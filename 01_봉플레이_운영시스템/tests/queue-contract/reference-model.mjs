// CLAUDE-011 — 발권 대기열 계약의 실행 가능한 참조 모델 (판본 v1).
//
// 운영 코드가 아니다. docs/design/CLAUDE-011_발권대기열_계약.md 를 메모리 안에서 그대로 옮긴 것으로,
// 구현(아난티)과 같은 픽스처를 돌려 결과를 대조하는 기준으로 쓴다. 네트워크·DB·실제 시계를 쓰지 않는다.
// 시간은 호출자가 넘기는 serverNow(ms, epoch) 만 사용한다.

export const ACTIVE = Object.freeze(['waiting', 'called', 'serving']);
export const TERMINAL = Object.freeze(['issued', 'cancelled', 'closed']);
export const STATES = Object.freeze([...ACTIVE, 'held', ...TERMINAL]);

// 계약 §2.1 전이표. key: action, value: { from: [...], to, actor }
export const TRANSITIONS = Object.freeze({
  call: { from: ['waiting'], to: 'called', actor: 'staff' },
  start_serving: { from: ['called'], to: 'serving', actor: 'staff' },
  hold: { from: ['called', 'serving'], to: 'held', actor: 'staff' },
  issue: { from: ['serving'], to: 'issued', actor: 'staff' },
  rejoin: { from: ['held'], to: 'waiting', actor: 'staff' },
  cancel: { from: ['waiting', 'called', 'held', 'serving'], to: 'cancelled', actor: 'staff' },
  cancel_self: { from: ['waiting', 'called', 'held'], to: 'cancelled', actor: 'customer' },
  close: { from: ['waiting', 'called', 'serving', 'held'], to: 'closed', actor: 'batch' }
});

const KST_OFFSET_MS = 9 * 3600 * 1000;
/** 서버 시각(ms) → KST 영업일 'YYYY-MM-DD' (계약 §3, 자정 경계 가정) */
export function kstBusinessDate(serverNowMs) {
  return new Date(serverNowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 영업일 끝(KST 24:00) — 토큰 만료 (계약 §11) */
export function kstDayEndIso(businessDate) {
  return `${businessDate}T23:59:59+09:00`;
}

const err = (code, extra = {}) => ({ ok: false, error: { code, retryable: ['RATE_LIMITED', 'LEDGER_NOT_CONFIRMED', 'SERVER_ERROR'].includes(code), ...extra } });

export class QueueModel {
  constructor({ siteId = 'bongplay_bonghwa', accessCode = 'SENTINEL-STAFF-CODE' } = {}) {
    this.siteId = siteId;
    this.accessCode = accessCode;
    this.entries = new Map(); // entry_ref → entry
    this.daily = new Map(); // `${site}|${date}` → { last_no, last_order_key, closed }
    this.byRequest = new Map(); // `${site}|${client_request_id}` → entry_ref
    this.byConsent = new Map(); // consent_id → entry_ref
    this.staffResults = new Map(); // request_id → result (계약 §9.2 같은 결과 반환)
    this.counters = new Map(); // counter_id → { state }
    this.audit = [];
    this.ledger = new Map(); // order_id → { consent_id, total, paid, tickets_expected, tickets_active }
    this.seq = 0;
  }

  // ---- 고객 ----------------------------------------------------------------
  submit({ clientRequestId, consent, serverNow }) {
    if (!clientRequestId || !consent || !consent.consent_id) return err('VALIDATION_FAILED');
    const fingerprint = JSON.stringify(consent);
    const reqKey = `${this.siteId}|${clientRequestId}`;
    const prevByReq = this.byRequest.get(reqKey);
    if (prevByReq) {
      const e = this.entries.get(prevByReq);
      if (e.consent_id !== consent.consent_id || e.fingerprint !== fingerprint) return err('IDEMPOTENCY_KEY_REUSED');
      return this._submitResult(e, false, serverNow);
    }
    const prevByConsent = this.byConsent.get(consent.consent_id);
    if (prevByConsent) return this._submitResult(this.entries.get(prevByConsent), false, serverNow);

    const date = kstBusinessDate(serverNow);
    const dkey = `${this.siteId}|${date}`;
    const day = this.daily.get(dkey) || { last_no: 0, last_order_key: 0, closed: false };
    if (day.closed) return err('QUEUE_CLOSED');
    day.last_no += 1;
    day.last_order_key += 1;
    this.daily.set(dkey, day);
    const ref = `qe_${++this.seq}`;
    const e = {
      entry_ref: ref, site_id: this.siteId, business_date: date, queue_no: day.last_no, order_key: day.last_order_key,
      consent_id: consent.consent_id, fingerprint, guardian_phone: consent.guardian_phone || null,
      status: 'waiting', version: 1, counter_id: null, token: `tok_${ref}_v1`,
      times: { waiting_at: serverNow }, flags: { held: false, ledger_failed: false, paused_during_serving: false }
    };
    this.entries.set(ref, e);
    this.byRequest.set(reqKey, ref);
    this.byConsent.set(consent.consent_id, ref);
    this._audit(e, null, 'waiting', 'customer', serverNow, clientRequestId);
    return this._submitResult(e, true, serverNow);
  }

  _submitResult(e, created, serverNow) {
    return { ok: true, created, queue_no: e.queue_no, business_date: e.business_date, status: e.status, lookup_token: e.token, token_expires_at: kstDayEndIso(e.business_date), server_time: serverNow };
  }

  _byToken(token) {
    for (const e of this.entries.values()) if (e.token === token) return e;
    return null;
  }

  myStatus({ token, serverNow, etaParams }) {
    const e = this._byToken(token);
    if (!e || e.business_date !== kstBusinessDate(serverNow)) return err('TOKEN_INVALID');
    const res = { ok: true, queue_no: e.queue_no, status: e.status, server_time: serverNow, stale_after_seconds: 60 };
    if (e.status === 'waiting') {
      res.ahead_count = this.aheadCount(e);
      res.eta = this.eta(e, serverNow, etaParams);
    } else {
      res.eta = { state: 'not_applicable' };
    }
    if (e.status === 'called' || e.status === 'serving') res.counter_label = e.counter_id;
    return res;
  }

  cancelSelf({ token, requestId, serverNow }) {
    const e = this._byToken(token);
    if (!e) return err('TOKEN_INVALID');
    return this._once(requestId, () => this._apply(e, 'cancel_self', { serverNow, actor: 'customer', requestId }));
  }

  // ---- 직원 ----------------------------------------------------------------
  _auth(code) { return code === this.accessCode; }

  _once(requestId, fn) {
    if (requestId && this.staffResults.has(requestId)) return this.staffResults.get(requestId);
    const r = fn();
    if (r && r._noCache) { const { _noCache, ...rest } = r; return rest; } // 재시도 가능한 실패는 고정하지 않음
    if (requestId) this.staffResults.set(requestId, r);
    return r;
  }

  setCounter({ accessCode, counterId, state, serverNow, requestId }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    return this._once(requestId, () => {
      this.counters.set(counterId, { state });
      if (state !== 'open') {
        for (const e of this.entries.values()) if (e.counter_id === counterId && e.status === 'serving') e.flags.paused_during_serving = true;
      }
      this.audit.push({ kind: 'counter', counter_id: counterId, to: state, at: serverNow, request_id: requestId });
      return { ok: true, counter_id: counterId, state };
    });
  }

  callNext({ accessCode, counterId, serverNow, requestId }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    return this._once(requestId, () => {
      const c = this.counters.get(counterId);
      if (!c || c.state !== 'open') return err('COUNTER_NOT_OPEN');
      for (const e of this.entries.values()) {
        if (e.counter_id === counterId && (e.status === 'called' || e.status === 'serving')) return err('COUNTER_BUSY');
      }
      const date = kstBusinessDate(serverNow);
      const next = [...this.entries.values()]
        .filter((e) => e.business_date === date && e.status === 'waiting')
        .sort((a, b) => a.order_key - b.order_key)[0];
      if (!next) return err('QUEUE_EMPTY');
      next.counter_id = counterId;
      return this._apply(next, 'call', { serverNow, actor: 'staff', requestId, counterId });
    });
  }

  transition({ accessCode, entryRef, expectedVersion, action, serverNow, requestId, reason = '' }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    return this._once(requestId, () => {
      const e = this.entries.get(entryRef);
      if (!e) return err('NOT_FOUND');
      if (!['start_serving', 'hold', 'rejoin', 'cancel'].includes(action)) return err('VALIDATION_FAILED');
      if (expectedVersion !== e.version) return err('VERSION_CONFLICT', { current_status: e.status, version: e.version });
      if (action === 'cancel' && e.status === 'serving' && !reason) return err('VALIDATION_FAILED');
      return this._apply(e, action, { serverNow, actor: 'staff', requestId, reason });
    });
  }

  recordLedger(orderId, rec) { this.ledger.set(orderId, { ...rec }); }

  issueComplete({ accessCode, entryRef, expectedVersion, orderId, serverNow, requestId }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    return this._once(requestId, () => {
      const e = this.entries.get(entryRef);
      if (!e) return err('NOT_FOUND');
      if (e.status === 'issued') return err('INVALID_TRANSITION', { current_status: 'issued' });
      if (expectedVersion !== e.version) return err('VERSION_CONFLICT', { current_status: e.status, version: e.version });
      if (e.status !== 'serving') return err('INVALID_TRANSITION', { current_status: e.status });
      const l = this.ledger.get(orderId);
      const missing = [];
      if (!l || l.consent_id !== e.consent_id) missing.push('order');
      else {
        if (l.paid !== l.total) missing.push('payment');
        if (l.tickets_active < l.tickets_expected) missing.push('tickets');
      }
      if (missing.length) {
        e.flags.ledger_failed = true; // 원장 장애 시간이 섞인 항목은 예상시간 표본에서 제외 (계약 §10.1)
        return { ...err('LEDGER_NOT_CONFIRMED', { missing }), _noCache: true };
      }
      return this._apply(e, 'issue', { serverNow, actor: 'staff', requestId, orderId });
    });
  }

  closeDay({ accessCode, businessDate, serverNow, requestId }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    return this._once(requestId, () => {
      let n = 0;
      for (const e of this.entries.values()) {
        if (e.business_date === businessDate && !TERMINAL.includes(e.status)) { this._apply(e, 'close', { serverNow, actor: 'batch', requestId }); n++; }
      }
      const dkey = `${this.siteId}|${businessDate}`;
      const day = this.daily.get(dkey) || { last_no: 0, last_order_key: 0, closed: false };
      day.closed = true;
      this.daily.set(dkey, day);
      return { ok: true, closed_count: n };
    });
  }

  publicBoard({ serverNow }) {
    const date = kstBusinessDate(serverNow);
    const called = [...this.entries.values()]
      .filter((e) => e.business_date === date && e.status === 'called')
      .sort((a, b) => a.order_key - b.order_key)
      .map((e) => ({ queue_no: e.queue_no, counter_label: e.counter_id }));
    return { ok: true, called, server_time: serverNow };
  }

  staffList({ accessCode, serverNow }) {
    if (!this._auth(accessCode)) return err('UNAUTHORIZED');
    const date = kstBusinessDate(serverNow);
    const list = [...this.entries.values()].filter((e) => e.business_date === date).sort((a, b) => a.order_key - b.order_key);
    return {
      ok: true,
      entries: list.map((e) => ({
        entry_ref: e.entry_ref, queue_no: e.queue_no, status: e.status, version: e.version, counter_id: e.counter_id, consent_id: e.consent_id,
        same_phone_active_count: e.guardian_phone
          ? list.filter((x) => x.guardian_phone === e.guardian_phone && ACTIVE.includes(x.status)).length
          : 0
      }))
    };
  }

  // ---- 공통 ----------------------------------------------------------------
  _apply(e, action, { serverNow, actor, requestId, counterId, reason, orderId }) {
    const t = TRANSITIONS[action];
    if (!t.from.includes(e.status)) return err('INVALID_TRANSITION', { current_status: e.status });
    const from = e.status;
    const oldKey = e.order_key;
    e.status = t.to;
    e.version += 1;
    e.times[`${t.to}_at`] = serverNow;
    if (action === 'call') e.counter_id = counterId ?? e.counter_id;
    if (action === 'hold') e.flags.held = true;
    if (action === 'rejoin') {
      const day = this.daily.get(`${e.site_id}|${e.business_date}`);
      day.last_order_key += 1;
      e.order_key = day.last_order_key; // 맨 뒤 합류, queue_no 유지 (계약 §6)
      e.counter_id = null;
    }
    if (action === 'hold') e.counter_id = null;
    if (orderId) e.order_id = orderId;
    this._audit(e, from, e.status, actor, serverNow, requestId, { reason, old_order_key: oldKey, new_order_key: e.order_key });
    return { ok: true, entry_ref: e.entry_ref, queue_no: e.queue_no, status: e.status, version: e.version, counter_id: e.counter_id };
  }

  _audit(e, from, to, actor, at, requestId, extra = {}) {
    this.audit.push({ kind: 'entry', entry_ref: e.entry_ref, from, to, actor_kind: actor, at, request_id: requestId, ...extra });
  }

  aheadCount(e) {
    let n = 0;
    for (const x of this.entries.values()) {
      if (x !== e && x.site_id === e.site_id && x.business_date === e.business_date && ACTIVE.includes(x.status) && x.order_key < e.order_key) n++;
    }
    return n;
  }

  /** 유효 표본: issued 이고 held·창구 정지·원장 실패를 거치지 않은 serving→issued (계약 §10.1) */
  validSamples() {
    const out = [];
    for (const e of this.entries.values()) {
      if (e.status !== 'issued' || e.flags.held || e.flags.paused_during_serving || e.flags.ledger_failed) continue;
      if (e.times.serving_at == null || e.times.issued_at == null) continue;
      out.push({ at: e.times.issued_at, seconds: (e.times.issued_at - e.times.serving_at) / 1000 });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  eta(e, serverNow, params = {}) {
    const date = e.business_date;
    const counters = [...this.counters.entries()].filter(([, c]) => c.state === 'open').map(([id]) => id);
    const work = counters.map((id) => {
      const busy = [...this.entries.values()].find((x) => x.counter_id === id && x.business_date === date && (x.status === 'called' || x.status === 'serving'));
      if (!busy) return { kind: 'idle' };
      if (busy.status === 'called') return { kind: 'called' };
      return { kind: 'serving', elapsed_seconds: (serverNow - busy.times.serving_at) / 1000 };
    });
    const aheadWaiting = [...this.entries.values()].filter((x) => x.business_date === date && x.status === 'waiting' && x.order_key < e.order_key).length;
    // 창구가 정지·종료된 채로 남은 called/serving 은 위 work 에 없지만 앞선 팀 수에는 포함된다 → 대기 팀으로 간주
    const strandedAhead = [...this.entries.values()].filter((x) => x.business_date === date && (x.status === 'called' || x.status === 'serving') && !counters.includes(x.counter_id) && x.order_key < e.order_key).length;
    return computeEta({ samples: this.validSamples().map((s) => s.seconds), counterWork: work, aheadWaiting: aheadWaiting + strandedAhead, serverNow, ...params });
  }
}

// ---- 예상시간 (계약 §10) -----------------------------------------------------
export const ETA_DEFAULTS = Object.freeze({ N_MIN: 5, MAX_SAMPLES: 20, MIN_SECONDS: 30, MAD_K: 3 }); // [제안] 값

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 이상값 제외 후 최근 MAX_SAMPLES 개 (입력은 오래된 순) */
export function filterSamples(samplesSeconds, { MAX_SAMPLES, MIN_SECONDS, MAD_K } = ETA_DEFAULTS) {
  let s = samplesSeconds.filter((x) => Number.isFinite(x) && x >= MIN_SECONDS);
  s = s.slice(-MAX_SAMPLES);
  if (s.length >= 3) {
    const sorted = [...s].sort((a, b) => a - b);
    const med = quantile(sorted, 0.5);
    const mad = quantile([...sorted.map((x) => Math.abs(x - med))].sort((a, b) => a - b), 0.5);
    if (mad > 0) s = s.filter((x) => x <= med + MAD_K * mad);
  }
  return s;
}

/** 창구 가용 시각을 시뮬레이션해 고객의 예상 호출 시각(초)을 구한다 */
export function simulateStartSeconds({ d, counterWork, aheadWaiting }) {
  const avail = counterWork.map((w) => (w.kind === 'idle' ? 0 : w.kind === 'called' ? d : Math.max(0, d - w.elapsed_seconds)));
  for (let i = 0; i < aheadWaiting; i++) {
    let j = 0;
    for (let k = 1; k < avail.length; k++) if (avail[k] < avail[j]) j = k;
    avail[j] += d;
  }
  return Math.min(...avail);
}

export function computeEta({ samples, counterWork, aheadWaiting, serverNow, ...overrides }) {
  const p = { ...ETA_DEFAULTS, ...overrides };
  if (!counterWork.length) return { state: 'paused', computed_at: serverNow };
  const valid = filterSamples(samples, p);
  if (valid.length < p.N_MIN) return { state: 'estimating', sample_count: valid.length, computed_at: serverNow };
  const sorted = [...valid].sort((a, b) => a - b);
  const p25 = quantile(sorted, 0.25), p75 = quantile(sorted, 0.75);
  const lo = simulateStartSeconds({ d: p25, counterWork, aheadWaiting });
  const hi = simulateStartSeconds({ d: p75, counterWork, aheadWaiting });
  return { state: 'range', min_minutes: Math.floor(lo / 60), max_minutes: Math.ceil(hi / 60), sample_count: valid.length, computed_at: serverNow };
}

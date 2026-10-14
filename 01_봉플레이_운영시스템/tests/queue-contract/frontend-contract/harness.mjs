// CLAUDE-011 — 프런트·백엔드 결합 계약 시험용 하네스 (브라우저 계층).
// 대상 체크아웃(ANT006_ROOT)의 실제 화면을 헤드리스 Chromium 으로 열고, Supabase 대신 이 파일의 모의 PostgREST 에 붙인다.
//
// 모의 서버가 하는 일
//   - 테이블 쓰기(POST/PATCH)를 "서버 확정" 행으로 보관하고 모든 요청을 시각과 함께 기록한다.
//   - 테이블·RPC 별 장애 주입: HTTP 503, 연결 끊김(abort), 지정 JSON 응답. 횟수 지정 가능.
//   - 대기열 RPC 는 제안 SQL(CLAUDE-011 후속 592d181) 의 계약을 간략히 모사한다:
//     접수 시 서약서 확정 확인(CONSENT_NOT_FOUND), 멱등키·서약서 중복, 발권 완료 시 원장 대사(7~12단계 요지).
//     실제 SQL 실행이 아니다. SQL 자체는 ant006-conformance/ 의 PGlite·로컬 PostgreSQL 시험이 검증한다.
// 외부 네트워크(CDN)는 차단하고 최소 대체 스크립트를 준다. 운영 DB·Supabase 에 접속하지 않는다. 합성 값만 쓴다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = process.env.ANT006_ROOT || null;
export const STAFF_CODE = 'SENTINEL-STAFF-CODE';
const ANON_KEY = 'SENTINEL-ANON-KEY';
const OPS = ROOT ? path.join(ROOT, '01_봉플레이_운영시스템') : null;

export function skipReason() {
  if (!ROOT) return 'ANT006_ROOT 미지정 — 대상 체크아웃 없이 건너뜀';
  if (!fs.existsSync(path.join(OPS, 'pages', 'consent-desk.html'))) return `대상 화면 없음: ${OPS}`;
  return false;
}

let pwModule;
async function playwright() {
  if (!pwModule) {
    const dir = process.env.PW_DIR;
    pwModule = await import(dir ? pathToFileURL(path.join(dir, 'index.mjs')).href : 'playwright');
  }
  return pwModule.chromium ? pwModule : pwModule.default;
}

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };

/** 모의 PostgREST + 정적 파일 서버 */
export async function startMockServer() {
  const state = { tables: new Map(), queue: [], seq: 0, log: [], faults: [] };
  const table = (name) => { if (!state.tables.has(name)) state.tables.set(name, new Map()); return state.tables.get(name); };
  const rowsOf = (name) => [...table(name).values()];
  const pkOf = (name, row) => (name === 'ticket_ledger' ? row.ticket_id : (row.id ?? row.item_id ?? row.ticket_id));

  function takeFault(kind, name, method) {
    const f = state.faults.find((x) => x.kind === kind && x.name === name && (!x.method || x.method === method) && x.times > 0);
    if (f) f.times -= 1;
    return f || null;
  }

  const rpc = {
    get_today_consents_secure: () => rowsOf('safety_consents'),
    verify_staff_access: () => true,
    enqueue_consent_team(b) {
      const site = b.p_site_id || 'bongplay_bonghwa';
      const day = kstToday();
      const byKey = state.queue.find((q) => q.site_id === site && q.queue_date === day && q.idempotency_key === b.p_idempotency_key);
      if (byKey) {
        if (byKey.consent_id !== b.p_consent_id) return { ok: false, error: 'IDEMPOTENCY_KEY_REUSED' };
        return { ok: true, duplicate: true, ...byKey };
      }
      const byConsent = state.queue.find((q) => q.site_id === site && q.queue_date === day && q.consent_id === b.p_consent_id);
      if (byConsent) return { ok: true, duplicate: true, ...byConsent };
      if (!table('safety_consents').has(b.p_consent_id)) {
        return { ok: false, error: 'CONSENT_NOT_FOUND', retryable: true, message: '서약서 저장이 서버에 확정되지 않았습니다.' };
      }
      state.seq += 1;
      const n = state.seq;
      const e = {
        id: `q_${day.replace(/-/g, '')}_${String(n).padStart(4, '0')}`, site_id: site, queue_date: day, queue_number: n, order_key: n,
        formatted_number: '#' + String(n).padStart(3, '0'), customer_token: 'bpq_sentinel_' + n, consent_id: b.p_consent_id,
        guardian_name: b.p_guardian_name, guardian_phone: b.p_guardian_phone, party_size: b.p_party_size,
        idempotency_key: b.p_idempotency_key, status: 'waiting', desk_no: null, enqueued_at: new Date().toISOString()
      };
      state.queue.push(e);
      return { ok: true, duplicate: false, ...e };
    },
    call_next_queue_team(b) {
      if (state.queue.some((q) => q.desk_no === b.p_desk_no && ['called', 'processing'].includes(q.status))) return { ok: false, error: 'DESK_ALREADY_OCCUPIED' };
      const t = state.queue.filter((q) => q.status === 'waiting').sort((a, c) => a.order_key - c.order_key)[0];
      if (!t) return { ok: false, error: 'empty_queue' };
      Object.assign(t, { status: 'called', desk_no: b.p_desk_no, called_at: new Date().toISOString() });
      return { ok: true, ...t };
    },
    start_queue_processing(b) {
      const t = state.queue.find((q) => q.id === b.p_queue_id);
      if (!t) return { ok: false, error: 'not_found' };
      if (t.status !== 'called') return { ok: false, error: 'invalid_status' };
      t.status = 'processing';
      return { ok: true, ...t };
    },
    complete_queue_issuance(b) { return completeIssuance(b); },
    get_staff_queue_list() {
      const live = state.queue.filter((q) => q.queue_date === kstToday());
      return {
        ok: true,
        waiting_count: live.filter((q) => q.status === 'waiting').length,
        waiting_teams: live.filter((q) => q.status === 'waiting'),
        called_teams: live.filter((q) => ['called', 'processing'].includes(q.status)),
        held_teams: live.filter((q) => q.status === 'no_show')
      };
    },
    get_customer_queue_status(b) {
      const t = state.queue.find((q) => q.customer_token === b.p_customer_token);
      if (!t) return { ok: false, error: 'INVALID_TOKEN' };
      const ahead = state.queue.filter((q) => q.order_key < t.order_key && ['waiting', 'called', 'processing'].includes(q.status)).length;
      return { ok: true, ...t, ahead_count: ahead, wait_time: { code: 'CALCULATING', text: '집계 중' } };
    },
    get_queue_public_display: () => ({ ok: true, data: { waiting_count: state.queue.filter((q) => q.status === 'waiting').length, desks: [] } })
  };
  const STAFF_RPCS = new Set(['call_next_queue_team', 'start_queue_processing', 'complete_queue_issuance', 'get_staff_queue_list', 'get_today_consents_secure']);

  // 제안 SQL complete_queue_issuance 7~12단계의 요지 (활성 품목, 서약서 양성 소속, 입장권 수량 정확 일치, 원장 완비, 할인 후 금액 수납)
  function completeIssuance(b) {
    const t = state.queue.find((q) => q.id === b.p_queue_id);
    if (!t) return { ok: false, error: 'not_found' };
    const ids = Array.isArray(b.p_ticket_ids) ? b.p_ticket_ids : [];
    if (t.status === 'issued') {
      return t.order_id === b.p_order_id
        ? { ok: true, duplicate: true, already_completed: true, ...t }
        : { ok: false, error: 'ALREADY_ISSUED_OTHER_ORDER' };
    }
    if (t.status !== 'processing') return { ok: false, error: 'INVALID_STATUS' };
    if (!b.p_order_id) return { ok: false, error: 'ORDER_ID_REQUIRED' };
    if (ids.length === 0) return { ok: false, error: 'TICKETS_REQUIRED' };
    const items = rowsOf('order_items').filter((r) => r.order_id === b.p_order_id && r.status !== 'cancelled' && !r.cancelled_at);
    if (items.length === 0) return { ok: false, error: 'ORDER_ITEMS_EMPTY' };
    if (items.some((r) => r.consent_id !== t.consent_id)) return { ok: false, error: 'ORDER_CONSENT_MISMATCH' };
    const pays = rowsOf('order_payments').filter((r) => r.order_id === b.p_order_id);
    if (pays.some((r) => r.consent_id !== t.consent_id)) return { ok: false, error: 'ORDER_CONSENT_MISMATCH' };
    if (new Set(ids).size !== ids.length) return { ok: false, error: 'DUPLICATE_TICKET_IDS' };
    const qty = items.filter((r) => r.product_category === 'ticket').reduce((s, r) => s + Number(r.quantity || 0), 0);
    if (qty === 0) return { ok: false, error: 'ORDER_TICKET_ITEMS_EMPTY' };
    if (qty !== ids.length) return { ok: false, error: 'TICKET_QUANTITY_MISMATCH' };
    const ledger = rowsOf('ticket_ledger').filter((r) => r.order_id === b.p_order_id && r.consent_id === t.consent_id && r.status === 'active' && !r.cancelled_at);
    const ledgerIds = new Set(ledger.map((r) => r.ticket_id));
    if (!ids.every((id) => ledgerIds.has(id)) || ledger.length !== qty) return { ok: false, error: 'TICKET_LEDGER_INCOMPLETE' };
    const amount = items.reduce((s, r) => s + Number(r.paid_amount || r.total_price || 0), 0);
    const paid = pays.filter((r) => r.status === 'paid' && !r.cancelled_at).reduce((s, r) => s + Number(r.amount || 0), 0);
    if (amount > 0 && paid === 0) return { ok: false, error: 'PAYMENT_NOT_CONFIRMED' };
    if (paid < amount) return { ok: false, error: 'PARTIAL_PAYMENT_REJECTED' };
    Object.assign(t, { status: 'issued', order_id: b.p_order_id, ticket_ids: ids, desk_no: t.desk_no });
    return { ok: true, duplicate: false, already_completed: false, ...t };
  }

  const configJs = `
window.BONGPLAY_CONFIG = Object.assign(window.BONGPLAY_CONFIG || {}, { SUPABASE_URL: location.origin + '/mock-supabase', SUPABASE_ANON_KEY: '${ANON_KEY}', STAFF_SESSION_HOURS: 12, MASTER_VERSION: '2026.v1' });
try { localStorage.setItem('bongplay_supabase_config', JSON.stringify({ url: location.origin + '/mock-supabase', key: '${ANON_KEY}' })); } catch (e) {}
window.BongplayAuth = {
  getAccessCode: function () { try { var s = JSON.parse(localStorage.getItem('bongplay_staff_session_v2') || 'null'); return s && s.code; } catch (e) { return null; } },
  isAuthenticated: function () { return !!this.getAccessCode(); },
  logout: function () {}
};`;

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
    if (p.startsWith('/mock-supabase/rest/v1/')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
        const rest = p.slice('/mock-supabase/rest/v1/'.length);
        const isRpc = rest.startsWith('rpc/');
        const name = isRpc ? rest.slice(4) : rest;
        const entry = { t: Date.now(), kind: isRpc ? 'rpc' : 'rest', name, method: req.method, query: url.search, body, outcome: null };
        state.log.push(entry);
        const fault = takeFault(entry.kind, name, req.method);
        if (fault && fault.mode !== 'lost') {
          entry.outcome = 'fault:' + fault.mode;
          // 주의: 응답 없이 연결만 끊으면(abort) Chromium 이 재사용 연결의 POST 를 스스로 다시 보낼 수 있다.
          //       화면 코드의 재시도와 구분되지 않으므로 계약 시험에는 503·lost 를 쓴다.
          if (fault.mode === 'abort') return req.socket.destroy();
          if (fault.mode === '503') return json(res, 503, { message: 'SENTINEL injected 503' });
          if (fault.mode === 'json') return json(res, 200, fault.body);
        }
        // lost: 서버는 처리(커밋)했지만 응답이 유실된 경우 — 처리 후 503 으로 응답한다.
        const lost = fault && fault.mode === 'lost';
        const reply = (code, out) => (lost ? json(res, 503, { message: 'SENTINEL response lost after commit' }) : json(res, code, out));
        if (isRpc) {
          const fn = rpc[name];
          if (STAFF_RPCS.has(name) && (!body || body.p_access_code !== STAFF_CODE)) { entry.outcome = 'unauthorized'; return json(res, 200, { ok: false, error: 'UNAUTHORIZED_STAFF' }); }
          const out = fn ? fn(body || {}) : { ok: true };
          entry.outcome = (out && out.ok === false ? 'rejected:' + out.error : 'ok') + (lost ? '+response_lost' : '');
          entry.response = out;
          return reply(200, out);
        }
        if (req.method === 'GET' || req.method === 'HEAD') { entry.outcome = 'ok'; return json(res, 200, rowsOf(name)); }
        if (req.method === 'POST') {
          for (const row of (Array.isArray(body) ? body : [body])) {
            if (!row) continue;
            const k = pkOf(name, row);
            table(name).set(k, { ...(table(name).get(k) || {}), ...row });
          }
          entry.outcome = 'stored' + (lost ? '+response_lost' : '');
          return reply(201);
        }
        if (req.method === 'PATCH') {
          const m = url.search.match(/[?&]([a-z_]+)=eq\.([^&]+)/);
          const out = [];
          if (m) {
            const k = decodeURIComponent(m[2]);
            const cur = table(name).get(k);
            if (cur) { const next = { ...cur, ...body }; table(name).set(k, next); out.push(next); }
          }
          entry.outcome = out.length ? 'stored' + (lost ? '+response_lost' : '') : 'no_rows';   // PostgREST: 없는 행 PATCH 는 200 []
          return reply(200, out);
        }
        if (req.method === 'DELETE') { entry.outcome = 'ok'; return json(res, 204); }
        return json(res, 200, []);
      });
      return;
    }
    if (p.endsWith('/assets/config.js')) { res.writeHead(200, { 'Content-Type': mime['.js'] }); return res.end(configJs); }
    const file = path.join(OPS, p);
    if (file.startsWith(OPS) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base, state,
    /** 장애 주입. mode: '503'(처리 안 함) | 'lost'(처리 후 503) | 'json'(지정 응답) | 'abort'(연결 끊김, 브라우저 자동 재전송 주의). times 생략 시 계속 */
    fault(kind, name, mode, { times = Infinity, method, body } = {}) { state.faults.push({ kind, name, mode, times, method, body }); },
    clearFaults() { state.faults.length = 0; },
    calls(kind, name) { return state.log.filter((e) => e.kind === kind && e.name === name); },
    rows: rowsOf,
    seedConsent(row) { table('safety_consents').set(row.id, row); },
    seedQueue(consent) { return rpc.enqueue_consent_team({ p_consent_id: consent.id, p_idempotency_key: 'seed_' + consent.id, p_party_size: 2, p_guardian_name: consent.guardian_name, p_guardian_phone: consent.guardian_phone }); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

const CDN_STUBS = [
  [/cdn\.tailwindcss\.com/, 'window.tailwind = { config: {} };'],
  [/lucide/, 'window.lucide = { createIcons: function () {} };'],
  [/qrcode/i, 'window.QRCode = function () {}; window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };'],
  [/supabase-js/, '']
];

/** 새 브라우저 컨텍스트에서 화면을 연다. staff: 직원 세션(합성 코드)을 미리 넣는다. */
export async function openPage(srv, pagePath, { staff = false, viewport } = {}) {
  const pw = await playwright();
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
  if (staff) {
    await context.addInitScript((code) => {
      try { localStorage.setItem('bongplay_staff_session_v2', JSON.stringify({ code, expiresAt: Date.now() + 3600e3 })); } catch (e) {}
    }, STAFF_CODE);
  }
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(srv.base)) return route.continue();
    const stub = CDN_STUBS.find(([re]) => re.test(u));
    if (stub) return route.fulfill({ status: 200, contentType: 'application/javascript', body: stub[1] });
    return route.abort();
  });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message(), t: Date.now() });
    try { await d.accept(d.type() === 'prompt' ? (d.defaultValue() || '고객 요청') : undefined); } catch (e) { /* 페이지가 이미 닫힘 */ }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(srv.base + pagePath, { waitUntil: 'load' });
  return { page, dialogs, errors, close: () => browser.close() };
}

/** 조건이 참이 될 때까지 기다린다. 시간 안에 안 되면 false */
export async function waitFor(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return !!(await fn());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

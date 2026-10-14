// CLAUDE-011 — 설치 묶음 기능 검증 (PostgREST HTTP 경로).
// 앱과 같은 방식(anon 키 + REST/RPC)으로 시험 프로젝트를 호출해 권한·접수·호출·발권 완료·동시 접수를 확인한다.
// 대상: 로컬 PostgREST(run_local_install_check.sh) 또는 설치 묶음을 적용한 "시험" Supabase 프로젝트.
// 운영 프로젝트에 실행하지 않는다. 만드는 행은 모두 'SYN-HTTP-' 로 시작하는 합성 값이다.
//
// 실행:
//   SUPABASE_URL=<시험 프로젝트 URL> SUPABASE_ANON_KEY=<시험 프로젝트 anon 키> TEST_STAFF_CODE=<40 단계에서 넣은 시험 암호> \
//   node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/supabase-install/verify_http.mjs
// 전제: 00 → FINAL → 대기열 SQL → 40 → 50(오늘 PASS 점검) 적용 완료.
// 주의: 틀린 암호 시험이 private.auth_attempts 에 실패 1건을 남긴다 (IP 별 10분 20회 초과 시 잠금).
import test from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const CODE = process.env.TEST_STAFF_CODE;
const PREFIX = process.env.REST_PREFIX ?? '/rest/v1';   // Supabase 게이트웨이 경로. PostgREST 단독 실행이면 ''
const skip = URL_ && KEY && CODE ? false : 'SUPABASE_URL·SUPABASE_ANON_KEY·TEST_STAFF_CODE 미지정 — 건너뜀';
const RUN = 'SYN-HTTP-' + Date.now().toString(36);
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const H = () => ({ apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' });

async function rest(method, path, body, extra = {}) {
  const res = await fetch(`${URL_}${PREFIX}/${path}`, { method, headers: { ...H(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
  return { status: res.status, json };
}
const rpc = async (fn, args) => (await rest('POST', `rpc/${fn}`, args)).json;
const consent = (n) => ({
  id: `${RUN}-CST-${n}`, site_id: 'bongplay_bonghwa', guardian_name: `SYN 보호자 ${n}`, guardian_phone: '010-0000-0000',
  created_date: today, arrival_at: new Date().toISOString(), children: [{ name: 'SYN 아동', birth: '2019-05-12' }], is_issued: false
});
async function newConsent(n) {
  const r = await rest('POST', 'safety_consents', consent(n), { Prefer: 'return=minimal' });
  assert.equal(r.status, 201, `서약서 저장 실패 ${r.status} ${JSON.stringify(r.json)}`);
  return `${RUN}-CST-${n}`;
}
const enqueue = (cid, key) => rpc('enqueue_consent_team', {
  p_consent_id: cid, p_idempotency_key: key || `${cid}-key`, p_party_size: 2, p_guardian_name: 'SYN', p_guardian_phone: '010-0000-0000', p_site_id: 'bongplay_bonghwa'
});
const denied = (s) => s === 401 || s === 403;
const mine = new Map();   // 이번 실행이 접수한 대기 id → 서약서 id (호출 응답의 consent_id 와 대조)

test('H01 anon cannot read or write queue tables directly', { skip }, async () => {
  // 쓰기 본문은 각 표의 실제 열로 만든다 (없는 열이면 PostgREST 가 권한 검사 전에 400 을 돌려 판정이 흐려진다)
  const bodies = {
    ticket_queue: [{ id: `${RUN}-X` }, 'site_id=eq.bongplay_bonghwa', { status: 'waiting' }],
    ticket_queue_desks: [{ site_id: 'bongplay_bonghwa', desk_no: 99 }, 'site_id=eq.bongplay_bonghwa', { is_paused: false }],
    ticket_queue_rate_limits: [{ customer_token: `${RUN}-X` }, `customer_token=eq.${RUN}-X`, { request_count: 1 }]
  };
  for (const [t, [body, filter, patch]] of Object.entries(bodies)) {
    const g = await rest('GET', `${t}?select=*&limit=1`);
    assert.ok(denied(g.status), `${t} 직접 조회 허용 (${g.status} ${JSON.stringify(g.json)})`);
    const p = await rest('POST', t, body, { Prefer: 'return=minimal' });
    assert.ok(denied(p.status), `${t} 직접 쓰기 허용 (${p.status} ${JSON.stringify(p.json)})`);
    const u = await rest('PATCH', `${t}?${filter}`, patch);
    assert.ok(denied(u.status), `${t} 직접 수정 허용 (${u.status} ${JSON.stringify(u.json)})`);
  }
});

test('H02 internal functions are not reachable over the API', { skip }, async () => {
  for (const fn of ['lock_ticket_queue_day', 'verify_staff_permission', 'verify_access_code']) {
    const r = await rest('POST', `rpc/${fn}`, {});
    assert.ok(r.status === 404 || denied(r.status), `${fn} 호출 경로가 열려 있음 (${r.status})`);
  }
});

test('H03 anon cannot delete ledger rows', { skip }, async () => {
  const cid = await newConsent('DEL');
  const r = await rest('DELETE', `safety_consents?id=eq.${encodeURIComponent(cid)}`);
  assert.ok(denied(r.status), `서약서 DELETE 허용 (${r.status})`);
});

test('H04 enqueue: confirmed consent gets a number, same request is idempotent, missing consent is retryable', { skip }, async () => {
  const cid = await newConsent('Q1');
  const a = await enqueue(cid);
  assert.equal(a.ok, true, JSON.stringify(a));
  mine.set(a.id, cid);
  const b = await enqueue(cid);
  assert.equal(b.ok, true); assert.equal(b.duplicate, true); assert.equal(b.id, a.id);
  const m = await enqueue(`${RUN}-CST-MISSING`);
  assert.equal(m.ok, false); assert.equal(m.error, 'CONSENT_NOT_FOUND'); assert.equal(m.retryable, true);
  const s = await rpc('get_customer_queue_status', { p_customer_token: a.customer_token, p_site_id: 'bongplay_bonghwa' });
  assert.equal(s.ok, true, JSON.stringify(s)); assert.equal(s.status, 'waiting');
});

test('H05 twenty simultaneous enqueues over HTTP all succeed with distinct numbers', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await newConsent(`B${i}`));
  const out = await Promise.all(ids.map((id) => enqueue(id)));
  const bad = out.filter((r) => !r || r.ok !== true);
  assert.equal(bad.length, 0, `실패 ${bad.length}건: ${JSON.stringify(bad.slice(0, 3))}`);
  assert.equal(new Set(out.map((r) => r.queue_number)).size, 20);
  out.forEach((r, i) => mine.set(r.id, ids[i]));
});

test('H06 staff RPC rejects a wrong access code', { skip }, async () => {
  const r = await rpc('get_staff_queue_list', { p_access_code: 'SYN-WRONG-CODE', p_date: today, p_site_id: 'bongplay_bonghwa' });
  assert.equal(r.ok, false); assert.equal(r.error, 'UNAUTHORIZED_STAFF');
});

async function orderFor(cid, oid, { paid }) {
  const items = [{ item_id: `${oid}-I1`, id: `${oid}-I1`, order_id: oid, consent_id: cid, product_id: 'tkt_basic', product_category: 'ticket', quantity: 2, list_price: 10000, discount_amount: 0, paid_amount: 20000, status: 'paid' }];
  const pays = [{ id: `${oid}-P1`, order_id: oid, consent_id: cid, method: 'cash', amount: paid, status: 'paid' }];
  const tickets = [1, 2].map((i) => ({ ticket_id: `${oid}-T${i}`, order_id: oid, consent_id: cid, product_id: 'tkt_basic', status: 'active' }));
  for (const [t, rows] of [['order_items', items], ['order_payments', pays], ['ticket_ledger', tickets]]) {
    const r = await rest('POST', t, rows, { Prefer: 'return=minimal' });
    assert.equal(r.status, 201, `${t} 저장 실패 ${r.status} ${JSON.stringify(r.json)} (오늘 PASS 점검이 없으면 SAFETY_INTERLOCK_BLOCKED)`);
  }
  return tickets.map((t) => t.ticket_id);
}

const staff = (fn, args) => rpc(fn, { p_access_code: CODE, p_site_id: 'bongplay_bonghwa', ...args });

/** 창구를 비우고, 이번 실행이 접수한 팀이 호출될 때까지 앞선(이전 실행의) 합성 팀을 취소한다. 시험 프로젝트 전용. */
async function callMine(desk, skipped) {
  const l = await staff('get_staff_queue_list', { p_date: today });
  for (const t of (l.called_teams || []).filter((x) => x.desk_no === desk)) {
    await staff('cancel_queue_team', { p_queue_id: t.id, p_reason: 'SYN 시험 정리' });
    skipped.push(t.id);
  }
  for (let i = 0; i < 300; i++) {
    const c = await staff('call_next_queue_team', { p_desk_no: desk });
    assert.equal(c.ok, true, `${desk}번 창구 호출 실패: ${JSON.stringify(c)}`);
    if (mine.has(c.id)) {
      assert.equal(c.consent_id, mine.get(c.id), `호출 응답의 consent_id 가 접수한 서약서와 다름: ${JSON.stringify(c)}`);
      return c;
    }
    await staff('cancel_queue_team', { p_queue_id: c.id, p_reason: 'SYN 시험 정리' });
    skipped.push(c.id);
  }
  throw new Error('이번 실행 팀을 호출하지 못함');
}

test('H07 staff flow over HTTP: call, start, complete with confirmed ledger; retry returns the same success; partial payment rejected', { skip }, async () => {
  assert.ok(mine.size > 0, 'H04·H05 가 먼저 성공해야 함');
  const skipped = [];
  const c1 = await callMine(1, skipped);
  const s1 = await staff('start_queue_processing', { p_queue_id: c1.id });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  const oid1 = `${RUN}-ORD-1`;
  const t1 = await orderFor(c1.consent_id, oid1, { paid: 20000 });
  const done = await staff('complete_queue_issuance', { p_queue_id: c1.id, p_order_id: oid1, p_ticket_ids: t1 });
  assert.equal(done.ok, true, `발권 완료 실패: ${JSON.stringify(done)}`);
  const again = await staff('complete_queue_issuance', { p_queue_id: c1.id, p_order_id: oid1, p_ticket_ids: t1 });
  assert.equal(again.ok, true, JSON.stringify(again));

  const c2 = await callMine(2, skipped);
  await staff('start_queue_processing', { p_queue_id: c2.id });
  const oid2 = `${RUN}-ORD-2`;
  const t2 = await orderFor(c2.consent_id, oid2, { paid: 5000 });
  const part = await staff('complete_queue_issuance', { p_queue_id: c2.id, p_order_id: oid2, p_ticket_ids: t2 });
  assert.equal(part.ok, false, JSON.stringify(part)); assert.equal(part.error, 'PARTIAL_PAYMENT_REJECTED');
  if (skipped.length) console.log(`# 이전 실행의 합성 팀 ${skipped.length}개를 취소하고 진행`);
});

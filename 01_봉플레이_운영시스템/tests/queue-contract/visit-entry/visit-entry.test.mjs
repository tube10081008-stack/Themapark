// BEN-ENTRY-01 — 게이트 없는 발권·입장·반납 (실제 PostgreSQL + 설치 묶음, 여러 연결 경합). 합성 자료만 쓴다.
// 계약: 01_봉플레이_운영시스템/database/CONTRACT_gateless_entry.md
//
// 계층: desk-e2e 의 일회용 스택(PostgreSQL 16 + Supabase 모사 + 설치 묶음 ORDER + PostgREST)을 그대로 쓴다.
// - 직원 RPC 는 PostgREST 와 같은 경로로 부른다: authenticator 접속 → anon 역할 → request.headers(x-forwarded-for).
// - 발송 작업자 RPC 는 service_role 역할로 부른다 (작업자 자체는 모의 — 실제 알림톡 발송 없음).
// - 결제·티켓 원장은 관리자 연결로 직접 쓴다 (화면 createOrder 와 같은 소속·수량 구조).
//
// 실행 (저장소 루트):
//   PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
//   E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> \
//     node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/visit-entry/visit-entry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadEnv, db } from '../desk-e2e/harness.mjs';

const env = loadEnv();
const skip = !env ? 'E2E_ENV 미지정 — desk_e2e_stack.sh start 후 stack.env 경로를 지정'
  : !['127.0.0.1', 'localhost'].includes(new URL(env.E2E_PG_URL).hostname) ? '로컬이 아닌 DB 는 거부' : false;
const SITE = 'bongplay_bonghwa';
const PUBLIC_FNS = ['enqueue_consent_team', 'get_customer_queue_status', 'get_queue_public_display'];

async function pgMod() {
  return (await import(process.env.PG_DIR ? pathToFileURL(process.env.PG_DIR + '/lib/index.js').href : 'pg')).default;
}
async function stillPending(promise, ms = 400) {
  const t = new Promise((r) => setTimeout(() => r('pending'), ms));
  return (await Promise.race([promise.then(() => 'settled', () => 'settled'), t])) === 'pending';
}

/** PostgREST 요청 하나와 같은 연결. role: anon(직원 RPC, 운영 암호 자동) | anon_nocode | service_role */
async function api(role = 'anon', ip = '203.0.113.30') {
  const pg = await pgMod();
  const conn = new pg.Client({ connectionString: env.E2E_PG_URL.replace('//postgres@', '//authenticator@') });
  await conn.connect();
  const dbRole = role === 'service_role' ? 'service_role' : 'anon';
  const self = {
    async begin() {
      await conn.query('begin');
      await conn.query(`set local role ${dbRole}`);
      await conn.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`,
        [JSON.stringify({ role: dbRole }), JSON.stringify({ 'x-forwarded-for': ip })]);
    },
    async call(fn, args = {}) {
      if (role === 'anon' && !PUBLIC_FNS.includes(fn) && !('p_access_code' in args) && !fn.startsWith('claim_') && !fn.startsWith('report_')) {
        args = { p_access_code: env.E2E_STAFF_CODE, ...args };
      }
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
      try { return (await conn.query(sql, vals)).rows[0].r; } catch (e) { return { sqlError: e.message, sqlCode: e.code }; }
    },
    async sql(text, vals = []) {
      try { return (await conn.query(text, vals)).rows; } catch (e) { return { sqlError: e.message, sqlCode: e.code }; }
    },
    commit: () => conn.query('commit'),
    rollback: () => conn.query('rollback'),
    async rpc(fn, args = {}) {
      await self.begin();
      const r = await self.call(fn, args);
      if (r && r.sqlError !== undefined) await self.rollback(); else await self.commit();
      return r;
    },
    end: () => conn.end()
  };
  return self;
}

let seq = 0;
const uid = (p) => `SYN-${p}-${Date.now().toString(36)}-${++seq}`;
const rid = () => 'SYN-REQ-' + Math.random().toString(36).slice(2, 12) + (++seq);

async function reset(c) {
  await c.query(`truncate public.visit_entry_tickets, public.visit_entries, public.visit_identity_checks, public.visit_entry_requests,
    public.queue_call_notifications, public.ticket_queue, public.ticket_queue_rate_limits, public.order_items, public.order_payments,
    public.ticket_ledger, public.safety_consents, public.safety_audits`);
  await c.query(`update public.ticket_queue_desks set current_queue_id = null, is_paused = false`);
  await c.query(`delete from private.auth_attempts`);
  await passAudit(c);
}
async function passAudit(c) {
  await c.query(`insert into public.safety_audits (id, site_id, audit_date, audit_at, inspector, decision, is_safe, note)
    select 'SYN-AUDIT-' || d, $1, d, now(), 'SYN 점검자', 'pass', true, '합성'
      from (select (now() at time zone 'Asia/Seoul')::date as d) x on conflict (id) do nothing`, [SITE]);
}
async function consent(c, label, phone) {
  const id = uid('CST-' + label);
  await c.query(`insert into public.safety_consents (id, site_id, visit_id, arrival_at, created_date, guardian_name, guardian_phone,
      residence, children, party_size, child_count, adult_count, is_issued)
    values ($1, $2, $3, now(), (now() at time zone 'Asia/Seoul')::date, $4, $5, '관외',
      '[{"name":"SYN 아동","birth":"2019-05-12"}]'::jsonb, 2, 1, 1, false)`, [id, SITE, 'SYN-VST-' + id, 'SYN보호자' + label, phone]);
  return id;
}
/** 서약 → 접수 → 호출 → (뒷번호) → 처리 시작까지. 반환: 팀 정보 */
async function team(c, s, label, phone, { verify = true, start = true, desk = 1 } = {}) {
  const cid = await consent(c, label, phone);
  const e = await s.rpc('enqueue_consent_team', { p_consent_id: cid, p_idempotency_key: 'SYN-KEY-' + cid, p_party_size: 2,
    p_guardian_name: 'SYN보호자' + label, p_guardian_phone: phone, p_site_id: SITE });
  assert.equal(e.ok, true, JSON.stringify(e));
  const call = await s.rpc('call_next_queue_team', { p_desk_no: desk });
  assert.equal(call.ok, true, JSON.stringify(call));
  assert.equal(call.id, e.id);
  if (verify) assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: e.id, p_last4: phone.slice(-4) })).matched, true);
  if (start) assert.equal((await s.rpc('start_queue_processing', { p_queue_id: e.id, p_desk_no: desk })).ok, true);
  return { cid, qid: e.id, phone };
}
/** createOrder 와 같은 원장: 입장권 n장(+선택 매점 품목), 결제, 티켓 */
async function ledger(c, cid, { qty = 2, price = 18000, pay = 'full', tickets = true, fnb = 0, ticketItems = true } = {}) {
  const order = uid('ORD');
  if (ticketItems) await c.query(`insert into public.order_items (item_id, order_id, product_id, product_name, product_category, unit_price, quantity, list_price, paid_amount, consent_id, status, site_id, purchased_at)
    values ($1, $2, 'tkt_basic', 'SYN 기본이용권', 'ticket', $3::bigint, $4::int, $3::bigint * $4::int, $3::bigint * $4::int, $5, 'paid', $6, now())`, [order + '-I1', order, price, qty, cid, SITE]);
  if (fnb) await c.query(`insert into public.order_items (item_id, order_id, product_id, product_name, product_category, unit_price, quantity, list_price, paid_amount, consent_id, status, site_id, purchased_at)
    values ($1, $2, 'fnb_americano', 'SYN 아메리카노', 'fnb', $3::bigint, 1, $3::bigint, $3::bigint, $4, 'paid', $5, now())`, [order + '-F1', order, fnb, cid, SITE]);
  const total = (ticketItems ? price * qty : 0) + fnb;
  const amount = pay === 'full' ? total : pay === 'partial' ? Math.floor(total / 2) : 0;
  if (amount > 0) await c.query(`insert into public.order_payments (id, order_id, site_id, consent_id, method, amount, status) values ($1, $2, $3, $4, 'card', $5, 'paid')`,
    [order + '-P1', order, SITE, cid, amount]);
  const ids = [];
  if (ticketItems) for (let i = 1; i <= qty; i++) {
    ids.push(`${order}-T${i}`);
    if (tickets) await c.query(`insert into public.ticket_ledger (ticket_id, site_id, order_id, consent_id, status, product_id, product_name, price_paid) values ($1, $2, $3, $4, 'active', 'tkt_basic', 'SYN 기본이용권', $5)`,
      [`${order}-T${i}`, SITE, order, cid, price]);
  }
  return { order, tickets: ids };
}
async function ledgerSnapshot(c) {
  const out = {};
  for (const t of ['order_items', 'order_payments', 'ticket_ledger']) {
    out[t] = (await c.query(`select xmin::text || ' ' || to_jsonb(t)::text as r from public.${t} t order by 1`)).rows.map((r) => r.r);
  }
  return out;
}
const counts = async (c) => (await c.query(`select (select count(*) from public.visit_entries)::int e, (select count(*) from public.visit_entry_tickets)::int t,
  (select count(*) from public.visit_entry_tickets where returned_at is not null)::int r, (select count(*) from public.visit_entry_requests)::int q`)).rows[0];
const qrow = async (c, id) => (await c.query(`select status, order_id, ticket_ids from public.ticket_queue where id = $1`, [id])).rows[0];

async function scenario(fn) {
  const c = await db();
  const sessions = [];
  const open = async (role, ip) => { const s = await api(role, ip); sessions.push(s); return s; };
  try { await reset(c); await fn({ c, open }); }
  finally { for (const s of sessions) { try { await s.end(); } catch (e) { /* 닫힘 */ } } await c.end(); }
}
const confirm = (s, t, o, extra = {}) => s.rpc('confirm_visit_entry', { p_queue_id: t.qid, p_order_id: o.order, p_ticket_ids: o.tickets, p_request_id: rid(), ...extra });

test('V01 정상 동선: 뒷번호 일치 + 안전점검 PASS + 원장 대사 통과 시에만 입장 확정, 원장 불변, 거울은 빈 칸만', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-1111-2222', { verify: false });
    const wrong = await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: '9999' });
    assert.deepEqual([wrong.ok, wrong.matched, wrong.attempts_left], [true, false, 4]);
    assert.ok(!JSON.stringify(wrong).includes('2222'), '불일치 응답에 정답이 없어야 함');
    const o = await ledger(c, t.cid, { qty: 3 });
    assert.equal((await confirm(s, t, o)).error, 'LAST4_NOT_VERIFIED', '뒷번호 불일치 상태에서는 입장 불가');
    assert.equal((await counts(c)).e, 0);
    assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: '2222' })).matched, true);
    const before = await ledgerSnapshot(c);
    const r = await confirm(s, t, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.ticket_count, r.inside_count, r.status, r.already_entered], [3, 3, 'inside', false]);
    assert.deepEqual(await ledgerSnapshot(c), before, '결제·발권 원장은 읽기만');
    const q = await qrow(c, t.qid);
    assert.equal(q.status, 'issued');
    assert.equal(q.order_id, o.order);
    const cs = (await c.query(`select entry_at from public.safety_consents where id = $1`, [t.cid])).rows[0];
    assert.ok(cs.entry_at, '빈 entry_at 은 채운다');
    const occ = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ.entered_teams, occ.cumulative_visitors, occ.current_inside, occ.exited_visitors], [1, 3, 3, 0]);
  });
});

test('V02 거부 조건마다 아무것도 쓰지 않는다 (상태·서약 취소·인터록·미정산·부분결제·티켓 누락·품목 취소·주문 불일치)', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const expectReject = async (t, o, code, extra) => {
      const before = await counts(c);
      const q0 = await qrow(c, t.qid);
      const r = await confirm(s, t, o, extra);
      assert.equal(r.ok, false, `${code}: ${JSON.stringify(r)}`);
      assert.equal(r.error, code, JSON.stringify(r));
      assert.deepEqual(await counts(c), before);
      assert.deepEqual(await qrow(c, t.qid), q0);
    };
    // 호출만 되고 처리 시작 전
    const tCalled = await team(c, s, 'C', '010-3000-0001', { start: false });
    await expectReject(tCalled, await ledger(c, tCalled.cid), 'INVALID_STATUS');
    // (원장이 기록된 팀은 대기열 단독 취소가 막히므로 1번 창구는 그대로 두고 2번 창구를 쓴다)
    // 미정산 (결제 없음) / 부분 결제
    const t1 = await team(c, s, 'D', '010-3000-0002', { desk: 2 });
    await expectReject(t1, await ledger(c, t1.cid, { pay: 'none' }), 'PAYMENT_NOT_CONFIRMED');
    const t1b = await ledger(c, t1.cid, { pay: 'partial' });
    await expectReject(t1, t1b, 'PARTIAL_PAYMENT_REJECTED');
    // 티켓 원장 누락
    await expectReject(t1, await ledger(c, t1.cid, { tickets: false }), 'TICKET_LEDGER_INCOMPLETE');
    // 품목 취소(환불) 후
    const oc = await ledger(c, t1.cid);
    await c.query(`update public.order_items set status = 'cancelled', cancelled_at = now() where order_id = $1`, [oc.order]);
    await expectReject(t1, oc, 'ORDER_ITEMS_EMPTY');
    // 다른 팀 서약서의 주문
    const other = await consent(c, 'X', '010-3000-0099');
    await expectReject(t1, await ledger(c, other), 'ORDER_CONSENT_MISMATCH');
    // 수량 불일치
    const oq = await ledger(c, t1.cid, { qty: 2 });
    await expectReject(t1, { order: oq.order, tickets: [oq.tickets[0]] }, 'TICKET_QUANTITY_MISMATCH');
    // 안전점검 PASS 없음 (원장은 PASS 중에 저장된 뒤 점검 기록이 사라진 경우)
    const ok = await ledger(c, t1.cid);
    await c.query(`truncate public.safety_audits`);
    await expectReject(t1, ok, 'SAFETY_INTERLOCK_BLOCKED');
    await c.query(`insert into public.safety_audits (id, site_id, audit_date, audit_at, inspector, decision, is_safe) values ('SYN-AUDIT-WARN', $1, (now() at time zone 'Asia/Seoul')::date, now(), 'SYN', 'warn', true)`, [SITE]);
    await expectReject(t1, ok, 'SAFETY_INTERLOCK_BLOCKED');
    await passAudit(c);
    // 서약 취소
    await c.query(`update public.safety_consents set status = 'cancelled', cancelled_at = now() where id = $1`, [t1.cid]);
    await expectReject(t1, ok, 'CONSENT_CANCELLED');
    await c.query(`update public.safety_consents set status = 'active', cancelled_at = null where id = $1`, [t1.cid]);
    // 입력 오류
    await expectReject(t1, ok, 'REQUEST_ID_REQUIRED', { p_request_id: 'x' });
    await expectReject(t1, { order: ok.order, tickets: [ok.tickets[0], ok.tickets[0]] }, 'DUPLICATE_TICKET_IDS');
    // 모두 고치면 통과
    assert.equal((await confirm(s, t1, ok)).ok, true);
  });
});

test('V03 멱등: 같은 request_id 재전송은 재생, 입력이 다르면 충돌, 다른 단말 재처리는 already_entered — 입장 1건', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0001');
    const o = await ledger(c, t.cid);
    const req = rid();
    const a = await confirm(s, t, o, { p_request_id: req });
    const b = await confirm(s, t, o, { p_request_id: req, p_ticket_ids: [...o.tickets].reverse() });
    assert.equal(a.ok, true);
    assert.equal(b.replayed, true, '순서만 다른 같은 티켓 집합도 같은 입력');
    assert.equal(b.entry_id, a.entry_id);
    const conflict = await confirm(s, t, o, { p_request_id: req, p_ticket_ids: [o.tickets[0]] });
    assert.equal(conflict.error, 'REQUEST_ID_CONFLICT');
    const other = await confirm(s, t, o);
    assert.deepEqual([other.ok, other.already_entered, other.entry_id], [true, true, a.entry_id]);
    const o2 = await ledger(c, t.cid);
    assert.equal((await confirm(s, t, o2)).error, 'ENTRY_EXISTS_OTHER_ORDER');
    assert.deepEqual(await counts(c), { e: 1, t: 2, r: 0, q: 1 });
  });
});

test('V04 두 단말 동시 확정 (다른 request_id): 하나만 쓰고 다른 하나는 잠금을 기다렸다가 already_entered', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0002');
    const o = await ledger(c, t.cid, { qty: 3 });
    const s1 = await open('anon', '203.0.113.41');
    const s2 = await open('anon', '203.0.113.42');
    await s1.begin();
    const r1 = await s1.call('confirm_visit_entry', { p_queue_id: t.qid, p_order_id: o.order, p_ticket_ids: o.tickets, p_request_id: rid() });
    await s2.begin();
    const p2 = s2.call('confirm_visit_entry', { p_queue_id: t.qid, p_order_id: o.order, p_ticket_ids: o.tickets, p_request_id: rid() });
    assert.equal(await stillPending(p2), true, '두 번째 단말은 시설 잠금을 기다려야 함');
    await s1.commit();
    const r2 = await p2;
    await s2.commit();
    assert.equal(r1.ok, true);
    assert.deepEqual([r2.ok, r2.already_entered, r2.entry_id], [true, true, r1.entry_id]);
    assert.deepEqual(await counts(c), { e: 1, t: 3, r: 0, q: 1 });
  });
});

test('V05 매점 단독 주문은 입장객을 늘리지 않는다 (확정 거부, 체류 중 추가 구매도 인원 불변)', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0003');
    const store = await ledger(c, t.cid, { ticketItems: false, fnb: 3500 });
    const r = await s.rpc('confirm_visit_entry', { p_queue_id: t.qid, p_order_id: store.order, p_ticket_ids: ['SYN-NONE-1'], p_request_id: rid() });
    assert.equal(r.error, 'ORDER_TICKET_ITEMS_EMPTY', JSON.stringify(r));
    const o = await ledger(c, t.cid, { qty: 2, fnb: 4000 });
    assert.equal((await confirm(s, t, o)).ok, true, '입장권+매점 혼합 주문은 입장권 수만큼');
    const occ1 = await s.rpc('get_visit_occupancy', {});
    await ledger(c, t.cid, { ticketItems: false, fnb: 2500 });   // 체류 중 매점 추가 구매
    await c.query(`insert into public.order_items (item_id, order_id, product_id, product_category, quantity, paid_amount, status, site_id, purchased_at)
      values ($1, $1, 'fnb_water', 'fnb', 1, 1000, 'paid', $2, now())`, [uid('WALKUP'), SITE]);   // 서약 없는 매점 손님
    const occ2 = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ1.cumulative_visitors, occ1.current_inside], [2, 2]);
    assert.deepEqual(occ2, occ1);
  });
});

test('V06 부분·중복·전체 반납과 인원 정의 (누적 방문·현재 체류·퇴장)', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0004');
    const o = await ledger(c, t.cid, { qty: 3 });
    const e = await confirm(s, t, o);
    const [t1, t2, t3] = o.tickets;
    const req1 = rid();
    const p1 = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [t1], p_request_id: req1 });
    assert.deepEqual([p1.ok, p1.inside_count, p1.returned_count, p1.status], [true, 2, 1, 'partial']);
    assert.equal((await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [t1], p_request_id: req1 })).replayed, true);
    const dup = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [t1], p_request_id: rid() });
    assert.equal(dup.error, 'TICKET_ALREADY_RETURNED');
    const mixed = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [t2, t1], p_request_id: rid() });
    assert.equal(mixed.error, 'TICKET_ALREADY_RETURNED');
    assert.deepEqual(mixed.already_returned, [t1]);
    assert.equal((await counts(c)).r, 1, '섞인 요청은 하나도 반영하지 않음');
    assert.equal((await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: ['SYN-OTHER'], p_request_id: rid() })).error, 'TICKET_NOT_IN_ENTRY');
    assert.equal((await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_request_id: rid() })).error, 'RETURN_TARGET_REQUIRED');
    assert.equal((await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [t2], p_return_all: true, p_request_id: rid() })).error, 'RETURN_TARGET_AMBIGUOUS');
    let occ = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ.cumulative_visitors, occ.current_inside, occ.exited_visitors, occ.partial_teams], [3, 2, 1, 1]);
    const all = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() });
    assert.deepEqual([all.ok, all.returned_now.sort(), all.inside_count, all.status], [true, [t2, t3].sort(), 0, 'exited']);
    const again = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() });
    assert.deepEqual([again.ok, again.already_exited, again.returned_now], [true, true, []]);
    occ = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ.entered_teams, occ.cumulative_visitors, occ.current_inside, occ.exited_visitors], [1, 3, 0, 3], '누적은 반납해도 줄지 않음');
    const cs = (await c.query(`select exit_at, stay_duration_minutes from public.safety_consents where id = $1`, [t.cid])).rows[0];
    assert.ok(cs.exit_at);
    // 퇴장 후 재입장 불가: 같은 확정을 다시 보내도 새 입장이 아니라 기존 기록(체류 0)
    const re = await confirm(s, t, o);
    assert.deepEqual([re.ok, re.already_entered, re.inside_count, re.status], [true, true, 0, 'exited']);
    assert.equal((await counts(c)).e, 1);
  });
});

test('V07 두 단말이 같은 팔찌를 동시에 반납: 하나만 반영, 다른 쪽 TICKET_ALREADY_RETURNED', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0005');
    const o = await ledger(c, t.cid, { qty: 2 });
    const e = await confirm(s, t, o);
    const s1 = await open('anon', '203.0.113.51');
    const s2 = await open('anon', '203.0.113.52');
    await s1.begin();
    const r1 = await s1.call('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [o.tickets[0]], p_request_id: rid() });
    await s2.begin();
    const p2 = s2.call('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [o.tickets[0]], p_request_id: rid() });
    assert.equal(await stillPending(p2), true);
    await s1.commit();
    const r2 = await p2;
    await s2.commit();
    assert.equal(r1.ok, true);
    assert.equal(r2.error, 'TICKET_ALREADY_RETURNED');
    assert.equal((await counts(c)).r, 1);
    assert.equal((await s.rpc('get_visit_occupancy', {})).current_inside, 1);
  });
});

test('V08 같은 뒷번호 두 팀: 대조는 고른 팀에만, 검색은 두 건(개인정보 없음), 한 팀 반납이 다른 팀에 영향 없음', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const a = await team(c, s, 'A', '010-5555-1234');
    const ea = await confirm(s, a, await ledger(c, a.cid, { qty: 2 }));
    const b = await team(c, s, 'B', '010-7777-1234');
    const eb = await confirm(s, b, await ledger(c, b.cid, { qty: 2 }));
    const found = await s.rpc('search_visit_entries', { p_last4: '1234' });
    assert.equal(found.entries.length, 2);
    const text = JSON.stringify(found);
    for (const secret of ['010-5555-1234', '010-7777-1234', '01055551234', 'SYN보호자A', 'SYN보호자B', a.cid, b.cid]) {
      assert.ok(!text.includes(secret), '검색 응답에 개인정보·consent_id 없음: ' + secret);
    }
    assert.ok(found.entries.every((x) => x.guardian_masked && x.guardian_masked.includes('*')));
    await s.rpc('return_visit_wristbands', { p_entry_id: ea.entry_id, p_return_all: true, p_request_id: rid() });
    const after = await s.rpc('search_visit_entries', { p_last4: '1234' });
    assert.deepEqual(after.entries.map((x) => x.entry_id), [eb.entry_id]);
    assert.equal((await s.rpc('get_visit_entry', { p_entry_id: eb.entry_id })).entry.inside_count, 2);
    assert.equal((await s.rpc('search_visit_entries', { p_last4: '12' })).error, 'LAST4_FORMAT');
  });
});

test('V09 입장 뒤 취소·환불: 확정 거래·입장 기록 보존, 체류는 반납 전까지 유지, 환불 인원은 참고값', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0006');
    const o = await ledger(c, t.cid, { qty: 2 });
    const e = await confirm(s, t, o);
    const entryBefore = (await c.query(`select to_jsonb(e) as j from public.visit_entries e`)).rows;
    // 화면 cancelOrder 와 같은 전액 환불: 품목·결제·티켓을 함께 취소 (원장은 지우지 않고 상태만)
    await c.query(`update public.order_items set status = 'cancelled', cancelled_at = now() where order_id = $1`, [o.order]);
    await c.query(`update public.order_payments set status = 'cancelled', cancelled_at = now() where order_id = $1`, [o.order]);
    await c.query(`update public.ticket_ledger set status = 'cancelled', cancelled_at = now() where order_id = $1`, [o.order]);
    assert.deepEqual((await c.query(`select to_jsonb(e) as j from public.visit_entries e`)).rows, entryBefore);
    const occ = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ.cumulative_visitors, occ.current_inside, occ.refunded_after_entry_visitors], [2, 2, 2]);
    assert.equal((await s.rpc('get_visit_entry', { p_entry_id: e.entry_id })).entry.settlement.settled, true, '전액 환불은 정산 완료(0/0)');
    assert.equal((await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() })).ok, true);
  });
});

test('V10 이전 방문 재검색: 지난 영업일 미반납은 기본 검색·현재 체류에서 빠지고 옵션·별도 항목으로만 보이며 반납 가능', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0007');
    const o = await ledger(c, t.cid, { qty: 2 });
    const e = await confirm(s, t, o);
    await c.query(`update public.visit_entries set business_date = business_date - 1, entered_at = entered_at - interval '1 day' where id = $1`, [e.entry_id]);
    await c.query(`update public.ticket_queue set queue_date = queue_date - 1 where id = $1`, [t.qid]);
    assert.equal((await s.rpc('search_visit_entries', { p_last4: '0007' })).entries.length, 0);
    const past = await s.rpc('search_visit_entries', { p_last4: '0007', p_include_past_unreturned: true });
    assert.deepEqual(past.entries.map((x) => [x.entry_id, x.past_business_date]), [[e.entry_id, true]]);
    const occ = await s.rpc('get_visit_occupancy', {});
    assert.deepEqual([occ.cumulative_visitors, occ.current_inside, occ.past_unreturned_visitors], [0, 0, 2]);
    // 같은 가족 오늘 재방문: 새 서약·새 입장 (지난 기록과 분리)
    const t2 = await team(c, s, 'A2', '010-2000-0007');
    const e2 = await confirm(s, t2, await ledger(c, t2.cid, { qty: 2 }));
    assert.notEqual(e2.entry_id, e.entry_id);
    const now = await s.rpc('search_visit_entries', { p_last4: '0007' });
    assert.deepEqual(now.entries.map((x) => x.entry_id), [e2.entry_id]);
    const r = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() });
    assert.deepEqual([r.ok, r.past_business_date, r.status], [true, true, 'exited']);
    // 지난 영업일 대기표로 확정 시도 → 거부 (입장 기록 유무보다 영업일 검사가 먼저)
    assert.equal((await confirm(s, t, o)).error, 'PAST_QUEUE_DATE');
  });
});

test('V11 호환: 구 경로(complete_queue_issuance)로 발권된 팀도 같은 주문으로 입장 기록, 다른 주문은 거부', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0008');
    const o = await ledger(c, t.cid, { qty: 2 });
    const old = await s.rpc('complete_queue_issuance', { p_queue_id: t.qid, p_order_id: o.order, p_ticket_ids: o.tickets });
    assert.equal(old.ok, true, JSON.stringify(old));
    const q0 = await qrow(c, t.qid);
    const o2 = await ledger(c, t.cid, { qty: 2 });
    assert.equal((await confirm(s, t, o2)).error, 'ALREADY_ISSUED_OTHER_ORDER');
    const r = await confirm(s, t, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await qrow(c, t.qid), q0, '이미 issued 인 대기 행은 바꾸지 않음');
  });
});

test('V12 노출 경계: 운영 암호 없이는 UNAUTHORIZED_STAFF, anon 표 직접 조회·작업자 RPC 불가', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0009');
    const e = await confirm(s, t, await ledger(c, t.cid));
    const nocode = await open('anon_nocode', '203.0.113.60');
    const calls = [
      ['verify_visit_guardian_last4', { p_access_code: 'SYN-WRONG', p_queue_id: t.qid, p_last4: '0009' }],
      ['confirm_visit_entry', { p_access_code: 'SYN-WRONG', p_queue_id: t.qid, p_order_id: 'x', p_ticket_ids: ['x'], p_request_id: rid() }],
      ['search_visit_entries', { p_access_code: 'SYN-WRONG', p_last4: '0009' }],
      ['get_visit_entry', { p_access_code: 'SYN-WRONG', p_entry_id: e.entry_id }],
      ['return_visit_wristbands', { p_access_code: 'SYN-WRONG', p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() }],
      ['get_visit_occupancy', { p_access_code: 'SYN-WRONG' }],
      ['get_queue_call_notifications', { p_access_code: 'SYN-WRONG', p_queue_id: t.qid }]
    ];
    for (const [fn, args] of calls) {
      const r = await nocode.rpc(fn, args);
      assert.equal(r.error, 'UNAUTHORIZED_STAFF', fn + ' ' + JSON.stringify(r));
      assert.ok(!JSON.stringify(r).includes('010-2000-0009'), fn + ' 인증 실패 응답에 전화번호 없음');
    }
    for (const tbl of ['visit_entries', 'visit_entry_tickets', 'visit_identity_checks', 'visit_entry_requests', 'queue_call_notifications']) {
      await nocode.begin();
      const r = await nocode.sql(`select * from public.${tbl}`);
      await nocode.rollback();
      assert.equal(r.sqlCode, '42501', tbl + ' anon 직접 조회 차단');
    }
    for (const [fn, args] of [['claim_queue_call_notifications', {}], ['report_queue_call_notification', { p_notification_id: 'x', p_claim_token: 'x', p_result: 'sent' }]]) {
      const r = await nocode.rpc(fn, args);
      assert.equal(r.sqlCode, '42501', fn + ' anon 실행 차단');
    }
    const cust = await nocode.rpc('get_queue_public_display', {});
    assert.ok(!JSON.stringify(cust).includes('010-2000-0009'));
    assert.deepEqual(await counts(c), { e: 1, t: 2, r: 0, q: 1 });
  });
});

test('V13 뒷번호 연속 5회 불일치 → 10분 잠금(정답도 거부), 10분 뒤 해제', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2000-0010', { verify: false });
    for (let i = 0; i < 5; i++) assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: '1111' })).matched, false);
    const locked = await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: '0010' });
    assert.equal(locked.error, 'LAST4_LOCKED');
    assert.ok(locked.locked_until);
    await c.query(`update public.visit_identity_checks set checked_at = checked_at - interval '11 minutes'`);
    assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: '0010' })).matched, true);
    assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: t.qid, p_last4: 'abcd' })).error, 'LAST4_FORMAT');
    assert.equal((await s.rpc('verify_visit_guardian_last4', { p_queue_id: 'SYN-NOPE', p_last4: '0010' })).error, 'not_found');
  });
});

test('V14 호출 알림: 호출 성공과 발송 결과 분리, 실패·불명은 대기열 불변·다음 팀 자동 호출 없음·중복 발송 없음 (모의 작업자)', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const worker = await open('service_role', '203.0.113.70');
    const cA = await consent(c, 'NA', '010-4000-0001');
    const cB = await consent(c, 'NB', '010-4000-0002');
    const qA = (await s.rpc('enqueue_consent_team', { p_consent_id: cA, p_idempotency_key: 'SYN-KEY-' + cA, p_party_size: 2, p_guardian_name: 'SYN', p_guardian_phone: '010-4000-0001' })).id;
    const qB = (await s.rpc('enqueue_consent_team', { p_consent_id: cB, p_idempotency_key: 'SYN-KEY-' + cB, p_party_size: 2, p_guardian_name: 'SYN', p_guardian_phone: '010-4000-0002' })).id;
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, qA);
    let n = (await c.query(`select status from public.queue_call_notifications where queue_id = $1`, [qA])).rows;
    assert.deepEqual(n.map((x) => x.status), ['pending'], '호출 1회 = 알림 1건');
    assert.equal((await s.rpc('recall_queue_team', { p_queue_id: qA })).ok, true);
    n = (await c.query(`select status, suppress_reason from public.queue_call_notifications where queue_id = $1 order by created_at`, [qA])).rows;
    assert.deepEqual(n.map((x) => x.status), ['pending', 'suppressed'], '60초 안 재호출은 억제');
    const queueBefore = (await c.query(`select to_jsonb(q) - 'updated_at' as j from public.ticket_queue q order by id`)).rows;

    // 1차 발송: 공급사가 거절(재시도 가능) → pending 대기, 같은 수령 건 재보고는 duplicate
    const claim1 = await worker.rpc('claim_queue_call_notifications', {});
    assert.equal(claim1.items.length, 1);
    assert.equal(claim1.items[0].recipient_phone, '010-4000-0001');
    const it = claim1.items[0];
    assert.equal((await worker.rpc('report_queue_call_notification', { p_notification_id: it.notification_id, p_claim_token: it.claim_token, p_result: 'retryable', p_error: 'SYN provider 503' })).status, 'pending');
    assert.equal((await worker.rpc('report_queue_call_notification', { p_notification_id: it.notification_id, p_claim_token: it.claim_token, p_result: 'sent' })).duplicate, true);
    assert.equal((await worker.rpc('claim_queue_call_notifications', {})).items.length, 0, '다음 시도 시각 전에는 다시 수령 안 됨');
    await c.query(`update public.queue_call_notifications set next_attempt_at = now() - interval '1 second' where id = $1`, [it.notification_id]);
    const claim2 = await worker.rpc('claim_queue_call_notifications', {});
    assert.equal(claim2.items[0].attempt, 2);
    assert.equal((await worker.rpc('report_queue_call_notification', { p_notification_id: it.notification_id, p_claim_token: it.claim_token, p_result: 'sent' })).error, 'STALE_CLAIM');
    assert.equal((await worker.rpc('report_queue_call_notification', { p_notification_id: it.notification_id, p_claim_token: claim2.items[0].claim_token, p_result: 'sent', p_provider_message_id: 'SYN-MSG-1' })).status, 'sent');
    assert.equal((await worker.rpc('claim_queue_call_notifications', {})).items.length, 0, '발송 완료 건은 다시 보내지 않음');

    // 대기열은 발송과 무관: 그대로, 다음 팀(B)은 waiting 유지
    assert.deepEqual((await c.query(`select to_jsonb(q) - 'updated_at' as j from public.ticket_queue q order by id`)).rows, queueBefore);
    assert.equal((await qrow(c, qB)).status, 'waiting');

    // 작업자가 수령 후 보고 없이 죽음 → 임대 만료 건은 재발송하지 않고 unknown
    await s.rpc('cancel_queue_team', { p_queue_id: qA, p_reason: 'SYN' });
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, qB);
    const claim3 = await worker.rpc('claim_queue_call_notifications', {});
    assert.equal(claim3.items.length, 1);
    await c.query(`update public.queue_call_notifications set lease_until = now() - interval '1 second' where id = $1`, [claim3.items[0].notification_id]);
    assert.equal((await worker.rpc('claim_queue_call_notifications', {})).items.length, 0);
    assert.equal((await c.query(`select status from public.queue_call_notifications where id = $1`, [claim3.items[0].notification_id])).rows[0].status, 'unknown');

    // 팀이 더 이상 호출 상태가 아니면 발송하지 않음 (expired)
    const cC = await consent(c, 'NC', '010-4000-0003');
    const qC = (await s.rpc('enqueue_consent_team', { p_consent_id: cC, p_idempotency_key: 'SYN-KEY-' + cC, p_party_size: 1, p_guardian_name: 'SYN', p_guardian_phone: '010-4000-0003' })).id;
    await s.rpc('cancel_queue_team', { p_queue_id: qB, p_reason: 'SYN' });
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, qC);
    await s.rpc('cancel_queue_team', { p_queue_id: qC, p_reason: 'SYN' });
    assert.equal((await worker.rpc('claim_queue_call_notifications', {})).items.length, 0);
    assert.equal((await c.query(`select status from public.queue_call_notifications where queue_id = $1`, [qC])).rows[0].status, 'expired');

    // 직원 조회는 상태만 (전화번호 없음)
    const st = await s.rpc('get_queue_call_notifications', { p_queue_id: qA });
    assert.deepEqual(st.items.map((x) => x.status), ['sent', 'suppressed']);
    assert.ok(!JSON.stringify(st).includes('010-4000'));
  });
});

test('V15 알림 원장 기록이 실패해도 호출은 성공한다', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    await c.query(`alter table public.queue_call_notifications add constraint syn_force_fail check (false) not valid`);
    try {
      const cid = await consent(c, 'F', '010-4100-0001');
      const q = (await s.rpc('enqueue_consent_team', { p_consent_id: cid, p_idempotency_key: 'SYN-KEY-' + cid, p_party_size: 1, p_guardian_name: 'SYN', p_guardian_phone: '010-4100-0001' })).id;
      const call = await s.rpc('call_next_queue_team', { p_desk_no: 1 });
      assert.deepEqual([call.ok, call.id], [true, q], JSON.stringify(call));
      assert.equal((await qrow(c, q)).status, 'called');
      assert.equal((await c.query(`select count(*)::int n from public.queue_call_notifications`)).rows[0].n, 0);
    } finally {
      await c.query(`alter table public.queue_call_notifications drop constraint syn_force_fail`);
    }
  });
});

test('V16 혼합 경합: 연결 6개가 확정·반납·검색을 섞어 반복해도 오류·교착 없이 원장 간 일치', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    // 입장 완료 2팀(반납 경합용) + 1·2번 창구에서 처리 중인 2팀(확정 경합용)
    const teams = [];
    for (let i = 0; i < 4; i++) {
      const t = await team(c, s, 'M' + i, `010-6000-000${i}`, { desk: i < 2 ? 1 : i - 1 });
      const o = await ledger(c, t.cid, { qty: 3 });
      if (i < 2) assert.equal((await confirm(s, t, o)).ok, true);
      teams.push({ t, o });
    }
    const conns = [];
    for (let i = 0; i < 6; i++) conns.push(await open('anon', `203.0.113.${80 + i}`));
    const results = [];
    for (let round = 0; round < 15; round++) {
      await Promise.all(conns.map(async (cn, i) => {
        const { t, o } = teams[(round + i) % teams.length];
        const pick = (round * 7 + i) % 4;
        let r;
        if (pick === 0 || pick === 1) r = await cn.rpc('confirm_visit_entry', { p_queue_id: t.qid, p_order_id: o.order, p_ticket_ids: o.tickets, p_request_id: rid() });
        else if (pick === 2) {
          const entry = (await c.query(`select id from public.visit_entries where queue_id = $1`, [t.qid])).rows[0];
          r = entry ? await cn.rpc('return_visit_wristbands', { p_entry_id: entry.id, p_ticket_ids: [o.tickets[(round + i) % 3]], p_request_id: rid() }) : { ok: true };
        } else r = await cn.rpc('search_visit_entries', {});
        results.push(r);
      }));
    }
    assert.equal(results.filter((r) => r.sqlError).length, 0, JSON.stringify(results.find((r) => r.sqlError)));
    const bad = results.filter((r) => r.ok === false && !['TICKET_ALREADY_RETURNED'].includes(r.error));
    assert.deepEqual(bad, []);
    const chk = (await c.query(`select
        (select count(*) from public.visit_entries)::int teams,
        (select count(*) from public.visit_entry_tickets)::int tickets,
        (select count(*) from public.visit_entries e where e.ticket_count <> (select count(*) from public.visit_entry_tickets t where t.entry_id = e.id))::int mismatch,
        (select count(*) from public.visit_entries e where e.status <> case
            when not exists (select 1 from public.visit_entry_tickets t where t.entry_id = e.id and t.returned_at is not null) then 'inside'
            when exists (select 1 from public.visit_entry_tickets t where t.entry_id = e.id and t.returned_at is null) then 'partial' else 'exited' end)::int bad_status,
        (select count(*) from public.visit_entry_tickets t join public.ticket_ledger l on l.ticket_id = t.ticket_id
           join public.visit_entries e on e.id = t.entry_id where l.order_id <> e.order_id)::int foreign_ticket`)).rows[0];
    assert.deepEqual(chk, { teams: 4, tickets: 12, mismatch: 0, bad_status: 0, foreign_ticket: 0 });
    const occ = await s.rpc('get_visit_occupancy', {});
    const ret = (await counts(c)).r;
    assert.deepEqual([occ.cumulative_visitors, occ.exited_visitors, occ.current_inside], [12, ret, 12 - ret]);
  });
});

test('V17 60초 뒤 재호출: 새 알림 1건만 발송, 보내지 않은 이전 알림은 expired (한 호출에 한 번)', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const worker = await open('service_role', '203.0.113.71');
    const cid = await consent(c, 'R', '010-4200-0001');
    const q = (await s.rpc('enqueue_consent_team', { p_consent_id: cid, p_idempotency_key: 'SYN-KEY-' + cid, p_party_size: 1, p_guardian_name: 'SYN', p_guardian_phone: '010-4200-0001' })).id;
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, q);
    await c.query(`update public.queue_call_notifications set created_at = created_at - interval '2 minutes' where queue_id = $1`, [q]);
    assert.equal((await s.rpc('recall_queue_team', { p_queue_id: q })).ok, true);
    const rows = (await c.query(`select status from public.queue_call_notifications where queue_id = $1 order by created_at`, [q])).rows;
    assert.deepEqual(rows.map((r) => r.status), ['pending', 'pending']);
    const claim = await worker.rpc('claim_queue_call_notifications', {});
    assert.equal(claim.items.length, 1, '재호출 알림 1건만 수령');
    const after = (await c.query(`select status from public.queue_call_notifications where queue_id = $1 order by created_at`, [q])).rows;
    assert.deepEqual(after.map((r) => r.status), ['expired', 'sending']);
    assert.equal((await worker.rpc('report_queue_call_notification', { p_notification_id: claim.items[0].notification_id, p_claim_token: claim.items[0].claim_token, p_result: 'unknown', p_error: 'SYN timeout' })).status, 'unknown');
    assert.equal((await worker.rpc('claim_queue_call_notifications', {})).items.length, 0, '불명은 자동 재발송하지 않음');
    // 하루 4번째 호출부터는 억제 (60초 간격을 두어도)
    for (let i = 0; i < 3; i++) {
      await c.query(`update public.queue_call_notifications set created_at = created_at - interval '2 minutes' where queue_id = $1`, [q]);
      await s.rpc('recall_queue_team', { p_queue_id: q });
    }
    const all = (await c.query(`select status, suppress_reason from public.queue_call_notifications where queue_id = $1 order by created_at`, [q])).rows;
    assert.equal(all.filter((r) => r.status !== 'suppressed').length, 3);
    assert.equal(all.at(-1).suppress_reason, 'daily_cap_3');
  });
});

test('V18 미정산 차단: 방문에 연결된 주문의 품목 금액 ≠ 유효 결제면 반납을 같은 트랜잭션에서 거부, 정산 후 같은 request_id 로 통과', { skip }, async () => {
  await scenario(async ({ c, open }) => {
    const s = await open();
    const t = await team(c, s, 'A', '010-2100-0001');
    const o = await ledger(c, t.cid, { qty: 2 });
    const e = await confirm(s, t, o);
    const visitId = (await c.query(`select visit_id from public.safety_consents where id = $1`, [t.cid])).rows[0].visit_id;
    const snap = async () => ({ ...(await counts(c)),
      entry: (await c.query(`select status, version from public.visit_entries where id = $1`, [e.entry_id])).rows[0],
      consent: (await c.query(`select exit_at from public.safety_consents where id = $1`, [t.cid])).rows[0] });
    const expectBlocked = async (args, balance) => {
      const before = await snap();
      const r = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, ...args });
      assert.equal(r.error, 'UNSETTLED_ORDERS', JSON.stringify(r));
      assert.ok(r.unsettled_orders.some((u) => u.balance === balance), JSON.stringify(r.unsettled_orders));
      assert.deepEqual(await snap(), before, '차단 시 아무것도 쓰지 않음');
      return r;
    };

    // (1) 매점 POS 추가 구매(방문 연동 visit_id): 품목은 서버에 올라왔고 결제는 아직 → 받을 돈 4,000
    const addon = uid('ORD-ADDON');
    await c.query(`insert into public.order_items (item_id, order_id, product_id, product_name, product_category, unit_price, quantity, list_price, paid_amount, visit_id, status, site_id, purchased_at)
      values ($1, $2, 'fnb_apple_juice', 'SYN 사과주스', 'fnb', 4000, 1, 4000, 4000, $3, 'paid', $4, now())`, [addon + '-I1', addon, visitId, SITE]);
    const req = rid();
    await expectBlocked({ p_ticket_ids: [o.tickets[0]], p_request_id: req }, 4000);
    await expectBlocked({ p_return_all: true, p_request_id: rid() }, 4000);
    const shown = await s.rpc('search_visit_entries', { p_last4: '0001' });
    assert.equal(shown.entries[0].settlement.settled, false, '검색 결과에 서버 계산 정산 상태');
    // 부분 결제 → 남은 1,500
    await c.query(`insert into public.order_payments (id, order_id, site_id, visit_id, method, amount, status) values ($1, $2, $3, $4, 'cash', 2500, 'paid')`, [addon + '-P1', addon, SITE, visitId]);
    await expectBlocked({ p_ticket_ids: [o.tickets[0]], p_request_id: req }, 1500);
    // 나머지 결제 기록 → 같은 request_id 로 다시 보내면 새로 판정되어 통과
    await c.query(`insert into public.order_payments (id, order_id, site_id, visit_id, method, amount, status) values ($1, $2, $3, $4, 'card', 1500, 'paid')`, [addon + '-P2', addon, SITE, visitId]);
    const ok1 = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_ticket_ids: [o.tickets[0]], p_request_id: req });
    assert.deepEqual([ok1.ok, ok1.inside_count, ok1.replayed], [true, 1, false]);

    // (2) 돌려줄 돈: 품목은 취소했는데 결제가 남음 (환불 미처리) → balance -3,000
    const refund = uid('ORD-REF');
    await c.query(`insert into public.order_items (item_id, order_id, product_id, product_category, quantity, paid_amount, visit_id, status, cancelled_at, site_id, purchased_at)
      values ($1, $2, 'addon_net_challenge', 'addon_attraction', 1, 3000, $3, 'cancelled', now(), $4, now())`, [refund + '-I1', refund, visitId, SITE]);
    await c.query(`insert into public.order_payments (id, order_id, site_id, visit_id, method, amount, status) values ($1, $2, $3, $4, 'card', 3000, 'paid')`, [refund + '-P1', refund, SITE, visitId]);
    await expectBlocked({ p_return_all: true, p_request_id: rid() }, -3000);
    await c.query(`update public.order_payments set status = 'cancelled', cancelled_at = now() where order_id = $1`, [refund]);

    // (3) 서약서 소속 매표 주문의 결제가 취소됐는데 품목·티켓은 살아 있음 → 받을 돈
    await c.query(`update public.order_payments set status = 'cancelled', cancelled_at = now() where order_id = $1`, [o.order]);
    await expectBlocked({ p_return_all: true, p_request_id: rid() }, 36000);
    await c.query(`update public.order_payments set status = 'paid', cancelled_at = null where order_id = $1`, [o.order]);

    // (4) 이 방문과 연결되지 않은 매점 손님의 미결제 주문은 이 방문 반납에 영향 없음
    await c.query(`insert into public.order_items (item_id, order_id, product_id, product_category, quantity, paid_amount, status, site_id, purchased_at)
      values ($1, $1, 'fnb_water', 'fnb', 1, 1000, 'paid', $2, now())`, [uid('WALKUP'), SITE]);
    const done = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() });
    assert.deepEqual([done.ok, done.status], [true, 'exited'], JSON.stringify(done));

    // (5) 남은 팔찌가 없는 전체 반납(아무것도 쓰지 않음)은 미정산과 무관하게 already_exited
    const later = uid('ORD-LATE');
    await c.query(`insert into public.order_items (item_id, order_id, product_category, quantity, paid_amount, visit_id, status, site_id, purchased_at)
      values ($1, $2, 'fnb', 1, 2000, $3, 'paid', $4, now())`, [later + '-I1', later, visitId, SITE]);
    const noop = await s.rpc('return_visit_wristbands', { p_entry_id: e.entry_id, p_return_all: true, p_request_id: rid() });
    assert.deepEqual([noop.ok, noop.already_exited], [true, true]);
  });
});

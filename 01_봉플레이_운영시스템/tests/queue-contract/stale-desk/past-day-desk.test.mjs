// CLAUDE-011 R4 — 전날 미정리 팀·창구 점유 포인터 (실제 PostgreSQL + 설치 묶음, 여러 연결 경합).
// 계약: 01_봉플레이_운영시스템/database/CONTRACT_ticket_queue_past_day.md
//
// 계층: desk-e2e 의 일회용 스택(PostgreSQL 16 + Supabase 모사 + 설치 묶음 ORDER + PostgREST)을 그대로 쓴다.
// - 직원·고객 호출은 PostgREST 와 같은 경로로 한다: authenticator 로 접속 → anon 역할 → request.headers(x-forwarded-for).
// - 결정적 경합: 연결 1 이 트랜잭션을 열어 둔 채 RPC 를 실행하고, 그동안 연결 2 의 RPC 가 기다리는지 본 뒤 연결 1 을 커밋한다.
// - "전날"은 오늘 RPC 로 만든 행의 날짜·시각을 관리자 연결로 하루 앞당겨 만든다. 실제 자정 통과는 FAKETIME 스택에서 따로 본다 (M1).
// - 원장 행은 관리자 연결로 직접 쓴다 (화면 발권은 desk-e2e 계층이 본다). 자료는 모두 SYN- 합성 값이다.
//
// 실행 (저장소 루트):
//   PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
//   E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> \
//     node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/stale-desk/past-day-desk.test.mjs
//   (M1 실제 자정 통과: FAKETIME_AT='2026-10-16 14:59:40' 를 붙여 start — UTC 기준, KST 23:59:40)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, db } from '../desk-e2e/harness.mjs';

const env = loadEnv();
const skip = !env ? 'E2E_ENV 미지정 — desk_e2e_stack.sh start 후 stack.env 경로를 지정'
  : !['127.0.0.1', 'localhost'].includes(new URL(env.E2E_PG_URL).hostname) ? '로컬이 아닌 DB 는 거부' : false;
const faketimeFile = env && env.E2E_FAKETIME_FILE ? env.E2E_FAKETIME_FILE : null;
const SITE = 'bongplay_bonghwa';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 프로미스가 ms 안에 끝나지 않으면 true (= 잠금을 기다리는 중) */
async function stillPending(promise, ms = 400) {
  const t = new Promise((r) => setTimeout(() => r('pending'), ms));
  return (await Promise.race([promise.then(() => 'settled', () => 'settled'), t])) === 'pending';
}

/** PostgREST 요청 하나와 같은 연결: authenticator → anon, x-forwarded-for 설정. begin/call/commit 으로 트랜잭션을 열어 둘 수 있다 */
async function api(ip = '203.0.113.20') {
  const pg = (await import(process.env.PG_DIR ? pathToFileURL(process.env.PG_DIR + '/lib/index.js').href : 'pg')).default;
  const conn = new pg.Client({ connectionString: env.E2E_PG_URL.replace('//postgres@', '//authenticator@') });
  await conn.connect();
  const self = {
    async begin() {
      await conn.query('begin');
      await conn.query('set local role anon');
      await conn.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`,
        [JSON.stringify({ role: 'anon' }), JSON.stringify({ 'x-forwarded-for': ip })]);
    },
    async call(fn, args = {}) {
      if (fn !== 'enqueue_consent_team' && !('p_access_code' in args)) args = { p_access_code: env.E2E_STAFF_CODE, ...args };
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
      try { return (await conn.query(sql, vals)).rows[0].r; } catch (e) { return { sqlError: e.message, sqlCode: e.code }; }
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

/** 관리자 연결로 시나리오 초기화: 대기열·원장·서약서 비움, 창구 포인터·정지 해제, 오늘(서버 KST) PASS 점검 */
async function reset(c, { desks = [1, 2] } = {}) {
  await c.query(`truncate public.ticket_queue, public.ticket_queue_rate_limits, public.order_items, public.order_payments, public.ticket_ledger, public.safety_consents, public.safety_audits`);
  await c.query(`delete from public.ticket_queue_desks where site_id = $1 and desk_no <> all($2::int[])`, [SITE, desks]);
  for (const d of desks) {
    await c.query(`insert into public.ticket_queue_desks (site_id, desk_no) values ($1, $2) on conflict (site_id, desk_no) do nothing`, [SITE, d]);
  }
  await c.query(`update public.ticket_queue_desks set current_queue_id = null, is_paused = false`);
  await c.query(`delete from private.auth_attempts`);
  await passAudit(c);
}
async function passAudit(c) {
  await c.query(`insert into public.safety_audits (id, site_id, audit_date, audit_at, inspector, decision, is_safe, note)
    select 'SYN-AUDIT-' || d, $1, d, now(), 'SYN 점검자', 'pass', true, '합성'
      from (select (now() at time zone 'Asia/Seoul')::date as d) x
    on conflict (id) do nothing`, [SITE]);
}
let seq = 0;
async function consent(c, label) {
  const id = `SYN-CST-R4-${Date.now().toString(36)}-${++seq}-${label}`;
  await c.query(`insert into public.safety_consents (id, site_id, visit_id, pass_code, arrival_at, created_date, guardian_name, guardian_phone,
      residence, children, party_size, child_count, adult_count, is_issued)
    values ($1, $2, $3, 'SYN-PASS', now(), (now() at time zone 'Asia/Seoul')::date, $4, '010-0000-0000', '관외',
      '[{"name":"SYN 아동","birth":"2019-05-12","height":115,"weight":21}]'::jsonb, 2, 1, 1, false)`, [id, SITE, 'SYN-VST-' + id, 'SYN 보호자 ' + label]);
  return id;
}
async function enqueue(s, cid) {
  const r = await s.rpc('enqueue_consent_team', { p_consent_id: cid, p_idempotency_key: 'SYN-KEY-' + cid, p_party_size: 2, p_guardian_name: 'SYN', p_guardian_phone: '010-0000-0000', p_site_id: SITE });
  assert.equal(r.ok, true, '준비 접수 실패 ' + JSON.stringify(r));
  return r.id;
}
/** 결제·티켓 원장 (화면 createOrder 와 같은 소속·수량 구조). 관리자 연결로 직접 쓴다 */
async function ledger(c, cid, orderId, { qty = 2, price = 15000 } = {}) {
  await c.query(`insert into public.order_items (item_id, order_id, product_id, product_name, product_category, unit_price, quantity, list_price, paid_amount, consent_id, status, site_id, purchased_at)
    values ($1, $2, 'tkt_basic', 'SYN 기본권', 'ticket', $3::bigint, $4::int, $3::bigint * $4::int, $3::bigint * $4::int, $5, 'paid', $6, now())`, [orderId + '-I1', orderId, price, qty, cid, SITE]);
  await c.query(`insert into public.order_payments (id, order_id, site_id, consent_id, method, amount, status) values ($1, $2, $3, $4, 'cash', $5, 'paid')`,
    [orderId + '-P1', orderId, SITE, cid, price * qty]);
  const tickets = [];
  for (let i = 1; i <= qty; i++) {
    tickets.push(`${orderId}-T${i}`);
    await c.query(`insert into public.ticket_ledger (ticket_id, site_id, order_id, consent_id, status, product_id, price_paid) values ($1, $2, $3, $4, 'active', 'tkt_basic', $5)`,
      [`${orderId}-T${i}`, SITE, orderId, cid, price]);
  }
  return tickets;
}
/** 오늘 RPC 로 만든 대기 행을 "어제" 행으로 (날짜·시각을 하루 앞당김). 창구 포인터는 그대로 둔다 */
async function toYesterday(c, ids) {
  await c.query(`update public.ticket_queue set queue_date = queue_date - 1,
      enqueued_at = enqueued_at - interval '1 day', created_at = created_at - interval '1 day', updated_at = updated_at - interval '1 day',
      called_at = called_at - interval '1 day', processing_started_at = processing_started_at - interval '1 day', hold_at = hold_at - interval '1 day'
    where id = any($1::text[])`, [ids]);
}
/** 표 전체의 행 내용과 xmin (쓰기가 있었으면 xmin 이 바뀐다) */
async function snapshot(c) {
  const out = {};
  for (const t of ['ticket_queue', 'ticket_queue_desks', 'ticket_queue_rate_limits', 'order_items', 'order_payments', 'ticket_ledger', 'safety_consents']) {
    out[t] = (await c.query(`select xmin::text as x, to_jsonb(t) as row from public.${t} t order by 2::text`)).rows.map((r) => r.x + ' ' + JSON.stringify(r.row));
  }
  return out;
}
const ledgerOnly = (s) => ({ order_items: s.order_items, order_payments: s.order_payments, ticket_ledger: s.ticket_ledger });
const row = async (c, id) => (await c.query(`select id, queue_date::text, status, desk_no, order_id, version, ticket_ids from public.ticket_queue where id = $1`, [id])).rows[0];
const pointers = async (c) => Object.fromEntries((await c.query(`select desk_no, current_queue_id from public.ticket_queue_desks where site_id = $1 order by desk_no`, [SITE])).rows.map((r) => [r.desk_no, r.current_queue_id]));

/**
 * 계약 불변식: 오늘 창구당 활성 1팀 이하, 포인터 = 오늘 점유.
 * strict: 오늘 점유가 없는 창구의 포인터는 null 이어야 한다. allowPast: 그때 지난 영업일 행을 가리키는 것(옛 판 잔재, 조회가 stale 로 보고)은 허용.
 */
async function invariants(c, { strict = true, allowPast = false } = {}) {
  const today = (await c.query(`select (now() at time zone 'Asia/Seoul')::date::text d`)).rows[0].d;
  const act = (await c.query(`select desk_no, array_agg(id order by id) ids from public.ticket_queue
    where site_id = $1 and queue_date = $2 and status in ('called','processing') group by desk_no`, [SITE, today])).rows;
  const problems = [];
  for (const a of act) {
    if (a.desk_no === null) problems.push(`창구 없는 활성 팀 ${a.ids}`);
    else if (a.ids.length > 1) problems.push(`${a.desk_no}번 창구 활성 ${a.ids.length}팀 ${a.ids}`);
  }
  const ptr = await pointers(c);
  for (const [desk, qid] of Object.entries(ptr)) {
    const occ = act.find((a) => String(a.desk_no) === desk);
    if (occ && !occ.ids.includes(qid)) problems.push(`${desk}번 창구 포인터 ${qid} ≠ 오늘 점유 ${occ.ids}`);
    if (!occ && qid && strict) {
      const past = (await c.query(`select queue_date < $2::date p from public.ticket_queue where id = $1`, [qid, today])).rows[0];
      if (!(allowPast && past && past.p)) problems.push(`${desk}번 창구 포인터 ${qid} 가 오늘 점유가 아님`);
    }
  }
  for (const a of act) if (a.desk_no !== null && !(String(a.desk_no) in ptr)) problems.push(`창구 행 없는 점유 ${a.desk_no}`);
  return problems;
}

async function withScenario(fn, opts) {
  const c = await db();
  const sessions = [];
  const open = async (ip) => { const s = await api(ip); sessions.push(s); return s; };
  try {
    await reset(c, opts);
    await fn({ c, open });
  } finally {
    for (const s of sessions) { try { await s.end(); } catch (e) { /* 닫힘 */ } }
    await c.end();
  }
}

/** 어제 desk 1 에서 결제·티켓까지 저장하고 완료하지 못한 팀 A (포인터는 A 를 가리킨 채 남음) + 오늘 대기 팀 */
async function pastProcessingWithOrder({ c, open }, { todayTeams = 1 } = {}) {
  const s = await open();
  const ca = await consent(c, 'A');
  const qa = await enqueue(s, ca);
  assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, qa);
  assert.equal((await s.rpc('start_queue_processing', { p_queue_id: qa, p_desk_no: 1 })).ok, true);
  const order = 'SYN-ORD-R4-A-' + Date.now().toString(36);
  const tickets = await ledger(c, ca, order);
  await toYesterday(c, [qa]);
  const today = [];
  for (let i = 0; i < todayTeams; i++) {
    const cid = await consent(c, 'T' + i);
    today.push({ cid, qid: await enqueue(s, cid) });
  }
  return { s, ca, qa, order, tickets, today };
}

test('P1/P2 yesterday\'s unfinished team does not block today; the call replaces the stale pointer and leaves that team and its ledger untouched', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c } = ctx;
    const { s, qa, order, today } = await pastProcessingWithOrder(ctx);
    const before = await snapshot(c);
    const pastBefore = await row(c, qa);

    const list = await s.rpc('get_staff_queue_list', {});
    assert.equal(list.ok, true, JSON.stringify(list));
    const d1 = list.desks.find((d) => d.desk_no === 1);
    assert.equal(d1.pointer_queue_id, qa);
    assert.equal(d1.pointer_state, 'stale', JSON.stringify(d1));
    assert.equal(d1.pointer_stale && d1.pointer_stale.reason, 'past_day', JSON.stringify(d1));
    assert.equal(d1.current_queue_id, null, '전날 팀을 오늘 점유로 보고함');
    assert.equal(d1.occupant, null);
    assert.equal(list.past_unresolved_total, 1);
    const p = list.past_unresolved_teams[0];
    assert.equal(p.id, qa);
    assert.equal(p.status, 'processing');
    assert.deepEqual(p.recorded_orders.map((o) => o.order_id), [order]);
    assert.deepEqual(p.recorded_orders[0], { order_id: order, item_total: 30000, paid_total: 30000, active_tickets: 2 });
    assert.deepEqual(p.allowed_actions, ['complete_queue_issuance']);
    assert.deepEqual(list.called_teams, [], '오늘 목록에 전날 팀이 섞임');

    const called = await s.rpc('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(called.ok, true, `오늘 호출이 전날 팀 때문에 막힘: ${JSON.stringify(called)}`);
    assert.equal(called.id, today[0].qid);
    assert.equal(called.replaced_pointer && called.replaced_pointer.queue_id, qa, JSON.stringify(called));
    assert.equal(called.replaced_pointer.reason, 'past_day');

    assert.deepEqual(await row(c, qa), pastBefore, '전날 팀 행이 바뀜 (자동 정리 금지)');
    assert.deepEqual(ledgerOnly(await snapshot(c)), ledgerOnly(before), '원장이 바뀜');
    const after = await s.rpc('get_staff_queue_list', {});
    const a1 = after.desks.find((d) => d.desk_no === 1);
    assert.equal(a1.pointer_state, 'ok');
    assert.equal(a1.current_queue_id, today[0].qid);
    assert.equal(after.past_unresolved_teams[0].id, qa, '전날 팀이 목록에서 사라짐');
    assert.deepEqual(await invariants(c), []);
  });
});

test('R1 the staff list is read-only: repeated reads leave queue, desk, rate-limit, consent and ledger rows byte-identical (stale pointers are reported, not repaired)', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c } = ctx;
    const { s, today } = await pastProcessingWithOrder(ctx, { todayTeams: 3 });
    // 옛 판이 남긴 상태를 만든다: 2번 창구 → 오늘 완료된 팀(inactive), 3번 창구 → 오늘 호출된 팀이 있는데 포인터 없음(missing)
    const t0 = today[0];
    const t1 = today[1];
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 2 })).id, t0.qid);
    await c.query(`update public.ticket_queue set status = 'issued' where id = $1`, [t0.qid]);
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 3 })).id, t1.qid);
    await c.query(`update public.ticket_queue_desks set current_queue_id = null where desk_no = 3`);
    const before = await snapshot(c);
    let last;
    for (let i = 0; i < 5; i++) {
      last = await s.rpc('get_staff_queue_list', i % 2 ? { p_date: '2026-01-01' } : {});
      assert.equal(last.ok, true, JSON.stringify(last));
    }
    const after = await snapshot(c);
    assert.deepEqual(after, before, '조회 RPC 가 표를 바꿈 (숨은 쓰기)');
    const st = Object.fromEntries(last.desks.map((d) => [d.desk_no, [d.pointer_state, d.pointer_stale && d.pointer_stale.reason, d.current_queue_id]]));
    assert.deepEqual(st, { 1: ['stale', 'past_day', null], 2: ['stale', 'inactive', null], 3: ['missing', null, t1.qid] }, JSON.stringify(last.desks));
    console.log(`# R1 관찰: 조회 5회 전후 표 7개 행·xmin 동일, 창구 상태 ${JSON.stringify(st)}`);
  }, { desks: [1, 2, 3] });
});

test('P5 yesterday\'s team cannot be recalled, started, held or restored as if it were today (PAST_QUEUE_DATE, nothing changes)', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c, open } = ctx;
    const s = await open();
    const [cc, cn] = [await consent(c, 'CALLED'), await consent(c, 'HELD')];
    const qc = await enqueue(s, cc);
    const qn = await enqueue(s, cn);
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, qc);
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 2 })).id, qn);
    assert.equal((await s.rpc('hold_queue_team', { p_queue_id: qn })).ok, true);
    await toYesterday(c, [qc, qn]);
    const before = await snapshot(c);
    const res = {
      recall: await s.rpc('recall_queue_team', { p_queue_id: qc, p_desk_no: 1 }),
      start: await s.rpc('start_queue_processing', { p_queue_id: qc, p_desk_no: 1 }),
      hold: await s.rpc('hold_queue_team', { p_queue_id: qc }),
      restore: await s.rpc('restore_queue_team', { p_queue_id: qn })
    };
    for (const [k, r] of Object.entries(res)) {
      assert.equal(r.ok, false, `${k}: 전날 팀에 오늘 창구 동작이 됨 ${JSON.stringify(r)}`);
      assert.equal(r.error, 'PAST_QUEUE_DATE', `${k}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(res.recall.allowed_actions, ['cancel_queue_team']);
    assert.deepEqual(await snapshot(c), before, '거부했는데 표가 바뀜');
  });
});

test('P6 yesterday\'s team with a recorded order: cancel is refused, completion with the same order id succeeds once and is idempotent; ledger and today\'s pointer are untouched', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c } = ctx;
    const { s, qa, order, tickets, today } = await pastProcessingWithOrder(ctx);
    assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, today[0].qid, '준비: 오늘 팀이 1번 창구 점유');
    const before = await snapshot(c);

    const cancel = await s.rpc('cancel_queue_team', { p_queue_id: qa, p_reason: 'SYN 정리' });
    assert.equal(cancel.ok, false, `원장이 저장된 전날 팀의 대기열만 취소됨 ${JSON.stringify(cancel)}`);
    assert.equal(cancel.error, 'ORDER_RECORDED');
    assert.deepEqual(cancel.recorded_orders.map((o) => o.order_id), [order]);
    assert.deepEqual(await snapshot(c), before, '거부했는데 표가 바뀜');

    const other = await s.rpc('complete_queue_issuance', { p_queue_id: qa, p_order_id: 'SYN-ORD-OTHER', p_ticket_ids: tickets });
    assert.equal(other.ok, false, '다른 주문 id 로 완료됨');

    const done = await s.rpc('complete_queue_issuance', { p_queue_id: qa, p_order_id: order, p_ticket_ids: tickets });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.past_queue_date, true);
    const again = await s.rpc('complete_queue_issuance', { p_queue_id: qa, p_order_id: order, p_ticket_ids: tickets });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    const r = await row(c, qa);
    assert.equal(r.status, 'issued');
    assert.equal(r.order_id, order, '기존 주문 id 가 연결되지 않음');
    assert.deepEqual(ledgerOnly(await snapshot(c)), ledgerOnly(before), '원장이 바뀜');
    assert.deepEqual(await pointers(c), { 1: today[0].qid, 2: null }, '전날 팀 완료가 오늘 팀 포인터를 지움');
    const list = await s.rpc('get_staff_queue_list', {});
    assert.equal(list.past_unresolved_total, 0);
    assert.deepEqual(await invariants(c), []);
  });
});

test('P6b yesterday\'s team without any order: explicit cancel is allowed (and is the only action offered)', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c, open } = ctx;
    const s = await open();
    const cid = await consent(c, 'NOORDER');
    const qid = await enqueue(s, cid);
    await s.rpc('call_next_queue_team', { p_desk_no: 2 });
    assert.equal((await s.rpc('start_queue_processing', { p_queue_id: qid })).ok, true);
    await toYesterday(c, [qid]);
    const list = await s.rpc('get_staff_queue_list', {});
    assert.deepEqual(list.past_unresolved_teams.map((t) => [t.id, t.allowed_actions, t.recorded_orders]), [[qid, ['cancel_queue_team'], []]]);
    const before = await snapshot(c);
    const r = await s.rpc('cancel_queue_team', { p_queue_id: qid, p_reason: 'SYN 전날 미정리' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.past_queue_date, true);
    assert.equal((await row(c, qid)).status, 'canceled');
    assert.deepEqual(ledgerOnly(await snapshot(c)), ledgerOnly(before));
    assert.deepEqual(await invariants(c), []);
  });
});

test('C1 two terminals calling the same desk at the same moment (stale pointer present): exactly one wins, the other sees DESK_ALREADY_OCCUPIED with the occupant', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c, open } = ctx;
    const { today } = await pastProcessingWithOrder(ctx, { todayTeams: 2 });
    const s1 = await open('203.0.113.21');
    const s2 = await open('203.0.113.22');
    await s1.begin();
    const r1 = await s1.call('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p2 = s2.rpc('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(await stillPending(p2), true, '두 번째 호출이 잠금을 기다리지 않음');
    await s1.commit();
    const r2 = await p2;
    assert.equal(r2.sqlError, undefined, JSON.stringify(r2));
    assert.equal(r2.ok, false, `한 창구에 두 팀 호출 ${JSON.stringify(r2)}`);
    assert.equal(r2.error, 'DESK_ALREADY_OCCUPIED');
    assert.equal(r2.occupant && r2.occupant.id, today[0].qid);
    assert.deepEqual(await invariants(c), []);
  });
});

test('C2 moving a team into a desk races with a call on that desk: never two active teams on one desk, pointers follow the move (both orders)', { skip }, async () => {
  for (const order of ['call-first', 'move-first']) {
    await withScenario(async ({ c, open }) => {
      const s = await open();
      const ids = [];
      for (const l of ['X', 'Y']) ids.push(await enqueue(s, await consent(c, l)));
      assert.equal((await s.rpc('call_next_queue_team', { p_desk_no: 1 })).id, ids[0], '준비: X 는 1번 창구');
      const s1 = await open('203.0.113.21');
      const s2 = await open('203.0.113.22');
      const call = { fn: 'call_next_queue_team', args: { p_desk_no: 2 } };
      const move = { fn: 'start_queue_processing', args: { p_queue_id: ids[0], p_desk_no: 2 } };
      const [first, second] = order === 'call-first' ? [call, move] : [move, call];
      await s1.begin();
      const r1 = await s1.call(first.fn, first.args);
      assert.equal(r1.ok, true, `${order}: ${JSON.stringify(r1)}`);
      const p2 = s2.rpc(second.fn, second.args);
      assert.equal(await stillPending(p2), true, `${order}: 두 번째 요청이 잠금을 기다리지 않음`);
      await s1.commit();
      const r2 = await p2;
      assert.equal(r2.sqlError, undefined, JSON.stringify(r2));
      assert.equal(r2.ok, false, `${order}: 2번 창구에 두 팀 ${JSON.stringify(r2)}`);
      assert.equal(r2.error, 'DESK_ALREADY_OCCUPIED');
      const problems = await invariants(c);
      assert.deepEqual(problems, [], `${order}: ${problems.join('; ')}`);
      if (order === 'move-first') assert.deepEqual(await pointers(c), { 1: null, 2: ids[0] }, '이동 뒤 옛 창구 포인터가 남음');
    });
  }
});

test('C3 pause and call on the same desk at the same moment: a committed pause wins, a call already in progress finishes first', { skip }, async () => {
  for (const order of ['pause-first', 'call-first']) {
    await withScenario(async ({ c, open }) => {
      const s = await open();
      const q = await enqueue(s, await consent(c, 'P'));
      const s1 = await open('203.0.113.21');
      const s2 = await open('203.0.113.22');
      const pause = { fn: 'set_desk_pause_status', args: { p_desk_no: 1, p_is_paused: true } };
      const call = { fn: 'call_next_queue_team', args: { p_desk_no: 1 } };
      const [first, second] = order === 'pause-first' ? [pause, call] : [call, pause];
      await s1.begin();
      assert.equal((await s1.call(first.fn, first.args)).ok, true);
      const p2 = s2.rpc(second.fn, second.args);
      await stillPending(p2);
      await s1.commit();
      const r2 = await p2;
      const st = (await c.query(`select status from public.ticket_queue where id = $1`, [q])).rows[0].status;
      if (order === 'pause-first') {
        assert.equal(r2.ok, false, `정지된 창구로 호출됨 ${JSON.stringify(r2)}`);
        assert.equal(r2.error, 'DESK_PAUSED');
        assert.equal(st, 'waiting');
      } else {
        assert.equal(r2.ok, true);
        assert.equal(st, 'called');
      }
      assert.deepEqual(await invariants(c), []);
    });
  }
});

test('C4 completing yesterday\'s team while today\'s team is called on the same desk (both orders): both succeed and the desk keeps pointing at today\'s team', { skip }, async () => {
  for (const order of ['complete-first', 'call-first']) {
    await withScenario(async (ctx) => {
      const { c, open } = ctx;
      const { qa, order: oid, tickets, today } = await pastProcessingWithOrder(ctx);
      const s1 = await open('203.0.113.21');
      const s2 = await open('203.0.113.22');
      const complete = { fn: 'complete_queue_issuance', args: { p_queue_id: qa, p_order_id: oid, p_ticket_ids: tickets } };
      const call = { fn: 'call_next_queue_team', args: { p_desk_no: 1 } };
      const [first, second] = order === 'complete-first' ? [complete, call] : [call, complete];
      await s1.begin();
      const r1 = await s1.call(first.fn, first.args);
      const p2 = s2.rpc(second.fn, second.args);
      await stillPending(p2);
      await s1.commit();
      const r2 = await p2;
      assert.equal(r1.ok && r2.ok, true, `${order}: ${JSON.stringify([r1, r2])}`);
      assert.equal((await row(c, qa)).order_id, oid);
      assert.deepEqual(await pointers(c), { 1: today[0].qid, 2: null }, `${order}: 오늘 팀 포인터가 지워짐`);
      assert.deepEqual(await invariants(c), []);
    });
  }
});

test('C5 HTTP through PostgREST: 10 rounds of two simultaneous calls on the same desk each put exactly one team on it', { skip }, async () => {
  await withScenario(async ({ c, open }) => {
    const s = await open();
    for (let i = 0; i < 20; i++) await enqueue(s, await consent(c, 'H' + i));
    const callHttp = (ip) => fetch(env.E2E_PGRST_URL + '/rpc/call_next_queue_team', {
      method: 'POST',
      headers: { apikey: env.E2E_ANON_KEY, Authorization: 'Bearer ' + env.E2E_ANON_KEY, 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ p_access_code: env.E2E_STAFF_CODE, p_desk_no: 1, p_site_id: SITE })
    }).then(async (r) => ({ http: r.status, body: await r.json().catch(() => null) }));
    const tally = { ok: 0, occupied: 0, other: [] };
    for (let round = 0; round < 10; round++) {
      const rs = await Promise.all([callHttp('203.0.113.31'), callHttp('203.0.113.32')]);
      for (const r of rs) {
        if (r.http === 200 && r.body && r.body.ok) tally.ok++;
        else if (r.body && r.body.error === 'DESK_ALREADY_OCCUPIED') tally.occupied++;
        else tally.other.push(r);
      }
      const problems = await invariants(c);
      assert.deepEqual(problems, [], `round ${round}: ${problems.join('; ')}`);
      const cur = (await pointers(c))[1];
      await c.query(`update public.ticket_queue set status = 'canceled' where id = $1`, [cur]);
      await c.query(`update public.ticket_queue_desks set current_queue_id = null where desk_no = 1`);
    }
    console.log(`# C5 관찰: 10회 × 동시 2건 → 성공 ${tally.ok}, DESK_ALREADY_OCCUPIED ${tally.occupied}, 기타 ${tally.other.length}`);
    assert.equal(tally.ok, 10);
    assert.equal(tally.occupied, 10);
    assert.deepEqual(tally.other, []);
  });
});

test('S1 stress: 8 connections × 40 rounds of mixed staff actions (call, move, recall, hold, restore, cancel, complete) — no SQL error or deadlock, invariants hold, ledger untouched, yesterday\'s team untouched', { skip }, async () => {
  await withScenario(async (ctx) => {
    const { c, open } = ctx;
    const { qa } = await pastProcessingWithOrder(ctx, { todayTeams: 0 });
    const s = await open();
    const teams = [];
    for (let i = 0; i < 24; i++) {
      const cid = await consent(c, 'S' + i);
      const qid = await enqueue(s, cid);
      const order = `SYN-ORD-R4-S${i}-${Date.now().toString(36)}`;
      teams.push({ cid, qid, order, tickets: await ledger(c, cid, order) });
    }
    const pastBefore = await row(c, qa);
    const ledgerBefore = ledgerOnly(await snapshot(c));
    const conns = await Promise.all(Array.from({ length: 8 }, (_, i) => open(`203.0.113.${40 + i}`)));
    // 결정적 의사난수 (mulberry32). 대상 팀은 매 라운드 시작 시 상태에 맞는 집합에서 고른다 (대부분 유효한 동작이 되도록)
    let seed = 20261017;
    const rand = (n) => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) % n); };
    const pick = (arr) => (arr.length ? arr[rand(arr.length)] : teams[rand(teams.length)].qid);
    const counts = {};
    const errors = [];
    for (let round = 0; round < 40; round++) {
      const st = (await c.query(`select id, status from public.ticket_queue where queue_date = (now() at time zone 'Asia/Seoul')::date`)).rows;
      const by = (...ss) => st.filter((r) => ss.includes(r.status)).map((r) => r.id);
      const ops = conns.map((conn) => {
        const desk = 1 + rand(3);
        const k = rand(8);
        const active = by('called', 'processing');
        const op = [
          () => ['call_next_queue_team', { p_desk_no: desk }],
          () => ['start_queue_processing', { p_queue_id: pick(by('called')), p_desk_no: desk }],
          () => ['recall_queue_team', { p_queue_id: pick(active), p_desk_no: desk }],
          () => ['hold_queue_team', { p_queue_id: pick(active) }],
          () => ['restore_queue_team', { p_queue_id: pick(by('no_show')) }],
          () => ['cancel_queue_team', { p_queue_id: pick(by('waiting', 'called', 'no_show')) }],
          () => { const t = teams.find((x) => x.qid === pick(by('processing'))) || teams[0]; return ['complete_queue_issuance', { p_queue_id: t.qid, p_order_id: t.order, p_ticket_ids: t.tickets }]; },
          () => ['get_staff_queue_list', {}]
        ][k]();
        return conn.rpc(op[0], op[1]).then((r) => {
          const key = op[0] + ':' + (r && r.ok ? 'ok' : (r && (r.error || r.sqlCode)) || '?');
          counts[key] = (counts[key] || 0) + 1;
          if (r && r.sqlError !== undefined) errors.push(`${op[0]} ${r.sqlCode} ${r.sqlError}`);
        });
      });
      await Promise.all(ops);
      const problems = await invariants(c, { allowPast: true });
      assert.deepEqual(problems, [], `round ${round}: ${problems.join('; ')}`);
      if (round % 10 === 9) {   // 대기 팀이 바닥나지 않게 취소된 팀을 되살린다 (관리자, 시험 장치)
        await c.query(`update public.ticket_queue set status = 'waiting', desk_no = null where status = 'canceled' and queue_date = (now() at time zone 'Asia/Seoul')::date`);
      }
    }
    console.log(`# S1 관찰: ${JSON.stringify(counts)}`);
    const missing = ['call_next_queue_team', 'start_queue_processing', 'recall_queue_team', 'hold_queue_team', 'restore_queue_team', 'cancel_queue_team', 'complete_queue_issuance']
      .filter((f) => !counts[f + ':ok']);
    assert.deepEqual(missing, [], '경합 시험이 이 동작을 한 번도 성공시키지 못함 (시험 장치 점검 필요)');
    assert.deepEqual(errors, [], `SQL 오류 ${errors.length}건: ${errors.slice(0, 3).join(' | ')}`);
    assert.deepEqual(ledgerOnly(await snapshot(c)), ledgerBefore, '대기열 RPC 가 원장을 바꿈');
    assert.deepEqual(await row(c, qa), pastBefore, '전날 팀이 바뀜');
  }, { desks: [1, 2, 3] });
});

test('M1 real midnight (server clock under libfaketime): a team left processing at 23:59 KST shows as past-unresolved after 00:00 and does not block the first call of the new day', { skip: skip || (!faketimeFile && 'FAKETIME_AT 로 시작한 스택이 아님 — 실제 자정 통과 시험 건너뜀') }, async () => {
  const setClock = (utc) => fs.writeFileSync(faketimeFile, '@' + utc + '\n');
  setClock('2026-10-16 14:59:40');           // KST 23:59:40
  await withScenario(async ({ c, open }) => {
    const s = await open();
    const kst = async () => (await c.query(`select (now() at time zone 'Asia/Seoul')::text t, (now() at time zone 'Asia/Seoul')::date::text d`)).rows[0];
    const k0 = await kst();
    assert.equal(k0.d, '2026-10-16', `준비: 서버 시계 ${k0.t}`);
    const ca = await consent(c, 'MID');
    const qa = await enqueue(s, ca);
    await s.rpc('call_next_queue_team', { p_desk_no: 1 });
    assert.equal((await s.rpc('start_queue_processing', { p_queue_id: qa })).ok, true);
    const oid = 'SYN-ORD-R4-MID';
    const tickets = await ledger(c, ca, oid);
    setClock('2026-10-16 15:00:05');         // KST 00:00:05 다음 날
    const k1 = await kst();
    assert.equal(k1.d, '2026-10-17', `자정 통과 실패: ${k1.t}`);
    await passAudit(c);
    const cb = await consent(c, 'NEWDAY');
    const qb = await enqueue(s, cb);
    const list = await s.rpc('get_staff_queue_list', {});
    assert.equal(list.queue_day, '2026-10-17');
    assert.deepEqual(list.past_unresolved_teams.map((t) => [t.id, t.queue_date, t.allowed_actions]), [[qa, '2026-10-16', ['complete_queue_issuance']]]);
    assert.equal(list.desks.find((d) => d.desk_no === 1).pointer_state, 'stale');
    const called = await s.rpc('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(called.id, qb, JSON.stringify(called));
    const done = await s.rpc('complete_queue_issuance', { p_queue_id: qa, p_order_id: oid, p_ticket_ids: tickets });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.queue_date, '2026-10-16');
    assert.deepEqual(await pointers(c), { 1: qb, 2: null });
    console.log(`# M1 관찰: 서버 KST ${k0.t} → ${k1.t}, 전날 팀 ${qa} 과거 미정리로 표시 → 새날 첫 호출 ${called.formatted_number} 성공 → 전날 팀 같은 주문 ${oid} 로 완료`);
  });
});

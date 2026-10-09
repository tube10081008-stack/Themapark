// CLAUDE-011 — ANT-006 제안 SQL 의 계약 적합성 시험 (PGlite 계층).
// 시험은 계약을 기준으로 단언한다. 실패는 구현 결함 검출을 뜻한다. 상태 이름만 status-map.mjs 로 연결한다.
//
// 실행 (저장소 루트):
//   ANT006_SQL=<ANT-006 체크아웃>/01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql \
//   PGLITE_DIR=<pglite 설치 경로>/node_modules/@electric-sql/pglite \
//   node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/sql-conformance.test.mjs
// ANT006_SQL 이 없으면 전부 건너뛴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANT006_SQL, STAFF_CODE, createDb, loadMigration, callAs, rows, hasParam } from './harness.mjs';
import { impl } from './status-map.mjs';

const skip = ANT006_SQL ? false : 'ANT006_SQL 미지정 — 대상 구현 없이 건너뜀';
const STAFF_RPCS = [
  'call_next_queue_team', 'recall_queue_team', 'start_queue_processing', 'hold_queue_team', 'restore_queue_team',
  'cancel_queue_team', 'complete_queue_issuance', 'get_staff_queue_list', 'set_desk_pause_status'
];
const rejected = (r) => !!r && (r.sqlError !== undefined || r.ok === false);

async function freshDb(opts) {
  const db = await createDb(opts);
  await loadMigration(db);
  await db.exec(`insert into public.safety_consents (id, guardian_name) values ('cst_A','SENTINEL_A'),('cst_B','SENTINEL_B'),('cst_C','SENTINEL_C')`);
  return db;
}
async function enqueue(db, consent, key) {
  const r = await callAs(db, 'anon', 'enqueue_consent_team', { p_consent_id: consent, p_idempotency_key: key, p_party_size: 2, p_guardian_name: 'SENTINEL', p_guardian_phone: '010-0000-0000' });
  assert.equal(r.ok, true, `접수 준비 실패: ${JSON.stringify(r)}`);
  return r;
}
/** A 를 serving(=processing)으로 만들고, A·B 의 주문·수납·티켓 원장을 합성으로 만든다 */
async function servingWithLedger(db) {
  const a = await enqueue(db, 'cst_A', 'kA');
  const b = await enqueue(db, 'cst_B', 'kB');
  const called = await callAs(db, 'staff', 'call_next_queue_team', { p_desk_no: 1 });
  assert.equal(called.id, a.id, `준비: A 호출 실패 ${JSON.stringify(called)}`);
  const s = await callAs(db, 'staff', 'start_queue_processing', { p_queue_id: a.id });
  assert.equal(s.status, impl('serving'), `준비: serving 전이 실패 ${JSON.stringify(s)}`);
  await db.exec(`
    insert into public.order_items (item_id, order_id, product_id, category, unit_price, quantity, total_price) values
      ('it_A','ord_A','tkt_basic','ticket',15000,2,30000), ('it_B','ord_B','tkt_basic','ticket',15000,1,15000);
    insert into public.order_payments (id, order_id, consent_id, method, amount, status) values
      ('pay_A','ord_A','cst_A','card',30000,'paid'), ('pay_B','ord_B','cst_B','card',15000,'paid');
    insert into public.ticket_ledger (ticket_id, consent_id, order_id, product_id, status) values
      ('T_A1','cst_A','ord_A','tkt_basic','active'), ('T_A2','cst_A','ord_A','tkt_basic','active'),
      ('T_B1','cst_B','ord_B','tkt_basic','active');`);
  return { a, b };
}
const statusOf = async (db, id) => (await rows(db, `select status, version, order_id from public.ticket_queue where id = $1`, [id]))[0];

// ---- 1. 고객 조회: 공개 ID 거부, 토큰 만료 (계약 §11) ---------------------------------
test('customer lookup by row id (not token) is rejected', { skip }, async () => {
  const db = await freshDb();
  const a = await enqueue(db, 'cst_A', 'k1');
  // 계약 §11: 128비트 이상 무작위. 접두어 형식은 구현 자유 (예: 'bpq_' + 32 hex)
  assert.match(a.customer_token, /^(?:[a-z]+_)?[0-9a-f]{32,}$/, '128비트(32 hex) 이상 토큰');
  const byToken = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.customer_token });
  assert.equal(byToken.ok, true, `토큰 조회는 성공해야 함 ${JSON.stringify(byToken)}`);
  const byId = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.id });
  assert.ok(rejected(byId), `행 id 로 고객 상태가 조회됨: ${JSON.stringify(byId)}`);
});

test('customer token expires after its business day', { skip }, async () => {
  const db = await freshDb();
  const a = await enqueue(db, 'cst_A', 'k1');
  // 합성: 접수일을 전날로 옮겨 "지난 영업일 토큰" 을 만든다 (서버 시계 주입 수단이 없어 데이터로 모사)
  await db.exec(`update public.ticket_queue set queue_date = queue_date - 1 where id = '${a.id}'`);
  const r = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.customer_token });
  assert.ok(rejected(r), `지난 영업일 토큰이 아직 유효: ${JSON.stringify(r)}`);
});

test('customer token older than 24h is rejected (mechanism check, weaker than contract business-day expiry)', { skip }, async () => {
  // 계약 기준(영업일 종료)은 위 시험이 검사한다. 이 시험은 구현이 둔 24시간 만료 장치 자체가 동작하는지만 분리해 확인한다.
  const db = await freshDb();
  const a = await enqueue(db, 'cst_A', 'k1');
  await db.exec(`update public.ticket_queue set enqueued_at = enqueued_at - interval '25 hours' where id = '${a.id}'`);
  const r = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.customer_token });
  assert.ok(rejected(r), `25시간 지난 토큰이 유효: ${JSON.stringify(r).slice(0, 200)}`);
});

test('customer status response carries no internal id beyond the caller\'s own token', { skip }, async () => {
  const db = await freshDb();
  const a = await enqueue(db, 'cst_A', 'k1');
  const r = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.customer_token });
  assert.equal(r.ok, true);
  assert.ok(!('id' in r), `고객 응답에 내부 행 id 포함: ${r.id}`);
});

// ---- 2. 직원 조작 권한: anon·로그인 비직원 거부 (계약 §9.1) --------------------------------
// 각 함수가 실제로 성공할 수 있는 상태를 직원 권한으로 먼저 만든 뒤 호출한다 (없는 id 로 인한 거부를 권한 거부로 오인하지 않기 위해).
// 거부 판정 + 대기열·창구 상태가 바뀌지 않았는지 함께 확인한다.
async function prepareFor(db, fn) {
  const a = await enqueue(db, 'cst_A', 'kA');
  const id = a.id;
  const asStaff = (f, x) => callAs(db, 'staff', f, x);
  switch (fn) {
    case 'call_next_queue_team': return { p_desk_no: 1 };
    case 'recall_queue_team': await asStaff('call_next_queue_team', { p_desk_no: 1 }); return { p_queue_id: id, p_desk_no: 2 };
    case 'start_queue_processing': await asStaff('call_next_queue_team', { p_desk_no: 1 }); return { p_queue_id: id };
    case 'hold_queue_team': await asStaff('call_next_queue_team', { p_desk_no: 1 }); return { p_queue_id: id };
    case 'restore_queue_team': await asStaff('call_next_queue_team', { p_desk_no: 1 }); await asStaff('hold_queue_team', { p_queue_id: id }); return { p_queue_id: id };
    case 'cancel_queue_team': return { p_queue_id: id };
    case 'complete_queue_issuance': {
      await asStaff('call_next_queue_team', { p_desk_no: 1 }); await asStaff('start_queue_processing', { p_queue_id: id });
      await db.exec(`insert into public.order_items values ('it_A','ord_A','tkt_basic','ticket',15000,1,15000,'bongplay_bonghwa');
        insert into public.order_payments (id, order_id, consent_id, method, amount) values ('pay_A','ord_A','cst_A','card',15000);
        insert into public.ticket_ledger (ticket_id, consent_id, order_id) values ('T_A1','cst_A','ord_A');`);
      return { p_queue_id: id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1'] };
    }
    case 'get_staff_queue_list': return {};
    case 'set_desk_pause_status': return { p_desk_no: 1, p_is_paused: true };
    default: throw new Error(fn);
  }
}
const snapshot = async (db) => JSON.stringify(await rows(db, `select id, status, version, order_key, desk_no, called_at from public.ticket_queue order by id`))
  + JSON.stringify(await rows(db, `select desk_no, is_paused, current_queue_id from public.ticket_queue_desks order by desk_no`));

test('positive control: staff identity can run every staff RPC from the prepared state', { skip }, async () => {
  for (const fn of STAFF_RPCS) {
    const db = await freshDb();
    const args = await prepareFor(db, fn);
    const r = await callAs(db, 'staff', fn, args);
    assert.equal(r.ok, true, `준비 상태에서 직원 호출이 실패하면 권한 시험이 무의미함: ${fn} ${JSON.stringify(r)}`);
  }
});

for (const who of ['anon', 'nonstaff']) {
  for (const fn of STAFF_RPCS) {
    test(`${who === 'anon' ? 'anon' : 'logged-in non-staff'} cannot run staff RPC ${fn}`, { skip }, async () => {
      const db = await freshDb();
      const args = await prepareFor(db, fn);
      const before = await snapshot(db);
      const r = await callAs(db, who, fn, args);
      const after = await snapshot(db);
      assert.ok(rejected(r), `${who} 가 ${fn} 성공: ${JSON.stringify(r).slice(0, 220)}`);
      assert.equal(after, before, `${who} 호출로 상태가 바뀜`);
      if (fn === 'get_staff_queue_list') assert.ok(!JSON.stringify(r).includes('SENTINEL'), '직원 목록의 보호자 이름 노출');
    });
  }
}

// 접근 코드 모델(계약 §9.1)에서는 anon 실행 권한 자체는 허용된다(앱이 anon 키를 쓰므로). 대신 코드 검증이 유일한 관문이다.
test('staff access code model: anon with the valid code may run; missing or wrong code is rejected', { skip }, async () => {
  const probe = await freshDb();
  if (!(await hasParam(probe, 'call_next_queue_team', 'p_access_code'))) return; // R1 (JWT 역할 모델) 에는 해당 없음
  for (const code of [STAFF_CODE, '', null, 'SENTINEL-WRONG-CODE']) {
    const db = await freshDb();
    await enqueue(db, 'cst_A', 'kA');
    const r = await callAs(db, 'anon', 'call_next_queue_team', { p_access_code: code, p_desk_no: 1 });
    if (code === STAFF_CODE) assert.equal(r.ok, true, `유효 코드 anon 호출 실패: ${JSON.stringify(r)}`);
    else assert.ok(rejected(r), `코드 ${JSON.stringify(code)} 로 직원 호출 성공: ${JSON.stringify(r)}`);
  }
});

test('anon holds no EXECUTE privilege on staff RPCs that lack a staff credential parameter', { skip }, async () => {
  const db = await freshDb({ supabaseDefaults: true });
  const r = await rows(db, `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1) order by 1`,
    [STAFF_RPCS]);
  const withCred = [];
  for (const f of STAFF_RPCS) if (await hasParam(db, f, 'p_access_code')) withCred.push(f);
  const open = r.filter((x) => x.anon_exec && !withCred.includes(x.proname)).map((x) => x.proname);
  assert.deepEqual(open, [], `Supabase 기본 권한에서 anon EXECUTE 가 남은 직원 함수 (함수 안 역할 검사 하나만 방어): ${open.join(', ')}`);
});

// ---- 3. 발권 완료 거부 조건 (계약 §7) ----------------------------------------------------
test('positive control: valid serving team with confirmed ledger completes', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await statusOf(db, a.id)).status, impl('issued'));
});

test('completion rejects another team\'s tickets', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_B1'] });
  assert.ok(rejected(r), `B 팀 티켓 T_B1 을 섞어도 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects another team\'s order', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_B', p_ticket_ids: ['T_B1'] });
  assert.ok(rejected(r), `B 팀 주문으로 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects cancelled tickets', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`update public.ticket_ledger set status = 'cancelled', cancelled_at = now() where order_id = 'ord_A'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.ok(rejected(r), `취소된 티켓으로 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects a partially missing ticket set (ledger row missing)', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`delete from public.ticket_ledger where ticket_id = 'T_A2'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.ok(rejected(r), `원장에 없는 티켓 T_A2 를 포함해도 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects fewer tickets than the order quantity', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`delete from public.ticket_ledger where ticket_id = 'T_A2'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1'] });
  assert.ok(rejected(r), `주문 수량 2매 중 1매만 원장에 있어도 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects unconfirmed payment (no payment row)', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`delete from public.order_payments where order_id = 'ord_A'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.ok(rejected(r), `수납 원장 없이 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects partial payment (paid sum below order total)', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`update public.order_payments set amount = 10000 where order_id = 'ord_A'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.ok(rejected(r), `수납 10,000 < 주문 30,000 인데 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion rejects cancelled payment', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await db.exec(`update public.order_payments set status = 'cancelled', cancelled_at = now() where order_id = 'ord_A'`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  assert.ok(rejected(r), `취소된 결제로 완료됨: ${JSON.stringify(r)}`);
  assert.equal((await statusOf(db, a.id)).status, impl('serving'));
});

test('completion from called (not yet serving) is rejected', { skip }, async () => {
  const db = await freshDb();
  const a = await enqueue(db, 'cst_A', 'kA');
  await callAs(db, 'staff', 'call_next_queue_team', { p_desk_no: 1 });
  await db.exec(`insert into public.order_items values ('it_A','ord_A','tkt_basic','ticket',15000,1,15000,'bongplay_bonghwa');
    insert into public.order_payments (id, order_id, consent_id, method, amount) values ('pay_A','ord_A','cst_A','card',15000);
    insert into public.ticket_ledger (ticket_id, consent_id, order_id) values ('T_A1','cst_A','ord_A');`);
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1'] });
  assert.ok(rejected(r), `계약 §2.1 은 ${impl('serving')}(serving) 에서만 완료 허용. called 에서 완료됨: ${JSON.stringify(r)}`);
});

// ---- 4. 동일 완료 요청 재시도 (계약 §7·§9.2) ---------------------------------------------
test('retrying the same completion returns the same success and changes nothing', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  const args = { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] };
  const first = await callAs(db, 'staff', 'complete_queue_issuance', args);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = await statusOf(db, a.id);
  const again = await callAs(db, 'staff', 'complete_queue_issuance', args);
  const after = await statusOf(db, a.id);
  assert.deepEqual(after, before, '재시도가 행을 다시 바꿈');
  assert.equal(again.ok, true, `응답 유실 후 같은 완료 재시도가 오류로 끝남 (같은 결과여야 함): ${JSON.stringify(again)}`);
  assert.equal(again.status, impl('issued'));
});

test('a different order on an already issued team is rejected', { skip }, async () => {
  const db = await freshDb();
  const { a } = await servingWithLedger(db);
  await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T_A1', 'T_A2'] });
  const r = await callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: 'ord_B', p_ticket_ids: ['T_B1'] });
  assert.ok(rejected(r), JSON.stringify(r));
  assert.equal((await statusOf(db, a.id)).order_id, 'ord_A', '완료된 주문이 바뀜');
});

// ---- 5. Supabase 확장 배치 모사 ---------------------------------------------------------
test('enqueue works when pgcrypto lives in the extensions schema (Supabase layout)', { skip }, async () => {
  const db = await createDb({ supabaseExtensions: true });
  await loadMigration(db);
  await db.exec(`insert into public.safety_consents (id) values ('cst_A')`);
  const r = await callAs(db, 'anon', 'enqueue_consent_team', { p_consent_id: 'cst_A', p_idempotency_key: 'k1' });
  assert.equal(r.ok, true, `search_path=public,pg_temp 에서 gen_random_bytes 를 찾지 못함: ${JSON.stringify(r)}`);
});

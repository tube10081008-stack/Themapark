// CLAUDE-011 — 대기열 동시 연결 시험 (로컬 PostgreSQL 계층, 2026-10-14 후속).
// PGlite 는 단일 연결이라 재현하지 못하는 경합을 독립 연결 여러 개로 재현한다.
// 결정적 재현: 연결 1 이 트랜잭션을 열어 둔 채 RPC 를 실행하고, 그동안 연결 2 가 같은 RPC 를 실행한 뒤 연결 1 을 커밋한다.
//
// 실행 (저장소 루트, 로컬 일회용 PostgreSQL 만 허용):
//   ANT006_SQL=<체크아웃>/01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql \
//   ANT006_PG_URL=postgres://postgres@127.0.0.1:55432/postgres PG_DIR=<설치 경로>/node_modules/pg \
//   node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/pg-concurrency.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgDb, pgSkipReason, stillPending } from './pg-harness.mjs';
import { orderItemSql } from './supabase-emulation.mjs';
import { impl } from './status-map.mjs';

const skip = pgSkipReason();
const enqueueArgs = (consent, key) => ({
  p_consent_id: consent, p_idempotency_key: key, p_party_size: 2, p_guardian_name: 'SENTINEL', p_guardian_phone: '010-0000-0000'
});

async function withDb(fn, consents = ['cst_A', 'cst_B', 'cst_C']) {
  const db = await createPgDb();
  try {
    await db.owner.query(`insert into public.safety_consents (id) select unnest($1::text[])`, [consents]);
    await fn(db);
  } finally {
    await db.drop();
  }
}
const queueRows = async (db) => (await db.owner.query(
  `select id, consent_id, queue_number, order_key, status, desk_no from public.ticket_queue order by queue_number`)).rows;

test('two customers submitting at the same moment both get distinct numbers (no unique-constraint error)', { skip }, async () => {
  await withDb(async (db) => {
    const s1 = await db.session('anon');
    const s2 = await db.session('anon');
    await s1.begin();
    const r1 = await s1.call('enqueue_consent_team', enqueueArgs('cst_A', 'kA'));
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p2 = s2.rpc('enqueue_consent_team', enqueueArgs('cst_B', 'kB'));
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.equal(r2.sqlError, undefined, `동시 접수 중 SQL 오류: ${JSON.stringify(r2)}`);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.notEqual(r2.queue_number, r1.queue_number);
    const qs = await queueRows(db);
    assert.deepEqual(qs.map((q) => q.queue_number), [1, 2]);
  });
});

test('a burst of 20 simultaneous submissions yields numbers 1..20 and distinct order keys', { skip }, async () => {
  const consents = Array.from({ length: 20 }, (_, i) => `cst_${String(i).padStart(2, '0')}`);
  await withDb(async (db) => {
    const sessions = await Promise.all(consents.map(() => db.session('anon')));
    const results = await Promise.all(sessions.map((s, i) => s.rpc('enqueue_consent_team', enqueueArgs(consents[i], `k_${i}`))));
    const failed = results.filter((r) => !r || r.ok !== true);
    assert.equal(failed.length, 0, `실패 ${failed.length}건: ${JSON.stringify(failed.slice(0, 3))}`);
    const qs = await queueRows(db);
    assert.deepEqual(qs.map((q) => q.queue_number), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(qs.map((q) => String(q.order_key))).size, 20, '같은 order_key 가 둘 이상');
  }, consents);
});

test('the same consent submitted twice concurrently with different keys yields one team (duplicate, not an error)', { skip }, async () => {
  await withDb(async (db) => {
    const s1 = await db.session('anon');
    const s2 = await db.session('anon');
    await s1.begin();
    const r1 = await s1.call('enqueue_consent_team', enqueueArgs('cst_A', 'kA1'));
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p2 = s2.rpc('enqueue_consent_team', enqueueArgs('cst_A', 'kA2'));
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.equal(r2.sqlError, undefined, `같은 서약서 동시 접수 중 SQL 오류: ${JSON.stringify(r2)}`);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.duplicate, true);
    assert.equal(r2.id, r1.id);
    assert.equal((await queueRows(db)).length, 1);
  });
});

test('a held team restored while a new customer enqueues gets a distinct order key (no tie)', { skip }, async () => {
  await withDb(async (db) => {
    const anon = await db.session('anon');
    const staff = await db.session('staff');
    const a = await anon.rpc('enqueue_consent_team', enqueueArgs('cst_A', 'kA'));
    await anon.rpc('enqueue_consent_team', enqueueArgs('cst_B', 'kB'));
    const called = await staff.rpc('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(called.id, a.id, JSON.stringify(called));
    const held = await staff.rpc('hold_queue_team', { p_queue_id: a.id });
    assert.equal(held.ok, true, JSON.stringify(held));

    const s1 = await db.session('staff');
    const s2 = await db.session('anon');
    await s1.begin();
    const restored = await s1.call('restore_queue_team', { p_queue_id: a.id });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const p2 = s2.rpc('enqueue_consent_team', enqueueArgs('cst_C', 'kC'));
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const keys = (await queueRows(db)).map((q) => String(q.order_key));
    assert.equal(new Set(keys).size, keys.length, `order_key 동률: ${keys}`);
  });
});

test('two terminals calling the same desk at the same moment put only one team on that desk', { skip }, async () => {
  await withDb(async (db) => {
    const anon = await db.session('anon');
    await anon.rpc('enqueue_consent_team', enqueueArgs('cst_A', 'kA'));
    await anon.rpc('enqueue_consent_team', enqueueArgs('cst_B', 'kB'));
    const s1 = await db.session('staff');
    const s2 = await db.session('staff');
    await s1.begin();
    const r1 = await s1.call('call_next_queue_team', { p_desk_no: 1 });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p2 = s2.rpc('call_next_queue_team', { p_desk_no: 1 });
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.ok(r2.ok === false, `같은 창구에 두 번째 팀 호출: ${JSON.stringify(r2)}`);
    const onDesk1 = (await queueRows(db)).filter((q) => q.desk_no === 1 && ['called', 'processing'].includes(q.status));
    assert.equal(onDesk1.length, 1, JSON.stringify(onDesk1));
  });
});

test('two terminals calling different desks at the same moment call two different teams', { skip }, async () => {
  await withDb(async (db) => {
    const anon = await db.session('anon');
    await anon.rpc('enqueue_consent_team', enqueueArgs('cst_A', 'kA'));
    await anon.rpc('enqueue_consent_team', enqueueArgs('cst_B', 'kB'));
    const s1 = await db.session('staff');
    const s2 = await db.session('staff');
    await s1.begin();
    const r1 = await s1.call('call_next_queue_team', { p_desk_no: 1 });
    const p2 = s2.rpc('call_next_queue_team', { p_desk_no: 2 });
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.notEqual(r1.id, r2.id);
  });
});

test('the same team completed concurrently from two terminals with the same order: one completion, the retry sees the same success', { skip }, async () => {
  await withDb(async (db) => {
    const anon = await db.session('anon');
    const staff = await db.session('staff');
    const a = await anon.rpc('enqueue_consent_team', enqueueArgs('cst_A', 'kA'));
    await staff.rpc('call_next_queue_team', { p_desk_no: 1 });
    const s = await staff.rpc('start_queue_processing', { p_queue_id: a.id });
    assert.equal(s.status, impl('serving'), JSON.stringify(s));
    await db.owner.query(orderItemSql({ item: 'i1', order: 'ord_A', qty: 2, consent: 'cst_A' }));
    await db.owner.query(`insert into public.order_payments (id, order_id, consent_id, method, amount) values ('pay_A','ord_A','cst_A','card',30000)`);
    await db.owner.query(`insert into public.ticket_ledger (ticket_id, consent_id, order_id) values ('T1','cst_A','ord_A'),('T2','cst_A','ord_A')`);

    const args = { p_queue_id: a.id, p_order_id: 'ord_A', p_ticket_ids: ['T1', 'T2'] };
    const s1 = await db.session('staff');
    const s2 = await db.session('staff');
    await s1.begin();
    const r1 = await s1.call('complete_queue_issuance', args);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const p2 = s2.rpc('complete_queue_issuance', args);
    await stillPending(p2);
    await s1.commit();
    const r2 = await p2;
    assert.equal(r2.ok, true, `같은 주문 동시 재시도가 실패: ${JSON.stringify(r2)}`);
    const q = (await db.owner.query(`select status, order_id from public.ticket_queue where id = $1`, [a.id])).rows[0];
    assert.equal(q.status, impl('issued'));
    assert.equal(q.order_id, 'ord_A');
  });
});

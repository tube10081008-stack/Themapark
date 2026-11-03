// CLAUDE-011 — 2026-10-14 후속 수정의 순차 동작 시험 (PGlite 계층).
// 동시 연결 경합은 pg-concurrency.test.mjs (로컬 PostgreSQL 계층)에서 본다.
// 실행: ANT006_SQL=… PGLITE_DIR=… node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/sql-followup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANT006_SQL, createDb, loadMigration, callAs, rows } from './harness.mjs';

const skip = ANT006_SQL ? false : 'ANT006_SQL 미지정 — 대상 구현 없이 건너뜀';
const args = (consent, key) => ({ p_consent_id: consent, p_idempotency_key: key, p_party_size: 1, p_guardian_name: 'SENTINEL', p_guardian_phone: '010-0000-0000' });

test('enqueue before the consent row reaches the server returns a retryable CONSENT_NOT_FOUND, then the same request succeeds', { skip }, async () => {
  const db = await createDb();
  await loadMigration(db);
  const r1 = await callAs(db, 'anon', 'enqueue_consent_team', args('cst_late', 'k_late'));
  assert.equal(r1.sqlError, undefined, `외래키 SQL 오류가 그대로 노출됨: ${JSON.stringify(r1)}`);
  assert.equal(r1.ok, false, JSON.stringify(r1));
  assert.equal(r1.error, 'CONSENT_NOT_FOUND');
  assert.equal(r1.retryable, true);
  assert.equal((await rows(db, `select count(*)::int as n from public.ticket_queue`))[0].n, 0);

  await db.exec(`insert into public.safety_consents (id) values ('cst_late')`);
  const r2 = await callAs(db, 'anon', 'enqueue_consent_team', args('cst_late', 'k_late'));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.queue_number, 1);
});

test('sequential submissions keep numbering 1, 2, 3 and a retry with the same key returns the same team', { skip }, async () => {
  const db = await createDb();
  await loadMigration(db);
  await db.exec(`insert into public.safety_consents (id) values ('c1'),('c2'),('c3')`);
  const nums = [];
  for (const c of ['c1', 'c2', 'c3']) nums.push((await callAs(db, 'anon', 'enqueue_consent_team', args(c, 'k_' + c))).queue_number);
  assert.deepEqual(nums, [1, 2, 3]);
  const again = await callAs(db, 'anon', 'enqueue_consent_team', args('c2', 'k_c2'));
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.queue_number, 2);
});

test('the queue-day lock helper is not callable by anon or logged-in users directly', { skip }, async () => {
  const db = await createDb();
  await loadMigration(db);
  for (const role of ['anon', 'authenticated']) {
    let err = null;
    try {
      await db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        await tx.query(`select private.lock_ticket_queue_day('bongplay_bonghwa', current_date)`);
      });
    } catch (e) { err = e; }
    assert.ok(err, `${role} 가 내부 잠금 함수를 직접 호출함`);
  }
});

test('staff RPC responses carry the team consent_id; public and customer responses do not', { skip }, async () => {
  // 매표 화면은 호출 팀의 consent_id 로 결제 창을 열고, 결제 대상 서약서와 대조한다 (consent-desk.html).
  // 직원 인증을 거친 응답에만 넣고, 공개 전광판·고객 조회에는 넣지 않는다.
  const db = await createDb();
  await loadMigration(db);
  await db.exec(`insert into public.safety_consents (id) values ('cst_S1'),('cst_S2')`);
  const a = await callAs(db, 'anon', 'enqueue_consent_team', args('cst_S1', 'k_S1'));
  await callAs(db, 'anon', 'enqueue_consent_team', args('cst_S2', 'k_S2'));
  const called = await callAs(db, 'staff', 'call_next_queue_team', { p_desk_no: 1 });
  assert.equal(called.consent_id, 'cst_S1', JSON.stringify(called));
  const recalled = await callAs(db, 'staff', 'recall_queue_team', { p_queue_id: a.id, p_desk_no: 1 });
  assert.equal(recalled.consent_id, 'cst_S1', JSON.stringify(recalled));
  assert.equal(recalled.formatted_number, a.formatted_number);
  const started = await callAs(db, 'staff', 'start_queue_processing', { p_queue_id: a.id, p_desk_no: 1 });
  assert.equal(started.consent_id, 'cst_S1', JSON.stringify(started));
  assert.equal(started.formatted_number, a.formatted_number);
  assert.equal(started.desk_no, 1);
  const list = await callAs(db, 'staff', 'get_staff_queue_list', {});
  assert.equal(list.called_teams[0].consent_id, 'cst_S1', JSON.stringify(list));
  assert.equal(list.waiting_teams[0].consent_id, 'cst_S2');
  const pub = await callAs(db, 'anon', 'get_queue_public_display', {});
  assert.ok(!JSON.stringify(pub).includes('cst_S'), `공개 전광판에 서약서 id 노출: ${JSON.stringify(pub)}`);
  const cust = await callAs(db, 'anon', 'get_customer_queue_status', { p_customer_token: a.customer_token });
  assert.equal(cust.consent_id, undefined, `고객 조회에 서약서 id 노출: ${JSON.stringify(cust)}`);
});

// CLAUDE-011 — R3 §11 F1~F4 보완의 추가 경계 시험 (PGlite 계층).
// sql-conformance.test.mjs 를 보완한다. 주문 데이터는 매표 데스크 createOrder(bongplay-id.js)의 실제 쓰기 형태로 넣는다.
// 실행: ANT006_SQL=… PGLITE_DIR=… node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/sql-ledger-fix.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANT006_SQL, createDb, loadMigration, callAs, rows, orderItemSql } from './harness.mjs';
import { impl } from './status-map.mjs';

const skip = ANT006_SQL ? false : 'ANT006_SQL 미지정 — 대상 구현 없이 건너뜀';
const rejected = (r) => !!r && (r.sqlError !== undefined || r.ok === false);

/** A 팀을 processing(=serving)으로 만들고 주문 원장을 넣는다. items/payments/tickets 는 실제 쓰기 형태 */
async function setup({ items, payments = [], tickets = [] }) {
  const db = await createDb();
  await loadMigration(db);
  await db.exec(`insert into public.safety_consents (id) values ('cst_A'), ('cst_B')`);
  const a = await callAs(db, 'anon', 'enqueue_consent_team', { p_consent_id: 'cst_A', p_idempotency_key: 'kA' });
  assert.equal(a.ok, true, JSON.stringify(a));
  await callAs(db, 'staff', 'call_next_queue_team', { p_desk_no: 1 });
  const s = await callAs(db, 'staff', 'start_queue_processing', { p_queue_id: a.id });
  assert.equal(s.status, impl('serving'), JSON.stringify(s));
  if (items.length) await db.exec(items.map(orderItemSql).join('\n'));
  for (const [i, p] of payments.entries()) {
    await db.query(`insert into public.order_payments (id, order_id, consent_id, method, amount, status, cancelled_at) values ($1,$2,$3,'card',$4,$5,$6)`,
      [`pay_${i}`, p.order ?? 'ord_A', p.consent === undefined ? 'cst_A' : p.consent, p.amount, p.status ?? 'paid', p.cancelled ? new Date().toISOString() : null]);
  }
  for (const t of tickets) {
    await db.query(`insert into public.ticket_ledger (ticket_id, consent_id, order_id, status) values ($1,$2,$3,$4)`,
      [t.id, t.consent === undefined ? 'cst_A' : t.consent, t.order ?? 'ord_A', t.status ?? 'active']);
  }
  const complete = (ids, order = 'ord_A') => callAs(db, 'staff', 'complete_queue_issuance', { p_queue_id: a.id, p_order_id: order, p_ticket_ids: ids });
  const status = async () => (await rows(db, `select status from public.ticket_queue where id = $1`, [a.id]))[0].status;
  return { db, a, complete, status };
}
const tk = (...ids) => ids.map((id) => ({ id }));
const item = (o) => ({ item: o.item ?? 'i1', order: 'ord_A', consent: 'cst_A', ...o });

test('free order (infant free ticket, amount 0) completes without a payment row', { skip }, async () => {
  // createOrder 는 금액 0 결제를 기록하지 않는다 (amount > 0 만). 금액 0 주문은 결제 없이 완료돼야 한다.
  const { complete } = await setup({ items: [item({ product: 'tkt_infant_free', list: 0, qty: 1 })], tickets: tk('T1') });
  const r = await complete(['T1']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('cancelled order item is excluded from quantity and amount', { skip }, async () => {
  // 활성 입장권 2매 + 취소된 입장권 1매. 취소분은 수량·금액에서 빠진다.
  const { db, complete } = await setup({
    items: [item({ item: 'i1', qty: 2 }), item({ item: 'i2', qty: 1 })],
    payments: [{ amount: 30000 }], tickets: tk('T1', 'T2')
  });
  await db.exec(`update public.order_items set status = 'cancelled', cancelled_at = now() where item_id = 'i2'`);
  const r = await complete(['T1', 'T2']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('legacy row with total_price but no paid_amount is still amount-checked', { skip }, async () => {
  const { db, complete, status } = await setup({ items: [item({ qty: 2 })], payments: [{ amount: 10000 }], tickets: tk('T1', 'T2') });
  await db.exec(`update public.order_items set paid_amount = 0, total_price = 30000`);
  const r = await complete(['T1', 'T2']);
  assert.ok(rejected(r), `구 형식(total_price) 주문의 부분 수납이 통과: ${JSON.stringify(r)}`);
  assert.equal(await status(), impl('serving'));
});

test('duplicate ticket ids in the request are rejected', { skip }, async () => {
  const { complete } = await setup({ items: [item({ qty: 2 })], payments: [{ amount: 30000 }], tickets: tk('T1', 'T2') });
  const r = await complete(['T1', 'T1']);
  assert.ok(rejected(r), JSON.stringify(r));
});

test('order with more active ledger tickets than ordered is rejected even if the request matches the quantity', { skip }, async () => {
  const { complete } = await setup({ items: [item({ qty: 2 })], payments: [{ amount: 30000 }], tickets: tk('T1', 'T2', 'T3') });
  const r = await complete(['T1', 'T2']);
  assert.ok(rejected(r), `주문 2매에 원장 3매가 걸린 주문으로 완료: ${JSON.stringify(r)}`);
});

test('a payment row from another consent on the same order is rejected', { skip }, async () => {
  const { complete } = await setup({
    items: [item({ qty: 1 })], payments: [{ amount: 10000 }, { amount: 5000, consent: 'cst_B' }], tickets: tk('T1')
  });
  const r = await complete(['T1']);
  assert.ok(rejected(r), JSON.stringify(r));
});

test('a payment row without consent link is rejected', { skip }, async () => {
  const { complete } = await setup({ items: [item({ qty: 1 })], payments: [{ amount: 15000, consent: null }], tickets: tk('T1') });
  const r = await complete(['T1']);
  assert.ok(rejected(r), JSON.stringify(r));
});

test('an order item from another consent mixed into the order is rejected', { skip }, async () => {
  const { complete } = await setup({
    items: [item({ item: 'i1', qty: 1 }), item({ item: 'i2', qty: 1, consent: 'cst_B' })],
    payments: [{ amount: 30000 }], tickets: tk('T1', 'T2')
  });
  const r = await complete(['T1', 'T2']);
  assert.ok(rejected(r), JSON.stringify(r));
});

test('a requested ticket without consent link is rejected', { skip }, async () => {
  const { complete } = await setup({ items: [item({ qty: 1 })], payments: [{ amount: 15000 }], tickets: [{ id: 'T1', consent: null }] });
  const r = await complete(['T1']);
  assert.ok(rejected(r), JSON.stringify(r));
});

test('split payment (cash + card) covering the discounted total completes; overpay is allowed', { skip }, async () => {
  const { complete } = await setup({
    items: [item({ qty: 2, discount: 6000 }), item({ item: 'i2', product: 'fnb_drink', category: 'food', qty: 1, list: 3000 })],
    payments: [{ amount: 20000 }, { amount: 8000 }], tickets: tk('T1', 'T2')
  });
  const r = await complete(['T1', 'T2']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a cancelled payment does not count toward the paid total', { skip }, async () => {
  const { complete } = await setup({
    items: [item({ qty: 2 })], payments: [{ amount: 15000 }, { amount: 15000, status: 'cancelled', cancelled: true }], tickets: tk('T1', 'T2')
  });
  const r = await complete(['T1', 'T2']);
  assert.ok(rejected(r), JSON.stringify(r));
});

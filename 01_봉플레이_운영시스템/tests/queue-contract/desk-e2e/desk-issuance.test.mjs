// CLAUDE-011 — 매표 발권 E2E: 실제 화면(ANT006_ROOT) + 실제 DB 계약(설치 묶음) + 실제 PostgREST.
// 질문: "화면에서 발권하면 주문·결제·티켓·대기열 완료·서약서 발권 상태가 서버에 정확히 한 번 저장되는가"
// 단언은 서버 계약 기준이다. 실패는 계약 위반(미전송·거짓 완료·중복 매출) 검출을 뜻한다.
// 각 시험은 자기 계약만 단언한다 (E0 만 서약서 발권 상태를 본다 — 다른 시험이 같은 원인으로 함께 실패하지 않게).
//
// 실행 (저장소 루트):
//   PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
//   E2E_ENV=<stack.env> ANT006_ROOT=<화면 체크아웃> PG_DIR=<pg 모듈> PW_DIR=<playwright 모듈> \
//     node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk-issuance.test.mjs
//   bash …/desk_e2e_stack.sh stop
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy, openDesk, resetScenario, dbState, db, waitFor, sleep, skipReason, loadEnv, DEVICE_IP } from './harness.mjs';

const skip = skipReason();

/** 호출 → 처리 시작(화면이 consent_id 로 결제 창을 엶) → 기본권·현금 전액 배분까지 */
async function toPayment(ui) {
  assert.ok(await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0 && !!BongplayAuth.getAccessCode()), { timeout: 15000 }),
    '준비: 직원 로그인·서약서 목록 로드');
  const r = await ui.page.evaluate(async () => {
    await handleCallNextQueueTeam();
    if (!currentCalledQueueEntry) return { ok: false, step: 'call' };
    await handleStartQueueProcessing();
    if (!payCtx) return { ok: false, step: 'payment modal (consent_id 로 자동 열림)', entry: currentCalledQueueEntry };
    swapChildTicket('tkt_basic');      // 기상 관측값이 없어 짚코스터 권종은 인터록에 걸린다
    setAlloc('cash', payCtx.pricing.summary.total);
    return { ok: !!(payCtx.built && payCtx.built.valid), total: payCtx.pricing.summary.total };
  });
  assert.ok(r.ok, `준비 실패: ${JSON.stringify(r)}`);
  return r.total;
}
const confirmPay = (ui) => ui.page.evaluate(() => confirmPayment());
const orderIds = (s) => [...new Set(s.items.map((i) => i.order_id))];
const paidSum = (s) => s.pays.filter((p) => p.status === 'paid').reduce((a, p) => a + Number(p.amount), 0);

async function scenario(opts, fn) {
  const c = await db();
  const proxy = await startProxy();
  let ui;
  try {
    const ids = await resetScenario(c, opts);
    ui = await openDesk(proxy, opts);
    await fn({ c, proxy, ui, ...ids });
  } finally {
    if (ui) await ui.close();
    await proxy.close();
    await c.end();
  }
}

/** 이번 발권 1건이 서버에 정확히 한 번 저장되었는가 (주문 1건·결제 합계 = 주문 금액·티켓 = 수량·대기열 완료) */
function assertSingleIssuance(s, total, label) {
  const oids = orderIds(s);
  assert.equal(oids.length, 1, `${label}: 같은 팀에 주문 ${oids.length}건 저장 ${JSON.stringify(oids)}`);
  assert.equal(paidSum(s), total, `${label}: 결제 합계 ${paidSum(s)} ≠ 주문 금액 ${total} (중복 매출 또는 미전송)`);
  const qty = s.items.filter((i) => i.product_category === 'ticket').reduce((a, i) => a + Number(i.quantity), 0);
  assert.equal(s.tickets.filter((t) => t.status === 'active').length, qty, `${label}: 활성 티켓 수 ≠ 입장권 수량`);
  assert.equal(s.queue.status, 'issued', `${label}: 대기열 상태 ${s.queue.status}`);
  assert.equal(s.queue.order_id, oids[0], `${label}: 대기열에 연결된 주문이 저장된 주문과 다름`);
}

test('E0 normal issuance: order, payment, tickets, queue completion AND consent issued status all reach the server', { skip }, async () => {
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    assertSingleIssuance(s, total, 'E0');
    const cons = proxy.calls('rest', 'safety_consents').filter((e) => e.method !== 'GET');
    assert.equal(s.consent.is_issued, true,
      `서약서 발권 상태가 서버에 저장되지 않음 (화면 안내: ${ui.dialogs.map((d) => d.message.split('\n')[0]).join(' / ')}; ` +
      `서버 응답: ${cons.map((e) => e.status + ' ' + (e.response || '')).join(' | ')})`);
  });
});

test('E1 desk gate follows the server safety check: no sale starts when the server has no PASS (device-local PASS only)', { skip }, async () => {
  // 서버 트리거(안전 인터록)는 서버 safety_audits 를 본다. 화면 게이트가 단말 localStorage 만 보면, 화면은 결제를 진행하고
  // 서버는 주문·결제·티켓 쓰기를 모두 거부해 outbox 에만 쌓인다 (미전송).
  await scenario({ passAudit: false, localPassAudit: true }, async ({ c, ui, consentId, queueId, proxy }) => {
    // 화면은 적재 시점에 한 번 게이트를 계산한다(단말 기록 우선). 직원이 그대로 호출·결제하는 흐름을 따른다 (강제 재검사 없음).
    await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0), { timeout: 15000 });
    const gate = await ui.page.evaluate(() => isSafetyInspectionPassed);
    if (!gate) {
      // 화면이 서버 기준으로 막았다면 계약 충족: 판매 쓰기가 없어야 한다
      assert.equal(['order_items', 'order_payments', 'ticket_ledger'].flatMap((t) => proxy.calls('rest', t).filter((e) => e.method === 'POST')).length, 0);
      return;
    }
    await toPayment(ui);
    await confirmPay(ui);
    await sleep(300);
    const writes = ['order_items', 'order_payments', 'ticket_ledger'].flatMap((t) => proxy.calls('rest', t).filter((e) => e.method === 'POST'));
    const blocked = writes.filter((e) => /SAFETY_INTERLOCK_BLOCKED/.test(e.response || ''));
    const s = await dbState(c, consentId, queueId);
    console.log(`# E1 관찰: 화면 게이트=${gate}, 쓰기 시도 ${writes.length}건 중 인터록 거부 ${blocked.length}건, 서버 주문 ${s.items.length}건, 대기열 ${s.queue.status}, 안내: ${ui.dialogs.map((d) => d.message.split('\n')[0]).join(' / ')}`);
    assert.equal(writes.length, 0, `서버에 PASS 가 없는데 화면 게이트가 통과(단말 기록 기준)해 서버가 거부할 판매를 시작함 (주문·결제·티켓 쓰기 ${writes.length}건, 인터록 거부 ${blocked.length}건)`);
  });
});

test('E2 partial save (ticket_ledger 503 once) then retry in the same window: one order, one payment, queue issued', { skip }, async () => {
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'POST' });
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'PATCH' });
    await confirmPay(ui);
    assert.equal(proxy.calls('rpc', 'complete_queue_issuance').length, 0, '원장 미확정인데 완료 요청');
    await confirmPay(ui);          // 직원이 같은 결제 창에서 다시 누름
    await sleep(300);
    assertSingleIssuance(await dbState(c, consentId, queueId), total, 'E2');
  });
});

test('E3 completion response lost (server committed) then retry: same order reused, no second sale, queue issued', { skip }, async () => {
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rpc', 'complete_queue_issuance', 'lost', { times: 1 });
    await confirmPay(ui);
    await confirmPay(ui);
    await sleep(300);
    const done = proxy.calls('rpc', 'complete_queue_issuance');
    assert.ok(done.length >= 2 && done[1].body.p_order_id === done[0].body.p_order_id, '재시도가 같은 주문 id 를 쓰지 않음');
    assertSingleIssuance(await dbState(c, consentId, queueId), total, 'E3');
  });
});

test('E4 order_items POST response lost (server stored): the client confirms via fallback and does not duplicate rows', { skip }, async () => {
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rest', 'order_items', 'lost', { times: 1, method: 'POST' });
    await confirmPay(ui);
    if (proxy.calls('rpc', 'complete_queue_issuance').length === 0) await confirmPay(ui);
    await sleep(300);
    assertSingleIssuance(await dbState(c, consentId, queueId), total, 'E4');
  });
});

test('E5 staff closes and reopens the payment window after a partial failure: still one order and one payment', { skip }, async () => {
  // 결제 창을 닫으면 payCtx(activeOrder)가 사라진다. 다시 열고 결제하면 새 주문 id 로 주문·결제가 한 번 더 저장되는지 본다.
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'POST' });
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'PATCH' });
    await confirmPay(ui);
    await ui.page.evaluate((cid) => {
      closePaymentModal();
      openPaymentModal(cid);
      swapChildTicket('tkt_basic');
      setAlloc('cash', payCtx.pricing.summary.total);
    }, consentId);
    await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    console.log(`# E5 관찰: 주문 ${JSON.stringify(orderIds(s))}, 결제 합계 ${paidSum(s)} (주문 금액 ${total}), 대기열 ${s.queue.status}→${s.queue.order_id}`);
    assertSingleIssuance(s, total, 'E5');
  });
});

test('E6 a correct staff code still completes after another device behind the same IP sent wrong codes (no shared lockout)', { skip }, async () => {
  // private.verify_access_code 는 x-forwarded-for(IP) 별 10분 20회 실패면 그 IP 의 모든 검증을 거부한다.
  // 현장 단말은 같은 공유기(같은 공인 IP) 뒤에 있으므로, 옛 암호가 남은 단말 하나가 폴링하면 정상 단말의 발권 완료까지 막힌다.
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    const env = loadEnv();
    for (let i = 0; i < 20; i++) {
      await fetch(proxy.base + '/rest/v1/rpc/get_staff_queue_list', {
        method: 'POST', headers: { apikey: env.E2E_ANON_KEY, Authorization: 'Bearer ' + env.E2E_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_access_code: 'SYN-STALE-CODE', p_site_id: 'bongplay_bonghwa' })
      });
    }
    await confirmPay(ui);
    await sleep(300);
    const done = proxy.calls('rpc', 'complete_queue_issuance');
    console.log(`# E6 관찰: 같은 IP(${DEVICE_IP}) 실패 20회 뒤 완료 응답 ${done.map((e) => e.response).join(' | ')}`);
    assertSingleIssuance(await dbState(c, consentId, queueId), total, 'E6');
  });
});

test('E7 desk write payloads match the DB contract: ledger tables exactly, consents without schema-blocked critical columns', { skip }, async () => {
  // bongplay-sync.js 는 없는 열을 만나면 그 열을 지우고 다시 보낸다(열마다 요청 1회). status·cancelled_at·cancel_reason·closing_status 는
  // "중요 열"로 보고 지우지 않고 outbox 에 보류(schema_blocked)한다 → 그 저장은 영영 서버에 닿지 않는다.
  await scenario({}, async ({ c, ui, proxy }) => {
    await toPayment(ui);
    await confirmPay(ui);
    await sleep(300);
    const cols = {};
    for (const r of (await c.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'
        and table_name in ('order_items','order_payments','ticket_ledger','safety_consents')`)).rows) {
      (cols[r.table_name] ||= new Set()).add(r.column_name);
    }
    const report = {};
    for (const t of Object.keys(cols)) {
      const writes = proxy.calls('rest', t).filter((e) => e.method === 'POST' || e.method === 'PATCH');
      const keys = new Set(writes.flatMap((e) => (Array.isArray(e.body) ? e.body : [e.body]).flatMap((b) => Object.keys(b || {}))));
      report[t] = { requests: writes.length, unknown: [...keys].filter((k) => !cols[t].has(k)).sort() };
    }
    console.log(`# E7 관찰: ${JSON.stringify(report)}`);
    const CRITICAL = ['status', 'cancelled_at', 'cancel_reason', 'closing_status'];
    // 원장 3표는 모르는 열이 하나도 없어야 한다. 서약서는 중요 열만 단언하고, 나머지(지우고 다시 보내는 열)는 관찰로 남긴다.
    const ledgerUnknown = ['order_items', 'order_payments', 'ticket_ledger'].flatMap((t) => report[t].unknown.map((k) => `${t}.${k}`));
    const blocked = Object.entries(report).flatMap(([t, r]) => r.unknown.filter((k) => CRITICAL.includes(k)).map((k) => `${t}.${k}`));
    assert.deepEqual(ledgerUnknown, [], `원장 쓰기에 DB 에 없는 열: ${ledgerUnknown.join(', ')}`);
    assert.deepEqual(blocked, [], `DB 에 없는 중요 열을 보내 저장이 outbox 에 영구 보류됨: ${blocked.join(', ')}`);
  });
});

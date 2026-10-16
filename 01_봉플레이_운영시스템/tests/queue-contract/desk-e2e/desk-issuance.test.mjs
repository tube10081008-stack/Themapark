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
import { startProxy, openDesk, resetScenario, dbState, db, waitFor, sleep, skipReason, loadEnv, DEVICE_IP, hasCancelColumns, stopApiServer, startApiServer } from './harness.mjs';

const skip = skipReason();

/**
 * 페이지 안의 비동기 동작을 시작만 하고(한 번만 실행), 결과는 짧은 조회로 기다린다.
 * 긴 비동기 동작을 page.evaluate 안에서 await 하면 playwright 가 가끔 "Execution context was destroyed" 를 낸다
 * (페이지 이동·재적재는 없고 화면 상태도 유지됨 — 시험 도구 쪽 현상). 동작 자체는 다시 실행하지 않는다.
 */
let jobSeq = 0;
async function pageAsync(ui, fn, arg = null, { timeout = 30000 } = {}) {
  const id = 'job' + (++jobSeq);
  await ui.page.evaluate(({ id, src, arg }) => {
    window.__jobs = window.__jobs || {};
    window.__jobs[id] = { state: 'running' };
    const f = (0, eval)('(' + src + ')');
    Promise.resolve().then(() => f(arg)).then(
      (v) => { window.__jobs[id] = { state: 'done', value: v === undefined ? null : v }; },
      (e) => { window.__jobs[id] = { state: 'error', value: String(e && e.message || e) }; });
  }, { id, src: fn.toString(), arg });
  let job = null;
  const ok = await waitFor(async () => {
    try { job = await ui.page.evaluate((id) => window.__jobs && window.__jobs[id], id); } catch (e) { return false; }
    return job && job.state !== 'running';
  }, { timeout });
  assert.ok(ok, `페이지 동작이 ${timeout}ms 안에 끝나지 않음 (${job && job.state})`);
  if (job.state === 'error') throw new Error('페이지 동작 오류: ' + job.value);
  return job.value;
}

/** 호출 → 처리 시작(화면이 consent_id 로 결제 창을 엶) → 기본권·현금 전액 배분까지 */
async function toPayment(ui) {
  assert.ok(await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0 && !!BongplayAuth.getAccessCode()), { timeout: 15000 }),
    '준비: 직원 로그인·서약서 목록 로드');
  const r = await pageAsync(ui, async () => {
    await handleCallNextQueueTeam();
    if (!currentCalledQueueEntry) return { ok: false, step: 'call' };
    await handleStartQueueProcessing();
    if (!payCtx) return { ok: false, step: 'payment modal (consent_id 로 자동 열림)', entry: currentCalledQueueEntry };
    return { ok: true };
  });
  assert.ok(r.ok, `준비 실패: ${JSON.stringify(r)}`);
  return (await allocCash(ui)).total;
}

/**
 * 결제 창에서 기본권(기상 관측값이 없으면 짚코스터 권종은 인터록에 걸린다)·현금 전액 배분.
 * consentId 를 주면 직원이 서약서 목록의 [발권] 버튼을 누르는 것과 같이 toggleTicketIssue(id, true) 로 결제 창을 연다.
 * 화면이 진입을 막으면(대기·보류 고객 등) { opened: false } 를 돌려준다.
 * 주의: 배분(setAlloc)을 앞 단계와 같은 page.evaluate 안에서 부르면 playwright 가 "Execution context was destroyed" 를 내는 일이 있어
 *      (화면은 정상 유지 — 시험 도구 쪽 현상) 단계별로 나눠 호출한다.
 */
async function allocCash(ui, consentId) {
  if (consentId) {
    await pageAsync(ui, async (cid) => { if (payCtx) closePaymentModal(); await toggleTicketIssue(cid, true); }, consentId);
    if (!(await ui.page.evaluate(() => !!payCtx))) return { opened: false };
  }
  await ui.page.evaluate(() => swapChildTicket('tkt_basic'));
  await ui.page.evaluate(() => setAlloc('cash', payCtx.pricing.summary.total));
  const r = await ui.page.evaluate(() => ({ ok: !!(payCtx && payCtx.built && payCtx.built.valid), total: payCtx && payCtx.pricing.summary.total }));
  assert.ok(r.ok, `결제 배분 준비 실패: ${JSON.stringify(r)}`);
  return { opened: true, total: r.total };
}

/** 화면의 직원 대기 목록 캐시가 채워질 때까지 (현장 직원이 화면을 연 뒤 몇 초 지나 조작하는 상황) */
async function staffListReady(ui) {
  const ok = await waitFor(() => ui.page.evaluate(() => typeof lastKnownStaffQueueData !== 'undefined' && !!lastKnownStaffQueueData), { timeout: 10000 });
  if (!ok) await pageAsync(ui, async () => { if (typeof refreshDeskQueueView === 'function') await refreshDeskQueueView(); });
}

const confirmPay = (ui) => pageAsync(ui, () => confirmPayment());
const orderIds = (s) => [...new Set(s.items.map((i) => i.order_id))];
const paidSum = (s) => s.pays.filter((p) => p.status === 'paid').reduce((a, p) => a + Number(p.amount), 0);

async function scenario(opts, fn) {
  const c = await db();
  const proxy = await startProxy();
  let ui;
  try {
    if (opts.needsCancelColumns && !(await hasCancelColumns(c))) { opts.skipped = true; return; }
    const ids = await resetScenario(c, opts);
    ui = await openDesk(proxy, opts);
    try {
      await fn({ c, proxy, ui, ...ids });
    } catch (e) {
      if (ui.navs.length > 1) e.message += ` [페이지 이동 기록: ${ui.navs.map((n) => n.url).join(' → ')}]`;
      throw e;
    }
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
    if ('status' in s.consent) {
      // R2 결정: 서약서 status 는 active/cancelled 만, 발권 여부는 is_issued 로 분리
      assert.equal(s.consent.status, 'active', `발권 뒤 서약서 status 가 ${s.consent.status} (R2: active/cancelled 만, 발권은 is_issued)`);
    }
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
    await ui.page.evaluate(() => closePaymentModal());
    const re = await allocCash(ui, consentId);            // 직원이 목록에서 같은 팀의 [발권] 을 다시 누름
    assert.ok(re.opened, '처리 중인 같은 팀의 결제 창을 다시 열 수 있어야 함 (준비 조건)');
    await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    console.log(`# E5 관찰: 주문 ${JSON.stringify(orderIds(s))}, 결제 합계 ${paidSum(s)} (주문 금액 ${total}), 대기열 ${s.queue.status}→${s.queue.order_id}`);
    assertSingleIssuance(s, total, 'E5');
  });
});

test('E6 a correct staff code still completes after another device behind the same IP sent wrong codes (no shared lockout)', { skip, todo: '알려진 제한: IP 단위 잠금 공유 (C3 미적용, 벤 R1 결정)' }, async () => {
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

const saleWrites = (proxy, consentId) => ['order_items', 'order_payments', 'ticket_ledger']
  .flatMap((t) => proxy.calls('rest', t).filter((e) => (e.method === 'POST' || e.method === 'PATCH') && e.body && [].concat(e.body).some((b) => b && b.consent_id === consentId)));

test('E8 page reload after a partial failure, then pay again for the same team: still one order and one payment', { skip }, async () => {
  // 새로고침하면 화면 메모리(payCtx.activeOrder)가 사라진다. 진행 중 주문을 보존·재사용하지 않으면 주문·결제가 한 번 더 저장된다.
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'POST' });
    proxy.fault('rest', 'ticket_ledger', '503', { times: 1, method: 'PATCH' });
    await confirmPay(ui);
    await ui.page.reload({ waitUntil: 'load' });
    assert.ok(await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0 && !!BongplayAuth.getAccessCode()), { timeout: 15000 }), '새로고침 후 준비');
    await staffListReady(ui);
    const re = await allocCash(ui, consentId);
    assert.ok(re.opened, '새로고침 뒤 처리 중인 같은 팀의 결제 창을 다시 열 수 있어야 함 (준비 조건)');
    await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    console.log(`# E8 관찰: 주문 ${JSON.stringify(orderIds(s))}, 결제 합계 ${paidSum(s)} (주문 금액 ${total}), 대기열 ${s.queue.status}→${s.queue.order_id}`);
    assertSingleIssuance(s, total, 'E8');
  });
});

test('E9 paying for a different consent than the team called at this desk is refused before any sale is written', { skip }, async () => {
  await scenario({ consents: 2 }, async ({ c, ui, teams, proxy }) => {
    await toPayment(ui);                                   // 첫 팀(A) 호출·처리 시작
    const [a, b] = teams;
    const called = await ui.page.evaluate(() => currentCalledQueueEntry && currentCalledQueueEntry.consent_id);
    assert.equal(called, a.consentId, '준비: A 가 호출되어야 함');
    await staffListReady(ui);
    const opened = (await allocCash(ui, b.consentId)).opened;   // 직원이 목록에서 B 를 잘못 선택
    if (opened) await confirmPay(ui);
    await sleep(300);
    const sb = await dbState(c, b.consentId, b.queueId);
    const sa = await dbState(c, a.consentId, a.queueId);
    assert.equal(saleWrites(proxy, b.consentId).length, 0, `호출되지 않은 B 의 판매가 쓰임 (${saleWrites(proxy, b.consentId).length}건)`);
    assert.equal(sb.items.length + sb.pays.length + sb.tickets.length, 0, 'B 의 원장이 서버에 저장됨');
    assert.notEqual(sa.queue.status, 'issued', 'A 가 B 의 결제로 발권 완료됨');
    assert.ok(ui.dialogs.some((d) => /일치하지 않|대기열|다른 창구|FIFO/.test(d.message)), `거부 안내 없음: ${ui.dialogs.map((d) => d.message.split('\n')[0]).join(' / ')}`);
    console.log(`# E9 관찰: 결제 창 ${opened ? '열림 → 결제 단계에서 거부' : '진입 단계에서 거부'}`);
  });
});

test('E9b paying directly for a waiting team that was never called does not leave money recorded with the queue unfinished', { skip }, async () => {
  // 창구에 호출 팀이 없을 때 목록에서 대기 팀을 바로 발권하는 경우. 서버는 processing 이 아닌 팀의 완료를 거부한다(INVALID_STATUS).
  // 계약: 판매를 쓰기 전에 막거나(호출·처리 시작 유도), 대기열 완료까지 끝내야 한다. 결제만 남고 대기열이 남으면 안 된다.
  await scenario({ consents: 1 }, async ({ c, ui, consentId, queueId, proxy }) => {
    assert.ok(await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0 && !!BongplayAuth.getAccessCode()), { timeout: 15000 }));
    await staffListReady(ui);
    const opened = (await allocCash(ui, consentId)).opened;
    if (opened) await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    const done = proxy.calls('rpc', 'complete_queue_issuance').map((e) => e.response);
    console.log(`# E9b 관찰: 결제 창 ${opened ? '열림' : '진입 차단'}, 결제 ${paidSum(s)}, 대기열 ${s.queue.status}, 완료 응답 ${done.join(' | ')}, 안내: ${ui.dialogs.map((d) => d.message.split('\n')[0]).join(' / ')}`);
    const moneyWithoutQueue = paidSum(s) > 0 && s.queue.status !== 'issued';
    assert.ok(!moneyWithoutQueue, `결제 ${paidSum(s)}원이 저장됐는데 대기열은 ${s.queue.status}`);
  });
});

test('E10 issuing a previously cancelled consent clears its cancel fields on the server (status active, cancelled_at/cancel_reason null)', { skip }, async (t) => {
  // 취소 3열이 있는 DB 에서만 의미가 있다 (없으면 node:test 건너뜀으로 기록).
  const opts = { cancelledFirst: true, needsCancelColumns: true };
  await scenario(opts, async ({ c, ui, consentId, queueId }) => {
    const total = await toPayment(ui);
    await confirmPay(ui);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    assertSingleIssuance(s, total, 'E10');
    const k = s.consent;
    console.log(`# E10 관찰: is_issued=${k.is_issued}, status=${k.status}, cancelled_at=${k.cancelled_at}, cancel_reason=${k.cancel_reason}`);
    assert.equal(k.is_issued, true, '서약서 발권 상태 미저장');
    assert.equal(k.status, 'active', `발권 뒤 서약서 status 가 ${k.status} (R2: 발권 성공이면 active, 발권 여부는 is_issued)`);
    assert.equal(k.cancelled_at, null, `발권했는데 cancelled_at 이 남음 (${k.cancelled_at})`);
    assert.equal(k.cancel_reason, null, `발권했는데 cancel_reason 이 남음 (${k.cancel_reason})`);
  });
  if (opts.skipped) t.skip('이 DB 에는 서약서 취소 3열이 없다 (C1 미적용 판)');
});

test('E11 after the staff code changes on the server, the desk stops repeating stale-code calls, asks for re-authentication, and resumes after re-auth', { skip }, async () => {
  // 암호를 바꾸면(또는 세션 암호가 무효가 되면) 매표 화면은 3초 폴링 등으로 옛 암호를 계속 보낸다.
  // 실패는 private.auth_attempts 에 IP 별로 쌓이고 10분 20회면 같은 IP 의 모든 단말이 잠긴다 (E6).
  // 계약 (세 단계 모두):
  //   (1) 자동 요청 중단 — 암호 교체 후 30초 동안 서버 인증 실패 3건 이하
  //   (2) 재인증 안내 — 재인증 창 또는 인증·암호·로그인 안내
  //   (3) 재인증 성공 후 조회 재개 — 새 암호로 직원 대기 목록 조회가 다시 성공
  const env = loadEnv();
  const newCode = 'SYN-ROTATED-' + Date.now().toString(36);
  const c0 = await db();
  try {
    await scenario({}, async ({ c, ui, proxy }) => {
      assert.ok(await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0 && !!BongplayAuth.getAccessCode()), { timeout: 15000 }), '준비: 로그인');
      await c.query(`update private.app_settings set value = extensions.crypt($1, extensions.gen_salt('bf')), updated_at = now() where key = 'access_code'`, [newCode]);
      await c.query(`delete from private.auth_attempts`);
      const t0 = Date.now();
      await sleep(30000);
      const fails = (await c.query(`select count(*)::int n from private.auth_attempts where not ok`)).rows[0].n;
      const stale = proxy.state.log.filter((e) => e.t >= t0 && e.kind === 'rpc' && e.body && e.body.p_access_code === env.E2E_STAFF_CODE);
      const st = await ui.page.evaluate(() => ({
        overlay: !!document.getElementById('bongplay-auth-overlay'),
        code: !!(window.BongplayAuth && BongplayAuth.getAccessCode())
      }));
      const reauthDialog = ui.dialogs.some((d) => d.t >= t0 && /인증|암호|로그인/.test(d.message));
      const byName = stale.reduce((m, e) => ((m[e.name] = (m[e.name] || 0) + 1), m), {});
      // (3) 재인증: 화면이 인증 창을 띄웠으면 새 암호를 넣는다
      let resumed = null;
      if (st.overlay) {
        await ui.page.fill('#bongplay-auth-input', newCode);
        await ui.page.click('#bongplay-auth-submit');
        const t1 = Date.now();
        resumed = await waitFor(() => proxy.state.log.some((e) => e.t >= t1 && e.kind === 'rpc' && e.name === 'get_staff_queue_list'
          && e.body && e.body.p_access_code === newCode && /"ok"\s*:\s*true/.test(e.response || '')), { timeout: 15000 });
      }
      console.log(`# E11 관찰: 30초 동안 옛 암호 직원 호출 ${stale.length}회 ${JSON.stringify(byName)}, 서버 인증 실패 ${fails}건 (IP 잠금 기준 20), ` +
        `재인증 창 ${st.overlay}, 세션 암호 유지 ${st.code}, 재인증 안내 대화상자 ${reauthDialog}, 재인증 후 조회 재개 ${resumed === null ? '확인 불가(재인증 창 없음)' : resumed}`);
      assert.ok(fails <= 3, `(1) 인증 실패 뒤에도 옛 암호로 계속 요청 (30초 동안 실패 ${fails}건 — 10분 20건이면 같은 IP 단말 전체 잠김)`);
      assert.ok(st.overlay || reauthDialog, '(2) 인증 실패 뒤 재인증 안내가 없음');
      assert.ok(resumed === true, `(3) 재인증 성공 후 직원 대기 목록 조회가 재개되지 않음 (${resumed === null ? '재인증 창이 없어 재인증 불가' : '15초 안에 성공 조회 없음'})`);
    });
  } finally {
    // 다음 시험을 위해 시험 암호를 되돌린다
    await c0.query(`update private.app_settings set value = extensions.crypt($1, extensions.gen_salt('bf')), updated_at = now() where key = 'access_code'`, [env.E2E_STAFF_CODE]);
    await c0.query(`delete from private.auth_attempts`);
    await c0.end();
  }
});

const setStaffCode = (c, code) => c.query(`update private.app_settings set value = extensions.crypt($1, extensions.gen_salt('bf')), updated_at = now() where key = 'access_code'`, [code]);

/** 같은 팀 결제를 직원이 다시 확정: 결제 창이 열려 있으면 그대로 누르고, 닫혔으면 목록에서 같은 팀의 [발권] 으로 다시 연다 */
async function retryPayment(ui, consentId) {
  const open = await ui.page.evaluate(() => !!payCtx);
  if (!open) {
    await staffListReady(ui);
    const re = await allocCash(ui, consentId);
    assert.ok(re.opened, '복구: 처리 중인 같은 팀의 결제 창을 다시 열 수 있어야 함');
  }
  await confirmPay(ui);
  return open ? '같은 결제 창' : '결제 창 다시 열기';
}

test('E12 ledger saved, then completion is refused because the staff code changed on the server: after re-authentication the SAME order completes (no second sale)', { skip }, async () => {
  // 원장(주문·결제·티켓)이 서버에 저장된 직후, 완료 RPC 직전에 서버 암호가 바뀐다 → 완료는 UNAUTHORIZED_STAFF.
  // 계약: 재인증 안내 → 새 암호로 재인증 → 직원이 같은 팀을 다시 확정하면 같은 order_id 로 완료, 주문·결제는 1건.
  const env = loadEnv();
  const newCode = 'SYN-ROTATED-E12-' + Date.now().toString(36);
  const c0 = await db();
  try {
    await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
      const total = await toPayment(ui);
      proxy.fault('rpc', 'complete_queue_issuance', 'hook', { times: 1, fn: () => setStaffCode(c, newCode) });
      await confirmPay(ui);
      await sleep(300);
      const first = proxy.calls('rpc', 'complete_queue_issuance');
      assert.equal(first.length, 1, '준비: 완료 요청 1회');
      assert.match(first[0].response || '', /UNAUTHORIZED_STAFF/, `준비: 완료가 인증 실패여야 함 (${first[0].response})`);
      const mid = await dbState(c, consentId, queueId);
      assert.equal(orderIds(mid).length, 1, '준비: 원장 저장');
      assert.equal(mid.queue.status, 'processing', '인증 실패인데 대기열 상태가 바뀜');
      const firstOrder = orderIds(mid)[0];

      assert.ok(await waitFor(() => ui.page.evaluate(() => !!document.getElementById('bongplay-auth-input')), { timeout: 10000 }), '재인증 창이 뜨지 않음');
      await ui.page.fill('#bongplay-auth-input', newCode);
      await ui.page.click('#bongplay-auth-submit');
      const t1 = Date.now();
      assert.ok(await waitFor(() => ui.page.evaluate(() => !document.getElementById('bongplay-auth-overlay') && !!BongplayAuth.getAccessCode()), { timeout: 10000 }), '재인증이 끝나지 않음');
      assert.ok(await waitFor(() => proxy.state.log.some((e) => e.t >= t1 && e.name === 'get_staff_queue_list' && e.body && e.body.p_access_code === newCode && /"ok"\s*:\s*true/.test(e.response || '')), { timeout: 15000 }),
        '재인증 뒤 직원 목록 조회가 재개되지 않음');

      const path = await retryPayment(ui, consentId);
      await sleep(300);
      const s = await dbState(c, consentId, queueId);
      const dones = proxy.calls('rpc', 'complete_queue_issuance');
      console.log(`# E12 관찰: 1차 완료 ${first[0].response}, 재인증 후 ${path} → 완료 요청 ${dones.length}회 ` +
        `(주문 id ${[...new Set(dones.map((e) => e.body.p_order_id))].join(',')}), 서버 주문 ${JSON.stringify(orderIds(s))}, 결제 ${paidSum(s)}/${total}, 대기열 ${s.queue.status}`);
      assertSingleIssuance(s, total, 'E12');
      assert.equal(s.queue.order_id, firstOrder, '재인증 뒤 처음 저장한 주문이 아닌 주문으로 완료');
      assert.ok(dones.slice(1).every((e) => e.body.p_order_id === firstOrder && e.body.p_access_code === newCode), '재시도가 같은 주문·새 암호를 쓰지 않음');
    });
  } finally {
    await setStaffCode(c0, env.E2E_STAFF_CODE);
    await c0.query(`delete from private.auth_attempts`);
    await c0.end();
  }
});

test('E13a the device loses its network while saving the payment, comes back online and the staff retries: one order, one payment, queue issued', { skip }, async () => {
  // 브라우저 자체를 오프라인으로 전환한다 (Chromium 네트워크 차단 — fetch 가 실제 네트워크 오류). 결제 저장 요청에서 끊고,
  // 그 뒤의 원장 요청은 브라우저 밖으로 나가지 못한다. (끊은 요청은 브라우저가 곧바로 재전송할 수 있다 — 관찰로 기록)
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    proxy.fault('rest', 'order_payments', 'hook', { times: 1, method: 'POST', fn: async () => { await ui.context.setOffline(true); return 'drop'; } });
    await confirmPay(ui);
    await sleep(500);
    const mid = await dbState(c, consentId, queueId);
    assert.equal(proxy.calls('rpc', 'complete_queue_issuance').length, 0, '원장이 끊겼는데 완료 요청');
    await ui.context.setOffline(false);
    const tOn = Date.now();
    await sleep(1500);                       // 온라인 복귀 뒤 화면의 재전송(outbox)이 돌 시간
    const path = await retryPayment(ui, consentId);
    await sleep(300);
    const s = await dbState(c, consentId, queueId);
    const tl = ['order_payments', 'ticket_ledger'].flatMap((t) => proxy.calls('rest', t).filter((e) => e.method !== 'GET')
      .map((e) => `${t === 'order_payments' ? 'pay' : 'tkt'}:${e.method}:${e.fault || e.status}${e.t > tOn ? '(복귀 후)' : ''}`));
    console.log(`# E13a 관찰: 요청 ${tl.join(' ')} / 끊긴 시점 서버 주문 ${orderIds(mid).length}·결제 ${paidSum(mid)}·티켓 ${mid.tickets.length}, 복구 ${path} → 주문 ${JSON.stringify(orderIds(s))}, 결제 ${paidSum(s)}/${total}, 티켓 ${s.tickets.length}, 대기열 ${s.queue.status}`);
    assertSingleIssuance(s, total, 'E13a');
  });
});

test('E13b the API server goes down in the middle of a sale and comes back: the staff retries and there is still one order and one payment', { skip }, async () => {
  // 실제 PostgREST 프로세스를 결제 저장 직전에 정지한다 (연결 거부). 복구는 같은 설정으로 재기동.
  await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
    const total = await toPayment(ui);
    let down = false;
    proxy.fault('rest', 'order_payments', 'hook', { times: 1, method: 'POST', fn: async () => { await stopApiServer(); down = true; } });
    try {
      await confirmPay(ui);
      await sleep(500);
      assert.ok(down, '준비: 결제 저장 직전에 API 서버 정지');
      const mid = await dbState(c, consentId, queueId);
      assert.equal(proxy.calls('rpc', 'complete_queue_issuance').filter((e) => e.status === 200).length, 0, '서버가 내려가 있는데 완료됨');
      await startApiServer();
      down = false;
      await sleep(1500);
      const path = await retryPayment(ui, consentId);
      await sleep(300);
      const s = await dbState(c, consentId, queueId);
      console.log(`# E13b 관찰: 정지 시점 서버 주문 ${orderIds(mid).length}·결제 ${paidSum(mid)}·티켓 ${mid.tickets.length}, 재기동 후 ${path} → 주문 ${JSON.stringify(orderIds(s))}, 결제 ${paidSum(s)}/${total}, 대기열 ${s.queue.status}`);
      assertSingleIssuance(s, total, 'E13b');
    } finally {
      if (down) await startApiServer();
    }
  });
});

for (const [label, kind, name, method] of [['E13c', 'rpc', 'complete_queue_issuance', undefined], ['E13d', 'rest', 'order_items', 'POST']]) {
  test(`${label} the connection drops after the server committed ${name} (TCP reset, no response): recovery leaves no duplicate`, { skip }, async () => {
    // 서버는 처리·커밋했지만 응답 전에 연결이 끊긴다. 브라우저가 스스로 재전송할 수도 있다 (그 경우도 중복이 없어야 함).
    await scenario({}, async ({ c, ui, consentId, queueId, proxy }) => {
      const total = await toPayment(ui);
      proxy.fault(kind, name, 'reset', { times: 1, method });
      await confirmPay(ui);
      await sleep(800);
      let s = await dbState(c, consentId, queueId);
      let path = '재시도 불필요';
      if (s.queue.status !== 'issued' || !s.consent.is_issued) { path = await retryPayment(ui, consentId); await sleep(300); s = await dbState(c, consentId, queueId); }
      const hits = proxy.calls(kind, name).filter((e) => !method || e.method === method);
      console.log(`# ${label} 관찰: ${name} 요청 ${hits.length}회 (끊김 ${hits.filter((e) => e.fault === 'reset').length}), 복구 ${path} → 주문 ${JSON.stringify(orderIds(s))}, 품목 ${s.items.length}행, 결제 ${paidSum(s)}/${total}, 대기열 ${s.queue.status}`);
      assertSingleIssuance(s, total, label);
    });
  });
}

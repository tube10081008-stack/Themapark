// CLAUDE-011 — 저장 확정·동일 요청 재시도 계약 시험 (프런트·백엔드 결합, 브라우저 계층).
// 계약 원문: docs/qa/20261014_클로이_queue-followup.md §5. 단언은 계약 기준이며 실패는 계약 누락 검출을 뜻한다.
// 대상 화면은 수정하지 않는다. 장애는 모의 PostgREST(harness.mjs)에서만 주입한다.
//
// 실행 (저장소 루트):
//   ANT006_ROOT=<대상 체크아웃> PW_DIR=<playwright 모듈 경로> \
//   node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs
//   (PLAYWRIGHT_BROWSERS_PATH 가 설치된 Chromium 을 가리켜야 한다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, openPage, waitFor, sleep, skipReason } from './harness.mjs';

const skip = skipReason();
const ARG_KEYS = ['p_consent_id', 'p_idempotency_key', 'p_guardian_name', 'p_guardian_phone', 'p_party_size', 'p_site_id'];
const pick = (o) => Object.fromEntries(ARG_KEYS.map((k) => [k, o ? o[k] : undefined]));
const idx = (srv, e) => srv.state.log.indexOf(e);

async function withServer(fn) {
  const srv = await startMockServer();
  try { await fn(srv); } finally { await srv.close(); }
}

// ---------------------------------------------------------------- 고객 접수 (consent.html)

async function submitConsent(srv) {
  const ui = await openPage(srv, '/pages/consent.html', { viewport: { width: 390, height: 844 } });
  await ui.page.evaluate(() => {
    document.getElementById('guardianName').value = 'SENTINEL 보호자';
    document.getElementById('guardianPhone').value = '010-0000-0001';
    const set = (n, v) => { const el = document.querySelector(`#childrenContainer input[name="${n}"]`); if (el) el.value = v; };
    set('childName[]', 'SENTINEL 아동'); set('childBirth[]', '2019-05-12'); set('childHeight[]', '115'); set('childWeight[]', '21');
    for (const id of ['agreeRules', 'agreeGuardian', 'agreePrivacy']) document.getElementById(id).checked = true;
    const cv = document.getElementById('sigCanvas'); const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + 20, clientY: r.top + 20, bubbles: true }));
    cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 60, clientY: r.top + 60, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.getElementById('consentForm').dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await waitFor(() => ui.page.evaluate(() => !document.getElementById('voucherSection')?.classList.contains('hidden')), { timeout: 8000 });
  return ui;
}
const voucherNumber = (ui) => ui.page.evaluate(() => {
  const t = document.getElementById('voucherQueueNumberText')?.textContent || '';
  return /#\d{3}/.test(t) ? t.trim() : null;
});

test('C0 positive control: consent confirmed on server, then one enqueue, voucher shows the number', { skip }, async () => {
  await withServer(async (srv) => {
    const ui = await submitConsent(srv);
    try {
      assert.ok(await waitFor(async () => (await voucherNumber(ui)) === '#001'), '바우처에 #001 표시');
      const saved = srv.calls('rest', 'safety_consents').find((e) => e.outcome.startsWith('stored'));
      const enq = srv.calls('rpc', 'enqueue_consent_team');
      assert.equal(enq.length, 1);
      assert.ok(saved && idx(srv, saved) < idx(srv, enq[0]));
    } finally { await ui.close(); }
  });
});

test('C1 enqueue waits until the consent row is confirmed on the server, then completes without user action', { skip }, async () => {
  // 계약 §5.1-2: safety_consents 저장이 서버 확정(ok && !queued)이 아니면 접수 RPC 로 가지 않고 저장을 재시도한다.
  await withServer(async (srv) => {
    // 일시 장애: 첫 POST 와 그 직후 PATCH 대체 시도가 모두 503 → upsert 는 outbox 에 넣고 {ok:true, queued:true} 반환.
    // outbox 는 10초 주기로 다시 보내며 그때는 성공한다.
    srv.fault('rest', 'safety_consents', '503', { times: 1, method: 'POST' });
    srv.fault('rest', 'safety_consents', '503', { times: 1, method: 'PATCH' });
    const ui = await submitConsent(srv);
    try {
      const got = await waitFor(async () => (await voucherNumber(ui)) !== null, { timeout: 15000 });
      const firstStored = srv.calls('rest', 'safety_consents').find((e) => e.outcome.startsWith('stored'));
      const early = srv.calls('rpc', 'enqueue_consent_team').filter((e) => !firstStored || idx(srv, e) < idx(srv, firstStored));
      assert.equal(early.length, 0,
        `서약서가 서버에 확정되기 전에 접수 RPC 호출 ${early.length}회 (응답: ${early.map((e) => e.outcome).join(', ')})`);
      assert.ok(got, '서약서 확정 후 사용자 조작 없이 대기번호가 발급되어야 함');
    } finally { await ui.close(); }
  });
});

test('C5 a consent whose first save hits a transient 5xx is still saved on the server (not dropped)', { skip }, async () => {
  // 계약 §5 서버 확정 정의: 저장이 확정되지 않았으면 재시도 대상으로 남아야 한다.
  // 첫 POST 만 503 이고 PATCH 는 정상인 경우: 새 행이라 PATCH 는 PostgREST 규칙대로 200 [] 를 돌려준다.
  await withServer(async (srv) => {
    srv.fault('rest', 'safety_consents', '503', { times: 1, method: 'POST' });
    const ui = await submitConsent(srv);
    try {
      const consentId = await ui.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('bongplay_my_voucher')).consentId; } catch (e) { return null; } });
      const saved = await waitFor(() => srv.rows('safety_consents').some((r) => r.id === consentId), { timeout: 15000 });
      const outbox = await ui.page.evaluate(async () => { try { return (await BongplaySync.getQueue()).length; } catch (e) { return null; } });
      assert.ok(saved, `일시 503 뒤 서약서가 서버에 저장되지 않음 (15초 대기, 요청: ${srv.calls('rest', 'safety_consents').map((e) => e.method + ':' + e.outcome).join(', ')}, outbox ${outbox})`);
    } finally { await ui.close(); }
  });
});

test('C2 manual retry after a lost enqueue response re-sends exactly the same arguments', { skip }, async () => {
  // 계약 §5.1-3: 재시도는 같은 서약서 id·같은 멱등키·같은 인자. 인자가 바뀌면 서버 멱등키가 달라지고,
  // 첫 요청이 실제로는 실패했던 경우 잘못된 연락처로 새 팀이 만들어진다.
  await withServer(async (srv) => {
    srv.fault('rpc', 'enqueue_consent_team', 'lost', { times: 1 });   // 서버는 접수했지만 응답 유실
    const ui = await submitConsent(srv);
    try {
      assert.ok(await waitFor(() => ui.page.evaluate(() => {
        const b = document.getElementById('btnRetryQueueEnqueue'); return !!b && b.offsetParent !== null;
      })), '접수 실패 후 재시도 버튼이 보여야 함 (준비 조건)');
      await ui.page.click('#btnRetryQueueEnqueue');
      await waitFor(() => srv.calls('rpc', 'enqueue_consent_team').length >= 2);
      const [first, second] = srv.calls('rpc', 'enqueue_consent_team');
      assert.ok(second, '재시도 요청이 서버에 도달해야 함');
      assert.deepEqual(pick(second.body), pick(first.body), '재시도 인자가 첫 요청과 다름');
      assert.ok(await waitFor(async () => (await voucherNumber(ui)) !== null), '재시도 후 대기번호 표시');
      assert.equal(srv.state.queue.length, 1, '재시도로 팀이 하나 더 생김');
    } finally { await ui.close(); }
  });
});

test('C3 a retryable server rejection (ENQUEUE_CONFLICT) is retried automatically with the same arguments', { skip }, async () => {
  // 계약 §5.1-3 표: CONSENT_NOT_FOUND·ENQUEUE_CONFLICT 는 같은 인자로 자동 재시도.
  await withServer(async (srv) => {
    srv.fault('rpc', 'enqueue_consent_team', 'json', { times: 1, body: { ok: false, error: 'ENQUEUE_CONFLICT', retryable: true, message: '동시 접수 충돌' } });
    const ui = await submitConsent(srv);
    try {
      const retried = await waitFor(() => srv.calls('rpc', 'enqueue_consent_team').length >= 2, { timeout: 12000 });
      assert.ok(retried, `재시도 가능 오류 뒤 자동 재시도 없음 (12초 동안 접수 요청 ${srv.calls('rpc', 'enqueue_consent_team').length}회)`);
      const [first, second] = srv.calls('rpc', 'enqueue_consent_team');
      assert.deepEqual(pick(second.body), pick(first.body));
      assert.ok(await waitFor(async () => (await voucherNumber(ui)) !== null), '자동 재시도 후 대기번호 표시');
    } finally { await ui.close(); }
  });
});

test('C4 an HTTP 5xx on enqueue is retried automatically with the same arguments', { skip }, async () => {
  // 계약 §5.1-3 표: 네트워크 오류·5xx·시간 초과도 같은 인자로 자동 재시도 (서버는 같은 키에 같은 팀을 돌려준다).
  await withServer(async (srv) => {
    srv.fault('rpc', 'enqueue_consent_team', '503', { times: 1 });
    const ui = await submitConsent(srv);
    try {
      const retried = await waitFor(() => srv.calls('rpc', 'enqueue_consent_team').length >= 2, { timeout: 12000 });
      assert.ok(retried, `HTTP 5xx 뒤 자동 재시도 없음 (12초 동안 접수 요청 ${srv.calls('rpc', 'enqueue_consent_team').length}회)`);
      const [first, second] = srv.calls('rpc', 'enqueue_consent_team');
      assert.deepEqual(pick(second.body), pick(first.body));
    } finally { await ui.close(); }
  });
});

// ---------------------------------------------------------------- 매표 발권 완료 (consent-desk.html)

const SEED_CONSENT = {
  id: 'cst_sentinel_desk', site_id: 'bongplay_bonghwa', guardian_name: 'SENTINEL 보호자', guardian_phone: '010-0000-0002',
  residence: '관외', children: [{ name: 'SENTINEL 아동', birth: '2019-05-12', height: 115, weight: 21 }],
  is_issued: false, pass_code: 'BP-SENTINEL', created_date: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
};

/** 서버에 서약서·대기 팀을 만들고, 화면에서 호출 → 처리 시작 → 결제 창(기본권·현금 전액)까지 준비한다 */
async function deskReady(srv) {
  srv.seedConsent(SEED_CONSENT);
  srv.seedQueue(SEED_CONSENT);
  const ui = await openPage(srv, '/pages/consent-desk.html', { staff: true });
  await waitFor(() => ui.page.evaluate(() => typeof consents !== 'undefined' && consents.length > 0), { timeout: 8000 });
  const r = await ui.page.evaluate(async (cid) => {
    isSafetyInspectionPassed = true;
    await handleCallNextQueueTeam();
    if (!currentCalledQueueEntry) return { ok: false, step: 'call' };
    const p = await BongplayQueue.startProcessing(currentCalledQueueEntry.id, currentDeskNo);
    if (!p.ok) return { ok: false, step: 'start', p };
    currentCalledQueueEntry = p.item;
    openPaymentModal(cid);
    swapChildTicket('tkt_basic');                     // 기상 인터록(관측값 없음)에 걸리지 않는 기본권
    setAlloc('cash', payCtx.pricing.summary.total);
    return { ok: !!(payCtx.built && payCtx.built.valid), total: payCtx.pricing.summary.total };
  }, SEED_CONSENT.id);
  assert.ok(r.ok, `준비 실패: ${JSON.stringify(r)}`);
  return ui;
}
const confirmPayment = (ui) => ui.page.evaluate(() => confirmPayment());
const writesFor = (srv, tableName, orderId) => srv.calls('rest', tableName).filter((e) => e.body && e.body.order_id === orderId);

test('D0 positive control: order, payment and ledger are confirmed before completion; consent marked issued after it', { skip }, async () => {
  await withServer(async (srv) => {
    const ui = await deskReady(srv);
    try {
      await confirmPayment(ui);
      const done = srv.calls('rpc', 'complete_queue_issuance');
      assert.equal(done.length, 1);
      assert.equal(done[0].outcome, 'ok', JSON.stringify(done[0].response));
      const orderId = done[0].body.p_order_id;
      for (const t of ['order_items', 'order_payments', 'ticket_ledger']) {
        const w = writesFor(srv, t, orderId);
        assert.ok(w.length > 0 && w.every((e) => e.outcome.startsWith('stored') && idx(srv, e) < idx(srv, done[0])), `${t} 가 완료 호출 전에 확정되지 않음`);
      }
      const ledgerIds = writesFor(srv, 'ticket_ledger', orderId).map((e) => e.body.ticket_id).sort();
      assert.deepEqual([...done[0].body.p_ticket_ids].sort(), ledgerIds, '완료 요청 티켓 = 이 주문의 원장 티켓');
      const issuedMark = srv.calls('rest', 'safety_consents').find((e) => e.body && e.body.id === SEED_CONSENT.id && e.body.is_issued === true);
      assert.ok(issuedMark && idx(srv, issuedMark) > idx(srv, done[0]), '서약서 발권 완료 표시는 대기열 완료 뒤');
    } finally { await ui.close(); }
  });
});

test('D1 completion is not requested while ticket_ledger writes are only queued (not confirmed)', { skip }, async () => {
  // 계약 §5.2-3·4: 발권 원장이 서버 확정이 아니면 완료 RPC 를 부르지 않는다. upsert 는 5xx 를 {ok:true, queued:true} 로 돌려준다.
  await withServer(async (srv) => {
    srv.fault('rest', 'ticket_ledger', '503');
    const ui = await deskReady(srv);
    try {
      await confirmPayment(ui);
      await sleep(500);
      const done = srv.calls('rpc', 'complete_queue_issuance');
      assert.equal(done.length, 0,
        `원장 미확정 상태에서 완료 RPC 호출 ${done.length}회 (서버 응답: ${done.map((e) => e.outcome).join(', ')})`);
      assert.ok(!ui.dialogs.some((d) => d.message.includes('✅ 발권 완료')), '원장 미확정인데 발권 완료 안내');
    } finally { await ui.close(); }
  });
});

test('D2 completion is not requested while order_items writes are only queued (not confirmed)', { skip }, async () => {
  // 계약 §5.2-2: 주문 품목·결제가 전부 서버 확정이어야 다음 단계로 간다.
  await withServer(async (srv) => {
    srv.fault('rest', 'order_items', '503');
    const ui = await deskReady(srv);
    try {
      await confirmPayment(ui);
      await sleep(500);
      const done = srv.calls('rpc', 'complete_queue_issuance');
      assert.equal(done.length, 0,
        `주문 품목 미확정 상태에서 완료 RPC 호출 ${done.length}회 (서버 응답: ${done.map((e) => e.outcome).join(', ')})`);
    } finally { await ui.close(); }
  });
});

test('D3 retrying after a lost completion response reuses the same order and tickets (no second sale)', { skip }, async () => {
  // 계약 §5.2 실패 처리 표: 결과 불명(네트워크 오류)이면 같은 p_order_id·같은 티켓 id 로 재호출. 새 주문을 만들지 않는다.
  await withServer(async (srv) => {
    srv.fault('rpc', 'complete_queue_issuance', 'lost', { times: 1 });   // 서버는 완료 처리했지만 응답 유실
    const ui = await deskReady(srv);
    try {
      await confirmPayment(ui);                 // 첫 시도: 완료 응답 유실
      const stillOpen = await ui.page.evaluate(() => !!payCtx);
      assert.ok(stillOpen, '실패 후 결제 창이 유지되어 직원이 다시 누를 수 있어야 함 (준비 조건)');
      await confirmPayment(ui);                 // 직원이 같은 결제 창에서 다시 누름
      const done = srv.calls('rpc', 'complete_queue_issuance');
      assert.ok(done.length >= 2, `재시도 완료 요청이 없음 (${done.length}회)`);
      assert.equal(done[1].body.p_order_id, done[0].body.p_order_id, '재시도에서 새 주문 id 사용');
      assert.deepEqual(done[1].body.p_ticket_ids, done[0].body.p_ticket_ids, '재시도 티켓 id 가 다름');
      const orders = new Set(srv.rows('order_items').filter((r) => r.consent_id === SEED_CONSENT.id).map((r) => r.order_id));
      assert.equal(orders.size, 1, `같은 팀에 주문 ${orders.size}건 저장 (중복 판매)`);
      const pays = srv.rows('order_payments').filter((r) => r.consent_id === SEED_CONSENT.id && r.status === 'paid');
      assert.equal(pays.length, 1, `같은 팀에 결제 ${pays.length}건 저장 (중복 수납)`);
    } finally { await ui.close(); }
  });
});

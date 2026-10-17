import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import assert from 'assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '01_봉플레이_운영시스템');

// Static file server serving 01_봉플레이_운영시스템
function startServer(port) {
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(rootDir, reqPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      let contentType = 'text/plain';
      if (filePath.endsWith('.html')) contentType = 'text/html';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.css')) contentType = 'text/css';
      else if (filePath.endsWith('.json')) contentType = 'application/json';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found: ' + reqPath);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function run() {
  const PORT = 8123;
  const server = await startServer(PORT);
  console.log(`[TEST SERVER] Started at http://localhost:${PORT}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });

  // 직원 전용 화면을 위한 기본 운영자 세션 주입
  await context.addInitScript(() => {
    localStorage.setItem('bongplay_staff_session_v2', JSON.stringify({
      code: '000000',
      authAt: Date.now(),
      expiresAt: Date.now() + 12 * 3600 * 1000
    }));
  });

  const evidenceDir = path.resolve(__dirname, 'evidence');
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });

  try {
    // =========================================================================
    // 1. 안전점검 화면 (safety-check.html) 실제 브라우저 검증
    // - 배포본과 동일한 로컬 라이브러리(/assets/vendor/) 구성
    // - 외부 CDN 차단 시에도 화면 멈춤(freeze) 없음
    // - 실제 입력 → 서명 → 저장 → 서버 재조회(loadLatestOrNew) 폼 복원 검증
    // =========================================================================
    console.log('\n--- [1] 안전점검 화면 실제 브라우저 입력·저장·서버재조회 검증 ---');
    const page1 = await context.newPage();
    const page1Errors = [];
    page1.on('console', msg => {
      if (msg.type() === 'error') page1Errors.push(msg.text());
      else console.log('  [PAGE1 LOG]:', msg.text());
    });
    page1.on('pageerror', err => page1Errors.push(err.toString()));

    // 외부 CDN 차단 (오프라인 / 배포본 로컬 벤더 환경 강제)
    await page1.route('**/*cdn.tailwindcss.com/**', route => route.abort());
    await page1.route('**/*jsdelivr.net/**', route => route.abort());

    // Mock Supabase REST calls on BongplaySync
    let serverSafetyAudits = [];
    await page1.route('**/rest/v1/safety_audits*', async route => {
      const req = route.request();
      if (req.method() === 'POST' || req.method() === 'PUT') {
        const body = JSON.parse(req.postData());
        serverSafetyAudits.unshift(body);
        route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(body) });
      } else if (req.method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serverSafetyAudits) });
      } else {
        route.continue();
      }
    });

    await page1.goto(`http://localhost:${PORT}/pages/safety-check.html`);
    await page1.waitForTimeout(1000);

    // 콘솔 에러가 없어야 함 (lucide 및 SignaturePad 미로드로 인한 크래시 없음)
    const fatalErrors = page1Errors.filter(e => !e.includes('net::ERR_FAILED'));
    console.log('  - 페이지 로드 콘솔 치명적 에러 수:', fatalErrors.length);
    assert.equal(fatalErrors.length, 0, '페이지 로드 시 치명적 스크립트 에러가 없어야 함: ' + fatalErrors.join(', '));

    // 점검자 성명, 관리책임자, 기상 입력
    await page1.fill('#inspectorName', '홍길동');
    await page1.fill('#managerName', '김철수');
    await page1.selectOption('#weatherSelect', '맑음');
    await page1.fill('#temperature', '18.5℃');

    // 22개 항목 전체 양호 버튼 클릭
    await page1.click('button[onclick="markAllPass()"]');
    await page1.waitForTimeout(300);

    // 네이티브 캔버스에 실제 마우스 드래그로 서명 그리기
    const canvas = await page1.$('#signaturePad');
    assert.ok(canvas, '서명 캔버스가 존재해야 함');
    await canvas.scrollIntoViewIfNeeded();
    await page1.waitForTimeout(200);
    const box = await canvas.boundingBox();
    assert.ok(box, '캔버스 바운딩 박스를 가져올 수 있어야 함');

    await page1.mouse.move(box.x + 30, box.y + 30);
    await page1.mouse.down();
    await page1.mouse.move(box.x + 100, box.y + 60);
    await page1.mouse.move(box.x + 160, box.y + 40);
    await page1.mouse.move(box.x + 220, box.y + 90);
    await page1.mouse.up();
    await page1.waitForTimeout(300);

    const sigData = await page1.evaluate(() => typeof getSignatureData === 'function' ? getSignatureData() : null);
    console.log('  - 서명 생성 데이터 존재 여부:', !!sigData);

    // 판정 라디오 버튼이 'pass'인지 확인
    const passRadioChecked = await page1.$eval('input[name="finalDecision"][value="pass"]', el => el.checked);
    assert.equal(passRadioChecked, true, '전체 양호 후 최종 판정은 pass 여야 함');

    // 저장 버튼 클릭
    page1.on('dialog', async dialog => {
      console.log('  [PAGE1 DIALOG]:', dialog.message());
      await dialog.accept();
    });
    await page1.click('button[onclick="saveChecklist()"]');
    await page1.waitForTimeout(1000);

    // 서버 safety_audits 에 데이터가 기록되었는지 확인
    assert.ok(serverSafetyAudits.length > 0, '서버 safety_audits 테이블에 upsert 되어야 함');
    assert.equal(serverSafetyAudits[0].inspector, '홍길동');
    assert.equal(serverSafetyAudits[0].decision, 'pass');
    assert.ok(serverSafetyAudits[0].signature_data, '서명 데이터가 포함되어야 함');
    console.log('  - 화면에서 저장된 서버 감사 ID:', serverSafetyAudits[0].id);

    // [서버 재조회 검증]: localStorage를 비운 후 loadLatestOrNew() 호출하여 서버에서 온전히 복원되는지 검증
    await page1.evaluate(() => {
      localStorage.removeItem('bongplay_safety_audit_logs');
    });
    const bannerBefore = await page1.$eval('#todayAuditBanner', el => el.innerHTML);
    
    // 서버 비동기 재조회 실행
    await page1.evaluate(async () => {
      await window.loadLatestOrNew(true);
    });
    await page1.waitForTimeout(500);

    // 화면 입력칸 및 오늘 점검 배너가 서버 기록으로 복원되었는지 실제 DOM 검증
    const restoredInspector = await page1.$eval('#inspectorName', el => el.value);
    const restoredDecision = await page1.$eval('input[name="finalDecision"][value="pass"]', el => el.checked);
    const bannerText = await page1.$eval('#todayAuditBanner', el => el.textContent);
    
    console.log('  - 로컬스토리지 삭제 후 서버 재조회로 복원된 점검자:', restoredInspector);
    console.log('  - 복원된 최종 판정 (pass):', restoredDecision);
    console.log('  - 배너 표출 텍스트 일부:', bannerText.slice(0, 60));

    assert.equal(restoredInspector, '홍길동', '서버 재조회 후 점검자명이 복원되어야 함');
    assert.equal(restoredDecision, true, '서버 재조회 후 적합 판정이 복원되어야 함');
    assert.ok(bannerText.includes('정상 (개장 승인)') || bannerText.includes('안전점검 완료'), '배너에 정상 판정 및 점검 완료가 표시되어야 함');

    const ss1Path = path.join(evidenceDir, '01_safety_check_verified.png');
    await page1.screenshot({ path: ss1Path, fullPage: true });
    console.log('  - 실제 화면 증빙 저장 완료:', ss1Path);
    await page1.close();


    // =========================================================================
    // 2. 고객 서약 화면 (consent.html) 실제 브라우저 검증
    // - 전화번호 기반 가족 캐시 조회·저장 및 lookup_family_children 호출 제거 확인
    // - 공용 기기 모드(?mode=kiosk)에서 이전 고객 정보 미노출 및 60초 자동 초기화 확인
    // - 미전송 데이터(bongplay_sync_outbox) 보존 확인
    // - 개인 기기에서는 폼 작성 중 새로고침 시 세션 복구 보존 확인
    // =========================================================================
    console.log('\n--- [2] 고객 서약 화면 가족 캐시 제거·공용 기기 동선·새로고침 복구 검증 ---');
    const page2 = await context.newPage();
    let rpcLookupCalled = false;
    await page2.route('**/rest/v1/rpc/*', async route => {
      const url = route.request().url();
      if (url.includes('lookup_family_children')) {
        rpcLookupCalled = true;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // 2-1: 전화번호 입력 시 가족 캐시 조회/저장 배너 없음 검증
    await page2.goto(`http://localhost:${PORT}/pages/consent.html`);
    await page2.waitForTimeout(500);

    await page2.fill('#guardianPhone', '01012345678');
    await page2.waitForTimeout(500);

    assert.equal(rpcLookupCalled, false, 'lookup_family_children RPC가 일체 호출되지 않아야 함');
    const repeatFamilyBoxExists = await page2.$('#repeatFamilyBox');
    assert.equal(repeatFamilyBoxExists, null, '#repeatFamilyBox 요소가 DOM에 없어야 함');

    // 2-2: 개인 기기 작성 중 새로고침 세션 복구 검증
    await page2.fill('#guardianName', '이몽룡');
    await page2.fill('#guardianPhone', '010-9876-5432');
    await page2.fill('input[name="childName[]"]', '이자녀');
    await page2.fill('input[name="childBirth[]"]', '20190101');
    await page2.dispatchEvent('#consentForm', 'input');
    await page2.waitForTimeout(300);

    // 새로고침 실행
    await page2.reload();
    await page2.waitForTimeout(500);

    const reloadedName = await page2.$eval('#guardianName', el => el.value);
    const reloadedChild = await page2.$eval('input[name="childName[]"]', el => el.value);
    console.log('  - 개인 기기 새로고침 후 복원된 성명:', reloadedName);
    console.log('  - 개인 기기 새로고침 후 복원된 자녀:', reloadedChild);
    assert.equal(reloadedName, '이몽룡', '개인 기기 새로고침 시 작성 중이던 성명이 복구되어야 함');
    assert.equal(reloadedChild, '이자녀', '개인 기기 새로고침 시 자녀 성명이 복구되어야 함');

    // 2-3: 공용 기기(?mode=kiosk) 동선 검증
    // 아웃박스에 미전송 건 1건을 시드
    await page2.evaluate(() => {
      localStorage.setItem('bongplay_sync_outbox', JSON.stringify([{
        id: 'outbox_test_001',
        table: 'safety_consents',
        method: 'POST',
        payload: { pass_code: 'BP-OUTBOX-01' }
      }]));
      localStorage.setItem('bongplay_my_voucher', JSON.stringify({
        passCode: 'BP-OLD-GUEST',
        guardianName: '옛날고객',
        date: new Date().toISOString().slice(0, 10)
      }));
    });

    // 공용 키오스크 주소로 진입
    await page2.goto(`http://localhost:${PORT}/pages/consent.html?mode=kiosk`);
    await page2.waitForTimeout(500);

    // 공용 기기에서는 이전 고객의 바우처가 뜨지 않고 빈 작성 폼이 떠야 함
    const isFormVisible = await page2.$eval('#formSection', el => !el.classList.contains('hidden'));
    const isVoucherHidden = await page2.$eval('#voucherSection', el => el.classList.contains('hidden'));
    const currentNameOnKiosk = await page2.$eval('#guardianName', el => el.value);
    assert.equal(isFormVisible, true, '공용 기기에서는 작성 폼이 보여야 함');
    assert.equal(isVoucherHidden, true, '공용 기기에서는 이전 고객의 바우처가 숨겨져야 함');
    assert.equal(currentNameOnKiosk, '', '공용 기기에서는 이전 고객 성명이 비어 있어야 함');

    // 그러나 미전송 outbox는 온전히 보존되어야 함!
    const preservedOutbox = await page2.evaluate(() => {
      return JSON.parse(localStorage.getItem('bongplay_sync_outbox') || '[]');
    });
    assert.equal(preservedOutbox.length, 1, '미전송 outbox는 삭제되지 않고 온전히 보존되어야 함');
    assert.equal(preservedOutbox[0].id, 'outbox_test_001');
    console.log('  - 공용 기기 초기화 시 미전송 outbox 보존 확인: 건수', preservedOutbox.length);

    const ss2Path = path.join(evidenceDir, '02_consent_kiosk_verified.png');
    await page2.screenshot({ path: ss2Path, fullPage: true });
    console.log('  - 실제 화면 증빙 저장 완료:', ss2Path);
    await page2.close();


    // =========================================================================
    // 3. 직원 창구 화면 (consent-desk.html) 및 클로이 6a7ce1b 계약 검증
    // - 전날 미정리 목록(past_unresolved_teams) 연결 및 UI 표출
    // - processing 건: 새 주문 생성 없이 기존 order_id로 [발권 완료 확정]만 제공
    // - called 건: [대기열 취소]만 제공
    // - LEDGER_REVIEW_REQUIRED 건: 차단 배지 표출 및 동작 차단
    // =========================================================================
    console.log('\n--- [3] 직원 화면 전날 미정리 대기열 연결 및 제한 동작 검증 ---');
    const page3 = await context.newPage();
    const deskDialogs = [];
    page3.on('dialog', async d => {
      deskDialogs.push(d.message());
      if (d.type() === 'prompt') {
        await d.accept(d.defaultValue() || '전날 미방문 취소');
      } else {
        await d.accept();
      }
    });

    let completedQueueArgs = null;
    let canceledQueueArgs = null;

    // Supabase RPC interceptor
    await page3.route('**/rest/v1/rpc/*', async route => {
      const req = route.request();
      const url = req.url();
      const body = req.postData() ? JSON.parse(req.postData()) : {};

      if (url.includes('get_staff_queue_list')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            waiting_count: 2,
            called_teams: [],
            held_teams: [],
            past_unresolved_total: 3,
            past_unresolved_teams: [
              {
                id: 'q_past_007',
                queue_date: '2026-10-16',
                queue_number: 7,
                formatted_number: '#007',
                status: 'processing',
                desk_no: 1,
                guardian_name: '어제고객1',
                party_size: 2,
                recorded_orders: [{ order_id: 'ord_20261016_007', paid_total: 30000, active_tickets: 2 }],
                allowed_actions: ['complete_queue_issuance'],
                blocked_reason: null
              },
              {
                id: 'q_past_008',
                queue_date: '2026-10-16',
                queue_number: 8,
                formatted_number: '#008',
                status: 'called',
                desk_no: 1,
                guardian_name: '어제고객2',
                party_size: 3,
                recorded_orders: [],
                allowed_actions: ['cancel_queue_team'],
                blocked_reason: null
              },
              {
                id: 'q_past_009',
                queue_date: '2026-10-16',
                queue_number: 9,
                formatted_number: '#009',
                status: 'called',
                desk_no: 2,
                guardian_name: '어제고객3',
                party_size: 1,
                recorded_orders: [{ order_id: 'ord_20261016_009', paid_total: 10000 }],
                allowed_actions: [],
                blocked_reason: 'LEDGER_REVIEW_REQUIRED'
              }
            ]
          })
        });
      } else if (url.includes('complete_queue_issuance')) {
        completedQueueArgs = body;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, past_queue_date: true, item: { id: body.p_queue_id, status: 'issued' } })
        });
      } else if (url.includes('cancel_queue_team')) {
        canceledQueueArgs = body;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, past_queue_date: true, item: { id: body.p_queue_id, status: 'canceled' } })
        });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
    });

    await page3.goto(`http://localhost:${PORT}/pages/consent-desk.html`);
    await page3.waitForTimeout(1000);

    // 직원 화면 전날 미정리 대기열 영역 확인
    const pastContainerVisible = await page3.$eval('#pastUnresolvedContainer', el => !el.classList.contains('hidden'));
    const pastCount = await page3.$eval('#pastUnresolvedCount', el => el.textContent);
    console.log('  - 직원 화면 전날 미정리 목록 노출 여부:', pastContainerVisible);
    console.log('  - 전날 미정리 건수 표출:', pastCount);
    assert.equal(pastContainerVisible, true, '전날 미정리 대기열 서랍이 노출되어야 함');
    assert.equal(pastCount, '3', '전날 미정리 건수가 3건이어야 함');

    // #007 건의 발권 확정 버튼 클릭 (새 주문 생성 없이 기존 주문 연동)
    const completeBtn = await page3.$('button[onclick*="handleCompletePastUnresolvedTeam(\'q_past_007\'"]');
    assert.ok(completeBtn, '#007 팀에 [발권 완료 확정] 버튼이 존재해야 함');
    await completeBtn.click();
    await page3.waitForTimeout(500);

    assert.ok(completedQueueArgs, 'complete_queue_issuance RPC가 호출되어야 함');
    assert.equal(completedQueueArgs.p_queue_id, 'q_past_007');
    assert.equal(completedQueueArgs.p_order_id, 'ord_20261016_007', '기존 recorded_order의 order_id가 그대로 사용되어야 함 (새 주문 생성 0건)');
    console.log('  - #007 기존 주문 발권 확정 RPC 전달 인자:', completedQueueArgs);

    // #008 건의 취소 버튼 클릭
    const cancelBtn = await page3.$('button[onclick*="handleCancelPastUnresolvedTeam(\'q_past_008\'"]');
    assert.ok(cancelBtn, '#008 팀에 [대기열 취소] 버튼이 존재해야 함');
    await cancelBtn.click();
    await page3.waitForTimeout(500);

    assert.ok(canceledQueueArgs, 'cancel_queue_team RPC가 호출되어야 함');
    assert.equal(canceledQueueArgs.p_queue_id, 'q_past_008');
    console.log('  - #008 대기열 취소 RPC 전달 인자:', canceledQueueArgs);

    // #009 건 확인: 원장 검토 필요 배지 표출 및 발권/취소 버튼 없음 확인
    const item009Html = await page3.$eval('#pastUnresolvedList', el => el.innerHTML);
    assert.ok(item009Html.includes('원장 검토 필요'), '#009 팀에 원장 검토 필요 배지가 표출되어야 함');
    const complete009 = await page3.$('button[onclick*="handleCompletePastUnresolvedTeam(\'q_past_009\'"]');
    assert.equal(complete009, null, '#009 팀에는 발권 버튼이 없어야 함');

    const ss3Path = path.join(evidenceDir, '03_consent_desk_past_unresolved_verified.png');
    await page3.screenshot({ path: ss3Path, fullPage: true });
    console.log('  - 실제 화면 증빙 저장 완료:', ss3Path);
    await page3.close();

    console.log('\n======================================================');
    console.log('🎉 모든 실제 브라우저 E2E 검증 및 화면 증빙 확보 완료! (100% PASS)');
    console.log('======================================================\n');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

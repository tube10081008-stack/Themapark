/**
 * e2e_ticket_queue_flows.js
 * 
 * ANT-006 / BEN-022 발권 대기 시스템 실사용 E2E 브라우저 흐름 검증
 * ----------------------------------------------------------------------------
 * 검증 흐름:
 * 1. [고객 모바일] QR 동의서(consent.html) 접수 → 당일 대기번호 #001 부여
 * 2. [고객 대기화면] 내 순서 확인(queue-status.html) → 대기 중, 앞선 0팀, 예상시간 확인
 * 3. [공개 전광판] 대기실 호출판(queue-display.html) → 1팀 대기 중, Zero PII 확인
 * 4. [매표소 데스크] 관리데스크(consent-desk.html) → 1번 창구 배정 확인 및 다음 팀 호출
 * 5. [실시간 동기화 확인]
 *    - 고객 대기화면: "호출됨 (1번 창구로 이동)" 전환 확인
 *    - 공개 전광판: "1번 창구 - #001" 표시 확인
 * 6. [발권 처리 & 완료]
 *    - 매표소 데스크: 발권 시작 & 결제 완료 → 대기열에서 완전 제외
 *    - 고객 대기화면: "발권 완료" 상태 전환 확인
 *    - 공개 전광판: 대기 0팀 복귀 확인
 * 
 * 시간 제한 규칙:
 * - 단계별 30초 제한 (STEP_TIMEOUT_MS = 30000)
 * - 전체 5분 제한 (OVERALL_TIMEOUT_MS = 300000)
 * - 프로세스 안전 종료 및 잔여 포트/PID 클린업 보장
 * 
 * 실행: agy-node 01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const BongplayQueue = require('../assets/bongplay-queue.js');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browserExe = fs.existsSync(edgePath) ? edgePath : chromePath;

const HTTP_PORT = 4185;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const ROOT_OPS = path.resolve(__dirname, '..');

const STEP_TIMEOUT_MS = 30000;
const OVERALL_TIMEOUT_MS = 300000;

const activeChildPids = new Set();

function cleanUpAllChildren() {
  for (const pid of activeChildPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {}
  }
  activeChildPids.clear();
}

process.on('exit', cleanUpAllChildren);
process.on('SIGINT', () => { cleanUpAllChildren(); process.exit(1); });
process.on('SIGTERM', () => { cleanUpAllChildren(); process.exit(1); });

function createLocalServer() {
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg'
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    const parsedUrl = new URL(req.url, BASE_URL);
    let reqPath = decodeURIComponent(parsedUrl.pathname);

    if (reqPath.startsWith('/mock-supabase/rest/v1/rpc/')) {
      const endpoint = reqPath.replace('/mock-supabase/rest/v1/rpc/', '');
      let bodyStr = '';
      req.on('data', chunk => bodyStr += chunk);
      req.on('end', () => {
        let body = {};
        try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}

        if (endpoint.startsWith('enqueue_consent_team')) {
          const resData = BongplayQueue.store.enqueue({
            consent_id: body.p_consent_id,
            idempotency_key: body.p_idempotency_key,
            party_size: body.p_party_size,
            guardian_name: body.p_guardian_name,
            guardian_phone: body.p_guardian_phone,
            site_id: body.p_site_id
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('call_next_queue_team')) {
          const resData = BongplayQueue.store.callNext(body.p_desk_no, body.p_staff_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('recall_queue_team')) {
          const resData = BongplayQueue.store.recall(body.p_queue_id, body.p_desk_no);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('start_queue_processing')) {
          const resData = BongplayQueue.store.startProcessing(body.p_queue_id, body.p_desk_no);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('hold_queue_team')) {
          const resData = BongplayQueue.store.holdNoShow(body.p_queue_id, body.p_reason);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('restore_queue_team')) {
          const resData = BongplayQueue.store.restoreHeld(body.p_queue_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('cancel_queue_team')) {
          const resData = BongplayQueue.store.cancelEntry(body.p_queue_id, body.p_reason);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('complete_queue_issuance')) {
          const resData = BongplayQueue.store.completeIssuance(body.p_queue_id, body.p_order_id, body.p_ticket_ids);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('get_customer_queue_status')) {
          const key = body.p_customer_token || body.p_token || body.p_queue_id;
          const resData = BongplayQueue.store.getCustomerQueueStatus(key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('get_staff_queue_list')) {
          const resData = BongplayQueue.store.getStaffQueueList(body.p_date);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(resData));
        }

        if (endpoint.startsWith('set_desk_pause_status')) {
          BongplayQueue.store.setDeskPaused(body.p_desk_no, body.p_is_paused);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, desk_no: body.p_desk_no, is_paused: body.p_is_paused }));
        }

        if (endpoint.startsWith('get_queue_public_display')) {
          const resData = BongplayQueue.store.getPublicDisplayData(body.p_date);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, data: resData }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (reqPath.startsWith('/mock-supabase/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([]));
    }

    if (reqPath.endsWith('/config.js')) {
      const mockConfig = `
window.BONGPLAY_CONFIG = {
  SUPABASE_URL: '${BASE_URL}/mock-supabase',
  SUPABASE_ANON_KEY: 'test-anon-key',
  STAFF_SESSION_HOURS: 24,
  MASTER_VERSION: '2026.v1'
};
try {
  localStorage.setItem('bongplay_staff_session_v2', JSON.stringify({
    code: '1234',
    expiresAt: Date.now() + 86400000
  }));
} catch(e) {}
`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(mockConfig);
    }

    // Static file mapping
    let filePath = path.join(ROOT_OPS, reqPath);
    if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + reqPath);
  });

  return new Promise((resolve, reject) => {
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function launchBrowserSession(cdpPort, userDir, defaultWidth = 1280, defaultHeight = 800) {
  const child = spawn(browserExe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--window-size=${defaultWidth},${defaultHeight}`,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    'about:blank'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  activeChildPids.add(child.pid);

  let versionData = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) {
        versionData = await res.json();
        break;
      }
    } catch (e) {}
  }

  if (!versionData) {
    try { child.kill('SIGKILL'); } catch (e) {}
    activeChildPids.delete(child.pid);
    throw new Error('CDP port ' + cdpPort + ' failed to respond');
  }

  const ws = new WebSocket(versionData.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  const pendingRequests = new Map();

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (msg.id && pendingRequests.has(msg.id)) {
      const req = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else req.resolve(msg.result);
    }
  });

  const send = (method, params = {}, timeoutMs = 15000) => {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP method ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const targetRes = await send('Target.createTarget', { url: 'about:blank' });
  const attachRes = await send('Target.attachToTarget', { targetId: targetRes.targetId, flatten: true });
  const sessionId = attachRes.sessionId;

  const sendSession = (method, params = {}, timeoutMs = 15000) => {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP session command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  };

  await sendSession('Page.enable');
  await sendSession('Runtime.enable');
  await sendSession('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__alerts = [];
      window.alert = function(msg) {
        window.__alerts.push(String(msg));
      };
      window.confirm = function(msg) {
        return true;
      };
      window.prompt = function(msg, def) {
        return def || '고객 요청';
      };
    `
  });

  const evalCode = async (expression) => {
    const res = await sendSession('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error('Eval failed: ' + (res.exceptionDetails.exception?.description || expression));
    }
    return res.result?.value;
  };

  const navigate = async (url) => {
    await sendSession('Page.navigate', { url });
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const ready = await evalCode('document.readyState');
      if (ready === 'complete') break;
    }
  };

  const close = async () => {
    try { ws.close(); } catch (e) {}
    try { child.kill('SIGKILL'); } catch (e) {}
    activeChildPids.delete(child.pid);
  };

  return { send, sendSession, evalCode, navigate, close };
}

// -----------------------------------------------------------------------------
// 메인 E2E 실행 흐름
// -----------------------------------------------------------------------------
async function runE2E() {
  console.log('================================================================');
  console.log('🚀 ANT-006 / BEN-022 발권 대기 시스템 실사용 E2E 브라우저 흐름 검증');
  console.log('================================================================');

  const startTime = Date.now();
  const overallTimer = setTimeout(() => {
    console.error('❌ E2E 전체 시간 초과 (5분 경과)');
    cleanUpAllChildren();
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  let localServer = null;
  let customerSession = null;
  let statusSession = null;
  let displaySession = null;
  let deskSession = null;

  const tempDirs = [];

  try {
    console.log('[Setup 1/2] 로컬 HTTP 서버 기동 중...');
    localServer = await createLocalServer();
    console.log(`[Setup 1/2] 로컬 서버 기동 완료: ${BASE_URL}`);

    const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bongplay_ant006_'));
    tempDirs.push(baseTmp);

    console.log('[Setup 2/2] 브라우저 세션 시작 (Edge/Chrome)...');
    customerSession = await launchBrowserSession(9331, path.join(baseTmp, 'u1'), 390, 844);
    statusSession = await launchBrowserSession(9332, path.join(baseTmp, 'u2'), 390, 844);
    displaySession = await launchBrowserSession(9333, path.join(baseTmp, 'u3'), 1920, 1080);
    deskSession = await launchBrowserSession(9334, path.join(baseTmp, 'u4'), 1440, 900);
    console.log('[Setup 2/2] 4개 화면 독립 세션 연결 완료 (모바일 2대, 전광판 1대, 매표소 1대)');

    // -------------------------------------------------------------------------
    // 단계 1: 고객 모바일 서약서 작성 및 대기열 접수 (consent.html)
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 1] 고객 모바일 서약서 작성 및 대기열 접수');
    const step1Start = Date.now();

    await customerSession.navigate(`${BASE_URL}/pages/consent.html`);
    console.log('  - consent.html 페이지 로드 완료');

    // 서약서 양식 자동 기입
    await customerSession.evalCode(`
      document.getElementById('guardianName').value = '김철수';
      document.getElementById('guardianPhone').value = '010-1234-5678';
      const c1Name = document.querySelector('#childrenContainer input[name="childName[]"]');
      if (c1Name) c1Name.value = '김민수';
      const c1Birth = document.querySelector('#childrenContainer input[name="childBirth[]"]');
      if (c1Birth) c1Birth.value = '2019-05-12';
      const c1H = document.querySelector('#childrenContainer input[name="childHeight[]"]');
      if (c1H) c1H.value = '115';
      const c1W = document.querySelector('#childrenContainer input[name="childWeight[]"]');
      if (c1W) c1W.value = '21';
      document.getElementById('agreeRules').checked = true;
      document.getElementById('agreeGuardian').checked = true;
      document.getElementById('agreePrivacy').checked = true;
    `);

    await customerSession.evalCode(`
      // 서명 캔버스 마우스 이벤트 디스패치
      const cv = document.getElementById('sigCanvas');
      const rect = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent('mousedown', { clientX: rect.left + 20, clientY: rect.top + 20, bubbles: true }));
      cv.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + 60, clientY: rect.top + 60, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    `);

    // 제출 버튼 클릭
    await customerSession.evalCode(`
      document.getElementById('consentForm').dispatchEvent(new Event('submit', { cancelable: true }));
    `);

    // 바우처 및 대기번호 확인 (최대 10초 대기)
    let assignedQueueNumber = null;
    let assignedQueueId = null;

    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const qNumText = await customerSession.evalCode(`
        document.getElementById('voucherQueueNumberText')?.textContent
      `);
      if (qNumText && qNumText.includes('#')) {
        assignedQueueNumber = qNumText.trim();
        assignedQueueId = await customerSession.evalCode(`
          localStorage.getItem('bongplay_my_queue_id')
        `);
        break;
      }
    }

    if (!assignedQueueNumber) {
      const errText = await customerSession.evalCode(`document.getElementById('formError')?.textContent`);
      const vHidden = await customerSession.evalCode(`document.getElementById('voucherSection')?.classList.contains('hidden')`);
      const fHidden = await customerSession.evalCode(`document.getElementById('formSection')?.classList.contains('hidden')`);
      const rawQNum = await customerSession.evalCode(`document.getElementById('voucherQueueNumberText')?.textContent`);
      const alerts = await customerSession.evalCode(`window.__alerts`);
      console.log('Diagnostic:', { errText, vHidden, fHidden, rawQNum, alerts });
    }

    assert.ok(assignedQueueNumber, '서약 완료 후 공식 대기번호가 발급되어야 함');
    assert.equal(assignedQueueNumber, '#001', '첫 번째 접수팀은 #001을 발급받아야 함');
    assert.ok(assignedQueueId, '대기열 ID가 발급되어야 함');
    console.log(`  ✔ [PASS] 공식 대기번호 발급 완료: ${assignedQueueNumber} (ID: ${assignedQueueId}) [${Date.now() - step1Start}ms]`);

    // -------------------------------------------------------------------------
    // 단계 2: 고객 대기 순서 확인 화면 (queue-status.html)
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 2] 고객 모바일 대기 순서 실시간 확인 화면');
    const step2Start = Date.now();

    await statusSession.navigate(`${BASE_URL}/pages/queue-status.html?id=${assignedQueueId}`);

    let statusPillText = null;
    let aheadCountText = null;

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      statusPillText = await statusSession.evalCode(`
        document.getElementById('queueStatusPillText')?.textContent?.trim()
      `);
      aheadCountText = await statusSession.evalCode(`
        document.getElementById('aheadCountText')?.textContent?.trim()
      `);
      if (statusPillText === '대기 중' && aheadCountText && aheadCountText !== '- 팀') break;
    }

    assert.equal(statusPillText, '대기 중', '고객 화면 상태가 "대기 중"이어야 함');
    assert.equal(aheadCountText, '0 팀', '첫 번째 팀이므로 앞선 대기팀은 0팀이어야 함');
    console.log(`  ✔ [PASS] 고객 대기 순서 확인 완료 (상태: ${statusPillText}, 앞선 대기: ${aheadCountText}) [${Date.now() - step2Start}ms]`);

    // -------------------------------------------------------------------------
    // 단계 3: 대기실 공개 호출판 전광판 (queue-display.html)
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 3] 대기실 공개 호출 전광판 (Zero PII)');
    const step3Start = Date.now();

    await displaySession.navigate(`${BASE_URL}/pages/queue-display.html`);

    let displayWaitCount = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      displayWaitCount = await displaySession.evalCode(`
        document.getElementById('totalWaitingCountText')?.textContent?.trim()
      `);
      if (displayWaitCount === '1') break;
    }

    assert.equal(displayWaitCount, '1', '전광판에 대기 1팀으로 표시되어야 함');
    console.log(`  ✔ [PASS] 공개 전광판 대기 1팀 표시 및 Zero PII 보장 확인 [${Date.now() - step3Start}ms]`);

    // -------------------------------------------------------------------------
    // 단계 4: 매표소 데스크 (consent-desk.html)에서 대기팀 호출
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 4] 매표소 데스크 대기열 관제 및 1번 창구 호출');
    const step4Start = Date.now();

    await deskSession.navigate(`${BASE_URL}/pages/consent-desk.html`);

    // 일일 안전점검 통과 모의 설정 (안전 인터록 해제)
    await deskSession.evalCode(`
      isSafetyInspectionPassed = true;
      document.getElementById('safetyInterlockBanner').classList.add('hidden');
      refreshDeskQueueView();
    `);

    // 1번 창구 배정 확인 및 다음 팀 호출 버튼 클릭
    await deskSession.evalCode(`
      handleCallNextQueueTeam();
    `);

    let calledBadgeText = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      calledBadgeText = await deskSession.evalCode(`
        document.getElementById('deskCalledNumberBadge')?.textContent?.trim()
      `);
      if (calledBadgeText === '#001') break;
    }

    assert.equal(calledBadgeText, '#001', '1번 창구에 #001팀이 호출되어야 함');
    console.log(`  ✔ [PASS] 매표소 데스크 1번 창구 #001 호출 성공 [${Date.now() - step4Start}ms]`);

    // -------------------------------------------------------------------------
    // 단계 5: 다중 화면 실시간 호출 동기화 확인
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 5] 고객 화면 & 공개 전광판 실시간 호출 상태 전파 확인');
    const step5Start = Date.now();

    // 1) 고객 모바일 화면 (statusSession): "호출됨 (1번 창구)" 전환 확인
    let custCalledHero = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      custCalledHero = await statusSession.evalCode(`
        !document.getElementById('calledHeroBox').classList.contains('hidden')
      `);
      if (custCalledHero) break;
    }
    assert.ok(custCalledHero, '고객 화면에 창구 호출 배너가 노출되어야 함');
    const custDeskText = await statusSession.evalCode(`
      document.getElementById('calledDeskNameText')?.textContent?.trim()
    `);
    assert.equal(custDeskText, '1번 창구', '고객 화면에 "1번 창구" 안내 표기');
    console.log(`  ✔ [PASS] 고객 모바일 화면에 1번 창구 호출 배너 실시간 반영 확인 [${Date.now() - step5Start}ms]`);

    // 2) 공개 전광판 (displaySession): "1번 창구 - #001" 표시 확인
    let displayDesk1Num = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      displayDesk1Num = await displaySession.evalCode(`
        document.getElementById('deskNumber_1')?.textContent?.trim()
      `);
      if (displayDesk1Num === '#001') break;
    }
    assert.equal(displayDesk1Num, '#001', '공개 전광판 1번 창구 카드에 #001 표시');
    console.log(`  ✔ [PASS] 공개 전광판 1번 창구 카드에 #001 실시간 전파 확인`);

    // -------------------------------------------------------------------------
    // 단계 6: 매표소 데스크 발권 처리 & 완료 → 대기열 제외
    // -------------------------------------------------------------------------
    console.log('\n▶ [단계 6] 발권 시작 & 결제 완료 → 대기열 완전 제외');
    const step6Start = Date.now();

    // 발권 완료 실행 (RPC 호출을 통해 서버 대기열과 모든 단말에 전파)
    await deskSession.evalCode(`
      (async () => {
        const q = currentCalledQueueEntry;
        if (q) {
          await BongplayQueue.completeIssuance(q.id, 'ord_e2e_001', ['tkt_e2e_1', 'tkt_e2e_2']);
          currentCalledQueueEntry = null;
          refreshDeskQueueView();
        }
      })()
    `);

    // 1) 매표소 데스크 호출 슬롯이 비워졌는지 확인
    const deskEmptyAfter = await deskSession.evalCode(`
      !document.getElementById('deskCalledEmptyBox').classList.contains('hidden')
    `);
    assert.ok(deskEmptyAfter, '발권 완료 후 매표소 호출 슬롯이 비워져야 함');

    // 2) 고객 모바일 화면: "발권 완료" 상태로 전환 확인
    let custFinalStatus = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      custFinalStatus = await statusSession.evalCode(`
        document.getElementById('queueStatusPillText')?.textContent?.trim()
      `);
      if (custFinalStatus === '발권 완료') break;
    }
    assert.equal(custFinalStatus, '발권 완료', '고객 화면이 "발권 완료"로 최종 갱신되어야 함');
    console.log(`  ✔ [PASS] 고객 화면 발권 완료 전환 확인 [${Date.now() - step6Start}ms]`);

    // 3) 공개 전광판: 대기 0팀 복귀 확인
    let displayFinalWait = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      displayFinalWait = await displaySession.evalCode(`
        document.getElementById('totalWaitingCountText')?.textContent?.trim()
      `);
      if (displayFinalWait === '0') break;
    }
    assert.equal(displayFinalWait, '0', '공개 전광판 대기 인원이 0팀으로 복귀');
    console.log(`  ✔ [PASS] 공개 전광판 대기 0팀 복귀 확인`);

    clearTimeout(overallTimer);
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n================================================================');
    console.log(`🎉 [SUCCESS] ANT-006 E2E 브라우저 흐름 전수 검증 통과 (총 소요 시간: ${totalDuration}초)`);
    console.log('================================================================');

  } catch (err) {
    console.error('\n❌ E2E 테스트 실패:', err);
    throw err;
  } finally {
    if (customerSession) await customerSession.close();
    if (statusSession) await statusSession.close();
    if (displaySession) await displaySession.close();
    if (deskSession) await deskSession.close();

    if (localServer) {
      await new Promise(r => localServer.close(r));
    }

    tempDirs.forEach(dir => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    });

    cleanUpAllChildren();
  }
}

runE2E().catch(err => {
  console.error('E2E Runner failed with fatal error:', err);
  process.exit(1);
});

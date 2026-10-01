const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browserExe = fs.existsSync(edgePath) ? edgePath : chromePath;

const HTTP_PORT = 4174;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'qa', 'evidence', 'ANT-001', 'screenshots');
const EVIDENCE_FILE = path.resolve(__dirname, '..', '..', 'docs', 'qa', 'evidence', 'ANT-001', 'browser_flow_evidence.txt');

// Track all child process PIDs for guaranteed cleanup
const activeChildPids = new Set();

let mockServerState = {
  schemaMigrated: true,
  consents: {},
  audits: [],
  closing: {}
};

function createLocalServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    const parsedUrl = new URL(req.url, BASE_URL);
    let reqPath = decodeURIComponent(parsedUrl.pathname);

    // Mock Supabase REST endpoints
    if (reqPath.startsWith('/mock-supabase/rest/v1/')) {
      const endpoint = reqPath.replace('/mock-supabase/rest/v1/', '');
      let bodyStr = '';
      req.on('data', chunk => bodyStr += chunk);
      req.on('end', () => {
        let body = null;
        try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}

        if (endpoint.startsWith('rpc/verify_staff_access')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(true));
        }

        if (endpoint.startsWith('safety_consents')) {
          if (req.method === 'GET') {
            const list = Object.values(mockServerState.consents);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(list));
          }
          if (req.method === 'PATCH' || req.method === 'POST') {
            if (!mockServerState.schemaMigrated && body && ('status' in body || 'cancelled_at' in body)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                code: 'PGRST204',
                message: "Could not find the 'status' column of 'safety_consents' in the schema cache"
              }));
            }
            const idMatch = parsedUrl.search.match(/id=eq\.([^&]+)/);
            const id = idMatch ? decodeURIComponent(idMatch[1]) : (body ? body.id : null);
            if (id) {
              mockServerState.consents[id] = Object.assign(mockServerState.consents[id] || { id }, body);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(mockServerState.consents[id] || body));
          }
        }

        if (endpoint.startsWith('safety_audits')) {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(mockServerState.audits));
          }
          if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
            if (body) mockServerState.audits.unshift(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(body));
          }
        }

        if (endpoint.startsWith('closing_records')) {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(Object.values(mockServerState.closing)));
          }
          if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
            if (body && body.date) mockServerState.closing[body.date] = body;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(body));
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      });
      return;
    }

    // Serve static files
    if (reqPath === '/') reqPath = '/01_봉플레이_운영시스템/index.html';
    else if (reqPath.endsWith('/config.js')) {
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
    } else {
      reqPath = '/01_봉플레이_운영시스템' + reqPath;
    }

    const filePath = path.join(process.cwd(), reqPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : (ext === '.js' ? 'application/javascript; charset=utf-8' : (ext === '.css' ? 'text/css' : 'text/plain'));
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found: ' + reqPath);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function launchBrowserSession(cdpPort, userDir, defaultWidth = 1440, defaultHeight = 900) {
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
    try { child.kill('SIGTERM'); } catch(e) {}
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
  const alertHandlers = [];
  const consoleLogs = [];
  const pageErrors = [];
  let sessionId = null;

  const rejectAllPending = (reason) => {
    for (const [id, req] of pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error(`WebSocket disconnected (${reason}) while waiting for CDP msg ${id}`));
    }
    pendingRequests.clear();
  };

  ws.addEventListener('close', () => rejectAllPending('close'));
  ws.addEventListener('error', (err) => rejectAllPending(err.message || 'error'));

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch(e) { return; }

    if (msg.id && pendingRequests.has(msg.id)) {
      const req = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
    }

    if (msg.method === 'Page.javascriptDialogOpening') {
      alertHandlers.forEach(h => h(msg.params));
      if (sessionId) {
        sendSession('Page.handleJavaScriptDialog', { accept: true }, 2000).catch(() => {});
      }
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value || a.description).join(' ');
      consoleLogs.push({ type: msg.params.type, text });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails);
    }
  });

  function send(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const targetRes = await send('Target.createTarget', { url: 'about:blank' });
  const attachRes = await send('Target.attachToTarget', { targetId: targetRes.targetId, flatten: true });
  sessionId = attachRes.sessionId;

  function sendSession(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`CDP session command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  }

  await sendSession('Page.enable');
  await sendSession('Runtime.enable');
  await sendSession('Network.enable');

  await sendSession('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__alerts = [];
      window.alert = function(msg) {
        console.log('[ALERT]', msg);
        window.__lastAlert = String(msg);
        window.__alerts.push(String(msg));
      };
      window.confirm = function(msg) {
        console.log('[CONFIRM]', msg);
        return true;
      };
    `
  });

  return {
    child,
    ws,
    sessionId,
    consoleLogs,
    pageErrors,
    onAlert(fn) { alertHandlers.push(fn); },
    async setViewport(width, height) {
      try {
        await sendSession('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width < 600
        }, 5000);
      } catch (e) {
        console.warn(`[Viewport warning] setDeviceMetricsOverride: ${e.message}`);
      }
    },
    async navigate(url, timeoutMs = 8000) {
      const loadPromise = new Promise(resolve => {
        const handler = (evt) => {
          const msg = JSON.parse(evt.data);
          if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.domContentEventFired') {
            ws.removeEventListener('message', handler);
            resolve();
          }
        };
        ws.addEventListener('message', handler);
      });
      await sendSession('Page.navigate', { url }, 6000);
      await Promise.race([
        loadPromise,
        new Promise(r => setTimeout(r, 2500))
      ]);
      const startWait = Date.now();
      while (Date.now() - startWait < 4000) {
        await new Promise(r => setTimeout(r, 100));
        try {
          const ready = await sendSession('Runtime.evaluate', {
            expression: 'document.readyState !== "loading"',
            returnByValue: true
          }, 1000);
          if (ready && ready.result && ready.result.value) break;
        } catch(e) {}
      }
    },
    async eval(expr, timeoutMs = 8000) {
      const res = await sendSession('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true
      }, timeoutMs);
      if (res && res.exceptionDetails) {
        throw new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      }
      return res && res.result ? res.result.value : undefined;
    },
    async screenshot(filePath, timeoutMs = 8000) {
      try {
        await new Promise(r => setTimeout(r, 150));
        const res = await sendSession('Page.captureScreenshot', { format: 'png' }, timeoutMs);
        if (res && res.data) {
          fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
          return true;
        }
      } catch (err) {
        console.warn(`[Screenshot Warning] captureScreenshot: ${err.message}`);
      }
      return false;
    },
    async close() {
      try { ws.close(); } catch(e) {}
      try { child.kill('SIGTERM'); } catch(e) {}
      activeChildPids.delete(child.pid);
    }
  };
}

async function withTimeout(fn, timeoutMs, stepName, session = null) {
  const startTime = Date.now();
  console.log(`[START] ${stepName} (timeout: ${timeoutMs}ms)`);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TIMEOUT: ${stepName} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timer);
    const elapsed = Date.now() - startTime;
    console.log(`[PASS]  ${stepName} (${elapsed}ms)`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - startTime;
    console.error(`[FAIL]  ${stepName} after ${elapsed}ms: ${err.message}`);
    if (session) {
      try {
        const errorShotPath = path.join(SCREENSHOT_DIR, 'diagnostic_error.png');
        await session.screenshot(errorShotPath, 2000);
      } catch (e) {}
      if (session.consoleLogs.length > 0) {
        console.error(`[DIAGNOSTIC] Console logs:`, session.consoleLogs.slice(-5));
      }
      if (session.pageErrors.length > 0) {
        console.error(`[DIAGNOSTIC] Page exceptions:`, session.pageErrors.slice(-3));
      }
    }
    throw err;
  }
}

async function runAllFlows() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const overallStart = Date.now();
  const evidenceRows = [];

  console.log('================================================================================');
  console.log('BEN-009 / BEN-011 실제 3대 업무 흐름 전수 E2E 검증 (독립 단말 세션 격리)');
  console.log('================================================================================');

  let server = null;
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  try {
    // -------------------------------------------------------------------------
    // Phase 0: HTTP Server & Smoke Test
    // -------------------------------------------------------------------------
    server = await withTimeout(async () => {
      return await createLocalServer();
    }, 5000, '단계 0-1: 로컬 모의 HTTP 서버 구동');

    console.log('\n--- [단계 0: 브라우저 유한 연결/종료 Smoke Test] ---');
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-smoke-'));
    const smokeSession = await withTimeout(async () => {
      const sess = await launchBrowserSession(9340, smokeDir);
      assert.ok(sess.child.pid > 0, '브라우저 프로세스 생성 확인');
      return sess;
    }, 8000, '단계 0-2: Smoke 브라우저 실행 및 CDP 연결');

    await withTimeout(async () => {
      await smokeSession.navigate('about:blank', 3000);
      const ready = await smokeSession.eval('document.readyState');
      assert.strictEqual(ready, 'complete', 'about:blank 로드 완료');
    }, 4000, '단계 0-3: Smoke about:blank 탐색 및 eval 응답');

    await smokeSession.close();
    try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch (e) {}
    console.log('[PASS]  단계 0-4: Smoke 세션 정상 종료 및 프로세스 회수 완료');
    evidenceRows.push({ step: '단계 0: Smoke Test', result: 'PASS', detail: '브라우저 연결 → about:blank 탐색 → 유한 정상 종료 검증 완료' });

    // -------------------------------------------------------------------------
    // SCENARIO 1: 안전점검 → POS (POS 카운터 단말)
    // -------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log('SCENARIO 1: 안전점검 → POS 결제 인터록 및 중복 연타 가드 검증');
    console.log('================================================================================');

    const tempPOS = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-pos-'));
    let posSession = null;
    try {
      posSession = await withTimeout(async () => {
        return await launchBrowserSession(9341, tempPOS, 390, 844);
      }, 8000, '단계 1-1: POS 단말 브라우저 세션 초기화');

      // 1-2. Mobile Viewport operations.html with today fail audit
      await withTimeout(async () => {
        await posSession.navigate(`${BASE_URL}/pages/operations.html`, 8000);

        const failedAudits = [
          { audit_date: todayStr, audit_at: `${todayStr}T09:00:00Z`, decision: 'pass', facility_id: 'all_facilities' },
          { audit_date: todayStr, audit_at: `${todayStr}T11:00:00Z`, decision: 'fail', facility_id: 'all_facilities' }
        ];
        await posSession.eval(`
          localStorage.setItem('bongplay_safety_audit_logs', JSON.stringify(${JSON.stringify(failedAudits)}));
          localStorage.removeItem('bongplay_orders_v2');
          localStorage.removeItem('bongplay_order_items');
          localStorage.removeItem('bongplay_order_payments');
          checkSafetyInterlock();
        `);

        const isBlocked = await posSession.eval(`
          (!isSafetyInspectionPassed) && (!document.getElementById('safetyInterlockBanner').classList.contains('hidden'))
        `);
        assert.ok(isBlocked, '최신 fail 점검 시 안전 인터록 차단 및 배너 노출 확인');

        // Attempt payment while blocked
        await posSession.eval(`
          adjustPosItem('tkt_basic', 1);
          posAllocRemainTo('card');
          submitPosOrder();
        `);

        const orderCountBefore = await posSession.eval(`
          JSON.parse(localStorage.getItem('bongplay_order_items') || '[]').length
        `);
        assert.strictEqual(orderCountBefore, 0, '부적합 시 주문 원장 미생성(0건) 확인');
      }, 15000, '단계 1-2: 당일 부적합 인터록 차단 및 주문/수납 원장 0건 확인', posSession);
      evidenceRows.push({ step: '시나리오 1: 인터록 차단', result: 'PASS', detail: '당일 최신 fail 점검 시 결제 시도 차단 및 원장 0건 유지' });

      // 1-3. Navigate to safety-check.html, record official pass, save
      await withTimeout(async () => {
        await posSession.navigate(`${BASE_URL}/pages/safety-check.html`, 8000);
        await posSession.eval(`
          document.getElementById('inspectorName').value = '홍성현';
          document.getElementById('managerName').value = '홍성현';
          activeInspectionItems().forEach(item => {
            currentChecklist[item.id] = 'pass';
          });
          const passRadio = document.querySelector('input[name="finalDecision"][value="pass"]');
          if (passRadio) passRadio.checked = true;
          setSignatureData('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
          saveChecklist();
        `);

        const latestDecision = await posSession.eval(`
          JSON.parse(localStorage.getItem('bongplay_safety_audit_logs') || '[]')[0]?.decision
        `);
        assert.strictEqual(latestDecision, 'pass', '점검 일지 실제 화면 저장 후 최신 pass 판정 확인');
      }, 12000, '단계 1-3: safety-check.html 정상 재점검 및 서명 저장', posSession);
      evidenceRows.push({ step: '시나리오 1: 점검일지 합격 저장', result: 'PASS', detail: 'safety-check.html 실제 점검일지 전 항목 pass 및 서명 저장 확인' });

      // 1-4. Return to operations.html in Desktop viewport (1440x900)
      await withTimeout(async () => {
        await posSession.setViewport(1440, 900);
        await posSession.navigate(`${BASE_URL}/pages/operations.html`, 8000);

        const isPassed = await posSession.eval(`
          isSafetyInspectionPassed && document.getElementById('safetyInterlockBanner').classList.contains('hidden')
        `);
        assert.ok(isPassed, '정상 재점검 후 POS 인터록 해제 및 배너 숨김 확인');

        // Make payment and test 5 rapid clicks debounce guard
        await posSession.eval(`
          adjustPosItem('tkt_basic', 1);
          posAllocRemainTo('card');
          submitPosOrder();
          submitPosOrder();
          submitPosOrder();
          submitPosOrder();
          submitPosOrder();
        `);

        const orderCountAfter = await posSession.eval(`
          JSON.parse(localStorage.getItem('bongplay_order_items') || '[]').length
        `);
        assert.strictEqual(orderCountAfter, 1, '발권 완료 및 5회 연타 시 중복 방지 확인 (원장 정확히 1건)');

        await posSession.screenshot(path.join(SCREENSHOT_DIR, 'scenario1_pos_success.png'), 5000);
      }, 15000, '단계 1-4: POS 인터록 해제 및 5회 연타 시 중복 방지(원장 1건) 검증', posSession);
      evidenceRows.push({ step: '시나리오 1: POS 발권 및 연타 가드', result: 'PASS', detail: '인터록 해제 후 정상 발권 및 5회 연타 시 정확히 1건만 원장 생성' });

    } finally {
      if (posSession) await posSession.close();
      try { fs.rmSync(tempPOS, { recursive: true, force: true }); } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // SCENARIO 2: 입장 → 취소 → 퇴장 및 단말 B 모의 서버 동기화
    // -------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log('SCENARIO 2: 입장 → 취소 → 퇴장 및 단말 B 모의 서버 동기화 검증');
    console.log('================================================================================');

    const consentFamilyId = 'FAM_SYNTH_001';
    const syntheticConsent = {
      id: consentFamilyId,
      created_at: `${todayStr}T10:00:00Z`,
      created_date: todayStr,
      guardian_name: '홍길동',
      guardian_phone: '010-1234-5678',
      children: [{ name: '홍아이', age: 7 }],
      is_issued: true,
      issued_at: `${todayStr}T10:05:00Z`,
      status: 'active',
      entry_at: null,
      exit_at: null
    };
    mockServerState.consents[consentFamilyId] = { ...syntheticConsent };

    const tempGateA = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-gate-a-'));
    const tempGateB = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-gate-b-'));
    let gateSessionA = null;
    let gateSessionB = null;

    try {
      gateSessionA = await withTimeout(async () => {
        return await launchBrowserSession(9342, tempGateA, 390, 844);
      }, 8000, '단계 2-0: Gate 단말 A 브라우저 세션 초기화');

      // 2-1. Navigate to gate.html on Terminal A and perform Entry
      await withTimeout(async () => {
        await gateSessionA.navigate(`${BASE_URL}/pages/gate.html`, 10000);

        for (let i = 0; i < 40; i++) {
          const ready = await gateSessionA.eval(`typeof loadData !== 'undefined' && typeof processScanCode !== 'undefined'`).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 200));
        }

        await gateSessionA.eval(`
          (async () => {
            localStorage.setItem('bongplay_safety_consents', JSON.stringify([${JSON.stringify(syntheticConsent)}]));
            localStorage.setItem('bongplay_inside_tickets_v1', JSON.stringify([]));
            await loadData();
            processScanCode('${consentFamilyId}');
          })()
        `);

        const gateBtnText = await gateSessionA.eval(`
          document.querySelector('button[onclick*="executeGateAction"]')?.innerText.trim()
        `);
        assert.ok(gateBtnText.includes('입장하기 (2명)'), '발권 상태 2명 입장하기 버튼 표시 확인');

        // Click actual entry button
        await gateSessionA.eval(`
          document.querySelector('button[onclick*="executeGateAction"]').click();
        `);
        await new Promise(r => setTimeout(r, 400));

        const insideCount = await gateSessionA.eval(`
          parseInt(document.getElementById('currentInsideCount').innerText, 10)
        `);
        assert.strictEqual(insideCount, 2, '입장 처리 후 체류 인원 2명 반영 확인');

        await gateSessionA.screenshot(path.join(SCREENSHOT_DIR, 'scenario2_gate_inside.png'), 5000);
      }, 15000, '단계 2-1: gate.html 입장 처리 및 체류 인원 2명 반영 확인', gateSessionA);
      evidenceRows.push({ step: '시나리오 2: 게이트 입장', result: 'PASS', detail: '실제 입장 버튼 클릭으로 체류 인원 2명 반영 확인' });

      // 2-2. Cancellation with unmigrated schema (returns 400, held in outbox)
      await withTimeout(async () => {
        mockServerState.schemaMigrated = false;

        const patchResult = await gateSessionA.eval(`
          (async () => {
            return await BongplaySync.patch('safety_consents', '${consentFamilyId}', {
              status: 'cancelled',
              is_issued: false
            });
          })()
        `);
        assert.strictEqual(patchResult.ok, false, '미적용 스키마 400 시 ok: false 반환 확인');
        assert.strictEqual(patchResult.schema_blocked, true, 'schema_blocked: true 확인');
        assert.strictEqual(patchResult.queued, true, 'queued: true 아웃박스 적재 확인');

        const pendingCount = await gateSessionA.eval(`BongplaySync.getPendingCount()`);
        assert.strictEqual(pendingCount, 1, '스키마 미반영 시 큐 삭제 없이 1건 보존 확인');

        // Verify gate still maintains inside count 2 and shows inside cancelled badge
        await gateSessionA.eval(`
          (async () => {
            await loadData();
            processScanCode('${consentFamilyId}');
          })()
        `);
        const insideCountMaintained = await gateSessionA.eval(`
          parseInt(document.getElementById('currentInsideCount').innerText, 10)
        `);
        assert.strictEqual(insideCountMaintained, 2, '취소 후에도 실제 퇴장 전까지 체류 인원 2명 유지 확인');

        await gateSessionA.screenshot(path.join(SCREENSHOT_DIR, 'scenario2_gate_cancelled_inside.png'), 5000);
      }, 12000, '단계 2-2: 스키마 미적용 400 시 아웃박스 1건 보존 및 체류 2명 유지 확인', gateSessionA);
      evidenceRows.push({ step: '시나리오 2: 취소 시 아웃박스 보존 및 체류 유지', result: 'PASS', detail: '400 에러 시 큐 보존(pending: 1) 및 실제 퇴장 전까지 체류 2명 유지' });

      // 2-3. Schema recovery, flush outbox, and execute Exit
      await withTimeout(async () => {
        mockServerState.schemaMigrated = true;

        const flushResult = await gateSessionA.eval(`
          (async () => {
            return await BongplaySync.flushOutbox();
          })()
        `);
        const pendingCountAfter = await gateSessionA.eval(`BongplaySync.getPendingCount()`);
        assert.strictEqual(pendingCountAfter, 0, '스키마 복구 후 flush 성공 및 큐 0건 해소 확인');
        assert.strictEqual(mockServerState.consents[consentFamilyId].status, 'cancelled', '모의 서버로 status: cancelled 전달 확인');

        // Click actual exit button on Terminal A
        await gateSessionA.eval(`
          document.querySelector('button[onclick*="executeGateAction"]').click();
        `);
        await new Promise(r => setTimeout(r, 400));

        const insideCountAfterExit = await gateSessionA.eval(`
          parseInt(document.getElementById('currentInsideCount').innerText, 10)
        `);
        assert.strictEqual(insideCountAfterExit, 0, '퇴장 처리 후 체류 인원 0명 반영 확인');

        await gateSessionA.screenshot(path.join(SCREENSHOT_DIR, 'scenario2_gate_exit_done.png'), 5000);
      }, 12000, '단계 2-3: 스키마 복구 후 아웃박스 해소 및 실제 퇴장(체류 0명) 완료', gateSessionA);
      evidenceRows.push({ step: '시나리오 2: 스키마 복구 및 퇴장 처리', result: 'PASS', detail: 'flushOutbox로 큐 해소(pending: 0) 및 퇴장 버튼 클릭으로 체류 0명 반영' });

      // 2-4. Terminal B (independent browser profile/storage) pulls from mock server
      await withTimeout(async () => {
        console.log('  [2-4] Launching Terminal B (independent browser profile/storage)...');
        gateSessionB = await launchBrowserSession(9343, tempGateB, 1440, 900);
        await gateSessionB.navigate(`${BASE_URL}/pages/gate.html`, 10000);

        for (let i = 0; i < 40; i++) {
          const ready = await gateSessionB.eval(`typeof BongplaySync !== 'undefined' && typeof BongplaySync.pullAll === 'function'`).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 200));
        }

        // Terminal B pulls all from server without local pre-injection
        const termBPulledStatus = await gateSessionB.eval(`
          (async () => {
            const pullRes = await BongplaySync.pullAll();
            const consents = JSON.parse(localStorage.getItem('bongplay_safety_consents') || '[]');
            const target = consents.find(c => c.id === '${consentFamilyId}');
            return target ? target.status : null;
          })()
        `);
        assert.strictEqual(termBPulledStatus, 'cancelled', '단말 B가 모의 서버로부터 취소 상태(cancelled) 수신 확인 (단말 B 선주입 없음)');
      }, 15000, '단계 2-4: 독립 단말 B의 pullAll을 통한 취소 상태 정상 수신 검증', gateSessionB);
      evidenceRows.push({ step: '시나리오 2: 독립 단말 B 동기화', result: 'PASS', detail: '격리된 별도 브라우저 단말 B가 pullAll()로 서버 취소 상태(cancelled) 정상 수신' });

    } finally {
      if (gateSessionA) await gateSessionA.close();
      if (gateSessionB) await gateSessionB.close();
      try { fs.rmSync(tempGateA, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(tempGateB, { recursive: true, force: true }); } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // SCENARIO 3: 마감 A → 빈 B → A (마감 정산 단말)
    // -------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log('SCENARIO 3: 마감 A(확정/잠금) → 빈 B(초안) → A(복원) 날짜 전환 격리');
    console.log('================================================================================');

    const dateA = '2026-09-28';
    const dateB = '2026-09-29';

    const recordA = {
      id: dateA,
      date: dateA,
      manager: '홍성현',
      notes: 'A일 마감 확정 완료 - 특이사항 없음',
      is_locked: true,
      locked_at: `${dateA}T21:00:00Z`,
      cash: {
        base: 100000,
        sales: 250000,
        exp: 45000,
        c50k: 5,
        c10k: 5,
        c5k: 1,
        c1k: 0,
        cCoin: 0
      },
      voucher: {
        v10k: 2,
        v5k: 0,
        etc: 0
      }
    };
    mockServerState.closing[dateA] = recordA;

    const tempClosing = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-closing-'));
    let closingSession = null;

    try {
      closingSession = await withTimeout(async () => {
        return await launchBrowserSession(9344, tempClosing, 1440, 900);
      }, 8000, '단계 3-0: 마감 정산 단말 브라우저 세션 초기화');

      // 3-1. Load Date A in closing.html
      await withTimeout(async () => {
        await closingSession.navigate(`${BASE_URL}/pages/closing.html`, 10000);

        for (let i = 0; i < 40; i++) {
          const ready = await closingSession.eval(`typeof loadSavedData !== 'undefined'`).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 200));
        }

        await closingSession.eval(`
          localStorage.setItem('bongplay_closing_records_history', JSON.stringify([${JSON.stringify(recordA)}]));
          document.getElementById('closingDate').value = '${dateA}';
          loadSavedData();
        `);

        const isLockedA = await closingSession.eval(`document.getElementById('btnSaveClosing').disabled`);
        const expA = await closingSession.eval(`document.getElementById('cashExpenses').value`);
        const notesA = await closingSession.eval(`document.getElementById('handoverNotes').value`);

        assert.strictEqual(isLockedA, true, 'A일 확정 기록 버튼 잠금(disabled: true) 확인');
        assert.strictEqual(expA, '45000', 'A일 지출 45,000원 렌더링 확인');
        assert.strictEqual(notesA, 'A일 마감 확정 완료 - 특이사항 없음', 'A일 메모 보존 확인');

        await closingSession.screenshot(path.join(SCREENSHOT_DIR, 'scenario3_closing_dateA_locked.png'), 5000);
      }, 12000, '단계 3-1: A일 확정 기록 조회 및 잠금(disabled) 확인', closingSession);
      evidenceRows.push({ step: '시나리오 3: A일 확정 잠금', result: 'PASS', detail: 'A일 확정 기록 버튼 disabled=true, 지출 45,000원 및 메모 잠금 확인' });

      // 3-2. Switch to unrecorded Date B
      await withTimeout(async () => {
        await closingSession.eval(`
          document.getElementById('closingDate').value = '${dateB}';
          loadSavedData();
        `);

        const isLockedB = await closingSession.eval(`document.getElementById('btnSaveClosing').disabled`);
        const expB = await closingSession.eval(`document.getElementById('cashExpenses').value`);
        const notesB = await closingSession.eval(`document.getElementById('handoverNotes').value`);

        assert.strictEqual(isLockedB, false, '빈 B일 잠금 해제 확인');
        assert.strictEqual(expB, '0', '빈 B일에 A일 지출 누수 없이 0원 초기화 확인');
        assert.strictEqual(notesB, '', '빈 B일에 A일 메모 누수 없이 빈 문자열 초기화 확인');

        // Enter draft on Date B
        await closingSession.eval(`
          document.getElementById('cashExpenses').value = '12000';
          document.getElementById('handoverNotes').value = 'B일 현장 비품비 임시 지출';
        `);

        await closingSession.screenshot(path.join(SCREENSHOT_DIR, 'scenario3_closing_dateB_draft.png'), 5000);
      }, 12000, '단계 3-2: 빈 B일 전환 시 A일 시재 누수 차단 및 초안 입력 확인', closingSession);
      evidenceRows.push({ step: '시나리오 3: 빈 B일 시재 격리', result: 'PASS', detail: 'B일 이동 시 A일 지출·메모 누수 없이 0원 초기화 및 초안 입력 확인' });

      // 3-3. Switch back to Date A without saving B, then return to Date B to verify draft restore
      await withTimeout(async () => {
        // Switch back to Date A
        await closingSession.eval(`
          document.getElementById('closingDate').value = '${dateA}';
          loadSavedData();
        `);
        const isLockedARevisited = await closingSession.eval(`document.getElementById('btnSaveClosing').disabled`);
        const expARevisited = await closingSession.eval(`document.getElementById('cashExpenses').value`);
        assert.strictEqual(isLockedARevisited, true, 'A일 재진입 시 잠금 유지 확인');
        assert.strictEqual(expARevisited, '45000', 'A일 재진입 시 지출 45,000원 보존 (B일 데이터 혼입 없음)');

        // Switch back to Date B to verify draft restored
        await closingSession.eval(`
          document.getElementById('closingDate').value = '${dateB}';
          loadSavedData();
        `);
        const expBRestored = await closingSession.eval(`document.getElementById('cashExpenses').value`);
        const notesBRestored = await closingSession.eval(`document.getElementById('handoverNotes').value`);
        assert.strictEqual(expBRestored, '12000', 'B일 복귀 시 미저장 초안 지출 12,000원 복원 확인');
        assert.strictEqual(notesBRestored, 'B일 현장 비품비 임시 지출', 'B일 복귀 시 미저장 초안 메모 복원 확인');

        // Click actual save button for Date B
        await closingSession.eval(`
          document.getElementById('btnSaveClosing').click();
        `);
        await new Promise(r => setTimeout(r, 400));

        const savedHistoryB = await closingSession.eval(`
          JSON.parse(localStorage.getItem('bongplay_closing_records_history') || '[]').find(r => r.date === '${dateB}')
        `);
        assert.ok(savedHistoryB, 'B일 실제 저장 버튼 클릭 후 마감 기록 저장 확인');
        assert.strictEqual(savedHistoryB.cash.exp, 12000, '저장된 B일 지출 12,000원 확인');

        await closingSession.screenshot(path.join(SCREENSHOT_DIR, 'scenario3_closing_dateB_saved.png'), 5000);
      }, 15000, '단계 3-3: A일 복귀 시 격리 유지, B일 복귀 시 초안 복원 및 저장 완료 검증', closingSession);
      evidenceRows.push({ step: '시나리오 3: 초안 복원 및 저장', result: 'PASS', detail: 'A일 복귀 시 B일 데이터 미혼입, B일 재진입 시 초안 복원 및 실제 마감 저장 완료' });

    } finally {
      if (closingSession) await closingSession.close();
      try { fs.rmSync(tempClosing, { recursive: true, force: true }); } catch (e) {}
    }

    const totalElapsed = Date.now() - overallStart;
    console.log('\n================================================================================');
    console.log(`[ALL 3 SCENARIOS PASSED 100%] 총 소요 시간: ${totalElapsed}ms`);
    console.log('================================================================================');

    // Write evidence text file
    const evidenceContent = [
      '================================================================================',
      'BEN-009 / BEN-011 END-TO-END BROWSER WORKFLOW VERIFICATION EVIDENCE (ANT-001)',
      `Engine: ${browserExe}`,
      `Execution Date: ${new Date().toISOString()}`,
      `Total Elapsed: ${totalElapsed}ms`,
      '================================================================================',
      '',
      '| 단계 | 검증 항목 | 판정 | 실측 상세 |',
      '| :--- | :--- | :---: | :--- |',
      ...evidenceRows.map(r => `| ${r.step} | ${r.step} | ${r.result} | ${r.detail} |`),
      '',
      'Screenshot Artifacts Generated:',
      '- docs/qa/evidence/ANT-001/screenshots/scenario1_pos_success.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario2_gate_inside.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario2_gate_cancelled_inside.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario2_gate_exit_done.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario3_closing_dateA_locked.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario3_closing_dateB_draft.png',
      '- docs/qa/evidence/ANT-001/screenshots/scenario3_closing_dateB_saved.png',
      ''
    ].join('\n');
    fs.writeFileSync(EVIDENCE_FILE, evidenceContent, 'utf8');
    console.log(`[EVIDENCE] Verification evidence file written: ${EVIDENCE_FILE}`);

  } finally {
    console.log('\n[CLEANUP] 테스트 리소스 및 자식 프로세스 정리 시작...');
    for (const pid of activeChildPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {}
    }
    activeChildPids.clear();

    if (server) {
      server.close();
      console.log('[CLEANUP] 로컬 모의 HTTP 서버 종료 완료.');
    }
    console.log('[CLEANUP] 전체 자원 정리 완료.');
  }
}

runAllFlows().catch(err => {
  console.error('\n[FATAL TEST FAILURE]:', err.message);
  process.exit(1);
});

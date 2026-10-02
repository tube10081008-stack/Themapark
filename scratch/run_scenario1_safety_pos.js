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
const SCREENSHOT_DIR = path.join(process.cwd(), 'docs', 'qa', 'evidence', 'ANT-001', 'screenshots');

let mockServerState = {
  audits: []
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

async function launchBrowserSession(cdpPort, userDir) {
  const child = spawn(browserExe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    'about:blank'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

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
    child.kill('SIGTERM');
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

  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pendingRequests.has(msg.id)) {
      const cb = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      cb(msg);
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      alertHandlers.forEach(h => h(msg.params));
      send('Page.handleJavaScriptDialog', { accept: true });
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map(a => a.value || a.description).join(' ');
      consoleLogs.push({ type: msg.params.type, text });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      pendingRequests.set(id, (msg) => resolve(msg.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  const targetRes = await send('Target.createTarget', { url: 'about:blank' });
  const attachRes = await send('Target.attachToTarget', { targetId: targetRes.targetId, flatten: true });
  const sessionId = attachRes.sessionId;

  function sendSession(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      pendingRequests.set(id, (msg) => resolve(msg.result));
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
      await sendSession('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600
      });
    },
    async navigate(url, timeoutMs = 8000) {
      const loadPromise = new Promise(resolve => {
        const handler = (evt) => {
          const msg = JSON.parse(evt.data);
          if (msg.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', handler);
            resolve();
          }
        };
        ws.addEventListener('message', handler);
      });
      await sendSession('Page.navigate', { url });
      await Promise.race([
        loadPromise,
        new Promise(r => setTimeout(r, Math.min(timeoutMs, 4000)))
      ]);
      // Wait until document.readyState === 'complete'
      const startWait = Date.now();
      while (Date.now() - startWait < timeoutMs) {
        await new Promise(r => setTimeout(r, 150));
        try {
          const ready = await sendSession('Runtime.evaluate', {
            expression: 'document.readyState === "complete"',
            returnByValue: true
          });
          if (ready && ready.result && ready.result.value) break;
        } catch(e) {}
      }
    },
    async eval(expr) {
      const res = await sendSession('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true
      });
      if (res && res.exceptionDetails) {
        throw new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
      }
      return res && res.result ? res.result.value : undefined;
    },
    async screenshot(filePath) {
      const res = await sendSession('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch(e) {}
      try { child.kill('SIGTERM'); } catch(e) {}
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
    console.log(`[PASS] ${stepName} (${elapsed}ms)`);
    return result;
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - startTime;
    console.error(`[FAIL] ${stepName} after ${elapsed}ms: ${err.message}`);
    if (session) {
      try {
        const errorShotPath = path.join(SCREENSHOT_DIR, 'scenario1_error.png');
        await session.screenshot(errorShotPath);
        console.log(`[DIAGNOSTIC] Screenshot saved: ${errorShotPath}`);
      } catch (e) {
        console.error(`[DIAGNOSTIC] Failed to capture error screenshot:`, e.message);
      }
      if (session.consoleLogs.length > 0) {
        console.error(`[DIAGNOSTIC] Browser console logs:`, session.consoleLogs.slice(-10));
      }
      if (session.pageErrors.length > 0) {
        console.error(`[DIAGNOSTIC] Page exceptions:`, session.pageErrors.slice(-5));
      }
    }
    throw err;
  }
}

async function main() {
  const overallStart = Date.now();
  console.log('================================================================');
  console.log('BEN-009 시나리오 1: 안전점검 → POS 인터록 및 중복 연타 방지 단독 검증');
  console.log('================================================================');
  console.log(`[PROCESS INFO] Master PID: ${process.pid}`);

  let server = null;
  let session = null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-scen1-'));

  try {
    // 1. Launch HTTP Server
    server = await withTimeout(async () => {
      return await createLocalServer();
    }, 5000, '단계 1-1: 로컬 모의 HTTP 서버 구동');

    // 2. Launch Browser Session
    session = await withTimeout(async () => {
      const sess = await launchBrowserSession(9341, tempDir);
      console.log(`[PROCESS INFO] Browser Child PID: ${sess.child.pid}`);
      return sess;
    }, 10000, '단계 1-2: CDP 브라우저 세션 초기화');

    const todayStr = new Date().toISOString().slice(0, 10);
    const alerts = [];
    session.onAlert(p => {
      alerts.push(p.message);
      console.log(`  [Alert]: ${p.message.slice(0, 80).replace(/\n/g, ' ')}`);
    });

    // 3. Navigate to operations.html in Mobile viewport
    await withTimeout(async () => {
      await session.setViewport(390, 844);
      await session.navigate(`${BASE_URL}/pages/operations.html`, 8000);
      const isLoaded = await session.eval(`typeof checkSafetyInterlock !== 'undefined'`);
      assert.ok(isLoaded, 'operations.html 스크립트 로드 완료');
    }, 10000, '단계 1-3: operations.html 모바일(390x844) 진입', session);

    // 4. Inject fail audit and test interlock blocking
    await withTimeout(async () => {
      const failedAudits = [
        { audit_date: todayStr, audit_at: `${todayStr}T09:00:00Z`, decision: 'pass', facility_id: 'all_facilities' },
        { audit_date: todayStr, audit_at: `${todayStr}T11:00:00Z`, decision: 'fail', facility_id: 'all_facilities' }
      ];
      await session.eval(`
        localStorage.setItem('bongplay_safety_audit_logs', JSON.stringify(${JSON.stringify(failedAudits)}));
        localStorage.removeItem('bongplay_orders_v2');
        localStorage.removeItem('bongplay_order_items');
        localStorage.removeItem('bongplay_order_payments');
        checkSafetyInterlock();
      `);

      const isBlocked = await session.eval(`
        (!isSafetyInspectionPassed) && (!document.getElementById('safetyInterlockBanner').classList.contains('hidden'))
      `);
      assert.ok(isBlocked, '최신 fail 점검 시 안전 인터록 차단 및 배너 노출 확인');

      // Attempt payment
      await session.eval(`
        adjustPosItem('tkt_basic', 1);
        posAllocRemainTo('card');
        submitPosOrder();
      `);

      const orderCount = await session.eval(`
        JSON.parse(localStorage.getItem('bongplay_order_items') || '[]').length
      `);
      assert.strictEqual(orderCount, 0, '부적합 시 주문 원장 미생성(0건) 확인');
    }, 8000, '단계 1-4: 당일 부적합 인터록 차단 및 주문/수납 0건 확인', session);

    // 5. Navigate to safety-check.html and record official pass
    await withTimeout(async () => {
      await session.navigate(`${BASE_URL}/pages/safety-check.html`, 8000);
      await session.eval(`
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

      const latestDecision = await session.eval(`
        JSON.parse(localStorage.getItem('bongplay_safety_audit_logs') || '[]')[0]?.decision
      `);
      assert.strictEqual(latestDecision, 'pass', '점검 일지 실제 화면 저장 후 최신 pass 판정 확인');
    }, 8000, '단계 1-5: safety-check.html 정상 재점검 및 서명 저장', session);

    // 6. Return to operations.html in Desktop viewport
    await withTimeout(async () => {
      await session.setViewport(1440, 900);
      await session.navigate(`${BASE_URL}/pages/operations.html`, 8000);

      const isPassed = await session.eval(`
        isSafetyInspectionPassed && document.getElementById('safetyInterlockBanner').classList.contains('hidden')
      `);
      assert.ok(isPassed, '정상 재점검 후 POS 인터록 해제 및 배너 숨김 확인');
    }, 10000, '단계 1-6: 데스크톱(1440x900) 복귀 및 인터록 해제 확인', session);

    // 7. POS ticket issuance and 5 rapid clicks debounce guard
    await withTimeout(async () => {
      await session.eval(`
        adjustPosItem('tkt_basic', 1);
        posAllocRemainTo('card');
        submitPosOrder();
        submitPosOrder();
        submitPosOrder();
        submitPosOrder();
        submitPosOrder();
      `);

      const orderCountAfter = await session.eval(`
        JSON.parse(localStorage.getItem('bongplay_order_items') || '[]').length
      `);
      assert.strictEqual(orderCountAfter, 1, '발권 완료 및 연타 중복 방지 확인 (원장 정확히 1건)');

      // Capture success screenshot
      const successShotPath = path.join(SCREENSHOT_DIR, 'scenario1_pos_success.png');
      await session.screenshot(successShotPath);
      console.log(`[EVIDENCE] Success screenshot saved: ${successShotPath}`);
    }, 8000, '단계 1-7: 정상 발권 및 5회 연타 시 중복 방지(원장 정확히 1건) 검증', session);

    const totalElapsed = Date.now() - overallStart;
    console.log('================================================================');
    console.log(`[ALL PASSED] 시나리오 1 전체 단계 100% 정상 통과 (총 소요 시간: ${totalElapsed}ms)`);
    console.log('================================================================');

  } finally {
    console.log('[CLEANUP] 프로세스 및 리소스 격리 정리 시작...');
    if (session) {
      await session.close();
      console.log('[CLEANUP] 브라우저 세션 및 자식 프로세스 종료 완료.');
    }
    if (server) {
      server.close();
      console.log('[CLEANUP] 로컬 모의 HTTP 서버 종료 완료.');
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('[CLEANUP] 임시 프로필 폴더 삭제 완료.');
    } catch (e) {}
    console.log('[CLEANUP] 정리 작업 완료.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});

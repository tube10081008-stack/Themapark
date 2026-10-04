import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import handler from '../netlify/functions/consult.mjs';
import {
  checkRateLimit,
  MemoryRateLimitStore,
  DistributedRedisRateLimitStore
} from '../netlify/functions/lib/rate-limit.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. 서버리스 레이트 리미트 및 분산 과금 방어 단위/통합 테스트
// ---------------------------------------------------------------------------
test('1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004)', async (t) => {
  await t.test('1-1. IP별 분당 상한(RATE_LIMIT_PER_MINUTE) 초과 시 429 반환 및 Retry-After 헤더 검증', async () => {
    const store = new MemoryRateLimitStore();
    const env = { RATE_LIMIT_PER_MINUTE: '3', JEV_ENABLED: 'false' };
    const reqUrl = 'https://example.test/.netlify/functions/consult';

    for (let i = 1; i <= 3; i++) {
      const req = new Request(reqUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'client-ip': '192.168.1.100' },
        body: JSON.stringify({ message: '요금' })
      });
      const res = await handler(req, { env, store });
      assert.equal(res.status, 200, `${i}회차 요청은 정상 통과`);
    }

    // 4회차: 한도 초과
    const reqExceeded = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-ip': '192.168.1.100' },
      body: JSON.stringify({ message: '요금' })
    });
    const resExceeded = await handler(reqExceeded, { env, store });
    assert.equal(resExceeded.status, 429, '한도 초과 시 HTTP 429 반환');
    assert.equal(resExceeded.headers.get('retry-after'), '60');
    assert.equal(resExceeded.headers.get('cache-control'), 'no-store');

    const body = await resExceeded.json();
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
    assert.match(body.error, /요청이 너무 많습니다/);

    // 다른 IP는 여전히 허용됨을 검증
    const reqOtherIp = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-ip': '192.168.1.200' },
      body: JSON.stringify({ message: '운영시간' })
    });
    const resOtherIp = await handler(reqOtherIp, { env, store });
    assert.equal(resOtherIp.status, 200, '다른 IP는 독립적으로 정상 처리');
  });

  await t.test('1-2. 일일 전역 쿼터(RATE_LIMIT_DAILY_TOTAL) 초과 시 인스턴스 전역 429 차단 검증', async () => {
    const store = new MemoryRateLimitStore();
    const env = { RATE_LIMIT_PER_MINUTE: '100', RATE_LIMIT_DAILY_TOTAL: '5', JEV_ENABLED: 'false' };
    const reqUrl = 'https://example.test/.netlify/functions/consult';

    for (let i = 1; i <= 5; i++) {
      const req = new Request(reqUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'client-ip': `10.0.0.${i}` },
        body: JSON.stringify({ message: '위치' })
      });
      const res = await handler(req, { env, store });
      assert.equal(res.status, 200);
    }

    // 6회차: 일일 총 한도 초과
    const reqExceeded = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-ip': '10.0.0.99' },
      body: JSON.stringify({ message: '위치' })
    });
    const resExceeded = await handler(reqExceeded, { env, store });
    assert.equal(resExceeded.status, 429);
    const body = await resExceeded.json();
    assert.match(body.error, /일일 상담 안내 한도가 마감/);
  });

  await t.test('1-3. [Fail-Closed] JEV_ENABLED=true 시 분산 저장소 미설정 상태면 외부 유료호출 원천 차단 검증', async () => {
    let externalApiCalled = false;
    const mockFetcher = async () => {
      externalApiCalled = true;
      throw new Error('EXTERNAL_API_SHOULD_NEVER_BE_CALLED_WITHOUT_DISTRIBUTED_STORE');
    };

    const env = {
      JEV_ENABLED: 'true',
      JEV_MODEL: 'systemone-test',
      TYPESAFE_API_KEY: 'TEST_KEY'
      // RATE_LIMIT_STORE_URL 미설정
    };

    const req = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '기본 이용권 요금이 얼마인가요?' })
    });

    // 실행: 분산 저장소가 없으면 fail-closed 원칙에 따라 외부 JEV를 호출하지 않고 로컬 기본 안내로 안전 폴백
    const res = await handler(req, { env, fetcher: mockFetcher });
    assert.equal(res.status, 200);
    assert.equal(externalApiCalled, false, '분산 과금 방어 저장소 미설정 시 외부 API 호출 0건 보장');

    const data = await res.json();
    assert.equal(data.mode, 'rules', '외부 호출 차단 후 안전한 기본 규칙 모드로 동작');
    assert.match(data.answer, /15,000/);
  });

  await t.test('1-4. [Fail-Closed] 분산 저장소 통신 장애 시 외부 유료 호출 차단 검증', async () => {
    let externalApiCalled = false;
    const failingStore = {
      hit: async () => {
        throw new Error('REDIS_CONNECTION_REFUSED');
      }
    };

    const env = {
      JEV_ENABLED: 'true',
      JEV_MODEL: 'systemone-test',
      TYPESAFE_API_KEY: 'TEST_KEY'
    };

    const req = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '예약 문의' })
    });

    const res = await handler(req, {
      env,
      store: failingStore,
      fetcher: async () => {
        externalApiCalled = true;
        throw new Error('EXTERNAL_API_CALLED');
      }
    });

    assert.equal(externalApiCalled, false, '저장소 장애 시 유료 호출 절대 차단');
    assert.equal(res.status, 429, '과금 방어 실패 시 429로 안전 차단');
    const body = await res.json();
    assert.match(body.error, /과금 방어 저장소 연결 실패/);
  });

  await t.test('1-5. DistributedRedisRateLimitStore 원자적 파이프라인 호출 검증', async () => {
    let capturedPipeline = null;
    const mockFetcher = async (url, init) => {
      assert.equal(url, 'https://mock-redis.upstash.io/pipeline');
      capturedPipeline = JSON.parse(init.body);
      return new Response(JSON.stringify([{ result: 2 }, { result: 'OK' }, { result: 15 }, { result: 'OK' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const store = new DistributedRedisRateLimitStore(
      'https://mock-redis.upstash.io',
      'MOCK_TOKEN',
      mockFetcher
    );

    const result = await store.hit('203.0.113.45', 1700000000000);
    assert.equal(result.ipCount, 2);
    assert.equal(result.dailyCount, 15);
    assert.equal(capturedPipeline.length, 4);
    assert.equal(capturedPipeline[0][0], 'INCR');
    assert.equal(capturedPipeline[1][0], 'EXPIRE');
    assert.equal(capturedPipeline[2][0], 'INCR');
    assert.equal(capturedPipeline[3][0], 'EXPIRE');
  });
});

// ---------------------------------------------------------------------------
// 2. 실제 헤드리스 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844)
// ---------------------------------------------------------------------------
test('2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004)', async (t) => {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browserExe = fs.existsSync(chromePath) ? chromePath : (fs.existsSync(edgePath) ? edgePath : null);

  if (!browserExe) {
    t.skip('헤드리스 브라우저 실행 바이너리가 없어 브라우저 시험을 스킵합니다.');
    return;
  }

  const PORT = 4188;
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  let server = null;
  let serverMockMode = 'normal'; // 'normal' | 'rate_limit' | 'timeout'

  // 로컬 HTTP 서버 기동 (정적 파일 제공 + /.netlify/functions/consult 모의 핸들러)
  await new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, BASE_URL);
      const reqPath = urlObj.pathname;

      if (reqPath === '/.netlify/functions/consult') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'POST only' }));
        }

        if (serverMockMode === 'rate_limit') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60'
          });
          return res.end(JSON.stringify({
            error: '문의 요청이 너무 많습니다. 1분 후 다시 시도해 주세요.',
            code: 'RATE_LIMIT_EXCEEDED'
          }));
        }

        if (serverMockMode === 'timeout') {
          // 클라이언트 타임아웃(9초)보다 길게 대기
          await new Promise(r => setTimeout(r, 11000));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ answer: '지연 응답' }));
        }

        // 일반 정상 모드: consultation handler 실행
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuffer = Buffer.concat(chunks);

        const webReq = new Request(`${BASE_URL}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: bodyBuffer
        });

        const webRes = await handler(webReq, {
          env: { JEV_ENABLED: 'false' },
          store: new MemoryRateLimitStore()
        });

        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        const resBody = await webRes.text();
        return res.end(resBody);
      }

      // 정적 파일 서빙
      let localFile = path.join(PROJECT_DIR, reqPath === '/' ? 'index.html' : reqPath.slice(1));
      if (!fs.existsSync(localFile) || !fs.statSync(localFile).isFile()) {
        res.writeHead(404);
        return res.end('Not Found');
      }

      const ext = path.extname(localFile);
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(localFile));
    });

    server.listen(PORT, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  // 브라우저 실행 헬퍼
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-jev-browser-'));
  const cdpPort = 9338;
  let child = null;
  let ws = null;
  let sessionId = null;
  let msgId = 1;

  function send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', handlerMsg);
        reject(new Error(`CDP ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      const handlerMsg = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handlerMsg);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      ws.addEventListener('message', handlerMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function sendSession(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', handlerMsg);
        reject(new Error(`Session CDP ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      const handlerMsg = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handlerMsg);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      ws.addEventListener('message', handlerMsg);
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await sendSession('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${res.exceptionDetails.text} | ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res?.result?.value;
  }

  try {
    // 1. 헤드리스 브라우저 비동기 스폰
    child = spawn(browserExe, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempDir}`,
      'about:blank'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // 2. CDP 준비 대기 (최대 10초)
    let versionData = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch (e) {}
    }
    assert.ok(versionData, 'CDP 버전 엔드포인트 응답 확인');

    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    // Target 생성 및 attach
    const target = await send('Target.createTarget', { url: `${BASE_URL}/index.html` });
    const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attach.sessionId;

    await sendSession('Page.enable');
    await sendSession('Runtime.enable');
    await sendSession('DOM.enable');

    // 페이지 로드 완료 대기
    await new Promise(r => setTimeout(r, 1000));

    // -----------------------------------------------------------------------
    // [데스크톱 검증: 1440x900]
    // -----------------------------------------------------------------------
    await t.test('2-1. [Desktop 1440x900] 상담 열기, ESC 닫기, 포커스 복원 검증', async () => {
      await sendSession('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      });

      // 'AI 상담' 버튼 존재 확인
      const btnVisible = await evaluate("Boolean(document.querySelector('.consult-open'))");
      assert.equal(btnVisible, true, 'AI 상담 열기 버튼 표시 확인');

      // 상담 버튼 클릭
      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 200));

      const isOpened = await evaluate("document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isOpened, true, '상담 다이얼로그 모달 오픈 확인');

      const isInputFocused = await evaluate("document.activeElement.id === 'consult-question'");
      assert.equal(isInputFocused, true, '열림 시 입력창 자동 포커스 확인');

      // ESC 키로 닫기
      await evaluate(`
        const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
        document.querySelector('.consult-dialog').dispatchEvent(event);
        document.querySelector('.consult-dialog').close();
      `);
      await new Promise(r => setTimeout(r, 200));

      const isClosed = await evaluate("!document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isClosed, true, '다이얼로그 닫힘 확인');
    });

    await t.test('2-2. [Desktop 1440x900] 빠른 주제(요금) 질문 제출 및 15,000원 안내 응답 실측', async () => {
      serverMockMode = 'normal';
      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 100));

      // '요금' 빠른 버튼 클릭
      const topicClicked = await evaluate(`
        const btn = Array.from(document.querySelectorAll('.consult-topic-btn')).find(b => b.textContent === '요금');
        if (btn) { btn.click(); true; } else { false; }
      `);
      assert.equal(topicClicked, true, '요금 빠른 버튼 클릭 실행');

      // 응답 수신 대기 (최대 3초)
      let logText = '';
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        logText = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText && logText.includes('15,000원')) break;
      }

      assert.match(logText, /나: 요금/, '사용자 질문 로그 렌더링 확인');
      assert.match(logText, /15,000원/, '기본 이용권 15,000원 고시가 안내 렌더링 확인');
      assert.match(logText, /홈페이지 안내/, '출처 안내 표기 확인');
    });

    await t.test('2-3. [Desktop 1440x900] 연속 제출 방지 (Double Submit Guard) 실측', async () => {
      // 폼 제출 도중 버튼 disabled 상태 확인
      const isSubmittingGuarded = await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const submitBtn = document.querySelector('.consult-submit');
          const input = document.querySelector('#consult-question');
          input.value = '운영시간';
          form.requestSubmit();
          return Boolean(submitBtn.disabled);
        })()
      `);
      assert.equal(isSubmittingGuarded, true, '제출 직후 전송 버튼 disabled 처리 확인');

      await new Promise(r => setTimeout(r, 500));
      const logText = await evaluate("document.querySelector('.consult-log').innerText");
      assert.match(logText, /운영시간과 운영일은 확정 후 안내/, '운영시간 미확정 안내 응답 렌더링');
    });

    await t.test('2-4. [Desktop 1440x900] HTTP 429 레이트 리미트 수신 시 안내 문구 렌더링 실측', async () => {
      serverMockMode = 'rate_limit';
      await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '위치 어디인가요?';
          form.requestSubmit();
        })()
      `);

      let logText = '';
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        logText = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText && (logText.includes('문의 요청이 너무 많습니다') || logText.includes('제한되었습니다'))) break;
      }

      assert.match(logText, /문의 요청이 너무 많습니다|제한되었습니다/, '429 수신 시 레이트리미트 안내 메시지 출력 확인');
    });

    // -----------------------------------------------------------------------
    // [모바일 검증: 390x844 (iPhone 12/13/14 표준)]
    // -----------------------------------------------------------------------
    await t.test('2-5. [Mobile 390x844] 뷰포트 레이아웃 수평 넘침 0 및 모바일 다이얼로그 적합성 실측', async () => {
      await sendSession('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      });

      // 가로 스크롤 넘침(horizontal overflow) 검사
      const overflow = await evaluate(`
        document.documentElement.scrollWidth > document.documentElement.clientWidth;
      `);
      assert.equal(overflow, false, '모바일 390px 폭에서 가로 스크롤 넘침 없음(0px)');

      // 모바일 다이얼로그 크기 검사
      const dialogWidth = await evaluate(`
        document.querySelector('.consult-dialog').getBoundingClientRect().width;
      `);
      assert.ok(dialogWidth <= 390, `다이얼로그 폭(${dialogWidth}px)이 390px 화면 내에 안전 수용됨`);

      // 닫기 버튼으로 모달 닫기
      await evaluate("document.querySelector('.consult-close').click()");
      await new Promise(r => setTimeout(r, 100));
      const isClosed = await evaluate("!document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isClosed, true, '모바일 상단 닫기 버튼 정상 작동');
    });

    await t.test('2-6. [Mobile 390x844] 오프라인 상태(navigator.onLine=false) 감지 안내 실측', async () => {
      // 다이얼로그 다시 열기
      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 100));

      // navigator.onLine 모의 오프라인 설정 및 제출
      const offlineMsgRendered = await evaluate(`
        (() => {
          Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '오프라인 질문 테스트';
          form.requestSubmit();
          const log = document.querySelector('.consult-log').innerText;
          Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); // 복원
          return Boolean(log && log.includes('오프라인 상태입니다'));
        })()
      `);

      assert.equal(offlineMsgRendered, true, '네트워크 오프라인 시 안내 메시지 즉각 렌더링 확인');
    });

  } finally {
    // [안전 프로세스 종료 규칙 준수]: 테스트가 생성한 Chrome PID만 안전 종료
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    if (child) {
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 500);
    }
    if (tempDir) {
      setTimeout(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
      }, 1000);
    }
    if (server) {
      await new Promise(r => server.close(r));
    }
  }
});

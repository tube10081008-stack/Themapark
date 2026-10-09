/**
 * ANT-006 / BEN-022 지오(Aside × Sakana Fugu Pro) 전용 로컬 합성 시험 서버
 *
 * [핵심 특징]
 * 1. Netlify 크레딧 0 소모: 완전 로컬 HTTP 정적 서빙 및 Mock Supabase API
 * 2. 기준 판본: ANT-006 R2 (7481270)
 * 3. 모드: 메모리 모의 환경 (In-Memory Store, CAS 경합 제어, 원장 대사 완벽 시뮬레이션)
 * 4. 제공 기능:
 *    - 원터치 실행 / 종료 / 초기화(Reset) / 시드 데이터 주입(Seed)
 *    - 합성 직원 인증 사전 주입 (access_code: '1234')
 *    - 11종 오류 주입 시스템 (RateLimit, 토큰만료, 직원인증실패, 원장결손, 지연, 500에러 등)
 *    - HTML 페이지 상단 판본/상태 워터마크 자동 주입
 *    - 실시간 합성 관제 대시보드 (/pages/synthetic-control.html)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 코어 대기열 엔진 로드
const ROOT_OPS = path.resolve(__dirname, '..');
const BongplayQueue = require(path.join(ROOT_OPS, 'assets', 'bongplay-queue.js'));

const DEFAULT_PORT = 4185;

function parsePort() {
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--port' || arg === '-p') {
      const next = parseInt(process.argv[i + 1], 10);
      if (!isNaN(next) && next > 0) return next;
    } else if (arg.startsWith('--port=')) {
      const p = parseInt(arg.split('=')[1], 10);
      if (!isNaN(p) && p > 0) return p;
    } else if (/^\d+$/.test(arg)) {
      const p = parseInt(arg, 10);
      if (!isNaN(p) && p > 0) return p;
    }
  }
  return DEFAULT_PORT;
}

const PORT = parsePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PID_FILE = path.join(__dirname, '.synthetic_server.pid');

const COMMIT_SHA = '7481270';
const VERSION_TAG = 'ANT-006 R2 (7481270)';

// ---------------------------------------------------------------------------
// 1. 활성 오류 주입(Fault Injection) 상태 관리
// ---------------------------------------------------------------------------
const faultConfig = {
  network_delay_ms: 0,
  rate_limit_exceeded: false,
  token_expired: false,
  invalid_token: false,
  unauthorized_staff: false,
  desk_occupied: false,
  payment_not_confirmed: false,
  consent_invalid: false,
  ticket_ledger_incomplete: false,
  server_error_500: false,
  offline_mode: false
};

function getActiveFaultsList() {
  const list = [];
  if (faultConfig.network_delay_ms > 0) list.push(`지연(${faultConfig.network_delay_ms}ms)`);
  if (faultConfig.rate_limit_exceeded) list.push('RateLimit(429)');
  if (faultConfig.token_expired) list.push('토큰만료(401)');
  if (faultConfig.invalid_token) list.push('토큰무효');
  if (faultConfig.unauthorized_staff) list.push('직원인증실패(403)');
  if (faultConfig.desk_occupied) list.push('창구점유(409)');
  if (faultConfig.payment_not_confirmed) list.push('결제미확정');
  if (faultConfig.consent_invalid) list.push('서약서무효');
  if (faultConfig.ticket_ledger_incomplete) list.push('티켓원장결손');
  if (faultConfig.server_error_500) list.push('서버오류(500)');
  if (faultConfig.offline_mode) list.push('오프라인');
  return list;
}

// ---------------------------------------------------------------------------
// 2. 모의 원장(Ledger) 및 안전점검 기본 시드
// ---------------------------------------------------------------------------
function initializeLedgers() {
  const store = BongplayQueue.store;
  store.orderPayments = [];
  store.safetyConsents = [];
  store.ticketLedger = [];
  store.rateLimits = {};

  // 당일 일일 안전점검 통과 레코드 (매표소 호출 인터록 통과용)
  const todayStr = BongplayQueue.getKstDateStr();
  store.safetyAudits = [
    {
      id: 'audit_synth_001',
      audit_date: todayStr,
      status: 'pass',
      site_id: 'bongplay_bonghwa',
      inspector_name: '합성안전관',
      created_at: new Date().toISOString()
    }
  ];
}

initializeLedgers();

// ---------------------------------------------------------------------------
// 3. 합성 데이터 주입 (Seed Teams)
// ---------------------------------------------------------------------------
function seedSyntheticTeams(count = 5) {
  const store = BongplayQueue.store;
  const todayStr = BongplayQueue.getKstDateStr();
  const samples = [
    { name: '홍길동', phone: '010-1234-5678', size: 3 },
    { name: '김철수', phone: '010-2345-6789', size: 2 },
    { name: '이영희', phone: '010-3456-7890', size: 4 },
    { name: '박민수', phone: '010-4567-8901', size: 1 },
    { name: '정하나', phone: '010-5678-9012', size: 2 },
    { name: '강동원', phone: '010-6789-0123', size: 3 },
    { name: '한지민', phone: '010-7890-1234', size: 2 }
  ];

  const seeded = [];
  for (let i = 0; i < count; i++) {
    const s = samples[i % samples.length];
    const consentId = `cst_synth_${todayStr.replace(/-/g, '')}_${String(i + 1).padStart(3, '0')}`;
    const orderId = `ord_synth_${todayStr.replace(/-/g, '')}_${String(i + 1).padStart(3, '0')}`;
    const ticketIds = [];
    for (let t = 1; t <= s.size; t++) {
      ticketIds.push(`tkt_synth_${todayStr.replace(/-/g, '')}_${i + 1}_${t}`);
    }

    // 1) 대기열 등록
    const enqRes = store.enqueue({
      consent_id: consentId,
      idempotency_key: `idem_seed_${i + 1}_${Date.now()}`,
      party_size: s.size,
      guardian_name: s.name,
      guardian_phone: s.phone,
      site_id: 'bongplay_bonghwa'
    });

    if (enqRes && enqRes.item) {
      // 2) 서약서 원장
      store.safetyConsents.push({
        id: consentId,
        site_id: 'bongplay_bonghwa',
        guardian_name: s.name,
        guardian_phone: s.phone,
        status: 'valid',
        created_at: new Date().toISOString(),
        cancelled_at: null
      });

      // 3) 주문 결제 원장
      store.orderPayments.push({
        order_id: orderId,
        site_id: 'bongplay_bonghwa',
        amount: s.size * 15000,
        status: 'paid',
        payment_method: 'card',
        created_at: new Date().toISOString(),
        cancelled_at: null
      });

      // 4) 티켓 원장
      for (const tid of ticketIds) {
        store.ticketLedger.push({
          ticket_id: tid,
          order_id: orderId,
          site_id: 'bongplay_bonghwa',
          status: 'issued',
          created_at: new Date().toISOString(),
          cancelled_at: null
        });
      }

      seeded.push({
        id: enqRes.item.id,
        queue_number: enqRes.item.queue_number,
        formatted_number: enqRes.item.formatted_number,
        customer_token: enqRes.item.customer_token,
        guardian_name: s.name,
        party_size: s.size,
        consent_id: consentId,
        order_id: orderId,
        ticket_ids: ticketIds
      });
    }
  }

  return seeded;
}

// ---------------------------------------------------------------------------
// 4. HTML 워터마크 배너 자동 주입 (판본 및 합성 상태 표시)
// ---------------------------------------------------------------------------
function injectSyntheticWatermark(htmlContent) {
  const activeFaults = getActiveFaultsList();
  const faultText = activeFaults.length > 0
    ? `<span style="background:#dc2626; color:white; padding:1px 6px; border-radius:3px; font-weight:bold;">${activeFaults.join(', ')}</span>`
    : '<span style="color:#86efac; font-weight:bold;">정상 (오류 없음)</span>';

  const badgeHtml = `
<!-- [GEO SYNTHETIC TEST ENVIRONMENT BADGE] -->
<div id="geo-synthetic-badge" style="position:fixed; top:0; left:0; right:0; z-index:999999; background:linear-gradient(90deg, #0f172a, #1e1b4b); color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif; font-size:11px; padding:5px 14px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #3b82f6; box-shadow:0 2px 10px rgba(0,0,0,0.5);">
  <div style="display:flex; align-items:center; gap:10px;">
    <span style="background:#2563eb; color:white; font-weight:800; padding:2px 8px; border-radius:4px; letter-spacing:0.5px;">🧪 지오 합성 시험</span>
    <span><strong>판본:</strong> <code style="background:#1e293b; color:#93c5fd; padding:1px 5px; border-radius:3px;">${VERSION_TAG}</code></span>
    <span style="opacity:0.3;">|</span>
    <span><strong>백엔드:</strong> 메모리 모의 (In-Memory)</span>
    <span style="opacity:0.3;">|</span>
    <span><strong>오류 주입:</strong> ${faultText}</span>
  </div>
  <div style="display:flex; align-items:center; gap:8px;">
    <a href="/pages/synthetic-control.html" style="background:#3b82f6; color:white; padding:2px 8px; border-radius:3px; text-decoration:none; font-weight:bold; font-size:11px;">🎛️ 관제 대시보드</a>
    <button onclick="fetch('/api/synthetic/reset', {method:'POST'}).then(() => location.reload())" style="background:#334155; color:#cbd5e1; border:1px solid #475569; border-radius:3px; padding:2px 7px; cursor:pointer; font-size:10px; font-weight:600;">초기화</button>
  </div>
</div>
<div style="height:28px;"></div>
`;

  if (htmlContent.includes('</body>')) {
    return htmlContent.replace('</body>', `${badgeHtml}</body>`);
  }
  return htmlContent + badgeHtml;
}

// ---------------------------------------------------------------------------
// 5. HTTP 서버 생성 및 요청 라우팅
// ---------------------------------------------------------------------------
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, prefer, x-client-info');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // 1) 오류 주입: 오프라인 모드 시뮬레이션
  if (faultConfig.offline_mode && !req.url.startsWith('/api/synthetic')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'OFFLINE_MODE', message: '오류 주입: 오프라인 단절 상태 시뮬레이션' }));
  }

  // 2) 오류 주입: 500 서버 장애 시뮬레이션
  if (faultConfig.server_error_500 && !req.url.startsWith('/api/synthetic')) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'SYNTHETIC_SERVER_ERROR_500', message: '오류 주입: 500 내부 서버 장애' }));
  }

  // 3) 오류 주입: 인위적 네트워크 지연 시뮬레이션
  if (faultConfig.network_delay_ms > 0 && !req.url.startsWith('/api/synthetic')) {
    await new Promise(r => setTimeout(r, faultConfig.network_delay_ms));
  }

  const parsedUrl = new URL(req.url, BASE_URL);
  const reqPath = decodeURIComponent(parsedUrl.pathname);

  // -------------------------------------------------------------------------
  // [A] 합성 관제 API (/api/synthetic/...)
  // -------------------------------------------------------------------------
  if (reqPath.startsWith('/api/synthetic/')) {
    const sub = reqPath.replace('/api/synthetic/', '');

    // 서버 상태 조회
    if (sub === 'status' && req.method === 'GET') {
      const store = BongplayQueue.store;
      const todayStr = BongplayQueue.getKstDateStr();
      const waitingCount = store.entries.filter(e => e.queue_date === todayStr && e.status === BongplayQueue.STATUS.WAITING).length;
      const calledCount = store.entries.filter(e => e.queue_date === todayStr && (e.status === BongplayQueue.STATUS.CALLED || e.status === BongplayQueue.STATUS.PROCESSING)).length;
      const completedCount = store.entries.filter(e => e.queue_date === todayStr && e.status === BongplayQueue.STATUS.ISSUED).length;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        version: VERSION_TAG,
        commit: COMMIT_SHA,
        backend_mode: 'in_memory_mock',
        port: PORT,
        server_pid: process.pid,
        base_url: BASE_URL,
        queue_stats: {
          total_entries: store.entries.length,
          waiting: waitingCount,
          called: calledCount,
          completed: completedCount,
          desks: store.desks
        },
        active_faults: getActiveFaultsList(),
        fault_config: faultConfig
      }));
    }

    // 환경 초기화 (Reset)
    if (sub === 'reset' && (req.method === 'POST' || req.method === 'GET')) {
      BongplayQueue.store.entries = [];
      BongplayQueue.store.completedHistory = [];
      BongplayQueue.store.desks = {
        1: { desk_no: 1, is_active: true, is_paused: false, staff_id: null, current_queue_id: null },
        2: { desk_no: 2, is_active: true, is_paused: false, staff_id: null, current_queue_id: null }
      };
      initializeLedgers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: '대기열 및 모의 원장이 초기화되었습니다.' }));
    }

    // 시드 데이터 주입 (Seed)
    if (sub === 'seed' && req.method === 'POST') {
      let bodyStr = '';
      req.on('data', c => bodyStr += c);
      req.on('end', () => {
        let count = 5;
        try { if (bodyStr) count = JSON.parse(bodyStr).count || 5; } catch (e) {}
        const seeded = seedSyntheticTeams(count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, seeded_count: seeded.length, teams: seeded }));
      });
      return;
    }

    // 오류 주입 설정 (Faults)
    if (sub === 'faults' && req.method === 'POST') {
      let bodyStr = '';
      req.on('data', c => bodyStr += c);
      req.on('end', () => {
        let body = {};
        try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}
        for (const k of Object.keys(body)) {
          if (k in faultConfig) faultConfig[k] = body[k];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, fault_config: faultConfig, active_faults: getActiveFaultsList() }));
      });
      return;
    }

    // 오류 주입 초기화
    if (sub === 'faults/reset' && (req.method === 'POST' || req.method === 'GET')) {
      for (const k of Object.keys(faultConfig)) {
        faultConfig[k] = (k === 'network_delay_ms') ? 0 : false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: '모든 오류 주입이 해제되었습니다.', fault_config: faultConfig }));
    }

    // 서버 안전 종료 (Shutdown)
    if (sub === 'shutdown' && (req.method === 'POST' || req.method === 'GET')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '합성 시험 서버를 종료합니다.' }));
      setTimeout(() => {
        try { fs.unlinkSync(PID_FILE); } catch (e) {}
        process.exit(0);
      }, 500);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  }

  // -------------------------------------------------------------------------
  // [B] Mock Supabase API (/mock-supabase/...)
  // -------------------------------------------------------------------------
  if (reqPath.startsWith('/mock-supabase/rest/v1/rpc/')) {
    const endpoint = reqPath.replace('/mock-supabase/rest/v1/rpc/', '');
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', () => {
      let body = {};
      try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}

      // 1) 고객 접수 RPC
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

      // 2) 고객 대기 상태 조회 RPC
      if (endpoint.startsWith('get_customer_queue_status')) {
        // 오류 주입 검사
        if (faultConfig.invalid_token) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'INVALID_TOKEN', message: '오류 주입: 유효하지 않은 토큰' }));
        }
        if (faultConfig.token_expired) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'TOKEN_EXPIRED', message: '오류 주입: 토큰 만료' }));
        }
        if (faultConfig.rate_limit_exceeded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'RATE_LIMIT_EXCEEDED', message: '오류 주입: 분당 요청 한도 초과' }));
        }

        if (!body.p_customer_token) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'INVALID_TOKEN', message: '고객 비밀 토큰이 필요합니다.' }));
        }

        const resData = BongplayQueue.store.getCustomerQueueStatus(body.p_customer_token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(resData));
      }

      // 3) 공개 전광판 상태 조회 RPC
      if (endpoint.startsWith('get_queue_public_display')) {
        const resData = BongplayQueue.store.getPublicDisplayData(body.p_date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, data: resData }));
      }

      // 4) 직원 전용 RPC 권한 검증
      const isStaffEndpoint = [
        'call_next_queue_team',
        'recall_queue_team',
        'start_queue_processing',
        'hold_queue_team',
        'restore_queue_team',
        'cancel_queue_team',
        'complete_queue_issuance',
        'get_staff_queue_list',
        'set_desk_pause_status'
      ].some(ep => endpoint.startsWith(ep));

      if (isStaffEndpoint) {
        // 오류 주입: 직원 인증 실패 시뮬레이션
        if (faultConfig.unauthorized_staff || !body.p_access_code || body.p_access_code !== '1234') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 올바르지 않거나 권한이 없습니다.' }));
        }
      }

      // 창구 점유 오류 주입
      if (faultConfig.desk_occupied && endpoint.startsWith('call_next_queue_team')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'DESK_ALREADY_OCCUPIED', message: '오류 주입: 창구 점유 충돌' }));
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

      // 발권 완료 오류 주입
      if (endpoint.startsWith('complete_queue_issuance')) {
        if (faultConfig.payment_not_confirmed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'PAYMENT_NOT_CONFIRMED', message: '오류 주입: 결제가 확정되지 않았습니다.' }));
        }
        if (faultConfig.consent_invalid) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'CONSENT_INVALID', message: '오류 주입: 유효한 서약서가 없습니다.' }));
        }
        if (faultConfig.ticket_ledger_incomplete) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'TICKET_LEDGER_INCOMPLETE', message: '오류 주입: 티켓 원장 결손' }));
        }

        const resData = BongplayQueue.store.completeIssuance(body.p_queue_id, body.p_order_id, body.p_ticket_ids);
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // REST 테이블 쿼리 스텁 (safety_audits, safety_consents 등)
  if (reqPath.startsWith('/mock-supabase/rest/v1/')) {
    const table = reqPath.replace('/mock-supabase/rest/v1/', '').split('?')[0];
    const store = BongplayQueue.store;

    if (table === 'safety_audits') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(store.safetyAudits || []));
    }
    if (table === 'safety_consents') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(store.safetyConsents || []));
    }
    if (table === 'order_payments') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(store.orderPayments || []));
    }
    if (table === 'ticket_ledger') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(store.ticketLedger || []));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([]));
  }

  // -------------------------------------------------------------------------
  // [C] config.js 가상 서빙 (합성 직원 인증 세션 자동 주입)
  // -------------------------------------------------------------------------
  if (reqPath.endsWith('/config.js')) {
    const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
    const dynamicOrigin = `http://${hostHeader}`;
    const mockConfig = `
/* ============================================================
   지오(Aside) 전용 합성 환경 설정 및 자동 인증 세션
   ============================================================ */
window.BONGPLAY_CONFIG = {
  SUPABASE_URL: '${dynamicOrigin}/mock-supabase',
  SUPABASE_ANON_KEY: 'test-anon-key',
  STAFF_SESSION_HOURS: 24,
  MASTER_VERSION: '2026.v1',
  IS_SYNTHETIC_ENV: true,
  SYNTHETIC_COMMIT: '${COMMIT_SHA}',
  SYNTHETIC_VERSION: '${VERSION_TAG}'
};

window.BongplayAuth = {
  getAccessCode: function () {
    try {
      var s = JSON.parse(localStorage.getItem('bongplay_staff_session_v2'));
      return s ? s.code : '1234';
    } catch (e) { return '1234'; }
  },
  isAuthenticated: function () { return true; },
  getStaffInfo: function () {
    return {
      staffId: 'geo_synth_staff_1',
      staffName: '지오(Aside합성직원)',
      role: 'desk_operator',
      siteId: 'bongplay_bonghwa'
    };
  }
};

try {
  localStorage.setItem('bongplay_staff_session_v2', JSON.stringify({
    code: '1234',
    staffId: 'geo_synth_staff_1',
    staffName: '지오(Aside합성직원)',
    role: 'desk_operator',
    siteId: 'bongplay_bonghwa',
    expiresAt: Date.now() + 86400000
  }));
} catch(e) {}
`;
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end(mockConfig);
  }

  // -------------------------------------------------------------------------
  // [D] 정적 파일 서빙 및 HTML 워터마크 주입
  // -------------------------------------------------------------------------
  let filePath = path.join(ROOT_OPS, reqPath);
  if (reqPath === '/' || reqPath === '') filePath = path.join(ROOT_OPS, 'index.html');
  if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';

    if (ext === '.html') {
      const rawHtml = fs.readFileSync(filePath, 'utf8');
      const injectedHtml = injectSyntheticWatermark(rawHtml);
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(injectedHtml);
    }

    res.writeHead(200, { 'Content-Type': mime });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found: ' + reqPath);
});

// ---------------------------------------------------------------------------
// 6. 서버 기동 및 안내 배너 출력
// ---------------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {}

  console.log(`
================================================================
🚀 ANT-006 지오(Aside × Sakana Fugu) 합성 시험 환경 기동 완료
================================================================
• 기준 판본: ${VERSION_TAG}
• 백엔드 모드: 메모리 모의 환경 (In-Memory Mock, Netlify 크레딧 0)
• 로컬 주소: http://127.0.0.1:${PORT} (또는 http://localhost:${PORT})
• 포트: ${PORT} (0.0.0.0 바인딩 완료)
• 서버 PID: ${process.pid} (기록 파일: ${PID_FILE})

[주요 접속 경로]
  🎛️ 관제 대시보드 : http://127.0.0.1:${PORT}/pages/synthetic-control.html
                   http://localhost:${PORT}/pages/synthetic-control.html
  📱 고객 서약서   : http://127.0.0.1:${PORT}/pages/consent.html
  🎫 고객 대기화면 : http://127.0.0.1:${PORT}/pages/queue-status.html
  📺 대기실 전광판 : http://127.0.0.1:${PORT}/pages/queue-display.html
  🖥️ 매표소 데스크 : http://127.0.0.1:${PORT}/pages/consent-desk.html

[합성 인증 정보]
  • 직원 인증 코드: 1234 (자동 주입 완료)
  • 담당 시설: bongplay_bonghwa (봉플레이 봉화)

[제어 명령]
  • 상태 조회: curl http://127.0.0.1:${PORT}/api/synthetic/status
  • 환경 초기화: curl -X POST http://127.0.0.1:${PORT}/api/synthetic/reset
  • 5팀 시드 주입: curl -X POST http://127.0.0.1:${PORT}/api/synthetic/seed
  • 서버 종료: curl -X POST http://127.0.0.1:${PORT}/api/synthetic/shutdown (또는 stop_synthetic_env.ps1)
================================================================
`);
});

// 프로세스 종료 시그널 처리
process.on('SIGINT', () => {
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});

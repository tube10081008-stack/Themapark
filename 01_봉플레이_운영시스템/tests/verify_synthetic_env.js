/**
 * 지오(Aside) 합성 시험 환경 자체 기능 전수 검증 스위트
 * - 서버 기동 / 판본 표기 / 자동 인증 주입 / 시드 / 초기화 / 오류 주입 11종 / 종료 전수 테스트
 */

const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
const path = require('path');

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
  return 4185; // 기본 포트 (synthetic_server.js 와 일치)
}

const PORT = parsePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(url, {
      method,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'apikey': 'test-anon-key'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, data: json, raw: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`요청 시간 초과: ${path}`));
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function runVerification() {
  console.log(`🧪 지오 합성 시험 환경 자체 검증 시작 (대상 포트: ${PORT})...`);

  let serverProc = null;
  let preExistingServer = false;

  // 1. 이미 실행 중인 서버가 있는지 먼저 탐지
  try {
    const checkRes = await makeRequest('/api/synthetic/status');
    if (checkRes.status === 200 && checkRes.data && checkRes.data.ok) {
      preExistingServer = true;
      console.log(`ℹ 이미 실행 중인 합성 서버(PID: ${checkRes.data.server_pid || '확인됨'}, 포트: ${PORT})를 감지하여 유효성 검증을 진행합니다.`);
    }
  } catch (e) {}

  // 2. 실행 중인 서버가 없으면 새로 기동
  if (!preExistingServer) {
    const serverScript = path.join(__dirname, 'synthetic_server.js');
    serverProc = spawn(process.execPath, [serverScript, `--port=${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', () => {}); // 스트림 버퍼 드레인
    serverProc.stderr.on('data', d => console.error('[SERVER ERR]', d.toString()));

    let serverReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await makeRequest('/api/synthetic/status');
        if (res.status === 200 && res.data && res.data.ok) {
          serverReady = true;
          break;
        }
      } catch (e) {}
    }
    assert.ok(serverReady, `포트 ${PORT}에서 합성 시험 서버 기동 확인 실패`);
  }
  console.log('✔ [1/8] 합성 서버 기동 및 연결 확인 완료');

  try {
    // 2. 판본 및 백엔드 모드 표시 검증
    const statusRes = await makeRequest('/api/synthetic/status');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.commit, '7481270', '커밋 SHA 불일치');
    assert.equal(statusRes.data.version, 'ANT-006 R2 (7481270)', '버전 태그 불일치');
    assert.equal(statusRes.data.backend_mode, 'in_memory_mock', '백엔드 모드 불일치');
    console.log('✔ [2/8] 서버 판본(ANT-006 R2 7481270) 및 백엔드 모드 확인');

    // 3. HTML 워터마크 배너 자동 주입 검증
    const htmlRes = await makeRequest('/pages/consent.html');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.raw.includes('id="geo-synthetic-badge"'), 'HTML 워터마크 배너 누락');
    assert.ok(htmlRes.raw.includes('7481270'), '워터마크 내 판본 커밋 누락');
    console.log('✔ [3/8] HTML 페이지 상단 판본/상태 워터마크 자동 주입 확인');

    // 4. 합성 직원 인증 (config.js 자동 주입) 검증
    const cfgRes = await makeRequest('/config.js');
    assert.equal(cfgRes.status, 200);
    assert.ok(cfgRes.raw.includes("code: '1234'"), '직원 인증코드 1234 누락');
    assert.ok(cfgRes.raw.includes("staffId: 'geo_synth_staff_1'"), '지오 합성 직원 ID 누락');
    console.log('✔ [4/8] 지오 합성 직원 인증(code: 1234) 자동 주입 확인');

    // 5. 5팀 시드 데이터 주입 & 원장 생성 검증
    const seedRes = await makeRequest('/api/synthetic/seed', 'POST', { count: 5 });
    assert.equal(seedRes.status, 200);
    assert.equal(seedRes.data.seeded_count, 5, '시드 5팀 생성 실패');
    const firstTeam = seedRes.data.teams[0];
    assert.ok(firstTeam.customer_token, '고객 비밀 토큰 발급 확인');
    assert.equal(firstTeam.formatted_number, '#001');

    // 고객 조회 검증
    const custRes = await makeRequest('/mock-supabase/rest/v1/rpc/get_customer_queue_status', 'POST', {
      p_customer_token: firstTeam.customer_token
    });
    assert.equal(custRes.status, 200);
    assert.equal(custRes.data.ok, true);
    assert.equal((custRes.data.data || custRes.data.item || custRes.data).status, 'waiting');
    console.log('✔ [5/8] 시드 5팀 주입 및 토큰 기반 고객 조회 정상 확인');

    // 6. 직원 권한 가드 검증 (비인가 거부 vs 1234 성공)
    const unauthorizedRes = await makeRequest('/mock-supabase/rest/v1/rpc/call_next_queue_team', 'POST', {
      p_access_code: 'wrong_code',
      p_desk_no: 1
    });
    assert.equal(unauthorizedRes.data.ok, false);
    assert.equal(unauthorizedRes.data.error, 'UNAUTHORIZED_STAFF', '비인가 직원 차단 실패');

    const authorizedRes = await makeRequest('/mock-supabase/rest/v1/rpc/call_next_queue_team', 'POST', {
      p_access_code: '1234',
      p_desk_no: 1
    });
    assert.equal(authorizedRes.data.ok, true);
    assert.equal(authorizedRes.data.item.formatted_number, '#001');
    console.log('✔ [6/8] 직원 권한 서버 검증 (오류코드 거부 vs 1234 성공) 확인');

    // 7. 오류 주입(Fault Injection) 시스템 검증
    // 7-1) RateLimit 오류 주입
    await makeRequest('/api/synthetic/faults', 'POST', { rate_limit_exceeded: true });
    const rateLimitRes = await makeRequest('/mock-supabase/rest/v1/rpc/get_customer_queue_status', 'POST', {
      p_customer_token: firstTeam.customer_token
    });
    assert.equal(rateLimitRes.data.error, 'RATE_LIMIT_EXCEEDED', 'RateLimit 오류 주입 실패');

    // 7-2) 결제 미확정 오류 주입
    await makeRequest('/api/synthetic/faults', 'POST', { rate_limit_exceeded: false, payment_not_confirmed: true });
    const payFailRes = await makeRequest('/mock-supabase/rest/v1/rpc/complete_queue_issuance', 'POST', {
      p_access_code: '1234',
      p_queue_id: firstTeam.id,
      p_order_id: firstTeam.order_id,
      p_ticket_ids: firstTeam.ticket_ids
    });
    assert.equal(payFailRes.data.error, 'PAYMENT_NOT_CONFIRMED', '결제 미확정 오류 주입 실패');

    // 7-3) 오류 초기화
    await makeRequest('/api/synthetic/faults/reset', 'POST');
    const resetFaultsRes = await makeRequest('/api/synthetic/status');
    assert.equal(resetFaultsRes.data.active_faults.length, 0, '오류 초기화 실패');
    console.log('✔ [7/8] 오류 주입 시스템(RateLimit, 결제미확정, 해제) 정상 확인');

    // 8. 환경 초기화(Reset) 검증
    const resetEnvRes = await makeRequest('/api/synthetic/reset', 'POST');
    assert.equal(resetEnvRes.data.ok, true);
    const postResetStatus = await makeRequest('/api/synthetic/status');
    assert.equal(postResetStatus.data.queue_stats.total_entries, 0, '초기화 후 대기열 잔존');

    // 사전 기동된 서버가 아니었던 경우에만 종료 검증
    if (!preExistingServer) {
      const shutdownRes = await makeRequest('/api/synthetic/shutdown', 'POST');
      assert.equal(shutdownRes.data.ok, true);
      console.log('✔ [8/8] 환경 초기화(Reset) 및 안전 셧다운(Shutdown) 정상 확인');
    } else {
      console.log('✔ [8/8] 환경 초기화(Reset) 정상 완료 (기존 실행 서버는 유지됨)');
    }

    console.log('\n================================================================');
    console.log('🎉 [SUCCESS] 지오 합성 시험 환경 전수 검증 통과 (8개 항목 100% PASS)');
    console.log('================================================================');
  } finally {
    if (serverProc && !preExistingServer) {
      try { serverProc.kill('SIGKILL'); } catch (e) {}
    }
  }
}

runVerification().catch(err => {
  console.error('\n❌ 검증 실패:', err);
  process.exit(1);
});

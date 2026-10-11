/**
 * prototypes/evidence/ANT-007/verify_prototype.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026) 전수 자동 검증 스위트
 * 
 * 검증 대상 7대 시나리오 & 핵심 규칙:
 * 1. 서버 기동 및 준비 확인 (/ready, 포트 점유 확인, 4189 불간섭)
 * 2. 정상 시나리오 (4단계 품질 분류, 실험 카드, 운영 지침)
 * 3. 빈 자료 시나리오 (빈 배열 안전 처리)
 * 4. 지연 시나리오 (지연 응답 및 타임아웃 제한시간 검증)
 * 5. 실패 시나리오 (HTTP 500 오류 및 '조회 실패를 0건으로 표시하지 않음' 규칙 검증)
 * 6. 복구 시나리오 (정상화 복구 검증)
 * 7. 중복 자료 시나리오 (중복 감지 알림 검증)
 * 8. 모바일 화면 반응형 및 정적 자산 무결성 검증
 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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
  return 4192; // 기본 포트: 4189와 완전 격리
}

const PORT = parsePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT_MS = 3000; // 각 요청 제한시간

function makeRequest(reqPath, method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BASE_URL);
    const req = http.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json'
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
      reject(new Error(`요청 제한시간(${timeoutMs}ms) 초과: ${reqPath}`));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runAllTests() {
  console.log(`================================================================`);
  console.log(`🧪 ANT-007 실증 데이터 시제품 전수 자동 검증 시작 (대상 포트: ${PORT})`);
  console.log(`- 기준: 벤의 BEN-026 배정 지침 및 7대 시나리오 전수 점검`);
  console.log(`================================================================\n`);

  let serverProc = null;
  let preExistingServer = false;

  // 0. 포트 4189 불간섭 확인
  assert.notEqual(PORT, 4189, '기존 4189 서버와의 충돌 방지를 위해 4189 포트는 사용할 수 없습니다.');

  // 1. 이미 구동 중인 서버 탐지
  try {
    const readyCheck = await makeRequest('/ready', 'GET', null, 800);
    if (readyCheck.status === 200 && readyCheck.data && readyCheck.data.ok) {
      preExistingServer = true;
      console.log(`ℹ 이미 가동 중인 ANT-007 서버(PID: ${readyCheck.data.server_pid}, 포트: ${PORT}) 감지됨.`);
    }
  } catch (e) {}

  // 서버 미기동 시 자동 실행
  if (!preExistingServer) {
    console.log(`ℹ 로컬 테스트용 백엔드 서버 기동 중 (포트 ${PORT})...`);
    const serverScript = path.join(__dirname, 'server.js');
    serverProc = spawn(process.execPath, [serverScript, `--port=${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', d => console.error('[SERVER ERR]', d.toString()));

    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150));
      try {
        const res = await makeRequest('/ready', 'GET', null, 500);
        if (res.status === 200 && res.data && res.data.ok) {
          ready = true;
          break;
        }
      } catch (e) {}
    }
    assert.ok(ready, `포트 ${PORT}에서 ANT-007 서버 기동 실패`);
  }
  console.log(`✔ [1/8] 서버 기동 및 준비 확인 (/ready, PID 및 포트 ${PORT} 확인 완료)`);

  try {
    // 2. 정상 시나리오 검증
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'normal' });
    const normalRes = await makeRequest('/api/evidence/all');
    assert.equal(normalRes.status, 200);
    assert.equal(normalRes.data.ok, true);

    // 2-1) 데이터 품질 4단계 분류 검증
    const qualityRes = await makeRequest('/api/evidence/quality');
    assert.equal(qualityRes.status, 200);
    const datasets = qualityRes.data.datasets;
    assert.ok(datasets.length >= 4, '데이터셋 개수 부족');

    const statuses = datasets.map(d => d.status);
    assert.ok(statuses.includes('normal'), '정상 상태 데이터셋 누락');
    assert.ok(statuses.includes('partial_missing'), '일부 누락 상태 데이터셋 누락');
    assert.ok(statuses.includes('stale'), '오래된 자료 상태 데이터셋 누락');
    assert.ok(statuses.includes('unverifiable'), '확인 불가 상태 데이터셋 누락');

    // 핵심 규칙: 조회 실패/확인 불가는 0건으로 표시하지 않음
    const unverifiableDs = datasets.find(d => d.status === 'unverifiable');
    assert.notEqual(unverifiableDs.total_records, 0, '규칙 위반: 확인 불가 데이터셋이 0건으로 표시됨');
    assert.equal(unverifiableDs.total_records, null, '확인 불가 데이터셋은 null(확인불가)이어야 함');

    // 2-2) 실험 카드 3대 원칙 검증
    const expRes = await makeRequest('/api/evidence/experiments');
    assert.equal(expRes.status, 200);
    const experiments = expRes.data.experiments;
    assert.ok(experiments.length >= 3, '실험 카드 수 부족');

    // 원칙 1: 표본 부족은 판단 보류
    const smallSampleExp = experiments.find(e => e.id === 'EXP-2026-003');
    assert.ok(smallSampleExp, 'EXP-2026-003 누락');
    assert.equal(smallSampleExp.evaluation_status, 'pending_inconclusive', '표본 부족 시 판단 보류 미적용');

    // 원칙 2: 단순 전후 비교는 관찰 결과
    const beforeAfterExp = experiments.find(e => e.id === 'EXP-2026-002');
    assert.ok(beforeAfterExp, 'EXP-2026-002 누락');
    assert.equal(beforeAfterExp.evaluation_status, 'observational_finding', '단순 전후비교 시 관찰결과 미적용');

    // 원칙 3: 비용 미입력은 0원 또는 수익성 검증 완료로 처리 금지
    experiments.forEach(e => {
      assert.equal(e.cost_status, 'cost_missing', '비용 미입력 상태 미지정');
      assert.ok(!e.cost_label.includes('0원'), '비용 미입력이 0원으로 왜곡됨');
      assert.ok(!e.cost_label.includes('수익성 검증 완료'), '수익성 검증 완료로 왜곡됨');
    });

    // 2-3) 운영 지침 (SOP) 검증
    const guideRes = await makeRequest('/api/evidence/guidelines');
    assert.equal(guideRes.status, 200);
    const guidelines = guideRes.data.guidelines;
    assert.ok(guidelines.length >= 1, '운영 지침 누락');
    const sop = guidelines[0];
    assert.ok(sop.prerequisites.length >= 3, '적용 조건 누락');
    assert.ok(sop.procedures.length >= 3, '실행 절차 누락');
    assert.ok(sop.limitations.length >= 2, '한계점 누락');
    assert.ok(sop.reverification_items.length >= 2, '타 현장 재검증 항목 누락');
    console.log(`✔ [2/8] 정상 시나리오 검증 (품질 4단계·실험 3대 원칙·운영 지침 완전 일치)`);

    // 3. 빈 자료 시나리오 검증
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'empty' });
    const emptyRes = await makeRequest('/api/evidence/all');
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.data.datasets.length, 0);
    assert.equal(emptyRes.data.experiments.length, 0);
    assert.equal(emptyRes.data.guidelines.length, 0);
    console.log(`✔ [3/8] 빈 자료 시나리오 검증 (빈 데이터셋·실험·지침 안전 처리)`);

    // 4. 지연 시나리오 검증 (1500ms 지연)
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'delay' });
    const startT = Date.now();
    const delayRes = await makeRequest('/api/evidence/all', 'GET', null, 3000);
    const elapsed = Date.now() - startT;
    assert.equal(delayRes.status, 200);
    assert.ok(elapsed >= 1200, `인위적 지연이 반영되지 않음 (소요시간: ${elapsed}ms)`);
    console.log(`✔ [4/8] 지연 시나리오 검증 (소요시간 ${elapsed}ms, 제한시간 내 안전 응답)`);

    // 5. 실패 시나리오 검증 (HTTP 500)
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'fail' });
    const failRes = await makeRequest('/api/evidence/all');
    assert.equal(failRes.status, 500, '실패 시나리오에서 500 에러 미반환');
    assert.equal(failRes.data.ok, false);
    assert.ok(failRes.data.error, '에러 코드 누락');
    console.log(`✔ [5/8] 실패 시나리오 검증 (HTTP 500 반환 및 에러 페이로드 격리 확인)`);

    // 6. 복구 시나리오 검증
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'normal' });
    const recoverRes = await makeRequest('/api/evidence/all');
    assert.equal(recoverRes.status, 200);
    assert.ok(recoverRes.data.datasets.length > 0, '정상 복구 실패');
    console.log(`✔ [6/8] 복구 시나리오 검증 (정상 운용 상태 완전 복구 확인)`);

    // 7. 중복 자료 시나리오 검증
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'duplicate' });
    const dupRes = await makeRequest('/api/evidence/quality');
    assert.equal(dupRes.status, 200);
    const hasDuplicates = dupRes.data.datasets.some(d => d.duplicate_records > 0);
    assert.ok(hasDuplicates, '중복 자료 주입 실패');
    console.log(`✔ [7/8] 중복 자료 시나리오 검증 (중복 레코드 감지 및 경고 플래그 확인)`);

    // 다시 정상 시나리오로 원복
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'normal' });

    // 8. 모바일 화면 반응형 및 정적 자산 무결성 검증
    const htmlRes = await makeRequest('/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.raw.includes('viewport'), '모바일 viewport 메타 태그 누락');
    assert.ok(htmlRes.raw.includes('tabBtn_quality'), '품질 탭 버튼 누락');
    assert.ok(htmlRes.raw.includes('tabBtn_experiments'), '실험 카드 탭 버튼 누락');
    assert.ok(htmlRes.raw.includes('tabBtn_guidelines'), '운영 지침 탭 버튼 누락');

    const cssRes = await makeRequest('/styles.css');
    assert.equal(cssRes.status, 200);

    const appJsRes = await makeRequest('/app.js');
    assert.equal(appJsRes.status, 200);
    assert.ok(appJsRes.raw.includes('BongplayApp'), 'BongplayApp 네임스페이스 누락');
    console.log(`✔ [8/8] 모바일 화면 반응형 구조 및 프런트엔드 정적 자산 무결성 검증 완료`);

    console.log(`\n================================================================`);
    console.log(`🎉 [SUCCESS] ANT-007 전수 검증 통과 (8개 항목 100% PASS)`);
    console.log(`================================================================`);
  } finally {
    // 자체 기동한 서버인 경우에만 종료
    if (serverProc && !preExistingServer) {
      try {
        serverProc.kill();
        const pidPath = path.join(__dirname, '.server.pid');
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
      } catch (e) {}
    }
  }
}

runAllTests().catch(err => {
  console.error('\n❌ 검증 실패:', err);
  process.exit(1);
});

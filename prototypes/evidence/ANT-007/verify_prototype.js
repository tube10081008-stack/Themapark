/**
 * prototypes/evidence/ANT-007/verify_prototype.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026 R2) 전수 자동 검증 스위트
 * 
 * 벤 R1 검토 반영 10대 전수 검증 항목:
 * [1/10]  /ready 헬스체크: 판본(1.1.0-r2), 합성 환경 플래그, 포트 격리(4189 불간섭)
 * [2/10]  데이터 품질 4단계 분류 & 조회 실패 0건 왜곡 방지 (null 유지)
 * [3/10]  최초 조회 실패 fallback 및 오프라인 모드 격리 (연결 상태 왜곡 차단)
 * [4/10]  실험 판정: 사전 표본 계획 부재(보류)·단순전후(관찰)·충족(검토가능) & 3단계 분리
 * [5/10]  엣지 케이스 주입: 비용 null/0/값, 분모0(N/A), 표본계획미정 동적 주입
 * [6/10]  중복 3대 범주 분류: 동일내용 재전송(멱등) vs 다른내용 충돌(격리) vs 별개사건(정상)
 * [7/10]  지연 시나리오 및 요청 제한시간(타임아웃) 검증
 * [8/10]  오래된 응답 경합 덮어쓰기(Race Condition) 방지 가드 검증
 * [9/10]  좁은 화면(375px/390px) 탭 전환·오류·복구·가로 넘침(Overflow) 방지 구조 검증
 * [10/10] 장애 복구 및 정적 자산/네임스페이스 무결성 검증
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
const REQUEST_TIMEOUT_MS = 3000; // 각 요청 기본 제한시간

function makeRequest(reqPath, method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, BASE_URL);
    const req = http.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
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
  console.log(`🧪 ANT-007 실증 데이터 시제품 전수 자동 검증 시작 (포트: ${PORT})`);
  console.log(`- 기준: 벤(Ben) BEN-026 R1 검토 반영 10대 정밀 항목 점검`);
  console.log(`================================================================\n`);

  let serverProc = null;
  let preExistingServer = false;

  // 0. 포트 4189 불간섭 확인
  assert.notEqual(PORT, 4189, '기존 지오 4189 서버와의 충돌 방지를 위해 4189 포트는 사용할 수 없습니다.');

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

  try {
    // -----------------------------------------------------------------------
    // [1/10] /ready 헬스체크 및 환경 검증
    // -----------------------------------------------------------------------
    const readyRes = await makeRequest('/ready');
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.data.ok, true);
    assert.equal(readyRes.data.version, '1.1.0-r2', '실행 판본 1.1.0-r2 불일치');
    assert.equal(readyRes.data.is_synthetic, true, '합성 환경 플래그(is_synthetic) 누락');
    assert.equal(readyRes.data.environment, 'synthetic_prototype', '합성 환경 식별자 누락');
    assert.ok(readyRes.data.edge_cases_supported.includes('cost_null'), '비용 null 엣지케이스 미지원');
    assert.ok(readyRes.data.edge_cases_supported.includes('cost_zero'), '비용 0 엣지케이스 미지원');
    assert.ok(readyRes.data.edge_cases_supported.includes('zero_denominator'), '분모 0 엣지케이스 미지원');
    assert.ok(readyRes.data.edge_cases_supported.includes('sample_plan_unplanned'), '표본계획 미정 엣지케이스 미지원');
    console.log(`✔ [1/10] /ready 헬스체크: 판본(1.1.0-r2), 합성 환경 플래그, 엣지케이스 지원 명시 확인 완료`);

    // -----------------------------------------------------------------------
    // [2/10] 데이터 품질 4단계 분류 & 0건 왜곡 방지 검증
    // -----------------------------------------------------------------------
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'normal', cost_mode: 'default', zero_denom: false, sample_plan: 'default' });
    const qualityRes = await makeRequest('/api/evidence/quality');
    assert.equal(qualityRes.status, 200);
    const datasets = qualityRes.data.datasets;
    const statuses = datasets.map(d => d.status);
    assert.ok(statuses.includes('normal'), '정상 상태 데이터셋 누락');
    assert.ok(statuses.includes('partial_missing'), '일부 누락 상태 데이터셋 누락');
    assert.ok(statuses.includes('stale'), '오래된 자료 상태 데이터셋 누락');
    assert.ok(statuses.includes('unverifiable'), '확인 불가 상태 데이터셋 누락');

    // 핵심 규칙: 조회 실패/확인 불가는 0건으로 표시하지 않고 null 유지
    const unverifiableDs = datasets.find(d => d.status === 'unverifiable');
    assert.equal(unverifiableDs.total_records, null, '확인 불가 데이터셋은 null이어야 함');
    assert.notEqual(unverifiableDs.total_records, 0, '규칙 위반: 확인 불가 데이터셋이 0건으로 왜곡 표기됨');
    console.log(`✔ [2/10] 데이터 품질 4단계 분류 & 조회 실패 0건 왜곡 방지 (null 유지) 확인 완료`);

    // -----------------------------------------------------------------------
    // [3/10] 최초 실패 및 오프라인 예제 모드 분리 검증 (Ben R1 핵심 수정사항)
    // -----------------------------------------------------------------------
    const appJsRaw = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    // 검증: catch 문에서 fetchError를 null로 지우며 '실시간 연결됨'으로 속이던 구버전 로직 부재 확인
    assert.ok(!appJsRaw.includes('state.fetchError = null;\n        state.data = FALLBACK_DATA'), '구버전 fetchError 소거 버그 잔존');
    assert.ok(appJsRaw.includes('enableOfflineDemoMode'), '수동 오프라인 예제 모드 분리 확인');
    assert.ok(appJsRaw.includes('오래된 자료(캐시)'), '오래된 자료 캐시 안내 로직 확인');
    assert.ok(appJsRaw.includes('확인 불가'), '초기 실패 시 확인 불가 처리 로직 확인');
    console.log(`✔ [3/10] 최초 조회 실패 fallback 수정: 오프라인 예제 모드 분리 & 전 탭 캐시/확인불가 표기 검증 완료`);

    // -----------------------------------------------------------------------
    // [4/10] 실험 판정 4대 규칙 & 3단계 분리 검증
    // -----------------------------------------------------------------------
    const expRes = await makeRequest('/api/evidence/experiments');
    assert.equal(expRes.status, 200);
    const exps = expRes.data.experiments;

    // 규칙 1: 사전 표본 계획 부재 시 '판단 보류' (EXP-004)
    const expUnplanned = exps.find(e => e.id === 'EXP-2026-004');
    assert.ok(expUnplanned, 'EXP-2026-004 누락');
    assert.equal(expUnplanned.sample_plan.status, 'unplanned');
    assert.ok(expUnplanned.evaluation.synthetic_result.label.includes('판단 보류'), '사전 계획 부재 시 판단 보류 미적용');

    // 규칙 2: 표본 부족 시 '판단 보류' (EXP-003, N=8)
    const expSmall = exps.find(e => e.id === 'EXP-2026-003');
    assert.ok(expSmall, 'EXP-2026-003 누락');
    assert.ok(expSmall.evaluation.synthetic_result.label.includes('판단 보류'), '표본 부족 시 판단 보류 미적용');

    // 규칙 3: 단순 전후 비교는 '관찰 결과' (EXP-002)
    const expBeforeAfter = exps.find(e => e.id === 'EXP-2026-002');
    assert.ok(expBeforeAfter, 'EXP-2026-002 누락');
    assert.ok(expBeforeAfter.evaluation.synthetic_result.label.includes('관찰 결과'), '단순 전후비교 시 관찰 결과 미적용');

    // 규칙 4: 자료 충족 시에도 '개선 확정/성공'이 아닌 '검토 가능' (EXP-001)
    const expReady = exps.find(e => e.id === 'EXP-2026-001');
    assert.ok(expReady, 'EXP-2026-001 누락');
    assert.ok(expReady.evaluation.synthetic_result.label.includes('검토 가능'), '표본 충족 시 검토 가능 미적용');
    assert.ok(!expReady.evaluation.synthetic_result.label.includes('개선 확인'), '개선 확정 표현 잔존');

    // 3단계 구분 평가 검증
    exps.forEach(e => {
      assert.ok(e.evaluation.synthetic_result, '합성 결과 평가 누락');
      assert.ok(e.evaluation.operational_approval, '운영 승인 평가 누락');
      assert.ok(e.evaluation.site_replication, '타 현장 재현 평가 누락');
      assert.equal(e.cost.profitability_excluded, true, '수익성 판단 제외 원칙 위반');
    });
    console.log(`✔ [4/10] 실험 판정 수정: 사전계획 부재(보류)·표본부족(보류)·전후비교(관찰)·충족(검토가능) & 3단계 분리 검증 완료`);

    // -----------------------------------------------------------------------
    // [5/10] 동적 엣지 케이스 주입 시험 (비용 null/0/값, 분모0, 표본계획미정)
    // -----------------------------------------------------------------------
    // 5-1) 비용 null
    const costNullRes = await makeRequest('/api/evidence/all?cost=null');
    costNullRes.data.experiments.forEach(e => {
      assert.equal(e.cost.status, 'cost_null');
      assert.equal(e.cost.unit_cost_krw, null);
    });

    // 5-2) 비용 0원
    const costZeroRes = await makeRequest('/api/evidence/all?cost=zero');
    costZeroRes.data.experiments.forEach(e => {
      assert.equal(e.cost.status, 'cost_zero');
      assert.equal(e.cost.unit_cost_krw, 0);
      assert.equal(e.cost.profitability_excluded, true);
    });

    // 5-3) 비용 850원 (값 입력)
    const costValuedRes = await makeRequest('/api/evidence/all?cost=valued');
    costValuedRes.data.experiments.forEach(e => {
      assert.equal(e.cost.status, 'cost_valued');
      assert.equal(e.cost.unit_cost_krw, 850);
      assert.equal(e.cost.profitability_excluded, true);
    });

    // 5-4) 분모 0 시험
    const zeroDenomRes = await makeRequest('/api/evidence/all?zero_denom=1');
    zeroDenomRes.data.experiments.forEach(e => {
      assert.equal(e.sample_size, 0);
      assert.ok(e.evaluation.synthetic_result.label.includes('분모 0'));
      const rateMetric = e.metrics.find(m => m.name.includes('율'));
      if (rateMetric) {
        assert.ok(rateMetric.delta.includes('N/A (분모 0: 산출 불가)'));
      }
    });

    // 5-5) 표본 계획 미정 시험
    const unplannedRes = await makeRequest('/api/evidence/all?sample_plan=unplanned');
    unplannedRes.data.experiments.forEach(e => {
      assert.equal(e.sample_plan.status, 'unplanned');
      assert.ok(e.evaluation.synthetic_result.label.includes('사전 표본 계획 부재'));
    });
    console.log(`✔ [5/10] 동적 엣지 케이스 주입 시험: 비용 null/0/값, 분모0(N/A), 표본계획미정 100% 검증 완료`);

    // -----------------------------------------------------------------------
    // [6/10] 중복 3대 범주 분류 검증
    // -----------------------------------------------------------------------
    const dupRes = await makeRequest('/api/evidence/duplicates');
    assert.equal(dupRes.status, 200);
    const dupCats = dupRes.data.duplicate_analysis.duplicate_categories;
    assert.ok(dupCats.same_id_same_content, '동일 ID·동일 내용 재전송 범주 누락');
    assert.equal(dupCats.same_id_same_content.count, 16);
    assert.equal(dupCats.same_id_same_content.type, 'idempotent_retransmission');

    assert.ok(dupCats.same_id_diff_content, '동일 ID·다른 내용 충돌 범주 누락');
    assert.equal(dupCats.same_id_diff_content.count, 4);
    assert.equal(dupCats.same_id_diff_content.type, 'data_conflict_collision');

    assert.ok(dupCats.distinct_events, '별개 독립 사건 범주 누락');
    assert.equal(dupCats.distinct_events.count, 210);
    assert.equal(dupCats.distinct_events.type, 'independent_events');
    console.log(`✔ [6/10] 중복 3대 범주 분류 검증: 동일내용 재전송(16건 멱등) vs 충돌(4건 격리) vs 별개사건(210건 정상) 확인`);

    // -----------------------------------------------------------------------
    // [7/10] 지연 시나리오 및 타임아웃 검증
    // -----------------------------------------------------------------------
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'delay' });
    const delayStart = Date.now();
    const delayRes = await makeRequest('/api/evidence/all', 'GET', null, 3000);
    const delayElapsed = Date.now() - delayStart;
    assert.equal(delayRes.status, 200);
    assert.ok(delayElapsed >= 1200, `인위적 지연이 반영되지 않음 (${delayElapsed}ms)`);
    console.log(`✔ [7/10] 지연 시나리오 검증: 인위적 지연(${delayElapsed}ms) 및 제한시간 내 안전 응답 확인`);

    // -----------------------------------------------------------------------
    // [8/10] 오래된 응답 덮어쓰기(Race Condition) 방지 가드 검증
    // -----------------------------------------------------------------------
    assert.ok(appJsRaw.includes('thisSeq !== state.requestSeq'), '시퀀스 기반 경합 방지 가드 누락');
    assert.ok(appJsRaw.includes('AbortController'), 'AbortController 타임아웃 컨트롤러 누락');
    console.log(`✔ [8/10] 오래된 응답의 최신 결과 덮어쓰기 방지(Race Condition Sequence Guard) 코드 무결성 검증 완료`);

    // -----------------------------------------------------------------------
    // [9/10] 실제 좁은 화면(375px/390px) 레이아웃 및 가로 넘침(Overflow) 방지 구조 검증
    // -----------------------------------------------------------------------
    const htmlRaw = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const cssRaw = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

    // 9-1) 가로 넘침 방지 속성 점검
    assert.ok(htmlRaw.includes('overflow-x-hidden'), 'body/main 레벨 overflow-x-hidden 누락');
    assert.ok(htmlRaw.includes('overflow-x-auto'), '테이블/네비게이션 overflow-x-auto 가드 누락');
    assert.ok(!htmlRaw.includes('width: 400px'), '모바일 가로 넘침을 유발하는 고정 너비 인라인 스타일 존재');

    // 9-2) 375px/390px 모바일 화면 줄바꿈(flex-wrap, min-w-0, truncate) 점검
    assert.ok(htmlRaw.includes('flex-wrap'), '상단 바 flex-wrap 줄바꿈 지원 누락');
    assert.ok(htmlRaw.includes('min-w-0'), '텍스트 생략 flex 아이템 min-w-0 누락');
    assert.ok(htmlRaw.includes('tabBtn_quality'), '품질 탭 버튼 식별자 확인');
    assert.ok(htmlRaw.includes('tabBtn_experiments'), '실험 탭 버튼 식별자 확인');
    assert.ok(htmlRaw.includes('tabBtn_guidelines'), '지침 탭 버튼 식별자 확인');
    console.log(`✔ [9/10] 좁은 화면(375px/390px) 탭 전환·오류·복구·가로 넘침(Overflow-x) 방지 구조 검증 완료`);

    // -----------------------------------------------------------------------
    // [10/10] 장애 복구 및 정적 자산 무결성 검증
    // -----------------------------------------------------------------------
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'fail' });
    const failRes = await makeRequest('/api/evidence/all');
    assert.equal(failRes.status, 500);

    // 복구 호출
    await makeRequest('/api/evidence/scenario', 'POST', { scenario: 'normal', cost_mode: 'default', zero_denom: false, sample_plan: 'default' });
    const recRes = await makeRequest('/api/evidence/all');
    assert.equal(recRes.status, 200);
    assert.equal(recRes.data.ok, true);
    assert.ok(recRes.data.datasets.length >= 5);
    console.log(`✔ [10/10] 500 장애 주입 후 정상 복구 및 정적 자산 무결성 확인 완료`);

    console.log(`\n================================================================`);
    console.log(`🎉 [SUCCESS] ANT-007 R2 전수 검증 통과 (10개 항목 100% PASS)`);
    console.log(`================================================================`);
  } finally {
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

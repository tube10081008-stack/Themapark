/**
 * prototypes/evidence/ANT-007/server.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026) 전용 모의 서버
 * - 무의존 순수 Node.js HTTP 서버 (Zero External Dependency)
 * - 기존 4189 포트 절대 미접촉 (기본 포트 4192, 동적 포트 인자 지원)
 * - 7종 시나리오(정상, 빈자료, 지연, 실패, 복구, 중복자료, 모바일) 주입 지원
 * - 준비 확인(/ready)에 실행 판본(1.1.0-r2), 합성 환경 플래그, 엣지케이스 지원 명시
 * - 엣지 케이스 시험 수단: 비용 null/0/값, 분모0, 표본 계획 미정 동적 주입
 * - 중복 3대 범주(동일 ID·동일 내용 재전송, 동일 ID·다른 내용 충돌, 별개 사건) 분류 제공
 */

const http = require('http');
const fs = require('fs');
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
  return 4192; // 기본 포트: 4189와 완전 격리된 4192
}

const PORT = parsePort();
const HOST = '0.0.0.0';
const BASE_DIR = __dirname;
const DATA_FILE = path.join(BASE_DIR, 'data', 'synthetic_evidence_data.json');
const PID_FILE = path.join(BASE_DIR, '.server.pid');
const VERSION = '1.1.0-r2';

let activeScenario = 'normal'; // 'normal' | 'empty' | 'delay' | 'fail' | 'duplicate'
let artificialDelayMs = 0;

// 동적 엣지 케이스 주입 상태
let activeCostMode = 'default';      // 'default' | 'null' | 'zero' | 'valued'
let activeZeroDenom = false;         // false | true (분모 0 시험)
let activeSamplePlanMode = 'default'; // 'default' | 'unplanned' (표본 계획 미정 시험)

function loadMasterData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load synthetic data:', err);
    return { meta: {}, datasets: [], experiments: [], guidelines: [] };
  }
}

function getScenarioData(scenario, overrides = {}) {
  const master = loadMasterData();
  const costMode = overrides.costMode || activeCostMode;
  const zeroDenom = (overrides.zeroDenom !== undefined) ? overrides.zeroDenom : activeZeroDenom;
  const samplePlanMode = overrides.samplePlanMode || activeSamplePlanMode;

  if (scenario === 'empty') {
    return {
      meta: {
        ...master.meta,
        version: VERSION,
        scenario: 'empty',
        note: '빈 자료 시뮬레이션 상태 (0건 등록)'
      },
      datasets: [],
      experiments: [],
      guidelines: [],
      duplicate_analysis: {
        total_ingested: 0,
        unique_events: 0,
        duplicate_categories: {}
      }
    };
  }

  const cloned = JSON.parse(JSON.stringify(master));
  cloned.meta.version = VERSION;
  cloned.meta.scenario = scenario;

  // 1. 중복 자료 시나리오
  if (scenario === 'duplicate') {
    if (cloned.datasets.length > 0) {
      cloned.datasets[0].duplicate_records = 20;
      cloned.datasets[0].quality_summary = '⚠️ 중복 레코드 감지: 동일 내용 재전송 16건 + 다른 내용 충돌 4건. 3대 기준별 분류 정제 진행.';
    }
  }

  // 2. 비용 엣지 케이스 주입 (null / 0 / 값)
  if (costMode !== 'default') {
    cloned.experiments.forEach(exp => {
      if (costMode === 'null') {
        exp.cost = {
          status: 'cost_null',
          unit_cost_krw: null,
          cost_label: '비용 미입력 (null)',
          warning: '음료 원가 및 조제 인건비 미기입 상태. 0원으로 자동 산정하지 않으며 수익성 판단 및 ROI 산출은 전면 제외됩니다.',
          profitability_excluded: true
        };
      } else if (costMode === 'zero') {
        exp.cost = {
          status: 'cost_zero',
          unit_cost_krw: 0,
          cost_label: '명시적 비용 0원',
          warning: '직접 비용 0원으로 명시 등록됨. 간접비(시설 유지·통신 감가상각) 미포함 구조이므로 수익성 판단은 전면 제외됩니다.',
          profitability_excluded: true
        };
      } else if (costMode === 'valued') {
        exp.cost = {
          status: 'cost_valued',
          unit_cost_krw: 850,
          cost_label: '단위 원가 850원',
          warning: '단위 제조원가(사과농축액 등 850원) 입력됨. 단, 전체 회계 대사 및 간접비 미연결 상태이므로 수익성 판단은 전면 제외됩니다.',
          profitability_excluded: true
        };
      }
    });
  }

  // 3. 분모 0 엣지 케이스 주입
  if (zeroDenom) {
    cloned.experiments.forEach(exp => {
      exp.sample_size = 0;
      exp.sample_status = 'zero_denominator';
      exp.metrics.forEach(m => {
        if (m.name.includes('율') || m.name.includes('비율')) {
          m.control_value = '0/0';
          m.experiment_value = '0/0';
          m.delta = 'N/A (분모 0: 산출 불가)';
          m.trend = 'neutral';
        }
      });
      exp.results_summary = '표본 또는 모수 분모가 0으로 산출이 불가능한 상태(Zero Denominator)입니다. 지표 왜곡(NaN/Infinity)을 방지하고 산출 불가로 표시합니다.';
      exp.evaluation.synthetic_result = {
        status: 'pending_inconclusive',
        label: '판단 보류 (분모 0: 산출 불가)',
        detail: '모수 또는 유효 표본 분모가 0건으로 산출할 수 없어 판단을 보류합니다.'
      };
    });
  }

  // 4. 표본 계획 미정 엣지 케이스 주입
  if (samplePlanMode === 'unplanned') {
    cloned.experiments.forEach(exp => {
      exp.sample_plan = {
        status: 'unplanned',
        target_n: null,
        rationale: '사전 표본 산정 계획 미수립 (표본 계획 미정)'
      };
      exp.sample_status = 'unplanned';
      exp.evaluation.synthetic_result = {
        status: 'pending_inconclusive',
        label: '판단 보류 (사전 표본 계획 부재)',
        detail: '표본 수집 여부와 무관하게 사전 표본 계획(검정력·효과크기)이 수립되지 않아 개선이나 유의성을 확정하지 않고 판단을 보류합니다.'
      };
    });
  }

  return cloned;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS 및 캐시 방지 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  // 1. 준비 확인 엔드포인트 (/ready)
  if (pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      status: 'ready',
      service: 'ANT-007-evidence-prototype',
      version: VERSION,
      is_synthetic: true,
      environment: 'synthetic_prototype',
      port: PORT,
      server_pid: process.pid,
      active_scenario: activeScenario,
      edge_cases_supported: [
        'cost_null',
        'cost_zero',
        'cost_valued',
        'zero_denominator',
        'sample_plan_unplanned'
      ],
      active_edge_cases: {
        cost_mode: activeCostMode,
        zero_denominator: activeZeroDenom,
        sample_plan_mode: activeSamplePlanMode
      },
      timestamp: new Date().toISOString()
    }));
  }

  // 2. 셧다운 엔드포인트 (/api/evidence/shutdown)
  if (pathname === '/api/evidence/shutdown' && (req.method === 'POST' || req.method === 'GET')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'ANT-007 시제품 서버를 종료합니다.' }));
    setTimeout(() => {
      try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
      process.exit(0);
    }, 300);
    return;
  }

  // 3. 시나리오 및 엣지 케이스 변경 엔드포인트 (/api/evidence/scenario)
  if (pathname === '/api/evidence/scenario' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', () => {
      let body = {};
      try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}

      if (body.scenario !== undefined) activeScenario = body.scenario;
      if (body.cost_mode !== undefined) activeCostMode = body.cost_mode;
      if (body.zero_denom !== undefined) activeZeroDenom = Boolean(body.zero_denom);
      if (body.sample_plan !== undefined) activeSamplePlanMode = body.sample_plan;
      artificialDelayMs = (activeScenario === 'delay') ? 1500 : (body.delay_ms || 0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        message: `시나리오 설정이 갱신되었습니다.`,
        active_scenario: activeScenario,
        delay_ms: artificialDelayMs,
        cost_mode: activeCostMode,
        zero_denominator: activeZeroDenom,
        sample_plan_mode: activeSamplePlanMode
      }));
    });
    return;
  }

  // 4. REST API 엔드포인트들 (/api/evidence/...)
  if (pathname.startsWith('/api/evidence/')) {
    const handleApiResponse = () => {
      // 쿼리 파라미터 통한 실시간 오버라이드 지원
      const qCost = parsedUrl.searchParams.get('cost');
      const qZeroDenom = parsedUrl.searchParams.get('zero_denom');
      const qSamplePlan = parsedUrl.searchParams.get('sample_plan');
      const qScenario = parsedUrl.searchParams.get('scenario') || activeScenario;

      const overrides = {
        costMode: qCost || activeCostMode,
        zeroDenom: qZeroDenom !== null ? qZeroDenom === '1' || qZeroDenom === 'true' : activeZeroDenom,
        samplePlanMode: qSamplePlan || activeSamplePlanMode
      };

      // 실패 시나리오 강제 주입
      if (qScenario === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false,
          error: 'DATABASE_PIPELINE_ERROR',
          message: '실증 데이터 원장 파이프라인 통신 실패 (시뮬레이션)',
          timestamp: new Date().toISOString()
        }));
      }

      const data = getScenarioData(qScenario, overrides);

      if (pathname === '/api/evidence/quality') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          meta: data.meta,
          datasets: data.datasets,
          duplicate_analysis: data.duplicate_analysis
        }));
      }

      if (pathname === '/api/evidence/experiments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          meta: data.meta,
          experiments: data.experiments
        }));
      }

      if (pathname === '/api/evidence/guidelines') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          meta: data.meta,
          guidelines: data.guidelines
        }));
      }

      if (pathname === '/api/evidence/duplicates') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          meta: data.meta,
          duplicate_analysis: data.duplicate_analysis
        }));
      }

      if (pathname === '/api/evidence/all') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...data }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    };

    if (artificialDelayMs > 0) {
      setTimeout(handleApiResponse, artificialDelayMs);
    } else {
      handleApiResponse();
    }
    return;
  }

  // 5. 정적 파일 서빙
  let filePath = pathname === '/' ? path.join(BASE_DIR, 'index.html') : path.join(BASE_DIR, pathname);

  // 보안 가드: 상위 디렉터리 경로 탐색 차단
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>404 Not Found</h1><p>File not found: ${pathname}</p>`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log('================================================================');
  console.log(`🚀 ANT-007 실증 데이터 시제품 서버 가동 완료 (${VERSION})`);
  console.log(`- 포트: ${PORT} (0.0.0.0 바인딩, 4189 간섭 0%)`);
  console.log(`- 서버 PID: ${process.pid} (기록: ${PID_FILE})`);
  console.log(`- 접속 URL: http://127.0.0.1:${PORT}/`);
  console.log(`- 준비 확인: http://127.0.0.1:${PORT}/ready`);
  console.log(`- 기본 시나리오: ${activeScenario}`);
  console.log(`- 엣지 케이스 지원: 비용 null/0/값, 분모0, 표본계획미정`);
  console.log('================================================================');
});

// 안전한 프로세스 종료 처리
process.on('SIGINT', () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});

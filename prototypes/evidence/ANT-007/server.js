/**
 * prototypes/evidence/ANT-007/server.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026) 전용 모의 서버
 * - 무의존 순수 Node.js HTTP 서버 (Zero External Dependency)
 * - 기존 4189 포트 절대 미접촉 (기본 포트 4192, 동적 포트 인자 지원)
 * - 7종 시나리오(정상, 빈자료, 지연, 실패, 복구, 중복자료, 모바일) 주입 지원
 * - 준비 확인(/ready), 상태 API, 정적 파일 서빙, 안전 셧다운 제공
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

let activeScenario = 'normal'; // 'normal' | 'empty' | 'delay' | 'fail' | 'duplicate'
let artificialDelayMs = 0;

function loadMasterData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load synthetic data:', err);
    return { meta: {}, datasets: [], experiments: [], guidelines: [] };
  }
}

function getScenarioData(scenario) {
  const master = loadMasterData();
  if (scenario === 'empty') {
    return {
      meta: { ...master.meta, scenario: 'empty', note: '빈 자료 시뮬레이션 상태' },
      datasets: [],
      experiments: [],
      guidelines: []
    };
  }

  if (scenario === 'duplicate') {
    const cloned = JSON.parse(JSON.stringify(master));
    // 중복 자료 인위적 주입
    if (cloned.datasets.length > 0) {
      cloned.datasets[0].duplicate_records = 18;
      cloned.datasets[0].quality_summary = '⚠️ 중복 레코드 18건 감지: 동일 보호자 태그 2중 입력 발생. 정제 필요.';
      cloned.datasets.push({
        ...cloned.datasets[0],
        id: 'ds_visit_log_dup_copy',
        name: '[중복 수집본] 보호자 및 아동 방문·체류 로그',
        status: 'partial_missing'
      });
    }
    return {
      meta: { ...cloned.meta, scenario: 'duplicate', note: '중복 자료 감지 시뮬레이션 상태' },
      datasets: cloned.datasets,
      experiments: cloned.experiments,
      guidelines: cloned.guidelines
    };
  }

  return master;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
      version: '1.0.0',
      port: PORT,
      server_pid: process.pid,
      active_scenario: activeScenario,
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

  // 3. 시나리오 변경 엔드포인트 (/api/evidence/scenario)
  if (pathname === '/api/evidence/scenario' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', chunk => bodyStr += chunk);
    req.on('end', () => {
      let body = {};
      try { if (bodyStr) body = JSON.parse(bodyStr); } catch (e) {}
      const targetScenario = body.scenario || 'normal';
      activeScenario = targetScenario;
      artificialDelayMs = (targetScenario === 'delay') ? 1500 : (body.delay_ms || 0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        message: `시나리오가 '${activeScenario}'(으)로 변경되었습니다.`,
        active_scenario: activeScenario,
        delay_ms: artificialDelayMs
      }));
    });
    return;
  }

  // 4. REST API 엔드포인트들 (/api/evidence/...)
  if (pathname.startsWith('/api/evidence/')) {
    const handleApiResponse = () => {
      // 실패 시나리오 강제 주입
      if (activeScenario === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false,
          error: 'DATABASE_PIPELINE_ERROR',
          message: '실증 데이터 원장 파이프라인 통신 실패 (시뮬레이션)',
          timestamp: new Date().toISOString()
        }));
      }

      const data = getScenarioData(activeScenario);

      if (pathname === '/api/evidence/quality') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          meta: data.meta,
          datasets: data.datasets,
          summary: {
            total_datasets: data.datasets.length,
            normal_count: data.datasets.filter(d => d.status === 'normal').length,
            partial_missing_count: data.datasets.filter(d => d.status === 'partial_missing').length,
            stale_count: data.datasets.filter(d => d.status === 'stale').length,
            unverifiable_count: data.datasets.filter(d => d.status === 'unverifiable').length
          }
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
  console.log(`🚀 ANT-007 실증 데이터 시제품 서버 가동 완료`);
  console.log(`- 포트: ${PORT} (0.0.0.0 바인딩, 4189 간섭 0%)`);
  console.log(`- 서버 PID: ${process.pid} (기록: ${PID_FILE})`);
  console.log(`- 접속 URL: http://127.0.0.1:${PORT}/`);
  console.log(`- 준비 확인: http://127.0.0.1:${PORT}/ready`);
  console.log(`- 기본 시나리오: ${activeScenario}`);
  console.log('================================================================');
});

// 안전한 종료 처리
process.on('SIGINT', () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
  process.exit(0);
});

/**
 * 합성 시험 서버 종료 스크립트
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const PID_FILE = path.join(__dirname, '.synthetic_server.pid');
const PORT = 4185;

async function tryHttpShutdown() {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${PORT}/api/synthetic/shutdown`, { method: 'POST', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function stopServer() {
  console.log('🛑 지오 합성 시험 서버 종료 시도 중...');

  // 1. HTTP Graceful Shutdown 시도
  const httpOk = await tryHttpShutdown();
  if (httpOk) {
    console.log('✔ HTTP 셧다운 요청 성공: 서버가 정상 종료되었습니다.');
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    process.exit(0);
  }

  // 2. PID 파일 기반 프로세스 강제 종료 시도
  if (fs.existsSync(PID_FILE)) {
    const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`✔ PID ${pid} 프로세스에 종료 신호를 전달했습니다.`);
      } catch (err) {
        if (err.code === 'ESRCH') {
          console.log(`ℹ PID ${pid} 프로세스가 이미 실행 중이지 않습니다.`);
        } else {
          console.warn(`⚠️ 프로세스 종료 중 오류: ${err.message}`);
        }
      }
      try { fs.unlinkSync(PID_FILE); } catch (e) {}
      process.exit(0);
    }
  }

  console.log('ℹ 실행 중인 합성 시험 서버가 없습니다.');
}

stopServer();

const test = require('node:test');
const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browserExe = fs.existsSync(edgePath) ? edgePath : (fs.existsSync(chromePath) ? chromePath : null);

function dumpDom(relPath, width, height) {
  if (!browserExe) {
    throw new Error('No supported headless browser found');
  }
  const absPath = path.resolve(__dirname, '..', relPath);
  const fileUrl = 'file:///' + absPath.replace(/\\/g, '/');
  const cmd = `"${browserExe}" --headless=new --disable-gpu --window-size=${width},${height} --virtual-time-budget=2000 --dump-dom "${fileUrl}"`;
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

test('Headless Browser DOM & Viewport Layout Verification (Edge / Chrome)', async (t) => {
  if (!browserExe) {
    t.skip('Headless browser executable not available in environment');
    return;
  }

  const viewports = [
    { name: 'Mobile (390x844)', width: 390, height: 844 },
    { name: 'Desktop (1440x900)', width: 1440, height: 900 }
  ];

  for (const vp of viewports) {
    await t.test(`1. [${vp.name}] index.html 포털 메인 렌더링 검증`, () => {
      const dom = dumpDom('index.html', vp.width, vp.height);
      assert.ok(dom.includes('리틀포레스트') || dom.includes('봉플레이'), '포털 타이틀 렌더링 확인');
      assert.ok(dom.includes('href="pages/booking.html"'), '예약 링크 렌더링 확인');
      assert.ok(dom.includes('href="pages/operations.html"'), '운영 링크 렌더링 확인');
      assert.ok(dom.includes('href="pages/gate.html"'), '게이트 링크 렌더링 확인');
    });

    await t.test(`2. [${vp.name}] pages/booking.html 예약 화면 및 기준정보/게스트 고지 검증`, () => {
      const dom = dumpDom('pages/booking.html', vp.width, vp.height);
      assert.ok(dom.includes('리틀포레스트 봉플레이'), '브랜드명 고지 확인');
      assert.ok(dom.includes('15,000원'), '기본권 15,000원 표기 확인');
      assert.ok(!dom.includes('14,000원'), '구 요금 14,000원 미노출 확인');
      assert.ok(!dom.includes('오픈할인'), '오픈할인 배지 미노출 확인');
      assert.ok(dom.includes('운영시간 확정 후 안내'), '운영시간 미정 안내 고지 확인');
    });

    await t.test(`3. [${vp.name}] pages/gate.html 출입 게이트 및 정원 집계 UI 렌더링 검증`, () => {
      const dom = dumpDom('pages/gate.html', vp.width, vp.height);
      assert.ok(dom.includes('게이트') || dom.includes('입장') || dom.includes('체류'), '게이트 인터페이스 렌더링 확인');
      assert.ok(dom.includes('currentInsideCount'), '실시간 원내 체류 카운터 요소 존재 확인');
      assert.ok(dom.includes('occupancyProgressBar'), '재실률 프로그레스 바 요소 존재 확인');
    });

    await t.test(`4. [${vp.name}] pages/operations.html 매표 현장 운영 콘솔 렌더링 검증`, () => {
      const dom = dumpDom('pages/operations.html', vp.width, vp.height);
      assert.ok(dom.includes('매표') || dom.includes('발권') || dom.includes('운영'), '매표 운영 콘솔 렌더링 확인');
      assert.ok(dom.includes('syncStatusBadge') || dom.includes('bongplay-sync'), '동기화 상태 뱃지 요소 확인');
    });

    await t.test(`5. [${vp.name}] pages/closing.html 일일 마감 정산 화면 렌더링 검증`, () => {
      const dom = dumpDom('pages/closing.html', vp.width, vp.height);
      assert.ok(dom.includes('마감') || dom.includes('정산'), '마감 정산 인터페이스 렌더링 확인');
      assert.ok(dom.includes('closingDate') || dom.includes('date'), '정산 기준 일자 요소 확인');
    });

    await t.test(`6. [${vp.name}] pages/safety-check.html 일일 안전점검 인터록 렌더링 검증`, () => {
      const dom = dumpDom('pages/safety-check.html', vp.width, vp.height);
      assert.ok(dom.includes('안전점검') || dom.includes('점검표'), '안전점검 인터페이스 렌더링 확인');
      assert.ok(dom.includes('facility') || dom.includes('점검'), '시설 점검 항목 존재 확인');
    });
  }
});

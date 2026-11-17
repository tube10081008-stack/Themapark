// 사용: node render.js <입력.html> <출력.pdf>
// Playwright(chromium)로 A4 PDF를 만들고, 쪽마다 [본문 끝, 바닥글 위치]를 출력한다. 본문 끝 > 바닥글이면 넘침.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [inp, out] = process.argv.slice(2);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 794, height: 1123 } });
  await p.goto('file://' + path.resolve(inp), { waitUntil: 'networkidle' }); await p.evaluate(() => document.fonts.ready);
  console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.pg')].map(pg => { const f = pg.querySelector('.foot').getBoundingClientRect().top; let m = 0; pg.querySelectorAll('*').forEach(e => { if (!e.closest('.foot')) m = Math.max(m, e.getBoundingClientRect().bottom); }); return [Math.round(m), Math.round(f)]; }))));
  await p.pdf({ path: out, width: '210mm', height: '297mm', printBackground: true }); await b.close();
})();

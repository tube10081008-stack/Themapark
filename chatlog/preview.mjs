/**
 * 배포하지 않고 화면만 확인하는 도구.
 *
 *   node preview.mjs      →  preview.local.html 생성 (브라우저로 열면 됨)
 *
 * google.script.run 을 가짜 응답으로 바꿔치기하므로 Gemini도 시트도 건드리지 않는다.
 * index.html 을 고칠 때마다 다시 실행하면 된다. 생성물은 .gitignore 에 있다.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const FAKE = {
  getConfig: {
    sheetUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE',
    needsAccessCode: true,
    owners: ['성현', '지연', '주성', '공통', '미지정'],
    priorities: ['HIGH', 'MEDIUM', 'LOW'],
    statuses: ['대기', '진행', '완료', '검토', '보류'],
    categories: ['DECISION', 'TODO', 'INFO', 'IDEA'],
    categoryTag: { DECISION: '[결정]', TODO: '[할일]', INFO: '[공유]', IDEA: '[아이디어]' },
    today: '2026-09-14',
    noDue: '미정',
  },
  classify: {
    elapsedMs: 1840,
    items: [
      { category: 'DECISION', summary: '매표소 포스기 렌탈 vs 구매 확정 필요', owner: '성현', due_date: '2026-09-15', priority: 'HIGH', status: '대기', context: '월 30만 vs 일시불 150만 견적 비교 건' },
      { category: 'TODO', summary: '짚코스터 하네스 일일점검 체크리스트 초안 작성', owner: '주성', due_date: '2026-10-05', priority: 'HIGH', status: '대기', context: '제조사 매뉴얼 기반 작성 요청' },
      { category: 'INFO', summary: '군청 관광과 주무관 통화 완료 (인허가 실사 일정)', owner: '성현', due_date: '미정', priority: 'MEDIUM', status: '완료', context: '금요일 오후 현장 방문 예정' },
      { category: 'IDEA', summary: '동절기 눈썰매 연계 패키지 구성', owner: '지연', due_date: '미정', priority: 'LOW', status: '검토', context: '11월 오픈 이후 12월 회의 안건으로 이첩' },
    ],
  },
  appendItems: { count: 0, sheetUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE' },
};

const head = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>봉뜨락 업무로그 (미리보기)</title>
<script>
var FAKE = ${JSON.stringify(FAKE)};
function runner() {
  var ok = function () {}, fail = function () {};
  var api = {
    withSuccessHandler: function (f) { ok = f; return api; },
    withFailureHandler: function (f) { fail = f; return api; },
  };
  api.getConfig = function () { setTimeout(function () { ok(FAKE.getConfig); }, 150); };
  api.classify = function () { setTimeout(function () { ok(FAKE.classify); }, 900); };
  api.appendItems = function (items) {
    setTimeout(function () { ok({ count: items.length, sheetUrl: FAKE.appendItems.sheetUrl }); }, 400);
  };
  return api;
}
var google = { script: {} };
Object.defineProperty(google.script, 'run', { get: runner });
<\/script>
</head><body>
`;

const body = readFileSync(join(here, 'index.html'), 'utf8');
const out = join(here, 'preview.local.html');
writeFileSync(out, head + body + '\n</body></html>\n');
console.log('생성 완료: ' + out + '\n브라우저로 열어 확인하세요 (접근 코드는 아무 값이나 입력).');

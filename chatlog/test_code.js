/**
 * Code.gs 의 순수 함수(정규화·파싱)를 노드에서 그대로 검증한다.
 * Apps Script 런타임 없이 돌려야 하므로 GAS 전역만 최소한으로 흉내 낸다.
 *
 *   node test_code.js
 *
 * 여기서 검증하는 건 "모델이 이상한 값을 줘도 시트에 이상한 행이 들어가지 않는다" 한 가지다.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  SpreadsheetApp: {},
  HtmlService: {},
  UrlFetchApp: {},
  LockService: {},
  Utilities: { formatDate: () => '2026-09-14 15:30', sleep: () => {} },
  console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'Code.gs' });

// 함수 선언은 샌드박스 전역에 올라오지만, const 상수는 그렇지 않아 따로 꺼낸다.
const { parseModelJson, normalizeItems, normalizeItem, normalizeDue, itemToRow, thinkingConfig, resolveProvider } = sandbox;
const HEADERS = vm.runInContext('HEADERS', sandbox);
const MAX_ITEMS = vm.runInContext('MAX_ITEMS', sandbox);

let passed = 0;
// vm 컨텍스트에서 만들어진 값은 프로토타입이 달라 deepStrictEqual 이 통하지 않는다.
function eq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('parseModelJson');
check('배열 JSON 그대로 파싱', () => {
  eq(parseModelJson('[{"summary":"a"}]'), [{ summary: 'a' }]);
});
check('```json 펜스가 붙어 와도 벗겨낸다', () => {
  eq(parseModelJson('```json\n[{"summary":"a"}]\n```'), [{ summary: 'a' }]);
});
check('{items:[...]} 로 감싸 와도 배열을 꺼낸다', () => {
  eq(parseModelJson('{"items":[{"summary":"a"}]}'), [{ summary: 'a' }]);
});
check('단일 객체는 1건 배열로 취급', () => {
  assert.strictEqual(parseModelJson('{"summary":"a"}').length, 1);
});
check('JSON 이 아니면 사람이 읽을 오류', () => {
  assert.throws(() => parseModelJson('죄송합니다, 정리할 내용이 없습니다.'), /JSON 형식/);
});

console.log('normalizeDue');
check('YYYY-MM-DD 통과', () => assert.strictEqual(normalizeDue('2026-10-05'), '2026-10-05'));
check('2026.9.5 교정', () => assert.strictEqual(normalizeDue('2026.9.5'), '2026-09-05'));
check('2026/09/05 교정', () => assert.strictEqual(normalizeDue('2026/09/05'), '2026-09-05'));
check('미정/빈값/null → 미정', () => {
  ['미정', '', null, undefined, '다음 주'].forEach((v) => assert.strictEqual(normalizeDue(v), '미정'));
});
check('존재하지 않는 날짜(2026-02-30) → 미정', () => {
  assert.strictEqual(normalizeDue('2026-02-30'), '미정');
});

console.log('normalizeItem');
check('모르는 분류는 INFO 로, 상태는 분류별 기본값', () => {
  const item = normalizeItem({ category: 'RANDOM', summary: '가', owner: '홍길동', priority: '급함' });
  assert.strictEqual(item.category, 'INFO');
  assert.strictEqual(item.status, '완료');      // 공유는 이미 일어난 일
  assert.strictEqual(item.owner, '미지정');
  assert.strictEqual(item.priority, 'MEDIUM');
});
check('할일/결정의 기본 상태는 대기, 아이디어는 검토', () => {
  assert.strictEqual(normalizeItem({ category: 'TODO', summary: '가' }).status, '대기');
  assert.strictEqual(normalizeItem({ category: 'DECISION', summary: '가' }).status, '대기');
  assert.strictEqual(normalizeItem({ category: 'IDEA', summary: '가' }).status, '검토');
});
check('소문자 카테고리도 받아들인다', () => {
  assert.strictEqual(normalizeItem({ category: 'todo', summary: '가' }).category, 'TODO');
});
check('줄바꿈·과다 공백은 한 줄로 정리', () => {
  assert.strictEqual(normalizeItem({ summary: ' 가  나\n다 ' }).summary, '가 나 다');
});
check('긴 텍스트는 500자에서 자른다', () => {
  assert.strictEqual(normalizeItem({ summary: 'ㄱ'.repeat(900) }).summary.length, 500);
});

console.log('normalizeItems');
check('요약이 빈 항목과 객체가 아닌 값은 버린다', () => {
  const items = normalizeItems([{ summary: '' }, null, 'text', { category: 'TODO', summary: '유효' }]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].summary, '유효');
});
check('배열이 아니면 빈 배열', () => eq(normalizeItems({ a: 1 }), []));
check('한 번에 ' + MAX_ITEMS + '건을 넘지 않는다', () => {
  const many = Array.from({ length: 80 }, () => ({ category: 'TODO', summary: '가' }));
  assert.strictEqual(normalizeItems(many).length, MAX_ITEMS);
});

console.log('resolveProvider');
check('키가 있는 쪽을 자동으로 고른다', () => {
  assert.strictEqual(resolveProvider(null, null, 'AIza...'), 'gemini');
  assert.strictEqual(resolveProvider(null, 'sk-sakana', null), 'sakana');
});
check('둘 다 있으면 sakana', () => {
  assert.strictEqual(resolveProvider('', 'sk-sakana', 'AIza...'), 'sakana');
});
check('LLM_PROVIDER 가 자동 판별보다 우선', () => {
  assert.strictEqual(resolveProvider('Gemini', 'sk-sakana', 'AIza...'), 'gemini');
  assert.strictEqual(resolveProvider(' sakana ', null, 'AIza...'), 'sakana');
});
check('키가 하나도 없으면 빈 문자열(호출 전에 막힌다)', () => {
  assert.strictEqual(resolveProvider(null, '  ', ''), '');
  assert.strictEqual(resolveProvider('bogus', null, null), '');
});

console.log('thinkingConfig');
check('기본값은 3.x 용 thinkingLevel: low', () => {
  eq(thinkingConfig(null, null), { thinkingLevel: 'low' });
  eq(thinkingConfig('', ''), { thinkingLevel: 'low' });
});
check('대문자·공백 섞인 레벨도 받아들인다', () => {
  eq(thinkingConfig(' HIGH ', null), { thinkingLevel: 'high' });
});
check('예산이 지정되면 2.5 계열용 thinkingBudget 만 보낸다', () => {
  eq(thinkingConfig('low', '0'), { thinkingBudget: 0 });
  eq(thinkingConfig('high', '512'), { thinkingBudget: 512 });
});
check('해석할 수 없는 값이면 thinkingConfig 자체를 생략', () => {
  assert.strictEqual(thinkingConfig('off', null), null);
  assert.strictEqual(thinkingConfig(null, 'off'), null);
});

console.log('itemToRow');
check('시트 컬럼 순서(A~H)와 태그 표기', () => {
  const item = normalizeItem({
    category: 'DECISION',
    summary: '매표소 포스기 렌탈 vs 구매 확정 필요',
    owner: '성현',
    due_date: '2026-09-15',
    context: '월 30만 vs 일시불 150만 견적 비교 건',
    priority: 'HIGH',
  });
  eq(itemToRow(item, '2026-09-14 15:30'), [
    '2026-09-14 15:30', '[결정]', '매표소 포스기 렌탈 vs 구매 확정 필요', '성현',
    '2026-09-15', 'HIGH', '대기', '월 30만 vs 일시불 150만 견적 비교 건',
  ]);
});
check('행 길이가 헤더 수와 같다', () => {
  assert.strictEqual(itemToRow(normalizeItem({ summary: '가' }), 'ts').length, HEADERS.length);
});

console.log('\n' + passed + '개 통과');

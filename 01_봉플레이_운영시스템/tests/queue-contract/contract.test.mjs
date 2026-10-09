// CLAUDE-011 — 발권 대기열 계약 적합성 시험 (키·네트워크·DB 없음).
// 실행 (저장소 루트): node --test 01_봉플레이_운영시스템/tests/queue-contract/contract.test.mjs
// 구현 대조: QUEUE_IMPL=<어댑터 모듈 경로> node --test 01_봉플레이_운영시스템/tests/queue-contract/contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { computeEta, filterSamples, kstBusinessDate, TRANSITIONS, STATES } from './reference-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'scenarios.json'), 'utf8'));
const etaCases = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'eta.json'), 'utf8'));
const IMPL = process.env.QUEUE_IMPL ? pathToFileURL(path.resolve(process.env.QUEUE_IMPL)).href : './reference-adapter.mjs';
const { createQueue } = await import(IMPL);
const BASE = Date.parse(scenarios.base_time);
const STAFF_OPS = new Set(['setCounter', 'callNext', 'transition', 'issueComplete', 'closeDay', 'staffList']);

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function resolveArgs(v, vars) {
  if (typeof v === 'string' && v.startsWith('$')) {
    assert.ok(v.slice(1) in vars, `저장되지 않은 변수 ${v}`);
    return vars[v.slice(1)];
  }
  if (Array.isArray(v)) return v.map((x) => resolveArgs(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveArgs(x, vars)]));
  return v;
}
/** expected 의 모든 키가 actual 에 같은 값으로 있어야 한다 (배열은 같은 위치 부분 일치) */
function partialMatch(actual, expected, where = '$') {
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${where}: 객체 기대, 실제 ${JSON.stringify(actual)}`);
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual) && actual.length >= expected.length, `${where}: 배열 길이 ${actual?.length} < ${expected.length}`);
    }
    for (const [k, v] of Object.entries(expected)) partialMatch(actual[k], v, `${where}.${k}`);
  } else {
    assert.deepEqual(actual, expected, where);
  }
}

for (const sc of scenarios.scenarios) {
  test(`scenario ${sc.id}`, async () => {
    const q = createQueue({ siteId: 'bongplay_bonghwa', accessCode: scenarios.staff_code });
    const vars = {};
    for (const [i, step] of sc.steps.entries()) {
      const label = `${sc.id} step ${i} ${step.op}${step.why ? ` (${step.why})` : ''}`;
      const args = { ...resolveArgs(step.args || {}, vars), serverNow: BASE + step.t * 1000 };
      if (STAFF_OPS.has(step.op) && !('accessCode' in args)) args.accessCode = scenarios.staff_code;
      assert.equal(typeof q[step.op], 'function', `어댑터에 ${step.op} 없음`);
      const res = await q[step.op](args);
      if (step.expect) {
        try { partialMatch(res, resolveArgs(step.expect, vars)); } catch (e) { e.message = `${label}: ${e.message}\n실제: ${JSON.stringify(res)}`; throw e; }
      }
      if (step.expect_keys_only) {
        const extra = Object.keys(res).filter((k) => !step.expect_keys_only.includes(k));
        assert.deepEqual(extra, [], `${label}: 허용되지 않은 응답 키`);
      }
      if (step.expect_item_keys_only) {
        for (const [field, keys] of Object.entries(step.expect_item_keys_only)) {
          for (const item of res[field]) assert.deepEqual(Object.keys(item).sort(), [...keys].sort(), `${label}: ${field} 항목 키`);
        }
      }
      for (const t of step.expect_no_text || []) assert.ok(!JSON.stringify(res).includes(t), `${label}: 응답에 ${t} 노출`);
      for (const [name, p] of Object.entries(step.save || {})) {
        const v = getPath(res, p);
        assert.notEqual(v, undefined, `${label}: 저장할 ${p} 없음`);
        vars[name] = v;
      }
    }
  });
}

// ---- 예상시간 계산 (계약 §10) — 참조 계산식 자체의 검증 -----------------------------
for (const c of etaCases.cases) {
  test(`eta ${c.id}`, () => {
    const r = computeEta({ ...c.input, serverNow: 0 });
    partialMatch(r, c.expect);
    if (r.state === 'range') assert.ok(r.min_minutes <= r.max_minutes, '범위 역전');
    if (r.state !== 'range') assert.equal(r.min_minutes, undefined, '범위가 아닌 상태에서 숫자 노출');
  });
}

test('eta: no fixed per-team constant — result scales with measured samples', () => {
  const work = [{ kind: 'idle' }];
  const fast = computeEta({ samples: [60, 60, 60, 60, 60], counterWork: work, aheadWaiting: 3, serverNow: 0 });
  const slow = computeEta({ samples: [600, 600, 600, 600, 600], counterWork: work, aheadWaiting: 3, serverNow: 0 });
  assert.deepEqual([fast.min_minutes, fast.max_minutes], [3, 3]);
  assert.deepEqual([slow.min_minutes, slow.max_minutes], [30, 30]);
});

test('eta: more counters never increase the estimate (monotonic)', () => {
  const samples = [200, 250, 300, 350, 400, 450];
  for (let ahead = 0; ahead <= 12; ahead++) {
    let prev = Infinity;
    for (let c = 1; c <= 4; c++) {
      const r = computeEta({ samples, counterWork: Array.from({ length: c }, () => ({ kind: 'idle' })), aheadWaiting: ahead, serverNow: 0 });
      assert.ok(r.max_minutes <= prev, `ahead ${ahead}, counters ${c}`);
      prev = r.max_minutes;
    }
  }
});

test('eta: sample filter drops too-short and MAD outliers only', () => {
  assert.deepEqual(filterSamples([10, 29, 30, 300]), [30, 300]);
  assert.deepEqual(filterSamples([300, 310, 320, 330, 5000]), [300, 310, 320, 330]);
});

// ---- 예상시간 표본 제외 규칙 (계약 §10.1) — 참조 모델 경로 ----------------------------
test('eta samples exclude held, paused-counter, ledger-failure and cancelled entries', async () => {
  const q = createQueue({ accessCode: 'S' });
  if (typeof q.validSampleSeconds !== 'function') return; // 구현 어댑터가 제공하지 않으면 건너뜀
  const T = (s) => BASE + s * 1000;
  let n = 0;
  const run = async ({ dur, hold = false, pause = false, ledgerFail = false, cancel = false }) => {
    n++;
    const t0 = n * 10000;
    const cid = `cst_s${n}`;
    await q.submit({ clientRequestId: `r-${n}`, consent: { consent_id: cid }, serverNow: T(t0) });
    const counter = `K${n}`;
    await q.setCounter({ accessCode: 'S', counterId: counter, state: 'open', requestId: `o${n}`, serverNow: T(t0) });
    let r = await q.callNext({ accessCode: 'S', counterId: counter, requestId: `c${n}`, serverNow: T(t0 + 1) });
    const ref = r.entry_ref;
    if (hold) {
      r = await q.transition({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, action: 'hold', requestId: `h${n}`, reason: 'x', serverNow: T(t0 + 2) });
      r = await q.transition({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, action: 'rejoin', requestId: `j${n}`, reason: 'x', serverNow: T(t0 + 3) });
      r = await q.callNext({ accessCode: 'S', counterId: counter, requestId: `c2${n}`, serverNow: T(t0 + 4) });
    }
    r = await q.transition({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, action: 'start_serving', requestId: `s${n}`, serverNow: T(t0 + 5) });
    if (pause) {
      await q.setCounter({ accessCode: 'S', counterId: counter, state: 'paused', requestId: `p${n}`, serverNow: T(t0 + 6) });
      await q.setCounter({ accessCode: 'S', counterId: counter, state: 'open', requestId: `p2${n}`, serverNow: T(t0 + 7) });
    }
    if (cancel) {
      await q.transition({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, action: 'cancel', requestId: `x${n}`, reason: '고객 요청', serverNow: T(t0 + 5 + dur) });
      return;
    }
    if (ledgerFail) await q.issueComplete({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, orderId: `o_${n}`, requestId: `i${n}`, serverNow: T(t0 + 5 + dur - 1) });
    await q.recordLedger({ orderId: `o_${n}`, rec: { consent_id: cid, total: 1, paid: 1, tickets_expected: 1, tickets_active: 1 } });
    await q.issueComplete({ accessCode: 'S', entryRef: ref, expectedVersion: r.version, orderId: `o_${n}`, requestId: `i${n}`, serverNow: T(t0 + 5 + dur) });
  };
  await run({ dur: 240 });
  await run({ dur: 300 });
  await run({ dur: 999, hold: true });
  await run({ dur: 888, pause: true });
  await run({ dur: 777, ledgerFail: true });
  await run({ dur: 666, cancel: true });
  assert.deepEqual(q.validSampleSeconds().sort((a, b) => a - b), [240, 300]);
});

test('myStatus eta states: estimating with few samples, paused with no open counter', async () => {
  const q = createQueue({ accessCode: 'S' });
  const T = (s) => BASE + s * 1000;
  await q.setCounter({ accessCode: 'S', counterId: 'K1', state: 'open', requestId: 'o', serverNow: T(0) });
  await q.submit({ clientRequestId: 'r1', consent: { consent_id: 'c1' }, serverNow: T(1) });
  const s2 = await q.submit({ clientRequestId: 'r2', consent: { consent_id: 'c2' }, serverNow: T(2) });
  let st = await q.myStatus({ token: s2.lookup_token, serverNow: T(3) });
  assert.equal(st.eta.state, 'estimating');
  assert.equal(st.eta.min_minutes, undefined);
  await q.setCounter({ accessCode: 'S', counterId: 'K1', state: 'paused', requestId: 'p', serverNow: T(4) });
  st = await q.myStatus({ token: s2.lookup_token, serverNow: T(5) });
  assert.equal(st.eta.state, 'paused');
});

// ---- 계약 표 자체의 일관성 -------------------------------------------------------
test('transition table: terminal states have no outgoing transitions; every target is a known state', () => {
  for (const [action, t] of Object.entries(TRANSITIONS)) {
    assert.ok(STATES.includes(t.to), action);
    for (const f of t.from) assert.ok(!['issued', 'cancelled', 'closed'].includes(f), `${action} from terminal ${f}`);
  }
  assert.deepEqual(TRANSITIONS.issue.from, ['serving']);
  assert.deepEqual(TRANSITIONS.rejoin.from, ['held']);
  assert.equal(TRANSITIONS.cancel_self.from.includes('serving'), false, '고객은 처리 중 취소 불가');
});

test('KST business date uses server time, not UTC date', () => {
  assert.equal(kstBusinessDate(Date.parse('2026-10-10T14:59:59Z')), '2026-10-10');
  assert.equal(kstBusinessDate(Date.parse('2026-10-10T15:00:00Z')), '2026-10-11');
});

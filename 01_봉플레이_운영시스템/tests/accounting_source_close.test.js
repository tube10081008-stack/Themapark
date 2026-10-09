/**
 * accounting_source_close.test.js — CLAUDE-012 R1: 원천 조회 완전성 · 최종 마감 차단 · 자동매출 정책/잠재 충돌
 * 실행: node --test 01_봉플레이_운영시스템/tests/accounting_source_close.test.js
 * 모든 자료는 합성값이며 서버는 메모리 안의 가짜 PostgREST 다 (운영 DB 접속 없음).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'assets', 'bongplay-accounting.js'));

const POLICY = { auto_sales_start: '2026-10-01', policy_version: 'acct-auto-sales/1', source: '합성 시험' };
const RANGE = { from: '2026-10-01', to: '2026-10-31' };

/* ---------- 가짜 PostgREST (select·order·limit·gte/gt/lt/lte/is.null 만 지원) ---------- */
function fakeServer(tables, opts) {
  opts = opts || {};
  const calls = [];
  const cmp = (a, b) => {
    const ta = /T/.test(a) ? Date.parse(a) : NaN, tb = /T/.test(b) ? Date.parse(b) : NaN;
    if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const select = async (table, query) => {
    calls.push({ table, query });
    if (opts.onCall) opts.onCall(table, query, calls.length, tables);
    if (opts.fail && opts.fail(table, query, calls.filter(c => c.table === table).length)) return { ok: false, data: null, reason: 'http_500' };
    const params = query.replace(/^\?/, '').split('&').filter(Boolean).map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; });
    let rows = (tables[table] || []).slice();
    let cols = '*', order = null, limit = Infinity;
    for (const [k, v] of params) {
      if (k === 'select') { cols = v; continue; }
      if (k === 'order') { order = v.split('.')[0]; continue; }
      if (k === 'limit') { limit = Number(v); continue; }
      const dot = v.indexOf('.'); const op = v.slice(0, dot), val = v.slice(dot + 1);
      rows = rows.filter(r => {
        const x = r[k];
        if (op === 'is') return val === 'null' ? x == null : true;
        if (x == null) return false;
        const c = cmp(String(x), val);
        if (op === 'gte') return c >= 0;
        if (op === 'gt') return opts.gtAsGte ? c >= 0 : opts.ignoreGt ? true : c > 0;
        if (op === 'lt') return c < 0;
        if (op === 'lte') return c <= 0;
        return true;
      });
    }
    if (order) rows.sort((a, b) => cmp(String(a[order]), String(b[order])));
    rows = rows.slice(0, Math.min(limit, opts.maxRows || Infinity));
    if (cols !== '*') { const cs = cols.split(','); rows = rows.map(r => { const o = {}; cs.forEach(c => { o[c] = r[c] == null ? null : r[c]; }); return o; }); }
    else rows = rows.map(r => Object.assign({}, r));
    return { ok: true, data: rows };
  };
  return { select, calls, tables };
}

// 합성 원천: n 건 주문(품목 1·결제 1), 10월에 고르게, 마감기록은 매출일마다
function makeTables(n, opts) {
  opts = opts || {};
  const items = [], payments = [], closings = {};
  for (let i = 0; i < n; i++) {
    const day = 1 + (i % 28), hh = 1 + (i % 7);
    const at = `2026-10-${String(day).padStart(2, '0')}T0${hh}:00:00Z`;
    const oid = `ord_${String(i).padStart(6, '0')}`;
    items.push({ item_id: oid + '_1', id: oid + '_1', order_id: oid, product_category: i % 3 ? 'ticket' : 'fnb', paid_amount: 11000, purchased_at: at, status: 'paid' });
    payments.push({ id: oid + '_pay1', order_id: oid, method: i % 2 ? 'card' : 'cash', amount: 11000, paid_at: at, status: 'paid' });
    closings[`2026-10-${String(day).padStart(2, '0')}`] = 1;
  }
  return {
    order_items: items, order_payments: payments,
    closing_records: opts.noClosings ? [] : Object.keys(closings).map(d => ({ id: d, date: d, diff_amount: 0 }))
  };
}
const goodSnapshot = async (tables, at) => A.applyCollectResult(null, await A.collectSources(fakeServer(tables).select, RANGE, { nowIso: () => at || '2026-11-02T00:00:00.000Z' }));
const ctxOf = (snapshot, extra) => Object.assign({ policy: POLICY, snapshot, pendingCount: 0, seal: null, today: '2026-11-02', nowMs: Date.parse('2026-11-02T00:05:00Z') }, extra || {});

/* ======================= A. 조회 완전성 ======================= */
test('A1 작은 서버 행 상한(7행)에서도 키 기반 조회로 누락 없음', async () => {
  const t = makeTables(53);
  const srv = fakeServer(t, { maxRows: 7 });
  const r = await A.collectSources(srv.select, RANGE, {});
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.counts.items, 53); assert.equal(r.counts.payments, 53);
  assert.equal(new Set(r.data.items.map(x => x.item_id)).size, 53);
  assert.ok(srv.calls.some(c => /item_id=gt\./.test(c.query)), 'offset 이 아니라 마지막 키 다음부터 조회');
  assert.ok(!srv.calls.some(c => /offset=/.test(c.query)));
});

test('A2 2만 행 초과(25,000)도 끝까지 받는다', async () => {
  const t = makeTables(25000);
  const r = await A.collectSources(fakeServer(t).select, RANGE, {});
  assert.equal(r.ok, true);
  assert.equal(r.counts.items, 25000);
  assert.equal(r.counts.payments, 25000);
});

test('A3 중간 실패: 부분 자료를 섞지 않고 마지막 정상 스냅샷 + 미완료 표시 유지', async () => {
  const t = makeTables(30);
  const prev = await goodSnapshot(t);
  t.order_items.push({ item_id: 'ord_new_1', id: 'ord_new_1', order_id: 'ord_new', product_category: 'ticket', paid_amount: 5000, purchased_at: '2026-10-30T01:00:00Z', status: 'paid' });
  const srv = fakeServer(t, { maxRows: 5, fail: (table, q, n) => table === 'order_payments' && n === 4 });
  const res = await A.collectSources(srv.select, RANGE, { nowIso: () => '2026-11-02T01:00:00.000Z' });
  assert.equal(res.ok, false);
  assert.equal(res.data, undefined, '실패 결과에는 자료가 없다');
  assert.equal(res.failures[0].table, 'order_payments');
  const snap = A.applyCollectResult(prev, res);
  assert.equal(snap.counts.items, 30, '새 품목(부분 자료)이 섞이지 않음');
  assert.equal(snap.fetchedAt, prev.fetchedAt);
  assert.equal(snap.lastAttempt.ok, false);
  assert.equal(A.snapshotCovers(snap, RANGE.from, RANGE.to), false, '최근 시도 실패 → 미완료');
});

test('A4 재조회 시 취소·삭제된 행은 범위별 교체로 사라진다', async () => {
  const t = makeTables(10);
  const s1 = await goodSnapshot(t);
  const gone = t.order_items[0].item_id, cancelled = t.order_items[1].item_id;
  t.order_items = t.order_items.filter(x => x.item_id !== gone);
  t.order_payments = t.order_payments.filter(x => x.order_id !== 'ord_000000');
  t.order_items[0].status = 'cancelled'; // ord_000001
  t.order_payments.find(p => p.order_id === 'ord_000001').status = 'cancelled';
  const s2 = A.applyCollectResult(s1, await A.collectSources(fakeServer(t).select, RANGE, {}));
  assert.equal(s2.counts.items, 9);
  assert.ok(!s2.data.items.some(x => x.item_id === gone));
  assert.equal(s2.data.items.find(x => x.item_id === cancelled).status, 'cancelled');
  const books = A.assembleBooks({}, s2.data, { policy: POLICY, today: '2026-11-02' });
  const sales = books.vouchers.filter(v => v.source === 'auto_sales' && !/-CASH$/.test(v.no)).reduce((s, v) => s + v.meta.gross, 0);
  assert.equal(sales, 8 * 11000, '삭제·취소 2건 제외');
});

test('A5 조회 중 동시 변경(앞쪽 키에 새 행 삽입)은 불완전 실패', async () => {
  const t = makeTables(20);
  let inserted = false;
  const srv = fakeServer(t, { maxRows: 6, onCall: (table, q, n, tb) => {
    if (!inserted && table === 'order_items' && /select=item_id,status/.test(q)) {
      inserted = true;
      tb.order_items.push({ item_id: 'ord_000000_0', id: 'ord_000000_0', order_id: 'ord_000000', product_category: 'ticket', paid_amount: 1000, purchased_at: '2026-10-02T01:00:00Z', status: 'paid' });
    } } });
  const r = await A.collectSources(srv.select, RANGE, {});
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'CONCURRENT_CHANGE');
});

test('A6 반복 페이지·진행 없음·키/시각 빈 행·상한 도달은 모두 불완전 실패', async () => {
  const t = makeTables(12);
  const noProg = await A.collectSources(fakeServer(t, { maxRows: 5, ignoreGt: true }).select, RANGE, {});
  assert.equal(noProg.failures[0].reason, 'NO_PROGRESS');
  const rep = await A.collectSources(fakeServer(t, { maxRows: 5, gtAsGte: true }).select, RANGE, {});
  assert.equal(rep.failures[0].reason, 'REPEATED_ROWS');
  const nk = makeTables(3); nk.order_items.push({ item_id: null, id: 'x', order_id: 'x', purchased_at: '2026-10-05T01:00:00Z', paid_amount: 1, status: 'paid' });
  assert.equal((await A.collectSources(fakeServer(nk).select, RANGE, {})).failures[0].reason, 'NULL_KEY');
  const nt = makeTables(3); nt.order_payments.push({ id: 'p_x', order_id: 'x', amount: 1, paid_at: null, status: 'paid' });
  assert.equal((await A.collectSources(fakeServer(nt).select, RANGE, {})).failures[0].reason, 'NULL_TIME');
  assert.equal((await A.collectSources(fakeServer(t).select, RANGE, { maxRows: 5, pageSize: 3 })).failures[0].reason, 'ROW_LIMIT');
  let clock = 0;
  assert.equal((await A.collectSources(fakeServer(t, { maxRows: 2 }).select, RANGE, { now: () => (clock += 1000), maxMs: 3500 })).failures[0].reason, 'TIME_LIMIT');
  assert.equal((await A.collectSources(fakeServer(t).select, { from: '2026-10-31', to: '2026-10-01' }, {})).failures[0].reason, 'BAD_RANGE');
  const cacheSel = async () => ({ ok: true, data: [], from_local_cache: true });
  assert.equal((await A.collectSources(cacheSel, RANGE, {})).failures[0].reason, 'REQUEST_FAILED', '로컬 캐시 응답은 서버 원천으로 인정하지 않음');
});

test('A7 누적 기초자료 부족: 기준월만 받은 스냅샷은 시작일~기준월 범위를 덮지 못한다', async () => {
  const t = makeTables(10);
  const nov = A.applyCollectResult(null, await A.collectSources(fakeServer(t).select, { from: '2026-11-01', to: '2026-11-30' }, {}));
  const need = A.requiredSourceRange(POLICY, '2026-11');
  assert.deepEqual(need, { from: '2026-10-01', to: '2026-11-30' }, '누적 잔액을 위해 시작일부터 필요');
  assert.equal(A.snapshotCovers(nov, need.from, need.to), false);
  const books = A.assembleBooks({}, nov.data, { policy: POLICY, today: '2026-12-02' });
  const rd = A.closeReadiness(books, '2026-11', ctxOf(nov, { today: '2026-12-02', nowMs: Date.parse(nov.fetchedAt) }));
  const src = rd.checks.find(c => c.id === 'SOURCE_COMPLETE');
  assert.equal(src.ok, false);
  assert.match(src.detail, /보유: 2026-11-01/);
});

/* ======================= B. 최종 마감 차단 ======================= */
test('B1 모든 조건이 맞아도 서버 봉인 계약이 없으면 최종 마감 불가', async () => {
  const t = makeTables(28);
  const snap = await goodSnapshot(t);
  const books = A.assembleBooks({}, snap.data, { policy: POLICY, today: '2026-11-02' });
  const rd = A.closeReadiness(books, '2026-10', ctxOf(snap));
  const failed = rd.checks.filter(c => !c.ok).map(c => c.id);
  assert.deepEqual(failed, ['SOURCE_SEALED']);
  assert.equal(rd.ok, false);
  const lock = A.attemptLock({}, books, '2026-10', ctxOf(snap));
  assert.equal(lock.ok, false); assert.equal(lock.reason, 'NOT_READY');
});

test('B2 서버 봉인과 일치할 때만 마감 기록 생성, 불일치·보조조건 위반·오래된 조회는 차단', async () => {
  const t = makeTables(28);
  const snap = await goodSnapshot(t);
  const books = A.assembleBooks({}, snap.data, { policy: POLICY, today: '2026-11-02' });
  const seal = { period: '2026-10', sealed_at: '2026-11-01T15:00:00Z', items_count: 28, items_sum: 28 * 11000, payments_count: 28, payments_sum: 28 * 11000 };
  const ok = A.attemptLock({}, books, '2026-10', ctxOf(snap, { seal, nowIso: '2026-11-02T00:06:00Z' }));
  assert.equal(ok.ok, true, JSON.stringify(ok.readiness && ok.readiness.checks.filter(c => !c.ok)));
  assert.equal(ok.lock.policy.autoSalesStart, '2026-10-01');
  assert.equal(ok.lock.source.counts.items, 28);
  assert.equal(A.attemptLock({ locks: { '2026-10': ok.lock } }, books, '2026-10', ctxOf(snap, { seal })).reason, 'ALREADY_LOCKED');
  const bad = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal: Object.assign({}, seal, { payments_sum: 1 }) }));
  assert.equal(bad.checks.find(c => c.id === 'SOURCE_SEALED').ok, false);
  const pend = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal, pendingCount: 2 }));
  assert.equal(pend.ok, false); assert.equal(pend.checks.find(c => c.id === 'LOCAL_OUTBOX').kind, 'aux');
  const unknown = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal, pendingCount: null }));
  assert.equal(unknown.checks.find(c => c.id === 'LOCAL_OUTBOX').ok, false, '미전송 수를 모르면 미충족');
  const stale = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal, nowMs: Date.parse(snap.fetchedAt) + 11 * 60000 }));
  assert.equal(stale.checks.find(c => c.id === 'SOURCE_COMPLETE').ok, false, '마감 직전 재조회 필요');
  const open = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal, today: '2026-10-31' }));
  assert.equal(open.checks.find(c => c.id === 'PERIOD_ENDED').ok, false);
});

test('B3 일일 마감 기록 누락·대사 오류는 차단 (보조 조건은 필요하지만 충분하지 않음)', async () => {
  const t = makeTables(28, { noClosings: true });
  const snap = await goodSnapshot(t);
  const books = A.assembleBooks({}, snap.data, { policy: POLICY, today: '2026-11-02' });
  const seal = { period: '2026-10', sealed_at: 'x', items_count: 28, items_sum: 28 * 11000, payments_count: 28, payments_sum: 28 * 11000 };
  const rd = A.closeReadiness(books, '2026-10', ctxOf(snap, { seal }));
  assert.equal(rd.checks.find(c => c.id === 'DAILY_CLOSING').ok, false);
  const gapT = makeTables(28); gapT.order_payments[0].amount = 1000;
  const gapSnap = await goodSnapshot(gapT);
  const gapBooks = A.assembleBooks({}, gapSnap.data, { policy: POLICY, today: '2026-11-02' });
  const rd2 = A.closeReadiness(gapBooks, '2026-10', ctxOf(gapSnap, { seal: Object.assign({}, seal, { payments_sum: 27 * 11000 + 1000 }) }));
  const rec = rd2.checks.find(c => c.id === 'RECONCILE');
  assert.equal(rec.ok, false); assert.match(rec.detail, /SALES_PAYMENT_GAP/);
});

test('B4 연 마감도 같은 검사 + 그해 거래월 모두 마감 필요', async () => {
  const t = makeTables(5);
  const snap = await goodSnapshot(t);
  const books = A.assembleBooks({}, snap.data, { policy: POLICY, today: '2027-01-05' });
  const r = A.attemptYearClose({}, books, '2026', ctxOf(snap, { today: '2027-01-05' }));
  assert.equal(r.ok, false);
  assert.ok(r.readiness.checks.some(c => c.id === 'MONTHS_LOCKED' && /2026-10/.test(c.detail)));
  assert.ok(r.readiness.checks.some(c => c.id === 'SOURCE_SEALED' && !c.ok));
});

/* ======================= C. 자동매출 정책 · 잠재 충돌 ======================= */
test('C1 정책 미설정(null)·형식 오류: 자동매출·시재 자동분개·최종 마감 차단, 수기 장부는 유지', () => {
  const t = makeTables(5);
  const manual = [{ no: 'V-2026-10-001', date: '2026-10-02', lines: A.buildFromTemplate('capital_in', { amount: 1000000 }).lines }];
  const closings = [{ id: '2026-10-02', date: '2026-10-02', diff_amount: -500 }];
  for (const p of [{ auto_sales_start: null, policy_version: 'acct-auto-sales/1', source: '미정' }, { auto_sales_start: '2026-13-01' }, undefined]) {
    const books = A.assembleBooks({ manual }, { items: t.order_items, payments: t.order_payments, closings }, { policy: p, today: '2026-11-02' });
    assert.equal(books.vouchers.filter(v => v.source === 'auto_sales').length, 0, '자동매출·시재 전표 없음');
    assert.ok(books.vouchers.some(v => v.no === 'V-2026-10-001'), '수기 장부 조회 가능');
    assert.ok(books.warnings.some(w => /AUTO_SALES_POLICY_(UNSET|INVALID)/.test(w.code)));
    const rd = A.closeReadiness(books, '2026-10', { policy: p, snapshot: null, pendingCount: 0, today: '2026-11-02' });
    assert.equal(rd.checks.find(c => c.id === 'POLICY').ok, false);
    assert.equal(A.attemptLock({}, books, '2026-10', { policy: p, pendingCount: 0, today: '2026-11-02' }).ok, false);
    assert.equal(A.attemptYearClose({}, books, '2026', { policy: p, today: '2027-01-05' }).ok, false);
    assert.equal(A.requiredSourceRange(p, '2026-10'), null);
  }
  assert.equal(A.normalizePolicy({ auto_sales_start: '2026-02-30' }).autoSalesStart, null, '없는 날짜 거부');
  const legacy = A.assembleBooks({ settings: { autoSalesStart: '2026-10-01', manualSalesDates: ['2026-10-03'] } }, {}, { policy: { auto_sales_start: null }, today: '2026-11-02' });
  assert.ok(legacy.warnings.some(w => w.code === 'LEGACY_LOCAL_SETTING_IGNORED'), '기기별 예전 설정은 무시');
});

test('C2 141 상대계정 수기 매출·같은 날 별개 정상 거래 모두 잠재 충돌로 표시, 자동 삭제·제외 없음', () => {
  const day = '2026-10-05';
  const items = [{ item_id: 'o1_1', id: 'o1_1', order_id: 'o1', product_category: 'ticket', paid_amount: 22000, purchased_at: day + 'T02:00:00Z', status: 'paid' }];
  const pays = [{ id: 'o1_p', order_id: 'o1', method: 'card', amount: 22000, paid_at: day + 'T02:00:00Z', status: 'paid' }];
  const voucherSale = { no: 'V-2026-10-010', date: day, lines: [
    { evidence: '기타', memo: '청소년바우처 매출', code: '141', debit: 11000, credit: 0, vat: 0 },
    { evidence: '기타', memo: '매출', code: '401', debit: 0, credit: 10000, vat: 1000 },
    { evidence: '기타', memo: '부가세', code: '220', debit: 0, credit: 1000, vat: 0 }] };
  const rental = { no: 'V-2026-10-011', date: day, lines: A.buildFromTemplate('invoice_sale', { code: '404', gross: 330000, recv: 'bank', partner: '합성 단체' }).lines };
  const state = { manual: [voucherSale, rental], salesReviews: {} };
  const b1 = A.assembleBooks(state, { items, payments: pays }, { policy: POLICY, today: '2026-11-02' });
  const pot = b1.warnings.filter(w => w.code === 'SALES_CONFLICT_POTENTIAL').map(w => w.voucher).sort();
  assert.deepEqual(pot, ['V-2026-10-010', 'V-2026-10-011'], '상대계정(141·102)과 무관하게 탐지');
  assert.ok(pot.every(no => b1.warnings.find(w => w.voucher === no).level === 'warn'), '잠재 충돌은 오류로 단정하지 않음');
  const rev401 = A.incomeStatement(b1.lines, b1.chart, '2026-10-01', '2026-10-31').revenue;
  assert.equal(rev401, 20000 + 10000 + 300000, '자동·수기 모두 그대로 (삭제·상계·제외 없음)');
  assert.ok(A.closeReadiness(b1, '2026-10', { policy: POLICY }).checks.find(c => c.id === 'RECONCILE').detail.includes('SALES_CONFLICT_POTENTIAL'));

  // 명시적 검토: 대관은 별개 거래(근거 기록), 바우처 수기는 중복 판정
  state.salesReviews['V-2026-10-011'] = { decision: 'separate', reference: '세금계산서 합성-001', signature: A.voucherSignature(rental) };
  state.salesReviews['V-2026-10-010'] = { decision: 'duplicate', reference: '', signature: A.voucherSignature(voucherSale) };
  const b2 = A.assembleBooks(state, { items, payments: pays }, { policy: POLICY, today: '2026-11-02' });
  assert.equal(b2.warnings.find(w => w.voucher === 'V-2026-10-011').code, 'SALES_CONFLICT_REVIEWED');
  const dup = b2.warnings.find(w => w.voucher === 'V-2026-10-010');
  assert.equal(dup.code, 'SALES_DUPLICATE_CONFIRMED'); assert.equal(dup.level, 'error');
  assert.ok(b2.vouchers.some(v => v.no === 'V-2026-10-010'), '중복 판정도 자동 삭제하지 않음');

  // 검토 후 전표가 바뀌면 서명이 달라져 다시 잠재 충돌
  rental.lines[0].debit += 1000; rental.lines[1].credit += 1000;
  const b3 = A.assembleBooks(state, { items, payments: pays }, { policy: POLICY, today: '2026-11-02' });
  const again = b3.warnings.find(w => w.voucher === 'V-2026-10-011');
  assert.equal(again.code, 'SALES_CONFLICT_POTENTIAL'); assert.match(again.message, /다시 검토/);
});

test('C3 수익 대변이 없는 같은 날 수기 전표(경비 등)는 충돌이 아니다', () => {
  const day = '2026-10-05';
  const items = [{ item_id: 'o1_1', order_id: 'o1', product_category: 'fnb', paid_amount: 4000, purchased_at: day + 'T02:00:00Z', status: 'paid' }];
  const exp = { no: 'V-2026-10-012', date: day, lines: A.buildFromTemplate('purchase', { code: '509', gross: 55000, evidence: '카드전표', pay: 'card' }).lines };
  const b = A.assembleBooks({ manual: [exp] }, { items, payments: [] }, { policy: POLICY, today: '2026-11-02' });
  assert.ok(!b.warnings.some(w => /SALES_CONFLICT|SALES_DUPLICATE/.test(w.code)));
});

/**
 * accounting_engine.test.js — 회계 순환 자동화 엔진 (assets/bongplay-accounting.js) 회귀 테스트
 * 실행: node --test 01_봉플레이_운영시스템/tests/accounting_engine.test.js
 * 데이터는 모두 합성값이다 (실제 장부·거래처 데이터는 넣지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'assets', 'bongplay-accounting.js'));

const sumD = ls => ls.reduce((s, l) => s + l.debit, 0);
const sumC = ls => ls.reduce((s, l) => s + l.credit, 0);
const item = (id, order, cat, amt, at, extra) => Object.assign({ id: id, order_id: order, product_category: cat, paid_amount: amt, purchased_at: at, status: 'paid' }, extra || {});
const pay = (id, order, method, amt, at, extra) => Object.assign({ id: id, order_id: order, method: method, amount: amt, paid_at: at, status: 'paid' }, extra || {});

test('일일매출 자동 전표: 복합결제·취소·부가세·KST 날짜', () => {
  const items = [
    item('o1_1', 'o1', 'ticket', 21000, '2026-10-06T01:00:00Z'),
    item('o1_2', 'o1', 'fnb', 4000, '2026-10-06T01:00:00Z'),
    item('o2_1', 'o2', 'ticket', 15000, '2026-10-06T02:00:00Z'),
    item('o3_1', 'o3', 'merchandise', 2500, '2026-10-05T16:30:00Z'), // KST 10/6 01:30
    item('o4_1', 'o4', 'ticket', 21000, '2026-10-06T03:00:00Z', { status: 'cancelled' }),
    item('o1_1', 'o1', 'ticket', 21000, '2026-10-06T01:00:00Z') // 로컬·서버 중복
  ];
  const pays = [
    pay('o1_pay1', 'o1', 'local_pay', 20000, '2026-10-06T01:00:00Z'),
    pay('o1_pay2', 'o1', 'cash', 5000, '2026-10-06T01:00:00Z'),
    pay('o2_pay1', 'o2', 'card', 15000, '2026-10-06T02:00:00Z'),
    pay('o3_pay1', 'o3', 'youth_voucher', 2500, '2026-10-05T16:30:00Z'),
    pay('o4_pay1', 'o4', 'card', 21000, '2026-10-06T03:00:00Z', { status: 'cancelled' })
  ];
  const r = A.buildDailySalesVouchers(items, pays, {});
  assert.equal(r.vouchers.length, 1, 'UTC 10/5 16:30 은 KST 10/6 이므로 하루치 전표 1장');
  const v = r.vouchers[0];
  assert.equal(v.date, '2026-10-06');
  assert.equal(sumD(v.lines), sumC(v.lines), '차대 평형');
  assert.equal(sumD(v.lines), 42500, '취소·중복 제외 총액');
  const by = c => v.lines.filter(l => l.code === c);
  assert.equal(by('104')[0].debit, 20000);
  assert.equal(by('101')[0].debit, 5000);
  assert.equal(by('103')[0].debit, 15000);
  assert.equal(by('141')[0].debit, 2500, '청소년 바우처는 지자체 미수금');
  const vat401 = Math.round(36000 / 11), vat403 = Math.round(6500 / 11);
  assert.equal(by('401')[0].credit, 36000 - vat401);
  assert.equal(by('401')[0].vat, vat401, '부가세액은 공급가액 라인 H열에도 기록');
  assert.equal(by('403')[0].credit, 6500 - vat403);
  assert.equal(by('220')[0].credit, vat401 + vat403);
  assert.equal(r.warnings.length, 0);
});

test('결제행 없는 구 주문은 품목 payment_method 로 보완, 대사차이는 경고+임시계정', () => {
  const legacy = A.buildDailySalesVouchers([item('a', 'oa', 'ticket', 11000, '2026-10-07T01:00:00Z', { payment_method: 'cash' })], [], {});
  assert.equal(legacy.vouchers[0].lines.find(l => l.code === '101').debit, 11000);
  const gap = A.buildDailySalesVouchers([item('b', 'ob', 'ticket', 11000, '2026-10-07T01:00:00Z')], [pay('p', 'ob', 'card', 10000, '2026-10-07T01:00:00Z')], {});
  const v = gap.vouchers[0];
  assert.equal(sumD(v.lines), sumC(v.lines));
  assert.equal(v.lines.find(l => l.tag === 'gap').code, '141');
  assert.equal(gap.warnings[0].code, 'SALES_PAYMENT_GAP');
});

test('모든 수기 템플릿은 차대가 맞는 전표를 만든다', () => {
  const chart = A.buildChart();
  const sample = { cleared: 100000, deposit: 98500, amount: 50000, fee: 0, code: '516', gross: 55000, evidence: '카드전표', pay: 'card',
    expense_code: '510', supply: 43000000, vat: 4300000, months: 12, start: '2026-10', asset_code: '160', life: 5,
    recv: 'bank', ee_ins: 200000, tax: 30000, er_ins: 240000, principal: 1000000, interest: 50000, partner: '테스트', memo: '테스트' };
  A.TEMPLATES.forEach(t => {
    const f = Object.assign({}, sample);
    if (t.id === 'payroll') f.gross = 2236300;
    if (t.id === 'loan_in') f.code = '241';
    if (t.id === 'invoice_sale') f.code = '401';
    const r = A.buildFromTemplate(t.id, f, chart);
    assert.equal(sumD(r.lines), sumC(r.lines), t.id + ' 차대 평형');
    r.lines.forEach(l => assert.ok(A.findAccount(chart, l.code), `${t.id}: 계정 ${l.code} 존재`));
  });
  const card = A.buildFromTemplate('card_settle', { cleared: 100000, deposit: 98500, partner: '카드사' }, chart);
  assert.equal(card.lines.find(l => l.code === '515').debit, 1500, '수수료 자동 계산');
  const bad = () => A.buildFromTemplate('card_settle', { cleared: 100, deposit: 200 }, chart);
  assert.throws(bad);
});

test('매입 템플릿: 과세 계정+적격증빙만 매입세액 분리, 불공제는 비용 포함', () => {
  const chart = A.buildChart();
  const taxed = A.buildFromTemplate('purchase', { code: '509', gross: 55000, evidence: '카드전표', pay: 'card' }, chart);
  assert.equal(taxed.lines.find(l => l.code === '135').debit, 5000);
  const noProof = A.buildFromTemplate('purchase', { code: '509', gross: 55000, evidence: '무증빙', pay: 'cash' }, chart);
  assert.equal(noProof.lines.find(l => l.code === '135'), undefined);
  assert.equal(noProof.lines.find(l => l.code === '509').debit, 55000);
});

test('선급비용 기간배분·감가상각: 끝전은 마지막 달, 총액 정확', () => {
  const amort = { id: 'fac', kind: 'amort', name: '시설사용료', expense_code: '510', total: 43000000, months: 12, start: '2026-10' };
  const dep = { id: 'eq', kind: 'dep', name: '키오스크', asset_code: '160', cost: 1000000, salvage: 0, months: 60, start: '2026-10' };
  const periods = A.periodsBetween('2026-09', '2031-12');
  const vs = A.buildScheduleVouchers([amort, dep], periods);
  const total = (prefix) => vs.filter(v => v.no.includes(prefix)).reduce((s, v) => s + v.lines[0].debit, 0);
  assert.equal(total('AMT-fac'), 43000000);
  assert.equal(vs.filter(v => v.no.includes('AMT-fac')).length, 12);
  assert.equal(A.scheduleAmount(amort, '2026-10'), 3583333);
  assert.equal(A.scheduleAmount(amort, '2027-09'), 43000000 - 3583333 * 11);
  assert.equal(A.scheduleAmount(amort, '2026-09'), 0);
  assert.equal(total('DEP-eq'), 1000000);
  vs.forEach(v => assert.equal(sumD(v.lines), sumC(v.lines)));
});

test('부가세 정리: 반기말 220·135 잔액 상계, 예정고지 납부분과 205 상계', () => {
  const chart = A.buildChart();
  const manual = [
    { no: 'V-1', date: '2026-08-01', lines: A.buildFromTemplate('invoice_sale', { code: '401', gross: 1100000, recv: 'bank' }, chart).lines },
    { no: 'V-2', date: '2026-08-02', lines: A.buildFromTemplate('purchase', { code: '516', gross: 220000, evidence: '세금계산서', pay: 'bank' }, chart).lines },
    { no: 'V-3', date: '2026-10-25', lines: A.buildFromTemplate('vat_pay', { amount: 50000 }, chart).lines }
  ];
  const books = A.assembleBooks({ manual: manual }, {}, { today: '2027-01-05' });
  const clear = books.vouchers.find(v => v.no === 'J-2026-12-VAT');
  assert.ok(clear, '2기 말 정리분개 생성');
  assert.equal(clear.lines.find(l => l.code === '205').credit, 100000 - 20000);
  const tb = A.trialBalance(books.lines, books.chart, { to: '2026-12-31' });
  const cum = c => tb.rows.find(r => r.code === c).cumulative;
  assert.equal(cum('220'), 0); assert.equal(cum('135'), 0);
  assert.equal(cum('205'), -(80000 - 50000), '확정신고 때 낼 금액 = 80,000 − 예정고지 50,000');
  assert.equal(books.vouchers.find(v => v.no === 'J-2027-06-VAT'), undefined, '아직 안 끝난 과세기간은 정리하지 않음');
});

test('연 마감: 손익계정 0, 자본 대체, 재무상태표 평형', () => {
  const chart = A.buildChart();
  const manual = [
    { no: 'V-1', date: '2026-10-01', lines: A.buildFromTemplate('capital_in', { amount: 10000000 }, chart).lines },
    { no: 'V-2', date: '2026-10-02', lines: A.buildFromTemplate('invoice_sale', { code: '401', gross: 3300000, recv: 'bank' }, chart).lines },
    { no: 'V-3', date: '2026-10-03', lines: A.buildFromTemplate('expense_plain', { code: '513', amount: 500000, pay: 'bank' }, chart).lines },
    { no: 'V-4', date: '2026-10-04', lines: A.buildFromTemplate('owner_draw', { amount: 200000 }, chart).lines }
  ];
  const books = A.assembleBooks({ manual: manual, settings: { closedYears: ['2026'] } }, {}, { today: '2027-01-10' });
  const tb = A.trialBalance(books.lines, books.chart, { to: '2026-12-31' });
  tb.rows.filter(r => r.type === '수익' || r.type === '비용').forEach(r => assert.equal(r.cumulative, 0, r.code + ' 마감 후 0'));
  assert.equal(tb.rows.find(r => r.code === '302').cumulative, 0);
  const is = A.incomeStatement(books.lines, books.chart, '2026-01-01', '2026-12-31');
  assert.equal(is.net, 3000000 - 500000, '손익계산서는 마감분개를 제외하고 계산');
  const bs = A.balanceSheet(books.lines, books.chart, '2026-12-31');
  assert.ok(bs.balanced);
  assert.equal(tb.rows.find(r => r.code === '301').cumulative, -(10000000 + 2500000 - 200000));
});

const POLICY = { auto_sales_start: '2026-10-01', policy_version: 'acct-auto-sales/1', source: '합성 시험' };

test('검증: 수기·자동 매출 잠재 충돌, 부가세 H열 누락, 카드 미정산 경과', () => {
  const manualSales = { no: 'V-2026-10-005', date: '2026-10-03', lines: [
    { evidence: '카드전표', memo: '일일매출', code: '103', debit: 11000, credit: 0, vat: 0 },
    { evidence: '기타', memo: '부가세', code: '220', debit: 0, credit: 1000, vat: 0 },
    { evidence: '카드전표', memo: '매출', code: '401', debit: 0, credit: 10000, vat: 0 }] };
  const items = [item('x', 'ox', 'ticket', 11000, '2026-10-03T02:00:00Z')];
  const pays = [pay('xp', 'ox', 'card', 11000, '2026-10-03T02:00:00Z')];
  const books = A.assembleBooks({ manual: [manualSales] }, { items: items, payments: pays }, { policy: POLICY, today: '2026-10-20' });
  const codes = books.warnings.map(w => w.code);
  assert.ok(codes.includes('SALES_CONFLICT_POTENTIAL'));
  assert.ok(codes.includes('VAT_LINE_MISMATCH'));
  assert.ok(codes.includes('CARD_UNSETTLED'));
  assert.ok(books.vouchers.some(v => v.no === 'S-2026-10-03') && books.vouchers.some(v => v.no === 'V-2026-10-005'), '자동 삭제·제외 없음');
  const later = A.assembleBooks({ manual: [manualSales] }, { items: items, payments: pays }, { policy: Object.assign({}, POLICY, { auto_sales_start: '2026-10-04' }), today: '2026-10-05' });
  assert.ok(!later.warnings.some(w => w.code === 'SALES_CONFLICT_POTENTIAL'), '공통 정책 시작일 이전 매출은 수기 전표가 원천');
});

test('엑셀 전표 시트 왕복: 내보내기 → 불러오기 동일', () => {
  const r = A.buildDailySalesVouchers([item('a', 'o', 'fnb', 4000, '2026-10-06T01:00:00Z')], [pay('p', 'o', 'cash', 4000, '2026-10-06T01:00:00Z')], {});
  const rows = [A.MINISET_HEADER].concat(A.toMinisetRows(r.vouchers));
  const back = A.parseMinisetRows(A.parseTsv(A.toTsv(rows)));
  assert.equal(back.errors.length, 0);
  assert.equal(back.vouchers.length, 1);
  assert.deepEqual(back.vouchers[0].lines.map(l => [l.code, l.debit, l.credit, l.vat]), r.vouchers[0].lines.map(l => [l.code, l.debit, l.credit, l.vat]));
  assert.equal(A.normDate(46296), '2026-10-01', '엑셀 날짜 일련번호');
});

test('월 잠금: 스냅샷 고정, 이후 발권취소는 경고만', () => {
  const items = [item('a', 'o', 'ticket', 11000, '2026-10-06T01:00:00Z')];
  const pays = [pay('p', 'o', 'card', 11000, '2026-10-06T01:00:00Z')];
  const books = A.assembleBooks({}, { items: items, payments: pays }, { policy: POLICY, today: '2026-11-02' });
  const state = { locks: { '2026-10': { snapshot: A.lockSnapshot(books, '2026-10') } } };
  const after = A.assembleBooks(state, { items: [Object.assign({}, items[0], { status: 'cancelled' })], payments: [Object.assign({}, pays[0], { status: 'cancelled' })] }, { policy: POLICY, today: '2026-11-02' });
  assert.ok(after.vouchers.some(v => v.no === 'S-2026-10-06'), '잠긴 달 전표 유지');
  assert.ok(after.warnings.some(w => w.code === 'LOCKED_SOURCE_CHANGED'));
});

test('시재 과부족 → 현금과부족 전표', () => {
  const r = A.buildCashOverShortVouchers([{ date: '2026-10-06', diff_amount: -3000, notes: '거스름 오류' }, { date: '2026-10-07', diff_amount: 1000 }], {});
  assert.equal(r.vouchers[0].lines.find(l => l.code === '530').debit, 3000);
  assert.equal(r.vouchers[1].lines.find(l => l.code === '410').credit, 1000);
});

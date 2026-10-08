/* =========================================================================
   bongplay-accounting.js — 회계 순환 자동화 엔진 (회계_최소셋.xlsx 구조 이식)
   -------------------------------------------------------------------------
   회계 순환:  ① 거래 수집 → ② 분개(전표) → ③ 전기(총계정원장) → ④ 수정 전 시산표
               → ⑤ 결산 수정분개 → ⑥ 수정 후 시산표·재무제표·부가세 → ⑦ 마감·이월

   설계 원칙 (fugu D-007: 복식부기 원장이 본체, 나머지는 파생 출력)
   · 전표 라인 형식은 회계_최소셋 '전표' 시트 A~J 열과 같다.
       전표번호 | 날짜 | 증빙 | 적요 | 계정코드 | 차변 | 대변 | 부가세액 | 거래처 | 비고
   · 부가세액(H)은 공급가액이 있는 라인(수익·비용·자산)에 '정보'로 적고,
     실제 세액은 220 부가세예수금 / 135 부가세대급금 라인으로 따로 분개한다. (엑셀 V-007 방식)
   · 자동 전표(일일매출·결산수정·연마감)는 저장하지 않고 원천 데이터에서 매번 '결정적으로' 재생성한다.
     → 같은 입력이면 같은 전표, 중복 생성 없음. 월 잠금 시에만 스냅샷으로 고정한다.
   · 이 파일은 DOM·네트워크에 의존하지 않는다 (Node 테스트 가능). 화면은 pages/accounting.html.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ---------- 0. 계정과목표 (회계_최소셋 '계정과목' 시트 그대로 + 자동화에 필요한 2개 추가) ---------- */
  const BASE_CHART = [
    ['101', '현금', '자산', '해당없음'], ['102', '보통예금', '자산', '해당없음'],
    ['103', '카드매출미정산금', '자산', '해당없음'], ['104', '상품권', '자산', '해당없음'],
    ['120', '외상매출금', '자산', '해당없음'], ['135', '부가세대급금', '자산', '해당없음'],
    ['141', '미수금', '자산', '해당없음'], ['150', '상품', '자산', '과세'],
    ['160', '비품', '자산', '과세'], ['165', '시설장치', '자산', '과세'],
    ['170', '감가상각누계액', '자산', '해당없음'], ['180', '임차보증금', '자산', '해당없음'],
    ['190', '선급비용', '자산', '과세'],
    ['201', '외상매입금', '부채', '해당없음'], ['202', '미지급금', '부채', '해당없음'],
    ['203', '미지급비용', '부채', '해당없음'], ['210', '예수금(4대보험·원천세)', '부채', '해당없음'],
    ['220', '부가세예수금', '부채', '해당없음'], ['230', '선수금', '부채', '해당없음'],
    ['240', '단기차입금', '부채', '해당없음'], ['241', '장기차입금', '부채', '해당없음'],
    ['250', '퇴직급여충당부채', '부채', '해당없음'],
    ['301', '자본금', '자본', '해당없음'], ['302', '인출금', '자본', '해당없음'],
    ['310', '이월결손금', '자본', '해당없음'], ['320', '당기순손익', '자본', '해당없음'],
    ['401', '체험·입장료수입', '수익', '과세'], ['402', '프로그램·교육수입', '수익', '과세'],
    ['403', '매점매출', '수익', '과세'], ['404', '임대수입', '수익', '과세'],
    ['405', '이자수입', '수익', '면세'], ['410', '잡이익', '수익', '과세'],
    ['501', '급여', '비용', '해당없음'], ['502', '상여금', '비용', '해당없음'],
    ['503', '퇴직급여', '비용', '해당없음'], ['504', '4대보험료(사업주부담)', '비용', '해당없음'],
    ['510', '임차료', '비용', '과세'], ['511', '수도광열비', '비용', '과세'],
    ['512', '통신비', '비용', '과세'], ['513', '보험료', '비용', '불공제'],
    ['514', '세금과공과', '비용', '불공제'], ['515', '지급수수료(결제·카드)', '비용', '불공제'],
    ['516', '소모품비', '비용', '과세'], ['517', '여비교통비', '비용', '과세'],
    ['518', '차량유지비', '비용', '과세'], ['519', '광고선전비', '비용', '과세'],
    ['520', '접대비', '비용', '불공제'], ['521', '교육훈련비', '비용', '과세'],
    ['522', '수선비', '비용', '과세'], ['523', '외주용역비', '비용', '과세'],
    ['524', '감가상각비', '비용', '해당없음'], ['530', '잡비', '비용', '불공제'],
    ['540', '이자비용', '비용', '불공제']
  ];
  // 엑셀에 없는 계정 — 자동화 과정에서 필요해 추가. 엑셀 '계정과목' 시트에도 같은 코드로 추가해야 대사가 맞는다.
  const ADDED_CHART = [
    ['205', '미지급세금(부가세)', '부채', '해당없음', '부가세 정리 분개의 납부할 세액'],
    ['509', '원재료비(카페·매점)', '비용', '과세', '카페 식자재·원두·우유 등 판매용 재료 (소모품비와 분리)']
  ];

  function buildChart(extraRows) {
    const map = {};
    BASE_CHART.forEach(r => { map[r[0]] = { code: r[0], name: r[1], type: r[2], vat: r[3], added: false }; });
    ADDED_CHART.forEach(r => { map[r[0]] = { code: r[0], name: r[1], type: r[2], vat: r[3], added: true, why: r[4] }; });
    (extraRows || []).forEach(r => {
      if (!r || !r.code) return;
      const code = String(r.code).trim();
      map[code] = Object.assign({ code: code, added: !map[code] }, map[code] || {}, {
        name: r.name || (map[code] && map[code].name) || code,
        type: r.type || (map[code] && map[code].type) || '비용',
        vat: r.vat || (map[code] && map[code].vat) || '해당없음'
      });
    });
    return Object.keys(map).sort().map(k => map[k]);
  }

  const TYPES = ['자산', '부채', '자본', '수익', '비용'];
  const EVIDENCE = ['세금계산서', '계산서', '현금영수증', '카드전표', '무증빙', '기타'];

  /* ---------- 1. 공통 유틸 ---------- */
  const won = n => Math.round(Number(n) || 0);
  const pad2 = n => String(n).padStart(2, '0');

  // 브라우저 시간대와 무관하게 KST 날짜 (purchased_at/paid_at 은 UTC ISO)
  function kstDate(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return String(iso).slice(0, 10);
    return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const periodOf = d => String(d || '').slice(0, 7);
  function lastDayOf(period) {
    const [y, m] = period.split('-').map(Number);
    return `${period}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  }
  function addMonths(period, k) {
    const [y, m] = period.split('-').map(Number);
    const t = (y * 12 + (m - 1)) + k;
    return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
  }
  function monthDiff(a, b) { // b - a (개월)
    const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
    return (yb * 12 + mb) - (ya * 12 + ma);
  }
  function periodsBetween(fromP, toP) {
    const out = []; if (!fromP || !toP || fromP > toP) return out;
    for (let p = fromP; p <= toP; p = addMonths(p, 1)) out.push(p);
    return out;
  }
  // 엑셀 날짜 일련번호(46296) 또는 문자열 → YYYY-MM-DD
  function normDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v))) {
      const d = new Date(Math.round((Number(v) - 25569) * 86400000));
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim().replace(/[./]/g, '-');
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : s;
  }
  // 부가세 포함 금액에서 세액 (회계_최소셋 V-005 방식: ROUND(합계/11))
  const vatOfGross = g => Math.round(won(g) / 11);
  const line = (o) => ({
    evidence: o.evidence || '기타', memo: o.memo || '', code: String(o.code),
    debit: won(o.debit), credit: won(o.credit), vat: won(o.vat),
    partner: o.partner || '', note: o.note || '', tag: o.tag || ''
  });

  /* ---------- 2. 매핑 규칙 (운영시스템 SSOT → 계정) ---------- */
  // 품목 category → 수익 계정 (bongplay-id.js PRODUCT_CATALOG.category)
  function revenueCodeOf(category) {
    const c = String(category || '').toLowerCase();
    if (c.indexOf('ticket') === 0 || c === 'addon_attraction' || c === 'admission') return '401';
    if (c === 'fnb' || c === 'merchandise' || c === 'cafe' || c === 'goods') return '403';
    if (c === 'program' || c === 'education' || c === 'class') return '402';
    if (c === 'rental' || c === 'venue') return '404';
    return null; // 미분류 → 401로 귀속 + 경고
  }
  // 결제수단 → 차변 계정 (bongplay-id.js PAYMENT_METHODS.bucket 과 같은 분류)
  const METHOD_RULES = {
    card:          { code: '103', evidence: '카드전표',  partner: '카드사',   note: '카드 미정산금' },
    mobile_pay:    { code: '103', evidence: '카드전표',  partner: '간편결제사', note: '간편결제 미정산금' },
    cash:          { code: '101', evidence: '현금영수증', partner: '개인고객', note: '현금시재' },
    local_pay:     { code: '104', evidence: '기타',      partner: '봉화군청', note: '봉화사랑상품권(지류) — 환전 정산 대상' },
    youth_voucher: { code: '141', evidence: '기타',      partner: '봉화군청', note: '청소년 바우처 — 지자체 청구 대상' }
  };
  const METHOD_LABEL = { card: '카드결제', mobile_pay: '간편결제', cash: '현금입금', local_pay: '상품권수납', youth_voucher: '청소년바우처' };
  function methodRule(m) { return METHOD_RULES[m] || METHOD_RULES.card; } // 미등록 수단은 보수적으로 카드 계정 (getPaymentBucket 과 동일)

  const itemAmount = it => won(it.paid_amount != null ? it.paid_amount
    : (it.total_price != null ? it.total_price : (Number(it.unit_price || it.list_price || 0) * Number(it.quantity || 1))));

  /* ---------- 3. ② 분개 — 일일매출 자동 전표 ---------- */
  //  items    : order_items 행 (로컬+서버 병합, 중복 허용 — id 로 제거)
  //  payments : order_payments 행
  //  opts     : { from, to, startDate(이 날짜부터 자동), excludeDates: [] }
  function buildDailySalesVouchers(items, payments, opts) {
    opts = opts || {};
    const warnings = [];
    const uniq = (rows, key) => { const seen = {}; return (rows || []).filter(r => {
      const k = key(r); if (!k) return true; if (seen[k]) return false; seen[k] = 1; return true; }); };
    const live = r => r && r.status !== 'cancelled';
    const its = uniq(items, r => r.id || r.item_id).filter(live);
    const pays = uniq(payments, r => r.id).filter(live);

    const payByOrder = {};
    pays.forEach(p => { (payByOrder[p.order_id] = payByOrder[p.order_id] || []).push(p); });

    const days = {};
    const dayOf = d => (days[d] = days[d] || { date: d, revenue: {}, debit: {}, orders: {}, unmapped: 0 });
    const inRange = d => d && (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to)
      && (!opts.startDate || d >= opts.startDate) && !(opts.excludeDates || []).includes(d);

    its.forEach(it => {
      const d = kstDate(it.purchased_at || it.created_at);
      if (!inRange(d)) return;
      const amt = itemAmount(it);
      if (amt === 0) return;
      const day = dayOf(d);
      let code = revenueCodeOf(it.product_category || it.category);
      if (!code) { code = '401'; day.unmapped += amt; }
      day.revenue[code] = (day.revenue[code] || 0) + amt;
      day.orders[it.order_id] = day.orders[it.order_id] || { items: 0, legacyMethod: it.payment_method };
      day.orders[it.order_id].items += amt;
    });
    // 결제: 주문 기준 결제 원장 사용, 결제행이 없는 구(舊) 주문은 품목의 payment_method 로 보완
    Object.keys(days).forEach(d => {
      const day = days[d];
      Object.keys(day.orders).forEach(oid => {
        const rows = payByOrder[oid];
        if (rows && rows.length) {
          rows.forEach(p => { day.debit[p.method] = (day.debit[p.method] || 0) + won(p.amount); });
        } else {
          const m = day.orders[oid].legacyMethod || 'card';
          day.debit[m] = (day.debit[m] || 0) + day.orders[oid].items;
        }
      });
    });

    const vouchers = Object.keys(days).sort().map(d => {
      const day = days[d], md = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      const no = `S-${d}`;
      const lines = [];
      const methods = Object.keys(day.debit).sort((a, b) => ['cash', 'local_pay', 'youth_voucher', 'card', 'mobile_pay'].indexOf(a) - ['cash', 'local_pay', 'youth_voucher', 'card', 'mobile_pay'].indexOf(b));
      methods.forEach(m => {
        const r = methodRule(m);
        if (!day.debit[m]) return;
        lines.push(line({ evidence: r.evidence, memo: `${md} 일일매출 ${METHOD_LABEL[m] || m}`, code: r.code, debit: day.debit[m], partner: r.partner, note: r.note, tag: 'pay:' + m }));
      });
      let vatTotal = 0;
      Object.keys(day.revenue).sort().forEach(code => {
        const gross = day.revenue[code], vat = vatOfGross(gross);
        vatTotal += vat;
        lines.push(line({ memo: `${md} ${code === '403' ? '카페·매점' : code === '401' ? '놀이동 입장·체험' : '기타'} 매출`, code: code, credit: gross - vat, vat: vat, partner: '개인고객', note: '공급가액', tag: 'revenue' }));
      });
      if (vatTotal) lines.push(line({ memo: `${md} 일일매출 부가세 예수`, code: '220', credit: vatTotal, partner: '세무서', note: '부가세 10% (합계÷11)', tag: 'vat_out' }));

      const payTotal = methods.reduce((s, m) => s + won(day.debit[m]), 0);
      const saleTotal = Object.keys(day.revenue).reduce((s, c) => s + day.revenue[c], 0);
      const gap = payTotal - saleTotal;
      if (gap > 0) lines.push(line({ memo: `${md} 결제·품목 대사차이`, code: '230', credit: gap, note: '결제액>품목액 — 원인 확인 후 정정', tag: 'gap' }));
      if (gap < 0) lines.push(line({ memo: `${md} 결제·품목 대사차이`, code: '141', debit: -gap, note: '품목액>결제액 — 원인 확인 후 정정', tag: 'gap' }));
      if (gap) warnings.push({ level: 'error', code: 'SALES_PAYMENT_GAP', voucher: no, message: `${d} 결제 합계(${fmt(payTotal)})와 품목 합계(${fmt(saleTotal)})가 ${fmt(gap)}원 다릅니다. 대사차이 라인으로 임시 처리했습니다.` });
      if (day.unmapped) warnings.push({ level: 'warn', code: 'UNMAPPED_CATEGORY', voucher: no, message: `${d} 분류 없는 품목 ${fmt(day.unmapped)}원을 401로 처리했습니다. 상품 category 를 확인하세요.` });
      return { no: no, date: d, source: 'auto_sales', title: `${md} 일일매출 (주문 ${Object.keys(day.orders).length}건)`, lines: lines,
        meta: { orders: Object.keys(day.orders).length, gross: saleTotal, paid: payTotal } };
    });
    return { vouchers: vouchers, warnings: warnings };
  }

  // 마감 기록(closing_records)의 시재 과부족 → 현금과부족 전표. diff = 실사 − 장부 (closing.html:1050)
  function buildCashOverShortVouchers(closings, opts) {
    opts = opts || {};
    const out = [], warnings = [];
    (closings || []).forEach(c => {
      const d = normDate(c.date || (c.id || '').replace(/^cls_/, ''));
      if (!d || (opts.from && d < opts.from) || (opts.to && d > opts.to) || (opts.startDate && d < opts.startDate)) return;
      const diff = won(c.diff_amount != null ? c.diff_amount : c.diff);
      const md = `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      if (diff > 0) out.push({ no: `S-${d}-CASH`, date: d, source: 'auto_sales', title: `${md} 시재 과잉`, lines: [
        line({ memo: `${md} 시재 과잉`, code: '101', debit: diff, note: '마감 실사 > 장부' }),
        line({ memo: `${md} 현금과부족 정리`, code: '410', credit: diff, note: c.notes || '' })] });
      if (diff < 0) out.push({ no: `S-${d}-CASH`, date: d, source: 'auto_sales', title: `${md} 시재 부족`, lines: [
        line({ memo: `${md} 현금과부족 정리`, code: '530', debit: -diff, note: c.notes || '' }),
        line({ memo: `${md} 시재 부족`, code: '101', credit: -diff, note: '마감 실사 < 장부' })] });
      const exp = won(c.cash && c.cash.exp);
      if (exp > 0) warnings.push({ level: 'warn', code: 'CASH_EXPENSE_UNBOOKED', message: `${d} 마감에 금고 현금지출 ${fmt(exp)}원이 있습니다. 어떤 비용인지 경비 전표(현금 지급)로 입력하세요.` });
    });
    return { vouchers: out, warnings: warnings };
  }

  /* ---------- 4. ② 분개 — 수기 거래 템플릿 ---------- */
  // 각 템플릿은 화면 입력값(f) → { lines, schedule? } 을 만든다. 금액은 모두 원 단위 정수.
  const PAY_FROM = { bank: ['102', '보통예금'], card: ['202', '미지급금(카드)'], cash: ['101', '현금'], payable: ['202', '미지급금(외상)'] };
  const TEMPLATES = [
    { id: 'card_settle', group: '정산', label: '카드매출 입금 정산', hint: '카드사가 미정산 매출을 수수료 떼고 통장에 넣었을 때',
      fields: [['cleared', '정산 대상 카드매출(원)', 'number'], ['deposit', '통장 실입금액(원)', 'number'], ['partner', '카드사', 'text', '카드사']],
      build: f => { const fee = won(f.cleared) - won(f.deposit); if (fee < 0) throw new Error('입금액이 정산 대상보다 큽니다.');
        return { lines: [line({ memo: '카드매출 입금', code: '102', debit: f.deposit, partner: f.partner }),
          fee ? line({ evidence: '카드전표', memo: '카드 결제수수료', code: '515', debit: fee, partner: f.partner, note: `수수료율 ${(fee / Math.max(1, won(f.cleared)) * 100).toFixed(2)}%` }) : null,
          line({ memo: '카드매출 미정산금 회수', code: '103', credit: f.cleared, partner: f.partner })].filter(Boolean) }; } },
    { id: 'localpay_settle', group: '정산', label: '봉화사랑상품권 환전 입금', hint: '지류 상품권을 농협·군청에 제출해 통장으로 받았을 때',
      fields: [['amount', '제출 상품권 액면(원)', 'number'], ['fee', '환전 수수료(원, 없으면 0)', 'number']],
      build: f => ({ lines: [line({ memo: '상품권 환전 입금', code: '102', debit: won(f.amount) - won(f.fee), partner: '농협' }),
        won(f.fee) ? line({ memo: '상품권 환전 수수료', code: '515', debit: f.fee, partner: '농협' }) : null,
        line({ memo: '상품권 회수', code: '104', credit: f.amount, partner: '봉화군청', note: '봉화사랑상품권' })].filter(Boolean) }) },
    { id: 'youth_receipt', group: '정산', label: '청소년 바우처 청구금 입금', hint: '군청에 청구한 바우처 금액이 들어왔을 때',
      fields: [['amount', '입금액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '청소년 바우처 입금', code: '102', debit: f.amount, partner: '봉화군청' }),
        line({ memo: '바우처 미수금 회수', code: '141', credit: f.amount, partner: '봉화군청' })] }) },
    { id: 'cash_deposit', group: '정산', label: '현금 시재 은행 입금', hint: '금고 현금을 통장에 넣었을 때',
      fields: [['amount', '입금액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '현금 은행 입금', code: '102', debit: f.amount, partner: '기업은행' }), line({ memo: '현금 은행 입금', code: '101', credit: f.amount })] }) },

    { id: 'purchase', group: '매입·경비', label: '매입·경비 (증빙 있음)', hint: '세금계산서·카드·현금영수증으로 산 것. 과세면 부가세를 자동으로 나눕니다',
      fields: [['code', '비용 계정', 'account:비용'], ['gross', '결제 총액(부가세 포함, 원)', 'number'], ['evidence', '증빙', 'evidence', '카드전표'],
        ['pay', '지급 수단', 'pay', 'card'], ['partner', '거래처', 'text'], ['memo', '적요', 'text']],
      build: (f, chart) => purchaseLines(f, chart) },
    { id: 'expense_plain', group: '매입·경비', label: '경비 (부가세 공제 안 됨)', hint: '보험료·수수료·간이영수증·면세 품목 등',
      fields: [['code', '비용 계정', 'account:비용'], ['amount', '금액(원)', 'number'], ['evidence', '증빙', 'evidence', '기타'], ['pay', '지급 수단', 'pay', 'bank'], ['partner', '거래처', 'text'], ['memo', '적요', 'text']],
      build: f => { const p = PAY_FROM[f.pay] || PAY_FROM.bank; return { lines: [
        line({ evidence: f.evidence, memo: f.memo || '경비', code: f.code, debit: f.amount, partner: f.partner }),
        line({ evidence: f.evidence, memo: (f.memo || '경비') + ' 지급', code: p[0], credit: f.amount, partner: f.partner, note: p[1] })] }; } },
    { id: 'payable_pay', group: '매입·경비', label: '카드대금·미지급금 결제', hint: '카드값·외상값이 통장에서 빠져나갔을 때',
      fields: [['amount', '출금액(원)', 'number'], ['partner', '카드사·거래처', 'text', '농협카드']],
      build: f => ({ lines: [line({ memo: '미지급금 결제', code: '202', debit: f.amount, partner: f.partner }), line({ memo: '미지급금 결제 출금', code: '102', credit: f.amount, partner: f.partner })] }) },
    { id: 'prepaid', group: '매입·경비', label: '선급 비용 (연 사용료·보험 등) → 월 자동배분', hint: '1년치를 한 번에 낸 비용. 선급비용으로 잡고 매월 결산 때 자동으로 비용 처리합니다',
      fields: [['expense_code', '배분할 비용 계정', 'account:비용', '510'], ['supply', '공급가액(원)', 'number'], ['vat', '부가세(원, 없으면 0)', 'number'],
        ['months', '배분 개월 수', 'number', '12'], ['start', '배분 시작월(YYYY-MM)', 'month'], ['pay', '지급 수단', 'pay', 'payable'], ['partner', '거래처', 'text'], ['memo', '적요', 'text']],
      build: (f) => { const p = PAY_FROM[f.pay] || PAY_FROM.bank; const tot = won(f.supply) + won(f.vat);
        return { lines: [line({ evidence: won(f.vat) ? '세금계산서' : '기타', memo: f.memo || '선급비용', code: '190', debit: f.supply, vat: f.vat, partner: f.partner, note: `${f.months}개월 배분` }),
          won(f.vat) ? line({ evidence: '세금계산서', memo: (f.memo || '선급비용') + ' 부가세', code: '135', debit: f.vat, partner: f.partner }) : null,
          line({ memo: (f.memo || '선급비용') + ' 지급', code: p[0], credit: tot, partner: f.partner, note: p[1] })].filter(Boolean),
          schedule: { kind: 'amort', name: f.memo || '선급비용', expense_code: f.expense_code || '510', prepaid_code: '190', total: won(f.supply), months: Math.max(1, won(f.months)), start: f.start } }; } },
    { id: 'asset', group: '매입·경비', label: '비품·시설 취득 → 감가상각 자동', hint: '오래 쓰는 물건 (100만원 이상 권장). 매월 결산 때 감가상각비를 자동 계산합니다',
      fields: [['asset_code', '자산 계정', 'select:160=비품,165=시설장치', '160'], ['supply', '공급가액(원)', 'number'], ['vat', '부가세(원)', 'number'],
        ['life', '내용연수(년)', 'number', '5'], ['start', '취득월(YYYY-MM)', 'month'], ['pay', '지급 수단', 'pay', 'bank'], ['partner', '거래처', 'text'], ['memo', '자산명', 'text']],
      build: (f) => { const p = PAY_FROM[f.pay] || PAY_FROM.bank; const tot = won(f.supply) + won(f.vat);
        return { lines: [line({ evidence: '세금계산서', memo: f.memo || '자산 취득', code: f.asset_code || '160', debit: f.supply, vat: f.vat, partner: f.partner, note: `내용연수 ${f.life}년` }),
          won(f.vat) ? line({ evidence: '세금계산서', memo: (f.memo || '자산') + ' 부가세', code: '135', debit: f.vat, partner: f.partner }) : null,
          line({ memo: (f.memo || '자산') + ' 대금', code: p[0], credit: tot, partner: f.partner, note: p[1] })].filter(Boolean),
          schedule: { kind: 'dep', name: f.memo || '자산', asset_code: f.asset_code || '160', cost: won(f.supply), salvage: 0, months: Math.max(1, won(f.life) * 12), start: f.start } }; } },

    { id: 'invoice_sale', group: '매출', label: '대관·단체 매출 (세금계산서 발행)', hint: '단체·기관에 세금계산서를 끊어준 매출',
      fields: [['code', '수익 계정', 'select:401=체험·입장료수입,402=프로그램·교육수입,404=임대수입', '401'], ['gross', '청구 총액(부가세 포함, 원)', 'number'],
        ['recv', '대금', 'select:bank=통장 입금 완료,ar=외상(나중에 입금)', 'bank'], ['partner', '거래처', 'text'], ['memo', '적요', 'text']],
      build: f => { const vat = vatOfGross(f.gross); const dr = f.recv === 'ar' ? '120' : '102';
        return { lines: [line({ evidence: '세금계산서', memo: (f.memo || '대관 매출') + (dr === '120' ? ' 외상' : ' 입금'), code: dr, debit: f.gross, partner: f.partner }),
          line({ evidence: '세금계산서', memo: f.memo || '대관 매출', code: f.code || '401', credit: won(f.gross) - vat, vat: vat, partner: f.partner, note: '공급가액' }),
          line({ evidence: '세금계산서', memo: (f.memo || '대관 매출') + ' 부가세 예수', code: '220', credit: vat, partner: '세무서', note: '부가세 10%' })] }; } },
    { id: 'ar_receipt', group: '매출', label: '외상매출금 입금', hint: '외상으로 잡아둔 대관료가 들어왔을 때',
      fields: [['amount', '입금액(원)', 'number'], ['partner', '거래처', 'text']],
      build: f => ({ lines: [line({ memo: '외상매출금 입금', code: '102', debit: f.amount, partner: f.partner }), line({ memo: '외상매출금 회수', code: '120', credit: f.amount, partner: f.partner })] }) },

    { id: 'payroll', group: '인건비', label: '급여 지급', hint: '급여명세서 숫자 그대로. 공제액은 예수금으로, 사업주 4대보험은 비용으로 잡습니다',
      fields: [['gross', '총 급여(세전, 원)', 'number'], ['ee_ins', '근로자 4대보험 공제(원)', 'number'], ['tax', '소득세+지방소득세 공제(원)', 'number'],
        ['er_ins', '사업주 4대보험 부담(원)', 'number'], ['partner', '직원명(또는 "직원 2명")', 'text'], ['memo', '적요', 'text', '급여']],
      build: f => { const ded = won(f.ee_ins) + won(f.tax); const net = won(f.gross) - ded;
        return { lines: [line({ memo: f.memo || '급여', code: '501', debit: f.gross, partner: f.partner }),
          won(f.er_ins) ? line({ memo: '4대보험 사업주부담', code: '504', debit: f.er_ins, partner: '공단' }) : null,
          ded + won(f.er_ins) ? line({ memo: '급여 공제·사업주보험 예수', code: '210', credit: ded + won(f.er_ins), partner: '공단·세무서', note: `근로자분 ${fmt(ded)} + 사업주분 ${fmt(f.er_ins)}` }) : null,
          line({ memo: '급여 실지급', code: '102', credit: net, partner: f.partner })].filter(Boolean) }; } },
    { id: 'withholding_pay', group: '인건비', label: '4대보험·원천세 납부', hint: '다음 달 10일 원천세·보험료 납부',
      fields: [['amount', '납부액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '예수금 납부', code: '210', debit: f.amount, partner: '공단·세무서' }), line({ memo: '예수금 납부 출금', code: '102', credit: f.amount })] }) },

    { id: 'vat_pay', group: '세금·자금', label: '부가세 납부 (예정고지·확정)', hint: '세무서에 부가세를 냈을 때. 반기말 정리분개와 자동 상계됩니다',
      fields: [['amount', '납부액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '부가세 납부', code: '205', debit: f.amount, partner: '세무서', tag: 'vat_payment' }), line({ memo: '부가세 납부 출금', code: '102', credit: f.amount, partner: '세무서' })] }) },
    { id: 'capital_in', group: '세금·자금', label: '자본금 납입', fields: [['amount', '금액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '자본금 납입', code: '102', debit: f.amount, partner: '대표' }), line({ memo: '자본금 납입', code: '301', credit: f.amount, partner: '대표' })] }) },
    { id: 'owner_draw', group: '세금·자금', label: '대표 인출 (개인 사용)', fields: [['amount', '금액(원)', 'number']],
      build: f => ({ lines: [line({ memo: '대표 인출', code: '302', debit: f.amount, partner: '대표' }), line({ memo: '대표 인출', code: '102', credit: f.amount })] }) },
    { id: 'loan_in', group: '세금·자금', label: '차입금 입금', fields: [['amount', '금액(원)', 'number'], ['code', '구분', 'select:240=단기(1년 이내),241=장기', '241'], ['partner', '대여자', 'text']],
      build: f => ({ lines: [line({ evidence: '계약서', memo: '차입금 입금', code: '102', debit: f.amount, partner: f.partner }), line({ evidence: '계약서', memo: '차입금', code: f.code || '241', credit: f.amount, partner: f.partner })] }) },
    { id: 'loan_repay', group: '세금·자금', label: '차입금 상환·이자', fields: [['principal', '원금(원)', 'number'], ['interest', '이자(원)', 'number'], ['code', '구분', 'select:240=단기,241=장기', '241'], ['partner', '대여자', 'text']],
      build: f => ({ lines: [won(f.principal) ? line({ memo: '차입금 상환', code: f.code || '241', debit: f.principal, partner: f.partner }) : null,
        won(f.interest) ? line({ memo: '이자 지급', code: '540', debit: f.interest, partner: f.partner }) : null,
        line({ memo: '차입금 상환 출금', code: '102', credit: won(f.principal) + won(f.interest), partner: f.partner })].filter(Boolean) }) }
  ];

  function purchaseLines(f, chart) {
    const acct = findAccount(chart, f.code) || { vat: '과세', name: f.code };
    const p = PAY_FROM[f.pay] || PAY_FROM.card;
    const deductible = acct.vat === '과세' && ['세금계산서', '카드전표', '현금영수증'].includes(f.evidence);
    const gross = won(f.gross), vat = deductible ? vatOfGross(gross) : 0;
    const memo = f.memo || acct.name;
    return { lines: [
      line({ evidence: f.evidence, memo: memo, code: f.code, debit: gross - vat, vat: vat, partner: f.partner, note: deductible ? '공급가액' : '부가세 불공제(비용 포함)' }),
      vat ? line({ evidence: f.evidence, memo: memo + ' 부가세', code: '135', debit: vat, partner: f.partner, note: '매입세액' }) : null,
      line({ evidence: f.evidence, memo: memo + ' 결제', code: p[0], credit: gross, partner: f.partner, note: p[1] })].filter(Boolean) };
  }

  function buildFromTemplate(id, fields, chart) {
    const t = TEMPLATES.find(x => x.id === id);
    if (!t) throw new Error('알 수 없는 템플릿: ' + id);
    const res = t.build(fields || {}, chart || buildChart());
    const lines = res.lines.filter(l => l.debit || l.credit);
    if (!lines.length) throw new Error('금액을 입력하세요.');
    const bal = lines.reduce((s, l) => s + l.debit - l.credit, 0);
    if (bal !== 0) throw new Error(`차대 불일치 ${fmt(bal)}원 — 입력값을 확인하세요.`);
    if (res.schedule && !/^\d{4}-\d{2}$/.test(res.schedule.start || '')) throw new Error('시작월을 YYYY-MM 형식으로 입력하세요.');
    return { lines: lines, schedule: res.schedule || null, title: t.label };
  }

  function nextManualNo(manual, date) {
    const p = periodOf(date);
    let max = 0;
    (manual || []).forEach(v => { const m = String(v.no || '').match(/^V-(\d{4}-\d{2})-(\d+)$/); if (m && m[1] === p) max = Math.max(max, Number(m[2])); });
    return `V-${p}-${String(max + 1).padStart(3, '0')}`;
  }

  /* ---------- 5. ⑤ 결산 수정분개 (기간배분·감가상각·부가세 정리·연 마감) ---------- */
  function scheduleAmount(s, period) {
    const total = won(s.kind === 'dep' ? (s.cost - (s.salvage || 0)) : s.total);
    const k = monthDiff(s.start, period); // 0-based
    if (k < 0 || k >= s.months) return 0;
    const per = Math.floor(total / s.months);
    return k === s.months - 1 ? total - per * (s.months - 1) : per; // 끝전은 마지막 달에
  }
  function buildScheduleVouchers(schedules, periods) {
    const out = [];
    (schedules || []).forEach((s, idx) => {
      if (!s || !s.start || s.disabled) return;
      periods.forEach(p => {
        const amt = scheduleAmount(s, p);
        if (!amt) return;
        const k = monthDiff(s.start, p) + 1;
        const sid = s.id || ('s' + idx);
        const d = lastDayOf(p);
        if (s.kind === 'dep') {
          out.push({ no: `J-${p}-DEP-${sid}`, date: d, source: 'adjust', title: `${s.name} 감가상각 (${k}/${s.months})`, schedule_id: sid, lines: [
            line({ memo: `${s.name} 감가상각 (${k}/${s.months})`, code: '524', debit: amt, note: '정액법 월할' }),
            line({ memo: `${s.name} 감가상각누계`, code: '170', credit: amt, note: `자산 ${s.asset_code}` })] });
        } else {
          out.push({ no: `J-${p}-AMT-${sid}`, date: d, source: 'adjust', title: `${s.name} 기간배분 (${k}/${s.months})`, schedule_id: sid, lines: [
            line({ memo: `${s.name} 기간배분 (${k}/${s.months})`, code: s.expense_code || '510', debit: amt, note: '선급비용 월할 대체' }),
            line({ memo: `${s.name} 선급비용 감소`, code: s.prepaid_code || '190', credit: amt })] });
        }
      });
    });
    return out;
  }

  // 부가세 정리: 과세기간(1기 1~6월, 2기 7~12월) 말일에 220·135 잔액을 상계하고 차액을 205(납부) 또는 141(환급)로
  function buildVatClearingVouchers(lines, periods) {
    const out = [];
    periods.filter(p => /-(06|12)$/.test(p)).forEach(p => {
      const y = p.slice(0, 4), from = p.endsWith('06') ? `${y}-01-01` : `${y}-07-01`, to = lastDayOf(p);
      let out220 = 0, in135 = 0;
      lines.forEach(l => {
        if (l.date < from || l.date > to || l.tag === 'vat_clear') return;
        if (l.code === '220') out220 += l.credit - l.debit;
        if (l.code === '135') in135 += l.debit - l.credit;
      });
      if (!out220 && !in135) return;
      const diff = out220 - in135;
      const half = p.endsWith('06') ? '1기' : '2기';
      out.push({ no: `J-${p}-VAT`, date: to, source: 'adjust', title: `${y}년 ${half} 부가세 정리`, lines: [
        out220 ? line({ memo: `${half} 매출세액 정리`, code: '220', debit: out220, partner: '세무서', tag: 'vat_clear' }) : null,
        in135 ? line({ memo: `${half} 매입세액 정리`, code: '135', credit: in135, partner: '세무서', tag: 'vat_clear' }) : null,
        diff > 0 ? line({ memo: `${half} 납부할 부가세`, code: '205', credit: diff, partner: '세무서', note: '확정신고 시 납부 (예정고지 납부분과 상계)', tag: 'vat_clear' }) : null,
        diff < 0 ? line({ memo: `${half} 환급받을 부가세`, code: '141', debit: -diff, partner: '세무서', note: '환급 예정', tag: 'vat_clear' }) : null
      ].filter(Boolean) });
    });
    return out;
  }

  // 연 마감(마감분개): 수익·비용 잔액 → 320 당기순손익 → (개인사업자) 301 자본금. 인출금 302 도 자본금으로 대체.
  function buildYearCloseVouchers(lines, chart, year) {
    const from = `${year}-01-01`, to = `${year}-12-31`;
    const bal = {};
    lines.forEach(l => { if (l.date >= from && l.date <= to && l.source !== 'closing') bal[l.code] = (bal[l.code] || 0) + l.debit - l.credit; });
    const ls = []; let net = 0;
    chart.forEach(a => {
      const b = bal[a.code] || 0; if (!b) return;
      if (a.type === '수익') { ls.push(line({ memo: `${year} 손익대체`, code: a.code, debit: -b > 0 ? -b : 0, credit: b > 0 ? b : 0 })); net += -b; }
      if (a.type === '비용') { ls.push(line({ memo: `${year} 손익대체`, code: a.code, credit: b > 0 ? b : 0, debit: b < 0 ? -b : 0 })); net -= b; }
    });
    if (!ls.length) return [];
    ls.push(line({ memo: `${year} 당기순${net >= 0 ? '이익' : '손실'}`, code: '320', credit: net > 0 ? net : 0, debit: net < 0 ? -net : 0 }));
    const v1 = { no: `C-${year}-PL`, date: to, source: 'closing', title: `${year} 손익 마감`, lines: ls };
    const draw = bal['302'] || 0;
    const ls2 = [
      line({ memo: `${year} 순손익 자본 대체`, code: '320', debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }),
      line({ memo: `${year} 순손익 자본 대체`, code: '301', credit: net > 0 ? net : 0, debit: net < 0 ? -net : 0 })];
    if (draw) { ls2.push(line({ memo: `${year} 인출금 정리`, code: '301', debit: draw > 0 ? draw : 0, credit: draw < 0 ? -draw : 0 }));
      ls2.push(line({ memo: `${year} 인출금 정리`, code: '302', credit: draw > 0 ? draw : 0, debit: draw < 0 ? -draw : 0 })); }
    return [v1, { no: `C-${year}-EQ`, date: to, source: 'closing', title: `${year} 자본 대체 (개인사업자)`, lines: ls2.filter(l => l.debit || l.credit) }];
  }

  /* ---------- 6. ③ 전기 · ④ 시산표 · ⑥ 재무제표 ---------- */
  function flatten(vouchers) {
    const out = [];
    (vouchers || []).forEach(v => (v.lines || []).forEach((l, i) => out.push(Object.assign({}, l, {
      no: v.no, date: v.date, source: v.source || 'manual', seq: i, period: periodOf(v.date) }))));
    out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no < b.no ? -1 : a.no > b.no ? 1 : a.seq - b.seq));
    return out;
  }
  function findAccount(chart, code) { return (chart || []).find(a => a.code === String(code)) || null; }

  // 총계정원장: 계정 하나의 거래 내역과 누적 잔액 (자산·비용은 차변 잔액, 나머지는 대변 잔액이 +)
  function generalLedger(lines, chart, code, opts) {
    opts = opts || {};
    const a = findAccount(chart, code) || { code: code, name: '미등록', type: '자산' };
    const debitNature = a.type === '자산' || a.type === '비용';
    let bal = 0, opening = 0;
    const rows = [];
    lines.forEach(l => {
      if (l.code !== String(code)) return;
      const delta = debitNature ? l.debit - l.credit : l.credit - l.debit;
      if (opts.from && l.date < opts.from) { opening += delta; bal += delta; return; }
      if (opts.to && l.date > opts.to) return;
      bal += delta;
      rows.push(Object.assign({}, l, { balance: bal }));
    });
    return { account: a, opening: opening, rows: rows, closing: bal, debitNature: debitNature };
  }

  // 시산표: 회계_최소셋 '시산표' 시트와 같은 열 (차변·대변 = 기간 발생액, 잔액 = 차−대) + 기말 누적 잔액
  function trialBalance(lines, chart, opts) {
    opts = opts || {};
    const inPeriod = l => (!opts.from || l.date >= opts.from) && (!opts.to || l.date <= opts.to)
      && (!opts.excludeSources || !opts.excludeSources.includes(l.source));
    const upTo = l => (!opts.to || l.date <= opts.to) && (!opts.excludeSources || !opts.excludeSources.includes(l.source));
    const acc = {};
    const known = {}; chart.forEach(a => { known[a.code] = 1; });
    lines.forEach(l => {
      const r = acc[l.code] = acc[l.code] || { debit: 0, credit: 0, cum: 0 };
      if (inPeriod(l)) { r.debit += l.debit; r.credit += l.credit; }
      if (upTo(l)) r.cum += l.debit - l.credit;
    });
    const rows = chart.map(a => { const r = acc[a.code] || { debit: 0, credit: 0, cum: 0 };
      return { code: a.code, name: a.name, type: a.type, debit: r.debit, credit: r.credit, balance: r.debit - r.credit, cumulative: r.cum }; });
    Object.keys(acc).filter(c => !known[c]).forEach(c => rows.push({ code: c, name: '미등록 계정', type: '미등록', debit: acc[c].debit, credit: acc[c].credit, balance: acc[c].debit - acc[c].credit, cumulative: acc[c].cum, unregistered: true }));
    const totalDebit = lines.filter(inPeriod).reduce((s, l) => s + l.debit, 0);
    const totalCredit = lines.filter(inPeriod).reduce((s, l) => s + l.credit, 0);
    const rowDebit = rows.reduce((s, r) => s + r.debit, 0), rowCredit = rows.reduce((s, r) => s + r.credit, 0);
    return { rows: rows, totalDebit: totalDebit, totalCredit: totalCredit, diff: totalDebit - totalCredit, rowDebit: rowDebit, rowCredit: rowCredit,
      balanced: totalDebit === totalCredit, complete: rowDebit === totalDebit && rowCredit === totalCredit };
  }

  function incomeStatement(lines, chart, from, to) {
    const tb = trialBalance(lines, chart, { from: from, to: to, excludeSources: ['closing'] });
    const rev = tb.rows.filter(r => r.type === '수익' && (r.debit || r.credit)).map(r => ({ code: r.code, name: r.name, amount: r.credit - r.debit }));
    const exp = tb.rows.filter(r => r.type === '비용' && (r.debit || r.credit)).map(r => ({ code: r.code, name: r.name, amount: r.debit - r.credit }));
    const revenue = rev.reduce((s, r) => s + r.amount, 0), expense = exp.reduce((s, r) => s + r.amount, 0);
    return { from: from, to: to, revenue: revenue, expense: expense, net: revenue - expense, revenueRows: rev, expenseRows: exp };
  }

  function monthlyPnl(lines, chart, year) {
    return periodsBetween(`${year}-01`, `${year}-12`).map(p => {
      const is = incomeStatement(lines, chart, `${p}-01`, lastDayOf(p));
      return { period: p, revenue: is.revenue, expense: is.expense, net: is.net };
    });
  }

  function balanceSheet(lines, chart, asOf) {
    const tb = trialBalance(lines, chart, { to: asOf });
    const pick = (type, sign) => tb.rows.filter(r => r.type === type && r.cumulative).map(r => ({ code: r.code, name: r.name, amount: sign * r.cumulative }));
    const assets = pick('자산', 1), liabilities = pick('부채', -1), equity = pick('자본', -1);
    const unclosed = -tb.rows.filter(r => r.type === '수익' || r.type === '비용').reduce((s, r) => s + r.cumulative, 0); // 아직 마감 안 된 손익
    const A = assets.reduce((s, r) => s + r.amount, 0), L = liabilities.reduce((s, r) => s + r.amount, 0), E = equity.reduce((s, r) => s + r.amount, 0) + unclosed;
    return { asOf: asOf, assets: assets, liabilities: liabilities, equity: equity, unclosedProfit: unclosed, totalAssets: A, totalLiabilities: L, totalEquity: E, balanced: A === L + E };
  }

  // 부가세 신고 기초자료 (일반과세자 가정 — 사업자 유형 미확정, fugu OPEN_QUESTIONS)
  function vatReport(lines, chart, from, to) {
    const typ = {}; chart.forEach(a => { typ[a.code] = a; });
    const r = { from: from, to: to, salesSupply: 0, salesTaxBooked: 0, salesTaxOnLines: 0, purchaseSupply: 0, purchaseTaxBooked: 0, purchaseTaxOnLines: 0,
      cardSales: 0, cashSales: 0, exemptSales: 0, voucherMismatches: [] };
    const byVoucher = {};
    lines.forEach(l => {
      if (l.date < from || l.date > to || l.source === 'closing') return;
      const a = typ[l.code];
      const bv = byVoucher[l.no] = byVoucher[l.no] || { no: l.no, date: l.date, booked220: 0, lines220: 0, booked135: 0, lines135: 0 };
      if (l.tag === 'vat_clear') return;
      if (l.code === '220') { r.salesTaxBooked += l.credit - l.debit; bv.booked220 += l.credit - l.debit; }
      if (l.code === '135') { r.purchaseTaxBooked += l.debit - l.credit; bv.booked135 += l.debit - l.credit; }
      if (!a) return;
      if (a.type === '수익' && a.vat === '과세') { r.salesSupply += l.credit - l.debit; r.salesTaxOnLines += (l.credit ? 1 : -1) * l.vat; bv.lines220 += (l.credit ? 1 : -1) * l.vat; }
      if (a.type === '수익' && a.vat === '면세') r.exemptSales += l.credit - l.debit;
      if ((a.type === '비용' || a.type === '자산') && a.vat === '과세' && l.source !== 'adjust' && l.vat) {
        r.purchaseSupply += l.debit - l.credit; r.purchaseTaxOnLines += (l.debit ? 1 : -1) * l.vat; bv.lines135 += (l.debit ? 1 : -1) * l.vat; }
      if (l.source === 'auto_sales' && l.code === '103') r.cardSales += l.debit;
      if (l.source === 'auto_sales' && l.code === '101' && l.tag === 'pay:cash') r.cashSales += l.debit;
    });
    Object.keys(byVoucher).forEach(k => { const v = byVoucher[k];
      if (v.booked220 !== v.lines220) r.voucherMismatches.push({ no: v.no, date: v.date, kind: '매출세액', booked: v.booked220, onLines: v.lines220 });
      if (v.booked135 !== v.lines135) r.voucherMismatches.push({ no: v.no, date: v.date, kind: '매입세액', booked: v.booked135, onLines: v.lines135 }); });
    r.payable = r.salesTaxBooked - r.purchaseTaxBooked;
    return r;
  }

  /* ---------- 7. 검증 (회계_최소셋 '검증' 시트 9개 + 자동화 추가 점검) ---------- */
  function validate(vouchers, chart, opts) {
    opts = opts || {};
    const issues = [];
    const known = {}; chart.forEach(a => { known[a.code] = a; });
    const add = (level, code, message, no) => issues.push({ level: level, code: code, message: message, voucher: no || '' });
    const salesDates = {}, addedSeen = {};
    (vouchers || []).forEach(v => {
      if (v.source === 'auto_sales' && !/-CASH$/.test(v.no)) salesDates[v.date] = v.no;
    });
    (vouchers || []).forEach(v => {
      const ls = v.lines || [];
      const bal = ls.reduce((s, l) => s + won(l.debit) - won(l.credit), 0);
      if (bal !== 0) add('error', 'UNBALANCED', `차변과 대변이 ${fmt(bal)}원 다릅니다.`, v.no);
      if (!v.date) add('error', 'NO_DATE', '날짜가 없습니다.', v.no);
      ls.forEach((l, i) => {
        const at = `${i + 1}번째 줄`;
        if (l.debit && l.credit) add('error', 'BOTH_SIDES', `${at}: 차변과 대변이 동시에 있습니다.`, v.no);
        if (!l.debit && !l.credit && (l.memo || l.code)) add('warn', 'NO_AMOUNT', `${at}: 금액이 없습니다.`, v.no);
        if (!known[l.code]) add('error', 'UNKNOWN_ACCOUNT', `${at}: 계정코드 ${l.code} 가 계정과목에 없습니다.`, v.no);
        if (!l.evidence) add('warn', 'NO_EVIDENCE', `${at}: 증빙이 비어 있습니다.`, v.no);
        if (l.vat > 0 && known[l.code] && known[l.code].vat !== '과세') add('warn', 'VAT_ON_NON_TAXABLE', `${at}: 과세 계정이 아닌 ${l.code} 에 부가세액이 있습니다.`, v.no);
        if (known[l.code] && known[l.code].added && !opts.chartSynced && !addedSeen[l.code]) { addedSeen[l.code] = 1; add('info', 'ADDED_ACCOUNT', `${l.code} ${known[l.code].name} 은 엑셀에 없는 계정입니다. 엑셀 '계정과목' 시트에 같은 코드로 추가하세요 (${known[l.code].why || ''}).`, v.no); }
      });
      // 수기 매출 전표와 자동 매출 전표가 같은 날 겹치면 매출이 두 번 잡힌다
      if (v.source === 'manual' && salesDates[v.date] && ls.some(l => (l.code === '401' || l.code === '403') && l.credit) && ls.some(l => ['101', '103', '104'].includes(l.code) && l.debit))
        add('error', 'DUPLICATE_SALES', `${v.date} 에 자동 매출전표(${salesDates[v.date]})가 있는데 수기 매출전표도 있습니다. 둘 중 하나만 남기세요 (설정 → 자동매출 시작일).`, v.no);
      // 학습된 실수 패턴: 연간 비용을 한 달에 몰아 처리
      ls.forEach(l => { if (['510', '513'].includes(l.code) && l.debit >= (opts.largeExpense || 3000000) && v.source === 'manual')
        add('info', 'LUMP_EXPENSE', `${l.memo || l.code} ${fmt(l.debit)}원이 한 달 비용으로 잡혔습니다. 여러 달 쓰는 비용이면 '선급 비용' 템플릿으로 바꾸면 월별 손익이 정확해집니다.`, v.no); });
      ls.forEach(l => { if (l.code === '516' && /우유|원두|식자재|재료|시럽|과일|사과/.test(l.memo + l.note))
        add('info', 'COGS_AS_SUPPLIES', `${l.memo}: 판매용 재료는 516 소모품비보다 509 원재료비로 분리하면 카페 마진을 볼 수 있습니다.`, v.no); });
    });
    const lines = flatten(vouchers);
    const tb = trialBalance(lines, chart, {});
    if (!tb.balanced) add('error', 'TB_UNBALANCED', `전체 차변(${fmt(tb.totalDebit)})과 대변(${fmt(tb.totalCredit)})이 다릅니다.`);
    if (!tb.complete) add('error', 'TB_INCOMPLETE', `계정별 합계가 전체 합계와 다릅니다 (계정표 누락).`);
    const vr = vatReport(lines, chart, '0000-01-01', '9999-12-31');
    vr.voucherMismatches.forEach(m => add('warn', 'VAT_LINE_MISMATCH', `${m.kind}: 부가세 계정에는 ${fmt(m.booked)}원, 공급가액 라인의 부가세액(H열) 합계는 ${fmt(m.onLines)}원입니다. 신고자료가 ${fmt(m.booked - m.onLines)}원 어긋납니다.`, m.no));
    // 현금 잔액이 음수가 되는 날
    const cash = generalLedger(lines, chart, '101');
    const neg = cash.rows.find(r => r.balance < 0);
    if (neg) add('warn', 'NEGATIVE_CASH', `${neg.date} 현금 잔액이 ${fmt(neg.balance)}원으로 음수입니다. 입금·지출 전표 누락을 확인하세요.`, neg.no);
    // 카드 미정산 경과일 (선입선출)
    const asOf = opts.asOf || kstDate(new Date().toISOString());
    const aging = cardAging(lines, asOf);
    if (aging.overdue > 0) add('warn', 'CARD_UNSETTLED', `카드매출 ${fmt(aging.overdue)}원이 ${opts.cardSettleDays || 5}일 넘게 입금되지 않았습니다 (가장 오래된 매출 ${aging.oldest}). '카드매출 입금 정산'을 입력하세요.`);
    return issues;
  }

  function cardAging(lines, asOf, days) {
    days = days || 5;
    const lots = []; let settled = 0;
    lines.forEach(l => { if (l.code !== '103') return; if (l.debit) lots.push({ date: l.date, amt: l.debit }); if (l.credit) settled += l.credit; });
    lots.forEach(x => { const use = Math.min(x.amt, settled); x.amt -= use; settled -= use; });
    const limit = new Date(new Date(asOf + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10);
    const open = lots.filter(x => x.amt > 0);
    const overdue = open.filter(x => x.date < limit).reduce((s, x) => s + x.amt, 0);
    return { open: open, unsettled: open.reduce((s, x) => s + x.amt, 0), overdue: overdue, oldest: open.length ? open[0].date : '' };
  }

  /* ---------- 8. ① 수집 → ⑦ 마감 까지 한 번에: 장부 조립 ---------- */
  //  state  : { manual:[voucher], schedules:[], settings:{autoSalesStart, closedYears:[]}, locks:{ 'YYYY-MM': {snapshot:[voucher]} } }
  //  source : { items, payments, closings }
  function assembleBooks(state, source, opts) {
    state = state || {}; source = source || {}; opts = opts || {};
    const settings = state.settings || {};
    const chart = buildChart(state.chartExtra);
    const warnings = [];
    const manual = (state.manual || []).map(v => Object.assign({ source: 'manual' }, v));
    const locks = state.locks || {};

    const sales = buildDailySalesVouchers(source.items, source.payments, { startDate: settings.autoSalesStart || '', excludeDates: settings.manualSalesDates || [] });
    const cashOS = buildCashOverShortVouchers(source.closings, { startDate: settings.autoSalesStart || '' });
    warnings.push(...sales.warnings, ...cashOS.warnings);
    let auto = sales.vouchers.concat(cashOS.vouchers);

    // 자동 전표가 다룰 기간: 첫 거래월 ~ 기준월(오늘)
    const today = opts.today || kstDate(new Date().toISOString());
    const allDates = manual.concat(auto).map(v => v.date).filter(Boolean).sort();
    const schedStarts = (state.schedules || []).map(s => s.start).filter(Boolean).sort();
    const firstP = [allDates[0] && periodOf(allDates[0]), schedStarts[0]].filter(Boolean).sort()[0] || periodOf(today);
    const lastP = opts.toPeriod || periodOf(today);
    const periods = periodsBetween(firstP, lastP);

    let adjust = buildScheduleVouchers(state.schedules, periods);
    const preVat = flatten(manual.concat(auto, adjust));
    adjust = adjust.concat(buildVatClearingVouchers(preVat, periods.filter(p => lastDayOf(p) <= today || opts.includeOpenVat)));

    // 잠긴 달: 스냅샷으로 고정하고 원천 변동은 경고
    Object.keys(locks).forEach(p => {
      const snap = (locks[p] && locks[p].snapshot) || [];
      const fresh = auto.concat(adjust).filter(v => periodOf(v.date) === p);
      const sig = vs => JSON.stringify(vs.map(v => [v.no, v.lines.map(l => [l.code, l.debit, l.credit])]).sort());
      if (sig(fresh) !== sig(snap)) warnings.push({ level: 'warn', code: 'LOCKED_SOURCE_CHANGED', message: `${p} 은 마감(잠금)됐지만 이후 원천 데이터가 바뀌었습니다 (발권취소 등). 잠금 스냅샷 기준으로 표시합니다. 정정이 필요하면 다음 달에 수정 전표를 입력하세요.` });
      auto = auto.filter(v => periodOf(v.date) !== p);
      adjust = adjust.filter(v => periodOf(v.date) !== p);
      snap.forEach(v => (v.source === 'adjust' ? adjust : auto).push(v));
    });

    let all = manual.concat(auto, adjust);
    (settings.closedYears || []).forEach(y => { all = all.concat(buildYearCloseVouchers(flatten(all), chart, y)); });
    all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no < b.no ? -1 : 1));
    const lines = flatten(all);
    const issues = validate(all, chart, { asOf: today, chartSynced: settings.chartSynced, cardSettleDays: settings.cardSettleDays });
    return { chart: chart, vouchers: all, lines: lines, periods: periods, warnings: warnings.concat(issues), today: today };
  }

  function lockSnapshot(books, period) {
    return books.vouchers.filter(v => periodOf(v.date) === period && (v.source === 'auto_sales' || v.source === 'adjust'))
      .map(v => JSON.parse(JSON.stringify(v)));
  }

  /* ---------- 9. 엑셀 연동 (회계_최소셋 전표 시트 A~J) ---------- */
  const MINISET_HEADER = ['전표번호', '날짜', '증빙', '적요', '계정코드', '차변', '대변', '부가세액', '거래처', '비고'];
  function toMinisetRows(vouchers) {
    const rows = [];
    (vouchers || []).forEach(v => (v.lines || []).forEach(l => rows.push([v.no, v.date, l.evidence, l.memo, l.code,
      l.debit || '', l.credit || '', l.vat || '', l.partner, l.note])));
    return rows;
  }
  function toTsv(rows) { return rows.map(r => r.map(c => String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n'); }
  function toCsv(rows) { return '﻿' + rows.map(r => r.map(c => { const s = String(c == null ? '' : c); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n'); }

  // 엑셀 전표 시트 행(배열의 배열) → 수기 전표. 머리행·빈 행·안내문은 건너뛴다.
  function parseMinisetRows(rows) {
    const byNo = {}, order = [], errors = [];
    (rows || []).forEach((r, i) => {
      if (!r || !r.length) return;
      const no = String(r[0] == null ? '' : r[0]).trim();
      const code = String(r[4] == null ? '' : r[4]).trim();
      if (!no || no === '전표번호' || !/^\d{3}$/.test(code)) return;
      const num = v => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[,원\s]/g, '')); if (isNaN(n)) { errors.push(`${i + 1}행: 숫자가 아닌 금액 "${v}"`); return 0; } return Math.round(n); };
      if (!byNo[no]) { byNo[no] = { no: no, date: normDate(r[1]), source: 'manual', title: String(r[3] || ''), lines: [] }; order.push(no); }
      byNo[no].lines.push(line({ evidence: r[2] || '', memo: r[3] || '', code: code, debit: num(r[5]), credit: num(r[6]), vat: num(r[7]), partner: r[8] || '', note: r[9] || '' }));
    });
    return { vouchers: order.map(n => byNo[n]), errors: errors };
  }
  function parseTsv(text) { return String(text || '').replace(/\r/g, '').split('\n').filter(s => s.trim()).map(s => s.split('\t')); }

  // 계정과목 시트 행 → chartExtra (엑셀에서 계정을 추가했으면 반영)
  function parseChartRows(rows) {
    return (rows || []).filter(r => r && /^\d{3}$/.test(String(r[0] == null ? '' : r[0]).trim()) && TYPES.includes(String(r[2] || '').trim()))
      .map(r => ({ code: String(r[0]).trim(), name: String(r[1] || '').trim(), type: String(r[2]).trim(), vat: String(r[3] || '해당없음').trim() }));
  }

  function fmt(n) { return (Math.round(Number(n) || 0)).toLocaleString('ko-KR'); }

  const api = {
    VERSION: '2026-10-08.1',
    BASE_CHART: BASE_CHART, ADDED_CHART: ADDED_CHART, TYPES: TYPES, EVIDENCE: EVIDENCE, TEMPLATES: TEMPLATES, METHOD_RULES: METHOD_RULES, MINISET_HEADER: MINISET_HEADER,
    buildChart: buildChart, findAccount: findAccount, revenueCodeOf: revenueCodeOf, vatOfGross: vatOfGross,
    kstDate: kstDate, normDate: normDate, periodOf: periodOf, lastDayOf: lastDayOf, addMonths: addMonths, periodsBetween: periodsBetween,
    buildDailySalesVouchers: buildDailySalesVouchers, buildCashOverShortVouchers: buildCashOverShortVouchers,
    buildFromTemplate: buildFromTemplate, nextManualNo: nextManualNo,
    scheduleAmount: scheduleAmount, buildScheduleVouchers: buildScheduleVouchers, buildVatClearingVouchers: buildVatClearingVouchers, buildYearCloseVouchers: buildYearCloseVouchers,
    flatten: flatten, generalLedger: generalLedger, trialBalance: trialBalance, incomeStatement: incomeStatement, monthlyPnl: monthlyPnl,
    balanceSheet: balanceSheet, vatReport: vatReport, validate: validate, cardAging: cardAging,
    assembleBooks: assembleBooks, lockSnapshot: lockSnapshot,
    toMinisetRows: toMinisetRows, toTsv: toTsv, toCsv: toCsv, parseMinisetRows: parseMinisetRows, parseTsv: parseTsv, parseChartRows: parseChartRows, fmt: fmt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.BongplayAccounting = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

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
  //  opts     : { from, to, startDate(이 날짜부터 자동 — 공통 정책 auto_sales_start) }
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
      && (!opts.startDate || d >= opts.startDate);

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
    let curDate = '';
    const add = (level, code, message, no, date) => issues.push({ level: level, code: code, message: message, voucher: no || '', date: date != null ? date : curDate });
    const salesDates = {}, addedSeen = {};
    const reviews = opts.reviews || {};
    (vouchers || []).forEach(v => {
      if (v.source === 'auto_sales' && !/-CASH$/.test(v.no)) salesDates[v.date] = v.no;
    });
    (vouchers || []).forEach(v => {
      curDate = v.date || '';
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
      // 수기 수익 전표와 자동 매출 전표가 같은 날 있으면 '잠재 충돌' (상대계정과 무관하게 수익 대변으로 판단).
      // 같은 날 수기 매출이 모두 중복은 아니므로 자동 삭제·상계·제외하지 않고, 명시적 검토 기록으로만 해소한다.
      if (v.source === 'manual' && salesDates[v.date] && ls.some(l => known[l.code] && known[l.code].type === '수익' && won(l.credit) > 0)) {
        const rv = reviews[v.no];
        const current = rv && rv.signature === voucherSignature(v);
        if (current && rv.decision === 'separate')
          add('info', 'SALES_CONFLICT_REVIEWED', `${v.date} 수기 수익 전표는 자동 매출전표(${salesDates[v.date]})와 별개 거래로 검토됐습니다 (근거: ${rv.reference || '-'}).`, v.no);
        else if (current && rv.decision === 'duplicate')
          add('error', 'SALES_DUPLICATE_CONFIRMED', `${v.date} 수기 수익 전표가 자동 매출전표(${salesDates[v.date]})와 같은 매출로 판정됐습니다. 수기 전표를 직접 정정·삭제하세요 (자동 처리하지 않음).`, v.no);
        else
          add('warn', 'SALES_CONFLICT_POTENTIAL', `${v.date} 자동 매출전표(${salesDates[v.date]})와 같은 날 수기 수익 전표가 있습니다. 같은 매출인지 검토하세요.${rv ? ' 검토 후 전표가 바뀌어 다시 검토해야 합니다.' : ''}`, v.no);
      }
      // 학습된 실수 패턴: 연간 비용을 한 달에 몰아 처리
      ls.forEach(l => { if (['510', '513'].includes(l.code) && l.debit >= (opts.largeExpense || 3000000) && v.source === 'manual')
        add('info', 'LUMP_EXPENSE', `${l.memo || l.code} ${fmt(l.debit)}원이 한 달 비용으로 잡혔습니다. 여러 달 쓰는 비용이면 '선급 비용' 템플릿으로 바꾸면 월별 손익이 정확해집니다.`, v.no); });
      ls.forEach(l => { if (l.code === '516' && /우유|원두|식자재|재료|시럽|과일|사과/.test(l.memo + l.note))
        add('info', 'COGS_AS_SUPPLIES', `${l.memo}: 판매용 재료는 516 소모품비보다 509 원재료비로 분리하면 카페 마진을 볼 수 있습니다.`, v.no); });
    });
    curDate = '';
    const lines = flatten(vouchers);
    const tb = trialBalance(lines, chart, {});
    if (!tb.balanced) add('error', 'TB_UNBALANCED', `전체 차변(${fmt(tb.totalDebit)})과 대변(${fmt(tb.totalCredit)})이 다릅니다.`);
    if (!tb.complete) add('error', 'TB_INCOMPLETE', `계정별 합계가 전체 합계와 다릅니다 (계정표 누락).`);
    const vr = vatReport(lines, chart, '0000-01-01', '9999-12-31');
    vr.voucherMismatches.forEach(m => add('warn', 'VAT_LINE_MISMATCH', `${m.kind}: 부가세 계정에는 ${fmt(m.booked)}원, 공급가액 라인의 부가세액(H열) 합계는 ${fmt(m.onLines)}원입니다. 신고자료가 ${fmt(m.booked - m.onLines)}원 어긋납니다.`, m.no, m.date));
    // 현금 잔액이 음수가 되는 날
    const cash = generalLedger(lines, chart, '101');
    const neg = cash.rows.find(r => r.balance < 0);
    if (neg) add('warn', 'NEGATIVE_CASH', `${neg.date} 현금 잔액이 ${fmt(neg.balance)}원으로 음수입니다. 입금·지출 전표 누락을 확인하세요.`, neg.no, neg.date);
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

  /* ---------- 8. 자동매출 정책 (공통 설정 SSOT: bongplay-site.js accounting) ---------- */
  // 시작일은 대표 결정 사항이라 화면·기기별로 바꾸지 않는다. null 이면 자동매출·시재 자동분개·최종 마감 차단.
  function normalizePolicy(p) {
    p = p || {};
    const raw = p.autoSalesStart !== undefined ? p.autoSalesStart : p.auto_sales_start;
    const valid = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !isNaN(Date.parse(raw + 'T00:00:00Z'))
      && new Date(Date.parse(raw + 'T00:00:00Z')).toISOString().slice(0, 10) === raw;
    return { autoSalesStart: valid ? raw : null, version: String(p.version || p.policy_version || ''), source: String(p.source || ''),
      invalid: raw != null && raw !== '' && !valid };
  }
  function voucherSignature(v) {
    return JSON.stringify([v.date, (v.lines || []).map(l => [String(l.code), won(l.debit), won(l.credit)])]);
  }

  /* ---------- 9. ① 수집 → ⑦ 마감 까지 한 번에: 장부 조립 ---------- */
  //  state  : { manual:[voucher], schedules:[], salesReviews:{no:{decision,reference,signature}}, settings:{closedYears:[]}, locks:{ 'YYYY-MM': {snapshot:[voucher]} } }
  //  source : { items, payments, closings }  — 완전 조회된 스냅샷(또는 미확정 로컬 자료)
  //  opts   : { policy:{autoSalesStart, version, source}, today, toPeriod }
  function assembleBooks(state, source, opts) {
    state = state || {}; source = source || {}; opts = opts || {};
    const settings = state.settings || {};
    const chart = buildChart(state.chartExtra);
    const warnings = [];
    const manual = (state.manual || []).map(v => Object.assign({ source: 'manual' }, v));
    const locks = state.locks || {};
    const policy = normalizePolicy(opts.policy);

    let auto = [];
    if (policy.autoSalesStart) {
      const sales = buildDailySalesVouchers(source.items, source.payments, { startDate: policy.autoSalesStart });
      const cashOS = buildCashOverShortVouchers(source.closings, { startDate: policy.autoSalesStart });
      warnings.push(...sales.warnings.map(w => Object.assign({ date: String(w.voucher || '').slice(2, 12) }, w)), ...cashOS.warnings);
      auto = sales.vouchers.concat(cashOS.vouchers);
    } else {
      warnings.push({ level: 'warn', code: policy.invalid ? 'AUTO_SALES_POLICY_INVALID' : 'AUTO_SALES_POLICY_UNSET', voucher: '', date: '',
        message: policy.invalid ? '공통 설정의 자동매출 시작일 형식이 잘못돼 자동매출·시재 자동분개를 멈췄습니다 (YYYY-MM-DD).'
          : '자동매출 시작일이 정해지지 않아(공통 설정 null) 자동매출·시재 자동분개와 최종 마감을 멈췄습니다. 수기 장부 조회·백업은 가능합니다.' });
    }
    if (settings.autoSalesStart || (settings.manualSalesDates || []).length)
      warnings.push({ level: 'info', code: 'LEGACY_LOCAL_SETTING_IGNORED', voucher: '', date: '', message: '이 기기에 저장된 예전 자동매출 시작일·수기 유지 날짜 설정은 더 이상 쓰지 않습니다 (공통 설정 기준).' });

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
      if (sig(fresh) !== sig(snap)) warnings.push({ level: 'warn', code: 'LOCKED_SOURCE_CHANGED', voucher: '', date: p + '-01', message: `${p} 은 마감(잠금)됐지만 이후 원천 데이터가 바뀌었습니다 (발권취소 등). 잠금 스냅샷 기준으로 표시합니다. 정정이 필요하면 다음 달에 수정 전표를 입력하세요.` });
      auto = auto.filter(v => periodOf(v.date) !== p);
      adjust = adjust.filter(v => periodOf(v.date) !== p);
      snap.forEach(v => (v.source === 'adjust' ? adjust : auto).push(v));
    });

    let all = manual.concat(auto, adjust);
    (settings.closedYears || []).forEach(y => { all = all.concat(buildYearCloseVouchers(flatten(all), chart, y)); });
    all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no < b.no ? -1 : 1));
    const lines = flatten(all);
    const issues = validate(all, chart, { asOf: today, chartSynced: settings.chartSynced, cardSettleDays: settings.cardSettleDays, reviews: state.salesReviews });
    return { chart: chart, vouchers: all, lines: lines, periods: periods, warnings: warnings.concat(issues), today: today, policy: policy };
  }

  function lockSnapshot(books, period) {
    return books.vouchers.filter(v => periodOf(v.date) === period && (v.source === 'auto_sales' || v.source === 'adjust'))
      .map(v => JSON.parse(JSON.stringify(v)));
  }

  /* ---------- 10. 원천 수집 — 키 기반(keyset) 완전 조회 ---------- */
  // select(table, query) → { ok, data, from_local_cache? }  (BongplaySync.select 와 같은 계약 — 공통 sync 파일은 수정하지 않음)
  // · offset 대신 '마지막으로 받은 키 다음부터'(key=gt.last, order=key.asc) → 서버 행 상한이 작아도 누락 없음.
  //   키: order_items.item_id(FINAL 스키마 PK) · order_payments.id(PK) · closing_records.id(PK). createOrder 가 1회 생성하고
  //   patch 는 키를 바꾸지 않는다. 운영 DB 의 실제 PK 는 미검증 → 조회 중 키 중복·빈 키는 실패로 처리한다.
  // · 빈 페이지까지 읽고, 반복 행·진행 없음·시간/행/페이지 상한·요청 실패는 '불완전'으로 실패시킨다.
  // · 본 조회 뒤 키·상태 열만 한 번 더 읽어 서명이 다르면 동시 변경(CONCURRENT_CHANGE)으로 실패시킨다.
  // · 실패하면 자료를 돌려주지 않는다 (호출 측이 마지막 정상 스냅샷을 유지).
  const SOURCE_SPECS = [
    { name: 'items', table: 'order_items', key: 'item_id', time: 'purchased_at', timeKind: 'ts', verify: ['item_id', 'status', 'paid_amount', 'purchased_at'] },
    { name: 'payments', table: 'order_payments', key: 'id', time: 'paid_at', timeKind: 'ts', verify: ['id', 'status', 'amount', 'paid_at'] },
    { name: 'closings', table: 'closing_records', key: 'id', time: 'date', timeKind: 'date', verify: ['id', 'date', 'diff_amount'] }
  ];
  const SOURCE_FAIL_TEXT = {
    REQUEST_FAILED: '서버 요청 실패', NULL_KEY: '키가 비어 있는 행이 있어 빠짐없이 셀 수 없음', NULL_TIME: '기준 시각이 비어 있는 행이 있어 기간에 넣을 수 없음',
    NO_PROGRESS: '다음 페이지가 진행되지 않음', REPEATED_ROWS: '이미 받은 행이 다시 옴 (키 중복 또는 정렬 불일치)',
    ROW_LIMIT: '행 상한 초과', TIME_LIMIT: '시간 상한 초과', PAGE_LIMIT: '페이지 상한 초과', CONCURRENT_CHANGE: '조회 중 원천이 바뀜 (다시 조회 필요)',
    BAD_RANGE: '조회 기간이 올바르지 않음'
  };
  function nextDay(d) { return new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }
  function rangeFilter(spec, from, to) {
    if (spec.timeKind === 'date') return `&${spec.time}=gte.${from}&${spec.time}=lte.${to}`;
    return `&${spec.time}=gte.${encodeURIComponent(from + 'T00:00:00+09:00')}&${spec.time}=lt.${encodeURIComponent(nextDay(to) + 'T00:00:00+09:00')}`;
  }
  async function scanTable(select, spec, range, opts) {
    opts = opts || {};
    const pageSize = opts.pageSize || 1000, maxRows = opts.maxRows || 300000, maxPages = opts.maxPages || 5000, maxMs = opts.maxMs || 120000;
    const now = opts.now || (() => Date.now());
    const t0 = now();
    const rf = rangeFilter(spec, range.from, range.to);
    const fail = (reason, detail) => ({ ok: false, table: spec.table, reason: reason, detail: detail || SOURCE_FAIL_TEXT[reason] || '' });
    const call = async (q) => {
      let r;
      try { r = await select(spec.table, q); } catch (e) { return { bad: 'exception: ' + (e && e.message) }; }
      if (!r || r.ok !== true || !Array.isArray(r.data) || r.from_local_cache) return { bad: (r && (r.from_local_cache ? 'local_cache' : r.reason)) || 'error' };
      return { data: r.data };
    };
    let r = await call(`?select=${spec.key}${rf}&${spec.key}=is.null&limit=1`);
    if (r.bad) return fail('REQUEST_FAILED', r.bad);
    if (r.data.length) return fail('NULL_KEY');
    r = await call(`?select=${spec.key}&${spec.time}=is.null&limit=1`);
    if (r.bad) return fail('REQUEST_FAILED', r.bad);
    if (r.data.length) return fail('NULL_TIME');

    async function pass(cols) {
      const seen = new Set(), rows = [];
      let last = null, pages = 0;
      for (;;) {
        if (now() - t0 > maxMs) return { err: 'TIME_LIMIT' };
        if (pages >= maxPages) return { err: 'PAGE_LIMIT' };
        const q = `?select=${cols}${rf}&order=${spec.key}.asc&limit=${pageSize}` + (last == null ? '' : `&${spec.key}=gt.${encodeURIComponent(last)}`);
        const res = await call(q); pages++;
        if (res.bad) return { err: 'REQUEST_FAILED', detail: `${res.bad} (${pages}번째 페이지)` };
        if (!res.data.length) return { rows: rows, pages: pages };
        let fresh = 0;
        for (const row of res.data) {
          const k = row ? row[spec.key] : null;
          if (k == null || k === '') return { err: 'NULL_KEY' };
          if (seen.has(String(k))) continue;
          seen.add(String(k)); fresh++; rows.push(row);
        }
        if (fresh === 0) return { err: 'NO_PROGRESS' };
        if (fresh < res.data.length) return { err: 'REPEATED_ROWS' };
        if (rows.length > maxRows) return { err: 'ROW_LIMIT' };
        last = String(res.data[res.data.length - 1][spec.key]);
      }
    }
    const sig = rows => rows.map(x => JSON.stringify(spec.verify.map(c => x[c] == null ? null : String(x[c])))).sort().join('\n');
    const main = await pass('*');
    if (main.err) return fail(main.err, main.detail);
    const check = await pass(spec.verify.join(','));
    if (check.err) return fail(check.err, check.detail);
    if (check.rows.length !== main.rows.length || sig(check.rows) !== sig(main.rows)) return fail('CONCURRENT_CHANGE');
    return { ok: true, table: spec.table, rows: main.rows, count: main.rows.length, pages: main.pages + check.pages };
  }
  // 세 원천을 모두 완전하게 받았을 때만 ok. 하나라도 실패하면 자료 없이 실패 내역만 반환한다.
  async function collectSources(select, range, opts) {
    opts = opts || {};
    const at = opts.nowIso ? opts.nowIso() : new Date().toISOString();
    if (!range || !/^\d{4}-\d{2}-\d{2}$/.test(range.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(range.to || '') || range.from > range.to)
      return { ok: false, at: at, range: range || null, failures: [{ table: '-', reason: 'BAD_RANGE', detail: SOURCE_FAIL_TEXT.BAD_RANGE }] };
    const data = {}, counts = {}, failures = [];
    for (const spec of SOURCE_SPECS) {
      const r = await scanTable(select, spec, range, opts);
      if (!r.ok) { failures.push({ table: r.table, reason: r.reason, detail: r.detail }); break; }
      data[spec.name] = r.rows; counts[spec.name] = r.count;
    }
    if (failures.length) return { ok: false, at: at, range: { from: range.from, to: range.to }, failures: failures };
    return { ok: true, at: at, range: { from: range.from, to: range.to }, data: data, counts: counts };
  }
  // 범위별 교체: 성공하면 그 범위의 자료를 통째로 바꾼다 (재조회 시 취소·삭제된 행이 남지 않음).
  // 실패하면 마지막 정상 스냅샷을 그대로 두고 lastAttempt 에 실패를 기록한다 (부분 자료를 섞지 않음).
  function applyCollectResult(prev, result) {
    if (result && result.ok) return { complete: true, range: result.range, fetchedAt: result.at, counts: result.counts, data: result.data, lastAttempt: { ok: true, at: result.at, range: result.range } };
    const base = prev || { complete: false, range: null, fetchedAt: null, counts: null, data: null };
    return Object.assign({}, base, { lastAttempt: { ok: false, at: result && result.at, range: result && result.range, failures: (result && result.failures) || [] } });
  }
  // 스냅샷이 [from, to] 를 완전하게 덮고, 가장 최근 시도도 성공했는가
  function snapshotCovers(snap, from, to) {
    return !!(snap && snap.complete && snap.range && snap.data && snap.lastAttempt && snap.lastAttempt.ok && snap.range.from <= from && snap.range.to >= to);
  }
  // 장부에 필요한 원천 범위 = 자동매출 시작일 ~ 기준월 말일. 시작일 전은 수기 전표가 장부의 원천이다.
  // 누적 재무상태표·카드 미정산 경과는 이 전체 범위가 있어야 맞는다 — 기준월만 받으면 안 된다.
  function requiredSourceRange(policy, period) {
    const p = normalizePolicy(policy);
    if (!p.autoSalesStart) return null;
    const to = lastDayOf(period);
    if (to < p.autoSalesStart) return { from: p.autoSalesStart, to: p.autoSalesStart, empty: true };
    return { from: p.autoSalesStart, to: to };
  }

  /* ---------- 11. 최종 마감 준비 검사 — 버튼 표시와 실제 처리가 같은 함수를 쓴다 ---------- */
  // ctx: { policy, snapshot, pendingCount(이 기기 미전송, 모르면 null), seal(서버 기간 확정 증명 — 현재 계약 없음 → null),
  //        today, nowMs, maxAgeMs, nowIso }
  function closeReadiness(books, period, ctx) {
    ctx = ctx || {};
    const checks = [];
    const add = (id, label, ok, detail, kind) => checks.push({ id: id, label: label, ok: !!ok, detail: detail || '', kind: kind || 'required' });
    const policy = normalizePolicy(ctx.policy);
    const today = ctx.today || kstDate(new Date().toISOString());
    const end = lastDayOf(period);
    add('PERIOD_ENDED', '기간 종료', end < today, end < today ? `${period} 종료` : `${period} 이 아직 끝나지 않았습니다 (${end} 이후 마감)`);
    add('POLICY', '자동매출 시작일 정책 확정', !!policy.autoSalesStart,
      policy.autoSalesStart ? `${policy.autoSalesStart} · ${policy.version || '버전 없음'} · ${policy.source || '출처 없음'}` : '공통 설정 accounting.auto_sales_start 가 null — 대표 결정 필요');

    // 조회 완전성: 시작일~기준월 말일 전체를 최근에 빠짐없이 받았는가
    const need = requiredSourceRange(ctx.policy, period);
    const snap = ctx.snapshot;
    const maxAge = ctx.maxAgeMs != null ? ctx.maxAgeMs : 10 * 60 * 1000;
    const nowMs = ctx.nowMs != null ? ctx.nowMs : Date.now();
    let srcOk = false, srcDetail = '';
    if (!need) srcDetail = '정책 미확정으로 필요한 조회 범위를 정할 수 없음';
    else if (!snapshotCovers(snap, need.from, need.to)) {
      const la = snap && snap.lastAttempt;
      srcDetail = la && !la.ok ? `최근 조회 실패: ${(la.failures || []).map(f => `${f.table} ${f.reason}`).join(', ')}`
        : `${need.from} ~ ${need.to} 전체를 완전하게 받은 자료가 없음${snap && snap.range ? ` (보유: ${snap.range.from} ~ ${snap.range.to})` : ''}`;
    } else if (!(nowMs - Date.parse(snap.fetchedAt) <= maxAge)) srcDetail = `조회 후 ${Math.round((nowMs - Date.parse(snap.fetchedAt)) / 60000)}분 지남 — 마감 직전에 다시 조회해야 함`;
    else { srcOk = true; srcDetail = `${need.from} ~ ${need.to} · 품목 ${snap.counts.items} · 결제 ${snap.counts.payments} · 마감기록 ${snap.counts.closings}`; }
    add('SOURCE_COMPLETE', '원천 조회 완전성', srcOk, srcDetail);

    // 원천 확정: 다른 단말 미전송·사후 변경이 없음을 서버가 증명해야 한다. 현재 서버 계약이 없어 항상 미충족.
    const seal = ctx.seal;
    let sealOk = false, sealDetail = '서버에 기간 확정(봉인) 계약이 없어 다른 단말의 미전송·사후 변경이 없음을 증명할 수 없음';
    if (seal && srcOk) {
      const inP = (rows, f) => (rows || []).filter(x => periodOf(kstDate(x[f])) === period && x.status !== 'cancelled');
      const its = inP(snap.data.items, 'purchased_at'), pays = inP(snap.data.payments, 'paid_at');
      const mine = { items_count: its.length, items_sum: its.reduce((s, x) => s + itemAmount(x), 0), payments_count: pays.length, payments_sum: pays.reduce((s, x) => s + won(x.amount), 0) };
      const diff = Object.keys(mine).filter(k => won(seal[k]) !== mine[k]);
      sealOk = seal.period === period && !!seal.sealed_at && !diff.length;
      sealDetail = sealOk ? `서버 봉인 ${seal.sealed_at} 와 일치` : `서버 봉인과 불일치: ${seal.period !== period ? '기간 ' : ''}${diff.join(', ')}`;
    } else if (seal) sealDetail = '조회 완전성이 먼저 충족돼야 봉인과 대조할 수 있음';
    add('SOURCE_SEALED', '원천 확정 (서버 봉인)', sealOk, sealDetail);

    // 대사·검증: 이 기간(또는 날짜 없는 전역) 오류, 미검토 잠재 충돌, 잠금 후 원천 변동
    const blocking = (books.warnings || []).filter(w => (w.level === 'error' || w.code === 'SALES_CONFLICT_POTENTIAL')
      && (!w.date || periodOf(w.date) === period));
    add('RECONCILE', '대사·검증 오류와 미검토 충돌 0건', blocking.length === 0, blocking.length ? blocking.slice(0, 5).map(w => `${w.voucher ? w.voucher + ' ' : ''}${w.code}`).join(', ') + (blocking.length > 5 ? ` 외 ${blocking.length - 5}건` : '') : '없음');

    // 보조 조건 (필요하지만 충분하지 않음 — 다른 단말의 상태는 증명하지 못한다)
    add('LOCAL_OUTBOX', '이 기기 미전송 0건 (보조 — 다른 단말은 증명 못 함)', ctx.pendingCount === 0, ctx.pendingCount == null ? '확인 불가' : `${ctx.pendingCount}건`, 'aux');
    const salesDays = (books.vouchers || []).filter(v => v.source === 'auto_sales' && !/-CASH$/.test(v.no) && periodOf(v.date) === period).map(v => v.date);
    const closed = {}; ((snap && snap.data && snap.data.closings) || []).forEach(c => { closed[normDate(c.date || String(c.id || '').replace(/^cls_/, ''))] = 1; });
    const missing = salesDays.filter(d => !closed[d]);
    add('DAILY_CLOSING', '매출일마다 일일 마감 기록 (보조)', srcOk && missing.length === 0,
      !srcOk ? '조회 완전성 미충족' : missing.length ? `마감 기록 없음: ${missing.join(', ')}` : `${salesDays.length}일 모두 있음`, 'aux');

    return { period: period, ok: checks.every(c => c.ok), checks: checks };
  }
  // 실제 처리 함수 — 화면 버튼과 같은 검사를 다시 수행하고, 통과할 때만 잠금 기록을 만든다 (우회 경로 없음).
  function attemptLock(state, books, period, ctx) {
    ctx = ctx || {};
    if (state && state.locks && state.locks[period]) return { ok: false, reason: 'ALREADY_LOCKED' };
    const readiness = closeReadiness(books, period, ctx);
    if (!readiness.ok) return { ok: false, reason: 'NOT_READY', readiness: readiness };
    const policy = normalizePolicy(ctx.policy);
    return { ok: true, readiness: readiness, lock: { locked_at: ctx.nowIso || new Date().toISOString(), snapshot: lockSnapshot(books, period),
      policy: { autoSalesStart: policy.autoSalesStart, version: policy.version, source: policy.source },
      source: { range: ctx.snapshot.range, fetchedAt: ctx.snapshot.fetchedAt, counts: ctx.snapshot.counts }, seal: ctx.seal || null,
      readiness: readiness.checks.map(c => ({ id: c.id, ok: c.ok, detail: c.detail })) } };
  }
  // 연 마감: 12월 최종 마감 조건 + 그해 거래가 있는 다른 달이 모두 잠겨 있어야 한다.
  function attemptYearClose(state, books, year, ctx) {
    const y = String(year);
    if (((state && state.settings && state.settings.closedYears) || []).includes(y)) return { ok: false, reason: 'ALREADY_CLOSED' };
    const readiness = closeReadiness(books, `${y}-12`, ctx);
    const months = {}; (books.vouchers || []).forEach(v => { if (String(v.date).slice(0, 4) === y && v.source !== 'closing') months[periodOf(v.date)] = 1; });
    const unlocked = Object.keys(months).filter(p => p !== `${y}-12` && !(state && state.locks && state.locks[p])).sort();
    if (unlocked.length) readiness.checks.push({ id: 'MONTHS_LOCKED', label: '그해 거래월 모두 마감', ok: false, detail: `미마감: ${unlocked.join(', ')}`, kind: 'required' });
    readiness.ok = readiness.checks.every(c => c.ok);
    if (!readiness.ok) return { ok: false, reason: 'NOT_READY', readiness: readiness };
    return { ok: true, readiness: readiness };
  }

  /* ---------- 12. 엑셀 연동 (회계_최소셋 전표 시트 A~J) ---------- */
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
    VERSION: '2026-10-09.1',
    BASE_CHART: BASE_CHART, ADDED_CHART: ADDED_CHART, TYPES: TYPES, EVIDENCE: EVIDENCE, TEMPLATES: TEMPLATES, METHOD_RULES: METHOD_RULES, MINISET_HEADER: MINISET_HEADER,
    buildChart: buildChart, findAccount: findAccount, revenueCodeOf: revenueCodeOf, vatOfGross: vatOfGross,
    kstDate: kstDate, normDate: normDate, periodOf: periodOf, lastDayOf: lastDayOf, addMonths: addMonths, periodsBetween: periodsBetween,
    buildDailySalesVouchers: buildDailySalesVouchers, buildCashOverShortVouchers: buildCashOverShortVouchers,
    buildFromTemplate: buildFromTemplate, nextManualNo: nextManualNo,
    scheduleAmount: scheduleAmount, buildScheduleVouchers: buildScheduleVouchers, buildVatClearingVouchers: buildVatClearingVouchers, buildYearCloseVouchers: buildYearCloseVouchers,
    flatten: flatten, generalLedger: generalLedger, trialBalance: trialBalance, incomeStatement: incomeStatement, monthlyPnl: monthlyPnl,
    balanceSheet: balanceSheet, vatReport: vatReport, validate: validate, cardAging: cardAging,
    assembleBooks: assembleBooks, lockSnapshot: lockSnapshot, normalizePolicy: normalizePolicy, voucherSignature: voucherSignature,
    SOURCE_SPECS: SOURCE_SPECS, SOURCE_FAIL_TEXT: SOURCE_FAIL_TEXT, scanTable: scanTable, collectSources: collectSources, applyCollectResult: applyCollectResult,
    snapshotCovers: snapshotCovers, requiredSourceRange: requiredSourceRange, closeReadiness: closeReadiness, attemptLock: attemptLock, attemptYearClose: attemptYearClose,
    toMinisetRows: toMinisetRows, toTsv: toTsv, toCsv: toCsv, parseMinisetRows: parseMinisetRows, parseTsv: parseTsv, parseChartRows: parseChartRows, fmt: fmt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.BongplayAccounting = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

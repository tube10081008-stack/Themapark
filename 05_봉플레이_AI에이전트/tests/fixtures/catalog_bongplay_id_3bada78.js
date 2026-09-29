// fixture: 01_봉플레이_운영시스템/assets/bongplay-id.js @ 3bada78 의 PRODUCT_CATALOG~PRODUCTS 호환 블록 원문.
// 실제 파일이 바뀌어도 이 파일은 바꾸지 않는다 — 변형·회귀 테스트의 고정 기준.
  const PRODUCT_CATALOG = [
    // 1. 이용권 (입장권 계열 — 할인 대상)
    { id: 'tkt_allday',        name: '종합이용권 (기본+짚코스터 1회)', short: '종합권',   category: 'ticket', list_price: 21000, customer: 'child',  discountable: true,  headcount: 1, coaster: true, sort: 10 },
    { id: 'tkt_basic',         name: '기본이용권 (실내+네트챌린지 2시간)', short: '기본권', category: 'ticket', list_price: 15000, customer: 'child',  discountable: true,  headcount: 1, sort: 20 },
    { id: 'tkt_morning',       name: '조조 오전권 (종합, 12시 이전 입장)', short: '조조권', category: 'ticket', list_price: 18000, customer: 'child',  discountable: true,  headcount: 1, coaster: true, time_window: 'morning', sort: 30 },
    { id: 'tkt_guardian',      name: '보호자 입장권 (카페 음료 포함)',  short: '보호자',   category: 'ticket', list_price: 5000,  customer: 'adult',  discountable: true,  headcount: 1, sort: 40 },
    { id: 'tkt_infant_free',   name: '영유아 무료 (36개월 미만)',      short: '영유아',   category: 'ticket', list_price: 0,     customer: 'infant', discountable: false, headcount: 1, sort: 50 },
    { id: 'tkt_teacher_free',  name: '단체 인솔교사 무료',             short: '인솔교사', category: 'ticket', list_price: 0,     customer: 'adult',  discountable: false, headcount: 1, sort: 60 },
    // 2. 놀이시설 단품 / 추가권 (정액 — 할인 비대상)
    { id: 'ride_coaster_single', name: '짚코스터 1회 탑승권 (단품)',   short: '짚1회',   category: 'addon_attraction', list_price: 7000, discountable: false, coaster: true, sort: 70 },
    { id: 'addon_coaster_extra', name: '짚코스터 추가 탑승권',         short: '짚추가',   category: 'addon_attraction', list_price: 5000, discountable: false, coaster: true, sort: 80 },
    { id: 'addon_net_challenge', name: '네트 어드벤처 추가권',                            category: 'addon_attraction', list_price: 5000, discountable: false, sort: 90 },
    { id: 'addon_sled_slope',    name: '사계절 썰매 5회권',                               category: 'addon_attraction', list_price: 3000, discountable: false, sort: 100 },
    // 3. 식음료 (F&B)
    { id: 'fnb_apple_juice',   name: '봉화 사과 착즙주스',    category: 'fnb', list_price: 4000, discountable: false, sort: 110 },
    { id: 'fnb_americano',     name: '아메리카노 (핫/아이스)', category: 'fnb', list_price: 3500, discountable: false, sort: 120 },
    { id: 'fnb_cafe_latte',    name: '카페 라떼',             category: 'fnb', list_price: 4000, discountable: false, sort: 130 },
    { id: 'fnb_kids_cookie',   name: '유기농 동물쿠키',        category: 'fnb', list_price: 2500, discountable: false, sort: 140 },
    { id: 'fnb_mineral_water', name: '생수 (500ml)',          category: 'fnb', list_price: 1000, discountable: false, sort: 150 },
    // 4. 안전/굿즈 (Merchandise)
    { id: 'md_safety_socks',   name: '트램펄린 논슬립 양말',   category: 'merchandise', list_price: 2500, discountable: false, sort: 160 },
    { id: 'md_forest_cape',    name: '봉플레이 방수 케이프',   category: 'merchandise', list_price: 12000, discountable: false, sort: 170 }
  ];

  // POS 탭 정의 (탭 키 = 상품 category 값과 반드시 일치시킬 것)
  const POS_CATEGORIES = [
    { key: 'all',              label: '전체 품목' },
    { key: 'ticket',           label: '🎫 이용권' },
    { key: 'addon_attraction', label: '🎢 체험 / 짚코스터' },
    { key: 'fnb',              label: '☕ F&B / 카페' },
    { key: 'merchandise',      label: '🧦 굿즈 / 용품' }
  ];

  /* 결제수단 정의 (SSOT)
     ------------------------------------------------------------
     · bucket : 마감 정산에서 묶이는 계정 구분
       - cash        : 금고 현금 실사 대상
       - local_pay   : 지류 봉화사랑상품권 (실물 금고 보관 → 농협/군청 제출 정산)
       - youth_voucher: 봉화 청소년 바우처 (지자체 정산 청구 대상)
       - card        : 카드·간편결제 (단말기 매출 대사)
     · 모든 화면에서 이 목록으로 버튼을 만들고, 복합(분할) 결제를 허용한다.
  */
  const PAYMENT_METHODS = [
    { id: 'card',          label: '신용/체크카드',      short: '카드',     icon: '💳', bucket: 'card',          needs_approval: true,  color: 'sky' },
    { id: 'cash',          label: '현금',               short: '현금',     icon: '💵', bucket: 'cash',          needs_approval: false, color: 'emerald' },
    { id: 'local_pay',     label: '봉화사랑상품권(지류)', short: '상품권',  icon: '🎫', bucket: 'local_pay',     needs_approval: false, color: 'violet' },
    { id: 'youth_voucher', label: '봉화 청소년 바우처',  short: '청소년바우처', icon: '🧒', bucket: 'youth_voucher', needs_approval: false, color: 'amber' },
    { id: 'mobile_pay',    label: '간편결제(카카오/네이버)', short: '간편결제', icon: '📱', bucket: 'card',       needs_approval: true,  color: 'slate' }
  ];

  function getPaymentMethods() { return PAYMENT_METHODS.slice(); }
  function getPaymentMethod(id) { return PAYMENT_METHODS.find(function (m) { return m.id === id; }) || null; }
  function getPaymentBucket(id) {
    const m = getPaymentMethod(id);
    return m ? m.bucket : 'card';   // 미등록 수단은 보수적으로 카드 계정에 귀속
  }

  // 배분표 {method: amount} → 결제 건 배열 + 검증
  function buildPayments(alloc, total) {
    const payments = Object.keys(alloc || {})
      .map(function (id) { return { method: id, amount: Math.round(Number(alloc[id]) || 0) }; })
      .filter(function (p) { return p.amount > 0; });
    const sum = payments.reduce(function (s, p) { return s + p.amount; }, 0);
    return {
      payments: payments,
      sum: sum,
      remain: Math.round(Number(total) || 0) - sum,
      valid: payments.length > 0 && sum === Math.round(Number(total) || 0)
    };
  }

  // 할인 규칙: 중복 적용하지 않고 가장 유리한 1건만 적용 (입장권 계열에만)
  const DISCOUNT_RULES = [
    { id: 'group20',  label: '20인 이상 단체 20% 할인', rate: 0.20 },
    { id: 'resident', label: '봉화 관내 주민 20% 감면', rate: 0.20 }
  ];
  const GROUP_MIN_HEADCOUNT = 20;

  // 하위 호환: 기존 코드가 PRODUCTS[product_id] 로 조회 (createOrder 등)
  const PRODUCTS = {};
  PRODUCT_CATALOG.forEach(function (p) {
    p.price = p.list_price;          // 화면에서 prod.price 를 쓰는 곳 호환
    p.category_label = (POS_CATEGORIES.find(function (c) { return c.key === p.category; }) || {}).label || p.category;
    PRODUCTS[p.id] = p;
  });

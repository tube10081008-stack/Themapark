/* ============================================================
   봉플레이 운영시스템 — 11대 공통 ID 표준 & AI 인과 데이터 파이프라인
   ------------------------------------------------------------
   설계 원칙:
   1. 데이터 침묵(Silo) 제거: visit_id를 마스터 스파인으로 하여
      [유입(Campaign)] -> [가구/이용자(Household/Visitor)] -> [발권(Ticket)]
      -> [시설이용(Facility/Asset)] -> [운영/대기(Staff/Ops)] -> [결과(매출/사고/민원)]
      전체 라이프사이클을 1:1로 관통한다.
   2. 개인정보 보호와 AI 학습의 양립: 휴대폰번호를 직접 평문 보관하지 않고
      단방향 솔트 해시(Salted Hash)로 변환하여 익명 household_id 생성.
   3. 오프라인 우선: 클라우드 접속 여부와 무관하게 로컬에서 즉시 발급.
   ============================================================ */

(function (global) {
  'use strict';

  const SITE_ID = 'bongplay_bonghwa';
  const SALT = 'bongplay_causal_salt_2026_';

  /* ---------- 1. 초고속 결정론적 단방향 해시 (FNV-1a 32bit -> Hex) ---------- */
  function fnv1a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizePhone(phone) {
    return String(phone || '').replace(/[^0-9]/g, '');
  }

  function getLocalYmdCompact(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return String(y) + m + day;
  }

  /* ---------- 2. 11대 공통 ID 생성기 ---------- */
  function generateHouseholdId(phone) {
    const clean = normalizePhone(phone);
    if (!clean) return 'hh_anon_' + Math.random().toString(36).slice(2, 8);
    return 'hh_' + fnv1a(SALT + clean);
  }

  function generateVisitId(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 8);
    return `vst_${ymd}_${rand}`;
  }

  function generateVisitorId(householdId, index, childName) {
    const raw = `${householdId}_${index}_${childName || ''}`;
    return 'vis_' + fnv1a(raw).slice(0, 8);
  }

  function generateBookingId(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 6);
    return `bkg_${ymd}_${rand}`;
  }

  function generateOrderId(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 7);
    return `ord_${ymd}_${rand}`;
  }

  function generateTicketId(visitId, index) {
    const cleanVisit = (visitId || '').replace(/^vst_/, '');
    const seq = String(index || 1).padStart(2, '0');
    return `tkt_${cleanVisit}_${seq}`;
  }

  function detectCampaignId() {
    try {
      const p = new URLSearchParams(window.location.search);
      const utm = p.get('utm_campaign') || p.get('campaign_id') || p.get('channel') || p.get('ref');
      if (utm) return 'cmp_' + utm.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    } catch (e) {}
    return 'cmp_walkin';
  }

  /* ---------- 3. 표준 시설/장비/직원 마스터 사전 ---------- */
  const FACILITIES = {
    outdoor_coaster:   { id: 'outdoor_coaster',   name: '실버 짚코스터 (포레스트 어드벤처)', space: 'outdoor', capHr: 18 },
    outdoor_net:       { id: 'outdoor_net',       name: '센트럴 어드벤처 네트',         space: 'outdoor', capHr: 45 },
    outdoor_deck:      { id: 'outdoor_deck',      name: '스카이워크 전망 데크',         space: 'outdoor', capHr: 60 },
    indoor_trampoline: { id: 'indoor_trampoline', name: '실내 대형 트램펄린 아레나',     space: 'play_indoor', capHr: 40 },
    indoor_foampit:    { id: 'indoor_foampit',    name: '스카이블루 폼큐브 & 볼풀장',   space: 'play_indoor', capHr: 30 },
    indoor_junglegym:  { id: 'indoor_junglegym',  name: '복층 정글짐 & 옐로우 슬라이드', space: 'play_indoor', capHr: 35 },
    indoor_volcano:    { id: 'indoor_volcano',    name: '화산 클라이밍 마운드 & 스카이브릿지', space: 'play_indoor', capHr: 25 },
    indoor_ninja:      { id: 'indoor_ninja',      name: '닌자 어질리티 코스',           space: 'play_indoor', capHr: 20 },
    indoor_bouldering: { id: 'indoor_bouldering', name: '유아 안전 볼더링 & 소방설비',  space: 'play_indoor', capHr: 15 },
    indoor_cafe:       { id: 'indoor_cafe',       name: '포레스트 카페테리아 (휴게음식점)', space: 'admin_indoor', capHr: 50 },
    indoor_ticket:     { id: 'indoor_ticket',     name: '매표 & 키오스크 발권소',       space: 'admin_indoor', capHr: 80 },
    indoor_office:     { id: 'indoor_office',     name: '운영관리실 & 행정데스크',       space: 'admin_indoor', capHr: 10 },
    indoor_restroom:   { id: 'indoor_restroom',   name: '남녀 & 다목적 화장실 (정화조 10㎥)', space: 'admin_indoor', capHr: 60 }
  };

  const ASSETS = {
    outdoor_coaster: [
      { id: 'zip_trolley_01', name: '짚코스터 1호 트롤리' },
      { id: 'zip_trolley_02', name: '짚코스터 2호 트롤리' },
      { id: 'zip_trolley_03', name: '짚코스터 3호 트롤리' },
      { id: 'zip_harness_01', name: '어드벤처 하네스 A조 (소형)' },
      { id: 'zip_harness_02', name: '어드벤처 하네스 B조 (중형)' },
      { id: 'zip_wire_main',  name: '주 와이어 로프 및 앵커' },
      { id: 'zip_brake_main', name: '도착지 유압 마그네틱 브레이크' }
    ],
    outdoor_net: [
      { id: 'net_mesh_zone1', name: '중앙 넷 메쉬 바닥망' },
      { id: 'net_suspension', name: '외곽 현수 지지선 및 비너' }
    ],
    indoor_trampoline: [
      { id: 'tramp_bed_01',    name: '트램펄린 1번 베드' },
      { id: 'tramp_bed_02',    name: '트램펄린 2번 베드' },
      { id: 'tramp_spring_set',name: '외곽 완충 스프링 & 황동 커버' }
    ],
    indoor_foampit: [
      { id: 'foam_cubes_lot1', name: '스카이블루 고밀도 폼큐브 롯트' },
      { id: 'foam_guard_rim',  name: '안전 완충 가드 테두리' }
    ],
    indoor_cafe: [
      { id: 'espresso_mach_01', name: '상업용 2그룹 에스프레소 머신' },
      { id: 'ice_dispenser_01', name: '제빙기 및 냉장 쇼케이스' }
    ],
    indoor_office: [
      { id: 'cctv_server_01', name: '통합 방범 CCTV 관제 서버' },
      { id: 'pos_terminal_01', name: '매표 POS 메인 단말기' }
    ],
    indoor_restroom: [
      { id: 'septic_tank_50', name: '50인용 오수정화조(10㎥) 펌프' }
    ]
  };

  /* 직원 사전: 기준정보(bongplay-site.js)의 인력 명단에서 생성합니다.
     기준정보가 없으면(단독 로드) 최소한의 익명 항목만 둡니다. */
  const STAFF = (function () {
    const map = {};
    const list = (global.BongplaySite && global.BongplaySite.staff) ? global.BongplaySite.staff() : [];
    list.forEach(function (s) {
      map[s.id] = { id: s.id, name: (s.name + ' ' + (s.title || '')).trim(), role: s.role || '' };
    });
    // 외부 협력 주체 (직원 명단과 별개)
    const county = (global.BongplaySite && global.BongplaySite.partner) ? global.BongplaySite.partner('county') : null;
    if (county) {
      map.stf_county = { id: 'stf_county', name: county.contact || county.name, role: county.name };
    }
    map.stf_barista = { id: 'stf_barista', name: '카페 바리스타', role: '식음료 제조 및 F&B 운영' };
    map.staff_etc = { id: 'staff_etc', name: '기타 근무자', role: '' };
    return map;
  })();

  // 기준정보 기반 기본 담당자 (표시용 문자열)
  function siteStaffLabel(kind) {
    if (!global.BongplaySite) return '';
    const s = kind === 'inspector' ? BongplaySite.defaultInspector() : BongplaySite.defaultManager();
    return s ? (s.name + ' ' + (s.title || '')).trim() : '';
  }

  /* ---------- 3-1. 표준 상품 및 서비스 카탈로그 (P0-1 Item-level Master) ---------- */
  /* 판매 상품 카탈로그 (SSOT) — 2026 공식 요금표
     ------------------------------------------------------------
     매표 데스크 결제 모달, 운영 POS, 마감 정산이 모두 이 한 벌만 사용합니다.
     (이전에는 POS용 PRODUCTS / MASTER_PRODUCTS / 내부 목록이 각각 다른 가격을 갖고 있었음)

     · 동절기 실내전용 요금제(어린이 12,000원 등)는 2026 개장 시즌에는 운영하지 않습니다.
       (2026-09-20 대표 결정: 11월 개장을 할인 요금으로 시작하지 않음)
     · 야외 시설(짚코스터·네트)의 기상·결빙 중단은 요금제가 아니라
       안전 인터록(getCoasterWeatherLock)이 판단합니다.
     · 할인은 정률 규칙으로만 표현하고 중복 적용하지 않습니다. (아래 DISCOUNT_RULES)
  */
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

  /* ---------- 3-2. 기준정보 마스터 사전 (Section 7: Single Source of Truth, v2026.v1) ---------- */
  const MASTER_PRODUCTS = {
    PROD_CHILD_BASIC_STD: {
      product_id: 'PROD_CHILD_BASIC_STD',
      product_name: '어린이 기본이용권 (2시간)',
      product_category: 'ticket_child',
      price: 15000,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'child',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '놀이동(연면적 924㎡ / 실내 놀이공간 657.8㎡) + 야외 네트어드벤처 2시간 정규 고시가'
    },
    PROD_CHILD_BASIC_PROMO: {
      product_id: 'PROD_CHILD_BASIC_PROMO',
      product_name: '어린이 기본이용권 (오픈/평일 프로모션)',
      product_category: 'ticket_child',
      price: 14000,
      effective_from: '2026-01-01',
      effective_to: '2026-09-29',
      is_active: false,
      deprecated: true,
      customer_type: 'child',
      season_type: 'regular',
      weekday_type: 'weekday',
      discount_rule_id: 'promo_open_1000',
      version: '2026.v1',
      description: '평일 오픈 기념 1,000원 할인 프로모션가 (2026-09-29 대표 결정으로 폐지, 과거 정산 호환 보존)'
    },
    PROD_CHILD_ALL_STD: {
      product_id: 'PROD_CHILD_ALL_STD',
      product_name: '어린이 종합이용권 (실내+네트+짚코스터 1회)',
      product_category: 'ticket_child',
      price: 21000,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'child',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '전 시설 및 짚코스터 1회 포함 올인원 이용권'
    },
    PROD_ADULT_STD: {
      product_id: 'PROD_ADULT_STD',
      product_name: '보호자 입장권 (음료 1잔 포함)',
      product_category: 'ticket_adult',
      price: 5000,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'adult',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '보호자 입장 및 아메리카노/사과주스 교환권'
    },
    PROD_GROUP_ALL: {
      product_id: 'PROD_GROUP_ALL',
      product_name: '단체 종합이용권 (20인 이상, 20% 할인)',
      product_category: 'ticket_group',
      price: 16800,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'group',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'group_20pct',
      version: '2026.v1',
      description: '20인 이상 유치원/초등 단체 종합이용권 (정가 21,000원에서 20% 할인, BEP 초과 마진 확보)'
    },
    PROD_GROUP_BASIC: {
      product_id: 'PROD_GROUP_BASIC',
      product_name: '단체 기본이용권 (20인 이상)',
      product_category: 'ticket_group',
      price: 10909,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'group',
      season_type: 'regular',
      weekday_type: 'weekday',
      discount_rule_id: 'group_basic_b2b',
      version: '2026.v1',
      description: '교육기관 평일 대규모 단체 기본이용권'
    },
    PROD_GROUP_VOUCHER: {
      product_id: 'PROD_GROUP_VOUCHER',
      product_name: '지자체 바우처 단체 지원권',
      product_category: 'ticket_group',
      price: 7000,
      effective_from: '2026-01-01',
      effective_to: '2026-09-29',
      is_active: false,
      deprecated: true,
      customer_type: 'voucher',
      season_type: 'regular',
      weekday_type: 'weekday',
      discount_rule_id: 'bonghwa_voucher',
      version: '2026.v1',
      description: '봉화군 및 인근 지자체 연계 보조금/바우처 지원 단체권 (2026-09-29 대표 결정으로 폐지, 과거 정산 호환 보존)'
    },
    PROD_ADDON_COASTER: {
      product_id: 'PROD_ADDON_COASTER',
      product_name: '실버 짚코스터 1회 탑승권',
      product_category: 'addon_attraction',
      price: 5000,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'all',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '기본권 소지자 짚코스터 개별 추가 이용'
    },
    PROD_FNB_APPLEJUICE: {
      product_id: 'PROD_FNB_APPLEJUICE',
      product_name: '봉화 명품 사과 착즙주스 (100% 원액)',
      product_category: 'fnb',
      price: 4000,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'all',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '봉화 특산물 연계 시그니처 어린이 건강음료'
    },
    PROD_FNB_AMERICANO: {
      product_id: 'PROD_FNB_AMERICANO',
      product_name: '포레스트 블렌드 아메리카노',
      product_category: 'fnb',
      price: 3500,
      effective_from: '2026-01-01',
      effective_to: null,
      customer_type: 'all',
      season_type: 'regular',
      weekday_type: 'all',
      discount_rule_id: 'none',
      version: '2026.v1',
      description: '스페셜티 프리미엄 로스팅 원두 커피'
    }
  };

  const MASTER_FACILITIES = {
    play_dome: {
      facility_id: 'play_dome',
      official_name: '놀이동 실내 어드벤처 & 트램펄린 (돔형)',
      facility_type: 'indoor_play',
      capacity: 80,
      building_area_sqm: 924.00,  // 놀이동 건물 연면적 (건축물대장)
      play_area_sqm: 657.785,     // 실내 놀이공간 면적 (시설명세 세부내역, 약 199평)
      area_sqm: 924.00,           // 호환성 유지용 (놀이동 건물 연면적)
      operating_start: '10:00',
      operating_end: '18:00',
      safety_class: 'statutory_inspection_passed',
      version: '2026.v1',
      specs: {
        equipment_count: 21,
        floors: 2,
        structure: '대형 막구조 및 경량철골 돔',
        fire_safety: '소화기 8기, 옥내소화전 2개소, 자동화재탐지설비',
        key_attractions: ['트램펄린 아레나', '폼큐브 볼풀', '복층 정글짐 슬라이드', '화산 마운드', '닌자 코스', '안전 볼더링']
      }
    },
    admin_pavilion: {
      facility_id: 'admin_pavilion',
      official_name: '사무동 본관 파빌리온 (제1종근린생활시설)',
      facility_type: 'admin_pavilion',
      capacity: 50,
      area_sqm: 297.99,
      operating_start: '09:00',
      operating_end: '18:30',
      safety_class: 'statutory_inspection_passed',
      version: '2026.v1',
      specs: {
        structure: '18.9m 정팔각 파빌리온 구조',
        sub_spaces: {
          cafe: { name: '포레스트 카페테리아 (휴게음식점)', area_sqm: 119.70 },
          office: { name: '운영관리실 및 행정 관제', area_sqm: 24.50 },
          ticket: { name: '매표소 및 무인 키오스크', area_sqm: 18.00 },
          gallery: { name: '상설 공예품 갤러리', area_sqm: 35.00 },
          restroom: { name: '남녀/장애인 화장실 및 수유실', area_sqm: 32.00, septic_tank: '50인용 10㎥' }
        }
      }
    },
    central_net: {
      facility_id: 'central_net',
      official_name: '센트럴 어드벤처 네트 타워',
      facility_type: 'outdoor_adventure',
      capacity: 40,
      area_sqm: 420.00,
      operating_start: '10:00',
      operating_end: '17:30',
      safety_class: 'statutory_inspection_passed',
      version: '2026.v1',
      specs: {
        layers: 3,
        material: '16mm 고강도 폴리에스터/와이어 네트',
        drop_safety: '하부 30cm 바크 완충재 포설'
      }
    },
    silver_coaster: {
      facility_id: 'silver_coaster',
      official_name: '실버 짚코스터 (포레스트 어드벤처)',
      facility_type: 'outdoor_adventure',
      capacity: 18,
      area_sqm: 850.00,
      operating_start: '10:30',
      operating_end: '17:00',
      safety_class: 'statutory_inspection_passed',
      version: '2026.v1',
      specs: {
        rail_length_m: 280,
        trolley_count: 8,
        harness_count: 30,
        wind_limit_gust_ms: 12.0,
        rain_limit_mm: 5.0
      }
    },
    parking_lot: {
      facility_id: 'parking_lot',
      official_name: '봉뜨락 북측 공영 주차장',
      facility_type: 'parking',
      capacity: 42,
      area_sqm: 1450.00,
      operating_start: '08:30',
      operating_end: '19:00',
      safety_class: 'pass',
      version: '2026.v1',
      specs: {
        passenger_cars: 38,
        large_buses: 4,
        ev_chargers: 2
      }
    },
    welcome_plaza: {
      facility_id: 'welcome_plaza',
      official_name: '웰컴 게이트 및 사암 유록길 진입광장',
      facility_type: 'plaza',
      capacity: 120,
      area_sqm: 1280.00,
      operating_start: '09:00',
      operating_end: '18:30',
      safety_class: 'pass',
      version: '2026.v1',
      specs: {
        pavement: '천연 사암 블록 포장',
        features: ['야외 쉼터 벤치 6기', '종합 안내도 키오스크', '비상벨/CCTV']
      }
    }
  };

  // 사업 기준값(BEP·객단가 등)은 배포별 설정 파일(config.js)이 1순위,
  // 값이 없을 때만 아래 기본값을 사용합니다. (중복 정의로 화면마다 숫자가 달라지던 문제 방지)
  const CFG = (global.BONGPLAY_CONFIG || {});
  const cfgNum = (key, fallback) => (CFG[key] !== undefined && CFG[key] !== null && isFinite(Number(CFG[key]))) ? Number(CFG[key]) : fallback;
  const approvedBy = (global.BongplaySite && BongplaySite.defaultManager)
    ? (BongplaySite.defaultManager().name + ' 총괄') : '현장 총괄';

  const MASTER_TARGETS = {
    annual_bep: {
      target_id: 'annual_bep',
      target_type: 'annual_bep',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: cfgNum('ANNUAL_BEP_VISITORS', 19606),
      target_revenue: cfgNum('ANNUAL_BEP_REVENUE', 236000000),
      fixed_cost: cfgNum('ANNUAL_FIXED_COST', 228900000),
      variable_cost_per_person: cfgNum('VARIABLE_COST', 361),
      blended_price: cfgNum('BLENDED_PRICE', 12036),
      operating_days: 350,
      assumption_version: CFG.MASTER_VERSION || '2026.v1',
      approved_by: approvedBy,
      description: '연간 고정비 2.289억 원 회수를 위한 손익분기점(BEP) 연간 총 목표'
    },
    daily_baseline_bep: {
      target_id: 'daily_baseline_bep',
      target_type: 'daily_baseline_bep',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: Math.max(1, Math.round(cfgNum('DAILY_BASELINE_BEP', 660000) / Math.max(1, cfgNum('BLENDED_PRICE', 12036)))),
      target_revenue: cfgNum('DAILY_BASELINE_BEP', 660000),
      assumption_version: '2026.v1',
      approved_by: approvedBy,
      description: '연간 BEP의 350일 균등 배분 시 일일 기준 손익분기 목표'
    },
    weekday_target: {
      target_id: 'weekday_target',
      target_type: 'weekday',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: cfgNum('WEEKDAY_TARGET_VISITORS', 30),
      target_revenue: cfgNum('WEEKDAY_TARGET_REVENUE', 360000),
      assumption_version: '2026.v1',
      approved_by: approvedBy,
      description: '평일 유치 운영 목표 (어린이집/유치원 단체 및 지역 주민 중심)'
    },
    weekend_target: {
      target_id: 'weekend_target',
      target_type: 'weekend',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: cfgNum('WEEKEND_TARGET_VISITORS', 148),
      target_revenue: cfgNum('WEEKEND_TARGET_REVENUE', 1780000),
      assumption_version: '2026.v1',
      approved_by: approvedBy,
      description: '주말 가족 단위 방문객 집중 유치 목표 (영주/안동/봉화)'
    },
    festival_target: {
      target_id: 'festival_target',
      target_type: 'festival',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: 143,
      target_revenue: 1720000,
      assumption_version: '2026.v1',
      approved_by: approvedBy,
      description: '봉화 은어/송이 축제 및 성수기 특별 이벤트 유치 목표'
    }
  };

  /* ---------- 3-3. 11대 공간 관리 구역 (Section 8: Spatial Zones) ---------- */
  const SPATIAL_ZONES = [
    { id: 'parking',          name: '북측 주차장',           space: 'outdoor',      maxCap: 42,  targetDwell: 120 },
    { id: 'plaza',            name: '웰컴 게이트 진입광장',    space: 'outdoor',      maxCap: 120, targetDwell: 15 },
    { id: 'indoor_ticket',    name: '사무동 매표/키오스크',   space: 'admin_indoor', maxCap: 25,  targetDwell: 8 },
    { id: 'indoor_cafe',      name: '포레스트 카페테리아',    space: 'admin_indoor', maxCap: 50,  targetDwell: 45 },
    { id: 'indoor_counter',   name: '놀이동 검표 & 락커',     space: 'play_indoor',  maxCap: 30,  targetDwell: 10 },
    { id: 'indoor_trampoline',name: '트램펄린 바운스 아레나', space: 'play_indoor',  maxCap: 40,  targetDwell: 40 },
    { id: 'central_net',      name: '센트럴 어드벤처 네트',   space: 'outdoor',      maxCap: 40,  targetDwell: 45 },
    { id: 'coaster_queue',    name: '짚코스터 대기구역',      space: 'outdoor',      maxCap: 25,  targetDwell: 20 },
    { id: 'silver_coaster',   name: '짚코스터 출발대',       space: 'outdoor',      maxCap: 18,  targetDwell: 5 },
    { id: 'coaster_landing',  name: '짚코스터 도착/회수존',   space: 'outdoor',      maxCap: 15,  targetDwell: 5 },
    { id: 'indoor_firstaid',  name: '의무실 & 비상대피구',    space: 'play_indoor',  maxCap: 10,  targetDwell: 15 }
  ];

  const STORAGE_KEYS = {
    CONSENTS: 'bongplay_safety_consents',
    LEGACY_CONSENTS: 'bongtteurak_consents_v1',
    TICKETS: 'bongplay_ticket_ledger',
    ORDER_ITEMS: 'bongplay_order_items',
    ORDER_PAYMENTS: 'bongplay_order_payments',
    FACILITY_EVENTS: 'bongplay_facility_usage_events',
    TELEMETRY: 'bongplay_congestion_telemetry',
    ACTION_LOGS: 'bongplay_operator_action_logs',
    ASSET_MEASUREMENTS: 'bongplay_asset_measurements',
    EQUIPMENT_ASSETS: 'bongplay_equipment_assets',
    FACILITY_INTERVALS: 'bongplay_facility_intervals',
    INCIDENTS: 'bongplay_incident_logs',
    COMPLAINTS: 'bongplay_complaint_logs',
    CAMPAIGNS: 'bongplay_marketing_campaigns',
    SURVEYS: 'bongplay_customer_experience_surveys',
    STAFF_SHIFTS: 'bongplay_staff_shifts',
    STAFF_ASSIGNMENTS: 'bongplay_staff_assignment_events',
    STAFF_TASKS: 'bongplay_staff_task_logs',
    GROUP_BOOKINGS: 'bongtteurak_group_bookings_v1',
    WEATHER_TELEMETRY: 'bongplay_weather_environment_telemetry',
    MASTER_PRODUCTS: 'bongplay_master_products',
    MASTER_FACILITIES: 'bongplay_master_facilities',
    MASTER_TARGETS: 'bongplay_master_targets',
    SPATIAL_ZONE_TELEMETRY: 'bongplay_spatial_zone_telemetry',
    QUEUE_SNAPSHOTS: 'bongplay_queue_snapshots',
    SENSOR_READINGS: 'bongplay_sensor_readings',
    MAINTENANCE_LOGS: 'bongplay_asset_maintenance_logs',
    USAGE_COUNTERS: 'bongplay_asset_usage_counters'
  };

  /* Helper to check if household has visited before */
  function checkIsRepeatHousehold(householdId) {
    if (!householdId) return false;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem(STORAGE_KEYS.LEGACY_CONSENTS) || '[]';
      const list = JSON.parse(raw);
      return list.some(c => c.household_id === householdId);
    } catch (e) {
      return false;
    }
  }

  /* Helper to read/write consents */
  function getStoredConsents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem(STORAGE_KEYS.LEGACY_CONSENTS) || '[]';
      return JSON.parse(raw);
    } catch (e) { return []; }
  }

  function updateStoredConsent(visitId, updates) {
    const list = getStoredConsents();
    const idx = list.findIndex(c => c.visit_id === visitId || c.id === visitId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...updates };
      localStorage.setItem(STORAGE_KEYS.CONSENTS, JSON.stringify(list));
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('safety_consents', {
          id: list[idx].id || list[idx].visit_id,
          ...updates
        });
      }
      return list[idx];
    }
    return null;
  }

  /* ---------- 4. 방문 세션 (Visit Session) 통합 번들 생성 (P0-2) ---------- */
  function createVisitSession(params) {
    params = params || {};
    const now = new Date();
    const visitId = params.visit_id || generateVisitId(now);
    const householdId = params.household_id || generateHouseholdId(params.phone || params.guardianPhone);
    const bookingId = params.booking_id || (params.isBooking ? generateBookingId(now) : null);
    const campaignId = params.campaign_id || detectCampaignId();

    const children = Array.isArray(params.children) ? params.children : [];
    const visitorIds = children.map((k, idx) => generateVisitorId(householdId, idx, k.name));

    // 티켓 ID 프리 번들
    const adultCount = Number(params.adultCount || params.adult_count) || 1;
    const childCount = children.length;
    const totalCount = childCount + adultCount;
    const ticketIds = [];
    for (let i = 1; i <= totalCount; i++) {
      ticketIds.push(generateTicketId(visitId, i));
    }

    const firstOrRepeat = checkIsRepeatHousehold(householdId) ? 'repeat' : 'first';

    return {
      site_id: SITE_ID,
      visit_id: visitId,
      household_id: householdId,
      booking_id: bookingId,
      campaign_id: campaignId,
      arrival_at: now.toISOString(),
      ticket_issued_at: null,
      entry_at: null,
      exit_at: null,
      stay_duration_minutes: null,
      party_size: totalCount,
      child_count: childCount,
      adult_count: adultCount,
      residence_region: params.residence || '관외(영주/안동)',
      visit_type: bookingId ? 'group_booking' : 'walkin',
      first_or_repeat: firstOrRepeat,
      guardian_name: params.guardianName || params.guardian_name || '',
      guardian_phone: params.guardianPhone || params.phone || '',
      residence: params.residence || '일반',
      children: children,
      visitor_ids: visitorIds,
      ticket_ids: ticketIds,
      created_at: now.toISOString()
    };
  }

  /* ---------- 4-1. 세션 수명주기 전이 함수 (P0-2 Lifecycle Transitions) ---------- */
  function markVisitIssued(visitId, customTime) {
    const ts = customTime || new Date().toISOString();
    return updateStoredConsent(visitId, {
      ticket_issued_at: ts,
      isIssued: true,
      issue_status: 'issued'
    });
  }

  function markVisitEntry(visitId, customTime) {
    const ts = customTime || new Date().toISOString();
    return updateStoredConsent(visitId, {
      entry_at: ts,
      gate_status: 'entered'
    });
  }

  function markVisitExit(visitId, customTime) {
    const ts = customTime || new Date().toISOString();
    const list = getStoredConsents();
    const item = list.find(c => c.visit_id === visitId || c.id === visitId);
    let stayMinutes = null;
    if (item && item.entry_at) {
      const diffMs = new Date(ts).getTime() - new Date(item.entry_at).getTime();
      stayMinutes = Math.max(0, Math.round(diffMs / 60000));
    }
    return updateStoredConsent(visitId, {
      exit_at: ts,
      stay_duration_minutes: stayMinutes,
      gate_status: 'exited'
    });
  }

  /* ---------- 4-2. 주문 및 상품 항목 단위 등록 (P0-1 Order Items Ledger) ---------- */
  function createOrder(orderParams) {
    orderParams = orderParams || {};
    const now = new Date();
    const orderId = orderParams.order_id || generateOrderId(now);
    const visitId = orderParams.visit_id || null;
    const salesChannel = orderParams.sales_channel || 'pos_counter';
    const paymentMethod = orderParams.payment_method || 'card';
    const couponId = orderParams.coupon_id || null;
    const staffId = orderParams.staff_id || 'stf_jiyeon';

    const itemsInput = Array.isArray(orderParams.items) ? orderParams.items : [];
    const orderItems = [];

    itemsInput.forEach((item, idx) => {
      const prod = PRODUCTS[item.product_id] || {
        id: item.product_id || 'custom_item',
        name: item.product_name || '기타 상품',
        category: item.product_category || 'fnb',
        list_price: Number(item.list_price || item.price || 0)
      };

      const qty = Math.max(1, Number(item.quantity) || 1);
      const listPrice = Number(item.list_price || prod.list_price || 0);
      const discount = Number(item.discount_amount) || 0;
      const paid = Math.max(0, (listPrice * qty) - discount);

      const record = {
        id: `${orderId}_${idx + 1}`,
        item_id: `${orderId}_${idx + 1}`, // FINAL 스키마의 기본키(item_id)와 구 스키마의 id 를 모두 채움
        order_id: orderId,
        site_id: SITE_ID,
        visit_id: visitId,
        purchased_at: now.toISOString(),
        sales_channel: salesChannel,
        product_id: prod.id,
        product_name: prod.name,
        product_category: prod.category,
        quantity: qty,
        list_price: listPrice,
        discount_amount: discount,
        paid_amount: paid,
        payment_method: paymentMethod,
        approval_no: orderParams.approval_no || null,   // 외부 결제단말기(토스 등) 승인번호 — 마감 카드 대사용
        discount_rule: item.discount_rule || null,
        consent_id: orderParams.consent_id || null,
        coupon_id: couponId,
        staff_id: staffId,
        created_at: now.toISOString()
      };

      orderItems.push(record);
    });

    // 결제 수납 원장 (복합 결제 지원)
    //   params.payments = [{ method, amount, approval_no }]  (없으면 단일 결제수단 1건으로 기록)
    const totalPaid = orderItems.reduce((sum, it) => sum + it.paid_amount, 0);
    const paymentsInput = Array.isArray(orderParams.payments) && orderParams.payments.length > 0
      ? orderParams.payments
      : [{ method: paymentMethod, amount: totalPaid, approval_no: orderParams.approval_no || null }];

    const orderPayments = paymentsInput
      .filter(p => p && Number(p.amount) > 0)
      .map((p, idx) => ({
        id: `${orderId}_pay${idx + 1}`,
        order_id: orderId,
        site_id: SITE_ID,
        consent_id: orderParams.consent_id || null,
        visit_id: visitId,
        method: p.method,
        amount: Number(p.amount),
        approval_no: p.approval_no || null,
        paid_at: now.toISOString(),
        status: 'paid',
        staff_id: staffId
      }));

    // Save locally
    try {
      const existingRaw = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]';
      const list = JSON.parse(existingRaw);
      orderItems.forEach(rec => list.unshift(rec));
      localStorage.setItem(STORAGE_KEYS.ORDER_ITEMS, JSON.stringify(list));

      const payRaw = localStorage.getItem(STORAGE_KEYS.ORDER_PAYMENTS) || '[]';
      const payList = JSON.parse(payRaw);
      orderPayments.forEach(rec => payList.unshift(rec));
      localStorage.setItem(STORAGE_KEYS.ORDER_PAYMENTS, JSON.stringify(payList));

      // Sync each item to Supabase
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        orderItems.forEach(rec => {
          global.BongplaySync.upsert('order_items', rec);
        });
        orderPayments.forEach(rec => {
          global.BongplaySync.upsert('order_payments', rec);
        });
      }
    } catch (e) {
      console.error('Failed to save order items:', e);
    }

    return {
      order_id: orderId,
      visit_id: visitId,
      items: orderItems,
      payments: orderPayments,
      total_amount: orderItems.reduce((sum, it) => sum + it.paid_amount, 0),
      total_quantity: orderItems.reduce((sum, it) => sum + it.quantity, 0)
    };
  }

  /* ---------- 4-2-1. 일자별 실제 주문 원장 조회 (P0-1 Orders by Date) ---------- */
  function getOrdersByDate(dateStr) {
    if (!dateStr) return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]';
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return [];

      // purchased_at 은 UTC(ISO) 문자열이므로 앞 10자리를 자르면 한국 날짜와 어긋날 수 있음 → 현지 날짜로 변환
      const localYmd = (iso) => {
        const d = new Date(iso || '');
        if (isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      };
      // 같은 품목이 로컬·서버 양쪽에서 들어와도 한 번만 집계 (id 기준 중복 제거)
      // 발권취소된 건(status='cancelled')은 실적·마감 집계에서 제외
      // 서약서(safety_consents)가 존재하는 경우 현재 발권완료(is_issued: true) 상태인 건만 유효 주문으로 인정
      const consentMap = {};
      try {
        const cRaw = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem('bongtteurak_consents_v1');
        if (cRaw) {
          const cList = JSON.parse(cRaw);
          if (Array.isArray(cList)) {
            cList.forEach(c => { if (c && c.id) consentMap[c.id] = c; });
          }
        }
      } catch (e) {}

      // consent_id 별 최신 order_id 추적 (재발권 등으로 중복 주문이 생긴 경우 최신 주문만 유지)
      const consentLatestOrder = {};
      items.forEach(it => {
        if (it.consent_id && it.status !== 'cancelled') {
          const prev = consentLatestOrder[it.consent_id];
          const curTime = new Date(it.purchased_at || it.created_at || 0).getTime();
          if (!prev || curTime >= prev.time) {
            consentLatestOrder[it.consent_id] = { order_id: it.order_id, time: curTime };
          }
        }
      });

      const seen = {};
      const filtered = items.filter(it => {
        const key = it.id || it.item_id;
        if (key) {
          if (seen[key]) return false;
          seen[key] = true;
        }
        if (it.status === 'cancelled') return false;

        // 서약서 연계 주문인 경우: 서약서가 발권완료 상태여야 하고, 최신 order_id에 속해야 함
        if (it.consent_id) {
          const c = consentMap[it.consent_id];
          if (c && !(c.isIssued || c.is_issued)) return false; // 미발권/발권취소 서약서 주문 제외
          const latest = consentLatestOrder[it.consent_id];
          if (latest && latest.order_id && it.order_id && it.order_id !== latest.order_id) {
            return false; // 구버전 중복 주문 제외
          }
        }

        return localYmd(it.purchased_at || it.created_at) === dateStr;
      });

      const ordersMap = {};
      filtered.forEach(it => {
        const oid = it.order_id || it.id;
        if (!ordersMap[oid]) {
          ordersMap[oid] = {
            order_id: oid,
            purchased_at: it.purchased_at || it.created_at,
            payment_method: it.payment_method || 'card',
            final_amount: 0,
            sales_channel: it.sales_channel || 'pos_counter',
            items: []
          };
        }
        ordersMap[oid].final_amount += Number(it.paid_amount || 0);
        ordersMap[oid].items.push(it);
      });

      return Object.values(ordersMap);
    } catch (e) {
      console.warn('[BongplayID] getOrdersByDate error:', e);
      return [];
    }
  }

  /* ---------- 4-2-2. 결제 수납 원장 조회 / 발권취소 ---------- */
  // 일자별 결제수단 합계 (취소분 제외) — 마감 3원화 집계의 기준
  function getPaymentsByDate(dateStr) {
    if (!dateStr) return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ORDER_PAYMENTS) || '[]';
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      const localYmd = (iso) => {
        const d = new Date(iso || '');
        if (isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      };
      const seen = {};
      return list.filter(p => {
        if (p.id) {
          if (seen[p.id]) return false;
          seen[p.id] = true;
        }
        if (p.status === 'cancelled') return false;
        return localYmd(p.paid_at || p.created_at) === dateStr;
      });
    } catch (e) {
      console.warn('[BongplayID] getPaymentsByDate error:', e);
      return [];
    }
  }

  // 결제수단 계정별 합계 { cash, local_pay, youth_voucher, card, total } — 취소분 제외
  function getPaymentTotalsByDate(dateStr) {
    const totals = { cash: 0, local_pay: 0, youth_voucher: 0, card: 0, total: 0 };
    getPaymentsByDate(dateStr).forEach(p => {
      const amt = Number(p.amount || 0);
      totals.total += amt;
      const bucket = getPaymentBucket(p.method);
      totals[bucket] = (totals[bucket] || 0) + amt;
    });
    return totals;
  }

  // 발권취소: 원장을 삭제하지 않고 상태만 cancelled 로 전환 (법정 기록 보존 + 집계 자동 제외)
  //   대상: order_items(품목) · order_payments(수납) · ticket_ledger(발권)
  async function cancelOrdersByConsent(consentId, reason) {
    if (!consentId) return { ok: false, reason: 'no_consent_id' };
    const now = new Date().toISOString();
    const patchData = { status: 'cancelled', cancelled_at: now, cancel_reason: reason || '현장 발권취소' };
    const result = { order_items: 0, order_payments: 0, tickets: 0, order_ids: [] };

    const readList = (key) => {
      try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    };
    const saveList = (key, list) => {
      try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
    };

    // 1) 품목 원장
    const items = readList(STORAGE_KEYS.ORDER_ITEMS);
    for (const it of items) {
      if (it.consent_id === consentId && it.status !== 'cancelled') {
        Object.assign(it, patchData);
        result.order_items++;
        if (it.order_id && result.order_ids.indexOf(it.order_id) === -1) result.order_ids.push(it.order_id);
        if (global.BongplaySync) await global.BongplaySync.patch('order_items', it.id || it.item_id, patchData);
      }
    }
    saveList(STORAGE_KEYS.ORDER_ITEMS, items);

    // 2) 수납 원장
    const pays = readList(STORAGE_KEYS.ORDER_PAYMENTS);
    for (const p of pays) {
      const linked = p.consent_id === consentId || result.order_ids.indexOf(p.order_id) !== -1;
      if (linked && p.status !== 'cancelled') {
        Object.assign(p, patchData);
        result.order_payments++;
        if (global.BongplaySync) await global.BongplaySync.patch('order_payments', p.id, patchData);
      }
    }
    saveList(STORAGE_KEYS.ORDER_PAYMENTS, pays);

    // 3) 발권 원장 (ticket_ledger 는 status 컬럼이 active/cancelled)
    const tickets = readList(STORAGE_KEYS.TICKETS);
    for (const t of tickets) {
      const linked = t.consent_id === consentId || result.order_ids.indexOf(t.order_id) !== -1;
      if (linked && t.status !== 'cancelled') {
        t.status = 'cancelled';
        t.cancelled_at = now;
        result.tickets++;
        if (global.BongplaySync) {
          await global.BongplaySync.patch('ticket_ledger', t.ticket_id, { status: 'cancelled', cancelled_at: now }, 'ticket_id');
        }
      }
    }
    saveList(STORAGE_KEYS.TICKETS, tickets);

    // 4) 안전서약 원장 (safety_consents: 취소 시 게이트 무단입장 방지)
    const consents = readList(STORAGE_KEYS.CONSENTS);
    for (const c of consents) {
      if (c.id === consentId || (c.visit_id && result.order_ids.some(oid => oid.includes(c.visit_id)))) {
        c.status = 'cancelled';
        c.is_issued = false;
        c.isIssued = false;
        c.cancelled_at = now;
        c.cancel_reason = reason || '현장 발권취소';
        if (global.BongplaySync) {
          await global.BongplaySync.patch('safety_consents', c.id, {
            status: 'cancelled',
            is_issued: false,
            cancelled_at: now,
            cancel_reason: reason || '현장 발권취소'
          });
        }
      }
    }
    saveList(STORAGE_KEYS.CONSENTS, consents);

    return Object.assign({ ok: true }, result);
  }

  /* ---------- 4-3. 시설 이용 이벤트 로거 (P0-3 Facility Usage Events) ---------- */
  function recordFacilityEvent(params) {
    params = params || {};
    const now = new Date();
    const eventId = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const facilityId = params.facility_id || 'outdoor_coaster';

    const record = {
      id: eventId,
      event_id: eventId,
      site_id: SITE_ID,
      visit_id: params.visit_id || null,
      ticket_id: params.ticket_id || null,
      facility_id: facilityId,
      entered_at: params.entered_at || now.toISOString(),
      started_at: params.started_at || params.entered_at || now.toISOString(),
      completed_at: params.completed_at || now.toISOString(),
      exited_at: params.exited_at || now.toISOString(),
      result: params.result || 'completed', // completed, re_ride, cancelled_weather, height_weight_fail, customer_giveup
      stop_reason: params.stop_reason || null,
      operator_staff_id: params.operator_staff_id || 'stf_jusung',
      created_at: now.toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.FACILITY_EVENTS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      localStorage.setItem(STORAGE_KEYS.FACILITY_EVENTS, JSON.stringify(list));

      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('facility_usage_events', record);
      }
    } catch (e) {
      console.error('Failed to save facility usage event:', e);
    }

    return record;
  }

  /* ---------- 4-4. 대기열·혼잡도 시계열 텔레메트리 (P0-4 Queue Telemetry) ---------- */
  function recordCongestionTelemetry(params) {
    params = params || {};
    const now = new Date();
    const telemetryId = 'tel_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const facilityId = params.facility_id || 'outdoor_coaster';
    const queueCount = Number(params.queue_count) || 0;

    // Automatic estimation if not supplied
    let waitMin = Number(params.estimated_wait_minutes);
    if (isNaN(waitMin) || waitMin === null) {
      waitMin = facilityId === 'outdoor_coaster' ? Math.round(queueCount * 1.5) : Math.round(queueCount * 0.8);
    }

    let status = params.status;
    if (!status) {
      if (waitMin >= 25) status = 'congested';
      else if (waitMin >= 10) status = 'moderate';
      else status = 'smooth';
    }

    const capacity = Number(params.capacity) || (FACILITIES[facilityId]?.capHr ? Math.round(FACILITIES[facilityId].capHr / 3) : 20);

    const record = {
      id: telemetryId,
      telemetry_id: telemetryId,
      site_id: SITE_ID,
      facility_id: facilityId,
      measured_at: params.measured_at || now.toISOString(),
      queue_count: queueCount,
      estimated_wait_minutes: waitMin,
      current_occupancy: Number(params.current_occupancy) || Math.min(capacity, queueCount),
      capacity: capacity,
      throughput_last_15m: Number(params.throughput_last_15m) || 0,
      status: status,
      created_at: now.toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.TELEMETRY) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      if (list.length > 300) list.length = 300; // retain last 300 snapshots
      localStorage.setItem(STORAGE_KEYS.TELEMETRY, JSON.stringify(list));

      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('congestion_telemetry', record);
      }
    } catch (e) {
      console.error('Failed to save congestion telemetry:', e);
    }

    return record;
  }

  /* ---------- 4-5. 운영 결정 행동 로그 (P0-5 Operator Action Log) ---------- */
  function recordOperatorAction(params) {
    params = params || {};
    const now = new Date();
    const actionId = 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    const record = {
      id: actionId,
      action_id: actionId,
      site_id: SITE_ID,
      timestamp: params.timestamp || now.toISOString(),
      action_type: params.action_type || 'staff_dispatch', // staff_dispatch, facility_pause, facility_resume, group_routing, time_extension, discount_coupon, staff_reassign, flow_rerouting
      target_facility_id: params.target_facility_id || 'outdoor_coaster',
      previous_state: typeof params.previous_state === 'object' ? params.previous_state : { desc: params.previous_state },
      new_state: typeof params.new_state === 'object' ? params.new_state : { desc: params.new_state },
      reason_code: params.reason_code || 'manual_intervention',
      decided_by: params.decided_by || siteStaffLabel('inspector'),
      expected_effect: params.expected_effect || '대기시간 단축 및 안전 확보',
      created_at: now.toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ACTION_LOGS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      localStorage.setItem(STORAGE_KEYS.ACTION_LOGS, JSON.stringify(list));

      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('operator_action_logs', record);
      }
    } catch (e) {
      console.error('Failed to save operator action log:', e);
    }

    return record;
  }

  /* ---------- 4-6. 정량 측정값 원장 (P0-6 Asset Measurements) ---------- */
  function recordAssetMeasurement(params) {
    params = params || {};
    const now = new Date();
    const eventId = 'meas_' + now.toISOString().slice(0, 10).replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 7);

    const record = {
      id: eventId,
      inspection_event_id: eventId,
      site_id: SITE_ID,
      asset_id: params.asset_id || 'unknown_asset',
      inspection_item_id: params.inspection_item_id || 'general',
      metric_name: params.metric_name || 'value',
      measured_at: params.measured_at || now.toISOString(),
      measured_value: Number(params.measured_value) || 0,
      unit: params.unit || '',
      status: params.status || 'pass', // pass, warn, fail
      photo_url: params.photo_url || null,
      inspector_id: params.inspector_id || 'inspector_main',
      notes: params.notes || '',
      created_at: now.toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.ASSET_MEASUREMENTS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      localStorage.setItem(STORAGE_KEYS.ASSET_MEASUREMENTS, JSON.stringify(list));

      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('asset_measurements', record);
      }
    } catch (e) {
      console.error('Failed to save asset measurement:', e);
    }

    return record;
  }

  /* ---------- 4-7. 장비 개체 단위 관리 & AI 예지보전 (P0-7 Equipment Individual Registry) ----------
     ※ 아래 기본 목록은 구입일·사용횟수·불량이력이 임의로 채워진 '시연용 예시 데이터'입니다.
        운영 환경에서 실제 장비 대장과 섞이지 않도록, 기준정보(bongplay-site.js)의
        demo_data 플래그가 true 일 때만 생성합니다. (기본값: false)
        실제 장비는 장비 관리 화면에서 등록하십시오. */
  function isDemoDataEnabled() {
    try {
      if (global.BONGPLAY_SITE && typeof global.BONGPLAY_SITE.demo_data === 'boolean') {
        return global.BONGPLAY_SITE.demo_data;
      }
    } catch (e) {}
    return false;
  }

  function initDefaultEquipmentAssets() {
    try {
      const existing = localStorage.getItem(STORAGE_KEYS.EQUIPMENT_ASSETS);
      if (!isDemoDataEnabled()) {
        if (!existing) localStorage.setItem(STORAGE_KEYS.EQUIPMENT_ASSETS, '[]');
        return;
      }
      if (!existing || existing === '[]') {
        const list = [];
        // 12 전신 하네스
        for (let i = 1; i <= 12; i++) {
          const num = String(i).padStart(3, '0');
          list.push({
            asset_id: `HARNESS-${num}`,
            asset_name: i <= 8 ? `어린이 전신 하네스 #${i}` : `성인 안전 하네스 #${i}`,
            asset_type: i <= 8 ? 'harness_child' : 'harness_adult',
            facility_id: 'outdoor_coaster',
            purchased_at: '2025-05-10',
            first_used_at: '2025-06-01',
            usage_count: i === 3 ? 1420 : 650 + (i * 45),
            last_inspected_at: '2026-09-14',
            defect_count: i === 3 ? 2 : 0,
            repair_history: i === 3 ? [{ date: '2026-08-10', type: '웨빙 마모 점검', note: '경미한 보풀 정리' }] : [],
            status: i === 3 ? 'warn' : 'active',
            retired_at: null
          });
        }
        // 6 롤러 트롤리
        for (let i = 1; i <= 6; i++) {
          const num = String(i).padStart(3, '0');
          list.push({
            asset_id: `TROLLEY-${num}`,
            asset_name: `짚코스터 고속 롤러 트롤리 #${i}`,
            asset_type: 'trolley_coaster',
            facility_id: 'outdoor_coaster',
            purchased_at: '2025-04-15',
            first_used_at: '2025-05-01',
            usage_count: i === 3 ? 2850 : 1750 + (i * 110),
            last_inspected_at: '2026-09-15',
            defect_count: i === 3 ? 3 : 0,
            repair_history: i === 3 ? [{ date: '2026-09-02', type: '베어링 구리스 주입', note: '회전 소음 주의 1회' }] : [],
            status: i === 3 ? 'warn' : 'active',
            retired_at: null
          });
        }
        // 15 헬멧
        for (let i = 1; i <= 15; i++) {
          const num = String(i).padStart(3, '0');
          list.push({
            asset_id: `HELMET-${num}`,
            asset_name: i <= 10 ? `어린이 숲 헬멧 #${i}` : `성인 헬멧 #${i}`,
            asset_type: i <= 10 ? 'helmet_kids' : 'helmet_adult',
            facility_id: 'outdoor_coaster',
            purchased_at: '2025-05-10',
            first_used_at: '2025-06-01',
            usage_count: 480 + (i * 35),
            last_inspected_at: '2026-09-15',
            defect_count: 0,
            repair_history: [],
            status: 'active',
            retired_at: null
          });
        }
        // 24 오토락 카라비너
        for (let i = 1; i <= 24; i++) {
          const num = String(i).padStart(3, '0');
          list.push({
            asset_id: `CARABINER-${num}`,
            asset_name: `오토락 스틸 카라비너 30kN #${i}`,
            asset_type: 'carabiner_lock',
            facility_id: 'outdoor_coaster',
            purchased_at: '2025-05-10',
            first_used_at: '2025-06-01',
            usage_count: 820 + (i * 20),
            last_inspected_at: '2026-09-15',
            defect_count: 0,
            repair_history: [],
            status: 'active',
            retired_at: null
          });
        }
        localStorage.setItem(STORAGE_KEYS.EQUIPMENT_ASSETS, JSON.stringify(list));
      }
    } catch (e) {
      console.warn('Init default equipment error:', e);
    }
  }

  function normalizeEquipmentAsset(a) {
    if (!a) return a;
    let type = a.type;
    if (!type) {
      if (a.asset_id && a.asset_id.startsWith('HARNESS')) type = 'HARNESS';
      else if (a.asset_id && a.asset_id.startsWith('TROLLEY')) type = 'TROLLEY';
      else if (a.asset_id && a.asset_id.startsWith('HELMET')) type = 'HELMET';
      else if (a.asset_id && a.asset_id.startsWith('CARABINER')) type = 'CARABINER';
      else if (a.asset_type && a.asset_type.indexOf('harness') !== -1) type = 'HARNESS';
      else if (a.asset_type && a.asset_type.indexOf('trolley') !== -1) type = 'TROLLEY';
      else if (a.asset_type && a.asset_type.indexOf('helmet') !== -1) type = 'HELMET';
      else type = 'CARABINER';
    }
    const maxSafe = Number(a.max_safe_usage_count) || (
      type === 'TROLLEY' ? 3000 :
      type === 'HARNESS' ? 1500 :
      type === 'HELMET' ? 2000 : 5000
    );
    const usage = Number(a.cumulative_usage_count !== undefined ? a.cumulative_usage_count : (a.usage_count || 0));
    const name = a.name || a.asset_name || a.asset_id;

    a.type = type;
    a.asset_type = a.asset_type || (type.toLowerCase() + '_standard');
    a.asset_name = name;
    a.name = name;
    a.usage_count = usage;
    a.cumulative_usage_count = usage;
    a.max_safe_usage_count = maxSafe;
    // 과거 버전이 인코딩 깨진 문자열로 저장한 위치값을 자동 복구
    // (한글이 UTF-8 → CP949 로 잘못 해석돼 '?쇱쇅 吏싲씪…' 형태로 남아 있던 데이터)
    if (!a.location || /[쇱쇅吳싲튰]|�/.test(a.location)) {
      a.location = '야외 짚라인 어드벤처';
    }
    a.status = a.status || 'active';
    return a;
  }

  function getEquipmentAssets() {
    initDefaultEquipmentAssets();
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.EQUIPMENT_ASSETS) || '[]';
      const list = JSON.parse(raw);
      const normalized = list.map(normalizeEquipmentAsset);
      // 복구된 값을 저장해 두어 다음 조회부터는 정상 표시
      if (raw !== JSON.stringify(normalized)) {
        try { localStorage.setItem(STORAGE_KEYS.EQUIPMENT_ASSETS, JSON.stringify(normalized)); } catch (e) {}
      }
      return normalized;
    } catch (e) { return []; }
  }

  function saveEquipmentAssets(list) {
    try {
      localStorage.setItem(STORAGE_KEYS.EQUIPMENT_ASSETS, JSON.stringify(list));
    } catch (e) { console.warn('Error saving equipment assets:', e); }
  }

  function addEquipmentAsset(newAsset) {
    if (!newAsset || !newAsset.asset_id) {
      throw new Error('asset_id is required');
    }
    const list = getEquipmentAssets();
    const exists = list.some(a => a.asset_id.toUpperCase() === newAsset.asset_id.toUpperCase());
    if (exists) {
      throw new Error('already exists: ' + newAsset.asset_id);
    }

    const item = normalizeEquipmentAsset({
      asset_id: newAsset.asset_id.trim().toUpperCase(),
      asset_name: newAsset.asset_name || newAsset.name || newAsset.asset_id,
      name: newAsset.asset_name || newAsset.name || newAsset.asset_id,
      type: newAsset.type || 'HARNESS',
      asset_type: newAsset.asset_type || (newAsset.type ? newAsset.type.toLowerCase() + '_standard' : 'harness_standard'),
      facility_id: newAsset.facility_id || 'outdoor_coaster',
      purchased_at: newAsset.purchased_at || new Date().toISOString().slice(0, 10),
      first_used_at: newAsset.first_used_at || new Date().toISOString().slice(0, 10),
      usage_count: Number(newAsset.usage_count || 0),
      cumulative_usage_count: Number(newAsset.usage_count || 0),
      max_safe_usage_count: Number(newAsset.max_safe_usage_count || 1500),
      last_inspected_at: new Date().toISOString().slice(0, 10),
      defect_count: Number(newAsset.defect_count || 0),
      last_defect_note: newAsset.last_defect_note || null,
      repair_history: newAsset.repair_history || [],
      status: newAsset.status || 'active',
      location: newAsset.location || '야외 짚라인 어드벤처',
      retired_at: null
    });

    list.unshift(item);
    saveEquipmentAssets(list);
    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('equipment_assets', item);
    }
    return item;
  }

  function updateEquipmentAsset(assetId, updateFields) {
    const list = getEquipmentAssets();
    const idx = list.findIndex(a => a.asset_id === assetId);
    if (idx === -1) return null;

    Object.assign(list[idx], updateFields);
    normalizeEquipmentAsset(list[idx]);
    saveEquipmentAssets(list);
    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('equipment_assets', list[idx]);
    }
    return list[idx];
  }

  function deleteEquipmentAsset(assetId) {
    let list = getEquipmentAssets();
    const item = list.find(a => a.asset_id === assetId);
    if (!item) return false;

    list = list.filter(a => a.asset_id !== assetId);
    saveEquipmentAssets(list);
    return true;
  }

  function updateEquipmentUsage(assetId, deltaCount, newStatus, defectNote) {
    deltaCount = Number(deltaCount) || 0;
    const list = getEquipmentAssets();
    const item = list.find(a => a.asset_id === assetId);
    if (item) {
      item.usage_count = Math.max(0, (item.usage_count || 0) + deltaCount);
      item.cumulative_usage_count = item.usage_count;
      if (newStatus) item.status = newStatus;
      if (defectNote !== undefined) item.last_defect_note = defectNote;
      item.last_inspected_at = new Date().toISOString().slice(0, 10);
      saveEquipmentAssets(list);
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('equipment_assets', item);
      }
    }
    return item;
  }

  function incrementFacilityEquipmentUsage(facilityId, count) {
    count = Number(count) || 1;
    const list = getEquipmentAssets();
    let updated = 0;
    list.forEach(a => {
      if ((a.facility_id === facilityId || facilityId === 'silver_coaster') && a.status === 'active') {
        a.usage_count = (a.usage_count || 0) + count;
        updated++;
      }
    });
    if (updated > 0) saveEquipmentAssets(list);
    return updated;
  }

  function getPredictiveMaintenanceAlerts() {
    const list = getEquipmentAssets();
    const alerts = [];

    list.forEach(a => {
      // Trolley rule: > 2500 runs or defect >= 2
      if (a.asset_type === 'trolley_coaster') {
        if (a.usage_count >= 2500 || a.defect_count >= 2) {
          alerts.push({
            asset_id: a.asset_id,
            asset_name: a.asset_name,
            severity: a.usage_count >= 2800 ? 'danger' : 'warning',
            title: `선제 교체 권고 (누적 ${a.usage_count.toLocaleString()}회 주행)`,
            message: `${a.asset_id}는 누적 ${a.usage_count.toLocaleString()}회 사용되었으며, 최근 점검에서 소음/진동 주의가 발생했습니다. 선제 교체를 권장합니다.`,
            recommended_action: '롤러 베어링 세트 교체 및 주행 저항 테스트'
          });
        }
      }
      // Harness rule: > 1300 uses or defect >= 1
      if (a.asset_type && a.asset_type.startsWith('harness')) {
        if (a.usage_count >= 1300 || a.defect_count >= 1) {
          alerts.push({
            asset_id: a.asset_id,
            asset_name: a.asset_name,
            severity: 'warning',
            title: `웨빙 피로도 주의 (누적 ${a.usage_count.toLocaleString()}회)`,
            message: `${a.asset_id}는 권장 수명(1,500회)의 85%를 초과했습니다. 버클 및 봉제선 정밀 검사를 진행하세요.`,
            recommended_action: '웨빙 마모도 전수 육안검사 및 세척/소독'
          });
        }
      }
    });

    return alerts;
  }

  /* ---------- 4-8. 시설 가동·중단 시간 구간 (P0-8 Facility Operating Intervals) ---------- */
  function changeFacilityOperatingStatus(params) {
    params = params || {};
    const facilityId = params.facility_id || 'outdoor_coaster';
    const newStatus = params.status || 'OPEN';
    const now = new Date().toISOString();

    let intervals = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.FACILITY_INTERVALS) || '[]';
      intervals = JSON.parse(raw);
    } catch (e) { intervals = []; }

    // Close previous interval for this facility if still open
    const openInterval = intervals.slice().reverse().find(i => i.facility_id === facilityId && !i.ended_at);
    if (openInterval) {
      openInterval.ended_at = now;
      const startMs = new Date(openInterval.started_at).getTime();
      const endMs = new Date(now).getTime();
      openInterval.duration_minutes = Math.max(1, Math.round((endMs - startMs) / 60000));
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('facility_operating_intervals', openInterval);
      }
    }

    const intervalId = 'int_' + now.slice(0, 10).replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 7);
    const newInterval = {
      id: intervalId,
      interval_id: intervalId,
      site_id: SITE_ID,
      facility_id: facilityId,
      status: newStatus,
      started_at: now,
      ended_at: null,
      duration_minutes: null,
      reason_code: params.reason_code || 'routine_operation',
      weather_snapshot_id: params.weather_snapshot_id || null,
      approved_by: params.approved_by || '현장안전책임자',
      created_at: now
    };

    intervals.unshift(newInterval);
    try {
      localStorage.setItem(STORAGE_KEYS.FACILITY_INTERVALS, JSON.stringify(intervals));
    } catch (e) { console.warn('Interval save error:', e); }

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('facility_operating_intervals', newInterval);
    }

    return newInterval;
  }

  function getCurrentFacilityOperatingStatus(facilityId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.FACILITY_INTERVALS) || '[]';
      const intervals = JSON.parse(raw);
      const open = intervals.find(i => i.facility_id === facilityId && !i.ended_at);
      return open ? open.status : 'OPEN';
    } catch (e) { return 'OPEN'; }
  }

  function getFacilityOperatingMetrics(dateStr) {
    const today = dateStr || new Date().toISOString().slice(0, 10);
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.FACILITY_INTERVALS) || '[]';
      const intervals = JSON.parse(raw).filter(i => (i.started_at || '').slice(0, 10) === today);

      const PARK_OPEN_MINUTES = 510; // 09:30 ~ 18:00
      let weatherPauseMinutes = 0;
      let maintenancePauseMinutes = 0;
      let safetyPauseMinutes = 0;
      let openMinutes = 0;

      intervals.forEach(i => {
        const dur = i.duration_minutes || (i.started_at ? Math.max(1, Math.round((Date.now() - new Date(i.started_at).getTime()) / 60000)) : 0);
        if (i.status === 'OPEN') openMinutes += dur;
        else if (i.status === 'PAUSED_WEATHER') weatherPauseMinutes += dur;
        else if (i.status === 'PAUSED_MAINTENANCE') maintenancePauseMinutes += dur;
        else if (i.status === 'PAUSED_SAFETY') safetyPauseMinutes += dur;
      });

      const totalPauseMinutes = weatherPauseMinutes + maintenancePauseMinutes + safetyPauseMinutes;
      const uptimeRate = totalPauseMinutes === 0 ? 100.0 : Math.max(0, Number(((PARK_OPEN_MINUTES - totalPauseMinutes) / PARK_OPEN_MINUTES * 100).toFixed(1)));
      const estimatedLostRevenue = totalPauseMinutes * 3500;

      return {
        total_pause_minutes: totalPauseMinutes,
        weather_pause_minutes: weatherPauseMinutes,
        maintenance_pause_minutes: maintenancePauseMinutes,
        safety_pause_minutes: safetyPauseMinutes,
        uptime_rate: uptimeRate,
        estimated_lost_revenue: estimatedLostRevenue
      };
    } catch (e) {
      return { total_pause_minutes: 0, weather_pause_minutes: 0, maintenance_pause_minutes: 0, safety_pause_minutes: 0, uptime_rate: 100, estimated_lost_revenue: 0 };
    }
  }

  /* ---------- 4-4. P1-1: 마케팅 캠페인 단위 원장 (Marketing Campaigns & CAC) ---------- */
  const DEFAULT_CAMPAIGNS = [
    {
      campaign_id: 'CMP-MOM-01',
      campaign_name: '영주/안동 맘카페 입소문 체험단',
      channel: 'mom_cafe',
      started_at: '2026-08-01',
      ended_at: '2026-10-31',
      cost: 350000,
      target_region: '영주시, 안동시',
      target_segment: '5~9세 유아/초등 부모',
      coupon_code: 'MOMFREE',
      landing_source: 'cafe.naver.com/yeongjumom'
    },
    {
      campaign_id: 'CMP-BUS-01',
      campaign_name: '경북 북부 교육청 스쿨버스 임차료 지원',
      channel: 'school_board',
      started_at: '2026-09-01',
      ended_at: '2026-11-30',
      cost: 1200000,
      target_region: '봉화군, 영주시, 울진군, 안동시',
      target_segment: '초등학교 및 유치원·어린이집 단체',
      coupon_code: 'SCHBUS26',
      landing_source: 'gbe.kr/edu_notice'
    },
    {
      campaign_id: 'CMP-INSTA-01',
      campaign_name: '주말 숲속 짚라인 릴스 영상 광고',
      channel: 'meta_instagram',
      started_at: '2026-08-15',
      ended_at: '2026-09-30',
      cost: 500000,
      target_region: '대구광역시, 구미시, 안동시',
      target_segment: '20~40대 가족 나들이객',
      coupon_code: 'INSTA10',
      landing_source: 'instagram.com/reel/bongplay_zip'
    },
    {
      campaign_id: 'CMP-FEST-01',
      campaign_name: '봉화 은어·송이축제 행사장 연계 쿠폰',
      channel: 'local_festival',
      started_at: '2026-07-25',
      ended_at: '2026-10-15',
      cost: 200000,
      target_region: '봉화 체육공원 축제장 방문객',
      target_segment: '축제 방문 가족',
      coupon_code: 'FEST5000',
      landing_source: 'festival_paper_flyer'
    },
    {
      campaign_id: 'CMP-REVISIT-01',
      campaign_name: '재방문 고객 감사 20% 카톡 알림톡',
      channel: 'kakao_revisit',
      started_at: '2026-09-01',
      ended_at: '2026-12-31',
      cost: 60000,
      target_region: '기존 방문 고객 전체',
      target_segment: '최근 60일 내 방문 가구',
      coupon_code: 'RECOME20',
      landing_source: 'kakao_alimtalk'
    }
  ];

  function getMarketingCampaigns() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.CAMPAIGNS);
      if (!raw) {
        localStorage.setItem(STORAGE_KEYS.CAMPAIGNS, JSON.stringify(DEFAULT_CAMPAIGNS));
        return DEFAULT_CAMPAIGNS;
      }
      return JSON.parse(raw);
    } catch (e) {
      return DEFAULT_CAMPAIGNS;
    }
  }

  function saveMarketingCampaigns(campaigns) {
    try {
      localStorage.setItem(STORAGE_KEYS.CAMPAIGNS, JSON.stringify(campaigns));
    } catch (e) {
      console.warn('saveMarketingCampaigns error:', e);
    }
  }

  function recordMarketingCampaign(camp) {
    const list = getMarketingCampaigns();
    const idx = list.findIndex(c => c.campaign_id === camp.campaign_id);
    if (idx >= 0) {
      list[idx] = Object.assign({}, list[idx], camp, { updated_at: new Date().toISOString() });
    } else {
      list.push(Object.assign({}, camp, { created_at: new Date().toISOString() }));
    }
    saveMarketingCampaigns(list);
    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('marketing_campaigns', camp);
    }
    return camp;
  }

  function getCampaignAttribution(campaignId) {
    const campaigns = getMarketingCampaigns();
    const camp = campaigns.find(c => c.campaign_id === campaignId) || campaigns[0];
    if (!camp) return null;

    let consents = [];
    let orders = [];
    try {
      const rawC = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem(STORAGE_KEYS.LEGACY_CONSENTS);
      if (rawC) consents = JSON.parse(rawC);
      const rawO = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS);
      if (rawO) orders = JSON.parse(rawO);
    } catch (e) {}

    const matchedVisits = consents.filter(c => c.campaign_id === camp.campaign_id || (c.coupon_code && c.coupon_code === camp.coupon_code));
    const matchedVisitIds = new Set(matchedVisits.map(v => v.visit_id || v.id));
    const matchedOrders = orders.filter(o => matchedVisitIds.has(o.visit_id));
    const revenue = matchedOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
    const visitors = matchedVisits.length;
    const cac = visitors > 0 ? Math.round(camp.cost / visitors) : camp.cost;
    const avgBasket = visitors > 0 ? Math.round(revenue / visitors) : 0;

    return {
      campaign: camp,
      total_visitors: visitors,
      total_revenue: revenue,
      cac: cac,
      avg_basket: avgBasket,
      roi_pct: camp.cost > 0 ? Number(((revenue - camp.cost) / camp.cost * 100).toFixed(1)) : 0
    };
  }

  /* ---------- 4-5. P1-2: 단체예약 10단계 영업 퍼널 관리 (B2B Booking Sales Funnel) ---------- */
  const FUNNEL_STAGES = [
    { id: 'inquiry', label: '문의 접수', color: 'bg-slate-700 text-slate-200' },
    { id: 'consulted', label: '상담 완료', color: 'bg-blue-900/60 text-blue-300' },
    { id: 'quote_sent', label: '견적 발송', color: 'bg-indigo-900/60 text-indigo-300' },
    { id: 'tentative', label: '일정 가예약', color: 'bg-cyan-900/60 text-cyan-300' },
    { id: 'contract_confirmed', label: '계약 확정', color: 'bg-emerald-900/60 text-emerald-300' },
    { id: 'deposit_paid', label: '계약금 결제', color: 'bg-emerald-800 text-emerald-200' },
    { id: 'visit_completed', label: '방문 완료', color: 'bg-purple-900/60 text-purple-300' },
    { id: 'cancelled', label: '취소', color: 'bg-rose-900/60 text-rose-300' },
    { id: 'no_show', label: '노쇼', color: 'bg-rose-950 text-rose-400' },
    { id: 're_proposal', label: '재예약 제안', color: 'bg-amber-900/60 text-amber-300' }
  ];

  function updateBookingFunnel(bookingId, stageId, updates) {
    updates = updates || {};
    let bookings = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.GROUP_BOOKINGS);
      if (raw) bookings = JSON.parse(raw);
    } catch (e) {}

    const nowIso = new Date().toISOString();
    const idx = bookings.findIndex(b => (b.booking_id === bookingId || b.id === bookingId));
    if (idx === -1) return null;

    const b = bookings[idx];
    b.funnel_stage = stageId;
    const stageObj = FUNNEL_STAGES.find(s => s.id === stageId);
    b.status = stageObj ? stageObj.label : stageId;

    if (stageId === 'quote_sent' && !b.quote_sent_at) b.quote_sent_at = nowIso;
    if (stageId === 'contract_confirmed' && !b.confirmed_at) b.confirmed_at = nowIso;
    if (stageId === 'cancelled' && !b.cancelled_at) b.cancelled_at = nowIso;

    Object.assign(b, updates);
    b.updated_at = nowIso;

    try {
      localStorage.setItem(STORAGE_KEYS.GROUP_BOOKINGS, JSON.stringify(bookings));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('group_bookings', {
        id: b.id,
        booking_id: b.booking_id || b.id,
        funnel_stage: b.funnel_stage,
        status: b.status,
        quoted_amount: b.quoted_amount || 0,
        paid_amount: b.paid_amount || 0,
        sales_owner: b.sales_owner || siteStaffLabel('manager'),
        next_action_at: b.next_action_at || null,
        cancel_reason: b.cancel_reason || null,
        quote_sent_at: b.quote_sent_at || null,
        confirmed_at: b.confirmed_at || null,
        cancelled_at: b.cancelled_at || null
      });
    }

    return b;
  }

  /* ---------- 4-6. P1-3: 가족 단위 재방문 CRM 프로필 (Household CRM) ---------- */
  function getHouseholdCrmProfile(householdId) {
    if (!householdId) return null;
    let consents = [];
    let orders = [];
    try {
      const rawC = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem(STORAGE_KEYS.LEGACY_CONSENTS);
      if (rawC) consents = JSON.parse(rawC);
      const rawO = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS);
      if (rawO) orders = JSON.parse(rawO);
    } catch (e) {}

    const myVisits = consents.filter(c => c.household_id === householdId);
    if (!myVisits.length) return null;

    myVisits.sort((a, b) => new Date(a.created_at || a.createdDate || 0) - new Date(b.created_at || b.createdDate || 0));
    const firstVisit = myVisits[0];
    const lastVisit = myVisits[myVisits.length - 1];
    const visitIds = new Set(myVisits.map(v => v.visit_id || v.id));
    const myOrders = orders.filter(o => visitIds.has(o.visit_id));
    const totalSpend = myOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);

    const totalParty = myVisits.reduce((sum, v) => sum + (v.party_size || ((v.children ? v.children.length : 0) + 1)), 0);
    const avgParty = Number((totalParty / myVisits.length).toFixed(1));

    const totalStay = myVisits.reduce((sum, v) => sum + (v.stay_duration_minutes || 115), 0);
    const avgStay = Math.round(totalStay / myVisits.length);

    return {
      household_id: householdId,
      total_visits: myVisits.length,
      first_visited_at: firstVisit.created_at || firstVisit.createdDate || null,
      last_visited_at: lastVisit.created_at || lastVisit.createdDate || null,
      avg_family_size: avgParty,
      cumulative_spend: totalSpend,
      avg_stay_minutes: avgStay,
      consent_marketing: lastVisit.consent_marketing === true,
      visits: myVisits
    };
  }

  /* ---------- 4-7. P1-4: 10초 퇴장 설문 원장 (Customer Experience Surveys & NPS) ---------- */
  // 손님 폰(consent.html)·퇴장 태블릿(gate.html)·데모 시드가 모두 이 함수로 기록한다.
  // 응답하지 않은 항목은 null 로 둔다 (예전엔 추천 9점·대기 4점 등을 임의로 채워 NPS 가 부풀려졌음).
  function recordCustomerSurvey(params) {
    const toScore = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const nowIso = new Date().toISOString();
    const satisfaction = toScore(params.satisfaction_score != null ? params.satisfaction_score : params.satisfaction_rating);
    const recommendation = toScore(params.recommendation_score != null ? params.recommendation_score : params.nps_score);
    const notes = params.notes || params.comment || '';
    const survey = {
      id: 'SRV_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: 'bongplay_bonghwa',
      visit_id: params.visit_id || null,
      household_id: params.household_id || null,
      consent_id: params.consent_id || null,
      pass_code: params.pass_code || null,
      survey_channel: params.survey_channel || params.channel || null,   // exit_tablet / mobile
      submitted_at: nowIso,
      created_at: nowIso,
      satisfaction_score: satisfaction,
      recommendation_score: recommendation,
      wait_satisfaction: toScore(params.wait_satisfaction),
      favorite_facility: params.favorite_facility || params.preferred_facility || null,
      improvement_reason: params.improvement_reason || null,
      revisit_intent: params.revisit_intent || null,
      staff_friendly_score: toScore(params.staff_friendly_score),
      notes: notes,
      // 기본 스키마 컬럼(score/comment)에도 같은 값을 남겨 SQL 조회를 단순하게 한다
      score: satisfaction,
      comment: notes
    };

    let list = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SURVEYS);
      if (raw) list = JSON.parse(raw);
    } catch (e) {}

    list.unshift(survey);
    if (list.length > 500) list = list.slice(0, 500);

    try {
      localStorage.setItem(STORAGE_KEYS.SURVEYS, JSON.stringify(list));
    } catch (e) {
      console.warn('recordCustomerSurvey error:', e);
    }

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('customer_experience_surveys', survey);
    }

    return survey;
  }

  function getCustomerSurveys() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SURVEYS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function getNpsSummary() {
    const surveys = getCustomerSurveys();
    if (!surveys.length) {
      return { total: 0, nps: 0, avg_satisfaction: 0, avg_wait: 0, promoters_pct: 0, detractors_pct: 0 };
    }

    let promoters = 0;
    let passives = 0;
    let detractors = 0;
    let sumSat = 0, cntSat = 0;
    let sumWait = 0, cntWait = 0;

    surveys.forEach(s => {
      const sat = s.satisfaction_score != null ? s.satisfaction_score : s.score;
      // 추천 점수(0~10)가 없으면 5점 만족도로 환산: 5점=추천, 4점=중립, 3점 이하=비추천
      if (s.recommendation_score != null) {
        if (s.recommendation_score >= 9) promoters++;
        else if (s.recommendation_score >= 7) passives++;
        else detractors++;
      } else if (sat != null) {
        if (sat >= 5) promoters++;
        else if (sat === 4) passives++;
        else detractors++;
      }
      if (sat != null) { sumSat += sat; cntSat++; }
      if (s.wait_satisfaction != null) { sumWait += s.wait_satisfaction; cntWait++; }
    });

    const total = surveys.length;
    const rated = promoters + passives + detractors;
    const pPct = rated ? (promoters / rated) * 100 : 0;
    const dPct = rated ? (detractors / rated) * 100 : 0;
    const nps = Math.round(pPct - dPct);
    const avgWait = cntWait ? Number((sumWait / cntWait).toFixed(1)) : 0;

    return {
      total: total,
      nps: nps,
      promoters_pct: Number(pPct.toFixed(1)),
      detractors_pct: Number(dPct.toFixed(1)),
      avg_satisfaction: cntSat ? Number((sumSat / cntSat).toFixed(1)) : 0,
      avg_wait: avgWait,
      avg_wait_satisfaction: avgWait
    };
  }

  /* ---------- 4-8. P1-5: 직원 근무 교대 및 실시간 구역 재배치 (Staff Shifts & Assignment Events) ---------- */

  // 근무 교대 기본표: 기준정보 인력 명단으로 당일 근무표를 만든다.
  // (예전에는 특정 날짜·이름이 박힌 예시 3건이 항상 생성되었음)
  function buildDefaultShifts() {
    const list = (global.BongplaySite && global.BongplaySite.staff) ? global.BongplaySite.staff() : [];
    if (!list.length) return [];
    const hours = (global.BongplaySite ? global.BongplaySite.get('hours') : {}) || {};
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return list.map(function (s, i) {
      return {
        shift_id: 'SHF-' + ymd + '-' + String(i + 1).padStart(2, '0'),
        staff_id: s.id,
        staff_name: s.name,
        role: s.role || '',
        assigned_zone: 'all_facilities',
        scheduled_start: hours.open || '10:00',
        scheduled_end: hours.close || '18:00',
        actual_check_in: null,
        actual_check_out: null,
        break_minutes: 60,
        status: 'scheduled'
      };
    });
  }

  function getStaffShifts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_SHIFTS);
      if (!raw) {
        const built = buildDefaultShifts();
        localStorage.setItem(STORAGE_KEYS.STAFF_SHIFTS, JSON.stringify(built));
        return built;
      }
      return JSON.parse(raw);
    } catch (e) {
      return buildDefaultShifts();
    }
  }

  function saveStaffShifts(shifts) {
    try {
      localStorage.setItem(STORAGE_KEYS.STAFF_SHIFTS, JSON.stringify(shifts));
    } catch (e) {}
  }

  function recordStaffAssignmentEvent(params) {
    const event = {
      id: 'ASG_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      staff_id: params.staff_id,
      from_zone: params.from_zone || 'indoor_office',
      to_zone: params.to_zone,
      started_at: params.started_at || new Date().toISOString(),
      ended_at: params.ended_at || null,
      reason: params.reason || '대기열 혼잡 해소 및 안전 보강',
      dispatched_by: params.dispatched_by || siteStaffLabel('manager')
    };

    // Update active shift zone
    const shifts = getStaffShifts();
    const sh = shifts.find(s => s.staff_id === params.staff_id);
    if (sh) {
      sh.assigned_zone = params.to_zone;
      saveStaffShifts(shifts);
    }

    let list = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_ASSIGNMENTS);
      if (raw) list = JSON.parse(raw);
    } catch (e) {}
    list.unshift(event);
    if (list.length > 200) list = list.slice(0, 200);

    try {
      localStorage.setItem(STORAGE_KEYS.STAFF_ASSIGNMENTS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('staff_assignment_events', event);
    }

    return event;
  }

  function getStaffAssignmentEvents() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_ASSIGNMENTS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /* ---------- 4-9. P1-6: 직원 업무 완료 소요시간 측정 원장 (Staff Task Duration Logs) ---------- */
  function recordStaffTaskLog(params) {
    const started = params.started_at || new Date(Date.now() - 15 * 60000).toISOString();
    const completed = params.completed_at || new Date().toISOString();
    let duration = params.duration_minutes;
    if (duration == null) {
      duration = Math.max(1, Math.round((new Date(completed).getTime() - new Date(started).getTime()) / 60000));
    }

    const taskLog = {
      id: 'TSK_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      task_type: params.task_type || 'safety_sanitization',
      facility_id: params.facility_id || 'outdoor_coaster',
      staff_id: params.staff_id || 'stf_park',
      started_at: started,
      completed_at: completed,
      duration_minutes: duration,
      result: params.result || 'pass',
      rework_required: params.rework_required === true,
      notes: params.notes || ''
    };

    let list = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_TASKS);
      if (raw) list = JSON.parse(raw);
    } catch (e) {}
    list.unshift(taskLog);
    if (list.length > 200) list = list.slice(0, 200);

    try {
      localStorage.setItem(STORAGE_KEYS.STAFF_TASKS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('staff_task_logs', taskLog);
    }

    return taskLog;
  }

  function getStaffTaskLogs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_TASKS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /* ---------- 4-6. 기상·환경 세밀 텔레메트리 파이프라인 (Section 6) ---------- */
  function recordWeatherTelemetry(data) {
    const d = data || {};
    const record = {
      id: 'wtr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      observed_at: d.observed_at || new Date().toISOString(),
      temperature: Number(d.temperature !== undefined ? d.temperature : 21.5),
      humidity: Math.round(Number(d.humidity !== undefined ? d.humidity : 55)),
      rainfall: Number(d.rainfall !== undefined ? d.rainfall : 0.0),
      // 풍속은 안전 인터록 입력값이므로 누락 시 기본값을 지어내지 않고 null(미확인 → 잠금)
      wind_speed: (d.wind_speed != null && d.wind_speed !== '' && isFinite(Number(d.wind_speed))) ? Number(d.wind_speed) : null,
      wind_gust: (d.wind_gust != null && d.wind_gust !== '' && isFinite(Number(d.wind_gust))) ? Number(d.wind_gust) : null,
      source: d.source || 'manual_anemometer',
      wind_direction: d.wind_direction || 'NW',
      visibility: Number(d.visibility !== undefined ? d.visibility : 15000),
      snow_depth: Number(d.snow_depth !== undefined ? d.snow_depth : 0.0),
      weather_warning: d.weather_warning || 'none',
      indoor_temperature: Number(d.indoor_temperature !== undefined ? d.indoor_temperature : 22.8),
      indoor_humidity: Math.round(Number(d.indoor_humidity !== undefined ? d.indoor_humidity : 48)),
      created_at: new Date().toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.WEATHER_TELEMETRY) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      if (list.length > 288) list.length = 288;
      localStorage.setItem(STORAGE_KEYS.WEATHER_TELEMETRY, JSON.stringify(list));
    } catch (e) {
      console.warn('Weather telemetry save error:', e);
    }

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('weather_environment_telemetry', record);
    }

    return record;
  }

  function getWeatherTelemetry(limit) {
    const lim = limit || 24;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.WEATHER_TELEMETRY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) return list.slice(0, lim);
      }
    } catch (e) {}

    // 실측 데이터가 아직 로컬에 없을 때 빈 배열 반환 (가짜 난수 생성 금지)
    return [];
  }

  // 기상 데이터 유효시간: Open-Meteo 현재값은 15분 간격 갱신 → 30분이 지나면 신뢰하지 않음
  // (수동 입력값도 동일 적용: API 장애 시 현장 풍속계 값을 30분마다 다시 입력해야 발권 유지)
  const WEATHER_MAX_AGE_MS = 30 * 60 * 1000;
  const WEATHER_POLL_MS = 10 * 60 * 1000;

  // 봉화 현장 Open-Meteo 기상 연동 (위도 36.893, 경도 128.732)
  //   · current_weather(구형 응답)에는 순간풍속(gust)이 없어 추정값을 쓰게 되므로,
  //     current=wind_gusts_10m 으로 순간최대풍속을 직접 받습니다.
  //   · 격자 기상모델 값입니다. 현장 풍속계 실측을 대체하지 않으며, 값이 없으면
  //     추정하지 않고 null 로 두어 인터록이 "미확인 = 잠금"으로 판단하게 합니다.
  async function fetchLiveWeather() {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=36.893&longitude=128.732' +
      '&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
      '&wind_speed_unit=ms&timezone=Asia%2FSeoul';
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('http_' + res.status);
      const data = await res.json();
      const cur = data.current || {};
      const num = (v) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10) / 10 : null;

      const windSpeed = num(cur.wind_speed_10m);
      const gust = num(cur.wind_gusts_10m);
      const code = Number(cur.weather_code || 0);
      const isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
      const hasWind = windSpeed !== null && gust !== null;

      const rec = {
        id: 'wtr_live_' + Date.now(),
        observed_at: new Date().toISOString(),
        model_time: cur.time || null,
        temperature: num(cur.temperature_2m),
        humidity: num(cur.relative_humidity_2m),
        rainfall: num(cur.precipitation),
        wind_speed: windSpeed,
        wind_gust: gust,
        wind_direction: cur.wind_direction_10m !== undefined ? cur.wind_direction_10m : null,
        weather_warning: !hasWind ? 'UNKNOWN_WEATHER'
          : ((gust >= 12.0 || windSpeed >= 12.0) ? 'strong_wind_watch' : (isRain ? 'rain_watch' : 'none')),
        source: 'open_meteo_bonghwa',
        status: hasWind ? 'LIVE' : 'UNKNOWN'
      };

      const existing = getWeatherTelemetry(29);
      existing.unshift(rec);
      localStorage.setItem(STORAGE_KEYS.WEATHER_TELEMETRY, JSON.stringify(existing));
      return rec;
    } catch (e) {
      console.warn('[BongplayID] Live weather fetch failed:', e);
      return null;
    }
  }

  // 페이지가 열려 있는 동안 10분마다 기상 갱신. onUpdate(rec) 로 화면 재렌더링.
  let weatherPollTimer = null;
  function startLiveWeatherPolling(onUpdate) {
    const tick = async () => {
      const rec = await fetchLiveWeather();
      if (typeof onUpdate === 'function') {
        try { onUpdate(rec); } catch (e) { console.warn('[BongplayID] weather onUpdate error:', e); }
      }
    };
    if (weatherPollTimer) clearInterval(weatherPollTimer);
    tick();
    weatherPollTimer = setInterval(tick, WEATHER_POLL_MS);
    return function stop() { clearInterval(weatherPollTimer); weatherPollTimer = null; };
  }

  function getLatestWeather() {
    // 과거 버전이 localStorage 에 남긴 가짜 시드값(wtr_seed_*)은 무시
    const list = getWeatherTelemetry(30).filter(w => !String(w.id || '').startsWith('wtr_seed_'));
    if (list.length > 0) {
      const latest = list[0];
      const diffMs = Date.now() - new Date(latest.observed_at || 0).getTime();
      if (diffMs >= 0 && diffMs < WEATHER_MAX_AGE_MS) {
        return latest;
      }
    }

    // 실측 데이터가 없거나 유효시간 초과 시 안전을 위해 'UNKNOWN' 상태 반환 (임의의 안전값 조작 금지)
    return {
      observed_at: new Date().toISOString(),
      temperature: null,
      wind_speed: null,
      wind_gust: null,
      rainfall: null,
      weather_warning: 'UNKNOWN_WEATHER',
      status: 'UNKNOWN'
    };
  }

  function evaluateCoasterWeatherIntervention(weather) {
    const w = weather || getLatestWeather();
    
    // 기상 정보 미확인(UNKNOWN) 상태: 안전 최우선 원칙에 따라 짚코스터 발권 잠금 및 수동 점검 요구
    // (== null 은 null 과 undefined 를 모두 잡습니다. 숫자가 아니면 "미확인"으로 간주)
    const isNum = (v) => v != null && v !== '' && isFinite(Number(v));
    if (w.status === 'UNKNOWN' || !isNum(w.wind_speed) || !isNum(w.wind_gust) || w.weather_warning === 'UNKNOWN_WEATHER') {
      return {
        canOperate: false,
        alertLevel: 'warning',
        reason: '기상 관측 데이터 미수신 (현장 풍속 수동 확인 필요)',
        suggestedAction: '현장 풍속계로 직접 계측 후 관제 화면에 수동 입력할 때까지 짚코스터 발권을 대기합니다.',
        actionStatus: 'PAUSED_MANUAL_CHECK'
      };
    }

    const gust = Number(w.wind_gust);
    const wind = Number(w.wind_speed);
    const rain = Number(w.rainfall || 0);
    const warning = String(w.weather_warning || 'none');

    if (gust >= 12.0 || wind >= 12.0) {
      return {
        canOperate: false,
        alertLevel: 'critical',
        reason: `순간최대풍속 ${gust} m/s · 평균풍속 ${wind} m/s (안전 임계치 12.0 m/s 이상)`,
        suggestedAction: '짚코스터 운행 즉시 일시중단(weather_pause) 및 대기열 안내',
        actionStatus: 'PAUSED_WEATHER'
      };
    }
    if (rain >= 5.0 || warning.indexOf('rain') !== -1) {
      return {
        canOperate: false,
        alertLevel: 'critical',
        reason: `강수량 ${rain} mm/hr (우천 안전 기준 5.0 mm 초과)`,
        suggestedAction: '야외 시설 전체 중단 및 실내 놀이동 전환 유도',
        actionStatus: 'PAUSED_WEATHER'
      };
    }
    if (gust >= 8.5) {
      return {
        canOperate: true,
        alertLevel: 'warning',
        reason: `돌풍 주의 (순간최대풍속 ${gust} m/s, 주의 구간 8.5~11.9 m/s)`,
        suggestedAction: '배차 간격 1.5배 연장 및 안전요원 추가 감시 배치',
        actionStatus: 'OPEN'
      };
    }
    return {
      canOperate: true,
      alertLevel: 'normal',
      reason: `기상 양호 (풍속 ${w.wind_speed} m/s, 돌풍 ${gust} m/s)`,
      suggestedAction: '정상 운행 유지',
      actionStatus: 'OPEN'
    };
  }

  // POS·발권 화면이 공통으로 쓰는 짚코스터 판매 잠금 판정 (단일 기준)
  //   locked=true 인 경우: 강풍·우천·데이터 미확인(30분 경과/미수신) 모두 포함 → 실패 시 잠금(fail-closed)
  function getCoasterWeatherLock() {
    const weather = getLatestWeather();
    const evaluation = evaluateCoasterWeatherIntervention(weather);
    return { locked: !evaluation.canOperate, reason: evaluation.reason, weather: weather, evaluation: evaluation };
  }

  /* ---------- 4-2-2. 매표 요금 산출 엔진 (BP-008) ----------
     한 곳에서만 금액을 계산합니다: 매표 데스크 결제 모달 · 운영 POS · 마감 집계 공통.
     · 할인은 입장권 계열(discountable:true)에만, 중복 없이 가장 유리한 1건만 적용
     · 계산 결과는 그대로 order_items(결제 원장)에 저장되는 형태로 반환
  */
  function getProductsList(opts) {
    opts = opts || {};
    let list = PRODUCT_CATALOG.slice();
    if (opts.category && opts.category !== 'all') {
      list = list.filter(function (p) { return p.category === opts.category; });
    }
    if (opts.excludeFree) {
      list = list.filter(function (p) { return Number(p.list_price) > 0; });
    }
    return list.sort(function (a, b) { return (a.sort || 999) - (b.sort || 999); });
  }

  function getPosCategories() {
    return POS_CATEGORIES.slice();
  }

  // 아동 나이(개월) 추정: birth('2023-05-01' 또는 '2023') 또는 age(년) 입력 모두 허용
  function monthsOldFromChild(child) {
    if (!child || typeof child === 'string') return null;
    if (child.birth) {
      const b = new Date(String(child.birth).length === 4 ? child.birth + '-01-01' : child.birth);
      if (!isNaN(b.getTime())) {
        const now = new Date();
        return (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
      }
    }
    if (child.age !== undefined && child.age !== null && child.age !== '') {
      const a = Number(child.age);
      if (isFinite(a)) return Math.round(a * 12);
    }
    return null;
  }

  function isInfant(child) {
    const m = monthsOldFromChild(child);
    return m !== null && m < 36;   // 36개월 미만 무료
  }

  function isResidentDiscount(residence) {
    const r = String(residence || '');
    return r.indexOf('군민') !== -1 || r.indexOf('관내') !== -1;
  }

  // cart: [{ product_id, quantity }], ctx: { residence, groupSize, forceRuleId }
  function computeCartPricing(cart, ctx) {
    ctx = ctx || {};
    const lines = (cart || [])
      .map(function (c) {
        const prod = PRODUCTS[c.product_id];
        const qty = Math.max(0, Number(c.quantity) || 0);
        if (!prod || qty === 0) return null;
        return { prod: prod, quantity: qty };
      })
      .filter(Boolean);

    // 인원수 = 입장권 계열 수량 합계 (무료 대상 포함)
    const headcount = lines.reduce(function (sum, l) {
      return sum + (l.prod.category === 'ticket' ? l.quantity * (l.prod.headcount || 1) : 0);
    }, 0);

    // 적용 가능한 할인 판정
    const candidates = [];
    if ((Number(ctx.groupSize) || headcount) >= GROUP_MIN_HEADCOUNT) {
      candidates.push(DISCOUNT_RULES.find(function (r) { return r.id === 'group20'; }));
    }
    if (isResidentDiscount(ctx.residence)) {
      candidates.push(DISCOUNT_RULES.find(function (r) { return r.id === 'resident'; }));
    }
    let rule = null;
    if (ctx.forceRuleId === 'none') {
      rule = null;
    } else if (ctx.forceRuleId) {
      rule = DISCOUNT_RULES.find(function (r) { return r.id === ctx.forceRuleId; }) || null;
    } else {
      // 중복 적용 금지: 가장 할인율이 큰 1건만
      rule = candidates.sort(function (a, b) { return b.rate - a.rate; })[0] || null;
    }

    // 매점 방문고객 할인: 방문 가족을 연동(ctx.memberLinked)한 경우 식음료·굿즈 품목에만 적용.
    // 입장권 할인(군민·단체)과는 적용 품목이 달라 한 품목에 두 할인이 겹치지 않는다.
    const store = getStoreMemberDiscount();
    const storeActive = !!ctx.memberLinked && store.rate > 0;

    const items = lines.map(function (l) {
      const listTotal = l.prod.list_price * l.quantity;
      const applies = !!rule && l.prod.discountable === true && listTotal > 0;
      const storeApplies = !applies && storeActive && listTotal > 0 && store.categories.indexOf(l.prod.category) !== -1;
      const discount = applies ? Math.round(listTotal * rule.rate)
        : storeApplies ? Math.round(listTotal * store.rate) : 0;
      return {
        product_id: l.prod.id,
        product_name: l.prod.name,
        product_category: l.prod.category,
        quantity: l.quantity,
        list_price: l.prod.list_price,
        discount_amount: discount,
        paid_amount: listTotal - discount,
        discount_rule: applies ? rule.id : (storeApplies ? store.id : null)
      };
    });

    const subtotal = items.reduce(function (s, i) { return s + i.list_price * i.quantity; }, 0);
    const discountTotal = items.reduce(function (s, i) { return s + i.discount_amount; }, 0);
    const storeDiscount = items.reduce(function (s, i) { return s + (i.discount_rule === store.id ? i.discount_amount : 0); }, 0);
    const labels = [];
    if (rule && items.some(function (i) { return i.discount_rule === rule.id; })) labels.push(rule.label);
    if (storeDiscount > 0) labels.push(store.label + ' ' + Math.round(store.rate * 100) + '%');

    return {
      items: items,
      summary: {
        headcount: headcount,
        subtotal: subtotal,
        discount: discountTotal,
        total: subtotal - discountTotal,
        rule_id: rule ? rule.id : null,
        rule_label: labels.length ? labels.join(' + ') : '할인 없음',
        store_discount: storeDiscount,
        available_rules: candidates.filter(Boolean).map(function (r) { return r.id; })
      }
    };
  }

  // 매점 방문고객 할인 설정 (기준정보 bongplay-site.js 의 store 항목)
  function getStoreMemberDiscount() {
    const site = global.BongplaySite;
    const rate = Number(site && site.get('store.member_discount_rate'));
    const cats = site && site.get('store.member_discount_categories');
    return {
      id: 'store_member',
      rate: Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0,
      label: (site && site.get('store.member_discount_label')) || '방문고객 매점 할인',
      categories: Array.isArray(cats) && cats.length ? cats : ['fnb', 'merchandise']
    };
  }

  // 아동 기본 권종: 12시 이전 입장은 조조권(18,000) 자동 추천, 이후는 종합권(21,000)
  const CHILD_TICKET_IDS = ['tkt_allday', 'tkt_morning', 'tkt_basic'];
  function defaultChildTicketId(at) {
    const d = at ? new Date(at) : new Date();
    return d.getHours() < 12 ? 'tkt_morning' : 'tkt_allday';
  }

  // 서약서 1건 → 기본 권종 자동 추천 (36개월 미만 무료, 보호자 1명)
  function recommendCartForConsent(consent, opts) {
    opts = opts || {};
    const children = (consent && Array.isArray(consent.children)) ? consent.children : [];
    let paidChildren = 0;
    let infants = 0;
    children.forEach(function (ch) { if (isInfant(ch)) infants++; else paidChildren++; });

    const childProductId = opts.childProductId || defaultChildTicketId(opts.at);
    const cart = [];
    if (paidChildren > 0) cart.push({ product_id: childProductId, quantity: paidChildren });
    if (infants > 0) cart.push({ product_id: 'tkt_infant_free', quantity: infants });
    cart.push({ product_id: 'tkt_guardian', quantity: Number(opts.guardianCount) || 1 });

    return {
      cart: cart,
      residence: (consent && (consent.residence || consent.residence_region)) || '',
      paidChildren: paidChildren,
      infants: infants,
      childProductId: childProductId,
      isMorningPreset: childProductId === 'tkt_morning'
    };
  }

  // 짚코스터 탑승이 포함된 상품인지 (종합권·조조권도 짚코스터 1회 포함 → 강풍 시 함께 판매 중지)
  function isCoasterProduct(item) {
    if (!item) return false;
    const id = String(item.product_id || item.id || '');
    const known = PRODUCTS[id];
    if (known && known.coaster === true) return true;
    if (item.coaster === true) return true;
    const name = String(item.product_name || item.name || '');
    return id.includes('coaster') || name.includes('짚코스터');
  }

  /* ---------- 4-7. 기준정보 SSOT 조회 및 BEP 계산 (Section 7) ---------- */
  function getProduct(productId) {
    return MASTER_PRODUCTS[productId] || PRODUCTS[productId] || null;
  }

  function getFacilityMaster(facilityId) {
    return MASTER_FACILITIES[facilityId] || FACILITIES[facilityId] || null;
  }

  function getTarget(targetId) {
    return MASTER_TARGETS[targetId] || null;
  }

  function calculateBepStatus(actualVisitors, actualRevenue, dayType) {
    const annual = MASTER_TARGETS.annual_bep;
    const baseDaily = MASTER_TARGETS.daily_baseline_bep;
    const targetType = dayType === 'weekend' ? MASTER_TARGETS.weekend_target : (dayType === 'festival' ? MASTER_TARGETS.festival_target : MASTER_TARGETS.weekday_target);

    const visitors = Number(actualVisitors || 0);
    const revenue = Number(actualRevenue || 0);

    const targetV = targetType ? targetType.target_visitors : baseDaily.target_visitors;
    const targetR = targetType ? targetType.target_revenue : baseDaily.target_revenue;

    const visitorAchieveRate = targetV > 0 ? Math.round((visitors / targetV) * 100) : 0;
    const revenueAchieveRate = targetR > 0 ? Math.round((revenue / targetR) * 100) : 0;
    const isAboveDailyBep = revenue >= baseDaily.target_revenue;

    return {
      actualVisitors: visitors,
      actualRevenue: revenue,
      targetVisitors: targetV,
      targetRevenue: targetR,
      visitorAchieveRate: visitorAchieveRate,
      revenueAchieveRate: revenueAchieveRate,
      isAboveDailyBep: isAboveDailyBep,
      dailyBaselineBepRevenue: baseDaily.target_revenue,
      annualBepVisitors: annual.target_visitors,
      annualBepRevenue: annual.target_revenue,
      version: annual.assumption_version
    };
  }

  /* ---------- 4-8. 디지털 트윈 공간 텔레메트리 연동 (Section 8) ---------- */
  function recordSpatialZoneTelemetry(zoneId, telemetryData) {
    const d = telemetryData || {};
    const record = {
      id: 'spz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      zone_id: zoneId,
      timestamp: d.timestamp || new Date().toISOString(),
      occupancy_count: Math.max(0, Number(d.occupancy_count || 0)),
      entry_count: Math.max(0, Number(d.entry_count || 0)),
      exit_count: Math.max(0, Number(d.exit_count || 0)),
      average_dwell_time: Math.max(0, Number(d.average_dwell_time || 0)),
      queue_count: Math.max(0, Number(d.queue_count || 0)),
      staff_count: Math.max(0, Number(d.staff_count || 0)),
      facility_status: d.facility_status || 'operating',
      sensor_status: d.sensor_status || 'online',
      created_at: new Date().toISOString()
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SPATIAL_ZONE_TELEMETRY) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      if (list.length > 500) list.length = 500;
      localStorage.setItem(STORAGE_KEYS.SPATIAL_ZONE_TELEMETRY, JSON.stringify(list));
    } catch (e) {
      console.warn('Spatial zone telemetry save error:', e);
    }

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('spatial_zone_telemetry', record);
    }

    return record;
  }

  function getSpatialZoneTelemetry(zoneId, limit) {
    const lim = limit || 20;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SPATIAL_ZONE_TELEMETRY);
      if (raw) {
        const list = JSON.parse(raw);
        if (zoneId) return list.filter(r => r.zone_id === zoneId).slice(0, lim);
        return list.slice(0, lim);
      }
    } catch (e) {}
    return [];
  }

  function getLatestSpatialState() {
    const result = {};
    SPATIAL_ZONES.forEach(z => {
      result[z.id] = {
        zone_id: z.id,
        name: z.name,
        space: z.space,
        maxCap: z.maxCap,
        occupancy_count: 0,
        entry_count: 0,
        exit_count: 0,
        average_dwell_time: z.targetDwell,
        queue_count: 0,
        staff_count: 1,
        facility_status: 'operating',
        sensor_status: 'online',
        density_pct: 0
      };
    });

    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SPATIAL_ZONE_TELEMETRY);
      if (raw) {
        const list = JSON.parse(raw);
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (result[r.zone_id] && !result[r.zone_id]._populated) {
            Object.assign(result[r.zone_id], r, { _populated: true });
          }
        }
      }
    } catch (e) {}

    const weather = getLatestWeather();
    const coasterStatus = getCurrentFacilityOperatingStatus('silver_coaster') || (weather.wind_gust >= 12.0 ? 'PAUSED_WEATHER' : 'OPEN');
    const isCoasterPaused = coasterStatus.indexOf('PAUSE') !== -1;

    const seedOccupancy = {
      parking: 22,
      plaza: 14,
      indoor_ticket: 6,
      indoor_cafe: 18,
      indoor_counter: 9,
      indoor_trampoline: 24,
      central_net: 16,
      coaster_queue: isCoasterPaused ? 0 : 8,
      silver_coaster: isCoasterPaused ? 0 : 6,
      coaster_landing: isCoasterPaused ? 0 : 4,
      indoor_firstaid: 1
    };

    SPATIAL_ZONES.forEach(z => {
      const s = result[z.id];
      if (!s._populated) {
        s.occupancy_count = seedOccupancy[z.id] !== undefined ? seedOccupancy[z.id] : 5;
        s.entry_count = Math.round(s.occupancy_count * 0.3);
        s.exit_count = Math.round(s.occupancy_count * 0.2);
        s.queue_count = z.id === 'coaster_queue' ? (isCoasterPaused ? 0 : 8) : (z.id === 'indoor_ticket' ? 3 : 0);
        s.data_source = 'simulated';
        s.is_simulated = true;
        s.data_source_label = '시뮬레이션 가상추정치';
        s.sensor_status = 'simulated';
      } else {
        s.data_source = 'live_sensor';
        s.is_simulated = false;
        s.data_source_label = '실측 IoT 센서';
        s.sensor_status = 'online';
      }
      if (z.id.indexOf('coaster') !== -1 && isCoasterPaused) {
        s.facility_status = 'weather_pause';
      }
      s.density_pct = Math.min(100, Math.round((s.occupancy_count / s.maxCap) * 100));
    });

    return result;
  }

  /* ---------- 4-9. Section 10 핵심 데이터 모델 (Core Data Model) & 1회 방문 여정 엔진 ---------- */
  function recordQueueSnapshot(data) {
    const d = data || {};
    const snapshot = {
      id: 'qs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: SITE_ID,
      visit_id: d.visit_id || null,
      facility_id: d.facility_id || 'outdoor_net',
      wait_minutes: Number(d.wait_minutes !== undefined ? d.wait_minutes : 0),
      queue_count: Number(d.queue_count !== undefined ? d.queue_count : 0),
      measured_at: d.measured_at || new Date().toISOString()
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.QUEUE_SNAPSHOTS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(snapshot);
      if (list.length > 500) list.length = 500;
      localStorage.setItem(STORAGE_KEYS.QUEUE_SNAPSHOTS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('queue_snapshots', snapshot);
    }
    return snapshot;
  }

  function getQueueSnapshots(visitId, facilityId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.QUEUE_SNAPSHOTS);
      const list = raw ? JSON.parse(raw) : [];
      return list.filter(item => {
        if (visitId && item.visit_id !== visitId) return false;
        if (facilityId && item.facility_id !== facilityId) return false;
        return true;
      });
    } catch (e) {
      return [];
    }
  }

  function recordSensorReading(data) {
    const d = data || {};
    const reading = {
      id: 'sns_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: SITE_ID,
      facility_id: d.facility_id || 'outdoor_coaster',
      asset_id: d.asset_id || 'zip_wire_main',
      sensor_type: d.sensor_type || 'tension',
      value: Number(d.value !== undefined ? d.value : 0),
      unit: d.unit || 'kN',
      status: d.status || 'normal',
      measured_at: d.measured_at || new Date().toISOString()
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SENSOR_READINGS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(reading);
      if (list.length > 500) list.length = 500;
      localStorage.setItem(STORAGE_KEYS.SENSOR_READINGS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('sensor_readings', reading);
    }
    return reading;
  }

  function getSensorReadings(assetId, limit) {
    const lim = limit || 50;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SENSOR_READINGS);
      const list = raw ? JSON.parse(raw) : [];
      const filtered = assetId ? list.filter(s => s.asset_id === assetId) : list;
      return filtered.slice(0, lim);
    } catch (e) {
      return [];
    }
  }

  function recordAssetMaintenance(data) {
    const d = data || {};
    const record = {
      id: 'mnt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: SITE_ID,
      asset_id: d.asset_id || 'zip_trolley_01',
      maintenance_type: d.maintenance_type || 'lubrication',
      cost: Number(d.cost || 0),
      technician: d.technician || siteStaffLabel('inspector'),
      description: d.description || '정기 윤활 및 점검',
      performed_at: d.performed_at || new Date().toISOString(),
      next_due_date: d.next_due_date || null
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.MAINTENANCE_LOGS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(record);
      if (list.length > 300) list.length = 300;
      localStorage.setItem(STORAGE_KEYS.MAINTENANCE_LOGS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('asset_maintenance_logs', record);
    }
    return record;
  }

  function getAssetMaintenanceLogs(assetId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.MAINTENANCE_LOGS);
      const list = raw ? JSON.parse(raw) : [];
      return assetId ? list.filter(m => m.asset_id === assetId) : list;
    } catch (e) {
      return [];
    }
  }

  function incrementAssetUsage(assetId, count) {
    const delta = Number(count || 1);
    updateEquipmentUsage(assetId, delta);
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.USAGE_COUNTERS) || '{}';
      const map = JSON.parse(raw);
      map[assetId] = (map[assetId] || 0) + delta;
      localStorage.setItem(STORAGE_KEYS.USAGE_COUNTERS, JSON.stringify(map));
      return map[assetId];
    } catch (e) {
      return delta;
    }
  }

  function getAssetUsageCounter(assetId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.USAGE_COUNTERS) || '{}';
      const map = JSON.parse(raw);
      return map[assetId] || 0;
    } catch (e) {
      return 0;
    }
  }

  /* 방문객 1회 전주기 여정 (Visit 360°) — 실제 기록만으로 복원
     ------------------------------------------------------------
     원천: 서약서(도착·발권·입장·퇴장·체류) · 주문 원장(구매) · 설문 · 시설 이용 · 사고/민원
     (예전 구현은 기록이 없으면 체류 150분·도착 10:00·NPS 9점 등을 임의로 채워 넣었고,
      "1회 여정 시뮬레이션 생성" 버튼이 가짜 서약·주문·설문을 실제 DB 에 올렸다 → 전면 제거) */
  function readLocalList(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; }
  }

  function isSimulatedVisit(id) {
    return /^vst_sim_/.test(String(id || ''));
  }

  function localHm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function consentVisitId(c) {
    return c.visit_id || c.id || ('vst_legacy_' + (c.passCode || c.pass_code || ''));
  }

  function stayInfo(c) {
    if (c.stay_duration_minutes != null && c.stay_duration_minutes >= 0) {
      return { minutes: Number(c.stay_duration_minutes), label: c.stay_duration_minutes + '분', live: false };
    }
    if (c.entry_at && c.exit_at) {
      const m = Math.round((new Date(c.exit_at) - new Date(c.entry_at)) / 60000);
      if (m >= 0) return { minutes: m, label: m + '분', live: false };
    }
    if (c.entry_at && !c.exit_at) {
      const m = Math.max(0, Math.round((Date.now() - new Date(c.entry_at)) / 60000));
      return { minutes: m, label: '이용 중 ' + m + '분', live: true };
    }
    return { minutes: null, label: '-', live: false };
  }

  function getVisitFullJourney(query) {
    const allConsents = getStoredConsents()
      .filter(c => !isSimulatedVisit(c.visit_id) && !isSimulatedVisit(c.id))
      .sort((a, b) => new Date(b.arrival_at || b.created_at || 0) - new Date(a.arrival_at || a.created_at || 0));

    let consent = null;
    if (query) {
      const q = String(query).trim().toLowerCase();
      const qNum = q.replace(/[^0-9]/g, '');
      consent = allConsents.find(c => {
        const vId = String(c.visit_id || '').toLowerCase();
        const id = String(c.id || '').toLowerCase();
        const code = String(c.passCode || c.pass_code || '').toLowerCase();
        const gName = String(c.guardianName || c.guardian_name || '').toLowerCase();
        const phone = String(c.guardianPhone || c.guardian_phone || c.phone || '').replace(/[^0-9]/g, '');
        return vId === q || id === q || code === q
          || (qNum.length >= 4 && phone && phone.endsWith(qNum))
          || (q.length >= 2 && gName.includes(q));
      });
      if (!consent) return { success: false, reason: 'not_found' };
    } else {
      consent = allConsents[0];
      if (!consent) return { success: false, reason: 'empty' };
    }

    const c = consent;
    const vId = consentVisitId(c);
    const pass = c.passCode || c.pass_code || '';
    const hhId = c.household_id || generateHouseholdId(c.guardianPhone || c.guardian_phone || c.phone);
    const linked = (row) => row && (row.visit_id === vId || (row.consent_id && row.consent_id === c.id));

    const orders = readLocalList(STORAGE_KEYS.ORDER_ITEMS)
      .filter(o => linked(o) && (o.status || 'paid') !== 'cancelled');
    const facilityEvents = readLocalList(STORAGE_KEYS.FACILITY_EVENTS).filter(linked);
    const queueSnapshots = readLocalList(STORAGE_KEYS.QUEUE_SNAPSHOTS).filter(linked);
    const surveys = readLocalList(STORAGE_KEYS.SURVEYS)
      .filter(s => linked(s) || (pass && s.pass_code === pass));
    const incidents = readLocalList(STORAGE_KEYS.INCIDENTS).filter(linked);
    const complaints = readLocalList(STORAGE_KEYS.COMPLAINTS).filter(linked);
    const booking = readLocalList(STORAGE_KEYS.GROUP_BOOKINGS)
      .find(b => (c.booking_id && b.booking_id === c.booking_id) || b.visit_id === vId) || null;

    const paidOf = (o) => Number(o.paid_amount != null ? o.paid_amount : (o.total_price || 0)) || 0;
    const catOf = (o) => o.product_category || o.category || '';
    const ticketSpend = orders.filter(o => catOf(o) === 'ticket').reduce((s, o) => s + paidOf(o), 0);
    const extraSpend = orders.filter(o => catOf(o) !== 'ticket').reduce((s, o) => s + paidOf(o), 0);
    const childCount = Array.isArray(c.children) ? c.children.length : 0;
    const adultCount = Number(c.adult_count) || 1;
    const stay = stayInfo(c);
    const survey = surveys[0] || null;
    const waitMinutes = queueSnapshots.reduce((s, q) => s + (Number(q.wait_minutes || q.estimated_wait_minutes) || 0), 0);

    // 타임라인: 실제 시각이 있는 사건만
    const nodes = [];
    const add = (ts, stage, title, desc, badge, color, icon) => {
      if (!ts) return;
      nodes.push({ timestamp: ts, time_label: localHm(ts), stage_label: stage, title, description: desc || '', badge, badge_color: color, icon });
    };
    if (booking) add(booking.created_at || booking.booking_date, '예약', '사전 단체예약', booking.group_name || booking.org_name || '', '예약', 'blue', 'calendar-check');
    add(c.arrival_at || c.created_at, '서약', '모바일 안전서약 접수', `보호자 1명 · 아이 ${childCount}명 · ${c.residence || '거주지 미입력'}`, pass || '서약', 'cyan', 'file-signature');
    add(c.ticket_issued_at, '발권', '매표소 발권', ticketSpend ? `입장권 ${ticketSpend.toLocaleString()}원` : '', '발권', 'emerald', 'ticket');
    add(c.entry_at, '입장', '게이트 입장', '', '입장', 'emerald', 'log-in');
    orders.filter(o => catOf(o) !== 'ticket').forEach(o => {
      add(o.purchased_at || o.created_at, '구매', o.product_name || '매점 구매',
        `${(o.quantity || 1)}개 · ${paidOf(o).toLocaleString()}원${o.discount_rule === 'store_member' ? ' (방문고객 할인)' : ''}`, '구매', 'amber', 'shopping-bag');
    });
    facilityEvents.forEach(e => add(e.started_at || e.entered_at, '이용', e.facility_name || e.facility_id || '시설 이용', e.result || '', '이용', 'purple', 'activity'));
    incidents.forEach(i => add(i.created_at || i.incident_at || i.reported_at, '사고', i.title || i.incident_type || '사고 보고', i.description || '', '사고', 'rose', 'alert-triangle'));
    complaints.forEach(m => add(m.created_at || m.datetime, '민원', m.title || m.category || '민원 접수', m.content || m.description || '', '민원', 'rose', 'message-square-warning'));
    add(c.exit_at, '퇴장', '게이트 퇴장', stay.minutes != null && !stay.live ? `체류 ${stay.label}` : '', '퇴장', 'purple', 'log-out');
    if (survey) {
      const sat = survey.satisfaction_score != null ? survey.satisfaction_score : survey.score;
      add(survey.submitted_at || survey.created_at, '설문', `만족도 ${sat != null ? sat + '/5' : '-'}`, survey.notes || survey.comment || '', survey.survey_channel === 'exit_tablet' ? '태블릿' : '모바일', 'blue', 'star');
    }
    nodes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const satisfaction = survey ? (survey.satisfaction_score != null ? survey.satisfaction_score : (survey.score != null ? survey.score : null)) : null;
    const summary = {
      visit_id: vId,
      consent_id: c.id,
      pass_code: pass,
      household_id: hhId,
      guardian_name: c.guardianName || c.guardian_name || '익명',
      residence: c.residence || c.residence_region || '-',
      party_size: childCount + adultCount,
      child_count: childCount,
      adult_count: adultCount,
      date: c.created_date || c.createdDate || (c.arrival_at || '').slice(0, 10),
      arrival_at: c.arrival_at || c.created_at || null,
      entry_at: c.entry_at || null,
      exit_at: c.exit_at || null,
      arrival_time: localHm(c.arrival_at || c.created_at),
      exit_time: localHm(c.exit_at),
      stay_duration_minutes: stay.minutes,
      stay_label: stay.label,
      total_spend: ticketSpend + extraSpend,
      ticket_spend: ticketSpend,
      fnb_spend: extraSpend,
      order_count: orders.length,
      total_rides: facilityEvents.length,
      total_wait_minutes: waitMinutes,
      satisfaction_score: satisfaction,
      nps_score: survey && survey.recommendation_score != null ? survey.recommendation_score : null,
      had_incident: incidents.length > 0,
      had_complaint: complaints.length > 0,
      status: c.exit_at ? '퇴장 완료' : (c.entry_at ? '이용 중' : ((c.isIssued || c.is_issued) ? '발권 완료' : '서약만 완료')),
      pillar_linkage: {
        booking: !!booking,
        order: orders.length > 0,
        order_items_count: orders.length,
        facility_usage: facilityEvents.length > 0,
        facility_events_count: facilityEvents.length,
        queue_snapshot: queueSnapshots.length > 0,
        feedback: !!survey
      }
    };

    // AI 학습용 에피소드 (State → Action → Outcome) — 실제 값만
    const episode = {
      visit_id: vId,
      date: summary.date,
      state: { residence: summary.residence, party_size: summary.party_size, child_count: childCount, arrival_time: summary.arrival_time, booking: !!booking },
      actions: orders.map(o => ({ at: localHm(o.purchased_at || o.created_at), product: o.product_id, category: catOf(o), paid: paidOf(o), discount_rule: o.discount_rule || null })),
      outcome: { stay_minutes: stay.live ? null : stay.minutes, total_spend: summary.total_spend, extra_spend: extraSpend, satisfaction: satisfaction, incident: summary.had_incident }
    };

    return { success: true, summary, timeline: nodes, episode };
  }

  /* 전체 방문 세션 요약 목록 (실제 기록만, 최근 도착순) */
  function getAllVisitsSummary(limit) {
    const lim = limit || 50;
    const orders = readLocalList(STORAGE_KEYS.ORDER_ITEMS).filter(o => (o.status || 'paid') !== 'cancelled');
    const surveys = readLocalList(STORAGE_KEYS.SURVEYS);
    const incs = readLocalList(STORAGE_KEYS.INCIDENTS);

    return getStoredConsents()
      .filter(c => !isSimulatedVisit(c.visit_id) && !isSimulatedVisit(c.id))
      .sort((a, b) => new Date(b.arrival_at || b.created_at || 0) - new Date(a.arrival_at || a.created_at || 0))
      .slice(0, lim)
      .map(c => {
        const vId = consentVisitId(c);
        const pass = c.passCode || c.pass_code || '';
        const linked = (row) => row.visit_id === vId || (row.consent_id && row.consent_id === c.id);
        const vOrders = orders.filter(linked);
        const vSurvey = surveys.find(s => linked(s) || (pass && s.pass_code === pass));
        const stay = stayInfo(c);
        return {
          visit_id: vId,
          consent_id: c.id,
          pass_code: pass,
          household_id: c.household_id || generateHouseholdId(c.guardianPhone || c.guardian_phone || c.phone),
          guardian_name: c.guardianName || c.guardian_name || '익명',
          phone_masked: String(c.guardianPhone || c.guardian_phone || '').replace(/(\d{3})-?\d{3,4}-?(\d{4})/, '$1-****-$2'),
          residence: c.residence || c.residence_region || '-',
          party_size: (Array.isArray(c.children) ? c.children.length : 0) + (Number(c.adult_count) || 1),
          date: c.created_date || c.createdDate || (c.arrival_at || '').slice(0, 10),
          arrival_time: localHm(c.arrival_at || c.created_at) || '-',
          exit_time: localHm(c.exit_at) || '-',
          stay_minutes: stay.minutes,
          stay_label: stay.label,
          total_spend: vOrders.reduce((s, o) => s + (Number(o.paid_amount != null ? o.paid_amount : o.total_price) || 0), 0),
          rides_count: 0,
          satisfaction_score: vSurvey ? (vSurvey.satisfaction_score != null ? vSurvey.satisfaction_score : vSurvey.score) : null,
          nps_score: vSurvey && vSurvey.recommendation_score != null ? vSurvey.recommendation_score : null,
          had_incident: incs.some(i => linked(i)),
          status: c.exit_at ? '퇴장 완료' : (c.entry_at ? '이용 중' : ((c.isIssued || c.is_issued) ? '발권 완료' : '서약만 완료'))
        };
      });
  }

  /* 여정 시뮬레이션 생성 기능은 폐지 (가짜 서약·주문·설문이 실제 DB 에 쌓였음).
     기존 화면 코드가 호출해도 아무것도 만들지 않는다. */
  function createSimulatedFullJourney() {
    console.warn('createSimulatedFullJourney: 폐지된 기능입니다 (실데이터 오염 방지).');
    return null;
  }

  // 이 기기에 남아 있는 예전 시뮬레이션 기록(vst_sim_*)을 1회 정리
  (function purgeSimulatedJourneysOnce() {
    try {
      if (typeof localStorage === 'undefined' || localStorage.getItem('bongplay_sim_purged_v1') === '1') return;
      [STORAGE_KEYS.CONSENTS, STORAGE_KEYS.ORDER_ITEMS, STORAGE_KEYS.FACILITY_EVENTS, STORAGE_KEYS.SURVEYS, STORAGE_KEYS.QUEUE_SNAPSHOTS].forEach(key => {
        const list = readLocalList(key);
        const kept = list.filter(r => !(r && (isSimulatedVisit(r.visit_id) || isSimulatedVisit(r.id))));
        if (kept.length !== list.length) localStorage.setItem(key, JSON.stringify(kept));
      });
      // 서버 저장에 실패해 미전송 목록(outbox)에 남은 시뮬레이션 건도 재전송하지 않도록 제거
      const OUTBOX_KEY = 'bongplay_outbox_queue_v2';
      const outbox = readLocalList(OUTBOX_KEY);
      const keptOut = outbox.filter(o => {
        const p = (o && o.payload) || {};
        return !(isSimulatedVisit(p.visit_id) || isSimulatedVisit(p.id) || isSimulatedVisit(o && o.id));
      });
      if (keptOut.length !== outbox.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(keptOut));
      localStorage.setItem('bongplay_sim_purged_v1', '1');
    } catch (e) {}
  })();

  /* ---------- 5. AI 인과 학습 통합 데이터셋 (Full Causal Graph JSON) ---------- */
  function exportAiCausalDataset() {
    try {
      const consentsRaw = localStorage.getItem(STORAGE_KEYS.CONSENTS) || localStorage.getItem(STORAGE_KEYS.LEGACY_CONSENTS);
      const salesRaw = localStorage.getItem('bongtteurak_actual_records_v4');
      const incidentsRaw = localStorage.getItem(STORAGE_KEYS.INCIDENTS);
      const complaintsRaw = localStorage.getItem(STORAGE_KEYS.COMPLAINTS);
      const auditsRaw = localStorage.getItem('bongplay_safety_audit_logs');
      const bookingsRaw = localStorage.getItem('bongtteurak_group_bookings_v1');
      const orderItemsRaw = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS);
      const facilityEventsRaw = localStorage.getItem(STORAGE_KEYS.FACILITY_EVENTS);
      const telemetryRaw = localStorage.getItem(STORAGE_KEYS.TELEMETRY);
      const actionLogsRaw = localStorage.getItem(STORAGE_KEYS.ACTION_LOGS);
      const measurementsRaw = localStorage.getItem(STORAGE_KEYS.ASSET_MEASUREMENTS);
      const equipmentRaw = localStorage.getItem(STORAGE_KEYS.EQUIPMENT_ASSETS);
      const intervalsRaw = localStorage.getItem(STORAGE_KEYS.FACILITY_INTERVALS);
      const campaignsRaw = localStorage.getItem(STORAGE_KEYS.CAMPAIGNS);
      const surveysRaw = localStorage.getItem(STORAGE_KEYS.SURVEYS);
      const staffShiftsRaw = localStorage.getItem(STORAGE_KEYS.STAFF_SHIFTS);
      const staffAssignmentsRaw = localStorage.getItem(STORAGE_KEYS.STAFF_ASSIGNMENTS);
      const staffTasksRaw = localStorage.getItem(STORAGE_KEYS.STAFF_TASKS);
      const weatherRaw = localStorage.getItem(STORAGE_KEYS.WEATHER_TELEMETRY);
      const spatialRaw = localStorage.getItem(STORAGE_KEYS.SPATIAL_ZONE_TELEMETRY);
      const queueSnapshotsRaw = localStorage.getItem(STORAGE_KEYS.QUEUE_SNAPSHOTS);
      const sensorReadingsRaw = localStorage.getItem(STORAGE_KEYS.SENSOR_READINGS);
      const maintenanceLogsRaw = localStorage.getItem(STORAGE_KEYS.MAINTENANCE_LOGS);
      const usageCountersRaw = localStorage.getItem(STORAGE_KEYS.USAGE_COUNTERS);

      const consents = consentsRaw ? JSON.parse(consentsRaw) : [];
      const sales = salesRaw ? JSON.parse(salesRaw) : [];
      const incidents = incidentsRaw ? JSON.parse(incidentsRaw) : [];
      const complaints = complaintsRaw ? JSON.parse(complaintsRaw) : [];
      const audits = auditsRaw ? JSON.parse(auditsRaw) : [];
      const bookings = bookingsRaw ? JSON.parse(bookingsRaw) : [];
      const orderItems = orderItemsRaw ? JSON.parse(orderItemsRaw) : [];
      const facilityEvents = facilityEventsRaw ? JSON.parse(facilityEventsRaw) : [];
      const telemetry = telemetryRaw ? JSON.parse(telemetryRaw) : [];
      const actionLogs = actionLogsRaw ? JSON.parse(actionLogsRaw) : [];
      const measurements = measurementsRaw ? JSON.parse(measurementsRaw) : [];
      const equipment = equipmentRaw ? JSON.parse(equipmentRaw) : getEquipmentAssets();
      const intervals = intervalsRaw ? JSON.parse(intervalsRaw) : [];
      const campaigns = campaignsRaw ? JSON.parse(campaignsRaw) : getMarketingCampaigns();
      const surveys = surveysRaw ? JSON.parse(surveysRaw) : [];
      const staffShifts = staffShiftsRaw ? JSON.parse(staffShiftsRaw) : getStaffShifts();
      const staffAssignments = staffAssignmentsRaw ? JSON.parse(staffAssignmentsRaw) : [];
      const staffTasks = staffTasksRaw ? JSON.parse(staffTasksRaw) : [];
      const weatherTelemetry = weatherRaw ? JSON.parse(weatherRaw) : getWeatherTelemetry(24);
      const spatialTelemetry = spatialRaw ? JSON.parse(spatialRaw) : [];
      const queueSnapshots = queueSnapshotsRaw ? JSON.parse(queueSnapshotsRaw) : [];
      const sensorReadings = sensorReadingsRaw ? JSON.parse(sensorReadingsRaw) : [];
      const maintenanceLogs = maintenanceLogsRaw ? JSON.parse(maintenanceLogsRaw) : [];
      const usageCounters = usageCountersRaw ? JSON.parse(usageCountersRaw) : {};

      // 1. Visit 단위 트랜잭션 맵 구축 (P0-2 Lifecycle 포함)
      const visitMap = {};
      consents.forEach(c => {
        const vId = c.visit_id || c.id || ('vst_legacy_' + c.passCode);
        const hhId = c.household_id || generateHouseholdId(c.guardianPhone || c.phone);
        visitMap[vId] = {
          visit_id: vId,
          household_id: hhId,
          booking_id: c.booking_id || null,
          campaign_id: c.campaign_id || 'cmp_walkin',
          date: c.createdDate || (c.created_at ? c.created_at.slice(0, 10) : '2026-09-15'),
          lifecycle: {
            arrival_at: c.arrival_at || c.created_at || null,
            ticket_issued_at: c.ticket_issued_at || null,
            entry_at: c.entry_at || null,
            exit_at: c.exit_at || null,
            stay_duration_minutes: c.stay_duration_minutes || null
          },
          demographics: {
            residence_region: c.residence_region || c.residence || '관외(영주/안동)',
            party_size: c.party_size || ((c.children ? c.children.length : 0) + 1),
            child_count: c.child_count || (c.children ? c.children.length : 0),
            adult_count: c.adult_count || 1,
            visit_type: c.visit_type || (c.booking_id ? 'group_booking' : 'walkin'),
            first_or_repeat: c.first_or_repeat || 'first',
            consent_marketing: c.consent_marketing === true
          },
          order_items: [],
          facility_events: [],
          queue_snapshots: [],
          incidents: [],
          complaints: [],
          surveys: []
        };
      });

      // 2. 주문·상품(P0-1) 매핑
      orderItems.forEach(oi => {
        if (oi.visit_id && visitMap[oi.visit_id]) {
          visitMap[oi.visit_id].order_items.push(oi);
        }
      });

      // 3. 시설 이용 이벤트(P0-3) 매핑
      facilityEvents.forEach(fe => {
        if (fe.visit_id && visitMap[fe.visit_id]) {
          visitMap[fe.visit_id].facility_events.push(fe);
        }
      });

      // 3-1. 대기열 스냅샷(Queue Snapshots) 매핑
      queueSnapshots.forEach(qs => {
        if (qs.visit_id && visitMap[qs.visit_id]) {
          visitMap[qs.visit_id].queue_snapshots.push(qs);
        }
      });

      // 4. 사고(Incidents) 매핑
      incidents.forEach(inc => {
        const target = inc.visit_id ? visitMap[inc.visit_id] : null;
        const incItem = {
          incident_id: inc.id,
          occurred_at: inc.datetime || inc.occurred_at,
          facility_id: inc.facility_id || inc.location || 'outdoor_coaster',
          asset_id: inc.asset_id || 'zip_trolley_01',
          severity: inc.severity || 'minor',
          description: inc.description || inc.cause
        };
        if (target) target.incidents.push(incItem);
      });

      // 5. 민원(Complaints) 매핑
      complaints.forEach(cmp => {
        const target = cmp.visit_id ? visitMap[cmp.visit_id] : null;
        const cmpItem = {
          complaint_id: cmp.id,
          received_at: cmp.datetime || cmp.received_at,
          facility_id: cmp.facility_id || 'indoor_ticket',
          complaint_type: cmp.type || cmp.complaint_type || '대기·혼잡',
          severity: cmp.severity || 'normal',
          content: cmp.content
        };
        if (target) target.complaints.push(cmpItem);
      });

      // 6. 10초 설문(Surveys, P1-4) 매핑
      surveys.forEach(srv => {
        if (srv.visit_id && visitMap[srv.visit_id]) {
          visitMap[srv.visit_id].surveys.push(srv);
        }
      });

      // 7. Causal Episodes (State -> Action -> Outcome)
      const episodes = Object.values(visitMap).map(v => {
        const totalSpend = v.order_items.reduce((s, it) => s + (it.paid_amount || 0), 0);
        return {
          meta: {
            site_id: SITE_ID,
            visit_id: v.visit_id,
            household_id: v.household_id,
            booking_id: v.booking_id,
            campaign_id: v.campaign_id,
            date: v.date
          },
          demographics: v.demographics,
          // 1. 상태 (State: 고객 도착 정보 & 가구 이력)
          state: {
            visit_type: v.demographics.visit_type,
            first_or_repeat: v.demographics.first_or_repeat,
            party_size: v.demographics.party_size,
            arrival_at: v.lifecycle.arrival_at
          },
          // 2. 운영 결정 (Action: 세부 발권, 체류 게이트, F&B 주문)
          action: {
            ticket_issued_at: v.lifecycle.ticket_issued_at,
            entry_at: v.lifecycle.entry_at,
            order_count: v.order_items.length,
            ordered_products: v.order_items.map(o => o.product_name),
            facility_uses: v.facility_events.map(e => ({ facility: e.facility_id, result: e.result }))
          },
          // 3. 결과 (Outcome: 체류시간, 총지출액, 사고, 민원, 설문)
          outcome: {
            exit_at: v.lifecycle.exit_at,
            stay_duration_minutes: v.lifecycle.stay_duration_minutes,
            total_spend: totalSpend,
            had_incident: v.incidents.length > 0,
            incident_count: v.incidents.length,
            had_complaint: v.complaints.length > 0,
            complaint_count: v.complaints.length,
            surveys: v.surveys
          }
        };
      });

      return {
        success: true,
        site_id: SITE_ID,
        exported_at: new Date().toISOString(),
        total_sessions: episodes.length,
        summary: {
          total_sessions: episodes.length,
          total_orders: orderItems.length,
          total_facility_events: facilityEvents.length,
          total_telemetry_snapshots: telemetry.length,
          total_operator_actions: actionLogs.length,
          total_asset_measurements: measurements.length,
          total_equipment_assets: equipment.length,
          total_facility_intervals: intervals.length,
          total_marketing_campaigns: campaigns.length,
          total_customer_surveys: surveys.length,
          total_staff_shifts: staffShifts.length,
          total_staff_assignments: staffAssignments.length,
          total_staff_tasks: staffTasks.length,
          total_weather_telemetry: weatherTelemetry.length,
          total_spatial_telemetry: spatialTelemetry.length,
          total_queue_snapshots: queueSnapshots.length,
          total_sensor_readings: sensorReadings.length,
          total_asset_maintenance_logs: maintenanceLogs.length,
          master_products_count: Object.keys(MASTER_PRODUCTS).length,
          master_facilities_count: Object.keys(MASTER_FACILITIES).length,
          master_targets_count: Object.keys(MASTER_TARGETS).length
        },
        data: {
          episodes: episodes,
          order_items: orderItems,
          facility_usage_events: facilityEvents,
          queue_snapshots: queueSnapshots,
          congestion_telemetry: telemetry,
          operator_action_logs: actionLogs,
          asset_measurements: measurements,
          sensor_readings: sensorReadings,
          equipment_assets: equipment,
          asset_maintenance_logs: maintenanceLogs,
          asset_usage_counters: usageCounters,
          facility_operating_intervals: intervals,
          marketing_campaigns: campaigns,
          customer_experience_surveys: surveys,
          staff_shifts: staffShifts,
          staff_assignment_events: staffAssignments,
          staff_task_logs: staffTasks,
          weather_environment_telemetry: weatherTelemetry,
          spatial_zone_telemetry: spatialTelemetry,
          master_reference: {
            products: MASTER_PRODUCTS,
            facilities: MASTER_FACILITIES,
            targets: MASTER_TARGETS
          }
        }
      };
    } catch (e) {
      console.error('AI Dataset export error:', e);
      return { success: false, error: String(e) };
    }
  }

  function downloadAiCausalJson() {
    const dataset = exportAiCausalDataset();
    const jsonStr = JSON.stringify(dataset, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bongplay_causal_ai_dataset_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------- 5-3. AI 백엔드 (FastAPI 3-Layer) 연동 브릿지 ---------- */
  async function requestAiActionRecommendation(apiBaseUrl) {
    const url = (apiBaseUrl || 'http://localhost:8000').replace(/\/$/, '') + '/predict';
    const now = new Date();
    const weather = typeof getLatestWeather === 'function' ? getLatestWeather() : { temperature: 25, wind_speed: 2.0, wind_gust: 3.0, rainfall: 0, humidity: 55, weather_warning: 'none' };
    const queueZip = (function() {
      try {
        const q = JSON.parse(localStorage.getItem(STORAGE_KEYS.QUEUE_SNAPSHOTS) || '[]');
        const latest = q.find(x => x.facility_id === 'outdoor_coaster');
        return latest ? (latest.queue_count || 12) : 12;
      } catch(e) { return 12; }
    })();

    const payload = {
      timestamp: now.toISOString(),
      day_of_week: now.getDay(),
      hour: now.getHours(),
      month: now.getMonth() + 1,
      is_weekend: [0, 6].includes(now.getDay()),
      is_festival: false,
      temp_c: Number(weather.temperature || 25),
      wind_speed: Number(weather.wind_speed || 2.0),
      wind_gust: Number(weather.wind_gust || 3.0),
      precipitation: Number(weather.rainfall || 0.0),
      humidity: Number(weather.humidity || 55),
      sky: weather.weather_condition || 'clear',
      zip_queue: queueZip,
      net_queue: 6,
      cafe_queue: 4,
      zip_open: true,
      net_open: true,
      staff_zip: 2,
      staff_net: 2,
      staff_cafe: 2,
      cumulative_visitors: 120,
      remaining_operating_minutes: Math.max(0, 18 * 60 - (now.getHours() * 60 + now.getMinutes())),
      lighting_ok: true
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const action = await resp.json();
      return { success: true, is_live_server: true, action: action };
    } catch(err) {
      // Local Heuristic Fallback
      return {
        success: true,
        is_live_server: false,
        note: 'AI 서버 오프라인 (로컬 안전 휴리스틱 적용)',
        action: {
          open_zip: (payload.wind_speed > 12 || payload.wind_gust > 15) ? 0 : 1,
          open_net: 1,
          add_staff_zip: payload.zip_queue > 12 ? 1 : 0,
          add_staff_cafe: 0,
          issue_coupon: 0,
          price_adjustment: 0.0,
          coupon_discount_rate: 0.0,
          target_throughput_zip: 1.0,
          safety_applied: true
        }
      };
    }
  }

  /* ---------- 6. 전역 노출 ---------- */
  global.BongplayID = {
    SITE_ID: SITE_ID,
    FACILITIES: FACILITIES,
    ASSETS: ASSETS,
    STAFF: STAFF,
    PRODUCTS: PRODUCTS,
    STORAGE_KEYS: STORAGE_KEYS,
    MASTER_PRODUCTS: MASTER_PRODUCTS,
    MASTER_FACILITIES: MASTER_FACILITIES,
    MASTER_TARGETS: MASTER_TARGETS,
    SPATIAL_ZONES: SPATIAL_ZONES,
    fnv1a: fnv1a,
    normalizePhone: normalizePhone,
    generateHouseholdId: generateHouseholdId,
    generateVisitId: generateVisitId,
    generateVisitorId: generateVisitorId,
    generateBookingId: generateBookingId,
    generateOrderId: generateOrderId,
    generateTicketId: generateTicketId,
    detectCampaignId: detectCampaignId,
    createVisitSession: createVisitSession,
    markVisitIssued: markVisitIssued,
    markVisitEntry: markVisitEntry,
    markVisitExit: markVisitExit,
    createOrder: createOrder,
    recordFacilityEvent: recordFacilityEvent,
    recordCongestionTelemetry: recordCongestionTelemetry,
    recordOperatorAction: recordOperatorAction,
    recordAssetMeasurement: recordAssetMeasurement,
    getEquipmentAssets: getEquipmentAssets,
    addEquipmentAsset: addEquipmentAsset,
    updateEquipmentAsset: updateEquipmentAsset,
    deleteEquipmentAsset: deleteEquipmentAsset,
    updateEquipmentUsage: updateEquipmentUsage,
    incrementFacilityEquipmentUsage: incrementFacilityEquipmentUsage,
    getPredictiveMaintenanceAlerts: getPredictiveMaintenanceAlerts,
    changeFacilityOperatingStatus: changeFacilityOperatingStatus,
    getCurrentFacilityOperatingStatus: getCurrentFacilityOperatingStatus,
    getFacilityOperatingMetrics: getFacilityOperatingMetrics,
    getMarketingCampaigns: getMarketingCampaigns,
    saveMarketingCampaigns: saveMarketingCampaigns,
    recordMarketingCampaign: recordMarketingCampaign,
    getCampaignAttribution: getCampaignAttribution,
    FUNNEL_STAGES: FUNNEL_STAGES,
    updateBookingFunnel: updateBookingFunnel,
    getHouseholdCrmProfile: getHouseholdCrmProfile,
    recordCustomerSurvey: recordCustomerSurvey,
    getCustomerSurveys: getCustomerSurveys,
    getNpsSummary: getNpsSummary,
    getStaffShifts: getStaffShifts,
    saveStaffShifts: saveStaffShifts,
    recordStaffAssignmentEvent: recordStaffAssignmentEvent,
    getStaffAssignmentEvents: getStaffAssignmentEvents,
    recordStaffTaskLog: recordStaffTaskLog,
    getStaffTaskLogs: getStaffTaskLogs,
    recordWeatherTelemetry: recordWeatherTelemetry,
    getWeatherTelemetry: getWeatherTelemetry,
    getLatestWeather: getLatestWeather,
    fetchLiveWeather: fetchLiveWeather,
    startLiveWeatherPolling: startLiveWeatherPolling,
    evaluateCoasterWeatherIntervention: evaluateCoasterWeatherIntervention,
    getCoasterWeatherLock: getCoasterWeatherLock,
    isCoasterProduct: isCoasterProduct,
    // 매표 요금 산출 (BP-008)
    PRODUCT_CATALOG: PRODUCT_CATALOG,
    POS_CATEGORIES: POS_CATEGORIES,
    DISCOUNT_RULES: DISCOUNT_RULES,
    getProductsList: getProductsList,
    getPosCategories: getPosCategories,
    computeCartPricing: computeCartPricing,
    recommendCartForConsent: recommendCartForConsent,
    defaultChildTicketId: defaultChildTicketId,
    CHILD_TICKET_IDS: CHILD_TICKET_IDS,
    isInfant: isInfant,
    isResidentDiscount: isResidentDiscount,
    getOrdersByDate: getOrdersByDate,
    getPaymentsByDate: getPaymentsByDate,
    getPaymentTotalsByDate: getPaymentTotalsByDate,
    PAYMENT_METHODS: PAYMENT_METHODS,
    getPaymentMethods: getPaymentMethods,
    getPaymentMethod: getPaymentMethod,
    getPaymentBucket: getPaymentBucket,
    buildPayments: buildPayments,
    cancelOrdersByConsent: cancelOrdersByConsent,
    getProduct: getProduct,
    getFacilityMaster: getFacilityMaster,
    getTarget: getTarget,
    calculateBepStatus: calculateBepStatus,
    recordSpatialZoneTelemetry: recordSpatialZoneTelemetry,
    getSpatialZoneTelemetry: getSpatialZoneTelemetry,
    getLatestSpatialState: getLatestSpatialState,
    recordQueueSnapshot: recordQueueSnapshot,
    getQueueSnapshots: getQueueSnapshots,
    recordSensorReading: recordSensorReading,
    getSensorReadings: getSensorReadings,
    recordAssetMaintenance: recordAssetMaintenance,
    getAssetMaintenanceLogs: getAssetMaintenanceLogs,
    incrementAssetUsage: incrementAssetUsage,
    getAssetUsageCounter: getAssetUsageCounter,
    getVisitFullJourney: getVisitFullJourney,
    getAllVisitsSummary: getAllVisitsSummary,
    createSimulatedFullJourney: createSimulatedFullJourney,
    exportAiCausalDataset: exportAiCausalDataset,
    exportAiTrainingEpisodes: exportAiCausalDataset,
    downloadAiCausalJson: downloadAiCausalJson,
    requestAiActionRecommendation: requestAiActionRecommendation,
    VERSION: '2.0.0',
    MODULES: ['id-core', 'telemetry', 'equipment', 'analytics']
  };

})(typeof window !== 'undefined' ? window : this);


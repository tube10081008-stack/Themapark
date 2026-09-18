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

  const STAFF = {
    stf_jiyeon:  { id: 'stf_jiyeon',  name: '김지연 매니저', role: '매표 및 고객 안내' },
    stf_jusung:  { id: 'stf_jusung',  name: '김주성 매니저', role: '안전 총괄 및 설비 점검' },
    stf_park:    { id: 'stf_park',    name: '박기원 안전요원', role: '짚코스터/야외 어드벤처' },
    stf_eunjung: { id: 'stf_eunjung', name: '조은정 주무관', role: '문화관광과 시설 행정' },
    stf_barista: { id: 'stf_barista', name: '카페 바리스타', role: '식음료 제조 및 F&B 운영' }
  };

  /* ---------- 3-1. 표준 상품 및 서비스 카탈로그 (P0-1 Item-level Master) ---------- */
  const PRODUCTS = {
    // 1. 이용권 (Tickets)
    tkt_child_allday:   { id: 'tkt_child_allday',   name: '종합이용권 (어린이)', category: 'ticket', list_price: 21000 },
    tkt_adult_guardian: { id: 'tkt_adult_guardian', name: '보호자 입장권 (성인)', category: 'ticket', list_price: 5000 },
    tkt_group_package:  { id: 'tkt_group_package',  name: '단체 패키지 이용권',   category: 'ticket', list_price: 15000 },
    // 2. 식음료 (F&B)
    fnb_apple_juice:    { id: 'fnb_apple_juice',    name: '봉화 사과 착즙주스',   category: 'fnb',    list_price: 4000 },
    fnb_americano:      { id: 'fnb_americano',      name: '아메리카노 (핫/아이스)',category: 'fnb',    list_price: 3500 },
    fnb_cafe_latte:     { id: 'fnb_cafe_latte',     name: '카페 라떼',            category: 'fnb',    list_price: 4000 },
    fnb_kids_cookie:    { id: 'fnb_kids_cookie',    name: '유기농 동물쿠키',       category: 'fnb',    list_price: 2500 },
    fnb_mineral_water:  { id: 'fnb_mineral_water',  name: '생수 (500ml)',         category: 'fnb',    list_price: 1000 },
    // 3. 부가 체험 (Add-ons)
    addon_coaster_single:{ id: 'addon_coaster_single',name: '짚코스터 추가 1회권',category: 'addon_attraction', list_price: 5000 },
    addon_net_challenge: { id: 'addon_net_challenge', name: '네트 어드벤처 추가권',category: 'addon_attraction', list_price: 5000 },
    addon_sled_slope:    { id: 'addon_sled_slope',    name: '사계절 썰매 5회권',    category: 'addon_attraction', list_price: 3000 },
    // 4. 안전/굿즈 (Merchandise)
    md_safety_socks:    { id: 'md_safety_socks',    name: '트램펄린 논슬립 양말', category: 'merchandise', list_price: 2500 },
    md_forest_cape:     { id: 'md_forest_cape',     name: '봉플레이 방수 케이프',  category: 'merchandise', list_price: 12000 }
  };

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
      description: '실내 924㎡ 놀이동 + 야외 네트어드벤처 2시간 정규 법정 고시가'
    },
    PROD_CHILD_BASIC_PROMO: {
      product_id: 'PROD_CHILD_BASIC_PROMO',
      product_name: '어린이 기본이용권 (오픈/평일 프로모션)',
      product_category: 'ticket_child',
      price: 14000,
      effective_from: '2026-01-01',
      effective_to: '2026-12-31',
      customer_type: 'child',
      season_type: 'regular',
      weekday_type: 'weekday',
      discount_rule_id: 'promo_open_1000',
      version: '2026.v1',
      description: '평일 오픈 기념 1,000원 할인 프로모션가'
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
      effective_to: null,
      customer_type: 'voucher',
      season_type: 'regular',
      weekday_type: 'weekday',
      discount_rule_id: 'bonghwa_voucher',
      version: '2026.v1',
      description: '봉화군 및 인근 지자체 연계 보조금/바우처 지원 단체권'
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
      area_sqm: 924.00,
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

  const MASTER_TARGETS = {
    annual_bep: {
      target_id: 'annual_bep',
      target_type: 'annual_bep',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: 19606,
      target_revenue: 236000000,
      fixed_cost: 228900000,
      variable_cost_per_person: 361,
      blended_price: 12036,
      operating_days: 350,
      assumption_version: '2026.v1',
      approved_by: '홍성현 총괄',
      description: '연간 고정비 2.289억 원 회수를 위한 손익분기점(BEP) 연간 총 목표'
    },
    daily_baseline_bep: {
      target_id: 'daily_baseline_bep',
      target_type: 'daily_baseline_bep',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: 55,
      target_revenue: 660000,
      assumption_version: '2026.v1',
      approved_by: '홍성현 총괄',
      description: '연간 BEP의 350일 균등 배분 시 일일 기준 손익분기 목표'
    },
    weekday_target: {
      target_id: 'weekday_target',
      target_type: 'weekday',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: 30,
      target_revenue: 360000,
      assumption_version: '2026.v1',
      approved_by: '홍성현 총괄',
      description: '평일 유치 운영 목표 (어린이집/유치원 단체 및 지역 주민 중심)'
    },
    weekend_target: {
      target_id: 'weekend_target',
      target_type: 'weekend',
      period_start: '2026-01-01',
      period_end: '2026-12-31',
      target_visitors: 148,
      target_revenue: 1780000,
      assumption_version: '2026.v1',
      approved_by: '홍성현 총괄',
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
      approved_by: '홍성현 총괄',
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
        coupon_id: couponId,
        staff_id: staffId,
        created_at: now.toISOString()
      };

      orderItems.push(record);
    });

    // Save locally
    try {
      const existingRaw = localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]';
      const list = JSON.parse(existingRaw);
      orderItems.forEach(rec => list.unshift(rec));
      localStorage.setItem(STORAGE_KEYS.ORDER_ITEMS, JSON.stringify(list));

      // Sync each item to Supabase
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        orderItems.forEach(rec => {
          global.BongplaySync.upsert('order_items', rec);
        });
      }
    } catch (e) {
      console.error('Failed to save order items:', e);
    }

    return {
      order_id: orderId,
      visit_id: visitId,
      items: orderItems,
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

      const filtered = items.filter(it => {
        const itemDate = (it.purchased_at || it.created_at || '').slice(0, 10);
        return itemDate === dateStr;
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
      decided_by: params.decided_by || '김주성 매니저',
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

  /* ---------- 4-7. 장비 개체 단위 관리 & AI 예지보전 (P0-7 Equipment Individual Registry) ---------- */
  function initDefaultEquipmentAssets() {
    try {
      const existing = localStorage.getItem(STORAGE_KEYS.EQUIPMENT_ASSETS);
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
    a.location = a.location || '?쇱쇅 吏싲씪???대뱶踰ㅼ쿂';
    a.status = a.status || 'active';
    return a;
  }

  function getEquipmentAssets() {
    initDefaultEquipmentAssets();
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.EQUIPMENT_ASSETS) || '[]';
      const list = JSON.parse(raw);
      return list.map(normalizeEquipmentAsset);
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
      location: newAsset.location || '?쇱쇅 吏싲씪???대뱶踰ㅼ쿂',
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
        sales_owner: b.sales_owner || '홍성현',
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
  function recordCustomerSurvey(params) {
    const survey = {
      id: 'SRV_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      visit_id: params.visit_id || null,
      household_id: params.household_id || null,
      submitted_at: new Date().toISOString(),
      satisfaction_score: parseInt(params.satisfaction_score, 10) || 5,
      recommendation_score: parseInt(params.recommendation_score, 10) || 9,
      wait_satisfaction: parseInt(params.wait_satisfaction, 10) || 4,
      favorite_facility: params.favorite_facility || 'outdoor_coaster',
      improvement_reason: params.improvement_reason || '특이사항 없음',
      revisit_intent: params.revisit_intent || 'yes',
      staff_friendly_score: parseInt(params.staff_friendly_score, 10) || 5,
      notes: params.notes || ''
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
    let sumSat = 0;
    let sumWait = 0;

    surveys.forEach(s => {
      const score = s.recommendation_score != null ? s.recommendation_score : 9;
      if (score >= 9) promoters++;
      else if (score >= 7) passives++;
      else detractors++;

      sumSat += (s.satisfaction_score || 5);
      sumWait += (s.wait_satisfaction || 4);
    });

    const total = surveys.length;
    const pPct = (promoters / total) * 100;
    const dPct = (detractors / total) * 100;
    const nps = Math.round(pPct - dPct);

    return {
      total: total,
      nps: nps,
      promoters_pct: Number(pPct.toFixed(1)),
      detractors_pct: Number(dPct.toFixed(1)),
      avg_satisfaction: Number((sumSat / total).toFixed(1)),
      avg_wait: Number((sumWait / total).toFixed(1))
    };
  }

  /* ---------- 4-8. P1-5: 직원 근무 교대 및 실시간 구역 재배치 (Staff Shifts & Assignment Events) ---------- */
  const DEFAULT_STAFF_SHIFTS = [
    {
      shift_id: 'SHF-20260915-01',
      staff_id: 'stf_park',
      staff_name: '박기원',
      role: '야외 어드벤처/안전 코치',
      assigned_zone: 'outdoor_coaster',
      scheduled_start: '09:00',
      scheduled_end: '18:30',
      actual_check_in: '08:48',
      actual_check_out: null,
      break_minutes: 60,
      status: 'on_duty'
    },
    {
      shift_id: 'SHF-20260915-02',
      staff_id: 'stf_jusung',
      staff_name: '홍성현',
      role: '시설 안전 총괄 관리책임자',
      assigned_zone: 'all_facilities',
      scheduled_start: '08:30',
      scheduled_end: '18:30',
      actual_check_in: '08:25',
      actual_check_out: null,
      break_minutes: 60,
      status: 'on_duty'
    },
    {
      shift_id: 'SHF-20260915-03',
      staff_id: 'stf_jiyeon',
      staff_name: '김지연',
      role: '매표 POS 및 고객 응대 매니저',
      assigned_zone: 'indoor_office',
      scheduled_start: '09:10',
      scheduled_end: '18:10',
      actual_check_in: '09:02',
      actual_check_out: null,
      break_minutes: 60,
      status: 'on_duty'
    },
    {
      shift_id: 'SHF-20260915-04',
      staff_id: 'stf_barista',
      staff_name: '이서준',
      role: '실내 카페 & 플레이존 안전 서포터',
      assigned_zone: 'indoor_cafe',
      scheduled_start: '09:30',
      scheduled_end: '18:30',
      actual_check_in: '09:15',
      actual_check_out: null,
      break_minutes: 60,
      status: 'on_duty'
    }
  ];

  function getStaffShifts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STAFF_SHIFTS);
      if (!raw) {
        localStorage.setItem(STORAGE_KEYS.STAFF_SHIFTS, JSON.stringify(DEFAULT_STAFF_SHIFTS));
        return DEFAULT_STAFF_SHIFTS;
      }
      return JSON.parse(raw);
    } catch (e) {
      return DEFAULT_STAFF_SHIFTS;
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
      dispatched_by: params.dispatched_by || '홍성현'
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
      wind_speed: Number(d.wind_speed !== undefined ? d.wind_speed : 3.2),
      wind_gust: Number(d.wind_gust !== undefined ? d.wind_gust : (Number(d.wind_speed || 3.2) * 1.5).toFixed(1)),
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

  // 봉화 현장 실시간 Open-Meteo 기상 관측 연동 (위도: 36.893, 경도: 128.732)
  async function fetchLiveWeather() {
    try {
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=36.893&longitude=128.732&current_weather=true&windspeed_unit=ms');
      if (res.ok) {
        const data = await res.json();
        const cur = data.current_weather || {};
        const windSpeed = typeof cur.windspeed === 'number' ? Math.round(cur.windspeed * 10) / 10 : 0;
        const gust = typeof cur.windgust === 'number' ? Math.round(cur.windgust * 10) / 10 : Math.round(windSpeed * 1.3 * 10) / 10;
        const temp = typeof cur.temperature === 'number' ? Math.round(cur.temperature * 10) / 10 : 20.0;
        const code = cur.weathercode || 0;
        const isRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);

        const rec = {
          id: 'wtr_live_' + Date.now(),
          observed_at: new Date().toISOString(),
          temperature: temp,
          humidity: 50,
          rainfall: isRain ? 6.0 : 0.0,
          wind_speed: windSpeed,
          wind_gust: gust,
          wind_direction: cur.winddirection || 'NW',
          weather_warning: gust >= 12.0 ? 'strong_wind_watch' : (isRain ? 'rain_watch' : 'none'),
          source: 'open_meteo_live_bonghwa',
          status: 'LIVE'
        };

        const existing = getWeatherTelemetry(20);
        existing.unshift(rec);
        if (existing.length > 30) existing.length = 30;
        localStorage.setItem(STORAGE_KEYS.WEATHER_TELEMETRY, JSON.stringify(existing));
        return rec;
      }
    } catch (e) {
      console.warn('[BongplayID] Live weather fetch failed:', e);
    }
    return null;
  }

  function getLatestWeather() {
    const list = getWeatherTelemetry(1);
    if (list && list.length > 0) {
      const latest = list[0];
      // 관측 데이터가 2시간 이상 경과되었으면 신뢰 불가 처리
      const diffMs = Date.now() - new Date(latest.observed_at || 0).getTime();
      if (diffMs < 2 * 60 * 60 * 1000) {
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
    if (w.status === 'UNKNOWN' || w.wind_speed === null || w.wind_gust === null || w.weather_warning === 'UNKNOWN_WEATHER') {
      return {
        canOperate: false,
        alertLevel: 'warning',
        reason: '기상 관측 데이터 미수신 (현장 풍속 수동 확인 필요)',
        suggestedAction: '현장 풍속계로 직접 계측 후 관제 화면에 수동 입력할 때까지 짚코스터 발권을 대기합니다.',
        actionStatus: 'PAUSED_MANUAL_CHECK'
      };
    }

    const gust = Number(w.wind_gust || 0);
    const rain = Number(w.rainfall || 0);
    const warning = String(w.weather_warning || 'none');

    if (gust >= 12.0) {
      return {
        canOperate: false,
        alertLevel: 'critical',
        reason: `순간최대풍속 ${gust} m/s (안전 임계치 12.0 m/s 초과)`,
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
      technician: d.technician || '김주성',
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

  /* 최우선순위: 방문객 1회 전주기 여정 (Visit 360° Timeline) 복원 */
  function getVisitFullJourney(query) {
    const allConsents = getStoredConsents();
    let consent = null;

    if (query) {
      const q = String(query).trim().toLowerCase();
      const qNum = q.replace(/[^0-9]/g, '');
      consent = allConsents.find(c => {
        const vId = String(c.visit_id || '').toLowerCase();
        const id = String(c.id || '').toLowerCase();
        const code = String(c.passCode || '').toLowerCase();
        const gName = String(c.guardianName || c.guardian_name || '').toLowerCase();
        const phone = String(c.guardianPhone || c.phone || '').replace(/[^0-9]/g, '');
        return vId === q || id === q || code === q || (phone && phone === qNum) || (q.length >= 2 && gName.includes(q));
      });
    }

    if (!consent && allConsents.length > 0) {
      consent = allConsents[0];
    }

    const vId = consent ? (consent.visit_id || consent.id || ('vst_legacy_' + consent.passCode)) : (query || 'vst_unknown');
    const hhId = consent ? (consent.household_id || generateHouseholdId(consent.guardianPhone || consent.phone)) : generateHouseholdId('010-0000-0000');

    // 하위 7대 엔티티 로드
    const orderItems = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]'); } catch(e) { return []; }
    })().filter(o => o.visit_id === vId);

    const facilityEvents = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.FACILITY_EVENTS) || '[]'); } catch(e) { return []; }
    })().filter(e => e.visit_id === vId);

    const queueSnapshots = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.QUEUE_SNAPSHOTS) || '[]'); } catch(e) { return []; }
    })().filter(q => q.visit_id === vId);

    const surveys = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.SURVEYS) || '[]'); } catch(e) { return []; }
    })().filter(s => s.visit_id === vId);

    const incidents = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.INCIDENTS) || '[]'); } catch(e) { return []; }
    })().filter(i => i.visit_id === vId);

    const complaints = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.COMPLAINTS) || '[]'); } catch(e) { return []; }
    })().filter(c => c.visit_id === vId);

    const booking = (function() {
      try {
        const list = JSON.parse(localStorage.getItem(STORAGE_KEYS.GROUP_BOOKINGS) || '[]');
        return list.find(b => (consent && consent.booking_id && b.booking_id === consent.booking_id) || (b.visit_id === vId));
      } catch(e) { return null; }
    })();

    const weatherLogs = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.WEATHER_TELEMETRY) || '[]'); } catch(e) { return []; }
    })();

    // 타임라인 합성
    const timeline = [];
    const baseDate = consent ? (consent.createdDate || (consent.created_at ? consent.created_at.slice(0, 10) : '2026-09-15')) : '2026-09-15';

    // 1. 도착
    const arrivalTime = (consent && consent.arrival_at) || (consent && consent.created_at) || `${baseDate}T10:00:00.000Z`;
    timeline.push({
      timestamp: arrivalTime,
      stage: 'arrival',
      stage_label: '1. 현장 도착',
      title: '방문객 현장 도착 (Arrival)',
      description: `${consent ? (consent.guardianName || consent.guardian_name || '방문객') : '이용객'} 일행 도착 (거주지: ${consent ? (consent.residence_region || consent.residence || '관외') : '미확인'})`,
      icon: 'map-pin',
      badge: '도착확인',
      badge_color: 'cyan',
      details: {
        guardian: consent ? (consent.guardianName || consent.guardian_name) : '익명',
        phone: consent ? (consent.guardianPhone || consent.phone) : '-',
        party_size: consent ? ((consent.children ? consent.children.length : 0) + (consent.adult_count || 1)) : 1
      }
    });

    // 1-1. 기상 환경 연동 (Weather Telemetry)
    const matchedWeather = weatherLogs.length > 0
      ? (weatherLogs.find(w => (w.observed_at || '').slice(0, 13) === arrivalTime.slice(0, 13)) || weatherLogs[0])
      : null;
    if (matchedWeather) {
      const wTime = matchedWeather.observed_at ? matchedWeather.observed_at.slice(11, 16) : arrivalTime.slice(11, 16);
      timeline.push({
        timestamp: matchedWeather.observed_at || arrivalTime,
        stage: 'weather',
        stage_label: '기상·환경',
        title: `기상 환경 연동 (${matchedWeather.weather_condition || (matchedWeather.temperature >= 25 ? '맑음' : '구름조금')})`,
        description: `${wTime} 기준 기온 ${matchedWeather.temperature || 28}℃, 습도 ${matchedWeather.humidity || 65}%, 풍속 ${matchedWeather.wind_speed || 1.8}m/s (특보: ${matchedWeather.weather_warning || 'none'})`,
        icon: 'cloud-sun',
        badge: `${matchedWeather.temperature || 28}℃ ${matchedWeather.weather_condition || '맑음'}`,
        badge_color: 'sky',
        details: matchedWeather
      });
    }

    // 2. 발권 (티켓 주문)
    const ticketOrders = orderItems.filter(o => o.product_category === 'ticket' || (o.product_id && o.product_id.startsWith('tkt_')) || (o.product_id && o.product_id.startsWith('PROD_CHILD')) || (o.product_id && o.product_id.startsWith('PROD_ADULT')));
    if (ticketOrders.length > 0) {
      const ticketTotal = ticketOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
      const ticketTime = (consent && consent.ticket_issued_at) || ticketOrders[0].purchased_at || `${baseDate}T10:05:00.000Z`;
      timeline.push({
        timestamp: ticketTime,
        stage: 'order_ticket',
        stage_label: '2. 매표 및 발권',
        title: `POS 발권 완료 (${ticketOrders.length}종 품목)`,
        description: ticketOrders.map(t => `${t.product_name} x${t.quantity} (${(t.paid_amount || 0).toLocaleString()}원)`).join(' / '),
        icon: 'ticket',
        badge: `${ticketTotal.toLocaleString()}원`,
        badge_color: 'amber',
        details: { items: ticketOrders, total: ticketTotal }
      });
    }

    // 3. 안전서약서 작성
    if (consent) {
      const consentTime = consent.created_at || `${baseDate}T10:08:00.000Z`;
      const childNames = (consent.children || []).map(ch => `${ch.name}(${ch.age}세)`).join(', ');
      timeline.push({
        timestamp: consentTime,
        stage: 'consent',
        stage_label: '3. 모바일 안전서약',
        title: '전자 안전이용서약서 서명 완료',
        description: `보호자: ${consent.guardianName || consent.guardian_name} | 동반아동: ${childNames || '없음'} | 마케팅동의: ${consent.consent_marketing ? '동의' : '미동의'}`,
        icon: 'file-check',
        badge: '서약완료',
        badge_color: 'emerald',
        details: { passCode: consent.passCode, children: consent.children }
      });
    }

    // 4. 게이트 입장
    const entryTime = (consent && consent.entry_at) || `${baseDate}T10:12:00.000Z`;
    timeline.push({
      timestamp: entryTime,
      stage: 'entry',
      stage_label: '4. 메인 게이트 통과',
      title: '놀이터 메인 게이트 QR 체크인',
      description: '어린이 및 보호자 밴드/QR 스캔 후 안전입장 완료',
      icon: 'door-open',
      badge: '입장확인',
      badge_color: 'emerald',
      details: { entry_at: entryTime }
    });

    // 5. 대기 스냅샷 (Queue Snapshots)
    queueSnapshots.forEach(qs => {
      timeline.push({
        timestamp: qs.measured_at || `${baseDate}T10:20:00.000Z`,
        stage: 'queue',
        stage_label: '5. 시설 대기',
        title: `시설 대기열 진입 (${qs.facility_id})`,
        description: `대기시간 실측: 약 ${qs.wait_minutes}분 (대기인원 ${qs.queue_count}명)`,
        icon: 'clock',
        badge: `${qs.wait_minutes}분 대기`,
        badge_color: qs.wait_minutes > 15 ? 'rose' : 'purple',
        details: qs
      });
    });

    // 6. 시설 이용 이벤트 (Facility Usages)
    facilityEvents.forEach(fe => {
      timeline.push({
        timestamp: fe.entered_at || fe.started_at || `${baseDate}T10:25:00.000Z`,
        stage: 'facility_usage',
        stage_label: '6. 시설 이용',
        title: `시설 탑승/이용 (${fe.facility_id})`,
        description: `탑승결과: ${fe.result || '정상완료'}${fe.operator_staff_id ? ` (담당: ${fe.operator_staff_id})` : ''}`,
        icon: 'activity',
        badge: fe.result === 'completed' ? '정상탑승' : fe.result,
        badge_color: fe.result === 'completed' ? 'emerald' : 'rose',
        details: fe
      });
    });

    // 7. 부가 F&B / 체험 주문
    const fnbOrders = orderItems.filter(o => o.product_category === 'fnb' || o.product_category === 'addon_attraction' || (o.product_id && o.product_id.startsWith('fnb_')) || (o.product_id && o.product_id.startsWith('PROD_FNB')));
    if (fnbOrders.length > 0) {
      const fnbTotal = fnbOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
      const fnbTime = fnbOrders[0].purchased_at || `${baseDate}T11:15:00.000Z`;
      timeline.push({
        timestamp: fnbTime,
        stage: 'order_fnb',
        stage_label: '7. F&B 및 부가상품 구매',
        title: `사무동 카페테리아 F&B 주문 (${fnbOrders.length}종)`,
        description: fnbOrders.map(f => `${f.product_name} x${f.quantity} (${(f.paid_amount || 0).toLocaleString()}원)`).join(' / '),
        icon: 'coffee',
        badge: `${fnbTotal.toLocaleString()}원`,
        badge_color: 'amber',
        details: { items: fnbOrders, total: fnbTotal }
      });
    }

    // 8. 사고 및 민원
    incidents.forEach(inc => {
      timeline.push({
        timestamp: inc.occurred_at || inc.datetime || `${baseDate}T11:30:00.000Z`,
        stage: 'incident',
        stage_label: '🚨 안전사고 발생',
        title: `사고 발생 (${inc.facility_id || inc.location})`,
        description: `등급: ${inc.severity} | 내용: ${inc.description || inc.cause} | 조치: ${inc.action_taken}`,
        icon: 'alert-triangle',
        badge: '사고연동',
        badge_color: 'rose',
        details: inc
      });
    });

    complaints.forEach(cp => {
      timeline.push({
        timestamp: cp.received_at || cp.datetime || `${baseDate}T11:35:00.000Z`,
        stage: 'complaint',
        stage_label: '⚠️ 민원 접수',
        title: `고객 민원 접수 (${cp.complaint_type || '현장불만'})`,
        description: `내용: ${cp.content || cp.description}`,
        icon: 'message-square-warning',
        badge: '민원연동',
        badge_color: 'amber',
        details: cp
      });
    });

    // 9. 만족도 설문 (Feedback)
    surveys.forEach(srv => {
      timeline.push({
        timestamp: srv.created_at || `${baseDate}T12:35:00.000Z`,
        stage: 'survey',
        stage_label: '8. 10초 퇴장 설문 (NPS)',
        title: `고객 경험 만족도 평가 (NPS ${srv.nps_score}점)`,
        description: `전반 만족도: ${srv.satisfaction_rating || 5}/5점 | 대기 만족도: ${srv.wait_satisfaction || 4}/5점 ${srv.comment ? ` | 의견: "${srv.comment}"` : ''}`,
        icon: 'star',
        badge: `NPS ${srv.nps_score}점`,
        badge_color: srv.nps_score >= 9 ? 'emerald' : (srv.nps_score >= 7 ? 'amber' : 'rose'),
        details: srv
      });
    });

    // 10. 퇴장
    const exitTime = (consent && consent.exit_at) || `${baseDate}T12:45:00.000Z`;
    timeline.push({
      timestamp: exitTime,
      stage: 'exit',
      stage_label: '9. 출구 퇴장',
      title: '출구 게이트 퇴장 완료',
      description: `총 체류시간: ${consent && consent.stay_duration_minutes ? consent.stay_duration_minutes : 150}분 | 여정 완료`,
      icon: 'log-out',
      badge: '퇴장완료',
      badge_color: 'blue',
      details: { exit_at: exitTime }
    });

    // 시간순 정렬
    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // 집계 메트릭 계산
    const totalSpend = orderItems.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
    const ticketSpend = ticketOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
    const fnbSpend = fnbOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
    const stayMinutes = consent && consent.stay_duration_minutes ? consent.stay_duration_minutes : 150;
    const totalWait = queueSnapshots.reduce((sum, q) => sum + (q.wait_minutes || 0), 0);

    const summary = {
      visit_id: vId,
      household_id: hhId,
      guardian_name: consent ? (consent.guardianName || consent.guardian_name || '익명') : '이용객',
      guardian_phone: consent ? (consent.guardianPhone || consent.phone || '-') : '-',
      residence: consent ? (consent.residence_region || consent.residence || '관외') : '관외',
      party_size: consent ? ((consent.children ? consent.children.length : 0) + (consent.adult_count || 1)) : 1,
      child_count: consent && consent.children ? consent.children.length : 0,
      adult_count: consent && consent.adult_count ? consent.adult_count : 1,
      date: baseDate,
      arrival_at: arrivalTime,
      exit_at: exitTime,
      stay_duration_minutes: stayMinutes,
      total_spend: totalSpend,
      ticket_spend: ticketSpend,
      fnb_spend: fnbSpend,
      total_rides: facilityEvents.filter(e => e.result === 'completed').length,
      total_wait_minutes: totalWait,
      nps_score: surveys.length > 0 ? surveys[0].nps_score : null,
      had_incident: incidents.length > 0,
      had_complaint: complaints.length > 0,
      weather: matchedWeather ? {
        observed_at: matchedWeather.observed_at,
        condition: matchedWeather.weather_condition || '맑음',
        temperature: matchedWeather.temperature || 28,
        humidity: matchedWeather.humidity || 65,
        wind_speed: matchedWeather.wind_speed || 1.8,
        wind_gust: matchedWeather.wind_gust || 2.5
      } : null,
      pillar_linkage: {
        household: true,
        visit: true,
        booking: Boolean(booking),
        order: orderItems.length > 0,
        order_items_count: orderItems.length,
        facility_usage: facilityEvents.length > 0,
        facility_events_count: facilityEvents.length,
        queue_snapshot: queueSnapshots.length > 0,
        weather: Boolean(matchedWeather),
        feedback: surveys.length > 0,
        incident: incidents.length > 0
      }
    };

    const episode = {
      meta: { site_id: SITE_ID, visit_id: vId, household_id: hhId, date: baseDate },
      state: {
        residence: summary.residence,
        party_size: summary.party_size,
        child_count: summary.child_count,
        arrival_at: arrivalTime,
        weather: summary.weather
      },
      action: {
        orders: orderItems.map(o => ({ product: o.product_name, category: o.product_category, amount: o.paid_amount })),
        facility_rides: facilityEvents.map(e => ({ facility: e.facility_id, result: e.result })),
        waited_minutes: totalWait
      },
      outcome: {
        stay_duration_minutes: stayMinutes,
        total_spend: totalSpend,
        nps_score: summary.nps_score,
        had_incident: summary.had_incident,
        had_complaint: summary.had_complaint
      }
    };

    return {
      success: true,
      visit_id: vId,
      summary: summary,
      timeline: timeline,
      episode: episode,
      raw: {
        consent: consent,
        booking: booking,
        order_items: orderItems,
        facility_events: facilityEvents,
        queue_snapshots: queueSnapshots,
        surveys: surveys,
        incidents: incidents,
        complaints: complaints
      }
    };
  }

  /* 전체 방문 세션 요약 목록 조회 */
  function getAllVisitsSummary(limit) {
    const lim = limit || 50;
    const consents = getStoredConsents();
    const orders = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]'); } catch(e) { return []; }
    })();
    const events = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.FACILITY_EVENTS) || '[]'); } catch(e) { return []; }
    })();
    const surveys = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.SURVEYS) || '[]'); } catch(e) { return []; }
    })();
    const incs = (function() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.INCIDENTS) || '[]'); } catch(e) { return []; }
    })();

    return consents.slice(0, lim).map(c => {
      const vId = c.visit_id || c.id || ('vst_legacy_' + c.passCode);
      const vOrders = orders.filter(o => o.visit_id === vId);
      const vEvents = events.filter(e => e.visit_id === vId);
      const vSurveys = surveys.filter(s => s.visit_id === vId);
      const hasInc = incs.some(i => i.visit_id === vId);
      const totalSpend = vOrders.reduce((sum, o) => sum + (o.paid_amount || 0), 0);
      const partySize = (c.children ? c.children.length : 0) + (c.adult_count || 1);

      return {
        visit_id: vId,
        household_id: c.household_id || generateHouseholdId(c.guardianPhone || c.phone),
        guardian_name: c.guardianName || c.guardian_name || '익명',
        phone_masked: (c.guardianPhone || c.phone || '').replace(/(\d{3})\d{4}(\d{4})/, '$1-****-$2'),
        residence: c.residence_region || c.residence || '관외',
        party_size: partySize,
        date: c.createdDate || (c.created_at ? c.created_at.slice(0, 10) : '2026-09-15'),
        arrival_time: (c.arrival_at || c.created_at || '').slice(11, 16) || '10:00',
        exit_time: (c.exit_at || '').slice(11, 16) || (c.arrival_at ? '12:30' : '-'),
        stay_minutes: c.stay_duration_minutes || 150,
        total_spend: totalSpend,
        rides_count: vEvents.length,
        nps_score: vSurveys.length > 0 ? vSurveys[0].nps_score : null,
        had_incident: hasInc,
        status: c.exit_at ? '퇴장 완료' : (c.entry_at ? '체류 중' : '발권 완료')
      };
    });
  }

  /* 표준 1회 전주기 여정 시뮬레이션 데이터 원클릭 생성 */
  function createSimulatedFullJourney(customProps) {
    const props = customProps || {};
    const today = new Date().toISOString().slice(0, 10);
    const vId = props.visit_id || ('vst_sim_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5));
    const phone = props.phone || '010-9876-5432';
    const hhId = props.household_id || generateHouseholdId(phone);
    const gName = props.guardian_name || '김태양';

    // 1. 안전서약 (Consent)
    const consent = {
      id: vId,
      visit_id: vId,
      household_id: hhId,
      passCode: 'BP' + Math.floor(1000 + Math.random() * 9000),
      guardianName: gName,
      guardian_name: gName,
      guardianPhone: phone,
      phone: phone,
      residence: '경북 영주시 가흥동',
      residence_region: '영주',
      visit_type: 'walkin',
      first_or_repeat: 'repeat',
      children: [
        { name: '김민준', age: 7, gender: '남' },
        { name: '김서연', age: 5, gender: '여' }
      ],
      adult_count: 1,
      party_size: 3,
      arrival_at: `${today}T10:15:00.000Z`,
      ticket_issued_at: `${today}T10:18:00.000Z`,
      entry_at: `${today}T10:22:00.000Z`,
      exit_at: `${today}T12:45:00.000Z`,
      stay_duration_minutes: 150,
      consent_marketing: true,
      created_at: `${today}T10:20:00.000Z`,
      createdDate: today
    };

    try {
      const consents = getStoredConsents();
      consents.unshift(consent);
      localStorage.setItem(STORAGE_KEYS.CONSENTS, JSON.stringify(consents));
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('safety_consents', consent);
      }
    } catch(e) {}

    // 2. 발권 품목 주문 (Order 1: 매표소)
    const ordId1 = 'ORD-' + today.replace(/-/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);
    const item1 = {
      id: ordId1 + '_1',
      order_id: ordId1,
      site_id: SITE_ID,
      visit_id: vId,
      purchased_at: `${today}T10:18:00.000Z`,
      sales_channel: 'pos_counter',
      product_id: 'PROD_CHILD_ALL_STD',
      product_name: '종합이용권 (짚코스터 포함)',
      product_category: 'ticket',
      quantity: 2,
      list_price: 21000,
      discount_amount: 0,
      paid_amount: 42000,
      payment_method: 'card',
      staff_id: '홍성현',
      created_at: `${today}T10:18:00.000Z`
    };
    const item2 = {
      id: ordId1 + '_2',
      order_id: ordId1,
      site_id: SITE_ID,
      visit_id: vId,
      purchased_at: `${today}T10:18:00.000Z`,
      sales_channel: 'pos_counter',
      product_id: 'PROD_ADULT_CARE',
      product_name: '보호자 입장권 (음료 미포함)',
      product_category: 'ticket',
      quantity: 1,
      list_price: 5000,
      discount_amount: 0,
      paid_amount: 5000,
      payment_method: 'card',
      staff_id: '홍성현',
      created_at: `${today}T10:18:00.000Z`
    };

    // 3. F&B 주문 (Order 2: 카페)
    const ordId2 = 'ORD-' + today.replace(/-/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);
    const item3 = {
      id: ordId2 + '_1',
      order_id: ordId2,
      site_id: SITE_ID,
      visit_id: vId,
      purchased_at: `${today}T11:15:00.000Z`,
      sales_channel: 'kiosk',
      product_id: 'PROD_FNB_JUICE',
      product_name: '봉화 사과 착즙 주스',
      product_category: 'fnb',
      quantity: 2,
      list_price: 4000,
      discount_amount: 0,
      paid_amount: 8000,
      payment_method: 'local_currency',
      staff_id: '김지현',
      created_at: `${today}T11:15:00.000Z`
    };
    const item4 = {
      id: ordId2 + '_2',
      order_id: ordId2,
      site_id: SITE_ID,
      visit_id: vId,
      purchased_at: `${today}T11:15:00.000Z`,
      sales_channel: 'kiosk',
      product_id: 'PROD_FNB_SNACK',
      product_name: '유기농 수제 쿠키팩',
      product_category: 'fnb',
      quantity: 1,
      list_price: 4000,
      discount_amount: 0,
      paid_amount: 4000,
      payment_method: 'local_currency',
      staff_id: '김지현',
      created_at: `${today}T11:15:00.000Z`
    };

    try {
      const orderItems = JSON.parse(localStorage.getItem(STORAGE_KEYS.ORDER_ITEMS) || '[]');
      orderItems.unshift(item1, item2, item3, item4);
      localStorage.setItem(STORAGE_KEYS.ORDER_ITEMS, JSON.stringify(orderItems));
      if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
        global.BongplaySync.upsert('order_items', item1);
        global.BongplaySync.upsert('order_items', item2);
        global.BongplaySync.upsert('order_items', item3);
        global.BongplaySync.upsert('order_items', item4);
      }
    } catch(e) {}

    // 4. 대기 스냅샷 (Queue Snapshots)
    recordQueueSnapshot({
      visit_id: vId,
      facility_id: 'outdoor_net',
      wait_minutes: 5,
      queue_count: 6,
      measured_at: `${today}T10:28:00.000Z`
    });
    recordQueueSnapshot({
      visit_id: vId,
      facility_id: 'outdoor_coaster',
      wait_minutes: 12,
      queue_count: 14,
      measured_at: `${today}T11:35:00.000Z`
    });

    // 5. 시설 이용 이벤트 (Facility Usages)
    recordFacilityEvent({
      visit_id: vId,
      facility_id: 'outdoor_net',
      ticket_id: item1.id,
      entered_at: `${today}T10:33:00.000Z`,
      started_at: `${today}T10:35:00.000Z`,
      completed_at: `${today}T11:03:00.000Z`,
      result: 'completed',
      operator_staff_id: '김주성'
    });
    recordFacilityEvent({
      visit_id: vId,
      facility_id: 'outdoor_coaster',
      ticket_id: item1.id,
      entered_at: `${today}T11:47:00.000Z`,
      started_at: `${today}T11:50:00.000Z`,
      completed_at: `${today}T11:58:00.000Z`,
      result: 'completed',
      operator_staff_id: '김주성'
    });

    // 6. 퇴장 10초 설문 (Survey)
    recordCustomerSurvey({
      visit_id: vId,
      household_id: hhId,
      nps_score: 9,
      satisfaction_rating: 5,
      wait_satisfaction: 4,
      revisit_intent: 'yes',
      preferred_facility: 'outdoor_coaster',
      comment: '짚코스터가 너무 스릴 넘치고 네트놀이터도 아이들이 안전하게 뛰어놀아 만족스러웠습니다. 가을에 꼭 다시 오겠습니다!',
      survey_channel: 'exit_tablet',
      created_at: `${today}T12:40:00.000Z`
    });

    return vId;
  }

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
    evaluateCoasterWeatherIntervention: evaluateCoasterWeatherIntervention,
    getOrdersByDate: getOrdersByDate,
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


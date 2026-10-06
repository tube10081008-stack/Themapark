/**
 * ============================================================
 * 리틀포레스트 봉플레이 - Bongplay ID Core Module (id-core)
 * ============================================================
 * 파일명: bongplay-id-core.js
 * 역할: FNV-1a 단방향 해싱, 11대 공통 ID 생성기, SSOT 기준정보 상수,
 *       방문 세션(Visit Session), POS 주문 원장, 가구 CRM, 직원 근무/교대
 * ============================================================
 */
(function (global) {
  'use strict';

  const BongplayID = global.BongplayID || (global.BongplayID = {});
  global.BongplayIDCore = BongplayID;
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

  const fnv1aHex = fnv1a;

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
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 8);
    return 'vst_' + ymd + '_' + rand;
  }

  function generateVisitorId(householdId, index, childName) {
    const raw = householdId + '_' + index + '_' + (childName || '');
    return 'vis_' + fnv1a(raw).slice(0, 8);
  }

  function generateBookingId(dateStr) {
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 6);
    return 'bkg_' + ymd + '_' + rand;
  }

  function generateOrderId(dateStr) {
    const ymd = getLocalYmdCompact(dateStr);
    const rand = Math.random().toString(36).slice(2, 7);
    return 'ord_' + ymd + '_' + rand;
  }

  function generateTicketId(visitId, index) {
    const cleanVisit = (visitId || '').replace(/^vst_/, '');
    const seq = String(index || 1).padStart(2, '0');
    return 'tkt_' + cleanVisit + '_' + seq;
  }

  function generateOrderItemId(orderId, index) {
    const cleanOrder = (orderId || '').replace(/^ord_/, '');
    const seq = String(index || 1).padStart(2, '0');
    return 'item_' + cleanOrder + '_' + seq;
  }

  function generateFacilityEventId() {
    return 'fev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function generateTelemetryId() {
    return 'tel_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function generateActionId() {
    return 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function generateAssetMeasurementId() {
    return 'asm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
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
    tkt_adult_guardian: { id: 'tkt_adult_guardian', name: '보호자 입장권 (웰컴 음료 1잔 포함)', category: 'ticket', list_price: 5000 },
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
      product_name: '보호자 입장권 (웰컴 음료 1잔 포함)',
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

  /* ---------- 4-1-1. 상품 폐지 여부 및 상품 정보 매핑 헬퍼 (Section 7 SSOT 연동) ---------- */
  const KNOWN_DEPRECATED_PRODUCT_IDS = ['PROD_GROUP_VOUCHER', 'PROD_CHILD_BASIC_PROMO'];

  function isDeprecatedProduct(productId, item) {
    if (item && (item.deprecated === true || item.is_active === false)) {
      return true;
    }
    if (!productId) return false;

    if (KNOWN_DEPRECATED_PRODUCT_IDS.indexOf(productId) !== -1) {
      return true;
    }

    const pProd = PRODUCTS[productId];
    if (pProd && (pProd.deprecated === true || pProd.is_active === false)) {
      return true;
    }

    const pMaster = MASTER_PRODUCTS[productId];
    if (pMaster && (pMaster.deprecated === true || pMaster.is_active === false)) {
      return true;
    }

    const pCat = PRODUCT_CATALOG.find(function (p) { return p.id === productId; });
    if (pCat && (pCat.deprecated === true || pCat.is_active === false)) {
      return true;
    }

    return false;
  }

  function resolveProduct(item) {
    if (!item) {
      return {
        id: 'custom_item',
        name: '기타 상품',
        category: 'fnb',
        list_price: 0
      };
    }

    const productId = item.product_id;
    // 1. PRODUCTS (PRODUCT_CATALOG 기반)
    const catProd = productId ? (PRODUCTS[productId] || PRODUCT_CATALOG.find(function (p) { return p.id === productId; })) : null;
    if (catProd) {
      return {
        id: catProd.id,
        name: item.product_name || catProd.name,
        category: item.product_category || catProd.category,
        list_price: Number(item.list_price != null ? item.list_price : (catProd.list_price != null ? catProd.list_price : (catProd.price || 0)))
      };
    }

    // 2. MASTER_PRODUCTS (기준정보 마스터)
    const masterProd = productId ? MASTER_PRODUCTS[productId] : null;
    if (masterProd) {
      return {
        id: masterProd.product_id,
        name: item.product_name || masterProd.product_name,
        category: item.product_category || masterProd.product_category,
        list_price: Number(item.list_price != null ? item.list_price : (masterProd.price || 0))
      };
    }

    // 3. 허용된 커스텀/기타 품목 (custom_item)
    return {
      id: productId || 'custom_item',
      name: item.product_name || '기타 상품',
      category: item.product_category || 'fnb',
      list_price: Number(item.list_price != null ? item.list_price : (item.price || 0))
    };
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

    // [사전 검증 1] 품목 배열 유무 검증
    if (itemsInput.length === 0) {
      console.warn('[createOrder] Empty items in orderParams:', orderId);
      return {
        success: false,
        error: 'EMPTY_ORDER_ITEMS',
        message: '주문 품목이 비어있습니다.',
        order_id: orderId,
        visit_id: visitId,
        items: [],
        total_amount: 0,
        total_quantity: 0
      };
    }

    // [사전 검증 2] 폐지 상품 전수 사전 검증 (All-or-Nothing 무결성 원칙)
    for (let i = 0; i < itemsInput.length; i++) {
      const item = itemsInput[i];
      const pId = item ? (item.product_id || item.id) : null;
      if (isDeprecatedProduct(pId, item)) {
        console.warn(`[createOrder] Deprecated product blocked: ${pId} in order ${orderId}`);
        return {
          success: false,
          error: 'DEPRECATED_PRODUCT_BLOCKED',
          message: `폐지된 상품(${pId || '알 수 없음'})은 신규 주문할 수 없습니다.`,
          order_id: orderId,
          visit_id: visitId,
          items: [],
          total_amount: 0,
          total_quantity: 0
        };
      }
    }

    const orderItems = [];
    itemsInput.forEach((item, idx) => {
      const prod = resolveProduct(item);
      const qty = Math.max(1, Number(item.quantity) || 1);
      const listPrice = Number(item.list_price != null ? item.list_price : (prod.list_price || 0));
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
      success: true,
      order_id: orderId,
      visit_id: visitId,
      items: orderItems,
      total_amount: orderItems.reduce((sum, it) => sum + it.paid_amount, 0),
      total_quantity: orderItems.reduce((sum, it) => sum + it.quantity, 0)
    };
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


  const MASTER_ASSETS = ASSETS;
  const MASTER_STAFF = STAFF;
  const MASTER_PRICING_RULES = {};

  Object.assign(BongplayID, {
    fnv1a,
    fnv1aHex,
    normalizePhone,
    SITE_ID,
    STORAGE_KEYS,
    MASTER_FACILITIES,
    MASTER_ASSETS,
    MASTER_STAFF,
    MASTER_PRODUCTS,
    MASTER_PRICING_RULES,
    MASTER_TARGETS,
    generateVisitId,
    generateHouseholdId,
    generateBookingId,
    generateTicketId,
    generateVisitorId,
    generateOrderId,
    generateOrderItemId,
    generateFacilityEventId,
    generateTelemetryId,
    generateActionId,
    generateAssetMeasurementId,
    createVisitSession,
    markVisitIssued,
    markVisitEntry,
    markVisitExit,
    createOrder,
    isDeprecatedProduct,
    checkIsRepeatHousehold,
    recordFacilityEvent,
    getStoredConsents,
    updateStoredConsent,
    detectCampaignId,
    updateBookingFunnel,
    saveMarketingCampaigns,
    recordMarketingCampaign,
    getCampaignAttribution,
    getMarketingCampaigns,
    /*
    endStaffShift,
    assignStaffToZone,
    recordStaffTaskDuration,
    getStaffTaskDurationLogs,
    getStaffShifts,
    */
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayID;
  }
})(typeof window !== 'undefined' ? window : global);
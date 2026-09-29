/* ============================================================
   봉플레이 현장 기준정보 (Site Profile · SSOT)
   ------------------------------------------------------------
   ※ 참고: assets/bongplay-id-core.js, bongplay-telemetry.js,
     bongplay-analytics.js, bongplay-equipment.js 는 현재 어떤 화면도
     불러오지 않는 옛 파일입니다(인명·수치가 남아 있으나 동작에 영향 없음).
     정리 시 삭제 대상입니다.
   ------------------------------------------------------------
   시설명·주소·정원·인력 명단·유관기관 연락처를 한 곳에서 관리합니다.
   값이 바뀌면 이 파일 하나만 고쳐서 배포하면 모든 화면에 반영됩니다.

   [동작 방식]
   1) 새 코드: HTML 에 data-site="경로" 를 쓰면 로딩 시 값이 채워집니다.
        <span data-site="address.road"></span>
        <a data-site-tel="partner.hospital">병원 전화</a>
   2) 기존 화면: 페이지에 박혀 있던 옛 값(전화·주소·이름)은
      LEGACY_MAP 을 통해 로딩 시 자동으로 현재 값으로 치환됩니다.
      → 페이지를 일일이 수정하지 않아도 이 파일만 바꾸면 됩니다.

   [주의]
   · 인쇄(print) 화면도 동일하게 치환됩니다.
   · 사람이 입력한 값(input/textarea)은 건드리지 않습니다.
   ============================================================ */
(function (global) {
  'use strict';

  var SITE = {
    version: '2026.09.20',

    facility: {
      name: '리틀포레스트 봉플레이',
      short_name: '봉플레이',
      operator: '리플레이스(RE:PLAYCE)',
      business_no: '',                       // 사업자등록번호 (확정 시 입력)
      legal_basis: '「어린이놀이시설 안전관리법」 제15조 및 동법 시행규칙 제16조'
    },

    address: {
      // ★ 주소는 road 한 줄만 고치면 됩니다. 나머지는 비워두면 자동 생성됩니다.
      road: '경상북도 봉화군 봉화읍 유록길 22',
      lot: '경상북도 봉화군 봉화읍 석평리 1214-22',   // 지번 (건축물대장 기준)
      road_short: '',       // 예: 봉화읍 유록길 22   (비우면 road 에서 생성)
      emergency_call: '',   // 119 신고용            (비우면 'road(경북 표기) + 시설명')
      map_query: ''         // 지도 검색어           (비우면 road)
    },

    capacity: {
      max_occupancy: 250,        // 동시 수용 정원
      comfortable: 150,          // 쾌적 기준
      caution: 200               // 혼잡 주의 기준
    },

    hours: {
      open: '10:00',
      close: '18:00',
      safety_check_deadline: '09:30',   // 개장 전 안전점검 마감 시각
      closing_window: '18:00~18:30',
      morning_ticket_until_hour: 12     // 조조권 적용 시간 (12시 이전)
    },

    // 매점(식음료·굿즈) 방문고객 할인 — POS 에서 방문 가족을 연동하면 자동 적용
    // (목적: 매점 구매를 방문 세션에 연결해 가족 단위 소비 데이터를 모음)
    store: {
      member_discount_rate: 0.10,                       // ★ 할인율 (0.10 = 10%, 0 이면 할인 없이 연동만)
      member_discount_label: '방문고객 매점 할인',
      member_discount_categories: ['fnb', 'merchandise'] // 적용 품목군 (입장권·체험권 제외)
    },

    // 시재금 (기초 준비금) 기준 설정 — 마감 시재의 기준치 (하드코딩 방지 SSOT)
    cash: {
      default_base_cash: 100000                         // 기본 개장 준비금 (시재 100,000원)
    },

    /* 현장 인력 — id 는 원장(staff_id)에 기록되는 값이므로 변경 시 주의 */
    staff: [
      {
        id: 'staff_hong', name: '홍성현', title: '대표', role: '총괄 대표 / 현장총괄',
        phone: '010-5931-4144', shift: '종일조 (09:00~19:00)',
        is_manager: true, is_inspector: true, is_safety_officer: true, default_manager: true
      },
      {
        id: 'staff_kim_js', name: '김주성', title: '매니저', role: '안전관리 매니저 / 야외 어드벤처',
        phone: '010-9135-9544', shift: '종일조 (09:00~19:00)',
        is_inspector: true, default_inspector: true
      },
      {
        id: 'staff_kim_jy', name: '김지연', title: '매니저', role: '운영 매니저 / 매표·정산·실내존',
        phone: '', shift: '종일조 (09:00~19:00)',
        is_manager: true, is_inspector: true
      },
      {
        id: 'staff_park', name: '박기원', title: '요원', role: '현장 안전요원',
        phone: '', shift: '교대조', is_inspector: true
      },
      {
        id: 'staff_lee', name: '이서준', title: '요원', role: '현장 운영요원',
        phone: '', shift: '교대조', is_inspector: true
      },
      {
        id: 'staff_coach', name: '안전코치(알바)', title: '', role: '짚라인 출발·도착 안전보조',
        phone: '', shift: '오후조 (13:30~19:00)'
      }
    ],

    /* 유관기관 · 비상 연락처 */
    partners: {
      fire:       { name: '봉화119안전센터', phone: '119', alt_phone: '054-670-5119', note: '소방·구급' },
      police:     { name: '봉화경찰서',      phone: '112', alt_phone: '054-672-0112', note: '경찰' },
      hospital:   { name: '봉화해성병원',    phone: '054-679-1299', note: '지정 후송 병원' },
      county:     { name: '봉화군청 문화관광과 관광개발팀', contact: '조은정 주무관', phone: '054-679-6355', note: '인허가·보고' },
      county_main:{ name: '봉화군청 대표전화', phone: '054-679-6114', note: '대표번호' },
      insurance:  { name: '영업배상책임보험 사고접수', phone: '1577-1999', note: '보험 접수' },
      kepco:      { name: '한국전력 고장신고', phone: '123', note: '정전' },
      water:      { name: '상수도 사업소', phone: '054-679-6114', note: '단수·누수' }
    },

    /* 데모/샘플 데이터 생성 여부
       true  : 장비 목록 등에 예시 데이터를 자동 생성 (시연·교육용)
       false : 실제 등록한 자료만 사용 (운영 기본값) */
    demo_data: false
  };

  /* ---------- 조회 헬퍼 ---------- */
  function get(path, fallback) {
    try {
      return path.split('.').reduce(function (o, k) { return o[k]; }, SITE);
    } catch (e) {
      return fallback !== undefined ? fallback : '';
    }
  }

  function staffList(filter) {
    var list = SITE.staff.slice();
    if (filter === 'inspector') list = list.filter(function (s) { return s.is_inspector; });
    if (filter === 'manager') list = list.filter(function (s) { return s.is_manager; });
    return list;
  }

  function byId(id) {
    return SITE.staff.find(function (s) { return s.id === id; }) || null;
  }

  function findStaff(nameOrId) {
    if (!nameOrId) return null;
    var key = String(nameOrId).trim();
    return SITE.staff.find(function (s) { return s.name === key || s.id === key; }) || null;
  }

  function staffIdByName(name, fallbackId) {
    var s = findStaff(name);
    return s ? s.id : (fallbackId || 'staff_etc');
  }

  function defaultInspector() {
    return SITE.staff.find(function (s) { return s.default_inspector; }) || staffList('inspector')[0] || SITE.staff[0];
  }

  function defaultManager() {
    return SITE.staff.find(function (s) { return s.default_manager; }) || staffList('manager')[0] || SITE.staff[0];
  }

  function partner(key) { return SITE.partners[key] || null; }

  function defaultBaseCash() {
    var c = SITE.cash || {};
    return typeof c.default_base_cash === 'number' ? c.default_base_cash : 100000;
  }

  // 정원 기준값 정합성 보정: 정원을 줄였을 때 '주의/쾌적' 기준이 정원을 넘지 않도록
  function capacity() {
    var c = SITE.capacity || {};
    var max = Number(c.max_occupancy) || 0;
    var caution = Number(c.caution) || 0;
    var comfortable = Number(c.comfortable) || 0;
    if (!max) return { max_occupancy: 0, caution: 0, comfortable: 0 };
    if (!caution || caution >= max) caution = Math.round(max * 0.8);
    if (!comfortable || comfortable >= caution) comfortable = Math.round(max * 0.6);
    return { max_occupancy: max, caution: caution, comfortable: comfortable };
  }

  function digits(phone) { return String(phone || '').replace(/[^0-9]/g, ''); }

  /* ---------- 구버전 하드코딩 값 → 현재 값 매핑 ----------
     기존 화면에 그대로 적혀 있던 값들을 로딩 시 현재 설정으로 치환합니다.
     (옛 값 문자열은 "찾을 대상"일 뿐이며, 오른쪽 값이 실제 출력됩니다) */
  function legacyMap() {
    var hong = byId('staff_hong') || {};
    var js = byId('staff_kim_js') || {};

    // 인력 이름: 화면에 박혀 있던 옛 이름 → 현재 명단의 이름
    // (담당자가 바뀌면 staff 의 name 만 고치면 모든 화면 텍스트가 따라 바뀝니다)
    var namePairs = [
      ['홍성현', 'staff_hong'],
      ['김주성', 'staff_kim_js'],
      ['김지연', 'staff_kim_jy'],
      ['박기원', 'staff_park'],
      ['이서준', 'staff_lee']
    ].map(function (p) {
      var s = byId(p[1]);
      return s ? [p[0], s.name] : null;
    }).filter(Boolean);

    var county = SITE.partners.county || {};
    if (county.contact) namePairs.push(['조은정 주무관', county.contact]);

    // 주소: 표기 형태별로 현재 값에서 파생 (조각 치환이 겹쳐 '봉화군'이 사라지던 문제 방지)
    var road = get('address.road');                                  // 경상북도 봉화군 봉화읍 유록길 22
    var roadProvinceShort = road.replace(/^경상북도/, '경북');        // 경북 봉화군 …
    var roadNoProvince = road.replace(/^(경상북도|경북)\s*/, '');      // 봉화군 봉화읍 …
    var roadShort = get('address.road_short');                        // 봉화읍 유록길 22

    return namePairs.concat([
      // 주소 (긴 표기부터 — 실제 치환은 단일 패스로 1회만 적용됨)
      ['경상북도 봉화군 봉화읍 유록길 22', road],
      ['경북 봉화군 봉화읍 유록길 22',     roadProvinceShort],
      ['봉화군 봉화읍 유록길 22',          roadNoProvince],
      ['봉화읍 유록길 22',                 roadShort],
      // 연락처
      ['010-5931-4144', hong.phone || ''],
      ['010-9135-9544', js.phone || ''],
      ['054-679-1299',  get('partners.hospital.phone')],
      ['054-679-6355',  get('partners.county.phone')],
      ['054-672-0112',  get('partners.police.alt_phone')],
      ['054-670-5119',  get('partners.fire.alt_phone')],
      ['1577-1999',     get('partners.insurance.phone')]
    ]).filter(function (pair) { return pair[1] && pair[0] !== pair[1]; });
  }

  /* ---------- DOM 바인딩 ---------- */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, CODE: 1, PRE: 1 };

  function applyAttributeBindings(root) {
    root = root || document;

    // <span data-site="address.road"></span>
    root.querySelectorAll('[data-site]').forEach(function (el) {
      var val = get(el.getAttribute('data-site'));
      if (val !== '' && val !== undefined && val !== null) el.textContent = val;
    });

    // <a data-site-tel="partner.hospital">  → href="tel:..." + 번호 표기
    root.querySelectorAll('[data-site-tel]').forEach(function (el) {
      var key = el.getAttribute('data-site-tel');
      var p = partner(key) || findStaff(key);
      if (!p) return;
      var phone = p.phone || p.alt_phone || '';
      if (!phone) return;
      el.setAttribute('href', 'tel:' + digits(phone));
      if (el.hasAttribute('data-site-tel-label')) el.textContent = phone;
    });
  }

  function applyLegacyReplacements(root) {
    var pairs = legacyMap();
    if (!pairs.length) return 0;
    root = root || document.body;
    if (!root) return 0;

    var replaced = 0;

    // 1) 텍스트 노드 치환
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentNode;
        if (!p || SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    // 단일 패스 치환기: 긴 문자열 우선으로 한 번만 매칭 (치환 결과가 다시 치환되는 연쇄 방지)
    var dict = {};
    var keys = [];
    pairs.forEach(function (pair) {
      if (!dict[pair[0]]) { dict[pair[0]] = pair[1]; keys.push(pair[0]); }
    });
    keys.sort(function (a, b) { return b.length - a.length; });
    var re = new RegExp(keys.map(function (k) {
      return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|'), 'g');

    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue;
      var next = text.replace(re, function (m) { return dict[m] !== undefined ? dict[m] : m; });
      if (next !== text) { node.nodeValue = next; replaced++; }
    }

    // 2) tel: 링크 치환 — 'tel:010-5931-4144' / 'tel:01059314144' 두 표기 모두 처리
    root.querySelectorAll('a[href^="tel:"]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var hrefDigits = digits(href);
      pairs.forEach(function (pair) {
        var from = digits(pair[0]);
        var to = digits(pair[1]);
        if (!from || !to || from === to) return;
        if (hrefDigits === from) {           // 번호 전체가 일치할 때만 교체 (부분 일치 오작동 방지)
          a.setAttribute('href', 'tel:' + to);
          hrefDigits = to;
          replaced++;
        }
      });
    });

    return replaced;
  }

  function applyAll(root) {
    try {
      applyAttributeBindings(root);
      applyLegacyReplacements(root);
    } catch (e) {
      console.warn('[BongplaySite] 바인딩 오류:', e);
    }
  }

  /* ---------- 배포별 덮어쓰기 ----------
     config.js 에서 window.BONGPLAY_CONFIG.SITE 로 일부 값만 덮어쓸 수 있습니다.
     (예: 시범운영 기간에 정원만 다르게 두는 경우) */
  function mergeOverrides() {
    var ov = global.BONGPLAY_CONFIG && global.BONGPLAY_CONFIG.SITE;
    if (!ov) return;
    Object.keys(ov).forEach(function (k) {
      if (ov[k] && typeof ov[k] === 'object' && !Array.isArray(ov[k]) && SITE[k]) {
        Object.assign(SITE[k], ov[k]);
      } else {
        SITE[k] = ov[k];
      }
    });
  }

  /* 주소 파생값 자동 생성 — road 한 곳만 고치면 나머지 표기가 따라옵니다.
     (예전에는 짧은 주소·119 신고 주소를 따로 고쳐야 해서 표기가 어긋났습니다) */
  function normalizeAddress() {
    var a = SITE.address || (SITE.address = {});
    var road = a.road || '';
    if (!road) return;
    if (!a.road_short) {
      // 시·도 + 시·군·구 를 제외한 나머지 (예: 봉화읍 유록길 22)
      a.road_short = road.replace(/^\S+(도|시)\s+/, '').replace(/^\S+(시|군|구)\s+/, '');
    }
    if (!a.emergency_call) {
      a.emergency_call = road.replace(/^경상북도/, '경북') +
        (SITE.facility && SITE.facility.short_name ? ' (' + SITE.facility.short_name + ')' : '');
    }
    if (!a.map_query) a.map_query = road;
  }

  mergeOverrides();
  normalizeAddress();

  global.BONGPLAY_SITE = SITE;
  global.BongplaySite = {
    data: SITE,
    get: get,
    staff: staffList,
    findStaff: findStaff,
    staffIdByName: staffIdByName,
    defaultInspector: defaultInspector,
    defaultManager: defaultManager,
    defaultBaseCash: defaultBaseCash,
    partner: partner,
    capacity: capacity,
    digits: digits,
    apply: applyAll,
    applyLegacyReplacements: applyLegacyReplacements
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyAll(); });
    } else {
      applyAll();
    }
    // 인쇄 직전에도 한 번 더 (동적으로 생성된 기록부 내용 반영)
    global.addEventListener('beforeprint', function () { applyAll(); });
  }
})(window);

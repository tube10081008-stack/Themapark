(function (global) {
  'use strict';

  const BongplayID = global.BongplayID || (global.BongplayID = {});
  const STORAGE_KEYS = BongplayID.STORAGE_KEYS || {
    SPATIAL_ZONE_TELEMETRY: 'bongplay_spatial_zone_telemetry',
    WEATHER_TELEMETRY: 'bongplay_weather_telemetry',
    QUEUE_SNAPSHOTS: 'bongplay_queue_snapshots',
    TELEMETRY: 'bongplay_queue_telemetry',
    SENSOR_READINGS: 'bongplay_sensor_readings'
  };
  const SITE_ID = BongplayID.SITE_ID || 'bongplay_bonghwa';

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


  function recordSensorReading(data) {
    const d = data || {};
    const reading = {
      id: 'snr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: SITE_ID,
      asset_id: d.asset_id || 'zip_trolley_01',
      sensor_type: d.sensor_type || 'vibration',
      metric_value: Number(d.metric_value !== undefined ? d.metric_value : 0),
      unit: d.unit || 'g',
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

  function getSensorReadings(assetId, sensorType, limit) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SENSOR_READINGS);
      const list = raw ? JSON.parse(raw) : [];
      let filtered = list;
      if (assetId) filtered = filtered.filter(item => item.asset_id === assetId);
      if (sensorType) filtered = filtered.filter(item => item.sensor_type === sensorType);
      return filtered.slice(0, limit || 50);
    } catch (e) {
      return [];
    }
  }

  Object.assign(BongplayID, {
    SPATIAL_ZONES,
    recordQueueSnapshot,
    getQueueSnapshots,
    recordQueueTelemetry,
    getQueueTelemetry,
    recordWeatherTelemetry,
    getWeatherTelemetry,
    getLatestWeather,
    analyzeWeatherOperationRisk,
    recordSpatialZoneTelemetry,
    getSpatialZoneTelemetry,
    getLatestSpatialState,
    recordSensorReading,
    getSensorReadings
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayID;
  }
})(typeof window !== 'undefined' ? window : global);
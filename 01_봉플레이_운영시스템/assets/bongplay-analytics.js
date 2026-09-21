(function (global) {
  'use strict';

  const BongplayID = global.BongplayID || (global.BongplayID = {});
  const STORAGE_KEYS = BongplayID.STORAGE_KEYS || {
    ACTION_LOGS: 'bongplay_operator_action_logs',
    CONSENTS: 'bongplay_safety_consents',
    LEGACY_CONSENTS: 'bongtteurak_consents_v1',
    ORDER_ITEMS: 'bongplay_order_items_ledger',
    FACILITY_EVENTS: 'bongplay_facility_usage_events',
    QUEUE_SNAPSHOTS: 'bongplay_queue_snapshots',
    SURVEYS: 'bongplay_customer_surveys',
    INCIDENTS: 'bongplay_incident_logs',
    COMPLAINTS: 'bongtteurak_complaint_records_v1',
    CAMPAIGNS: 'bongplay_marketing_campaigns',
    STAFF_SHIFTS: 'bongplay_staff_shifts',
    STAFF_ASSIGNMENTS: 'bongplay_staff_assignments',
    STAFF_TASKS: 'bongplay_staff_tasks',
    WEATHER_TELEMETRY: 'bongplay_weather_telemetry',
    SPATIAL_ZONE_TELEMETRY: 'bongplay_spatial_zone_telemetry',
    SENSOR_READINGS: 'bongplay_sensor_readings',
    MAINTENANCE_LOGS: 'bongplay_asset_maintenance_logs',
    USAGE_COUNTERS: 'bongplay_asset_usage_counters',
    ASSET_MEASUREMENTS: 'bongplay_asset_measurements',
    EQUIPMENT_ASSETS: 'bongplay_equipment_assets',
    FACILITY_INTERVALS: 'bongplay_facility_intervals'
  };
  const SITE_ID = BongplayID.SITE_ID || 'bongplay_bonghwa';

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
    a.location = a.location || '야외 짚라인 어드벤처';
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
        if (list.length > 0) return list.slice(0, lim);
      }
    } catch (e) {}

    const now = Date.now();
    const defaults = [];
    for (let i = 0; i < lim; i++) {
      const t = new Date(now - i * 10 * 60 * 1000);
      const windSpeed = +(2.0 + Math.sin(i * 0.3) * 1.8 + (i % 3) * 0.4).toFixed(1);
      const gust = +(windSpeed * 1.4 + (i % 2) * 0.5).toFixed(1);
      defaults.push({
        id: 'wtr_seed_' + i,
        observed_at: t.toISOString(),
        temperature: +(20.5 + Math.cos(i * 0.2) * 2.2).toFixed(1),
        humidity: Math.round(52 + Math.sin(i * 0.25) * 8),
        rainfall: 0.0,
        wind_speed: windSpeed,
        wind_gust: gust,
        wind_direction: ['NW', 'NNW', 'W', 'WNW'][i % 4],
        visibility: 15000,
        snow_depth: 0.0,
        weather_warning: gust >= 12.0 ? 'strong_wind_watch' : 'none',
        indoor_temperature: 22.5,
        indoor_humidity: 48,
        created_at: t.toISOString()
      });
    }
    try {
      localStorage.setItem(STORAGE_KEYS.WEATHER_TELEMETRY, JSON.stringify(defaults));
    } catch (e) {}
    return defaults;
  }

  function getLatestWeather() {
    const list = getWeatherTelemetry(1);
    return list && list.length > 0 ? list[0] : {
      observed_at: new Date().toISOString(),
      temperature: 21.0,
      humidity: 50,
      rainfall: 0.0,
      wind_speed: 3.5,
      wind_gust: 5.2,
      wind_direction: 'NW',
      visibility: 15000,
      snow_depth: 0.0,
      weather_warning: 'none',
      indoor_temperature: 22.5,
      indoor_humidity: 48
    };
  }

  function evaluateCoasterWeatherIntervention(weather) {
    const w = weather || getLatestWeather();
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


  /* 6. AI 백엔드 (FastAPI 3-Layer) 연동 브릿지 */
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

  const exportAiTrainingEpisodes = exportAiCausalDataset;

  Object.assign(BongplayID, {
    recordOperatorAction,
    getOperatorActionLogs,
    getMasterConfig,
    calculateOperationalTargets,
    calculateDailyTargetProgress,
    getVisitFullJourney,
    getAllVisitsSummary,
    createSimulatedFullJourney,
    exportAiCausalDataset,
    exportAiTrainingEpisodes,
    downloadAiCausalJson,
    requestAiActionRecommendation
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayID;
  }
})(typeof window !== 'undefined' ? window : global);
(function (global) {
  'use strict';

  const BongplayID = global.BongplayID || (global.BongplayID = {});
  const STORAGE_KEYS = BongplayID.STORAGE_KEYS || {
    ASSET_MEASUREMENTS: 'bongplay_asset_measurements',
    EQUIPMENT_ASSETS: 'bongplay_equipment_assets',
    FACILITY_INTERVALS: 'bongplay_facility_intervals',
    MAINTENANCE_LOGS: 'bongplay_asset_maintenance_logs',
    USAGE_COUNTERS: 'bongplay_asset_usage_counters'
  };
  const SITE_ID = BongplayID.SITE_ID || 'bongplay_bonghwa';
  const generateAssetMeasurementId = BongplayID.generateAssetMeasurementId || function (assetId) {
    return 'msr_' + (assetId || 'gen') + '_' + Date.now().toString(36);
  };

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


  function recordAssetMaintenance(data) {
    const d = data || {};
    const log = {
      id: 'mnt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      site_id: SITE_ID,
      asset_id: d.asset_id || 'zip_wire_main',
      maintenance_type: d.maintenance_type || 'inspection',
      performed_at: d.performed_at || new Date().toISOString(),
      performed_by: d.performed_by || '?띿꽦??,
      action_details: d.action_details || '?뺢린 ?덉쟾 ?먭? 諛??ㅽ솢???꾪룷',
      replaced_parts: d.replaced_parts || [],
      cost: Number(d.cost || 0),
      downtime_minutes: Number(d.downtime_minutes || 0)
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.MAINTENANCE_LOGS) || '[]';
      const list = JSON.parse(raw);
      list.unshift(log);
      if (list.length > 300) list.length = 300;
      localStorage.setItem(STORAGE_KEYS.MAINTENANCE_LOGS, JSON.stringify(list));
    } catch (e) {}

    if (global.BongplaySync && typeof global.BongplaySync.upsert === 'function') {
      global.BongplaySync.upsert('asset_maintenance_logs', log);
    }
    return log;
  }

  function getMaintenanceLogs(assetId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.MAINTENANCE_LOGS);
      const list = raw ? JSON.parse(raw) : [];
      return assetId ? list.filter(item => item.asset_id === assetId) : list;
    } catch (e) {
      return [];
    }
  }

  function getAssetUsageCounters(assetId) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.USAGE_COUNTERS);
      const counters = raw ? JSON.parse(raw) : {};
      return assetId ? (counters[assetId] || null) : counters;
    } catch (e) {
      return assetId ? null : {};
    }
  }

  Object.assign(BongplayID, {
    INITIAL_EQUIPMENT_ASSETS,
    recordAssetMeasurement,
    getAssetMeasurements,
    getEquipmentAssets,
    saveEquipmentAssets,
    addEquipmentAsset,
    updateEquipmentAsset,
    deleteEquipmentAsset,
    updateEquipmentUsage,
    incrementAssetUsage,
    incrementFacilityEquipmentUsage,
    getPredictiveMaintenanceAlerts,
    recordEquipmentMaintenance,
    recordAssetMaintenance,
    getMaintenanceLogs,
    getAssetUsageCounters,
    analyzeAssetLifecycleHealth,
    changeFacilityOperatingStatus,
    getCurrentFacilityOperatingStatus,
    getFacilityOperatingIntervals
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayID;
  }
})(typeof window !== 'undefined' ? window : global);
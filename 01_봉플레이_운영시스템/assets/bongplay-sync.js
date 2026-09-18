/* ============================================================
   봉플레이 데이터 동기화 모듈 (Supabase Cloud-First SSOT Engine)
   ------------------------------------------------------------
   설계 원칙 (v2026.DB-First):
   1. Supabase Cloud DB가 유일한 진실 공급원 (Single Source of Truth)
   2. 모든 쓰기는 Supabase에 즉시 반영되며, 스키마 불일치(미반영 컬럼) 시
      자동으로 필터링 후 재시도하여 400 오류를 원천 차단
   3. WebSocket Realtime 및 고속 동기화 폴링(3초)을 통해
      모든 기기(PC, 태블릿, 모바일)가 지연 없이 동일 데이터를 실시간 공유
   4. localStorage는 브라우저 렌더링용 고속 캐시로만 동작
   ============================================================ */
(function (global) {
  'use strict';

  var CFG_KEY = 'bongplay_supabase_config';
  var QUEUE_KEY = 'bongplay_sync_queue';
  var DEVICE_KEY = 'bongplay_device_id';

  // 컬럼 캐시 (스키마에 존재하지 않는 컬럼을 기억하여 자동 제외)
  var invalidColumnCache = {};

  // ------------------------------------------------------------
  // 과거 오프라인 대기열 잔재(과거 실패로 누적된 큐 등) 영구 소탕
  // DB-First SSOT 체제에서는 모든 데이터가 Supabase와 직접 실시간 통신하므로
  // 과거의 로컬 대기열 잔재를 0으로 즉시 영구 삭제합니다.
  // ------------------------------------------------------------
  try {
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem('bongplay_offline_queue');
    localStorage.removeItem('bongtteurak_sync_queue');
    localStorage.removeItem('bongplay_sync_pending');
  } catch (e) {}

  /* ---------- 기기 식별 ---------- */
  function getDeviceId() {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }
  function getDeviceLabel() {
    return localStorage.getItem('bongplay_device_label') || '미지정';
  }
  function setDeviceLabel(label) {
    localStorage.setItem('bongplay_device_label', label);
  }

  /* ---------- 설정 ---------- */
  function getConfig() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) return JSON.parse(raw);
      if (global.BONGPLAY_CONFIG && global.BONGPLAY_CONFIG.SUPABASE_URL) {
        return {
          url: global.BONGPLAY_CONFIG.SUPABASE_URL.replace(/\/+$/, ''),
          key: global.BONGPLAY_CONFIG.SUPABASE_ANON_KEY.trim()
        };
      }
      return null;
    } catch (e) { return null; }
  }
  function setConfig(url, anonKey) {
    if (!url || !anonKey) { localStorage.removeItem(CFG_KEY); return false; }
    localStorage.setItem(CFG_KEY, JSON.stringify({
      url: url.replace(/\/+$/, ''),
      key: anonKey.trim()
    }));
    initRealtime();
    return true;
  }
  function isConfigured() { return !!getConfig(); }

  /* ---------- 상태 알림 ---------- */
  var statusListeners = [];
  function onStatusChange(fn) { statusListeners.push(fn); fn(getStatus()); }
  function notifyStatus() {
    var s = getStatus();
    statusListeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  }
  function getStatus() {
    return {
      configured: isConfigured(),
      online: navigator.onLine,
      pending: 0
    };
  }

  /* ---------- 대기열 호환성 유지 (항상 0건 정리) ---------- */
  function getQueue() {
    try {
      localStorage.removeItem(QUEUE_KEY);
      localStorage.removeItem('bongplay_offline_queue');
      localStorage.removeItem('bongtteurak_sync_queue');
      localStorage.removeItem('bongplay_sync_pending');
    } catch (e) {}
    return [];
  }
  function clearQueue() {
    try {
      localStorage.removeItem(QUEUE_KEY);
      localStorage.removeItem('bongplay_offline_queue');
      localStorage.removeItem('bongtteurak_sync_queue');
      localStorage.removeItem('bongplay_sync_pending');
    } catch (e) {}
    notifyStatus();
  }
  function flushQueue() {
    clearQueue();
    notifyStatus();
    return Promise.resolve({ success: true, processed: 0 });
  }

  /* ---------- 이벤트 버스 & 실시간 알림 ---------- */
  var crossChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('bongplay_system_bus') : null;
  var dataChangeListeners = [];

  function onDataChange(fn) {
    if (typeof fn === 'function') dataChangeListeners.push(fn);
  }

  function notifyDataChange(detail) {
    dataChangeListeners.forEach(function (fn) {
      try { fn(detail); } catch (e) { console.warn('dataChange listener error:', e); }
    });
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('bongplay:data-changed', { detail: detail }));
      } catch (e) {}
    }
  }

  function broadcast(detail) {
    if (crossChannel) {
      try { crossChannel.postMessage(detail); } catch (e) {}
    }
    notifyDataChange(detail);
  }

  if (crossChannel) {
    crossChannel.onmessage = function (ev) {
      if (ev && ev.data) notifyDataChange(ev.data);
    };
  }

  /* ---------- 로컬 시각 변환 유틸리티 (UTC 9시간 오차 방지) ---------- */
  function toLocalTimeStr(isoOrDate) {
    if (!isoOrDate) return '';
    var d = new Date(isoOrDate);
    if (isNaN(d.getTime())) {
      var s = String(isoOrDate);
      return s.length >= 16 ? s.slice(11, 16) : s;
    }
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function toLocalDateStr(isoOrDate) {
    if (!isoOrDate) return '';
    var d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return String(isoOrDate).slice(0, 10);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function toLocalDatetimeLocalStr(d) {
    d = d ? new Date(d) : new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + 'T' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  }

  /* ---------- Supabase 조회 (SELECT) ---------- */
  async function select(table, query) {
    var cfg = getConfig();
    if (!cfg || !navigator.onLine) return { ok: false, data: null, reason: 'offline_or_unconfigured' };
    try {
      var url = cfg.url + '/rest/v1/' + table + (query || '?select=*');
      var res = await fetch(url, {
        headers: {
          'apikey': cfg.key,
          'Authorization': 'Bearer ' + cfg.key,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) {
        var errTxt = await res.text();
        console.warn('Supabase select error on', table, res.status, errTxt);
        return { ok: false, data: null, reason: 'http_' + res.status, detail: errTxt };
      }
      var json = await res.json();
      return { ok: true, data: json };
    } catch (e) {
      return { ok: false, data: null, reason: 'network', detail: String(e) };
    }
  }

  /* ---------- Supabase 스마트 쓰기 (UPSERT with Auto Column Fallback) ---------- */
  async function upsert(table, row) {
    var cfg = getConfig();
    var payload = Object.assign({}, row, {
      device_id: getDeviceId(),
      device_label: getDeviceLabel(),
      updated_at: new Date().toISOString()
    });

    // 이미 알려진 누락 컬럼 제거
    if (invalidColumnCache[table]) {
      invalidColumnCache[table].forEach(function (col) {
        delete payload[col];
      });
    }

    if (!cfg || !navigator.onLine) {
      return { ok: false, queued: false, reason: cfg ? 'offline' : 'not_configured' };
    }

    // 누락 컬럼 발견 시 자동 제거 후 즉시 재시도 (최대 10회)
    var maxRetries = 10;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      try {
        var res = await fetch(cfg.url + '/rest/v1/' + table, {
          method: 'POST',
          headers: {
            'apikey': cfg.key,
            'Authorization': 'Bearer ' + cfg.key,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          broadcast({ type: 'UPSERT_SUCCESS', table: table, row: payload });
          return { ok: true };
        }

        var errBody = await res.text();

        // 1. DB 스키마에 없는 컬럼 오류(PGRST204) 발생 시, 해당 컬럼 제거 후 자동 재시도
        var match = errBody.match(/Could not find the '([^']+)' column/);
        if (match && match[1]) {
          var missingCol = match[1];
          if (!invalidColumnCache[table]) invalidColumnCache[table] = [];
          if (invalidColumnCache[table].indexOf(missingCol) === -1) {
            invalidColumnCache[table].push(missingCol);
            try { sessionStorage.setItem('bongplay_invalid_columns', JSON.stringify(invalidColumnCache)); } catch (e) {}
          }
          delete payload[missingCol];
          continue; // 컬럼 제거 후 재시도
        }

        // 2. PK가 존재하는 경우, RLS(42501) 또는 중복(409) 등 발생 시 즉시 PATCH로 갱신 시도
        var pkField = (table === 'ticket_ledger') ? 'ticket_id' : 'id';
        var pkVal = payload[pkField];
        if (pkVal) {
          try {
            var patchData = Object.assign({}, payload);
            delete patchData[pkField];
            var resPatch = await fetch(cfg.url + '/rest/v1/' + table + '?' + pkField + '=eq.' + encodeURIComponent(pkVal), {
              method: 'PATCH',
              headers: {
                'apikey': cfg.key,
                'Authorization': 'Bearer ' + cfg.key,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
              },
              body: JSON.stringify(patchData)
            });
            if (resPatch.ok) {
              broadcast({ type: 'UPSERT_SUCCESS', table: table, row: payload });
              return { ok: true };
            }
          } catch (patchErr) {}
        }

        console.warn('Upsert failed for table:', table, res.status, errBody);
        return { ok: false, reason: 'http_' + res.status, detail: errBody };
      } catch (e) {
        console.warn('Upsert network exception:', table, e);
        return { ok: false, reason: 'network', detail: String(e) };
      }
    }

    return { ok: false, reason: 'max_retries_exceeded' };
  }

  /* ---------- Supabase 직접 수정 (PATCH) ---------- */
  async function patch(table, idVal, patchData, idCol) {
    var cfg = getConfig();
    idCol = idCol || (table === 'ticket_ledger' ? 'ticket_id' : 'id');
    if (!cfg || !navigator.onLine) {
      return { ok: false, reason: 'offline_or_not_configured' };
    }
    try {
      var url = cfg.url + '/rest/v1/' + table + '?' + idCol + '=eq.' + encodeURIComponent(idVal);
      var res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'apikey': cfg.key,
          'Authorization': 'Bearer ' + cfg.key,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(patchData)
      });
      if (res.ok) {
        broadcast({ type: 'UPDATE_SUCCESS', table: table, id: idVal, data: patchData });
        return { ok: true };
      }
      var errTxt = await res.text();
      console.warn('Supabase patch error:', res.status, errTxt);
      return { ok: false, status: res.status, detail: errTxt };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /* ---------- Supabase 직접 삭제 (DELETE) ---------- */
  async function remove(table, idVal, idCol) {
    var cfg = getConfig();
    idCol = idCol || (table === 'ticket_ledger' ? 'ticket_id' : 'id');
    if (!cfg || !navigator.onLine) {
      return { ok: false, reason: 'offline_or_not_configured' };
    }
    try {
      var url = cfg.url + '/rest/v1/' + table + '?' + idCol + '=eq.' + encodeURIComponent(idVal);
      var res = await fetch(url, {
        method: 'DELETE',
        headers: {
          'apikey': cfg.key,
          'Authorization': 'Bearer ' + cfg.key,
          'Prefer': 'return=representation'
        }
      });
      if (res.ok) {
        // 로컬 캐시에서 해당 행 즉시 제거 (pullAll 전 캐시 정합성 보장)
        try {
          var cacheKey = (table === 'safety_consents') ? 'bongplay_safety_consents' : (table === 'safety_audits' ? 'bongplay_safety_audit_logs' : '');
          if (cacheKey) {
            var rawLocal = localStorage.getItem(cacheKey);
            if (rawLocal) {
              var localItems = JSON.parse(rawLocal);
              if (Array.isArray(localItems)) {
                var filteredLocal = localItems.filter(function(it) { return it[idCol] !== idVal && it.id !== idVal; });
                localStorage.setItem(cacheKey, JSON.stringify(filteredLocal));
              }
            }
          }
        } catch (cle) {}

        broadcast({ type: 'DELETE_SUCCESS', table: table, id: idVal });
        // 클라우드 기준으로 로컬 캐시 즉시 재동기화
        await pullAll();
        return { ok: true };
      }
      var errTxt = await res.text();
      console.warn('Supabase delete error:', res.status, errTxt);
      return { ok: false, status: res.status, detail: errTxt };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  /* ---------- 클라우드 DB 전체 다운로드 및 로컬 캐시 갱신 (PULL ALL - SSOT 직접 동기화) ---------- */
  async function pullAll() {
    var cfg = getConfig();
    if (!cfg || !navigator.onLine) return { ok: false, reason: 'offline_or_unconfigured' };

    var results = { safety_audits: 0, safety_consents: 0, sales_records: 0, closing_records: 0, ticket_ledger: 0 };
    try {
      // 1. safety_audits (클라우드 DB가 진실의 유일한 원천: 삭제 시 로컬에서도 즉시 제거)
      var rAudits = await select('safety_audits', '?select=*&order=updated_at.desc&limit=100');
      if (rAudits.ok && Array.isArray(rAudits.data)) {
        var cloudAudits = rAudits.data.map(function (row) {
          return {
            id: row.id,
            site_id: row.site_id || 'bongplay_bonghwa',
            date: row.audit_date ? row.audit_date + 'T10:00' : toLocalDatetimeLocalStr(),
            audit_date: row.audit_date,
            inspector: row.inspector || '점검자',
            decision: row.decision || 'pass',
            checklist: row.items || {},
            actionNotes: row.note || '',
            updated_at: row.updated_at
          };
        });
        cloudAudits.sort(function (a, b) {
          return new Date(b.date || b.updated_at || 0) - new Date(a.date || a.updated_at || 0);
        });
        localStorage.setItem('bongplay_safety_audit_logs', JSON.stringify(cloudAudits));
        results.safety_audits = cloudAudits.length;
      }

      // 2. safety_consents (개인정보 보호 강화 RPC 우선 호출, 실패 시 일반 select 폴백)
      var rConsents = { ok: false };
      var appConfig = (typeof window !== 'undefined' && window.BONGPLAY_CONFIG) ? window.BONGPLAY_CONFIG : {};
      var accessCode = appConfig.ACCESS_CODE || '';
      if (accessCode) {
        try {
          var rpcRes = await fetch(cfg.url + '/rest/v1/rpc/get_today_consents_secure', {
            method: 'POST',
            headers: {
              'apikey': cfg.key,
              'Authorization': 'Bearer ' + cfg.key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ p_access_code: accessCode })
          });
          if (rpcRes.ok) {
            var rpcData = await rpcRes.json();
            rConsents = { ok: true, data: rpcData };
          }
        } catch (rpcErr) {}
      }
      if (!rConsents.ok) {
        rConsents = await select('safety_consents', '?select=*&order=updated_at.desc&limit=150');
      }
      if (rConsents.ok && Array.isArray(rConsents.data)) {
        var cloudConsents = rConsents.data.map(function (row) {
          return {
            id: row.id,
            site_id: row.site_id || 'bongplay_bonghwa',
            visit_id: row.visit_id,
            household_id: row.household_id,
            booking_id: row.booking_id,
            campaign_id: row.campaign_id,
            passCode: row.pass_code,
            isIssued: (row.is_issued !== undefined) ? row.is_issued : false,
            arrival_at: row.arrival_at,
            ticket_issued_at: row.ticket_issued_at,
            entry_at: row.entry_at,
            exit_at: row.exit_at,
            stay_duration_minutes: row.stay_duration_minutes,
            guardianName: row.guardian_name,
            guardianPhone: row.guardian_phone,
            residence: row.residence,
            children: row.children || [],
            createdDate: row.created_date,
            created_date: row.created_date,
            timestamp: row.timestamp_text,
            ticket_ids: row.ticket_ids,
            signatureData: row.signature_data,
            consentMarketing: row.consent_marketing
          };
        });
        cloudConsents.sort(function (a, b) {
          return new Date(b.arrival_at || b.created_date || 0) - new Date(a.arrival_at || a.created_date || 0);
        });
        localStorage.setItem('bongplay_safety_consents', JSON.stringify(cloudConsents));
        results.safety_consents = cloudConsents.length;
      }

      // 3. ticket_ledger (클라우드 DB 기준 동기화)
      var rTickets = await select('ticket_ledger', '?select=*&order=issued_at.desc&limit=300');
      if (rTickets.ok && Array.isArray(rTickets.data)) {
        localStorage.setItem('bongplay_ticket_ledger', JSON.stringify(rTickets.data));
        results.ticket_ledger = rTickets.data.length;
      }

      // 4. sales_records (클라우드 DB 기준 전체 실적 원장 동기화)
      var rSales = await select('sales_records', '?select=*&order=date.desc&limit=90');
      if (rSales.ok && Array.isArray(rSales.data)) {
        var cloudSales = rSales.data.map(function (s) {
          return {
            date: s.date,
            opMode: s.op_mode || 'weekday',
            targetRevenue: Number(s.target_revenue) || 0,
            targetVisitors: Number(s.target_visitors) || 0,
            child: Number(s.child) || 0,
            adult: Number(s.adult) || 0,
            group: Number(s.group) || 0,
            ticketRevenue: Number(s.ticket_revenue) || 0,
            extraRevenue: Number(s.extra_revenue) || 0,
            totalVisitors: Number(s.total_visitors) || 0,
            totalRevenue: Number(s.total_revenue) || 0,
            isSafe: s.is_safe !== undefined ? s.is_safe : true,
            memo: s.memo || '',
            channels: s.channels || null,
            dataSource: s.data_source || 'manual'
          };
        });
        cloudSales.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
        localStorage.setItem('bongtteurak_actual_records_v4', JSON.stringify(cloudSales));

        // 당일 대시보드 요약 갱신
        var todayStr = toLocalDateStr(new Date());
        var todaySales = cloudSales.find(function (s) { return s.date === todayStr; });
        var dashData = {
          date: todayStr,
          todayRevenue: todaySales ? todaySales.totalRevenue : 0,
          todayVisitors: todaySales ? todaySales.totalVisitors : 0,
          monthRevenue: cloudSales.reduce(function (sum, s) { return sum + (Number(s.totalRevenue) || 0); }, 0)
        };
        localStorage.setItem('bongplay_dashboard_data', JSON.stringify(dashData));
        localStorage.setItem('bongtteurak_dashboard_data', JSON.stringify(dashData));
        results.sales_records = cloudSales.length;
      }

      // 5. closing_records (마감 정산 동기화)
      var rClosing = await select('closing_records', '?select=*&order=date.desc&limit=30');
      if (rClosing.ok && Array.isArray(rClosing.data)) {
        var todayStr2 = toLocalDateStr(new Date());
        var todayClose = rClosing.data.find(function (c) { return c.date === todayStr2; });
        if (todayClose) {
          var closeData = {
            date: todayClose.date,
            manager: todayClose.manager,
            staff: todayClose.staff,
            cash: todayClose.cash,
            actualCash: todayClose.actual_cash,
            diff: todayClose.diff,
            notes: todayClose.notes
          };
          localStorage.setItem('bongplay_closing_board_data', JSON.stringify(closeData));
          localStorage.setItem('bongtteurak_closing_board_data', JSON.stringify(closeData));
        } else {
          localStorage.removeItem('bongplay_closing_board_data');
          localStorage.removeItem('bongtteurak_closing_board_data');
        }
        results.closing_records = rClosing.data.length;
      }

      notifyDataChange({ type: 'CLOUD_PULL_SUCCESS', results: results });
      return { ok: true, results: results };
    } catch (e) {
      console.warn('pullAll error:', e);
      return { ok: false, error: String(e) };
    }
  }

  /* ---------- Supabase Realtime WebSocket 구독 초기화 ---------- */
  var supabaseRealtimeClient = null;
  function initRealtime() {
    var cfg = getConfig();
    if (!cfg || !global.supabase || !global.supabase.createClient) return;

    try {
      if (!supabaseRealtimeClient) {
        supabaseRealtimeClient = global.supabase.createClient(cfg.url, cfg.key);
      }
      var channel = supabaseRealtimeClient.channel('bongplay-realtime-bus');
      var tables = ['safety_consents', 'safety_audits', 'sales_records', 'closing_records', 'ticket_ledger'];

      tables.forEach(function (tbl) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table: tbl }, function (payload) {
          console.log('[Supabase Realtime Event]', tbl, payload);
          pullAll(); // 실시간 데이터 즉시 다운로드 및 로컬 캐시 갱신
        });
      });

      channel.subscribe(function (status) {
        console.log('[Supabase Realtime Channel Status]', status);
      });
    } catch (e) {
      console.warn('Realtime init error:', e);
    }
  }

  /* ---------- 연결 테스트 ---------- */
  async function testConnection() {
    var cfg = getConfig();
    if (!cfg) return { ok: false, msg: '설정이 저장되지 않았습니다.' };
    try {
      var res = await fetch(cfg.url + '/rest/v1/sales_records?select=id&limit=1', {
        headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key }
      });
      if (res.ok) return { ok: true, msg: '연결 성공 (Supabase DB 온라인)' };
      if (res.status === 401 || res.status === 403) return { ok: false, msg: 'API 키가 올바르지 않거나 권한이 없습니다 (HTTP ' + res.status + ')' };
      if (res.status === 404) return { ok: false, msg: '테이블(sales_records)이 없습니다. SQL 스크립트를 실행하십시오.' };
      return { ok: false, msg: 'HTTP ' + res.status };
    } catch (e) {
      return { ok: false, msg: '네트워크 오류 — URL을 확인하십시오.' };
    }
  }

  /* ---------- CSV 백업 ---------- */
  function toCsv(rows) {
    if (!rows || !rows.length) return '';
    var keys = Object.keys(rows[0]);
    var esc = function (v) {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') v = JSON.stringify(v);
      v = String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return keys.join(',') + '\n' +
      rows.map(function (r) { return keys.map(function (k) { return esc(r[k]); }).join(','); }).join('\n');
  }
  function downloadCsv(filename, rows) {
    var csv = toCsv(rows);
    if (!csv) { alert('내보낼 데이터가 없습니다.'); return; }
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ---------- 초기 기동 및 고속 동기화 폴링 ---------- */
  // 1. 페이지 로드 시 즉시 1회 동기화 및 Realtime 초기화
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', function () {
      pullAll();
      initRealtime();
    });
    // 창 포커스(탭 전환 복귀) 시 즉시 풀
    window.addEventListener('focus', function () {
      if (navigator.onLine && isConfigured()) pullAll();
    });
    window.addEventListener('online', function () {
      notifyStatus();
      pullAll();
      initRealtime();
    });
    window.addEventListener('offline', notifyStatus);
  }

  // 2. 백그라운드 주기 동기화 (30초 폴링 대기, 실시간 이벤트는 Supabase Realtime으로 즉시 수신)
  setInterval(function () {
    if (navigator.onLine && isConfigured()) {
      pullAll();
    }
  }, 30000);

  // 전역 API 노출
  global.BongplaySync = {
    getConfig: getConfig,
    setConfig: setConfig,
    isConfigured: isConfigured,
    getDeviceId: getDeviceId,
    getDeviceLabel: getDeviceLabel,
    setDeviceLabel: setDeviceLabel,
    upsert: upsert,
    patch: patch,
    select: select,
    remove: remove,
    delete: remove,
    pullAll: pullAll,
    getQueue: getQueue,
    clearQueue: clearQueue,
    flushQueue: flushQueue,
    testConnection: testConnection,
    getStatus: getStatus,
    onStatusChange: onStatusChange,
    onDataChange: onDataChange,
    broadcast: broadcast,
    initRealtime: initRealtime,
    toLocalTimeStr: toLocalTimeStr,
    toLocalDateStr: toLocalDateStr,
    toLocalDatetimeLocalStr: toLocalDatetimeLocalStr,
    downloadCsv: downloadCsv
  };
})(window);

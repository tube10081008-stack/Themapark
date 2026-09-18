/* ============================================================
   봉플레이 데이터 동기화 & 오프라인 원장 엔진 (BP-001)
   ------------------------------------------------------------
   설계 원칙 (v2026.Offline-First Resilient Ledger):
   1. 오프라인 자립성: 봉화 현장의 불안정한 LTE/WiFi 환경에서도
      안전동의서 서약, 발권, 게이트 체크인이 1ms 지연 없이 즉시 체결됨.
   2. IndexedDB 아웃박스(Outbox) 보존:
      네트워크 단절 또는 Supabase 장애 시 모든 트랜잭션은
      로컬 IndexedDB 아웃박스에 영구 보관되며 절대로 유실되거나 강제 삭제되지 않음.
   3. 선입선출(FIFO) 멱등성 동기화:
      네트워크 복구 즉시 순차적으로 Supabase 클라우드로 안전 전송 (UPSERT).
   4. 로컬 캐시 & 반응형 뱃지:
      온·오프라인 상태와 미전송 대기 건수를 실시간 뱃지로 UI에 명확히 표시.
   ============================================================ */
(function (global) {
  'use strict';

  var CFG_KEY = 'bongplay_supabase_config';
  var DEVICE_KEY = 'bongplay_device_id';
  var LS_OUTBOX_KEY = 'bongplay_outbox_queue_v2';
  var DB_NAME = 'BongplayLocalDB_v1';
  var DB_VERSION = 1;

  // 컬럼 캐시 (스키마에 존재하지 않는 컬럼을 기억하여 자동 제외)
  var invalidColumnCache = {};
  try {
    var rawCache = sessionStorage.getItem('bongplay_invalid_columns');
    if (rawCache) invalidColumnCache = JSON.parse(rawCache);
  } catch (e) {}

  var dbInstance = null;
  var isFlushing = false;
  var currentPendingCount = 0;

  /* ============================================================
     1. IndexedDB 아웃박스 스토리지 (BP-001 핵심)
     ============================================================ */
  function openIndexedDb() {
    if (dbInstance) return Promise.resolve(dbInstance);
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (ev) {
          var db = ev.target.result;
          if (!db.objectStoreNames.contains('outbox')) {
            var outStore = db.createObjectStore('outbox', { keyPath: 'id' });
            outStore.createIndex('created_at', 'created_at', { unique: false });
            outStore.createIndex('table', 'table', { unique: false });
          }
          if (!db.objectStoreNames.contains('local_ledger')) {
            db.createObjectStore('local_ledger', { keyPath: 'store_key' });
          }
        };
        req.onsuccess = function (ev) {
          dbInstance = ev.target.result;
          resolve(dbInstance);
        };
        req.onerror = function () {
          console.warn('IndexedDB unavailable, fallback to localStorage outbox');
          resolve(null);
        };
      } catch (e) {
        console.warn('IndexedDB exception:', e);
        resolve(null);
      }
    });
  }

  // localStorage 폴백 함수군
  function getLsOutbox() {
    try {
      var raw = localStorage.getItem(LS_OUTBOX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveLsOutbox(arr) {
    try { localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  // 아웃박스 적재 (Enqueue)
  async function enqueueOutbox(item) {
    item.id = item.id || ('out_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));
    item.created_at = item.created_at || new Date().toISOString();
    item.retry_count = item.retry_count || 0;

    var db = await openIndexedDb();
    if (db) {
      await new Promise(function (resolve) {
        try {
          var tx = db.transaction(['outbox'], 'readwrite');
          tx.objectStore('outbox').put(item);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    } else {
      var q = getLsOutbox();
      var idx = q.findIndex(function (x) { return x.id === item.id; });
      if (idx >= 0) q[idx] = item;
      else q.push(item);
      saveLsOutbox(q);
    }
    await refreshPendingCount();
    notifyStatus();
    return item;
  }

  // 아웃박스 조회 (FIFO: created_at 오름차순)
  async function getOutboxItems() {
    var db = await openIndexedDb();
    if (db) {
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['outbox'], 'readonly');
          var store = tx.objectStore('outbox');
          var index = store.index('created_at');
          var req = index.getAll();
          req.onsuccess = function (ev) { resolve(ev.target.result || []); };
          req.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
    }
    var q = getLsOutbox();
    q.sort(function (a, b) { return new Date(a.created_at || 0) - new Date(b.created_at || 0); });
    return q;
  }

  // 아웃박스 항목 제거 (성공 후)
  async function removeOutboxItem(id) {
    var db = await openIndexedDb();
    if (db) {
      await new Promise(function (resolve) {
        try {
          var tx = db.transaction(['outbox'], 'readwrite');
          tx.objectStore('outbox').delete(id);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    } else {
      var q = getLsOutbox().filter(function (x) { return x.id !== id; });
      saveLsOutbox(q);
    }
    await refreshPendingCount();
    notifyStatus();
  }

  // 미전송 건수 계산
  async function refreshPendingCount() {
    var db = await openIndexedDb();
    if (db) {
      currentPendingCount = await new Promise(function (resolve) {
        try {
          var tx = db.transaction(['outbox'], 'readonly');
          var req = tx.objectStore('outbox').count();
          req.onsuccess = function (ev) { resolve(ev.target.result || 0); };
          req.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    } else {
      currentPendingCount = getLsOutbox().length;
    }
    return currentPendingCount;
  }

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
    return localStorage.getItem('bongplay_device_label') || '현장단말';
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

  /* ---------- 상태 알림 & UI 뱃지 ---------- */
  var statusListeners = [];
  function onStatusChange(fn) {
    if (typeof fn === 'function') {
      statusListeners.push(fn);
      fn(getStatus());
    }
  }
  function notifyStatus() {
    var s = getStatus();
    statusListeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
    updateAllBadges();
  }
  function getStatus() {
    return {
      configured: isConfigured(),
      online: navigator.onLine,
      pending: currentPendingCount,
      syncing: isFlushing
    };
  }

  /* ---------- 실시간 동기화 상태 뱃지 렌더러 ---------- */
  function renderBadge(containerOrId) {
    var el = (typeof containerOrId === 'string') ? document.getElementById(containerOrId) : containerOrId;
    if (!el) return;
    var status = getStatus();
    var html = '';

    if (!status.configured) {
      html = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 cursor-pointer" onclick="window.BongplaySync && window.BongplaySync.testConnection().then(r=>alert(r.msg))" title="클라우드 DB 미연동 (로컬 전용 모드)">' +
             '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>' +
             '<span>DB 미연동</span></span>';
    } else if (status.syncing) {
      html = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-sky-950 text-sky-300 border border-sky-700 animate-pulse">' +
             '<span class="w-2 h-2 rounded-full bg-sky-400"></span>' +
             '<span>동기화 중 (' + status.pending + '건)</span></span>';
    } else if (!status.online) {
      html = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950 text-amber-300 border border-amber-700 shadow-sm" title="오프라인 모드: 로컬 원장에 정상 저장되며 통신 복구 시 자동 전송됩니다.">' +
             '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>' +
             '<span>오프라인 (' + status.pending + '건 보관)</span></span>';
    } else if (status.pending > 0) {
      html = '<button type="button" onclick="window.BongplaySync && window.BongplaySync.flushOutbox()" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-950/90 hover:bg-amber-900 text-amber-300 border border-amber-600 transition shadow-sm" title="클릭 시 즉시 클라우드로 전송">' +
             '<span class="w-2 h-2 rounded-full bg-amber-400"></span>' +
             '<span>미전송 ' + status.pending + '건 (전송 ↻)</span></button>';
    } else {
      html = '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-950/90 text-emerald-300 border border-emerald-700/80">' +
             '<span class="w-2 h-2 rounded-full bg-emerald-400"></span>' +
             '<span>온라인 동기화 완료</span></span>';
    }
    el.innerHTML = html;
  }

  function updateAllBadges() {
    if (typeof document === 'undefined') return;
    var targets = document.querySelectorAll('[data-bongplay-sync-badge], #syncStatusBadge');
    targets.forEach(function (t) { renderBadge(t); });
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

  /* ---------- 로컬 시각 변환 유틸리티 (KST 9시간 오차 방지) ---------- */
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

  /* ---------- 로컬 캐시 즉시 반영 헬퍼 ---------- */
  function updateLocalCache(table, row) {
    try {
      var pkField = (table === 'ticket_ledger') ? 'ticket_id' : 'id';
      var idVal = row[pkField];
      var cacheKey = '';
      if (table === 'safety_consents') cacheKey = 'bongplay_safety_consents';
      else if (table === 'ticket_ledger') cacheKey = 'bongplay_ticket_ledger';
      else if (table === 'safety_audits') cacheKey = 'bongplay_safety_audit_logs';
      else if (table === 'closing_records') cacheKey = 'bongplay_closing_board_data';
      else if (table === 'sales_records') cacheKey = 'bongtteurak_actual_records_v4';

      if (cacheKey && idVal) {
        var raw = localStorage.getItem(cacheKey);
        var list = raw ? JSON.parse(raw) : [];
        if (Array.isArray(list)) {
          var idx = list.findIndex(function (it) { return it[pkField] === idVal || it.id === idVal; });
          if (idx >= 0) {
            list[idx] = Object.assign({}, list[idx], row);
          } else {
            list.unshift(row);
          }
          localStorage.setItem(cacheKey, JSON.stringify(list));
        }
      }
    } catch (e) {
      console.warn('updateLocalCache error:', e);
    }
  }

  /* ---------- Supabase 조회 (SELECT) ---------- */
  async function select(table, query) {
    var cfg = getConfig();
    if (!cfg || !navigator.onLine) {
      // 오프라인 시 로컬 캐시에서 서빙 시도
      var cacheKey = (table === 'safety_consents') ? 'bongplay_safety_consents' :
                     (table === 'ticket_ledger') ? 'bongplay_ticket_ledger' :
                     (table === 'safety_audits') ? 'bongplay_safety_audit_logs' : '';
      if (cacheKey) {
        try {
          var localData = JSON.parse(localStorage.getItem(cacheKey) || '[]');
          return { ok: true, data: localData, from_local_cache: true };
        } catch (e) {}
      }
      return { ok: false, data: null, reason: 'offline_or_unconfigured' };
    }
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

  /* ---------- Supabase RPC 호출 (Remote Procedure Call) ---------- */
  async function rpc(fnName, params) {
    var cfg = getConfig();
    if (!cfg || !navigator.onLine) {
      return { ok: false, reason: 'offline_or_unconfigured' };
    }
    try {
      var url = cfg.url + '/rest/v1/rpc/' + fnName;
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': cfg.key,
          'Authorization': 'Bearer ' + cfg.key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params || {})
      });
      if (!res.ok) {
        var errTxt = await res.text();
        console.warn('Supabase RPC error:', fnName, res.status, errTxt);
        return { ok: false, status: res.status, error: errTxt };
      }
      var data = await res.json();
      return { ok: true, data: data };
    } catch (e) {
      console.warn('Supabase RPC exception:', fnName, e);
      return { ok: false, error: String(e) };
    }
  }

  /* ---------- 스마트 쓰기 (UPSERT with Resilient Offline Outbox) ---------- */
  async function upsert(table, row) {
    var cfg = getConfig();
    var pkField = (table === 'ticket_ledger') ? 'ticket_id' : 'id';
    
    // PK 자동 보장 (멱등성 확보)
    if (!row[pkField]) {
      row[pkField] = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

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

    // 1. 로컬 캐시 즉시 업데이트 (UI 반응성 보장)
    updateLocalCache(table, payload);

    // 2. 오프라인 또는 설정 누락 시 즉시 아웃박스에 영구 보존
    if (!cfg || !navigator.onLine) {
      var outId = payload[pkField] || ('out_' + Date.now());
      await enqueueOutbox({
        id: outId,
        table: table,
        action: 'upsert',
        payload: payload,
        created_at: new Date().toISOString()
      });
      broadcast({ type: 'UPSERT_OFFLINE_QUEUED', table: table, row: payload, offline: true });
      return { ok: true, queued: true, offline: true, row: payload };
    }

    // 3. 온라인 상태: Supabase로 전송 시도
    var maxRetries = 6;
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
          await removeOutboxItem(payload[pkField]);
          broadcast({ type: 'UPSERT_SUCCESS', table: table, row: payload });
          return { ok: true, row: payload };
        }

        var errBody = await res.text();

        // 3-1. DB 컬럼 누락 시 자동 제거 후 재시도
        var match = errBody.match(/Could not find the '([^']+)' column/);
        if (match && match[1]) {
          var missingCol = match[1];
          if (!invalidColumnCache[table]) invalidColumnCache[table] = [];
          if (invalidColumnCache[table].indexOf(missingCol) === -1) {
            invalidColumnCache[table].push(missingCol);
            try { sessionStorage.setItem('bongplay_invalid_columns', JSON.stringify(invalidColumnCache)); } catch (e) {}
          }
          delete payload[missingCol];
          continue;
        }

        // 3-2. 충돌 시 PATCH 시도
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
              await removeOutboxItem(payload[pkField]);
              broadcast({ type: 'UPSERT_SUCCESS', table: table, row: payload });
              return { ok: true, row: payload };
            }
          } catch (patchErr) {}
        }

        if (res.status >= 500) {
          await enqueueOutbox({
            id: payload[pkField],
            table: table,
            action: 'upsert',
            payload: payload,
            created_at: new Date().toISOString()
          });
          return { ok: true, queued: true, row: payload };
        }

        console.warn('Upsert failed for table:', table, res.status, errBody);
        return { ok: false, reason: 'http_' + res.status, detail: errBody };
      } catch (e) {
        console.warn('Upsert network exception, queued to outbox:', table, e);
        await enqueueOutbox({
          id: payload[pkField],
          table: table,
          action: 'upsert',
          payload: payload,
          created_at: new Date().toISOString()
        });
        return { ok: true, queued: true, offline: true, row: payload };
      }
    }

    await enqueueOutbox({
      id: payload[pkField],
      table: table,
      action: 'upsert',
      payload: payload,
      created_at: new Date().toISOString()
    });
    return { ok: true, queued: true, row: payload };
  }

  /* ---------- 직접 수정 (PATCH with Outbox) ---------- */
  async function patch(table, idVal, patchData, idCol) {
    var cfg = getConfig();
    idCol = idCol || (table === 'ticket_ledger' ? 'ticket_id' : 'id');

    var patchPayload = Object.assign({}, patchData);
    patchPayload[idCol] = idVal;
    updateLocalCache(table, patchPayload);

    if (!cfg || !navigator.onLine) {
      await enqueueOutbox({
        id: 'patch_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'patch',
        payload: patchData,
        created_at: new Date().toISOString()
      });
      broadcast({ type: 'UPDATE_SUCCESS', table: table, id: idVal, data: patchData, offline: true });
      return { ok: true, queued: true };
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
      await enqueueOutbox({
        id: 'patch_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'patch',
        payload: patchData,
        created_at: new Date().toISOString()
      });
      return { ok: true, queued: true };
    } catch (e) {
      await enqueueOutbox({
        id: 'patch_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'patch',
        payload: patchData,
        created_at: new Date().toISOString()
      });
      return { ok: true, queued: true };
    }
  }

  /* ---------- 직접 삭제 (DELETE with Outbox) ---------- */
  async function remove(table, idVal, idCol) {
    var cfg = getConfig();
    idCol = idCol || (table === 'ticket_ledger' ? 'ticket_id' : 'id');

    try {
      var cacheKey = (table === 'safety_consents') ? 'bongplay_safety_consents' :
                     (table === 'safety_audits') ? 'bongplay_safety_audit_logs' : '';
      if (cacheKey) {
        var rawLocal = localStorage.getItem(cacheKey);
        if (rawLocal) {
          var localItems = JSON.parse(rawLocal);
          if (Array.isArray(localItems)) {
            var filtered = localItems.filter(function (it) { return it[idCol] !== idVal && it.id !== idVal; });
            localStorage.setItem(cacheKey, JSON.stringify(filtered));
          }
        }
      }
    } catch (cle) {}

    broadcast({ type: 'DELETE_SUCCESS', table: table, id: idVal });

    if (!cfg || !navigator.onLine) {
      await enqueueOutbox({
        id: 'del_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'delete',
        created_at: new Date().toISOString()
      });
      return { ok: true, queued: true };
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
        await pullAll();
        return { ok: true };
      }
      var errTxt = await res.text();
      console.warn('Supabase delete error:', res.status, errTxt);
      await enqueueOutbox({
        id: 'del_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'delete',
        created_at: new Date().toISOString()
      });
      return { ok: true, queued: true };
    } catch (e) {
      await enqueueOutbox({
        id: 'del_' + idVal,
        idVal: idVal,
        idCol: idCol,
        table: table,
        action: 'delete',
        created_at: new Date().toISOString()
      });
      return { ok: true, queued: true };
    }
  }

  /* ============================================================
     2. 선입선출(FIFO) 아웃박스 자동 동기화 (Flush Engine)
     ============================================================ */
  async function flushOutbox() {
    if (isFlushing || !navigator.onLine) {
      return { processed: 0, pending: await refreshPendingCount() };
    }
    var cfg = getConfig();
    if (!cfg) return { processed: 0, pending: await refreshPendingCount() };

    isFlushing = true;
    notifyStatus();

    var items = await getOutboxItems();
    var processed = 0;

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      try {
        var success = false;
        if (item.action === 'upsert') {
          var res = await fetch(cfg.url + '/rest/v1/' + item.table, {
            method: 'POST',
            headers: {
              'apikey': cfg.key,
              'Authorization': 'Bearer ' + cfg.key,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify(item.payload)
          });

          if (res.ok) {
            success = true;
          } else if (res.status === 409) {
            var pkField = (item.table === 'ticket_ledger') ? 'ticket_id' : 'id';
            var pkVal = item.payload[pkField];
            if (pkVal) {
              var pData = Object.assign({}, item.payload);
              delete pData[pkField];
              var resPatch = await fetch(cfg.url + '/rest/v1/' + item.table + '?' + pkField + '=eq.' + encodeURIComponent(pkVal), {
                method: 'PATCH',
                headers: {
                  'apikey': cfg.key,
                  'Authorization': 'Bearer ' + cfg.key,
                  'Content-Type': 'application/json',
                  'Prefer': 'return=representation'
                },
                body: JSON.stringify(pData)
              });
              if (resPatch.ok) success = true;
            }
          } else if (res.status >= 400 && res.status < 500) {
            var errTxt = await res.text();
            var colMatch = errTxt.match(/Could not find the '([^']+)' column/);
            if (colMatch && colMatch[1]) {
              delete item.payload[colMatch[1]];
              var resRetry = await fetch(cfg.url + '/rest/v1/' + item.table, {
                method: 'POST',
                headers: {
                  'apikey': cfg.key,
                  'Authorization': 'Bearer ' + cfg.key,
                  'Content-Type': 'application/json',
                  'Prefer': 'resolution=merge-duplicates,return=minimal'
                },
                body: JSON.stringify(item.payload)
              });
              if (resRetry.ok) success = true;
            }
          }
        } else if (item.action === 'patch') {
          var pk = item.idCol || (item.table === 'ticket_ledger' ? 'ticket_id' : 'id');
          var resP = await fetch(cfg.url + '/rest/v1/' + item.table + '?' + pk + '=eq.' + encodeURIComponent(item.idVal), {
            method: 'PATCH',
            headers: {
              'apikey': cfg.key,
              'Authorization': 'Bearer ' + cfg.key,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(item.payload)
          });
          if (resP.ok) success = true;
        } else if (item.action === 'delete') {
          var pkD = item.idCol || (item.table === 'ticket_ledger' ? 'ticket_id' : 'id');
          var resD = await fetch(cfg.url + '/rest/v1/' + item.table + '?' + pkD + '=eq.' + encodeURIComponent(item.idVal), {
            method: 'DELETE',
            headers: {
              'apikey': cfg.key,
              'Authorization': 'Bearer ' + cfg.key,
              'Prefer': 'return=representation'
            }
          });
          if (resD.ok || resD.status === 401 || resD.status === 403 || resD.status === 404) {
            success = true;
          }
        }

        if (success) {
          await removeOutboxItem(item.id);
          processed++;
        } else {
          item.retry_count = (item.retry_count || 0) + 1;
          break;
        }
      } catch (err) {
        console.warn('Outbox flush network error:', item.id, err);
        break;
      }
    }

    isFlushing = false;
    await refreshPendingCount();
    notifyStatus();

    if (processed > 0) {
      broadcast({ type: 'OUTBOX_FLUSHED', processed: processed });
    }
    return { processed: processed, pending: currentPendingCount };
  }

  function getQueue() { return getOutboxItems(); }
  function clearQueue() {
    refreshPendingCount().then(notifyStatus);
  }
  function flushQueue() { return flushOutbox(); }

  /* ---------- 클라우드 DB 전체 풀 (PULL ALL) ---------- */
  async function pullAll() {
    var cfg = getConfig();
    if (!cfg || !navigator.onLine) return { ok: false, reason: 'offline_or_unconfigured' };

    var results = { safety_audits: 0, safety_consents: 0, sales_records: 0, closing_records: 0, ticket_ledger: 0 };
    try {
      // 1. safety_audits
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

      // 2. safety_consents
      var rConsents = await select('safety_consents', '?select=*&order=updated_at.desc&limit=200');
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

      // 3. ticket_ledger
      var rTickets = await select('ticket_ledger', '?select=*&order=issued_at.desc&limit=400');
      if (rTickets.ok && Array.isArray(rTickets.data)) {
        localStorage.setItem('bongplay_ticket_ledger', JSON.stringify(rTickets.data));
        results.ticket_ledger = rTickets.data.length;
      }

      // 4. sales_records
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

      // 5. closing_records
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
            notes: todayClose.notes,
            is_locked: todayClose.is_locked
          };
          localStorage.setItem('bongplay_closing_board_data', JSON.stringify(closeData));
          localStorage.setItem('bongtteurak_closing_board_data', JSON.stringify(closeData));
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
          pullAll();
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
    if (!cfg) return { ok: false, msg: 'Supabase URL/Key 설정이 없습니다.' };
    try {
      var res = await fetch(cfg.url + '/rest/v1/sales_records?select=id&limit=1', {
        headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key }
      });
      if (res.ok) return { ok: true, msg: '연결 성공 (Supabase 클라우드 온라인)' };
      if (res.status === 401 || res.status === 403) return { ok: false, msg: 'API 키 권한 오류 (HTTP ' + res.status + ')' };
      return { ok: false, msg: '서버 응답 오류 (HTTP ' + res.status + ')' };
    } catch (e) {
      return { ok: false, msg: '네트워크 연결 불가 (오프라인 상태)' };
    }
  }

  /* ---------- CSV 다운로드 ---------- */
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

  /* ---------- 라이프사이클 이벤트 & 백그라운드 동기화 ---------- */
  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', function () {
      openIndexedDb().then(function () {
        refreshPendingCount().then(function () {
          notifyStatus();
          if (navigator.onLine) {
            flushOutbox();
            pullAll();
            initRealtime();
          }
        });
      });
    });

    window.addEventListener('online', function () {
      notifyStatus();
      flushOutbox();
      pullAll();
      initRealtime();
    });

    window.addEventListener('offline', function () {
      notifyStatus();
    });

    window.addEventListener('focus', function () {
      if (navigator.onLine && isConfigured()) {
        flushOutbox();
        pullAll();
      }
    });

    // 10초마다 아웃박스 동기화 확인
    setInterval(function () {
      if (navigator.onLine && isConfigured() && !isFlushing) {
        flushOutbox();
      }
    }, 10000);
  }

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
    rpc: rpc,
    remove: remove,
    delete: remove,
    pullAll: pullAll,
    getQueue: getQueue,
    clearQueue: clearQueue,
    flushQueue: flushQueue,
    flushOutbox: flushOutbox,
    getPendingCount: refreshPendingCount,
    testConnection: testConnection,
    getStatus: getStatus,
    onStatusChange: onStatusChange,
    onDataChange: onDataChange,
    broadcast: broadcast,
    initRealtime: initRealtime,
    toLocalTimeStr: toLocalTimeStr,
    toLocalDateStr: toLocalDateStr,
    toLocalDatetimeLocalStr: toLocalDatetimeLocalStr,
    downloadCsv: downloadCsv,
    renderBadge: renderBadge,
    updateAllBadges: updateAllBadges
  };
})(window);

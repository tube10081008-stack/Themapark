/**
 * assets/bongplay-queue.js
 * 
 * 봉플레이 발권 대기 시스템 핵심 엔진 & 클라이언트 어댑터 (ANT-006 / BEN-022)
 * ----------------------------------------------------------------------------
 * 주요 책임:
 * 1. 동의서 1건 = 1팀 대기열 접수 및 당일 대기번호 발급 (서버 확정 전 로컬 임의 번호 발급 원천 차단)
 * 2. 멱등성 보장 (idempotency_key 기반 새로고침·재시도 중복 생성 방지)
 * 3. 앞선 미발권 팀 수 산정 (waiting + called + processing 포함, issued/canceled/no_show 제외)
 * 4. 처리 실적 기반 예상시간 산출 (표본 3건 미만 "집계 중", 창구 중지 "발권 일시 중지")
 * 5. 다중 단말 경합 방지 (CAS / 낙관적 락 기반 이중 호출 차단)
 * 6. 발권 실패 가드 (서버 발권 실패 시 완료 처리 금지, 취소 시 예전 순서 자동 복귀 차단)
 * 7. 공개 호출판 PII 완전 마스킹
 */

(function (global) {
  'use strict';

  var STATUS = {
    WAITING: 'waiting',       // 대기 중
    CALLED: 'called',         // 호출됨 (창구로 이동)
    PROCESSING: 'processing', // 창구에서 서약 확인 및 결제/발권 진행 중
    ISSUED: 'issued',         // 발권 완료 (대기열 완전 제외)
    NO_SHOW: 'no_show',       // 부재 보류 (대기열 제외, 필요 시 복귀 가능)
    CANCELED: 'canceled'      // 접수 취소 (대기열 완전 제외)
  };

  // 대기 순번에 포함되는 활성 대기 상태
  var ACTIVE_IN_QUEUE_STATUSES = [STATUS.WAITING, STATUS.CALLED, STATUS.PROCESSING];

  /**
   * KST 날짜 문자열 반환 (YYYY-MM-DD)
   */
  function getKstDateStr(dateInput) {
    var d = dateInput ? new Date(dateInput) : new Date();
    var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    var kst = new Date(utc + (9 * 3600000));
    var y = kst.getFullYear();
    var m = String(kst.getMonth() + 1).padStart(2, '0');
    var day = String(kst.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  /**
   * KST 시간 문자열 반환 (HH:mm:ss)
   */
  function getKstTimeStr(dateInput) {
    var d = dateInput ? new Date(dateInput) : new Date();
    var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    var kst = new Date(utc + (9 * 3600000));
    var hh = String(kst.getHours()).padStart(2, '0');
    var mm = String(kst.getMinutes()).padStart(2, '0');
    var ss = String(kst.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  /**
   * 멱등성 키 생성
   */
  function generateIdempotencyKey(dateStr, consentId, phone) {
    var cleanPhone = (phone || '').replace(/[^0-9]/g, '');
    var cid = consentId || 'cst_unknown';
    var d = dateStr || getKstDateStr();
    return d + '_' + cid + (cleanPhone ? '_' + cleanPhone.slice(-4) : '');
  }

  /**
   * 대기번호 표시 포맷팅 (#001)
   */
  function formatQueueNumber(num) {
    if (typeof num !== 'number' || isNaN(num) || num <= 0) return '대기 중';
    return '#' + String(num).padStart(3, '0');
  }

  /**
   * 내 앞 대기 팀 수 계산
   * - 규칙: 동일 일자, 내 queue_number보다 작고, 상태가 waiting, called, processing 중 하나인 팀만 포함.
   * - issued, no_show, canceled 상태 팀은 반드시 제외.
   */
  function computeAheadCount(queueList, myQueueNumber, queueDate) {
    if (!Array.isArray(queueList) || !myQueueNumber) return 0;
    var targetDate = queueDate || getKstDateStr();
    var count = 0;
    for (var i = 0; i < queueList.length; i++) {
      var item = queueList[i];
      if (item.queue_date !== targetDate) continue;
      if (item.queue_number < myQueueNumber) {
        if (ACTIVE_IN_QUEUE_STATUSES.indexOf(item.status) !== -1) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * 예상 대기시간 계산
   * @param {Object} options
   * - aheadCount: 내 앞선 팀 수 (호출·처리 중 포함)
   * - completedIssuances: 당일 발권 완료 기록 목록 ([{ processing_duration_seconds: 120 }, ...])
   * - activeDesksCount: 현재 활성 매표 창구 수 (최소 1 이상 권장)
   * - isDeskPaused: 창구 전체 정지 여부 (boolean)
   * - minSampleCount: 최소 표본 수 (기본 3건)
   */
  function calculateWaitTime(options) {
    var opts = options || {};
    var aheadCount = typeof opts.aheadCount === 'number' ? opts.aheadCount : 0;
    var completed = Array.isArray(opts.completedIssuances) ? opts.completedIssuances : [];
    var activeDesks = (typeof opts.activeDesksCount === 'number' && opts.activeDesksCount > 0) ? opts.activeDesksCount : 1;
    var isDeskPaused = Boolean(opts.isDeskPaused);
    var minSampleCount = typeof opts.minSampleCount === 'number' ? opts.minSampleCount : 3;

    // 1. 창구 정지인 경우
    if (isDeskPaused || activeDesks <= 0) {
      return {
        code: 'PAUSED',
        text: '발권 일시 중지',
        minutes: null,
        sampleCount: completed.length
      };
    }

    // 앞선 팀이 0인 경우 (즉시 처리 가능 또는 호출 대기)
    if (aheadCount <= 0) {
      return {
        code: 'IMMEDIATE',
        text: '곧 호출 예정',
        minutes: 0,
        sampleCount: completed.length
      };
    }

    // 2. 표본 수집 확인
    // 발권 완료 건 중 유효한 처리시간(초) 추출
    var validDurations = [];
    for (var i = 0; i < completed.length; i++) {
      var c = completed[i];
      var sec = c.duration_seconds;
      if (typeof sec !== 'number' && c.called_at && c.issued_at) {
        var start = new Date(c.processing_started_at || c.called_at).getTime();
        var end = new Date(c.issued_at).getTime();
        if (end > start) sec = Math.round((end - start) / 1000);
      }
      if (typeof sec === 'number' && sec >= 20 && sec <= 1800) {
        validDurations.push(sec);
      }
    }

    // 표본 부족 시 "집계 중" 반환
    if (validDurations.length < minSampleCount) {
      return {
        code: 'CALCULATING',
        text: '집계 중',
        minutes: null,
        sampleCount: validDurations.length
      };
    }

    // 최근 최대 10건의 이동 평균 계산
    var recentSamples = validDurations.slice(-10);
    var sumSec = 0;
    for (var j = 0; j < recentSamples.length; j++) {
      sumSec += recentSamples[j];
    }
    var avgSecPerTeam = sumSec / recentSamples.length;

    // (내 앞 팀 수 * 팀당 평균 소요 시간) / 활성 창구 수
    var totalEstimatedSec = (aheadCount * avgSecPerTeam) / activeDesks;
    var estimatedMinutes = Math.max(1, Math.ceil(totalEstimatedSec / 60));

    return {
      code: 'ESTIMATED',
      text: '약 ' + estimatedMinutes + '분',
      minutes: estimatedMinutes,
      avgSecPerTeam: Math.round(avgSecPerTeam),
      sampleCount: validDurations.length
    };
  }

  /**
   * 공개 호출판용 PII 마스킹 (개인정보 원천 차단)
   */
  function sanitizeForPublicDisplay(queueItem) {
    if (!queueItem) return null;
    return {
      id: queueItem.id,
      queue_number: queueItem.queue_number,
      formatted_number: formatQueueNumber(queueItem.queue_number),
      desk_no: queueItem.desk_no || null,
      status: queueItem.status,
      called_at: queueItem.called_at || null,
      queue_date: queueItem.queue_date
    };
  }

  /* ============================================================
     2. 로컬 메모리 시뮬레이션 / 테스트 / 오프라인용 대기열 엔진
     ============================================================ */
  function InMemoryQueueStore() {
    this.entries = []; // 전체 큐 레코드
    this.counters = {}; // { '2026-10-08': 42 } 날짜별 일련번호
    this.desks = {
      1: { desk_no: 1, is_active: true, is_paused: false, staff_id: 'staff_1', current_queue_id: null },
      2: { desk_no: 2, is_active: true, is_paused: false, staff_id: 'staff_2', current_queue_id: null }
    };
    this.completedHistory = []; // 완료된 발권 히스토리
    this.lock = false; // 동시성 원자성 제어용
  }

  InMemoryQueueStore.prototype.reset = function () {
    this.entries = [];
    this.counters = {};
    this.completedHistory = [];
    this.desks[1] = { desk_no: 1, is_active: true, is_paused: false, staff_id: 'staff_1', current_queue_id: null };
    this.desks[2] = { desk_no: 2, is_active: true, is_paused: false, staff_id: 'staff_2', current_queue_id: null };
  };

  /**
   * 접수 (enqueue) - 원자적 일련번호 채번 & 멱등성 보장
   */
  InMemoryQueueStore.prototype.enqueue = function (params) {
    var p = params || {};
    var dateStr = p.queue_date || getKstDateStr(p.now);
    var idempotencyKey = p.idempotency_key || generateIdempotencyKey(dateStr, p.consent_id, p.guardian_phone);

    // 멱등성 검사: 동일 idempotency_key가 이미 있으면 기존 항목 반환
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].idempotency_key === idempotencyKey) {
        return {
          ok: true,
          duplicate: true,
          item: Object.assign({}, this.entries[i])
        };
      }
    }

    // 날짜별 시퀀스 증가 (1부터 시작)
    if (!this.counters[dateStr]) {
      this.counters[dateStr] = 0;
    }
    this.counters[dateStr] += 1;
    var nextNum = this.counters[dateStr];

    var entryId = 'q_' + dateStr.replace(/-/g, '') + '_' + String(nextNum).padStart(4, '0') + '_' + Math.random().toString(36).slice(2, 6);
    var nowIso = (p.now ? new Date(p.now) : new Date()).toISOString();

    var newEntry = {
      id: entryId,
      site_id: p.site_id || 'bongplay_bonghwa',
      queue_date: dateStr,
      queue_number: nextNum,
      formatted_number: formatQueueNumber(nextNum),
      consent_id: p.consent_id,
      visit_id: p.visit_id || null,
      household_id: p.household_id || null,
      guardian_name: p.guardian_name || '',
      guardian_phone: p.guardian_phone || '',
      party_size: typeof p.party_size === 'number' ? p.party_size : 1,
      idempotency_key: idempotencyKey,
      status: STATUS.WAITING,
      desk_no: null,
      staff_id: null,
      enqueued_at: nowIso,
      called_at: null,
      processing_started_at: null,
      issued_at: null,
      canceled_at: null,
      hold_at: null,
      restored_at: null,
      version: 1
    };

    this.entries.push(newEntry);
    return {
      ok: true,
      duplicate: false,
      item: Object.assign({}, newEntry)
    };
  };

  /**
   * 다음 대기팀 호출 (call_next) - 단말 간 경합 방지
   */
  InMemoryQueueStore.prototype.callNext = function (deskNo, staffId, now) {
    var desk = this.desks[deskNo];
    if (!desk) {
      desk = { desk_no: deskNo, is_active: true, is_paused: false, staff_id: staffId, current_queue_id: null };
      this.desks[deskNo] = desk;
    }
    if (desk.is_paused) {
      return { ok: false, error: 'desk_paused', message: '창구가 일시 중지 상태입니다.' };
    }

    var todayStr = getKstDateStr(now);
    var nowIso = (now ? new Date(now) : new Date()).toISOString();

    // 당일 waiting 상태인 항목 중 queue_number가 가장 작은 것 선택
    var candidates = [];
    for (var i = 0; i < this.entries.length; i++) {
      var item = this.entries[i];
      if (item.queue_date === todayStr && item.status === STATUS.WAITING) {
        candidates.push(item);
      }
    }

    if (candidates.length === 0) {
      return { ok: false, error: 'empty_queue', message: '대기 중인 팀이 없습니다.' };
    }

    // 순번 오름차순 정렬
    candidates.sort(function (a, b) { return a.queue_number - b.queue_number; });
    var target = candidates[0];

    // 원자적 상태 변경
    target.status = STATUS.CALLED;
    target.desk_no = deskNo;
    target.staff_id = staffId || desk.staff_id;
    target.called_at = nowIso;
    target.version += 1;

    desk.current_queue_id = target.id;

    return {
      ok: true,
      item: Object.assign({}, target)
    };
  };

  /**
   * 재호출 (recall)
   */
  InMemoryQueueStore.prototype.recall = function (queueId, deskNo, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.CALLED && item.status !== STATUS.PROCESSING) {
      return { ok: false, error: 'invalid_status', message: '호출 또는 처리 중인 팀만 재호출할 수 있습니다.' };
    }

    item.called_at = (now ? new Date(now) : new Date()).toISOString();
    if (deskNo) item.desk_no = deskNo;
    item.version += 1;

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 발권 처리 시작 (start_processing)
   */
  InMemoryQueueStore.prototype.startProcessing = function (queueId, deskNo, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.CALLED) {
      return { ok: false, error: 'invalid_status', message: '호출된 팀만 발권 처리를 시작할 수 있습니다.' };
    }

    item.status = STATUS.PROCESSING;
    item.processing_started_at = (now ? new Date(now) : new Date()).toISOString();
    if (deskNo) item.desk_no = deskNo;
    item.version += 1;

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 부재 보류 (hold_no_show) - 대기열 즉시 제외
   */
  InMemoryQueueStore.prototype.holdNoShow = function (queueId, reason, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.CALLED && item.status !== STATUS.PROCESSING) {
      return { ok: false, error: 'invalid_status', message: '호출 또는 처리 중인 상태에서만 보류할 수 있습니다.' };
    }

    item.status = STATUS.NO_SHOW;
    item.hold_at = (now ? new Date(now) : new Date()).toISOString();
    item.hold_reason = reason || '고객 부재';
    item.version += 1;

    // 해당 창구의 현재 진행 비우기
    if (item.desk_no && this.desks[item.desk_no]) {
      this.desks[item.desk_no].current_queue_id = null;
    }

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 보류 복귀 (restore_held) - 대기열 복귀
   */
  InMemoryQueueStore.prototype.restoreHeld = function (queueId, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.NO_SHOW) {
      return { ok: false, error: 'invalid_status', message: '부재 보류된 팀만 대기열로 복귀할 수 있습니다.' };
    }

    item.status = STATUS.WAITING;
    item.restored_at = (now ? new Date(now) : new Date()).toISOString();
    item.desk_no = null;
    item.version += 1;

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 접수 취소 (cancel_entry) - 대기열 완전 제외
   */
  InMemoryQueueStore.prototype.cancelEntry = function (queueId, reason, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };

    item.status = STATUS.CANCELED;
    item.canceled_at = (now ? new Date(now) : new Date()).toISOString();
    item.cancel_reason = reason || '고객 취소';
    item.version += 1;

    if (item.desk_no && this.desks[item.desk_no]) {
      this.desks[item.desk_no].current_queue_id = null;
    }

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 발권 완료 (complete_issuance)
   * - 필수 가드: 발권 실패 시에는 이 메서드가 호출되지 않아야 함
   * - 완료 즉시 대기열에서 제외되고 실적 처리시간 기록
   */
  InMemoryQueueStore.prototype.completeIssuance = function (queueId, orderId, ticketIds, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };

    var nowIso = (now ? new Date(now) : new Date()).toISOString();
    var startTime = item.processing_started_at || item.called_at || item.enqueued_at;
    var durationSec = 60; // 기본 1분
    if (startTime) {
      var diff = (new Date(nowIso).getTime() - new Date(startTime).getTime()) / 1000;
      if (diff > 0) durationSec = Math.round(diff);
    }

    item.status = STATUS.ISSUED;
    item.issued_at = nowIso;
    item.order_id = orderId || null;
    item.ticket_ids = Array.isArray(ticketIds) ? ticketIds : [];
    item.duration_seconds = durationSec;
    item.version += 1;

    if (item.desk_no && this.desks[item.desk_no]) {
      this.desks[item.desk_no].current_queue_id = null;
    }

    this.completedHistory.push({
      id: item.id,
      queue_date: item.queue_date,
      queue_number: item.queue_number,
      called_at: item.called_at,
      processing_started_at: item.processing_started_at,
      issued_at: item.issued_at,
      duration_seconds: durationSec
    });

    return { ok: true, item: Object.assign({}, item) };
  };

  InMemoryQueueStore.prototype.getEntryById = function (queueId) {
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].id === queueId) return this.entries[i];
    }
    return null;
  };

  InMemoryQueueStore.prototype.getEntryByConsentId = function (consentId) {
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].consent_id === consentId) return this.entries[i];
    }
    return null;
  };

  /**
   * 창구 일시 중지 / 해제 설정
   */
  InMemoryQueueStore.prototype.setDeskPaused = function (deskNo, isPaused) {
    if (this.desks[deskNo]) {
      this.desks[deskNo].is_paused = Boolean(isPaused);
      return true;
    }
    return false;
  };

  /**
   * 고객 화면용 상태 조회
   */
  InMemoryQueueStore.prototype.getCustomerQueueStatus = function (queueId, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };

    var ahead = computeAheadCount(this.entries, item.queue_number, item.queue_date);
    var activeDesksCount = 0;
    var anyDeskPaused = false;
    for (var d in this.desks) {
      if (this.desks[d].is_active && !this.desks[d].is_paused) activeDesksCount++;
      if (this.desks[d].is_paused) anyDeskPaused = true;
    }

    var waitTime = calculateWaitTime({
      aheadCount: ahead,
      completedIssuances: this.completedHistory.filter(function (c) { return c.queue_date === item.queue_date; }),
      activeDesksCount: activeDesksCount,
      isDeskPaused: (activeDesksCount === 0 || anyDeskPaused && activeDesksCount === 0)
    });

    return {
      ok: true,
      item: {
        id: item.id,
        queue_number: item.queue_number,
        formatted_number: item.formatted_number,
        status: item.status,
        desk_no: item.desk_no,
        ahead_count: ahead,
        wait_time: waitTime,
        updated_at: (now ? new Date(now) : new Date()).toISOString(),
        updated_time_text: getKstTimeStr(now)
      }
    };
  };

  /**
   * 공개 호출판용 전광판 상태 조회 (Zero PII)
   */
  InMemoryQueueStore.prototype.getPublicDisplayData = function (dateStr) {
    var targetDate = dateStr || getKstDateStr();
    var calledList = [];
    var waitingCount = 0;

    for (var i = 0; i < this.entries.length; i++) {
      var item = this.entries[i];
      if (item.queue_date !== targetDate) continue;
      if (item.status === STATUS.CALLED || item.status === STATUS.PROCESSING) {
        calledList.push(sanitizeForPublicDisplay(item));
      } else if (item.status === STATUS.WAITING) {
        waitingCount++;
      }
    }

    // 최근 호출순 정렬
    calledList.sort(function (a, b) {
      return (new Date(b.called_at || 0)).getTime() - (new Date(a.called_at || 0)).getTime();
    });

    return {
      date: targetDate,
      called_teams: calledList,
      waiting_teams_count: waitingCount,
      desks: Object.assign({}, this.desks),
      updated_at: new Date().toISOString(),
      updated_time_text: getKstTimeStr()
    };
  };

  /* ============================================================
     3. 통합 클라이언트 API (BongplayQueue)
     ============================================================ */
  var defaultStore = new InMemoryQueueStore();

  var BongplayQueue = {
    STATUS: STATUS,
    ACTIVE_IN_QUEUE_STATUSES: ACTIVE_IN_QUEUE_STATUSES,
    getKstDateStr: getKstDateStr,
    getKstTimeStr: getKstTimeStr,
    generateIdempotencyKey: generateIdempotencyKey,
    formatQueueNumber: formatQueueNumber,
    computeAheadCount: computeAheadCount,
    calculateWaitTime: calculateWaitTime,
    sanitizeForPublicDisplay: sanitizeForPublicDisplay,
    store: defaultStore,

    // 새 인메모리 스토어 인스턴스 생성기 (테스트 격리용)
    createStore: function () {
      return new InMemoryQueueStore();
    },

    /**
     * 고객 서약서 대기열 접수 요청 (온라인/서버 RPC 우선, 미연결 시 로컬 보류)
     */
    enqueueConsent: async function (consentRecord, options) {
      var opts = options || {};
      var now = opts.now || new Date();
      var dateStr = getKstDateStr(now);
      var idempotencyKey = generateIdempotencyKey(dateStr, consentRecord.id, consentRecord.guardian_phone || consentRecord.guardianPhone);

      var isOnline = true;
      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
        isOnline = navigator.onLine;
      }
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.isOnline === 'function') {
        isOnline = window.BongplaySync.isOnline();
      }

      // 오프라인 상태인 경우: 공식 번호 발급 거부 (규칙 1)
      if (!isOnline) {
        return {
          ok: false,
          offline: true,
          reason: 'offline_pending',
          message: '네트워크 연결 대기 중입니다. 서버 확정 후 공식 대기번호가 발급됩니다.'
        };
      }

      // 1. Supabase RPC 호출 시도 (실제 운영 환경)
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('enqueue_consent_team', {
            p_consent_id: consentRecord.id,
            p_idempotency_key: idempotencyKey,
            p_party_size: (consentRecord.children ? consentRecord.children.length + 1 : 1),
            p_guardian_name: consentRecord.guardian_name || consentRecord.guardianName || '',
            p_guardian_phone: consentRecord.guardian_phone || consentRecord.guardianPhone || '',
            p_site_id: consentRecord.site_id || 'bongplay_bonghwa'
          });

          if (rpcRes && rpcRes.ok && rpcRes.data && (rpcRes.data.queue_number || rpcRes.data.id)) {
            return {
              ok: true,
              source: 'rpc',
              item: rpcRes.data
            };
          }
        } catch (e) {
          console.warn('RPC enqueue failed, checking mock fallback:', e);
        }
      }

      // 2. Mock / In-memory Fallback (합성 테스트 및 로컬 샌드박스)
      var res = defaultStore.enqueue({
        consent_id: consentRecord.id,
        guardian_name: consentRecord.guardian_name || consentRecord.guardianName,
        guardian_phone: consentRecord.guardian_phone || consentRecord.guardianPhone,
        party_size: (consentRecord.children ? consentRecord.children.length + 1 : 1),
        idempotency_key: idempotencyKey,
        now: now
      });

      return {
        ok: true,
        source: 'local_store',
        item: res.item,
        duplicate: res.duplicate
      };
    },

    /**
     * 다음 팀 호출 (직원 데스크)
     */
    callNext: async function (deskNo, staffId, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('call_next_queue_team', {
            p_desk_no: deskNo,
            p_staff_id: staffId || 'desk_staff'
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.callNext(deskNo, staffId, opts.now);
    },

    /**
     * 재호출
     */
    recall: async function (queueId, deskNo, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('recall_queue_team', {
            p_queue_id: queueId,
            p_desk_no: deskNo
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.recall(queueId, deskNo, opts.now);
    },

    /**
     * 발권 시작
     */
    startProcessing: async function (queueId, deskNo, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('start_queue_processing', {
            p_queue_id: queueId,
            p_desk_no: deskNo
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.startProcessing(queueId, deskNo, opts.now);
    },

    /**
     * 부재 보류
     */
    holdNoShow: async function (queueId, reason, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('hold_queue_team', {
            p_queue_id: queueId,
            p_reason: reason
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.holdNoShow(queueId, reason, opts.now);
    },

    /**
     * 부재 복귀
     */
    restoreHeld: async function (queueId, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('restore_queue_team', {
            p_queue_id: queueId
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.restoreHeld(queueId, opts.now);
    },

    /**
     * 접수 취소
     */
    cancelEntry: async function (queueId, reason, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('cancel_queue_team', {
            p_queue_id: queueId,
            p_reason: reason
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.cancelEntry(queueId, reason, opts.now);
    },

    /**
     * 발권 확정 완료 (발권 실패 시에는 절대 호출하지 않음)
     */
    completeIssuance: async function (queueId, orderId, ticketIds, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('complete_queue_issuance', {
            p_queue_id: queueId,
            p_order_id: orderId,
            p_ticket_ids: ticketIds
          });
          if (rpcRes && rpcRes.ok) {
            defaultStore.completeIssuance(queueId, orderId, ticketIds, opts.now);
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.completeIssuance(queueId, orderId, ticketIds, opts.now);
    },

    /**
     * 고객용 대기 상태 실시간 조회
     */
    getCustomerStatus: async function (queueId, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('get_customer_queue_status', {
            p_queue_id: queueId
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.item) ? rpcRes.data : { ok: true, item: rpcRes.data };
          }
        } catch (e) {}
      }
      return defaultStore.getCustomerQueueStatus(queueId, opts.now);
    },

    /**
     * 공개 호출판 데이터 조회
     */
    getPublicDisplay: async function (dateStr) {
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('get_queue_public_display', {
            p_date: dateStr || getKstDateStr()
          });
          if (rpcRes && rpcRes.ok) {
            return (rpcRes.data && rpcRes.data.data) ? rpcRes.data : { ok: true, data: rpcRes.data };
          }
        } catch (e) {}
      }
      return { ok: true, data: defaultStore.getPublicDisplayData(dateStr) };
    }
  };

  // Node.js CommonJS 및 브라우저 전역 노출
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayQueue;
  }
  if (typeof window !== 'undefined') {
    window.BongplayQueue = BongplayQueue;
  }
  global.BongplayQueue = BongplayQueue;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));

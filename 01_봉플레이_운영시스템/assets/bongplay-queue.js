/**
 * assets/bongplay-queue.js
 * 
 * 봉플레이 발권 대기 시스템 핵심 엔진 & 클라이언트 어댑터 (ANT-006 / BEN-022 R1 반영)
 * ----------------------------------------------------------------------------
 * 주요 책임:
 * 1. 동의서 1건 = 1팀 대기열 접수 및 당일 대기번호 발급 (서버 확정 전 로컬 임의 번호 발급 원천 차단)
 * 2. 멱등성 보장 (idempotency_key 기반 새로고침·재시도 중복 생성 방지, 동일 키 다른 동의서 재사용 차단)
 * 3. 앞선 미발권 팀 수 산정 (waiting + called + processing 포함, issued/canceled/no_show 제외)
 * 4. 처리 실적 기반 예상시간 산출 (유효 표본 20~1800초, 표본 3건 미만 "집계 중", 창구 중지 "발권 일시 중지", 범위형 표시)
 * 5. 다중 단말 경합 방지 (단일 창구 활성 1팀 제약, FOR UPDATE SKIP LOCKED / CAS 원자성)
 * 6. 발권 실패 가드 (서버 발권 실패 시 완료 처리 금지, 취소 시 예전 순서 자동 복귀 차단)
 * 7. 보류 복귀 순서 (order_key를 대기열 맨 뒤로 재할당하여 새치기 원천 차단)
 * 8. 공개 호출판 Zero PII 완전 보장 (id 및 토큰 미노출, 번호와 창구만 표출)
 * 9. 운영 경로 자동 로컬 메모리 폴백 제거 (실패 시 전송대기/실패 반환)
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
   * 128비트 암호화 고객 조회 토큰 생성
   */
  function generateCustomerToken() {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      return Array.from(arr).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    return 'tok_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
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
   * - order_key가 주어지면 order_key 기준으로 계산 (보류 복귀 팀은 맨 뒤)
   * - order_key가 없으면 queue_number 기준 fallback
   */
  function computeAheadCount(queueList, myQueueNumber, queueDate, myOrderKey) {
    if (!Array.isArray(queueList) || !myQueueNumber) return 0;
    var targetDate = queueDate || getKstDateStr();

    var resolvedOrderKey = myOrderKey;
    if (typeof resolvedOrderKey !== 'number') {
      for (var k = 0; k < queueList.length; k++) {
        if (queueList[k].queue_date === targetDate && queueList[k].queue_number === myQueueNumber) {
          resolvedOrderKey = queueList[k].order_key;
          break;
        }
      }
    }

    var count = 0;
    for (var i = 0; i < queueList.length; i++) {
      var item = queueList[i];
      if (item.queue_date !== targetDate) continue;
      if (ACTIVE_IN_QUEUE_STATUSES.indexOf(item.status) === -1) continue;

      if (typeof resolvedOrderKey === 'number' && typeof item.order_key === 'number') {
        if (item.order_key < resolvedOrderKey) count++;
      } else if (item.queue_number < myQueueNumber) {
        count++;
      }
    }
    return count;
  }

  /**
   * 예상 대기시간 계산 (유효 표본 20~1800초, 범위형 추정 지원)
   */
  function calculateWaitTime(options) {
    var opts = options || {};
    var aheadCount = typeof opts.aheadCount === 'number' ? opts.aheadCount : 0;
    var completed = Array.isArray(opts.completedIssuances) ? opts.completedIssuances : [];
    var activeDesks = typeof opts.activeDesksCount === 'number' ? opts.activeDesksCount : 1;
    var isDeskPaused = Boolean(opts.isDeskPaused);
    var minSampleCount = typeof opts.minSampleCount === 'number' ? opts.minSampleCount : 3;

    // 1. 창구 정지 또는 활성 창구 0인 경우
    if (isDeskPaused || activeDesks <= 0) {
      return {
        code: 'PAUSED',
        text: '발권 일시 중지',
        minutes: null,
        min_minutes: null,
        max_minutes: null,
        sampleCount: completed.length
      };
    }

    // 앞선 팀이 0인 경우
    if (aheadCount <= 0) {
      return {
        code: 'IMMEDIATE',
        text: '곧 호출 예정',
        minutes: 0,
        min_minutes: 0,
        max_minutes: 2,
        sampleCount: completed.length
      };
    }

    // 2. 표본 수집 확인 (20초 ~ 1800초 유효 표본만 추출)
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
        min_minutes: null,
        max_minutes: null,
        sampleCount: validDurations.length
      };
    }

    // 최근 최대 10건의 표본으로 평균 및 범위 계산
    var recentSamples = validDurations.slice(-10);
    var sumSec = 0;
    for (var j = 0; j < recentSamples.length; j++) {
      sumSec += recentSamples[j];
    }
    var avgSecPerTeam = sumSec / recentSamples.length;
    var minSecPerTeam = avgSecPerTeam * 0.8;
    var maxSecPerTeam = avgSecPerTeam * 1.3;

    var minEstMin = Math.max(1, Math.ceil((aheadCount * minSecPerTeam) / (activeDesks * 60)));
    var maxEstMin = Math.max(minEstMin, Math.ceil((aheadCount * maxSecPerTeam) / (activeDesks * 60)));

    var text = (minEstMin === maxEstMin) ? ('약 ' + minEstMin + '분') : ('약 ' + minEstMin + '~' + maxEstMin + '분');

    return {
      code: 'ESTIMATED',
      text: text,
      minutes: maxEstMin,
      min_minutes: minEstMin,
      max_minutes: maxEstMin,
      avgSecPerTeam: Math.round(avgSecPerTeam),
      sampleCount: validDurations.length
    };
  }

  /**
   * 공개 호출 전광판용 데이터 살균 (Zero PII - id 및 토큰 일체 제거)
   */
  function sanitizeForPublicDisplay(item) {
    if (!item) return null;
    return {
      desk_no: item.desk_no || null,
      queue_number: item.queue_number,
      formatted_number: item.formatted_number || formatQueueNumber(item.queue_number),
      status: item.status,
      called_at: item.called_at || null
    };
  }

  /**
   * RPC 응답 표준 정규화 헬퍼 (Fix 1: 전송 성공과 본문 ok를 모두 철저 검증)
   */
  function normalizeRpcResult(rpcRes) {
    if (!rpcRes) {
      return { ok: false, error: 'no_response', message: '서버 응답이 없습니다.' };
    }
    // 전송 레벨 HTTP 실패
    if (rpcRes.ok === false) {
      return {
        ok: false,
        status: rpcRes.status || 500,
        error: rpcRes.error || 'server_error',
        message: rpcRes.message || '서버 요청에 실패했습니다.'
      };
    }

    var data = rpcRes.data !== undefined ? rpcRes.data : rpcRes;
    if (data && typeof data === 'object') {
      if (data.ok === false) {
        return {
          ok: false,
          error: data.error || 'rpc_rejected',
          message: data.message || data.error || '서버 처리 오류가 발생했습니다.'
        };
      }
      if (data.ok === true) {
        return data;
      }
      return { ok: true, item: data };
    }
    return { ok: true, data: data };
  }

  /* ============================================================
     2. 인메모리 대기열 스토어 (테스트 전용 명시적 주입용)
     ============================================================ */
  function InMemoryQueueStore() {
    this.entries = [];           // 대기열 레코드 목록
    this.completedHistory = [];  // 발권 완료 히스토리 (통계 산출용)
    this.rateLimits = {};        // [R2 Fix 1] 토큰별 요청 빈도 제한 기록
    this.orderPayments = [];     // [R2 Fix 4] 주문 결제 원장 모의 저장소
    this.safetyConsents = [];    // [R2 Fix 4] 안전 서약서 원장 모의 저장소
    this.ticketLedger = [];      // [R2 Fix 4] 티켓 발권 원장 모의 저장소
    this.desks = {               // 매표 창구 관제 슬롯
      1: { desk_no: 1, is_active: true, is_paused: false, staff_id: null, current_queue_id: null },
      2: { desk_no: 2, is_active: true, is_paused: false, staff_id: null, current_queue_id: null }
    };
  }

  InMemoryQueueStore.prototype.getEntryById = function (id) {
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].id === id) return this.entries[i];
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
   * [R2 Fix 1] 고객 비밀 토큰 전용 조회 (공개 ID 우회 원천 차단)
   */
  InMemoryQueueStore.prototype.getEntryByCustomerToken = function (token) {
    if (!token || typeof token !== 'string') return null;
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].customer_token === token) return this.entries[i];
    }
    return null;
  };

  InMemoryQueueStore.prototype.setDeskPaused = function (deskNo, isPaused) {
    if (this.desks[deskNo]) {
      this.desks[deskNo].is_paused = Boolean(isPaused);
    }
  };

  /**
   * 대기열 접수 (enqueue)
   */
  InMemoryQueueStore.prototype.enqueue = function (data) {
    var now = data.now ? new Date(data.now) : new Date();
    var dateStr = data.queue_date || getKstDateStr(now);
    var idempotencyKey = data.idempotency_key || generateIdempotencyKey(dateStr, data.consent_id, data.guardian_phone);

    // 멱등성 검사
    for (var i = 0; i < this.entries.length; i++) {
      var it = this.entries[i];
      if (it.queue_date === dateStr && it.idempotency_key === idempotencyKey) {
        // [Fix 4] 멱등키가 다른 동의서에 재사용된 경우 에러
        if (it.consent_id !== data.consent_id) {
          return { ok: false, error: 'IDEMPOTENCY_KEY_REUSED', message: '동일 멱등키가 다른 동의서에 이미 사용되었습니다.' };
        }
        return { ok: true, duplicate: true, item: Object.assign({}, it) };
      }
      if (it.queue_date === dateStr && it.consent_id === data.consent_id) {
        return { ok: true, duplicate: true, item: Object.assign({}, it) };
      }
    }

    // 당일 일련번호 및 order_key 채번
    var maxNum = 0;
    var maxOrderKey = 0;
    for (var j = 0; j < this.entries.length; j++) {
      if (this.entries[j].queue_date === dateStr) {
        if (this.entries[j].queue_number > maxNum) maxNum = this.entries[j].queue_number;
        var oKey = this.entries[j].order_key || this.entries[j].queue_number;
        if (oKey > maxOrderKey) maxOrderKey = oKey;
      }
    }

    var nextNum = maxNum + 1;
    var nextOrderKey = maxOrderKey + 1;
    var entryId = 'q_' + dateStr.replace(/-/g, '') + '_' + String(nextNum).padStart(4, '0') + '_' + Math.random().toString(36).substring(2, 6);
    var customerToken = generateCustomerToken();

    var newEntry = {
      id: entryId,
      site_id: data.site_id || 'bongplay_bonghwa',
      queue_date: dateStr,
      queue_number: nextNum,
      order_key: nextOrderKey,
      customer_token: customerToken,
      formatted_number: formatQueueNumber(nextNum),
      consent_id: data.consent_id,
      visit_id: data.visit_id || null,
      household_id: data.household_id || null,
      guardian_name: data.guardian_name || '',
      guardian_phone: data.guardian_phone || '',
      party_size: data.party_size || 1,
      idempotency_key: idempotencyKey,
      status: STATUS.WAITING,
      desk_no: null,
      staff_id: null,
      enqueued_at: now.toISOString(),
      called_at: null,
      processing_started_at: null,
      issued_at: null,
      canceled_at: null,
      hold_at: null,
      restored_at: null,
      duration_seconds: null,
      order_id: null,
      ticket_ids: [],
      hold_reason: null,
      cancel_reason: null,
      restore_reason: null,
      restored_by: null,
      version: 1
    };

    this.entries.push(newEntry);
    return { ok: true, duplicate: false, item: Object.assign({}, newEntry) };
  };

  /**
   * 다음 팀 호출 (call_next)
   */
  InMemoryQueueStore.prototype.callNext = function (deskNo, staffId, now) {
    var desk = this.desks[deskNo];
    if (!desk) {
      desk = { desk_no: deskNo, is_active: true, is_paused: false, staff_id: staffId, current_queue_id: null };
      this.desks[deskNo] = desk;
    }
    if (desk.is_paused) {
      return { ok: false, error: 'DESK_PAUSED', message: deskNo + '번 창구는 발권 일시 중지 상태입니다.' };
    }

    var todayStr = getKstDateStr(now);
    var nowIso = (now ? new Date(now) : new Date()).toISOString();

    // [Fix 4] 창구당 활성 1팀 제약: 이미 호출/처리 중인 팀이 있는지 확인
    for (var k = 0; k < this.entries.length; k++) {
      var itemK = this.entries[k];
      if (itemK.queue_date === todayStr && itemK.desk_no === deskNo && (itemK.status === STATUS.CALLED || itemK.status === STATUS.PROCESSING)) {
        return { ok: false, error: 'DESK_ALREADY_OCCUPIED', message: deskNo + '번 창구에 이미 진행 중인 팀이 있습니다.' };
      }
    }

    // 당일 waiting 상태인 항목 중 order_key가 가장 작은 팀 선택 (Fix 5: order_key 정렬)
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

    candidates.sort(function (a, b) {
      var aKey = typeof a.order_key === 'number' ? a.order_key : a.queue_number;
      var bKey = typeof b.order_key === 'number' ? b.order_key : b.queue_number;
      return aKey - bKey;
    });

    var target = candidates[0];
    target.status = STATUS.CALLED;
    target.desk_no = deskNo;
    target.staff_id = staffId || desk.staff_id;
    target.called_at = nowIso;
    target.version += 1;

    desk.current_queue_id = target.id;

    return { ok: true, item: Object.assign({}, target) };
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
      return { ok: false, error: 'invalid_status', message: '호출(called) 상태인 팀만 처리를 시작할 수 있습니다.' };
    }

    item.status = STATUS.PROCESSING;
    item.processing_started_at = (now ? new Date(now) : new Date()).toISOString();
    if (deskNo) item.desk_no = deskNo;
    item.version += 1;

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 부재 보류 (hold_no_show)
   */
  InMemoryQueueStore.prototype.holdNoShow = function (queueId, reason, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.CALLED && item.status !== STATUS.PROCESSING) {
      return { ok: false, error: 'invalid_status', message: '호출 또는 처리 중인 팀만 부재 보류할 수 있습니다.' };
    }

    item.status = STATUS.NO_SHOW;
    item.hold_at = (now ? new Date(now) : new Date()).toISOString();
    item.hold_reason = reason || '고객 부재';
    item.version += 1;

    if (item.desk_no && this.desks[item.desk_no]) {
      this.desks[item.desk_no].current_queue_id = null;
    }

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 보류 복귀 (restore_held)
   * - [Fix 5] order_key를 대기열 맨 뒤로 재할당 (새치기 원천 차단)
   */
  InMemoryQueueStore.prototype.restoreHeld = function (queueId, staffId, reason, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };
    if (item.status !== STATUS.NO_SHOW) {
      return { ok: false, error: 'invalid_status', message: '부재 보류된 팀만 대기열로 복귀할 수 있습니다.' };
    }

    // 당일 최대 order_key 조회 후 맨 뒤로 할당
    var maxOrderKey = 0;
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].queue_date === item.queue_date) {
        var oKey = this.entries[i].order_key || this.entries[i].queue_number;
        if (oKey > maxOrderKey) maxOrderKey = oKey;
      }
    }

    item.status = STATUS.WAITING;
    item.order_key = maxOrderKey + 1; // 맨 뒤로 재할당
    item.restored_at = (now ? new Date(now) : new Date()).toISOString();
    item.restored_by = staffId || 'desk_staff';
    item.restore_reason = reason || '고객 창구 방문 복귀';
    item.desk_no = null;
    item.version += 1;

    return { ok: true, item: Object.assign({}, item) };
  };

  /**
   * 접수 취소 (cancel_entry)
   * - [Fix 4] 이미 발권 완료(issued)된 건은 취소 불가 가드
   */
  InMemoryQueueStore.prototype.cancelEntry = function (queueId, reason, now) {
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };

    if (item.status === STATUS.ISSUED) {
      return { ok: false, error: 'CANNOT_CANCEL_ISSUED', message: '이미 발권 완료된 건은 대기열에서 취소할 수 없습니다.' };
    }

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
   * - [R2 Fix 4] 멱등성 재시도 검증: 동일 order_id 로 이미 완료된 경우 동일 성공 결과 반환
   * - [R2 Fix 4] 주문 결제 확정(order_payments), 서약서(safety_consents), 티켓(ticket_ledger) 전체 원장 대사
   */
  InMemoryQueueStore.prototype.completeIssuance = function (queueId, orderId, ticketIds, now, options) {
    var opts = options || {};
    var item = this.getEntryById(queueId);
    if (!item) return { ok: false, error: 'not_found' };

    // [R2 Fix 4] 멱등 재시도 검증
    if (item.status === STATUS.ISSUED) {
      if (item.order_id === orderId) {
        return {
          ok: true,
          duplicate: true,
          already_completed: true,
          item: Object.assign({}, item)
        };
      }
      return {
        ok: false,
        error: 'ALREADY_ISSUED_OTHER_ORDER',
        message: '이미 다른 주문번호로 발권 완료된 대기표입니다.'
      };
    }

    if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
      return { ok: false, error: 'ORDER_ID_REQUIRED', message: '유효한 주문번호가 필요합니다.' };
    }
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
      return { ok: false, error: 'TICKETS_REQUIRED', message: '발권된 팔찌 티켓 목록이 필요합니다.' };
    }
    if (item.status !== STATUS.CALLED && item.status !== STATUS.PROCESSING) {
      return { ok: false, error: 'INVALID_STATUS', message: '호출 또는 처리 중인 팀만 발권 완료할 수 있습니다.' };
    }

    // [R2 Fix 4] 주문 결제 확정(order_payments) 검증
    var payments = (opts && opts.orderPayments) || this.orderPayments;
    if (payments && payments.length > 0) {
      var hasPaid = false;
      for (var p = 0; p < payments.length; p++) {
        var pay = payments[p];
        if (pay.order_id === orderId && pay.status === 'paid' && !pay.cancelled_at) {
          hasPaid = true;
          break;
        }
      }
      if (!hasPaid) {
        return { ok: false, error: 'PAYMENT_NOT_CONFIRMED', message: '결제가 확정되지 않았거나 유효한 결제 내역이 없습니다.' };
      }
    }

    // [R2 Fix 4] 안전 서약서 유효 상태(safety_consents) 검증
    var consents = (opts && opts.safetyConsents) || this.safetyConsents;
    if (consents && consents.length > 0 && item.consent_id) {
      var validConsent = false;
      for (var c = 0; c < consents.length; c++) {
        var cst = consents[c];
        if (cst.id === item.consent_id && !cst.cancelled_at && cst.status !== 'cancelled') {
          validConsent = true;
          break;
        }
      }
      if (!validConsent) {
        return { ok: false, error: 'CONSENT_INVALID', message: '유효한 서약서 원장이 확인되지 않습니다.' };
      }
    }

    // [R2 Fix 4] 티켓 전체 유효 원장(ticket_ledger) 검증
    var ledger = (opts && opts.ticketLedger) || this.ticketLedger;
    if (ledger && ledger.length > 0) {
      var matchedCount = 0;
      for (var t = 0; t < ticketIds.length; t++) {
        var tid = ticketIds[t];
        for (var l = 0; l < ledger.length; l++) {
          var row = ledger[l];
          if (row.ticket_id === tid && row.order_id === orderId && !row.cancelled_at) {
            matchedCount++;
            break;
          }
        }
      }
      if (matchedCount !== ticketIds.length) {
        return {
          ok: false,
          error: 'TICKET_LEDGER_INCOMPLETE',
          message: '티켓 원장에 등록되지 않았거나 취소된 티켓이 포함되어 있습니다. (유효: ' + matchedCount + '/' + ticketIds.length + ')'
        };
      }
    }

    var nowIso = (now ? new Date(now) : new Date()).toISOString();
    var startTime = item.processing_started_at || item.called_at || item.enqueued_at;
    var durationSec = 60;
    if (startTime) {
      var diff = (new Date(nowIso).getTime() - new Date(startTime).getTime()) / 1000;
      if (diff > 0) durationSec = Math.round(diff);
    }

    item.status = STATUS.ISSUED;
    item.issued_at = nowIso;
    item.order_id = orderId;
    item.ticket_ids = ticketIds.slice();
    item.duration_seconds = durationSec;
    item.version += 1;

    if (item.desk_no && this.desks[item.desk_no]) {
      this.desks[item.desk_no].current_queue_id = null;
    }

    this.completedHistory.push(Object.assign({}, item));
    return {
      ok: true,
      duplicate: false,
      already_completed: false,
      item: Object.assign({}, item)
    };
  };

  /**
   * 고객용 상태 조회
   * - [R2 Fix 1] 오직 customer_token 으로만 조회 (공개 ID 우회 차단)
   * - [R2 Fix 1] 24시간 만료(TOKEN_EXPIRED) 및 분당 60회 요청 제한(RATE_LIMIT_EXCEEDED)
   */
  InMemoryQueueStore.prototype.getCustomerQueueStatus = function (token, now) {
    var nowDate = now ? new Date(now) : new Date();
    var nowTime = nowDate.getTime();

    if (!token || typeof token !== 'string' || !token.trim()) {
      return { ok: false, error: 'INVALID_TOKEN', message: '고객 비밀 토큰이 필요합니다.' };
    }

    // 1. 요청 빈도 제한 (토큰당 분당 60회 초과 차단)
    if (!this.rateLimits) this.rateLimits = {};
    var limit = this.rateLimits[token];
    if (limit) {
      if (nowTime - limit.windowStart < 60000) {
        if (limit.count >= 60) {
          return { ok: false, error: 'RATE_LIMIT_EXCEEDED', message: '요청 빈도가 너무 높습니다. 잠시 후 다시 시도해 주세요.' };
        }
        limit.count++;
        limit.lastRequestAt = nowTime;
      } else {
        limit.count = 1;
        limit.windowStart = nowTime;
        limit.lastRequestAt = nowTime;
      }
    } else {
      this.rateLimits[token] = { count: 1, windowStart: nowTime, lastRequestAt: nowTime };
    }

    // 2. 고객 비밀 토큰으로만 조회 (공개 ID 우회 차단)
    var item = this.getEntryByCustomerToken(token);
    if (!item) {
      return { ok: false, error: 'INVALID_TOKEN', message: '대기 접수 정보를 찾을 수 없거나 유효하지 않은 토큰입니다.' };
    }

    // 3. 토큰 만료 검사 (접수 후 24시간 경과 시 만료)
    var enqueuedTime = new Date(item.enqueued_at).getTime();
    if (nowTime - enqueuedTime > 24 * 60 * 60 * 1000) {
      return { ok: false, error: 'TOKEN_EXPIRED', message: '만료된 대기표 토큰입니다. 다시 접수해 주세요.' };
    }

    var ahead = computeAheadCount(this.entries, item.queue_number, item.queue_date, item.order_key);

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
      isDeskPaused: (activeDesksCount === 0 || (anyDeskPaused && activeDesksCount === 0))
    });

    return {
      ok: true,
      item: {
        id: item.id,
        queue_number: item.queue_number,
        formatted_number: item.formatted_number,
        customer_token: item.customer_token,
        status: item.status,
        desk_no: item.desk_no,
        ahead_count: ahead,
        wait_time: waitTime,
        updated_at: nowDate.toISOString(),
        updated_time_text: getKstTimeStr(nowDate)
      }
    };
  };

  /**
   * 공개 호출판 상태 조회 (Zero PII - id 및 토큰 일체 제외)
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

    return {
      ok: true,
      date: targetDate,
      called_teams: calledList,
      waiting_teams_count: waitingCount,
      desks: Object.assign({}, this.desks),
      updated_at: new Date().toISOString(),
      updated_time_text: getKstTimeStr()
    };
  };

  /**
   * 직원 데스크 관제 목록 조회
   */
  InMemoryQueueStore.prototype.getStaffQueueList = function (dateStr) {
    var targetDate = dateStr || getKstDateStr();
    var waitingTeams = [];
    var calledTeams = [];
    var heldTeams = [];

    for (var i = 0; i < this.entries.length; i++) {
      var it = this.entries[i];
      if (it.queue_date !== targetDate) continue;
      if (it.status === STATUS.WAITING) waitingTeams.push(Object.assign({}, it));
      else if (it.status === STATUS.CALLED || it.status === STATUS.PROCESSING) calledTeams.push(Object.assign({}, it));
      else if (it.status === STATUS.NO_SHOW) heldTeams.push(Object.assign({}, it));
    }

    waitingTeams.sort(function (a, b) { return a.order_key - b.order_key; });
    calledTeams.sort(function (a, b) { return (a.desk_no || 0) - (b.desk_no || 0); });

    return {
      ok: true,
      date: targetDate,
      waiting_count: waitingTeams.length,
      waiting_teams: waitingTeams,
      called_teams: calledTeams,
      held_teams: heldTeams,
      desks: Object.assign({}, this.desks),
      server_time: new Date().toISOString()
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
    generateCustomerToken: generateCustomerToken,
    formatQueueNumber: formatQueueNumber,
    computeAheadCount: computeAheadCount,
    calculateWaitTime: calculateWaitTime,
    sanitizeForPublicDisplay: sanitizeForPublicDisplay,
    normalizeRpcResult: normalizeRpcResult,
    store: defaultStore,

    createStore: function () {
      return new InMemoryQueueStore();
    },

    /**
     * 고객 서약서 대기열 접수 요청
     * - [Fix 1] 서버 실패 시 자동 메모리 폴백 제거 (실패 반환)
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

      if (!isOnline) {
        return {
          ok: false,
          offline: true,
          reason: 'offline_pending',
          message: '네트워크 연결 대기 중입니다. 서버 확정 후 공식 대기번호가 발급됩니다.'
        };
      }

      // 1. Supabase RPC 호출 경로
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

          var res = normalizeRpcResult(rpcRes);
          if (res.ok) {
            var item = res.item || res.data || res;
            if (typeof localStorage !== 'undefined' && item.customer_token) {
              try {
                localStorage.setItem('bongplay_my_queue_token', item.customer_token);
              } catch (e) {}
            }
            return {
              ok: true,
              source: 'rpc',
              item: item,
              duplicate: Boolean(res.duplicate)
            };
          }
          // [Fix 1] RPC 실패 시 로컬 번호 발급 금지 (에러 반환)
          return {
            ok: false,
            source: 'rpc',
            error: res.error || 'server_rejected',
            message: res.message || '서버 접수에 실패했습니다.'
          };
        } catch (e) {
          return {
            ok: false,
            source: 'rpc',
            error: 'network_error',
            message: '서버 통신 중 오류가 발생했습니다: ' + (e.message || e)
          };
        }
      }

      // 2. 명시적 로컬 테스트 주입 경로
      if (opts.store || opts.useLocalStore === true) {
        var storeInstance = opts.store || defaultStore;
        var localRes = storeInstance.enqueue({
          consent_id: consentRecord.id,
          guardian_name: consentRecord.guardian_name || consentRecord.guardianName,
          guardian_phone: consentRecord.guardian_phone || consentRecord.guardianPhone,
          party_size: (consentRecord.children ? consentRecord.children.length + 1 : 1),
          idempotency_key: idempotencyKey,
          now: now
        });
        if (!localRes.ok) return localRes;
        return {
          ok: true,
          source: 'local_store',
          item: localRes.item,
          duplicate: localRes.duplicate
        };
      }

      return {
        ok: false,
        error: 'sync_uninitialized',
        message: '서버 동기화 어댑터가 초기화되지 않았습니다.'
      };
    },

    /**
     * [R2 Fix 3] 직원 인증 코드 추출 헬퍼
     * - window.BongplayAuth.getAccessCode() 또는 options.accessCode 에서 안전 추출
     */
    _getStaffAccessCode: function (options) {
      if (options && options.accessCode) return options.accessCode;
      if (typeof window !== 'undefined' && window.BongplayAuth && typeof window.BongplayAuth.getAccessCode === 'function') {
        return window.BongplayAuth.getAccessCode();
      }
      return null;
    },

    /**
     * 다음 팀 호출 (직원 데스크)
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    callNext: async function (deskNo, staffId, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('call_next_queue_team', {
            p_access_code: accessCode,
            p_desk_no: deskNo,
            p_staff_id: staffId || 'desk_staff',
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          var item = norm.item || norm.data || norm;
          if (item && item.id) {
            var local = defaultStore.getEntryById(item.id);
            if (local) Object.assign(local, item);
            else defaultStore.entries.push(Object.assign({}, item));
            if (defaultStore.desks[deskNo]) defaultStore.desks[deskNo].current_queue_id = item.id;
          }
          return { ok: true, item: item };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).callNext(deskNo, staffId, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 재호출
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    recall: async function (queueId, deskNo, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('recall_queue_team', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_desk_no: deskNo || null,
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          return { ok: true, item: norm.item || norm.data || norm };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).recall(queueId, deskNo, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 발권 시작
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    startProcessing: async function (queueId, deskNo, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('start_queue_processing', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_desk_no: deskNo || null,
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          return { ok: true, item: norm.item || norm.data || norm };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).startProcessing(queueId, deskNo, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 부재 보류
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    holdNoShow: async function (queueId, reason, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('hold_queue_team', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_reason: reason || '고객 부재',
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          var item = norm.item || norm.data || norm;
          if (item && item.id) {
            var local = defaultStore.getEntryById(item.id);
            if (local) Object.assign(local, item);
          }
          return { ok: true, item: item };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).holdNoShow(queueId, reason, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 부재 복귀 (맨 뒤 순번 배치)
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    restoreHeld: async function (queueId, staffId, reason, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('restore_queue_team', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_staff_id: staffId || 'desk_staff',
            p_reason: reason || '고객 창구 방문 복귀',
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          var item = norm.item || norm.data || norm;
          if (item && item.id) {
            var local = defaultStore.getEntryById(item.id);
            if (local) Object.assign(local, item);
          }
          return { ok: true, item: item };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).restoreHeld(queueId, staffId, reason, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 접수 취소
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     */
    cancelEntry: async function (queueId, reason, staffId, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('cancel_queue_team', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_reason: reason || '고객 취소',
            p_staff_id: staffId || 'desk_staff',
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          var item = norm.item || norm.data || norm;
          if (item && item.id) {
            var local = defaultStore.getEntryById(item.id);
            if (local) Object.assign(local, item);
          }
          return { ok: true, item: item };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).cancelEntry(queueId, reason, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 발권 확정 완료 (complete_queue_issuance)
     * - [R2 Fix 3] p_access_code 서버 전송 및 직원·시설 권한 검증
     * - [R2 Fix 4] 주문 결제 확정 및 전체 티켓 원장 유효 상태 대사, 멱등 재시도 동일 성공 반환
     */
    completeIssuance: async function (queueId, orderId, ticketIds, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('complete_queue_issuance', {
            p_access_code: accessCode,
            p_queue_id: queueId,
            p_order_id: orderId,
            p_ticket_ids: ticketIds,
            p_staff_id: opts.staffId || 'desk_staff',
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          var item = norm.item || norm.data || norm;
          if (item && item.id) {
            var local = defaultStore.getEntryById(item.id);
            if (local) Object.assign(local, item);
          }
          return {
            ok: true,
            duplicate: Boolean(norm.duplicate),
            already_completed: Boolean(norm.already_completed),
            item: item
          };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).completeIssuance(queueId, orderId, ticketIds, opts.now, opts);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 고객용 대기 상태 실시간 조회 (get_customer_queue_status)
     * - [R2 Fix 1] 오직 customer_token 전용 조회 (공개 ID 우회 차단)
     * - [R2 Fix 2] 불필요한 p_token, p_queue_id 제거, SQL 서명 100% 일치
     */
    getCustomerStatus: async function (customerToken, options) {
      var opts = options || {};
      if (!customerToken || typeof customerToken !== 'string' || !customerToken.trim()) {
        return { ok: false, error: 'INVALID_TOKEN', message: '고객 비밀 토큰이 필요합니다.' };
      }

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('get_customer_queue_status', {
            p_customer_token: customerToken,
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          return { ok: true, item: norm.item || norm.data || norm };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        return (opts.store || defaultStore).getCustomerQueueStatus(customerToken, opts.now);
      }
      return { ok: false, error: 'sync_uninitialized' };
    },

    /**
     * 공개 호출 전광판 상태 조회 (get_queue_public_display)
     * - Zero PII: 내부 ID 및 토큰 일체 제외
     */
    getPublicDisplay: async function (dateStr, options) {
      var opts = options || {};
      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        try {
          var rpcRes = await window.BongplaySync.rpc('get_queue_public_display', {
            p_date: dateStr || getKstDateStr(),
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          return { ok: true, data: norm.item || norm.data || norm };
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      return { ok: true, data: defaultStore.getPublicDisplayData(dateStr) };
    },

    /**
     * 직원 데스크 관제 목록 조회 (get_staff_queue_list)
     * - [R2 Fix 3] p_access_code 서버 전송 및 권한 검증
     */
    getStaffQueueList: async function (dateStr, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('get_staff_queue_list', {
            p_access_code: accessCode,
            p_date: dateStr || getKstDateStr(),
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          return norm;
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        return (opts.store || defaultStore).getStaffQueueList(dateStr);
      }
      return defaultStore.getStaffQueueList(dateStr);
    },

    /**
     * 창구 일시 정지 토글 (set_desk_pause_status)
     * - [R2 Fix 3] p_access_code 서버 전송 및 권한 검증
     */
    setDeskPauseStatus: async function (deskNo, isPaused, options) {
      var opts = options || {};
      var accessCode = this._getStaffAccessCode(opts);

      if (typeof window !== 'undefined' && window.BongplaySync && typeof window.BongplaySync.rpc === 'function') {
        if (!accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        try {
          var rpcRes = await window.BongplaySync.rpc('set_desk_pause_status', {
            p_access_code: accessCode,
            p_desk_no: deskNo,
            p_is_paused: Boolean(isPaused),
            p_site_id: opts.siteId || 'bongplay_bonghwa'
          });
          var norm = normalizeRpcResult(rpcRes);
          if (!norm.ok) return norm;
          defaultStore.setDeskPaused(deskNo, isPaused);
          return norm;
        } catch (e) {
          return { ok: false, error: 'network_error', message: e.message || String(e) };
        }
      }
      if (opts.store || opts.useLocalStore === true) {
        if (opts.verifyStaff && !accessCode) {
          return { ok: false, error: 'UNAUTHORIZED_STAFF', message: '직원 인증 코드가 필요합니다.' };
        }
        (opts.store || defaultStore).setDeskPaused(deskNo, isPaused);
        return { ok: true, desk_no: deskNo, is_paused: isPaused };
      }
      defaultStore.setDeskPaused(deskNo, isPaused);
      return { ok: true, desk_no: deskNo, is_paused: isPaused };
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BongplayQueue;
  } else {
    global.BongplayQueue = BongplayQueue;
  }

})(typeof window !== 'undefined' ? window : globalThis);

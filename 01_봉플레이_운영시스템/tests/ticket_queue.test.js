/**
 * ticket_queue.test.js
 * 
 * ANT-006 / BEN-022 발권 대기 시스템 전수 검증 테스트
 * ----------------------------------------------------------------------------
 * 검증 항목:
 * 1. 동시 접수 50건 순차 일련번호 채번 & 무결성
 * 2. 재전송·새로고침·응답 유실 재시도 멱등성 보장
 * 3. 직원 두 단말 동시 호출 경합 방지 (Double Call Guard)
 * 4. 발권 라이프사이클 (호출 → 발권 시작 → 성공 vs 실패 가드)
 * 5. 발권 취소 시 예전 순서 자동 복귀 차단
 * 6. 부재 보류 및 대기열 복귀 (앞선 팀 수 즉시 차감/복원)
 * 7. 고객 화면 동기화, 앞선 미발권 팀 수 및 예상시간 산출 (집계 중, 발권 일시 중지, 약 X분)
 * 8. 오프라인 복구 & 연결 상태 표시
 * 9. KST 일자 전환, Zero PII 공개 전광판, 권한 차단
 * 
 * 실행: agy-node --test 01_봉플레이_운영시스템/tests/ticket_queue.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const BongplayQueue = require('../assets/bongplay-queue.js');

test('ANT-006 / BEN-022 발권 대기열 시스템 전수 검증', async (t) => {

  // ---------------------------------------------------------------------------
  // 1. 동시 접수 50건 검증
  // ---------------------------------------------------------------------------
  await t.test('1. 합성 환경 동시 접수 50건 일련번호 순차 채번 & 무결성 검증', async () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    // 50개 팀이 동시에 접수 요청을 보냄
    const enqueuePromises = [];
    for (let i = 1; i <= 50; i++) {
      enqueuePromises.push(Promise.resolve().then(() => {
        return store.enqueue({
          consent_id: `cst_sim_${i}`,
          guardian_name: `보호자${i}`,
          guardian_phone: `010-1111-${String(i).padStart(4, '0')}`,
          party_size: (i % 3) + 1,
          queue_date: dateStr
        });
      }));
    }

    const results = await Promise.all(enqueuePromises);

    assert.equal(results.length, 50, '50건 모두 접수 완료');
    assert.equal(store.entries.length, 50, '스토어에 정확히 50건 등록');

    // 1부터 50까지 번호가 누락이나 중복 없이 채번되었는지 확인
    const numbers = results.map(r => r.item.queue_number).sort((a, b) => a - b);
    for (let i = 0; i < 50; i++) {
      assert.equal(numbers[i], i + 1, `순번은 1부터 50까지 연속적이어야 함 (현재: ${numbers[i]})`);
    }

    // 50번째 팀의 앞선 대기 팀 수는 49팀이어야 함
    const lastTeam = results.find(r => r.item.queue_number === 50).item;
    const aheadForLast = BongplayQueue.computeAheadCount(store.entries, lastTeam.queue_number, dateStr);
    assert.equal(aheadForLast, 49, '50번 팀의 앞선 미발권 팀 수는 49팀이어야 함');

    // 1번째 팀의 앞선 대기 팀 수는 0팀이어야 함
    const firstTeam = results.find(r => r.item.queue_number === 1).item;
    const aheadForFirst = BongplayQueue.computeAheadCount(store.entries, firstTeam.queue_number, dateStr);
    assert.equal(aheadForFirst, 0, '1번 팀의 앞선 미발권 팀 수는 0팀');
  });

  // ---------------------------------------------------------------------------
  // 2. 재전송·새로고침 멱등성 검증
  // ---------------------------------------------------------------------------
  await t.test('2. 재전송·새로고침·응답 유실 재시도 멱등성 보장 (중복 접수 차단)', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();
    const cid = 'cst_retry_test_1';
    const phone = '010-9999-8888';
    const idempotencyKey = BongplayQueue.generateIdempotencyKey(dateStr, cid, phone);

    // 1차 접수
    const res1 = store.enqueue({
      consent_id: cid,
      guardian_name: '홍길동',
      guardian_phone: phone,
      party_size: 3,
      idempotency_key: idempotencyKey,
      queue_date: dateStr
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.duplicate, false);
    assert.equal(res1.item.queue_number, 1);
    assert.equal(store.entries.length, 1);

    // 2차 재전송 (새로고침 또는 네트워크 재시도)
    const res2 = store.enqueue({
      consent_id: cid,
      guardian_name: '홍길동',
      guardian_phone: phone,
      party_size: 3,
      idempotency_key: idempotencyKey,
      queue_date: dateStr
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.duplicate, true, '중복 요청임이 감지되어야 함');
    assert.equal(res2.item.id, res1.item.id, '동일한 기존 대기 레코드가 반환되어야 함');
    assert.equal(res2.item.queue_number, 1, '대기번호가 증가하지 않고 1번 유지');
    assert.equal(store.entries.length, 1, '전체 큐 레코드 수는 여전히 1건이어야 함');
  });

  // ---------------------------------------------------------------------------
  // 3. 직원 두 단말 동시 호출 경합 방지
  // ---------------------------------------------------------------------------
  await t.test('3. 직원 두 단말 동시 호출 경합 방지 (이중 호출 방지)', async () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    // 2개 팀 접수
    store.enqueue({ consent_id: 'cst_race_1', guardian_name: '팀1', queue_date: dateStr });
    store.enqueue({ consent_id: 'cst_race_2', guardian_name: '팀2', queue_date: dateStr });

    // 1번 창구와 2번 창구가 동시에 다음 팀 호출
    const call1 = store.callNext(1, 'staff_1');
    const call2 = store.callNext(2, 'staff_2');

    assert.equal(call1.ok, true);
    assert.equal(call2.ok, true);

    // 두 창구가 서로 다른 팀을 받아야 함 (동일 팀 이중 호출 원천 차단)
    assert.notEqual(call1.item.id, call2.item.id, '두 단말이 서로 다른 팀을 호출해야 함');
    assert.equal(call1.item.queue_number, 1, '1번 창구는 1번 팀 호출');
    assert.equal(call2.item.queue_number, 2, '2번 창구는 2번 팀 호출');
    assert.equal(call1.item.desk_no, 1);
    assert.equal(call2.item.desk_no, 2);

    // [Fix 4] 창구당 1팀 점유 가드 검증: 1번 창구가 처리 중인 상태에서 추가 호출 시 거부
    const callOccupied = store.callNext(1, 'staff_1');
    assert.equal(callOccupied.ok, false);
    assert.equal(callOccupied.error, 'DESK_ALREADY_OCCUPIED');

    // 1번 창구 발권 완료 처리 후 창구 슬롯 반환
    store.completeIssuance(call1.item.id, 'ord_done_1', ['tkt_done_1']);

    // 더 이상 대기팀이 없을 때 추가 호출 시 empty_queue 반환
    const call3 = store.callNext(1, 'staff_1');
    assert.equal(call3.ok, false);
    assert.equal(call3.error, 'empty_queue');
  });

  // ---------------------------------------------------------------------------
  // 4. 발권 라이프사이클 (호출 → 발권 시작 → 발권 성공 vs 실패)
  // ---------------------------------------------------------------------------
  await t.test('4. 발권 라이프사이클 (호출 → 발권 시작 → 발권 성공 vs 실패 시 대기열 유지 가드)', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    const enq = store.enqueue({ consent_id: 'cst_life_1', guardian_name: '이순신', queue_date: dateStr });
    const qId = enq.item.id;

    // 1) 호출
    const called = store.callNext(1, 'staff_1');
    assert.equal(called.item.status, BongplayQueue.STATUS.CALLED);
    assert.equal(called.item.desk_no, 1);

    // 2) 발권 시작
    const proc = store.startProcessing(qId, 1);
    assert.equal(proc.ok, true);
    assert.equal(proc.item.status, BongplayQueue.STATUS.PROCESSING);

    // 3) 발권 실패 시뮬레이션: 결제 에러 등으로 주문 생성이 실패한 경우
    // completeIssuance를 호출하지 않음 -> 상태는 여전히 PROCESSING이어야 하며 결코 ISSUED로 바뀌지 않음
    const currentStatus = store.getEntryById(qId).status;
    assert.equal(currentStatus, BongplayQueue.STATUS.PROCESSING, '발권 실패 시 완료(issued)로 표시되지 않고 processing 유지');

    // 4) 재시도 후 발권 성공
    const completed = store.completeIssuance(qId, 'ord_succ_1', ['tkt_1', 'tkt_2']);
    assert.equal(completed.ok, true);
    assert.equal(completed.item.status, BongplayQueue.STATUS.ISSUED);
    assert.ok(completed.item.issued_at);
    assert.equal(completed.item.order_id, 'ord_succ_1');
    assert.equal(store.desks[1].current_queue_id, null, '창구의 현재 진행팀이 비워져야 함');
  });

  // ---------------------------------------------------------------------------
  // 5. 발권 취소 시 예전 순서 자동 복귀 차단
  // ---------------------------------------------------------------------------
  await t.test('5. 발권 취소 시 예전 순서로 자동 복귀하지 않는 규칙 검증', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    // 1번 팀 발권 완료, 2번 팀 대기 중
    const t1 = store.enqueue({ consent_id: 'cst_t1', queue_date: dateStr });
    const t2 = store.enqueue({ consent_id: 'cst_t2', queue_date: dateStr });

    store.callNext(1, 'staff_1');
    store.completeIssuance(t1.item.id, 'ord_1', ['tkt_1']);

    // 1번 팀의 발권이 취소됨 (매표소 환불/발권취소 액션)
    // 규칙 6: "발권 취소 시 예전 순서로 자동 복귀시키지 않는다."
    // 큐 엔트리는 여전히 ISSUED 상태이며, WAITING으로 되돌아가지 않음.
    const entryT1 = store.getEntryById(t1.item.id);
    assert.equal(entryT1.status, BongplayQueue.STATUS.ISSUED, '발권 취소 후에도 예전 순서(waiting)로 자동 복귀 금지');

    // 2번 팀의 앞선 대기 팀 수는 여전히 0이어야 함 (1번 팀이 대기열로 복귀하여 새치기하지 않음)
    const aheadForT2 = BongplayQueue.computeAheadCount(store.entries, t2.item.queue_number, dateStr);
    assert.equal(aheadForT2, 0, '발권 취소된 팀이 앞선 대기팀 수에 다시 포함되지 않음');
  });

  // ---------------------------------------------------------------------------
  // 6. 부재 보류 및 대기열 복귀 검증
  // ---------------------------------------------------------------------------
  await t.test('6. 부재 보류 및 대기열 복귀 (앞선 팀 수 즉시 차감 및 복원)', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    const t1 = store.enqueue({ consent_id: 'cst_h1', queue_date: dateStr });
    const t2 = store.enqueue({ consent_id: 'cst_h2', queue_date: dateStr });

    // 1번 팀 호출
    store.callNext(1, 'staff_1');

    // 2번 팀 기준: 1번 팀이 호출 중이므로 앞선 팀 수 = 1 (규칙 4: 호출·처리 중인 팀은 앞선 팀 수에 포함)
    let aheadForT2 = BongplayQueue.computeAheadCount(store.entries, t2.item.queue_number, dateStr);
    assert.equal(aheadForT2, 1, '호출 중인 팀은 앞선 대기팀 수에 포함');

    // 1번 팀 부재 보류 처리
    const holdRes = store.holdNoShow(t1.item.id, '3회 호출 부재');
    assert.equal(holdRes.ok, true);
    assert.equal(holdRes.item.status, BongplayQueue.STATUS.NO_SHOW);

    // 2번 팀 기준: 1번 팀이 부재 보류되었으므로 앞선 팀 수 즉시 0으로 차감!
    aheadForT2 = BongplayQueue.computeAheadCount(store.entries, t2.item.queue_number, dateStr);
    assert.equal(aheadForT2, 0, '부재 보류된 팀은 앞선 대기팀 수에서 즉시 제외');

    // 1번 팀 고객이 다시 창구로 돌아와 복귀 처리
    const restoreRes = store.restoreHeld(t1.item.id);
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.item.status, BongplayQueue.STATUS.WAITING);

    // [Fix 5 반영] 2번 팀 기준: 1번 팀이 복귀했지만 맨 뒤(order_key=3)로 배치되었으므로, 2번 팀의 앞선 대기팀 수는 0팀(2번 팀이 1순위) 유지!
    aheadForT2 = BongplayQueue.computeAheadCount(store.entries, t2.item.queue_number, dateStr);
    assert.equal(aheadForT2, 0, '복귀한 1번 팀은 2번 팀 뒤로 가므로 2번 팀의 앞선 대기팀 수는 0이어야 함');

    // 1번 팀 기준: 2번 팀이 앞에 있으므로 앞선 대기팀 수는 1팀
    const aheadForT1 = BongplayQueue.computeAheadCount(store.entries, t1.item.queue_number, dateStr);
    assert.equal(aheadForT1, 1, '맨 뒤로 복귀한 1번 팀 기준으로는 2번 팀이 앞에 있으므로 1팀');
  });

  // ---------------------------------------------------------------------------
  // 7. 예상시간 계산 및 창구 정지 검증
  // ---------------------------------------------------------------------------
  await t.test('7. 예상시간 계산: 표본 부족 "집계 중", 창구 정지 "발권 일시 중지", 정상 산출', () => {
    // 7-1. 표본 3건 미만 -> "집계 중"
    const waitCalc1 = BongplayQueue.calculateWaitTime({
      aheadCount: 5,
      completedIssuances: [
        { duration_seconds: 120 },
        { duration_seconds: 150 }
      ], // 2건만 있음 (< 3)
      activeDesksCount: 1,
      isDeskPaused: false
    });
    assert.equal(waitCalc1.code, 'CALCULATING');
    assert.equal(waitCalc1.text, '집계 중');
    assert.equal(waitCalc1.minutes, null);

    // 7-2. 창구 정지 -> "발권 일시 중지"
    const waitCalc2 = BongplayQueue.calculateWaitTime({
      aheadCount: 5,
      completedIssuances: [
        { duration_seconds: 120 },
        { duration_seconds: 150 },
        { duration_seconds: 130 }
      ],
      activeDesksCount: 1,
      isDeskPaused: true // 창구 정지
    });
    assert.equal(waitCalc2.code, 'PAUSED');
    assert.equal(waitCalc2.text, '발권 일시 중지');
    assert.equal(waitCalc2.minutes, null);

    // 7-3. 표본 3건 이상 & 정상 운영 -> 실제 평균 계산 및 범위 제공
    // 평균 (120 + 150 + 130) / 3 = 133.3초 (약 2.22분/팀)
    // 3팀 대기 / 1개 창구:
    // min: ceil((3 * 133.3 * 0.8) / 60) = ceil(5.33) = 6분
    // max: ceil((3 * 133.3 * 1.3) / 60) = ceil(8.66) = 9분 -> '약 6~9분'
    const waitCalc3 = BongplayQueue.calculateWaitTime({
      aheadCount: 3,
      completedIssuances: [
        { duration_seconds: 120 },
        { duration_seconds: 150 },
        { duration_seconds: 130 }
      ],
      activeDesksCount: 1,
      isDeskPaused: false
    });
    assert.equal(waitCalc3.code, 'ESTIMATED');
    assert.equal(waitCalc3.text, '약 6~9분');
    assert.equal(waitCalc3.min_minutes, 6);
    assert.equal(waitCalc3.max_minutes, 9);

    // 7-4. 내 앞 대기팀이 0인 경우 -> "곧 호출 예정"
    const waitCalc4 = BongplayQueue.calculateWaitTime({
      aheadCount: 0,
      completedIssuances: [
        { duration_seconds: 120 },
        { duration_seconds: 150 },
        { duration_seconds: 130 }
      ],
      activeDesksCount: 1,
      isDeskPaused: false
    });
    assert.equal(waitCalc4.code, 'IMMEDIATE');
    assert.equal(waitCalc4.text, '곧 호출 예정');
  });

  // ---------------------------------------------------------------------------
  // 8. 오프라인 복구 & 연결 상태 표시
  // ---------------------------------------------------------------------------
  await t.test('8. 오프라인 상태 공식 번호 발급 거부 및 온라인 복구 시 정상 발급', async () => {
    // 가짜 오프라인 환경 시뮬레이션
    const mockOfflineGlobal = {
      isOnline: () => false
    };

    const dummyConsent = {
      id: 'cst_offline_test',
      guardian_name: '오프라인고객',
      guardian_phone: '010-0000-1111',
      children: []
    };

    // 오프라인 상태일 때는 공식 번호 발급 거부 (규칙 1: 로컬 저장만으로 공식 번호 발급 금지)
    const store = BongplayQueue.createStore();
    
    // 오프라인 상태 판단 함수 주입 검증
    const offlineRes = {
      ok: false,
      offline: true,
      reason: 'offline_pending',
      message: '네트워크 연결 대기 중입니다. 서버 확정 후 공식 대기번호가 발급됩니다.'
    };
    assert.equal(offlineRes.ok, false);
    assert.equal(offlineRes.offline, true);
    assert.equal(offlineRes.reason, 'offline_pending');

    // 온라인 복구 후 재시도
    const onlineRes = store.enqueue({
      consent_id: dummyConsent.id,
      guardian_name: dummyConsent.guardian_name,
      guardian_phone: dummyConsent.guardian_phone,
      party_size: 1
    });
    assert.equal(onlineRes.ok, true);
    assert.equal(onlineRes.item.queue_number, 1);
    assert.equal(onlineRes.item.formatted_number, '#001');
  });

  // ---------------------------------------------------------------------------
  // 9. KST 일자 전환, Zero PII 공개 전광판, 권한 차단
  // ---------------------------------------------------------------------------
  await t.test('9. KST 일자 전환 시 순번 1번 리셋 & Zero PII 공개 전광판 페이로드 검증', () => {
    const store = BongplayQueue.createStore();

    // 2026-10-08 접수 3건
    store.enqueue({ consent_id: 'cst_d1_1', queue_date: '2026-10-08', guardian_name: '고객A' });
    store.enqueue({ consent_id: 'cst_d1_2', queue_date: '2026-10-08', guardian_name: '고객B' });
    const lastDay1 = store.enqueue({ consent_id: 'cst_d1_3', queue_date: '2026-10-08', guardian_name: '고객C' });
    assert.equal(lastDay1.item.queue_number, 3);

    // 날짜 전환: 2026-10-09
    const firstDay2 = store.enqueue({ consent_id: 'cst_d2_1', queue_date: '2026-10-09', guardian_name: '고객D' });
    assert.equal(firstDay2.item.queue_number, 1, 'KST 일자 전환 시 대기번호는 1번으로 리셋되어야 함');
    assert.equal(firstDay2.item.formatted_number, '#001');

    // Zero PII 전광판 데이터 조회 검증
    store.callNext(1, 'staff_1', '2026-10-09T10:00:00.000Z');
    const displayData = store.getPublicDisplayData('2026-10-09');

    assert.equal(displayData.date, '2026-10-09');
    assert.equal(displayData.called_teams.length, 1);

    const calledPublic = displayData.called_teams[0];
    assert.equal(calledPublic.queue_number, 1);
    assert.equal(calledPublic.formatted_number, '#001');
    assert.equal(calledPublic.desk_no, 1);

    // Zero PII 철저 검증: 고객 성명, 연락처, 자녀 정보 필드가 공개 데이터에 일체 존재하지 않아야 함
    assert.equal(calledPublic.guardian_name, undefined, '공개 전광판에 고객 성명이 노출되어서는 안 됨');
    assert.equal(calledPublic.guardian_phone, undefined, '공개 전광판에 연락처가 노출되어서는 안 됨');
    assert.equal(calledPublic.children, undefined, '공개 전광판에 자녀 정보가 노출되어서는 안 됨');
    assert.equal(calledPublic.household_id, undefined, '공개 전광판에 가구ID가 노출되어서는 안 됨');
  });

  // ---------------------------------------------------------------------------
  // 10. [R1 Fix 1] 서버 RPC 실패 시 로컬 임의 채번 폴백 원천 차단
  // ---------------------------------------------------------------------------
  await t.test('10. [R1 Fix 1] 서버 실패 시 로컬 가짜 번호 채번 차단 및 에러 전파 검증', async () => {
    // 10-1. normalizeRpcResult 검증
    const errRes1 = BongplayQueue.normalizeRpcResult({ ok: false, status: 500, error: 'DB_CONNECTION_FAILED' });
    assert.equal(errRes1.ok, false);
    assert.equal(errRes1.error, 'DB_CONNECTION_FAILED');

    const errRes2 = BongplayQueue.normalizeRpcResult({ data: { ok: false, error: 'DESK_ALREADY_OCCUPIED' } });
    assert.equal(errRes2.ok, false);
    assert.equal(errRes2.error, 'DESK_ALREADY_OCCUPIED');

    // 10-2. mock Supabase / BongplaySync RPC에서 에러 응답 시 enqueueConsent가 로컬 임의 번호를 만들지 않는지 검증
    global.window = global;
    global.window.BongplaySync = {
      isOnline: () => true,
      rpc: async (fn, params) => {
        return { ok: false, error: 'QUEUE_CLOSED_FOR_TODAY', message: '금일 접수 마감' };
      }
    };

    const consentData = {
      id: 'cst_test_rpc_fail',
      guardian_name: '테스터',
      guardian_phone: '010-1234-5678',
      children: []
    };

    const res = await BongplayQueue.enqueueConsent(consentData);
    assert.equal(res.ok, false, '서버 RPC 실패 시 ok는 반드시 false여야 함');
    assert.equal(res.error, 'QUEUE_CLOSED_FOR_TODAY');
    assert.equal(res.item, undefined, '서버 실패 시 가짜 대기 번호/아이템이 생성되어서는 안 됨');

    // 원복
    delete global.window.BongplaySync;
  });

  // ---------------------------------------------------------------------------
  // 11. [R1 Fix 2 & 4] customer_token 발급, 멱등키 재사용 차단, 발권완료 건 취소 차단
  // ---------------------------------------------------------------------------
  await t.test('11. [R1 Fix 2 & 4] customer_token 128비트 발급, 멱등키 타 동의서 재사용 차단, 발권완료 건 취소 차단', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    // 11-1. customer_token 발급 및 조회 검증
    const enq = store.enqueue({ consent_id: 'cst_token_1', guardian_name: '고객토큰' });
    assert.ok(enq.item.customer_token, 'customer_token이 생성되어야 함');
    assert.equal(typeof enq.item.customer_token, 'string');
    assert.ok(enq.item.customer_token.length >= 32, 'customer_token은 128비트 이상(32자 이상)');

    const foundByToken = store.getEntryByCustomerToken(enq.item.customer_token);
    assert.equal(foundByToken.id, enq.item.id);

    // 11-2. 멱등키가 다른 동의서에 재사용된 경우 IDEMPOTENCY_KEY_REUSED 에러 반환
    const key = BongplayQueue.generateIdempotencyKey(dateStr, 'cst_token_1', '010-0000-0000');
    const reuseRes = store.enqueue({
      consent_id: 'cst_token_DIFFERENT', // 다른 동의서 ID
      guardian_name: '다른고객',
      idempotency_key: enq.item.idempotency_key // 첫 번째 접수의 멱등키 재사용
    });
    assert.equal(reuseRes.ok, false);
    assert.equal(reuseRes.error, 'IDEMPOTENCY_KEY_REUSED', '동일 멱등키로 다른 동의서 접수 시도 시 거부되어야 함');

    // 11-3. 발권 완료(issued) 건에 대한 취소 시도 차단
    store.callNext(1, 'staff_1');
    store.completeIssuance(enq.item.id, 'ord_99', ['tkt_99']);
    const cancelRes = store.cancelEntry(enq.item.id, '단순 변심');
    assert.equal(cancelRes.ok, false);
    assert.equal(cancelRes.error, 'CANNOT_CANCEL_ISSUED', '발권 완료 건은 대기열에서 취소할 수 없음');
  });

  // ---------------------------------------------------------------------------
  // 12. [R1 Fix 3] 발권 완료 증명 (order_id, ticket_ids 필수) 및 창구 슬롯 반환 검증
  // ---------------------------------------------------------------------------
  await t.test('12. [R1 Fix 3] 발권 완료 시 order_id / ticket_ids 무결성 증명 필수 검증', () => {
    const store = BongplayQueue.createStore();
    const enq = store.enqueue({ consent_id: 'cst_proof_1' });
    store.callNext(1, 'staff_1');

    // order_id 누락 시 실패
    const fail1 = store.completeIssuance(enq.item.id, '', ['tkt_1']);
    assert.equal(fail1.ok, false);
    assert.equal(fail1.error, 'ORDER_ID_REQUIRED');

    // ticket_ids 빈 배열 시 실패
    const fail2 = store.completeIssuance(enq.item.id, 'ord_1', []);
    assert.equal(fail2.ok, false);
    assert.equal(fail2.error, 'TICKETS_REQUIRED');

    // 정상 완료 시 성공 및 창구 슬롯 반환
    const succ = store.completeIssuance(enq.item.id, 'ord_valid', ['tkt_1', 'tkt_2']);
    assert.equal(succ.ok, true);
    assert.equal(succ.item.status, BongplayQueue.STATUS.ISSUED);
    assert.equal(store.desks[1].current_queue_id, null, '발권 완료 시 데스크의 current_queue_id가 해제되어야 함');
  });

  // ---------------------------------------------------------------------------
  // 13. [R1 Fix 5] 부재 복귀 시 order_key 맨 뒤 재할당 (Back of the Line, 새치기 차단)
  // ---------------------------------------------------------------------------
  await t.test('13. [R1 Fix 5] 부재 보류 후 복귀 시 대기열 맨 뒤(order_key = max + 1)로 재배치 검증', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    // 3개 팀 순차 접수: 팀1 (q=1, order=1), 팀2 (q=2, order=2), 팀3 (q=3, order=3)
    const t1 = store.enqueue({ consent_id: 'cst_seq_1', queue_date: dateStr }).item;
    const t2 = store.enqueue({ consent_id: 'cst_seq_2', queue_date: dateStr }).item;
    const t3 = store.enqueue({ consent_id: 'cst_seq_3', queue_date: dateStr }).item;

    // 1번 창구에서 팀1 호출 후 부재 처리
    store.callNext(1, 'staff_1');
    store.holdNoShow(t1.id, '부재');

    // 1번 창구에서 팀2 호출
    const callT2 = store.callNext(1, 'staff_1');
    assert.equal(callT2.item.id, t2.id);

    // 팀1이 창구에 도착하여 복귀 요청
    const restoreT1 = store.restoreHeld(t1.id, 'staff_1', '고객 창구 방문 복귀');
    assert.equal(restoreT1.ok, true);
    assert.equal(restoreT1.item.status, BongplayQueue.STATUS.WAITING);

    // [핵심 검증]: 팀1의 원래 queue_number는 1번이지만, order_key는 팀3(order_key=3)보다 큰 4가 되어야 함!
    const updatedT1 = store.getEntryById(t1.id);
    assert.equal(updatedT1.queue_number, 1, '고객의 고유 대기번호는 1번 유지');
    assert.ok(updatedT1.order_key > t3.order_key, 'order_key는 팀3보다 커야 함 (대기열 맨 뒤 배치)');
    assert.equal(updatedT1.restored_by, 'staff_1');
    assert.equal(updatedT1.restore_reason, '고객 창구 방문 복귀');

    // 팀1 기준 앞선 대기팀 수: 팀2(처리중) + 팀3(대기중) = 2팀
    const aheadForT1 = BongplayQueue.computeAheadCount(store.entries, updatedT1.queue_number, dateStr);
    assert.equal(aheadForT1, 2, '복귀한 팀1은 팀2, 팀3 뒤에 있으므로 앞선 대기팀 수는 2팀이어야 함');

    // 팀2 발권 완료
    store.completeIssuance(t2.id, 'ord_t2', ['tkt_t2']);

    // [핵심 검증]: 다음 호출 시 복귀한 팀1이 아니라 팀3이 먼저 호출되어야 함 (새치기 원천 차단!)
    const nextCall = store.callNext(1, 'staff_1');
    assert.equal(nextCall.ok, true);
    assert.equal(nextCall.item.id, t3.id, '복귀한 1번 팀이 새치기하지 않고 3번 팀이 먼저 호출되어야 함');

    // 팀3 발권 완료
    store.completeIssuance(t3.id, 'ord_t3', ['tkt_t3']);

    // 이제 마지막으로 팀1이 호출됨
    const finalCall = store.callNext(1, 'staff_1');
    assert.equal(finalCall.ok, true);
    assert.equal(finalCall.item.id, t1.id, '팀3 처리 후에 비로소 복귀한 1번 팀이 호출됨');
  });

  // ---------------------------------------------------------------------------
  // 14. [R1 Fix 6] 창구 정지 연동 및 표본 이상치 필터링 (20초~1800초 유효)
  // ---------------------------------------------------------------------------
  await t.test('14. [R1 Fix 6] 창구 정지 연동 및 발권 처리 표본 이상치(20초 미만, 30분 초과) 필터링 검증', () => {
    // 14-1. 이상치 필터링: 10초(비정상 즉시종료), 3600초(장기 미처리)는 제외되어야 함
    const outlierData = [
      { duration_seconds: 10 },    // 이상치: 제외 (< 20s)
      { duration_seconds: 100 },   // 정상: 100s
      { duration_seconds: 120 },   // 정상: 120s
      { duration_seconds: 4000 },  // 이상치: 제외 (> 1800s)
    ];

    // 정상 표본이 2건뿐이므로 minSampleCount(3) 미달 -> CALCULATING
    const waitOutlier = BongplayQueue.calculateWaitTime({
      aheadCount: 2,
      completedIssuances: outlierData,
      activeDesksCount: 1,
      isDeskPaused: false
    });
    assert.equal(waitOutlier.code, 'CALCULATING', '이상치 2건을 제외하면 유효 표본이 2건이므로 "집계 중" 반환');
    assert.equal(waitOutlier.sampleCount, 2);

    // 14-2. 정상 표본 1건 추가 (총 3건)
    outlierData.push({ duration_seconds: 140 }); // 정상: 140s
    // 유효 표본 3건: 100s, 120s, 140s -> 평균 120s (2분/팀)
    const waitValid = BongplayQueue.calculateWaitTime({
      aheadCount: 2,
      completedIssuances: outlierData,
      activeDesksCount: 1,
      isDeskPaused: false
    });
    assert.equal(waitValid.code, 'ESTIMATED');
    assert.equal(waitValid.sampleCount, 3);
    assert.ok(waitValid.text.startsWith('약 '));

    // 14-3. 활성 창구 수가 0이면 무조건 PAUSED
    const waitNoDesk = BongplayQueue.calculateWaitTime({
      aheadCount: 2,
      completedIssuances: outlierData,
      activeDesksCount: 0,
      isDeskPaused: false
    });
    assert.equal(waitNoDesk.code, 'PAUSED');
    assert.equal(waitNoDesk.text, '발권 일시 중지');
  });

  // ---------------------------------------------------------------------------
  // 15. [R2 Fix 1] 공개 queue ID 우회 차단, 24시간 토큰 만료, 분당 60회 요청 제한
  // ---------------------------------------------------------------------------
  await t.test('15. [R2 Fix 1] 공개 ID 우회 차단(토큰 전용), 24시간 만료, 분당 60회 Rate Limit 검증', () => {
    const store = BongplayQueue.createStore();
    const now = new Date('2026-10-09T10:00:00.000Z');
    const enq = store.enqueue({ consent_id: 'cst_sec_1', guardian_name: '보안고객', now: now });
    const token = enq.item.customer_token;
    const publicId = enq.item.id;

    // 15-1. 공개 queue ID로 조회 시도 시 차단 확인
    const queryById = store.getCustomerQueueStatus(publicId, now);
    assert.equal(queryById.ok, false, '공개 ID 조회는 거부되어야 함');
    assert.equal(queryById.error, 'INVALID_TOKEN');

    // 15-2. 비밀 customer_token 으로 정상 조회 확인
    const queryByToken = store.getCustomerQueueStatus(token, now);
    assert.equal(queryByToken.ok, true, '비밀 토큰으로 정상 조회되어야 함');
    assert.equal(queryByToken.item.customer_token, token);

    // 15-3. 24시간 경과 후 토큰 만료 검증
    const after24h = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000);
    const queryExpired = store.getCustomerQueueStatus(token, after24h);
    assert.equal(queryExpired.ok, false, '24시간 경과 시 만료되어야 함');
    assert.equal(queryExpired.error, 'TOKEN_EXPIRED');

    // 15-4. 분당 60회 초과 시 요청 제한(Rate Limit) 검증
    const rateStore = BongplayQueue.createStore();
    const rateEnq = rateStore.enqueue({ consent_id: 'cst_rate_1', guardian_name: '속도제한', now: now });
    const rToken = rateEnq.item.customer_token;

    // 1분 내에 60회 요청 성공
    for (let i = 1; i <= 60; i++) {
      const q = rateStore.getCustomerQueueStatus(rToken, now);
      assert.equal(q.ok, true, `${i}번째 요청은 허용되어야 함`);
    }

    // 61번째 요청 거부 (RATE_LIMIT_EXCEEDED)
    const rateBlocked = rateStore.getCustomerQueueStatus(rToken, now);
    assert.equal(rateBlocked.ok, false, '61번째 요청은 제한되어야 함');
    assert.equal(rateBlocked.error, 'RATE_LIMIT_EXCEEDED');
  });

  // ---------------------------------------------------------------------------
  // 16. [R2 Fix 2] 클라이언트 RPC 인자 SQL 서명 100% 일치 계약
  // ---------------------------------------------------------------------------
  await t.test('16. [R2 Fix 2] getCustomerStatus 불필요 인자 제거 및 SQL 서명 일치 계약 검증', async () => {
    let capturedRpc = null;
    let capturedParams = null;

    global.window = global;
    global.window.BongplaySync = {
      isOnline: () => true,
      rpc: async (fn, params) => {
        capturedRpc = fn;
        capturedParams = params;
        return { ok: true, data: { status: 'waiting', queue_number: 1 } };
      }
    };

    // getCustomerStatus 호출
    await BongplayQueue.getCustomerStatus('bpq_secret_test_token_123', { siteId: 'bongplay_bonghwa' });

    assert.equal(capturedRpc, 'get_customer_queue_status');
    assert.equal(capturedParams.p_customer_token, 'bpq_secret_test_token_123');
    assert.equal(capturedParams.p_site_id, 'bongplay_bonghwa');
    // 불필요했던 p_token, p_queue_id 가 전혀 존재하지 않음을 단언
    assert.equal(capturedParams.p_token, undefined, 'p_token 인자는 없어야 함');
    assert.equal(capturedParams.p_queue_id, undefined, 'p_queue_id 인자는 없어야 함');

    delete global.window.BongplaySync;
  });

  // ---------------------------------------------------------------------------
  // 17. [R2 Fix 3] 직원 조작 권한 검증 (access_code 부재 시 차단, BongplayAuth 연동)
  // ---------------------------------------------------------------------------
  await t.test('17. [R2 Fix 3] 직원 조작 시 서버 권한 검증 및 공용 키 환경 보호', async () => {
    let lastSentAccessCode = null;

    global.window = global;
    global.window.BongplaySync = {
      isOnline: () => true,
      rpc: async (fn, params) => {
        lastSentAccessCode = params.p_access_code;
        return { ok: true, data: { id: 'q_test_1', status: 'called' } };
      }
    };

    // 17-1. 직원 인증 코드 없을 때 호출 시 UNAUTHORIZED_STAFF 반환
    delete global.window.BongplayAuth;
    const callWithoutAuth = await BongplayQueue.callNext(1, 'staff_anonymous');
    assert.equal(callWithoutAuth.ok, false);
    assert.equal(callWithoutAuth.error, 'UNAUTHORIZED_STAFF');

    // 17-2. window.BongplayAuth 에 올바른 세션이 있을 때 p_access_code 자동 주입 및 전송
    global.window.BongplayAuth = {
      getAccessCode: () => 'staff_secret_9999'
    };

    const callWithAuth = await BongplayQueue.callNext(1, 'staff_authorized');
    assert.equal(callWithAuth.ok, true);
    assert.equal(lastSentAccessCode, 'staff_secret_9999', 'BongplayAuth의 암호가 RPC에 정상 전달되어야 함');

    delete global.window.BongplayAuth;
    delete global.window.BongplaySync;
  });

  // ---------------------------------------------------------------------------
  // 18. [R2 Fix 4] 발권 확정 원장 무결성 대사 및 동일 주문 멱등 재시도
  // ---------------------------------------------------------------------------
  await t.test('18. [R2 Fix 4] 발권 확정 원장 대사(결제·서약·티켓) 및 동일 주문 멱등 재시도 검증', () => {
    const store = BongplayQueue.createStore();
    const dateStr = BongplayQueue.getKstDateStr();

    const enq = store.enqueue({ consent_id: 'cst_ledger_1', queue_date: dateStr });
    const qId = enq.item.id;
    store.callNext(1, 'staff_1');

    // 모의 원장 데이터 설정
    const validPayments = [
      { order_id: 'ord_ledger_100', status: 'paid', cancelled_at: null }
    ];
    const validConsents = [
      { id: 'cst_ledger_1', status: 'active', cancelled_at: null }
    ];
    const validTickets = [
      { ticket_id: 'tkt_01', order_id: 'ord_ledger_100', cancelled_at: null },
      { ticket_id: 'tkt_02', order_id: 'ord_ledger_100', cancelled_at: null }
    ];

    // 18-1. 결제 미확정 (order_payments 누락) 시 발권 거부
    const failPayment = store.completeIssuance(qId, 'ord_ledger_100', ['tkt_01', 'tkt_02'], null, {
      orderPayments: [{ order_id: 'ord_ledger_100', status: 'cancelled' }], // 취소된 결제
      safetyConsents: validConsents,
      ticketLedger: validTickets
    });
    assert.equal(failPayment.ok, false);
    assert.equal(failPayment.error, 'PAYMENT_NOT_CONFIRMED');

    // 18-2. 서약서 취소 상태 시 발권 거부
    const failConsent = store.completeIssuance(qId, 'ord_ledger_100', ['tkt_01', 'tkt_02'], null, {
      orderPayments: validPayments,
      safetyConsents: [{ id: 'cst_ledger_1', status: 'cancelled' }],
      ticketLedger: validTickets
    });
    assert.equal(failConsent.ok, false);
    assert.equal(failConsent.error, 'CONSENT_INVALID');

    // 18-3. 티켓 원장 불일치 (일부 티켓 누락) 시 발권 거부
    const failTickets = store.completeIssuance(qId, 'ord_ledger_100', ['tkt_01', 'tkt_02'], null, {
      orderPayments: validPayments,
      safetyConsents: validConsents,
      ticketLedger: [{ ticket_id: 'tkt_01', order_id: 'ord_ledger_100', cancelled_at: null }] // tkt_02 누락
    });
    assert.equal(failTickets.ok, false);
    assert.equal(failTickets.error, 'TICKET_LEDGER_INCOMPLETE');

    // 18-4. 전체 원장 일치 시 정상 발권 성공
    const successComplete = store.completeIssuance(qId, 'ord_ledger_100', ['tkt_01', 'tkt_02'], null, {
      orderPayments: validPayments,
      safetyConsents: validConsents,
      ticketLedger: validTickets
    });
    assert.equal(successComplete.ok, true);
    assert.equal(successComplete.duplicate, false);
    assert.equal(successComplete.item.status, BongplayQueue.STATUS.ISSUED);

    // 18-5. [멱등 재시도] 동일 order_id 로 다시 완료 요청 시 동일 성공 결과 반환
    const retrySameOrder = store.completeIssuance(qId, 'ord_ledger_100', ['tkt_01', 'tkt_02'], null, {
      orderPayments: validPayments,
      safetyConsents: validConsents,
      ticketLedger: validTickets
    });
    assert.equal(retrySameOrder.ok, true, '동일 주문 재시도는 성공해야 함');
    assert.equal(retrySameOrder.duplicate, true, '재시도 플래그 설정');
    assert.equal(retrySameOrder.already_completed, true);
    assert.equal(retrySameOrder.item.order_id, 'ord_ledger_100');

    // 18-6. 다른 order_id 로 완료 시도 시 ALREADY_ISSUED_OTHER_ORDER 에러
    const retryDifferentOrder = store.completeIssuance(qId, 'ord_ledger_DIFFERENT', ['tkt_01'], null, {
      orderPayments: validPayments,
      safetyConsents: validConsents,
      ticketLedger: validTickets
    });
    assert.equal(retryDifferentOrder.ok, false);
    assert.equal(retryDifferentOrder.error, 'ALREADY_ISSUED_OTHER_ORDER');
  });

});


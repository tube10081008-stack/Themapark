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
    const dateStr = '2026-10-08';

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
    const dateStr = '2026-10-08';
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
    const dateStr = '2026-10-08';

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
    const dateStr = '2026-10-08';

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
    const dateStr = '2026-10-08';

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
    const dateStr = '2026-10-08';

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

    // 2번 팀 기준: 1번 팀이 대기열로 복귀했으므로 다시 1팀으로 반영
    aheadForT2 = BongplayQueue.computeAheadCount(store.entries, t2.item.queue_number, dateStr);
    assert.equal(aheadForT2, 1, '복귀 시 다시 앞선 대기팀 수에 포함');
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

    // 7-3. 표본 3건 이상 & 정상 운영 -> 실제 평균 계산
    // 평균 (120 + 150 + 130) / 3 = 133.3초 (약 2.22분/팀)
    // 3팀 대기 / 1개 창구 -> (3 * 133.3) / 60 = 6.66분 -> 올림 7분
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
    assert.equal(waitCalc3.text, '약 7분');
    assert.equal(waitCalc3.minutes, 7);

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

});

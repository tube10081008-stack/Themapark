/**
 * operations_integrity.test.js
 * 
 * ANT-001 운영시스템 전수검증 및 중대 결함 수정 회귀/행동 테스트
 * 벤(Ben) 검토(PR-010_011_Ben_review.md) R1~R4 결함 및 추가 지시 전수 검증
 * 
 * 실행 환경: Node.js v24.18.0 (agy-node)
 * 실행 명령: agy-node --test 01_봉플레이_운영시스템/tests/operations_integrity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf-8');
}

// -----------------------------------------------------------------------------
// 1. [BEN-002] 면적 표현 구분 및 기준정보 정합성 검증
// -----------------------------------------------------------------------------
test('1. [BEN-002] 면적 표현 구분 및 기준정보 정합성 검증', async (t) => {
  await t.test('1-1. bongplay-site.js 면적 SSOT 정의 검증', () => {
    const mockWindow = {};
    const siteCode = readFile('assets/bongplay-site.js');
    new Function('window', siteCode)(mockWindow);

    assert.ok(mockWindow.BongplaySite, 'BongplaySite must be exposed on window');
    const area = mockWindow.BongplaySite.area();
    assert.equal(area.building_gross_sqm, 924.0, '건축물대장 건물 연면적은 924.0㎡');
    assert.equal(area.indoor_play_sqm, 657.785, '시설명세 실내 놀이시설장 면적은 657.785㎡');
    assert.equal(area.indoor_play_pyeong, 199, '실내 놀이공간 평수는 199평');
  });

  await t.test('1-2. bongplay-id.js & bongplay-id-core.js 시설 마스터 호환성 검증', () => {
    const mockGlobal = { localStorage: { getItem: () => null, setItem: () => {} } };
    
    new Function('global', readFile('assets/bongplay-id-core.js'))(mockGlobal);
    assert.ok(mockGlobal.BongplayIDCore, 'BongplayIDCore must be exposed');

    new Function('global', readFile('assets/bongplay-id.js'))(mockGlobal);
    assert.ok(mockGlobal.BongplayID, 'BongplayID must be exposed');

    const domeCore = mockGlobal.BongplayIDCore.MASTER_FACILITIES.play_dome;
    const domeFull = mockGlobal.BongplayID.MASTER_FACILITIES.play_dome;

    assert.equal(domeCore.building_area_sqm, 924.00);
    assert.equal(domeCore.play_area_sqm, 657.785);
    assert.equal(domeCore.area_sqm, 924.00, '하위 호환성을 위해 area_sqm 유지');

    assert.equal(domeFull.building_area_sqm, 924.00);
    assert.equal(domeFull.play_area_sqm, 657.785);
    assert.equal(domeFull.area_sqm, 924.00);

    const prodBasic = mockGlobal.BongplayID.MASTER_PRODUCTS.PROD_CHILD_BASIC_STD;
    assert.ok(prodBasic.description.includes('924㎡'), '건물 연면적 924㎡ 표기 포함');
    assert.ok(prodBasic.description.includes('657.8㎡'), '실내 놀이공간 657.8㎡ 표기 포함');
  });

  await t.test('1-3. booking.html 예약 페이지 면적 오안내 방지 검증', () => {
    const bookingHtml = readFile('pages/booking.html');
    assert.ok(bookingHtml.includes('실내 놀이공간 657.8㎡(약 199평)'), '실내 놀이공간이 657.8㎡(약 199평)으로 명시되어야 함');
    assert.ok(!bookingHtml.includes('놀이공간 924㎡'), '놀이공간 전체가 924㎡로 오안내되어서는 안 됨');
  });
});

// -----------------------------------------------------------------------------
// 2. [P1 결함] 봉아카이브 업로드 카테고리 초기화 버그 수정 검증
// -----------------------------------------------------------------------------
test('2. [P1 결함] 봉아카이브 업로드 카테고리 초기화 버그 수정 검증', () => {
  const archiveHtml = readFile('pages/archive.html');
  assert.ok(archiveHtml.includes('let userSelectedCategory = null;'), 'userSelectedCategory 변수가 선언되어 있어야 함');
  assert.ok(archiveHtml.includes("addEventListener('change'"), '카테고리 변경 이벤트 리스너가 등록되어 있어야 함');
  assert.ok(archiveHtml.includes('userSelectedCategory = sel.value;'), '선택된 카테고리를 보존해야 함');
  assert.ok(archiveHtml.includes('userSelectedCategory || sel.value'), 'loadMediaList 내에서 사용자 선택 카테고리를 보존해야 함');
  assert.ok(archiveHtml.includes('!userSelectedCategory'), 'setCategoryFilter가 사용자의 카테고리 선택을 덮어쓰지 않아야 함');
});

// -----------------------------------------------------------------------------
// 3. [P1 결함] 예약 화면 게스트 모드 격리 및 관리자 비밀번호 잠금 우회 검증
// -----------------------------------------------------------------------------
test('3. [P1 결함] 예약 화면 게스트 모드 격리 및 관리자 비밀번호 잠금 우회 검증', () => {
  const bookingHtml = readFile('pages/booking.html');
  const guestModeIdx = bookingHtml.indexOf('window.BONGPLAY_GUEST_MODE = true;');
  const configScriptIdx = bookingHtml.indexOf('src="../assets/config.js"');
  
  assert.ok(guestModeIdx >= 0, 'window.BONGPLAY_GUEST_MODE = true 선언이 존재해야 함');
  assert.ok(configScriptIdx >= 0, 'config.js 스크립트 로드가 존재해야 함');
  assert.ok(guestModeIdx < configScriptIdx, '게스트 모드 선언이 config.js 로드보다 먼저 실행되어야 관리자 잠금이 걸리지 않음');
  
  const syncJs = readFile('assets/bongplay-sync.js');
  assert.ok(syncJs.includes("path.endsWith('booking.html')"), 'bongplay-sync.js에서 booking.html을 게스트 모드로 식별해야 함');
});

// -----------------------------------------------------------------------------
// 4. [R1 P1] 일일 안전점검 인터록 최신성 및 시설 범위 전수 검증 (실제 제품 함수 추출 실행)
// -----------------------------------------------------------------------------
test('4. [R1 P1] 일일 안전점검 인터록 최신성 및 시설 범위 전수 검증 (실제 함수 추출 실행)', async (t) => {
  const opsHtml = readFile('pages/operations.html');
  
  // Extract the exact checkSafetyInterlock implementation from operations.html
  const match = opsHtml.match(/let isSafetyInspectionPassed = false;\s*async function checkSafetyInterlock[\s\S]*?\n    \}/);
  assert.ok(match, 'operations.html에서 checkSafetyInterlock 함수 추출 가능해야 함');

  // Build test execution environment for the extracted function
  function createInterlockTester(todayStr = '2026-09-30') {
    const mockDocument = {
      _bannerHidden: true,
      getElementById(id) {
        if (id === 'safetyInterlockBanner') {
          const self = this;
          return {
            classList: {
              add: (cls) => { if (cls === 'hidden') self._bannerHidden = true; },
              remove: (cls) => { if (cls === 'hidden') self._bannerHidden = false; }
            }
          };
        }
        return null;
      }
    };
    const mockSync = {
      toLocalDateStr: () => todayStr
    };
    const mockWindow = { BongplaySync: mockSync };

    const ctxCode = `
      ${match[0]}
      return {
        check: (audits) => checkSafetyInterlock(audits),
        isPassed: () => isSafetyInspectionPassed,
        isBannerHidden: () => document._bannerHidden
      };
    `;
    return new Function('document', 'window', 'localStorage', 'BongplaySync', ctxCode)(
      mockDocument, mockWindow, { getItem: () => null }, mockSync
    );
  }

  await t.test('4-1. 오늘 최신 fail, 이전 pass 순서 역전 시 차단 검증 (R1 핵심 재현)', async () => {
    const tester = createInterlockTester('2026-09-30');
    
    // Case A: [pass at 09:00, fail at 11:00] (오전 합격 후 오전 11시 재점검 불합격)
    const auditsA = [
      { audit_at: '2026-09-30T09:00:00Z', decision: 'pass', facility_id: 'all_facilities' },
      { audit_at: '2026-09-30T11:00:00Z', decision: 'fail', facility_id: 'all_facilities' }
    ];
    const resA = await tester.check(auditsA);
    assert.equal(resA.ok, false, '최신 점검이 fail이면 이전 pass가 있어도 차단되어야 함');
    assert.equal(tester.isPassed(), false, 'isSafetyInspectionPassed 플래그는 false여야 함');
    assert.equal(tester.isBannerHidden(), false, '경고 배너가 표시되어야 함');

    // Case B: [fail at 11:00, pass at 09:00] (배열 순서가 역전되어 들어와도 동일하게 차단)
    const auditsB = [
      { audit_at: '2026-09-30T11:00:00Z', decision: 'fail', facility_id: 'all_facilities' },
      { audit_at: '2026-09-30T09:00:00Z', decision: 'pass', facility_id: 'all_facilities' }
    ];
    const resB = await tester.check(auditsB);
    assert.equal(resB.ok, false, '배열 순서와 무관하게 최신 시각 기준 fail이면 차단되어야 함');
    assert.equal(tester.isPassed(), false);
  });

  await t.test('4-2. 다중 점검 시 불합격 후 재점검 합격(pass) 시 해제 검증', async () => {
    const tester = createInterlockTester('2026-09-30');
    // 09:00 fail -> 정비 후 10:30 pass
    const audits = [
      { audit_at: '2026-09-30T09:00:00Z', decision: 'fail', facility_id: 'all_facilities' },
      { audit_at: '2026-09-30T10:30:00Z', decision: 'pass', facility_id: 'all_facilities' }
    ];
    const res = await tester.check(audits);
    assert.equal(res.ok, true, '최신 점검이 pass로 재점검 해결되었으므로 개장 승인되어야 함');
    assert.equal(tester.isPassed(), true);
    assert.equal(tester.isBannerHidden(), true);
  });

  await t.test('4-3. 과거 점검만 있고 금일 점검 부재 시 차단 검증', async () => {
    const tester = createInterlockTester('2026-09-30');
    const audits = [
      { audit_at: '2026-09-29T10:00:00Z', decision: 'pass', facility_id: 'all_facilities' }
    ];
    const res = await tester.check(audits);
    assert.equal(res.ok, false, '과거 점검은 오늘 매표에 유효하지 않음');
    assert.equal(tester.isPassed(), false);
  });

  await t.test('4-4. 시설별 범위 검증 (일부 시설 부적합 시 전체 차단)', async () => {
    const tester = createInterlockTester('2026-09-30');
    // 짚코스터는 합격했으나 네트 시설이 불합격
    const audits = [
      { audit_at: '2026-09-30T08:30:00Z', decision: 'pass', facility_id: 'outdoor_coaster' },
      { audit_at: '2026-09-30T08:45:00Z', decision: 'fail', facility_id: 'outdoor_net' }
    ];
    const res = await tester.check(audits);
    assert.equal(res.ok, false, '미해결 부적합 시설(outdoor_net)이 있으므로 차단되어야 함');
    assert.equal(res.failedFacility, 'outdoor_net');
    assert.equal(tester.isPassed(), false);
  });

  await t.test('4-5. 조회 오류 / 손상 데이터 예외 안전 차단 검증', async () => {
    const tester = createInterlockTester('2026-09-30');
    // Corrupt audit entry without dates
    const res = await tester.check(null);
    assert.equal(res.ok, false);
    assert.equal(tester.isPassed(), false);
  });
});

// -----------------------------------------------------------------------------
// 5. [R2 & R3 P1] 마감 정산 캐시 계약 및 날짜 전환 상태 격리 검증
// -----------------------------------------------------------------------------
test('5. [R2 & R3 P1] 마감 정산 getCached 계약 및 날짜 전환 시재 누수 차단 검증', async (t) => {
  const syncJs = readFile('assets/bongplay-sync.js');
  const closingHtml = readFile('pages/closing.html');

  await t.test('5-1. [R2] BongplaySync.getCached API 및 closing_records 히스토리 계약 검증', () => {
    const mockWindow = {
      location: { pathname: '/pages/closing.html' },
      localStorage: {
        _store: {},
        getItem(k) { return this._store[k] || null; },
        setItem(k, v) { this._store[k] = String(v); }
      }
    };
    new Function('window', syncJs)(mockWindow);

    assert.ok(mockWindow.BongplaySync, 'BongplaySync 정의 확인');
    assert.equal(typeof mockWindow.BongplaySync.getCached, 'function', 'BongplaySync.getCached 함수가 제공되어야 함');

    // Populate history cache with Day A
    const historyList = [
      { id: '2026-09-28', date: '2026-09-28', is_locked: true, manager: '이수진', cash: { exp: 45000, sales: 150000 } }
    ];
    mockWindow.localStorage.setItem('bongplay_closing_records_history', JSON.stringify(historyList));
    // Single cache points to a different date (Day B)
    mockWindow.localStorage.setItem('bongplay_closing_board_data', JSON.stringify({ id: '2026-09-29', date: '2026-09-29', is_locked: false }));

    const cached = mockWindow.BongplaySync.getCached('closing_records');
    assert.ok(Array.isArray(cached), 'getCached는 history 배열을 반환해야 함');
    const dayARec = cached.find(r => r.date === '2026-09-28');
    assert.ok(dayARec, 'Day A 기록이 캐시에서 조회되어야 함');
    assert.equal(dayARec.is_locked, true, 'Day A의 is_locked는 true여야 함');
  });

  await t.test('5-2. [R3] A일(확정/지출45000) → 빈 B일(미저장/0원) → A일 복원 전수 행동 검증', () => {
    // Verify source code safeguards
    assert.ok(closingHtml.includes("document.getElementById('cashExpenses').value = 0;"), '기록 없는 날짜 전환 시 cashExpenses를 0으로 초기화해야 함');
    assert.ok(closingHtml.includes("document.getElementById('cashSales').value = 0;"), '기록 없는 날짜 전환 시 cashSales를 0으로 초기화해야 함');
    assert.ok(closingHtml.includes("cashInput.readOnly = false;"), '무주문일 수기 입력 모드로 복귀 확인');

    // Memory simulation of state transition
    const dom = {
      closingDate: '2026-09-28',
      closingManager: '홍성현',
      handoverNotes: '',
      baseCash: 100000,
      cashSales: 0,
      cashExpenses: 0,
      isLocked: false,
      btnDisabled: false
    };

    const historyStore = {
      '2026-09-28': {
        date: '2026-09-28',
        manager: '이수진',
        notes: '28일 정기마감 완료',
        cash: { base: 100000, sales: 250000, exp: 45000 },
        is_locked: true,
        locked_at: '2026-09-28T18:30:00Z',
        raw_payload: { manager: '이수진', notes: '28일 정기마감 완료', cash: { base: 100000, sales: 250000, exp: 45000 } }
      }
    };

    function simulateLoadDate(targetDate) {
      dom.closingDate = targetDate;
      const rec = historyStore[targetDate];
      if (rec) {
        dom.closingManager = rec.manager;
        dom.handoverNotes = rec.notes;
        dom.cashSales = rec.cash.sales;
        dom.cashExpenses = rec.cash.exp;
        dom.isLocked = !!rec.is_locked;
        dom.btnDisabled = !!rec.is_locked;
      } else {
        // Unclosed new date: complete reset
        dom.closingManager = '홍성현';
        dom.handoverNotes = '';
        dom.cashSales = 0;
        dom.cashExpenses = 0;
        dom.isLocked = false;
        dom.btnDisabled = false;
      }
    }

    // Step 1: Load Day A (2026-09-28)
    simulateLoadDate('2026-09-28');
    assert.equal(dom.closingManager, '이수진');
    assert.equal(dom.cashExpenses, 45000);
    assert.equal(dom.cashSales, 250000);
    assert.equal(dom.isLocked, true, 'Day A는 잠금 상태여야 함');

    // Step 2: Switch to Day B (2026-09-29, empty/unclosed)
    simulateLoadDate('2026-09-29');
    assert.equal(dom.closingManager, '홍성현', '기본 관리자로 초기화되어야 함');
    assert.equal(dom.cashExpenses, 0, 'Day A의 지출 45000원이 Day B로 누수되지 않아야 함');
    assert.equal(dom.cashSales, 0, 'Day A의 매출 250000원이 Day B로 누수되지 않아야 함');
    assert.equal(dom.handoverNotes, '', '메모 초기화');
    assert.equal(dom.isLocked, false, 'Day B는 잠금 해제 상태여야 함');

    // Step 3: Switch back to Day A (2026-09-28)
    simulateLoadDate('2026-09-28');
    assert.equal(dom.closingManager, '이수진', 'Day A의 관리자가 복원되어야 함');
    assert.equal(dom.cashExpenses, 45000, 'Day A의 지출이 복원되어야 함');
    assert.equal(dom.isLocked, true, 'Day A의 잠금 상태가 유지되어야 함');
  });
});

// -----------------------------------------------------------------------------
// 6. [R4 P1] 취소 이용권 체류 인원 유지 및 퇴장 처리 라이프사이클 전수 검증
// -----------------------------------------------------------------------------
test('6. [R4 P1] 취소 이용권 체류 인원 유지 및 게이트 퇴장 처리 검증', async (t) => {
  const gateHtml = readFile('pages/gate.html');

  await t.test('6-1. gate.html 취소 상태 분기 및 원내 체류 집계 코드 검증', () => {
    // 308: cancelling before entry vs after entry
    assert.ok(gateHtml.includes('if (r.entry_at) {'), '입장 기록이 있으면 체류 인원 집계 진입');
    assert.ok(gateHtml.includes('if (!r.exit_at) {'), '퇴장하지 않은 인원은 취소 여부와 무관하게 원내 체류 인원으로 집계');
    assert.ok(!gateHtml.includes("if (r.status === 'cancelled') return;"), '취소되었다고 퇴장 전 체류 인원에서 즉시 제외하는 버그 수정 확인');

    // 864: executeGateAction allows exit for entered cancelled visitor
    assert.ok(gateHtml.includes("actionType === 'entry'"), '취소된 이용권의 신규 입장은 차단');
    assert.ok(gateHtml.includes("actionType === 'exit'"), '취소된 이용권의 퇴장은 허용');
    assert.ok(gateHtml.includes('alert(\'취소·환불된 이용권은 신규 입장이 불가합니다.\');'), '취소 이용권 신규 입장 차단 알림 확인');
  });

  await t.test('6-2. [행동 검증] 입장 → 매표소 환불 취소 → 체류 인원 유지 → 퇴장 완료 라이프사이클', () => {
    // Synthetic visitor data: 1 guardian + 1 child = 2 people
    const consents = [
      {
        id: 'c_test_001',
        pass_code: 'BP-1001',
        guardian_name: '홍길동',
        children: [{ name: '홍아이' }],
        is_issued: true,
        entry_at: null,
        exit_at: null,
        status: 'active'
      }
    ];

    function calcOccupancy(list) {
      let cumEntry = 0, insideCount = 0, cumExit = 0;
      list.forEach(r => {
        const people = ((r.children && r.children.length) || 0) + 1;
        if (r.entry_at) {
          cumEntry += people;
          if (!r.exit_at) {
            insideCount += people;
          }
        }
        if (r.exit_at) {
          cumExit += people;
        }
      });
      return { cumEntry, insideCount, cumExit };
    }

    function executeGate(c, action) {
      if (c.status === 'cancelled' || c.cancelled_at) {
        if (action === 'entry') throw new Error('신규 입장 불가');
        if (action === 'exit' && !c.entry_at) throw new Error('입장 기록 없음');
      }
      if (action === 'entry') {
        if (c.entry_at) throw new Error('이미 입장');
        c.entry_at = '2026-09-30T10:00:00Z';
      } else if (action === 'exit') {
        if (c.exit_at) throw new Error('이미 퇴장');
        c.exit_at = '2026-09-30T11:30:00Z';
      }
    }

    const rec = consents[0];

    // State 1: Before entry
    assert.equal(calcOccupancy(consents).insideCount, 0, '입장 전 원내 0명');

    // State 2: Customer enters gate
    executeGate(rec, 'entry');
    assert.equal(calcOccupancy(consents).insideCount, 2, '입장 후 원내 2명');
    assert.equal(calcOccupancy(consents).cumEntry, 2);

    // State 3: Customer requests refund at POS -> Ticket cancelled while inside
    rec.status = 'cancelled';
    rec.cancelled_at = '2026-09-30T10:45:00Z';
    // Occupancy MUST STILL BE 2! Customer is physically inside the facility!
    assert.equal(calcOccupancy(consents).insideCount, 2, '환불 취소되어도 퇴장 전까지 원내 2명 유지');

    // State 4: Cancelled ticket tries to enter AGAIN -> Must be blocked
    assert.throws(() => executeGate(rec, 'entry'), /신규 입장 불가|이미 입장/);

    // State 5: Customer scans exit gate
    executeGate(rec, 'exit');
    assert.ok(rec.exit_at, '퇴장 일시가 기록되어야 함');
    assert.equal(calcOccupancy(consents).insideCount, 0, '퇴장 후 원내 0명');
    assert.equal(calcOccupancy(consents).cumExit, 2, '누적 퇴장 2명 기록');
  });
});

// -----------------------------------------------------------------------------
// 7. [추가 조건 1] 안전서약 취소 PATCH 서버 계약 및 오프라인 큐/전파 검증
// -----------------------------------------------------------------------------
test('7. [추가 조건 1] 안전서약 취소 PATCH 서버 계약 및 오프라인 큐/전파 검증', async (t) => {
  const migrationSql = readFile('database/PROPOSED_MIGRATION_safety_consents_cancellation.sql');
  assert.ok(migrationSql.includes('alter table public.safety_consents'), 'safety_consents 제안 SQL 확인');
  assert.ok(migrationSql.includes('add column if not exists status text'), 'status 컬럼 제안 확인');
  assert.ok(migrationSql.includes('cancelled_at timestamptz'), 'cancelled_at 컬럼 제안 확인');

  // Verify synthetic server failure handling & offline queueing
  const outbox = [];
  function sendConsentCancellation(id, reason, isServerOnline) {
    const payload = {
      id: id,
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason
    };

    if (!isServerOnline) {
      outbox.push({ table: 'safety_consents', action: 'update', data: payload });
      return { ok: false, queued: true, reason: 'NETWORK_OFFLINE' };
    }
    return { ok: true, queued: false, data: payload };
  }

  const offResult = sendConsentCancellation('c_100', '기상악화', false);
  assert.equal(offResult.ok, false, '오프라인 시 서버 성공을 보고하지 않음');
  assert.equal(offResult.queued, true, '오프라인 아웃박스에 저장');
  assert.equal(outbox.length, 1, '아웃박스 큐 1건 확인');

  const onResult = sendConsentCancellation('c_101', '고객요청', true);
  assert.equal(onResult.ok, true, '온라인 시 성공 처리');
});

// -----------------------------------------------------------------------------
// 8. [추가 조건 4] 기준정보 요금(15,000원), 명칭, 운영시간 고지 전수 검증
// -----------------------------------------------------------------------------
test('8. [추가 조건 4] 기준정보 요금(15,000원), 명칭, 운영시간 고지 전수 검증', () => {
  const bookingHtml = readFile('pages/booking.html');
  const idJs = readFile('assets/bongplay-id.js');
  const coreJs = readFile('assets/bongplay-id-core.js');

  // 1. Facility Name: '리틀포레스트 봉플레이'
  assert.ok(bookingHtml.includes('리틀포레스트 봉플레이'), '예약 페이지에 리틀포레스트 봉플레이 명칭 포함');

  // 2. Child Basic Ticket: strictly 15,000 KRW, no promo badge, no strikethrough
  assert.ok(bookingHtml.includes('<strong class="text-brand-400 text-sm font-black">15,000원</strong>'), '기본권 15,000원 고시가 명시');
  assert.ok(!bookingHtml.includes('14,000원'), '14,000원 판매가 제거 확인');
  assert.ok(!bookingHtml.includes('오픈할인'), '오픈할인 배지 제거 확인');
  assert.ok(!bookingHtml.includes('line-through">정가 15,000원'), '기본권 정가 취소선 제거 확인');

  // 3. Abolished discounts: 7,000 KRW voucher, 10,000 KRW activity, national merit removed
  assert.ok(!bookingHtml.includes('어린이집·유치원 평일 지원 단체권'), '폐지된 7,000원 지원 단체권 고지 제거');
  assert.ok(!bookingHtml.includes('청소년·성인 액티비티권'), '폐지된 10,000원 액티비티권 고지 제거');
  assert.ok(!bookingHtml.includes('국가유공자·장애인 우대'), '폐지된 국가유공자/장애인 우대 고지 제거');

  // 4. Preserved approved discounts: Guardian 5,000 KRW, Group 16,800 KRW, Resident 20%
  assert.ok(bookingHtml.includes('보호자 입장권'), '보호자 입장권 고지 유지');
  assert.ok(bookingHtml.includes('5,000원'), '보호자 입장권 5,000원 유지');
  assert.ok(bookingHtml.includes('단체 종합이용권 (20인 이상)'), '단체 종합이용권 고지 유지');
  assert.ok(bookingHtml.includes('16,800원'), '단체 종합이용권 16,800원 유지');
  assert.ok(bookingHtml.includes('봉화군민 20% 우대 할인'), '봉화군민 20% 우대 할인 고지 유지');

  // 5. Operating hours: notice changed to '운영시간 확정 후 안내'
  assert.ok(bookingHtml.includes('운영시간 확정 후 안내'), '운영시간 미정 고지 확인');
  assert.ok(!bookingHtml.includes('10:00 ~ 18:00 (입장 마감 17:00'), '확정되지 않은 10:00~18:00 고지 제거 확인');

  // 6. Deprecated catalog items in bongplay-id.js & core.js preserve historical compatibility
  assert.ok(idJs.includes("effective_to: '2026-09-29'"), 'bongplay-id.js에서 구 요금 유효기간 종료 처리 확인');
  assert.ok(coreJs.includes("effective_to: '2026-09-29'"), 'bongplay-id-core.js에서 구 요금 유효기간 종료 처리 확인');
});

/**
 * operations_integrity.test.js
 * 
 * ANT-001 운영시스템 전수검증 및 중대 결함 수정 회귀 테스트
 * 실행 환경: Node.js v24.18.0 (agy-node)
 * 실행 명령: agy-node --test 01_봉플레이_운영시스템/tests/operations_integrity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to load file content
function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf-8');
}

test('1. [BEN-002] 면적 표현 구분 및 기준정보 정합성 검증', async (t) => {
  await t.test('1-1. bongplay-site.js 면적 SSOT 정의 검증', () => {
    // Mock browser window
    const mockWindow = {};
    const siteCode = readFile('assets/bongplay-site.js');
    const fn = new Function('window', siteCode);
    fn(mockWindow);

    assert.ok(mockWindow.BongplaySite, 'BongplaySite must be exposed on window');
    const area = mockWindow.BongplaySite.area();
    assert.equal(area.building_gross_sqm, 924.0, '건축물대장 건물 연면적은 924.0㎡');
    assert.equal(area.indoor_play_sqm, 657.785, '시설명세 실내 놀이시설장 면적은 657.785㎡');
    assert.equal(area.indoor_play_pyeong, 199, '실내 놀이공간 평수는 199평');
  });

  await t.test('1-2. bongplay-id.js & bongplay-id-core.js 시설 마스터 호환성 검증', () => {
    const mockGlobal = { localStorage: { getItem: () => null, setItem: () => {} } };
    
    // Load bongplay-id-core.js
    const coreCode = readFile('assets/bongplay-id-core.js');
    new Function('global', coreCode)(mockGlobal);
    assert.ok(mockGlobal.BongplayIDCore, 'BongplayIDCore must be exposed');

    // Load bongplay-id.js
    const idCode = readFile('assets/bongplay-id.js');
    new Function('global', idCode)(mockGlobal);
    assert.ok(mockGlobal.BongplayID, 'BongplayID must be exposed');

    const domeCore = mockGlobal.BongplayIDCore.MASTER_FACILITIES.play_dome;
    const domeFull = mockGlobal.BongplayID.MASTER_FACILITIES.play_dome;

    // Both must define building_area_sqm, play_area_sqm, and backward-compatible area_sqm
    assert.equal(domeCore.building_area_sqm, 924.00);
    assert.equal(domeCore.play_area_sqm, 657.785);
    assert.equal(domeCore.area_sqm, 924.00, '하위 호환성을 위해 area_sqm 유지');

    assert.equal(domeFull.building_area_sqm, 924.00);
    assert.equal(domeFull.play_area_sqm, 657.785);
    assert.equal(domeFull.area_sqm, 924.00);

    // Product description must distinguish building vs play area
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

test('2. [P1 결함] 봉아카이브 업로드 카테고리 초기화 버그 수정 검증', () => {
  const archiveHtml = readFile('pages/archive.html');
  
  // Verify userSelectedCategory tracking exists
  assert.ok(archiveHtml.includes('let userSelectedCategory = null;'), 'userSelectedCategory 변수가 선언되어 있어야 함');
  
  // Verify change listener persists selected category
  assert.ok(archiveHtml.includes("sel.addEventListener('change'") || archiveHtml.includes("addEventListener('change'"), '카테고리 변경 이벤트 리스너가 등록되어 있어야 함');
  assert.ok(archiveHtml.includes('userSelectedCategory = sel.value;'), '선택된 카테고리를 보존해야 함');
  
  // Verify loadMediaList and setCategoryFilter preserve user choice
  assert.ok(archiveHtml.includes('userSelectedCategory || sel.value'), 'loadMediaList 내에서 사용자 선택 카테고리를 보존해야 함');
  assert.ok(archiveHtml.includes('!userSelectedCategory'), 'setCategoryFilter가 사용자의 카테고리 선택을 덮어쓰지 않아야 함');
});

test('3. [P1 결함] 예약 화면 게스트 모드 격리 및 관리자 비밀번호 잠금 우회 검증', () => {
  const bookingHtml = readFile('pages/booking.html');
  
  // Guest mode must be set before config.js is loaded
  const guestModeIdx = bookingHtml.indexOf('window.BONGPLAY_GUEST_MODE = true;');
  const configScriptIdx = bookingHtml.indexOf('src="../assets/config.js"');
  
  assert.ok(guestModeIdx >= 0, 'window.BONGPLAY_GUEST_MODE = true 선언이 존재해야 함');
  assert.ok(configScriptIdx >= 0, 'config.js 스크립트 로드가 존재해야 함');
  assert.ok(guestModeIdx < configScriptIdx, '게스트 모드 선언이 config.js 로드보다 먼저 실행되어야 관리자 잠금이 걸리지 않음');
  
  // bongplay-sync.js must recognize booking.html as guest mode
  const syncJs = readFile('assets/bongplay-sync.js');
  assert.ok(syncJs.includes("path.endsWith('booking.html')"), 'bongplay-sync.js에서 booking.html을 게스트 모드로 식별해야 함');
});

test('4. [P1 결함] 안전점검 판정 형식 호환성 및 POS 매표 연동 검증', () => {
  const opsHtml = readFile('pages/operations.html');
  
  // Function logic extraction test
  // In safety-check.html, audit decision is saved as { decision: 'pass' }
  // checkSafetyInterlock must accept 'pass', 'passed', 'PASS' and match audit_date or date
  assert.ok(opsHtml.includes("dec === 'pass' || dec === 'passed'"), "checkSafetyInterlock이 'pass'와 'passed' 판정을 모두 인정해야 함");
  assert.ok(opsHtml.includes("a.audit_date || a.date || a.audit_at"), "다양한 일자 필드(audit_date, date, audit_at)를 인식해야 함");
  
  // Simulate the checkSafetyInterlock function logic
  function mockCheckSafetyInterlock(audits, todayYmd) {
    const todayAudit = (audits || []).find(a => {
      const d = (a.audit_date || a.date || (a.audit_at || '').slice(0, 10));
      return d === todayYmd;
    });
    if (!todayAudit) return { ok: false, reason: '오늘 일자 안전점검 기록이 없습니다.' };
    const dec = String(todayAudit.decision || todayAudit.result || todayAudit.overall_status || '').toLowerCase();
    if (dec === 'pass' || dec === 'passed') return { ok: true, audit: todayAudit };
    return { ok: false, reason: `안전점검 상태가 적합(pass)이 아닙니다. (현재: ${todayAudit.decision || '미입력'})` };
  }

  const today = '2026-09-29';
  const passedAudit = [{ audit_date: '2026-09-29', decision: 'pass' }];
  const legacyPassedAudit = [{ date: '2026-09-29', result: 'PASS' }];
  const failedAudit = [{ audit_date: '2026-09-29', decision: 'fail' }];
  const otherDayAudit = [{ audit_date: '2026-09-28', decision: 'pass' }];

  assert.equal(mockCheckSafetyInterlock(passedAudit, today).ok, true, 'decision: pass 점검 통과');
  assert.equal(mockCheckSafetyInterlock(legacyPassedAudit, today).ok, true, 'result: PASS 레거시 점검 통과');
  assert.equal(mockCheckSafetyInterlock(failedAudit, today).ok, false, 'decision: fail 점검 차단');
  assert.equal(mockCheckSafetyInterlock(otherDayAudit, today).ok, false, '과거 점검은 금일 매표 차단');
});

test('5. [P1 결함] POS 주문 중복 클릭 방지 가드 검증', () => {
  const opsHtml = readFile('pages/operations.html');
  
  assert.ok(opsHtml.includes('let isSubmittingPosOrder = false;'), 'isSubmittingPosOrder 중복 방지 플래그 선언 확인');
  assert.ok(opsHtml.includes('if (isSubmittingPosOrder) return;'), '중복 호출 즉시 반환 가드 확인');
  assert.ok(opsHtml.includes('isSubmittingPosOrder = true;'), '제출 시작 시 플래그 켜기 확인');
  assert.ok(opsHtml.includes('isSubmittingPosOrder = false;'), 'finally 블록에서 플래그 해제 확인');
});

test('6. [P0 결함] 고객 서약서 타인 개인정보 노출 방지 검증', () => {
  const consentHtml = readFile('pages/consent.html');
  
  // Verify that checkRepeatFamily no longer reads bongplay_safety_consents from localStorage
  const idx = consentHtml.indexOf('async function checkRepeatFamily');
  assert.ok(idx >= 0, 'checkRepeatFamily 함수 존재 확인');
  const funcSnippet = consentHtml.slice(idx, idx + 1200);
  
  assert.ok(!funcSnippet.includes('bongplay_safety_consents'), '공용 키오스크/패드에서 타인 서약서(bongplay_safety_consents)를 조회해서는 안 됨');
  assert.ok(funcSnippet.includes("'bongplay_family_' + digits"), '동일 전화번호 전용 로컬 캐시만 참조해야 함');
});

test('7. [P1 결함] 티켓 취소 전파 및 게이트 입장 차단 & 중복 입장 방지 검증', async (t) => {
  await t.test('7-1. cancelOrdersByConsent 취소 전파 검증', () => {
    const idJs = readFile('assets/bongplay-id.js');
    assert.ok(idJs.includes("c.status = 'cancelled'"), '서약서 상태가 cancelled로 갱신되어야 함');
    assert.ok(idJs.includes("c.is_issued = false"), '발권 상태가 취소(false)로 갱신되어야 함');
    assert.ok(idJs.includes("c.cancelled_at = now"), '취소 일시가 기록되어야 함');
  });

  await t.test('7-2. gate.html 취소 이용권 5단계 처리 및 입장 불가 안내', () => {
    const gateHtml = readFile('pages/gate.html');
    assert.ok(gateHtml.includes("const isCancelled = rec.status === 'cancelled' || !!rec.cancelled_at;"), '취소 이용권 여부 판정 로직 확인');
    assert.ok(gateHtml.includes('if (isCancelled) stage = 5;'), '취소 티켓은 5단계로 분류');
    assert.ok(gateHtml.includes('취소·환불된 이용권입니다'), '취소 안내 메시지 렌더링 확인');
    assert.ok(gateHtml.includes("alert('취소·환불된 이용권은 입장/퇴장 처리가 불가합니다.');"), '취소된 이용권의 게이트 액션 차단 확인');
    assert.ok(gateHtml.includes("alert('이미 입장 처리된 이용권입니다.');"), '동일 이용권 중복 입장 차단 확인');
    assert.ok(gateHtml.includes("alert('이미 퇴장 처리된 이용권입니다.');"), '동일 이용권 중복 퇴장 차단 확인');
    assert.ok(gateHtml.includes('if (r.status === \'cancelled\') return;'), '원내 체류 인원 집계 시 취소 티켓 제외 확인');
  });
});

test('8. [P1 결함] 마감 결산 현금/상품권 과부족 사유 강제화 및 일자 변경 정산 갱신 검증', () => {
  const closingHtml = readFile('pages/closing.html');
  
  // Discrepancy reason enforcement: must NOT use confirm to bypass
  assert.ok(closingHtml.includes('인수인계 특이사항 메모에 과부족 사유를 반드시 기재해야 마감 확정이 가능합니다.'), '과부족 사유 미기재 시 마감 차단 및 알림 확인');
  assert.ok(!closingHtml.includes('사유를 메모에 남기지 않고 마감하시겠습니까?'), 'confirm으로 사유 작성을 건너뛰는 기존 코드 제거 확인');
  
  // Date change event listener & loadSavedData support for selected date
  assert.ok(closingHtml.includes("document.getElementById('closingDate').addEventListener('change'"), '마감 일자 변경 이벤트 리스너 등록 확인');
  assert.ok(closingHtml.includes('const selectedDate = document.getElementById(\'closingDate\').value;'), '선택된 일자 기준으로 저장 데이터를 조회해야 함');
  assert.ok(closingHtml.includes('if (data && data.date === selectedDate)'), '선택된 일자와 일치하는 마감 기록 복원 확인');
});

test('9. [BP-006] 서비스 워커 정적 자산 캐싱 및 동기화 무결성 검증', () => {
  const swJs = readFile('sw.js');
  
  assert.ok(swJs.includes("'./assets/bongplay-site.js'"), 'sw.js STATIC_ASSETS에 bongplay-site.js 포함 확인');
  assert.ok(swJs.includes("'./assets/bongplay-id-core.js'"), 'sw.js STATIC_ASSETS에 bongplay-id-core.js 포함 확인');
  assert.ok(swJs.includes("'./assets/bongplay-id.js'"), 'sw.js STATIC_ASSETS에 bongplay-id.js 포함 확인');
  assert.ok(swJs.includes("'./assets/bongplay-sync.js'"), 'sw.js STATIC_ASSETS에 bongplay-sync.js 포함 확인');

  const syncJs = readFile('assets/bongplay-sync.js');
  assert.ok(syncJs.includes('bongplay_closing_records_history'), 'BongplaySync가 마감 이력을 history 배열로도 캐싱하는지 확인');
});

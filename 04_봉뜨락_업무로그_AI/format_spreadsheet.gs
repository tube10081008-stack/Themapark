/**
 * 봉뜨락 업무로그 — 구글 스프레드시트 원클릭 서식 자동 정리 스크립트
 * 
 * [스프레드시트에서 바로 실행하는 방법]
 * 1. 구글 스프레드시트 상단 메뉴 > [확장 프로그램] > [Apps Script] 클릭
 * 2. 기존 코드를 지우고 이 코드를 붙여넣은 뒤 [저장] (Ctrl + S)
 * 3. 상단 함수 선택에서 [formatBongchatSheet] 선택 후 [실행] 클릭!
 *    (스프레드시트를 새로고침하면 상단에 [✨ 봉뜨락] > [업무로그 서식 자동 정리] 메뉴도 생성됩니다)
 */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('✨ 봉뜨락')
    .addItem('🎨 업무로그 서식 자동 정리', 'formatBongchatSheet')
    .addToUi();
}

function formatBongchatSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('업무로그') || ss.getActiveSheet();
  
  // 1. 1행 틀 고정 (헤더 스크롤 고정) 및 높이 설정
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 42);
  
  // 2. 헤더 스타일 (슬레이트 네이비 배경, 볼드 화이트 폰트, 중앙 정렬)
  var headerRange = sheet.getRange(1, 1, 1, 8);
  headerRange.setBackground('#1E293B')
             .setFontColor('#FFFFFF')
             .setFontWeight('bold')
             .setFontSize(11)
             .setHorizontalAlignment('center')
             .setVerticalAlignment('middle')
             .setWrap(false);
             
  // 3. 열 너비 자동 최적화 (가독성 극대화)
  sheet.setColumnWidth(1, 140); // A: 타임스탬프
  sheet.setColumnWidth(2, 85);  // B: 분류
  sheet.setColumnWidth(3, 360); // C: 핵심 요약
  sheet.setColumnWidth(4, 75);  // D: 담당자
  sheet.setColumnWidth(5, 105); // E: 마감일
  sheet.setColumnWidth(6, 85);  // F: 우선순위
  sheet.setColumnWidth(7, 75);  // G: 상태
  sheet.setColumnWidth(8, 450); // H: 원문 맥락

  var maxRows = Math.max(sheet.getLastRow(), 100);
  var dataRange = sheet.getRange(2, 1, maxRows - 1, 8);
  
  // 4. 데이터 기본 정렬 및 폰트
  dataRange.setVerticalAlignment('middle').setFontSize(10);
  sheet.getRange(2, 1, maxRows - 1, 1).setHorizontalAlignment('center').setFontColor('#64748B'); // 타임스탬프
  sheet.getRange(2, 2, maxRows - 1, 1).setHorizontalAlignment('center');                         // 분류
  sheet.getRange(2, 3, maxRows - 1, 1).setHorizontalAlignment('left').setWrap(true).setFontWeight('bold'); // 요약
  sheet.getRange(2, 4, maxRows - 1, 1).setHorizontalAlignment('center');                         // 담당자
  sheet.getRange(2, 5, maxRows - 1, 1).setHorizontalAlignment('center');                         // 마감일
  sheet.getRange(2, 6, maxRows - 1, 1).setHorizontalAlignment('center').setFontWeight('bold');   // 우선순위
  sheet.getRange(2, 7, maxRows - 1, 1).setHorizontalAlignment('center').setFontWeight('bold');   // 상태
  sheet.getRange(2, 8, maxRows - 1, 1).setHorizontalAlignment('left').setWrap(true).setFontColor('#475569'); // 원문

  // 5. 줄무늬 행 (Banding)
  var bandings = sheet.getBandings();
  for (var i = 0; i < bandings.length; i++) {
    bandings[i].remove();
  }
  sheet.getRange(1, 1, maxRows, 8).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);

  // 6. 데이터 필터 버튼
  var filter = sheet.getFilter();
  if (!filter) {
    sheet.getRange(1, 1, maxRows, 8).createFilter();
  }

  // 7. 조건부 서식 규칙 추가 (우선순위 / 상태 / 분류)
  sheet.clearConditionalFormatRules();
  var rules = [];

  // 우선순위 (F열)
  var priorityRange = sheet.getRange('F2:F' + maxRows);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('HIGH')
    .setBackground('#FEE2E2')
    .setFontColor('#991B1B')
    .setBold(true)
    .setRanges([priorityRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('MEDIUM')
    .setBackground('#FEF3C7')
    .setFontColor('#92400E')
    .setBold(true)
    .setRanges([priorityRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('LOW')
    .setBackground('#F1F5F9')
    .setFontColor('#475569')
    .setRanges([priorityRange])
    .build());

  // 상태 (G열)
  var statusRange = sheet.getRange('G2:G' + maxRows);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('대기')
    .setBackground('#FEF9C3')
    .setFontColor('#854D0E')
    .setBold(true)
    .setRanges([statusRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('진행')
    .setBackground('#DBEAFE')
    .setFontColor('#1E40AF')
    .setBold(true)
    .setRanges([statusRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('검토')
    .setBackground('#F3E8FF')
    .setFontColor('#6B21A8')
    .setBold(true)
    .setRanges([statusRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('완료')
    .setBackground('#DCFCE7')
    .setFontColor('#166534')
    .setBold(true)
    .setRanges([statusRange])
    .build());

  // 분류 (B열)
  var catRange = sheet.getRange('B2:B' + maxRows);
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('결정')
    .setBackground('#FAF5FF')
    .setFontColor('#6B21A8')
    .setBold(true)
    .setRanges([catRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('할일')
    .setBackground('#FFF1F2')
    .setFontColor('#9F1239')
    .setBold(true)
    .setRanges([catRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('공유')
    .setBackground('#ECFDF5')
    .setFontColor('#065F46')
    .setBold(true)
    .setRanges([catRange])
    .build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('아이디어')
    .setBackground('#F0F9FF')
    .setFontColor('#0369A1')
    .setBold(true)
    .setRanges([catRange])
    .build());

  sheet.setConditionalFormatRules(rules);

  try {
    ss.toast('업무로그 시트 서식 정리가 완료되었습니다!', '✨ 완료', 4);
  } catch (e) {}
  Logger.log('✨ [완료] 업무로그 시트 서식 정리가 모두 성공적으로 적용되었습니다!');
}

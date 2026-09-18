/**
 * ============================================================
 * 📸 리틀포레스트 봉플레이 — 구글 드라이브 5TB 미디어 아카이브 엔진
 * ============================================================
 * 
 * [구글 앱스 스크립트(GAS) 배포 안내]
 * 1. 대표님의 5TB 구글 드라이브에 접속합니다.
 * 2. [새로 만들기] > [더보기] > [Google Apps Script] 를 클릭합니다.
 * 3. 기존 코드를 모두 지우고 이 파일 전체를 그대로 복사하여 붙여넣습니다.
 * 4. 우측 상단 [배포] > [새 배포] 클릭:
 *    - 유형: "웹 앱 (Web app)" 선택
 *    - 설명: "봉플레이 아카이브 API"
 *    - 다음 사용자 권한으로 실행: "나 (내 계정)"  <-- 대표님 5TB 용량 사용!
 *    - 액세스 권한: "모든 사용자 (Anyone)"       <-- 로그인 없이 웹앱 연동!
 * 5. 배포 완료 후 나타나는 "웹 앱 URL (https://script.google.com/macros/s/.../exec)"을
 *    봉플레이 아카이브 웹 화면(archive.html) 설정창에 붙여넣으면 연동 끝!
 */

// 루트 보관함 폴더 이름 (드라이브 최상위에 자동 생성됩니다)
var ROOT_FOLDER_NAME = "봉플레이_공식아카이브";

// 기본 카테고리 정의
var CATEGORIES = [
  "01_시설안전_및_보수",
  "02_현장스케치_및_고객",
  "03_단체행사_및_프로그램",
  "04_사고_및_민원증빙",
  "05_마케팅_홍보_A컷"
];

/** GET 요청 처리 (폴더/파일 목록 조회 및 상태 확인) */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  
  try {
    var root = getOrCreateRootFolder();
    
    if (action === 'ping') {
      return jsonResponse({
        ok: true,
        message: "봉플레이 구글 드라이브 아카이브 연동 정상",
        rootFolderName: root.getName(),
        rootFolderId: root.getId()
      });
    }
    
    if (action === 'categories') {
      return jsonResponse({
        ok: true,
        categories: CATEGORIES
      });
    }
    
    // 목록 조회 (action === 'list')
    var targetCategory = (e && e.parameter && e.parameter.category) || '';
    var files = listMediaFiles(root, targetCategory);
    
    return jsonResponse({
      ok: true,
      category: targetCategory,
      count: files.length,
      files: files
    });
    
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/** POST 요청 처리 (사진/영상 업로드) */
function doPost(e) {
  try {
    var payload = {};
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    
    var root = getOrCreateRootFolder();
    var category = payload.category || '01_시설안전_및_보수';
    var memo = payload.memo || '';
    var uploader = payload.uploader || '현장근무자';
    var filename = payload.filename || ('photo_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss') + '.jpg');
    var mimeType = payload.mimeType || 'image/jpeg';
    var base64Data = payload.base64Data;
    
    if (!base64Data) {
      return jsonResponse({ ok: false, error: "업로드할 파일 데이터(base64Data)가 누락되었습니다." });
    }
    
    // 1. 카테고리 폴더 확보
    var catFolder = getOrCreateSubFolder(root, category);
    
    // 2. 당월 폴더 확보 (예: 2026-09)
    var monthStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM');
    var monthFolder = getOrCreateSubFolder(catFolder, monthStr);
    
    // 3. Base64 디코딩 후 파일 생성
    var decoded = Utilities.base64Decode(base64Data);
    var blob = Utilities.newBlob(decoded, mimeType, filename);
    var file = monthFolder.createFile(blob);
    
    // 4. 설명(메모 및 업로더 정보) 기록
    var descText = "[작성자: " + uploader + "] " + memo + " (등록시각: " + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') + ")";
    file.setDescription(descText);
    
    // 5. 보기 권한을 링크 보유자에게 열람 허용 (웹 갤러리 썸네일 노출용)
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return jsonResponse({
      ok: true,
      fileId: file.getId(),
      name: file.getName(),
      size: file.getSize(),
      category: category,
      month: monthStr,
      memo: memo,
      uploader: uploader,
      viewUrl: file.getUrl(),
      directUrl: "https://drive.google.com/uc?export=view&id=" + file.getId(),
      createdTime: Utilities.formatDate(file.getDateCreated(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
    });
    
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/** 루트 폴더 찾거나 자동 생성 */
function getOrCreateRootFolder() {
  var folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  var newRoot = DriveApp.createFolder(ROOT_FOLDER_NAME);
  newRoot.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  // 기본 카테고리 폴더 미리 생성
  for (var i = 0; i < CATEGORIES.length; i++) {
    newRoot.createFolder(CATEGORIES[i]);
  }
  return newRoot;
}

/** 하위 폴더 찾거나 생성 */
function getOrCreateSubFolder(parentFolder, subFolderName) {
  var folders = parentFolder.getFoldersByName(subFolderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  var newFolder = parentFolder.createFolder(subFolderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return newFolder;
}

/** 미디어 파일 목록 수집 */
function listMediaFiles(rootFolder, targetCategory) {
  var fileList = [];
  var catFolders = [];
  
  if (targetCategory) {
    var specific = rootFolder.getFoldersByName(targetCategory);
    if (specific.hasNext()) catFolders.push(specific.next());
  } else {
    var allCats = rootFolder.getFolders();
    while (allCats.hasNext()) catFolders.push(allCats.next());
  }
  
  for (var c = 0; c < catFolders.length; c++) {
    var catFolder = catFolders[c];
    var catName = catFolder.getName();
    
    // 월별 하위 폴더 탐색
    var monthFolders = catFolder.getFolders();
    while (monthFolders.hasNext()) {
      var mFolder = monthFolders.next();
      var monthName = mFolder.getName();
      
      var files = mFolder.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        var mime = f.getMimeType();
        var isImg = mime.indexOf('image/') === 0;
        var isVid = mime.indexOf('video/') === 0;
        
        fileList.push({
          id: f.getId(),
          name: f.getName(),
          size: f.getSize(),
          mimeType: mime,
          isImage: isImg,
          isVideo: isVid,
          category: catName,
          month: monthName,
          description: f.getDescription() || '',
          viewUrl: f.getUrl(),
          // 구글 썸네일 고화질 링크
          thumbUrl: "https://drive.google.com/thumbnail?sz=w600&id=" + f.getId(),
          fullUrl: "https://drive.google.com/uc?export=view&id=" + f.getId(),
          createdTime: Utilities.formatDate(f.getDateCreated(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
        });
      }
    }
  }
  
  // 최신순 정렬
  fileList.sort(function(a, b) {
    return b.createdTime.localeCompare(a.createdTime);
  });
  
  return fileList;
}

/** JSON 응답 헬퍼 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

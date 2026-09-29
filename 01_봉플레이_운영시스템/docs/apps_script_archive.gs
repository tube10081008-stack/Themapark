/**
 * ============================================================
 * 📸 리틀포레스트 봉플레이 — 구글 드라이브 5TB 미디어 아카이브 엔진 (완성본)
 * ------------------------------------------------------------
 * 2026-09-24 갱신: 폴더 양방향 연동 추가
 *   · action=folders      → 드라이브의 폴더 목록을 아카이브 화면에 전달
 *   · action=createFolder → 화면에서 [새 폴더 추가] 시 드라이브에 즉시 생성
 *   · 카테고리 폴더에 바로 넣은 사진도 목록에 표시 (월별 폴더 밖 파일)
 *
 * [배포 방법]
 * 1. script.google.com 에서 아카이브 프로젝트를 연다 (없으면 새로 만든다).
 * 2. 기존 코드를 모두 지우고 이 파일 전체를 붙여넣는다.
 * 3. [배포] → [배포 관리] → 연필(수정) → 버전: "새 버전" → [배포]
 *    ※ 처음 만드는 경우: [새 배포] → 유형 "웹 앱"
 *       - 실행 계정: 나 (대표님 5TB 사용)
 *       - 액세스 권한: 모든 사용자
 * 4. 웹 앱 URL(.../exec)을 아카이브 화면의 [드라이브 설정]에 붙여넣는다.
 *    (이미 연동돼 있다면 URL 은 그대로 두고 3번만 하면 된다)
 * ============================================================
 */

// 루트 보관함 폴더 이름 (드라이브 최상위에 자동 생성)
var ROOT_FOLDER_NAME = "봉플레이_공식아카이브";

// 처음 만들 때 미리 생성할 기본 폴더
var CATEGORIES = [
  "01_시설안전_및_보수",
  "02_현장스케치_및_고객",
  "03_단체행사_및_프로그램",
  "04_사고_및_민원증빙",
  "05_마케팅_홍보_A컷",
  "06_기타_정리필요한 파일",
  "07_초기_시설사진",
  "08_시설_공사사진"
];

/** GET 요청: ping / folders / categories / list */
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

    // 폴더 목록 (빈 폴더 포함) — 아카이브 화면의 폴더 탐색기가 사용
    if (action === 'folders' || action === 'categories') {
      var names = listFolderNames(root);
      return jsonResponse({ ok: true, folders: names, categories: names });
    }

    // 파일 목록
    var targetCategory = (e && e.parameter && e.parameter.category) || '';
    var files = listMediaFiles(root, targetCategory);
    return jsonResponse({ ok: true, category: targetCategory, count: files.length, files: files });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/** POST 요청: upload / createFolder */
function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }
    var action = payload.action || 'upload';
    var root = getOrCreateRootFolder();

    // ── 폴더 생성 ──
    if (action === 'createFolder') {
      var rawName = String(payload.name || '').replace(/[\\\/:*?"<>|]/g, '').trim();
      if (!rawName) return jsonResponse({ ok: false, error: "폴더 이름이 비어 있습니다." });
      var folder = getOrCreateSubFolder(root, rawName);
      return jsonResponse({ ok: true, name: folder.getName(), id: folder.getId(), folders: listFolderNames(root) });
    }

    // ── 파일 삭제 (휴지통 이동) ──
    if (action === 'delete' || action === 'deleteFile') {
      var fileId = payload.fileId;
      var fileIds = payload.fileIds || (fileId ? [fileId] : []);
      if (!fileIds.length) return jsonResponse({ ok: false, error: "삭제할 파일 ID(fileId)가 필요합니다." });
      var deleted = [];
      for (var d = 0; d < fileIds.length; d++) {
        try {
          var f = DriveApp.getFileById(fileIds[d]);
          f.setTrashed(true);
          deleted.push(fileIds[d]);
        } catch (delErr) {
          console.warn('파일 삭제 실패:', fileIds[d], delErr);
        }
      }
      return jsonResponse({ ok: true, deletedCount: deleted.length, deleted: deleted });
    }

    // ── 업로드 ──
    var category = payload.category || '01_시설안전_및_보수';
    var memo = payload.memo || '';
    var uploader = payload.uploader || '현장근무자';
    var filename = payload.filename || ('photo_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss') + '.jpg');
    var mimeType = payload.mimeType || 'image/jpeg';
    var base64Data = payload.base64Data;

    if (!base64Data) {
      return jsonResponse({ ok: false, error: "업로드할 파일 데이터(base64Data)가 누락되었습니다." });
    }

    var catFolder = getOrCreateSubFolder(root, category);                                  // 카테고리 폴더 (없으면 자동 생성)
    var monthStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM');
    var monthFolder = getOrCreateSubFolder(catFolder, monthStr);                           // 당월 폴더

    var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
    var file = monthFolder.createFile(blob);
    file.setDescription("[작성자: " + uploader + "] " + memo + " (등록시각: " + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') + ")");
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
      directUrl: "https://drive.google.com/thumbnail?sz=w1600&id=" + file.getId(),
      createdTime: Utilities.formatDate(file.getDateCreated(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
    });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

/** 루트 폴더 찾거나 자동 생성 */
function getOrCreateRootFolder() {
  var folders = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();

  var newRoot = DriveApp.createFolder(ROOT_FOLDER_NAME);
  newRoot.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  for (var i = 0; i < CATEGORIES.length; i++) newRoot.createFolder(CATEGORIES[i]);
  return newRoot;
}

/** 하위 폴더 찾거나 생성 */
function getOrCreateSubFolder(parentFolder, subFolderName) {
  var folders = parentFolder.getFoldersByName(subFolderName);
  if (folders.hasNext()) return folders.next();
  var newFolder = parentFolder.createFolder(subFolderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return newFolder;
}

/** 루트 아래 폴더 이름 목록 (이름순) */
function listFolderNames(rootFolder) {
  var it = rootFolder.getFolders();
  var names = [];
  while (it.hasNext()) {
    var name = it.next().getName();
    if (name.charAt(0) === '_') continue;   // 내부용 폴더 제외
    names.push(name);
  }
  names.sort();
  return names;
}

/** 미디어 파일 목록 수집 (월별 폴더 + 카테고리 폴더 직속 파일) */
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

    // 카테고리 폴더에 바로 넣은 파일 (드라이브에서 직접 옮긴 경우)
    collectFiles(catFolder.getFiles(), catName, '', fileList);

    // 월별 하위 폴더
    var monthFolders = catFolder.getFolders();
    while (monthFolders.hasNext()) {
      var mFolder = monthFolders.next();
      collectFiles(mFolder.getFiles(), catName, mFolder.getName(), fileList);
    }
  }

  fileList.sort(function (a, b) { return b.createdTime.localeCompare(a.createdTime); });
  return fileList;
}

/** 파일 반복자 → 목록에 담기 (사진·영상만) */
function collectFiles(iter, catName, monthName, out) {
  while (iter.hasNext()) {
    var f = iter.next();
    var mime = f.getMimeType();
    var isImg = mime.indexOf('image/') === 0;
    var isVid = mime.indexOf('video/') === 0;
    if (!isImg && !isVid) continue;

    out.push({
      id: f.getId(),
      name: f.getName(),
      size: f.getSize(),
      mimeType: mime,
      isImage: isImg,
      isVideo: isVid,
      category: catName,
      month: monthName || Utilities.formatDate(f.getDateCreated(), 'Asia/Seoul', 'yyyy-MM'),
      description: f.getDescription() || '',
      viewUrl: f.getUrl(),
      thumbUrl: "https://drive.google.com/thumbnail?sz=w600&id=" + f.getId(),
      fullUrl: "https://drive.google.com/thumbnail?sz=w1600&id=" + f.getId(),
      createdTime: Utilities.formatDate(f.getDateCreated(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
    });
  }
}

/** JSON 응답 헬퍼 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

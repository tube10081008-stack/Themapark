# CLAUDE-008 — 01/04 배포 ZIP 출처·비밀값 차단 검증

- 지시: [BEN-013](../tasks/BEN-013_직원접근설계와_배포보강.md) CLAUDE-008
- 담당: 클로이 / 브랜치 `claude/CLAUDE-008-zip-provenance` / 기준 master `edb6f62`
- 범위: `01_봉플레이_운영시스템/build_deploy_zip.ps1`, `04_봉뜨락_업무로그_AI/build_deploy_zip.ps1`, `tests/packaging/`, 이 문서, 작업표 본인 행
- 배포·운영 설정 읽기: **하지 않음**. 시험은 임시 폴더의 합성 git 저장소와 SENTINEL 가짜 값만 사용.

## 1. 보존한 것

| 항목 | 기존 | 변경 후 |
|---|---|---|
| ZIP 이름 | `bongplay_deploy.zip` / `worklog_deploy.zip` + 사본 `bongchat_deploy.zip` | 동일 (사본은 바이트 동일) |
| 실행 위치 | 프로젝트 폴더에서 `.\build_deploy_zip.ps1` | 동일 (`-ProjectRoot` 는 선택 인자, 기본값 현재 폴더) |
| ZIP 안 경로 | 프로젝트 기준 상대 경로, `/` 구분 | 동일 |
| 구성 방식 | `System.IO.Compression.ZipArchive` 로 항목 직접 작성 | 동일 |
| 시작 시 이전 ZIP 삭제 | 있음 | 있음 (보고서·`.partial` 포함) |

## 2. 포함 규칙 (허용 목록 + 2차 차단)

1. **후보** = 프로젝트 폴더의 git 추적 파일 + 명시한 공개 설정 파일(01: `assets/config.js`). git 이 무시하는 기타 파일(예: `pages/firebase-config.js`)은 후보가 아님.
2. **링크 검사**: 후보의 경로 각 단계가 심볼릭 링크·정션(재분석 지점)이면 즉시 실패. 허용·차단 판정보다 먼저 검사.
3. **2차 차단**(대소문자 무시, 모든 깊이): 폴더 `.git .svn .hg node_modules .netlify __pycache__ .vscode .idea tmp temp test tests __tests__ fixtures evidence qa raw backup backups database backend_ai docs _보관`, 이름 `.env`·`.env.*`·`*.env`·키/인증서 확장자·`id_rsa` 류·`credential`/`secret`/`service account`/`adminsdk` 포함 이름·`.npmrc`/`.netrc`·백업/임시/로그·문서/스크립트/압축/DB 확장자.
4. **허용 목록**(대소문자 구분)
   - 01: `index.html manifest.json sw.js netlify.toml _redirects _headers`, `pages/*.html|css|js`, `forms/*.html|css|js`, `assets/*.js|css`, `assets/images/**` 이미지, `netlify/functions/*.mjs|js`. `assets/config.template.js` 는 제외.
   - 04: `netlify.toml _redirects _headers`, `public/**` 의 웹 정적 파일, `netlify/functions/*.mjs|js`.
5. **내용 검사**(텍스트 파일): 개인 키 본문, 서비스 계정 `private_key`, `sk-ant-` 키, Google API 키 전체 길이, Discord 웹훅 주소, payload `role=service_role` 인 JWT → 실패. 자리표시자(`eyJhbGci...`, `AIzaSy...`)와 api.mjs 의 설명 주석은 통과.
6. **필수 파일**: 01 `index.html netlify.toml assets/config.js`, 04 `netlify.toml netlify/functions/api.mjs public/index.html public/archive.html`. 없으면 실패하고 더미를 만들지 않음. 01 공개 설정에 템플릿 자리표시자(`YOUR_PROJECT_ID` 등)가 남아 있으면 실패.

공개 설정과 비밀 설정의 구별: 01 `assets/config.js` 는 브라우저에 공개되는 Supabase URL·anon 키·GAS 배포 ID 만 허용(service_role 차단). Discord 웹훅·NOTIFY_SECRET·Gemini 키·서비스 계정 키는 Netlify 환경변수로만 두며 ZIP 에 들어오면 내용 검사에서 실패. 04 는 공개 설정 파일이 없음.

## 3. 출처 표식과 검증 보고서

- ZIP 안 공개 표식: 01 `deploy-manifest.json`, 04 `public/deploy-manifest.json` (각 프로젝트 게시 폴더 기준).
  - 키: `format`(`replayce-deploy-manifest/1`), `project`(`01_bongplay_ops` / `04_bongchat_worklog`), `commit`(전체 40자 SHA), `dirty`, `public_config`(경로·SHA-256·바이트·git 추적 여부), `files`(경로·SHA-256·바이트, 정렬).
  - 계정명·로컬 절대 경로·환경변수·생성 시각은 넣지 않음.
- ZIP 밖 검증 보고서: 01 `bongplay_deploy.verify.json`, 04 `worklog_deploy.verify.json`. 최종 ZIP SHA-256(사본 포함), 표식 SHA-256, 파일 수, 공개 설정 해시, 제외 목록과 사유. ZIP 해시를 ZIP 안에 넣지 않음.
- dirty checkout(추적 파일 변경, 무시되지 않은 새 파일)은 기본 실패. 스크립트 산출물(ZIP·보고서·`.partial`)은 dirty 판정에서 제외. `-AllowDirty` 를 주면 만들되 표식과 보고서에 `dirty: true`. 이때도 추적되지 않은 파일은 포함하지 않음.
- 항목 시각을 2000-01-01 로 고정해 같은 commit·같은 공개 설정이면 ZIP SHA-256 이 같음.

## 4. 합성 회귀시험

`python -m unittest discover -s tests/packaging -v` (PowerShell 경로는 `PWSH` 환경변수 또는 PATH 의 `pwsh`/`powershell`).

| 시험 | 01 | 04 |
|---|---|---|
| 정상 파일 보존(바이트 동일) + 차단 파일 전부 제외 목록에 기록 | ✅ (차단 23종) | ✅ (차단 10종) |
| 중첩·대소문자 변형 비밀 파일(`pages/.ENV`, `assets/Server.PEM`, `pages/Tests/`, `public/Evidence/`, `public/TMP/` 등) | ✅ | ✅ |
| 표식 commit = HEAD, 파일 해시 = ZIP 항목 해시, 키 집합 고정, 절대경로·계정명·HOME 미포함 | ✅ | ✅ |
| 보고서 ZIP SHA = 실제 파일 SHA, 보고서는 ZIP 밖, 표식 SHA 일치 | ✅ | ✅ (사본 동일) |
| 공개 설정 해시 별도 기록(`tracked_in_git: false`) | ✅ | 해당 없음(빈 목록) |
| 필수 설정 누락 → 실패, 더미 미생성, 이전 ZIP 남지 않음 | ✅ | ✅ (`public/archive.html`) |
| 템플릿 자리표시자 설정 → 실패 | ✅ | — |
| service_role JWT / 개인 키 본문 / Anthropic 키 → 실패 | ✅ / ✅ | ✅ (함수 소스) |
| 추적 링크(파일·폴더)·공개 설정 링크로 프로젝트 밖 참조 → 실패 | ✅ | — (공통 본체) |
| dirty(수정·새 파일) → 실패, `-AllowDirty` → `dirty: true` | ✅ | ✅ |
| git 무시 파일(`pages/firebase-config.js`) 미포함 | ✅ | — |
| 재실행 시 ZIP SHA 동일, 산출물이 dirty 로 잡히지 않음 | ✅ | — (공통 본체) |
| git 저장소 밖 실행 → 실패 | ✅ | — |

실행 결과(Linux, PowerShell 7.4.6 휴대판, Python 3.11): **19개 통과**. 같은 시험을 기존 스크립트에 돌리면 19개 모두 실패(실패 17, 오류 2) — 시험이 보강 내용을 실제로 검사함을 확인.

추가 확인(커밋하지 않음): 임시 복제본에 SENTINEL `assets/config.js` 를 두고 실제 01/04 트리로 실행 → 01 은 46개 파일 + 표식, 04 는 4개 파일 + 표식. 기존 스크립트 대비 빠진 파일은 01 `assets/config.template.js`·`assets/images/README.txt`, 04 `README.md`·`format_spreadsheet.gs` 뿐(모두 화면에서 참조하지 않음).

## 5. 미실행·제약

- **Windows PowerShell 5.1 실기 실행 안 함**(이 환경에 Windows 없음). 5.1 대응으로 두 스크립트를 UTF-8 BOM 으로 저장(한글 문자열·`_보관` 규칙이 5.1 에서 깨지지 않게), PS 3+ 문법만 사용. Windows 에서 `.\build_deploy_zip.ps1` 1회 실행 확인 필요.
- Windows 심볼릭 링크·정션 시험은 권한 문제로 건너뜀(Linux 에서만 실행). 판정은 .NET `FileAttributes.ReparsePoint` 라 정션도 같은 경로로 잡힘.
- 실제 `assets/config.js`·실제 키로는 시험하지 않음(지시대로).
- 배포·Netlify 설정 변경 안 함.

## 6. 통합 시 참고·결정 요청

1. 보고서 파일(`*.verify.json`)은 루트 `.gitignore` 에 없어 작업 폴더에 미추적 파일로 보임(스크립트의 dirty 판정에서는 제외됨). 루트 `.gitignore` 에 `*.verify.json` 추가 여부 — 이 PR 범위 밖이라 벤 결정.
2. 04 ZIP 에서 `README.md`·`format_spreadsheet.gs` 가 빠짐(기존에는 포함). 게시 폴더(`public`) 밖이라 웹에 노출되지는 않았지만 배포물에서 제외하는 것이 맞는지 확인.
3. 표식이 게시 폴더에 들어가 `/deploy-manifest.json` 으로 공개 조회됨(commit SHA·파일 해시만). 공개를 원치 않으면 경로 변경 필요.
4. `-AllowDirty` 산출물은 운영 배포에 쓰지 않는 것을 규칙으로 둘지.

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

`python -m unittest discover -s tests/packaging -v`

- 셸 선택: 환경변수 `PWSH` 에 하나 이상 지정(`;`(Windows)/`:` 구분). 없으면 Windows 는 PATH 의 `powershell.exe`(5.1)와 `pwsh`(7) 를 **모두** 찾아 셸마다 시험 묶음을 따로 만든다 (`Project01Tests_ps51`, `Project01Tests_pwsh` …). 실행 시 첫 줄에 셸 경로와 `PSVersion PSEdition` 을 출력한다.
- 임시 폴더: `BONGPLAY_TEST_WORKDIR` 로 바꿀 수 있다. git 객체 파일은 읽기 전용이라 Windows 에서 `TemporaryDirectory` 정리가 WinError 5 로 실패할 수 있어(벤 환경 보고), 읽기 전용 속성을 풀고 지우는 정리로 바꿨다. 시험 판정 로직은 바꾸지 않았다.
- Windows 5.1 실행 예:
  ```powershell
  $env:PWSH = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe;$((Get-Command pwsh).Source)"
  $env:BONGPLAY_TEST_WORKDIR = "$env:USERPROFILE\c008_work"   # 쓰기 가능한 폴더
  New-Item -ItemType Directory -Force $env:BONGPLAY_TEST_WORKDIR | Out-Null
  python -m unittest discover -s tests/packaging -v
  ```

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
| 추적 폴더를 프로젝트 밖으로 옮기고 정션(Windows)/심볼릭 링크로 대체, `-AllowDirty` → 링크 검사에서 실패 | ✅ (Linux 심볼릭 링크) | — (공통 본체) |
| dirty(수정·새 파일) → 실패, `-AllowDirty` → `dirty: true` | ✅ | ✅ |
| git 무시 파일(`pages/firebase-config.js`) 미포함 | ✅ | — |
| 재실행 시 ZIP SHA 동일, 산출물이 dirty 로 잡히지 않음 | ✅ | — (공통 본체) |
| git 저장소 밖 실행 → 실패 | ✅ | — |

실행 결과 (1차 `fd41991`): Linux, PowerShell 7.4.6, 19개 통과. 같은 시험을 기존 스크립트에 돌리면 19개가 모두 실패(실패 17, 오류 2)했다. 시험이 보강 내용을 실제로 검사한다는 뜻이다.

실행 결과 (2차, 벤 검토 반영): Linux, PowerShell 7.4.6 Core, Python 3.11에서 **20개 통과, 건너뜀 0**. 링크 검사를 끈 변형 스크립트로 돌리면 링크 시험 4개가 실패해서, 링크 시험이 실제로 동작함을 확인했다.

### 플랫폼별 실행·건너뜀 구분

| 시험 | Linux pwsh 7 (클로이 실행) | Windows 5.1 / 7 (미실행, 예상 동작) |
|---|---|---|
| 일반 시험 16개 | 실행·통과 | 실행 |
| 파일 심볼릭 링크 2개 (`tracked_symlink`, `public_config_symlink`) | 실행·통과 | 개발자 모드·관리자 권한이 없으면 **건너뜀**(사유 출력) |
| 추적된 폴더 심볼릭 링크 (`symlinked_directory`) | 실행·통과 | **건너뜀**: Windows git 의 폴더 링크 추적 방식이 달라서. 정션 시험이 대신 검사 |
| 추적 폴더 → 정션 대체 (`tracked_directory_replaced_by_link`) | 실행·통과 (심볼릭 링크로) | 실행 (`mklink /J`, 관리자 권한 불필요). 정션 생성이 실패하면 건너뜀 |

추가 확인(커밋하지 않음): 임시 복제본에 SENTINEL `assets/config.js` 를 두고 실제 01/04 트리로 실행 → 01 은 46개 파일 + 표식, 04 는 4개 파일 + 표식. 기존 스크립트 대비 빠진 파일은 01 `assets/config.template.js`·`assets/images/README.txt`, 04 `README.md`·`format_spreadsheet.gs` 뿐(모두 화면에서 참조하지 않음).

### 3차 (아난티 Windows 독립 검증 후 오탐 수정, 2026-10-02)

- 아난티 보고 (`784263f`, Windows 11, PS 5.1.26100 / 7.6.4): 40개 중 통과 30, 건너뜀 6, 실패 4. 실패 4건은 모두 `Project01Tests_*` 의 `test_provenance_manifest_and_report`·`test_dirty_untracked_file_fails_and_allow_dirty_records` 였다. 원인은 시험 하네스의 `getpass.getuser()` 부분 문자열 검사로, OS 사용자명 `bongp` 가 정상 이름 `bongplay`(`01_bongplay_ops`, `assets/bongplay-site.js`)에 걸린 오탐이다. 패키징 스크립트는 바꾸지 않았다.
- 수정 범위는 시험 파일의 누출 검사만이다 (`manifest_violations`, `local_identity`). 검사를 지우거나 사용자명 전체를 예외로 두지 않았다.
  - **고정 schema 유지**: 최상위·`files`·`public_config` 키 집합이 정확히 일치해야 한다. `format`·`project` 는 고정값이어야 한다.
  - **값 유형 검사 유지**: commit 40자 hex, sha256 64자 hex, bytes 는 정수, dirty/tracked_in_git 은 bool 이어야 한다. path 는 상대 POSIX 경로여야 하고(드라이브 문자·선행 `/`·`\`·`..` 금지) 시험 픽스처가 정한 예상 파일 목록 안에 있어야 한다.
  - **계정·호스트 이름**: 부분 문자열이 아니라 독립 토큰 일치로 판정한다. 구분자가 든 이름(`DESKTOP-AB12` 등)은 원문 포함으로 판정한다. 수집 대상은 `getuser()`, `USER`/`USERNAME`/`LOGNAME`/`COMPUTERNAME`/`HOSTNAME`/`USERDOMAIN` 이다.
  - **로컬 절대 경로·환경값**: `HOME`/`USERPROFILE`/`TEMP`/`TMP`/`TMPDIR`/`APPDATA`/`LOCALAPPDATA`/`HOMEPATH`/`BONGPLAY_TEST_WORKDIR` 와 시험 임시 경로가 값에 들어 있으면 실패한다. 경로 구분자는 정규화해서 비교한다.
  - 위에서 정확히 대조된 값(스키마 키, 고정 format/project, 예상 파일 경로, 해시)만 계정·경로 검사에서 뺀다. 그 밖의 값과 키는 모두 검사한다.
- **양성·음성 회귀 14개 추가** (`ManifestLeakCheckTests`, PowerShell 불필요)
  - 음성(통과해야 함) 3개: `bongp` vs `bongplay`, 대소문자 변형, 사용자명이 정상 파일명 토큰과 같은 경우(`site` vs `bongplay-site.js`, HOME=`/root` vs 상대 경로)
  - 양성(실패해야 함) 10개: 새 필드에 사용자명, project 를 사용자명으로 교체, 경로에 사용자명 토큰, 파일 기록에 추가 키, Windows 절대 경로, POSIX 절대 경로, 환경 경로값, 구분자 든 호스트명, 값 유형 오류 3종, SENTINEL
  - 수집 함수 점검 1개
- 결과 (Linux, PowerShell 7.4.6 Core, Python 3.11):
  - 기본 환경: **34개 통과** (패키징 20 + 검사기 14), 건너뜀 0.
  - **`USER=bongp LOGNAME=bongp` 재현**: 이전 하네스(`784263f`)에서는 아난티와 같은 2건이 실패했고, 새 하네스에서는 34개 통과했다.
  - **누출 변형 스크립트 3종**(새 필드 `built_by="bongp"`, 파일 path 에 로컬 절대 경로, project 에 `[Environment]::UserName`): 모두 provenance 시험에서 실패했다. 끝난 뒤 원본 스크립트로 되돌렸다.

## 5. 미실행·제약

- **Windows PowerShell 5.1 / Windows pwsh 실행: 미실행.** 클로이 환경(Linux 컨테이너)에는 Windows가 없다. 위 명령으로 Windows 에서 한 번 실행해야 한다. 벤의 1차 재실행은 임시 폴더 정리(WinError 5)에서 막혔다. 이는 제품 실패가 아닌 시험 도구 문제로 분류하며, Windows 검증 완료로 보지 않는다.
- **5.1 정적 점검 후 보강 1건**: 5.1 에서는 `$ErrorActionPreference='Stop'` 상태일 때 git 의 stderr 출력(예: CRLF 경고)이 `2>$null` 로도 종료 오류가 된다. 그래서 git 호출 중에만 `Continue` 로 두고 종료 코드로 판정하도록 바꿨다 (`Invoke-Git`). 벤 환경 로그를 근거로 한 변경이 아니라 5.1 동작에 맞춘 대응이며, 실제 5.1 실행 확인은 남아 있다.
- 두 스크립트는 UTF-8 BOM으로 저장했고 PS 3+ 문법만 사용했다.
- Windows 정션 시험은 시험 코드에만 있고 실행하지 못했다.
- 실제 `assets/config.js`·실제 키로는 시험하지 않았다 (지시대로).
- 배포·Netlify 설정 변경은 하지 않았다. 운영 배포는 금지다.

## 6. 벤 결정 (PR #28 검토, 2026-10-02) 반영

1. 04 배포물에서 `README.md`·`format_spreadsheet.gs` 제외: **유지**.
2. 공개 표식(commit SHA·파일 해시)을 `/deploy-manifest.json` 으로 공개: **유지**.
3. `-AllowDirty` 산출물: **운영 배포 금지**. 표식·보고서의 `dirty: true` 로 구별한다.
4. 검증 보고서: 승인된 범위 확장에 따라 루트 `.gitignore` 에 **생성 파일의 정확한 경로 2개만** 추가했다 (`01_봉플레이_운영시스템/bongplay_deploy.verify.json`, `04_봉뜨락_업무로그_AI/worklog_deploy.verify.json`). `*.verify.json` 처럼 전역으로 제외하지 않았다. 다른 위치의 `*.verify.json` 은 계속 미추적 파일로 보이는 것을 확인했다.

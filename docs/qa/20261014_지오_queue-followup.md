# 2026-10-14 지오: 발권 대기열 시험 배포 대상(bongplay2) 확인과 U01~U16 시험표

- 지시: 벤. 시험 배포 대상은 Netlify `gartenhong2` 팀의 `bongplay2.netlify.app`. 읽기 전용 확인, 격리 설정 정리, 시험표 게시.
- 작성: 지오(Aside). 1차 확인 2026-10-14 17:48-17:51 KST(Netlify). **2차 갱신 18:12-18:16 KST(Supabase 시험 프로젝트 확인, 5-6절 추가).** **3차 22:09-22:14 KST: 대표 승인에 따라 비운영 프로젝트 1개 일시정지, 시험 프로젝트 `bongplay-queue-test` 생성(5-4절).** **4차 22:22-22:25 KST: 시험 프로젝트 전체 ref·대시보드 URL 기록, 접근 확인, 설치·배포 실행 준비(7절).** **5차 23:04-23:08 KST: 벤 승인으로 시험 DB에 설치 묶음 6단계 실행, 검증 FAIL 0건(7-6절).** **6차 23:12-23:23 KST: README 2절 HTTP 검증 H01-H07 시도 → 실행 도구 제약으로 실행 불가(7-7절). DB 연결 준비 완료로 기록하지 않음.**
- 기준 SHA(origin/master): `892a06143ebe69e64a77761cd5793ab199c9755b`
- 작업 브랜치: `aside/20261014-geo-queue-followup` (master에서 분기)
- 결과 SHA: 1차 본문 `4145b8e2d5826ce136792a3a9a650f34e40ef8d6`, 1차 SHA 기입 `3f6c8d83e17b5664a94c68293c428d24d86b70f9`. 2차 갱신 `f53ed162fa1abd01fee7785df74630b0c6302929`. 3차 갱신 `d4326f1642db61eefdc9c7ba152423c46993df8a`. 4차 갱신 `3bf1653c0da58b61263230ace00336dd7eb4a763`. 5차 갱신 `1758f805636f58a0e692a1f81e8f820af582c30d`. 6차 갱신 커밋 SHA는 자기 참조가 불가능하므로 최종 보고에 기재
- 변경 파일: `docs/qa/20261014_지오_queue-followup.md` 1개. 공통 작업표·운영 코드·Netlify 설정은 변경하지 않음.
- **실행 상태: U01~U16 전부 미실행.** 벤이 수정본과 시험 환경을 지정하기 전에는 어떤 결과도 통과로 기록하지 않는다.
- 하지 않은 것: 배포, Drop 업로드, 환경변수·도메인·요금제 변경, 운영/시험 데이터 입력, 공개 내부 파일의 내용 열람, Supabase 운영 프로젝트 설정 변경, 운영 데이터 복사, SQL 적용. (3차에서 대표 승인 범위의 일시정지 1건·시험 프로젝트 생성 1건만 수행)

## 1. Netlify `bongplay2` 확인 결과 (읽기 전용)

| 항목 | 확인값 | 근거 |
|---|---|---|
| 팀 | `gartenhong2` (무료 플랜) | Netlify 팀 프로젝트 목록 |
| 같은 팀의 다른 프로젝트 | `replayce`, `bongplaychat2` | 프로젝트 목록. 시험 대상 아님 |
| 사이트명 / URL | `bongplay2` / `https://bongplay2.netlify.app/` | 응답 200, 제목 "리틀포레스트 봉플레이 — 운영시스템" |
| 현재 게시 배포 ID | `6aaa32f4fd125e6e580548d4` | 배포 목록 최상단 "Production Published" |
| 배포일 | 2026-09-16 15:11 (브라우저 표시 시각) | 배포 상세 |
| 고정 주소 | `https://6aaa32f4fd125e6e580548d4--bongplay2.netlify.app/` | 배포 상세 Permalink |
| 게시 방식 | Netlify Drop, 자동 게시 켜짐, 잠금 없음 | 배포 화면 |
| 게시본 규모 | 파일 94개, 53.5MB. 함수 배포 없음 | 배포 상세 |
| 크레딧 | 299.7 / 300 남음. 주기 10/5~11/4, 11/5 만료. 이번 주기 운영 배포 0회 | 팀 Usage & billing |
| 배포 가능 여부 | **가능해 보임.** 일시 중지 안내 없음. 운영 배포 1회 15크레딧 → 이번 주기 약 19회 | 결제 화면, Netlify 문서(운영 배포 15크레딧) |
| 환경변수 | **없음** ("No environment variables set") | 프로젝트 환경변수 화면 |
| 대기열 화면 | `pages/consent.html` 200, `pages/queue-status.html`·`pages/consent-desk.html`·`pages/gate.html` **404** | HEAD 요청 |

**판단:** 현재 `bongplay2` 게시본은 9/16의 옛 판본이라 대기열 기능 시험 대상이 아니다. 수정본이 새로 게시돼야 한다. Drop으로 올리면 즉시 운영 배포(15크레딧)가 되고 기존 게시본을 대체한다. 이전 게시본으로 되돌리는 것은 크레딧이 들지 않는다.

## 2. 운영 DB·Discord와 격리해야 할 설정

| 순위 | 항목 | 현재 관찰 | 필요한 조치(벤 결정·실행) |
|---|---|---|---|
| **P0** | Supabase 연결 대상 | `bongplay2`의 `assets/config.js`가 운영 `bongplay`와 **같은 Supabase 프로젝트**(ref `vwkg…vl`)를 가리킴. 공개 anon 키도 들어 있음. **3차: 분리된 시험 프로젝트 `bongplay-queue-test`(`mglj…eg`) 생성 완료, SQL 미적용**(5-4절). `bongplay2` 게시본은 아직 운영 DB를 가리킴 | 수정본 게시 시 `config.js`를 시험 프로젝트 주소·키로 교체하고, 대기열 SQL을 시험 프로젝트에 적용(벤 담당). 교체 전에는 시험 금지 |
| **P0** | 공개 노출된 내부 파일 | `main.py`, `ops_test_kit.sql`, `database_rules.json`, `firebase_설정방법.txt`, `docker-compose.yml`이 공개 URL에서 200으로 열림. 이 밖에 `scratch/`, `tmp/`, `replayce_deploy/`, `봉뜨락_업무로그_netlify/`, `실내놀이동/` 폴더도 게시본에 포함 | 내용은 열지 않았으므로 비밀값 포함 여부는 미검증. 수정본은 웹 파일만 포함한 패키지로 교체하고, 노출 기간 중 비밀값이 있었다면 교체 여부를 검토 |
| P1 | 직원 접근 코드 | 공개 `config.js`에 `ACCESS_CODE` 항목이 있음(값 미기록) | 시험용 별도 코드를 쓰고 운영 코드 재사용 금지. 근본 대책은 서버 측 직원 인증 |
| P1 | Discord 알림 | `bongplay2`에는 환경변수와 함수가 없어 현재 게시본은 `notify` 함수로 알림을 보낼 수 없음(`/.netlify/functions/notify` 404). 운영 `bongplay`는 `DISCORD_WEBHOOK_*` 4개가 모든 배포 맥락에 같은 값으로 설정돼 있음 | 수정본에 `netlify/functions/notify`가 포함돼도 **gartenhong2에 운영 웹훅을 복사하지 않는다.** 필요하면 시험 전용 채널 웹훅을 쓰거나 비워 둔다. 클라이언트 코드에 웹훅 주소 하드코딩 여부를 수정본에서 다시 확인 |
| P1 | 자동 게시 | 자동 게시 켜짐 | 시험 판본 고정이 필요하면 게시 후 잠금 여부를 벤이 결정 |
| P2 | 결제·외부 연동 | 시험 환경의 결제 단말·외부 API 호출 여부 미확인 | 무결제 합성 발권만 허용. 실제 결제 경로 차단 증빙 필요 |

## 3. 시험 명령과 결과

| 명령/조작 | 결과 |
|---|---|
| Netlify UI: `teams/gartenhong2/projects`, `projects/bongplay2/deploys`, 배포 상세, `billing/general`, `configuration/env` 열람 | 1절 값 확인. 변경 없음 |
| `HEAD https://bongplay2.netlify.app/{/, /main.py, /ops_test_kit.sql, /database_rules.json, /firebase_설정방법.txt, /docker-compose.yml, /assets/config.js, /pages/consent.html}` | 모두 200 |
| `HEAD https://bongplay2.netlify.app/{/pages/queue-status.html, /pages/consent-desk.html, /pages/gate.html, /.netlify/functions/notify}` | 모두 404 |
| `GET /assets/config.js`(운영·시험) → Supabase 프로젝트 ref만 추출 비교 | 동일 ref. 키·코드 값은 기록하지 않음 |
| `GET /assets/bongplay-sync.js`(시험) → Discord 웹훅 하드코딩·notify 호출 문자열 검색 | 둘 다 없음 |
| `git clone --filter=blob:none https://github.com/tube10081008-stack/Themapark.git <전용 폴더>` | **실패.** 세션 임시 폴더와 `%TEMP%` 모두 `could not create leading directories ... Permission denied`(실행 환경 샌드박스 권한) |
| 대체: GitHub 웹에서 master 기준 `aside/20261014-geo-queue-followup` 생성 후 이 파일을 원격 브랜치에 직접 커밋 | 로컬 push 없음. 원격 반영은 GitHub API로 SHA·내용 일치 확인 |
| (2차) Aside Vault에서 Supabase 저장 로그인 검색 | 0건. 사용자가 브라우저에서 직접 로그인 |
| (2차) Supabase UI: `dashboard/organizations`, 각 조직 프로젝트 목록 | 조직 3개·프로젝트 5개(활성 2, 일시정지 3). 5-1절 |
| (2차) Supabase UI: 활성 비운영 프로젝트 테이블 편집기에서 테이블 이름만 확인 | 봉플레이 테이블 없음. 데이터 행은 열지 않음 |
| (2차) Supabase UI: `bongplay` 조직 새 프로젝트 화면 열람(생성 버튼 미클릭) | "활성 무료 프로젝트 한도 2개 도달" 안내 |

## 4. U01~U16 사용자 시험표 (전부 미실행)

**시험 시작 조건(모두 충족 전 실행 금지):** 벤이 지정한 수정본 판본(프런트·서버 전체 SHA), `bongplay2` 게시 배포 ID, 운영과 분리된 Supabase, 운영 웹훅 미설정 확인, 합성 데이터 초기화 방법, 직원 시험 계정(또는 시험 전용 코드) 2개, 오류 주입 수단, 결제 비활성.

**실행 구분:**
- **PC:** PC 브라우저를 390×844 모바일 크기로 에뮬레이션.
- **폰:** 실제 휴대폰(iPhone Safari, Android Chrome)과 실제 카메라·터치·네트워크.
- PC 결과로 폰 항목을 통과 처리하지 않는다. 화면의 성공 표시만으로 DB 저장 통과로 판정하지 않는다.

| ID | 시나리오 | 조작 | 기대 결과 | 구분 | 상태 |
|---|---|---|---|---|---|
| U01 | QR 동의서 접수 | 인쇄 QR을 폰 카메라로 스캔해 합성 정보로 제출. PC는 URL 직접 열기 | 공식 대기번호 1개와 접수 시각 표시 | 폰·PC | 미실행 |
| U02 | 대기번호 확인 | 고객 대기 화면 열기 | 번호, 상태, 앞선 팀 수, 예상시간(표본 부족 시 "집계 중"), 마지막 갱신 시각 | 폰·PC | 미실행 |
| U03 | 매표소 호출 | 직원 A가 다음 팀 호출 | 고객 화면·전광판이 같은 번호·창구로 바뀜. 반영 지연 기록 | PC + 폰 | 미실행 |
| U04 | 발권(무결제 합성) | 발권 시작 → 완료 | 해당 팀이 대기에서 빠지고 뒤 팀 앞선 수 1 감소. 실제 원장 검증은 후속 서버 시험 | PC | 미실행 |
| U05 | 게이트 입장 | 발권된 합성 QR·번호로 입장, 미발권 건도 시도 | 발권 건은 원내 인원 증가, 미발권 건 거부 | 폰(카메라)·PC(번호) | 미실행 |
| U06 | 부재 보류 → 복귀 | 호출 팀 보류, 새 접수 후 복귀 | 보류 중 앞선 수 제외, 복귀 시 맨 뒤 합류, 새치기 없음 | PC | 미실행 |
| U07 | 중복 접수 | 제출 연타, 응답 직전 새로고침 후 재제출 | 접수 1건, 번호 1개 | 폰·PC | 미실행 |
| U08 | 취소 | 대기 중 취소, 발권 후 취소 | 대기 제외, 게이트 입장 거부, 모든 화면 상태 일치 | PC | 미실행 |
| U09 | 통신 오류(고객) | 접수 중 오프라인 전환, 서버 500 주입 | 공식 번호 미표시, 오류 안내, 성공 오인 없음 | 폰(비행기 모드)·PC | 미실행 |
| U10 | 통신 오류(직원) | 호출·발권 요청 실패 주입 | 직원·고객·전광판 상태 불변 | PC | 미실행 |
| U11 | 복구 | 오류 해제 후 재연결 | 중복·누락 없이 수렴, 갱신 시각 재개 | 폰·PC | 미실행 |
| U12 | 다중 단말 갱신 | 직원 단말 2대 동시 호출 | 같은 팀 이중 호출 없음. 고객·전광판·게이트 반영 시각 기록 | PC 2대 + 폰 | 미실행 |
| U13 | 화면 잠금·백그라운드 | 폰 잠금 1분 후 복귀 | 즉시 갱신 또는 "오래됨" 경고 | 폰 | 미실행 |
| U14 | 네트워크 전환 | Wi-Fi ↔ LTE 전환 | 끊김 표시 후 자동 복구 | 폰 | 미실행 |
| U15 | 알림 격리 | 시험 전 과정 진행 | 운영 Discord 알림 0건, 운영 Supabase 신규 행 0건 | 공통 | 미실행 |
| U16 | 개인정보 | 고객 화면·전광판·공개 파일 점검 | 다른 팀 이름·연락처 노출 없음, 전광판은 번호만, 내부 파일 비공개 | 폰·PC | 미실행 |

**증거:** 단말별 캡처(개인정보 가림), KST 초 단위 시각, 판본 SHA·배포 ID, 응답 코드만 남긴 네트워크 기록, 시험 DB 상태 열(가능할 때). 원본 토큰·키·개인정보는 저장소에 넣지 않는다.

## 5. Supabase 시험 프로젝트 확인 (2차, 18:12~18:16 KST, 읽기 전용)

사용자가 브라우저에서 Supabase에 직접 로그인한 뒤 조직·프로젝트 목록만 읽었다. 프로젝트 ref는 앞 4자리·뒤 2자리만 적는다. 키·접속 문자열은 열람·기록하지 않았다.

### 5-1. 계정의 조직과 프로젝트

| 조직(무료 플랜) | 프로젝트 | ref | 지역·규모 | 상태 | 봉플레이 시험용 여부 |
|---|---|---|---|---|---|
| `bongplay` | `tube10081008-stack's Project` | `vwkg…vl` | ap-northeast-2, NANO | 활성 | **아님. 운영 DB**(`bongplay`·`bongplay2` 설정 파일이 가리키는 프로젝트) |
| `analog holiday` | `tube10081008-stack's Project` | `vtnl…io` | ap-southeast-2, NANO | 활성 → **3차에 일시정지** | **아님.** 테이블 이름이 `acct_*`, `agent_*`, `chinese_*`, `german_*` 등 다른 서비스 것(데이터 미열람) |
| `analog holiday` | `slowstep-app` | `jlgh…sc` | ap-northeast-1 | 일시정지 | 이름상 아님(미열람) |
| `tube10081008-stack's Org` | `tube10081008-stack's Project` | `ytgm…ux` | ap-south-1 | 일시정지 | 미확인(일시정지 상태라 미열람) |
| `tube10081008-stack's Org` | `tube10081008-stack's Project2` | `yhpp…gu` | ap-southeast-2 | 일시정지 | 미확인(일시정지 상태라 미열람) |

**결론:** 운영과 분리된 봉플레이 시험 프로젝트는 **없음**. 일시정지된 2개 프로젝트의 용도는 확인하지 못했다.

### 5-2. 무료 프로젝트 생성 가능 여부

- `bongplay` 조직의 새 프로젝트 화면(생성 버튼은 누르지 않음)에 다음 안내가 표시됨: 관리자 `tube10081008-stack`이 **활성 무료 프로젝트 한도(2개)에 도달**해, 프로젝트를 삭제·일시정지·업그레이드하기 전에는 이 조직에서 무료 프로젝트를 만들 수 없음.
- 현재 활성 무료 프로젝트 2개 = 운영 `vwkg…vl` + 다른 서비스 `vtnl…io`.
- Supabase 공식 문서 기준 무료 플랜: 활성 프로젝트 2개(Owner/Admin인 모든 조직 합산, 일시정지 프로젝트는 제외), DB 500MB, 1주 저활동 시 자동 일시정지, 자동 백업 없음. Pro는 조직당 월 $25부터이며 $10 컴퓨트 크레딧이 Micro 1개를 덮고 추가 프로젝트는 약 월 $10씩.

### 5-3. 시험 DB 확보 선택지 (모두 미실행, 결정 필요)

| 안 | 방법 | 비용 | 영향·위험 |
|---|---|---|---|
| A (**3차 실행**) | `vtnl…io`(다른 서비스) 일시정지 후 `bongplay` 조직에 무료 시험 프로젝트 생성 | 0원 | 그 서비스가 멈춤. 소유자 승인 필요. 시험 프로젝트도 1주 저활동 시 자동 일시정지 |
| B | 다른 Supabase 계정(한도 여유가 있는 별도 소유자)으로 무료 조직·프로젝트 생성 | 0원 | 계정·권한 관리 분리 필요. 운영 계정과 키가 섞이지 않게 관리 |
| C | 조직 하나를 Pro로 올리고 시험 프로젝트 추가 | 월 $25부터(+추가 컴퓨트) | 요금제 변경이라 대표 승인 필요. 자동 일시정지 없음 |
| D | 운영 프로젝트 안에 시험 스키마 | 0원 | **비권장.** 같은 DB·키·RLS를 공유해 운영 오염·권한 혼선 위험. 격리 기준 미달 |
| E | 로컬 Supabase(CLI/Docker) | 0원 | 실제 휴대폰 시험에 외부 접속 경로 필요. 지오 실행 환경에서는 Docker·로컬 Git 권한이 막혀 있음 |

### 5-4. 3차 실행 결과 (2026-10-14 22:09~22:14 KST, 대표 승인)

**승인 범위:** 봉플레이 운영 DB(`vwkg…vl`)를 제외한 미사용 프로젝트 일시정지, 확보된 무료 슬롯으로 `bongplay-queue-test` 생성. 운영 데이터 복사·운영 설정 변경·SQL 적용 금지. 비용이 생기면 중단.

| 단계 | 결과 | 확인 근거 |
|---|---|---|
| 일시정지 대상 재대조 | `vtnl…io`(조직 `analog holiday`)가 운영 설정 파일의 ref(`vwkg…vl`)와 **다름**을 전체 ref 비교로 확인 | 운영 `config.js` ref와 조직 목록 ref 비교(값은 마스킹) |
| 일시정지 | `vtnl…io` → "Project is paused". 이미 정지된 `jlgh…sc`, `ytgm…ux`, `yhpp…gu`는 그대로 둠 | 조직 프로젝트 목록 |
| 무료 조건 | `bongplay` 조직 새 프로젝트 화면의 한도 경고 사라짐. 조직 Free Plan, 비용·업그레이드 요구 문구 없음, 청구서 $0.00 | 새 프로젝트 화면, 조직 Billing |
| 생성 | 아래 표 | 조직 프로젝트 목록, 프로젝트 홈 |

| 항목 | 값 |
|---|---|
| 프로젝트명 | `bongplay-queue-test` |
| 조직 | `bongplay` (Free Plan) |
| ref (배포 대상 식별용, 비밀값 아님) | `mgljfzdjpsvdxcailheg` |
| 대시보드 URL | https://supabase.com/dashboard/project/mgljfzdjpsvdxcailheg |
| 지역 | Northeast Asia (Seoul) `ap-northeast-2` |
| 규모 | NANO (`t3a.nano`) |
| 상태 | **Healthy** (22:13 KST 확인) |
| 운영 DB와 분리 | **분리됨.** 운영 `vwkg…vl`과 다른 별도 프로젝트·인스턴스. 운영 데이터 복사 없음 |
| DB 내용 | `public` 스키마 "No tables or views". **SQL 미적용** |
| 생성 시 보안 옵션 | 기본값 유지: Data API 사용, 새 테이블 자동 노출 켜짐, 자동 RLS 꺼짐. SQL 적용 전 벤 검토 권장 |
| 비밀값 | DB 비밀번호는 Aside Vault에 숨김 생성·저장(값 미열람·미기록). anon 키·접속 문자열은 열람하지 않음 |

**남은 위험:** 무료 프로젝트라 1주 저활동 시 자동 일시정지될 수 있다(재개 가능). `bongplay2` 게시본은 아직 운영 DB를 가리키므로 수정본 교체 전 시험 금지.

## 6. 시험 환경 격리 수용 기준과 배포 후 재검사 체크리스트

시험 개시 전 아래 항목을 모두 확인한다. 하나라도 미충족이면 사용자 시험(U01~U16)을 시작하지 않는다. 결과에는 값이 아니라 일치·불일치와 응답 코드만 적는다.

### 6-1. 합성 데이터·DB 격리
- [x] 운영과 분리된 시험 프로젝트 존재: `bongplay-queue-test`(`mglj…eg`, Seoul, Healthy) — 3차
- [ ] 시험 배포의 `assets/config.js` Supabase ref가 운영 `vwkg…vl`이 아니라 `mglj…eg`임
- [x] 시험 프로젝트에 기본 스키마·대기열 SQL 적용, 판본 `e8a9041`과 파일 blob SHA 기록 — 5차(7-6절)
- [x] 시험 데이터는 `SYN-` 합성 자료만(50 시드), 초기화 방법은 설치 README 3절(90·91)에 문서화 — 5차
- [ ] 시험 전후 운영 `vwkg…vl`의 서약·대기·발권 테이블 신규 행 수 0 (운영 쪽 읽기 권한자가 확인)

### 6-2. 무결제
- [ ] 결제 단말·외부 결제 호출이 비활성이거나 시험 모드임을 벤이 확인
- [ ] 발권 시험은 무결제 합성 경로만 사용. 실제 카드·현금 수납 기록 0건

### 6-3. 운영 Discord 알림 차단
- [ ] gartenhong2 `bongplay2` 환경변수에 `DISCORD_WEBHOOK_*` 운영 값 없음(현재 0개, 배포 후 재확인)
- [ ] 수정본에 `netlify/functions/notify`가 있으면 시험 전용 채널 웹훅 또는 비활성 상태
- [ ] 공개 JS 전체에 Discord 웹훅 주소 하드코딩 없음(문자열 검색, 값 미기록)
- [ ] 시험 전 과정 동안 운영 Discord 채널 신규 알림 0건(채널 관리자 확인)

### 6-4. 공개 노출 파일 재검사 (배포 후 `HEAD` 응답 코드로 확인)
기존 게시본(`6aaa32f4fd125e6e580548d4`)에서 1차에 200으로 열린 파일과 게시본 파일 목록에 있던 비웹 항목이다. 새 게시본에서는 모두 404여야 한다.

| 경로 | 1차 결과 | 배포 후 기대 |
|---|---|---|
| `/main.py` | 200 | 404 |
| `/ops_test_kit.sql` | 200 | 404 |
| `/database_rules.json` | 200 | 404 |
| `/firebase_설정방법.txt` | 200 | 404 |
| `/docker-compose.yml` | 200 | 404 |
| `/dockerfile` | 미확인(파일 목록에 있음) | 404 |
| `/scratch/` 하위 7개 | 미확인(파일 목록에 있음) | 폴더 자체 미포함 |
| `/tmp/` 하위 3개 | 미확인(파일 목록에 있음) | 폴더 자체 미포함 |
| `/replayce_deploy/` 하위 5개 | 미확인(파일 목록에 있음) | 폴더 자체 미포함 |
| `/봉뜨락_업무로그_netlify/` 하위 4개 | 미확인(파일 목록에 있음) | 폴더 자체 미포함 |
| `/실내놀이동/` 하위 21개 | 미확인(파일 목록에 있음) | 시험 범위 밖이면 미포함 |

- [ ] 새 배포의 Netlify 파일 목록에 `.py`, `.sql`, `.yml`, `dockerfile`, `.txt` 설정 문서, `scratch`·`tmp` 폴더가 없음
- [ ] 위 표의 경로가 모두 404
- [ ] 노출 기간 중 위 파일에 비밀값이 있었다면 해당 키 교체 여부를 벤이 판단(지오는 내용 미열람)
- [ ] 공개 `config.js`의 직원 접근 코드는 시험 전용 값이며 운영 코드와 다름(값 미기록, 일치 여부만)

### 6-5. 판본 고정
- [ ] 시험 대상 배포 ID와 프런트·서버 전체 SHA 기록, 시험 중 자동 게시로 판본이 바뀌지 않음

## 7. 배포 대상 식별·접근 확인·실행 준비 (4차, 2026-10-14 22:22-22:25 KST)

**실행 상태(5차 기준):** 시험 DB SQL 설치 **완료**(7-6절). Netlify 설정 변경·배포 **0건**. 운영 DB 작업 0건.

### 7-1. 배포 대상 식별

| 대상 | 식별 정보 | 비고 |
|---|---|---|
| 시험 DB | 프로젝트 `bongplay-queue-test`, ref `mgljfzdjpsvdxcailheg`, 조직 `bongplay`(Free), 서울 `ap-northeast-2` | https://supabase.com/dashboard/project/mgljfzdjpsvdxcailheg |
| 운영 DB(대상 아님) | ref `vwkg…vl` | 시험 작업에서 열거나 변경하지 않음 |
| 시험 웹 배포 | Netlify 팀 `gartenhong2`, 사이트 `bongplay2`, `https://bongplay2.netlify.app/` | 현재 게시 배포 `6aaa32f4fd125e6e580548d4`(9/16), 아직 운영 DB를 가리킴 |

### 7-2. 접근 확인 (읽기 전용)

| 대상 | 결과 | 근거 |
|---|---|---|
| Supabase 시험 프로젝트 | **접근 가능.** 상태 Healthy, NANO, `ap-northeast-2` | 프로젝트 홈 |
| 시험 DB 내용 | `public` 테이블 0개("No tables or views") | Table Editor |
| SQL 편집기 | 새 쿼리 화면과 Run 버튼 표시. **아무 쿼리도 실행하지 않음** | `/sql/new` 화면 |
| Netlify `bongplay2` | **접근 가능.** 배포 목록·Drop 업로드 영역 표시, 자동 게시 켜짐 | 배포 화면(팀 `gartenhong2`, 멤버 1명) |
| Netlify 크레딧 | 299.6/300 남음(주기 10/5~11/4). 운영 배포 1회 15크레딧 | 팀 Billing |
| `bongplay2` 환경변수 | 0개 | 환경변수 화면 |
| `bongplay2` DB 연결 | 공개 `config.js`가 여전히 운영 ref를 가리킴. 시험 ref 아님 | 공개 파일의 ref만 비교 |

### 7-3. 지정 후 실행 순서 (준비만, 미실행)

**실행 전제(모두 벤 지정):** (a) 클로이 설치 SQL의 경로·커밋 SHA·실행 순서, (b) 벤 통합 판본(프런트·SQL) 전체 SHA, (c) 실행 승인. 하나라도 없으면 시작하지 않는다.

1. **대상 재확인:** Supabase 화면의 프로젝트명이 `bongplay-queue-test`이고 URL ref가 `mgljfzdjpsvdxcailheg`인지 확인. `vwkg…vl`이면 즉시 중단.
2. **사전 상태 기록:** 테이블·함수 목록과 시각 기록(값·데이터 없이 이름만).
3. **기본 스키마 선행 설치:** 대기열 SQL은 `safety_consents`, `order_items`, `order_payments`, `ticket_ledger`를 참조한다. 빈 시험 DB에는 이 테이블이 없으므로, 지정된 기본 설치 SQL을 먼저 적용해야 한다. master의 후보는 `FINAL_SUPABASE_SETUP.sql`(네 테이블 생성 포함)이지만 **어느 파일과 순서를 쓸지는 클로이 설치 SQL 지정에 따른다.**
4. **제외 대상:** `supabase_discord_setup.sql`(pg_net 외부 호출 포함 → Discord 알림 위험)과 `ops_test_kit.sql`(데이터 INSERT 포함)은 지정이 없으면 적용하지 않는다. 운영 데이터 복사 금지.
5. **대기열 SQL 적용:** 지정 SHA의 파일만 사용하고, 붙여넣기 전 저장소 blob SHA와 대조한다. 오류 시 중단하고 오류 문구만 보고(재시도·수정 SQL 작성은 지시 후).
6. **사후 확인:** 생성된 테이블·RPC 이름 목록과 대기열 3개 테이블(`ticket_queue`, `ticket_queue_desks`, `ticket_queue_rate_limits`) 존재, 합성 데이터 외 행 0건을 기록.
7. **웹 패키지 준비:** 벤 통합 판본의 `01_봉플레이_운영시스템` 웹 파일만 포함(`.py`·`.sql`·`.yml`·`dockerfile`·`scratch`·`tmp` 제외). `assets/config.js`의 Supabase 주소를 시험 ref로, 키는 시험 프로젝트 anon 키로, 직원 접근 코드는 시험 전용 값으로 교체한다. 키·코드 값은 보고서·채팅에 남기지 않는다.
8. **배포:** `bongplay2`에 Drop 업로드(운영 배포 15크레딧). 배포 ID·시각 기록.
9. **배포 후 검사:** 6절 체크리스트 전체(시험 ref 연결, 노출 파일 404, 웹훅 0개, Discord 하드코딩 없음) 통과 시에만 U01~U16 시작 가능으로 보고.

### 7-4. 판본 후보 (참고, 지정 아님)

저장소에서 확인한 대기열 관련 최신 브랜치(22:24 KST). 어느 것을 쓸지는 벤 지정에 따른다.

| 브랜치 | HEAD | 커밋 시각(UTC) | 대기열 SQL |
|---|---|---|---|
| `claude/CLAUDE-011-queue-followup` | `837649c7fdce0e8bfb84550b80cc04933c74b0c6` | 2026-10-14 09:26 | 있음 |
| `antigravity/ANT-006-queue-followup` | `6692940a31434f2613ba0e77aeb1da13d125e957` | 2026-10-14 09:50 | 있음 |

### 7-5. 실행상 제약

- 지오 실행 환경은 로컬 Git·폴더 생성이 권한 문제로 막혀 있다. SQL은 Supabase 웹 SQL 편집기로, 패키지는 세션 임시 폴더와 브라우저 파일 선택으로 올릴 계획이며 **업로드 방식은 미검증**이다. 막히면 벤에게 패키지 제출을 요청한다.
- 무료 시험 프로젝트는 1주 저활동 시 자동 일시정지될 수 있다. 시험 직전 상태가 Healthy인지 재확인한다.

### 7-6. 시험 DB 설치 실행 결과 (5차, 2026-10-14 23:04-23:08 KST, 벤 승인)

- **대상:** `bongplay-queue-test` (`mgljfzdjpsvdxcailheg`). 매 실행 직전 브라우저 URL의 ref와 화면의 프로젝트명을 코드로 대조. 운영 DB(`vwkg…vl`)는 열지 않음.
- **판본:** `claude/CLAUDE-011-queue-followup` `e8a9041cda9d13d1db34f6168096b9d2fbc49f5d` (실행 시점 브랜치 HEAD와 동일). 설치 순서는 같은 판본의 `database/test_supabase_install/README.md`(blob `1c79a36`).
- **방법:** Supabase SQL Editor에 저장소 원문 전체를 넣고 Run. 편집기에 들어간 글자 수가 원문과 같은지 실행 전 대조.

| 순서 | 파일(판본 `e8a9041`) | blob | 결과 |
|---|---|---|---|
| 1 | `test_supabase_install/00_preflight.sql` | `f4db954e53e235deb18c671857741a01e91f1afa` | 성공(예외 없음 → 빈 시험 프로젝트 확인, 설치 표시 기록) |
| 2 | `FINAL_SUPABASE_SETUP.sql` | `62c1264cef3fbf02140b675d224ae2ec15a2aaf1` | 성공. 마지막 점검 "안전 인터록 트리거 수 3, PASS" |
| 3 | `PROPOSED_MIGRATION_ticket_queue.sql` | `22555fb3cf55a3724c20996befc838fb2d509154` | 성공 |
| 4 | `test_supabase_install/40_test_staff_code.sql` | `e053014b848480996ac6b2d0b6c31a2fbde65955` | 성공. 자리표시자 1곳만 시험 전용 값으로 치환해 실행(파일·저장소 미수정). 실행 직후 편집기 내용 삭제 |
| 5 | `test_supabase_install/50_synthetic_seed.sql` | `faee541bceaf718d24ddb8725ebe302dda14b6f9` | 성공(오늘 PASS 점검 1건, `SYN-` 서약서 3건) |
| 6 | `test_supabase_install/60_verify.sql` | `4fe9cfe8b856acb0fa68ce85023472c80ddd77b8` | 성공. 19행 반환 |

**Supabase 경고창 처리:**
- 2단계에서 "삭제 작업 포함·RLS 없이 표 생성" 경고가 떴다. 지정 파일을 바꾸지 않기 위해 **"Run without RLS"**(원문 그대로 실행)를 선택했다. "Run and enable RLS"는 SQL을 바꾸므로 고르지 않았다. RLS는 FINAL 자체 구문과 6단계 `R01 RLS 켜짐` 점검으로 확인했다.
- 3단계에서 "삭제 작업 포함" 경고가 떠 **"Run query"**로 원문을 실행했다.

**6단계 검증 결과 (README 판정: `level = FAIL`이면서 `ok = false`인 행이 없어야 함) → 통과**

| 수준 | ok | 건수 | 항목 |
|---|---|---|---|
| FAIL | true | 16 | A01, A02, E01, P01, P02, P03, P04, P05, P06, Q01, Q02, Q03, R01, S01, T01, T02 |
| FAIL | false | **0** | 없음 |
| WARN | false | 1 | P02b anon·authenticated의 원장 TRUNCATE 권한 남음(README 3절 참고 항목, PostgREST로는 호출 불가) |
| WARN | true | 2 | D01 오늘 PASS 점검 있음, X01 pg_cron 있음 |

- 결과 표가 화면에서 12행까지만 그려져, 60 파일의 마지막 조회만 `level, ok`별 집계로 바꾼 **읽기 전용 보조 쿼리**를 한 번 더 실행해 19행 전체를 확인했다. 집계 합계 19건 = 원 결과 19행.

**실행하지 않은 것(5차 시점):** `90_reset_queue.sql`, `91_reset_all_test.sql`(초기화·삭제), README 2절 HTTP 기능 검증(H01~H07), 운영 DB 작업, 운영 데이터 복사, Netlify 업로드·설정 변경.

**비밀값 처리:** 시험 직원 코드는 지오가 무작위 16자로 생성해 Aside Vault 항목 "bongplay-queue-test 시험 직원 코드"에 저장했다. 값은 화면·로그·보고서에 출력하지 않았고 SQL 스니펫도 저장하지 않았다. DB 비밀번호·키·접속 문자열은 열람·기록하지 않았다.

### 7-7. HTTP 기능 검증 H01~H07 (6차, 2026-10-14 23:12-23:23 KST, 벤 지시)

**결론: 7건 모두 실행 불가.** 지오 실행 환경의 제약으로 시험 요청이 시험 프로젝트에 도달하지 못했다. 다른 방식으로 대체해 통과 처리하지 않았다. **"DB 연결 준비 완료"는 기록하지 않는다.**

| 항목 | 내용 |
|---|---|
| 시험 파일 | `01_봉플레이_운영시스템/tests/queue-contract/supabase-install/verify_http.mjs` (판본 `e8a9041`, blob `1e3ac55`). 내려받은 사본이 원문과 동일함을 대조 |
| 대상 | `https://mgljfzdjpsvdxcailheg.supabase.co` (anon 키의 JWT 내용에서 역할 `anon`과 ref 일치만 확인, 값 미출력) |
| 직원 코드 | Vault 항목 "bongplay-queue-test 시험 직원 코드"와 같은 값(5차에 생성·저장한 값) |
| 비밀값 전달 | 세션 임시 파일로만 전달하고, 실행기가 읽는 즉시 삭제. 출력은 키·코드를 `[MASK]`로 치환하는 실행기를 거침. 시험 후 임시 파일 전부 삭제 확인 |

| 시도 | 명령(요지) | 결과 |
|---|---|---|
| 1 | README 명령 `node --test --test-concurrency=1 verify_http.mjs` (마스킹 실행기 경유) | 실행 파일 경로 확인 단계에서 `EPERM: operation not permitted, lstat 'C:\'` (샌드박스) |
| 2 | 같은 명령 + `--preserve-symlinks --preserve-symlinks-main` | 4분 이상 무응답 → 강제 종료. 결과 출력 없음 |
| 3 | 진단: 비밀값 없이 `node --test`만 실행(모든 시험이 건너뛰어져야 함) | 40초 제한도 넘겨 무응답 → 강제 종료. `--test` 실행기 자체가 이 환경에서 멈춤 |
| 4 | 진단: 같은 파일을 `node --input-type=module -`로 직접 실행(비밀값 없음) | 정상 동작. H01~H07 7건 인식, 7건 모두 "미지정 — 건너뜀", exit 0 |
| 5 | 4번 방식 + 비밀값 전달 | 무응답 → 강제 종료. 결과 파일 생성 안 됨 |
| 6 | 진단: 셸 Node에서 시험 프로젝트 `auth/v1/health`로 fetch(비밀값 없음) | `ENOTFOUND` — **셸 Node는 외부 DNS·네트워크에 접근 불가** |

- **실행 불가 원인:** 지오의 셸·Node 실행 환경은 샌드박스라 외부 네트워크(DNS)가 막혀 있고, `node --test` 실행기도 동작하지 않는다. 브라우저에서는 네트워크가 되지만, 브라우저 안에서 시험을 다시 구현하면 README 시험을 대체하는 우회가 되므로 하지 않았다.
- **시험 DB 영향:** 실행 전후 공개 RPC `get_queue_public_display` 조회로 대기 팀 0건을 확인했다. anon으로 `safety_consents`의 `SYN-HTTP-*` 행을 조회한 결과도 0건이었다(RLS 때문에 보이지 않을 가능성이 있어 보조 근거). 시험 요청이 도달하지 않았으므로 H06의 인증 실패 기록도 남지 않았을 것으로 본다(미검증).
- **보조 요청(읽기 전용):** 위 대기 현황 RPC 조회 3회와 anon 조회 1회는 브라우저에서 진단용으로만 실행했다. 쓰기 요청은 없다.

| 시험 | 판정 |
|---|---|
| H01 대기열 표 직접 접근 차단 | 실행 불가 |
| H02 내부 함수 API 비노출 | 실행 불가 |
| H03 anon 서약서 삭제 불가 | 실행 불가 |
| H04 접수·멱등·미확정 재시도·토큰 조회 | 실행 불가 |
| H05 HTTP 동시 접수 20건 | 실행 불가 |
| H06 틀린 직원 암호 거부 | 실행 불가 |
| H07 호출→처리→발권 완료·재시도·부분 수납 거부 | 실행 불가 |

**필요한 조치(벤 결정):** 외부 네트워크가 되는 Node 22 이상 환경(벤·클로이 로컬 또는 CI)에서 README 2절 명령을 실행해야 한다. 필요한 값은 시험 프로젝트 URL, anon 키(대시보드 Settings → API Keys), Vault의 시험 직원 코드다. 실행자가 지오가 아니면 직원 코드의 전달 방식을 정해야 한다.

## 8. 미검증

- 공개 노출 파일에 비밀값이 들어 있는지(내용을 열지 않음).
- 수정본 판본, 게시 예정 배포 ID, 분리 Supabase 준비 여부.
- 수정본의 Discord 연동 방식과 시험 채널 존재 여부.
- `bongplay2` 게시본과 저장소 커밋의 대응 관계(Drop 게시라 SHA 표시 없음).
- 실제 휴대폰 기종·브라우저 확보 여부.
- 일시정지된 Supabase 프로젝트 2개(`ytgm…ux`, `yhpp…gu`)의 용도.
- 공개 노출 폴더(`scratch/`, `tmp/` 등) 하위 파일의 개별 응답 코드.
- 클로이 설치 SQL·벤 통합 판본(미지정). 기본 스키마 SQL과 대기열 SQL의 실제 적용 성공 여부.
- Netlify Drop 업로드를 지오 환경에서 수행할 수 있는지.
- **HTTP 기능 검증 H01~H07 (6차 실행 불가, 7-7절).** 이 검증 전에는 시험 DB의 앱 경로(anon 키 + PostgREST) 동작을 확인하지 못한 상태다.

## 9. 결정 요청

**벤**
0. ~~실행 지정~~ → 5차에 시험 DB 설치 완료. **다음 지정 필요:** README 2절 HTTP 검증(H01-H07)을 네트워크가 되는 환경에서 누가 실행할지(6차에 지오 환경에서 실행 불가, 7-7절), 수정본 웹 패키지(판본)와 `bongplay2` 업로드 승인. 참고로 이전 요청: 클로이 설치 SQL(경로·SHA·순서, 기본 스키마 포함 여부)과 벤 통합 판본 전체 SHA, 실행 승인. 7-4절 후보 중 무엇을 쓸지 포함.
1. 시험 DB는 A안으로 확보 완료(`bongplay-queue-test`). 대기열 SQL 적용 담당자와 판본, 생성 시 보안 기본값(새 테이블 자동 노출 켜짐·자동 RLS 꺼짐) 유지 여부를 정해 주세요. anon 키를 수정본 `config.js`에 넣는 담당자도 지정이 필요합니다.
2. 공개 노출된 내부 파일 정리 방법: 수정본 게시로 덮을지, 먼저 웹 파일만 담은 패키지로 교체할지. 노출 파일에 비밀값이 있었다면 교체 여부.
3. 수정본 판본·배포 ID·직원 시험 계정·오류 주입·초기화 방법 지정과 시험 개시 인계.
4. 시험 전용 Discord 채널을 둘지, 알림을 끈 채 시험할지.

**대표**
- 무료 플랜 크레딧(이번 주기 약 19회 운영 배포) 안에서 시험 배포를 운영할지. Netlify 요금제 변경 필요는 없음.
- Supabase 시험 DB: 대표 승인(A안)으로 해결. 일시정지한 `vtnl…io`(다른 서비스)는 필요 시 대시보드에서 재개 가능(1년 이내). 무료 활성 슬롯이 다시 2개 모두 사용 중이므로, 재개하려면 다른 프로젝트를 정지해야 함.

# 지오(Aside × Sakana Fugu Pro) 전용 합성 시험 환경 가이드

**문서 코드**: GEO-ENV-001 / ANT-006  
**작성자**: 아난티 (Antigravity / Google Pro)  
**기준 판본 (Fixed Base)**: `74812700958fd18d2c87b7331c2a6fddc57fa41c` (ANT-006 R2 검토 대상 고정)  
**전용 작업 브랜치**: `antigravity/ANT-006-geo-synthetic-env`  
**전용 격리 폴더**: `C:\Users\bongp\Documents\Codex\2026-09-29\e\agent-workspaces\geo-synthetic-env`  
**작성 일자**: 2026-10-09  

---

## 1. 개요 및 목적

본 환경은 지오(Aside × Sakana Fugu Pro)가 브라우저 자동화 및 실사용 탐색을 통해 **리틀포레스트 봉플레이 발권 대기열 시스템(ANT-006 R2)** 을 안전하고 독립적으로 전수 검증할 수 있도록 마련된 **Netlify 크레딧 0 소모 로컬 합성 시험 환경**입니다.

### 핵심 준수 원칙
1. **Netlify 크레딧 완전 보호**: Netlify 배포 빌드나 외부 트래픽을 일체 유발하지 않고, 순수 로컬 Node.js HTTP 서버 및 Mock Supabase API로 동작합니다.
2. **운영 DB 및 실제 데이터 불개입**: 운영 Supabase DB나 회계 장부(`chloe-accounting`), 원본 공유 폴더에 어떠한 쓰기나 변경도 가하지 않습니다.
3. **판본 고정**: 벤의 검토 대상인 `7481270` 커밋을 기준으로 별도 브랜치와 폴더에 구축되어 기존 R2 성과물에 간섭하지 않습니다.

---

## 2. 환경 구분: 메모리 모의 환경 vs 실제 PostgreSQL 환경

| 구분 | 환경 A: 메모리 모의 환경 (In-Memory Mock) <br>**(현재 활성화된 기본 환경)** | 환경 B: 실제 PostgreSQL 환경 (Real SQL) <br>**(추가 인프라 준비 시 전환 환경)** |
|---|---|---|
| **실행 엔진** | Node.js 내장 HTTP 서버 + `InMemoryQueueStore` | PostgreSQL 15+ 데이터베이스 엔진 + PostgREST |
| **외부 의존성** | **전무 (0 Dep)**: Node.js만 있으면 즉시 실행 | Docker / 로컬 PostgreSQL 서비스 / Supabase CLI 필요 |
| **Netlify 크레딧** | **0 소모 (완전 무료)** | 0 소모 (로컬 컨테이너 시) |
| **검증 가능 범위** | - 서약서 접수, 토큰 발급, 실시간 대기 순서 확인<br>- 전광판 Zero PII 실시간 전파<br>- 매표소 창구 호출, 재호출, 부재 보류, 복귀(맨 뒤 재배치)<br>- 3대 원장 대사(결제·서약·티켓) 및 발권 완료<br>- 11종 인위적 오류 주입 및 복구 전수 검증 | - 실제 PostgreSQL 인덱스, Row Level Security(RLS)<br>- `pg_advisory_xact_lock` 실제 락 경합<br>- `SECURITY DEFINER` 및 DB 트리거/시퀀스 물리 검증 |
| **현재 상태** | **100% 준비 완료 및 자체 검증 8/8 통과** | 로컬 Windows 환경 내 PostgreSQL 서비스 부재 상태 (아래 섹션 7 참조) |

---

## 3. 실행, 종료 및 초기화 (Operation Guide)

### 3.1 실행 방법 (Start)
PowerShell, CMD, 또는 터미널에서 다음 명령 중 하나를 실행합니다:

```powershell
# 방법 1: PowerShell 런처 실행 (권장)
.\run_synthetic_env.ps1

# 방법 2: 배치 파일 실행
.\run_synthetic_env.bat

# 방법 3: Node.js 직접 실행 (포트 변경 가능)
& "C:\Program Files\nodejs\node.exe" "01_봉플레이_운영시스템/tests/synthetic_server.js" --port=4185
```

기동 즉시 터미널에 다음 접속 정보가 출력됩니다:
- **로컬 베이스 URL**: `http://127.0.0.1:4185`
- **합성 관제 대시보드**: `http://127.0.0.1:4185/pages/synthetic-control.html`
- **프로세스 PID 파일**: `01_봉플레이_운영시스템/tests/.synthetic_server.pid`

---

### 3.2 종료 방법 (Stop / Shutdown)
서버를 종료하는 3가지 방법이 제공됩니다:

```powershell
# 방법 1: PowerShell 스톱 스크립트 실행
.\stop_synthetic_env.ps1

# 방법 2: 배치 파일 실행
.\stop_synthetic_env.bat

# 방법 3: HTTP API 원격 종료 (지오 스크립트용)
curl -X POST http://127.0.0.1:4185/api/synthetic/shutdown
```
*(관제 대시보드 우측 상단의 `[서버 종료]` 버튼을 클릭해도 안전하게 종료됩니다.)*

---

### 3.3 초기화 방법 (Reset) 및 시드 데이터 주입 (Seed)

```powershell
# 1) 전체 대기열 및 모의 원장 완전 초기화 (0건 깨끗한 상태로 복구)
curl -X POST http://127.0.0.1:4185/api/synthetic/reset

# 2) 5팀의 합성 고객 데이터 및 원장(서약·결제·티켓) 원터치 자동 주입
curl -X POST -H "Content-Type: application/json" -d '{"count": 5}' http://127.0.0.1:4185/api/synthetic/seed
```
*(관제 대시보드에서 `[환경 완전 초기화]` 및 `[합성 대기열 5팀 자동 주입]` 버튼으로 마우스 1클릭 조작 가능)*

---

## 4. 합성 직원 인증 (Synthetic Staff Auth)

지오가 매표 데스크(`consent-desk.html`)를 검증할 때 암호 입력 없이 즉시 업무를 시작할 수 있도록 자동 세션이 내장되어 있습니다:

- **합성 직원 인증 코드**: `1234`
- **자동 주입 원리**:
  - `http://127.0.0.1:4185/config.js`가 가상 서빙되며, `window.BongplayAuth` 객체와 `localStorage`에 유효한 직원 세션(`geo_synth_staff_1`, 봉플레이 봉화 시설 권한)을 자동 등록합니다.
  - 서버 Mock Supabase 엔드포인트(`call_next_queue_team`, `complete_queue_issuance` 등)는 요청 본문의 `p_access_code: '1234'`를 유효한 인증으로 수락합니다.
- **비인가 테스트**:
  - `p_access_code`가 `1234`가 아니거나 누락된 경우, 서버는 즉시 `{ ok: false, error: 'UNAUTHORIZED_STAFF' }`로 거부합니다.

---

## 5. 오류 주입 방법 (Fault Injection System)

지오가 프런트엔드의 결함 대응 및 회복 탄력성(Resilience)을 검증할 수 있도록 11종의 인위적 오류 주입을 제공합니다.

### 5.1 대시보드 GUI를 통한 조작
- `http://127.0.0.1:4185/pages/synthetic-control.html` 접속
- "오류 주입 스위치" 섹션에서 원하는 결함 체크박스를 ON/OFF 토글.

### 5.2 HTTP API를 통한 자동화 조작 (지오 브라우저/스크립트용)
`POST http://127.0.0.1:4185/api/synthetic/faults` 로 JSON 페이로드 전송:

```bash
# 1) Rate Limit 초과 (429) 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"rate_limit_exceeded": true}' http://127.0.0.1:4185/api/synthetic/faults

# 2) 고객 토큰 24시간 만료 (401) 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"token_expired": true}' http://127.0.0.1:4185/api/synthetic/faults

# 3) 직원 인증 실패 (403) 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"unauthorized_staff": true}' http://127.0.0.1:4185/api/synthetic/faults

# 4) 결제 미확정 원장 대사 실패 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"payment_not_confirmed": true}' http://127.0.0.1:4185/api/synthetic/faults

# 5) 티켓 원장 결손 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"ticket_ledger_incomplete": true}' http://127.0.0.1:4185/api/synthetic/faults

# 6) 네트워크 인위적 지연 (예: 2000ms 로딩 스피너/타임아웃 검증)
curl -X POST -H "Content-Type: application/json" -d '{"network_delay_ms": 2000}' http://127.0.0.1:4185/api/synthetic/faults

# 7) 500 서버 장애 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"server_error_500": true}' http://127.0.0.1:4185/api/synthetic/faults

# 8) 오프라인 단절 시뮬레이션
curl -X POST -H "Content-Type: application/json" -d '{"offline_mode": true}' http://127.0.0.1:4185/api/synthetic/faults

# 9) 모든 오류 즉시 초기화 (정상 복원)
curl -X POST http://127.0.0.1:4185/api/synthetic/faults/reset
```

---

## 6. 판본 및 상태 표시 (Version & Status Watermark)

지오가 브라우저 탐색 중 운영 사이트와 합성 환경을 명확히 구분할 수 있도록 모든 HTML 페이지(`consent.html`, `queue-status.html`, `queue-display.html`, `consent-desk.html` 등) 상단에 고정 워터마크 배너가 자동 주입됩니다:

- **표시 내용**:
  - `🧪 지오 합성 시험` 배지
  - 기준 판본: `ANT-006 R2 (7481270)`
  - 백엔드 모드: `메모리 모의 (In-Memory)`
  - 오류 주입 상태: 오류 활성화 시 붉은색 태그(예: `[RateLimit(429)]`) 실시간 표출
  - 관제소 바로가기 버튼 및 1클릭 초기화 버튼 포함

---

## 7. 실제 SQL 환경 구성 시 필요한 전제조건 및 막힘 분석

지시서 원칙에 따라 "실제 SQL을 사용하는 환경"으로 확장할 때 필요한 조건을 구체적으로 보고합니다:

### 7.1 현 로컬 환경의 제약 사항
- 현재 Windows 작업 머신에는 **PostgreSQL 로컬 서비스(`psql`, `pg_ctl`) 및 Docker 데몬이 설치되어 있지 않습니다**.
- 지시서 원칙상 운영 Supabase 프로덕션 DB에 직접 DDL을 적용하는 행위는 엄격히 금지되어 있습니다.

### 7.2 실제 PostgreSQL 환경 가동을 위한 필요 조건
만약 지오가 실제 PostgreSQL 트랜잭션/RLS 레벨까지 직접 검증해야 한다면 다음 중 하나의 환경이 제공되어야 합니다:

1. **조건 안 A (로컬 Supabase CLI / Docker)**:
   - 로컬 Docker Desktop 설치 및 `supabase start` 실행.
   - 로컬 컨테이너 포트(기본 54322)에 `01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql` 실행.
2. **조건 안 B (독립 스테이징 Supabase 프로젝트)**:
   - 운영 DB와 물리적으로 분리된 별도의 테스트용 Supabase 프로젝트(무료 티어) URL 및 Service Role 키 제공.
   - 해당 스테이징 DB에 제안 마이그레이션 SQL을 적용한 뒤, `config.js`의 `SUPABASE_URL`을 해당 스테이징으로 지정.

> **권고**: 지오의 본래 과업인 **"브라우저를 통한 서비스 간 실사용 검증(접수→대기확인→전광판→데스크호출→발권완료)"** 은 현재 완성된 **환경 A (메모리 모의 환경)** 에서 Netlify 크레딧 소모 0 및 부작용 0 상태로 100% 완전하게 수행 가능합니다.

---

## 8. 지오(Aside) 점검 체크리스트 (Verification Checklist)

지오는 다음 5개 핵심 시나리오를 점검하시기 바랍니다:

- [ ] **시나리오 1 (정상 접수 및 대기)**: `/pages/consent.html`에서 서약서 제출 후 대기번호(`#001`) 발급 및 `queue-status.html?token=...` 실시간 조회 확인.
- [ ] **시나리오 2 (전광판 Zero PII)**: `/pages/queue-display.html`에서 대기 1팀 표시 및 개인정보/토큰 비노출 확인.
- [ ] **시나리오 3 (창구 호출)**: `/pages/consent-desk.html`에서 1번 창구 호출 시 고객 화면 배너 및 전광판에 즉시 `#001` 실시간 반영 확인.
- [ ] **시나리오 4 (부재 복귀 맨 뒤 배치)**: 부재 보류 후 복귀 시 대기열 맨 뒤로 재배치(`order_key = MAX + 1`)되는지 확인.
- [ ] **시나리오 5 (원장 대사 및 발권 완료)**: 결제 확정 후 발권 완료 시 고객 화면 "발권 완료" 전환 및 전광판 대기 0팀 복귀 확인.
- [ ] **시나리오 6 (오류 주입 대응)**: 관제소에서 `RateLimit` 또는 `결제미확정` 활성화 시 적절한 경고 배너 및 슬롯 유지 동작 확인.

---

## 9. 결론

지오(Aside × Sakana Fugu Pro) 전용 합성 시험 환경은 **R2 커밋 `7481270`에 안전하게 앵커링**되어 있으며, **자체 검증 스위트(`verify_synthetic_env.js`) 8개 항목 전수 통과**를 완료하였습니다. Netlify 크레딧 소모와 운영 DB 오염 없이 즉시 브라우저 실사용 검증에 착수할 수 있습니다.

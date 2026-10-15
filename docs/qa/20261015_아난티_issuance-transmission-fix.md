# ANT-006 발권 시 데이터 미전송 결함 분석·수정 및 원장 전송 정합성 검증 보고서

**과업명**: bongplay2.netlify.app 현장 발권 시 데이터 미전송 원인 분석 및 프런트엔드 결함 수정  
**담당**: 아난티 (Antigravity / Google Pro)  
**착수 시각**: 2026-10-15 15:30 KST  
**완료 시각**: 2026-10-15 16:30 KST  
**작업 공간**: `c:\Users\bongp\OneDrive\문서\new\.worktrees\ANT-006-ticket-queue` (전용 worktree)  
**작업 브랜치**: `antigravity/ANT-006-queue-followup`  
**기준 커밋 SHA (Base SHA)**: `2a0aacf910d65b91b97aee41f53d463fa78d5fd5`  
**구현 완료 SHA**: `d5c1b5a4eb53d05dc512493570712f99887b7214`  
**PR 대상 브랜치**: `master` (직접 병합/배포 금지)  
**배포 기준 환경**: 프런트 `2a0aacf` + DB 계약 `e8a9041` + 벤의 배포 보완본 `20261015-r2`  

---

## 1. 대표 발견 현상 및 실측 데이터 특정

### 1.1 대표 접수 데이터 원장 대사
- **발견 일시**: 2026-10-15 15:12 KST
- **고객 서약서**: `safety_consents` id: `cst_1792044745246_rzz7a` (보호자: 홍*현 [마스킹], 패스코드: `BP-261015-TSBY`, 도착시각: 15:12 KST)
- **발권 대기열**: `ticket_queue` id: `q_20261015_0043_39ca` (대기번호 #043, 상태: `waiting`, 고객토큰: `bpq_33454...[마스킹]`)
- **원장 대사 결과**:
  - `order_items`: `[]` (0건)
  - `order_payments`: `[]` (0건)
  - `ticket_ledger`: `[]` (0건)
  - `safety_consents.is_issued`: `false` (미발권)
  - **결론**: 대표 접수 후 창구에서 발권 시도 시 원장 저장 및 상태 갱신이 서버 DB에 일체 도달하지 못함.

---

## 2. 4대 결함 원인 분석 및 재현 (Root Causes)

Playwright 브라우저 E2E 실측 및 PostgREST 네트워크 트레이싱을 통해 다음 4개 원인을 전수 규명하고 100% 재현하였습니다:

### 2.1 원인 1: 기상안전 인터록 차단에 따른 무응답 (Silent Interlock Return)
- **원인 메커니즘**:
  - `bongplay-id.js`의 `recommendCartForConsent()`는 12:00 이후 접수 건에 대해 종합권(`tkt_allday`, 짚코스터 포함)을 기본 권종으로 추천함.
  - 시험/개발 환경에서는 AWS 기상 관측소 센서 데이터가 실시간 수신되지 않아 `getCoasterWeatherLock().locked`가 `true`(`기상 관측 데이터 미수신 → fail-closed`)로 판정됨.
  - 직원이 결제 모달을 열면 종합권(`tkt_allday`)이 담겨 있고, [결제 완료 & 발권]을 누르면 `confirmPayment()` 내의 `if (weatherLock.locked && cart['tkt_allday']) alert(...)` 인터록에 걸려 즉시 `return`됨.
  - 결과적으로 **서버로 단 1건의 HTTP 요청도 발생하지 않고 발권이 침묵 차단**됨.
- **수정**:
  - `bongplay-id.js`의 `defaultChildTicketId(at)`: `getCoasterWeatherLock().locked`가 활성화된 경우 Fail-safe 기본 권종으로 `tkt_basic`(기본이용권: 실내+네트, 짚코스터 미포함)을 안전 기본 추천.
  - `consent-desk.html`의 `openPaymentModal()`: 기상 잠금 시 카트에 짚코스터 상품이 포함되어 있다면 `tkt_basic`으로 안전 자동 전환. (안전 인터록을 절대 우회하지 않고 준수함).

### 2.2 원인 2: `safety_consents` 스키마 불일치(PGRST204) 및 Outbox 영구 고착
- **원인 메커니즘**:
  - 비짚코스터 권종(`tkt_basic`)으로 발권 시 `order_items`, `order_payments`, `ticket_ledger`는 201 Created로 정상 저장됨.
  - 그러나 마지막 단계인 `safety_consents` 발권완료(`is_issued: true`) 업데이트 시, 페이로드에 `cancel_reason: null`, `cancelled_at: null` 등이 포함됨.
  - 운영 DB 스키마(`FINAL_SUPABASE_SETUP.sql`)에는 `safety_consents`에 `cancel_reason` 컬럼이 없음 (취소 제안 마이그레이션 미적용 상태).
  - PostgREST가 `400 Bad Request (PGRST204: Could not find the 'cancel_reason' column)`를 반환함.
  - `bongplay-sync.js`의 `upsert()`는 `cancel_reason`을 `criticalCols`로 분류하여 컬럼 제거 재시도를 하지 않고 `schema_blocked: true, queued: true`로 아웃박스에 영구 격리.
  - 결과적으로 DB의 `is_issued`가 영구히 `false`로 남아, 화면 새로고침 또는 10초 주기 클라우드 폴링 시 다시 "발권대기"로 롤백됨.
- **수정**:
  - `bongplay-sync.js` (`upsert`, `patch`, `flushOutbox`): 누락 컬럼의 값이 `null` 또는 `undefined`인 경우, 유의미한 데이터 손실이 없으므로 컬럼을 안전하게 삭제하고 즉시 재시도하여 정상 저장을 완료하도록 보정.
  - `bongplay-sync.js` (`loadConsentsFromCloud`): 취소되지 않은 행에 `null` 취소 필드를 주입하지 않음.
  - `consent-desk.html` (`confirmPayment`): 발권 확정 시 불필요한 null 취소 필드를 페이로드에서 제거.

### 2.3 원인 3: 대기열 발권 확정 RPC 생명주기 및 호출 누락
- **원인 메커니즘**:
  - 서약서 목록에서 [즉시발권]을 누르면 `currentCalledQueueEntry`가 `null`이고 인메모리 스토어에 서버 대기열이 캐시되어 있지 않아 `complete_queue_issuance` RPC가 호출되지 않고 누락됨 (#043 대기열이 영구 `waiting` 상태로 잔류).
  - 또한 직원이 [창구호출]을 눌러 `called` 상태가 된 팀은, DB 계약(`complete_queue_issuance`)상 `processing` 상태여야만 발권 확정이 가능하며, `called` 상태에서 바로 발권 확정을 요청하면 DB가 `INVALID_STATUS` 오류로 거부함.
- **수정**:
  - `consent-desk.html` (`confirmPayment`):
    - `qEntry` 탐색 시 `currentCalledQueueEntry`, `BongplayQueue.store`뿐 아니라 서버에서 폴링한 `lastKnownStaffQueueData`(called_teams, waiting_teams, held_teams)를 전수 탐색.
    - `qEntry.status === 'called'`인 경우, `completeIssuance` 전에 `BongplayQueue.startProcessing`을 선행 호출하여 `processing` 상태 전이를 보장.

### 2.4 원인 4: `order_items` 필수 컬럼 누락
- **원인 메커니즘**:
  - `bongplay-id.js`의 `createOrder()`에서 품목 레코드 생성 시 `unit_price`, `total_price`, `category`, `status: 'paid'` 필드를 누락하여 DB 기본값(0)으로 저장됨.
  - DB 계약 RPC(`complete_queue_issuance`)가 `SUM(total_price)`를 검사할 때 불일치 위험 존재.
- **수정**:
  - `createOrder()`의 품목 생성 객체에 `unit_price: listPrice`, `total_price: paid`, `category: prod.category`, `status: 'paid'` 명시.

---

## 3. 벤의 배포 개선사항 보존 (`20261015-r2`)

벤이 배포 환경에서 적용한 외부 CDN 의존성 제거 및 보안 개선사항을 100% 보존하고 로컬에 반영하였습니다:
1. **로컬 벤더 스크립트 전환**:
   - `01_봉플레이_운영시스템/assets/vendor/` 디렉터리에 `tailwind-3.4.17.js`, `lucide-0.468.0.js`, `qrcode-1.0.0.js`, `supabase-2.49.1.js` 4개 파일 온프레미스 보존.
   - `consent-desk.html` 및 `consent.html`의 외부 CDN(`cdn.tailwindcss.com`, `jsdelivr.net` 등) 링크를 로컬 벤더 경로(`/assets/vendor/...`)로 전환.
2. **시험 배너 유지**:
   - `<div style="background:#92400e;color:white;text-align:center;padding:8px;font:14px sans-serif">시험용 · 합성 데이터만 입력 · 실제 결제 금지</div>`
3. **루사이드 아이콘 안전 호출**:
   - `window.lucide && window.lucide.createIcons();` 전수 방어적 호출.
4. **루트 상대 경로 링크**:
   - `/`, `/pages/gate`, `/pages/operations`, `/pages/safety-check`, `/pages/closing`, `/pages/consent`, `/pages/queue-display`, `/pages/queue-status`.

---

## 4. 수정 파일 목록

| 파일 | 수정 내용 |
|---|---|
| `01_봉플레이_운영시스템/assets/bongplay-id.js` | `defaultChildTicketId`: 기상 잠금 시 `tkt_basic` 안전 기본 추천.<br>`createOrder`: `order_items`에 `unit_price`, `total_price`, `category`, `status: 'paid'` 명시. |
| `01_봉플레이_운영시스템/assets/bongplay-sync.js` | `upsert`/`patch`/`flushOutbox`: 누락 컬럼이 null/undefined인 경우 criticalCols 블로킹 해제 및 컬럼 삭제 후 즉시 재시도.<br>`loadConsentsFromCloud`: 미취소 건에 null 취소 필드 주입 방지. |
| `01_봉플레이_운영시스템/pages/consent-desk.html` | 벤의 20261015-r2 배포본 보존 (로컬 벤더 스크립트, 시험 배너, 링크 경로).<br>`openPaymentModal`: 기상 잠금 시 `tkt_basic` 자동 전환 Fail-safe.<br>`confirmPayment`: `lastKnownStaffQueueData` 대기열 탐색, `called` → `startProcessing` 선행 전이, 원장 서버 확정 순서 엄수, null 취소 필드 제거. |
| `01_봉플레이_운영시스템/pages/consent.html` | 벤의 20261015-r2 배포본 보존 (로컬 벤더 스크립트, 시험 배너, queue-status 경로, 안전 lucide 호출). |
| `01_봉플레이_운영시스템/assets/vendor/*` | `tailwind-3.4.17.js`, `lucide-0.468.0.js`, `qrcode-1.0.0.js`, `supabase-2.49.1.js` 4종 로컬 벤더 파일 배치. |

---

## 5. 검증 결과

### 5.1 계약 시험 (`save-retry-contract.test.mjs`)
- 실행 명령: `node 01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs`
- 결과: **10 / 10 PASS (100%)**
  - C0 (서약서 서버 확정 후 대기열 발급): PASS
  - C1 (서약서 미확정 시 대기열 차단 및 확정 후 자동 완료): PASS
  - C5 (서약서 5xx 일시 실패 후 복구, 아웃박스 보존): PASS
  - C2 (대기열 응답 유실 후 동일 인자 수동 재시도): PASS
  - C3 (대기열 ENQUEUE_CONFLICT 자동 재시도): PASS
  - C4 (대기열 5xx 자동 재시도): PASS
  - D0 (원장 서버 확정 후 발권 완료): PASS
  - D1 (티켓 원장 미확정 시 발권 완료 차단): PASS
  - D2 (주문 원장 미확정 시 발권 완료 차단): PASS
  - D3 (발권 완료 응답 유실 후 동일 order/tickets 멱등 재시도): PASS

### 5.2 대기열 단위 시험 (`ticket_queue.test.js`)
- 실행 명령: `node 01_봉플레이_운영시스템/tests/ticket_queue.test.js`
- 결과: **26 / 26 PASS (100%)**

### 5.3 운영 무결성 시험 (`operations_integrity.test.js`)
- 실행 명령: `node 01_봉플레이_운영시스템/tests/operations_integrity.test.js`
- 결과: **29 / 29 PASS (100%)**

### 5.4 Playwright 브라우저 E2E 실측 검증 (`test_browser_desk_issuance.mjs`)
- 브라우저 환경에서 실제 `consent-desk.html`을 구동하여 발권 및 네트워크 요청 전수 추적:
  - 기상 잠금 시 `tkt_basic` 카트 자동 추천: **확인 완료**
  - 발권 완료 클릭 시 Supabase 네트워크 트레이스:
    - `POST /rest/v1/order_items` 2건 (201 Created)
    - `POST /rest/v1/order_payments` 1건 (201 Created)
    - `POST /rest/v1/ticket_ledger` 2건 (201 Created)
    - `POST /rest/v1/safety_consents` (201/200 OK)
  - 발권 완료 모달 표시: **확인 완료**
  - 브라우저 새로고침(F5) 후 발권 완료 유지 및 티켓 2매 보존: **확인 완료**

---

## 6. 남은 문제 및 DB 스키마 제안 보고 (벤 검토 요청)

1. **`safety_consents` 테이블의 취소 컬럼 추가 제안**:
   - 현재 프런트엔드에서는 `safety_consents`에 `cancel_reason` 컬럼이 없어 null 필드를 제거하고 저장함으로써 PGRST204 에러를 완벽히 회피하고 있습니다.
   - 그러나 향후 발권 취소(`toggleTicketIssue(id, false)`) 시 실제 취소 사유를 기록하려면 `database/PROPOSED_MIGRATION_safety_consents_cancellation.sql`에 정의된 `cancel_reason TEXT, cancelled_at TIMESTAMPTZ` 컬럼 추가 마이그레이션 적용을 권장합니다.

---

## 7. 벤 R1 보완 지시 및 지오 5대 발견 이슈 조치 내역 (2026-10-15 Follow-up)

**기준 커밋 SHA**: `6b9d0ae`  
**완료 일시**: 2026-10-15 17:55 KST  

### 7.1 벤 5대 보완 지시 이행
1. **[지시 ①] 부분 저장 뒤 결제 창 재열기·새로고침에도 동일 주문/티켓 ID 복구해 중복 매출 원천 방지**:
   - `consent-desk.html`의 `confirmPayment()` 시작 시 생성된 `order.order_id`와 `ticketIds`를 `localStorage.setItem('bongplay_pending_order_' + rec.id, ...)`에 기록.
   - 결제 도중 창을 닫거나 새로고침한 뒤 다시 결제창을 열 때(`openPaymentModal`), 해당 동의서 ID의 pending 기록을 검사하여 동일 `order_id`와 `ticket_ids`를 `payCtx`에 복원.
   - 발권 및 서약서 확정 저장이 성공 완료된 직후 `localStorage.removeItem('bongplay_pending_order_' + rec.id)`로 정리.
   - 결제 재시도 시 중복 매출 생성 원천 차단.
2. **[지시 ②] 결제 직전에 서버의 당일 KST 안전점검 PASS 실시간 확인**:
   - `confirmPayment()` 진입 직전 `BongplaySync.select('safety_audits', '?audit_date=eq.' + todayStr + '&select=audit_date,decision')` 실시간 서버 조회.
   - 서버에 합격(`pass`) 기록이 없으면 결제 진입 즉시 차단 및 경고 표출.
3. **[지시 ③] 원장 저장 전에 서약서-호출고객 일치 및 창구 `processing` 상태 검증, 대기/보류 고객 즉시발권 차단 및 FIFO 순차 호출 안내**:
   - `toggleTicketIssue`에서 서약서의 대기열 상태가 대기(`waiting`) 또는 부재보류(`held`/`no_show`)인 경우 결제창 진입을 원천 차단하고 `공정 대기 원칙(FIFO)` 경고 표출.
   - `confirmPayment`에서 선택 서약서와 현재 창구의 `currentCalledQueueEntry`의 일치 여부 검증.
   - `called` 상태인 경우 `BongplayQueue.startProcessing`을 선행 호출하여 `processing` 상태 전이를 확정하고, 유효한 창구 슬롯인지 철저 검증.
4. **[지시 ④] 중요 누락 컬럼 공통 동기화 우회 롤백**:
   - `bongplay-sync.js`를 롤백하여 `criticalCols`(`status`, `cancelled_at`, `cancel_reason`, `closing_status`) 누락 시 우회 삭제 없이 엄격 차단 및 아웃박스 격리 계약 복원.
   - DB 누락 컬럼 문제는 SQL 마이그레이션 적용을 통해 해결하도록 분리.
5. **[지시 ⑤] 지오 보고 5대 이슈 조치**:
   - **R-05 창구 정지 표시**: 버튼 라벨을 '창구 일시 중지 중 (클릭 시 운영 재개)' vs '창구 정상 운영 (클릭 시 일시 중지)'로 명확화하고 배너 안내와 동기화.
   - **R-04 호출 실패 안내**: 호출 실패 시 사유별 구체적 안내 배너(`deskCallNoticeBanner`) 및 alert 표출.
   - **R-03 권종 변경 후 결제 배분 자동 갱신**: 단일 결제수단 선택 시 권종/수량 변경 시 총 결제금액에 맞춰 배분 금액 자동 재계산.
   - **R-06 UTC 시각의 KST 변환**: 창구 배정 팀 호출 시각(`deskCalledTimeText`) 및 전광판 시각(`queue-display.html`)에 `formatKstTime()` 적용하여 06시→15시 KST 정상 표기.
   - **R-07 미전송 상태의 성공 제목 수정**: `consent.html`에서 오프라인/미전송 상태 시 바우처 상단 제목을 "접수 완료" 대신 "서약 접수 대기 중 (전송 대기/오프라인)"으로 동적 갱신.
6. **PII 마스킹 준수**: 보고서 및 로그 내 대표 실명(`홍*현`)과 고객 토큰(`bpq_33454...`) 전수 마스킹.

### 7.2 검증 결과 요약
- `ticket_queue.test.js`: **26 / 26 PASS (100%)**
- `operations_integrity.test.js`: **29 / 29 PASS (100%)**
- `save-retry-contract.test.mjs`: **10 / 10 PASS (100%)**
- `test_r1_supplementary_contract.mjs`: **5 / 5 PASS (100%)**

---

## 8. 벤 R2 보완 지시 (E1·E10) 조치 내역 (2026-10-15 Round 2)

**기준 커밋 SHA**: `71c944b`  
**완료 일시**: 2026-10-15 18:38 KST  

### 8.1 벤 R2 보완 지시 이행
1. **[지시 ① - E1] 결제 직전 안전점검 판정 false 초기화 및 서버 유효 당일 PASS 확인 (Fail-Closed 엄수)**:
   - `confirmPayment()` 진입 시 `isSafetyInspectionPassed`를 즉시 `false`로 초기화하고 `auditConfirmed = false`를 기본값으로 설정.
   - 서버 `safety_audits` 실시간 조회 성공 및 `data.length > 0`이면서 부적합(`fail`)이 없고 최신 판정이 `pass`일 때만 `isSafetyInspectionPassed = true`로 승인.
   - 빈 결과(0건), 조회 실패, 네트워크 예외 발생 시 일체 원장 쓰기(`order_items`, `order_payments`, `ticket_ledger`)를 진행하지 않고 즉시 차단 알림 표출.
   - `checkSafetyInterlock()`에서도 서버 조회가 가능한 환경에서는 로컬 캐시 우선이 아닌 서버 조회를 우선하여 단말-서버 간 안전 상태 불일치 방지.
2. **[지시 ② - E10] 발권 확정 저장 payload에 `status='active'`, `cancelled_at=null`, `cancel_reason=null` 명시**:
   - `consent-desk.html`의 발권 완료 저장 단계에서 `consentUpdatePayload`에 `status: 'active'`, `cancelled_at: null`, `cancel_reason: null`을 명시적으로 포함하여 전송.
   - 예전에 취소된 서약서의 재발권 시 과거 취소 필드가 서버에 잔류하지 않고 깨끗이 해제되도록 보장.
   - 발권 여부는 `is_issued: true`로 명확히 관리하며, 기존 발권 대기열의 재발권 허용 범위는 확대하지 않고 기존 FIFO 및 processing 계약 유지.

### 8.2 검증 결과 요약
- `ticket_queue.test.js`: **26 / 26 PASS (100%)**
- `operations_integrity.test.js`: **29 / 29 PASS (100%)**
- `save-retry-contract.test.mjs`: **10 / 10 PASS (100%)**
- `test_r1_supplementary_contract.mjs`: **5 / 5 PASS (100%)**
- `test_r2_e1_e10.mjs` (E1 빈 결과 차단, 503 에러 차단, E10 취소 필드 해제): **4 / 4 PASS (100%)**

---

## 9. 벤 R3 보완 지시 (E11) 조치 내역 (2026-10-15)

### 9.1 지시 사항 및 배경
- **배경 (E11 결함 원인)**:
  - 서버에서 운영자 암호가 변경되거나 세션이 만료된 경우, 매표 화면(`consent-desk.html`)이 3초 주기의 `refreshDeskQueueView()`를 통해 옛 암호로 `get_staff_queue_list`를 계속 반복 요청함.
  - 이로 인해 Supabase `private.auth_attempts`에 실패 로그가 지속 누적되어 10분 20회 초과 시 매표소 공유기 IP 전체가 잠기는 치명적 운영 사고(E6) 위험이 존재함.
- **벤 R3 지시 요건**:
  1. 직원 인증 실패(`UNAUTHORIZED_STAFF`) 수신 시 직원 자동 조회 및 재시도를 즉시 중단할 것.
  2. 저장된 직원 암호(`localStorage['bongplay_staff_session_v2']`)를 제거하고 재인증을 안내할 것 (`#bongplay-auth-overlay` 표출).
  3. 재인증 성공 시에만 조회를 재개하고, `setInterval` 타이머가 중복 생성되지 않도록 가드할 것.
  4. 진행 중인 주문·티켓 복구 기록(`bongplay_pending_order_*`)은 삭제하지 않고 안전하게 보존할 것.
  5. 서버 인증 제한(10분 20회 잠금 규칙)은 일체 완화하지 말 것.

### 9.2 상세 수정 내용
1. **`assets/config.template.js` 및 `assets/config.js`**:
   - `showAuthModal(onSuccess)`에 성공 콜백 인자 지원 및 이미 열려 있을 경우 포커스만 재지정.
   - `window.BongplayAuth`에 세션 제거 메서드 `clearSession()` 및 재인증 요청 메서드 `promptReauth(onSuccess)` 추가.
   - `promptReauth`: 기존 `bongplay_staff_session_v2`를 삭제하고 재인증 오버레이 모달을 띄워 서버 검증 성공 시 콜백 실행.
2. **`pages/consent-desk.html`**:
   - `deskQueuePollTimer`, `isStaffAuthFailed` 상태 변수 추가.
   - `stopQueuePolling()`: 활성화된 폴링 타이머가 있으면 `clearInterval` 후 null 처리.
   - `startQueuePolling()`: 항상 기존 타이머를 먼저 정리하고, `isStaffAuthFailed`가 아닐 때만 단일 3초 인터벌 등록 (타이머 중복 생성 원천 차단).
   - `isUnauthorizedStaff(resOrErr)`: 응답/에러 객체, 메시지, 문자열 전체에서 `UNAUTHORIZED_STAFF` 정밀 탐지.
   - `handleStaffAuthFailure(errorMsg)`:
     - 중복 호출 방지 가드 (`if (isStaffAuthFailed) return; isStaffAuthFailed = true;`).
     - 자동 조회 즉시 중단 (`stopQueuePolling()`).
     - 저장된 직원 암호 세션 제거 (`localStorage.removeItem('bongplay_staff_session_v2')`). 단, 진행 중 주문 복구 키인 `bongplay_pending_order_*`는 일체 건드리지 않고 보존.
     - `BongplayAuth.promptReauth(onReauthSuccess)` 호출하여 재인증 오버레이 표시.
     - 재인증 성공 시 `isStaffAuthFailed = false`, `startQueuePolling()`, `loadData()`, `refreshDeskQueueView()` 순차 실행하여 정상 복구.
   - `refreshDeskQueueView()`, `loadData()`, `toggleCurrentDeskPause()`, `handleCallNextQueueTeam()`, `handleRecallQueueTeam()`, `handleStartQueueProcessing()`, `handleHoldQueueTeam()`, `handleRestoreHeldTeam()`, `handleCancelQueueTeam()`, `confirmPayment()`의 `completeIssuance()` 전역에서 `UNAUTHORIZED_STAFF` 감지 시 즉시 핸들러로 라우팅.
3. **`tests/queue-contract/frontend-contract/harness.mjs`**:
   - 모의 `window.BongplayAuth`에 `clearSession`, `promptReauth` 지원.
   - `ROOT` 미설정 시 기본 경로 폴백 추가하여 계약 테스트 신뢰성 확보.

### 9.3 전수 검증 결과
- `ticket_queue.test.js`: **26 / 26 PASS (100%)**
- `operations_integrity.test.js`: **29 / 29 PASS (100%)**
- `save-retry-contract.test.mjs`: **10 / 10 PASS (100%)**
- `test_r2_e1_e10.mjs` (E1 fail-closed & E10 cancel fields reset): **4 / 4 PASS (100%)**
- `test_r3_e11.mjs` (E11 UNAUTHORIZED_STAFF 폴링 중단, 암호 삭제, 재인증 안내, 타이머 중복 방지, pending_order 보존): **4 / 4 PASS (100%)**
- **모든 테스트 통과 합계: 73건 전수 PASS**




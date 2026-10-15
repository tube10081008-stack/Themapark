# ANT-006 발권 시 데이터 미전송 결함 분석·수정 및 원장 전송 정합성 검증 보고서

**과업명**: bongplay2.netlify.app 현장 발권 시 데이터 미전송 원인 분석 및 프런트엔드 결함 수정  
**담당**: 아난티 (Antigravity / Google Pro)  
**착수 시각**: 2026-10-15 15:30 KST  
**완료 시각**: 2026-10-15 16:30 KST  
**작업 공간**: `c:\Users\bongp\OneDrive\문서\new\.worktrees\ANT-006-ticket-queue` (전용 worktree)  
**작업 브랜치**: `antigravity/ANT-006-queue-followup`  
**기준 커밋 SHA (Base SHA)**: `2a0aacf910d65b91b97aee41f53d463fa78d5fd5`  
**PR 대상 브랜치**: `master` (직접 병합/배포 금지)  
**배포 기준 환경**: 프런트 `2a0aacf` + DB 계약 `e8a9041` + 벤의 배포 보완본 `20261015-r2`  

---

## 1. 대표 발견 현상 및 실측 데이터 특정

### 1.1 대표 접수 데이터 원장 대사
- **발견 일시**: 2026-10-15 15:12 KST
- **고객 서약서**: `safety_consents` id: `cst_1792044745246_rzz7a` (보호자: 홍성현, 패스코드: `BP-261015-TSBY`, 도착시각: 15:12 KST)
- **발권 대기열**: `ticket_queue` id: `q_20261015_0043_39ca` (대기번호 #043, 상태: `waiting`, 고객토큰: `bpq_33454b6df1e7c538a7b9735d4d3a0e69`)
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
2. **대기열 FIFO 순서와 즉시발권 간 계약**:
   - DB 계약(`complete_queue_issuance`)은 `processing` 상태인 팀만 완료할 수 있습니다.
   - 직원이 서약서 목록에서 임의의 대기팀을 골라 [즉시발권]을 시도하는 경우, 해당 팀이 아직 창구에서 호출(`called`)되지 않은 상태라면 DB에서 상태 오류가 발생할 수 있습니다.
   - 따라서 대기열이 운영 중일 때는 반드시 [창구호출] → [발권 시작] 흐름을 따르거나, 특정 대기팀 직접 호출 RPC 지원 여부를 벤이 결정할 필요가 있습니다.

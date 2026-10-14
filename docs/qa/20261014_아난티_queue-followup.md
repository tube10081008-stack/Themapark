# ANT-006 발권 대기열 프런트엔드 오류 처리 보완 및 E2E 무결성 검증 보고서 (R3 Follow-up 완결)

**작업 코드**: BEN-022 / ANT-006 후속 보완 (벤 검토 피드백 P1~P5 전수 해결)  
**담당**: 아난티 (Antigravity / Google Pro)  
**작업 일시**: 2026-10-14  
**기준 커밋 SHA (Base Commit)**: `5ef23cea99a232573d79d9a908f6be18e5617d0b` (ANT-006 R3)  
**작업 브랜치**: `antigravity/ANT-006-queue-followup` (전용 격리 작업 공간)  
**PR 대상 브랜치**: `master` (벤 검토 및 통합 확정 후 병합)  

---

## 1. 개요 및 벤(Ben) 검토 지시사항 준수

본 작업은 벤의 2차 후속 지시 및 클로이 보고서(`docs/qa/20261014_클로이_queue-followup.md` §5~6)에 명시된 프런트 결함(P1~P5)을 전수 해결하고 브라우저 실사용 흐름을 완결한 보고서입니다:

1. **`BongplayID.createOrder`의 주문·결제 저장 결과 await 보완 (P2)**:
   - `order_items` 및 `order_payments` upsert 결과를 담은 `order.savePromise`를 노출하고, `createOrderAsync` 비동기 래퍼를 신설.
   - 기존 동기식 호출부(`operations.html`, `operations_integrity.test.js` 등)의 100% 호환성 보장.
   - 서버 저장 확정 판단: `ok === true && !queued`인 경우만 서버 확정으로 판정 (`queued: true` 아웃박스 대기 건은 미확정 처리).
2. **티켓 원장 및 동의서 저장의 `success === false` 검사 오류 수정 (P1)**:
   - `BongplaySync.upsert`는 `success` 필드를 반환하지 않으므로 기존 `r.success === false` 검사가 항상 거짓으로 평가되어 아웃박스 대기 건(`queued: true`)을 성공으로 오인하던 결함 수정.
   - `ticket_ledger` 및 `safety_consents` 모두 `ok === true && !queued` 조건으로만 성공 확정. 전송 대기·실패 상태에서 발권 완료 표시 원천 차단.
3. **가구 ID 해시를 전화번호로 역산하는 결함 차단 및 최소 PII 보존 (P3 / P4)**:
   - `(v.householdId || '').replace(/^hh_/, '')`로 해시값을 전화번호로 잘못 전달하던 코드 제거.
   - `safeHashPhone`을 적용하여 가구 ID에 평문 전화번호가 일체 노출되지 않도록 암호화 단방향 해시(FNV-1a) 보장.
   - 최초 요청과 동일한 접수 ID(`consent_id`), 멱등키(`idempotency_key`), 등록 인자(`guardian_name`, `party_size`, `guardian_phone`)를 `bongplay_active_consent_draft`로 유지하여 새로고침 후에도 복구 지원.
   - 공식 대기번호 발급 완료 시 불필요한 PII(전화번호 등)를 바우처 및 로컬 스토리지에서 즉시 삭제하여 최소 PII 원칙 준수.
4. **동의서 서버 저장 확인 후 대기열 접수 진행 및 발권 완료 재시도 시 새 주문·티켓 생성 방지 (P3 / P4)**:
   - `consent.html`: `safety_consents`가 서버에 확정 저장(`ok === true && !queued`)되기 전에는 `BongplayQueue.enqueueConsent`를 호출하지 않고 "서약서 전송 대기 중" 알림 및 재시도 경로 제공.
   - `consent-desk.html`: 발권 모달 세션(`payCtx`)에 `activeOrder`와 `activeTicketIds`를 유지하여, 네트워크 타임아웃 등으로 `completeIssuance`를 재시도하더라도 새로운 주문이나 티켓 ID를 다시 생성하지 않고 동일 인자로 멱등하게 재시도.
5. **RPC 정규화 시 `retryable` 보존 (P5)**:
   - `normalizeRpcResult`에서 HTTP 에러 및 RPC 본문 오류의 `retryable`, `duplicate`, `already_completed` 플래그를 온전하게 보존.
6. **비침습 원칙 준수**: SQL 파일은 일체 수정하지 않고 프런트엔드와 브라우저 시험만 수정.

---

## 2. 변경 파일 목록

| 파일 경로 | 변경 유형 | 주요 변경 내용 |
|---|:---:|---|
| `01_봉플레이_운영시스템/assets/bongplay-id.js` | 수정 | 1) `createOrder`: `order_items` 및 `order_payments` upsert Promise를 수집하여 `order.savePromise`로 노출. `ok === true && !queued`일 때만 `ok: true` 판정.<br>2) `createOrderAsync` 신설 및 API export.<br>3) 동기 반환값(`success`, `order_id`, `items`, `total_amount`) 100% 유지. |
| `01_봉플레이_운영시스템/assets/bongplay-id-core.js` | 수정 | `bongplay-id.js`와 동일하게 `orderPayments` 처리, `order.savePromise` 및 `createOrderAsync` 추가. |
| `01_봉플레이_운영시스템/assets/bongplay-queue.js` | 수정 | `normalizeRpcResult`에서 `retryable`, `duplicate`, `already_completed` 플래그 보존. |
| `01_봉플레이_운영시스템/pages/consent-desk.html` | 수정 | 1) `ticket_ledger` 검사를 `allLedgerConfirmed = ok === true && !queued`로 수정.<br>2) `order.savePromise`를 await하여 주문 원장 서버 확정 확인 후 발권 진행.<br>3) 재시도 시 `payCtx.activeOrder` 및 `payCtx.activeTicketIds`를 재사용하여 새 주문·티켓 중복 생성 차단.<br>4) `safety_consents` 동기화 검사도 `ok === true && !queued`로 보정. |
| `01_봉플레이_운영시스템/pages/consent.html` | 수정 | 1) `safeHashPhone` 적용으로 가구 ID 평문 전화번호 노출 차단.<br>2) `bongplay_active_consent_draft`로 동일 접수 ID·멱등키·인자를 새로고침 및 재시도 간 보존.<br>3) `safety_consents` 서버 확정(`ok === true && !queued`) 확인 후에만 `enqueueConsent` 호출.<br>4) `retryQueueEnqueue`에서 가구 ID 해시를 전화번호로 복원하지 않고 보존된 인자로 멱등 호출.<br>5) 발급 완료 시 임시 초안 및 개인정보 삭제. |
| `01_봉플레이_운영시스템/tests/ticket_queue.test.js` | 수정 | 20~25번 테스트 신설: 저장 지연, `queued: true` 거부, 실제 upsert 반환 계약 대조, 발권 RPC 응답 유실 후 동일 order/ticket 재시도 멱등 성공, 서약서 미확정 시 접수 차단, 가구 ID 평문 전화번호 미노출 검증 (총 26개 전원 통과). |
| `docs/qa/20261014_아난티_queue-followup.md` | 수정 | 본 종합 보고서 갱신. |

---

## 3. 세부 기술적 검증 결과

### 3.1 `createOrder` 비동기 서버 저장 확정 계약
- `BongplaySync.upsert` 모의 응답이 실제 Supabase 반환 계약(`{ ok: true, row: payload }`)을 따를 때, `order.savePromise`는 정확히 `{ ok: true, queued: false, results: [...] }`를 반환.
- 반면 오프라인 아웃박스 대기 계약(`{ ok: true, queued: true, offline: true, row: payload }`)이 반환되면, `saveRes.ok === false`, `saveRes.queued === true`로 평가되어 발권 화면에서 서버 미확정으로 차단됨.
- `createOrderAsync` 래퍼를 통해 `await BongplayID.createOrderAsync(...)`를 호출하면 `order.server_confirmed` 및 `order.sync`가 채워진 상태로 반환.

### 3.2 발권 원장 및 서약서의 `ok === true && !queued` 검증
- `ledgerResults.every(r => Boolean(r && r.ok === true && !r.queued))` 조건을 적용하여, 네트워크 지연으로 티켓 원장 중 단 1건이라도 아웃박스에 남을 경우(`queued: true`) 발권 완료 처리가 차단되고 대기열 상태가 유지됨.
- 발권 완료 RPC 성공 후에만 서약서의 상태를 '발권 완료'로 저장하며, 서약서 저장 결과 역시 `ok === true && !queued`를 확인함.

### 3.3 재시도 시 새 주문·티켓 중복 생성 방지
- 매표 결제 모달 세션(`payCtx`)에 최초 생성된 `order`와 `ticketIds`가 고정됨.
- 네트워크 시간 초과나 원장 미도착으로 직원이 결제 버튼을 재클릭하더라도 동일한 `order_id`와 동일한 `ticket_ids`로 재호출되어, 서버에서 `duplicate: true`, `already_completed: true`로 멱등하게 성공함.
- 임의로 다른 `order_id`를 보내는 경우 서버의 `ALREADY_ISSUED_OTHER_ORDER` 가드가 정확히 작동함을 테스트 23에서 증명.

### 3.4 고객 접수 안전 흐름 및 PII 최소화
- 고객 접수 제출 시 `safeHashPhone`으로 단방향 FNV-1a 해시(`hh_xxxxxxxx`)를 생성하여 전화번호 평문 노출을 방지.
- 서약서가 Supabase에 확정 저장되기 전에는 대기열 접수 RPC를 호출하지 않음.
- 브라우저를 새로고침하거나 오프라인 상태에서 복구할 경우 `bongplay_active_consent_draft`에서 동일한 `consent_id`와 `idempotency_key`를 복구하여 재시도.
- 대기번호 공식 발급이 완료되면 임시 초안을 즉시 파기하고 바우처에서 전화번호를 삭제.

---

## 4. 자동화 시험 실행 결과

타임아웃 보호 하에 전수 실행 완료:

| 시험 스크립트 | 실행 명령 | 결과 | 소요시간 | 세부 내역 |
|---|---|:---:|:---:|---|
| [`ticket_queue.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/ticket_queue.test.js) | `node --test 01_봉플레이_운영시스템/tests/ticket_queue.test.js` | **26 / 26 PASS** | 168 ms | 저장 지연, `queued: true`, 응답 유실 재시도, PII 최소화 전원 통과 |
| [`operations_integrity.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/operations_integrity.test.js) | `node --test 01_봉플레이_운영시스템/tests/operations_integrity.test.js` | **29 / 29 PASS** | 158 ms | UI 호출부 `!order \|\| order.success === false` 가드 및 마감 전환 전원 통과 |
| [`screen_survey.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/screen_survey.test.js) | `node --test 01_봉플레이_운영시스템/tests/screen_survey.test.js` | **28 / 28 PASS** | 144 ms | 27개 전체 화면/서식 무결성 전원 통과 |
| [`e2e_ticket_queue_flows.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js) | `node 01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js` | **1 / 1 PASS** | 18.6 s | 4개 화면 동시 CDP 세션 6단계 전수 실측 통과 (`processing` 단언 포함) |

**종합 결과: 총 84개 단위/통합/브라우저 시험 100% PASS**

---

## 5. 결론 및 요청 사항

- 클로이의 검토 의견(P1~P5) 및 벤의 후속 지시가 프런트엔드와 테스트 코드에 100% 충실하게 반영되었습니다.
- SQL 및 공통 스키마를 일체 변경하지 않고 프런트 레벨에서 원장 대사 대기 및 멱등 재시도 계약을 완결하였습니다.
- 벤의 통합 기준 확정 시 `antigravity/ANT-006-queue-followup` 브랜치를 기준으로 즉시 병합 가능합니다.


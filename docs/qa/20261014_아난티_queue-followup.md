# ANT-006 발권 대기열 프런트엔드 오류 처리 보완 및 계약 시험 완결 보고서 (배포 전 최종 보완)

**작업 코드**: BEN-022 / ANT-006 배포 전 최종 보완  
**담당**: 아난티 (Antigravity / Google Pro)  
**작업 일시**: 2026-10-14  
**기준 커밋 SHA (Base Commit)**: `5ef23cea99a232573d79d9a908f6be18e5617d0b` (ANT-006 R3)  
**직전 부모 커밋 SHA**: `669294024c0840b373fa35fcb91aa15729fb5a28`  
**최종 결과 전체 SHA (Final Commit)**: `f545eb02b315f2170d74893393cf527cf4724236`  
**작업 브랜치**: `antigravity/ANT-006-queue-followup` (전용 격리 작업 공간)  
**PR 대상 브랜치**: `master` (벤 검토 및 통합 확정 후 병합)  

---

## 1. 개요 및 벤(Ben) 최종 보완 지시사항 4개 전수 해결

본 작업은 벤의 배포 전 최종 보완 지시 및 클로이 보고서(`docs/qa/20261014_클로이_queue-followup.md` §10 C1~C5, D0~D3)에 명시된 원격 계약 시험을 전수 통과시키고, 운영 안전성을 확보하기 위해 진행되었습니다.

### 1.1 지시 1: 실패한 `activeOrder.savePromise` 영구 실패 버그 수정 (동일 주문·티켓 재확인)
- **원인**: 결제 모달(`payCtx`)에서 1차 시도 시 주문 저장(`order.savePromise`)이 네트워크 장애나 5xx로 실패한 경우, 해당 Promise가 영구적으로 실패(rejected/`ok:false`) 상태로 고정되어 직원이 결제를 재시도하더라도 서버 재확인 없이 즉시 동일 실패로 종료되는 현상.
- **수정**:
  - `bongplay-id.js` 및 `bongplay-id-core.js`의 `createOrder`에 `retrySave()` 및 `resyncSave()` 메서드 추가.
  - 기존 생성된 `order_id`와 `items`, `payments` 레코드를 그대로 재사용하여 Supabase upsert를 다시 실행하고 `order.savePromise`를 갱신.
  - `consent-desk.html`에서 `order.savePromise`가 미확정/실패 상태일 때 `order.retrySave()`를 호출하여 서버 저장을 재확인.
  - 신규 `order_id`나 신규 `ticket_ids`를 재생성하지 않고 동일한 식별자로 멱등하게 처리(중복 판매/중복 수납 원천 차단).

### 1.2 지시 2: `bongplay-sync.js` 일시 장애 시 Outbox 미전송 데이터 삭제 방지 (클로이 보고 §10 C5)
- **원인**: 신규 서약서/원장 저장 시 POST가 503 등 일시 장애를 겪은 후 3-2단계에서 충돌 대체용 PATCH를 시도할 때, 서버에 레코드가 아직 존재하지 않아 PostgREST가 `200 []`(0행 수정)를 반환. 이때 기존 코드가 이를 RLS 거부로 단정하고 `removeOutboxItem`을 호출하여 미전송 데이터를 아웃박스에서 삭제해버리던 치명적 결함(C5).
- **수정**:
  - `bongplay-sync.js` `upsert`에서 PATCH 결과가 `200 []`일 때, 이전 POST의 실패 원인이 `res.status >= 500`이거나 일시적 장애(`SAFETY_INTERLOCK_BLOCKED` 등)인 경우 **절대 Outbox 항목을 삭제하지 않고 `enqueueOutbox` 및 `{ ok: true, queued: true }`로 보존**.
  - `flushOutbox`에서도 PATCH가 0행 수정인 경우 성공으로 간주하지 않도록 보정.
  - 실제 401/403 권한 거부(RLS 잠금/보존 기록)와 일시 네트워크/서버 장애를 명확히 구분.

### 1.3 지시 3: 고객 접수 자동 재시도 루프 및 소진 시 “접수 미완료 — 매표소 문의” 표출
- **수정**:
  - `consent.html`에 지수 백오프 자동 재시도 루프 구현: **1초, 2초, 4초, 8초 간격으로 최대 4회 재시도** (클로이 계약 시험 C3 `ENQUEUE_CONFLICT`, C4 `HTTP 503` 전수 자동 복구).
  - 재시도 시 최초 제출 시의 동일 인자(`consent_id`, `idempotency_key`, `guardian_name`, `guardian_phone`, `party_size`)를 100% 동일하게 재전송.
  - `bongplay-queue.js` `enqueueConsent`에서 `idempotency_key`와 `party_size`를 덮어쓰지 않고 최우선 보존하도록 매핑 보정.
  - 4회 재시도 모두 소진 시:
    - 대기번호 영역(`voucherQueueNumberText`): **“접수 미완료 — 매표소 문의”** 표출.
    - 상태 배지(`voucherQueueStatusBadge`): **“접수 미완료”** (빨간색 경고 배지) 표출.
    - 매표소 문의 안내 알림 표시 및 수동 재시도 버튼 유지.
  - 서약서가 아직 서버에 미확정(Outbox 대기) 상태인 경우(`C1`), 서약서 확정 전 접수 RPC 호출을 차단하고, 서버 확정이 완료되는 즉시 백그라운드에서 사용자 조작 없이 자동으로 접수를 완료하여 대기번호(`#001`)를 발급.

### 1.4 지시 4: 클로이 원격 계약 시험 실행 및 무결성 검증
- 클로이가 작성한 `tests/queue-contract/frontend-contract/save-retry-contract.test.mjs` 10개 계약 시험을 헤드리스 Chromium 및 모의 PostgREST 하네스 환경에서 전수 실행.
- **성공 조건 완화 없이 10개 시험 10 / 10 PASS (100%) 달성**.

---

## 2. 변경 파일 목록

| 파일 경로 | 변경 유형 | 주요 변경 내용 |
|---|:---:|---|
| `01_봉플레이_운영시스템/assets/bongplay-sync.js` | 수정 | 1) C5 수정: POST 일시 장애(5xx/인터록) 후 PATCH `200 []` 수신 시 Outbox 항목 삭제 금지 및 큐잉 유지.<br>2) 권한 거부(401/403/RLS)와 일시 장애(5xx) 명확 분리.<br>3) `flushOutbox` PATCH 빈 배열 반환 시 성공 오인 방지. |
| `01_봉플레이_운영시스템/assets/bongplay-id.js` | 수정 | 1) `createOrder`에 `syncOrderRecords`, `retrySave`, `resyncSave` 메서드 추가.<br>2) 저장 실패 시 동일 `order_id`, `items`, `payments`로 서버 저장을 재확인 (새 주문·결제 생성 방지). |
| `01_봉플레이_운영시스템/assets/bongplay-id-core.js` | 수정 | `bongplay-id.js`와 동일하게 `retrySave`, `resyncSave`, `syncOrderRecords` 지원. |
| `01_봉플레이_운영시스템/assets/bongplay-queue.js` | 수정 | 1) `enqueueConsent`: `consentRecord.idempotency_key` 및 `party_size` 매핑 최우선 보존.<br>2) `retryable` 및 `status` 필드 전파 보장. |
| `01_봉플레이_운영시스템/pages/consent-desk.html` | 수정 | `order.savePromise` 미확정/실패 시 `order.retrySave()` / `resyncSave()`로 동일 주문 저장을 재확인하여 영구 실패 방지. |
| `01_봉플레이_운영시스템/pages/consent.html` | 수정 | 1) 서약서 서버 확정 전 접수 RPC 차단 및 서버 확정 감지 시 자동 접수 완결 (C1 해결).<br>2) 1·2·4·8초 간격 최대 4회 자동 재시도 루프 구현 (C3, C4 해결).<br>3) 재시도 소진 시 `voucherQueueNumberText`에 “접수 미완료 — 매표소 문의” 표출.<br>4) 수동 재시도 버튼과 자동 재시도 간 상호 타이머 정리 및 동일 인자 전송. |
| `docs/qa/20261014_아난티_queue-followup.md` | 수정 | 벤 지시 4개 해결 및 계약 시험 10/10 PASS 결과 기록. |

---

## 3. 계약 시험 실행 결과 (`save-retry-contract.test.mjs`)

실행 환경: Node.js v24.21.0, Playwright Headless Chromium, 모의 PostgREST (`harness.mjs`)  
실행 명령:
```bash
ANT006_ROOT=. node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs
```

### 3.1 계약 시험 10건 전수 실행 상세

| # | 시험 항목 | 결과 | 소요시간 | 검증 내용 |
|---|---|:---:|:---:|---|
| **C0** | 정상 접수 (양성 대조) | **PASS** | 868.9 ms | 서약서 확정 → 접수 RPC 1회 → 바우처 `#001` 발급 정상 검증 |
| **C1** | 서약서 저장 일시 503 후 서버 확정 대기 | **PASS** | 10,489.4 ms | 서약서 확정 전 접수 RPC 0회 유지, 아웃박스 플러시 후 사용자 조작 없이 `#001` 발급 검증 |
| **C5** | 첫 POST 503 후 PATCH 빈 배열 시 데이터 보존 | **PASS** | 10,399.9 ms | PATCH `200 []` 수신 시 Outbox에서 서약서를 삭제하지 않고 보존하여 15초 내 정상 저장 검증 |
| **C2** | 접수 응답 유실 후 수동 재시도 버튼 | **PASS** | 755.8 ms | 수동 재시도 시 첫 요청과 100% 동일한 인자(서약서 ID, 멱등키, 전화번호, 인원수)로 재전송 검증 |
| **C3** | 재시도 가능 오류 (`ENQUEUE_CONFLICT`) 자동 재시도 | **PASS** | 1,454.1 ms | 서버 충돌 거부 후 1초 지수 백오프로 자동 재시도하여 번호 정상 발급 검증 |
| **C4** | 접수 RPC HTTP 503 일시 장애 자동 재시도 | **PASS** | 1,498.5 ms | HTTP 503 수신 후 1초 지수 백오프로 동일 인자 자동 재시도 및 발급 검증 |
| **D0** | 정상 발권 (양성 대조) | **PASS** | 698.5 ms | 품목·결제·원장 서버 확정 확인 → 대기열 완료 1회 → 서약서 발권 완료 표시 순서 검증 |
| **D1** | `ticket_ledger` 쓰기 503 (아웃박스 대기) | **PASS** | 1,164.1 ms | 원장이 서버 확정(`ok && !queued`)이 아닐 때 완료 RPC 호출 차단 검증 |
| **D2** | `order_items` 쓰기 503 (아웃박스 대기) | **PASS** | 1,105.8 ms | 품목 원장이 서버 확정이 아닐 때 완료 RPC 호출 차단 검증 |
| **D3** | 완료 응답 유실 후 직원 결제 재클릭 | **PASS** | 770.1 ms | 결제 재클릭 시 동일 `order_id`와 동일 `ticket_ids`로 재호출하여 중복 판매·수납 0건 검증 |

**계약 시험 종합 결과: 10 / 10 PASS (100% 성공, 총 소요시간 29.34초)**

---

## 4. 기존 회귀 방지 시험 실행 결과

| 시험 스크립트 | 실행 명령 | 결과 | 소요시간 | 세부 내역 |
|---|---|:---:|:---:|---|
| [`save-retry-contract.test.mjs`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs) | `node --test --test-concurrency=1 .../save-retry-contract.test.mjs` | **10 / 10 PASS** | 29.3 s | 클로이 원격 계약 시험 10개 전수 통과 |
| [`ticket_queue.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/ticket_queue.test.js) | `node --test 01_봉플레이_운영시스템/tests/ticket_queue.test.js` | **26 / 26 PASS** | 160 ms | 발권 대기열 인메모리/통합 26개 전원 통과 |
| [`rpc-signature.test.mjs`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/rpc-signature.test.mjs) | `node --test .../rpc-signature.test.mjs` | **4 / 4 PASS** | 133 ms | 대기열 RPC 서명 및 인자 무결성 전원 통과 |
| [`operations_integrity.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/operations_integrity.test.js) | `node --test 01_봉플레이_운영시스템/tests/operations_integrity.test.js` | **29 / 29 PASS** | 170 ms | 운영 무결성, 폐지 품목 차단, 일일 안전점검 전원 통과 |

---

## 5. 최종 결론

1. 벤의 배포 전 최종 보완 지시 4개 항목을 프런트엔드 비침습 원칙(SQL 무수정) 하에 전수 해결하였습니다.
2. 클로이의 원격 계약 시험 `save-retry-contract.test.mjs` 10건이 타임아웃이나 단언 완화 없이 전수 정상 통과(10/10 PASS)하였습니다.
3. 운영 시스템 기존 핵심 무결성 시험 59건 역시 전수 100% 통과하여 회귀가 없음을 확인하였습니다.
4. 본 수정본은 커밋 및 원격 푸시를 완료하였으며, 벤의 통합 검토를 요청합니다.

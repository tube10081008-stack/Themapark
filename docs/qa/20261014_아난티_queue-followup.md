# ANT-006 발권 대기열 프런트엔드 오류 처리 보완 및 E2E 무결성 검증 보고서

**작업 코드**: BEN-022 / ANT-006 후속 보완  
**담당**: 아난티 (Antigravity / Google Pro)  
**작업 일시**: 2026-10-14  
**기준 커밋 SHA (Base Commit)**: `5ef23cea99a232573d79d9a908f6be18e5617d0b` (ANT-006 R3)  
**작업 브랜치**: `antigravity/ANT-006-queue-followup` (전용 격리 작업 공간)  
**결과 커밋 SHA (Result SHA)**: `antigravity/ANT-006-queue-followup` 브랜치 헤드 (`116a93a`)  
**PR 대상 브랜치**: `master` (벤 검토 및 통합 확정 후 병합)  

---

## 1. 개요 및 벤(Ben) 지시사항 준수

본 작업은 벤의 후속 지시에 따라 발권 대기열 프런트엔드 오류 처리 보완 및 실사용 E2E 브라우저 흐름을 완결한 보고서입니다:
1. **직원 조회 실패 시 '대기 0팀' 노출 차단**: 관제 RPC 응답 실패 시 인메모리 스토어로 임의 대체하여 정상 0팀으로 둔갑하던 버그를 제거하고, 미확인 상태(`-` 및 `대기 확인 불가 (연결 장애)`)로 안전하게 표시.
2. **동일 접수 ID(consent_id) 안전 재시도 보장**: 고객 서약서 작성 및 재시도 시 `currentConsentDraftId`를 보존하여, 통신 장애 후 재시도 시에도 동일한 접수 ID로 멱등성을 보장(중복 대기번호 채번 원천 방지). 바우처 오프라인 화면에 '대기번호 발급 재시도' 기능 신설.
3. **서버 확정 전 발권 완료 표시 차단**: `BongplayQueue.completeIssuance`의 서버 성공 응답(`ok: true`)을 확인하기 전에 서약서 상태를 '발권 완료'로 변경하거나 모달을 닫지 않도록 트랜잭션 순서를 재배치.
4. **E2E 브라우저 시험 `processing` 전이 보완**: `e2e_ticket_queue_flows.js`의 6단계에서 누락되었던 `startProcessing` 호출을 반영하고 고객 모바일 화면의 `발권 처리 중` 실시간 전파를 엄격히 단언하여, 성공 조건을 전혀 느슨하게 만들지 않고 전수 통과.
5. **비침습 원칙 준수**: SQL 및 공통 DB/API 계약을 일체 수정하지 않고 프런트엔드와 브라우저 시험 범위만 격리 수정.

---

## 2. 변경 파일 목록

| 파일 경로 | 변경 유형 | 주요 변경 내용 |
|---|:---:|---|
| `01_봉플레이_운영시스템/pages/consent-desk.html` | 수정 | 1) `refreshDeskQueueView`: 직원 관제 목록 조회 실패 시 인메모리 store로 fallback하여 `isSuccess = true`로 처리되던 버그 차단. 실패 시 직전 데이터가 0건이거나 없으면 절대 '대기 0팀'을 표기하지 않고 `-` 및 `대기 확인 불가 (연결 장애)` 표시.<br>2) `completePaymentAndIssue`: `completeIssuance`의 서버 `ok: true` 확정 전에 서약서(`safety_consents`) 발권 완료 변경 및 성공 모달 닫기를 수행하지 않도록 순서 재배치. |
| `01_봉플레이_운영시스템/pages/consent.html` | 수정 | 1) `currentConsentDraftId` 도입: 접수 실패 또는 네트워크 단절 후 재시도 시 동일한 `recordId`(`consent_id`)를 재사용하여 서버 멱등키 보장.<br>2) 바우처 오프라인 알림 상자에 `btnRetryQueueEnqueue`('대기번호 발급 재시도') 버튼 추가 및 `retryQueueEnqueue()` 구현.<br>3) `resetForNewGuest()` 시 드래프트 ID 리셋. |
| `01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js` | 수정 | 1) 6단계에서 `startProcessing` 전이 단계를 추가하고 `procRes.status === 'processing'` 및 모바일 고객 화면 `발권 처리 중` 상태를 엄격히 단언(`assert.equal`).<br>2) 성공 조건을 완화하지 않고 매표소 슬롯 비움, 고객 최종 발권 완료, 전광판 0팀 복귀의 기존 모든 단언 100% 유지. |
| `01_봉플레이_운영시스템/tests/ticket_queue.test.js` | 수정 | 19번 단위 시험 추가: 동일 `consent_id` 재시도 멱등성 검증(기존 순번 1번 유지, 번호 미증가, 스토어 총 1건 보존) 및 직원 조회 실패 시 `waiting_count: 0` 허위 반환 방지 규격 검증. |
| `docs/qa/20261014_아난티_queue-followup.md` | 신규 | 본 작업 결과 및 검증 보고서. |

---

## 3. 세부 수정 내용 및 기술적 검증

### 3.1 직원 조회 실패 시 '대기 0팀' 노출 방지 (`consent-desk.html`)
- **기존 문제**:
  - `BongplayQueue.store`가 인스턴스에 항상 존재하므로, 서버의 `getStaffQueueList` RPC가 실패하면 조용히 `else if (BongplayQueue.store)` 블록을 타면서 로컬 스토어의 0건을 취득하고 `isSuccess = true`로 둔갑하여 화면에 `대기 0팀`을 노출함.
  - 또한 직전 정상 조회 기록(`lastKnownStaffQueueData`)의 대기 인원이 0명이었던 경우, 현재 조회가 실패했음에도 `waitingCount = 0`이 되어 `대기 0팀 (연결 장애)`를 노출할 소지가 있었음.
- **수정 내용**:
  - `staffListRes.ok === false` 또는 catch 발생 시 `isSuccess = false`를 확정하고, Supabase 연동 환경에서는 로컬 fallback을 전면 차단.
  - 조회가 실패한 경우(`!isSuccess`):
    - 직전 정상 기록이 존재하고 1팀 이상(`waiting_count > 0`)인 경우에만: `waitEl.textContent = waitingCount;`, 배지 `대기 N팀 (연결 장애)` 표시.
    - 직전 기록이 없거나 직전 기록이 0팀이었던 경우: `waitEl.textContent = '-';`, 배지 `대기 확인 불가 (연결 장애)`로 표기하여 허위 0팀 노출 원천 차단.

### 3.2 동일 접수 ID 재시도 멱등성 보장 (`consent.html`)
- **기존 문제**:
  - 서약서 제출 함수 `handleConsentSubmit` 실행 시마다 무조건 `Date.now()` 기반의 새로운 `recordId`(`cst_...`)를 채번함.
  - 네트워크 타임아웃 등으로 접수 결과 응답이 유실되어 손님이 제출 버튼을 다시 누르면 새로운 `consent_id`가 발급되어 서버에서 별개의 2번 대기번호가 중복 발급되는 문제 발생.
- **수정 내용**:
  - 폼 작성 시점에 `currentConsentDraftId`, `currentConsentVisitId`, `currentConsentPassCode`를 보존.
  - 제출 실패 또는 재시도 시 보존된 `currentConsentDraftId`를 그대로 사용하여 동일한 `p_consent_id` 및 멱등키를 서버로 전송.
  - 바우처 화면에 대기열 번호가 미발급된 오프라인 상태일 경우 `대기번호 발급 재시도` 버튼을 제공하여, 동일한 `v.consentId`로 `BongplayQueue.enqueueConsent`를 호출할 수 있도록 구현.
  - '다른 일행 서약하기'(`resetForNewGuest`) 클릭 시에만 드래프트 ID를 리셋.

### 3.3 서버 저장 확인 전 발권 완료 표시 방지 (`consent-desk.html`)
- **기존 문제**:
  - 매표소 데스크 결제 완료 처리 시 `rec.isIssued = true` 및 `safety_consents` 저장을 먼저 수행한 후 `BongplayQueue.completeIssuance`를 호출함.
  - 대기열 완료 RPC가 실패하더라도 메모리 상의 `rec.isIssued`는 이미 `true`가 되어 서약서 목록에 '발권 완료'로 표시되는 상태 불일치 발생.
- **수정 내용**:
  - `BongplayQueue.completeIssuance`의 호출 및 성공(`qRes && qRes.ok`) 응답을 최우선으로 검증.
  - 대기열 완료가 실패하면 `alert('❌ 대기열 발권 확정 실패: ...')`를 노출하고 즉시 반환(`return`).
  - `rec.isIssued` 변조, `safety_consents` 상태 갱신, 창구 배정 슬롯 해제(`currentCalledQueueEntry = null`), 성공 모달 닫기는 반드시 대기열 완료 성공 확인 후에만 순차 실행.

### 3.4 대기열 E2E 브라우저 시험 `processing` 전이 보완 (`e2e_ticket_queue_flows.js`)
- **기존 문제**:
  - 커밋 `30ac524` (R3 Fix 4)에서 계약 §2.1에 따라 `complete_queue_issuance` 호출 시 `status = 'processing'` 상태를 필수로 요구하도록 수정되었으나, `e2e_ticket_queue_flows.js`의 6단계는 `called` 상태에서 곧바로 `completeIssuance`를 호출하여 단언 실패 발생.
- **수정 내용**:
  - 6단계 도입부에 `startProcessing` 전이를 명시적으로 실행.
  - 처리 개시 성공(`procRes.ok && procRes.status === 'processing'`) 및 고객 모바일 화면의 실시간 `발권 처리 중` 상태 전환을 엄격히 단언(`assert.equal(custProcStatus, '발권 처리 중')`).
  - 발권 완료 후 매표소 슬롯 비움(`deskCalledEmptyBox`), 고객 화면 `발권 완료`, 공개 전광판 `대기 0팀` 복귀의 기존 모든 단언을 전혀 느슨하게 하지 않고 유지.

---

## 4. 백엔드 계약 의존 사항 분리 보고 (Backend Contract Dependencies)

프런트엔드 수정과 무관하게 백엔드 SQL 및 DB 구조에 의존하는 항목들을 명확히 분리하여 보고합니다:

1. **`complete_queue_issuance` RPC의 상태 전이 계약**:
   - 백엔드는 현재 대기팀이 `status = 'processing'` 상태일 때만 발권 완료를 수용하도록 설계되어 있습니다.
   - 직원이 창구에서 손님 호출 후 실물 발권 모달을 열지 않고 곧바로 결제 처리를 시도할 경우 백엔드에서 `INVALID_STATUS` 에러를 반환하므로, 프런트엔드는 반드시 `startProcessing` 호출을 선행해야 합니다.
2. **원장 대사(Ledger Reconciliation) 계약 (CLAUDE-011 R3 리뷰 F1~F4)**:
   - **F1 (주문 총액 vs 수납 합계)**: 데스크가 `order_items`에 할인 후 단가인 `paid_amount`를 기록할 때 백엔드가 `total_price`만을 집계하면 검증이 우회될 수 있으므로, 백엔드 SQL의 `COALESCE(SUM(paid_amount), SUM(total_price))` 대사 계약이 필요합니다.
   - **F2/F4 (티켓 수량 vs 품목 범주)**: 음료·식음료가 포함된 복합 주문 시 백엔드가 전체 품목 수량을 집계하지 않고 `item_category = 'ticket'`(또는 `product_category = 'ticket'`) 품목만 집계하도록 SQL 계약 정합성이 확정되어야 합니다.
   - **F3 (서약서 연결 검증)**: 주문 및 티켓에 `consent_id`가 NULL로 들어간 건을 백엔드가 엄격히 거부하는 계약이 필요합니다.
3. **고객 비밀 토큰 만료 정책 (24시간 vs 당일 영업 마감)**:
   - 프런트엔드는 현재 24시간(`enqueued_at < NOW() - INTERVAL '24 hours'`) 만료를 감지하도록 구현되어 있습니다. 계약 초안의 당일 현장 영업 마감(21:00 KST) 일괄 만료 정책으로 확정될 경우 백엔드 RPC 및 토큰 만료 에러코드 처리 기준을 벤이 최종 결정해야 합니다.

---

## 5. 자동화 시험 실행 결과 (전수 통과)

모든 시험은 타임아웃 보호(30초~60초) 하에 격리 실행되었습니다.

| 시험 스크립트 | 실행 명령 | 결과 | 소요시간 | 세부 내역 |
|---|---|:---:|:---:|---|
| [`ticket_queue.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/ticket_queue.test.js) | `node --test 01_봉플레이_운영시스템/tests/ticket_queue.test.js` | **20 / 20 PASS** | 121 ms | 19번 동일 consent_id 멱등성 & 직원 조회 오류 안전 시험 포함 전원 통과 |
| [`operations_integrity.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/operations_integrity.test.js) | `node --test 01_봉플레이_운영시스템/tests/operations_integrity.test.js` | **29 / 29 PASS** | 173 ms | 마감 날짜 전환, 안전점검 인터록, 폐지 상품 주문 차단 전원 통과 |
| [`screen_survey.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/screen_survey.test.js) | `node --test 01_봉플레이_운영시스템/tests/screen_survey.test.js` | **28 / 28 PASS** | 228 ms | 27개 전체 화면/서식 및 링크 무결성 전원 통과 |
| [`headless_browser.test.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/headless_browser.test.js) | `node --test 01_봉플레이_운영시스템/tests/headless_browser.test.js` | **9 / 9 PASS** | 25.8 s | 모바일/데스크톱 해상도별 렌더링 및 15,000원 요금 고지 실측 통과 |
| [`e2e_browser_flows.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/e2e_browser_flows.js) | `node --test 01_봉플레이_운영시스템/tests/e2e_browser_flows.js` | **3 / 3 PASS** | 19.4 s | 1) 안전점검 인터록<br>2) 게이트 입퇴장·취소<br>3) 마감 A/B일 격리 전원 통과 |
| [`e2e_ticket_queue_flows.js`](file:///C:/Users/bongp/OneDrive/문서/new/.worktrees/ANT-006-ticket-queue/01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js) | `node --test 01_봉플레이_운영시스템/tests/e2e_ticket_queue_flows.js` | **1 / 1 PASS** | 22.8 s | 4개 화면 동시 CDP 세션 6단계 전수 실측 통과 (`processing` 단언 포함) |

**종합 결과: 총 88개 단위/통합/E2E 테스트 100% PASS**

---

## 6. 미검증 항목 및 결정 요청 사항

### 6.1 미검증 항목 (Unverified Items)
1. **실제 Supabase 클라우드 인스턴스 RPC 호출**:
   - 로컬 테스트 및 브라우저 E2E는 로컬 mock RPC 서버 및 인메모리 스토어로 100% 검증되었으나, 실제 Supabase 클라우드 환경에 `PROPOSED_MIGRATION_ticket_queue.sql`이 배포된 상태에서의 통합 시험은 벤의 마이그레이션 적용 승인 대기 중입니다.
2. **오프라인 진입 후 재접속 시 브라우저 자동 재시도 큐**:
   - 손님이 네트워크 단절 상태에서 수동으로 '대기번호 발급 재시도' 버튼을 누르는 흐름은 검증되었으나, Service Worker 백그라운드 싱크를 통한 자동 재전송은 브라우저 백그라운드 동기화 지원 여부에 따라 기기별 편차가 있을 수 있습니다.

### 6.2 벤(Ben) 및 대표 결정 요청 사항
- **[D1] 고객 대기 토큰 만료 기준 최종 확정**:
  - 현재 구현: 발급 시점 기준 24시간(`24 hours`).
  - 대안: 당일 영업 마감 시각(21:00 KST) 일괄 만료.
  - 야간에 다음 날 일정을 미리 확인하려는 손님의 편의를 위해 24시간을 유지할지 여부 결정 요청.
- **[D2] CLAUDE-011 R3 SQL 패치(F1~F4) 통합 일정 확정**:
  - 클로이가 작성한 `claude/CLAUDE-011-r3-ledger-fix`의 원장 대사 SQL 패치와 본 브랜치의 프런트엔드 오류 처리 보완본의 통합 머지 시점 확정 요청.

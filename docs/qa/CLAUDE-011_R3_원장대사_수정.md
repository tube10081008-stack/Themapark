# CLAUDE-011 — ANT-006 R3 발권 완료 원장 대사 수정 (F1~F4)

- 지시: 벤 (2026-10-10). "R3 에서 별도 수정 브랜치를 만들어 §11 의 F1~F4 를 직접 수정"
- 브랜치: `claude/CLAUDE-011-r3-ledger-fix`
- 기준: `antigravity/ANT-006-ticket-queue` R3 `30ac524c05b75405bbc6bbbdb3f5ebe44f24af9d`
- 수정 범위
  - 제안 SQL `01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql` 의 `complete_queue_issuance` 원장 대사 부분(7~12단계)
  - 독립 검증 시험 `01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/`
- 수정하지 않은 것: 화면(`pages/`), `bongplay-queue.js`, 그 밖의 SQL 함수, 운영 DB.
  - 시험 폴더는 CLAUDE-011 브랜치 `2ae9e1f` 의 파일을 바이트 그대로 가져왔고, 새 시험은 별도 파일로 추가했다 (두 브랜치 통합 시 충돌 방지).

## 1. 근거: 실제 저장 구조

매표 데스크 `bongplay-id.js` `createOrder` 가 실제로 쓰는 열 기준이다 (같은 커밋에서 확인).

| 테이블 | 쓰는 열 | 쓰지 않는 열 |
|---|---|---|
| `order_items` | `order_id`, `product_id`, `product_category`, `quantity`, `list_price`, `discount_amount`, `paid_amount`(= 정가×수량 − 할인), `consent_id`, (취소 시 `status`·`cancelled_at`) | `total_price`, `category`, `unit_price` (기본값 0/NULL) |
| `order_payments` | `order_id`, `consent_id`, `method`, `amount`(> 0 만 기록), `status`('paid'/'cancelled'), `cancelled_at` | |
| `ticket_ledger` | 입장권 품목(`product_category='ticket'`)에만 1매당 1행. `ticket_id`, `order_id`, `consent_id`, `status`, (`cancelled_at`) | |

## 2. 수정한 대사 규칙 (`complete_queue_issuance` 7~12단계)

**활성 품목** = 해당 주문의 `order_items` 중 `status <> 'cancelled'` 이고 `cancelled_at IS NULL` 인 행.

| 단계 | 규칙 | 오류 코드 | 해결하는 결함 |
|---|---|---|---|
| 7 | 활성 품목이 1행 이상이어야 하고, **모든** 활성 품목의 `consent_id` 가 대기 팀 서약서와 같아야 함 (NULL·다른 값 거부) | `ORDER_ITEMS_EMPTY`, `ORDER_CONSENT_MISMATCH` | F3 |
| 8 | 이 주문의 결제 행은 **모두** 대기 팀 서약서 소속이어야 함 (NULL·다른 값 거부) | `ORDER_CONSENT_MISMATCH` | F3 |
| 9 | 요청 티켓 id 중복 금지 | `DUPLICATE_TICKET_IDS` (신규) | F4 보조 |
| 10 | 입장권 수량 = 활성 품목 중 `product_category='ticket'` 의 수량 합. 0 이면 거부. 요청 티켓 수와 **정확히 같아야** 함 | `ORDER_TICKET_ITEMS_EMPTY` (신규), `TICKET_QUANTITY_MISMATCH` | F2, F4 |
| 11 | 요청 티켓 전부가 이 주문·이 서약서(**양성 일치**)의 활성 티켓이어야 함. 이 주문의 활성 티켓 원장 수도 입장권 수량과 같아야 함 | `TICKET_LEDGER_INCOMPLETE` | F3, F4 |
| 12 | 주문 금액 = 활성 품목 `paid_amount` 합 (할인 후). `paid_amount` 가 0 인 구 형식 행만 `total_price` 로 보완. 유효 결제(`status='paid'`, 미취소, 같은 서약서) 합계가 주문 금액 이상이어야 함. 주문 금액이 0 이면 결제 없이 허용 (무료권) | `PAYMENT_NOT_CONFIRMED`, `PARTIAL_PAYMENT_REJECTED` | F1 |

그대로 둔 단계:
- 1~6: 직원 인증, 입력 검사, 행 잠금, 같은 주문 재시도 시 같은 성공, `processing` 상태만 허용, 원장 테이블 존재, 서약서 존재
- 13~15: 처리 시간, 상태 갱신, 창구 해제

## 3. 검증 결과 (PGlite 0.5.8 / PostgreSQL 18.3, Node v22.22.2)

| 시험 | 대상 | 결과 |
|---|---|---|
| `rpc-signature.test.mjs` | 이 브랜치 | 4/4 통과 |
| `sql-conformance.test.mjs` (CLAUDE-011 §11 의 42개) | 이 브랜치 | §3.1 |
| `sql-ledger-fix.test.mjs` (신규 경계 11개) | 이 브랜치 | 11/11 통과 |
| `sql-ledger-fix.test.mjs` | 원본 R3 `30ac524` | §3.2 (시험이 R3 결함을 잡는지 확인) |
| ANT-006 자체 `ticket_queue.test.js` | 이 브랜치 | 19/19 통과 (메모리 저장소 대상, SQL 변경과 무관) |

### 3.1 기존 42개 — R3 원본 37/42 → 이 브랜치 **41/42**

| §11 항목 | R3 원본 | 이 브랜치 |
|---|---|---|
| F1 부분 수납 (수납 10,000 < 주문 30,000) | 실패 (대사 생략) | **통과** (`PARTIAL_PAYMENT_REJECTED`) |
| F2 정상 혼합 주문 (입장권 2 + 음료 1) | 실패 (오거부) | **통과** (완료) |
| F3 서약서 연결 없는 주문 | 실패 (수용) | **통과** (거부) |
| F4 주문 수량보다 많은 티켓 | 실패 (수용) | **통과** (거부) |
| 할인 주문 정상 완료 | 통과 (대사 생략 덕분) | **통과** (할인 후 금액으로 실제 대사) |
| 토큰 만료 — 영업일 기준 | 실패 | 실패 (**정책 차이**, 이번 수정 범위 밖) |

나머지 36개(권한·접근 코드·공개 ID·다른 팀 티켓·주문·취소·결제·재시도·`called` 완료·pgcrypto 등)는 R3 와 같이 모두 통과했다. 회귀가 없다.

### 3.2 신규 경계 시험 11개 — 이 브랜치 11/11, 원본 R3 **3/11**

| 시험 | R3 원본 | 이 브랜치 |
|---|---|---|
| 무료권(금액 0) 결제 없이 완료 | 실패 (`PAYMENT_NOT_CONFIRMED` 오거부) | 통과 |
| 취소 품목은 수량·금액에서 제외 | 실패 (`TICKET_QUANTITY_MISMATCH` 오거부) | 통과 |
| 구 형식(`total_price` 만) 부분 수납 거부 | 통과 | 통과 |
| 요청 티켓 중복 거부 | 통과 | 통과 |
| 주문 활성 티켓이 수량보다 많으면 거부 | 실패 (수용) | 통과 |
| 같은 주문에 다른 서약서 결제 섞이면 거부 | 통과 | 통과 |
| 서약서 연결 없는 결제 거부 | 실패 (수용) | 통과 |
| 다른 서약서 품목 섞이면 거부 | 실패 (수용) | 통과 |
| 서약서 연결 없는 티켓 거부 | 실패 (수용) | 통과 |
| 분할 결제(현금+카드)·할인·혼합·초과 수납 정상 완료 | 실패 (오거부) | 통과 |
| 취소 결제는 수납 합계에서 제외 | 실패 (수용) | 통과 |

원본 R3 에서 8개가 실패하므로, 신규 시험이 실제로 결함을 잡는다는 것을 확인했다.

## 4. 계약으로 보고하는 필요 변경 (이 브랜치에서 수정하지 않음)

1. **매표 화면 `consent-desk.html` (아난티)**
   - 발권 완료 RPC 를 호출하기 전에 `order_items`·`order_payments`·`ticket_ledger` 쓰기가 **서버에 확정**되어야 한다. `BongplaySync.upsert` 결과가 `queued` 가 아니어야 한다.
   - 현재는 `ticket_ledger` upsert 를 await 하지 않는다. 이번 수정으로 대사가 엄격해져, 원장이 outbox 에 남아 있으면 `TICKET_LEDGER_INCOMPLETE`·`ORDER_ITEMS_EMPTY` 로 거부된다.
   - 화면은 이 오류를 "원장 전송 대기 — 재시도" 로 표시하고, 같은 주문 id 로 재호출해야 한다 (계약 §7 재시도).
2. **`bongplay-queue.js` `completeIssuance` (아난티)**
   - `p_ticket_ids` 에는 그 주문의 **입장권 티켓 id 전부, 중복 없이** 넘긴다.
   - 새 오류 코드 `DUPLICATE_TICKET_IDS`·`ORDER_TICKET_ITEMS_EMPTY` 를 화면 문구에 연결한다.
   - `ORDER_CONSENT_MISMATCH` 는 이제 "서약서 연결 없음" 도 포함한다.
3. **다른 판매 경로**
   - 매표 데스크 외 경로(예약·현장 판매 등)의 주문을 대기 팀 발권 완료에 쓰려면, 품목·결제·티켓에 같은 `consent_id` 를 채워야 한다.
   - 채우지 않은 주문은 이번 규칙으로 거부된다. 의도된 동작이다 (F3).
4. **계약 문서 §7 확정 조건 (제안 A2) 갱신 제안**
   - 확정 조건을 위 §2 표(활성 품목, 입장권 수량 정확 일치, 할인 후 금액, 양성 소속)로 구체화한다.
   - CLAUDE-011 계약 문서는 이 브랜치에 없다. 벤 승인 후 CLAUDE-011 브랜치에서 반영한다.

## 5. 남은 차이·미실행

- **토큰 만료 정책 차이** (계약: 영업일 종료, 구현: 24시간). 기능 결함과 분리한다. 벤 결정 대기. 이 브랜치에서 수정하지 않았다.
- **R3 에서 변경되지 않은 관찰**: 토큰 단위 요청 제한, `gijang-main` 하드코딩, 잠금 없는 창구 활성 검사, `consent.html` 동의서 id 재생성. 이번 범위 밖이다.
- **미실행**
  - 실제 Supabase/PostgREST
  - 동시 연결 (같은 팀 동시 완료 등)
  - 브라우저 화면
  - 운영 DB 적용·배포
- PGlite 결과는 구현 통과의 최종 근거가 아니다.

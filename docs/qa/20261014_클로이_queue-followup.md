# 대기열 백엔드 후속 수정 — 클로이 (CLAUDE-011 후속, 2026-10-14)

- 지시: 벤 (2026-10-14). 원장 수정 6e23209 의 통합 적합성 확인, 부분 수납·혼합 주문·동의서 연결·초과 발권 검증과 동시 접수 번호 충돌 수정, 저장 완료·발권 완료 API 계약 보고
- 담당 범위: 대기열 제안 SQL, 백엔드 시험. **프런트 파일(`pages/`, `assets/`)은 수정하지 않았다.** 운영 DB·Supabase 에 적용하지 않았다.
- 브랜치: `claude/CLAUDE-011-queue-followup` (전용 작업 폴더 `Themapark-c011q`, git worktree)
- 착수: 2026-10-14T17:48:25+09:00 (KST, 시스템 시각). 종료 시각은 최종 답변에 적는다.

## 1. SHA

| 구분 | SHA |
|---|---|
| 기준 (ANT-006 `antigravity/ANT-006-ticket-queue`) | `5ef23cea99a232573d79d9a908f6be18e5617d0b` |
| 통합한 원장 수정 (`claude/CLAUDE-011-r3-ledger-fix`) | `6e23209ea0100b09feff40ea3872c49373ca8932` |
| 통합 병합 커밋 | `2f5b37c` (이 브랜치 첫 커밋) |
| 결과 — SQL·시험 수정 커밋 | `592d181cfed4fcb321d8c211cd5c72e579014f5d` |
| 결과 — 이 보고서 커밋 | 최종 답변에 기재 (자기 SHA 는 파일 안에 적을 수 없음) |

## 2. 변경 파일 (기준 5ef23ce 대비)

| 파일 | 내용 |
|---|---|
| `01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql` | 6e23209 원장 대사(7~12단계) + 이번 수정 (§4) |
| `tests/queue-contract/ant006-conformance/supabase-emulation.mjs` (신규) | Supabase 모사 SQL 공용화 (PGlite·로컬 PostgreSQL 두 계층이 공유) |
| `…/harness.mjs` | 공용 모듈 사용으로 정리. 외부 동작·내보내기 동일 |
| `…/pg-harness.mjs` (신규) | 로컬 PostgreSQL 다중 연결 계층. 호스트가 127.0.0.1·localhost 가 아니면 실행 거부 |
| `…/pg-concurrency.test.mjs` (신규) | 동시 연결 시험 7건 |
| `…/sql-followup.test.mjs` (신규) | 순차 동작 시험 3건 (PGlite) |
| `…/README.md` | 계층 표·실행 방법 갱신 |
| `…/rpc-signature`·`sql-conformance`·`sql-ledger-fix`·`status-map` | 6e23209 에서 그대로 들어옴 (변경 없음) |
| `docs/qa/CLAUDE-011_R3_원장대사_수정.md` | 6e23209 에서 그대로 들어옴 |
| `docs/qa/20261014_클로이_queue-followup.md` | 이 보고서 |

## 3. 6e23209 통합 적합성

- 기준 30ac524 → 5ef23ce 변경 파일은 `pages/consent-desk.html`·`queue-display.html`·`queue-status.html` 3개뿐이다. 6e23209 의 변경 파일(SQL·시험·문서)과 겹치지 않아 **충돌 없이 병합**됐다.
- 병합 직후(이번 수정 전) 결과: `sql-conformance` 41/42, `sql-ledger-fix` 11/11, `rpc-signature` 4/4. R3 기준 결과와 같다. 실패 1건은 토큰 만료 **정책 차이**(계약 영업일 종료 대 구현 24시간)이며 결함이 아니다.
- 그러나 5ef23ce 의 매표 화면은 엄격해진 대사 규칙과 **함께 쓰면 실패하는 부분**이 있다 (§6). SQL 만 병합하면 정상 발권이 원장 미도착으로 거부될 수 있으므로, §5 계약에 맞춘 화면 수정과 함께 반영해야 한다.

부분 수납·혼합 주문·동의서 연결·초과 발권(F1~F4)은 6e23209 의 수정이 그대로 해결한다. 규칙은 `docs/qa/CLAUDE-011_R3_원장대사_수정.md` §2 에 있다. 이번에 다시 실행한 결과는 §7 에 있다.

## 4. 이번 수정 (SQL)

### 4.1 동시 접수 번호 충돌 (검토 #3)

- **원인**: `enqueue_consent_team` 의 advisory lock 이 멱등키 단위였다. 서로 다른 고객의 접수는 직렬화되지 않아 같은 `MAX(queue_number)+1` 을 계산했다. 늦게 커밋하는 쪽이 고유 제약 `uq_ticket_queue_site_date_number` 위반(23505)으로 실패했다.
- **수정**
  - `private.lock_ticket_queue_day(site, date)`: 시설·영업일 단위 트랜잭션 잠금 (`pg_advisory_xact_lock(hashtextextended(...))`). `PUBLIC` 실행 권한을 회수했다.
  - `enqueue_consent_team`: 첫 단계에서 이 잠금을 잡는다. 멱등키 조회, 서약서 중복 조회, 번호 계산, 삽입이 모두 잠금 안에서 실행된다. 기존 멱등키 잠금은 이 잠금에 포함되므로 제거했다.
  - 같은 서약서가 다른 멱등키로 동시에 들어와도, 두 번째 요청은 고유 제약 오류 대신 `duplicate: true` 로 같은 팀을 돌려받는다.
- **영향**: 같은 시설의 접수·복귀·호출이 한 번에 하나씩 실행된다. 각 트랜잭션은 밀리초 단위라 현장 규모(창구 2개, 분당 수십 건)에서는 문제가 없다고 판단한다. 실측은 하지 않았다.

### 4.2 같은 성격의 경합 2건 (같은 잠금으로 함께 해결)

- **복귀**: `restore_queue_team` 도 `MAX(order_key)+1` 을 쓴다. 동시 접수와 같은 `order_key` 가 나와 호출 순서가 비결정적이 되는 동률이 로컬 PostgreSQL 에서 재현됐다 (`order_key 동률: 3,2,3`). 같은 잠금을 걸었다.
- **같은 창구 이중 호출** (검토 #8): `call_next_queue_team` 의 창구 점유 검사(`EXISTS`)에 잠금이 없었다. 두 단말이 같은 창구를 동시에 호출하면 두 팀이 같은 창구로 호출됐다 (재현됨). 점유 검사 전에 같은 잠금을 건다. 다른 창구 동시 호출은 계속 서로 다른 팀을 호출한다 (시험 6).
- 이 둘은 지시 목록에 이름이 없었다. 같은 잠금 한 줄로 해결되고 SQL 담당 범위 안이라 함께 수정했다. 원치 않으면 해당 두 줄만 되돌리면 된다.

### 4.3 접수 실패 코드 (저장 순서 계약 보조)

- **`CONSENT_NOT_FOUND`** (`retryable: true`): 서약서가 서버에 아직 없을 때 반환한다.
  - 이전에는 외래키 위반 SQL 오류(23503)가 HTTP 오류로 그대로 나갔다.
  - 고객 화면이 서약서 저장 대기(outbox) 상태에서 접수를 부르면 이 코드를 받고, 같은 요청으로 재시도한다.
- **`ENQUEUE_CONFLICT`** (`retryable: true`): 잠금 이후에도 고유 제약 충돌이 생기면(토큰 난수 충돌 등) SQL 오류 대신 이 코드를 반환한다. 정상 경로에서는 나오지 않아야 한다.

## 5. 아난티용 계약: 저장 완료 → 발권 완료 순서와 실패 처리

용어: **서버 확정** = `BongplaySync.upsert` 결과가 `ok === true` 이고 `queued` 가 없음(falsy). `queued: true` 는 outbox 에만 있는 상태로 **미확정**이다. `schema_blocked`, `ok: false` 는 실패다. (`upsert` 반환 객체에는 `success` 필드가 없다.)

### 5.1 고객 접수 (`consent.html`)

1. **서약서 id 고정**: 제출 시도 하나에 서약서 id 를 한 번만 만든다. 재시도·재제출에서 **새 id 를 만들지 않는다**. 멱등키는 날짜+서약서 id+전화로 정해지므로, id 가 바뀌면 같은 팀이 두 번 접수된다.
2. **`safety_consents` 저장 → 서버 확정 확인**: 확정이 아니면 3단계로 가지 않고 "저장 확인 중"을 표시한 뒤 저장을 재시도한다.
3. **`enqueue_consent_team`**: 같은 인자(같은 서약서 id·멱등키)로 호출한다.

| 결과 | 처리 |
|---|---|
| `ok: true` (`duplicate` 여부 무관) | 번호·토큰 저장 |
| `CONSENT_NOT_FOUND`, `ENQUEUE_CONFLICT`, 네트워크 오류·HTTP 5xx·시간 초과 | **같은 인자로** 자동 재시도 (예: 1·2·4·8초, 최대 수 회). 서버는 같은 키에 같은 팀을 돌려주므로 중복이 생기지 않는다 |
| `IDEMPOTENCY_KEY_REUSED` | 버그. 재시도하지 말고 직원 문의 안내 |
| 재시도를 다 써도 실패 | "접수 대기 중"으로 끝내지 말고 **"접수 미완료 — 매표소 문의"** 를 명확히 표시 |

4. `normalizeRpcResult` 는 현재 `retryable` 을 버린다. 그대로 전달하거나 위 코드 목록으로 판단한다.

### 5.2 매표 발권 완료 (`consent-desk.html`, `bongplay-queue.js`)

호출 순서 (앞 단계가 서버 확정이 아니면 다음 단계로 가지 않는다):

1. `start_queue_processing` → 상태 `processing`. 발권 완료는 `processing` 에서만 허용된다.
2. **주문 저장**: `order_items` 전부 + `order_payments` 전부 (금액 > 0 만) → **전부 서버 확정**.
   - 현재 `createOrder` 는 upsert 를 기다리지 않고 결과를 버린다. 결과(Promise)를 돌려주도록 바꾸고, 전부 확정인지 확인해야 한다.
   - 품목·결제 행에 대기 팀의 `consent_id` 를 반드시 채운다. 비어 있으면 `ORDER_CONSENT_MISMATCH` 가 난다.
3. **발권 원장 저장**: `ticket_ledger` (입장권 품목 1매당 1행, 같은 `order_id`·`consent_id`) → 전부 서버 확정.
4. **`complete_queue_issuance(p_queue_id, p_order_id, p_ticket_ids)`**
   - `p_ticket_ids` 는 **이번 주문의 입장권 티켓 id 전부, 중복 없이**.
   - 이전 발권분(`rec.ticket_ids`)을 섞지 않는다.
5. 서약서 발권 상태 갱신(`is_issued` 등)은 4단계 성공 뒤에 한다. 실패하면 재시도 대상으로 남긴다. 대기열 완료 판정은 이 값을 쓰지 않는다.

4단계 실패 처리:

| 오류 | 의미 | 화면 처리 |
|---|---|---|
| 네트워크 오류, HTTP 5xx, 시간 초과 | 결과 불명 | **같은 `p_order_id`·같은 티켓 id** 로 재호출. 같은 주문 재시도는 같은 성공(`duplicate`/`already_completed`)을 돌려준다 (두 단말 동시 완료도 로컬 PostgreSQL 에서 확인, 시험 7) |
| `ORDER_ITEMS_EMPTY`, `TICKET_LEDGER_INCOMPLETE`, `PAYMENT_NOT_CONFIRMED` | 대개 2·3단계 원장이 아직 서버에 없음 | "원장 전송 대기 — 재시도". outbox 전송 후 같은 인자로 재호출. **새 주문을 만들지 않는다** |
| `PARTIAL_PAYMENT_REJECTED` | 수납 합계 < 할인 후 주문 금액 | 추가 수납을 **같은 주문**에 기록한 뒤 재호출 |
| `ORDER_CONSENT_MISMATCH`, `TICKET_QUANTITY_MISMATCH`, `DUPLICATE_TICKET_IDS`, `ORDER_TICKET_ITEMS_EMPTY`, `TICKETS_REQUIRED`, `ORDER_ID_REQUIRED` | 화면이 보낸 데이터 오류 | 자동 재시도 금지. 오류 코드 표시, 관리자 확인 |
| `INVALID_STATUS` | `processing` 이 아님 | 1단계 확인 (호출됨이면 처리 시작 먼저) |
| `ALREADY_ISSUED_OTHER_ORDER` | 이미 다른 주문으로 발권 완료된 팀 | 취소 후 재발권 경우. **현재 서버에 처리 경로 없음** (결정 요청 D3) |
| `UNAUTHORIZED_STAFF` | 접근 코드 없음·만료 | 직원 재로그인 |
| `CONSENT_INVALID`, `LEDGER_TABLE_MISSING`, `not_found` | 설정·데이터 문제 | 자동 재시도 금지, 관리자 확인 |

## 6. 프런트 계약 위반 (5ef23ce 확인, 수정하지 않음 — 아난티 담당)

| # | 파일·위치 (5ef23ce) | 내용 | 영향 |
|---|---|---|---|
| P1 | `pages/consent-desk.html` 원장 저장 확인 (`ledgerResults.some(r => r && r.success === false)`) | `upsert` 는 `success` 를 반환하지 않으므로 이 검사는 **항상 거짓**이다. `queued: true` 도 성공으로 본다. 서약서 갱신 검사(`consentSyncRes.success`)도 같다 | 원장이 outbox 에 남은 채 완료 RPC 호출 → 6e23209 SQL 에서는 `TICKET_LEDGER_INCOMPLETE` 로 거부, 현재 SQL 에서는 원장 없이 완료 |
| P2 | `assets/bongplay-id.js` `createOrder` | `order_items`·`order_payments` upsert 를 기다리지 않고 결과를 버림 | 6e23209 SQL 에서 `ORDER_ITEMS_EMPTY`·`PAYMENT_NOT_CONFIRMED` 거부 가능 |
| P3 | `pages/consent-desk.html` 재발권 | `ticketIds` 가 `rec.ticket_ids`(이전 발권분)로 시작 | 재발권 시 취소된 이전 티켓이 섞여 `TICKET_QUANTITY_MISMATCH`/`TICKET_LEDGER_INCOMPLETE`. 대기열이 이미 `issued` 면 `ALREADY_ISSUED_OTHER_ORDER` |
| P4 | `pages/consent.html` 771·793·800 | 제출마다 서약서 id 새로 생성, 서약서 저장 결과 미확인, 접수 1회만 호출·재시도 없음 | 재제출 시 중복 팀, 일시 실패 시 고객 누락 |
| P5 | `assets/bongplay-queue.js` `normalizeRpcResult` | `retryable` 필드 버림 | 재시도 판단 불가 (코드 목록으로 대체 가능) |

## 7. 시험 명령과 결과

환경: Node v22.22.2.
- PGlite 0.5.8 (PostgreSQL 18.3)
- 로컬 PostgreSQL 16.13: 이 작업용 일회용 서버, 127.0.0.1:55432, trust 인증, 시험마다 임시 DB 생성 후 삭제. **Supabase·운영 DB 아님.**
- `pg` 8 (저장소 밖 임시 폴더 설치)

```sh
# 저장소 루트. <SQL> 은 대상 PROPOSED_MIGRATION_ticket_queue.sql
T=01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance
ANT006_ROOT=. node --test $T/rpc-signature.test.mjs
ANT006_SQL=<SQL> PGLITE_DIR=<pglite> node --test $T/sql-conformance.test.mjs
ANT006_SQL=<SQL> PGLITE_DIR=<pglite> node --test $T/sql-ledger-fix.test.mjs
ANT006_SQL=<SQL> PGLITE_DIR=<pglite> node --test $T/sql-followup.test.mjs
ANT006_SQL=<SQL> ANT006_PG_URL=postgres://postgres@127.0.0.1:55432/postgres PG_DIR=<pg> node --test $T/pg-concurrency.test.mjs
(cd 01_봉플레이_운영시스템 && node tests/ticket_queue.test.js)   # ANT-006 자체 시험
```

| 시험 | 계층 | 기준 5ef23ce SQL | 결과 SQL (592d181) |
|---|---|---|---|
| `rpc-signature` | 정적 대조 | 4/4 (이전 검토) | 4/4 |
| `sql-conformance` | PGlite | 37/42 (이전 검토, F1~F4 + 정책 차이) | **41/42** (정책 차이 1건만) |
| `sql-ledger-fix` | PGlite | 3/11 | **11/11** |
| `sql-followup` | PGlite | 2/3 (서약서 미확정 시 외래키 SQL 오류 23503 노출) | **3/3** |
| `pg-concurrency` | 로컬 PostgreSQL 다중 연결 | **2/7** | **7/7** (3회 반복 모두 7/7) |
| ANT `ticket_queue.test.js` | 메모리 저장소 (DB 아님) | 19/19 (이전 검토) | 19/19 |

기준 SQL 에서 `pg-concurrency` 실패 내용:
1. 두 고객 동시 접수: 고유 제약 오류 23505
2. 20건 동시 접수: 병합 직후 SQL(접수 함수는 5ef23ce 와 동일)에서 18건, 5ef23ce 원본 SQL 에서 15건 실패
3. 같은 서약서·다른 키 동시 접수: 고유 제약 오류
4. 복귀·접수 동시: `order_key` 동률
5. 같은 창구 동시 호출: 두 번째 팀도 같은 창구로 호출

통과 2건: 다른 창구 동시 호출, 같은 팀 동시 완료 재시도.

`sql-followup` 의 "내부 잠금 함수 직접 호출 불가" 시험은 기준 SQL 에서 함수가 없어서 통과한 것이다. 의미 있는 비교는 결과 SQL 쪽뿐이다.

## 8. 미검증

- 실제 Supabase/PostgREST (역할·RLS·JWT·HTTP 오류 형태). 로컬 PostgreSQL 은 Supabase 역할을 모사한 것이다.
- 실제 네트워크 지연·outbox 전송 순서, 브라우저 화면, 단말 여러 대 동시 사용
- 잠금 직렬화의 처리량 (현장 최대 동시 접수 규모에서 대기 시간)
- §5 계약에 맞춘 프런트 수정 (아난티 담당, 미착수)
- 운영 DB 적용·배포 (하지 않음). 운영 DB 에 이 SQL 이 이미 적용됐는지도 확인하지 않음
- 예상 대기시간의 창구 일부 정지 처리 (검토 #7), 시설·직원별 권한 (검토 #9) — 이번 범위 밖, 변경 없음

## 9. 결정 요청 (벤)

- **D1** 이 브랜치(6e23209 포함)를 ANT-006 에 반영할지. 반영한다면 §6 P1·P2 수정과 **같은 배포**에 넣어야 한다. SQL 만 먼저 들어가면 정상 발권이 원장 미도착으로 거부될 수 있다.
- **D2** 실제 Supabase **시험 프로젝트**에서 `pg-concurrency` 시나리오를 HTTP 로 재실행하는 것을 승인할지 (운영 프로젝트 아님).
- **D3** 취소·환불 뒤 재발권 정책 (B4). 대기열 `issued` 팀에 새 주문을 연결하는 서버 경로(예: 직원 전용 "재발권 연결" RPC, 이전 주문 취소 확인 필수)를 만들지, 재발권은 대기열과 무관하게 처리할지.
- ~~**D4** 같은 창구 이중 호출·복귀 동률 수정(§4.2)을 유지할지~~ → **유지로 결정** (벤, 2026-10-14 2차 지시).
- **D5** 고객 대기표 토큰 만료 정책 (영업일 종료 대 24시간). 기존 결정 대기 항목.

---

## 10. 2차 — 프런트 결합 계약 시험 (아난티 5293dc8 기준)

- 지시: 벤 (2026-10-14 2차)
  - 백엔드 수정과 §4.2 추가 수정을 유지한다.
  - 원격 아난티 5293dc8 을 기준으로 저장 확정·동일 요청 재시도 계약의 누락을 검증하는 시험을 작성한다.
  - 프런트 구현 파일은 수정하지 않는다. 운영 DB 적용·배포는 하지 않는다.
- 착수: 2026-10-14T18:12:48+09:00 (KST). 종료 시각은 최종 답변에 적는다.
- 백엔드 SQL 은 이번에 바꾸지 않았다 (592d181 그대로).

### 10.1 대상

| 구분 | 값 |
|---|---|
| 대상 브랜치 | `antigravity/ANT-006-queue-followup` |
| 대상 SHA | `5293dc8f7e42fd10e5438c354d98093ac68dbb13` (부모 5ef23ce) |
| 대상의 SQL | 5ef23ce 와 같음. 6e23209·592d181 미포함 |
| 대상 보고서 | `docs/qa/20261014_아난티_queue-followup.md` |

- 대상 보고서의 "결과 SHA `116a93a`" 는 원격에 없는 객체다. 원격 브랜치 머리는 5293dc8 이다.
- 대상 보고서의 "Windows 경로 링크·Edge 실행" 기반 시험은 이 환경에서 재실행하지 않았다.

5293dc8 이 반영한 것 (코드 확인):
- 매표 직원 목록 조회 실패 시 "대기 0팀" 대신 "대기 확인 불가" 표시
- 고객 서약서 id 를 재시도 동안 유지 (`currentConsentDraftId`)
- 바우처의 수동 "대기번호 발급 재시도" 버튼
- 대기열 완료 성공 뒤에만 서약서 발권 표시

### 10.2 추가한 시험 (본인 전용 `tests/queue-contract/frontend-contract/`)

| 파일 | 내용 |
|---|---|
| `harness.mjs` | 대상 체크아웃의 실제 화면을 헤드리스 Chromium 으로 연다. Supabase 대신 모의 PostgREST 를 붙인다. 테이블·RPC 별 장애 주입(503 / 처리 후 응답 유실 / 지정 JSON), 전체 요청 기록, CDN 차단 |
| `save-retry-contract.test.mjs` | 계약 시험 10건 (고객 C0~C5, 매표 D0~D3) |
| `README.md` | 구성·장애 모드·실행 방법 |

- 대기열 RPC 는 **제안 SQL 계약을 간략히 모사**한 것이다 (§5, R3 원장 대사 요지). 실제 SQL 실행이 아니다.
- 장애 모드에서 "응답 없이 연결 끊기"는 쓰지 않는다. Chromium 이 재사용 연결의 POST 를 스스로 다시 보내 화면 코드의 재시도와 구분되지 않는 것을 확인했다.

### 10.3 5293dc8 결과 — 10건 중 2 통과, 8 실패 (2회 실행 동일)

| # | 시험 | 결과 | 현재 코드에서 실패하는 이유 | 기대 결과 (계약) |
|---|---|---|---|---|
| C0 | 정상 접수 (양성 대조) | 통과 | — | 서약서 확정 → 접수 1회 → `#001` |
| C1 | 서약서 저장이 일시 503(POST·PATCH)으로 outbox 에 들어간 경우 | **실패** | `consent.html` 이 `BongplaySync.upsert('safety_consents', …)` 결과를 확인하지 않고 바로 접수 RPC 를 부른다 → 서버 `CONSENT_NOT_FOUND`. 이후 outbox 가 서약서를 보내도 접수를 다시 하지 않아 "접수 대기 중"에 머문다 | 서약서가 서버 확정(`ok && !queued`)된 뒤 접수. 사용자 조작 없이 번호 발급 (§5.1-2) |
| C5 | 서약서 첫 POST 만 503, PATCH 는 정상 | **실패** | `bongplay-sync.js` `upsert` 는 POST 실패 시 PATCH 로 대체 시도한다. 새 행이라 PostgREST 는 `200 []` 를 돌려주고, 이를 RLS 거부로 판단해 **outbox 항목을 지운 뒤** `ok:false` 를 반환한다. 서약서가 서버에 영영 저장되지 않는다 (15초 대기, outbox 0건) | 확정 안 된 저장은 재시도 대상으로 남아 서버에 저장 (§5 서버 확정 정의) |
| C2 | 접수 응답 유실(서버는 접수함) 뒤 수동 재시도 버튼 | **실패** | `retryQueueEnqueue()` 가 바우처의 `householdId` 에서 `hh_` 를 떼어 전화번호로 보낸다. 실제 값은 해시(`c1c0184c`)라 멱등키가 바뀐다. `party_size` 도 1 로 바뀐다(원래 2, `children` 미전달). 서버의 서약서 중복 검사 덕분에 팀은 하나지만, 첫 요청이 실제로 실패한 경우에는 해시 값이 연락처로 저장된다 | 첫 요청과 같은 인자(서약서 id·멱등키·이름·전화·인원) (§5.1-3) |
| C3 | 서버가 `ENQUEUE_CONFLICT`(retryable) 반환 | **실패** | 자동 재시도 없음 (12초 동안 1회). 수동 버튼만 있다 | 같은 인자로 자동 재시도 후 번호 발급 |
| C4 | 접수 RPC 가 HTTP 503 | **실패** | 자동 재시도 없음 (12초 동안 1회) | 같은 인자로 자동 재시도 |
| D0 | 정상 발권 (양성 대조) | 통과 | — | 품목·결제·원장 확정 → 완료 1회 → 서약서 발권 표시 |
| D1 | `ticket_ledger` 쓰기가 503 (outbox 대기) | **실패** | 원장 실패 검사가 `r.success === false` 다. `upsert` 결과에는 `success` 가 없어 검사가 항상 통과하고, `queued` 도 성공으로 본다. 완료 RPC 가 호출되어 `TICKET_LEDGER_INCOMPLETE` 로 거부된다 | 원장이 서버 확정이 아니면 완료 RPC 를 부르지 않음 (§5.2-3) |
| D2 | `order_items` 쓰기가 503 | **실패** | `bongplay-id.js` `createOrder` 가 품목·결제 upsert 를 기다리지 않고 결과를 버린다. 완료 RPC 호출 → `ORDER_ITEMS_EMPTY` | 품목·결제 전부 확정 후 다음 단계 (§5.2-2) |
| D3 | 완료 응답 유실(서버는 완료함) 뒤 직원이 같은 결제 창에서 다시 누름 | **실패** | 재시도가 `createOrder` 를 다시 불러 **새 주문 id** 를 만든다. 실측: 주문 2건, 현금 20,000원 결제 2건 저장. 두 번째 완료는 `ALREADY_ISSUED_OTHER_ORDER`, 서약서는 발권 표시가 안 된 채 남는다 | 같은 `p_order_id`·같은 티켓 id 로 재호출. 새 주문·결제를 만들지 않음 (§5.2 실패 처리 표) |

같은 대상에서 함께 실행한 것:
- `rpc-signature` 4/4 통과 (5293dc8 화면·클라이언트와 그 SQL 의 RPC 서명 일치)
- 아난티 `ticket_queue.test.js` 20/20 통과 (메모리 저장소, DB 아님)

### 10.4 시험 명령

```sh
git worktree add --detach <dir> 5293dc8f7e42fd10e5438c354d98093ac68dbb13
ANT006_ROOT=<dir> PW_DIR=<playwright 1.56.1 모듈> PLAYWRIGHT_BROWSERS_PATH=<Chromium 설치> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs
```

환경: Node v22.22.2, playwright 1.56.1, 헤드리스 Chromium. 시험 1회 약 1분 30초.

### 10.5 통합 검증 상태

- 이 계약(§5)을 반영한 아난티 수정본은 **아직 원격에 없다**. 5293dc8 은 §5 계약을 올린 커밋(32dad25, 18:03 KST)보다 먼저(17:59 KST) 커밋되었다.
- 따라서 이번 범위는 **계약 시험 준비 완료**까지다. **통합 검증(수정본 + 592d181 SQL + 브라우저)은 미실행**이다.
- 수정본이 오면:
  1. 같은 명령으로 `save-retry-contract` 를 재실행한다. 10/10 이 기대 결과다.
  2. 592d181 SQL 을 합친 체크아웃에서 `ant006-conformance` 를 다시 실행한다.

### 10.6 미검증 (2차)

- 통합 검증 전체 (위 10.5)
- 실제 Supabase/PostgREST 위의 브라우저 흐름. 모의 서버의 RPC 는 SQL 모사다
- 취소·환불 뒤 재발권 경로 (D3 결정 대기라 시험을 쓰지 않음)
- 오프라인(`navigator.onLine = false`) 경로, 여러 단말 동시 발권, 서비스 워커
- 아난티 보고서의 Windows·Edge 기반 E2E 결과 재현

### 10.7 결정 요청 (2차 추가)

- **D6** C5(`bongplay-sync.js` 의 POST 실패 → PATCH 빈 응답 → outbox 삭제)는 대기열 화면만이 아니라 **모든 테이블 저장**에 해당한다. 담당자를 정해 달라 (공용 자산, 아난티 또는 별도 작업).
  - 수정 방향 제안: PATCH 가 `200 []` 이면 RLS 거부로 단정하지 않는다. POST 실패 원인이 5xx·네트워크면 outbox 에 남긴다.
- **D7** 고객 접수 자동 재시도(C3·C4)의 횟수·간격(예: 1·2·4·8초, 최대 4회)과, 소진 시 문구("접수 미완료 — 매표소 문의")를 확정해 달라.


---

## 11. 3차 — 배포 전 최종 검증 + 빈 시험 Supabase 설치 묶음

- 지시: 벤 (2026-10-14 3차)
  - 원격 아난티 최신 SHA 로 독립 계약 시험을 다시 실행하고 이전 판본과 구분한다.
  - 빈 시험 Supabase 설치 SQL 묶음을 준비한다 (선행 표·확장·함수·직원 인증·RLS·권한·대기열, 적용 순서).
  - 시험 하네스의 느슨한 권한을 쓰지 않는다. 실제 DB 적용은 하지 않는다. 프런트 구현은 수정하지 않는다.
- 착수: 2026-10-14T22:22:20+09:00 (KST). 종료 시각은 최종 답변에 적는다.

### 11.1 아난티 원격 판본

| 확인 시각 (KST) | 브랜치 머리 | 비고 |
|---|---|---|
| 22:22 | `6692940a31434f2613ba0e77aeb1da13d125e957` | 2차 대상 5293dc8 다음 커밋 (18:50:45 KST). 화면·`bongplay-id*.js`·`bongplay-queue.js` 변경 |
| 22:39 | `6692940` 그대로 | 이후 새 게시 없음 |

- 6692940 의 SQL 은 5ef23ce 그대로다. 592d181·이번 수정은 포함하지 않는다.
- `bongplay-sync.js` 도 바뀌지 않았다.

### 11.2 계약 시험 — 판본별 결과 (save-retry-contract, 각 2회 실행 동일)

| 시험 | 5293dc8 (2차, §10.3) | **6692940 (3차)** | 6692940 에서 남은 이유 |
|---|---|---|---|
| C0 정상 접수 | 통과 | 통과 | — |
| C1 서약서 미확정 시 접수 보류 후 자동 재개 | 실패 | **실패** | 이제 서약서가 확정(`ok && !queued`)될 때까지 접수 RPC 를 부르지 않는다 (앞부분 통과). 그러나 outbox 가 서약서를 보낸 뒤 접수를 **자동으로 재개하지 않는다**. 고객이 재시도 버튼을 눌러야 한다 (15초 대기 중 번호 미발급) |
| C5 첫 POST 503 뒤 서약서 저장 | 실패 | **실패** | `bongplay-sync.js` 미변경. PATCH `200 []` 를 RLS 거부로 보고 outbox 항목을 지워 서약서가 서버에 저장되지 않는다 |
| C2 응답 유실 뒤 수동 재시도 인자 동일 | 실패 | **통과** | — (멱등키·전화·인원을 초안에서 그대로 재사용) |
| C3 `ENQUEUE_CONFLICT` 자동 재시도 | 실패 | **실패** | 자동 재시도 없음 (12초 동안 1회) |
| C4 HTTP 503 자동 재시도 | 실패 | **실패** | 자동 재시도 없음 |
| D0 정상 발권 | 통과 | 통과 | — |
| D1 원장 미확정 시 완료 RPC 보류 | 실패 | **통과** | — |
| D2 품목 미확정 시 완료 RPC 보류 | 실패 | **통과** | — |
| D3 완료 응답 유실 뒤 같은 주문 재사용 | 실패 | **통과** | — (중복 주문·결제 없음) |
| **합계** | **2 / 10** | **6 / 10** | |

같은 대상에서 함께 실행한 것 (6692940):
- `rpc-signature` 4/4 통과
- 아난티 `ticket_queue.test.js` 26/26 통과 (메모리 저장소, DB 아님)

코드에서 본 추가 사항 (시험 외):
- **O1 (백엔드↔화면 계약 차이, 이번에 SQL 쪽 수정)**
  - 매표 화면(`consent-desk.html` 855·1601행)은 호출 팀의 `consent_id` 로 결제 창을 열고 결제 대상과 대조한다.
  - 그러나 제안 SQL 의 직원 RPC 응답에는 `consent_id` 가 없었다. 실제 DB 에서는 결제 창 자동 열기와 대조 가드가 둘 다 동작하지 않는다 (서버 대사 `ORDER_CONSENT_MISMATCH` 는 결제 기록 **뒤에** 거부).
  - 아난티 모의 저장소와 내 계약 시험 모의 서버는 `consent_id` 를 돌려주고 있어 이 차이가 가려져 있었다.
  - §11.3 에서 SQL 이 직원 인증 뒤 응답에만 `consent_id` 를 넣도록 고쳤다. `start_queue_processing`·`recall_queue_team` 도 화면이 응답으로 현재 팀을 교체하므로 번호·창구·이름을 함께 돌려준다.
- **O2 (낮음)** 6692940 은 접수가 끝날 때까지 `localStorage` 의 `bongplay_active_consent_draft` 에 보호자 이름·전화번호를 평문으로 둔다.
  - 고객 본인 기기이고 접수 성공 시 지워진다.
  - 접수가 끝내 실패하면 남는다.

### 11.3 백엔드 SQL 수정 (`PROPOSED_MIGRATION_ticket_queue.sql`)

| 변경 | 이유 | 시험 |
|---|---|---|
| 끝에 5) 절 추가: 대기열 표 3개 `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `private.verify_staff_permission`·`private.lock_ticket_queue_day` 실행 권한 `PUBLIC, anon, authenticated` 회수 | Supabase 는 public 의 새 표·함수에 anon·authenticated 권한을 기본으로 준다. 이전 판에서는 표 직접 권한이 열려 있었다 | 대조 실행(592d181 SQL): `60_verify` P01·P04 실패, HTTP `GET /ticket_queue` 가 `200 []`(RLS 로 행만 숨김). 수정 후 401/403 |
| 직원 RPC 응답에 `consent_id` 추가: `call_next_queue_team`, `recall_queue_team`, `start_queue_processing`, `get_staff_queue_list` 의 대기·호출·보류 항목 | O1 | `sql-followup` 신규 1건 (공개 전광판·고객 조회에는 없음 확인), HTTP H07 에서 호출 응답 `consent_id` 대조 |

### 11.4 빈 시험 Supabase 설치 묶음

위치: `01_봉플레이_운영시스템/database/test_supabase_install/` (설치·검증·초기화 방법은 같은 폴더 `README.md`).

| 순서 | 파일 | 내용 |
|---|---|---|
| 1 | `00_preflight.sql` (신규) | Supabase 역할·pgcrypto 확인. 합성(`SYN-`) 아닌 운영 행이나 기존 운영자 암호가 있으면 중단. 통과 시 `private.app_settings.install_target = synthetic_test` 표시 |
| 2 | `database/FINAL_SUPABASE_SETUP.sql` (기존, 변경 없음) | 30개 표 (서약서·주문 품목·결제·티켓 원장·안전점검 등), RLS·정책, DELETE 회수, pgcrypto, 직원 인증(bcrypt·IP 잠금), 공개 RPC 4개, 안전 인터록 트리거, Realtime |
| 3 | `database/PROPOSED_MIGRATION_ticket_queue.sql` (§11.3 반영) | 대기열 표 3개, RPC 12개, 잠금, 권한 이중화 |
| 4 | `40_test_staff_code.sql` (신규) | 시험 전용 운영자 암호 등록. 파일에는 자리표시자만 있다. 바꾸지 않으면 거부 |
| 5 | `50_synthetic_seed.sql` (신규) | 오늘(KST) PASS 점검 1건(안전 인터록 해제 조건), 합성 서약서 3건 |
| 6 | `60_verify.sql` (신규) | 읽기 전용 점검 표. 필수 표·열, pgcrypto 위치, RLS, 대기열 표 직접 권한 없음, 원장 DELETE 없음, private 스키마·함수 차단, 대기열 RPC 12개 실행 가능, 허용 목록 밖 SECURITY DEFINER 노출 없음, `search_path` 고정, 고유 제약, 잠금 함수, 창구 시드, 설치 표시, 암호 해시 |
| 초기화 | `90_reset_queue.sql` / `91_reset_all_test.sql` (신규) | 대기열만 / 묶음 전체. 설치 표시가 없으면 거부 |

- `PATCH_r3_to_r4.sql`·`PATCH_survey_v2.sql` 은 FINAL 에 이미 들어 있다 (추가 열 전부 FINAL 에서 확인). 따라서 순서에서 뺐다.
- `PROPOSED_MIGRATION_safety_consents_cancellation.sql` 은 대기열·현재 화면이 쓰지 않아 넣지 않았다.

**적용 순서 주의**
- FINAL 은 실행할 때마다 public 의 RLS 정책을 모두 지운다.
- 그래서 FINAL 다음에 대기열 SQL 을 실행한다.
- FINAL 만 다시 실행해도 대기열 표는 막혀 있다: 대기열 정책 0개인 상태에서 RLS 와 표 권한 회수로 막히는 것을 D2 단계에서 확인했다.

**파일 sha256 (커밋 기준)**

| 파일 | sha256 |
|---|---|
| FINAL_SUPABASE_SETUP.sql | `92c66077cd07b1138c36b1cce3149f73c2725f8ae9ae6e64be097e786a43d459` |
| PROPOSED_MIGRATION_ticket_queue.sql | `9f170a8357a67cb8516b14ebba13460f4b6a7810cfc76f654731a933563e07ab` |
| 00_preflight.sql | `bd662f89fd8d59c8d8fb307155af7652d11fb5f879b2ede16f72abcffe313574` |
| 40_test_staff_code.sql | `8866d8ce2b0277d53ee37bfc59e20b2bb44108c0ed347c6dab3f71af670a5fb7` |
| 50_synthetic_seed.sql | `cfc0db36576f813c13f416430306986c0aeb4148b5b0dcfb64f4d13e29742237` |
| 60_verify.sql | `587dfe9cae7a32334c8e14feefd569adcf1809d6a338ac13dfbc79377dc66e04` |
| 90_reset_queue.sql | `7992531763fafa85607fa3b9cc5da6799aa51e8a87d112eca9c8147842669003` |
| 91_reset_all_test.sql | `4582984820fc3cba15290c34cb482ac9074ac4afb005156d43ff6fcf2205b84f` |

### 11.5 설치 묶음 로컬 검증

`tests/queue-contract/supabase-install/run_local_install_check.sh`

**환경**
- 일회용 PostgreSQL 16.13 (슈퍼유저 `supabase_admin`)
- `supabase_platform_emulation.sql` 로 호스팅 Supabase 의 역할을 모사
  - `postgres` 비슈퍼유저·BYPASSRLS, `anon`·`authenticated`·`service_role`·`authenticator`
  - **넓은 public 기본 권한**, extensions·auth 함수, Realtime 발행
- 설치는 비슈퍼유저 `postgres` 로 실행
- PostgREST 12.2.3, anon JWT (로컬 합성 비밀)
- 시험 하네스(`ant006-conformance`)의 느슨한 설정은 쓰지 않았다.

| 단계 | 결과 (최종 SQL) |
|---|---|
| B 설치 → `60_verify` | FAIL 0건 |
| C HTTP `verify_http.mjs` H01~H07 | **7/7 통과** (표 직접 접근 거부, 내부 함수 비노출, 서약서 DELETE 거부, 접수·멱등·`CONSENT_NOT_FOUND`·고객 조회, HTTP 동시 접수 20건 번호 고유, 틀린 암호 거부, 호출→처리→원장 확정 후 완료→재시도 성공→부분 수납 거부) |
| D 같은 DB 재설치 → `60_verify` | FAIL 0건 (멱등) |
| D2 FINAL 만 재실행 → `60_verify` | FAIL 0건 (대기열 정책 0개여도 막힘) |
| E `90` → 대기열 표 0개·서약서 유지 → 대기열 재설치 → `60_verify` | 통과 |
| F `91` → public 표 0개·private 없음 → 처음부터 설치 → `60_verify` | 통과 |
| G 운영 보호 | 합성 아닌 서약서가 있으면 `00` 거부. 운영자 암호가 이미 있으면 `00` 거부. 설치 표시가 없으면 `40`·`50`·`90`·`91` 거부. 자리표시자 그대로면 `40` 거부 |
| **대조**: 대기열 SQL 을 592d181(5) 절 없음)로 바꿔 같은 점검 | `60_verify` P01·P04 실패, HTTP H01 실패 (`GET /ticket_queue` → `200 []`). 점검이 권한 누락을 잡는 것을 확인 |

남는 WARN (설치 유효, 결정 필요):
- **P02b**: Supabase 기본 권한 때문에 anon·authenticated 가 원장 표(서약서·주문 품목·결제·티켓·점검)에 `TRUNCATE` 권한을 가진다.
  - PostgREST 에는 TRUNCATE 경로가 없어 API 로는 실행할 수 없다.
  - FINAL 의 DELETE 회수처럼 TRUNCATE 도 회수할지 결정이 필요하다 (FINAL 은 운영 기준 파일이라 이번에 바꾸지 않았다).
- **X01**: 로컬에는 pg_cron 이 없어 개인정보 자동 마스킹 작업이 등록되지 않는다. 호스팅 Supabase 에서는 확장을 켤 수 있다.

### 11.6 백엔드 회귀 (최종 SQL, 9f170a83…)

| 시험 | 계층 | 결과 |
|---|---|---|
| `rpc-signature` | 정적 대조 | 4/4 |
| `sql-conformance` | PGlite | 41/42 (토큰 만료 정책 차이 1건, 기존과 같음) |
| `sql-ledger-fix` | PGlite | 11/11 |
| `sql-followup` | PGlite | 4/4 (신규 1건 포함) |
| `pg-concurrency` | 로컬 PostgreSQL 다중 연결 | 7/7 |

### 11.7 시험 명령

```sh
# 계약 시험 (판본별)
git worktree add --detach <dir> 6692940a31434f2613ba0e77aeb1da13d125e957
ANT006_ROOT=<dir> PW_DIR=<playwright 1.56.1> node --test --test-concurrency=1 \
  01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs
# 설치 묶음 로컬 검증
PGRST_BIN=<postgrest 12.2.3> bash 01_봉플레이_운영시스템/tests/queue-contract/supabase-install/run_local_install_check.sh
QUEUE_SQL=<592d181 판 대기열 SQL> PGRST_BIN=… bash …/run_local_install_check.sh   # 대조
# 실제 시험 Supabase 에 적용한 뒤 (미실행)
SUPABASE_URL=… SUPABASE_ANON_KEY=… TEST_STAFF_CODE=… node --test --test-concurrency=1 \
  01_봉플레이_운영시스템/tests/queue-contract/supabase-install/verify_http.mjs
```

### 11.8 미검증 (3차)

- **실제 시험 Supabase 프로젝트 적용·`verify_http.mjs` 실행**: 지시대로 하지 않았다.
  - 로컬 모사는 공개된 기본 상태를 흉내 낸 것이다. 실제 Supabase 와 다를 수 있는 점:
    - `postgres` 역할 속성, 기본 권한의 세부, PostgREST 판(12.2.3 사용)
    - `request.headers` 의 클라이언트 IP(로컬은 `unknown`), Realtime, pg_cron
- **통합 검증**: 아난티 6692940 화면 + 이번 SQL + 실제 Supabase.
  - 6692940 화면은 호출 팀의 `consent_id` 를 기대하고, 이번 SQL 이 그것을 제공한다.
  - 그러나 둘을 결합한 화면 동작은 실제 DB 로 확인하지 않았다.
- **아난티 남은 실패 4건(C1·C3·C4·C5)의 수정본**: 아직 원격에 없다 (22:39 KST 확인).
- 운영 DB 적용·배포: 하지 않음.

### 11.9 결정 요청 (3차 추가)

- **D8** 원장 표의 anon·authenticated `TRUNCATE` 권한 회수를 FINAL 에 넣을지 (P02b).
- **D9** 시험 Supabase 프로젝트 생성과 이 묶음 적용·`verify_http.mjs` 실행 승인. 적용자와 시험 암호 보관 방법을 정해 달라.
- **D6·D7 (재요청)**
  - C5 는 공용 `bongplay-sync.js` 문제라 모든 테이블 저장에 해당한다.
  - C1·C3·C4 는 자동 재시도·재개 정책이 정해지지 않아 남아 있다.
  - 배포 전에 담당·정책을 정해 달라.

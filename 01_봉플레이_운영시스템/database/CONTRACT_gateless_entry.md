# BEN-ENTRY-01 게이트 없는 발권·입장·반납 계약

- **작업:** BEN-ENTRY-01 / 클로이. 화면 HTML은 아난티 소관이다.
- **기준 커밋:**
  - `claude/CLAUDE-011-queue-followup` `8df36cf5ac705c31d49fe1b12d875d9cfd24f176`: 대기열 R4, 서약서 취소 3열, `lookup_family_children` 차단까지 포함한 최신 DB 판본
  - `origin/master` `892a06143ebe69e64a77761cd5793ab199c9755b`: 대기열 SQL 없음
  - 대조한 화면 판본: `antigravity/ANT-006-queue-followup` `9831bb5`
- **구현 파일:** `PROPOSED_MIGRATION_visit_entry.sql`. 대기열 SQL(`PROPOSED_MIGRATION_ticket_queue.sql`) 뒤에 적용한다.
  - 기존 함수와 원장 표는 바꾸지 않는다.
- 운영 DB에 적용하지 않는다. 시험은 로컬 PostgreSQL과 합성(`SYN-`) 자료로만 한다.

## 0. 새 동선과 폐지 대상

```
서약 접수(enqueue_consent_team) → 대기팀 호출(call_next_queue_team) → [호출 알림: 별도 발송 원장]
 → 직원이 고른 팀의 보호자 전화 뒷 4자리 확인(verify_visit_guardian_last4)
 → 처리 시작(start_queue_processing) → 결제·발권(createOrder: order_items·order_payments·ticket_ledger)
 → 발권 확정 = 입장 기록(confirm_visit_entry)      ← 이 호출이 성공해야만 입장
 → 체류 중 팀 검색(search_visit_entries) → 팔찌 반납 = 부분/전체 퇴장(return_visit_wristbands)
 → 출구 공용 QR 설문(방문 식별자와 연결하지 않음)
```

- **폐지:** 별도 게이트 화면(`pages/gate.html`의 바우처 QR 입장·퇴장 처리), 고객용 바우처 QR(`safety_consents.pass_code` 제시)
  - 열은 지우지 않는다. 과거 기록 보존과 호환 기간 때문이다(8절).
- **고객 요구 없음:** 고객에게 카카오톡 확인이나 QR 제시를 요구하지 않는다. 호출 알림은 보조 수단이다. 발송 실패와 무관하게 매표소 육성 호출이 기준이다.

## 1. 식별자

| 이름 | 값 | 누가 알 수 있나 | 용도 |
|---|---|---|---|
| `queue_id` | `ticket_queue.id` | 직원 (호출·목록 응답) | 호출된 방문. 뒷번호 대조·발권 확정의 대상 |
| `order_id` | 매표 `createOrder`가 만든 주문 번호 | 직원 단말 | 결제·발권 원장 묶음 |
| `ticket_ids` | 주문의 `ticket_ledger.ticket_id` 목록 | 직원 단말 | 팔찌 1개 = 티켓 1장 = 입장 1명 |
| `entry_id` | `visit_entries.id` (`ve_…`) | 직원 (확정·검색 응답) | 입장 기록. 반납의 대상 |
| `request_id` | 단말이 **사용자 동작 1번마다** 새로 만드는 UUID | 직원 단말 | 재시도 멱등. 같은 동작을 다시 보낼 때는 같은 값 |
| `customer_token` | 기존 고객 대기 조회 토큰 | 고객 | 대기 순서 조회만. 입장·반납 정보는 돌려주지 않는다 |

- 뒷번호(4자리)는 **식별자가 아니다**. 직원이 이미 고른 `queue_id`와 대조하는 값이다. 뒷번호로 팀을 찾는 API는 직원 전용 체류 검색(E4) 하나뿐이다.
- **고객용 함수가 돌려주지 않는 것:** 고객용 함수(`get_customer_queue_status`, `get_queue_public_display`, `enqueue_consent_team`)와 출구 설문은 다음을 돌려주지 않는다.
  - 다른 가족 목록, 이름, 전화번호, 입장·반납 정보
  - 새 함수는 모두 직원 인증이 없으면 `UNAUTHORIZED_STAFF`만 돌려준다.

## 2. 공통 규칙

- **직원 인증:** 모든 직원 함수는 `p_access_code`(운영 암호)와 `p_site_id`를 받아 서버에서 매번 검증한다.
  - 검증은 `private.verify_staff_permission` → `private.verify_access_code`를 쓴다. bcrypt이며, IP별 10분 20회 실패 시 잠금이다.
  - 실패하면 `{ok:false, error:'UNAUTHORIZED_STAFF'}`다. 단말은 폴링을 멈추고 재로그인을 요구한다.
  - `p_staff_id`는 표시용 이름이다. 권한 근거가 아니다.
- **응답 형식:** `{ ok: boolean, error?: CODE, message?: 한국어, ... }`. 업무 오류는 SQL 예외가 아니라 `ok:false`로 돌려준다.
  - SQL 예외(HTTP 4xx/5xx)는 인프라 오류로 본다(4절 재시도 규칙).
- **시설 범위:** 다른 `p_site_id`의 행은 없는 것으로 본다(`not_found`). 허용 시설이 아니면 `UNAUTHORIZED_STAFF`다.
- **영업일:** KST(`Asia/Seoul`) 기준이고 서버 시계로 정한다. 단말 시계는 쓰지 않는다.
- **동시성:** 변경 함수는 시설 단위 잠금(`private.lock_ticket_queue_site`) 안에서 대상 행을 다시 읽는다. 연타·재시도·두 단말 동시 처리도 한 번만 반영된다.
- **멱등:** 변경 함수(E3·E6)는 `p_request_id`(8~64자)를 필수로 받는다.
  - 성공 응답은 `request_id`별로 저장한다.
  - 같은 `request_id`와 같은 입력이면 저장된 응답을 `replayed:true`로 그대로 돌려준다.
  - 같은 `request_id`인데 입력이 다르면 `REQUEST_ID_CONFLICT`다.
  - 실패 응답은 저장하지 않는다. 원인을 고친 뒤 같은 `request_id`로 다시 보내면 새로 판정한다.

## 3. 함수 계약

### E0. 직원 로그인 (기존, 변경 없음)

| | |
|---|---|
| 호출 | `verify_staff_access(p_access_code)` |
| 응답 | `true` / `false` |
| 비고 | 화면 진입용이다. 각 변경 함수가 다시 검증하므로 이 결과를 저장해 권한으로 쓰지 않는다 |

### E1. 호출된 방문 식별 (기존, 변경 없음)

| | |
|---|---|
| 호출 | `call_next_queue_team(p_access_code, p_desk_no, p_staff_id, p_site_id)`, `recall_queue_team`, `start_queue_processing`, `get_staff_queue_list` |
| 쓰는 값 | 응답의 `id` = `queue_id`, `formatted_number`, `guardian_name`, `consent_id`, `party_size`, `desk_no` |
| 규칙 | 화면은 호출 응답의 `queue_id`를 보관해 E2·E3에 그대로 쓴다. 뒷번호로 `queue_id`를 찾지 않는다 |

### E2. 뒷번호 대조 — `verify_visit_guardian_last4`

요청: `(p_access_code text, p_queue_id text, p_last4 text, p_staff_id text default 'desk_staff', p_site_id text default 'bongplay_bonghwa')`

| 결과 | 응답 |
|---|---|
| 일치 | `{ok:true, matched:true, queue_id, verified_at}` |
| 불일치 | `{ok:true, matched:false, queue_id, attempts_left}` — 전화번호·정답 자릿수는 돌려주지 않는다 |
| 잠금 | `{ok:false, error:'LAST4_LOCKED', locked_until}` — 같은 팀에 연속 5회 불일치하면 10분 잠금 |

오류 코드:

| 코드 | 의미 | 재시도 |
|---|---|---|
| `UNAUTHORIZED_STAFF` | 직원 인증 실패 | 재로그인 후 |
| `LAST4_FORMAT` | 숫자 4자리가 아님 | 입력 수정 |
| `not_found` | 이 시설에 없는 `queue_id` | 안 함 |
| `PAST_QUEUE_DATE` | 지난 영업일 대기 행 | 안 함 (새 접수) |
| `INVALID_STATUS` | `called`·`processing` 상태가 아님 | 안 함 (호출부터) |
| `LAST4_UNAVAILABLE` | 대기 행 전화번호가 4자리 미만 | 안 함 (현장 확인) |
| `LAST4_LOCKED` | 연속 불일치 잠금 중 | `locked_until` 이후 |

규칙:
- 대조는 `queue_id`가 가리키는 팀의 `guardian_phone` 숫자 끝 4자리와만 한다. 같은 뒷번호의 다른 팀은 결과에 영향이 없다.
- 일치 기록은 그 `queue_id`의 같은 영업일에만 유효하다. 일치가 기록되면 불일치 횟수는 0으로 돌아간다.
- 일치는 **입장 조건의 하나일 뿐**이다. 이 호출만으로는 아무 원장도 바뀌지 않는다.

### E3. 발권 확정 = 입장 기록 — `confirm_visit_entry`

요청: `(p_access_code text, p_queue_id text, p_order_id text, p_ticket_ids jsonb, p_request_id text, p_staff_id text default 'desk_staff', p_site_id text default 'bongplay_bonghwa')`

성공 응답:
```json
{"ok": true, "entry_id": "ve_…", "queue_id": "…", "order_id": "…", "business_date": "2026-11-03",
 "entered_at": "…", "ticket_count": 3, "inside_count": 3, "returned_count": 0, "status": "inside",
 "already_entered": false, "replayed": false}
```

- **같은 방문 재처리:** 다른 단말이나 다른 `request_id`로 같은 방문(같은 `queue_id`·`order_id`·티켓 집합)을 다시 확정하면 새 행 없이 `already_entered:true`다.
- **같은 요청 재전송:** 같은 `request_id`로 재전송하면 저장된 응답에 `replayed:true`다.

판정 순서 (앞에서 걸리면 이후는 보지 않는다. 실패 시 아무 원장도 바뀌지 않는다):

| 순서 | 검사 | 실패 코드 |
|---|---|---|
| 1 | 직원 인증 | `UNAUTHORIZED_STAFF` |
| 2 | 입력 | `REQUEST_ID_REQUIRED`, `ORDER_ID_REQUIRED`, `TICKETS_REQUIRED`, `DUPLICATE_TICKET_IDS` |
| 3 | 같은 `request_id` 재전송 | (성공 응답 재생) / `REQUEST_ID_CONFLICT` |
| 4 | 대기 행 (시설 범위, 오늘) | `not_found`, `PAST_QUEUE_DATE` |
| 5 | 이미 입장 기록 있음 | 같은 주문·같은 티켓이면 `already_entered:true`. 다르면 `ENTRY_EXISTS_OTHER_ORDER` |
| 6 | 대기 상태: `processing`. 또는 구 경로로 같은 주문 `issued`(호환) | `INVALID_STATUS`, `ALREADY_ISSUED_OTHER_ORDER` |
| 7 | 서약서 유효 (같은 시설, 취소 아님) | `CONSENT_INVALID`, `CONSENT_CANCELLED` |
| 8 | 이 팀의 오늘 뒷번호 일치 기록 | `LAST4_NOT_VERIFIED` |
| 9 | 안전점검 인터록: 오늘(KST) `decision='pass'` 점검 있음 | `SAFETY_INTERLOCK_BLOCKED` |
| 10 | 원장 대사: 기존 `complete_queue_issuance`와 같은 규칙과 같은 코드 | `ORDER_ITEMS_EMPTY`, `ORDER_CONSENT_MISMATCH`, `ORDER_TICKET_ITEMS_EMPTY`, `TICKET_QUANTITY_MISMATCH`, `TICKET_LEDGER_INCOMPLETE`, `PAYMENT_NOT_CONFIRMED`, `PARTIAL_PAYMENT_REJECTED` |
| 11 | 티켓이 다른 입장 기록에 이미 있음 | `TICKET_ALREADY_ENTERED` |

10번 원장 대사의 세부 조건:
- 활성 품목은 전부 이 서약서 소속이다. 결제 행도 전부 이 서약서 소속이다.
- 입장권(`product_category='ticket'`) 활성 수량 = 요청 티켓 수 = 주문의 활성 티켓 원장 수
- 유효 결제 합계 ≥ 할인 후 주문 금액. 금액 0 주문은 결제 없이 허용한다.
- 매점 단독 주문(입장권 품목 없음)은 `ORDER_TICKET_ITEMS_EMPTY`로 거부되어 입장객을 늘리지 않는다.

성공 시 한 트랜잭션에서 한 번만 쓴다:
- **대기열:** 상태가 `processing`이면 `issued`로 바꾼다. `order_id`, `ticket_ids`, 처리 시간, 창구 포인터 해제는 `complete_queue_issuance`와 같다.
- **입장 원장:** `visit_entries` 1행과 `visit_entry_tickets` 티켓 수만큼 쓴다.
- **호환 거울:** 서약서가 오늘 접수분이고 `entry_at`이 비어 있을 때만 `safety_consents.entry_at`을 채운다. 기존 값은 덮어쓰지 않는다.
- **결제·발권 원장:** `order_items`·`order_payments`·`ticket_ledger`는 **읽기만 하고 바꾸지 않는다**.

### E4. 체류 중 팀 검색 — `search_visit_entries`

요청: `(p_access_code text, p_last4 text default null, p_include_exited boolean default false, p_include_past_unreturned boolean default false, p_site_id text default 'bongplay_bonghwa')`

응답 (`entries`는 최대 50건, 최근 입장 순):
```json
{"ok": true, "business_date": "…", "entries": [
  {"entry_id": "ve_…", "queue_id": "…", "formatted_number": "A-012", "guardian_masked": "홍*현", "last4": "1234",
   "business_date": "…", "past_business_date": false, "entered_at": "…", "status": "partial",
   "ticket_count": 3, "inside_count": 1, "returned_count": 2,
   "tickets": [{"ticket_id": "…", "product_name": "어린이 기본이용권", "returned": true, "returned_at": "…"}]}]}
```

- `p_last4`가 없으면 오늘 체류 중인 팀 전체다. 있으면 숫자 4자리여야 한다(`LAST4_FORMAT`).
- **범위:** 기본은 오늘 영업일의 `inside`·`partial`이다.
  - `p_include_exited`: 오늘 퇴장 완료도 포함한다.
  - `p_include_past_unreturned`: 지난 영업일의 미반납 팀도 포함한다(`past_business_date:true`). "이전 방문 재검색"은 이 옵션으로만 보인다.
- **돌려주지 않는 것:** 전화번호 전체, 보호자 실명, 자녀 정보, `consent_id`. 이름은 서버 마스킹(`private.mask_name`) 값만 준다.
- 같은 뒷번호의 두 팀은 두 건으로 따로 나온다. 직원은 대기번호·인원·입장 시각으로 고르고, 반납은 `entry_id`로만 한다.

### E5. 입장 기록 단건 — `get_visit_entry`

요청: `(p_access_code text, p_entry_id text, p_site_id text default 'bongplay_bonghwa')` → `{ok:true, entry:{E4 항목과 같은 형식}}`. 오류: `UNAUTHORIZED_STAFF`, `not_found`.

### E6. 팔찌 반납 = 부분·전체 퇴장 — `return_visit_wristbands`

요청: `(p_access_code text, p_entry_id text, p_ticket_ids jsonb default null, p_return_all boolean default false, p_request_id text default null, p_staff_id text default 'desk_staff', p_site_id text default 'bongplay_bonghwa')`

성공 응답:
```json
{"ok": true, "entry_id": "ve_…", "returned_now": ["t1"], "ticket_count": 3, "inside_count": 2, "returned_count": 1,
 "status": "partial", "exited_at": null, "past_business_date": false, "already_exited": false, "replayed": false}
```

| 순서 | 검사 | 실패 코드 |
|---|---|---|
| 1 | 직원 인증 | `UNAUTHORIZED_STAFF` |
| 2 | 입력: `request_id` 필수, 대상은 `p_ticket_ids`(비어 있지 않음)와 `p_return_all=true` 중 **하나만**, 중복 금지 | `REQUEST_ID_REQUIRED`, `RETURN_TARGET_REQUIRED`, `RETURN_TARGET_AMBIGUOUS`, `DUPLICATE_TICKET_IDS` |
| 3 | 같은 `request_id` 재전송 | (성공 응답 재생) / `REQUEST_ID_CONFLICT` |
| 4 | 입장 기록 (시설 범위) | `not_found` |
| 5 | 지정 티켓이 이 입장 기록 소속 | `TICKET_NOT_IN_ENTRY` |
| 6 | 지정 티켓 중 이미 반납된 것이 있음 | `TICKET_ALREADY_RETURNED` (`already_returned` 목록 포함, 하나도 반영하지 않음) |

- **전체 반납:** `p_return_all=true`는 남은 티켓 전부를 반납한다. 남은 것이 없으면 `ok:true, returned_now:[], already_exited:true`이고 아무것도 바꾸지 않는다.
- **두 단말 동시 처리:** 두 단말이 같은 팔찌를 동시에 반납하면 먼저 잠금을 얻은 쪽만 반영된다. 다른 쪽은 `TICKET_ALREADY_RETURNED`라 인원이 두 번 빠지지 않는다.
- **안전점검과 무관:** 반납은 안전점검 인터록과 무관하게 허용한다. 점검 실패 중에도 퇴장은 기록되어야 한다.
- **지난 영업일:** 지난 영업일 입장 기록도 반납할 수 있다(`past_business_date:true`, 전날 미반납 정리용).
- **원장 보존:** 반납은 `visit_entry_tickets.returned_at`과 입장 기록 상태(`inside`→`partial`→`exited`)만 바꾼다. 결제·발권 원장과 입장 시각은 그대로다.
- **호환 거울:** 전체 퇴장이 되면, 서약서가 오늘 접수분이고 `exit_at`이 비어 있을 때만 `safety_consents.exit_at`·`stay_duration_minutes`를 채운다.
- **재입장 불가:** 퇴장 후 재입장은 없다. 반납한 티켓은 다시 "체류"로 돌릴 수 없고, 같은 티켓으로 새 입장 기록도 만들 수 없다(`TICKET_ALREADY_ENTERED`).

### E7. 인원 집계 — `get_visit_occupancy`

요청: `(p_access_code text, p_business_date date default null, p_site_id text default 'bongplay_bonghwa')`. 날짜가 없으면 오늘(KST)이다.

| 응답 항목 | 정의 |
|---|---|
| `entered_teams` | 그 영업일 입장 기록 수 |
| `cumulative_visitors` (누적 방문) | 그 영업일 입장 기록의 티켓 수. 반납해도 줄지 않는다 |
| `exited_visitors` (퇴장 인원) | 그 영업일 입장 티켓 중 반납된 수 |
| `current_inside` (현재 체류) | `cumulative_visitors − exited_visitors` (그 영업일 입장분만) |
| `partial_teams` | 일부만 반납한 팀 수 |
| `past_unreturned_visitors` | 그 영업일 **이전** 입장분 중 미반납 티켓 수. 현재 체류에 더하지 않고 따로 보고한다 |
| `refunded_after_entry_visitors` | 입장 뒤 티켓 원장이 취소(환불)된 입장 티켓 수. 참고값이다. 누적·체류에서 빼지 않는다 |

- 입장권이 없는 주문(매점 단독)은 입장 기록이 없어 어떤 값에도 들어가지 않는다.
- 기존 `sales_records`·마감 정산의 결제 집계는 바꾸지 않는다.

## 4. 재시도 규칙 (단말)

| 상황 | 단말 동작 |
|---|---|
| 응답을 못 받음 (네트워크 끊김, 시간 초과, HTTP 5xx, SQL 오류 `40001`·`40P01`·`57014`) | **같은 `request_id`·같은 입력**으로 재전송 (지수 백오프, 예 1·2·4·8초, 최대 5회). 연타도 같은 동작이면 같은 `request_id` |
| `ok:true` (`replayed`·`already_entered`·`already_exited` 포함) | 완료로 처리. 다시 보내지 않음 |
| `UNAUTHORIZED_STAFF` | 폴링·재시도 중지, 재로그인. 재로그인 후 같은 `request_id`로 1회 재전송 가능 |
| `SAFETY_INTERLOCK_BLOCKED` | 자동 재시도 금지. 안전점검 PASS 반영 뒤 직원이 다시 누를 때 같은 `request_id` 사용 |
| `LAST4_NOT_VERIFIED` | E2 대조 후 같은 `request_id`로 다시 E3 |
| `PAYMENT_NOT_CONFIRMED`, `PARTIAL_PAYMENT_REJECTED`, `TICKET_LEDGER_INCOMPLETE` | 결제·발권 저장(기존 아웃박스)이 끝난 뒤 같은 `request_id`로 다시 E3. 입장 처리하지 않음 |
| `REQUEST_ID_CONFLICT` | 단말 오류. 새 동작이면 새 `request_id` |
| `TICKET_ALREADY_RETURNED`, `TICKET_ALREADY_ENTERED`, `ENTRY_EXISTS_OTHER_ORDER`, `ALREADY_ISSUED_OTHER_ORDER` | 재시도 금지. 화면을 새로 읽어(E4·E5) 현재 상태를 보여 줌 |
| 그 밖의 `ok:false` | 재시도 금지, 메시지 표시 |

## 5. 호출 알림 (발송 원장 분리)

- **대기열과 분리:** 호출 성공(`ticket_queue.status='called'`)과 알림 발송 결과를 분리한다. 발송 원장은 `queue_call_notifications`다.
  - 대기열 함수의 응답·동작은 바뀌지 않는다.
  - 발송 원장 기록이 실패해도 호출은 성공한다. 트리거가 예외를 삼키고 경고만 남긴다.
- **생성:** 호출·재호출로 `called_at`이 바뀔 때 1건을 만든다. 중복 방지 키는 `queue_id` + 그 `called_at`이다. 같은 호출을 여러 번 저장해도 1건이다.
- **억제:** 다음 경우 `suppressed`로 만들어 발송하지 않는다.
  - 같은 팀에 60초 안에 만든 알림이 이미 있음
  - 같은 팀의 그날 발송 대상이 3건을 넘음
- **상태:**
  - `pending` → 작업자 수령(`sending`, 임대 2분) → `sent` / `retry`(`pending`으로, 다음 시도 시각 지정) / `failed`(3회 소진) / `unknown`(공급사 접수 여부 불명, 자동 재발송 안 함)
  - 수령 시점에 다음 중 하나면 `expired`(발송 안 함): 팀이 더 이상 `called`가 아님, 호출 뒤 15분이 지남, 같은 팀에 더 새로운 발송 대상 알림(60초 뒤 재호출)이 있음. 따라서 한 팀에 동시에 두 알림이 나가지 않는다
  - 알림은 팀 상태가 `called`일 때의 호출·재호출에만 만든다. 처리 중(`processing`) 팀을 재호출해도 알림을 만들지 않는다
  - 작업자가 수령 후 보고 없이 임대가 끝나면 다시 보내지 않고 `unknown`으로 둔다(이미 발송됐을 수 있으므로)
- **실패 처리:** 발송 실패·불명은 대기열을 바꾸지 않는다. 다음 팀을 자동 호출하지 않고, 같은 호출을 다시 발송하지 않는다. 매표소는 육성 호출을 계속한다.
- **작업자 함수 (`service_role` 전용, anon 불가):**
  - `claim_queue_call_notifications(p_limit int default 10, p_lease_seconds int default 120)` → `{ok, items:[{notification_id, claim_token, queue_id, formatted_number, desk_no, recipient_phone, attempt}]}`
  - `report_queue_call_notification(p_notification_id text, p_claim_token text, p_result text, p_provider_message_id text default null, p_error text default null)`
    - `p_result`: `sent` | `retryable` | `failed` | `unknown`
    - 같은 수령 건을 다시 보고하면 상태 변화 없이 `duplicate:true`
    - 임대가 끝나 다른 작업자가 다시 수령했다면 `STALE_CLAIM`
- **직원 조회:** `get_queue_call_notifications(p_access_code, p_queue_id, p_site_id)` → `{ok, items:[{notification_id, called_at, status, attempts, updated_at, last_error_code}]}`. 화면은 "알림 대기·발송·실패·미발송"만 표시한다.
- **현재 단계의 한계:** 공급사, 승인 템플릿, 인증정보가 없다. 작업자는 구현하지 않았고 실제 알림톡 발송은 **미완료**다. 시험은 모의 작업자로만 했다.

## 6. 개인정보 노출 경계

- **새 표 접근:** 새 표(`visit_entries`, `visit_entry_tickets`, `visit_identity_checks`, `visit_entry_requests`, `queue_call_notifications`)는 RLS를 켜고 정책을 두지 않는다. anon·authenticated의 표 권한도 회수한다.
- **새 함수 권한:** 직원 함수는 anon에게 실행 권한이 있지만, 운영 암호 없이 `UNAUTHORIZED_STAFF`만 돌려준다. 작업자 함수는 `service_role`만 실행한다.
- **기존 노출 위험 (이 작업에서 바꾸지 않음, 벤 결정 필요):**
  - `FINAL_SUPABASE_SETUP.sql`의 `consents_select_restricted`는 anon에게 **오늘 접수 서약서 행 직접 SELECT**를 허용한다. 보호자 이름·전화번호·자녀 정보가 포함된다.
  - 고객 화면이 이 경로를 쓰지 않더라도 anon 키를 아는 사람은 오늘 행을 읽을 수 있다.

## 7. 화면(아난티) 체크리스트

1. 호출 응답의 `queue_id`로만 뒷번호 대조(E2)를 한다. 뒷번호 입력으로 팀을 고르지 않는다.
2. 결제·발권 저장(`createOrder`) 완료 확인 뒤 E3를 부른다. `ok:true`일 때만 "입장 완료"를 표시하고 팔찌를 준다.
   - 화면 단독 판정이나 로컬 캐시로 입장을 표시하지 않는다.
3. 버튼을 누를 때마다 `request_id`를 새로 만든다. 같은 동작의 재전송·연타는 같은 `request_id`를 쓴다(4절).
4. 반납 화면은 E4 결과에서 팀을 고르고 티켓(사람) 단위로 선택한다. 전체 반납은 `p_return_all`을 쓴다.
5. 고객용 화면에 바우처 QR·카카오톡 확인 안내를 넣지 않는다. 출구 설문 QR은 방문 식별자 없는 공용 주소로 한다.
6. 호출 알림 상태는 E1 화면에 보조 표시만 한다. 실패해도 다음 팀 호출을 자동으로 하지 않는다.

## 8. 적용 순서·호환 기간·복구 (요약, 상세는 구현 보고서)

- **적용 순서:** 기존 설치 묶음(`FINAL` → 서약서 취소 3열 → 대기열 → `lookup_family_children` 차단) → `PROPOSED_MIGRATION_visit_entry.sql`
  - 다시 실행해도 안전하다(`IF NOT EXISTS`, `CREATE OR REPLACE`).
- **호환 기간:**
  - 기존 `complete_queue_issuance`와 구 게이트 화면은 남는다. 새 화면 배포 전까지 기존 흐름이 그대로 동작한다.
  - 구 경로로 이미 `issued`된 팀은 같은 주문으로 E3를 부르면 입장 기록이 생긴다(6번 호환).
  - `safety_consents.entry_at/exit_at`은 비어 있을 때만 채운다.
- **복구:** 새 표·함수·트리거만 삭제하면 원래 상태다(`test_supabase_install/90_reset_visit_entry.sql`, 시험 설치 전용 보호 있음). 결제·발권·대기열 원장은 이 마이그레이션이 바꾸지 않는다.
  - 예외: E3 성공 시의 대기열 `issued` 전환은 기존 발권 완료와 같은 결과로 남는다.

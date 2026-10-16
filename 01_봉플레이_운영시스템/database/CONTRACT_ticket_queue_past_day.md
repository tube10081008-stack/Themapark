# 대기열 반환 API 계약 — 전날 미정리 팀과 창구 점유 (CLAUDE-011 R4)

- 대상: `PROPOSED_MIGRATION_ticket_queue.sql` 의 직원 RPC.
- 이 문서는 구현 전에 고정하는 반환 계약이다. 구현과 시험은 이 문서를 기준으로 한다.
- 함수 서명(인자 이름·순서·기본값)은 바꾸지 않는다. 매표 화면(ANT-006)은 수정할 필요가 없다.
- 표·열도 추가하지 않는다. 바뀌는 것은 함수 본문과 내부 잠금 함수 1개다.

## 0. 문제

매표 창구 표 `ticket_queue_desks` 는 날짜가 없다. `current_queue_id` 는 대기열 행을 가리키는 포인터다.
전날 `called`·`processing` 상태로 끝나지 않은 팀이 있으면 다음 상황이 생긴다 (9a5380f 기준).

| # | 현상 |
|---|---|
| P1 | 창구 포인터가 다음 날에도 전날 팀을 가리킨다. 직원 목록(`get_staff_queue_list`)은 그 값을 그대로 돌려줘서, 오늘 점유인지 전날 잔재인지 구분할 수 없다 |
| P2 | 오늘 목록(`p_date` = 오늘)에는 전날 미정리 팀이 보이지 않는다. 그래서 정리할 방법이 없다. 결제·티켓 원장이 저장됐는데 완료만 못 한 팀이면 매출이 대기열 완료 없이 남는다 |
| P3 | 재호출·처리 시작에 `p_desk_no` 를 주면 창구를 옮길 수 있다. 이때 점유 검사와 포인터 갱신이 없다. 한 창구에 활성 팀이 둘이 될 수 있고, 옛 창구 포인터는 남는다 |
| P4 | 보류·취소·완료는 `v_rec.desk_no` 창구 포인터만 지운다. P3 로 옮겨진 팀이면 다른 창구 포인터가 남는다 |
| P5 | 전날 팀에도 재호출·처리 시작·보류·복귀가 된다. 복귀하면 전날 날짜의 `waiting` 이 되어 다시는 호출되지 않는다 |
| P6 | 전날 팀을 취소하면, 결제·티켓 원장이 저장돼 있어도 대기열만 `canceled` 가 된다 (원장과 대기열 단절) |
| P7 | 호출의 창구 정지 확인이 잠금 밖에서 일어난다. 동시에 정지하면 정지된 창구로 호출될 수 있다 |
| P8 | 행 조회에 `site_id` 확인이 없다. 다른 시설의 대기 id 로 상태를 바꿀 수 있다 |

## 1. 기준 (벤 R4)

1. 과거 원장과 `order_id` 를 보존한다. 어떤 RPC 도 원장 표(`order_items`·`order_payments`·`ticket_ledger`)를 쓰거나 고치지 않는다.
2. 자동 취소·자동 발권 완료는 없다. 전날 팀은 직원이 인증된 변경 RPC 로 명시적으로 정리할 때만 바뀐다.
3. 오늘 창구 점유와 과거 미정리 건을 구분한다.
   - 점유는 오늘 행만으로 판정한다.
   - 과거 행은 점유하지 않고, 오늘 호출을 막지 않는다.
4. 정합성은 인증된 변경 RPC 안에서 잠금과 재조회로 보장한다.
5. 조회 RPC 에는 숨은 쓰기가 없다.
   - 대기열·창구·원장 표를 쓰지 않는다.
   - 유일한 쓰기는 FINAL 의 기존 직원 인증 기록(`private.auth_attempts`)이다. IP 잠금용이며 이번 변경과 무관하다.

## 2. 용어

| 용어 | 정의 |
|---|---|
| 영업일 `queue_day` | 트랜잭션 시작 시각의 KST 날짜. `(now() at time zone 'Asia/Seoul')::date` |
| 과거 행 | `queue_date < queue_day` |
| 오늘 점유 | `queue_date = queue_day`, `status in ('called','processing')`, `desk_no = N` 인 행. **진실은 행이다.** `current_queue_id` 는 변경 RPC 가 관리하는 캐시일 뿐이다 |
| 과거 미정리 팀 | 과거 행 중 `status in ('called','processing')` 인 행 (창구를 잡았다가 끝나지 않은 팀) |
| 기록된 주문 | 그 팀 서약서(`consent_id`)에 연결된 주문 중, 활성 원장(아래)이 하나라도 있는 주문 |
| 활성 원장 | 취소되지 않은 주문 품목, `status='paid'` 이고 미취소인 결제, 미취소 활성 티켓 |

## 3. 잠금과 재조회 (모든 직원 변경 RPC 공통)

순서:
1. 직원 인증 (bcrypt). 잠금 밖에서 한다.
2. **시설 잠금** `private.lock_ticket_queue_site(site)` (트랜잭션 범위 advisory lock)
   - 직원 변경 RPC 는 모두 이 잠금을 먼저 잡는다.
   - 시설 단위라 자정을 사이에 둔 두 요청도 직렬화된다. 날짜 단위 잠금이면 두 날짜가 서로 다른 잠금을 잡는다.
3. 대상 행 `select … for update` 재조회. `site_id = p_site_id` 가 아니면 `not_found`.
4. 상태 판정 → 쓰기.

- 접수(`enqueue_consent_team`)는 지금처럼 날짜 잠금 `lock_ticket_queue_day` 만 잡는다. 번호 계산용이다.
- 복귀는 시설 잠금 다음에 날짜 잠금을 잡는다. 잠금 순서는 항상 시설 → 날짜다.
- 창구 포인터 정리는 "이 대기 id 를 가리키는 모든 창구"를 대상으로 한다 (P4).

## 4. 조회 — `get_staff_queue_list(p_access_code, p_date, p_site_id)`

기존 필드는 그대로 둔다: `ok`·`date`·`waiting_count`·`waiting_teams`·`called_teams`·`held_teams`·`server_time`. `p_date` 기준이다.
`desks[]` 는 항목을 늘리고 `current_queue_id` 의 의미를 바꾼다 (화면은 이 필드를 읽지 않는다).

추가 필드:

```jsonc
{
  "queue_day": "2026-10-17",              // 서버 영업일 (KST)
  "desks": [{
    "desk_no": 1, "is_active": true, "is_paused": false,
    "current_queue_id": "q_…",            // [의미 변경] 오늘 점유 팀 id. 없으면 null (예전: 저장된 포인터 그대로)
    "occupant": { "id": "q_…", "formatted_number": "#003", "status": "processing", "consent_id": "…" },  // 또는 null
    "occupancy_count": 1,                 // 오늘 이 창구의 활성 팀 수 (2 이상이면 정합성 위반)
    "pointer_queue_id": "q_…",            // 저장된 포인터 원값
    "pointer_state": "ok",                // 아래 표
    "pointer_stale": null                 // pointer_state='stale' 일 때 { "queue_id", "reason", "queue_date", "status" }
  }],
  "past_unresolved_total": 1,
  "past_unresolved_teams": [{             // 과거 미정리 팀, queue_date·desk_no 순, 최대 100건
    "id": "q_…", "queue_date": "2026-10-16", "queue_number": 7, "formatted_number": "#007",
    "status": "processing", "desk_no": 1, "consent_id": "…", "guardian_name": "…", "party_size": 2,
    "called_at": "…", "processing_started_at": "…",
    "recorded_orders": [{ "order_id": "…", "item_total": 30000, "paid_total": 30000, "active_tickets": 2 }],
    "allowed_actions": ["complete_queue_issuance"],
    "blocked_reason": null
  }],
  "past_open_counts": { "waiting": 0, "no_show": 0 }   // 과거 waiting·no_show 수 (창구를 잡지 않음, 참고용)
}
```

| `pointer_state` | 뜻 |
|---|---|
| `empty` | 포인터 null, 오늘 점유 없음 |
| `ok` | 포인터 = 오늘 점유 팀 |
| `stale` | 포인터가 오늘 점유 팀이 아닌 행을 가리킨다. 오늘 점유는 없다. `reason`: `past_day`(과거 행) · `inactive`(오늘 행이지만 issued·canceled·no_show·waiting) · `other_desk`(오늘 활성이지만 다른 창구) · `not_found`(행 없음) |
| `missing` | 오늘 점유 팀이 있는데 포인터가 null 이거나 다른 행을 가리킨다 |

`allowed_actions` (과거 미정리 팀):

| 상태 | 기록된 주문 | allowed_actions | blocked_reason |
|---|---|---|---|
| processing | 있음 | `["complete_queue_issuance"]` (같은 `order_id` 로) | null |
| processing | 없음 | `["cancel_queue_team"]` | null |
| called | 없음 | `["cancel_queue_team"]` | null |
| called | 있음 | `[]` | `LEDGER_REVIEW_REQUIRED` |

- called 상태에 기록된 주문이 있는 경우는 화면 흐름(처리 시작 → 원장 저장)에서는 생기지 않는다.
- 원장이 일부만 저장된 processing 팀은 완료 검증에서 거부된다. 기록된 주문이 있으므로 취소도 거부된다.
  - 이때는 기존 환불(원장 취소) 절차로 원장을 먼저 정리해야 한다.
  - 정리하면 기록된 주문이 사라지고 취소가 가능해진다.

**쓰기 없음**: 이 함수는 대기열·창구·원장 표를 쓰지 않는다. 포인터가 `stale`·`missing` 이어도 고치지 않고 보고만 한다.

## 5. 변경 RPC 반환 계약

공통 규칙:
- 인증 실패 응답은 그대로 `UNAUTHORIZED_STAFF` 다.
- 행이 없거나 다른 시설 행이면 `not_found`.
- 성공 응답의 기존 필드는 유지하고, 아래 필드만 더한다.

### 5.1 `call_next_queue_team`

- 오늘 행만 호출한다 (지금과 같음). 오늘 점유는 오늘 행으로 판정한다. 과거 미정리 팀은 오늘 호출을 막지 않고, 그 행은 바뀌지 않는다.
- 창구 정지 여부는 잠금 안에서 창구 행을 `for update` 로 다시 읽어 판정한다 (P7).
- 성공 응답에 `replaced_pointer` 를 더한다. 바꾸기 전 포인터가 `stale` 이었으면 `{ "queue_id", "reason", "queue_date", "status" }`, 아니면 null.
- 오류 코드는 그대로다: `DESK_PAUSED`·`DESK_ALREADY_OCCUPIED`·`empty_queue`.
  - `DESK_ALREADY_OCCUPIED` 응답에는 `occupant` `{ id, formatted_number, status }` 를 더한다.

### 5.2 `recall_queue_team`, `start_queue_processing`

- 과거 행이면 `PAST_QUEUE_DATE` 로 거부한다.
  - 응답: `{ ok:false, error:'PAST_QUEUE_DATE', queue_date, status, allowed_actions, message }`
  - `allowed_actions` 는 §4 표와 같다.
- 대상 창구는 `coalesce(p_desk_no, desk_no)` 이다. 원래 창구와 다르면 아래와 같이 한다.
  - 그 창구에 다른 오늘 활성 팀이 있으면 `DESK_ALREADY_OCCUPIED` (+ `occupant`).
  - 없으면 옮긴다. 이 id 를 가리키던 모든 포인터를 지우고, 대상 창구 포인터를 이 id 로 둔다.
  - 성공 응답에 `moved_from_desk` (옮기지 않았으면 null).
- 같은 창구이면 포인터가 이 id 가 아닐 때 이 id 로 고친다 (변경 RPC 의 정합성 복구).

### 5.3 `hold_queue_team`, `restore_queue_team`

- 과거 행이면 `PAST_QUEUE_DATE` 로 거부한다 (응답 형식은 5.2 와 같음). 전날 팀을 오늘 보류·복귀하지 않는다 (P5).
- 보류는 이 id 를 가리키는 모든 창구 포인터를 지운다.

### 5.4 `cancel_queue_team`

- 오늘 행은 지금과 같다. `issued` 는 `CANNOT_CANCEL_ISSUED` 다.
- 과거 행이고 기록된 주문이 있으면 `ORDER_RECORDED` 로 거부한다 (P6).
  - 응답: `{ ok:false, error:'ORDER_RECORDED', queue_date, status, recorded_orders, allowed_actions, message }`
- 과거 행이고 기록된 주문이 없으면 직원의 명시적 취소로 허용한다.
- 이 id 를 가리키는 모든 창구 포인터를 지운다.
- 성공 응답에 `queue_date`, `past_queue_date` (불리언).

### 5.5 `complete_queue_issuance`

- 검증은 그대로다: 직원 인증, processing 상태, 원장 대사(품목·결제·티켓·서약서 소속).
- 과거 processing 행도 직원이 **같은 주문 id** 로 호출하면 완료할 수 있다.
  - 원장을 새로 만들지 않는다. 대기열에 기존 `order_id` 를 연결할 뿐이다.
  - 같은 `order_id` 재시도는 지금처럼 `duplicate:true` 다.
- 이 id 를 가리키는 모든 창구 포인터를 지운다. 오늘 다른 팀을 가리키는 포인터는 건드리지 않는다.
- 성공 응답(멱등 포함)에 `queue_date`, `past_queue_date`.

### 5.6 `set_desk_pause_status`

- 시설 잠금 안에서 실행한다. 반환은 그대로다.

## 6. 바뀌지 않는 것

- 함수 서명, 권한(GRANT/REVOKE), RLS, 표·열·제약.
- `enqueue_consent_team`, `get_customer_queue_status`, `get_queue_public_display` 의 동작.
- 원장 표와 서약서 표. 어떤 대기열 RPC 도 쓰지 않는다.
- 자동 정리 작업(cron 등) 없음.

## 7. 오늘 행 동작 영향

| 동작 | 9a5380f | 이 계약 |
|---|---|---|
| 오늘 호출·처리 시작·완료·보류·복귀·취소 (같은 창구) | 성공 | 성공, 응답 필드만 추가 |
| 재호출·처리 시작으로 점유된 창구로 이동 | 성공 (한 창구에 2팀) | `DESK_ALREADY_OCCUPIED` |
| 오늘 처리 중 팀 취소 (원장 저장됨) | 성공 | 성공 (변경 없음 — 아래 결정 요청) |

**결정 요청 (벤)**: 원장이 저장된 **오늘** 처리 중 팀의 취소도 `ORDER_RECORDED` 로 막을지 정해 주세요.
- 이 계약은 과거 행에만 적용했다. 오늘 행까지 막으면 화면의 [접수 취소] 동작이 바뀌어서다.

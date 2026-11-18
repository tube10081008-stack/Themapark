# CLAUDE-011 — 매표소 발권 대기열 계약 (판본 v1)

- 지시: 벤 → 클로이, BEN-022 클로이 담당 실행 지시 (2026-10-08)
- 기준: `origin/master` `892a06143ebe69e64a77761cd5793ab199c9755b` (2026-10-04T22:21:38+09:00)
- 범위: `01_봉플레이_운영시스템/` 매표소 발권 대기. 놀이시설 탑승 대기, 06 상담 기능은 제외.
- 역할: 이 문서는 계약이다. 실행 코드·SQL·화면은 아난티 담당이다. 이 문서에 나오는 테이블·RPC 이름은 **제안 이름이며 현재 저장소에 없다** (§1).
- 표기
  - **[계약]** 구현이 반드시 지켜야 한다.
  - **[제안]** 근거가 있는 초기값·선택안이다. 벤 또는 대표가 확정한다.
  - **[결정 요청]** 확정이 필요하다.

## 0. 운영 흐름

QR 동의서 **서버 접수** → 대기번호 부여 → 고객이 자기 순서·예상시간 확인 → 직원 호출 → 발권 완료.

기본 단위는 **동의서 1건 = 1팀**이다. 대기 항목(entry) 1개는 동의서 1건과 1:1로 대응한다.

## 1. 현재 저장소 상태와 의존성 (`892a061` 기준 확인)

| 항목 | 현재 | 계약 영향 |
|---|---|---|
| 동의서 제출 `pages/consent.html` | 제출할 때마다 `id = 'cst_' + Date.now() + random` 을 새로 만든다. `await BongplaySync.upsert('safety_consents', …)` 결과와 상관없이 바우처를 보여 준다. | 같은 제출을 재시도·새로고침하면 다른 동의서가 생길 수 있다. 로컬 저장을 접수로 간주하는 구조다 → §4·§5 |
| `BongplaySync.upsert` (`assets/bongplay-sync.js`) | 오프라인·네트워크 오류 시 outbox 에 넣고 `{ok:true, queued:true}` 를 반환한다. | `ok:true` 만으로 서버 접수를 판단하면 안 된다. **`queued` 가 있으면 미접수**다 (§5) |
| 발권 `pages/consent-desk.html` | `BongplayID.createOrder` 다음에 `ticket_ledger` upsert 를 **await 없이** 호출한다. 이어서 `safety_consents.is_issued=true` 를 upsert 한다. | 서버 원장 확정 없이 발권 완료를 표시할 수 있다 → §7 |
| 직원 권한 | 공용 접근 코드 `verify_staff_access(p_access_code)` 만 있다 (`database/FINAL_SUPABASE_SETUP.sql`). 직원 개인 식별은 없다. | 감사 기록의 행위자는 단말(device_id/label)·창구까지만 남는다 → [결정 요청 B3] |
| 대기열 테이블·RPC | **없다.** | 모든 대기열 RPC 는 신규 구현 대상이다 (§9) |
| `safety_consents` RLS | anon insert 허용, 당일 select/update 허용 (`supabase_rls_hardening.sql`) | 대기 상태는 anon 이 직접 갱신하지 못하는 별도 테이블과 `security definer` RPC 로만 바꾼다 (§9) |

## 2. 상태

| 상태 | 뜻 | 앞선 팀 수 산정 | 종료 상태 |
|---|---|---|---|
| `waiting` | 서버 접수 완료, 호출 대기 | 포함 | |
| `called` | 창구가 호출함 | 포함 | |
| `serving` | 창구에서 발권 처리 중 | 포함 | |
| `issued` | 서버 발권 원장 확정 후 완료 | 제외 | 예 |
| `held` | 호출에 응답 없음(부재 보류) | 제외 | |
| `cancelled` | 접수 취소 (고객 또는 직원) | 제외 | 예 |
| `closed` | 영업일 종료 처리로 마감 | 제외 | 예 |

클라이언트 전용 표시 상태가 하나 있다: **`pending_send` "접수 전송 대기"**. 서버 상태가 아니다. 번호·순서가 없다 (§5).

### 2.1 전이표 [계약]

| 전이 | 행위자 | 조건 | 비고 |
|---|---|---|---|
| (없음) → `waiting` | 고객 | 동의서가 서버에 저장되고 같은 트랜잭션에서 번호가 부여됨 | §4 |
| `waiting` → `called` | 직원 | 창구 `open`, 그 창구에 `called`/`serving` 항목이 없음 | 다음 호출(§9 `queue_call_next`) |
| `called` → `serving` | 직원 | 같은 창구 | |
| `called` → `held` | 직원 | 무응답 | 보류 사유 기록 |
| `serving` → `issued` | 직원 | **서버 발권 원장 확정 검증 통과** | §7 |
| `serving` → `held` | 직원 | 처리 중 이탈 | 원장 미확정일 때만 |
| `held` → `waiting` | 직원 | **명시적 복귀 조작** | 맨 뒤 합류 (§6), 감사 기록 |
| `waiting`/`called`/`held` → `cancelled` | 고객(토큰) 또는 직원 | | |
| `serving` → `cancelled` | 직원 | 원장 미확정, 사유 필수 | |
| 비종료 상태 → `closed` | 직원 또는 일괄 작업 | 영업일 종료 | §8 |

- 위 표에 없는 전이는 모두 `INVALID_TRANSITION` 이다.
- 종료 상태(`issued`/`cancelled`/`closed`)에서는 어떤 전이도 없다.
- **[결정 요청 B1]** 직원 오조작 되돌리기 `called` → `waiting`(원래 순서 유지, 사유·감사 필수)을 둘지. 이 판본에는 넣지 않았다.

## 3. 번호와 순서 [계약]

- 번호 키는 **시설(`site_id`) + KST 영업일(`business_date`)** 이다.
  - 영업일은 서버가 `(now() at time zone 'Asia/Seoul')::date` 로 정한다.
  - **[제안]** 자정을 넘는 영업은 없다고 가정한다. 운영시간이 미정이므로 영업일 경계는 [결정 요청 C1] 이다.
- 대기번호 `queue_no` 는 서버가 **원자적으로** 부여한다. 같은 키에 대해 1부터 증가한다.
  - 클라이언트 시계, 배열 위치, 화면 행 번호, 로컬 카운터로 번호를 만들지 않는다.
  - 예: 일별 카운터 행에 `insert … on conflict (site_id, business_date) do update set last_no = last_no + 1 returning last_no` 를 대기 항목 insert 와 같은 트랜잭션에서 실행한다.
- `queue_no` 는 한 번 부여되면 **바뀌지 않는다** (표시 번호 고정).
- 순서는 `queue_no` 가 아니라 별도 정렬 키 `order_key` 로 정한다.
  - 접수 시 `order_key` 를 같은 일별 카운터에서 증가시켜 부여한다.
  - 부재 복귀 때는 새 `order_key` 를 받는다 (§6). 그래서 복귀한 팀의 번호는 그대로이고 순서만 뒤로 간다.
- 실패한 트랜잭션 때문에 번호가 비는 것(gap)은 허용한다. 비어도 다시 쓰지 않는다.
- **앞선 팀 수** `ahead_count` = 같은 `site_id`·`business_date` 에서 상태가 `waiting`/`called`/`serving` 이고 `order_key` 가 자기보다 작은 항목 수.
  - `issued`·`held`·`cancelled`·`closed` 는 제외한다.
  - 자기 상태가 `called`/`serving` 이면 고객 화면에는 앞선 팀 수 대신 "호출되었습니다/발권 중" 을 보여 준다.

## 4. 접수 멱등성 [계약]

- 고객 단말은 제출 시도 하나마다 다음 두 값을 **전송 전에** 만들어 로컬에 저장하고, 재시도·새로고침·응답 유실 때 그대로 다시 보낸다.
  - `client_request_id`: UUID v4
  - `consent_id`: 동의서 id
- 서버는 `unique (site_id, client_request_id)` 와 `unique (consent_id)` 를 둔다.

| 상황 | 서버 응답 |
|---|---|
| 처음 요청 | 동의서 저장 + 번호 부여, 201 상당 `{ok:true, created:true, …}` |
| 같은 `client_request_id` + 같은 `consent_id` (재시도·응답 유실) | **같은 결과** `{ok:true, created:false, …}`: 같은 `queue_no`, 현재 상태, 같은 조회 토큰 |
| 같은 `consent_id`, 다른 `client_request_id` (새로고침 후 재생성 등) | 기존 항목의 결과를 그대로 반환 (`created:false`) |
| 같은 `client_request_id`, 다른 `consent_id` | `IDEMPOTENCY_KEY_REUSED` (409), 아무것도 저장하지 않음 |

- 멱등 비교는 동의서 본문 해시(`request_fingerprint`)도 함께 저장한다. 같은 키로 본문이 다르면 `IDEMPOTENCY_KEY_REUSED` 다.
- **전화번호만으로 중복 여부를 판단하지 않는다.** 같은 보호자가 다른 팀을 데려오거나 가족끼리 번호를 공유하는 경우를 막지 않는다.
  - 같은 전화번호의 활성 항목이 여럿이면 직원 목록에 **표시만** 한다 (`same_phone_active_count`, 차단 아님).
- **[제안 A1]** 동의서 저장과 번호 부여를 **하나의 RPC·하나의 트랜잭션**(`queue_submit`)으로 처리한다.
  - 대안은 `safety_consents` upsert 다음에 별도 enqueue 를 호출하는 2단계 방식이다. 이 경우 동의서만 저장되고 번호가 없는 중간 상태가 생긴다. 이 상태의 복구 규칙(재호출 시 기존 동의서로 enqueue)이 추가로 필요하다.

## 5. 서버 접수와 오프라인 [계약]

- 고객 화면에 대기번호를 보여 주는 조건은 **`queue_submit` 의 서버 성공 응답** 하나뿐이다.
- `BongplaySync.upsert` 의 `{ok:true, queued:true}`, 로컬 캐시 저장, outbox 적재는 접수가 아니다.
  - 이 경우 화면은 **"접수 전송 대기"** 로 표시한다.
  - "공식 번호와 순서는 전송이 완료되어야 정해집니다" 를 안내한다. 번호·앞선 팀 수·예상시간은 표시하지 않는다.
- 오프라인에서 입력한 내용이 나중에 전송되면 그 시점에 번호가 부여된다. 입력 시각 기준으로 앞 순서를 주지 않는다 (서버 수신 순서).
- 클라이언트가 오프라인 대기 중에 번호를 추정하거나 임시 번호를 보여 주지 않는다.

## 6. 부재 보류와 복귀 [계약 + 제안]

- `called` → `held` 는 직원이 판단한다.
  - **[제안]** 자동 보류(타이머)는 이번 판본에 넣지 않는다. 호출 후 응답 대기 시간이 정해진 적이 없기 때문이다 → [결정 요청 C2]
- `held` → `waiting` 은 **직원의 명시적 조작**으로만 한다. 이때 새 `order_key` 를 받아 **맨 뒤에 합류**한다.
  - `queue_no` 는 유지한다.
  - 감사 기록에 이전·새 `order_key`, 행위자, 사유를 남긴다.
  - 이것은 초기 정책이며 대표 확인 대상이다 → [결정 요청 C3]
- 고객이 스스로 복귀하는 API 는 없다.
- `held` 는 앞선 팀 수 계산에서 빠지고 예상시간도 표시하지 않는다.
  - 고객 화면 문구: "호출에 응답이 없어 보류되었습니다. 매표소 직원에게 말씀해 주세요."

## 7. 발권 완료와 원장 [계약]

- `serving` → `issued` 는 서버가 **발권 원장 확정**을 검증한 트랜잭션 안에서만 일어난다.
- **확정 조건 [제안 A2]**: `p_order_id` 의 주문이 다음을 모두 만족해야 한다.
  1. `consent_id` 가 이 항목과 일치한다.
  2. 수납 원장 합계가 주문 합계와 같다.
  3. 입장권 품목 수량만큼 `ticket_ledger` 행(`status='active'`)이 **서버에 있다**.
- 조건을 만족하지 못하면 `LEDGER_NOT_CONFIRMED` (409) 를 반환하고 상태는 `serving` 그대로 둔다.
  - 응답에 부족 항목을 돌려준다: `missing: ['order'|'payment'|'tickets']`, 기대·실제 매수.
- **실패·부분 성공·재시도**

  | 경우 | 처리 |
  |---|---|
  | 원장 쓰기가 outbox 에 남음 (오프라인) | `serving` 유지. 직원 화면 "발권 확인 필요(원장 전송 대기)". 전송 후 같은 `request_id` 로 `queue_issue_complete` 재시도 |
  | 주문은 있고 티켓 일부 누락 (부분 성공) | `serving` 유지. 누락 티켓을 **같은 주문 id·같은 ticket_id** 로 재전송한다 (upsert 멱등). 새 주문을 만들지 않는다 |
  | 원장 확정 후 `issue_complete` 응답 유실 | 같은 `request_id` 로 재시도하면 같은 성공 결과를 받는다 |
  | 원장 확정 후 상태 전이 실패 (서버 오류) | 원장은 유지한다. 재시도로 전이한다. 원장을 되돌리지 않는다 |
  | 결제 실패·취소 | 원장 미확정 → `serving` 유지 또는 직원 `cancelled`/`held` (사유) |

- **현재 코드 의존성**: 지금은 발권이 원장 upsert 를 await 하지 않는다. 그래서 구현 시 원장 쓰기가 서버 확정(`queued` 아님)인지 확인한 뒤 `queue_issue_complete` 를 호출해야 한다. 원장 생성과 완료 전이를 서버 RPC 하나로 묶는 것이 더 안전하다 → [결정 요청 B2]
- **발권 취소**(원장 `status` 변경, `cancelOrdersByConsent`)가 있어도 대기 항목은 예전 순서로 **자동 복귀하지 않는다.** 대기 항목은 `issued` 그대로다.
  - 재발권이 필요하면 직원이 같은 항목에서 원장을 다시 확정하는 것이 아니라 새 동의서로 새 접수를 한다. 또는 [결정 요청 B4] 에 따른다.

## 8. 영업일 종료 [계약]

- 영업일 종료 처리는 같은 `site_id`·`business_date` 의 비종료 항목(`waiting`/`called`/`serving`/`held`)을 `closed` 로 바꾼다. 각 항목에 감사 기록을 남긴다.
- `serving` 항목은 원장이 확정되어 있으면 먼저 `issued` 로 전이를 시도한다. 실패하면 `closed` + "원장 확인 필요" 표시를 남긴다.
- 종료 뒤 같은 영업일의 `queue_submit` 은 `QUEUE_CLOSED` 다. 다음 영업일 번호는 1부터 시작한다.
- 실행 주체(직원 조작 또는 일정 작업)와 시각은 운영시간 미정으로 [결정 요청 C1] 이다.

## 9. API 계약 (모두 신규 · 제안 이름)

공통 사항:
- 모두 Supabase `security definer` RPC 로 구현하고 `search_path` 를 고정한다.
- 대기 테이블에는 anon·authenticated 의 직접 insert/update/delete/select 를 **허용하지 않는다**.
- 응답은 `jsonb` 다.
  - 성공: `{ok:true, …, server_time}`
  - 실패: `{ok:false, error:{code, message_ko, retryable}}`
- `server_time` 은 서버 시각(ISO 8601 +09:00)이다. 클라이언트 시계로 갱신 시각을 표시하지 않는다.

| RPC | 호출자 | 요청 | 성공 응답 | 멱등성 |
|---|---|---|---|---|
| `queue_submit` | 고객(anon) | `p_site_id`, `p_client_request_id`(uuid), `p_consent`(jsonb, 동의서 본문·`consent_id`) | `queue_no`, `business_date`, `status`, `lookup_token`, `token_expires_at`, `created` | §4 |
| `queue_my_status` | 고객(토큰) | `p_lookup_token` | `queue_no`, `status`, `ahead_count`(waiting일 때), `eta`(§10), `counter_label`(called/serving일 때), `server_time`, `stale_after_seconds` | 조회 |
| `queue_cancel_self` | 고객(토큰) | `p_lookup_token`, `p_request_id` | `status:'cancelled'` | `request_id` |
| `queue_staff_list` | 직원 | `p_access_code`, `p_site_id`, `p_business_date`(생략 시 서버 KST 오늘) | 항목 배열: `entry_ref`, `queue_no`, `status`, `position`, `counter_id`, 각 전이 시각, `consent_id`, 마스킹된 보호자명, 인원, `same_phone_active_count`, `version` | 조회 |
| `queue_call_next` | 직원 | `p_access_code`, `p_counter_id`, `p_request_id` | 호출된 항목, `version` | `request_id` |
| `queue_transition` | 직원 | `p_access_code`, `p_entry_ref`, `p_expected_version`, `p_action`(`start_serving`/`hold`/`rejoin`/`cancel`), `p_reason`, `p_counter_id`, `p_request_id` | 새 상태, `version` | `request_id` |
| `queue_issue_complete` | 직원 | `p_access_code`, `p_entry_ref`, `p_expected_version`, `p_order_id`, `p_request_id` | `status:'issued'`, `version` | `request_id` |
| `queue_counter_set` | 직원 | `p_access_code`, `p_counter_id`, `p_state`(`open`/`paused`/`closed`), `p_reason`, `p_request_id` | 창구 상태 | `request_id` |
| `queue_close_day` | 직원 | `p_access_code`, `p_site_id`, `p_business_date`, `p_request_id` | 마감 건수 | `request_id` |
| `queue_public_board` | 공개(anon) | `p_site_id` | 호출 중 목록 `[{queue_no, counter_label}]`, `server_time` | 조회 |

### 9.1 권한 [계약]

- 직원 RPC 는 매 호출마다 서버에서 `private.verify_access_code(p_access_code)` 를 검증한다. 실패하면 `UNAUTHORIZED` 이고, 대기 항목의 존재 여부도 알려 주지 않는다.
- 클라이언트 화면의 권한 표시·숨김은 보안 경계가 아니다.
- 고객 RPC 는 토큰이 가리키는 **자기 항목**만 다룬다.
- `queue_public_board` 는 번호와 창구 표시명만 반환한다. 이름·전화·자녀·서명·동의서 id·상태 이력은 반환하지 않는다.
- `queue_staff_list` 도 이름은 기존 마스킹 함수 규칙으로 가린다. 동의서 원문은 기존 `get_today_consents_secure` 경로로만 조회한다.

### 9.2 경합 처리 [계약]

- `queue_call_next` 는 `waiting` 중 `order_key` 가 가장 작은 행을 `for update skip locked` 로 잠그고 전이한다.
  - 두 창구가 동시에 호출해도 한 팀이 두 창구에 호출되지 않는다.
  - 대상이 없으면 `QUEUE_EMPTY` 다.
- 창구당 활성 항목(`called`/`serving`)은 1개다. 이미 있으면 `COUNTER_BUSY` 다.
- 모든 직원 전이는 `p_expected_version` 을 비교한다. 다르면 `VERSION_CONFLICT` (409) 이고, 현재 상태와 `version` 을 돌려준다. 성공하면 `version + 1` 이다.
- 같은 `p_request_id` 의 재요청은 **처음 결과를 그대로** 반환한다 (요청 기록 테이블에 결과 보관).
  - **[제안]** 보관 기간은 영업일 종료 + 1일이다.
- 동시 발권: 같은 항목에 대한 두 번째 `issue_complete` 는 다음 중 하나다.
  - `VERSION_CONFLICT`
  - 같은 `request_id` 면 같은 성공 결과
  - 이미 `issued` 면 `INVALID_TRANSITION` (`current_status:'issued'`)

### 9.3 오류 코드 [계약]

| 코드 | 의미 | retryable |
|---|---|---|
| `VALIDATION_FAILED` | 필수값·형식 오류 | false |
| `IDEMPOTENCY_KEY_REUSED` | 같은 요청 id, 다른 본문 | false |
| `QUEUE_CLOSED` | 영업일 종료 또는 접수 중지 | false |
| `TOKEN_INVALID` | 토큰 없음·만료·위조. **존재 여부를 구분하지 않음** | false |
| `RATE_LIMITED` | 요청 한도 초과, `retry_after_seconds` 포함 | true |
| `UNAUTHORIZED` | 직원 코드 불일치 | false |
| `NOT_FOUND` | 직원 요청의 항목 없음 | false |
| `INVALID_TRANSITION` | 전이표에 없는 전이, `current_status` 포함 | false |
| `VERSION_CONFLICT` | 동시 변경, 현재 상태·version 포함 | false (새로고침 후 재판단) |
| `COUNTER_BUSY` / `COUNTER_NOT_OPEN` | 창구 활성 항목 존재 / 창구 정지·종료 | false |
| `QUEUE_EMPTY` | 호출할 대기 없음 | false |
| `LEDGER_NOT_CONFIRMED` | 원장 미확정, `missing` 포함 | true (원장 전송 후) |
| `SERVER_ERROR` | 그 밖의 오류. 내부 메시지는 노출하지 않음 | true |

## 10. 예상시간 계산 [계약 + 제안]

고정 처리량("팀당 3분" 등)은 확정된 적이 없다. 이 계약은 그런 값을 쓰지 않는다.

### 10.1 표본 [계약]

- 정상 처리시간 표본은 `issued` 항목의 `serving_at` → `issued_at` 구간이다.
- 다음은 표본에서 **제외**한다.
  - `held` 를 거친 항목
  - 처리 중 그 창구가 `paused` 였던 구간을 포함하는 항목 (창구 정지 시간이 섞이므로)
  - `cancelled`/`closed`
  - `issue_complete` 가 `LEDGER_NOT_CONFIRMED` 로 한 번 이상 실패한 항목 (원장 장애 시간이 섞이므로)
- 제외 사유는 표본 계산 결과에 집계해 직원 화면에서 확인할 수 있게 한다.

### 10.2 제안값 (근거 구분)

| 항목 | 제안값 | 근거 |
|---|---|---|
| 최소 표본 수 `N_MIN` | 5 | 사분위 범위를 계산할 최소 규모. 그보다 적으면 범위가 우연에 좌우됨 |
| 관측 범위 | 같은 시설의 최근 유효 표본 20건, 최근 7 영업일 이내 | 개장 초기 표본이 적은 것을 보완하면서 오래된 운영 방식을 배제 |
| 이상값 | 30초 미만 또는 표본 중앙값 + 3×MAD 초과 제외 | 30초 미만은 오조작·사후 일괄 처리 가능성. MAD 는 소표본에서 평균·표준편차보다 덜 흔들림 |
| 범위 | 하한은 표본 P25, 상한은 P75 처리시간으로 각각 계산 | 보장값이 아니라 대표 구간 |
| 표시 반올림 | 하한은 1분 내림, 상한은 1분 올림 | 과소 표시 방지 |

이 값들은 실측 데이터가 쌓이면 다시 판단한다 → [결정 요청 C4]

### 10.3 계산 [계약]

**입력**
- 활성 창구 수 `c`: 상태가 `open` 인 창구.
- 각 창구의 남은 작업량: `serving` 항목이면 `max(0, d − 경과)`, `called` 항목이면 `d`, 비어 있으면 0.
- 고객 앞의 `waiting` 팀 목록 (`order_key` 순).

**절차**: 처리시간 `d ∈ {P25, P75}` 각각에 대해 다음을 계산한다.
1. 각 창구의 가용 시각을 남은 작업량으로 둔다.
2. 앞선 `waiting` 팀을 순서대로 가장 빨리 비는 창구에 배정한다. 배정된 창구의 가용 시각에 `d` 를 더한다.
3. 고객의 예상 호출 시각은 그 뒤 가장 빨리 비는 창구의 가용 시각이다.

**결과 상태 `eta.state`**

| state | 조건 | 고객 문구 |
|---|---|---|
| `range` | 정상 | "약 {min}~{max}분 (예상이며 보장 시간이 아닙니다)" |
| `estimating` | 유효 표본 < `N_MIN` | "예상시간 집계 중" |
| `paused` | `c = 0` (모든 창구 `paused`/`closed`) | "발권 일시 중지" |
| `not_applicable` | 자기 상태가 `called`/`serving`/`held`/종료 | 상태 문구만 |

- 응답에 다음을 포함한다: `eta.min_minutes`, `eta.max_minutes`, `eta.sample_count`, `eta.computed_at`(서버 시각).
- 표본 구간 원시값은 고객에게 주지 않는다.

## 11. 고객 조회 토큰과 개인정보 [계약]

- `queue_submit` 은 추측 불가능한 조회 토큰을 돌려준다. 토큰은 128비트 이상 무작위다.
- **[제안 A3]** 토큰 = `base64url(HMAC-SHA256(서버 비밀, entry_id ‖ token_version))`.
  - 재시도·응답 유실 때 같은 토큰을 다시 계산해 돌려줄 수 있다.
  - 저장은 해시만 한다. 비밀은 `private` 스키마나 Vault 에 두고 클라이언트에 노출하지 않는다.
- 번호(`queue_no`)·전화번호·이름만으로 개인 접수 상태를 조회하는 API 는 **없다.**
- 토큰 만료는 해당 영업일 종료 시점이다.
  - 종료 상태가 된 뒤에도 영업일 안에서는 조회할 수 있다. 결과만 보여 준다.
- **[제안]** 요청 제한
  - `queue_my_status`: 토큰당 10초 1회
  - `queue_submit`: 같은 출처당 분당 5회
  - `queue_public_board`: 출처당 5초 1회
  - `TOKEN_INVALID` 연속 실패: 출처당 분당 20회 초과 시 `RATE_LIMITED`
  - 출처 식별은 호스팅이 보증하는 정보만 사용한다 → [결정 요청 B5]
- 고객 응답에는 자기 번호·상태·앞선 팀 수·예상 범위·갱신 시각만 넣는다. 다른 고객의 동의서·이름·전화·자녀·서명은 넣지 않는다.
- 공개 호출판은 번호와 창구만 표시한다.

## 12. 연결 장애 표시 [계약]

- 고객·직원·호출판 화면은 마지막 성공 응답의 `server_time` 을 함께 표시한다.
- 응답의 `stale_after_seconds` 를 넘기면 "연결 확인 중 · 마지막 갱신 HH:MM" 으로 바꾼다. 이때 앞선 팀 수·예상시간을 실시간처럼 강조하지 않는다.
  - **[제안]** `stale_after_seconds` 는 고객 60초, 호출판 30초다.
- 오프라인 상태에서 상태 변경 조작(호출·발권 완료)은 큐에 쌓지 않고 **거절**한다. 직원 상태 전이는 서버 확정이 필요하기 때문이다.

## 13. 감사 기록 [계약]

모든 상태 전이와 창구 상태 변경은 감사 테이블에 다음을 남긴다.
- `entry_ref`, `from`, `to`, `old_order_key`, `new_order_key`
- `actor_kind`(고객/직원/일괄), `device_id`, `device_label`, `counter_id`
- `reason`, `request_id`, 서버 시각

감사 기록은 수정·삭제할 수 없다. 개인정보는 넣지 않는다.

## 14. 결정 요청

**벤 결정**
- B1 `called` → `waiting` 오조작 되돌리기 전이를 둘지
- B2 원장 생성과 발권 완료 전이를 단일 서버 RPC 로 묶을지 (§7). 묶지 않으면 원장의 서버 확정을 확인한 뒤 완료를 호출한다
- B3 직원 개인 식별 없이(공용 코드) 감사 행위자를 단말·창구 수준으로 둘지
- B4 발권 취소 후 재발권을 같은 대기 항목에서 허용할지, 새 접수로만 할지
- B5 요청 제한의 출처 식별 수단과 저장소 (Supabase 측 구현 가능 범위)

**대표 결정**
- C1 영업일 경계와 종료 처리 시각 (운영시간 미정)
- C2 호출 후 응답 대기 시간과 자동 보류 여부
- C3 부재 복귀를 "맨 뒤 합류" 로 운영할지 (초기 정책)
- C4 예상시간 제안값(N_MIN 5, 표본 20건·7영업일, P25~P75)을 실측 후 조정하는 절차

**제안 A1~A3** (단일 접수 RPC, 원장 확정 조건, HMAC 토큰)은 벤 검토 시 함께 확정을 요청한다.

## 15. 다음 단계

1. 이 문서를 첫 커밋으로 제출한다 (판본 v1).
2. 벤 검토 후 아난티에게 판본을 인계한다.
3. 클로이가 `01_봉플레이_운영시스템/tests/queue-contract/` 에 독립 픽스처와 예상시간 시뮬레이션을 추가한다.
4. 구현 인계 후 실제 구현을 이 계약과 대조한다 (`docs/qa/CLAUDE-011_발권대기열_검증.md`).

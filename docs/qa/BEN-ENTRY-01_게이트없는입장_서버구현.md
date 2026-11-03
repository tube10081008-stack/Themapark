# BEN-ENTRY-01 게이트 없는 발권·입장·반납 — 데이터 계약과 서버 구현 (클로이)

- **담당·역할:** 클로이 → 벤. 화면 HTML은 아난티 소관이라 수정하지 않았다.
- **브랜치:** `claude/BEN-ENTRY-01-gateless-entry`
- **기준 커밋:** `claude/CLAUDE-011-queue-followup` `8df36cf5ac705c31d49fe1b12d875d9cfd24f176`
  - 원격 master `892a06143ebe69e64a77761cd5793ab199c9755b`에는 대기열 SQL이 없다. 그래서 최신 대기열 DB 판본 위에 쌓았다.
  - 이 브랜치의 PR은 CLAUDE-011 대기열 커밋을 함께 포함한다. CLAUDE-011이 먼저 통합되면 이 작업분만 남는다.
- **계약 커밋 (아난티 전달용):** `a96b801d7c62c5fcb23b8d11e40050e0f5d2b41b` — `01_봉플레이_운영시스템/database/CONTRACT_gateless_entry.md`
- **하지 않은 것:** 운영 DB SQL 실행, 실제 고객 조회, 실제 알림톡 발송, 배포, 화면 수정

## 1. 조사한 판본 (원격 master만으로 운영본을 대표한다고 보지 않음)

| 판본 | SHA | 확인 내용 |
|---|---|---|
| `origin/master` | `892a061` | `FINAL_SUPABASE_SETUP.sql`의 원장 표, 안전점검 인터록 트리거, `consents_select_restricted`. 대기열 SQL 없음 |
| `claude/CLAUDE-011-queue-followup` | `8df36cf` | 대기열 R4(시설 잠금·포인터·`ORDER_RECORDED`), 서약서 취소 3열, `lookup_family_children` 차단, 설치 묶음·시험 하니스. **기준으로 씀** |
| `antigravity/ANT-006-queue-followup` | `9831bb5` | 매표 화면 흐름 대조: 호출 → 처리 시작 → `createOrder` → `complete_queue_issuance`. 직원 화면이 서약서를 anon으로 직접 읽는 경로 확인 |
| `claude/CLAUDE-011-ticket-queue-contract` (PR [#35](https://github.com/tube10081008-stack/Themapark/pull/35)) | `2ae9e1f` | 열린 PR. `8df36cf`가 이 판을 포함한 후속이다 |
| `aside/20261014-geo-queue-followup`, `aside/GEO-008-ticket-queue-qa` | `5310f65`, `0d3f721` | 실사용 검증 문서. SQL 변경 없음 |
| 운영 DB·벤 로컬 준비본 | 확인 불가 | 이 작업 공간에서 접근할 수 없다. 운영 DB에 대기열 SQL이 이미 적용됐는지도 미확인이다(7절) |

## 2. 변경 파일

| 파일 | 내용 |
|---|---|
| `01_…/database/CONTRACT_gateless_entry.md` | API 계약. 알림 만료 규칙과 복구 경로를 구현에 맞춰 보정했다 |
| `01_…/database/PROPOSED_MIGRATION_visit_entry.sql` (신규) | 표 5개, 내부 헬퍼 7개, 직원 RPC 7개, 작업자 RPC 2개, 호출 알림 트리거, 입장 원장 인터록 트리거, 권한 |
| `01_…/database/test_supabase_install/ORDER` | 대기열·`lookup` 차단 뒤에 이 마이그레이션 추가 |
| `01_…/database/test_supabase_install/60_verify.sql` | V01~V06 점검 추가(표·RLS·표 권한·RPC 권한·작업자 전용·트리거). anon 허용 목록에 직원 RPC 7개 추가 |
| `01_…/database/test_supabase_install/90_reset_visit_entry.sql` (신규) | 이 마이그레이션 객체만 제거. 시험 설치 표시가 없으면 거부 |
| `01_…/database/test_supabase_install/91_reset_all_test.sql` | 새 함수·표를 전체 초기화 목록에 추가 |
| `01_…/tests/queue-contract/supabase-install/run_local_install_check.sh` | E: 대기열 재설치 시 이 마이그레이션 재적용. G: 운영 보호에 `90_reset_visit_entry` 추가. I: 호환 DB에 적용. J: 2회 적용 → 복구 → 재적용 |
| `01_…/tests/queue-contract/visit-entry/` (신규) | 합성 데이터 시험 17건과 README |

기존 함수(`complete_queue_issuance` 등)와 원장 표 정의는 바꾸지 않았다.

## 3. 설계 요점

- **입장 조건:** 입장(`confirm_visit_entry`)은 다음을 **한 트랜잭션·시설 잠금 안에서** 모두 통과해야 한다.
  - 직원 인증, 오늘 대기 행 `processing`, 서약 유효
  - **이 팀의 오늘 뒷번호 일치 기록**
  - **오늘 `decision='pass'` 안전점검** (기존 인터록과 같은 조건, `warn`은 거부)
  - **결제·발권 원장 대사:** `complete_queue_issuance`와 같은 규칙과 같은 오류 코드
  - 뒷번호 일치만으로는 아무것도 쓰지 않는다.
- **원장 간 일치:**
  - 입장 티켓은 주문의 활성 티켓 원장과 1:1이다. `visit_entry_tickets.ticket_id`는 기본키라 한 티켓은 한 번만 입장한다.
  - `visit_entries`는 대기 1건·주문 1건당 1행(고유 제약)이다.
  - 결제·발권 원장은 읽기만 한다.
- **멱등:** 변경 RPC는 `request_id`별 성공 응답을 저장해 재생한다. 같은 업무 키(같은 팀·주문·티켓)로 다른 단말이 처리하면 `already_entered`이고, 반납은 티켓 단위 상태로 중복을 막는다.
- **인원 정의:**
  - 누적 방문 = 입장 티켓 수 (반납해도 줄지 않음)
  - 현재 체류 = 입장 − 반납 (그 영업일 입장분)
  - 퇴장 = 반납 수
  - 지난 영업일 미반납과 입장 뒤 환불은 별도 항목이고, 체류에서 빼거나 더하지 않는다.
- **호출 알림:**
  - 대기열 표 트리거가 발송 원장에 기록한다. 기록 실패는 경고만 남기고 호출은 성공한다.
  - 발송은 `service_role` 작업자가 수령·보고한다.
  - 중복 발송 방지: 60초 억제, 하루 3건 상한, 새 재호출이 이전 미발송을 대체, 임대 만료·불명은 재발송하지 않음.
  - 발송 결과는 대기열을 바꾸지 않는다.
- **호환 거울:** 구 대시보드·분석용으로 `safety_consents.entry_at/exit_at/stay_duration_minutes`를 **비어 있을 때만, 오늘 접수분만** 채운다.

## 4. 적용 순서

1. 기존 설치 묶음 순서대로: `FINAL_SUPABASE_SETUP.sql` → `PROPOSED_MIGRATION_safety_consents_cancellation.sql` → `PROPOSED_MIGRATION_ticket_queue.sql` → `PROPOSED_MIGRATION_lookup_family_children_revoke.sql`
2. `PROPOSED_MIGRATION_visit_entry.sql` (다시 실행해도 안전)
3. 적용 후 `test_supabase_install/60_verify.sql` 실행 → FAIL 0건 확인 (V01~V06 포함)
4. **주의:** 대기열 SQL을 다시 설치(`ticket_queue` 표를 지우고 다시 만듦)하면 알림 트리거가 사라진다. 그 뒤 2를 다시 실행한다. 60_verify V06이 이를 검출한다.

## 5. 호환 기간

- **새 화면 배포 전:** 기존 흐름(`complete_queue_issuance`, 구 게이트 화면, 바우처 QR)이 그대로 동작한다. 새 표에는 기록되지 않는다.
- **전환 중:**
  - 구 경로로 이미 `issued`된 팀도 같은 주문으로 `confirm_visit_entry`를 부르면 입장 기록이 생긴다. 대기 행은 바꾸지 않는다(V11).
  - 같은 날 구 게이트와 새 반납을 섞어 쓰면 `safety_consents.exit_at`과 `visit_entries` 상태가 서로 다를 수 있다. 전환일에는 한쪽만 쓰도록 벤이 날짜를 정해야 한다.
- **전환 후:** 구 게이트 화면과 바우처 QR 안내는 아난티 작업에서 제거한다. `pass_code`·`entry_at`·`exit_at` 열은 과거 기록 보존을 위해 지우지 않는다.

## 6. 실패 시 복구

- **마이그레이션 적용 중 오류:** 파일 단위 트랜잭션이 아니므로 오류 위치까지 일부 객체가 생길 수 있다. 원인 수정 후 같은 파일을 다시 실행하면 된다(멱등).
- **기능을 되돌릴 때:** `90_reset_visit_entry.sql`과 같은 순서로 입장 객체만 지운다. 시험 프로젝트 전용 보호가 있으므로, 운영에서는 관리자 승인 후 같은 순서를 수동으로 실행한다.
  - 지우기 전에 `visit_entries`·`visit_entry_tickets`·`queue_call_notifications`를 내보내 보관한다.
  - 서약서·주문·결제·티켓·대기열 표는 그대로 남는다(J단계에서 행 수 유지 확인).
  - 이미 `confirm_visit_entry`로 `issued`된 대기 행은 기존 발권 완료와 같은 상태로 남는다. 되돌릴 필요가 없다.
- **화면만 되돌릴 때:** DB는 그대로 두고 기존 `complete_queue_issuance` 흐름으로 돌아가면 된다. 새 RPC를 부르지 않으면 새 표는 쓰이지 않는다. 알림 원장은 계속 쌓이지만 발송 작업자가 없으면 아무것도 나가지 않는다.

## 7. 검증 결과 (Linux, PostgreSQL 16, PostgREST 12.2.3, Node 22, 합성 자료)

| 실행 | 결과 |
|---|---|
| `visit-entry/visit-entry.test.mjs` (V01~V17) | **17/17 통과**, 3회 반복 모두 통과 |
| `run_local_install_check.sh` (A~J) | **전체 통과**: 60_verify FAIL 0건(설치·재설치·FINAL 재실행·대기열 재설치·전체 초기화 후·호환 DB·2회 적용·복구 후 재적용). HTTP H01~H08 통과, 운영 보호 8건 거부 확인 |
| `stale-desk/past-day-desk.test.mjs` (새 묶음) | 16 통과, 1 건너뜀. 건너뛴 M1은 FAKETIME 스택 전용이며 이번에 실행하지 않았다 |
| `anon-exposure/lookup-family.test.mjs` (새 묶음) | 4/4 통과 |
| `ant006-conformance/*` (PGlite 0.4.6 + 로컬 PG) | 67/68 통과. 실패 1건 `customer token expires after its business day`는 CLAUDE-011 때 이미 따로 기록한 **기존 실패**다. 이 시험은 새 마이그레이션을 불러오지 않는다 |
| PostgREST HTTP 직접 확인 | `get_visit_occupancy` 암호 있음 → 응답, 틀린 암호 → `UNAUTHORIZED_STAFF`. anon의 `claim_queue_call_notifications`·`visit_entries` 직접 조회 → 401 |

## 8. 미검증·미확인 사항

- **실제 Supabase(호스팅) 적용:** 하지 않음. 로컬 모사만 검증했다.
- **운영 DB 현황:** 대기열 SQL과 취소 3열이 이미 적용됐는지 확인할 수 없다. 적용 순서 1이 운영에 반영됐는지 벤이 먼저 확인해야 한다.
- **화면 연동:** 아난티 작업 전이라 실제 매표 화면으로 E2E를 하지 않았다. 계약 7절 체크리스트를 기준으로 한다.
- **알림톡:** 공급사, 승인 템플릿, 발신 프로필, 인증정보가 없다. 발송 작업자는 구현하지 않았고 **실제 발송은 미완료**다. 모의 작업자 시험만 했다.
- **자정 통과(FAKETIME) 시험:** 입장·반납은 실행하지 않았다. 지난 영업일 동작은 날짜를 하루 앞당긴 행으로만 봤다(V10).
- **Windows·다른 Node/PG 판본:** 미실행

## 9. 벤 결정이 필요한 사항

1. **기존 개인정보 노출 (이번 작업에서 바꾸지 않음):**
   - 내용: `consents_select_restricted` 정책 때문에 anon 키만으로 **오늘 접수 서약서의 보호자 이름·전화번호·자녀 정보를 직접 조회**할 수 있다. 로컬 PostgREST에서 합성 자료로 재현했다.
   - 영향: 매표 데스크·비상 화면·구 게이트·`bongplay-sync.js`가 이 직접 조회를 쓰므로 정책만 닫으면 화면이 깨진다.
   - 필요 조치: 직원 화면을 직원 인증 RPC로 바꾸는 아난티 작업과 정책 차단 마이그레이션을 함께 배정해야 한다.
2. **팔찌 번호:** 계약은 "팔찌 1개 = 티켓 1장"이고 반납을 티켓 단위로 지정한다. 실제 팔찌에 번호가 없으면 화면이 사람(티켓) 목록에서 고르게 해야 한다. 팔찌 실물 방식 확인이 필요하다.
3. **환불 뒤 입장 처리:** 입장 뒤 환불은 입장 기록을 보존하고 참고값으로만 집계한다. "입장 기록 무효화" 기능은 만들지 않았다. 필요하면 조건(반납 여부, 사유, 권한)을 정해 주어야 한다.
4. **전환일:** 구 게이트와 새 반납을 같은 날 섞지 않도록 전환일을 정해 주어야 한다.
5. **뒷번호 잠금 기준:** 연속 5회 불일치 시 10분 잠금으로 정했다. 운영 기준이 따로 있으면 정해 주어야 한다.
6. **알림 정책:** 60초 억제, 하루 3건, 15분 경과 시 미발송으로 정했다. 공급사 선정과 템플릿 승인 후 작업자 배정이 필요하다.
7. **안전점검 인터록:** 기존 조건 그대로다(시설 구분 없이 오늘 PASS 1건). 다시설 운영 시 시설별로 볼지 정해 주어야 한다.

## 10. 소요 시간

지시 수신 03:29 UTC부터 이 보고서 작성까지 세션 기록 기준 약 25분. 계약 커밋은 수신 후 약 9분에 했다.

## 11. 반납 계약 검토 — 미정산 차단 (2026-11-03 추가 지시)

### 11.1 기존 원장 확인 결과

- **서버가 판정할 수 있는 원장이 있다.**
  - `order_items`(품목·금액·취소 상태)와 `order_payments`(결제·취소 상태)는 `order_id`로 묶인다.
  - 방문과의 연결은 두 경로다.
    - 매표 주문: `consent_id`
    - 매점 POS 방문 연동 주문: `visit_id`. `operations.html`(`9831bb5`)이 서약서 `visit_id` 또는 서약서 id를 넣는다.
- **실제로 생기는 미정산 상태:**
  - 매표 `createOrder`(`bongplay-id.js`, `9831bb5`)는 품목과 결제를 **따로 업서트**한다(아웃박스).
  - 그래서 품목만 도착하거나 결제만 도착한 상태가 서버에 남을 수 있다.
  - 환불 처리 중 품목·결제 중 한쪽만 취소된 상태도 원장에 남는다.
- **후불·초과요금 원장은 없다:** 카탈로그·계약·SQL 어디에도 후불, 초과 이용 요금, 팔찌 배상 품목이 없다. 모든 주문은 그 자리에서 결제하는 구조다.

### 11.2 반영 (운영 DB 미적용)

- **판정 헬퍼:** `private.visit_unsettled_orders(consent_id)`를 추가했다.
  - 대상: 방문에 연결된 주문별 활성 품목 금액과 유효 결제 합계의 차이
  - `balance > 0`: 받을 돈, `balance < 0`: 돌려줄 돈
- **반납 차단:** `return_visit_wristbands`가 **시설 잠금 안, 반납을 쓰기 직전, 같은 트랜잭션에서** 이 헬퍼로 원장을 다시 읽는다.
  - 미정산이면 `UNSETTLED_ORDERS`(주문 목록 포함)를 돌려주고 아무것도 쓰지 않는다.
  - 실패는 저장하지 않으므로, 정산을 기록한 뒤 같은 `request_id`로 다시 보내면 새로 판정된다.
- **조회 표시:** `search_visit_entries`·`get_visit_entry` 응답에 서버 계산 `settlement`를 추가했다.
  - 화면 안내용이며, 허용 근거는 아니다(계약 E4). 화면에서만 검사한 상태를 서버 통과로 쓰지 않는다.
- **시험:**
  - V09: 전액 환불을 화면 `cancelOrder`와 같이 품목·결제·티켓 동시 취소로 바꿨다. 0/0 정산 완료라 반납이 가능하다.
  - V18 추가: 결제 없음, 부분 결제, 돌려줄 돈, 매표 결제 취소, 방문 미연결 주문 무영향, 정산 후 같은 `request_id` 통과, 차단 시 행·버전·거울 불변

### 11.3 검증 (로컬 PostgreSQL 16 + PostgREST, 합성 자료)

| 실행 | 결과 |
|---|---|
| `visit-entry` V01~V18 | 18/18 통과, 3회 반복 모두 통과 |
| `run_local_install_check.sh` A~J | 전체 통과 (60_verify P04: 새 private 함수 anon 실행 권한 없음 포함) |
| `stale-desk` | 16 통과, 1 건너뜀 (M1 FAKETIME 전용, 미실행) |

### 11.4 결정 사항 (서버가 볼 원장이 없는 항목 — 화면 검사로 대신하지 않음)

| # | 항목 | 정해야 할 것 | 기록할 원장 (제안) |
|---|---|---|---|
| D1 | 초과 이용 요금 (기본권 2시간 초과) | 받는지 여부, 단위(분)·금액, 종합권·단체 적용 여부. 인계문의 "16시 이후 동일 요금"과의 관계 | 반납 전에 `order_items`에 새 품목 id(예: 초과이용, 범주 `addon`)를 방문 연동(`consent_id` 또는 `visit_id`)으로 기록하고 `order_payments`에 결제를 기록한다. 그러면 E6 7번이 자동으로 판정한다. 가격 계약(`site_profile.json`)에도 확정 항목으로 추가해야 한다 |
| D2 | 팔찌 분실·파손 배상 | 금액, 면제 조건 | D1과 같은 방식(새 품목 id) |
| D3 | 방문 미연결 매점 결제 | 체류 중 매점 구매를 반드시 방문에 연동할지 | 연동하면 `order_items.visit_id`가 채워져 판정 대상이 된다. 연동하지 않으면 판정 대상이 아니다(현재) |
| D4 | 서버 미도착 아웃박스 건 | 품목·결제 원자 저장 RPC를 도입할지 (아난티·클로이 별도 작업) | 도입 전에는 서버가 볼 수 없다. 화면의 "저장 대기 0건" 확인은 보조 안내일 뿐 서버 통과로 보지 않는다 |
| D5 | 비상 퇴장 예외 | 미정산이어도 퇴장 기록을 허용할 상황·권한·사유 기록 방식 | 현재 예외 없음. 필요하면 관리자 권한 RPC와 사유를 별도 원장에 남기는 방식으로 설계 |
| D6 | 돌려줄 돈(`balance < 0`) 차단 | 환불 미처리 상태에서 퇴장을 막을지 | 현재는 막는다. 허용하려면 계약 E6 7번을 `balance > 0`만으로 바꾼다 |

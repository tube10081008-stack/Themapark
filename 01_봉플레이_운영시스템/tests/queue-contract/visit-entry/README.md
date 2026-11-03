# 게이트 없는 발권·입장·반납 (BEN-ENTRY-01, 실제 PostgreSQL 경합 계층)

계약: `database/CONTRACT_gateless_entry.md`. 구현: `database/PROPOSED_MIGRATION_visit_entry.sql`.
단언은 계약 기준이고, 실패는 계약 위반 검출을 뜻한다. 자료는 모두 `SYN-` 합성 값이다.

## 계층

- desk-e2e 일회용 스택을 그대로 쓴다: PostgreSQL 16, Supabase 모사, 설치 묶음(ORDER, 이 마이그레이션 포함), PostgREST.
- **호출 경로:**
  - 직원 RPC: `authenticator` → `anon` 역할 → `request.headers`. PostgREST 요청과 같다.
  - 발송 작업자 RPC: `service_role`.
- **결정적 경합:** 연결 1이 트랜잭션을 열어 둔 채 RPC를 실행한다. 연결 2가 잠금을 기다리는지 본 뒤 연결 1을 커밋한다.
- **원장 쓰기:** 결제·티켓 원장은 관리자 연결로 직접 쓴다. 화면 `createOrder`와 같은 소속·수량 구조다.
- **실제 알림 발송 없음:** 작업자는 모의다. 공급사 연결이 없다.

| 시험 | 확인 내용 |
|---|---|
| V01 | 정상 동선: 뒷번호 불일치 응답에 정답 없음, 불일치 상태 입장 거부, 일치 후 확정. 결제·발권 원장 xmin 불변, 대기열 issued, 서약서 빈 `entry_at`만 채움, 인원 집계 |
| V02 | 거부 시 아무것도 쓰지 않음. 대상: 처리 전 상태, 미정산, 부분 결제, 티켓 누락, 품목 취소, 다른 팀 주문, 수량 불일치, 안전점검 없음·`warn`, 서약 취소, 입력 오류 |
| V03 | 같은 `request_id` 재생(티켓 순서 무관), 입력 다르면 `REQUEST_ID_CONFLICT`, 다른 `request_id`는 `already_entered`, 다른 주문은 `ENTRY_EXISTS_OTHER_ORDER`. 입장 1건 |
| V04 | 두 단말 동시 확정: 두 번째가 잠금을 기다린 뒤 `already_entered`. 입장 1건 |
| V05 | 매점 단독 주문 확정 거부(`ORDER_TICKET_ITEMS_EMPTY`). 입장권+매점 혼합 주문은 입장권 수만큼. 체류 중 매점 구매·서약 없는 매점 손님은 인원 불변 |
| V06 | 부분 반납, 같은 요청 재생, 중복 반납 거부, 섞인 요청은 하나도 반영 안 함, 대상 오류 3종, 전체 반납, 재전체 반납 `already_exited`. 누적·체류·퇴장 정의, 서약서 `exit_at`, 퇴장 후 재입장 불가 |
| V07 | 두 단말 같은 팔찌 동시 반납: 하나만 반영 |
| V08 | 같은 뒷번호 두 팀: 검색 두 건. 응답에 전화번호·실명·consent_id 없음. 한 팀 반납이 다른 팀에 영향 없음 |
| V09 | 입장 뒤 전액 환불(품목·결제·티켓 함께 취소): 입장 기록 불변, 체류 유지, `refunded_after_entry_visitors`, 정산 완료(0/0)라 반납 가능 |
| V10 | 지난 영업일 미반납: 기본 검색·현재 체류에서 빠지고 옵션·`past_unreturned_visitors`로만 보임. 반납 가능. 같은 가족 재방문은 새 입장, 지난 대기표 확정은 `PAST_QUEUE_DATE` |
| V11 | 호환: 구 `complete_queue_issuance`로 발권된 팀도 같은 주문으로 입장. 다른 주문은 거부, 대기 행 불변 |
| V12 | 운영 암호 없이 직원 RPC 7종 `UNAUTHORIZED_STAFF`. anon 표 직접 조회 5종 `42501`, 작업자 RPC anon 실행 `42501` |
| V13 | 뒷번호 연속 5회 불일치 시 정답도 잠금, 10분 뒤 해제. 형식·없는 팀 오류 |
| V14 | 호출 알림 1건, 60초 안 재호출 억제, 재시도 가능 실패 → 대기 → 재수령, 같은 수령 재보고 `duplicate`, 옛 수령 `STALE_CLAIM`, 발송 후 재수령 없음. 대기열 불변·다음 팀 waiting 유지, 임대 만료 `unknown`, 팀 취소 시 `expired`, 직원 조회에 전화번호 없음 |
| V15 | 알림 원장 기록이 실패해도 호출은 성공 |
| V16 | 연결 6개 × 15회 확정·반납·검색 혼합: SQL 오류·교착 0, 원장 간 일치(티켓 수·상태·주문 소속), 집계 = 원장 |
| V17 | 60초 뒤 재호출: 새 알림만 발송, 이전 미발송 `expired`, 불명은 재발송 안 함, 하루 4번째부터 억제 |
| V18 | 대표 결정 차단 범위. 방문 연동 매점 단독 주문 미결제 4,000은 막지 않고 표시에도 없음. 입장권 주문 받을 돈 18,000은 `UNSETTLED_TICKET_ORDER`(금액 36,000/0/18,000/18,000, 귀속 ticket), 차단 시 체류 불변. 결제 기록 후 같은 `request_id`로 통과. 인원 2/1/1 → 2/0/2 |
| V19 | 혼합 주문(입장권 36,000 + 매점 4,000, 결제 38,000): 귀속 `undeterminable`, 배분 값 없이 차단·`attribution_undeterminable`. 입장권 환불 뒤 매점 몫 4,000만 남으면 `other_due`로 표시하고 막지 않음 |
| V20 | 돌려줄 돈 3,000: 반납 허용·`refund_completed:false`·후속 확인 1건(두 번째 반납도 같은 건). 메모만으로 처리 시 `FOLLOWUP_LEDGER_NOT_SETTLED(-3000)`, 결제 취소 기록 뒤 처리, 재생·중복 처리 |
| V21 | 비상 대피(안전점검 기록 없음): 대피 시점 명단 5팀 9명(대피 전 반납 1명 제외, 대피 뒤 반납 1명 포함), 퇴장 처리 8명, 받을 돈 18,000·돌려줄 돈 2,000 후속 확인, 원장 xmin 불변. 인원 10/0/10·대피 8·미처리 2, 재생·같은 시각 `already_recorded`, 대피 뒤 일반 반납 `already_exited`. 받을 돈은 결제 기록 뒤에만 처리 |

## 실행

```sh
PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/visit-entry/visit-entry.test.mjs
```

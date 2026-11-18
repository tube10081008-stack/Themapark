# 전날 미정리 팀·창구 점유 포인터 (CLAUDE-011 R4, 실제 PostgreSQL 경합 계층)

계약: `database/CONTRACT_ticket_queue_past_day.md`. 단언은 계약 기준이고, 실패는 계약 위반 검출을 뜻한다.

## 계층

- desk-e2e 의 일회용 스택을 그대로 쓴다: PostgreSQL 16, Supabase 모사, 설치 묶음(ORDER), PostgREST.
- RPC 는 PostgREST 와 같은 경로로 부른다: `authenticator` 접속 → `anon` 역할 → `request.headers`(x-forwarded-for).
- C5 는 실제 PostgREST HTTP 로 부른다.
- 결정적 경합: 연결 1 이 트랜잭션을 열어 둔 채 RPC 를 실행하고, 연결 2 가 잠금을 기다리는지 본 뒤 연결 1 을 커밋한다.
- "전날" 행은 오늘 RPC 로 만든 행의 날짜·시각을 관리자 연결로 하루 앞당겨 만든다.
  - M1 만은 서버 시계를 libfaketime 으로 실제 자정 너머로 옮긴다.
- 원장 행은 관리자 연결로 직접 쓴다. 화면 발권은 desk-e2e 가 본다. 자료는 모두 `SYN-` 합성 값이다.

| 시험 | 확인 내용 |
|---|---|
| P1/P2 | 전날 처리 중 팀·포인터가 있어도 오늘 호출은 된다 (`replaced_pointer`). 전날 행·원장은 그대로이고, 목록의 `past_unresolved_teams` 에 기록된 주문·허용 동작이 나온다 |
| R1 | 직원 목록 조회 5회 전후로 표 7개의 행·xmin 이 같다 (숨은 쓰기 없음). `stale`(past_day·inactive)·`missing` 보고 |
| P5 | 전날 팀 재호출·처리 시작·보류·복귀 → `PAST_QUEUE_DATE`, 변경 없음 |
| P6 | 원장 있는 전날 팀: 취소는 `ORDER_RECORDED`, 다른 주문 id 완료는 거부, 같은 주문 id 완료는 성공·멱등. 원장과 오늘 포인터는 그대로 |
| P6b | 원장 없는 전날 팀: 명시적 취소만 허용 |
| P6c | **오늘** 팀, 원장 전부·일부(품목만·결제만·티켓만·품목+결제): 대기열 단독 취소 `ORDER_RECORDED`, 일부 원장 완료 거부, 표 불변 (R4 보완) |
| P6d | **전날** 팀, 일부 원장: 기록된 주문으로 보고, 취소 `ORDER_RECORDED`, 완료 거부 → 환불 뒤 취소 허용 |
| P6e | 오늘 팀: 환불(원장 전부 취소) 뒤에는 취소 허용 |
| X1 | 다른 시설 `p_site_id` 로 이 시설 대기 id 를 다루는 직원 RPC 7종 → `not_found`/`empty_queue`, 대기열·원장 불변. 목록·창구·고객 조회는 시설 범위. 미등록 시설은 `UNAUTHORIZED_STAFF` |
| X2 | 다른 시설 서약서로 접수 → `CONSENT_SITE_MISMATCH` (재시도 불가), 자기 시설 접수는 정상 |
| C1 | 같은 창구 동시 호출(전날 포인터 있음): 하나만 성공, 다른 쪽은 `DESK_ALREADY_OCCUPIED` + `occupant` |
| C2 | 창구 이동(처리 시작 `p_desk_no`)과 그 창구 호출의 경합 (두 순서): 한 창구에 두 팀이 생기지 않고, 포인터가 이동을 따른다 |
| C3 | 정지와 호출의 경합 (두 순서): 먼저 커밋된 정지가 이기고, 먼저 시작된 호출은 끝난다 |
| C4 | 전날 팀 완료와 오늘 호출의 경합 (두 순서): 둘 다 성공하고 포인터는 오늘 팀 |
| C5 | PostgREST HTTP 동시 호출 10회 × 2건: 매번 정확히 하나 성공 |
| S1 | 연결 8개 × 40회 혼합 동작: SQL 오류·교착 0, 매 회 불변식 유지, 원장·전날 팀 불변, 모든 변경 동작이 1회 이상 성공 |
| M1 | 실제 자정 통과 (FAKETIME 스택만): KST 23:59 처리 중 팀이 00:00 뒤 과거 미정리로 나오고, 새날 첫 호출을 막지 않으며, 같은 주문으로 완료된다 |

## 실행

```sh
PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/stale-desk/past-day-desk.test.mjs
bash …/desk_e2e_stack.sh stop
# M1 (실제 자정 통과): FAKETIME_AT='2026-10-16 14:59:40' 를 붙여 start (UTC, KST 23:59:40) 후 같은 명령
# 기존 판 대조: DB_ROOT=<다른 판 database 폴더> 를 붙여 start
```

이 계층이 확인하지 못하는 것: 실제 Supabase 프로젝트(호스팅 PostgREST·게이트웨이), 네트워크 지연, 화면 동작.

# 매표 발권 E2E (CLAUDE-011, 실제 DB 계약 계층)

실제 매표 화면(`pages/consent-desk.html`)으로 발권한다. 그 결과 주문·결제·티켓·대기열 완료·서약서 발권 상태가 **실제 DB 계약에 정확히 한 번 저장되는지** 확인하는 시험이다.

## 다른 계층과의 차이

| 계층 | 화면 | 서버 |
|---|---|---|
| `frontend-contract/` | 실제 화면 | **모의** PostgREST (RPC·쓰기 규칙을 흉내) |
| `supabase-install/verify_http.mjs` | 없음 (HTTP 직접 호출) | 실제 DB 계약 + PostgREST |
| **`desk-e2e/` (이 폴더)** | **실제 화면** | **실제 DB 계약(설치 묶음) + 실제 PostgREST** |

HTTP 시험(H01~H07)이 통과해도 화면 발권이 정상이라는 뜻은 아니다. 화면이 실제로 보내는 열·순서·재시도를 이 계층에서 본다.

## 구성

| 파일 | 내용 |
|---|---|
| `desk_e2e_stack.sh` | 일회용 PostgreSQL → Supabase 플랫폼 모사 → 설치 묶음 → PostgREST. `EXTRA_SQL` 로 변경안 SQL 을 덧붙여 효과를 비교할 수 있다 (설치 묶음 자체는 바꾸지 않음) |
| `harness.mjs` | 정적 파일 + `config.template.js`(접속값만 치환) + `/rest/v1` → PostgREST 전달 프록시 (장애 주입·요청 기록), 관리자 DB 연결로 결과 확인 |
| `desk-issuance.test.mjs` | E0~E13 (아래 표) |

| 시험 | 확인 내용 |
|---|---|
| E0 | 정상 발권: 주문·결제·티켓·대기열 완료·서약서 발권 상태가 모두 서버에 저장. 서약서 `status` 는 `active` (R2: active/cancelled 만, 발권은 `is_issued`) |
| E1 | 서버에 오늘 PASS 가 없고 단말 기록만 있으면 판매를 시작하지 않음 |
| E2 | 티켓 원장 일부 실패 → 같은 창에서 재시도: 주문 1·결제 1·대기열 완료 |
| E3 | 완료 응답 유실 → 재시도: 같은 주문 재사용 |
| E4 | 주문 품목 저장 응답 유실: 중복 없음 |
| E5 | 부분 실패 뒤 결제 창을 닫고 목록에서 다시 열어 결제: 주문 1·결제 1 |
| E6 | 같은 IP 다른 단말의 틀린 암호 20회 뒤에도 정상 단말 발권 — **알려진 제한**(C3 미적용 결정). node:test `todo` 로 표시해 실패 수에 넣지 않는다 |
| E7 | 원장 쓰기 열이 DB 와 일치, 서약서 저장에 DB 에 없는 중요 열 없음 |
| E8 | 부분 실패 뒤 새로고침하고 다시 결제: 주문 1·결제 1 |
| E9 | 창구에 호출된 팀과 다른 서약서 결제는 판매 쓰기 전에 거부 |
| E9b | 호출되지 않은 대기 팀을 바로 발권: 진입 차단 또는 대기열 완료까지. 결제만 남고 대기열이 남으면 실패 |
| E10 | 예전에 취소된 서약서를 발권하면 서버의 `status='active'`, `cancelled_at`·`cancel_reason` null (취소 3열 없는 DB 에서는 건너뜀) |
| E11 | 서버에서 직원 암호가 바뀐 뒤 화면이 옛 암호 반복 요청을 멈추고 재인증을 안내 (30초 동안 서버 인증 실패 3건 이하) |
| E12 | 원장(주문·결제·티켓) 저장 직후 서버 암호가 바뀌어 완료가 `UNAUTHORIZED_STAFF` → 재인증 → 직원이 같은 팀을 다시 확정하면 **처음 저장한 order_id** 로 완료, 주문·결제 1건 |
| E13a | 결제 저장 중 단말이 실제로 오프라인(Chromium 네트워크 차단) → 복귀 뒤 재시도: 주문 1·결제 1·대기열 완료 |
| E13b | 판매 중 실제 API 서버(PostgREST 프로세스) 정지 → 재기동 뒤 재시도: 주문 1·결제 1 |
| E13c | 완료 RPC 를 서버가 커밋한 뒤 TCP 연결 끊김(응답 없음): 중복 없이 복구 (브라우저 자동 재전송 포함) |
| E13d | 주문 품목 저장을 서버가 커밋한 뒤 TCP 연결 끊김: 중복 행 없이 복구 |

목록에서 고르는 경우(E5·E8·E9·E9b)는 직원이 누르는 [발권] 버튼과 같은 `toggleTicketIssue(id, true)` 로 결제 창을 연다.

**프록시 장애 모드**
- `503`: 서버에 보내지 않는다.
- `lost`: 서버가 처리(커밋)한 뒤 응답만 503 으로 바꾼다.
- `hook`: 전달 직전에 시험 동작을 실행한다 (서버 암호 교체, API 서버 정지, 단말 오프라인 전환). `'drop'` 을 돌려주면 보내지 않고 끊는다.
- `drop`: 서버에 보내지 않고 연결을 끊는다 (응답 없음).
- `reset`: 서버가 처리(커밋)한 뒤 응답 대신 연결을 끊는다 (실제 TCP 끊김).

**단말 시간대**: 화면은 오늘 날짜를 단말 시간대로 계산한다(`BongplaySync.toLocalDateStr`). 현장 단말과 같게 시험 브라우저를 `Asia/Seoul` 로 둔다. 컨테이너 기본 UTC 로 두면 KST 00:00~09:00 에 화면의 '오늘'이 전날이 되어 서버 PASS 점검을 찾지 못한다.

**실제 자정 통과**: `FAKETIME_AT='<UTC 시각>'` 을 붙여 start 하면 PostgreSQL 서버 시계가 libfaketime 을 따른다. `stale-desk/` 의 M1 이 이 스택을 쓴다 (화면 E2E 에는 쓰지 않음).

**직원 로그인**
- `config.js` 의 실제 인증 창에 시험 암호를 넣어 서버(`verify_staff_access`)로 검증받는다.
- 모든 요청에 `X-Forwarded-For: 203.0.113.10`(문서용 예약 대역)을 붙여, 현장 공유기 뒤 단말을 흉내 낸다.

## 실행

```sh
PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env ANT006_ROOT=<화면 체크아웃> PG_DIR=<pg 모듈> PW_DIR=<playwright 모듈> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk-issuance.test.mjs
bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh stop
# 변경안 비교: EXTRA_SQL="<SQL 파일 경로>" 를 붙여 start
```

- 운영 DB·Supabase 에 접속하지 않는다. 로컬이 아닌 DB 는 거부한다.
- 시험 암호·JWT 비밀은 실행마다 새로 만드는 합성 값이다. 자료는 모두 `SYN-` 합성 값이다.

**시험 도구 주의**: 긴 비동기 화면 동작(호출·처리 시작·결제 확정·목록 진입)을 `page.evaluate` 안에서 기다리면, playwright 가 가끔 "Execution context was destroyed" 를 낸다. 이때 페이지 이동·재적재는 없고 화면 상태도 유지된다. 그래서 `pageAsync()` 로 동작을 한 번만 시작하고 결과는 짧은 조회로 기다린다. 동작을 다시 실행하지는 않는다.

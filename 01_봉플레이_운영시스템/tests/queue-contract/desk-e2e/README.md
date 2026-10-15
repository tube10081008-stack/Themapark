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
| `desk-issuance.test.mjs` | E0~E7 |

**프록시 장애 모드**
- `503`: 서버에 보내지 않는다.
- `lost`: 서버가 처리(커밋)한 뒤 응답만 503 으로 바꾼다.

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

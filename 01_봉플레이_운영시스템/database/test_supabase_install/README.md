# 빈 시험 Supabase 설치 묶음 (CLAUDE-011)

새로 만든 **빈 시험 Supabase 프로젝트**에 봉플레이 기본 스키마와 발권 대기열을 설치하는 순서다. 검증과 초기화 방법도 함께 적는다.

- 운영 프로젝트에는 실행하지 않는다. `00_preflight.sql` 이 운영 흔적을 보면 중단한다.
- 운영 데이터·운영 비밀값은 들어 있지 않다. 시험 자료는 모두 `SYN-` 로 시작하는 합성 값이다.

## 1. 설치 순서

SQL Editor 에서 파일 하나씩 전체를 붙여넣고 **Run** 한다. 각 단계는 여러 번 실행해도 안전하다.

| 순서 | 파일 | 하는 일 | 필수 |
|---|---|---|---|
| 1 | `test_supabase_install/00_preflight.sql` | 빈 시험 프로젝트인지 확인하고 시험 설치 표시(`install_target = synthetic_test`)를 남긴다 | ✅ |
| 2 | `FINAL_SUPABASE_SETUP.sql` (저장소 `database/`) | 기본 스키마 30개 표 전체 | ✅ |
| 3 | `PROPOSED_MIGRATION_ticket_queue.sql` (저장소 `database/`) | 대기열 표 3개, RPC 12개, 잠금·권한 이중화 | ✅ |
| 4 | `test_supabase_install/40_test_staff_code.sql` | 시험 전용 운영자 암호 등록 | ✅ |
| 5 | `test_supabase_install/50_synthetic_seed.sql` | 오늘(KST) 안전점검 PASS 1건, 합성 서약서 3건 | ✅ (시험하는 날마다) |
| 6 | `test_supabase_install/60_verify.sql` | 구조·권한 점검 (읽기 전용) | ✅ |

**2단계 FINAL 이 만드는 것**
- 서약서·주문 품목·결제·티켓 원장·안전점검 등 표와 RLS 정책
- DELETE 권한 회수
- `pgcrypto`(extensions 스키마)
- 직원 인증: `private.verify_access_code`, bcrypt, IP 잠금
- 공개 RPC 4개, 안전 인터록 트리거, Realtime 등록
- `PATCH_r3_to_r4.sql`·`PATCH_survey_v2.sql` 의 내용은 이미 FINAL 에 들어 있어 따로 실행하지 않는다.

**3단계 대기열 SQL 의 권한 이중화**
- Supabase 는 public 스키마에 새로 만든 표·함수에 `anon`·`authenticated` 권한을 기본으로 준다.
- 대기열 SQL 끝의 5) 절이 대기열 표의 직접 권한과 내부 함수의 PUBLIC 실행 권한을 회수한다.
- 기본 권한을 끄거나 바꾸는 별도 설정은 필요 없다.

**4단계 시험 운영자 암호**
- 파일 안의 `__TEST_ONLY_STAFF_CODE__` 를 6자 이상의 **시험 전용 값**으로 바꿔 실행한다.
- 운영 암호를 재사용하지 않는다. 바꾼 파일은 커밋하지 않는다.

**5단계 오늘 PASS 점검**
- FINAL 의 안전 인터록 때문에, 오늘 PASS 점검이 없으면 주문·결제·발권 원장 쓰기가 `SAFETY_INTERLOCK_BLOCKED` 로 거부된다.

**6단계 결과 판정**
- 결과 표에 `level = FAIL` 이면서 `ok = false` 인 행이 없어야 한다.
- `WARN` 은 참고 항목이다 (pg_cron 없음, TRUNCATE 권한 — §3 참고).

**순서 주의**
- FINAL 은 실행할 때마다 public 스키마의 **모든 RLS 정책을 지우고 다시 만든다**.
- 그래서 설치 뒤 FINAL 을 다시 실행했다면 대기열 SQL 도 다시 실행한다. 대기열 표는 정책이 지워져도 RLS 와 표 권한 회수로 계속 막혀 있다.

## 2. 기능 검증 (HTTP)

앱과 같은 경로(anon 키 + PostgREST)로 확인한다.

```sh
SUPABASE_URL=https://<시험 프로젝트>.supabase.co SUPABASE_ANON_KEY=<시험 프로젝트 anon 키> TEST_STAFF_CODE=<4단계 시험 암호> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/supabase-install/verify_http.mjs
```

| 시험 | 확인 내용 |
|---|---|
| H01 | 대기열 표 3개를 anon 이 직접 조회·쓰기·수정 못 함 |
| H02 | 내부 함수가 API 로 노출되지 않음 |
| H03 | anon 이 서약서를 삭제하지 못함 |
| H04 | 접수 · 같은 요청 멱등 · 서약서 미확정 `CONSENT_NOT_FOUND`(retryable) · 고객 토큰 조회 |
| H05 | HTTP 동시 접수 20건이 모두 성공하고 번호가 겹치지 않음 |
| H06 | 틀린 직원 암호 거부 |
| H07 | 호출 → 처리 시작 → 원장 확정 후 발권 완료 → 같은 요청 재시도 성공 → 부분 수납 거부 |

주의:
- 만드는 행은 `SYN-HTTP-` 로 시작한다.
- H07 은 앞선 실행이 남긴 합성 대기 팀을 취소하고 진행한다. 시험 프로젝트 전용이다.
- H06 은 `private.auth_attempts` 에 실패 1건을 남긴다. IP 별 10분 20회를 넘기면 잠긴다.

## 3. 초기화

| 파일 | 지우는 것 | 남기는 것 |
|---|---|---|
| `90_reset_queue.sql` | 대기열 표 3개와 RPC·내부 함수 | 기본 스키마·서약서·원장 |
| `91_reset_all_test.sql` | 묶음이 만든 표 33개, 함수, private 스키마(시험 암호·설치 표시 포함), pg_cron 작업 | Supabase 기본 역할·스키마·확장 |

- 두 파일 모두 시험 설치 표시가 없으면 실행을 거부한다.
- 다시 설치하려면 `90` 뒤에는 3단계부터, `91` 뒤에는 1단계부터 실행한다.
- 가장 확실한 초기화는 Supabase 대시보드에서 시험 프로젝트 자체를 지우는 것이다.

## 4. 로컬 검증 (이 묶음 자체의 시험)

`01_봉플레이_운영시스템/tests/queue-contract/supabase-install/run_local_install_check.sh` 로 확인한다.

**쓰는 환경**
- 일회용 PostgreSQL 16
- `supabase_platform_emulation.sql`: 호스팅 Supabase 의 역할·넓은 기본 권한·extensions·auth 함수를 모사
- PostgREST 12.2.3

**확인하는 것**
1. 설치
2. 60 점검
3. HTTP 검증
4. 재설치
5. 90·91 초기화와 재설치
6. 운영 보호

시험 하네스(`ant006-conformance`)의 느슨한 설정은 쓰지 않는다. 설치 실행자는 Supabase 와 같이 비슈퍼유저 `postgres` 다.

```sh
PGRST_BIN=<postgrest 경로> bash 01_봉플레이_운영시스템/tests/queue-contract/supabase-install/run_local_install_check.sh
# 대조 실행: QUEUE_SQL=<다른 판본 대기열 SQL> 로 바꿔 같은 점검을 돌릴 수 있다
```

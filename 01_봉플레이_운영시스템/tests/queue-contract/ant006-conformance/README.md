# ANT-006 계약 적합성 시험 (CLAUDE-011)

아난티 구현(ANT-006)을 CLAUDE-011 계약에 맞춰 독립적으로 검사하는 시험이다. 단언 기준은 계약이고, 시험이 실패하면 구현 결함이 검출된 것이다. 이 폴더는 구현 코드·SQL·화면을 수정하지 않는다.

## 상태 대응 (`status-map.mjs`)

| 계약 | ANT-006 |
|---|---|
| waiting | waiting |
| called | called |
| serving | processing |
| held | no_show |
| cancelled | canceled |
| issued | issued |
| closed | (없음) |

대응표는 이름만 연결한다. 전이 조건과 검증 조건은 계약 그대로이며 완화하지 않는다. 예를 들어 발권 완료는 `serving(=processing)` 에서만 허용한다.

## 검증 계층 구분

| 계층 | 이 폴더에서 | 확인하는 것 | 확인하지 못하는 것 |
|---|---|---|---|
| 정적 대조 | `rpc-signature.test.mjs` | 클라이언트 `rpc()` 인자 ↔ SQL 함수 서명, 직원 자격 인자 존재 | PostgREST 가 실제로 어떤 오류를 내는지 |
| PGlite | `sql-conformance.test.mjs` | 제안 SQL 을 메모리 안 PostgreSQL 에 적재해 함수 동작·권한·원장 검증을 실행. Supabase 역할·`auth.role()`·기본 권한·`extensions` 스키마를 모사 | 실제 Supabase 설정, PostgREST 라우팅·JWT 검증, RLS 와 실제 역할, **동시 연결 경합** (PGlite 는 단일 연결) |
| 실제 Supabase/PostgREST | 없음 (미실행) | 시험 프로젝트에서 같은 시나리오를 HTTP 로 재실행, 동시 요청 | 운영 프로젝트에는 실행하지 않음 |

## 실행

```sh
# 대상 구현을 별도 폴더에 고정 SHA 로 꺼낸다 (예: git worktree add --detach <dir> <SHA>)
# PGlite 설치 (저장소 밖 임시 폴더)
npm i @electric-sql/pglite

ANT006_ROOT=<구현 체크아웃> \
  node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/rpc-signature.test.mjs

ANT006_SQL=<구현 체크아웃>/01_봉플레이_운영시스템/database/PROPOSED_MIGRATION_ticket_queue.sql \
PGLITE_DIR=<설치 폴더>/node_modules/@electric-sql/pglite \
  node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/sql-conformance.test.mjs
```

환경변수를 주지 않으면 대상 의존 시험은 건너뛴다 (파서 자체 점검만 실행). 결과는 반드시 대상 구현의 전체 SHA 와 함께 기록한다.

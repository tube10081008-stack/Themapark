# 익명 노출 점검 (CLAUDE-011 R4 보완)

| 시험 | 확인 내용 |
|---|---|
| L1 | `public.lookup_family_children` 의 모든 오버로드 ACL 에 PUBLIC·anon·authenticated EXECUTE 없음 |
| L2 | PostgREST HTTP (POST·GET) 로 anon 키·authenticated JWT 호출 → 401/403, 응답에 합성 아동 정보 없음 |
| L3 | PostgREST 와 같은 SQL 경로(authenticator → anon/authenticated) → `42501` |
| L4 | service_role 은 그대로 동작 (함수 자체는 유지 — 차단은 권한만) |
| L5 | 나중에 생긴 오버로드는 Supabase 기본 권한으로 anon 에 열린다. 마이그레이션을 다시 실행(2회)하면 모두 닫힌다 |

- 차단 마이그레이션: `database/PROPOSED_MIGRATION_lookup_family_children_revoke.sql` (설치 묶음 ORDER 3b).
- 운영 중 DB 에 적용하는 경로(적용 전 노출 재현 → 2회 적용 → FINAL 재실행 후 유지)는 `supabase-install/run_local_install_check.sh` I 단계가 본다.
- 자료는 모두 `SYN-` 합성 값이다.

```sh
PGRST_BIN=<postgrest> bash 01_봉플레이_운영시스템/tests/queue-contract/desk-e2e/desk_e2e_stack.sh start
E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/anon-exposure/lookup-family.test.mjs
```

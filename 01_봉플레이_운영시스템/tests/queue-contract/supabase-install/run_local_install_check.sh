#!/usr/bin/env bash
# CLAUDE-011 — 설치 묶음 로컬 검증 (일회용 PostgreSQL + PostgREST). Supabase·운영 DB 에 접속하지 않는다.
#
# 순서
#   A. 새 클러스터(슈퍼유저 supabase_admin) → supabase_platform_emulation.sql (호스팅 Supabase 기본 상태 모사)
#   B. 설치 실행자 postgres(비슈퍼유저)로 00 → FINAL → 대기열 SQL → 40(시험 암호) → 50 → 60 검증
#   C. PostgREST(anon JWT) 기동 → verify_http.mjs (H01~H07)
#   D. 재설치 멱등성: B 를 한 번 더 → 60
#   D2. FINAL 만 다시 실행 → 60 (FINAL 이 public 정책을 모두 지워도 대기열 표가 막혀 있는지)
#   E. 90 대기열 초기화 → 대기열 객체 없음 확인 → 대기열 SQL 재설치 → 60
#   F. 91 전체 초기화 → 객체 없음 확인 → 00~60 처음부터 → 60
#   G. 운영 보호: 합성 아닌 서약서가 있는 DB 에서 00 거부, 설치 표시 없는 DB 에서 40·50·90·91 거부
#
# 필요: root(클러스터를 postgres OS 사용자로 띄움), PostgreSQL 16 바이너리, PostgREST 바이너리, node 22
# 사용: PGRST_BIN=<postgrest 경로> [PG_BIN=/usr/lib/postgresql/16/bin] [WORK=/var/lib/postgresql/c011-install] \
#       bash run_local_install_check.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OPS="$(cd "$HERE/../../.." && pwd)"                      # 01_봉플레이_운영시스템
DB_DIR="$OPS/database"
BUNDLE="$DB_DIR/test_supabase_install"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGRST_BIN="${PGRST_BIN:?PGRST_BIN 필요}"
WORK="${WORK:-/var/lib/postgresql/c011-install}"
PORT="${PORT:-55433}"
API_PORT="${API_PORT:-3011}"
DB=bp_test
QUEUE_SQL="${QUEUE_SQL:-$DB_DIR/PROPOSED_MIGRATION_ticket_queue.sql}"   # 대조 실행용으로 다른 판본 지정 가능
TEST_CODE="SYN-TEST-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"   # 실행마다 새로 만드는 시험 전용 값
JWT_SECRET="SYN-LOCAL-JWT-SECRET-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TMP="$(mktemp -d)"
FAILS=0
step() { printf '\n=== %s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

psql_as() { local role="$1" db="$2"; shift 2; "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U "$role" -d "$db" "$@"; }
apply()   { local db="$1" f="$2"; if psql_as postgres "$db" -f "$f" > "$TMP/apply.log" 2>&1; then ok "적용 $(basename "$f")"; else bad "적용 $(basename "$f")"; tail -5 "$TMP/apply.log"; fi; }
expect_fail() { local db="$1" f="$2" pat="$3"; if psql_as postgres "$db" -f "$f" > "$TMP/x.log" 2>&1; then bad "거부되어야 함: $(basename "$f")"; elif grep -q "$pat" "$TMP/x.log"; then ok "거부 확인: $(basename "$f") ($pat)"; else bad "다른 오류: $(basename "$f")"; tail -3 "$TMP/x.log"; fi; }
verify() {
  psql_as postgres "$DB" -A -F '|' -t -f "$BUNDLE/60_verify.sql" > "$TMP/verify.txt" 2>&1 || { bad "60_verify 실행 오류"; cat "$TMP/verify.txt"; return; }
  local nfail; nfail=$(grep -c '^FAIL|[^|]*|f|' "$TMP/verify.txt")
  if [ "$nfail" -eq 0 ]; then ok "60_verify FAIL 0건 ($1)"; else bad "60_verify FAIL ${nfail}건 ($1)"; grep '|f|' "$TMP/verify.txt"; fi
  grep '^WARN|[^|]*|f|' "$TMP/verify.txt" | sed 's/^/      참고 /'
}
install_all() {
  local db="$1"
  apply "$db" "$BUNDLE/00_preflight.sql"
  apply "$db" "$DB_DIR/FINAL_SUPABASE_SETUP.sql"
  apply "$db" "$QUEUE_SQL"
  sed "s/__TEST_ONLY_STAFF_CODE__/$TEST_CODE/" "$BUNDLE/40_test_staff_code.sql" > "$TMP/40.sql"
  apply "$db" "$TMP/40.sql"
  apply "$db" "$BUNDLE/50_synthetic_seed.sql"
}
cleanup() {
  [ -n "${PGRST_PID:-}" ] && kill "$PGRST_PID" 2>/dev/null
  su postgres -s /bin/sh -c "$PG_BIN/pg_ctl -D $WORK/data -m fast stop" >/dev/null 2>&1
  rm -rf "$WORK" "$TMP"
}
trap cleanup EXIT

step "A. 일회용 클러스터 + Supabase 플랫폼 모사"
rm -rf "$WORK"; su postgres -s /bin/sh -c "mkdir -p $WORK && $PG_BIN/initdb -D $WORK/data -A trust -U supabase_admin >/dev/null && \
  $PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l $WORK/log start >/dev/null" || { echo "클러스터 기동 실패"; exit 2; }
for d in $DB bp_prodlike bp_nomarker; do
  "$PG_BIN/psql" -X -q -h 127.0.0.1 -p "$PORT" -U supabase_admin -d postgres -c "create database $d" || exit 2
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U supabase_admin -d $d -f "$HERE/supabase_platform_emulation.sql" > "$TMP/emu.log" 2>&1 || { cat "$TMP/emu.log"; exit 2; }
done
ok "클러스터·플랫폼 모사 준비 (DB: $DB, bp_prodlike, bp_nomarker)"
psql_as postgres "$DB" -t -A -c "select 'installer=' || current_user || ' superuser=' || rolsuper || ' bypassrls=' || rolbypassrls from pg_roles where rolname = current_user"

step "B. 설치 (1회차)"
install_all "$DB"
verify "1회차"

step "C. PostgREST HTTP 검증"
ANON_KEY=$(node -e '
const c=require("crypto"),b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"anon",iss:"syn-local",exp:Math.floor(Date.now()/1000)+3600});
console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url"));' "$JWT_SECRET")
cat > "$TMP/pgrst.conf" <<EOF
db-uri = "postgres://authenticator@127.0.0.1:$PORT/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $API_PORT
EOF
"$PGRST_BIN" "$TMP/pgrst.conf" > "$TMP/pgrst.log" 2>&1 &
PGRST_PID=$!
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/" && break; sleep 0.2; done
if SUPABASE_URL="http://127.0.0.1:$API_PORT" REST_PREFIX="" SUPABASE_ANON_KEY="$ANON_KEY" TEST_STAFF_CODE="$TEST_CODE" \
   node --test --test-concurrency=1 "$HERE/verify_http.mjs" > "$TMP/http.txt" 2>&1; then
  ok "verify_http $(grep -E '^# pass' "$TMP/http.txt")"
else
  bad "verify_http $(grep -E '^# (pass|fail)' "$TMP/http.txt" | tr '\n' ' ')"
fi
grep -E '^(ok|not ok)|^# 이전' "$TMP/http.txt" | sed 's/^/      /'
grep -E "^\s+error:" -A2 "$TMP/http.txt" | sed 's/^/      /' | head -30
kill "$PGRST_PID" 2>/dev/null; PGRST_PID=

step "D. 재설치 멱등성 (같은 DB 에 다시 적용)"
install_all "$DB"
verify "재설치"

step "D2. FINAL 만 다시 실행 (대기열 정책이 지워진 상태에서도 대기열 표가 막혀 있는지)"
apply "$DB" "$DB_DIR/FINAL_SUPABASE_SETUP.sql"
pol=$(psql_as postgres "$DB" -t -A -c "select count(*) from pg_policies where schemaname='public' and tablename like 'ticket_queue%'")
echo "      대기열 정책 수: $pol"
verify "FINAL 재실행 후"

step "E. 90 대기열 초기화 → 재설치"
apply "$DB" "$BUNDLE/90_reset_queue.sql"
left=$(psql_as postgres "$DB" -t -A -c "select count(*) from pg_class where relname in ('ticket_queue','ticket_queue_desks','ticket_queue_rate_limits') and relnamespace='public'::regnamespace")
base=$(psql_as postgres "$DB" -t -A -c "select count(*) from public.safety_consents")
[ "$left" = 0 ] && ok "대기열 표 0개, 서약서 ${base}건 유지" || bad "대기열 표 ${left}개 남음"
apply "$DB" "$QUEUE_SQL"
verify "대기열 재설치"

step "F. 91 전체 초기화 → 처음부터 설치"
apply "$DB" "$BUNDLE/91_reset_all_test.sql"
left=$(psql_as postgres "$DB" -t -A -c "select count(*) from pg_tables where schemaname='public'")
priv=$(psql_as postgres "$DB" -t -A -c "select count(*) from pg_namespace where nspname='private'")
[ "$left" = 0 ] && [ "$priv" = 0 ] && ok "public 테이블 0개, private 스키마 없음" || bad "남은 public 테이블 ${left}개, private ${priv}"
install_all "$DB"
verify "초기화 후 재설치"

step "G. 운영 보호"
psql_as postgres bp_prodlike -f "$DB_DIR/FINAL_SUPABASE_SETUP.sql" > /dev/null 2>&1
psql_as postgres bp_prodlike -c "insert into public.safety_consents (id, guardian_name, created_date) values ('cst_real_like_1', '합성 운영 흉내', current_date)" > /dev/null
expect_fail bp_prodlike "$BUNDLE/00_preflight.sql" "PREFLIGHT"
psql_as postgres bp_prodlike -c "delete from public.safety_consents; insert into private.app_settings (key, value) values ('access_code', 'x') on conflict do nothing" > /dev/null
expect_fail bp_prodlike "$BUNDLE/00_preflight.sql" "운영자 암호가 이미 등록"
psql_as postgres bp_nomarker -f "$DB_DIR/FINAL_SUPABASE_SETUP.sql" > /dev/null 2>&1
expect_fail bp_nomarker "$TMP/40.sql" "시험 설치 표시"
expect_fail bp_nomarker "$BUNDLE/50_synthetic_seed.sql" "시험 설치 표시"
expect_fail bp_nomarker "$BUNDLE/90_reset_queue.sql" "시험 설치 표시"
expect_fail bp_nomarker "$BUNDLE/91_reset_all_test.sql" "시험 설치 표시"
expect_fail "$DB" "$BUNDLE/40_test_staff_code.sql" "자리표시자"

step "결과"
if [ "$FAILS" -eq 0 ]; then echo "전체 통과"; else echo "실패 ${FAILS}건"; fi
exit "$FAILS"

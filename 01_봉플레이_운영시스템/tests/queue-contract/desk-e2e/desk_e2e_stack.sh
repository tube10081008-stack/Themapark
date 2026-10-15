#!/usr/bin/env bash
# CLAUDE-011 — 매표 발권 E2E 용 로컬 스택 (일회용 PostgreSQL + 설치 묶음 + PostgREST). Supabase·운영 DB 에 접속하지 않는다.
#   start: 클러스터 생성 → Supabase 플랫폼 모사 → 설치 묶음(00 → FINAL → 대기열 SQL → 40 → 50) → PostgREST 기동
#          → 접속 정보를 $WORK/stack.env 에 기록 (시험 암호·JWT 비밀은 실행마다 새로 만드는 합성 값)
#   stop : PostgREST·클러스터 정지, 작업 폴더 삭제
# 사용: PGRST_BIN=<postgrest> [DB_ROOT=<대상 database 폴더>] [EXTRA_SQL="<변경안 SQL> ..."] bash desk_e2e_stack.sh start|stop
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS="$(cd "$HERE/../../.." && pwd)"
DB_ROOT="${DB_ROOT:-$OPS/database}"                 # DB 계약 판본 (기본: 이 체크아웃)
BUNDLE="$DB_ROOT/test_supabase_install"
EMU="$HERE/../supabase-install/supabase_platform_emulation.sql"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="${WORK:-/var/lib/postgresql/c011-desk-e2e}"
PORT="${PORT:-55434}"
API_PORT="${API_PORT:-3012}"
DB=bp_e2e

stop() {
  [ -f "$WORK/pgrst.pid" ] && kill "$(cat "$WORK/pgrst.pid")" 2>/dev/null
  [ -d "$WORK/data" ] && su postgres -s /bin/sh -c "$PG_BIN/pg_ctl -D $WORK/data -m fast stop" >/dev/null 2>&1
  rm -rf "$WORK"
}

start() {
  : "${PGRST_BIN:?PGRST_BIN 필요}"
  stop
  su postgres -s /bin/sh -c "mkdir -p $WORK && chmod 755 $WORK && $PG_BIN/initdb -D $WORK/data -A trust -U supabase_admin >/dev/null && \
    $PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l $WORK/log start >/dev/null" || { echo "클러스터 기동 실패"; exit 2; }
  local P="$PG_BIN/psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PORT"
  $P -U supabase_admin -d postgres -c "create database $DB" || exit 2
  $P -U supabase_admin -d $DB -f "$EMU" >/dev/null || exit 2
  local code="SYN-E2E-$(head -c 10 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  local secret="SYN-E2E-JWT-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed "s/__TEST_ONLY_STAFF_CODE__/$code/" "$BUNDLE/40_test_staff_code.sql" > "$WORK/40.sql"
  for f in "$BUNDLE/00_preflight.sql" "$DB_ROOT/FINAL_SUPABASE_SETUP.sql" "$DB_ROOT/PROPOSED_MIGRATION_ticket_queue.sql" "$WORK/40.sql" "$BUNDLE/50_synthetic_seed.sql"; do
    $P -U postgres -d $DB -f "$f" > "$WORK/apply.log" 2>&1 || { echo "적용 실패: $f"; tail -5 "$WORK/apply.log"; exit 2; }
  done
  # 검증용 추가 SQL (변경안 효과 확인 전용, 설치 묶음 자체는 바꾸지 않는다). 공백으로 여러 파일 지정 가능
  for f in ${EXTRA_SQL:-}; do
    $P -U postgres -d $DB -f "$f" > "$WORK/apply.log" 2>&1 || { echo "추가 SQL 적용 실패: $f"; tail -5 "$WORK/apply.log"; exit 2; }
    echo "추가 SQL 적용: $f" >> "$WORK/extra.log"
  done
  local anon
  anon=$(node -e '
const c=require("crypto"),b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"anon",iss:"syn-local",exp:Math.floor(Date.now()/1000)+6*3600});
console.log(h+"."+p+"."+c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url"));' "$secret")
  cat > "$WORK/pgrst.conf" <<EOF
db-uri = "postgres://authenticator@127.0.0.1:$PORT/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$secret"
server-host = "127.0.0.1"
server-port = $API_PORT
EOF
  nohup "$PGRST_BIN" "$WORK/pgrst.conf" > "$WORK/pgrst.log" 2>&1 &
  echo $! > "$WORK/pgrst.pid"
  for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/" && break; sleep 0.2; done
  cat > "$WORK/stack.env" <<EOF
E2E_PG_URL=postgres://postgres@127.0.0.1:$PORT/$DB
E2E_PGRST_URL=http://127.0.0.1:$API_PORT
E2E_ANON_KEY=$anon
E2E_STAFF_CODE=$code
E2E_DB_ROOT=$DB_ROOT
E2E_EXTRA_SQL=${EXTRA_SQL:-}
EOF
  echo "$WORK/stack.env"
}

case "${1:-}" in start) start ;; stop) stop ;; *) echo "start|stop"; exit 1 ;; esac

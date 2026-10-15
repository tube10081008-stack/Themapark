#!/usr/bin/env bash
# CLAUDE-011 — safety_audits 수정 정책 KST 경계 시각 시험 (C2). Supabase·운영 DB 에 접속하지 않는다.
#
# PostgreSQL 서버 전체를 libfaketime 아래에서 띄워 now()/current_date 가 지정 시각을 따르게 한다 (세션 시간대 UTC = Supabase 기본).
# 같은 클러스터에 두 DB 를 둔다:
#   current: FINAL_SUPABASE_SETUP.sql 그대로 (audits_update = current_date, UTC)
#   patched: FINAL + PROPOSED_PATCH_audits_update_kst.sql
# 각 경계 시각마다 관리자 연결로 "오늘(KST)"·"어제(KST)" 점검 기록을 만들고, anon(앱)으로 두 기록의 note 수정을 시도한다.
# 계약: 오늘(KST) 기록은 수정 1건, 어제(KST) 기록은 수정 0건.
# 추가: 같은 시각에 오늘(KST) PASS 가 있으면 안전 인터록이 주문 품목 쓰기를 허용하는지 (트리거는 원래 KST 기준).
#
# 사용: [PG_BIN=/usr/lib/postgresql/16/bin] [FAKETIME_LIB=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1] bash audits_kst_boundary.sh
# 종료 코드: patched 의 계약 위반 수 (current 의 위반은 재현 결과로만 출력)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS="$(cd "$HERE/../../.." && pwd)"
DB_DIR="$OPS/database"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
LIB="${FAKETIME_LIB:-/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1}"
WORK="${WORK:-/var/lib/postgresql/c011-kst-boundary}"
PORT="${PORT:-55435}"
[ -f "$LIB" ] || { echo "libfaketime 없음: $LIB"; exit 2; }

cleanup() { su postgres -s /bin/sh -c "$PG_BIN/pg_ctl -D $WORK/data -m fast stop" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
rm -rf "$WORK"
su postgres -s /bin/sh -c "mkdir -p $WORK && chmod 755 $WORK && $PG_BIN/initdb -D $WORK/data -A trust -U supabase_admin >/dev/null" || exit 2
echo "@2026-10-15 12:00:00" > "$WORK/faketime"; chmod 644 "$WORK/faketime"
su postgres -s /bin/sh -c "TZ=UTC LD_PRELOAD=$LIB FAKETIME_TIMESTAMP_FILE=$WORK/faketime FAKETIME_NO_CACHE=1 FAKETIME_DONT_FAKE_MONOTONIC=1 \
  $PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c timezone=UTC' -l $WORK/log start >/dev/null" || { cat "$WORK/log"; exit 2; }

P="$PG_BIN/psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PORT"
for d in current patched; do
  $P -U supabase_admin -d postgres -c "create database $d" || exit 2
  $P -U supabase_admin -d $d -f "$HERE/supabase_platform_emulation.sql" >/dev/null 2>&1 || exit 2
  $P -U postgres -d $d -f "$DB_DIR/test_supabase_install/00_preflight.sql" >/dev/null 2>&1 || exit 2
  $P -U postgres -d $d -f "$DB_DIR/FINAL_SUPABASE_SETUP.sql" >/dev/null 2>&1 || { echo "FINAL 적용 실패 ($d)"; exit 2; }
done
$P -U postgres -d patched -f "$DB_DIR/PROPOSED_PATCH_audits_update_kst.sql" >/dev/null || exit 2

probe() {   # $1 = DB. 출력: "서버UTC|KST날짜|current_date|오늘수정|어제수정|인터록"
  $P -U postgres -d "$1" -t -A <<'SQL'
truncate public.safety_audits;
delete from public.order_items where item_id like 'SYN-KST-%';
insert into public.safety_audits (id, site_id, audit_date, decision, inspector, note) values
  ('SYN-A-TODAY', 'bongplay_bonghwa', (now() at time zone 'Asia/Seoul')::date, 'pass', 'SYN', 'before'),
  ('SYN-A-YDAY',  'bongplay_bonghwa', (now() at time zone 'Asia/Seoul')::date - 1, 'pass', 'SYN', 'before');
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
with t as (update public.safety_audits set note = 'edited' where id = 'SYN-A-TODAY' returning 1),
     y as (update public.safety_audits set note = 'edited' where id = 'SYN-A-YDAY' returning 1)
select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' ||
       ((now() at time zone 'Asia/Seoul')::date)::text || '|' || current_date::text || '|' ||
       (select count(*) from t) || '|' || (select count(*) from y);
commit;
begin;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
insert into public.order_items (item_id, id, order_id, product_category, quantity, paid_amount)
  values ('SYN-KST-' || extract(epoch from now())::bigint, 'SYN-KST-x', 'SYN-KST-ORD', 'ticket', 1, 0);
select 'INTERLOCK_OK';
rollback;
SQL
}

FAILS=0; CUR_FAILS=0
printf '%-22s %-11s %-12s | %-24s | %-24s | %s\n' "서버 시각(UTC)" "KST 날짜" "current_date" "current: 오늘/어제 수정" "patched: 오늘/어제 수정" "인터록(오늘 PASS)"
for t in "2026-10-15 14:59:30" "2026-10-15 15:00:30" "2026-10-15 23:59:30" "2026-10-16 00:00:30"; do
  echo "@$t" > "$WORK/faketime"
  rc=$(probe current 2>&1 | grep '|' | head -1)
  rp=$(probe patched 2>&1); il=$(echo "$rp" | grep -c INTERLOCK_OK); rp=$(echo "$rp" | grep '|' | head -1)
  IFS='|' read -r utc kst cd ct cy <<< "$rc"
  IFS='|' read -r _ _ _ pt py <<< "$rp"
  cv=$([ "$ct" = 1 ] && [ "$cy" = 0 ] && echo "계약 충족" || echo "위반")
  pv=$([ "$pt" = 1 ] && [ "$py" = 0 ] && echo "계약 충족" || echo "위반")
  [ "$cv" = "위반" ] && CUR_FAILS=$((CUR_FAILS + 1))
  [ "$pv" = "위반" ] && FAILS=$((FAILS + 1))
  printf '%-22s %-11s %-12s | %s/%s %-18s | %s/%s %-18s | %s\n' "$utc" "$kst" "$cd" "$ct" "$cy" "$cv" "$pt" "$py" "$pv" "$([ "$il" = 1 ] && echo 허용 || echo 거부)"
done
echo "current(FINAL 그대로) 위반 시각 ${CUR_FAILS}개 / patched 위반 시각 ${FAILS}개"
exit "$FAILS"

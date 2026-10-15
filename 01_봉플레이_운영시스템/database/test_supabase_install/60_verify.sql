-- ============================================================================
-- 60_verify.sql — 설치 후 구조·권한 점검 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 읽기 전용 조회 1개. 아무것도 바꾸지 않는다. 결과 표에서 ok = false 인 행이 없어야 한다.
-- (level = 'WARN' 은 참고 항목: 실패해도 설치 자체는 유효하지만 시험 전에 확인)
-- 기능 동작(접수·호출·발권 완료·동시 접수)은 tests/queue-contract/supabase-install/verify_http.mjs 로
-- PostgREST(HTTP) 경로에서 따로 확인한다.
-- ============================================================================
with
req_tables(t) as (values
  ('safety_consents'), ('order_items'), ('order_payments'), ('ticket_ledger'), ('safety_audits'),
  ('ticket_queue'), ('ticket_queue_desks'), ('ticket_queue_rate_limits')),
queue_tables(t) as (values ('ticket_queue'), ('ticket_queue_desks'), ('ticket_queue_rate_limits')),
ledger_tables(t) as (values ('safety_consents'), ('order_items'), ('order_payments'), ('ticket_ledger'), ('safety_audits')),
req_cols(t, c) as (values
  ('safety_consents', 'id'), ('safety_consents', 'created_date'),
  ('order_items', 'order_id'), ('order_items', 'product_category'), ('order_items', 'quantity'),
  ('order_items', 'paid_amount'), ('order_items', 'total_price'), ('order_items', 'consent_id'),
  ('order_items', 'status'), ('order_items', 'cancelled_at'),
  ('order_payments', 'order_id'), ('order_payments', 'consent_id'), ('order_payments', 'amount'),
  ('order_payments', 'status'), ('order_payments', 'cancelled_at'),
  ('ticket_ledger', 'ticket_id'), ('ticket_ledger', 'order_id'), ('ticket_ledger', 'consent_id'),
  ('ticket_ledger', 'status'), ('ticket_ledger', 'cancelled_at')),
api_roles(r) as (values ('anon'), ('authenticated')),
privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
-- anon 이 실행해도 되는 public 함수 (대기열 RPC 12개 + FINAL 의 공개 RPC 4개). 나머지는 노출되면 안 된다.
queue_rpcs(f) as (values
  ('enqueue_consent_team'), ('get_customer_queue_status'), ('get_queue_public_display'),
  ('call_next_queue_team'), ('recall_queue_team'), ('start_queue_processing'), ('hold_queue_team'),
  ('restore_queue_team'), ('cancel_queue_team'), ('complete_queue_issuance'), ('get_staff_queue_list'),
  ('set_desk_pause_status')),
anon_rpc_allow(f) as (
  select f from queue_rpcs
  union all values ('verify_staff_access'), ('get_today_consents_secure'), ('mask_expired_consents_secure'), ('lookup_family_children')),
fns as (
  select p.oid, n.nspname, p.proname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind = 'f'),
checks(level, check_id, ok, detail) as (
  select 'FAIL', 'T01 필수 테이블',
         bool_and(to_regclass('public.' || t) is not null),
         coalesce(string_agg(t, ', ') filter (where to_regclass('public.' || t) is null), '')
  from req_tables
  union all
  select 'FAIL', 'T02 대기열이 읽는 원장 열',
         bool_and(c.column_name is not null),
         coalesce(string_agg(rc.t || '.' || rc.c, ', ') filter (where c.column_name is null), '')
  from req_cols rc left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = rc.t and c.column_name = rc.c
  union all
  select 'FAIL', 'T03 서약서 취소 3열 (status·cancelled_at·cancel_reason, 매표 화면이 저장에 포함)',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'safety_consents'
            and column_name in ('status', 'cancelled_at', 'cancel_reason')) = 3,
         'PROPOSED_MIGRATION_safety_consents_cancellation.sql 적용 여부'
  union all
  select 'FAIL', 'E01 pgcrypto 가 extensions 스키마에 설치',
         exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                 where e.extname = 'pgcrypto' and n.nspname = 'extensions'), ''
  union all
  select 'FAIL', 'R01 RLS 켜짐',
         bool_and(coalesce(c.relrowsecurity, false)),
         coalesce(string_agg(t.t, ', ') filter (where not coalesce(c.relrowsecurity, false)), '')
  from req_tables t left join pg_class c on c.oid = to_regclass('public.' || t.t)
  union all
  select 'FAIL', 'P01 anon·authenticated 의 대기열 표 직접 권한 없음',
         not bool_or(has_table_privilege(r.r, 'public.' || q.t, p.p)),
         coalesce(string_agg(r.r || ':' || q.t || ':' || p.p, ', ') filter (where has_table_privilege(r.r, 'public.' || q.t, p.p)), '')
  from api_roles r cross join queue_tables q cross join privs p
  where to_regclass('public.' || q.t) is not null
  union all
  select 'FAIL', 'P02 anon·authenticated 의 원장 DELETE 권한 없음',
         not bool_or(has_table_privilege(r.r, 'public.' || l.t, 'DELETE')),
         coalesce(string_agg(r.r || ':' || l.t, ', ') filter (where has_table_privilege(r.r, 'public.' || l.t, 'DELETE')), '')
  from api_roles r cross join ledger_tables l
  where to_regclass('public.' || l.t) is not null
  union all
  select 'WARN', 'P02b anon·authenticated 의 원장 TRUNCATE 권한 (PostgREST 로는 호출 불가, 직접 접속 경로만)',
         not bool_or(has_table_privilege(r.r, 'public.' || l.t, 'TRUNCATE')),
         coalesce(string_agg(r.r || ':' || l.t, ', ') filter (where has_table_privilege(r.r, 'public.' || l.t, 'TRUNCATE')), '')
  from api_roles r cross join ledger_tables l
  where to_regclass('public.' || l.t) is not null
  union all
  select 'FAIL', 'P03 private 스키마 USAGE 없음',
         not bool_or(has_schema_privilege(r.r, 'private', 'USAGE')),
         coalesce(string_agg(r.r, ', ') filter (where has_schema_privilege(r.r, 'private', 'USAGE')), '')
  from api_roles r
  union all
  select 'FAIL', 'P04 private 함수 실행 권한 없음',
         coalesce(not bool_or(has_function_privilege(r.r, f.oid, 'EXECUTE')), true),
         coalesce(string_agg(r.r || ':' || f.proname, ', ') filter (where has_function_privilege(r.r, f.oid, 'EXECUTE')), '')
  from api_roles r cross join fns f where f.nspname = 'private'
  union all
  select 'FAIL', 'P05 대기열 RPC 12개 anon 실행 가능',
         count(*) filter (where exists (select 1 from fns f where f.nspname = 'public' and f.proname = q.f
                                        and has_function_privilege('anon', f.oid, 'EXECUTE'))) = 12,
         coalesce(string_agg(q.f, ', ') filter (where not exists (select 1 from fns f where f.nspname = 'public' and f.proname = q.f
                                        and has_function_privilege('anon', f.oid, 'EXECUTE'))), '')
  from queue_rpcs q
  union all
  select 'FAIL', 'P06 허용 목록 밖 SECURITY DEFINER 함수가 anon 에 노출되지 않음',
         coalesce(not bool_or(true), true),
         coalesce(string_agg(f.proname, ', '), '')
  from fns f
  where f.nspname = 'public' and f.prosecdef and has_function_privilege('anon', f.oid, 'EXECUTE')
    and f.proname not in (select f from anon_rpc_allow)
  union all
  select 'FAIL', 'S01 SECURITY DEFINER 함수 search_path 고정',
         coalesce(bool_and(exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')), true),
         coalesce(string_agg(f.nspname || '.' || f.proname, ', ') filter (where not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%')), '')
  from fns f where f.prosecdef
  union all
  select 'FAIL', 'S02 안전점검 수정 정책이 KST 날짜 기준 (C2, UTC current_date 아님)',
         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'safety_audits' and policyname = 'audits_update'
                 and qual like '%Asia/Seoul%' and with_check like '%Asia/Seoul%'),
         'FINAL_SUPABASE_SETUP.sql 5-3 판 확인'
  union all
  select 'FAIL', 'Q01 대기열 고유 제약 (번호·서약서·멱등키)',
         (select count(*) from pg_constraint where conname in
           ('uq_ticket_queue_site_date_number', 'uq_ticket_queue_site_date_consent', 'uq_ticket_queue_site_date_idempotency')) = 3, ''
  union all
  select 'FAIL', 'Q02 시설·영업일 잠금 함수 (CLAUDE-011 후속)',
         to_regprocedure('private.lock_ticket_queue_day(text,date)') is not null, ''
  union all
  select 'FAIL', 'Q03 창구 시드 2개 이상',
         (select count(*) from public.ticket_queue_desks) >= 2, ''
  union all
  select 'FAIL', 'A01 시험 설치 표시',
         exists (select 1 from private.app_settings where key = 'install_target' and value = 'synthetic_test'), ''
  union all
  select 'FAIL', 'A02 운영자 암호 해시 등록 (bcrypt)',
         exists (select 1 from private.app_settings where key = 'access_code' and value like '$2%'), '40_test_staff_code.sql 실행 여부'
  union all
  select 'WARN', 'D01 오늘(KST) 안전점검 PASS (없으면 주문·발권 원장 쓰기 거부)',
         exists (select 1 from public.safety_audits where audit_date = (now() at time zone 'Asia/Seoul')::date and decision = 'pass'),
         '50_synthetic_seed.sql 을 오늘 실행했는지'
  union all
  select 'WARN', 'X01 pg_cron (개인정보 자동 마스킹)',
         exists (select 1 from pg_extension where extname = 'pg_cron'), '시험 프로젝트에서는 없어도 됨'
)
select level, check_id, ok, detail from checks
order by ok, level, check_id;

-- ============================================================================
-- 90_reset_queue.sql — 대기열만 초기화 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 시험 프로젝트에서 대기열 SQL(PROPOSED_MIGRATION_ticket_queue.sql)이 만든 객체만 지운다.
-- 기본 스키마(FINAL_SUPABASE_SETUP.sql)·서약서·주문·원장은 그대로 둔다.
-- 다시 설치하려면 PROPOSED_MIGRATION_ticket_queue.sql 부터 다시 실행한다.
-- 시험 설치 표시(00_preflight.sql)가 없으면 실행을 거부한다.
-- ============================================================================
do $reset_queue$
declare
  r record;
begin
  if to_regclass('private.app_settings') is null
     or coalesce((select value from private.app_settings where key = 'install_target'), '') <> 'synthetic_test' then
    raise exception 'RESET: 시험 설치 표시가 없습니다. 운영 프로젝트에서는 실행하지 않습니다.';
  end if;

  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in (
             'enqueue_consent_team', 'get_customer_queue_status', 'get_queue_public_display',
             'call_next_queue_team', 'recall_queue_team', 'start_queue_processing', 'hold_queue_team',
             'restore_queue_team', 'cancel_queue_team', 'complete_queue_issuance', 'get_staff_queue_list',
             'set_desk_pause_status'))
       or (n.nspname = 'private' and p.proname in ('verify_staff_permission', 'lock_ticket_queue_day',
             -- R4 (전날 미정리 팀·창구 포인터)
             'lock_ticket_queue_site', 'ticket_queue_recorded_orders', 'ticket_queue_past_actions', 'ticket_queue_past_rejection',
             'ticket_queue_sync_pointer', 'ticket_queue_desk_occupant', 'ticket_queue_pointer_stale'))
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;

  drop table if exists public.ticket_queue_rate_limits;
  drop table if exists public.ticket_queue_desks;
  drop table if exists public.ticket_queue;

  raise notice 'RESET: 대기열 객체를 지웠습니다 (기본 스키마·원장 유지).';
end
$reset_queue$;

-- ============================================================================
-- 90_reset_visit_entry.sql — 게이트 없는 입장(BEN-ENTRY-01) 객체만 지운다
-- ----------------------------------------------------------------------------
-- PROPOSED_MIGRATION_visit_entry.sql 이 만든 표·함수·트리거만 지운다.
-- 서약서·주문·결제·티켓 원장·대기열 표는 그대로 둔다 (대기열 행의 issued 전환은 기존 발권 완료와 같은 결과로 남는다).
-- 다시 설치하려면 PROPOSED_MIGRATION_visit_entry.sql 을 다시 실행한다.
-- 시험 설치 표시(00_preflight.sql)가 없으면 실행을 거부한다.
--
-- 운영 복구(롤백)용으로 쓰려면 시험 표시 검사 대신 관리자 승인 후 같은 순서를 수동으로 실행한다.
-- 그 경우 입장·반납·알림 기록이 함께 지워지므로 먼저 visit_entries·visit_entry_tickets·queue_call_notifications 를 내보내 보관한다.
-- ============================================================================
do $reset_visit$
declare
  r record;
begin
  if to_regclass('private.app_settings') is null
     or coalesce((select value from private.app_settings where key = 'install_target'), '') <> 'synthetic_test' then
    raise exception 'RESET: 시험 설치 표시가 없습니다. 운영 프로젝트에서는 실행하지 않습니다.';
  end if;

  if to_regclass('public.ticket_queue') is not null then
    drop trigger if exists trg_queue_call_notification on public.ticket_queue;
  end if;

  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in (
             'verify_visit_guardian_last4', 'confirm_visit_entry', 'search_visit_entries', 'get_visit_entry',
             'return_visit_wristbands', 'get_visit_occupancy', 'get_queue_call_notifications',
             'claim_queue_call_notifications', 'report_queue_call_notification'))
       or (n.nspname = 'private' and p.proname in (
             'visit_today', 'visit_safety_pass', 'visit_last4', 'visit_sorted_ids', 'visit_request_replay',
             'visit_entry_json', 'visit_reconcile_order', 'trg_queue_call_notification'))
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;

  drop table if exists public.visit_entry_tickets;
  drop table if exists public.visit_entries;   -- 트리거 trg_safety_interlock 도 함께 지워진다 (공유 함수 private.trg_safety_interlock 은 유지)
  drop table if exists public.visit_identity_checks;
  drop table if exists public.visit_entry_requests;
  drop table if exists public.queue_call_notifications;

  raise notice 'RESET: 게이트 없는 입장 객체를 지웠습니다 (서약서·원장·대기열 유지).';
end
$reset_visit$;

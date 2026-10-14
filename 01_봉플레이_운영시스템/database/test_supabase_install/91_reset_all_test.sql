-- ============================================================================
-- 91_reset_all_test.sql — 시험 프로젝트 전체 초기화 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 이 묶음(00~50)이 만든 것을 모두 지워 빈 프로젝트에 가깝게 되돌린다.
--   · public: FINAL_SUPABASE_SETUP.sql 의 30개 테이블 + 대기열 3개 테이블과 그 함수·트리거·정책
--     (Realtime 발행 등록은 테이블과 함께 사라진다)
--   · private 스키마 전체 (시험 운영자 암호 해시·설치 표시 포함)
--   · pg_cron 작업 daily_mask_expired_consents (있을 때만)
-- 지우지 않는 것: Supabase 기본 역할·스키마, pgcrypto 등 확장, auth/storage 스키마.
-- 시험 설치 표시가 없으면 실행을 거부한다. 되돌릴 수 없다.
-- 프로젝트 자체를 지우는 편이 더 확실하면 Supabase 대시보드에서 시험 프로젝트를 삭제한다.
-- ============================================================================
do $reset_all$
declare
  t text;
  r record;
begin
  if to_regclass('private.app_settings') is null
     or coalesce((select value from private.app_settings where key = 'install_target'), '') <> 'synthetic_test' then
    raise exception 'RESET: 시험 설치 표시가 없습니다. 운영 프로젝트에서는 실행하지 않습니다.';
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select cron.unschedule(jobid) from cron.job where jobname = 'daily_mask_expired_consents'$c$;
  end if;

  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'enqueue_consent_team', 'get_customer_queue_status', 'get_queue_public_display',
      'call_next_queue_team', 'recall_queue_team', 'start_queue_processing', 'hold_queue_team',
      'restore_queue_team', 'cancel_queue_team', 'complete_queue_issuance', 'get_staff_queue_list',
      'set_desk_pause_status',
      'verify_staff_access', 'get_today_consents_secure', 'lookup_family_children', 'mask_expired_consents_secure')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;

  foreach t in array array[
    'ticket_queue_rate_limits', 'ticket_queue_desks', 'ticket_queue',
    'asset_maintenance_logs', 'asset_measurements', 'asset_usage_counters', 'closing_records', 'complaint_logs',
    'congestion_telemetry', 'customer_experience_surveys', 'equipment_assets', 'facility_operating_intervals',
    'facility_usage_events', 'group_bookings', 'incident_logs', 'marketing_campaigns', 'master_facilities',
    'master_products', 'master_targets', 'operator_action_logs', 'order_items', 'order_payments', 'queue_snapshots',
    'safety_audits', 'safety_consents', 'sales_records', 'sensor_readings', 'spatial_zone_telemetry',
    'staff_assignment_events', 'staff_shifts', 'staff_task_logs', 'ticket_ledger', 'weather_environment_telemetry']
  loop
    execute format('drop table if exists public.%I cascade', t);
  end loop;

  drop schema if exists private cascade;
  raise notice 'RESET: 시험 설치 전체를 지웠습니다. 다시 설치하려면 00_preflight.sql 부터 실행하십시오.';
end
$reset_all$;

-- ============================================================================
-- 봉플레이 운영시스템 — Supabase RLS 보안 강화 마이그레이션
-- 작성/검증일: 2026-09-17
--
-- 목적
--   1) anon/authenticated 역할의 직접 DELETE를 차단한다.
--   2) 운영 테이블은 현재 프론트엔드의 Cloud-First upsert 동작에 필요한
--      SELECT / INSERT / UPDATE만 허용한다.
--   3) 기준정보(master_*)는 SELECT 전용으로 만든다.
--   4) 기존 "FOR ALL USING (true)" 정책과 이전 secure_* 정책을 모두 제거해
--      permissive 정책의 OR 결합으로 권한이 다시 열리는 문제를 방지한다.
--
-- 실행 순서
--   - 신규 DB: supabase_setup.sql 실행 후 이 파일 실행
--   - 기존 DB: 이 파일만 실행
--
-- 중요 한계
--   - 현재 앱은 Supabase anon key를 사용하는 무로그인 구조다.
--   - 아래 정책은 DELETE와 master 변조를 막지만, anon에게 허용된 운영 데이터의
--     조회/입력/수정 자체를 사용자별로 구분하지는 못한다.
--   - safety_consents에는 개인정보가 있으므로 외부 공개 서비스에서는 반드시
--     Supabase Auth + 사용자/역할 기반 정책으로 전환해야 한다.
--   - ACCESS_CODE는 브라우저 화면의 간이 잠금일 뿐 DB 인증 수단이 아니다.
--
-- 이 스크립트는 아래 29개 업무 테이블의 기존 RLS 정책을 전부 초기화한다.
-- service_role은 Supabase 기본 동작상 RLS를 우회하므로 관리자 작업은 유지된다.
-- ============================================================================

begin;

-- 0. 대상 테이블 존재 여부를 먼저 확인한다.
do $$
declare
  expected text[] := array[
    'sales_records', 'safety_consents', 'safety_audits', 'closing_records',
    'group_bookings', 'incident_logs', 'complaint_logs', 'ticket_ledger',
    'order_items', 'facility_usage_events', 'congestion_telemetry',
    'operator_action_logs', 'asset_measurements', 'equipment_assets',
    'facility_operating_intervals', 'marketing_campaigns',
    'customer_experience_surveys', 'staff_shifts', 'staff_assignment_events',
    'staff_task_logs', 'weather_environment_telemetry', 'master_products',
    'master_facilities', 'master_targets', 'spatial_zone_telemetry',
    'queue_snapshots', 'sensor_readings', 'asset_maintenance_logs',
    'asset_usage_counters'
  ];
  missing text[];
begin
  select array_agg(t order by t)
    into missing
  from unnest(expected) as t
  where to_regclass('public.' || t) is null;

  if missing is not null then
    raise exception
      'RLS hardening 중단: 다음 테이블이 없습니다: %. 먼저 supabase_setup.sql을 실행하십시오.',
      array_to_string(missing, ', ');
  end if;
end
$$;

-- 1. 대상 테이블의 기존 정책을 전부 제거한다.
-- 정책은 permissive(OR 결합)이므로 취약한 정책 하나만 남아도 차단이 무효다.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'sales_records', 'safety_consents', 'safety_audits', 'closing_records',
        'group_bookings', 'incident_logs', 'complaint_logs', 'ticket_ledger',
        'order_items', 'facility_usage_events', 'congestion_telemetry',
        'operator_action_logs', 'asset_measurements', 'equipment_assets',
        'facility_operating_intervals', 'marketing_campaigns',
        'customer_experience_surveys', 'staff_shifts', 'staff_assignment_events',
        'staff_task_logs', 'weather_environment_telemetry', 'master_products',
        'master_facilities', 'master_targets', 'spatial_zone_telemetry',
        'queue_snapshots', 'sensor_readings', 'asset_maintenance_logs',
        'asset_usage_counters'
      ])
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      p.policyname, p.schemaname, p.tablename
    );
  end loop;
end
$$;

-- 2. 운영 테이블: SELECT / INSERT / UPDATE만 허용하고 DELETE 권한은 회수한다.
-- upsert가 중복 키에서 UPDATE로 전환되므로 INSERT와 UPDATE가 모두 필요하다.
do $$
declare
  t text;
  operational_tables text[] := array[
    'sales_records', 'safety_consents', 'safety_audits', 'closing_records',
    'group_bookings', 'incident_logs', 'complaint_logs', 'ticket_ledger',
    'order_items', 'facility_usage_events', 'congestion_telemetry',
    'operator_action_logs', 'asset_measurements', 'equipment_assets',
    'facility_operating_intervals', 'marketing_campaigns',
    'customer_experience_surveys', 'staff_shifts', 'staff_assignment_events',
    'staff_task_logs', 'weather_environment_telemetry',
    'spatial_zone_telemetry', 'queue_snapshots', 'sensor_readings',
    'asset_maintenance_logs', 'asset_usage_counters'
  ];
begin
  foreach t in array operational_tables
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to anon using (true)',
      'anon_' || t || '_select', t
    );
    execute format(
      'create policy %I on public.%I for insert to anon with check (true)',
      'anon_' || t || '_insert', t
    );
    execute format(
      'create policy %I on public.%I for update to anon using (true) with check (true)',
      'anon_' || t || '_update', t
    );
    execute format(
      'revoke delete on table public.%I from anon, authenticated', t
    );
  end loop;
end
$$;

-- 3. 기준정보 테이블: 익명/일반 사용자는 읽기 전용.
do $$
declare
  t text;
  master_tables text[] := array[
    'master_products', 'master_facilities', 'master_targets'
  ];
begin
  foreach t in array master_tables
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to anon using (true)',
      'anon_' || t || '_select', t
    );
    execute format(
      'revoke insert, update, delete on table public.%I from anon, authenticated', t
    );
  end loop;
end
$$;

commit;

-- 4. 실행 후 검증용 조회
-- 운영 테이블은 SELECT/INSERT/UPDATE 각 1개, master는 SELECT 1개여야 한다.
-- DELETE 또는 ALL 정책이 한 건이라도 나오면 적용 상태를 재점검한다.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename = any (array[
    'sales_records', 'safety_consents', 'safety_audits', 'closing_records',
    'group_bookings', 'incident_logs', 'complaint_logs', 'ticket_ledger',
    'order_items', 'facility_usage_events', 'congestion_telemetry',
    'operator_action_logs', 'asset_measurements', 'equipment_assets',
    'facility_operating_intervals', 'marketing_campaigns',
    'customer_experience_surveys', 'staff_shifts', 'staff_assignment_events',
    'staff_task_logs', 'weather_environment_telemetry', 'master_products',
    'master_facilities', 'master_targets', 'spatial_zone_telemetry',
    'queue_snapshots', 'sensor_readings', 'asset_maintenance_logs',
    'asset_usage_counters'
  ])
order by tablename, cmd, policyname;

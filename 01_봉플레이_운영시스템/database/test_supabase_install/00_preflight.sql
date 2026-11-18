-- ============================================================================
-- 00_preflight.sql — 빈 시험 Supabase 설치 사전 점검 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 이 묶음은 "새로 만든 빈 시험 프로젝트" 전용이다. 운영 프로젝트에서는 실행하지 않는다.
-- 아래 조건 중 하나라도 맞으면 예외를 던지고 아무것도 바꾸지 않는다.
--   1) 운영 테이블에 합성(SYN-) 이 아닌 행이 있다 (이미 설치 표시가 있는 시험 프로젝트는 예외)
--   2) 운영자 암호(private.app_settings.access_code)가 이미 있는데 시험 설치 표시가 없다
--   3) Supabase 역할(anon·authenticated·service_role) 또는 pgcrypto 를 쓸 수 없다
-- 통과하면 private.app_settings 에 시험 설치 표시(install_target = synthetic_test)를 남긴다.
-- 이후 단계(40·50·90·91)는 이 표시가 없으면 실행을 거부한다.
-- 실행: SQL Editor 에 전체 붙여넣기 ➔ Run. 여러 번 실행해도 안전하다.
-- ============================================================================
do $preflight$
declare
  v_marker text;
  v_has_code boolean := false;
  v_count bigint;
  r record;
begin
  -- 3) 플랫폼 조건
  if not exists (select 1 from pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception 'PREFLIGHT: Supabase 역할(anon/authenticated/service_role)이 없습니다. Supabase 프로젝트가 아닙니다.';
  end if;
  if not exists (select 1 from pg_available_extensions where name = 'pgcrypto') then
    raise exception 'PREFLIGHT: pgcrypto 확장을 쓸 수 없습니다.';
  end if;

  -- 이미 설치 표시가 있으면 시험 프로젝트로 보고 데이터 검사를 건너뛴다 (재설치)
  if to_regclass('private.app_settings') is not null then
    execute $q$select value from private.app_settings where key = 'install_target'$q$ into v_marker;
    execute $q$select exists (select 1 from private.app_settings where key = 'access_code')$q$ into v_has_code;
  end if;
  if v_marker is not null and v_marker <> 'synthetic_test' then
    raise exception 'PREFLIGHT: install_target 표시가 %입니다. 시험 프로젝트가 아닙니다.', v_marker;
  end if;

  if v_marker is null then
    -- 2) 운영자 암호가 이미 등록된 프로젝트는 운영(또는 사용 중) 프로젝트로 본다
    if v_has_code then
      raise exception 'PREFLIGHT: 운영자 암호가 이미 등록된 프로젝트입니다. 빈 시험 프로젝트에서만 실행하십시오.';
    end if;
    -- 1) 운영 데이터 흔적
    for r in
      select * from (values
        ('safety_consents', 'id'), ('order_items', 'item_id'), ('order_payments', 'id'),
        ('ticket_ledger', 'ticket_id'), ('sales_records', 'id'), ('closing_records', 'id'),
        ('safety_audits', 'id'), ('ticket_queue', 'id')
      ) as t(tbl, pk)
    loop
      if to_regclass('public.' || r.tbl) is not null then
        execute format('select count(*) from public.%I where %I::text not like %L', r.tbl, r.pk, 'SYN-%') into v_count;
        if v_count > 0 then
          raise exception 'PREFLIGHT: public.% 에 합성(SYN-)이 아닌 행 %건이 있습니다. 빈 시험 프로젝트에서만 실행하십시오.', r.tbl, v_count;
        end if;
      end if;
    end loop;
  end if;

  -- 설치 표시 (FINAL_SUPABASE_SETUP.sql 의 private 스키마·app_settings 정의와 같은 구조)
  create schema if not exists private;
  revoke all on schema private from public;
  revoke all on schema private from anon, authenticated;
  create table if not exists private.app_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz default now()
  );
  insert into private.app_settings (key, value) values ('install_target', 'synthetic_test')
  on conflict (key) do nothing;

  raise notice 'PREFLIGHT 통과: 시험 설치 표시 확인 (install_target = synthetic_test)';
end
$preflight$;

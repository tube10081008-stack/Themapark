-- ============================================================
-- 🔥 봉플레이 운영시스템 DB 전면 정상화 & 실시간 동기화 활성화 SQL
-- Supabase 대시보드 → SQL Editor 에 전체 복사 후 [Run]을 누르십시오.
-- ============================================================

-- ── 1. 누락된 필수 컬럼 추가 (안전한 IF NOT EXISTS) ──────────
-- safety_consents (동의서 및 발권 원장)
alter table safety_consents add column if not exists site_id text default 'bongplay_bonghwa';
alter table safety_consents add column if not exists visit_id text;
alter table safety_consents add column if not exists household_id text;
alter table safety_consents add column if not exists booking_id text;
alter table safety_consents add column if not exists campaign_id text default 'cmp_walkin';
alter table safety_consents add column if not exists ticket_ids jsonb;
alter table safety_consents add column if not exists pass_code text;
alter table safety_consents add column if not exists arrival_at timestamptz;
alter table safety_consents add column if not exists ticket_issued_at timestamptz;
alter table safety_consents add column if not exists entry_at timestamptz;
alter table safety_consents add column if not exists exit_at timestamptz;
alter table safety_consents add column if not exists stay_duration_minutes int;
alter table safety_consents add column if not exists consent_marketing boolean default false;

-- safety_audits (안전점검 일지)
alter table safety_audits add column if not exists site_id text default 'bongplay_bonghwa';
alter table safety_audits add column if not exists facility_id text;
alter table safety_audits add column if not exists asset_id text;
alter table safety_audits add column if not exists staff_id text;

-- sales_records (매출 실적)
alter table sales_records add column if not exists site_id text default 'bongplay_bonghwa';
alter table sales_records add column if not exists channels jsonb;
alter table sales_records add column if not exists data_source text default 'manual';

-- closing_records (마감 정산)
alter table closing_records add column if not exists site_id text default 'bongplay_bonghwa';

-- ticket_ledger (발권 원장 테이블 없을 경우 생성)
create table if not exists ticket_ledger (
  ticket_id       text primary key,
  site_id         text default 'bongplay_bonghwa',
  visit_id        text,
  household_id    text,
  visitor_id      text,
  ticket_type     text,
  issued_at       timestamptz default now(),
  status          text default 'active',
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);

-- ── 2. RLS 정책 정상화 (기기간 공유 유지 + DELETE 차단) ──────
-- FOR ALL 정책은 DELETE까지 허용하므로 사용하지 않는다.
-- 전체 29개 테이블의 최종 정책은 이 파일 실행 후
-- supabase_rls_hardening.sql을 실행하여 일괄 적용/검증한다.
do $$
declare
  t text;
  p record;
  target_tables text[] := array[
    'safety_consents',
    'safety_audits',
    'sales_records',
    'closing_records',
    'ticket_ledger'
  ];
begin
  foreach t in array target_tables
  loop
    execute format('alter table public.%I enable row level security', t);

    for p in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

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

-- ── 3. Supabase Realtime (WebSocket 실시간 전파) 활성화 ───────
-- 모든 기기에서 즉각 변경사항 수신
do $$
begin
  begin
    alter publication supabase_realtime add table safety_consents;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table safety_audits;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table sales_records;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table closing_records;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table ticket_ledger;
  exception when others then null;
  end;
end $$;

-- ── 4. 조회 속도 최적화 인덱스 ───────────────────────────────
create index if not exists idx_consents_date on safety_consents(created_date desc);
create index if not exists idx_audits_date on safety_audits(audit_date desc);
create index if not exists idx_sales_date on sales_records(date desc);
create index if not exists idx_closing_date on closing_records(date desc);
create index if not exists idx_ticket_issued on ticket_ledger(issued_at desc);

-- 완료 확인
select '봉플레이 DB 전면 정상화 및 실시간 동기화 설정 완료' as result;

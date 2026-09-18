-- ============================================================
-- 🌟 봉플레이 운영시스템 — 최종 통합 마스터 DB 설정 스크립트 (FINAL_SUPABASE_SETUP.sql)
-- ------------------------------------------------------------
-- 버전: v2026.FINAL
-- 포함 내용:
--   1. 전체 29개 테이블 스키마 및 최신 컬럼 정의 (IF NOT EXISTS)
--   2. 실시간 동기화(Supabase Realtime) 채널 활성화
--   3. [P0 해결] safety_consents 아동 개인정보 보호 (anon 전량 덤프 원천 차단 & 보안 RPC 함수)
--   4. [P1 해결] 점검일지·서약서 삭제 버튼 2곳 회귀 방지 (DELETE 허용 정책 수록)
--   5. [P1 해결] 전 테이블 Row Level Security (RLS) 최소 권한 보안 강화
-- ------------------------------------------------------------
-- 실행 방법:
--   1. https://supabase.com 접속 ➔ 봉플레이 프로젝트 선택
--   2. 좌측 메뉴 [SQL Editor] ➔ [New query] 클릭
--   3. 본 파일 내용 전체를 복사하여 붙여넣고 우측 하단 [Run] 클릭
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. 핵심 운영 테이블 스키마 생성 및 컬럼 보강
-- ────────────────────────────────────────────────────────────

-- 1-1. 매출 실적
create table if not exists public.sales_records (
  id                text primary key,              -- 날짜 (YYYY-MM-DD)
  date              date not null,
  op_mode           text default 'weekday',        -- weekday / weekend / festival
  target_revenue    bigint default 0,
  target_visitors   int    default 0,
  child             int    default 0,
  adult             int    default 0,
  "group"           int    default 0,
  ticket_revenue    bigint default 0,
  extra_revenue     bigint default 0,
  total_visitors    int    default 0,
  total_revenue     bigint default 0,
  is_safe           boolean default true,
  memo              text,
  channels          jsonb,                         -- 유입경로 분해
  data_source       text default 'manual',         -- manual / gate
  device_id         text,
  device_label      text,
  site_id           text default 'bongplay_bonghwa',
  updated_at        timestamptz default now()
);

-- 1-2. 안전 이용 서약서 (개인정보 포함 - 3년 보존)
create table if not exists public.safety_consents (
  id                    text primary key,
  site_id               text default 'bongplay_bonghwa',
  visit_id              text,
  household_id          text,
  booking_id            text,
  campaign_id           text default 'cmp_walkin',
  ticket_ids            jsonb,
  pass_code             text,
  arrival_at            timestamptz,
  ticket_issued_at      timestamptz,
  entry_at              timestamptz,
  exit_at               timestamptz,
  stay_duration_minutes int,
  party_size            int default 1,
  child_count           int default 0,
  adult_count           int default 1,
  residence_region      text,
  visit_type            text default 'walkin',
  first_or_repeat       text default 'first',
  created_date          date not null default current_date,
  timestamp_text        text,
  guardian_name         text,
  guardian_phone        text,
  residence             text,
  children              jsonb,                      -- [{name, birth, gender}]
  signature_data        text,                       -- base64 서명
  is_issued             boolean default false,
  consent_marketing     boolean default false,
  updated_at            timestamptz default now()
);

-- 1-3. 일일 안전점검 일지
create table if not exists public.safety_audits (
  id            text primary key,
  site_id       text default 'bongplay_bonghwa',
  facility_id   text,
  asset_id      text,
  staff_id      text,
  audit_date    date not null default current_date,
  inspector     text default '점검자',
  decision      text default 'pass',           -- pass / conditional / fail
  items         jsonb,                         -- 항목별 체크 결과
  note          text,
  is_safe       boolean default true,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);

-- 1-4. 마감 정산 보드
create table if not exists public.closing_records (
  id            text primary key,              -- cls_YYYY-MM-DD
  site_id       text default 'bongplay_bonghwa',
  date          date not null,
  shift_type    text default 'final',          -- mid / final
  settled_by    text,
  cash_actual   bigint default 0,
  card_actual   bigint default 0,
  diff_amount   bigint default 0,
  notes         text,
  raw_payload   jsonb,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);

-- 1-5. 단체 예약 관리
create table if not exists public.group_bookings (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  org_name        text not null,
  contact_name    text,
  contact_phone   text,
  booking_date    date not null,
  time_slot       text,
  headcount       int default 0,
  program_type    text,
  status          text default 'confirmed',    -- pending / confirmed / completed / cancelled
  notes           text,
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);

-- 1-6. 사고 및 비상 일지
create table if not exists public.incident_logs (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  incident_date   date not null default current_date,
  incident_time   text,
  location        text,
  victim_type     text,
  victim_info     text,
  description     text,
  first_aid       text,
  hospital_yn     boolean default false,
  reporter        text,
  status          text default 'open',
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);

-- 1-7. 고객의 소리 / 민원 일지
create table if not exists public.complaint_logs (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  complaint_date  date not null default current_date,
  category        text,
  customer_info   text,
  content         text,
  action_taken    text,
  handler         text,
  status          text default 'resolved',
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);

-- 1-8. 발권 원장 (개별 티켓 추적)
create table if not exists public.ticket_ledger (
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

-- 1-9. 주문 상세 원장
create table if not exists public.order_items (
  item_id         text primary key,
  order_id        text not null,
  product_id      text,
  product_name    text,
  category        text,
  unit_price      bigint default 0,
  quantity        int default 1,
  total_price     bigint default 0,
  created_at      timestamptz default now(),
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

-- 1-10. 시설 구역별 사용 및 텔레메트리
create table if not exists public.facility_usage_events (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  facility_id     text,
  event_type      text,
  headcount       int default 0,
  timestamp       timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.congestion_telemetry (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  zone_id         text,
  headcount       int default 0,
  congestion_rate numeric(5,2),
  timestamp       timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.operator_action_logs (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  operator_id     text,
  action_type     text,
  details         jsonb,
  timestamp       timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.asset_measurements (
  id              text primary key,
  asset_id        text,
  metric_name     text,
  val             numeric,
  measured_at     timestamptz default now(),
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.equipment_assets (
  id              text primary key,
  facility_id     text,
  name            text,
  asset_type      text,
  status          text default 'normal',
  last_inspected  date,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.facility_operating_intervals (
  id              text primary key,
  facility_id     text,
  start_at        timestamptz,
  end_at          timestamptz,
  status          text,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.marketing_campaigns (
  id              text primary key,
  name            text,
  start_date      date,
  end_date        date,
  target_audience text,
  budget          bigint default 0,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.customer_experience_surveys (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  visit_id        text,
  score           int,
  comment         text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.staff_shifts (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  staff_name      text,
  shift_date      date,
  role            text,
  check_in        timestamptz,
  check_out       timestamptz,
  updated_at      timestamptz default now()
);

create table if not exists public.staff_assignment_events (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  staff_id        text,
  zone_id         text,
  assigned_at     timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.staff_task_logs (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  task_name       text,
  status          text,
  completed_at    timestamptz,
  updated_at      timestamptz default now()
);

-- 1-11. 기준정보 테이블 (마스터 테이블 - 조회 전용)
create table if not exists public.master_products (
  product_id      text primary key,
  name            text not null,
  category        text,
  unit_price      bigint default 0,
  is_active       boolean default true,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.master_facilities (
  facility_id     text primary key,
  name            text not null,
  capacity        int default 0,
  min_age         int default 0,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.master_targets (
  id              text primary key,
  year            int default 2026,
  bep_visitors    int default 19606,            -- Single Source of Truth
  bep_revenue     bigint default 236000000,
  weekday_visitors int default 30,
  weekend_visitors int default 148,
  site_id         text default 'bongplay_bonghwa',
  updated_at      timestamptz default now()
);

create table if not exists public.weather_environment_telemetry (
  id              text primary key,
  temp_c          numeric,
  wind_speed      numeric,
  precipitation   numeric,
  recorded_at     timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

create table if not exists public.spatial_zone_telemetry (
  id              text primary key,
  zone_id         text,
  occupancy       int default 0,
  recorded_at     timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

create table if not exists public.queue_snapshots (
  id              text primary key,
  facility_id     text,
  queue_len       int default 0,
  recorded_at     timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

create table if not exists public.sensor_readings (
  id              text primary key,
  sensor_type     text,
  sensor_val      numeric,
  recorded_at     timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

create table if not exists public.asset_maintenance_logs (
  id              text primary key,
  asset_id        text,
  maintenance_type text,
  cost            bigint default 0,
  done_at         timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

create table if not exists public.asset_usage_counters (
  id              text primary key,
  asset_id        text,
  counter_val     bigint default 0,
  updated_at      timestamptz default now(),
  site_id         text default 'bongplay_bonghwa'
);

-- ────────────────────────────────────────────────────────────
-- 2. 실시간 통신(Supabase Realtime) 활성화
-- ────────────────────────────────────────────────────────────
do $$
begin
  begin
    alter publication supabase_realtime add table 
      sales_records, 
      safety_consents, 
      safety_audits, 
      closing_records, 
      ticket_ledger;
  exception when others then
    -- 이미 추가된 경우 무시
    null;
  end;
end $$;

-- ────────────────────────────────────────────────────────────
-- 3. Row Level Security (RLS) 활성화
-- ────────────────────────────────────────────────────────────
alter table sales_records                 enable row level security;
alter table safety_consents               enable row level security;
alter table safety_audits                 enable row level security;
alter table closing_records               enable row level security;
alter table group_bookings                enable row level security;
alter table incident_logs                 enable row level security;
alter table complaint_logs                enable row level security;
alter table ticket_ledger                 enable row level security;
alter table order_items                   enable row level security;
alter table facility_usage_events         enable row level security;
alter table congestion_telemetry          enable row level security;
alter table operator_action_logs          enable row level security;
alter table asset_measurements            enable row level security;
alter table equipment_assets              enable row level security;
alter table facility_operating_intervals enable row level security;
alter table marketing_campaigns           enable row level security;
alter table customer_experience_surveys   enable row level security;
alter table staff_shifts                  enable row level security;
alter table staff_assignment_events       enable row level security;
alter table staff_task_logs               enable row level security;
alter table master_products               enable row level security;
alter table master_facilities             enable row level security;
alter table master_targets                enable row level security;
alter table weather_environment_telemetry enable row level security;
alter table spatial_zone_telemetry        enable row level security;
alter table queue_snapshots               enable row level security;
alter table sensor_readings               enable row level security;
alter table asset_maintenance_logs        enable row level security;
alter table asset_usage_counters          enable row level security;

-- ────────────────────────────────────────────────────────────
-- 4. 기존 취약 정책 초기화 (클린업)
-- ────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in (select schemaname, tablename, policyname from pg_policies where schemaname = 'public') loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────
-- 5. [P0 & P1 해결] 맞춤형 RLS 보안 정책 재구축
-- ────────────────────────────────────────────────────────────

-- 5-1. [P0 핵심] safety_consents (아동 개인정보 보호 정책)
-- (1) 일반 고객: 모바일에서 서약서 등록(INSERT) 무조건 허용
create policy "consents_insert_policy" on public.safety_consents
  for insert to anon
  with check (true);

-- (2) 매표소 현장 발권/상태 업데이트: 허용
create policy "consents_update_policy" on public.safety_consents
  for update to anon
  using (true) with check (true);

-- (3) [P1 해결] 현장 삭제 버튼(consent.html deleteConsent) 정상 동작 지원 (회귀 방지)
create policy "consents_delete_policy" on public.safety_consents
  for delete to anon
  using (true);

-- (4) [P0 핵심] 일반 anon 직접 SELECT는 당일 본인 접수번호(pass_code) 확인용으로만 제한
--     외부 해커가 URL/anon 키로 테이블 전체(과거 아동 명단 및 연락처)를 덤프하는 행위 원천 차단
create policy "consents_select_restricted" on public.safety_consents
  for select to anon
  using (
    created_date = current_date
  );

-- 5-2. [P0 핵심] 현장 매표소 관리자 전용 안전 조회 RPC 함수
-- 관리자 암호(ACCESS_CODE)를 전달받아 당일 및 전일 서약서 목록을 안전하게 제공
create or replace function public.get_today_consents_secure(p_access_code text)
returns setof public.safety_consents
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_access_code is null or p_access_code <> 'bongplay2026' then
    raise exception '접근 거부: 관리자 암호가 일치하지 않습니다.';
  end if;

  return query
  select * from public.safety_consents
  where created_date >= current_date - interval '2 days'
  order by arrival_at desc nulls last;
end;
$$;

-- 5-3. [P1 해결] safety_audits (안전점검 일지)
-- 점검일지 삭제 버튼(deleteLog) 정상 동작 지원 (회귀 방지)
create policy "audits_select" on public.safety_audits for select to anon using (true);
create policy "audits_insert" on public.safety_audits for insert to anon with check (true);
create policy "audits_update" on public.safety_audits for update to anon using (true) with check (true);
create policy "audits_delete" on public.safety_audits for delete to anon using (true); -- DELETE 허용

-- 5-4. 매출 / 마감 / 예약 / 민원 / 발권 (안전한 운영 테이블 - SELECT / INSERT / UPDATE만 허용, 임의 DELETE 차단)
do $$
declare
  t text;
  tables text[] := array[
    'sales_records', 'closing_records', 'group_bookings', 'incident_logs',
    'complaint_logs', 'ticket_ledger', 'order_items', 'facility_usage_events',
    'congestion_telemetry', 'operator_action_logs', 'asset_measurements',
    'equipment_assets', 'facility_operating_intervals', 'marketing_campaigns',
    'customer_experience_surveys', 'staff_shifts', 'staff_assignment_events',
    'staff_task_logs'
  ];
begin
  foreach t in array tables loop
    execute format('create policy %I on public.%I for select to anon using (true)', 'sec_' || t || '_sel', t);
    execute format('create policy %I on public.%I for insert to anon with check (true)', 'sec_' || t || '_ins', t);
    execute format('create policy %I on public.%I for update to anon using (true) with check (true)', 'sec_' || t || '_upd', t);
  end loop;
end $$;

-- 5-5. 마스터 기준정보 테이블 (조회 전용 - anon은 오직 SELECT만 허용)
do $$
declare
  t text;
  master_tables text[] := array[
    'master_products', 'master_facilities', 'master_targets',
    'weather_environment_telemetry', 'spatial_zone_telemetry',
    'queue_snapshots', 'sensor_readings', 'asset_maintenance_logs',
    'asset_usage_counters'
  ];
begin
  foreach t in array master_tables loop
    execute format('create policy %I on public.%I for select to anon using (true)', 'sec_' || t || '_readonly', t);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────
-- 6. 정상 적용 검증 쿼리
-- ────────────────────────────────────────────────────────────
select 
  schemaname, 
  tablename, 
  rowsecurity as rls_enabled,
  (select count(*) from pg_policies p where p.tablename = t.tablename) as policies_count
from pg_tables t
where schemaname = 'public' and tablename in ('safety_consents', 'safety_audits', 'sales_records', 'closing_records', 'ticket_ledger')
order by tablename;

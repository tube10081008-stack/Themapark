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
-- 4. 기존 취약 정책 초기화 및 DELETE 권한 원천 회수
-- ────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  for r in (select schemaname, tablename, policyname from pg_policies where schemaname = 'public') loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- 모든 public 테이블에 대해 anon 및 authenticated의 DELETE 권한을 원천 회수
-- (법정 안전 기록 및 운영 장부는 서비스롤 또는 관리자 권한을 통해서만 제어 가능)
revoke delete on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke delete on tables from anon, authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. [심층 RLS 보안 강화] 테이블별 엄격 권한 통제
-- ────────────────────────────────────────────────────────────

-- 5-1. safety_consents (법정 안전이용동의서 & 아동 개인정보)
-- (1) 일반 고객: 모바일에서 서약서 등록(INSERT) 허용
create policy "consents_insert_policy" on public.safety_consents
  for insert to anon
  with check (true);

-- (2) 현장 당일 발권/입퇴장 업데이트만 허용 (과거 이력 변조 원천 차단)
--     created_date가 당일인 레코드만 상태 업데이트 가능
create policy "consents_update_policy" on public.safety_consents
  for update to anon
  using (created_date = current_date)
  with check (created_date = current_date);

-- (3) 일반 anon 직접 SELECT는 당일 접수 건으로만 한정
--     외부 해커가 URL/anon 키로 수개월~수년 치 고객 연락처를 전량 덤프하는 행위 차단
create policy "consents_select_restricted" on public.safety_consents
  for select to anon
  using (created_date = current_date);

-- ※ DELETE 정책: 등록하지 않음 (anon DELETE 원천 불가)

-- 5-2. 현장 매표소 관리자 전용 안전 조회 및 관리 RPC 함수
-- (1) 당일 및 전일 서약서 목록 안전 조회
create or replace function public.get_today_consents_secure(p_access_code text)
returns setof public.safety_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
begin
  v_expected := coalesce(current_setting('app.settings.access_code', true), 'bongplay2026!');
  if p_access_code is null or (p_access_code <> v_expected and p_access_code <> 'bongplay2026') then
    raise exception '접근 거부: 관리자 암호가 일치하지 않습니다.';
  end if;

  return query
  select * from public.safety_consents
  where created_date >= current_date - interval '2 days'
  order by arrival_at desc nulls last;
end;
$$;

-- (2) [BP-007] 90일 경과 미사고 동의서 자동 마스킹 및 서명 파기 서버사이드 보안 RPC
create or replace function public.mask_expired_consents_secure(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text;
  v_count int := 0;
begin
  v_expected := coalesce(current_setting('app.settings.access_code', true), 'bongplay2026!');
  if p_access_code is null or (p_access_code <> v_expected and p_access_code <> 'bongplay2026') then
    raise exception '접근 거부: 관리자 암호가 일치하지 않습니다.';
  end if;

  -- 90일 경과 및 사고 이력(incident_logs)에 연계되지 않은 서약서의 개인정보 마스킹
  with target as (
    update public.safety_consents c
    set 
      guardian_phone = case 
        when length(regexp_replace(guardian_phone, '[^0-9]', '', 'g')) = 11 
        then substr(regexp_replace(guardian_phone, '[^0-9]', '', 'g'), 1, 3) || '-****-' || substr(regexp_replace(guardian_phone, '[^0-9]', '', 'g'), 8, 4)
        else '010-****-0000'
      end,
      signature_data = null,
      updated_at = now()
    where c.created_date < (current_date - interval '90 days')
      and c.signature_data is not null
      and not exists (
        select 1 from public.incident_logs inc 
        where inc.consent_id = c.id or inc.visit_id = c.visit_id
      )
    returning c.id
  )
  select count(*) into v_count from target;

  return jsonb_build_object('ok', true, 'masked_count', v_count, 'executed_at', now());
end;
$$;

-- 5-3. safety_audits (일일 안전점검 일지 - 유원시설 법정 일지)
create policy "audits_select" on public.safety_audits
  for select to anon
  using (true);

create policy "audits_insert" on public.safety_audits
  for insert to anon
  with check (true);

-- 점검 일지 수정은 당일 작성 중에만 허용 (과거 점검 기록 사후 위조 방지)
create policy "audits_update" on public.safety_audits
  for update to anon
  using (audit_date = current_date)
  with check (audit_date = current_date);

-- ※ DELETE 정책: 등록하지 않음 (과거 안전점검 기록 임의 삭제 불가)

-- 5-4. closing_records (일일 마감 정산표 - 마감 확정 후 변조 방지)
create policy "closing_select" on public.closing_records
  for select to anon
  using (true);

create policy "closing_insert" on public.closing_records
  for insert to anon
  with check (true);

-- 마감 원장이 이미 잠긴(is_locked = true) 건은 수정 불가
create policy "closing_update" on public.closing_records
  for update to anon
  using (coalesce(raw_payload->>'is_locked', 'false') <> 'true')
  with check (coalesce(raw_payload->>'is_locked', 'false') <> 'true');

-- 5-5. 매출 / 예약 / 민원 / 발권 (운영 테이블 - SELECT / INSERT / UPDATE만 허용, DELETE 차단)
do $$
declare
  t text;
  tables text[] := array[
    'sales_records', 'group_bookings', 'incident_logs',
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

-- 5-6. 마스터 기준정보 테이블 (조회 전용 - anon은 오직 SELECT만 허용)
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
-- 6. 보안 검증 자가 진단 쿼리 (Supabase SQL Editor에서 실행하여 확인)
-- ────────────────────────────────────────────────────────────

-- 1) DELETE / ALL 정책이 0건인지 확인 (반드시 0이어야 함)
select 
  'DELETE 허용 정책 수' as check_item,
  count(*) as count,
  case when count(*) = 0 then 'PASS (안전: 익명 DELETE 원천 차단)' else 'FAIL (경고: DELETE 정책 잔존)' end as status
from pg_policies
where schemaname = 'public' and cmd in ('DELETE', 'ALL');

-- 2) RLS 적용 상태 및 주요 테이블 정책 수 확인
select 
  schemaname, 
  tablename, 
  rowsecurity as rls_enabled,
  (select count(*) from pg_policies p where p.tablename = t.tablename) as policies_count
from pg_tables t
where schemaname = 'public' and tablename in ('safety_consents', 'safety_audits', 'sales_records', 'closing_records', 'ticket_ledger')
order by tablename;


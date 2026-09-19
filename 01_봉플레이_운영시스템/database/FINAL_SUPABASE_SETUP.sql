-- ============================================================
-- 🌟 봉플레이 운영시스템 — 최종 통합 마스터 DB 설정 스크립트 (FINAL_SUPABASE_SETUP.sql)
-- ------------------------------------------------------------
-- 버전: v2026.FINAL-r2 (2026-09-18 워크플로우 정합성 수정)
-- 포함 내용:
--   1. 전체 29개 테이블 스키마 및 최신 컬럼 정의 (IF NOT EXISTS)
--   1-12. 프런트 기록 필드 ↔ DB 컬럼 정합성 보강 (결제수단·사고연계·마감잠금 등)
--   2. 실시간 동기화(Supabase Realtime) 채널 활성화 (테이블별 개별 등록)
--   3. safety_consents 아동 개인정보 보호 (과거 이력 조회·수정·삭제 차단)
--   4. 전 테이블 Row Level Security (RLS) 최소 권한, anon DELETE 전면 회수
--   5-2. 서버 검증형 운영자 인증 (bcrypt, 대입 공격 잠금) · 90일 개인정보 마스킹 · 사고 연계 3년 보존
--   5-4. 마감 확정 후 원장 수정 차단
--   5-7. pg_cron 새벽 3시 자동 마스킹
-- ------------------------------------------------------------
-- 실행 방법:
--   1. https://supabase.com 접속 ➔ 봉플레이 프로젝트 선택
--   2. 좌측 메뉴 [SQL Editor] ➔ [New query] 클릭
--   3. 본 파일 내용 전체를 복사하여 붙여넣고 우측 하단 [Run] 클릭
--   4. ★ 최초 1회: 5-2 절 안내에 따라 운영자 암호를 등록 (등록 전에는 대시보드 로그인 불가)
--   5. (선택) Database > Extensions 에서 pg_cron 활성화 후 이 파일을 한 번 더 실행
--
-- ※ 이 스크립트는 여러 번 실행해도 안전합니다(멱등). 한 문장이라도 실패하면 전체가
--   롤백되므로, 실행 결과 하단에 오류가 없는지 반드시 확인하십시오.
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
  signature_data text,                         -- 점검자 전자서명 (Base64)
  is_safe       boolean default true,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);
alter table public.safety_audits add column if not exists signature_data text;

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

-- 1-12. 스키마 정합성 보강 (프런트가 실제로 기록하는 필드 ↔ DB 컬럼)
--   이전 스크립트(supabase_setup.sql)와 이 파일의 테이블 정의가 서로 달라,
--   어느 쪽으로 먼저 만들어졌든 프런트 기록이 누락되지 않도록 컬럼을 맞춥니다.
--   (누락 컬럼은 bongplay-sync.js 가 조용히 버리므로, 결제수단·잠금 여부 같은
--    핵심 값이 DB에 도달하지 못하던 원인입니다.)

-- (1) order_items: POS 결제 원장 (bongplay-id.js createOrder)
alter table public.order_items add column if not exists id               text;
alter table public.order_items add column if not exists item_id          text;
alter table public.order_items add column if not exists visit_id         text;
alter table public.order_items add column if not exists purchased_at     timestamptz;
alter table public.order_items add column if not exists sales_channel    text;
alter table public.order_items add column if not exists product_category text;
alter table public.order_items add column if not exists list_price       bigint default 0;
alter table public.order_items add column if not exists discount_amount  bigint default 0;
alter table public.order_items add column if not exists paid_amount      bigint default 0;
alter table public.order_items add column if not exists payment_method   text;
alter table public.order_items add column if not exists coupon_id        text;
alter table public.order_items add column if not exists staff_id         text;
alter table public.order_items add column if not exists device_id        text;
alter table public.order_items add column if not exists device_label     text;
create index if not exists idx_order_items_purchased on public.order_items (purchased_at desc);

-- (2) incident_logs: 비상 키오스크 사고 보고 (emergency.html) + 디스코드 트리거 참조 컬럼
alter table public.incident_logs add column if not exists incident_date      date default current_date;
alter table public.incident_logs add column if not exists occurred_at        text;
alter table public.incident_logs add column if not exists facility_id        text;
alter table public.incident_logs add column if not exists victim_name        text;
alter table public.incident_logs add column if not exists action_taken       text;
alter table public.incident_logs add column if not exists hospital_transport text;
alter table public.incident_logs add column if not exists reported_by        text;
alter table public.incident_logs add column if not exists created_at         timestamptz default now();
alter table public.incident_logs add column if not exists severity           text;
alter table public.incident_logs add column if not exists target_type        text;
alter table public.incident_logs add column if not exists called_119         boolean default false;
alter table public.incident_logs add column if not exists notified_guardian  boolean default false;
alter table public.incident_logs add column if not exists consent_id         text;   -- 연계 서약서 (법적 보존)
alter table public.incident_logs add column if not exists visit_id           text;
create index if not exists idx_incident_consent on public.incident_logs (consent_id);
create index if not exists idx_incident_visit   on public.incident_logs (visit_id);

-- (3) closing_records: 마감 정산 (closing.html) + 잠금 전용 컬럼
alter table public.closing_records add column if not exists manager      text;
alter table public.closing_records add column if not exists staff        jsonb;
alter table public.closing_records add column if not exists cash         jsonb;
alter table public.closing_records add column if not exists actual_cash  bigint default 0;
alter table public.closing_records add column if not exists diff         bigint default 0;
alter table public.closing_records add column if not exists system_cash  bigint default 0;
alter table public.closing_records add column if not exists system_card  bigint default 0;
alter table public.closing_records add column if not exists raw_payload  jsonb;
alter table public.closing_records add column if not exists is_locked    boolean not null default false;
alter table public.closing_records add column if not exists locked_at    timestamptz;

-- (4) safety_consents: 법적 보존 기한 및 마스킹 이력
alter table public.safety_consents add column if not exists legal_hold_until date;       -- 사고 연계 시 +3년
alter table public.safety_consents add column if not exists pii_masked_at    timestamptz;

-- ────────────────────────────────────────────────────────────
-- 2. 실시간 통신(Supabase Realtime) 활성화
-- ────────────────────────────────────────────────────────────
-- 테이블을 한 번에 추가하면 하나라도 이미 등록된 경우 문장 전체가 실패해
-- 나머지 테이블까지 누락되므로, 테이블별로 개별 등록합니다.
do $$
declare
  t text;
begin
  foreach t in array array['sales_records', 'safety_consents', 'safety_audits',
                           'closing_records', 'ticket_ledger', 'order_items'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
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

-- 5-2. 현장 운영자 인증 및 개인정보 보안 함수
-- ────────────────────────────────────────────────────────────
-- [설계 원칙]
--   · 운영자 암호는 브라우저에 두지 않습니다. (config.js 는 누구나 열람 가능)
--     → 암호의 bcrypt 해시만 API 로 노출되지 않는 private 스키마에 저장하고,
--       검증은 DB 함수만 수행합니다. 하드코딩된 기본 암호는 없습니다.
--   · 암호 대입 공격 방지: 접속 IP 별로 10분 내 20회 실패 시 잠금.
--   · 암호가 틀려도 예외를 던지지 않고 빈 결과를 돌려줍니다.
--     (예외를 던지면 실패 기록까지 롤백되어 대입 방지가 무력화됩니다.)
--
-- [최초 1회 필수] 이 스크립트 실행 후 SQL Editor 에서 운영자 암호(6자 이상)를 등록하십시오.
--   insert into private.app_settings (key, value)
--   values ('access_code', extensions.crypt('여기에-새-암호', extensions.gen_salt('bf')))
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--   ※ 등록 전에는 모든 대시보드 로그인이 거부됩니다. 암호 변경도 같은 문장으로 합니다.
-- ────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz default now()
);

create table if not exists private.auth_attempts (
  id            bigserial primary key,
  client_ip     text,
  ok            boolean not null,
  attempted_at  timestamptz not null default now()
);
create index if not exists idx_auth_attempts_ip on private.auth_attempts (client_ip, attempted_at desc);

-- (1) 암호 검증 (내부 전용)
create or replace function private.verify_access_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = private, extensions, public
as $$
declare
  v_hash  text;
  v_ip    text;
  v_fails int;
  v_ok    boolean := false;
begin
  begin
    v_ip := split_part(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ',', 1);
  exception when others then
    v_ip := null;
  end;
  v_ip := coalesce(nullif(trim(v_ip), ''), 'unknown');

  select count(*) into v_fails
    from private.auth_attempts
   where client_ip = v_ip and not ok and attempted_at > now() - interval '10 minutes';
  if v_fails >= 20 then
    return false;
  end if;

  select value into v_hash from private.app_settings where key = 'access_code';
  if v_hash is not null and v_hash like '$2%' and p_code is not null and length(p_code) >= 6 then
    v_ok := extensions.crypt(p_code, v_hash) = v_hash;
  end if;

  insert into private.auth_attempts (client_ip, ok) values (v_ip, v_ok);
  delete from private.auth_attempts where attempted_at < now() - interval '1 day';
  return v_ok;
end;
$$;

-- (2) 대시보드 로그인 RPC (config.js 인증 창이 호출)
create or replace function public.verify_staff_access(p_access_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select private.verify_access_code(p_access_code);
$$;

-- (3) 매표소 서약서 조회 (당일 포함 최근 3일) — 암호 불일치 시 빈 결과
create or replace function public.get_today_consents_secure(p_access_code text)
returns setof public.safety_consents
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.verify_access_code(p_access_code) then
    return;
  end if;

  return query
  select * from public.safety_consents
  where created_date >= current_date - interval '2 days'
  order by arrival_at desc nulls last;
end;
$$;

-- (4) 개인정보 마스킹 도우미: 홍길동 → 홍*동, 김철 → 김*
create or replace function private.mask_name(p text)
returns text
language sql
immutable
as $$
  select case
    when p is null or length(trim(p)) = 0 then p
    when length(p) = 1 then '*'
    when length(p) = 2 then left(p, 1) || '*'
    else left(p, 1) || repeat('*', length(p) - 2) || right(p, 1)
  end;
$$;

-- 동반 아동 배열: 이름 마스킹 + 생년월일은 연도만 남김 (연령 통계용)
create or replace function private.mask_children(p jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'array' then p
    else coalesce((
      select jsonb_agg(
        case jsonb_typeof(elem)
          when 'string' then to_jsonb(private.mask_name(elem #>> '{}'))
          when 'object' then
            elem
            || case when elem ? 'name'  then jsonb_build_object('name', private.mask_name(elem->>'name')) else '{}'::jsonb end
            || case when elem ? 'birth' then jsonb_build_object('birth', left(elem->>'birth', 4))      else '{}'::jsonb end
          else elem
        end)
      from jsonb_array_elements(p) as elem
    ), '[]'::jsonb)
  end;
$$;

-- (5) [BP-007] 개인정보 수명주기 처리 (크론 전용 내부 함수)
--   대상: 접수 90일 경과 + 미마스킹 + 법적 보존기한 없음/만료 + 최근 3년 내 사고 연계 없음
--   처리: 보호자·아동 성명 마스킹, 연락처 뒷 4자리만 보존, 전자서명 원본 영구 삭제
create or replace function private.mask_expired_consents_internal()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  with target as (
    update public.safety_consents c
    set
      guardian_name  = private.mask_name(c.guardian_name),
      guardian_phone = case
        when c.guardian_phone is null then null
        when length(regexp_replace(c.guardian_phone, '[^0-9]', '', 'g')) = 11
          then substr(regexp_replace(c.guardian_phone, '[^0-9]', '', 'g'), 1, 3) || '-****-'
               || right(regexp_replace(c.guardian_phone, '[^0-9]', '', 'g'), 4)
        else '***-****-' || right(regexp_replace(c.guardian_phone, '[^0-9]', '', 'g'), 4)
      end,
      children       = private.mask_children(c.children),
      signature_data = null,
      pii_masked_at  = now(),
      updated_at     = now()
    where c.created_date < (current_date - interval '90 days')
      and c.pii_masked_at is null
      and (c.legal_hold_until is null or c.legal_hold_until < current_date)
      and not exists (
        select 1 from public.incident_logs inc
        where (inc.consent_id = c.id or (c.visit_id is not null and inc.visit_id = c.visit_id))
          and coalesce(inc.incident_date, current_date) > current_date - interval '3 years'
      )
    returning c.id
  )
  select count(*) into v_count from target;

  return jsonb_build_object('ok', true, 'masked_count', v_count, 'executed_at', now());
end;
$$;

-- (6) 관리 화면 수동 실행용 RPC (management.html) — 암호 불일치 시 실행 거부
create or replace function public.mask_expired_consents_secure(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.verify_access_code(p_access_code) then
    return jsonb_build_object('ok', false, 'error', 'access_denied');
  end if;
  return private.mask_expired_consents_internal();
end;
$$;

-- (7) 사고 일지 저장 시 연계 서약서에 3년 법적 보존 플래그 자동 설정
create or replace function private.trg_incident_legal_hold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.consent_id is not null or new.visit_id is not null then
    update public.safety_consents c
       set legal_hold_until = greatest(
             coalesce(c.legal_hold_until, current_date),
             (coalesce(new.incident_date, current_date) + interval '3 years')::date
           )
     where c.id = new.consent_id
        or (new.visit_id is not null and c.visit_id = new.visit_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_incident_legal_hold on public.incident_logs;
create trigger trg_incident_legal_hold
  after insert or update of consent_id, visit_id on public.incident_logs
  for each row execute function private.trg_incident_legal_hold();

-- (8) 실행 권한 정리: 내부 함수·테이블은 외부 호출 차단, RPC 3종만 anon 허용
revoke all on all tables    in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.verify_staff_access(text)          from public;
revoke all on function public.get_today_consents_secure(text)    from public;
revoke all on function public.mask_expired_consents_secure(text) from public;
grant execute on function public.verify_staff_access(text)          to anon, authenticated;
grant execute on function public.get_today_consents_secure(text)    to anon, authenticated;
grant execute on function public.mask_expired_consents_secure(text) to anon, authenticated;

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
--   · using      : "수정 전" 행 검사 → 잠긴 행은 아예 수정 대상이 되지 않음
--   · with check : "수정 후" 행 검사 → 잠금으로 바꾸는 것(마감 확정)은 허용해야 하므로 true
--   (이전 정책은 with check 에서도 잠금을 막아, 마감 확정 저장 자체가 거부되었습니다.
--    또 프런트가 채우지 않는 raw_payload 를 검사해 잠금이 한 번도 작동하지 않았습니다.)
create policy "closing_update" on public.closing_records
  for update to anon
  using (not is_locked)
  with check (true);

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

-- 5-7. 심야 자동화 스케줄 (매일 03:00 KST)
--   ※ 바깥 블록은 $cron_setup$, 크론 명령은 $cron_cmd$ 로 따옴표를 분리합니다.
--     (같은 $$ 를 중첩하면 바깥 블록이 그 지점에서 끝나 스크립트 전체가 롤백됩니다.)
--   ※ 크론은 postgres 권한으로 실행되므로 암호 없이 내부 함수를 직접 호출합니다.
do $cron_setup$
begin
  begin
    create extension if not exists pg_cron with schema extensions;
  exception when others then
    raise warning 'pg_cron 확장을 켤 수 없습니다 (Dashboard > Database > Extensions 에서 활성화): %', sqlerrm;
  end;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- 최초 실행 시에는 등록된 작업이 없어 unschedule 이 오류를 내므로 존재할 때만 해제
    if exists (select 1 from cron.job where jobname = 'daily_mask_expired_consents') then
      perform cron.unschedule('daily_mask_expired_consents');
    end if;
    perform cron.schedule(
      'daily_mask_expired_consents',
      '0 18 * * *', -- UTC 18:00 = KST 03:00
      $cron_cmd$select private.mask_expired_consents_internal()$cron_cmd$
    );
  else
    raise warning 'pg_cron 미설치: 개인정보 자동 마스킹 크론이 등록되지 않았습니다.';
  end if;
end $cron_setup$;

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


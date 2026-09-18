-- ============================================================
-- 봉플레이 운영시스템 Supabase 초기 설정 스크립트
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 실행하십시오.
-- ============================================================

-- ── 1. 매출 실적 (현장운영 대시보드) ──────────────────
create table if not exists sales_records (
  id            text primary key,              -- 날짜를 id로 사용 (YYYY-MM-DD)
  date          date not null,
  op_mode       text,                          -- weekday / weekend / festival
  target_revenue    bigint default 0,
  target_visitors   int    default 0,
  child         int    default 0,
  adult         int    default 0,
  "group"       int    default 0,
  ticket_revenue    bigint default 0,
  extra_revenue     bigint default 0,
  total_visitors    int    default 0,
  total_revenue     bigint default 0,
  is_safe       boolean default true,
  memo          text,
  channels      jsonb,                         -- 유입경로별 인원 분해 (인과관계 기록)
  data_source   text default 'manual',         -- manual(수기) / gate(게이트 자동)
  device_id     text,
  device_label  text,
  site_id       text default 'bongplay_bonghwa',
  updated_at    timestamptz default now()
);

-- ── 2. 안전 이용 동의서 (모바일 안전동의서) ───────────
-- 개인정보 포함 테이블. 보관기간 3년, 이후 파기 필요.
create table if not exists safety_consents (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  visit_id        text,                         -- 1회 방문 마스터 ID (vst_YYYYMMDD_XXXXXX)
  household_id    text,                         -- 단방향 해시 익명 가구 ID (hh_XXXXXXXX)
  booking_id      text,                         -- 예약 연계 ID
  campaign_id     text default 'cmp_walkin',    -- 유입 경로/캠페인 ID
  ticket_ids      jsonb,                        -- 발권된 개별 티켓 ID 목록
  pass_code       text,
  arrival_at      timestamptz,                  -- 고객 현장 도착 접수 시각
  ticket_issued_at timestamptz,                 -- 매표소 발권 완료 시각
  entry_at        timestamptz,                  -- 게이트 입장 시각
  exit_at         timestamptz,                  -- 최종 퇴장 시각
  stay_duration_minutes int,                    -- 실체류 시간 (분)
  party_size      int default 1,                -- 총 일행 수
  child_count     int default 0,                -- 동반 아동 수
  adult_count     int default 1,                -- 성인 보호자 수
  residence_region text,                        -- 거주지 권역 (봉화/영주/안동/외지)
  visit_type      text default 'walkin',        -- walkin / group_booking / member
  first_or_repeat text default 'first',         -- first / repeat (가구 재방문 여부)
  created_date    date not null,
  timestamp_text  text,
  guardian_name   text,
  guardian_phone  text,
  residence       text,
  children        jsonb,                        -- [{name, birth, ...}]
  signature_data  text,                         -- base64 PNG
  is_issued       boolean default false,
  consent_marketing boolean default false,      -- P1-3: 선택적 마케팅 혜택 및 AI 방문행동 최적화 분석 동의
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);

-- ── 3. 일일 안전점검 일지 ─────────────────────────────
create table if not exists safety_audits (
  id            text primary key,
  site_id       text default 'bongplay_bonghwa',
  facility_id   text,                            -- 시설 ID
  asset_id      text,                            -- 설비/부품 ID
  staff_id      text,                            -- 점검자 직원 ID
  audit_date    date not null,
  inspector     text,
  decision      text,                            -- pass / warn / fail
  items         jsonb,
  note          text,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);

-- ── 4. 마감 정산 / 교대 인수인계 ──────────────────────
create table if not exists closing_records (
  id            text primary key,               -- 날짜 기준
  site_id       text default 'bongplay_bonghwa',
  date          date not null,
  manager       text,
  staff         jsonb,
  cash          jsonb,
  actual_cash   bigint default 0,
  diff          bigint default 0,
  notes         text,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);

-- ── 5. 단체 예약 ──────────────────────────────────────
create table if not exists group_bookings (
  id            text primary key,
  site_id       text default 'bongplay_bonghwa',
  booking_id    text,                            -- 예약 고유 식별자 (bkg_...)
  visit_id      text,                            -- 방문 매핑 식별자
  household_id  text,                            -- 대표자 가구 ID
  campaign_id   text,                            -- 유입 캠페인 ID
  booking_date  date,
  org_name      text,
  contact_name  text,
  contact_phone text,
  headcount     int default 0,
  status        text,
  funnel_stage  text default 'inquiry',          -- P1-2: inquiry, consulted, quote_sent, tentative, contract_confirmed, deposit_paid, visit_completed, cancelled, no_show, re_proposal
  quoted_amount bigint default 0,
  paid_amount   bigint default 0,
  sales_owner   text default '홍성현',
  next_action_at timestamptz,
  quote_sent_at  timestamptz,
  confirmed_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  memo          text,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);


-- ── 6. 사고·아차사고 기록 (운영관리 통합보드) ────────
-- 보험 청구·분쟁 대응 증거자료. 개인정보(성명·연락처) 포함.
create table if not exists incident_logs (
  id                text primary key,
  site_id           text default 'bongplay_bonghwa',
  visit_id          text,                        -- 1회 방문 연계 ID
  household_id      text,                        -- 가구 익명 ID
  facility_id       text,                        -- 발생 시설 ID
  asset_id          text,                        -- 관련 장비/부품 ID
  staff_id          text,                        -- 조치 직원 ID
  occurred_at       text,                        -- 발생 일시
  severity          text,                        -- near_miss / minor / moderate / serious
  location          text,
  target_type       text,                        -- 이용 어린이 / 보호자 / 직원
  person_name       text,
  person_phone      text,
  description       text not null,               -- 발생 경위
  action_taken      text not null,               -- 조치 내용
  called_119        boolean default false,
  notified_guardian boolean default false,
  prevention        text,                        -- 재발 방지 대책
  reporter          text,
  device_id         text,
  device_label      text,
  updated_at        timestamptz default now()
);


-- ── 7. 민원 접수·처리 로그 ────────────────────────────
-- 계약서 제13조⑥: 중대 민원 연 2회 이상 시 허가 취소 가능.
-- "민원 0건" 기록 자체가 운영 신뢰의 근거가 된다.
create table if not exists complaint_logs (
  id              text primary key,
  site_id         text default 'bongplay_bonghwa',
  visit_id        text,                        -- 1회 방문 연계 ID
  household_id    text,                        -- 가구 익명 ID
  facility_id     text,                        -- 대상 시설 ID
  staff_id        text,                        -- 응대 직원 ID
  received_at     text,                        -- 접수 일시
  channel         text,                        -- 현장/전화/온라인/군청이첩 등
  complaint_type  text,                        -- 대기·혼잡 / 안전우려 / 응대 등
  severity        text,                        -- minor / normal / serious
  person_name     text,
  person_phone    text,
  content         text not null,               -- 민원 내용
  resolution      text,                        -- 처리 결과
  status          text,                        -- open / resolved / escalated
  resolved_at     text,
  prevention      text,                        -- 재발 방지 조치
  handler         text,
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);


-- ── 8. 개별 티켓 발권 원장 (티켓/손목밴드 단위 실시간 이력) ───────────
create table if not exists ticket_ledger (
  ticket_id       text primary key,
  site_id         text default 'bongplay_bonghwa',
  visit_id        text not null,
  household_id    text not null,
  visitor_id      text,
  ticket_type     text,                         -- child / adult / group
  issued_at       timestamptz default now(),
  status          text default 'active',        -- active / expired / cancelled
  device_id       text,
  device_label    text,
  updated_at      timestamptz default now()
);


-- ── 9. 주문 및 상품 항목 원장 (P0-1 Item-level Order Ledger) ──────────
create table if not exists order_items (
  id                text primary key,           -- ord_YYYYMMDD_XXXXXX_1
  order_id          text not null,
  site_id           text default 'bongplay_bonghwa',
  visit_id          text,                       -- 방문 세션 연계 키
  purchased_at      timestamptz default now(),
  sales_channel     text default 'pos_counter', -- pos_counter / kiosk / online
  product_id        text not null,              -- tkt_child_allday, fnb_apple_juice 등
  product_name      text not null,
  product_category  text not null,              -- ticket / fnb / addon_attraction / merchandise
  quantity          int default 1,
  list_price        bigint default 0,
  discount_amount   bigint default 0,
  paid_amount       bigint default 0,
  payment_method    text default 'card',        -- card / cash / local_currency / voucher
  coupon_id         text,
  staff_id          text,
  created_at        timestamptz default now()
);


-- ── 10. 시설 이용 이벤트 로그 (P0-3 Facility Usage Events) ──────────
create table if not exists facility_usage_events (
  id                text primary key,           -- evt_...
  event_id          text not null,
  site_id           text default 'bongplay_bonghwa',
  visit_id          text,                       -- 방문 세션 연계 키
  ticket_id         text,                       -- 개별 티켓/밴드 연계 키
  facility_id       text not null,              -- outdoor_coaster, indoor_trampoline 등
  entered_at        timestamptz default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  exited_at         timestamptz,
  result            text default 'completed',   -- completed / re_ride / cancelled_weather / height_weight_fail / customer_giveup
  stop_reason       text,
  operator_staff_id text,
  created_at        timestamptz default now()
);


-- ── 11. 대기열·혼잡도 시계열 텔레메트리 (P0-4 Queue Telemetry) ──────────
create table if not exists congestion_telemetry (
  id                      text primary key,     -- tel_...
  telemetry_id            text not null,
  site_id                 text default 'bongplay_bonghwa',
  facility_id             text not null,
  measured_at             timestamptz default now(),
  queue_count             int default 0,
  estimated_wait_minutes  int default 0,
  current_occupancy       int default 0,
  capacity                int default 20,
  throughput_last_15m     int default 0,
  status                  text default 'smooth',-- smooth / moderate / congested / paused / closed
  created_at              timestamptz default now()
);


-- ── 12. 운영 결정 행동 로그 (P0-5 Operator Action Logs: RL State→Action→Outcome) ──
create table if not exists operator_action_logs (
  id                  text primary key,         -- act_...
  action_id           text not null,
  site_id             text default 'bongplay_bonghwa',
  timestamp           timestamptz default now(),
  action_type         text not null,            -- staff_dispatch / facility_pause / facility_resume / group_routing / time_extension / discount_coupon / staff_reassign / flow_rerouting
  target_facility_id  text,
  previous_state      jsonb,
  new_state           jsonb,
  reason_code         text,
  decided_by          text,
  expected_effect     text,
  created_at          timestamptz default now()
);


-- ── 13. 안전설비 정량 측정값 원장 (P0-6 Asset Measurements: Predictive Maintenance) ──
create table if not exists asset_measurements (
  id                  text primary key,         -- meas_...
  inspection_event_id text not null,
  site_id             text default 'bongplay_bonghwa',
  asset_id            text not null,            -- zip_wire_main, outdoor_ground_bark 등
  inspection_item_id  text,                     -- 1_1, 1_2, 1_5 등
  metric_name         text not null,            -- tension, sag, bark_depth, sound_db 등
  measured_at         timestamptz default now(),
  measured_value      numeric not null,         -- 8.4, 27.5 등 정량 수치
  unit                text not null,            -- kN, cm, dB, %, MPa 등
  status              text default 'pass',      -- pass / warn / fail
  photo_url           text,
  inspector_id        text,
  notes               text,
  created_at          timestamptz default now()
);


-- ── 14. 장비 개체 단위 관리 대장 (P0-7 Individual Equipment Assets Registry) ──
create table if not exists equipment_assets (
  asset_id            text primary key,         -- HARNESS-001, TROLLEY-001 등
  site_id             text default 'bongplay_bonghwa',
  asset_name          text not null,
  asset_type          text not null,            -- harness_child, trolley_coaster, helmet_kids 등
  facility_id         text,                     -- outdoor_coaster 등
  purchased_at        date,
  first_used_at       date,
  usage_count         int default 0,            -- 누적 사용/주행 횟수
  last_inspected_at   date,
  last_cleaned_at     date,
  defect_count        int default 0,
  repair_history      jsonb default '[]'::jsonb,
  status              text default 'active',    -- active / warn / repair / retired
  retired_at          date,
  updated_at          timestamptz default now()
);


-- ── 15. 시설 가동·중단 시간 구간 원장 (P0-8 Facility Operating & Downtime Intervals) ──
create table if not exists facility_operating_intervals (
  id                  text primary key,         -- int_...
  interval_id         text not null,
  site_id             text default 'bongplay_bonghwa',
  facility_id         text not null,            -- outdoor_coaster, indoor_trampoline 등
  status              text not null,            -- OPEN, PAUSED_WEATHER, PAUSED_SAFETY, PAUSED_MAINTENANCE, CLOSED_CAPACITY, CLOSED_SCHEDULED
  started_at          timestamptz not null,
  ended_at            timestamptz,              -- null이면 현재 진행 중
  duration_minutes    int,                      -- 종료 시 자동 계산 (분)
  reason_code         text,                     -- weather_gust, scheduled_maintenance 등
  weather_snapshot_id text,
  approved_by         text,
  created_at          timestamptz default now()
);


-- ── 16. 마케팅 캠페인 및 CAC 원장 (P1-1 Marketing Campaigns & CAC) ──
create table if not exists marketing_campaigns (
  campaign_id       text primary key,         -- cmp_...
  campaign_name     text not null,
  channel           text not null,            -- mom_cafe, local_flyer, school_board, festival, blog, search_ad, walkin
  started_at        date not null,
  ended_at          date,
  cost              bigint default 0,         -- 집행 예산 (원)
  target_region     text,                     -- 봉화, 영주, 안동, 전국
  target_segment    text,                     -- 영유아부모, 초등단체, 주말가족
  coupon_code       text,                     -- 봉화사랑, 맘카페2026 등
  landing_source    text,
  status            text default 'active',    -- active, completed, paused
  created_at        timestamptz default now()
);

-- ── 17. 퇴장 고객 경험 및 NPS 설문 원장 (P1-4 Customer Experience & NPS Surveys) ──
create table if not exists customer_experience_surveys (
  survey_id             text primary key,     -- srv_...
  site_id               text default 'bongplay_bonghwa',
  visit_id              text not null,        -- vst_...
  household_id          text,                 -- hh_...
  campaign_id           text,                 -- cmp_...
  surveyed_at           timestamptz not null,
  satisfaction_score    int default 5,        -- 1~5 점
  recommendation_score  int default 10,       -- NPS 0~10 점
  wait_satisfaction     int default 4,        -- 대기시간 만족도 1~5 점
  favorite_facility     text,                 -- 최선호 놀이시설
  improvement_reason    text,                 -- 개선 필요 사항/불편사항
  revisit_intent        text default 'yes',   -- yes, maybe, no
  created_at            timestamptz default now()
);

-- ── 18. 근무 직원 시프트 원장 (P1-5 Staff Shifts) ──
create table if not exists staff_shifts (
  shift_id          text primary key,         -- shf_...
  site_id           text default 'bongplay_bonghwa',
  date              date not null,
  staff_id          text not null,            -- stf_...
  staff_name        text not null,
  role              text not null,            -- manager, safety_op, ticket_clerk, fnb_staff
  shift_type        text default 'full',      -- morning, afternoon, full, split
  start_scheduled   text,                     -- "09:00"
  end_scheduled     text,                     -- "18:00"
  clock_in          timestamptz,
  clock_out         timestamptz,
  assigned_zone     text,                     -- indoor_net, outdoor_coaster, ticket_gate, fnb_lounge
  hourly_rate       bigint default 10030,
  created_at        timestamptz default now()
);

-- ── 19. 혼잡 대응 근무자 동적 구역 재배치 이력 (P1-5 Staff Zone Assignment Events) ──
create table if not exists staff_assignment_events (
  event_id          text primary key,         -- sae_...
  site_id           text default 'bongplay_bonghwa',
  staff_id          text not null,
  staff_name        text not null,
  from_zone         text not null,
  to_zone           text not null,
  started_at        timestamptz not null,
  ended_at          timestamptz,
  reason            text not null,            -- congestion_relief, shift_break, safety_assist, relief_cover
  telemetry_id      text,                     -- 발동 트리거가 된 혼잡 텔레메트리
  created_at        timestamptz default now()
);

-- ── 20. 현장 작업별 소요 시간 측정 로그 (P1-6 Staff Task Execution Duration Logs) ──
create table if not exists staff_task_logs (
  task_log_id       text primary key,         -- tsk_...
  site_id           text default 'bongplay_bonghwa',
  task_type         text not null,            -- safety_check, facility_sanitization, customer_briefing, crowd_control, opening_prep, closing_clean
  facility_id       text,
  staff_id          text not null,
  started_at        timestamptz not null,
  completed_at      timestamptz,
  duration_minutes  int default 0,
  result            text default 'pass',      -- pass, rework, incomplete
  memo              text,
  created_at        timestamptz default now()
);


-- ============================================================
-- 보안 설정 (RLS: Row Level Security)
-- ------------------------------------------------------------
-- ⚠ 중요: anon key는 브라우저에 노출됩니다.
-- 아래는 "사내 3개 기기에서만 접속" 전제의 최소 설정입니다.
-- 외부 공개 환경이라면 반드시 인증(Auth)을 추가하십시오.
-- ============================================================

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

-- 운영 테이블: 현재 프론트엔드의 Cloud-First upsert 및 기기간 동기화에 필요한
-- SELECT / INSERT / UPDATE만 허용한다. DELETE 정책은 만들지 않고 권한도 회수한다.
-- 주의: anon 무로그인 구조이므로 사용자별 권한 분리는 되지 않는다.
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
    'staff_task_logs'
  ];
begin
  foreach t in array operational_tables
  loop
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


-- ── 조회 편의용 인덱스 (Causal Relational Graph Index) ──────────
create index if not exists idx_sales_date          on sales_records(date desc);
create index if not exists idx_consents_date       on safety_consents(created_date desc);
create index if not exists idx_consents_visit_id   on safety_consents(visit_id);
create index if not exists idx_consents_hh_id      on safety_consents(household_id);
create index if not exists idx_audits_date         on safety_audits(audit_date desc);
create index if not exists idx_closing_date        on closing_records(date desc);
create index if not exists idx_incident_date       on incident_logs(occurred_at desc);
create index if not exists idx_incident_visit_id   on incident_logs(visit_id);
create index if not exists idx_complaint_date      on complaint_logs(received_at desc);
create index if not exists idx_complaint_visit_id  on complaint_logs(visit_id);
create index if not exists idx_ticket_visit_id     on ticket_ledger(visit_id);
create index if not exists idx_ticket_hh_id        on ticket_ledger(household_id);
create index if not exists idx_order_visit_id      on order_items(visit_id);
create index if not exists idx_order_product_id    on order_items(product_id);
create index if not exists idx_facility_event_vis  on facility_usage_events(visit_id);
create index if not exists idx_facility_event_fac  on facility_usage_events(facility_id);
create index if not exists idx_telemetry_facility  on congestion_telemetry(facility_id, measured_at desc);
create index if not exists idx_action_logs_type    on operator_action_logs(action_type, timestamp desc);
create index if not exists idx_measurements_asset  on asset_measurements(asset_id, measured_at desc);
create index if not exists idx_equipment_type      on equipment_assets(asset_type, usage_count desc);
create index if not exists idx_intervals_fac_time  on facility_operating_intervals(facility_id, started_at desc);
create index if not exists idx_campaigns_channel   on marketing_campaigns(channel, started_at desc);
create index if not exists idx_surveys_visit_id    on customer_experience_surveys(visit_id);
create index if not exists idx_surveys_hh_id       on customer_experience_surveys(household_id);
create index if not exists idx_staff_shifts_date   on staff_shifts(date desc, staff_id);
create index if not exists idx_staff_assign_time   on staff_assignment_events(started_at desc);
create index if not exists idx_staff_task_type     on staff_task_logs(task_type, started_at desc);

-- ── 기존 배포 DB를 위한 컬럼 보강 (Idempotent Migration) ──────
alter table safety_consents add column if not exists consent_marketing boolean default false;
alter table group_bookings  add column if not exists funnel_stage text default 'inquiry';
alter table group_bookings  add column if not exists quoted_amount bigint default 0;
alter table group_bookings  add column if not exists paid_amount bigint default 0;
alter table group_bookings  add column if not exists sales_owner text default '홍성현';
alter table group_bookings  add column if not exists next_action_at timestamptz;
alter table group_bookings  add column if not exists quote_sent_at timestamptz;
alter table group_bookings  add column if not exists confirmed_at timestamptz;
alter table group_bookings  add column if not exists cancelled_at timestamptz;
alter table group_bookings  add column if not exists cancel_reason text;

-- ── 21. weather_environment_telemetry (Section 6: 10분 기상·환경 마이크로 텔레메트리) ──
create table if not exists weather_environment_telemetry (
  id                  text primary key,
  observed_at         timestamptz not null default now(),
  temperature         numeric(4,1) default 21.5,
  humidity            integer default 55,
  rainfall            numeric(5,1) default 0.0,
  wind_speed          numeric(4,1) default 3.2,
  wind_gust           numeric(4,1) default 4.8,     -- 순간최대풍속 (12.0m/s 이상 시 짚코스터 중단)
  wind_direction      text default 'NW',
  visibility          numeric(6,1) default 15000,
  snow_depth          numeric(4,1) default 0.0,
  weather_warning     text default 'none',
  indoor_temperature  numeric(4,1) default 22.8,
  indoor_humidity     integer default 48,
  created_at          timestamptz default now()
);

alter table weather_environment_telemetry enable row level security;
create policy "Allow all on weather_environment_telemetry" on weather_environment_telemetry for all using (true) with check (true);
create index if not exists idx_weather_observed_at on weather_environment_telemetry (observed_at desc);

-- ── 22. master_products (Section 7: 기준정보 표준화 - 상품/이용권 마스터 SSOT) ──
create table if not exists master_products (
  product_id          text primary key,
  product_name        text not null,
  product_category    text not null,
  price               integer not null,
  effective_from      date not null default '2026-01-01',
  effective_to        date,
  customer_type       text not null default 'all',
  season_type         text not null default 'regular',
  weekday_type        text not null default 'all',
  discount_rule_id    text default 'none',
  version             text not null default '2026.v1',
  description         text,
  is_active           boolean default true,
  created_at          timestamptz default now()
);

alter table master_products enable row level security;
create policy "Allow all on master_products" on master_products for all using (true) with check (true);

-- ── 23. master_facilities (Section 7: 기준정보 표준화 - 시설 제원 마스터 SSOT) ──
create table if not exists master_facilities (
  facility_id         text primary key,
  official_name       text not null,
  facility_type       text not null,
  capacity            integer not null,
  area_sqm            numeric(8,2) not null,
  operating_start     text default '10:00',
  operating_end       text default '18:00',
  safety_class        text default 'statutory_inspection_passed',
  version             text not null default '2026.v1',
  specs_json          jsonb,
  is_active           boolean default true,
  created_at          timestamptz default now()
);

alter table master_facilities enable row level security;
create policy "Allow all on master_facilities" on master_facilities for all using (true) with check (true);

-- ── 24. master_targets (Section 7: 기준정보 표준화 - 경영 BEP 목표 마스터 SSOT) ──
create table if not exists master_targets (
  target_id           text primary key,
  target_type         text not null,
  period_start        date not null default '2026-01-01',
  period_end          date not null default '2026-12-31',
  target_visitors     integer not null,
  target_revenue      bigint not null,
  fixed_cost          bigint default 0,
  variable_cost_per_person integer default 0,
  blended_price       integer default 0,
  assumption_version  text not null default '2026.v1',
  approved_by         text default '홍성현 총괄',
  description         text,
  created_at          timestamptz default now()
);

alter table master_targets enable row level security;
create policy "Allow all on master_targets" on master_targets for all using (true) with check (true);

-- ── 25. spatial_zone_telemetry (Section 8: 디지털 트윈 11대 공간 실시간 텔레메트리) ──
create table if not exists spatial_zone_telemetry (
  id                  text primary key,
  zone_id             text not null,
  timestamp           timestamptz not null default now(),
  occupancy_count     integer not null default 0,
  entry_count         integer not null default 0,
  exit_count          integer not null default 0,
  average_dwell_time  integer not null default 0,
  queue_count         integer not null default 0,
  staff_count         integer not null default 0,
  facility_status     text default 'operating',
  sensor_status       text default 'online',
  created_at          timestamptz default now()
);

alter table spatial_zone_telemetry enable row level security;
create policy "Allow all on spatial_zone_telemetry" on spatial_zone_telemetry for all using (true) with check (true);
create index if not exists idx_spatial_zone_ts on spatial_zone_telemetry (zone_id, timestamp desc);

-- ── 26. queue_snapshots (Section 10: 고객 1회 방문 여정 - 시설별 대기 스냅샷) ──
create table if not exists queue_snapshots (
  id                  text primary key,
  site_id             text default 'bongplay_bonghwa',
  visit_id            text,
  facility_id         text not null,
  wait_minutes        integer not null default 0,
  queue_count         integer not null default 0,
  measured_at         timestamptz not null default now(),
  created_at          timestamptz default now()
);

alter table queue_snapshots enable row level security;
create policy "Allow all on queue_snapshots" on queue_snapshots for all using (true) with check (true);
create index if not exists idx_queue_snapshots_visit on queue_snapshots (visit_id);
create index if not exists idx_queue_snapshots_fac on queue_snapshots (facility_id, measured_at desc);

-- ── 27. sensor_readings (Section 10: 시설/장비 센서 계측 데이터) ──
create table if not exists sensor_readings (
  id                  text primary key,
  site_id             text default 'bongplay_bonghwa',
  facility_id         text not null,
  asset_id            text not null,
  sensor_type         text not null default 'tension',
  value               numeric not null default 0,
  unit                text not null default 'kN',
  status              text default 'normal',
  measured_at         timestamptz not null default now(),
  created_at          timestamptz default now()
);

alter table sensor_readings enable row level security;
create policy "Allow all on sensor_readings" on sensor_readings for all using (true) with check (true);
create index if not exists idx_sensor_readings_asset on sensor_readings (asset_id, measured_at desc);

-- ── 28. asset_maintenance_logs (Section 10: 장비 개체 정비·윤활·부품교체 원장) ──
create table if not exists asset_maintenance_logs (
  id                  text primary key,
  site_id             text default 'bongplay_bonghwa',
  asset_id            text not null,
  maintenance_type    text not null default 'lubrication',
  cost                bigint default 0,
  technician          text default '김주성',
  description         text not null,
  performed_at        timestamptz not null default now(),
  next_due_date       date,
  created_at          timestamptz default now()
);

alter table asset_maintenance_logs enable row level security;
create policy "Allow all on asset_maintenance_logs" on asset_maintenance_logs for all using (true) with check (true);
create index if not exists idx_asset_maint_asset on asset_maintenance_logs (asset_id, performed_at desc);

-- ── 29. asset_usage_counters (Section 10: 장비별 누적 주행 및 수명 카운터) ──
create table if not exists asset_usage_counters (
  asset_id            text primary key,
  site_id             text default 'bongplay_bonghwa',
  facility_id         text,
  current_cycles      integer not null default 0,
  max_lifespan_cycles integer default 10000,
  last_incremented_at timestamptz default now(),
  created_at          timestamptz default now()
);

alter table asset_usage_counters enable row level security;
create policy "Allow all on asset_usage_counters" on asset_usage_counters for all using (true) with check (true);



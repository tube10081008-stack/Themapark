-- ============================================================
-- 봉플레이 DB 증분 패치 r3 → r4 (2026-09-21)
-- ------------------------------------------------------------
-- 대상: r3(발권·결제 안전 인터록 트리거 2건)까지 이미 실행한 DB
-- 내용: 복합 결제 수납원장(order_payments) · 발권취소 상태 전환 ·
--       청소년 바우처 마감 컬럼 · 안전점검 시각/기상 보존
-- 특성: 전부 IF NOT EXISTS / DROP IF EXISTS 로 작성 — 여러 번 실행해도 안전,
--       기존 데이터는 건드리지 않음
-- 실행: Supabase ➔ SQL Editor ➔ 전체 붙여넣기 ➔ Run
-- ============================================================

begin;

-- 1. 안전점검 일지: 점검 시각·기상·책임자 보존 (기록부 인쇄용)
alter table public.safety_audits add column if not exists audit_at    timestamptz;
alter table public.safety_audits add column if not exists weather     text;
alter table public.safety_audits add column if not exists temperature text;
alter table public.safety_audits add column if not exists manager     text;

-- 2. 주문 원장: 발권취소 시 삭제하지 않고 상태만 전환
alter table public.order_items add column if not exists status        text default 'paid';
alter table public.order_items add column if not exists cancelled_at  timestamptz;
alter table public.order_items add column if not exists cancel_reason text;
create index if not exists idx_order_items_status  on public.order_items (status);
create index if not exists idx_order_items_consent on public.order_items (consent_id);

-- 3. 결제수단별 수납 원장 (복합 결제: 상품권+현금, 바우처+카드 등)
create table if not exists public.order_payments (
  id            text primary key,
  order_id      text not null,
  site_id       text default 'bongplay_bonghwa',
  consent_id    text,
  visit_id      text,
  method        text not null,                 -- card / cash / local_pay / youth_voucher / mobile_pay
  amount        bigint not null default 0,
  approval_no   text,
  paid_at       timestamptz default now(),
  status        text default 'paid',           -- paid / cancelled
  cancelled_at  timestamptz,
  cancel_reason text,
  staff_id      text,
  device_id     text,
  device_label  text,
  updated_at    timestamptz default now()
);
create index if not exists idx_order_payments_paid  on public.order_payments (paid_at desc);
create index if not exists idx_order_payments_order on public.order_payments (order_id);

-- 4. 발권 원장: 취소 시각
alter table public.ticket_ledger add column if not exists cancelled_at timestamptz;
create index if not exists idx_ticket_ledger_consent on public.ticket_ledger (consent_id);

-- 5. 마감: 청소년 바우처(지자체 청구분, 시재 아님)
alter table public.closing_records add column if not exists system_youth_voucher bigint default 0;

-- 6. order_payments 보안: RLS + 조회/등록/수정만 허용 (삭제 불가)
alter table public.order_payments enable row level security;
revoke delete on public.order_payments from anon, authenticated;

drop policy if exists sec_order_payments_sel on public.order_payments;
drop policy if exists sec_order_payments_ins on public.order_payments;
drop policy if exists sec_order_payments_upd on public.order_payments;
create policy sec_order_payments_sel on public.order_payments for select to anon using (true);
create policy sec_order_payments_ins on public.order_payments for insert to anon with check (true);
create policy sec_order_payments_upd on public.order_payments for update to anon using (true) with check (true);

-- 7. 안전 인터록: 금일 점검 PASS 전에는 수납 원장도 기록 불가
drop trigger if exists trg_safety_interlock on public.order_payments;
create trigger trg_safety_interlock
  before insert or update on public.order_payments
  for each row execute function private.trg_safety_interlock();

-- 8. 실시간 동기화 등록 (여러 기기 간 결제 내역 즉시 반영)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_payments'
  ) then
    alter publication supabase_realtime add table public.order_payments;
  end if;
end $$;

-- 9. 서약서 조회 범위: 매표 데스크 요일 탭(7일)과 일치 + 날짜 기준 KST 고정
--    (기존: 최근 3일 · 서버 UTC 기준 → 지난 요일 탭이 비고, KST 00~09시엔 오늘 건 수정 불가)
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
  where created_date >= (now() at time zone 'Asia/Seoul')::date - 6
  order by arrival_at desc nulls last;
end;
$$;
revoke all on function public.get_today_consents_secure(text) from public;
grant execute on function public.get_today_consents_secure(text) to anon, authenticated;

drop policy if exists "consents_update_policy" on public.safety_consents;
create policy "consents_update_policy" on public.safety_consents
  for update to anon
  using (created_date = (now() at time zone 'Asia/Seoul')::date)
  with check (created_date = (now() at time zone 'Asia/Seoul')::date);

drop policy if exists "consents_select_restricted" on public.safety_consents;
create policy "consents_select_restricted" on public.safety_consents
  for select to anon
  using (created_date = (now() at time zone 'Asia/Seoul')::date);

-- 10. 퇴장 만족도 설문 저장 컬럼 (손님 폰·퇴장 태블릿 공통)
--     (기존: 손님 폰이 존재하지 않는 guest_surveys 테이블로 보내 설문이 서버에 저장되지 않았음)
alter table public.customer_experience_surveys add column if not exists household_id         text;
alter table public.customer_experience_surveys add column if not exists consent_id           text;
alter table public.customer_experience_surveys add column if not exists pass_code            text;
alter table public.customer_experience_surveys add column if not exists survey_channel       text;
alter table public.customer_experience_surveys add column if not exists submitted_at         timestamptz default now();
alter table public.customer_experience_surveys add column if not exists satisfaction_score   int;
alter table public.customer_experience_surveys add column if not exists recommendation_score int;
alter table public.customer_experience_surveys add column if not exists wait_satisfaction    int;
alter table public.customer_experience_surveys add column if not exists favorite_facility    text;
alter table public.customer_experience_surveys add column if not exists improvement_reason   text;
alter table public.customer_experience_surveys add column if not exists revisit_intent       text;
alter table public.customer_experience_surveys add column if not exists staff_friendly_score int;
alter table public.customer_experience_surveys add column if not exists notes                text;
create index if not exists idx_ces_submitted on public.customer_experience_surveys (submitted_at desc);

commit;

-- ============================================================
-- 검증 (결과 3줄이 모두 PASS 여야 함)
-- ============================================================
select '인터록 트리거' as 항목,
       case when count(*) = 3 then 'PASS' else 'FAIL (' || count(*) || '건)' end as 결과
  from pg_trigger
 where tgname = 'trg_safety_interlock' and not tgisinternal
   and tgrelid in ('public.ticket_ledger'::regclass, 'public.order_items'::regclass, 'public.order_payments'::regclass)
union all
select 'order_payments 정책',
       case when count(*) = 3 then 'PASS' else 'FAIL (' || count(*) || '건)' end
  from pg_policies where schemaname = 'public' and tablename = 'order_payments'
union all
select '신규 컬럼',
       case when count(*) = 8 then 'PASS' else 'FAIL (' || count(*) || '/8)' end
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (
     ('safety_audits','audit_at'), ('safety_audits','weather'),
     ('safety_audits','temperature'), ('safety_audits','manager'),
     ('order_items','status'), ('order_items','cancelled_at'),
     ('ticket_ledger','cancelled_at'), ('closing_records','system_youth_voucher'));

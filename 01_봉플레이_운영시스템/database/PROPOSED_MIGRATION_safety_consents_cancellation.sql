-- =============================================================================
-- [제안 SQL] safety_consents 테이블 취소/환불 관리 컬럼 추가 안
-- 작성: 아난티 (Antigravity) / ANT-001 보완 과제
-- 수신 및 검토: 벤 (Ben)
-- 주의: 이 파일은 제안 및 검토용이며, 운영 DB에 직접 적용하지 않습니다.
-- =============================================================================

-- 1. safety_consents 테이블에 취소 관련 메타데이터 컬럼 추가
alter table public.safety_consents
  add column if not exists status text default 'active',
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text;

comment on column public.safety_consents.status is '서약 상태: active(유효), cancelled(취소/환불)';
comment on column public.safety_consents.cancelled_at is '매표소/POS에서 취소 처리된 시각 (ISO 8601)';
comment on column public.safety_consents.cancel_reason is '취소 사유 (단순변심, 기상악화, 오발권 등)';

-- 2. RLS 정책 보완: anon 또는 authenticated 역할의 UPDATE 권한에 취소 컬럼 허용 확인
-- (FINAL_SUPABASE_SETUP.sql 및 supabase_rls_hardening.sql 정책과 정합성 유지)
-- create policy "consents_cancel_policy" on public.safety_consents
--   for update using (true)
--   with check (status in ('active', 'cancelled'));

-- 3. 취소 상태 빠른 조회를 위한 부분 인덱스 권장
create index if not exists idx_safety_consents_cancelled
  on public.safety_consents(created_date, status)
  where status = 'cancelled';

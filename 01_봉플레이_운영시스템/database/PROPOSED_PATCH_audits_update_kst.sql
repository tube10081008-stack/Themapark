-- =============================================================================
-- [제안 SQL] safety_audits 수정 정책을 KST 날짜 기준으로 (CLAUDE-011 C2, 2026-10-15)
-- -----------------------------------------------------------------------------
-- 상태: 2026-10-15 벤 R2 결정으로 FINAL_SUPABASE_SETUP.sql 5-3 자체에 같은 내용을 반영했다.
--       새로 설치하는 DB 는 FINAL 만으로 충분하다. 이 파일은 이미 옛 FINAL 로 설치된 DB 에 정책만 바꿀 때 쓴다.
--       시험 설치 묶음(ORDER)에는 넣지 않는다. 운영 DB 적용은 이번 범위가 아니다.
--
-- 문제: FINAL_SUPABASE_SETUP.sql 5-3 "audits_update" 가 current_date 와 비교한다.
--       Supabase 세션 시간대는 UTC 라 current_date 는 UTC 날짜다. KST 00:00~08:59 에는 다음 둘이 함께 생긴다.
--         · 오늘(KST) 점검 기록 수정이 거부된다 (USING 이 0행 → 오류 없이 0건 수정)
--         · 어제(KST) 점검 기록 수정이 허용된다 ("과거 기록 사후 위조 방지" 목적에 어긋남)
--       같은 FINAL 의 서약서 정책·안전 인터록 트리거는 이미 KST((now() at time zone 'Asia/Seoul')::date)를 쓴다.
-- 변경: USING·WITH CHECK 의 비교 날짜만 KST 로 바꾼다. 조회·등록 정책, 다른 표는 그대로다.
-- 주의: 옛 FINAL(이 수정 전 판)을 다시 실행하면 public 정책을 모두 지우고 UTC 판을 다시 만든다. 지금 FINAL 은 KST 판을 만든다.
-- 검증: tests/queue-contract/supabase-install/audits_kst_boundary.sh (libfaketime 으로 KST 경계 시각 재현)
-- =============================================================================
drop policy if exists "audits_update" on public.safety_audits;
create policy "audits_update" on public.safety_audits
  for update to anon
  using (audit_date = (now() at time zone 'Asia/Seoul')::date)
  with check (audit_date = (now() at time zone 'Asia/Seoul')::date);

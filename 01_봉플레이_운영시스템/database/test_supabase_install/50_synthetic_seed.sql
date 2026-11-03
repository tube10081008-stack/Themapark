-- ============================================================================
-- 50_synthetic_seed.sql — 합성 시험 자료 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 모든 행의 id 는 'SYN-' 로 시작하고, 이름·연락처는 실재하지 않는 합성 값이다.
--   · 오늘(KST) 안전점검 PASS 1건: FINAL 5-8 안전 인터록 때문에 이것이 없으면 주문·발권 원장 쓰기가 거부된다.
--     날짜에 묶여 있으므로 시험하는 날마다 이 파일을 다시 실행한다 (같은 날 재실행은 안전).
--   · 서약서 3건 (오늘 날짜): 매표 화면·대기열 접수 시험용
-- 00_preflight.sql 의 시험 설치 표시가 없으면 실행을 거부한다.
-- ============================================================================
do $seed$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if coalesce((select value from private.app_settings where key = 'install_target'), '') <> 'synthetic_test' then
    raise exception 'SEED: 시험 설치 표시가 없습니다. 00_preflight.sql 을 먼저 실행하십시오.';
  end if;

  insert into public.safety_audits (id, site_id, audit_date, audit_at, inspector, decision, is_safe, note)
  values ('SYN-AUDIT-' || v_today, 'bongplay_bonghwa', v_today, now(), 'SYN 점검자', 'pass', true, '합성 시험 자료')
  on conflict (id) do update set decision = 'pass', is_safe = true, audit_at = now();

  insert into public.safety_consents
    (id, site_id, visit_id, pass_code, arrival_at, created_date, guardian_name, guardian_phone,
     residence, children, party_size, child_count, adult_count, is_issued)
  select 'SYN-CST-' || to_char(v_today, 'YYYYMMDD') || '-' || n,
         'bongplay_bonghwa', 'SYN-VST-' || n, 'SYN-PASS-' || n, now(), v_today,
         'SYN 보호자 ' || n, '010-0000-000' || n, '관외',
         jsonb_build_array(jsonb_build_object('name', 'SYN 아동 ' || n, 'birth', '2019-05-12', 'height', 115, 'weight', 21)),
         2, 1, 1, false
  from generate_series(1, 3) as g(n)
  on conflict (id) do nothing;

  raise notice 'SEED: 오늘(%) PASS 점검 1건, 합성 서약서 3건 준비', v_today;
end
$seed$;

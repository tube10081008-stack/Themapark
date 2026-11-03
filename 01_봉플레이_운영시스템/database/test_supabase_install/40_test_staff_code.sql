-- ============================================================================
-- 40_test_staff_code.sql — 시험 전용 운영자 암호 등록 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 이 파일에는 암호가 들어 있지 않다. 실행 전에 아래 자리표시자를 시험 전용 값으로 바꾼다.
--   · 운영 암호를 재사용하지 않는다. 6자 이상. 시험이 끝나면 91 초기화로 함께 지운다.
--   · 바꾼 파일은 저장소에 커밋하지 않는다 (SQL Editor 에서만 고쳐 실행).
-- 저장 형식은 FINAL_SUPABASE_SETUP.sql 5-2 절과 같다 (bcrypt 해시만 저장).
-- 00_preflight.sql 의 시험 설치 표시가 없으면 실행을 거부한다.
-- ============================================================================
do $code$
declare
  v_code constant text := '__TEST_ONLY_STAFF_CODE__';   -- ← 시험 전용 값으로 바꿀 것
begin
  if coalesce((select value from private.app_settings where key = 'install_target'), '') <> 'synthetic_test' then
    raise exception 'TEST_CODE: 시험 설치 표시가 없습니다. 00_preflight.sql 을 먼저 실행하십시오.';
  end if;
  if v_code like '\_\_%' or length(v_code) < 6 then
    raise exception 'TEST_CODE: 자리표시자를 6자 이상의 시험 전용 값으로 바꾼 뒤 실행하십시오.';
  end if;
  insert into private.app_settings (key, value)
  values ('access_code', extensions.crypt(v_code, extensions.gen_salt('bf')))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  raise notice 'TEST_CODE: 시험 전용 운영자 암호 해시를 등록했습니다.';
end
$code$;

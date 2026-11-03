-- ============================================================================
-- PROPOSED MIGRATION: lookup_family_children 익명 실행 차단 (CLAUDE-011 R4 보완)
--
-- 문제: FINAL_SUPABASE_SETUP.sql (3-B) 의 public.lookup_family_children(p_phone text) 는
--   SECURITY DEFINER 이고, 전화번호 하나만으로 가장 최근 서약서의 보호자 이름·거주지·자녀 목록(이름·생년월일·키·몸무게)을
--   돌려준다. FINAL 은 이 함수의 실행 권한을 회수하지 않으므로
--   PostgreSQL 기본값(PUBLIC 에 EXECUTE)과 Supabase 기본 권한(anon·authenticated)으로 익명 API 에서 호출된다.
--   → 전화번호만 알면(또는 순차 대입하면) 다른 가족의 아동 정보를 조회할 수 있다.
-- 조치(최소): 이름이 lookup_family_children 인 public 함수 전부(오버로드 포함)의 실행 권한을
--   PUBLIC·anon·authenticated 에서 회수한다. 함수 본문·서명·표는 바꾸지 않는다. service_role·소유자는 그대로.
-- 영향: 손님 서약 화면(consent.html)의 "이전 방문 자녀 기록 불러오기" 서버 조회가 거부된다.
--   화면은 실패를 무시하고 같은 단말 localStorage 캐시만 쓴다 (서약 제출에는 영향 없음).
-- 여러 번 실행해도 같다. FINAL 을 다시 실행하거나 함수를 다시 만든 뒤에는 이 파일도 다시 실행한다
--   (CREATE OR REPLACE 는 권한을 유지하지만, DROP 후 재생성하면 기본 권한이 다시 붙는다).
-- 운영 DB 에는 벤 승인 후 수동 적용한다.
-- ============================================================================
do $revoke_lookup$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'lookup_family_children'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    n := n + 1;
  end loop;
  raise notice 'lookup_family_children: % 개 서명의 PUBLIC·anon·authenticated 실행 권한 회수', n;
end
$revoke_lookup$;

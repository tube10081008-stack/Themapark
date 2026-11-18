-- ============================================================================
-- 시험 전용: 호스팅 Supabase 플랫폼 기본 상태 모사 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- 설치 묶음(database/test_supabase_install)이 아니다. 로컬 일회용 PostgreSQL 에서
-- "빈 Supabase 프로젝트"에 가까운 출발점을 만들기 위해 슈퍼유저(supabase_admin)로 한 번 실행한다.
--
-- 목적: 설치 묶음이 Supabase 의 실제 기본 권한(넓게 열린 default privileges)을 전제로도 안전한지 본다.
--   · 시험 하네스(ant006-conformance)의 느슨한 설정을 재사용하지 않는다.
--   · 반대로 Supabase 가 실제로 하는 넓은 기본 부여는 그대로 흉내 내, 묶음이 직접 막는지 확인한다.
-- 모사하는 것 (Supabase 공개 문서·기본 마이그레이션 기준, 세부는 실제와 다를 수 있음):
--   · 역할: postgres(비슈퍼유저, BYPASSRLS, 설치 실행자), anon, authenticated, service_role(BYPASSRLS),
--     authenticator(PostgREST 접속 역할, 세 API 역할로 전환 가능)
--   · 스키마: extensions(pgcrypto 사전 설치), auth(role·uid·jwt 함수)
--   · public 스키마 기본 권한: postgres 가 만드는 테이블·함수·시퀀스에 anon·authenticated·service_role 전체 권한
--   · Realtime 발행 supabase_realtime
-- 모사하지 않는 것: GoTrue 로그인, Storage, Realtime 서버, pg_cron, 네트워크 제한, PgBouncer.
-- ============================================================================
do $r$ begin create role postgres login createrole createdb bypassrls nosuperuser; exception when duplicate_object then null; end $r$;
do $r$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $r$;
do $r$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $r$;
do $r$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $r$;
do $r$ begin create role authenticator login noinherit; exception when duplicate_object then null; end $r$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

select format('alter database %I owner to postgres', current_database()) \gexec

create schema if not exists extensions authorization postgres;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, postgres;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role, postgres;

alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

do $p$ begin create publication supabase_realtime; exception when duplicate_object then null; end $p$;
alter publication supabase_realtime owner to postgres;

// Supabase 와 비슷한 조건을 만드는 SQL. PGlite 계층(harness.mjs)과 로컬 PostgreSQL 계층(pg-harness.mjs)이 함께 쓴다.
// 운영 DB·Supabase·PostgREST 에 접속하지 않는다. 합성 값만 쓴다.
//
// 모사하는 것 (실제 Supabase 와 다를 수 있음 → 실환경 검증 항목으로 분리):
//   - 역할 anon / authenticated, auth.role()·auth.uid() (request.jwt.claims 기반, Supabase 정의와 같은 방식)
//   - Supabase 기본 권한: public 스키마 새 함수에 anon·authenticated EXECUTE 자동 부여
//   - pgcrypto 를 extensions 스키마에 설치 (supabaseExtensions) 또는 public 에 설치
//   - 01 운영 스키마의 safety_consents·order_items·order_payments·ticket_ledger 중 시험에 필요한 열
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ANT006_SQL = process.env.ANT006_SQL || null;
export const STAFF_CODE = 'SENTINEL-STAFF-CODE';   // 합성 운영자 암호 (운영 값 아님)
export const WRONG_CODE = 'SENTINEL-WRONG-CODE';

/** 역할은 클러스터 전역이라 실제 PostgreSQL 에서 데이터베이스를 새로 만들 때 이미 있을 수 있다 */
export function emulationSql({ supabaseExtensions = false } = {}) {
  return `
    set timezone = 'UTC';
    do $r$ begin create role anon nologin; exception when duplicate_object then null; end $r$;
    do $r$ begin create role authenticated nologin; exception when duplicate_object then null; end $r$;
    create schema if not exists auth; create schema if not exists extensions;
    grant usage on schema auth to anon, authenticated;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
    grant execute on function auth.role(), auth.uid() to anon, authenticated;
    create extension if not exists pgcrypto schema ${supabaseExtensions ? 'extensions' : 'public'};
    ${supabaseExtensions ? '' : `create or replace function extensions.crypt(text, text) returns text language sql as $f$ select public.crypt($1, $2) $f$;
    create or replace function extensions.gen_salt(text) returns text language sql as $f$ select public.gen_salt($1) $f$;`}
    -- 01 운영 스키마의 직원 암호 저장소 (FINAL_SUPABASE_SETUP.sql 과 같은 구조)
    create schema if not exists private;
    revoke all on schema private from public;
    create table private.app_settings (key text primary key, value text not null, updated_at timestamptz default now());
    create table private.auth_attempts (id bigserial primary key, client_ip text, ok boolean not null, attempted_at timestamptz not null default now());
    create table public.safety_consents (id text primary key, guardian_name text, created_date date);
    -- order_items: FINAL_SUPABASE_SETUP.sql 의 기본 열(category/unit_price/total_price) + 추가 열(product_category/list_price/
    -- discount_amount/paid_amount/consent_id/status). 매표 데스크(bongplay-id.js createOrder)는 추가 열만 채우고
    -- total_price·category 는 쓰지 않는다 → 시험 픽스처도 실제 쓰기 형태(orderItem)로 넣는다.
    create table public.order_items (item_id text primary key, order_id text not null, product_id text, category text,
      unit_price bigint default 0, quantity int default 1, total_price bigint default 0, site_id text default 'bongplay_bonghwa',
      product_category text, list_price bigint default 0, discount_amount bigint default 0, paid_amount bigint default 0,
      consent_id text, status text default 'paid', cancelled_at timestamptz);
    create table public.order_payments (id text primary key, order_id text not null, consent_id text, method text not null,
      amount bigint not null default 0, status text default 'paid', cancelled_at timestamptz);
    create table public.ticket_ledger (ticket_id text primary key, site_id text default 'bongplay_bonghwa', consent_id text,
      order_id text, product_id text, status text default 'active', cancelled_at timestamptz, issued_at timestamptz default now());
  `;
}

/** 대상 체크아웃의 01 운영 스키마(FINAL_SUPABASE_SETUP.sql)에서 private.verify_access_code 원문을 가져온다 */
export function repoVerifyAccessCode() {
  const f = ANT006_SQL ? path.join(path.dirname(ANT006_SQL), 'FINAL_SUPABASE_SETUP.sql') : null;
  if (!f || !existsSync(f)) return null;
  const m = readFileSync(f, 'utf8').match(/create or replace function private\.verify_access_code[\s\S]*?\n\$\$;/i);
  return m ? m[0] : null;
}

export const SUPABASE_DEFAULT_PRIVILEGES_SQL = `alter default privileges in schema public grant execute on functions to anon, authenticated;`;

/** PostgREST 가 RPC 마다 하는 일을 흉내: 역할·JWT 클레임 설정 문장과 호출 문장 */
export function claimsFor(who) {
  const claims = who === 'anon' ? { role: 'anon' }
    : who === 'nonstaff' ? { role: 'authenticated', sub: '00000000-0000-4000-8000-0000000000aa', app_metadata: {} }
    : who === 'staff' ? { role: 'authenticated', sub: '00000000-0000-4000-8000-0000000000bb', app_metadata: { role: 'staff' } }
    : null;
  const role = who === 'owner' ? null : (who === 'anon' ? 'anon' : 'authenticated');
  return { claims, role };
}

export function rpcCallSql(fn, args) {
  const names = Object.keys(args);
  const placeholders = names.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = names.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  return { text: `select public.${fn}(${placeholders}) as r`, values };
}

/** 매표 데스크 createOrder 와 같은 형태로 주문 품목 1행을 넣는 SQL (total_price·category 는 채우지 않음) */
export function orderItemSql({ item, order, product = 'tkt_basic', category = 'ticket', qty = 1, list = 15000, discount = 0, consent }) {
  const paid = Math.max(0, list * qty - discount);
  return `insert into public.order_items (item_id, order_id, product_id, product_category, quantity, list_price, discount_amount, paid_amount, consent_id)
    values ('${item}','${order}','${product}','${category}',${qty},${list},${discount},${paid},${consent ? `'${consent}'` : 'null'});`;
}

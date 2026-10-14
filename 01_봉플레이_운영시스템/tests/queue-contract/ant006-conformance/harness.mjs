// PGlite(메모리 안 PostgreSQL) 위에 Supabase 와 비슷한 조건을 만들고 ANT-006 제안 SQL 을 적재한다.
// 운영 DB·Supabase·PostgREST 에 접속하지 않는다. 합성 값만 쓴다.
//
// 모사하는 것 (실제 Supabase 와 다를 수 있음 → 실환경 검증 항목으로 분리):
//   - 역할 anon / authenticated, auth.role()·auth.uid() (request.jwt.claims 기반, Supabase 정의와 같은 방식)
//   - Supabase 기본 권한: public 스키마 새 함수에 anon·authenticated EXECUTE 자동 부여 (supabaseDefaults)
//   - pgcrypto 를 extensions 스키마에 설치 (supabaseExtensions) 또는 public 에 설치
//   - 01 운영 스키마의 safety_consents·order_items·order_payments·ticket_ledger 중 시험에 필요한 열
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const pgliteDir = process.env.PGLITE_DIR;
const { PGlite } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/index.js').href : '@electric-sql/pglite');
const { pgcrypto } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/contrib/pgcrypto.js').href : '@electric-sql/pglite/contrib/pgcrypto');

export const ANT006_SQL = process.env.ANT006_SQL || null;
export const STAFF_CODE = 'SENTINEL-STAFF-CODE';   // 합성 운영자 암호 (운영 값 아님)
export const WRONG_CODE = 'SENTINEL-WRONG-CODE';

/** 대상 체크아웃의 01 운영 스키마(FINAL_SUPABASE_SETUP.sql)에서 private.verify_access_code 원문을 가져온다 */
function repoVerifyAccessCode() {
  const f = ANT006_SQL ? path.join(path.dirname(ANT006_SQL), 'FINAL_SUPABASE_SETUP.sql') : null;
  if (!f || !existsSync(f)) return null;
  const m = readFileSync(f, 'utf8').match(/create or replace function private\.verify_access_code[\s\S]*?\n\$\$;/i);
  return m ? m[0] : null;
}

export async function createDb({ supabaseDefaults = true, supabaseExtensions = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    set timezone = 'UTC';
    create role anon nologin; create role authenticated nologin;
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
  `);
  const verify = repoVerifyAccessCode();
  if (verify) await db.exec(verify);
  await db.query(`insert into private.app_settings (key, value) values ('access_code', extensions.crypt($1, extensions.gen_salt('bf')))`, [STAFF_CODE]);
  if (supabaseDefaults) {
    await db.exec(`alter default privileges in schema public grant execute on functions to anon, authenticated;`);
  }
  return db;
}

export async function loadMigration(db) {
  if (!ANT006_SQL) throw new Error('ANT006_SQL 미지정');
  await db.exec(readFileSync(ANT006_SQL, 'utf8'));
}

/** 역할·JWT 클레임을 바꿔 RPC 를 호출한다 (PostgREST 가 하는 일을 흉내). 오류는 {sqlError} 로 돌려준다. */
export async function callAs(db, who, fn, args = {}) {
  const claims = who === 'anon' ? { role: 'anon' }
    : who === 'nonstaff' ? { role: 'authenticated', sub: '00000000-0000-4000-8000-0000000000aa', app_metadata: {} }
    : who === 'staff' ? { role: 'authenticated', sub: '00000000-0000-4000-8000-0000000000bb', app_metadata: { role: 'staff' } }
    : null;
  const role = who === 'owner' ? null : (who === 'anon' ? 'anon' : 'authenticated');
  // 대상 함수가 p_access_code 를 받으면(R2 이후) 신원에 맞는 코드를 자동으로 넣는다. 명시한 값이 있으면 그대로 쓴다.
  if (!('p_access_code' in args) && (await hasParam(db, fn, 'p_access_code'))) {
    args = { p_access_code: who === 'staff' ? STAFF_CODE : WRONG_CODE, ...args };
  }
  const names = Object.keys(args);
  const placeholders = names.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = names.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
  try {
    return await db.transaction(async (tx) => {
      if (role) {
        await tx.exec(`set local role ${role}`);
        await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', $2, true)`, [JSON.stringify(claims), claims.role]);
      }
      const r = await tx.query(`select public.${fn}(${placeholders}) as r`, values);
      return r.rows[0].r;
    });
  } catch (e) {
    return { sqlError: e.message, sqlCode: e.code };
  }
}

export async function hasParam(db, fn, param) {
  const r = await db.query(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1 and $2 = any(p.proargnames)`, [fn, param]);
  return r.rows.length > 0;
}

/** 매표 데스크 createOrder 와 같은 형태로 주문 품목 1행을 넣는 SQL (total_price·category 는 채우지 않음) */
export function orderItemSql({ item, order, product = 'tkt_basic', category = 'ticket', qty = 1, list = 15000, discount = 0, consent }) {
  const paid = Math.max(0, list * qty - discount);
  return `insert into public.order_items (item_id, order_id, product_id, product_category, quantity, list_price, discount_amount, paid_amount, consent_id)
    values ('${item}','${order}','${product}','${category}',${qty},${list},${discount},${paid},${consent ? `'${consent}'` : 'null'});`;
}

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

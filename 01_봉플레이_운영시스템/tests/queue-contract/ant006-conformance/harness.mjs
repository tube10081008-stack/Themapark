// PGlite(메모리 안 PostgreSQL) 위에 Supabase 와 비슷한 조건을 만들고 ANT-006 제안 SQL 을 적재한다.
// 운영 DB·Supabase·PostgREST 에 접속하지 않는다. 합성 값만 쓴다.
//
// 모사하는 것 (실제 Supabase 와 다를 수 있음 → 실환경 검증 항목으로 분리):
//   - 역할 anon / authenticated, auth.role()·auth.uid() (request.jwt.claims 기반, Supabase 정의와 같은 방식)
//   - Supabase 기본 권한: public 스키마 새 함수에 anon·authenticated EXECUTE 자동 부여 (supabaseDefaults)
//   - pgcrypto 를 extensions 스키마에 설치 (supabaseExtensions) 또는 public 에 설치
//   - 01 운영 스키마의 safety_consents·order_items·order_payments·ticket_ledger 중 시험에 필요한 열
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const pgliteDir = process.env.PGLITE_DIR;
const { PGlite } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/index.js').href : '@electric-sql/pglite');
const { pgcrypto } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/contrib/pgcrypto.js').href : '@electric-sql/pglite/contrib/pgcrypto');

export const ANT006_SQL = process.env.ANT006_SQL || null;

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
    create table public.safety_consents (id text primary key, guardian_name text, created_date date);
    create table public.order_items (item_id text primary key, order_id text not null, product_id text, category text,
      unit_price bigint default 0, quantity int default 1, total_price bigint default 0, site_id text default 'bongplay_bonghwa');
    create table public.order_payments (id text primary key, order_id text not null, consent_id text, method text not null,
      amount bigint not null default 0, status text default 'paid', cancelled_at timestamptz);
    create table public.ticket_ledger (ticket_id text primary key, site_id text default 'bongplay_bonghwa', consent_id text,
      order_id text, product_id text, status text default 'active', cancelled_at timestamptz, issued_at timestamptz default now());
  `);
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

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

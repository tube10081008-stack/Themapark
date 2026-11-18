// CLAUDE-011 R4 보완 — public.lookup_family_children 익명 노출 점검 (실제 PostgreSQL + 설치 묶음 + PostgREST).
//
// 이 함수는 SECURITY DEFINER 이고 전화번호 하나로 가장 최근 서약서의 보호자 이름·거주지·자녀 목록(이름·생년월일·키·몸무게)을 돌려준다.
// FINAL 은 실행 권한을 회수하지 않아, PostgreSQL 기본값(PUBLIC EXECUTE)과 Supabase 기본 권한(anon·authenticated)으로 익명 API 에서 호출된다.
// 차단: database/PROPOSED_MIGRATION_lookup_family_children_revoke.sql (설치 묶음 ORDER 에 포함).
//
// 확인: (L1) 모든 오버로드의 ACL 에 PUBLIC·anon·authenticated EXECUTE 없음, (L2) PostgREST HTTP 로 anon·authenticated JWT 호출 거부·응답에 합성 아동 정보 없음,
//       (L3) PostgREST 와 같은 SQL 경로(authenticator → anon/authenticated) 거부, (L4) service_role 은 그대로 동작 (함수 자체는 유지),
//       (L5) 기본 권한으로 새 오버로드가 생겨도 마이그레이션을 다시 실행하면 함께 차단, 두 번 실행해도 같음.
// 자료는 모두 SYN- 합성 값이다. 운영 DB·Supabase 에 접속하지 않는다.
//
// 실행: desk-e2e 스택(start) 후
//   E2E_ENV=/var/lib/postgresql/c011-desk-e2e/stack.env PG_DIR=<pg 모듈> node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/anon-exposure/lookup-family.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadEnv, db } from '../desk-e2e/harness.mjs';

const env = loadEnv();
const skip = !env ? 'E2E_ENV 미지정 — desk_e2e_stack.sh start 후 stack.env 경로를 지정'
  : !['127.0.0.1', 'localhost'].includes(new URL(env.E2E_PG_URL).hostname) ? '로컬이 아닌 DB 는 거부' : false;
const PHONE = '010-9999-0417';
const CHILD = 'SYN-L-아동';
const MIGRATION = (() => {
  const own = path.resolve(import.meta.dirname, '../../../database/PROPOSED_MIGRATION_lookup_family_children_revoke.sql');
  const dbRoot = env && env.E2E_DB_ROOT ? path.join(env.E2E_DB_ROOT, 'PROPOSED_MIGRATION_lookup_family_children_revoke.sql') : null;
  return dbRoot && fs.existsSync(dbRoot) ? dbRoot : own;
})();

function jwt(role) {
  const conf = fs.readFileSync(env.E2E_PGRST_CONF, 'utf8');
  const secret = conf.match(/jwt-secret\s*=\s*"([^"]+)"/)[1];
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b({ alg: 'HS256', typ: 'JWT' });
  const p = b({ role, iss: 'syn-local', exp: Math.floor(Date.now() / 1000) + 600 });
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url')}`;
}
async function sqlAs(role, sql, params = []) {
  const pg = (await import(process.env.PG_DIR ? pathToFileURL(process.env.PG_DIR + '/lib/index.js').href : 'pg')).default;
  const conn = new pg.Client({ connectionString: env.E2E_PG_URL.replace('//postgres@', '//authenticator@') });
  await conn.connect();
  try {
    await conn.query('begin');
    await conn.query(`set local role ${role}`);
    await conn.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role })]);
    return { rows: (await conn.query(sql, params)).rows };
  } catch (e) {
    return { code: e.code, message: e.message };
  } finally {
    await conn.query('rollback').catch(() => {});
    await conn.end();
  }
}
const overloads = async (c) => (await c.query(`
  select p.oid::regprocedure::text as sig,
         coalesce(p.proacl::text, '(기본: PUBLIC EXECUTE)') as acl,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'lookup_family_children' order by 1`)).rows;

async function seed(c) {
  await c.query(`delete from public.safety_consents where id like 'SYN-LOOKUP-%'`);
  await c.query(`insert into public.safety_consents (id, site_id, visit_id, arrival_at, created_date, guardian_name, guardian_phone, residence, children, party_size, is_issued)
    values ('SYN-LOOKUP-1', 'bongplay_bonghwa', 'SYN-VST-LOOKUP-1', now(), (now() at time zone 'Asia/Seoul')::date, 'SYN 보호자 L', $1, 'SYN 거주지',
            $2::jsonb, 2, false)`, [PHONE, JSON.stringify([{ name: CHILD, birth: '2019-05-12', height: 115, weight: 21 }])]);
}

test('L1 no overload of public.lookup_family_children is executable by PUBLIC, anon or authenticated (ACL)', { skip }, async () => {
  const c = await db();
  try {
    const rows = await overloads(c);
    console.log(`# L1 관찰: ${JSON.stringify(rows)}`);
    assert.ok(rows.length >= 1, '함수가 없음 (설치 확인)');
    const open = rows.filter((r) => r.public || r.anon || r.authenticated);
    assert.deepEqual(open.map((r) => r.sig), [], `익명 실행 가능: ${JSON.stringify(open)}`);
  } finally { await c.end(); }
});

test('L2 over PostgREST HTTP, anon and authenticated JWTs are refused and no synthetic child data comes back (POST and GET)', { skip }, async () => {
  const c = await db();
  try {
    await seed(c);
    const results = [];
    for (const role of ['anon', 'authenticated']) {
      const key = role === 'anon' ? env.E2E_ANON_KEY : jwt(role);
      const headers = { apikey: env.E2E_ANON_KEY, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
      const post = await fetch(env.E2E_PGRST_URL + '/rpc/lookup_family_children', { method: 'POST', headers, body: JSON.stringify({ p_phone: PHONE }) });
      const pbody = await post.text();
      const get = await fetch(env.E2E_PGRST_URL + '/rpc/lookup_family_children?p_phone=' + encodeURIComponent(PHONE), { headers });
      const gbody = await get.text();
      results.push({ role, post: post.status, get: get.status, leak: pbody.includes(CHILD) || gbody.includes(CHILD), body: pbody.slice(0, 160) });
    }
    console.log(`# L2 관찰: ${JSON.stringify(results)}`);
    for (const r of results) {
      assert.equal(r.leak, false, `${r.role}: 전화번호만으로 합성 아동 정보가 반환됨 (${r.body})`);
      assert.ok(r.post >= 400 && r.get >= 400, `${r.role}: 거부되지 않음 (POST ${r.post}, GET ${r.get})`);
    }
  } finally { await c.end(); }
});

test('L3 the same call over the PostgREST SQL path (authenticator → anon / authenticated) fails with permission denied; service_role still works (L4)', { skip }, async () => {
  const c = await db();
  try {
    await seed(c);
    const anon = await sqlAs('anon', `select public.lookup_family_children($1) as r`, [PHONE]);
    const authd = await sqlAs('authenticated', `select public.lookup_family_children($1) as r`, [PHONE]);
    const svc = await sqlAs('service_role', `select public.lookup_family_children($1) as r`, [PHONE]);
    console.log(`# L3 관찰: anon ${anon.code || 'rows'}, authenticated ${authd.code || 'rows'}, service_role ${svc.rows ? JSON.stringify(svc.rows[0].r).slice(0, 80) : svc.code}`);
    assert.equal(anon.code, '42501', `anon: ${JSON.stringify(anon).slice(0, 200)}`);
    assert.equal(authd.code, '42501', `authenticated: ${JSON.stringify(authd).slice(0, 200)}`);
    assert.ok(svc.rows && JSON.stringify(svc.rows[0].r).includes(CHILD), `L4 service_role 동작 확인 실패 ${JSON.stringify(svc).slice(0, 200)}`);
  } finally { await c.end(); }
});

test('L5 an overload created later picks up Supabase default grants; re-running the migration (twice) revokes every overload', { skip }, async () => {
  const c = await db();
  try {
    await c.query(`create or replace function public.lookup_family_children(p_phone text, p_hint text)
      returns jsonb language sql security definer set search_path = public as $$ select public.lookup_family_children(p_phone) $$`);
    const before = (await overloads(c)).find((r) => r.sig.includes(','));
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await c.query(sql);
    await c.query(sql);
    const after = await overloads(c);
    console.log(`# L5 관찰: 새 오버로드 생성 직후 anon=${before.anon} public=${before.public}; 마이그레이션 2회 후 ${JSON.stringify(after.map((r) => [r.sig, r.anon, r.authenticated, r.public]))}`);
    assert.deepEqual(after.filter((r) => r.anon || r.authenticated || r.public).map((r) => r.sig), []);
    const anon2 = await sqlAs('anon', `select public.lookup_family_children($1, 'x') as r`, [PHONE]);
    assert.equal(anon2.code, '42501');
  } finally {
    await c.query(`drop function if exists public.lookup_family_children(text, text)`);
    await c.end();
  }
});

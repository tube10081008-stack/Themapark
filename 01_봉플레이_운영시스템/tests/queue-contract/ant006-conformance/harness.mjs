// PGlite(메모리 안 PostgreSQL) 위에 Supabase 와 비슷한 조건을 만들고 ANT-006 제안 SQL 을 적재한다.
// 운영 DB·Supabase·PostgREST 에 접속하지 않는다. 합성 값만 쓴다.
// 모사 범위는 supabase-emulation.mjs 참고. PGlite 는 단일 연결이라 동시 연결 경합은 pg-harness.mjs 계층에서 본다.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ANT006_SQL, STAFF_CODE, WRONG_CODE, emulationSql, repoVerifyAccessCode, SUPABASE_DEFAULT_PRIVILEGES_SQL,
  claimsFor, rpcCallSql, orderItemSql
} from './supabase-emulation.mjs';

const pgliteDir = process.env.PGLITE_DIR;
const { PGlite } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/index.js').href : '@electric-sql/pglite');
const { pgcrypto } = await import(pgliteDir ? pathToFileURL(pgliteDir + '/dist/contrib/pgcrypto.js').href : '@electric-sql/pglite/contrib/pgcrypto');

export { ANT006_SQL, STAFF_CODE, WRONG_CODE, orderItemSql };

export async function createDb({ supabaseDefaults = true, supabaseExtensions = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(emulationSql({ supabaseExtensions }));
  const verify = repoVerifyAccessCode();
  if (verify) await db.exec(verify);
  await db.query(`insert into private.app_settings (key, value) values ('access_code', extensions.crypt($1, extensions.gen_salt('bf')))`, [STAFF_CODE]);
  if (supabaseDefaults) await db.exec(SUPABASE_DEFAULT_PRIVILEGES_SQL);
  return db;
}

export async function loadMigration(db) {
  if (!ANT006_SQL) throw new Error('ANT006_SQL 미지정');
  await db.exec(readFileSync(ANT006_SQL, 'utf8'));
}

/** 역할·JWT 클레임을 바꿔 RPC 를 호출한다 (PostgREST 가 하는 일을 흉내). 오류는 {sqlError} 로 돌려준다. */
export async function callAs(db, who, fn, args = {}) {
  const { claims, role } = claimsFor(who);
  // 대상 함수가 p_access_code 를 받으면(R2 이후) 신원에 맞는 코드를 자동으로 넣는다. 명시한 값이 있으면 그대로 쓴다.
  if (!('p_access_code' in args) && (await hasParam(db, fn, 'p_access_code'))) {
    args = { p_access_code: who === 'staff' ? STAFF_CODE : WRONG_CODE, ...args };
  }
  const call = rpcCallSql(fn, args);
  try {
    return await db.transaction(async (tx) => {
      if (role) {
        await tx.exec(`set local role ${role}`);
        await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', $2, true)`, [JSON.stringify(claims), claims.role]);
      }
      const r = await tx.query(call.text, call.values);
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

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows;

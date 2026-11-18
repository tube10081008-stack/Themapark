// 로컬 PostgreSQL(여러 연결) 위에 Supabase 와 비슷한 조건을 만들고 ANT-006 제안 SQL 을 적재한다.
// PGlite 가 볼 수 없는 동시 연결 경합(잠금·고유 제약 충돌)을 확인하는 계층이다.
//
// 안전장치: ANT006_PG_URL 의 호스트가 127.0.0.1·localhost·::1 이 아니면 실행하지 않는다 (운영·Supabase 차단).
// 시험마다 임시 데이터베이스를 만들고 끝나면 지운다. 합성 값만 쓴다.
//
// 이 계층이 확인하지 못하는 것: 실제 Supabase 역할·RLS·PostgREST 라우팅·JWT 검증, 네트워크 지연.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ANT006_SQL, STAFF_CODE, WRONG_CODE, emulationSql, repoVerifyAccessCode, SUPABASE_DEFAULT_PRIVILEGES_SQL,
  claimsFor, rpcCallSql
} from './supabase-emulation.mjs';

export const PG_URL = process.env.ANT006_PG_URL || null;
const pgDir = process.env.PG_DIR;

export function pgSkipReason() {
  if (!ANT006_SQL) return 'ANT006_SQL 미지정 — 대상 구현 없이 건너뜀';
  if (!PG_URL) return 'ANT006_PG_URL 미지정 — 로컬 PostgreSQL 없이 건너뜀';
  const host = new URL(PG_URL).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return `로컬이 아닌 호스트(${host})는 거부 — 운영·Supabase 대상 실행 금지`;
  return false;
}

let pgModule;
async function pg() {
  if (!pgModule) pgModule = (await import(pgDir ? pathToFileURL(pgDir + '/lib/index.js').href : 'pg')).default;
  return pgModule;
}

/** 임시 데이터베이스를 만들고 에뮬레이션·제안 SQL 을 적재한다. 반환값의 session() 으로 독립 연결을 연다. */
export async function createPgDb({ supabaseExtensions = false } = {}) {
  const { Client } = await pg();
  const name = `c011q_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(PG_URL); url.pathname = '/' + name;
  const clients = [];
  const open = async () => { const c = new Client({ connectionString: url.toString() }); await c.connect(); clients.push(c); return c; };

  const owner = await open();
  await owner.query(emulationSql({ supabaseExtensions }));
  const verify = repoVerifyAccessCode();
  if (verify) await owner.query(verify);
  await owner.query(`insert into private.app_settings (key, value) values ('access_code', extensions.crypt($1, extensions.gen_salt('bf')))`, [STAFF_CODE]);
  await owner.query(SUPABASE_DEFAULT_PRIVILEGES_SQL);
  await owner.query(readFileSync(ANT006_SQL, 'utf8'));

  const accessParam = new Map();
  async function needsAccessCode(fn) {
    if (!accessParam.has(fn)) {
      const r = await owner.query(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1 and 'p_access_code' = any(p.proargnames)`, [fn]);
      accessParam.set(fn, r.rows.length > 0);
    }
    return accessParam.get(fn);
  }

  /** 한 연결 = PostgREST 요청 하나. begin() 후 call() 을 하고 commit() 전까지 트랜잭션을 열어 둘 수 있다. */
  async function session(who) {
    const c = await open();
    const { claims, role } = claimsFor(who);
    return {
      async begin() {
        await c.query('begin');
        if (role) {
          await c.query(`set local role ${role}`);
          await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.role', $2, true)`, [JSON.stringify(claims), claims.role]);
        }
      },
      async call(fn, args = {}) {
        if (!('p_access_code' in args) && (await needsAccessCode(fn))) {
          args = { p_access_code: who === 'staff' ? STAFF_CODE : WRONG_CODE, ...args };
        }
        const q = rpcCallSql(fn, args);
        try { return (await c.query(q.text, q.values)).rows[0].r; }
        catch (e) { return { sqlError: e.message, sqlCode: e.code }; }
      },
      commit: () => c.query('commit'),
      rollback: () => c.query('rollback'),
      /** 트랜잭션 하나로 호출 (PostgREST 의 일반 요청과 같음) */
      async rpc(fn, args = {}) {
        await this.begin();
        const r = await this.call(fn, args);
        if (r && r.sqlError !== undefined) await this.rollback(); else await this.commit();
        return r;
      }
    };
  }

  async function drop() {
    for (const c of clients) { try { await c.end(); } catch (e) { /* 이미 닫힘 */ } }
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }

  return { owner, session, drop, name };
}

/** 프로미스가 ms 안에 끝나지 않으면 'pending' (= 잠금을 기다리는 중) */
export async function stillPending(promise, ms = 300) {
  const timeout = new Promise((r) => setTimeout(() => r('pending'), ms));
  return (await Promise.race([promise.then(() => 'settled', () => 'settled'), timeout])) === 'pending';
}

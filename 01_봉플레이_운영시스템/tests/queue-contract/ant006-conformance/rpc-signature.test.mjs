// CLAUDE-011 — 클라이언트 RPC 인자 ↔ SQL 함수 서명 정적 대조 (DB 불필요).
// PostgREST 는 이름 있는 인자 집합으로 함수를 고른다. 서명에 없는 인자를 보내거나 기본값 없는 인자를 빠뜨리면
// 함수를 찾지 못한다 (PGRST202). 이 시험은 그 조건을 소스에서 미리 잡는다. 실제 PostgREST 응답 확인은 별도.
//
// 실행: ANT006_ROOT=<ANT-006 체크아웃 루트> node --test 01_봉플레이_운영시스템/tests/queue-contract/ant006-conformance/rpc-signature.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ANT006_ROOT || null;
const skip = ROOT ? false : 'ANT006_ROOT 미지정 — 대상 구현 없이 건너뜀';
const APP = ROOT ? path.join(ROOT, '01_봉플레이_운영시스템') : null;

/** SQL 의 CREATE [OR REPLACE] FUNCTION public.name(...) → { name: [{name, hasDefault}] } (마지막 정의 우선) */
export function parseSqlSignatures(sql) {
  const out = {};
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns/gi;
  let m;
  while ((m = re.exec(sql))) {
    const params = m[2].split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean).map((p) => ({
      name: p.split(/\s+/)[0], hasDefault: /\bdefault\b|=/i.test(p)
    }));
    out[m[1]] = params;
  }
  return out;
}

/** JS/HTML 의 rpc('name', { k: v, ... }) 호출 → [{file, line, fn, keys}] */
export function parseRpcCalls(text, file) {
  const calls = [];
  const re = /rpc\(\s*'(\w+)'\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2] || '';
    const keys = [...('{' + body).matchAll(/[{,]\s*([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]); // 키는 { 또는 , 바로 뒤 (삼항 ': 1' 제외)
    calls.push({ file, line: text.slice(0, m.index).split('\n').length, fn: m[1], keys });
  }
  return calls;
}

function collect() {
  const sql = readFileSync(path.join(APP, 'database', 'PROPOSED_MIGRATION_ticket_queue.sql'), 'utf8');
  const sigs = parseSqlSignatures(sql);
  const files = [path.join(APP, 'assets', 'bongplay-queue.js'),
    ...readdirSync(path.join(APP, 'pages')).filter((f) => f.endsWith('.html')).map((f) => path.join(APP, 'pages', f))];
  const calls = files.filter(existsSync).flatMap((f) => parseRpcCalls(readFileSync(f, 'utf8'), path.relative(ROOT, f)))
    .filter((c) => c.fn in sigs);
  return { sigs, calls };
}

test('parser self-check on a synthetic signature', () => {
  const s = parseSqlSignatures(`create or replace function public.f(\n p_a text,\n p_b int default 1,\n p_d date default ((now() at time zone 'Asia/Seoul')::date)\n) returns jsonb`);
  assert.deepEqual(s.f, [{ name: 'p_a', hasDefault: false }, { name: 'p_b', hasDefault: true }, { name: 'p_d', hasDefault: true }]);
  const c = parseRpcCalls(`x.rpc('f', {\n p_a: 1,\n p_x: y || 'a',\n p_n: (k ? k.length + 1 : 1)\n})`, 'x.js');
  assert.deepEqual(c[0].keys, ['p_a', 'p_x', 'p_n']);
});

test('every queue RPC call sends only parameters that exist in the SQL signature', { skip }, () => {
  const { sigs, calls } = collect();
  assert.ok(calls.length > 0, '대기열 RPC 호출을 찾지 못함');
  const bad = [];
  for (const c of calls) {
    const names = sigs[c.fn].map((p) => p.name);
    const unknown = c.keys.filter((k) => !names.includes(k));
    if (unknown.length) bad.push(`${c.file}:${c.line} ${c.fn} 에 서명에 없는 인자 ${unknown.join(', ')} (서명: ${names.join(', ')})`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('every queue RPC call supplies all parameters without defaults', { skip }, () => {
  const { sigs, calls } = collect();
  const bad = [];
  for (const c of calls) {
    const missing = sigs[c.fn].filter((p) => !p.hasDefault && !c.keys.includes(p.name)).map((p) => p.name);
    if (missing.length) bad.push(`${c.file}:${c.line} ${c.fn} 필수 인자 누락 ${missing.join(', ')}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('staff RPCs have a server-verified staff credential parameter reachable from the anon-key app', { skip }, () => {
  // 01 앱은 Supabase 로그인 없이 anon 키로 RPC 를 호출한다 (bongplay-sync.js Authorization: Bearer <anon key>).
  // 계약 §9.1: 직원 RPC 는 서버에서 직원 자격을 검증한다. 현재 앱 구조에서는 p_access_code 같은 인자가 있어야 한다.
  const { sigs } = collect();
  const staff = ['call_next_queue_team', 'recall_queue_team', 'start_queue_processing', 'hold_queue_team', 'restore_queue_team',
    'cancel_queue_team', 'complete_queue_issuance', 'get_staff_queue_list', 'set_desk_pause_status'];
  const noCred = staff.filter((f) => sigs[f] && !sigs[f].some((p) => /access_code|staff_code|staff_token/.test(p.name)));
  assert.deepEqual(noCred, [], `직원 자격 인자가 없는 직원 RPC (authenticated 전용 + 앱은 anon 키 → 운영에서 직원 화면 호출 불가, 또는 anon 개방 시 무방비): ${noCred.join(', ')}`);
});

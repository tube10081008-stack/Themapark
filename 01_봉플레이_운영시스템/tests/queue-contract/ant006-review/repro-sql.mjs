// CLAUDE-011 검토: ANT-006 제안 SQL(0ea7b61)을 PGlite(메모리 안 Postgres)에서 실행해 결함을 재현한다.
// 운영 DB·Supabase 에 접속하지 않는다. 합성 값만 쓴다.
// 실행: (임시 폴더에서) npm i @electric-sql/pglite
//       PGLITE_DIR=<그 폴더>/node_modules/@electric-sql/pglite node repro-sql.mjs <PROPOSED_MIGRATION_ticket_queue.sql 경로>
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.PGLITE_DIR ? pathToFileURL(process.env.PGLITE_DIR + '/dist/index.js').href : '@electric-sql/pglite');
import { readFileSync } from 'node:fs';
const sql = readFileSync(process.argv[2], 'utf8');
const db = new PGlite();
const q = async (s, p) => (await db.query(s, p)).rows;
const rpc = async (fn, args) => (await q(`select public.${fn}(${args}) as r`))[0].r;
const out = [];
const rec = (id, ok, detail) => { out.push({ id, reproduced: ok, detail }); };

await db.exec(`set timezone='UTC';
  create role anon nologin; create role authenticated nologin;
  create table public.safety_consents (id text primary key, guardian_name text);
  insert into public.safety_consents select 'cst_'||g, 'SENTINEL_'||g from generate_series(1,20) g;`);
await db.exec(sql);
const ver = (await q('select version() v'))[0].v.split(' ').slice(0,2).join(' ');

// R1 권한: anon 이 직원 RPC 실행 가능한가
await q(`select public.enqueue_consent_team('cst_1','k1',2,'SENTINEL_1','010-0000-0001')`);
await q(`select public.enqueue_consent_team('cst_2','k2',1,'SENTINEL_2','010-0000-0002')`);
await q(`select public.enqueue_consent_team('cst_3','k3',1,'SENTINEL_3','010-0000-0003')`);
const acl = (await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_exec
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
  ('call_next_queue_team','cancel_queue_team','complete_queue_issuance','hold_queue_team','restore_queue_team','start_queue_processing','recall_queue_team') order by 1`));
await db.exec('set role anon');
let anonCall;
try { anonCall = await rpc('call_next_queue_team', '9, $$anon$$'); } catch (e) { anonCall = 'ERR ' + e.message; }
await db.exec('reset role');
rec('R1_anon_can_run_staff_rpcs', acl.every((r) => r.anon_exec) && anonCall?.ok === true,
  { anon_execute: acl, anon_call_next_result: anonCall });

// R2 시각 저장: TIMEZONE('Asia/Seoul', NOW()) 를 timestamptz 에 넣으면 9시간 밀림
const ts = (await q(`select extract(epoch from (enqueued_at - now()))/3600 as hours_ahead from public.ticket_queue where consent_id='cst_1'`))[0];
rec('R2_timestamps_shifted_9h', Math.round(ts.hours_ahead) === 9, { enqueued_at_minus_now_hours: Number(ts.hours_ahead).toFixed(3), session_timezone: 'UTC' });

// R3 부재 복귀가 맨 뒤가 아니라 원래 자리
const id = async (c) => (await q(`select id from public.ticket_queue where consent_id=$1`, [c]))[0].id;
const A = await id('cst_1'), B = await id('cst_2'), C = await id('cst_3');
// anon 호출로 A 는 이미 desk 9 에 called 됨
await rpc('hold_queue_team', `'${A}', '무응답'`);
await rpc('restore_queue_team', `'${A}'`);
const stA = await rpc('get_customer_queue_status', `'${A}'`);
const stC = await rpc('get_customer_queue_status', `'${C}'`);
const next = await rpc('call_next_queue_team', `1, 'desk1'`);
rec('R3_rejoin_returns_to_original_position', stA.ahead_count === 0 && next.id === A,
  { after_restore_A_ahead: stA.ahead_count, C_ahead_count_includes_A: stC.ahead_count, call_next_picks: next.formatted_number + ' (A=#001)' });

// R4 창구 중복 호출: 같은 창구에서 다음 호출이 또 됨
const next2 = await rpc('call_next_queue_team', `1, 'desk1'`);
const desk1 = (await q(`select count(*)::int n from public.ticket_queue where desk_no=1 and status in ('called','processing')`))[0].n;
rec('R4_same_desk_called_twice', next2.ok === true && desk1 === 2, { desk1_active_count: desk1 });

// R5 발권 완료: 상태·원장 검사 없음 (waiting/canceled 에서도 issued)
await q(`select public.enqueue_consent_team('cst_4','k4',1,'S','010-0000-0004')`);
const D = await id('cst_4');
const doneWaiting = await rpc('complete_queue_issuance', `'${D}', 'ord_DOES_NOT_EXIST'`);
await q(`select public.enqueue_consent_team('cst_5','k5',1,'S','010-0000-0005')`);
const E = await id('cst_5');
await rpc('cancel_queue_team', `'${E}', 'x'`);
const doneCanceled = await rpc('complete_queue_issuance', `'${E}', 'ord_x'`);
rec('R5_issue_without_status_or_ledger_check', doneWaiting.ok && doneCanceled.ok,
  { from_waiting_with_unknown_order: doneWaiting.status, from_canceled: doneCanceled.status });

// R6 취소: 발권 완료 건도 취소로 덮어씀
const cancelIssued = await rpc('cancel_queue_team', `'${D}', '실수'`);
const dNow = (await q(`select status, issued_at is not null as had_issued from public.ticket_queue where id=$1`, [D]))[0];
rec('R6_cancel_overwrites_issued', cancelIssued.ok && dNow.status === 'canceled', dNow);

// R7 같은 동의서, 다른 멱등키 → 두 번째 번호
const dup = await rpc('enqueue_consent_team', `'cst_2', 'k2_after_refresh', 1, 'SENTINEL_2', '010-0000-0002'`);
rec('R7_same_consent_new_key_duplicates', dup.ok && dup.duplicate === false, { new_number: dup.formatted_number, consent: 'cst_2 (already #002)' });

// R8 같은 멱등키 + 다른 동의서 → 다른 동의서인데 기존 결과 반환 (본문 대조 없음)
const reuse = await rpc('enqueue_consent_team', `'cst_9', 'k1', 1, 'X', '010-9'`);
rec('R8_key_reuse_with_other_consent_accepted', reuse.ok && reuse.duplicate === true, { returned: reuse.formatted_number, for_consent: 'cst_9' });

// R9 공개 호출판이 내부 id 를 노출 → 그 id 로 상태 조회·취소 가능
const board = await rpc('get_queue_public_display', '');
const leaked = board.called_teams.map((t) => t.id);
await db.exec('set role anon');
let anonCancel;
try { anonCancel = await rpc('cancel_queue_team', `'${leaked[0]}', '외부 취소'`); } catch (e) { anonCancel = 'ERR ' + e.message; }
await db.exec('reset role');
rec('R9_public_board_leaks_id_then_anon_cancels', leaked.length > 0 && anonCancel?.ok === true,
  { board_item_keys: Object.keys(board.called_teams[0] || {}), anon_cancel: anonCancel });

// R10 예상시간: 창구 수·정지 무시, 단일값
await db.exec(`delete from public.ticket_queue`);
for (let i = 1; i <= 8; i++) await q(`select public.enqueue_consent_team('cst_${i+10}','e${i}',1,'S','010')`);
await db.exec(`update public.ticket_queue set status='issued', duration_seconds=300 where queue_number<=3`);
const last = (await q(`select id from public.ticket_queue order by queue_number desc limit 1`))[0].id;
const eta = await rpc('get_customer_queue_status', `'${last}'`);
rec('R10_eta_single_value_ignores_desks_and_pause', eta.wait_time.code === 'ESTIMATED' && typeof eta.wait_time.minutes === 'number',
  { ahead: eta.ahead_count, wait_time: eta.wait_time, note: '서버 함수에 창구 수·정지 입력이 없음' });

// R11 동시 같은 키 접수: 사전 조회가 락 밖 → 동시 요청은 unique 위반 예외 (단일 연결 PGlite 에서는 순차라 재현 불가, 코드 경로로 기록)
rec('R11_concurrent_same_key_race', null, { note: '멱등키 조회(80행)가 advisory lock(98행) 앞. 동시 같은 키 2건이면 둘째가 uq 예외 → 같은 결과 대신 오류. 실 DB 동시성 시험 필요' });

console.log(JSON.stringify({ engine: ver, results: out }, null, 1));

// CLAUDE-011 — 매표 발권 E2E 하네스: 실제 화면 + 실제 DB 계약(설치 묶음) + 실제 PostgREST.
// frontend-contract/ 와 달리 RPC·테이블 쓰기를 모사하지 않는다. 모든 요청은 로컬 PostgREST → PostgreSQL 로 간다.
// 이 프록시가 하는 일은 (1) 대상 체크아웃의 정적 파일 제공, (2) config.js 를 시험 접속값으로 바꾼 템플릿 제공,
// (3) /rest/v1/* 를 PostgREST 로 전달하며 장애 주입·요청 기록, 세 가지뿐이다.
// 접속 정보는 desk_e2e_stack.sh 가 만든 stack.env 에서 읽는다. 운영 DB·Supabase 에 접속하지 않는다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export const FRONT_ROOT = process.env.ANT006_ROOT || null;
const ENV_FILE = process.env.E2E_ENV || null;
export const DEVICE_IP = '203.0.113.10';   // 문서용 예약 대역(TEST-NET-3). 현장 공유기 뒤 단말을 흉내

export function loadEnv() {
  if (!ENV_FILE || !fs.existsSync(ENV_FILE)) return null;
  return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
}
export function skipReason() {
  if (!FRONT_ROOT) return 'ANT006_ROOT 미지정 — 대상 화면 없이 건너뜀';
  if (!loadEnv()) return 'E2E_ENV 미지정 — desk_e2e_stack.sh start 후 stack.env 경로를 지정';
  const host = new URL(loadEnv().E2E_PG_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') return '로컬이 아닌 DB 는 거부';
  return false;
}

let pgMod, pwMod;
export async function db() {
  if (!pgMod) pgMod = (await import(process.env.PG_DIR ? pathToFileURL(process.env.PG_DIR + '/lib/index.js').href : 'pg')).default;
  const c = new pgMod.Client({ connectionString: loadEnv().E2E_PG_URL });
  await c.connect();
  return c;
}
async function playwright() {
  if (!pwMod) pwMod = await import(process.env.PW_DIR ? pathToFileURL(path.join(process.env.PW_DIR, 'index.mjs')).href : 'playwright');
  return pwMod.chromium ? pwMod : pwMod.default;
}

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export { kstToday };

/**
 * 시나리오마다 대기열·주문·원장·서약서를 비우고 합성 서약서 n 건과 대기 팀을 순서대로 만든다 (관리자 연결).
 * cancelledFirst: 첫 서약서를 "예전에 발권취소된" 상태(status·cancelled_at·cancel_reason)로 만든다 (취소 3열이 있는 DB 에서만).
 * 반환: 첫 서약서·대기 팀 id (consentId·queueId) 와 전체 목록 (teams).
 */
export async function resetScenario(c, { passAudit = true, consents = 1, cancelledFirst = false } = {}) {
  await c.query(`truncate public.ticket_queue, public.order_items, public.order_payments, public.ticket_ledger, public.safety_consents, public.safety_audits`);
  await c.query(`update public.ticket_queue_desks set current_queue_id = null, is_paused = false`);
  await c.query(`delete from private.auth_attempts`);
  if (passAudit) {
    await c.query(`insert into public.safety_audits (id, site_id, audit_date, audit_at, inspector, decision, is_safe, note)
      values ($1, 'bongplay_bonghwa', $2, now(), 'SYN 점검자', 'pass', true, '합성')`, ['SYN-AUDIT-' + kstToday(), kstToday()]);
  }
  const teams = [];
  for (let n = 1; n <= consents; n++) {
    const cid = `SYN-CST-${Date.now().toString(36)}-${n}`;
    await c.query(`insert into public.safety_consents (id, site_id, visit_id, pass_code, arrival_at, created_date, guardian_name, guardian_phone,
        residence, children, party_size, child_count, adult_count, is_issued)
      values ($1, 'bongplay_bonghwa', $2, 'SYN-PASS', now(), $3, $4, '010-0000-000' || $5, '관외',
        '[{"name":"SYN 아동","birth":"2019-05-12","height":115,"weight":21}]'::jsonb, 2, 1, 1, false)`,
      [cid, 'SYN-VST-' + cid, kstToday(), 'SYN 보호자 ' + n, String(n)]);
    if (n === 1 && cancelledFirst) {
      await c.query(`update public.safety_consents set status = 'cancelled', cancelled_at = now() - interval '1 hour', cancel_reason = 'SYN 이전 취소' where id = $1`, [cid]);
    }
    const q = (await c.query(`select public.enqueue_consent_team($1, $2, 2, 'SYN 보호자', '010-0000-0001', 'bongplay_bonghwa') as r`, [cid, 'SYN-KEY-' + cid])).rows[0].r;
    if (!q.ok) throw new Error('준비 접수 실패 ' + JSON.stringify(q));
    teams.push({ consentId: cid, queueId: q.id });
  }
  return { consentId: teams[0].consentId, queueId: teams[0].queueId, teams };
}

export async function hasCancelColumns(c) {
  return (await c.query(`select count(*)::int n from information_schema.columns where table_schema = 'public'
    and table_name = 'safety_consents' and column_name in ('status','cancelled_at','cancel_reason')`)).rows[0].n === 3;
}

/** DB 에 실제로 남은 것 (관리자 연결) */
export async function dbState(c, consentId, queueId) {
  const one = async (sql, p) => (await c.query(sql, p)).rows;
  return {
    items: await one(`select item_id, order_id, product_category, quantity, paid_amount, status from public.order_items where consent_id = $1 order by item_id`, [consentId]),
    pays: await one(`select id, order_id, amount, status from public.order_payments where consent_id = $1 order by id`, [consentId]),
    tickets: await one(`select ticket_id, order_id, status from public.ticket_ledger where consent_id = $1 order by ticket_id`, [consentId]),
    queue: (await one(`select status, order_id, ticket_ids from public.ticket_queue where id = $1`, [queueId]))[0],
    consent: (await one(`select to_jsonb(c) - 'signature_data' - 'children' as row from public.safety_consents c where id = $1`, [consentId]))[0].row
  };
}

/** 정적 파일 + config.js + /rest/v1 → PostgREST 전달 프록시 */
export async function startProxy() {
  const env = loadEnv();
  const OPS = path.join(FRONT_ROOT, '01_봉플레이_운영시스템');
  const state = { log: [], faults: [] };
  const take = (kind, name, method) => {
    const f = state.faults.find((x) => x.kind === kind && x.name === name && (!x.method || x.method === method) && x.times > 0);
    if (f) f.times -= 1;
    return f || null;
  };
  const tmpl = fs.readFileSync(path.join(OPS, 'assets', 'config.template.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p.endsWith('/assets/config.js')) {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(tmpl.replace('https://YOUR_PROJECT_ID.supabase.co', origin).replace('YOUR_ANON_PUBLIC_KEY', env.E2E_ANON_KEY));
    }
    if (p.startsWith('/rest/v1/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const rest = p.slice('/rest/v1/'.length);
        const isRpc = rest.startsWith('rpc/');
        const entry = { t: Date.now(), kind: isRpc ? 'rpc' : 'rest', name: isRpc ? rest.slice(4) : rest, method: req.method, query: url.search, status: null, fault: null };
        try { entry.body = body.length ? JSON.parse(body.toString()) : null; } catch (e) { entry.body = null; }
        state.log.push(entry);
        const f = take(entry.kind, entry.name, req.method);
        // hook: 전달 직전에 시험 동작 실행(예: 서버 암호 교체·API 서버 정지·단말 오프라인 전환) 후 그대로 전달.
        //       fn 이 'drop' 을 돌려주면 이 요청은 서버에 보내지 않고 연결을 끊는다
        let dropIt = f && f.mode === 'drop';
        if (f && f.mode === 'hook') { entry.fault = 'hook'; if ((await f.fn(entry)) === 'drop') dropIt = true; }
        // drop: 서버에 보내지 않고 연결을 끊는다 (응답 없음 — 브라우저에는 실제 연결 끊김)
        if (dropIt) { entry.fault = 'drop'; entry.status = 0; return req.socket.destroy(); }
        if (f && f.mode === '503') { entry.fault = '503'; entry.status = 503; res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"message":"SYN injected 503"}'); }
        const headers = { 'X-Forwarded-For': DEVICE_IP };
        for (const h of ['apikey', 'authorization', 'content-type', 'prefer', 'accept', 'range']) if (req.headers[h]) headers[h] = req.headers[h];
        try {
          const up = await fetch(env.E2E_PGRST_URL + '/' + rest + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
          const text = await up.text();
          entry.status = up.status;
          entry.response = text.slice(0, 400);
          // reset: 서버가 처리(커밋)한 뒤 응답 대신 연결을 끊는다 (실제 TCP 끊김 — 브라우저가 스스로 재전송할 수 있음)
          if (f && f.mode === 'reset') { entry.fault = 'reset'; return req.socket.destroy(); }
          if (f && f.mode === 'lost') { entry.fault = 'lost'; res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"message":"SYN response lost after commit"}'); }
          const out = { 'Content-Type': up.headers.get('content-type') || 'application/json' };
          if (up.headers.get('content-range')) out['Content-Range'] = up.headers.get('content-range');
          res.writeHead(up.status, out);
          res.end(text);
        } catch (e) {
          entry.status = 502; res.writeHead(502); res.end(String(e));
        }
      });
      return;
    }
    const file = path.join(OPS, p);
    if (file.startsWith(OPS) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    fault(kind, name, mode, { times = Infinity, method, fn } = {}) { state.faults.push({ kind, name, mode, times, method, fn }); },
    clearFaults() { state.faults.length = 0; },
    calls(kind, name) { return state.log.filter((e) => e.kind === kind && e.name === name); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })
  };
}

const CDN_STUBS = [
  [/cdn\.tailwindcss\.com/, 'window.tailwind = { config: {} };'],
  [/lucide/, 'window.lucide = { createIcons: function () {} };'],
  [/qrcode/i, 'window.QRCode = function () {}; window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };'],
  [/supabase-js/, '']
];

/**
 * 운영 화면 하나를 새 단말(새 브라우저 컨텍스트, 빈 localStorage)로 연다.
 * 직원 로그인은 config.js 의 실제 인증 창에 시험 암호를 넣어 서버(verify_staff_access)로 검증받는다.
 * timezoneId: 단말 시간대 (기본 Asia/Seoul — 현장 단말). 화면은 오늘 날짜를 단말 시간대로 계산한다(BongplaySync.toLocalDateStr).
 *   컨테이너 기본 UTC 로 두면 KST 00:00~09:00 에 화면의 '오늘'이 전날이 되므로, 기본 시험은 KST 로 맞추고 비KST 단말은 따로 시험한다.
 * localPassAudit: 이 단말 localStorage 에만 오늘 PASS 점검 기록이 있는 상태를 만든다 (서버와 무관).
 */
export async function openPage(proxy, pagePath, { localPassAudit = false, timezoneId = 'Asia/Seoul', waitReady } = {}) {
  const env = loadEnv();
  const pw = await playwright();
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId });
  if (localPassAudit) {
    await context.addInitScript((today) => {
      try {
        if (!localStorage.getItem('bongplay_safety_audit_logs')) {
          localStorage.setItem('bongplay_safety_audit_logs', JSON.stringify([{ id: 'LOG_SYN_LOCAL', date: today + 'T08:30', decision: 'pass', audit_date: today }]));
        }
      } catch (e) {}
    }, kstToday());
  }
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(proxy.base)) return route.continue();
    const stub = CDN_STUBS.find(([re]) => re.test(u));
    return stub ? route.fulfill({ status: 200, contentType: 'application/javascript', body: stub[1] }) : route.abort();
  });
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message(), t: Date.now() });
    try { await d.accept(d.type() === 'prompt' ? (d.defaultValue() || '고객 요청') : undefined); } catch (e) { /* 닫힘 */ }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push({ t: Date.now(), url: f.url() }); });
  await page.goto(proxy.base + pagePath, { waitUntil: 'load' });
  if (await page.locator('#bongplay-auth-input').count()) {
    await page.fill('#bongplay-auth-input', env.E2E_STAFF_CODE);
    await page.click('#bongplay-auth-submit');
  }
  // 로그인이 끝나고(암호 저장·인증 창 제거) 첫 동기화가 가라앉을 때까지 기다린다
  await page.waitForFunction(() => window.BongplayAuth && BongplayAuth.getAccessCode() && !document.getElementById('bongplay-auth-overlay'), null, { timeout: 15000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  if (waitReady) await page.waitForFunction(waitReady, null, { timeout: 15000 });
  return { page, context, dialogs, errors, navs, timezoneId, close: () => browser.close() };
}

/** 매표 화면 (consent-desk.html) */
export const openDesk = (proxy, opts = {}) => openPage(proxy, '/pages/consent-desk.html', opts);

/**
 * 지금 이 순간 단말 날짜가 KST 날짜와 다른 시간대 하나를 고른다 (비KST 단말 시험용).
 * UTC-11 과 UTC+14 중 하나는 언제나 KST(UTC+9)와 날짜가 다르다.
 */
export function nonKstZoneWithOtherDate(now = new Date()) {
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const kst = fmt('Asia/Seoul');
  for (const tz of ['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
    if (fmt(tz) !== kst) return { timezoneId: tz, deviceDate: fmt(tz), kstDate: kst };
  }
  throw new Error('KST 와 날짜가 다른 시간대를 찾지 못함');
}

/** 실제 API 서버(PostgREST) 정지·재기동 — 서버 쪽 통신 중단 재현 (desk_e2e_stack.sh 가 stack.env 에 경로를 남긴다) */
export async function stopApiServer() {
  const env = loadEnv();
  const pid = Number(fs.readFileSync(env.E2E_PGRST_PID, 'utf8'));
  try { process.kill(pid, 'SIGTERM'); } catch (e) { /* 이미 정지 */ }
  await waitFor(async () => { try { await fetch(env.E2E_PGRST_URL + '/'); return false; } catch (e) { return true; } }, { timeout: 10000 });
}
export async function startApiServer() {
  const env = loadEnv();
  const out = fs.openSync(env.E2E_PGRST_CONF + '.restart.log', 'a');
  const child = spawn(env.E2E_PGRST_BIN, [env.E2E_PGRST_CONF], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(env.E2E_PGRST_PID, String(child.pid));
  const ok = await waitFor(async () => {
    try { const r = await fetch(env.E2E_PGRST_URL + '/rpc/get_queue_public_display', { method: 'POST', headers: { apikey: env.E2E_ANON_KEY, Authorization: 'Bearer ' + env.E2E_ANON_KEY, 'Content-Type': 'application/json' }, body: '{}' }); return r.status === 200; } catch (e) { return false; }
  }, { timeout: 20000, interval: 200 });
  if (!ok) throw new Error('PostgREST 재기동 실패');
}

export async function waitFor(fn, { timeout = 8000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, interval)); }
  return !!(await fn());
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

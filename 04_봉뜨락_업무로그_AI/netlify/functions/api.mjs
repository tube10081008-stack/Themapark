/**
 * 봉뜨락 업무로그 — 단일 서버리스 함수.
 *
 *   POST /api/classify  { text, code }   → 모델이 분류한 항목 배열 (시트에 쓰지 않음)
 *   POST /api/append    { items, code }  → 승인한 항목을 구글 시트에 행으로 추가
 *   GET  /api/config                     → 화면 초기화에 필요한 값 (키는 절대 내려보내지 않음)
 *
 * 외부 패키지를 하나도 쓰지 않는다. Netlify 에 zip 을 끌어다 놓으면 npm install 이 돌지 않기
 * 때문이다. 구글 인증(JWT 서명)은 Node 내장 crypto 로, HTTP 는 내장 fetch 로 처리한다.
 *
 * 환경변수 (Netlify: Site configuration → Environment variables)
 *   SAKANA_API_KEY / GEMINI_API_KEY   둘 중 하나 (넣은 쪽이 자동 선택, 둘 다면 Sakana)
 *   SHEET_ID                          적재할 스프레드시트 ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL      서비스 계정 이메일 (...gserviceaccount.com)
 *   GOOGLE_PRIVATE_KEY                서비스 계정 비밀키 (-----BEGIN PRIVATE KEY----- ...)
 *   ACCESS_CODE                       (선택) 설정하면 화면에서 이 코드를 입력해야 동작
 *   LLM_PROVIDER / SAKANA_MODEL / GEMINI_MODEL / LLM_BASE_URL / SHEET_NAME  (선택)
 */

import crypto from 'node:crypto';

const SAKANA_BASE_URL = 'https://api.sakana.ai/v1';
const DEFAULT_SAKANA_MODEL = 'fugu';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';

const TZ = 'Asia/Seoul';
const HEADERS = ['타임스탬프', '분류', '핵심 요약', '담당자', '마감일', '우선순위', '상태', '원문 맥락'];
const CATEGORIES = ['DECISION', 'TODO', 'INFO', 'IDEA'];
const CATEGORY_TAG = { DECISION: '[결정]', TODO: '[할일]', INFO: '[공유]', IDEA: '[아이디어]' };
const DEFAULT_STATUS = { DECISION: '대기', TODO: '대기', INFO: '완료', IDEA: '검토' };
const OWNERS = ['성현', '지연', '주성', '공통', '미지정'];
const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
const STATUSES = ['대기', '진행', '완료', '검토', '보류'];
const NO_DUE = '미정';

const MAX_INPUT_CHARS = 12000;
const MAX_ITEMS = 50;
const MAX_TEXT_FIELD = 500;

const SYSTEM_PROMPT = [
  'You are an operational executive assistant for "Little Forest Bongplay"',
  '(an outdoor children\'s adventure park preparing for its November opening).',
  'Your job is to read unstructured group chat messages or voice notes among the 3 founders',
  '(Seong-hyun/성현: CEO/General, Ji-yeon/지연: Ticketing/Admin, Ju-sung/주성: Safety/Field)',
  'and extract structured action logs.',
  '',
  'For each distinct point in the text, categorize it into EXACTLY ONE of the following 4 categories:',
  '1. DECISION (결정): Items that require the CEO\'s final approval/decision, or confirmed business decisions.',
  '2. TODO (할일): Action items with an owner and/or deadline.',
  '3. INFO (공유): Status updates, notices, official government contacts (e.g. County office), no immediate reply required.',
  '4. IDEA (아이디어): Future proposals, creative thoughts (to be reviewed later or post-opening).',
  '',
  'Rules:',
  '- Infer the owner based on context (Ticketing/Kiosk/Receipts -> 지연, Coaster/Net/Safety/Maintenance -> 주성, Licensing/Contracts/Budget -> 성현).',
  '- If the owner cannot be inferred, use 미지정. If it applies to everyone, use 공통.',
  '- If multiple tasks are mixed in one message, separate them into distinct items.',
  '- Filter out pure casual greetings or small talk. If nothing is actionable, return an empty list.',
  '- "summary" is one short Korean sentence in 개조식 (noun-ending) style.',
  '- "context" is a 1~2 line Korean summary of the original wording, including numbers and names when present.',
  '- Resolve relative dates ("내일", "다음 주 월요일") against TODAY given in the user message, and output YYYY-MM-DD.',
  '- If there is no deadline, output "미정" for due_date. Never invent a deadline.',
  '- Do not add markdown code fences. Return raw JSON only.',
].join('\n');

const JSON_FORMAT_NOTE = [
  '',
  'Return a single JSON object of this exact shape:',
  '{"items":[{"category":"DECISION|TODO|INFO|IDEA","summary":"<Korean>","owner":"성현|지연|주성|공통|미지정",',
  '"due_date":"YYYY-MM-DD or 미정","context":"<Korean>","priority":"HIGH|MEDIUM|LOW"}]}',
  'If nothing is actionable, return {"items":[]}.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: CATEGORIES },
      summary: { type: 'STRING' },
      owner: { type: 'STRING', enum: OWNERS },
      due_date: { type: 'STRING' },
      context: { type: 'STRING' },
      priority: { type: 'STRING', enum: PRIORITIES },
    },
    required: ['category', 'summary', 'owner', 'due_date', 'context', 'priority'],
    propertyOrdering: ['category', 'summary', 'owner', 'due_date', 'context', 'priority'],
  },
};

// ── 시간 ────────────────────────────────────────────────────────────

export function kstParts(date = new Date()) {
  const text = date.toLocaleString('sv-SE', { timeZone: TZ });   // "2026-09-14 15:30:12"
  return { day: text.slice(0, 10), stamp: text.slice(0, 16) };
}

// ── 정규화 ──────────────────────────────────────────────────────────

export function parseModelJson(text) {
  let body = String(text || '').trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new UserError('모델이 JSON 형식으로 답하지 않았습니다. 다시 시도해주세요.');
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && typeof data === 'object') return [data];
  throw new UserError('모델 응답에서 항목을 찾지 못했습니다.');
}

export function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .map(normalizeItem)
    .filter((item) => item.summary)
    .slice(0, MAX_ITEMS);
}

export function normalizeItem(raw) {
  const category = pick(raw.category, CATEGORIES, 'INFO');
  return {
    category,
    summary: clean(raw.summary),
    owner: pick(raw.owner, OWNERS, '미지정'),
    due_date: normalizeDue(raw.due_date ?? raw.due),
    context: clean(raw.context),
    priority: pick(raw.priority, PRIORITIES, 'MEDIUM'),
    status: pick(raw.status, STATUSES, DEFAULT_STATUS[category]),
  };
}

export function normalizeDue(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!match) return NO_DUE;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return NO_DUE;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function itemToRow(item, timestamp) {
  return [
    timestamp,
    CATEGORY_TAG[item.category] || CATEGORY_TAG.INFO,
    item.summary,
    item.owner,
    item.due_date,
    item.priority,
    item.status,
    item.context,
  ];
}

function pick(value, allowed, fallback) {
  const text = String(value ?? '').trim().toUpperCase();
  return allowed.find((option) => String(option).toUpperCase() === text) ?? fallback;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_FIELD);
}

/** 화면에 그대로 보여줄 수 있는 오류. 그 외 오류는 일반 문구로 가린다. */
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ── 모델 호출 ───────────────────────────────────────────────────────

export function resolveProvider(explicit, sakanaKey, geminiKey) {
  const named = String(explicit ?? '').trim().toLowerCase();
  if (named === 'sakana' || named === 'gemini') return named;
  if (String(sakanaKey ?? '').trim()) return 'sakana';
  if (String(geminiKey ?? '').trim()) return 'gemini';
  return '';
}

async function callModel(input, env) {
  const provider = resolveProvider(env.LLM_PROVIDER, env.SAKANA_API_KEY, env.GEMINI_API_KEY);
  if (provider === 'sakana') return callOpenAiCompatible(input, env);
  if (provider === 'gemini') return callGemini(input, env);
  throw new UserError('API 키가 설정되지 않았습니다. Netlify 환경변수에 SAKANA_API_KEY 또는 GEMINI_API_KEY 를 넣어주세요.', 500);
}

async function callOpenAiCompatible(input, env) {
  const base = (env.LLM_BASE_URL || SAKANA_BASE_URL).replace(/\/+$/, '');
  const model = env.SAKANA_MODEL || DEFAULT_SAKANA_MODEL;
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + JSON_FORMAT_NOTE },
      { role: 'user', content: `TODAY: ${kstParts().day}\n\n---\n${input}` },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SAKANA_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (response.ok) return extractChatText(body);

    // 이 옵션들을 모르는 엔드포인트가 있다. 해당 항목만 빼고 다시 시도한다
    // (출력 형식은 프롬프트에도 적어두었으므로 JSON 모드 없이도 파싱된다).
    if (response.status === 400 && /response_format/i.test(body) && payload.response_format) {
      delete payload.response_format;
      continue;
    }
    if (response.status === 400 && /temperature/i.test(body) && payload.temperature !== undefined) {
      delete payload.temperature;
      continue;
    }
    lastError = chatErrorMessage(response.status, body, model);
    if (response.status === 429 || response.status >= 500) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    throw new UserError(lastError);
  }
  throw new UserError(lastError || '모델 호출에 실패했습니다.');
}

async function callGemini(input, env) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: `TODAY: ${kstParts().day}\n\n---\n${input}` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: (env.GEMINI_THINKING_LEVEL || 'low').toLowerCase() },
    },
  };

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (response.ok) return extractGeminiText(body);

    if (response.status === 400 && /thinking/i.test(body) && payload.generationConfig.thinkingConfig) {
      delete payload.generationConfig.thinkingConfig;
      continue;
    }
    lastError = chatErrorMessage(response.status, body, model);
    if (response.status === 429 || response.status >= 500) {
      await sleep(800 * (attempt + 1));
      continue;
    }
    throw new UserError(lastError);
  }
  throw new UserError(lastError || '모델 호출에 실패했습니다.');
}

function chatErrorMessage(status, body, model) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.error?.code || '';
  } catch {
    detail = String(body).slice(0, 200);
  }
  if (status === 401 || /API key/i.test(detail)) return 'API 키가 올바르지 않습니다. Netlify 환경변수를 확인하세요.';
  if (status === 402 || /quota|credit|balance/i.test(detail)) return '계정의 크레딧 또는 사용 한도가 부족합니다.';
  if (status === 403) return 'API 접근이 거부되었습니다 (키 권한 또는 지역 제한 확인).';
  if (status === 404) return `모델 "${model}" 을(를) 찾을 수 없습니다. 모델 이름을 확인하세요.`;
  if (status === 429) return '요청이 몰렸습니다. 잠시 후 다시 시도해주세요.';
  if (status >= 500) return `모델 서버 오류(${status}). 잠시 후 다시 시도해주세요.`;
  return `모델 오류(${status}): ${detail}`;
}

function extractChatText(body) {
  const data = safeJson(body);
  const choice = data?.choices?.[0];
  if (!choice) throw new UserError('모델이 결과를 반환하지 않았습니다.');
  if (choice.finish_reason === 'length') {
    throw new UserError('내용이 너무 길어 결과가 잘렸습니다. 입력을 나눠서 다시 시도해주세요.');
  }
  const text = String(choice.message?.content ?? '').trim();
  if (!text) throw new UserError('모델 응답이 비어 있습니다.');
  return text;
}

function extractGeminiText(body) {
  const data = safeJson(body);
  if (data?.promptFeedback?.blockReason) {
    throw new UserError(`안전 필터에 걸려 분류하지 못했습니다 (${data.promptFeedback.blockReason}).`);
  }
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new UserError('모델이 결과를 반환하지 않았습니다.');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new UserError('내용이 너무 길어 결과가 잘렸습니다. 입력을 나눠서 다시 시도해주세요.');
    }
    throw new UserError(`모델이 응답을 완료하지 못했습니다 (${candidate.finishReason}).`);
  }
  const text = (candidate.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
  if (!text) throw new UserError('모델 응답이 비어 있습니다.');
  return text;
}

function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new UserError('모델 응답을 해석하지 못했습니다.');
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 구글 시트 (서비스 계정) ─────────────────────────────────────────

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

/** 서비스 계정 JWT 로 액세스 토큰을 받는다. 토큰은 1시간짜리라 함수 인스턴스에 잠깐 재사용한다. */
let cachedToken = { value: '', expiresAt: 0 };

async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.value && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const email = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const rawKey = String(env.GOOGLE_PRIVATE_KEY || '');
  if (!email || !rawKey) {
    throw new UserError('구글 서비스 계정 환경변수가 비어 있습니다. README 의 「3. 구글 시트 연결」을 참고하세요.', 500);
  }
  // Netlify 환경변수는 줄바꿈을 \n 문자열로 넣는 경우가 많다. 둘 다 받아들인다.
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), crypto.createPrivateKey(privateKey));
  } catch {
    throw new UserError('서비스 계정 비밀키 형식이 잘못되었습니다. JSON 의 private_key 값을 그대로 넣었는지 확인하세요.', 500);
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${base64url(signature)}`,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = safeJsonSoft(body)?.error_description || '';
    throw new UserError(`구글 인증에 실패했습니다. 서비스 계정 설정을 확인하세요. ${detail}`.trim(), 500);
  }
  const token = safeJsonSoft(body)?.access_token;
  if (!token) throw new UserError('구글 인증 응답에 토큰이 없습니다.', 500);
  cachedToken = { value: token, expiresAt: now + 3000 };
  return token;
}

function safeJsonSoft(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function sheetsRequest(env, path, init = {}) {
  const sheetId = String(env.SHEET_ID || '').trim();
  if (!sheetId) throw new UserError('SHEET_ID 환경변수가 비어 있습니다.', 500);
  const token = await accessToken(env);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = safeJsonSoft(body)?.error?.message || '';
    if (response.status === 403) {
      throw new UserError('시트에 접근할 수 없습니다. 서비스 계정 이메일을 시트에 편집자로 공유했는지 확인하세요.', 500);
    }
    if (response.status === 404) throw new UserError('시트를 찾을 수 없습니다. SHEET_ID 를 확인하세요.', 500);
    if (/Unable to parse range/i.test(detail)) {
      throw new UserError(
        `"${env.SHEET_NAME || '업무로그'}" 시트 탭을 찾지 못했습니다. 스프레드시트 아래쪽 탭 이름을 확인하거나, ` +
        'SHEET_NAME 환경변수를 실제 탭 이름으로 맞춰주세요.',
        500
      );
    }
    throw new UserError(`구글 시트 오류(${response.status}): ${detail}`, 500);
  }
  return safeJsonSoft(body) ?? {};
}

/** A1 표기의 시트 이름은 따옴표로 감싼다 — 한글·공백 이름에서 range 파싱이 깨지지 않도록. */
export function quoteRange(sheetName, a1) {
  return `'${String(sheetName).replace(/'/g, "''")}'!${a1}`;
}

/** 탭과 헤더가 없으면 만들어 준다. 새 스프레드시트에는 '시트1' 하나뿐인 경우가 대부분이다. */
let ensuredSheet = '';

async function ensureSheet(env, sheetName) {
  if (ensuredSheet === sheetName) return;   // 같은 인스턴스에서 두 번 확인하지 않는다

  const meta = await sheetsRequest(env, '?fields=sheets.properties.title');
  const titles = (meta.sheets ?? []).map((sheet) => sheet.properties?.title);
  if (!titles.includes(sheetName)) {
    await sheetsRequest(env, ':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
    });
  }

  const range = encodeURIComponent(quoteRange(sheetName, 'A1:H1'));
  const current = await sheetsRequest(env, `/values/${range}`);
  if (!current.values?.[0]?.length) {
    await sheetsRequest(env, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [HEADERS] }),
    });
  }
  ensuredSheet = sheetName;
}

async function appendRows(env, rows) {
  const sheetName = env.SHEET_NAME || '업무로그';
  await ensureSheet(env, sheetName);
  const range = encodeURIComponent(quoteRange(sheetName, 'A1'));
  const result = await sheetsRequest(env, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: rows }),
  });

  // 구글이 200 을 주면서 아무것도 쓰지 않는 경우가 있다(권한·범위 문제).
  // 기록됐다고 화면에 알리기 전에 '몇 행이 어디에' 들어갔는지 응답으로 확인한다.
  const updatedRows = result.updates?.updatedRows ?? 0;
  const updatedRange = result.updates?.updatedRange ?? '';
  if (updatedRows < rows.length) {
    throw new UserError(
      `시트에 기록되지 않았습니다 (요청 ${rows.length}행 / 기록 ${updatedRows}행). ` +
      '아래 「연결 상태 확인」으로 어느 시트·탭에 쓰고 있는지 확인해주세요.',
      500
    );
  }
  return { updatedRows, updatedRange };
}

/** 시트에 쌓인 행을 읽어 온다. 화면의 '원장' 탭이 이걸 그린다. */
async function readRows(env) {
  const sheetName = env.SHEET_NAME || '업무로그';
  const range = encodeURIComponent(quoteRange(sheetName, 'A2:H2000'));
  const data = await sheetsRequest(env, `/values/${range}`);   // 실패는 그대로 화면에 보여준다
  return (data.values ?? [])
    .filter((row) => row[2])            // 요약이 비면 빈 줄
    .map((row) => ({
      ts: row[0] ?? '',
      tag: row[1] ?? '',
      summary: row[2] ?? '',
      owner: row[3] ?? '',
      due: row[4] ?? '',
      priority: row[5] ?? '',
      status: row[6] ?? '',
      context: row[7] ?? '',
    }))
    .reverse();                         // 최근 것이 위로
}

/**
 * 연결 상태 진단. "전송했다는데 시트에 없다" 같은 상황에서 추측을 없애기 위한 것.
 * 어느 스프레드시트(제목!)의 어떤 탭에 몇 행이 있는지, 도구가 쓰는 탭은 무엇인지 보여준다.
 */
async function diagnostics(env) {
  const configuredTab = env.SHEET_NAME || '업무로그';
  const meta = await sheetsRequest(
    env,
    '?fields=properties.title,sheets.properties(title,hidden)'
  );

  const tabs = [];
  for (const sheet of (meta.sheets ?? []).slice(0, 8)) {
    const title = sheet.properties?.title ?? '';
    const values = await sheetsRequest(env, `/values/${encodeURIComponent(quoteRange(title, 'A1:H2000'))}`);
    const grid = values.values ?? [];
    const hasHeader = looksLikeHeader(grid[0]);
    const body = grid.filter((row, index) => !(index === 0 && hasHeader) && String(row[2] ?? '').trim());
    tabs.push({
      title,
      hidden: Boolean(sheet.properties?.hidden),
      dataRows: body.length,
      header: (grid[0] ?? []).slice(0, 4).join(' | '),
      lastSummary: body.length ? String(body[body.length - 1][2]) : '',
    });
  }

  return {
    spreadsheetTitle: meta.properties?.title ?? '',
    spreadsheetUrl: sheetUrl(env),
    sheetIdTail: String(env.SHEET_ID || '').slice(-8),
    configuredTab,
    configuredTabExists: tabs.some((tab) => tab.title === configuredTab),
    serviceAccount: String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || ''),
    provider: resolveProvider(env.LLM_PROVIDER, env.SAKANA_API_KEY, env.GEMINI_API_KEY) || '(키 없음)',
    tabs,
  };
}

/**
 * 스프레드시트에 고품질 프리미엄 서식 (틀 고정, 헤더 스타일, 열 너비, 줄무늬 행, 우선순위·상태 조건부 서식) 적용
 */
async function formatWorklogSheet(env, sheetName) {
  const meta = await sheetsRequest(
    env,
    '?fields=sheets(properties(sheetId,title),bandedRanges(bandedRangeId),conditionalFormats)'
  );
  const sheetObj = (meta.sheets ?? []).find((s) => s.properties?.title === sheetName);
  if (!sheetObj) {
    throw new UserError(`"${sheetName}" 탭을 찾을 수 없습니다.`, 404);
  }
  const sheetId = sheetObj.properties.sheetId;

  // 1. 기존 조건부 서식 및 밴딩 정리 (중복 생성 방지)
  const cleanupRequests = [];
  if (Array.isArray(sheetObj.conditionalFormats)) {
    for (let i = sheetObj.conditionalFormats.length - 1; i >= 0; i--) {
      cleanupRequests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }
  }
  if (Array.isArray(sheetObj.bandedRanges)) {
    for (const b of sheetObj.bandedRanges) {
      if (b.bandedRangeId !== undefined) {
        cleanupRequests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
      }
    }
  }
  if (cleanupRequests.length) {
    try {
      await sheetsRequest(env, ':batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ requests: cleanupRequests }),
      });
    } catch (e) {
      console.warn('기존 서식 정리 중 일부 건너뜀:', e);
    }
  }

  // 2. 신규 서식 적용
  const colWidths = [140, 85, 360, 75, 105, 85, 75, 450];
  const requests = [
    // 2-1. 1행 틀 고정 (스크롤 시에도 헤더 항상 상단 고정)
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // 2-2. 1행 헤더 행 높이 42px
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 42 },
        fields: 'pixelSize',
      },
    },
    // 2-3. 열 너비 최적화 (요약과 맥락을 넓게, 코드는 콤팩트하게)
    ...colWidths.map((w, idx) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: idx, endIndex: idx + 1 },
        properties: { pixelSize: w },
        fields: 'pixelSize',
      },
    })),
    // 2-4. 1행 헤더 스타일 (짙은 슬레이트 네이비 배경, 볼드 화이트 텍스트, 중앙 정렬)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 8 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.118, green: 0.161, blue: 0.231 }, // #1E293B
            textFormat: {
              foregroundColor: { red: 1, green: 1, blue: 1 },
              bold: true,
              fontSize: 11,
            },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'CLIP',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
      },
    },
    // 2-5. 데이터 행 기본 정렬 & 줄바꿈 (세로 중앙 정렬)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 },
        cell: {
          userEnteredFormat: {
            verticalAlignment: 'MIDDLE',
            textFormat: { fontSize: 10 },
          },
        },
        fields: 'userEnteredFormat(verticalAlignment,textFormat.fontSize)',
      },
    },
    // 타임스탬프 (Col 0: 가운데 정렬, 차분한 회색)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 1 },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            textFormat: { foregroundColor: { red: 0.392, green: 0.455, blue: 0.545 }, fontSize: 9.5 },
          },
        },
        fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
      },
    },
    // 분류 (Col 1: 가운데 정렬)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    },
    // 핵심 요약 (Col 2: 왼쪽 정렬, 줄바꿈 활성화)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'LEFT',
            wrapStrategy: 'WRAP',
            textFormat: { bold: true, foregroundColor: { red: 0.09, green: 0.12, blue: 0.16 } },
          },
        },
        fields: 'userEnteredFormat(horizontalAlignment,wrapStrategy,textFormat)',
      },
    },
    // 담당자 (Col 3: 가운데 정렬)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    },
    // 마감일 (Col 4: 가운데 정렬)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 4, endColumnIndex: 5 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    },
    // 우선순위 (Col 5: 가운데 정렬, 볼드)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 5, endColumnIndex: 6 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } },
        fields: 'userEnteredFormat(horizontalAlignment,textFormat.bold)',
      },
    },
    // 상태 (Col 6: 가운데 정렬, 볼드)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 6, endColumnIndex: 7 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } },
        fields: 'userEnteredFormat(horizontalAlignment,textFormat.bold)',
      },
    },
    // 원문 맥락 (Col 7: 왼쪽 정렬, 줄바꿈 활성화)
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 7, endColumnIndex: 8 },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'LEFT',
            wrapStrategy: 'WRAP',
            textFormat: { foregroundColor: { red: 0.35, green: 0.40, blue: 0.48 } },
          },
        },
        fields: 'userEnteredFormat(horizontalAlignment,wrapStrategy,textFormat)',
      },
    },
    // 2-6. 줄무늬 행 (Banding - 화이트 & 슬레이트 교차)
    {
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 },
          rowProperties: {
            headerColor: { red: 0.118, green: 0.161, blue: 0.231 },
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.973, green: 0.980, blue: 0.988 }, // #F8FAFC
          },
        },
      },
    },
    // 2-7. 데이터 필터 버튼 장착 (우선순위/담당자/상태별 즉시 필터)
    {
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 8 },
        },
      },
    },
    // 2-8. 조건부 서식: 우선순위 HIGH (연붉은 배경 + 진붉은색 볼드)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'HIGH' }] },
            format: {
              backgroundColor: { red: 0.996, green: 0.886, blue: 0.886 }, // #FEE2E2
              textFormat: { foregroundColor: { red: 0.600, green: 0.106, blue: 0.106 }, bold: true },
            },
          },
        },
        index: 0,
      },
    },
    // 2-9. 조건부 서식: 우선순위 MEDIUM (호박색 배경 + 진갈색 볼드)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'MEDIUM' }] },
            format: {
              backgroundColor: { red: 0.996, green: 0.953, blue: 0.780 }, // #FEF3C7
              textFormat: { foregroundColor: { red: 0.573, green: 0.251, blue: 0.055 }, bold: true },
            },
          },
        },
        index: 1,
      },
    },
    // 2-10. 조건부 서식: 우선순위 LOW (연회색 배경 + 차분한 텍스트)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 5, endColumnIndex: 6 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'LOW' }] },
            format: {
              backgroundColor: { red: 0.945, green: 0.961, blue: 0.976 }, // #F1F5F9
              textFormat: { foregroundColor: { red: 0.400, green: 0.450, blue: 0.520 } },
            },
          },
        },
        index: 2,
      },
    },
    // 2-11. 조건부 서식: 상태 (대기 / 진행 / 검토 / 완료)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 6, endColumnIndex: 7 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '대기' }] },
            format: {
              backgroundColor: { red: 0.996, green: 0.976, blue: 0.765 }, // #FEF9C3
              textFormat: { foregroundColor: { red: 0.522, green: 0.302, blue: 0.055 }, bold: true },
            },
          },
        },
        index: 3,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 6, endColumnIndex: 7 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '진행' }] },
            format: {
              backgroundColor: { red: 0.859, green: 0.918, blue: 0.996 }, // #DBEAFE
              textFormat: { foregroundColor: { red: 0.118, green: 0.251, blue: 0.686 }, bold: true },
            },
          },
        },
        index: 4,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 6, endColumnIndex: 7 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '검토' }] },
            format: {
              backgroundColor: { red: 0.953, green: 0.910, blue: 1.0 }, // #F3E8FF
              textFormat: { foregroundColor: { red: 0.420, green: 0.129, blue: 0.659 }, bold: true },
            },
          },
        },
        index: 5,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 6, endColumnIndex: 7 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '완료' }] },
            format: {
              backgroundColor: { red: 0.863, green: 0.988, blue: 0.906 }, // #DCFCE7
              textFormat: { foregroundColor: { red: 0.086, green: 0.396, blue: 0.204 }, bold: true },
            },
          },
        },
        index: 6,
      },
    },
    // 2-12. 조건부 서식: 분류 태그 ([결정], [할일], [공유], [아이디어])
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: '결정' }] },
            format: {
              backgroundColor: { red: 0.960, green: 0.930, blue: 1.0 },
              textFormat: { foregroundColor: { red: 0.420, green: 0.129, blue: 0.659 }, bold: true },
            },
          },
        },
        index: 7,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: '할일' }] },
            format: {
              backgroundColor: { red: 1.0, green: 0.945, blue: 0.949 },
              textFormat: { foregroundColor: { red: 0.624, green: 0.071, blue: 0.224 }, bold: true },
            },
          },
        },
        index: 8,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: '공유' }] },
            format: {
              backgroundColor: { red: 0.925, green: 0.992, blue: 0.961 },
              textFormat: { foregroundColor: { red: 0.024, green: 0.373, blue: 0.275 }, bold: true },
            },
          },
        },
        index: 9,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 1, endColumnIndex: 2 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: '아이디어' }] },
            format: {
              backgroundColor: { red: 0.941, green: 0.976, blue: 1.0 },
              textFormat: { foregroundColor: { red: 0.012, green: 0.412, blue: 0.631 }, bold: true },
            },
          },
        },
        index: 10,
      },
    },
  ];

  await sheetsRequest(env, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });

  return { ok: true, sheetId, title: sheetName };
}

const looksLikeHeader = (row) => Boolean(row && String(row[0] ?? '').includes('타임스탬프'));

// ── 요청 처리 ───────────────────────────────────────────────────────

function checkAccess(env, code) {
  const expected = String(env.ACCESS_CODE || '').trim();
  if (!expected) return;
  if (String(code || '').trim() !== expected) throw new UserError('접근 코드가 올바르지 않습니다.', 401);
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const sheetUrl = (env) =>
  env.SHEET_ID ? `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/edit` : '';

export default async function handler(request) {
  const env = process.env;
  const action = new URL(request.url).pathname.split('/').filter(Boolean).pop();

  try {
    if (action === 'config') {
      return json({
        needsAccessCode: Boolean(String(env.ACCESS_CODE || '').trim()),
        sheetUrl: sheetUrl(env),
        owners: OWNERS,
        priorities: PRIORITIES,
        statuses: STATUSES,
        categories: CATEGORIES,
        categoryTag: CATEGORY_TAG,
        today: kstParts().day,
        noDue: NO_DUE,
      });
    }

    if (request.method !== 'POST') return json({ error: '지원하지 않는 요청입니다.' }, 405);
    const payload = await request.json().catch(() => ({}));
    checkAccess(env, payload.code);

    if (action === 'classify') {
      const text = String(payload.text || '').trim();
      if (!text) throw new UserError('입력된 내용이 없습니다.');
      if (text.length > MAX_INPUT_CHARS) {
        throw new UserError(`입력이 너무 깁니다 (${text.length}자). ${MAX_INPUT_CHARS}자 이하로 나눠서 넣어주세요.`);
      }
      const started = Date.now();
      const items = normalizeItems(parseModelJson(await callModel(text, env)));

      // 자동 전송: 분류와 적재를 한 번의 왕복으로 끝낸다.
      let saved = 0;
      let savedRange = '';
      if (payload.autosave && items.length) {
        const written = await appendRows(env, items.map((item) => itemToRow(item, kstParts().stamp)));
        saved = written.updatedRows;
        savedRange = written.updatedRange;
      }
      return json({ items, saved, savedRange, elapsedMs: Date.now() - started, sheetUrl: sheetUrl(env) });
    }

    if (action === 'append') {
      const items = normalizeItems(payload.items);   // 화면에서 온 값도 다시 검사한다
      if (!items.length) throw new UserError('전송할 항목이 없습니다.');
      const { stamp } = kstParts();
      const written = await appendRows(env, items.map((item) => itemToRow(item, stamp)));
      return json({ count: written.updatedRows, savedRange: written.updatedRange, sheetUrl: sheetUrl(env) });
    }

    if (action === 'diag') {
      return json(await diagnostics(env));
    }

    if (action === 'rows') {
      return json({ rows: await readRows(env), sheetUrl: sheetUrl(env) });
    }

    if (action === 'format') {
      const configuredTab = env.SHEET_NAME || '업무로그';
      const result = await formatWorklogSheet(env, configuredTab);
      return json({
        ok: true,
        message: `"${configuredTab}" 시트에 1행 틀 고정, 우선순위·상태 조건부 서식, 열 너비 최적화, 줄무늬 행이 성공적으로 적용되었습니다.`,
        sheetUrl: sheetUrl(env),
        result,
      });
    }

    return json({ error: '알 수 없는 요청입니다.' }, 404);
  } catch (error) {
    if (error instanceof UserError) return json({ error: error.message }, error.status);
    console.error(error);
    return json({ error: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }, 500);
  }
}

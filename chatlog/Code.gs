/**
 * 봉뜨락 업무로그 — 단톡방 대화/현장 메모를 Gemini로 분류해 구글 시트에 적재한다.
 *
 * 구조
 *   doGet()            웹앱 화면(index.html) 서빙
 *   getConfig()        화면이 시작할 때 필요한 설정값
 *   classify()         입력 텍스트 → Gemini → 정규화된 항목 배열 (시트에 쓰지 않음)
 *   appendItems()      사용자가 승인한 항목만 시트에 행으로 추가
 *
 * 분류와 적재를 두 단계로 나눈 이유: 모델이 담당자·마감일을 잘못 짚는 경우가 있어
 * 사람이 카드에서 고친 뒤 보내야 시트가 신뢰할 만한 원장이 된다.
 *
 * 설정은 전부 스크립트 속성(파일 > 프로젝트 설정 > 스크립트 속성)에 둔다. README 참고.
 *   GEMINI_API_KEY          (필수) aistudio.google.com 에서 발급
 *   SHEET_ID                (권장) 적재할 스프레드시트 ID. 없으면 이 스크립트가 붙은 시트를 쓴다
 *   GEMINI_MODEL            (선택) 기본 gemini-3.7-flash
 *   GEMINI_THINKING_LEVEL   (선택) low/medium/high. 기본 low(속도 우선). Gemini 3.x 용
 *   GEMINI_THINKING_BUDGET  (선택) 숫자. 2.5 계열 모델을 쓸 때만. 지정하면 level 대신 이쪽을 보낸다
 *   ACCESS_CODE             (선택) 설정하면 화면에서 이 코드를 입력해야 동작한다
 */

const PROPS = PropertiesService.getScriptProperties();

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// 2026-09 기준. gemini-2.5-flash 는 폐기 예정(2026-10-16 종료)이라 기본값으로 쓰지 않는다.
// 3.7 Flash 는 짧은 입력·대량 처리에 권장되는 모델이라 이 용도(단톡방 몇 줄 분류)에 맞는다.
// 더 싸게: gemini-3.5-flash-lite / 더 똑똑하게: gemini-3.8-flash — GEMINI_MODEL 속성으로 교체.
const DEFAULT_MODEL = 'gemini-3.7-flash';
const THINKING_LEVELS = ['low', 'medium', 'high'];

const SHEET_NAME = '업무로그';
const HEADERS = ['타임스탬프', '분류', '핵심 요약', '담당자', '마감일', '우선순위', '상태', '원문 맥락'];
const TZ = 'Asia/Seoul';

const CATEGORIES = ['DECISION', 'TODO', 'INFO', 'IDEA'];
const CATEGORY_TAG = {
  DECISION: '[결정]',
  TODO: '[할일]',
  INFO: '[공유]',
  IDEA: '[아이디어]',
};
// 분류별 기본 상태. 공유는 이미 벌어진 일이라 '완료', 아이디어는 나중에 볼 것이라 '검토'.
const DEFAULT_STATUS = {
  DECISION: '대기',
  TODO: '대기',
  INFO: '완료',
  IDEA: '검토',
};
const OWNERS = ['성현', '지연', '주성', '공통', '미지정'];
const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
const STATUSES = ['대기', '진행', '완료', '검토', '보류'];
const NO_DUE = '미정';

// 입력·출력 상한. 단톡방 하루치를 통째로 붙여넣어도 1만 자를 넘기 어렵고,
// 상한이 없으면 사고로 수백 행이 시트에 꽂힐 수 있다.
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
  '- Filter out pure casual greetings or small talk. If nothing is actionable, return an empty array.',
  '- "summary" is one short Korean sentence in 개조식 (noun-ending) style.',
  '- "context" is a 1~2 line Korean summary of the original wording, including numbers and names when present.',
  '- Resolve relative dates ("내일", "다음 주 월요일") against TODAY given in the user message, and output YYYY-MM-DD.',
  '- If there is no deadline, output "미정" for due_date. Never invent a deadline.',
  '- Do not add markdown code fences. Return raw JSON only.',
].join('\n');

// Gemini 구조화 출력 스키마. JSON 모드(responseMimeType)와 함께 써야 파싱이 안정적이다.
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

// ── 웹앱 ────────────────────────────────────────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('봉뜨락 업무로그')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 화면 초기화에 필요한 값들. API 키는 절대 내려보내지 않는다. */
function getConfig() {
  return {
    sheetUrl: sheetUrl_(),
    needsAccessCode: !!PROPS.getProperty('ACCESS_CODE'),
    owners: OWNERS,
    priorities: PRIORITIES,
    statuses: STATUSES,
    categories: CATEGORIES,
    categoryTag: CATEGORY_TAG,
    today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    noDue: NO_DUE,
  };
}

/**
 * 텍스트를 분류만 한다. 시트에는 쓰지 않는다.
 * @return {{items: Object[], elapsedMs: number}}
 */
function classify(text, accessCode) {
  checkAccess_(accessCode);
  const input = String(text || '').trim();
  if (!input) throw new Error('입력된 내용이 없습니다.');
  if (input.length > MAX_INPUT_CHARS) {
    throw new Error(
      '입력이 너무 깁니다 (' + input.length + '자). ' + MAX_INPUT_CHARS + '자 이하로 나눠서 넣어주세요.'
    );
  }

  const started = Date.now();
  const raw = callGemini_(input);
  const items = normalizeItems(parseModelJson(raw));
  return { items: items, elapsedMs: Date.now() - started };
}

/**
 * 사용자가 승인한 항목을 시트에 행으로 추가한다.
 * 화면에서 온 값은 다시 정규화한다 — 클라이언트를 신뢰하지 않는다.
 * @return {{count: number, sheetUrl: string}}
 */
function appendItems(items, accessCode) {
  checkAccess_(accessCode);
  const normalized = normalizeItems(items);
  if (!normalized.length) throw new Error('전송할 항목이 없습니다.');

  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const rows = normalized.map(function (item) { return itemToRow(item, stamp); });

  // 세 명이 동시에 눌러도 행이 겹쳐 쓰이지 않도록 잠근다.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('다른 저장이 진행 중입니다. 잠시 후 다시 시도해주세요.');
  try {
    const sheet = ensureSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { count: rows.length, sheetUrl: sheetUrl_() };
}

/** 분류와 저장을 한 번에. 미리보기 없이 바로 넣고 싶을 때만 쓴다. */
function classifyAndAppend(text, accessCode) {
  const parsed = classify(text, accessCode);
  if (!parsed.items.length) return { count: 0, items: [], sheetUrl: sheetUrl_() };
  const saved = appendItems(parsed.items, accessCode);
  return { count: saved.count, items: parsed.items, sheetUrl: saved.sheetUrl };
}

// ── Gemini 호출 ─────────────────────────────────────────────────────

function callGemini_(input) {
  const apiKey = PROPS.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 스크립트 속성이 비어 있습니다. README의 「3. 설정값 입력」을 참고하세요.');
  }
  const model = PROPS.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;
  const url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) + ':generateContent';

  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const payload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: 'TODAY: ' + today + '\n\n---\n' + input }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };
  const thinking = thinkingConfig(
    PROPS.getProperty('GEMINI_THINKING_LEVEL'),
    PROPS.getProperty('GEMINI_THINKING_BUDGET')
  );
  if (thinking) payload.generationConfig.thinkingConfig = thinking;

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },   // URL 대신 헤더로 — 키가 로그에 남지 않게
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code === 200) return extractText_(body);

    // 모델마다 thinking 파라미터가 달라(3.x=thinkingLevel, 2.5=thinkingBudget) 400 이 날 수 있다.
    // 그때는 그 항목만 빼고 즉시 다시 시도한다 — 분류 자체는 사고과정 없이도 된다.
    if (code === 400 && /thinking/i.test(body) && payload.generationConfig.thinkingConfig) {
      delete payload.generationConfig.thinkingConfig;
      continue;
    }
    lastError = geminiErrorMessage_(code, body, model);
    if (code === 429 || code >= 500) {
      Utilities.sleep(800 * (attempt + 1));   // 일시적 오류만 재시도
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error(lastError || 'Gemini 호출에 실패했습니다.');
}

function geminiErrorMessage_(code, body, model) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = (parsed.error && parsed.error.message) || '';
  } catch (e) {
    detail = String(body).slice(0, 300);
  }
  if (code === 400 && /API key/i.test(detail)) return 'Gemini API 키가 잘못되었습니다. 스크립트 속성을 확인하세요.';
  if (code === 403) return 'Gemini API 접근이 거부되었습니다 (키 권한 또는 결제 설정 확인).';
  if (code === 404) return '모델 "' + model + '" 을(를) 찾을 수 없습니다. GEMINI_MODEL 속성을 확인하세요.';
  if (code === 429) return '요청이 몰렸습니다. 잠시 후 다시 시도해주세요.';
  if (code >= 500) return 'Gemini 서버 오류(' + code + '). 잠시 후 다시 시도해주세요.';
  return 'Gemini 오류(' + code + '): ' + detail;
}

/** 응답 본문에서 모델이 생성한 텍스트만 뽑아낸다. */
function extractText_(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('Gemini 응답을 해석하지 못했습니다.');
  }
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error('안전 필터에 걸려 분류하지 못했습니다 (' + data.promptFeedback.blockReason + ').');
  }
  const candidate = (data.candidates || [])[0];
  if (!candidate) throw new Error('Gemini가 결과를 반환하지 않았습니다.');
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error('내용이 너무 길어 결과가 잘렸습니다. 입력을 나눠서 다시 시도해주세요.');
    }
    throw new Error('Gemini가 응답을 완료하지 못했습니다 (' + candidate.finishReason + ').');
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini 응답이 비어 있습니다.');
  return text;
}

/**
 * 사고(thinking) 설정을 만든다.
 * Gemini 3.x 는 thinkingLevel(low/medium/high), 2.5 계열은 thinkingBudget(숫자)을 받고
 * 둘을 같이 보내면 400 이 난다. 그래서 하나만 넣는다 — 예산이 지정돼 있으면 그쪽이 우선.
 * 'off' 처럼 해석할 수 없는 값이면 아예 보내지 않는다(모델 기본값에 맡김).
 */
function thinkingConfig(level, budget) {
  const budgetText = String(budget == null ? '' : budget).trim();
  if (budgetText !== '') {
    const amount = Number(budgetText);
    return isNaN(amount) ? null : { thinkingBudget: amount };
  }
  const levelText = String(level == null ? '' : level).trim().toLowerCase() || 'low';
  if (THINKING_LEVELS.indexOf(levelText) === -1) return null;
  return { thinkingLevel: levelText };
}

// ── 정규화 (순수 함수 — test_code.js 에서 그대로 테스트한다) ─────────

/** JSON 모드여도 가끔 ```json 펜스가 붙어 오므로 벗겨내고 파싱한다. */
function parseModelJson(text) {
  let body = String(text || '').trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('모델이 JSON 형식으로 답하지 않았습니다. 다시 시도해주세요.');
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;   // 객체로 감싸 오는 경우
  if (data && typeof data === 'object') return [data];
  throw new Error('모델 응답에서 항목을 찾지 못했습니다.');
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(function (item) { return item && typeof item === 'object'; })
    .map(normalizeItem)
    .filter(function (item) { return !!item.summary; })
    .slice(0, MAX_ITEMS);
}

function normalizeItem(raw) {
  const category = pick_(raw.category, CATEGORIES, 'INFO');
  return {
    category: category,
    summary: clean_(raw.summary),
    owner: pick_(raw.owner, OWNERS, '미지정'),
    due_date: normalizeDue(raw.due_date),
    context: clean_(raw.context),
    priority: pick_(raw.priority, PRIORITIES, 'MEDIUM'),
    status: pick_(raw.status, STATUSES, DEFAULT_STATUS[category]),
  };
}

/** 'YYYY-MM-DD' 만 통과시킨다. 2026.9.5 / 2026/09/05 처럼 흔한 변형은 교정하고, 나머지는 '미정'. */
function normalizeDue(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return NO_DUE;
  const match = text.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!match) return NO_DUE;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return NO_DUE;
  return year + '-' + pad2_(month) + '-' + pad2_(day);
}

function itemToRow(item, timestamp) {
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

function pick_(value, allowed, fallback) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  for (let i = 0; i < allowed.length; i++) {
    if (String(allowed[i]).toUpperCase() === text) return allowed[i];
  }
  return fallback;
}

function clean_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_FIELD);
}

function pad2_(n) {
  return n < 10 ? '0' + n : String(n);
}

// ── 시트 ────────────────────────────────────────────────────────────

function spreadsheet_() {
  const id = PROPS.getProperty('SHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id.trim());
    } catch (e) {
      throw new Error('SHEET_ID 로 시트를 열지 못했습니다. ID와 공유 권한을 확인하세요.');
    }
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('SHEET_ID 스크립트 속성이 비어 있습니다. README의 「3. 설정값 입력」을 참고하세요.');
  return active;
}

function sheetUrl_() {
  try {
    const ss = spreadsheet_();
    const sheet = ss.getSheetByName(SHEET_NAME);
    return ss.getUrl() + (sheet ? '#gid=' + sheet.getSheetId() : '');
  } catch (e) {
    return '';
  }
}

/** 시트가 없으면 헤더까지 갖춰서 만든다. 첫 실행에서 손으로 준비할 게 없도록. */
function ensureSheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 타임스탬프·마감일은 텍스트로 고정한다. 날짜로 자동 변환되면 '미정'과 서식이 섞인다.
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange('E:E').setNumberFormat('@');
    const widths = [130, 90, 320, 80, 100, 90, 80, 360];
    widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
    sheet.getRange('C:C').setWrap(true);
    sheet.getRange('H:H').setWrap(true);
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build();
    sheet.getRange(2, 7, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  }
  return sheet;
}

// ── 접근 코드 ───────────────────────────────────────────────────────

/** ACCESS_CODE 속성이 설정된 경우에만 검사한다. 링크가 외부로 새도 아무나 쓰지 못하게. */
function checkAccess_(accessCode) {
  const expected = PROPS.getProperty('ACCESS_CODE');
  if (!expected) return;
  if (String(accessCode || '').trim() !== expected.trim()) {
    throw new Error('접근 코드가 올바르지 않습니다.');
  }
}

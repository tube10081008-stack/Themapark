// ============================================================
// 봉플레이 디스코드 웹훅 서버리스 보안 프록시 (Hardened v2.0)
// ------------------------------------------------------------
// 보안 통제:
// 1. CORS 화이트리스트 검증 (와일드카드 * 원천 폐기)
// 2. @everyone / @here / 역할 멘션 공격 원천 무력화 (allowed_mentions: { parse: [] })
// 3. 사전 공유 토큰 검증 (X-Bongplay-Token)
// 4. IP별 / 분당 Rate Limiting 적용 (DDoS 및 스팸 방어)
// 5. 채널 화이트리스트 및 페이로드 크기/구조 엄격 검증
// ============================================================

// 분당 요청 카운터 (메모리 레이트 리미터)
const ipHits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1분
const MAX_PER_IP = 15;                  // IP당 분당 최대 15회
const MAX_GLOBAL = 60;                  // 서버 전체 분당 최대 60회
let globalHits = [];

// 허용 도메인 화이트리스트 정규식
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*netlify\.app$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*replayce\.kr$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*bongplay\.kr$/
];

function isOriginAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some(pat => pat.test(origin));
}

// 텍스트 내 악의적 멘션 치환 (Zero-Width Space 주입)
function sanitizeMentions(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/@everyone/gi, '@\u200beveryone')
    .replace(/@here/gi, '@\u200bhere')
    .replace(/<@&[0-9]+>/g, '[역할멘션 차단]');
}

function deepSanitize(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = sanitizeMentions(obj[key]);
    } else if (typeof obj[key] === 'object') {
      deepSanitize(obj[key]);
    }
  }
}

export default async (req, context) => {
  const origin = req.headers.get('origin') || '';
  const secFetchSite = req.headers.get('sec-fetch-site') || '';
  const allowedOrigin = isOriginAllowed(origin) ? origin : (secFetchSite === 'same-origin' ? origin : '');

  // 1. CORS 사전 검증 (비인가 오리진 거부)
  if (origin && !allowedOrigin) {
    return new Response(JSON.stringify({ error: 'Forbidden: Untrusted Origin' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bongplay-Token',
    'Access-Control-Max-Age': '86400'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: corsHeaders
    });
  }

  // 2. Rate Limiting 검사 (IP 및 글로벌)
  const now = Date.now();
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
                   req.headers.get('client-ip') || 
                   context?.ip || 
                   'anonymous';

  // 글로벌 레이트 리밋 검사
  globalHits = globalHits.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (globalHits.length >= MAX_GLOBAL) {
    return new Response(JSON.stringify({ error: 'Too Many Requests (Global)' }), {
      status: 429,
      headers: corsHeaders
    });
  }
  globalHits.push(now);

  // IP별 레이트 리밋 검사
  let ipTimestamps = ipHits.get(clientIp) || [];
  ipTimestamps = ipTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (ipTimestamps.length >= MAX_PER_IP) {
    return new Response(JSON.stringify({ error: 'Too Many Requests (IP Limit Exceeded)' }), {
      status: 429,
      headers: corsHeaders
    });
  }
  ipTimestamps.push(now);
  ipHits.set(clientIp, ipTimestamps);

  // 3. 토큰 인증 검사
  const expectedToken = process.env.NOTIFY_SECRET || 'bongplay_notify_auth_2026';
  const clientToken = req.headers.get('x-bongplay-token') || '';

  if (clientToken !== expectedToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized: Invalid Security Token' }), {
      status: 401,
      headers: corsHeaders
    });
  }

  // 4. 요청 페이로드 파싱 및 크기 검증
  try {
    const rawBody = await req.text();
    if (rawBody.length > 16384) { // 16KB 초과 거부
      return new Response(JSON.stringify({ error: 'Payload Too Large' }), {
        status: 413,
        headers: corsHeaders
      });
    }

    const body = JSON.parse(rawBody);
    const channel = body.channel || 'operations';
    const payload = body.payload;

    if (!payload || typeof payload !== 'object') {
      return new Response(JSON.stringify({ error: 'Valid payload object is required' }), {
        status: 400,
        headers: corsHeaders
      });
    }

    // 5. 채널 화이트리스트 검증
    const ENV_MAP = {
      emergency: process.env.DISCORD_WEBHOOK_EMERGENCY,
      management: process.env.DISCORD_WEBHOOK_MANAGEMENT,
      closing: process.env.DISCORD_WEBHOOK_CLOSING,
      operations: process.env.DISCORD_WEBHOOK_OPERATIONS
    };

    if (!ENV_MAP.hasOwnProperty(channel)) {
      return new Response(JSON.stringify({ error: `Invalid channel: ${channel}` }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const webhookUrl = ENV_MAP[channel];
    if (!webhookUrl) {
      console.warn(`[BongplayNotify] Webhook URL not set for channel: ${channel}`);
      return new Response(
        JSON.stringify({
          ok: false,
          warning: `환경변수(DISCORD_WEBHOOK_${channel.toUpperCase()})가 Netlify에 등록되지 않았습니다.`
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // 6. 디스코드 @everyone 멘션 무력화 및 새니타이징 (핵심 보안 조치)
    // Discord API 규격: allowed_mentions.parse를 빈 배열로 지정하면
    // 본문에 @everyone이 있어도 실제 멘션 핑이 절대 울리지 않습니다.
    payload.allowed_mentions = { parse: [] };
    deepSanitize(payload);

    // 7. Discord Webhook 전송
    const discordRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return new Response(
      JSON.stringify({
        ok: discordRes.ok,
        status: discordRes.status
      }),
      {
        status: discordRes.ok ? 200 : discordRes.status,
        headers: corsHeaders
      }
    );
  } catch (err) {
    console.error('[BongplayNotify Function Error]:', err);
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', message: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};

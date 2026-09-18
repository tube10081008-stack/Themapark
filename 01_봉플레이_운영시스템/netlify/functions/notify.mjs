// ============================================================
// 봉플레이 디스코드 웹훅 서버리스 보안 프록시
// ------------------------------------------------------------
// 웹훅 URL이 클라이언트 JS에 절대 노출되지 않도록
// Netlify Functions 서버사이드 환경변수를 통해 발송합니다.
//
// 필요 환경변수 (Netlify > Site configuration > Environment variables):
// - DISCORD_WEBHOOK_EMERGENCY
// - DISCORD_WEBHOOK_MANAGEMENT
// - DISCORD_WEBHOOK_CLOSING
// - DISCORD_WEBHOOK_OPERATIONS
// ============================================================

export default async (req, context) => {
  // CORS 프리플라이트 및 헤더
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers
    });
  }

  try {
    const body = await req.json();
    const channel = body.channel || 'operations';
    const payload = body.payload;

    if (!payload) {
      return new Response(JSON.stringify({ error: 'Payload is required' }), {
        status: 400,
        headers
      });
    }

    // 채널별 환경변수 매핑
    const ENV_MAP = {
      emergency: process.env.DISCORD_WEBHOOK_EMERGENCY,
      management: process.env.DISCORD_WEBHOOK_MANAGEMENT,
      closing: process.env.DISCORD_WEBHOOK_CLOSING,
      operations: process.env.DISCORD_WEBHOOK_OPERATIONS
    };

    const webhookUrl = ENV_MAP[channel];

    if (!webhookUrl) {
      console.warn(`[BongplayNotify Function] Webhook URL not set for channel: ${channel}`);
      return new Response(
        JSON.stringify({
          ok: false,
          warning: `환경변수(DISCORD_WEBHOOK_${channel.toUpperCase()})가 Netlify에 등록되지 않았습니다.`
        }),
        { status: 200, headers }
      );
    }

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
        headers
      }
    );
  } catch (err) {
    console.error('[BongplayNotify Function Error]:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal Server Error' }),
      { status: 500, headers }
    );
  }
};

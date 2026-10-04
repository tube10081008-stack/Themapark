import { consult } from './lib/consultation.mjs';
import { checkRateLimit } from './lib/rate-limit.mjs';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  }
});

export default async function handler(request, context = {}) {
  if (request.method !== 'POST') return json({ error: 'POST 요청만 지원합니다.' }, 405);
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return json({ error: 'JSON 형식이 필요합니다.' }, 415);
  }

  // Origin is browser CSRF protection, not authentication or a cost-control boundary.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: '허용되지 않은 출처입니다.' }, 403);
  }

  if (Number(request.headers.get('content-length')) > 8192) {
    return json({ error: '질문이 너무 깁니다.' }, 413);
  }

  // 환경설정 및 분산 레이트 리미트 / 과금 방어 검사
  const env = context.env || process.env || {};
  const rateLimitOptions = {
    env,
    store: context.store,
    isShared: context.isShared,
    fetcher: context.fetcher || fetch
  };

  const rl = await checkRateLimit(request, rateLimitOptions);
  if (!rl.allowed) {
    return json({
      error: rl.error || '문의 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
      code: rl.code || 'RATE_LIMIT_EXCEEDED',
      retry_after: rl.retryAfter || 60
    }, 429, { 'Retry-After': String(rl.retryAfter || 60) });
  }

  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: '질문을 입력해 주세요.' }, 400);

    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return json({ error: '질문이 너무 깁니다.' }, 413);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }

    const input = JSON.parse(new TextDecoder().decode(bytes));

    // [Fail-Closed 과금 방어]: 분산 저장소 미설정/장애 시 외부 유료 JEV 호출 원천 차단
    let safeEnv = env;
    if (env.JEV_ENABLED === 'true' && !rl.allowExternal) {
      safeEnv = {
        ...env,
        JEV_ENABLED: 'false',
        JEV_BLOCKED_REASON: rl.reason || 'cost_defense_store_missing'
      };
    }

    const result = await consult(input.message, {
      env: safeEnv,
      fetcher: context.fetcher || fetch
    });

    return json(result);
  } catch {
    return json({ error: '질문은 1~1,200자로 입력해 주세요.' }, 400);
  }
}

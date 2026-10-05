import { consult } from './lib/consultation.mjs';
import { decideConversation } from './lib/conversation-engine.mjs';
import { checkRateLimit, sanitizeHistory } from './lib/rate-limit.mjs';

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

  // 한글 UTF-8 멀티턴 대화 이력 상한을 고려한 바이트 한도 32,768 (BEN-019 인수 계약 v1)
  if (Number(request.headers.get('content-length')) > 32768) {
    return json({ error: '질문이 너무 깁니다.' }, 413);
  }

  // 환경설정 및 분산 레이트 리미트 / 과금 방어 검사
  const env = context.env || process.env || {};
  const rateLimitOptions = {
    env,
    context,
    store: context.store,
    isShared: context.isShared,
    testIp: context.testIp,
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
      if (size > 32768) {
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

    // [Fail-Closed 과금 방어]: 분산 저장소 미설정/장애 시 외부 유료 호출(JEV 및 공급자 공통) 원천 차단
    let safeEnv = env;
    if (env.JEV_ENABLED === 'true' && !rl.allowExternal) {
      safeEnv = {
        ...safeEnv,
        JEV_ENABLED: 'false',
        JEV_BLOCKED_REASON: rl.reason || 'cost_defense_store_missing'
      };
    }
    if (env.CONSULT_ENABLED === 'true' && !rl.allowExternal) {
      safeEnv = {
        ...safeEnv,
        CONSULT_ENABLED: 'false',
        CONSULT_BLOCKED_REASON: rl.reason || 'cost_defense_store_missing'
      };
    }

    // [서버 주입 externalAllowed]: 공유 제한 저장소 검증(rl.allowExternal) 결과만 내부에서 주입하며,
    // 클라이언트 요청 JSON(input.externalAllowed)은 절대 수용하지 않음 (BEN-016)
    const serverExternalAllowed = Boolean(rl.allowExternal);

    // [역할 검증 및 시스템 역할 거부 (CS-035)]: history 내 user/assistant 외 역할(system, developer 등) 엄격 차단
    if (input.history !== undefined) {
      if (!Array.isArray(input.history)) {
        return json({ error: '대화 이력 형식이 올바르지 않습니다.' }, 400);
      }
      for (const turn of input.history) {
        if (!turn || typeof turn !== 'object' || (turn.role !== 'user' && turn.role !== 'assistant')) {
          return json({ error: '허용되지 않은 대화 역할(role)입니다.' }, 400);
        }
      }
    }

    // [대화 이력 정제]: 클라이언트 전달 history의 역할·길이·개인정보 검증 (BEN-019)
    const safeHistory = sanitizeHistory(input.history);

    const isConversation = input.history !== undefined || env.CONSULT_ENGINE === 'conversation';
    const result = isConversation
      ? await decideConversation(input.message, {
          env: safeEnv,
          fetcher: context.fetcher || fetch,
          externalAllowed: serverExternalAllowed,
          history: safeHistory
        })
      : await consult(input.message, {
          env: safeEnv,
          fetcher: context.fetcher || fetch,
          externalAllowed: serverExternalAllowed,
          history: safeHistory
        });

    return json(result);
  } catch (err) {
    if (err.message === 'INVALID_MESSAGE') {
      return json({ error: '질문은 1~1,200자로 입력해 주세요.' }, 400);
    }
    return json({ error: '질문은 1~1,200자로 입력해 주세요.' }, 400);
  }
}

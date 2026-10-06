/**
 * rate-limit.mjs
 *
 * JEV 상담 호출 제한 및 분산 과금 방어 모듈 (ANT-004 / R2 보완)
 * - 다중 서버리스 인스턴스 환경에서 상태 불일치를 방지하기 위한 Upstash Redis REST 파이프라인(INCR + EXPIRE) 연동
 * - Fail-Closed 원칙: JEV_ENABLED === 'true'일 때 분산 저장소 미설정, 응답 이상, 통신 장애 시 외부 유료 JEV 호출 원천 차단 (외부 유료 API 호출 0건 유지)
 * - 외부 라이브러리(npm) 의존성 제로 (Web Standards fetch & MemoryRateLimitStore)
 * - Redis REST 파이프라인은 일괄 배치 실행(batched commands)이며 ACID 트랜잭션이 아니므로 각 명령 결과 및 오류를 개별 엄격 검증함
 * - IP 신뢰 경계: Netlify platform context.ip 및 x-nf-client-connection-ip만 신뢰하며, 위변조 가능한 임의 클라이언트 헤더는 untrusted_client 공통 키로 차단
 */

/**
 * 환경변수 제한값 안전 파싱
 * - <= 0: 0 반환 (모든 요청 차단)
 * - NaN, Infinity, 미설정: 기본값 반환
 * - 유효 양의 정수: 해당 정수 반환
 */
export function parsePositiveLimit(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const num = Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num)) return defaultVal;
  if (num <= 0) return 0;
  return Math.floor(num);
}

/**
 * Redis EXPIRE 명령 성공 여부 엄격 검사
 * - Redis 표준: 키 타임아웃 설정 성공 시 1 반환 (키 미존재 또는 실패 시 0)
 * - 일부 REST 프록시: 성공 시 'OK' 반환 가능
 * - 0, 음수(-1), 2 이상의 수, 기타 문자열, null, undefined는 엄격히 실패로 판정
 */
export function isValidExpireResult(val) {
  return val === 1 || val === 'OK';
}

export class MemoryRateLimitStore {
  constructor() {
    this.ipHits = new Map(); // ip -> [timestamps]
    this.dailyHits = new Map(); // 'YYYY-MM-DD' -> count
  }

  async hit(ip, now = Date.now(), windowMs = 60000) {
    // 1. IP 분당 슬라이딩 윈도우
    const timestamps = (this.ipHits.get(ip) || []).filter(t => now - t < windowMs);
    timestamps.push(now);
    this.ipHits.set(ip, timestamps);

    // 2. 일별 전역 카운터
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const dayCount = (this.dailyHits.get(dayKey) || 0) + 1;
    this.dailyHits.set(dayKey, dayCount);

    return {
      ipCount: timestamps.length,
      dailyCount: dayCount
    };
  }

  clear() {
    this.ipHits.clear();
    this.dailyHits.clear();
  }
}

export class DistributedRedisRateLimitStore {
  constructor(url, token, fetcher = fetch) {
    this.url = url?.replace(/\/$/, '');
    this.token = token;
    this.fetcher = fetcher;
  }

  /**
   * Redis REST Pipeline 실행 및 엄격 검증
   * - 파이프라인 구성:
   *   [0] INCR minuteKey -> 분당 요청 수
   *   [1] EXPIRE minuteKey 65 -> 분당 키 TTL
   *   [2] INCR dayKey -> 일일 요청 수
   *   [3] EXPIRE dayKey 90000 -> 일일 키 TTL
   */
  async hit(ip, now = Date.now(), windowMs = 60000) {
    if (!this.url || !this.token) {
      throw new Error('DISTRIBUTED_STORE_NOT_CONFIGURED');
    }

    const minuteKey = `rl:ip:${ip}:${Math.floor(now / windowMs)}`;
    const dayKey = `rl:daily:${new Date(now).toISOString().slice(0, 10)}`;

    const pipeline = [
      ['INCR', minuteKey],
      ['EXPIRE', minuteKey, 65],
      ['INCR', dayKey],
      ['EXPIRE', dayKey, 90000]
    ];

    const res = await this.fetcher(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(3000)
    });

    if (!res.ok) {
      throw new Error(`STORE_HTTP_ERROR_${res.status}`);
    }

    let results;
    try {
      results = await res.json();
    } catch (parseErr) {
      throw new Error(`STORE_RESPONSE_PARSE_ERROR: ${parseErr.message}`);
    }

    // [R1/R2 엄격 검사]: 응답 구조 및 모든 개별 명령 오류 전수 검사
    if (!Array.isArray(results) || results.length < 4) {
      throw new Error(`STORE_INCOMPLETE_PIPELINE_RESULTS: length=${results ? results.length : 'non-array'}`);
    }

    for (let i = 0; i < 4; i++) {
      const item = results[i];
      if (!item || typeof item !== 'object') {
        throw new Error(`STORE_MALFORMED_PIPELINE_ITEM_${i}`);
      }
      if ('error' in item) {
        throw new Error(`STORE_COMMAND_ERROR_${i}: ${item.error}`);
      }
    }

    // Step 0: IP 카운터 (반드시 양의 안전 정수)
    const ipCount = results[0].result;
    if (typeof ipCount !== 'number' || !Number.isSafeInteger(ipCount) || ipCount <= 0) {
      throw new Error(`STORE_INVALID_IP_COUNT: ${JSON.stringify(ipCount)}`);
    }

    // Step 1: IP EXPIRE (엄격 검증: 1 또는 'OK'만 허용, 0/-1/2/null/문자열 등은 실패)
    const ipExpire = results[1].result;
    if (!isValidExpireResult(ipExpire)) {
      throw new Error(`STORE_INVALID_IP_EXPIRE: ${JSON.stringify(ipExpire)}`);
    }

    // Step 2: 일일 카운터 (반드시 양의 안전 정수)
    const dailyCount = results[2].result;
    if (typeof dailyCount !== 'number' || !Number.isSafeInteger(dailyCount) || dailyCount <= 0) {
      throw new Error(`STORE_INVALID_DAILY_COUNT: ${JSON.stringify(dailyCount)}`);
    }

    // Step 3: 일일 EXPIRE (엄격 검증: 1 또는 'OK'만 허용, 0/-1/2/null/문자열 등은 실패)
    const dailyExpire = results[3].result;
    if (!isValidExpireResult(dailyExpire)) {
      throw new Error(`STORE_INVALID_DAILY_EXPIRE: ${JSON.stringify(dailyExpire)}`);
    }

    return { ipCount, dailyCount };
  }
}

// 싱글톤 기본 메모리 저장소 (개발/단일 프로세스 로컬용)
export const defaultMemoryStore = new MemoryRateLimitStore();

/**
 * 신뢰할 수 있는 클라이언트 식별자 추출 (플랫폼 보증 경계 준수)
 *
 * [보안 설계 및 플랫폼 계약 근거]:
 * - Netlify Functions 런타임은 edge routing 계층에서 검증된 클라이언트 IP를 `context.ip`로 주입함.
 * - HTTP 헤더 중에서는 Netlify proxy가 주입하는 `x-nf-client-connection-ip`만 플랫폼이 보증함.
 * - 외부 클라이언트가 임의로 전송할 수 있는 `client-ip`, `x-forwarded-for` 등은 스푸핑(위변조)이 가능하므로
 *   플랫폼 보증(context.ip 또는 x-nf-client-connection-ip)이 없는 경우 개별 IP로 신뢰하지 않고
 *   공통 제한 키('untrusted_client')로 분류하여 IP 회전 공격(IP rotation bypass)을 원천 차단함.
 * - 로컬/단위 테스트용 IP 주입은 `options.testIp`로 엄격히 분리하여 운영 경로와 격리함.
 */
export function extractClientIp(request, context = {}, options = {}) {
  // 1. 단위/로컬 테스트 전용 명시 주입 IP (운영 경로와 격리)
  if (options && typeof options.testIp === 'string' && options.testIp.trim()) {
    return options.testIp.trim();
  }

  // 2. Netlify 런타임 플랫폼 보증 IP (context.ip - 위변조 불가)
  if (context && typeof context.ip === 'string' && context.ip.trim()) {
    return context.ip.trim();
  }
  if (context && context.clientContext && typeof context.clientContext.ip === 'string' && context.clientContext.ip.trim()) {
    return context.clientContext.ip.trim();
  }

  // 3. Netlify 엣지 프록시 보증 헤더
  const nfIp = request?.headers?.get('x-nf-client-connection-ip');
  if (nfIp && nfIp.trim()) {
    return nfIp.trim();
  }

  // 4. 플랫폼 보증 없는 임의 헤더(client-ip, x-forwarded-for 등)는 신뢰하지 않고 공통 키로 귀속
  return 'untrusted_client';
}

/**
 * 레이트 리미트 및 Fail-Closed 과금 방어 검사
 * @param {Request} request
 * @param {Object} options
 * @returns {Promise<{
 *   allowed: boolean,
 *   allowExternal: boolean,
 *   status: number,
 *   retryAfter: number,
 *   clientIp: string,
 *   code?: string,
 *   reason?: string,
 *   error?: string
 * }>}
 */
export async function checkRateLimit(request, options = {}) {
  const env = options.env || process.env || {};
  const now = options.now || Date.now();
  const clientIp = extractClientIp(request, options.context, options);

  // 환경설정 한도 (0이면 전면 차단, 유효하지 않으면 기본값)
  const limitPerMinute = parsePositiveLimit(env.RATE_LIMIT_PER_MINUTE, 10);
  const limitDailyTotal = parsePositiveLimit(env.RATE_LIMIT_DAILY_TOTAL, 500);

  const isJevEnabled = env.JEV_ENABLED === 'true';
  const isConsultEnabled = env.CONSULT_ENABLED === 'true';
  const isExternalModelEnabled = isJevEnabled || isConsultEnabled;

  // 저장소 선택
  let store = options.store;
  if (!store) {
    if (env.RATE_LIMIT_STORE_URL && env.RATE_LIMIT_STORE_TOKEN) {
      store = new DistributedRedisRateLimitStore(
        env.RATE_LIMIT_STORE_URL,
        env.RATE_LIMIT_STORE_TOKEN,
        options.fetcher || fetch
      );
    } else {
      store = defaultMemoryStore;
    }
  }

  // [Fail-Closed 과금 방어 1 - 메모리 우회 플래그 완전 제거 및 공급자 공통 확장 (BEN-016)]:
  // JEV_ENABLED === 'true' 또는 CONSULT_ENABLED === 'true'일 때 분산 저장소(Redis)가 미설정된 상태면
  // 메모리 카운터만으로는 다중 인스턴스 과금 차단이 불가능하므로
  // 외부 유료 API 호출을 원천 차단하고(allowExternal = false) 기본 규칙 모드로 안전 폴백.
  // (테스트 주입은 options.isShared === true로 명시 전달된 경우에만 인정)
  let allowExternal = isExternalModelEnabled;
  if (isExternalModelEnabled) {
    const isSharedConfigured = Boolean(
      (options.store && options.isShared === true) ||
      (env.RATE_LIMIT_STORE_URL && env.RATE_LIMIT_STORE_TOKEN)
    );

    if (!isSharedConfigured) {
      allowExternal = false; // 분산 저장소 미설정 시 유료 JEV / 모델 공급자 호출 차단
    }
  }

  // 한도 카운팅 수행
  try {
    const { ipCount, dailyCount } = await store.hit(clientIp, now, 60000);

    // 0 이하 상한 설정 시 (전면 차단)
    if (limitPerMinute <= 0 || limitDailyTotal <= 0) {
      return {
        allowed: false,
        allowExternal: false,
        status: 429,
        retryAfter: 60,
        clientIp,
        code: 'RATE_LIMIT_BLOCKED',
        reason: 'limit_configured_to_zero',
        error: '상담 요청이 제한되어 있습니다. 전화(010-5931-4144)로 문의해 주세요.'
      };
    }

    // 1. IP별 분당 상한 초과
    if (ipCount > limitPerMinute) {
      return {
        allowed: false,
        allowExternal: false,
        status: 429,
        retryAfter: 60,
        clientIp,
        code: 'RATE_LIMIT_EXCEEDED',
        reason: 'ip_minute_limit_exceeded',
        error: '문의 요청이 너무 많습니다. 1분 후 다시 시도해 주세요.'
      };
    }

    // 2. 전체 일일 상한 초과
    if (dailyCount > limitDailyTotal) {
      return {
        allowed: false,
        allowExternal: false,
        status: 429,
        retryAfter: 3600,
        clientIp,
        code: 'DAILY_QUOTA_EXCEEDED',
        reason: 'daily_quota_exceeded',
        error: '일일 상담 안내 한도가 마감되었습니다. 전화(010-5931-4144)로 문의해 주세요.'
      };
    }

    return {
      allowed: true,
      allowExternal,
      status: 200,
      retryAfter: 0,
      clientIp
    };
  } catch (err) {
    // [Fail-Closed 과금 방어 2]: 저장소 통신 장애 또는 응답 이상 발생 시
    // 유료 호출을 즉시 차단하고 429 반환
    return {
      allowed: !isExternalModelEnabled, // 외부 모델(JEV/공급자) 미사용 시에는 로컬 규칙 답변 허용, 유료 모델 사용 시 과금 방어를 위해 안전 차단
      allowExternal: false,
      status: isExternalModelEnabled ? 429 : 200,
      retryAfter: 60,
      clientIp,
      code: 'STORE_FAILURE',
      reason: 'store_failure',
      error: isExternalModelEnabled
        ? '상담 서버 과금 방어 저장소 연결 실패로 일시 차단되었습니다. 전화로 문의해 주세요.'
        : undefined
    };
  }
}

/**
 * 대화 이력 검증 및 정제 (BEN-019 / ANT-005)
 * - 클라이언트가 전송한 과거 발화(history)는 신뢰할 수 없는 문맥 데이터임
 * - 허용 역할: 'user', 'assistant' 만 허용 (system, developer 등 권한 승격 시도 엄격 제외)
 * - 길이 제한: 건당 최대 800자, 전체 합계 최대 3,200자, 최대 최근 6개 발화
 * - 개인정보 탐지: 전화번호, 이메일, 주민등록번호 패턴 포함 발화는 문맥 전달에서 제외
 */
export function sanitizeHistory(history) {
  if (!history || !Array.isArray(history)) return [];
  const allowed = [];
  // 최근 발화 최대 6개 추출
  const recentTurns = history.slice(-6);
  for (const turn of recentTurns) {
    if (!turn || typeof turn !== 'object') continue;
    // 역할 검증: user 및 assistant 만 허용 (system/developer 등 거부)
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    const raw = typeof turn.content === 'string' ? turn.content : (typeof turn.text === 'string' ? turn.text : null);
    if (raw === null) continue;
    const cleaned = raw.normalize('NFKC').trim().slice(0, 800);
    if (!cleaned) continue;
    // 개인정보 패턴 검사: 이메일, 전화번호(+82/010), 주민등록번호
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?:\+82|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}|\d{6}[-\s]?[1-4]\d{6}/.test(cleaned)) {
      continue; // 민감 발화 제외
    }
    allowed.push({ role: turn.role, content: cleaned, text: cleaned });
  }

  // R2 수정: 총 길이 3,200자 초과 시 오래된 앞 발화부터 제거하여 사용자의 최신 문맥 보존
  let totalLength = allowed.reduce((sum, t) => sum + t.content.length, 0);
  while (allowed.length > 0 && totalLength > 3200) {
    const removed = allowed.shift();
    totalLength -= removed.content.length;
  }

  return allowed;
}

/**
 * rate-limit.mjs
 * 
 * JEV 상담 호출 제한 및 분산 과금 방어 모듈 (ANT-004)
 * - 단순 프로세스 메모리 카운터를 넘어 다중 서버리스 인스턴스에서 공유 가능한 원자적 요청/일별 상한 지원
 * - Fail-Closed 원칙: JEV_ENABLED === 'true' 상태에서 제한 저장소 미설정 또는 통신 장애 시 외부 유료 호출 차단
 * - 외부 라이브러리(npm) 의존성 제로 (순수 Web Standards fetch & memory store)
 */

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

  async hit(ip, now = Date.now(), windowMs = 60000) {
    if (!this.url || !this.token) {
      throw new Error('DISTRIBUTED_STORE_NOT_CONFIGURED');
    }

    const minuteKey = `rl:ip:${ip}:${Math.floor(now / windowMs)}`;
    const dayKey = `rl:daily:${new Date(now).toISOString().slice(0, 10)}`;

    // Upstash Redis REST Pipeline API (원자적 다중 INCR + EXPIRE)
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

    const results = await res.json();
    // Upstash returns [{ result: 1 }, { result: 1 }, { result: 1 }, ...]
    const ipCount = Number(results[0]?.result || 1);
    const dailyCount = Number(results[2]?.result || 1);

    return { ipCount, dailyCount };
  }
}

// 싱글톤 메모리 저장소 (로컬 개발/단일 인스턴스 모의용)
export const defaultMemoryStore = new MemoryRateLimitStore();

export function extractClientIp(request) {
  if (!request || !request.headers) return '127.0.0.1';
  const nf = request.headers.get('x-nf-client-connection-ip');
  if (nf) return nf.trim();
  const cip = request.headers.get('client-ip');
  if (cip) return cip.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return '127.0.0.1';
}

/**
 * 레이트 리미트 및 과금 방어 검사
 * @param {Request} request 
 * @param {Object} options
 * @returns {Promise<{
 *   allowed: boolean,
 *   allowExternal: boolean,
 *   status: number,
 *   retryAfter: number,
 *   clientIp: string,
 *   reason?: string,
 *   error?: string
 * }>}
 */
export async function checkRateLimit(request, options = {}) {
  const env = options.env || process.env || {};
  const now = options.now || Date.now();
  const clientIp = extractClientIp(request);

  // 환경설정 한도 (사업상 지출 예산을 임의 확정하지 않고 환경변수로 분리)
  const limitPerMinute = Number(env.RATE_LIMIT_PER_MINUTE) || 10;
  const limitDailyTotal = Number(env.RATE_LIMIT_DAILY_TOTAL) || 500;

  // 저장소 선택
  let store = options.store;
  const isJevEnabled = env.JEV_ENABLED === 'true';

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

  // [Fail-Closed 과금 방어 1]: JEV 유료 호출이 활성화되었으나 분산 저장소가 설정되지 않은 경우
  // 외부 분산 저장소 없이 메모리만으로는 다중 인스턴스 과금 방어가 불가능하므로 유료 호출을 Fail-Closed 차단
  let allowExternal = isJevEnabled;
  if (isJevEnabled) {
    const isSharedConfigured = Boolean(
      (options.store && options.isShared) ||
      (env.RATE_LIMIT_STORE_URL && env.RATE_LIMIT_STORE_TOKEN)
    );

    if (!isSharedConfigured && env.ALLOW_MEMORY_STORE_FOR_JEV !== 'true') {
      allowExternal = false; // 외부 JEV 호출 차단 (기본 안내 모드로 안전 폴백)
    }
  }

  // 한도 카운팅 수행
  try {
    const { ipCount, dailyCount } = await store.hit(clientIp, now, 60000);

    // 1. IP별 분당 상한 초과
    if (ipCount > limitPerMinute) {
      return {
        allowed: false,
        allowExternal: false,
        status: 429,
        retryAfter: 60,
        clientIp,
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
    // [Fail-Closed 과금 방어 2]: 저장소 장애 시
    // 저장소 에러가 발생한 경우, 외부 유료 호출은 즉시 차단
    return {
      allowed: !isJevEnabled, // JEV 미사용 모드일 때는 기본 안내 허용, JEV 사용 모드일 때는 429/503 처리 가능
      allowExternal: false,
      status: isJevEnabled ? 429 : 200,
      retryAfter: 60,
      clientIp,
      reason: 'store_failure',
      error: isJevEnabled
        ? '상담 서버 과금 방어 저장소 연결 실패로 일시 차단되었습니다. 전화로 문의해 주세요.'
        : undefined
    };
  }
}

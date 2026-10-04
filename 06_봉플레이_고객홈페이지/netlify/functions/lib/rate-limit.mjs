/**
 * rate-limit.mjs
 * 
 * JEV 상담 호출 제한 및 분산 과금 방어 모듈 (ANT-004 / R1 보완)
 * - 다중 서버리스 인스턴스 환경에서 상태 불일치를 방지하기 위한 Upstash Redis REST 파이프라인(INCR + EXPIRE) 연동
 * - Fail-Closed 원칙: JEV_ENABLED === 'true'일 때 분산 저장소 미설정, 응답 이상, 통신 장애 시 외부 유료 JEV 호출 원천 차단 (외부 유료 API 호출 0건 유지)
 * - 외부 라이브러리(npm) 의존성 제로 (Web Standards fetch & MemoryRateLimitStore)
 * - 주의: Redis REST 파이프라인은 일괄 배치 실행(batched commands)이며 ACID 트랜잭션이 아니므로 각 명령 결과 및 오류를 개별 엄격 검증함
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

    // [R1 P1 엄격 검사]: 응답 구조 및 모든 개별 명령 오류 전수 검사
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

    // Step 1: IP EXPIRE (1 또는 'OK')
    const ipExpire = results[1].result;
    if (ipExpire !== 1 && ipExpire !== 'OK' && typeof ipExpire !== 'number') {
      throw new Error(`STORE_INVALID_IP_EXPIRE: ${JSON.stringify(ipExpire)}`);
    }

    // Step 2: 일일 카운터 (반드시 양의 안전 정수)
    const dailyCount = results[2].result;
    if (typeof dailyCount !== 'number' || !Number.isSafeInteger(dailyCount) || dailyCount <= 0) {
      throw new Error(`STORE_INVALID_DAILY_COUNT: ${JSON.stringify(dailyCount)}`);
    }

    // Step 3: 일일 EXPIRE (1 또는 'OK')
    const dailyExpire = results[3].result;
    if (dailyExpire !== 1 && dailyExpire !== 'OK' && typeof dailyExpire !== 'number') {
      throw new Error(`STORE_INVALID_DAILY_EXPIRE: ${JSON.stringify(dailyExpire)}`);
    }

    return { ipCount, dailyCount };
  }
}

// 싱글톤 기본 메모리 저장소 (개발/단일 프로세스 로컬용)
export const defaultMemoryStore = new MemoryRateLimitStore();

/**
 * 신뢰할 수 있는 클라이언트 IP 추출
 * - Netlify Edge Proxy가 보증하는 헤더를 최우선 신뢰하여 IP 스푸핑 방어
 * 1. x-nf-client-connection-ip (Netlify 엣지 연결 직접 확인 IP)
 * 2. client-ip (인증된 프록시 주입 IP)
 * 3. x-forwarded-for 첫 번째 IP (앞단 프록시 체인)
 * 4. 폴백: 127.0.0.1
 */
export function extractClientIp(request) {
  if (!request || !request.headers) return '127.0.0.1';
  const nf = request.headers.get('x-nf-client-connection-ip');
  if (nf && nf.trim()) return nf.trim();
  const cip = request.headers.get('client-ip');
  if (cip && cip.trim()) return cip.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff && xff.trim()) {
    const firstIp = xff.split(',')[0].trim();
    if (firstIp) return firstIp;
  }
  return '127.0.0.1';
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
  const clientIp = extractClientIp(request);

  // 환경설정 한도 (0이면 전면 차단, 유효하지 않으면 기본값)
  const limitPerMinute = parsePositiveLimit(env.RATE_LIMIT_PER_MINUTE, 10);
  const limitDailyTotal = parsePositiveLimit(env.RATE_LIMIT_DAILY_TOTAL, 500);

  const isJevEnabled = env.JEV_ENABLED === 'true';

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

  // [Fail-Closed 과금 방어 1 - 메모리 우회 플래그 완전 제거]:
  // JEV_ENABLED === 'true'일 때 분산 저장소(Redis)가 미설정된 상태면
  // 메모리 카운터만으로는 다중 인스턴스 과금 차단이 불가능하므로
  // 외부 유료 API 호출을 원천 차단하고(allowExternal = false) 기본 규칙 모드로 안전 폴백.
  // (테스트 주입은 options.isShared === true로 명시 전달된 경우에만 인정)
  let allowExternal = isJevEnabled;
  if (isJevEnabled) {
    const isSharedConfigured = Boolean(
      (options.store && options.isShared === true) ||
      (env.RATE_LIMIT_STORE_URL && env.RATE_LIMIT_STORE_TOKEN)
    );

    if (!isSharedConfigured) {
      allowExternal = false; // 분산 저장소 미설정 시 유료 JEV 호출 차단
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
      allowed: !isJevEnabled, // JEV 미사용 시에는 로컬 규칙 답변 허용, JEV 사용 모드 시 안전 차단
      allowExternal: false,
      status: isJevEnabled ? 429 : 200,
      retryAfter: 60,
      clientIp,
      code: 'STORE_FAILURE',
      reason: 'store_failure',
      error: isJevEnabled
        ? '상담 서버 과금 방어 저장소 연결 실패로 일시 차단되었습니다. 전화로 문의해 주세요.'
        : undefined
    };
  }
}

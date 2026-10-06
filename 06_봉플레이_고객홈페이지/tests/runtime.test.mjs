import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import handler from '../netlify/functions/consult.mjs';
import {
  checkRateLimit,
  parsePositiveLimit,
  isValidExpireResult,
  extractClientIp,
  MemoryRateLimitStore,
  DistributedRedisRateLimitStore
} from '../netlify/functions/lib/rate-limit.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. 서버리스 레이트 리미트 및 분산 과금 방어 단위/통합 테스트 (상한 5분)
// ---------------------------------------------------------------------------
test('1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004 / R2 보완)', { timeout: 300000 }, async (t) => {
  await t.test('1-1. IP별 분당 상한(RATE_LIMIT_PER_MINUTE) 초과 시 429 반환 및 Retry-After 헤더 검증', { timeout: 60000 }, async () => {
    const store = new MemoryRateLimitStore();
    const env = { RATE_LIMIT_PER_MINUTE: '3', JEV_ENABLED: 'false' };
    const reqUrl = 'https://example.test/.netlify/functions/consult';

    for (let i = 1; i <= 3; i++) {
      const req = new Request(reqUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': '192.168.1.100' },
        body: JSON.stringify({ message: '요금' })
      });
      const res = await handler(req, { env, store, ip: '192.168.1.100' });
      assert.equal(res.status, 200, `${i}회차 요청은 정상 통과`);
    }

    // 4회차: 한도 초과
    const reqExceeded = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': '192.168.1.100' },
      body: JSON.stringify({ message: '요금' })
    });
    const resExceeded = await handler(reqExceeded, { env, store, ip: '192.168.1.100' });
    assert.equal(resExceeded.status, 429, '한도 초과 시 HTTP 429 반환');
    assert.equal(resExceeded.headers.get('retry-after'), '60');
    assert.equal(resExceeded.headers.get('cache-control'), 'no-store');

    const body = await resExceeded.json();
    assert.equal(body.code, 'RATE_LIMIT_EXCEEDED');
    assert.match(body.error, /요청이 너무 많습니다/);

    // 다른 IP는 여전히 허용됨을 검증
    const reqOtherIp = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': '192.168.1.200' },
      body: JSON.stringify({ message: '운영시간' })
    });
    const resOtherIp = await handler(reqOtherIp, { env, store, ip: '192.168.1.200' });
    assert.equal(resOtherIp.status, 200, '다른 IP는 독립적으로 정상 처리');
  });

  await t.test('1-2. 일일 전역 쿼터(RATE_LIMIT_DAILY_TOTAL) 초과 시 DAILY_QUOTA_EXCEEDED 반환 검증', { timeout: 60000 }, async () => {
    const store = new MemoryRateLimitStore();
    const env = { RATE_LIMIT_PER_MINUTE: '100', RATE_LIMIT_DAILY_TOTAL: '5', JEV_ENABLED: 'false' };
    const reqUrl = 'https://example.test/.netlify/functions/consult';

    for (let i = 1; i <= 5; i++) {
      const req = new Request(reqUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': `10.0.0.${i}` },
        body: JSON.stringify({ message: '위치' })
      });
      const res = await handler(req, { env, store, ip: `10.0.0.${i}` });
      assert.equal(res.status, 200);
    }

    // 6회차: 일일 총 한도 초과
    const reqExceeded = new Request(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': '10.0.0.99' },
      body: JSON.stringify({ message: '위치' })
    });
    const resExceeded = await handler(reqExceeded, { env, store, ip: '10.0.0.99' });
    assert.equal(resExceeded.status, 429);
    const body = await resExceeded.json();
    assert.equal(body.code, 'DAILY_QUOTA_EXCEEDED');
    assert.match(body.error, /일일 상담 안내 한도가 마감/);
  });

  await t.test('1-3. [Fail-Closed] JEV_ENABLED=true 시 분산 저장소 미설정 상태면 외부 유료호출 원천 차단 검증', { timeout: 60000 }, async () => {
    let externalApiCalled = false;
    const mockFetcher = async () => {
      externalApiCalled = true;
      throw new Error('EXTERNAL_API_SHOULD_NEVER_BE_CALLED_WITHOUT_DISTRIBUTED_STORE');
    };

    const env = {
      JEV_ENABLED: 'true',
      JEV_MODEL: 'systemone-test',
      TYPESAFE_API_KEY: 'TEST_KEY'
      // RATE_LIMIT_STORE_URL 미설정
    };

    const req = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '기본 이용권 요금이 얼마인가요?' })
    });

    const res = await handler(req, { env, fetcher: mockFetcher });
    assert.equal(res.status, 200);
    assert.equal(externalApiCalled, false, '분산 과금 방어 저장소 미설정 시 외부 API 호출 0건 유지');

    const data = await res.json();
    assert.equal(data.mode, 'rules', '외부 호출 차단 후 안전한 기본 규칙 모드로 동작');
    assert.match(data.answer, /15,000/);
  });

  await t.test('1-4. [Fail-Closed] 분산 저장소 통신 장애 시 외부 유료 호출 차단 및 429 반환 검증', { timeout: 60000 }, async () => {
    let externalApiCalled = false;
    const failingStore = {
      hit: async () => {
        throw new Error('REDIS_CONNECTION_REFUSED');
      }
    };

    const env = {
      JEV_ENABLED: 'true',
      JEV_MODEL: 'systemone-test',
      TYPESAFE_API_KEY: 'TEST_KEY'
    };

    const req = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '예약 문의' })
    });

    const res = await handler(req, {
      env,
      store: failingStore,
      fetcher: async () => {
        externalApiCalled = true;
        throw new Error('EXTERNAL_API_CALLED');
      }
    });

    assert.equal(externalApiCalled, false, '저장소 장애 시 유료 호출 절대 차단');
    assert.equal(res.status, 429, '과금 방어 실패 시 429로 안전 차단');
    const body = await res.json();
    assert.equal(body.code, 'STORE_FAILURE');
    assert.match(body.error, /과금 방어 저장소 연결 실패/);
  });

  await t.test('1-5. DistributedRedisRateLimitStore 정상 파이프라인 배치 실행 검증', { timeout: 60000 }, async () => {
    let capturedPipeline = null;
    const mockFetcher = async (url, init) => {
      assert.equal(url, 'https://mock-redis.upstash.io/pipeline');
      capturedPipeline = JSON.parse(init.body);
      return new Response(JSON.stringify([{ result: 2 }, { result: 1 }, { result: 15 }, { result: 'OK' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const store = new DistributedRedisRateLimitStore(
      'https://mock-redis.upstash.io',
      'MOCK_TOKEN',
      mockFetcher
    );

    const result = await store.hit('203.0.113.45', 1700000000000);
    assert.equal(result.ipCount, 2);
    assert.equal(result.dailyCount, 15);
    assert.equal(capturedPipeline.length, 4);
    assert.equal(capturedPipeline[0][0], 'INCR');
    assert.equal(capturedPipeline[1][0], 'EXPIRE');
    assert.equal(capturedPipeline[2][0], 'INCR');
    assert.equal(capturedPipeline[3][0], 'EXPIRE');
  });

  await t.test('1-6. [P1 Fail-Closed & R2 EXPIRE 엄격 검증] 만료 성공(1, OK) 외 0/음수/2/문자/오류 시 외부 호출 0건 차단 검증', { timeout: 60000 }, async () => {
    // 1. isValidExpireResult 헬퍼 자체 단위 검증
    assert.equal(isValidExpireResult(1), true, '1은 유효한 성공');
    assert.equal(isValidExpireResult('OK'), true, 'OK는 유효한 성공');
    assert.equal(isValidExpireResult(0), false, '0은 키 미존재 실패');
    assert.equal(isValidExpireResult(-1), false, '음수는 실패');
    assert.equal(isValidExpireResult(2), false, '2는 비정상 결과로 실패');
    assert.equal(isValidExpireResult('FAIL'), false, '기타 문자열 실패');
    assert.equal(isValidExpireResult(null), false, 'null 실패');
    assert.equal(isValidExpireResult(undefined), false, 'undefined 실패');

    // 2. 벤 R2 재현 케이스: 양의 카운터와 비정상 EXPIRE 결과 (0, -1, 2, 문자, null 등)
    // 위치 1 (IP EXPIRE)과 위치 3 (Daily EXPIRE) 모두 전수 검증
    const invalidExpireValues = [0, -1, 2, 'FAIL', null, undefined];

    for (const badVal of invalidExpireValues) {
      // (a) IP EXPIRE (index 1) 오류
      const ipExpirePayload = [{ result: 1 }, { result: badVal }, { result: 1 }, { result: 1 }];
      const store1 = new DistributedRedisRateLimitStore('https://mock-redis.upstash.io', 'MOCK_TOKEN', async () => {
        return new Response(JSON.stringify(ipExpirePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      await assert.rejects(
        () => store1.hit('1.2.3.4'),
        /STORE_INVALID_IP_EXPIRE/,
        `IP EXPIRE=${JSON.stringify(badVal)} 일 때 반드시 예외를 던져야 함`
      );

      // (b) Daily EXPIRE (index 3) 오류
      const dailyExpirePayload = [{ result: 1 }, { result: 1 }, { result: 1 }, { result: badVal }];
      const store2 = new DistributedRedisRateLimitStore('https://mock-redis.upstash.io', 'MOCK_TOKEN', async () => {
        return new Response(JSON.stringify(dailyExpirePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      await assert.rejects(
        () => store2.hit('1.2.3.4'),
        /STORE_INVALID_DAILY_EXPIRE/,
        `Daily EXPIRE=${JSON.stringify(badVal)} 일 때 반드시 예외를 던져야 함`
      );

      // (c) 핸들러 통과 시 외부 호출 0건 및 HTTP 429 차단 검증
      let externalApiCalled = false;
      const env = { JEV_ENABLED: 'true', TYPESAFE_API_KEY: 'TEST_KEY' };
      const req = new Request('https://example.test/.netlify/functions/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '요금 안내' })
      });

      const res = await handler(req, {
        env,
        store: store1,
        fetcher: async () => {
          externalApiCalled = true;
          throw new Error('EXTERNAL_API_SHOULD_NOT_BE_CALLED');
        }
      });

      assert.equal(externalApiCalled, false, `EXPIRE=${badVal} 시 외부 유료 호출 0건 유지`);
      assert.equal(res.status, 429, '저장소 실패 시 429 차단');
      const body = await res.json();
      assert.equal(body.code, 'STORE_FAILURE');
    }

    // 3. 빈 배열([]) 및 명령 개별 에러([error]) 검증
    const commandErrors = [
      [],
      [{ error: 'ERR' }, { result: 1 }, { result: 1 }, { result: 1 }],
      [{ result: 1 }, { result: 1 }, { error: 'OOM' }, { result: 1 }]
    ];
    for (const errPayload of commandErrors) {
      const storeErr = new DistributedRedisRateLimitStore('https://mock-redis.upstash.io', 'MOCK_TOKEN', async () => {
        return new Response(JSON.stringify(errPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      await assert.rejects(() => storeErr.hit('1.2.3.4'), /STORE_/);
    }
  });

  await t.test('1-7. [P1 Memory 우회 방지 & 한도 파싱] 분산 저장소 없이 메모리 우회 불가 및 한도 0/음수/NaN/Infinity 정책 검증', { timeout: 60000 }, async () => {
    // 1. ALLOW_MEMORY_STORE_FOR_JEV가 환경변수에 있어도 무시되고 allowExternal=false가 되어야 함
    const envWithMemoryFlag = {
      JEV_ENABLED: 'true',
      ALLOW_MEMORY_STORE_FOR_JEV: 'true' // 과거 우회 플래그
    };
    const req = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '요금' })
    });
    const rl = await checkRateLimit(req, { env: envWithMemoryFlag, store: new MemoryRateLimitStore() });
    assert.equal(rl.allowExternal, false, 'ALLOW_MEMORY_STORE_FOR_JEV 플래그가 있어도 분산저장소 미설정 시 외부 호출 불허');

    // 2. 한도 파싱 검증
    assert.equal(parsePositiveLimit('0', 10), 0, '0은 0으로 파싱 (전면 차단)');
    assert.equal(parsePositiveLimit('-10', 10), 0, '음수는 0으로 파싱 (전면 차단)');
    assert.equal(parsePositiveLimit('abc', 10), 10, 'NaN 문자열은 기본값 복원');
    assert.equal(parsePositiveLimit('Infinity', 10), 10, 'Infinity는 기본값 복원');
    assert.equal(parsePositiveLimit(undefined, 10), 10, '미설정은 기본값');
    assert.equal(parsePositiveLimit('25', 10), 25, '유효 양의 정수 파싱');

    // 3. 한도가 0으로 설정된 경우 전면 차단 (RATE_LIMIT_BLOCKED)
    const zeroEnv = { RATE_LIMIT_PER_MINUTE: '0', JEV_ENABLED: 'false' };
    const zeroRes = await checkRateLimit(req, { env: zeroEnv, store: new MemoryRateLimitStore() });
    assert.equal(zeroRes.allowed, false);
    assert.equal(zeroRes.code, 'RATE_LIMIT_BLOCKED');
    assert.equal(zeroRes.status, 429);
  });

  await t.test('1-8. [R2 IP 신뢰 경계 검증] Netlify context.ip 최우선 및 위변조 임의 헤더 차단(untrusted_client) 검증', { timeout: 60000 }, async () => {
    // A. Netlify context.ip 플랫폼 보증 IP가 있는 경우: 위변조된 임의 헤더 무시하고 context.ip 사용
    const spoofedReq = new Request('https://example.test', {
      headers: {
        'client-ip': '1.1.1.1',
        'x-forwarded-for': '2.2.2.2, 3.3.3.3'
      }
    });
    const verifiedIp = extractClientIp(spoofedReq, { ip: '203.0.113.199' });
    assert.equal(verifiedIp, '203.0.113.199', 'Netlify context.ip가 있으면 임의 클라이언트 헤더 무시');

    // B. context.clientContext.ip 플랫폼 보증 검증
    const clientContextIp = extractClientIp(spoofedReq, { clientContext: { ip: '198.51.100.77' } });
    assert.equal(clientContextIp, '198.51.100.77', 'context.clientContext.ip 플랫폼 보증 사용');

    // C. Netlify 엣지 프록시 헤더 (x-nf-client-connection-ip) 검증
    const nfReq = new Request('https://example.test', {
      headers: {
        'x-nf-client-connection-ip': '198.51.100.5',
        'x-forwarded-for': '2.2.2.2'
      }
    });
    const nfIp = extractClientIp(nfReq);
    assert.equal(nfIp, '198.51.100.5', 'Netlify edge 프록시 헤더 신뢰');

    // D. 플랫폼 보증 없는 임의 클라이언트 헤더만 있는 경우 -> untrusted_client 로 귀속
    const untrustedReq = new Request('https://example.test', {
      headers: {
        'client-ip': '10.0.0.1',
        'x-forwarded-for': '10.0.0.2'
      }
    });
    assert.equal(extractClientIp(untrustedReq), 'untrusted_client', '플랫폼 보증 없는 헤더는 untrusted_client로 귀속');

    // E. IP 회전 스푸핑 공격 방어 실측 (헤더를 조작하여 회전해도 untrusted_client로 공통 제한)
    const store = new MemoryRateLimitStore();
    const env = { RATE_LIMIT_PER_MINUTE: '3', JEV_ENABLED: 'false' };
    const reqUrl = 'https://example.test/.netlify/functions/consult';

    for (let i = 1; i <= 3; i++) {
      const rotReq = new Request(reqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': `192.0.2.${i}` // 공격자가 매번 다른 IP를 스푸핑
        },
        body: JSON.stringify({ message: '테스트' })
      });
      // 플랫폼 context 없음
      const res = await handler(rotReq, { env, store });
      assert.equal(res.status, 200, `${i}회차 요청 통과`);
    }

    // 4회차: 공격자가 또 다른 IP(192.0.2.99)로 스푸핑해도 untrusted_client 한도 초과로 차단
    const rotExceeded = new Request(reqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '192.0.2.99'
      },
      body: JSON.stringify({ message: '테스트' })
    });
    const resExceeded = await handler(rotExceeded, { env, store });
    assert.equal(resExceeded.status, 429, '임의 XFF 헤더 조작을 통한 분당 제한 우회 차단 성공');

    // F. 로컬 테스트 명시 주입 IP (options.testIp) 격리 검증
    const testInjected = extractClientIp(untrustedReq, {}, { testIp: '127.0.0.99' });
    assert.equal(testInjected, '127.0.0.99', 'options.testIp 주입 시 테스트 IP 정상 반환');
  });

  await t.test('1-9. [BEN-016 공급자 공통 호출 제한 & Sakana 연결 경로 & Fail-Closed 검증]', { timeout: 60000 }, async (st) => {
    const sakanaEnv = {
      CONSULT_ENABLED: 'true',
      CONSULT_PROVIDER: 'sakana',
      CONSULT_MODEL: 'test-model',
      SAKANA_API_KEY: 'fake-test-key'
    };

    // A. 분산 저장소 미설정 상태: externalAllowed=false 주입되어 외부 호출 0건, rules fallback (Fail-Closed)
    let externalCallsA = 0;
    const mockFetcherA = async () => {
      externalCallsA++;
      throw new Error('EXTERNAL_API_SHOULD_NEVER_BE_CALLED_WITHOUT_DISTRIBUTED_STORE');
    };
    const reqA = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '이용권 요금과 위치를 알려주세요' })
    });
    const resA = await handler(reqA, { env: sakanaEnv, fetcher: mockFetcherA });
    assert.equal(resA.status, 200);
    assert.equal(externalCallsA, 0, '분산 저장소 미설정 시 Sakana 외부 API 호출 0건 유지');
    const dataA = await resA.json();
    assert.equal(dataA.mode, 'rules', '외부 비활성화 시 기본 규칙 모드로 동작');
    assert.equal(dataA.reason, 'external_disabled');

    // B. 클라이언트가 request JSON에 externalAllowed: true 를 위변조하여 전송하더라도 서버에서 무시됨 (0건 호출)
    let externalCallsB = 0;
    const mockFetcherB = async () => {
      externalCallsB++;
      throw new Error('CLIENT_INJECTED_EXTERNAL_ALLOWED_MUST_BE_IGNORED');
    };
    const reqB = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '이용권 요금과 위치를 알려주세요',
        externalAllowed: true // 위변조 시도
      })
    });
    const resB = await handler(reqB, { env: sakanaEnv, fetcher: mockFetcherB });
    assert.equal(resB.status, 200);
    assert.equal(externalCallsB, 0, '클라이언트 JSON의 externalAllowed는 철저히 무시되고 외부 호출 0건');
    const dataB = await resB.json();
    assert.equal(dataB.mode, 'rules');
    assert.equal(dataB.reason, 'external_disabled');

    // C. 저장소 통신 장애(STORE_FAILURE) 발생 시: 즉시 429 반환 및 외부 호출 0건
    let externalCallsC = 0;
    const failingStore = {
      hit: async () => {
        throw new Error('REDIS_DOWN');
      }
    };
    const reqC = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '운영시간 문의' })
    });
    const resC = await handler(reqC, {
      env: sakanaEnv,
      store: failingStore,
      fetcher: async () => {
        externalCallsC++;
        throw new Error('MUST_NOT_BE_CALLED');
      }
    });
    assert.equal(externalCallsC, 0, '저장소 장애 시 유료 호출 절대 차단');
    assert.equal(resC.status, 429, '저장소 실패 시 429 반환');
    const bodyC = await resC.json();
    assert.equal(bodyC.code, 'STORE_FAILURE');

    // D. 분산 저장소 정상 설정 및 허용 시: 서버 내부에서 externalAllowed: true 주입되어 Sakana 경로 정상 동작
    let externalCallsD = 0;
    let capturedUrlD = null;
    let capturedBodyD = null;
    const mockFetcherD = async (url, opts) => {
      externalCallsD++;
      capturedUrlD = url;
      capturedBodyD = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({ ids: ['price', 'location'], clarify: false })
          }
        }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    // Upstash Redis 모의 응답
    const mockRedisFetcher = async () => {
      return new Response(JSON.stringify([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    const redisStore = new DistributedRedisRateLimitStore(
      'https://mock-redis.upstash.io',
      'MOCK_TOKEN',
      mockRedisFetcher
    );

    const reqD = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '비용과 주소가 궁금해요' })
    });
    const resD = await handler(reqD, {
      env: sakanaEnv,
      store: redisStore,
      isShared: true,
      fetcher: mockFetcherD
    });

    assert.equal(resD.status, 200);
    assert.equal(externalCallsD, 1, '분산 저장소 검증 통과 시 외부 호출 1회 정상 실행');
    assert.equal(capturedUrlD, 'https://api.sakana.ai/v1/chat/completions');
    assert.equal(capturedBodyD.model, 'test-model');
    const dataD = await resD.json();
    assert.equal(dataD.mode, 'model', '공급자 선택 모드는 model로 응답');
    assert.equal(dataD.reason, 'selected_knowledge');
    assert.match(dataD.answer, /21,000/);
    assert.match(dataD.answer, /유록길 22/);

    // E. SAKANA_API_KEY만 설정되고 CONSULT_ENABLED=false 인 경우: 외부 호출 0건
    let externalCallsE = 0;
    const envDisabled = {
      ...sakanaEnv,
      CONSULT_ENABLED: 'false'
    };
    const reqE = new Request('https://example.test/.netlify/functions/consult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '비용과 주소가 궁금해요' })
    });
    const resE = await handler(reqE, {
      env: envDisabled,
      store: redisStore,
      fetcher: async () => {
        externalCallsE++;
        throw new Error('MUST_NOT_BE_CALLED');
      }
    });
    assert.equal(resE.status, 200);
    assert.equal(externalCallsE, 0, 'CONSULT_ENABLED=false 시 외부 호출 0건');
    const dataE = await resE.json();
    assert.equal(dataE.mode, 'rules');
  });
});

// ---------------------------------------------------------------------------
// 2. 실제 헤드리스 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844) (상한 5분)
// ---------------------------------------------------------------------------
test('2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004 / R2 보완)', { timeout: 300000 }, async (t) => {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browserExe = fs.existsSync(chromePath) ? chromePath : (fs.existsSync(edgePath) ? edgePath : null);

  if (!browserExe) {
    t.skip('헤드리스 브라우저 실행 바이너리가 없어 브라우저 시험을 스킵합니다.');
    return;
  }

  const PORT = 4188;
  const BASE_URL = `http://127.0.0.1:${PORT}`;
  let server = null;
  let serverMockMode = 'normal'; // 'normal' | 'rate_limit' | 'daily_quota' | 'timeout' | 'input_error'

  // 로컬 HTTP 서버 기동 (정적 파일 제공 + /.netlify/functions/consult 모의 핸들러)
  await new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, BASE_URL);
      const reqPath = urlObj.pathname;

      if (reqPath === '/.netlify/functions/consult') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'POST only' }));
        }

        if (serverMockMode === 'rate_limit') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '60'
          });
          return res.end(JSON.stringify({
            error: '문의 요청이 너무 많습니다. 1분 후 다시 시도해 주세요.',
            code: 'RATE_LIMIT_EXCEEDED'
          }));
        }

        if (serverMockMode === 'daily_quota') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '3600'
          });
          return res.end(JSON.stringify({
            error: '일일 상담 안내 한도가 마감되었습니다. 전화(010-5931-4144)로 문의해 주세요.',
            code: 'DAILY_QUOTA_EXCEEDED'
          }));
        }

        if (serverMockMode === 'input_error') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: '질문이 너무 깁니다. 1,200자 이내로 입력해 주세요.'
          }));
        }

        if (serverMockMode === 'timeout') {
          // 클라이언트 타임아웃(9초)보다 길게(9.6초) 대기하여 클라이언트 timeout 트리거
          await new Promise(r => setTimeout(r, 9600));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ answer: '지연 응답' }));
        }

        // 일반 정상 모드: consultation handler 실행
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuffer = Buffer.concat(chunks);

        const webReq = new Request(`${BASE_URL}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: bodyBuffer
        });

        const webRes = await handler(webReq, {
          env: { JEV_ENABLED: 'false' },
          store: new MemoryRateLimitStore(),
          ip: '127.0.0.1'
        });

        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        const resBody = await webRes.text();
        return res.end(resBody);
      }

      // 정적 파일 서빙
      let localFile = path.join(PROJECT_DIR, reqPath === '/' ? 'index.html' : reqPath.slice(1));
      if (!fs.existsSync(localFile) || !fs.statSync(localFile).isFile()) {
        res.writeHead(404);
        return res.end('Not Found');
      }

      const ext = path.extname(localFile);
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(localFile));
    });

    server.listen(PORT, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  // 브라우저 실행 헬퍼
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-jev-browser-'));
  const cdpPort = 9338;
  let child = null;
  let ws = null;
  let sessionId = null;
  let msgId = 1;

  function send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', handlerMsg);
        reject(new Error(`CDP ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      const handlerMsg = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handlerMsg);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      ws.addEventListener('message', handlerMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function sendSession(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timer = setTimeout(() => {
        ws.removeEventListener('message', handlerMsg);
        reject(new Error(`Session CDP ${method} timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      const handlerMsg = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeEventListener('message', handlerMsg);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      ws.addEventListener('message', handlerMsg);
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await sendSession('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res?.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${res.exceptionDetails.text} | ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res?.result?.value !== undefined ? res?.result?.value : res?.result?.result?.value;
  }

  try {
    child = spawn(browserExe, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempDir}`,
      'about:blank'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // CDP 준비 대기 (최대 10초)
    let versionData = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch (e) {}
    }
    assert.ok(versionData, 'CDP 버전 엔드포인트 응답 확인');

    ws = new WebSocket(versionData.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    const target = await send('Target.createTarget', { url: `${BASE_URL}/index.html` });
    const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessionId = attach.sessionId;

    await sendSession('Page.enable');
    await sendSession('Runtime.enable');
    await sendSession('DOM.enable');

    await new Promise(r => setTimeout(r, 1000));

    // -----------------------------------------------------------------------
    // [데스크톱 검증: 1440x900]
    // -----------------------------------------------------------------------
    await t.test('2-1. [Desktop 1440x900] 상담 열기, ESC 닫기, 포커스 복원 검증', { timeout: 60000 }, async () => {
      await sendSession('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      });

      const btnVisible = await evaluate("Boolean(document.querySelector('.consult-open'))");
      assert.equal(btnVisible, true, 'AI 상담 열기 버튼 표시 확인');

      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 200));

      const isOpened = await evaluate("document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isOpened, true, '상담 다이얼로그 모달 오픈 확인');

      const isInputFocused = await evaluate("document.activeElement.id === 'consult-question'");
      assert.equal(isInputFocused, true, '열림 시 입력창 자동 포커스 확인');

      // ESC 키로 닫기
      await evaluate(`
        (() => {
          const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
          document.querySelector('.consult-dialog').dispatchEvent(event);
          document.querySelector('.consult-dialog').close();
        })()
      `);
      await new Promise(r => setTimeout(r, 200));

      const isClosed = await evaluate("!document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isClosed, true, '다이얼로그 닫힘 확인');
    });

    await t.test('2-2. [Desktop 1440x900] 빠른 주제(요금) 질문 제출 및 15,000원 안내 응답 실측', { timeout: 60000 }, async () => {
      serverMockMode = 'normal';
      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 100));

      const topicClicked = await evaluate(`
        (() => {
          const btn = Array.from(document.querySelectorAll('.consult-topic-btn')).find(b => b.textContent === '요금');
          if (btn) { btn.click(); return true; }
          return false;
        })()
      `);
      assert.equal(topicClicked, true, '요금 빠른 버튼 클릭 실행');

      let logText = '';
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        logText = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText && logText.includes('15,000원')) break;
      }

      assert.match(logText, /나: 요금/, '사용자 질문 로그 렌더링 확인');
      assert.match(logText, /15,000원/, '기본 이용권 15,000원 고시가 안내 렌더링 확인');
      assert.match(logText, /봉플레이 공개 안내 기준|홈페이지 안내/, '출처 안내 표기 확인');
    });

    await t.test('2-3. [Desktop 1440x900] 연속 제출 방지 (Double Submit Guard) 실측', { timeout: 60000 }, async () => {
      const isSubmittingGuarded = await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const submitBtn = document.querySelector('.consult-submit');
          const input = document.querySelector('#consult-question');
          input.value = '운영시간';
          form.requestSubmit();
          return Boolean(submitBtn.disabled);
        })()
      `);
      assert.equal(isSubmittingGuarded, true, '제출 직후 전송 버튼 disabled 처리 확인');

      await new Promise(r => setTimeout(r, 500));
      const logText = await evaluate("document.querySelector('.consult-log').innerText");
      assert.match(logText, /운영시간과 운영일은 확정 후 안내/, '운영시간 미확정 안내 응답 렌더링');
    });

    await t.test('2-4. [Desktop 1440x900] 한글 IME 조합 중(isComposing=true) Enter 전송 방지 실측', { timeout: 60000 }, async () => {
      // 한글 조합 중 Enter 이벤트 발생 시 submit 되지 않아야 함
      const imePrevented = await evaluate(`
        (() => {
          const input = document.querySelector('#consult-question');
          input.value = '조합중인한글';
          let submitted = false;
          const submitHandler = () => { submitted = true; };
          const form = document.querySelector('.consult-form');
          form.addEventListener('submit', submitHandler, { once: true });

          // isComposing = true 인 Enter 이벤트 디스패치
          const imeEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true
          });
          input.dispatchEvent(imeEvent);

          form.removeEventListener('submit', submitHandler);
          input.value = ''; // 정리
          return submitted === false;
        })()
      `);
      assert.equal(imePrevented, true, '한글 IME 조합 중 Enter 키 입력 시 폼 제출 방지 확인');
    });

    await t.test('2-5. [Desktop 1440x900] HTTP 429 일일 한도 vs 1분 분당 제한 차등 렌더링 실측', { timeout: 60000 }, async () => {
      // 1. 분당 상한 초과 (RATE_LIMIT_EXCEEDED)
      serverMockMode = 'rate_limit';
      await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '분당 제한 질문';
          form.requestSubmit();
        })()
      `);

      let logText1 = '';
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        logText1 = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText1 && logText1.includes('1분 후 다시 시도')) break;
      }
      assert.match(logText1, /1분 후 다시 시도/, '분당 제한 시 1분 대기 안내 렌더링');

      // 2. 일일 한도 초과 (DAILY_QUOTA_EXCEEDED)
      serverMockMode = 'daily_quota';
      await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '일일 한도 질문';
          form.requestSubmit();
        })()
      `);

      let logText2 = '';
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        logText2 = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText2 && logText2.includes('오늘 상담 안내 한도가 마감')) break;
      }
      assert.match(logText2, /오늘 상담 안내 한도가 마감/, '일일 한도 마감 안내 렌더링');
    });

    await t.test('2-6. [Desktop 1440x900] 실제 9초 타임아웃(AbortSignal.timeout) 발생 및 안내 문구 렌더링 실측', { timeout: 60000 }, async () => {
      // 서버에서 9.6초 대기 -> 클라이언트 9초 타임아웃 트리거
      serverMockMode = 'timeout';
      await evaluate(`
        (() => {
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '타임아웃 유발 질문';
          form.requestSubmit();
        })()
      `);

      // 9초 타임아웃 수신 대기 (최대 12초 폴링)
      let logText = '';
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 200));
        logText = await evaluate("document.querySelector('.consult-log').innerText");
        if (logText && logText.includes('상담 응답 시간이 초과되었습니다 (9초)')) break;
      }

      assert.match(logText, /상담 응답 시간이 초과되었습니다 \(9초\)/, '9초 타임아웃 안내 문구 정상 표출 확인');

      // 타임아웃 후 폼과 버튼이 다시 활성화되었는지 확인
      const isReEnabled = await evaluate(`
        (() => {
          const submitBtn = document.querySelector('.consult-submit');
          return submitBtn.disabled === false;
        })()
      `);
      assert.equal(isReEnabled, true, '타임아웃 발생 후 전송 버튼 재활성화 확인');
    });

    // -----------------------------------------------------------------------
    // [모바일 검증: 390x844 (iPhone 12/13/14 표준)]
    // -----------------------------------------------------------------------
    await t.test('2-7. [Mobile 390x844] 뷰포트 레이아웃 수평 넘침 0 및 모바일 다이얼로그 적합성 실측', { timeout: 60000 }, async () => {
      await sendSession('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      });

      const overflow = await evaluate(`
        (() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        })()
      `);
      assert.equal(overflow, false, '모바일 390px 폭에서 가로 스크롤 넘침 없음(0px)');

      const dialogWidth = await evaluate(`
        (() => {
          return document.querySelector('.consult-dialog').getBoundingClientRect().width;
        })()
      `);
      assert.ok(dialogWidth <= 390, `다이얼로그 폭(${dialogWidth}px)이 390px 화면 내에 안전 수용됨`);

      await evaluate("document.querySelector('.consult-close').click()");
      await new Promise(r => setTimeout(r, 100));
      const isClosed = await evaluate("!document.querySelector('.consult-dialog').hasAttribute('open')");
      assert.equal(isClosed, true, '모바일 상단 닫기 버튼 정상 작동');
    });

    await t.test('2-8. [Mobile 390x844] 오프라인 상태(navigator.onLine=false) 감지 안내 실측', { timeout: 60000 }, async () => {
      await evaluate("document.querySelector('.consult-open').click()");
      await new Promise(r => setTimeout(r, 100));

      const offlineMsgRendered = await evaluate(`
        (() => {
          Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
          const form = document.querySelector('.consult-form');
          const input = document.querySelector('#consult-question');
          input.value = '오프라인 질문 테스트';
          form.requestSubmit();
          const log = document.querySelector('.consult-log').innerText;
          Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); // 복원
          return Boolean(log && log.includes('오프라인 상태입니다'));
        })()
      `);

      assert.equal(offlineMsgRendered, true, '네트워크 오프라인 시 안내 메시지 즉각 렌더링 확인');
    });

  } finally {
    // [안전 프로세스 종료 규칙 준수]: 테스트가 생성한 Chrome PID만 안전 종료
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    if (child) {
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
      }, 500);
    }
    if (tempDir) {
      setTimeout(() => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
      }, 1000);
    }
    if (server) {
      await new Promise(r => server.close(r));
    }
  }
});

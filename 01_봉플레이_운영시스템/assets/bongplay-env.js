/* ============================================================
   BongplayEnv — 놀이시설 운영 의사결정 시뮬레이션 환경
   ------------------------------------------------------------
   RE:PLAYCE 기술자산 / v1.0

   설계 원칙
   1. 물리법칙은 봉플레이 실측·확정 파라미터를 그대로 쓴다.
      (BEP 19,606명 / 공헌이익 11,675원 / 계절 계수)
   2. 에이전트의 행동이 결과를 바꾼다. 각본 재생이 아니다.
   3. 계약 해지 조건(중대민원 2회)은 종료 상태로 처리한다.
      — 사업이 실제로 끝나는 조건이므로.
   4. 시드 고정 시 재현 가능해야 한다. (실험 비교 목적)
   ============================================================ */

(function (global) {
  'use strict';

  // ── 확정 파라미터 (봉플레이 실사업 기준) ──────────────
  const P = {
    FIXED_ANNUAL: 228_900_000,   // 연간 고정비
    PRICE_BLEND:  12_036,        // 혼합객단가
    VAR_COST:     361,           // 1인당 변동비
    BEP_ANNUAL:   19_606,        // 연간 손익분기 방문객
    OPEN_DAYS:    300,           // 연 영업일

    // 계절 구간 (일수, 연간 방문 비중)
    SEASONS: {
      peak:   { days: 55,  share: 0.40, label: '성수기' },
      mid:    { days: 105, share: 0.35, label: '준성수기' },
      winter: { days: 140, share: 0.25, label: '동절기' }
    },

    // 짚코스터 처리용량 — 시간당 (제조사 미확인, 태조산 사례 기반 추정)
    ZIP_THROUGHPUT_HR: 18,
    OPEN_HOURS: 8,

    // 인건비 (일)
    STAFF_COST_DAY: 93_000,      // 안전요원 1인 일당 환산
    MIN_SAFETY_STAFF: 2,         // 법정·안전상 최소 배치
  };

  const CM = P.PRICE_BLEND - P.VAR_COST;   // 공헌이익 11,675

  // ── 재현 가능 난수 (시드 고정) ────────────────────────
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ── 환경 ──────────────────────────────────────────────
  class BongplayEnv {
    constructor(opts) {
      opts = opts || {};
      this.seed = opts.seed != null ? opts.seed : 42;
      this.maxDays = opts.maxDays || 300;
      this.reset();
    }

    reset() {
      this.rng = mulberry32(this.seed);
      this.day = 0;

      this.state = {
        // 누적
        cumVisitors: 0,
        cumRevenue: 0,
        cumCost: 0,
        cumProfit: 0,

        // 안전·민원
        seriousComplaints: 0,   // 2회면 계약 해지
        minorComplaints: 0,
        incidents: 0,
        safeDays: 0,

        // 운영 상태
        staffSafety: 3,
        reputation: 0.5,        // 0~1, 재방문·입소문에 영향
        zipOpen: true,
        cafeReady: true,

        // 당일
        weather: 'clear',
        season: 'winter',
        dow: 0,
        visitors: 0,
        queueWait: 0,
        revenue: 0,
        profit: 0
      };

      this.log = [];
      this.done = false;
      this.terminationReason = null;
      return this._observe();
    }

    // ── 관측 (에이전트가 보는 상태) ──────────────────────
    _observe() {
      const s = this.state;
      const bepProgress = s.cumVisitors / P.BEP_ANNUAL;
      return {
        day: this.day,
        season: s.season,
        dow: s.dow,
        weather: s.weather,
        staffSafety: s.staffSafety,
        reputation: +s.reputation.toFixed(3),
        cumVisitors: s.cumVisitors,
        cumProfit: Math.round(s.cumProfit),
        bepProgress: +bepProgress.toFixed(4),
        seriousComplaints: s.seriousComplaints,
        incidents: s.incidents,
        safeDaysStreak: s.safeDays,
        zipOpen: s.zipOpen,
        done: this.done
      };
    }

    // ── 하루 조건 생성 ───────────────────────────────────
    _rollDay() {
      const r = this.rng;
      const s = this.state;
      const d = this.day;

      s.dow = d % 7;                     // 0=월 ... 5,6=주말

      // 계절: 300 영업일을 구간으로 분할
      const cyc = d % 300;
      if (cyc < 140) s.season = 'winter';
      else if (cyc < 245) s.season = 'mid';
      else s.season = 'peak';

      // 날씨 — 동절기일수록 악천후 확률 상승
      const badP = s.season === 'winter' ? 0.28 : s.season === 'mid' ? 0.15 : 0.10;
      const w = r();
      s.weather = w < badP * 0.4 ? 'storm' : w < badP ? 'rain' : 'clear';

      // 혹한/폭우 시 짚코스터 자동 폐쇄 (안전)
      s.zipOpen = !(s.weather === 'storm' || (s.season === 'winter' && s.weather === 'rain'));
    }

    // ── 수요 모델 ────────────────────────────────────────
    _demand(action) {
      const s = this.state, r = this.rng;
      const sc = P.SEASONS[s.season];

      // 기준: 해당 계절 일평균
      let base = (P.BEP_ANNUAL * sc.share) / sc.days;

      // 요일 (주말 1.9배, 평일 0.7배)
      base *= (s.dow >= 5) ? 1.9 : 0.7;

      // 날씨
      if (s.weather === 'rain')  base *= 0.72;
      if (s.weather === 'storm') base *= 0.45;
      // 실내 657㎡ 보유 — 악천후 방어력 (이 시설의 실제 강점)
      if (s.weather !== 'clear') base *= 1.25;

      // 평판 (0.5 기준, ±30%)
      base *= (0.7 + s.reputation * 0.6);

      // 행동 효과
      if (action.promoMorning) base *= 1.12;      // 오전권 할인
      if (action.acceptGroup)  base += action.groupSize || 0;
      if (!s.zipOpen)          base *= 0.78;      // 짚코스터 폐쇄 시 이탈

      // 확률 변동 ±18%
      base *= (0.82 + r() * 0.36);

      return Math.max(0, Math.round(base));
    }

    // ── 한 스텝 = 하루 ───────────────────────────────────
    step(action) {
      if (this.done) return { obs: this._observe(), reward: 0, done: true, info: {} };

      action = Object.assign({
        staffSafety: 3,      // 안전요원 배치 (2~5)
        promoMorning: false, // 오전권 할인
        acceptGroup: false,  // 단체 예약 수락
        groupSize: 0,
        prioritizeCS: false  // 민원 우선 처리
      }, action || {});

      const s = this.state, r = this.rng;
      const events = [];

      this.day++;
      this._rollDay();

      s.staffSafety = Math.max(P.MIN_SAFETY_STAFF, Math.min(5, action.staffSafety));

      // ── 방문객 ──
      let visitors = this._demand(action);

      // ── 짚코스터 대기열 (처리용량 병목) ──
      const zipCapacity = P.ZIP_THROUGHPUT_HR * P.OPEN_HOURS;   // 144명/일
      const zipDemand = s.zipOpen ? Math.round(visitors * 0.5) : 0;
      const overflow = Math.max(0, zipDemand - zipCapacity);
      s.queueWait = zipCapacity > 0 ? Math.round(overflow / P.ZIP_THROUGHPUT_HR * 60) : 0;

      // 대기 60분 초과 시 이탈 + 민원 확률
      if (s.queueWait > 60) {
        const churn = Math.round(overflow * 0.15);
        visitors -= churn;
        events.push({ type: 'warn', msg: `짚코스터 대기 ${s.queueWait}분 — 이탈 ${churn}명` });
      }

      s.visitors = visitors;

      // ── 매출 ──
      const revenue = visitors * P.PRICE_BLEND;
      const varCost = visitors * P.VAR_COST;
      const fixedDay = P.FIXED_ANNUAL / P.OPEN_DAYS;
      const staffExtra = (s.staffSafety - P.MIN_SAFETY_STAFF) * P.STAFF_COST_DAY;
      const dayProfit = revenue - varCost - fixedDay - staffExtra;

      s.revenue = revenue;
      s.profit = dayProfit;
      s.cumVisitors += visitors;
      s.cumRevenue += revenue;
      s.cumProfit += dayProfit;

      // ── 안전 사고 ──
      // 인원이 많고 안전요원이 적을수록 위험
      const load = visitors / 150;
      const staffFactor = (6 - s.staffSafety) / 4;
      const incidentP = 0.004 * load * staffFactor * (s.zipOpen ? 1.4 : 1.0);

      let hadIncident = false;
      if (r() < incidentP) {
        hadIncident = true;
        s.incidents++;
        s.safeDays = 0;
        s.reputation = Math.max(0, s.reputation - 0.08);
        events.push({ type: 'danger', msg: '안전사고 발생 — 무사고 기록 초기화' });
      } else {
        s.safeDays++;
      }

      // ── 민원 ──
      let complaintP = 0.015;
      if (s.queueWait > 60) complaintP += 0.12;
      if (hadIncident)      complaintP += 0.50;
      if (s.staffSafety <= 2) complaintP += 0.06;
      // 안전요원이 많으면 현장에서 즉시 해소되어 민원으로 번지지 않음
      if (s.staffSafety >= 4) complaintP *= 0.6;
      if (action.prioritizeCS) complaintP *= 0.45;

      let newSerious = 0;
      if (r() < complaintP) {
        // 중대민원은 사고를 동반할 때 주로 발생.
        // 사고 없는 단순 불만이 곧바로 '중대'가 되는 일은 드물다.
        let seriousP = hadIncident ? 0.35 : 0.02;
        // 현장 대응이 두터우면 중대화 억제
        if (s.staffSafety >= 4) seriousP *= 0.5;
        if (action.prioritizeCS) seriousP *= 0.5;
        if (r() < seriousP) {
          newSerious = 1;
          s.seriousComplaints++;
          s.reputation = Math.max(0, s.reputation - 0.12);
          events.push({ type: 'danger', msg: `⚠ 중대민원 발생 (누적 ${s.seriousComplaints}건 / 2건 시 계약해지)` });
        } else {
          s.minorComplaints++;
          s.reputation = Math.max(0, s.reputation - 0.02);
          events.push({ type: 'warn', msg: '경미 민원 접수' });
        }
      }

      // ── 평판 회복 (무사고 지속) ──
      if (!hadIncident && s.queueWait < 30) {
        s.reputation = Math.min(1, s.reputation + 0.004);
      }

      // ── 보상 설계 ──
      // 이익을 만 원 단위로 정규화 + 안전·민원 페널티
      let reward = dayProfit / 10_000;
      if (hadIncident) reward -= 50;
      reward -= newSerious * 300;
      if (s.queueWait > 60) reward -= 10;
      if (s.safeDays > 0 && s.safeDays % 30 === 0) reward += 20;   // 무사고 30일

      // ── 중대민원 후 집중 관리 (재발방지 조치) ──
      // 1건 발생 후 인력을 늘리고 민원 우선 대응하면 2건째 위험이 크게 준다.
      if (s.seriousComplaints === 1 && s.staffSafety >= 4 && action.prioritizeCS) {
        s.reputation = Math.min(1, s.reputation + 0.006);
      }

      // ── 종료 조건 ──
      if (s.seriousComplaints >= 2) {
        this.done = true;
        this.terminationReason = 'CONTRACT_TERMINATED';
        reward -= 1000;
        events.push({ type: 'danger', msg: '🚨 중대민원 2건 — 계약서 제13조⑥에 따라 사용허가 취소' });
      }
      if (this.day >= this.maxDays) {
        this.done = true;
        this.terminationReason = this.terminationReason || 'SEASON_END';
        // BEP 초과 달성 보너스
        if (s.cumVisitors > P.BEP_ANNUAL) reward += 200;
      }

      this.log.push({
        day: this.day, season: s.season, dow: s.dow, weather: s.weather,
        visitors, revenue, profit: Math.round(dayProfit),
        queueWait: s.queueWait, incident: hadIncident, serious: newSerious,
        reward: +reward.toFixed(2)
      });

      return {
        obs: this._observe(),
        reward: +reward.toFixed(2),
        done: this.done,
        info: { events, visitors, revenue, dayProfit: Math.round(dayProfit), queueWait: s.queueWait }
      };
    }

    // ── 결과 요약 ────────────────────────────────────────
    summary() {
      const s = this.state;
      return {
        days: this.day,
        terminated: this.terminationReason,
        cumVisitors: s.cumVisitors,
        cumRevenue: Math.round(s.cumRevenue),
        cumProfit: Math.round(s.cumProfit),
        bepAchieved: s.cumVisitors >= P.BEP_ANNUAL,
        bepProgress: +(s.cumVisitors / P.BEP_ANNUAL).toFixed(3),
        incidents: s.incidents,
        seriousComplaints: s.seriousComplaints,
        minorComplaints: s.minorComplaints,
        finalReputation: +s.reputation.toFixed(3),
        totalReward: +this.log.reduce((a, b) => a + b.reward, 0).toFixed(1)
      };
    }
  }

  // ── 기준 정책 (베이스라인) ────────────────────────────
  const Policies = {
    // 1. 최소 비용 — 안전요원 최소, 프로모션 없음
    minimal: function (obs) {
      return { staffSafety: 2, promoMorning: false, acceptGroup: false, prioritizeCS: false };
    },

    // 2. 안전 우선 — 인력 최대, 민원 즉시 대응
    safetyFirst: function (obs) {
      return { staffSafety: 5, promoMorning: false, acceptGroup: false, prioritizeCS: true };
    },

    // 3. 매출 극대화 — 프로모션·단체 다 받음
    aggressive: function (obs) {
      return {
        staffSafety: 2, promoMorning: true,
        acceptGroup: true, groupSize: 40, prioritizeCS: false
      };
    },

    // 4. 균형 — 상황에 따라 조정 (규칙 기반)
    balanced: function (obs) {
      const weekend = obs.dow >= 5;
      const peak = obs.season === 'peak';
      const behind = obs.bepProgress < (obs.day / 300) * 0.9;   // BEP 진도 미달

      return {
        // 붐빌 것 같으면 인력 증원
        staffSafety: (weekend || peak) ? 4 : 3,
        // 평일이고 진도 미달이면 오전권 할인
        promoMorning: !weekend && behind,
        // 평일 단체는 적극 수용 (유휴 슬롯)
        acceptGroup: !weekend,
        groupSize: 40,
        // 민원 누적 시 우선 대응
        prioritizeCS: obs.seriousComplaints >= 1
      };
    }
  };

  global.BongplayEnv = BongplayEnv;
  global.BongplayPolicies = Policies;
  global.BONGPLAY_PARAMS = P;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { BongplayEnv, Policies, P };
  }
})(typeof window !== 'undefined' ? window : globalThis);

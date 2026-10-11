/**
 * prototypes/evidence/ANT-007/app.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026) 프런트엔드 애플리케이션 로직
 * 
 * 핵심 규칙 구현:
 * 1. 데이터 품질: 정상 / 일부 누락 / 오래된 자료 / 확인 불가 4단계 분류 & 갱신 시각 표기
 *    - 조회 실패 시 절대 0건으로 표시하지 않고 '확인 불가'로 격리 표기.
 * 2. 실험 카드: 가설, 변경내용, 대상, 기간, 비교방식, 지표, 표본수, 결과, 다음결정
 *    - 표본 부족 -> '판단 보류'
 *    - 단순 전후 비교 -> '관찰 결과'
 *    - 비용 미입력 -> '비용 미입력 (수익성 미검증 / ROI 산정 보류)' (0원 왜곡 차단)
 * 3. 운영 지침: 적용조건, 실행절차, 근거, 한계, 타 현장 재검증 항목
 * 4. 시나리오 제어: 정상, 빈자료, 지연, 실패, 복구, 중복자료
 */

(function () {
  'use strict';

  // 상태 관리 객체
  const state = {
    currentTab: 'quality', // 'quality' | 'experiments' | 'guidelines'
    activeScenario: 'normal',
    data: null,
    lastKnownGoodData: null,
    lastFetchedTime: null,
    isLoading: false,
    fetchError: null,
    qualityFilter: 'all' // 'all' | 'normal' | 'partial_missing' | 'stale' | 'unverifiable'
  };

  // 내장 로컬 모의 데이터 (서버 미구동 단독 브라우저 실행 지원용 fallback)
  const FALLBACK_DATA = {
    meta: {
      system: "리틀포레스트 봉플레이 실증 데이터 관제 시제품 (Local Fallback)",
      site_name: "봉플레이 봉화 본점",
      is_synthetic: true
    },
    datasets: [
      {
        id: "ds_visit_log",
        name: "보호자 및 아동 방문·체류 로그",
        table_name: "ops_guardian_visit_log",
        category: "입출장 및 체류",
        status: "partial_missing",
        status_label: "일부 누락",
        total_records: 482,
        valid_records: 441,
        missing_records: 41,
        duplicate_records: 0,
        missing_fields: ["checkout_at", "guardian_phone_optin"],
        last_updated_at: "2026-10-11T11:45:00+09:00",
        staleness_hours: 0.5,
        description: "게이트 태그 입장 및 퇴장 체류시간 기록. 퇴장 시 바코드 미태그로 인한 체류시간 누락 41건(8.5%) 존재.",
        quality_summary: "체류시간 분석 시 결손치(41건)는 평균값 대체 대신 분석 대상에서 제외 처리 필요."
      },
      {
        id: "ds_welcome_drink",
        name: "보호자 웰컴 음료 쿠폰 지급·수령 내역",
        table_name: "ops_welcome_drink_distribution",
        category: "운영 실험 개입",
        status: "normal",
        status_label: "정상",
        total_records: 210,
        valid_records: 210,
        missing_records: 0,
        duplicate_records: 0,
        missing_fields: [],
        last_updated_at: "2026-10-11T12:05:00+09:00",
        staleness_hours: 0.1,
        description: "매표소 발권 시 교부된 웰컴 음료 바우처 및 카페 창구 실교환 기록 100% 정상 수집.",
        quality_summary: "발권 번호-바우처 ID 1:1 매핑 완전 일치. 교환율 91.4% (192건 교환 완료)."
      },
      {
        id: "ds_guardian_survey",
        name: "보호자 만족도 및 대기 피로도 설문",
        table_name: "ops_guardian_survey_feedback",
        category: "고객 경험 피드백",
        status: "stale",
        status_label: "오래된 자료",
        total_records: 128,
        valid_records: 124,
        missing_records: 4,
        duplicate_records: 0,
        missing_fields: ["revisit_intent_score"],
        last_updated_at: "2026-10-09T18:20:00+09:00",
        staleness_hours: 42.4,
        description: "카카오 알림톡 설문 링크를 통해 수집된 피드백. 배치 동기화가 24시간 이상 지연되어 최근 주말 수치가 미반영 상태.",
        quality_summary: "최근 42시간 동안 신규 동기화 부재로 실시간 의사결정 시 보정치 필요."
      },
      {
        id: "ds_beverage_cost",
        name: "음료 원가 및 F&B 소모 비용 대사",
        table_name: "ops_beverage_cost_ledger",
        category: "비용 및 자원",
        status: "partial_missing",
        status_label: "일부 누락",
        total_records: 192,
        valid_records: 0,
        missing_records: 192,
        duplicate_records: 0,
        missing_fields: ["unit_cost_krw", "supplier_invoice_id", "labor_cost_krw"],
        last_updated_at: "2026-10-10T09:00:00+09:00",
        staleness_hours: 27.0,
        description: "음료 제조 수량은 집계되었으나 단위 원가 및 매입 계산서 미연결 상태.",
        quality_summary: "⚠️ 비용 미입력: 원가 0원이나 수익성 검증 완료로 처리 금지. 순이익/ROI 산정 불가 상태로 표기."
      },
      {
        id: "ds_external_weather",
        name: "봉화 현장 기상 및 야외 체감온도 로그",
        table_name: "ops_weather_context_stream",
        category: "외부 환경 변수",
        status: "unverifiable",
        status_label: "확인 불가",
        total_records: null,
        valid_records: null,
        missing_records: null,
        duplicate_records: null,
        missing_fields: ["all_fields"],
        last_updated_at: null,
        staleness_hours: null,
        description: "기상 센서 게이트웨이 통신 단절로 최근 데이터 무응답 (조회 실패).",
        quality_summary: "❌ 조회 실패 상태: 0건으로 표시하지 않고 '확인 불가 (센서 연결 단절)'로 격리 표시."
      }
    ],
    experiments: [
      {
        id: "EXP-2026-001",
        title: "주말 매표 시 보호자 웰컴 음료 제공에 따른 대기 피로도 완화 및 체류 만족도 영향",
        topic: "보호자 웰컴 음료",
        hypothesis: "발권 시 보호자에게 봉화 사과 에이드/아메리카노 교환권을 웰컴 제공하면, 대기 피로도가 유의미하게 경감되어 보호자 체류 만족도가 0.4점 이상 상승하고 불만 접수율이 50% 이상 감소할 것이다.",
        intervention: "매표소 발권 완료 시 보호자 1인당 웰컴 음료 지류/모바일 교환권 1매 교부 (카페 창구 즉시 수령 가능).",
        target_cohort: "주말 유아/초등 동반 가족 방문객 보호자",
        period: "2026-10-03 ~ 2026-10-05 (주말 3일간)",
        methodology: "A/B 테스트 (통제군: 일반 발권, 실험군: 웰컴 음료 교부)",
        method_type: "ab_test",
        metrics: [
          { name: "보호자 만족도 점수 (5점 만점)", control_value: "4.10", experiment_value: "4.65", delta: "+0.55점", trend: "positive" },
          { name: "대기 관련 불만 접수율", control_value: "14.5%", experiment_value: "3.8%", delta: "-10.7%p (-73.8%)", trend: "positive" },
          { name: "평균 가족 체류 시간", control_value: "118분", experiment_value: "140분", delta: "+22분", trend: "positive" },
          { name: "음료 교환 수령률", control_value: "N/A", experiment_value: "91.8%", delta: "156명 중 143명 수령", trend: "neutral" }
        ],
        sample_size: 154,
        sample_threshold: 60,
        is_sample_sufficient: true,
        evaluation_status: "positive_confirmed",
        evaluation_label: "가설 지지 (개선 확인)",
        cost_status: "cost_missing",
        cost_label: "비용 미입력 (수익성 미검증)",
        cost_warning: "음료 원가 및 조제 인건비 미기입으로 순수익 기여도(ROI)는 검증되지 않았습니다. 원가 대사 전까지 무료 전면 확대는 보류합니다.",
        results_summary: "음료 제공 시 대기 중 카페 라운지 분산 착석 효과가 확인되어 보호자 체류 만족도가 4.10점에서 4.65점으로 대폭 향상됨. 대기 불만도 73.8% 급감.",
        next_decision: "주말 운영 표준 SOP로 1차 승인하되, F&B 부서의 1잔당 원가(사과 농축액 등) 산정 완료 후 영주/안동 현장 전파 여부 확정.",
        decision_tag: "운영 지침화 추진"
      },
      {
        id: "EXP-2026-002",
        title: "평일 오전 단체 방문객 보호자(인솔자) 대상 웰컴 티 패키지 시범 적용",
        topic: "보호자 웰컴 음료",
        hypothesis: "평일 단체 방문객 인솔자에게 웰컴 티를 제공하면 단체 재예약 의향이 증가할 것이다.",
        intervention: "유치원/어린이집 단체 방문 시 인솔 교사 및 보호자 대상 보온 보틀 웰컴 허브티 세트 제공.",
        target_cohort: "평일 오전 단체 인솔 교사 및 동반 학부모 (20명 이상 단체)",
        period: "2026-10-06 ~ 2026-10-08",
        methodology: "단순 전후 비교 (이전 주 평일 단체 vs 금주 평일 단체)",
        method_type: "before_after",
        metrics: [
          { name: "인솔자 체감 편의 만족도", control_value: "4.20 (전주)", experiment_value: "4.50 (금주)", delta: "+0.30점", trend: "positive" },
          { name: "차기 시즌 재예약 문의율", control_value: "28.5%", experiment_value: "35.7%", delta: "+7.2%p", trend: "positive" }
        ],
        sample_size: 42,
        sample_threshold: 30,
        is_sample_sufficient: true,
        evaluation_status: "observational_finding",
        evaluation_label: "관찰 결과 (단순 전후 비교)",
        cost_status: "cost_missing",
        cost_label: "비용 미입력 (수익성 미검증)",
        cost_warning: "보틀 포장재 및 티백 원가 미입력. 0원으로 계산하지 않으며 수익성 검증 미완료 상태.",
        results_summary: "수치상 만족도 및 재예약 문의가 증가했으나, 동시 진행된 가을 날씨 호조 및 요일별 단체 성격 차이 등 외생변수가 통제되지 않은 단순 관찰 결과임.",
        next_decision: "동일 요일 분할 배정 형태의 대조군(Control Group)을 포함한 정밀 A/B 테스트 재실행 권고.",
        decision_tag: "대조군 보완 재실험 권고"
      },
      {
        id: "EXP-2026-003",
        title: "우천 시 야외 대기 불가 환경에서의 핫티(Hot Tea) 즉시 전환 파일럿",
        topic: "보호자 웰컴 음료",
        hypothesis: "우천으로 야외 이용이 제한될 때 실내 핫티 음료를 즉시 제공하면 날씨로 인한 환불 요구가 감소할 것이다.",
        intervention: "우천 발령 시 매표 화면에서 웰컴 음료를 즉시 '따뜻한 대추사과차'로 변경 교부.",
        target_cohort: "우천 시간대 방문 가족 보호자",
        period: "2026-10-09 (우천 당일 4시간)",
        methodology: "A/B 테스트",
        method_type: "ab_test",
        metrics: [
          { name: "환불 요구율", control_value: "12.5%", experiment_value: "0.0%", delta: "-12.5%p", trend: "positive" },
          { name: "보호자 라운지 체류 만족도", control_value: "3.80", experiment_value: "4.40", delta: "+0.60점", trend: "positive" }
        ],
        sample_size: 8,
        sample_threshold: 30,
        is_sample_sufficient: false,
        evaluation_status: "pending_inconclusive",
        evaluation_label: "판단 보류 (표본 부족: N=8)",
        cost_status: "cost_missing",
        cost_label: "비용 미입력 (수익성 미검증)",
        cost_warning: "비용 데이터 누락. 0원으로 왜곡 처리 금지.",
        results_summary: "실험군 환불 0건 및 만족도 상승이 관측되었으나, 유효 표본이 8팀에 불과하여 통계적 유의성이 전혀 없음.",
        next_decision: "우천 일수 추가 누적으로 최소 표본(30팀) 도달 시까지 결론을 보류하고 추가 데이터 수집 유지.",
        decision_tag: "표본 누적 대기"
      }
    ],
    guidelines: [
      {
        id: "SOP-BP-007",
        title: "보호자 웰컴 음료 제공 운영 지침서 (타 현장 전파용)",
        version: "1.0",
        target_scene: "가족형 야외/실내 복합 레저 현장 (매표 및 대기 단계)",
        evidence_ref: "EXP-2026-001 (A/B 테스트 만족도 +0.55pt, 불만 -73.8% 실증)",
        prerequisites: [
          "F&B 카페 창구와 매표소 간 반경 30m 이내 접근 동선 확보",
          "주말 기준 카페 음료 제조 캐파 분당 최소 3~4잔 이상 가동 가능",
          "보호자 착석 가능 라운지 공간 최소 20석 이상 확보",
          "매표 POS에서 바우처 바코드 인쇄 또는 모바일 QR 전송 기능 구비"
        ],
        procedures: [
          { step: 1, role: "매표 데스크 직원", action: "현장 발권 완료 시 고객에게 '보호자 웰컴 음료 바우처(팀당 최대 2매)'를 교부하고 교환처(카페 라운지) 위치를 구두 안내한다." },
          { step: 2, role: "대기 안내 직원", action: "대기팀 5팀 초과 시 '아이들은 체험 대기 공간에서 준비하고, 보호자분은 웰컴 음료를 수령하여 라운지에서 대기'하도록 동선을 유도 분산한다." },
          { step: 3, role: "카페 F&B 바리스타", action: "웰컴 음료 전용 메뉴(사과 에이드/콜드브루) 2종을 상시 프리믹스하여 주문 후 30초 이내 신속 교부하고 바우처를 회수함에 투입한다." },
          { step: 4, role: "마감 정산 담당자", action: "매일 마감 시 매표소 발권 바우처 수량과 카페 회수 바우처 수량을 대사하여 '실교환율'을 일일 운영일지에 기록한다." }
        ],
        limitations: [
          "피크타임(14:00~16:00) 방문객 집중 시 카페 주문 대기열이 2차 병목을 유발할 위험 존재",
          "현재 음료 1잔당 제조 원가 및 부자재 비용이 미확정되어, 1인당 순이익 기여도(ROI) 검증이 미완료된 한계가 있음",
          "기상 상황(혹서기/혹한기)에 따라 아이스/핫 선호 편차가 극심하여 고정 단일 메뉴 적용 불가"
        ],
        reverification_items: [
          "타 현장(영주, 안동 등) 카페 카운터 제조 속도 및 동선 병목 여부 실측",
          "지역 로컬 특산 재료(예: 영주 풍기 인삼차, 안동 식혜 등) 활용 시의 원가율 및 유통기한 관리",
          "보호자 1인당 음료 수령 시 2차 유료 F&B 메뉴(디저트, 스낵 등) 추가 구매 전환율 실증",
          "동절기(11월~2월) 온음료 전환 시 보온 용기 수급 및 안전 화상 방지 규정 준수 여부"
        ]
      }
    ]
  };

  // 초기화
  document.addEventListener('DOMContentLoaded', function () {
    if (window.lucide) lucide.createIcons();
    initEventListeners();
    fetchData();
  });

  function initEventListeners() {
    // 탭 전환 이벤트
    ['quality', 'experiments', 'guidelines'].forEach(tab => {
      const btn = document.getElementById(`tabBtn_${tab}`);
      if (btn) btn.addEventListener('click', () => switchTab(tab));
    });

    // 새로고침 버튼
    const refreshBtn = document.getElementById('btnRefreshAll');
    if (refreshBtn) refreshBtn.addEventListener('click', () => fetchData());

    // 시나리오 버튼들
    const scenarioBtns = document.querySelectorAll('[data-scenario]');
    scenarioBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sc = btn.getAttribute('data-scenario');
        setScenario(sc);
      });
    });

    // 데이터 품질 필터 버튼들
    const qualityFilterBtns = document.querySelectorAll('[data-quality-filter]');
    qualityFilterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-quality-filter');
        setQualityFilter(filter);
      });
    });
  }

  // 탭 전환
  function switchTab(targetTab) {
    state.currentTab = targetTab;
    ['quality', 'experiments', 'guidelines'].forEach(tab => {
      const btn = document.getElementById(`tabBtn_${tab}`);
      const pane = document.getElementById(`tabPane_${tab}`);
      if (btn) {
        if (tab === targetTab) {
          btn.className = 'px-4 py-2.5 rounded-xl font-black text-xs sm:text-sm bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center gap-2 transition';
        } else {
          btn.className = 'px-4 py-2.5 rounded-xl font-bold text-xs sm:text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 flex items-center gap-2 transition';
        }
      }
      if (pane) {
        if (tab === targetTab) pane.classList.remove('hidden');
        else pane.classList.add('hidden');
      }
    });

    renderCurrentView();
  }

  // 시나리오 설정
  async function setScenario(scenario) {
    state.activeScenario = scenario;
    updateScenarioBadgeUI(scenario);

    // 서버로 시나리오 변경 요청 시도
    try {
      await fetch('/api/evidence/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario })
      });
    } catch (e) {
      console.warn('Backend scenario API not reachable, running client-side simulation:', e);
    }

    // 데이터 재조회
    await fetchData();
  }

  function updateScenarioBadgeUI(sc) {
    const badge = document.getElementById('activeScenarioBadge');
    if (!badge) return;
    const labels = {
      normal: '정상 운용',
      empty: '빈 자료 (0건)',
      delay: '지연 (1.5s)',
      fail: '조회 실패 (500)',
      duplicate: '중복 자료 감지'
    };
    const colors = {
      normal: 'bg-emerald-950 text-emerald-400 border-emerald-800',
      empty: 'bg-slate-800 text-slate-300 border-slate-700',
      delay: 'bg-amber-950 text-amber-400 border-amber-800',
      fail: 'bg-rose-950 text-rose-300 border-rose-800',
      duplicate: 'bg-purple-950 text-purple-300 border-purple-800'
    };

    badge.className = `px-2.5 py-1 rounded-full text-xs font-black border ${colors[sc] || colors.normal}`;
    badge.textContent = `시나리오: ${labels[sc] || sc}`;
  }

  // 데이터 조회
  async function fetchData() {
    state.isLoading = true;
    state.fetchError = null;
    showLoadingUI(true);

    try {
      // 1. 서버 API 호출 시도
      const res = await fetch('/api/evidence/all', {
        headers: { 'Accept': 'application/json' }
      });

      if (!res.ok) {
        throw new Error(`서버 응답 오류 (HTTP ${res.status})`);
      }

      const json = await res.json();
      if (!json || !json.ok) {
        throw new Error(json?.message || '데이터 페이로드 수신 실패');
      }

      state.data = json;
      state.lastKnownGoodData = json;
      state.lastFetchedTime = new Date().toLocaleTimeString('ko-KR');
      state.fetchError = null;
    } catch (err) {
      console.warn('Fetch failed:', err);
      state.fetchError = err.message || '네트워크 연결 실패';

      // 실패 시나리오인 경우:
      if (state.activeScenario === 'fail') {
        state.data = null; // 실패 상태를 화면에 강제 반영
      } else if (!state.lastKnownGoodData) {
        // 서버가 아예 안 떠있을 때 client fallback
        state.data = FALLBACK_DATA;
        state.lastKnownGoodData = FALLBACK_DATA;
        state.lastFetchedTime = new Date().toLocaleTimeString('ko-KR');
        state.fetchError = null;
      }
    } finally {
      state.isLoading = false;
      showLoadingUI(false);
      updateHeaderStatusUI();
      renderCurrentView();
    }
  }

  function showLoadingUI(isLoading) {
    const spinner = document.getElementById('globalLoadingIndicator');
    if (spinner) {
      if (isLoading) spinner.classList.remove('hidden');
      else spinner.classList.add('hidden');
    }
  }

  function updateHeaderStatusUI() {
    const timeEl = document.getElementById('lastUpdatedTimeText');
    const statusBadge = document.getElementById('systemConnStatusBadge');
    const errorBanner = document.getElementById('globalErrorAlertBanner');

    if (timeEl) {
      timeEl.textContent = state.lastFetchedTime || '확인 불가 (조회 전)';
    }

    if (statusBadge) {
      if (state.fetchError || state.activeScenario === 'fail') {
        statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-950 border border-rose-800 text-[11px] font-bold text-rose-300';
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span><span>연결 장애 (확인 불가)</span>';
      } else {
        statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-800 text-[11px] font-bold text-slate-400';
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>실시간 연결됨</span>';
      }
    }

    if (errorBanner) {
      if (state.fetchError || state.activeScenario === 'fail') {
        errorBanner.classList.remove('hidden');
        const errText = document.getElementById('globalErrorAlertText');
        if (errText) {
          errText.textContent = `데이터 파이프라인 장애: ${state.fetchError || '원장 서버 응답 없음'} (조회 실패를 0건으로 왜곡하지 않고 확인 불가 상태를 유지합니다)`;
        }
      } else {
        errorBanner.classList.add('hidden');
      }
    }
    if (window.lucide) lucide.createIcons();
  }

  // 현재 탭 렌더링
  function renderCurrentView() {
    if (state.currentTab === 'quality') renderQualityTab();
    else if (state.currentTab === 'experiments') renderExperimentsTab();
    else if (state.currentTab === 'guidelines') renderGuidelinesTab();
  }

  // -------------------------------------------------------------------------
  // 1. 데이터 품질 화면 (Data Quality Tab)
  // -------------------------------------------------------------------------
  function setQualityFilter(filter) {
    state.qualityFilter = filter;
    const filterBtns = document.querySelectorAll('[data-quality-filter]');
    filterBtns.forEach(btn => {
      const f = btn.getAttribute('data-quality-filter');
      if (f === filter) {
        btn.className = 'px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-black shadow transition';
      } else {
        btn.className = 'px-3 py-1.5 bg-slate-900 text-slate-400 hover:text-white border border-slate-800 rounded-xl text-xs font-bold transition';
      }
    });
    renderQualityTab();
  }

  function renderQualityTab() {
    const container = document.getElementById('qualityDatasetsContainer');
    const summaryCard = document.getElementById('qualitySummaryMetrics');
    const dupAlert = document.getElementById('duplicateAlertBanner');
    if (!container) return;

    // 실패 상태 처리: 조회 실패를 0건으로 표시하지 않음!
    if (state.activeScenario === 'fail' || (!state.data && state.fetchError)) {
      if (dupAlert) dupAlert.classList.add('hidden');
      if (summaryCard) {
        summaryCard.innerHTML = `
          <div class="col-span-full bg-rose-950/60 border border-rose-800/80 rounded-2xl p-5 text-rose-200">
            <div class="flex items-center gap-2 text-sm font-black text-rose-300">
              <i data-lucide="alert-triangle" class="w-5 h-5"></i>
              <span>데이터 파이프라인 조회 실패 (원장 확인 불가)</span>
            </div>
            <p class="text-xs text-rose-300/80 mt-1.5 leading-relaxed">
              조회 실패를 0건으로 표시하지 않습니다. 현재 원장 데이터베이스와의 통신이 단절되어 품질 통계를 산출할 수 없습니다.<br>
              마지막 정상 확인 시각: <strong class="font-mono text-white">${state.lastFetchedTime || '기록 없음'}</strong>
            </p>
          </div>
        `;
      }
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">데이터셋 품질 목록 조회 실패</p>
          <p class="text-xs text-slate-500">원장 연결이 복구되면 자동으로 실시간 품질 스냅샷이 갱신됩니다.</p>
          <button type="button" onclick="window.BongplayApp.fetchData()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-black rounded-xl border border-slate-700 transition">
            재시도 ↻
          </button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const datasets = state.data?.datasets || [];

    // 중복 자료 알림 검사
    const totalDuplicates = datasets.reduce((sum, d) => sum + (d.duplicate_records || 0), 0);
    if (dupAlert) {
      if (totalDuplicates > 0) {
        dupAlert.classList.remove('hidden');
        document.getElementById('duplicateCountBadge').textContent = `${totalDuplicates}건 중복 감지`;
      } else {
        dupAlert.classList.add('hidden');
      }
    }

    // 상단 4단계 카운트 계산
    const normalCount = datasets.filter(d => d.status === 'normal').length;
    const partialCount = datasets.filter(d => d.status === 'partial_missing').length;
    const staleCount = datasets.filter(d => d.status === 'stale').length;
    const unverifiableCount = datasets.filter(d => d.status === 'unverifiable').length;

    if (summaryCard) {
      summaryCard.innerHTML = `
        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <div class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span> 정상
            </div>
            <div class="text-2xl font-black text-emerald-400 mt-1 font-mono">${normalCount} <span class="text-xs text-slate-400 font-normal">종</span></div>
          </div>
          <i data-lucide="check-circle" class="w-6 h-6 text-emerald-500/40"></i>
        </div>

        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <div class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-amber-400"></span> 일부 누락
            </div>
            <div class="text-2xl font-black text-amber-400 mt-1 font-mono">${partialCount} <span class="text-xs text-slate-400 font-normal">종</span></div>
          </div>
          <i data-lucide="file-question" class="w-6 h-6 text-amber-500/40"></i>
        </div>

        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <div class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-orange-400"></span> 오래된 자료
            </div>
            <div class="text-2xl font-black text-orange-400 mt-1 font-mono">${staleCount} <span class="text-xs text-slate-400 font-normal">종</span></div>
          </div>
          <i data-lucide="clock" class="w-6 h-6 text-orange-500/40"></i>
        </div>

        <div class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between shadow-sm">
          <div>
            <div class="text-[11px] font-bold text-slate-400 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-rose-400"></span> 확인 불가
            </div>
            <div class="text-2xl font-black text-rose-400 mt-1 font-mono">${unverifiableCount} <span class="text-xs text-slate-400 font-normal">종</span></div>
          </div>
          <i data-lucide="alert-octagon" class="w-6 h-6 text-rose-500/40"></i>
        </div>
      `;
    }

    // 빈 자료 시나리오 처리
    if (datasets.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-2">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto text-slate-600"></i>
          <p class="text-sm font-bold text-slate-300">등록된 실증 데이터셋이 없습니다.</p>
          <p class="text-xs text-slate-500">데이터 파이프라인에서 수집된 원장 테이블이 없습니다. 상단 [정상] 시나리오를 선택해 확인하세요.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    // 필터링 적용
    let filtered = datasets;
    if (state.qualityFilter !== 'all') {
      filtered = datasets.filter(d => d.status === state.qualityFilter);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-8 text-center text-slate-400 space-y-1">
          <p class="text-xs font-bold text-slate-300">선택된 상태(${state.qualityFilter})의 데이터셋이 없습니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    // 카드 목록 렌더링
    container.innerHTML = filtered.map(d => {
      let badgeColor = 'bg-emerald-950 text-emerald-300 border-emerald-800';
      let statusIcon = 'check-circle';
      if (d.status === 'partial_missing') {
        badgeColor = 'bg-amber-950 text-amber-300 border-amber-800';
        statusIcon = 'file-question';
      } else if (d.status === 'stale') {
        badgeColor = 'bg-orange-950 text-orange-300 border-orange-800';
        statusIcon = 'clock';
      } else if (d.status === 'unverifiable') {
        badgeColor = 'bg-rose-950 text-rose-300 border-rose-800';
        statusIcon = 'alert-octagon';
      }

      // 레코드 건수 표시 (조회 실패 / 확인 불가 시 절대 0건으로 표시 금지)
      let recordDisplay = '확인 불가 (오류)';
      if (typeof d.total_records === 'number') {
        recordDisplay = `${d.total_records.toLocaleString()}건`;
      }

      const updatedStr = d.last_updated_at
        ? new Date(d.last_updated_at).toLocaleString('ko-KR')
        : '확인 불가 (수집 실패)';

      return `
        <div class="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl p-5 shadow-sm space-y-3 transition">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800/80">
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-black text-white">${escapeHtml(d.name)}</h3>
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  ${escapeHtml(d.table_name)}
                </span>
              </div>
              <p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(d.category)}</p>
            </div>
            
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-black border ${badgeColor}">
                <i data-lucide="${statusIcon}" class="w-3.5 h-3.5"></i>
                <span>${escapeHtml(d.status_label)}</span>
              </span>
            </div>
          </div>

          <p class="text-xs text-slate-300 leading-relaxed">${escapeHtml(d.description)}</p>

          <!-- 세부 지표 그리드 -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">총 레코드 수</span>
              <p class="font-mono font-black text-slate-200 mt-0.5">${recordDisplay}</p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">결손치 수</span>
              <p class="font-mono font-black ${d.missing_records > 0 ? 'text-amber-400' : 'text-slate-300'} mt-0.5">
                ${d.missing_records !== null ? `${d.missing_records}건` : '확인 불가'}
              </p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">자료 지연 경과</span>
              <p class="font-mono font-black ${d.staleness_hours > 24 ? 'text-orange-400' : 'text-slate-300'} mt-0.5">
                ${d.staleness_hours !== null ? `${d.staleness_hours}시간` : '확인 불가'}
              </p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">중복 레코드</span>
              <p class="font-mono font-black ${d.duplicate_records > 0 ? 'text-purple-400' : 'text-slate-300'} mt-0.5">
                ${d.duplicate_records !== null ? `${d.duplicate_records}건` : '확인 불가'}
              </p>
            </div>
          </div>

          <!-- 품질 판정 요약 -->
          <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-800/80 text-[11px] text-slate-300 leading-snug">
            <div class="flex items-center gap-1.5 font-bold text-slate-200 mb-1">
              <i data-lucide="info" class="w-3.5 h-3.5 text-indigo-400"></i>
              <span>품질 판정 가이드</span>
            </div>
            <p>${escapeHtml(d.quality_summary)}</p>
          </div>

          <div class="flex items-center justify-between text-[10px] text-slate-500 pt-1">
            <span>마지막 갱신: <span class="font-mono text-slate-400 font-bold">${updatedStr}</span></span>
            <span>데이터 파이프라인 무결성 점검</span>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  // -------------------------------------------------------------------------
  // 2. 실험 카드 (Experiment Cards Tab)
  // -------------------------------------------------------------------------
  function renderExperimentsTab() {
    const container = document.getElementById('experimentsContainer');
    if (!container) return;

    if (state.activeScenario === 'fail' || (!state.data && state.fetchError)) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">운영 실험 카드 조회 실패 (확인 불가)</p>
          <p class="text-xs text-slate-500">조회 실패를 0건으로 왜곡하지 않으며, 원장 연결 시 재표출됩니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const experiments = state.data?.experiments || [];
    if (experiments.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-2">
          <i data-lucide="flask-conical-off" class="w-8 h-8 mx-auto text-slate-600"></i>
          <p class="text-sm font-bold text-slate-300">등록된 운영 실험 카드가 없습니다.</p>
          <p class="text-xs text-slate-500">현재 등록된 운영 실험이 비어 있습니다. 상단 [정상] 시나리오를 선택하세요.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = experiments.map(exp => {
      // 1) 표본 부족 판정 뱃지
      let evalBadge = '';
      if (exp.evaluation_status === 'pending_inconclusive') {
        evalBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-rose-950 text-rose-300 border border-rose-800">판단 보류 (표본 부족)</span>';
      } else if (exp.evaluation_status === 'observational_finding') {
        evalBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-amber-950 text-amber-300 border border-amber-800">관찰 결과 (단순 전후 비교)</span>';
      } else {
        evalBadge = '<span class="px-2.5 py-1 rounded-full text-xs font-black bg-emerald-950 text-emerald-300 border border-emerald-800">가설 지지 (개선 확인)</span>';
      }

      // 2) 비용 미입력 경고 뱃지 (0원 왜곡 차단 필수 규칙)
      let costBadge = '';
      if (exp.cost_status === 'cost_missing') {
        costBadge = `
          <div class="bg-amber-950/60 border border-amber-700/80 rounded-xl p-3 text-xs text-amber-200">
            <div class="flex items-center gap-1.5 font-bold text-amber-300 mb-0.5">
              <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>
              <span>비용 미입력 (수익성 미검증 / ROI 산정 보류)</span>
            </div>
            <p class="text-[11px] text-amber-200/90 leading-snug">${escapeHtml(exp.cost_warning)}</p>
          </div>
        `;
      }

      // 지표 테이블
      const metricsHtml = exp.metrics.map(m => `
        <tr class="border-b border-slate-800/60">
          <td class="py-2 px-3 text-slate-300">${escapeHtml(m.name)}</td>
          <td class="py-2 px-3 font-mono text-slate-400">${escapeHtml(m.control_value)}</td>
          <td class="py-2 px-3 font-mono font-bold text-white">${escapeHtml(m.experiment_value)}</td>
          <td class="py-2 px-3 font-mono font-black ${m.trend === 'positive' ? 'text-emerald-400' : 'text-slate-300'}">
            ${escapeHtml(m.delta)}
          </td>
        </tr>
      `).join('');

      return `
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl space-y-4">
          <!-- 카드 헤더 -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
            <div>
              <div class="flex items-center gap-2">
                <span class="px-2.5 py-0.5 rounded-lg text-xs font-black bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  ${exp.id}
                </span>
                <span class="text-xs font-bold text-slate-400">예시 주제: ${escapeHtml(exp.topic)}</span>
              </div>
              <h3 class="text-base sm:text-lg font-black text-white mt-1">${escapeHtml(exp.title)}</h3>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              ${evalBadge}
            </div>
          </div>

          <!-- 가설 & 변경 내용 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div class="bg-slate-950/70 p-3.5 rounded-2xl border border-slate-800">
              <span class="text-[10px] font-bold text-indigo-400 uppercase tracking-wider block mb-1">가설 (Hypothesis)</span>
              <p class="text-slate-200 leading-relaxed">${escapeHtml(exp.hypothesis)}</p>
            </div>
            <div class="bg-slate-950/70 p-3.5 rounded-2xl border border-slate-800">
              <span class="text-[10px] font-bold text-sky-400 uppercase tracking-wider block mb-1">변경 내용 (Intervention)</span>
              <p class="text-slate-200 leading-relaxed">${escapeHtml(exp.intervention)}</p>
            </div>
          </div>

          <!-- 실험 메타 속성 -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">대상 (Target)</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${escapeHtml(exp.target_cohort)}</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">기간 (Period)</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${escapeHtml(exp.period)}</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">비교 방식</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${escapeHtml(exp.methodology)}</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">표본 수 (Sample Size)</span>
              <p class="font-bold font-mono ${exp.is_sample_sufficient ? 'text-emerald-400' : 'text-rose-400'} mt-0.5">
                N = ${exp.sample_size}팀 ${exp.is_sample_sufficient ? '(충분)' : '(기준 미달)'}
              </p>
            </div>
          </div>

          <!-- 지표 테이블 -->
          <div class="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="bg-slate-950 border-b border-slate-800 text-slate-400">
                  <th class="py-2 px-3 font-semibold">측정 지표</th>
                  <th class="py-2 px-3 font-semibold">대조군(기준치)</th>
                  <th class="py-2 px-3 font-semibold">실험군(개입치)</th>
                  <th class="py-2 px-3 font-semibold">변화폭(Delta)</th>
                </tr>
              </thead>
              <tbody>
                ${metricsHtml}
              </tbody>
            </table>
          </div>

          <!-- 비용 상태 알림 -->
          ${costBadge}

          <!-- 결과 및 다음 결정 -->
          <div class="bg-slate-950/90 rounded-2xl p-4 border border-slate-800 space-y-2 text-xs">
            <div>
              <span class="text-[10px] font-bold text-slate-400 block mb-0.5">실험 결과 요약</span>
              <p class="text-slate-200 leading-relaxed">${escapeHtml(exp.results_summary)}</p>
            </div>
            <div class="pt-2 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span class="text-[10px] font-bold text-indigo-400 block">다음 결정 (Next Decision)</span>
                <p class="text-white font-bold mt-0.5">${escapeHtml(exp.next_decision)}</p>
              </div>
              <span class="self-start sm:self-auto px-2.5 py-1 rounded-lg bg-indigo-900/60 border border-indigo-700 text-indigo-200 font-black text-[11px] shrink-0">
                ${escapeHtml(exp.decision_tag)}
              </span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  // -------------------------------------------------------------------------
  // 3. 운영 지침 화면 (Guidelines / SOP Tab)
  // -------------------------------------------------------------------------
  function renderGuidelinesTab() {
    const container = document.getElementById('guidelinesContainer');
    if (!container) return;

    if (state.activeScenario === 'fail' || (!state.data && state.fetchError)) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">운영 지침서 조회 실패 (확인 불가)</p>
          <p class="text-xs text-slate-500">원장 연결 복구 후 자동으로 지침서가 동기화됩니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const guidelines = state.data?.guidelines || [];
    if (guidelines.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-400 space-y-2">
          <i data-lucide="book-open" class="w-8 h-8 mx-auto text-slate-600"></i>
          <p class="text-sm font-bold text-slate-300">등록된 현장 운영 지침서가 없습니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = guidelines.map(g => {
      const prereqHtml = g.prerequisites.map(p => `
        <li class="flex items-start gap-2">
          <i data-lucide="check" class="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(p)}</span>
        </li>
      `).join('');

      const stepsHtml = g.procedures.map(st => `
        <div class="flex items-start gap-3 bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800">
          <div class="w-6 h-6 rounded-lg bg-indigo-600 text-white font-mono font-black text-xs flex items-center justify-center shrink-0">
            ${st.step}
          </div>
          <div>
            <span class="text-[10px] font-bold text-indigo-400 block">${escapeHtml(st.role)}</span>
            <p class="text-xs text-slate-200 mt-0.5 leading-relaxed">${escapeHtml(st.action)}</p>
          </div>
        </div>
      `).join('');

      const limitsHtml = g.limitations.map(l => `
        <li class="flex items-start gap-2 text-rose-200/90">
          <i data-lucide="alert-circle" class="w-4 h-4 text-rose-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(l)}</span>
        </li>
      `).join('');

      const reverifyHtml = g.reverification_items.map(r => `
        <li class="flex items-start gap-2 text-sky-200/90">
          <i data-lucide="repeat" class="w-4 h-4 text-sky-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(r)}</span>
        </li>
      `).join('');

      return `
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-7 shadow-xl space-y-6">
          <!-- 헤더 -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
            <div>
              <div class="flex items-center gap-2">
                <span class="px-2.5 py-0.5 rounded-lg text-xs font-black bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  ${g.id}
                </span>
                <span class="text-xs text-slate-400">Ver ${g.version} · 타 현장 전파용 표준 지침</span>
              </div>
              <h2 class="text-lg sm:text-xl font-black text-white mt-1">${escapeHtml(g.title)}</h2>
              <p class="text-xs text-slate-400 mt-0.5">적용 대상: ${escapeHtml(g.target_scene)}</p>
            </div>
            
            <div class="bg-slate-950 p-2.5 rounded-xl border border-slate-800 text-xs shrink-0">
              <span class="text-[10px] text-slate-400 block">실증 근거 (Evidence Base)</span>
              <span class="font-bold text-indigo-300 font-mono">${escapeHtml(g.evidence_ref)}</span>
            </div>
          </div>

          <!-- 1. 적용 조건 -->
          <div class="space-y-2">
            <h4 class="text-xs font-black text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <i data-lucide="shield-check" class="w-4 h-4 text-emerald-400"></i>
              <span>1. 사전 적용 필수 조건 (Prerequisites)</span>
            </h4>
            <ul class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300 bg-slate-950/40 p-4 rounded-2xl border border-slate-800/80">
              ${prereqHtml}
            </ul>
          </div>

          <!-- 2. 실행 절차 -->
          <div class="space-y-2.5">
            <h4 class="text-xs font-black text-slate-200 uppercase tracking-wider flex items-center gap-1.5">
              <i data-lucide="list-ordered" class="w-4 h-4 text-indigo-400"></i>
              <span>2. 표준 실행 절차 (SOP Procedure)</span>
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              ${stepsHtml}
            </div>
          </div>

          <!-- 3. 한계 & 다른 현장에서 재검증할 항목 -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- 한계 -->
            <div class="bg-rose-950/20 border border-rose-900/60 rounded-2xl p-4 space-y-2">
              <h5 class="text-xs font-black text-rose-300 flex items-center gap-1.5">
                <i data-lucide="alert-triangle" class="w-4 h-4 text-rose-400"></i>
                <span>3. 제도적·운영적 한계 (Limitations)</span>
              </h5>
              <ul class="space-y-1.5 text-xs">
                ${limitsHtml}
              </ul>
            </div>

            <!-- 타 현장 재검증 -->
            <div class="bg-sky-950/20 border border-sky-900/60 rounded-2xl p-4 space-y-2">
              <h5 class="text-xs font-black text-sky-300 flex items-center gap-1.5">
                <i data-lucide="compass" class="w-4 h-4 text-sky-400"></i>
                <span>4. 타 현장 전파 시 재검증 항목 (Re-verification)</span>
              </h5>
              <ul class="space-y-1.5 text-xs">
                ${reverifyHtml}
              </ul>
            </div>
          </div>

        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  // XSS 방지 유틸
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 전역 노출 (HTML 인라인 호출용)
  window.BongplayApp = {
    fetchData,
    switchTab,
    setScenario,
    setQualityFilter
  };

})();

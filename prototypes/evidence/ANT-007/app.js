/**
 * prototypes/evidence/ANT-007/app.js
 * 
 * 리플레이스 실증 데이터 시제품 (ANT-007 / BEN-026 R2) 프런트엔드 애플리케이션 로직
 * 
 * 벤 R1 검토 반영 핵심 규칙:
 * 1. 최초 조회 실패 fallback 수정:
 *    - 네트워크 오류/HTTP500 발생 시 예제 자료를 채우고 fetchError를 지워 '실시간 연결됨'으로 왜곡하던 문제 원천 차단.
 *    - 오프라인 예제 모드는 수동 명시 모드로 분리(실서버 미연결 명시).
 *    - 실패 시 마지막 성공 시각, 오래된 자료(캐시 유지 시), 확인 불가(초기 실패 시)를 모든 탭에 일관되게 표시.
 *    - 요청 제한시간(AbortController 4s) 적용 및 시퀀스 ID 기반 오래된 응답 덮어쓰기(Race Condition) 방지.
 * 2. 실험 판정 수정:
 *    - A/B 명칭이나 임의 표본만으로 개선/유의성/성공을 확정하지 않음.
 *    - 사전 표본 계획 부재 시 '판단 보류 (사전 표본 계획 부재)', 표본 충족 시에도 '검토 가능 (합성 자료 관찰)'으로 표기.
 *    - 합성 결과 · 운영 승인 · 타 현장 재현 3단계 분리.
 *    - 비용 null / 0 / 값 구분 및 수익성 판단 전면 제외.
 *    - FALLBACK_DATA 이중 관리 제거 (단일 원천: /api/evidence/*).
 * 3. 중복 집계 3대 범주 분류:
 *    - 동일 ID·동일 내용 재전송(멱등 필터링), 동일 ID·다른 내용 충돌(무결성 격리), 별개 사건(정상 집계).
 */

(function () {
  'use strict';

  // 상태 관리 객체
  const state = {
    currentTab: 'quality', // 'quality' | 'experiments' | 'guidelines'
    activeScenario: 'normal',
    activeCostMode: 'default', // 'default' | 'null' | 'zero' | 'valued'
    activeZeroDenom: false,
    activeSamplePlanMode: 'default', // 'default' | 'unplanned'
    data: null,
    lastKnownGoodData: null,
    lastSuccessTime: null,
    isLoading: false,
    fetchError: null,
    connectionStatus: 'init', // 'connected' | 'error' | 'offline_demo'
    isOfflineDemoMode: false,
    qualityFilter: 'all', // 'all' | 'normal' | 'partial_missing' | 'stale' | 'unverifiable'
    requestSeq: 0
  };

  // 초기화
  document.addEventListener('DOMContentLoaded', function () {
    if (window.lucide) lucide.createIcons();
    initEventListeners();
    fetchData();
  });

  function initEventListeners() {
    // 탭 전환 버튼
    ['quality', 'experiments', 'guidelines'].forEach(tab => {
      const btn = document.getElementById(`tabBtn_${tab}`);
      if (btn) btn.addEventListener('click', () => switchTab(tab));
    });

    // 새로고침 버튼
    const refreshBtn = document.getElementById('btnRefreshAll');
    if (refreshBtn) refreshBtn.addEventListener('click', () => fetchData());

    // 기본 시나리오 버튼들
    const scenarioBtns = document.querySelectorAll('[data-scenario]');
    scenarioBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const sc = btn.getAttribute('data-scenario');
        setScenario(sc);
      });
    });

    // 엣지 케이스: 비용 모드 버튼들
    const costBtns = document.querySelectorAll('[data-edge-cost]');
    costBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-edge-cost');
        state.activeCostMode = (state.activeCostMode === mode) ? 'default' : mode;
        updateEdgeToolbarUI();
        fetchData();
      });
    });

    // 엣지 케이스: 분모 0 토글
    const zeroDenomBtn = document.querySelector('[data-edge-zero-denom]');
    if (zeroDenomBtn) {
      zeroDenomBtn.addEventListener('click', () => {
        state.activeZeroDenom = !state.activeZeroDenom;
        updateEdgeToolbarUI();
        fetchData();
      });
    }

    // 엣지 케이스: 표본 계획 미정 토글
    const samplePlanBtn = document.querySelector('[data-edge-sample-plan]');
    if (samplePlanBtn) {
      samplePlanBtn.addEventListener('click', () => {
        state.activeSamplePlanMode = (state.activeSamplePlanMode === 'unplanned') ? 'default' : 'unplanned';
        updateEdgeToolbarUI();
        fetchData();
      });
    }

    // 엣지 케이스: 오래된 응답 경합 시험 버튼
    const raceBtn = document.getElementById('btnRaceTest');
    if (raceBtn) {
      raceBtn.addEventListener('click', () => triggerRaceConditionTest());
    }

    // 오프라인 예제 모드 수동 전환 버튼
    const offlineBtn = document.getElementById('btnEnterOfflineDemo');
    if (offlineBtn) {
      offlineBtn.addEventListener('click', () => enableOfflineDemoMode());
    }

    // 데이터 품질 필터 버튼들
    const qualityFilterBtns = document.querySelectorAll('[data-quality-filter]');
    qualityFilterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-quality-filter');
        setQualityFilter(filter);
      });
    });
  }

  function updateEdgeToolbarUI() {
    // 비용 버튼 스타일 갱신
    document.querySelectorAll('[data-edge-cost]').forEach(btn => {
      const mode = btn.getAttribute('data-edge-cost');
      if (state.activeCostMode === mode) {
        btn.className = 'px-2 py-0.5 rounded-lg bg-amber-600 text-white font-black text-[10px] border border-amber-400 transition';
      } else {
        btn.className = 'px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 font-bold text-[10px] transition';
      }
    });

    // 분모 0 버튼 스타일 갱신
    const zeroDenomBtn = document.querySelector('[data-edge-zero-denom]');
    if (zeroDenomBtn) {
      if (state.activeZeroDenom) {
        zeroDenomBtn.className = 'px-2 py-0.5 rounded-lg bg-rose-600 text-white font-black text-[10px] border border-rose-400 transition';
      } else {
        zeroDenomBtn.className = 'px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 font-bold text-[10px] transition';
      }
    }

    // 표본 계획 미정 버튼 스타일 갱신
    const samplePlanBtn = document.querySelector('[data-edge-sample-plan]');
    if (samplePlanBtn) {
      if (state.activeSamplePlanMode === 'unplanned') {
        samplePlanBtn.className = 'px-2 py-0.5 rounded-lg bg-purple-600 text-white font-black text-[10px] border border-purple-400 transition';
      } else {
        samplePlanBtn.className = 'px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 font-bold text-[10px] transition';
      }
    }
  }

  // 탭 전환
  function switchTab(targetTab) {
    state.currentTab = targetTab;
    ['quality', 'experiments', 'guidelines'].forEach(tab => {
      const btn = document.getElementById(`tabBtn_${tab}`);
      const pane = document.getElementById(`tabPane_${tab}`);
      if (btn) {
        if (tab === targetTab) {
          btn.className = 'px-3.5 py-2.5 rounded-xl font-black text-xs sm:text-sm bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 flex items-center gap-2 transition shrink-0';
        } else {
          btn.className = 'px-3.5 py-2.5 rounded-xl font-bold text-xs sm:text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 flex items-center gap-2 transition shrink-0';
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
        body: JSON.stringify({
          scenario,
          cost_mode: state.activeCostMode,
          zero_denom: state.activeZeroDenom,
          sample_plan: state.activeSamplePlanMode
        })
      });
    } catch (e) {
      console.warn('Backend scenario API unreachable:', e);
    }

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

  // 데이터 조회 (타임아웃 + 시퀀스 기반 오래된 응답 덮어쓰기 방지)
  async function fetchData(options = {}) {
    const thisSeq = ++state.requestSeq;
    state.isLoading = true;
    showLoadingUI(true);

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 4000;
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    // 쿼리 파라미터 조합
    const url = new URL('/api/evidence/all', window.location.origin);
    if (state.activeScenario) url.searchParams.set('scenario', state.activeScenario);
    if (state.activeCostMode !== 'default') url.searchParams.set('cost', state.activeCostMode);
    if (state.activeZeroDenom) url.searchParams.set('zero_denom', '1');
    if (state.activeSamplePlanMode !== 'default') url.searchParams.set('sample_plan', state.activeSamplePlanMode);

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`원장 서버 응답 오류 (HTTP ${res.status})`);
      }

      const json = await res.json();
      if (!json || !json.ok) {
        throw new Error(json?.message || '원장 데이터 무결성 검증 실패');
      }

      // [Race Condition Guard] 요청 시퀀스 불일치 시 이전 지연 응답 폐기
      if (thisSeq !== state.requestSeq) {
        console.warn(`[RaceCondition] 오래된 응답(#${thisSeq})이 최신 요청(#${state.requestSeq})에 의해 폐기되었습니다.`);
        return;
      }

      // 정상 수신 완료
      state.data = json;
      state.lastKnownGoodData = json;
      state.lastSuccessTime = new Date().toLocaleTimeString('ko-KR', { hour12: false });
      state.fetchError = null;
      state.connectionStatus = 'connected';
      state.isOfflineDemoMode = false;

    } catch (err) {
      clearTimeout(timeoutId);

      // [Race Condition Guard]
      if (thisSeq !== state.requestSeq) {
        console.warn(`[RaceCondition] 구 요청(#${thisSeq}) 에러 무시됨.`);
        return;
      }

      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout
        ? '원장 서버 응답 제한시간(4초) 초과'
        : (err.message || '네트워크 연결 단절');

      state.fetchError = errMsg;
      state.connectionStatus = 'error';
      state.isOfflineDemoMode = false;

      // 실패 시나리오이거나 최초 조회 실패(lastKnownGoodData 부재) 시:
      if (state.activeScenario === 'fail' || !state.lastKnownGoodData) {
        state.data = null; // 절대 예제 데이터로 대체하여 '실시간 연결됨'으로 속이지 않음!
      } else {
        // 기존 성공 데이터가 있으면 유지하되, 화면에 '오래된 자료(캐시)'로 강력 표기
        state.data = state.lastKnownGoodData;
      }

    } finally {
      if (thisSeq === state.requestSeq) {
        state.isLoading = false;
        showLoadingUI(false);
        updateHeaderStatusUI();
        renderCurrentView();
      }
    }
  }

  // 오래된 응답 경합(Race Condition) 시험
  function triggerRaceConditionTest() {
    alert('오래된 지연 응답이 최신 정상 응답을 덮어쓰지 못하도록 시퀀스 가드를 시험합니다.\n(1. 지연 요청 발송 후 즉시 2. 정상 요청 발송)');
    // 1차 지연 요청
    fetchData({ timeoutMs: 5000 });
    // 200ms 후 최신 정상 요청 발송 -> 1차 응답이 도착해도 폐기되어 최신 상태가 유지됨
    setTimeout(() => {
      fetchData();
    }, 200);
  }

  // 수동 오프라인 예제 모드 진입
  function enableOfflineDemoMode() {
    state.isOfflineDemoMode = true;
    state.connectionStatus = 'offline_demo';
    state.fetchError = null;

    // 최소 모의 데이터 로드
    state.data = {
      meta: {
        system: "오프라인 모의 예제 환경 (실서버 미연결)",
        version: "1.1.0-offline",
        is_synthetic: true
      },
      datasets: [
        {
          id: "ds_demo_visit",
          name: "[오프라인 예제] 보호자 방문 로그",
          table_name: "demo_visit_log",
          category: "오프라인 모의",
          status: "normal",
          status_label: "정상 (모의)",
          total_records: 100,
          valid_records: 100,
          missing_records: 0,
          duplicate_records: 0,
          last_updated_at: new Date().toISOString(),
          description: "네트워크 단절 시 화면 구조 확인을 위한 단독 모의 예제입니다.",
          quality_summary: "오프라인 예제 상태: 실제 서버 연결 상태가 아닙니다."
        }
      ],
      experiments: [],
      guidelines: [],
      duplicate_analysis: {
        total_ingested: 100,
        unique_events: 100,
        duplicate_categories: {}
      }
    };

    updateHeaderStatusUI();
    renderCurrentView();
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
    const errText = document.getElementById('globalErrorAlertText');

    if (timeEl) {
      timeEl.textContent = state.lastSuccessTime || '없음 (확인 불가)';
    }

    if (statusBadge) {
      if (state.connectionStatus === 'connected') {
        statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950 border border-emerald-800 text-[11px] font-bold text-emerald-300';
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>실시간 연결됨</span>';
      } else if (state.connectionStatus === 'offline_demo') {
        statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-950 border border-amber-800 text-[11px] font-bold text-amber-300';
        statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400"></span><span>오프라인 예제 모드 (실서버 미연결)</span>';
      } else {
        // error 상태
        const isStaleCache = Boolean(state.lastKnownGoodData && state.data);
        statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-950 border border-rose-800 text-[11px] font-bold text-rose-300';
        statusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span><span>연결 장애 (${isStaleCache ? '오래된 자료 유지' : '확인 불가'})</span>`;
      }
    }

    if (errorBanner) {
      if (state.connectionStatus === 'error' || state.activeScenario === 'fail') {
        errorBanner.classList.remove('hidden');
        if (errText) {
          const isStaleCache = Boolean(state.lastKnownGoodData && state.data);
          if (isStaleCache) {
            errText.textContent = `원장 서버 연결 장애: ${state.fetchError || '응답 오류'} (마지막 정상 수신: ${state.lastSuccessTime} 자료 유지 중)`;
          } else {
            errText.textContent = `원장 서버 최초 연결 실패: ${state.fetchError || '통신 단절'} (조회 실패를 0건으로 왜곡하지 않고 확인 불가 유지)`;
          }
        }
      } else {
        errorBanner.classList.add('hidden');
      }
    }

    if (window.lucide) lucide.createIcons();
  }

  // 현재 탭 렌더링
  function renderCurrentView() {
    renderTabStatusNotice('quality');
    renderTabStatusNotice('experiments');
    renderTabStatusNotice('guidelines');

    if (state.currentTab === 'quality') renderQualityTab();
    else if (state.currentTab === 'experiments') renderExperimentsTab();
    else if (state.currentTab === 'guidelines') renderGuidelinesTab();
  }

  // 모든 탭 상단에 일관된 장애 및 캐시 상태 안내 카드 렌더링
  function renderTabStatusNotice(tab) {
    const el = document.getElementById(`${tab}TabStatusNotice`);
    if (!el) return;

    if (state.connectionStatus === 'error' || state.activeScenario === 'fail') {
      const isStaleCache = Boolean(state.lastKnownGoodData && state.data);
      if (isStaleCache) {
        el.innerHTML = `
          <div class="bg-amber-950/70 border border-amber-800/90 rounded-2xl p-4 text-xs text-amber-200 flex items-start gap-3 shadow-md">
            <i data-lucide="clock-alert" class="w-5 h-5 text-amber-400 shrink-0 mt-0.5"></i>
            <div class="min-w-0">
              <strong class="font-bold text-amber-300 block text-sm">⚠️ 원장 서버 통신 장애: 오래된 자료(캐시) 표시 중</strong>
              <p class="text-[11px] text-amber-200/90 mt-1 leading-relaxed">
                최신 실시간 스냅샷을 가져오지 못하여 직전 정상 수신된 자료를 임시 표시하고 있습니다.<br>
                마지막 성공 시각: <span class="font-mono font-bold text-white">${state.lastSuccessTime || '확인 불가'}</span> | 오류 사유: <span class="font-mono text-rose-300">${state.fetchError || '서버 무응답'}</span>
              </p>
            </div>
          </div>
        `;
      } else {
        el.innerHTML = `
          <div class="bg-rose-950/80 border border-rose-800 rounded-2xl p-4 text-xs text-rose-200 flex items-start gap-3 shadow-md">
            <i data-lucide="alert-triangle" class="w-5 h-5 text-rose-400 shrink-0 mt-0.5"></i>
            <div class="min-w-0">
              <strong class="font-bold text-rose-300 block text-sm">❌ 원장 서버 최초 연결 실패: 자료 확인 불가</strong>
              <p class="text-[11px] text-rose-200/90 mt-1 leading-relaxed">
                원장 서버와의 최초 통신에 실패하여 정상 자료를 수신하지 못했습니다.<br>
                규칙 준수: <strong>조회 실패를 0건으로 왜곡하지 않으며 '확인 불가' 상태를 유지합니다.</strong><br>
                마지막 성공 시각: <span class="font-mono font-bold text-white">기록 없음</span>
              </p>
            </div>
          </div>
        `;
      }
    } else {
      el.innerHTML = '';
    }
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

    // 초기 실패 상태 (자료 자체가 없음)
    if (!state.data) {
      if (dupAlert) dupAlert.classList.add('hidden');
      if (summaryCard) {
        summaryCard.innerHTML = `
          <div class="col-span-full bg-slate-900/80 border border-slate-800 rounded-2xl p-6 text-center text-slate-400 space-y-2">
            <i data-lucide="database-zap" class="w-7 h-7 mx-auto text-rose-400"></i>
            <p class="text-xs font-bold text-rose-300">품질 요약 지표 산출 불가 (원장 미수신 상태)</p>
            <p class="text-[11px] text-slate-500">원장 연결 실패 시 0건 집계 왜곡을 원천 차단하기 위해 지표 카드를 비활성화합니다.</p>
          </div>
        `;
      }
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">원장 데이터셋 품질 목록 확인 불가</p>
          <p class="text-xs text-slate-500">원장 연결이 복구되면 자동으로 실시간 스냅샷을 수신합니다.</p>
          <button type="button" onclick="window.BongplayApp.fetchData()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-black rounded-xl border border-slate-700 transition">
            재시도 ↻
          </button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const datasets = state.data?.datasets || [];

    // 중복 자료 알림 검사 (3대 분류 배너)
    const dupInfo = state.data?.duplicate_analysis?.duplicate_categories;
    if (dupAlert) {
      if (dupInfo && (dupInfo.same_id_same_content?.count > 0 || dupInfo.same_id_diff_content?.count > 0)) {
        dupAlert.classList.remove('hidden');
        const detailContainer = document.getElementById('duplicateDetailsContainer');
        if (detailContainer) {
          detailContainer.innerHTML = `
            <span class="px-2 py-0.5 rounded bg-purple-900 text-purple-200 border border-purple-700">
              1. 동일 내용 재전송: <strong>${dupInfo.same_id_same_content.count}건 (멱등 필터링)</strong>
            </span>
            <span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800">
              2. 다른 내용 충돌: <strong>${dupInfo.same_id_diff_content.count}건 (무결성 격리)</strong>
            </span>
            <span class="px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-700">
              3. 별개 독립 사건: <strong>${dupInfo.distinct_events.count}건 (정상 집계)</strong>
            </span>
          `;
        }
      } else {
        dupAlert.classList.add('hidden');
      }
    }

    // 4단계 카운트 계산
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

    // 필터링 적용
    const filtered = (state.qualityFilter === 'all')
      ? datasets
      : datasets.filter(d => d.status === state.qualityFilter);

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-2">
          <i data-lucide="folder-search" class="w-7 h-7 mx-auto text-slate-600"></i>
          <p class="text-xs font-bold text-slate-300">해당 조건에 일치하는 데이터셋이 없습니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = filtered.map(d => {
      let badgeColor = 'bg-slate-800 text-slate-300 border-slate-700';
      let icon = 'check-circle';
      if (d.status === 'normal') {
        badgeColor = 'bg-emerald-950 text-emerald-300 border-emerald-800';
        icon = 'check-circle';
      } else if (d.status === 'partial_missing') {
        badgeColor = 'bg-amber-950 text-amber-300 border-amber-800';
        icon = 'file-question';
      } else if (d.status === 'stale') {
        badgeColor = 'bg-orange-950 text-orange-300 border-orange-800';
        icon = 'clock';
      } else if (d.status === 'unverifiable') {
        badgeColor = 'bg-rose-950 text-rose-300 border-rose-800';
        icon = 'alert-octagon';
      }

      // 조회 실패 시 건수를 절대 0건으로 왜곡하지 않음!
      const totalStr = (d.total_records !== null) ? `${d.total_records.toLocaleString()}건` : '<span class="text-rose-400 font-bold">확인 불가 (오류)</span>';
      const validStr = (d.valid_records !== null) ? `${d.valid_records.toLocaleString()}건` : '<span class="text-rose-400 font-bold">-</span>';
      const missingStr = (d.missing_records !== null) ? `${d.missing_records.toLocaleString()}건` : '<span class="text-rose-400 font-bold">-</span>';
      const updatedStr = d.last_updated_at ? new Date(d.last_updated_at).toLocaleString('ko-KR') : '<span class="text-rose-400 font-bold">확인 불가 (수신 실패)</span>';

      return `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
                  ${d.table_name || d.id}
                </span>
                <span class="text-xs font-bold text-slate-400">${escapeHtml(d.category)}</span>
              </div>
              <h3 class="text-sm sm:text-base font-black text-white mt-1">${escapeHtml(d.name)}</h3>
            </div>
            <div class="flex items-center gap-2">
              <span class="px-2.5 py-1 rounded-full text-xs font-black border flex items-center gap-1.5 ${badgeColor}">
                <i data-lucide="${icon}" class="w-3.5 h-3.5"></i>
                <span>${d.status_label || d.status}</span>
              </span>
            </div>
          </div>

          <p class="text-xs text-slate-300 leading-relaxed">${escapeHtml(d.description)}</p>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">총 레코드 수</span>
              <p class="font-mono font-black text-white mt-0.5">${totalStr}</p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">정상 레코드</span>
              <p class="font-mono font-black text-emerald-400 mt-0.5">${validStr}</p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">결측/누락 수</span>
              <p class="font-mono font-black text-amber-400 mt-0.5">${missingStr}</p>
            </div>
            <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-slate-400">중복 레코드</span>
              <p class="font-mono font-black ${d.duplicate_records > 0 ? 'text-purple-400' : 'text-slate-300'} mt-0.5">
                ${d.duplicate_records !== null ? `${d.duplicate_records}건` : '확인 불가'}
              </p>
            </div>
          </div>

          <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-800/80 text-[11px] text-slate-300 leading-snug">
            <div class="flex items-center gap-1.5 font-bold text-slate-200 mb-1">
              <i data-lucide="info" class="w-3.5 h-3.5 text-indigo-400"></i>
              <span>품질 판정 가이드</span>
            </div>
            <p>${escapeHtml(d.quality_summary)}</p>
          </div>

          <div class="flex items-center justify-between text-[10px] text-slate-500 pt-1">
            <span>마지막 갱신: <span class="font-mono text-slate-400 font-bold">${updatedStr}</span></span>
            <span>데이터 파이프라인 무결성 감시</span>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  // -------------------------------------------------------------------------
  // 2. 실험 카드 화면 (Experiment Cards Tab)
  // -------------------------------------------------------------------------
  function renderExperimentsTab() {
    const container = document.getElementById('experimentsContainer');
    if (!container) return;

    if (!state.data) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">운영 실험 카드 조회 불가 (원장 미수신 상태)</p>
          <p class="text-xs text-slate-500">조회 실패를 0건으로 왜곡하지 않으며, 서버 연결 시 재표출됩니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const experiments = state.data?.experiments || [];
    if (experiments.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-2">
          <i data-lucide="flask-conical-off" class="w-8 h-8 mx-auto text-slate-600"></i>
          <p class="text-sm font-bold text-slate-300">등록된 운영 실험 카드가 없습니다. (0건)</p>
          <p class="text-xs text-slate-500">현재 등록된 운영 실험이 비어 있습니다. 상단 [1. 정상] 시나리오를 선택하세요.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = experiments.map(exp => {
      // 1) 합성 결과 라벨링 (사전 표본 계획 유무 & 비교 방식 기반)
      let evalBadge = '';
      const synthStatus = exp.evaluation?.synthetic_result?.status;
      const synthLabel = exp.evaluation?.synthetic_result?.label;

      if (synthStatus === 'pending_inconclusive') {
        evalBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-black bg-rose-950 text-rose-300 border border-rose-800">${escapeHtml(synthLabel || '판단 보류')}</span>`;
      } else if (synthStatus === 'observational_finding') {
        evalBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-black bg-amber-950 text-amber-300 border border-amber-800">${escapeHtml(synthLabel || '관찰 결과')}</span>`;
      } else {
        evalBadge = `<span class="px-2.5 py-1 rounded-full text-xs font-black bg-emerald-950 text-emerald-300 border border-emerald-800">${escapeHtml(synthLabel || '검토 가능')}</span>`;
      }

      // 2) 비용 상태 뱃지 (비용 null / 0원 / 값 구분 & 수익성 판단 제외)
      let costBlock = '';
      const costInfo = exp.cost || {};
      let costColor = 'border-amber-800/80 bg-amber-950/60 text-amber-200';
      if (costInfo.status === 'cost_zero') {
        costColor = 'border-sky-800/80 bg-sky-950/60 text-sky-200';
      } else if (costInfo.status === 'cost_valued') {
        costColor = 'border-emerald-800/80 bg-emerald-950/60 text-emerald-200';
      }

      costBlock = `
        <div class="border rounded-xl p-3 text-xs ${costColor}">
          <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <span class="font-bold flex items-center gap-1.5">
              <i data-lucide="coins" class="w-3.5 h-3.5"></i>
              <span>비용 구분: <strong>${escapeHtml(costInfo.cost_label || '비용 미입력')}</strong></span>
            </span>
            <span class="px-2 py-0.5 rounded text-[10px] font-black bg-slate-900 border border-slate-700 text-slate-300">
              수익성 판단 제외 (회계 비연결 원칙)
            </span>
          </div>
          <p class="text-[11px] leading-relaxed opacity-90">${escapeHtml(costInfo.warning || '')}</p>
        </div>
      `;

      // 3) 3단계 분리 카드 (합성 결과 / 운영 승인 / 타 현장 재현)
      const approvalInfo = exp.evaluation?.operational_approval || {};
      const replicationInfo = exp.evaluation?.site_replication || {};

      // 지표 테이블
      const metricsHtml = (exp.metrics || []).map(m => `
        <tr class="border-b border-slate-800/60">
          <td class="py-2 px-3 text-slate-300">${escapeHtml(m.name)}</td>
          <td class="py-2 px-3 font-mono text-slate-400">${escapeHtml(m.control_value)}</td>
          <td class="py-2 px-3 font-mono font-bold text-white">${escapeHtml(m.experiment_value)}</td>
          <td class="py-2 px-3 font-mono font-black ${m.trend === 'positive' ? 'text-emerald-400' : 'text-slate-300'}">
            ${escapeHtml(m.delta)}
          </td>
        </tr>
      `).join('');

      // 표본 수 및 계획 표시
      const planStatus = exp.sample_plan?.status === 'planned' ? '사전 계획 수립됨' : '사전 계획 미정';
      const targetNStr = exp.sample_plan?.target_n ? ` (목표 N=${exp.sample_plan.target_n})` : '';

      return `
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl space-y-4">
          <!-- 카드 헤더 -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="px-2.5 py-0.5 rounded-lg text-xs font-black bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  ${exp.id}
                </span>
                <span class="text-xs font-bold text-slate-400">예시 주제: ${escapeHtml(exp.topic)}</span>
              </div>
              <h3 class="text-sm sm:text-base md:text-lg font-black text-white mt-1">${escapeHtml(exp.title)}</h3>
            </div>
            <div class="flex items-center gap-2 shrink-0">
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
              <span class="text-[10px] text-slate-400">비교 방식</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${escapeHtml(exp.methodology_label || exp.methodology)}</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">표본 계획</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${planStatus}${targetNStr}</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">수집 표본 수</span>
              <p class="font-bold font-mono text-white mt-0.5">N = ${exp.sample_size}팀</p>
            </div>
            <div class="bg-slate-950/50 p-2.5 rounded-xl border border-slate-800/80">
              <span class="text-[10px] text-slate-400">실험 기간</span>
              <p class="font-bold text-slate-200 truncate mt-0.5">${escapeHtml(exp.period)}</p>
            </div>
          </div>

          <!-- 지표 테이블 -->
          <div class="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="bg-slate-950 border-b border-slate-800 text-slate-400">
                  <th class="py-2 px-3 font-semibold">측정 지표</th>
                  <th class="py-2 px-3 font-semibold">대조군(기준)</th>
                  <th class="py-2 px-3 font-semibold">실험군(개입)</th>
                  <th class="py-2 px-3 font-semibold">변화폭(Delta)</th>
                </tr>
              </thead>
              <tbody>
                ${metricsHtml}
              </tbody>
            </table>
          </div>

          <!-- 비용 블록 -->
          ${costBlock}

          <!-- 3단계 구분 평가 (합성 결과 · 운영 승인 · 타 현장 재현) -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-indigo-400 block mb-0.5">① 합성 결과 판정</span>
              <strong class="text-white block font-black">${escapeHtml(exp.evaluation?.synthetic_result?.label || '-')}</strong>
              <p class="text-[11px] text-slate-400 mt-1 leading-snug">${escapeHtml(exp.evaluation?.synthetic_result?.detail || '')}</p>
            </div>

            <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-sky-400 block mb-0.5">② 운영 승인 상태</span>
              <strong class="text-white block font-black">${escapeHtml(approvalInfo.label || '운영 승인: 대기')}</strong>
              <p class="text-[11px] text-slate-400 mt-1 leading-snug">${escapeHtml(approvalInfo.detail || '')}</p>
            </div>

            <div class="bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <span class="text-[10px] font-bold text-emerald-400 block mb-0.5">③ 타 현장 재현 검증</span>
              <strong class="text-white block font-black">${escapeHtml(replicationInfo.label || '타 현장 재현: 미실시')}</strong>
              <p class="text-[11px] text-slate-400 mt-1 leading-snug">${escapeHtml(replicationInfo.detail || '')}</p>
            </div>
          </div>

          <!-- 결과 요약 및 다음 결정 -->
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
                ${escapeHtml(exp.decision_tag || '검토 중')}
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

    if (!state.data) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-3">
          <i data-lucide="wifi-off" class="w-8 h-8 mx-auto text-rose-400"></i>
          <p class="text-sm font-black text-rose-300">운영 지침서 조회 불가 (원장 미수신 상태)</p>
          <p class="text-xs text-slate-500">조회 실패를 0건으로 왜곡하지 않습니다.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    const guidelines = state.data?.guidelines || [];
    if (guidelines.length === 0) {
      container.innerHTML = `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-10 text-center text-slate-400 space-y-2">
          <i data-lucide="file-question" class="w-8 h-8 mx-auto text-slate-600"></i>
          <p class="text-sm font-bold text-slate-300">등록된 표준 운영 지침서가 없습니다. (0건)</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = guidelines.map(g => {
      const prereqsHtml = (g.prerequisites || []).map(p => `
        <li class="flex items-start gap-2 text-slate-300">
          <i data-lucide="check" class="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(p)}</span>
        </li>
      `).join('');

      const stepsHtml = (g.procedures || []).map(step => `
        <div class="flex items-start gap-3 p-3 bg-slate-950/60 rounded-xl border border-slate-800/80">
          <div class="w-6 h-6 rounded-full bg-indigo-900/80 text-indigo-300 font-mono font-black text-xs flex items-center justify-center shrink-0">
            ${step.step}
          </div>
          <div class="min-w-0">
            <span class="text-[11px] font-bold text-indigo-400 block">${escapeHtml(step.role)}</span>
            <p class="text-xs text-slate-200 mt-0.5 leading-relaxed">${escapeHtml(step.action)}</p>
          </div>
        </div>
      `).join('');

      const limitsHtml = (g.limitations || []).map(l => `
        <li class="flex items-start gap-2 text-amber-200">
          <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(l)}</span>
        </li>
      `).join('');

      const reverifyHtml = (g.reverification_items || []).map(r => `
        <li class="flex items-start gap-2 text-sky-200">
          <i data-lucide="refresh-cw" class="w-4 h-4 text-sky-400 shrink-0 mt-0.5"></i>
          <span>${escapeHtml(r)}</span>
        </li>
      `).join('');

      return `
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-4 sm:p-6 shadow-xl space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="px-2.5 py-0.5 rounded-lg text-xs font-mono font-black bg-indigo-950 text-indigo-300 border border-indigo-800">
                  ${g.id} v${g.version}
                </span>
                <span class="text-xs text-slate-400">적용 대상: ${escapeHtml(g.target_scene)}</span>
              </div>
              <h3 class="text-sm sm:text-base md:text-lg font-black text-white mt-1">${escapeHtml(g.title)}</h3>
            </div>
            <span class="text-xs font-bold text-slate-400 bg-slate-950 px-3 py-1 rounded-xl border border-slate-800 self-start sm:self-auto">
              근거: ${escapeHtml(g.evidence_ref)}
            </span>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs font-black text-emerald-400 flex items-center gap-1.5 uppercase tracking-wide">
              <i data-lucide="clipboard-check" class="w-4 h-4"></i>
              <span>1. 사전 적용 필수 조건 (Prerequisites)</span>
            </h4>
            <ul class="space-y-1.5 text-xs bg-slate-950/40 p-4 rounded-2xl border border-slate-800/80">
              ${prereqsHtml}
            </ul>
          </div>

          <div class="space-y-2">
            <h4 class="text-xs font-black text-indigo-400 flex items-center gap-1.5 uppercase tracking-wide">
              <i data-lucide="list-ordered" class="w-4 h-4"></i>
              <span>2. 실행 단계별 절차 (Standard Operating Procedures)</span>
            </h4>
            <div class="space-y-2">
              ${stepsHtml}
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div class="bg-amber-950/30 border border-amber-900/60 rounded-2xl p-4 space-y-2">
              <h4 class="font-black text-amber-300 flex items-center gap-1.5">
                <i data-lucide="alert-octagon" class="w-4 h-4"></i>
                <span>3. 운영 한계 및 주의사항 (Limitations)</span>
              </h4>
              <ul class="space-y-1.5 text-[11px]">
                ${limitsHtml}
              </ul>
            </div>

            <div class="bg-sky-950/30 border border-sky-900/60 rounded-2xl p-4 space-y-2">
              <h4 class="font-black text-sky-300 flex items-center gap-1.5">
                <i data-lucide="git-branch-plus" class="w-4 h-4"></i>
                <span>4. 타 현장(영주·안동) 재검증 필수 항목</span>
              </h4>
              <ul class="space-y-1.5 text-[11px]">
                ${reverifyHtml}
              </ul>
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 전역 디버그 및 테스트용 노출
  window.BongplayApp = {
    state,
    fetchData,
    setScenario,
    switchTab,
    enableOfflineDemoMode,
    triggerRaceConditionTest
  };

})();

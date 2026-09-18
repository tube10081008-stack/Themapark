/* ============================================================
   봉플레이 운영시스템 — 설정 템플릿 (config.template.js)
   ------------------------------------------------------------
   ⚠ 사용 방법:
   1. 이 파일을 복사하여 같은 폴더에 'config.js' 로 저장하십시오.
   2. 아래 항목에 발급받은 Supabase 접속 정보와 Apps Script URL을 입력하십시오.
   3. 'config.js'는 보안 자격증명이 포함되므로 .gitignore에 의해 Git 커밋에서 제외됩니다.
   ============================================================ */

window.BONGPLAY_CONFIG = {

  // ── 1. Supabase 접속 정보 ────────────────────────────
  // Supabase 콘솔 ➔ Project Settings ➔ API 에서 복사
  SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_PUBLIC_KEY',

  // ── 2. 구글 드라이브 5TB 아카이브 연동 URL ─────────────
  // Google Apps Script 웹 앱 배포 URL
  ARCHIVE_GAS_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',

  // ── 3. 접근 제한 암호 ─────────────────────────────────
  // 운영 요원 대시보드 보안 인증용 (손님용 서약/설문은 잠기지 않음)
  ACCESS_CODE: 'bongplay2026!',
  STAFF_PIN: '2026',

  // ── 4. 사업 기준값 (Single Source of Truth, v2026.v1) ─
  ANNUAL_FIXED_COST: 228900000,   // 연간 고정비 (2.289억 원)
  BLENDED_PRICE: 12036,           // 혼합객단가
  VARIABLE_COST: 361,             // 1인당 변동비
  ANNUAL_BEP_VISITORS: 19606,     // 연간 손익분기 방문객 (19,606명)
  ANNUAL_BEP_REVENUE: 236000000,  // 연간 손익분기 매출 (2.36억 원)
  DAILY_BASELINE_BEP: 660000,     // 일일 기준 손익분기 매출 (66만 원)
  WEEKDAY_TARGET_VISITORS: 30,    // 평일 목표 방문객
  WEEKDAY_TARGET_REVENUE: 360000, // 평일 목표 매출 (36만 원)
  WEEKEND_TARGET_VISITORS: 148,   // 주말 목표 방문객
  WEEKEND_TARGET_REVENUE: 1780000,// 주말 목표 매출 (178만 원)
  MASTER_VERSION: '2026.v1'       // 기준정보 버전
};

/* ---------- 자동 적용 및 운영 요원 접근 제어 ---------- */
(function () {
  var cfg = window.BONGPLAY_CONFIG || {};

  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && cfg.SUPABASE_URL.indexOf('YOUR_PROJECT') === -1) {
    try {
      localStorage.setItem('bongplay_supabase_config', JSON.stringify({
        url: cfg.SUPABASE_URL.replace(/\/+$/, ''),
        key: cfg.SUPABASE_ANON_KEY.trim()
      }));
    } catch (e) { /* 무시 */ }
  }

  var currentPath = window.location.pathname.toLowerCase();
  var isPublicPage = currentPath.endsWith('consent.html') || currentPath.endsWith('survey.html') || currentPath === '/' || currentPath.endsWith('index.html');
  if (isPublicPage) return;

  var isAdminDashboard = currentPath.includes('/pages/');
  if (!isAdminDashboard || (!cfg.ACCESS_CODE && !cfg.STAFF_PIN)) return;

  var AUTH_KEY = 'bongplay_staff_session_v1';
  try {
    var sessionRaw = localStorage.getItem(AUTH_KEY);
    if (sessionRaw) {
      var sess = JSON.parse(sessionRaw);
      if (sess.authenticated && sess.expiresAt > Date.now()) return;
    }
  } catch (e) {}

  function showAuthModal() {
    if (document.getElementById('bongplay-auth-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'bongplay-auth-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.96);backdrop-filter:blur(8px);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#f8fafc;';
    overlay.innerHTML = 
      '<div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px 28px;max-width:380px;width:90%;text-align:center;">' +
        '<div style="width:48px;height:48px;margin:0 auto 16px;background:#0284c7;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;">🔒</div>' +
        '<h2 style="font-size:18px;font-weight:700;margin:0 0 8px;">봉플레이 현장 운영 인증</h2>' +
        '<p style="font-size:13px;color:#94a3b8;margin:0 0 20px;">현장 근무자 비밀번호 또는 PIN을 입력하십시오.</p>' +
        '<form id="bongplay-auth-form" style="margin:0;">' +
          '<input type="password" id="bongplay-auth-input" placeholder="비밀번호 / PIN" autofocus style="width:100%;box-sizing:border-box;padding:12px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#fff;text-align:center;font-size:16px;margin-bottom:12px;" />' +
          '<div id="bongplay-auth-error" style="color:#f87171;font-size:12px;margin-bottom:12px;display:none;"></div>' +
          '<button type="submit" style="width:100%;padding:12px;background:#0284c7;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">인증 및 잠금 해제</button>' +
        '</form>' +
      '</div>';
    document.body ? document.body.appendChild(overlay) : document.documentElement.appendChild(overlay);

    var form = document.getElementById('bongplay-auth-form');
    var input = document.getElementById('bongplay-auth-input');
    var errEl = document.getElementById('bongplay-auth-error');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = (input.value || '').trim();
      if (val === cfg.ACCESS_CODE || val === cfg.STAFF_PIN) {
        localStorage.setItem(AUTH_KEY, JSON.stringify({ authenticated: true, expiresAt: Date.now() + 12*3600*1000 }));
        overlay.remove();
      } else {
        errEl.textContent = '암호가 올바르지 않습니다.';
        errEl.style.display = 'block';
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showAuthModal);
  else showAuthModal();
})();

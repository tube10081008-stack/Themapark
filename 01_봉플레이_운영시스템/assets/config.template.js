/* ============================================================
   봉플레이 운영시스템 — 설정 템플릿 (config.template.js)
   ------------------------------------------------------------
   ⚠ 사용 방법: 이 파일을 같은 폴더에 'config.js' 로 복사한 뒤 아래 값을 채우십시오.
      'config.js' 는 .gitignore 로 커밋에서 제외됩니다.
   ------------------------------------------------------------
   ⚠ 배포 전 아래 두 줄만 채우십시오.
      각 기기에서 따로 입력할 필요가 없어집니다.

   ⚠ 보안 주의
      이 파일은 브라우저에서 그대로 보입니다.
      → 암호·PIN·토큰 등 비밀값을 이 파일에 절대 넣지 마십시오.
      → 운영자 암호는 Supabase DB(private.app_settings)에 해시로만 저장되고,
        로그인 시 DB 함수(verify_staff_access)가 검증합니다.
        등록 방법: database/FINAL_SUPABASE_SETUP.sql 의 5-2 절 참고
   ============================================================ */

window.BONGPLAY_CONFIG = {

  // ── 1. Supabase 접속 정보 ────────────────────────────
  // Supabase → Project Settings → API 에서 복사
  SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_PUBLIC_KEY',

  // ── 2. 구글 드라이브 5TB 아카이브 연동 URL ─────────────
  ARCHIVE_GAS_URL: 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec',

  // ── 3. 운영자 로그인 유지 시간 (시간) ──────────────────
  STAFF_SESSION_HOURS: 12,

  // ── 4. 사업 기준값 (Single Source of Truth, v2026.v1) ───────────────────
  // 시뮬레이터 및 bongplay-id.js MASTER_TARGETS와 100% 일치
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
  var sbUrl = (cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  var sbKey = (cfg.SUPABASE_ANON_KEY || '').trim();

  // 1. Supabase 설정이 코드에 있으면 자동 저장 (기기별 수동 입력 불필요)
  if (sbUrl && sbKey && sbUrl.indexOf('YOUR_PROJECT') === -1) {
    try {
      var existing = localStorage.getItem('bongplay_supabase_config');
      var e = existing ? JSON.parse(existing) : null;
      if (!e || e.url !== sbUrl || e.key !== sbKey) {
        localStorage.setItem('bongplay_supabase_config', JSON.stringify({ url: sbUrl, key: sbKey }));
      }
    } catch (err) { /* 무시 */ }
  }

  // 2. 운영자 세션 (서버에서 검증된 암호만 세션으로 보관)
  var AUTH_KEY = 'bongplay_staff_session_v2';
  var SESSION_MS = (Number(cfg.STAFF_SESSION_HOURS) || 12) * 60 * 60 * 1000;
  try { localStorage.removeItem('bongplay_staff_session_v1'); } catch (err) {} // 구버전(클라이언트 비교) 세션 폐기

  function readSession() {
    try {
      var s = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (s && s.code && s.expiresAt > Date.now()) return s;
      localStorage.removeItem(AUTH_KEY);
    } catch (err) {}
    return null;
  }

  // 보안 RPC(get_today_consents_secure 등)에 전달할 암호는 여기서만 꺼냅니다.
  window.BongplayAuth = {
    getAccessCode: function () { var s = readSession(); return s ? s.code : null; },
    isAuthenticated: function () { return !!readSession(); },
    logout: function () {
      try { localStorage.removeItem(AUTH_KEY); } catch (err) {}
      window.location.reload();
    }
  };

  // 3. 인증 제외 화면 판별
  //    · 손님 화면은 페이지 스스로 window.BONGPLAY_GUEST_MODE = true 를 선언합니다.
  //    · 메인 포털(루트 index.html)은 바로가기 모음이라 제외합니다.
  //    ※ 예전처럼 경로('/pages/' 포함 여부)로 판별하면 _redirects 짧은 주소
  //      (/operations, /closing 등)로 접속할 때 인증 창이 뜨지 않았습니다.
  //      그래서 "명시적으로 손님 화면이라고 선언하지 않은 모든 화면"을 잠급니다.
  var path = window.location.pathname.toLowerCase();
  var isPortalRoot = path.indexOf('/pages/') === -1 && path.indexOf('/forms/') === -1 &&
                     (/\/$/.test(path) || /\/index\.html$/.test(path));
  if (window.BONGPLAY_GUEST_MODE === true || isPortalRoot) return;
  if (readSession()) return;

  function verifyOnServer(code) {
    if (!sbUrl || !sbKey) return Promise.reject(new Error('unconfigured'));
    return fetch(sbUrl + '/rest/v1/rpc/verify_staff_access', {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': 'Bearer ' + sbKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_access_code: code })
    }).then(function (res) {
      if (res.status === 404) throw new Error('rpc_missing');
      if (!res.ok) throw new Error('http_' + res.status);
      return res.json();
    }).then(function (ok) { return ok === true; });
  }

  function showAuthModal() {
    if (document.getElementById('bongplay-auth-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'bongplay-auth-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.96);backdrop-filter:blur(8px);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#f8fafc;';

    overlay.innerHTML =
      '<div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px 28px;max-width:380px;width:90%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);text-align:center;">' +
        '<div style="width:52px;height:52px;margin:0 auto 16px;background:#0284c7;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;">🔒</div>' +
        '<h2 style="font-size:19px;font-weight:700;margin:0 0 6px;color:#f1f5f9;">봉플레이 현장 운영 인증</h2>' +
        '<p style="font-size:13px;color:#94a3b8;margin:0 0 24px;line-height:1.4;">이 대시보드는 현장 근무자 전용입니다.<br>운영자 암호(6자 이상)를 입력하십시오.</p>' +
        '<form id="bongplay-auth-form" style="margin:0;">' +
          '<div style="margin-bottom:16px;">' +
            '<input type="password" id="bongplay-auth-input" placeholder="운영자 암호" autocomplete="current-password" autofocus ' +
              'style="width:100%;box-sizing:border-box;padding:12px 16px;background:#0f172a;border:1px solid #475569;border-radius:10px;color:#f8fafc;font-size:16px;text-align:center;letter-spacing:2px;outline:none;transition:border-color 0.2s;" />' +
          '</div>' +
          '<div id="bongplay-auth-error" style="color:#f87171;font-size:12px;margin-bottom:14px;min-height:16px;display:none;"></div>' +
          '<button type="submit" id="bongplay-auth-submit" style="width:100%;padding:12px;background:#0284c7;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:background 0.2s;">대시보드 잠금 해제</button>' +
          '<div style="margin-top:16px;">' +
            '<a href="../index.html" style="color:#64748b;font-size:12px;text-decoration:none;">← 메인 포털 홈으로 돌아가기</a>' +
          '</div>' +
        '</form>' +
      '</div>';

    document.body ? document.body.appendChild(overlay) : document.documentElement.appendChild(overlay);

    var form = document.getElementById('bongplay-auth-form');
    var input = document.getElementById('bongplay-auth-input');
    var errorEl = document.getElementById('bongplay-auth-error');
    var submitBtn = document.getElementById('bongplay-auth-submit');

    if (input) setTimeout(function () { input.focus(); }, 150);

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      input.style.borderColor = '#f87171';
      input.value = '';
      input.focus();
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var val = (input.value || '').trim();
      if (val.length < 6) {
        showError('운영자 암호는 6자 이상입니다.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '서버 확인 중…';

      verifyOnServer(val).then(function (ok) {
        if (!ok) {
          showError('암호가 일치하지 않습니다. (연속 실패 시 10분간 잠깁니다)');
          return;
        }
        localStorage.setItem(AUTH_KEY, JSON.stringify({
          code: val,
          authAt: Date.now(),
          expiresAt: Date.now() + SESSION_MS
        }));
        overlay.style.transition = 'opacity 0.25s ease';
        overlay.style.opacity = '0';
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 250);
      }).catch(function (err) {
        var reason = String(err && err.message || err);
        if (reason === 'rpc_missing') {
          showError('서버 인증 함수가 설치되지 않았습니다. 관리자에게 DB 설정(FINAL_SUPABASE_SETUP.sql) 적용을 요청하십시오.');
        } else if (!navigator.onLine || reason.indexOf('Failed to fetch') !== -1) {
          showError('인터넷 연결을 확인하십시오. 로그인은 온라인에서만 가능합니다. (로그인 후 ' + (Number(cfg.STAFF_SESSION_HOURS) || 12) + '시간 유지)');
        } else {
          showError('인증 서버 오류 (' + reason + '). 잠시 후 다시 시도하십시오.');
        }
      }).then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = '대시보드 잠금 해제';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showAuthModal);
  } else {
    showAuthModal();
  }
})();

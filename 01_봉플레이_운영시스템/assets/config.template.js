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
  // 브라우저 최초 진입 및 관리자 RPC 인증용 비밀번호
  ACCESS_CODE: 'bongplay2026',

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

/* ---------- 자동 적용 모듈 ---------- */
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

  if (cfg.ACCESS_CODE) {
    var KEY = 'bongplay_access_ok';
    if (sessionStorage.getItem(KEY) !== '1') {
      var input = prompt('봉플레이 운영시스템\n접근 암호를 입력하십시오.');
      if (input === cfg.ACCESS_CODE) {
        sessionStorage.setItem(KEY, '1');
      } else {
        document.documentElement.innerHTML =
          '<body style="background:#0f172a;color:#94a3b8;font-family:sans-serif;' +
          'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">' +
          '<div style="text-align:center"><p style="font-size:15px;font-weight:700">접근이 제한되었습니다.</p>' +
          '<p style="font-size:12px;margin-top:8px">암호가 올바르지 않습니다. 새로고침 후 다시 시도하십시오.</p></div></body>';
        throw new Error('access denied');
      }
    }
  }
})();

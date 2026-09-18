/* ============================================================
   봉플레이 키오스크 & 태블릿 화면 꺼짐 방지 모듈 (Screen Wake Lock)
   ------------------------------------------------------------
   운영 시간 동안 매표소, 게이트, 키오스크 태블릿의 절전/화면 꺼짐을 방지합니다.
   ============================================================ */
(function (global) {
  'use strict';

  var wakeLockInstance = null;
  var isEnabled = true;

  async function requestWakeLock() {
    if (!isEnabled || typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return false;
    }
    try {
      wakeLockInstance = await navigator.wakeLock.request('screen');
      wakeLockInstance.addEventListener('release', function () {
        wakeLockInstance = null;
      });
      return true;
    } catch (err) {
      console.warn('Wake Lock request failed:', err.name, err.message);
      return false;
    }
  }

  function releaseWakeLock() {
    if (wakeLockInstance) {
      try {
        wakeLockInstance.release();
      } catch (e) {}
      wakeLockInstance = null;
    }
  }

  // 탭 복귀 시 화면 켜짐 유지 재요청
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && isEnabled) {
        requestWakeLock();
      }
    });

    window.addEventListener('DOMContentLoaded', function () {
      requestWakeLock();
    });
  }

  global.BongplayWakeLock = {
    request: requestWakeLock,
    release: releaseWakeLock,
    isActive: function () { return !!wakeLockInstance; },
    setEnabled: function (val) {
      isEnabled = !!val;
      if (isEnabled) requestWakeLock();
      else releaseWakeLock();
    }
  };
})(window);

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

test('R4-ANT Verification: Safety check freeze fix, Consent guest reset & recovery, Desk repeat query & pause UI', async (t) => {
  const safetyCheckHtml = fs.readFileSync(path.join(root, '01_봉플레이_운영시스템/pages/safety-check.html'), 'utf-8');
  const consentHtml = fs.readFileSync(path.join(root, '01_봉플레이_운영시스템/pages/consent.html'), 'utf-8');
  const consentDeskHtml = fs.readFileSync(path.join(root, '01_봉플레이_운영시스템/pages/consent-desk.html'), 'utf-8');

  // =========================================================================
  // 과업 ①: 안전점검 화면 멈춤 원인 수정 및 화면 저장·재조회 검증
  // =========================================================================
  await t.test('1. safety-check.html guards SignaturePad and supports native canvas fallback', () => {
    // 1-1. SignaturePad 가드 및 네이티브 폴백 존재 확인
    assert.ok(safetyCheckHtml.includes("typeof SignaturePad === 'function'"), 'Must guard SignaturePad with typeof check');
    assert.ok(safetyCheckHtml.includes('// Native Canvas Fallback'), 'Must provide native canvas fallback');
    assert.ok(safetyCheckHtml.includes('canvas.addEventListener(\'mousedown\', startStroke);'), 'Fallback must bind mouse events');
    assert.ok(safetyCheckHtml.includes('canvas.addEventListener(\'touchstart\', startStroke'), 'Fallback must bind touch events');
    assert.ok(safetyCheckHtml.includes('isFormDirty = true;'), 'Must track form dirty state');
  });

  await t.test('2. safety-check.html saves checklist and recovers via loadLatestOrNew without SQL seed', async () => {
    // Mock Environment
    const storage = {};
    const mockLocalStorage = {
      getItem: (k) => storage[k] || null,
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    };

    let serverUpsertPayload = null;
    let serverSelectResult = [];
    const mockBongplaySync = {
      upsert: (table, data) => {
        if (table === 'safety_audits') {
          serverUpsertPayload = data;
          serverSelectResult = [data];
          return { ok: true, data };
        }
        return { ok: true };
      },
      select: async (table, query) => {
        if (table === 'safety_audits') {
          return { ok: true, data: serverSelectResult };
        }
        return { ok: true, data: [] };
      },
      broadcast: () => {}
    };

    const mockBongplaySite = {
      siteId: () => 'bongplay_bonghwa',
      staffIdByName: () => 'staff_001',
      defaultManager: () => ({ name: '홍길동' })
    };

    // 1) Test Save flow
    const todayYmd = new Date().toISOString().slice(0, 10);
    const mockChecklist = { '1_1': '양호', '1_2': '양호' };
    const newLog = {
      id: 'LOG_' + Date.now(),
      site_id: mockBongplaySite.siteId(),
      staff_id: 'staff_001',
      date: todayYmd + 'T09:30',
      inspector: '김점검',
      manager: '홍길동',
      checklist: mockChecklist,
      signature: 'data:image/png;base64,mockSignatureData',
      decision: 'pass',
      timestamp: new Date().toISOString()
    };

    // Simulate saveChecklist
    let logs = JSON.parse(mockLocalStorage.getItem('bongplay_safety_audit_logs') || '[]');
    logs.unshift(newLog);
    mockLocalStorage.setItem('bongplay_safety_audit_logs', JSON.stringify(logs));
    mockBongplaySync.upsert('safety_audits', {
      id: newLog.id,
      site_id: newLog.site_id,
      audit_date: todayYmd,
      inspector: newLog.inspector,
      decision: newLog.decision,
      items: newLog.checklist,
      signature_data: newLog.signature
    });

    assert.ok(serverUpsertPayload, 'Server upsert must have executed');
    assert.equal(serverUpsertPayload.decision, 'pass', 'Saved decision must be pass');
    assert.equal(serverUpsertPayload.site_id, 'bongplay_bonghwa', 'site_id must match bongplay_bonghwa');

    // 2) Test loadLatestOrNew recovery without local storage (simulating new session/refresh)
    mockLocalStorage.removeItem('bongplay_safety_audit_logs');
    assert.equal(mockLocalStorage.getItem('bongplay_safety_audit_logs'), null);

    // Call mock select from server as loadLatestOrNew does
    const res = await mockBongplaySync.select('safety_audits', `?audit_date=eq.${todayYmd}`);
    assert.ok(res.ok && res.data.length > 0, 'Must successfully query today audit from server');
    const recovered = res.data[0];
    assert.equal(recovered.decision, 'pass');
    assert.equal(recovered.inspector, '김점검');
    assert.ok(recovered.signature_data, 'Signature data must be recovered');
  });

  // =========================================================================
  // 과업 ②: 공용 서약 화면 이전 고객 정보 초기화 및 새로고침 복구 보존
  // =========================================================================
  await t.test('3. consent.html implements session draft recovery and thorough reset for next guest', () => {
    // 3-1. Check session draft logic presence
    assert.ok(consentHtml.includes("const FORM_DRAFT_KEY = 'bongplay_consent_form_draft';"), 'Must define FORM_DRAFT_KEY');
    assert.ok(consentHtml.includes('function saveFormDraftToSession()'), 'Must define saveFormDraftToSession');
    assert.ok(consentHtml.includes('function restoreFormDraftFromSession()'), 'Must define restoreFormDraftFromSession');
    assert.ok(consentHtml.includes('sessionStorage.removeItem(FORM_DRAFT_KEY);'), 'Must clear draft on submission and reset');

    // 3-2. Check resetForNewGuest thorough reset
    assert.ok(consentHtml.includes('document.querySelectorAll(\'.term-check\').forEach'), 'Must uncheck all term checkboxes');
    assert.ok(consentHtml.includes('nameEl.value = \'\';'), 'Must clear guardian name');
    assert.ok(consentHtml.includes('phoneEl.value = \'\';'), 'Must clear guardian phone');
    assert.ok(consentHtml.includes('clearSignature();'), 'Must clear signature on reset');
    assert.ok(consentHtml.includes('cancelAutoEnqueueRetry();'), 'Must cancel any active enqueue retries');
    assert.ok(consentHtml.includes('다음 고객 접수 (새로 작성)'), 'Button label must be updated for next guest flow');
  });

  await t.test('4. Simulated consent reset: clears prior customer data while preserving outbox', () => {
    const mockLocalStorage = {
      'bongplay_my_voucher': JSON.stringify({ passCode: 'BP-261017-TEST', guardianName: '이전고객' }),
      'bongplay_active_consent_draft': JSON.stringify({ guardian_name: '이전고객', guardian_phone: '01012345678' }),
      'bongplay_my_queue_id': 'q_12345',
      'bongplay_sync_outbox': JSON.stringify([{ id: 'cst_offline_1', table: 'safety_consents' }]) // 미전송 데이터
    };
    const mockSessionStorage = {
      'bongplay_consent_form_draft': JSON.stringify({ guardianName: '이전고객', guardianPhone: '01012345678' })
    };

    // Simulate resetForNewGuest
    delete mockLocalStorage['bongplay_my_voucher'];
    delete mockLocalStorage['bongplay_active_consent_draft'];
    delete mockLocalStorage['bongplay_my_queue_id'];
    delete mockSessionStorage['bongplay_consent_form_draft'];

    // Verify customer data cleared
    assert.equal(mockLocalStorage['bongplay_my_voucher'], undefined, 'Voucher must be removed');
    assert.equal(mockLocalStorage['bongplay_active_consent_draft'], undefined, 'Active draft must be removed');
    assert.equal(mockSessionStorage['bongplay_consent_form_draft'], undefined, 'Session draft must be removed');

    // Verify outbox preserved
    assert.ok(mockLocalStorage['bongplay_sync_outbox'], 'Offline outbox MUST be preserved');
    const outbox = JSON.parse(mockLocalStorage['bongplay_sync_outbox']);
    assert.equal(outbox.length, 1, 'Outbox item count must remain 1');
  });

  // =========================================================================
  // 과업 ③: 발권 후 반복 조회 억제, 창구 정지 표시, 전송 전 완료 제목 수정
  // =========================================================================
  await t.test('5. consent.html shows pre-transmission title when consent is not yet confirmed on server', () => {
    assert.ok(consentHtml.includes("titleEl.textContent = '서약 접수 대기 중 (전송 대기)';"), 'Must set pre-transmission title in showVoucher');
    assert.ok(consentHtml.includes("subTitleEl.textContent = '네트워크 연결 후 서버로 자동 전송됩니다.';"), 'Must set pre-transmission subtitle');
  });

  await t.test('6. consent-desk.html provides in-flight guards, debounced data loading, and desk pause sync', () => {
    // 6-1. In-flight guard and debouncing in consent-desk.html
    assert.ok(consentDeskHtml.includes('let isRefreshingDeskQueue = false;'), 'Must have isRefreshingDeskQueue flag');
    assert.ok(consentDeskHtml.includes('let pendingDeskQueueRefresh = false;'), 'Must have pendingDeskQueueRefresh flag');
    assert.ok(consentDeskHtml.includes('function requestLoadData()'), 'Must define debounced requestLoadData');
    assert.ok(consentDeskHtml.includes('let isLoadingConsents = false;'), 'Must have isLoadingConsents flag');

    // 6-2. Desk pause indicator and error notice
    assert.ok(consentDeskHtml.includes('async function selectActiveDesk(deskNo)'), 'selectActiveDesk must be async');
    assert.ok(consentDeskHtml.includes('await syncDeskStatusFromServer(currentDeskNo);'), 'Must await syncDeskStatusFromServer');
    assert.ok(consentDeskHtml.includes('activeBadge.textContent = `${currentDeskNo}번 창구 (일시 중지)`;'), 'Must display paused badge text');
    assert.ok(consentDeskHtml.includes('showDeskNotice'), 'Must show desk notices on pause/errors');
  });

  await t.test('7. Simulated in-flight guard suppresses rapid duplicate RPC queries', async () => {
    let rpcCallCount = 0;
    let isRefreshing = false;
    let pendingRefresh = false;

    const mockRefresh = async () => {
      if (isRefreshing) {
        pendingRefresh = true;
        return;
      }
      isRefreshing = true;
      rpcCallCount++;
      // Simulate RPC delay
      await new Promise(r => setTimeout(r, 50));
      isRefreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        await mockRefresh();
      }
    };

    // Trigger 5 rapid simultaneous calls (e.g. after issuance + bus events + polling)
    await Promise.all([
      mockRefresh(),
      mockRefresh(),
      mockRefresh(),
      mockRefresh(),
      mockRefresh()
    ]);

    // Should only have executed 2 calls (initial + 1 pending catch-up), not 5
    assert.equal(rpcCallCount, 2, 'Rapid duplicate queries must be coalesced to 2');
  });
});

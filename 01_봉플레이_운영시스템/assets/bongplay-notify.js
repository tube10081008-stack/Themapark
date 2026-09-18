/* ============================================================
   봉플레이 디스코드 관제 및 수석비서 보고 엔진 (BongplayNotify v1.2)
   ------------------------------------------------------------
   설계 원칙:
   1. 보안 최우선: Discord Webhook URL을 클라이언트에 노출하지 않고
      Netlify Functions(/api/notify) 서버리스 프록시를 통해 안전하게 발송
   2. 격조 높은 수석비서관 스타일의 정중하고 명확한 한글 보고서 서식
   3. 개인정보 철저 보호: 고객 성명/연락처 국외 유출 방지 (마스킹 필수)
   4. 멱등성(중복 방지): 오프라인 큐 복구 시 동일 사건 중복 알림 차단
   5. 알림 채널 분리: #비상 / #경영 / #마감 / #운영 4대 목적별 전송
   ============================================================ */
(function (global) {
  'use strict';

  var NOTIFY_KEY = 'bongplay_notified_event_ids';
  var NOTIFY_ENDPOINT = '/api/notify';

  /* ---------- 로컬 커스텀 웹훅 오버라이드 지원 (선택사항) ---------- */
  function getCustomWebhooks() {
    try {
      return JSON.parse(localStorage.getItem('bongplay_discord_webhooks') || '{}');
    } catch (e) {
      return {};
    }
  }

  /* ---------- 개인정보 마스킹 (개인정보보호법 국외 이전 방어) ---------- */
  function maskName(name) {
    if (!name || typeof name !== 'string') return '고객';
    var clean = name.trim();
    if (clean.length <= 1) return clean + '*';
    if (clean.length === 2) return clean[0] + '*';
    return clean[0] + '*'.repeat(clean.length - 2) + clean[clean.length - 1];
  }

  function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '-';
    var clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 11) {
      return clean.slice(0, 3) + '-****-' + clean.slice(7);
    } else if (clean.length === 10) {
      return clean.slice(0, 3) + '-***-' + clean.slice(6);
    }
    return '***-****-****';
  }

  /* ---------- 멱등성 가드 (중복 발송 차단) ---------- */
  function getNotifiedIds() {
    try {
      return JSON.parse(localStorage.getItem(NOTIFY_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function markAsNotified(id) {
    if (!id) return;
    try {
      var ids = getNotifiedIds();
      if (!ids.includes(id)) {
        ids.push(id);
        if (ids.length > 500) ids = ids.slice(-500);
        localStorage.setItem(NOTIFY_KEY, JSON.stringify(ids));
      }
    } catch (e) {}
  }

  function hasAlreadyNotified(id) {
    if (!id) return false;
    var ids = getNotifiedIds();
    return ids.includes(id);
  }

  /* ---------- 공통 HTTP 전송 (서버리스 보안 프록시 경유) ---------- */
  async function postDiscord(channel, payload) {
    // 1. 개발자 로컬 테스트용 오버라이드가 있으면 직접 발송
    var custom = getCustomWebhooks();
    if (custom && custom[channel]) {
      try {
        var resDirect = await fetch(custom[channel], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return resDirect.ok;
      } catch (e) {
        console.warn('[BongplayNotify] Custom Webhook delivery failed:', e);
      }
    }

    // 2. 보안 서버리스 프록시(/api/notify)로 위임 (환경변수에 저장된 웹훅 사용)
    try {
      var res = await fetch(NOTIFY_ENDPOINT, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Bongplay-Token': 'bongplay_notify_auth_2026'
        },
        body: JSON.stringify({ channel: channel, payload: payload })
      });
      return res.ok;
    } catch (e) {
      console.warn('[BongplayNotify] Serverless Proxy delivery failed:', e);
      return false;
    }
  }

  /* ============================================================
     1. #비상 — 119 출동 및 긴급 안전사고 보고 (수석비서관 양식)
     ============================================================ */
  async function sendEmergencyAlert(params) {
    params = params || {};
    var eventId = params.id || params.incident_id || ('inc_' + Date.now());
    if (hasAlreadyNotified(eventId)) return false;

    var severity = params.severity || 'serious';
    var is119 = params.called_119 === true || (params.hospital_transport && params.hospital_transport.includes('119'));
    var facility = params.facility_name || params.facility_id || '현장 시설';
    var time = params.occurred_at || new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    var cause = params.description || params.cause || '원인 파악 중';
    var action = params.action_taken || '현장 응급조치 수행 중';
    var hospital = params.hospital_transport || (is119 ? '봉화해성병원 응급실 (119 구급대 이송)' : '현장 조치 및 모니터링');
    var maskedVictim = maskName(params.victim_name || params.person_name);

    var embed = {
      title: '🚨 [긴급 비상경보] ' + (is119 ? '119 구급대 출동 및 안전사고 보고' : '현장 안전사고 발생 긴급 보고'),
      description: '대표님, **' + facility + '**에서 안전사고가 발생하여 긴급히 보고드립니다.\n현재 현장 안전요원이 골든타임 프로토콜에 따라 응급조치 및 초기 진압을 완료하고 비상 대기 중입니다.',
      color: 15158332, // Vivid Red
      fields: [
        { name: '사고 접수번호', value: '`' + eventId + '`', inline: true },
        { name: '대응 심각도', value: '**' + (severity === 'critical' ? '최고 위험 [CRITICAL]' : '긴급 대응 [SERIOUS]') + '**' + (is119 ? ' 🚨 119 출동' : ''), inline: true },
        { name: '발생 시설/장소', value: facility, inline: true },
        { name: '발생 시각', value: time, inline: true },
        { name: '피해 고객 정보', value: maskedVictim + ' (연령: ' + (params.victim_age || '미상') + ')', inline: true },
        { name: '방문 세션 ID', value: params.visit_id ? '`' + params.visit_id + '`' : '현장 수기 접수', inline: true },
        { name: '사고 발생 경위', value: cause, inline: false },
        { name: '현장 조치 내역', value: action, inline: false },
        { name: '병원 이송 결과', value: hospital, inline: false }
      ],
      footer: { text: '봉플레이 비상관제 엔진 • 개인정보보호법 준수 및 안심 마스킹 적용' },
      timestamp: new Date().toISOString()
    };

    var ok = await postDiscord('emergency', {
      username: '봉플레이 비상관제 수석비서',
      embeds: [embed]
    });

    if (ok) markAsNotified(eventId);
    return ok;
  }

  /* ============================================================
     1-B. #비상 — 실내 비상 키오스크 원터치 비상벨 즉시 호출
     ============================================================ */
  async function sendInstantBellAlert(params) {
    params = params || {};
    var location = params.location || '실내 안내데스크 비상 키오스크';
    var time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    var caller = params.caller || '현장 방문객 또는 직원';

    var embed = {
      title: '🚨🚨 [비상벨 발령] 실내 키오스크 원터치 비상벨 작동!',
      description: '대표님 및 전 직원 비상 전파!\n**' + location + '**에서 긴급 비상벨이 작동되었습니다.\n현장 모든 근무자는 즉시 무전을 개방하고 현장 안전 상황을 신속히 확인해 주시기 바랍니다.',
      color: 15158332, // Red
      fields: [
        { name: '호출 위치', value: location, inline: true },
        { name: '발령 시각', value: time, inline: true },
        { name: '호출자 구분', value: caller, inline: true },
        { name: '행동 요령', value: '1. 즉시 현장(안내데스크)으로 안전관리자 이동\n2. 환자/사고 여부 확인 후 필요시 즉시 119 원터치 연계\n3. 현장 상황 무전으로 대표 및 운영팀에 실시간 공유', inline: false }
      ],
      footer: { text: '봉플레이 비상 키오스크 핫라인 연동' },
      timestamp: new Date().toISOString()
    };

    return await postDiscord('emergency', {
      username: '봉플레이 비상벨 관제',
      embeds: [embed]
    });
  }

  /* ============================================================
     2. #경영 — 고객 중대민원 및 위탁 리스크 보고 (수석비서관 양식)
     ============================================================ */
  async function sendComplaintAlert(params) {
    params = params || {};
    var eventId = params.id || params.complaint_id || ('cmp_' + Date.now());
    if (hasAlreadyNotified(eventId)) return false;

    var count = Number(params.current_complaint_count || 1);
    var isContractRisk = count >= 2;
    var facility = params.facility_name || params.facility_id || '운영 현장';
    var content = params.content || params.description || '민원 상세 확인 중';
    var maskedCustomer = maskName(params.customer_name || params.complainant_name);

    var embed = {
      title: isContractRisk 
        ? '🚨🚨 [경영 위기 경보] 중대민원 2건 누적 보고 (위탁 계약 해지 위험)' 
        : '⚠️ [경영 리스크 보고] 고객 중대민원 접수 현황',
      description: isContractRisk 
        ? '대표님, **[위탁 운영 3대 원칙]**에 따른 중대민원이 **' + count + '건 누적**되었습니다.\n군청 위탁 계약상 치명적인 리스크로 이어질 수 있으므로 즉시 긴급 경영대책 회의 및 군청 소통을 개시하여 주십시오.'
        : '대표님, **' + facility + '**에서 고객 불만/중대민원이 접수되었습니다.\n고객 경험 악화 및 확산 방지를 위하여 10분 이내 신속한 현장 응대 및 경청 조치를 권장합니다.',
      color: isContractRisk ? 10038562 : 16744192, // Dark Red or Amber
      fields: [
        { name: '접수 관리번호', value: '`' + eventId + '`', inline: true },
        { name: '누적 중대민원', value: '**' + count + ' / 2건**' + (isContractRisk ? ' [위험]' : ' [주의]'), inline: true },
        { name: '발생 시설', value: facility, inline: true },
        { name: '고객명', value: maskedCustomer, inline: true },
        { name: '민원 유형', value: params.complaint_type || '시설 안전 및 고객 응대', inline: true },
        { name: '방문 세션 ID', value: params.visit_id ? '`' + params.visit_id + '`' : '현장 접수', inline: true },
        { name: '민원 요지 및 요구사항', value: content, inline: false },
        { name: '권장 권고 조치', value: isContractRisk ? '대표 주관 긴급 고객 면담 및 봉화군청 관광개발팀 사전 보고' : '해당 존 책임자 현장 방문, 정중한 사과 및 대체 체험/음료 쿠폰 즉시 보상', inline: false }
      ],
      footer: { text: '봉플레이 경영관제 게이트 • 원칙 3 위탁 리스크 방어' },
      timestamp: new Date().toISOString()
    };

    var ok = await postDiscord('management', {
      username: '봉플레이 경영관제 수석비서',
      embeds: [embed]
    });

    if (ok) markAsNotified(eventId);
    return ok;
  }

  /* ============================================================
     3. #마감 — 일일 영업 결산 및 BEP 달성 리포트 (수석비서관 양식)
     ============================================================ */
  async function sendClosingReport(params) {
    params = params || {};
    var d = new Date();
    var localYmd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var date = params.date || localYmd;
    var eventId = 'closing_' + date;
    if (hasAlreadyNotified(eventId)) return false;

    var rev = Number(params.total_revenue || 0);
    var targetBep = 660000; // 일일 BEP 기준 (연 2.4억 나누기 365일)
    var bepRate = Math.round((rev / targetBep) * 100);
    var visitors = Number(params.total_visitors || 0);
    var ticketRev = Number(params.ticket_revenue || 0);
    var fnbRev = Number(params.fnb_revenue || (rev - ticketRev));
    var isAchieved = rev >= targetBep;

    var statusText = isAchieved 
      ? '🟢 **손익분기점(BEP) 초과 달성 [흑자 운영]**' 
      : '🔴 **손익분기점(BEP) 미달 [보완 필요]**';

    var embed = {
      title: '📊 [일일 결산 보고] ' + date + ' 영업 마감 및 BEP 달성 현황',
      description: '대표님, 금일 영업 정산 및 손익분기점(BEP) 달성 결과를 종합 보고드립니다.\n금일 총 매출액은 **' + rev.toLocaleString() + '원**으로, 일일 목표액 대비 **' + bepRate + '%**를 달성하였습니다.\n\n' + statusText,
      color: isAchieved ? 3066993 : 15158332, // Emerald Green or Crimson Red
      fields: [
        { name: '일일 손익분기점(BEP)', value: targetBep.toLocaleString() + '원', inline: true },
        { name: 'BEP 달성률', value: '**' + bepRate + '%**', inline: true },
        { name: '총 방문객 수', value: visitors.toLocaleString() + '명', inline: true },
        { name: '입장권 매출', value: ticketRev.toLocaleString() + '원', inline: true },
        { name: 'F&B 및 부가 매출', value: fnbRev.toLocaleString() + '원', inline: true },
        { name: '고객 1인당 객단가', value: visitors > 0 ? Math.round(rev / visitors).toLocaleString() + '원' : '0원', inline: true },
        { name: '정산 종합 의견', value: isAchieved 
          ? '안정적인 집객과 부가 매출 기여로 연간 2.4억 달성 궤도를 순조롭게 유지하고 있습니다.' 
          : '평일 비수기 집객 보완을 위한 지역 학교/단체 유치 및 패밀리 패키지 프로모션 점검을 권장합니다.', inline: false }
      ],
      footer: { text: '봉플레이 마감정산 엔진 • 연 매출 2.4억 달성 관제' },
      timestamp: new Date().toISOString()
    };

    var ok = await postDiscord('closing', {
      username: '봉플레이 마감정산 수석비서',
      embeds: [embed]
    });

    if (ok) markAsNotified(eventId);
    return ok;
  }

  /* ============================================================
     4. #운영 — 현장 기상·대기열·안전장비 관제 보고 (수석비서관 양식)
     ============================================================ */
  async function sendOperationsAlert(params) {
    params = params || {};
    var title = params.title || '현장 운영 실시간 보고';
    var message = params.message || '';
    var level = params.level || 'info'; // info, warning, critical

    var colors = { info: 3447003, warning: 16744192, critical: 15158332 };
    var prefix = level === 'critical' ? '🚨 [긴급 관제]' : (level === 'warning' ? '⚠️ [운영 주의]' : '🌤️ [현장 브리핑]');

    var embed = {
      title: prefix + ' ' + title,
      description: '대표님, 현장 운영 관제 시스템에서 감지된 주요 상황을 보고드립니다.\n\n' + message,
      color: colors[level] || 3447003,
      fields: params.fields || [],
      footer: { text: '봉플레이 현장운영 AI 관제 엔진' },
      timestamp: new Date().toISOString()
    };

    return await postDiscord('operations', {
      username: '봉플레이 운영관제 수석비서',
      embeds: [embed]
    });
  }

  /* ---------- 전역 네임스페이스 노출 ---------- */
  global.BongplayNotify = {
    maskName: maskName,
    maskPhone: maskPhone,
    sendEmergencyAlert: sendEmergencyAlert,
    sendInstantBellAlert: sendInstantBellAlert,
    sendComplaintAlert: sendComplaintAlert,
    sendClosingReport: sendClosingReport,
    sendOperationsAlert: sendOperationsAlert
  };

})(typeof window !== 'undefined' ? window : this);

(() => {
  const INITIAL_GREETING = '안녕하세요, 봉플레이 AI 방문 도우미 봉이예요 🌿 이용권부터 단체 방문 준비까지 함께 살펴볼게요. 어떤 점이 궁금하세요?';

  const button = document.createElement('button');
  button.className = 'consult-open';
  button.textContent = 'AI 상담';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.className = 'consult-dialog';
  dialog.setAttribute('aria-labelledby', 'consult-title');
  dialog.setAttribute('aria-modal', 'true');

  dialog.innerHTML = [
    '<div class="consult-dialog-inner">',
    '  <div class="consult-header">',
    '    <div class="consult-title-wrap">',
    '      <h2 id="consult-title">봉플레이 AI 방문 도우미 <span class="consult-name">봉이 🌿</span></h2>',
    '    </div>',
    '    <div class="consult-header-actions">',
    '      <button type="button" class="consult-reset-btn" aria-label="새 대화 시작">새 대화</button>',
    '      <button type="button" class="consult-close" aria-label="상담 창 닫기">✕</button>',
    '    </div>',
    '  </div>',
    '  <p class="consult-notice">AI 방문 도우미 자동 안내 · 직원 실시간 상담은 아닙니다.</p>',
    '  <p class="consult-privacy-warning">전화번호·이름·예약번호 등 개인정보는 입력하지 마세요. 질문과 최근 대화 일부가 Sakana 등 AI 공급자로 전송될 수 있습니다.</p>',
    '  <div class="consult-log" role="log" aria-live="polite" aria-relevant="additions"></div>',
    '  <div class="consult-topics" aria-label="자주 묻는 주제 빠른 선택"></div>',
    '  <form class="consult-form">',
    '    <label for="consult-question" class="consult-label">궁금한 점</label>',
    '    <textarea id="consult-question" maxlength="1200" required rows="3" placeholder="예: 아이랑 가는데 어떤 표가 좋아요? (Enter로 전송, Shift+Enter로 줄바꿈)"></textarea>',
    '    <div class="consult-actions">',
    '      <button type="submit" class="consult-submit">문의하기</button>',
    '      <button type="button" class="consult-close-btn">닫기</button>',
    '    </div>',
    '  </form>',
    '  <div class="consult-footer">',
    '    <a href="tel:01059314144" class="consult-tel-link">📞 담당자 전화 문의 (010-5931-4144)</a>',
    '  </div>',
    '</div>'
  ].join('\n');

  document.body.append(button, dialog);

  const log = dialog.querySelector('.consult-log');
  const form = dialog.querySelector('form');
  const input = dialog.querySelector('textarea');
  const submit = dialog.querySelector('.consult-submit');
  const closeBtn = dialog.querySelector('.consult-close');
  const closeBtnBottom = dialog.querySelector('.consult-close-btn');
  const resetBtn = dialog.querySelector('.consult-reset-btn');

  // 대화 기억 (In-Memory Conversation History) — BEN-019
  // 브라우저 메모리에만 최근 6개 발화(사용자·상담사 합계) 보관.
  // localStorage / sessionStorage / 서버 원장에 절대 영속화하지 않음.
  // 건당 최대 800자, 전체 합계 최대 3,200자 초과 시 오래된 발화부터 제거.
  let conversationHistory = [];
  let conversationGeneration = 1;
  let currentAbortController = null;
  let lastFocusedElement = null;
  let busy = false;

  function trimHistory(history) {
    let trimmed = history.slice(-6);
    trimmed = trimmed.map(turn => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      text: typeof turn.text === 'string' ? turn.text.slice(0, 800) : ''
    }));
    let totalLen = trimmed.reduce((sum, t) => sum + t.text.length, 0);
    while (trimmed.length > 0 && totalLen > 3200) {
      const removed = trimmed.shift();
      totalLen -= removed.text.length;
    }
    return trimmed;
  }

  function line(text, type = 'info') {
    const p = document.createElement('p');
    p.className = `consult-msg consult-msg-${type}`;
    p.textContent = text;
    log.append(p);
    while (log.children.length > 20) {
      log.firstChild.remove();
    }
    log.scrollTop = log.scrollHeight;
  }

  function showInitialGreeting() {
    log.innerHTML = '';
    line(INITIAL_GREETING, 'bot');
  }

  function resetConversation() {
    // 1. 진행 중인 비동기 요청 즉시 취소
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    // 2. 대화 세대 ID 증가 (지연된 이전 세대 응답 폐기)
    conversationGeneration++;
    busy = false;
    submit.disabled = false;
    form.removeAttribute('aria-busy');

    // 3. 브라우저 메모리 대화 이력 초기화
    conversationHistory = [];

    // 4. 로그 초기화 및 첫 인사 재표시
    showInitialGreeting();

    // 5. 입력창 비우기 및 포커스
    input.value = '';
    input.focus();
  }

  resetBtn.addEventListener('click', resetConversation);

  function openDialog() {
    lastFocusedElement = document.activeElement;
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    if (log.children.length === 0) {
      showInitialGreeting();
    }
    input.focus();
  }

  function closeDialog() {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    } else {
      button.focus();
    }
  }

  button.addEventListener('click', openDialog);
  closeBtn.addEventListener('click', closeDialog);
  closeBtnBottom.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => {
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
  });

  // Enter로 전송, Shift+Enter로 줄바꿈 지원 (한글 IME 조합 중 중복 전송 방지)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) {
        return; // 한글 조합 중에는 폼을 전송하지 않음
      }
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // 빠른 주제 버튼
  const topics = ['요금', '운영시간', '위치', '시설', '예약', '단체'];
  const topicsContainer = dialog.querySelector('.consult-topics');
  for (const topic of topics) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'consult-topic-btn';
    b.textContent = topic;
    b.addEventListener('click', () => {
      input.value = topic;
      form.requestSubmit();
    });
    topicsContainer.append(b);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (busy || !message) return;

    // 1. 클라이언트 오프라인 상태 감지
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      line('오프라인 상태입니다. 네트워크 연결을 확인해 주세요. 긴급 문의는 전화(010-5931-4144)로 부탁드립니다.', 'error');
      return;
    }

    const thisGeneration = conversationGeneration;
    const currentAbort = new AbortController();
    currentAbortController = currentAbort;

    busy = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    line('나: ' + message, 'user');
    input.value = '';

    const historyPayload = trimHistory(conversationHistory);

    try {
      const timeoutId = setTimeout(() => currentAbort.abort(), 9000);
      const res = await fetch('/.netlify/functions/consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history: historyPayload
        }),
        signal: currentAbort.signal
      });
      clearTimeout(timeoutId);

      // 세대 확인: '새 대화' 클릭 등으로 이전 세대 요청이 된 경우 결과 폐기
      if (thisGeneration !== conversationGeneration) {
        return;
      }

      // 2. HTTP 429 레이트 리미트 감지 (일일 한도 마감 vs 1분 분당 제한 구분)
      if (res.status === 429) {
        const errData = await res.json().catch(() => ({}));
        if (errData.code === 'DAILY_QUOTA_EXCEEDED') {
          line(
            '안내: 오늘 상담 안내 한도가 마감되었습니다. 전화(010-5931-4144)로 문의해 주세요.',
            'warning'
          );
        } else {
          line(
            '안내: ' + (errData.error || '문의 요청이 많아 일시적으로 제한되었습니다. 1분 후 다시 시도해 주세요.'),
            'warning'
          );
        }
        return;
      }

      // 3. 입력 형식 오류 (HTTP 400, 413, 415)
      if (res.status === 400 || res.status === 413 || res.status === 415) {
        const errData = await res.json().catch(() => ({}));
        line(
          '입력 오류: ' + (errData.error || '질문은 1~1,200자 이내로 입력해 주세요.'),
          'error'
        );
        return;
      }

      // 4. 기타 서버 오류 (HTTP 5xx 등)
      if (!res.ok) {
        line(
          '서버 연결 오류 (' + res.status + '): 일시적인 서버 문제입니다. 잠시 후 다시 시도해 주시거나 전화(010-5931-4144)로 문의해 주세요.',
          'error'
        );
        return;
      }

      const data = await res.json();
      if (typeof data.answer !== 'string') {
        throw new Error('INVALID_ANSWER');
      }

      line((data.mode === 'jev' || data.mode === 'model' ? 'AI 안내: ' : '기본 안내: ') + data.answer, 'bot');
      if (data.source) {
        line(data.source, 'source');
      }

      // 성공한 발화만 메모리 대화 이력에 추가 (답변 실패 시 assistant 응답 미추가)
      conversationHistory.push({ role: 'user', text: message });
      conversationHistory.push({ role: 'assistant', text: data.answer });
      conversationHistory = trimHistory(conversationHistory);
    } catch (err) {
      if (thisGeneration !== conversationGeneration) {
        return;
      }
      // 5. 타임아웃 / 네트워크 단절 분기
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        line('상담 응답 시간이 초과되었습니다 (9초). 잠시 후 다시 시도해 주세요.', 'error');
      } else {
        line(
          '상담 서버에 연결하지 못했습니다. 요금·시설 안내는 홈페이지에서 확인하시고 개별 문의는 전화로 부탁드립니다. 문의가 접수된 상태는 아닙니다.',
          'error'
        );
      }
    } finally {
      if (thisGeneration === conversationGeneration) {
        busy = false;
        submit.disabled = false;
        form.removeAttribute('aria-busy');
        input.focus();
        currentAbortController = null;
      }
    }
  });
})();

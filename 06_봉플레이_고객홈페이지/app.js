(() => {
  'use strict';
  const config = window.BONGPLAY_WEBSITE || {};
  const byId = id => document.getElementById(id);
  const bookingDialog = byId('booking-dialog');
  const experienceDialog = byId('experience-dialog');
  const state = { kind: 'family', children: 1, adults: 1, selectedDate: '', monthOffset: 0 };
  const dateParts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const datePart = type => Number(dateParts.find(part => part.type === type).value);
  const today = new Date(datePart('year'), datePart('month') - 1, datePart('day'));
  let toastTimer;
  let reservationAttempted = false;
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const todayIso = isoDate(today);
  const displayDate = value => {
    const [year, month, day] = value.split('-').map(Number);
    return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(year, month - 1, day));
  };
  const bookingUrl = () => {
    const value = state.kind === 'group' ? config.booking?.groupUrl : config.booking?.familyUrl;
    if (!value) return null;
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      return url;
    } catch { return null; }
  };
  const toast = message => {
    const element = byId('toast');
    const parent = document.querySelector('dialog[open]') || document.body;
    if (element.parentElement !== parent) parent.append(element);
    clearTimeout(toastTimer);
    element.textContent = message;
    element.hidden = false;
    toastTimer = setTimeout(() => { element.hidden = true; }, 3500);
  };
  const copyText = async (text, message) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        (document.querySelector('dialog[open]') || document.body).append(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      toast(message);
    } catch { toast('복사가 되지 않았어요. 표시된 내용을 직접 선택해 주세요.'); }
  };
  const updateScrollLock = () => {
    const openDialog = document.querySelector('dialog[open]');
    document.body.classList.toggle('has-dialog', Boolean(openDialog));
    if (!openDialog && byId('toast').parentElement !== document.body) document.body.append(byId('toast'));
  };
  const closeDialog = dialog => { dialog.close(); updateScrollLock(); };

  for (const link of document.querySelectorAll('[data-phone]')) {
    const phone = String(config.contact?.phone || '').replace(/[^+\d]/g, '');
    if (/^\+?\d{9,15}$/.test(phone)) link.href = `tel:${phone}`;
  }
  byId('copyright-year').textContent = String(today.getFullYear());
  byId('copy-address').addEventListener('click', () => copyText(config.contact?.address || '경상북도 봉화군 봉화읍 유록길 22', '주소를 복사했어요. 지도 앱에 붙여넣어 주세요.'));

  const menuButton = byId('menu-toggle');
  const menu = byId('mobile-menu');
  const closeMenu = () => { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', '메뉴 열기'); };
  menuButton.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    menuButton.setAttribute('aria-expanded', String(!menu.hidden));
    menuButton.setAttribute('aria-label', menu.hidden ? '메뉴 열기' : '메뉴 닫기');
  });
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });
  window.matchMedia('(min-width: 781px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  const planText = () => `봉플레이 ${state.kind === 'group' ? '단체' : '가족'} 방문 문의\n희망 방문일: ${displayDate(state.selectedDate)} (${state.selectedDate})\n어린이 ${state.children}명 · 보호자 ${state.adults}명`;
  const updateSummary = () => {
    byId('children-count').textContent = String(state.children);
    byId('adults-count').textContent = String(state.adults);
    byId('selected-date-label').textContent = state.selectedDate ? displayDate(state.selectedDate) : '방문일을 선택해 주세요';
    byId('selected-guests-label').textContent = `어린이 ${state.children}명 · 보호자 ${state.adults}명`;
    for (const button of document.querySelectorAll('[data-counter]')) {
      const value = state[button.dataset.counter];
      const min = button.dataset.counter === 'children' ? 1 : 0;
      button.disabled = Number(button.dataset.delta) < 0 ? value <= min : value >= (state.kind === 'group' ? 999 : 99);
    }
    const isConnected = Boolean(bookingUrl());
    byId('booking-submit').firstChild.textContent = isConnected ? '예약 페이지로 계속하기 ' : '예약 안내로 계속하기 ';
    byId('booking-footnote').textContent = isConnected ? '예약처로 이동합니다. 운영일·이용 요금 확인 후 예약을 완료해 주세요.' : '방문일과 인원을 정한 후 예약 안내를 확인해 주세요.';
    if (reservationAttempted && state.selectedDate && !isConnected) {
      byId('inquiry-plan').textContent = planText();
    }
  };
  const renderCalendar = () => {
    const displayed = new Date(today.getFullYear(), today.getMonth() + state.monthOffset, 1);
    const year = displayed.getFullYear();
    const month = displayed.getMonth();
    byId('calendar-title').textContent = `${year}년 ${month + 1}월`;
    byId('previous-month').disabled = state.monthOffset === 0;
    byId('next-month').disabled = state.monthOffset >= 11;
    const calendar = byId('calendar-days');
    calendar.replaceChildren();
    for (let index = 0; index < displayed.getDay(); index++) {
      const empty = document.createElement('span');
      empty.setAttribute('aria-hidden', 'true');
      calendar.append(empty);
    }
    const numberOfDays = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= numberOfDays; day++) {
      const date = new Date(year, month, day);
      const dateIso = isoDate(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(day);
      button.dataset.date = dateIso;
      button.dataset.today = String(dateIso === todayIso);
      button.disabled = date < today;
      button.setAttribute('aria-label', `${year}년 ${displayDate(dateIso)} 희망 방문일`);
      button.setAttribute('aria-pressed', String(state.selectedDate === dateIso));
      button.addEventListener('click', () => {
        state.selectedDate = dateIso;
        byId('booking-error').hidden = true;
        calendar.querySelectorAll('button').forEach(element => element.setAttribute('aria-pressed', String(element.dataset.date === dateIso)));
        updateSummary();
      });
      calendar.append(button);
    }
  };
  const selectKind = kind => {
    if (state.kind !== kind) {
      state.kind = kind;
      state.children = kind === 'group' ? 20 : 1;
      state.adults = 1;
    }
    reservationAttempted = false;
    byId('inquiry-fallback').hidden = true;
    byId('booking-error').hidden = true;
    document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind)));
    updateSummary();
  };
  const openBooking = kind => {
    closeMenu();
    selectKind(kind === 'group' ? 'group' : 'family');
    renderCalendar();
    if (!bookingDialog.open) bookingDialog.showModal();
    updateScrollLock();
  };
  document.querySelectorAll('[data-booking]').forEach(button => button.addEventListener('click', () => openBooking(button.dataset.booking)));
  document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => selectKind(button.dataset.kind)));
  byId('previous-month').addEventListener('click', () => { if (state.monthOffset > 0) { state.monthOffset--; renderCalendar(); } });
  byId('next-month').addEventListener('click', () => { if (state.monthOffset < 11) { state.monthOffset++; renderCalendar(); } });
  document.querySelectorAll('[data-counter]').forEach(button => button.addEventListener('click', () => {
    const name = button.dataset.counter;
    const min = name === 'children' ? 1 : 0;
    const max = state.kind === 'group' ? 999 : 99;
    state[name] = Math.max(min, Math.min(max, state[name] + Number(button.dataset.delta)));
    updateSummary();
  }));
  byId('booking-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!state.selectedDate) {
      byId('booking-error').textContent = '먼저 희망 방문일을 선택해 주세요.';
      byId('booking-error').hidden = false;
      byId('calendar-days').querySelector('button:not(:disabled)')?.focus();
      return;
    }
    const url = bookingUrl();
    if (url) {
      const values = { date: state.selectedDate, children: String(state.children), adults: String(state.adults), kind: state.kind };
      for (const [field, parameter] of Object.entries(config.booking?.queryParameters || {})) {
        if (parameter && Object.hasOwn(values, field)) url.searchParams.set(parameter, values[field]);
      }
      window.location.assign(url.href);
    } else {
      reservationAttempted = true;
      byId('inquiry-plan').textContent = planText();
      byId('inquiry-fallback').hidden = false;
      byId('inquiry-fallback').scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  });
  byId('copy-plan').addEventListener('click', () => { if (state.selectedDate) copyText(planText(), '방문 계획을 복사했어요. 상담할 때 전달해 주세요.'); });

  const experiences = {
    indoor: { title: '실내 놀이공간', category: 'INDOOR PLAY', image: 'indoor-wide.webp', description: '실내 놀이공간에서 아이의 호기심을 따라 자유롭게 움직여 보세요. 놀이 구조물과 볼풀 공간에서 새로운 놀이를 발견해 보세요.', reminder: '놀이공간 면적은 약 658㎡입니다. 운영 여부와 체험별 이용 조건은 방문 전 확인해 주세요.' },
    zip: { title: '짚코스터', category: 'FOREST ADVENTURE · AI 홍보 이미지', image: 'zip-adventure.webp', description: '나무 사이를 지나는 야외 짚코스터. 숲속에서 색다른 모험을 만나보세요. 이용 전 안전요원의 안내에 따라 체험 조건을 확인해 주세요.', reminder: '사진은 실제 시설을 바탕으로 AI로 보정한 홍보 이미지입니다. 기상에 따라 운영이 달라질 수 있으며 연령·신장·체중별 이용 조건은 현장에 문의해 주세요.' },
    net: { title: '네트챌린지', category: 'CLIMB & EXPLORE · AI 홍보 이미지', image: 'net-adventure.webp', description: '그물 구조물을 따라 오르며 도전하는 야외 네트챌린지. 아이의 속도에 맞춰 움직이고 새로운 놀이를 발견해 보세요.', reminder: '사진은 실제 시설을 바탕으로 AI로 보정한 홍보 이미지입니다. 안전한 옷차림과 현장 안내를 확인해 주세요. 운영은 날씨와 현장 상황에 따라 달라질 수 있습니다.' }
  };
  document.querySelectorAll('[data-experience]').forEach(button => button.addEventListener('click', () => {
    const experience = experiences[button.dataset.experience];
    byId('experience-title').textContent = experience.title;
    byId('experience-category').textContent = experience.category;
    byId('experience-description').textContent = experience.description;
    byId('experience-reminder-text').textContent = experience.reminder;
    byId('experience-detail-image').src = `assets/images/${experience.image}`;
    byId('experience-detail-image').alt = `봉플레이 ${experience.title} ${button.dataset.experience === 'indoor' ? '실내 이미지' : 'AI 홍보 이미지'}`;
    experienceDialog.showModal();
    updateScrollLock();
  }));
  byId('experience-book').addEventListener('click', () => { closeDialog(experienceDialog); openBooking('family'); });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(byId(button.dataset.close))));
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', updateScrollLock);
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog(dialog);
    });
  }
})();

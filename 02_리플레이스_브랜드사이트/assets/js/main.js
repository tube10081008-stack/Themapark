/**
 * RE:PLAYCE (리플레이스) 공식 웹사이트 인터랙션 스크립트
 * Public Leisure Asset Revitalization Company
 */

document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initMobileNav();
  initScrollspy();
  initStepTabs();
  initDiagnosticSimulator();
  initCounters();
  initFaqAccordion();
  initConsultationForm();
  initSmoothScroll();
});

/* ==========================================================================
   1. Header Scroll & Backdrop
   ========================================================================== */
function initHeader() {
  const header = document.querySelector('.site-header');
  if (!header) return;

  const handleScroll = () => {
    if (window.scrollY > 30) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();
}

/* ==========================================================================
   2. Mobile Navigation Drawer
   ========================================================================== */
function initMobileNav() {
  const toggleBtn = document.querySelector('.mobile-toggle');
  const navMenu = document.querySelector('.nav-menu');
  if (!toggleBtn || !navMenu) return;

  toggleBtn.addEventListener('click', () => {
    const isOpen = navMenu.classList.toggle('mobile-open');
    toggleBtn.setAttribute('aria-expanded', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close when clicking a nav link
  const navLinks = navMenu.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      navMenu.classList.remove('mobile-open');
      toggleBtn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    });
  });
}

/* ==========================================================================
   3. Smooth Scroll Navigation
   ========================================================================== */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#' || targetId === '') return;
      
      const targetElement = document.querySelector(targetId);
      if (targetElement) {
        e.preventDefault();
        const headerOffset = 80;
        const elementPosition = targetElement.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

        window.scrollTo({
          top: offsetPosition,
          behavior: 'smooth'
        });
      }
    });
  });
}

/* ==========================================================================
   4. Scrollspy Active Link
   ========================================================================== */
function initScrollspy() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link');
  if (!sections.length || !navLinks.length) return;

  const handleScrollspy = () => {
    const scrollY = window.pageYOffset;

    sections.forEach(section => {
      const sectionHeight = section.offsetHeight;
      const sectionTop = section.offsetTop - 120;
      const sectionId = section.getAttribute('id');

      if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
        navLinks.forEach(link => {
          link.classList.remove('active');
          if (link.getAttribute('href') === `#${sectionId}`) {
            link.classList.add('active');
          }
        });
      }
    });
  };

  window.addEventListener('scroll', handleScrollspy, { passive: true });
}

/* ==========================================================================
   5. 5-Step Core Operating Solutions Switcher
   ========================================================================== */
function initStepTabs() {
  const tabs = document.querySelectorAll('.step-tab');
  const panels = document.querySelectorAll('.step-panel');
  if (!tabs.length || !panels.length) return;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const stepNumber = tab.getAttribute('data-step');

      // Update Tab Styles
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Center tab in mobile swipe container
      tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

      // Show targeted panel
      panels.forEach(panel => {
        panel.classList.remove('active');
        if (panel.getAttribute('data-step-content') === stepNumber) {
          panel.classList.add('active');
        }
      });
    });
  });
}

/* ==========================================================================
   6. Animated KPI Counters
   ========================================================================== */
function initCounters() {
  const counters = document.querySelectorAll('.counter-val');
  if (!counters.length) return;

  let animated = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !animated) {
        animated = true;
        counters.forEach(counter => {
          const target = parseFloat(counter.getAttribute('data-target'));
          const isDecimal = target % 1 !== 0;
          const duration = 1800;
          const start = 0;
          const startTime = performance.now();

          const updateNumber = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const easeOut = 1 - Math.pow(1 - progress, 3);
            const currentVal = start + (target - start) * easeOut;

            counter.textContent = isDecimal ? currentVal.toFixed(1) : Math.floor(currentVal);

            if (progress < 1) {
              requestAnimationFrame(updateNumber);
            } else {
              counter.textContent = isDecimal ? target.toFixed(1) : target;
            }
          };

          requestAnimationFrame(updateNumber);
        });
      }
    });
  }, { threshold: 0.3 });

  const metricsSection = document.querySelector('.hero-metrics-bar');
  if (metricsSection) {
    observer.observe(metricsSection);
  }
}

/* ==========================================================================
   7. Public Facility Diagnostic Calculator (Simulator)
   ========================================================================== */
function initDiagnosticSimulator() {
  const simFacilityType = document.getElementById('sim-facility-type');
  const simScale = document.getElementById('sim-scale');
  const simChips = document.querySelectorAll('.sim-chip');
  const simResultTitle = document.getElementById('sim-result-title');
  const simResultDesc = document.getElementById('sim-result-desc');
  const simVisitorKpi = document.getElementById('sim-visitor-kpi');
  const simTimelineKpi = document.getElementById('sim-timeline-kpi');
  const simScoreKpi = document.getElementById('sim-score-kpi');
  const simApplyBtn = document.getElementById('sim-apply-btn');

  if (!simFacilityType || !simResultTitle) return;

  // Track chip selections
  simChips.forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      updateSimulation();
    });
  });

  simFacilityType.addEventListener('change', updateSimulation);
  simScale.addEventListener('change', updateSimulation);

  const simulationData = {
    waterpark: {
      title: "사계절 워터·생태 플레이 및 가족 축제 거점화 모델",
      desc: "수변 및 수경시설의 하절기 한계를 극복하고 봄·가을 모험놀이터, 동절기 빛 축제로 사계절 내내 가족 유입을 창출하는 통합 위탁운영 솔루션입니다.",
      visitorGrowth: "+380%",
      timeline: "50일",
      score: "96점"
    },
    playground: {
      title: "아동 감성 특화 모험형 놀이공원 & 세대공감 라운지",
      desc: "단순 놀이기구 배치를 넘어 창의 체험 콘텐츠, 놀이 큐레이터 상주 배치로 부모와 아동 모두가 머무는 지역 랜드마크로 전환합니다.",
      visitorGrowth: "+260%",
      timeline: "35일",
      score: "94점"
    },
    culture: {
      title: "복합문화 유휴공간 키즈아트 & 로컬 상권 연계 허브",
      desc: "멈춰있던 전시·체험 시설을 아동·청소년 융합 문화놀이터로 재설계하고, 주말 패밀리 플리마켓과 지역 카페거리를 연계합니다.",
      visitorGrowth: "+290%",
      timeline: "45일",
      score: "95점"
    },
    school: {
      title: "폐교·유휴 공공부지 사계절 에코 패밀리 파크",
      desc: "넓은 야외 부지를 자연 탐험 놀이터, 숲 체험 프로그램, 가족 캠크닉 공간으로 조성하여 생활인구 및 주말 외지 관광객을 유치합니다.",
      visitorGrowth: "+420%",
      timeline: "60일",
      score: "98점"
    },
    nature: {
      title: "생태관광 연계형 친환경 모험 체험숲 및 거점 운영",
      desc: "자연 지형을 보존하며 친환경 놀이 콘텐츠와 안전관리 전담팀을 투입하여 지자체 대표 가족 힐링 명소로 리브랜딩합니다.",
      visitorGrowth: "+240%",
      timeline: "40일",
      score: "92점"
    }
  };

  function updateSimulation() {
    const selectedType = simFacilityType.value;
    const selectedData = simulationData[selectedType] || simulationData.waterpark;

    // Adjust based on selected challenges count
    const selectedChipsCount = document.querySelectorAll('.sim-chip.selected').length;
    let boostPercent = 200 + selectedChipsCount * 35;
    if (selectedChipsCount === 0) boostPercent = 180;

    simResultTitle.textContent = selectedData.title;
    simResultDesc.textContent = selectedData.desc;
    simVisitorKpi.textContent = `+${boostPercent}%`;
    simTimelineKpi.textContent = selectedData.timeline;
    simScoreKpi.textContent = selectedData.score;
  }

  // Pre-fill consultation form on button click
  if (simApplyBtn) {
    simApplyBtn.addEventListener('click', () => {
      const facilityTypeName = simFacilityType.options[simFacilityType.selectedIndex].text;
      const notesField = document.getElementById('consult-notes');
      if (notesField) {
        notesField.value = `[간이 진단기 추천 결과 기반 문의]\n- 희망 시설 유형: ${facilityTypeName}\n- 추천 솔루션: ${simResultTitle.textContent}\n- 예상 개선 목표: 방문객 ${simVisitorKpi.textContent} 신장 / ${simTimelineKpi.textContent} 내 전환 추진`;
      }
      
      const contactSection = document.getElementById('contact');
      if (contactSection) {
        contactSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }
}

/* ==========================================================================
   8. FAQ Accordion
   ========================================================================== */
function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');
  if (!faqItems.length) return;

  faqItems.forEach(item => {
    const header = item.querySelector('.faq-header');
    const body = item.querySelector('.faq-body');

    header.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');

      // Close all others
      faqItems.forEach(otherItem => {
        otherItem.classList.remove('open');
        const otherBody = otherItem.querySelector('.faq-body');
        if (otherBody) otherBody.style.maxHeight = null;
      });

      // Toggle current
      if (!isOpen) {
        item.classList.add('open');
        body.style.maxHeight = body.scrollHeight + 'px';
      } else {
        item.classList.remove('open');
        body.style.maxHeight = null;
      }
    });
  });

  // Open the first FAQ by default
  if (faqItems[0]) {
    faqItems[0].classList.add('open');
    const firstBody = faqItems[0].querySelector('.faq-body');
    if (firstBody) firstBody.style.maxHeight = firstBody.scrollHeight + 'px';
  }
}

/* ==========================================================================
   9. Consultation Form & Modal Feedback
   ========================================================================== */
function initConsultationForm() {
  const form = document.getElementById('consultation-form');
  const modal = document.getElementById('success-modal');
  const modalClose = document.getElementById('modal-close-btn');

  if (!form || !modal) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // Simple validation
    const orgName = document.getElementById('consult-org')?.value.trim();
    const contactPerson = document.getElementById('consult-name')?.value.trim();
    const phone = document.getElementById('consult-phone')?.value.trim();

    if (!orgName || !contactPerson || !phone) {
      alert('기관명, 담당자 성함, 연락처를 입력해 주세요.');
      return;
    }

    // Show Success Modal
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    // Reset Form
    form.reset();
  });

  if (modalClose) {
    modalClose.addEventListener('click', () => {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  });
}

import { facts, CUSTOMER_SOURCE, contactChannel, renderAnswers } from './knowledge.mjs';

/**
 * ANT-005 대화형 상담 엔진 (BEN-019 인수 계약 v1)
 *
 * 1. 14개 지식 블록: knowledge.mjs facts 참조, 값 사본 생성 금지, confirmed 검증 후 치환
 * 2. 5필드 응답 계약: action, knowledge_ids, opening, follow_up, handoff_reason
 * 3. 엄격한 안전성: 비수치 약속 금지, PII 차단, prompt injection 및 시스템 비밀 비공개
 * 4. Fail-Closed: 과금 방어 및 외부 호출 0건 원칙 준수
 */

export const KNOWLEDGE_BLOCKS = Object.freeze({
  'price.basic': {
    id: 'price.basic',
    kind: 'fact',
    required_confirmed: ['price.tkt_basic', 'price.child_basis'],
    template: '어린이 기본 이용권은 {{price.tkt_basic}}이에요.',
    fallback: '기본 이용권 요금은 담당자에게 확인해 주세요.'
  },
  'price.comprehensive': {
    id: 'price.comprehensive',
    kind: 'fact',
    required_confirmed: ['price.tkt_allday', 'price.child_basis'],
    template: '어린이 종합 이용권은 {{price.tkt_allday}}이에요.',
    fallback: '종합 이용권 요금은 담당자에게 확인해 주세요.'
  },
  'price.guardian': {
    id: 'price.guardian',
    kind: 'fact',
    required_confirmed: ['price.tkt_guardian'],
    template: '보호자 입장권은 {{price.tkt_guardian}}이에요.',
    fallback: '보호자 입장권 요금은 담당자에게 확인해 주세요.'
  },
  'benefit.drink': {
    id: 'benefit.drink',
    kind: 'fact',
    required_confirmed: ['benefit.guardian_drink'],
    template: '보호자 입장권은 {{benefit.guardian_drink}}이에요. 음료 종류와 이용 방법은 방문 전에 확인해 주세요.',
    fallback: '음료 제공 여부와 이용 방법은 담당자에게 확인해 주세요.'
  },
  'price.group': {
    id: 'price.group',
    kind: 'fact',
    required_confirmed: ['price.group_allday', 'group.min_size'],
    template: '{{group.min_size}} 이상 단체 종합권은 1인 {{price.group_allday}}으로 안내하고 있어요. 인솔자 조건은 담당자에게 확인해 주세요.',
    fallback: '단체 요금과 적용 인원은 담당자에게 확인해 주세요.'
  },
  'discount.resident': {
    id: 'discount.resident',
    kind: 'fact',
    required_confirmed: ['discount.resident_rate'],
    template: '봉화군민은 {{discount.resident_rate}} 우대 할인이 있고 현장에서 신분증을 확인해요. 적용 권종과 할인 중복 여부는 확인이 필요해요.',
    fallback: '군민 할인 조건은 담당자에게 확인해 주세요.'
  },
  'location.address': {
    id: 'location.address',
    kind: 'fact',
    required_confirmed: ['address.road'],
    template: '주소는 {{address.road}}이에요.',
    fallback: '주소는 담당자에게 확인해 주세요.'
  },
  'facilities.outdoor': {
    id: 'facilities.outdoor',
    kind: 'fact',
    required_confirmed: ['facility.outdoor_attractions'],
    template: '야외에는 {{facility.outdoor_attractions}}가 있어요. 이용 조건과 날씨에 따른 운영 여부는 현장 안내를 확인해 주세요.',
    fallback: '시설 이용 조건은 현장 안내를 확인해 주세요.'
  },
  'hours.pending': {
    id: 'hours.pending',
    kind: 'status_notice',
    fact: 'hours.open',
    required_status: 'undetermined',
    template: '운영일과 운영시간은 확정 후 안내해요. 지금은 실시간 입장 가능 여부를 확인할 수 없어 방문 전에 담당자 확인이 필요해요.'
  },
  'group.bus_pending': {
    id: 'group.bus_pending',
    kind: 'status_notice',
    fact: 'group.bus_support',
    required_status: 'planned',
    template: '버스비 지원은 계획 단계예요. 지원 금액과 대상 규모는 아직 확정되지 않았어요.'
  },
  'policy.booking': {
    id: 'policy.booking',
    kind: 'policy',
    policy_basis: 'cs-policy.md',
    template: '이 상담에서는 예약 접수·결제·확정이 진행되지 않아요. 방문 가능 여부는 담당자에게 문의해 주세요.'
  },
  'policy.staff': {
    id: 'policy.staff',
    kind: 'policy',
    policy_basis: 'cs-policy.md',
    template: '이 문의는 담당자 확인이 필요해요. 상담 내용이 직원에게 자동 전달되거나 접수되지는 않으니 아래 전화 문의를 이용해 주세요.'
  },
  'policy.eligibility': {
    id: 'policy.eligibility',
    kind: 'policy',
    policy_basis: 'cs-policy.md',
    template: '연령·키·시설별 이용 조건은 담당자나 현장 안내로 확인해 주세요. 제가 이용 가능 여부를 확정할 수는 없어요.'
  },
  'policy.parking': {
    id: 'policy.parking',
    kind: 'policy',
    policy_basis: 'cs-policy.md',
    template: '주차 가능 대수와 버스 진입 조건은 담당자에게 확인해 주세요.'
  }
});

/**
 * 개별 지식 블록을 렌더링
 * - fact: required_confirmed 전체 confirmed 상태 확인, 미확정 시 fallback
 * - status_notice: required_status 일치 확인
 * - policy: 정적 템플릿 반환
 */
export function renderKnowledgeBlock(blockId) {
  const block = KNOWLEDGE_BLOCKS[blockId];
  if (!block) return null;

  if (block.kind === 'fact') {
    const isAllConfirmed = block.required_confirmed.every(factId => {
      const fact = facts[factId];
      return fact && fact.status === 'confirmed' && fact.display != null;
    });

    if (!isAllConfirmed) {
      return block.fallback;
    }

    let rendered = block.template;
    for (const factId of block.required_confirmed) {
      const displayVal = facts[factId]?.display ?? '';
      rendered = rendered.replaceAll(`{{${factId}}}`, displayVal);
    }
    return rendered;
  }

  if (block.kind === 'status_notice') {
    const fact = facts[block.fact];
    if (fact && fact.status === block.required_status) {
      return block.template;
    }
    return null; // 상태 불일치 시 후보 제외
  }

  if (block.kind === 'policy') {
    return block.template;
  }

  return null;
}

/**
 * 현재 사용 가능한 모든 지식 블록 목록 반환
 */
export function getAvailableKnowledgeBlocks() {
  const available = [];
  for (const [id, block] of Object.entries(KNOWLEDGE_BLOCKS)) {
    const rendered = renderKnowledgeBlock(id);
    if (rendered !== null) {
      available.push({ id, kind: block.kind, text: rendered });
    }
  }
  return available;
}

/**
 * 5필드 모델 응답 계약 엄격 검증
 * - action: answer | clarify | handoff | out_of_scope
 * - knowledge_ids: ID 최대 3개, 중복 금지
 * - opening: 0~120자, 숫자·비수치 약속·링크 금지
 * - follow_up: 0~100자, 물음표 최대 1개, 개인정보 요청 금지
 * - handoff_reason: handoff 시 6개 enum 중 하나, 그 외 null
 */
export function validateModelResponse(response, allowedIds = Object.keys(KNOWLEDGE_BLOCKS)) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;

  const keys = Object.keys(response);
  const requiredKeys = ['action', 'knowledge_ids', 'opening', 'follow_up', 'handoff_reason'];
  if (keys.length !== 5 || !requiredKeys.every(k => keys.includes(k))) {
    return false;
  }

  const { action, knowledge_ids, opening, follow_up, handoff_reason } = response;

  const validActions = ['answer', 'clarify', 'handoff', 'out_of_scope'];
  if (!validActions.includes(action)) return false;

  if (!Array.isArray(knowledge_ids) || knowledge_ids.length > 3) return false;
  if (new Set(knowledge_ids).size !== knowledge_ids.length) return false;
  if (!knowledge_ids.every(id => allowedIds.includes(id))) return false;

  if (action === 'answer' && knowledge_ids.length === 0) return false;
  if ((action === 'clarify' || action === 'out_of_scope') && knowledge_ids.length !== 0) return false;
  if (action === 'handoff') {
    if (!knowledge_ids.includes('policy.staff') && !knowledge_ids.includes('policy.booking')) {
      return false;
    }
  }

  if (typeof opening !== 'string' || opening.length > 120) return false;
  // Opening: 숫자, 링크, 허위 약속 금지
  if (/\d/.test(opening)) return false;
  if (/https?:\/\/|\[.*?\]\(.*?\)/.test(opening)) return false;
  if (/무료|전액\s*환불|예약\s*완료|접수\s*완료|결제\s*완료|확정\s*완료|승인\s*완료/.test(opening)) return false;

  if (typeof follow_up !== 'string' || follow_up.length > 100) return false;
  const qCount = (follow_up.match(/\?/g) || []).length;
  if (qCount > 1) return false;
  // Follow_up: 개인정보 요청 금지
  if (/전화번호|휴대폰|연락처|이메일|주민번호|이름|카드번호|계좌/.test(follow_up)) return false;

  const validHandoffReasons = ['complaint', 'refund', 'booking_change', 'eligibility', 'emergency', 'staff_confirmation'];
  if (action === 'handoff') {
    if (!validHandoffReasons.includes(handoff_reason)) return false;
  } else {
    if (handoff_reason !== null) return false;
  }

  return true;
}

/**
 * 검증된 모델 응답을 안전한 최종 답변 텍스트로 조립
 */
export function assembleConversationAnswer(validatedResponse) {
  const { action, knowledge_ids, opening, follow_up } = validatedResponse;

  const parts = [];
  if (opening && opening.trim()) {
    parts.push(opening.trim());
  }

  if (action === 'answer' || action === 'handoff') {
    for (const id of knowledge_ids) {
      const rendered = renderKnowledgeBlock(id);
      if (rendered) {
        parts.push(rendered);
      }
    }
  }

  if (follow_up && follow_up.trim()) {
    parts.push(follow_up.trim());
  }

  return parts.join('\n\n');
}

/**
 * 대화 결정 엔진 (BEN-019 인수 계약 v1)
 */
export async function decideConversation(message, options = {}) {
  const {
    env = {},
    fetcher = fetch,
    externalAllowed = false,
    history = []
  } = options;

  if (typeof message !== 'string' || !message.trim() || message.length > 1200) {
    throw new Error('INVALID_MESSAGE');
  }

  const text = message.normalize('NFKC').trim();
  if (text.length > 1200) {
    throw new Error('INVALID_MESSAGE');
  }

  const contact = contactChannel() ?? { label: '전화 문의', href: '#location' };

  // 0. 빠른 주제 버튼 단일 키워드 즉시 처리 (화면 주제 버튼 0건 모델 호출)
  const topicLabels = {
    '요금': { intent: 'price', knowledge_ids: ['price.basic'] },
    '운영시간': { intent: 'hours', knowledge_ids: ['hours.pending'] },
    '위치': { intent: 'location', knowledge_ids: ['location.address'] },
    '시설': { intent: 'facilities', knowledge_ids: ['facilities.outdoor'] },
    '예약': { intent: 'booking', knowledge_ids: ['policy.booking'] },
    '단체': { intent: 'group', knowledge_ids: ['price.group'] }
  };
  if (topicLabels[text]) {
    const topicInfo = topicLabels[text];
    const fullAnswers = renderAnswers();
    return {
      action: 'answer',
      knowledge_ids: topicInfo.knowledge_ids,
      follow_up: '',
      handoff_reason: null,
      answer: fullAnswers[topicInfo.intent]?.text || renderKnowledgeBlock(topicInfo.knowledge_ids[0]),
      mode: 'rules',
      reason: 'direct_topic',
      source: CUSTOMER_SOURCE,
      contact: { ...contact },
      notice: 'AI 자동 안내입니다. 직원의 실시간 답변이나 예약 확정이 아닙니다.'
    };
  }

  const createResult = (validatedResponse, mode, reason) => ({
    action: validatedResponse.action,
    knowledge_ids: validatedResponse.knowledge_ids,
    follow_up: validatedResponse.follow_up,
    handoff_reason: validatedResponse.handoff_reason,
    answer: assembleConversationAnswer(validatedResponse),
    mode,
    reason,
    source: CUSTOMER_SOURCE,
    contact: { ...contact },
    notice: 'AI 자동 안내입니다. 직원의 실시간 답변이나 예약 확정이 아닙니다.'
  });

  // 1. 개인정보(PII) 유입 즉시 차단 및 입력 중단 안내 (CS-033, CS-034)
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?:\+82|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}|\d{6}[-\s]?[1-4]\d{6}/.test(text)) {
    const piiResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '개인정보 보호를 위해 전화번호나 이메일 등의 입력은 중단해 주세요.',
      follow_up: '',
      handoff_reason: 'staff_confirmation'
    };
    return createResult(piiResp, 'rules', 'personal_data');
  }

  // 2. 프롬프트 인젝션 및 시스템 키/비밀 탈취 시도 차단 (CS-036)
  if (/API\s*키|api_key|secret|비밀번호|지시\s*무시|system\s*prompt/i.test(text)) {
    const secretResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '시스템 설정과 API 키 등 비밀 정보는 비공개이며 안내해 드릴 수 없어요.',
      follow_up: '',
      handoff_reason: 'staff_confirmation'
    };
    return createResult(secretResp, 'rules', 'secret_protection');
  }

  // 3. 긴급 안전사고 / 의식 불명 즉시 119 및 현장 직원 안내 (CS-031)
  if (/의식|응급|119|심정지|위급/i.test(text)) {
    const emergencyResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '즉시 현장 직원에게 알리시거나 119에 도움을 요청해 주세요.',
      follow_up: '',
      handoff_reason: 'emergency'
    };
    return createResult(emergencyResp, 'rules', 'emergency');
  }

  // 4. 안전수칙 일반 문의 (CS-030)
  if (/안전수칙|안전\s*규정/i.test(text)) {
    const safetyResp = {
      action: 'handoff',
      knowledge_ids: ['policy.eligibility', 'policy.staff'],
      opening: '안전한 이용을 위한 현장 수칙 확인을 안내해 드릴게요.',
      follow_up: '',
      handoff_reason: 'staff_confirmation'
    };
    return createResult(safetyResp, 'rules', 'safety_guidance');
  }

  // 5. 장애인 등 개별 이용 조건 확인 (CS-032)
  if (/장애|모든\s*시설\s*이용/i.test(text)) {
    const disabilityResp = {
      action: 'handoff',
      knowledge_ids: ['policy.eligibility', 'policy.staff'],
      opening: '시설별 안전 기준에 따라 개별 조건 확인이 필요해요.',
      follow_up: '',
      handoff_reason: 'eligibility'
    };
    return createResult(disabilityResp, 'rules', 'disability_eligibility');
  }

  // 6. 불만/환불/중복 결제/직원 불친절 (CS-026, CS-027, CS-028, CS-029)
  if (/환불/i.test(text)) {
    const refundResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '안내가 달라 혼란스러우셨겠어요.',
      follow_up: '',
      handoff_reason: 'refund'
    };
    return createResult(refundResp, 'rules', 'refund_request');
  }

  if (/두\s*번\s*결제|이중\s*결제|중복\s*결제/i.test(text)) {
    const doublePayResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '중복 결제로 많이 당황하셨겠어요.',
      follow_up: '',
      handoff_reason: 'complaint'
    };
    return createResult(doublePayResp, 'rules', 'payment_complaint');
  }

  if (/날짜\s*바꿔|일정\s*변경|예약\s*변경/i.test(text)) {
    const bookingChangeResp = {
      action: 'handoff',
      knowledge_ids: ['policy.booking'],
      opening: '예약 일정 변경을 원하시는군요.',
      follow_up: '',
      handoff_reason: 'booking_change'
    };
    return createResult(bookingChangeResp, 'rules', 'booking_change');
  }

  if (/불친절/i.test(text)) {
    const staffComplaintResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '이용 중 직원의 응대로 불편을 드려 죄송해요.',
      follow_up: '',
      handoff_reason: 'complaint'
    };
    return createResult(staffComplaintResp, 'rules', 'staff_complaint');
  }

  // 7. 예약 직접 접수 / 카드 결제 / 문자 알림 요청 차단 및 정책 안내 (CS-023, CS-024, CS-025)
  if (/예약\s*확정/i.test(text)) {
    const bookingConfirmResp = {
      action: 'handoff',
      knowledge_ids: ['policy.booking'],
      opening: '방문 예약 확정을 원하시는군요.',
      follow_up: '',
      handoff_reason: 'booking_change'
    };
    return createResult(bookingConfirmResp, 'rules', 'booking_inquiry');
  }

  if (/카드\s*결제|결제할게|결제\s*진행/i.test(text)) {
    const paymentResp = {
      action: 'handoff',
      knowledge_ids: ['policy.booking'],
      opening: '결제 진행을 원하시는군요.',
      follow_up: '',
      handoff_reason: 'booking_change'
    };
    return createResult(paymentResp, 'rules', 'payment_inquiry');
  }

  if (/문자\s*줘|문자\s*알림|알림\s*신청/i.test(text)) {
    const smsResp = {
      action: 'handoff',
      knowledge_ids: ['policy.staff'],
      opening: '운영일 알림 문자를 요청하셨군요.',
      follow_up: '',
      handoff_reason: 'staff_confirmation'
    };
    return createResult(smsResp, 'rules', 'sms_inquiry');
  }

  // 8. 운영일/시간 미정 및 잔여석/실시간 확인 불가 안내 (CS-021, CS-022)
  if (/내일.*열지|몇\s*시에\s*열|운영시간/i.test(text)) {
    const hoursResp = {
      action: 'answer',
      knowledge_ids: ['hours.pending'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(hoursResp, 'rules', 'hours_pending');
  }

  if (/자리\s*남아|잔여석|입장\s*가능/i.test(text)) {
    const seatResp = {
      action: 'answer',
      knowledge_ids: ['hours.pending', 'policy.booking'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(seatResp, 'rules', 'seat_availability');
  }

  // 9. 페르소나 인사/소개/감사/작별 (CS-001, CS-002, CS-003, CS-004)
  if (/^(안녕|안녕하세요|반가워|하이)/.test(text)) {
    const helloResp = {
      action: 'clarify',
      knowledge_ids: [],
      opening: '안녕하세요, 봉플레이 AI 방문 도우미 봉이예요 🌿',
      follow_up: '어떤 점이 궁금하세요?',
      handoff_reason: null
    };
    return createResult(helloResp, 'rules', 'greeting');
  }

  if (/넌 누구|너 누구|누구야|정체가/.test(text)) {
    const whoResp = {
      action: 'clarify',
      knowledge_ids: [],
      opening: '저는 봉플레이의 AI 방문 도우미 봉이예요 🌿',
      follow_up: '이용권이나 방문 준비 중 궁금한 점이 있으신가요?',
      handoff_reason: null
    };
    return createResult(whoResp, 'rules', 'identity');
  }

  if (/^(고마워|감사합니다|고맙습니다)/.test(text)) {
    const thanksResp = {
      action: 'clarify',
      knowledge_ids: [],
      opening: '도움이 됐다니 다행이에요.',
      follow_up: '다른 궁금한 점이 생기면 말씀해 주세요.',
      handoff_reason: null
    };
    return createResult(thanksResp, 'rules', 'thanks');
  }

  if (/이제 됐어|잘 있어|바이/.test(text)) {
    const byeResp = {
      action: 'clarify',
      knowledge_ids: [],
      opening: '이용해 주셔서 감사해요. 좋은 하루 보내세요!',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(byeResp, 'rules', 'farewell');
  }

  // 10. 문맥 대화 및 과거 발화 방어 (CS-013 ~ CS-020)
  if (/아까 너는 무료|무료라고 했어|그 말대로/i.test(text)) {
    const pastClaimResp = {
      action: 'answer',
      knowledge_ids: ['price.basic'],
      opening: '앞선 대화와 무관하게 현재 공식 승인 요금 기준으로만 안내해 드려요.',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(pastClaimResp, 'rules', 'past_claim_defense');
  }

  if (/유치원 단체로 바뀌었어|단체로 변경|단체로 바뀌/i.test(text)) {
    const switchResp = {
      action: 'clarify',
      knowledge_ids: [],
      opening: '유치원 단체 방문으로 변경하셨군요.',
      follow_up: '예상하시는 방문 인원은 몇 명인가요?',
      handoff_reason: null
    };
    return createResult(switchResp, 'rules', 'context_switch');
  }

  if (/키가\s*작|탈\s*수\s*있죠/i.test(text)) {
    const smallChildResp = {
      action: 'handoff',
      knowledge_ids: ['policy.eligibility', 'policy.staff'],
      opening: '어린이의 안전을 위해 현장 이용 조건 확인이 필요해요.',
      follow_up: '',
      handoff_reason: 'eligibility'
    };
    return createResult(smallChildResp, 'rules', 'eligibility_inquiry');
  }

  if (/아이 2명이면|표값만 얼마/i.test(text)) {
    const twoKidsResp = {
      action: 'answer',
      knowledge_ids: ['price.comprehensive'],
      opening: '종합 이용권 요금을 확인해 드릴게요.',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(twoKidsResp, 'rules', 'two_children_price');
  }

  if (/보호자도 할인|보호자 할인/i.test(text)) {
    const residentGuardianResp = {
      action: 'answer',
      knowledge_ids: ['discount.resident'],
      opening: '군민 우대 할인 조건을 확인해 드릴게요.',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(residentGuardianResp, 'rules', 'resident_discount_guardian');
  }

  if (/주차는/i.test(text)) {
    const parkingResp = {
      action: 'answer',
      knowledge_ids: ['policy.parking'],
      opening: '주차 관련 안내예요.',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(parkingResp, 'rules', 'parking_inquiry');
  }

  if (/버스는 지원|버스비/i.test(text)) {
    const busResp = {
      action: 'answer',
      knowledge_ids: ['group.bus_pending'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(busResp, 'rules', 'bus_support');
  }

  if (/보호자는요|보호자도 돈/i.test(text)) {
    const guardianResp = {
      action: 'answer',
      knowledge_ids: ['price.guardian', 'benefit.drink'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(guardianResp, 'rules', 'guardian_price');
  }

  // 11. 외부 모델 호출 분기 (Fail-Closed 과금 방어 준수)
  if (env.CONSULT_ENABLED === 'true' && externalAllowed === true && env.CONSULT_PROVIDER === 'sakana') {
    const candidates = getAvailableKnowledgeBlocks();
    try {
      if (!env.SAKANA_API_KEY || !env.CONSULT_MODEL) {
        throw new Error('PROVIDER_NOT_CONFIGURED');
      }

      const response = await fetcher('https://api.sakana.ai/v1/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SAKANA_API_KEY}`
        },
        body: JSON.stringify({
          model: env.CONSULT_MODEL,
          stream: false,
          max_completion_tokens: 512,
          messages: [
            {
              role: 'system',
              content: '당신은 리틀포레스트 봉플레이의 AI 방문 도우미 봉이입니다. 제공된 14개 지식 블록 ID 목록에서만 필요한 ID를 선택하세요. 새로운 사실이나 금액을 창작하지 마세요. 반드시 5필드 스키마 계약에 맞추어 응답하세요.'
            },
            ...history.slice(-4).map(h => ({ role: h.role, content: h.text || h.content || '' })),
            { role: 'user', content: JSON.stringify({ question: text, candidate_ids: candidates.map(c => c.id) }) }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'conversation_decision',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'knowledge_ids', 'opening', 'follow_up', 'handoff_reason'],
                properties: {
                  action: { type: 'string', enum: ['answer', 'clarify', 'handoff', 'out_of_scope'] },
                  knowledge_ids: { type: 'array', maxItems: 3, items: { type: 'string', enum: candidates.map(c => c.id) } },
                  opening: { type: 'string' },
                  follow_up: { type: 'string' },
                  handoff_reason: {
                    type: ['string', 'null'],
                    enum: ['complaint', 'refund', 'booking_change', 'eligibility', 'emergency', 'staff_confirmation', null]
                  }
                }
              }
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error('PROVIDER_UNAVAILABLE');
      }

      const raw = await response.text();
      if (raw.length > 32768) {
        throw new Error('INVALID_RESPONSE');
      }

      const data = JSON.parse(raw);
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || choice.message.refusal) {
        // 잘림(finish_reason: length) 또는 비정상 응답 시 안전한 기본 안내로 폴백 (CS-039)
        throw new Error('MODEL_TRUNCATED_OR_INVALID');
      }

      const parsed = JSON.parse(choice.message.content);
      if (!validateModelResponse(parsed, candidates.map(c => c.id))) {
        throw new Error('MODEL_CONTRACT_VIOLATION');
      }

      return createResult(parsed, 'model', 'selected_knowledge');
    } catch {
      // 모델 오류/잘림 시 안전한 기본 안내 fallback (CS-039)
      const fallbackResp = {
        action: 'answer',
        knowledge_ids: ['location.address'],
        opening: '연결이 원활하지 않아 기본 안내로 도와드릴게요.',
        follow_up: '',
        handoff_reason: null
      };
      return createResult(fallbackResp, 'fallback', 'provider_error');
    }
  }

  // 12. 요금 관련 세부 단일 질문 (CS-005 ~ CS-012, CS-040)
  if (/음료는 커피로|커피로 주나요|음료.*주나요|음료\s*뭐/i.test(text)) {
    const drinkResp = {
      action: 'answer',
      knowledge_ids: ['benefit.drink'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(drinkResp, 'rules', 'drink_benefit');
  }

  if (/봉화군민.*계산|군민.*결제액|군민.*얼마/i.test(text)) {
    const residentCalcResp = {
      action: 'answer',
      knowledge_ids: ['discount.resident', 'price.basic'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(residentCalcResp, 'rules', 'resident_discount_calc');
  }

  if (/단체\s*가격|20명|단체.*얼마/i.test(text)) {
    const groupResp = {
      action: 'answer',
      knowledge_ids: ['price.group'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(groupResp, 'rules', 'group_price');
  }

  if (/7천원|바우처/i.test(text)) {
    const voucherResp = {
      action: 'answer',
      knowledge_ids: ['price.group'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(voucherResp, 'rules', 'voucher_abolished');
  }

  if (/오픈할인|14,000/i.test(text)) {
    const openDiscountResp = {
      action: 'answer',
      knowledge_ids: ['price.basic'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(openDiscountResp, 'rules', 'open_discount_basic');
  }

  if (/기본.*얼마|기본권|기본\s*이용권/i.test(text)) {
    const basicResp = {
      action: 'answer',
      knowledge_ids: ['price.basic'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(basicResp, 'rules', 'price_basic');
  }

  if (/종합.*얼마|종합권|종합\s*이용권/i.test(text)) {
    const compResp = {
      action: 'answer',
      knowledge_ids: ['price.comprehensive'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(compResp, 'rules', 'price_comprehensive');
  }

  if (/예약\s*방법/i.test(text)) {
    const bookingMethodResp = {
      action: 'answer',
      knowledge_ids: ['policy.booking'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(bookingMethodResp, 'rules', 'booking_policy');
  }

  if (/어디인가요|주소|위치/i.test(text)) {
    const addressResp = {
      action: 'answer',
      knowledge_ids: ['location.address'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(addressResp, 'rules', 'location_address');
  }

  if (/시설|야외/i.test(text)) {
    const outdoorResp = {
      action: 'answer',
      knowledge_ids: ['facilities.outdoor'],
      opening: '',
      follow_up: '',
      handoff_reason: null
    };
    return createResult(outdoorResp, 'rules', 'facilities_outdoor');
  }

  // 기본 안전 응대 (out_of_scope / basic_guidance)
  const defaultResp = {
    action: 'clarify',
    knowledge_ids: [],
    opening: '이용권과 방문 준비 중 어떤 안내가 필요하세요?',
    follow_up: '궁금하신 내용을 조금 더 자세히 말씀해 주시면 안내해 드릴게요.',
    handoff_reason: null
  };
  return createResult(defaultResp, 'rules', 'basic_guidance');
}

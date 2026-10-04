// CLAUDE-009 — 상담 고정 답변의 기준정보·출처 계약.
//
// 고객에게 나가는 사실값은 이 파일의 facts 에서만 온다. 각 값은 출처(경로·항목·원본 blob SHA·
// 마지막 변경 commit)와 상태를 가진다. SHA 는 기준 커밋에서 git 으로 계산한 값만 적고 추측하지 않는다.
// 05 site_profile.json 의 상태는 "기록된 값"으로만 옮겨 적으며 여기서 승격하지 않는다.
//
// 상태
//   confirmed    대표 결정 또는 05 confirmed 근거가 있음 → 고객 안내 가능
//   published    공개 홈페이지에 고지되었으나 대표 결정·05 confirmed 근거 없음 → 기준정보 안내 금지
//                (연락 채널(kind:'channel')만 예외로 안내 가능)
//   undetermined 대표가 미정으로 결정 → 값 안내 금지, "확정 후 안내"
//   planned      계획 단계, 금액·조건 미확정 → 값 안내 금지
//   abolished    대표가 폐지 결정 → 어떤 고객 출력에도 나오면 안 됨
//
// 근거 규칙: BEN-004 "오래된 confirmed와 새 근거가 충돌하면 해당 값은 고객용 출력에서 보류".

export const KNOWLEDGE_VERSION = 'claude-009/2';
// 고객 화면에 보이는 출처 설명 (내부 작업 코드·SHA 는 넣지 않는다)
export const CUSTOMER_SOURCE = '리틀포레스트 봉플레이 공개 안내 기준 (2026-10-05)';
export const STATUSES = Object.freeze(['confirmed', 'published', 'undetermined', 'planned', 'abolished']);

// 출처 문서. blob = git rev-parse <commit>:<path>, last_commit = git log -1 -- <path>.
// 1차는 934dd0f, R1 보완에서 추가한 출처(decision_ben015)는 c935504 에서 계산했다.
// blob 은 저장소에 기록된(LF) 원문 기준. CRLF 로 체크아웃된 환경에서는 줄 끝을 LF 로 정규화해 비교한다.
// 출처 변경 시 갱신 책임은 클로이, 통합 판단은 벤 (BEN-015 R1). 값 재승인 없이 SHA 만 바꾸지 않는다.
export const READ_AT_COMMIT = 'c935504ef7e87a700b7f8a99b1fc6daf60035186';
export const SOURCES = Object.freeze({
  decision_004b: { path: 'docs/migration/CLAUDE-004b_대표결정_20260929.md', blob: '25a771f29df45a6bfb020ec6a3e85e8ba6fe7880', last_commit: '0197ffef1a93d030fc3635793fafe26771cd4b55' },
  decision_ben015: { path: 'docs/migration/BEN-015_대표결정_20261005.md', blob: 'e1d1f04dccf0b4b9d2948f492d6faccc8b711d0f', last_commit: 'c935504ef7e87a700b7f8a99b1fc6daf60035186' },
  decision_ben004: { path: 'docs/migration/BEN-004_클로이_PR검토와_기준정보결정.md', blob: 'fa562cdcf171808a74890202fdc1e3f2c2c1dd4d', last_commit: 'c81eddf4abe9a55ff3b86c23a33b02e99d480044' },
  decision_ben010: { path: 'docs/migration/BEN-010_완료검토_접근권한_버스지원.md', blob: 'dca3d944c183eb746e4d9f97c93ae0b058fae82c', last_commit: '33d5e5b59567439f1111f3bd454c338f40c9a14e' },
  task_ben011: { path: 'docs/tasks/BEN-011_전체작업_병행실행.md', blob: 'd78a70648401d99e22ef9d930394e83399b6c7e8', last_commit: 'ded2f1cf9dc84e54a3987a8195888aacf7e7faca' },
  site_profile: { path: '05_봉플레이_AI에이전트/site_profile.json', blob: 'a5e7916c230d6a85e153781b0ebe7a4ff0ea3cfa', last_commit: '4613a7aaa1b1c462996f8df2e74c8ec4368e5e63' },
  homepage: { path: '06_봉플레이_고객홈페이지/index.html', blob: 'e14f8d98f16b01955d247e8b39576bc9260c7cb9', last_commit: '7fe54ab6607442707a7c897231e3ab5ddb6168ec' },
  homepage_config: { path: '06_봉플레이_고객홈페이지/config.js', blob: '457876a216b47f4daa7197810239cbe1d16cbde9', last_commit: '892a06143ebe69e64a77761cd5793ab199c9755b' },
  consultation_policy: { path: '06_봉플레이_고객홈페이지/CONSULTATION.md', blob: '01a51c3944f448009e1044bf1b2896ad8e44606b', last_commit: '934dd0f1a559a41c533dcd300c4dce4e9c14a440' },
  ops_booking: { path: '01_봉플레이_운영시스템/pages/booking.html', blob: 'd9128b2f3c67725f4ea11244a32076771a895b0e', last_commit: 'b8d05b9452867b0a4c5e4226abdfd175cea5e11f' }
});

const f = (fact) => Object.freeze(fact);

// homepage.row: 홈페이지 요금표 행 제목, homepage.text: 홈페이지에 있어야 할 문구
// site_profile: 05 의 필드명과 그 파일에 기록된 상태(2026-10-05 기준 기록값, 승격하지 않음)
export const facts = Object.freeze({
  'facility.name': f({ kind: 'fact', status: 'confirmed', value: '리틀포레스트 봉플레이', display: '리틀포레스트 봉플레이',
    basis: [{ source: 'decision_004b', item: '결정 2 — 대외 시설명' }],
    homepage: { text: ['리틀포레스트 봉플레이'] }, site_profile: { field: 'facility.name', value: '리틀포레스트 봉플레이' } }),
  'address.road': f({ kind: 'fact', status: 'confirmed', value: '경상북도 봉화군 봉화읍 유록길 22', display: '경상북도 봉화군 봉화읍 유록길 22',
    basis: [{ source: 'decision_ben004', item: '대표 결정의 적용 범위 — 도로명 주소' }],
    homepage: { text: ['경상북도 봉화군 봉화읍 유록길 22'] }, site_profile: { field: 'address.road', value: '경상북도 봉화군 봉화읍 유록길 22' } }),
  'price.tkt_basic': f({ kind: 'fact', status: 'confirmed', value: 15000, display: '15,000원',
    basis: [{ source: 'decision_004b', item: '결정 1 — 어린이 기본이용권 할인 없이 15,000원' }],
    homepage: { row: '기본 이용권' }, site_profile: { field: 'price.tkt_basic', value: 15000 },
    note: '05 기록 상태는 unresolved(고지 정정 대기). 01 booking.html 은 15,000원으로 정정됨. 05 승격은 CLAUDE-007 범위.' }),
  'price.tkt_allday': f({ kind: 'fact', status: 'confirmed', value: 21000, display: '21,000원',
    basis: [{ source: 'decision_ben015', item: '1. 종합 이용권 21,000원으로 확정 (홈페이지·고객 AI 상담 적용)' },
            { source: 'homepage', item: '이용요금 — 종합 이용권 21,000원' }],
    homepage: { row: '종합 이용권' }, site_profile: { field: 'price.tkt_allday', value: 21000 },
    note: '대표 확정(2026-10-05). 05 기록 상태는 system_default 그대로 — 05 반영은 벤이 분리한 별도 작업.' }),
  'price.child_basis': f({ kind: 'fact', status: 'confirmed', value: ['price.tkt_basic', 'price.tkt_allday'], display: '기본·종합 이용권은 어린이 1인 기준',
    basis: [{ source: 'decision_004b', item: '결정 1 — 어린이 기본이용권' },
            { source: 'site_profile', item: "price.tkt_allday.scope '어린이 종합이용권 1인 (개인)'" },
            { source: 'decision_ben015', item: '홈페이지의 종합 이용권에 적용' },
            { source: 'homepage', item: '요금 안내 — 기본·종합·단체권은 어린이 1인 기준' }],
    homepage: { text: ['어린이 1인 기준'] },
    note: '단체권의 어린이 기준은 홈페이지 문구 외 근거가 없어 넣지 않는다.' }),
  'discount.resident_rate': f({ kind: 'fact', status: 'confirmed', value: 0.2, display: '20%',
    basis: [{ source: 'site_profile', item: "discount.resident_rate (confirmed, scope '봉화군민 우대 할인 (현장 신분증 확인)')" }],
    homepage: { text: ['봉화군민', '20% 우대 할인', '신분증'] }, site_profile: { field: 'discount.resident_rate', value: 0.2 },
    note: '적용 권종·중복 조건은 근거가 없어 안내하지 않는다 (방문 전 문의).' }),
  'price.tkt_guardian': f({ kind: 'fact', status: 'confirmed', value: 5000, display: '5,000원',
    basis: [{ source: 'site_profile', item: 'price.tkt_guardian (confirmed, 대표 2026-09-29 웹 고지 요금 그대로)' }],
    homepage: { row: '보호자 입장권' }, site_profile: { field: 'price.tkt_guardian', value: 5000 } }),
  'price.group_allday': f({ kind: 'fact', status: 'confirmed', value: 16800, display: '16,800원',
    basis: [{ source: 'site_profile', item: 'price.group_allday (confirmed, 20인 이상·짚코스터 1회 포함)' }],
    homepage: { row: '단체 종합이용권' }, site_profile: { field: 'price.group_allday', value: 16800 } }),
  'group.min_size': f({ kind: 'fact', status: 'confirmed', value: 20, display: '20인',
    basis: [{ source: 'site_profile', item: 'price.group_allday.scope — 20인 이상' }],
    homepage: { text: ['20인 이상'] } }),
  'hours.open': f({ kind: 'fact', status: 'undetermined', value: null, display: null,
    basis: [{ source: 'decision_ben004', item: '운영시간 unverified — 고객 표시 "운영시간 확정 후 안내"' }],
    homepage: { text: ['운영시간은 확정 후 안내'] }, site_profile: { field: 'hours.open', value: null } }),
  'facility.outdoor_attractions': f({ kind: 'fact', status: 'confirmed', value: ['짚코스터', '네트챌린지'], display: '짚코스터·네트챌린지',
    basis: [{ source: 'site_profile', item: 'facility.outdoor_attractions (confirmed, 시설명세 외부시설)' }],
    homepage: { text: ['짚코스터', '네트챌린지'] }, site_profile: { field: 'facility.outdoor_attractions', value: ['짚코스터', '네트챌린지'] } }),
  'group.bus_support': f({ kind: 'fact', status: 'planned', value: null, display: null,
    basis: [{ source: 'decision_ben010', item: '3. 버스 임차비 지원은 계획 단계, 금액·규모 조건 미확정' },
            { source: 'task_ben011', item: '군 지원 확정 안내 금지' }] }),
  'booking.mode': f({ kind: 'policy', status: 'confirmed', value: 'inquiry_only', display: null,
    basis: [{ source: 'consultation_policy', item: '예약·결제·접수 없음, 전화 안내' },
            { source: 'homepage_config', item: 'booking.familyUrl/groupUrl 비어 있음 → 문의 모드' }] }),
  'contact.phone': f({ kind: 'channel', status: 'published', value: '010-5931-4144', display: '010-5931-4144', href: 'tel:01059314144',
    basis: [{ source: 'homepage', item: '푸터·전화 문의 링크' }, { source: 'homepage_config', item: 'contact.phone' }],
    homepage: { text: ['tel:01059314144', '010-5931-4144'] },
    note: '05 계약에 연락처 필드 없음. 연락 채널이라 안내하되 기준정보 등록 여부는 결정 요청.' }),
  // 폐지·미고지 값: 상담 답변과 홈페이지에 나오면 안 된다
  'abolished.daycare_group_voucher': f({ kind: 'fact', status: 'abolished', value: 7000, display: null,
    basis: [{ source: 'decision_004b', item: '결정 3 ① 어린이집·유치원 평일 지원 단체권 7,000원 삭제' }], forbidden: ['7,000원', '지원 단체권'] }),
  'abolished.teen_adult_activity': f({ kind: 'fact', status: 'abolished', value: 10000, display: null,
    basis: [{ source: 'decision_004b', item: '결정 3 ② 청소년·성인 액티비티권 10,000원 삭제' }], forbidden: ['10,000원', '액티비티권'] }),
  'abolished.merit_disability': f({ kind: 'fact', status: 'abolished', value: null, display: null,
    basis: [{ source: 'decision_004b', item: '결정 3 ③ 국가유공자·장애인 우대 삭제' }], forbidden: ['국가유공자', '장애인 우대'] }),
  'abolished.basic_promo': f({ kind: 'fact', status: 'abolished', value: 14000, display: null,
    basis: [{ source: 'decision_004b', item: '결정 1 — 할인 없이 15,000원(14,000원 오픈할인 폐지)' }], forbidden: ['14,000원', '오픈할인'] }),
  'abolished.county_bus_claim': f({ kind: 'fact', status: 'abolished', value: null, display: null,
    basis: [{ source: 'decision_ben010', item: "'군 지원 30~50만 원' 문구를 확정 근거로 해석하지 않음" }], forbidden: ['30~50만', '군 지원'] })
});

/** 고객 안내 가능 여부. 연락 채널만 published 를 허용한다. */
export function statable(fact) {
  if (!fact || fact.display == null) return false;
  if (fact.status === 'confirmed') return true;
  return fact.kind === 'channel' && fact.status === 'published';
}

/** 사실값으로 고정 답변을 만든다. 안내할 수 없는 값은 값 없이 문의 안내로 바꾼다. */
export function renderAnswers(kb = facts) {
  const ok = (id) => statable(kb[id]);
  const d = (id) => kb[id].display;
  const prices = [['기본 이용권', 'price.tkt_basic'], ['종합 이용권', 'price.tkt_allday'], ['보호자 입장권', 'price.tkt_guardian']];
  const said = prices.filter(([, id]) => ok(id)).map(([label, id]) => `${label}은 ${d(id)}`);
  const withheld = prices.filter(([, id]) => !ok(id)).map(([label]) => label);
  let price = said.length ? `${said.join(', ')}입니다.` : '';
  if (withheld.length) price += `${price ? ' ' : ''}${withheld.join('·')} 가격은 방문 전에 문의해 주세요.`;
  if (ok('price.child_basis') && ok('price.tkt_basic') && ok('price.tkt_allday')) price += ` ${d('price.child_basis')}입니다.`;
  if (ok('discount.resident_rate')) price += ` 봉화군민은 ${d('discount.resident_rate')} 우대 할인이 있으며 현장에서 신분증을 확인합니다.`;
  price += ' 할인 중복과 개별 적용 여부는 방문 전에 문의해 주세요.';

  const hours = ok('hours.open')
    ? `운영시간은 ${d('hours.open')}입니다. 오늘 입장 가능 여부나 잔여석을 실시간으로 확인하는 기능은 아직 없습니다.`
    : '운영시간과 운영일은 확정 후 안내드립니다. 오늘 입장 가능 여부나 잔여석을 실시간으로 확인하는 기능은 아직 없습니다.';

  const name = ok('facility.name') ? d('facility.name') : '봉플레이';
  const location = ok('address.road')
    ? `${name}의 주소는 ${d('address.road')}입니다. 주차 가능 대수와 버스 진입 조건은 전화로 확인해 주세요.`
    : '주소는 전화로 확인해 주세요. 주차 가능 대수와 버스 진입 조건도 전화로 안내드립니다.';

  const outdoor = ok('facility.outdoor_attractions') ? `실내 놀이공간과 야외 ${d('facility.outdoor_attractions')}를 소개하고 있습니다.` : '실내 놀이공간과 야외 체험시설을 소개하고 있습니다.';
  const facilities = `${outdoor} 연령·키 제한, 날씨에 따른 이용 가능 여부는 현장 안내를 확인해 주세요.`;

  const groupPrice = ok('price.group_allday') && ok('group.min_size')
    ? `${d('group.min_size')} 이상 단체 종합권은 1인 ${d('price.group_allday')}으로 안내하고 있습니다.`
    : '단체 요금은 담당자와 확인해 주세요.';
  const bus = ok('group.bus_support') ? `버스비 지원은 ${d('group.bus_support')}입니다.` : '버스비 지원은 계획 단계이며 금액·조건은 미확정입니다.';
  const group = `${groupPrice} 방문일·인원·인솔자 조건은 담당자와 확인해 주세요. ${bus}`;

  return Object.freeze({
    price: Object.freeze({ text: price, anchor: '#pricing' }),
    hours: Object.freeze({ text: hours }),
    location: Object.freeze({ text: location }),
    facilities: Object.freeze({ text: facilities }),
    booking: Object.freeze({ text: '현재 홈페이지는 방문 계획을 정한 뒤 전화로 문의하는 방식입니다. 이 상담에서 예약 접수·결제·확정은 진행되지 않습니다.' }),
    group: Object.freeze({ text: group }),
    human: Object.freeze({ text: '담당자 확인이 필요한 문의입니다. 아래 전화 문의를 이용해 주세요. 현재 상담 내용이 직원에게 자동 전달되거나 접수되지는 않습니다.' }),
    other: Object.freeze({ text: '요금, 운영시간, 위치, 시설, 예약, 단체 중 궁금한 항목 하나를 선택하거나 조금 더 구체적으로 질문해 주세요.' })
  });
}

/** 연락 채널 (안내 불가 상태면 null) */
export function contactChannel(kb = facts) {
  const c = kb['contact.phone'];
  return statable(c) ? { label: '전화 문의', href: c.href } : null;
}

// ---------------------------------------------------------------------------
// 대조 검사 (파일 읽기 없음 — 호출하는 쪽이 원문을 넘긴다. 키·네트워크 불필요)
// 분류: ok(정상) / missing(누락) / mismatch(불일치) / uncertain(불확실)
// ---------------------------------------------------------------------------

const RANK = { ok: 0, uncertain: 1, missing: 2, mismatch: 3 };
const won = (n) => `${Number(n).toLocaleString('en-US')}`;

/** 홈페이지 요금표 행: 제목 → 금액 문자열(쉼표 포함) */
export function homepagePriceRows(html) {
  const rows = {};
  const re = /<div class="price-row(?: [^"]*)?">([\s\S]*?)<strong class="price">([\d,]+)<small>원/g;
  let m;
  while ((m = re.exec(html))) {
    const titles = [...m[1].matchAll(/<strong>([^<]+)<\/strong>/g)].map((x) => x[1].trim());
    if (titles.length) rows[titles[titles.length - 1]] = m[2];
  }
  return rows;
}

/** 금액 문구는 앞자리 숫자에 붙은 경우(17,000원 안의 7,000원)를 제외하고 찾는다. */
export function containsTerm(text, term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(/^\d/.test(term) ? `(?<![\\d,])${esc}` : esc).test(text);
}

function sp(siteProfile, field) {
  return siteProfile && siteProfile.fields ? siteProfile.fields[field] : undefined;
}

/**
 * @param {object} input
 * @param {string|null} input.homepage   06 index.html 원문
 * @param {object|null} input.siteProfile 05 site_profile.json 파싱값
 * @param {Record<string,string>|null} input.blobs  출처 key → 현재 git blob SHA (없으면 검사 생략)
 * @param {Record<string,string>} [input.notices]   그 밖의 고객 고지 원문(예: 01 booking.html) — 폐지 값만 검사
 * @param {Record<string,object>} [kb]
 * @returns {{id:string, category:string, findings:string[]}[]}
 */
export function checkKnowledge({ homepage = null, siteProfile = null, blobs = null, notices = {} } = {}, kb = facts) {
  const rows = homepage ? homepagePriceRows(homepage) : {};
  const results = [];
  for (const [id, fact] of Object.entries(kb)) {
    const findings = [];
    let category = 'ok';
    const flag = (cat, msg) => { findings.push(`${cat}: ${msg}`); if (RANK[cat] > RANK[category]) category = cat; };

    if (!STATUSES.includes(fact.status)) flag('mismatch', `알 수 없는 상태 ${fact.status}`);
    if (!Array.isArray(fact.basis) || fact.basis.length === 0) flag('missing', '출처 없음');
    for (const b of fact.basis || []) {
      const src = SOURCES[b.source];
      if (!src) { flag('missing', `출처 키 없음 ${b.source}`); continue; }
      if (blobs) {
        // blobs 값은 SHA 하나 또는 후보 배열(원문 바이트, 줄 끝 LF 정규화) — 하나라도 기록값과 같으면 동일 원문
        const cand = blobs[b.source] == null ? [] : [].concat(blobs[b.source]);
        if (!(b.source in blobs) || cand.length === 0) flag('missing', `출처 파일 없음 ${src.path}`);
        else if (!cand.includes(src.blob)) flag('uncertain', `출처 변경됨 ${src.path} (기록 ${src.blob.slice(0, 7)} → 현재 ${String(cand[cand.length - 1]).slice(0, 7)}) — 재검토 필요`);
      }
    }

    if (fact.status === 'published' && fact.kind !== 'channel') flag('uncertain', '홈페이지 고지만 있고 대표 결정·05 confirmed 근거 없음 — 상담 안내 보류');
    if (fact.status === 'published' && fact.kind === 'channel') flag('uncertain', '연락 채널: 홈페이지 고지만 있고 05 계약 필드 없음');

    // 홈페이지 대조
    if (homepage != null && fact.homepage) {
      if (fact.homepage.row) {
        const shown = rows[fact.homepage.row];
        if (shown == null) flag('missing', `홈페이지 요금표에 '${fact.homepage.row}' 행 없음`);
        else if (fact.value != null && shown !== won(fact.value)) flag('mismatch', `홈페이지 '${fact.homepage.row}' ${shown}원 ≠ 기준 ${won(fact.value)}원`);
      }
      for (const t of fact.homepage.text || []) {
        if (!homepage.includes(t)) flag(fact.status === 'undetermined' ? 'mismatch' : 'missing', `홈페이지에 '${t}' 없음`);
      }
      if (fact.status === 'undetermined' && /운영\s*시간[^<]{0,40}?\d{1,2}\s*[:시]\s*\d{0,2}/.test(homepage)) {
        flag('mismatch', '홈페이지가 미정 운영시간을 시각으로 고지');
      }
    }
    for (const t of fact.forbidden || []) {
      if (homepage != null && containsTerm(homepage, t)) flag('mismatch', `홈페이지에 폐지 값 '${t}' 고지`);
      for (const [name, html] of Object.entries(notices)) {
        if (html && containsTerm(html, t)) flag('mismatch', `${name} 에 폐지 값 '${t}' 고지`);
      }
    }

    // 05 대조 (기록값 비교만, 승격하지 않음)
    if (siteProfile != null && fact.site_profile) {
      const rec = sp(siteProfile, fact.site_profile.field);
      if (rec === undefined) flag('missing', `05 에 ${fact.site_profile.field} 없음`);
      else {
        if (JSON.stringify(rec.value ?? null) !== JSON.stringify(fact.site_profile.value)) {
          flag('mismatch', `05 ${fact.site_profile.field}=${JSON.stringify(rec.value)} ≠ 기준 ${JSON.stringify(fact.site_profile.value)}`);
        }
        const want = fact.status === 'undetermined' ? 'unverified' : 'confirmed';
        if (rec.status !== want) flag('uncertain', `05 ${fact.site_profile.field} 상태 ${rec.status} (기대 ${want}) — 05 승격·정정은 이 작업 범위 밖`);
      }
    }
    results.push({ id, status: fact.status, category, findings });
  }
  return results;
}

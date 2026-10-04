// CLAUDE-009 — 상담 지식 계약·출처·정확성 회귀시험. 키·네트워크 없이 실행한다.
// 실행: node tests/knowledge.test.mjs (06_봉플레이_고객홈페이지 폴더에서)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  facts, SOURCES, STATUSES, READ_AT_COMMIT, CUSTOMER_SOURCE, statable, renderAnswers, contactChannel,
  checkKnowledge, homepagePriceRows, containsTerm
} from '../netlify/functions/lib/knowledge.mjs';
import { consult, answers } from '../netlify/functions/lib/consultation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(REPO, rel));
const gitBlob = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
// Windows 체크아웃(core.autocrlf)은 LF 로 저장된 원문을 CRLF 로 풀어 놓는다. 바이너리(NUL 포함)가 아니면
// 원문 바이트와 줄 끝 LF 정규화본 두 후보를 만든다. 기록 blob 과 하나라도 같으면 같은 원문으로 본다.
const toCRLF = (buf) => Buffer.from(buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
function blobCandidates(buf) {
  if (buf.includes(0)) return [gitBlob(buf)];
  const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return [...new Set([gitBlob(buf), gitBlob(lf)])];
}
const HAVE_REPO = existsSync(path.join(REPO, SOURCES.site_profile.path));

function currentInputs(transform = (b) => b) {
  const blobs = {};
  for (const [key, src] of Object.entries(SOURCES)) {
    const p = path.join(REPO, src.path);
    blobs[key] = existsSync(p) ? blobCandidates(transform(readFileSync(p))) : null;
  }
  return {
    homepage: transform(read(SOURCES.homepage.path)).toString('utf8'),
    siteProfile: JSON.parse(transform(read(SOURCES.site_profile.path)).toString('utf8')),
    blobs,
    notices: { '01 booking.html': transform(read(SOURCES.ops_booking.path)).toString('utf8') }
  };
}
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));
const clone = (kb) => JSON.parse(JSON.stringify(kb));
const AMOUNT = /\d{1,3}(?:,\d{3})+\s*원|\d+\s*만\s*원/g;
const CLOCK = /\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시(?!간)/;

// ---- 계약 구조 ---------------------------------------------------------------
test('contract: every fact has a known status, basis and verifiable SHA fields', () => {
  assert.match(READ_AT_COMMIT, /^[0-9a-f]{40}$/);
  for (const [key, src] of Object.entries(SOURCES)) {
    assert.match(src.blob, /^[0-9a-f]{40}$/, key);
    assert.match(src.last_commit, /^[0-9a-f]{40}$/, key);
    assert.ok(src.path && !path.isAbsolute(src.path), key);
  }
  for (const [id, f] of Object.entries(facts)) {
    assert.ok(STATUSES.includes(f.status), id);
    assert.ok(f.basis.length > 0, id);
    for (const b of f.basis) assert.ok(SOURCES[b.source] && b.item, `${id} ${b.source}`);
    if (f.status === 'confirmed' && f.kind === 'fact') assert.ok(f.display != null || f.value == null, id);
    if (['undetermined', 'planned', 'abolished'].includes(f.status)) assert.equal(f.display, null, `${id}: 미확정·폐지 값은 표시값이 없어야 함`);
  }
});

test('contract: recorded blob SHAs equal the bytes in this checkout (no guessed SHA)', { skip: !HAVE_REPO && '저장소 전체가 없어 출처 파일 대조 생략' }, () => {
  for (const [key, src] of Object.entries(SOURCES)) {
    assert.ok(blobCandidates(read(src.path)).includes(src.blob), `${key} ${src.path}`);
  }
});

// ---- 미확정 값 안내 금지 --------------------------------------------------------
test('answers: every amount/time stated is a statable fact; nothing unconfirmed leaks', () => {
  const allowed = new Set(Object.values(facts).filter(statable).map((f) => f.display));
  for (const [intent, { text }] of Object.entries(answers)) {
    for (const m of text.match(AMOUNT) || []) assert.ok(allowed.has(m.replace(/\s/g, '')), `${intent}: 근거 없는 금액 ${m}`);
    assert.doesNotMatch(text, CLOCK, `${intent}: 미정 운영시간이 시각으로 안내됨`);
    for (const f of Object.values(facts)) {
      for (const t of f.forbidden || []) assert.ok(!containsTerm(text, t), `${intent}: 폐지 값 ${t}`);
    }
  }
  for (const [intent, { text }] of Object.entries(answers)) {
    for (const m of text.match(/\d+\s*%/g) || []) assert.ok(allowed.has(m.replace(/\s/g, '')), `${intent}: 근거 없는 비율 ${m}`);
  }
  assert.match(answers.hours.text, /확정 후 안내/);
  assert.match(answers.group.text, /계획 단계이며 금액·조건은 미확정/);
  assert.doesNotMatch(answers.group.text, /군|보조|30~50/);
  assert.doesNotMatch(answers.booking.text, /확정되었|접수되었|예약되었/);
});

test('answers: confirmed values are stated exactly', () => {
  assert.match(answers.price.text, /기본 이용권은 15,000원/);
  assert.match(answers.price.text, /보호자 입장권은 5,000원/);
  assert.match(answers.price.text, /종합 이용권은 21,000원/); // 대표 확정 2026-10-05
  assert.match(answers.price.text, /기본·종합 이용권은 어린이 1인 기준입니다/);
  assert.match(answers.price.text, /봉화군민은 20% 우대 할인이 있으며 현장에서 신분증을 확인합니다/);
  assert.doesNotMatch(answers.group.text, /어린이/, '단체권 어린이 기준은 근거 부족으로 안내하지 않음');
  assert.equal(answers.price.text, '기본 이용권은 15,000원, 종합 이용권은 21,000원, 보호자 입장권은 5,000원입니다. 기본·종합 이용권은 어린이 1인 기준입니다. 봉화군민은 20% 우대 할인이 있으며 현장에서 신분증을 확인합니다. 할인 중복과 개별 적용 여부는 방문 전에 문의해 주세요.');
  assert.match(answers.group.text, /20인 이상 단체 종합권은 1인 16,800원/);
  assert.match(answers.location.text, /리틀포레스트 봉플레이의 주소는 경상북도 봉화군 봉화읍 유록길 22/);
  assert.match(answers.facilities.text, /짚코스터·네트챌린지/);
});

test('answers follow status: demoting or promoting a fact changes what is said', () => {
  const kb = clone(facts);
  kb['price.tkt_basic'].status = 'undetermined';
  kb['price.tkt_basic'].display = null;
  kb['address.road'].status = 'published';
  kb['price.group_allday'].status = 'planned';
  let a = renderAnswers(kb);
  assert.doesNotMatch(a.price.text, /15,000/);
  assert.match(a.price.text, /기본 이용권 가격은 방문 전에 문의/);
  assert.doesNotMatch(a.price.text, /어린이 1인 기준/);
  assert.doesNotMatch(a.location.text, /유록길/);
  assert.doesNotMatch(a.group.text, /16,800/);

  const kb2 = clone(facts);
  kb2['price.tkt_allday'].status = 'published'; // 대표 확정 이전 상태로 되돌린 합성
  a = renderAnswers(kb2);
  assert.doesNotMatch(a.price.text, /21,000/);
  assert.match(a.price.text, /종합 이용권 가격은 방문 전에 문의/);
  assert.doesNotMatch(a.price.text, /어린이 1인 기준/, '종합 금액을 안내하지 않으면 기준 문장도 빼야 함');
  kb2['discount.resident_rate'].status = 'undetermined';
  assert.doesNotMatch(renderAnswers(kb2).price.text, /20%|군민/);

  const kb3 = clone(facts);
  kb3['hours.open'] = { ...kb3['hours.open'], status: 'confirmed', display: '10:00~18:00' };
  assert.match(renderAnswers(kb3).hours.text, /10:00~18:00/);
});

test('published facts are not statable, except contact channels', () => {
  assert.equal(statable(facts['price.tkt_allday']), true);
  assert.equal(statable({ ...facts['price.tkt_allday'], status: 'published' }), false);
  assert.equal(statable(facts['contact.phone']), true);
  assert.deepEqual(contactChannel(), { label: '전화 문의', href: 'tel:01059314144' });
  const kb = clone(facts);
  kb['contact.phone'].status = 'abolished';
  assert.equal(contactChannel(kb), null);
});

// ---- 현재 저장소 대조 (정상·불확실) -------------------------------------------------
test('current repo: classification snapshot', { skip: !HAVE_REPO && '저장소 전체가 없어 대조 생략' }, () => {
  const r = byId(checkKnowledge(currentInputs()));
  const expected = {
    'facility.name': 'ok', 'address.road': 'ok', 'price.tkt_guardian': 'ok', 'price.group_allday': 'ok',
    'group.min_size': 'ok', 'hours.open': 'ok', 'facility.outdoor_attractions': 'ok', 'group.bus_support': 'ok',
    'booking.mode': 'ok',
    'price.tkt_basic': 'uncertain', // 05 기록 unresolved (승격은 CLAUDE-007 범위)
    'price.tkt_allday': 'uncertain', // 대표 확정, 05 기록은 아직 system_default (05 반영은 별도 작업)
    'price.child_basis': 'ok', 'discount.resident_rate': 'ok',
    'contact.phone': 'uncertain', // 05 계약 필드 없음
    'abolished.daycare_group_voucher': 'ok', 'abolished.teen_adult_activity': 'ok', 'abolished.merit_disability': 'ok',
    'abolished.basic_promo': 'ok', 'abolished.county_bus_claim': 'ok'
  };
  assert.deepEqual(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.category])), expected,
    JSON.stringify(Object.values(r).filter((x) => x.findings.length), null, 1));
  assert.match(r['price.tkt_basic'].findings.join('\n'), /05 price\.tkt_basic 상태 unresolved/);
  assert.deepEqual(r['price.tkt_allday'].findings, ['uncertain: 05 price.tkt_allday 상태 system_default (기대 confirmed) — 05 승격·정정은 이 작업 범위 밖']);
});

test('portability: CRLF checkout classifies the same as LF; real edits are still detected', { skip: !HAVE_REPO && '저장소 전체가 없어 생략' }, () => {
  const lf = Object.fromEntries(checkKnowledge(currentInputs()).map((x) => [x.id, x.category]));
  const crlfInputs = currentInputs(toCRLF);
  // CRLF 바이트의 원문 blob 은 기록값과 다르지만 정규화 후보가 일치해야 한다
  assert.notEqual(gitBlob(toCRLF(read(SOURCES.decision_004b.path))), SOURCES.decision_004b.blob);
  assert.ok(crlfInputs.blobs.decision_004b.includes(SOURCES.decision_004b.blob));
  const crlf = Object.fromEntries(checkKnowledge(crlfInputs).map((x) => [x.id, x.category]));
  assert.deepEqual(crlf, lf);
  // 의미 있는 원문 변경(한 글자)은 CRLF 체크아웃에서도 출처 변경으로 잡힌다
  const edited = currentInputs((b) => toCRLF(Buffer.from(b.toString('utf8').replace('15,000원', '15,500원'), 'utf8')));
  const r = byId(checkKnowledge(edited));
  assert.match(r['price.tkt_basic'].findings.join(), /출처 변경됨 docs\/migration\/CLAUDE-004b/);
  assert.notEqual(r['price.tkt_basic'].category, 'ok');
});

test('homepage price rows parse', { skip: !HAVE_REPO && '저장소 전체가 없어 생략' }, () => {
  assert.deepEqual(homepagePriceRows(currentInputs().homepage),
    { '기본 이용권': '15,000', '종합 이용권': '21,000', '보호자 입장권': '5,000', '단체 종합이용권': '16,800' });
});

// ---- 합성 변형: 불일치·누락·불확실 -------------------------------------------------
const SYN_HOME = `<p>리틀포레스트 봉플레이</p><p>경상북도 봉화군 봉화읍 유록길 22</p>
<div class="price-row"><div><strong>기본 이용권</strong></div><strong class="price">15,000<small>원</small></strong></div>
<div class="price-row"><div><strong>종합 이용권</strong></div><strong class="price">21,000<small>원</small></strong></div>
<div class="price-row"><div><strong>보호자 입장권</strong></div><strong class="price">5,000<small>원</small></strong></div>
<div class="price-row"><div><strong>단체 종합이용권</strong><span>20인 이상</span></div><strong class="price">16,800<small>원</small></strong></div>
<p>기본·종합·단체권은 어린이 1인 기준입니다.</p><p>봉화군민 20% 우대 할인 · 현장에서 신분증을 확인해 주세요.</p>
<p>운영시간은 확정 후 안내됩니다.</p><p>짚코스터 네트챌린지</p><a href="tel:01059314144">010-5931-4144</a>`;
const synProfile = () => ({ fields: {
  'facility.name': { value: '리틀포레스트 봉플레이', status: 'confirmed' },
  'address.road': { value: '경상북도 봉화군 봉화읍 유록길 22', status: 'confirmed' },
  'price.tkt_basic': { value: 15000, status: 'confirmed' },
  'price.tkt_allday': { value: 21000, status: 'confirmed' },
  'price.tkt_guardian': { value: 5000, status: 'confirmed' },
  'price.group_allday': { value: 16800, status: 'confirmed' },
  'hours.open': { value: null, status: 'unverified' },
  'facility.outdoor_attractions': { value: ['짚코스터', '네트챌린지'], status: 'confirmed' },
  'discount.resident_rate': { value: 0.2, status: 'confirmed' }
} });
const cat = (input, id) => byId(checkKnowledge(input))[id];

test('synthetic: fully consistent inputs are ok (published still uncertain)', () => {
  const r = byId(checkKnowledge({ homepage: SYN_HOME, siteProfile: synProfile() }));
  for (const [id, x] of Object.entries(r)) {
    const want = facts[id].status === 'published' ? 'uncertain' : 'ok';
    assert.equal(x.category, want, `${id}: ${x.findings.join('; ')}`);
  }
});

test('synthetic mismatch: homepage price differs from decision', () => {
  const r = cat({ homepage: SYN_HOME.replace('15,000<small>', '14,000<small>'), siteProfile: synProfile() }, 'price.tkt_basic');
  assert.equal(r.category, 'mismatch');
  assert.match(r.findings.join(), /14,000원 ≠ 기준 15,000원/);
});

test('synthetic mismatch: 05 value differs', () => {
  const p = synProfile();
  p.fields['price.group_allday'].value = 17000;
  assert.equal(cat({ homepage: SYN_HOME, siteProfile: p }, 'price.group_allday').category, 'mismatch');
});

test('synthetic mismatch: undetermined hours published as a time', () => {
  const html = SYN_HOME.replace('운영시간은 확정 후 안내됩니다.', '운영시간 10:00~18:00');
  assert.equal(cat({ homepage: html }, 'hours.open').category, 'mismatch');
  const html2 = SYN_HOME + '<p>운영시간은 확정 후 안내 · 운영 시간 오전 10시 개장</p>';
  assert.equal(cat({ homepage: html2 }, 'hours.open').category, 'mismatch');
});

test('synthetic mismatch: abolished values reappear on homepage or other notices', () => {
  assert.equal(cat({ homepage: SYN_HOME + '<p>지원 단체권 7,000원</p>' }, 'abolished.daycare_group_voucher').category, 'mismatch');
  assert.equal(cat({ homepage: SYN_HOME, notices: { '01 booking.html': '봉화군 군 지원 30~50만 원' } }, 'abolished.county_bus_claim').category, 'mismatch');
  // 17,000원 안의 7,000원은 폐지 값이 아님
  assert.equal(cat({ homepage: SYN_HOME + '<p>정가 17,000원</p>' }, 'abolished.daycare_group_voucher').category, 'ok');
});

test('synthetic missing: homepage row, homepage text, 05 field, source file', () => {
  const noGuardian = SYN_HOME.replace(/<div class="price-row"><div><strong>보호자 입장권[\s\S]*?<\/div><\/div>|<div class="price-row"><div><strong>보호자 입장권<\/strong><\/div><strong class="price">5,000<small>원<\/small><\/strong><\/div>/, '');
  assert.equal(cat({ homepage: noGuardian }, 'price.tkt_guardian').category, 'missing');
  assert.equal(cat({ homepage: SYN_HOME.replace('유록길 22', '유록길') }, 'address.road').category, 'missing');
  const p = synProfile();
  delete p.fields['price.tkt_guardian'];
  assert.equal(cat({ homepage: SYN_HOME, siteProfile: p }, 'price.tkt_guardian').category, 'missing');
  const blobs = Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.blob]));
  blobs.decision_004b = null;
  assert.equal(cat({ blobs }, 'price.tkt_basic').category, 'missing');
});

test('synthetic uncertain: 05 not confirmed, source changed since snapshot', () => {
  const p = synProfile();
  p.fields['price.tkt_basic'].status = 'unresolved';
  assert.equal(cat({ homepage: SYN_HOME, siteProfile: p }, 'price.tkt_basic').category, 'uncertain');
  const blobs = Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.blob]));
  blobs.decision_004b = '0'.repeat(40);
  const r = cat({ homepage: SYN_HOME, siteProfile: synProfile(), blobs }, 'price.tkt_basic');
  assert.equal(r.category, 'uncertain');
  assert.match(r.findings.join(), /출처 변경됨/);
});

test('severity: mismatch outranks missing and uncertain', () => {
  const p = synProfile();
  p.fields['price.tkt_basic'].status = 'unresolved';
  const r = cat({ homepage: SYN_HOME.replace('15,000<small>', '14,000<small>'), siteProfile: p }, 'price.tkt_basic');
  assert.equal(r.category, 'mismatch');
  assert.equal(r.findings.length, 2);
});

// ---- consult 계약 유지 ------------------------------------------------------------
test('consult output contract unchanged and answers come from the knowledge contract', async () => {
  const r = await consult('요금');
  assert.deepEqual(Object.keys(r), ['intent', 'mode', 'reason', 'answer', 'source', 'contact', 'notice']);
  assert.equal(r.answer, renderAnswers().price.text);
  assert.deepEqual(r.contact, { label: '전화 문의', href: 'tel:01059314144' });
  assert.equal(r.source, CUSTOMER_SOURCE);
  assert.doesNotMatch(r.source, /BEN-|CLAUDE-|ANT-|GEO-|[0-9a-f]{7,}/, '고객 출처 표기에 내부 작업 코드·SHA 금지');
  const env = { JEV_ENABLED: 'true', JEV_MODEL: 'synthetic-model', TYPESAFE_API_KEY: 'SENTINEL' };
  const probs = (k) => Object.fromEntries(['price', 'hours', 'location', 'facilities', 'booking', 'group', 'human', 'other'].map((x) => [x, x === k ? 1 : 0]));
  for (const intent of ['price', 'hours', 'group']) {
    const out = await consult('질문', { env, fetcher: async () => new Response(JSON.stringify({ answers: { intent: { type: 'choice', choice: intent, confidence: 0.9, probabilities: probs(intent) } }, text: '무료 입장, 운영시간 10:00, 단체 버스비 50만 원 지원' })) });
    assert.equal(out.answer, answers[intent].text);
    assert.doesNotMatch(out.answer, /무료|10:00|50만/);
  }
});

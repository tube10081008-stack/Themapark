/**
 * screen_survey.test.js
 * 
 * ANT-001 운영시스템 27개 전체 화면/서식 전수 점검 및 자산 정합성 검증 테스트
 * 실행 환경: Node.js v24.18.0 (agy-node)
 * 실행 명령: agy-node --test 01_봉플레이_운영시스템/tests/screen_survey.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

// 27 screens definition
const SCREENS = [
  // 1 Root Portal
  { type: 'root', file: 'index.html', title: '루트 운영 포털', category: '포털' },

  // 14 Pages
  { type: 'page', file: 'pages/consent.html', title: '안전이용 동의서 (고객용)', category: '고객 접점' },
  { type: 'page', file: 'pages/survey.html', title: '퇴장 고객 만족도 설문', category: '고객 접점' },
  { type: 'page', file: 'pages/booking.html', title: '단체/체험 사전예약', category: '고객 접점' },
  { type: 'page', file: 'pages/consent-desk.html', title: '서약 접수 데스크', category: '매표/안내' },
  { type: 'page', file: 'pages/operations.html', title: 'POS 발권 및 매표 운영', category: '매표/안내' },
  { type: 'page', file: 'pages/gate.html', title: '게이트 입퇴장 검표', category: '게이트' },
  { type: 'page', file: 'pages/safety-check.html', title: '일일 시설안전점검', category: '안전관리' },
  { type: 'page', file: 'pages/closing.html', title: '일일 영업마감 및 시재정산', category: '마감정산' },
  { type: 'page', file: 'pages/management.html', title: '운영 총괄 관리 대시보드', category: '경영관리' },
  { type: 'page', file: 'pages/master.html', title: '기준정보 마스터 관리', category: '경영관리' },
  { type: 'page', file: 'pages/archive.html', title: '봉아카이브 사진/영상 관리', category: '미디어' },
  { type: 'page', file: 'pages/emergency.html', title: '비상대응 및 상황전파', category: '안전관리' },
  { type: 'page', file: 'pages/simulator.html', title: '수익/수요 시뮬레이터', category: '분석시뮬' },
  { type: 'page', file: 'pages/metaverse.html', title: '디지털 트윈 메타버스', category: '분석시뮬' },

  // 12 Forms
  { type: 'form', file: 'forms/index.html', title: '행정 서식 통합 포털', category: '행정서식' },
  { type: 'form', file: 'forms/booking-confirm.html', title: '단체 예약확인서', category: '행정서식' },
  { type: 'form', file: 'forms/quotation.html', title: '단체 견적서', category: '행정서식' },
  { type: 'form', file: 'forms/invoice.html', title: '청구서 / 거래명세서', category: '행정서식' },
  { type: 'form', file: 'forms/incident-report.html', title: '안전사고 발생보고서', category: '행정서식' },
  { type: 'form', file: 'forms/safety-training.html', title: '안전교육 일지', category: '행정서식' },
  { type: 'form', file: 'forms/facility-change.html', title: '시설 점검/개수 확인서', category: '행정서식' },
  { type: 'form', file: 'forms/operation-report.html', title: '일일 운영보고서', category: '행정서식' },
  { type: 'form', file: 'forms/employment-contract.html', title: '근로계약서', category: '행정서식' },
  { type: 'form', file: 'forms/employment-cert.html', title: '재직증명서', category: '행정서식' },
  { type: 'form', file: 'forms/payslip.html', title: '급여명세서', category: '행정서식' },
  { type: 'form', file: 'forms/inspection-cert.html', title: '안전점검 필증 서식', category: '행정서식' }
];

test('전수 화면 조사: 27개 HTML 파일 무결성 및 링크 점검', async (t) => {
  const surveyResults = [];

  for (const s of SCREENS) {
    await t.test(`검증 [${s.category}] ${s.file}`, () => {
      const fullPath = path.join(ROOT_DIR, s.file);
      assert.ok(fs.existsSync(fullPath), `파일이 존재해야 함: ${s.file}`);

      const html = fs.readFileSync(fullPath, 'utf-8');
      
      // 1. DOCTYPE, charset, responsive viewport
      assert.ok(/<!DOCTYPE\s+html>/i.test(html), `${s.file}에 <!DOCTYPE html> 선언 필요`);
      assert.ok(/<meta\s+charset=["']?utf-8["']?/i.test(html), `${s.file}에 UTF-8 선언 필요`);
      assert.ok(/name=["']viewport["']/i.test(html), `${s.file}에 반응형 뷰포트 메타태그 필요`);

      // 2. Local scripts & styles existence check
      const dirOfFile = path.dirname(fullPath);
      
      // Local scripts regex
      const scriptMatches = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)];
      const missingScripts = [];
      const localScripts = [];
      const cdnScripts = [];

      scriptMatches.forEach(m => {
        const src = m[1];
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
          cdnScripts.push(src);
        } else {
          localScripts.push(src);
          // resolve relative to current file
          const scriptTarget = path.resolve(dirOfFile, src);
          if (!fs.existsSync(scriptTarget)) {
            missingScripts.push({ src, resolved: scriptTarget });
          }
        }
      });

      assert.equal(missingScripts.length, 0, `${s.file}에 깨진 로컬 스크립트가 없어야 함: ${JSON.stringify(missingScripts)}`);

      // Local styles regex
      const linkMatches = [...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)];
      const missingStyles = [];
      const localStyles = [];
      const cdnStyles = [];

      linkMatches.forEach(m => {
        const href = m[1];
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
          cdnStyles.push(href);
        } else if (href.endsWith('.css')) {
          localStyles.push(href);
          const styleTarget = path.resolve(dirOfFile, href);
          if (!fs.existsSync(styleTarget)) {
            missingStyles.push({ href, resolved: styleTarget });
          }
        }
      });

      assert.equal(missingStyles.length, 0, `${s.file}에 깨진 로컬 스타일시트가 없어야 함: ${JSON.stringify(missingStyles)}`);

      // 3. Guest vs Staff Authentication classification
      let authMode = '스태프 (관리자 잠금 대상)';
      if (html.includes('BONGPLAY_GUEST_MODE = true') || s.file.includes('consent.html') || s.file.includes('survey.html')) {
        authMode = '게스트 공개 (인증 제외)';
      } else if (s.type === 'form') {
        authMode = '업무 서식 (인쇄/열람)';
      }

      surveyResults.push({
        file: s.file,
        title: s.title,
        category: s.category,
        authMode,
        localScripts: localScripts.length,
        cdnScripts: cdnScripts.length,
        localStyles: localStyles.length,
        cdnStyles: cdnStyles.length,
        bytes: html.length
      });
    });
  }

  // Generate evidence summary file
  const evidenceDir = path.resolve(ROOT_DIR, '..', 'docs', 'qa', 'evidence', 'ANT-001');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const manifestPath = path.join(evidenceDir, 'screen_survey_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(surveyResults, null, 2), 'utf-8');
  assert.equal(surveyResults.length, 27, '정확히 27개 화면/서식이 검증되어야 함');
});

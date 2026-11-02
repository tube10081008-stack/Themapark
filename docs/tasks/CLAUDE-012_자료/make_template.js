// 봉뜨락 기본 공문 양식(docx) 생성 스크립트. 사용: node make_template.js <출력.docx> <로고.png>
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign, Footer,
  PageNumber, PageBreak, TableLayoutType, HeightRule,
} = require('docx');

const OUT = process.argv[2];
const LOGO = process.argv[3];

const GREEN = '0B4A2B';
const NAVY = '132146';
const GRAY = '8A8A8A';
const FONT = { ascii: '바탕', hAnsi: '바탕', eastAsia: '바탕', cs: '바탕' };
const GOTHIC = { ascii: '맑은 고딕', hAnsi: '맑은 고딕', eastAsia: '맑은 고딕', cs: '맑은 고딕' };
const W = 9638; // A4 width minus 2 cm margins

const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
const line = (sz = 4, color = '000000') => ({ style: BorderStyle.SINGLE, size: sz, color });

const t = (text, o = {}) => new TextRun({ text, font: FONT, ...o });
const ph = (text, o = {}) => t(text, { color: GRAY, ...o });
const p = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], ...o });

const cell = (children, width, o = {}) => new TableCell({
  children: Array.isArray(children) ? children : [children],
  width: { size: width, type: WidthType.DXA },
  verticalAlign: VerticalAlign.CENTER,
  ...o,
});

// ---------- page 1 header: logo | 시설명 | (balance) ----------
const logo = new ImageRun({
  type: 'png',
  data: fs.readFileSync(LOGO),
  transformation: { width: 96, height: 70 },
  altText: { title: 'BONG PLAY', description: '봉플레이 로고', name: 'logo' },
});
const headerTable = new Table({
  width: { size: W, type: WidthType.DXA },
  columnWidths: [2000, 5638, 2000],
  layout: TableLayoutType.FIXED,
  borders: noBorders,
  rows: [new TableRow({ children: [
    cell(p(logo), 2000),
    cell(p(t('리틀포레스트 봉뜨락', { bold: true, size: 36, font: GOTHIC }), { alignment: AlignmentType.CENTER }), 5638),
    cell(p(t('')), 2000),
  ] })],
});

// ---------- 수신 / 경유 / 제목 ----------
const B = 22; // 11pt
const lbl = (s, o = {}) => t(s, { size: B, ...o });
const recipient = [
  p([lbl('수신자 : '), ph('[수신 기관  부서]', { size: B })], { spacing: { before: 280, after: 40 } }),
  p([lbl('(경유)     '), ph('[담당 팀  담당자 직위]', { size: B })], { spacing: { after: 40 } }),
  p([lbl('제    목 : '), ph('[제목]', { bold: true, size: B })], {
    spacing: { after: 320 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '9A9A9A', space: 6 } },
  }),
];

// ---------- 본문 (비움) ----------
const bodyPara = (num, text) => p([t(`${num}. `, { size: B }), ph(text, { size: B })], {
  indent: { left: 760, hanging: 300 }, spacing: { after: 60, line: 340 },
});
const body = [
  bodyPara(1, '[인사  협조 감사 문구]'),
  bodyPara(2, '[요청 배경과 요청 사항]'),
  bodyPara(3, '[검토  승인 요청 문구]'),
  p(t('-      다      음      -', { size: B, bold: true }), { alignment: AlignmentType.CENTER, spacing: { before: 360, after: 360 } }),
  p([t('□ ', { size: B }), ph('[요청 건명]', { size: B })], { indent: { left: 460 }, spacing: { after: 80 } }),
  p([t('1. 주요내용', { size: B, bold: true })], { indent: { left: 760 }, spacing: { after: 60 } }),
  p([t('1) ', { size: B }), ph('[세부 내용]', { size: B })], { indent: { left: 1060 }, spacing: { after: 360 } }),
  p([t('□ 붙임 : ', { size: B }), ph('[첨부 문서명]', { size: B }), t(' 1부.   끝.', { size: B })], { indent: { left: 460 } }),
];

// ---------- 첫 쪽 바닥: 회색 띠 + 기안·시행·연락처 ----------
const small = (s, o = {}) => t(s, { size: 18, font: GOTHIC, ...o });
const sph = (s, o = {}) => ph(s, { size: 18, font: GOTHIC, ...o });
const FC = [4300, 3338, 2000];
const fcell = (children, w, align = AlignmentType.LEFT) =>
  cell(p(children, { alignment: align, spacing: { before: 30, after: 30 } }), w);
const grayBar = new Table({
  width: { size: W, type: WidthType.DXA },
  columnWidths: [W],
  layout: TableLayoutType.FIXED,
  borders: noBorders,
  rows: [new TableRow({ height: { value: 220, rule: HeightRule.EXACT }, children: [
    cell(p(t('', { size: 4 })), W, { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'CCCCCC' } }),
  ] })],
});
const infoTable = new Table({
  width: { size: W, type: WidthType.DXA },
  columnWidths: FC,
  layout: TableLayoutType.FIXED,
  borders: noBorders,
  rows: [
    new TableRow({ children: [
      fcell([small('기안    '), sph('[이름]')], FC[0]),
      fcell([small('')], FC[1]),
      fcell([sph('[YYMMDD]'), small('  전결')], FC[2], AlignmentType.RIGHT),
    ] }),
    new TableRow({ children: [
      fcell([small('시행    리틀포레스트 봉뜨락')], FC[0]),
      fcell([sph('[직위]'), small('  홍성현')], FC[1]),
      fcell([small('')], FC[2]),
    ] }),
    new TableRow({ children: [
      fcell([small('전화    010-5931-4144')], FC[0]),
      fcell([small('이메일  bongplay@outlook.kr')], FC[1]),
      fcell([small('/'), sph('[공개 구분]')], FC[2], AlignmentType.RIGHT),
    ] }),
  ],
});
const pageNo = () => p([new TextRun({ children: [PageNumber.CURRENT], font: GOTHIC, size: 18 })], { alignment: AlignmentType.CENTER, spacing: { before: 160 } });
const firstFooter = new Footer({ children: [grayBar, infoTable, pageNo()] });
const defaultFooter = new Footer({ children: [pageNo()] });

// ---------- 2쪽: 붙임 상세 양식 ----------
const sectionBar = new Table({
  width: { size: W, type: WidthType.DXA },
  columnWidths: [700, 160, 8778],
  layout: TableLayoutType.FIXED,
  borders: noBorders,
  rows: [new TableRow({ height: { value: 560, rule: HeightRule.ATLEAST }, children: [
    cell(p(t('Ⅰ', { bold: true, size: 26, color: 'FFFFFF', font: GOTHIC }), { alignment: AlignmentType.CENTER }), 700,
      { shading: { type: ShadingType.CLEAR, color: 'auto', fill: GREEN } }),
    cell(p(t('')), 160),
    cell(p([ph('[붙임 제목]', { bold: true, size: 26, color: 'FFFFFF', font: GOTHIC })], { indent: { left: 160 } }), 8778,
      { shading: { type: ShadingType.CLEAR, color: 'auto', fill: GREEN } }),
  ] })],
});
const cols = [900, 1700, 2500, 4538];
const grid = { top: line(), bottom: line(), left: line(), right: line(), insideHorizontal: line(), insideVertical: line() };
const headCell = (s, w) => cell(p(t(s, { bold: true, size: 20, font: GOTHIC }), { alignment: AlignmentType.CENTER }), w,
  { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF3EE' } });
const emptyRow = (n) => new TableRow({ height: { value: 2300, rule: HeightRule.ATLEAST }, children: [
  cell(p(t(String(n), { size: 20 }), { alignment: AlignmentType.CENTER }), cols[0]),
  cell(p(ph('[항목]', { size: 20 }), { alignment: AlignmentType.CENTER }), cols[1]),
  cell(p(ph('[사진]', { size: 20 }), { alignment: AlignmentType.CENTER }), cols[2]),
  cell(p(ph('[내용]', { size: 20 }), { indent: { left: 100 } }), cols[3]),
] });
const detailTable = new Table({
  width: { size: W, type: WidthType.DXA },
  columnWidths: cols,
  layout: TableLayoutType.FIXED,
  borders: grid,
  rows: [
    new TableRow({ tableHeader: true, height: { value: 480, rule: HeightRule.ATLEAST }, children: [
      headCell('순서', cols[0]), headCell('항목', cols[1]), headCell('사진', cols[2]), headCell('내용', cols[3]),
    ] }),
    emptyRow(1), emptyRow(2), emptyRow(3), emptyRow(4),
  ],
});

const doc = new Document({
  creator: '리틀포레스트 봉뜨락',
  title: '봉뜨락 기본 공문 양식',
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  sections: [{
    properties: {
      titlePage: true,
      page: { margin: { top: 1000, bottom: 1000, left: 1134, right: 1134, footer: 560 } },
    },
    footers: { first: firstFooter, default: defaultFooter },
    children: [
      headerTable,
      ...recipient,
      ...body,
      p(new PageBreak()),
      sectionBar,
      p(t(''), { spacing: { after: 160 } }),
      detailTable,
    ],
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('wrote', OUT); });

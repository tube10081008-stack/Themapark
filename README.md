# 리플레이스 (RE:PLAYCE) & 봉플레이 통합 저장소

본 저장소는 유휴 공공시설 재생 실증 1호 모델인 **경북 봉화군 [리틀포레스트 봉플레이(봉뜨락)]**의 스마트 운영 플랫폼, 브랜드 공식 웹사이트, 건축·행정 인허가 자산 및 AI 업무로그 시스템이 집약된 프로젝트 디렉터리입니다.

---

## 🚀 Netlify 원클릭 배포 안내 (초간단 5초 배포)

모든 배포 대상 프로젝트는 **원클릭 배포용 ZIP 패키지**가 이미 빌드되어 있습니다.  
브라우저에서 **[Netlify Drop (app.netlify.com/drop)](https://app.netlify.com/drop)** 에 접속한 뒤 아래 zip 파일 중 배포를 원하는 파일을 드래그 앤 드롭하시면 즉시 서비스가 시작됩니다.

| 배포 대상 | 담당 폴더 | 배포용 ZIP 파일 | 배포 후 권장 사이트명 |
|---|---|---|---|
| **봉플레이 현장 스마트 운영시스템** | `01_봉플레이_운영시스템/` | **`bongplay_deploy.zip`** | `bongplay` (`https://bongplay.netlify.app`) |
| **리플레이스 공식 브랜드 홈페이지** | `02_리플레이스_브랜드사이트/` | **`replayce_deploy.zip`** | `replayce` (`https://replayce.kr` 등) |
| **단톡방 대화 AI 업무로그 수집기** | `04_봉뜨락_업무로그_AI/` | **`worklog_deploy.zip`** | `bongttorak-worklog` |

> 💡 **배포 시 주의사항**:
> - `bongplay_deploy.zip` 안에는 순수 웹 파일(`index.html`, `pages/`, `forms/`, `assets/`, `_redirects`, `netlify.toml`, `netlify/functions/`)만 포함되어 있어 **SQL 스키마나 파이썬 백엔드 코드, 내부 기획문서가 웹에 절대 유출되지 않습니다.**
> - 디스코드 알림 웹훅은 서버리스 함수(`netlify/functions/notify.mjs`)를 통해 발송되므로, Netlify 환경변수(`DISCORD_WEBHOOK_*`)에 주소를 등록하여 사용하십시오.
> - 운영시스템 배포 전 `01_봉플레이_운영시스템/assets/config.js`에 발급받은 Supabase 접속 정보가 올바르게 기재되어 있는지 확인하십시오.

---

## 📂 디렉터리 구조 및 역할 정의

```
c:/Users/bongp/OneDrive/문서/new/
├── 📁 01_봉플레이_운영시스템/         ← [현장 메인] 스마트 현장 관제 및 발권·안전 플랫폼
│   ├── 📦 bongplay_deploy.zip       ← ★ Netlify 원클릭 배포 파일 (~400 KB)
│   ├── index.html                   ← 메인 포털 허브 (단말 바로가기)
│   ├── pages/                       ← 관제 대시보드 11종 (master, operations, consent, metaverse, simulator 등)
│   ├── forms/                       ← 표준 행정 서식 12종 (포털 index.html 및 근로계약서, 사고보고서 등 11개 서식)
│   ├── assets/                      ← 공통 스크립트, CSS, config.js (환경설정)
│   ├── netlify/                     ← Netlify Functions (디스코드 웹훅 서버리스 보안 프록시)
│   ├── database/                    ← [내부용] DB 관리 스크립트 (FINAL_SUPABASE_SETUP.sql, ops_test_kit.sql)
│   ├── backend_ai/                  ← [내부용] AI 코파일럿 백엔드 (FastAPI main.py, Dockerfile)
│   └── docs/                        ← [내부용] 배포/설정/디스코드 가이드 및 창업지원전략 md
│
├── 📁 02_리플레이스_브랜드사이트/       ← [B2G 홍보] 유휴 공공시설 운영재생 전문기업 웹사이트
│   ├── 📦 replayce_deploy.zip       ← ★ Netlify 원클릭 배포 파일 (33 KB)
│   ├── index.html                   ← 브랜드 공식 소개, 포트폴리오, 간이 진단기
│   └── assets/                      ← 70:30 B2G 디자인 시스템, 반응형 CSS/JS
│
├── 📁 03_봉뜨락_도면및행정자료/         ← [법적 자산] 봉화 현장 원천 도면 및 공문·인허가
│   ├── 01~06 도면 (PDF 6종)         ← 건축/구조, 기계설비, 전기소방, 기계소방 등 정밀 도면
│   ├── 온비드/건축물대장/등기부등본 ← 입찰 낙찰 결과서, 소유권 및 시설 증빙
│   ├── 시설변경 승인요청 공문 (DOCX)← 봉화군청 제출용 정식 공문 서식
│   └── _구버전_초기프로토타입_20260914/ ← 9/14 초기 프로토타입 대시보드 8종 격리 보관
│
├── 📁 04_봉뜨락_업무로그_AI/           ← [업무 자동화] 카톡 대화 AI 분석 및 구글 시트 적재
│   ├── 📦 worklog_deploy.zip        ← ★ Netlify 원클릭 배포 파일 (35 KB)
│   ├── public/ / netlify/           ← 서버리스 Functions (Gemini/Sakana LLM 연동)
│   └── README.md                    ← 구글 시트 서비스 계정 연동 가이드
│
├── 📁 _보관/                        ← [OneDrive 절약] 대용량 미디어 (영상 246MB, 사진 55MB)
│   ├── 영상/                        ← 봉플레이챗 사용법 동영상
│   └── 사진/                        ← 실내놀이동 현장 실측 고해상도 사진 21장
│
├── 📄 모두의창업 2기 지원서.pdf        ← 정부지원사업 제출 서류
└── 📄 README.md                     ← [본 문서] 전체 프로젝트 인덱스 가이드
```

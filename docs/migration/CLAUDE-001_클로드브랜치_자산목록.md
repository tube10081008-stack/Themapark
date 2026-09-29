# CLAUDE-001 — 기존 Claude 브랜치 고유 자산 목록과 이관 검토

- 작성: Claude (클로이) · 2026-09-29
- 기준: `origin/master` @ `068e704`
- 방법: 각 브랜치의 모든 파일을 **내용(blob 해시)** 으로 master 전체와 대조했다. 이력이 달라(공통 조상 없음) 커밋 비교는 쓰지 않았다.
- 범위: **목록과 권고만.** 이 작업에서는 파일을 옮기지 않았다. 실제 이관은 항목별 후속 작업으로 나눈다.

---

## 1. 브랜치 현황 보완

| 브랜치 | HEAD | 비고 |
|---|---|---|
| `claude/greeting-4xvpmy` | `0b774a0` | 공통 Claude 기반 (26개 파일) |
| `claude/sleepy-hamilton-dlqr9s` | `0b774a0` | **COORD 표에 없던 브랜치.** greeting과 같은 커밋이라 고유 자산 없음. 클로이 세션의 작업 브랜치로 자동 생성된 것 |
| `claude/jev-routing-analysis` | `a345016` | greeting + JEV 분석 문서 1개 |
| `claude/video-analysis-insights-ql16ga` | `caf1336` | greeting + 지식 시스템 v2 설계 문서 1개 |
| `claude/dreamy-ritchie-jpz4r8` | `6de1d69` | greeting + `chatlog/`·`netlify-site/`·`seed/` (어사이드 담당 범위) |

## 2. 고유 자산 목록 (master에 같은 내용이 없는 파일)

### 2-1. `agents/` — Python 운영 에이전트 11종 + 테스트 (greeting 기반, 22개 파일)
전부 master에 없다. 테스트 94건(이관 21 · Tier2 16 · Tier3 19 · 현금흐름 38)이 로컬에서 통과했다(2026-09-28, 이 세션에서 실행).

| 에이전트 | master의 대응 기능 | 권고 |
|---|---|---|
| `content_agent` 마케팅 글 | 없음 | 이관 |
| `faq_agent` 문의 응대 | 없음 (`booking.html`에 FAQ 화면만) | 이관 |
| `sales_agent` 단체영업 | 없음 | 이관 |
| `review_agent` 리뷰 분류·답글 | 없음 | 이관 |
| `admin_agent` 봉화군 제출 문서·기한 | 부분(`forms/`의 서식, `bongplay-notify.js`) | 이관, 서식은 master 것 우선 |
| `cashflow_agent` 현금흐름 | 없음 (`simulator.html`은 손익) | 이관 |
| `complaint_agent` 민원 3일 기한 | **있음** — master 18개 파일이 민원을 다룸 (Supabase 기록) | 기록 기능은 이관하지 않음. 문서 초안 기능만 검토 |
| `safety_agent` 안전점검 기록 | **있음** — `pages/safety-check.html` + DB | 이관하지 않음 (기록이 두 곳에 생기면 안 됨) |
| `emergency_agent` 비상 플레이북 | **있음** — `pages/emergency.html` | 이관하지 않음. 플레이북 문구만 비교 |
| `daily_report` 일일 리포트 | **있음** — `closing.html`, 분석 뷰 | 이관하지 않음 |
| `forecast_agent` 수요예측 | **있음** — `backend_ai/` (Prophet + LightGBM) | 이관하지 않음. 요일계수 방식은 `backend_ai` 폴백 후보로만 기록 |

**이관 전에 반드시 맞출 것 — 기준값 충돌** (`agents/config.py` vs master 기준정보)

| 항목 | `agents/config.py` | master (현행 기준) |
|---|---|---|
| 시설명 | 리틀 포레스트 봉뜨락 | 리틀포레스트 **봉플레이** (`bongplay-site.js`) |
| 요금 | 전부 `None` (미확정) | 종합권 21,000 / 기본권 15,000 / 조조권 18,000 등 (`bongplay-id.js`) |
| 운영시간 | "미확정" | 10:00~18:00 (`bongplay-site.js`) |
| 손익분기 | 17,442명 · 고정비 2억 930만 · 객단가 12,000 | **19,606명** · 혼합객단가 **12,036원** · 일 BEP 660,000원 |
| 짚코스터 설명 | "**실내** 짚라인형" | 야외 시설 (`backend_ai` 강풍 폐쇄 로직 등) — config 쪽이 **틀림** |
| 인력 기준 | `STAFFING_TIERS` (자체 표) | `bongplay-site.js` staff 명단 + `backend_ai` SafetyFilter(짚 최소 2명) |

→ 이관할 때 `config.py`가 값을 **직접 들고 있지 않고 master 기준정보를 읽도록** 바꿔야 한다. 그대로 옮기면 기준값이 두 곳이 된다.

**데이터 저장소 충돌:** 에이전트는 로컬 `data/*.json`, master는 Supabase를 쓴다. 이관하는 에이전트도 운영 기록을 로컬 JSON에 새로 쌓으면 안 된다. 1차 이관은 "초안·문서 생성" 기능 위주로 하고, 기록 기능은 Supabase 연동을 별도 작업으로 설계한다.

**위치 제안 (벤 결정 필요):** `05_봉플레이_AI에이전트/`. 번호 폴더 규칙을 따르되, 웹 배포 대상(`01_`)과 섞지 않는다.

### 2-2. 사업 문서 (greeting 기반, 4개)

| 파일 | 상태 | 권고 |
|---|---|---|
| `봉화_리틀포레스트봉뜨락_운영계획서_초안.md` | BEP 17,442명 등 **master 이전 수치**. 140·320·321행에 조정 전 수치 잔존. 시장분석·리스크 표는 여전히 쓸모 있음 | `03_…/_참고_초기기획_20260830/` 에 "구버전" 머리말을 붙여 보관 |
| `봉뜨락_동료_제안서.html` | 채용 제안서. 보상 수치 포함(개인정보는 아님) | 대표 확인 후 결정. 채용이 끝났다면 보관만 |
| `봉뜨락_제안서_클로드디자인_프롬프트.md` | 위 제안서의 디자인 프롬프트 | 제안서와 함께 처리 |
| `scratchpad/bongttorak_pnl_grid.html` | 손익 그리드 | **이관하지 않음** — master `pages/simulator.html`이 대체 |

### 2-3. 분석·설계 문서 (각 1개)

| 파일 | 브랜치 | 권고 |
|---|---|---|
| `docs/분석_JEV_생성에서선택으로.md` | jev-routing-analysis | `docs/분석/`으로 이관. 단, `agents/` 경로를 전제로 쓴 부분은 이관 위치에 맞춰 고쳐야 함. **master `backend_ai`의 SafetyFilter(규칙이 RL 위에 얹힘)와 같은 원칙**이라 상호 참조 추가 권장 |
| `지식시스템_v2_설계.md` | video-analysis-insights | `docs/분석/`으로 이관 검토. 문서 안의 "`agents/` 11종" 언급은 이관 결과에 맞춰 갱신 필요. 설계를 실제로 적용할지는 대표 결정 |

### 2-4. 어사이드 담당 범위 (참고만, 이번 작업에서 판단하지 않음)
`claude/dreamy-ritchie-jpz4r8`의 `chatlog/`(Apps Script 7개), `seed/`(업무로그 초안 2개)는 master에 없다.
`netlify-site/` 중 `README.md`·`netlify.toml`은 master `04_봉뜨락_업무로그_AI/`와 **내용이 같고**, `api.mjs`·`public/index.html`은 다르다(벤 문서의 "master 쪽 394줄 추가"와 일치).

## 3. 이관 작업 분할 제안

| 제안 ID | 내용 | 선행 조건 |
|---|---|---|
| CLAUDE-002 | JEV·지식시스템 문서를 `docs/분석/`으로 이관 (경로 언급 수정 포함) | 없음. 문서만 |
| CLAUDE-003 | 운영계획서·제안서를 `03_…/_참고_초기기획_20260830/`로 보관 이관 | 대표의 제안서 처리 결정 |
| CLAUDE-004 | `agents/` 중 대응 기능 없는 6종(content·faq·sales·review·admin·cashflow)을 `05_`로 이관, `config.py`를 master 기준정보 참조로 전환, 테스트 통과 확인 | 벤의 위치 결정 |
| (보류) | complaint·safety·emergency·daily_report·forecast | 이관하지 않음. 필요 기능은 master 화면·Supabase 쪽에 요청 |

## 4. 검증

- 파일 대조: 각 브랜치 `git ls-tree -r`의 blob 해시를 master 전체와 비교 (스크립트 출력으로 2절 작성).
- `agents/` 테스트 94건: 2026-09-28 이 세션에서 `test_*.py` 4종 실행, 전부 통과. **master 기준값으로 바꾼 뒤에는 다시 돌려야 한다** (계절 목표·BEP 상수 의존 테스트 있음).
- 실행하지 못한 검증: master 화면의 실제 동작(안티그래비티 담당), Supabase 스키마와 에이전트 데이터 모델 대응.

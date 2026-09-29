# 05_봉플레이_AI에이전트 — 이관 설계 (CLAUDE-004, 1차 PR)

- 작성: 클로이 · 2026-09-29 · 기준 master `3830fad`
- 이 PR은 **설계 문서만** 담는다. 코드는 옮기지 않았다.
- 벤 검토 결정(2026-09-29): [BEN-004](../docs/migration/BEN-004_클로이_PR검토와_기준정보결정.md)의 요금 어긋남 검사·confirmed 승격·모델 명시·파일 무변경 검증 조건이 아래 초안의 선택안보다 우선한다. 004b는 클로이, 큰 구현인 004c/004d는 004b 병합 후 아난티에게 별도 배정한다.
- 원본 코드: `claude/greeting-4xvpmy` @ `0b774a0` 의 `agents/`
- 이관 대상 (BEN-002 결정): content · faq · sales · review · admin · cashflow, 그리고 실제로 필요한 공통 모듈과 테스트

---

## 1. 원칙 (BEN-002에서 그대로 가져옴)

1. 정적 웹 배포(`01_`)에 포함하지 않는다.
2. **1차 기능은 초안·분석 결과 생성으로 제한한다.** 다음은 1차에 넣지 않는다.
   - 자동 발송
   - 운영 원장 쓰기
   - 별도의 JSON 운영 원장
3. 사업 상수를 복제하지 않는다. Python에서 브라우저 JS를 실행하지 않는다.
4. 기록에 의존하는 기능은 **입력 스냅샷**으로 계산한다. Supabase 연동은 별도 설계로 뺀다.

---

## 2. 조사 결과 — 원본 코드에 숨은 의존성과 쓰기 경로

### 2-1. 이관 보류 모듈에 대한 의존 (CLAUDE-001에서 못 잡은 것)

| 이관 대상 | 의존하는 보류 모듈·데이터 | 처리 |
|---|---|---|
| `cashflow_agent` | `from forecast_agent import weekday_coefficients` — forecast는 **이관 보류** 모듈 | 순수 계산 함수만 `core/calc.py`로 분리해 옮긴다. forecast 에이전트 자체는 옮기지 않는다 |
| `cashflow_agent` | `load("daily")` — daily_report(보류)가 쓰는 로컬 원장 | 입력 스냅샷 파일로 대체 (4절) |
| `admin_agent sales` | `load("daily")` — 계약서 제7조⑥ 매출 자료 | 입력 스냅샷 파일로 대체 |
| `review_agent` | `from faq_agent import SAFETY_KEYWORDS, DISPUTE_KEYWORDS` | 둘 다 이관 대상이다. 다만 키워드는 `core/gate.py`로 분리한다 (faq를 import하면 faq의 부수효과까지 따라오므로) |

### 2-2. 로컬 쓰기 경로 전수 (1차에서 전부 제거 대상)

| 위치 | 쓰기 | 1차 처리 |
|---|---|---|
| `store._path()` | `load()`만 불러도 `data/` 폴더를 **만든다** (`DATA_DIR.mkdir`) — 읽기가 쓰기를 한다 | `store.py`를 이관하지 않는다 |
| `review_agent add` / `done` | `reviews.json` append / update | `analyze`(입력 → 결과 출력만)로 바꾸고 `done`은 뺀다 |
| `admin_agent setup` | `contract.json` save | 제거. 계약 기준일은 기준정보 계약(3절)에서 읽는다 |
| `cashflow_agent setup` / `expense` | `cash.json` save, `expenses.json` append | 제거. 보유 현금·지출은 입력 스냅샷에서 읽는다 |
| `store.save()` | `.bak` 파일 생성 | 이관하지 않음 |

content · faq · sales는 파일에 쓰지 않는다. 표준 출력과 API 호출만 한다.

---

## 3. 기준정보 계약 — `site_profile.json`

### 3-1. 왜 JSON 계약인가
현행 기준정보는 여러 곳에 흩어져 있다.
- `bongplay-site.js`: 시설·주소·운영시간·인력
- `bongplay-id.js` `PRODUCT_CATALOG`: 요금
- Supabase `master_targets`: BEP. 기본값이 `bep_visitors 19606`, `bep_revenue 236000000`
- BEN-002: 면적

게다가 BEN-002의 지적대로 **코드에 들어 있는 값이 현장 확정값이라는 보장이 없다.** 그래서 값마다 출처와 확인 상태를 함께 적는 계약 파일을 두고, 에이전트는 이 파일만 읽는다.

### 3-2. 형식 (초안)

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-29",
  "fields": {
    "facility.name": {
      "value": "리틀포레스트 봉플레이",
      "source": "01_봉플레이_운영시스템/assets/bongplay-site.js SITE.facility.name",
      "status": "system_default",
      "checked_at": "2026-09-29"
    },
    "area.play_space_m2": {
      "value": 657.785,
      "source": "03_…/20260907151214551_….hwpx 붙임1 실내놀이시설장 (BEN-002)",
      "status": "confirmed",
      "checked_at": "2026-09-29"
    },
    "area.building_gfa_m2": {
      "value": 924,
      "source": "03_…/놀이동 건축물대장.pdf 1쪽 연면적 (BEN-002)",
      "status": "confirmed",
      "checked_at": "2026-09-29"
    },
    "price.tkt_allday": {
      "value": 21000,
      "source": "봉플레이 웹 고지 요금 (pages/booking.html 정가 21,000원) · 대표 확인 2026-09-29",
      "status": "confirmed",
      "checked_at": "2026-09-29"
    },
    "hours.open": {
      "value": null,
      "source": "대표 확인 2026-09-29: 운영시간 미정",
      "status": "unverified",
      "checked_at": "2026-09-29"
    }
  }
}
```

**상태 4종과 사용 규칙** (004b에서 `unresolved` 추가 — BEN-004 "서로 다르면 unresolved")

| status | 뜻 | 고객에게 나가는 글 (faq·content·sales) | 내부 분석 (cashflow·admin) |
|---|---|---|---|
| `confirmed` | 대표 확인 또는 1차 공문서로 확인 | 사용 | 사용 |
| `system_default` | 운영시스템 코드·DB 기본값. 현장 확정 여부 미확인 | **사용하지 않음** → "확정 후 안내" | 사용하되 출력에 "(시스템 기본값)" 표시 |
| `unverified` | 미정이거나 출처 불명확 | 사용하지 않음 | 사용하지 않음 → 누락 경고 |
| `unresolved` | 출처끼리 값이 달라 결정 필요 | 사용하지 않음 | 사용하지 않음 |

필드가 없거나 `value`가 `null`이면 에이전트는 추정하지 않는다. 이것은 원본 `config.py`의 "미확정이면 지어내지 않는다" 원칙을 그대로 이은 것이다.

### 3-3. 누가 어떻게 만드나
- **1단계 (CLAUDE-004b):** 사람이 관리하는 JSON 파일로 둔다. 출처는 파일 경로와 항목명으로 적는다. 확인되지 않은 값은 `system_default`로 두고, 대표가 확인한 값만 `confirmed`로 올린다 (2026-09-29 확인분은 8절).
- **2단계 (별도 작업, 벤 조정):** Supabase `master_products` / `master_targets`에서 읽기 전용으로 생성하는 스크립트. 운영 DB 키와 권한 설계가 필요하다.
- **하지 않는 것:** Python에서 `bongplay-*.js`를 실행하거나 해석하는 것. 공통 `assets/` 수정.

### 3-4. 어긋남 감지 — 필수, 실패로 처리 (BEN-004 결정 1로 확정)
~~경고만 내는 방안~~은 채택되지 않았다. `core/price_check.py`가 confirmed 요금·할인마다 **profile 값 = 카탈로그 = 고객 고지**를 대조하고, 다음은 모두 **실패**(종료코드 1)다: 불일치, 추출 실패, 선언·id·필드 중복, 형식 변경(중첩 객체, 숫자 아닌 값, 금액 표기 변경), 고지에서 품목이 사라짐, **계약에 없는 새 고지 품목**. JS는 실행하지 않고 범위를 좁힌 정적 추출만 한다. profile을 자동으로 고치거나 승격하지 않는다.

---

## 4. 입력 스냅샷 — 기록 의존 기능의 입력

운영 원장(Supabase)은 **읽지도 쓰지도 않는다.** 사람이 내보낸 파일을 인자로 받는다.

| 기능 | 입력 | 형식 (초안) |
|---|---|---|
| `cashflow project/runway` | `--snapshot cash_snapshot.json` | `{as_of, cash_balance, fee_schedule:[{month, amount}], insurance_month, planned_expenses:[{date, amount, memo}]}` |
| `cashflow` 요일계수 | `--daily daily_export.csv` (선택) | `date, visitors, revenue`. `closing_records`/`sales_records` 내보내기 형태에 맞춰 확정 |
| `admin sales` | `--daily daily_export.csv` | 위와 같음 |
| `review stats` | `--reviews reviews_export.csv` | `date, platform, rating, text` |

사용료 분납(4개월)은 `fee_schedule`로 표현한다. 원본의 `--fee-month` 단일 일시납 가정은 쓰지 않는다.

---

## 5. 폴더 구조 (안)

```
05_봉플레이_AI에이전트/
  DESIGN.md              ← 이 문서
  README.md              ← 004b에서 작성
  requirements.txt       ← 004c에서 추가 (anthropic, pydantic). 004b는 표준 라이브러리만
  env.template           ← 키 템플릿만 (루트 .gitignore 가 .env.* 를 무시). 실제 키 커밋 금지
  site_profile.json      ← 3절 계약 (004b)
  core/
    profile.py           ← 계약 로더·상태 규칙 (API 키 불필요)
    gate.py              ← 안전·분쟁 키워드 (faq·review 공용)
    price_check.py       ← 요금 대조 (004b)
    settings.py          ← ANTHROPIC_MODEL 확인 (004b)
    calc.py              ← 순수 계산: 요일계수, 월별 현금 예측
    client.py            ← Anthropic 클라이언트·캐싱 (원본 client.py)
  agents/
    content.py  faq.py  sales.py  review.py  admin.py  cashflow.py
  tests/
    test_profile.py  test_gate.py  test_price_check.py  test_settings.py  test_no_side_effects.py  (004d: test_calc.py)
```

---

## 6. 테스트 계획 (API 키 없이 실행)

| 테스트 | 검증 내용 | 원본에서 가져오는 것 |
|---|---|---|
| `test_profile` | 상태별 사용 규칙. `system_default` 요금이 고객용 문구에 들어가지 않음. 필드 누락·`null` 시 "확정 후 안내"로 대체됨. 스키마 버전 불일치 시 즉시 종료 | 없음 (신규) |
| `test_gate` | 안전·분쟁 키워드 이관, 활용형 포함 | `test_escalation.py` 21건 그대로 |
| `test_calc` | 요일계수(표본 3일 미만 대체), 분납 4개월 반영, 과거 실적 이중계상 없음, 기준일이 속한 달의 잔여일 계산 | `test_cashflow.py`·`test_tier3.py` 중 순수 계산 부분만. **`store` 의존 케이스는 스냅샷 입력으로 다시 쓴다** |
| `test_no_side_effects` (004b 구현) | 모듈 폴더·입력 원본 폴더·작업 폴더의 파일 해시와 디렉터리 목록을 전후 비교해 **생성·수정·삭제·디렉터리 생성**을 모두 잡는다. 대상 코드는 bytecode 쓰기를 끈 자식 프로세스에서 네트워크·subprocess·쓰기 모드 open을 막고 실행. 검사기가 네 종류 변화를 실제로 잡는지도 확인 (BEN-004) | 없음 (신규). 2-2절의 숨은 쓰기 경로 재발 방지 |
| 리뷰 차단 | 위생·차별 등 추가 키워드 차단, 호평 오탐 없음 | `test_tier3.py` 리뷰 부분 |

**원본 94건 중 이관되지 않는 테스트:** `test_tier2.py`의 점검 기한·민원 3일 기한 케이스는 safety·complaint가 보류이므로 옮기지 않는다. 원본 브랜치에는 그대로 남는다.

**별도 보고 항목:** LLM을 실제로 호출하는 확인과 운영 DB 접근은 단위 테스트에 넣지 않는다. 실행했다면 PR에 따로 적는다.

---

## 7. PR 순서 (제안)

| 단계 | 내용 | 변경 범위 |
|---|---|---|
| **004a (이 PR)** | 설계 문서 | `05_…/DESIGN.md`, 작업표 |
| 004b | `site_profile.json` + `core/profile.py` + `core/gate.py` + 테스트 | `05_` 안에서만 |
| 004c | content · faq · sales 이관 (파일 쓰기가 원래 없는 3종) | `05_` 안에서만 |
| 004d | review · admin · cashflow를 상태 없는(스냅샷 입력) 방식으로 이관 + `test_no_side_effects` 대상에 추가 | `05_` 안에서만 |
| 별도 | Supabase 읽기 전용 생성기, 어긋남 감지 | 벤 범위 조정 필요 |

각 단계에서 원본 대비 바뀐 동작(없어진 명령, 달라진 인자)을 README 표로 남긴다.

---

## 8. 대표 결정 반영 (2026-09-29)

| 항목 | 결정 | 계약 반영 |
|---|---|---|
| 요금 | **봉플레이 웹에 고지된 그대로** 간다 | 웹(`pages/booking.html` 등)에 고객용으로 고지된 권종·가격만 `confirmed`. 운영시스템 카탈로그에만 있고 웹에 고지되지 않은 품목은 `system_default` 유지. 004b에서 고지 화면과 카탈로그를 품목별로 대조해 목록을 확정한다 |
| 주소 | **경상북도 봉화군 봉화읍 유록길 22** | `address.road` = `confirmed`. 지번은 건물별로 다르다 — 놀이동 석평리 1214-22 (`bongplay-site.js`), 사무동 1214-21 (구 운영계획서) — 에이전트는 도로명만 쓴다 |
| 운영시간 | **미정** | `hours.*` = `null` / `unverified`. faq·content는 "확정 후 안내"로 답한다. `bongplay-site.js`의 10:00~18:00은 쓰지 않는다 |

**충돌 보고:** 고객용 예약 화면 `01_봉플레이_운영시스템/pages/booking.html` 468행에 "운영 시간 10:00 ~ 18:00 (입장 마감 17:00)"이 이미 고지돼 있다. 대표 결정(미정)과 다르다. 이 PR은 운영 화면을 고치지 않는다 — 화면 담당과 벤의 조정이 필요하다.

## 9. 9절 질문의 결정 (BEN-004)

| # | 질문 | 결정 | 004b 반영 |
|---|---|---|---|
| 1 | 어긋남 감지 | 필수. 경고만으로 통과 금지 | `core/price_check.py`, `tests/test_price_check.py` |
| 2 | confirmed 승격 절차 | 출처·확인자·확인일(·시행일)을 기록한 PR을 벤이 검토 | 로더가 confirmed 에 `confirmed_by`·`confirmed_at`·`source.revision` 없으면 거부 |
| 3 | 시설 설명 | 확인된 기준정보로 생성. 규격 자동 보충 금지 | `profile.facility_description()` — confirmed 값만 사용 |
| 4 | 모델 ID | 하드코딩 금지, `ANTHROPIC_MODEL` 명시 | `core/settings.require_model()`, core 안 모델 ID 문자열 금지 테스트 |

## 10. 004b 구현 결과

### 요금 품목 대조 (고객 고지 `pages/booking.html` @ `d7ac76c` ↔ `PRODUCT_CATALOG` @ `3bada78`)

| 고지 품목 | 고지 | 카탈로그 | 판정 |
|---|---|---|---|
| 보호자 입장권 | 5,000원 | `tkt_guardian` 5,000 | **confirmed** |
| 단체 종합이용권 (20인 이상) | 16,800원 (정가 21,000) | `tkt_allday` 21,000 × (1 − `group20` 0.20) | **confirmed** |
| 봉화군민 우대 | 20% (현장 신분증 확인) | `resident` 0.20 | **confirmed** |
| 어린이 기본이용권 (2시간) | **14,000원** 오픈할인 (정가 15,000) | `tkt_basic` 15,000 · 같은 파일 주석 "2026-09-20 대표 결정: 11월 개장을 할인 요금으로 시작하지 않음" | **unresolved** — 대표 결정(09-29): 할인 없이 15,000원. 고지 정정 후 confirmed |
| 어린이집·유치원 평일 지원 단체권 | 7,000원 "지자체 보조·바우처 전용" | 없음 (구 목록 `PROD_GROUP_VOUCHER`에만) | **unresolved** — 대표 결정(09-29): 폐지. 고지 삭제 후 계약에서 제거 |
| 청소년·성인 액티비티권 | 10,000원 | 없음 | **unresolved** — 대표 결정(09-29): 폐지 |
| 국가유공자·장애인 우대 | 비율 없음 | 없음 | **unresolved** — 대표 결정(09-29): 폐지 |
| (고지 안 됨) 개인 종합권 · 조조권 | — | 21,000 · 18,000 | system_default |

**참고:** `bongplay-id.js` 안에 요금 목록이 두 벌 있다 — `PRODUCT_CATALOG`("2026 공식 요금표", SSOT 주석)와 그 아래 구 목록(`PROD_*`, 프로모션 14,000·바우처 7,000 포함). 고객 고지는 구 목록 쪽과 일치하는 항목이 있다. 또 고지의 "실내 924㎡ 돔놀이터"는 BEN-002 기준 건물 연면적이며 놀이공간 면적(657.8㎡)이 아니다. 두 사항 모두 이 PR 범위(05) 밖이라 수정하지 않았다.

대외 시설명은 대표 결정(09-29)으로 **리틀포레스트 봉플레이** confirmed. 결정 원문과 운영 화면 정정 요청: [CLAUDE-004b 대표결정 기록](../docs/migration/CLAUDE-004b_대표결정_20260929.md).

### 파일
`site_profile.json`, `core/{profile,price_check,gate,settings}.py`, `tests/test_*.py` 5종, `README.md`, `env.template`

### 검증
`python3 -B -m unittest discover -s tests` — 57건 통과 (키·모델·네트워크 없이). LLM 호출·운영 DB 접근은 하지 않았다.

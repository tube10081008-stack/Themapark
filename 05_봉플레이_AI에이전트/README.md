# 05_봉플레이_AI에이전트

봉플레이 운영을 돕는 AI 에이전트 폴더. 정적 웹 배포(`01_`)에 포함되지 않는다.
설계와 결정 기록은 [DESIGN.md](DESIGN.md), 기준은 [BEN-004](../docs/migration/BEN-004_클로이_PR검토와_기준정보결정.md).

## 현재 들어 있는 것 (CLAUDE-004b)

| 파일 | 역할 | 키·모델 필요 |
|---|---|---|
| `site_profile.json` | 기준정보 계약. 값마다 출처·확인 상태 | – |
| `core/profile.py` | 계약 로더, 고객용/내부용 사용 규칙, 시설 설명 생성 | 아니오 |
| `core/price_check.py` | confirmed 요금이 고객 고지·카탈로그와 같은지 대조. 불일치·추출 실패·미분류 가격은 실패 | 아니오 |
| `core/js_static.py` | JS 배열 리터럴을 실행 없이 읽는 제한적 파서. 중복·따옴표·계산 키, spread, 비리터럴 값, 선언 뒤 변경은 거부 | 아니오 |
| `tests/fixtures/` | 변형·회귀 테스트의 고정 기준 (요금 영역 `d7ac76c`, 카탈로그 `3bada78`, 전체 페이지 구 고지 `0e4b51b`·#11 보완본 `e4a6c74`). 실제 화면이 바뀌어도 수정하지 않는다 | – |
| `core/gate.py` | 안전·분쟁 문의·리뷰를 사람에게 넘기는 키워드 게이트 | 아니오 |
| `core/settings.py` | `ANTHROPIC_MODEL` 확인 (LLM 명령에서만 호출) | – |
| `env.template` | 환경변수 템플릿 (값 비어 있음). 루트 `.gitignore`가 `.env.*`를 무시하므로 이 이름을 쓴다 | – |

에이전트 본체(content·faq·sales·review·admin·cashflow)는 아직 없다. 004c·004d에서 이관한다.

## 실행

```bash
cd 05_봉플레이_AI에이전트
python3 -B -m unittest discover -s tests   # 전체 테스트 (키·모델·네트워크 불필요)
python3 -B -m core.price_check             # 요금 대조(코드 대조 결과 — 라이브 확인 아님). 실패가 있으면 종료코드 1
```

Python 3.10 이상, 표준 라이브러리만 쓴다. 확인한 환경: Linux, Python 3.11.15 — 전체 110건 통과.

부수효과 테스트 3건(`test_no_side_effects`)은 격리된 작업 폴더가 필요하다. 기본은 시스템 임시폴더다.
임시폴더를 만들 수 없는 환경(권한이 막힌 Windows 샌드박스 등)에서는 쓰기 가능한 기존 폴더를 지정한다.
감시 대상(05 폴더, `01_…/assets`, `01_…/pages`) 안은 거부한다.

```bash
# Linux/macOS
BONGPLAY_TEST_WORKDIR=/path/to/writable python3 -B -m unittest discover -s tests
# Windows PowerShell
$env:BONGPLAY_TEST_WORKDIR="C:\path\to\writable"; python -B -m unittest discover -s tests
```

## 기준정보 규칙

| status | 고객에게 나가는 글 | 내부 분석 |
|---|---|---|
| `confirmed` | 사용 | 사용 |
| `system_default` | 쓰지 않음 → "확정 후 안내" | 사용하되 표시 |
| `unverified` | 쓰지 않음 | 쓰지 않음 |
| `unresolved` | 쓰지 않음 | 쓰지 않음 |

- 값을 `confirmed`로 올리려면 `confirmed_by`·`confirmed_at`·`source.revision`(커밋 SHA 또는 문서 판본)을 적은 PR을 벤이 검토한다. 로더가 이 항목 없이는 파일을 거부한다.
- confirmed 요금·할인은 `price_check` 규칙이 있어야 하고, 고지·카탈로그와 다르면 `price_check`가 실패한다.
- 고객 고지에 새 품목·할인이 생겼는데 계약에 없으면 실패한다. 카드 구조는 CSS 클래스가 아니라 판매가(`<strong>N원</strong>`) 기준으로 찾고, 카드로 분류되지 않은 금액이나 카드 안의 다른 금액은 실패다. 광고 문구 등 예외는 계약의 `notice_allowed_text`에 정확한 문장으로만 허용한다.
- 혜택·지원·영역 밖 금액 (CLAUDE-006):
  - **G1** 요금 영역 안 카드 밖의 혜택 선언(우대·할인·감면·면제·무료)은 계약 할인 라벨 또는 계약 `source.item` 인용과 대응해야 한다. 제목·카드 설명은 제외.
  - **G1b** 페이지 어디서든 공공 주체(봉화군·군청·지자체 등)와 지원·보조·인센티브를 함께 말하면 실패 — 군 지원 확정 안내 금지 (BEN-011). '봉화군민'은 공공 주체가 아니다.
  - **G2** 요금 영역 밖 금액(`N원`)은 confirmed 요금과 같아야 한다. 범위·만 원 단위·한글 혼합 단위는 실패. ㎡·시각·전화·날짜·인원 등 '원'이 없는 숫자와 `<script>` 안 문구는 대상이 아니다.
- 실제 파일 판정(운영 화면 상태에 따라 달라짐)은 단위 테스트가 아니라 `core.price_check` CLI 가 사유와 함께 보고한다. 자세한 내용은 [CLAUDE-006 문서](../docs/migration/CLAUDE-006_가격고지_검사보강.md).
- 운영시간은 대표 결정으로 **미정**이다 (2026-09-29).

## 모델

모델 ID는 코드에 두지 않는다. LLM을 부르는 명령은 `ANTHROPIC_MODEL`이 없으면 설명을 남기고 종료한다.
`env.template`을 `.env`로 복사해 쓰되 실제 키와 `.env`는 커밋하지 않는다.

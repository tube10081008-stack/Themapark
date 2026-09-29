# 05_봉플레이_AI에이전트

봉플레이 운영을 돕는 AI 에이전트 폴더. 정적 웹 배포(`01_`)에 포함되지 않는다.
설계와 결정 기록은 [DESIGN.md](DESIGN.md), 기준은 [BEN-004](../docs/migration/BEN-004_클로이_PR검토와_기준정보결정.md).

## 현재 들어 있는 것 (CLAUDE-004b)

| 파일 | 역할 | 키·모델 필요 |
|---|---|---|
| `site_profile.json` | 기준정보 계약. 값마다 출처·확인 상태 | – |
| `core/profile.py` | 계약 로더, 고객용/내부용 사용 규칙, 시설 설명 생성 | 아니오 |
| `core/price_check.py` | confirmed 요금이 고객 고지·카탈로그와 같은지 대조. 불일치·추출 실패는 실패 | 아니오 |
| `core/gate.py` | 안전·분쟁 문의·리뷰를 사람에게 넘기는 키워드 게이트 | 아니오 |
| `core/settings.py` | `ANTHROPIC_MODEL` 확인 (LLM 명령에서만 호출) | – |
| `env.template` | 환경변수 템플릿 (값 비어 있음). 루트 `.gitignore`가 `.env.*`를 무시하므로 이 이름을 쓴다 | – |

에이전트 본체(content·faq·sales·review·admin·cashflow)는 아직 없다. 004c·004d에서 이관한다.

## 실행

```bash
cd 05_봉플레이_AI에이전트
python3 -B -m unittest discover -s tests   # 전체 테스트 (키·모델·네트워크 불필요)
python3 -B -m core.price_check             # 요금 대조. 실패가 있으면 종료코드 1
```

Python 3.10 이상, 표준 라이브러리만 쓴다.

## 기준정보 규칙

| status | 고객에게 나가는 글 | 내부 분석 |
|---|---|---|
| `confirmed` | 사용 | 사용 |
| `system_default` | 쓰지 않음 → "확정 후 안내" | 사용하되 표시 |
| `unverified` | 쓰지 않음 | 쓰지 않음 |
| `unresolved` | 쓰지 않음 | 쓰지 않음 |

- 값을 `confirmed`로 올리려면 `confirmed_by`·`confirmed_at`·`source.revision`(커밋 SHA 또는 문서 판본)을 적은 PR을 벤이 검토한다. 로더가 이 항목 없이는 파일을 거부한다.
- confirmed 요금·할인은 `price_check` 규칙이 있어야 하고, 고지·카탈로그와 다르면 `price_check`가 실패한다.
- 고객 고지에 새 품목이 생겼는데 계약에 없으면 실패한다.
- 운영시간은 대표 결정으로 **미정**이다 (2026-09-29).

## 모델

모델 ID는 코드에 두지 않는다. LLM을 부르는 명령은 `ANTHROPIC_MODEL`이 없으면 설명을 남기고 종료한다.
`env.template`을 `.env`로 복사해 쓰되 실제 키와 `.env`는 커밋하지 않는다.

# 봉뜨락 운영 에이전트 (Tier 1)

리틀 포레스트 봉뜨락 운영을 돕는 AI 에이전트 3종입니다.

| 파일 | 역할 | 모델 | 왜 필요한가 |
|---|---|---|---|
| `content_agent.py` | 마케팅 콘텐츠 생성 | Opus 5 | 비수기 일평균 24명을 채우는 것이 사업의 사활인데, 5명 조직으로는 콘텐츠를 지속 생산할 수 없음 |
| `faq_agent.py` | 고객문의 응대 | Haiku 4.5 | 반복 문의를 흡수해 매표 담당이 발권에 집중하게 함 |
| `sales_agent.py` | 단체영업 리스트업·제안서 | Opus 5 | 평일 비수기를 채우는 사실상 유일한 수단 |

## 설치

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # console.anthropic.com 에서 발급
```

`.env.example` 을 `.env` 로 복사해 쓰셔도 됩니다. `.env` 는 `.gitignore` 에 있으니
키가 저장소에 올라가지 않습니다.

## 사용법

### 1. 마케팅 콘텐츠

```bash
# 네이버 블로그 포스트
python3 content_agent.py "비 오는 날 아이와 갈 만한 곳"

# 인스타그램 캡션
python3 content_agent.py "짚코스터 첫 체험" -c instagram

# 맘카페 글 — 은어축제 기간 맥락을 넣어서
python3 content_agent.py "축제 다녀오는 길에 들르기 좋은 곳" -c cafe -x "은어축제 기간 연계"

# 재방문 유도 문자
python3 content_agent.py "겨울방학 재방문 할인" -c sms
```

채널: `blog` / `instagram` / `cafe` / `sms`

### 2. 고객문의 응대

```bash
# 단건
python3 faq_agent.py "주차장 있나요?"

# 대화형 (빈 줄 입력 시 종료)
python3 faq_agent.py

# 내부 판단 근거까지 보기
python3 faq_agent.py "몇 살부터 이용 가능한가요?" -v
```

### 3. 단체영업

```bash
# 지역 내 후보 기관 조사 (웹 검색 사용)
python3 sales_agent.py research "경북 봉화군"
python3 sales_agent.py research "경북 안동시" -k "초등학교"

# 특정 기관 제안서
python3 sales_agent.py proposal "봉화초등학교" -k 초등학교 -n "40명"
```

## 설정 바꾸기

`config.py` 한 곳만 고치면 세 에이전트에 모두 반영됩니다.

```python
PRICING = {"어린이(만7~13세 미만)": 12000, ...}   # 확정되면 숫자 입력
OPERATING_HOURS = "09:00 ~ 18:00"
RESERVATION_URL = "https://naver.me/..."
PHONE = "054-000-0000"
```

**요금·운영시간이 `None` / "미확정" 인 동안에는 에이전트가 임의의 숫자를 만들어내지
않고 "확정 후 안내 예정"으로 처리합니다.** 확정 전에 잘못된 숫자가 고객에게 나가는 것을
막기 위한 설계입니다.

## 안전 설계 — 반드시 알아두실 것

`faq_agent.py` 는 아래 주제가 문의에 포함되면 **API를 호출하지 않고 즉시 사람에게
넘깁니다.**

- 안전·사고 (사고, 다쳤, 부상, 위험, 추락, 119 …)
- 금전 분쟁 (환불, 보상, 배상, 소송 …)
- 민원 (민원, 불만, 항의, 군청 …)

개인명의 사업이라 무한책임 구조이고, 짚코스터는 인적 과실이 중대사고로 직결되는
시설입니다. **이 판단을 AI에 맡기면 안 됩니다.** 키워드는 `faq_agent.py` 의
`ESCALATE_KEYWORDS` 에서 늘릴 수 있습니다. 줄이지는 마십시오.

이관 로직은 API 없이 검증할 수 있습니다.

```bash
python3 test_escalation.py
```

## 비용

프롬프트 캐싱이 걸려 있어 반복 호출 시 입력 비용이 크게 줄어듭니다.
`-v` 또는 stderr 출력의 `캐시읽기` 값이 0이 아니면 캐시가 동작 중입니다.

예상 월 비용 (마케팅 20건 + 문의 800건 + 제안서 15건 기준): **약 15,000원**

## 주의

- `sales_agent.py research` 는 웹 검색 결과에 의존합니다. 기관명·규모는 **반드시
  직접 확인**하고 쓰십시오. 연락처와 담당자명은 지어내지 않도록 지시했지만,
  검색 결과 자체가 오래됐을 수 있습니다.
- 생성된 콘텐츠는 그대로 게시하지 말고 사실관계를 확인한 뒤 올리십시오.
  특히 요금·운영시간·개장일이 들어간 문구는 반드시 검토가 필요합니다.

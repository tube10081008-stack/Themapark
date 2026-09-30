"""사람에게 넘겨야 하는 문의·리뷰를 가려내는 키워드 게이트.

원본: claude/greeting-4xvpmy @ 0b774a0 의 agents/faq_agent.py(28~51행),
agents/review_agent.py(24~35행). 키워드는 그대로 옮겼다.

이 게이트는 모델을 부르기 **전에** 돈다. 여기에 걸린 입력은 모델 판단·확률
임계값에 맡기지 않고 무조건 사람에게 넘긴다 (BEN-004, JEV 분석 문서 5절).

한국어 활용형 주의 — 어간 하나만 넣으면 시제·어미에 따라 빠져나간다.
예: "다쳤어요"는 잡히는데 "다칠 뻔했어요"(아차사고)는 안 잡힌다.
사고 관련 동사는 과거형·미래형·어간을 함께 등록할 것. 키워드를 줄이지 말 것.
"""

SAFETY_KEYWORDS = (
    # 실제 발생
    "사고", "부상", "골절", "응급", "구급", "119", "구조대",
    # 다치다 활용형
    "다쳤", "다칠", "다치", "다침", "다쳐",
    # 추락·충돌·끼임 (아차사고 포함)
    "추락", "떨어졌", "떨어질", "부딪", "끼였", "끼임", "미끄러졌", "미끄러질",
    # 안전 문의
    "안전한가", "안전하나", "위험",
    # 신체 이상
    "아팠", "아파요", "토했", "어지러",
)

DISPUTE_KEYWORDS = (
    "환불", "보상", "배상", "변상", "소송", "고소",
)

# 문의 라우팅용 — 공개 리뷰에는 적용하지 않는다.
# "사장님이 친절하셨어요" 같은 호평까지 차단되면 리뷰 분류 통계에서 통째로 빠진다.
ROUTING_KEYWORDS = (
    "민원", "불만", "항의", "책임자", "사장", "군청", "취소해", "신고할",
)

# 공개 리뷰에서만 추가로 문제되는 주제
REVIEW_EXTRA_KEYWORDS = (
    "위생", "벌레", "식중독", "차별", "폭언", "성희롱",
)

INQUIRY_KEYWORDS = SAFETY_KEYWORDS + DISPUTE_KEYWORDS + ROUTING_KEYWORDS
REVIEW_KEYWORDS = SAFETY_KEYWORDS + DISPUTE_KEYWORDS + REVIEW_EXTRA_KEYWORDS

_CHANNELS = {
    "inquiry": INQUIRY_KEYWORDS,
    "review": REVIEW_KEYWORDS,
}


def escalation_hit(text: str, channel: str) -> str | None:
    """사람에게 넘겨야 하면 걸린 키워드를, 아니면 None 을 돌려준다.

    channel: "inquiry"(고객 문의) 또는 "review"(공개 리뷰).
    알 수 없는 채널은 조용히 통과시키지 않고 오류로 끝낸다.
    """
    if channel not in _CHANNELS:
        raise ValueError(f"알 수 없는 채널: {channel!r} (inquiry / review 중 하나)")
    if not isinstance(text, str):
        raise TypeError("text 는 문자열이어야 합니다")
    for kw in _CHANNELS[channel]:
        if kw in text:
            return kw
    return None

"""이관 로직 검증 — API 키 없이 실행된다.

안전·사고·분쟁 문의가 사람에게 넘어가는지 확인한다.
ESCALATE_KEYWORDS를 수정했다면 반드시 이 스크립트를 다시 돌릴 것.

    python3 test_escalation.py
"""

import sys

from faq_agent import needs_human

# (문의, 사람에게 넘겨야 하는가)
CASES = [
    # 자동 응대해도 되는 것
    ("주차장 있나요?", False),
    ("몇 시까지 하나요?", False),
    ("몇 살부터 탈 수 있어요?", False),
    ("실내인가요 실외인가요?", False),
    ("주말에도 여나요?", False),
    # 반드시 사람이 받아야 하는 것
    ("아이가 다쳤는데 어떻게 하나요", True),
    ("환불 되나요?", True),
    ("짚코스터 안전한가요?", True),
    ("민원 넣겠습니다", True),
    ("사고 났을 때 보상은요?", True),
    ("애가 떨어졌어요", True),
    ("책임자 바꿔주세요", True),
    ("위험해 보이는데 괜찮나요", True),
    ("소송하겠습니다", True),
]


def main() -> int:
    failed = 0
    for question, should_escalate in CASES:
        hit = needs_human(question)
        actual = hit is not None
        if actual == should_escalate:
            mark, detail = "통과", (f" (키워드 '{hit}')" if hit else "")
        else:
            mark, detail = "실패", f" — 기대 {should_escalate}, 실제 {actual}"
            failed += 1
        print(f"[{mark}] {question!r} → 이관={actual}{detail}")

    print(f"\n{len(CASES) - failed}/{len(CASES)} 통과")
    if failed:
        print("실패한 항목이 있습니다. ESCALATE_KEYWORDS를 확인하세요.", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

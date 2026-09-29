"""키워드 게이트 — 원본 test_escalation.py 21건 + test_tier3.py 리뷰 차단 10건을 그대로 옮겼다."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.gate import escalation_hit  # noqa: E402

INQUIRY_CASES = [
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
    # 아차사고 — 활용형이 달라 빠져나가기 쉬운 표현들
    ("애가 다칠 뻔했어요", True),
    ("떨어질 뻔했는데 안전요원이 없었어요", True),
    ("다치면 보험 처리 되나요", True),
    ("아이가 부딪혔어요", True),
    ("그물에 발이 끼였어요", True),
    ("바닥에서 미끄러졌습니다", True),
    ("놀다가 배가 아파요", True),
]

REVIEW_MUST_BLOCK = [
    "애가 짚코스터에서 다칠 뻔했어요",
    "떨어질 뻔했습니다",
    "화장실에 벌레가 나왔어요",
    "환불해 주세요",
    "직원이 폭언을 했습니다",
    "위생상태가 엉망",
]
REVIEW_MUST_PASS = [
    "아이들이 정말 좋아했어요",
    "주차하기 편해서 좋았습니다",
    "대기시간이 좀 길었어요",
    "재방문 의사 있습니다",
]


class InquiryGate(unittest.TestCase):
    def test_original_21_cases(self):
        self.assertEqual(len(INQUIRY_CASES), 21)
        for text, expect in INQUIRY_CASES:
            with self.subTest(text=text):
                self.assertEqual(escalation_hit(text, "inquiry") is not None, expect)


class ReviewGate(unittest.TestCase):
    def test_block(self):
        for text in REVIEW_MUST_BLOCK:
            with self.subTest(text=text):
                self.assertIsNotNone(escalation_hit(text, "review"))

    def test_pass(self):
        for text in REVIEW_MUST_PASS:
            with self.subTest(text=text):
                self.assertIsNone(escalation_hit(text, "review"))

    def test_routing_words_not_applied_to_reviews(self):
        # 호평 오탐 방지: '사장' 은 문의에서만 이관
        self.assertIsNone(escalation_hit("사장님이 친절하셨어요", "review"))
        self.assertEqual(escalation_hit("사장님 바꿔주세요", "inquiry"), "사장")


class GateInputs(unittest.TestCase):
    def test_empty_text_passes(self):
        self.assertIsNone(escalation_hit("", "inquiry"))

    def test_unknown_channel_fails(self):
        with self.assertRaises(ValueError):
            escalation_hit("환불", "sms")

    def test_non_string_fails(self):
        with self.assertRaises(TypeError):
            escalation_hit(None, "inquiry")


if __name__ == "__main__":
    unittest.main()

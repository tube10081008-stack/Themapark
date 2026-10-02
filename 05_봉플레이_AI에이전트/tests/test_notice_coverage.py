"""CLAUDE-006 — G1 혜택 문구, G1b 공적 지원 주장, G2 요금 영역 밖 금액.

전부 고정 fixture 위에서 돈다 (실제 운영 화면 상태와 무관). 임시 파일을 만들지 않는다.
- page_booking_0e4b51b.html : 구 고지 전체 페이지 (master, #11 병합 전)
- page_booking_e4a6c74.html : 보완본 전체 페이지 (#11)
"""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.price_check import run_checks  # noqa: E402
from core.profile import DEFAULT_PATH, load_profile, profile_from_data  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
FJS = (FIX / "catalog_bongplay_id_3bada78.js").read_text(encoding="utf-8")
OLD = (FIX / "page_booking_0e4b51b.html").read_text(encoding="utf-8")
NEW = (FIX / "page_booking_e4a6c74.html").read_text(encoding="utf-8")
BASE = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
ABOLISHED = ("price.daycare_group_voucher", "price.teen_adult_activity", "discount.merit_disability")


def promoted():
    """CLAUDE-007 이 만들 계약을 메모리에서 흉내낸다 (실제 계약 파일은 바꾸지 않는다)."""
    d = copy.deepcopy(BASE)
    f = d["fields"]
    b = f["price.tkt_basic"]
    b.update(status="confirmed", confirmed_by="테스트", confirmed_at="2026-09-29",
             price_check={"catalog_id": "tkt_basic", "notice_title": "어린이 기본이용권 (2시간)",
                          "notice_field": "sale"})
    b["source"]["revision"] = "test"
    for k in ABOLISHED:
        del f[k]
    return profile_from_data(d)


def results(html, profile=None):
    return run_checks(profile or load_profile(), FJS, html)


def bad(html, profile=None, key=None):
    return [r for r in results(html, profile) if not r.ok and (key is None or r.key == key)]


def sub(text, old, new):
    out = text.replace(old, new, 1)
    assert out != text, f"fixture 치환 실패: {old!r}"
    return out


SECTION_END = "<!-- Local Discount Notice -->"
OUTSIDE = "<!-- 5. GROUP VISIT CALLOUT BANNER"


class OldNotice(unittest.TestCase):
    """구 고지 — 현재 계약(승격 전)으로 대조하면 G1b·G2 실패 사유가 정확히 나와야 한다."""

    def test_old_page_g2_failures(self):
        msgs = [r.message for r in bad(OLD, key="(G2 영역 밖 금액)")]
        self.assertEqual(sum("'7,000원'" in m for m in msgs), 2, msgs)
        self.assertEqual(sum("'30~50만 원'" in m for m in msgs), 2, msgs)
        self.assertTrue(all("ride_coaster_single" in m for m in msgs if "'7,000원'" in m))

    def test_old_page_public_support_claims(self):
        msgs = [r.message for r in bad(OLD, key="(G1b 공적 지원 주장)")]
        self.assertTrue(any("지자체 보조" in m for m in msgs), msgs)
        self.assertTrue(any("봉화군 관광버스 임차비 지원" in m for m in msgs), msgs)

    def test_old_page_g1_passes_with_current_contract(self):
        # 폐지 결정된 '국가유공자·장애인 우대' 는 아직 계약(unresolved)에 남아 있어 대응된다
        self.assertEqual(bad(OLD, key="(G1 혜택 고지)"), [])


class NewNotice(unittest.TestCase):
    """보완본 — 요금 영역은 정리됐지만 버스비 지원 문구는 남아 있다."""

    def test_confirmed_prices_and_g1_pass(self):
        rs = results(NEW, promoted())
        for key in ("price.tkt_basic", "price.tkt_guardian", "price.group_allday", "discount.resident_rate"):
            self.assertTrue(any(r.key == key and r.ok for r in rs), key)
        self.assertEqual(bad(NEW, promoted(), "(G1 혜택 고지)"), [])

    def test_out_of_section_16800_matches_confirmed(self):
        oks = [r for r in results(NEW) if r.key == "(G2 영역 밖 금액)" and r.ok]
        self.assertEqual(len(oks), 2)
        self.assertTrue(all("price.group_allday" in r.message for r in oks))

    def test_bus_subsidy_still_blocked(self):
        g2 = [r.message for r in bad(NEW, key="(G2 영역 밖 금액)")]
        self.assertEqual(sum("'30~50만 원'" in m for m in g2), 2, g2)
        g1b = [r.message for r in bad(NEW, key="(G1b 공적 지원 주장)")]
        self.assertEqual(len(g1b), 3, g1b)

    def test_only_known_blockers_remain(self):
        keys = {r.key for r in bad(NEW, promoted())}
        self.assertEqual(keys, {"(G2 영역 밖 금액)", "(G1b 공적 지원 주장)"})


class G1Benefit(unittest.TestCase):
    """CLAUDE-005 G1 — 금액·비율 없는 폐지 우대 문구."""

    def test_abolished_merit_phrase_readded_fails(self):
        html = sub(NEW, "(현장 신분증 확인)</span>", "(현장 신분증 확인)</span>\n<span>국가유공자·장애인 우대</span>")
        msgs = [r.message for r in bad(html, promoted(), "(G1 혜택 고지)")]
        self.assertTrue(any("국가유공자·장애인 우대" in m for m in msgs), msgs)

    def test_other_unmapped_benefit_phrases_fail(self):
        for phrase in ("경로 우대", "다자녀 가정 무료", "임산부 입장료 면제", "기초수급 감면"):
            with self.subTest(phrase=phrase):
                html = sub(NEW, "(현장 신분증 확인)</span>", f"(현장 신분증 확인)</span>\n<span>{phrase}</span>")
                self.assertTrue(bad(html, promoted(), "(G1 혜택 고지)"))

    def test_headings_and_cards_are_not_declarations(self):
        # 제목 '이용 요금 및 우대 혜택', 보호자 카드 '… 1잔 무료 교환' 은 G1 대상이 아니다
        self.assertIn("이용 요금 및 우대 혜택", NEW)
        self.assertIn("무료 교환", NEW)
        self.assertEqual(bad(NEW, promoted(), "(G1 혜택 고지)"), [])

    def test_non_benefit_text_ignored(self):
        html = sub(NEW, "(현장 신분증 확인)</span>", "(현장 신분증 확인)</span>\n<span>현장 결제 가능</span>")
        self.assertEqual(bad(html, promoted(), "(G1 혜택 고지)"), [])

    def test_labelled_discount_passes(self):
        self.assertTrue(any(r.key == "(G1 혜택 고지)" and r.ok for r in results(NEW, promoted())))


class G1bPublicSupport(unittest.TestCase):
    def test_resident_is_not_public_funding(self):
        html = sub(NEW, OUTSIDE, "<p>봉화군민 20% 우대 할인 지원</p>" + OUTSIDE)
        msgs = [r.message for r in bad(html, key="(G1b 공적 지원 주장)")]
        self.assertFalse(any("봉화군민 20%" in m for m in msgs), msgs)

    def test_operator_support_without_public_body_passes(self):
        before = len(bad(NEW, key="(G1b 공적 지원 주장)"))
        html = sub(NEW, OUTSIDE, "<p>원스톱 견학 행정 지원</p>" + OUTSIDE)
        self.assertEqual(len(bad(html, key="(G1b 공적 지원 주장)")), before)

    def test_public_body_claims_fail(self):
        for t in ("군청 보조금으로 입장료 지원", "지자체 인센티브 연계"):
            with self.subTest(t=t):
                before = len(bad(NEW, key="(G1b 공적 지원 주장)"))
                html = sub(NEW, OUTSIDE, f"<p>{t}</p>" + OUTSIDE)
                self.assertEqual(len(bad(html, key="(G1b 공적 지원 주장)")), before + 1)

    def test_attribute_claim_fails(self):
        before = len(bad(NEW, key="(G1b 공적 지원 주장)"))
        html = sub(NEW, OUTSIDE, '<a title="봉화군 버스비 지원 안내">x</a>' + OUTSIDE)
        self.assertEqual(len(bad(html, key="(G1b 공적 지원 주장)")), before + 1)


class G2OutOfSection(unittest.TestCase):
    def g2_bad(self, snippet):
        base = {r.message for r in bad(NEW, promoted(), "(G2 영역 밖 금액)")}
        html = sub(NEW, OUTSIDE, snippet + OUTSIDE)
        return [r.message for r in bad(html, promoted(), "(G2 영역 밖 금액)") if r.message not in base]

    def test_wrong_price_outside_section_fails(self):
        msgs = self.g2_bad("<p>단체 종합이용권(17,000원)</p>")
        self.assertTrue(msgs and "계약에 없는 금액" in msgs[0], msgs)

    def test_old_price_outside_section_fails(self):
        msgs = self.g2_bad("<p>기본권 14,000원</p>")
        self.assertTrue(msgs, msgs)

    def test_unconfirmed_catalog_price_fails(self):
        msgs = self.g2_bad("<p>조조권 18,000원</p>")
        self.assertTrue(msgs and "확정되지 않은 금액" in msgs[0], msgs)

    def test_confirmed_price_with_particle_passes(self):
        self.assertEqual(self.g2_bad("<p>단체는 16,800원에 이용하세요</p>"), [])

    def test_ranges_and_man_units_fail(self):
        for t in ("버스비 30~50만 원", "최대 50만원 지원", "10,000-20,000원"):
            with self.subTest(t=t):
                msgs = self.g2_bad(f"<p>{t}</p>")
                self.assertTrue(msgs and "범위·만 원" in msgs[0], msgs)

    def test_ambiguous_korean_units_fail(self):
        for t in ("1만5천원", "1만 5000원", "5천원"):
            with self.subTest(t=t):
                msgs = self.g2_bad(f"<p>{t}</p>")
                self.assertTrue(msgs and "해석 불가" in msgs[0], msgs)

    def test_non_money_numbers_ignored(self):
        snippet = ("<p>실내 놀이공간 657.8㎡(약 199평), 10:00~18:00, 054-000-0000, 2026-09-29, "
                   "1:1 통제, 360도 커브, 20인 이상, 원스톱 접수, 원터치 변경, 인원 30명</p>")
        self.assertEqual(self.g2_bad(snippet), [])

    def test_attribute_money_checked(self):
        msgs = self.g2_bad('<input placeholder="예: 9,000원">')
        self.assertTrue(msgs and "@placeholder" in msgs[0], msgs)

    def test_script_text_out_of_scope(self):
        self.assertEqual(self.g2_bad("<script>var msg = '9,000원';</script>"), [])

    def test_inside_section_still_uses_card_rules(self):
        # 요금 영역 안의 카드 밖 금액은 여전히 추출 실패(미분류 가격)다
        html = sub(NEW, SECTION_END, "<p>9,000원</p>" + SECTION_END)
        rs = results(html, promoted())
        self.assertTrue(rs and not rs[0].ok and "미분류" in rs[0].message)


if __name__ == "__main__":
    unittest.main()

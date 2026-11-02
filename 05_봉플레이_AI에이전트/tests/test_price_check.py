"""요금 대조 — 불일치·추출 실패는 모두 실패여야 한다 (BEN-004 결정 1, BEN PR-009 R1·R2).

- 변형·회귀 테스트는 **고정 fixture**(tests/fixtures/) 위에서 돈다. 실제 운영 화면이 올바르게
  정정돼도(예: 기본권 14,000 → 15,000) 이 테스트가 옛 화면으로 되돌리기를 요구하지 않는다.
- 실제 파일 테스트는 "현재 confirmed 값이 현재 고지·카탈로그와 일치하는가"만 본다.
- 임시 파일을 만들지 않는다 (profile_from_data 사용).
- PRICE-20261102: 옛 고지·카탈로그 fixture 의 변형 테스트는 그 시점 계약(892a061)의 고정본
  `fixtures/profile_892a061.json` 으로 돈다 (검사 규칙은 그대로). 새 계약은 합성 고지
  `fixtures/notice_contract_20261102_synthetic.html` 과 fixture 카탈로그를 확정 요금으로 바꾼
  사본으로 따로 검증한다.
"""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.js_static import read_const_array  # noqa: E402
from core.price_check import (  # noqa: E402
    CATALOG_PATH, NOTICE_PATH, ExtractError, catalog_deprecated, catalog_prices, discount_rates,
    read_notice, run_checks,
)
from core.profile import DEFAULT_PATH, ProfileError, load_profile, profile_from_data  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"
FJS = (FIX / "catalog_bongplay_id_3bada78.js").read_text(encoding="utf-8")
FHTML = (FIX / "notice_booking_d7ac76c.html").read_text(encoding="utf-8")
# 옛 fixture(고지 d7ac76c·카탈로그 3bada78)와 짝인 계약 고정본 (892a061 site_profile.json 그대로)
BASE = json.loads((FIX / "profile_892a061.json").read_text(encoding="utf-8"))
CURRENT = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))
GUARDIAN = "list_price: 5000,  customer: 'adult'"


def profile_with(mutate=None, base=None):
    data = copy.deepcopy(BASE if base is None else base)
    if mutate:
        mutate(data)
    return profile_from_data(data)


def failed(results):
    return [r for r in results if not r.ok]


def fails(js=FJS, html=FHTML, profile=None):
    return failed(run_checks(profile or profile_with(), js, html))


def sub(text, old, new):
    out = text.replace(old, new, 1)
    assert out != text, f"fixture 치환 실패: {old!r}"
    return out


class RealFiles(unittest.TestCase):
    """실제 저장소 파일 — 현재 confirmed 값만 본다. 특정 옛 문구를 전제하지 않는다."""

    def test_current_confirmed_prices_match(self):
        js = CATALOG_PATH.read_text(encoding="utf-8")
        html = NOTICE_PATH.read_text(encoding="utf-8")
        bad = fails(js, html, profile=load_profile())
        self.assertEqual(bad, [], [r.message for r in bad])


class FixtureBaseline(unittest.TestCase):
    def test_fixture_passes(self):
        self.assertEqual(fails(), [])

    def test_extractors(self):
        self.assertEqual(catalog_prices(FJS)["tkt_guardian"], 5000)
        self.assertEqual(discount_rates(FJS)["group20"], 0.2)
        items, loose = read_notice(FHTML)
        self.assertEqual(items["단체 종합이용권 (20인 이상)"],
                         {"sale": 16800, "list": 21000, "extras": []})
        self.assertEqual(loose, ["봉화군민 20% 우대 할인"])

    def test_alias_copy_is_not_a_mutation(self):
        # 실제 코드: PRODUCT_CATALOG.forEach(function (p) { p.price = p.list_price; ... })
        self.assertIn("p.price = p.list_price", FJS)
        self.assertEqual(len(read_const_array(FJS, "PRODUCT_CATALOG")), 17)


class R1QuotedAndAmbiguousKeys(unittest.TestCase):
    """BEN PR-009 R1 — 실효 값이 바뀌거나 모호한 구문은 실패."""

    def assertCatalogFails(self, js):
        bad = fails(js=js)
        self.assertTrue(bad, "통과하면 안 됨")
        self.assertIn("추출 실패", bad[0].message)

    def test_ben_repro_quoted_duplicate_key(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000, 'list_price': 6000, customer: 'adult'"))

    def test_double_quoted_duplicate_key(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, 'list_price: 5000, "list_price": 6000, customer: \'adult\''))

    def test_plain_duplicate_key(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000, list_price: 6000, customer: 'adult'"))

    def test_duplicate_id(self):
        self.assertCatalogFails(sub(FJS, "// 1. 이용권",
                                    "{ id: 'tkt_guardian', list_price: 5000 },\n    // 1. 이용권"))

    def test_computed_key(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "['list_price']: 6000, customer: 'adult'"))

    def test_spread(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000, ...OVERRIDE, customer: 'adult'"))

    def test_identifier_value(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: PRICE_GUARDIAN,  customer: 'adult'"))

    def test_expression_value(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000 + 1000,  customer: 'adult'"))

    def test_template_with_expression(self):
        self.assertCatalogFails(sub(FJS, "customer: 'adult'", "customer: `${who}`"))

    def test_nested_object(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000, meta: { x: 1 }, customer: 'adult'"))

    def test_shorthand_property(self):
        self.assertCatalogFails(sub(FJS, GUARDIAN, "list_price: 5000, customer, x: 'adult'"))

    def test_missing_declaration(self):
        self.assertCatalogFails(FJS.replace("const PRODUCT_CATALOG", "const PRODUCT_LIST"))

    def test_redeclaration(self):
        self.assertCatalogFails(FJS + "\nlet PRODUCT_CATALOG = [];\n")

    def test_push_after_declaration(self):
        self.assertCatalogFails(FJS + "\nPRODUCT_CATALOG.push({ id: 'x', list_price: 1 });\n")

    def test_index_write_after_declaration(self):
        self.assertCatalogFails(FJS + "\nPRODUCT_CATALOG[3].list_price = 6000;\n")

    def test_property_write_in_loop(self):
        self.assertCatalogFails(sub(FJS, "p.price = p.list_price;", "p.list_price = 6000; p.price = p.list_price;"))

    def test_bracket_property_write(self):
        self.assertCatalogFails(sub(FJS, "p.price = p.list_price;", "p['list_price'] = 6000; p.price = p.list_price;"))

    def test_increment_and_delete(self):
        self.assertCatalogFails(sub(FJS, "p.price = p.list_price;", "p.list_price++; p.price = p.list_price;"))
        self.assertCatalogFails(sub(FJS, "p.price = p.list_price;", "delete p.list_price; p.price = 0;"))

    def test_discount_rate_write(self):
        self.assertCatalogFails(FJS + "\nDISCOUNT_RULES.forEach(function (r) { r.rate = 0.3; });\n")

    def test_comment_and_string_are_not_properties(self):
        js = sub(FJS, GUARDIAN, "list_price: 5000, /* list_price: 9999, */ note: 'list_price: 9999', customer: 'adult'")
        self.assertEqual(catalog_prices(js)["tkt_guardian"], 5000)
        self.assertEqual(fails(js=js), [])


class ValueMismatch(unittest.TestCase):
    def test_profile_value_differs(self):
        p = profile_with(lambda d: d["fields"]["price.tkt_guardian"].update(value=6000))
        self.assertTrue(any(r.key == "price.tkt_guardian" for r in fails(profile=p)))

    def test_catalog_value_differs(self):
        self.assertTrue(fails(js=sub(FJS, GUARDIAN, "list_price: 5500,  customer: 'adult'")))

    def test_notice_value_differs(self):
        self.assertTrue(fails(html=sub(FHTML, "5,000원</strong>", "4,000원</strong>")))

    def test_group_list_price_differs(self):
        self.assertTrue(fails(html=sub(FHTML, "정가 21,000원</div>", "정가 22,000원</div>")))

    def test_resident_rate_differs(self):
        self.assertTrue(fails(html=sub(FHTML, "봉화군민 20% 우대", "봉화군민 10% 우대")))

    def test_unknown_spec_key(self):
        p = profile_with(lambda d: d["fields"]["price.tkt_guardian"]["price_check"].update(tolerance=500))
        self.assertTrue(fails(profile=p))


class R2UnclassifiedNotice(unittest.TestCase):
    """BEN PR-009 R2 — 클래스·태그가 다른 신규 카드, 분류되지 않은 가격은 실패."""

    ANCHOR = "<!-- Guardian ticket"

    def insert(self, snippet):
        return sub(FHTML, self.ANCHOR, snippet + self.ANCHOR)

    def assertFlags(self, html, needle):
        msgs = [r.message for r in fails(html=html)]
        self.assertTrue(any(needle in m for m in msgs), msgs)

    def test_ben_repro_py3_card(self):
        self.assertFlags(self.insert(
            '<div class="py-3 flex"><div class="font-extrabold">새 권종</div><strong>9,000원</strong></div>'),
            "새 권종")

    def test_classless_card_with_other_tags(self):
        self.assertFlags(self.insert("<section><p>야간 이용권</p><b>x</b><strong>8,000원</strong></section>"),
                         "야간 이용권")

    def test_price_not_in_strong_is_unclassified(self):
        self.assertFlags(self.insert('<div class="py-2.5"><span>숨은 권종</span><span>9,000원</span></div>'),
                         "미분류")

    def test_loose_amount_outside_cards(self):
        self.assertFlags(sub(FHTML, "국가유공자·장애인 우대", "국가유공자·장애인 3,000원 할인"), "미분류")

    def test_extra_amount_in_existing_card(self):
        self.assertFlags(sub(FHTML, "숲속 쉼터 입장 +", "숲속 쉼터 입장(주말 6,000원) +"), "다른 금액")

    def test_allowed_text_must_match_exactly(self):
        self.assertFlags(sub(FHTML, "음료 포함 실질 0원", "음료 포함 실질 1,000원"), "다른 금액")

    def test_new_percent_discount_line(self):
        self.assertFlags(sub(FHTML, "<span>국가유공자·장애인 우대</span>",
                             "<span>경로 30% 할인</span>"), "계약에 없는 할인")

    def test_duplicate_title(self):
        bad = fails(html=sub(FHTML, "<span>보호자 입장권</span>", "<span>단체 종합이용권 (20인 이상)</span>"))
        self.assertTrue(bad and "추출 실패" in bad[0].message)

    def test_format_change_existing_item(self):
        # 금액 표기가 바뀌면 판매가 앵커가 사라지고 confirmed 품목 대조가 실패한다
        self.assertTrue(fails(html=sub(FHTML, "5,000원</strong>", "5,000 KRW</strong>")))

    def test_confirmed_item_renamed(self):
        self.assertTrue(fails(html=sub(FHTML, "<span>보호자 입장권</span>", "<span>보호자 이용권</span>")))

    def test_section_missing(self):
        bad = fails(html=FHTML.replace('id="sectionPricing"', 'id="pricing"'))
        self.assertTrue(bad and "추출 실패" in bad[0].message)


class PendingNoticeFix(unittest.TestCase):
    """기본권 15,000원(대표 결정) 승격 규칙 — 옛 고지 fixture 에서는 실패, 정정된 고지에서는 통과."""

    @staticmethod
    def promote(d):
        f = d["fields"]["price.tkt_basic"]
        f.update(status="confirmed", confirmed_by="대표", confirmed_at="2026-09-29",
                 price_check={"catalog_id": "tkt_basic", "notice_title": "어린이 기본이용권 (2시간)",
                              "notice_field": "sale"})
        f["source"]["revision"] = "test"

    def test_old_notice_blocks_promotion(self):
        bad = [r for r in fails(profile=profile_with(self.promote)) if r.key == "price.tkt_basic"]
        self.assertTrue(bad and "14000" in bad[0].message, bad)

    def test_corrected_notice_allows_promotion(self):
        html = sub(FHTML, "14,000원</strong>", "15,000원</strong>")
        ok = [r for r in run_checks(profile_with(self.promote), FJS, html) if r.key == "price.tkt_basic"]
        self.assertTrue(ok and ok[0].ok, ok)


# ── PRICE-20261102 대표 확정 요금 ─────────────────────────────────

OWNER_20261102 = {
    "price.tkt_basic": 18000,
    "price.tkt_allday": 24000,
    "price.group_basic": 14400,
    "price.group_allday": 19200,
    "price.tkt_guardian": 5000,
    "price.guardian_net_addon": 3000,
    "price.ride_coaster_single": 9000,
    "price.addon_coaster_extra": 9000,
    "discount.resident_rate": 0.2,
}


def _replace_in_item(js, cid, old, new):
    start = js.index(f"id: '{cid}'")
    end = js.index("}", start)
    item = js[start:end]
    assert old in item, (cid, old)
    return js[:start] + item.replace(old, new, 1) + js[end:]


def new_catalog(js=FJS):
    """fixture 카탈로그를 확정 요금으로 바꾼 사본 — 조조권은 deprecated 로 판매 차단."""
    for cid, old, new in (("tkt_basic", 15000, 18000), ("tkt_allday", 21000, 24000),
                          ("ride_coaster_single", 7000, 9000), ("addon_coaster_extra", 5000, 9000),
                          ("addon_net_challenge", 5000, 3000)):
        js = _replace_in_item(js, cid, f"list_price: {old}", f"list_price: {new}")
    return _replace_in_item(js, "tkt_morning", "discountable: true", "discountable: true, deprecated: true")


NEW_JS = new_catalog()
NEW_HTML = (FIX / "notice_contract_20261102_synthetic.html").read_text(encoding="utf-8")


def new_fails(js=NEW_JS, html=NEW_HTML, profile=None):
    return failed(run_checks(profile or load_profile(), js, html))


class Owner20261102Contract(unittest.TestCase):
    """계약 값이 대표 확정 요금(2026-11-02)과 같다."""

    def setUp(self):
        self.p = load_profile()

    def test_confirmed_values(self):
        for key, value in OWNER_20261102.items():
            with self.subTest(key=key):
                f = self.p.field(key)
                self.assertEqual((f.value, f.status), (value, "confirmed"))
                self.assertEqual(f.confirmed_at, "2026-11-02")
                self.assertEqual(self.p.customer_value(key), value)

    def test_group_prices_are_20pct_off_individual(self):
        self.assertEqual(round(18000 * 0.8), self.p.customer_value("price.group_basic"))
        self.assertEqual(round(24000 * 0.8), self.p.customer_value("price.group_allday"))
        for key in ("price.group_basic", "price.group_allday"):
            self.assertEqual(self.p.field(key).price_check["discount_rule"], "group20")

    def test_guardian_total_with_net(self):
        self.assertEqual(self.p.customer_value("price.tkt_guardian")
                         + self.p.customer_value("price.guardian_net_addon"), 8000)

    def test_coaster_single_and_extra(self):
        self.assertEqual(self.p.customer_value("price.ride_coaster_single"), 9000)
        self.assertEqual(self.p.customer_value("price.addon_coaster_extra"), 9000)

    def test_no_stacking_policy(self):
        f = self.p.field("policy.discount_stacking")
        self.assertEqual((f.value, f.status), ("none", "confirmed"))

    def test_morning_ticket_retired(self):
        f = self.p.field("price.tkt_morning")
        self.assertEqual(f.status, "retired")
        self.assertIsNone(self.p.customer_value("price.tkt_morning"))
        self.assertIsNone(self.p.internal_value("price.tkt_morning"))

    def test_guardian_drink_exception_removed(self):
        spec = self.p.field("price.tkt_guardian").price_check
        self.assertNotIn("notice_allowed_text", spec)


class NewContractConforming(unittest.TestCase):
    """확정 요금에 맞춘 카탈로그·고지는 전부 통과하고, 모든 확정 품목이 실제로 대조된다."""

    def test_all_pass(self):
        results = run_checks(load_profile(), NEW_JS, NEW_HTML)
        self.assertEqual(failed(results), [], [r.message for r in failed(results)])
        checked = {r.key for r in results}
        self.assertTrue(set(OWNER_20261102) | {"price.tkt_morning"} <= checked, checked)

    def test_old_fixture_fails_every_changed_item(self):
        bad = {r.key for r in new_fails(FJS, FHTML)}
        for key in ("price.tkt_basic", "price.tkt_allday", "price.group_basic", "price.group_allday",
                    "price.guardian_net_addon", "price.ride_coaster_single",
                    "price.addon_coaster_extra", "price.tkt_morning", "(미분류 가격)"):
            self.assertIn(key, bad)
        self.assertNotIn("price.tkt_guardian", bad)
        self.assertNotIn("discount.resident_rate", bad)


class NewContractMutations(unittest.TestCase):
    def assertFlags(self, needle, js=NEW_JS, html=NEW_HTML, key=None):
        bad = new_fails(js, html)
        msgs = [f"{r.key}: {r.message}" for r in bad]
        self.assertTrue(any(needle in m and (key is None or m.startswith(key)) for m in msgs), msgs)

    def test_catalog_basic_old_price(self):
        js = _replace_in_item(NEW_JS, "tkt_basic", "list_price: 18000", "list_price: 15000")
        bad = {r.key for r in new_fails(js=js)}
        self.assertTrue({"price.tkt_basic", "price.group_basic"} <= bad, bad)

    def test_catalog_allday_old_price(self):
        js = _replace_in_item(NEW_JS, "tkt_allday", "list_price: 24000", "list_price: 21000")
        bad = {r.key for r in new_fails(js=js)}
        self.assertTrue({"price.tkt_allday", "price.group_allday"} <= bad, bad)

    def test_catalog_coaster_old_prices(self):
        self.assertFlags("불일치", js=_replace_in_item(NEW_JS, "ride_coaster_single", "list_price: 9000",
                                                     "list_price: 7000"), key="price.ride_coaster_single")
        self.assertFlags("불일치", js=_replace_in_item(NEW_JS, "addon_coaster_extra", "list_price: 9000",
                                                     "list_price: 5000"), key="price.addon_coaster_extra")

    def test_catalog_net_old_price(self):
        self.assertFlags("불일치", js=_replace_in_item(NEW_JS, "addon_net_challenge", "list_price: 3000",
                                                     "list_price: 5000"), key="price.guardian_net_addon")

    def test_notice_group_basic_wrong(self):
        self.assertFlags("불일치", html=sub(NEW_HTML, "14,400원</strong>", "15,000원</strong>"),
                         key="price.group_basic")

    def test_notice_group_allday_list_wrong(self):
        self.assertFlags("정가", html=sub(NEW_HTML, "정가 24,000원", "정가 21,000원"), key="price.group_allday")

    def test_notice_missing_coaster_extra(self):
        html = sub(NEW_HTML, '<div class="card"><span>짚코스터 추가 탑승권</span><strong>9,000원</strong></div>', "")
        self.assertFlags("없음", html=html, key="price.addon_coaster_extra")

    def test_guardian_drink_text_no_longer_allowed(self):
        html = sub(NEW_HTML, "<p>음료는 포함되지 않습니다</p>", "<p>음료 포함 실질 0원</p>")
        self.assertFlags("다른 금액", html=html)

    def test_retired_morning_sellable_in_catalog(self):
        js = NEW_JS.replace("discountable: true, deprecated: true", "discountable: true", 1)
        self.assertFlags("판매 가능", js=js, key="price.tkt_morning")

    def test_retired_morning_card_in_notice(self):
        html = sub(NEW_HTML, '<div class="card"><span>짚코스터 단독',
                   '<div class="card"><span>조조 오전권</span><strong>18,000원</strong></div>'
                   '<div class="card"><span>짚코스터 단독')
        self.assertFlags("폐지 품목 표기", html=html, key="price.tkt_morning")
        self.assertFlags("계약에 없는 고지 품목", html=html)  # 폐지 출처 문구는 품목을 인정하지 않는다

    def test_retired_term_outside_pricing_section(self):
        html = NEW_HTML + '\n<section id="faq"><p>오전에는 조조 할인이 있어요</p></section>\n'
        self.assertFlags("폐지 품목 표기", html=html, key="price.tkt_morning")

    def test_retired_term_in_attribute(self):
        html = NEW_HTML + '\n<img src="x.png" alt="조조권 안내">\n'
        self.assertFlags("폐지 품목 표기", html=html, key="price.tkt_morning")

    def test_deprecated_must_be_boolean(self):
        js = NEW_JS.replace("deprecated: true", "deprecated: 'yes'", 1)
        bad = new_fails(js=js)
        self.assertTrue(bad and "추출 실패" in bad[0].message, bad)
        with self.assertRaises(ExtractError):
            catalog_deprecated(js)

    def test_unknown_retired_spec_key(self):
        def m(d):
            d["fields"]["price.tkt_morning"]["price_check"]["allow_notice"] = True
        bad = failed(run_checks(profile_with(m, base=CURRENT), NEW_JS, NEW_HTML))
        self.assertTrue(any(r.key == "price.tkt_morning" and "알 수 없는 항목" in r.message for r in bad), bad)

    def test_retired_needs_terms(self):
        def m(d):
            d["fields"]["price.tkt_morning"]["price_check"]["notice_terms"] = []
        bad = failed(run_checks(profile_with(m, base=CURRENT), NEW_JS, NEW_HTML))
        self.assertTrue(any(r.key == "price.tkt_morning" for r in bad), bad)

    def test_retired_requires_flag_in_profile(self):
        def m(d):
            d["fields"]["price.tkt_morning"]["price_check"].pop("retired")
        with self.assertRaises(ProfileError):
            profile_with(m, base=CURRENT)

    def test_retired_flag_only_for_retired_status(self):
        def m(d):
            d["fields"]["price.tkt_basic"]["price_check"]["retired"] = True
        with self.assertRaises(ProfileError):
            profile_with(m, base=CURRENT)

    def test_retired_needs_confirmer(self):
        def m(d):
            d["fields"]["price.tkt_morning"].pop("confirmed_by")
        with self.assertRaises(ProfileError):
            profile_with(m, base=CURRENT)


class NoAutoPromotion(unittest.TestCase):
    def test_unresolved_items_are_not_checked_or_promoted(self):
        before = DEFAULT_PATH.read_bytes()
        results = run_checks(profile_with(), FJS, FHTML)
        self.assertNotIn("price.tkt_basic", {r.key for r in results})
        current = run_checks(load_profile(), NEW_JS, NEW_HTML)
        for f in load_profile().with_status("unresolved"):
            self.assertNotIn(f.key, {r.key for r in current})
        self.assertEqual(DEFAULT_PATH.read_bytes(), before)

    def test_extract_error_is_exported(self):
        self.assertTrue(issubclass(ExtractError, Exception))


if __name__ == "__main__":
    unittest.main()

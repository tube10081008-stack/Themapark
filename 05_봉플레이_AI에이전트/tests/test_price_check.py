"""요금 대조 — 불일치·추출 실패는 모두 실패여야 한다 (BEN-004 결정 1)."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.price_check import (  # noqa: E402
    CATALOG_PATH, NOTICE_PATH, ExtractError, catalog_prices, discount_rates, notice_items, run_checks,
)
from core.profile import DEFAULT_PATH, load_profile  # noqa: E402

JS = CATALOG_PATH.read_text(encoding="utf-8")
HTML = NOTICE_PATH.read_text(encoding="utf-8")
BASE = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))


def profile_with(mutate):
    data = copy.deepcopy(BASE)
    mutate(data)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.json"
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return load_profile(p)


def failed(results):
    return [r for r in results if not r.ok]


class RealFiles(unittest.TestCase):
    def test_current_confirmed_prices_match(self):
        results = run_checks(load_profile(), JS, HTML)
        self.assertEqual(failed(results), [], [r.message for r in failed(results)])
        self.assertEqual({r.key for r in results},
                         {"price.tkt_guardian", "price.group_allday", "discount.resident_rate"})

    def test_extractors(self):
        self.assertEqual(catalog_prices(JS)["tkt_guardian"], 5000)
        self.assertEqual(discount_rates(JS)["group20"], 0.2)
        items = notice_items(HTML)
        self.assertEqual(items["단체 종합이용권 (20인 이상)"], {"sale": 16800, "list": 21000})


class Mismatch(unittest.TestCase):
    def test_profile_value_differs(self):
        p = profile_with(lambda d: d["fields"]["price.tkt_guardian"].update(value=6000))
        self.assertTrue(any(r.key == "price.tkt_guardian" for r in failed(run_checks(p, JS, HTML))))

    def test_catalog_changed(self):
        js = JS.replace("list_price: 5000,  customer: 'adult'", "list_price: 5500,  customer: 'adult'", 1)
        self.assertNotEqual(js, JS)
        self.assertTrue(failed(run_checks(load_profile(), js, HTML)))

    def test_notice_changed(self):
        html = HTML.replace("5,000원</strong>", "4,000원</strong>", 1)
        self.assertNotEqual(html, HTML)
        self.assertTrue(failed(run_checks(load_profile(), JS, html)))

    def test_group_list_price_differs(self):
        html = HTML.replace("정가 21,000원</div>", "정가 22,000원</div>", 1)
        self.assertNotEqual(html, HTML)
        self.assertTrue(failed(run_checks(load_profile(), JS, html)))

    def test_resident_rate_differs(self):
        html = HTML.replace("봉화군민 20% 우대", "봉화군민 10% 우대", 1)
        self.assertNotEqual(html, HTML)
        self.assertTrue(failed(run_checks(load_profile(), JS, html)))

    def test_unknown_spec_key(self):
        p = profile_with(lambda d: d["fields"]["price.tkt_guardian"]["price_check"].update(tolerance=500))
        self.assertTrue(failed(run_checks(p, JS, HTML)))


class ExtractionFailures(unittest.TestCase):
    def assertExtractFails(self, js=JS, html=HTML):
        results = run_checks(load_profile(), js, html)
        self.assertTrue(failed(results))
        self.assertIn("추출 실패", failed(results)[0].message)

    def test_catalog_missing(self):
        self.assertExtractFails(js=JS.replace("const PRODUCT_CATALOG", "const PRODUCT_LIST"))

    def test_catalog_declared_twice(self):
        self.assertExtractFails(js=JS + "\nconst PRODUCT_CATALOG = [ { id: 'x', list_price: 1 } ];\n")

    def test_duplicate_id(self):
        dup = "{ id: 'tkt_guardian', name: 'dup', list_price: 5000 },\n    // 1. 이용권"
        self.assertExtractFails(js=JS.replace("// 1. 이용권", dup, 1))

    def test_price_field_twice_in_object(self):
        self.assertExtractFails(js=JS.replace("list_price: 5000,  customer: 'adult'",
                                              "list_price: 5000, list_price: 6000, customer: 'adult'", 1))

    def test_price_not_numeric(self):
        self.assertExtractFails(js=JS.replace("list_price: 5000,  customer: 'adult'",
                                              "list_price: PRICE_GUARDIAN,  customer: 'adult'", 1))

    def test_section_missing(self):
        self.assertExtractFails(html=HTML.replace('id="sectionPricing"', 'id="pricing"'))

    def test_duplicate_notice_title(self):
        html = HTML.replace("<span>보호자 입장권</span>", "<span>단체 종합이용권 (20인 이상)</span>", 1)
        self.assertExtractFails(html=html)

    def test_price_format_changed(self):
        self.assertExtractFails(html=HTML.replace("5,000원</strong>", "5,000 KRW</strong>", 1))


class Coverage(unittest.TestCase):
    def test_new_notice_item_without_contract_fails(self):
        extra = ('<div class="py-2.5 flex"><div><div class="font-extrabold">새 권종</div></div>'
                 '<div><strong>9,000원</strong></div></div>')
        html = HTML.replace("<!-- Guardian ticket", extra + "<!-- Guardian ticket", 1)
        self.assertNotEqual(html, HTML)
        msgs = [r.message for r in failed(run_checks(load_profile(), JS, html))]
        self.assertTrue(any("새 권종" in m for m in msgs), msgs)

    def test_confirmed_item_removed_from_notice_fails(self):
        html = HTML.replace("<span>보호자 입장권</span>", "<span>보호자 이용권</span>", 1)
        self.assertTrue(failed(run_checks(load_profile(), JS, html)))


class NoAutoPromotion(unittest.TestCase):
    def test_unresolved_items_are_not_checked_or_promoted(self):
        before = DEFAULT_PATH.read_bytes()
        results = run_checks(load_profile(), JS, HTML)
        self.assertNotIn("price.tkt_basic", {r.key for r in results})
        self.assertEqual(DEFAULT_PATH.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

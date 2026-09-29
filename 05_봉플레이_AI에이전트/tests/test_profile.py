import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.profile import (  # noqa: E402
    DEFAULT_PATH, PENDING_TEXT, ProfileError, facility_description, lint_keys, load_profile,
)

BASE = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))


def load_variant(mutate):
    data = copy.deepcopy(BASE)
    mutate(data)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.json"
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return load_profile(p)


class RealProfile(unittest.TestCase):
    def setUp(self):
        self.p = load_profile()

    def test_keys_follow_naming(self):
        self.assertEqual(lint_keys(self.p), [])

    def test_owner_decisions(self):
        self.assertEqual(self.p.customer_value("address.road"), "경상북도 봉화군 봉화읍 유록길 22")
        for k in ("hours.open", "hours.close", "hours.last_entry"):
            self.assertIsNone(self.p.customer_value(k))
            self.assertIsNone(self.p.internal_value(k))
        self.assertEqual(self.p.customer_text("hours.open"), PENDING_TEXT)

    def test_system_default_not_for_customers(self):
        self.assertIsNone(self.p.customer_value("facility.name"))
        self.assertIsNone(self.p.customer_value("price.tkt_allday"))
        self.assertEqual(self.p.internal_value("price.tkt_allday"), (21000, "system_default"))

    def test_unresolved_not_used_anywhere(self):
        for f in self.p.with_status("unresolved"):
            with self.subTest(key=f.key):
                self.assertIsNone(self.p.customer_value(f.key))
                self.assertIsNone(self.p.internal_value(f.key))

    def test_areas_are_separate_fields(self):
        self.assertEqual(self.p.customer_value("area.play_space_m2"), 657.785)
        self.assertEqual(self.p.customer_value("area.building_gfa_m2"), 924)


class Description(unittest.TestCase):
    def test_from_confirmed_only(self):
        text = facility_description(load_profile())
        self.assertIn("유록길 22", text)
        self.assertIn("657.8㎡(약 199평)", text)
        self.assertIn("야외에는 짚코스터·네트챌린지가", text)
        self.assertIn(PENDING_TEXT, text)
        self.assertNotIn("봉플레이", text)          # facility.name 은 system_default
        self.assertNotIn("실내 짚라인", text)        # 원본의 오류 문구
        self.assertNotIn("924", text)               # 건물 연면적은 놀이공간 설명에 쓰지 않음
        self.assertNotRegex(text, r"\d+\s*m\b|높이|길이")  # 확인 안 된 규격 보충 금지

    def test_confirmed_name_used_with_particle(self):
        def m(d):
            f = d["fields"]["facility.name"]
            f.update(status="confirmed", confirmed_by="테스트", confirmed_at="2026-09-29")
            f["source"]["revision"] = "test"
        text = facility_description(load_variant(m))
        self.assertTrue(text.startswith("리틀포레스트 봉플레이는 "))

    def test_unconfirmed_outdoor_omitted(self):
        def m(d):
            d["fields"]["facility.outdoor_attractions"]["status"] = "unverified"
        self.assertNotIn("야외", facility_description(load_variant(m)))


class Validation(unittest.TestCase):
    def assertRejects(self, mutate, needle):
        with self.assertRaises(ProfileError) as cm:
            load_variant(mutate)
        self.assertIn(needle, str(cm.exception))

    def test_missing_file(self):
        with self.assertRaises(ProfileError):
            load_profile("/nonexistent/site_profile.json")

    def test_bad_json(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.json"
            p.write_text("{", encoding="utf-8")
            with self.assertRaises(ProfileError):
                load_profile(p)

    def test_schema_version(self):
        self.assertRejects(lambda d: d.update(schema_version=2), "schema_version")

    def test_empty_fields(self):
        self.assertRejects(lambda d: d.update(fields={}), "fields")

    def test_unknown_status(self):
        self.assertRejects(lambda d: d["fields"]["address.road"].update(status="approved"), "status")

    def test_unknown_key(self):
        self.assertRejects(lambda d: d["fields"]["address.road"].update(owner="x"), "알 수 없는 항목")

    def test_value_required(self):
        self.assertRejects(lambda d: d["fields"]["hours.open"].pop("value"), "value")

    def test_confirmed_needs_confirmer(self):
        self.assertRejects(lambda d: d["fields"]["address.road"].pop("confirmed_by"), "confirmed_by")

    def test_confirmed_needs_revision(self):
        self.assertRejects(lambda d: d["fields"]["address.road"]["source"].pop("revision"), "revision")

    def test_confirmed_bad_date(self):
        self.assertRejects(lambda d: d["fields"]["address.road"].update(confirmed_at="9/29"), "날짜")

    def test_confirmed_null_value(self):
        self.assertRejects(lambda d: d["fields"]["address.road"].update(value=None), "null")

    def test_confirmed_price_needs_check(self):
        self.assertRejects(lambda d: d["fields"]["price.tkt_guardian"].pop("price_check"), "price_check")

    def test_source_required(self):
        self.assertRejects(lambda d: d["fields"]["address.road"]["source"].update(path=""), "source")


if __name__ == "__main__":
    unittest.main()

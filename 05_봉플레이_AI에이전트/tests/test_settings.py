import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.settings import MODEL_ENV, MissingModelError, require_model  # noqa: E402


class RequireModel(unittest.TestCase):
    def test_unset_exits_with_explanation(self):
        env = {k: v for k, v in os.environ.items() if k != MODEL_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(MissingModelError) as cm:
                require_model()
        self.assertIn(MODEL_ENV, str(cm.exception.code))

    def test_blank_is_unset(self):
        with mock.patch.dict(os.environ, {MODEL_ENV: "   "}):
            with self.assertRaises(MissingModelError):
                require_model()

    def test_explicit_value_returned_as_is(self):
        with mock.patch.dict(os.environ, {MODEL_ENV: "some-model-id"}):
            self.assertEqual(require_model(), "some-model-id")

    def test_no_hardcoded_default_in_core(self):
        core = Path(__file__).resolve().parents[1] / "core"
        for py in core.glob("*.py"):
            with self.subTest(file=py.name):
                self.assertNotIn("claude-", py.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

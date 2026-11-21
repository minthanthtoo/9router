import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("check_upstream", Path(__file__).with_name("check_upstream.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


BASE = "a" * 40
TAG = "b" * 40
NPM_HEAD = "c" * 40
BASELINE = {"version": "0.5.116", "base": BASE, "npm_git_head": BASE}


class UpstreamMonitorTests(unittest.TestCase):
    def test_new_tag_and_npm_release_are_reported(self):
        report = module.inspect_refs(
            BASELINE,
            f"{BASE}\trefs/tags/v0.5.116\n{TAG}\trefs/tags/v0.5.119\n",
            {"version": "0.5.119", "gitHead": NPM_HEAD},
        )
        self.assertTrue(report["review_required"])
        self.assertEqual(report["latest_tag_version"], "0.5.119")
        self.assertEqual(report["latest_tag_sha"], TAG)
        self.assertEqual(report["npm_git_head"], NPM_HEAD)

    def test_matching_pins_are_quiet(self):
        report = module.inspect_refs(
            BASELINE,
            f"{BASE}\trefs/tags/v0.5.116\n",
            {"version": "0.5.116", "gitHead": BASE},
        )
        self.assertFalse(report["review_required"])
        self.assertEqual(report["reasons"], [])

    def test_same_tag_version_moved_is_reported(self):
        report = module.inspect_refs(
            BASELINE,
            f"{TAG}\trefs/tags/v0.5.116\n",
            {"version": "0.5.116", "gitHead": BASE},
        )
        self.assertTrue(report["review_required"])
        self.assertIn("pinned official tag", " ".join(report["reasons"]))

    def test_same_npm_version_with_new_githead_is_reported(self):
        report = module.inspect_refs(
            BASELINE,
            f"{BASE}\trefs/tags/v0.5.116\n",
            {"version": "0.5.116", "gitHead": NPM_HEAD},
        )
        self.assertTrue(report["review_required"])
        self.assertIn("gitHead", " ".join(report["reasons"]))

    def test_missing_pinned_tag_is_reported(self):
        report = module.inspect_refs(
            BASELINE,
            f"{TAG}\trefs/tags/v0.5.119\n",
            {"version": "0.5.119", "gitHead": NPM_HEAD},
        )
        self.assertTrue(report["review_required"])
        self.assertIn("missing", " ".join(report["reasons"]))

    def test_invalid_external_githead_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "valid gitHead"):
            module.inspect_refs(
                BASELINE,
                f"{BASE}\trefs/tags/v0.5.116\n",
                {"version": "0.5.116", "gitHead": "not-a-commit"},
            )


if __name__ == "__main__":
    unittest.main()

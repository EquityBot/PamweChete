"""Report comparisons use fabricated files and never read private Pi sessions."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/analyze-sessions/scripts"))
import cost


def runtime(code="f" * 64, version="0.87.1"):
    value = {"schemaVersion": 1, "packageName": "@earendil-works/pi-coding-agent", "version": version,
             "entryPoint": "dist/bundle/cli.js", "codeDigest": code, "fileCount": 3,
             "sourceRevision": None, "nodeVersion": "v22.19.0", "platform": "win32", "arch": "x64"}
    value["digest"] = hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()
    return value


def report():
    return {
        "schemaVersion": 3, "kind": "live", "runId": "synthetic", "modelId": "test/model", "runtime": runtime(), "runtimeVerified": True, "executionVerified": True, "cleanupVerified": True,
        "requestDigest": "a" * 64, "fixtureDigest": "b" * 64, "piVersion": "0.87.1",
        "resourcesDigest": "c" * 64, "harnessDigest": "d" * 64,
        "profileFiles": {"settings.json": "e" * 64}, "plan": {"contextWindow": 32768, "fixtures": ["test"], "repeats": 1, "maxRequests": 192, "reservationPerRequestUsd": 0.001},
        "maxEstimatedUsd": 1,
        "runs": [{"fixture": "test", "repetition": 1, "passed": True, "estimatedUsageUsd": 0.01,
                  "metrics": {"elapsedMs": 120, "toolErrors": 0, "repeatedCalls": 1, "retries": 0, "truncated": 0}}],
    }


class FeatherlessReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pamwechete-reports-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def save(self, value, name="report.json"):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_explicit_report_does_not_load_sessions(self):
        path = self.save(report())
        output = io.StringIO()
        with patch.object(cost.S, "load_summaries", side_effect=AssertionError("Private sessions accessed")), \
                patch.object(sys, "argv", ["cost.py", "--benchmark-report", str(path)]), \
                contextlib.redirect_stdout(output):
            self.assertEqual(cost.main(), 0)
        row = json.loads(output.getvalue())[0]
        self.assertEqual(row["passed"], 1)
        self.assertEqual(row["estimated_usage_usd"], 0.01)
        self.assertEqual(row["median_elapsed_ms"], 120)

    def test_unknown_cost_stays_unknown(self):
        value = report()
        value["runs"][0]["estimatedUsageUsd"] = None
        self.assertIsNone(cost.benchmark_reports([self.save(value)])[0]["estimated_usage_usd"])

    def test_exact_fixture_plan_is_required(self):
        for changes in ({"fixture": "unselected"}, {"repetition": 0}, {"repetition": 2}):
            value = report()
            value["runs"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])
        value = report()
        value["plan"]["repeats"] = 2
        with self.assertRaises(ValueError):
            cost.benchmark_reports([self.save(value)])
        value["runs"].append({**value["runs"][0], "repetition": 2})
        self.assertEqual(cost.benchmark_reports([self.save(value)])[0]["runs"], 2)

    def test_configuration_verification_is_required_and_legacy_reports_stay_separate(self):
        for verified in (False, None, 1, "true"):
            value = report()
            value["executionVerified"] = verified
            with self.subTest(verified=verified), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])
        first = report()
        first["schemaVersion"] = 2
        second = {**first, "runId": "second"}
        rows = cost.benchmark_reports([self.save(first), self.save(second, "second.json")])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["runtime_status"] == "configuration-unverified" for row in rows))

    def test_duplicates_and_invalid_metrics_are_rejected(self):
        path = self.save(report())
        with self.assertRaises(ValueError):
            cost.benchmark_reports([path, path])
        for invalid in [-1, float("inf"), float("nan"), True, "0.01", 10**500]:
            with self.subTest(invalid=invalid):
                value = report()
                value["runs"][0]["estimatedUsageUsd"] = invalid
                with self.assertRaises(ValueError):
                    cost.benchmark_reports([self.save(value)])
        value = report()
        value["runs"].append(value["runs"][0].copy())
        with self.assertRaises(ValueError):
            cost.benchmark_reports([self.save(value)])

    def test_cleanup_verification_is_required(self):
        for verified in (False, None, 1, "true"):
            value = report()
            value["cleanupVerified"] = verified
            with self.subTest(verified=verified), self.assertRaisesRegex(ValueError, "cleanup"):
                cost.benchmark_reports([self.save(value)])

    def test_request_spending_and_reservation_limits_remain_separate(self):
        first = self.save(report())
        for field, changed in (("maxRequests", 1), ("maxEstimatedUsd", 0.01),
                               ("reservationPerRequestUsd", 0.002)):
            second = report()
            second["runId"] = "limited"
            target = second if field == "maxEstimatedUsd" else second["plan"]
            target[field] = changed
            second["runs"][0].update(passed=False, skipped=True, estimatedUsageUsd=None)
            with self.subTest(field=field):
                rows = cost.benchmark_reports([first, self.save(second, "second.json")])
                self.assertEqual(len(rows), 2)
                self.assertEqual(sum(row["skipped"] for row in rows), 1)
                self.assertEqual(rows[0]["max_requests"], 192)
                self.assertEqual(rows[0]["max_estimated_usd"], 1)

    def test_invalid_budget_identity_is_rejected(self):
        for field, invalid in (("maxRequests", True), ("maxRequests", 0),
                               ("maxRequests", 10001), ("maxEstimatedUsd", 0),
                               ("maxEstimatedUsd", float("inf")),
                               ("reservationPerRequestUsd", -1)):
            value = report()
            target = value if field == "maxEstimatedUsd" else value["plan"]
            target[field] = invalid
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])

    def test_context_and_source_versions_remain_separate(self):
        first = self.save(report())
        for field in ["requestDigest", "fixtureDigest", "resourcesDigest", "harnessDigest", "piVersion", "context"]:
            with self.subTest(field=field):
                value = report()
                value["runId"] = "second"
                if field == "context":
                    value["plan"]["contextWindow"] = 16384
                else:
                    value[field] = "changed"
                if field == "piVersion":
                    value[field] = "0.87.2"
                    value["runtime"] = runtime(version="0.87.2")
                rows = cost.benchmark_reports([first, self.save(value, "second.json")])
                self.assertEqual(len(rows), 2)

    def test_matching_runtimes_merge_but_same_version_forks_do_not(self):
        first = self.save(report())
        second = report()
        second["runId"] = "second"
        self.assertEqual(len(cost.benchmark_reports([first, self.save(second, "second.json")])), 1)
        second["runtime"] = runtime(code="a" * 64)
        self.assertEqual(len(cost.benchmark_reports([first, self.save(second, "second.json")])), 2)

    def test_legacy_reports_remain_unverified_and_do_not_merge(self):
        first = report()
        first["schemaVersion"] = 1
        del first["runtime"]
        second = {**first, "runId": "second"}
        rows = cost.benchmark_reports([self.save(first), self.save(second, "second.json")])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["runtime_status"] == "legacy-unverified" for row in rows))

    def test_missing_or_changed_runtime_identity_is_rejected(self):
        for invalid in [None, {}, {**runtime(), "version": "0.87.2"}, {**runtime(), "fileCount": True},
                        {**runtime(), "platform": "linux"}, {**runtime(), "digest": "invalid"}]:
            value = report()
            value["runtime"] = invalid
            with self.subTest(runtime=invalid), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])

    def test_runtime_must_be_verified_after_the_run(self):
        for verified in [False, None, 1, "true"]:
            value = report()
            value["runtimeVerified"] = verified
            with self.subTest(verified=verified), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])

    def test_different_fixture_selections_do_not_merge(self):
        first = self.save(report())
        second = report()
        second["runId"] = "second"
        second["plan"]["fixtures"] = ["different"]
        second["runs"][0]["fixture"] = "different"
        self.assertEqual(len(cost.benchmark_reports([first, self.save(second, "second.json")])), 2)

    def test_empty_or_synthetic_reports_do_not_claim_live_results(self):
        for value in [[], {}, {**report(), "kind": "synthetic"}, {**report(), "runs": []}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                cost.benchmark_reports([self.save(value)])


if __name__ == "__main__":
    unittest.main()

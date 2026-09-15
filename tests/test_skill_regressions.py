"""Offline checks using fabricated inputs only."""
import argparse
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/analyze-sessions/scripts"))
import cost
import sessions
import show_session

spec = importlib.util.spec_from_file_location(
    "transcript", ROOT / "skills/youtube-transcript/fetch_transcript.py"
)
transcript = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transcript)


class SkillRegressionTests(unittest.TestCase):
    def test_pdf_output_uses_a_private_user_cache_directory(self):
        pdf_spec = importlib.util.spec_from_file_location("pdf_render", ROOT / "skills/pdf-reader/scripts/pdf_render.py")
        pdf_render = importlib.util.module_from_spec(pdf_spec)
        with patch.dict(sys.modules, {"pymupdf": SimpleNamespace()}):
            pdf_spec.loader.exec_module(pdf_render)
        with tempfile.TemporaryDirectory() as cache, patch.dict(os.environ, {"LOCALAPPDATA": cache, "XDG_CACHE_HOME": cache}):
            first = Path(pdf_render.private_output_directory())
            second = Path(pdf_render.private_output_directory())
            self.assertTrue(first.is_relative_to(cache))
            self.assertNotEqual(first, second)
            self.assertTrue(first.is_dir())
            if os.name != "nt":
                self.assertEqual(first.stat().st_mode & 0o077, 0)
            marker = first / "page_0001.png"
            marker.write_bytes(b"synthetic image placeholder")
            with patch.object(pdf_render, "MAX_RENDER_DIRECTORIES", 2, create=True):
                with self.assertRaisesRegex(ValueError, "cache is full"):
                    pdf_render.private_output_directory()
            self.assertEqual(marker.read_bytes(), b"synthetic image placeholder")

    @staticmethod
    def _fabricated_summary(day: str, session_id: str, amount: float):
        """One fabricated session. Local-aware so the day key is stable."""
        from datetime import datetime
        started = datetime.fromisoformat(day + "T12:00:00").astimezone()
        return SimpleNamespace(
            started_at=started, id=session_id, cwd="/fabricated/project",
            cost_total=amount, message_count=1, error_count=0,
            is_subagent=False, models=["fabricated-model"],
        )

    def test_group_limit_caps_groups_in_json_and_in_the_daily_table(self):
        # --limit is documented as a cap on groups. The JSON branch returned
        # every group, and the text branch skipped the cap for --by day.
        made = [self._fabricated_summary("2026-01-01", "older", 1.0),
                self._fabricated_summary("2026-01-02", "newer", 9.0)]

        self.assertEqual(list(cost.build_report(made, "session", 1)["groups"]), ["newer"])
        self.assertEqual(list(cost.build_report(made, "day", 1)["groups"]), ["2026-01-02"])

        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            cost.print_grouped(made, "day", show_subagents=False, limit=1)
        self.assertIn("2026-01-02", printed.getvalue())
        self.assertNotIn("2026-01-01", printed.getvalue())

    def test_undated_sessions_do_not_displace_the_most_recent_day(self):
        # "unknown" sorts after every ISO date, so it used to survive the
        # most-recent slice while the real latest day was dropped.
        undated = SimpleNamespace(
            started_at=None, id="undated", cwd="/fabricated/project",
            cost_total=5.0, message_count=1, error_count=0,
            is_subagent=False, models=["fabricated-model"],
        )
        made = [self._fabricated_summary("2026-01-01", "older", 1.0),
                self._fabricated_summary("2026-01-02", "newer", 9.0), undated]
        groups = list(cost.build_report(made, "day", 1)["groups"])
        self.assertEqual(groups, ["2026-01-02"])
        self.assertEqual(list(cost.build_report(made, "day")["groups"]),
                         ["unknown", "2026-01-01", "2026-01-02"])

    def test_group_limit_left_out_returns_every_group(self):
        made = [self._fabricated_summary("2026-01-01", "older", 1.0),
                self._fabricated_summary("2026-01-02", "newer", 9.0)]
        report = cost.build_report(made, "day")
        self.assertEqual(list(report["groups"]), ["2026-01-01", "2026-01-02"])
        self.assertEqual(report["total_cost"], 10.0)

    def test_undated_session_is_excluded_by_each_date_bound(self):
        session = SimpleNamespace(started_at=None)
        bound = sessions.parse_date("2026-01-01")
        for filters in (sessions.Filters(since=bound), sessions.Filters(until=bound)):
            self.assertFalse(filters.matches(session))

    def test_featherless_is_a_provider_choice(self):
        parser = argparse.ArgumentParser()
        sessions.add_filter_args(parser, subagents_default=False)
        self.assertEqual(parser.parse_args(["--provider", "featherless"]).provider, "featherless")

    def test_tool_output_cannot_close_its_fence(self):
        text = "before\n`````\nafter"
        result = io.StringIO()
        with contextlib.redirect_stdout(result):
            show_session._render_tool_result({"content": [{"type": "text", "text": text}]}, "", 0)
        self.assertIn("``````\n" + text + "\n``````", result.getvalue())

    def test_bad_urls_never_reach_yt_dlp(self):
        for url in ("--exec=bad", "file:///tmp/video", "http://youtube.com/v", "https://youtube.com.evil.example/v", "https://example.com/v"):
            with self.subTest(url=url), patch.object(sys, "argv", ["fetch_transcript.py", url]), patch.object(transcript, "get_metadata") as metadata:
                with self.assertRaises(SystemExit):
                    transcript.main()
                metadata.assert_not_called()

    def test_both_commands_end_with_option_separator_and_url(self):
        url = "https://www.youtube.com/watch?v=fabricated"
        with patch.object(transcript.subprocess, "run", return_value=SimpleNamespace(stdout="{}")) as run:
            transcript.get_metadata(url)
            self.assertEqual(run.call_args.args[0][-2:], ["--", url])
            with patch.object(transcript.glob, "glob", return_value=["fabricated.json3"]):
                transcript.download_subtitle(url, "en", False, "fabricated")
            self.assertEqual(run.call_args.args[0][-2:], ["--", url])


    # ------------------------------------------------------------------
    # CodeRabbit whole-repo scan, 16 September 2026
    # ------------------------------------------------------------------

    def test_a_date_only_until_covers_the_whole_day(self):
        # --until 2026-01-01 parsed to midnight, so everything after midnight on the
        # requested day was excluded and the cost and transcript results came back short.
        from datetime import datetime, timezone
        parser = argparse.ArgumentParser()
        sessions.add_filter_args(parser, subagents_default=False)
        args = parser.parse_args(["--until", "2026-01-01"])
        filters = sessions.filters_from_args(args, subagents_default=False)
        midday = SimpleNamespace(
            started_at=datetime(2026, 1, 1, 23, 59, tzinfo=timezone.utc))
        self.assertTrue(filters.matches(midday))
        next_day = SimpleNamespace(
            started_at=datetime(2026, 1, 2, 0, 0, tzinfo=timezone.utc))
        self.assertFalse(filters.matches(next_day))

    def test_an_explicit_until_time_is_left_alone(self):
        from datetime import datetime, timezone
        parser = argparse.ArgumentParser()
        sessions.add_filter_args(parser, subagents_default=False)
        args = parser.parse_args(["--until", "2026-01-01T09:00:00"])
        filters = sessions.filters_from_args(args, subagents_default=False)
        self.assertFalse(filters.matches(SimpleNamespace(
            started_at=datetime(2026, 1, 1, 9, 30, tzinfo=timezone.utc))))

    def test_an_ambiguous_session_prefix_is_refused(self):
        # A prefix matching two sessions rendered the newest without saying so, which
        # showed a different transcript from the one the caller named.
        matches = [SimpleNamespace(id="019eaaaa-newer"), SimpleNamespace(id="019eaaaa-older")]
        with patch.object(show_session.S, "load_summaries", return_value=matches), \
                patch.object(sys, "argv", ["show_session.py", "--session", "019eaaaa"]), \
                patch.object(show_session, "_render") as render:
            errors = io.StringIO()
            with contextlib.redirect_stderr(errors):
                self.assertEqual(show_session.main(), 1)
            render.assert_not_called()
            self.assertIn("Ambiguous", errors.getvalue())
            self.assertIn("019eaaaa-newer", errors.getvalue())

    def test_an_exact_session_id_wins_over_a_longer_sibling(self):
        exact = SimpleNamespace(id="019eaaaa")
        matches = [SimpleNamespace(id="019eaaaa-longer"), exact]
        with patch.object(show_session.S, "load_summaries", return_value=matches), \
                patch.object(sys, "argv", ["show_session.py", "--session", "019eaaaa"]), \
                patch.object(show_session, "_render") as render:
            self.assertEqual(show_session.main(), 0)
            self.assertIs(render.call_args.args[0], exact)

    def test_model_rollup_credits_each_message_once(self):
        # Every model key used to receive the session's whole message and error count,
        # so a two-model session reported double the messages it had.
        records = [
            {"type": "message", "message": {"role": "user"}},
            {"type": "message", "message": {"role": "assistant", "model": "model-a",
                                            "usage": {"cost": {"total": 1.0}}}},
            {"type": "message", "message": {"role": "toolResult", "isError": True}},
            {"type": "message", "message": {"role": "assistant", "model": "model-b",
                                            "usage": {"cost": {"total": 2.0}}}},
            {"type": "message", "message": {"role": "user"}},
            {"type": "message", "message": {"role": "assistant", "model": "model-b",
                                            "usage": {"cost": {"total": 3.0}}}},
        ]
        session = SimpleNamespace(
            path="fabricated.jsonl", id="fabricated", cwd="/fabricated/project",
            started_at=None, cost_total=6.0, message_count=6, error_count=1,
            is_subagent=False, models={"model-a", "model-b"})
        with patch.object(sessions, "iter_records", return_value=iter(records)):
            rows = dict((k, (c, m, e)) for k, c, m, e in cost.session_keys(session, "model"))
        self.assertEqual(rows["model-a"], (1.0, 3, 1))
        self.assertEqual(rows["model-b"], (5.0, 3, 0))

        with patch.object(sessions, "iter_records", return_value=iter(records)):
            groups = cost.build_report([session], "model")["groups"]
        self.assertEqual(sum(g["messages"] for g in groups.values()), 6)
        self.assertEqual(sum(g["errors"] for g in groups.values()), 1)

    def test_truncation_reports_the_characters_actually_dropped(self):
        # The marker counted from max_chars, not from the text it kept, so it
        # understated the cut by the length of the marker itself.
        text = "x" * 500
        out = show_session._truncate_with_count(text, 120)
        self.assertLessEqual(len(out), 120)
        dropped = int(re.search(r"\[(\d+) more chars elided\]", out).group(1))
        self.assertEqual(len(text) - dropped, len(out.split("\n")[0]))

    def test_render_bounds_its_dpi(self):
        pdf_spec = importlib.util.spec_from_file_location(
            "pdf_render_dpi", ROOT / "skills/pdf-reader/scripts/pdf_render.py")
        pdf_render = importlib.util.module_from_spec(pdf_spec)
        with patch.dict(sys.modules, {"pymupdf": SimpleNamespace()}):
            pdf_spec.loader.exec_module(pdf_render)
        for dpi in (0, -1, 100_000):
            with self.subTest(dpi=dpi), self.assertRaisesRegex(ValueError, "DPI must be"):
                pdf_render.render("fabricated.pdf", "all", dpi)

    def test_search_refuses_negative_context(self):
        search_spec = importlib.util.spec_from_file_location(
            "pdf_search", ROOT / "skills/pdf-reader/scripts/pdf_search.py")
        pdf_search = importlib.util.module_from_spec(search_spec)
        with patch.dict(sys.modules, {"pymupdf": SimpleNamespace()}):
            search_spec.loader.exec_module(pdf_search)
        with self.assertRaisesRegex(ValueError, "zero or more"):
            pdf_search.search("fabricated.pdf", "query", -1)

    def test_greek_prose_is_not_read_as_maths(self):
        info_spec = importlib.util.spec_from_file_location(
            "pdf_info", ROOT / "skills/pdf-reader/scripts/pdf_info.py")
        pdf_info = importlib.util.module_from_spec(info_spec)
        with patch.dict(sys.modules, {"pymupdf": SimpleNamespace()}):
            info_spec.loader.exec_module(pdf_info)
        greek_prose = "αβγδε"
        self.assertFalse(any(pdf_info._is_maths_char(c) for c in greek_prose))
        self.assertTrue(all(pdf_info._is_greek_char(c) for c in greek_prose))
        # A Greek letter beside a real operator still counts.
        self.assertTrue(pdf_info._is_maths_char("∑"))

    def test_yt_dlp_calls_carry_a_timeout(self):
        url = "https://www.youtube.com/watch?v=fabricated"
        with patch.object(transcript.subprocess, "run",
                          return_value=SimpleNamespace(stdout="{}")) as run:
            transcript.get_metadata(url)
            self.assertEqual(run.call_args.kwargs["timeout"],
                             transcript.YT_DLP_TIMEOUT_SECONDS)
            with patch.object(transcript.glob, "glob", return_value=["fabricated.json3"]):
                transcript.download_subtitle(url, "en", False, "fabricated")
            self.assertEqual(run.call_args.kwargs["timeout"],
                             transcript.YT_DLP_TIMEOUT_SECONDS)

    def test_a_yt_dlp_timeout_exits_non_zero(self):
        url = "https://www.youtube.com/watch?v=fabricated"
        timed_out = transcript.subprocess.TimeoutExpired(cmd="yt-dlp", timeout=1)
        with patch.object(transcript.subprocess, "run", side_effect=timed_out):
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    transcript.get_metadata(url)
            self.assertEqual(raised.exception.code, 1)



if __name__ == "__main__":
    unittest.main()

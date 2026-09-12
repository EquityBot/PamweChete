"""Offline checks using fabricated inputs only."""
import argparse
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills/analyze-sessions/scripts"))
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


if __name__ == "__main__":
    unittest.main()

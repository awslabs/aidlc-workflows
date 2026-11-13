"""Tests for the PTY terminal driver's pure logic.

These exercise the screen rendering (pyte) and gate detection without spawning a
real CLI — the live PTY drive is covered manually (needs the claude binary +
Bedrock). We drive a trivial real subprocess (`printf`/`cat`) to validate the
PTY plumbing on POSIX, and feed synthetic ANSI to validate menu detection.
"""

from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="PTY driver is POSIX-only (pexpect)"
)

from cli_harness.adapters._pty_terminal import PtyTerminal  # noqa: E402


def _feed(term: PtyTerminal, text: str) -> None:
    """Feed raw bytes straight into the pyte screen (bypassing the PTY)."""
    term._stream.feed(text.encode("utf-8"))


class TestScreenRendering:
    def test_plain_text_renders(self):
        term = PtyTerminal(["true"], cwd=".", cols=40, rows=5)
        _feed(term, "Hello world")
        assert "Hello world" in term.screen_text()

    def test_ansi_color_stripped_in_text(self):
        term = PtyTerminal(["true"], cwd=".", cols=40, rows=5)
        _feed(term, "\x1b[31mRED\x1b[0m text")
        text = term.screen_text()
        assert "RED text" in text
        assert "\x1b" not in text  # escape codes consumed by the emulator


class TestMenuDetection:
    def test_detects_select_menu(self):
        term = PtyTerminal(["true"], cwd=".", cols=80, rows=10)
        _feed(
            term,
            "Which scope?\r\n❯ 1. mvp\r\n  2. poc\r\n\r\nEnter to select\r\n",
        )
        assert term.screen_has_menu() is True

    def test_detects_submit_strip(self):
        # A real Submit screen carets a NUMBERED option; a bare unnumbered
        # caret must NOT count as a menu (that false-positive was the
        # streamed-noise stuck-gate bug).
        term = PtyTerminal(["true"], cwd=".", cols=80, rows=10)
        _feed(term, "❯ 1. Submit answers\r\n  2. Go back\r\n\r\nEnter to select\r\n")
        assert term.screen_has_menu() is True
        assert term.is_mechanical_gate() is True

    def test_no_menu_on_unnumbered_caret(self):
        term = PtyTerminal(["true"], cwd=".", cols=80, rows=10)
        _feed(term, "> select options\r\nSubmit answers\r\n")
        assert term.screen_has_menu() is False

    def test_no_menu_on_plain_output(self):
        term = PtyTerminal(["true"], cwd=".", cols=80, rows=10)
        _feed(term, "Running stage code-generation...\r\nWriting files\r\n")
        assert term.screen_has_menu() is False


class TestWaitFor:
    def test_wait_matches_streamed_output(self):
        # `printf` writes then exits — exercises the real PTY read path.
        term = PtyTerminal(["printf", r"[AIDLC] IDEATION ready\n"], cwd=".", cols=80, rows=10)
        term.start()
        try:
            assert term.wait_for(r"\[AIDLC\] IDEATION", timeout=10, stable_ms=0) is True
        finally:
            term.close()

    def test_wait_times_out_on_absent_pattern(self):
        term = PtyTerminal(["printf", r"nothing useful\n"], cwd=".", cols=80, rows=10)
        term.start()
        try:
            assert term.wait_for(r"this-never-appears", timeout=2, stable_ms=0) is False
        finally:
            term.close()


class TestKeyEncoding:
    def test_unknown_key_raises(self):
        term = PtyTerminal(["true"], cwd=".", cols=40, rows=5)
        term.start()
        try:
            with pytest.raises(ValueError, match="unknown key"):
                term.send_key("Meta-x")
        finally:
            term.close()

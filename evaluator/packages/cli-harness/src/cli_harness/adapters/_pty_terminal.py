"""PTY-backed terminal driver for driving a real interactive CLI like a customer.

This is the Python-native analogue of the framework's ``tests/harness/tui-drive.ts``
(node-pty + @xterm/headless + tmux). It uses:

- **pexpect** to spawn the CLI in a real pseudo-terminal (the customer-grade
  transport — no SDK embedding, no tmux), and
- **pyte** as a headless terminal emulator that reconstructs the *visible screen
  grid* from the raw ANSI byte stream, so we can wait on and assert against what
  the user would actually see.

Design rules ported from tui-drive.ts:

- **Detection is screen-based; termination is on-disk.** Use the rendered grid to
  decide *when* to act (a prompt/menu appeared), but decide a workflow is *done*
  from a real artifact / state-file signal — never from a screen string, which
  can race the spinner/statusline.
- **Stability window** for static prompts: a pattern match is only honored once
  the grid has been byte-stable for ``stable_ms`` (use 0 while output streams).
- **Timeouts are loud hang-backstops**, not success conditions.

POSIX only (pexpect/pty). The caller is responsible for prerequisite checks.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable

import pexpect
import pyte

# AskUserQuestion menu detection — mirrors gridHasMenu() in v2's
# tests/harness/tui-drive.ts (the authoritative driver for this widget):
#   caret (❯ or ASCII >) on a NUMBERED option, AND an "Enter to select" or
#   "Submit answers" footer. The caret-before-number is what distinguishes a
#   menu from the plain input prompt (also ">"). We tolerate v2's occasional
#   space-collapsed repaint (\s* not tui-drive's \s+; footer with optional
#   inter-word spaces).
_MENU_CARET_RE = re.compile(r"^\s*(?:❯|>)\s*\d+\.", re.MULTILINE)
_SELECT_FOOTER_RE = re.compile(r"E\s?n\s?t\s?e\s?r\s?to\s?select|Submit\s?answers", re.IGNORECASE)
# Multi-select: a checkbox marker on an option line (tmux paints ✔, claude -p
# paints x). Enter TOGGLES on multi-select, so it must be answered with Space
# then Right/Enter — never Enter-first (the select+deselect spin trap).
_MULTISELECT_RE = re.compile(r"\d+\.\s*\[[ xX✔]\]")
# Multi-tab form: the tab-strip navigation arrows.
_MULTITAB = ("←", "→")
# The final "Submit answers" confirmation screen.
_SUBMIT_RE = re.compile(r"Submit\s?answers", re.IGNORECASE)

# An empty input caret (prompt waiting for free-text) — v1.5/v1 approval gates
# print prose ("reply with 'yes'") and then wait at a bare caret, with no menu.
# MULTILINE so a caret line ANYWHERE on the screen matches (it sits above the
# persistent footer, not at end-of-string).
_EMPTY_PROMPT_RE = re.compile(r"^\s*[❯>]\s*$", re.MULTILINE)
# Spinner/working indicators Claude paints while inferring — if present, not
# idle. NB: exclude the persistent "⏵⏵ bypass permissions" footer (always on
# screen) and the box-drawing carets; match only genuine activity signals:
# the animated braille/star spinner glyphs, the "esc to interrupt" hint that
# only shows mid-turn, and the "(Xs · ↓N tokens)" working timer.
_WORKING_RE = re.compile(
    r"[✶✳✢✻✽✺⣾⣽⣻⢿⡿⣟⣯⣷]"
    r"|esc to interrupt"
    r"|Crunch|Scurry|running stop hook"
    r"|\(\d+m?\s*\d*s\s*·",  # working timer: "(46s ·" or "(1m 4s ·"
    re.IGNORECASE,
)


class PtyTerminal:
    """Drive an interactive CLI in a PTY and read its rendered screen.

    Usage::

        term = PtyTerminal(["claude", "--dangerously-skip-permissions"],
                           cwd=workspace, env=env, cols=120, rows=45)
        term.start()
        term.wait_for(r"\\[AIDLC\\] IDEATION", timeout=45)
        term.send_line("/aidlc Build a todo app --scope mvp --test-run")
        ...
        term.close()
    """

    def __init__(
        self,
        cmd: list[str],
        cwd: str,
        env: dict | None = None,
        cols: int = 200,
        rows: int = 200,
        logfile=None,
    ) -> None:
        self.cmd = cmd
        self.cwd = cwd
        self.env = env
        self.cols = cols
        self.rows = rows
        self._logfile = logfile
        self._child: pexpect.spawn | None = None
        self._screen = pyte.Screen(cols, rows)
        self._stream = pyte.ByteStream(self._screen)
        self._raw_log: list[bytes] = []

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        """Spawn the command in a PTY at the configured grid size."""
        self._child = pexpect.spawn(
            self.cmd[0],
            self.cmd[1:],
            cwd=self.cwd,
            env=self.env,
            dimensions=(self.rows, self.cols),
            encoding=None,  # bytes — feed raw to pyte
            timeout=None,
        )

    def close(self) -> None:
        """Terminate the child process if still alive."""
        if self._child is not None and self._child.isalive():
            try:
                self._child.sendcontrol("c")
                self._child.terminate(force=True)
            except Exception:
                pass

    @property
    def alive(self) -> bool:
        return self._child is not None and self._child.isalive()

    # -- I/O --------------------------------------------------------------

    def _drain(self, timeout: float = 0.3) -> None:
        """Pump available PTY output into the pyte screen for up to *timeout*s."""
        if self._child is None:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                chunk = self._child.read_nonblocking(size=4096, timeout=0.1)
            except pexpect.TIMEOUT:
                break
            except (pexpect.EOF, OSError):
                break
            if not chunk:
                break
            self._raw_log.append(chunk)
            if self._logfile is not None:
                try:
                    self._logfile.write(chunk.decode("utf-8", errors="replace"))
                    self._logfile.flush()
                except Exception:
                    pass
            self._stream.feed(chunk)

    def screen_text(self) -> str:
        """Return the current visible screen as plain text (trailing blanks trimmed)."""
        lines = [line.rstrip() for line in self._screen.display]
        return "\n".join(lines)

    def _settle(self, seconds: float) -> None:
        """Sleep *seconds* while DRAINING the PTY so the screen stays current.

        A bare time.sleep after a keystroke leaves the pyte grid stale — the
        widget's repaint arrives on the PTY but is never read, so the next
        screen_has_menu() sees the OLD menu and re-fires the key. (That was the
        99-Enter scope-gate loop: every Enter may have registered, but pyte
        never saw the advance.) Draining through the settle pumps the post-key
        repaint into pyte before the caller re-inspects the screen.
        """
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._drain(timeout=0.1)

    def send_line(self, text: str, enter: bool = True) -> None:
        """Type *text* into the PTY, optionally followed by Enter.

        Sent as a literal string (the equivalent of tmux ``send-keys -l``), so
        slash commands and freeform prompts are typed verbatim.
        """
        if self._child is None:
            raise RuntimeError("terminal not started")
        self._child.send(text.encode("utf-8"))
        if enter:
            # Enter sent separately, matching tui-drive's two-step send: some
            # TUIs swallow a trailing newline appended to the same write.
            time.sleep(0.1)
            self._child.send(b"\r")

    def send_key(self, key: str) -> None:
        """Send a single named key. Supports Enter, Up, Down, Left, Right, Space, Tab, C-c."""
        if self._child is None:
            raise RuntimeError("terminal not started")
        mapping = {
            "Enter": b"\r",
            "Up": b"\x1b[A",
            "Down": b"\x1b[B",
            "Right": b"\x1b[C",
            "Left": b"\x1b[D",
            "Space": b" ",
            "Tab": b"\t",
            "C-c": b"\x03",
        }
        seq = mapping.get(key)
        if seq is None:
            raise ValueError(f"unknown key: {key}")
        self._child.send(seq)

    # -- waiting ----------------------------------------------------------

    def wait_for(
        self,
        pattern: str,
        timeout: float = 60.0,
        stable_ms: float = 0.0,
        poll: float = 0.4,
    ) -> bool:
        """Poll the rendered screen until *pattern* (regex) appears.

        When *stable_ms* > 0 the pattern must be present AND the screen must have
        been byte-unchanged for that long (use for static menus). With 0, match
        as soon as the pattern appears (use while output is streaming). Returns
        True on match, False on timeout.
        """
        regex = re.compile(pattern, re.IGNORECASE | re.MULTILINE)
        deadline = time.monotonic() + timeout
        last_sig: str | None = None
        stable_since = 0.0
        while time.monotonic() < deadline:
            self._drain(timeout=poll)
            screen = self.screen_text()
            sig = screen
            now = time.monotonic()
            if sig != last_sig:
                last_sig = sig
                stable_since = now
            stable = stable_ms <= 0 or (stable_since and (now - stable_since) * 1000 >= stable_ms)
            if regex.search(screen) and stable:
                return True
        return False

    # -- gate handling ----------------------------------------------------

    def screen_has_menu(self) -> bool:
        """True if the screen shows an interactive selection menu (a caret + footer)."""
        screen = self.screen_text()
        return bool(_MENU_CARET_RE.search(screen) and _SELECT_FOOTER_RE.search(screen))

    def _menu_fingerprint(self) -> str:
        """Order-insensitive signature of the current menu's option labels.

        Used to tell whether the menu on screen is the SAME one we just answered
        (still lingering) or a genuinely new gate.
        """
        return "|".join(sorted(label for _n, label, _h in self.menu_options()))

    def _wait_menu_cleared(self, before_fingerprint: str, timeout: float = 8.0) -> None:
        """Drain until the just-answered menu (``before_fingerprint``) is gone.

        After answering, the menu can linger on the grid for a beat before the
        model consumes the key and repaints. Waiting here — rather than
        re-inspecting immediately — stops the same gate being answered twice
        (the scope-gate re-fire). Returns as soon as the menu clears or changes
        to a different one, or on *timeout* (a backstop, not a failure).
        """
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self._drain(timeout=0.2)
            if not self.screen_has_menu() or self._menu_fingerprint() != before_fingerprint:
                return

    def is_mechanical_gate(self) -> bool:
        """True if the menu is a Submit-answers screen or a multi-select tab.

        These are answered by fixed keystrokes (no human content): Submit → Enter,
        multi-select → Space then Right/Enter. Distinguished from single-select
        question/approval gates, which need semantic handling by the caller.
        """
        screen = self.screen_text()
        return bool(_SUBMIT_RE.search(screen) or _MULTISELECT_RE.search(screen))

    def menu_has_option(self, pattern: str) -> bool:
        """True if any parsed menu option label matches *pattern* (case-insensitive)."""
        return any(
            re.search(pattern, label, re.IGNORECASE) for _n, label, _h in self.menu_options()
        )

    def answer_gate(self) -> str:
        """Answer a MECHANICAL AskUserQuestion gate (submit / multi-select), or
        accept the highlighted Recommended option on a single-select.

        Dispatch mirrors v2's tui-drive.ts answer-gate:
          * Submit-answers confirmation screen → Enter (commit the form)
          * multi-select tab (checkbox options) → Space to toggle Recommended,
            then Right (multi-tab) or Enter (lone) — never Enter first, because
            Enter also toggles and Space+Enter nets to zero (spin trap)
          * otherwise (single-select) → Enter (accept highlighted Recommended)

        NOTE: a bare Enter on a single-select accepts whatever is highlighted.
        That is correct ONLY when the Recommended option is the desired one (an
        approval gate). On a question/proceed gate whose option 1 is "Guide me"
        (an interactive-walkthrough trap), the caller must NOT use this — it must
        route to the "Type something" free-text option instead (see
        select_menu_freetext + _on_gate_impl). Returns the action for logging;
        follows every keystroke with a 500ms settle.
        """
        screen = self.screen_text()
        action: str
        if _SUBMIT_RE.search(screen):
            self.send_key("Enter")
            action = "submit"
        elif _MULTISELECT_RE.search(screen):
            self.send_key("Space")
            self._settle(0.15)
            if all(g in screen for g in _MULTITAB):
                self.send_key("Right")
                action = "multiselect_toggle+right"
            else:
                self.send_key("Enter")
                action = "multiselect_toggle+enter"
        else:
            self.send_key("Enter")
            action = "single_select_default"
        # Draining settle: pump the widget's post-keystroke repaint into pyte so
        # the next screen_has_menu() sees the ADVANCE, not the stale menu.
        self._settle(0.6)
        return action

    # Back-compat alias — older callers used answer_gate_default().
    def answer_gate_default(self) -> None:
        self.answer_gate()

    def is_working(self) -> bool:
        """True if the screen shows an active spinner / 'esc to interrupt' — the
        model is mid-inference, not waiting for input."""
        return bool(_WORKING_RE.search(self.screen_text()))

    def prompt_is_waiting(self, stable_ms: int = 2500) -> bool:
        """True if the CLI is quiescent at a free-text input caret.

        Distinguishes a genuine "waiting for the human to type" state (v1.5/v1
        prose approval gates, which show no selectable menu) from active work.
        Requires the screen to be byte-stable for *stable_ms*, show an empty
        input caret, and NOT be showing a spinner or a selection menu.
        """
        if self.screen_has_menu():
            return False
        # Byte-stability is the authoritative "idle" signal: if the CLI is
        # actively working it keeps emitting output (spinner frames, tokens),
        # so no new chunks for stable_ms means it has genuinely stopped and is
        # waiting for input. (Glyph-based spinner detection is unreliable here
        # because stale spinner text lingers on the rendered screen after a
        # turn ends.) We still require an empty input caret to be showing.
        end = time.monotonic() + stable_ms / 1000.0
        last = len(self._raw_log)
        while time.monotonic() < end:
            self._drain(timeout=0.15)
            if len(self._raw_log) != last:
                return False  # still emitting → not idle
            time.sleep(0.05)
        return bool(_EMPTY_PROMPT_RE.search(self.screen_text()))

    def type_response(self, text: str) -> None:
        """Type a free-text response into the input and submit it.

        Two-step (line without Enter, settle, then Enter) — TUIs drop a trailing
        newline typed in the same burst; mirrors the /aidlc kickoff typing.
        """
        self.send_line(text, enter=False)
        self._settle(0.6)
        self.send_key("Enter")

    def menu_options(self) -> list[tuple[int, str, bool]]:
        """Parse a numbered selection menu into (number, label, is_highlighted).

        AskUserQuestion renders options like ``1. Guide me`` / ``5. Type
        something``, with a ``❯`` caret on the highlighted row and numbers that
        run CONSECUTIVELY from 1. We keep only the maximal 1,2,3,… run so that
        stray numbered lines in streamed code/diffs ("9 +## …", "6  orchestrate")
        don't get mistaken for options and pollute the menu fingerprint (the
        cause of a false stuck-gate during heavy code streaming). Tolerates
        space-collapsed repaints ("❯1.Approve").
        """
        raw: list[tuple[int, str, bool]] = []
        for line in self.screen_text().splitlines():
            m = re.match(r"\s*([❯>]?)\s*(\d+)[.)]\s*(\S.*)", line)
            if m:
                raw.append((int(m.group(2)), m.group(3).strip(), bool(m.group(1))))
        # Keep the first consecutive-from-1 run (1, 2, 3, …). Real AUQ menus
        # always number this way; code/diff noise does not.
        opts: list[tuple[int, str, bool]] = []
        expected = 1
        for num, label, hl in raw:
            if num == expected:
                opts.append((num, label, hl))
                expected += 1
            elif num == 1 and not opts:
                # a later "1." (menu painted below noise) — restart the run
                opts = [(num, label, hl)]
                expected = 2
        return opts

    def select_menu_option(self, pattern: str) -> bool:
        """Navigate to and select the first menu option whose label matches
        *pattern* (case-insensitive). Returns False if no option matches.

        Used to pick "Approve" on an approval gate (vs opening a free-text
        field on a question gate).
        """
        opts = self.menu_options()
        if not opts:
            return False
        target = next(
            (i for i, (_n, label, _h) in enumerate(opts)
             if re.search(pattern, label, re.IGNORECASE)),
            None,
        )
        if target is None:
            return False
        self._navigate_and_select(target)
        return True

    def _navigate_and_select(self, target_idx: int) -> None:
        """Move the caret to option index *target_idx* (0-based) and Enter.

        Mirrors tui-drive.ts's chooseNumberedMenuOption: the caret starts on the
        first option when the menu paints, so send *target_idx* Down presses
        (120ms apart, matching tui-drive), then a discrete Enter. Deliberately
        does NOT parse the current caret position — the highlighted-row glyph is
        unreliable on v2's space-collapsed repaints, and assuming option 1 is
        what the reference driver does.
        """
        for _ in range(max(0, target_idx)):
            self.send_key("Down")
            self._settle(0.12)   # drain each caret-move repaint
        self.send_key("Enter")
        self._settle(0.6)  # drain the post-selection advance into pyte

    def select_menu_freetext(self) -> bool:
        """Navigate a selection menu to its free-text option and open it.

        For gates whose options include a "Type something" free-text entry (v2
        AskUserQuestion, v1.5 gate widget): move the caret from the highlighted
        option to the free-text one and Enter to open its text field. Returns
        False if no free-text option is found (caller falls back to default).
        The caller then types the answer content via type_response().
        """
        opts = self.menu_options()
        if not opts:
            return False
        # Prefer a genuine free-TEXT-entry option ("Type something"); "Chat
        # about this"/"Other" is a weaker fallback; a bare "Chat" is freeform
        # discussion (avoid) and "Guide me" is an interactive walkthrough (avoid).
        free_idx = next(
            (i for i, (_n, label, _h) in enumerate(opts)
             if re.search(r"type\s*something|type\b", label, re.IGNORECASE)),
            None,
        )
        if free_idx is None:
            free_idx = next(
                (i for i, (_n, label, _h) in enumerate(opts)
                 if re.search(r"chat about|other|specify", label, re.IGNORECASE)),
                None,
            )
        if free_idx is None:
            return False
        # Navigate from option 1 (tui-drive assumes the caret starts there) to
        # the free-text option, then Enter to open its text field.
        for _ in range(max(0, free_idx)):
            self.send_key("Down")
            self._settle(0.12)   # drain each caret-move repaint
        self.send_key("Enter")   # open the free-text field
        self._settle(0.6)
        return True

    def drive_until(
        self,
        is_done: Callable[[], bool],
        *,
        idle_pattern: str | None = None,
        on_idle: Callable[[PtyTerminal], None] | None = None,
        timeout: float = 3600.0,
        idle_timeout: float = 240.0,
    ) -> bool:
        """Run the terminal forward until *is_done()* (on-disk signal) is True.

        Between checks, when the screen shows a gate/menu (or *idle_pattern*
        appears) the *on_idle* callback is invoked to advance it (e.g. answer the
        gate). Returns True if completion was detected, False on the overall
        timeout (a loud hang-backstop — the caller should treat False as failure,
        not success).
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if is_done():
                return True
            if not self.alive:
                # process exited; give the on-disk signal one last chance
                return is_done()
            advanced = False
            if self.screen_has_menu():
                # A selectable menu (v2 AskUserQuestion / gate). Fingerprint it
                # BEFORE answering so we can wait for THAT menu to clear after —
                # otherwise the just-answered menu, still lingering on the grid
                # for a beat before the model processes the key, gets
                # re-detected and re-answered (the scope-gate re-fire).
                before = self._menu_fingerprint()
                if on_idle is not None:
                    on_idle(self)
                else:
                    self.answer_gate_default()
                self._wait_menu_cleared(before, timeout=8.0)
                advanced = True
            elif idle_pattern is not None and self.wait_for(
                idle_pattern, timeout=idle_timeout, stable_ms=800
            ):
                if on_idle is not None:
                    on_idle(self)
                advanced = True
            elif on_idle is not None and self.prompt_is_waiting():
                # A free-text approval/clarification gate (v1.5/v1 prose): the
                # CLI is quiescent at an empty caret with no menu. Let on_idle
                # supply a human response.
                if not is_done():
                    on_idle(self)
                    advanced = True
            if not advanced:
                self._drain(timeout=1.0)
        return is_done()

    def full_transcript(self) -> str:
        """Return the entire raw output decoded (for logging/debugging)."""
        return b"".join(self._raw_log).decode("utf-8", errors="replace")

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

# A menu caret on a highlighted option, plus the select/submit footer the
# AskUserQuestion widget paints. Mirrors gridHasMenu() in tui-drive.ts.
_MENU_CARET_RE = re.compile(r"[❯>]\s+\S")
_SELECT_FOOTER_RE = re.compile(r"Enter to select|Submit answers|Submit", re.IGNORECASE)


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
        cols: int = 120,
        rows: int = 45,
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

    def answer_gate_default(self) -> None:
        """Answer the painted gate, mirroring tui-drive.ts's per-widget key model.

        - Submit review screen: Enter commits the whole form.
        - Multi-select option (numbered line with a checkbox): Enter TOGGLES
          instead of selecting (the t73 toggle-forever hang), so Space toggles
          the Recommended option ON, then Right advances a multi-tab form or
          Enter commits a lone multi-select question.
        - Single-select: bare Enter accepts the highlighted Recommended option.
        """
        screen = self.screen_text()
        if "Submit answers" in screen:
            self.send_key("Enter")
            return
        if re.search(r"\d+\.\s*\[[ xX✔]\]", screen):
            self.send_key("Space")
            time.sleep(0.15)
            if "←" in screen and "→" in screen:
                self.send_key("Right")
            else:
                self.send_key("Enter")
            return
        self.send_key("Enter")

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
        last_menu_screen = ""
        while time.monotonic() < deadline:
            if is_done():
                return True
            if not self.alive:
                # process exited; give the on-disk signal one last chance
                return is_done()
            advanced = False
            if self.screen_has_menu():
                # Only answer when the menu screen has actually changed since the
                # last answer; a stale identical screen means the TUI hasn't
                # processed the previous keystroke yet. Always drain after
                # answering — sending keys in a tight loop without pumping the
                # PTY output fills both pipe buffers and deadlocks writer/reader.
                screen_now = self.screen_text()
                if screen_now != last_menu_screen:
                    if on_idle is not None:
                        on_idle(self)
                    else:
                        self.answer_gate_default()
                    last_menu_screen = screen_now
                self._drain(timeout=2.0)
                advanced = True
            elif idle_pattern is not None and self.wait_for(
                idle_pattern, timeout=idle_timeout, stable_ms=800
            ):
                if on_idle is not None:
                    on_idle(self)
                advanced = True
            if not advanced:
                self._drain(timeout=1.0)
        return is_done()

    def full_transcript(self) -> str:
        """Return the entire raw output decoded (for logging/debugging)."""
        return b"".join(self._raw_log).decode("utf-8", errors="replace")

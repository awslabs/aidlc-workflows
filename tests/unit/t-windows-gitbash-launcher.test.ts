// covers: file:core/tools/aidlc-lifecycle.ts file:core/tools/aidlc-install-paths.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previousWindowsPosixShims,
  windowsPosixCommandPath,
  windowsPosixLauncherBodyIsOwned,
} from "../../core/tools/aidlc-install-paths.ts";
import { windowsPosixShim } from "../../core/tools/aidlc-lifecycle.ts";

// Behavioral tests below run wherever a POSIX /bin/sh exists — Linux + macOS
// runners AND the Windows merge queue (Git Bash provides /bin/sh). Gating on
// existsSync("/bin/sh") rather than a !win32 carve-out is what lets the one
// platform the launcher targets actually exercise the launch path in CI.
const HAS_POSIX_SH = existsSync("/bin/sh");

// The Windows extensionless launcher exists so a bare `aidlc` resolves in Git
// Bash / MSYS shells, which use execvp PATH lookup and ignore PATHEXT (so they
// never find aidlc.cmd). These assertions pin the two load-bearing properties
// that make it work regardless of the host the test runs on.
describe("windows extensionless git bash launcher", () => {
  test("the forwarder is a LF POSIX script that execs its sibling aidlc.cmd", () => {
    const body = windowsPosixShim();
    // A CRLF script breaks under MSYS /bin/sh: the trailing \r joins the
    // shebang interpreter path, so /bin/sh\r is looked up and not found.
    expect(body.includes("\r")).toBe(false);
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    // Location-independent: it resolves aidlc.cmd relative to its own path, so
    // the body is a constant the installer's ownership check compares verbatim.
    // (Assert on fragments that avoid a literal "${" so the lint's
    // template-curly heuristic does not misfire on this shell expansion.)
    expect(body).toContain('self%/*}/aidlc.cmd" "$@"');
    // $0 hardening: normalise backslashes to slashes with SHELL BUILTINS
    // (a parameter-expansion loop), not `tr` — GNU tr in MSYS prints an
    // "unescaped backslash" warning on every launch, and the builtin form
    // also drops the external-command dependency.
    expect(body).not.toContain("tr ");
    expect(body).toContain("while [");
    expect(body).toContain("done");
    // Fail loud on a slash-less $0 instead of exec'ing a CWD-relative
    // ./aidlc.cmd — that fallback would break the launcher AND let an
    // attacker-planted aidlc.cmd in the current directory run.
    expect(body).toContain('*/*)');
    expect(body).toContain("exit 1");
    // No absolute install path baked in — that would make the body vary per
    // machine and defeat the byte-for-byte ownership comparison. (The case/
    // echo lines legitimately contain ':' so we check the exec target instead.)
    expect(body).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  test("the launcher path is bin/aidlc on Windows and null elsewhere", () => {
    const previous = process.env.AIDLC_BIN_DIR;
    const bin = join("/tmp", "aidlc-bin-fixture");
    process.env.AIDLC_BIN_DIR = bin;
    try {
      const path = windowsPosixCommandPath();
      if (process.platform === "win32") {
        expect(path).toBe(join(bin, "aidlc"));
      } else {
        // Off Windows the platform command is already the extensionless
        // launcher, so there is no separate sibling to install.
        expect(path).toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = previous;
    }
  });

  // Finding-closing behavioral test: the assertions above pin the SHAPE of the
  // forwarder, but nothing proved it actually LAUNCHES. The Windows-gated tests
  // run only in the merge queue (PR CI is Linux-only), so the launch path was
  // unexercised on the PR gate. This test runs the forwarder through /bin/sh —
  // available on macOS and Linux — against a stub aidlc.cmd, proving sibling
  // resolution, verbatim arg forwarding, and exit-code passthrough on EVERY
  // runner, including the Linux PR gate. The only Windows-specific link it does
  // not cover (MSYS executing the .cmd via the Windows loader) is validated
  // manually on a real Windows box.
  test("the forwarder resolves its sibling and round-trips args + exit code via /bin/sh", () => {
    if (!HAS_POSIX_SH) return;
    const dir = mkdtempSync(join(tmpdir(), "aidlc-forwarder-"));
    try {
      const forwarder = join(dir, "aidlc");
      writeFileSync(forwarder, windowsPosixShim(), { encoding: "utf-8" });
      chmodSync(forwarder, 0o755);
      // Stub sibling standing in for the real aidlc.cmd. It reports the arg
      // COUNT ($#) and each "$@" element on its own line, so a dropped-quoting
      // regression (forwarding $* or unquoted $@, which would split "two words"
      // into two args) is DETECTED — a $*-flattened assertion would pass either
      // way. Exits 7 to prove exit-code passthrough.
      const cmd = join(dir, "aidlc.cmd");
      writeFileSync(
        cmd,
        '#!/bin/sh\necho "argc=$#"\nfor a in "$@"; do echo "arg=[$a]"; done\nexit 7\n',
        { encoding: "utf-8" },
      );
      chmodSync(cmd, 0o755);

      // Run the forwarder as $0 = its own path (what a PATH lookup yields), so
      // the sibling-resolution branch is exercised, not the fail-loud branch.
      // Args include a spaces arg and an empty-string arg — both must survive.
      const run = spawnSync("/bin/sh", [forwarder, "hello", "two words", ""], {
        encoding: "utf-8",
      });

      expect(run.status).toBe(7);
      // Exactly three args survived as distinct, boundaries intact.
      expect(run.stdout).toContain("argc=3");
      expect(run.stdout).toContain("arg=[hello]");
      expect(run.stdout).toContain("arg=[two words]");
      expect(run.stdout).toContain("arg=[]");
      // The v2 regression: no GNU-tr "unescaped backslash" warning on stderr.
      expect(run.stderr ?? "").not.toContain("backslash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the forwarder normalises a backslash $0 to slashes (v3 loop)", () => {
    if (!HAS_POSIX_SH) return;
    // Exercises the v3 parameter-expansion normalisation loop — the whole
    // reason for this revision — as a standalone shell snippet, so a
    // backslash-separated $0 (what a Windows resolved path looks like) is
    // proven to convert to slashes. A real exec cannot be used here: a
    // backslash path is not a real file on the POSIX host the test runs on, so
    // we run the loop body directly against a fixed input and assert the
    // normalised result. The loop is lifted verbatim from the rendered body
    // (asserted identical to windowsPosixShim() below).
    const body = windowsPosixShim();
    // Pull the lines from `norm=''` through `self="$norm$self"` — the loop.
    const lines = body.split("\n");
    const start = lines.findIndex((l) => l === "norm=''");
    const end = lines.findIndex((l) => l === 'self="$norm$self"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const loop = lines.slice(start, end + 1).join("\n");
    const script = `self='C:\\Users\\me\\bin\\aidlc'\n${loop}\nprintf %s "$self"\n`;
    const run = spawnSync("/bin/sh", ["-c", script], { encoding: "utf-8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("C:/Users/me/bin/aidlc");
    expect(run.stderr ?? "").not.toContain("backslash");
  });

  test("windowsPosixLauncherBodyIsOwned recognises current + previous bodies, rejects foreign", () => {
    // The shared ownership predicate is the single source of truth install and
    // uninstall both consult. Test it on every runner (it is pure, no I/O), so
    // the ownership decision — including migration recognition of the v2 body —
    // has real coverage rather than only the Windows-gated plan tests.
    expect(windowsPosixLauncherBodyIsOwned(windowsPosixShim())).toBe(true);
    for (const prev of previousWindowsPosixShims()) {
      expect(windowsPosixLauncherBodyIsOwned(prev)).toBe(true);
    }
    // A user-authored / foreign body is NOT owned.
    expect(windowsPosixLauncherBodyIsOwned("#!/bin/sh\necho hi\n")).toBe(false);
    // A near-miss (current body with one byte changed) is NOT owned — exact match.
    expect(windowsPosixLauncherBodyIsOwned(windowsPosixShim() + " ")).toBe(false);
  });

  test("the v2 forwarder body is byte-frozen so migration recognition cannot silently break", () => {
    // previousWindowsPosixShims() is append-only BY CONTRACT (a comment): the
    // ownership check recognises a v2-machine's on-disk forwarder as ours and
    // overwrites it on upgrade. If the historical v2 string is ever edited, that
    // recognition silently breaks for every machine still carrying the real v2
    // body — the exact failure the allowlist exists to prevent, with no other
    // signal. This pins the v2 entry to the bytes the v2 installer actually
    // wrote, so an accidental edit fails HERE instead of in the field. The
    // literal below is the historical v2 body; it must NOT be "fixed" to match a
    // newer style — it is a frozen record of what shipped.
    const v2 = [
      "#!/bin/sh",
      "# aidlc-gitbash-forwarder-v2",
      'self=$(printf %s "$0" | tr "\\\\" "/")',
      'case "$self" in',
      '  */*) exec "$' + '{self%/*}/aidlc.cmd" "$@" ;;',
      '  *) echo "aidlc: cannot locate launcher directory from \\$0 ($0)" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n");
    // The frozen v2 body is present in the allowlist, verbatim…
    expect(previousWindowsPosixShims()).toContain(v2);
    // …and the shared predicate recognises it as installer-owned.
    expect(windowsPosixLauncherBodyIsOwned(v2)).toBe(true);
    // Guard the contract itself: the current body must never be dropped from
    // recognition, and every historical entry must remain non-empty LF scripts.
    for (const prev of previousWindowsPosixShims()) {
      expect(prev.startsWith("#!/bin/sh\n")).toBe(true);
      expect(prev.includes("\r")).toBe(false);
      expect(prev.length).toBeGreaterThan(0);
    }
  });

  test("a slash-less $0 fails loud instead of exec'ing a CWD-relative launcher", () => {
    if (!HAS_POSIX_SH) return;
    const dir = mkdtempSync(join(tmpdir(), "aidlc-forwarder-noslash-"));
    try {
      const forwarder = join(dir, "aidlc");
      writeFileSync(forwarder, windowsPosixShim(), { encoding: "utf-8" });
      chmodSync(forwarder, 0o755);
      // Plant a decoy aidlc.cmd in the CWD the child runs in: if the forwarder
      // wrongly fell back to a CWD-relative ./aidlc.cmd, it would exec THIS and
      // print DECOY-RAN. The fail-loud branch must prevent that.
      writeFileSync(join(dir, "aidlc.cmd"), '#!/bin/sh\necho DECOY-RAN\n', {
        encoding: "utf-8",
      });
      chmodSync(join(dir, "aidlc.cmd"), 0o755);
      // Run the forwarder with $0 set to a bare name (no directory separator),
      // which is what a mis-resolved invocation looks like. Invoking `sh aidlc`
      // from the forwarder's own directory sets $0 to the bare "aidlc" — no
      // separator — portably (no bash-only `exec -a`). CWD holds the decoy.
      const run = spawnSync("/bin/sh", ["aidlc"], {
        encoding: "utf-8",
        cwd: dir,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("cannot locate launcher directory");
      expect(run.stdout ?? "").not.toContain("DECOY-RAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration allowlist recognises the previous (v2) body as installer-owned", () => {
    // A body change must not strand an existing install: the previous body is
    // listed so the ownership check still treats it as ours (recognise +
    // overwrite on next activation), rather than refusing to touch a "foreign"
    // file. Guards against a marker bump self-locking activation.
    const previous = previousWindowsPosixShims();
    expect(previous.length).toBeGreaterThan(0);
    // Each entry is a real LF POSIX forwarder, not the current one.
    for (const body of previous) {
      expect(body.startsWith("#!/bin/sh\n")).toBe(true);
      expect(body.includes("\r")).toBe(false);
      expect(body).not.toBe(windowsPosixShim());
    }
  });
});

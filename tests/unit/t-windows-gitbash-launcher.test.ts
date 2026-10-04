// covers: file:core/tools/aidlc-lifecycle.ts file:core/tools/aidlc-install-paths.ts file:core/tools/aidlc-doctor.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previousWindowsPosixShims,
  windowsPosixCommandPath,
  windowsPosixLauncherBodyIsOwned,
} from "../../core/tools/aidlc-install-paths.ts";
import { windowsPosixShim } from "../../core/tools/aidlc-lifecycle.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { gitBashSkipReason, posixShellPath } from "../harness/git-bash.ts";
import { writeReleaseFixture } from "../harness/release-fixture.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

// Behavioral tests below run on every runner: /bin/sh on Linux and macOS, Git
// Bash's sh on Windows. Bun on Windows cannot see Git Bash's /bin, so an
// existsSync("/bin/sh") gate skipped these cases on the one platform the
// launcher targets; posixShellPath() finds the shell where Git installs it.
const NO_POSIX_SH = gitBashSkipReason() !== null;

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
    // Absolute on every platform: on Windows the bin root is resolved, so a
    // drive-less "/tmp" path comes back as "C:\tmp".
    const bin = join(tmpdir(), "aidlc-bin-fixture");
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
  // unexercised on the PR gate. This test runs the forwarder through a POSIX sh
  // (Git Bash's on Windows) against a stub aidlc.cmd, proving sibling
  // resolution, verbatim arg forwarding, and exit-code passthrough on EVERY
  // runner, including the Linux PR gate and the Windows merge queue. Git Bash
  // running the real aidlc.cmd through the Windows loader is covered by
  // t-native-install-hooks.
  test.skipIf(NO_POSIX_SH)("the forwarder resolves its sibling and round-trips args + exit code via sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-forwarder-"));
    try {
      const forwarder = join(dir, "aidlc");
      writeFileSync(forwarder, windowsPosixShim(), { encoding: "utf-8" });
      chmodSync(forwarder, 0o755);
      // Stub sibling standing in for the real aidlc.cmd. It reports the arg
      // COUNT ($#) and each "$@" element on its own line, so a dropped-quoting
      // regression (forwarding $* or unquoted $@, which would split "two words"
      // into two args) is DETECTED — a $*-flattened assertion would pass either
      // way. Exits 7 to prove exit-code passthrough. On Windows Git Bash hands
      // a .cmd to cmd.exe, so there the stub is a batch file that prints the
      // command line it received and each of its three args.
      const windows = process.platform === "win32";
      const cmd = join(dir, "aidlc.cmd");
      writeFileSync(
        cmd,
        windows
          ? "@echo off\r\necho line=[%*]\r\necho arg=[%~1]\r\necho arg=[%~2]\r\necho arg=[%~3]\r\nexit /b 7\r\n"
          : '#!/bin/sh\necho "argc=$#"\nfor a in "$@"; do echo "arg=[$a]"; done\nexit 7\n',
        { encoding: "utf-8" },
      );
      chmodSync(cmd, 0o755);

      // Run the forwarder as $0 = its own path (what a PATH lookup yields), so
      // the sibling-resolution branch is exercised, not the fail-loud branch.
      // Args include a spaces arg and an empty-string arg — both must survive.
      const run = spawnSync(posixShellPath(), [forwarder, "hello", "two words", ""], {
        encoding: "utf-8",
      });

      expect(run.status).toBe(7);
      // Exactly three args survived as distinct, boundaries intact.
      expect(run.stdout).toContain(windows ? 'line=[hello "two words" ""]' : "argc=3");
      expect(run.stdout).toContain("arg=[hello]");
      expect(run.stdout).toContain("arg=[two words]");
      expect(run.stdout).toContain("arg=[]");
      // The v2 regression: no GNU-tr "unescaped backslash" warning on stderr.
      expect(run.stderr ?? "").not.toContain("backslash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(NO_POSIX_SH)("the forwarder normalises a backslash $0 to slashes (v3 loop)", () => {
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
    // Run it from a file: Windows would requote a multi-line `sh -c` argument.
    const dir = mkdtempSync(join(tmpdir(), "aidlc-forwarder-loop-"));
    try {
      const file = join(dir, "loop.sh");
      writeFileSync(file, script, { encoding: "utf-8" });
      const run = spawnSync(posixShellPath(), [file], { encoding: "utf-8" });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("C:/Users/me/bin/aidlc");
      expect(run.stderr ?? "").not.toContain("backslash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test.skipIf(NO_POSIX_SH)("a slash-less $0 fails loud instead of exec'ing a CWD-relative launcher", () => {
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
      const run = spawnSync(posixShellPath(), ["aidlc"], {
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

  // Git Bash, where Claude Code runs its hooks on Windows, needs the
  // extensionless launcher; doctor must not read healthy without it.
  test.skipIf(process.platform !== "win32")(
    "doctor fails while Git Bash cannot run a bare aidlc, and names the step that fixes it",
    () => {
      const machine = mkdtempSync(join(tmpdir(), "aidlc-gitbash-doctor-"));
      const project = mkdtempSync(join(tmpdir(), "aidlc-gitbash-doctor-project-"));
      try {
        cpSync(join(REPO_ROOT, "dist", "claude"), project, { recursive: true });
        const bin = join(machine, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "aidlc.cmd"), "@echo off\r\n");
        const env = { ...process.env, AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
        const rowStarting = (prefix: string) => {
          const r = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc.ts"), "doctor", "--json", "--project-dir", project], {
            cwd: project,
            encoding: "utf-8",
            env,
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          });
          const report = JSON.parse(r.stdout) as { data?: { checks?: Array<{ pass: boolean; label: string; fix?: string }> } };
          return (report.data?.checks ?? []).find((check) => check.label.startsWith(prefix));
        };
        const row = () => rowStarting("Windows launcher (Git Bash)");
        // Only aidlc.cmd: what W5-CC's install had. No version marker, so the installer is the fix.
        expect(row()).toEqual({
          pass: false,
          label: "Windows launcher (Git Bash): a bare `aidlc` does not run in Git Bash, so hooks that call it fail there",
          fix: "rerun the AI-DLC installer (install.ps1)",
        });
        // Once a workflow has started with no hook run, the hooks row names this
        // cause and its fix, never /hooks (nothing there to approve).
        const created = spawnSync(process.execPath, [
          join(project, ".claude", "tools", "aidlc-utility.ts"),
          "intent-create", "--scope", "bugfix", "--label", "git bash", "--arguments", "fix the flag parser",
        ], { cwd: project, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
        expect(created.status, created.stderr).toBe(0);
        const never = rowStarting("Hooks have never executed");
        expect(never?.fix).toBe("Git Bash cannot run a bare `aidlc`, so no hook runs: rerun the AI-DLC installer (install.ps1)");
        writeFileSync(join(bin, "aidlc"), windowsPosixShim());
        expect(row()?.pass).toBe(true);
        writeFileSync(join(bin, "aidlc"), "#!/bin/sh\necho not ours\n");
        const foreign = row();
        expect(foreign?.pass).toBe(false);
        expect(foreign?.fix).toBe(`move ${join(bin, "aidlc")} aside, then rerun the AI-DLC installer (install.ps1)`);
      } finally {
        rmSync(machine, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    },
  );

  // A person's own bin\aidlc, such as a hand-made forwarder: they asked to
  // update or switch, not to overwrite it. At a terminal it asks once (Enter
  // means yes), --yes answers yes, and otherwise the refusal names the step.
  // Their file is kept either way.
  test.skipIf(process.platform !== "win32")(
    "an aidlc in bin that AI-DLC did not write is asked about once, kept as a backup, then replaced",
    () => {
      const root = mkdtempSync(join(tmpdir(), "aidlc-gitbash-foreign-"));
      try {
        const release = join(root, "release");
        mkdirSync(release);
        writeReleaseFixture({ root: release, repoRoot: REPO_ROOT, version: AIDLC_VERSION, binary: "executable" });
        const machine = join(root, "machine");
        const bin = join(machine, "bin");
        const project = join(root, "project");
        mkdirSync(join(project, ".git"), { recursive: true });
        // A missing gh: the fixture release has no real attestation to verify.
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          AIDLC_INSTALL_ROOT: machine,
          AIDLC_BIN_DIR: bin,
          AIDLC_GH_BIN: join(root, "no-gh", "gh.exe"),
          NO_COLOR: "1",
        };
        delete env.AIDLC_TEST_CONFIG_TTY;
        const lifecycle = (args: string[], extra: NodeJS.ProcessEnv = {}, input = "") => {
          const r = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts"), ...args], {
            cwd: project,
            encoding: "utf-8",
            env: { ...env, ...extra },
            input,
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          });
          return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        };
        const installed = lifecycle(["update", "--version", AIDLC_VERSION, "--from", release]);
        expect(installed.status, installed.stdout + installed.stderr).toBe(0);
        const launcher = join(bin, "aidlc");
        const own = "#!/bin/sh\nexec \"$(dirname \"$0\")/aidlc.cmd\" \"$@\"\n";
        const backups = () => readdirSync(bin).filter((name) => name.startsWith("aidlc.bak-")).sort();

        // No terminal and no --yes: left as it is, and the step is named.
        writeFileSync(launcher, own);
        const refused = lifecycle(["use", AIDLC_VERSION]);
        expect(refused.status).toBe(4);
        expect(refused.stdout + refused.stderr).toContain(
          `${launcher} wasn't made by AI-DLC, so it was left as it is. Move ${launcher} aside, then run this command again.`,
        );
        expect(readFileSync(launcher, "utf-8")).toBe(own);
        expect(backups()).toEqual([]);

        // At a terminal, "n" leaves it as well.
        const declined = lifecycle(["use", AIDLC_VERSION], { AIDLC_TEST_CONFIG_TTY: "1" }, "n\n");
        expect(declined.status).toBe(1);
        expect(declined.stdout).toContain(
          `${launcher} wasn't made by AI-DLC. Replace it with AI-DLC's launcher? Your file is kept as ${launcher}.bak-`,
        );
        expect(readFileSync(launcher, "utf-8")).toBe(own);
        expect(backups()).toEqual([]);

        // Enter means yes: AI-DLC's launcher is written and one line says where the old file went.
        const accepted = lifecycle(["use", AIDLC_VERSION], { AIDLC_TEST_CONFIG_TTY: "1" }, "\n");
        expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
        expect(readFileSync(launcher, "utf-8")).toBe(windowsPosixShim());
        expect(backups()).toHaveLength(1);
        const kept = join(bin, backups()[0]);
        expect(readFileSync(kept, "utf-8")).toBe(own);
        expect(accepted.stdout).toContain(`Replaced ${launcher} with AI-DLC's launcher; your file is now ${kept}.`);

        // --yes answers yes for a script or an agent; with --json the line stays off stdout.
        writeFileSync(launcher, own);
        const scripted = lifecycle(["update", "--version", AIDLC_VERSION, "--from", release, "--yes", "--json"]);
        expect(scripted.status, scripted.stdout + scripted.stderr).toBe(0);
        expect(JSON.parse(scripted.stdout).ok).toBe(true);
        expect(scripted.stderr).toContain(`Replaced ${launcher} with AI-DLC's launcher; your file is now ${launcher}.bak-`);
        expect(readFileSync(launcher, "utf-8")).toBe(windowsPosixShim());
        expect(backups()).toHaveLength(2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
});

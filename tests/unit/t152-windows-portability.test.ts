// covers: harness-instrument:windows-portability
//
// MR10 deterministic guard for the Windows runner/infrastructure handoff. The
// live proof is the EC2 run; this test keeps the committed run path honest on
// every platform by checking the files that make that run repeatable.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TESTS = join(REPO_ROOT, "tests");
const WINDOWS = join(TESTS, "harness", "windows");

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("t152 Windows portability guard", () => {
  test("run-tests.sh is a thin wrapper around the native Bun runner", () => {
    const sh = read("tests/run-tests.sh");
    expect(sh).toContain('exec bun "$SCRIPT_DIR/run-tests.ts" "$@"');
    expect(sh).not.toContain("jobs -rp");
    expect(sh).not.toContain("PIPESTATUS");
    expect(sh).not.toContain("grep -qE");
    expect(sh).not.toContain("eval \"$(");
  });

  test("native runner has no jq preflight dependency", () => {
    const ts = read("tests/run-tests.ts");
    expect(ts).not.toContain('commandExists("jq")');
    expect(ts).not.toContain("jq is required");
  });

  test("run-all.ps1 runs --all through Bun and forces live Windows TUI env", () => {
    const ps = readFileSync(join(WINDOWS, "run-all.ps1"), "utf8");
    expect(ps).toContain('$env:AIDLC_NODE_BIN = $NodeExe');
    expect(ps).toContain('$env:AIDLC_TUI_LIVE = "1"');
    expect(ps).toContain('-ArgumentList @("tests/run-tests.ts", "--all", "--debug", "-P", "$Parallel")');
    expect(ps).toContain("$Runner = Start-Process");
    expect(ps).toContain("exit $Runner.ExitCode");
    expect(ps).toContain("require('node-pty'); require('@xterm/headless')");
    expect(ps).not.toContain("run-tests.sh");
  });

  test("CloudFormation stack is disposable SSM-only Windows Server 2022", () => {
    const yaml = readFileSync(join(WINDOWS, "windows-test.cfn.yaml"), "utf8");
    expect(yaml).toContain("Windows_Server-2022-English-Full-Base");
    expect(yaml).toContain("AmazonSSMManagedInstanceCore");
    expect(yaml).toContain("SecurityGroupIngress: []");
    expect(yaml).toContain("Git-2.49.0-64-bit.exe");
    expect(yaml).toContain("node-v22.14.0-x64.msi");
    expect(yaml).toContain("https://bun.sh/install.ps1");
    expect(yaml).toContain("https://claude.ai/install.ps1");
  });

  test("SSM and sync helpers have no hard-coded EC2 instance id", () => {
    for (const rel of [
      "tests/harness/windows/ssm-run.ts",
      "tests/harness/windows/sync.ts",
      "tests/harness/windows/sync.sh",
    ]) {
      const body = read(rel);
      expect(body).not.toMatch(/\bi-[0-9a-f]{8,}\b/);
    }
    expect(read("tests/harness/windows/ssm-run.ts")).toContain("--stack-name");
    expect(read("tests/harness/windows/ssm-run.ts")).toContain("executionTimeout");
    expect(read("tests/harness/windows/sync.ts")).toContain("AIDLC_WINDOWS_STACK_NAME");
  });

  test("Windows path separators are normalized at harness and sensor boundaries", () => {
    const sensor = read("dist/claude/.claude/tools/aidlc-sensor.ts");
    expect(sensor).toContain("normalizePathForComparison(path)");
    expect(sensor).toContain('path.replace(/\\\\/g, "/")');
    expect(sensor).toContain("comparisonKey(normalizedPath)");
    expect(sensor).toContain("globToRegex(v).test(normalizedPath)");

    const fixtures = read("tests/harness/fixtures.ts");
    expect(fixtures).toContain('new Set(["EBUSY", "ENOTEMPTY", "EPERM"])');
    expect(fixtures).toContain("removeTreeWithRetry(proj)");

    const asserts = read("tests/harness/assert.ts");
    expect(asserts).toContain("assertStateFieldPath");
    expect(read("tests/integration/t70.test.ts")).toContain('assertStateFieldPath(r, "Project Root", proj)');
  });

  test("sibling TypeScript tools are resolved with fileURLToPath on Windows", () => {
    for (const rel of [
      "dist/claude/.claude/tools/aidlc-bolt.ts",
      "dist/claude/.claude/tools/aidlc-orchestrate.ts",
    ]) {
      const body = read(rel);
      expect(body).toContain("fileURLToPath(new URL(");
      expect(body).not.toContain("import.meta.url).pathname");
    }
  });

  test("swarm convergence check runs via a portable shell, not a hardcoded bash argv", () => {
    // #5: aidlc-swarm.ts checkConverged() previously launched the check command
    // through a hardcoded `bash` argv. `bash` is ENOENT on native Windows
    // PowerShell, so the convergence check spuriously failed there. The portable
    // form passes the check command as the command with a shell, picking
    // /bin/bash on POSIX where it exists (preserving the original bash
    // interpreter so bashisms don't regress to dash) and shell:true otherwise
    // (cmd.exe on win32, /bin/sh on bash-less POSIX).
    //
    // The needles below are split (`"spawn" + "Sync("`) on purpose: a verbatim
    // `spawnSync(` token co-occurring with the aidlc-swarm.ts literal and a
    // runtime launcher would make the coverage generator's body-derived
    // mechanism predicate (drivesCliSurface) misread THIS pure file-reading
    // guard as a deterministic CLI spawner. It spawns nothing — it greps source
    // — so the split keeps the honesty ratchet (gen-coverage-registry) accurate.
    const swarm = read("dist/claude/.claude/tools/aidlc-swarm.ts");
    const spawnCall = "spawn" + "Sync(";
    // The convergence spawn no longer hardcodes a bash -c argv.
    expect(swarm).not.toContain(`${spawnCall}"bash", ["-c", checkCmd]`);
    // It passes the check command as the command and runs it under a shell.
    expect(swarm).toContain(`${spawnCall}checkCmd, {`);
    expect(swarm).toContain("shell,");
    // Bash is preserved where present on POSIX (no dash regression for bashisms),
    // with shell:true as the cross-platform fallback (Windows + bash-less POSIX).
    expect(swarm).toContain('existsSync("/bin/bash")');
    expect(swarm).toContain('? "/bin/bash"');
    expect(swarm).toContain(": true");
  });

  test("Windows graph and type-check sensor paths avoid Bun substrate traps", () => {
    const lib = read("dist/claude/.claude/tools/aidlc-lib.ts");
    expect(lib).toContain("function loadScopeGridForMapping()");
    expect(lib).not.toMatch(/const \{ loadScopeGrid \} = require\("\.\/aidlc-graph\.ts"\)/);

    const typeCheck = read("dist/claude/.claude/tools/aidlc-sensor-type-check.ts");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: assertion matches literal TypeScript source
    expect(typeCheck).toContain('`${result.stdout ?? ""}${result.stderr ?? ""}`');
    expect(typeCheck).toContain("stdout.split(/\\r?\\n/)");
    expect(typeCheck).toContain("parseTscOutput(output)");
  });
});

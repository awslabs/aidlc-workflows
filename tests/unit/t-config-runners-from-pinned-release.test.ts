// covers: function:runnerGenerator, function:regenerateRunnersFor, function:pinnedRunnersFailure, function:runnersFallbackLine

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedRunnersFailure, regenerateRunnersFor, runnerGenerator, runnersFallbackLine } from "../../core/tools/aidlc-init.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";

const PINNED = "2.10.0";
const created: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const name of ["AIDLC_COMPILED_EXECUTABLE", "AIDLC_INSTALL_ROOT", "T_RUNNER_LOG", "T_RUNNER_EXIT"]) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  created.push(path);
  return path;
}

function staged(release: string | null, withTool = true): { root: string; harness: string; log: string } {
  const root = temp("aidlc-t-pinned-runners-");
  const harness = join(root, ".claude");
  mkdirSync(join(harness, "tools", "data"), { recursive: true });
  if (release !== null) {
    writeFileSync(join(harness, "tools", "data", "aidlc-stamp.json"), `${JSON.stringify({ frameworkVersion: release })}\n`);
  }
  if (withTool) {
    writeFileSync(join(harness, "tools", "aidlc-runner-gen.ts"), [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(process.env.T_RUNNER_LOG!, \`\${process.argv.slice(2).join(" ")} @ \${process.cwd()}\\n\`);`,
      `process.exit(Number(process.env.T_RUNNER_EXIT ?? 0));`,
    ].join("\n"));
  }
  const log = join(root, "ran.log");
  process.env.T_RUNNER_LOG = log;
  return { root, harness, log };
}

function nativeInstall(): string {
  const install = temp("aidlc-t-pinned-runners-install-");
  process.env.AIDLC_INSTALL_ROOT = install;
  process.env.AIDLC_COMPILED_EXECUTABLE = join(install, "active-aidlc");
  return install;
}

describe("config writes the runner skills with the release its files come from", () => {
  test("files from the running release are written in this process", () => {
    expect(runnerGenerator(staged(AIDLC_VERSION).harness, true)).toBeNull();
  });

  test("files that record no release are written in this process", () => {
    expect(runnerGenerator(staged(null).harness, true)).toBeNull();
  });

  test("an unpinned project's older files are written in this process", () => {
    expect(runnerGenerator(staged(PINNED).harness, false)).toBeNull();
  });

  test("a pinned release's own tool writes its runners when running from source", () => {
    const { root, harness, log } = staged(PINNED);
    regenerateRunnersFor(root, harness, true);
    expect(readFileSync(log, "utf-8")).toBe(`write @ ${root}\nscopes @ ${root}\n`);
  });

  test("a pinned release's own installed aidlc writes its runners on a native install", () => {
    const { harness } = staged(PINNED);
    const install = nativeInstall();
    const executable = join(install, "versions", PINNED, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    mkdirSync(join(install, "versions", PINNED), { recursive: true });
    writeFileSync(executable, "");
    expect(runnerGenerator(harness, true)).toEqual({
      release: PINNED,
      commands: [[executable, "engine", "gen", "runners"], [executable, "engine", "gen", "runner-scopes"]],
    });
  });

  test.skipIf(process.platform === "win32")("the installed aidlc runs in the staged tree", () => {
    const { root, harness, log } = staged(PINNED, false);
    const install = nativeInstall();
    const executable = join(install, "versions", PINNED, "aidlc");
    mkdirSync(join(install, "versions", PINNED), { recursive: true });
    writeFileSync(executable, `#!/bin/sh\necho "$* @ $(pwd -P)" >> "$T_RUNNER_LOG"\n`);
    chmodSync(executable, 0o755);
    regenerateRunnersFor(root, harness, true);
    expect(readFileSync(log, "utf-8")).toBe(`engine gen runners @ ${root}\nengine gen runner-scopes @ ${root}\n`);
  });

  test("a pinned release missing from a native install leaves its runners to the running release, and the refresh says so", () => {
    const { harness } = staged(PINNED);
    nativeInstall();
    expect(runnerGenerator(harness, true)).toEqual({ release: PINNED, missing: true });
    expect(runnersFallbackLine(PINNED, null)).toBe(
      `AI-DLC ${PINNED} is not installed on this computer, so AI-DLC ${AIDLC_VERSION} wrote the runner skills.`,
    );
  });

  test("a pinned release of any age writes its own runners with its own installed aidlc", () => {
    const { harness } = staged("2.9.0");
    const install = nativeInstall();
    const executable = join(install, "versions", "2.9.0", process.platform === "win32" ? "aidlc.exe" : "aidlc");
    mkdirSync(join(install, "versions", "2.9.0"), { recursive: true });
    writeFileSync(executable, "");
    expect(runnerGenerator(harness, true)).toEqual({
      release: "2.9.0",
      commands: [[executable, "engine", "gen", "runners"], [executable, "engine", "gen", "runner-scopes"]],
    });
  });

  test("a source without the release's runner tool writes them in this process", () => {
    expect(runnerGenerator(staged(PINNED, false).harness, true)).toBeNull();
  });

  test("a failing generator leaves the runners to the running release, in one line", () => {
    const { root, harness } = staged(PINNED);
    process.env.T_RUNNER_EXIT = "3";
    const generator = runnerGenerator(harness, true);
    expect(generator).toEqual({ release: PINNED, commands: [[process.execPath, join(harness, "tools", "aidlc-runner-gen.ts"), "write"], [process.execPath, join(harness, "tools", "aidlc-runner-gen.ts"), "scopes"]] });
    const failure = pinnedRunnersFailure(root, (generator as { commands: string[][] }).commands);
    expect(failure).toBe("exit 3");
    expect(runnersFallbackLine(PINNED, failure)).toBe(
      `AI-DLC ${PINNED} could not write its runner skills (exit 3), so AI-DLC ${AIDLC_VERSION} wrote them.`,
    );
  });
});

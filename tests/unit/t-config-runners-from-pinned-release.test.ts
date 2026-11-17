// covers: file:tools/aidlc-release-runners.ts

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateRunnersFor, runnerGenerator } from "../../core/tools/aidlc-release-runners.ts";
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
    expect(runnerGenerator(staged(AIDLC_VERSION).harness)).toBeNull();
  });

  test("files that record no release are written in this process", () => {
    expect(runnerGenerator(staged(null).harness)).toBeNull();
  });

  test("a pinned release's own tool writes its runners when running from source", () => {
    const { root, harness, log } = staged(PINNED);
    regenerateRunnersFor(root, harness);
    expect(readFileSync(log, "utf-8")).toBe(`write @ ${root}\nscopes @ ${root}\n`);
  });

  test("a pinned release's own installed aidlc writes its runners on a native install", () => {
    const { harness } = staged(PINNED);
    const install = nativeInstall();
    const executable = join(install, "versions", PINNED, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    mkdirSync(join(install, "versions", PINNED), { recursive: true });
    writeFileSync(executable, "");
    expect(runnerGenerator(harness)).toEqual({
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
    regenerateRunnersFor(root, harness);
    expect(readFileSync(log, "utf-8")).toBe(`engine gen runners @ ${root}\nengine gen runner-scopes @ ${root}\n`);
  });

  test("a pinned release missing from a native install stops with the step that installs it", () => {
    const { harness } = staged(PINNED);
    nativeInstall();
    expect(() => runnerGenerator(harness)).toThrow(`aidlc versions install ${PINNED}`);
  });

  test("a source without the release's runner tool stops instead of writing another release's text", () => {
    const { harness } = staged(PINNED, false);
    expect(() => runnerGenerator(harness)).toThrow(`the ${PINNED} source has no tools/aidlc-runner-gen.ts`);
  });

  test("a failing generator names its release", () => {
    const { root, harness } = staged(PINNED);
    process.env.T_RUNNER_EXIT = "3";
    expect(() => regenerateRunnersFor(root, harness)).toThrow(`${PINNED}'s runner generator failed`);
  });
});

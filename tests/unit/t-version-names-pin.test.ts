// covers: none (aidlc-channel.ts and the dispatcher's version route have no registry unit)
//
// In a pinned project the pin decides which release runs the work, so both
// version answers name it (#1464). `aidlc version` runs on this machine's
// release and keeps its stdout line exactly as it is, because an update checks
// a release it activates by comparing that line in whatever folder it runs:
// the pin is named on stderr, and as `pinnedVersion` under --json. When the pin
// launched the engine, `/aidlc --version` is answered by that engine, which
// knows both releases; otherwise it runs `aidlc version` as before.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  pinnedVersionNote,
  projectPinnedVersion,
} from "../../dist/claude/.claude/tools/aidlc-channel.ts";
import { setupIntegrationProject } from "../harness/fixtures.ts";

const OTHER = "2.9.0";
const created: string[] = [];
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function project(pin?: string): string {
  const dir = setupIntegrationProject();
  created.push(dir);
  if (pin !== undefined) writeFileSync(join(dir, ".aidlc-version"), pin);
  return dir;
}

function run(
  dir: string,
  args: string[],
  extra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extra };
  for (const name of ["AIDLC_PROJECT_DIR", "KIRO_PROJECT_DIR", "AIDLC_PIN_DISPATCHED", "AIDLC_ACTIVE_VERSION"]) {
    if (!(name in extra)) delete env[name];
  }
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf-8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VERSION_LINE = `aidlc ${AIDLC_VERSION} (runtime ${AIDLC_VERSION})\n`;

describe("the project's pin is read once, the same way everywhere", () => {
  test("a well-formed pin is its release; anything else is no pin", () => {
    const dir = project();
    expect(projectPinnedVersion(dir)).toBeNull();
    writeFileSync(join(dir, ".aidlc-version"), `${OTHER}\n`);
    expect(projectPinnedVersion(dir)).toBe(OTHER);
    writeFileSync(join(dir, ".aidlc-version"), "latest\n");
    expect(projectPinnedVersion(dir)).toBeNull();
    rmSync(join(dir, ".aidlc-version"));
    mkdirSync(join(dir, ".aidlc-version"));
    expect(projectPinnedVersion(dir)).toBeNull();
  });

  test("the machine's release is named only when it is another one", () => {
    expect(pinnedVersionNote(OTHER, AIDLC_VERSION)).toBe(
      `this project is pinned to aidlc ${OTHER}, which runs its workflow (machine active: ${AIDLC_VERSION})`,
    );
    expect(pinnedVersionNote(OTHER, OTHER)).toBe(`this project is pinned to aidlc ${OTHER}, which runs its workflow`);
    expect(pinnedVersionNote(OTHER)).toBe(`this project is pinned to aidlc ${OTHER}, which runs its workflow`);
  });
});

describe("aidlc version in a pinned project", () => {
  test("stdout is the same line as anywhere else, and stderr names the pin", () => {
    const dir = project(`${OTHER}\n`);
    const shown = run(dir, [".claude/tools/aidlc.ts", "version"]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toBe(VERSION_LINE);
    expect(shown.stderr).toBe(
      `aidlc: this project is pinned to aidlc ${OTHER}, which runs its workflow (machine active: ${AIDLC_VERSION})\n`,
    );
  });

  test("a pin to this machine's own release is named without a second version", () => {
    const dir = project(`${AIDLC_VERSION}\n`);
    const shown = run(dir, [".claude/tools/aidlc.ts", "version"]);
    expect(shown.stdout).toBe(VERSION_LINE);
    expect(shown.stderr).toBe(`aidlc: this project is pinned to aidlc ${AIDLC_VERSION}, which runs its workflow\n`);
  });

  test("--json carries the pin as pinnedVersion, with nothing on stderr", () => {
    const dir = project(`${OTHER}\n`);
    const shown = run(dir, [".claude/tools/aidlc.ts", "version", "--json"]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual({
      schemaVersion: 1,
      binaryVersion: AIDLC_VERSION,
      runtimeVersion: AIDLC_VERSION,
      pinnedVersion: OTHER,
    });
    expect(shown.stderr).toBe("");
  });

  test("--project-dir names the project whose pin is read", () => {
    const pinned = project(`${OTHER}\n`);
    const elsewhere = project();
    const shown = run(elsewhere, [".claude/tools/aidlc.ts", "--project-dir", pinned, "version", "--json"], {
      CLAUDE_PROJECT_DIR: elsewhere,
    });
    expect(JSON.parse(shown.stdout).pinnedVersion).toBe(OTHER);
  });

  test("with no pin, or a malformed one, version prints what it always printed", () => {
    for (const pin of [undefined, "latest\n"]) {
      const dir = project(pin);
      const shown = run(dir, [".claude/tools/aidlc.ts", "version"]);
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).toBe(VERSION_LINE);
      expect(shown.stderr).toBe("");
      const json = run(dir, [".claude/tools/aidlc.ts", "version", "--json"]);
      expect(JSON.parse(json.stdout)).toEqual({
        schemaVersion: 1,
        binaryVersion: AIDLC_VERSION,
        runtimeVersion: AIDLC_VERSION,
      });
    }
  });
});

describe("/aidlc --version", () => {
  test("the engine the pin launched answers with both releases itself", () => {
    const dir = project(`${AIDLC_VERSION}\n`);
    const step = run(dir, [".claude/tools/aidlc-orchestrate.ts", "next", "--version"], {
      AIDLC_PIN_DISPATCHED: AIDLC_VERSION,
      AIDLC_ACTIVE_VERSION: OTHER,
    });
    expect(step.status, step.stderr).toBe(0);
    const directive = JSON.parse(step.stdout);
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain(
      `Tell the person, in one line, that this project is pinned to aidlc ${AIDLC_VERSION}, which runs its workflow (machine active: ${OTHER}), then stop.`,
    );
    expect(directive.message).toContain("do NOT run `next`");
    expect(directive.message).not.toContain("version`, print its output verbatim");
  });

  test("an engine the pin did not launch still runs aidlc version", () => {
    const runs: Record<string, string>[] = [{}, { AIDLC_PIN_DISPATCHED: OTHER, AIDLC_ACTIVE_VERSION: OTHER }];
    for (const extra of runs) {
      const dir = project();
      const step = run(dir, [".claude/tools/aidlc-orchestrate.ts", "next", "--version"], extra);
      expect(step.status, step.stderr).toBe(0);
      const directive = JSON.parse(step.stdout);
      expect(directive.kind).toBe("print");
      expect(directive.message).toMatch(/^Run `[^`]* version`, print its output verbatim, then stop\./);
    }
  });
});

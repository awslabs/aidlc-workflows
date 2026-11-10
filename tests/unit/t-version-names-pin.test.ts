// covers: none (aidlc-channel.ts and the dispatcher's version route have no registry unit)
//
// In a pinned project the pin decides which release runs the work, so both
// version answers name it. `aidlc version` runs on this machine's release and
// keeps its stdout line exactly as it is, because an update checks a release it
// activates by comparing that line in whatever folder it runs. The pin is named
// on stderr only at a terminal, where a person reads it: a script, a pipe or a
// capture gets nothing new, since Windows PowerShell 5.1 stops a script that
// stops on errors at a stderr line it redirects. `--json` names it as
// `pinnedVersion`. When the pin launched the engine, `/aidlc --version` is
// answered by that engine, which knows both releases; otherwise it runs
// `aidlc version` as before.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
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

// The same command with a terminal on every stream, as a person runs it; the
// terminal shows both streams as one text, and a Windows console writes
// sequences of its own between lines (its window title among them).
async function runAtTerminal(dir: string, args: string[]): Promise<{ status: number; shown: string }> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  for (const name of ["AIDLC_PROJECT_DIR", "KIRO_PROJECT_DIR", "AIDLC_PIN_DISPATCHED", "AIDLC_ACTIVE_VERSION"]) {
    delete env[name];
  }
  let shown = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: dir,
    env,
    terminal: { cols: 200, rows: 24, data: (_terminal, data) => { shown += decoder.decode(data); } },
  });
  const status = await child.exited;
  child.terminal?.close();
  return { status, shown: stripVTControlCharacters(shown).replaceAll("\r", "") };
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
  test("redirected, piped or captured, it writes nothing to stderr", () => {
    for (const pin of [OTHER, AIDLC_VERSION]) {
      const dir = project(`${pin}\n`);
      const shown = run(dir, [".claude/tools/aidlc.ts", "version"]);
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).toBe(VERSION_LINE);
      expect(shown.stderr).toBe("");
    }
  });

  test("at a terminal it names the pin after the same line", async () => {
    const versionLine = VERSION_LINE.trim();
    const other = await runAtTerminal(project(`${OTHER}\n`), [".claude/tools/aidlc.ts", "version"]);
    expect(other.status, other.shown).toBe(0);
    const pinLine =
      `aidlc: this project is pinned to aidlc ${OTHER}, which runs its workflow (machine active: ${AIDLC_VERSION})`;
    expect(other.shown).toContain(versionLine);
    expect(other.shown.indexOf(pinLine)).toBeGreaterThan(other.shown.indexOf(versionLine));
    const own = await runAtTerminal(project(`${AIDLC_VERSION}\n`), [".claude/tools/aidlc.ts", "version"]);
    const ownLine = `aidlc: this project is pinned to aidlc ${AIDLC_VERSION}, which runs its workflow`;
    expect(own.shown).toContain(versionLine);
    expect(own.shown.indexOf(ownLine)).toBeGreaterThan(own.shown.indexOf(versionLine));
    expect(own.shown).not.toContain("machine active");
    const unpinned = await runAtTerminal(project(), [".claude/tools/aidlc.ts", "version"]);
    expect(unpinned.shown).toContain(versionLine);
    expect(unpinned.shown).not.toContain("pinned to");
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

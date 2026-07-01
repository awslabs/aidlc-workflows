// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:detect
// covers: function:classifyTerminalCommand
//
// t198 - the P0 compose surfaces (adaptive workflows):
//   - `compose` as a LEADING verb reaches the composer-dispatch branch (Branch
//     4c) in BOTH worlds: cold start (front) and with-state (in-flight). A
//     mid-flow bare `compose` must NOT fall through to Branch 10 and advance
//     the current stage.
//   - `--new-scope` and `--report <path>` are parsed flags: --report CONSUMES
//     its value (an unrecognized valued flag would leak the path into
//     flags.intent - the spike-F trap), and both force the composer dispatch.
//   - compose is NOT in WORKSPACE_VERBS / classifyTerminalCommand: on Kiro the
//     verb-intercept hook classifies every leading terminal verb and runs it
//     off-band as an aidlc-utility subcommand + arms the roll-forward latch. A
//     compose entry there would spawn a nonexistent subcommand and neuter the
//     same-turn birth `next` - so classifyTerminalCommand(["compose", ...])
//     must stay null (the Kiro-adapter regression pin).
//   - Branch 8 (cold-start freeform, no --scope) now routes by keyword
//     inference instead of the static feature-default confirm: a clear keyword
//     hit (<=5 words) asks a one-line confirm NAMING THE MATCHED SCOPE; rich /
//     unmatched prose asks the COMPOSE OFFER (never a silent feature default).
//   - `detect --json` is a pure read: prints the workspace scan + the resolved
//     scopesDir/scopeGridPath (so the composer is TOLD where to write) and
//     leaves the project dir untouched.
//
// Mechanism: CLI spawn of the shipped dist engine (same convention as t114/
// t179); no LLM, no network - unit tier.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";
import { classifyTerminalCommand } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

interface RunResult {
  rc: number;
  out: string;
}

function runNext(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [ORCH, "next", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function runUtility(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

// ===========================================================================
// The Kiro verb-intercept regression pin (review trap 1). compose must never
// classify as a terminal command - a WORKSPACE_VERBS entry would make the Kiro
// hook run `aidlc-utility.ts compose` off-band and arm the roll-forward latch.
// ===========================================================================
describe("t198 compose is NOT a terminal command (Kiro seam regression)", () => {
  test("classifyTerminalCommand null for compose in every arg shape", () => {
    expect(classifyTerminalCommand(["compose"])).toBeNull();
    expect(classifyTerminalCommand(["compose", "fix", "the", "bug"])).toBeNull();
    expect(classifyTerminalCommand(["compose", "--report", "sonar.json"])).toBeNull();
    expect(classifyTerminalCommand(["--new-scope"])).toBeNull();
    expect(classifyTerminalCommand(["--report", "sonar.json"])).toBeNull();
  });

  test("workspace verbs still classify (the set itself is untouched)", () => {
    expect(classifyTerminalCommand(["space", "teamB"])).toEqual({
      subcommand: "space",
      arg: "teamB",
      source: "workspace-verb",
    });
  });
});

// ===========================================================================
// Cold start (front): compose / --new-scope / --report each reach the
// composer-dispatch print - never the freeform confirm, never a birth.
// ===========================================================================
describe("t198 cold-start compose surfaces -> composer dispatch", () => {
  test("leading compose verb + freeform text -> print naming the composer agent", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["compose", "fix the token bug"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("aidlc-composer-agent");
    expect(String(d.message)).toContain("fix the token bug");
    // Front mode, not in-flight: no state file exists.
    expect(String(d.message)).not.toContain("RUNNING workflow");
  });

  test("--report <path> consumes its value (no leak into the intent text)", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["compose", "--report", "sonar.json"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain('scan report at "sonar.json"');
    // The spike-F leak shape was intent text "compose sonar.json" - the path
    // must ride the report slot, not the task-text slot.
    expect(String(d.message)).not.toContain('for: "sonar.json"');
  });

  test("--new-scope forces synthesis wording and dispatches without the verb", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["--new-scope", "build a payment reconciliation service"]).out,
    );
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("aidlc-composer-agent");
    expect(String(d.message)).toContain("--new-scope");
    expect(String(d.message)).toContain("SYNTHESIZE");
  });

  test("compose + --stage is rejected (plan-shape vs cursor-move confusion)", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["compose", "--stage", "feasibility"]).out);
    expect(d.kind).toBe("error");
  });
});

// ===========================================================================
// With-state (in-flight): a bare mid-flow compose reaches the IN-FLIGHT
// composer dispatch - NOT Branch 10 (which would silently advance the current
// stage: the spike-F trap this branch exists to close).
// ===========================================================================
describe("t198 mid-flow compose -> in-flight dispatch, not an advance", () => {
  test("bare compose over an active workflow names the in-flight composer", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const d = directiveOf(runNext(proj, ["compose"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("aidlc-composer-agent");
    expect(String(d.message)).toContain("RUNNING workflow");
    // The counterfactual: a guard-less engine routes this to the current
    // run-stage. Pin the absence.
    expect(d.kind).not.toBe("run-stage");
  });

  test("bare next (no compose) still advances - the dispatch branch is inert when unused", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const d = directiveOf(runNext(proj, []).out);
    expect(d.kind).toBe("run-stage");
  });
});

// ===========================================================================
// Branch 8 rewiring: inference-driven confirm vs the compose offer. The old
// behavior was a static feature-default confirm for ALL freeform prose.
// ===========================================================================
describe("t198 Branch 8: inference confirm + compose offer", () => {
  test("clear keyword hit (<=5 words) -> one-line confirm naming the MATCHED scope", () => {
    proj = createTestProject();
    const d = directiveOf(runNext(proj, ["fix login bug"]).out);
    expect(d.kind).toBe("ask");
    // bugfix carries keyword "fix"; the old code would have said "feature".
    expect(String(d.question)).toContain('"bugfix"');
    expect(String(d.question)).toContain("compose");
  });

  test("rich prose (no clear hit) -> the compose offer, never a silent feature default", () => {
    proj = createTestProject();
    const d = directiveOf(
      runNext(proj, ["build a distributed cache layer with consistency guarantees"]).out,
    );
    expect(d.kind).toBe("ask");
    expect(String(d.question)).toContain("compose");
    expect(String(d.question)).not.toContain('"feature" workflow');
  });

  test("known-scope positional still births (Branch 7b untouched)", () => {
    proj = createTestProject();
    // The birth path needs a GENUINELY empty workspace (zero intents), else the
    // engine asks to select the seeded record instead of birthing (t118's
    // pattern).
    removeWorkspaceRecord(proj);
    const d = directiveOf(runNext(proj, ["bugfix"]).out);
    expect(d.kind).toBe("print");
    expect(String(d.message)).toContain("intent-birth --scope bugfix");
  });
});

// ===========================================================================
// detect --json: pure read, prints the scan + the resolved registry paths.
// ===========================================================================
describe("t198 detect --json is a pure read that names the write target", () => {
  test("returns scan fields + scopesDir + scopeGridPath + the 9 stock scopes, writes nothing", () => {
    proj = createTestProject();
    const before = readdirSync(proj).sort().join(",");
    const r = runUtility(proj, ["detect", "--json"]);
    expect(r.rc).toBe(0);
    const payload = JSON.parse(r.out.trim()) as Record<string, unknown>;
    expect(["Greenfield", "Brownfield"]).toContain(String(payload.projectType));
    expect(typeof payload.languages).toBe("string");
    expect(String(payload.scopesDir)).toContain("scopes");
    expect(String(payload.scopeGridPath)).toContain("scope-grid.json");
    expect(payload.scopes as string[]).toContain("bugfix");
    const after = readdirSync(proj).sort().join(",");
    expect(after).toBe(before); // no dir created, no file written
  });
});

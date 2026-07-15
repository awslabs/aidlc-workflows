// covers: hook:aidlc-audit-logger, hook:aidlc-sensor-fire, hook:aidlc-sync-statusline, hook:aidlc-runtime-compile, hook:aidlc-validate-state, hook:aidlc-log-subagent, hook:aidlc-stop
//
// t131 — the hooks move (Fork 2→B). Migrated from
// tests/integration/t131-hooks-settings-fire.sh (TAP plan 16). With the six
// workflow-spine hooks relocated from aidlc/SKILL.md frontmatter into
// project-wide settings.json, this proves two halves:
//
//   (1) REGISTRATION (mechanism none) — settings.json (a static JSON file) is
//       valid JSON and wires all seven hooks under the right Claude Code event:
//       audit-logger + sensor-fire on PostToolUse(Write|Edit), sync-statusline
//       on PostToolUse(TaskUpdate), runtime-compile on PostToolUse(Bash),
//       validate-state on PreCompact, log-subagent on SubagentStop, stop on
//       Stop; and aidlc/SKILL.md no longer carries a `hooks:` frontmatter block
//       (the move removed it entirely). The .sh shelled `bun -e` JSON.parse
//       passes; here we read + JSON.parse the same files IN-PROCESS — no LLM,
//       no subprocess, the data is on disk.
//
//   (2) BEHAVIOUR + SELF-GATE (mechanism cli) — the spine still fires inside a
//       workflow and self-gates to a no-op outside one. A hook has no CLI arg
//       surface; it is driven by feeding Claude Code's PostToolUse JSON on
//       stdin with CLAUDE_PROJECT_DIR set, the same way Claude Code drives it
//       from settings.json. So every behaviour/self-gate row is preserved by
//       SPAWNING the real hook via node:child_process spawnSync (the bun
//       runtime + the hook .ts path) with the JSON piped through `input:`,
//       exactly as the .sh did
//         `echo '<json>' | CLAUDE_PROJECT_DIR=<p> bun "<proj>/.claude/hooks/...ts"`.
//
// SOURCE UNDER TEST:
//   dist/claude/.claude/settings.json — the hooks: block (lines 32-121).
//       PostToolUse Write|Edit -> aidlc-audit-logger.ts + aidlc-sensor-fire.ts;
//       PostToolUse TaskUpdate -> aidlc-sync-statusline.ts; PostToolUse Bash ->
//       aidlc-runtime-compile.ts; PreCompact -> aidlc-validate-state.ts;
//       SubagentStop -> aidlc-log-subagent.ts; Stop -> aidlc-stop.ts.
//   dist/claude/.claude/skills/aidlc/SKILL.md — frontmatter no longer carries
//       a `^hooks:` line.
//   dist/claude/.claude/hooks/aidlc-audit-logger.ts — PostToolUse Write|Edit.
//       Self-gates: only logs writes to aidlc-docs/ (:47) AND only when
//       audit.md already exists (:55, "Don't auto-create audit.md"). Inside a
//       workflow (audit.md present) a Write under aidlc-docs/ -> appendAuditEntry
//       (:95) appends one ARTIFACT_CREATED/UPDATED row.
//   dist/claude/.claude/hooks/aidlc-runtime-compile.ts — PostToolUse Bash.
//       Self-gates: command must match aidlc-(state|jump|bolt|utility).ts (:61-64)
//       AND audit.md must exist (:68). On a GATE_APPROVED-tail audit it dispatches
//       `bun run <proj>/.claude/tools/aidlc-runtime.ts compile` (:106-111), which
//       writes aidlc-docs/runtime-graph.json.
//   Project-dir resolution: resolveProjectDirFromHook honours CLAUDE_PROJECT_DIR
//       first (aidlc-lib.ts:116).
//
// FIXTURE DISCIPLINE — replicate the .sh's make_workflow (t131:76-85) EXACTLY:
// a fresh temp project with aidlc-docs/ + a self-contained .claude/ skeleton
// holding the three tool files (aidlc-runtime.ts, aidlc-lib.ts, aidlc-audit.ts)
// + data/stage-graph.json + the two driven hooks copied in, plus a minimal
// aidlc-state.md ("- **Scope**: bugfix"). The COPY (not symlink) matters: the
// runtime-compile hook spawns <proj>/.claude/tools/aidlc-runtime.ts, whose
// aidlc-lib.ts resolves data/stage-graph.json relative to its own location —
// the data file must sit beside the copied lib for the compile to read it.
// mkdtempSync + toPortablePath (Windows path round-trip). Nothing is written
// under tests/fixtures/**; all temp dirs cleaned in afterAll.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (PostToolUse:: block present)              -> R1
//   .sh test 2  (audit-logger on PostToolUse)              -> R2
//   .sh test 3  (sensor-fire on PostToolUse)               -> R3
//   .sh test 4  (sync-statusline on PostToolUse)           -> R4
//   .sh test 5  (runtime-compile on PostToolUse)           -> R5
//   .sh test 6  (validate-state on PreCompact)             -> R6
//   .sh test 7  (log-subagent on SubagentStop)             -> R7
//   .sh test 8  (stop on Stop)                             -> R8
//   .sh test 9  (audit-logger matcher == "Write|Edit")     -> R9
//   .sh test 10 (SKILL.md carries no ^hooks: block)        -> R10
//   .sh test 11 (in-workflow Write -> audit row appended)  -> B1
//   .sh test 12 (in-workflow transition -> graph emitted)  -> B2
//   .sh test 13 (outside workflow -> audit-logger exit 0)  -> S1
//   .sh test 14 (outside workflow -> no audit.md written)  -> S2
//   .sh test 15 (outside workflow -> runtime-compile exit 0)-> S3
//   .sh test 16 (outside workflow -> no runtime-graph.json) -> S4
//
// 16 .sh asserts -> 16 expect()-bearing test() cases here (several STRONGER:
// matcher checks are scoped to the group actually carrying the hook command,
// and the registration assertions verify the resolved hook command path, not
// just substring presence).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const SETTINGS = join(AIDLC_SRC, "settings.json");
const SKILL = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const SRC_TOOLS = join(AIDLC_SRC, "tools");
const SRC_HOOKS = join(AIDLC_SRC, "hooks");

// P9 per-intent layout: the audit-logger + runtime-compile spine resolves state
// via stateFilePath() and the audit trail via auditFilePath()/readAllAuditShards()
// under the active intent's record. We PIN the clone-id so the seeded shard and
// the hook's resolved shard agree; reads glob every shard.
const PINNED_CLONE_ID = "testcloneid131";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}
function pinnedShardPath(proj: string): string {
  return join(seededAuditDir(proj), pinnedShardName());
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// ============================================================================
// (1) REGISTRATION — mechanism none. Read + JSON.parse the static settings.json
// and read SKILL.md, asserting the hooks: block wiring on disk.
// ============================================================================

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
}

/** Parse settings.json once (it is a static shipped file). */
function readSettings(): Settings {
  return JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
}

/** All groups registered under a given Claude Code event. */
function groupsFor(s: Settings, event: string): HookGroup[] {
  return s.hooks?.[event] ?? [];
}

/** True if any hook group under `event` carries a command including `needle`. */
function eventHasHook(s: Settings, event: string, needle: string): boolean {
  return groupsFor(s, event).some((g) =>
    (g.hooks ?? []).some((h) => (h.command ?? "").includes(needle)),
  );
}

/** The matcher of the FIRST group under `event` whose commands include `needle`. */
function matcherForHook(
  s: Settings,
  event: string,
  needle: string,
): string | undefined {
  const g = groupsFor(s, event).find((grp) =>
    (grp.hooks ?? []).some((h) => (h.command ?? "").includes(needle)),
  );
  return g?.matcher;
}

describe("t131 hooks-move registration (settings.json + SKILL.md, mechanism none)", () => {
  test("R1: settings.json is valid JSON and registers a PostToolUse hook block [.sh test 1]", () => {
    const s = readSettings();
    // .sh: assert_contains REG "PostToolUse::". STRONGER: the block must exist
    // AND carry at least one hook command.
    const post = groupsFor(s, "PostToolUse");
    expect(post.length).toBeGreaterThan(0);
    expect(post.some((g) => (g.hooks ?? []).length > 0)).toBe(true);
  });

  test("R2: audit-logger registered on PostToolUse [.sh test 2]", () => {
    expect(
      eventHasHook(readSettings(), "PostToolUse", "aidlc-audit-logger.ts"),
    ).toBe(true);
  });

  test("R3: sensor-fire registered on PostToolUse [.sh test 3]", () => {
    expect(
      eventHasHook(readSettings(), "PostToolUse", "aidlc-sensor-fire.ts"),
    ).toBe(true);
  });

  test("R4: sync-statusline registered on PostToolUse [.sh test 4]", () => {
    expect(
      eventHasHook(readSettings(), "PostToolUse", "aidlc-sync-statusline.ts"),
    ).toBe(true);
  });

  test("R5: runtime-compile registered on PostToolUse [.sh test 5]", () => {
    expect(
      eventHasHook(readSettings(), "PostToolUse", "aidlc-runtime-compile.ts"),
    ).toBe(true);
  });

  test("R6: validate-state registered on PreCompact [.sh test 6]", () => {
    expect(
      eventHasHook(readSettings(), "PreCompact", "aidlc-validate-state.ts"),
    ).toBe(true);
  });

  test("R7: log-subagent registered on SubagentStop [.sh test 7]", () => {
    expect(
      eventHasHook(readSettings(), "SubagentStop", "aidlc-log-subagent.ts"),
    ).toBe(true);
  });

  test("R8: stop registered on Stop [.sh test 8]", () => {
    expect(eventHasHook(readSettings(), "Stop", "aidlc-stop.ts")).toBe(true);
  });

  test("R9: audit-logger matcher is Write|Edit [.sh test 9]", () => {
    // .sh: assert_eq WE_MATCHER "Write|Edit". The matcher belongs to the
    // PostToolUse group that carries the audit-logger command.
    expect(
      matcherForHook(readSettings(), "PostToolUse", "aidlc-audit-logger.ts"),
    ).toBe("Write|Edit");
    // STRONGER: runtime-compile (the other PostToolUse seam under test) sits in
    // a Bash-matcher group, distinct from the Write|Edit group.
    expect(
      matcherForHook(readSettings(), "PostToolUse", "aidlc-runtime-compile.ts"),
    ).toBe("Bash");
  });

  test("R10: aidlc/SKILL.md carries no hooks: block (moved to settings.json) [.sh test 10]", () => {
    // .sh: assert_not_grep SKILL "^hooks:". Match the exact anchored pattern.
    const skill = readFileSync(SKILL, "utf-8");
    const hasHooksLine = skill
      .split("\n")
      .some((l) => /^hooks:/.test(l));
    expect(hasHooksLine).toBe(false);
  });
});

// ============================================================================
// (2) BEHAVIOUR + SELF-GATE — mechanism cli. Spawn the real hooks with the
// PostToolUse JSON on stdin and CLAUDE_PROJECT_DIR set.
// ============================================================================

/**
 * make_workflow (t131:76-85): a fresh temp project with a self-contained
 * .claude/ skeleton (the three tools + data/stage-graph.json + the two driven
 * hooks copied in), aidlc-docs/, and a minimal aidlc-state.md. `withState`
 * controls whether the state file is seeded (the .sh's make_workflow seeds it;
 * the bare self-gate project omits it).
 */
function makeProject(withState: boolean): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools", "data"), { recursive: true });
  mkdirSync(join(proj, ".claude", "hooks"), { recursive: true });
  for (const t of ["aidlc-runtime.ts", "aidlc-lib.ts", "aidlc-runtime-paths.ts", "aidlc-audit.ts"]) {
    copyFileSync(join(SRC_TOOLS, t), join(proj, ".claude", "tools", t));
  }
  copyFileSync(
    join(SRC_TOOLS, "data", "stage-graph.json"),
    join(proj, ".claude", "tools", "data", "stage-graph.json"),
  );
  for (const h of ["aidlc-audit-logger.ts", "aidlc-runtime-compile.ts"]) {
    copyFileSync(join(SRC_HOOKS, h), join(proj, ".claude", "hooks", h));
  }
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  if (withState) {
    // State into the record so the active-intent cursor resolves → the hooks
    // anchor under the record (docsRoot/auditFilePath/runtimeGraphPath).
    mkdirSync(seededRecordDir(proj), { recursive: true });
    writeFileSync(seededStateFile(proj), "- **Scope**: bugfix", "utf-8");
  }
  return proj;
}

const auditLoggerHook = (proj: string): string =>
  join(proj, ".claude", "hooks", "aidlc-audit-logger.ts");
const runtimeCompileHook = (proj: string): string =>
  join(proj, ".claude", "hooks", "aidlc-runtime-compile.ts");
const graphPath = (proj: string): string =>
  join(seededRecordDir(proj), "runtime-graph.json");

interface HookResult {
  status: number;
  out: string;
}

/** run_hook (t131:91-92, 119-120): pipe PostToolUse JSON on stdin, CLAUDE_PROJECT_DIR set. */
function runHook(hookPath: string, proj: string, json: string): HookResult {
  const res = spawnSync(BUN, [hookPath], {
    input: json,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    timeout: 20_000,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// The transition audit the runtime-compile hook tail-reads (.sh:100-118):
// the last 3 blocks carry STAGE_COMPLETED + GATE_APPROVED -> dispatch compile.
const TRANSITION_AUDIT = `## Stage Start
**Event**: STAGE_STARTED
**Stage**: requirements-analysis

---

## Stage Completion
**Event**: STAGE_COMPLETED
**Stage**: requirements-analysis

---

## Gate Approved
**Event**: GATE_APPROVED
**Stage**: requirements-analysis

---
`;

describe("t131 spine fires inside a workflow (mechanism cli — spawnSync)", () => {
  test("B1: in-workflow Write -> audit-logger appends an audit row [.sh test 11]", () => {
    const proj = makeProject(true);
    // The audit SHARD present == active workflow (the audit-logger's :73 gate);
    // pin it as the seed so the hook (same clone-id) appends to this shard.
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(pinnedShardPath(proj), "# audit\n", "utf-8");
    const before = readAllAuditShards(proj).split("\n").length;
    const json = JSON.stringify({
      tool_name: "Write",
      tool_input: {
        // Under the per-intent record so the audit-logger's docsRoot() gate fires.
        file_path: join(
          seededRecordDir(proj),
          "inception",
          "requirements-analysis",
          "requirements.md",
        ),
      },
    });
    const r = runHook(auditLoggerHook(proj), proj, json);
    expect(r.status).toBe(0); // STRONGER: the .sh swallowed the exit code.
    const after = readAllAuditShards(proj).split("\n").length;
    expect(after).toBeGreaterThan(before);
    // STRONGER than the .sh's wc -l comparison: an actual artifact row landed.
    const body = readAllAuditShards(proj);
    expect(/\*\*Event\*\*:\s*ARTIFACT_(CREATED|UPDATED)/.test(body)).toBe(true);
  }, 30000);

  test("B2: in-workflow transition -> runtime-compile emits runtime-graph.json [.sh test 12]", () => {
    const proj = makeProject(true);
    // The transition trail goes into the record's audit shard (runtime-compile
    // reads readAllAuditShards of the active intent).
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(pinnedShardPath(proj), TRANSITION_AUDIT, "utf-8");
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          "bun .claude/tools/aidlc-state.ts approve --stage requirements-analysis",
      },
    });
    const r = runHook(runtimeCompileHook(proj), proj, json);
    expect(r.status).toBe(0); // STRONGER: the .sh swallowed the exit code.
    expect(existsSync(graphPath(proj))).toBe(true);
  }, 30000);

  test("B2-twin: new-shape state approve -> runtime-compile emits runtime-graph.json", () => {
    const proj = makeProject(true);
    // Same seam as B2, using the new public grammar instead of the tool-file shape.
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(pinnedShardPath(proj), TRANSITION_AUDIT, "utf-8");
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "aidlc state approve --stage requirements-analysis",
      },
    });
    const r = runHook(runtimeCompileHook(proj), proj, json);
    expect(r.status).toBe(0);
    expect(existsSync(graphPath(proj))).toBe(true);
  }, 30000);

  test("report-after-gate: new-shape report -> runtime-compile emits runtime-graph.json", () => {
    const proj = makeProject(true);
    // Pins the new report allowlist path that mirrors aidlc-orchestrate.ts report.
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(pinnedShardPath(proj), TRANSITION_AUDIT, "utf-8");
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          "aidlc report --stage requirements-analysis --result approved",
      },
    });
    const r = runHook(runtimeCompileHook(proj), proj, json);
    expect(r.status).toBe(0);
    expect(existsSync(graphPath(proj))).toBe(true);
  }, 30000);

  test("recursion twin: new-shape runtime compile -> no runtime-graph.json", () => {
    const proj = makeProject(true);
    // Even with a transition in the audit tail, the command-level recursion guard wins.
    mkdirSync(seededAuditDir(proj), { recursive: true });
    writeFileSync(pinnedShardPath(proj), TRANSITION_AUDIT, "utf-8");
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "aidlc runtime compile",
      },
    });
    const r = runHook(runtimeCompileHook(proj), proj, json);
    expect(r.status).toBe(0);
    expect(existsSync(graphPath(proj))).toBe(false);
  }, 30000);
});

describe("t131 spine self-gates to a no-op outside a workflow (mechanism cli — spawnSync)", () => {
  // No aidlc-state.md, no audit.md: every hook must exit 0 and write nothing.
  test("S1: outside a workflow -> audit-logger exits 0 (self-gate) [.sh test 13]", () => {
    const proj = makeProject(false);
    const json = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(proj, "aidlc-docs", "inception", "x.md") },
    });
    const r = runHook(auditLoggerHook(proj), proj, json);
    expect(r.status).toBe(0);
  }, 30000);

  test("S2: outside a workflow -> audit-logger writes no audit.md (no-op) [.sh test 14]", () => {
    const proj = makeProject(false);
    const json = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(proj, "aidlc-docs", "inception", "x.md") },
    });
    runHook(auditLoggerHook(proj), proj, json);
    // The "don't auto-create the audit trail" guard (hook :73) holds: no shard.
    expect(readAllAuditShards(proj)).toBe("");
  }, 30000);

  test("S3: outside a workflow -> runtime-compile exits 0 (self-gate) [.sh test 15]", () => {
    const proj = makeProject(false);
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          "bun .claude/tools/aidlc-state.ts approve --stage requirements-analysis",
      },
    });
    const r = runHook(runtimeCompileHook(proj), proj, json);
    expect(r.status).toBe(0);
  }, 30000);

  test("S4: outside a workflow -> runtime-compile writes no runtime-graph.json (no-op) [.sh test 16]", () => {
    const proj = makeProject(false);
    const json = JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command:
          "bun .claude/tools/aidlc-state.ts approve --stage requirements-analysis",
      },
    });
    runHook(runtimeCompileHook(proj), proj, json);
    // The audit-existence guard (hook :68) holds: no audit.md -> no graph.
    expect(existsSync(graphPath(proj))).toBe(false);
  }, 30000);
});

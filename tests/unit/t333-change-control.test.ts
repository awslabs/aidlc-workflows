// covers: function:resolveGuardPolicy, function:memoryGuardPolicyDeclarations,
// function:parseGuardPolicyStateLine, function:parseGuardPolicy,
// function:formatGuardPolicy, function:scopeGuardPolicyDefault,
// function:governedGuardPolicy, function:guardPolicyStateField,
// function:setGuardPolicyLine, function:guardPolicyMemoryStrictRefusal,
// function:noteGuardPolicyRename, function:fencesLoweredByPolicy,
// function:resolveFences, function:formatFence, function:parseGuardsOffLine,
// function:formatGuardsOffLine, function:setGuardsOffLine,
// function:recordSessionPresenceBypass, function:sessionPresenceBypassRecorded,
// function:fenceKeyBypassed,
// function:resolveChangeControl, function:memoryChangeControlDeclarations,
// function:parseChangeControlStateLine, function:parseChangeControl,
// function:formatChangeControl, function:scopeChangeControlDefault,
// function:governedChangeControl,
// function:memorySectionBody, function:structuredField,
// subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:config-get,
// subcommand:aidlc-utility:config-list, subcommand:aidlc-utility:status,
// subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:scope-change,
// subcommand:aidlc-orchestrate:next, audit:GUARD_POLICY_SET, audit:CHANGE_CONTROL_SET,
// audit:GUARD_DISABLED, audit:GUARD_RESTORED
// hook:aidlc-plan-approval-guard, hook:aidlc-session-start, hook:aidlc-record-human-turn,
// function:applyTypedGuardSwitchPrompt, audit:GUARD_STOOD_ASIDE
//
// t333 - Guard Policy (the setting formerly called Change Control) is one
// setting with three values: strict, relaxed, and off. The resolved value is
// the intent's own valid state line when present; a missing line stays strict
// for compatibility, then any memory layer that declares strict wins. The
// policy word lowers a fixed set of fences; a per-run switch lowers or raises
// one of four fences for one piece of work. These tests pin resolver precedence,
// scope defaults the maintainer decided, the memory grammar and its validation
// error, the source labels the human sees, the verb and flag surfaces, the
// GUARD_POLICY_SET / GUARD_DISABLED / GUARD_RESTORED rows, and the retired
// names (scope key, state line, memory heading, flag, config key, audit row)
// that are still read for one release and never written.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  CHANGE_CONTROL_FIELD,
  CHANGE_CONTROL_VALUES,
  fencesLoweredByPolicy,
  fenceSwitchSentence,
  formatChangeControl,
  formatFence,
  formatGuardPolicy,
  formatGuardsOffLine,
  getField,
  governedChangeControl,
  governedGuardPolicy,
  GUARD_FENCES,
  GUARD_POLICY_FIELD,
  GUARD_POLICY_RENAME_NOTICE,
  GUARD_POLICY_VALUES,
  GUARDS_OFF_FIELD,
  GUARDS_ON_FIELD,
  type GuardPolicyResolution,
  guardPolicyStateField,
  loadScopeMapping,
  memoryChangeControlDeclarations,
  memoryGuardPolicyDeclarations,
  memoryStrictHoldsGuardPolicy,
  memorySectionBody,
  parseChangeControl,
  parseChangeControlStateLine,
  parseGuardPolicy,
  parseGuardPolicyStateLine,
  parseGuardsOffLine,
  parseGuardsOnLine,
  readAuditShardEvents,
  resolveChangeControl,
  recordSessionPresenceBypass,
  resolveFences,
  resolveGuardPolicy,
  scopeChangeControlDefault,
  scopeGuardPolicyDefault,
  setField,
  setGuardPolicyLine,
  setGuardsOffLine,
  stateDigest,
  structuredField,
  writeActiveDirectiveMarker,
  writeCurrentSessionId,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const tempDirs: string[] = [];

/** The status lines, padded exactly as `status` prints them. */
const STATUS_POLICY = "Guard Policy:   ";
const STATUS_FENCES = "Fences:         ";
const ALL_FENCES_ON =
  "plan-approval on (default), review-freeze on (default), state-transition on (default), reviewer-scope on (default), human-presence on (default)";
const FENCE_SESSION = "t333-fence-session";
/** Every fence kill switch held at "0" so the test host's environment cannot lower a fence. */
const FENCE_ENV_CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_REVIEWER_SCOPE_HOOK: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: FENCE_SESSION,
  AIDLC_UNATTENDED: "0",
};

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function run(tool: string, args: string[], proj: string, env: NodeJS.ProcessEnv = {}) {
  const result = Bun.spawnSync({
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// The utility reports a refusal as one JSON line. Compare its decoded text: the
// encoding doubles Windows path backslashes, so raw stderr never matches there.
function refusalError(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).reverse().find((entry) => entry.startsWith("{"));
  return line ? (JSON.parse(line) as { error?: string }).error ?? stderr : stderr;
}

function recordHumanPrompt(proj: string, prompt: string, env: NodeJS.ProcessEnv = {}): string {
  const result = Bun.spawnSync({
    cmd: [BUN, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    cwd: proj,
    env: { ...process.env, ...FENCE_ENV_CLEAR, ...env, CLAUDE_PROJECT_DIR: proj },
    stdin: Buffer.from(JSON.stringify({
      hook_event_name: "UserPromptSubmit", cwd: proj, session_id: FENCE_SESSION, prompt,
    })),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

function utilityError(stderr: string): string {
  const parsed: unknown = JSON.parse(stderr);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("error" in parsed) ||
    typeof parsed.error !== "string"
  ) {
    throw new Error(`Expected a utility error envelope: ${stderr}`);
  }
  return parsed.error;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

/** A project with the shipped memory and one intent on `scope`. */
function project(scope: string, extra: string[] = []): { proj: string; state: string } {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  const created = run(
    UTILITY,
    [
      "intent-create",
      "--scope",
      scope,
      "--arguments",
      "guard policy fixture",
      "--label",
      "guard-policy",
      ...extra,
    ],
    proj,
  );
  expect(created.status, created.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const state = join(intents, active, "aidlc-state.md");
  expect(existsSync(state)).toBe(true);
  return { proj, state };
}

function memoryFile(proj: string, layer: "org" | "team" | "project"): string {
  return join(proj, "aidlc", "spaces", "default", "memory", `${layer}.md`);
}

/** Declare a Mode under the shipped `## Guard Policy` heading. */
function declareMemoryMode(proj: string, layer: "org" | "team" | "project", mode: string): void {
  const path = memoryFile(proj, layer);
  const content = readFileSync(path, "utf-8");
  expect(content).toContain("## Guard Policy\n");
  expect(content).not.toContain("## Change Control");
  writeFileSync(path, content.replace("## Guard Policy\n", `## Guard Policy\n\nMode: ${mode}\n`));
}

/** Append a section under the retired `## Change Control` heading, as an earlier release wrote it. */
function declareLegacyMemoryMode(proj: string, layer: "org" | "team" | "project", mode: string): void {
  const path = memoryFile(proj, layer);
  const content = readFileSync(path, "utf-8");
  writeFileSync(path, `${content.trimEnd()}\n\n## Change Control\n\nMode: ${mode}\n`);
}

function selectedProject(
  targetScope = "enterprise",
): { proj: string; defaultIntent: string; targetIntent: string; targetState: string } {
  const base = project("enterprise");
  const defaultIntent = readFileSync(
    join(base.proj, "aidlc", "spaces", "default", "intents", "active-intent"),
    "utf-8",
  ).trim();
  const createdSpace = run(UTILITY, ["space-create", "alt"], base.proj);
  expect(createdSpace.status, createdSpace.stderr).toBe(0);
  const switchedToAlt = run(UTILITY, ["space", "alt"], base.proj);
  expect(switchedToAlt.status, switchedToAlt.stderr).toBe(0);
  const createdTarget = run(
    UTILITY,
    [
      "intent-create",
      "--scope",
      targetScope,
      "--arguments",
      "selected guard policy fixture",
      "--label",
      "target",
    ],
    base.proj,
  );
  expect(createdTarget.status, createdTarget.stderr).toBe(0);
  const altIntents = join(base.proj, "aidlc", "spaces", "alt", "intents");
  const targetIntent = readFileSync(join(altIntents, "active-intent"), "utf-8").trim();
  const targetState = join(altIntents, targetIntent, "aidlc-state.md");
  const switchedToDefault = run(UTILITY, ["space", "default"], base.proj);
  expect(switchedToDefault.status, switchedToDefault.stderr).toBe(0);
  return { proj: base.proj, defaultIntent, targetIntent, targetState };
}

function selectedArgs(targetIntent: string): string[] {
  return ["--space", "alt", "--intent", targetIntent];
}

function altMemoryFile(proj: string): string {
  return join(proj, "aidlc", "spaces", "alt", "memory", "project.md");
}

/** space-create seeds a bare project.md with no sections, so the lock is appended. */
function declareAltMemoryStrict(proj: string): void {
  const path = altMemoryFile(proj);
  const content = readFileSync(path, "utf-8");
  expect(content).not.toContain("## Guard Policy");
  writeFileSync(path, `${content.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
}

function selectedRows(proj: string, intent: string, space: string, event: string) {
  return readAuditShardEvents(proj, intent, space).filter((entry) => entry.event === event);
}

function guardPolicyRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "GUARD_POLICY_SET");
}

function rowsOf(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === event);
}

/** How many times the one-line rename notice appears in a stream. */
function renameNotices(stream: string): number {
  return stream.split("\n").filter((line) => line === GUARD_POLICY_RENAME_NOTICE).length;
}

/** The frontmatter block of a shipped scope file. */
function scopeFrontmatter(scope: string): string {
  const body = readFileSync(join(AIDLC_SRC, "scopes", `aidlc-${scope}.md`), "utf-8");
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  expect(match, scope).not.toBeNull();
  return match![1];
}

describe("t333 (1) scope defaults", () => {
  const EXPECTED: Record<string, "strict" | "relaxed" | "off"> = {
    enterprise: "strict",
    "security-patch": "strict",
    workshop: "relaxed",
    infra: "strict",
    poc: "relaxed",
    express: "relaxed",
    classic: "relaxed",
    bugfix: "relaxed",
    feature: "relaxed",
    mvp: "relaxed",
    refactor: "relaxed",
  };

  test("every shipped scope declares the value the maintainer decided", () => {
    const mapping = loadScopeMapping();
    expect(Object.keys(mapping).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [scope, value] of Object.entries(EXPECTED)) {
      expect(mapping[scope]?.guardPolicy, scope).toBe(value);
      expect(scopeGuardPolicyDefault(scope), scope).toBe(value);
      expect(scopeChangeControlDefault(scope), scope).toBe(value);
    }
  });

  test("a scope without a guard_policy line, or an unknown scope, defaults to strict", () => {
    expect(scopeGuardPolicyDefault("no-such-scope")).toBe("strict");
    expect(scopeGuardPolicyDefault(null)).toBe("strict");
  });

  test("every scope file declares guard_policy and the three ceremony keys explicitly, under the new key only", () => {
    for (const scope of Object.keys(loadScopeMapping())) {
      const frontmatter = scopeFrontmatter(scope);
      expect(frontmatter, scope).toMatch(new RegExp(`^guard_policy: ${EXPECTED[scope]}$`, "m"));
      expect(frontmatter, scope).not.toMatch(/^change_control:/m);
      for (const key of ["sensors", "learnings", "summary_confirmation"]) {
        expect(frontmatter, `${scope} ${key}`).toMatch(new RegExp(`^${key}: (on|off)$`, "m"));
      }
    }
  });

  test("every scope file documents its value in prose, agreeing with its frontmatter", () => {
    const scopesDir = join(AIDLC_SRC, "scopes");
    for (const scope of Object.keys(loadScopeMapping())) {
      const body = readFileSync(join(scopesDir, `aidlc-${scope}.md`), "utf-8");
      // The prose may still carry the retired name for this release; the value
      // it names must be the frontmatter value.
      const prose = /(?:Guard Policy|Change Control) defaults to (strict|relaxed|off)/.exec(body);
      expect(prose, scope).not.toBeNull();
      expect(prose![1], scope).toBe(EXPECTED[scope]);
    }
  });
});

describe("t333 (2) the grammar", () => {
  test("the state line is read by value; the label after it is for humans", () => {
    expect(parseGuardPolicyStateLine("relaxed (from scope classic)")).toEqual({
      value: "relaxed",
      source: "scope classic",
    });
    expect(parseGuardPolicyStateLine("strict (from project.md)")).toEqual({
      value: "strict",
      source: "project.md",
    });
    expect(parseGuardPolicyStateLine("strict (set by you)")).toEqual({
      value: "strict",
      source: "you",
    });
    expect(parseGuardPolicyStateLine("off (set by you)")).toEqual({ value: "off", source: "you" });
    expect(parseGuardPolicyStateLine("Relaxed")).toEqual({ value: "relaxed", source: "you" });
    expect(parseGuardPolicyStateLine("sometimes (from scope poc)")).toBeNull();
    expect(parseGuardPolicyStateLine("offline (set by you)")).toBeNull();
    expect(parseGuardPolicyStateLine("")).toBeNull();
    expect(parseGuardPolicyStateLine(null)).toBeNull();
  });

  test("source labels render the shapes the status line shows", () => {
    expect(formatGuardPolicy("strict", "project.md")).toBe("strict (from project.md)");
    expect(formatGuardPolicy("relaxed", "scope classic")).toBe("relaxed (from scope classic)");
    expect(formatGuardPolicy("strict", "you")).toBe("strict (set by you)");
    expect(formatGuardPolicy("off", "you")).toBe("off (set by you)");
    expect(formatGuardPolicy("strict", "not set")).toBe("strict (not set)");
  });

  test("a Mode value is a closed list of three read through the Testing Posture field grammar", () => {
    expect(GUARD_POLICY_VALUES).toEqual(["strict", "relaxed", "off"]);
    expect(parseGuardPolicy("strict")).toBe("strict");
    expect(parseGuardPolicy("**Relaxed**")).toBe("relaxed");
    expect(parseGuardPolicy("`strict`")).toBe("strict");
    expect(parseGuardPolicy("OFF")).toBe("off");
    expect(parseGuardPolicy("loose")).toBeNull();
    expect(parseGuardPolicy("on")).toBeNull();
    expect(parseGuardPolicy(undefined)).toBeNull();
    expect(structuredField("- **Mode**: strict", "Mode")).toBe("strict");
    expect(structuredField("Mode: relaxed", "Mode")).toBe("relaxed");
    expect(structuredField("Methodology: tdd", "Mode")).toBeNull();
  });

  test("a field value continues on indented lines and stops at the next item", () => {
    const wrapped = [
      "- **Ordering**: tests first,",
      "  then implementation.",
      "- **Coverage**: 80%",
    ].join("\n");
    expect(structuredField(wrapped, "Ordering")).toBe("tests first, then implementation.");
    expect(structuredField(wrapped, "Coverage")).toBe("80%");
    // A blank line, an unindented line, or a nested bullet ends the value.
    expect(structuredField("Ordering: a first,\n\n  not the value", "Ordering")).toBe("a first,");
    expect(structuredField("Ordering: a first,\nnext paragraph", "Ordering")).toBe("a first,");
    expect(structuredField("- **Ordering**: a first,\n  - sub item", "Ordering")).toBe("a first,");
    // An empty head with an indented continuation still yields the value.
    expect(structuredField("Ordering:\n  tests first.", "Ordering")).toBe("tests first.");
  });

  // These layouts were already accepted before wrapped values were supported.
  // Nested notes, sibling fields, and new blocks are not part of the field;
  // only wrapped prose belongs to its value.
  test("a field value ends at the next item of any marker, a sibling field, or a block", () => {
    expect(structuredField("- **Ordering**: custom:\n  1. scenarios\n  2. implement", "Ordering")).toBe("custom:");
    expect(structuredField("- **Ordering**: a\n  + sub", "Ordering")).toBe("a");
    expect(structuredField("- **Ordering**: a\n  > quoted", "Ordering")).toBe("a");
    expect(structuredField("- **Ordering**: a\n  | x | y |", "Ordering")).toBe("a");
    expect(structuredField("- **Ordering**: a\n  ```\n  code\n  ```", "Ordering")).toBe("a");
    const plain = "  Methodology: tdd\n  Ordering: tests first.";
    expect(structuredField(plain, "Methodology")).toBe("tdd");
    expect(structuredField(plain, "Ordering")).toBe("tests first.");
    expect(structuredField("Methodology: tdd\n  Ordering: tests first.", "Methodology")).toBe("tdd");
    expect(structuredField("  - **Ordering**: long\n    wrapped", "Ordering")).toBe("long wrapped");
    expect(structuredField("- **Mode**: strict\n  1. Require reapproval when inputs move.", "Mode")).toBe("strict");
    // A sibling head is one of the structured fields, with or without a space after its colon; any other word: is prose.
    expect(structuredField("Methodology: tdd\n  Ordering:tests first.", "Methodology")).toBe("tdd");
    expect(structuredField("Methodology: tdd\n  Ordering:tests first.", "Ordering")).toBe("tests first.");
    expect(structuredField("- **Methodology**: tdd\n  **Ordering**:tests first.", "Methodology")).toBe("tdd");
    expect(structuredField("- **Ordering**: a,\n  then run https://x.y/z first", "Ordering")).toBe("a, then run https://x.y/z first");
    expect(structuredField("- **Ordering**: a,\n  then file://share/tests", "Ordering")).toBe("a, then file://share/tests");
    expect(structuredField("- **Ordering**: run the suite from\n  C:\\tests before implementation", "Ordering")).toBe("run the suite from C:\\tests before implementation");
    expect(structuredField("- **Ordering**: a,\n  use C:\\tests before implementation", "Ordering")).toBe("a, use C:\\tests before implementation");
    expect(structuredField("- **Ordering**: a,\n  issue:ABC-123 next, then implement", "Ordering")).toBe("a, issue:ABC-123 next, then implement");
    expect(structuredField("- **Ordering**: a,\n  at 10:00 run the suite", "Ordering")).toBe("a, at 10:00 run the suite");
    expect(structuredField("- **Ordering**: a,\n  Note: run them twice", "Ordering")).toBe("a, Note: run them twice");
  });

  test("the section body ignores commented headings and commented lines, under either heading", () => {
    for (const heading of ["## Guard Policy", "## Change Control"]) {
      const content = [
        "# Team",
        "",
        `<!-- ${heading} -->`,
        "## Testing Posture",
        "",
        "Methodology: tdd",
        "",
        heading,
        "",
        "<!-- Mode: strict -->",
        "Mode: relaxed",
        "",
        "## Deployment",
        "",
        "Mode: strict",
      ].join("\n");
      const body = memorySectionBody(content, heading);
      expect(structuredField(body, "Mode"), heading).toBe("relaxed");
      expect(body, heading).not.toContain("Deployment");
    }
  });

  test("the retired names are the same functions and the same three values", () => {
    expect(resolveChangeControl).toBe(resolveGuardPolicy);
    expect(memoryChangeControlDeclarations).toBe(memoryGuardPolicyDeclarations);
    expect(parseChangeControlStateLine).toBe(parseGuardPolicyStateLine);
    expect(parseChangeControl).toBe(parseGuardPolicy);
    expect(formatChangeControl).toBe(formatGuardPolicy);
    expect(scopeChangeControlDefault).toBe(scopeGuardPolicyDefault);
    expect(governedChangeControl).toBe(governedGuardPolicy);
    expect(CHANGE_CONTROL_VALUES).toEqual(["strict", "relaxed", "off"]);
    expect(GUARD_POLICY_FIELD).toBe("Guard Policy");
    expect(CHANGE_CONTROL_FIELD).toBe("Change Control");
  });

  test("the Guards Off line lists lowered fences in canonical order; none or an absent line is empty", () => {
    expect(parseGuardsOffLine(null)).toEqual([]);
    expect(parseGuardsOffLine("none")).toEqual([]);
    expect(parseGuardsOffLine("review-freeze, plan-approval (set by you)")).toEqual([
      "review-freeze",
      "plan-approval",
    ]);
    expect(parseGuardsOffLine("plan-approval, human-presence, nonsense, plan-approval")).toEqual(["plan-approval"]);
    expect(parseGuardsOnLine("human-presence, review-freeze, nonsense (set by you)")).toEqual(["review-freeze"]);
    expect(formatGuardsOffLine([])).toBe("none");
    expect(formatGuardsOffLine(["review-freeze", "plan-approval"])).toBe(
      "plan-approval, review-freeze (set by you)",
    );
    const state = "- **Scope**: classic\n- **Guard Policy**: relaxed (from scope classic)\n";
    const lowered = setGuardsOffLine(state, ["review-freeze"]);
    expect(lowered).toBe(
      "- **Scope**: classic\n- **Guard Policy**: relaxed (from scope classic)\n- **Guards Off**: review-freeze (set by you)\n",
    );
    expect(setGuardsOffLine(lowered, [])).toContain(`- **${GUARDS_OFF_FIELD}**: none\n`);
  });

  test("the policy line is written under its new name; a retired line is renamed in place, never duplicated", () => {
    const legacy = "- **Scope**: classic\n- **Change Control**: relaxed (from scope classic)\n- **Sensors**: on (from scope classic)\n";
    expect(guardPolicyStateField(legacy)).toBe(CHANGE_CONTROL_FIELD);
    const renamed = setGuardPolicyLine(legacy, "strict (set by you)");
    expect(renamed).toBe(
      "- **Scope**: classic\n- **Guard Policy**: strict (set by you)\n- **Sensors**: on (from scope classic)\n",
    );
    expect(guardPolicyStateField(renamed)).toBe(GUARD_POLICY_FIELD);
    expect(getField(renamed, CHANGE_CONTROL_FIELD)).toBeNull();
    const lineless = "- **Scope**: classic\n- **Test Strategy**: Standard\n";
    expect(guardPolicyStateField(lineless)).toBeNull();
    expect(setGuardPolicyLine(lineless, "off (set by you)")).toBe(
      "- **Scope**: classic\n- **Test Strategy**: Standard\n- **Guard Policy**: off (set by you)\n",
    );
  });
});

describe("t333 (3) resolution precedence", () => {
  test("a fresh intent carries the scope default with its source", () => {
    const { proj, state } = project("classic");
    const content = readFileSync(state, "utf-8");
    expect(getField(content, GUARD_POLICY_FIELD)).toBe("relaxed (from scope classic)");
    expect(getField(content, CHANGE_CONTROL_FIELD)).toBeNull();
    const resolved = resolveGuardPolicy(proj);
    expect(resolved.value).toBe("relaxed");
    expect(resolved.source).toBe("scope classic");
    expect(resolved.stateField).toBe(GUARD_POLICY_FIELD);
    expect(resolved.memoryStrict).toBeNull();
  });

  test("the intent line wins over the scope default, for every value", () => {
    for (const value of ["relaxed", "off"] as const) {
      const { proj, state } = project("enterprise");
      expect(resolveGuardPolicy(proj).value).toBe("strict");
      writeFileSync(
        state,
        setField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD, `${value} (set by you)`),
      );
      const resolved = resolveGuardPolicy(proj);
      expect(resolved.value).toBe(value);
      expect(resolved.source).toBe("you");
      expect(resolved.scopeDefault).toBe("strict");
    }
  });

  test("a retired Change Control state line is read under its old name until the next write", () => {
    const { proj, state } = project("classic");
    const legacy = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:/m,
      "- **Change Control**:",
    );
    writeFileSync(state, legacy);
    expect(getField(legacy, GUARD_POLICY_FIELD)).toBeNull();
    expect(getField(legacy, CHANGE_CONTROL_FIELD)).toBe("relaxed (from scope classic)");
    const resolved = resolveGuardPolicy(proj);
    expect(resolved.value).toBe("relaxed");
    expect(resolved.source).toBe("scope classic");
    expect(resolved.stateField).toBe(CHANGE_CONTROL_FIELD);
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}relaxed (from scope classic)\n`);
    // Reading never rewrites the record.
    expect(readFileSync(state, "utf-8")).toBe(legacy);
    expect(guardPolicyRows(proj)).toHaveLength(0);
  });

  test("a record carrying both lines resolves strict when they disagree and the new one when they agree", () => {
    const { proj, state } = project("classic");
    const disagreeing = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: strict (set by you)\n- **Guard Policy**: off (set by you)",
    );
    writeFileSync(state, disagreeing);
    const conflicted = resolveGuardPolicy(proj);
    expect(conflicted.value).toBe("strict");
    expect(conflicted.source).toBe("conflicting state lines");
    expect(conflicted.stateField).toBe(GUARD_POLICY_FIELD);
    expect(conflicted.conflict).toEqual({
      guardPolicy: "off (set by you)",
      changeControl: "strict (set by you)",
    });
    writeFileSync(state, disagreeing.replace("Change Control**: strict", "Change Control**: off"));
    const agreeing = resolveGuardPolicy(proj);
    expect(agreeing.value).toBe("off");
    expect(agreeing.conflict).toBeUndefined();
    expect(agreeing.stateField).toBe(GUARD_POLICY_FIELD);
  });

  test("memory strict beats both, from any layer, and names its file and section", () => {
    for (const layer of ["org", "team", "project"] as const) {
      const { proj } = project("poc");
      declareMemoryMode(proj, layer, "strict");
      const resolved = resolveGuardPolicy(proj);
      expect(resolved.value).toBe("strict");
      expect(resolved.source).toBe(`${layer}.md`);
      expect(resolved.memoryStrict?.path).toBe(memoryFile(proj, layer));
      expect(resolved.memoryStrict?.heading).toBe("## Guard Policy");
      expect(resolved.intent?.value).toBe("relaxed");
    }
  });

  test("a Mode line followed by a nested list still declares its value", () => {
    const { proj } = project("classic");
    declareMemoryMode(proj, "team", "strict\n  + Strict here holds for every intent.");
    expect(memoryChangeControlDeclarations(proj)).toEqual([
      { layer: "team", path: memoryFile(proj, "team"), heading: "## Guard Policy", value: "strict" },
    ]);
    expect(resolveChangeControl(proj).value).toBe("strict");
  });

  test("a retired Change Control memory section still locks the value and names its section", () => {
    const { proj, state } = project("poc");
    declareLegacyMemoryMode(proj, "team", "strict");
    expect(memoryGuardPolicyDeclarations(proj)).toEqual([
      { layer: "team", path: memoryFile(proj, "team"), heading: "## Change Control", value: "strict" },
    ]);
    const resolved = resolveGuardPolicy(proj);
    expect(resolved.value).toBe("strict");
    expect(resolved.source).toBe("team.md");
    expect(resolved.memoryStrict?.heading).toBe("## Change Control");
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, ["config-change", "--guard-policy", "relaxed"], proj);
    expect(refused.status).toBe(1);
    expect(refusalError(refused.stderr)).toContain(
      `Guard Policy is set to strict in ${memoryFile(proj, "team")} (section: Change Control), so it cannot be changed from chat.`,
    );
    expect(readFileSync(state, "utf-8")).toBe(before);
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (from team.md)\n`);
  });

  test("the new heading is read first when a file carries both sections", () => {
    const { proj } = project("poc");
    declareMemoryMode(proj, "project", "relaxed");
    declareLegacyMemoryMode(proj, "project", "strict");
    expect(memoryGuardPolicyDeclarations(proj)).toEqual([
      { layer: "project", path: memoryFile(proj, "project"), heading: "## Guard Policy", value: "relaxed" },
    ]);
    expect(resolveGuardPolicy(proj).value).toBe("relaxed");
  });

  test("memory relaxed or off and an absent section have no effect", () => {
    for (const mode of ["relaxed", "off"] as const) {
      const { proj } = project("enterprise");
      declareMemoryMode(proj, "project", mode);
      expect(memoryGuardPolicyDeclarations(proj)).toEqual([
        { layer: "project", path: memoryFile(proj, "project"), heading: "## Guard Policy", value: mode },
      ]);
      expect(resolveGuardPolicy(proj).value).toBe("strict");
      expect(resolveGuardPolicy(proj).source).toBe("scope enterprise");
    }
  });

  test("an invalid memory value is a validation error naming the file, the section, and the allowed values", () => {
    const { proj } = project("classic");
    declareMemoryMode(proj, "team", "sometimes");
    expect(() => resolveGuardPolicy(proj)).toThrow(
      `Invalid Guard Policy Mode "sometimes" in ${memoryFile(proj, "team")} (section: Guard Policy). Expected one of: strict, relaxed, off.`,
    );
    const legacy = project("classic");
    declareLegacyMemoryMode(legacy.proj, "org", "sometimes");
    expect(() => resolveGuardPolicy(legacy.proj)).toThrow(
      `Invalid Change Control Mode "sometimes" in ${memoryFile(legacy.proj, "org")} (section: Change Control). Expected one of: strict, relaxed, off.`,
    );
  });

  test("an unreadable memory policy withholds the fence switch instead of failing open", () => {
    const { proj, state } = project("enterprise");
    const content = readFileSync(state, "utf-8");
    expect(memoryStrictHoldsGuardPolicy(proj, content)).toBe(false);
    expect(fenceSwitchSentence(proj, "plan-approval", content)).toContain("config set guard.plan-approval off");
    const memory = memoryFile(proj, "project");
    rmSync(memory);
    mkdirSync(memory);
    expect(memoryStrictHoldsGuardPolicy(proj, content)).toBe(true);
    const sentence = fenceSwitchSentence(proj, "plan-approval", content);
    expect(sentence).toContain("cannot be turned off from chat");
    expect(sentence).not.toContain("config set guard.plan-approval off");
  });

  test("a state file without the line stays strict for intents created before the setting", () => {
    const { proj, state } = project("classic");
    const content = readFileSync(state, "utf-8").replace(/^- \*\*Guard Policy\*\*:.*\n/m, "");
    expect(getField(content, GUARD_POLICY_FIELD)).toBeNull();
    writeFileSync(state, content);
    const resolved = resolveGuardPolicy(proj);
    expect(resolved.value).toBe("strict");
    expect(resolved.source).toBe("not set");
    expect(resolved.stateValue).toBe("strict");
    expect(resolved.stateField).toBeNull();
    expect(resolved.intent).toBeNull();
  });

  test("an invalid state line refuses resolution while status preserves the invalid state", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      setField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD, "stricct (set by you)"),
    );
    const before = readFileSync(state, "utf-8");
    expect(() => resolveGuardPolicy(proj)).toThrow(
      `Invalid Guard Policy "stricct (set by you)" in ${state} (field: Guard Policy). Expected one of: strict, relaxed, off. Run /aidlc --guard-policy strict, relaxed, or off to repair it.`,
    );
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}unavailable (Invalid Guard Policy "stricct (set by you)" in ${state} (field: Guard Policy)`);
    expect(status.stdout).toContain(`${STATUS_FENCES}unavailable\n`);
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(guardPolicyRows(proj)).toHaveLength(0);
  });

  test("an invalid retired state line names the retired field", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      readFileSync(state, "utf-8").replace(
        /^- \*\*Guard Policy\*\*:.*$/m,
        "- **Change Control**: stricct (set by you)",
      ),
    );
    expect(() => resolveGuardPolicy(proj)).toThrow(
      `Invalid Guard Policy "stricct (set by you)" in ${state} (field: Change Control). Expected one of: strict, relaxed, off.`,
    );
  });
});

describe("t333 (4) config-change, the slash flag, and the status line", () => {
  test("config-change rewrites the line, records GUARD_POLICY_SET, and status shows the human as the source", () => {
    const { proj, state } = project("classic");
    const flipped = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj);
    expect(flipped.status, flipped.stderr).toBe(0);
    expect(flipped.stdout).toContain("Guard Policy changed: relaxed (from scope classic) to strict (set by you)");
    expect(renameNotices(flipped.stderr)).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
    expect(rowsOf(proj, "CHANGE_CONTROL_SET")).toHaveLength(0);
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (set by you)\n`);
    expect(status.stdout).not.toContain("Change Control:");
    const beforeRepeat = readFileSync(state, "utf-8");
    const again = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Guard Policy is already strict (set by you)");
    expect(readFileSync(state, "utf-8")).toBe(beforeRepeat);
    expect(guardPolicyRows(proj)).toHaveLength(1);
  });

  test("off is a first-class value end to end: state line, row, status, config get and list", () => {
    const { proj, state } = project("classic");
    recordHumanPrompt(proj, "/aidlc --guard-policy off");
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("off (set by you)");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("off");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
    const unchanged = run(UTILITY, ["config-change", "--guard-policy", "off"], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("Guard Policy is already off (set by you)");
    expect(guardPolicyRows(proj)).toEqual(rows);
    expect(resolveGuardPolicy(proj).value).toBe("off");
    const status = run(UTILITY, ["status"], proj, FENCE_ENV_CLEAR);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}off (set by you)\n`);
    expect(status.stdout).toContain(
      `${STATUS_FENCES}plan-approval off (guard policy off (set by you)), review-freeze off (guard policy off (set by you)), state-transition off (guard policy off (set by you)), reviewer-scope off (guard policy off (set by you)), human-presence on (default)\n`,
    );
    expect(run(UTILITY, ["config-get", "guard-policy"], proj, FENCE_ENV_CLEAR).stdout).toBe("off (set by you)\n");
    const listed = run(UTILITY, ["config-list", "--json"], proj, FENCE_ENV_CLEAR);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      "guard-policy": "off (set by you)",
      "guard.plan-approval": "off (guard policy off (set by you))",
      "guard.state-transition": "off (guard policy off (set by you))",
    });
    expect(JSON.parse(listed.stdout)).not.toHaveProperty("guard.human-presence");
    expect(run(UTILITY, ["config-get", "guard.human-presence"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (default)\n");
    // Back to strict: the row records the move from off.
    const restored = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj);
    expect(restored.status, restored.stderr).toBe(0);
    const after = guardPolicyRows(proj);
    expect(after).toHaveLength(2);
    expect(auditBlockField(after[1].block, "Old Value")).toBe("off");
    expect(auditBlockField(after[1].block, "New Value")).toBe("strict");
  });

  test("config-change repairs an invalid state line and records its old text", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      setField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD, "stricct (set by you)"),
    );
    const repaired = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj);
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("stricct (set by you)");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });

  test("config-change refuses invalid or missing Guard Policy values without changing state or settings audit", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    for (const args of [["--guard-policy", "loose"], ["--guard-policy"], ["--guard-policy", "on"], []]) {
      const refused = run(UTILITY, ["config-change", ...args], proj);
      expect(refused.status, args.join(" ")).toBe(1);
      expect(readFileSync(state, "utf-8")).toBe(before);
      expect(guardPolicyRows(proj)).toHaveLength(0);
    }
    const loose = run(UTILITY, ["config-change", "--guard-policy", "loose"], proj);
    expect(loose.stderr).toContain('Unknown Guard Policy value: \\"loose\\". Valid: strict, relaxed, off.');
  });

  test("memory strict refuses a relaxed or off change and leaves the line alone", () => {
    for (const value of ["relaxed", "off"] as const) {
      const { proj, state } = project("classic");
      declareMemoryMode(proj, "project", "strict");
      const before = readFileSync(state, "utf-8");
      const refused = run(UTILITY, ["config-change", "--guard-policy", value], proj);
      expect(refused.status, value).toBe(1);
      expect(refusalError(refused.stderr)).toContain(
        `Guard Policy is set to strict in ${memoryFile(proj, "project")} (section: Guard Policy), so it cannot be changed from chat. Edit that line to change it for everyone on this repo.`,
      );
      expect(resolveGuardPolicy(proj).value).toBe("strict");
      expect(readFileSync(state, "utf-8")).toBe(before);
      expect(guardPolicyRows(proj)).toHaveLength(0);
      const status = run(UTILITY, ["status"], proj);
      expect(status.stdout).toContain(`${STATUS_POLICY}strict (from project.md)\n`);
    }
  });

  test("the status line shows the scope as the source until someone changes it", () => {
    const { proj } = project("poc");
    const status = run(UTILITY, ["status"], proj, FENCE_ENV_CLEAR);
    expect(status.stdout).toContain(`${STATUS_POLICY}relaxed (from scope poc)\n`);
    expect(status.stdout).toContain(
      `${STATUS_FENCES}plan-approval off (guard policy relaxed (from scope poc)), review-freeze off (guard policy relaxed (from scope poc)), state-transition on (default), reviewer-scope on (default), human-presence on (default)\n`,
    );
    const strict = project("enterprise");
    const strictStatus = run(UTILITY, ["status"], strict.proj, FENCE_ENV_CLEAR);
    expect(strictStatus.stdout).toContain(`${STATUS_POLICY}strict (from scope enterprise)\n`);
    expect(strictStatus.stdout).toContain(`${STATUS_FENCES}${ALL_FENCES_ON}\n`);
  });

  /** The last JSON line `next` printed, narrowed to the two fields these tests read. */
  function lastDirective(stdout: string): { kind: string; message: string } {
    const parsed: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("kind" in parsed) ||
      typeof parsed.kind !== "string" ||
      !("message" in parsed) ||
      typeof parsed.message !== "string"
    ) {
      throw new Error(`not a print or error directive: ${stdout}`);
    }
    return { kind: parsed.kind, message: parsed.message };
  }

  test("the slash flag routes to config set and refuses bad or missing values without mutation", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    const routed = run(ORCHESTRATE, ["next", "--guard-policy", "strict"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    const directive = lastDirective(routed.stdout);
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("engine config set guard-policy strict");
    expect(directive.message).not.toContain("change-control");
    expect(renameNotices(routed.stderr)).toBe(0);
    const off = lastDirective(run(ORCHESTRATE, ["next", "--guard-policy", "off"], proj).stdout);
    expect(off.kind).toBe("print");
    expect(off.message).toContain("engine config set guard-policy off");
    const bad = lastDirective(run(ORCHESTRATE, ["next", "--guard-policy", "maybe"], proj).stdout);
    expect(bad.kind).toBe("error");
    expect(bad.message).toContain('--guard-policy requires <strict|relaxed|off>; received "maybe".');
    const bare = lastDirective(run(ORCHESTRATE, ["next", "--guard-policy"], proj).stdout);
    expect(bare.kind).toBe("error");
    expect(bare.message).toContain("--guard-policy requires <strict|relaxed|off>.");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(guardPolicyRows(proj)).toHaveLength(0);
  });

  test("the retired --change-control flag still routes, prints the one-line notice once, and is never echoed", () => {
    const { proj, state } = project("classic");
    const routed = run(ORCHESTRATE, ["next", "--change-control", "strict"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    const directive = lastDirective(routed.stdout);
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("engine config set guard-policy strict");
    expect(directive.message).not.toContain("change-control");
    expect(renameNotices(routed.stderr)).toBe(1);

    const flipped = run(UTILITY, ["config-change", "--change-control", "strict"], proj);
    expect(flipped.status, flipped.stderr).toBe(0);
    expect(renameNotices(flipped.stderr)).toBe(1);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    expect(getField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD)).toBeNull();
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(rowsOf(proj, "CHANGE_CONTROL_SET")).toHaveLength(0);

    const read = run(UTILITY, ["config-get", "change-control"], proj);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe("strict (set by you)\n");
    expect(renameNotices(read.stderr)).toBe(1);
    // The new key prints no notice, and the list carries only the new key.
    const current = run(UTILITY, ["config-get", "guard-policy"], proj);
    expect(current.stdout).toBe("strict (set by you)\n");
    expect(renameNotices(current.stderr)).toBe(0);
    const listed = run(UTILITY, ["config-list", "--json"], proj);
    expect(Object.keys(JSON.parse(listed.stdout))).toContain("guard-policy");
    expect(Object.keys(JSON.parse(listed.stdout))).not.toContain("change-control");
    expect(renameNotices(listed.stderr)).toBe(0);
  });

  test("passing --change-control and --guard-policy with different values is refused before any write", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, ["config-change", "--change-control", "strict", "--guard-policy", "relaxed"], proj);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--change-control is the retired name of --guard-policy; pass one of them, not both.");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(guardPolicyRows(proj)).toHaveLength(0);
    const agreed = run(UTILITY, ["config-change", "--change-control", "strict", "--guard-policy", "strict"], proj);
    expect(agreed.status, agreed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    expect(guardPolicyRows(proj)).toHaveLength(1);
  });

  test("the flag at creation writes the human as the source, under either spelling", () => {
    const { state } = project("classic", ["--guard-policy", "strict"]);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");

    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const retired = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "x", "--label", "retired", "--change-control", "strict"],
      proj,
    );
    expect(retired.status, retired.stderr).toBe(0);
    expect(renameNotices(retired.stderr)).toBe(1);
    expect(getField(readFileSync(project_state(proj), "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    const both = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "y", "--label", "both", "--change-control", "strict", "--guard-policy", "off"],
      proj,
    );
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("--change-control is the retired name of --guard-policy; pass one of them, not both.");
  });

  function project_state(proj: string): string {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    return join(intents, active, "aidlc-state.md");
  }

  test("the flag at creation cannot relax or switch off a memory strict", () => {
    for (const value of ["relaxed", "off"] as const) {
      const proj = createTestProject();
      tempDirs.push(proj);
      seedAidlcMemory(proj);
      declareMemoryMode(proj, "org", "strict");
      const refused = run(
        UTILITY,
        ["intent-create", "--scope", "classic", "--arguments", "x", "--guard-policy", value],
        proj,
      );
      expect(refused.status, value).toBe(1);
      expect(refusalError(refused.stderr)).toContain(
        `Guard Policy is set to strict in ${memoryFile(proj, "org")} (section: Guard Policy)`,
      );
      const created = run(
        UTILITY,
        ["intent-create", "--scope", "classic", "--arguments", "x", "--label", "mem"],
        proj,
      );
      expect(created.status, created.stderr).toBe(0);
      expect(resolveGuardPolicy(proj).source).toBe("org.md");
      const status = run(UTILITY, ["status"], proj);
      expect(status.stdout).toContain(`${STATUS_POLICY}strict (from org.md)\n`);
    }
  });

  test("a scope change carries a scope-supplied value to the new default and keeps a human's value", () => {
    const followed = project("classic");
    const changed = run(UTILITY, ["scope-change", "--scope", "enterprise"], followed.proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(followed.state, "utf-8"), GUARD_POLICY_FIELD)).toBe(
      "strict (from scope enterprise)",
    );
    const rows = guardPolicyRows(followed.proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope enterprise");

    const kept = project("classic");
    recordHumanPrompt(kept.proj, "/aidlc --guard-policy relaxed");
    const keptRows = guardPolicyRows(kept.proj);
    const keptChange = run(UTILITY, ["scope-change", "--scope", "enterprise"], kept.proj);
    expect(keptChange.status, keptChange.stderr).toBe(0);
    expect(getField(readFileSync(kept.state, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(guardPolicyRows(kept.proj)).toEqual(keptRows);

    const retired = project("classic");
    recordHumanPrompt(retired.proj, "/aidlc --guard-policy off");
    const retiredChange = run(UTILITY, ["scope-change", "--scope", "enterprise", "--change-control", "off"], retired.proj);
    expect(retiredChange.status, retiredChange.stderr).toBe(0);
    expect(renameNotices(retiredChange.stderr)).toBe(1);
    expect(getField(readFileSync(retired.state, "utf-8"), GUARD_POLICY_FIELD)).toBe("off (set by you)");
  });

  test("creation accepts its scope default, while scope-change lowering requires a typed switch", () => {
    // Creation: the flag names what the scope would have given anyway.
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const created = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "x", "--label", "own", "--guard-policy", "relaxed"],
      proj,
    );
    expect(created.status, created.stderr).toBe(0);
    expect(getField(readFileSync(project_state(proj), "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (from scope classic)");
    const lower = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "y", "--label", "lower", "--guard-policy", "off"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(lower.status).toBe(1);

    // Scope change: naming the new scope's lower default is still a lowering.
    const raised = project("enterprise");
    writeFileSync(
      raised.state,
      setGuardPolicyLine(readFileSync(raised.state, "utf-8"), "strict (set by you)"),
    );
    const refused = run(UTILITY, ["scope-change", "--scope", "classic", "--guard-policy", "off"], raised.proj, FENCE_ENV_CLEAR);
    expect(refused.status).toBe(1);
    expect(getField(readFileSync(raised.state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    const defaultRefused = run(
      UTILITY,
      ["scope-change", "--scope", "classic", "--guard-policy", "relaxed"],
      raised.proj,
      FENCE_ENV_CLEAR,
    );
    expect(defaultRefused.status).toBe(1);
    expect(getField(readFileSync(raised.state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    recordHumanPrompt(raised.proj, "/aidlc --guard-policy relaxed");
    const taken = run(UTILITY, ["scope-change", "--scope", "classic", "--guard-policy", "relaxed"], raised.proj);
    expect(taken.status, taken.stderr).toBe(0);
    expect(getField(readFileSync(raised.state, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    const rows = guardPolicyRows(raised.proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });

  test("a scope change renames a retired state line in place while following the new scope", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      readFileSync(state, "utf-8").replace(/^- \*\*Guard Policy\*\*:/m, "- **Change Control**:"),
    );
    const changed = run(UTILITY, ["scope-change", "--scope", "enterprise"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    const after = readFileSync(state, "utf-8");
    expect(getField(after, GUARD_POLICY_FIELD)).toBe("strict (from scope enterprise)");
    expect(getField(after, CHANGE_CONTROL_FIELD)).toBeNull();
    expect(after.match(/^- \*\*(Guard Policy|Change Control)\*\*:/gm)).toHaveLength(1);
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
  });

  test("a scope-owned Guard Policy value follows the new scope under memory strict", () => {
    const { proj, state } = project("classic");
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (from scope classic)");
    const memory = memoryFile(proj, "project");
    const beforeMemory = readFileSync(memory, "utf-8");
    declareMemoryMode(proj, "project", "strict");
    const changed = run(UTILITY, ["scope-change", "--scope", "enterprise"], proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (from scope enterprise)");
    const governed = resolveGuardPolicy(proj);
    expect(governed.value).toBe("strict");
    expect(governed.source).toBe("project.md");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope enterprise");

    writeFileSync(memory, beforeMemory);
    const ungoverned = resolveGuardPolicy(proj);
    expect(ungoverned.value).toBe("strict");
    expect(ungoverned.source).toBe("scope enterprise");
  });

  test("a scope change commits its state and audit rows together", () => {
    const moved = project("classic");
    const beforeFault = readFileSync(moved.state, "utf-8");
    const failed = run(
      UTILITY,
      ["scope-change", "--scope", "enterprise"],
      moved.proj,
      { AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT: "t333" },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("injected ledger fault: t333");
    expect(readFileSync(moved.state, "utf-8")).toBe(beforeFault);
    expect(rowsOf(moved.proj, "SCOPE_CHANGED")).toHaveLength(0);
    expect(guardPolicyRows(moved.proj)).toHaveLength(0);

    const changed = run(UTILITY, ["scope-change", "--scope", "enterprise"], moved.proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(moved.state, "utf-8"), "Scope")).toBe("enterprise");
    expect(rowsOf(moved.proj, "SCOPE_CHANGED")).toHaveLength(1);
    const rows = guardPolicyRows(moved.proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope enterprise");
  });

  test("a lineless legacy intent stays strict across a scope change without a change row", () => {
    const legacy = project("enterprise");
    const withoutLine = readFileSync(legacy.state, "utf-8").replace(/^- \*\*Guard Policy\*\*:.*\n/m, "");
    writeFileSync(legacy.state, withoutLine);
    const changed = run(UTILITY, ["scope-change", "--scope", "classic"], legacy.proj);
    expect(changed.status, changed.stderr).toBe(0);
    const after = readFileSync(legacy.state, "utf-8");
    expect(getField(after, "Scope")).toBe("classic");
    expect(getField(after, GUARD_POLICY_FIELD)).toBeNull();
    expect(getField(after, CHANGE_CONTROL_FIELD)).toBeNull();
    expect(resolveGuardPolicy(legacy.proj).value).toBe("strict");
    expect(guardPolicyRows(legacy.proj)).toHaveLength(0);
  });

  test("scope-change refuses an invalid state line without writing state or audit", () => {
    const invalid = project("enterprise");
    writeFileSync(
      invalid.state,
      setField(readFileSync(invalid.state, "utf-8"), GUARD_POLICY_FIELD, "stricct (set by you)"),
    );
    const before = readFileSync(invalid.state, "utf-8");
    const refused = run(UTILITY, ["scope-change", "--scope", "classic"], invalid.proj);
    expect(refused.status).toBe(1);
    expect(utilityError(refused.stderr)).toContain(
      `Invalid Guard Policy "stricct (set by you)" in ${invalid.state} (field: Guard Policy). Expected one of: strict, relaxed, off. Run /aidlc --guard-policy strict, relaxed, or off to repair it.`,
    );
    expect(readFileSync(invalid.state, "utf-8")).toBe(before);
    expect(rowsOf(invalid.proj, "SCOPE_CHANGED")).toHaveLength(0);
    expect(guardPolicyRows(invalid.proj)).toHaveLength(0);
  });
});

describe("t333 (5) an explicit workflow selection governs Guard Policy end to end", () => {
  test("a selected space's memory strict refuses a relaxed change and logs only to that intent", () => {
    const selected = selectedProject();
    declareAltMemoryStrict(selected.proj);
    const beforeState = readFileSync(selected.targetState, "utf-8");
    const beforeDefault = readAuditShardEvents(selected.proj, selected.defaultIntent, "default");
    const beforeTarget = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");

    const refused = run(
      UTILITY,
      ["config-change", "--guard-policy", "relaxed", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(refused.status).not.toBe(0);
    expect(utilityError(refused.stderr)).toContain(altMemoryFile(selected.proj));
    expect(readFileSync(selected.targetState, "utf-8")).toBe(beforeState);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(beforeDefault);
    const targetAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    expect(targetAfter).toHaveLength(beforeTarget.length + 1);
    const refusalRow = targetAfter[targetAfter.length - 1];
    expect(refusalRow.event).toBe("ERROR_LOGGED");
    expect(auditBlockField(refusalRow.block, "Error")?.replaceAll("\\", "/")).toContain(
      "<project-dir>/aidlc/spaces/alt/memory/project.md",
    );
    expect(targetAfter.filter((row) => row.event === "GUARD_POLICY_SET")).toHaveLength(0);
  });

  test("a selected relaxed change updates and audits only the selected intent", () => {
    const selected = selectedProject();
    const defaultBefore = selectedRows(selected.proj, selected.defaultIntent, "default", "GUARD_POLICY_SET");
    recordHumanPrompt(
      selected.proj,
      `/aidlc --guard-policy relaxed --intent ${selected.targetIntent} --space alt`,
    );

    const changed = run(
      UTILITY,
      ["config-change", "--guard-policy", "relaxed", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(selected.targetState, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "GUARD_POLICY_SET")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "GUARD_POLICY_SET")).toEqual(defaultBefore);
  });

  test("a selected scope change preserves strict and writes only its scope row", () => {
    const selected = selectedProject();

    const changed = run(
      UTILITY,
      ["scope-change", "--scope", "classic", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "GUARD_POLICY_SET")).toHaveLength(0);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "SCOPE_CHANGED")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "GUARD_POLICY_SET")).toHaveLength(0);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "SCOPE_CHANGED")).toHaveLength(0);
  });

  test("a selected scope change preserves its stored strict value under memory strict", () => {
    const selected = selectedProject();
    declareAltMemoryStrict(selected.proj);

    const changed = run(
      UTILITY,
      ["scope-change", "--scope", "classic", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    const resolution = resolveGuardPolicy(selected.proj, null, {
      selection: { intent: selected.targetIntent, space: "alt" },
    });
    expect(resolution.value).toBe("strict");
    expect(resolution.source).toBe("project.md");
    expect(getField(readFileSync(selected.targetState, "utf-8"), GUARD_POLICY_FIELD)).toBe(
      "strict (from scope enterprise)",
    );
    const rows = selectedRows(selected.proj, selected.targetIntent, "alt", "GUARD_POLICY_SET");
    expect(rows).toHaveLength(0);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "SCOPE_CHANGED")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "SCOPE_CHANGED")).toHaveLength(0);
  });

  test("status reports the selected intent's value and source", () => {
    const selected = selectedProject("classic");

    const status = run(UTILITY, ["status", ...selectedArgs(selected.targetIntent)], selected.proj);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}relaxed (from scope classic)\n`);
    expect(status.stdout).not.toContain(`${STATUS_POLICY}strict (from scope enterprise)\n`);
  });

  test("a selected invalid state line names the selected state file", () => {
    const selected = selectedProject("classic");
    writeFileSync(
      selected.targetState,
      setField(readFileSync(selected.targetState, "utf-8"), GUARD_POLICY_FIELD, "stricct (set by you)"),
    );

    const status = run(UTILITY, ["status", ...selectedArgs(selected.targetIntent)], selected.proj);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Invalid Guard Policy "stricct (set by you)" in ${selected.targetState}`);
  });
});

describe("t333 (6) a memory edit observed by a governed check", () => {
  test("the next governed check writes one GUARD_POLICY_SET row naming the memory file, once", () => {
    const { proj } = project("classic");
    expect(governedGuardPolicy(proj).value).toBe("relaxed");
    expect(guardPolicyRows(proj)).toHaveLength(0);
    declareMemoryMode(proj, "team", "strict");
    const observed = governedGuardPolicy(proj);
    expect(observed.value).toBe("strict");
    let rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("team.md");
    governedGuardPolicy(proj);
    governedGuardPolicy(proj);
    expect(guardPolicyRows(proj)).toHaveLength(1);

    // The memory edit is undone: the intent's own line governs again and the
    // ledger records that flip too, naming the line's source.
    const path = memoryFile(proj, "team");
    writeFileSync(path, readFileSync(path, "utf-8").replace("Mode: strict\n", ""));
    expect(governedGuardPolicy(proj).value).toBe("relaxed");
    rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(2);
    expect(auditBlockField(rows[1].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[1].block, "New Value")).toBe("relaxed");
    expect(auditBlockField(rows[1].block, "Source")).toBe("scope classic");
  });

  test("a CHANGE_CONTROL_SET row written by an earlier release is the previous value a governed check reads", () => {
    const { proj } = project("classic");
    appendAuditEntry(
      "CHANGE_CONTROL_SET",
      { "Old Value": "relaxed", "New Value": "strict", Source: "you" },
      proj,
    );
    expect(rowsOf(proj, "CHANGE_CONTROL_SET")).toHaveLength(1);
    const observed = governedGuardPolicy(proj);
    expect(observed.value).toBe("relaxed");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope classic");
    // The newest row of either kind wins: the flip is now recorded and settles.
    governedGuardPolicy(proj);
    expect(guardPolicyRows(proj)).toHaveLength(1);
    expect(rowsOf(proj, "CHANGE_CONTROL_SET")).toHaveLength(1);
  });

  test("a governed check leaves a legacy lineless intent strict and writes no row", () => {
    const { proj, state } = project("classic");
    const withoutLine = readFileSync(state, "utf-8").replace(/^- \*\*Guard Policy\*\*:.*\n/m, "");
    writeFileSync(state, withoutLine);
    const resolved = governedGuardPolicy(proj);
    expect(resolved.value).toBe("strict");
    expect(resolved.source).toBe("not set");
    expect(readFileSync(state, "utf-8")).toBe(withoutLine);
    expect(guardPolicyRows(proj)).toHaveLength(0);
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (not set)\n`);
  });

  test("a governed check with no state file resolves strict and writes nothing", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const resolved = governedGuardPolicy(proj);
    expect(resolved.value).toBe("strict");
    mkdirSync(join(proj, "nothing"), { recursive: true });
    expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents", "audit"))).toBe(false);
  });
});

describe("t333 (7) a refusal's ERROR_LOGGED row lands in the selected workflow", () => {
  /** selectedProject plus a second default intent and no default cursor: the
   *  active space cannot resolve an intent, so nothing about the active state
   *  may decide whether an explicitly selected refusal is recorded. */
  function ambiguousDefault(): ReturnType<typeof selectedProject> {
    const selected = selectedProject("classic");
    const second = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "second default", "--label", "second"],
      selected.proj,
    );
    expect(second.status, second.stderr).toBe(0);
    const defaultIntents = join(selected.proj, "aidlc", "spaces", "default", "intents");
    rmSync(join(defaultIntents, "active-intent"));
    const records = readdirSync(defaultIntents).filter((name) =>
      existsSync(join(defaultIntents, name, "aidlc-state.md")),
    );
    expect(records).toHaveLength(2);
    return selected;
  }

  test("an explicit target with no active cursor records the refusal in the selected shard", () => {
    const selected = ambiguousDefault();
    const beforeTarget = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");

    const refused = run(
      UTILITY,
      ["config-change", "--guard-policy", "loose", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(refused.status).toBe(1);
    const targetAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    expect(targetAfter).toHaveLength(beforeTarget.length + 1);
    const row = targetAfter[targetAfter.length - 1];
    expect(row.event).toBe("ERROR_LOGGED");
    expect(auditBlockField(row.block, "Command")).toContain(
      `--space alt --intent ${selected.targetIntent}`,
    );
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")
      .filter((entry) => entry.event === "ERROR_LOGGED")).toHaveLength(0);
  });

  test("an explicit target that does not exist is refused without creating its audit directory", () => {
    const selected = selectedProject("classic");
    const altIntents = join(selected.proj, "aidlc", "spaces", "alt", "intents");
    const beforeAlt = readdirSync(altIntents).sort();
    const beforeDefault = readAuditShardEvents(selected.proj, selected.defaultIntent, "default");

    const refused = run(
      UTILITY,
      ["config-change", "--guard-policy", "relaxed", "--space", "alt", "--intent", "not-a-real-intent"],
      selected.proj,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr.trim().split("\n").pop()!)).toHaveProperty("error");
    expect(existsSync(join(altIntents, "not-a-real-intent"))).toBe(false);
    expect(readdirSync(altIntents).sort()).toEqual(beforeAlt);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(beforeDefault);
  });

  test("a selected space with no resolvable intent records nothing and creates nothing", () => {
    const selected = ambiguousDefault();
    const emptyIntents = join(selected.proj, "aidlc", "spaces", "empty", "intents");
    const createdSpace = run(UTILITY, ["space-create", "empty"], selected.proj);
    expect(createdSpace.status, createdSpace.stderr).toBe(0);
    const beforeEmpty = existsSync(emptyIntents) ? readdirSync(emptyIntents).sort() : null;

    const refused = run(UTILITY, ["config-change", "--guard-policy", "loose", "--space", "empty"], selected.proj);

    expect(refused.status).toBe(1);
    expect(existsSync(join(emptyIntents, "audit"))).toBe(false);
    expect(existsSync(emptyIntents) ? readdirSync(emptyIntents).sort() : null).toEqual(beforeEmpty);
  });

  test("a space-only refusal stays pinned when the active-intent cursor moves after selection", async () => {
    const selected = selectedProject("classic");
    const altIntents = join(selected.proj, "aidlc", "spaces", "alt", "intents");
    const second = run(
      UTILITY,
      [
        "intent-create",
        "--scope",
        "classic",
        "--arguments",
        "second selected intent",
        "--label",
        "second-alt",
        "--space",
        "alt",
      ],
      selected.proj,
    );
    expect(second.status, second.stderr).toBe(0);
    const secondIntent = readFileSync(join(altIntents, "active-intent"), "utf-8").trim();
    expect(secondIntent).not.toBe(selected.targetIntent);
    writeFileSync(join(altIntents, "active-intent"), `${selected.targetIntent}\n`);

    const beforeTarget = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    const beforeSecond = readAuditShardEvents(selected.proj, secondIntent, "alt");
    const barrier = join(selected.proj, "aidlc", ".t333-error-emit-selection");
    const child = Bun.spawn({
      cmd: [
        BUN,
        UTILITY,
        "config-change",
        "--guard-policy",
        "loose",
        "--space",
        "alt",
        "--project-dir",
        selected.proj,
      ],
      env: {
        ...process.env,
        AIDLC_TEST_ERROR_EMIT_SELECTION_BARRIER: barrier,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();

    await waitForPath(`${barrier}.selected`);
    expect(readFileSync(`${barrier}.selected`, "utf-8")).toBe(`alt/${selected.targetIntent}\n`);
    writeFileSync(join(altIntents, "active-intent"), `${secondIntent}\n`);
    writeFileSync(`${barrier}.release`, "release\n");

    const [status, out, err] = await Promise.all([child.exited, stdout, stderr]);
    expect(status).toBe(1);
    expect(out).toBe("");
    expect(JSON.parse(err.trim().split("\n").pop()!)).toHaveProperty("error");
    const targetAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    expect(targetAfter).toHaveLength(beforeTarget.length + 1);
    expect(targetAfter[targetAfter.length - 1]?.event).toBe("ERROR_LOGGED");
    expect(readAuditShardEvents(selected.proj, secondIntent, "alt")).toEqual(beforeSecond);
  }, 30_000);
});

describe("t333 (8) intent-create --space is the creation target end to end", () => {
  const CREATE = ["intent-create", "--scope", "classic", "--arguments", "x", "--label", "in-alt"];

  /** Every on-disk fact a refused creation must leave alone. */
  function snapshot(proj: string, space: string) {
    const intents = join(proj, "aidlc", "spaces", space, "intents");
    const records = readdirSync(intents)
      .filter((name) => existsSync(join(intents, name, "aidlc-state.md")))
      .sort();
    return {
      records,
      registry: readFileSync(join(intents, "intents.json"), "utf-8"),
      cursor: readFileSync(join(intents, "active-intent"), "utf-8"),
      states: records.map((name) => readFileSync(join(intents, name, "aidlc-state.md"), "utf-8")),
    };
  }

  test("a relaxed or off request into a memory-strict space is refused and creates nothing anywhere", () => {
    for (const value of ["relaxed", "off"] as const) {
      const selected = selectedProject("classic");
      declareAltMemoryStrict(selected.proj);
      const defaultBefore = snapshot(selected.proj, "default");
      const altBefore = snapshot(selected.proj, "alt");
      const defaultRows = readAuditShardEvents(selected.proj, selected.defaultIntent, "default");
      const altRows = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");

      const refused = run(
        UTILITY,
        [...CREATE, "--guard-policy", value, "--space", "alt"],
        selected.proj,
      );

      expect(refused.status, value).toBe(1);
      expect(utilityError(refused.stderr)).toContain(
        `Guard Policy is set to strict in ${altMemoryFile(selected.proj)} (section: Guard Policy)`,
      );
      expect(snapshot(selected.proj, "default")).toEqual(defaultBefore);
      expect(snapshot(selected.proj, "alt")).toEqual(altBefore);
      expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(defaultRows);
      // The refusal is recorded under the selected space, in its active intent.
      const altAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
      expect(altAfter).toHaveLength(altRows.length + 1);
      expect(altAfter[altAfter.length - 1].event).toBe("ERROR_LOGGED");
    }
  });

  test("a creation into another space lands there, reads its memory, and leaves the active space alone", () => {
    const selected = selectedProject("classic");
    declareAltMemoryStrict(selected.proj);
    const defaultBefore = snapshot(selected.proj, "default");
    const defaultRows = readAuditShardEvents(selected.proj, selected.defaultIntent, "default");
    const altIntents = join(selected.proj, "aidlc", "spaces", "alt", "intents");

    const created = run(UTILITY, [...CREATE, "--space", "alt"], selected.proj);

    expect(created.status, created.stderr).toBe(0);
    const createdDir = readFileSync(join(altIntents, "active-intent"), "utf-8").trim();
    expect(createdDir).not.toBe(selected.targetIntent);
    expect(created.stdout).toContain(`Intent created: ${createdDir} (space: alt)`);
    const state = readFileSync(join(altIntents, createdDir, "aidlc-state.md"), "utf-8");
    expect(getField(state, GUARD_POLICY_FIELD)).toBe("strict (from project.md)");
    expect(getField(state, "Current Stage")).not.toBeNull();
    const rows = readAuditShardEvents(selected.proj, createdDir, "alt");
    expect(rows.map((row) => row.event)).toContain("WORKFLOW_STARTED");
    expect(rows.map((row) => row.event)).toContain("WORKSPACE_INITIALISED");
    expect(existsSync(join(altIntents, createdDir, "verification"))).toBe(true);
    // The active space is untouched: cursor, registry, records, rows.
    expect(snapshot(selected.proj, "default")).toEqual(defaultBefore);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(defaultRows);
    expect(readFileSync(join(selected.proj, "aidlc", "active-space"), "utf-8").trim()).toBe("default");

    const status = run(UTILITY, ["status", "--space", "alt", "--intent", createdDir], selected.proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (from project.md)\n`);
  });

  test("without a strict memory the created intent carries the scope default and status reports it", () => {
    const selected = selectedProject("classic");
    const altIntents = join(selected.proj, "aidlc", "spaces", "alt", "intents");

    const created = run(UTILITY, [...CREATE, "--space", "alt"], selected.proj);

    expect(created.status, created.stderr).toBe(0);
    const createdDir = readFileSync(join(altIntents, "active-intent"), "utf-8").trim();
    expect(createdDir).not.toBe(selected.targetIntent);
    expect(existsSync(join(altIntents, createdDir, "aidlc-state.md"))).toBe(true);
    const status = run(UTILITY, ["status", "--space", "alt", "--intent", createdDir], selected.proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}relaxed (from scope classic)\n`);
  });

  test("a memory edit after the locked policy snapshot completes one fully initialized intent", async () => {
    const selected = selectedProject("classic");
    const defaultBefore = snapshot(selected.proj, "default");
    const altBefore = snapshot(selected.proj, "alt");
    const altIntents = join(selected.proj, "aidlc", "spaces", "alt", "intents");
    const barrier = join(selected.proj, "aidlc", ".t333-intent-create-policy");
    const child = Bun.spawn({
      cmd: [
        BUN,
        UTILITY,
        ...CREATE,
        "--guard-policy",
        "relaxed",
        "--space",
        "alt",
        "--project-dir",
        selected.proj,
      ],
      env: {
        ...process.env,
        AIDLC_TEST_INTENT_CREATE_CHANGE_CONTROL_BARRIER: barrier,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();

    await waitForPath(`${barrier}.snapshotted`);
    declareAltMemoryStrict(selected.proj);
    writeFileSync(`${barrier}.release`, "release\n");

    const [status, out, err] = await Promise.all([child.exited, stdout, stderr]);
    expect(status, err).toBe(0);
    const createdDir = readFileSync(join(altIntents, "active-intent"), "utf-8").trim();
    expect(createdDir).not.toBe(selected.targetIntent);
    expect(out).toContain(`Intent created: ${createdDir} (space: alt)`);

    const state = readFileSync(join(altIntents, createdDir, "aidlc-state.md"), "utf-8");
    expect(getField(state, GUARD_POLICY_FIELD)).toBe("relaxed (from scope classic)");
    expect(getField(state, "Current Stage")).not.toBeNull();
    const rows = readAuditShardEvents(selected.proj, createdDir, "alt");
    expect(rows.map((row) => row.event)).toContain("WORKFLOW_STARTED");
    expect(rows.map((row) => row.event)).toContain("WORKSPACE_INITIALISED");
    expect(existsSync(join(altIntents, createdDir, "verification"))).toBe(true);
    expect(snapshot(selected.proj, "default")).toEqual(defaultBefore);
    expect(snapshot(selected.proj, "alt").records).toHaveLength(altBefore.records.length + 1);
  }, 30_000);

  test("--intent and an unknown --space are refused before anything is created", () => {
    const selected = selectedProject("classic");
    const defaultBefore = snapshot(selected.proj, "default");
    const altBefore = snapshot(selected.proj, "alt");

    const withIntent = run(UTILITY, [...CREATE, "--intent", selected.targetIntent], selected.proj);
    expect(withIntent.status).toBe(1);
    expect(withIntent.stderr).toContain(
      "intent-create does not accept --intent: it creates a new intent and names it itself. Use --space <name> to choose the space it is created in.",
    );

    const unknownSpace = run(UTILITY, [...CREATE, "--space", "nowhere"], selected.proj);
    expect(unknownSpace.status).toBe(1);
    expect(unknownSpace.stderr).toContain('Unknown space \\"nowhere\\".');
    expect(unknownSpace.stderr).toContain("intent-create only creates in an existing space");
    expect(existsSync(join(selected.proj, "aidlc", "spaces", "nowhere"))).toBe(false);

    expect(snapshot(selected.proj, "default")).toEqual(defaultBefore);
    expect(snapshot(selected.proj, "alt")).toEqual(altBefore);
  });

  test("an explicit other space is refused while the flat layout still awaits migration", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const createdSpace = run(UTILITY, ["space-create", "alt"], proj);
    expect(createdSpace.status, createdSpace.stderr).toBe(0);
    mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
    writeFileSync(
      join(proj, "aidlc-docs", "aidlc-state.md"),
      "- **Current Stage**: requirements-analysis\n- **Workflow**: Build Auth Service\n",
    );
    const altIntents = join(proj, "aidlc", "spaces", "alt", "intents");
    const defaultIntents = join(proj, "aidlc", "spaces", "default", "intents");
    const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : null);
    const altBefore = listing(altIntents);
    const defaultBefore = listing(defaultIntents);

    const refused = run(UTILITY, [...CREATE, "--space", "alt"], proj);

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("still has the flat aidlc-docs/ layout");
    expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(true);
    expect(listing(altIntents)).toEqual(altBefore);
    expect(listing(defaultIntents)).toEqual(defaultBefore);
  });
});

describe("t333 (9) fences: the policy lowers a fixed set; per-run switches can lower or raise four fences", () => {
  /** A resolution for a value with a fixed source, as resolveFences reads it. */
  function policy(value: "strict" | "relaxed" | "off", source = "you"): GuardPolicyResolution {
    return {
      value,
      source,
      scopeDefault: "strict",
      intent: { value, source },
      stateValue: value,
      rawStateValue: `${value} (set by you)`,
      stateField: GUARD_POLICY_FIELD,
      memoryStrict: null,
    };
  }

  test("strict lowers nothing; relaxed lowers two; off lowers four; human presence is never among them", () => {
    expect(GUARD_FENCES).toEqual([
      "plan-approval",
      "review-freeze",
      "state-transition",
      "reviewer-scope",
      "human-presence",
    ]);
    expect(fencesLoweredByPolicy("strict")).toEqual([]);
    expect(fencesLoweredByPolicy("relaxed")).toEqual(["plan-approval", "review-freeze"]);
    expect(fencesLoweredByPolicy("off")).toEqual([
      "plan-approval",
      "review-freeze",
      "state-transition",
      "reviewer-scope",
    ]);
    withEnvAndFreshCaches(FENCE_ENV_CLEAR, () => {
      const strict = resolveFences(policy("strict"), "");
      for (const fence of GUARD_FENCES) expect(strict[fence]).toEqual({ fence, value: "on", source: "default" });
      const relaxed = resolveFences(policy("relaxed", "scope express"), "");
      expect(relaxed["plan-approval"]).toEqual({
        fence: "plan-approval",
        value: "off",
        source: "guard policy relaxed (from scope express)",
      });
      expect(relaxed["review-freeze"].value).toBe("off");
      expect(relaxed["state-transition"]).toEqual({ fence: "state-transition", value: "on", source: "default" });
      expect(relaxed["reviewer-scope"].value).toBe("on");
      expect(relaxed["human-presence"].value).toBe("on");
      const off = resolveFences(policy("off"), "");
      expect(off["state-transition"]).toEqual({
        fence: "state-transition",
        value: "off",
        source: "guard policy off (set by you)",
      });
      expect(off["reviewer-scope"].value).toBe("off");
      expect(off["human-presence"]).toEqual({ fence: "human-presence", value: "on", source: "default" });
      expect(formatFence(relaxed["plan-approval"])).toBe("off (guard policy relaxed (from scope express))");
      expect(formatFence(strict["plan-approval"])).toBe("on (default)");
    });
  });

  test("environment, Guards Off, Guards On, and policy resolve in precedence order without a presence switch", () => {
    withEnvAndFreshCaches(FENCE_ENV_CLEAR, () => {
      const perRun = resolveFences(policy("relaxed"), "- **Guards Off**: human-presence, review-freeze (set by you)\n- **Guards On**: human-presence, plan-approval, review-freeze (set by you)\n");
      expect(perRun["human-presence"]).toEqual({ fence: "human-presence", value: "on", source: "default" });
      expect(perRun["review-freeze"]).toEqual({ fence: "review-freeze", value: "off", source: "you" });
      expect(perRun["plan-approval"]).toEqual({ fence: "plan-approval", value: "on", source: "you" });
      expect(formatFence(perRun["plan-approval"])).toBe("on (set by you)");
      expect(formatFence(perRun["review-freeze"])).toBe("off (set by you)");
    });
    withEnvAndFreshCaches({ ...FENCE_ENV_CLEAR, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" }, () => {
      const env = resolveFences(policy("strict"), "- **Guards Off**: plan-approval (set by you)\n- **Guards On**: plan-approval (set by you)\n");
      expect(env["plan-approval"]).toEqual({
        fence: "plan-approval",
        value: "off",
        source: "env AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
      });
      expect(formatFence(env["plan-approval"])).toBe("off (env AIDLC_DISABLE_PLAN_APPROVAL_GUARD)");
    });
  });

  test("the human-turn hook lowers a fence immediately, repeated CLI setters are no-ops, and on restores it", () => {
    const { proj, state } = project("enterprise");
    const context = JSON.parse(recordHumanPrompt(proj, "/aidlc config set guard.plan-approval off"));
    expect(context.additionalContext).toContain("AIDLC Guard Policy:");
    expect(context.additionalContext).toContain(
      "Fence plan-approval is off for this piece of work (logged; back on for the next one)",
    );
    const content = readFileSync(state, "utf-8");
    expect(getField(content, GUARDS_OFF_FIELD)).toBe("plan-approval (set by you)");
    expect(getField(content, GUARD_POLICY_FIELD)).toBe("strict (from scope enterprise)");
    const disabled = rowsOf(proj, "GUARD_DISABLED");
    expect(disabled).toHaveLength(1);
    expect(auditBlockField(disabled[0].block, "Guard")).toBe("plan-approval");
    expect(auditBlockField(disabled[0].block, "Scope")).toBe("enterprise");
    expect(auditBlockField(disabled[0].block, "Source")).toBe("you");
    expect(guardPolicyRows(proj)).toHaveLength(0);
    expect(run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR).stdout).toBe("off (set by you)\n");
    expect(run(UTILITY, ["config-get", "guard.review-freeze"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (default)\n");
    const status = run(UTILITY, ["status"], proj, FENCE_ENV_CLEAR);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (from scope enterprise)\n`);
    expect(status.stdout).toContain(
      `${STATUS_FENCES}plan-approval off (set by you), review-freeze on (default), state-transition on (default), reviewer-scope on (default), human-presence on (default)\n`,
    );
    // Repeating is a no-op: no second row, no write.
    const before = readFileSync(state, "utf-8");
    const again = run(UTILITY, ["config-change", "--guard.plan-approval", "off"], proj, FENCE_ENV_CLEAR);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Fence plan-approval is already off");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(1);
    // A second switchable fence joins the line in canonical order.
    recordHumanPrompt(proj, "/aidlc config set guard.review-freeze off");
    expect(getField(readFileSync(state, "utf-8"), GUARDS_OFF_FIELD)).toBe(
      "plan-approval, review-freeze (set by you)",
    );
    expect(rowsOf(proj, "GUARD_DISABLED").map((row) => auditBlockField(row.block, "Guard"))).toEqual([
      "plan-approval",
      "review-freeze",
    ]);
    expect(run(UTILITY, ["config-get", "guard.human-presence"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (default)\n");
    // Back on: GUARD_RESTORED, the line shrinks, the read returns to the default.
    const restored = run(UTILITY, ["config-change", "--guard.plan-approval", "on"], proj, FENCE_ENV_CLEAR);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("Fence plan-approval is back on for this piece of work");
    expect(getField(readFileSync(state, "utf-8"), GUARDS_OFF_FIELD)).toBe("review-freeze (set by you)");
    const restoredRows = rowsOf(proj, "GUARD_RESTORED");
    expect(restoredRows).toHaveLength(1);
    expect(auditBlockField(restoredRows[0].block, "Guard")).toBe("plan-approval");
    expect(auditBlockField(restoredRows[0].block, "Scope")).toBe("enterprise");
    expect(auditBlockField(restoredRows[0].block, "Source")).toBe("you");
    expect(run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (default)\n");
    const all = run(
      UTILITY,
      ["config-change", "--guard.review-freeze", "on"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(all.status, all.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARDS_OFF_FIELD)).toBe("none");
    expect(rowsOf(proj, "GUARD_RESTORED")).toHaveLength(2);
    const listed = run(UTILITY, ["config-list", "--json"], proj, FENCE_ENV_CLEAR);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      "guard-policy": "strict (from scope enterprise)",
      "guard.plan-approval": "on (default)",
      "guard.review-freeze": "on (default)",
      "guard.state-transition": "on (default)",
      "guard.reviewer-scope": "on (default)",
    });
    expect(JSON.parse(listed.stdout)).not.toHaveProperty("guard.human-presence");
  });

  test("config set can raise a policy-lowered fence and the human-turn hook can lower it again without duplicate rows", () => {
    const { proj, state } = project("classic");
    const dispatcher = join(AIDLC_SRC, "tools", "aidlc.ts");
    const raised = run(dispatcher, ["engine", "config", "set", "guard.plan-approval", "on"], proj, FENCE_ENV_CLEAR);
    expect(raised.status, raised.stderr).toBe(0);
    const onState = readFileSync(state, "utf-8");
    expect(onState).toContain("- **Guards On**: plan-approval (set by you)");
    expect(getField(onState, GUARD_POLICY_FIELD)).toBe("relaxed (from scope classic)");
    const restoredRows = rowsOf(proj, "GUARD_RESTORED");
    expect(restoredRows).toHaveLength(1);
    expect(auditBlockField(restoredRows[0].block, "Guard")).toBe("plan-approval");
    expect(auditBlockField(restoredRows[0].block, "Scope")).toBe("classic");
    expect(auditBlockField(restoredRows[0].block, "Source")).toBe("you");
    expect(run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (set by you)\n");
    expect(run(UTILITY, ["status"], proj, FENCE_ENV_CLEAR).stdout).toContain("plan-approval on (set by you)");
    const again = run(dispatcher, ["engine", "config", "set", "guard.plan-approval", "on"], proj, FENCE_ENV_CLEAR);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Fence plan-approval is already on");
    expect(readFileSync(state, "utf-8")).toBe(onState);
    expect(rowsOf(proj, "GUARD_RESTORED")).toHaveLength(1);
    recordHumanPrompt(proj, "/aidlc config set guard.plan-approval off");
    const offState = readFileSync(state, "utf-8");
    expect(getField(offState, GUARDS_ON_FIELD)).toBe("none");
    expect(getField(offState, GUARDS_OFF_FIELD)).toBe("plan-approval (set by you)");
    const disabledRows = rowsOf(proj, "GUARD_DISABLED");
    expect(disabledRows).toHaveLength(1);
    expect(auditBlockField(disabledRows[0].block, "Guard")).toBe("plan-approval");
    expect(run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR).stdout).toBe("off (set by you)\n");
    const unchanged = run(dispatcher, ["engine", "config", "set", "guard.plan-approval", "off"], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("Fence plan-approval is already off");
    expect(readFileSync(state, "utf-8")).toBe(offState);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(1);
  });

  const fenceRefusal = "Turning the plan-approval check off is the person's move: they type `/aidlc config set guard.plan-approval off` and the harness applies it as they say it. This command does not lower a fence on its own.";
  const policyRefusal = "Setting Guard Policy relaxed lowers fences and is the person's move: they type `/aidlc --guard-policy relaxed` and the harness applies it as they say it. This command does not lower fences on its own.";
  const createRefusal = "Creating this intent with Guard Policy relaxed would lower fences. Create it, then have the person type `/aidlc --guard-policy relaxed`; the harness applies it as they say it. A scope default applies without asking.";

  // Human turns and refusals may be logged without mutating workflow facts.
  function mutationRows(proj: string, intent?: string, space?: string) {
    return readAuditShardEvents(proj, intent, space).filter((row) =>
      row.event !== "ERROR_LOGGED" && row.event !== "HUMAN_TURN"
    );
  }

  describe.each([
    { context: "a resolved session", session: FENCE_SESSION },
    { context: "an unresolved session after harness startup", session: undefined },
  ])("a command-local presence bypass in $context", ({ session }) => {
    test.each<{ operation: string; args: string[]; refusal: string }>([
      {
        operation: "the fence setter",
        args: ["config-change", "--guard.plan-approval", "off"],
        refusal: fenceRefusal,
      },
      {
        operation: "the policy setter",
        args: ["config-change", "--guard-policy", "off"],
        refusal: policyRefusal.replaceAll("relaxed", "off"),
      },
      {
        operation: "intent creation",
        args: [
          "intent-create", "--scope", "enterprise", "--arguments", "untrusted lowering",
          "--label", "untrusted", "--guard-policy", "relaxed",
        ],
        refusal: createRefusal,
      },
    ])("does not authorize $operation or mutate workflow facts", ({ args, refusal }) => {
      const { proj, state } = project("enterprise");
      if (session === undefined) writeCurrentSessionId(proj, "harness-session");
      const before = readFileSync(state, "utf-8");
      const ledger = mutationRows(proj);
      const intents = join(proj, "aidlc", "spaces", "default", "intents");
      const registry = readFileSync(join(intents, "intents.json"), "utf-8");
      const active = readFileSync(join(intents, "active-intent"), "utf-8");
      const records = readdirSync(intents).sort();
      const refused = run(UTILITY, args, proj, {
        ...FENCE_ENV_CLEAR,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_SESSION_OVERRIDE: session,
        AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
      });
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stderr)).toEqual({ error: refusal });
      expect(readFileSync(state, "utf-8")).toBe(before);
      expect(mutationRows(proj)).toEqual(ledger);
      expect(readFileSync(join(intents, "intents.json"), "utf-8")).toBe(registry);
      expect(readFileSync(join(intents, "active-intent"), "utf-8")).toBe(active);
      expect(readdirSync(intents).sort()).toEqual(records);
    });
  });

  test.each([
    { origin: "sessionless fixture", session: undefined },
    { origin: "harness-launch", session: FENCE_SESSION },
  ])("the $origin presence bypass authorizes CLI lowering without a typed prompt", ({ session }) => {
    const { proj, state } = project("enterprise");
    const env = {
      ...FENCE_ENV_CLEAR,
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SESSION_OVERRIDE: session,
      AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
    };
    if (session !== undefined) {
      const started = Bun.spawnSync({
        cmd: [BUN, join(AIDLC_SRC, "hooks", "aidlc-session-start.ts")],
        cwd: proj,
        env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: proj },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "SessionStart", source: "startup", cwd: proj, session_id: session,
        })),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(started.exitCode, started.stderr.toString()).toBe(0);
    }
    const fence = run(UTILITY, ["config-change", "--guard.plan-approval", "off"], proj, env);
    expect(fence.status, fence.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARDS_OFF_FIELD)).toBe("plan-approval (set by you)");
    expect(rowsOf(proj, "GUARD_DISABLED").map((row) => auditBlockField(row.block, "Guard"))).toEqual(["plan-approval"]);

    const policy = run(UTILITY, ["config-change", "--guard-policy", "off"], proj, env);
    expect(policy.status, policy.stderr).toBe(0);
    const lowered = readFileSync(state, "utf-8");
    expect(getField(lowered, GUARD_POLICY_FIELD)).toBe("off (set by you)");
    expect(guardPolicyRows(proj).map((row) => auditBlockField(row.block, "New Value"))).toEqual(["off"]);

    const created = run(UTILITY, [
      "intent-create", "--scope", "enterprise", "--arguments", "trusted lowering",
      "--label", "trusted", "--guard-policy", "relaxed",
    ], proj, env);
    expect(created.status, created.stderr).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const createdState = join(intents, active, "aidlc-state.md");
    expect(createdState).not.toBe(state);
    expect(getField(readFileSync(createdState, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(readFileSync(state, "utf-8")).toBe(lowered);
  });

  test.each<{ operation: string; args: string[]; refusal: string }>([
    {
      operation: "fence setter",
      args: ["config-change", "--guard.plan-approval", "off"],
      refusal: fenceRefusal,
    },
    {
      operation: "policy setter",
      args: ["config-change", "--guard-policy", "relaxed"],
      refusal: policyRefusal,
    },
    {
      operation: "intent creation",
      args: [
        "intent-create", "--scope", "enterprise", "--arguments", "unapproved lowering",
        "--label", "unapproved", "--guard-policy", "relaxed",
      ],
      refusal: createRefusal,
    },
  ])("a CLI $operation cannot lower fences even after a fresh human turn", ({ args, refusal }) => {
    const { proj, state } = project("enterprise");
    recordHumanPrompt(proj, "Continue");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const registry = readFileSync(join(intents, "intents.json"), "utf-8");
    const active = readFileSync(join(intents, "active-intent"), "utf-8");
    const records = readdirSync(intents).sort();
    const refused = run(UTILITY, args, proj, FENCE_ENV_CLEAR);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({ error: refusal });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    expect(readFileSync(join(intents, "intents.json"), "utf-8")).toBe(registry);
    expect(readFileSync(join(intents, "active-intent"), "utf-8")).toBe(active);
    expect(readdirSync(intents).sort()).toEqual(records);
  });

  test.each([
    "why was `guard.plan-approval off` suggested?",
    "/aidlc why was config set guard.plan-approval off suggested?",
    "/aidlc config set guard.plan-approval off please",
    "do not run /aidlc config set guard.plan-approval off",
    "I read about --guard-policy relaxed in the docs",
    "guard policy relaxed is what the team uses",
    "/aidlc --guard-policy strict",
    "/aidlc guard-policy relaxed",
  ])("a prompt that names no lowering switch changes nothing: %s", (prompt) => {
    const { proj, state } = project("enterprise");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    expect(recordHumanPrompt(proj, prompt)).toBe("");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test.each([
    "/aidlc intent switch target --guard-policy relaxed",
    "/aidlc intent target --guard-policy relaxed",
    "/aidlc intent create --scope classic --guard-policy relaxed",
    "/aidlc space switch target --guard-policy relaxed",
    "/aidlc space target --guard-policy relaxed",
    "/aidlc space create target --guard-policy relaxed",
    "/aidlc space-create target --guard-policy relaxed",
  ])("a workspace command cannot lower the previously active intent: %s", (prompt) => {
    const { proj, state } = project("enterprise");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    expect(recordHumanPrompt(proj, prompt)).toBe("");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test("the CLI can raise Guard Policy after a strict prompt leaves it unchanged", () => {
    const { proj, state } = project("enterprise");
    recordHumanPrompt(proj, "Guard policy off.");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    expect(recordHumanPrompt(proj, "/aidlc --guard-policy strict")).toBe("");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    const raised = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj, FENCE_ENV_CLEAR);
    expect(raised.status, raised.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (set by you)");
    expect(guardPolicyRows(proj).map((row) => auditBlockField(row.block, "New Value"))).toEqual(["off", "strict"]);
  });

  test("an already-off fence needs no key unless the same CLI transaction raises its policy", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const unchanged = run(UTILITY, ["config-change", "--guard.plan-approval", "off"], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("Fence plan-approval is already off");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    const refused = run(UTILITY, [
      "config-change", "--guard-policy", "strict", "--guard.plan-approval", "off",
    ], proj, FENCE_ENV_CLEAR);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({ error: fenceRefusal });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test.each([
    { prompt: "/aidlc --guard-policy relaxed", value: "relaxed" },
    { prompt: "/aidlc --guard-policy relaxed build the auth service", value: "relaxed" },
    { prompt: "$aidlc --guard-policy relaxed", value: "relaxed" },
    { prompt: "Guard policy off.", value: "off" },
  ])("the human-turn hook applies an affirmative policy prompt immediately: $prompt", ({ prompt, value }) => {
    const { proj, state } = project("enterprise");
    const context = JSON.parse(recordHumanPrompt(proj, prompt));
    expect(context.additionalContext).toContain("AIDLC Guard Policy: Guard Policy changed:");
    expect(context.additionalContext).toContain(`${value} (set by you)`);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe(`${value} (set by you)`);
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "New Value")).toBe(value);
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
    const before = readFileSync(state, "utf-8");
    const unchanged = run(UTILITY, ["config-change", "--guard-policy", value], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain(`Guard Policy is already ${value} (set by you)`);
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(guardPolicyRows(proj)).toEqual(rows);
  });

  test.each([
    {
      prompt: "/aidlc --guard-policy relaxed build auth --depth impossible",
      error: 'Unknown depth: "impossible". Valid depths: minimal, standard, comprehensive.',
    },
    {
      prompt: "/aidlc --guard-policy relaxed build auth --unknown value",
      error: null,
    },
    {
      prompt: "/aidlc config set guard-policy relaxed --depth",
      error: null,
    },
    {
      prompt: "/aidlc --guard-policy relaxed --change-control off",
      error: null,
    },
    {
      prompt: "/aidlc --change-control relaxed --guard-policy off",
      error: null,
    },
    {
      prompt: "/aidlc --scope not-a-scope --guard-policy relaxed",
      error: 'Unknown scope "not-a-scope".',
    },
  ])("a typed lowering command validates every companion before changing state: $prompt", ({ prompt, error }) => {
    const { proj, state } = project("enterprise");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const output = recordHumanPrompt(proj, prompt);
    if (error === null) {
      expect(output).toBe("");
    } else {
      const context = JSON.parse(output);
      expect(context.additionalContext).toBe(`AIDLC Guard Policy: ${error}`);
    }
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test.each([
    "/aidlc --guard-policy relaxed --depth minimal --sensors off",
    "/aidlc --guard-policy relaxed build auth --depth minimal --sensors off",
    "/aidlc --scope classic --guard-policy relaxed build auth --depth minimal --sensors off",
    "/aidlc config set guard-policy relaxed --depth minimal --sensors off",
  ])("a valid typed lowering command applies all companion settings atomically: %s", (prompt) => {
    const { proj, state } = project("enterprise");
    const context = JSON.parse(recordHumanPrompt(proj, prompt));
    expect(context.additionalContext).toContain("Guard Policy changed:");
    expect(context.additionalContext).toContain("Depth changed: Comprehensive -> Minimal");
    expect(context.additionalContext).toContain("Sensors changed:");
    const content = readFileSync(state, "utf-8");
    expect(getField(content, GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(getField(content, "Depth")).toBe("Minimal");
    expect(getField(content, "Sensors")).toBe("off (set by you)");
    expect(guardPolicyRows(proj)).toHaveLength(1);
    expect(rowsOf(proj, "DEPTH_CHANGED")).toHaveLength(1);
    expect(rowsOf(proj, "CEREMONY_SET")).toHaveLength(1);
  });

  test("a submitted prompt normalizes a retired policy before applying its typed lowering switch", () => {
    const { proj, state } = project("classic");
    const retired = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: relaxed (from scope classic)",
    );
    writeFileSync(state, retired);
    const contexts = recordHumanPrompt(proj, "/aidlc --guard-policy off")
      .trim().split("\n").map((line) => JSON.parse(line).additionalContext);
    expect(contexts[0]).toContain("AIDLC Guard Policy migration: kept relaxed");
    expect(contexts[1]).toContain("off (set by you)");
    const updated = readFileSync(state, "utf-8");
    expect(getField(updated, GUARD_POLICY_FIELD)).toBe("off (set by you)");
    expect(getField(updated, CHANGE_CONTROL_FIELD)).toBeNull();
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("off");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });

  test("a typed policy switch changes only the intent and space selected in the prompt", () => {
    const { proj, defaultIntent, targetIntent, targetState } = selectedProject();
    const defaultState = join(proj, "aidlc", "spaces", "default", "intents", defaultIntent, "aidlc-state.md");
    const before = readFileSync(defaultState, "utf-8");
    const ledger = mutationRows(proj, defaultIntent, "default");
    const context = JSON.parse(recordHumanPrompt(
      proj, `/aidlc config set guard-policy relaxed --intent ${targetIntent} --space alt`,
    ));
    expect(context.additionalContext).toContain("AIDLC Guard Policy: Guard Policy changed:");
    expect(context.additionalContext).toContain("relaxed (set by you)");
    expect(getField(readFileSync(targetState, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(readFileSync(defaultState, "utf-8")).toBe(before);
    expect(mutationRows(proj, defaultIntent, "default")).toEqual(ledger);
    const rows = selectedRows(proj, targetIntent, "alt", "GUARD_POLICY_SET");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "New Value")).toBe("relaxed");
  });

  test("a typed switch for a missing intent changes nothing and explains the missing piece of work", () => {
    const { proj, state } = project("enterprise");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const records = readdirSync(intents).sort();
    const context = JSON.parse(recordHumanPrompt(
      proj, "/aidlc config set guard-policy relaxed --intent does-not-exist --space default",
    ));
    expect(context.additionalContext).toContain("does-not-exist is not a piece of work in space default.");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    expect(readdirSync(intents).sort()).toEqual(records);
  });

  test.each([
    { malformed: "a repeated intent selector", suffix: "--intent {intent} --intent {intent}" },
    { malformed: "a repeated space selector", suffix: "--space default --space default" },
    { malformed: "an intent selector without a value", suffix: "--intent" },
    { malformed: "a space selector without a value", suffix: "--space" },
  ])("a typed config command with $malformed applies nothing", ({ suffix }) => {
    const { proj, state } = project("enterprise");
    const intent = readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim();
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    expect(recordHumanPrompt(proj, `/aidlc config set guard-policy relaxed ${suffix.replaceAll("{intent}", intent)}`)).toBe("");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test.each([
    "/aidlc --guard-policy relaxed",
    "/aidlc config set guard.plan-approval off",
  ])("memory strict refuses a typed switch before any setting changes: %s", (prompt) => {
    const { proj, state } = project("enterprise");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const context = JSON.parse(recordHumanPrompt(proj, prompt));
    expect(context.additionalContext).toContain(
      `Guard Policy is set to strict in ${memoryFile(proj, "project")} (section: Guard Policy), so it cannot be changed from chat. Edit that line to change it for everyone on this repo.`,
    );
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
  });

  test.each([
    { prompt: "/aidlc --guard-policy relaxed", setting: "Guard Policy relaxed" },
    { prompt: "/aidlc config set guard.plan-approval off", setting: "guard.plan-approval off" },
  ])("a typed $setting switch with no state asks the person to create the piece of work first", ({ prompt, setting }) => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    removeWorkspaceRecord(proj);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const before = existsSync(intents) ? readdirSync(intents).sort() : null;
    const context = JSON.parse(recordHumanPrompt(proj, prompt));
    expect(context.additionalContext).toContain(setting);
    expect(context.additionalContext).toContain("apply to a piece of work: create it, then type this again.");
    expect(existsSync(intents) ? readdirSync(intents).sort() : null).toEqual(before);
    expect(readAuditShardEvents(proj)).toEqual([]);
  });

  test.each<{ operation: string; prompt: string; args: string[]; refusal: string }>([
    {
      operation: "fence setter",
      prompt: "/aidlc config set guard.plan-approval off",
      args: ["config-change", "--guard.plan-approval", "off"],
      refusal: fenceRefusal,
    },
    {
      operation: "policy setter",
      prompt: "/aidlc --guard-policy relaxed",
      args: ["config-change", "--guard-policy", "relaxed"],
      refusal: policyRefusal,
    },
    {
      operation: "intent creation",
      prompt: "/aidlc --guard-policy relaxed",
      args: [
        "intent-create", "--scope", "enterprise", "--arguments", "unattended piece of work",
        "--label", "unattended", "--guard-policy", "relaxed",
      ],
      refusal: createRefusal,
    },
  ])("an unattended prompt applies nothing and the $operation refuses even with the presence bypass", ({ prompt, args, refusal }) => {
    const { proj, state } = project("enterprise");
    recordSessionPresenceBypass(proj, FENCE_SESSION);
    const before = readFileSync(state, "utf-8");
    const allRows = readAuditShardEvents(proj);
    const context = JSON.parse(recordHumanPrompt(proj, prompt, { AIDLC_UNATTENDED: "1" }));
    expect(context.additionalContext).toContain("not applied");
    expect(context.additionalContext).toContain("AIDLC_UNATTENDED=1");
    expect(context.additionalContext).toContain("withholds human authority");
    expect(context.additionalContext).toContain("attended session");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(readAuditShardEvents(proj)).toEqual(allRows);
    const ledger = mutationRows(proj);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const registry = readFileSync(join(intents, "intents.json"), "utf-8");
    const active = readFileSync(join(intents, "active-intent"), "utf-8");
    const records = readdirSync(intents).sort();
    const refused = run(UTILITY, args, proj, {
      ...FENCE_ENV_CLEAR, AIDLC_UNATTENDED: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    });
    expect(refused.status).toBe(1);
    const error = JSON.parse(refused.stderr).error;
    expect(error).toStartWith(refusal);
    expect(error).toContain("AIDLC_UNATTENDED=1 is set, so automated prompt submissions cannot count as a human reply.");
    expect(error).toEndWith("This needs a fresh human turn: wait for the person to reply, then record it again.");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    expect(readFileSync(join(intents, "intents.json"), "utf-8")).toBe(registry);
    expect(readFileSync(join(intents, "active-intent"), "utf-8")).toBe(active);
    expect(readdirSync(intents).sort()).toEqual(records);
  });

  test("scope-change refuses lowering until the hook applies combined switches without a slash", () => {
    const { proj, state } = project("enterprise");
    recordHumanPrompt(proj, "/aidlc --guard-policy relaxed");
    const args = ["scope-change", "--scope", "classic", "--guard-policy", "relaxed", "--guard.state-transition", "off"];
    const before = readFileSync(state, "utf-8");
    const ledger = mutationRows(proj);
    const refused = run(UTILITY, args, proj, FENCE_ENV_CLEAR);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: fenceRefusal.replaceAll("plan-approval", "state-transition"),
    });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(mutationRows(proj)).toEqual(ledger);
    recordHumanPrompt(
      proj,
      "aidlc --scope classic --guard-policy relaxed build auth --guard.state-transition off",
    );
    const switched = readFileSync(state, "utf-8");
    expect(getField(switched, "Scope")).toBe("enterprise");
    expect(getField(switched, GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(getField(switched, GUARDS_OFF_FIELD)).toBe("state-transition (set by you)");
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(1);
    const changed = run(UTILITY, args, proj, FENCE_ENV_CLEAR);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("relaxed (set by you)");
    expect(getField(readFileSync(state, "utf-8"), "Scope")).toBe("classic");
    expect(rowsOf(proj, "SCOPE_CHANGED")).toHaveLength(1);
    expect(guardPolicyRows(proj)).toHaveLength(1);
    expect(auditBlockField(guardPolicyRows(proj)[0].block, "Source")).toBe("you");
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(1);
  });

  test("a scope change preserves a stricter policy until the person lowers it", () => {
    const { proj, state } = project("enterprise");
    const changed = run(UTILITY, ["scope-change", "--scope", "classic"], proj, FENCE_ENV_CLEAR);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), GUARD_POLICY_FIELD)).toBe("strict (from scope enterprise)");
    expect(rowsOf(proj, "SCOPE_CHANGED")).toHaveLength(1);
    expect(guardPolicyRows(proj)).toHaveLength(0);
  });

  test("memory strict raises a previously lowered fence and refuses unapproved source writes", () => {
    const { proj, state } = project("enterprise");
    const content = setGuardsOffLine(
      setField(readFileSync(state, "utf-8"), "Current Stage", "code-generation"),
      ["plan-approval"],
    );
    writeFileSync(state, content);
    declareMemoryMode(proj, "project", "strict");
    const resolved = run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR);
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout).toBe("on (guard policy strict (from project.md))\n");
    writeActiveDirectiveMarker(proj, {
      kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(content),
    });
    mkdirSync(join(proj, "src"), { recursive: true });
    const guarded = Bun.spawnSync({
      cmd: [BUN, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")],
      cwd: proj,
      env: { ...process.env, ...FENCE_ENV_CLEAR, CLAUDE_PROJECT_DIR: proj },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(proj, "src", "unapproved.ts"), content: "export const unapproved = true;\n" },
        cwd: proj,
      })),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(guarded.exitCode, guarded.stderr.toString()).toBe(2);
    expect(rowsOf(proj, "GUARD_STOOD_ASIDE")).toHaveLength(0);
    expect(getField(readFileSync(state, "utf-8"), GUARDS_OFF_FIELD)).toBe("plan-approval (set by you)");
  });

  test("memory strict refuses a fence-off config change before any setting changes", () => {
    const { proj, state } = project("enterprise");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const refused = run(
      UTILITY,
      ["config-change", "--depth", "minimal", "--guard.plan-approval", "off"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(refused.status, refused.stderr).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: `Guard Policy is set to strict in ${memoryFile(proj, "project")} (section: Guard Policy), so plan-approval cannot be turned off from chat. Edit that line to change it for everyone on this repo.`,
    });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(rowsOf(proj, "DEPTH_CHANGED")).toHaveLength(0);
  });

  test("the dispatcher cannot lower a fence held strict by memory", () => {
    const { proj, state } = project("enterprise");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const refused = run(
      join(AIDLC_SRC, "tools", "aidlc.ts"),
      ["engine", "config", "set", "guard.plan-approval", "off"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(refused.status, refused.stderr).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: `Guard Policy is set to strict in ${memoryFile(proj, "project")} (section: Guard Policy), so plan-approval cannot be turned off from chat. Edit that line to change it for everyone on this repo.`,
    });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
  });

  test("scope-change refuses a fence-off request under memory strict before changing scope", () => {
    const { proj, state } = project("enterprise");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const refused = run(
      UTILITY,
      ["scope-change", "--scope", "classic", "--guard.plan-approval", "off"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(refused.status, refused.stderr).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: `Guard Policy is set to strict in ${memoryFile(proj, "project")} (section: Guard Policy), so plan-approval cannot be turned off from chat. Edit that line to change it for everyone on this repo.`,
    });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(rowsOf(proj, "SCOPE_CHANGED")).toHaveLength(0);
    expect(guardPolicyRows(proj)).toHaveLength(0);
  });

  test("memory strict allows an already-on fence without changing state or recording a row", () => {
    const { proj, state } = project("enterprise");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const unchanged = run(UTILITY, ["config-change", "--guard.plan-approval", "on"], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("Fence plan-approval is already on");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(rowsOf(proj, "GUARD_RESTORED")).toHaveLength(0);
  });

  test("config list names the eleven switchable settings in order", () => {
    const { proj } = project("classic");
    const listed = run(UTILITY, ["config-list", "--json"], proj, FENCE_ENV_CLEAR);
    expect(listed.status, listed.stderr).toBe(0);
    expect(Object.keys(JSON.parse(listed.stdout))).toEqual([
      "depth",
      "test-strategy",
      "review",
      "guard-policy",
      "sensors",
      "learnings",
      "summary-confirmation",
      "guard.plan-approval",
      "guard.review-freeze",
      "guard.state-transition",
      "guard.reviewer-scope",
    ]);
  });

  test("the environment kill switch shows as the source and writes nothing", () => {
    const { proj, state } = project("enterprise");
    const before = readFileSync(state, "utf-8");
    const env = { ...FENCE_ENV_CLEAR, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" };
    expect(run(UTILITY, ["config-get", "guard.plan-approval"], proj, env).stdout).toBe(
      "off (env AIDLC_DISABLE_PLAN_APPROVAL_GUARD)\n",
    );
    const status = run(UTILITY, ["status"], proj, env);
    expect(status.stdout).toContain(
      `${STATUS_FENCES}plan-approval off (env AIDLC_DISABLE_PLAN_APPROVAL_GUARD), review-freeze on (default), state-transition on (default), reviewer-scope on (default), human-presence on (default)\n`,
    );
    const presence = run(UTILITY, ["status"], proj, { ...FENCE_ENV_CLEAR, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(presence.stdout).toContain("human-presence off (env AIDLC_SKIP_HUMAN_PRESENCE_GUARD)");
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
  });

  test("an invalid fence value or an unknown fence is refused without state or audit changes", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    const maybe = run(UTILITY, ["config-change", "--guard.plan-approval", "maybe"], proj);
    expect(maybe.status).toBe(1);
    expect(maybe.stderr).toContain('--guard.plan-approval requires <on|off>; received \\"maybe\\".');
    const unknown = run(UTILITY, ["config-change", "--guard.nonsense", "off"], proj);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("config-change does not accept --guard.nonsense.");
    const read = run(UTILITY, ["config-get", "guard.nonsense"], proj);
    expect(read.status).toBe(1);
    expect(read.stderr).toContain('Unknown config key: \\"guard.nonsense\\".');
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(rowsOf(proj, "GUARD_RESTORED")).toHaveLength(0);
  });

  test("a human-presence switch refuses the whole policy transaction", () => {
    const { proj, state } = project("classic");
    const before = readFileSync(state, "utf-8");
    const changed = run(
      UTILITY,
      ["config-change", "--guard-policy", "off", "--guard.human-presence", "off"],
      proj,
      FENCE_ENV_CLEAR,
    );
    expect(changed.status, changed.stderr).toBe(1);
    expect(JSON.parse(changed.stderr)).toEqual({
      error: "guard.human-presence has no per-work switch: human presence is the key holder, and only the machine-wide AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 lowers it.",
    });
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(guardPolicyRows(proj)).toHaveLength(0);
    expect(rowsOf(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(rowsOf(proj, "GUARD_RESTORED")).toHaveLength(0);
    expect(rowsOf(proj, "GUARD_STOOD_ASIDE")).toHaveLength(0);
    expect(run(UTILITY, ["config-get", "guard.human-presence"], proj, FENCE_ENV_CLEAR).stdout).toBe("on (default)\n");
    // The ledger fault fails the whole transaction, fence row included.
    const fresh = project("classic");
    const beforeFault = readFileSync(fresh.state, "utf-8");
    const failed = run(
      UTILITY,
      ["config-change", "--guard-policy", "strict", "--guard.plan-approval", "off"],
      fresh.proj,
      { AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT: "t333" },
    );
    expect(failed.status).toBe(1);
    expect(readFileSync(fresh.state, "utf-8")).toBe(beforeFault);
    expect(rowsOf(fresh.proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(guardPolicyRows(fresh.proj)).toHaveLength(0);
  });
});

describe("t333 (10) retired policy confirmation", () => {
  const relaxedNotice = "Guard Policy: relaxed was carried over from this piece of work's retired Change Control line. Under Guard Policy, relaxed now also lowers the plan-approval and review-freeze fences for work nobody directed, and every pass is recorded in the audit trail. Say 'guard policy relaxed' to keep it, or 'guard policy strict' to raise them again; this notice repeats until you choose.";
  const offNotice = "Guard Policy: off was carried over from this piece of work's retired Change Control line. Under Guard Policy, off now also lowers the plan-approval, review-freeze, state-transition and reviewer-scope fences for work nobody directed, and every pass is recorded in the audit trail. Say 'guard policy off' to keep it, or 'guard policy strict' to raise them again; this notice repeats until you choose.";
  const conflictNotice = "Guard Policy: this piece of work carries both `Guard Policy: off (set by you)` and the retired `Change Control: strict (from scope classic)`, so strict applies until you choose. Say 'guard policy strict', 'guard policy relaxed', or 'guard policy off' to keep one line; this notice repeats until you do.";

  test("conflicting policy lines enforce strict and repeat the notice until a typed choice leaves one line", () => {
    const { proj, state } = project("classic");
    const conflicted = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Guard Policy**: off (set by you)\n- **Change Control**: strict (from scope classic)",
    );
    writeFileSync(state, conflicted);
    expect(resolveGuardPolicy(proj, conflicted)).toMatchObject({
      value: "strict",
      source: "conflicting state lines",
      conflict: { guardPolicy: "off (set by you)", changeControl: "strict (from scope classic)" },
    });
    const config = run(UTILITY, ["config-get", "guard-policy"], proj, FENCE_ENV_CLEAR);
    expect(config.status, config.stderr).toBe(0);
    expect(config.stdout).toBe("strict (from conflicting state lines)\n");
    const status = run(UTILITY, ["status"], proj, FENCE_ENV_CLEAR);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${STATUS_POLICY}strict (from conflicting state lines)\n`);
    for (const args of [[], ["--resume"]]) {
      const next = runOrchestrateNext(ORCHESTRATE, proj, args);
      expect(next.status, next.stderr).toBe(0);
      expect(next.directive?.change_notices).toEqual([conflictNotice]);
      for (const part of next.steering) expect(part.change_notices).toEqual([conflictNotice]);
      expect(readFileSync(state, "utf-8")).toBe(conflicted);
    }

    const generation = setField(conflicted, "Current Stage", "code-generation");
    writeFileSync(state, generation);
    writeActiveDirectiveMarker(proj, {
      kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(generation),
    });
    mkdirSync(join(proj, "src"), { recursive: true });
    const guarded = Bun.spawnSync({
      cmd: [BUN, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")],
      cwd: proj,
      env: { ...process.env, ...FENCE_ENV_CLEAR, CLAUDE_PROJECT_DIR: proj },
      stdin: Buffer.from(JSON.stringify({
        hook_event_name: "PreToolUse", tool_name: "Write", cwd: proj,
        tool_input: { file_path: join(proj, "src", "unapproved.ts"), content: "export const unapproved = true;\n" },
      })),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(guarded.exitCode, guarded.stderr.toString()).toBe(2);
    expect(rowsOf(proj, "PLAN_APPROVAL_BLOCKED")).toHaveLength(1);
    expect(rowsOf(proj, "GUARD_STOOD_ASIDE")).toHaveLength(0);
    expect(guardPolicyRows(proj)).toHaveLength(0);

    recordHumanPrompt(proj, "guard policy off");
    const confirmed = readFileSync(state, "utf-8");
    expect(confirmed.match(/^- \*\*Guard Policy\*\*:.*$/gm)).toEqual(["- **Guard Policy**: off (set by you)"]);
    expect(getField(confirmed, CHANGE_CONTROL_FIELD)).toBeNull();
    expect(confirmed).not.toContain("- **Change Control**:");
    const rows = guardPolicyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("off");
    const unchanged = run(UTILITY, ["config-change", "--guard-policy", "off"], proj, FENCE_ENV_CLEAR);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(unchanged.stdout).toContain("Guard Policy is already off (set by you)");
    expect(readFileSync(state, "utf-8")).toBe(confirmed);
    expect(guardPolicyRows(proj)).toEqual(rows);
    const next = runOrchestrateNext(ORCHESTRATE, proj);
    expect(next.status, next.stderr).toBe(0);
    expect(next.directive?.change_notices).toBeUndefined();
    for (const part of next.steering) expect(part.change_notices).toBeUndefined();
  });

  test("agreeing policy lines use Guard Policy silently and the next write removes the retired line", () => {
    const { proj, state } = project("classic");
    const agreed = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Guard Policy**: relaxed (set by you)\n- **Change Control**: relaxed (from scope classic)",
    );
    writeFileSync(state, agreed);
    const policy = resolveGuardPolicy(proj, agreed);
    expect(policy.value).toBe("relaxed");
    expect(policy.source).toBe("you");
    expect(policy.conflict).toBeUndefined();
    const next = runOrchestrateNext(ORCHESTRATE, proj);
    expect(next.status, next.stderr).toBe(0);
    expect(next.directive?.change_notices).toBeUndefined();
    for (const part of next.steering) expect(part.change_notices).toBeUndefined();
    expect(readFileSync(state, "utf-8")).toBe(agreed);

    const changed = run(UTILITY, ["config-change", "--guard-policy", "strict"], proj, FENCE_ENV_CLEAR);
    expect(changed.status, changed.stderr).toBe(0);
    const confirmed = readFileSync(state, "utf-8");
    expect(confirmed.match(/^- \*\*Guard Policy\*\*:.*$/gm)).toEqual(["- **Guard Policy**: strict (set by you)"]);
    expect(getField(confirmed, CHANGE_CONTROL_FIELD)).toBeNull();
    expect(confirmed).not.toContain("- **Change Control**:");
    expect(resolveGuardPolicy(proj, confirmed).value).toBe("strict");
  });

  test("next repeats the retired relaxed notice without changing state bytes", () => {
    const { proj, state } = project("classic");
    const retired = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: relaxed (from scope classic)",
    );
    writeFileSync(state, retired);
    for (const args of [[], ["--resume"]]) {
      const next = runOrchestrateNext(ORCHESTRATE, proj, args);
      expect(next.status, next.stderr).toBe(0);
      expect(next.directive?.kind).toBe("run-stage");
      expect(next.directive?.change_notices).toEqual([relaxedNotice]);
      for (const part of next.steering) expect(part.change_notices).toEqual([relaxedNotice]);
      expect(readFileSync(state, "utf-8")).toBe(retired);
    }
  });

  test("a retired relaxed line held strict by memory announces nothing: the effective policy lowers no fence", () => {
    const { proj, state } = project("classic");
    const retired = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: relaxed (from scope classic)",
    );
    writeFileSync(state, retired);
    declareMemoryMode(proj, "project", "strict");
    expect(resolveGuardPolicy(proj, retired).value).toBe("strict");
    const next = runOrchestrateNext(ORCHESTRATE, proj);
    expect(next.status, next.stderr).toBe(0);
    expect(next.directive?.kind).toBe("run-stage");
    expect(next.directive?.change_notices).toBeUndefined();
    expect(readFileSync(state, "utf-8")).toBe(retired);
  });

  test("next announces all four fences for retired off without changing state bytes", () => {
    const { proj, state } = project("classic");
    const retired = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: off (from scope classic)",
    );
    writeFileSync(state, retired);
    const next = runOrchestrateNext(ORCHESTRATE, proj);
    expect(next.status, next.stderr).toBe(0);
    expect(next.directive?.kind).toBe("run-stage");
    expect(next.directive?.change_notices).toEqual([offNotice]);
    for (const part of next.steering) expect(part.change_notices).toEqual([offNotice]);
    expect(readFileSync(state, "utf-8")).toBe(retired);
  });

  test("next leaves retired strict silent and state bytes unchanged", () => {
    const { proj, state } = project("classic");
    const retired = readFileSync(state, "utf-8").replace(
      /^- \*\*Guard Policy\*\*:.*$/m,
      "- **Change Control**: strict (from scope classic)",
    );
    writeFileSync(state, retired);
    const next = runOrchestrateNext(ORCHESTRATE, proj);
    expect(next.status, next.stderr).toBe(0);
    expect(next.directive?.kind).toBe("run-stage");
    expect(next.directive?.change_notices).toBeUndefined();
    expect(readFileSync(state, "utf-8")).toBe(retired);
  });

  test("confirming unchanged relaxed policy renames the retired field and stops the next notice", () => {
    for (const source of ["from scope classic", "set by you"]) {
      const { proj, state } = project("classic");
      const retired = readFileSync(state, "utf-8").replace(
        /^- \*\*Guard Policy\*\*:.*$/m,
        `- **Change Control**: relaxed (${source})`,
      );
      writeFileSync(state, retired);
      recordHumanPrompt(proj, "/aidlc --guard-policy relaxed");
      const confirmed = readFileSync(state, "utf-8");
      expect(confirmed).toContain("- **Guard Policy**: relaxed (set by you)");
      expect(getField(confirmed, CHANGE_CONTROL_FIELD)).toBeNull();
      // Changing the source already records a row; a field-only rename does not.
      expect(guardPolicyRows(proj)).toHaveLength(source === "set by you" ? 0 : 1);
      const next = runOrchestrateNext(ORCHESTRATE, proj);
      expect(next.status, next.stderr).toBe(0);
      expect(next.directive?.kind).toBe("run-stage");
      expect(next.directive?.change_notices).toBeUndefined();
      expect(readFileSync(state, "utf-8")).toBe(confirmed);
    }
  });

  test("retired guard policies preserve initial approval requirements without changing the fence setting", () => {
    for (const policy of ["relaxed", "strict"]) {
      const { proj, state } = project("classic");
      const retired = setField(readFileSync(state, "utf-8"), "Current Stage", "code-generation")
        .replace(/^- \*\*Guard Policy\*\*:.*$/m, `- **Change Control**: ${policy} (from scope classic)`);
      writeFileSync(state, retired);
      writeActiveDirectiveMarker(proj, {
        kind: "run-stage",
        stage: "code-generation",
        state_sha256: stateDigest(retired),
      });
      mkdirSync(join(proj, "src"), { recursive: true });
      const sourcePath = join(proj, "src", "unapproved.ts");
      const guarded = Bun.spawnSync({
        cmd: [BUN, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")],
        cwd: proj,
        env: { ...process.env, ...FENCE_ENV_CLEAR, CLAUDE_PROJECT_DIR: proj },
        stdin: Buffer.from(JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: sourcePath, content: "export const unapproved = true;\n" },
          cwd: proj,
        })),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(guarded.exitCode, guarded.stderr.toString()).toBe(2);
      expect(guarded.stdout.toString()).toBe("");
      expect(rowsOf(proj, "GUARD_STOOD_ASIDE")).toHaveLength(0);
      if (policy === "relaxed") {
        expect(guarded.stderr.toString()).toContain("CODE_GENERATION_EXECUTION_INELIGIBLE");
      }
      const fence = run(UTILITY, ["config-get", "guard.plan-approval"], proj, FENCE_ENV_CLEAR);
      expect(fence.status, fence.stderr).toBe(0);
      expect(fence.stdout).toStartWith(policy === "relaxed" ? "off (" : "on (");
      expect(readFileSync(state, "utf-8")).toBe(retired);
    }
  });
});

// covers: function:resolveChangeControl, function:memoryChangeControlDeclarations,
// function:parseChangeControlStateLine, function:parseChangeControl,
// function:formatChangeControl, function:scopeChangeControlDefault,
// function:governedChangeControl, function:recordChangeControlSet,
// function:memorySectionBody, function:structuredField,
// subcommand:aidlc-utility:change-control, subcommand:aidlc-utility:status,
// subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:scope-change,
// subcommand:aidlc-orchestrate:next, audit:CHANGE_CONTROL_SET
//
// t333 - Change Control is one setting with two values, strict and relaxed.
// The resolved value is the intent's own valid state line when present; a
// missing line stays strict for compatibility, then any memory layer that
// declares strict wins. These tests pin
// the resolver precedence, the scope defaults the maintainer decided, the
// memory grammar and its validation error, the source labels the human sees,
// the verb and flag surfaces, and the CHANGE_CONTROL_SET rows.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  CHANGE_CONTROL_FIELD,
  formatChangeControl,
  getField,
  governedChangeControl,
  loadScopeMapping,
  memoryChangeControlDeclarations,
  memorySectionBody,
  parseChangeControl,
  parseChangeControlStateLine,
  readAuditShardEvents,
  resolveChangeControl,
  scopeChangeControlDefault,
  setField,
  structuredField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function run(tool: string, args: string[], proj: string, env: Record<string, string> = {}) {
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
      "change control fixture",
      "--label",
      "change-control",
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

function declareMemoryMode(proj: string, layer: "org" | "team" | "project", mode: string): void {
  const path = memoryFile(proj, layer);
  const content = readFileSync(path, "utf-8");
  expect(content).toContain("## Change Control");
  writeFileSync(
    path,
    content.replace("## Change Control\n", `## Change Control\n\nMode: ${mode}\n`),
  );
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
      "selected change control fixture",
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

function declareAltMemoryStrict(proj: string): void {
  const path = altMemoryFile(proj);
  const content = readFileSync(path, "utf-8");
  writeFileSync(
    path,
    `${content.trimEnd()}\n\n## Change Control\n\nMode: strict\n`,
  );
}

function selectedRows(proj: string, intent: string, space: string, event: string) {
  return readAuditShardEvents(proj, intent, space).filter((entry) => entry.event === event);
}

function changeControlRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "CHANGE_CONTROL_SET");
}

describe("t333 (1) scope defaults", () => {
  test("every shipped scope declares the value the maintainer decided", () => {
    const mapping = loadScopeMapping();
    const expected: Record<string, "strict" | "relaxed"> = {
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
    for (const [scope, value] of Object.entries(expected)) {
      expect(mapping[scope]?.changeControl, scope).toBe(value);
      expect(scopeChangeControlDefault(scope), scope).toBe(value);
    }
  });

  test("a scope without a change_control line, or an unknown scope, defaults to strict", () => {
    expect(scopeChangeControlDefault("no-such-scope")).toBe("strict");
    expect(scopeChangeControlDefault(null)).toBe("strict");
  });

  test("every scope file documents its value in prose", () => {
    const scopesDir = join(AIDLC_SRC, "scopes");
    for (const scope of Object.keys(loadScopeMapping())) {
      const body = readFileSync(join(scopesDir, `aidlc-${scope}.md`), "utf-8");
      expect(body, scope).toMatch(/^change_control: (strict|relaxed)$/m);
      expect(body, scope).toMatch(/Change Control defaults to (strict|relaxed)/);
    }
  });
});

describe("t333 (2) the grammar", () => {
  test("the state line is read by value; the label after it is for humans", () => {
    expect(parseChangeControlStateLine("relaxed (from scope classic)")).toEqual({
      value: "relaxed",
      source: "scope classic",
    });
    expect(parseChangeControlStateLine("strict (from project.md)")).toEqual({
      value: "strict",
      source: "project.md",
    });
    expect(parseChangeControlStateLine("strict (set by you)")).toEqual({
      value: "strict",
      source: "you",
    });
    expect(parseChangeControlStateLine("Relaxed")).toEqual({ value: "relaxed", source: "you" });
    expect(parseChangeControlStateLine("sometimes (from scope poc)")).toBeNull();
    expect(parseChangeControlStateLine("")).toBeNull();
    expect(parseChangeControlStateLine(null)).toBeNull();
  });

  test("source labels render the three shapes the status line shows", () => {
    expect(formatChangeControl("strict", "project.md")).toBe("strict (from project.md)");
    expect(formatChangeControl("relaxed", "scope classic")).toBe("relaxed (from scope classic)");
    expect(formatChangeControl("strict", "you")).toBe("strict (set by you)");
    expect(formatChangeControl("strict", "not set")).toBe("strict (not set)");
  });

  test("a Mode value is a closed list read through the Testing Posture field grammar", () => {
    expect(parseChangeControl("strict")).toBe("strict");
    expect(parseChangeControl("**Relaxed**")).toBe("relaxed");
    expect(parseChangeControl("`strict`")).toBe("strict");
    expect(parseChangeControl("loose")).toBeNull();
    expect(parseChangeControl(undefined)).toBeNull();
    expect(structuredField("- **Mode**: strict", "Mode")).toBe("strict");
    expect(structuredField("Mode: relaxed", "Mode")).toBe("relaxed");
    expect(structuredField("Methodology: tdd", "Mode")).toBeNull();
  });

  test("the section body ignores commented headings and commented lines", () => {
    const content = [
      "# Team",
      "",
      "<!-- ## Change Control -->",
      "## Testing Posture",
      "",
      "Methodology: tdd",
      "",
      "## Change Control",
      "",
      "<!-- Mode: strict -->",
      "Mode: relaxed",
      "",
      "## Deployment",
      "",
      "Mode: strict",
    ].join("\n");
    const body = memorySectionBody(content, "## Change Control");
    expect(structuredField(body, "Mode")).toBe("relaxed");
    expect(body).not.toContain("Deployment");
  });
});

describe("t333 (3) resolution precedence", () => {
  test("a fresh intent carries the scope default with its source", () => {
    const { proj, state } = project("classic");
    expect(getField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "relaxed (from scope classic)",
    );
    const resolved = resolveChangeControl(proj);
    expect(resolved.value).toBe("relaxed");
    expect(resolved.source).toBe("scope classic");
    expect(resolved.memoryStrict).toBeNull();
  });

  test("the intent line wins over the scope default", () => {
    const { proj, state } = project("enterprise");
    expect(resolveChangeControl(proj).value).toBe("strict");
    writeFileSync(
      state,
      setField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD, "relaxed (set by you)"),
    );
    const resolved = resolveChangeControl(proj);
    expect(resolved.value).toBe("relaxed");
    expect(resolved.source).toBe("you");
    expect(resolved.scopeDefault).toBe("strict");
  });

  test("memory strict beats both, from any layer, and names its file", () => {
    for (const layer of ["org", "team", "project"] as const) {
      const { proj } = project("poc");
      declareMemoryMode(proj, layer, "strict");
      const resolved = resolveChangeControl(proj);
      expect(resolved.value).toBe("strict");
      expect(resolved.source).toBe(`${layer}.md`);
      expect(resolved.memoryStrict?.path).toBe(memoryFile(proj, layer));
      expect(resolved.intent?.value).toBe("relaxed");
    }
  });

  test("memory relaxed and an absent section have no effect", () => {
    const { proj } = project("enterprise");
    declareMemoryMode(proj, "project", "relaxed");
    expect(memoryChangeControlDeclarations(proj)).toEqual([
      { layer: "project", path: memoryFile(proj, "project"), value: "relaxed" },
    ]);
    expect(resolveChangeControl(proj).value).toBe("strict");
    expect(resolveChangeControl(proj).source).toBe("scope enterprise");
  });

  test("an invalid memory value is a validation error naming the file and the allowed values", () => {
    const { proj } = project("classic");
    declareMemoryMode(proj, "team", "sometimes");
    expect(() => resolveChangeControl(proj)).toThrow(
      `Invalid Change Control Mode "sometimes" in ${memoryFile(proj, "team")} (section: Change Control). Expected one of: strict, relaxed.`,
    );
  });

  test("a state file without the line stays strict for intents created before the setting", () => {
    const { proj, state } = project("classic");
    const content = readFileSync(state, "utf-8").replace(/^- \*\*Change Control\*\*:.*\n/m, "");
    expect(getField(content, CHANGE_CONTROL_FIELD)).toBeNull();
    writeFileSync(state, content);
    const resolved = resolveChangeControl(proj);
    expect(resolved.value).toBe("strict");
    expect(resolved.source).toBe("not set");
    expect(resolved.stateValue).toBe("strict");
    expect(resolved.intent).toBeNull();
  });

  test("an invalid state line is a validation error that names the field and repair command", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      setField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD, "stricct (set by you)"),
    );
    const message =
      `Invalid Change Control "stricct (set by you)" in ${state} (field: Change Control). ` +
      "Expected one of: strict, relaxed. Run /aidlc --change-control strict or " +
      "/aidlc --change-control relaxed to repair it.";
    expect(() => resolveChangeControl(proj)).toThrow(message);
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Change Control: unavailable (${message})\n`);
  });
});

describe("t333 (4) the verb, the flag, and the status line", () => {
  test("the verb rewrites the line, records CHANGE_CONTROL_SET, and status shows the human as the source", () => {
    const { proj, state } = project("classic");
    const flipped = run(UTILITY, ["change-control", "strict"], proj);
    expect(flipped.status, flipped.stderr).toBe(0);
    expect(flipped.stdout).toBe(
      "Change Control changed: relaxed (from scope classic) to strict (set by you)\n",
    );
    expect(getField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "strict (set by you)",
    );
    const rows = changeControlRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
    const status = run(UTILITY, ["status"], proj);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("Change Control: strict (set by you)\n");
    const again = run(UTILITY, ["change-control", "strict"], proj);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe("Change Control is already strict (set by you)\n");
    expect(changeControlRows(proj)).toHaveLength(1);
  });

  test("the verb repairs an invalid state line and records its old text", () => {
    const { proj, state } = project("classic");
    writeFileSync(
      state,
      setField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD, "stricct (set by you)"),
    );
    const repaired = run(UTILITY, ["change-control", "strict"], proj);
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toBe(
      "Change Control changed: stricct (set by you) to strict (set by you)\n",
    );
    expect(getField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "strict (set by you)",
    );
    const rows = changeControlRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("stricct (set by you)");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });

  test("the verb refuses a value outside the two", () => {
    const { proj } = project("classic");
    const bad = run(UTILITY, ["change-control", "loose"], proj);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(
      'change-control requires exactly one of: strict, relaxed (received \\"loose\\").',
    );
    const missing = run(UTILITY, ["change-control"], proj);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("change-control requires exactly one of: strict, relaxed.");
  });

  test("a memory strict refuses the flip with the exact message and leaves the line alone", () => {
    const { proj, state } = project("classic");
    declareMemoryMode(proj, "project", "strict");
    const before = readFileSync(state, "utf-8");
    const refused = run(UTILITY, ["change-control", "relaxed"], proj);
    expect(refused.status).toBe(1);
    expect(refused.stderr.trim()).toBe(
      JSON.stringify({
        error:
          `Change Control is set to strict in ${memoryFile(proj, "project")} (section: Change Control), ` +
          "so it cannot be changed from chat. Edit that line to change it for everyone on this repo.",
      }),
    );
    expect(readFileSync(state, "utf-8")).toBe(before);
    expect(changeControlRows(proj)).toHaveLength(0);
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain("Change Control: strict (from project.md)\n");
  });

  test("the status line shows the scope as the source until someone changes it", () => {
    const { proj } = project("poc");
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain("Change Control: relaxed (from scope poc)\n");
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

  test("the flag routes to the verb on a live workflow and refuses a bad value", () => {
    const { proj } = project("classic");
    const routed = run(ORCHESTRATE, ["next", "--change-control", "strict"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    const directive = lastDirective(routed.stdout);
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("aidlc-utility.ts change-control strict");
    const bad = lastDirective(run(ORCHESTRATE, ["next", "--change-control", "maybe"], proj).stdout);
    expect(bad.kind).toBe("error");
    expect(bad.message).toBe('--change-control requires <strict|relaxed>; received "maybe".');
    const bare = lastDirective(run(ORCHESTRATE, ["next", "--change-control"], proj).stdout);
    expect(bare.message).toBe("--change-control requires <strict|relaxed>.");
  });

  test("the flag at creation writes the human as the source", () => {
    const { state } = project("classic", ["--change-control", "strict"]);
    expect(getField(readFileSync(state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "strict (set by you)",
    );
  });

  test("the flag at creation cannot relax a memory strict", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    declareMemoryMode(proj, "org", "strict");
    const refused = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "x", "--change-control", "relaxed"],
      proj,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `Change Control is set to strict in ${memoryFile(proj, "org")} (section: Change Control)`,
    );
    const created = run(
      UTILITY,
      ["intent-create", "--scope", "classic", "--arguments", "x", "--label", "mem"],
      proj,
    );
    expect(created.status, created.stderr).toBe(0);
    expect(resolveChangeControl(proj).source).toBe("org.md");
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain("Change Control: strict (from org.md)\n");
  });

  test("a scope change carries a scope-supplied value to the new default and keeps a human's value", () => {
    const followed = project("classic");
    const changed = run(UTILITY, ["scope-change", "--scope", "enterprise"], followed.proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(followed.state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "strict (from scope enterprise)",
    );
    const rows = changeControlRows(followed.proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope enterprise");

    const kept = project("classic", ["--change-control", "relaxed"]);
    const keptChange = run(UTILITY, ["scope-change", "--scope", "enterprise"], kept.proj);
    expect(keptChange.status, keptChange.stderr).toBe(0);
    expect(getField(readFileSync(kept.state, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "relaxed (set by you)",
    );
    expect(changeControlRows(kept.proj)).toHaveLength(0);
  });

  test("a scope change commits its state and audit rows together", () => {
    const moved = project("enterprise");
    const beforeFault = readFileSync(moved.state, "utf-8");
    const failed = run(
      UTILITY,
      ["scope-change", "--scope", "classic"],
      moved.proj,
      { AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT: "t333" },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Cannot record the scope change");
    expect(failed.stderr).toContain("injected ledger fault: t333");
    expect(readFileSync(moved.state, "utf-8")).toBe(beforeFault);
    expect(readAuditShardEvents(moved.proj).filter((row) => row.event === "SCOPE_CHANGED")).toHaveLength(0);
    expect(changeControlRows(moved.proj)).toHaveLength(0);

    const changed = run(UTILITY, ["scope-change", "--scope", "classic"], moved.proj);
    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(moved.state, "utf-8"), "Scope")).toBe("classic");
    const scopeRows = readAuditShardEvents(moved.proj).filter((row) => row.event === "SCOPE_CHANGED");
    expect(scopeRows).toHaveLength(1);
    const rows = changeControlRows(moved.proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "Source")).toBe("scope classic");
  });

  test("a lineless legacy intent stays strict across a scope change without a change row", () => {
    const legacy = project("enterprise");
    const withoutLine = readFileSync(legacy.state, "utf-8").replace(
      /^- \*\*Change Control\*\*:.*\n/m,
      "",
    );
    writeFileSync(legacy.state, withoutLine);
    const changed = run(UTILITY, ["scope-change", "--scope", "classic"], legacy.proj);
    expect(changed.status, changed.stderr).toBe(0);
    const after = readFileSync(legacy.state, "utf-8");
    expect(getField(after, "Scope")).toBe("classic");
    expect(getField(after, CHANGE_CONTROL_FIELD)).toBeNull();
    expect(resolveChangeControl(legacy.proj).value).toBe("strict");
    expect(changeControlRows(legacy.proj)).toHaveLength(0);
  });

  test("scope-change refuses an invalid state line without writing state or audit", () => {
    const invalid = project("enterprise");
    writeFileSync(
      invalid.state,
      setField(readFileSync(invalid.state, "utf-8"), CHANGE_CONTROL_FIELD, "stricct (set by you)"),
    );
    const before = readFileSync(invalid.state, "utf-8");
    const refused = run(UTILITY, ["scope-change", "--scope", "classic"], invalid.proj);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`Invalid Change Control \\"stricct (set by you)\\" in ${invalid.state}`);
    expect(readFileSync(invalid.state, "utf-8")).toBe(before);
    expect(readAuditShardEvents(invalid.proj).filter((row) => row.event === "SCOPE_CHANGED")).toHaveLength(0);
    expect(changeControlRows(invalid.proj)).toHaveLength(0);
  });
});

describe("t333 (5) an explicit workflow selection governs Change Control end to end", () => {
  test("a selected space's memory strict refuses a relaxed change and logs only to that intent", () => {
    const selected = selectedProject();
    declareAltMemoryStrict(selected.proj);
    const beforeState = readFileSync(selected.targetState, "utf-8");
    const beforeDefault = readAuditShardEvents(
      selected.proj,
      selected.defaultIntent,
      "default",
    );
    const beforeTarget = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");

    const refused = run(
      UTILITY,
      ["change-control", "relaxed", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(altMemoryFile(selected.proj));
    expect(readFileSync(selected.targetState, "utf-8")).toBe(beforeState);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(
      beforeDefault,
    );
    const targetAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    expect(targetAfter).toHaveLength(beforeTarget.length + 1);
    const refusalRow = targetAfter[targetAfter.length - 1];
    expect(refusalRow.event).toBe("ERROR_LOGGED");
    expect(auditBlockField(refusalRow.block, "Error")).toContain(
      "<project-dir>/aidlc/spaces/alt/memory/project.md",
    );
    expect(targetAfter.filter((row) => row.event === "CHANGE_CONTROL_SET")).toHaveLength(0);
  });
  test("a selected relaxed change updates and audits only the selected intent", () => {
    const selected = selectedProject();
    const defaultBefore = selectedRows(
      selected.proj,
      selected.defaultIntent,
      "default",
      "CHANGE_CONTROL_SET",
    );

    const changed = run(
      UTILITY,
      ["change-control", "relaxed", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    expect(getField(readFileSync(selected.targetState, "utf-8"), CHANGE_CONTROL_FIELD)).toBe(
      "relaxed (set by you)",
    );
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "CHANGE_CONTROL_SET")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "CHANGE_CONTROL_SET")).toEqual(
      defaultBefore,
    );
  });

  test("a selected scope change writes both rows only to the selected intent", () => {
    const selected = selectedProject();

    const changed = run(
      UTILITY,
      ["scope-change", "--scope", "classic", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "CHANGE_CONTROL_SET")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "SCOPE_CHANGED")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "CHANGE_CONTROL_SET")).toHaveLength(0);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "SCOPE_CHANGED")).toHaveLength(0);
  });

  test("a selected scope change stays memory-strict and writes no Change Control row", () => {
    const selected = selectedProject();
    declareAltMemoryStrict(selected.proj);

    const changed = run(
      UTILITY,
      ["scope-change", "--scope", "classic", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(changed.status, changed.stderr).toBe(0);
    expect(resolveChangeControl(selected.proj, null, {
      selection: { intent: selected.targetIntent, space: "alt" },
    }).value).toBe("strict");
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "CHANGE_CONTROL_SET")).toHaveLength(0);
    expect(selectedRows(selected.proj, selected.targetIntent, "alt", "SCOPE_CHANGED")).toHaveLength(1);
    expect(selectedRows(selected.proj, selected.defaultIntent, "default", "SCOPE_CHANGED")).toHaveLength(0);
  });

  test("status reports the selected intent's value and source", () => {
    const selected = selectedProject("classic");

    const status = run(UTILITY, ["status", ...selectedArgs(selected.targetIntent)], selected.proj);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("Change Control: relaxed (from scope classic)\n");
    expect(status.stdout).not.toContain("Change Control: strict (from scope enterprise)\n");
  });

  test("a selected invalid state line names the selected state file", () => {
    const selected = selectedProject("classic");
    writeFileSync(
      selected.targetState,
      setField(
        readFileSync(selected.targetState, "utf-8"),
        CHANGE_CONTROL_FIELD,
        "stricct (set by you)",
      ),
    );

    const status = run(UTILITY, ["status", ...selectedArgs(selected.targetIntent)], selected.proj);

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`Invalid Change Control "stricct (set by you)" in ${selected.targetState}`);
  });
});

describe("t333 (6) a memory edit observed by a governed check", () => {
  test("the next governed check writes one CHANGE_CONTROL_SET row naming the memory file, once", () => {
    const { proj } = project("classic");
    expect(governedChangeControl(proj).value).toBe("relaxed");
    expect(changeControlRows(proj)).toHaveLength(0);
    declareMemoryMode(proj, "team", "strict");
    const observed = governedChangeControl(proj);
    expect(observed.value).toBe("strict");
    let rows = changeControlRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Old Value")).toBe("relaxed");
    expect(auditBlockField(rows[0].block, "New Value")).toBe("strict");
    expect(auditBlockField(rows[0].block, "Source")).toBe("team.md");
    governedChangeControl(proj);
    governedChangeControl(proj);
    expect(changeControlRows(proj)).toHaveLength(1);

    // The memory edit is undone: the intent's own line governs again and the
    // ledger records that flip too, naming the line's source.
    const path = memoryFile(proj, "team");
    writeFileSync(path, readFileSync(path, "utf-8").replace("Mode: strict\n", ""));
    expect(governedChangeControl(proj).value).toBe("relaxed");
    rows = changeControlRows(proj);
    expect(rows).toHaveLength(2);
    expect(auditBlockField(rows[1].block, "Old Value")).toBe("strict");
    expect(auditBlockField(rows[1].block, "New Value")).toBe("relaxed");
    expect(auditBlockField(rows[1].block, "Source")).toBe("scope classic");
  });

  test("a governed check leaves a legacy lineless intent strict and writes no row", () => {
    const { proj, state } = project("classic");
    const withoutLine = readFileSync(state, "utf-8").replace(/^- \*\*Change Control\*\*:.*\n/m, "");
    writeFileSync(state, withoutLine);
    const resolved = governedChangeControl(proj);
    expect(resolved.value).toBe("strict");
    expect(resolved.source).toBe("not set");
    expect(readFileSync(state, "utf-8")).toBe(withoutLine);
    expect(changeControlRows(proj)).toHaveLength(0);
    const status = run(UTILITY, ["status"], proj);
    expect(status.stdout).toContain("Change Control: strict (not set)\n");
  });

  test("a governed check with no state file resolves strict and writes nothing", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const resolved = governedChangeControl(proj);
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
      ["change-control", "loose", ...selectedArgs(selected.targetIntent)],
      selected.proj,
    );

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'change-control requires exactly one of: strict, relaxed (received \\"loose\\").',
    );
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
      ["change-control", "relaxed", "--space", "alt", "--intent", "not-a-real-intent"],
      selected.proj,
    );

    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr.trim().split("\n").pop()!)).toHaveProperty("error");
    expect(existsSync(join(altIntents, "not-a-real-intent"))).toBe(false);
    expect(readdirSync(altIntents).sort()).toEqual(beforeAlt);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(
      beforeDefault,
    );
  });

  test("a selected space with no resolvable intent records nothing and creates nothing", () => {
    const selected = ambiguousDefault();
    const emptyIntents = join(selected.proj, "aidlc", "spaces", "empty", "intents");
    const createdSpace = run(UTILITY, ["space-create", "empty"], selected.proj);
    expect(createdSpace.status, createdSpace.stderr).toBe(0);
    const beforeEmpty = existsSync(emptyIntents) ? readdirSync(emptyIntents).sort() : null;

    const refused = run(UTILITY, ["change-control", "loose", "--space", "empty"], selected.proj);

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
        "change-control",
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
    expect(readFileSync(`${barrier}.selected`, "utf-8")).toBe(
      `alt/${selected.targetIntent}\n`,
    );
    writeFileSync(join(altIntents, "active-intent"), `${secondIntent}\n`);
    writeFileSync(`${barrier}.release`, "release\n");

    const [status, out, err] = await Promise.all([child.exited, stdout, stderr]);
    expect(status).toBe(1);
    expect(out).toBe("");
    expect(err).toContain(
      'change-control requires exactly one of: strict, relaxed (received \\"loose\\").',
    );
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

  test("a relaxed request into a memory-strict space is refused and creates nothing anywhere", () => {
    const selected = selectedProject("classic");
    declareAltMemoryStrict(selected.proj);
    const defaultBefore = snapshot(selected.proj, "default");
    const altBefore = snapshot(selected.proj, "alt");
    const defaultRows = readAuditShardEvents(selected.proj, selected.defaultIntent, "default");
    const altRows = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");

    const refused = run(
      UTILITY,
      [...CREATE, "--change-control", "relaxed", "--space", "alt"],
      selected.proj,
    );

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      `Change Control is set to strict in ${altMemoryFile(selected.proj)} (section: Change Control)`,
    );
    expect(snapshot(selected.proj, "default")).toEqual(defaultBefore);
    expect(snapshot(selected.proj, "alt")).toEqual(altBefore);
    expect(readAuditShardEvents(selected.proj, selected.defaultIntent, "default")).toEqual(defaultRows);
    // The refusal is recorded under the selected space, in its active intent.
    const altAfter = readAuditShardEvents(selected.proj, selected.targetIntent, "alt");
    expect(altAfter).toHaveLength(altRows.length + 1);
    expect(altAfter[altAfter.length - 1].event).toBe("ERROR_LOGGED");
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
    expect(getField(state, CHANGE_CONTROL_FIELD)).toBe("strict (from project.md)");
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
    expect(status.stdout).toContain("Change Control: strict (from project.md)\n");
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
    expect(status.stdout).toContain("Change Control: relaxed (from scope classic)\n");
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
        "--change-control",
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
    expect(getField(state, CHANGE_CONTROL_FIELD)).toBe("relaxed (set by you)");
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

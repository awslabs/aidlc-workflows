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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function run(tool: string, args: string[], proj: string) {
  const result = Bun.spawnSync({
    cmd: [BUN, tool, ...args, "--project-dir", proj],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
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

function changeControlRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "CHANGE_CONTROL_SET");
}

describe("t333 (1) scope defaults", () => {
  test("every shipped scope declares the value the maintainer decided", () => {
    const mapping = loadScopeMapping();
    const expected: Record<string, "strict" | "relaxed"> = {
      enterprise: "strict",
      "security-patch": "strict",
      workshop: "strict",
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
});

describe("t333 (5) a memory edit observed by a governed check", () => {
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

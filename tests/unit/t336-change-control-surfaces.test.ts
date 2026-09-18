// covers: subcommand:aidlc-graph:validate-grid, subcommand:aidlc-orchestrate:next,
// function:validateDirective, file:agents/aidlc-composer-agent.md, file:skills/aidlc/SKILL.md,
// file:knowledge/aidlc-composer-agent/composing.md
//
// t336 - the Guard Policy surfaces around the composer and the conductor:
// the validator checks the ONE value a proposal carries (three values; a
// relaxed or off proposal under a memory strict is refused, naming the file),
// echoes it under the new key and the retired one, still reads the retired
// flag and member for one release, the compose dispatch names the gate row,
// the composer's persona and knowledge describe the value, and
// `change_notices` is a legal universal directive field.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { GUARD_POLICY_RENAME_NOTICE, loadScopeMapping } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seedAidlcMemory,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const ORCHESTRATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function project(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  return proj;
}

function runValidateGrid(proj: string, proposal: unknown, extra: string[] = []) {
  const proposalPath = join(proj, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal), "utf-8");
  const result = spawnSync(
    BUN,
    [GRAPH_TOOL, "validate-grid", "--proposal", proposalPath, ...extra, "--project-dir", proj],
    { encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
  );
  return { rc: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** How many times the one-line rename notice appears in a stream. */
function renameNotices(stream: string): number {
  return stream.split("\n").filter((line) => line === GUARD_POLICY_RENAME_NOTICE).length;
}

/** The validator's JSON, narrowed to the fields these tests read. */
function validation(stdout: string): {
  valid: boolean;
  errors: string[];
  guard_policy?: string;
  change_control?: string;
} {
  const parsed: unknown = JSON.parse(stdout);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("valid" in parsed) ||
    typeof parsed.valid !== "boolean" ||
    !("errors" in parsed) ||
    !Array.isArray(parsed.errors)
  ) {
    throw new Error(`not a validation result: ${stdout}`);
  }
  const guardPolicy =
    "guard_policy" in parsed && typeof parsed.guard_policy === "string" ? parsed.guard_policy : undefined;
  const changeControl =
    "change_control" in parsed && typeof parsed.change_control === "string"
      ? parsed.change_control
      : undefined;
  return {
    valid: parsed.valid,
    errors: parsed.errors.filter((entry): entry is string => typeof entry === "string"),
    ...(guardPolicy === undefined ? {} : { guard_policy: guardPolicy }),
    ...(changeControl === undefined ? {} : { change_control: changeControl }),
  };
}

function declareMemoryStrict(proj: string): string {
  const memory = join(proj, "aidlc", "spaces", "default", "memory", "org.md");
  const content = readFileSync(memory, "utf-8");
  expect(content).toContain("## Guard Policy\n");
  writeFileSync(memory, content.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n"));
  return memory;
}

describe("t336 (1) validate-grid checks the proposal's Guard Policy value", () => {
  const featureGrid = () => loadScopeMapping().feature.stages;

  test("a valid value is echoed under both keys, from the flag or the proposal member, for all three values", () => {
    const proj = project();
    for (const value of ["strict", "relaxed", "off"]) {
      const flagged = runValidateGrid(proj, { stages: featureGrid() }, ["--guard-policy", value]);
      expect(flagged.rc, flagged.stderr).toBe(0);
      expect(validation(flagged.stdout)).toMatchObject({ valid: true, guard_policy: value, change_control: value });
      expect(renameNotices(flagged.stderr)).toBe(0);
      const member = runValidateGrid(proj, { stages: featureGrid(), guardPolicy: value });
      expect(member.rc, member.stderr).toBe(0);
      expect(validation(member.stdout)).toMatchObject({ valid: true, guard_policy: value, change_control: value });
      expect(renameNotices(member.stderr)).toBe(0);
    }
    const absent = runValidateGrid(proj, { stages: featureGrid() });
    expect(absent.rc).toBe(0);
    expect(validation(absent.stdout).guard_policy).toBeUndefined();
    expect(validation(absent.stdout).change_control).toBeUndefined();
  });

  test("the retired flag and member are still read, and the flag prints the rename notice once", () => {
    const proj = project();
    const flagged = runValidateGrid(proj, { stages: featureGrid() }, ["--change-control", "relaxed"]);
    expect(flagged.rc, flagged.stderr).toBe(0);
    expect(validation(flagged.stdout)).toMatchObject({ valid: true, guard_policy: "relaxed", change_control: "relaxed" });
    expect(renameNotices(flagged.stderr)).toBe(1);
    const member = runValidateGrid(proj, { stages: featureGrid(), changeControl: "strict" });
    expect(member.rc, member.stderr).toBe(0);
    expect(validation(member.stdout)).toMatchObject({ valid: true, guard_policy: "strict", change_control: "strict" });
    // The new spelling wins when a proposal carries both members, and the new flag wins over the retired one.
    const both = runValidateGrid(proj, { stages: featureGrid(), guardPolicy: "off", changeControl: "strict" });
    expect(both.rc, both.stderr).toBe(0);
    expect(validation(both.stdout)).toMatchObject({ valid: true, guard_policy: "off" });
    const bothFlags = runValidateGrid(proj, { stages: featureGrid() }, ["--change-control", "strict", "--guard-policy", "off"]);
    expect(bothFlags.rc, bothFlags.stderr).toBe(0);
    expect(validation(bothFlags.stdout)).toMatchObject({ valid: true, guard_policy: "off" });
    expect(renameNotices(bothFlags.stderr)).toBe(0);
  });

  test("a value outside the three rejects the grid", () => {
    const proj = project();
    const bad = runValidateGrid(proj, { stages: featureGrid(), guardPolicy: "loose" });
    expect(bad.rc).toBe(1);
    const result = validation(bad.stdout);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Guard Policy must be one of: strict, relaxed, off (got "loose").');
    expect(result.guard_policy).toBeUndefined();
    const bare = runValidateGrid(proj, { stages: featureGrid() }, ["--guard-policy"]);
    expect(bare.rc).toBe(1);
    expect(bare.stderr).toContain("validate-grid: --guard-policy requires <strict|relaxed|off>.");
    const retiredBare = runValidateGrid(proj, { stages: featureGrid() }, ["--change-control"]);
    expect(retiredBare.rc).toBe(1);
    expect(retiredBare.stderr).toContain("validate-grid: --change-control requires <strict|relaxed|off>.");
  });

  test("a relaxed or off proposal under a memory strict is refused with the message naming the file", () => {
    const proj = project();
    const memory = declareMemoryStrict(proj);
    for (const value of ["relaxed", "off"]) {
      const refused = runValidateGrid(proj, { stages: featureGrid(), guardPolicy: value });
      expect(refused.rc, value).toBe(1);
      expect(validation(refused.stdout).errors).toContain(
        `Guard Policy is set to strict in ${memory} (section: Guard Policy), so it cannot be changed from chat. Edit that line to change it for everyone on this repo.`,
      );
    }
    const allowed = runValidateGrid(proj, { stages: featureGrid(), guardPolicy: "strict" });
    expect(allowed.rc, allowed.stderr).toBe(0);
  });

  test("a memory strict written under the retired heading refuses the same way and names its section", () => {
    const proj = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(memory, `${readFileSync(memory, "utf-8").trimEnd()}\n\n## Change Control\n\nMode: strict\n`);
    const refused = runValidateGrid(proj, { stages: featureGrid() }, ["--guard-policy", "relaxed"]);
    expect(refused.rc).toBe(1);
    expect(validation(refused.stdout).errors).toContain(
      `Guard Policy is set to strict in ${memory} (section: Change Control), so it cannot be changed from chat. Edit that line to change it for everyone on this repo.`,
    );
  });
});

describe("t336 (2) the compose dispatch and composer guidance", () => {
  test("the front compose dispatch names the gate row and the creation flag", () => {
    const proj = project();
    const result = spawnSync(
      BUN,
      [ORCHESTRATE_TOOL, "next", "compose", "add a small feature", "--project-dir", proj],
      { encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
    );
    expect(result.status, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "{}");
    if (parsed === null || typeof parsed !== "object" || !("message" in parsed) || typeof parsed.message !== "string") {
      throw new Error(`not a print directive: ${result.stdout}`);
    }
    // The dispatch speaks the NEW spelling: one guardPolicy value over three
    // values, the "Guard Policy:" gate row, and the --guard-policy creation
    // flag. An earlier revision of this test pinned the retired spelling here
    // and so blessed a half-finished rename; the retired flag is still ACCEPTED
    // (covered by the validator cases above), but nothing the engine tells a
    // conductor to type may name it.
    expect(parsed.message).toContain("ONE guardPolicy value (strict|relaxed|off");
    expect(parsed.message).toContain('"Guard Policy: <guardPolicy> - <guardPolicyRationale>"');
    expect(parsed.message).toContain("--guard-policy <value>");
    expect(parsed.message).not.toContain("--change-control");
    expect(parsed.message).not.toContain("changeControl");
  });

  test("the composer persona and knowledge describe the value and its defaults", () => {
    const persona = readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-composer-agent.md"), "utf-8");
    expect(persona).toContain('"guardPolicy": "strict | relaxed | off"');
    expect(persona).toContain("`guardPolicy` is REQUIRED for every mode");
    expect(persona).toContain("`guard_policy: <the approved value>`");
    // The persona authors new scope files, so the retired key must not appear
    // as anything but the one documented migration read.
    expect(persona).not.toContain("`change_control:");
    expect(persona).not.toContain("--change-control");
    const knowledge = readFileSync(
      join(REPO_ROOT, "core", "knowledge", "aidlc-composer-agent", "composing.md"),
      "utf-8",
    );
    expect(knowledge).toContain("## Guard Policy");
    expect(knowledge).not.toContain("`change_control:");
    expect(knowledge).toContain(
      "strict on enterprise, security-patch,\n  and infra, relaxed everywhere else",
    );
  });
});

describe("t336 (3) change_notices is a universal directive field", () => {
  test("every kind accepts a string array and refuses anything else", () => {
    for (const directive of [
      { kind: "print", message: "x" },
      { kind: "done", reason: "x" },
      { kind: "error", message: "x" },
    ]) {
      const accepted = validateDirective({ ...directive, change_notices: ["one line"] });
      expect(accepted.valid, JSON.stringify(directive)).toBe(true);
      const refused = validateDirective({ ...directive, change_notices: "one line" });
      expect(refused.valid).toBe(false);
    }
  });
});

describe("t336 (4) every orchestrator skill teaches the new name only", () => {
  // The seven SKILL.md files are what a conductor reads to learn which flag to
  // type. They are authored per harness, so a rename lands in seven places or
  // in none: this branch found all seven still naming the retired flag while
  // every engine reader had moved, which made the deprecation notice fire
  // during ordinary use and taught the new name to nobody.
  const HARNESSES = [
    "claude",
    "codex",
    "copilot",
    "cursor",
    "kiro",
    "kiro-ide",
    "opencode",
  ] as const;

  test("names --guard-policy and never --change-control", () => {
    for (const harness of HARNESSES) {
      const skill = readFileSync(
        join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"),
        "utf-8",
      );
      expect(skill, harness).toContain("--guard-policy");
      expect(skill, harness).not.toContain("--change-control");
      expect(skill, harness).not.toContain("changeControl");
      // change_notices is a directive field name, not the setting, and stays.
      expect(skill.includes("Change Control"), harness).toBe(false);
    }
  });

  test("the plain-chat request names all three values", () => {
    for (const harness of HARNESSES) {
      const skill = readFileSync(
        join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"),
        "utf-8",
      );
      expect(skill, harness).toContain("config-change --guard-policy <strict|relaxed|off>");
    }
  });
});

// covers: subcommand:aidlc-graph:validate-grid, subcommand:aidlc-orchestrate:next,
// function:validateDirective, file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md,
// file:knowledge/aidlc-composer-agent/composing.md
//
// t336 - the Change Control surfaces around the composer and the conductor:
// the validator checks the ONE value a proposal carries (and refuses a relaxed
// proposal under a memory strict, naming the file), the compose dispatch names
// the gate row, the seven conductor skills carry the same plain-chat
// recognition rule and change_notices rule, the composer's persona and
// knowledge describe the value, and `change_notices` is a legal universal
// directive field.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { loadScopeMapping } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
const HARNESSES = ["claude", "kiro", "kiro-ide", "codex", "cursor", "opencode", "copilot"];
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

/** The validator's JSON, narrowed to the fields these tests read. */
function validation(stdout: string): {
  valid: boolean;
  errors: string[];
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
  const changeControl =
    "change_control" in parsed && typeof parsed.change_control === "string"
      ? parsed.change_control
      : undefined;
  return {
    valid: parsed.valid,
    errors: parsed.errors.filter((entry): entry is string => typeof entry === "string"),
    ...(changeControl === undefined ? {} : { change_control: changeControl }),
  };
}

describe("t336 (1) validate-grid checks the proposal's Change Control value", () => {
  const featureGrid = () => loadScopeMapping().feature.stages;

  test("a valid value is echoed with the grid, from the flag or the proposal member", () => {
    const proj = project();
    const flagged = runValidateGrid(proj, { stages: featureGrid() }, ["--change-control", "relaxed"]);
    expect(flagged.rc, flagged.stderr).toBe(0);
    expect(validation(flagged.stdout)).toMatchObject({ valid: true, change_control: "relaxed" });
    const member = runValidateGrid(proj, { stages: featureGrid(), changeControl: "strict" });
    expect(member.rc, member.stderr).toBe(0);
    expect(validation(member.stdout)).toMatchObject({ valid: true, change_control: "strict" });
    const absent = runValidateGrid(proj, { stages: featureGrid() });
    expect(absent.rc).toBe(0);
    expect(validation(absent.stdout).change_control).toBeUndefined();
  });

  test("a value outside the two rejects the grid", () => {
    const proj = project();
    const bad = runValidateGrid(proj, { stages: featureGrid(), changeControl: "loose" });
    expect(bad.rc).toBe(1);
    const result = validation(bad.stdout);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Change Control must be one of: strict, relaxed (got "loose").');
    const bare = runValidateGrid(proj, { stages: featureGrid() }, ["--change-control"]);
    expect(bare.rc).toBe(1);
    expect(bare.stderr).toContain("validate-grid: --change-control requires <strict|relaxed>.");
  });

  test("a relaxed proposal under a memory strict is refused with the message naming the file", () => {
    const proj = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "org.md");
    writeFileSync(
      memory,
      readFileSync(memory, "utf-8").replace("## Change Control\n", "## Change Control\n\nMode: strict\n"),
    );
    const refused = runValidateGrid(proj, { stages: featureGrid(), changeControl: "relaxed" });
    expect(refused.rc).toBe(1);
    expect(validation(refused.stdout).errors).toContain(
      `Change Control is set to strict in ${memory} (section: Change Control), so it cannot be changed from chat. Edit that line to change it for everyone on this repo.`,
    );
    const allowed = runValidateGrid(proj, { stages: featureGrid(), changeControl: "strict" });
    expect(allowed.rc, allowed.stderr).toBe(0);
  });
});

describe("t336 (2) the compose dispatch and the seven conductor skills", () => {
  test("the front compose dispatch names the Change Control gate row and the creation flag", () => {
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
    expect(parsed.message).toContain("ONE changeControl value (strict|relaxed");
    expect(parsed.message).toContain('"Change Control: <changeControl> - <changeControlRationale>"');
    expect(parsed.message).toContain("--change-control <value>");
  });

  test("every authored skill carries the same chat recognition rule and change_notices rule", () => {
    const rules = HARNESSES.map((harness) => {
      const src = readFileSync(join(REPO_ROOT, "harness", harness, "skills", "aidlc", "SKILL.md"), "utf-8");
      const chat = src.match(/^\*\*Change Control requests arrive in plain chat too\.\*\*.*$/m)?.[0];
      const notices = src.match(/^\*\*Change Control notices \(the `change_notices` field\)\.\*\*.*$/m)?.[0];
      const composer = src.match(/^Render that proposal to the human as THREE blocks.*$/m)?.[0];
      expect(chat, harness).toBeDefined();
      expect(notices, harness).toBeDefined();
      expect(composer, harness).toContain(
        'render it as its own row of the proposal ("Change Control: relaxed - a spike moves fast; a changed input is recorded and announced, not re-approved")',
      );
      expect(chat).toContain("When unsure whether a message is that request, ask, never guess");
      expect(chat).toContain("change-control <strict|relaxed>");
      expect(src).toMatch(/--test-strategy, (--review, )?--change-control, --version,/);
      return {
        harness,
        // The harness directory is the one permitted difference in the chat rule.
        chat: (chat ?? "").replace(/`bun [^ ]+\/tools\/aidlc-utility\.ts change-control/, "`bun <dir>/tools/aidlc-utility.ts change-control"),
        notices: notices ?? "",
      };
    });
    for (const rule of rules.slice(1)) {
      expect(rule.chat, rule.harness).toBe(rules[0].chat);
      expect(rule.notices, rule.harness).toBe(rules[0].notices);
    }
  });

  test("the composer persona and knowledge describe the value and its defaults", () => {
    const persona = readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-composer-agent.md"), "utf-8");
    expect(persona).toContain('"changeControl": "strict | relaxed"');
    expect(persona).toContain("`changeControl` is REQUIRED for every mode");
    expect(persona).toContain("`change_control: <the approved value>`");
    const knowledge = readFileSync(
      join(REPO_ROOT, "core", "knowledge", "aidlc-composer-agent", "composing.md"),
      "utf-8",
    );
    expect(knowledge).toContain("## Change Control");
    expect(knowledge).toContain(
      "strict on enterprise, security-patch,\n  workshop, and infra, relaxed everywhere else",
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

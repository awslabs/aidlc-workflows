// covers: subcommand:aidlc-state:practices-promote, subcommand:aidlc-orchestrate:report
//
// At the Practices Discovery gate the person approves the hard rules the
// stage drafted, and Approve writes them into the project's rules stamped
// "(affirmed <date>)". Live runs showed one summary and wrote another: "None."
// under both headings became two rules, and an intro sentence, a wrapped
// second line or an evidence bullet each became one more. The rules are the
// list items under `## Mandated` and `## Forbidden`, read once: the gate's
// line names them and promotion writes them, so the two cannot differ.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, runOrchestrateNext, seedAidlcMemory, seededAuditShard,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { extractMarkdownSection } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const PROJECT_RULES = "aidlc/spaces/default/memory/project.md";
// The state file's stage-row separator.
const STAGE_SEP = "\u2014";
const NO_RULES = `Approve adds no rules to ${PROJECT_RULES}.`;

// A lead-only Practices Discovery in progress, so the gate opens without spoke
// contribution files.
function project(discoveredRules: string): { proj: string; draftDir: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: practices rules test
- **Project Type**: Greenfield
- **Scope**: enterprise
- **Collaborators**: off (set by you)
- **State Version**: 8
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [S] reverse-engineering ${STAGE_SEP} SKIP
- [-] practices-discovery ${STAGE_SEP} EXECUTE
- [ ] requirements-analysis ${STAGE_SEP} EXECUTE

## Current Status
- **Current Stage**: practices-discovery
- **Lifecycle Phase**: INCEPTION
- **Status**: In Progress
`);
  const shard = seededAuditShard(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, [
    "", "## STAGE_STARTED", "**Timestamp**: 2026-07-17T14:01:00Z", "**Event**: STAGE_STARTED",
    "**Stage**: practices-discovery", "**Agent**: aidlc-pipeline-deploy-agent", "", "---", "",
  ].join("\n"), { flag: "a" });
  const draftDir = join(seededRecordDir(proj), "inception", "practices-discovery");
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(
    join(draftDir, "team-practices.md"),
    "# Team Practices\n\n## Testing Posture\n\n- **Methodology**: test-after\n- **Ordering**: one sentence.\n",
  );
  writeFileSync(join(draftDir, "discovered-rules.md"), discoveredRules);
  return { proj, draftDir };
}

function openGate(proj: string): { kind?: string; message?: string; narration?: string } {
  const r = spawnSync(BUN, [ORCH, "report", "--stage", "practices-discovery", "--result", "awaiting-approval", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj,
  });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { kind: "unparseable", message: `${r.stdout}${r.stderr}` };
  }
}

function promote(proj: string, draftDir: string): { mandated_appended: number; forbidden_appended: number } {
  const r = spawnSync(BUN, [
    STATE, "practices-promote",
    "--team-practices", join(draftDir, "team-practices.md"),
    "--discovered-rules", join(draftDir, "discovered-rules.md"),
    "--affirming-user", "the person", "--project-dir", proj,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
}

// The rules a section of project.md holds: its lines that carry a stamp.
function stamped(proj: string, heading: string): string[] {
  const text = extractMarkdownSection(readFileSync(join(proj, PROJECT_RULES), "utf-8"), heading);
  return text.split("\n").filter((line) => / \(affirmed \d{4}-\d{2}-\d{2}\)$/.test(line))
    .map((line) => line.replace(/ \(affirmed \d{4}-\d{2}-\d{2}\)$/, ""));
}

// The rules the gate's line names, in its order.
function shownRules(narration: string | undefined): string[] {
  const lines = (narration ?? "").split("\n");
  const head = lines.findIndex((line) => line.startsWith("Approve adds these rules to "));
  if (head < 0) return [];
  const rules: string[] = [];
  for (const line of lines.slice(head + 1)) {
    const match = /^- (Mandated|Forbidden): (.+)$/.exec(line);
    if (match === null) break;
    rules.push(`${match[1]}: ${match[2]}`);
  }
  return rules;
}

describe("Practices Discovery writes exactly the rules its gate showed", () => {
  test("a draft whose sections say None. promotes no rule, and the gate says Approve adds none", () => {
    const { proj, draftDir } = project("# Discovered Rules\n\n## Mandated\n\nNone.\n\n## Forbidden\n\nNone.\n");
    const before = readFileSync(join(proj, PROJECT_RULES), "utf-8");

    const gate = openGate(proj);
    expect(gate.kind, gate.message).toBe("print");
    expect(gate.narration).toContain(NO_RULES);
    expect(shownRules(gate.narration)).toEqual([]);

    expect(promote(proj, draftDir)).toMatchObject({ mandated_appended: 0, forbidden_appended: 0 });
    expect(readFileSync(join(proj, PROJECT_RULES), "utf-8")).toBe(before);
  });

  // Rules written as plain lines are prose to the reader, so the gate says
  // what Approve will do with them rather than leave the summary to count them.
  test("rules written as plain lines are no rule, and the gate says Approve adds none", () => {
    const { proj, draftDir } = project(
      "# Discovered Rules\n\n## Mandated\n\nALWAYS run the test suite in CI\n\n## Forbidden\n\nNEVER commit secrets\n",
    );
    expect(openGate(proj).narration).toContain(NO_RULES);
    expect(promote(proj, draftDir)).toMatchObject({ mandated_appended: 0, forbidden_appended: 0 });
  });

  test("two items under each, with an intro line and wrapped lines, promote those two and nothing else, and the gate lists the same", () => {
    const { proj, draftDir } = project(`# Discovered Rules

## Mandated

The person stated these hard constraints in the interview:

- ALWAYS run the test suite in CI
  before a merge to main
- ALWAYS keep line coverage at 80% or more

## Forbidden

No exceptions were discussed.

- NEVER commit secrets
- NEVER deploy to production
  without a manual approval
`);
    const gate = openGate(proj);
    expect(gate.kind, gate.message).toBe("print");
    expect(gate.narration).toContain(`Approve adds these rules to ${PROJECT_RULES}, which every later stage follows:`);
    const shown = shownRules(gate.narration);
    expect(shown).toEqual([
      "Mandated: ALWAYS run the test suite in CI before a merge to main",
      "Mandated: ALWAYS keep line coverage at 80% or more",
      "Forbidden: NEVER commit secrets",
      "Forbidden: NEVER deploy to production without a manual approval",
    ]);
    // The gate shown again (a resume, a second look) names the same rules.
    const again = runOrchestrateNext(ORCH, proj, [], { cwd: proj }).directive as { gate_only?: boolean; narration?: string };
    expect(again?.gate_only, JSON.stringify(again)).toBe(true);
    expect(shownRules(again.narration)).toEqual(shown);

    expect(promote(proj, draftDir)).toMatchObject({ mandated_appended: 2, forbidden_appended: 2 });
    const written = [
      ...stamped(proj, "## Mandated").map((rule) => `Mandated: ${rule.replace(/^- /, "")}`),
      ...stamped(proj, "## Forbidden").map((rule) => `Forbidden: ${rule.replace(/^- /, "")}`),
    ];
    expect(written).toEqual(shown);
  });

  test("an evidence bullet nested under a rule is part of no rule", () => {
    const { proj, draftDir } = project(`# Discovered Rules

## Mandated

- ALWAYS run the test suite in CI
  - Source: interview answer 3

## Forbidden

- NEVER commit secrets
  - Source: devsecops review
`);
    expect(shownRules(openGate(proj).narration)).toEqual([
      "Mandated: ALWAYS run the test suite in CI",
      "Forbidden: NEVER commit secrets",
    ]);
    expect(promote(proj, draftDir)).toMatchObject({ mandated_appended: 1, forbidden_appended: 1 });
    expect(stamped(proj, "## Mandated")).toEqual(["- ALWAYS run the test suite in CI"]);
    expect(stamped(proj, "## Forbidden")).toEqual(["- NEVER commit secrets"]);
  });

  test("a rule already in the project's rules is neither shown nor written again", () => {
    const { proj, draftDir } = project(
      "# Discovered Rules\n\n## Mandated\n\n- ALWAYS run the test suite in CI\n- ALWAYS review every change\n\n## Forbidden\n",
    );
    const rulesPath = join(proj, PROJECT_RULES);
    writeFileSync(
      rulesPath,
      readFileSync(rulesPath, "utf-8").replace("## Mandated\n", "## Mandated\n\nALWAYS run the test suite in CI (affirmed 2026-01-01)\n"),
    );

    expect(shownRules(openGate(proj).narration)).toEqual(["Mandated: ALWAYS review every change"]);
    expect(promote(proj, draftDir)).toMatchObject({ mandated_appended: 1, forbidden_appended: 0 });
    expect(stamped(proj, "## Mandated")).toEqual([
      "ALWAYS run the test suite in CI",
      "- ALWAYS review every change",
    ]);
  });
});

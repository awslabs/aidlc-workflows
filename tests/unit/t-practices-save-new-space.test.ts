// covers: subcommand:aidlc-state:practices-promote, subcommand:aidlc-utility:space-create, function:ensureHeading
//
// Approve at Practices Discovery saves the approved practices into the space's
// team.md (five sections) and project.md (the Mandated and Forbidden rules). A
// space made by `space create` starts both files as one line, and a team may
// trim either by hand: the save adds the heading it writes under when the file
// lacks it, so the approval is recorded instead of failing on a heading.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, seedAidlcMemory, seededAuditShard, seededRecordDir,
  seededStateFile, seedWorkspaceShell,
} from "../harness/fixtures.ts";
import { placeRulesBlock, renderRulesBlock, stripRulesBlock } from "../../dist/claude/.claude/tools/aidlc-plugin.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SPACE = "mobile-svc";
// The state file's stage-row separator.
const STAGE_SEP = "\u2014";
const DATE = / \(affirmed \d{4}-\d{2}-\d{2}\)/g;

const TEAM_PRACTICES = `# Team Practices

## Way of Working

Trunk-based, branches live a day.

## Walking Skeleton

No walking skeleton: the pipeline exists.

## Testing Posture

- **Methodology**: test-after
- **Ordering**: tests follow the code in the same change.

## Deployment

Weekly, through the GitHub Actions pipeline.

## Code Style

Biome formats every file.
`;

const DISCOVERED_RULES = `# Discovered Rules

## Mandated

- ALWAYS validate request bodies with zod

## Forbidden

- NEVER log the text of a note
`;

// What the save leaves in a space's one-line team.md: the five sections in
// order, one blank line between them, one newline at the end.
const SAVED_SECTIONS = `## Way of Working

Trunk-based, branches live a day.

## Walking Skeleton

No walking skeleton: the pipeline exists.

## Testing Posture

- **Methodology**: test-after
- **Ordering**: tests follow the code in the same change.

## Deployment

Weekly, through the GitHub Actions pipeline.

## Code Style

Biome formats every file.
`;

function run(proj: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function memoryOf(proj: string, space: string): string {
  return join(proj, "aidlc", "spaces", space, "memory");
}

// A lead-only Practices Discovery in progress in `space`, its drafts written.
function practicesInProgress(proj: string, space: string, teamPractices = TEAM_PRACTICES): string {
  writeFileSync(seededStateFile(proj, space), `# AI-DLC State Tracking

## Project Information
- **Project**: practices save test
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
  const shard = seededAuditShard(proj, space);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, [
    "", "## STAGE_STARTED", "**Timestamp**: 2026-07-17T14:01:00Z", "**Event**: STAGE_STARTED",
    "**Stage**: practices-discovery", "**Agent**: aidlc-pipeline-deploy-agent", "", "---", "",
  ].join("\n"), { flag: "a" });
  const draftDir = join(seededRecordDir(proj, space), "inception", "practices-discovery");
  mkdirSync(draftDir, { recursive: true });
  writeFileSync(join(draftDir, "team-practices.md"), teamPractices);
  writeFileSync(join(draftDir, "discovered-rules.md"), DISCOVERED_RULES);
  return draftDir;
}

// A project whose team works in a space made by `space create`, at Practices
// Discovery's gate.
function newSpaceProject(): { proj: string; draftDir: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const made = run(proj, [UTILITY, "space-create", SPACE, "--project-dir", proj]);
  expect(made.status, made.out).toBe(0);
  seedWorkspaceShell(proj, SPACE);
  return { proj, draftDir: practicesInProgress(proj, SPACE) };
}

function openGate(proj: string): void {
  const r = run(proj, [ORCH, "report", "--stage", "practices-discovery", "--result", "awaiting-approval", "--project-dir", proj]);
  const reply = JSON.parse(r.out.trim().split("\n").pop() ?? "{}");
  expect(reply.kind, r.out).toBe("print");
}

function promote(proj: string, draftDir: string): { status: number | null; out: string } {
  return run(proj, [
    STATE, "practices-promote",
    "--team-practices", join(draftDir, "team-practices.md"),
    "--discovered-rules", join(draftDir, "discovered-rules.md"),
    "--affirming-user", "the person", "--project-dir", proj,
  ]);
}

function files(proj: string, space: string): { team: string; project: string } {
  return {
    team: readFileSync(join(memoryOf(proj, space), "team.md"), "utf-8"),
    project: readFileSync(join(memoryOf(proj, space), "project.md"), "utf-8"),
  };
}

describe("Practices Discovery's save in a space made by space create", () => {
  test("Approve saves the practices and the rules, and the approval is recorded", () => {
    const { proj, draftDir } = newSpaceProject();
    const defaultBefore = files(proj, "default");
    expect(files(proj, SPACE)).toEqual({ team: "# Team practices\n", project: "# Project overrides\n" });

    openGate(proj);
    const saved = promote(proj, draftDir);
    expect(saved.status, saved.out).toBe(0);
    expect(saved.out).toContain('"emitted":"PRACTICES_AFFIRMED"');

    const after = files(proj, SPACE);
    expect(after.team).toBe(`# Team practices\n\n${SAVED_SECTIONS}`);
    expect(after.project.replace(DATE, "")).toBe(
      "# Project overrides\n\n## Mandated\n- ALWAYS validate request bodies with zod\n\n" +
        "## Forbidden\n- NEVER log the text of a note\n",
    );
    expect(after.project.match(DATE)?.length).toBe(2);
    expect(files(proj, "default")).toEqual(defaultBefore);

    const approved = run(proj, [
      ORCH, "report", "--stage", "practices-discovery", "--result", "approved", "--user-input", "Approve",
      "--project-dir", proj,
    ]);
    const reply = JSON.parse(approved.out.trim().split("\n").pop() ?? "{}");
    expect(reply.kind, approved.out).toBe("done");
    expect(readFileSync(seededStateFile(proj, SPACE), "utf-8")).toContain(`- [x] practices-discovery ${STAGE_SEP} EXECUTE`);

    // The same save again writes the same bytes.
    const again = promote(proj, draftDir);
    expect(again.status, again.out).toBe(0);
    expect(files(proj, SPACE)).toEqual(after);
  });

  test("a section the draft leaves out adds no heading", () => {
    const { proj, draftDir } = newSpaceProject();
    writeFileSync(join(draftDir, "team-practices.md"),
      "# Team Practices\n\n## Way of Working\n\nTrunk-based.\n\n## Code Style\n\nBiome.\n");
    const saved = promote(proj, draftDir);
    expect(saved.status, saved.out).toBe(0);
    expect(files(proj, SPACE).team).toBe("# Team practices\n\n## Way of Working\n\nTrunk-based.\n\n## Code Style\n\nBiome.\n");
  });

  test("a plugin's rules section in the new space's team.md stays whole, and the sections land outside it", () => {
    const { proj, draftDir } = newSpaceProject();
    const team = join(memoryOf(proj, SPACE), "team.md");
    // As space create leaves team.md when a plugin's rules are on in the space it copies from.
    const block = renderRulesBlock("test-pro", "- Every Unit ships tests that fail before the code exists.\n");
    writeFileSync(team, placeRulesBlock("# Team practices\n", "test-pro", block));
    const saved = promote(proj, draftDir);
    expect(saved.status, saved.out).toBe(0);
    const after = readFileSync(team, "utf-8");
    expect(after).toContain(block);
    expect(after.indexOf("## Way of Working")).toBeGreaterThan(after.indexOf(block) + block.length - 1);
    expect(stripRulesBlock(after, "test-pro")).toBe(`# Team practices\n\n${SAVED_SECTIONS}`);
  });

  test("a stub with Windows line endings saves", () => {
    const { proj, draftDir } = newSpaceProject();
    writeFileSync(join(memoryOf(proj, SPACE), "team.md"), "# Team practices\r\n");
    writeFileSync(join(memoryOf(proj, SPACE), "project.md"), "# Project overrides\r\n");
    const saved = promote(proj, draftDir);
    expect(saved.status, saved.out).toBe(0);
    const after = files(proj, SPACE);
    for (const heading of ["Way of Working", "Walking Skeleton", "Testing Posture", "Deployment", "Code Style"]) {
      expect(after.team).toContain(`## ${heading}\n`);
    }
    expect(after.project).toContain("- ALWAYS validate request bodies with zod (affirmed ");
    expect(after.project).toContain("- NEVER log the text of a note (affirmed ");
  });
});

describe("Practices Discovery's save in a team.md trimmed by hand", () => {
  test("the file keeps its own text and order and gains only the missing section, at its end", () => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    const teamPath = join(memoryOf(proj, "default"), "team.md");
    const seed = readFileSync(teamPath, "utf-8");
    const start = seed.indexOf("## Deployment\n");
    const end = seed.indexOf("## Code Style\n");
    expect(start).toBeGreaterThan(-1);
    const trimmed = seed.slice(0, start) + seed.slice(end);
    writeFileSync(teamPath, trimmed);
    const draftDir = practicesInProgress(proj, "default");

    const saved = promote(proj, draftDir);
    expect(saved.status, saved.out).toBe(0);
    const after = readFileSync(teamPath, "utf-8");
    // Everything but the four replaced sections is where it was.
    const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings(after)).toEqual([...headings(trimmed), "## Deployment"]);
    expect(after.endsWith("## Deployment\n\nWeekly, through the GitHub Actions pipeline.\n")).toBe(true);
    // The file's own last section, Corrections, is left as it was, one blank line above the added heading.
    const tail = trimmed.slice(trimmed.indexOf("## Corrections"));
    expect(after.slice(after.indexOf("## Corrections"), after.indexOf("## Deployment"))).toBe(`${tail}\n`);

    const again = promote(proj, draftDir);
    expect(again.status, again.out).toBe(0);
    expect(readFileSync(teamPath, "utf-8")).toBe(after);
  });
});

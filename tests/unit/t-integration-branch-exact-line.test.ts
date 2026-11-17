// covers: subcommand:aidlc-unit:share, subcommand:aidlc-unit:status, subcommand:aidlc-state:practices-promote, subcommand:aidlc-state:practices-branch, file:core/memory/org.md
//
// A lead affirmed the Way of Working sentence "`main` is the base branch and
// also the merge target in both repos, `alerts-api` and `alerts-web`", and team
// work took `alerts-api` as its branch: the tool pattern-matched the prose, and
// the name after "base branch" won. Every team step then failed, and the only
// way out was rewording team.md. The branch is now one exact line under
// `## Way of Working` (`- **Integration branch**: main`), read narrowest layer
// first (project.md, team.md, org.md); the tool never reads the prose. Practices
// Discovery writes the line through practices-promote. A layer that has words
// and no line (work begun before the line existed) is read by the agent first:
// the step that needs the branch says so, and practices-branch records what it
// read, the line or that the words name no branch, so a team whose team.md says
// `develop` in a sentence is never moved to `main`, and branch-free words are
// read once and ask the person nothing.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT, resetAidlcEnv, seedAidlcMemory, seededAuditShard,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { integrationBranchToRead, shareOfferTarget, shareTarget } from "../../dist/claude/.claude/tools/aidlc-unit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const MEMORY = join("aidlc", "spaces", "default", "memory");
const SHIPPED_ORG = readFileSync(join(REPO_ROOT, "core", "memory", "org.md"), "utf-8");
// The state file's stage-row separator.
const STAGE_SEP = "\u2014";
const D2 = "`main` is the base branch and also the merge target in both repos, `alerts-api` and `alerts-web`.";

function gitRepo(proj: string): void {
  for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://example.invalid/team.git"]]) {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
  }
}

// A git repo with an origin and the given memory files; shareTarget reads the
// branch without fetching.
function project(memory: Record<string, string>): string {
  const proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-branch-line-"));
  created.push(proj);
  gitRepo(proj);
  mkdirSync(join(proj, MEMORY), { recursive: true });
  for (const [name, body] of Object.entries(memory)) writeFileSync(join(proj, MEMORY, name), body);
  return proj;
}

const wayOfWorking = (body: string): string => `# Rules\n\n## Way of Working\n\n${body}\n\n## Code Style\n\n- Tabs.\n`;
const branchOf = (proj: string): string | undefined => shareTarget(proj)?.branch;

// The agent's record of what it read, through the engine's own command.
function record(proj: string, file: string, read: string | null): { status: number | null; out: string; json: Record<string, unknown> | null } {
  const r = spawnSync(BUN, [STATE, "practices-branch", "--file", file, ...(read === null ? ["--none"] : ["--branch", read]), "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
  } catch {
    json = null;
  }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json };
}

const READ_STEP = (file: string) => new RegExp(`read the "Way of Working" section of aidlc/spaces/default/memory/${file.replace(".", "\\.")}`);

describe("the integration branch is one exact line under Way of Working", () => {
  test("a sentence naming the repos beside the branch is read by the agent first, never taken as a repo", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking(D2) });
    expect(() => shareTarget(proj)).toThrow(READ_STEP("team.md"));
    expect(integrationBranchToRead(proj)).toBe("aidlc/spaces/default/memory/team.md");
    const recorded = record(proj, "team.md", "main");
    expect(recorded.status, recorded.out).toBe(0);
    expect(recorded.json?.line).toBe(
      'Team work merges into main, read from aidlc/spaces/default/memory/team.md, where it is now the "Integration ' +
        'branch" line under "Way of Working"; change it there to use another branch.',
    );
    expect(branchOf(proj)).toBe("main");
    expect(integrationBranchToRead(proj)).toBeNull();
  });

  test("a team.md that says develop only in a sentence keeps develop after the update", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("`develop` is our integration branch.") });
    expect(() => shareTarget(proj)).toThrow(READ_STEP("team.md"));
    expect(record(proj, "team.md", "develop").status).toBe(0);
    expect(branchOf(proj)).toBe("develop");
    const team = readFileSync(join(proj, MEMORY, "team.md"), "utf-8");
    // The line goes at the section's end, before the next heading, words kept.
    expect(team).toContain("`develop` is our integration branch.\n\n- **Integration branch**: develop\n\n## Code Style");
  });

  test("branch-free words are read once, ask nothing, and keep org.md's main until they change", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("We use GitHub Flow with feature branches.") });
    expect(() => shareTarget(proj)).toThrow(READ_STEP("team.md"));
    const none = record(proj, "team.md", null);
    expect(none.status, none.out).toBe(0);
    expect(none.json).toMatchObject({ recorded: null, line: null });
    expect(integrationBranchToRead(proj)).toBeNull();
    expect(branchOf(proj)).toBe("main");
    expect(readFileSync(join(proj, MEMORY, "team.md"), "utf-8")).not.toContain("Integration branch");
    writeFileSync(join(proj, MEMORY, "team.md"), wayOfWorking("We use GitHub Flow; `trunk` is where work merges."));
    expect(integrationBranchToRead(proj)).toBe("aidlc/spaces/default/memory/team.md");
  });

  test("project.md's line wins over team.md's, and team.md's over org.md's", () => {
    const team = wayOfWorking(`${D2}\n\n- **Integration branch**: develop`);
    expect(branchOf(project({ "org.md": SHIPPED_ORG, "team.md": team }))).toBe("develop");
    expect(branchOf(project({
      "org.md": SHIPPED_ORG,
      "team.md": team,
      "project.md": wayOfWorking("Integration branch: release/next"),
    }))).toBe("release/next");
  });

  test("project.md's words are read before team.md's line answers", () => {
    const proj = project({
      "org.md": SHIPPED_ORG,
      "team.md": wayOfWorking("- **Integration branch**: develop"),
      "project.md": wayOfWorking("This monorepo needs package-scoped branch names."),
    });
    expect(() => shareTarget(proj)).toThrow(READ_STEP("project.md"));
    expect(record(proj, "project.md", null).status).toBe(0);
    expect(branchOf(proj)).toBe("develop");
  });

  test("an org.md from an earlier release, with words and no line, is read once and gives main", () => {
    const earlier = SHIPPED_ORG.replace(/^- \*\*Integration branch\*\*: main\n/m, "");
    expect(earlier).not.toContain("Integration branch");
    const proj = project({ "org.md": earlier });
    expect(() => shareTarget(proj)).toThrow(READ_STEP("org.md"));
    expect(record(proj, "org.md", "main").status).toBe(0);
    expect(branchOf(proj)).toBe("main");
  });

  test("a hand-written line in a code span with a full stop is read as the name", () => {
    expect(branchOf(project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("Integration branch: `dev`.") }))).toBe("dev");
  });

  test("a commented example is not read", () => {
    const project_md = wayOfWorking("<!-- - **Integration branch**: develop -->");
    expect(branchOf(project({ "org.md": SHIPPED_ORG, "project.md": project_md }))).toBe("main");
  });

  test("a name git cannot use is refused with its file, by the reader and the recorder", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("- **Integration branch**: bad..name") });
    expect(() => shareTarget(proj)).toThrow(/"bad\.\.name", named in aidlc\/spaces\/default\/memory\/team\.md under "Way of Working", is not a valid git branch name/);
    const words = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("We merge into bad..name.") });
    const refused = record(words, "team.md", "bad..name");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("aidlc/spaces/default/memory/team.md");
    expect(readFileSync(join(words, MEMORY, "team.md"), "utf-8")).not.toContain("Integration branch");
  });

  test("recording twice leaves one line, and a Windows file keeps its line endings", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking("`develop` is our integration branch.").replace(/\n/g, "\r\n") });
    expect(record(proj, "team.md", "develop").status).toBe(0);
    const again = record(proj, "team.md", "develop");
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("already has");
    const team = readFileSync(join(proj, MEMORY, "team.md"), "utf-8");
    expect(team.match(/Integration branch/g)).toHaveLength(1);
    expect(team.replace(/\r\n/g, "")).not.toContain("\n");
    expect(branchOf(proj)).toBe("develop");
  });

  test("a share or push offer still names the branch to be read, as the team's branch", () => {
    const proj = project({ "org.md": SHIPPED_ORG, "team.md": wayOfWorking(D2) });
    expect(shareOfferTarget(proj)).toEqual({ remote: "origin", branch: "the team's branch" });
    expect(record(proj, "team.md", "main").status).toBe(0);
    expect(shareOfferTarget(proj)).toEqual({ remote: "origin", branch: "main" });
  });
});

// The stage's own path: the lead's draft carries the person's sentence and the
// line, Approve promotes it into team.md, and team work reads main from it.
describe("Practices Discovery writes the line into team.md", () => {
  test("Approve with D2's sentence and the line gives main from team.md", () => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    gitRepo(proj);
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: integration branch line
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
    writeFileSync(join(draftDir, "team-practices.md"), [
      "# Team Practices", "", "## Way of Working", "", D2, "", "- **Integration branch**: main", "",
      "## Testing Posture", "", "- **Methodology**: test-after", "- **Ordering**: one sentence.", "",
    ].join("\n"));
    writeFileSync(join(draftDir, "discovered-rules.md"), "# Discovered Rules\n\n## Mandated\n\nNone.\n\n## Forbidden\n\nNone.\n");
    const options = { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" as const, cwd: proj };
    const gate = spawnSync(BUN, [ORCH, "report", "--stage", "practices-discovery", "--result", "awaiting-approval", "--project-dir", proj], options);
    expect(gate.status, `${gate.stdout}${gate.stderr}`).toBe(0);
    const promoted = spawnSync(BUN, [
      STATE, "practices-promote",
      "--team-practices", join(draftDir, "team-practices.md"),
      "--discovered-rules", join(draftDir, "discovered-rules.md"),
      "--affirming-user", "the person", "--project-dir", proj,
    ], options);
    expect(promoted.status, `${promoted.stdout}${promoted.stderr}`).toBe(0);

    const team = readFileSync(join(proj, MEMORY, "team.md"), "utf-8");
    expect(team).toContain(D2);
    expect(team).toContain("- **Integration branch**: main");
    expect(branchOf(proj)).toBe("main");
  });
});

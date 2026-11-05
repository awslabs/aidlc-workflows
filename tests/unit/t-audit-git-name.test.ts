// covers: function:gitUserName, function:personGitNameField, cli:aidlc-state(approve), cli:aidlc-state(reject), cli:aidlc-state(skip), cli:aidlc-orchestrate(report), cli:aidlc-jump(execute), cli:aidlc-jump(reopen), subcommand:aidlc-utility:status, subcommand:aidlc-utility:config-change
//
// A decision of the person's records who was at the keyboard as their git
// reports it: `Git Name`, read from `git config user.name` in the project (the
// repo's own setting, then their global one), the name the Unit board shows
// (#3234). With no name in git the row is what it was before, byte for byte;
// a team clone records its own name; a row nobody decided (the engine's own
// backfill, an agent's skip, a jump while Construction runs on its own, an
// unattended run) carries none. `--status` names who approved the last
// completed stage.
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedBoltDag,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks are not this file's subject; the bare fixtures write no
// documents for them.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCH = join(AIDLC_SRC, "tools", "aidlc.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const DASH = "\u2014"; // the state file's stage-line separator
const SESSION = "t-audit-git-name";

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

interface Project {
  dir: string;
  // The global git config this project's commands read: a file holding a
  // name, or a path with nothing there (no global name).
  globalConfig: string;
}

// A run as a person's: the presence guard on, the artifact guard off for the
// bare fixture, and git reading only this project's own config files.
function env(p: Project, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SESSION_OVERRIDE: SESSION,
    GIT_CONFIG_GLOBAL: p.globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_UNATTENDED;
  delete e.GIT_CONFIG_SYSTEM;
  return { ...e, ...extra };
}

function run(p: Project, cmd: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(BUN, [...cmd, "--project-dir", p.dir], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env(p, extra), AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

function git(p: Project, args: string[]): void {
  const r = spawnSync("git", args, { cwd: p.dir, encoding: "utf-8", env: env(p) });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// The person types `prompt`; the human-turn hook keeps it. Returns its id.
function person(p: Project, prompt: string, extra: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(BUN, [DISPATCH, "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: p.dir,
    env: { ...env(p, extra), AIDLC_PROJECT_DIR: p.dir, CLAUDE_PROJECT_DIR: p.dir },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: p.dir, prompt }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  const turn = readAuditShardEvents(p.dir).filter((row) => row.event === "HUMAN_TURN").at(-1);
  return turn === undefined ? "" : auditBlockField(turn.block, "Message Id") ?? "";
}

// A project mid-Ideation in its own git repository; `name` is the repo's own
// user.name (none when undefined), `globalName` the person's global one.
function project(name?: string, globalName?: string): Project {
  resetAidlcEnv();
  const dir = createTestProject();
  projects.push(dir);
  const p: Project = { dir, globalConfig: join(dir, ".git-global-config") };
  if (globalName !== undefined) writeFileSync(p.globalConfig, `[user]\n\tname = ${globalName}\n`);
  seedStateFile(dir, "state-mid-ideation.md");
  git(p, ["init", "-q"]);
  if (name !== undefined) git(p, ["config", "user.name", name]);
  return p;
}

// Construction at Build and Test, Code Generation done, in its own git
// repository named "Jane Doe"; Construction either runs on its own after the
// person's autonomy grant, or asks them at each gate.
function constructionProject(autonomy: "autonomous" | "gated", unitMajor: boolean): Project {
  const p = project("Jane Doe");
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p.dir), `# AI-DLC State Tracking
## Project Information
- **Project**: Jumps under autonomy
- **Project Type**: Greenfield
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
${unitMajor ? "- **Construction Iteration**: unit-major\n" : ""}- **Construction Autonomy Mode**: ${autonomy}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### INCEPTION PHASE
- [x] requirements-analysis ${DASH} EXECUTE
### CONSTRUCTION PHASE
${skipped.map((stage) => `- [S] ${stage} ${DASH} SKIP`).join("\n")}
- [x] code-generation ${DASH} EXECUTE
- [-] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: build-and-test
- **Status**: Running
`);
  if (unitMajor) seedBoltDag(p.dir, ["alpha"]);
  return p;
}

function currentStage(p: Project): string {
  return /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(p.dir), "utf-8"))![1];
}

function rows(p: Project, event: string) {
  return readAuditShardEvents(p.dir).filter((row) => row.event === event);
}

// The stage's gate shown, the person's reply, and the agent's report of it.
function decide(p: Project, reply: string, result: "approved" | "rejected"): string {
  const slug = currentStage(p);
  expect(run(p, [STATE, "checkbox", `${slug}=in-progress`]).rc).toBe(0);
  const opened = run(p, [STATE, "gate-start", slug]);
  expect(opened.rc, opened.out).toBe(0);
  person(p, reply);
  const reported = run(p, [ORCHESTRATE, "report", "--stage", slug, "--result", result,
    "--user-input", result === "approved" ? "Approve" : "Request Changes"]);
  expect(reported.rc, reported.out).toBe(0);
  return slug;
}

// What differs between two runs of the same steps whatever git says.
function normalised(block: string): string {
  return block
    .replace(/^\*\*Timestamp\*\*: .*$/gm, "**Timestamp**: <t>")
    .replace(/^\*\*(Message Id|Message Ids)\*\*: .*$/gm, "**$1**: <id>");
}

const gitNameLines = (block: string) => block.split("\n").filter((line) => line.startsWith("**Git Name**:"));

describe("t-audit-git-name: a decision records the person's git name", () => {
  test("an approval with user.name set records it", () => {
    const p = project("Jane Doe");
    decide(p, "Approve, the stories read well", "approved");
    const approved = rows(p, "GATE_APPROVED");
    expect(approved.length).toBe(1);
    expect(gitNameLines(approved[0].block)).toEqual(["**Git Name**: Jane Doe"]);
    // The completion the approval implies is the engine's row, not a decision.
    expect(gitNameLines(rows(p, "STAGE_COMPLETED").at(-1)!.block)).toEqual([]);
  });

  test("with no name in git, the approval is recorded as before, byte for byte", () => {
    const unnamed = project();
    const named = project("Jane Doe");
    decide(unnamed, "Approve, the stories read well", "approved");
    decide(named, "Approve, the stories read well", "approved");
    const before = normalised(rows(unnamed, "GATE_APPROVED")[0].block);
    const after = normalised(rows(named, "GATE_APPROVED")[0].block);
    expect(gitNameLines(before)).toEqual([]);
    // The name is the one line the named run adds; every other line is the same.
    expect(after.split("\n").filter((line) => !line.startsWith("**Git Name**:")).join("\n")).toBe(before);
  });

  test("the person's global name is read when the repo has none, and the repo's own wins over it", () => {
    const globalOnly = project(undefined, "Global Person");
    decide(globalOnly, "Approve", "approved");
    expect(gitNameLines(rows(globalOnly, "GATE_APPROVED")[0].block)).toEqual(["**Git Name**: Global Person"]);
    const both = project("Repo Person", "Global Person");
    decide(both, "Approve", "approved");
    expect(gitNameLines(rows(both, "GATE_APPROVED")[0].block)).toEqual(["**Git Name**: Repo Person"]);
  });

  test("a team clone with a different user.name records that one", () => {
    const origin = project("Origin Person");
    git(origin, ["add", "-A"]);
    git(origin, ["-c", "user.email=o@example.com", "commit", "-qm", "the work so far"]);
    const cloneDir = `${origin.dir}-clone`;
    projects.push(cloneDir);
    const cloned = spawnSync("git", ["clone", "-q", origin.dir, cloneDir], { encoding: "utf-8", env: env(origin) });
    expect(cloned.status, `${cloned.stdout}${cloned.stderr}`).toBe(0);
    const clone: Project = { dir: cloneDir, globalConfig: origin.globalConfig };
    git(clone, ["config", "user.name", "Clone Person"]);
    decide(clone, "Approve", "approved");
    const approved = rows(clone, "GATE_APPROVED");
    expect(approved.length).toBe(1);
    expect(gitNameLines(approved[0].block)).toEqual(["**Git Name**: Clone Person"]);
  });

  test("Request Changes records it", () => {
    const p = project("Jane Doe");
    decide(p, "Please add the export stories", "rejected");
    const rejected = rows(p, "GATE_REJECTED");
    expect(rejected.length).toBe(1);
    expect(gitNameLines(rejected[0].block)).toEqual(["**Git Name**: Jane Doe"]);
  });

  test("a skip the person asked for records it; the agent's own skip does not", () => {
    const asked = project("Jane Doe");
    const slug = currentStage(asked);
    person(asked, "skip this one");
    const skipped = run(asked, [ORCHESTRATE, "report", "--stage", slug, "--result", "skipped", "--reason", "the person asked to skip it"]);
    expect(skipped.rc, skipped.out).toBe(0);
    expect(gitNameLines(rows(asked, "STAGE_SKIPPED")[0].block)).toEqual(["**Git Name**: Jane Doe"]);

    const own = project("Jane Doe");
    const reported = run(own, [ORCHESTRATE, "report", "--stage", currentStage(own), "--result", "skipped", "--reason", "nothing in this request needs it"]);
    expect(reported.rc, reported.out).toBe(0);
    expect(gitNameLines(rows(own, "STAGE_SKIPPED")[0].block)).toEqual([]);
  });

  test("a check the person turned off records it; the same setting with nobody asking does not", () => {
    const p = project("Jane Doe");
    const id = person(p, "turn the checks off for this one");
    const off = run(p, [UTILITY, "config-change", "--sensors", "off", "--message", id]);
    expect(off.rc, off.out).toBe(0);
    const theirs = rows(p, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(theirs.block, "Source")).toBe("you");
    expect(gitNameLines(theirs.block)).toEqual(["**Git Name**: Jane Doe"]);
    const on = run(p, [UTILITY, "config-change", "--sensors", "on"]);
    expect(on.rc, on.out).toBe(0);
    const command = rows(p, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(command.block, "Source")).not.toBe("you");
    expect(gitNameLines(command.block)).toEqual([]);
  });

  test("a jump back while Construction runs on its own names nobody; the same jump with the person at the gates names them", () => {
    for (const [autonomy, named] of [["autonomous", []], ["gated", ["**Git Name**: Jane Doe"]]] as const) {
      const p = constructionProject(autonomy, false);
      const jumped = run(p, [JUMP, "execute", "--target", "code-generation", "--direction", "backward", "--scope", "classic"]);
      expect(jumped.rc, jumped.out).toBe(0);
      const row = rows(p, "STAGE_JUMPED").at(-1);
      expect(row, jumped.out).toBeDefined();
      expect(gitNameLines(row!.block)).toEqual([...named]);
    }
    // The person's own jump out of Construction, back to Requirements, is theirs either way.
    const out = constructionProject("autonomous", false);
    const back = run(out, [JUMP, "execute", "--target", "requirements-analysis", "--direction", "backward", "--scope", "classic"]);
    expect(back.rc, back.out).toBe(0);
    expect(gitNameLines(rows(out, "STAGE_JUMPED").at(-1)!.block)).toEqual(["**Git Name**: Jane Doe"]);
  });

  test("a Unit reopened from Build and Test while Construction runs on its own names nobody; with the person at the gates it names them", () => {
    for (const [autonomy, named] of [["autonomous", []], ["gated", ["**Git Name**: Jane Doe"]]] as const) {
      const p = constructionProject(autonomy, true);
      const reopened = run(p, [JUMP, "reopen", "--target", "code-generation", "--stages", "code-generation", "--units", "alpha", "--scope", "classic"]);
      expect(reopened.rc, reopened.out).toBe(0);
      const row = rows(p, "GATE_REJECTED").at(-1);
      expect(row, reopened.out).toBeDefined();
      expect(auditBlockField(row!.block, "Reopen")).toBe("jump");
      expect(gitNameLines(row!.block)).toEqual([...named]);
    }
  });

  test("an unattended run records no name: nobody is at the keyboard", () => {
    const p = project("CI Runner");
    const skipped = run(p, [ORCHESTRATE, "report", "--stage", currentStage(p), "--result", "skipped", "--reason", "the person asked to skip it"],
      { AIDLC_UNATTENDED: "1" });
    expect(skipped.rc, skipped.out).toBe(0);
    expect(gitNameLines(rows(p, "STAGE_SKIPPED")[0].block)).toEqual([]);
  });

  test("--status names who approved the last completed stage, and says nothing more without a name", () => {
    const named = project("Jane Doe");
    const slug = decide(named, "Approve", "approved");
    const shown = run(named, [UTILITY, "status"]);
    expect(shown.rc, shown.out).toBe(0);
    expect(shown.stdout).toMatch(/^Last Completed: .+ \(approved by Jane Doe\)$/m);
    expect(slug.length).toBeGreaterThan(0);

    const unnamed = project();
    decide(unnamed, "Approve", "approved");
    const plain = run(unnamed, [UTILITY, "status"]);
    expect(plain.rc, plain.out).toBe(0);
    expect(plain.stdout).toMatch(/^Last Completed: [^(\n]+$/m);
  });
});

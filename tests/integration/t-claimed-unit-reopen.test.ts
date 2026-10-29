// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:reopen, function:claimedCheckoutReopens
//
// A checkout that claimed a team Unit reopens that Unit's own stages itself:
// the recovery question's "Reopen the approved stage" and the person's own
// `/aidlc --stage <their Unit's stage>` are taken there, and the redone stage
// comes back to the person for approval. A stage that is not the Unit's is
// still moved elsewhere, and the line saying so names a place the person can
// go, never the one they are in. Both shapes of a claimed checkout: the
// project's own checkout claiming a Unit (#3282) and a team's own clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactFilename,
  evaluateGuardRefusal,
  loadStageGraphAll,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

// The stage's checks are not this file's subject (t325 keeps them off the same way).
process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const UNIT = join(AIDLC_SRC, "tools", "aidlc-unit.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const FREEZE = join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts");
const PLAN_GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const TRANSITION_GUARD = join(AIDLC_SRC, "hooks", "aidlc-state-transition-guard.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

// The state format's own separator is U+2014, written as an escape.
function stateBody(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: claimed reopen
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage
- **Review Override**: adversarial
- **Worktree Path**:
- **Bolt Refs**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design \u2014 EXECUTE
- [ ] nfr-requirements \u2014 EXECUTE
- [ ] nfr-design \u2014 EXECUTE
- [ ] infrastructure-design \u2014 EXECUTE
- [ ] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Unit Progress
| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| skeleton | - | [x] | [x] | [x] | [x] | [x] | [x] |
| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
}

function makeSeed(): { seed: string; remote: string } {
  const seed = createTestProject();
  tempDirs.push(seed);
  seedAidlcMemory(seed);
  writeFileSync(seededStateFile(seed), stateBody());
  const depDir = join(seededRecordDir(seed), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, "unit-of-work-dependency.md"),
    "# Unit dependencies\n\n```yaml\nunits:\n  - name: skeleton\n    depends_on: []\n" +
      "  - name: alpha\n    depends_on: [skeleton]\n  - name: beta\n    depends_on: [skeleton]\n```\n",
  );
  writeFileSync(
    join(seed, ".gitignore"),
    "aidlc/.aidlc-clone-id\naidlc/.aidlc-unit-scope.json\naidlc/.aidlc-unit-parked\n" +
      "aidlc/.aidlc-claim-generations.json\naidlc/.aidlc-unit-participant\n" +
      "aidlc/.aidlc-claim-registry.json\naidlc/.aidlc-unit-releases/\n",
  );
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "seed"]);
  git(seed, ["config", "user.email", "seed@example.test"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "seed"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-reopen-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { seed, remote };
}

function clone(remote: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aidlc-reopen-${label}-`));
  rmSync(dir, { recursive: true, force: true });
  git(tmpdir(), ["clone", remote, dir]);
  tempDirs.push(dir);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

function run(tool: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", cwd], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      ...env,
    },
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
}

type Directive = Record<string, unknown> & { kind?: string; message?: string };

function next(cwd: string, args: string[] = []): Directive {
  const first = run(ORCH, ["next", ...args], cwd);
  expect(first.status, first.out).toBe(0);
  const directive = JSON.parse(first.stdout) as Directive;
  if (directive.kind === "load-steering" && typeof directive.receipt === "string") {
    const continued = run(ORCH, ["continue", directive.receipt], cwd);
    expect(continued.status, continued.out).toBe(0);
    return JSON.parse(continued.stdout) as Directive;
  }
  return directive;
}

const FD = "functional-design";
const REVIEWER = "aidlc-architecture-reviewer-agent";

function stageDir(checkout: string, unit: string, slug: string): string {
  return join(seededRecordDir(checkout), "construction", unit, slug);
}

// A per-Unit stage's work for the Unit, as the stage's own steps record it, up
// to its gate. Each attempt's review starts again at its first pass.
function workStage(checkout: string, unit: string, slug: string, version: number): void {
  const stage = loadStageGraphAll().find((entry) => entry.slug === slug)!;
  const started = run(STATE, ["unit", "start", "--stage", slug, "--unit", unit], checkout);
  expect(started.status, started.out).toBe(0);
  const dir = stageDir(checkout, unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name} ${version}\n`);
  expect(run(LOG, ["decision", "--stage", slug, "--decision", "A choice", "--unit", unit], checkout).status).toBe(0);
  expect(run(LOG, ["answer", "--stage", slug, "--details", "An answer", "--unit", unit], checkout).status).toBe(0);
  const review = ["review", "--stage", slug, "--reviewer", REVIEWER, "--iteration", "1", "--unit", unit];
  const requested = run(LOG, review, checkout);
  expect(requested.status, requested.out).toBe(0);
  appendFileSync(
    join(dir, artifactFilename(stage.review_artifact!)),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n` +
      "### Findings\n\nNo blocking findings.\n",
  );
  const verdict = run(LOG, [...review, "--verdict", "READY"], checkout);
  expect(verdict.status, verdict.out).toBe(0);
  const completed = run(STATE, ["unit", "complete", "--stage", slug, "--unit", unit], checkout);
  expect(completed.status, completed.out).toBe(0);
}

function approveStage(checkout: string, unit: string, slug: string, shown: "awaiting-approval" | "revised"): void {
  const gate = run(ORCH, ["report", "--stage", slug, "--unit", unit, "--result", shown], checkout);
  expect(gate.status, gate.out).toBe(0);
  const approved = run(ORCH, ["report", "--stage", slug, "--unit", unit, "--result", "approved", "--user-input", "Approve"], checkout);
  expect(approved.status, approved.out).toBe(0);
}

// The printed reopen's own arguments, to run as printed.
function printedReopen(message: string | undefined): string {
  const command = /reopen --target [^\s`]+ --stages [^\s`]+ --units [^\s`]+ --scope [^\s`]+/.exec(message ?? "")?.[0];
  expect(command, message).toBeDefined();
  return command!;
}

// The agent's edit of an approved document, stopped by the review freeze. A
// repeat puts the recovery question to the person, as in the live run.
function frozenEdit(checkout: string, name: string): void {
  const refused = spawnSync(process.execPath, [FREEZE], {
    cwd: checkout,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Edit",
      tool_input: {
        file_path: join(stageDir(checkout, "alpha", FD), artifactFilename(name)),
        old_string: `# ${name}`,
        new_string: `# ${name} changed`,
      },
      cwd: checkout,
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(refused.status, refused.stderr).toBe(2);
}

// A checkout that claimed alpha, with alpha's Functional Design approved and
// its walk on NFR Requirements.
function claimedPastFunctionalDesign(shape: "shared" | "clone"): { checkout: string; seed: string } {
  const { seed, remote } = makeSeed();
  const checkout = shape === "shared" ? seed : clone(remote, "team");
  const claim = run(UNIT, ["claim", "alpha", "--team", "lead"], checkout);
  expect(claim.status, claim.out).toBe(0);
  workStage(checkout, "alpha", FD, 1);
  approveStage(checkout, "alpha", FD, "awaiting-approval");
  expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
  return { checkout, seed };
}

const SESSION = "01995000-7a11-7000-8000-0000000c1a1e";

// The person's own message, as the host's prompt hook records it.
function says(checkout: string, prompt: string): void {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: checkout,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: checkout, CLAUDE_PROJECT_DIR: checkout },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// What a refused move must leave as it was: the state and every audit row.
function recordSnapshot(checkout: string): { state: string; audit: string[] } {
  const auditDir = seededAuditDir(checkout);
  return {
    state: readFileSync(seededStateFile(checkout), "utf-8"),
    audit: readdirSync(auditDir).sort().map((name) => readFileSync(join(auditDir, name), "utf-8")),
  };
}

const SHAPES = [
  ["the project's own checkout that claimed the Unit", "shared"],
  ["a team's own clone", "clone"],
] as const;

describe("a claimed checkout reopens its own Unit's stages", () => {
  for (const [label, shape] of SHAPES) {
    test(`${label}: the recovery question's Reopen is taken, and the redone stage is approved again`, () => {
      const { checkout } = claimedPastFunctionalDesign(shape);
      frozenEdit(checkout, "rules");
      frozenEdit(checkout, "entities");
      frozenEdit(checkout, "functional-spec");
      const asked = next(checkout);
      expect(asked).toMatchObject({ kind: "ask", ask_type: "guard-recovery", stage: FD, unit: "alpha" });
      const reopen = (asked.remedies as Array<Record<string, unknown>>).find((remedy) => remedy.op === "restore-or-jump");
      expect(reopen, JSON.stringify(asked)).toMatchObject({ label: "Reopen the approved stage" });
      expect(String(reopen!.command)).toEndWith(`next --stage ${FD}`);

      const picked = run(LOG, ["answer", "--stage", FD, "--checkpoint", "guard-recovery", "--details", "restore-or-jump"], checkout);
      expect(picked.status, picked.out).toBe(0);
      // The pick's own command: the reopen, with nothing refused.
      const printed = next(checkout, ["--stage", FD]);
      expect(printed.kind, JSON.stringify(printed)).toBe("print");
      expect(printed.message).toContain('"Reopened Functional Design for unit alpha."');
      expect(printed.message).not.toContain("main checkout");
      const command = printedReopen(printed.message);
      expect(command).toBe(
        "reopen --target functional-design --stages functional-design,nfr-requirements,nfr-design," +
          "infrastructure-design,code-generation --units alpha --scope feature",
      );
      const reopened = run(JUMP, command!.split(" "), checkout);
      expect(reopened.status, reopened.out).toBe(0);
      const row = readAuditShardEvents(checkout).filter((event) => event.event === "GATE_REJECTED").at(-1);
      expect(row?.block).toContain("**Gate Scope**: per-stage");
      expect(row?.block).toMatch(/\*\*Attempt Generation\*\*: 1/);

      // alpha does Functional Design again from the top, and its approval is
      // the person's again: the walk does not go on to NFR Requirements first.
      expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha", gate: false });
      workStage(checkout, "alpha", FD, 2);
      const gate = next(checkout);
      expect(gate.kind, JSON.stringify(gate)).toBe("print");
      expect(gate.message).toContain(`report --stage ${FD} --unit alpha --result revised`);
      approveStage(checkout, "alpha", FD, "revised");
      expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
    });

    test(`${label}: a change they ask for in words to an approved stage is recorded in their words`, () => {
      const { checkout } = claimedPastFunctionalDesign(shape);
      const words = "I want to change Functional Design: names are trimmed.";
      says(checkout, words);
      const turn = readAuditShardEvents(checkout).filter((event) => event.event === "HUMAN_TURN").at(-1);
      const id = /\*\*Message Id\*\*: (\S+)/.exec(turn?.block ?? "")?.[1];
      expect(id, turn?.block).toBeDefined();
      // The agent reads their words as a change: the jump print names the form for one.
      const jump = run(ORCH, ["report", "--result", "resumed", "--choice", "jump", "--target", FD, "--unit", "alpha"], checkout);
      expect(jump.status, jump.out).toBe(0);
      expect((JSON.parse(jump.stdout) as Directive).message).toContain(`\`next --stage ${FD} --unit alpha --change\``);
      const printed = next(checkout, ["--stage", FD, "--unit", "alpha", "--change"]);
      expect(printed.kind, JSON.stringify(printed)).toBe("print");
      const command = /reopen --target \S+ --stages \S+ --units alpha --scope feature --via change/.exec(printed.message ?? "")?.[0];
      expect(command, printed.message).toBeDefined();
      const reopened = run(JUMP, command!.split(" "), checkout, { AIDLC_SESSION_OVERRIDE: SESSION });
      expect(reopened.status, reopened.out).toBe(0);
      const row = readAuditShardEvents(checkout).filter((event) => event.event === "GATE_REJECTED").at(-1)?.block ?? "";
      expect(row).toContain("**Reopen**: change");
      expect(row).toContain("**User Input**: Request Changes");
      expect(row).toContain(`**Feedback**: ${words}`);
      expect(row).toContain(`**Message Id**: ${id}`);
      expect(row).not.toContain("/aidlc --stage");
    });

    test(`${label}: a move outside the Unit names a place the person can go`, () => {
      const { checkout } = claimedPastFunctionalDesign(shape);
      const before = recordSnapshot(checkout);
      for (const move of [["--stage", "build-and-test"], ["--phase", "inception"]]) {
        const refused = next(checkout, move);
        expect(refused.kind, JSON.stringify(refused)).toBe("error");
        expect(refused.message).toContain('carry on with Unit "alpha"');
        expect(refused.message).toContain("once alpha has landed and this checkout has pulled main");
        expect(refused.message).not.toContain("main checkout");
      }
      const everyUnit = next(checkout, ["--stage", FD, "--every-unit"]);
      expect(everyUnit).toMatchObject({ kind: "error" });
      expect(everyUnit.message).toContain(`--stage ${FD}\` to reopen Functional Design for alpha`);
      // A stage asked to run on its own, or a move with more asked beside it, is
      // not a reopen: refused as before, with nothing written.
      const alone = next(checkout, ["--stage", FD, "--single"]);
      expect(alone.kind, JSON.stringify(alone)).toBe("error");
      expect(alone.message).toContain("a stage does not run on its own here");
      expect(alone.message).toContain("run Functional Design on its own from here");
      const more = next(checkout, ["--stage", FD, "--scope", "bugfix"]);
      expect(more.kind, JSON.stringify(more)).toBe("error");
      expect(more.message).toContain("does not run here");
      const foreign = next(checkout, ["--stage", FD, "--unit", "beta"]);
      expect(foreign).toMatchObject({ kind: "error" });
      expect(foreign.message).toContain('refusing foreign Unit "beta"');
      // A stage alpha has not reached yet has nothing to reopen.
      const ahead = next(checkout, ["--stage", "code-generation"]);
      expect(ahead.kind, JSON.stringify(ahead)).toBe("print");
      expect(ahead.message).toContain("has not reached Code Generation yet");
      expect(recordSnapshot(checkout)).toEqual(before);
      // The step the walk is on, with nothing done there yet, is where plain routing goes.
      expect(next(checkout, ["--stage", "nfr-requirements"])).toMatchObject({
        kind: "run-stage", stage: "nfr-requirements", unit: "alpha",
      });
      expect(readAuditShardEvents(checkout).some((event) => event.event === "GATE_REJECTED")).toBe(false);
    });
  }

  test("a reopen they ask for as a jump keeps its jump row", () => {
    const { checkout } = claimedPastFunctionalDesign("clone");
    says(checkout, "Go back to Functional Design for alpha.");
    const printed = next(checkout, ["--stage", FD, "--unit", "alpha"]);
    expect(printed.kind, JSON.stringify(printed)).toBe("print");
    const reopened = run(JUMP, printedReopen(printed.message).split(" "), checkout, { AIDLC_SESSION_OVERRIDE: SESSION });
    expect(reopened.status, reopened.out).toBe(0);
    const row = readAuditShardEvents(checkout).filter((event) => event.event === "GATE_REJECTED").at(-1)?.block ?? "";
    expect(row).toContain("**Reopen**: jump");
    expect(row).toContain(`**Feedback**: Reopened Functional Design for unit alpha (/aidlc --stage ${FD}).`);
    expect(row).not.toContain("Message Id");
  });

  test("at Code Generation the guards let the printed reopen through", () => {
    const { checkout } = claimedPastFunctionalDesign("shared");
    for (const slug of ["nfr-requirements", "nfr-design", "infrastructure-design"]) {
      expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: slug, unit: "alpha" });
      workStage(checkout, "alpha", slug, 1);
      approveStage(checkout, "alpha", slug, "awaiting-approval");
    }
    expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
    says(checkout, "/aidlc --stage functional-design");
    const printed = next(checkout, ["--stage", FD]);
    expect(printed.kind, JSON.stringify(printed)).toBe("print");
    // The printed reopen in the native spelling: this fixture runs the tools
    // from the build, not from a script in the project the guard would trust.
    const shown = `aidlc engine jump ${printedReopen(printed.message)}`;
    for (const hook of [PLAN_GUARD, TRANSITION_GUARD]) {
      const judged = spawnSync(process.execPath, [hook], {
        cwd: checkout,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: SESSION,
          tool_name: "Bash",
          tool_input: { command: shown },
          cwd: checkout,
        }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
        encoding: "utf-8",
      });
      expect(judged.status, `${hook}: ${judged.stderr}`).toBe(0);
    }
    const reopened = run(JUMP, printedReopen(printed.message).split(" "), checkout);
    expect(reopened.status, reopened.out).toBe(0);
    expect(next(checkout)).toMatchObject({ kind: "run-stage", stage: FD, unit: "alpha", gate: false });
  });

  test("the question offers no reopen a claimed checkout cannot take, and main still offers it", () => {
    const { seed, remote } = makeSeed();
    const team = clone(remote, "team");
    const claim = run(UNIT, ["claim", "alpha", "--team", "team"], team);
    expect(claim.status, claim.out).toBe(0);
    // A finished stage that is the whole project's, not the Unit's.
    const refusal = (projectDir: string, stage: string, unit?: string) => evaluateGuardRefusal({
      code: "REVIEW_FREEZE_ACTIVE",
      blockedAction: "artifact-write:doc.md",
      stage,
      ...(unit ? { unit } : {}),
      projectDir,
      stateContent: readFileSync(seededStateFile(projectDir), "utf-8").replace(
        "- [ ] build-and-test",
        "- [x] build-and-test",
      ),
      invariant: "A terminal review continues to cover the bytes it certified.",
      userMessage: "",
      attempt: { recovery: "spent", summaryCoverage: "current", reviewCoverage: "current", sourceCoverage: "current" },
      humanAuthority: { freshTurn: true, unattended: false },
      ...(unit ? { teamGate: { resolved: true, scope: "per-stage", status: "approved", gateStage: stage } } : {}),
      fence: "review-freeze",
      fenceSwitch: "offer",
    });
    const ops = (projectDir: string, stage: string, unit?: string) =>
      refusal(projectDir, stage, unit).remedies.map((remedy) => remedy.op);
    expect(ops(team, "build-and-test")).not.toContain("restore-or-jump");
    expect(ops(team, "build-and-test")).toContain("lower-fence");
    expect(ops(team, FD, "alpha")).toContain("restore-or-jump");
    expect(ops(seed, "build-and-test")).toContain("restore-or-jump");
  });
});

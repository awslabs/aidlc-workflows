// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:reopen, function:claimedCheckoutReopens
//
// A checkout that claimed the plan's last Unit, done with it: once every
// Unit's row is done the record moves on to Build and Test, the whole work's
// next stage. The person's redo of one of their Unit's own stages there
// (`/aidlc --stage code-generation`, or a change they ask for in words) is
// read from the Unit's own walk, not from that stage: it reopens the stage for
// their Unit, the guards let the printed reopen through, and the walk takes
// the Unit through the stage again instead of saying it has not reached it.
// Both shapes of a claimed checkout: a team's own clone and the project's own
// checkout that claimed the Unit.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import {
  GUARD_RECOVERY_ASK_TYPE,
  readAuditShardEvents,
  readStateFile,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  appendMainHumanTurn,
  cleanupTempDirs,
  completeUnitOnMain,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const PLAN_GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const TRANSITION_GUARD = join(AIDLC_SRC, "hooks", "aidlc-state-transition-guard.ts");
const SESSION = "01995000-7a11-7000-8000-0000000c1a1f";
const CG = "code-generation";
const FD = "functional-design";

const currentStage = (checkout: string): string =>
  /^- \*\*Current Stage\*\*: (.*)$/m.exec(readFileSync(seededStateFile(checkout), "utf-8"))?.[1] ?? "";

// alpha claimed, worked and approved through every stage and published; beta,
// the other Unit, built on main. The walk's next on alpha's last stage moves
// the record on to Build and Test, as in a live run. "shared": the project's
// own checkout claims alpha; "clone": a team's own clone does.
function lastUnitDone(shape: "clone" | "shared" = "clone"): string {
  const { seed: lead, remote } = makeSeed(parallelDependencyBody());
  completeUnitOnMain(lead, "beta");
  if (shape === "shared") appendMainHumanTurn(lead);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "beta built on main"]);
  git(lead, ["push", "origin", "main"]);
  const { checkout } = shape === "shared"
    ? prepareCandidate(remote, "alpha", "lead", { checkout: lead })
    : prepareCandidate(remote, "alpha", "team-a");
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, `- **Current Stage**: ${CG}`),
  );
  expect(nextDirective(checkout)).toMatchObject({ kind: "notice", unit: "alpha" });
  expect(currentStage(checkout)).toBe("build-and-test");
  return checkout;
}

function nextWith(checkout: string, args: string[]): Record<string, unknown> & { message?: string } {
  const result = runMergeTool(ORCH, ["next", ...args], checkout);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout);
}

// Their words alone, as the skill passes them: the project flag goes before
// the words, which `next` reads as the person's.
function nextWords(checkout: string, words: string): Record<string, unknown> & { message?: string } {
  const result = spawnSync(process.execPath, [ORCH, "next", "--project-dir", checkout, words], {
    cwd: checkout,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

function printedReopen(message: string | undefined): string {
  const command = /reopen --target [^\s`]+ --stages [^\s`]+ --units [^\s`]+ (?:--via redo )?--scope [^\s`]+(?: --via change)?/
    .exec(message ?? "")?.[0];
  expect(command, message).toBeDefined();
  return command!;
}

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

const lastReopenRow = (checkout: string): string =>
  readAuditShardEvents(checkout).filter((event) => event.event === "GATE_REJECTED").at(-1)?.block ?? "";

const SHAPES = [
  ["a team's own clone", "clone"],
  ["the project's own checkout that claimed the Unit", "shared"],
] as const;

// Both guards on the printed reopen, as the agent runs it.
function guardsPass(checkout: string, command: string): void {
  for (const hook of [PLAN_GUARD, TRANSITION_GUARD]) {
    const judged = spawnSync(process.execPath, [hook], {
      cwd: checkout,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        tool_name: "Bash",
        tool_input: { command: `aidlc engine jump ${command}` },
        cwd: checkout,
      }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
      encoding: "utf-8",
    });
    expect(judged.status, `${hook}: ${judged.stderr}`).toBe(0);
  }
}

const REDO_CG = `reopen --target ${CG} --stages ${CG} --units alpha --via redo --scope feature`;
const REDO_CG_LINE = '"Redoing Code Generation for unit alpha from the start, plan included.';

// The redo of alpha's Code Generation, run as printed: recorded as a redo, its
// answer to the re-use question kept, and the work moved back from Build and Test.
function redoneAsPrinted(checkout: string, message: string | undefined): void {
  expect(message).toContain(REDO_CG_LINE);
  const command = printedReopen(message);
  expect(command).toBe(REDO_CG);
  guardsPass(checkout, command);
  const reopened = runMergeTool(JUMP, command.split(" "), checkout);
  expect(reopened.status, reopened.out).toBe(0);
  expect(currentStage(checkout)).toBe(CG);
  const row = lastReopenRow(checkout);
  expect(row).toContain("**Unit**: alpha");
  expect(row).toContain("**Reopen**: redo");
  expect(row).toContain("**Moved From**: build-and-test");
  const reuse = readAuditShardEvents(checkout).filter((event) => event.event === "ARTIFACT_REUSED").at(-1)?.block ?? "";
  expect(reuse).toContain(`**Stage**: ${CG}`);
  expect(reuse).toContain("**Decision**: redo");
  // The Unit's own step again, not Build and Test or the end-of-Unit notice.
  expect(nextDirective(checkout)).toMatchObject({ stage: CG, unit: "alpha" });
  expect(currentStage(checkout)).toBe(CG);
}

describe("a claimed checkout whose record moved on to Build and Test redoes its Unit's own stage", () => {
  for (const [label, shape] of SHAPES) {
    test(`${label}: Code Generation asked for by name is reopened for the Unit, and the guards let it through`, () => {
      const checkout = lastUnitDone(shape);
      const printed = nextWith(checkout, ["--stage", CG]);
      expect(printed.kind, JSON.stringify(printed)).toBe("print");
      expect(printed.message).not.toContain("has not reached");
      expect(printed.message).toContain('"Reopened Code Generation for unit alpha."');
      const command = printedReopen(printed.message);
      expect(command).toBe(`reopen --target ${CG} --stages ${CG} --units alpha --scope feature`);
      guardsPass(checkout, command);
      const reopened = runMergeTool(JUMP, command.split(" "), checkout);
      expect(reopened.status, reopened.out).toBe(0);
      expect(currentStage(checkout)).toBe(CG);
      const row = lastReopenRow(checkout);
      expect(row).toContain("**Unit**: alpha");
      expect(row).toContain("**Moved From**: build-and-test");
      // The Unit's own step again, not Build and Test or the end-of-Unit
      // notice: Code Generation is redone plan included, so its plan comes back
      // to the person first.
      expect(nextDirective(checkout)).toMatchObject({
        kind: "ask", ask_type: "plan-approval", stage: CG, unit: "alpha",
      });
      expect(currentStage(checkout)).toBe(CG);
    });
  }

  test("the recovery question's reopen, picked for the Unit's Code Generation, redoes it as a redo", () => {
    const checkout = lastUnitDone();
    // The question a refused change to alpha's approved code plan puts to the
    // person, and their pick of its reopen.
    writeActiveDirectiveMarker(checkout, {
      kind: "ask",
      ask_type: GUARD_RECOVERY_ASK_TYPE,
      stage: CG,
      unit: "alpha",
      state_sha256: stateDigest(readStateFile(checkout)),
      remedies: [{
        op: "restore-or-jump",
        label: "Reopen the approved stage",
        action: `This stage is already approved; jump back with /aidlc --stage ${CG} to redo it.`,
        interaction: "command",
        operation: { kind: "restart-stage", stage: CG },
      }],
    });
    says(checkout, "Reopen the approved stage");
    const picked = runMergeTool(
      LOG,
      ["answer", "--stage", CG, "--unit", "alpha", "--checkpoint", "guard-recovery", "--details", "Reopen the approved stage"],
      checkout,
      false,
      { AIDLC_SESSION_OVERRIDE: SESSION },
    );
    expect(picked.status, picked.out).toBe(0);
    redoneAsPrinted(checkout, nextWith(checkout, ["--stage", CG]).message);
  });

  test("an earlier stage reopens with every step after it, for the Unit only", () => {
    const checkout = lastUnitDone();
    const printed = nextWith(checkout, ["--stage", FD]);
    expect(printed.kind, JSON.stringify(printed)).toBe("print");
    expect(printed.message).toContain('"Reopened Functional Design for unit alpha."');
    expect(printedReopen(printed.message)).toBe(
      `reopen --target ${FD} --stages ${FD},nfr-requirements,nfr-design,infrastructure-design,${CG} ` +
        "--units alpha --scope feature",
    );
  });

  test("a change they ask for in words is reopened as their change, in their words", () => {
    const checkout = lastUnitDone();
    const words = "I want to change Code Generation: the help text lists every command.";
    says(checkout, words);
    const printed = nextWith(checkout, ["--stage", CG, "--unit", "alpha", "--change"]);
    expect(printed.kind, JSON.stringify(printed)).toBe("print");
    const command = printedReopen(printed.message);
    expect(command).toBe(`reopen --target ${CG} --stages ${CG} --units alpha --scope feature --via change`);
    const reopened = runMergeTool(JUMP, command.split(" "), checkout, false, { AIDLC_SESSION_OVERRIDE: SESSION });
    expect(reopened.status, reopened.out).toBe(0);
    const row = lastReopenRow(checkout);
    expect(row).toContain("**Reopen**: change");
    expect(row).toContain("**User Input**: Request Changes");
    expect(row).toContain(`**Feedback**: ${words}`);
  });

  test("a redo they type is read as one, and redoes the Unit's own stage", () => {
    const checkout = lastUnitDone();
    const words = "redo the Code Generation for alpha";
    says(checkout, words);
    // Their words alone: the reading offers the re-entry report a redo goes
    // through, not only "go on" or a question about where the work belongs.
    const reading = nextWords(checkout, words);
    expect(reading.kind, JSON.stringify(reading)).toBe("print");
    expect(reading.message).toContain("report --result resumed --choice <redo|jump|fresh>");
    // The agent reads a redo of alpha's Code Generation.
    const redo = runMergeTool(ORCH, ["report", "--result", "resumed", "--choice", "redo", "--target", CG, "--unit", "alpha"], checkout);
    expect(redo.status, redo.out).toBe(0);
    redoneAsPrinted(checkout, JSON.parse(redo.stdout).message);
  });

  test("a redo they type with no stage or Unit named redoes the Unit's last stage, never Build and Test", () => {
    const checkout = lastUnitDone();
    const redo = runMergeTool(ORCH, ["report", "--result", "resumed", "--choice", "redo"], checkout);
    expect(redo.status, redo.out).toBe(0);
    const message = JSON.parse(redo.stdout).message ?? "";
    expect(message).not.toContain("execute --target");
    redoneAsPrinted(checkout, message);
  });

  test("a stage that is not the Unit's is still moved elsewhere, with nothing written", () => {
    const checkout = lastUnitDone();
    const before = readFileSync(seededStateFile(checkout), "utf-8");
    const refused = nextWith(checkout, ["--stage", "build-and-test"]);
    expect(refused.kind, JSON.stringify(refused)).toBe("error");
    expect(refused.message).toContain('carry on with Unit "alpha"');
    expect(readFileSync(seededStateFile(checkout), "utf-8")).toBe(before);
  });
});

// A spec Unit has no Infrastructure Design: its kind owes none of that stage's
// documents, so the walk passes it. A redo of it says so in one line, with the
// stages the Unit does have, and nothing is reopened or run again, in the
// Unit's own stages and once the record has moved on past them.
describe("a stage the claimed Unit's kind does not have", () => {
  const specDependencies = (alphaLast: boolean): string =>
    "# Unit dependencies\n\n```yaml\nunits:\n  - name: skeleton\n    depends_on: []\n" +
    "  - name: alpha\n    kind: spec\n    depends_on: [skeleton]\n" +
    `  - name: beta\n    depends_on: [${alphaLast ? "skeleton" : "alpha"}]\n\`\`\`\n`;
  // alpha, a spec Unit, claimed and done with every stage it has; with
  // alphaLast, beta built on main, so the record moves on to Build and Test.
  function specUnitDone(alphaLast: boolean): string {
    const { seed: lead, remote } = makeSeed(specDependencies(alphaLast));
    if (alphaLast) {
      completeUnitOnMain(lead, "beta");
      git(lead, ["add", "-A"]);
      git(lead, ["commit", "-m", "beta built on main"]);
      git(lead, ["push", "origin", "main"]);
    }
    const { checkout } = prepareCandidate(remote, "alpha", "team-a", {
      stages: [FD, "nfr-requirements", "nfr-design", CG],
    });
    writeFileSync(
      seededStateFile(checkout),
      readFileSync(seededStateFile(checkout), "utf-8")
        .replace(/^- \*\*Current Stage\*\*: .*$/m, `- **Current Stage**: ${CG}`),
    );
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", unit: "alpha" });
    expect(currentStage(checkout)).toBe(alphaLast ? "build-and-test" : CG);
    return checkout;
  }
  const record = (checkout: string): string =>
    readFileSync(seededStateFile(checkout), "utf-8") + JSON.stringify(readAuditShardEvents(checkout));
  const LINE = '"unit alpha has no Infrastructure Design stage; its stages are Functional Design, ' +
    'NFR Requirements, NFR Design and Code Generation."';
  const CASES = [
    ["in the Unit's own stages", false],
    ["once the record has moved on to Build and Test", true],
  ] as const;
  for (const [label, alphaLast] of CASES) {
    test(`${label}: its redo says what the Unit has, and nothing runs again`, () => {
      const checkout = specUnitDone(alphaLast);
      const before = record(checkout);
      const said = nextWith(checkout, ["--stage", "infrastructure-design"]);
      expect(said.kind, JSON.stringify(said)).toBe("print");
      expect(said.message).toContain(LINE);
      expect(said.message).not.toContain("reopen --target");
      expect(record(checkout)).toBe(before);
    });
  }

  test("asked for every Unit, or as a change in words, it says the same and nothing runs again", () => {
    const checkout = specUnitDone(true);
    const before = record(checkout);
    for (const args of [
      ["--stage", "infrastructure-design", "--every-unit"],
      ["--stage", "infrastructure-design", "--unit", "alpha", "--change"],
    ]) {
      const said = nextWith(checkout, args);
      expect(said.kind, JSON.stringify(said)).toBe("print");
      expect(said.message).toContain(LINE);
      expect(said.message).not.toContain("reopen --target");
    }
    expect(record(checkout)).toBe(before);
  });
});

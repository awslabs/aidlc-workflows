// covers: subcommand:aidlc-unit:assign, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, subcommand:aidlc-unit:hand-off, subcommand:aidlc-unit:progress, subcommand:aidlc-unit:take-in, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, function:handFileStep, function:reopenTurnedDownBuild
//
// No step the build-out adds hands the person the same thing twice. Each walk
// runs a step's own command as the agent would (from the project's tool tree,
// with the person's words filled in) and then asks for the next step, and the
// next step is never the same step for the same thing. A command that is
// refused names a way on, and following it leads somewhere else. Walks: the
// lead assigns and the board offers a hand-off; a team takes, pushes, is turned
// down and goes back to Code Generation; a team by file starts from the file,
// sends progress (taken in by its path) and its result (by the command); the
// home answers two proposals.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { AIDLC_SRC, createTestProject, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  finishBuild,
  git,
  hook,
  makeHome,
  next,
  personsChat,
  personsNext,
  refundsTaken,
  run,
  STATE,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

type Step = Record<string, unknown>;

// What a step is about: two steps with the same key hand the person the same thing.
function key(step: Step): string {
  return JSON.stringify([step.kind, step.ask_type ?? null, step.stage ?? null, step.unit ?? null,
    step.kind === "print" || step.kind === "notice" ? step.message : null, step.kind === "ask" ? step.question : null]);
}

// The project's own tool tree, so a command runs exactly as the engine printed it.
function withTools(dir: string): string {
  cpSync(AIDLC_SRC, join(dir, ".claude"), { recursive: true });
  return dir;
}

// A command as the agent runs it: the person's words in place of the slot.
function runPrinted(dir: string, env: NodeJS.ProcessEnv, command: string): { status: number; out: string } {
  const line = command.replace(/^bun /, `${process.execPath} `).replace(/'<their words>'/g, "'yes, go ahead'");
  const r = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf-8", env });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function choice(step: Step, label: string): string {
  const picked = (step.choices as Array<{ label: string; command?: string }>).find((entry) => entry.label === label);
  expect(picked?.command, JSON.stringify(step)).toBeDefined();
  return picked!.command!;
}

function printed(step: Step): string {
  const command = /`(bun [^`]+)`/.exec(String(step.message))?.[1];
  expect(command, JSON.stringify(step)).toBeDefined();
  return command!;
}

// Run the step's command, then the next step: never the same step again. A
// refusal names a way on (a command in backticks), and that leads elsewhere.
function movesOn(dir: string, env: NodeJS.ProcessEnv, step: Step, command: string, words: string[] = []): Step {
  const ran = runPrinted(dir, env, command);
  if (ran.status !== 0) {
    const way = /`(bun [^`]+)`/.exec(ran.out)?.[1];
    expect(way, `refused with no way on: ${ran.out}`).toBeDefined();
    const after = runPrinted(dir, env, way!);
    expect(after.out).not.toBe(ran.out);
  }
  const after = next(dir, env, words);
  expect(key(after), `the same step came back after ${command}: ${JSON.stringify(after)}`).not.toBe(key(step));
  return after;
}

describe("no step of the build-out comes back after its own command ran", () => {
  test("the lead assigns, the board offers a hand-off, a team takes, pushes, is turned down and goes back to Code Generation", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    withTools(home.dir);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    // Who builds which Unit: the lead's words, run once; the question is not put again.
    const assignment = next(home.dir);
    expect(assignment.ask_type, JSON.stringify(assignment)).toBe("unit-assignment");
    const assign = String(assignment.assign_command).replace("<unit>=<team> [<unit>=<team> ...]", "refunds=payments checkout-ui=web");
    const board = movesOn(home.dir, ENV, assignment, assign);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // The board, with checkout-ui held for web and not taken: its hand-off offer, run once, is not offered again.
    const offer = (board.offers as Array<{ choices: Array<{ label: string; command?: string }> }>)
      .find((entry) => entry.choices[0].label.includes("checkout-ui"))!;
    const handed = movesOn(home.dir, ENV, board, offer.choices[0].command!);
    expect(JSON.stringify(handed.offers ?? [])).not.toContain("Hand checkout-ui");
    // A team member takes refunds from the offer; the offer is not put again.
    const alice = withTools(cloneOf(home.remote, "alice"));
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    const take = next(alice, ENV);
    expect(take.ask_type, JSON.stringify(take)).toBe("unit-take");
    movesOn(alice, ENV, take, choice(take, "Start refunds"));
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    // The team's push at the end of its build.
    const chat = personsChat("t-unit-no-loops-team");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-no-loops-team", prompt: "build refunds" }).status).toBe(0);
    codeGenerated(alice, record);
    finishBuild(record);
    // The person approved the last stage: their earlier turns are spent.
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "refunds" }, alice, basename(record), "payments");
    const push = next(alice, ENV);
    expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
    movesOn(alice, ENV, push, choice(push, "Push"));
    // The lead turns refunds down; the team's way back runs and is not offered again.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const ask = personsNext(alice, chat, "t-unit-no-loops-team");
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-turned-down");
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-no-loops-team", prompt: "yes, take it back" }).status).toBe(0);
    const redo = runPrinted(alice, chat, choice(ask, "Take refunds back to Code Generation"));
    expect(redo.status, redo.out).toBe(0);
    const jump = /`(bun \S+aidlc-jump\.ts execute [^`]+)`/.exec(redo.out)?.[1];
    expect(jump, redo.out).toBeDefined();
    const guard = hook(alice, chat, {
      hook_event_name: "PreToolUse", session_id: "t-unit-no-loops-team", tool_name: "Bash", tool_input: { command: jump },
    });
    expect(guard.status, guard.out).toBe(0);
    const back = movesOn(alice, chat, ask, jump!);
    expect(back.kind, JSON.stringify(back)).toBe("run-stage");
    expect(back.stage).toBe("code-generation");
  });

  test("a team by file starts from the file once, and its progress and result are taken in once, by path and by command", () => {
    const deps = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
      "  - name: reporting\n    repos: [ledger]\n    depends_on: []\n```\n";
    const home = makeHome({ dependencies: deps });
    withTools(home.dir);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    expect(run(UNIT, ["hand-off", "reporting", "--team", "data", "--person-words", "hand off reporting to data"], home.dir).status).toBe(0);
    const partner = withTools(createTestProject());
    seedAidlcMemory(partner);
    git(partner, ["init", "-q", "-b", "main"]);
    cloneCode(codeHost("ledger"), partner, "ledger", "dana");
    const inbox = tempDir("inbox");
    const deliver = (from: string, rel: string): string => {
      const path = join(inbox, rel.split("/").at(-1)!);
      writeFileSync(path, readFileSync(join(from, ...rel.split("/")), "utf-8"));
      return path;
    };
    // The hand-off file: pointed at, then started; pointed at again, the build carries on.
    const file = deliver(home.dir, "aidlc/handoff/fixture-reporting.md");
    const offer = next(partner, ENV, [file]);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-handoff");
    movesOn(partner, ENV, offer, choice(offer, "Start reporting"), [file]);
    // Progress, taken in by its path (the turn keeps the path for every step in it).
    expect(run(UNIT, ["progress"], partner).status).toBe(0);
    const progress = deliver(partner, "aidlc/handoff/fixture-reporting-progress.md");
    const takeIn = next(home.dir, ENV, [progress]);
    expect(takeIn.kind, JSON.stringify(takeIn)).toBe("print");
    const after = movesOn(home.dir, ENV, takeIn, printed(takeIn), [progress]);
    expect(String(after.message)).toContain("handed off by file, at");
    // The result, taken in by the command: the next step offers no take-in of it.
    const intents = join(partner, "aidlc", "spaces", "data", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
    mkdirSync(join(partner, "ledger", "src"), { recursive: true });
    writeFileSync(join(partner, "ledger", "src", "report.ts"), "export const report = 1;\n");
    const stage = join(record, "construction", "reporting", "code-generation");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/report.ts" }] })}\n`);
    expect(run(UNIT, ["push"], partner).status).toBe(0);
    const result = deliver(partner, "aidlc/handoff/fixture-reporting-result.md");
    expect(run(UNIT, ["take-in", result], home.dir).status).toBe(0);
    const later = next(home.dir, ENV, [result]);
    expect(later.kind, JSON.stringify(later)).not.toBe("print");
  });

  test("the home answers a proposal once, approved or turned down, and is not asked it again", () => {
    for (const answer of ["approve", "reject"]) {
      const taken = refundsTaken();
      withTools(taken.home.dir);
      const copy = join(taken.record, "inception", "requirements-analysis", "requirements.md");
      writeFileSync(copy, "# Requirements\n\nFR1 refunds, partial amounts too.\n");
      expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], taken.alice).status).toBe(0);
      git(taken.home.dir, ["fetch", "-q", "origin"]);
      const ask = next(taken.home.dir, ENV);
      expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-amend");
      const command = String(ask.amend_command).replace("<approve|reject>", answer);
      movesOn(taken.home.dir, ENV, ask, command);
    }
  });
});

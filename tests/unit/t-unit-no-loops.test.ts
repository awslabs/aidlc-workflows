// covers: subcommand:aidlc-unit:assign, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, subcommand:aidlc-unit:hand-off, subcommand:aidlc-unit:progress, subcommand:aidlc-unit:take-in, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, function:handFileStep, function:reopenTurnedDownBuild, subcommand:aidlc-unit:sign-off
//
// No step the build-out adds hands the person the same thing twice. Each walk
// runs a step's own command as the agent would (from the project's tool tree,
// with the person's words filled in) and then asks for the next step, and the
// next step is never the same step for the same thing. A command that is
// refused names a way on, and following it leads somewhere else. Walks: the
// lead assigns and the board offers a hand-off; a team takes, pushes, goes back
// to main, is turned down, goes back to Code Generation and pushes again from
// main; a team by file starts from the file,
// sends progress (taken in by its path) and its result (by the command); the
// home answers two proposals; no step met tells the person what to type
// (tellsWhatToType). Then each step that waits on an answer the person
// did not give yet, and each way on from a push or a take that could not go as
// it was (a push their own change is in the way of waits for it to be out of
// the way): none hands them the same thing again.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, removeWorkspaceRecord, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeGeneratedAgain,
  codeHost,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  hook,
  homeState,
  makeHome,
  mergeOnHost,
  next,
  personsChat,
  personsNext,
  refundsTaken,
  run,
  STATE,
  kindsEverySkillHandles,
  tellsWhatToType,
  tempDir,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

type Step = Record<string, unknown>;

// What a step is about: two steps with the same key hand the person the same thing.
function key(step: Step): string {
  return JSON.stringify([step.kind, step.ask_type ?? null, step.stage ?? null, step.unit ?? null,
    step.kind === "print" || step.kind === "notice" ? step.message : null, step.kind === "print" ? step.narration ?? null : null,
    step.kind === "ask" ? step.question : null, ((step.offers ?? []) as Array<{ question: string }>).map((offer) => offer.question)]);
}

// The project's own tool tree, so a command runs exactly as the engine printed it.
function withTools(dir: string): string {
  cpSync(AIDLC_SRC, join(dir, ".claude"), { recursive: true });
  return dir;
}

// A command as the agent runs it: the person's words in place of the slot.
function runPrinted(dir: string, env: NodeJS.ProcessEnv, command: string): { status: number; out: string } {
  const line = command.replace(/^bun /, `${process.execPath} `).replace(/'<their words>'/g, "'yes, go ahead'")
    .replace(/'<their team>'/g, "'payments'");
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
// What the person reads of a step: none of it tells them what to type. And
// its kind is one every harness's skill acts on in a fresh chat.
let handled: Set<string> | undefined;
function readsAsOffers(step: Step): void {
  handled ??= kindsEverySkillHandles();
  expect(tellsWhatToType(step.question, step.message, step.narration, step.choices, step.offers, step.change_notices), JSON.stringify(step))
    .toBe(false);
  expect(handled.has(String(step.kind)), `no skill's step table knows ${String(step.kind)}: ${JSON.stringify(step)}`).toBe(true);
}

function movesOn(dir: string, env: NodeJS.ProcessEnv, step: Step, command: string, words: string[] = []): Step {
  readsAsOffers(step);
  const ran = runPrinted(dir, env, command);
  if (ran.status !== 0) {
    const way = /`(bun [^`]+)`/.exec(ran.out)?.[1];
    expect(way, `refused with no way on: ${ran.out}`).toBeDefined();
    const after = runPrinted(dir, env, way!);
    expect(after.out).not.toBe(ran.out);
  }
  const after = next(dir, env, words);
  expect(key(after), `the same step came back after ${command}: ${JSON.stringify(after)}`).not.toBe(key(step));
  readsAsOffers(after);
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
    // The way back to main the push's line offered.
    for (const repo of Object.keys(hosts)) git(join(alice, repo), ["switch", "-q", "main"]);
    // The lead turns refunds down; the team's way back runs and is not offered again.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "billing needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const asked = personsNext(alice, chat, "t-unit-no-loops-team");
    expect(asked.ask_type, JSON.stringify(asked)).toBe("unit-turned-down");
    readsAsOffers(asked);
    // Not now; at the next /aidlc it is offered again, as a step every skill acts on, and the offer takes it back.
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-no-loops-team", prompt: "not now" }).status).toBe(0);
    const ask = personsNext(alice, chat, "t-unit-no-loops-team");
    expect(ask.kind, JSON.stringify(ask)).toBe("print");
    expect(key(ask)).not.toBe(key(asked));
    readsAsOffers(ask);
    expect(hook(alice, chat, { hook_event_name: "UserPromptSubmit", session_id: "t-unit-no-loops-team", prompt: "yes, take it back" }).status).toBe(0);
    const redo = runPrinted(alice, chat, offered(ask, "Take refunds back to Code Generation"));
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
    // Code Generation again, on main, approved: the end offers the push, not the redo, and the push goes.
    codeGeneratedAgain(alice);
    finishBuild(record);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "refunds" }, alice, basename(record), "payments");
    const again = next(alice, ENV);
    expect(again.ask_type, JSON.stringify(again)).toBe("unit-push");
    const sent = movesOn(alice, ENV, again, choice(again, "Push"));
    expect(JSON.stringify(sent)).not.toContain("back to Code Generation");
    expect(git(hosts.billing, ["show", "refunds:lib/refund.ts"])).toBe("export const refund = 2;");
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
    const offer = next(partner, ENV, ["--hand-file", file]);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-handoff");
    movesOn(partner, ENV, offer, choice(offer, "Start reporting"), ["--hand-file", file]);
    // Progress, taken in by its path (the turn keeps the path for every step in it).
    expect(run(UNIT, ["progress"], partner).status).toBe(0);
    const progress = deliver(partner, "aidlc/handoff/fixture-reporting-progress.md");
    const takeIn = next(home.dir, ENV, [progress]);
    expect(takeIn.kind, JSON.stringify(takeIn)).toBe("print");
    const after = movesOn(home.dir, ENV, takeIn, printed(takeIn), [progress]);
    expect(String(after.narration)).toContain("handed off by file, at");
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
    expect(String(later.message), JSON.stringify(later)).not.toContain("take-in");
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

type Offer = { question: string; choices: Array<{ label: string; command?: string }> };

function offered(step: Step, label: string): string {
  const command = ((step.offers ?? []) as Offer[]).flatMap((offer) => offer.choices).find((entry) => entry.label === label)?.command;
  expect(command, JSON.stringify(step)).toBeDefined();
  return command!;
}

function teamsHome(): ReturnType<typeof makeHome> {
  const home = makeHome();
  withTools(home.dir);
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  return home;
}

describe("a step that waits on the person, and every way on the round added, never comes back for the same thing", () => {
  test("who builds which Unit: after not yet, the offer; with the home unreachable, try again", () => {
    const home = teamsHome();
    expect(next(home.dir).ask_type).toBe("unit-assignment");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not yet" }, home.dir);
    const waits = next(home.dir);
    expect(waits.kind, JSON.stringify(waits)).toBe("print");
    movesOn(home.dir, ENV, waits, offered(waits, "Leave them all open"));
    // The home unreachable: the answer is kept, and trying again holds the Units.
    const other = teamsHome();
    git(other.dir, ["remote", "set-url", "origin", join(other.remote, "gone")]);
    expect(run(UNIT, ["assign", "refunds=payments", "--person-words", "payments takes refunds"], other.dir).status).toBe(0);
    const kept = next(other.dir);
    expect(kept.kind, JSON.stringify(kept)).toBe("print");
    git(other.dir, ["remote", "set-url", "origin", other.remote]);
    movesOn(other.dir, ENV, kept, offered(kept, "Try again"));
  });

  test("the lead's sign-off and a team's proposal after not now: the board's offer answers each, once", () => {
    const { home, alice, record } = refundsTaken();
    withTools(home.dir);
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).ask_type).toBe("unit-signoff");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "not now" }, home.dir);
    const board = next(home.dir);
    expect(board.kind, JSON.stringify(board)).toBe("print");
    movesOn(home.dir, ENV, board, offered(board, "Sign it off"));
    // A team's proposal, not answered at once: the board's offer answers it.
    const taken = refundsTaken();
    withTools(taken.home.dir);
    writeFileSync(join(taken.record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, faster.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "faster refunds"], taken.alice).status).toBe(0);
    git(taken.home.dir, ["fetch", "-q", "origin"]);
    expect(next(taken.home.dir).ask_type).toBe("unit-amend");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "later" }, taken.home.dir);
    const later = next(taken.home.dir);
    movesOn(taken.home.dir, ENV, later, offered(later, "Approve it"));
  });

  test("a team that changed its copy: the offer to send it home, once", () => {
    const { alice, record } = refundsTaken();
    withTools(alice);
    writeFileSync(join(record, "inception", "requirements-analysis", "requirements.md"), "# Requirements\n\nFR1 refunds, faster.\n");
    const ask = next(alice);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-propose");
    movesOn(alice, ENV, ask, choice(ask, "Send it to the home"));
  });

  test("the push: a repo the plan did not list goes with it; a result the home did not take is offered again as that; a read-only take sends by git once it can", () => {
    const { home, alice, record } = refundsTaken();
    withTools(alice);
    codeGenerated(alice, record);
    cloneCode(codeHost("ledger"), alice, "ledger", "alice");
    writeFileSync(join(alice, "ledger", "entries.ts"), "export const entry = 1;\n");
    const manifest = join(record, "construction", "refunds", "code-generation", "source-manifest.json");
    const written = JSON.parse(readFileSync(manifest, "utf-8")) as { writes: Array<{ repo: string; path: string }> };
    written.writes.push({ repo: "ledger", path: "entries.ts" });
    writeFileSync(manifest, `${JSON.stringify(written, null, 2)}\n`);
    finishBuild(record);
    const hostHook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hostHook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/heads/claim/*) exit 1;; esac; done\n");
    chmodSync(hostHook, 0o755);
    const push = next(alice, ENV);
    expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
    const unsent = movesOn(alice, ENV, push, choice(push, "Push"));
    expect(unsent.ask_type, JSON.stringify(unsent)).toBe("unit-push");
    writeFileSync(hostHook, "#!/bin/sh\nexit 0\n");
    movesOn(alice, ENV, unsent, choice(unsent, "Send it again"));
  });

  test("the push again with their own change in the way of the Unit's branch: refused in git's words, not offered again until it is out of the way, then it goes", () => {
    const { hosts, alice, record } = refundsTaken();
    withTools(alice);
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const billing = join(alice, "billing");
    for (const repo of Object.keys(hosts)) git(join(alice, repo), ["switch", "-q", "main"]);
    writeFileSync(join(billing, "README.md"), "# billing\n\nnew\n");
    git(billing, ["commit", "-q", "-am", "readme"]);
    codeGeneratedAgain(alice);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "refunds" }, alice, basename(record), "payments");
    const push = next(alice, ENV);
    expect(push.ask_type, JSON.stringify(push)).toBe("unit-push");
    readsAsOffers(push);
    // They edit that file again while the question is up, then say yes.
    writeFileSync(join(billing, "README.md"), "# billing\n\nnew, still editing\n");
    const refused = runPrinted(alice, ENV, choice(push, "Push"));
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("README.md");
    expect(refused.out).toContain("once they are committed or put aside, I can push refunds.");
    const waits = next(alice, ENV);
    expect(key(waits), JSON.stringify(waits)).not.toBe(key(push));
    readsAsOffers(waits);
    git(billing, ["commit", "-q", "-am", "readme, done"]);
    const ready = next(alice, ENV);
    expect(ready.ask_type, JSON.stringify(ready)).toBe("unit-push");
    movesOn(alice, ENV, ready, choice(ready, "Push"));
  });

  test("a take: a Unit the home started is refused with a way on that does not offer it; an open Unit starts for a team the lead named", () => {
    const home = teamsHome();
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    const homeStep = next(home.dir);
    expect(homeStep.unit, JSON.stringify(homeStep)).toBe("checkout-ui");
    expect(run(STATE, ["unit", "start", "--stage", "functional-design", "--unit", "checkout-ui"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const carol = withTools(cloneOf(home.remote, "carol"));
    // The agent's own command for the home's Unit: refused, with a way on that does not offer it again.
    const refused = runPrinted(carol, ENV, `bun .claude/tools/aidlc-unit.ts take checkout-ui --home ${HOME_RECORD} --team web`);
    expect(refused.status).not.toBe(0);
    const way = /`(bun [^`]+)`/.exec(refused.out)?.[1];
    expect(way, refused.out).toBeDefined();
    const after = runPrinted(carol, ENV, way!);
    expect(after.status, after.out).toBe(0);
    expect(after.out).not.toContain("Start checkout-ui");
    // An open Unit nobody started, from the default space: started for a team the lead named.
    const other = teamsHome();
    expect(run(UNIT, ["assign", "refunds=payments"], other.dir).status).toBe(0);
    git(other.dir, ["add", "-A"]);
    git(other.dir, ["commit", "-q", "-m", "teams"]);
    git(other.dir, ["push", "-q", "origin", "main"]);
    const dana = withTools(cloneOf(other.remote, "dana"));
    const offer = next(dana);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    movesOn(dana, ENV, offer, choice(offer, "Start checkout-ui for payments"));
  });

  test("a fresh clone while the home builds the walking skeleton: the waiting step is one every harness's skill acts on, and ends the turn", () => {
    const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n  - name: orders\n    depends_on: []\n" +
      "  - name: refunds\n    depends_on: [orders]\n  - name: checkout-ui\n    depends_on: [orders]\n```\n";
    const home = makeHome({ dependencies, state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = withTools(cloneOf(home.remote, "alice"));
    const waiting = next(alice);
    expect(waiting.kind, JSON.stringify(waiting)).toBe("print");
    expect(waiting.message).toBe("Say the line above, then end the turn.");
    expect(String(waiting.narration)).toContain("The walking skeleton, orders, is built at the home first.");
    readsAsOffers(waiting);
  });

  test("a clone where nothing is ready: words for new work start it, and the take opens once the home moves", () => {
    const { hosts, home, alice, record } = refundsTaken(["refunds=payments", "checkout-ui=web", "reporting=data"]);
    const dana = withTools(cloneOf(home.remote, "dana"));
    expect(run(UTILITY, ["space-create", "data"], dana).status).toBe(0);
    expect(run(UTILITY, ["space", "data"], dana).status).toBe(0);
    const waiting = next(dana);
    expect(waiting.kind, JSON.stringify(waiting)).toBe("print");
    readsAsOffers(waiting);
    const erin = withTools(cloneOf(home.remote, "erin"));
    expect(run(UTILITY, ["space-create", "data"], erin).status).toBe(0);
    expect(run(UTILITY, ["space", "data"], erin).status).toBe(0);
    expect(key(next(erin, ENV, ["build", "a", "ledger", "export"]))).not.toBe(key(waiting));
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    next(home.dir);
    const ready = next(dana);
    expect(ready.ask_type, JSON.stringify(ready)).toBe("unit-take");
    movesOn(dana, ENV, ready, choice(ready, "Start reporting"));
  });
});

describe("a print with no offers reads as it did before the teams' steps became prints", () => {
  test("a plan named alone on a fresh workspace: the same fields and the same words", () => {
    const proj = createTestProject();
    try {
      removeWorkspaceRecord(proj);
      const ran = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), "next", "--project-dir", proj, "--scope", "bugfix"],
        { cwd: proj, encoding: "utf-8", env: ENV });
      const step = JSON.parse(ran.stdout.trim()) as Step;
      const orchestrate = /run `(\S+ \S+aidlc-orchestrate\.ts) next/.exec(String(step.message))?.[1];
      expect(orchestrate, JSON.stringify(step)).toBeDefined();
      expect(JSON.stringify(step).replaceAll(orchestrate!, "<orchestrate>")).toBe(JSON.stringify({
        narration: "I'll use the bugfix plan. What should I work on? Tell me in your own words and I'll start it.",
        message: "The person picked the `bugfix` plan and has not said what the work is for, so nothing is created yet. " +
          "Say the line above, then wait: when they say what to work on, run `<orchestrate> next --scope bugfix -- <their words>` " +
          "with their words as one shell-safe argument, and follow what it returns: it starts the work.",
        kind: "print",
      }));
    } finally {
      cleanupTestProject(proj);
    }
  });
});

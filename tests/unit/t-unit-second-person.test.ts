// covers: subcommand:aidlc-unit:lead-sign-off, subcommand:aidlc-unit:sign-off, function:switchSoloToTeams, function:builtFromAnotherMachine
//
// A second person on solo work, and the lead's sign-off (#2410, item 8). Solo
// work built one Unit at a time from another machine is offered to a teammate
// opening it: take an open Unit as their own, carry on the whole work, or
// follow along. Taking one never writes the home's state: the take goes on the
// claim, and the home's own session switches to teams at its next step,
// keeping everything done and asking nothing again. The lead's sign-off is off
// by default; switched on, a team's result waits for the lead's own word.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, seededStateFile } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  ENV,
  git,
  HOME_RECORD,
  homeState,
  hook,
  makeHome,
  mergeOnHost,
  next,
  refundsTaken,
  run,
  stateOf,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

// Solo work on machine A, one Unit at a time, refunds under way there (and,
// with `refundsDone`, refunds finished and reporting under way), pushed.
function soloAtA(refundsDone = false) {
  const home = makeHome();
  const row = (event: string, stage: string, unit: string) => appendAuditEntry(event, { Stage: stage, Unit: unit, "Run floor": "0" }, home.dir);
  row("UNIT_STARTED", "functional-design", "refunds");
  if (refundsDone) {
    row("UNIT_COMPLETED", "code-generation", "refunds");
    row("UNIT_STARTED", "functional-design", "reporting");
  }
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

describe("a teammate opens solo work built from another machine", () => {
  test("is offered the whole work to carry on, an open Unit to take, or to follow along", () => {
    const home = soloAtA();
    const ask = next(cloneOf(home.remote, "bob"));
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect(ask.question).toBe(
      "fixture is being built from another machine, on refunds (Functional Design). Carry on the whole work here, " +
        "take an open Unit as your own, or follow along?",
    );
    const choices = ask.choices as Array<{ label: string; command: string }>;
    expect(choices.map((choice) => choice.label)).toEqual(["Carry on fixture here", "Take checkout-ui", "Follow along"]);
    expect(choices[1].command).toEndWith(`take checkout-ui --home ${HOME_RECORD}`);
    expect(choices[2].command).toContain(`status --space default --intent ${HOME_RECORD}`);
  });

  test("the same person on their own second machine is not asked: their work carries on as before", () => {
    const home = soloAtA();
    // The lead's laptop: the same git identity as the one who committed the work.
    const laptop = cloneOf(home.remote, "lead");
    expect(next(laptop).ask_type).not.toBe("unit-take");
    // The machine the work is built on, in a chat with no work selected yet.
    rmSync(join(home.dir, "aidlc", "spaces", "default", "intents", "active-intent"));
    expect(next(home.dir).ask_type).not.toBe("unit-take");
  });

  test("taking it writes nothing of the home's: the take is on the claim, the build in a folder of its own", () => {
    const home = soloAtA();
    const bob = cloneOf(home.remote, "bob");
    const homeStateBefore = readFileSync(seededStateFile(bob), "utf-8");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);
    expect(took.json).toMatchObject({ space: "default" });
    expect(readFileSync(seededStateFile(bob), "utf-8")).toBe(homeStateBefore);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ owner: "bob", taken_by: "bob" });
    const other = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], cloneOf(home.remote, "carol"));
    expect(other.status).not.toBe(0);
    expect(other.out).toContain("refunds is being built on the other machine; take another Unit, or follow along.");
  });

  test("the home's own session switches to teams at its next step, keeps its work and its approvals, and asks nothing again", () => {
    const home = soloAtA(true);
    const bob = cloneOf(home.remote, "bob");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);
    // The teammate's build approves the way the home does: once per Unit, at its checkpoint.
    const bobState = readFileSync(join(bob, "aidlc", "spaces", "default", "intents", String(took.json?.record), "aidlc-state.md"), "utf-8");
    expect(field(bobState, "Construction Iteration")).toBe("unit-major");
    expect(field(bobState, "Construction Checkpoints")).toBe("enabled");
    // The lead fetches nothing by hand: the home looks for a teammate's take itself.
    const step = next(home.dir);
    expect((step.change_notices ?? []) as string[]).toContain(
      "Your teammate bob took checkout-ui; this session carries on with the rest, one Unit at a time.",
    );
    const state = stateOf(home.dir);
    expect(field(state, "Unit Ownership")).toBe("team");
    expect(field(state, "Home Location")).toBe(home.remote);
    expect(field(state, "Unit Gate Rhythm")).toBe("unit-end");
    const rows = readAuditShardEvents(home.dir);
    expect(rows.filter((row) => row.event === "UNIT_GATE_RHYTHM_SET")).toHaveLength(1);
    // refunds was built here, never merged anywhere: the record says nothing it did not do.
    expect(rows.filter((row) => row.event === "UNIT_MERGED")).toEqual([]);
    // The work goes on with reporting, under way here; nothing is asked again.
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    expect(next(home.dir).ask_type).toBeUndefined();
  });
});

describe("the lead's own chat hears a teammate's take that comes after it looked", () => {
  const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "lead-chat" };
  const typed = (dir: string) =>
    expect(hook(dir, chat, { hook_event_name: "UserPromptSubmit", session_id: "lead-chat", prompt: "/aidlc" }).status).toBe(0);

  test("at the lead's next /aidlc in the same chat", () => {
    const home = soloAtA(true);
    typed(home.dir);
    next(home.dir, chat);
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], cloneOf(home.remote, "bob")).status).toBe(0);
    typed(home.dir);
    const step = next(home.dir, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain(
      "Your teammate bob took checkout-ui; this session carries on with the rest, one Unit at a time.",
    );
    expect(field(stateOf(home.dir), "Unit Ownership")).toBe("team");
  });

  test("before the session starts its next Unit: a Unit a teammate took meanwhile is never started here", () => {
    const home = makeHome();
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    appendAuditEntry("UNIT_COMPLETED", { Stage: "code-generation", Unit: "refunds", "Run floor": "0" }, home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "refunds built here"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    typed(home.dir);
    const first = next(home.dir, chat);
    const unit = String(first.unit);
    expect(["checkout-ui", "reporting"], JSON.stringify(first)).toContain(unit);
    expect(run(UNIT, ["take", unit, "--home", HOME_RECORD], cloneOf(home.remote, "bob")).status).toBe(0);
    // The agent's own next step in the same turn, the person silent.
    const step = next(home.dir, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain(
      `Your teammate bob took ${unit}; this session carries on with the rest, one Unit at a time.`,
    );
    expect(step.unit ?? null, JSON.stringify(step)).not.toBe(unit);
  });
});

describe("a solo home looks for a teammate's take only once its Unit walk has begun", () => {
  const servers: Array<() => void> = [];
  afterEach(() => {
    while (servers.length > 0) servers.pop()!();
  });
  // The looks at the work's claims a step ran, from git's own trace.
  const looks = (trace: string): number => existsSync(trace)
    ? readFileSync(trace, "utf-8").split("\n").filter((line) => line.includes('"event":"start"'))
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      .filter((argv) => (argv.includes("ls-remote") || argv.includes("fetch")) && argv.some((arg) => arg.includes("claim/"))).length
    : 0;
  const traced = (): { trace: string; env: NodeJS.ProcessEnv } => {
    const trace = join(tempDir("trace"), "trace2.json");
    return { trace, env: { ...ENV, GIT_TRACE2_EVENT: trace, AIDLC_SESSION_OVERRIDE: "solo-chat" } };
  };
  const betweenUnits = () => {
    const home = makeHome();
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    appendAuditEntry("UNIT_COMPLETED", { Stage: "code-generation", Unit: "refunds", "Run floor": "0" }, home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "refunds built here"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    return home;
  };

  test("at an Inception stage: two steps, no look", () => {
    const home = makeHome({
      state: homeState().replace("- [x] delivery-planning", "- [-] delivery-planning").replace("- [-] functional-design", "- [ ] functional-design")
        .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: delivery-planning"),
    });
    const { trace, env } = traced();
    expect(next(home.dir, env).stage).toBe("delivery-planning");
    next(home.dir, env);
    expect(looks(trace)).toBe(0);
  });

  test("between Units: one look before the next Unit starts", () => {
    const home = betweenUnits();
    const { trace, env } = traced();
    next(home.dir, env);
    expect(looks(trace)).toBe(1);
  });

  // The command lines still running that name a host stand-in's port.
  const runningFor = (port: string): string[] => {
    const listed = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf-8" })
      : spawnSync("ps", ["-eo", "args"], { encoding: "utf-8" });
    return (listed.stdout ?? "").split(/\r?\n/).filter((line) => line.includes(`127.0.0.1:${port}`));
  };

  test("a remote that does not answer holds the step a few seconds at most, nothing is said, and nothing of the look keeps running", async () => {
    const home = betweenUnits();
    const child = spawn(process.execPath, ["-e", `
      const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
      console.log(server.port);
    `], { stdio: ["ignore", "pipe", "inherit"] });
    servers.push(() => child.kill());
    const port = await new Promise<string>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())));
    git(home.dir, ["remote", "set-url", "origin", `http://127.0.0.1:${port}/org/ws.git`]);
    const { env } = traced();
    const started = Date.now();
    const step = next(home.dir, env);
    expect(Date.now() - started, JSON.stringify(step)).toBeLessThan(8000);
    expect(JSON.stringify(step.change_notices ?? [])).not.toContain("could not be reached");
    expect(runningFor(port)).toEqual([]);
  });
});

describe("the lead's sign-off", () => {
  test("off by default: a merged Unit is done with no sign-off asked", () => {
    const { home, hosts, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).ask_type).not.toBe("unit-signoff");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });

  test("on: the result waits for the lead's own word, asked once as it arrives", () => {
    const { home, hosts, alice, record } = refundsTaken();
    const on = run(UNIT, ["lead-sign-off", "on"], home.dir);
    expect(on.status, on.out).toBe(0);
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    const ask = next(home.dir);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-signoff");
    expect(ask.question).toBe(
      "refunds came back from payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged). Sign it off?",
    );
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const guarded: NodeJS.ProcessEnv = { ...ENV, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "" };
    const unasked = run(UNIT, ["sign-off", "refunds", "--person-words", "sign it off"], home.dir, guarded);
    expect(String(unasked.json?.error)).toStartWith("The sign-off is the person's own word: ask them first, then run this with their words.");
    appendAuditEntry("HUMAN_TURN", { "Person Reply": "let me look at the PRs first" }, home.dir);
    const board = next(home.dir);
    expect(String(board.narration)).toContain("- refunds, payments: checkout-api merged, billing merged (2 of 2 merged), waiting for your sign-off");
    // Not asked again; the board keeps the sign-off theirs to give, and names the lead's other moves.
    const signOff = (board.offers as Array<{ question: string; choices: Array<{ label: string; command?: string }> }>)
      .find((offer) => offer.question === "refunds came back from payments. Sign it off?");
    expect(signOff?.choices.map((choice) => choice.label)).toEqual(["Sign it off", "Not now"]);
    expect(String(signOff?.choices[0].command)).toEndWith("aidlc-unit.ts sign-off refunds --person-words '<their words>'");
    for (const command of ["sign-off <unit>", "amend <unit> --input <file>", "lead-sign-off on", "release <unit>"]) {
      expect(String(board.board_note)).toContain(command);
    }
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.done).toBeUndefined();
    expect(run(UNIT, ["sign-off", "refunds", "--person-words", "looks right, sign it off"], home.dir).status).toBe(0);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });
});

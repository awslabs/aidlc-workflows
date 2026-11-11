// covers: function:checkInLine, function:arrivedAtLastPull, function:mergedAtTeamLook, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push
//
// The lines a person meets in a workspace teams share by git (#2410). Carry on
// is offered only for the person's own take, by their git name, whatever space
// their clone is in: another's build is said, with who builds it and where, and
// carried on only when they ask; one pushed waits for its merge. The check-in
// line is said once at a stop, at the push and at a Unit's end, never from
// what git status shows (AI-DLC's own audit rows always change aidlc/), and
// never names the person's tool folder. Status says what the last pull brought
// from the other teams.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { arrivedAtLastPull, checkInLine, checkInState } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { mergedAtTeamLook, type UnitClaimPayload } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  DEPENDENCIES,
  claimPayload,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  inSpace,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  refundsTaken,
  run,
  STATE,
  UNIT,
  UTILITY,
  takeIn,
  tempDir,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const LINE = "Your teammates see where this work stands once aidlc/ is committed and pushed.";
type Choice = { label: string; detail?: string };

// The lead's work, teams chosen and every Unit open, shared.
function homeWithTeams() {
  const home = makeHome();
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return home;
}

// What a person does by hand: commit the team's record and push it.
function checkIn(dir: string, message: string): void {
  git(dir, ["add", "aidlc"]);
  git(dir, ["commit", "-q", "-m", message]);
  git(dir, ["pull", "-q", "--no-rebase", "--no-edit"]);
  git(dir, ["push", "-q", "origin", "HEAD:main"]);
}

const carryOns = (step: Record<string, unknown>): Choice[] =>
  ((step.choices ?? []) as Choice[]).filter((choice) => choice.label.startsWith("Carry on") && !choice.label.endsWith("as the lead"));

describe("Carry on in a shared workspace", () => {
  test("a fresh clone is offered only the builds its own git name took; another's is said with who and where, and carried on when asked", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");

    // Someone who took neither, in the default space: each build is said, nothing is offered to carry on.
    const abe = cloneOf(home.remote, "abe");
    const fresh = next(abe);
    expect(carryOns(fresh), JSON.stringify(fresh)).toEqual([]);
    expect(String(fresh.narration ?? fresh.question), JSON.stringify(fresh)).toContain(
      "Being built: refunds (being built by ana in payments, on another computer), checkout-ui (being built by bea in web, on another computer).",
    );

    // Ana's own second clone, also in the default space: her build is offered, bea's is said.
    const laptop = cloneOf(home.remote, "ana");
    const own = next(laptop);
    expect(carryOns(own), JSON.stringify(own)).toEqual([
      expect.objectContaining({ label: "Carry on refunds", detail: "Your build of it in the payments space, from another computer." }),
    ]);
    expect(String(own.question), JSON.stringify(own)).toContain("checkout-ui (being built by bea in web, on another computer)");
    const mine = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], laptop);
    expect(mine.status, mine.out).toBe(0);
    expect(mine.json?.notice).toBe("Carrying on refunds, your build in the payments space.");
    expect(readFileSync(join(laptop, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");

    // Abe asks to carry on ana's build all the same: it is carried on, said as hers.
    const carried = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], abe);
    expect(carried.status, carried.out).toBe(0);
    expect(carried.json?.notice).toBe("Carrying on refunds, ana's build in the payments space.");
    expect(readFileSync(join(abe, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    // With nothing of theirs selected, abe's look still offers neither build.
    writeFileSync(join(abe, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const later = next(abe);
    expect(carryOns(later), JSON.stringify(later)).toEqual([]);
  });

  test("a pushed build waits for its merge and is not offered; one the lead turned down is said so and stays its taker's to carry on", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    const look = next(cloneOf(home.remote, "alice"));
    expect(carryOns(look), JSON.stringify(look)).toEqual([]);
    expect(String(look.question), JSON.stringify(look)).toContain("refunds (pushed by alice in payments, waiting for its merge)");

    // The lead turns it down in billing: it is back with alice.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const again = next(cloneOf(home.remote, "alice"));
    expect(String(again.question), JSON.stringify(again)).not.toContain("waiting for its merge");
    expect(carryOns(again), JSON.stringify(again)).toEqual([
      expect.objectContaining({
        label: "Carry on refunds",
        detail: "Your build of it in the payments space, from another computer; turned down in billing, back with alice in payments.",
      }),
    ]);
    // Someone else hears where it is, and is not offered it.
    const other = next(cloneOf(home.remote, "abe"));
    expect(carryOns(other), JSON.stringify(other)).toEqual([]);
    expect(String(other.question), JSON.stringify(other)).toContain("refunds (turned down in billing, back with alice in payments)");
  });

  // A live run (Windows Server): a team's look said the Unit was waiting for its
  // merge after it had merged, until the lead's next look. The team's look runs
  // the lead's own merge rule, read only (mergedAtTeamLook), for its own pushed
  // build.
  test("a pushed build of this checkout reads as merged at its own look once every repo has it, with nothing written to the claim", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    const look = (): string => {
      writeFileSync(join(alice, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
      return String(next(alice).question);
    };
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(look()).toContain("refunds (pushed by alice in payments, waiting for its merge)");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const merged = look();
    expect(merged).toContain("refunds (pushed by alice in payments, merged; the lead's project records it at its next look)");
    expect(merged).not.toContain("waiting for its merge");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toBeUndefined();
  });

  test("the lead's merge rule, read at a team's checkout: merged once every repo has it, with nothing written to the claim", () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const payload = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as unknown as UnitClaimPayload;
    expect(mergedAtTeamLook(alice, payload)).toBe(false);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(mergedAtTeamLook(alice, payload)).toBe(false);
    mergeOnHost(hosts.billing, "refunds", "squash");
    expect(mergedAtTeamLook(alice, payload)).toBe(true);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.verdicts).toBeUndefined();
  });

  test("a code repo offline, refusing, asking for a sign-in or never answering reads as not merged, asks nothing and keeps the lead's time limit", async () => {
    const { hosts, home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const payload = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds") as unknown as UnitClaimPayload;
    const dir = mkdtempSync(join(tmpdir(), "aidlc-merge-row-"));
    const log = join(dir, "requests.log");
    const marker = join(dir, "asked.txt");
    const askpass = join(dir, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho asked >> '${marker.replaceAll("\\", "/")}'\necho secret\n`, { mode: 0o755 });
    // A server that logs each request: one asks for a sign-in, one never answers.
    const server = join(dir, "server.ts");
    writeFileSync(server, [
      "import { appendFileSync } from 'node:fs';",
      "const [mode, log] = process.argv.slice(2);",
      "const s = Bun.serve({ port: 0, fetch(req) { appendFileSync(log, mode + ' ' + new URL(req.url).pathname + '\\n');",
      "  return mode === 'auth' ? new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=\"x\"' } }) : new Promise(() => {}); } });",
      "console.log(s.port);",
    ].join("\n"));
    const start = async (mode: string) => {
      const child = Bun.spawn([process.execPath, server, mode, log], { stdout: "pipe", stderr: "ignore" });
      const { value } = await child.stdout.getReader().read();
      return { child, port: Number(new TextDecoder().decode(value).trim()) };
    };
    const auth = await start("auth");
    const silent = await start("silent");
    const before = { askpass: process.env.GIT_ASKPASS, prompt: process.env.GIT_TERMINAL_PROMPT };
    // The person's own sign-in program, which a quiet fetch must never run.
    process.env.GIT_ASKPASS = askpass;
    process.env.GIT_TERMINAL_PROMPT = "1";
    try {
      for (const url of ["http://127.0.0.1:9/billing.git", `http://127.0.0.1:${auth.port}/billing.git`, `http://127.0.0.1:${silent.port}/billing.git`]) {
        git(join(alice, "billing"), ["remote", "set-url", "origin", url]);
        const started = Date.now();
        expect(mergedAtTeamLook(alice, payload), url).toBe(false);
        expect((Date.now() - started) / 1000, url).toBeLessThan(30);
      }
      expect(readFileSync(log, "utf-8")).toContain("auth ");
      expect(readFileSync(log, "utf-8")).toContain("silent ");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (before.askpass === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = before.askpass;
      if (before.prompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = before.prompt;
      auth.child.kill();
      silent.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no merge check runs for a build that is not pushed and waiting", async () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    const dir = mkdtempSync(join(tmpdir(), "aidlc-merge-row-"));
    const log = join(dir, "requests.log");
    writeFileSync(log, "");
    const server = join(dir, "server.ts");
    writeFileSync(server, [
      "import { appendFileSync } from 'node:fs';",
      "const log = process.argv[2];",
      "const s = Bun.serve({ port: 0, fetch(req) { appendFileSync(log, new URL(req.url).pathname + '\\n'); return new Response('', { status: 404 }); } });",
      "console.log(s.port);",
    ].join("\n"));
    const child = Bun.spawn([process.execPath, server, log], { stdout: "pipe", stderr: "ignore" });
    const { value } = await child.stdout.getReader().read();
    const port = Number(new TextDecoder().decode(value).trim());
    try {
      for (const repo of ["checkout-api", "billing"]) git(join(alice, repo), ["remote", "set-url", "origin", `http://127.0.0.1:${port}/${repo}.git`]);
      writeFileSync(join(alice, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
      next(alice);
      expect(readFileSync(log, "utf-8")).toBe("");
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a build the lead sent back from Build and Test says it was the lead's Build and Test", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    git(home.dir, ["fetch", "-q", "origin"]);
    const sent = run(UNIT, ["send-back", "refunds", "--person-words", "the refund total is off by one"], home.dir);
    expect(sent.status, sent.out).toBe(0);
    const look = next(cloneOf(home.remote, "alice"));
    expect(carryOns(look), JSON.stringify(look)).toEqual([
      expect.objectContaining({
        detail: "Your build of it in the payments space, from another computer; sent back from the lead's Build and Test, back with alice in payments.",
      }),
    ]);
    expect(JSON.stringify(look)).not.toContain("your Build and Test");
    const other = next(cloneOf(home.remote, "abe"));
    expect(String(other.question), JSON.stringify(other)).toContain("refunds (sent back from the lead's Build and Test, back with alice in payments)");
  });
});

describe("the check-in line", () => {
  test("said at the person's stop, once: a plain look over the parked work does not say it again", () => {
    const { alice } = refundsTaken();
    next(alice);
    const parked = run(ORCH, ["park"], alice);
    expect(parked.status, parked.out).toBe(0);
    expect(String(parked.json?.narration), parked.out).toEndWith(LINE);
    const look = next(alice);
    expect(look.kind, JSON.stringify(look)).toBe("parked");
    expect(JSON.stringify(look)).not.toContain("git add aidlc");
  });

  test("said at the push, last, and never the tool folder", () => {
    const { alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice)).toEndWith(` ${LINE}`);
    expect(pushed.out).not.toContain("own folder");
  });

  test("said when the push is put off, and not again by a later look at the finished build", () => {
    const { alice, record } = refundsTaken();
    const step = next(alice);
    expect(JSON.stringify(step)).not.toContain("git add aidlc");
    codeGenerated(alice, record);
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    expect(next(alice).ask_type).toBe("unit-push");
    const later = run(UNIT, ["push", "--later"], alice);
    expect(later.status, later.out).toBe(0);
    expect(later.json?.notice).toBe(`Nothing is pushed. I'll push refunds when you want it to go to the lead. ${LINE}`);
    // The end, and every look after it, carry nothing more.
    for (let look = 0; look < 2; look++) {
      const end = next(alice);
      expect(end.kind, JSON.stringify(end)).toBe("done");
      expect(JSON.stringify(end)).not.toContain("git add aidlc");
    }
  });

  test("said at the lead's own Build and Test end, with the approval", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    expect(String(approved.json?.narration), approved.out).toEndWith(LINE);
  });

  // A live run (Kiro CLI, the lead's Build and Test): the step said '15 of 23'
  // where status said '9/18 stages here': the step counted the Units' own
  // stages, which run in each taker's build.
  test("at the lead's project the approval's progress and status count the same stages, the Units' own left out", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    const step = /Progress: (\d+) of (\d+) stages done\. Next: /.exec(String(approved.json?.narration));
    expect(step, approved.out).not.toBeNull();
    const status = /^Completion: +(\d+)\/(\d+) stages here /m.exec(run(UTILITY, ["status"], home.dir, ENV).out);
    expect(status).not.toBeNull();
    expect([step![1], step![2]]).toEqual([status![1], status![2]]);
  });

  // A live run (the lead's pull and Build and Test): the approval went straight
  // on to CI Pipeline and the line, in the approval's own narration, never
  // reached the person. In a chat it is kept for the reply the turn ends on.
  test("from a chat, the lead's Build and Test end keeps the line for the reply, and the next step carries it", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const session = "7d8e2f3a-3b4c-4e5d-9a6b-2c3d4e5f6a70";
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) };
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir, chat);
    expect(approved.status, approved.out).toBe(0);
    expect(String(approved.json?.narration ?? "")).not.toContain(LINE);
    const kept = JSON.parse(readFileSync(join(home.dir, "aidlc", ".aidlc-engine", "sessions", `${session}.person-lines`), "utf-8")) as {
      lines: Array<{ line: string; reply?: boolean }>;
    };
    expect(kept.lines.find((entry) => entry.line === LINE)?.reply, JSON.stringify(kept)).toBe(true);
    const step = next(home.dir, chat);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step)).toContain(LINE);
  });

  test("from a chat, the lead's Build and Test end with a stop in the same turn says the line once", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: "8e9f3a4b-4c5d-4f6e-8b7c-3d4e5f6a7b81", CLAUDE_PID: String(process.pid) };
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir, chat);
    expect(approved.status, approved.out).toBe(0);
    const parked = run(ORCH, ["park", "--person-asked"], home.dir, chat);
    expect(parked.status, parked.out).toBe(0);
    expect(parked.json?.kind, parked.out).toBe("parked");
    const said = [String(parked.json?.narration ?? ""), ...((parked.json?.change_notices ?? []) as string[])].join("\n");
    expect(said.split(LINE).length - 1, parked.out).toBe(1);
  });

  test("only for teams across repos with a remote: main's team Units on the workspace's own repo never hear it", () => {
    const { alice } = refundsTaken();
    expect(checkInLine(alice)).toBe(LINE);
    git(alice, ["remote", "remove", "origin"]);
    expect(checkInLine(alice)).toBeNull();
    const onRepo = makeHome({ repos: {} });
    expect(run(STATE, ["set-unit-ownership", "team"], onRepo.dir).status).toBe(0);
    expect(checkInLine(onRepo.dir)).toBeNull();
  });
});

// Live runs (Claude Code on Windows Server, Codex, Kiro CLI): after the
// person's own commit and push, the agent kept saying to commit and push
// aidlc/; the next look now hands it the fact.
describe("the checked-in fact", () => {
  const CHECKED_IN = "aidlc/ is committed and pushed: your teammates see where this work stands.";
  const STATUS_YES = "Checked in:     yes, aidlc/ is committed and pushed\n";
  const chatOf = (session: string): NodeJS.ProcessEnv => ({ ...ENV, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) });
  const statusOf = (dir: string): string => run(UTILITY, ["status"], dir, ENV).out;
  const notices = (step: Record<string, unknown>): string[] => (step.change_notices ?? []) as string[];

  test("after the person's own commit and push, the chat that heard the line hears once that it is checked in, and status says yes", () => {
    const { alice } = refundsTaken();
    const chat = chatOf("5b6c0d1e-1f2a-4c3b-8e4f-0a1b2c3d4e50");
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).toEndWith(LINE);
    expect(statusOf(alice)).not.toContain("Checked in:");
    checkIn(alice, "refunds parked");
    const look = next(alice, chat);
    expect(notices(look), JSON.stringify(look)).toContain(CHECKED_IN);
    expect(JSON.stringify(look)).not.toContain(LINE);
    expect(notices(next(alice, chat))).not.toContain(CHECKED_IN);
    expect(statusOf(alice)).toContain(STATUS_YES);
  });

  test("a change not checked in, or a decision of theirs only in this clone's audit, says nothing at a look or in status", () => {
    const { alice, record } = refundsTaken();
    const chat = chatOf("4a5b9c0d-0e1f-4b2a-8d3e-9f0a1b2c3d40");
    next(alice, chat);
    expect(run(ORCH, ["park"], alice, chat).status).toBe(0);
    checkIn(alice, "refunds parked");
    // A change to the record the person has not checked in.
    writeFileSync(join(record, "notes.md"), "Not checked in yet.\n");
    expect(notices(next(alice, chat))).not.toContain(CHECKED_IN);
    expect(statusOf(alice)).not.toContain("Checked in:");
    rmSync(join(record, "notes.md"));
    // A decision row of theirs, in this clone's own audit file only.
    const audit = join(record, "audit");
    const shard = readdirSync(audit).find((name) => readFileSync(join(audit, name), "utf-8").includes("**Event**: UNIT_TAKEN_IN"))!;
    writeFileSync(join(audit, shard), `${readFileSync(join(audit, shard), "utf-8")}\n## Gate Approved\n**Timestamp**: 2026-11-10T12:00:00Z\n**Event**: GATE_APPROVED\n**Stage**: functional-design\n**Git Name**: alice\n\n---\n`);
    expect(statusOf(alice)).not.toContain("Checked in:");
    expect(notices(next(alice, chat))).not.toContain(CHECKED_IN);
  });

  // A live run on GitHub: a record pushed with -u on a branch whose pull
  // request was open was said to be with the team while main had none of it.
  test("a record pushed on a branch not merged yet is said pushed there, once, and checked in once main has it", () => {
    const { home, alice } = refundsTaken();
    const chat = chatOf("6c7d1e2f-2a3b-4d4c-9f5a-1b2c3d4e5f60");
    const PUSHED = "aidlc/ is pushed on records/refunds; your teammates see it once it is in main.";
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).toEndWith(LINE);
    git(alice, ["checkout", "-q", "-b", "records/refunds"]);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    git(alice, ["push", "-q", "-u", "origin", "records/refunds"]);
    const look = next(alice, chat);
    expect(notices(look), JSON.stringify(look)).toContain(PUSHED);
    expect(notices(look)).not.toContain(CHECKED_IN);
    expect(notices(next(alice, chat))).not.toContain(PUSHED);
    expect(checkInLine(alice)).toBeNull();
    expect(statusOf(alice)).toContain("Checked in:     pushed on records/refunds, not in main yet\n");
    // The pull request squash-merged on the host: main has the record as a commit of its own.
    const reviewer = cloneOf(home.remote, "reviewer");
    git(reviewer, ["fetch", "-q", "origin", "records/refunds"]);
    git(reviewer, ["merge", "-q", "--squash", "FETCH_HEAD"]);
    git(reviewer, ["commit", "-q", "-m", "refunds record (#1)"]);
    git(reviewer, ["push", "-q", "origin", "main"]);
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice, chat))).toContain(CHECKED_IN);
    expect(statusOf(alice)).toContain(STATUS_YES);
  });

  test("at the lead's own checkout the branch is read from this clone's refs, never asked of the remote, never the branch it is on", () => {
    const { home } = refundsTaken();
    git(home.dir, ["checkout", "-q", "-b", "records/plan"]);
    writeFileSync(join(home.dir, "aidlc", "notes.md"), "The plan, for its pull request.\n");
    git(home.dir, ["add", "aidlc"]);
    git(home.dir, ["commit", "-q", "-m", "the plan"]);
    git(home.dir, ["push", "-q", "-u", "origin", "records/plan"]);
    git(home.dir, ["remote", "set-url", "origin", join(home.remote, "gone")]);
    expect(checkInState(home.dir)).toEqual({ pushedOn: "records/plan", into: "main" });
    // Pushed only as a fork's main, a branch named like the one the work merges into: git cannot tell.
    const fork = tempDir("fork-host");
    git(fork, ["init", "-q", "--bare", "-b", "main"]);
    git(home.dir, ["remote", "add", "fork", fork]);
    git(home.dir, ["push", "-q", "-u", "fork", "records/plan:main"]);
    expect(checkInState(home.dir)).toBe("unknown");
  });

  // Case 12 on GitHub: the team's records live on a branch called records.
  test("where the work merges into records, a record pushed on its own branch waits for records, read from the lead's space", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const branch = run(STATE, ["practices-branch", "--file", "team.md", "--branch", "records"], home.dir);
    expect(branch.status, branch.out).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams, on records"]);
    git(home.dir, ["push", "-q", "origin", "main", "main:records"]);
    const alice = cloneOf(home.remote, "alice");
    git(alice, ["checkout", "-q", "records"]);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    inSpace(alice, "payments");
    const took = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    const chat = chatOf("7d8e2f3a-3b4c-4e5d-8a6b-2c3d4e5f6a70");
    next(alice, chat);
    expect(String(run(ORCH, ["park"], alice, chat).json?.narration)).toEndWith(LINE);
    git(alice, ["checkout", "-q", "-b", "pr/refunds"]);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    git(alice, ["push", "-q", "-u", "origin", "pr/refunds"]);
    const look = next(alice, chat);
    expect(notices(look), JSON.stringify(look)).toContain("aidlc/ is pushed on pr/refunds; your teammates see it once it is in records.");
    expect(statusOf(alice)).toContain("Checked in:     pushed on pr/refunds, not in records yet\n");
    // Merged into records with a merge commit.
    const reviewer = cloneOf(home.remote, "reviewer");
    git(reviewer, ["checkout", "-q", "records"]);
    git(reviewer, ["fetch", "-q", "origin", "pr/refunds"]);
    git(reviewer, ["merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    git(reviewer, ["push", "-q", "origin", "records"]);
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(next(alice, chat))).toContain(CHECKED_IN);
    expect(statusOf(alice)).toContain(STATUS_YES);
  });

  test("a branch never pushed cannot be told: no line at a look, none in status, and the stopping point says today's words", () => {
    const { alice } = refundsTaken();
    git(alice, ["checkout", "-q", "-b", "local-only"]);
    const chat = chatOf("3f4a8b9c-9d0e-4a1f-8c2d-8e9f0a1b2c30");
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).toEndWith(LINE);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    expect(notices(next(alice, chat))).not.toContain(CHECKED_IN);
    expect(statusOf(alice)).not.toContain("Checked in:");
  });
});

describe("where things stand", () => {
  test("status says what the last pull brought from the other teams", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(takeIn("payments", ["refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    expect(arrivedAtLastPull(ana)).toBeNull();
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana)).toBe("bea: checkout-ui");
    const status = run(UTILITY, ["status"], ana, ENV);
    expect(status.out).toContain("From others, at your last pull that brought changes:    bea: checkout-ui (building)\n");
    // Another pull, straight after, that brings the lead's change: only that one is said.
    writeFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "notes.md"), "Lead's note.\n");
    git(home.dir, ["pull", "-q", "--no-rebase", "--no-edit"]);
    checkIn(home.dir, "the lead's note");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana)).toBe("lead: fixture");
    // A record that is not a build keeps its name alone.
    expect(run(UTILITY, ["status"], ana, ENV).out).toContain("From others, at your last pull that brought changes:    lead: fixture\n");
  });

  // A live run (Windows Server, every take in the default space): status right
  // after a pull that brought a teammate's merged Unit said nothing of it, since
  // the line read other spaces; it reads who made the change.
  test("with every build in one space, a pull's news is said by who made it, and nothing when it was only the person's own", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "checkout-ui started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana)).toBe("bea: checkout-ui");
    expect(run(UTILITY, ["status"], ana, ENV).out).toContain("From others, at your last pull that brought changes:    bea: checkout-ui (building)\n");
    // Ana's own change from her other computer: nothing from others.
    const laptop = cloneOf(home.remote, "ana");
    const intents = join(laptop, "aidlc", "spaces", "default", "intents");
    const build = readdirSync(intents).find((name) => name.endsWith("-refunds"));
    expect(build).toBeDefined();
    writeFileSync(join(intents, build!, "notes.md"), "Ana's note.\n");
    checkIn(laptop, "ana's note");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana)).toBeNull();
    expect(run(UTILITY, ["status"], ana, ENV).out).not.toContain("From others");
  });

  // Live runs (Windows Server, Kiro CLI): status said only whose records a pull
  // brought, and the agent said a merged Unit was still in progress.
  test("each pulled build says where it stands in the take question's words: pushed, waiting for its merge, merged, or pushed alone when its repos cannot be read here", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "checkout-ui started");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], ana, chat).status).toBe(0);
    const intents = join(ana, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    codeGenerated(ana, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], ana, chat);
    expect(pushed.status, pushed.out).toBe(0);
    checkIn(ana, "refunds pushed");
    git(bea, ["pull", "-q", "--no-rebase", "--no-edit"]);
    const fromOthers = (): string | undefined =>
      /^From others, at your last pull that brought changes: +(.*)$/m.exec(run(UTILITY, ["status"], bea, ENV).out)?.[1];
    // Her workspace has no copy of refunds' repos: where its merge stands cannot be read here.
    expect(fromOthers()).toBe("ana: refunds (pushed)");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, bea, name, "bea");
    expect(fromOthers()).toBe("ana: refunds (pushed, waiting for its merge)");
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    expect(fromOthers()).toBe("ana: refunds (merged)");
  });

  // Live runs (Kiro CLI, Claude Code on Windows Server): at a look from her next
  // build the agent said her own earlier Unit was still waiting for its merge
  // after it merged; status said only where the others' builds stood.
  test("status names the person's own other finished builds where each stands, in the same words; none for a first build, the lead's project or solo work", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], ana, chat).status).toBe(0);
    const intents = join(ana, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
    codeGenerated(ana, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], ana, chat);
    expect(pushed.status, pushed.out).toBe(0);
    checkIn(ana, "refunds pushed");
    const status = (): string => run(UTILITY, ["status"], ana, ENV).out;
    const yours = (): string | undefined => /^Yours: +(.*)$/m.exec(status())?.[1];
    // Her first build in hand, finished: it alone, where it stands.
    expect(yours(), status()).toBe("refunds (pushed, waiting for its merge)");
    const second = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], ana, chat);
    expect(second.status, second.out).toBe(0);
    expect(status()).toContain("Yours:          refunds (pushed, waiting for its merge)\n");
    // A repo of it not in this clone: where its merge stands cannot be read here.
    renameSync(join(ana, "billing"), join(ana, "billing-aside"));
    expect(yours()).toBe("refunds (pushed)");
    renameSync(join(ana, "billing-aside"), join(ana, "billing"));
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "merge");
    expect(yours()).toBe("refunds (merged)");
    // The lead's project, and work with no teams, have no such line.
    expect(run(UTILITY, ["status"], home.dir, ENV).out).not.toContain("Yours:");
    const solo = makeHome();
    expect(run(UTILITY, ["status"], solo.dir, ENV).out).not.toContain("Yours:");
  });

  // The GitHub live test: the lead's screen said "I've told Member A
  // u6-request-id is merged.", and her look on her finished build, then status,
  // left the agent only her earlier answer, "pushed, but not merged yet".
  test("the build in hand, finished, is on status's Yours line where the lead's project has it: merged once the lead records it", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const status = (): string => run(UTILITY, ["status"], alice, ENV).out;
    const yours = (): string | undefined => /^Yours: +(.*)$/m.exec(status())?.[1];
    expect(yours(), status()).toBe("refunds (pushed, waiting for its merge)");
    // The lead's word for each repo: only the claim says it merged.
    git(home.dir, ["fetch", "-q", "origin"]);
    for (const repo of ["checkout-api", "billing"]) {
      expect(run(UNIT, ["merged", "refunds", "--repo", repo, "--person-words", `${repo} merged it`], home.dir).status).toBe(0);
    }
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // Status alone reads the lead's project for it.
    expect(yours(), status()).toBe("refunds (merged)");
    // Her look with words on the finished build, then status: never waiting.
    next(alice, ENV, ["where do things stand?"]);
    expect(status()).toContain("Yours:          refunds (merged)\n");
    expect(status()).not.toContain("waiting for its merge");
  });

  test("two builds one teammate is building are each said building, in one line", () => {
    const home = makeHome({ dependencies: DEPENDENCIES.replace("depends_on: [refunds]", "depends_on: []") });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD], ana).status).toBe(0);
    checkIn(ana, "refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bea).status).toBe(0);
    expect(run(UNIT, ["take", "reporting", "--home", HOME_RECORD], bea).status).toBe(0);
    checkIn(bea, "checkout-ui and reporting started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(run(UTILITY, ["status"], ana, ENV).out)
      .toContain("From others, at your last pull that brought changes:    bea: checkout-ui (building), reporting (building)\n");
  });
});


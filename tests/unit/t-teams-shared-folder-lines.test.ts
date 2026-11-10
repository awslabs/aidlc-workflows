// covers: function:checkInLine, function:arrivedAtLastPull, function:mergedAtTeamLook, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push
//
// The lines a person meets in a workspace teams share by git (#2410). Carry on
// is offered only for the person's own team's build: another team's is said,
// with who builds it and where, and one pushed waits for its merge (a fresh
// clone, whose team is not known yet, names each team's). The check-in line is
// said once at a stop, at the push and at a Unit's end, never from what git
// status shows (AI-DLC's own audit rows always change aidlc/), and never names
// the person's tool folder. Status says what the last pull brought from the
// other teams.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { arrivedAtLastPull, checkInLine } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { mergedAtTeamLook, type UnitClaimPayload } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  claimPayload,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  makeHome,
  mergeOnHost,
  next,
  ORCH,
  refundsTaken,
  run,
  STATE,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const LINE = "Your teammates see where this work stands once aidlc/ is committed and pushed.";
type Choice = { label: string; detail?: string };

// The lead's work with its Units held for two teams, shared.
function homeWithTeams() {
  const home = makeHome();
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir).status).toBe(0);
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
  test("a fresh clone names each team's build; once the team is known, only its own is offered and the other is said", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD, "--team", "web"], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");

    const abe = cloneOf(home.remote, "abe");
    const fresh = next(abe);
    expect(carryOns(fresh), JSON.stringify(fresh)).toEqual([
      expect.objectContaining({ label: "Carry on refunds for the payments team", detail: "ana's build of it, from another computer." }),
      expect.objectContaining({ label: "Carry on checkout-ui for the web team", detail: "bea's build of it, from another computer." }),
    ]);

    const carried = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], abe);
    expect(carried.status, carried.out).toBe(0);
    expect(readFileSync(join(abe, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    // Abe's team is known now: the look with nothing of theirs selected.
    writeFileSync(join(abe, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const known = next(abe);
    expect(carryOns(known).map((choice) => choice.label), JSON.stringify(known)).toEqual(["Carry on refunds"]);
    expect(carryOns(known)[0].detail).toBe("ana's build of it, from another computer.");
    expect(String(known.question), JSON.stringify(known)).toContain("checkout-ui (being built by bea on another computer)");
  });

  test("a pushed build waits for its merge and is not offered; one the lead turned down is said so and stays its team's to carry on", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    checkIn(alice, "payments: refunds pushed");
    const look = next(cloneOf(home.remote, "abe"));
    expect(carryOns(look).map((choice) => choice.label), JSON.stringify(look)).not.toContain("Carry on refunds for the payments team");
    expect(String(look.question), JSON.stringify(look)).toContain("refunds (pushed, waiting for its merge)");

    // The lead turns it down in billing: it is back with payments.
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"], home.dir);
    expect(down.status, down.out).toBe(0);
    const again = next(cloneOf(home.remote, "abe-again"));
    expect(String(again.question), JSON.stringify(again)).not.toContain("refunds (pushed, waiting for its merge)");
    expect(carryOns(again), JSON.stringify(again)).toEqual([
      expect.objectContaining({ label: "Carry on refunds for the payments team", detail: "alice's build of it, from another computer; turned down in billing, back with payments." }),
    ]);
  });

  // A live run (Windows Server): a team's look said the Unit was waiting for its
  // merge after it had merged, until the lead's next look. The team's look runs
  // the lead's own merge rule, read only (mergedAtTeamLook), for its own pushed
  // build; the row that says it comes with its own change.
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
    const look = next(cloneOf(home.remote, "abe"));
    expect(carryOns(look), JSON.stringify(look)).toEqual([
      expect.objectContaining({ detail: "alice's build of it, from another computer; sent back from the lead's Build and Test, back with payments." }),
    ]);
    expect(JSON.stringify(look)).not.toContain("your Build and Test");
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
    const kept = JSON.parse(readFileSync(join(home.dir, "aidlc", ".aidlc-sessions", `${session}.person-lines`), "utf-8")) as {
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

describe("where things stand", () => {
  test("status says what the last pull brought from the other teams", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", "--home", HOME_RECORD, "--team", "payments"], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    expect(arrivedAtLastPull(ana, "payments")).toBeNull();
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD, "--team", "web"], bea).status).toBe(0);
    checkIn(bea, "web: checkout-ui started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana, "payments")).toBe("the web team's checkout-ui");
    const status = run(UTILITY, ["status"], ana, ENV);
    expect(status.out).toContain("From others:    the web team's checkout-ui (at your last pull that brought changes)");
    // Another pull, straight after, that brings the lead's change: only that one is said.
    writeFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "notes.md"), "Lead's note.\n");
    git(home.dir, ["pull", "-q", "--no-rebase", "--no-edit"]);
    checkIn(home.dir, "the lead's note");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(arrivedAtLastPull(ana, "payments")).toStartWith("the lead's ");
    expect(arrivedAtLastPull(ana, "payments")).not.toContain("checkout-ui");
  });
});


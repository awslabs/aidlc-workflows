// covers: function:checkInState, function:arrivedAtLastPull, function:mergedAtTeamLook, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push
//
// The lines a person meets in a workspace teams share by git (#2410). Carry on
// is offered only for the person's own take, by their git name, whatever space
// their clone is in: another's build is said, with who builds it and where, and
// carried on only when they ask; one pushed waits for its merge. The check-in
// line is said once at a stop, at the push and at a Unit's end in a Unit's
// build (never at the lead's own work, whose record the teams never read), never from
// what git status shows (AI-DLC's own audit rows always change aidlc/), and
// never names the person's tool folder. Status says what the last pull brought
// from the other teams.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { arrivedAtLastPull, checkInState } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { mergedAtTeamLook, type UnitClaimPayload } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
import { asLeadsOwnCheckout } from "../harness/team-unit-merge.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  DEPENDENCIES,
  ENV,
  finishBuild,
  git,
  HOME_RECORD,
  inSpace,
  makeHome,
  makePlanHomeWithRemote,
  mergeOnHost,
  next,
  ORCH,
  planWordAt,
  recordAt,
  refundsTaken,
  refundsTakenInClone,
  run,
  STATE,
  UNIT,
  UTILITY,
  takeIn,
  tempDir,
  sharePlan,
  planFrom,
  leadRecordOnItsOwnBranch,
  teamWorkspace,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// A team's record in aidlc/ is the team's to commit and share: no step says what a teammate sees of it, or where it
// stands; status says that when asked.
const CHECK_IN_SAID = /teammates see|aidlc\/ is committed and pushed|aidlc\/ is pushed on/;
const INIT = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-init.ts");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
type Choice = { label: string; detail?: string };

// The lead's work, teams chosen and every Unit open, its workspace pushed and its plan shared.
function homeWithTeams() {
  return makePlanHomeWithRemote({ repos: { app: codeHost("app") } });
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
    expect(takeIn("payments", ["refunds", ...planFrom(home)], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", ...planFrom(home)], bea).status).toBe(0);
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
    const mine = run(UNIT, ["take", "refunds", ...planFrom(home)], laptop);
    expect(mine.status, mine.out).toBe(0);
    expect(mine.json?.notice).toBe("Carrying on refunds, your build in the payments space.");
    expect(readFileSync(join(laptop, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");

    // Abe asks to carry on ana's build all the same: it is carried on, said as hers.
    const carried = run(UNIT, ["take", "refunds", ...planFrom(home)], abe);
    expect(carried.status, carried.out).toBe(0);
    expect(carried.json?.notice).toBe("Carrying on refunds, ana's build in the payments space.");
    expect(readFileSync(join(abe, "aidlc", "active-space"), "utf-8").trim()).toBe("payments");
    // With nothing of theirs selected, abe's look still offers neither build.
    writeFileSync(join(abe, "aidlc", "spaces", "payments", "intents", "active-intent"), "");
    const later = next(abe);
    expect(carryOns(later), JSON.stringify(later)).toEqual([]);
  });

  test("a pushed build waits for its merge and is not offered; one the lead turned down is said so and stays its taker's to carry on", () => {
    const { home, alice, record } = refundsTakenInClone();
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
    const { hosts, home, alice, record } = refundsTakenInClone();
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
    expect(merged).toContain("Merged: refunds (pushed by alice in payments).");
    expect(merged).not.toContain("Being built: refunds");
    expect(merged).not.toContain("waiting for its merge");
    expect(planWordAt(home, "refunds")?.verdicts).toBeUndefined();
  });

  test("the lead's merge rule, read at a team's checkout: merged once every repo has it, with nothing written to the claim", () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const payload = recordAt(home, "refunds")?.json as unknown as UnitClaimPayload;
    expect(mergedAtTeamLook(alice, payload)).toBe(false);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    expect(mergedAtTeamLook(alice, payload)).toBe(false);
    mergeOnHost(hosts.billing, "refunds", "squash");
    expect(mergedAtTeamLook(alice, payload)).toBe(true);
    expect(planWordAt(home, "refunds")?.verdicts).toBeUndefined();
  });

  test("a code repo offline, refusing, asking for a sign-in or never answering reads as not merged, asks nothing and keeps the lead's time limit", async () => {
    const { hosts, home, alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    const payload = recordAt(home, "refunds")?.json as unknown as UnitClaimPayload;
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
    const before = { askpass: process.env.GIT_ASKPASS, prompt: process.env.GIT_TERMINAL_PROMPT, protocols: process.env.GIT_ALLOW_PROTOCOL };
    // The person's own sign-in program, which a quiet fetch must never run.
    process.env.GIT_ASKPASS = askpass;
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    try {
      for (const url of ["http://127.0.0.1:9/billing.git", `http://127.0.0.1:${auth.port}/billing.git`, `http://127.0.0.1:${silent.port}/billing.git`]) {
        git(join(alice, "billing"), ["remote", "set-url", "origin", url]);
        const started = Date.now();
        expect(mergedAtTeamLook(alice, payload), url).toBe(false);
        expect((Date.now() - started) / 1000, url).toBeLessThan(30);
      }
      expect(readFileSync(log, "utf-8")).toContain("auth ");
      // A remote that never answers is asked once in a read, never again for the Unit's branch.
      expect(readFileSync(log, "utf-8").split("\n").filter((line) => line.startsWith("silent "))).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (before.askpass === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = before.askpass;
      if (before.prompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = before.prompt;
      if (before.protocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = before.protocols;
      auth.child.kill();
      silent.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no merge check runs for a build that is not pushed and waiting", async () => {
    const { alice, record } = refundsTakenInClone();
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
      // http allowed, so a merge check that did run would reach the server and be logged.
      next(alice, { ...ENV, GIT_ALLOW_PROTOCOL: "file:http" });
      expect(readFileSync(log, "utf-8")).toBe("");
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a build the lead sent back from Build and Test says it was the lead's Build and Test", () => {
    const { home, alice, record } = refundsTakenInClone();
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

describe("no line about the team's record at a stopping point", () => {
  test("the person's stop, and a plain look over the parked work, say nothing of it", () => {
    const { alice } = refundsTakenInClone();
    next(alice);
    const parked = run(ORCH, ["park"], alice);
    expect(parked.status, parked.out).toBe(0);
    expect(String(parked.json?.narration), parked.out).not.toMatch(CHECK_IN_SAID);
    const look = next(alice);
    expect(look.kind, JSON.stringify(look)).toBe("parked");
    expect(JSON.stringify(look)).not.toMatch(CHECK_IN_SAID);
    expect(JSON.stringify(look)).not.toContain("git add aidlc");
  });

  test("the push says nothing of it, nor of the tool folder", () => {
    const { alice, record } = refundsTakenInClone();
    codeGenerated(alice, record);
    finishBuild(record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(String(pushed.json?.notice), pushed.out).toContain("Pushed branch refunds");
    expect(String(pushed.json?.notice)).not.toMatch(CHECK_IN_SAID);
    expect(pushed.out).not.toContain("own folder");
  });

  test("the push put off says only that, and a later look at the finished build nothing more", () => {
    const { alice, record } = refundsTakenInClone();
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
    expect(later.json?.notice).toBe("Nothing is pushed. I'll push refunds when you ask.");
    // The end, and every look after it, carry nothing more.
    for (let look = 0; look < 2; look++) {
      const end = next(alice);
      expect(end.kind, JSON.stringify(end)).toBe("done");
      expect(JSON.stringify(end)).not.toContain("git add aidlc");
    }
  });

  // The teams read the plan, never the lead's record, so the lead's own work
  // never hears that its record is not checked in: not with the approval, not
  // kept for a chat's reply, not at a stop in the same turn.
  test("not said at the lead's own Build and Test end: the approval, a chat's reply and a stop after it carry none of it", () => {
    const home = homeWithTeams();
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    const chat: NodeJS.ProcessEnv = { ...ENV, CLAUDE_CODE_SESSION_ID: "7d8e2f3a-3b4c-4e5d-9a6b-2c3d4e5f6a70", CLAUDE_PID: String(process.pid) };
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir, chat);
    expect(approved.status, approved.out).toBe(0);
    expect(approved.out).not.toMatch(CHECK_IN_SAID);
    const parked = run(ORCH, ["park", "--person-asked"], home.dir, chat);
    expect(parked.status, parked.out).toBe(0);
    expect(parked.out).not.toMatch(CHECK_IN_SAID);
  });

  // The step and status read the plan's one list, so they say the same count.
  test("at the lead's project the approval's progress and status count the same stages", () => {
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
    const status = /^Completion: +(\d+)\/(\d+) stages /m.exec(run(UTILITY, ["status"], home.dir, ENV).out);
    expect(status).not.toBeNull();
    expect([step![1], step![2]]).toEqual([status![1], status![2]]);
  });

  // The lead approved a plan of N stages: choosing teams changes who builds
  // each Unit, never how many stages the plan has, so every count line keeps
  // the total the plan was offered with, as solo work does.
  const statusCount = (dir: string) => /^Completion: {5}(\d+)\/(\d+) stages \(\d+%\)$/m.exec(run(UTILITY, ["status"], dir, ENV).out);

  test("choosing teams leaves the stage count the plan was offered: the Units' own stages stay in it", () => {
    const home = makeHome();
    const offered = statusCount(home.dir);
    expect(offered).not.toBeNull();
    const chose = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(chose.status, chose.out).toBe(0);
    const state = readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md"), "utf-8");
    expect(state).toMatch(/^- \*\*Home Location\*\*: \S/m);
    expect(statusCount(home.dir)?.[2]).toBe(offered![2]);
  });

  test("at the lead's project the Units' own stages count as done once their boxes are, in the step and in status", () => {
    const home = makeHome();
    const offered = statusCount(home.dir);
    expect(offered).not.toBeNull();
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    sharePlan(home);
    const statePath = join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
      .replace(/^- \[ \] build-and-test /m, "- [?] build-and-test ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
    // The fixture's state has no Initialization rows, so every finished box is a stage the count names.
    const finished = () => (readFileSync(statePath, "utf-8").match(/^- \[x\] /gm) ?? []).length;
    expect(statusCount(home.dir)?.slice(1)).toEqual([String(finished()), offered![2]]);
    const approved = run(ORCH, ["report", "--stage", "build-and-test", "--result", "approved", "--user-input", "Approve"], home.dir);
    expect(approved.status, approved.out).toBe(0);
    expect(approved.json?.narration).toBe(`Progress: ${finished()} of ${offered![2]} stages done. Next: CI Pipeline.`);
  });
});

// Where a team's record stands is status's to say, when the person asks: no
// look says it, before or after their own commit and push.
describe("the checked-in fact", () => {
  const STATUS_YES = "Checked in:     yes, aidlc/ is in main on origin\n";
  const chatOf = (session: string): NodeJS.ProcessEnv => ({ ...ENV, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) });
  const statusOf = (dir: string): string => run(UTILITY, ["status"], dir, ENV).out;

  test("after the person's own commit and push, no look says anything of it, and status says yes", () => {
    const { alice } = refundsTakenInClone();
    const chat = chatOf("5b6c0d1e-1f2a-4c3b-8e4f-0a1b2c3d4e50");
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).not.toContain("Checked in:");
    checkIn(alice, "refunds parked");
    const look = next(alice, chat);
    expect(JSON.stringify(look)).not.toMatch(CHECK_IN_SAID);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).toContain(STATUS_YES);
  });

  // An aidlc/ that git ignores is in no commit at all, whatever the branch's log
  // shows: status says so, never that it is checked in.
  test("where git ignores aidlc/ and none of it is committed, status says git ignores it, never that it is checked in", () => {
    const { alice } = refundsTakenInClone();
    checkIn(alice, "refunds taken");
    expect(statusOf(alice)).toContain(STATUS_YES);
    git(alice, ["rm", "-r", "-q", "--cached", "aidlc"]);
    const ignore = join(alice, ".gitignore");
    writeFileSync(ignore, `${existsSync(ignore) ? readFileSync(ignore, "utf-8") : ""}aidlc/\n`);
    git(alice, ["add", ".gitignore"]);
    git(alice, ["commit", "-q", "-m", "aidlc/ stays in this clone"]);
    git(alice, ["push", "-q", "origin", "HEAD:main"]);
    expect(existsSync(join(alice, "aidlc"))).toBe(true);
    expect(statusOf(alice)).not.toContain("Checked in:     yes");
    expect(statusOf(alice)).toContain("Checked in:     no, git ignores aidlc/ here\n");
  });

  test("a change not checked in, or a decision of theirs only in this clone's audit, says nothing at a look or in status", () => {
    const { alice, record } = refundsTakenInClone();
    const chat = chatOf("4a5b9c0d-0e1f-4b2a-8d3e-9f0a1b2c3d40");
    next(alice, chat);
    expect(run(ORCH, ["park"], alice, chat).status).toBe(0);
    checkIn(alice, "refunds parked");
    // A change to the record the person has not checked in.
    writeFileSync(join(record, "notes.md"), "Not checked in yet.\n");
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).not.toContain("Checked in:");
    rmSync(join(record, "notes.md"));
    // A decision row of theirs, in this clone's own audit file only.
    const audit = join(record, "audit");
    const shard = readdirSync(audit).find((name) => readFileSync(join(audit, name), "utf-8").includes("**Event**: UNIT_TAKEN_IN"))!;
    writeFileSync(join(audit, shard), `${readFileSync(join(audit, shard), "utf-8")}\n## Gate Approved\n**Timestamp**: 2026-11-10T12:00:00Z\n**Event**: GATE_APPROVED\n**Stage**: functional-design\n**Git Name**: alice\n\n---\n`);
    expect(statusOf(alice)).not.toContain("Checked in:");
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
  });

  // A live run on GitHub: a record pushed with -u on a branch whose pull
  // request was open was said to be with the team while main had none of it.
  test("a record pushed on a branch not merged yet is in status as pushed there, and checked in once main has it; no look says either", () => {
    const { home, alice } = refundsTakenInClone();
    const chat = chatOf("6c7d1e2f-2a3b-4d4c-9f5a-1b2c3d4e5f60");
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).not.toMatch(CHECK_IN_SAID);
    git(alice, ["checkout", "-q", "-b", "records/refunds"]);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    git(alice, ["push", "-q", "-u", "origin", "records/refunds"]);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).toContain("Checked in:     pushed on records/refunds, not in main yet\n");
    // The pull request squash-merged on the host: main has the record as a commit of its own.
    const reviewer = cloneOf(home.remote, "reviewer");
    git(reviewer, ["fetch", "-q", "origin", "records/refunds"]);
    git(reviewer, ["merge", "-q", "--squash", "FETCH_HEAD"]);
    git(reviewer, ["commit", "-q", "-m", "refunds record (#1)"]);
    git(reviewer, ["push", "-q", "origin", "main"]);
    git(alice, ["fetch", "-q", "origin"]);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).toContain(STATUS_YES);
  });

  test("at the lead's own checkout the branch is read from this clone's refs, never asked of the remote, never the branch it is on", () => {
    const { home } = refundsTakenInClone();
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
    const plan = sharePlan(home);
    const alice = cloneOf(home.remote, "alice");
    git(alice, ["checkout", "-q", "records"]);
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
    inSpace(alice, "payments");
    const took = run(UNIT, ["take", "refunds", ...planFrom(plan)], alice);
    expect(took.status, took.out).toBe(0);
    const chat = chatOf("7d8e2f3a-3b4c-4e5d-8a6b-2c3d4e5f6a70");
    next(alice, chat);
    expect(String(run(ORCH, ["park"], alice, chat).json?.narration)).not.toMatch(CHECK_IN_SAID);
    git(alice, ["checkout", "-q", "-b", "pr/refunds"]);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    git(alice, ["push", "-q", "-u", "origin", "pr/refunds"]);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).toContain("Checked in:     pushed on pr/refunds, not in records yet\n");
    // Merged into records with a merge commit.
    const reviewer = cloneOf(home.remote, "reviewer");
    git(reviewer, ["checkout", "-q", "records"]);
    git(reviewer, ["fetch", "-q", "origin", "pr/refunds"]);
    git(reviewer, ["merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD"]);
    git(reviewer, ["push", "-q", "origin", "records"]);
    git(alice, ["fetch", "-q", "origin"]);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).toContain("Checked in:     yes, aidlc/ is in records on origin\n");
  });

  test("a branch never pushed cannot be told: no line at a look, at the stopping point or in status", () => {
    const { alice } = refundsTakenInClone();
    git(alice, ["checkout", "-q", "-b", "local-only"]);
    const chat = chatOf("3f4a8b9c-9d0e-4a1f-8c2d-8e9f0a1b2c30");
    next(alice, chat);
    const parked = run(ORCH, ["park"], alice, chat);
    expect(String(parked.json?.narration), parked.out).not.toMatch(CHECK_IN_SAID);
    git(alice, ["add", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "refunds parked"]);
    expect(JSON.stringify(next(alice, chat))).not.toMatch(CHECK_IN_SAID);
    expect(statusOf(alice)).not.toContain("Checked in:");
  });
});

describe("where things stand", () => {
  test("status says what the last pull brought from the other teams", () => {
    const home = homeWithTeams();
    const ana = cloneOf(home.remote, "ana");
    expect(takeIn("payments", ["refunds", ...planFrom(home)], ana).status).toBe(0);
    checkIn(ana, "payments: refunds started");
    expect(arrivedAtLastPull(ana)).toBeNull();
    const bea = cloneOf(home.remote, "bea");
    expect(takeIn("web", ["checkout-ui", ...planFrom(home)], bea).status).toBe(0);
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
    expect(run(UNIT, ["take", "refunds", ...planFrom(home)], ana).status).toBe(0);
    checkIn(ana, "refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(home)], bea).status).toBe(0);
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
    const plan = sharePlan(home);
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(plan)], bea).status).toBe(0);
    checkIn(bea, "checkout-ui started");
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    expect(run(UNIT, ["take", "refunds", ...planFrom(plan)], ana, chat).status).toBe(0);
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
    const plan = sharePlan(home);
    const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: "ana-chat" };
    const ana = cloneOf(home.remote, "ana");
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, ana, name, "ana");
    expect(run(UNIT, ["take", "refunds", ...planFrom(plan)], ana, chat).status).toBe(0);
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
    const second = run(UNIT, ["take", "checkout-ui", ...planFrom(plan)], ana, chat);
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
    const { home, alice, record } = refundsTakenInClone();
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
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
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
    const plan = sharePlan(home);
    const ana = cloneOf(home.remote, "ana");
    expect(run(UNIT, ["take", "refunds", ...planFrom(plan)], ana).status).toBe(0);
    checkIn(ana, "refunds started");
    const bea = cloneOf(home.remote, "bea");
    expect(run(UNIT, ["take", "checkout-ui", ...planFrom(plan)], bea).status).toBe(0);
    expect(run(UNIT, ["take", "reporting", ...planFrom(plan)], bea).status).toBe(0);
    checkIn(bea, "checkout-ui and reporting started");
    git(ana, ["pull", "-q", "--no-rebase", "--no-edit"]);
    expect(run(UTILITY, ["status"], ana, ENV).out)
      .toContain("From others, at your last pull that brought changes:    bea: checkout-ui (building), reporting (building)\n");
  });
});

// A live run on Codex: a member's fresh clone of the lead's workspace ran
// config and read "Updated. Your open work (<the lead's work>) carries on."
describe("config in a teammate's clone", () => {
  test("config names none of the lead's work as the person's open work; the lead's own checkout still hears it", () => {
    const home = homeWithTeams();
    asLeadsOwnCheckout(home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "the lead's plan"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    // Off this machine's own install and tool homes, as t304 runs config.
    const machine = tempDir("config-machine");
    const env = {
      ...Object.fromEntries(Object.entries(ENV).filter(([name]) => !/^(AIDLC_|CLAUDE_|KIRO_)/.test(name))),
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const config = (dir: string): string => {
      const done = spawnSync(process.execPath, [INIT, "config", "--project-dir", dir, "--from", CLAUDE_RELEASE, "--harness", "claude", "--mcp", "none", "--yes"], {
        cwd: dir,
        encoding: "utf-8",
        env,
      });
      expect(done.status, `${done.stdout}${done.stderr}`).toBe(0);
      return done.stdout;
    };
    const open = `Your open work (default/${HOME_RECORD}) carries on.`;
    expect(config(cloneOf(home.remote, "ana"))).not.toContain(open);
    expect(config(home.dir)).toContain(open);
  });
});

// The person asks AI-DLC to commit its record in a Unit's build: in the team's
// own workspace it is the build's own record, as at any other work; in a clone
// of a workspace that holds the lead's work too, aidlc/ holds the lead's record,
// so it is not committed from there.
describe("AI-DLC's record committed on the person's word in a Unit's build", () => {
  test("in the team's own workspace the build's own record is committed, never another work's", () => {
    const { alice, record } = refundsTaken();
    const other = join(alice, "aidlc", "spaces", "payments", "intents", "zz-another-work");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "notes.md"), "Another work of the team's.\n");
    const before = git(alice, ["rev-parse", "HEAD"]);
    const committed = run(UNIT, ["commit-record"], alice);
    expect(committed.status, committed.out).toBe(0);
    const head = git(alice, ["rev-parse", "--short", "HEAD"]);
    expect(String(committed.json?.notice)).toMatch(new RegExp(`^AI-DLC's record in aidlc/ is committed on main as ${head} \\(\\d+ files\\); nothing is pushed\\.$`));
    expect(git(alice, ["log", "-1", "--format=%s"])).toBe("Update AI-DLC's record");
    const shown = git(alice, ["diff", "--name-only", before, "HEAD"]).split("\n").filter(Boolean);
    const own = record.slice(alice.length + 1).split("\\").join("/");
    expect(shown.filter((path) => path.startsWith("aidlc/spaces/payments/intents/")).every((path) => path.startsWith(`${own}/`)), shown.join("\n")).toBe(true);
    expect(shown.some((path) => path.startsWith(`${own}/`))).toBe(true);
    expect(git(alice, ["status", "--porcelain", "--", other])).toContain("zz-another-work");
    const again = run(UNIT, ["commit-record"], alice);
    expect(again.json?.notice, again.out).toBe("AI-DLC's record in aidlc/ has nothing new to commit.");
  });

  // The record commit-record makes, by path, against where it started.
  const committedByRecord = (dir: string, before: string): string[] =>
    git(dir, ["diff", "--name-only", before, "HEAD"]).split("\n").filter(Boolean);

  test("in a clone made before the lead's record reached main, the build's own folder is committed and the lead's space's memory is not", () => {
    const units = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    kind: service\n    depends_on: []\n```\n";
    const { home, clone } = leadRecordOnItsOwnBranch(units);
    const took = run(UNIT, ["take", "refunds", "--plan", fixtureIntentId8(home.dir), "--from", home.remote], clone);
    expect(took.status, took.out).toBe(0);
    const intents = join(clone, "aidlc", "spaces", "default", "intents");
    const own = `aidlc/spaces/default/intents/${readdirSync(intents).find((name) => name.endsWith("-refunds"))}`;
    const before = git(clone, ["rev-parse", "HEAD"]);
    const committed = run(UNIT, ["commit-record"], clone);
    expect(committed.status, committed.out).toBe(0);
    const shown = committedByRecord(clone, before);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((path) => !path.startsWith(`${own}/`)), shown.join("\n")).toEqual([]);
    expect(git(clone, ["status", "--porcelain", "--", "aidlc/spaces/default/memory/project.md"])).toBe("?? aidlc/spaces/default/memory/project.md");
  });

  test("in a team's own workspace building in the default space, the space the lead's plan names, with nothing of aidlc/ in git yet: the build's own folder only", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
    const home = makePlanHomeWithRemote({ repos: hosts });
    const alice = teamWorkspace(hosts, "alice");
    git(alice, ["rm", "-r", "-q", "--cached", "aidlc"]);
    git(alice, ["commit", "-q", "-m", "aidlc/ out of git"]);
    const took = run(UNIT, ["take", "refunds", ...planFrom(home)], alice);
    expect(took.status, took.out).toBe(0);
    const intents = join(alice, "aidlc", "spaces", "default", "intents");
    const own = `aidlc/spaces/default/intents/${readdirSync(intents).find((name) => name.endsWith("-refunds"))}`;
    const before = git(alice, ["rev-parse", "HEAD"]);
    const committed = run(UNIT, ["commit-record"], alice);
    expect(committed.status, committed.out).toBe(0);
    const shown = committedByRecord(alice, before);
    expect(shown.filter((path) => !path.startsWith(`${own}/`)), shown.join("\n")).toEqual([]);
  });

  test("in a clone of a workspace that holds the lead's work, it is not committed, in today's words", () => {
    const { alice } = refundsTakenInClone();
    const head = git(alice, ["rev-parse", "HEAD"]);
    const refused = run(UNIT, ["commit-record"], alice);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("This checkout builds a Unit, so I don't commit aidlc/ from here: it holds the lead's record too.");
    expect(git(alice, ["rev-parse", "HEAD"])).toBe(head);
  });
});

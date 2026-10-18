// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, subcommand:aidlc-unit:hand-off, subcommand:aidlc-unit:take-in, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, function:checkTeamResults, function:switchSoloToTeams, function:buildClaimNotes
//
// The six scenarios of the build-out (#2410, section 3), at the engine level,
// each team on another tool's tree: one shared workspace with the repos side
// by side; one big code repo beside the workspace and the workspace inside it;
// a team keeping its own workspace repo, reaching the home by its address; a
// team that cannot reach the home, by hand-off file (CRLF, a folder with a
// space); solo work a second person joins; and what goes wrong (a turned-down
// PR, a refused push, a Unit started early, a shared input changed mid-build).
// Each team's stages are recorded built as the engine records them; the walk
// through every stage on every tree is t-unit-teams-journeys.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT, seedAidlcMemory, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  GIT_ENV,
  git,
  HOME_RECORD,
  type Home,
  makeHome,
  mergeOnHost,
  next,
  run,
  STATE,
  stateOf,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterEach(cleanupTeamBuild);

type Tool = "claude" | "kiro" | "kiro-ide" | "codex" | "cursor" | "opencode" | "copilot";
const LEAF: Record<Tool, string> = {
  claude: ".claude", kiro: ".kiro", "kiro-ide": ".kiro", codex: ".codex", cursor: ".cursor", opencode: ".aidlc", copilot: ".aidlc",
};

// A tool's own tree: its engine and its unit tool.
function tree(tool: Tool) {
  const tools = join(REPO_ROOT, "dist", tool, LEAF[tool], "tools");
  return {
    unit: join(tools, "aidlc-unit.ts"),
    next: (cwd: string, words: string[] = []) => next(cwd, undefined, words, join(tools, "aidlc-orchestrate.ts")),
  };
}

const notices = (step: Record<string, unknown>) => (step.change_notices ?? []) as string[];
const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function buildRecord(dir: string, space: string, unit: string): string {
  const intents = join(dir, "aidlc", "spaces", space, "intents");
  const name = readdirSync(intents).find((entry) => entry.endsWith(`-${unit}`));
  expect(name, readdirSync(intents).join(", ")).toBeDefined();
  return join(intents, name!);
}

// What Code Generation leaves in a Unit's build: each file in its repo's
// folder, and the manifest naming each by repo.
function built(record: string, unit: string, files: Array<{ repo?: string; folder: string; path: string }>): void {
  for (const file of files) {
    mkdirSync(join(file.folder, ...file.path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(file.folder, ...file.path.split("/")), `export const ${unit.replace(/-/g, "_")} = "${file.path}";\n`);
  }
  const stage = join(record, "construction", unit, "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: files.map(({ repo, path }) => (repo ? { repo, path } : { path })),
  }, null, 2)}\n`);
  writeFileSync(join(stage, "code-summary.md"), `# Code summary\n\n${unit}.\n`);
}

function teamsChosen(home: Home, assign: string[]): void {
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  const assigned = run(UNIT, ["assign", ...assign], home.dir);
  expect(assigned.status, assigned.out).toBe(0);
  commitAll(home.dir, "teams chosen");
  git(home.dir, ["push", "-q", "origin", "main"]);
}

function boardAt(home: Home): string {
  git(home.dir, ["fetch", "-q", "origin"]);
  const step = next(home.dir);
  return String(step.message ?? JSON.stringify(step));
}

describe("scenario 1: one shared workspace repo, the repos side by side", () => {
  test("repos.json puts the repos beside the workspace; the lead keeps theirs elsewhere; refunds merges repo by repo and reporting opens", () => {
    const hosts = { "checkout-api": codeHost("checkout-api"), "checkout-web": codeHost("checkout-web"), billing: codeHost("billing") };
    const home = makeHome({ repos: hosts });
    // The team keeps the repos side by side in one work folder; the lead's own
    // clones are where their repos.local.json says.
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({
      org: "your-org",
      repos: Object.keys(hosts).map((name) => ({ name, url: "", path: `../${name}` })),
    }, null, 2)}\n`);
    writeFileSync(join(home.dir, "repos.local.json"), `${JSON.stringify({
      repos: Object.keys(hosts).map((name) => ({ name, path: join(home.dir, name).replace(/\\/g, "/") })),
    }, null, 2)}\n`);
    appendFileSync(join(home.dir, ".gitignore"), "repos.local.json\n");
    commitAll(home.dir, "repos side by side");
    teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);

    // A payments developer on Cursor: the workspace and the two repos side by side.
    const cursor = tree("cursor");
    const alice = cloneOf(home.remote, "alice");
    cpSync(join(REPO_ROOT, "dist", "cursor"), alice, { recursive: true, force: false, errorOnExist: false });
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as keyof typeof hosts], join(alice, ".."), name, "alice");
    const offer = cursor.next(alice);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    expect(String(offer.question)).toContain("refunds (for payments; likely checkout-api, billing)");
    const took = run(cursor.unit, ["take", "refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    const record = buildRecord(alice, "payments", "refunds");
    built(record, "refunds", [
      { repo: "checkout-api", folder: join(alice, "..", "checkout-api"), path: "src/refunds.ts" },
      { repo: "billing", folder: join(alice, "..", "billing"), path: "lib/refund.ts" },
    ]);
    const pushed = run(cursor.unit, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Open a PR in each your usual way. You are on branch refunds in checkout-api and billing now.",
    );

    expect(boardAt(home)).toBe([
      "Units of fixture:",
      "- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
      "- checkout-ui, web: held for web, not taken yet",
      "- reporting, here: waits on refunds",
    ].join("\n"));
    mergeOnHost(hosts["checkout-api"], "refunds", "merge");
    expect(boardAt(home)).toContain("- refunds, payments: checkout-api merged, billing not merged yet (1 of 2 merged)");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    const step = next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    // reporting waited on refunds and is the home's own to build now: the
    // lead's chat builds it through every stage, and the board shows it done.
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
    const host = hostFor("claude", home.dir, GIT_ENV);
    const person = new PersonScript(host);
    const agent = new AgentStandIn(host, person, {
      units: ["refunds", "checkout-ui", "reporting"],
      codeRepo: (unit) => (unit === "reporting" ? [{ repo: "billing" }] : undefined),
      until: (d: Directive) => d.kind === "notice" || d.kind === "done" || (d.kind === "run-stage" && d.stage === "build-and-test"),
    });
    host.sessionStart("startup");
    person.say("/aidlc");
    const end = agent.drive(agent.next());
    expect(agent.worked.filter((d) => d.unit === "reporting").map((d) => d.stage)).toContain("code-generation");
    expect(end.kind, JSON.stringify(end)).toBe("notice");
    expect(String(end.message)).toContain("- reporting, here: done");
  });
});

describe("scenario 2: one big code repo", () => {
  const MONOREPO_UNITS = (prefix: string) => "# Unit dependencies\n\n```yaml\nunits:\n" +
    `  - name: refunds\n    repos: [${prefix}services/checkout-api, ${prefix}services/billing]\n    depends_on: []\n` +
    `  - name: checkout-ui\n    repos: [${prefix}apps/checkout-web]\n    depends_on: []\n` +
    "```\n";

  test("the workspace beside it: the code PR holds only code, and the home sees the one PR merge", () => {
    const platform = codeHost("platform");
    const home = makeHome({ dependencies: MONOREPO_UNITS("platform/") });
    const registryPath = join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = ["platform"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "platform", url: platform, path: "../platform" }] }, null, 2)}\n`);
    // The lead keeps platform in a folder of their own.
    const leads = tempDir("lead-src");
    git(leads, ["clone", "-q", platform, join(leads, "platform")]);
    writeFileSync(join(home.dir, "repos.local.json"), `${JSON.stringify({ repos: [{ name: "platform", path: join(leads, "platform") }] }, null, 2)}\n`);
    appendFileSync(join(home.dir, ".gitignore"), "repos.local.json\n");
    commitAll(home.dir, "the workspace beside platform");
    teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);

    const codex = tree("codex");
    const alice = cloneOf(home.remote, "alice");
    cloneCode(platform, join(alice, ".."), "platform", "alice");
    const took = run(codex.unit, ["take", "refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    built(buildRecord(alice, "payments", "refunds"), "refunds", [
      { repo: "platform", folder: join(alice, "..", "platform"), path: "services/checkout-api/src/refunds.ts" },
      { repo: "platform", folder: join(alice, "..", "platform"), path: "services/billing/lib/refund.ts" },
    ]);
    const pushed = run(codex.unit, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe("Pushed branch refunds in platform. Open a PR in it your usual way. You are on branch refunds in platform now.");
    expect(git(platform, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n").sort())
      .toEqual(["README.md", "services/billing/lib/refund.ts", "services/checkout-api/src/refunds.ts"]);
    expect(boardAt(home)).toContain("- refunds, payments: platform not merged yet");
    mergeOnHost(platform, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });

  test("the workspace inside it: the Unit's branch is the repo's own, and only its code is committed on it", () => {
    const home = makeHome({ dependencies: MONOREPO_UNITS("") });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "platform", path: "." }] }, null, 2)}\n`);
    writeFileSync(join(home.dir, "README.md"), "# platform\n");
    commitAll(home.dir, "AI-DLC inside platform");
    teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);

    const opencode = tree("opencode");
    const alice = cloneOf(home.remote, "alice");
    const took = run(opencode.unit, ["take", "refunds", "--home", HOME_RECORD], alice);
    expect(took.status, took.out).toBe(0);
    built(buildRecord(alice, "payments", "refunds"), "refunds", [
      { folder: alice, path: "services/checkout-api/src/refunds.ts" },
      { folder: alice, path: "services/billing/lib/refund.ts" },
    ]);
    const pushed = run(opencode.unit, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe("Pushed branch refunds in the repo. Open a PR in it your usual way. You are on branch refunds in the repo now.");
    // The commit on refunds is the code alone; the team's record stays theirs to commit.
    expect(git(alice, ["show", "--name-only", "--format=", "refunds"]).split("\n").sort())
      .toEqual(["services/billing/lib/refund.ts", "services/checkout-api/src/refunds.ts"]);
    expect(git(alice, ["status", "--porcelain", "--", "aidlc/spaces/payments"])).not.toBe("");
    expect(boardAt(home)).toContain("- refunds, payments: the repo not merged yet");
    mergeOnHost(home.remote, "refunds", "merge");
    git(home.dir, ["pull", "-q", "--ff-only", "origin", "main"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });
});

// A team's own workspace repo made from the home's: the home's record comes
// with it, its origin is the team's host.
function teamWorkspace(homeRemote: string, label: string): { dir: string; host: string } {
  const seed = cloneOf(homeRemote, `${label}-seed`);
  const host = tempDir(`${label}-host`);
  git(host, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["remote", "set-url", "origin", host]);
  git(seed, ["push", "-q", "origin", "main"]);
  return { dir: cloneOf(host, label), host };
}

describe("scenario 3: each team keeps its own workspace repo", () => {
  test("the web team's workspace reaches the home by its address: its build and record stay in its own repo, the result goes home", () => {
    const hosts = { "checkout-web": codeHost("checkout-web") };
    const home = makeHome({ repos: hosts });
    teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);
    const kiroIde = tree("kiro-ide");
    const web = teamWorkspace(home.remote, "wendy");
    cloneCode(hosts["checkout-web"], web.dir, "checkout-web", "wendy");
    const remotes = git(web.dir, ["remote"]);
    const offer = kiroIde.next(web.dir);
    expect(String(offer.question)).toStartWith(`fixture (its home is ${home.remote}) is built by teams, one Unit each.`);
    expect((offer.choices as Array<{ label: string }>).map((c) => c.label)).not.toContain("Carry on fixture");
    const took = run(kiroIde.unit, ["take", "checkout-ui", "--home", HOME_RECORD], web.dir);
    expect(took.status, took.out).toBe(0);
    const record = buildRecord(web.dir, "web", "checkout-ui");
    built(record, "checkout-ui", [{ repo: "checkout-web", folder: join(web.dir, "checkout-web"), path: "src/cart.tsx" }]);
    expect(run(kiroIde.unit, ["push"], web.dir).status).toBe(0);
    // The team's record goes to its own repo like any record; the home's main is untouched.
    const homeMain = git(home.remote, ["rev-parse", "main"]);
    commitAll(web.dir, "checkout-ui built");
    git(web.dir, ["push", "-q", "origin", "main"]);
    expect(git(home.remote, ["rev-parse", "main"])).toBe(homeMain);
    expect(git(web.dir, ["remote"])).toBe(remotes);
    // The home's copied work in their workspace is left as it is.
    expect(git(web.dir, ["diff", "--name-only", "origin/main~1", "origin/main", "--", seededRecordDir(web.dir).slice(web.dir.length + 1)])).toBe("");
    // A teammate clones the team's workspace and carries the build on.
    const will = cloneOf(web.host, "will");
    const carry = kiroIde.next(will);
    expect((carry.choices as Array<{ label: string }>).map((c) => c.label), JSON.stringify(carry)).toContain("Carry on checkout-ui");
    expect(run(kiroIde.unit, ["take", "checkout-ui", "--home", HOME_RECORD], will).json).toMatchObject({ resumed: true });
    expect(kiroIde.next(will).unit).toBe("checkout-ui");
    expect(boardAt(home)).toContain("- checkout-ui, web: checkout-web not merged yet");
    mergeOnHost(hosts["checkout-web"], "checkout-ui", "rebase");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ done: true });
  });

  test("read but not write: the result goes back as a file, said once", () => {
    const home = makeHome();
    teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);
    const hook = join(home.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'read-only for partners' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const kiroIde = tree("kiro-ide");
    const web = teamWorkspace(home.remote, "wendy");
    const took = run(kiroIde.unit, ["take", "checkout-ui", "--home", HOME_RECORD], web.dir);
    expect(took.status, took.out).toBe(0);
    expect(String(took.json?.notice)).toContain(
      "You can read the home but not write to it, so the result of checkout-ui goes back as a file when it is built.",
    );
  });
});

describe("scenario 4: a team that cannot reach the home", () => {
  test("the hand-off file goes out, the build starts from it, progress and the result come back as files, and the Unit is done", () => {
    const OPEN = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
      "  - name: reporting\n    repos: [ledger]\n    depends_on: []\n```\n";
    const home = makeHome({ dependencies: OPEN });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "refunds=payments"], home.dir).status).toBe(0);
    const handed = run(UNIT, ["hand-off", "reporting", "--team", "data", "--person-words", "hand off reporting to the data team"], home.dir);
    expect(handed.status, handed.out).toBe(0);
    const file = "aidlc/handoff/fixture-reporting.md";
    // The partner's own workspace on Copilot, with its own copy of ledger.
    const partner = join(tempDir("partner"), "data workspace");
    mkdirSync(partner, { recursive: true });
    seedAidlcMemory(partner);
    git(partner, ["init", "-q", "-b", "main"]);
    const ledger = codeHost("ledger");
    cloneCode(ledger, partner, "ledger", "dana");
    const copilot = tree("copilot");
    // Each file travels as a mail attachment saved with CRLF, into a folder with a space.
    const deliver = (from: string, rel: string): string => {
      const inbox = join(tempDir("inbox"), "from the other side");
      mkdirSync(inbox, { recursive: true });
      const path = join(inbox, rel.split("/").at(-1)!);
      writeFileSync(path, readFileSync(join(from, ...rel.split("/")), "utf-8").replace(/\n/g, "\r\n"));
      return path;
    };
    const ask = copilot.next(partner, [deliver(home.dir, file)]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-handoff");
    expect(run(copilot.unit, ["take", "--file", deliver(home.dir, file)], partner).status).toBe(0);
    expect(run(copilot.unit, ["progress"], partner).status).toBe(0);
    expect(run(UNIT, ["take-in", deliver(partner, "aidlc/handoff/fixture-reporting-progress.md")], home.dir).status).toBe(0);
    expect(String(next(home.dir).message)).toContain("- reporting, data: handed off by file, at Functional Design");
    const record = buildRecord(partner, "data", "reporting");
    built(record, "reporting", [{ folder: join(partner, "ledger"), path: "src/report.ts" }]);
    expect(run(copilot.unit, ["push"], partner).status).toBe(0);
    git(join(partner, "ledger"), ["switch", "-q", "main"]);
    git(join(partner, "ledger"), ["merge", "-q", "--ff-only", "reporting"]);
    git(join(partner, "ledger"), ["push", "-q", "origin", "main"]);
    const again = run(copilot.unit, ["push"], partner);
    expect(again.status, again.out).toBe(0);
    // The lead gives the result file's path to /aidlc: that step takes it in.
    const result = deliver(partner, "aidlc/handoff/fixture-reporting-result.md");
    const step = next(home.dir, undefined, [result]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.message)).toContain(`aidlc-unit.ts take-in '${result}'`);
    const taken = run(UNIT, ["take-in", result], home.dir);
    expect(taken.json?.notice).toBe("Took in reporting's result from data.");
    next(home.dir);
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => row.block).join("\n")).toContain("reported by data");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "reporting")).toMatchObject({ done: true });
  });
});

describe("scenario 5: solo work, then a second person joins", () => {
  test("a teammate on opencode takes an open Unit; the first machine switches to teams, keeps its work and asks nothing again", () => {
    const hosts = { "checkout-web": codeHost("checkout-web") };
    const home = makeHome({ repos: hosts });
    const row = (event: string, stage: string, unit: string) => appendAuditEntry(event, { Stage: stage, Unit: unit, "Run floor": "0" }, home.dir);
    row("UNIT_STARTED", "functional-design", "refunds");
    row("UNIT_COMPLETED", "code-generation", "refunds");
    row("UNIT_STARTED", "functional-design", "reporting");
    commitAll(home.dir, "solo work under way");
    git(home.dir, ["push", "-q", "origin", "main"]);

    const opencode = tree("opencode");
    const bob = cloneOf(home.remote, "bob");
    cloneCode(hosts["checkout-web"], bob, "checkout-web", "bob");
    const ask = opencode.next(bob);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((c) => c.label)).toEqual(["Carry on fixture here", "Take checkout-ui", "Follow along"]);
    const before = readFileSync(seededStateFile(bob), "utf-8");
    expect(run(opencode.unit, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    expect(readFileSync(seededStateFile(bob), "utf-8")).toBe(before);
    built(buildRecord(bob, "default", "checkout-ui"), "checkout-ui", [{ repo: "checkout-web", folder: join(bob, "checkout-web"), path: "src/cart.tsx" }]);
    expect(run(opencode.unit, ["push"], bob).status).toBe(0);

    git(home.dir, ["fetch", "-q", "origin"]);
    const step = next(home.dir);
    expect(notices(step)).toContain("Your teammate bob took checkout-ui; this session carries on with the rest, one Unit at a time.");
    expect(field(stateOf(home.dir), "Unit Ownership")).toBe("team");
    expect(step.unit).toBe("reporting");
    expect(next(home.dir).ask_type).toBeUndefined();
    mergeOnHost(hosts["checkout-web"], "checkout-ui", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "checkout-ui")).toMatchObject({ done: true });
  });
});

// The checkout example's home on two repos, refunds held for payments and
// taken on Kiro CLI, checkout-ui held for web.
function refundsOnKiro() {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makeHome({ repos: hosts });
  teamsChosen(home, ["refunds=payments", "checkout-ui=web"]);
  const kiro = tree("kiro");
  const alice = cloneOf(home.remote, "alice");
  for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
  expect(run(kiro.unit, ["take", "refunds", "--home", HOME_RECORD], alice).status).toBe(0);
  const record = buildRecord(alice, "payments", "refunds");
  const code = (body = "") => built(record, "refunds", [
    { repo: "checkout-api", folder: join(alice, "checkout-api"), path: "src/refunds.ts" },
    { repo: "billing", folder: join(alice, "billing"), path: `lib/refund${body}.ts` },
  ]);
  return { hosts, home, kiro, alice, record, code };
}

describe("scenario 6: when things go wrong", () => {
  test("a turned-down PR: the team hears it once in the home's words; checkout-ui stays merged; the next push is counted again", () => {
    const { hosts, home, kiro, alice, code } = refundsOnKiro();
    code();
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "they want the retry logic in the client"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(boardAt(home)).toContain("- refunds, payments: turned down in billing, back with payments");
    git(alice, ["fetch", "-q", "origin"]);
    expect(notices(kiro.next(alice))).toContain(
      'refunds was turned down in billing at the home: "they want the retry logic in the client". Say go back to Code Generation to change it, then push again.',
    );
    // The team changes billing and pushes again; checkout-api stays merged.
    code("-with-retry");
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts.billing, "refunds", "merge");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
    expect(git(hosts["checkout-api"], ["log", "--format=%s", "main"]).split("\n")).toContain("refunds (squashed)");
  });

  test("a push the host refuses is said once in its words, and nothing is retried", () => {
    const { hosts, kiro, alice, code } = refundsOnKiro();
    code();
    const hook = join(hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'branch protection: refunds needs a ticket' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const pushed = run(kiro.unit, ["push"], alice);
    expect(pushed.status).not.toBe(0);
    expect(String(pushed.json?.error)).toBe(
      "The push of refunds in billing was refused: branch protection: refunds needs a ticket (pre-receive hook declined). Nothing was retried.",
    );
  });

  test("a Unit started early, and a shared input changed mid-build: the data team hears each once, with the redo offer, and nothing is approved again", () => {
    const { hosts, home, kiro, alice, code } = refundsOnKiro();
    code();
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    // The data team on Claude Code starts reporting early, and walks its
    // Functional Design through to the next stage.
    const dana = cloneOf(home.remote, "dana");
    cpSync(join(REPO_ROOT, "dist", "claude"), dana, { recursive: true, force: false, errorOnExist: false });
    cloneCode(hosts.billing, dana, "billing", "dana");
    cloneCode(hosts["checkout-api"], dana, "checkout-api", "dana");
    const early = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--early", "--team", "data"], dana);
    expect(early.status, early.out).toBe(0);
    expect(String(early.json?.notice)).toContain("It starts early on the pushed branch of refunds in checkout-api and billing. It may still change before it merges.");
    const host = hostFor("claude", dana, GIT_ENV);
    const person = new PersonScript(host);
    const agent = new AgentStandIn(host, person, {
      units: ["reporting"],
      until: (d: Directive) => d.kind === "run-stage" && d.stage !== "functional-design",
    });
    host.sessionStart("startup");
    person.say("/aidlc");
    const after = agent.drive(agent.next());
    expect(after.stage, JSON.stringify(after)).toBe("nfr-requirements");

    // payments proposes a change to the requirements; the lead approves it at the home.
    const requirements = "inception/requirements-analysis/requirements.md";
    writeFileSync(join(buildRecord(alice, "payments", "refunds"), ...requirements.split("/")), "# Requirements\n\nFR1 refunds, with a reason.\n");
    expect(run(kiro.unit, ["propose", "--input", "requirements.md", "--person-words", "add refund_reason"], alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).ask_type).toBe("unit-amend");
    expect(run(UNIT, ["amend", "refunds", "--input", requirements, "--answer", "approve", "--person-words", "yes, add it"], home.dir).status).toBe(0);
    git(dana, ["fetch", "-q", "origin"]);
    const heard = agent.next();
    expect(notices(heard)).toContain(
      "Something Functional Design used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Functional Design with the change?",
    );
    expect(heard.stage).toBe("nfr-requirements");
    expect(notices(agent.next())).not.toContain(
      "Something Functional Design used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Functional Design with the change?",
    );

    // refunds merges and is done: the early team hears it once and keeps its work.
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    git(dana, ["fetch", "-q", "origin"]);
    expect(notices(agent.next())).toContain("refunds is done at the home. reporting started early on its branch: rebase on it when you are ready.");
    expect(git(join(dana, "billing"), ["branch", "--show-current"])).toBe("reporting");
    expect(existsSync(join(buildRecord(dana, "data", "reporting"), "construction", "reporting", "functional-design"))).toBe(true);
  });
});

// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:propose, subcommand:aidlc-unit:amend, function:checkTeamResults, function:switchSoloToTeams, function:buildClaimNotes
//
// The scenarios of the build-out (#2410, section 3), at the engine level, each
// team on another tool's tree, numbered as the RFC numbers them; every team
// works through git, so the RFC's fourth (a team that cannot reach the home,
// by file) has none: one shared workspace with the repos side by side; one big
// code repo beside the workspace (a workspace inside it keeps the team flow of
// one repo); a team keeping its own workspace repo, reaching the home by its
// address (one that can read but not push to it takes nothing); solo work a
// second person joins; and what goes wrong (a turned-down PR, a refused push,
// a Unit started early, a shared input changed mid-build).
// Each team's stages are recorded built as the engine records them; the walk
// through every stage on every tree is t-unit-teams-journeys.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { hostFor } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  fetchRecords,
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
  takeIn,
  inSpace,
  sharePlan,
  planFrom,
  planWordAt,
  type PlanHome,
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

// A take on a tree's own unit tool, from the space the person works in.
function takeWith(unitTool: string, space: string, args: string[], dir: string) {
  inSpace(dir, space);
  return run(unitTool, args, dir);
}

// Teams chosen at the lead's project: every Unit is open, and the plan is shared.
function teamsChosen(home: Home): PlanHome & Home {
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  commitAll(home.dir, "teams chosen");
  git(home.dir, ["push", "-q", "origin", "main"]);
  return sharePlan(home);
}

function boardAt(home: Home): string {
  fetchRecords(home.dir);
  const step = next(home.dir);
  return String(step.narration ?? step.message ?? JSON.stringify(step));
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
    writeFileSync(join(home.dir, "aidlc", "repos.local.json"), `${JSON.stringify({
      repos: Object.keys(hosts).map((name) => ({ name, path: join(home.dir, name).replace(/\\/g, "/") })),
    }, null, 2)}\n`);
    appendFileSync(join(home.dir, ".gitignore"), "repos.local.json\n");
    commitAll(home.dir, "repos side by side");
    const plan = teamsChosen(home);

    // A payments developer on Cursor: the workspace and the two repos side by side.
    const cursor = tree("cursor");
    const alice = cloneOf(home.remote, "alice");
    cpSync(join(REPO_ROOT, "dist", "cursor"), alice, { recursive: true, force: false, errorOnExist: false });
    for (const name of ["checkout-api", "billing"]) cloneCode(hosts[name as keyof typeof hosts], join(alice, ".."), name, "alice");
    const offer = cursor.next(alice);
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    expect(String(offer.question)).toContain("refunds (open; likely checkout-api, billing)");
    const took = takeWith(cursor.unit, "payments", ["take", "refunds", ...planFrom(plan)], alice);
    expect(took.status, took.out).toBe(0);
    const record = buildRecord(alice, "payments", "refunds");
    built(record, "refunds", [
      { repo: "checkout-api", folder: join(alice, "..", "checkout-api"), path: "src/refunds.ts" },
      { repo: "billing", folder: join(alice, "..", "billing"), path: "lib/refund.ts" },
    ]);
    const pushed = run(cursor.unit, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in checkout-api and billing. Open a PR in each your usual way. You're on refunds now in checkout-api and billing. Switch back to main any time.",
    );

    expect(boardAt(home)).toBe([
      "Units of fixture:",
      "- refunds, payments space: built by alice, checkout-api not merged yet, billing not merged yet (0 of 2 merged)",
      "- checkout-ui, open: waiting for a team to take it",
      "- reporting, open: waiting for a team to take it",
    ].join("\n"));
    mergeOnHost(hosts["checkout-api"], "refunds", "merge");
    expect(boardAt(home)).toContain("- refunds, payments space: built by alice, checkout-api merged, billing not merged yet (1 of 2 merged)");
    mergeOnHost(hosts.billing, "refunds", "squash");
    fetchRecords(home.dir);
    next(home.dir);
    expect(planWordAt(plan, "refunds")).toMatchObject({ done: true });
    // reporting waited on refunds and is open now; the lead asks to build it
    // at their own project, where their repos.local.json puts billing: the
    // lead's chat builds it through every stage, and the board shows it done.
    const here = run(UNIT, ["assign", "--here", "reporting", "--person-words", "we build reporting here"], home.dir);
    expect(here.status, here.out).toBe(0);
    const step = next(home.dir);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.unit).toBe("reporting");
    cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
    const host = hostFor("claude", home.dir, GIT_ENV);
    const person = new PersonScript(host);
    const agent = new AgentStandIn(host, person, {
      units: ["refunds", "checkout-ui", "reporting"],
      codeRepo: (unit) => (unit === "reporting" ? [{ repo: "billing" }] : undefined),
      until: (d: Directive) => (d.kind === "print" && d.board_note !== undefined) || d.kind === "done" ||
        (d.kind === "run-stage" && d.stage === "build-and-test"),
    });
    host.sessionStart("startup");
    person.say("/aidlc");
    const end = agent.drive(agent.next());
    expect(agent.worked.filter((d) => d.unit === "reporting").map((d) => d.stage)).toContain("code-generation");
    expect(end.kind, JSON.stringify(end)).toBe("print");
    expect(String(end.narration)).toContain("- reporting, here: done");
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
    writeFileSync(join(home.dir, "aidlc", "repos.local.json"), `${JSON.stringify({ repos: [{ name: "platform", path: join(leads, "platform") }] }, null, 2)}\n`);
    appendFileSync(join(home.dir, ".gitignore"), "repos.local.json\n");
    commitAll(home.dir, "the workspace beside platform");
    const plan = teamsChosen(home);

    const codex = tree("codex");
    const alice = cloneOf(home.remote, "alice");
    cloneCode(platform, join(alice, ".."), "platform", "alice");
    const took = takeWith(codex.unit, "payments", ["take", "refunds", ...planFrom(plan)], alice);
    expect(took.status, took.out).toBe(0);
    built(buildRecord(alice, "payments", "refunds"), "refunds", [
      { repo: "platform", folder: join(alice, "..", "platform"), path: "services/checkout-api/src/refunds.ts" },
      { repo: "platform", folder: join(alice, "..", "platform"), path: "services/billing/lib/refund.ts" },
    ]);
    const pushed = run(codex.unit, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    expect(pushed.json?.notice).toBe(
      "Pushed branch refunds in platform. Open a PR in it your usual way. You're on refunds now in platform. Switch back to main any time.",
    );
    expect(git(platform, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n").sort())
      .toEqual(["README.md", "services/billing/lib/refund.ts", "services/checkout-api/src/refunds.ts"]);
    expect(boardAt(home)).toContain("- refunds, payments space: built by alice, platform not merged yet");
    mergeOnHost(platform, "refunds", "squash");
    fetchRecords(home.dir);
    next(home.dir);
    expect(planWordAt(plan, "refunds")).toMatchObject({ done: true });
  });

  test("the workspace inside it: teams on its remote take each Unit, push it on its own branch and merge it by pull request, and the lead's look sees the merge", () => {
    // The code is the workspace's own repo (repos.json names it "."): the
    // work records no code repo of its own, and its teams build as teams
    // across repos do, each Unit on its own branch of this repository.
    const home = makeHome({ repos: {}, dependencies: MONOREPO_UNITS("") });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({ repos: [{ name: "platform", path: "." }] }, null, 2)}\n`);
    writeFileSync(join(home.dir, "README.md"), "# platform\n");
    commitAll(home.dir, "AI-DLC inside platform");
    git(home.dir, ["push", "-q", "origin", "main"]);
    const teams = run(STATE, ["set-unit-ownership", "team"], home.dir);
    expect(teams.status, teams.out).toBe(0);
    expect(field(stateOf(home.dir), "Home Location")).toBe(home.remote);
    const step = next(home.dir);
    expect(step.ask_type, JSON.stringify(step)).toBe("team-handover");
    expect(String(step.question)).toStartWith("Do you want me to share the plan with the teams?");
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const alice = cloneOf(home.remote, "alice");
    expect(takeWith(UNIT, "payments", ["take", "refunds", "--plan", fixtureIntentId8(home.dir), "--from", home.remote], alice).status).toBe(0);
    built(buildRecord(alice, "payments", "refunds"), "refunds", [
      { folder: alice, path: "services/checkout-api/src/refunds.ts" },
      { folder: alice, path: "services/billing/lib/refund.ts" },
    ]);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // Its pull request holds the Unit's code and AI-DLC's record of its build.
    expect(git(home.remote, ["diff", "--name-only", "main...refunds"]).split("\n").filter((path) => !path.startsWith("aidlc/")))
      .toEqual(["services/billing/lib/refund.ts", "services/checkout-api/src/refunds.ts"]);
    expect(boardAt(home)).toContain("- refunds, payments space: built by alice, the repo not merged yet");
    mergeOnHost(home.remote, "refunds", "squash");
    fetchRecords(home.dir);
    next(home.dir);
    // The plan is shared in the workspace's own repository here.
    const shared = { dir: home.dir, hosts: { workspace: home.remote }, id8: fixtureIntentId8(home.dir), plan: null };
    expect(planWordAt(shared, "refunds")).toMatchObject({ done: true });
  });
});

describe("scenario 5: solo work, then a second person joins", () => {
  test("a teammate on opencode takes an open Unit; the first machine switches to teams, keeps its work and asks nothing again", () => {
    const hosts = { "checkout-web": codeHost("checkout-web") };
    const home = makeHome({ repos: hosts });
    const row = (event: string, stage: string, unit: string) => appendAuditEntry(event, { Stage: stage, Unit: unit, "Run floor": "0" }, home.dir);
    row("UNIT_STARTED", "functional-design", "refunds");
    row("UNIT_COMPLETED", "code-generation", "refunds");
    // Approved at its checkpoint, as the walk records it.
    appendAuditEntry("GATE_APPROVED", {
      Stage: "code-generation", Unit: "refunds", "Gate Scope": "unit-end", "User Input": "Approve", "Run floor": "0",
    }, home.dir);
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
    // Solo work's Unit is built in the lead's own space.
    expect(run(opencode.unit, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    expect(readFileSync(seededStateFile(bob), "utf-8")).toBe(before);
    built(buildRecord(bob, "default", "checkout-ui"), "checkout-ui", [{ repo: "checkout-web", folder: join(bob, "checkout-web"), path: "src/cart.tsx" }]);
    expect(run(opencode.unit, ["push"], bob).status).toBe(0);

    fetchRecords(home.dir);
    const step = next(home.dir);
    expect(notices(step)).toContain("Your teammate bob took checkout-ui; this session carries on with the rest, one Unit at a time, and you can ask to sign off a teammate's result yourself before it counts as done.");
    expect(field(stateOf(home.dir), "Unit Ownership")).toBe("team");
    expect(step.unit).toBe("reporting");
    expect(next(home.dir).ask_type).toBeUndefined();
    mergeOnHost(hosts["checkout-web"], "checkout-ui", "squash");
    fetchRecords(home.dir);
    next(home.dir);
    // No plan is shared for solo work a teammate took: the lead's own record keeps the merge it saw.
    expect(readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => row.block).join("\n")).toContain("checkout-ui");
  });
});

// The checkout example's home on two repos, every Unit open, refunds taken
// on Kiro CLI from the payments space.
function refundsOnKiro() {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makeHome({ repos: hosts });
  const plan = teamsChosen(home);
  const kiro = tree("kiro");
  const alice = cloneOf(home.remote, "alice");
  for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
  expect(takeWith(kiro.unit, "payments", ["take", "refunds", ...planFrom(plan)], alice).status).toBe(0);
  const record = buildRecord(alice, "payments", "refunds");
  const code = (body = "") => built(record, "refunds", [
    { repo: "checkout-api", folder: join(alice, "checkout-api"), path: "src/refunds.ts" },
    { repo: "billing", folder: join(alice, "billing"), path: `lib/refund${body}.ts` },
  ]);
  return { hosts, home: plan, kiro, alice, record, code };
}

describe("scenario 6: when things go wrong", () => {
  test("a turned-down PR: the team hears it once in the home's words; checkout-ui stays merged; the next push is counted again", () => {
    const { hosts, home, kiro, alice, code } = refundsOnKiro();
    code();
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    fetchRecords(home.dir);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "they want the retry logic in the client"], home.dir);
    expect(down.status, down.out).toBe(0);
    expect(boardAt(home)).toContain("- refunds, payments space: turned down in billing, back with alice");
    fetchRecords(alice);
    expect(notices(kiro.next(alice))).toContain(
      'refunds was turned down in billing by the lead: "they want the retry logic in the client".',
    );
    // The team changes billing and pushes again; checkout-api stays merged.
    code("-with-retry");
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    mergeOnHost(hosts.billing, "refunds", "merge");
    fetchRecords(home.dir);
    next(home.dir);
    expect(planWordAt(home, "refunds")).toMatchObject({ done: true });
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
      "The push of refunds in billing was refused: branch protection: refunds needs a ticket (pre-receive hook declined). Nothing was retried. You're on refunds now in checkout-api and billing. Switch back to main any time. " +
        "If it is the commit message, tell me the one to use, and I will commit with it and push again.",
    );
  });

  test("a Unit started early, and a shared input changed mid-build: the data team hears each once, with the redo offer, and nothing is approved again", () => {
    const { hosts, home, kiro, alice, code } = refundsOnKiro();
    code();
    expect(run(kiro.unit, ["push"], alice).status).toBe(0);
    fetchRecords(home.dir);
    // The data team on Claude Code starts reporting early, and walks its
    // Functional Design through to the next stage.
    const dana = cloneOf(home.remote, "dana");
    cpSync(join(REPO_ROOT, "dist", "claude"), dana, { recursive: true, force: false, errorOnExist: false });
    cloneCode(hosts.billing, dana, "billing", "dana");
    cloneCode(hosts["checkout-api"], dana, "checkout-api", "dana");
    const early = takeIn("data", ["reporting", ...planFrom(home), "--early"], dana);
    expect(early.status, early.out).toBe(0);
    // reporting's plan lists billing only: checkout-api, which refunds also pushed, stays as it is.
    expect(String(early.json?.notice)).toContain("It starts early on the pushed branch of refunds in billing. It may still change before it merges.");
    expect(git(join(dana, "checkout-api"), ["branch", "--show-current"])).toBe("main");
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
    fetchRecords(home.dir);
    expect(next(home.dir).ask_type).toBe("unit-amend");
    expect(run(UNIT, ["amend", "refunds", "--input", requirements, "--answer", "approve", "--person-words", "yes, add it"], home.dir).status).toBe(0);
    fetchRecords(dana);
    const heard = agent.next();
    expect(notices(heard)).toContain(
      "Something Functional Design used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Functional Design with the change?",
    );
    expect(heard.stage).toBe("nfr-requirements");
    expect(notices(agent.next())).not.toContain(
      "Something Functional Design used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Functional Design with the change?",
    );

    // refunds merges and is done: the early team is offered once to move onto main, and keeps its work.
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
    fetchRecords(home.dir);
    next(home.dir);
    fetchRecords(dana);
    const move = agent.next();
    expect(move.ask_type, JSON.stringify(move)).toBe("unit-move-onto");
    expect(String(move.question)).toStartWith("refunds is merged into main. Do you want me to move reporting onto main now?");
    expect(git(join(dana, "billing"), ["branch", "--show-current"])).toBe("reporting");
    expect(existsSync(join(buildRecord(dana, "data", "reporting"), "construction", "reporting", "functional-design"))).toBe(true);
  });
});

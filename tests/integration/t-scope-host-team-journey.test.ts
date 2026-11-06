// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, function:checkTeamResults, function:unitMergeVerdict, function:localRepoOverrideLines
//
// The build-out's journey (#2410, section 3), on every tool's tree, in one piece
// of work. The home is the lead's clone on Claude Code; each team works in its
// own clone with its own tool's tree, through that tool's own hooks: it is
// offered its Unit, takes it, builds it with the agent stand-in (every stage,
// its gate and the code plan approved by the person), pushes it, and its repos
// merge their own way (squash, merge commit, rebase). One team keeps its repos
// outside the workspace, in its own repos.local.json. The home sees every
// merge, records each Unit done, opens the Unit that waited, and runs Build and
// Test once every Unit is in. The home's plan skips the NFR and infrastructure
// stages, as t-scope-host-* journeys skip design stages, so each build walks
// Functional Design and Code Generation.
//
// The teams reach their Units by the routes the live runs took, where a bare
// `next` once passed while those routes broke (x2783-s9): opencode's bare
// /aidlc through its skill's status probe and `next --resume`; a teammate's
// first line in words; a new chat's words at the push question; a take whose
// repo is not checked out yet; a fresh clone's offer after a merge; the lead's
// look at the board between a merge and the step that records it. They come in
// the order they were fixed, so on an older engine the journey stops at the
// first route it still breaks. The cases after the journey are routes of their
// own: the lead's project building a Unit while a team's Unit merges.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
import { type HostName, hostFor, OpencodeScopeHost } from "../harness/scope-hosts.ts";
import { AgentStandIn, type Directive, PersonScript } from "../harness/scope-run.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  GIT_ENV,
  git,
  type Home,
  homeState,
  makeHome,
  mergeOnHost,
  run,
  STATE,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(60 * 60_000);
// opencode's host keeps a worker for its plugin; it goes with the clones.
const opened: OpencodeScopeHost[] = [];
afterAll(() => {
  for (const host of opened) host.dispose();
  cleanupTeamBuild();
});

type Tool = "claude" | HostName;
type Merge = "squash" | "merge" | "rebase";

interface Plan {
  unit: string;
  team: string;
  tool: Tool;
  person: string;
  repos: Array<{ repo: string; merge: Merge }>;
  dependsOn?: string;
}

// The checkout example's three Units, and four more so every tool's tree has a
// team of its own.
const PLAN: readonly Plan[] = [
  { unit: "search", team: "discovery", tool: "opencode", person: "dora", repos: [{ repo: "checkout-web", merge: "squash" }] },
  { unit: "receipts", team: "finance", tool: "copilot", person: "frank", repos: [{ repo: "checkout-api", merge: "rebase" }] },
  { unit: "checkout-ui", team: "web", tool: "codex", person: "wendy", repos: [{ repo: "checkout-web", merge: "rebase" }] },
  { unit: "refunds", team: "payments", tool: "kiro", person: "alice", repos: [{ repo: "checkout-api", merge: "squash" }, { repo: "billing", merge: "merge" }] },
  { unit: "alerts", team: "ops", tool: "kiro-ide", person: "omar", repos: [{ repo: "billing", merge: "squash" }] },
  { unit: "ledger", team: "platform", tool: "claude", person: "pat", repos: [{ repo: "checkout-api", merge: "merge" }] },
  { unit: "reporting", team: "data", tool: "cursor", person: "dana", repos: [{ repo: "billing", merge: "rebase" }], dependsOn: "refunds" },
];
const FIRST = PLAN.filter((p) => p.dependsOn === undefined);
const plan = (unit: string): Plan => PLAN.find((p) => p.unit === unit)!;

const UNIT_ASKS = new Set(["unit-take", "unit-push", "unit-assignment", "unit-amend", "unit-signoff", "unit-handoff"]);

// The lead's project at the first Construction step, its plan skipping the
// NFR and infrastructure stages, with the lead's tree and the Units held as
// `assign` says: committed and pushed, as the lead shares it.
function leadsProject(hosts: Record<string, string>, units: readonly Plan[], assign: string[]): { home: Home; id8: string; assigned: Record<string, unknown> } {
  const dependencies = "# Unit dependencies\n\n```yaml\nunits:\n" +
    units.map((p) => `  - name: ${p.unit}\n    kind: service\n    repos: [${p.repos.map((r) => r.repo).join(", ")}]\n    depends_on: [${p.dependsOn ?? ""}]\n`).join("") +
    "```\n";
  const state = homeState().replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
  const home = makeHome({ repos: hosts, dependencies, state });
  cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  const assigned = run(UNIT, ["assign", ...assign], home.dir);
  expect(assigned.status, assigned.out).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return { home, id8: fixtureIntentId8(home.dir), assigned: assigned.json ?? {} };
}

interface Team {
  plan: Plan;
  dir: string;
  agent: AgentStandIn;
  person: PersonScript;
}

// A teammate's clone of the workspace with their own tool's tree laid in beside
// its files, and their clones of the Unit's repos: under the workspace, or, with
// `elsewhere`, in a folder of their own that their repos.local.json names. A
// repo in `without` is not checked out yet.
function teamClone(home: Home, hosts: Record<string, string>, plan: Plan, opts: { elsewhere?: boolean; without?: string[] } = {}): Team {
  const dir = cloneOf(home.remote, plan.person);
  cpSync(join(REPO_ROOT, "dist", plan.tool), dir, { recursive: true, force: false, errorOnExist: false });
  const folders = new Map<string, string>();
  const own = opts.elsewhere === true ? tempDir(`${plan.person}-src`) : null;
  for (const { repo } of plan.repos.filter((r) => !(opts.without ?? []).includes(r.repo))) {
    if (own === null) {
      cloneCode(hosts[repo], dir, repo, plan.person);
      continue;
    }
    git(own, ["clone", "-q", hosts[repo], join(own, repo)]);
    git(join(own, repo), ["config", "user.name", plan.person]);
    git(join(own, repo), ["config", "user.email", `${plan.person}@example.test`]);
    folders.set(repo, relative(dir, join(own, repo)));
  }
  if (own !== null) {
    writeFileSync(join(dir, "repos.local.json"), `${JSON.stringify({
      repos: plan.repos.map(({ repo }) => ({ name: repo, path: join(own, repo).replace(/\\/g, "/") })),
    }, null, 2)}\n`);
  }
  const host = hostFor(plan.tool, dir, GIT_ENV);
  if (host instanceof OpencodeScopeHost) opened.push(host);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: [plan.unit],
    codeRepo: () => plan.repos.map(({ repo }) => ({ repo, folder: folders.get(repo) })),
    until: (d: Directive) => d.kind === "ask" && UNIT_ASKS.has(String(d.ask_type)),
  });
  host.sessionStart("startup");
  return { plan, dir, agent, person };
}

// The person picks a choice of a Unit question, and the agent runs its command.
function pick(team: { agent: AgentStandIn; person: PersonScript }, d: Directive, label: string): Record<string, unknown> {
  const choices = (d.choices as Array<{ label: string; command?: string }> | undefined) ?? [];
  const choice = choices.find((c) => c.label === label);
  expect(choice?.command, `${label} in ${JSON.stringify(d)}`).toBeString();
  team.person.pick(String(d.question), choices.map((c) => c.label), label);
  const ran = team.agent.host.bash(choice!.command!);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

// The take offer's choice for a Unit, whatever team its label names.
function startChoice(offer: Directive, unit: string): { label: string; command: string } {
  const choice = ((offer.choices as Array<{ label: string; command?: string }> | undefined) ?? [])
    .find((c) => c.label === `Start ${unit}` || c.label.startsWith(`Start ${unit} for `));
  expect(choice?.command, `Start ${unit} in ${JSON.stringify(offer)}`).toBeString();
  return choice as { label: string; command: string };
}

// The team takes the Unit it was offered and builds it to the push question.
function takeAndBuild(team: Team, offer: Directive, unit = team.plan.unit): { took: Record<string, unknown>; end: Directive } {
  expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
  const took = pick(team, offer, startChoice(offer, unit).label);
  const end = team.agent.drive(team.agent.next());
  expect(end.ask_type, JSON.stringify(end)).toBe("unit-push");
  return { took, end };
}

// A team's whole turn: offered its Unit at `/aidlc`, takes it, builds it to the
// push question, and pushes.
function takeBuildPush(team: Team): { took: Record<string, unknown>; pushed: Record<string, unknown> } {
  team.person.say("/aidlc");
  const { took, end } = takeAndBuild(team, team.agent.next());
  return { took, pushed: pick(team, end, "Push") };
}

// opencode's skill enters a bare /aidlc through a read-only status probe and
// carries on the work it reports with `next --resume` ("Bare session re-entry
// on opencode"). In a fresh clone of the lead's workspace the probe lists the
// lead's work, and the live agent carried it on.
function opencodeBareEntry(team: Team): Directive {
  team.person.say("/aidlc");
  const probe = team.agent.host.bash(`bun ${team.agent.host.dir}/tools/aidlc.ts --status`);
  expect(probe.status, probe.stdout + probe.stderr).toBe(0);
  return team.agent.next("--resume");
}

// The agent reads words that only ask for the work to go on against the print
// they got: it takes the print's own way on, a bare `next`, and drives from there.
function goOn(who: { agent: AgentStandIn }, said: Directive): Directive {
  if (said.kind !== "print") return said;
  expect(String(said.message), `no way for the work to go on in ${JSON.stringify(said)}`)
    .toMatch(/run `[^`]*orchestrate\.ts next` with nothing after it/);
  return who.agent.drive(who.agent.next());
}

// The person picks a choice whose command prints words, not a result, and the agent runs it.
function choose(team: Team, question: string, choices: Array<{ label: string; command?: string }>, label: string): string {
  const choice = choices.find((c) => c.label === label);
  expect(choice?.command, `${label} in ${JSON.stringify(choices)}`).toBeString();
  team.person.pick(question, choices.map((c) => c.label), label);
  const ran = team.agent.host.bash(choice!.command!);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return ran.stdout;
}

// The lead's chat at the home; the journey ends at the first step after Build
// and Test (the fixture's state lists Construction only).
function homeStandIn(home: Home) {
  const host = hostFor("claude", home.dir, GIT_ENV);
  const person = new PersonScript(host);
  const agent = new AgentStandIn(host, person, {
    units: PLAN.map((p) => p.unit),
    until: (d: Directive) => d.kind === "run-stage" && d.stage !== "build-and-test",
  });
  host.sessionStart("startup");
  return { host, person, agent };
}

// What came back from a team's push: the result its claim carries, by its person, with the Unit's two files.
function expectResult(remote: string, id8: string, p: Plan, pushed: Record<string, unknown>): void {
  expect(pushed).toMatchObject({ pushed: true, unit: p.unit, repos: p.repos.map((r) => r.repo) });
  const result = claimPayload(remote, id8, p.unit)?.result as { by: string; repos: Array<{ repo: string; paths: Record<string, string> }> };
  expect(result.by).toBe(p.person);
  for (const repo of result.repos) expect(Object.keys(repo.paths).sort()).toEqual([`src/${p.unit}.ts`, `test/${p.unit}.test.ts`]);
}

const unitsMerged = (dir: string): string[] =>
  readAuditShardEvents(dir).filter((row) => row.event === "UNIT_MERGED").map((row) => /\*\*Unit\*\*: (\S+)/.exec(row.block)?.[1] ?? "").sort();

describe("one piece of work, a team on every tool", () => {
  test("each team takes, builds and pushes its Unit by the routes the live runs took; the repos merge their own way; the home records every Unit done and runs Build and Test", () => {
    const hosts: Record<string, string> = { "checkout-api": codeHost("checkout-api"), "checkout-web": codeHost("checkout-web"), billing: codeHost("billing") };
    const { home, id8 } = leadsProject(hosts, PLAN, PLAN.map((p) => `${p.unit}=${p.team}`));
    const teams = new Map<string, Team>();
    const pushedBy = new Map<string, Record<string, unknown>>();

    // Discovery, on opencode: a bare /aidlc through the skill's probe is offered
    // search (a live run once got the lead's board there and released a team's
    // Unit). Dora builds it to the push question, then goes to run the tests herself.
    const dora = teamClone(home, hosts, plan("search"));
    teams.set("search", dora);
    const doraBuilt = takeAndBuild(dora, opencodeBareEntry(dora));
    expect(doraBuilt.took).toMatchObject({ taken: true, unit: "search", team: "discovery", space: "discovery" });

    // Finance, on Copilot CLI: the teammate's first line is words, which get the
    // Units to take (a live run once got the pick of the lead's work itself).
    const frank = teamClone(home, hosts, plan("receipts"));
    teams.set("receipts", frank);
    const frankBuilt = takeAndBuild(frank, frank.agent.personTypes("/aidlc Hi, I am on the finance team. What is ours to build?"));
    expect(frankBuilt.took).toMatchObject({ taken: true, unit: "receipts", team: "finance", space: "finance" });
    pushedBy.set("receipts", pick(frank, frankBuilt.end, "Push"));

    // Dora's next chat: her words at the push question get the push (a live run
    // once heard the work was finished, and the agent pushed by hand).
    dora.agent.host.newSession();
    const back = goOn(dora, dora.agent.personTypes("/aidlc where were we?"));
    expect(back.ask_type, JSON.stringify(back)).toBe("unit-push");
    pushedBy.set("search", pick(dora, back, "Push"));

    // The web team, on Codex, has no checkout of checkout-web yet: the take
    // offers to clone it where repos.json puts it (a live run once asked for an
    // address repos.json holds, then cloned it inside Code Generation), and no
    // file of the clone is named at a gate as changed by the build.
    const wendy = teamClone(home, hosts, plan("checkout-ui"), { without: ["checkout-web"] });
    teams.set("checkout-ui", wendy);
    wendy.person.say("/aidlc");
    const wendyOffer = wendy.agent.next();
    expect(wendyOffer.ask_type, JSON.stringify(wendyOffer)).toBe("unit-take");
    const wendyTook = pick(wendy, wendyOffer, startChoice(wendyOffer, "checkout-ui").label);
    const clone = (wendyTook.offer as { choices?: Array<{ label: string; command?: string }> } | undefined)?.choices ?? [];
    expect(clone.map((c) => c.label), JSON.stringify(wendyTook)).toEqual(["Clone checkout-web", "Not now"]);
    choose(wendy, String(wendyTook.notice), clone, "Clone checkout-web");
    expect(existsSync(join(wendy.dir, "checkout-web", "README.md"))).toBe(true);
    const wendyEnd = wendy.agent.drive(wendy.agent.next());
    expect(wendyEnd.ask_type, JSON.stringify(wendyEnd)).toBe("unit-push");
    expect(JSON.stringify([wendy.agent.directives, wendy.agent.notices])).not.toMatch(/changed outside any unit's work[^"]*checkout-web\//);
    pushedBy.set("checkout-ui", pick(wendy, wendyEnd, "Push"));

    // Every other team with nothing to wait on takes, builds and pushes from a bare /aidlc.
    for (const p of FIRST.filter((p) => !teams.has(p.unit))) {
      const team = teamClone(home, hosts, p, { elsewhere: p.unit === "refunds" });
      teams.set(p.unit, team);
      const { took, pushed } = takeBuildPush(team);
      expect(took).toMatchObject({ taken: true, unit: p.unit, team: p.team, space: p.team });
      pushedBy.set(p.unit, pushed);
    }
    for (const p of FIRST) expectResult(home.remote, id8, p, pushedBy.get(p.unit)!);
    // The payments team's repos live outside its workspace, where its own
    // repos.local.json says; the branch is pushed from there.
    const payments = teams.get("refunds")!;
    expect(existsSync(join(payments.dir, "checkout-api"))).toBe(false);
    expect(git(hosts.billing, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("src/refunds.ts");

    // The home sees what came back before anything merged, with no fetch by the lead.
    const lead = homeStandIn(home);
    lead.person.say("/aidlc");
    const board = lead.agent.next();
    expect(board.kind, JSON.stringify(board)).toBe("print");
    expect(String(board.narration)).toContain("- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)");
    expect(String(board.narration)).toContain("- reporting, data: held for data, not taken yet");

    // Each repo merges its own way.
    for (const p of FIRST) for (const { repo, merge } of p.repos) mergeOnHost(hosts[repo], p.unit, merge);
    const seen = lead.agent.next();
    expect(unitsMerged(home.dir), JSON.stringify(seen)).toEqual(FIRST.map((p) => p.unit).sort());
    for (const p of FIRST) expect(claimPayload(home.remote, id8, p.unit), p.unit).toMatchObject({ done: true });
    expect(String(seen.narration)).toContain("- refunds, payments: done");

    // refunds is done, so reporting opens for data, who builds it on Cursor. The
    // lead's state as last pushed still has refunds under way, and the take
    // offer never says a Unit done on its claim is being built.
    const data = teamClone(home, hosts, plan("reporting"));
    teams.set("reporting", data);
    data.person.say("/aidlc");
    const dataOffer = data.agent.next();
    expect(String(dataOffer.question), JSON.stringify(dataOffer)).not.toContain("Being built");
    const dataBuilt = takeAndBuild(data, dataOffer);
    expectResult(home.remote, id8, plan("reporting"), pick(data, dataBuilt.end, "Push"));
    mergeOnHost(hosts.billing, "reporting", "rebase");

    // The lead asks where things stand before their next step: the merge the
    // board sees is said as not recorded yet (a live run once read it as merged
    // while nothing was recorded), and the look records nothing.
    const status = lead.agent.personTypes("/aidlc --status");
    const named = /`([^`]+)`/.exec(String(status.message ?? ""))?.[1];
    expect(named, JSON.stringify(status)).toBeString();
    const look = lead.agent.host.bash(named!);
    expect(look.status, look.stdout + look.stderr).toBe(0);
    expect(look.stdout).toMatch(/^- reporting, data: billing merged\b.*, not recorded yet: the next step here records it$/m);
    expect(unitsMerged(home.dir)).not.toContain("reporting");

    // Every Unit is in: the home records the last one, runs Build and Test, and the work ends done.
    const last = lead.agent.next();
    expect(unitsMerged(home.dir)).toEqual(PLAN.map((p) => p.unit).sort());
    expect(claimPayload(home.remote, id8, "reporting")).toMatchObject({ done: true });
    expect(last.kind, JSON.stringify(last)).toBe("run-stage");
    expect(last.stage).toBe("build-and-test");
    const end = lead.agent.drive(last);
    expect(end.stage, JSON.stringify(end)).not.toBe("build-and-test");
    expect(lead.agent.asked.some((a) => a.what === "approval" && a.stage === "build-and-test")).toBe(true);
    expect(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", "fixture-8000000000000001", "aidlc-state.md"), "utf-8"))
      .toMatch(/^- \[x\] build-and-test /m);
    // Every team built under its own approvals, never the home's.
    for (const team of teams.values()) expect(team.agent.asked.some((a) => a.what === "plan approval")).toBe(true);
  });
});

describe("the lead's project builds a Unit of its own while a team's Unit merges", () => {
  test("the lead's next step records the merge the team's repo made, though the lead's chat read the claims before the team took it", () => {
    const hosts: Record<string, string> = { "checkout-web": codeHost("checkout-web"), billing: codeHost("billing") };
    const team: Plan = { unit: "refund-button", team: "storefront", tool: "copilot", person: "sam", repos: [{ repo: "checkout-web", merge: "merge" }] };
    const here: Plan = { unit: "weekly-report", team: "here", tool: "claude", person: "lead", repos: [{ repo: "billing", merge: "squash" }] };
    // The lead names a team for refund-button only, so weekly-report is built here.
    const { home, id8 } = leadsProject(hosts, [team, here], ["refund-button=storefront"]);
    // The lead's chat starts on the Unit built here, reading the claims once.
    const lead = homeStandIn(home);
    lead.person.say("/aidlc");
    const first = lead.agent.next();
    expect(first, JSON.stringify(first).slice(0, 400)).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    // Meanwhile the storefront team takes, builds and pushes its Unit, and its repo merges it by a merge commit.
    const sam = teamClone(home, hosts, team);
    const { pushed } = takeBuildPush(sam);
    expectResult(home.remote, id8, team, pushed);
    mergeOnHost(hosts["checkout-web"], "refund-button", "merge");
    // x2783-s9 16: the lead carries on in the same chat; the step went on to the
    // Unit built here and recorded nothing, while the board said it would.
    const step = goOn(lead, lead.agent.personTypes("/aidlc carry on"));
    expect(step, JSON.stringify(step).slice(0, 400)).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(unitsMerged(home.dir)).toEqual(["refund-button"]);
    expect(claimPayload(home.remote, id8, "refund-button")).toMatchObject({ done: true });
  });
});

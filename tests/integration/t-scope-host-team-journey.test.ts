// covers: subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, subcommand:aidlc-unit:release, subcommand:aidlc-unit:assign, function:checkTeamResults, function:unitMergeVerdict, function:localRepoOverrideLines
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
// own: the lead's project building a Unit while a team's Unit merges, a team's
// next Unit asked for in the chat of its pushed build, a take of another team's
// Unit and its way back, and the lead's re-hold of a Unit.

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
  ORCH,
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

// A Unit the lead holds for a team that nobody has taken, and not by file.
function heldNotTaken(claim: Record<string, unknown> | null, team: string): void {
  expect(claim).toMatchObject({ status: "claimed", owner: team });
  expect(claim?.taken_by, JSON.stringify(claim)).toBeUndefined();
  expect(claim?.by_file, JSON.stringify(claim)).toBeUndefined();
}

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
    pick(wendy, wendyOffer, startChoice(wendyOffer, "checkout-ui").label);
    // The build's own next step asks to clone it, so the offer reaches her
    // whatever the agent did with the take's output.
    const cloneAsk = wendy.agent.next();
    expect(cloneAsk.ask_type, JSON.stringify(cloneAsk)).toBe("unit-clone");
    expect((cloneAsk.choices as Array<{ label: string }>).map((c) => c.label)).toEqual(["Clone checkout-web", "Not now"]);
    choose(wendy, String(cloneAsk.question), cloneAsk.choices as Array<{ label: string; command?: string }>, "Clone checkout-web");
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

describe("a team's pushed build, asked for the team's next Unit", () => {
  test("on Copilot CLI, in the same chat, once its first Unit is merged the team is offered the Unit that opened", () => {
    const hosts: Record<string, string> = { "checkout-api": codeHost("checkout-api") };
    const receipts = plan("receipts");
    const statements: Plan = { ...receipts, unit: "statements", dependsOn: "receipts" };
    const { home, id8 } = leadsProject(hosts, [receipts, statements], ["receipts=finance", "statements=finance"]);
    const frank = teamClone(home, hosts, receipts);
    frank.person.say("/aidlc");
    const built = takeAndBuild(frank, frank.agent.next());
    expectResult(home.remote, id8, receipts, pick(frank, built.end, "Push"));
    mergeOnHost(hosts["checkout-api"], "receipts", "rebase");
    const lead = homeStandIn(home);
    lead.person.say("/aidlc");
    lead.agent.next();
    expect(claimPayload(home.remote, id8, "receipts")).toMatchObject({ done: true });
    // x2783-s9 14: in the chat of his pushed build he asks for more, and met the finished work's doors and new work.
    const more = frank.agent.personTypes("/aidlc Anything else for the finance team?");
    expect(more.ask_type, JSON.stringify(more).slice(0, 800)).toBe("unit-take");
    expect(pick(frank, more, startChoice(more, "statements").label)).toMatchObject({ taken: true, unit: "statements", team: "finance" });
  });
});

// refunds held for payments and checkout-ui for web.
const TWO_TEAMS: Plan[] = [
  { unit: "refunds", team: "payments", tool: "copilot", person: "alice", repos: [{ repo: "checkout-api", merge: "squash" }] },
  { unit: "checkout-ui", team: "web", tool: "copilot", person: "sam", repos: [{ repo: "checkout-web", merge: "squash" }] },
];

describe("a teammate on Copilot CLI and the Units the lead held for teams", () => {
  test("asking to take another team's Unit leaves it with that team, and a take is given back to the team it was held for", () => {
    const hosts: Record<string, string> = { "checkout-api": codeHost("checkout-api"), "checkout-web": codeHost("checkout-web") };
    const { home, id8 } = leadsProject(hosts, TWO_TEAMS, TWO_TEAMS.map((p) => `${p.unit}=${p.team}`));
    const sam = teamClone(home, hosts, TWO_TEAMS[1]);
    // x2783-s9 5: his words name the payments team's Unit, and the agent takes it for his own team.
    const offer = sam.agent.personTypes("/aidlc We are the web team. Can we take refunds instead?");
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    const asked = sam.agent.host.bash(`${startChoice(offer, "refunds").command.replace(/ --team (?:'[^']*'|\S+)/, "")} --team web`);
    heldNotTaken(claimPayload(home.remote, id8, "refunds"), "payments");
    expect(asked.stdout + asked.stderr).toContain("payments");
    // x2783-s9 6: he takes his team's own Unit, then asks to give it back; the lead's hold for web comes back.
    const mine = startChoice(offer, "checkout-ui");
    sam.person.pick(String(offer.question), [mine.label], mine.label);
    const took = sam.agent.host.bash(mine.command);
    expect(took.status, took.stdout + took.stderr).toBe(0);
    expect(claimPayload(home.remote, id8, "checkout-ui")).toMatchObject({ owner: "web", taken_by: "sam" });
    sam.person.say("give it back, it is not ours to build after all");
    const back = sam.agent.host.bash(`bun ${sam.agent.host.dir}/tools/aidlc-unit.ts release checkout-ui`);
    expect(back.status, back.stdout + back.stderr).toBe(0);
    heldNotTaken(claimPayload(home.remote, id8, "checkout-ui"), "web");
  });
});

describe("the lead holds a Unit for a team again", () => {
  test("a re-hold after a release is a hold, assign makes a hand-off by file a hold again, and the approvals question is answered once", () => {
    const hosts: Record<string, string> = { "checkout-api": codeHost("checkout-api"), "checkout-web": codeHost("checkout-web") };
    const { home, id8, assigned } = leadsProject(hosts, TWO_TEAMS, TWO_TEAMS.map((p) => `${p.unit}=${p.team}`));
    const lead = homeStandIn(home);
    const unitTool = `bun ${lead.agent.host.dir}/tools/aidlc-unit.ts`;
    // The first assign asked how often the teams approve; the lead keeps the recommended answer.
    const rhythm = (assigned.offer as { choices?: Array<{ label: string; command?: string }> } | undefined)?.choices ?? [];
    const keep = rhythm.find((c) => c.label === "Keep approvals after every stage");
    expect(keep, JSON.stringify(assigned)).toBeDefined();
    lead.person.pick(String(assigned.notice), rhythm.map((c) => c.label), keep!.label);
    if (keep!.command !== undefined) expect(lead.agent.host.bash(keep!.command).status).toBe(0);
    lead.person.say("/aidlc");
    const board = lead.agent.next();
    expect(board.kind, JSON.stringify(board).slice(0, 400)).toBe("print");
    // x2783-s9 3: the lead freed refunds, then said to hold it for payments again;
    // the board's note gave the agent only the hand-off by file, which it ran.
    lead.person.say("free refunds for now");
    const freed = lead.agent.host.bash(`${unitTool} release refunds`);
    expect(freed.status, freed.stdout + freed.stderr).toBe(0);
    expect(String(board.board_note)).toMatch(/`[^`]*\bassign <unit>=<team>[^`]*`/);
    const again = "No, the payments team builds it. Hold it for them again.";
    lead.person.say(again);
    const held = lead.agent.host.bash(`${unitTool} assign refunds=payments --person-words '${again}'`);
    expect(held.status, held.stdout + held.stderr).toBe(0);
    heldNotTaken(claimPayload(home.remote, id8, "refunds"), "payments");
    // x2783-s9 4: the approvals question was answered at the first assign and is not asked again.
    expect((JSON.parse(held.stdout.trim().split("\n").at(-1) ?? "{}") as { offer?: unknown }).offer).toBeUndefined();
    // x2783-s9 12: a hand-off by file the lead asked for, then "no file": assign makes it a hold again.
    lead.person.say("hand checkout-ui to web by file");
    const file = lead.agent.host.bash(`${unitTool} hand-off checkout-ui --team web --person-words 'hand checkout-ui to web by file'`);
    expect(file.status, file.stdout + file.stderr).toBe(0);
    expect(claimPayload(home.remote, id8, "checkout-ui")).toMatchObject({ by_file: true });
    lead.person.say("no file, the web team works in this workspace");
    const hold = lead.agent.host.bash(`${unitTool} assign checkout-ui=web --person-words 'no file, the web team works in this workspace'`);
    expect(hold.status, hold.stdout + hold.stderr).toBe(0);
    heldNotTaken(claimPayload(home.remote, id8, "checkout-ui"), "web");
    expect(run(ORCH, ["team-board"], home.dir).out).toContain("- checkout-ui, web: held for web, not taken yet");
  });
});

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
  { unit: "refunds", team: "payments", tool: "kiro", person: "alice", repos: [{ repo: "checkout-api", merge: "squash" }, { repo: "billing", merge: "merge" }] },
  { unit: "checkout-ui", team: "web", tool: "codex", person: "wendy", repos: [{ repo: "checkout-web", merge: "rebase" }] },
  { unit: "receipts", team: "finance", tool: "copilot", person: "frank", repos: [{ repo: "checkout-api", merge: "rebase" }] },
  { unit: "search", team: "discovery", tool: "opencode", person: "dora", repos: [{ repo: "checkout-web", merge: "squash" }] },
  { unit: "alerts", team: "ops", tool: "kiro-ide", person: "omar", repos: [{ repo: "billing", merge: "squash" }] },
  { unit: "ledger", team: "platform", tool: "claude", person: "pat", repos: [{ repo: "checkout-api", merge: "merge" }] },
  { unit: "reporting", team: "data", tool: "cursor", person: "dana", repos: [{ repo: "billing", merge: "rebase" }], dependsOn: "refunds" },
];

const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n" +
  PLAN.map((p) => `  - name: ${p.unit}\n    kind: service\n    repos: [${p.repos.map((r) => r.repo).join(", ")}]\n    depends_on: [${p.dependsOn ?? ""}]\n`).join("") +
  "```\n";

const UNIT_ASKS = new Set(["unit-take", "unit-push", "unit-assignment", "unit-amend", "unit-signoff", "unit-handoff"]);

interface Team {
  plan: Plan;
  dir: string;
  agent: AgentStandIn;
  person: PersonScript;
}

// A teammate's clone of the workspace with their own tool's tree laid in beside
// its files, and their clones of the Unit's repos: under the workspace, or, with
// `elsewhere`, in a folder of their own that their repos.local.json names.
function teamClone(home: Home, hosts: Record<string, string>, plan: Plan, elsewhere = false): Team {
  const dir = cloneOf(home.remote, plan.person);
  cpSync(join(REPO_ROOT, "dist", plan.tool), dir, { recursive: true, force: false, errorOnExist: false });
  const folders = new Map<string, string>();
  const own = elsewhere ? tempDir(`${plan.person}-src`) : null;
  for (const { repo } of plan.repos) {
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

// A team's whole turn: offered its Unit at `/aidlc`, takes it, builds it to the
// push question, and pushes.
function takeBuildPush(team: Team): { took: Record<string, unknown>; pushed: Record<string, unknown> } {
  team.person.say("/aidlc");
  const offer = team.agent.next();
  expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
  const took = pick(team, offer, `Start ${team.plan.unit}`);
  const end = team.agent.drive(team.agent.next());
  expect(end.ask_type, JSON.stringify(end)).toBe("unit-push");
  const pushed = pick(team, end, "Push");
  return { took, pushed };
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

describe("one piece of work, a team on every tool", () => {
  test("each team takes, builds and pushes its Unit; the repos merge their own way; the home records every Unit done and runs Build and Test", () => {
    const hosts: Record<string, string> = { "checkout-api": codeHost("checkout-api"), "checkout-web": codeHost("checkout-web"), billing: codeHost("billing") };
    const state = homeState().replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
    const home = makeHome({ repos: hosts, dependencies: DEPENDENCIES, state });
    cpSync(join(REPO_ROOT, "dist", "claude"), home.dir, { recursive: true, force: false, errorOnExist: false });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const assigned = run(UNIT, ["assign", ...PLAN.map((p) => `${p.unit}=${p.team}`)], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const id8 = fixtureIntentId8(home.dir);

    // Every team but data builds at once; data's Unit waits on refunds.
    const teams = new Map<string, Team>();
    for (const plan of PLAN.filter((p) => p.dependsOn === undefined)) {
      const team = teamClone(home, hosts, plan, plan.unit === "refunds");
      teams.set(plan.unit, team);
      const { took, pushed } = takeBuildPush(team);
      expect(took).toMatchObject({ taken: true, unit: plan.unit, team: plan.team, space: plan.team });
      expect(pushed).toMatchObject({ pushed: true, unit: plan.unit, repos: plan.repos.map((r) => r.repo) });
      const result = claimPayload(home.remote, id8, plan.unit)?.result as { by: string; repos: Array<{ repo: string; paths: Record<string, string> }> };
      expect(result.by).toBe(plan.person);
      for (const repo of result.repos) expect(Object.keys(repo.paths).sort()).toEqual([`src/${plan.unit}.ts`, `test/${plan.unit}.test.ts`]);
    }
    // The payments team's repos live outside its workspace, where its own
    // repos.local.json says; the branch is pushed from there.
    const payments = teams.get("refunds")!;
    expect(existsSync(join(payments.dir, "checkout-api"))).toBe(false);
    expect(git(hosts.billing, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n")).toContain("src/refunds.ts");

    // The home sees what came back before anything merged, with no fetch by the lead.
    const lead = homeStandIn(home);
    lead.person.say("/aidlc");
    const board = lead.agent.next();
    expect(board.kind, JSON.stringify(board)).toBe("notice");
    expect(String(board.message)).toContain("- refunds, payments: checkout-api not merged yet, billing not merged yet (0 of 2 merged)");
    expect(String(board.message)).toContain("- reporting, data: held for data, not taken yet");

    // Each repo merges its own way.
    for (const plan of PLAN.filter((p) => p.dependsOn === undefined)) {
      for (const { repo, merge } of plan.repos) mergeOnHost(hosts[repo], plan.unit, merge);
    }
    const seen = lead.agent.next();
    const done = readAuditShardEvents(home.dir).filter((row) => row.event === "UNIT_MERGED").map((row) => /\*\*Unit\*\*: (\S+)/.exec(row.block)?.[1]);
    expect(done.sort(), JSON.stringify(seen)).toEqual(PLAN.filter((p) => p.dependsOn === undefined).map((p) => p.unit).sort());
    for (const plan of PLAN.filter((p) => p.dependsOn === undefined)) {
      expect(claimPayload(home.remote, id8, plan.unit), plan.unit).toMatchObject({ done: true });
    }
    expect(String(seen.message)).toContain("- refunds, payments: done");

    // refunds is done, so reporting opens for data, who builds it on Cursor.
    const data = teamClone(home, hosts, PLAN.find((p) => p.unit === "reporting")!);
    const { pushed } = takeBuildPush(data);
    expect(pushed).toMatchObject({ pushed: true, unit: "reporting", repos: ["billing"] });
    mergeOnHost(hosts.billing, "reporting", "rebase");

    // Every Unit is in: the home runs Build and Test, and the work ends done.
    const last = lead.agent.next();
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

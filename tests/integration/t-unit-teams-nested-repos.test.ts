// covers: function:walkWorkspaceSource, subcommand:aidlc-unit:take, subcommand:aidlc-unit:push, function:checkTeamResults
//
// The packages inside the workspace's own repo (#2410, item 1): the home
// workspace repo records src/pkg-a and src/pkg-b as gitlinks, with no
// .gitmodules, and repos.json maps the workspace as "." and each package by
// its path and address. A teammate's clone gets the two folders empty and the
// sync tool clones each package into its own; the teammate takes refunds and
// the agent stand-in builds it through every stage under Guard Policy strict,
// which the home's rules lock (the code plan approved by the person, the Unit
// reviewed, its gate), writing in both packages. The Unit's record names each
// write by its package, the listing holds each file once, the push goes to
// both packages and never to the workspace's own repo, the board counts the
// two merges, and the home records refunds done.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSourceListing } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, fixtureIntentId8, REPO_ROOT } from "../harness/fixtures.ts";
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
  homeState,
  makeHome,
  mergeOnHost,
  next,
  run,
  STATE,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(20 * 60_000);
afterAll(cleanupTeamBuild);

const SYNC = join(AIDLC_SRC, "tools", "aidlc-workspace-sync.ts");
const UNIT_ASKS = new Set(["unit-take", "unit-push", "unit-assignment", "unit-amend", "unit-signoff", "unit-handoff"]);
const DEPENDENCIES = "# Unit dependencies\n\n```yaml\nunits:\n" +
  "  - name: refunds\n    kind: service\n    repos: [pkg-a, pkg-b]\n    depends_on: []\n" +
  "  - name: checkout-ui\n    kind: ui\n    repos: [pkg-b]\n    depends_on: []\n" +
  "```\n";

// The person picks a choice of a Unit question, and the agent runs its command.
function pick(agent: AgentStandIn, person: PersonScript, d: Directive, label: string): Record<string, unknown> {
  const choices = (d.choices as Array<{ label: string; command?: string }> | undefined) ?? [];
  const choice = choices.find((c) => c.label === label);
  expect(choice?.command, `${label} in ${JSON.stringify(d)}`).toBeString();
  person.pick(String(d.question), choices.map((c) => c.label), label);
  const ran = agent.host.bash(choice!.command!);
  expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("the packages inside the workspace's own repo, as gitlinks", () => {
  test("a teammate's clone fills the empty package folders; refunds is built, reviewed and pushed once in each package; the home sees both merge", () => {
    const hosts = { "pkg-a": codeHost("pkg-a"), "pkg-b": codeHost("pkg-b") };
    const state = homeState()
      .replace(/^- \[ \] (nfr-requirements|nfr-design|infrastructure-design) (\S+) EXECUTE$/gm, "- [ ] $1 $2 SKIP");
    const home = makeHome({ dependencies: DEPENDENCIES, state });
    // The rules every space here starts from hold strict, so the team's build runs under it.
    const rules = join(home.dir, "aidlc", "spaces", "default", "memory", "org.md");
    writeFileSync(rules, readFileSync(rules, "utf-8").replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n"));
    mkdirSync(join(home.dir, "src"), { recursive: true });
    for (const [name, host] of Object.entries(hosts)) cloneCode(host, join(home.dir, "src"), name);
    writeFileSync(join(home.dir, "README.md"), "# shop\n");
    mkdirSync(join(home.dir, "docs"), { recursive: true });
    writeFileSync(join(home.dir, "docs", "guide.md"), "The shop's own guide.\n");
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify({
      repos: [
        { name: "shop", url: "", path: "." },
        ...Object.entries(hosts).map(([name, url]) => ({ name, url, path: `src/${name}` })),
      ],
    }, null, 2)}\n`);
    const registryPath = join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = ["pkg-a", "pkg-b", "shop"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "the shop records its packages"]);
    // Each package is a gitlink in the workspace's repo, and nothing names it a submodule.
    expect(git(home.dir, ["ls-files", "-s", "src"]).split("\n").map((line) => `${line.split(" ")[0]} ${line.split("\t")[1]}`))
      .toEqual(["160000 src/pkg-a", "160000 src/pkg-b"]);
    expect(existsSync(join(home.dir, ".gitmodules"))).toBe(false);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    const assigned = run(UNIT, ["assign", "refunds=payments", "checkout-ui=web"], home.dir);
    expect(assigned.status, assigned.out).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams chosen"]);
    git(home.dir, ["push", "-q", "origin", "main"]);

    // A payments developer's clone: the package folders come empty, and the sync fills each from its address.
    const alice = cloneOf(home.remote, "alice");
    expect(readdirSync(join(alice, "src", "pkg-a"))).toEqual([]);
    const synced = spawnSync(process.execPath, [SYNC, "--project-dir", alice], { cwd: alice, encoding: "utf-8", env: GIT_ENV });
    expect(synced.status, `${synced.stdout}${synced.stderr}`).toBe(0);
    for (const name of Object.keys(hosts)) {
      const dir = join(alice, "src", name);
      expect(existsSync(join(dir, "README.md")), name).toBe(true);
      git(dir, ["config", "user.name", "alice"]);
      git(dir, ["config", "user.email", "alice@example.test"]);
    }
    expect(git(alice, ["status", "--porcelain", "--", "src"])).toBe("");

    cpSync(join(REPO_ROOT, "dist", "claude"), alice, { recursive: true, force: false, errorOnExist: false });
    const host = hostFor("claude", alice, GIT_ENV);
    const person = new PersonScript(host);
    const agent = new AgentStandIn(host, person, {
      units: ["refunds"],
      codeRepo: () => Object.keys(hosts).map((repo) => ({ repo, folder: `src/${repo}` })),
      until: (d: Directive) => d.kind === "ask" && UNIT_ASKS.has(String(d.ask_type)),
    });
    host.sessionStart("startup");
    person.say("/aidlc");
    const offer = agent.next();
    expect(offer.ask_type, JSON.stringify(offer)).toBe("unit-take");
    const took = pick(agent, person, offer, "Start refunds");
    expect(took).toMatchObject({ taken: true, unit: "refunds", team: "payments", space: "payments" });
    const end = agent.drive(agent.next());
    expect(end.ask_type, JSON.stringify(end)).toBe("unit-push");
    expect(agent.asked.some((a) => a.what === "plan approval")).toBe(true);
    expect(agent.notices.filter((line) => line.includes("outside any unit"))).toEqual([]);

    // The Unit's record names each write by its package, and each file is listed once.
    const intents = join(alice, "aidlc", "spaces", "payments", "intents");
    const build = readdirSync(intents).find((name) => name.endsWith("-refunds"));
    expect(build, readdirSync(intents).join(", ")).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(intents, build!, "construction", "refunds", "code-generation", "source-manifest.json"), "utf-8")) as {
      writes: Array<{ repo?: string; path: string }>;
    };
    expect(manifest.writes.map((w) => `${w.repo}/${w.path}`).sort())
      .toEqual(["pkg-a/src/refunds.ts", "pkg-a/test/refunds.test.ts", "pkg-b/src/refunds.ts", "pkg-b/test/refunds.test.ts"]);
    const listed = [...(workspaceSourceListing(alice, build, "payments")?.keys() ?? [])].map((key) => key.replace("\0", "|"));
    expect(listed.filter((key) => key.endsWith("refunds.ts")).sort()).toEqual(["pkg-a|src/refunds.ts", "pkg-b|src/refunds.ts"]);
    expect(listed.some((key) => key.includes("|src/pkg-"))).toBe(false);

    const pushed = pick(agent, person, end, "Push");
    expect(pushed).toMatchObject({ pushed: true, unit: "refunds", repos: ["pkg-a", "pkg-b"] });
    for (const bare of Object.values(hosts)) {
      expect(git(bare, ["ls-tree", "-r", "--name-only", "refunds"]).split("\n").sort()).toEqual(["README.md", "src/refunds.ts", "test/refunds.test.ts"]);
    }
    expect(git(home.remote, ["branch", "--list", "refunds"])).toBe("");

    git(home.dir, ["fetch", "-q", "origin"]);
    expect(String(next(home.dir).narration)).toContain("- refunds, payments: pkg-a not merged yet, pkg-b not merged yet (0 of 2 merged)");
    mergeOnHost(hosts["pkg-a"], "refunds", "squash");
    mergeOnHost(hosts["pkg-b"], "refunds", "merge");
    git(home.dir, ["fetch", "-q", "origin"]);
    next(home.dir);
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")).toMatchObject({ done: true });
  });
});

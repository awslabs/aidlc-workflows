// covers: subcommand:aidlc-unit:share, function:planFilesNow, function:writePlan, function:planRecordRef
//
// The lead shares the plan with the teams as a ref of AI-DLC's own in one code
// repository: one commit of plan.json, the approved inputs and the lead's
// rules, with no history but its own, pushed with a lease from the lead's
// workspace by the code repository's address. The lead's workspace needs no
// remote of its own, no branch or commit is made there, and nothing of
// AI-DLC's is added to a code clone. A later share goes on the plan's tip and
// keeps every word already on it.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { gitTargetFor, planAtCopy, planFilesNow, planPlaceForShare, planUnitsKept, writePlan } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { checkInLine, planJsonOf, repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { seededRecordDir } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeHost,
  DEPENDENCIES,
  ENV,
  git,
  HOME_RECORD,
  makeHome,
  makePlanHome,
  next,
  planRefOf,
  run,
  STATE,
  tempDir,
  TICKET_RULE_WORDS,
  ticketKeyRule,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const registryOf = (dir: string): Array<{ uuid: string; slug: string }> =>
  JSON.parse(readFileSync(join(dir, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8"));

interface Plan {
  version: number;
  work: { id: string; label: string; space: string };
  units: Array<{ name: string; waits_on: string[]; repos: string[]; record: string; word: Record<string, unknown> }>;
  inputs: Array<{ path: string; fingerprint: string }>;
  [key: string]: unknown;
}

const planAt = (host: string, ref: string): Plan => JSON.parse(git(host, ["show", `${ref}:plan.json`]));

const share = (dir: string) => {
  const shared = run(UNIT, ["share", "--plan"], dir);
  expect(shared.status, shared.out).toBe(0);
  return shared;
};

// A commit on the plan's tip made with plain git, as another writer of the
// plan would make it: `edit` changes its plan.json.
function writeOnTip(host: string, id8: string, edit: (plan: Plan) => void): string {
  const scratch = tempDir("plan-writer");
  git(scratch, ["init", "-q"]);
  git(scratch, ["config", "user.name", "lead"]);
  git(scratch, ["config", "user.email", "lead@example.test"]);
  git(scratch, ["fetch", "-q", host, `${planRefOf(id8)}:refs/tip`]);
  git(scratch, ["read-tree", "refs/tip"]);
  const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"]));
  edit(plan);
  const blob = spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`);
  git(scratch, ["update-index", "--cacheinfo", `100644,${blob},plan.json`]);
  const tree = git(scratch, ["write-tree"]);
  const commit = git(scratch, ["commit-tree", tree, "-p", "refs/tip", "-m", `aidlc plan word ${plan.version}`]);
  git(scratch, ["push", "-q", host, `${commit}:${planRefOf(id8)}`]);
  return commit;
}

function spawnHash(dir: string, text: string): string {
  const file = join(dir, "blob.txt");
  writeFileSync(file, text);
  return git(dir, ["hash-object", "-w", file]);
}

describe("the plan is shared as a ref of its own in the work's first code repository", () => {
  test("one commit with no parent, holding only plan.json, the approved inputs and the lead's rules, by the lead's own git", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const ref = planRefOf(home.id8);
    expect(git(host, ["rev-parse", ref])).toBe(String(home.plan));
    expect(git(host, ["rev-list", "--parents", "-n", "1", ref])).toBe(String(home.plan));
    expect(git(host, ["log", "-1", "--format=%s", ref])).toBe(`aidlc plan ${registryOf(home.dir)[0].slug} 1: shared`);
    expect(git(host, ["log", "-1", "--format=%an <%ae>", ref])).toBe("lead <lead@example.test>");
    const paths = git(host, ["ls-tree", "-r", "--name-only", ref]).split("\n");
    expect(paths).toContain("plan.json");
    expect(paths).toContain("inputs/inception/units-generation/unit-of-work-dependency.md");
    expect(paths.every((path) => path === "plan.json" || path.startsWith("inputs/") || /^rules\/(team|project)\.md$/.test(path))).toBe(true);
    // The other repositories, and the code's own branches, have nothing of it.
    for (const other of [home.hosts.billing, home.hosts["checkout-web"]]) expect(git(other, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(host, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/main");
  });

  test("plan.json is the index of what a team's build reads, field by field", () => {
    const home = makePlanHome();
    const plan = planAt(home.hosts["checkout-api"], planRefOf(home.id8));
    const row = registryOf(home.dir)[0];
    expect(Object.keys(plan)).toEqual([
      "format", "version", "work", "plan_repo", "repos", "units", "skeleton", "settings", "stages", "unit_stages", "inputs",
    ]);
    expect(plan.format).toBe(1);
    expect(plan.version).toBe(1);
    expect(plan.work).toEqual({ id: row.uuid, label: row.slug, space: "default" });
    expect(plan.plan_repo).toEqual({ name: "checkout-api", address: home.hosts["checkout-api"] });
    expect(plan.repos).toEqual(Object.entries(home.hosts).map(([name, address]) => ({ name, address, branch: "main" })));
    expect(plan.units).toEqual([
      { name: "refunds", waits_on: [], repos: ["checkout-api", "billing"], record: "checkout-api", word: {} },
      { name: "checkout-ui", waits_on: [], repos: ["checkout-web"], record: "checkout-web", word: {} },
      { name: "reporting", waits_on: ["refunds"], repos: ["billing"], record: "billing", word: {} },
    ]);
    expect(plan.skeleton).toBeNull();
    expect(plan.settings).toMatchObject({
      Scope: "feature", Depth: "Standard", "Test Strategy": "Standard", "Project Type": "Greenfield", "Unit Gate Rhythm": "per-stage",
    });
    expect(plan.stages).toMatchObject({ "requirements-analysis": "completed", "units-generation": "completed", "functional-design": "in-progress" });
    expect(plan.unit_stages).toContain("functional-design");
    expect(plan.unit_stages).toContain("code-generation");
    const dependency = plan.inputs.find((input) => input.path === "inception/units-generation/unit-of-work-dependency.md");
    expect(dependency?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Each input listed is the lead's own file, at the path the lead's record holds it.
    for (const input of plan.inputs) {
      expect(git(home.hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:inputs/${input.path}`]))
        .toBe(readFileSync(join(seededRecordDir(home.dir), ...input.path.split("/")), "utf-8").trim());
    }
  });

  test("an address carries no sign-in, and a repository the lead has no clone of is named by its url", () => {
    const home = makePlanHome({ share: false });
    const repos = JSON.parse(readFileSync(join(home.dir, "repos.json"), "utf-8"));
    repos.repos.push({ name: "ledger", url: "https://lead:tok3n@example.test/acme/ledger.git" });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify(repos, null, 2)}\n`);
    const registryPath = join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry[0].repos = [...registry[0].repos, "ledger"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    share(home.dir);
    const plan = planAt(home.hosts["checkout-api"], planRefOf(home.id8));
    expect((plan.repos as unknown[]).at(-1)).toEqual({ name: "ledger", address: "https://example.test/acme/ledger.git", branch: null });
    expect(JSON.stringify(plan)).not.toContain("tok3n");
  });

  test("a Unit's record goes where it can be written: the first of its repositories with an address, else the plan's own", () => {
    const home = makePlanHome({ share: false, repos: { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") } });
    share(home.dir);
    const host = home.hosts["checkout-api"];
    const plan = planAt(host, planRefOf(home.id8));
    // checkout-ui names checkout-web, which the work does not list and the lead has no address for.
    expect((plan.repos as unknown[]).at(-1)).toEqual({ name: "checkout-web", address: null, branch: null });
    expect(plan.units.find((unit) => unit.name === "checkout-ui")).toMatchObject({ repos: ["checkout-web"], record: "checkout-api" });
    // Once repos.json gives it an address, its record goes there.
    const repos = JSON.parse(readFileSync(join(home.dir, "repos.json"), "utf-8"));
    repos.repos.push({ name: "checkout-web", url: "https://example.test/acme/checkout-web.git" });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify(repos, null, 2)}\n`);
    share(home.dir);
    const again = planAt(host, planRefOf(home.id8));
    expect(again.units.find((unit) => unit.name === "checkout-ui")).toMatchObject({ record: "checkout-web" });
  });

  test("a sign-in in a clone's address goes on no command AI-DLC runs: the address goes without it, and the person's own by a setting of that command", () => {
    const home = makePlanHome({ share: false });
    const signed = "https://lead:tok3n@127.0.0.1:9/acme/checkout-api.git";
    const plain = "https://127.0.0.1:9/acme/checkout-api.git";
    git(join(home.dir, "checkout-api"), ["remote", "set-url", "origin", signed]);
    const trace = join(tempDir("trace"), "git.jsonl");
    run(UNIT, ["share", "--plan"], home.dir, { ...ENV, GIT_TRACE2_EVENT: trace });
    const argv = readFileSync(trace, "utf-8").split("\n").filter((line) => line.includes('"event":"start"'))
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(" "));
    // git's own remote helper is handed the rewritten address, as it is for any
    // push from that clone; no command AI-DLC runs carries the sign-in.
    const helper = (line: string): boolean => /(^|\/)git[ -]remote-https? /.test(line);
    expect(argv.filter((line) => line.includes("tok3n") && !helper(line))).toEqual([]);
    expect(argv.some((line) => helper(line) && line.includes(signed))).toBe(true);
    expect(argv.some((line) => line.includes(` push ${plain} `))).toBe(true);
    const via = gitTargetFor(home.dir, plain, "push");
    expect(via.target).toBe(plain);
    const at = Object.entries(via.env).find(([, value]) => value === `url.${signed}.insteadOf`)?.[0].replace("KEY", "VALUE");
    expect(at === undefined ? undefined : via.env[at]).toBe(plain);
  });

  test("the lead's files go in as git keeps text: CRLF read as LF, and plan.json as two-space JSON with a last newline", () => {
    const home = makePlanHome({ share: false });
    const requirements = join(seededRecordDir(home.dir), "inception", "requirements-analysis", "requirements.md");
    writeFileSync(requirements, "# Requirements\r\n\r\nFR1 refunds.\r\n");
    share(home.dir);
    const host = home.hosts["checkout-api"];
    const ref = planRefOf(home.id8);
    expect(git(host, ["cat-file", "blob", `${ref}:inputs/inception/requirements-analysis/requirements.md`]))
      .toBe("# Requirements\n\nFR1 refunds.");
    const text = spawnShow(host, `${ref}:plan.json`);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });
});

function spawnShow(dir: string, spec: string): string {
  const result = Bun.spawnSync({ cmd: ["git", "cat-file", "blob", spec], cwd: dir, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout);
}

describe("nothing else moves", () => {
  test("no commit, branch or file of the lead's changes; no code clone gains a ref, a remote or a setting; a plain clone does not bring the plan", () => {
    const home = makePlanHome({ share: false });
    const clones = Object.keys(home.hosts).map((name) => join(home.dir, name));
    const look = (dir: string) => ({
      head: git(dir, ["rev-parse", "HEAD"]),
      branches: git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"]),
      status: git(dir, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((line) => !line.includes("aidlc/.aidlc-engine/")).join("\n"),
      remotes: git(dir, ["remote", "-v"]),
      config: git(dir, ["config", "--local", "--list"]),
      aidlc: dir === home.dir ? "" : git(dir, ["for-each-ref", "refs/aidlc"]),
    });
    const before = [home.dir, ...clones].map(look);
    share(home.dir);
    expect([home.dir, ...clones].map(look)).toEqual(before);
    // The lead's workspace keeps its copy of what it pushed, in its own repository only.
    const copies = git(home.dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/aidlc"]).split("\n");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(new RegExp(`^refs/aidlc/home/${home.id8}/[0-9a-f]{12}/plan `));
    expect(copies[0].split(" ")[1]).toBe(git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]));
    const plain = join(tempDir("plain"), "checkout-api");
    git(home.dir, ["clone", "-q", home.hosts["checkout-api"], plain]);
    expect(git(plain, ["for-each-ref", "refs/aidlc"])).toBe("");
  });

  test("a copy of the plan read from any repository but the one it names is no plan, however new", () => {
    const home = makePlanHome();
    const kept = git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc"]);
    // The same plan with one more Unit, as a mirror or a fork could hold it, read into another repository's folder.
    git(home.dir, ["read-tree", "--index-output=.git/plan-copy-index", kept]);
    const plan = JSON.parse(git(home.dir, ["show", `${kept}:plan.json`]));
    plan.units.push({ name: "ghost", waits_on: [], repos: [], record: "checkout-api", word: { done: true } });
    const blob = spawnHash(home.dir, `${JSON.stringify(plan, null, 2)}\n`);
    const index = { ...process.env, GIT_INDEX_FILE: join(home.dir, ".git", "plan-copy-index") };
    spawnSync("git", ["update-index", "--cacheinfo", `100644,${blob},plan.json`], { cwd: home.dir, env: index });
    const tree = spawnSync("git", ["write-tree"], { cwd: home.dir, env: index, encoding: "utf-8" }).stdout.trim();
    const later = { ...process.env, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2099-01-01T00:00:00Z" };
    const commit = spawnSync("git", ["commit-tree", tree, "-p", kept, "-m", "a copy"], { cwd: home.dir, env: later, encoding: "utf-8" }).stdout.trim();
    const elsewhere = `refs/aidlc/home/${home.id8}/aaaaaaaaaaaa/plan`;
    git(home.dir, ["update-ref", elsewhere, commit]);
    expect(planAtCopy(home.dir, elsewhere)).toBeNull();
    expect(planAtCopy(home.dir, kept)?.commit).toBe(String(home.plan));
    expect(planUnitsKept(home.dir)).toEqual(["refunds", "checkout-ui", "reporting"]);
  });

  test("a copy read at an address the person named is the plan, however they spelled it (an ssh host alias)", () => {
    const home = makePlanHome();
    const kept = git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc"]);
    const alias = `refs/aidlc/home/${home.id8}/${repoCopyKey("checkout-api-alias:acme/checkout-api.git")}/plan`;
    git(home.dir, ["update-ref", alias, String(home.plan)]);
    expect(planAtCopy(home.dir, alias, { named: true })?.plan.plan_repo).toEqual({ name: "checkout-api", address: home.hosts["checkout-api"] });
    expect(planAtCopy(home.dir, alias)).toBeNull();
    expect(planAtCopy(home.dir, kept)?.commit).toBe(String(home.plan));
  });

  test("the share run again with nothing new writes nothing", () => {
    const home = makePlanHome();
    share(home.dir);
    expect(git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)])).toBe(String(home.plan));
  });
});

describe("a later share goes on the plan's tip and keeps what is on it", () => {
  const addUnit = (dir: string): void => {
    const path = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(path, DEPENDENCIES.replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
  };

  test("a Unit added after the share: a commit on the tip, its version and the Unit named, the lead's word on the tip kept", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const worded = writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.units[0].word = { done: true };
    });
    addUnit(home.dir);
    share(home.dir);
    const ref = planRefOf(home.id8);
    expect(git(host, ["rev-parse", `${ref}^`])).toBe(worded);
    expect(git(host, ["log", "-1", "--format=%s", ref])).toBe(`aidlc plan ${registryOf(home.dir)[0].slug} 3: ledger-sync added`);
    const plan = planAt(host, ref);
    expect(plan.version).toBe(3);
    expect(plan.units.map((unit) => unit.name)).toEqual(["refunds", "checkout-ui", "reporting", "ledger-sync"]);
    expect(plan.units[0].word).toEqual({ done: true });
  });

  test("a second computer of the lead's, with no copy of the plan yet, builds on the plan already there", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const copy = git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc"]);
    git(home.dir, ["update-ref", "-d", copy]);
    const worded = writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.units[2].word = { signoff: { words: "ship it", at: "2026-11-16T00:00:00Z" } };
    });
    addUnit(home.dir);
    share(home.dir);
    const ref = planRefOf(home.id8);
    expect(git(host, ["rev-parse", `${ref}^`])).toBe(worded);
    expect(planAt(host, ref).units[2].word).toEqual({ signoff: { words: "ship it", at: "2026-11-16T00:00:00Z" } });
  });

  test("a Unit a teammate took while the work was solo keeps its record where it is: the workspace's own repository, which the plan then lists", () => {
    const api = codeHost("checkout-api");
    const home = makeHome({ repos: { "checkout-api": api, billing: codeHost("billing") } });
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bob = cloneOf(home.remote, "bob");
    const took = run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob);
    expect(took.status, took.out).toBe(0);
    // The lead's next step hears the take and switches the work to teams.
    next(home.dir);
    share(home.dir);
    const id8 = registryOf(home.dir)[0].uuid.replace(/-/g, "").slice(-8);
    const plan = planAt(api, planRefOf(id8));
    const workspace = (plan.repos as Array<{ name: string; address: string }>).find((repo) => repo.address === home.remote);
    expect(workspace, JSON.stringify(plan.repos)).toBeDefined();
    expect(plan.units.find((unit) => unit.name === "checkout-ui")).toMatchObject({ record: workspace?.name });
    expect(plan.units.find((unit) => unit.name === "refunds")).toMatchObject({ record: "checkout-api" });
  });
});

describe("a person alone meets nothing of it", () => {
  test("solo work across repositories: its steps make no read or write of a plan, and no repository gets one", () => {
    const api = codeHost("checkout-api");
    const home = makeHome({ repos: { "checkout-api": api, billing: codeHost("billing") } });
    const trace = join(tempDir("trace"), "git.jsonl");
    const env = { ...ENV, GIT_TRACE2_EVENT: trace };
    next(home.dir, env);
    next(home.dir, env);
    const argv = existsSync(trace)
      ? readFileSync(trace, "utf-8").split("\n").filter((line) => line.includes('"event":"start"'))
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(" "))
      : [];
    expect(argv.filter((line) => line.includes("refs/aidlc/plans"))).toEqual([]);
    expect(git(api, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(home.remote, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(home.dir, ["for-each-ref", "refs/aidlc/home"])).toBe("");
  });
});

// A plan's text as the cases below change it.
interface Loose {
  inputs: Array<{ path: string }>;
  repos: Array<{ name: string; branch: string | null }>;
  plan_repo: { address: string };
  units: Array<Record<string, unknown>>;
  settings: Record<string, string>;
  stages?: unknown;
  unit_stages?: unknown;
  [key: string]: unknown;
}

describe("plan.json is read only as a plan holds it", () => {
  // Anyone who can push to the plan's repository can write its text: every
  // name in it becomes a path or a git argument in a team's workspace.
  test("a path, a branch, a name or a value a plan never holds makes the plan unreadable, never an error", () => {
    const home = makePlanHome();
    const good = planAt(home.hosts["checkout-api"], planRefOf(home.id8)) as unknown as Loose;
    expect(planJsonOf(JSON.stringify(good)).plan).not.toBeNull();
    const bad: Array<[string, (plan: Loose) => void]> = [
      ["an input climbing out of the record", (plan) => { plan.inputs[0].path = "../../.git/hooks/pre-commit"; }],
      ["an absolute input path", (plan) => { plan.inputs[0].path = "/etc/hosts"; }],
      ["a drive path", (plan) => { plan.inputs[0].path = "C:/temp/x.md"; }],
      ["a backslash", (plan) => { plan.inputs[0].path = "inception\\x.md"; }],
      ["the record's state", (plan) => { plan.inputs[0].path = "aidlc-state.md"; }],
      ["the record's audit", (plan) => { plan.inputs[0].path = "audit/shard.md"; }],
      ["a branch that is an option", (plan) => { plan.repos[0].branch = "--upload-pack=x"; }],
      ["a branch that is a refspec", (plan) => { plan.repos[0].branch = "main:refs/heads/x"; }],
      ["a repository name with a path", (plan) => { plan.repos[0].name = "../elsewhere"; }],
      ["an address that is an option", (plan) => { plan.plan_repo.address = "-oProxyCommand=x"; }],
      ["a Unit with no record", (plan) => { delete plan.units[0].record; }],
      ["a Unit whose word is a list", (plan) => { plan.units[0].word = []; }],
      ["a Unit waiting on a name no Unit has", (plan) => { plan.units[0].waits_on = ["a b"]; }],
      ["no stages", (plan) => { delete plan.stages; }],
      ["no per-Unit stages", (plan) => { delete plan.unit_stages; }],
      ["a setting of two lines", (plan) => { plan.settings.Depth = "Standard\n- **Guard Policy**: off"; }],
    ];
    for (const [what, edit] of bad) {
      const plan = structuredClone(good);
      edit(plan);
      expect({ what, read: planJsonOf(JSON.stringify(plan)) }).toEqual({ what, read: { format: 1, plan: null } });
    }
    expect(planJsonOf("not json")).toEqual({ format: 0, plan: null });
    expect(planJsonOf(JSON.stringify({ ...good, format: 2 }))).toEqual({ format: 2, plan: null });
  });

  test("the plan the share builds always reads back, even for a repository named by an address with no name of its own", () => {
    const home = makePlanHome({ share: false });
    for (const named of [undefined, "git@plans.example:"]) {
      const place = planPlaceForShare(home.dir, named);
      if (!("ref" in place)) throw new Error(`no place for ${named}`);
      const built = planFilesNow(home.dir, null, place);
      expect(planJsonOf(JSON.stringify(built.plan)).plan, `${named}: ${place.repo}`).not.toBeNull();
    }
  });

  // Only the share, which the lead said yes to, writes over such a tip (the case below).
  test("a write nobody said yes to finds a plan it cannot read on the tip: nothing is written over it", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const broken = writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.inputs[0].path = "../../outside.md";
    });
    const place = planPlaceForShare(home.dir);
    if (!("ref" in place)) throw new Error("the plan has a place");
    expect(writePlan(home.dir, place, { what: "a word", unasked: true })).toEqual({ kind: "unreadable", format: 1 });
    expect(git(host, ["rev-parse", planRefOf(home.id8)])).toBe(broken);
  });
});

describe("what the lead reads", () => {
  const ADDED = (dir: string): void => {
    const path = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(path, DEPENDENCIES.replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
  };
  const isShare = (step: Record<string, unknown>): boolean =>
    step.kind === "ask" && ((step.handovers ?? []) as string[]).includes("share");

  test("the share question names where the plan goes, each Unit's repositories and who can read it; Share the plan or Not now", () => {
    const home = makePlanHome({ share: false });
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).toMatch(new RegExp(
      "^Do you want me to share the plan with the teams\\? I'd put it in checkout-api: the Units " +
        "\\(refunds in checkout-api and billing, checkout-ui in checkout-web, reporting in billing\\) and what each is built from" +
        "(, with your [a-z' ]+)?\\. " +
        "Nothing is added to a branch or to your files\\. Everyone who can read checkout-api can read it\\.$",
    ));
    const choices = ask.choices as Array<{ label: string; detail: string; command: string }>;
    expect(choices.map((choice) => [choice.label, choice.detail])).toEqual([
      ["Share the plan", "One push to checkout-api with your own git; nothing else changes."],
      ["Not now", "Nothing is pushed; say when you want it shared."],
    ]);
    expect(choices[0].command).toEndWith(" unit share --plan");
    expect(String(ask.board_note)).toContain("--repo <its name or address>");
    // A long plan names five Units and counts the rest.
    const more = ["audit", "ledger", "payouts"].map((name) => `  - name: ${name}\n    kind: service\n    repos: [billing]\n    depends_on: []\n`).join("");
    const long = next(makePlanHome({ share: false, dependencies: DEPENDENCIES.replace("```\n", `${more}\`\`\`\n`) }).dir);
    expect(String(long.question)).toMatch(/: the Units \((?:[a-z-]+ in [a-z -]+, ){5}and 1 more\) and what each is built from/);
  });

  test("the share says where the plan is, that AI-DLC tells nobody, the address a team needs, and the release a take needs", () => {
    const home = makePlanHome({ share: false });
    const shared = share(home.dir);
    expect(shared.json?.notice).toBe(
      "The plan is shared in checkout-api. AI-DLC sends no notice of it: the teams hear it from you. A team whose workspace has " +
        `no checkout-api needs this address: ${home.hosts["checkout-api"]} Taking a Unit of this work needs AI-DLC 2.12 or newer.`,
    );
    expect(isShare(next(home.dir))).toBe(false);
  });

  test("a Unit added after the share: asked once, naming it; shared again, said; the same share again changes nothing", () => {
    const home = makePlanHome();
    ADDED(home.dir);
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(ask.question).toBe("The plan in checkout-api does not have ledger-sync yet: you added it after you shared the plan. " +
      "Do you want me to share it again? Nothing is added to a branch or to your files.");
    expect((ask.choices as Array<{ label: string; detail: string }>).map((choice) => [choice.label, choice.detail])).toEqual([
      ["Share the plan again", "One push to checkout-api, on top of what is there; nothing else changes."],
      ["Not now", "Nothing is pushed; say when you want it shared."],
    ]);
    expect(share(home.dir).json?.notice).toBe("The plan in checkout-api has ledger-sync now.");
    expect(share(home.dir).json?.notice).toBe("The plan in checkout-api already has everything here.");
  });

  test("a plan gone from its repository is shared again with the words this computer last had on it, and said", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.units[0].word = { done: true };
    });
    share(home.dir);
    git(host, ["update-ref", "-d", planRefOf(home.id8)]);
    expect(share(home.dir).json?.notice).toBe(
      "The plan was no longer in checkout-api, so I shared it again, with what you decided on each Unit as this computer last had it.",
    );
    const plan = planAt(host, planRefOf(home.id8));
    expect(plan.units[0].word).toEqual({ done: true });
    expect(git(host, ["rev-list", "--count", planRefOf(home.id8)])).toBe("1");
  });

  test("a repository with no address: the question gives way to one line, once, and the share says the same", () => {
    const home = makePlanHome({ share: false, repos: { "checkout-api": "", billing: codeHost("billing") } });
    const LINE = "checkout-api has no remote here, so there is nowhere to put the plan yet. Give me its address, or name another " +
      "repository the teams can read, and I'll share it there.";
    const step = next(home.dir);
    expect(String(step.narration ?? step.message ?? ""), JSON.stringify(step)).toContain(LINE);
    expect(JSON.stringify(next(home.dir))).not.toContain(LINE);
    expect(run(UNIT, ["share", "--plan"], home.dir).json?.error).toBe(LINE);
  });

  test("--repo: another repository takes the plan; a name nobody has, or one git would read as an option, pushes nothing", () => {
    const home = makePlanHome({ share: false });
    const other = codeHost("platform-docs");
    expect(run(UNIT, ["share", "--plan", "--repo", other], home.dir).status).toBe(0);
    expect(git(other, ["for-each-ref", "--format=%(refname)", "refs/aidlc"])).toBe(planRefOf(home.id8));
    expect(git(home.hosts["checkout-api"], ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(run(UNIT, ["share", "--plan", "--repo", "nowhere"], home.dir).json?.error).toBe(
      "nowhere is not a repository of this work or of repos.json, and not a git address, so nothing was pushed. " +
        "Give me its address and I'll share the plan there.",
    );
    expect(run(UNIT, ["share", "--plan", "--repo=-x"], home.dir).json?.error).toBe(
      '"-x" starts with "-", so git would read it as an option; nothing was pushed.',
    );
  });

  test("a host that does not answer: git's words, and the retry is the lead's to ask", () => {
    const home = makePlanHome({ share: false });
    git(join(home.dir, "checkout-api"), ["remote", "set-url", "origin", join(tempDir("gone"), "nothing-here.git")]);
    const refused = run(UNIT, ["share", "--plan"], home.dir);
    expect(String(refused.json?.error)).toMatch(/^checkout-api could not be reached, so the plan is not shared: git says ".+"\. Say when to try again\.$/);
  });

  // git ends a push with the same fatal exit when the host answered and gave
  // no push access (an https 403, ssh's Permission denied) as when it was not
  // reached; here the host reads, and its pushes go where nothing takes them.
  test("a host that answers a read and ends the push with a fatal exit did not take the plan; it was reached", () => {
    const home = makePlanHome({ share: false });
    git(home.dir, ["config", `url.${join(tempDir("no-push"), "denied.git")}.pushInsteadOf`, home.hosts["checkout-api"]]);
    const refused = run(UNIT, ["share", "--plan"], home.dir);
    expect(String(refused.json?.error)).toMatch(
      /^checkout-api did not take the plan: .+\. Say when to try again, or name another repository the teams can read\.$/,
    );
    expect(git(home.hosts["checkout-api"], ["for-each-ref", "refs/aidlc"])).toBe("");
  });

  test("a host rule on the commit message: its words, the way in for the lead's own message, and that message taken", () => {
    const home = makePlanHome({ share: false });
    ticketKeyRule(home.hosts["checkout-api"]);
    const refused = run(UNIT, ["share", "--plan"], home.dir);
    expect(refused.status, refused.out).toBe(0);
    expect(refused.json?.shared).toBe(false);
    expect(String(refused.json?.notice)).toContain(`checkout-api did not take the plan: ${TICKET_RULE_WORDS}`);
    expect(String(refused.json?.notice)).toEndWith("If it is the commit message, tell me the one to use, and I will share it with that.");
    const file = /write it to (\S+) with your file tool/.exec(String(refused.json?.step))?.[1] ?? "";
    expect(String(refused.json?.step)).toContain(` unit share --plan --commit-message-file ${file}`);
    mkdirSync(dirname(join(home.dir, ...file.split("/"))), { recursive: true });
    writeFileSync(join(home.dir, ...file.split("/")), "ABC-1 share the plan\n");
    expect(run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir).status).toBe(0);
    expect(git(home.hosts["checkout-api"], ["log", "-1", "--format=%s", planRefOf(home.id8)])).toBe("ABC-1 share the plan");
  });

  test("a tip that is not a plan: the share writes over it, carrying the decisions this work's plan last had; a newer one never", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    const ref = planRefOf(home.id8);
    // The lead's decision on a Unit, then a plan.json that does not read pushed on top of it.
    writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.units[0].word = { done: true };
    });
    const broken = writeOnTip(host, home.id8, (plan) => {
      plan.version = 3;
      plan.inputs[0].path = "../../outside.md";
    });
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(String(shared.json?.notice)).toStartWith(
      "The plan in checkout-api is shared again over what was there, with what was decided on each Unit as the plan last had it.",
    );
    expect(git(host, ["rev-parse", `${ref}^`])).toBe(broken);
    const over = planAt(host, ref);
    expect(over.units[0].word).toEqual({ done: true });
    expect(over.version).toBe(4);
    // Pushed over whole by another work's plan, read on a computer of the lead's with no copy:
    // nothing of the other work is carried, and the line says the decisions were not there.
    const scratch = tempDir("other-work");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    let parent: string | null = null;
    for (const edit of [(plan: Plan) => { plan.work.id = `${plan.work.id}-other`; plan.units[0].word = { done: false }; },
      (plan: Plan) => { plan.inputs[0].path = "../../outside.md"; }]) {
      const plan = { ...over, units: over.units.map((unit) => ({ ...unit })), inputs: over.inputs.map((input) => ({ ...input })), work: { ...over.work } };
      edit(plan);
      git(scratch, ["update-index", "--add", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
      const tree = git(scratch, ["write-tree"]);
      parent = git(scratch, ["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", "another work"]);
    }
    git(scratch, ["push", "-q", "--force", host, `${parent}:${ref}`]);
    for (const copy of git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home"]).split("\n").filter(Boolean)) {
      git(home.dir, ["update-ref", "-d", copy]);
    }
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect(String(again.json?.notice)).toStartWith("The plan in checkout-api is shared again over what was there, from your own record " +
      "here. What you had decided on its Units was not there to carry, so it is not on the plan now.");
    const fresh = planAt(host, ref);
    expect(fresh.work.id).toBe(over.work.id);
    expect(fresh.units[0].word).toEqual({});
    const newer = writeOnTip(host, home.id8, (plan) => {
      (plan as Record<string, unknown>).format = 2;
    });
    expect(String(run(UNIT, ["share", "--plan"], home.dir).json?.error)).toBe(
      "The plan in checkout-api was set up with a newer AI-DLC, so nothing was written over it. Update AI-DLC here, then say when to share it.",
    );
    expect(git(host, ["rev-parse", ref])).toBe(newer);
  });

  test("teams chosen in a workspace with no remote say once that the lead's record is only here; with a remote nothing is said", () => {
    const LINE = "This workspace has no remote, so AI-DLC's record of this work and your approvals are only on this computer.";
    const lone = makePlanHome({ teams: false });
    expect(String(run(STATE, ["set-unit-ownership", "team"], lone.dir).json?.notice ?? "")).toContain(LINE);
    const remote = makeHome({ repos: { "checkout-api": codeHost("checkout-api") } });
    expect(String(run(STATE, ["set-unit-ownership", "team"], remote.dir).json?.notice ?? "")).not.toContain(LINE);
  });

  test("after the share, the lead's own stops say nothing of checking in aidlc/; a lead on a branch of their own is asked the same share", () => {
    const home = makePlanHome({ share: false });
    git(home.dir, ["switch", "-q", "-c", "lead-notes"]);
    const ask = next(home.dir);
    expect(String(ask.question)).toStartWith("Do you want me to share the plan with the teams?");
    share(home.dir);
    expect(checkInLine(home.dir)).toBeNull();
  });
});

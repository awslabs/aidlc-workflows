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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { gitTargetFor, planAtCopy, planFilesNow, planPlaceForShare, planUnitsKept, writePlan } from "../../dist/claude/.claude/tools/aidlc-unit.ts";
import { copyOf, inputName, planJsonOf, repoCopyKey, textFingerprint } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeGenerated,
  codeHost,
  DEPENDENCIES,
  ENV,
  git,
  hook,
  HOME_RECORD,
  homeState,
  makeHome,
  makePlanHome,
  makePlanHomeWithRemote,
  mergeOnHost,
  next,
  ORCH,
  personsChat,
  type PlanHome,
  planRefOf,
  refundsTaken,
  run,
  STATE,
  teamWorkspace,
  tempDir,
  TICKET_RULE_WORDS,
  ticketKeyRule,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const registryOf = (dir: string): Array<{ uuid: string; slug: string }> =>
  JSON.parse(readFileSync(join(dir, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8"));

interface Plan {
  version: number;
  work: { id: string; label: string; space: string };
  plan_repo: { name: string; address: string };
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

// The share asks first about a change on the plan this computer did not write
// (writeOnTip's): the lead keeps it, and the share then goes on top of it.
function keepTheirChange(dir: string): void {
  const asked = run(UNIT, ["share", "--plan"], dir);
  expect(asked.json?.ask_type, asked.out).toBe("lead-plan-change");
  const keep = (asked.json?.choices as Array<{ label: string; command: string }>)[0];
  expect(keep.label).toBe("Keep it");
  expect(run(UNIT, ["plan-change", "keep", "--tip", /--tip (\S+)/.exec(keep.command)![1]], dir).status).toBe(0);
}

// A commit on the plan's tip made with plain git, as another writer of the
// plan would make it: `edit` changes its plan.json, `files` adds files beside it.
function writeOnTip(host: string, id8: string, edit: (plan: Plan) => void, files: Record<string, string> = {}): string {
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
  for (const [path, text] of Object.entries(files)) git(scratch, ["update-index", "--add", "--cacheinfo", `100644,${spawnHash(scratch, text)},${path}`]);
  const tree = git(scratch, ["write-tree"]);
  const commit = git(scratch, ["commit-tree", tree, "-p", "refs/tip", "-m", `aidlc plan word ${plan.version}`]);
  git(scratch, ["push", "-q", host, `${commit}:${planRefOf(id8)}`]);
  return commit;
}

// A move made on another computer of the lead's, by plain git: the plan in `to`
// as one commit on the old tip naming `to` as its own, and this work's pointer
// on the old tip at `from`.
function movedByHand(home: { hosts: Record<string, string>; id8: string }, from: string, to: string): void {
  const ref = planRefOf(home.id8);
  const scratch = tempDir("plan-move");
  git(scratch, ["init", "-q"]);
  git(scratch, ["config", "user.name", "lead"]);
  git(scratch, ["config", "user.email", "lead@example.test"]);
  git(scratch, ["fetch", "-q", home.hosts[from], `${ref}:refs/tip`]);
  git(scratch, ["read-tree", "refs/tip"]);
  const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
  plan.version += 1;
  plan.plan_repo = { name: to, address: home.hosts[to] };
  git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
  const moved = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "a move"]);
  git(scratch, ["push", "-q", home.hosts[to], `${moved}:${ref}`]);
  const pointer = { format: 1, work: plan.work, moved_to: { name: to, address: home.hosts[to] } };
  const blob = spawnHash(scratch, `${JSON.stringify(pointer, null, 2)}\n`);
  const tree = spawnSync("git", ["mktree"], { cwd: scratch, input: `100644 blob ${blob}\tplan.json\n`, encoding: "utf-8" }).stdout.trim();
  const note = git(scratch, ["commit-tree", tree, "-p", "refs/tip", "-m", `aidlc plan ${plan.work.label}: moved to ${to}`]);
  git(scratch, ["push", "-q", home.hosts[from], `${note}:${ref}`]);
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
    // Once repos.json gives it an address, its record stays where the plan has
    // it, since a take may be recorded there already.
    const repos = JSON.parse(readFileSync(join(home.dir, "repos.json"), "utf-8"));
    repos.repos.push({ name: "checkout-web", url: "https://example.test/acme/checkout-web.git" });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify(repos, null, 2)}\n`);
    share(home.dir);
    const again = planAt(host, planRefOf(home.id8));
    expect(again.units.find((unit) => unit.name === "checkout-ui")).toMatchObject({ record: "checkout-api" });
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
    // No command AI-DLC runs carries the password. The push still signs in:
    // git's own remote helper is handed the rewritten address, as for any push
    // from that clone. Its path is the platform's own, and a git that keeps the
    // password out of its trace (Git for Windows) shows the address with the
    // lead's user name only: the plain address has none, so only the rewrite
    // to the signed one puts it there. The host here never answers, so the push
    // itself does not go through.
    const helper = (line: string): boolean => /(^|[\\/])git(\.exe)?[ -]remote-https?(\.exe)? /i.test(line);
    expect(argv.filter((line) => line.includes("tok3n") && !helper(line))).toEqual([]);
    expect(argv.some((line) => helper(line) && /https:\/\/lead:[^@\s]+@127\.0\.0\.1:9\/acme\/checkout-api\.git/.test(line)),
      JSON.stringify(argv.filter((line) => /remote-https?/i.test(line)))).toBe(true);
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
  test("a share without --plan, typed on a branch of the lead's own, commits only AI-DLC's record there and pushes nothing; with no remote it says so and commits nothing", () => {
    const home = makePlanHomeWithRemote();
    writeFileSync(join(home.dir, "app.txt"), "one\n");
    git(home.dir, ["add", "app.txt"]);
    git(home.dir, ["commit", "-q", "-m", "app"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const main = git(home.remote, ["rev-parse", "refs/heads/main"]);
    git(home.dir, ["checkout", "-q", "-b", "my-work"]);
    writeFileSync(join(home.dir, "app.txt"), "two\n");
    writeFileSync(join(home.dir, "draft.txt"), "mine\n");
    const shared = run(UNIT, ["share"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(shared.json?.shared).toBe(false);
    expect(String(shared.json?.notice)).toStartWith("This checkout is on my-work, not main, so AI-DLC's record of this work is committed here and nothing is pushed.");
    expect(git(home.remote, ["rev-parse", "refs/heads/main"])).toBe(main);
    expect(git(home.remote, ["for-each-ref", "refs/heads/my-work"])).toBe("");
    const status = git(home.dir, ["status", "--porcelain", "--", "app.txt", "draft.txt"]);
    expect(status).toMatch(/^ ?M app\.txt$/m);
    expect(status).toContain("?? draft.txt");
    expect(git(home.dir, ["log", "-1", "--format=%H", "main"])).toBe(main);

    const alone = makePlanHome();
    writeFileSync(join(alone.dir, "draft.txt"), "mine\n");
    const before = git(alone.dir, ["rev-parse", "HEAD"]);
    const none = run(UNIT, ["share"], alone.dir);
    expect(none.status, none.out).not.toBe(0);
    expect(none.json?.error).toBe("This repository has no remote to share main with. Add one (git remote add origin <url>), then share again.");
    expect(git(alone.dir, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(alone.dir, ["status", "--porcelain", "--", "draft.txt"])).toBe("?? draft.txt");
  });

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
    expect(planAtCopy(home.dir, elsewhere, { found: true }).kind).toBe("unreadable");
    expect(planAtCopy(home.dir, kept, { found: true })).toMatchObject({ kind: "read", oid: String(home.plan) });
    expect(planUnitsKept(home.dir)).toEqual(["refunds", "checkout-ui", "reporting"]);
  });

  test("a copy read at an address the person named is the plan, however they spelled it (an ssh host alias)", () => {
    const home = makePlanHome();
    const kept = git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc"]);
    const alias = `refs/aidlc/home/${home.id8}/${repoCopyKey("checkout-api-alias:acme/checkout-api.git")}/plan`;
    git(home.dir, ["update-ref", alias, String(home.plan)]);
    expect(planAtCopy(home.dir, alias)).toMatchObject({ kind: "read", plan: { plan_repo: { name: "checkout-api", address: home.hosts["checkout-api"] } } });
    expect(planAtCopy(home.dir, alias, { found: true }).kind).toBe("unreadable");
    expect(planAtCopy(home.dir, kept)).toMatchObject({ kind: "read", oid: String(home.plan) });
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
    keepTheirChange(home.dir);
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
    keepTheirChange(home.dir);
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

// The lead's answer on how the Units are approved goes on the plan by the
// lead's own writer, as the sign-off setting does: that setting and the
// version, nothing else, and with every later write of the lead's.
describe("the lead's answer on how the Units are approved goes on the shared plan", () => {
  const rhythmAt = (host: string, id8: string): string | undefined =>
    (planAt(host, planRefOf(id8)).settings as Record<string, string>)["Unit Gate Rhythm"];

  test("the approval setting's write puts only that setting on the plan", () => {
    const home = makePlanHomeWithRemote();
    const host = home.hosts["checkout-api"];
    const ref = planRefOf(home.id8);
    const before = planAt(host, ref);
    const set = run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir);
    expect(set.status, set.out).toBe(0);
    const after = planAt(host, ref);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
    expect(changed).toEqual(["settings", "version"]);
    expect(after.version).toBe(before.version + 1);
    expect(after.settings).toEqual({ ...(before.settings as Record<string, string>), "Unit Gate Rhythm": "unit-end" });
    expect(git(host, ["diff", "--name-only", `${ref}~1`, ref])).toBe("plan.json");
    expect(git(host, ["log", "-1", "--format=%s", ref])).toBe(`aidlc plan fixture ${after.version}: approvals once at the end of each Unit`);
    expect(run(STATE, ["set-unit-gate-rhythm", "per-stage"], home.dir).status).toBe(0);
    expect(git(host, ["log", "-1", "--format=%s", ref])).toBe(`aidlc plan fixture ${after.version + 1}: approvals after every stage`);
  });

  test("a lead write carries the answered setting, and a computer that never answered keeps the plan's", () => {
    const home = makePlanHomeWithRemote();
    const host = home.hosts["checkout-api"];
    const hookPath = join(host, "hooks", "pre-receive");
    writeFileSync(hookPath, "#!/bin/sh\necho 'plans are read only here' >&2\nexit 1\n");
    chmodSync(hookPath, 0o755);
    expect(run(STATE, ["set-unit-gate-rhythm", "unit-end"], home.dir).status).toBe(0);
    expect(rhythmAt(host, home.id8)).toBe("per-stage");
    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    const signed = run(UNIT, ["lead-sign-off", "on"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    expect(rhythmAt(host, home.id8)).toBe("unit-end");
    // The lead's other computer, whose state never heard the answer: its own
    // writes, a share included, keep the plan's.
    const laptop = cloneOf(home.remote, "laptop");
    expect(run(UTILITY, ["intent", "switch", HOME_RECORD], laptop).status).toBe(0);
    expect(run(UNIT, ["lead-here", "--person-words", "I lead this work, carry it on here"], laptop).status).toBe(0);
    next(laptop);
    expect(readFileSync(seededStateFile(laptop), "utf-8")).not.toContain("Unit Gate Rhythm");
    const off = run(UNIT, ["lead-sign-off", "off"], laptop);
    expect(off.status, off.out).toBe(0);
    expect((planAt(host, planRefOf(home.id8)).settings as Record<string, string>)["Lead Sign-off"]).toBe("off");
    expect(rhythmAt(host, home.id8)).toBe("unit-end");
    const shared = run(UNIT, ["share", "--plan"], laptop);
    expect(shared.status, shared.out).toBe(0);
    expect(rhythmAt(host, home.id8)).toBe("unit-end");
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
      // Case-blind and dot-dropping file systems read these as the record's own files.
      ["the record's state in capitals", (plan) => { plan.inputs[0].path = "AIDLC-STATE.md"; }],
      ["the record's audit in capitals", (plan) => { plan.inputs[0].path = "Audit/2026.md"; }],
      ["a folder ending in a dot", (plan) => { plan.inputs[0].path = "inception./x.md"; }],
      ["a name ending in a space", (plan) => { plan.inputs[0].path = "inception/x.md "; }],
      ["an input outside ideation and inception", (plan) => { plan.inputs[0].path = "notes/x.md"; }],
      ["an input of two lines", (plan) => { plan.inputs[0].path = "inception/x.md\ny.md"; }],
      ["a word whose generation is text", (plan) => { plan.units[0].word = { generation: "1" }; }],
      ["a word whose done is not true", (plan) => { plan.units[0].word = { done: "yes" }; }],
      ["a word whose amendments are not a list", (plan) => { plan.units[0].word = { amendments: {} }; }],
      ["a word whose amendment has no blob", (plan) => {
        plan.units[0].word = { amendments: [{ input: plan.inputs[0].path, at: "t", words: "" }] };
      }],
      ["a word whose sign-off has no time", (plan) => { plan.units[0].word = { signoff: { words: "ok" } }; }],
    ];
    for (const [what, edit] of bad) {
      const plan = structuredClone(good);
      edit(plan);
      expect({ what, read: planJsonOf(JSON.stringify(plan)) }).toEqual({ what, read: { format: 1, plan: null } });
    }
    expect(planJsonOf("not json")).toEqual({ format: 0, plan: null });
    expect(planJsonOf(JSON.stringify({ ...good, format: 2 }))).toEqual({ format: 2, plan: null });
    // An amendment is kept only for one of the plan's own inputs, by a full object id.
    const listed = structuredClone(good);
    const blob = "0123456789abcdef0123456789abcdef01234567";
    listed.units[0].word = { generation: 1, amendments: [
      { input: listed.inputs[0].path, at: "t", words: "", blob },
      { input: "inception/not-listed.md", at: "t", words: "", blob },
      { input: listed.inputs[0].path, at: "t", words: "", blob: "0123abc" },
    ] };
    expect(planJsonOf(JSON.stringify(listed)).plan?.units[0].word).toEqual({ generation: 1, amendments: [
      { input: listed.inputs[0].path, at: "t", words: "", blob },
    ] });
  });

  // A word AI-DLC writes never makes the plan unreadable, whatever the lead's words hold.
  test("every word the lead's steps write reads back: a merge said in two lines, a sign-off, a turn-down, a send-back from Build and Test, opened again", () => {
    const { home, alice, record } = refundsTaken();
    codeGenerated(alice, record);
    expect(run(UNIT, ["push"], alice).status).toBe(0);
    const host = Object.values(home.hosts)[0];
    const steps: Array<[string, string[]]> = [
      ["a merge said in two lines", ["merged", "refunds", "--repo", "billing", "--person-words", "merged by hand\nafter the review"]],
      ["the sign-off setting", ["lead-sign-off", "on"]],
      ["a sign-off", ["sign-off", "refunds", "--person-words", "looks right"]],
      ["a turn-down", ["turned-down", "refunds", "--repo", "billing", "--person-words", "the totals are wrong"]],
      ["a send-back from Build and Test", ["send-back", "refunds", "--person-words", "the totals are wrong"]],
      ["opened again", ["release", "refunds"]],
    ];
    for (const [what, args] of steps) {
      const done = run(UNIT, args, home.dir);
      expect(done.status, `${what}: ${done.out}`).toBe(0);
      expect(planJsonOf(git(host, ["show", `${planRefOf(home.id8)}:plan.json`])).plan, what).not.toBeNull();
    }
  });

  test("a plan listing an input outside ideation/ and inception/ is not read, so a take writes nothing of it into the build", () => {
    const home = makePlanHome();
    const host = home.hosts["checkout-api"];
    writeOnTip(host, home.id8, (plan) => {
      plan.version = 2;
      plan.inputs.push({ path: "AIDLC-STATE.md", fingerprint: "x" });
    }, { "inputs/AIDLC-STATE.md": "# Not this build's state\n" });
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", host], web);
    const intents = join(web, "aidlc", "spaces", "default", "intents");
    const found = existsSync(intents) ? readdirSync(intents, { recursive: true }).map(String) : [];
    expect(found.filter((path) => path.endsWith("AIDLC-STATE.md"))).toEqual([]);
  });

  test("a moved plan's pointer reads as moved, with the work it is and where it went, and only in its own shape", () => {
    const home = makePlanHome();
    const good = planAt(home.hosts["checkout-api"], planRefOf(home.id8));
    const pointer = { format: 1, work: good.work, moved_to: { name: "billing", address: home.hosts.billing } };
    expect(planJsonOf(JSON.stringify(pointer))).toEqual({ format: 1, plan: null, moved: pointer });
    expect(planJsonOf(JSON.stringify(good)).moved).toBeUndefined();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["another key", { ...pointer, version: 2 }],
      ["no work", { format: 1, moved_to: pointer.moved_to }],
      ["a name with a path", { ...pointer, moved_to: { ...pointer.moved_to, name: "../billing" } }],
      ["an address with a sign-in", { ...pointer, moved_to: { ...pointer.moved_to, address: "https://lead:tok3n@git.example.invalid/billing.git" } }],
      ["an address git would read as an option", { ...pointer, moved_to: { ...pointer.moved_to, address: "-x" } }],
      ["another key where it went", { ...pointer, moved_to: { ...pointer.moved_to, branch: "main" } }],
      ["a format above this release's", { ...pointer, format: 2 }],
    ];
    for (const [what, value] of bad) {
      const read = planJsonOf(JSON.stringify(value));
      expect({ what, plan: read.plan, moved: read.moved }).toEqual({ what, plan: null, moved: undefined });
    }
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

describe("the lead moves the shared plan to another repository", () => {
  const moveTo = (dir: string, repo: string) => run(UNIT, ["share", "--plan", "--repo", repo], dir);
  const note = (host: string, id8: string) => planJsonOf(git(host, ["show", `${planRefOf(id8)}:plan.json`])).moved;
  const homeOf = (dir: string): string | undefined => /^- \*\*Home Location\*\*: (.*)$/m.exec(readFileSync(seededStateFile(dir), "utf-8"))?.[1];
  const OTHER = DEPENDENCIES.replace("```\n", "  - name: notes\n    kind: service\n    repos: []\n    depends_on: []\n```\n");
  const ADDED = (dir: string): void => {
    const path = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
  };

  test("moved: the plan in the new repository on the old tip, the note on the old tip, Home Location there, and the next share writes there", () => {
    const home = makePlanHome({ dependencies: OTHER });
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const old = writeOnTip(api, home.id8, (plan) => {
      plan.version = 2;
      plan.units[0].word = { done: true };
    });
    keepTheirChange(home.dir);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(moved.json?.notice).toBe("The plan is in billing now, with what was decided on each Unit, and checkout-api says where it went. " +
      "Its earlier versions stay readable in both. " +
      `Everyone who takes a Unit needs read access to billing; AI-DLC sends no notice of the move. billing's address: ${home.hosts.billing}`);
    // The plan there: one commit on the old tip, only where it lives and its version changed, each record where it was.
    expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(old);
    const there = planAt(home.hosts.billing, ref);
    expect(there.plan_repo).toEqual({ name: "billing", address: home.hosts.billing });
    expect(there.version).toBe(3);
    expect(there.units[0].word).toEqual({ done: true });
    expect(there.units.find((unit) => unit.name === "notes")?.record).toBe("checkout-api");
    // The note at the old place, on the old tip.
    expect(git(api, ["rev-parse", `${ref}^`])).toBe(old);
    expect(note(api, home.id8)?.moved_to).toEqual({ name: "billing", address: home.hosts.billing });
    expect(git(api, ["log", "-1", "--format=%s", ref])).toBe(`aidlc plan ${registryOf(home.dir)[0].slug}: moved to billing`);
    expect(homeOf(home.dir)).toBe(home.hosts.billing);
    const pointer = git(api, ["rev-parse", ref]);
    ADDED(home.dir);
    expect(share(home.dir).json?.notice).toBe("The plan in billing has ledger-sync now.");
    expect(git(api, ["rev-parse", ref])).toBe(pointer);
    // A Unit taken from it reads its record where it was: the next share keeps it.
    expect(planAt(home.hosts.billing, ref).units.find((unit) => unit.name === "notes")?.record).toBe("checkout-api");
    // And back again: the plan takes the note's place, as one commit on the
    // plan in billing, and billing gets the note.
    const last = git(home.hosts.billing, ["rev-parse", ref]);
    const back = moveTo(home.dir, "checkout-api");
    expect(String(back.json?.notice), back.out).toStartWith("The plan is in checkout-api now, with what was decided on each Unit, and billing says " +
      "where it went. Its earlier versions stay readable in both.");
    expect(git(api, ["rev-parse", `${ref}^`])).toBe(last);
    expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(last);
    expect(planAt(api, ref).plan_repo.name).toBe("checkout-api");
    expect(note(home.hosts.billing, home.id8)?.moved_to.name).toBe("checkout-api");
  });

  test("a Unit whose record is in the plan's own repository, the plan first shared outside the work's list: after the move it is still taken", () => {
    const home = makePlanHome({ dependencies: OTHER, share: false });
    const ref = planRefOf(home.id8);
    const docs = codeHost("docs");
    expect(run(UNIT, ["share", "--plan", "--repo", docs], home.dir).status).toBe(0);
    const first = planAt(docs, ref);
    expect(first.units.find((unit) => unit.name === "notes")?.record).toBe(first.plan_repo.name);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "notes", "--plan", home.id8, "--from", docs], pay);
    expect(took.status, took.out).toBe(0);
    expect(moveTo(home.dir, "billing").status).toBe(0);
    const there = planAt(home.hosts.billing, ref);
    expect(there.units.find((unit) => unit.name === "notes")?.record).toBe(first.plan_repo.name);
    expect((there.repos as Array<{ name: string; address: string | null }>).find((repo) => repo.name === first.plan_repo.name)?.address).toBe(docs);
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const second = run(UNIT, ["take", "notes", "--plan", home.id8, "--from", home.hosts.billing], web);
    expect(second.json?.taken, second.out).not.toBe(true);
  });

  // The move marks two commits of its own within one second; which reads as
  // the newer then falls to the folder's order, so the case is run a few times.
  test("on the computer that moved the plan, Take it out for a change another computer wrote there takes it out", () => {
    for (let round = 0; round < 4; round++) {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      expect(moveTo(home.dir, "billing").status).toBe(0);
      writeOnTip(home.hosts.billing, home.id8, (plan) => {
        plan.version += 1;
        plan.units[0].word = { done: true };
      });
      const asked = run(UNIT, ["share", "--plan"], home.dir);
      expect(asked.json?.ask_type, asked.out).toBe("lead-plan-change");
      const out = (asked.json?.choices as Array<{ label: string; command: string }>).find((choice) => choice.label === "Take it out")!;
      expect(run(UNIT, ["plan-change", "take-out", "--tip", /--tip (\S+)/.exec(out.command)![1]], home.dir).status).toBe(0);
      ADDED(home.dir);
      const shared = share(home.dir);
      expect(String(shared.json?.notice), `round ${round}: ${shared.out}`).toContain("The plan in billing is back as you last had it.");
      expect(planAt(home.hosts.billing, ref).units[0].word).toEqual({});
    }
  });

  for (const first of ["after the plain share met it", "with no copy of it here"] as const) {
    test(`a note of a newer AI-DLC at the plan's place, ${first}: a share naming another repository gives the update step and shares nothing there`, () => {
      const home = makePlanHome();
      const api = home.hosts["checkout-api"];
      writeOnTip(api, home.id8, (plan) => {
        for (const key of Object.keys(plan)) if (key !== "work") delete plan[key];
        Object.assign(plan, { format: 2, moved_to: { name: "billing", address: home.hosts.billing } });
      });
      if (first === "after the plain share met it") expect(run(UNIT, ["share", "--plan"], home.dir).out).toContain("newer AI-DLC");
      else git(home.dir, ["update-ref", "-d", copyOf(api, planRefOf(home.id8))]);
      const named = moveTo(home.dir, "checkout-web");
      expect(named.status, named.out).not.toBe(0);
      expect(named.out).toContain("newer AI-DLC");
      expect(git(home.hosts["checkout-web"], ["for-each-ref", "refs/aidlc"])).toBe("");
      expect(homeOf(home.dir)).toBe(api);
    });
  }

  test("a copy of the plan in another repository whose old place takes the note: an ordinary move, the copy replaced by the plan", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    git(home.hosts["checkout-api"], ["push", "-q", home.hosts.billing, `${ref}:${ref}`]);
    const tip = git(home.hosts["checkout-api"], ["rev-parse", ref]);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toStartWith("The plan is in billing now, with what was decided on each Unit, and checkout-api says where it went.");
    expect(planAt(home.hosts.billing, ref).plan_repo.name).toBe("billing");
    expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(tip);
    expect(note(home.hosts["checkout-api"], home.id8)?.moved_to.name).toBe("billing");
    expect(homeOf(home.dir)).toBe(home.hosts.billing);
  });

  test("the new repository refusing: nothing changes; the old one refusing the note: the plan stays in the new one, nothing written at the old", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const refuse = (host: string) => {
      writeFileSync(join(host, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: no pushes here' >&2\nexit 1\n");
      chmodSync(join(host, "hooks", "pre-receive"), 0o755);
    };
    const tip = git(home.hosts["checkout-api"], ["rev-parse", ref]);
    refuse(home.hosts.billing);
    const refused = moveTo(home.dir, "billing");
    expect(String(refused.json?.error)).toMatch(/^billing did not take the plan, so it stays in checkout-api: .+\. Say when to try again\.$/);
    unlinkSync(join(home.hosts.billing, "hooks", "pre-receive"));
    expect(git(home.hosts.billing, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(homeOf(home.dir)).toBe(home.hosts["checkout-api"]);
    // An old place that refuses the note refuses every other write of the lead's too.
    refuse(home.hosts["checkout-api"]);
    const noNote = moveTo(home.dir, "billing");
    expect(noNote.status, noNote.out).toBe(0);
    expect(String(noNote.json?.notice)).toStartWith("The plan is in billing now, with what was decided on each Unit. checkout-api did not take the note " +
      "that the plan moved (");
    expect(String(noNote.json?.notice)).toContain("), so nothing was written there and checkout-api does not say where the plan went. Give " +
      "billing's address to everyone who takes a Unit: until their AI-DLC has it, their builds read the plan in checkout-api as it was. Its earlier versions stay readable in both.");
    expect(git(home.hosts["checkout-api"], ["rev-parse", ref])).toBe(tip);
    expect(planAt(home.hosts.billing, ref).plan_repo.name).toBe("billing");
    expect(homeOf(home.dir)).toBe(home.hosts.billing);
  });

  test("the old place refusing the note where it took the plan under the person's own message: the message is asked for first, then the move goes with it", () => {
    const home = makePlanHome({ share: false });
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    ticketKeyRule(api);
    const write = (step: unknown, text: string): string => {
      const file = /write it to (\S+) with your file tool/.exec(String(step))?.[1] ?? "";
      mkdirSync(dirname(join(home.dir, ...file.split("/"))), { recursive: true });
      writeFileSync(join(home.dir, ...file.split("/")), text);
      return file;
    };
    const first = run(UNIT, ["share", "--plan"], home.dir);
    expect(run(UNIT, ["share", "--plan", "--commit-message-file", write(first.json?.step, "ABC-1 share the plan\n")], home.dir).status).toBe(0);
    const tip = git(api, ["rev-parse", ref]);
    const asked = moveTo(home.dir, "billing");
    expect(asked.status, asked.out).toBe(0);
    expect(asked.json?.shared).toBe(false);
    expect(String(asked.json?.notice)).toStartWith("checkout-api did not take the note that the plan moved, so the plan stays in checkout-api: ");
    expect(String(asked.json?.notice)).toEndWith("If it is the commit message, tell me the one to use, and I will move the plan with that.");
    expect(String(asked.json?.step)).toContain(" unit share --plan --repo billing --commit-message-file ");
    expect(git(home.hosts.billing, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(api, ["rev-parse", ref])).toBe(tip);
    expect(homeOf(home.dir)).toBe(api);
    // With their message the note goes: an ordinary move.
    const moved = run(UNIT, ["share", "--plan", "--repo", "billing", "--commit-message-file", write(asked.json?.step, "ABC-2 move the plan\n")], home.dir);
    expect(String(moved.json?.notice), moved.out).toStartWith("The plan is in billing now, with what was decided on each Unit, and checkout-api says where it went.");
    expect(note(api, home.id8)?.moved_to.name).toBe("billing");
  });

  test("a change on the plan this computer did not write stops the move for the lead's word, and so does one made while it moves, with no copy left", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const keep = (asked: ReturnType<typeof run>) => {
      const choice = (asked.json?.choices as Array<{ label: string; command: string }>)[0];
      expect(choice.label).toBe("Keep it");
      expect(run(UNIT, ["plan-change", "keep", "--tip", /--tip (\S+)/.exec(choice.command)![1]], home.dir).status).toBe(0);
    };
    const word = writeOnTip(api, home.id8, (plan) => {
      plan.version = 2;
      plan.units[0].word = { done: true };
    });
    const asked = moveTo(home.dir, "billing");
    expect(asked.json?.ask_type, asked.out).toBe("lead-plan-change");
    expect(String(asked.json?.error)).toStartWith("Before I write the plan's move to billing: ");
    expect(git(home.hosts.billing, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(api, ["rev-parse", ref])).toBe(word);
    keep(asked);
    // Another computer's word lands on the old place while the plan goes to billing.
    const later = writeOnTip(api, home.id8, (plan) => {
      plan.version = 3;
      plan.units[0].word = {};
    });
    git(api, ["update-ref", ref, word]);
    const hook = join(home.hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nunset GIT_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH\n" +
      `git --git-dir="${api.replaceAll("\\", "/")}" update-ref ${ref} ${later}\nrm -f "$0"\n`);
    chmodSync(hook, 0o755);
    const raced = moveTo(home.dir, "billing");
    expect(raced.json?.ask_type, raced.out).toBe("lead-plan-change");
    expect(git(home.hosts.billing, ["for-each-ref", "refs/aidlc"])).toBe("");
    expect(git(api, ["rev-parse", ref])).toBe(later);
    keep(raced);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(later);
    expect(git(api, ["rev-parse", `${ref}^`])).toBe(later);
  });

  test("the share question for a Unit added later, answered with another repository, moves the plan and shares the Unit; a move on its own does not", () => {
    for (const answer of ["move there", "not now, then move"] as const) {
      const home = makePlanHome();
      ADDED(home.dir);
      const ask = next(home.dir);
      expect(String(ask.question), JSON.stringify(ask).slice(0, 400)).toStartWith("The plan in checkout-api does not have ledger-sync yet");
      expect(String(ask.board_note)).toContain("When the person wants the plan moved and ledger-sync not shared yet, run the question's Not now first, then the move.");
      if (answer === "not now, then move") next(home.dir);
      const moved = moveTo(home.dir, "billing");
      expect(moved.status, moved.out).toBe(0);
      const units = planAt(home.hosts.billing, planRefOf(home.id8)).units.map((unit) => unit.name);
      if (answer === "move there") {
        expect(String(moved.json?.notice)).toEndWith(`billing's address: ${home.hosts.billing} The plan in billing has ledger-sync now.`);
        expect(units).toContain("ledger-sync");
      } else {
        expect(String(moved.json?.notice)).toEndWith(`ledger-sync is not on it yet: say when to share it. billing's address: ${home.hosts.billing}`);
        expect(units).not.toContain("ledger-sync");
      }
    }
  });

  test("a move asked at the lead's other computer, after the plan moved from there: it follows the note, says so once, and moves the plan from where it is", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    movedByHand(home, "checkout-api", "billing");
    const first = git(api, ["rev-parse", ref]);
    // The commit that moved the plan to billing holds nobody's decision, so nothing is asked: one move, with the follow said once.
    const moved = moveTo(home.dir, "checkout-web");
    expect(String(moved.json?.notice), moved.out).toStartWith(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${home.hosts.billing}); ` +
      "this computer writes it there now. The plan is in checkout-web now, with what was decided on each Unit, and billing says where it went. " +
      "Its earlier versions stay readable in both.");
    expect(note(home.hosts.billing, home.id8)?.moved_to.name).toBe("checkout-web");
    expect(planAt(home.hosts["checkout-web"], ref).plan_repo.name).toBe("checkout-web");
    expect(git(api, ["rev-parse", ref])).toBe(first);
    expect(homeOf(home.dir)).toBe(home.hosts["checkout-web"]);
  });

  test("a move back whose note the current place refuses keeps the plan at the first place, over its note", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    expect(moveTo(home.dir, "billing").status).toBe(0);
    const first = git(api, ["rev-parse", ref]);
    const hook = join(home.hosts.billing, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'error: no pushes here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const back = moveTo(home.dir, "checkout-api");
    expect(back.status, back.out).toBe(0);
    expect(String(back.json?.notice)).toStartWith("The plan is in checkout-api now, with what was decided on each Unit. billing did not take the note");
    expect(git(api, ["rev-parse", ref])).not.toBe(first);
    expect(planAt(api, ref).plan_repo.name).toBe("checkout-api");
    expect(planAt(home.hosts.billing, ref).plan_repo.name).toBe("billing");
    expect(homeOf(home.dir)).toBe(api);
  });

  test("a move at the lead's other computer whose note leads to a repository it cannot read: said, and nothing is moved on", () => {
    const home = makePlanHome();
    movedByHand(home, "checkout-api", "billing");
    renameSync(home.hosts.billing, `${home.hosts.billing}-gone`);
    const asked = moveTo(home.dir, "checkout-web");
    expect(asked.status, asked.out).not.toBe(0);
    expect(String(asked.json?.error)).toMatch(new RegExp(`^The plan of ${registryOf(home.dir)[0].slug} moved to billing \\(.+\\), which could not be read ` +
      "\\(.+\\), so it was not moved on to checkout-web\\. Say when to try again\\.$"));
    expect(git(home.hosts["checkout-web"], ["for-each-ref", "refs/aidlc"])).toBe("");
  });

  test("a move at the lead's other computer whose note leads to a repository holding no plan now: the share's offer, with its command for the yes", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    movedByHand(home, "checkout-api", "billing");
    git(home.hosts.billing, ["update-ref", "-d", ref]);
    const asked = moveTo(home.dir, "checkout-web");
    expect(asked.status, asked.out).toBe(0);
    expect(asked.json?.shared).toBe(false);
    expect(asked.json?.notice).toBe(`The plan of ${registryOf(home.dir)[0].slug} says it moved, but billing does not hold it, so it was not moved on ` +
      "to checkout-web. I can share the plan again in billing from your own record here: say if you want that.");
    const yes = /`[^`]* unit share (--plan --repo \S+)`/.exec(String(asked.json?.step))?.[1].split(" ");
    expect(yes, String(asked.json?.step)).toEqual(["--plan", "--repo", "billing"]);
    expect(git(home.hosts["checkout-web"], ["for-each-ref", "refs/aidlc"])).toBe("");
    // The yes shares it there, then the move goes on in the same step: the person never asks for it twice.
    const step = String(asked.json?.step);
    const then = /once it shares the plan, run `[^`]* unit share (--plan --repo \S+)` in the same turn/.exec(step)?.[1].split(" ");
    expect(then, step).toEqual(["--plan", "--repo", "checkout-web"]);
    expect(step).toContain("If the share does not go, its own line is the answer: leave the move's command unrun.");
    const again = run(UNIT, ["share", ...yes!], home.dir);
    expect(again.json?.notice, again.out).toBe("The plan was no longer in billing, so I shared it again, with what was decided on each Unit as the plan had it when it moved.");
    const moved = run(UNIT, ["share", ...then!], home.dir);
    expect(String(moved.json?.notice), moved.out).toStartWith("The plan is in checkout-web now, with what was decided on each Unit, and billing says where it went.");
  });

  test("the share riding a move that meets another computer's change at the new place: the move is said, then the lead's question, and the share once they answer", () => {
    const home = makePlanHome();
    ADDED(home.dir);
    next(home.dir);
    const hook = join(home.hosts.billing, "hooks", "post-receive");
    writeFileSync(hook, "#!/bin/sh\nread old new ref\n" +
      "c=$(GIT_AUTHOR_NAME=someone GIT_AUTHOR_EMAIL=someone@example.test GIT_COMMITTER_NAME=someone GIT_COMMITTER_EMAIL=someone@example.test " +
      "git commit-tree \"$new^{tree}\" -p \"$new\" -m 'a word from another computer')\ngit update-ref \"$ref\" \"$c\"\nrm -f \"$0\"\n");
    chmodSync(hook, 0o755);
    const moved = moveTo(home.dir, "billing");
    expect(moved.json?.ask_type, moved.out).toBe("lead-plan-change");
    expect(String(moved.json?.error)).toStartWith("The plan is in billing now, with what was decided on each Unit, and checkout-api says where it went. " +
      "Its earlier versions stay readable in both. " +
      `Everyone who takes a Unit needs read access to billing; AI-DLC sends no notice of the move. billing's address: ${home.hosts.billing} `);
    expect(planAt(home.hosts.billing, planRefOf(home.id8)).units.map((unit) => unit.name)).not.toContain("ledger-sync");
    const keep = (moved.json?.choices as Array<{ command: string }>)[0].command;
    expect(run(UNIT, ["plan-change", "keep", "--tip", /--tip (\S+)/.exec(keep)![1]], home.dir).status).toBe(0);
    expect(moveTo(home.dir, "billing").json?.notice).toBe("The plan in billing has ledger-sync now.");
  });

  // A symlink stands for one repository under a second spelling, which Windows
  // makes only with a privilege.
  test.skipIf(process.platform === "win32")("a plan gone from its repository with no copy of it here: moved from the lead's own record, with the note made there", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    // The plan names its place by another spelling of the same repository, whose copy this computer never had.
    const alias = `${api}-alias`;
    symlinkSync(api, alias);
    const named = writeOnTip(api, home.id8, (plan) => {
      plan.plan_repo = { name: "checkout-api", address: alias };
    });
    git(home.dir, ["fetch", "-q", api, `+${named}:${copyOf(api, ref)}`]);
    git(api, ["update-ref", "-d", ref]);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toStartWith("The plan was no longer in checkout-api, and this computer had no copy of it; it is in billing now " +
      "from your own record here, and checkout-api says where it went. What was decided on its Units before was not there to carry, so it is not on " +
      "the plan now. Everyone who takes a Unit needs read access to billing;");
    const there = planAt(home.hosts.billing, ref);
    expect(there.plan_repo).toEqual({ name: "billing", address: home.hosts.billing });
    expect(git(home.hosts.billing, ["rev-list", "--count", ref])).toBe("1");
    expect(note(api, home.id8)?.moved_to.name).toBe("billing");
  });

  test("a move over something that is not a plan, with nothing of this work under it, carries nothing of it into the new repository", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const scratch = tempDir("plan-other");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "someone"]);
    git(scratch, ["config", "user.email", "someone@example.test"]);
    writeFileSync(join(scratch, "README.md"), "not a plan\n");
    git(scratch, ["add", "README.md"]);
    git(scratch, ["commit", "-q", "-m", "not a plan"]);
    const other = git(scratch, ["rev-parse", "HEAD"]);
    git(scratch, ["push", "-q", "--force", home.hosts["checkout-api"], `HEAD:${ref}`]);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(spawnSync("git", ["cat-file", "-e", `${other}^{commit}`], { cwd: home.hosts.billing }).status).not.toBe(0);
    // The plan there sits on this computer's copy of it.
    expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(String(home.plan));
  });

  test("a plan gone from its repository, or with something else in its place, moved in the same step: from this computer's copy, with the note made there", () => {
    for (const there of ["nothing", "something else", "an unreadable plan on top"] as const) {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      const api = home.hosts["checkout-api"];
      let other: string | null = null;
      if (there === "nothing") git(api, ["update-ref", "-d", ref]);
      else if (there === "an unreadable plan on top") {
        writeOnTip(api, home.id8, (plan) => {
          (plan as unknown as { units: string }).units = "none";
        });
        const moved = moveTo(home.dir, "billing");
        expect(String(moved.json?.notice), moved.out).toStartWith("The plan is in billing now, with what was decided on each Unit, and checkout-api says where it went. " +
          "Its earlier versions stay readable in both.");
        const written = planAt(home.hosts.billing, ref);
        expect(written.plan_repo.name).toBe("billing");
        expect(written.units.map((unit) => unit.name)).toContain("checkout-ui");
        expect(note(api, home.id8)?.moved_to.name).toBe("billing");
        continue;
      } else {
        const scratch = tempDir("plan-other");
        git(scratch, ["init", "-q"]);
        git(scratch, ["config", "user.name", "someone"]);
        git(scratch, ["config", "user.email", "someone@example.test"]);
        writeFileSync(join(scratch, "README.md"), "not a plan\n");
        git(scratch, ["add", "README.md"]);
        git(scratch, ["commit", "-q", "-m", "not a plan"]);
        other = git(scratch, ["rev-parse", "HEAD"]);
        git(scratch, ["push", "-q", "--force", api, `HEAD:${ref}`]);
      }
      const moved = moveTo(home.dir, "billing");
      // From this computer's copy, with its history: readable in billing, not under the note in checkout-api.
      expect(String(moved.json?.notice), moved.out).toStartWith("The plan was no longer in checkout-api; it is in billing now, with what you " +
        "decided on each Unit as this computer last had it, and checkout-api says where it went. Its earlier versions are readable in billing.");
      expect(planAt(home.hosts.billing, ref).plan_repo.name).toBe("billing");
      expect(note(api, home.id8)?.moved_to.name).toBe("billing");
      if (other !== null) expect(git(api, ["rev-parse", `${ref}^`])).toBe(other);
    }
  });
});

describe("a repository that moved hosts: the plan taken over where it is now", () => {
  const moveTo = (dir: string, repo: string) => run(UNIT, ["share", "--plan", "--repo", repo], dir);
  const note = (host: string, id8: string) => planJsonOf(git(host, ["show", `${planRefOf(id8)}:plan.json`])).moved;
  const homeOf = (dir: string): string | undefined => /^- \*\*Home Location\*\*: (.*)$/m.exec(readFileSync(seededStateFile(dir), "utf-8"))?.[1];
  const refuse = (host: string) => {
    writeFileSync(join(host, "hooks", "pre-receive"), "#!/bin/sh\necho 'error: no pushes here' >&2\nexit 1\n");
    chmodSync(join(host, "hooks", "pre-receive"), 0o755);
  };
  const ADDED = (dir: string): void => {
    const path = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
  };
  const takenOver = (old: string, now: string, address: string) =>
    `${old} does not say where the plan went. Give ${now}'s address to everyone who takes a Unit: until their AI-DLC has it, their builds read the plan in ${old} as it ` +
    `was. Its earlier versions stay readable in both. Everyone who takes a Unit needs read access to ${now}; AI-DLC sends no notice of the move. ${now}'s address: ${address}`;

  for (const lists of ["the same", "different"] as const) {
    test(`its old place taking no pushes, the two ref lists ${lists}: the plan is taken over at the new place, nothing is written at the old one, and the lead hears what to do`, () => {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      const api = home.hosts["checkout-api"];
      const billing = home.hosts.billing;
      git(api, ["push", "-q", "--mirror", billing]);
      if (lists === "different") {
        const scratch = tempDir("moved-host");
        git(scratch, ["clone", "-q", billing, "."]);
        git(scratch, ["config", "user.name", "someone"]);
        git(scratch, ["config", "user.email", "someone@example.test"]);
        writeFileSync(join(scratch, "NEW.md"), "on the new host\n");
        git(scratch, ["add", "NEW.md"]);
        git(scratch, ["commit", "-q", "-m", "on the new host"]);
        git(scratch, ["push", "-q", "origin", "HEAD"]);
      }
      const tip = git(api, ["rev-parse", ref]);
      refuse(api);
      const moved = moveTo(home.dir, "billing");
      expect(moved.status, moved.out).toBe(0);
      const said = String(moved.json?.notice);
      expect(said).toStartWith("The plan is in billing now, with what was decided on each Unit. checkout-api did not take the note that the plan moved (");
      expect(said).toContain("), so nothing was written there and ");
      expect(said).toEndWith(takenOver("checkout-api", "billing", billing));
      expect(git(api, ["rev-parse", ref])).toBe(tip);
      expect(note(api, home.id8)).toBeUndefined();
      expect(planAt(billing, ref).plan_repo).toEqual({ name: "billing", address: billing });
      expect(git(billing, ["rev-parse", `${ref}^`])).toBe(tip);
      expect(homeOf(home.dir)).toBe(billing);
      // The plan is the lead's there from now on.
      expect(share(home.dir).json?.notice).toBe("The plan in billing already has everything here.");
    });
  }

  test("a build in the lead's own workspace reads the plan where it was taken over", () => {
    const home = makePlanHome();
    const api = home.hosts["checkout-api"];
    expect(run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", api], home.dir).status).toBe(0);
    expect(run(UTILITY, ["intent", "switch", registryOf(home.dir)[0].slug], home.dir).status).toBe(0);
    const intents = join(home.dir, "aidlc", "spaces", "default", "intents");
    const build = join(intents, readdirSync(intents).find((name) => name.endsWith("-checkout-ui"))!, "aidlc-state.md");
    git(api, ["push", "-q", "--mirror", home.hosts.billing]);
    refuse(api);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(/^- \*\*Home Location\*\*: (.*)$/m.exec(readFileSync(build, "utf-8"))?.[1]).toBe(home.hosts.billing);
  });

  test("the lead's other computer holding a word the plan taken over lacks: its move writes nothing over the plan there and follows it", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    git(api, ["push", "-q", "--mirror", billing]);
    // The take-over on another computer, on the plan before this computer's word.
    const scratch = tempDir("taken-over");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
    const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
    plan.version += 1;
    plan.plan_repo = { name: "billing", address: billing };
    git(scratch, ["read-tree", "refs/tip"]);
    git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
    const over = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"]);
    git(scratch, ["push", "-q", billing, `${over}:${ref}`]);
    // This computer's word, written at the old place before it stopped taking pushes.
    ADDED(home.dir);
    expect(share(home.dir).json?.notice).toBe("The plan in checkout-api has ledger-sync now.");
    refuse(api);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toStartWith(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${billing}); this computer writes it there now.`);
    expect(git(billing, ["rev-parse", ref])).toBe(over);
    expect(homeOf(home.dir)).toBe(billing);
  });

  for (const there of ["a copy of the plan", "nothing"] as const) {
    test(`its old place not reached, the new place holding ${there}: the plan is written there from what this computer and the copy have, and the lead hears what to do`, () => {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      const api = home.hosts["checkout-api"];
      const billing = home.hosts.billing;
      if (there === "a copy of the plan") git(api, ["push", "-q", "--mirror", billing]);
      const tip = git(api, ["rev-parse", ref]);
      renameSync(api, `${api}-gone`);
      const moved = moveTo(home.dir, "billing");
      expect(moved.status, moved.out).toBe(0);
      const said = String(moved.json?.notice);
      expect(said).toStartWith("The plan is in billing now, with what you decided on each Unit as this computer last had it. checkout-api could not " +
        "be reached (git says \"");
      expect(said).toContain("\"), so nothing was written there and checkout-api does not say where the plan went. Give billing's address to everyone who takes a Unit: " +
        "until their AI-DLC has it, their builds look for the plan in checkout-api. Its earlier versions are readable in billing. Everyone who takes a Unit needs " +
        `read access to billing; AI-DLC sends no notice of the move. billing's address: ${billing}`);
      expect(planAt(billing, ref).plan_repo).toEqual({ name: "billing", address: billing });
      expect(git(billing, ["rev-parse", `${ref}^`])).toBe(tip);
      expect(homeOf(home.dir)).toBe(billing);
      renameSync(`${api}-gone`, api);
      expect(git(api, ["rev-parse", ref])).toBe(tip);
    });
  }

  test("a mirror synced again after the move, its note over the plan there: the lead's look and share end at the offer to share it again, and a move back puts it right", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    git(api, ["push", "-q", "--mirror", billing]);
    expect(moveTo(home.dir, "billing").status).toBe(0);
    // The person's mirror job runs again: the old place's tip, the note, lands over the plan.
    git(api, ["push", "-q", "--mirror", billing]);
    const looked = JSON.stringify(next(home.dir));
    ADDED(home.dir);
    const shared = share(home.dir);
    const offer = String(shared.json?.notice ?? shared.json?.error);
    expect(offer, shared.out).toContain("says it moved, but billing does not hold it");
    expect(offer).toMatch(/I can share the plan again in (billing|checkout-api)/);
    expect(looked).not.toContain("Cannot ");
    const back = moveTo(home.dir, "checkout-api");
    expect(back.status, back.out).toBe(0);
    expect(planAt(api, ref).plan_repo.name).toBe("checkout-api");
  });

  test("its old place not reached, the new place holding something else: nothing is moved, and the line says what is there", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const scratch = tempDir("something-else");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "someone"]);
    git(scratch, ["config", "user.email", "someone@example.test"]);
    writeFileSync(join(scratch, "README.md"), "not a plan\n");
    git(scratch, ["add", "README.md"]);
    git(scratch, ["commit", "-q", "-m", "not a plan"]);
    git(scratch, ["push", "-q", home.hosts.billing, `HEAD:${ref}`]);
    renameSync(api, `${api}-gone`);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).not.toBe(0);
    expect(moved.json?.error).toBe("billing already holds something else where the plan would go, so nothing was moved: the plan stays in checkout-api.");
    expect(homeOf(home.dir)).toBe(api);
  });

  test("the plan's repository archived: a later share is refused with the move offered, and the move keeps the plan at the new place", () => {
    const home = makePlanHome();
    const api = home.hosts["checkout-api"];
    refuse(api);
    ADDED(home.dir);
    // A refusal that may be on the message asks for the person's own first; with it, the same refusal is the end of
    // that way, and the way on is another repository, never the same question again.
    const asked = run(UNIT, ["share", "--plan"], home.dir);
    expect(String(asked.json?.notice), asked.out).toContain("If it is the commit message, tell me the one to use, and I will share it with that. If not, I can put the plan on a branch there instead,");
    const file = /write it to (\S+) with your file tool/.exec(String(asked.json?.step))?.[1] ?? "";
    mkdirSync(dirname(join(home.dir, ...file.split("/"))), { recursive: true });
    writeFileSync(join(home.dir, ...file.split("/")), "ABC-1 share the plan\n");
    const refused = run(UNIT, ["share", "--plan", "--commit-message-file", file], home.dir);
    expect(String(refused.json?.error), refused.out).toMatch(/^checkout-api did not take the plan: .+\. Say when to try again, or name another repository everyone who takes a Unit can read\.$/);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toContain("so nothing was written there and checkout-api does not say where the plan went. Give billing's address to everyone who takes a Unit");
    expect(String(moved.json?.notice)).not.toContain("the plan stays in checkout-api");
    expect(homeOf(home.dir)).toBe(home.hosts.billing);
  });

  // A word is for one take, as the commands write it: generation 1 is the take both plans know.
  // The lead's carry, run as the agent runs it after the person's reply: the
  // question about the take-over this computer did not write answered keep on the way.
  const carryRun = (dir: string, chat: string, said: string, args: string[]) => {
    expect(hook(dir, personsChat(chat), { hook_event_name: "UserPromptSubmit", session_id: chat, prompt: said }).status).toBe(0);
    let carried = run(UNIT, ["share", "--plan", ...args], dir, personsChat(chat));
    if (carried.json?.ask_type === "lead-plan-change") {
      const keep = (carried.json?.choices as Array<{ label: string; command: string }>)[0].command;
      expect(run(UNIT, ["plan-change", "keep", "--tip", /--tip (\S+)/.exec(keep)![1]], dir).status).toBe(0);
      carried = run(UNIT, ["share", "--plan", ...args], dir, personsChat(chat));
    }
    expect(carried.status, carried.out).toBe(0);
    return carried;
  };

  for (const later of [false, true] as const) {
    test(`the lead's other computer whose words the plan taken over lacks${later ? ", one Unit taken again there" : ""}: one line lists them and asks which stands where the plan there says otherwise, a plain ask works it out again, and each answer writes what it names`, () => {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      const api = home.hosts["checkout-api"];
      const billing = home.hosts.billing;
      git(api, ["push", "-q", "--mirror", billing]);
      // The take-over on another computer, with words of its own: a sign-off of reporting, a turn-down of refunds.
      const scratch = tempDir("taken-over");
      git(scratch, ["init", "-q"]);
      git(scratch, ["config", "user.name", "lead"]);
      git(scratch, ["config", "user.email", "lead@example.test"]);
      git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
      const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
      plan.version += 1;
      plan.plan_repo = { name: "billing", address: billing };
      plan.units.find((unit) => unit.name === "reporting")!.word = { generation: 1, signoff: { words: "fine by me", at: "2026-11-16T01:00:00Z" } };
      plan.units.find((unit) => unit.name === "refunds")!.word = {
        generation: 1, turned_down: { repo: "billing", heads: { billing: "1".repeat(40) }, words: "not yet", at: "2026-11-16T01:01:00Z" },
      };
      // Taken again there: this computer's words on its earlier take are no one's now.
      if (later) plan.units.find((unit) => unit.name === "checkout-ui")!.word = { generation: 2 };
      git(scratch, ["read-tree", "refs/tip"]);
      git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
      const over = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"]);
      git(scratch, ["push", "-q", billing, `${over}:${ref}`]);
      // This computer's words, on the old place before it stopped taking pushes.
      const counted = { repo: "checkout-web", words: "merged by hand", at: "2026-11-17T01:13:00Z" };
      writeOnTip(api, home.id8, (old) => {
        old.version += 1;
        old.units.find((unit) => unit.name === "refunds")!.word = { generation: 1, signoff: { words: "looks right", at: "2026-11-12T01:10:00Z" } };
        old.units.find((unit) => unit.name === "reporting")!.word = {
          generation: 1, turned_down: { repo: "billing", heads: { billing: "0".repeat(40) }, words: "the totals are wrong", at: "2026-11-12T01:11:00Z" },
          said_merged: [counted],
        };
        old.units.find((unit) => unit.name === "checkout-ui")!.word = {
          generation: 1, said_merged: [{ repo: "checkout-web", words: "merged by hand", at: "2026-11-17T01:12:00Z" }],
        };
      });
      keepTheirChange(home.dir);
      refuse(api);
      const moved = moveTo(home.dir, "billing");
      expect(moved.status, moved.out).toBe(0);
      // Where the plan there says otherwise, its own sentence with each word's day as recorded, and the Unit is left; its other words are said on it.
      const refundsAsked = "has refunds turned down in billing (16 Nov), and this computer has your sign-off of it from 12 Nov: say which stands.";
      const reportingAsked = "The plan there has reporting signed off (16 Nov), and this computer has your turn-down of it in billing from 12 Nov: say which stands";
      const questions = `The plan ${later ? "in billing" : "there"} ${refundsAsked} ${reportingAsked}, and either way I will write your count of ` +
        "reporting as merged in checkout-web there as you gave it.";
      expect(String(moved.json?.notice)).toBe(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${billing}); this computer writes it there ` +
        `now. ${later ? "" : "This is not on the plan in billing: your count of checkout-ui as merged in checkout-web. I have it as you gave it: say " +
          "if you want it written there. "}${questions}`);
      const step = String(moved.json?.step);
      expect(step).toContain("`--stands refunds=here` if they say this computer's word on refunds stands, `--stands refunds=plan` if the plan's does");
      expect(step).toContain("answers for several Units go after one --stands, joined by commas");
      if (later) expect(step).not.toContain("--carry-words");
      else expect(step).toContain("`--carry-words` if they say yes to the words it lists");
      expect(git(billing, ["rev-parse", ref])).toBe(over);
      const word = (name: string) => planAt(billing, ref).units.find((unit) => unit.name === name)?.word as Record<string, unknown>;
      const [refundsThere, reportingThere] = [JSON.stringify(word("refunds")), JSON.stringify(word("reporting"))];
      // A plain ask before any answer: the list's word goes on, never the reply, and the same sentences are said again.
      const chat = `t-plan-ref-words-yes-${later}`;
      const asked = carryRun(home.dir, chat, "yes", ["--carry-words"]);
      expect(asked.json?.notice).toBe(`${later ? "" : "The plan in billing has your count of checkout-ui as merged in checkout-web now, as you gave it. "}${questions}`);
      // Nothing the plan there holds is written over: byte for byte as it was.
      expect(JSON.stringify(word("refunds"))).toBe(refundsThere);
      expect(JSON.stringify(word("reporting"))).toBe(reportingThere);
      if (later) expect(word("checkout-ui")).toEqual({ generation: 2 });
      else {
        expect(word("checkout-ui")).toMatchObject({ generation: 1, said_merged: [{ words: "merged by hand" }] });
        // The plan commit names what it carries and from where.
        expect(git(billing, ["log", "-1", "--format=%s", ref])).toEndWith(": count of checkout-ui as merged in checkout-web carried over from checkout-api");
      }
      // The answers: this computer's sign-off of refunds stands, and the plan's sign-off of reporting; reporting's count goes on either way.
      const answered = carryRun(home.dir, chat, "my sign-off of refunds stands, and the sign-off of reporting there", ["--stands", "refunds=here,reporting=plan"]);
      expect(answered.json?.notice).toBe("The plan in billing has your sign-off of refunds and your count of reporting as merged in checkout-web now, as " +
        "you gave them. The plan in billing still has reporting signed off.");
      expect(word("refunds")).toEqual({ generation: 1, signoff: { words: "looks right", at: "2026-11-12T01:10:00Z" } });
      expect(word("reporting")).toEqual({ ...JSON.parse(reportingThere), said_merged: [counted] });
      expect(git(billing, ["log", "-1", "--format=%s", ref])).toEndWith(": sign-off of refunds and count of reporting as merged in checkout-web carried over " +
        "from checkout-api");
      // A later plain ask: refunds, where this computer's word now stands there, is not asked again; the plan's own word kept is not
      // remembered, so reporting's sentence is said again, answered the same way (the named limit).
      expect(carryRun(home.dir, chat, "carry my words over", ["--carry-words"]).json?.notice).toBe("The plan in billing has reporting signed off (16 Nov), " +
        "and this computer has your turn-down of it in billing from 12 Nov: say which stands.");
      expect(JSON.stringify(planAt(billing, ref).units.map((unit) => unit.word))).not.toMatch(/"words":"(yes|carry my words over|my sign-off of refunds stands, and the sign-off of reporting there)"/);
    });
  }

  test("the carry writes only what the plan there lacks, of every kind; one answer on a Unit with two questions writes both, and the line names each", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    git(api, ["push", "-q", "--mirror", billing]);
    const scratch = tempDir("taken-over");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
    const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
    plan.version += 1;
    plan.plan_repo = { name: "billing", address: billing };
    const input = plan.inputs[0].path;
    // Words of its own there: refunds turned down and the other answer to the same proposal, the send-back in other words, a word of an older take.
    plan.units.find((unit) => unit.name === "refunds")!.word = {
      generation: 1, turned_down: { repo: "billing", heads: { billing: "1".repeat(40) }, words: "not yet", at: "2026-11-16T01:01:00Z" },
      answers: [{ input, at: "2026-11-17T01:20:00Z", answer: "turned down", words: "no" }],
    };
    plan.units.find((unit) => unit.name === "reporting")!.word = {
      generation: 1, turned_down: { repo: "", from: "build-and-test", heads: {}, words: "it does not build", at: "2026-11-16T01:02:00Z" },
    };
    plan.units.find((unit) => unit.name === "checkout-ui")!.word = { generation: 1, signoff: { words: "fine", at: "2026-11-17T01:03:00Z" } };
    git(scratch, ["read-tree", "refs/tip"]);
    const there = (name: string) => JSON.stringify(plan.units.find((unit) => unit.name === name)?.word);
    const [refundsThere, reportingThere] = [there("refunds"), there("reporting")];
    git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
    const over = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"]);
    git(scratch, ["push", "-q", billing, `${over}:${ref}`]);
    // This computer's words of every kind, on the old place before it stopped taking pushes.
    const text = "# The approved text\n\nAs the lead approved it.\n";
    const blob = spawnSync("git", ["hash-object", "--stdin"], { cwd: scratch, input: text, encoding: "utf-8" }).stdout.trim();
    const approved = { input, at: "2026-11-17T01:20:00Z", answer: "approved" as const, words: "yes, take it" };
    const counted = { repo: "checkout-api", words: "merged by hand", at: "2026-11-17T01:25:00Z" };
    writeOnTip(api, home.id8, (old) => {
      old.version += 1;
      // Two questions on refunds, and a count of its own that goes with either answer.
      old.units.find((unit) => unit.name === "refunds")!.word = {
        generation: 1, signoff: { words: "looks right", at: "2026-11-12T01:19:00Z" }, answers: [approved],
        amendments: [{ input, at: "2026-11-17T01:20:00Z", words: "yes, take it", blob }], said_merged: [counted],
      };
      // checkout-ui was taken again here (generation 2): its word starts a word of that take there.
      old.units.find((unit) => unit.name === "checkout-ui")!.word = {
        generation: 2, open_again: { at: "2026-11-17T01:21:00Z" },
        turned_down: { repo: "checkout-web", heads: { "checkout-web": "2".repeat(40) }, words: "the button is gone", at: "2026-11-17T01:22:00Z" },
        answers: [{ input, at: "2026-11-17T01:23:00Z", answer: "approved", words: "fine" }],
        amendments: [{ input, at: "2026-11-17T01:23:00Z", words: "fine", blob }],
      };
      // The same send-back there in other words: offered, the plan as it is the default.
      old.units.find((unit) => unit.name === "reporting")!.word = {
        generation: 1, turned_down: { repo: "", from: "build-and-test", heads: {}, words: "the totals fail the build", at: "2026-11-12T01:22:00Z" },
        said_merged: [{ repo: "billing", words: "merged by hand", at: "2026-11-17T01:24:00Z" }],
      };
    }, { [`inputs/${input}`]: text });
    keepTheirChange(home.dir);
    refuse(api);
    const name = inputName(input);
    const them = name.endsWith("s") ? "them" : "it";
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    // An answer's time is its proposal's, not the day of the lead's word: said without a day.
    const refundsAsked = "The plan there has refunds turned down in billing (16 Nov), and this computer has your sign-off of it from 12 Nov: say which " +
      `stands. The plan there has refunds's change to the ${name} turned down, and this computer has your approval of it: say which stands, and ` +
      "either way I will write your count of refunds as merged in checkout-api there as you gave it.";
    const questions = `${refundsAsked} The plan there has reporting sent back from Build and Test (16 Nov) too, worded differently. I have your ` +
      "send-back of it from 12 Nov as you gave it: say if you want it written there in its place.";
    expect(String(moved.json?.notice)).toEndWith(`These are not on the plan in billing: your turn-down of checkout-ui in checkout-web, your approval ` +
      `of checkout-ui's change to the ${name}, the ${name} as you approved ${them} for checkout-ui, your opening of checkout-ui again, your count ` +
      `of reporting as merged in billing. I have them as you gave them: say if you want them written there. ${questions}`);
    expect(String(moved.json?.step)).toContain("`--stands reporting=here` if they want this computer's word on reporting written in place of the plan's");
    // The list's yes and the plan's send-back kept, in one command: each written word named, what the plan still has, and only the
    // question left unanswered said again.
    const carried = carryRun(home.dir, "t-plan-ref-words-yes-kinds", "yes, and keep the send-back there", ["--carry-words", "--stands", "reporting=plan"]);
    expect(carried.json?.notice).toBe(`The plan in billing has your turn-down of checkout-ui in checkout-web, your approval of checkout-ui's change to ` +
      `the ${name}, the ${name} as you approved ${them} for checkout-ui, your opening of checkout-ui again and your count of reporting as merged in ` +
      `billing now, as you gave them. The plan in billing still has reporting sent back from Build and Test. ${refundsAsked}`);
    const word = (unit: string) => planAt(billing, ref).units.find((entry) => entry.name === unit)?.word as Record<string, unknown>;
    // What the plan there held is left byte for byte: the Unit with questions whole, the send-back kept.
    expect(JSON.stringify(word("refunds"))).toBe(refundsThere);
    expect(JSON.stringify({ ...word("reporting"), said_merged: undefined })).toBe(reportingThere);
    expect(word("checkout-ui")).toEqual({
      generation: 2, open_again: { at: "2026-11-17T01:21:00Z" },
      turned_down: { repo: "checkout-web", heads: { "checkout-web": "2".repeat(40) }, words: "the button is gone", at: "2026-11-17T01:22:00Z" },
      answers: [{ input, at: "2026-11-17T01:23:00Z", answer: "approved", words: "fine" }],
      amendments: [{ input, at: "2026-11-17T01:23:00Z", words: "fine", blob }],
    });
    expect(word("reporting").said_merged).toEqual([{ repo: "billing", words: "merged by hand", at: "2026-11-17T01:24:00Z" }]);
    // The approved text goes with its file and fingerprint.
    expect(git(billing, ["show", `${ref}:inputs/${input}`])).toBe(text.trimEnd());
    expect(planAt(billing, ref).inputs.find((entry) => entry.path === input)?.fingerprint).toBe(textFingerprint(text));
    expect(git(billing, ["log", "-1", "--format=%s", ref])).toEndWith(`: turn-down of checkout-ui in checkout-web, approval of checkout-ui's ` +
      `change to the ${name}, approved ${name} for checkout-ui and 2 more carried over from checkout-api`);
    // One answer on refunds decides both its questions; the line names each word written, so neither passes silently. The send-back kept
    // before is not remembered: asked again, it is written now.
    const stood = carryRun(home.dir, "t-plan-ref-words-stands-kinds", "mine stands on refunds, and write the send-back there",
      ["--stands", "refunds=here,reporting=here"]);
    expect(stood.json?.notice).toBe(`The plan in billing has your sign-off of refunds, your approval of refunds's change to the ${name}, the ${name} ` +
      `as you approved ${them} for refunds, your count of refunds as merged in checkout-api and your send-back of reporting from Build and Test ` +
      "now, as you gave them.");
    expect(word("refunds")).toEqual({
      generation: 1, signoff: { words: "looks right", at: "2026-11-12T01:19:00Z" }, answers: [approved],
      amendments: [{ input, at: "2026-11-17T01:20:00Z", words: "yes, take it", blob }], said_merged: [counted],
    });
    expect((word("reporting").turned_down as { words: string }).words).toBe("the totals fail the build");
    expect(git(billing, ["log", "-1", "--format=%s", ref])).toEndWith(`: sign-off of refunds, approval of refunds's change to the ${name}, ` +
      `approved ${name} for refunds and 2 more carried over from checkout-api`);
    // Answered: a later look and a later share say neither the sentences nor the offer again, and a plain ask finds nothing left.
    const later = `${JSON.stringify(next(home.dir))} ${String(share(home.dir).json?.notice)}`;
    expect(later).not.toContain("say which stands");
    expect(later).not.toContain("in its place");
    // A plain ask that finds nothing of the lead's left still says what the share itself wrote.
    ADDED(home.dir);
    expect(carryRun(home.dir, "t-plan-ref-words-added-kinds", "carry my words over", ["--carry-words"]).json?.notice)
      .toBe("The plan in billing has ledger-sync now.");
    expect(carryRun(home.dir, "t-plan-ref-words-again-kinds", "carry my words over", ["--carry-words"]).json?.notice)
      .toBe("The plan in billing already has everything here.");
    expect(JSON.stringify(planAt(billing, ref).units.map((unit) => unit.word))).not.toMatch(/"words":"(yes|mine stands on refunds, and write the send-back there|carry my words over)"/);
  });

  test("a team's result the lead signed off at the old place, then the move and the yes: the lead's look reads that take signed off and counts it done", () => {
    const { home, hosts, alice, record } = refundsTaken();
    const ref = planRefOf(home.id8);
    const [api, billing] = [hosts["checkout-api"], hosts.billing];
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    codeGenerated(alice, record);
    const pushed = run(UNIT, ["push"], alice);
    expect(pushed.status, pushed.out).toBe(0);
    // The take-over on another computer, from a copy of the plan made before the lead's sign-off (billing keeps its own code).
    git(api, ["push", "-q", billing, `${ref}:${ref}`]);
    const scratch = tempDir("taken-over");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
    const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
    plan.version += 1;
    plan.plan_repo = { name: "billing", address: billing };
    git(scratch, ["read-tree", "refs/tip"]);
    git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
    git(scratch, ["push", "-q", billing, `${git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"])}:${ref}`]);
    // The lead's sign-off on this computer, at the old place, by its own command.
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "looks right"], home.dir);
    expect(signed.status, signed.out).toBe(0);
    // The team's result merged in both repositories, before the old place stops taking pushes.
    mergeOnHost(api, "refunds", "squash");
    mergeOnHost(billing, "refunds", "squash");
    refuse(api);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toEndWith("This is not on the plan in billing: your sign-off of refunds. I have it as you gave it: say if you " +
      "want it written there.");
    const chat = "t-plan-ref-words-yes-take";
    expect(hook(home.dir, personsChat(chat), { hook_event_name: "UserPromptSubmit", session_id: chat, prompt: "yes" }).status).toBe(0);
    const carried = run(UNIT, ["share", "--plan", "--carry-words"], home.dir, personsChat(chat));
    expect(carried.json?.notice, carried.out).toBe("The plan in billing has your sign-off of refunds now, as you gave it.");
    // The lead's look counts the merged result done only on a sign-off of that take.
    next(home.dir);
    expect(planAt(billing, ref).units.find((unit) => unit.name === "refunds")?.word).toMatchObject({ done: true, signoff: { words: "looks right" } });
  });

  test("the plan's repositories as the lead's workspace spells them now, not as the copy has them", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    writeOnTip(api, home.id8, (plan) => {
      plan.repos = (plan.repos as Array<{ name: string; address: string | null }>)
        .map((repo) => repo.name === "checkout-web" ? { ...repo, address: "/nowhere/checkout-web.git" } : repo);
    });
    keepTheirChange(home.dir);
    git(api, ["push", "-q", "--mirror", home.hosts.billing]);
    refuse(api);
    expect(moveTo(home.dir, "billing").status).toBe(0);
    const web = (planAt(home.hosts.billing, ref).repos as Array<{ name: string; address: string | null }>).find((repo) => repo.name === "checkout-web");
    expect(web?.address).toBe(home.hosts["checkout-web"]);
  });

  // A symlink stands for one repository under a second spelling, which Windows
  // makes only with a privilege.
  test.skipIf(process.platform === "win32")("one repository under two names: the write there is taken back, and the plan stays as the teams read it", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const alias = `${api}-alias`;
    symlinkSync(api, alias);
    const repos = JSON.parse(readFileSync(join(home.dir, "repos.json"), "utf-8"));
    repos.repos.push({ name: "checkout-api-alias", url: alias });
    writeFileSync(join(home.dir, "repos.json"), `${JSON.stringify(repos, null, 2)}\n`);
    const tip = git(api, ["rev-parse", ref]);
    const moved = moveTo(home.dir, "checkout-api-alias");
    expect(moved.status, moved.out).not.toBe(0);
    expect(moved.json?.error).toBe("checkout-api-alias is the same repository as checkout-api under another name, so the plan stays in checkout-api.");
    expect(git(api, ["rev-parse", ref])).toBe(tip);
    expect(planAt(api, ref).plan_repo.name).toBe("checkout-api");
    expect(homeOf(home.dir)).toBe(api);
  });

  test("the lead's other computer after a take-over: its move follows the plan where it is now, writes nothing over it, and says so once", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    git(api, ["push", "-q", "--mirror", billing]);
    // The take-over, made on the lead's first computer, then a word written there.
    const scratch = tempDir("taken-over");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
    const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
    plan.version += 1;
    plan.plan_repo = { name: "billing", address: billing };
    git(scratch, ["read-tree", "refs/tip"]);
    git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
    const over = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"]);
    git(scratch, ["push", "-q", billing, `${over}:${ref}`]);
    const word = writeOnTip(billing, home.id8, (later) => {
      later.version += 1;
      later.units[0].word = { done: true };
    });
    const tip = git(api, ["rev-parse", ref]);
    refuse(api);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toStartWith(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${billing}); this computer writes it there now.`);
    expect(git(billing, ["rev-parse", ref])).toBe(word);
    expect(git(api, ["rev-parse", ref])).toBe(tip);
    expect(homeOf(home.dir)).toBe(billing);
  });

  test("the lead's other computer after a take-over, the old host gone: its move follows the plan where it is now and writes nothing over it", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    const api = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    git(api, ["push", "-q", "--mirror", billing]);
    const scratch = tempDir("taken-over");
    git(scratch, ["init", "-q"]);
    git(scratch, ["config", "user.name", "lead"]);
    git(scratch, ["config", "user.email", "lead@example.test"]);
    git(scratch, ["fetch", "-q", billing, `${ref}:refs/tip`]);
    const plan = JSON.parse(git(scratch, ["show", "refs/tip:plan.json"])) as Plan;
    plan.version += 1;
    plan.plan_repo = { name: "billing", address: billing };
    git(scratch, ["read-tree", "refs/tip"]);
    git(scratch, ["update-index", "--cacheinfo", `100644,${spawnHash(scratch, `${JSON.stringify(plan, null, 2)}\n`)},plan.json`]);
    const over = git(scratch, ["commit-tree", git(scratch, ["write-tree"]), "-p", "refs/tip", "-m", "taken over"]);
    git(scratch, ["push", "-q", billing, `${over}:${ref}`]);
    renameSync(api, `${api}-gone`);
    const moved = moveTo(home.dir, "billing");
    expect(moved.status, moved.out).toBe(0);
    expect(String(moved.json?.notice)).toStartWith(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${billing}); this computer writes it there now.`);
    expect(git(billing, ["rev-parse", ref])).toBe(over);
    expect(homeOf(home.dir)).toBe(billing);
  });
});

describe("what the lead reads", () => {
  const ADDED = (dir: string): void => {
    const path = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    writeFileSync(path, DEPENDENCIES.replace("```\n", "  - name: ledger-sync\n    kind: service\n    repos: [billing]\n    depends_on: []\n```\n"));
  };
  const isShare = (step: Record<string, unknown>): boolean =>
    step.kind === "ask" && ((step.handovers ?? []) as string[]).includes("share");

  test("every step at the lead's work tells the agent that the person saying the plan is in another repository now is the move there; main's team work does not", () => {
    const sentence = "When the person says the plan is in another repository now, that is the move to it on this computer: run ";
    const home = makePlanHome();
    const step = next(home.dir);
    expect(String(step.board_note), JSON.stringify(step).slice(0, 600)).toContain(sentence);
    expect(String(step.board_note)).toContain(" unit share --plan --repo <that repository>`.");
    const main = makeHome();
    expect(run(STATE, ["set-unit-ownership", "team"], main.dir).status).toBe(0);
    expect(JSON.stringify(next(main.dir))).not.toContain(sentence);
  });

  test("the share question names where the plan goes, each Unit's repositories and who can read it; Share the plan or Not now", () => {
    const home = makePlanHome({ share: false });
    const ask = next(home.dir);
    expect(isShare(ask), JSON.stringify(ask)).toBe(true);
    expect(String(ask.question)).toMatch(new RegExp(
      "^Do you want me to share the plan\\? I'd put it in checkout-api: the Units " +
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
      "The plan is shared in checkout-api. AI-DLC sends no notice of it, so tell whoever will take a Unit. Anyone whose workspace has " +
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
    keepTheirChange(home.dir);
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
      "repository everyone who takes a Unit can read, and I'll share it there.";
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
      /^checkout-api did not take the plan: .+\. Say when to try again, or name another repository everyone who takes a Unit can read\.$/,
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
    expect(String(refused.json?.notice)).toContain("If it is the commit message, tell me the one to use, and I will share it with that. If not, I can put the plan on a branch there instead,");
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
    keepTheirChange(home.dir);
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
    // A plan of a newer AI-DLC: the update step, and nothing written over it.
    expect(String(run(UNIT, ["share", "--plan"], home.dir).json?.error)).toStartWith("This plan was set up with a newer AI-DLC");
    expect(git(host, ["rev-parse", ref])).toBe(newer);
  });

  test("the lead's other computer after a move: its share follows the pointer, writes where the plan is now, says so once, and never writes over the pointer", () => {
    const home = makePlanHome();
    const ref = planRefOf(home.id8);
    movedByHand(home, "checkout-api", "billing");
    const note = git(home.hosts["checkout-api"], ["rev-parse", ref]);
    ADDED(home.dir);
    // The move's own commit holds nobody's decision, so nothing is asked: the share goes there, with the move said once.
    expect(share(home.dir).json?.notice).toBe(
      `The plan of ${registryOf(home.dir)[0].slug} moved to billing (${home.hosts.billing}); this computer writes it there now. ` +
        "The plan in billing has ledger-sync now.",
    );
    expect(planAt(home.hosts.billing, ref).units.map((unit) => unit.name)).toContain("ledger-sync");
    expect(git(home.hosts["checkout-api"], ["rev-parse", ref])).toBe(note);
    expect(readFileSync(seededStateFile(home.dir), "utf-8")).toContain(`- **Home Location**: ${home.hosts.billing}`);
  });

  test("the lead's other computer after a move: its look follows the note, says so once, and puts no share question on the note", () => {
    const home = makePlanHome();
    movedByHand(home, "checkout-api", "billing");
    // The look fetches the plan, as the lead's look does.
    git(home.dir, ["fetch", "-q", home.hosts["checkout-api"], `+${planRefOf(home.id8)}:${git(home.dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home"]).split("\n")[0]}`]);
    const look = next(home.dir);
    expect(String(look.question ?? ""), JSON.stringify(look).slice(0, 600)).not.toStartWith("Do you want me to share the plan?");
    expect((look.change_notices ?? []) as string[], JSON.stringify(look).slice(0, 600))
      .toContain(`The plan of ${registryOf(home.dir)[0].slug} moved to billing (${home.hosts.billing}); this computer writes it there now.`);
    expect(readFileSync(seededStateFile(home.dir), "utf-8")).toContain(`- **Home Location**: ${home.hosts.billing}`);
    expect(JSON.stringify(next(home.dir))).not.toContain("this computer writes it there now");
  });

  // A note the share cannot follow: the way on is the share again where the note
  // says when that place holds nothing (the plan deleted there), else on top of
  // the note where it is.
  for (const holds of ["nothing", "other"] as const) {
    test(`a note whose new place holds ${holds === "nothing" ? "no plan" : "something else"}: the share says so with its way on, and its yes shares ${holds === "nothing" ? "there" : "on top of the note"}`, () => {
      const home = makePlanHome();
      const ref = planRefOf(home.id8);
      const decided = writeOnTip(home.hosts["checkout-api"], home.id8, (plan) => {
        plan.version = 2;
        plan.units[0].word = { done: true };
      });
      keepTheirChange(home.dir);
      movedByHand(home, "checkout-api", "billing");
      if (holds === "nothing") git(home.hosts.billing, ["update-ref", "-d", ref]);
      else writeOnTip(home.hosts.billing, home.id8, (plan) => { plan.plan_repo = { name: "checkout-web", address: home.hosts["checkout-web"] }; });
      const note = git(home.hosts["checkout-api"], ["rev-parse", ref]);
      const asked = share(home.dir);
      expect(asked.json?.shared).toBe(false);
      expect(asked.json?.notice).toBe(`The plan of ${registryOf(home.dir)[0].slug} says it moved, but billing does not hold it, so the plan is not shared. ` +
        (holds === "nothing" ? "I can share the plan again in billing from your own record here: say if you want that."
          : "I can share the plan again in checkout-api, over the note that it moved, from your own record here: say if you want that."));
      expect(git(home.hosts["checkout-api"], ["rev-parse", ref])).toBe(note);
      const yes = /`[^`]* unit share (--plan --repo \S+)`/.exec(String(asked.json?.step))?.[1].split(" ");
      expect(yes, String(asked.json?.step)).toEqual(["--plan", "--repo", holds === "nothing" ? "billing" : "checkout-api"]);
      const again = run(UNIT, ["share", ...yes!], home.dir);
      if (holds === "nothing") {
        expect(again.json?.notice, again.out).toBe("The plan was no longer in billing, so I shared it again, with what was decided on each Unit " +
          "as the plan had it when it moved.");
        expect(git(home.hosts.billing, ["rev-parse", `${ref}^`])).toBe(decided);
        expect(planAt(home.hosts.billing, ref).units[0].word).toEqual({ done: true });
        expect(git(home.hosts["checkout-api"], ["rev-parse", ref])).toBe(note);
      } else {
        expect(again.json?.notice, again.out).toBe("The plan is shared again in checkout-api, over the note that it moved, with what was decided " +
          "on each Unit as the plan had it when it moved.");
        expect(git(home.hosts["checkout-api"], ["rev-parse", `${ref}^`])).toBe(note);
        expect(planAt(home.hosts["checkout-api"], ref).units[0].word).toEqual({ done: true });
      }
    });
  }

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
    expect(String(ask.question)).toStartWith("Do you want me to share the plan?");
    share(home.dir);
    const parked = run(ORCH, ["park"], home.dir);
    expect(parked.status, parked.out).toBe(0);
    expect(parked.out).not.toContain("aidlc/ is committed");
    expect(parked.out).not.toContain("teammates see");
  });
});

describe("at the lead's own work whose plan is its own ref, the lines that named main's share", () => {
  const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: name });
  const said = (step: Record<string, unknown>): string[] =>
    ((step.change_notices ?? []) as string[]).filter((line) => line.includes("thin slice first"));
  // The plan shared with a thin slice first, then the lead's answer here turned to none: the plan still holds every
  // other Unit behind the first.
  function heldBack(dependencies?: string): { home: PlanHome; skeleton: string } {
    const home = makePlanHome({ state: homeState().replace("- **Skeleton Stance**: off", "- **Skeleton Stance**: on"), ...(dependencies === undefined ? {} : { dependencies }) });
    const skeleton = String(planAt(home.hosts["checkout-api"], planRefOf(home.id8)).skeleton ?? "");
    expect(skeleton).not.toBe("");
    const state = seededStateFile(home.dir);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- **Skeleton Stance**: on", "- **Skeleton Stance**: off"));
    return { home, skeleton };
  }

  test("the lead's next says once that the plan still has the earlier answer, read from the plan, and the share after the yes says the answer is on it", () => {
    const { home, skeleton } = heldBack();
    const step = next(home.dir, chat("lead-chat"));
    const line = said(step);
    expect(line.length, JSON.stringify(step).slice(0, 900)).toBe(1);
    expect(line[0]).toStartWith(`The plan in checkout-api still has your earlier answer about building a thin slice first, so every other Unit in it waits on ${skeleton}. I can share it again when you say so, or you can run \``);
    expect(line[0]).toEndWith(" unit share --plan`.");
    expect(said(next(home.dir, chat("lead-chat")))).toEqual([]);
    expect(share(home.dir).json?.notice).toBe(`The plan in checkout-api has your answer now: no Unit in it waits on ${skeleton}.`);
    expect(planAt(home.hosts["checkout-api"], planRefOf(home.id8)).skeleton).toBeNull();
    expect(said(next(home.dir, chat("lead-chat-2")))).toEqual([]);
  });

  test("after the yes, where another Unit of the plan still waits on that first Unit, the line says only that the answer is on the plan", () => {
    // The usual shape: the thin slice is built from the Unit another depends on.
    const { home, skeleton } = heldBack(DEPENDENCIES.replace("depends_on: [refunds]", "depends_on: [checkout-ui]"));
    expect(skeleton).toBe("checkout-ui");
    expect(said(next(home.dir, chat("lead-chat")))).toHaveLength(1);
    expect(share(home.dir).json?.notice).toBe("The plan in checkout-api has your answer now.");
    expect(planAt(home.hosts["checkout-api"], planRefOf(home.id8)).skeleton).toBeNull();
  });

  test("silent where the plan agrees with the answer here", () => {
    const home = makePlanHome();
    expect(said(next(home.dir, chat("lead-chat")))).toEqual([]);
  });

  test("a share without --plan on a branch of the lead's own says the plan was not shared by it, with the offer, and hands the agent the command for the yes", () => {
    const home = makePlanHomeWithRemote();
    git(home.dir, ["checkout", "-q", "-b", "my-work"]);
    writeFileSync(join(home.dir, "draft.txt"), "mine\n");
    const shared = run(UNIT, ["share"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const notice = String(shared.json?.notice);
    expect(notice).toStartWith("This checkout is on my-work, not main, so AI-DLC's record of this work is committed here and nothing is pushed. " +
      "The plan was not shared by this: I can share it in checkout-api when you say so, or you can run `");
    expect(notice).toEndWith(" unit share --plan`.");
    expect(String(shared.json?.step)).toMatch(/When they say yes, run `[^`]* unit share --plan`/);
  });

  test("a share without --plan on main itself commits and pushes only AI-DLC's record, never the person's other changes, and says the plan was not shared by it, with the offer", () => {
    const home = makePlanHomeWithRemote();
    writeFileSync(join(home.dir, "app.txt"), "one\n");
    git(home.dir, ["add", "app.txt"]);
    git(home.dir, ["commit", "-q", "-m", "app"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    writeFileSync(join(home.dir, "app.txt"), "two\n");
    writeFileSync(join(home.dir, "draft.txt"), "mine\n");
    const shared = run(UNIT, ["share"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    expect(shared.json?.shared).toBe(true);
    expect(shared.json?.committed_files).toBeUndefined();
    const notice = String(shared.json?.notice);
    expect(notice).toContain("The plan was not shared by this: I can share it in checkout-api when you say so, or you can run `");
    expect(notice).toEndWith(" unit share --plan`.");
    expect(String(shared.json?.step)).toMatch(/When they say yes, run `[^`]* unit share --plan`/);
    const status = git(home.dir, ["status", "--porcelain", "--", "app.txt", "draft.txt"]);
    expect(status).toMatch(/^ ?M app\.txt$/m);
    expect(status).toContain("?? draft.txt");
    expect(git(home.remote, ["show", "refs/heads/main:app.txt"])).toBe("one");
    expect(git(home.remote, ["ls-tree", "--name-only", "refs/heads/main", "--", "draft.txt"])).toBe("");
  });
});


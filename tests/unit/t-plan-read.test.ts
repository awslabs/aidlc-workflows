// covers: subcommand:aidlc-unit:take, function:lookAt, function:planAt, function:gitTargetFor, function:homeCopyOf, function:planSharedAtHome
//
// A team takes a Unit from the plan where the lead shared it: one fetch of the
// plan's own ref, by the address of the code repository it is in, with the
// person's own login, into a copy in the team's own workspace repository, one
// folder per repository read. Nothing of the lead's workspace is read, nothing
// is added to a code clone, no remote is added and no setting changes. The
// build records the plan's repository and the plan's commit, and copies the
// approved inputs as the plan holds them.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { asLeadsOwnCheckout } from "../harness/team-unit-merge.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeGenerated,
  codeHost,
  ENV,
  git,
  type Home,
  HOME_RECORD,
  hook,
  inSpace,
  makeHome,
  makePlanHome,
  makePlanHomeWithRemote,
  next,
  offerText,
  ORCH,
  type PlanHome,
  planRefOf,
  recordAt,
  run,
  sharePlan,
  STATE,
  teamWorkspace,
  tempDir,
  UNIT,
  UTILITY,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// The look and the copy names, read when a case calls them.
const tools = async () => ({
  ...(await import("../../dist/claude/.claude/tools/aidlc-unit.ts")),
  ...(await import("../../dist/claude/.claude/tools/aidlc-unit-holders.ts")),
  ...(await import("../../dist/claude/.claude/tools/aidlc-unit-teams.ts")),
});
const copyName = (address: string, id8: string): string => `refs/aidlc/home/${id8}/${repoCopyKey(address)}/plan`;

// What the shipped opencode plugin says of a command under a shell setting, as on `platform`: "" when it lets
// the command run, else its refusal.
async function openCodeSays(shell: string, platform: NodeJS.Platform, command: string): Promise<string> {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const { default: createAdapter } = await import("../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts");
    const client = { session: { get: async () => ({ data: {} }), prompt: async () => {} }, config: { get: async () => ({ data: { shell } }) } };
    const adapter = await createAdapter.server({ client: client as never, directory: mkdtempSync(join(tmpdir(), "aidlc-oc-")) } as never);
    const before = (adapter as Record<string, (a: unknown, b: unknown) => Promise<void>>)["tool.execute.before"];
    await before({ tool: "bash", sessionID: "plan-read", callID: "plan-read" }, { args: { command } });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    Object.defineProperty(process, "platform", { value: real });
  }
}

// What a code clone holds of git's own: its refs, its remotes and its settings.
function cloneState(dir: string): string {
  return createHash("sha256").update(git(dir, ["for-each-ref"]) + git(dir, ["config", "--list", "--local"])).digest("hex");
}

function buildDir(dir: string, unit: string): string {
  const intents = join(dir, "aidlc", "spaces", "default", "intents");
  return join(intents, readdirSync(intents).find((name) => name.endsWith(`-${unit}`))!);
}

const field = (state: string, name: string): string | null =>
  new RegExp(`^- \\*\\*${name}\\*\\*: (.*)$`, "m").exec(state)?.[1]?.trim() ?? null;

// The plan as shared, its plan.json edited as anyone who can push to a repository could, pushed on top of it at
// `host` (the plan's own repository unless named), dated later than any copy here.
function pushEditedPlan(home: PlanHome, edit: (json: Record<string, unknown>) => Record<string, unknown>, host = Object.values(home.hosts)[0]): string {
  const scratch = join(tempDir("edited"), "repo");
  git(tempDir("edited-parent"), ["clone", "-q", "--bare", Object.values(home.hosts)[0], scratch]);
  git(scratch, ["config", "user.name", "lead"]);
  git(scratch, ["config", "user.email", "lead@example.test"]);
  const json = JSON.parse(git(scratch, ["show", `${home.plan}:plan.json`])) as Record<string, unknown>;
  writeFileSync(join(scratch, "plan.json"), `${JSON.stringify(edit(json), null, 2)}\n`);
  const blob = git(scratch, ["hash-object", "-w", join(scratch, "plan.json")]);
  const index = { ...ENV, GIT_INDEX_FILE: join(scratch, "edited-index") };
  const at = (args: string[]): string => Bun.spawnSync({ cmd: ["git", ...args], cwd: scratch, env: index }).stdout.toString().trim();
  at(["read-tree", home.plan!]);
  at(["update-index", "--cacheinfo", `100644,${blob},plan.json`]);
  const later = { ...ENV, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2099-01-01T00:00:00Z" };
  const tree = at(["write-tree"]);
  const commit = Bun.spawnSync({ cmd: ["git", "commit-tree", tree, "-p", home.plan!, "-m", "edited"], cwd: scratch, env: later }).stdout.toString().trim();
  git(scratch, ["push", "-q", "--force", host, `${commit}:${planRefOf(home.id8)}`]);
  return commit;
}

// A plan.json written as one commit on `onto` at `host`'s plan ref, as anyone who can push there could: the plan's
// other files kept, or plan.json alone (a pointer's tree). Returns the commit.
function pushPlanJson(home: PlanHome, host: string, json: Record<string, unknown>, onto: string, files: "all" | "plan only", message: string): string {
  const from = home.hosts["checkout-api"];
  const scratch = join(tempDir("plan-json"), "repo");
  git(tempDir("plan-json-parent"), ["clone", "-q", "--bare", from, scratch]);
  git(scratch, ["config", "user.name", "lead"]);
  git(scratch, ["config", "user.email", "lead@example.test"]);
  // Every host's plan refs, so `onto` may be a commit only one of them has.
  for (const [i, each] of [...Object.values(home.hosts), host].entries()) git(scratch, ["fetch", "-q", each, `+refs/aidlc/*:refs/hosts/${i}/*`]);
  const env = { ...ENV, GIT_INDEX_FILE: join(scratch, "plan-json-index"), GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2099-01-01T00:00:00Z" };
  const at = (args: string[], input?: string): string =>
    Bun.spawnSync({ cmd: ["git", ...args], cwd: scratch, env, stdin: input === undefined ? undefined : Buffer.from(input) }).stdout.toString().trim();
  const blob = at(["hash-object", "-w", "--stdin"], `${JSON.stringify(json, null, 2)}\n`);
  at(files === "all" ? ["read-tree", onto] : ["read-tree", "--empty"]);
  at(["update-index", "--add", "--cacheinfo", `100644,${blob},plan.json`]);
  const commit = at(["commit-tree", at(["write-tree"]), "-p", onto, "-m", message]);
  expect(commit).toMatch(/^[0-9a-f]{40,64}$/);
  git(scratch, ["push", "-q", "--force", host, `${commit}:${planRefOf(home.id8)}`]);
  return commit;
}

// The lead's move, as the lead makes it: `unit share --plan --repo <to>`. Returns the plan's commit at `to`.
function movePlan(home: PlanHome, to: string): string {
  const moved = run(UNIT, ["share", "--plan", "--repo", to], home.dir);
  expect(moved.status, moved.out).toBe(0);
  return git(home.hosts[to], ["rev-parse", planRefOf(home.id8)]);
}

// A move as it would be with a note naming the new place by another spelling (`address`) than the host it is
// pushed to: the plan at `to` as one commit on the old tip, and at the old place a note on the old tip.
function movePlanByHand(home: PlanHome, to: string, address = home.hosts[to]): { moved: string; pointer: string } {
  const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
  const json = JSON.parse(git(home.hosts["checkout-api"], ["show", `${tip}:plan.json`])) as Record<string, unknown> & { version: number };
  const moved = pushPlanJson(home, home.hosts[to], { ...json, version: json.version + 1, plan_repo: { name: to, address } }, tip, "all", "aidlc plan fixture");
  const pointer = pushPlanJson(home, home.hosts["checkout-api"], { format: 1, work: json.work, moved_to: { name: to, address } }, tip, "plan only",
    `aidlc plan fixture: moved to ${to}`);
  return { moved, pointer };
}

describe("a team takes a Unit from the plan where it is shared", () => {
  test("one fetch of the plan's ref by its repository's address, kept in the team's own repository; no code clone, remote or setting changes", async () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const billingBefore = cloneState(join(pay, "billing"));
    const trace = join(tempDir("trace"), "trace.txt");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay, { ...ENV, GIT_TRACE: trace });
    expect(took.status, took.out).toBe(0);
    // The copy: the plan's own commit, in the folder of the repository read.
    const copy = `refs/aidlc/home/${home.id8}/${repoCopyKey(plan)}/plan`;
    expect(git(pay, ["rev-parse", copy])).toBe(home.plan!);
    expect((await tools()).homeCopyOf(copy)).toEqual({ id8: home.id8, key: repoCopyKey(plan), kind: "plan" });
    expect(git(pay, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${home.id8}/integration`])).toBe("");
    // One fetch of the plan, never ls-remote with a pattern, never the lead's branch: the only branches a look
    // reads are AI-DLC's own, the plan's and a record's, where a repository holds them as branches.
    const calls = readFileSync(trace, "utf-8").split(/\r?\n/).filter((line) => line.includes("trace: built-in: git ") || line.includes("trace: run_command: git"));
    expect(calls.filter((line) => / fetch .*refs\/aidlc\/plans\//.test(line))).toHaveLength(1);
    expect(calls.some((line) => / ls-remote .*refs\/aidlc\/\*/.test(line))).toBe(false);
    expect(calls.some((line) => / fetch .*refs\/heads\/(?!aidlc\/(?:claims|plans)\/)/.test(line))).toBe(false);
    // Nothing of AI-DLC's in the code clone, no remote here, no setting changed.
    expect(cloneState(join(pay, "billing"))).toBe(billingBefore);
    expect(git(join(pay, "billing"), ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
    expect(git(pay, ["remote"])).toBe("");
  });

  test("the build records the plan's repository and commit, no Home Record, and copies the inputs as the plan holds them", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    const record = buildDir(pay, "refunds");
    const state = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(field(state, "Home Location")).toBe(plan);
    expect(field(state, "Home Record")).toBeNull();
    const audit = readdirSync(join(record, "audit")).map((name) => readFileSync(join(record, "audit", name), "utf-8")).join("\n");
    const takenIn = audit.slice(audit.indexOf("UNIT_TAKEN_IN"));
    expect(takenIn).toContain(`**Home Commit**: ${home.plan}`);
    expect(takenIn.slice(0, takenIn.indexOf("\n---"))).not.toContain("Home Record");
    // The inputs, byte for byte as the plan holds them.
    const rel = "inception/requirements-analysis/requirements.md";
    expect(readFileSync(join(record, ...rel.split("/")), "utf-8")).toBe(`${git(plan, ["show", `${home.plan}:inputs/${rel}`])}\n`);
    // The take's record is where the plan's records are read.
    expect(recordAt(home, "refunds")?.json).toMatchObject({ unit: "refunds", taken_by: "pay", base_oid: home.plan });
    expect(readFileSync(join(record, "approved-inputs.md"), "utf-8")).toContain(
      `refunds of fixture, from the plan shared in checkout-api (${plan}), copied from its commit ${home.plan!.slice(0, 12)}. ` +
        "These files are the lead's: approved there, read here. Change one and AI-DLC asks whether to put your change on the " +
        "Unit's record, for the lead to decide.",
    );
  });

  test("a longer ref name that starts with the work id lands at its own copy name, never in this plan's copy", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    // Another commit under a name that begins with this work's id.
    git(plan, ["update-ref", `refs/aidlc/plans/${home.id8}zz`, git(plan, ["rev-parse", "main"])]);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    expect(git(pay, ["rev-parse", copyName(plan, home.id8)])).toBe(home.plan!);
    expect(git(pay, ["rev-parse", `refs/aidlc/home/${home.id8}zz/${repoCopyKey(plan)}/plan`])).toBe(git(plan, ["rev-parse", "main"]));
  });

  test("a plan deleted at its repository: the look says it is gone and keeps the copy a build took from", async () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    git(pay, ["config", "fetch.prune", "true"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    const looked = (await tools()).lookAt(pay, plan, [planRefOf(home.id8)]);
    expect(looked).toEqual({ ok: true, refs: { [planRefOf(home.id8)]: { now: null, was: home.plan } } });
    expect(git(pay, ["rev-parse", copyName(plan, home.id8)])).toBe(home.plan!);
  });

  test("with fetch.prune on, a look at one repository keeps another repository's copies", async () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const billing = home.hosts.billing;
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    git(pay, ["config", "fetch.prune", "true"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    expect((await tools()).lookAt(pay, billing, [`refs/aidlc/claims/${home.id8}/`]).ok).toBe(true);
    expect(git(pay, ["rev-parse", copyName(plan, home.id8)])).toBe(home.plan!);
  });

  test("the lead's work records its plan's repository as its Home Location once teams are chosen", () => {
    const home = makePlanHome({ share: false });
    expect(field(readFileSync(seededStateFile(home.dir), "utf-8"), "Home Location")).toBe(home.hosts["checkout-api"]);
  });

  test("taken with the lead's practices, the build's testing contract follows the lead's Testing Posture as the plan carries it", () => {
    const home = makePlanHome({ share: false });
    const practices = join(home.dir, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(practices, readFileSync(practices, "utf-8").replace("## Testing Posture\n", "## Testing Posture\nTDD: the refund amount's tests are written first and must fail.\n"));
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan, "--lead-rules"], pay).status).toBe(0);
    expect(field(readFileSync(join(buildDir(pay, "refunds"), "aidlc-state.md"), "utf-8"), "Lead Project Rules")).toBe("rules/team.md");
    const posture = JSON.parse(run(join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), ["resolve"], pay).out) as { methodology: string; source: string };
    expect(posture).toMatchObject({ methodology: "tdd", source: "team" });
  });

  test("the plan's repository's address said once: its Units are offered, each start takes from the plan, and a later ask finds them with no address", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const ask = next(pay, ENV, ["--lead-address", plan]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    const start = (ask.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Start refunds");
    expect(start?.command?.replaceAll("'", "")).toContain(`take refunds --plan ${home.id8} --from ${plan}`);
    expect(JSON.parse(readFileSync(join(pay, "aidlc", ".aidlc-engine", "units", "claim-registry.json"), "utf-8")).said_plans)
      .toEqual([{ address: plan, at: expect.any(String) }]);
    // Another chat, the same ask in words with no address: the plan is found where it was said.
    const again = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }, ["--units"]);
    expect(again.ask_type, JSON.stringify(again).slice(0, 600)).toBe("unit-take");
    // Once a build holds the address, the said list lets it go.
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    expect(JSON.parse(readFileSync(join(pay, "aidlc", ".aidlc-engine", "units", "claim-registry.json"), "utf-8")).said_plans).toBeUndefined();
  });

  test("a workspace that has the plan's repository finds it with nothing said but the ask", () => {
    const home = makePlanHome();
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const ask = next(sam, ENV, ["--units"]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
  });

  test("a person alone, nobody asked: a bare next reads no remote", () => {
    const home = makePlanHome();
    const solo = teamWorkspace(home.hosts, "solo", ["checkout-api"]);
    const trace = join(tempDir("trace"), "trace.txt");
    next(solo, { ...ENV, GIT_TRACE: trace });
    const calls = existsSync(trace) ? readFileSync(trace, "utf-8").split(/\r?\n/) : [];
    expect(calls.filter((line) => /trace: (built-in|run_command): git (fetch|ls-remote)/.test(line))).toEqual([]);
  });

  test("a code repository's own pre-push hook does not run for a take; its record goes from the workspace's own repository", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    const marker = join(tempDir("hook"), "ran");
    const hook = join(sam, "checkout-api", ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker.replace(/\\/g, "/")}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    expect(run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", plan], sam).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ unit: "checkout-ui", taken_by: "sam" });
    expect(git(join(sam, "checkout-api"), ["for-each-ref", "--format=%(refname)", "refs/aidlc/"])).toBe("");
  });

  test("two spellings of one repository's address read into one copy folder", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", `file://${plan.replace(/\\/g, "/")}`], pay).status).toBe(0);
    expect(git(pay, ["rev-parse", copyName(plan, home.id8)])).toBe(home.plan!);
    expect(git(pay, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${home.id8}/`]).split("\n").filter((ref) => ref.endsWith("/plan")))
      .toEqual([copyName(plan, home.id8)]);
  });

  test("one silent repository among several: the ask reads the others and offers their plan, and the silent one holds it five seconds at most", () => {
    const home = makePlanHome();
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api", "billing"]);
    // A third clone whose remote never answers.
    const silent = join(sam, "reports");
    git(sam, ["init", "-q", "-b", "main", silent]);
    git(silent, ["remote", "add", "origin", "ssh://silent.example/reports.git"]);
    const sleeper = join(tempDir("ssh"), "never-answers.sh");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 60\n");
    chmodSync(sleeper, 0o755);
    const started = Date.now();
    const ask = next(sam, { ...ENV, GIT_SSH_COMMAND: sleeper }, ["--units"]);
    expect(Date.now() - started, JSON.stringify(ask).slice(0, 400)).toBeLessThan(30_000);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
  });

  test("a plan whose format this AI-DLC does not read: the update step, and nothing taken or built", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    pushEditedPlan(home, (json) => ({ ...json, format: 99 }));
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("This plan was set up with a newer AI-DLC");
    expect(existsSync(join(pay, "aidlc", "spaces", "default", "intents")) && readdirSync(join(pay, "aidlc", "spaces", "default", "intents"))
      .some((name) => name.endsWith("-refunds"))).toBe(false);
    expect(recordAt(home, "refunds")).toBeNull();
  });

  test("an address said that git cannot read: the step says it could not be reached in git's words, never that nothing is shared there", () => {
    const pay = teamWorkspace({}, "pay", []);
    const nowhere = join(tempDir("gone"), "nowhere.git");
    const step = run(ORCH, ["next", "--lead-address", nowhere], pay);
    expect(String(step.json?.message ?? step.json?.error), step.out).toContain(`${nowhere} could not be read: `);
    expect(step.out).not.toContain("has no plan shared in it");
    // Given no address at all: what the flag takes, in the words the person gives it.
    const bare = run(ORCH, ["next", "--lead-address"], pay);
    expect(bare.out).toContain("--lead-address requires the address of the repository the plan is shared in.");
  });

  test("the offer names the plan's repository, and who made the plan's last commit and when, as that commit says", async () => {
    const home = makePlanHome();
    const { planLastChange } = await tools();
    const sam = teamWorkspace(home.hosts, "sam", ["checkout-api"]);
    // AI-DLC's own message: what follows its "aidlc plan <label> <version>: ".
    expect(planLastChange(home.hosts["checkout-api"], home.plan!)?.what).toBe("shared");
    const edited = pushEditedPlan(home, (json) => json);
    const ask = next(sam, ENV, ["--units"]);
    expect(String(ask.question), JSON.stringify(ask).slice(0, 600)).toStartWith("fixture is shared in checkout-api (the plan's last commit: lead, 1 Jan).");
    expect(planLastChange(sam, edited)).toEqual({ what: "edited", name: "lead", day: "1 Jan" });
  });

  // A sh script stands in for ssh, which git for Windows never runs as one; the order and the quiet read are
  // the same code on every platform.
  test.skipIf(process.platform === "win32")("the address said is read first, as the person's own step: never quiet, and never skipped for a silent repository on its host", () => {
    const sam = teamWorkspace({}, "sam", []);
    const silent = join(sam, "reports");
    git(sam, ["init", "-q", "-b", "main", silent]);
    git(silent, ["remote", "add", "origin", "ssh://plans.example/reports.git"]);
    // An ssh that notes each call; the repository the workspace has never answers, the said one refuses at once.
    const bin = tempDir("ssh-bin");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *reports*) sleep 60;; esac\nexit 128\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    run(ORCH, ["next", "--lead-address", "ssh://plans.example/plans.git"], sam, { ...ENV, GIT_SSH_COMMAND: join(bin, "ssh") });
    const calls = readFileSync(log, "utf-8").trim().split("\n");
    expect(calls[0], calls.join("\n")).toContain("plans.git");
    expect(calls[0]).not.toContain("BatchMode=yes");
  });

  test("a plan ref pushed into a second repository of the workspace is not offered by the sweep there", () => {
    const home = makePlanHome();
    pushEditedPlan(home, (json) => json, home.hosts.billing);
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const ask = next(pay, ENV, ["--units"]);
    expect(ask.ask_type ?? null, JSON.stringify(ask).slice(0, 600)).not.toBe("unit-take");
  });

  test("a plan ref pushed into a second repository of the workspace is not read as the lead's own plan", async () => {
    const home = makePlanHome();
    const billing = home.hosts.billing;
    pushEditedPlan(home, (json) => ({
      ...json,
      plan_repo: { name: "billing", address: billing },
      units: [...(json.units as unknown[]), { name: "ghost", waits_on: [], repos: [], record: "billing", word: { done: true } }],
    }), billing);
    // As a look at billing would keep it: in billing's own copy folder.
    git(home.dir, ["fetch", "-q", billing, `${planRefOf(home.id8)}:${copyName(billing, home.id8)}`]);
    const { planUnitsKept } = await tools();
    expect(planUnitsKept(home.dir)).toEqual(["refunds", "checkout-ui", "reporting"]);
    const again = run(UNIT, ["share", "--plan"], home.dir);
    expect(again.status, again.out).toBe(0);
    expect((again.json?.plan as { repo: string }).repo).toBe("checkout-api");
  });

  test("a plan ref pushed into another repository of the workspace is never read as the lead's word: a Unit another team took stays taken", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", plan], web);
    expect(took.status, took.out).toBe(0);
    const generation = recordAt(home, "checkout-ui")?.json.generation;
    // Pushed into billing by anyone who can push there: the same plan, later, with an open-again word on checkout-ui.
    pushEditedPlan(home, (json) => ({
      ...json,
      units: (json.units as Array<Record<string, unknown>>).map((unit) =>
        unit.name === "checkout-ui" ? { ...unit, word: { generation, open_again: { at: "2099-01-01T00:00:00Z" } } } : unit),
    }), home.hosts.billing);
    // A workspace with every repository asks what it can take: the sweep reads each of them.
    const sam = teamWorkspace(home.hosts, "sam");
    const ask = next(sam, ENV, ["--units"]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).not.toContain("Start checkout-ui");
    const again = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", plan], sam);
    expect(again.status, again.out).not.toBe(0);
    expect(again.out).toContain("checkout-ui is already taken");
    expect(recordAt(home, "checkout-ui")?.json).toMatchObject({ taken_by: "web" });
  });

  test("asked for the Units with no plan in this workspace's repositories: the ask is for the address it is shared in", () => {
    const home = makePlanHome({ share: false });
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const ask = next(pay, ENV, ["--units"]);
    expect(String(ask.narration), JSON.stringify(ask).slice(0, 600)).toMatch(
      /^I found no plan in this workspace's repositor(y|ies \([^)]*\))\. What is the address of the repository it is shared in\?$/,
    );
  });

  test("a plan gone from where it was shared: the address said and a take say so by its name, and nothing is taken", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(next(pay, ENV, ["--lead-address", plan]).ask_type).toBe("unit-take");
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    const said = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }, ["--lead-address", plan]);
    expect(String(said.narration), JSON.stringify(said).slice(0, 600)).toBe("The plan of fixture is no longer in checkout-api.");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("The plan of fixture is no longer in checkout-api.");
    expect(existsSync(join(pay, "aidlc", "spaces", "default", "intents"))).toBe(false);
    // With no copy here, the address alone.
    const sam = teamWorkspace(home.hosts, "sam", ["billing"]);
    const fresh = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], sam);
    expect(String(fresh.json?.error), fresh.out).toBe(`${plan} does not have this plan now.`);
  });

  test("a build whose plan is gone from its repository: said once, none of its Units offered, and looked at again each step until it is back", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    const later = { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" };
    const step = next(pay, later, ["--units"]);
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 800)).toContain(
      "The plan of fixture is no longer in checkout-api. This build carries on from the copy here; no other Unit of it can be taken while it is gone.",
    );
    expect(JSON.stringify(step)).not.toContain("Start checkout-ui");
    expect(JSON.stringify(step)).not.toContain("What is the address");
    // The chat is not noted as looked for that work, so a later step looks again.
    const mark = join(pay, "aidlc", ".aidlc-engine", "sessions", "claims-fetched.json");
    const noted = existsSync(mark) ? (JSON.parse(readFileSync(mark, "utf-8")) as Record<string, { chat: string }>) : {};
    expect(noted[home.id8]?.chat).not.toBe("pay-later");
    // Back where it was: the same chat's next look offers its Units again.
    git(plan, ["update-ref", planRefOf(home.id8), home.plan!]);
    const back = next(pay, later, ["--units"]);
    expect(back.ask_type, JSON.stringify(back).slice(0, 600)).toBe("unit-take");
    expect((back.choices as Array<{ label: string }>).map((choice) => choice.label)).toContain("Start checkout-ui");
  });

  test("a plan at the address said that does not read: the step says so, never that nothing is shared there", () => {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    pushEditedPlan(home, (json) => ({ ...json, units: "none" }));
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const said = next(pay, ENV, ["--lead-address", plan]);
    expect(String(said.narration), JSON.stringify(said).slice(0, 600)).toMatch(
      /^The plan in \S+ could not be read: what is there is not a plan this AI-DLC can read\.$/,
    );
  });

  test("the plan's repository does not answer at a look in a clone of the lead's workspace: said once with git's first line", () => {
    const home = makePlanHomeWithRemote();
    const [repo, plan] = Object.entries(home.hosts)[0];
    const bob = cloneOf(home.remote, "bob");
    expect(next(bob).ask_type).toBe("unit-take");
    renameSync(plan, `${plan}-away`);
    try {
      const step = next(bob, { ...ENV, AIDLC_SESSION_OVERRIDE: "bob-later" });
      const said = ((step.change_notices ?? []) as string[]).filter((line) => line.includes("could not be read just now"));
      expect(said, JSON.stringify(step).slice(0, 800)).toHaveLength(1);
      // The plan's repository holds records of its Units too: one line says both.
      expect(said[0]).toMatch(new RegExp(`^${repo} could not be read just now \\(fatal: .+\\), so what is ready to take in fixture, and who has taken what, may be behind\\.$`));
      expect(said[0]).not.toContain("Could not read from remote repository");
    } finally {
      renameSync(`${plan}-away`, plan);
    }
  });

  test("the Start choice names the plan's address quoted: it runs under posix as written, and under cmd.exe and PowerShell as the opencode skill has it typed", async () => {
    // The plan's repository at an address with an @ in it, as an ssh address has.
    const at = join(tempDir("at"), "team@host", "checkout-api.git");
    mkdirSync(dirname(at), { recursive: true });
    git(tempDir("at-parent"), ["clone", "-q", "--bare", codeHost("checkout-api"), at]);
    const home = makePlanHome({ repos: { "checkout-api": at, billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") } });
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const ask = next(pay, ENV, ["--lead-address", at]);
    const start = (ask.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Start refunds")?.command;
    expect(start, JSON.stringify(ask).slice(0, 600)).toContain(`--from '${at}'`);
    // As written, a POSIX shell hands the take the address as one word.
    const words = Bun.spawnSync({ cmd: ["bash", "-c", `set -- ${start!.replace(/^.*? take /, "")}; printf '%s\\0' "$@"`] }).stdout.toString().split("\0").filter(Boolean);
    expect(words).toEqual(["refunds", "--plan", home.id8, "--from", at]);
    expect(run(UNIT, ["take", ...words], pay).status).toBe(0);
    // The same words for ssh addresses, through the plugin as opencode runs it.
    const { planTakeWords } = await tools();
    for (const address of [at, "git@github.com:acme/checkout-api.git", "ssh://git@github.com/acme/checkout-api.git"]) {
      const command = `bun .aidlc/tools/aidlc-unit.ts take refunds ${planTakeWords(home.id8, address)}`;
      expect(await openCodeSays("bash", "linux", command), command).toBe("");
      // The opencode skill: cmd.exe groups no single quotes, so the agent puts them in double quotes.
      expect(await openCodeSays("cmd.exe", "win32", command.replaceAll("'", '"')), command).toBe("");
      for (const [shell, platform] of [["pwsh", "linux"], ["powershell.exe", "win32"], ["pwsh", "win32"]] as const) {
        expect(await openCodeSays(shell, platform, command), `${shell} on ${platform}: ${command}`).toBe("");
      }
    }
  });

  test("the first look in a fresh clone of the lead's workspace reads each record where the plan puts it: a Unit another team took is not offered", () => {
    const home = makePlanHomeWithRemote();
    const plan = home.hosts["checkout-api"];
    const web = teamWorkspace(home.hosts, "web", ["checkout-web"]);
    const took = run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", plan], web);
    expect(took.status, took.out).toBe(0);
    const bob = cloneOf(home.remote, "bob");
    const ask = next(bob);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("unit-take");
    expect((ask.choices as Array<{ label: string }>).map((choice) => choice.label)).not.toContain("Start checkout-ui");
  });

  test("a take asked by another spelling of the plan's repository, with no clone of it here, writes the record there by the spelling the person gave", () => {
    const home = makePlanHome();
    const lead = "ssh://git@plans.example/org/checkout-api.git";
    const theirs = "https://plans.example/org/checkout-api.git";
    let unit = "";
    // The lead spells the plan's repository by ssh; this computer reaches it by https only.
    pushEditedPlan(home, (json) => {
      const own = json.plan_repo as { name: string };
      unit = (json.units as Array<{ name: string; record?: string }>).find((entry) => entry.record === own.name)!.name;
      return { ...json, plan_repo: { ...own, address: lead } };
    });
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const https = {
      ...ENV, GIT_SSH_COMMAND: "false", GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: `url.${home.hosts["checkout-api"]}.insteadOf`, GIT_CONFIG_VALUE_2: theirs,
    };
    const took = run(UNIT, ["take", unit, "--plan", home.id8, "--from", theirs], pay, https);
    expect(took.status, took.out).toBe(0);
    expect(recordAt(home, unit)?.json).toMatchObject({ unit, taken_by: "pay" });
  });

  test("a plan that names another work than the one asked for is not taken", () => {
    const home = makePlanHome();
    pushEditedPlan(home, (json) => ({ ...json, work: { ...(json.work as Record<string, unknown>), id: "00000000-0000-7000-8000-0000000000ff" } }));
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("could not be read: what is there is not a plan this AI-DLC can read.");
    expect(existsSync(join(pay, "aidlc", "spaces", "default", "intents"))).toBe(false);
  });

  test("a plan whose input would be copied over the build's own state is not taken, and nothing is written", () => {
    const home = makePlanHome();
    pushEditedPlan(home, (json) => ({ ...json, inputs: [...(json.inputs as Array<Record<string, unknown>>), { path: "aidlc-state.md" }] }));
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("what is there is not a plan this AI-DLC can read");
    expect(existsSync(join(pay, "aidlc", "spaces", "default", "intents"))).toBe(false);
  });

  test("a branch name in plan.json that reads as an option never goes to git as one", () => {
    const home = makeHome({ repos: {} });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const id8 = (JSON.parse(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as Array<{ uuid: string }>)[0]
      .uuid.replace(/-/g, "").slice(-8);
    const marker = join(tempDir("option"), "ran");
    const planHome: PlanHome = { dir: home.dir, hosts: { workspace: home.remote }, id8, plan: git(home.remote, ["rev-parse", planRefOf(id8)]) };
    pushEditedPlan(planHome, (json) => ({
      ...json, repos: (json.repos as Array<Record<string, unknown>>).map((repo) => ({ ...repo, branch: `--upload-pack=touch ${marker}` })),
    }));
    const bob = cloneOf(home.remote, "bob");
    const took = run(UNIT, ["take", "refunds", "--plan", id8, "--from", home.remote], bob);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain("what is there is not a plan this AI-DLC can read");
    expect(existsSync(marker)).toBe(false);
  });

  test("a --home take of work teams build is refused with the way to its plan, and nothing is taken", () => {
    const home = makePlanHomeWithRemote();
    const bea = cloneOf(home.remote, "bea");
    const took = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], bea);
    expect(took.status).not.toBe(0);
    expect(took.out).toContain(`${HOME_RECORD}'s Units are taken from its plan.`);
    expect(recordAt(home, "refunds")).toBeNull();
  });

  test("a --home take of work teams build whose plan has nowhere to go yet is refused the same way, and nothing is taken", () => {
    // The work's one repository has no address, so its Home Location is "local" and no plan is shared anywhere.
    const home = makeHome({ repos: { ledger: "" } });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(field(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "aidlc-state.md"), "utf-8"), "Home Location")).toBe("local");
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bea = cloneOf(home.remote, "bea");
    const before = git(home.remote, ["for-each-ref", "refs/aidlc"]);
    const took = run(UNIT, ["take", "refunds", "--home", HOME_RECORD], bea);
    expect(took.status, took.out).not.toBe(0);
    expect(took.out).toContain(`${HOME_RECORD}'s Units are taken from its plan. Run \``);
    expect(took.out).toContain(" next --units` for what is ready to take.");
    expect(readdirSync(join(bea, "aidlc", "spaces", "default", "intents")).some((name) => name.endsWith("-refunds"))).toBe(false);
    expect(git(home.remote, ["for-each-ref", "refs/aidlc"])).toBe(before);
    expect(git(bea, ["for-each-ref", "refs/aidlc"])).toBe("");
    // The step it names finds no plan and asks where it is shared.
    const asked = next(bea, ENV, ["--units"]);
    expect(String(asked.narration), JSON.stringify(asked).slice(0, 600)).toMatch(/What is the address of the repository it is shared in\?$/);
  });

  // A pin of the solo second person's path: its look reads its claims and no plan.
  test("a solo second person's build looks at no plan", () => {
    const home = makeHome({ repos: {} });
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "refunds", "Run floor": "0" }, home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "solo work under way"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bob = cloneOf(home.remote, "bob");
    expect(run(UNIT, ["take", "checkout-ui", "--home", HOME_RECORD], bob).status).toBe(0);
    // In a space with nothing of their own, the look lists the builds here.
    inSpace(bob, "notes");
    const trace = join(tempDir("trace"), "trace.txt");
    next(bob, { ...ENV, GIT_TRACE: trace, AIDLC_SESSION_OVERRIDE: "bob-later" });
    const calls = existsSync(trace) ? readFileSync(trace, "utf-8").split(/\r?\n/) : [];
    expect(calls.filter((line) => /trace: (built-in|run_command): git .*refs\/aidlc\/plans/.test(line))).toEqual([]);
  });

  test("a sign-in in an unlisted clone's URL or in a repos.json url never goes on git's command line at the ask", () => {
    const pay = teamWorkspace({}, "pay", []);
    // Nothing listens on port 9 of the loopback, so each fetch is refused there and no host name is looked up.
    // A clone on disk that repos.json does not list, whose URL carries a sign-in.
    const billing = join(pay, "billing");
    git(pay, ["init", "-q", "-b", "main", billing]);
    git(billing, ["remote", "add", "origin", "https://lead:s3cret@127.0.0.1:9/org/billing.git"]);
    // A repos.json url that carries one, with no clone on disk.
    writeFileSync(join(pay, "repos.json"), `${JSON.stringify({ repos: [{ name: "ledger", url: "https://lead:t0ken@127.0.0.1:9/org/ledger.git" }] })}\n`);
    const trace = join(tempDir("trace"), "git.trace");
    run(ORCH, ["next", "--units"], pay, { ...ENV, GIT_TRACE: trace });
    // AI-DLC's own git calls (git's helper for https is handed the URL by git itself, as for any fetch in that clone).
    const calls = readFileSync(trace, "utf-8").split("\n").filter((line) => /trace: (built-in|exec|run_command): git fetch/.test(line));
    expect(calls.some((line) => line.includes("127.0.0.1:9/org/billing.git")), calls.join("\n")).toBe(true);
    expect(calls.some((line) => line.includes("127.0.0.1:9/org/ledger.git")), calls.join("\n")).toBe(true);
    expect(calls.filter((line) => /s3cret|t0ken/.test(line)), calls.join("\n")).toEqual([]);
  });

  // A sh script named git on PATH notes the call and its settings; git for Windows is found as git.exe, never as a
  // script. The command line half is the sign-in case above, by git's own trace, on every platform.
  test.skipIf(process.platform === "win32")("the plan and the records are read with a clone's own sign-in when its URL carries one, which never goes on git's command line", async () => {
    const pay = teamWorkspace({}, "pay", []);
    const clone = join(pay, "checkout-api");
    git(pay, ["init", "-q", "-b", "main", clone]);
    git(clone, ["remote", "add", "origin", "https://lead:s3cret@example.invalid/org/checkout-api.git"]);
    const address = "https://example.invalid/org/checkout-api.git";
    writeFileSync(join(pay, "repos.json"), `${JSON.stringify({ repos: [{ name: "checkout-api", url: address }] })}\n`);
    const { refreshHomeClaims } = await tools();
    // A git that notes each call's arguments and its command-scope settings, then gives up.
    const bin = tempDir("git-bin");
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in fetch*refs/aidlc/*) echo "$* | $(env | grep '^GIT_CONFIG_' | tr '\\n' ' ')" >> '${log}'; exit 1;; esac\nexec ${Bun.which("git")} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      refreshHomeClaims(pay, { home: { id8: "00000001", location: address }, now: true });
    } finally {
      process.env.PATH = path;
    }
    // With no copy of the plan here, the plan is read first, the same way.
    const calls = readFileSync(log, "utf-8").split("\n").filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const [args, settings] = call.split(" | ");
      expect(args).not.toContain("s3cret");
      expect(settings).toContain("insteadOf");
    }
  });
});

describe("a build whose plan was shared again over its history hears it once", () => {
  // pay takes refunds from the plan; what the build holds of its take, to compare after.
  function takenBuild(repos = ["billing"]): { home: PlanHome; plan: string; pay: string; kept: () => string } {
    const home = makePlanHome();
    const plan = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", repos);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", plan], pay).status).toBe(0);
    const record = buildDir(pay, "refunds");
    const kept = (): string => JSON.stringify([
      readFileSync(join(record, "approved-inputs.md"), "utf-8"),
      readdirSync(join(record, "audit")).map((name) => readFileSync(join(record, "audit", name), "utf-8")).join("\n").match(/UNIT_TAKEN_IN[\s\S]*?\n---/)?.[0],
      recordAt(home, "refunds")?.json,
    ]);
    return { home, plan, pay, kept };
  }
  const heard = (step: Record<string, unknown>): string[] =>
    ((step.change_notices ?? []) as string[]).filter((line) => line.includes("was shared again since you took refunds"));
  const line = "The plan of fixture in checkout-api was shared again since you took refunds; what you took stays as it was.";

  test("gone and shared again: the build's next look says it once, the look after says nothing, and what it took stays", () => {
    const { home, plan, pay, kept } = takenBuild();
    const before = kept();
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const first = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(heard(first), JSON.stringify(first).slice(0, 900)).toEqual([line]);
    const after = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later-2" });
    expect(heard(after), JSON.stringify(after).slice(0, 900)).toEqual([]);
    expect(kept()).toBe(before);
  });

  test("written over a tip that was not a plan: the build's next look says it once", () => {
    const { home, pay } = takenBuild();
    pushEditedPlan(home, (json) => ({ ...json, units: "none" }));
    const shared = run(UNIT, ["share", "--plan"], home.dir);
    expect(shared.status, shared.out).toBe(0);
    const first = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(heard(first), JSON.stringify(first).slice(0, 900)).toEqual([line]);
  });

  // Who moves the workspace's one copy of the plan first does not matter: the take's own commit is what is compared.
  test("next --units looks first: it says it once, and the build's steps after say nothing", () => {
    const { home, plan, pay } = takenBuild();
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const asked = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }, ["--units"]);
    expect(heard(asked), JSON.stringify(asked).slice(0, 900)).toEqual([line]);
    expect(heard(next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }))).toEqual([]);
  });

  test("status moves the copy first and says nothing: the build's next step says it once", () => {
    const { home, plan, pay } = takenBuild();
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const status = run(UTILITY, ["status"], pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(status.status).toBe(0);
    expect(status.out).not.toContain("was shared again since you took refunds");
    const step = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(heard(step), JSON.stringify(step).slice(0, 900)).toEqual([line]);
    expect(heard(next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later-2" }))).toEqual([]);
  });

  test("a look while the plan's tip is not a plan says nothing of it; the share over it is said once at the next", () => {
    const { home, pay } = takenBuild();
    pushEditedPlan(home, (json) => ({ ...json, units: "none" }));
    expect(heard(next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" }))).toEqual([]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const step = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later-2" });
    expect(heard(step), JSON.stringify(step).slice(0, 900)).toEqual([line]);
  });

  test("a build already pushed hears it once at its next bare step", () => {
    const { home, plan, pay } = takenBuild(["checkout-api", "billing"]);
    codeGenerated(pay, buildDir(pay, "refunds"));
    expect(run(UNIT, ["push"], pay).status).toBe(0);
    git(plan, ["update-ref", "-d", planRefOf(home.id8)]);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const step = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(heard(step), JSON.stringify(step).slice(0, 900)).toEqual([line]);
  });

  test("a share on top of the plan it took says nothing of it", () => {
    const { home, pay } = takenBuild();
    pushEditedPlan(home, (json) => json);
    const first = next(pay, { ...ENV, AIDLC_SESSION_OVERRIDE: "pay-later" });
    expect(heard(first), JSON.stringify(first).slice(0, 900)).toEqual([]);
  });
});

describe("followPlan reads where a moved plan is now, and only the plan itself", () => {
  // A teammate's workspace that has looked at the old place: its copy there is the pointer.
  async function lookedAtOld(home: PlanHome): Promise<{ pay: string; follow: (typed?: boolean) => Promise<Record<string, unknown>> }> {
    const t = await tools();
    const pay = teamWorkspace(home.hosts, "pay", ["checkout-web"]);
    const from = home.hosts["checkout-api"];
    expect(t.lookAt(pay, from, [planRefOf(home.id8)]).ok).toBe(true);
    const at = t.planAtCopy(pay, copyName(from, home.id8));
    expect(at.kind).toBe("moved");
    if (at.kind !== "moved") throw new Error("no pointer at the old place");
    const pointer = at.pointer;
    return { pay, follow: async (typed = false) => t.followPlan(pay, from, home.id8, pointer, typed) as unknown as Record<string, unknown> };
  }
  const pointerTo = (home: PlanHome, at: string, name: string, address: string): void => {
    const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    const work = (JSON.parse(git(home.hosts["checkout-api"], ["show", `${home.plan}:plan.json`])) as { work: unknown }).work;
    pushPlanJson(home, at, { format: 1, work, moved_to: { name, address } }, tip, "plan only", `aidlc plan fixture: moved to ${name}`);
  };

  test("a plan moved once is read where it went: the work, that repository as its own, its commit", async () => {
    const home = makePlanHome();
    const moved = movePlan(home, "billing");
    const { follow } = await lookedAtOld(home);
    const followed = await follow();
    expect(followed).toMatchObject({ kind: "followed", label: "fixture", repo: "billing", address: home.hosts.billing, oid: moved });
    expect((followed.plan as { plan_repo: unknown }).plan_repo).toEqual({ name: "billing", address: home.hosts.billing });
  });

  test("moved twice: each pointer is followed on to the plan", async () => {
    const home = makePlanHome();
    movePlan(home, "billing");
    const web = home.hosts["checkout-web"];
    movePlan(home, "checkout-web");
    const { follow } = await lookedAtOld(home);
    expect(await follow()).toMatchObject({ kind: "followed", repo: "checkout-web", address: web });
  });

  test("the new place could not be read: git's words when typed, its first line when quiet", async () => {
    const home = makePlanHome();
    movePlan(home, "billing");
    const { follow } = await lookedAtOld(home);
    renameSync(home.hosts.billing, `${home.hosts.billing}.gone`);
    for (const typed of [true, false]) {
      const unread = await follow(typed);
      expect(unread).toMatchObject({ kind: "unread", label: "fixture", repo: "billing", address: home.hosts.billing });
      expect(String(unread.said)).toContain(home.hosts.billing);
    }
  });

  test("where it points does not hold it: a pointer back and a plan naming another repository hold something else; no plan there holds nothing", async () => {
    const back = makePlanHome();
    movePlan(back, "billing");
    pointerTo(back, back.hosts.billing, "checkout-api", back.hosts["checkout-api"]);
    expect(await (await lookedAtOld(back)).follow()).toMatchObject({ kind: "not-followed", repo: "billing", address: back.hosts.billing, holds: "other" });

    const none = makePlanHome();
    pointerTo(none, none.hosts["checkout-api"], "checkout-web", none.hosts["checkout-web"]);
    expect(await (await lookedAtOld(none)).follow()).toMatchObject({ kind: "not-followed", repo: "checkout-web", holds: "nothing" });

    const mirror = makePlanHome();
    movePlan(mirror, "billing");
    const tip = git(mirror.hosts.billing, ["rev-parse", planRefOf(mirror.id8)]);
    const json = JSON.parse(git(mirror.hosts.billing, ["show", `${tip}:plan.json`])) as Record<string, unknown>;
    pushPlanJson(mirror, mirror.hosts.billing, { ...json, plan_repo: { name: "checkout-web", address: mirror.hosts["checkout-web"] } }, tip, "all", "mirror");
    expect(await (await lookedAtOld(mirror)).follow()).toMatchObject({ kind: "not-followed", repo: "billing", holds: "other" });
  });

  test("a plan deleted where it went holds nothing, though this workspace kept a copy of it from before", async () => {
    const home = makePlanHome();
    movePlan(home, "billing");
    const { follow } = await lookedAtOld(home);
    expect(await follow()).toMatchObject({ kind: "followed", repo: "billing" });
    git(home.hosts.billing, ["update-ref", "-d", planRefOf(home.id8)]);
    expect(await follow()).toMatchObject({ kind: "not-followed", repo: "billing", holds: "nothing" });
  });

  test("while the note is not followed, the plan under it is what a copy is read at", async () => {
    const home = makePlanHome();
    const t = await tools();
    const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    movePlan(home, "billing");
    const { pay } = await lookedAtOld(home);
    const copy = copyName(home.hosts["checkout-api"], home.id8);
    expect(t.planCommitOf(pay, copy)).toBe(tip);
    const place = { address: home.hosts["checkout-api"], repo: "checkout-api", id8: home.id8, uuid: "", work: home.id8, ref: planRefOf(home.id8), copy };
    expect(t.planAt(pay, place)).toMatchObject({ kind: "read", plan: { oid: tip } });
    expect(t.planAtCopy(pay, copy).kind).toBe("moved");
  });

  test("a chain past three pointers is not followed, and the fourth place is never read", async () => {
    const home = makePlanHome();
    const hops = ["hop-one", "hop-two", "hop-three", "hop-four"].map((name) => ({ name, address: codeHost(name) }));
    pointerTo(home, home.hosts["checkout-api"], hops[0].name, hops[0].address);
    for (const [i, hop] of hops.slice(0, 3).entries()) pointerTo(home, hop.address, hops[i + 1].name, hops[i + 1].address);
    const { pay, follow } = await lookedAtOld(home);
    expect(await follow()).toMatchObject({ kind: "not-followed", repo: "hop-three", address: hops[2].address });
    expect(git(pay, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${home.id8}/`]).split("\n").filter((ref) => ref.includes(repoCopyKey(hops[3].address)))).toEqual([]);
  });

  test("a pointer that is not this work's, or names an address git would read as an option, is no pointer: nothing is followed", async () => {
    const home = makePlanHome();
    const t = await tools();
    const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    const work = (JSON.parse(git(home.hosts["checkout-api"], ["show", `${tip}:plan.json`])) as { work: Record<string, unknown> }).work;
    const pay = teamWorkspace(home.hosts, "pay", ["checkout-web"]);
    for (const pointer of [
      { format: 1, work: { ...work, id: "00000000-0000-4000-8000-00000000beef" }, moved_to: { name: "billing", address: home.hosts.billing } },
      { format: 1, work, moved_to: { name: "billing", address: "-x" } },
    ]) {
      pushPlanJson(home, home.hosts["checkout-api"], pointer, tip, "plan only", "pointer");
      expect(t.lookAt(pay, home.hosts["checkout-api"], [planRefOf(home.id8)]).ok).toBe(true);
      expect(t.planAtCopy(pay, copyName(home.hosts["checkout-api"], home.id8)).kind).toBe("unreadable");
    }
  });
});

describe("a build follows a plan the lead moved to another repository", () => {
  const notices = (step: Record<string, unknown>): string[] => ((step.change_notices ?? []) as string[]).filter((line) => line.startsWith("The plan of fixture"));
  const homeLocation = (pay: string): string | null => field(readFileSync(join(buildDir(pay, "refunds"), "aidlc-state.md"), "utf-8"), "Home Location");
  const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: name });
  // The person writes in that chat: a line kept for the reply they read goes once a step carried it.
  const writes = (dir: string, name: string): void => {
    expect(hook(dir, chat(name), { hook_event_name: "UserPromptSubmit", session_id: name, prompt: "go on" }).status).toBe(0);
  };
  function took(repos = ["billing"]): { home: PlanHome; pay: string } {
    const home = makePlanHome();
    const pay = teamWorkspace(home.hosts, "pay", repos);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay).status).toBe(0);
    return { home, pay };
  }

  test("at the build's next look: it reads the plan where it went, says so once with the address, and never that it was shared again", () => {
    const { home, pay } = took();
    movePlan(home, "billing");
    const step = next(pay, chat("pay-later"));
    expect(notices(step), JSON.stringify(step).slice(0, 900)).toEqual([`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`]);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
    writes(pay, "pay-later");
    const after = [next(pay, chat("pay-later")), next(pay, chat("pay-later-2"))];
    expect(after.flatMap(notices), JSON.stringify(after[1]).slice(0, 900)).toEqual([]);
  });

  test("the new place could not be read: said once a chat with the way on, the lead's practices still read, nothing offered; it follows once it reads", () => {
    const { home, pay } = took();
    movePlan(home, "billing");
    renameSync(home.hosts.billing, `${home.hosts.billing}.away`);
    const step = next(pay, chat("pay-later"));
    const said = notices(step);
    expect(said.length, JSON.stringify(step).slice(0, 900)).toBe(1);
    expect(said[0]).toStartWith(`The plan of fixture moved to billing (${home.hosts.billing}), which could not be read (`);
    expect(said[0]).toEndWith("), so this build carries on from the copy here; no other Unit of it can be taken until it can be read. If you reach billing by another address, tell me which.");
    expect(JSON.stringify(step)).not.toContain("could not be read just now, so this step follows your team's own rules");
    expect(homeLocation(pay)).toBe(home.hosts["checkout-api"]);
    writes(pay, "pay-later");
    expect(notices(next(pay, chat("pay-later")))).toEqual([]);
    const offer = next(pay, chat("pay-later"), ["--units"]);
    expect(JSON.stringify(offer)).not.toContain("Start checkout-ui");
    renameSync(`${home.hosts.billing}.away`, home.hosts.billing);
    expect(notices(next(pay, chat("pay-later-2")))).toEqual([`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`]);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
  });

  test("where it points does not hold it: said once with whose it is to mend, and the build stays where it was", () => {
    const { home, pay } = took();
    const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    const work = (JSON.parse(git(home.hosts["checkout-api"], ["show", `${tip}:plan.json`])) as { work: unknown }).work;
    pushPlanJson(home, home.hosts["checkout-api"], { format: 1, work, moved_to: { name: "checkout-web", address: home.hosts["checkout-web"] } }, tip, "plan only", "moved");
    const step = next(pay, chat("pay-later"));
    expect(notices(step), JSON.stringify(step).slice(0, 900)).toEqual([
      "The plan of fixture says it moved, but checkout-web does not hold it, so this build carries on from the copy here; no other Unit of it can be taken until the lead's project has put that right.",
    ]);
    expect(homeLocation(pay)).toBe(home.hosts["checkout-api"]);
  });

  test("another spelling of the new address, said by the person, is where a build that cannot read the note's address follows", () => {
    const { home, pay } = took();
    const leads = join(tempDir("leads-spelling"), "billing.git");
    movePlanByHand(home, "billing", leads);
    expect(notices(next(pay, chat("pay-later")))[0]).toContain("If you reach billing by another address, tell me which.");
    const said = next(pay, chat("pay-later"), ["--lead-address", home.hosts.billing]);
    expect(notices(said), JSON.stringify(said).slice(0, 900)).toContain(`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
  });

  test("a note naming the work by another full id with the same suffix: the build follows it once and the step ends", () => {
    const { home, pay } = took();
    const tip = git(home.hosts["checkout-api"], ["rev-parse", planRefOf(home.id8)]);
    movePlan(home, "billing");
    const note = JSON.parse(git(home.hosts["checkout-api"], ["show", `${planRefOf(home.id8)}:plan.json`])) as { work: { id: string } };
    const other = `${note.work.id.startsWith("f") ? "e" : "f"}${note.work.id.slice(1)}`;
    pushPlanJson(home, home.hosts["checkout-api"], { ...note, work: { ...note.work, id: other } }, tip, "plan only", "aidlc plan fixture: moved to billing");
    const step = next(pay, chat("pay-later"));
    expect(notices(step), JSON.stringify(step).slice(0, 900)).toEqual([`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`]);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
  });

  test("the old address said, with no build here: the offer is the plan where it went, its takes name that address, and the said list keeps it", () => {
    const home = makePlanHome();
    const pay = teamWorkspace(home.hosts, "pay", ["checkout-web"]);
    movePlan(home, "billing");
    const ask = next(pay, ENV, ["--lead-address", home.hosts["checkout-api"]]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 900)).toBe("unit-take");
    expect(notices(ask)).toEqual(["The plan of fixture moved to billing."]);
    expect(String(ask.question)).toStartWith("fixture is shared in billing");
    const start = (ask.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Start refunds");
    expect(start?.command?.replaceAll("'", "")).toContain(`take refunds --plan ${home.id8} --from ${home.hosts.billing}`);
    expect(JSON.parse(readFileSync(join(pay, "aidlc", ".aidlc-engine", "units", "claim-registry.json"), "utf-8")).said_plans)
      .toEqual([{ address: home.hosts.billing, at: expect.any(String) }]);
  });

  test("the old address said and the new place could not be read: the step ends with that, never that nothing is shared there", () => {
    const home = makePlanHome();
    const pay = teamWorkspace(home.hosts, "pay", ["checkout-web"]);
    movePlan(home, "billing");
    renameSync(home.hosts.billing, `${home.hosts.billing}.away`);
    const step = run(ORCH, ["next", "--lead-address", home.hosts["checkout-api"]], pay);
    const said = String(step.json?.narration ?? step.json?.error ?? step.out);
    expect(said).toContain(`The plan of fixture moved to billing (${home.hosts.billing}), which could not be read (`);
    expect(said).toContain("If you reach billing by another address, tell me which.");
    expect(said).not.toContain("has no plan shared in it yet");
  });

  test("a take typed at the old address takes from where the plan went and records it; when that cannot be read, nothing is taken", () => {
    const home = makePlanHome();
    const pay = teamWorkspace(home.hosts, "pay", ["checkout-web"]);
    movePlan(home, "billing");
    renameSync(home.hosts.billing, `${home.hosts.billing}.away`);
    const refused = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay);
    expect(refused.status).not.toBe(0);
    expect(String(refused.json?.error)).toContain(`refunds was not taken: the plan of fixture moved to billing (${home.hosts.billing}), which could not be read (`);
    expect(String(refused.json?.error)).toContain("Say when to try again. If you reach billing by another address, tell me which.");
    renameSync(`${home.hosts.billing}.away`, home.hosts.billing);
    const taken = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay);
    expect(taken.status, taken.out).toBe(0);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
    expect(taken.json?.notice).toStartWith("The plan of fixture moved to billing. refunds is yours.");
  });

  test("a silent look first (status, then a push): the build's next step still says it once, and its record is written only where it was", () => {
    const { home, pay } = took(["checkout-api", "billing"]);
    codeGenerated(pay, buildDir(pay, "refunds"));
    movePlan(home, "billing");
    const holding = (): string[] => Object.entries(home.hosts)
      .filter(([, host]) => git(host, ["for-each-ref", `refs/aidlc/claims/${home.id8}/refunds`]) !== "").map(([name]) => name);
    const before = holding();
    expect(run(UTILITY, ["status"], pay, chat("pay-later")).status).toBe(0);
    const pushed = run(UNIT, ["push"], pay, chat("pay-later"));
    expect(pushed.status, pushed.out).toBe(0);
    expect(holding()).toEqual(before);
    expect(homeLocation(pay)).toBe(home.hosts.billing);
    const step = next(pay, chat("pay-later"));
    expect(notices(step), JSON.stringify(step).slice(0, 900)).toEqual([`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`]);
  });
});

describe("a teammate's clone of work teams build with no plan known", () => {
  // A teammate's clone (another git user, a chat of its own) of the lead's
  // workspace, pushed after teams were chosen and before any plan was shared.
  function teammateClone(repos: Record<string, string>, notNow: boolean): string {
    const home = makeHome({ repos });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    // The lead planned it there: the plan's own rows are in the lead's checkout.
    asLeadsOwnCheckout(home.dir);
    if (notNow) {
      const share = next(home.dir);
      expect(share.ask_type, JSON.stringify(share).slice(0, 400)).toBe("team-handover");
    }
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "--allow-empty", "-m", "teams"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const bea = cloneOf(home.remote, "bea");
    git(bea, ["config", "user.name", "Bea Teammate"]);
    git(bea, ["config", "user.email", "bea.teammate@example.test"]);
    return bea;
  }

  for (const [label, repos, notNow] of [
    ["its one repository has no address", () => ({ ledger: "" }), false],
    ["the lead said Not now to the share", () => ({ "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") }), true],
  ] as const) {
    test(`a bare next is the step next --units gives, and the lead's work is never offered to carry on (${label})`, () => {
      const bea = teammateClone(repos(), notNow);
      const env = { ...ENV, AIDLC_SESSION_OVERRIDE: "bea-chat" };
      const bare = next(bea, env);
      const units = next(bea, { ...env, AIDLC_SESSION_OVERRIDE: "bea-chat-2" }, ["--units"]);
      expect(bare.ask_type ?? null, JSON.stringify(bare).slice(0, 600)).not.toBe("intent-pick");
      expect(JSON.stringify(bare)).not.toContain("Carry on with");
      expect(String(bare.narration), JSON.stringify(bare).slice(0, 600)).toBe(String(units.narration));
      expect(String(bare.narration)).toMatch(/What is the address of the repository it is shared in\?$/);
    });
  }

  // Unchanged: work that is not built by teams, and a team's work with no Home Location (its claims on branches).
  for (const [label, made] of [
    ["solo work", (home: ReturnType<typeof makeHome>) => home],
    ["a team's work with its claims on branches", (home: ReturnType<typeof makeHome>) => {
      expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
      asLeadsOwnCheckout(home.dir);
      const state = seededStateFile(home.dir);
      writeFileSync(state, readFileSync(state, "utf-8").replace(/^- \*\*Home Location\*\*:.*\n/m, ""));
      return home;
    }],
  ] as const) {
    test(`${label}: a bare next in a clone still puts that work to the person to carry on`, () => {
      const home = made(makeHome({ repos: { ledger: "" } }));
      git(home.dir, ["add", "-A"]);
      git(home.dir, ["commit", "-q", "--allow-empty", "-m", "work"]);
      git(home.dir, ["push", "-q", "origin", "main"]);
      const bea = cloneOf(home.remote, "bea");
      const bare = next(bea, { ...ENV, AIDLC_SESSION_OVERRIDE: "bea-chat" });
      expect(bare.ask_type, JSON.stringify(bare).slice(0, 600)).toBe("intent-pick");
      expect(String(bare.question)).toContain("Carry on with");
    });
  }
});

describe("a teammate's clone of the planner's record from before the plan was shared", () => {
  const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: name });
  // What a clone of solo work is asked, word for word.
  const CARRY_ON = `This project has one piece of work in progress: \`fixture\` (record: \`${HOME_RECORD}\`) (in Construction). ` +
    "Carry on with `fixture`, or not now?";
  const SHAPES = [
    ["one repository, the workspace's own", () => ({})],
    ["several repositories", () => ({ "checkout-api": codeHost("checkout-api"), billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") })],
  ] as const;

  // The planner's workspace with Inception approved in the planner's own checkout and pushed; main then takes no
  // direct push. `later` is what the planner does next (teams chosen and the plan shared, unless it says else), whose
  // record stays out of main; a teammate's clone is made after it. `before` edits the workspace before its push.
  function planAhead(repos: Record<string, string>, later?: (home: Home) => void, before?: (dir: string) => void): { home: Home; bea: string } {
    const home = makeHome({ repos });
    before?.(home.dir);
    mkdirSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "audit"), { recursive: true });
    asLeadsOwnCheckout(home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "inception"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const refuse = join(home.remote, "hooks", "pre-receive");
    writeFileSync(refuse, "#!/bin/sh\nwhile read old new ref; do [ \"$ref\" = refs/heads/main ] && { echo 'main takes pull requests only' >&2; exit 1; }; done\nexit 0\n");
    chmodSync(refuse, 0o755);
    (later ?? ((it: Home) => {
      expect(run(STATE, ["set-unit-ownership", "team"], it.dir).status).toBe(0);
      sharePlan(it);
    }))(home);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "--allow-empty", "-m", "teams"]);
    expect(() => git(home.dir, ["push", "-q", "origin", "main"])).toThrow();
    const bea = cloneOf(home.remote, "bea");
    git(bea, ["config", "user.name", "Bea Teammate"]);
    return { home, bea };
  }

  // The step, and the git calls it made that read a remote.
  function remoteReads(dir: string, env: NodeJS.ProcessEnv): { step: Record<string, unknown>; reads: string[] } {
    const trace = join(tempDir("trace"), "trace.txt");
    const step = next(dir, { ...env, GIT_TRACE: trace });
    const calls = existsSync(trace) ? readFileSync(trace, "utf-8").split(/\r?\n/) : [];
    return { step, reads: calls.filter((line) => /trace: (built-in|run_command): git (fetch|ls-remote)/.test(line)) };
  }

  const expectCarryOn = (step: Record<string, unknown>): void => {
    expect(step.ask_type, JSON.stringify(step).slice(0, 600)).toBe("intent-pick");
    expect(step.question).toBe(CARRY_ON);
  };

  // The planner's repos.json with checkout-api at `url`, as only the planner's computer may reach it.
  const checkoutApiAt = (url: string) => (dir: string): void => {
    const listed = JSON.parse(readFileSync(join(dir, "repos.json"), "utf-8")) as { repos: Array<{ name: string; url: string }> };
    const repos = listed.repos.map((repo) => (repo.name === "checkout-api" ? { ...repo, url } : repo));
    writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos }, null, 2)}\n`);
  };

  for (const [shape, repos] of SHAPES) {
    test(`a bare next offers the plan's Units as next --units does, never the planner's work to carry on (${shape})`, () => {
      const { bea } = planAhead(repos());
      const bare = next(bea, chat("bea-chat"));
      const units = next(bea, chat("bea-chat-2"), ["--units"]);
      expect(bare.ask_type, JSON.stringify(bare).slice(0, 600)).toBe("unit-take");
      expect(JSON.stringify(bare)).not.toContain("Carry on with");
      expect(offerText(bare.question)).toBe(offerText(units.question));
      expect((bare.choices as Array<{ label: string }>).map((choice) => choice.label))
        .toEqual((units.choices as Array<{ label: string }>).map((choice) => choice.label));
    });
  }

  test("one repository whose Way of Working is in words this clone has not read: a bare next offers the plan's Units", () => {
    const { bea } = planAhead(SHAPES[0][1](), (home) => {
      expect(run(STATE, ["practices-branch", "--file", "team.md", "--none"], home.dir).status).toBe(0);
      expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
      sharePlan(home);
    }, (dir) => {
      const team = join(dir, "aidlc", "spaces", "default", "memory", "team.md");
      writeFileSync(team, readFileSync(team, "utf-8").replace(/## Way of Working\n[\s\S]*?(?=\n## )/, "## Way of Working\n\nWe review every change in a pull request.\n"));
    });
    const bare = next(bea, chat("bea-chat"));
    expect(bare.ask_type, JSON.stringify(bare).slice(0, 600)).toBe("unit-take");
    expect(offerText(bare.question)).toBe(offerText(next(bea, chat("bea-chat-2"), ["--units"]).question));
  });

  test("after the Units offer, words naming the planner's work still pick it", () => {
    const { bea } = planAhead(SHAPES[0][1]());
    expect(next(bea, chat("bea-chat")).ask_type).toBe("unit-take");
    const said = next(bea, chat("bea-chat"), ["carry", "on", "fixture"]);
    expect(String(said.message), JSON.stringify(said).slice(0, 600)).toContain(`Work is in progress here (${HOME_RECORD})`);
    const picked = next(bea, chat("bea-chat"), ["--pick", HOME_RECORD]);
    expect(JSON.stringify(picked)).toContain(`intent switch ${HOME_RECORD}`);
  });

  test("work one person builds: one look, of that work's plan only, finds none; once they carry on no step looks for a plan", () => {
    const { bea } = planAhead(SHAPES[0][1](), () => {});
    const bare = remoteReads(bea, chat("bea-chat"));
    expectCarryOn(bare.step);
    expect(bare.reads, bare.reads.join("\n")).toHaveLength(1);
    expect(bare.reads[0]).toMatch(/'\+refs\/aidlc\/plans\/[0-9a-f]{8}\*:/);
    expect(run(UTILITY, ["intent", "switch", HOME_RECORD], bea, chat("bea-chat")).status).toBe(0);
    expect(remoteReads(bea, chat("bea-chat")).reads.filter((read) => read.includes("refs/aidlc/plans/"))).toEqual([]);
  });

  test("teams chosen and the plan shared, then one builder again, that record in main: a clone is asked to carry the work on", () => {
    const home = makeHome({ repos: {} });
    mkdirSync(join(home.dir, "aidlc", "spaces", "default", "intents", HOME_RECORD, "audit"), { recursive: true });
    asLeadsOwnCheckout(home.dir);
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    sharePlan(home);
    expect(run(STATE, ["set-unit-ownership", "solo"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "one builder"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    expectCarryOn(next(cloneOf(home.remote, "bea"), chat("bea-chat")));
  });

  test("the plan's repository does not answer: the step is the one a clone of solo work meets", () => {
    const { home, bea } = planAhead(SHAPES[0][1]());
    renameSync(home.remote, `${home.remote}-away`);
    try {
      expectCarryOn(next(bea, chat("bea-chat")));
    } finally {
      renameSync(`${home.remote}-away`, home.remote);
    }
  });

  test("the plan's repository is silent: the look ends at its time limit and the step is the one a clone of solo work meets", () => {
    const { bea } = planAhead(SHAPES[1][1](), undefined, checkoutApiAt("ssh://silent.example/checkout-api.git"));
    const sleeper = join(tempDir("ssh"), "never-answers.sh");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 60\n");
    chmodSync(sleeper, 0o755);
    const started = Date.now();
    const step = next(bea, { ...chat("bea-chat"), GIT_SSH_COMMAND: sleeper });
    expect(Date.now() - started).toBeLessThan(30_000);
    expectCarryOn(step);
  });

  test("the workspace's remote is silent and names no default branch here: the look ends at its time limit and the step is the one a clone of solo work meets", () => {
    const { bea } = planAhead(SHAPES[0][1]());
    git(bea, ["remote", "set-head", "origin", "-d"]);
    git(bea, ["remote", "set-url", "origin", "ssh://silent.example/workspace.git"]);
    const sleeper = join(tempDir("ssh"), "never-answers.sh");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 60\n");
    chmodSync(sleeper, 0o755);
    const started = Date.now();
    const step = next(bea, { ...chat("bea-chat"), GIT_SSH_COMMAND: sleeper });
    expect(Date.now() - started).toBeLessThan(30_000);
    expectCarryOn(step);
  });

  test("the plan's repository spelled as only the planner's computer reaches it: the step is the one a clone of solo work meets", () => {
    const { bea } = planAhead(SHAPES[1][1](), undefined, checkoutApiAt(join(tempDir("planner-only"), "checkout-api.git")));
    expectCarryOn(next(bea, chat("bea-chat")));
  });

  test("a closed plan, or one of a format this AI-DLC does not read: the step is the one a clone of solo work meets", () => {
    const closed = (json: Record<string, unknown>) => ({ ...json, closed: { at: "2026-11-19T00:00:00Z" } });
    const newer = (json: Record<string, unknown>) => ({ ...json, format: 99 });
    for (const edit of [closed, newer]) {
      const { bea } = planAhead(SHAPES[0][1](), (home) => {
        expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
        pushEditedPlan(sharePlan(home), edit);
      });
      expectCarryOn(next(bea, chat("bea-chat")));
    }
  });

  test("the plan shared by name in another of the work's repositories: the step is the one a clone of solo work meets", () => {
    const { bea } = planAhead(SHAPES[1][1](), (home) => {
      expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
      expect(run(UNIT, ["share", "--plan", "--repo", "billing"], home.dir).status).toBe(0);
    });
    expectCarryOn(next(bea, chat("bea-chat")));
  });

  test("the planner's own checkout, nothing selected, before the answer: no look for a plan, and asked to carry it on", () => {
    const { home } = planAhead(SHAPES[0][1](), () => {});
    rmSync(join(home.dir, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
    const bare = remoteReads(home.dir, chat("planner-later"));
    expectCarryOn(bare.step);
    expect(bare.reads.filter((read) => read.includes("refs/aidlc/plans/"))).toEqual([]);
  });
});

describe("a build reads the plan at an address its builder says, after the repository moved hosts", () => {
  const notices = (step: Record<string, unknown>): string[] => ((step.change_notices ?? []) as string[]).filter((line) => line.startsWith("The plan of fixture"));
  const homeLocation = (pay: string): string | null => field(readFileSync(join(buildDir(pay, "refunds"), "aidlc-state.md"), "utf-8"), "Home Location");
  const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: name });
  // The person writes in that chat: a line kept for the reply they read goes once a step carried it.
  const writes = (dir: string, name: string): void => {
    expect(hook(dir, chat(name), { hook_event_name: "UserPromptSubmit", session_id: name, prompt: "go on" }).status).toBe(0);
  };
  // A copy of a repository at another path, every ref and commit kept, as a host move's mirror makes it.
  const mirrorOf = (host: string, label: string): string => {
    const at = join(tempDir(label), "repo.git");
    git(tempDir(`${label}-parent`), ["clone", "-q", "--mirror", host, at]);
    return at;
  };
  // pay took refunds at the old place; the repository moved hosts: a mirror at the new host, and the lead's take-over
  // there, one commit on the mirror's tip naming the new place as its own; nothing written at the old place.
  function movedHosts(units = ["refunds"]): { home: PlanHome; pay: string; old: string; mirror: string } {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing", "checkout-web"]);
    for (const unit of units) expect(run(UNIT, ["take", unit, "--plan", home.id8, "--from", old], pay).status).toBe(0);
    const mirror = mirrorOf(old, "new-host");
    const tip = git(mirror, ["rev-parse", planRefOf(home.id8)]);
    const json = JSON.parse(git(mirror, ["show", `${tip}:plan.json`])) as Record<string, unknown> & { version: number };
    pushPlanJson(home, mirror, { ...json, version: json.version + 1, plan_repo: { name: "checkout-api", address: mirror } }, tip, "all", "aidlc plan fixture");
    return { home, pay, old, mirror };
  }
  const heard18b = (step: Record<string, unknown>): string[] =>
    ((step.change_notices ?? []) as string[]).filter((line) => line.includes("was shared again since you took"));

  for (const [label, oldGone] of [["the old place still answers, read only", false], ["the old place is gone", true]] as const) {
    test(`the builder says the new address once: the build reads the plan there from then on, said once (${label})`, () => {
      const { pay, old, mirror } = movedHosts();
      if (oldGone) renameSync(old, `${old}.away`);
      else writeFileSync(join(old, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const said = next(pay, chat("pay-later"), ["--lead-address", mirror]);
      expect(notices(said), JSON.stringify(said).slice(0, 900)).toEqual([`The plan of fixture moved to checkout-api (${mirror}); this build reads it there now.`]);
      expect(homeLocation(pay)).toBe(mirror);
      writes(pay, "pay-later");
    const after = [next(pay, chat("pay-later")), next(pay, chat("pay-later-2"))];
      expect(after.flatMap(notices), JSON.stringify(after[1]).slice(0, 900)).toEqual([]);
      expect([said, ...after].flatMap(heard18b)).toEqual([]);
    });
  }

  test("another spelling of the new place, typed by the builder, is followed too: the two plans are compared, not the spelling", () => {
    const { pay, mirror } = movedHosts();
    const spelled = mirrorOf(mirror, "new-host-spelled");
    const said = next(pay, chat("pay-later"), ["--lead-address", spelled]);
    expect(notices(said), JSON.stringify(said).slice(0, 900)).toEqual([`The plan of fixture moved to checkout-api (${spelled}); this build reads it there now.`]);
    expect(homeLocation(pay)).toBe(spelled);
  });

  test("a copy of the old place, or the new place before the take-over, typed by the builder: the build stays where it reads", () => {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", old], pay).status).toBe(0);
    for (const [i, copy] of [mirrorOf(old, "old-alias"), mirrorOf(old, "new-host-early")].entries()) {
      const said = next(pay, chat(`pay-later-${i}`), ["--lead-address", copy]);
      expect(notices(said), JSON.stringify(said).slice(0, 900)).toEqual([]);
      expect(homeLocation(pay)).toBe(old);
    }
  });

  test("two builds of the work here are both read at the new place from the one address said", () => {
    const { pay, mirror } = movedHosts(["refunds", "checkout-ui"]);
    const said = next(pay, chat("pay-later"), ["--lead-address", mirror]);
    expect(notices(said).length, JSON.stringify(said).slice(0, 900)).toBeGreaterThan(0);
    for (const unit of ["refunds", "checkout-ui"]) {
      expect(field(readFileSync(join(buildDir(pay, unit), "aidlc-state.md"), "utf-8"), "Home Location"), unit).toBe(mirror);
    }
  });

  test("the old address said again after the build reads the new place: nothing changes and nothing is said", () => {
    const { pay, old, mirror } = movedHosts();
    expect(notices(next(pay, chat("pay-later"), ["--lead-address", mirror])).length).toBe(1);
    const back = next(pay, chat("pay-later-2"), ["--lead-address", old]);
    expect(notices(back), JSON.stringify(back).slice(0, 900)).toEqual([]);
    expect(homeLocation(pay)).toBe(mirror);
  });

  test("a workspace with both repositories and no build: of the two plans of the work, the one whose history holds the other is offered", () => {
    const { home, old, mirror } = movedHosts();
    const sam = teamWorkspace({ ...home.hosts, "checkout-api-moved": mirror }, "sam", ["checkout-api", "checkout-api-moved", "checkout-web"]);
    const offer = next(sam, chat("sam-later"), ["--units"]);
    const takes = ((offer.choices ?? []) as Array<{ command?: string }>).flatMap((choice) => (choice.command?.includes(" take ") ? [choice.command] : []));
    expect(takes.length, JSON.stringify(offer).slice(0, 900)).toBeGreaterThan(0);
    for (const take of takes) {
      expect(take).toContain(mirror);
      expect(take).not.toContain(old);
    }
  });

  // pay took refunds at the old place; the mirror is cut; a later word is written at the old place and pay reads it;
  // then the take-over at the mirror, one commit on the tip the mirror was cut at: neither plan holds the other.
  function parted(heardBefore: boolean): { home: PlanHome; pay: string; mirror: string } {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", old], pay).status).toBe(0);
    const json = JSON.parse(git(old, ["show", `${planRefOf(home.id8)}:plan.json`])) as Record<string, unknown> & { version: number };
    if (heardBefore) {
      // Shared again over what pay took, once already: a commit that is no plan, then the plan on it.
      const none = pushPlanJson(home, old, { ...json, units: "none" }, git(old, ["rev-parse", planRefOf(home.id8)]), "all", "edited");
      pushPlanJson(home, old, { ...json, version: json.version + 1 }, none, "all", "aidlc plan fixture");
      expect(heard18b(next(pay, chat("pay-heard")))).toHaveLength(1);
    }
    const mirror = mirrorOf(old, "parted-host");
    const cut = git(mirror, ["rev-parse", planRefOf(home.id8)]);
    pushPlanJson(home, old, { ...json, version: json.version + 2 }, cut, "all", "aidlc plan fixture");
    next(pay, chat("pay-reads-later-word"));
    pushPlanJson(home, mirror, { ...json, version: json.version + 3, plan_repo: { name: "checkout-api", address: mirror } }, cut, "all", "aidlc plan fixture");
    return { home, pay, mirror };
  }

  for (const [label, heardBefore] of [["", false], [", though it heard that line before", true]] as const) {
    test(`a build whose plan has parted from the plan at the address said reads it there and hears once that the plan was shared again${label}`, () => {
      const { pay, mirror } = parted(heardBefore);
      const said = next(pay, chat("pay-later"), ["--lead-address", mirror]);
      // The one line of the plan, in place of the moved line.
      expect(notices(said), JSON.stringify(said).slice(0, 900)).toEqual(["The plan of fixture in checkout-api was shared again since you took refunds; what you took stays as it was."]);
      expect(homeLocation(pay)).toBe(mirror);
      writes(pay, "pay-later");
    const after = [next(pay, chat("pay-later")), next(pay, chat("pay-later-2"))];
      expect(after.flatMap(notices), JSON.stringify(after[1]).slice(0, 900)).toEqual([]);
    });
  }

  test("a build whose record the move did not carry: the step where its builder says the new address records the take there first and offers it to carry on", () => {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", old], pay).status).toBe(0);
    // A move that carries the plan's ref and none of the records, and the take-over naming the new place for both.
    const moved = mirrorOf(old, "record-left-behind");
    const claim = `refs/aidlc/claims/${home.id8}/refunds`;
    git(moved, ["update-ref", "-d", claim]);
    const tip = git(moved, ["rev-parse", planRefOf(home.id8)]);
    const json = JSON.parse(git(moved, ["show", `${tip}:plan.json`])) as Record<string, unknown> & { version: number; repos: Array<{ name: string; address: string | null }> };
    pushPlanJson(home, moved, { ...json, version: json.version + 1, plan_repo: { name: "checkout-api", address: moved },
      repos: json.repos.map((repo) => (repo.name === "checkout-api" ? { ...repo, address: moved } : repo)) }, tip, "all", "aidlc plan fixture");
    const said = next(pay, chat("pay-later"), ["--lead-address", moved]);
    expect(notices(said), JSON.stringify(said).slice(0, 900)).toEqual([`The plan of fixture moved to checkout-api (${moved}); this build reads it there now.`]);
    expect(String(said.question), JSON.stringify(said).slice(0, 900)).not.toContain("by a teammate");
    expect(((said.choices ?? []) as Array<{ label: string }>).map((choice) => choice.label)).toContain("Carry on refunds");
    expect(git(moved, ["for-each-ref", "--format=%(refname)", claim])).toBe(claim);
  });

  test("a build whose plan's repository cannot be read is told it can give the plan's new address; a record's repository alone is not", () => {
    const home = makePlanHome();
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], pay).status).toBe(0);
    const unread = (step: Record<string, unknown>, repo: string): string[] =>
      ((step.change_notices ?? []) as string[]).filter((line) => line.startsWith(`${repo} could not be read just now`) && line.includes("so news from"));
    renameSync(home.hosts.billing, `${home.hosts.billing}.away`);
    const records = next(pay, chat("pay-records"));
    expect(unread(records, "billing"), JSON.stringify(records).slice(0, 900)).toHaveLength(1);
    expect(unread(records, "billing")[0]).toEndWith("so news from it may be behind.");
    renameSync(`${home.hosts.billing}.away`, home.hosts.billing);
    renameSync(home.hosts["checkout-api"], `${home.hosts["checkout-api"]}.away`);
    const plan = next(pay, chat("pay-plan"));
    expect(unread(plan, "checkout-api"), JSON.stringify(plan).slice(0, 900)).toHaveLength(1);
    expect(unread(plan, "checkout-api")[0]).toEndWith("so news from it may be behind. If the plan of fixture has moved from checkout-api, " +
      "tell me its new address and this build will read it there.");
  });

  // An ordinary move to a mirror the old place is still copied into: the plan at the mirror, one commit on the old tip
  // naming it, and the note at the old place; then the mirror's next copy writes the old place's tip, the note, over it.
  function movedToCopiedMirror(followFirst: boolean): { pay: string; old: string; mirror: string } {
    const home = makePlanHome();
    const old = home.hosts["checkout-api"];
    const pay = teamWorkspace(home.hosts, "pay", ["billing"]);
    expect(run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", old], pay).status).toBe(0);
    const mirror = mirrorOf(old, "kept-mirror");
    const tip = git(old, ["rev-parse", planRefOf(home.id8)]);
    const json = JSON.parse(git(old, ["show", `${tip}:plan.json`])) as Record<string, unknown> & { version: number; work: unknown };
    pushPlanJson(home, mirror, { ...json, version: json.version + 1, plan_repo: { name: "checkout-api", address: mirror } }, tip, "all", "aidlc plan fixture");
    pushPlanJson(home, old, { format: 1, work: json.work, moved_to: { name: "checkout-api", address: mirror } }, tip, "plan only",
      "aidlc plan fixture: moved to checkout-api");
    if (followFirst) {
      expect(notices(next(pay, chat("pay-follows")))).toEqual([`The plan of fixture moved to checkout-api (${mirror}); this build reads it there now.`]);
      expect(homeLocation(pay)).toBe(mirror);
    }
    git(mirror, ["fetch", "-q", "--prune", "origin"]);
    expect(git(mirror, ["rev-parse", planRefOf(home.id8)])).toBe(git(old, ["rev-parse", planRefOf(home.id8)]));
    return { pay, old, mirror };
  }

  for (const [label, followFirst] of [["before the build followed the move", false], ["after the build followed it", true]] as const) {
    test(`the mirror copied again over the plan that moved there (${label}): the build hears once that the plan is not held there`, () => {
      const { pay, old, mirror } = movedToCopiedMirror(followFirst);
      const step = next(pay, chat("pay-later"));
      expect(step.error, JSON.stringify(step).slice(0, 900)).toBeUndefined();
      expect(notices(step), JSON.stringify(step).slice(0, 900)).toEqual(["The plan of fixture says it moved, but checkout-api does not hold it, so this " +
        "build carries on from the copy here; no other Unit of it can be taken until the lead's project has put that right."]);
      writes(pay, "pay-later");
    expect(notices(next(pay, chat("pay-later")))).toEqual([]);
      expect(homeLocation(pay)).toBe(followFirst ? mirror : old);
    });
  }

  test("a look nobody typed never moves a build: the sweep finds the plan at the new place through a clone, and the build stays", () => {
    const { home, mirror, old } = movedHosts();
    const sam = teamWorkspace({ ...home.hosts, "checkout-api": mirror }, "sam", ["checkout-api", "checkout-web"]);
    expect(run(UNIT, ["take", "checkout-ui", "--plan", home.id8, "--from", old], sam).status).toBe(0);
    const swept = next(sam, chat("sam-later"), ["--units"]);
    expect(notices(swept), JSON.stringify(swept).slice(0, 900)).toEqual([]);
    expect(field(readFileSync(join(buildDir(sam, "checkout-ui"), "aidlc-state.md"), "utf-8"), "Home Location")).toBe(old);
  });
});

describe("a clone of the team's workspace when the lead moves the plan", () => {
  const chat = (name: string): NodeJS.ProcessEnv => ({ ...ENV, AIDLC_SESSION_OVERRIDE: name });

  test("a teammate's clone: its build follows and says so, the lead's line is never said there, and the lead's record there is left as it is", () => {
    const home = makePlanHomeWithRemote();
    // The lead planned the work in the lead's own checkout: the plan's own rows are in the lead's shard.
    asLeadsOwnCheckout(home.dir);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "planned"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
    const alice = cloneOf(home.remote, "alice");
    for (const name of ["checkout-api", "billing"]) cloneCode(home.hosts[name], alice, name, "alice");
    inSpace(alice, "payments");
    const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", home.hosts["checkout-api"]], alice);
    expect(took.status, took.out).toBe(0);
    const lead = seededStateFile(alice);
    const before = readFileSync(lead, "utf-8");
    movePlan(home, "billing");
    const step = next(alice, chat("alice-later"));
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 900))
      .toContain(`The plan of fixture moved to billing (${home.hosts.billing}); this build reads it there now.`);
    expect(JSON.stringify(step)).not.toContain("this computer writes it there now");
    expect(readFileSync(lead, "utf-8")).toBe(before);
  });

  test("a second computer of the lead's that said it leads the work here follows as the lead", () => {
    const home = makePlanHomeWithRemote();
    const old = home.hosts["checkout-api"];
    const laptop = cloneOf(home.remote, "lead");
    expect(run(UTILITY, ["intent", "switch", HOME_RECORD], laptop).status).toBe(0);
    const lifted = run(UNIT, ["lead-here", "--person-words", "I lead this work, carry it on here on my laptop"], laptop);
    expect(lifted.status, lifted.out).toBe(0);
    movePlan(home, "billing");
    // The look fetches the plan, as the lead's look does.
    git(laptop, ["fetch", "-q", old, `+${planRefOf(home.id8)}:${copyName(old, home.id8)}`]);
    const step = next(laptop, chat("laptop-later"));
    expect((step.change_notices ?? []) as string[], JSON.stringify(step).slice(0, 900))
      .toContain(`The plan of fixture moved to billing (${home.hosts.billing}); this computer writes it there now.`);
    expect(readFileSync(seededStateFile(laptop), "utf-8")).toContain(`- **Home Location**: ${home.hosts.billing}`);
  });
});

// covers: subcommand:aidlc-unit:take, function:lookAt, function:planAt, function:gitTargetFor, function:homeCopyOf
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoCopyKey } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  cleanupTeamBuild,
  cloneOf,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  inSpace,
  makeHome,
  makePlanHome,
  makePlanHomeWithRemote,
  next,
  ORCH,
  type PlanHome,
  planRefOf,
  recordAt,
  run,
  STATE,
  teamWorkspace,
  tempDir,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

// The look and the copy names, read when a case calls them.
const tools = async () => ({
  ...(await import("../../dist/claude/.claude/tools/aidlc-unit.ts")),
  ...(await import("../../dist/claude/.claude/tools/aidlc-unit-holders.ts")),
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
    // One fetch of the plan, never ls-remote with a pattern, never the lead's branch.
    const calls = readFileSync(trace, "utf-8").split(/\r?\n/).filter((line) => line.includes("trace: built-in: git ") || line.includes("trace: run_command: git"));
    expect(calls.filter((line) => / fetch .*refs\/aidlc\/plans\//.test(line))).toHaveLength(1);
    expect(calls.some((line) => / ls-remote .*refs\/aidlc\/\*/.test(line))).toBe(false);
    expect(calls.some((line) => / fetch .*refs\/heads\//.test(line))).toBe(false);
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
    expect(step.out).toContain(`${nowhere} could not be read: `);
    expect(step.out).not.toContain("has no plan shared in it");
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

  test("the address said is read first, as the person's own step: never quiet, and never skipped for a silent repository on its host", () => {
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
    expect(fresh.out).toContain(`${plan} does not have this plan now.`);
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
    expect(took.out).toContain(`${HOME_RECORD} is built by teams: its Units are taken from the plan.`);
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
    expect(took.out).toContain(`${HOME_RECORD} is built by teams: its Units are taken from the plan. Run \``);
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
    // A clone on disk that repos.json does not list, whose URL carries a sign-in.
    const billing = join(pay, "billing");
    git(pay, ["init", "-q", "-b", "main", billing]);
    git(billing, ["remote", "add", "origin", "https://lead:s3cret@example.invalid/org/billing.git"]);
    // A repos.json url that carries one, with no clone on disk.
    writeFileSync(join(pay, "repos.json"), `${JSON.stringify({ repos: [{ name: "ledger", url: "https://lead:t0ken@example.invalid/org/ledger.git" }] })}\n`);
    const trace = join(tempDir("trace"), "git.trace");
    run(ORCH, ["next", "--units"], pay, { ...ENV, GIT_TRACE: trace });
    // AI-DLC's own git calls (git's helper for https is handed the URL by git itself, as for any fetch in that clone).
    const calls = readFileSync(trace, "utf-8").split("\n").filter((line) => /trace: (built-in|exec|run_command): git fetch/.test(line));
    expect(calls.some((line) => line.includes("example.invalid/org/billing.git")), calls.join("\n")).toBe(true);
    expect(calls.some((line) => line.includes("example.invalid/org/ledger.git")), calls.join("\n")).toBe(true);
    expect(calls.filter((line) => /s3cret|t0ken/.test(line)), calls.join("\n")).toEqual([]);
  });

  test("records are read with a clone's own sign-in when its URL carries one, which never goes on git's command line", async () => {
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
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *refs/aidlc/claims*) echo "$* | $(env | grep '^GIT_CONFIG_' | tr '\\n' ' ')" >> '${log}'; exit 1;; esac\nexec ${Bun.which("git")} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      refreshHomeClaims(pay, { home: { id8: "00000001", location: address }, now: true });
    } finally {
      process.env.PATH = path;
    }
    const [args, settings] = readFileSync(log, "utf-8").split("\n")[0].split(" | ");
    expect(args).not.toContain("s3cret");
    expect(settings).toContain("insteadOf");
  });
});

// Shared fixture for teams building each Unit as work of their own (#2410):
// a home workspace repo at the first Construction step, pushed to a bare
// "host", the checkout example's Units (refunds, checkout-ui, reporting; reporting
// waits on refunds), code repos as bare hosts, and clones for each team.
// Every git call is offline and hermetic.

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "./fixtures.ts";
import { readConductorSurface } from "./conductor-skill.ts";
import { copyOf } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import { asLeadsOwnCheckout } from "./team-unit-merge.ts";

export const UNIT = join(AIDLC_SRC, "tools", "aidlc-unit.ts");
export const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
export const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const D = String.fromCharCode(0x2014);
const dirs: string[] = [];
const projects: string[] = [];

/** Remove every workspace, clone and host a case made; register as afterEach. */
export function cleanupTeamBuild(): void {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
}

// Offline and without background maintenance (git 2.47+ repacks after writes,
// which races back-to-back commands in small repos).
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

export function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `aidlc-team-${label}-`)));
  dirs.push(dir);
  return dir;
}

export const DEPENDENCIES = `# Unit dependencies

\`\`\`yaml
units:
  - name: refunds
    kind: service
    repos: [checkout-api, billing]
    depends_on: []
  - name: checkout-ui
    kind: ui
    repos: [checkout-web]
    depends_on: []
  - name: reporting
    kind: service
    repos: [billing]
    depends_on: [refunds]
\`\`\`
`;

/** The home's state as Inception ends: Construction entered, nothing built, nobody asked who builds. */
export function homeState(extraRuntime: string[] = []): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: checkout revamp
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial
${extraRuntime.join("\n")}

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] requirements-analysis ${D} EXECUTE
- [x] units-generation ${D} EXECUTE
- [x] delivery-planning ${D} EXECUTE

### CONSTRUCTION PHASE
- [-] functional-design ${D} EXECUTE
- [ ] nfr-requirements ${D} EXECUTE
- [ ] nfr-design ${D} EXECUTE
- [ ] infrastructure-design ${D} EXECUTE
- [ ] code-generation ${D} EXECUTE
- [ ] build-and-test ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`;
}

export interface Home {
  /** The lead's clone: the home workspace. */
  dir: string;
  /** The bare host the workspace is pushed to. */
  remote: string;
}

/** The home workspace, committed and pushed to its own bare host. */
export function makeHome(options: { state?: string; dependencies?: string; repos?: Record<string, string> } = {}): Home {
  const dir = homeWorkspace(options);
  const remote = tempDir("home-host");
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, remote };
}

/** The home workspace at the first Construction step, committed, with no remote. */
function homeWorkspace(options: { state?: string; dependencies?: string; repos?: Record<string, string> }): string {
  const dir = createTestProject();
  projects.push(dir);
  seedAidlcMemory(dir);
  writeFileSync(seededStateFile(dir), options.state ?? homeState());
  const units = join(seededRecordDir(dir), "inception", "units-generation");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "unit-of-work-dependency.md"), options.dependencies ?? DEPENDENCIES);
  writeFileSync(join(units, "unit-of-work.md"), "# Units of work\n\nrefunds, checkout-ui, reporting.\n");
  const requirements = join(seededRecordDir(dir), "inception", "requirements-analysis");
  mkdirSync(requirements, { recursive: true });
  writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\nFR1 refunds.\n");
  // The work's code repos, by name and host: recorded for the work, cloned as
  // the workspace's children, and left out of the workspace's own repo. Teams
  // build Units as work of their own where the work records repos, so a home
  // has one unless the test asks for none (`repos: {}`, main's team flow). A
  // blank host is a repo the home has no address or copy of.
  const hosts = options.repos ?? { app: codeHost("app") };
  const repos = Object.keys(hosts);
  if (repos.length > 0) {
    const registryPath = join(dir, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = repos;
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    for (const [name, host] of Object.entries(hosts)) if (host !== "") cloneCode(host, dir, name);
    // Committed, as a team keeps it, so every clone knows where its repos go.
    writeFileSync(join(dir, "repos.json"), `${JSON.stringify({ repos: Object.entries(hosts).map(([name, url]) => ({ name, url })) }, null, 2)}\n`);
  }
  writeFileSync(
    join(dir, ".gitignore"),
    "aidlc/.aidlc-engine/clone-id\naidlc/.aidlc-engine/sessions/\naidlc/active-space\naidlc/spaces/*/intents/active-intent\n" +
      "aidlc/.aidlc-engine/units/claimed.json\naidlc/.aidlc-engine/units/claim-generations.json\naidlc/.aidlc-engine/units/claim-registry.json\n" +
      "**/aidlc/spaces/*/intents/**/.aidlc-engine/\n" + repos.map((name) => `/${name}/\n`).join(""),
  );
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "lead"]);
  git(dir, ["config", "user.email", "lead@example.test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "inception"]);
  return dir;
}

export interface PlanHome {
  /** The lead's workspace: a git repository with no remote of its own. */
  dir: string;
  /** Each code repository's bare host, by name, in the work's order. */
  hosts: Record<string, string>;
  /** The work's id, as the plan's ref names it. */
  id8: string;
  /** The plan's commit on its host after the share, or null when not shared. */
  plan: string | null;
}

/** The plan's ref at a host for a work id. */
export const planRefOf = (id8: string): string => `refs/aidlc/plans/${id8}`;

/**
 * The lead's workspace whose plan goes to a code repository: a git repository
 * with no remote of its own, each code repository a bare host cloned beside
 * it, several teams chosen unless `teams` is false, and the plan shared
 * unless `share` is false.
 */
export function makePlanHome(
  options: { state?: string; dependencies?: string; repos?: Record<string, string>; share?: boolean; teams?: boolean } = {},
): PlanHome {
  const hosts = options.repos ?? { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") };
  const dir = homeWorkspace({ ...options, repos: hosts });
  const registry = JSON.parse(readFileSync(join(dir, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as Array<{ uuid: string }>;
  const id8 = registry[0].uuid.replace(/-/g, "").slice(-8);
  if (options.teams === false) return { dir, hosts, id8, plan: null };
  const chose = run(STATE, ["set-unit-ownership", "team"], dir);
  expect(chose.status, chose.out).toBe(0);
  if (options.share === false) return { dir, hosts, id8, plan: null };
  const shared = run(UNIT, ["share", "--plan"], dir);
  expect(shared.status, shared.out).toBe(0);
  const first = Object.values(hosts)[0];
  return { dir, hosts, id8, plan: git(first, ["rev-parse", planRefOf(id8)]) };
}

/**
 * The plan home of a lead who keeps their workspace on a host of its own: the
 * workspace, teams chosen, committed and pushed to `remote` as origin, then the
 * plan shared, so the lead's own pushes and fetches and a teammate's clone of it
 * go there, and the plan still goes to its code repository.
 */
export function makePlanHomeWithRemote(options: { state?: string; dependencies?: string; repos?: Record<string, string> } = {}): PlanHome & Home {
  const home = makeHome({ ...options, repos: options.repos ?? { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") } });
  const chose = run(STATE, ["set-unit-ownership", "team"], home.dir);
  expect(chose.status, chose.out).toBe(0);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  return sharePlan(home);
}

/**
 * The lead's `unit share --plan` on a home whose teams are chosen: the plan goes
 * to the work's first code repository, and the home reads as a plan home.
 */
export function sharePlan(home: Home): PlanHome & Home {
  const shared = run(UNIT, ["share", "--plan"], home.dir);
  expect(shared.status, shared.out).toBe(0);
  // The plan's repository first, as the share names it, then the work's others.
  const plan = shared.json?.plan as { repo: string; address: string; commit: string };
  const listed = existsSync(join(home.dir, "repos.json"))
    ? (JSON.parse(readFileSync(join(home.dir, "repos.json"), "utf-8")) as { repos: Array<{ name: string; url?: string }> }).repos
    : [];
  const hosts = Object.fromEntries([[plan.repo, plan.address],
    ...listed.filter((repo) => repo.name !== plan.repo && repo.url).map((repo) => [repo.name, repo.url!])]);
  const registry = JSON.parse(readFileSync(join(home.dir, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as Array<{ uuid: string }>;
  return { ...home, hosts, id8: registry[0].uuid.replace(/-/g, "").slice(-8), plan: plan.commit };
}

/** A code repo's bare host with one commit on main. */
export function codeHost(label: string): string {
  const seed = tempDir(`${label}-seed`);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "lead"]);
  git(seed, ["config", "user.email", "lead@example.test"]);
  writeFileSync(join(seed, "README.md"), `# ${label}\n`);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "start"]);
  const host = tempDir(`${label}-host`);
  git(host, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["remote", "add", "origin", host]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  return host;
}

/** A printed `bun ...` command as a bash line: this Bun, its path quoted with
 * forward slashes, since bash on Windows reads a backslash as an escape. */
export function bashLine(command: string): string {
  return command.replace(/^bun /, `'${process.execPath.replace(/\\/g, "/")}' `);
}

/** A clone of a code host as a workspace's child repo. */
export function cloneCode(host: string, workspace: string, name: string, user = "lead"): string {
  const dir = join(workspace, name);
  git(workspace, ["clone", "-q", host, dir]);
  git(dir, ["config", "user.name", user]);
  git(dir, ["config", "user.email", `${user}@example.test`]);
  return dir;
}

/** A teammate's clone of a workspace host. */
export function cloneOf(remote: string, label: string): string {
  const parent = tempDir(`clone-${label}`);
  const dir = join(parent, "workspace");
  git(parent, ["clone", "-q", remote, dir]);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

export const ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};

export interface RunResult {
  status: number;
  out: string;
  stdout: string;
  json: Record<string, unknown> | null;
}

export function run(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = ENV): RunResult {
  // `next` reads every token after its flags as the person's words.
  const argv = args[0] === "next" && args.length > 1
    ? [args[0], "--project-dir", cwd, ...args.slice(1)]
    : [...args, "--project-dir", cwd];
  const result = spawnSync(process.execPath, [tool, ...argv], { cwd, encoding: "utf-8", env });
  // The last JSON line the tool printed: its result, or its refusal.
  let json: Record<string, unknown> | null = null;
  for (const stream of [result.stdout, result.stderr]) {
    try {
      json = JSON.parse((stream ?? "").trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
      break;
    } catch {
      json = null;
    }
  }
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "", json };
}

/** A take offer's text without who last changed the plan and when, for a case that reads the rest of it. */
export const offerText = (text: unknown): string => String(text).replace(/ \(the plan's last commit: [^)]*\)/, "");

/**
 * `next`, with rules delivered in parts taken as the agent takes them, and the
 * agent's draft of a Unit's commit message taken as an agent that keeps today's
 * message does (unless `stopAtDraft`): checked each time, and never given
 * twice. `orch` is another tree's engine.
 */
export function next(
  cwd: string,
  env: NodeJS.ProcessEnv = ENV,
  args: string[] = [],
  orch = ORCH,
  options: { stopAtDraft?: boolean } = {},
): Record<string, unknown> {
  let result = run(orch, ["next", ...args], cwd, env);
  let drafted = false;
  for (let parts = 0; parts < 50; parts++) {
    expect(result.status, result.out).toBe(0);
    const directive = JSON.parse(result.stdout) as Record<string, unknown>;
    if (isDraftStep(directive) && !options.stopAtDraft) {
      expect(drafted, `the draft step came twice: ${result.stdout}`).toBe(false);
      expectDraftStep(cwd, directive);
      drafted = true;
      result = run(orch, ["next"], cwd, env);
      continue;
    }
    if (directive.kind !== "load-steering" || typeof directive.receipt !== "string") return directive;
    result = run(orch, ["continue", directive.receipt], cwd, env);
  }
  throw new Error("rules never finished arriving");
}

/** The agent's step to draft a Unit's commit message before its push question. */
export function isDraftStep(step: Record<string, unknown>): boolean {
  return step.kind === "print" && typeof step.commit_message_file === "string";
}

/** The draft step as the agent meets it: silent, its file holding today's message, which the step names. */
export function expectDraftStep(cwd: string, step: Record<string, unknown>): string {
  expect(isDraftStep(step), JSON.stringify(step)).toBe(true);
  expect(step.narration, JSON.stringify(step)).toBeUndefined();
  const file = String(step.commit_message_file);
  const held = readFileSync(join(cwd, ...file.split("/")), "utf-8");
  // A Unit's push holds "<unit>: <home>"; the share's and the record's hold their own one-line fallback.
  const shape = file.includes("/unit-push-message-") ? /^[^\n]+: [^\n]+\n?$/ : /^[^\n]+\n?$/;
  expect(held, `the draft file holds today's message: ${JSON.stringify(step)}`).toMatch(shape);
  expect(String(step.message)).toContain(`\`${held.trim()}\``);
  return file;
}

// A line for the person that tells them what to type, in place of an offer the
// agent puts to them: none of the build-out's lines may.
// The step kinds every harness's orchestrator skill has a row for in its step
// table: what a fresh chat, with no other module read yet, acts on.
export function kindsEverySkillHandles(): Set<string> {
  const skills = readdirSync(join(REPO_ROOT, "harness")).map((name) => join(REPO_ROOT, "harness", name, "skills", "aidlc", "SKILL.md"))
    .filter((path) => existsSync(path));
  expect(skills).toHaveLength(7);
  const tables = skills.map((path) =>
    new Set([...readConductorSurface(path).matchAll(/^\| `([a-z-]+)` \|/gm)].map((row) => row[1]).filter((kind) => kind !== "kind")));
  return new Set([...tables[0]].filter((kind) => tables.every((table) => table.has(kind))));
}

export function tellsWhatToType(...lines: unknown[]): boolean {
  return lines.some((line) => /\b[Ss]ay (?:["']|push\b|go back|so\b|it your way)|\btype \/aidlc/.test(JSON.stringify(line ?? "")));
}

/** The person's own fetch, and what AI-DLC's look adds to it in a clone: its copies of the teams' records, which that
 * fetch never brings. With a plan copied here, the look also reads the plan where it is shared and each Unit's record
 * in the repository the plan names for it. */
export function fetchRecords(dir: string, remote?: string): void {
  const origin = remote ?? (git(dir, ["remote"]).split("\n").includes("origin") ? "origin" : null);
  if (origin !== null) {
    git(dir, ["fetch", "-q", origin]);
    // AI-DLC's look in this clone: each work's records into its copy of them by the remote's address.
    const address = git(dir, ["remote", "get-url", origin]);
    const works = new Set(git(dir, ["ls-remote", origin, "refs/aidlc/claims/*"]).split("\n")
      .map((line) => /\trefs\/aidlc\/claims\/([^/]+)\//.exec(line)?.[1]).filter((id8): id8 is string => id8 !== undefined));
    for (const id8 of works) git(dir, ["fetch", "-q", "--no-tags", origin, `+refs/aidlc/claims/${id8}/*:${copyOf(address, `refs/aidlc/claims/${id8}/`)}*`]);
  }
  const plans = git(dir, ["for-each-ref", "--format=%(refname)", "refs/aidlc/home/"]).split("\n").filter((ref) => ref.endsWith("/plan"));
  for (const ref of plans) {
    const id8 = ref.split("/")[3];
    const plan = JSON.parse(git(dir, ["show", `${ref}:plan.json`])) as {
      plan_repo: { address: string }; repos: Array<{ name: string; address: string | null }>; units: Array<{ record: string }>;
    };
    const quiet = (args: string[]): void => {
      spawnSync("git", args, { cwd: dir, encoding: "utf-8", env: GIT_ENV });
    };
    quiet(["fetch", "-q", "--no-tags", plan.plan_repo.address, `+refs/aidlc/plans/${id8}:${copyOf(plan.plan_repo.address, `refs/aidlc/plans/${id8}`)}`]);
    const records = new Set(plan.units.map((unit) => plan.repos.find((repo) => repo.name === unit.record)?.address ?? null)
      .filter((address): address is string => address !== null));
    for (const address of records) {
      quiet(["fetch", "-q", "--no-tags", address, `+refs/aidlc/claims/${id8}/*:${copyOf(address, `refs/aidlc/claims/${id8}/`)}*`]);
    }
  }
}

// A Unit's record at a host: a claim commit's claim file (main's flow), else
// a build-out record's unit.json.
export function claimPayload(remote: string, intentId8: string, unit: string): Record<string, unknown> | null {
  const ref = `refs/aidlc/claims/${intentId8}/${unit}`;
  const tip = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: remote, encoding: "utf-8", env: GIT_ENV });
  if (tip.status !== 0) return null;
  const claim = spawnSync("git", ["show", `${tip.stdout.trim()}:.aidlc-unit-claim.json`], { cwd: remote, encoding: "utf-8", env: GIT_ENV });
  return JSON.parse(claim.status === 0 ? claim.stdout : git(remote, ["show", `${tip.stdout.trim()}:unit.json`])) as Record<string, unknown>;
}

/** The host the work's records are written to: the plan's repository here. */
export const recordHost = (home: PlanHome): string => Object.values(home.hosts)[0];

/** A take's `--plan` and `--from` for a Unit of a shared plan. */
export const planFrom = (home: PlanHome): string[] => ["--plan", home.id8, "--from", Object.values(home.hosts)[0]];

/**
 * A Unit's record at the host it is written to, as the build-out writes it: its unit.json, every path in the record
 * commit's tree, the tip's subject and parents. Null when the host has no such record. Callers name the plan home and
 * the Unit, never a host: the record is in the repository the shared plan names for that Unit.
 */
export function recordAt(home: PlanHome, unit: string): { json: Record<string, unknown>; files: string[]; message: string; parents: string[] } | null {
  const host = recordHostOf(home, unit);
  const ref = `refs/aidlc/claims/${home.id8}/${unit}`;
  const tip = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: host, encoding: "utf-8", env: GIT_ENV });
  if (tip.status !== 0) return null;
  const oid = tip.stdout.trim();
  const [message, parents] = git(host, ["log", "-1", "--format=%s%x00%P", oid]).split("\0");
  return {
    json: JSON.parse(git(host, ["show", `${oid}:unit.json`])) as Record<string, unknown>,
    files: git(host, ["ls-tree", "-r", "--name-only", oid]).split("\n").filter(Boolean),
    message,
    parents: parents === "" ? [] : parents.split(" "),
  };
}

/** The lead's word on a Unit as the plan at its host holds it (plan.json's units[].word); undefined for a Unit it lacks. */
export function planWordAt(home: PlanHome, unit: string): Record<string, unknown> | undefined {
  const plan = JSON.parse(git(Object.values(home.hosts)[0], ["show", `${planRefOf(home.id8)}:plan.json`])) as {
    units: Array<{ name: string; word: Record<string, unknown> }>;
  };
  return plan.units.find((entry) => entry.name === unit)?.word;
}

/** The bare host of the repository the shared plan names for a Unit's record (plan.json's units[].record). */
export function recordHostOf(home: PlanHome, unit: string): string {
  const plan = JSON.parse(git(Object.values(home.hosts)[0], ["show", `${planRefOf(home.id8)}:plan.json`])) as { units: Array<{ name: string; record: string }> };
  const name = plan.units.find((entry) => entry.name === unit)?.record;
  if (name === undefined || home.hosts[name] === undefined) throw new Error(`the plan names no host for ${unit}'s record`);
  return home.hosts[name];
}

export function stateOf(dir: string): string {
  return readFileSync(seededStateFile(dir), "utf-8");
}

export const HOME_RECORD = "fixture-8000000000000001";

// The space a teammate works in: made in their clone and switched to, so a
// take there builds there.
export function inSpace(dir: string, space: string): void {
  if (!existsSync(join(dir, "aidlc", "spaces", space, "memory"))) {
    const made = run(UTILITY, ["space-create", space], dir);
    expect(made.status, made.out).toBe(0);
  }
  const switched = run(UTILITY, ["space", space], dir);
  expect(switched.status, switched.out).toBe(0);
}

// `unit take` from the space the person works in, made and switched to first.
export function takeIn(space: string, args: string[], dir: string, env: NodeJS.ProcessEnv = ENV): RunResult {
  inSpace(dir, space);
  return run(UNIT, ["take", ...args], dir, env);
}

// A team's own workspace: a git repository with no remote, nothing of the
// lead's in it, the code repositories it builds in (`repos`, by name in
// `hosts`) cloned beside it as `label`.
export function teamWorkspace(hosts: Record<string, string>, label: string, repos: string[] = Object.keys(hosts)): string {
  const dir = join(tempDir(`${label}-ws`), "workspace");
  mkdirSync(dir, { recursive: true });
  seedAidlcMemory(dir);
  writeFileSync(join(dir, ".gitignore"), "aidlc/.aidlc-engine/\naidlc/active-space\naidlc/spaces/*/intents/active-intent\n" +
    "**/aidlc/spaces/*/intents/**/.aidlc-engine/\n" + repos.map((name) => `/${name}/\n`).join(""));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "workspace"]);
  for (const name of repos) cloneCode(hosts[name], dir, name, label);
  return dir;
}

// The plan of work across checkout-api and billing, teams chosen and the plan
// shared in checkout-api, the lead's workspace on a host of its own; a
// teammate's workspace of her own with both repos, working in the payments
// space, refunds taken there from the plan. Another Unit plan (`dependencies`)
// replaces DEPENDENCIES. The work's records are read with recordAt.
export function refundsTaken(beforeTake?: (alice: string) => void, dependencies?: string) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makePlanHomeWithRemote({ repos: hosts, ...(dependencies === undefined ? {} : { dependencies }) });
  const alice = teamWorkspace(hosts, "alice");
  beforeTake?.(alice);
  inSpace(alice, "payments");
  const took = run(UNIT, ["take", "refunds", "--plan", home.id8, "--from", hosts["checkout-api"]], alice);
  expect(took.status, took.out).toBe(0);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
  return { hosts, home, alice, record };
}

// refunds taken as refundsTaken takes it, by a teammate whose workspace is a
// clone of the lead's, which several teams share: the lead's work is on disk in
// it, and its origin is the lead's workspace's own host. `env` is the take's.
export function refundsTakenInClone(beforeTake?: (alice: string) => void, dependencies?: string, env: NodeJS.ProcessEnv = ENV) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing") };
  const home = makePlanHomeWithRemote({ repos: hosts, ...(dependencies === undefined ? {} : { dependencies }) });
  const alice = cloneOf(home.remote, "alice");
  for (const [name, host] of Object.entries(hosts)) cloneCode(host, alice, name, "alice");
  beforeTake?.(alice);
  inSpace(alice, "payments");
  const took = run(UNIT, ["take", "refunds", ...planFrom(home)], alice, env);
  expect(took.status, took.out).toBe(0);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!);
  return { hosts, home, alice, record };
}

// What Code Generation leaves: the files, and the manifest of what it wrote.
export function codeGenerated(alice: string, record: string): void {
  mkdirSync(join(alice, "checkout-api", "src"), { recursive: true });
  writeFileSync(join(alice, "checkout-api", "src", "refunds.ts"), "export const refunds = 1;\n");
  mkdirSync(join(alice, "billing", "lib"), { recursive: true });
  writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 1;\n");
  const stage = join(record, "construction", "refunds", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation",
    unit: "refunds",
    version: 1,
    writes: [{ repo: "checkout-api", path: "src/refunds.ts" }, { repo: "billing", path: "lib/refund.ts" }],
  }, null, 2)}\n`);
  writeFileSync(join(stage, "code-summary.md"), "# Code summary\n\nRefunds.\n");
}

// Code Generation run again after a turn-down: the same files with the home's
// change, written on whatever branch each repo is on.
export function codeGeneratedAgain(alice: string): void {
  mkdirSync(join(alice, "checkout-api", "src"), { recursive: true });
  writeFileSync(join(alice, "checkout-api", "src", "refunds.ts"), "export const refunds = 2;\n");
  mkdirSync(join(alice, "billing", "lib"), { recursive: true });
  writeFileSync(join(alice, "billing", "lib", "refund.ts"), "export const refund = 2;\n");
}

// Merge a Unit's branch on a code host the way a team would, from a clone. A
// rebase merge replays the branch onto a main that moved meanwhile, as a host's
// "rebase and merge" does, so every commit gets a new id.
export function mergeOnHost(host: string, branch: string, how: "squash" | "merge" | "rebase"): void {
  const dir = join(tempDir("merger"), "repo");
  git(tempDir("merger-parent"), ["clone", "-q", host, dir]);
  git(dir, ["config", "user.name", "reviewer"]);
  git(dir, ["config", "user.email", "reviewer@example.test"]);
  git(dir, ["fetch", "-q", "origin", branch]);
  if (how === "squash") {
    git(dir, ["merge", "-q", "--squash", `origin/${branch}`]);
    git(dir, ["commit", "-q", "-m", `${branch} (squashed)`]);
  } else if (how === "rebase") {
    writeFileSync(join(dir, `before-${branch}.md`), "Merged first.\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `before ${branch}`]);
    git(dir, ["switch", "-q", "-c", `rebased-${branch}`, `origin/${branch}`]);
    git(dir, ["rebase", "-q", "main"]);
    git(dir, ["switch", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", `rebased-${branch}`]);
  } else {
    git(dir, ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, `origin/${branch}`]);
  }
  git(dir, ["push", "-q", "origin", "main"]);
}

// Every planned stage of the build done and approved, and the build finished.
export function finishBuild(record: string): void {
  const statePath = join(record, "aidlc-state.md");
  writeFileSync(statePath, readFileSync(statePath, "utf-8")
    .replace(/^- \[[-? ]\] (functional-design|nfr-requirements|nfr-design|infrastructure-design|code-generation) /gm, "- [x] $1 ")
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation")
    .replace(/^- \*\*Status\*\*: .*$/m, "- **Status**: Completed"));
}

// The person's own chat: the presence guard on, as in a real run.
export function personsChat(session: string): NodeJS.ProcessEnv {
  const chat: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: session };
  delete chat.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  return chat;
}

// The person types /aidlc in their chat: the prompt's hook runs, then the step.
export function personsNext(dir: string, chat: NodeJS.ProcessEnv, session: string): Record<string, unknown> {
  expect(hook(dir, chat, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "/aidlc" }).status).toBe(0);
  return next(dir, chat);
}

// One of Claude Code's hooks, as the host calls it in the person's project.
export function hook(dir: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown>): { status: number; out: string } {
  const r = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook",
    payload.hook_event_name === "UserPromptSubmit" ? "record-human-turn" : "guard-tool-call"], {
    cwd: dir, encoding: "utf-8", env: { ...env, CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir }, input: JSON.stringify({ cwd: dir, ...payload }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A team's commit message convention, as their own tools keep it: the first
// line starts with a ticket key. TICKET_HOOK_WORDS is what their commit-msg
// hook says (commitlint or a script in their repo), TICKET_RULE_WORDS what
// their host says when a push carries a commit without one (a GitLab push rule).
export const TICKET_HOOK_WORDS = "commit-msg: message must start with a ticket key (PAY-123 ...)";
export const TICKET_RULE_WORDS = "GitLab: Commit message does not follow the pattern '^[A-Z]+-[0-9]+ '";

/** Their commit-msg hook in a clone: a message without a ticket key is refused. */
export function ticketKeyHook(repo: string): void {
  const file = join(repo, ".git", "hooks", "commit-msg");
  writeFileSync(file, `#!/bin/sh\nhead -n 1 "$1" | grep -qE '^[A-Z]+-[0-9]+ ' && exit 0\necho '${TICKET_HOOK_WORDS}' >&2\nexit 1\n`);
  chmodSync(file, 0o755);
}

/** Their host's rule on a bare code host: a push whose new commits lack a ticket key is refused. */
export function ticketKeyRule(host: string): void {
  const file = join(host, "hooks", "pre-receive");
  writeFileSync(file, "#!/bin/sh\nwhile read old new ref; do\n  for c in $(git rev-list \"$new\" --not --all); do\n" +
    `    git log -1 --format=%s "$c" | grep -qE '^[A-Z]+-[0-9]+ ' || { echo "${TICKET_RULE_WORDS}" >&2; exit 1; }\n` +
    "  done\ndone\nexit 0\n");
  chmodSync(file, 0o755);
}

/** The build's message file: the commit message its push carries, one per build (its record). */
export function commitMessageFile(record: string): string {
  return `aidlc/.aidlc-engine/request-text/unit-push-message-${basename(record).replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`;
}

/** A commit message written where the build's push reads it, as the agent writes it with its file tool. */
export function commitMessage(workspace: string, record: string, text: string): string {
  const file = commitMessageFile(record);
  mkdirSync(join(workspace, "aidlc", ".aidlc-engine", "request-text"), { recursive: true });
  writeFileSync(join(workspace, ...file.split("/")), text);
  return file;
}

/**
 * The lead's work in a teammate's clone of the lead's workspace: the plan approved in the lead's own checkout (its
 * shard holds the plan's rows), teams chosen, the plan shared in checkout-api, the workspace on a host of its own;
 * `signOff`: the lead's sign-off on, committed and pushed; alice took refunds in a workspace of her own and pushed
 * it, merged on both hosts with `merged`; carl cloned the lead's workspace with every repo and selected the lead's
 * work, and has not said he leads it.
 */
export function teammateWithLeadsWork(options: { signOff?: boolean; merged?: boolean } = {}) {
  const hosts = { "checkout-api": codeHost("checkout-api"), billing: codeHost("billing"), "checkout-web": codeHost("checkout-web") };
  const home = makeHome({ repos: hosts });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  asLeadsOwnCheckout(home.dir);
  git(home.dir, ["add", "-A"]);
  git(home.dir, ["commit", "-q", "-m", "teams"]);
  git(home.dir, ["push", "-q", "origin", "main"]);
  const plan = sharePlan(home);
  if (options.signOff) {
    expect(run(UNIT, ["lead-sign-off", "on", "--person-words", "I want to sign off every team's result"], home.dir).status).toBe(0);
    git(home.dir, ["add", "-A"]);
    git(home.dir, ["commit", "-q", "-m", "sign-off on"]);
    git(home.dir, ["push", "-q", "origin", "main"]);
  }
  const alice = teamWorkspace(hosts, "alice", ["checkout-api", "billing"]);
  inSpace(alice, "payments");
  expect(run(UNIT, ["take", "refunds", ...planFrom(plan)], alice).status).toBe(0);
  const intents = join(alice, "aidlc", "spaces", "payments", "intents");
  codeGenerated(alice, join(intents, readdirSync(intents).find((name) => name.endsWith("-refunds"))!));
  expect(run(UNIT, ["push"], alice).status).toBe(0);
  if (options.merged) {
    mergeOnHost(hosts["checkout-api"], "refunds", "squash");
    mergeOnHost(hosts.billing, "refunds", "squash");
  }
  const carl = cloneOf(home.remote, "carl");
  for (const [name, host] of Object.entries(hosts)) cloneCode(host, carl, name, "carl");
  expect(run(UTILITY, ["intent", "switch", HOME_RECORD], carl).status).toBe(0);
  return { hosts, home, plan, alice, carl };
}

// covers: tool:aidlc-pr, subcommand:aidlc-state:unit,
// subcommand:aidlc-orchestrate:next, audit:PR_MERGED

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  findAllEvents,
  getField,
  readAllAuditShards,
  readStateFile,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  emitOpenReceipts,
  type PullSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-pr.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const PR = join(AIDLC_SRC, "tools", "aidlc-pr.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function state(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: PR finalize fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Active Agent**: aidlc-pipeline-deploy-agent

## Scope Configuration
- **Stages to Execute**: 3.5, 3.6, 3.7
- **Stages to Skip**: all others
- **Depth**: Standard
- **Test Strategy**: Standard

## Runtime State
- **Revision Count**: 0
- **Integration Mode**: pr

## Phase Progress
- **Initialization**: Verified
- **Ideation**: Skipped
- **Inception**: Verified
- **Construction**: Active
- **Operation**: Pending

## Stage Progress

### CONSTRUCTION PHASE
- [x] code-generation — EXECUTE
- [-] pr-integration — EXECUTE
- [ ] build-and-test — EXECUTE
- [S] ci-pipeline — SKIP

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: pr-integration
- **Next Stage**: build-and-test
- **Status**: Running
- **Last Updated**: 2026-08-28T00:00:00Z

## Session Resume Point
- **Last Completed Stage**: code-generation
- **Next Action**: Finalize merged PR
`;
}

function mergedPull(): PullSnapshot {
  return {
    repo: "example/service",
    number: 42,
    url: "https://github.com/example/service/pull/42",
    state: "MERGED",
    merged: true,
    mergedAt: "2026-08-28T01:00:00Z",
    mergeCommit: { oid: "merge-42" },
    mergedBy: { login: "maintainer" },
    headRefName: "bolt-alpha",
    baseRefName: "develop",
  };
}

function writePrRecord(proj: string): void {
  const dir = join(seededRecordDir(proj), "construction", "alpha", "pr-integration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pr-record.md"),
    "# PR Record\n\n## PR Summary\n\nMerged fixture.\n\n## Publication Plan\n\nApproved fixture.\n\n## Evidence Dossier\n\nRecorded fixture.\n\n## Integration Status\n\nMERGED\n",
    "utf-8",
  );
}

function projectWithPulls(pulls: PullSnapshot[] = [mergedPull()], record = true): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  writeFileSync(seededStateFile(proj), state(), "utf-8");
  seedBoltDag(proj, ["alpha"]);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "pr-integration",
    Agent: "aidlc-pipeline-deploy-agent",
  }, proj);
  if (record) writePrRecord(proj);
  if (pulls.length > 0) {
    emitOpenReceipts(proj, "pr-integration", "alpha", pulls.map((pull) => ({
      ...pull,
      state: "OPEN",
      merged: false,
    })));
  }
  return proj;
}

function runPr(proj: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    AIDLC_TEST_PR_FIXTURES: "1",
  };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  return spawnSync(process.execPath, [PR, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env,
  });
}

function finalize(proj: string, pulls: PullSnapshot[], args: string[] = []) {
  const fixture = join(proj, "finalize-pulls.json");
  writeFileSync(fixture, JSON.stringify(pulls), "utf-8");
  return runPr(proj, [
    "finalize", "--stage", "pr-integration", "--unit", "alpha",
    "--fixture", fixture, ...args,
  ]);
}

function receipts(proj: string, event: string) {
  return findAllEvents(readAllAuditShards(proj), event).filter((row) =>
    auditBlockField(row.block, "Stage") === "pr-integration" &&
    auditBlockField(row.block, "Unit") === "alpha"
  );
}

function expectUnsettled(proj: string): void {
  expect(findAllEvents(readAllAuditShards(proj), "PR_MERGED")).toHaveLength(0);
  expect(findAllEvents(readAllAuditShards(proj), "UNIT_COMPLETED")).toHaveLength(0);
}

function siblingPull(): PullSnapshot {
  return {
    ...mergedPull(),
    repo: "example/web",
    number: 77,
    url: "https://github.com/example/web/pull/77",
    mergeCommit: { oid: "merge-77" },
  };
}

interface GitHubStubState {
  pulls: PullSnapshot[];
  calls: string[][];
  failCreateRepo: string | null;
  failReviewerOnce: boolean;
}

function githubStub(
  proj: string,
  pulls: PullSnapshot[] = [],
  failures: { failCreateRepo?: string; failReviewerOnce?: boolean } = {},
) {
  const bin = join(proj, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const statePath = join(proj, "github-stub.json");
  writeFileSync(statePath, JSON.stringify({
    pulls,
    calls: [],
    failCreateRepo: failures.failCreateRepo ?? null,
    failReviewerOnce: failures.failReviewerOnce ?? false,
  } satisfies GitHubStubState));
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!${process.execPath}\n${String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.AIDLC_GH_STUB_STATE;
const state = JSON.parse(readFileSync(path, "utf-8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(path, JSON.stringify(state));
const fail = (message) => { save(); console.error(message); process.exit(1); };
const reply = (value) => { save(); console.log(JSON.stringify(value)); process.exit(0); };
const flag = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) fail("Missing stub argument " + name);
  return args[index + 1];
};
if (args[0] === "api" && args[1] === "rate_limit") reply(5000);
if (args[0] === "api" && /^repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(reviews|timeline|comments)\?per_page=100$/.test(args[1])) {
  reply([]);
}
if (args[0] !== "pr") fail("Unexpected gh command: " + args.join(" "));
const repo = flag("-R");
if (args[1] === "list") {
  const head = flag("--head");
  const base = flag("--base");
  if (flag("--state") !== "all" || flag("--json") !== "number") fail("Unexpected PR lookup");
  reply(state.pulls.filter((pull) => pull.repo === repo && pull.headRefName === head && pull.baseRefName === base)
    .map((pull) => ({ number: pull.number })));
}
if (args[1] === "create") {
  const head = flag("--head");
  const base = flag("--base");
  if (state.pulls.some((pull) => pull.repo === repo && pull.headRefName === head && pull.baseRefName === base)) {
    fail("a pull request for this branch already exists");
  }
  if (state.failCreateRepo === repo) {
    state.failCreateRepo = null;
    fail("injected create failure for " + repo);
  }
  const number = repo === "example/service" ? 42 : 77;
  const pull = {
    repo, number, url: "https://github.com/" + repo + "/pull/" + number,
    state: "OPEN", merged: false, mergedAt: null, mergeCommit: null, mergedBy: null,
    headRefName: head, baseRefName: base, headRefOid: "stub-head-" + number,
    body: readFileSync(flag("--body-file"), "utf-8"),
    reviewRequests: [], reviewDecision: "REVIEW_REQUIRED", isDraft: false,
    mergeStateStatus: "CLEAN", mergeable: "MERGEABLE",
  };
  state.pulls.push(pull);
  save();
  console.log(pull.url);
  process.exit(0);
}
const pull = state.pulls.find((pull) => pull.repo === repo && pull.number === Number(args[2]));
if (!pull) fail("Unknown PR " + repo + "#" + args[2]);
if (args[1] === "view") reply(pull);
if (args[1] === "edit") {
  const reviewers = flag("--add-reviewer").split(",");
  if (state.failReviewerOnce) {
    state.failReviewerOnce = false;
    fail("injected reviewer request failure");
  }
  pull.reviewRequests = reviewers.map((login) => ({ login }));
  reply({});
}
fail("Unexpected gh command: " + args.join(" "));
`}`, "utf-8");
  chmodSync(executable, 0o755);
  return {
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      AIDLC_GH_STUB_STATE: statePath,
    },
    read: (): GitHubStubState => JSON.parse(readFileSync(statePath, "utf-8")),
  };
}

function localPublicationRepo(proj: string, name: string): string {
  const repo = join(proj, "repos", name);
  const remote = join(proj, "remotes", `${name}.git`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(remote, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  git("init", "--bare", remote);
  git("init", "--initial-branch=bolt-alpha", repo);
  git("-C", repo, "-c", "user.name=PR Fixture", "-c", "user.email=pr-fixture@example.invalid",
    "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture");
  git("-C", repo, "remote", "add", "origin", remote);
  return repo;
}

function publicationArgs(proj: string, repos: string[]): string[] {
  const mappings = repos.flatMap((repo) => [
    "--repo", repo, "--repo-path", `${repo}=${localPublicationRepo(proj, repo.split("/")[1]!)}`,
  ]);
  return [
    "open", "--stage", "pr-integration", "--unit", "alpha",
    "--branch-pattern", "bolt-{slug}", "--base", "develop", "--reviewer", "maintainer",
    ...mappings,
  ];
}


describe("t329-pr-integration-finalize", () => {
  test("verified merge completes the integrating Unit and exposes the stage gate", () => {
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    writeFileSync(seededStateFile(proj), state(), "utf-8");
    seedBoltDag(proj, ["alpha"]);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "pr-integration",
      Agent: "aidlc-pipeline-deploy-agent",
    }, proj);

    const recordDir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "pr-integration",
    );
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "pr-record.md"),
      [
        "# PR Record",
        "",
        "## PR Summary",
        "",
        "Merged fixture.",
        "",
        "## Publication Plan",
        "",
        "Approved fixture.",
        "",
        "## Evidence Dossier",
        "",
        "Recorded fixture.",
        "",
        "## Integration Status",
        "",
        "MERGED",
        "",
      ].join("\n"),
      "utf-8",
    );
    emitOpenReceipts(
      proj,
      "pr-integration",
      "alpha",
      [{ ...mergedPull(), state: "OPEN", merged: false }],
    );

    const fixturePath = join(proj, "merged-pr.json");
    writeFileSync(fixturePath, JSON.stringify([mergedPull()]), "utf-8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_TEST_PR_FIXTURES: "1",
    };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const finalized = spawnSync(
      process.execPath,
      [
        PR,
        "finalize",
        "--stage",
        "pr-integration",
        "--unit",
        "alpha",
        "--fixture",
        fixturePath,
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env },
    );
    expect(
      finalized.status,
      `${finalized.stdout}\n${finalized.stderr}`,
    ).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({
      finalized: true,
      unit_completed: true,
      metadata_consolidated: false,
      worktree_retired: false,
      cleanup_pending: false,
    });
    expect(unitCompletedReceipts(proj, "pr-integration").has("alpha"))
      .toBe(true);

    const repeated = finalize(proj, [mergedPull()]);
    expect(repeated.status, `${repeated.stdout}\n${repeated.stderr}`).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      finalized: true,
      unit_completed: true,
    });
    expect(receipts(proj, "PR_MERGED")).toHaveLength(1);
    expect(receipts(proj, "UNIT_COMPLETED")).toHaveLength(1);

    const routed = runOrchestrateNext(ORCH, proj, [], { env: process.env });
    expect(routed.status, routed.out).toBe(0);
    expect(routed.directive).toMatchObject({
      kind: "run-stage",
      stage: "pr-integration",
      unit: "alpha",
      gate: true,
    });
  }, 30_000);

  test("finalizing an integrating Unit preserves a different active checkpoint", () => {
    const proj = createOrchestrationTestProject();
    projects.push(proj);
    writeFileSync(seededStateFile(proj), state(), "utf-8");
    seedBoltDag(proj, ["alpha", "beta"]);
    appendAuditEntry("STAGE_STARTED", {
      Stage: "pr-integration",
      Agent: "aidlc-pipeline-deploy-agent",
    }, proj);

    const recordDir = join(
      seededRecordDir(proj),
      "construction",
      "alpha",
      "pr-integration",
    );
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, "pr-record.md"),
      "# PR Record\n\n## PR Summary\n\nx\n\n## Publication Plan\n\nx\n\n## Evidence Dossier\n\nx\n\n## Integration Status\n\nMERGED\n",
      "utf-8",
    );
    emitOpenReceipts(
      proj,
      "pr-integration",
      "alpha",
      [{ ...mergedPull(), state: "OPEN", merged: false }],
    );

    const started = spawnSync(
      process.execPath,
      [
        STATE,
        "unit",
        "start",
        "--stage",
        "pr-integration",
        "--unit",
        "beta",
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env: process.env },
    );
    expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0);

    const fixturePath = join(proj, "merged-pr-active-sibling.json");
    writeFileSync(fixturePath, JSON.stringify([mergedPull()]), "utf-8");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_TEST_PR_FIXTURES: "1",
    };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const finalized = spawnSync(
      process.execPath,
      [
        PR,
        "finalize",
        "--stage",
        "pr-integration",
        "--unit",
        "alpha",
        "--fixture",
        fixturePath,
        "--project-dir",
        proj,
      ],
      { cwd: proj, encoding: "utf-8", env },
    );
    expect(
      finalized.status,
      `${finalized.stdout}\n${finalized.stderr}`,
    ).toBe(0);
    const content = readStateFile(proj);
    expect(getField(content, "Active Unit")).toBe("beta");
    expect(getField(content, "Unit State")).toBe("in-progress");
    expect(unitCompletedReceipts(proj, "pr-integration").has("alpha"))
      .toBe(true);
  }, 30_000);

  test("a merged fixture cannot substitute another repo and PR for alpha's binding", () => {
    const proj = projectWithPulls();
    const unrelated = {
      ...mergedPull(),
      repo: "other/repo",
      number: 999,
      url: "https://github.com/other/repo/pull/999",
    };
    const result = finalize(proj, [unrelated], ["--pr", "other/repo#999"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expectUnsettled(proj);
  }, 30_000);

  test.each([
    ["head", { headRefName: "bolt-beta" }],
    ["base", { baseRefName: "main" }],
  ] as const)("finalize refuses a merged PR whose %s no longer matches its binding", (_field, change) => {
    const proj = projectWithPulls();
    const result = finalize(proj, [{ ...mergedPull(), ...change }], ["--pr", "example/service#42"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expectUnsettled(proj);
  }, 30_000);

  test("finalize refuses an explicit PR selector that disagrees with the matching merged fixture", () => {
    const proj = projectWithPulls();
    const result = finalize(proj, [mergedPull()], ["--pr", "other/repo#999"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expectUnsettled(proj);
  }, 30_000);

  test.each([
    ["missing sibling", [mergedPull()]],
    ["unexpected sibling", [mergedPull(), siblingPull(), {
      ...mergedPull(), repo: "other/repo", number: 999,
      url: "https://github.com/other/repo/pull/999",
    }]],
  ] as const)("finalize refuses a coordinated set with a %s", (_case, supplied) => {
    const proj = projectWithPulls([mergedPull(), siblingPull()]);
    const pulls = [...supplied];
    const result = finalize(proj, pulls);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expectUnsettled(proj);
  }, 30_000);

  test("finalize refuses receipts without the exact coordinated membership even when both PRs merged", () => {
    const proj = projectWithPulls();
    emitOpenReceipts(proj, "pr-integration", "alpha", [{ ...siblingPull(), state: "OPEN", merged: false }]);
    const result = finalize(proj, [mergedPull(), siblingPull()]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expectUnsettled(proj);
  }, 30_000);

  test("finalize waits for every bound coordinated PR to merge", () => {
    const proj = projectWithPulls([mergedPull(), siblingPull()]);
    const result = finalize(proj, [mergedPull(), {
      ...siblingPull(), state: "OPEN", merged: false, mergedAt: null,
      mergeCommit: null, mergedBy: null,
    }]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ finalized: false });
    expectUnsettled(proj);
  }, 30_000);

  test("finalize rejects a prior run's PR_OPENED receipt until the current run binds it", () => {
    const proj = projectWithPulls();
    appendAuditEntry("STAGE_STARTED", {
      Stage: "pr-integration",
      Agent: "aidlc-pipeline-deploy-agent",
    }, proj);
    const stale = finalize(proj, [mergedPull()], ["--pr", "example/service#42"]);
    expect(stale.status, `${stale.stdout}\n${stale.stderr}`).toBe(1);
    expectUnsettled(proj);

    emitOpenReceipts(proj, "pr-integration", "alpha", [{ ...mergedPull(), state: "OPEN", merged: false }]);
    const current = finalize(proj, [mergedPull()]);
    expect(current.status, `${current.stdout}\n${current.stderr}`).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ finalized: true, unit_completed: true });
    expect(receipts(proj, "PR_MERGED")).toHaveLength(1);
    expect(receipts(proj, "UNIT_COMPLETED")).toHaveLength(1);
  }, 30_000);

  test("finalize requires the PR record before completing the Unit", () => {
    const proj = projectWithPulls([mergedPull()], false);
    const missing = finalize(proj, [mergedPull()]);
    expect(missing.status, `${missing.stdout}\n${missing.stderr}`).toBe(1);
    expect(receipts(proj, "UNIT_COMPLETED")).toHaveLength(0);

    writePrRecord(proj);
    const complete = finalize(proj, [mergedPull()]);
    expect(complete.status, `${complete.stdout}\n${complete.stderr}`).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({ finalized: true, unit_completed: true });
    expect(receipts(proj, "PR_MERGED")).toHaveLength(1);
    expect(receipts(proj, "UNIT_COMPLETED")).toHaveLength(1);
  }, 30_000);

  test("finalize derives every coordinated PR from current receipts when --pr is omitted", () => {
    const proj = projectWithPulls([mergedPull(), siblingPull()]);
    const gh = githubStub(proj, [mergedPull(), siblingPull()]);
    const result = runPr(proj, ["finalize", "--stage", "pr-integration", "--unit", "alpha"], gh.env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ finalized: true, unit_completed: true });
    expect(receipts(proj, "PR_MERGED").map((row) => [
      auditBlockField(row.block, "Repo"), auditBlockField(row.block, "PR Number"),
    ]).sort()).toEqual([["example/service", "42"], ["example/web", "77"]]);
    expect(receipts(proj, "UNIT_COMPLETED")).toHaveLength(1);
    expect(gh.read().calls.filter((args) => args[0] === "pr" && args[1] === "view")
      .map((args) => `${args[args.indexOf("-R") + 1]}#${args[2]}`).sort())
      .toEqual(["example/service#42", "example/web#77"]);
  }, 30_000);

  test("open retry adopts the created PR after a failed reviewer request without duplicating PR_OPENED", () => {
    const proj = projectWithPulls([], false);
    const args = publicationArgs(proj, ["example/service"]);
    const gh = githubStub(proj, [], { failReviewerOnce: true });
    const plan = runPr(proj, args, gh.env);
    expect(plan.status, `${plan.stdout}\n${plan.stderr}`).toBe(0);
    expect(gh.read().calls).toEqual([]);

    const failed = runPr(proj, [...args, "--execute"], gh.env);
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(1);
    expect(`${failed.stdout}\n${failed.stderr}`).toContain("injected reviewer request failure");
    expect(gh.read().pulls.map((pull) => pull.url)).toEqual([mergedPull().url]);
    expect(receipts(proj, "PR_OPENED")).toHaveLength(1);
    expectUnsettled(proj);

    const retried = runPr(proj, [...args, "--execute"], gh.env);
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(JSON.parse(retried.stdout).opened).toEqual([{
      repo: "example/service", number: 42, url: mergedPull().url,
    }]);
    const observed = gh.read();
    expect(observed.calls.filter((call) => call[0] === "pr" && call[1] === "create")
      .map((call) => call[call.indexOf("-R") + 1]))
      .toEqual(["example/service"]);
    expect(observed.pulls[0]!.reviewRequests).toEqual([{ login: "maintainer" }]);
    expect(receipts(proj, "PR_OPENED")).toHaveLength(1);
    expect(receipts(proj, "UNIT_INTEGRATING")).toHaveLength(1);
  }, 30_000);

  test("coordinated open retry adopts the published repo and creates only the missing sibling", () => {
    const proj = projectWithPulls([], false);
    const args = publicationArgs(proj, ["example/service", "example/web"]);
    const gh = githubStub(proj, [], { failCreateRepo: "example/web" });
    const plan = runPr(proj, args, gh.env);
    expect(plan.status, `${plan.stdout}\n${plan.stderr}`).toBe(0);
    expect(gh.read().calls).toEqual([]);

    const failed = runPr(proj, [...args, "--execute"], gh.env);
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(1);
    expect(`${failed.stdout}\n${failed.stderr}`).toContain("injected create failure for example/web");
    expect(gh.read().pulls.map((pull) => pull.repo)).toEqual(["example/service"]);
    expect(receipts(proj, "PR_OPENED")).toHaveLength(1);
    expectUnsettled(proj);

    const retried = runPr(proj, [...args, "--execute"], gh.env);
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(JSON.parse(retried.stdout).opened).toEqual([
      { repo: "example/service", number: 42, url: mergedPull().url },
      { repo: "example/web", number: 77, url: siblingPull().url },
    ]);
    const observed = gh.read();
    expect(observed.calls.filter((call) => call[0] === "pr" && call[1] === "create")
      .map((call) => call[call.indexOf("-R") + 1]))
      .toEqual(["example/service", "example/web", "example/web"]);
    expect(observed.pulls.map((pull) => [pull.repo, pull.reviewRequests])).toEqual([
      ["example/service", [{ login: "maintainer" }]],
      ["example/web", [{ login: "maintainer" }]],
    ]);
    expect(receipts(proj, "PR_OPENED").map((row) => auditBlockField(row.block, "Repo")).sort())
      .toEqual(["example/service", "example/web"]);
    expect(receipts(proj, "UNIT_INTEGRATING")).toHaveLength(1);
  }, 30_000);
});

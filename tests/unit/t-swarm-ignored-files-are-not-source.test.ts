// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-worktree:merge, function:validateCodeGenerationForkApproval
//
// While the Units are built side by side, a file Git ignores and does not track (a test run's log, a dev server's
// log, a .env, a link to a folder outside the project) is no part of the person's source: no commit holds it and no
// Unit's checkout gets it. One rule says so for every reader: the plans' approval at prepare, what prepare needs
// committed and each landing's look at the main checkout (the stage's completion is in t314). Under strict nothing
// re-asks the approval or refuses for such a file, and under relaxed nothing says it was kept. A file Git does not
// ignore is still the person's change, as before.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditBlockField, boltSlugForUnit, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  CHECK, ISOLATED_GIT_ENV, approvePlan, cleanupCheckpointFixtures, fixture, fixtureWithSource, git, prepare,
  publish, reviewRevisedSource, swarm, writeUnitSource, wt,
} from "../harness/swarm-checkpoint.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const outside: string[] = [];
afterEach(() => {
  cleanupCheckpointFixtures();
  while (outside.length) rmSync(outside.pop()!, { recursive: true, force: true });
});

const UNITS = ["alpha", "beta"];
const ID = ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com"];
const ENV = "API_KEY=not-a-real-secret\n";
const REASKED = "Parent source has changed since Plan Approval";
const NOT_COMMITTED = "Approved parent source is not committed";

const IGNORES = ".env\n*.log\nshared\n";

// A project whose .gitignore covers .env, logs and a local link from before the stage began, its plans approved.
// `more` adds to the project before the stage began.
function project(policy = "strict", more: (code: string) => void = () => {}): string {
  return fixtureWithSource((code) => {
    appendFileSync(join(code, ".gitignore"), IGNORES);
    more(code);
  }, UNITS, policy);
}

// The same with a submodule, the ignore rules committed after the stage began and the plans approved again.
function projectWithSubmodule(): string {
  const pd = fixture(UNITS, CHECK, true);
  appendFileSync(join(pd, ".gitignore"), IGNORES);
  git(pd, ["add", ".gitignore"]);
  git(pd, [...ID, "commit", "-qm", "ignore env and logs"]);
  return pd;
}

function outsideFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "t-ignored-outside-"));
  outside.push(dir);
  writeFileSync(join(dir, "fixture.json"), "{\"shared\":true}\n");
  return dir;
}

function prepared(pd: string): void {
  const result = prepare(pd, UNITS);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(true);
}

// alpha and beta are built, checked, reviewed and finalized; nothing has landed.
function built(pd: string): void {
  UNITS.forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  });
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", UNITS.join(","), "--claimed", UNITS.join(",")]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
}

function land(pd: string, unit: string) {
  const r = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-worktree.ts"),
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, encoding: "utf-8",
    env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const keptRows = (pd: string) => readAuditShardEvents(pd)
  .filter((row) => row.event === "CHANGE_ACCEPTED" && auditBlockField(row.block, "Checkpoint") === "swarm-batch");

test("strict: a log Git ignores, written after the plans were approved, does not ask for their approval again", () => {
  const pd = project();
  writeFileSync(join(pd, "test-run.log"), "tests passed\n");
  prepared(pd);
  expect(readFileSync(join(pd, "test-run.log"), "utf-8")).toBe("tests passed\n");
  for (const unit of UNITS) expect(existsSync(join(wt(pd, unit), "test-run.log"))).toBe(false);
});

test("strict: a file Git does not ignore, written after the plans were approved, still asks for their approval", () => {
  const pd = project();
  writeFileSync(join(pd, "notes.txt"), "not ignored\n");
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain(REASKED);
  for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
});

test("a link Git ignores to a folder outside the project, and an ignored .env that links outside: the build starts", () => {
  for (const policy of ["strict", "off (set by you)"]) {
    const target = outsideFolder();
    const pd = fixture(UNITS, CHECK, false, null, policy);
    appendFileSync(join(pd, ".gitignore"), ".env\nshared\n");
    git(pd, ["add", ".gitignore"]);
    git(pd, [...ID, "commit", "-qm", "ignore env and the shared link"]);
    symlinkSync(target, join(pd, "shared"), "dir");
    writeFileSync(join(target, "secrets.env"), ENV);
    symlinkSync(join(target, "secrets.env"), join(pd, ".env"), "file");
    for (const unit of UNITS) approvePlan(pd, unit, "after-links");
    const result = prepare(pd, UNITS);
    expect(result.code, `${policy}\n${result.out}\n${result.err}`).toBe(0);
    expect(`${result.out}\n${result.err}`).not.toContain(NOT_COMMITTED);
    expect(readFileSync(join(pd, ".env"), "utf-8")).toBe(ENV);
    expect(readFileSync(join(pd, "shared", "fixture.json"), "utf-8")).toBe("{\"shared\":true}\n");
    for (const unit of UNITS) {
      expect(existsSync(join(wt(pd, unit), ".env"))).toBe(false);
      expect(existsSync(join(wt(pd, unit), "shared"))).toBe(false);
    }
    cleanupCheckpointFixtures();
  }
}, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 2);

// A submodule is its own checkout: its own rules say what Git ignores inside it.
test("with a submodule, an ignored .env in the project and a log the submodule ignores: the build starts", () => {
  const pd = projectWithSubmodule();
  const sub = join(pd, "vendor", "sub");
  writeFileSync(join(pd, ".env"), ENV);
  appendFileSync(resolve(sub, git(sub, ["rev-parse", "--git-path", "info/exclude"])), "*.log\n");
  writeFileSync(join(sub, "build.log"), "built\n");
  for (const unit of UNITS) approvePlan(pd, unit, "with-env");
  prepared(pd);
  expect(readFileSync(join(pd, ".env"), "utf-8")).toBe(ENV);
  for (const unit of UNITS) expect(existsSync(join(wt(pd, unit), ".env"))).toBe(false);
});

test("with a submodule, an untracked file Git does not ignore still has to be committed first", () => {
  const pd = projectWithSubmodule();
  writeFileSync(join(pd, ".env"), ENV);
  writeFileSync(join(pd, "notes.txt"), "not ignored\n");
  for (const unit of UNITS) approvePlan(pd, unit, "with-notes");
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain(NOT_COMMITTED);
});

test("strict: a dev server's ignored log written in the main checkout during the build never stops a landing", () => {
  const pd = project();
  prepared(pd);
  writeFileSync(join(pd, "dev-server.log"), "listening\n");
  built(pd);
  const first = land(pd, "alpha");
  expect(first.code, first.out).toBe(0);
  expect(first.out).not.toContain("dev-server.log");
  // The dev server restarts and clears its log: a file Git never tracked is gone, not deleted source.
  rmSync(join(pd, "dev-server.log"));
  const second = land(pd, "beta");
  expect(second.code, second.out).toBe(0);
  expect(second.out).not.toContain("dev-server.log");
});

test("strict: a file Git does not ignore, written in the main checkout during the build, still stops the landing", () => {
  const pd = project();
  prepared(pd);
  writeFileSync(join(pd, "dev-server.log"), "listening\n");
  writeFileSync(join(pd, "notes.txt"), "not ignored\n");
  built(pd);
  const refused = land(pd, "alpha");
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("the main checkout source changed since the stage-entry baseline (notes.txt)");
});

test("strict: an ignored log written while the first batch was built does not re-ask the next batch's approval", () => {
  const pd = project();
  // The next batch's plan is approved with the first's, before anything is built.
  publish(pd, ["later"]);
  approvePlan(pd, "later");
  publish(pd, UNITS);
  prepared(pd);
  writeFileSync(join(pd, "dev-server.log"), "listening\n");
  built(pd);
  for (const unit of UNITS) {
    const landed = land(pd, unit);
    expect(landed.code, landed.out).toBe(0);
  }
  appendFileSync(join(pd, "dev-server.log"), "request served\n");
  publish(pd, ["later"]);
  const next = swarm(pd, ["prepare", "--batch", "2", "--units", "later", "--base", "main"]);
  expect(next.code, `${next.out}\n${next.err}`).toBe(0);
  expect(existsSync(wt(pd, "later"))).toBe(true);
});

test("strict: a tracked file an ignore rule matches, or an ignored one registered as source, still stops the landing", () => {
  const pd = project("strict", (code) => {
    writeFileSync(join(code, "fixture.log"), "tracked log\n");
    git(code, ["add", "-f", "fixture.log"]);
    appendFileSync(join(code, ".gitignore"), "config/local.json\n");
    writeFileSync(join(code, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, paths: ["config/local.json"] }));
  });
  prepared(pd);
  writeFileSync(join(pd, "fixture.log"), "edited during the build\n");
  mkdirSync(join(pd, "config"));
  writeFileSync(join(pd, "config", "local.json"), "{\"registered\":true}\n");
  built(pd);
  const refused = land(pd, "alpha");
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("the main checkout source changed since the stage-entry baseline (config/local.json, fixture.log)");
});

// The index forgets a file once its deletion is committed; Git's history still says it was the person's.
test("strict: a tracked file an ignore rule matches, its deletion committed after the approval, still asks again", () => {
  const pd = project("strict", (code) => {
    writeFileSync(join(code, "fixture.log"), "tracked log\n");
    git(code, ["add", "-f", "fixture.log"]);
  });
  git(pd, ["rm", "-q", "fixture.log"]);
  git(pd, [...ID, "commit", "-qm", "stop shipping fixture.log"]);
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain(REASKED);
});

test("strict: that deletion committed during the build still stops the landing, named", () => {
  const pd = project("strict", (code) => {
    writeFileSync(join(code, "fixture.log"), "tracked log\n");
    git(code, ["add", "-f", "fixture.log"]);
  });
  prepared(pd);
  built(pd);
  git(pd, ["rm", "-q", "fixture.log"]);
  git(pd, [...ID, "commit", "-qm", "stop shipping fixture.log"]);
  const refused = land(pd, "alpha");
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("the main checkout source changed since the stage-entry baseline (fixture.log)");
});

// Git reads the person's rules against their own paths, never against what a tracked link leads to outside the
// project: a log written there after the approval is compared as before.
test("strict: a log behind a tracked link to a folder outside the project still asks for the plans' approval", () => {
  const target = outsideFolder();
  const pd = project("strict", (code) => {
    if (process.platform === "win32") git(code, ["config", "core.symlinks", "true"]);
    symlinkSync(target, join(code, "vendor-shared"), "dir");
    git(code, ["add", "vendor-shared"]);
  });
  writeFileSync(join(target, "run.log"), "written behind the link\n");
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain(REASKED);
});

test("in a workspace of several repositories, a log a repository ignores does not re-ask the plans' approval", () => {
  const pd = fixture(UNITS, CHECK, false, "repo-a");
  const repo = join(pd, "repo-a");
  appendFileSync(resolve(repo, git(repo, ["rev-parse", "--git-path", "info/exclude"])), "*.log\n");
  writeFileSync(join(repo, "test-run.log"), "tests passed\n");
  prepared(pd);
  expect(readFileSync(join(repo, "test-run.log"), "utf-8")).toBe("tests passed\n");
});

test("relaxed: an ignored log written during the build is not said as kept, and the person's own edit is", () => {
  const pd = project("relaxed (set by you)");
  prepared(pd);
  writeFileSync(join(pd, "dev-server.log"), "listening\n");
  built(pd);
  const first = land(pd, "alpha");
  expect(first.code, first.out).toBe(0);
  expect(first.out).not.toContain("dev-server.log");
  expect(keptRows(pd)).toHaveLength(0);
  writeFileSync(join(pd, "notes.txt"), "the person's own note\n");
  appendFileSync(join(pd, "dev-server.log"), "request served\n");
  const second = land(pd, "beta");
  expect(second.code, second.out).toBe(0);
  expect(second.out).not.toContain("dev-server.log");
  expect(keptRows(pd)).toHaveLength(1);
});

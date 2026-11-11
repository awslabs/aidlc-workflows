// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-worktree:merge, function:validateCodeGenerationForkApproval
//
// While the Units are built side by side, a file Git ignores and does not track (a test run's log, a dev server's
// log, a .env, a link to a folder outside the project) is no part of the person's source: no commit holds it and no
// Unit's checkout gets it. One rule says so for every reader: the plans' approval at prepare, what prepare needs
// committed and each landing's look at the main checkout (the stage's completion is in t314). Under strict nothing
// re-asks the approval or refuses for such a file, and under relaxed nothing says it was kept. A file Git does not
// ignore is still the person's change, as before. A repo that joins the work while the Units are built is no change
// either: its files count from what it held at the add, at every one of those readers and the stage's completion.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditBlockField, boltSlugForUnit, currentSwarmSourceMergeChain, readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, dropRepoBaselineAdditions, seedBoltDagBatches } from "../harness/fixtures.ts";
import {
  CHECK, ISOLATED_GIT_ENV, approvePlan, checkpointChoice, cleanupCheckpointFixtures, fixture, fixtureWithSource, git,
  humanChoice, prepare, publish, reviewRevisedSource, runCheckpointTool, swarm, writeUnitSource, wt,
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

// This chat, as the host names it to a hook and to the commands the agent runs.
const CHAT = "swarm-joined-repo";

function inChat(pd: string, file: string, args: string[], input?: unknown) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, file), ...args, "--project-dir", pd], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd,
    env: {
      ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
      AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// The person types `prompt` in this chat; returns the id of the message kept.
function says(pd: string, prompt: string): string {
  const said = inChat(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt,
  });
  expect(said.code, `${said.out}\n${said.err}`).toBe(0);
  const id = auditBlockField(readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN").at(-1)?.block ?? "", "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

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

// A repo that joins the work during the build (intent add-repo of a repo the
// person cloned beside the work's own) joins as it was at the add: its files are
// no change to the main checkout at a landing, at the stage's completion, at the
// next batch or after Request Changes, on every Guard Policy, and the chain of
// landings stays readable. A file changed in it after the add is still theirs.

// payments, made elsewhere and cloned beside repo-a, as the person's own clone
// or add-repo's puts it there; then added to the work.
function addPayments(pd: string): void {
  const seed = mkdtempSync(join(tmpdir(), "t-ignored-payments-"));
  outside.push(seed);
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "api.ts"), "export const api = 1;\n");
  writeFileSync(join(seed, "README.md"), "# payments\n");
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["add", "-A"]);
  git(seed, [...ID, "commit", "-qm", "seed"]);
  git(pd, ["clone", "-q", seed, "payments"]);
  const added = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
    "intent", "add-repo", "payments", "--project-dir", pd,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, encoding: "utf-8" });
  expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
}

// In work that records its repos (repo-a), `units` are built in their
// worktrees, checked, reviewed and finalized for `batch`; nothing has landed.
function builtInRepos(pd: string, batch = 1, units = UNITS, value = 2): void {
  units.forEach((unit, index) => {
    writeUnitSource(pd, unit, index + value);
    // The worker writes the stage's documents in its worktree, as the swarm protocol has it.
    cpSync(codeGenerationRecordDir(pd, unit), codeGenerationRecordDir(wt(pd, unit), unit), { recursive: true, force: false });
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit);
  });
  const finalized = swarm(pd, ["finalize", "--batch", String(batch), "--units", units.join(","), "--claimed", units.join(",")]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
}

function landed(pd: string, unit: string, policy = "strict"): void {
  const r = land(pd, unit);
  expect(r.code, `${policy}\n${r.out}`).toBe(0);
}

test("a repo added to the work between two landings never stops or is said at the next landing", () => {
  for (const policy of ["off (set by you)", "strict"]) {
    const pd = fixture(UNITS, CHECK, false, "repo-a", policy);
    // The next batch's plan is approved with the first's, before anything is built.
    publish(pd, ["later"]);
    approvePlan(pd, "later");
    publish(pd, UNITS);
    prepared(pd);
    builtInRepos(pd);
    landed(pd, "alpha", policy);
    addPayments(pd);
    const second = land(pd, "beta");
    expect(second.code, `${policy}\n${second.out}`).toBe(0);
    expect(second.out, policy).not.toContain("payments/");
    expect(keptRows(pd), policy).toHaveLength(0);
    // The batch checkpoint, the stage's completion and the count of landed Units read this chain.
    const chain = currentSwarmSourceMergeChain(pd, "code-generation");
    expect(chain.state === "ready" ? [...chain.units].sort() : chain, policy).toEqual(UNITS);
    if (policy === "strict") {
      publish(pd, ["later"]);
      const next = swarm(pd, ["prepare", "--batch", "2", "--units", "later", "--base", "main", "--repo", "repo-a"]);
      expect(next.code, `${next.out}\n${next.err}`).toBe(0);
    }
  }
});

test("strict: a file changed in a repo after it joined the work still stops the next landing, named alone", () => {
  const pd = fixture(UNITS, CHECK, false, "repo-a");
  prepared(pd);
  builtInRepos(pd);
  landed(pd, "alpha");
  addPayments(pd);
  writeFileSync(join(pd, "payments", "README.md"), "# payments, edited after the add\n");
  const refused = land(pd, "beta");
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("the main checkout source changed after the previous reviewed-source merge (payments/README.md).");
});

// Without the add's snapshot the repo cannot be read as it joined: the landing
// compares as it did before the repo joined, and the chain still reads.
test("strict: a repo added between two landings whose snapshot is not on this machine is compared as before", () => {
  const pd = fixture(UNITS, CHECK, false, "repo-a");
  prepared(pd);
  builtInRepos(pd);
  landed(pd, "alpha");
  addPayments(pd);
  expect(dropRepoBaselineAdditions(pd)).toBeGreaterThan(0);
  const refused = land(pd, "beta");
  expect(refused.code).not.toBe(0);
  expect(refused.out).not.toContain("source-merge chain is invalid");
  expect(refused.out).toContain("the main checkout source changed after the previous reviewed-source merge (payments/README.md, payments/src/api.ts).");
});

// The likelier moment: every Unit has landed and the repo joins at the stage's gate.
test("a repo added after the last landing: the batch and Code Generation are approved with nothing said", () => {
  for (const policy of ["off (set by you)", "strict"]) {
    const pd = fixture(UNITS, CHECK, false, "repo-a", policy);
    seedBoltDagBatches(pd, [UNITS]);
    prepared(pd);
    builtInRepos(pd);
    for (const unit of UNITS) landed(pd, unit, policy);
    addPayments(pd);
    checkpointChoice(pd, UNITS, "Approve");
    const batch = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", UNITS.join(","), "--session", "t344-checkpoint",
      "--user-input", "Approve", "--project-dir", pd,
    ]);
    expect(batch.code, `${policy}\n${batch.out}\n${batch.err}`).toBe(0);
    humanChoice(pd, "Approve", "stage");
    const approved = runCheckpointTool(pd, "tools/aidlc-orchestrate.ts", [
      "report", "--stage", "code-generation", "--result", "approved", "--user-input", "Approve", "--project-dir", pd,
    ]);
    const said = `${approved.out}\n${approved.err}`;
    expect(JSON.parse(approved.out.trim().split(/\r?\n/).at(-1)!).kind, `${policy}\n${said}`).not.toBe("error");
    expect(said, policy).not.toContain("changed after the last unit was merged");
    expect(keptRows(pd), policy).toHaveLength(0);
  }
});

// The one compare the next batch's own approval decides: beside a file the
// person asked to change while the Units are built, a repo that joined since
// the approval is no reason to approve that plan again.
test("strict: beside a file the person asked to change, a repo added before the next batch does not re-ask its approval", () => {
  const pd = fixture(UNITS, CHECK, false, "repo-a");
  prepared(pd);
  builtInRepos(pd);
  for (const unit of UNITS) landed(pd, unit);
  publish(pd, ["later"]);
  approvePlan(pd, "later");
  const asked = says(pd, "also add a notes file to repo-a");
  writeFileSync(join(pd, "repo-a", "NOTES.md"), "notes\n");
  const allowed = inChat(pd, "tools/aidlc-swarm.ts", ["allow-change", "repo-a/NOTES.md", "--message", asked]);
  expect(allowed.code, `${allowed.out}\n${allowed.err}`).toBe(0);
  addPayments(pd);
  publish(pd, ["later"]);
  const next = swarm(pd, ["prepare", "--batch", "2", "--units", "later", "--base", "main", "--repo", "repo-a"]);
  expect(next.code, `${next.out}\n${next.err}`).toBe(0);
  expect(`${next.out}\n${next.err}`).not.toContain(REASKED);
});

// After Request Changes the revised Unit's landing starts from the prior
// attempt's last landing (its kept listing on the rejection).
test("strict: after Request Changes, a repo added before the revised Unit lands is not said and does not stop it", () => {
  const pd = fixture(UNITS, CHECK, false, "repo-a");
  prepared(pd);
  builtInRepos(pd);
  for (const unit of UNITS) landed(pd, unit);
  // The person's Request Changes at the stage's gate, recorded as the gate records it.
  const rejected = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-state.ts"),
    "reject", "code-generation", "--feedback", "Revise alpha", "--project-dir", pd,
  ], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, encoding: "utf-8",
    env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
  });
  expect(rejected.status, `${rejected.stdout}${rejected.stderr}`).toBe(0);
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  addPayments(pd);
  publish(pd, ["alpha"]);
  approvePlan(pd, "alpha", "revised");
  // The revised Unit is built again in its own batch of the Unit plan, in the new attempt.
  const again = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main", "--repo", "repo-a"]);
  expect(again.code, `${again.out}\n${again.err}`).toBe(0);
  builtInRepos(pd, 1, ["alpha"], 5);
  const revised = land(pd, "alpha");
  expect(revised.code, revised.out).toBe(0);
  expect(revised.out).not.toContain("payments/");
});

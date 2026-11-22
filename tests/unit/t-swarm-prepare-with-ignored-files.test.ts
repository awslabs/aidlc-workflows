// covers: subcommand:aidlc-swarm:prepare, function:validateCodeGenerationForkApproval,
// function:bindCodeGenerationWorktreeApproval
//
// Files Git ignores and does not track (a .env, a log) are not part of what a side-by-side build needs committed:
// no commit holds them and no Git checkout of a Unit gets them. The build starts with them in the project, and a
// worker's own ignored log in its worktree does not keep a plan approved again from reaching it. A file Git does not
// ignore, one it tracks (in the main folder or in the Unit's own worktree), and an ignored file the person registered
// as source in .aidlc-source-paths.json are still compared as before.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvePlan, cleanupCheckpointFixtures, fixture, git, prepare, runCheckpointTool, swarm, wt,
} from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const UNITS = ["alpha", "beta"];
const ID = ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com"];
const ENV = "API_KEY=not-a-real-secret\n";

// A project whose .gitignore covers .env and logs, committed before the plans were approved.
function project(): string {
  const pd = fixture(UNITS);
  appendFileSync(join(pd, ".gitignore"), ".env\n*.log\n");
  git(pd, ["add", ".gitignore"]);
  git(pd, [...ID, "commit", "-qm", "ignore env and logs"]);
  return pd;
}

function approveAll(pd: string): void {
  for (const unit of UNITS) approvePlan(pd, unit, "after-ignore");
}

function allowed(pd: string, unit: string): boolean {
  const child = wt(pd, unit);
  const result = runCheckpointTool(child, "tools/aidlc-testing-posture.ts", ["verify", "--unit", unit, "--project-dir", child]);
  return JSON.parse(result.out).execution_allowed === true;
}

test("an ignored .env and log in the project: the build starts, they stay where they are, no Unit gets them", () => {
  const pd = project();
  writeFileSync(join(pd, ".env"), ENV);
  writeFileSync(join(pd, "app.log"), "log line\n");
  approveAll(pd);
  const result = prepare(pd, UNITS);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  for (const unit of UNITS) {
    expect(existsSync(join(wt(pd, unit), ".env"))).toBe(false);
    expect(existsSync(join(wt(pd, unit), "app.log"))).toBe(false);
    expect(allowed(pd, unit)).toBe(true);
  }
  expect(readFileSync(join(pd, ".env"), "utf-8")).toBe(ENV);
  expect(git(pd, ["status", "--short"])).not.toContain(".env");
});

test("a worker's ignored log in its worktree: a plan approved again is handed to the build", () => {
  const pd = project();
  approveAll(pd);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  writeFileSync(join(wt(pd, "alpha"), "app.log"), "worker test output\n");
  approvePlan(pd, "alpha", "revised");
  const again = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha"]);
  expect(again.code, `${again.out}\n${again.err}`).toBe(0);
  expect(JSON.parse(again.out).units).toEqual([
    expect.objectContaining({ unit: "alpha", ok: true, approval_transferred: true }),
  ]);
  expect(allowed(pd, "alpha")).toBe(true);
  expect(readFileSync(join(wt(pd, "alpha"), "app.log"), "utf-8")).toBe("worker test output\n");
});

test("the main folder moved on and a worker's ignored log: the build is brought forward and handed the plan", () => {
  const pd = project();
  approveAll(pd);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  writeFileSync(join(wt(pd, "alpha"), "app.log"), "worker test output\n");
  writeFileSync(join(pd, "src", "peer.ts"), "export const peer = 1;\n");
  git(pd, ["add", "src/peer.ts"]);
  git(pd, [...ID, "commit", "-qm", "a peer's code"]);
  const head = git(pd, ["rev-parse", "HEAD"]);
  approvePlan(pd, "alpha", "revised");
  const again = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha"]);
  expect(again.code, `${again.out}\n${again.err}`).toBe(0);
  expect(JSON.parse(again.out).units).toEqual([
    expect.objectContaining({ unit: "alpha", ok: true, approval_transferred: true }),
  ]);
  expect(git(wt(pd, "alpha"), ["rev-parse", "HEAD"])).toBe(head);
  expect(allowed(pd, "alpha")).toBe(true);
});

test("an untracked file Git does not ignore still has to be committed first", () => {
  const pd = project();
  writeFileSync(join(pd, "notes.txt"), "not ignored\n");
  approveAll(pd);
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain("Approved parent source is not committed");
  for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
});

test("a tracked file the .gitignore also matches is compared as any tracked file", () => {
  const pd = project();
  writeFileSync(join(pd, "settings.log"), "tracked\n");
  git(pd, ["add", "-f", "settings.log"]);
  git(pd, [...ID, "commit", "-qm", "a tracked file .gitignore matches"]);
  writeFileSync(join(pd, "settings.log"), "edited, not committed\n");
  approveAll(pd);
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain("Approved parent source is not committed");
});

test("an ignored file the person registered as source still has to be committed first", () => {
  const pd = project();
  appendFileSync(join(pd, ".gitignore"), "config/local.json\n");
  writeFileSync(join(pd, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, paths: ["config/local.json"] }));
  git(pd, ["add", ".gitignore", ".aidlc-source-paths.json"]);
  git(pd, [...ID, "commit", "-qm", "register an ignored source file"]);
  mkdirSync(join(pd, "config"), { recursive: true });
  writeFileSync(join(pd, "config", "local.json"), "{\"registered\":true}\n");
  approveAll(pd);
  const result = prepare(pd, UNITS);
  expect(result.code).not.toBe(0);
  expect(`${result.out}\n${result.err}`).toContain("Approved parent source is not committed");
  for (const unit of UNITS) expect(existsSync(wt(pd, unit))).toBe(false);
});

test("the main folder deleted a tracked file the .gitignore matches: the build is brought forward without it", () => {
  const pd = project();
  writeFileSync(join(pd, "fixture.log"), "tracked log\n");
  git(pd, ["add", "-f", "fixture.log"]);
  git(pd, [...ID, "commit", "-qm", "a tracked file .gitignore matches"]);
  approveAll(pd);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  git(pd, ["rm", "-q", "fixture.log"]);
  git(pd, [...ID, "commit", "-qm", "stop shipping fixture.log"]);
  const head = git(pd, ["rev-parse", "HEAD"]);
  approvePlan(pd, "alpha", "revised");
  const again = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha"]);
  expect(again.code, `${again.out}\n${again.err}`).toBe(0);
  expect(git(wt(pd, "alpha"), ["rev-parse", "HEAD"])).toBe(head);
  expect(existsSync(join(wt(pd, "alpha"), "fixture.log"))).toBe(false);
});

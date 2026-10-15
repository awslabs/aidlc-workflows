// covers: subcommand:aidlc-worktree:merge, hook:aidlc-plan-approval-guard, audit:SWARM_SOURCE_MERGED
//
// Two parallel Units wrote one file. The first lands; the second's landing
// clashes, and git leaves it staged in the person's main checkout. The landing
// says how git left each file and names the way on, the agent may
// combine exactly those files there while the batch is out, the same merge
// says the clash again until they are combined, and then it lands and the
// batch goes on. Nothing else in the main checkout opens up. In a workspace of
// several repositories the same holds in the Unit's own repository. A landing that git
// does not start because a file it changes holds changes not committed in the
// main checkout (an AI-DLC update to .gitignore) names the file and the step.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField, boltSlugForUnit, readAuditShardEvents, workspaceSourceListing, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  ISOLATED_GIT_ENV, STAGE, cleanupCheckpointFixtures, fixture, git, nextDirective, prepare, reviewRevisedSource,
  runCheckpointTool, swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

type Clash = { status: string; conflict_files: string[]; detail: string; next: string };

function land(pd: string, unit: string, target = "main") {
  return runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(unit), "--target", target, "--strategy", "squash", "--project-dir", pd,
  ]);
}

// alpha and beta each build their own file and write one shared file; alpha lands.
function clashed(
  shared = "src/shared.ts",
  target = "main",
  change = (_unit: string, path: string, value: number) => writeFileSync(path, `export const shared = ${value};\n`),
  repo: string | null = null,
): string {
  const pd = fixture(["alpha", "beta"], undefined, false, repo);
  if (target !== "main") git(repo === null ? pd : join(pd, repo), ["branch", "-m", "main", target]);
  const prepared = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha,beta", "--base", target]);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  ["alpha", "beta"].forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    change(unit, join(wt(pd, unit), shared), index + 2);
    // The records stay at the workspace roof: the worker writes the stage's documents in its worktree.
    if (repo !== null) {
      cpSync(codeGenerationRecordDir(pd, unit), codeGenerationRecordDir(wt(pd, unit), unit), { recursive: true, force: false });
    }
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit, [...new Set([`src/${unit}.ts`, shared])]);
  });
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha,beta", "--claimed", "alpha,beta"]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  const first = land(pd, "alpha", target);
  expect(first.code, `${first.out}\n${first.err}`).toBe(0);
  return pd;
}

function guard(pd: string, toolName: string, toolInput: Record<string, unknown>) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd,
    env: {
      ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"),
      AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
    },
    stdin: Buffer.from(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "landing-clash", cwd: pd,
    })),
    stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

const write = (path: string) => ({ file_path: path, content: "export const shared = 2;\nexport const sharedBeta = 3;\n" });
const COMBINED = "export const shared = 2;\nexport const sharedBeta = 3;\n";
const unmerged = (pd: string) => git(pd, ["diff", "--name-only", "-z", "--diff-filter=U"]).replace(/\0/g, "\n").trim();

describe("a parallel landing that clashes with a Unit already landed", () => {
  test("the clash says it is staged in the main checkout, names the file, and names the way on", () => {
    const pd = clashed();
    const r = land(pd, "beta");
    expect(r.code).toBe(1);
    const clash = JSON.parse(r.out) as Clash;
    expect(clash).toMatchObject({ status: "conflict", conflict_files: ["src/shared.ts"] });
    expect(clash.detail).toContain("Unit beta's landing clashes with what is already on main");
    expect(clash.detail).toContain("src/shared.ts (added on both sides)");
    expect(clash.detail).toContain(pd);
    expect(clash.detail).not.toContain("in worktree");
    expect(clash.next).toContain("`git add`");
    expect(clash.next).toContain("run this same merge again");
    expect(clash.next).toContain("`git reset --merge`");
    expect(unmerged(pd)).toBe("src/shared.ts");
  });

  test("the agent may write the clashing file in the main checkout while the batch is out, and nothing else there", () => {
    const pd = clashed();
    expect(land(pd, "beta").code).toBe(1);
    const shared = join(pd, "src", "shared.ts");
    expect(guard(pd, "Write", write(shared)).code).toBe(0);
    expect(guard(pd, "Edit", { file_path: shared, old_string: "<<<<<<< HEAD\n", new_string: "" }).code).toBe(0);
    // beta's own file is staged in the same landing but merged cleanly; alpha's landed file is not beta's.
    const staged = guard(pd, "Write", write(join(pd, "src", "beta.ts")));
    expect(staged.code).toBe(2);
    expect(staged.err).toContain("invoke-swarm");
    expect(guard(pd, "Write", write(join(pd, "src", "alpha.ts"))).code).toBe(2);
    // Once the landing is dropped there is nothing to combine.
    git(pd, ["reset", "--merge"]);
    expect(guard(pd, "Write", write(shared)).code).toBe(2);
  });

  test("the same merge run again before the file is combined says the same clash", () => {
    const pd = clashed();
    expect(land(pd, "beta").code).toBe(1);
    const again = land(pd, "beta");
    expect(again.code, `${again.out}\n${again.err}`).toBe(1);
    expect(JSON.parse(again.out) as Clash).toMatchObject({ status: "conflict", conflict_files: ["src/shared.ts"] });
    expect(unmerged(pd)).toBe("src/shared.ts");
  });

  test("combined and added, the same merge lands it and the batch goes on", () => {
    const pd = clashed();
    expect(land(pd, "beta").code).toBe(1);
    writeFileSync(join(pd, "src", "shared.ts"), COMBINED);
    git(pd, ["add", "src/shared.ts"]);
    // A second look at its own combination after `git add` is still the agent's to write.
    expect(guard(pd, "Write", write(join(pd, "src", "shared.ts"))).code).toBe(0);
    const landed = land(pd, "beta");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect((JSON.parse(landed.out) as { notices?: string[] }).notices)
      .toEqual(["Landed Unit beta with src/shared.ts settled by hand against what was already on main."]);
    expect(readFileSync(join(pd, "src", "shared.ts"), "utf-8")).toBe(COMBINED);
    expect(unmerged(pd)).toBe("");
    const rows = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_SOURCE_MERGED");
    expect(rows.map((row) => auditBlockField(row.block, "Unit name"))).toEqual(["alpha", "beta"]);
    expect(auditBlockField(rows[1].block, "Landed changes")).toBe("src/shared.ts");
    // The landing is done: the main checkout's files wait for the batch again.
    expect(guard(pd, "Write", write(join(pd, "src", "shared.ts"))).code).toBe(2);
    expect((nextDirective(pd) as { kind: string }).kind).toBe("run-stage");
  });

  test("a file one Unit deleted and the other changed: the clash says so, and `git rm` keeps the deletion", () => {
    // alpha's plan removes its module; beta's changes it, and its own file too.
    const pd = clashed("src/alpha.ts", "main", (unit, path) =>
      unit === "alpha" ? rmSync(path) : writeFileSync(path, "export const alpha = 3;\n"));
    const clash = JSON.parse(land(pd, "beta").out) as Clash;
    expect(clash).toMatchObject({ status: "conflict", conflict_files: ["src/alpha.ts"] });
    expect(clash.detail).toContain("git could not merge src/alpha.ts (deleted on main, changed by Unit beta)");
    expect(clash.detail).not.toContain("conflict markers");
    expect(clash.next).toContain("`git rm`");
    git(pd, ["rm", "-q", "src/alpha.ts"]);
    const landed = land(pd, "beta");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect((JSON.parse(landed.out) as { notices?: string[] }).notices)
      .toEqual(["Landed Unit beta with src/alpha.ts settled by hand against what was already on main."]);
    expect(existsSync(join(pd, "src", "alpha.ts"))).toBe(false);
    expect(readFileSync(join(pd, "src", "beta.ts"), "utf-8")).toBe("export const beta = 3;\n");
    const rows = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_SOURCE_MERGED");
    expect(auditBlockField(rows[1].block, "Landed changes")).toContain("src/alpha.ts");
  });

  test("a file whose name is not plain ASCII: the clash names it as it is, and the agent may write it", () => {
    const file = "src/sh\u00e9.ts";
    const pd = clashed(file);
    const clash = JSON.parse(land(pd, "beta").out) as Clash;
    expect(clash).toMatchObject({ status: "conflict", conflict_files: [file] });
    expect(clash.detail).toContain(file);
    expect(guard(pd, "Write", write(join(pd, file))).code).toBe(0);
  });

  test("a landing on another branch names that branch", () => {
    const pd = clashed("src/shared.ts", "trunk");
    const clash = JSON.parse(land(pd, "beta", "trunk").out) as Clash;
    expect(clash.detail).toContain("what is already on trunk");
    expect(clash.detail).not.toContain(" on main");
  });

  test("a clash in a merge the person started is not AI-DLC's landing: writing there still waits for the batch", () => {
    const pd = clashed();
    git(pd, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 9;\n");
    git(pd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "side"]);
    git(pd, ["checkout", "-q", "main"]);
    const merged = Bun.spawnSync(["git", "merge", "--no-commit", "side"], { cwd: pd, env: ISOLATED_GIT_ENV, stdout: "pipe", stderr: "pipe" });
    expect(merged.exitCode).not.toBe(0);
    expect(unmerged(pd)).toBe("src/alpha.ts");
    expect(guard(pd, "Write", write(join(pd, "src", "alpha.ts"))).code).toBe(2);
  });
});

describe("a parallel landing over changes not committed in the main checkout", () => {
  // Claude Code installed: .gitignore is AI-DLC's root integration, and an update the
  // person took left a new line in it, not committed. The Unit's own source adds one too.
  test("the landing names the file and the step, and changes nothing", () => {
    const pd = fixture(["alpha"]);
    const data = join(pd, ".claude", "tools", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "harness.json"), JSON.stringify({ harnessDir: ".claude" }));
    writeFileSync(join(data, "aidlc-projection.json"), JSON.stringify({ rootIntegrations: [{ path: ".gitignore", policy: "managed-block" }] }));
    git(pd, ["add", "-A"]);
    git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "install AI-DLC"]);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!) }, pd);
    const prepared = prepare(pd, ["alpha"]);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeUnitSource(pd, "alpha", 2);
    const ignore = join(wt(pd, "alpha"), ".gitignore");
    writeFileSync(ignore, `${readFileSync(ignore, "utf-8")}dist/\n`);
    expect(swarm(pd, ["check", "alpha"]).code).toBe(0);
    reviewRevisedSource(pd, "alpha", ["src/alpha.ts", ".gitignore"]);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    const update = `${readFileSync(join(pd, ".gitignore"), "utf-8")}aidlc/active-memory/\n`;
    writeFileSync(join(pd, ".gitignore"), update);
    const head = git(pd, ["rev-parse", "HEAD"]);

    const r = land(pd, "alpha");
    expect(r.code).toBe(1);
    const said = (JSON.parse(r.err) as { error: string }).error;
    expect(said).toContain("Unit alpha's landing changes .gitignore, which has changes not committed in");
    expect(said).toContain("nothing in the checkout changed");
    expect(said).toContain("Commit those changes");
    expect(said).toContain("then run this same merge again");
    expect(said).not.toContain("Please commit your changes or stash them");
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(pd, ".gitignore"), "utf-8")).toBe(update);
    expect(existsSync(join(pd, ".git", "SQUASH_MSG"))).toBe(false);
  });
});

describe("a parallel landing that clashes in a sibling repository", () => {
  test("the agent may combine the clashing file there, and the landing names it with its repository", () => {
    const pd = clashed("src/shared.ts", "main", undefined, "repo-a");
    const repo = join(pd, "repo-a");
    const clash = JSON.parse(land(pd, "beta").out) as Clash;
    expect(clash).toMatchObject({ status: "conflict", conflict_files: ["src/shared.ts"] });
    expect(clash.detail).toContain(`it is staged in ${repo}`);
    const shared = join(repo, "src", "shared.ts");
    expect(guard(pd, "Write", write(shared)).code).toBe(0);
    expect(guard(pd, "Edit", { file_path: shared, old_string: "<<<<<<< HEAD\n", new_string: "" }).code).toBe(0);
    expect(guard(pd, "Write", write(join(repo, "src", "beta.ts"))).code).toBe(2);
    // Dropped, the landing has nothing to combine; staged again, it clashes again.
    git(repo, ["reset", "--merge"]);
    expect(guard(pd, "Write", write(shared)).code).toBe(2);
    expect(JSON.parse(land(pd, "beta").out) as Clash).toMatchObject({ status: "conflict", conflict_files: ["src/shared.ts"] });
    writeFileSync(shared, COMBINED);
    git(repo, ["add", "src/shared.ts"]);
    const landed = land(pd, "beta");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect((JSON.parse(landed.out) as { notices?: string[] }).notices)
      .toEqual(["Landed Unit beta with repo-a/src/shared.ts settled by hand against what was already on main."]);
    expect(readFileSync(shared, "utf-8")).toBe(COMBINED);
    const rows = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_SOURCE_MERGED");
    expect(auditBlockField(rows[1].block, "Repo")).toBe("repo-a");
    expect(auditBlockField(rows[1].block, "Landed changes")).toBe("repo-a/src/shared.ts");
    expect(guard(pd, "Write", write(shared)).code).toBe(2);
    expect((nextDirective(pd) as { kind: string }).kind).toBe("run-stage");
  });
});

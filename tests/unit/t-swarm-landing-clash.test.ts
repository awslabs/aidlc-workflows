// covers: subcommand:aidlc-worktree:merge, hook:aidlc-plan-approval-guard, audit:SWARM_SOURCE_MERGED
//
// Two parallel Units wrote one file. The first lands; the second's landing
// clashes, and git leaves it staged in the person's main checkout. The landing
// says how git left each file and names the way on, the agent may
// combine exactly those files there while the batch is out, the same merge
// says the clash again until they are combined, and then it lands and the
// batch goes on. Nothing else in the main checkout opens up. In a workspace of
// several repositories the same holds in the Unit's own repository. A landing
// the person's pre-commit hook refused is fixed the same way: the agent may
// write the files it staged there, and the same merge lands it. A landing that git
// does not start because a file it changes holds changes not committed in the
// main checkout (an AI-DLC update to .gitignore) names the file and the step.
// A change of the person's own that the landing keeps (Guard Policy off) is said
// once the Unit has landed: not by a landing git did not start or that clashed,
// and once by the same merge when it then lands.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField, boltSlugForUnit, pendingPersonLines, readAuditShardEvents, workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  CHECK, ISOLATED_GIT_ENV, STAGE, cleanupCheckpointFixtures, fixture, git, nextDirective, prepare, reviewRevisedSource,
  runCheckpointTool, swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import { AIDLC_SRC, runOrchestrateNext, seededStateFile } from "../harness/fixtures.ts";
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

// The chat the agent runs the landing in, as the host names it.
const CHAT = "landing-reply";
const inChat = (pd: string) => ({
  ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
  AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
});

function landInChat(pd: string, unit: string, strategy = "squash") {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-worktree.ts"),
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", strategy, "--project-dir", pd,
  ], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: inChat(pd), stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// The person chose Continue automatically: the state says so and their grant is the latest on record.
function continueAutomatically(pd: string): void {
  const path = seededStateFile(pd);
  writeFileSync(path, readFileSync(path, "utf-8").replace(
    "- **Construction Autonomy Mode**: gated", "- **Construction Autonomy Mode**: autonomous",
  ));
  appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
}

// The person writes: the prompt hook marks their turn.
function personWrites(pd: string, prompt: string): void {
  const human = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: inChat(pd), stdout: "pipe", stderr: "pipe",
    stdin: Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt })),
  });
  expect(human.exitCode, human.stderr.toString()).toBe(0);
}

// The reply the person reads: they ask to stop, and the park answers them.
function parkReply(pd: string): Record<string, unknown> {
  personWrites(pd, "stop here for today please, park the work");
  const park = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"),
    "park", "--person-asked", "--project-dir", pd,
  ], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: inChat(pd), stdout: "pipe", stderr: "pipe",
  });
  expect(park.exitCode, `${park.stdout}\n${park.stderr}`).toBe(0);
  return JSON.parse(park.stdout.toString().trim()) as Record<string, unknown>;
}

const noticesOf = (step: Record<string, unknown>): string[] =>
  Array.isArray(step.change_notices) ? step.change_notices.map(String) : [];

// alpha and beta each build their own file and write one shared file; alpha lands.
function clashed(
  shared = "src/shared.ts",
  target = "main",
  change = (_unit: string, path: string, value: number) => writeFileSync(path, `export const shared = ${value};\n`),
  repo: string | null = null,
  granted = false,
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
  if (granted) continueAutomatically(pd);
  const first = granted ? landInChat(pd, "alpha") : land(pd, "alpha", target);
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
    expect(staged.err).toContain("the main checkout changes only by their landings");
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
    // Nothing is unmerged now, but beta's cleanly merged file is still not the clash's: it waits.
    expect(guard(pd, "Write", write(join(pd, "src", "beta.ts"))).code).toBe(2);
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

describe("a parallel landing the person's git hook refused", () => {
  const LOGGED = "export const alpha = 2;\nconsole.log('debug');\n";
  const FIXED = "export const alpha = 2;\n";

  function refuseConsoleLog(pd: string): void {
    const dir = join(pd, ".git", "hooks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "pre-commit");
    writeFileSync(path, [
      "#!/bin/sh",
      "if git diff --cached -- src/alpha.ts | grep -q 'console.log'; then",
      "  echo 'lint: src/alpha.ts has a console.log' >&2",
      "  exit 1",
      "fi",
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
  }

  test("a landing the person's pre-commit hook refused: the staged file it names is the agent's to fix in the main checkout, and nothing else there", () => {
    const pd = fixture(["alpha"]);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeFileSync(join(wt(pd, "alpha"), "src", "alpha.ts"), LOGGED);
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    refuseConsoleLog(pd);
    const refused = land(pd, "alpha");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ status: "commit-refused", staged: ["src/alpha.ts"] });
    expect(unmerged(pd)).toBe("");
    const alpha = join(pd, "src", "alpha.ts");
    expect(guard(pd, "Edit", { file_path: alpha, old_string: "console.log('debug');\n", new_string: "" }).code).toBe(0);
    expect(guard(pd, "Write", { file_path: alpha, content: FIXED }).code).toBe(0);
    // A file the landing did not stage still waits for the batch.
    expect(guard(pd, "Write", { file_path: join(pd, "README.md"), content: "seed, fixed\n" }).code).toBe(2);
    // Dropped, the landing has nothing to fix; staged again, the hook refuses it again.
    git(pd, ["reset", "--merge"]);
    expect(guard(pd, "Write", { file_path: alpha, content: FIXED }).code).toBe(2);
    expect((JSON.parse(land(pd, "alpha").out) as { status: string }).status).toBe("commit-refused");
    writeFileSync(alpha, FIXED);
    git(pd, ["add", "src/alpha.ts"]);
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect((JSON.parse(landed.out) as { notices?: string[] }).notices)
      .toEqual(["Landed Unit alpha with 1 file changed since your hook refused it: src/alpha.ts."]);
    expect(readFileSync(alpha, "utf-8")).toBe(FIXED);
    // The landing is done: the main checkout's files wait for the batch again.
    expect(guard(pd, "Write", { file_path: alpha, content: FIXED }).code).toBe(2);
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

// Under Continue automatically the agent approves the batch itself and goes on,
// so the landing's settled-by-hand line, with its commit and the way back, is
// kept for the reply the person reads, said once, and the merge's own output no
// longer carries it; a gated run reads as before.
describe("under Continue automatically, a landing settled by hand is said in the person's next reply", () => {
  // beta clashes with alpha in the main checkout; the agent combines both sides and runs the same merge again.
  function settled(pd: string, strategy = "squash") {
    expect(landInChat(pd, "beta", strategy).code).toBe(1);
    writeFileSync(join(pd, "src", "shared.ts"), COMBINED);
    git(pd, ["add", "src/shared.ts"]);
    const landed = landInChat(pd, "beta", strategy);
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    return { err: landed.err, out: JSON.parse(landed.out) as { commit_sha: string; notices?: string[] } };
  }
  const line = (sha: string, revert = `git revert ${sha}`) =>
    "Landed Unit beta with src/shared.ts settled by hand against what was already on main. " +
    `\`git show ${sha} -- src/shared.ts\` shows how, and \`${revert}\` undoes the landing.`;

  test("the line names the files, the landing commit and the way back, and rides each step until the person writes", () => {
    const pd = clashed("src/shared.ts", "main", undefined, null, true);
    // Guard Policy off, as in the run: the batch with its hand-combined file is approved as it is.
    const statePath = seededStateFile(pd);
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, "- **Guard Policy**: off (set by you)"));
    // alpha landed with nothing settled by hand: nothing waits for the reply.
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([]);
    const { err, out } = settled(pd);
    const sha = out.commit_sha.slice(0, 12);
    // The merge does not say it itself: the engine carries it.
    expect(out.notices ?? []).toEqual([]);
    expect(err).not.toContain("settled by hand");
    // Each step the agent speaks from carries it once, with the order to say it before the person replies, so
    // the step it stops on carries it however long the turn runs.
    const next = () => runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], { cwd: pd, env: inChat(pd) });
    const carries = (step: ReturnType<typeof next>) => {
      expect(step.status, step.out).toBe(0);
      expect(noticesOf(step.directive ?? {}).filter((said) => said === line(sha))).toHaveLength(1);
      expect(String(step.directive?.change_notices_note)).toContain("before they reply");
    };
    // The batch's checkpoint, then (the agent approves it itself) the step after it.
    carries(next());
    const approve = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-bolt.ts"),
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", "alpha,beta", "--project-dir", pd,
    ], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: inChat(pd), stdout: "pipe", stderr: "pipe",
    });
    expect(approve.exitCode, `${approve.stdout}\n${approve.stderr}`).toBe(0);
    carries(next());
    // The person wrote after a step carried it: it was said, so it goes.
    personWrites(pd, "ok, carry on");
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([]);
    // The way back is real: the commit shows the combination, and reverting it puts alpha's file back.
    expect(git(pd, ["show", sha, "--", "src/shared.ts"])).toContain("+export const sharedBeta = 3;");
    git(pd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "revert", "--no-edit", sha]);
    expect(readFileSync(join(pd, "src", "shared.ts"), "utf-8")).toBe("export const shared = 2;\n");
  });

  test("a landing made as a merge commit is undone with git revert -m 1", () => {
    const pd = clashed("src/shared.ts", "main", undefined, null, true);
    const { out } = settled(pd, "merge");
    const sha = out.commit_sha.slice(0, 12);
    expect(out.notices ?? []).toEqual([]);
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([line(sha, `git revert -m 1 ${sha}`)]);
    git(pd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "revert", "--no-edit", "-m", "1", sha]);
    expect(readFileSync(join(pd, "src", "shared.ts"), "utf-8")).toBe("export const shared = 2;\n");
  });

  // The run this was found in: Guard Policy off, the agent changes a file after the landing and approves the
  // batch itself, and the person's next message asks to stop. Code Generation's own gate under the grant is
  // t-swarm-after-skeleton-approves'.
  test("the landing and the batch the agent approves both reach the one reply, each once", () => {
    const pd = clashed("src/shared.ts", "main", undefined, null, true);
    const path = seededStateFile(pd);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, "- **Guard Policy**: off (set by you)"));
    const { out } = settled(pd);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 9;\n");
    const approve = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-bolt.ts"),
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", "alpha,beta", "--project-dir", pd,
    ], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: inChat(pd), stdout: "pipe", stderr: "pipe",
    });
    expect(approve.exitCode, `${approve.stdout}\n${approve.stderr}`).toBe(0);
    const batch = JSON.parse(approve.stdout.toString().trim()) as { approved: boolean; notices?: string[] };
    expect(batch.approved).toBe(true);
    expect(batch.notices ?? []).toEqual([]);
    const reply = noticesOf(parkReply(pd));
    expect(reply.filter((said) => said === line(out.commit_sha.slice(0, 12)))).toHaveLength(1);
    expect(reply.filter((said) => said.startsWith("Files from the alpha Unit changed after its batch was checked:"))).toHaveLength(1);
    personWrites(pd, "thanks");
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([]);
  });

  test("in a workspace of several repositories, the way back runs git in the Unit's own repository", () => {
    const pd = clashed("src/shared.ts", "main", undefined, "repo-a", true);
    const repo = join(pd, "repo-a");
    expect(landInChat(pd, "beta").code).toBe(1);
    writeFileSync(join(repo, "src", "shared.ts"), COMBINED);
    git(repo, ["add", "src/shared.ts"]);
    const landed = landInChat(pd, "beta");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    const sha = (JSON.parse(landed.out) as { commit_sha: string }).commit_sha.slice(0, 12);
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([
      "Landed Unit beta with repo-a/src/shared.ts settled by hand against what was already on main. " +
        `\`git -C repo-a show ${sha} -- src/shared.ts\` shows how, and \`git -C repo-a revert ${sha}\` undoes the landing.`,
    ]);
    expect(git(repo, ["show", sha, "--", "src/shared.ts"])).toContain("+export const sharedBeta = 3;");
  });

  test("a gated run reads as before: the merge says the line itself, and nothing waits for the reply", () => {
    const pd = clashed();
    const { out } = settled(pd);
    expect(out.notices).toEqual(["Landed Unit beta with src/shared.ts settled by hand against what was already on main."]);
    expect(pendingPersonLines(pd, CHAT).lines).toEqual([]);
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

describe("a landing over the person's own change says so once it has landed", () => {
  const notes = (run: { err: string }) => run.err.split(/\r?\n/).filter((line) => line.includes("during the build"));
  const landedNotices = (run: { out: string }) => (JSON.parse(run.out) as { notices?: string[] }).notices;
  const accepted = (pd: string) => readAuditShardEvents(pd)
    .filter((row) => row.event === "CHANGE_ACCEPTED").map((row) => auditBlockField(row.block, "Changed"));
  const commit = (pd: string, paths: string[], message: string) => {
    git(pd, ["add", "--", ...paths]);
    git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", message]);
  };

  // Guard Policy off, as the feature scope sets it. The agent committed one of
  // AI-DLC's own records in the Unit's worktree by hand, and the main checkout
  // holds the same record not committed, so git does not start the landing
  // until it is committed there.
  function recordInTheWay(personChanges: boolean): { pd: string; record: string } {
    const pd = fixture(["alpha"], CHECK, false, null, "off");
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeUnitSource(pd, "alpha", 2);
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");
    const manifest = join(codeGenerationRecordDir(wt(pd), "alpha"), "source-manifest.json");
    const record = relative(wt(pd), manifest).replace(/\\/g, "/");
    const bytes = readFileSync(manifest);
    commit(wt(pd), [record], "the Unit's work");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    writeFileSync(join(pd, record), bytes);
    if (personChanges) writeFileSync(join(pd, "CHANGELOG.md"), "## Unreleased\n");
    return { pd, record };
  }

  test("a landing git did not start says only that, and the landing that happens says their change once", () => {
    const { pd, record } = recordInTheWay(true);
    const refused = land(pd, "alpha");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("so git did not start it and nothing in the checkout changed");
    expect(notes(refused)).toEqual([]);
    commit(pd, [record], "AI-DLC's records");
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    const said = "You changed CHANGELOG.md during the build; kept them and merged unit alpha.";
    expect(notes(landed)).toEqual([`note: ${said}`]);
    expect(landedNotices(landed)).toEqual([said]);
    expect(accepted(pd)).toEqual(["CHANGELOG.md"]);
  });

  test("with nothing of theirs changed, neither the stopped landing nor the one that happens says a change", () => {
    const { pd, record } = recordInTheWay(false);
    const refused = land(pd, "alpha");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("so git did not start it and nothing in the checkout changed");
    expect(notes(refused)).toEqual([]);
    commit(pd, [record], "AI-DLC's records");
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(landed.err).not.toContain("note:");
    expect(landedNotices(landed)).toBeUndefined();
    expect(accepted(pd)).toEqual([]);
  });

  test("a landing that clashes says only the clash, and once combined it lands and says their change once", () => {
    const pd = fixture(["alpha"], CHECK, false, null, "off");
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeUnitSource(pd, "alpha", 2);
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    // Their own edit to the Unit's file, committed while the Unit was built.
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 5;\n");
    commit(pd, ["src/alpha.ts"], "the person's own change");
    const clash = land(pd, "alpha");
    expect(clash.code).toBe(1);
    expect(JSON.parse(clash.out) as Clash).toMatchObject({ status: "conflict", conflict_files: ["src/alpha.ts"] });
    expect(notes(clash)).toEqual([]);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 7;\n");
    git(pd, ["add", "src/alpha.ts"]);
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    const said = "You changed src/alpha.ts during the build; kept them and merged unit alpha.";
    expect(notes(landed)).toEqual([`note: ${said}`]);
    expect(landedNotices(landed))
      .toEqual([said, "Landed Unit alpha with src/alpha.ts settled by hand against what was already on main."]);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toBe("export const alpha = 7;\n");
  });
});

// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:finalize,
// subcommand:aidlc-worktree:merge, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-bolt:swarm-checkpoint
//
// The walking skeleton is on and Construction runs as a swarm (#3238). The first
// Unit is built on the main checkout and approved at its own skeleton
// checkpoint; the swarm builds and lands the Units after it. Approving Code
// Generation then goes through: the skeleton's approval is its authority, and no
// swarm merge is asked of a Unit no swarm batch built. With one Unit there is no
// swarm batch at all, and the stage is approved the same way. A Unit a swarm
// batch started still owes its merge, approved or not.
//
// The swarm's first landing starts from the skeleton as the person approved it:
// under Guard Policy off or relaxed it says no change of theirs and records
// none, and under strict it goes on. A change the person makes after the skeleton's checkpoint
// is still said and recorded (off) and still stops the landing for them (strict).
//
// Under Continue automatically the agent approves the batch and Code Generation's
// gate itself and goes on, so the gate's change line waits for the reply the
// person reads; when the person approves each checkpoint the gate says it.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { verifyConstructionCheckpoint } from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import {
  approvedConstructionUnits, artifactFilename, auditBlockField, boltSlugForUnit, findStageBySlug,
  addPendingPersonLines, latestMainWorkflowStageRunFloorForProject, pendingPersonLines, readAuditShardEvents,
  reviewArtifactFingerprint, setField,
  unitMajorConstructionStageSlugs,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seedBoltDagBatches, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { ISOLATED_GIT_ENV } from "../harness/swarm-checkpoint.ts";
import {
  approvePlan, CHECK, cleanupCheckpointFixtures, fixture, fixtureWithSource, git, humanChoice, nextDirective, publish,
  reviewRevisedSource, runCheckpointTool, STAGE, swarm, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

type Run = { code: number | null; out: string; err: string };

function ok(run: Run): Run {
  expect(run.code, `${run.out}\n${run.err}`).toBe(0);
  return run;
}

function commit(pd: string, message: string): void {
  git(pd, ["add", "-A"]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", message]);
}

function report(pd: string, result: string, extra: string[] = []) {
  const run = runCheckpointTool(pd, "tools/aidlc-orchestrate.ts", [
    "report", "--stage", STAGE, "--result", result, ...extra, "--project-dir", pd,
  ]);
  return JSON.parse(run.out.trim().split(/\r?\n/).at(-1)!) as { kind: string; message?: string; next_stage?: string };
}

// Under the feature scope's Guard Policy (off unless given), with alpha as the
// walking skeleton: alpha is built on the main checkout, each of its stages
// recorded done, and its skeleton checkpoint verified, asked and approved by the
// person. `before` are files of the person's from before the stage; the skeleton
// deletes those in `deletes` and its source manifest lists them, as the stage asks.
async function skeletonApproved(
  batches: string[][], policy = "off", { before = [], deletes = [] }: { before?: string[]; deletes?: string[] } = {},
): Promise<string> {
  const pd = before.length === 0 ? fixture(["alpha"], CHECK, false, null, policy) : fixtureWithSource((code) => {
    for (const path of before) writeFileSync(join(code, path), `export const before = "${path}";\n`);
  }, ["alpha"], policy);
  seedBoltDagBatches(pd, batches);
  const statePath = seededStateFile(pd);
  writeFileSync(statePath, setField(setField(readFileSync(statePath, "utf-8"),
    "Skeleton Stance", "on"), "Review Override", "none"));
  writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
  for (const path of deletes) unlinkSync(join(pd, path));
  for (const stage of unitMajorConstructionStageSlugs("feature", readFileSync(statePath, "utf-8"), true)) {
    const definition = findStageBySlug(stage)!;
    const dir = join(seededRecordDir(pd), "construction", "alpha", stage);
    mkdirSync(dir, { recursive: true });
    for (const name of definition.produces ?? []) {
      const path = join(dir, artifactFilename(name));
      if (!existsSync(path)) writeFileSync(path, `# ${stage} alpha ${name}\n`);
    }
    if (definition.workspace_requires) {
      writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
        stage, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }, ...deletes.map((path) => ({ path }))],
      }));
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: stage, Unit: "alpha", Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(pd, stage, true, "alpha"),
      "Artifact Fingerprint": reviewArtifactFingerprint(pd, definition, "alpha", { requireRequiredArtifacts: true })!,
    }, pd);
  }
  commit(pd, "walking skeleton");
  const verified = await verifyConstructionCheckpoint(pd, "alpha", "skeleton");
  expect(verified.verified, JSON.stringify(verified.errors)).toBe(true);
  ok(runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "checkpoint", "--action", "ask", "--unit", "alpha", "--kind", "skeleton", "--session", "skeleton", "--project-dir", pd,
  ]));
  humanChoice(pd, "Approve", "skeleton");
  ok(runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "checkpoint", "--action", "approve", "--unit", "alpha", "--kind", "skeleton", "--session", "skeleton",
    "--user-input", "Approve", "--project-dir", pd,
  ]));
  expect([...approvedConstructionUnits(pd, readFileSync(statePath, "utf-8"))]).toEqual(["alpha"]);
  return pd;
}

// The swarm builds `later` as batch 2, the way `next` routes it after the
// skeleton, and lands it on main: the swarm's first landing. `during` is what
// the person does in the main checkout while the batch is built.
function swarmLandsLater(pd: string, during?: () => void): Run {
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", units: ["later"], batch: 2 });
  publish(pd, ["later"]);
  approvePlan(pd, "later");
  commit(pd, "plan for later");
  ok(swarm(pd, ["prepare", "--batch", "2", "--units", "later", "--base", "main"]));
  writeUnitSource(pd, "later", 2);
  ok(swarm(pd, ["check", "later"]));
  reviewRevisedSource(pd, "later");
  ok(swarm(pd, ["finalize", "--batch", "2", "--units", "later", "--claimed", "later"]));
  during?.();
  return runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit("later"), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ]);
}

// The person approves the batch the swarm landed.
function approveLaterBatch(pd: string): void {
  ok(runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "ask", "--batch", "2", "--units", "later", "--session", "batch", "--project-dir", pd,
  ]));
  humanChoice(pd, "Approve", "batch");
  ok(runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "approve", "--batch", "2", "--units", "later", "--session", "batch",
    "--user-input", "Approve", "--project-dir", pd,
  ]));
}

describe("t-swarm-after-skeleton-approves", () => {
  test("after the skeleton's own approval and the swarm's landed batch, the person approves Code Generation", async () => {
    const pd = await skeletonApproved([["alpha"], ["later"]]);
    ok(swarmLandsLater(pd));
    approveLaterBatch(pd);
    const shown = report(pd, "awaiting-approval");
    expect(shown.kind, shown.message).not.toBe("error");
    humanChoice(pd, "Approve", "stage");
    const approved = report(pd, "approved", ["--user-input", "Approve"]);
    expect(approved.kind, approved.message).not.toBe("error");
    expect(readAuditShardEvents(pd).some((row) =>
      row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === STAGE &&
      auditBlockField(row.block, "Checkpoint") === null)).toBe(true);
    expect(readFileSync(seededStateFile(pd), "utf-8")).toContain("- [x] code-generation");
  });

  test("with the skeleton the only Unit, no swarm batch runs and Code Generation can still be approved", async () => {
    const pd = await skeletonApproved([["alpha"]]);
    const shown = report(pd, "awaiting-approval");
    expect(shown.kind, shown.message).not.toBe("error");
    expect(shown.next_stage).toBe("Build and Test");
  });

  test("a Unit a swarm batch started still owes its merge, though its own checkpoint approved it", async () => {
    const pd = await skeletonApproved([["alpha"], ["later"]]);
    ok(swarmLandsLater(pd));
    approveLaterBatch(pd);
    appendAuditEntry("SWARM_STARTED", {
      "Batch number": "1", "Unit names": "alpha", "Unit obligations": "alpha,later", "Concurrency cap": "1",
      Stage: STAGE, "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    }, pd);
    const refused = report(pd, "awaiting-approval");
    expect(refused.kind).toBe("error");
    expect(refused.message).toContain("have no current-attempt post-merge source binding (alpha)");
  });
});

describe("the swarm's first landing after the approved walking skeleton", () => {
  const changesAccepted = (pd: string) => readAuditShardEvents(pd).filter((row) => row.event === "CHANGE_ACCEPTED");

  // The person's own change in the main checkout while the swarm builds, after the skeleton's checkpoint.
  const personChanges = (pd: string, files: Record<string, string>) => (): void => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(pd, path), text);
    commit(pd, "the person's own change");
  };

  test.each(["off", "relaxed"])("under Guard Policy %s, the skeleton they approved is not said or recorded as their change", async (policy) => {
    const pd = await skeletonApproved([["alpha"], ["later"]], policy);
    const landed = ok(swarmLandsLater(pd));
    expect(landed.err).not.toContain("You changed");
    expect(changesAccepted(pd)).toEqual([]);
  });

  test("under strict, the landing goes on and the person approves the batch and Code Generation", async () => {
    const pd = await skeletonApproved([["alpha"], ["later"]], "strict");
    ok(swarmLandsLater(pd));
    approveLaterBatch(pd);
    humanChoice(pd, "Approve", "stage");
    const approved = report(pd, "approved", ["--user-input", "Approve"]);
    expect(approved.kind, approved.message).not.toBe("error");
    expect(changesAccepted(pd)).toEqual([]);
  });

  test("under Continue automatically, the gate the agent approves itself keeps its change lines for the reply, and they ride the steps after it", async () => {
    const line = "Files in the main checkout changed after the last unit was merged. Kept them.";
    const earlier = "Landed Unit later with src/later.ts settled by hand against what was already on main.";
    const chat = "skeleton-reply";
    const inChat = (pd: string, file: string, args: string[]) => {
      const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", file), ...args, "--project-dir", pd], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, stdout: "pipe", stderr: "pipe",
        env: {
          ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
          AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
        },
      });
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout.toString().trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>;
    };
    let gatedSaid: string[] = [];
    for (const granted of [false, true]) {
      const pd = await skeletonApproved([["alpha"], ["later"]]);
      if (granted) {
        const statePath = seededStateFile(pd);
        writeFileSync(statePath, setField(readFileSync(statePath, "utf-8"), "Construction Autonomy Mode", "autonomous"));
        appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
      }
      ok(swarmLandsLater(pd));
      if (granted) {
        expect(inChat(pd, "aidlc-bolt.ts", ["swarm-checkpoint", "--action", "approve", "--batch", "2", "--units", "later"]).approved)
          .toBe(true);
      } else {
        approveLaterBatch(pd);
      }
      // A file in the main checkout changes after the last landing, as the agent's own fix did in the run.
      writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 4;\n");
      // A line an earlier step kept for the reply rides the gate too.
      if (!granted) expect(addPendingPersonLines(pd, chat, [earlier], { forReply: true })).toBe(true);
      const gate = inChat(pd, "aidlc-orchestrate.ts", ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
      expect(gate.kind, JSON.stringify(gate)).toBe("print");
      const said = Array.isArray(gate.change_notices) ? gate.change_notices : [];
      const waiting = pendingPersonLines(pd, chat).lines;
      if (granted) {
        // The gate's own lines, the run's two among them, are kept for the reply: they ride this step and the
        // steps after it, so the one the agent stops on carries them.
        expect(waiting).toContain(line);
        expect(waiting).toContain("The project source could not be checked against the Code Generation review on this machine; carrying on.");
        expect(waiting.filter((kept) => !gatedSaid.includes(kept))).toEqual([]);
        expect(said.filter((kept) => kept === line)).toHaveLength(1);
        // The agent's own approval goes on to Build and Test: its step carries them again.
        const approved = inChat(pd, "aidlc-orchestrate.ts", ["report", "--stage", STAGE, "--result", "approved"]);
        expect(approved.kind, JSON.stringify(approved)).toBe("done");
        expect(approved.change_notices ?? []).toContain(line);
        expect(pendingPersonLines(pd, chat).lines).toContain(line);
      } else {
        // Said with the gate as before, nothing of the gate's kept; the earlier reply line rides it too.
        expect(said).toContain(line);
        expect(said.filter((kept) => kept === earlier)).toHaveLength(1);
        expect(waiting).toEqual([earlier]);
        gatedSaid = said.map(String).filter((kept) => kept !== earlier);
      }
    }
  });

  // Kiro's chat is nearly full, so the gate the agent approves itself also offers to pause in a new chat: a
  // question the agent stops on, so it is the reply, and a line kept for the reply rides it.
  test("under Continue automatically, a gate that offers to pause in a new chat says the line kept for the reply", async () => {
    const chat = "5c1e4a0b-7d2f-4c3e-9a8b-1f2e3d4c5b6a";
    const kept = "Landed Unit later with src/later.ts settled by hand against what was already on main.";
    const homeDir = mkdtempSync(join(tmpdir(), "t-swarm-skeleton-kiro-home-"));
    mkdirSync(join(homeDir, ".kiro", "sessions", "cli"), { recursive: true });
    writeFileSync(join(homeDir, ".kiro", "sessions", "cli", `${chat}.json`), `${JSON.stringify({
      session_id: chat, session_state: { conversation_metadata: { last_context_usage: { percentage: 84 } } },
    })}\n`);
    const pd = await skeletonApproved([["alpha"], ["later"]]);
    const statePath = seededStateFile(pd);
    writeFileSync(statePath, setField(readFileSync(statePath, "utf-8"), "Construction Autonomy Mode", "autonomous"));
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
    ok(swarmLandsLater(pd));
    const env = {
      ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd, HOME: homeDir, USERPROFILE: homeDir,
      AIDLC_HARNESS_NAME: "kiro", AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    };
    const run = (file: string, args: string[]) => {
      const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", file), ...args, "--project-dir", pd], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, stdout: "pipe", stderr: "pipe", env,
      });
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout.toString().trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>;
    };
    expect(run("aidlc-bolt.ts", ["swarm-checkpoint", "--action", "approve", "--batch", "2", "--units", "later"]).approved).toBe(true);
    expect(addPendingPersonLines(pd, chat, [kept], { forReply: true })).toBe(true);
    const gate = run("aidlc-orchestrate.ts", ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    expect(gate.kind, JSON.stringify(gate)).toBe("print");
    expect(String(gate.narration ?? "")).toContain("Do you want to pause here and carry on in a new chat?");
    const said = Array.isArray(gate.change_notices) ? gate.change_notices : [];
    expect(said.filter((line) => line === kept)).toHaveLength(1);
    // Still kept, beside the gate's own kept line: it goes once the person writes after a step carried it.
    expect(pendingPersonLines(pd, chat).lines).toContain(kept);
  });

  test("under Guard Policy off, their own change after the skeleton's checkpoint is still said and recorded", async () => {
    const pd = await skeletonApproved([["alpha"], ["later"]]);
    const landed = ok(swarmLandsLater(pd,
      personChanges(pd, { "src/alpha.ts": "export const alpha = 3;\n", "src/mine.ts": "export const mine = 1;\n" })));
    expect(landed.err).toContain("note: You changed src/alpha.ts, src/mine.ts during the build; kept them and merged unit later.");
    const accepted = changesAccepted(pd);
    expect(accepted.map((row) => auditBlockField(row.block, "Changed"))).toEqual(["src/alpha.ts, src/mine.ts"]);
  });

  test.each(["off", "relaxed", "strict"])("under Guard Policy %s, a file the approved skeleton deleted is not read as their change", async (policy) => {
    const pd = await skeletonApproved([["alpha"], ["later"]], policy, { before: ["src/old.ts"], deletes: ["src/old.ts"] });
    const landed = ok(swarmLandsLater(pd));
    expect(landed.err).not.toContain("You changed");
    expect(changesAccepted(pd)).toEqual([]);
  });

  test("under Guard Policy off, their edit to a skeleton file names only it, not the file the skeleton deleted", async () => {
    const pd = await skeletonApproved([["alpha"], ["later"]], "off", { before: ["src/old.ts"], deletes: ["src/old.ts"] });
    const landed = ok(swarmLandsLater(pd, personChanges(pd, { "src/alpha.ts": "export const alpha = 3;\n" })));
    expect(landed.err).toContain("note: You changed src/alpha.ts during the build; kept them and merged unit later.");
    expect(changesAccepted(pd).map((row) => auditBlockField(row.block, "Changed"))).toEqual(["src/alpha.ts"]);
  });

  test("their own deletion beside the skeleton's is still said (off) and still stops the landing (strict), naming only theirs", async () => {
    const files = { before: ["src/old.ts", "src/keep.ts"], deletes: ["src/old.ts"] };
    const theirDeletion = (pd: string) => (): void => {
      unlinkSync(join(pd, "src", "keep.ts"));
      commit(pd, "the person's own deletion");
    };
    const off = await skeletonApproved([["alpha"], ["later"]], "off", files);
    const said = ok(swarmLandsLater(off, theirDeletion(off)));
    expect(said.err).toContain("note: You changed src/keep.ts during the build; kept them and merged unit later.");
    expect(changesAccepted(off).map((row) => auditBlockField(row.block, "Changed"))).toEqual(["src/keep.ts"]);
    const strict = await skeletonApproved([["alpha"], ["later"]], "strict", files);
    const refused = swarmLandsLater(strict, theirDeletion(strict));
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("the main checkout source changed since the stage-entry baseline (src/keep.ts).");
  });

  test("under strict, their own change after the skeleton's checkpoint still stops the landing, naming only theirs", async () => {
    const added = await skeletonApproved([["alpha"], ["later"]], "strict");
    const refused = swarmLandsLater(added, personChanges(added, { "src/mine.ts": "export const mine = 1;\n" }));
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("the main checkout source changed since the stage-entry baseline (src/mine.ts).");
    const edited = await skeletonApproved([["alpha"], ["later"]], "strict");
    const stopped = swarmLandsLater(edited, personChanges(edited, { "src/alpha.ts": "export const alpha = 3;\n" }));
    expect(stopped.code).not.toBe(0);
    expect(stopped.err).toContain("the main checkout source changed since the stage-entry baseline (src/alpha.ts).");
  });
});

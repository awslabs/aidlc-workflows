// covers: hook:aidlc-sync-workflow-state, function:statusSyncLeavesCursor
//
// With Construction Checkpoints on and the walking skeleton on, the engine walks
// the first Unit through its design stages and Code Generation one stage at a
// time while Current Stage stays on Functional Design, whatever the Construction
// Iteration. On Claude Code, Codex and Kiro CLI the agent marks each stage's task
// in progress, and the status sync moved Current Stage to that stage: its hold for
// a Unit's step counted only `Construction Iteration: unit-major`. With the Units
// built stage by stage or in parallel (stage-major), the next Unit after the
// skeleton's approval then went straight to Code Generation, and its design
// stages never ran (#3604). While the step the engine issued is still current,
// the sync now leaves the state as it is.
//
// Mechanism: cli - the shipped engine tools and the shipped status-sync hook, fed
// the task update the agent's task tool sends, on the checkpoint fixture, through
// the skeleton's own verify, ask and approval.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { verifyConstructionCheckpoint } from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import {
  artifactFilename, findStageBySlug, getField, latestMainWorkflowStageRunFloorForProject, readActiveDirectiveMarker,
  reviewArtifactFingerprint, setField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seedBoltDagBatches, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  CHECK, cleanupCheckpointFixtures, fixture, git, humanChoice, nextDirective, runCheckpointTool,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const DESIGN = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];

const currentStage = (pd: string): string =>
  (getField(readFileSync(seededStateFile(pd), "utf-8"), "Current Stage") ?? "").trim();

// Two Units, the first the walking skeleton, the Units built stage by stage
// (`execution` serial) or by a swarm, with nothing of the first Unit done yet.
function skeletonWalk(execution: "serial" | "swarm"): string {
  const pd = fixture(["alpha"], CHECK, false, null, "off");
  seedBoltDagBatches(pd, [["alpha"], ["beta"]]);
  const statePath = seededStateFile(pd);
  let state = readFileSync(statePath, "utf-8");
  state = setField(setField(state, "Skeleton Stance", "on"), "Review Override", "none");
  state = setField(setField(state, "Construction Execution", execution), "Current Stage", "functional-design");
  state = state.replace("- **Unit Ownership**: solo", "- **Unit Ownership**: solo\n- **Summary Confirmation**: off (set by you)")
    .replace("- [x] functional-design", "- [-] functional-design")
    .replace("- [x] nfr-requirements", "- [ ] nfr-requirements")
    .replace("- [x] nfr-design", "- [ ] nfr-design")
    .replace("- [x] infrastructure-design", "- [ ] infrastructure-design")
    .replace("- [-] code-generation", "- [ ] code-generation");
  writeFileSync(statePath, state);
  writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
  return pd;
}

// The agent marks the step's stage task in progress, as the conductor's task
// list asks; the hook is the one Claude Code runs after it.
function taskInProgress(pd: string, stage: string): void {
  const run = runCheckpointTool(pd, "hooks/aidlc-sync-workflow-state.ts", [], {
    tool_name: "TaskUpdate",
    tool_input: { taskId: stage, status: "in_progress", activeForm: `Running ${findStageBySlug(stage)!.name} [${stage}]` },
  });
  expect(run.code, `${run.out}\n${run.err}`).toBe(0);
}

// The first Unit's step on `stage` done: its documents written and its
// completion receipt recorded at the stage's run floor.
function alphaDone(pd: string, stage: string): void {
  const definition = findStageBySlug(stage)!;
  const dir = join(seededRecordDir(pd), "construction", "alpha", stage);
  mkdirSync(dir, { recursive: true });
  for (const name of definition.produces ?? []) {
    const path = join(dir, artifactFilename(name));
    if (!existsSync(path)) writeFileSync(path, `# ${stage} alpha ${name}\n`);
  }
  if (definition.workspace_requires) {
    writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
      stage, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
    }));
  }
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: stage, Unit: "alpha", Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(pd, stage, true, "alpha"),
    "Artifact Fingerprint": reviewArtifactFingerprint(pd, definition, "alpha", { requireRequiredArtifacts: true })!,
  }, pd);
}

async function approveSkeleton(pd: string): Promise<void> {
  git(pd, ["add", "-A"]);
  git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "walking skeleton"]);
  const verified = await verifyConstructionCheckpoint(pd, "alpha", "skeleton");
  expect(verified.verified, JSON.stringify(verified.errors)).toBe(true);
  const checkpoint = ["checkpoint", "--unit", "alpha", "--kind", "skeleton", "--session", "skeleton", "--project-dir", pd];
  const asked = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [...checkpoint, "--action", "ask"]);
  expect(asked.code, `${asked.out}\n${asked.err}`).toBe(0);
  humanChoice(pd, "Approve", "skeleton");
  const approved = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [...checkpoint, "--action", "approve", "--user-input", "Approve"]);
  expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
}

describe("t-status-sync-holds-issued-step: the sync leaves the skeleton walk's place", () => {
  for (const execution of ["serial", "swarm"] as const) {
    test(`Units built ${execution === "serial" ? "stage by stage" : "by a swarm"}: after the skeleton, the next Unit starts at Functional Design`, async () => {
      const pd = skeletonWalk(execution);
      for (const stage of [...DESIGN, "code-generation"]) {
        const step = nextDirective(pd) as { kind?: string; stage?: string; unit?: string; gate?: unknown };
        expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage, unit: "alpha" });
        taskInProgress(pd, stage);
        expect(currentStage(pd)).toBe("functional-design");
        // The step the engine issued is still the current one.
        expect(readActiveDirectiveMarker(pd, readFileSync(seededStateFile(pd), "utf-8"))).toMatchObject({ stage, unit: "alpha" });
        alphaDone(pd, stage);
      }
      await approveSkeleton(pd);

      const next = nextDirective(pd) as { kind?: string; stage?: string; unit?: string };
      expect(next, JSON.stringify(next)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "beta" });
    });
  }
});

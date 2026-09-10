// covers: file:skills/aidlc/SKILL.md
//
// t-acp-kiro-reviewer.serial.test.ts — LIVE proof that the §12a reviewer step
// fires on the Kiro harness: a reviewer-declaring stage driven over ACP through
// the production `aidlc` conductor ends with a separate review file committed
// to a digest-bound review record by REVIEW_COMPLETED.
//
// WHY THIS TEST EXISTS. The reviewer mechanism has three Kiro-side wiring
// contracts (conductor `subagent.trustedAgents` includes the two reviewer
// slugs; the reviewer agents' `fs_write` is capped to the `aidlc/spaces/**`
// workspace; the SKILL.md gate flow names the §12a step). All three are pinned
// deterministically by dist parity, but until this test NO live check proved a
// Kiro conductor actually runs the reviewer sub-agent end-to-end — the live
// reviewer evidence lived only on the Claude TUI leg (t-tui-t51-poc-scope).
// This is the Kiro logic-half twin: same stage (requirements-analysis, poc,
// `reviewer: aidlc-product-lead-agent` per its frontmatter), ACP-native shape.
//
// MECHANISM. `/aidlc --scope poc --stage requirements-analysis --single` emits
// exactly ONE run-stage directive carrying the graph node's `reviewer` +
// `reviewer_max_iterations` fields (buildRunStageDirective attaches them from
// the compiled node; Branch 4b short-circuits every mutating path, so the main
// pointer is never touched). The conductor runs the stage body, invokes the
// reviewer as a sub-agent, and the reviewer writes the request's reviewFile.
// The conductor records its verdict without modifying requirements.md.
//
// TURN SHAPE (the ACP hazards, both live-verified by the workspace journey):
//   1. The conductor's forwarding loop runs IN-TURN on ACP and does not
//      voluntarily end after stage work — so the stop is a DISK-CONDITION
//      cancel (poll for a verified REVIEW_COMPLETED record, then session/cancel),
//      the same pattern as driveCodekbUntilBothRepos, NOT a tool-title stop.
//   2. The stage's clarifying questions render as numbered PROSE in the
//      agent's text (question-rendering annex), not a protocol gate the driver
//      can answer — so the opening prompt grants one-stage self-answer
//      permission up front, and if the model still ends its turn to ask, ONE
//      bounded follow-up turn on the SAME keepAlive session answers with the
//      recommended defaults. Two turns maximum; the disk poll spans both.
//
// ASSERTABLE SURFACES (on-disk + tool trace, never prose):
//   - requirements.md exists without an embedded review. REVIEW_COMPLETED
//     names a digest-verified record under <record>/.aidlc-reviews/, paired
//     with REVIEW_REQUESTED and containing the reviewer's canonical verdict.
//   - The separate reviewFile was written through a completed native edit;
//     its validated body survives in the committed record after draft cleanup.
//   - No root-level `aidlc-docs/` appears: the retired flat layout must not
//     be resurrected by a reviewer pointed at a dead path.
//   - An actual sub-agent dispatch names the reviewer; a logger command that
//     merely mentions the reviewer cannot stand in for that invocation.
//
// SPENDS Kiro credits — gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when
// unset OR kiro-cli absent/unauthenticated. Serial: one live ACP session.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  pairedReviewRecordForCompletion,
  readAuditShardEvents,
  reviewRecordRefFromBlock,
  validateReviewAppendix,
} from "../../dist/kiro/.kiro/tools/aidlc-lib.ts";
import { seededRecordDir } from "../harness/fixtures.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

// One live stage body + reviewer sub-agent round-trip; the poc/Minimal
// requirements pass is small but the reviewer invocation adds a second model
// turn inside the same ACP turn. Budget generously; the disk-condition cancel
// ends the turn the moment the verdict lands, so green runs never wait it out.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1800", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1800) * 1000;
// Two drive turns share the budget; leave headroom for setup/asserts.
const DRIVE_MS = Math.max(300_000, Math.floor((TEST_TIMEOUT_MS - 120_000) / 2));

const REVIEWER_SLUG = "aidlc-product-lead-agent";
const STAGE = "requirements-analysis";
const WORKFLOW = `single-stage:${STAGE}`;

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP reviewer round-trip (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

/** The primary artifact is reviewed, never used as the reviewer's write target. */
function requirementsPath(proj: string): string {
  return join(seededRecordDir(proj), "inception", STAGE, "requirements.md");
}

/** Stop only after the logger has committed a review paired to its request.
 * A draft alone, an unrelated receipt, or a tampered record cannot stop the run. */
function completedReview(proj: string) {
  try {
    const events = readAuditShardEvents(proj);
    for (const completion of events) {
      if (
        completion.event !== "REVIEW_COMPLETED" ||
        auditBlockField(completion.block, "Stage") !== STAGE ||
        auditBlockField(completion.block, "Workflow") !== WORKFLOW ||
        auditBlockField(completion.block, "Reviewer") !== REVIEWER_SLUG
      ) continue;
      const record = pairedReviewRecordForCompletion(proj, completion.block);
      const ref = reviewRecordRefFromBlock(completion.block);
      if (!record || !ref || !record.request_id) continue;
      const request = events.find((event) =>
        event.event === "REVIEW_REQUESTED" &&
        auditBlockField(event.block, "Request Id") === record.request_id &&
        auditBlockField(event.block, "Stage") === STAGE &&
        auditBlockField(event.block, "Workflow") === WORKFLOW &&
        auditBlockField(event.block, "Reviewer") === REVIEWER_SLUG &&
        auditBlockField(event.block, "Iteration") === String(record.iteration) &&
        auditBlockField(event.block, "Artifact Fingerprint") === record.artifact_fingerprint
      );
      if (request) return { record, ref, request, completion };
    }
  } catch {
    // The poll can race a file write; the final assertion still requires a receipt.
  }
  return null;
}

/** Drive one ACP turn and cancel it the moment a verified review receipt is on
 *  disk (the conductor's in-turn forwarding loop never voluntarily ends — the
 *  same hazard + pattern as the workspace journey's codekb turn). Resolves
 *  with the drive result either way; the caller asserts on disk. */
async function driveUntilReview(
  session: AcpSession,
  proj: string,
  prompt: string,
): Promise<Awaited<ReturnType<typeof driveKiroAcp>>> {
  let cancelled = false;
  const poll = setInterval(() => {
    if (!cancelled && session.sessionId && completedReview(proj)) {
      cancelled = true;
      session.notify("session/cancel", { sessionId: session.sessionId });
    }
  }, 2000);
  try {
    return await driveKiroAcp({
      projectDir: proj,
      session,
      prompt,
      timeoutMs: DRIVE_MS,
      keepAlive: true,
    });
  } finally {
    clearInterval(poll);
  }
}

describe("t-acp-kiro-reviewer (live §12a reviewer fires on the shipped dist/kiro)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `a reviewer-declaring stage commits the separate review and matching REVIEW_COMPLETED receipt${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // Greenfield stub + seeded ideation artifacts: intent-statement.md gives
      // the requirements pass its anchor (fewer/cheaper clarifying questions);
      // all of requirements-analysis's consumes are optional, so nothing else
      // is required for a poc `--single` run. withState is LOAD-BEARING: the
      // intent record only resolves when it holds an aidlc-state.md
      // (activeIntent's cursor check + listIntentDirs both require it), and
      // with no record the engine's recordPrefix falls back to the BARE
      // intents root — the stage then writes `intents/inception/...` while
      // this test polls the record shard, and the poll never fires (the same
      // wrong-shard trap the Kiro IDE checkpoint test hit). The state content
      // itself is inert here: a `--single` run never reads or touches the
      // main workflow state (Branch 4b).
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-init-active.md",
        greenfieldStub: true,
        ideationArtifacts: true,
      });
      const session = new AcpSession(proj, "aidlc", true);
      try {
        // Self-answer permission is granted for THIS stage only, up front —
        // the ACP driver cannot answer prose-rendered structured questions, so
        // waiting on one would burn the whole budget (the autonomy rule allows
        // exactly this: explicit permission for this specific stage).
        const r1 = await driveUntilReview(
          session,
          proj,
          `/aidlc --scope poc --stage requirements-analysis --single` +
            ` — for any clarifying question this stage asks, choose the` +
            ` recommended option yourself and continue; do not wait for me.` +
            ` Run the stage to completion including the reviewer step.`,
        );

        // Bounded second turn: if the model still ended its turn to ask the
        // stage's questions (live models sometimes do despite the grant),
        // answer once with the defaults and let the disk poll finish the job.
        let r2: Awaited<ReturnType<typeof driveKiroAcp>> | undefined;
        if (!completedReview(proj) && r1.stopReason === "end_turn") {
          r2 = await driveUntilReview(
            session,
            proj,
            `Use the recommended answer for every question and finish the` +
              ` stage now, including the reviewer step. Do not ask me anything.`,
          );
        }

        // §12a on disk: the primary artifact and the separately recorded review
        // both exist. The completion verifies record bytes and receipt ownership.
        expect(existsSync(requirementsPath(proj))).toBe(true);
        const artifact = readFileSync(requirementsPath(proj), "utf-8");
        expect(artifact.trim().length).toBeGreaterThan(0);
        expect(artifact).not.toMatch(/^## Review\b/m);
        const review = completedReview(proj);
        expect(review).not.toBeNull();
        if (!review) throw new Error("Missing digest-bound REVIEW_COMPLETED and matching request");
        expect(review.ref.path).toMatch(
          /^\.aidlc-reviews\/requirements-analysis\/stage\/[0-9a-f]{16}\/[1-9][0-9]*\.json$/,
        );
        expect(existsSync(join(seededRecordDir(proj), review.ref.path))).toBe(true);
        expect(review.record).toMatchObject({
          stage: STAGE,
          workflow: WORKFLOW,
          unit: null,
          reviewer: REVIEWER_SLUG,
        });
        expect(["READY", "NOT-READY"]).toContain(review.record.verdict);
        expect(review.record.body.trim().length).toBeGreaterThan(0);
        expect(validateReviewAppendix(Buffer.from(review.record.body), {
          verdict: review.record.verdict,
          reviewer: REVIEWER_SLUG,
          iteration: review.record.iteration,
          reviewChallenge: null,
          standalone: true,
        })).toEqual({ valid: true });

        // The retired flat layout must not reappear: a reviewer (or conductor)
        // still pointed at the dead root path would recreate it here.
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);

        const allCalls = [...r1.toolCalls, ...(r2?.toolCalls ?? [])];
        // The request's project-relative reviewFile is the native write target.
        // The logger deletes this draft on commit, so inspect the completed tool
        // call and retained record body instead of requiring the draft to remain.
        const requestOutput = allCalls.flatMap((call) =>
          call.output.join("").split(/\r?\n/).flatMap((line) => {
            try {
              const value = JSON.parse(line);
              return value?.emitted === "REVIEW_REQUESTED" &&
                  value.requestId === review.record.request_id
                ? [value as { reviewFile: string }]
                : [];
            } catch {
              return [];
            }
          })
        );
        expect(requestOutput).toHaveLength(1);
        const reviewFile = requestOutput[0]?.reviewFile;
        expect(reviewFile).toStartWith(
          `${seededRecordDir(proj).slice(proj.length + 1).replaceAll("\\", "/")}/.aidlc-reviews/${STAGE}/`,
        );
        expect(allCalls.some((call) => {
          const input = call.rawInput as { path?: string } | undefined;
          return call.kind === "edit" && call.status === "completed" &&
            (input?.path === reviewFile || input?.path === join(proj, reviewFile!));
        })).toBe(true);
        // Live agents fumble individual tool ARGUMENTS and recover in the
        // next call (observed: an orphan "Directory not found" validation
        // failure mid-run while the stage still completed - reproduced on
        // clean v2). A transient, recovered fumble is not the contract under
        // test; a SYSTEMATIC failure is. Reject only issues that the on-disk
        // outcome (asserted above) did not absorb: hook blocks and repeated
        // failures of the same call.
        const issues = [...r1.toolCallIssues, ...(r2?.toolCallIssues ?? [])];
        const systematic = issues.filter(
          (issue) =>
            issue.output.join("\n").includes("PreToolHook blocked") ||
            issues.filter((other) => other.toolCallId === issue.toolCallId)
              .length > 1,
        );
        expect(systematic).toEqual([]);
        // Native crew dispatch has no ACP kind and carries mode/stages/task.
        // Reads, edits, searches, and task-list calls mentioning the agent do not count.
        const reviewerInvoked = allCalls.some((tc) => {
          const input = tc.rawInput;
          return tc.title === "Spawning agent crew" && tc.kind === "" &&
            tc.status === "completed" &&
            input !== null && typeof input === "object" && !Array.isArray(input) &&
            Object.hasOwn(input, "mode") && Object.hasOwn(input, "stages") &&
            Object.hasOwn(input, "task") &&
            JSON.stringify(input).includes(REVIEWER_SLUG);
        });
        expect(reviewerInvoked).toBe(true);
      } finally {
        session.close();
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

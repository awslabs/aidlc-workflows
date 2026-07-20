// covers: file:skills/aidlc/SKILL.md
//
// t-acp-kiro-reviewer.serial.test.ts — LIVE proof that the §12a reviewer step
// fires on the Kiro harness: a reviewer-declaring stage driven over ACP through
// the production `aidlc` conductor ends with the reviewer's `## Review` verdict
// appended to the primary artifact on disk.
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
// reviewer as a sub-agent, and the reviewer appends `## Review` to
// `requirements.md` under the seeded intent record.
//
// TURN SHAPE (the ACP hazards, both live-verified by the workspace journey):
//   1. The conductor's forwarding loop runs IN-TURN on ACP and does not
//      voluntarily end after stage work — so the stop is a DISK-CONDITION
//      cancel (poll for a verdict under `## Review`, then session/cancel),
//      the same pattern as driveCodekbUntilBothRepos, NOT a tool-title stop.
//   2. The stage's clarifying questions render as numbered PROSE in the
//      agent's text (question-rendering annex), not a protocol gate the driver
//      can answer — so the opening prompt grants one-stage self-answer
//      permission up front, and if the model still ends its turn to ask, ONE
//      bounded follow-up turn on the SAME keepAlive session answers with the
//      recommended defaults. Two turns maximum; the disk poll spans both.
//
// ASSERTABLE SURFACES (on-disk + tool trace, never prose):
//   - `<record>/inception/requirements-analysis/requirements.md` exists and
//     carries a `## Review` section with a READY / NOT-READY verdict — the
//     §12a contract (stage-protocol.md "Reviewer executes"), landing under
//     `aidlc/spaces/**` (the tree the reviewer's write cap names).
//   - No root-level `aidlc-docs/` appears: the retired flat layout must not
//     be resurrected by a reviewer pointed at a dead path.
//   - Some tool call in the turn references the reviewer agent slug — the
//     reviewer ran as a SUB-AGENT invocation, not conductor-inline prose.
//
// SPENDS Kiro credits — gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when
// unset OR kiro-cli absent/unauthenticated. Serial: one live ACP session.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The primary artifact the stage produces and the reviewer appends to. */
function requirementsPath(proj: string): string {
  return join(seededRecordDir(proj), "inception", "requirements-analysis", "requirements.md");
}

function hasReviewerVerdict(artifact: string): boolean {
  return /^## Review\b[\s\S]*?\b(?:NOT-READY|READY)\b/m.test(artifact);
}

function reviewLanded(proj: string): boolean {
  try {
    return hasReviewerVerdict(readFileSync(requirementsPath(proj), "utf-8"));
  } catch {
    return false;
  }
}

/** Drive one ACP turn and cancel it the moment a `## Review` verdict is on
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
    if (!cancelled && session.sessionId && reviewLanded(proj)) {
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
    `a reviewer-declaring stage driven over ACP ends with the reviewer's ## Review verdict on the artifact${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
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
        if (!reviewLanded(proj) && r1.stopReason === "end_turn") {
          r2 = await driveUntilReview(
            session,
            proj,
            `Use the recommended answer for every question and finish the` +
              ` stage now, including the reviewer step. Do not ask me anything.`,
          );
        }

        // §12a on disk: the artifact exists under the per-intent record
        // (aidlc/spaces/** — the tree the reviewer's write grant names) and
        // carries the appended ## Review verdict.
        expect(existsSync(requirementsPath(proj))).toBe(true);
        const artifact = readFileSync(requirementsPath(proj), "utf-8");
        expect(artifact).toMatch(/^## Review\b/m);
        expect(hasReviewerVerdict(artifact)).toBe(true);

        // The retired flat layout must not reappear: a reviewer (or conductor)
        // still pointed at the dead root path would recreate it here.
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);

        // The reviewer ran as a sub-agent: some tool call in the turn(s)
        // references the reviewer slug (title, input, or output — tolerant of
        // how kiro-cli surfaces the subagent invocation in its tool stream).
        const allCalls = [...r1.toolCalls, ...(r2?.toolCalls ?? [])];
        expect([
          ...r1.toolCallIssues,
          ...(r2?.toolCallIssues ?? []),
        ]).toEqual([]);
        const reviewerInvoked = allCalls.some((tc) =>
          [tc.title, JSON.stringify(tc.rawInput ?? ""), tc.output.join("")]
            .join("\n")
            .includes(REVIEWER_SLUG),
        );
        expect(reviewerInvoked).toBe(true);
      } finally {
        session.close();
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

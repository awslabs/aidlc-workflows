// covers: file:skills/aidlc/SKILL.md
//
// t-acp-kiro-compose-inflight.serial.test.ts - the P4 in-flight recompose
// journey on Kiro-ACP: the Kiro logic-half twin of the SDK test
// t196-compose-inflight. t196 proves the CONDUCTOR arc over the Claude SDK; this
// proves the SAME arc runs end-to-end on the shipped dist/kiro conductor, over a
// real running workflow driven through the Agent Client Protocol:
//
//   seed:      a BORN-shape feature workflow (the state-initialization-done
//              fixture: cursor at intent-capture, market-research +
//              team-formation pending grid-EXECUTE ahead of it). Seeded from a
//              fixture rather than a subprocess intent-birth so the deterministic
//              tier stays fixture-driven, the same posture the reviewer + front
//              twins take (a spawned aidlc tool would reclassify this file's
//              mechanism).
//   turn 1:    `/aidlc compose "drop market research and team formation ..."`.
//              The engine's WITH-STATE dispatch names the composer; the
//              conductor proposes SKIP flips for the two pending stages, writes
//              the pending marker `aidlc/.aidlc-compose-pending`, and renders the
//              approve/edit/reject gate as numbered prose. The marker is what
//              lets the turn END at the gate (the Stop hook's pending-compose
//              carve-out honours it, proven deterministically by t195). Nothing
//              is applied yet: the state file is byte-unchanged, no RECOMPOSED.
//   turn 2:    "1 (Approve ...)" on the SAME keepAlive session. The conductor
//              runs the recompose verb and DELETES the marker. Because the
//              ACP conductor's forwarding loop does not reliably end its turn on
//              its own, the stop is a DISK-CONDITION cancel: poll until the
//              RECOMPOSED audit event is present AND the marker is gone, then
//              session/cancel (the pattern t-acp-kiro-reviewer uses for the
//              in-turn forwarding hazard).
//   disk:      market-research now carries the SKIP suffix, the cursor and every
//              checkbox marker are byte-unchanged (a plan edit, not an advance),
//              Total Stages shrank, Stages to Skip names market-research,
//              RECOMPOSED is audited, and the marker is gone.
//
// JOURNEY-LEVEL tolerance (mirrors t196): the live composer exercises judgment
// over WHICH of the two named stages to flip (a run was observed keeping
// team-formation with a reason), so the deterministic contract is that at least
// the unambiguous market-research flip landed AS A SUFFIX EDIT, the plan shrank,
// and the cursor never moved. t194 pins the exact multi-flip mechanics
// deterministically. The marker is asserted absent only AFTER the turn fully
// resolves it (the disk-condition poll gates on marker-gone), avoiding the
// write-then-delete timing race t196 documents at the recompose tool result.
//
// SPENDS Kiro credits - gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when unset
// or kiro-cli absent/unauthenticated. Serial: one live ACP session, two turns.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { seededRecordDir } from "../harness/fixtures.ts";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1800", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1800) * 1000;
// Turn 1 carries the composer dispatch (detect + propose + write marker + gate);
// turn 2 carries the recompose apply + marker delete. Split the budget.
const TURN_MS = Math.max(300_000, Math.floor((TEST_TIMEOUT_MS - 60_000) / 2));

const TASK =
  "drop market research and team formation from this workflow - we already know the market and the team";

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP in-flight recompose journey (uses Kiro credits)";
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

/** The pending-proposal marker the conductor writes before the gate and deletes
 *  on resolve (aidlc/.aidlc-compose-pending, project-root aidlc/). */
function markerPath(proj: string): string {
  return join(proj, "aidlc", ".aidlc-compose-pending");
}

/** The seeded record's state file (the fixture layout resolves the default
 *  intent record; recompose writes back to this same file). */
function readState(proj: string): string {
  return readFileSync(join(seededRecordDir(proj), "aidlc-state.md"), "utf-8");
}

/** Concatenated audit shard text under the record's audit/ dir (empty if none). */
function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

const recomposed = (proj: string): boolean =>
  auditText(proj).includes("**Event**: RECOMPOSED");

describe("t-acp-kiro compose in-flight recompose journey (live Kiro ACP)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `mid-flow compose proposes SKIP flips; approve lands them via recompose, cursor + markers untouched${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // A BORN-shape feature workflow seeded from a fixture: market-research +
      // team-formation are pending grid-EXECUTE stages ahead of the cursor
      // (intent-capture), the exact shape t196 births live.
      const root = setupTuiProject({
        harness: "kiro",
        withState: "state-initialization-done.md",
      });
      const session = new AcpSession(root, "aidlc", true);
      try {
        const before = readState(root);
        expect(before).toMatch(/- \[ \] market-research .* EXECUTE/);
        expect(before).toMatch(/- \[ \] team-formation .* EXECUTE/);
        const cursorBefore = /- \*\*Current Stage\*\*: (.*)/.exec(before)?.[1];
        const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
        // Every checkbox MARKER + slug (excluding the EXECUTE/SKIP suffix, which
        // a flip DOES edit): a recompose must leave these byte-identical - it is
        // a plan edit, never a stage advance.
        const markersBefore = [...before.matchAll(/^- \[[ xSR?-]\] \S+/gm)].map((m) => m[0]);
        expect(markersBefore.length).toBeGreaterThan(0);

        // --- turn 1: compose -> proposal -> marker + gate (turn ends there) ---
        // No stop condition: the marker's Stop-hook carve-out lets the turn end
        // AT the gate on its own (the same turn-end bet the front twin makes).
        const r1 = await driveKiroAcp({
          projectDir: root,
          session,
          prompt: `/aidlc compose "${TASK}"`,
          timeoutMs: TURN_MS,
          keepAlive: true,
        });
        // The marker was written, the gate is pending, and NOTHING is applied
        // yet: state byte-unchanged, no RECOMPOSED (the marker-first discipline).
        expect(existsSync(markerPath(root))).toBe(true);
        expect(readState(root)).toBe(before);
        expect(recomposed(root)).toBe(false);

        // --- turn 2: approve -> recompose applies -> marker deleted -----------
        // Disk-condition cancel: the ACP conductor's in-turn forwarding loop does
        // not reliably end on its own, so poll until the recompose fully resolved
        // (RECOMPOSED audited AND marker gone), then session/cancel. Requiring
        // BOTH sidesteps the write-then-delete race t196 documents.
        let cancelled = false;
        const poll = setInterval(() => {
          if (!cancelled && session.sessionId && recomposed(root) && !existsSync(markerPath(root))) {
            cancelled = true;
            session.notify("session/cancel", { sessionId: session.sessionId });
          }
        }, 500);
        try {
          const r2 = await driveKiroAcp({
            projectDir: root,
            session,
            prompt:
              "1 (Approve the proposal as-is - apply the SKIP flips to the running workflow)",
            timeoutMs: TURN_MS,
            keepAlive: true,
          });
          expect([...r1.toolCallIssues, ...r2.toolCallIssues]).toEqual([]);
        } finally {
          clearInterval(poll);
        }

        // The flips landed as suffix edits; cursor + markers byte-unchanged.
        const after = readState(root);
        expect(after).toMatch(/- \[ \] market-research .* SKIP/);
        const cursorAfter = /- \*\*Current Stage\*\*: (.*)/.exec(after)?.[1];
        expect(cursorAfter).toBe(cursorBefore);
        const markersAfter = [...after.matchAll(/^- \[[ xSR?-]\] \S+/gm)].map((m) => m[0]);
        expect(markersAfter).toEqual(markersBefore);
        // Derived fields rebuilt: total dropped by at least the one flip.
        const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
        expect(totalAfter).toBeLessThan(totalBefore);
        // And the rebuilt Stages to Skip names the flipped stage.
        expect(after).toMatch(/- \*\*Stages to Skip\*\*: .*market-research/);

        // RECOMPOSED audited and the marker gone (the poll only cancelled once
        // both held, so this asserts the fully-resolved end state - the strongest
        // proof the recompose verb ran, mirroring t196's audit assertion).
        expect(recomposed(root)).toBe(true);
        expect(existsSync(markerPath(root))).toBe(false);
      } finally {
        session.close();
        cleanupTuiProject(root);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

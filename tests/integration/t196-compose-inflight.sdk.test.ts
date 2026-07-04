// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-utility:recompose
//
// t196-compose-inflight.sdk.test.ts - the P4 in-flight recompose journey (sdk
// live). t194 pins the deterministic verb; this proves the CONDUCTOR arc the
// SKILL.md composer block names, over a real running workflow:
//
//   seed:      an active mid-ideation feature workflow (the born shape).
//   drive:     `/aidlc compose "drop market research and team formation"`.
//   engine:    Branch 4c WITH-STATE dispatch (t198 pins it does not advance).
//   conductor: dispatches the composer -> proposal (SKIP flips for the two
//              named pending stages) -> writes the pending marker -> gate
//              (answerScript approves) -> runs `recompose --skip ...` ->
//              deletes the marker.
//   disk:      the two stages' suffixes are SKIP; derived fields rebuilt;
//              RECOMPOSED audited; the marker is GONE; the cursor and every
//              checkbox marker byte-unchanged (a plan edit, not an advance).
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock. Gated
// on claude-CLI presence.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateFile } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(180_000, TEST_TIMEOUT_MS - 15_000);

const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Approve" },
};

describe("t196 in-flight recompose journey (/aidlc compose mid-workflow, sdk live)", () => {
  test(
    "mid-flow compose proposes SKIP flips, approve lands them via the recompose verb, cursor untouched",
    async () => {
      // A real BORN workflow (not a fixture): birth feature scope, so
      // market-research + team-formation are pending grid-EXECUTE stages
      // ahead of the cursor (intent-capture).
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const birth = Bun.spawnSync({
          cmd: [
            process.execPath,
            join(proj, ".claude", "tools", "aidlc-utility.ts"),
            "intent-birth", "--scope", "feature", "--project-dir", proj,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(birth.exitCode).toBe(0);
        const before = readStateFile(proj) ?? "";
        expect(before).toMatch(/- \[ \] market-research — EXECUTE/);
        expect(before).toMatch(/- \[ \] team-formation — EXECUTE/);
        const cursorBefore = /- \*\*Current Stage\*\*: (.*)/.exec(before)?.[1];

        const r = await driveAidlc(
          '/aidlc compose "drop market research and team formation from this workflow - we already know the market and the team"',
          {
            projectDir: proj,
            answerScript: APPROVE_ALL,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: { toolName: "Bash", resultIncludes: "Recomposed:" },
          },
        );

        // The gate fired; the recompose verb ran (its verbatim summary).
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        const recomposeCalls = r.toolResults.filter(
          (t) => t.toolName === "Bash" && t.resultText.includes("Recomposed:"),
        );
        expect(recomposeCalls.length).toBeGreaterThanOrEqual(1);

        // Disk: the flips landed as suffix edits, cursor + markers untouched.
        // JOURNEY-LEVEL tolerance: the live composer exercises judgment over
        // WHICH of the two named stages to flip (a run was observed keeping
        // team-formation with a reason) - the deterministic contract is that
        // at least the unambiguous market-research flip landed AS A SUFFIX
        // EDIT (marker still pending), the plan shrank, and the cursor never
        // moved. t194 pins the exact multi-flip mechanics deterministically.
        const after = readStateFile(proj) ?? "";
        expect(after).toMatch(/- \[ \] market-research — SKIP/);
        const cursorAfter = /- \*\*Current Stage\*\*: (.*)/.exec(after)?.[1];
        expect(cursorAfter).toBe(cursorBefore);
        // Derived fields rebuilt: total dropped by at least the one flip.
        const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
        const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
        expect(totalAfter).toBeLessThan(totalBefore);
        // And the rebuilt Stages to Skip names the flipped stage.
        expect(after).toMatch(/- \*\*Stages to Skip\*\*: .*market-research/);

        // RECOMPOSED audited.
        const space = existsSync(join(proj, "aidlc", "active-space"))
          ? readFileSync(join(proj, "aidlc", "active-space"), "utf-8").trim() || "default"
          : "default";
        const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
        const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
        const auditDir = join(intentsDir, rec, "audit");
        const audit = readdirSync(auditDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => readFileSync(join(auditDir, f), "utf-8"))
          .join("\n");
        expect(audit).toContain("**Event**: RECOMPOSED");

        // The pending-proposal MARKER discipline (write before the gate,
        // delete on resolve) is deliberately NOT asserted here: this drive
        // aborts AT the recompose tool result, and whether the conductor's
        // marker-deletion step has run by that instant is a live-timing race
        // (both orders observed across runs). The deterministic halves are
        // pinned elsewhere - t195 proves the Stop hook honours the marker and
        // blocks again once it is gone; the dispatch print (t198's shape)
        // carries the write/delete instruction verbatim.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

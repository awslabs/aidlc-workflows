// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-utility:recompose
//
// t196-compose-inflight.sdk.test.ts - the P4 in-flight recompose journey (sdk
// live). t194 pins the deterministic verb; this proves the CONDUCTOR arc over a
// real running workflow when the person types `compose` and names the stages:
//
//   seed:      an active mid-ideation feature workflow (the post-creation shape).
//   drive:     `/aidlc compose "drop market research and team formation"`.
//   conductor: the person named both stages, so it may apply them at once
//              (`next --skip`, no question: SKILL.md "Named stage changes are
//              done at once") or route through the composer's in-flight
//              dispatch (Branch 4c; t198 pins it does not advance), whose gate
//              the answerScript approves. Either way it runs
//              `recompose --skip ...`; the test does not care which route.
//   disk:      both named stages' suffixes are SKIP; derived fields rebuilt;
//              RECOMPOSED audited with both names; the cursor unchanged (a
//              plan edit, not an advance).
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock. Gated
// on claude-CLI presence.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateFile } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Approve" },
};

describe("t196 in-flight recompose journey (/aidlc compose mid-workflow, sdk live)", () => {
  test(
    "mid-flow compose naming two stages skips both through the recompose verb, cursor untouched",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      // A real created workflow (not a fixture): create a feature-scope intent, so
      // market-research + team-formation are pending grid-EXECUTE stages
      // ahead of the cursor (intent-capture).
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const creation = Bun.spawnSync({
          cmd: [
            process.execPath,
            join(proj, ".claude", "tools", "aidlc-utility.ts"),
            "intent-create", "--scope", "feature", "--project-dir", proj,
          ],
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(creation.exitCode).toBe(0);
        const before = readStateFile(proj) ?? "";
        expect(before).toMatch(/- \[ \] market-research — EXECUTE/);
        expect(before).toMatch(/- \[ \] team-formation — EXECUTE/);
        const cursorBefore = /- \*\*Current Stage\*\*: (.*)/.exec(before)?.[1];

        const r = await driveAidlc(
          '/aidlc compose "drop market research and team formation from this workflow - we already know the market and the team"',
          {
            projectDir: proj,
            answerScript: APPROVE_ALL,
            timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
              deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
            }),
            stopAfterToolResult: {
              toolName: "Bash",
              resultIncludes: "Recomposed:",
              inputExcludes: "--dry-run",
            },
          },
        );

        // The recompose verb ran (its verbatim summary). Whether a question
        // came first is not asserted: the person named the stages, so the
        // agent may apply them at once or confirm them through the composer's
        // gate, and both leave the same records below.
        const recomposeCalls = r.toolResults.filter(
          (t) => t.toolName === "Bash" && t.resultText.includes("Recomposed:"),
        );
        expect(recomposeCalls.length).toBeGreaterThanOrEqual(1);

        // Disk: both stages the person named are skipped, as suffix edits
        // (markers still pending), and the cursor never moved.
        const after = readStateFile(proj) ?? "";
        for (const slug of ["market-research", "team-formation"]) {
          expect(after).toContain(`- [ ] ${slug} \u2014 SKIP`);
        }
        const cursorAfter = /- \*\*Current Stage\*\*: (.*)/.exec(after)?.[1];
        expect(cursorAfter).toBe(cursorBefore);
        // Derived fields rebuilt: two fewer stages to run.
        const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
        const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
        expect(totalAfter).toBe(totalBefore - 2);
        // And the rebuilt Stages to Skip names both.
        const toSkip = /- \*\*Stages to Skip\*\*: (.*)/.exec(after)?.[1] ?? "";
        expect(toSkip).toContain("market-research");
        expect(toSkip).toContain("team-formation");

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
        // The audit names both skips (in whatever order the agent passed them).
        const recomposed = audit.split("\n---\n").find((block) => block.includes("**Event**: RECOMPOSED")) ?? "";
        const skippedRow = /\*\*Stages skipped\*\*: (.*)/.exec(recomposed)?.[1] ?? "";
        expect(skippedRow.split(", ").sort()).toEqual(["market-research", "team-formation"]);

        // The pending-proposal MARKER discipline (write before the gate,
        // delete on resolve) is deliberately NOT asserted here: the direct
        // route writes no marker, this drive aborts AT the recompose tool
        // result, and on the composer route whether the conductor's
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

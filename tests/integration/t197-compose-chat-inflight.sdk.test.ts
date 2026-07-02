// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-utility:recompose
//
// t197-compose-chat-inflight.sdk.test.ts - the CHAT-FIRST in-flight reshape
// journey (sdk live). t196 proves the arc when the human types the literal
// `compose` verb; this proves the conductor RECOGNIZES a plain-chat reshape
// request with NO verb anywhere and routes it through the same deterministic
// path (the SKILL.md first-judgment step: continuation / new-work /
// plan-reshape):
//
//   seed:      an active mid-ideation feature workflow (the born shape).
//   drive:     `/aidlc can we skip market research? we already know this
//              market` - no compose verb, no flag, pure conversation.
//   conductor: classifies the input as a plan-reshape (not a continuation -
//              a verbatim forward would silently run the current stage),
//              routes via `next compose "<their words>"` or the sanctioned
//              fast path, presents the approve gate, and on approve lands
//              the flip through the recompose verb.
//   disk:      market-research's suffix is SKIP (a suffix edit - the marker
//              stays pending); derived fields rebuilt; RECOMPOSED audited;
//              the cursor never moved and no stage advanced.
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

/** Checkbox marker lines only ([ ]/[-]/[x]/[S] + slug), suffix stripped -
 *  the reshape must land as suffix edits, never as marker mutations. */
function checkboxMarkers(state: string): string {
  return state
    .split("\n")
    .filter((l) => /^- \[[ x\-S]\] /.test(l))
    .map((l) => l.replace(/ — (EXECUTE|SKIP)$/, ""))
    .join("\n");
}

describe("t197 chat-first in-flight reshape (plain chat, no compose verb, sdk live)", () => {
  test(
    "a conversational skip request reaches the gate and lands via the recompose verb; no stage advances",
    async () => {
      // A real BORN workflow (not a fixture): birth feature scope, so
      // market-research is a pending grid-EXECUTE stage ahead of the
      // cursor (intent-capture).
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
        const cursorBefore = /- \*\*Current Stage\*\*: (.*)/.exec(before)?.[1];
        const markersBefore = checkboxMarkers(before);

        // The whole point: NO compose verb, NO flag - plain conversation
        // that names skipping a stage of the running workflow.
        const r = await driveAidlc(
          "/aidlc can we skip market research? we already know this market",
          {
            projectDir: proj,
            answerScript: APPROVE_ALL,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: { toolName: "Bash", resultIncludes: "Recomposed:" },
          },
        );

        // The gate fired; the flip landed through the deterministic verb
        // (its verbatim summary in a tool result), not a prose state edit.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        const recomposeCalls = r.toolResults.filter(
          (t) => t.toolName === "Bash" && t.resultText.includes("Recomposed:"),
        );
        expect(recomposeCalls.length).toBeGreaterThanOrEqual(1);

        // Disk: the suffix flipped, and NOTHING advanced - cursor identical,
        // every checkbox marker byte-identical (a plan edit, not an advance).
        const after = readStateFile(proj) ?? "";
        expect(after).toMatch(/- \[ \] market-research — SKIP/);
        const cursorAfter = /- \*\*Current Stage\*\*: (.*)/.exec(after)?.[1];
        expect(cursorAfter).toBe(cursorBefore);
        expect(checkboxMarkers(after)).toBe(markersBefore);
        // Derived fields rebuilt against the reshaped plan.
        const totalBefore = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(before)?.[1]);
        const totalAfter = Number(/- \*\*Total Stages\*\*: (\d+)/.exec(after)?.[1]);
        expect(totalAfter).toBeLessThan(totalBefore);
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

        // Marker-file timing is NOT asserted here for the same reason t196
        // skips it: the drive aborts AT the recompose tool result and the
        // conductor's marker-deletion step races that instant. t195 pins the
        // Stop-hook half deterministically.
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

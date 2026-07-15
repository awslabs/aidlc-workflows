// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t193-compose-report-journey.sdk.test.ts - the P3 report-composer journey
// (sdk live). The report moment is the front path with a report-shaped input:
// `/aidlc compose --report <path>` makes the engine's Branch 4c print carry
// the report-triage instruction; the dispatched composer reads the file,
// triages findings (auto-fixable vs human-decision), and composes a compact
// fix-and-ship grid - which for a bug-shaped scan should ROUTE TO THE STOCK
// `bugfix` SCOPE rather than minting a new one (the persona's prefer-stock
// rule; the fixture is 5 code-level findings on a brownfield Todo app, the
// canonical bugfix shape).
//
// Journey (one interactive run, stopped at the birth):
//   drive:     `/aidlc compose --report scan-report-sample.json` on a fresh
//              BROWNFIELD project (the fixture stub) with the report copied in.
//   conductor: dispatch -> triage -> proposal (matched: bugfix) -> gate
//              (answerScript approves) -> NO scope write (stock match) ->
//              same-turn birth on bugfix.
//   disk:      NO new scope file (still 10 + 10 - the matched path skips the
//              write); a born intent whose state carries Scope: bugfix.
//
// The deterministic halves are pinned by t198 (the --report flag parses,
// value not leaked). This proves the LIVE triage->route->birth arc.
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock. Gated
// on claude-CLI presence (driveAidlc marks it SDK-dependent).

import { describe, expect, test } from "bun:test";
import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  FIXTURES_DIR,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField, readStateFile } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(180_000, TEST_TIMEOUT_MS - 15_000);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

// Approve the compose gate; any other menu falls back to option 1.
const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Approve" },
};

describe("t193 report composer journey (/aidlc compose --report, sdk live)", () => {
  test(
    "a bug-shaped scan triages to the stock bugfix scope: no scope write, same-turn birth on bugfix",
    async () => {
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
        withBrownfieldStub: true,
      });
      try {
        copyFileSync(
          join(FIXTURES_DIR, "scan-report-sample.json"),
          join(proj, "scan-report-sample.json"),
        );
        const scopesDir = join(proj, ".claude", "scopes");
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(10);

        const r = await driveAidlc(
          "/aidlc compose --report scan-report-sample.json",
          {
            projectDir: proj,
            answerScript: APPROVE_ALL,
            timeoutMs: DRIVE_TIMEOUT_MS,
            stopAfterToolResult: STOP_AFTER_INIT,
          },
        );

        // The engine's dispatch print carried the triage instruction with the
        // report path riding the report slot (not leaked into the task text).
        // NB the tool result is the directive JSON, so the message's inner
        // quotes arrive escaped (\"...\") - assert the escape-stable parts.
        assertToolResultContains(r, "Bash", "scan report at");
        assertToolResultContains(r, "Bash", "scan-report-sample.json");

        // The gate fired and the birth ran in the SAME drive.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // Matched-stock path: NO scope write (still exactly the 10 stock files
        // + 10 grid keys).
        expect(
          readdirSync(scopesDir).filter((f) => f.startsWith("aidlc-") && f.endsWith(".md"))
            .length,
        ).toBe(10);
        const grid = JSON.parse(
          readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(10);

        // The born workflow rides the triaged route: a compact incremental
        // scope (bugfix, or security-patch if the composer judged the hotspot
        // must deploy) - never the full-arc feature default.
        const stateText = readStateFile(proj) ?? "";
        const scope = readStateField(stateText, "Scope");
        expect(["bugfix", "security-patch"]).toContain(scope ?? "");
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

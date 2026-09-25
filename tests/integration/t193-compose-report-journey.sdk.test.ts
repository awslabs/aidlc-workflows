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
// Journey (one interactive run, stopped at the creation):
//   drive:     `/aidlc compose --report scan-report-sample.json` on a fresh
//              BROWNFIELD project (the fixture stub) with the report copied in.
//   conductor: dispatch -> triage -> proposal (matched: bugfix) -> gate
//              (answerScript approves) -> NO scope write (stock match) ->
//              same-turn creation on bugfix.
//   disk:      NO new scope file (still 10 + 10 - the matched path skips the
//              write); a created intent whose state carries Scope: bugfix.
//
// The deterministic halves are pinned by t198 (the --report flag parses,
// value not leaked). This proves the LIVE triage->route->creation arc.
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock. Gated
// on claude-CLI presence (driveAidlc marks it SDK-dependent).

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
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

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

// Approve the compose gate; any other menu falls back to option 1.
const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Approve" },
};

function boundedEvidence(text: string, limit = 64 * 1024): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

// Read-only snapshots distinguish a proposed custom route from a stock route
// whose registry was unexpectedly changed. Diagnostics must not interrupt a gate.
function scopeEvidence(proj: string): Record<string, unknown> {
  try {
    const scopesDir = join(proj, ".claude", "scopes");
    const files = readdirSync(scopesDir).filter((f) => f.endsWith(".md")).sort();
    const gridText = readFileSync(
      join(proj, ".claude", "tools", "data", "scope-grid.json"),
      "utf-8",
    );
    return {
      scopeFileCount: files.length,
      scopeFiles: files.slice(0, 32),
      scopeContents: Object.fromEntries(files.slice(0, 32).map((file) => [
        file,
        boundedEvidence(readFileSync(join(scopesDir, file), "utf-8"), 16 * 1024),
      ])),
      gridKeyCount: Object.keys(JSON.parse(gridText)).length,
      grid: boundedEvidence(gridText),
      state: boundedEvidence(readStateFile(proj) ?? ""),
    };
  } catch (error) {
    return { snapshotError: boundedEvidence(String(error), 4096) };
  }
}

describe("t193 report composer journey (/aidlc compose --report, sdk live)", () => {
  test(
    "a bug-shaped scan triages to the stock bugfix scope: no scope write, same-turn creation on bugfix",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
        withBrownfieldStub: true,
      });
      let passed = false;
      let gateCount = 0;
      try {
        copyFileSync(
          join(FIXTURES_DIR, "scan-report-sample.json"),
          join(proj, "scan-report-sample.json"),
        );
        const scopesDir = join(proj, ".claude", "scopes");
        console.log(`t193 initial scope evidence: ${JSON.stringify(scopeEvidence(proj))}`);
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);

        const r = await driveAidlc(
          "/aidlc compose --report scan-report-sample.json",
          {
            projectDir: proj,
            answerScript: APPROVE_ALL,
            timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
              deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
            }),
            stopAfterToolResult: STOP_AFTER_INIT,
            onAskUserQuestion: (menu) => {
              gateCount++;
              if (gateCount > 4) return;
              console.log(`t193 before answer delivery: ${JSON.stringify({
                gateCount,
                menu: boundedEvidence(JSON.stringify(menu), 16 * 1024),
                ...scopeEvidence(proj),
              })}`);
            },
          },
        );

        // The SDK trace keeps only 240 characters of each tool result. Preserve
        // the proposal, validator distances, gate answers, and creation output
        // before an assertion can fail; prose remains diagnostic evidence only.
        const routeResults = r.toolResults.filter(({ toolName }) =>
          ["Agent", "Task", "Bash", "AskUserQuestion"].includes(toolName)
        );
        console.log(`t193 post-run evidence: ${JSON.stringify({
          timedOut: r.timedOut,
          stoppedAfterAskUserQuestion: r.stoppedAfterAskUserQuestion,
          stoppedAfterToolResult: r.stoppedAfterToolResult,
          gateCount,
          askedQuestions: boundedEvidence(JSON.stringify(r.askedQuestions), 16 * 1024),
          routeResultCount: routeResults.length,
          routeResults: routeResults.slice(-32).map((result) => ({
            toolName: result.toolName,
            toolUseId: result.toolUseId,
            input: boundedEvidence(JSON.stringify(result.input), 16 * 1024),
            isError: result.isError,
            resultText: boundedEvidence(result.resultText),
          })),
          assistantText: boundedEvidence(r.assistantText),
          ...scopeEvidence(proj),
        })}`);

        // The engine's dispatch print carried the triage instruction with the
        // report path riding the report slot (not leaked into the task text).
        // NB the tool result is the directive JSON, so the message's inner
        // quotes arrive escaped (\"...\") - assert the escape-stable parts.
        assertToolResultContains(r, "Bash", "scan report at");
        assertToolResultContains(r, "Bash", "scan-report-sample.json");

        // The gate fired and the creation ran in the SAME drive.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // Matched-stock path: NO scope write (still exactly the 11 stock files
        // and 11 grid keys).
        expect(
          readdirSync(scopesDir).filter((f) => f.startsWith("aidlc-") && f.endsWith(".md"))
            .length,
        ).toBe(11);
        const grid = JSON.parse(
          readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(11);

        // The created workflow rides the triaged route: a compact incremental
        // scope (bugfix, or security-patch if the composer judged the hotspot
        // must deploy) - never the feature freeform default.
        const stateText = readStateFile(proj) ?? "";
        const scope = readStateField(stateText, "Scope");
        expect(["bugfix", "security-patch"]).toContain(scope ?? "");
        const projectDescription = readStateField(stateText, "Project");
        expect(projectDescription).toBeDefined();
        expect(projectDescription).not.toBe("[Project description]");
        expect(projectDescription?.trim().length ?? 0).toBeGreaterThan(0);
        passed = true;
      } finally {
        if (passed) cleanupTestProject(proj);
        else {
          console.error(`t193 failed fixture retained for runner collection: ${proj}`);
          console.error(`t193 failure scope evidence: ${JSON.stringify(scopeEvidence(proj))}`);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

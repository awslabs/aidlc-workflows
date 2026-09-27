// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t192-compose-front-journey.sdk.test.ts - the P2 front-composer journey (sdk).
//
// t189 proved dispatch-to-gate (P0: no write before approval). This test
// proves the P2 half: on APPROVE, the conductor's composer block drives the
// write + the same-turn creation - the whole front arc in ONE /aidlc invocation:
//
//   drive:     `/aidlc compose "<task no stock scope fits>"` on a fresh project.
//   conductor: dispatches the composer -> proposal -> approve/edit/reject gate
//              (the answerScript approves) -> the composer writes the two
//              scope files -> the conductor continues into intent-create with
//              the composed scope - NO second /aidlc invocation.
//   disk:      a composed scopes/aidlc-<name>.md + a scope-grid.json entry
//              exist; a created intent's aidlc-state.md carries the composed
//              scope; the composed scope ships keywords: [] (the hygiene
//              default - inferability is an explicit gate choice, never a
//              compose side effect).
//
// Assertions stay at the JOURNEY level (disk + tool results), tolerant of
// conversational variance - NEVER on assistantText:
//   (a) a gate fired (askedQuestions >= 1);
//   (b) the creation ran (`State initialized:` tool-result - only
//       handleIntentCreate emits it);
//   (c) a NEW scope .md landed in .claude/scopes/ (12 files, was 11) AND
//       scope-grid.json gained its entry (12 keys, was 11) - BOTH files, the
//       write contract;
//   (d) the created state's Scope names the composed scope (not a stock name);
//   (e) the composed .md carries keywords: [] (empty list or no entries).
//
// If the live composer instead MATCHES a stock scope for this task (allowed
// by the persona: prefer stock), (c) would fail - so the task is chosen to be
// genuinely cross-cutting (no stock grid fits: it needs operation stages but
// skips ideation), and the prompt nudges "compose a custom plan". A composer
// that still routes to stock fails (c) loudly - a signal to tighten the
// prompt, never a false green.
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import { assertComposedScopeFile } from "../harness/composed-scope.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

// A task built to NOT fit any stock grid: it needs deployment/observability
// (operation stages) against an existing system but no ideation and no new
// product surface - none of the 11 stock scopes covers that shape. The prompt
// explicitly asks for a custom plan so a stock match is a live failure signal.
const TASK =
  "harden the deployment pipeline and add observability for our existing service - no new features, compose a custom plan for exactly this";

// Approve every gate: the composer block pins the gate options to lead with
// Approve; any other menu (e.g. the offer confirm) also takes the fallback.
const APPROVE_ALL = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Approve" },
};

const STOCK_SCOPES = new Set([
  "bugfix", "enterprise", "feature", "infra", "mvp", "poc", "refactor",
  "security-patch", "classic", "workshop", "express",
]);

describe("t192 front composer journey (/aidlc compose -> approve -> write -> creation, sdk live)", () => {
  test(
    "approve drives the two-file scope write and the same-turn creation on the composed scope",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const scopesDir = join(proj, ".claude", "scopes");
        const gridPath = join(proj, ".claude", "tools", "data", "scope-grid.json");
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);

        const r = await driveAidlc(`/aidlc compose "${TASK}"`, {
          projectDir: proj,
          answerScript: APPROVE_ALL,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // (a) the gate fired - the approve/edit/reject turn-stop.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // (b) the creation ran in the SAME drive (one /aidlc invocation).
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // (c) BOTH scope files landed: a 12th .md + a 12th grid key.
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(12);
        const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<
          string,
          { stages?: Record<string, string> }
        >;
        const gridKeys = Object.keys(grid);
        expect(gridKeys.length).toBe(12);
        const composedName = gridKeys.find((k) => !STOCK_SCOPES.has(k));
        expect(composedName).toBeDefined();
        if (composedName === undefined) throw new Error("No composed scope in grid");
        // The grid entry is a real stages map, not an empty stub.
        expect(Object.keys(grid[composedName].stages ?? {}).length).toBeGreaterThan(0);

        // (d) the created state froze the COMPOSED scope.
        const spaceCursor = join(proj, "aidlc", "active-space");
        const space = existsSync(spaceCursor)
          ? readFileSync(spaceCursor, "utf-8").trim() || "default"
          : "default";
        const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
        const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
        const state = readFileSync(join(intentsDir, rec, "aidlc-state.md"), "utf-8");
        expect(state).toContain(`- **Scope**: ${composedName}`);
        const projectLine = state
          .split("\n")
          .find((line) => line.startsWith("- **Project**:"));
        expect(projectLine).toBe(`- **Project**: ${TASK}`);

        // (e) Join the grid/state name to exactly one declared scope identity.
        // It may already include aidlc-; the filename is not the identity.
        // Empty keywords remain mandatory, including in CRLF frontmatter.
        assertComposedScopeFile(scopesDir, composedName);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t192-compose-front-journey.sdk.test.ts - the P2 front-composer journey (sdk).
//
// t189 proved dispatch-to-gate (P0: no write before approval). This test
// proves the P2 half: on APPROVE, the conductor's composer block drives the
// same-turn creation - the whole front arc in ONE /aidlc invocation - and a
// composed plan belongs to that piece of work unless the person saves it.
//
//   drive:     `/aidlc compose "<task no stock scope fits>"` on a fresh project.
//   conductor: dispatches the composer -> proposal -> gate -> intent-create on
//              the plan's stock base with its --skip/--add changes - NO second
//              /aidlc invocation.
//   case 1:    Approve. No scope file is written: the scope library keeps its
//              11 files and 11 grid keys, and the created state runs a stock
//              scope with a `Plan: custom, based on <scope>` line and stage
//              suffixes that differ from that scope's grid.
//   case 2:    Approve and save as scope. After creation the conductor runs
//              `scope save`, so a 12th scope lands (durable record + harness
//              pair) carrying the running plan, keywords: [] (inferability is
//              an explicit choice, never a side effect) and the four approved
//              settings in the loader's words.
//
// Assertions stay at the JOURNEY level (disk + tool results), tolerant of
// conversational variance - NEVER on assistantText. If the live composer
// instead MATCHES a stock scope for this task (allowed by the persona: prefer
// stock), the Plan line is missing and the case fails - so the task is chosen
// to be genuinely cross-cutting (no stock grid fits: it needs operation stages
// but skips ideation), and the prompt nudges "compose a custom plan". A
// composer that still routes to stock fails loudly - a signal to tighten the
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
import { assertComposedScopeFile, assertComposedScopeSettings } from "../harness/composed-scope.ts";
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
// Take the save option at the plan gate; the name question that follows offers
// the composer's suggested name first, and a menu without the label takes it.
const APPROVE_AND_SAVE = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "save as scope" },
};

const STOCK_SCOPES = new Set([
  "bugfix", "enterprise", "feature", "infra", "mvp", "poc", "refactor",
  "security-patch", "classic", "workshop", "express",
]);

type Grid = Record<string, { stages?: Record<string, string> }>;

function activeState(proj: string): string {
  const spaceCursor = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
  return readFileSync(join(intentsDir, rec, "aidlc-state.md"), "utf-8");
}

/** The plan the state runs: each stage line's EXECUTE/SKIP suffix. */
function planOf(state: string): Record<string, string> {
  const plan: Record<string, string> = {};
  for (const m of state.matchAll(/^- \[.\] (\S+) \u2014 (EXECUTE|SKIP)\b/gm)) plan[m[1]] = m[2];
  return plan;
}

async function drive(proj: string, answerScript: typeof APPROVE_ALL, stopAfter: string, deadlineMs: number) {
  return driveAidlc(`/aidlc compose "${TASK}"`, {
    projectDir: proj,
    answerScript,
    timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
      deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
    }),
    stopAfterToolResult: { toolName: "Bash", resultIncludes: stopAfter },
  });
}

describe("t192 front composer journey (/aidlc compose -> approve -> creation, sdk live)", () => {
  test(
    "approve creates the plan for this piece of work and writes no scope file",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
      try {
        const scopesDir = join(proj, ".claude", "scopes");
        const gridPath = join(proj, ".claude", "tools", "data", "scope-grid.json");
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);

        const r = await drive(proj, APPROVE_ALL, INIT_STATE_SUMMARY, deadlineMs);

        // (a) the gate fired - the approve/edit/reject turn-stop.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        // (b) the creation ran in the SAME drive (one /aidlc invocation).
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);
        // (c) nothing was added to the scope library.
        expect(readdirSync(scopesDir).filter((f) => f.endsWith(".md")).length).toBe(11);
        expect(Object.keys(JSON.parse(readFileSync(gridPath, "utf-8")) as Grid).length).toBe(11);
        expect(existsSync(join(proj, "aidlc", "scopes"))).toBe(false);
        // (d) the work runs a stock scope with its own plan.
        const state = activeState(proj);
        const scope = /^- \*\*Scope\*\*: (\S+)$/m.exec(state)?.[1] ?? "";
        expect(STOCK_SCOPES.has(scope)).toBe(true);
        expect(state).toContain(`- **Plan**: custom, based on ${scope}`);
        const stock = (JSON.parse(readFileSync(gridPath, "utf-8")) as Grid)[scope]?.stages ?? {};
        const plan = planOf(state);
        const changed = Object.keys(plan).filter(
          (slug) => slug !== "reverse-engineering" && plan[slug] !== (stock[slug] ?? "SKIP"),
        );
        expect(changed.length).toBeGreaterThan(0);
        const projectLine = state.split("\n").find((line) => line.startsWith("- **Project**:"));
        expect(projectLine).toBe(`- **Project**: ${TASK}`);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "approve and save keeps the plan as a scope after the same-turn creation",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
      try {
        const scopesDir = join(proj, ".claude", "scopes");
        const gridPath = join(proj, ".claude", "tools", "data", "scope-grid.json");

        const r = await drive(proj, APPROVE_AND_SAVE, "Saved as scope", deadlineMs);

        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);
        assertToolResultContains(r, "Bash", "Saved as scope");
        // A 12th scope: the harness pair and its durable record.
        const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Grid;
        expect(Object.keys(grid).length).toBe(12);
        const savedName = Object.keys(grid).find((k) => !STOCK_SCOPES.has(k));
        if (savedName === undefined) throw new Error("No saved scope in grid");
        expect(existsSync(join(proj, "aidlc", "scopes", `${savedName}.md`))).toBe(true);
        assertComposedScopeSettings(assertComposedScopeFile(scopesDir, savedName));
        // The saved scope is the plan the work runs.
        const state = activeState(proj);
        const plan = planOf(state);
        const saved = grid[savedName].stages ?? {};
        for (const slug of Object.keys(plan)) {
          if (slug === "reverse-engineering") continue;
          expect(saved[slug], slug).toBe(plan[slug]);
        }
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

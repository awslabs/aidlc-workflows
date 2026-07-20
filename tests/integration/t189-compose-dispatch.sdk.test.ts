// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t189-compose-dispatch.sdk.test.ts - the P0 composer-dispatch beat (sdk).
//
// The deterministic half is pinned by t198 (the engine's Branch 4c emits the
// composer-dispatch print for compose/--new-scope/--report; Branch 8 emits the
// inference confirm / compose offer; classifyTerminalCommand stays null). What
// only a LIVE run can prove is the CONDUCTOR half the SKILL.md composer block
// names: on the dispatch print, the conductor Tasks the composer agent, the
// composer runs the read-only `detect` scan and returns a structured proposal,
// and the conductor renders the approve/edit/reject gate WITHOUT writing scope
// data or birthing before an approval.
//
// Journey (one interactive run, stopped at the gate):
//   drive:     `/aidlc compose "<task>"` on a fresh project (no workspace).
//   engine:    Branch 4c print naming the composer agent (t198 pins the shape).
//   conductor: dispatches the composer via the Task tool; the composer runs
//              `detect --json` (its tool-result carries the scan payload);
//              the conductor surfaces an AskUserQuestion gate.
//   stop:      at the FIRST AskUserQuestion (stopAfterAskUserQuestion) - the
//              gate itself is the P0 deliverable; no write, no birth.
//
// Assertions stay at the JOURNEY level (tool results + disk), tolerant of
// conversational variance, mirroring t143/t176 - NEVER on assistantText:
//   (a) the engine emitted the composer-dispatch print (Bash tool-result
//       carrying the deterministic directive JSON);
//   (b) the composer was DISPATCHED (a Task tool call appeared) - the
//       conductor did not improvise a grid inline;
//   (c) a gate fired (askedQuestions >= 1) and the run stopped there;
//   (d) NOTHING was written: no aidlc-state.md (no birth), no composed scope
//       file in .claude/scopes/ beyond the 9 stock ones, scope-grid.json
//       still has exactly 9 keys. P0 stops at render - the write is P2.
//   (e) the composer's returned proposal carries the ARS contract: the
//       Task/Agent tool-result names the entropy components (at least CSU)
//       and the evidence method (codekb | fallback). The dispatch print and
//       SKILL.md both demand the ars block; a proposal without it means the
//       composer silently ran the old keyword flow - the exact regression a
//       live trace caught once (three-key proposal, zero ARS output).
//
// It SPENDS TOKENS - driveAidlc drives the real /aidlc on Opus/Bedrock. Gated
// on claude-CLI presence (the file calls driveAidlc(), so claude-gate.ts marks
// it SDK-dependent; the runner skips-with-reason when claude is absent).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// A task no stock scope's keywords match, so even a conductor that second-
// guesses the verb has no keyword shortcut - the composer is the named move.
const TASK = "migrate our nightly ETL jobs to event-driven ingestion with replay";

describe("t189 composer dispatch (/aidlc compose, sdk live)", () => {
  test(
    "compose verb dispatches the composer agent, renders the gate, writes nothing before approval",
    async () => {
      const proj = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const r = await driveAidlc(`/aidlc compose "${TASK}"`, {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterAskUserQuestion: true,
        });

        // (a) The engine emitted the composer-dispatch print - the directive
        // JSON is the engine's verbatim stdout, never the LLM's rewording.
        assertToolResultContains(r, "Bash", "aidlc-composer-agent");

        // (b) The composer was DISPATCHED as a subagent (SKILL.md: "run the
        // composer via Task(aidlc-composer-agent)"). The harness surfaces the
        // subagent tool as "Task" or "Agent" depending on the SDK build -
        // accept either; an inline-improvised grid would show neither.
        const taskCalls = r.toolResults.filter(
          (t) => t.toolName === "Task" || t.toolName === "Agent",
        );
        expect(taskCalls.length).toBeGreaterThanOrEqual(1);

        // (e) The composer's proposal carries the ARS contract. Match the
        // component symbol case-insensitively (json key "csu" or table label
        // "CSU") and the method value - both are demanded verbatim by the
        // dispatch print, so their absence means the persona's scoring never
        // ran, not conversational variance.
        const composerOut = taskCalls.map((t) => t.resultText).join("\n");
        expect(composerOut.toLowerCase()).toContain("csu");
        expect(/\b(codekb|fallback)\b/i.test(composerOut)).toBe(true);

        // (c) A gate fired and the run stopped there (the approve/edit/reject
        // turn-stop the composer block mandates).
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // (d) NOTHING landed on disk before approval. No birth:
        const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
        const intentDirs = existsSync(intentsDir)
          ? readdirSync(intentsDir).filter((d) => !d.startsWith("."))
          : [];
        const stateFiles = intentDirs.filter((d) =>
          existsSync(join(intentsDir, d, "aidlc-state.md")),
        );
        expect(stateFiles).toEqual([]);
        // No composed scope file (the 9 stock scopes only):
        const scopesDir = join(proj, ".claude", "scopes");
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(9);
        // No grid mutation (exactly the 9 stock keys):
        const grid = JSON.parse(
          readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(9);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

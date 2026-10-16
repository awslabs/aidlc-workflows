// covers: subcommand:aidlc-utility:intent-create, file:skills/aidlc/SKILL.md
//
// t176-new-work-offer-second-intent.test.ts - the OFFER beat (sdk).
//
// The deterministic half of "a second intent alongside an active one" is pinned
// by t165 (intent-create mints a 2nd record while one is active; two isolated
// rows; distinct uuids; B's creation never mutates A's shard). This exercises
// the CONVERSATIONAL beat: with an intent already active, describing a
// GENUINELY NEW, UNRELATED piece of work prompts the orchestrator to OFFER a
// second intent (you confirm), rather than blindly advancing the active intent.
// RECOGNISING new-work + phrasing the offer is conductor PROSE (knowledge->LLM,
// in skills/aidlc/SKILL.md); on CONFIRM the prose routes through
// `next --new-intent`, so the read-only engine emits the SAME creation
// directive the fresh-start path does (carrying the `--label` seam) rather than
// the conductor hand-building intent-create. Either way it can only be verified
// LIVE, the way the codebase verifies every conductor behaviour: the Claude
// Agent SDK driver answering the offer on a structured callback.
//
// Journey (one interactive run):
//   seed:      ONE active intent mid-ideation (subject: a widget feature) +
//              its registry row (createTestProject's default record carries it).
//   drive:     `/aidlc "<a clearly unrelated new piece of work>"`.
//   conductor: recognises the input is NEW-WORK (not a continuation of the
//              widget intent), OFFERS a second intent via AskUserQuestion (the
//                answerScript confirms separate new work), then runs
//                `intent-create` and re-enters the loop - the run-then-continue
//                shape the offer prose names.
//   disk:      the registry now carries TWO in-flight intents (the offer was
//              confirmed and the creation fired into the active space).
//
// Assertions stay at the JOURNEY level, tolerant of conversational variance,
// mirroring t143/t71 — NEVER on assistantText. The proof the OFFER (not just a
// creation) fired is the CONJUNCTION of (a)+(b)+(c), not any one alone:
//   (a) an AskUserQuestion menu was surfaced (a human-gated pause). Asked BEFORE
//       the creation, since stopAfterToolResult halts on the first creation result. NB
//       this alone is NOT proof of the offer — the seeded intent is mid-ideation
//       at a gating EXECUTE stage, so a CONTINUATION would also surface an
//       approval gate; the offer-vs-gate distinction is carried by (b)+(c).
//   (b) the conductor ACTED on the confirm — `intent-create` ran (its verbatim
//       `State initialized:` summary, emitted ONLY inside handleIntentCreate,
//       landed as a Bash tool-result; a continuation path never emits it);
//   (c) a SECOND intent exists on disk — readIntentRegistry has 2 rows.
// The answerScript takes the option for separate new work wherever the agent
// shows it (the engine's routing question or the skill's Yes/No offer); a menu
// with none fails SAFE (option 1, no creation, (b)+(c) RED), never a false
// green.
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock. The run
// stops the instant the creation tool-result lands (stopAfterToolResult), or at
// the first stage step of the seeded work (stopWhen, so a red ends in about a
// minute instead of working that intent to the timeout), so no
// stage body of the new intent is executed. Gated on claude-CLI presence
// (run-tests.ts - the file calls driveAidlc(), so claude-gate.ts marks it
// SDK-dependent and the runner skips-with-reason when claude is absent; never a
// hard fail).

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  type AnswerScript, buildAnswers, type CapturedToolResult, driveAidlc, separateWorkOptionIndex,
} from "../harness/sdk-drive.ts";
import { readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Verbatim creation stdout summary (aidlc-utility.ts handleIntentCreate) - the
// deterministic surface that proves the offer was CONFIRMED and the creation ran.
const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_CREATION = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

// A new piece of work in a DIFFERENT domain from the seeded active intent
// (state-mid-ideation.md's subject is "Test widget feature for e-commerce
// platform"). Deliberately unmistakable so the conductor's default-to-
// CONTINUATION bias still classifies it as new-work and fires the offer.
const NEW_WORK =
  "build a standalone Python CLI that scrapes NOAA weather data and writes it to a SQLite database";

// Answer the offer affirmatively: the option for separate new work, wherever the
// agent puts it (separateWorkOptionIndex in sdk-drive.ts). The engine's routing
// question lists "Part of the active work" first, and the agent may show it in
// that order. A menu with no such option (a stage question of the seeded work)
// takes option 1, harmless, since (b)+(c) gate on a real creation.
const CONFIRM_OFFER: AnswerScript = {
  kind: "pick",
  pick: (question) => {
    const at = separateWorkOptionIndex(question.options);
    return at < 0 ? undefined : { optionIndex: at };
  },
};

// A stage step handed to the agent: the drive stops at the creation, so this is
// the seeded work going on instead of the offer. The drive ends there.
const SEEDED_STAGE_STEP = (results: readonly CapturedToolResult[]): boolean =>
  results.some((r) => r.toolName === "Bash" && /"kind":\s*"run-stage"/.test(r.resultText));

// The engine's routing question in its own order: the separate-work option is the
// second one, and the person's answer is that option wherever it is shown.
// Deterministic; the live journey below drives the real picker.
test("the answer is the separate-work option wherever the agent puts it", () => {
  const question = "Work is already in progress on the widget feature. What should I do?";
  const menu = [{
    header: "Route work",
    question,
    options: [
      { label: "Part of the active work", description: "Continue the current workflow" },
      { label: "Separate new piece of work", description: "Yes, set it up alongside the current one as \"classic\" work without changing it" },
      { label: "Reshape the active work", description: "Change how the remaining plan is shaped" },
    ],
  }];
  expect(buildAnswers(menu, CONFIRM_OFFER, 0)).toEqual({ [question]: "Separate new piece of work" });
});

describe("t176 P4 new-work offer (orchestrator offers a 2nd intent, sdk live)", () => {
  test(
    "describing unrelated new-work while an intent is active offers a 2nd intent; confirm → intent-create → 2 registry rows",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      // ONE active intent mid-ideation (the default seeded record carries the
      // withState fixture + its in-flight registry row). NOT noAidlcDocs — we
      // WANT an active intent so the engine would otherwise advance it and the
      // offer is the only path to a second intent.
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        stripEnvScope: true,
      });
      try {
        expect(readIntentRegistry(proj).length).toBe(1);

        const r = await driveAidlc(`/aidlc "${NEW_WORK}"`, {
          projectDir: proj,
          answerScript: CONFIRM_OFFER,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_CREATION,
          stopWhen: SEEDED_STAGE_STEP,
        });

        // (a) A human-gated pause preceded the creation - an AskUserQuestion menu
        // was surfaced (judgement→human: the conductor never auto-creates). Because
        // stopAfterToolResult halts on the FIRST creation tool-result, this question
        // was asked BEFORE the creation - i.e. it is the OFFER gating the creation, not
        // a later stage gate (a continuation that ran feasibility would gate but
        // never create, failing (b)+(c)). We deliberately do NOT assert the offer's
        // question TEXT - it is non-deterministic LLM prose; the answerScript selects
        // the separate-work option wherever it appears.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // (b) The conductor ACTED on the confirm — the named intent-create tool
        // ran and its verbatim summary landed as a Bash tool-result. This literal
        // is emitted ONLY inside handleIntentCreate, so a continuation path (which
        // creates nothing) never produces it. Together with the earlier question and
        // (c), this proves the offer was CONFIRMED and separate work was created.
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // (c) A SECOND intent now exists on disk (the creation fired into the
        // active space; the registry carries both rows).
        const reg = readIntentRegistry(proj);
        expect(reg.length).toBe(2);

        // (d) The 2nd intent's record dir is `<YYMMDD>-<short-label>` AND the
        // label is a CONDENSED essence, not a truncated copy of the new-work
        // sentence. This is the offer-to-create `--label` proof: the offer routes
        // through `next --new-intent`, which emits the SAME createPrintDirective
        // the fresh-start path uses (carrying the `--label "<2-3 word kebab
        // essence>"` placeholder), so the conductor supplies a real label here
        // exactly as it does on the first creation. WITHOUT that routing the
        // conductor fell back to truncating --arguments (e.g. the NOAA sentence →
        // "build-a-standalone-pytho", a mid-word 24-char cut with leading filler).
        // The seeded intent A has no registry dirName (legacy fixture record), so
        // the NEW row is the one with a date-prefixed dirName.
        const created = reg.find((e) => /^\d{6}-/.test(e.dirName ?? ""));
        expect(created).toBeDefined();
        const label = (created?.dirName ?? "").replace(/^\d{6}-/, "");
        // Concise (the cap is 24; a real essence is well under it) and free of the
        // leading filler words a raw truncation of NEW_WORK would carry ("build",
        // "a", "standalone") — a condensation drops them. Tolerant of model
        // wording variance: we assert SHAPE (short, no leading filler), not an
        // exact string. The registry slug equals the dir label (createIntent
        // normalizes once), so this also pins slug↔dirName agreement.
        expect(label.length).toBeLessThanOrEqual(24);
        expect(label).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(created?.slug).toBe(label);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

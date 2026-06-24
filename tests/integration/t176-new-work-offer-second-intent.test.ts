// covers: subcommand:aidlc-utility:intent-birth, file:skills/aidlc/SKILL.md
//
// t176-new-work-offer-second-intent.test.ts — the P4 OFFER beat (sdk).
//
// The deterministic half of "a second intent alongside an active one" is pinned
// by t165 (intent-birth mints a 2nd record while one is active; two isolated
// rows; distinct uuids; B's birth never mutates A's shard). What was NEVER
// exercised is the CONVERSATIONAL beat the vision promised: with an intent
// already active, describing a GENUINELY NEW, UNRELATED piece of work prompts
// the orchestrator to OFFER a second intent (you confirm), rather than blindly
// advancing the active intent. RECOGNISING new-work + phrasing the offer is
// conductor PROSE (knowledge→LLM, in skills/aidlc/SKILL.md); on CONFIRM the prose
// routes through `next --new-intent`, so the read-only engine emits the SAME
// birth directive the fresh-start path does (carrying the `--label` seam) rather
// than the conductor hand-building intent-birth. Either way it can only be
// verified LIVE, the way the codebase verifies every conductor behaviour: the
// Claude Agent SDK driver answering the offer Y/n on a structured callback.
//
// Journey (one interactive run):
//   seed:      ONE active intent mid-ideation (subject: a widget feature) +
//              its registry row (createTestProject's default record carries it).
//   drive:     `/aidlc "<a clearly unrelated new piece of work>"`.
//   conductor: recognises the input is NEW-WORK (not a continuation of the
//              widget intent), OFFERS a second intent via AskUserQuestion (the
//              answerScript confirms YES), then runs `intent-birth` and re-enters
//              the loop — the run-then-continue shape the offer prose names.
//   disk:      the registry now carries TWO in-flight intents (the offer was
//              confirmed and the birth fired into the active space).
//
// Assertions stay at the JOURNEY level, tolerant of conversational variance,
// mirroring t143/t71 — NEVER on assistantText. The proof the OFFER (not just a
// birth) fired is the CONJUNCTION of (a)+(b)+(c), not any one alone:
//   (a) an AskUserQuestion menu was surfaced (a human-gated pause). Asked BEFORE
//       the birth, since stopAfterToolResult halts on the first birth result. NB
//       this alone is NOT proof of the offer — the seeded intent is mid-ideation
//       at a gating EXECUTE stage, so a CONTINUATION would also surface an
//       approval gate; the offer-vs-gate distinction is carried by (b)+(c).
//   (b) the conductor ACTED on the confirm — `intent-birth` ran (its verbatim
//       `State initialized:` summary, emitted ONLY inside handleIntentBirth,
//       landed as a Bash tool-result; a continuation path never emits it);
//   (c) a SECOND intent exists on disk — readIntentRegistry has 2 rows.
// (b)+(c) are airtight: with an intent already active the engine advances it
// (Branch 10, !stateContent-gated births), so a 2nd intent can ONLY arise from
// the conductor's offer→confirm→intent-birth. The offer's affirmative option is
// pinned to "Yes" by the SKILL.md prose, which the answerScript keys on so the
// confirm is deterministic; a model that ignores that pin fails SAFE (the
// fallback misses → no birth → (b)+(c) RED), never a false green.
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock. The run
// stops the instant the birth tool-result lands (stopAfterToolResult), so no
// stage body of the new intent is executed. Gated on claude-CLI presence
// (run-tests.ts:274 — the file calls driveAidlc(), so claude-gate.ts marks it
// SDK-dependent and the runner skips-with-reason when claude is absent; never a
// hard fail).

import { describe, expect, test } from "bun:test";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";
import { readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// Timeout budget — same convention as t143/t71: honour AIDLC_TEST_TIMEOUT and
// abort the drive a hair early so a stuck run surfaces a partial DriveResult.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Verbatim birth stdout summary (aidlc-utility.ts handleIntentBirth :2400) — the
// deterministic surface that proves the offer was CONFIRMED and the birth ran.
const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_BIRTH = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;

// A new piece of work in a DIFFERENT domain from the seeded active intent
// (state-mid-ideation.md's subject is "Test widget feature for e-commerce
// platform"). Deliberately unmistakable so the conductor's default-to-
// CONTINUATION bias still classifies it as new-work and fires the offer.
const NEW_WORK =
  "build a standalone Python CLI that scrapes NOAA weather data and writes it to a SQLite database";

// Answer the offer affirmatively. The offer prose PINS the affirmative option to
// lead with "Yes" (SKILL.md: 'lead the affirmative option with the word "Yes"'),
// so labelContains("Yes") is anchored by the change under test — not a hopeful
// guess at the model's wording. resolveSpec/pickContains falls back to the first
// option if no label contains "Yes" (sdk-drive.ts), so a mislabeled affirmative
// would fail SAFE (no birth → asserts (b)+(c) fail), never a false green. Any
// non-offer menu (e.g. a continuation approval gate) also takes the fallback —
// harmless, since (b)+(c) gate on a real birth.
const CONFIRM_OFFER = {
  kind: "byHeader" as const,
  map: {},
  fallback: { labelContains: "Yes" },
};

describe("t176 P4 new-work offer (orchestrator offers a 2nd intent, sdk live)", () => {
  test(
    "describing unrelated new-work while an intent is active offers a 2nd intent; confirm → intent-birth → 2 registry rows",
    async () => {
      // ONE active intent mid-ideation (the default seeded record carries the
      // withState fixture + its in-flight registry row). NOT noAidlcDocs — we
      // WANT an active intent so the engine would otherwise advance it and the
      // offer is the only path to a second intent.
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        stripEnvScope: true,
      });
      try {
        // Sanity: exactly one intent before the run.
        expect(readIntentRegistry(proj).length).toBe(1);

        const r = await driveAidlc(`/aidlc "${NEW_WORK}"`, {
          projectDir: proj,
          answerScript: CONFIRM_OFFER,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_BIRTH,
        });

        // (a) A human-gated pause preceded the birth — an AskUserQuestion menu
        // was surfaced (judgement→human: the conductor never auto-births). Because
        // stopAfterToolResult halts on the FIRST birth tool-result, this question
        // was asked BEFORE the birth — i.e. it is the OFFER gating the birth, not
        // a later stage gate (a continuation that ran feasibility would gate but
        // never birth, failing (b)+(c)). We deliberately do NOT assert the offer's
        // question TEXT — it is non-deterministic LLM prose (verified: live runs
        // phrase it "...unrelated pieces of work. How should I proceed?" with no
        // fixed token); the deterministic offer surface is the affirmative option
        // label the prose pins to "Yes", which the answerScript keys on below.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // (b) The conductor ACTED on the confirm — the named intent-birth tool
        // ran and its verbatim summary landed as a Bash tool-result. This literal
        // is emitted ONLY inside handleIntentBirth, so a continuation path (which
        // births nothing) never produces it. (b)+(c) are the airtight proof the
        // offer was CONFIRMED: with an intent already active the engine advances
        // it (Branch 10) and every birth arm is !stateContent-gated, so a 2nd
        // intent can ONLY appear via the conductor's offer→confirm→intent-birth.
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // (c) A SECOND intent now exists on disk (the birth fired into the
        // active space; the registry carries both rows).
        const reg = readIntentRegistry(proj);
        expect(reg.length).toBe(2);

        // (d) The 2nd intent's record dir is `<YYMMDD>-<short-label>` AND the
        // label is a CONDENSED essence, not a truncated copy of the new-work
        // sentence. This is the offer-birth `--label` proof: the offer routes
        // through `next --new-intent`, which emits the SAME birthPrintDirective
        // the fresh-start path uses (carrying the `--label "<2-3 word kebab
        // essence>"` placeholder), so the conductor supplies a real label here
        // exactly as it does on the first birth. WITHOUT that routing the
        // conductor fell back to truncating --arguments (e.g. the NOAA sentence →
        // "build-a-standalone-pytho", a mid-word 24-char cut with leading filler).
        // The seeded intent A has no registry dirName (legacy fixture record), so
        // the NEW row is the one with a date-prefixed dirName.
        const born = reg.find((e) => /^\d{6}-/.test(e.dirName ?? ""));
        expect(born).toBeDefined();
        const label = (born?.dirName ?? "").replace(/^\d{6}-/, "");
        // Concise (the cap is 24; a real essence is well under it) and free of the
        // leading filler words a raw truncation of NEW_WORK would carry ("build",
        // "a", "standalone") — a condensation drops them. Tolerant of model
        // wording variance: we assert SHAPE (short, no leading filler), not an
        // exact string. The registry slug equals the dir label (birthIntent
        // normalizes once), so this also pins slug↔dirName agreement.
        expect(label.length).toBeLessThanOrEqual(24);
        expect(label).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(born?.slug).toBe(label);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

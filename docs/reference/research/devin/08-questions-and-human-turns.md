# Structured questions and human-turn recording

**Finding:** DEVIN-08. **Status:** Implemented response compatibility; live batch/cancellation authority coverage remains limited. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12; upstream-merge 2026-10-13 and 2026-10-14.

## Why this was needed

A visible question and a clicked answer did not necessarily produce the evidence AI-DLC uses to record answers or approve plans. Early fixtures matched the adapter's assumptions instead of the host's response envelope, allowing silent no-ops to pass tests.

## Current implementation

The shared stage protocol owns the neutral question spec, never-echo requirement, option coverage, summary checkpoint, and non-matching-reply rules; since the `0f39a808` merge the summary checkpoint itself lives in the summary module `stage-protocol-summary.md`, which §3 Step 3a names. The Devin annex references that method (§3, the summary module, and the logging checklist) and supplies only native rendering details; t181's Devin branch checks the referenced tokens in core and refuses a copy of them in the annex. It maps neutral multiSelect to native multi_select; responses are associated with the exact question text, selected labels, and optional custom_text.

Native calls allow 1–4 questions with 2–4 explicit options each. Other is supplied by the tool. Larger option sets must avoid a one-option remainder, duplicate question texts must not collide in a batch, and skip/cancellation/Other must not manufacture an approved checkpoint.

Hook parsing and tool-facing rendering are different layers. normalizeToolResponse accepts a string or an object containing an output string. extractJsonFromString handles a leading User answered your questions prefix. The selection parser supports legacy answers arrays, synthetic arrays of selected objects, and wrapped/unwrapped question-text maps with selected arrays.

record-human-turn skips only when no explicit selection was recognized AND the response is classified as cancellation. Otherwise it forwards to the shared human-turn hook, even for some unknown or missing response shapes. Explicit text extraction chooses the first nonempty selected label, then custom text when applicable, rather than returning the entire batch. This is the implemented compatibility behavior, not a guarantee of complete batch approval semantics. Since the `59264b2c` merge, upstream `e0b28084` (#2336) narrowed `isNonAnswer` to a reply with no words in it — "cancel"/"abort"/"timed out" count as the person's own words, so a `selected` label carrying one is an explicit selection; Devin-side cancellation is recognised by shape, not words, via `success:false` (`isAskUserQuestionCancellation`) or `skipped:true` on the answer record. The t149 Devin-shape case that expected `selected:["cancelled"]` to be rejected was replaced by two cases — an empty selection is not an explicit selection, and `["cancelled"]` is one.

A HUMAN_TURN is evidence of interaction in the engine's model; it is not a Plan Approval receipt. Correct offered choice, session, challenge, content, and attempt checks remain necessary. Contradictory success/selection/cancellation fields and partial batches need explicit regression coverage rather than optimistic assumptions.

## Evidence and limits

The headless S02 C07/C08 captures contain cancelled attempts, not answered PostToolUse envelopes. Historical interactive session exports informed native-answer fixtures; the original exports were removed from the working tree and are recoverable from Git history. An exported tool response is not automatically a raw hook-stdin capture; keep those provenance levels separate.

t332 covers object response, selected/Other compatibility shapes, successful unknown responses, cancellation, wrapped/unwrapped native-shaped maps, and a seeded Plan Approval response. This does not prove a fresh end-to-end interactive approval on the current host.

No Devin-specific long-prompt wrapping guarantee was established. The shared worktree long-path fallback reference is not proof that a fallback is implemented or tested on Devin.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Native rendering fields | multi_select is native; every option is offered without duplicate Other or a one-option remainder | t250-question-fence-never-echo; focused t181 checkpoint/reference tests; live UI check separate |
| Object/prefixed/native answer | Human-turn evidence and recognized choice survive the actual envelope | t332 tests 13a–13h; retain fixture provenance |
| Plan Approval response | Recognized offered approval with a real challenge produces a protected response, not merely an exit 0 | t332 test 13d; DEVIN-09 |
| Partial/unknown/contradictory response | No unrecognized or skipped choice becomes authorization; batch answers remain correctly associated | Coverage gap: current compatibility fallback and first-text extraction need targeted live and deterministic cases |
| Shared method update | Devin references the normative checkpoint rules without duplicating or weakening them | t250 and t181 source-contract checks |

## Superseded approaches and history

`f51d55d3` fixed the outer object envelope. `d6e26c47`, `8d8d4987`, and `a5b3fb38` addressed later shape/recording issues; `3d426b04` handled the textual prefix. `40d65300` centralized method wording and corrected the native field mapping.

Retired: string-only hook responses; Claude-only inner answer shapes; exit 0 means a human turn was written; a human turn means plan approval; an answered tool schema proves an answered hook capture; the original run-2 wrapper fix alone established full approval correctness.

## Sources

- `harness/devin/skills/aidlc/question-rendering.md`
- `core/aidlc-common/protocols/stage-protocol.md` — Structured questions, Question Format, Approval Gates
- `core/aidlc-common/protocols/stage-protocol-summary.md` — the consolidated-summary checkpoint (since `0f39a808`)
- `harness/devin/hooks/aidlc-devin-adapter.ts` — response parsing, record-human-turn
- `core/hooks/aidlc-record-human-turn.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- `tests/smoke/t250-question-fence-never-echo.test.ts`
- `tests/unit/t181-conductor-skill-parity.test.ts`
- `tests/fixtures/devin-hook-payloads/native-contracts-3000.10.31.provenance.json` — capture method and limits (the `capture-provenance.json` this entry previously named was removed under Item 9; in Git history)
- `core/knowledge/aidlc-shared/worktree-info-schema.md`

[Back to findings index](index.md)

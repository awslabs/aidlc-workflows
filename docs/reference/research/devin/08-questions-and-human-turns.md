# Structured questions and human-turn recording

**Finding:** DEVIN-08. **Status:** Implemented. Free text, batches and multi-select keep the person's words per question (`99a54c8b`), the decision's material travels in the question, and decline/cancel is the own-words path. All three were accepted live over ACP on 3000.11.3 (2026-10-15 rerun). Contradictory response fields and third-party ACP clients remain unexercised. **Source baseline:** `99a54c8b` (earlier sections were written against `6e208f7b`). **Fact-checked:** 2026-09-12; upstream-merge 2026-10-13, 2026-10-14 and 2026-10-27; live ACP runs 2026-10-14, 2026-10-15 and 2026-10-27 (message-id forwarding, `7a775309`).

## Why this was needed

A visible question and a clicked answer did not necessarily produce the evidence AI-DLC uses to record answers or approve plans. Early fixtures matched the adapter's assumptions instead of the host's response envelope, allowing silent no-ops to pass tests.

## Current implementation

The shared stage protocol owns the neutral question spec, never-echo requirement, option coverage, summary checkpoint, and non-matching-reply rules; since the `0f39a808` merge the summary checkpoint itself lives in the summary module `stage-protocol-summary.md`, which §3 Step 3a names. The Devin annex references that method (§3, the summary module, and the logging checklist) and supplies only native rendering details; t181's Devin branch checks the referenced tokens in core and refuses a copy of them in the annex. It maps neutral multiSelect to native multi_select; responses are associated with the exact question text, selected labels, and optional custom_text.

Native calls allow 1–4 questions with 2–4 explicit options each. Other is supplied by the tool. A question with more options is asked on its own as a numbered list, never split across calls (stage-protocol Step 3a, since the `cbf7741c` merge; it used to be split with no one-option remainder), duplicate question texts must not collide in a batch, and skip/cancellation/Other must not manufacture an approved checkpoint.

Over ACP (`devin acp`, 3000.11.3) a question arrives as a standard `elicitation/create` form with a closed `oneOf`; free text is allowed only by Devin's `_meta: {"cognition.ai/allowOther": true}`, which a third-party client may ignore. Every compliant client must offer decline and cancel (ACP elicitation spec). Devin answers a decline to the model as "The user wants to clarify these questions… Start by asking them what they would like to clarify" and a cancel as "User canceled the question"; neither fires PostToolUse (captured 2026-10-15). So the annex names both ways to answer in one's own words ("Pick "Other" on any question, or decline it and tell me…"), and after a decline or cancel the conductor asks what they would like to say and ends the turn, so their next typed message is the answer.

The question text is where the decision's material goes on Devin (annex section "What the person decides on goes in the question"): the completion message and review brief at a gate, the decision brief at the summary confirmation, the Plan Approval summary lines and plan paths, and the composer's short offer. A live ACP run showed 11 of 22 questions arriving with no text before them, because an ACP client's form is the prominent element and text said earlier can go unread or unsaid. The verification-command and Construction policy questions are the exception: their reply is matched to the exact `--decision` text by digest, so that text is their whole question.

Hook parsing and tool-facing rendering are different layers. normalizeToolResponse accepts a string or an object containing an output string. extractJsonFromString handles a leading User answered your questions prefix. The selection parser supports legacy answers arrays, synthetic arrays of selected objects, and wrapped/unwrapped question-text maps with selected arrays.

record-human-turn skips only when no explicit selection was recognized AND the response is classified as cancellation. Otherwise it forwards to the shared human-turn hook, even for some unknown or missing response shapes. Since 2026-10-15 an answer is forwarded as the picker reply it is (a PostToolUse with `tool_input.questions`, `multiSelect` normalised from `multi_select`, and `tool_response: {answer, answers}`), the same picker contract Claude Code and the Codex adapter use, never as a typed prompt. `pickerAnswers` keeps every question's reply in the order asked; a free-text Other answer is its `custom_text`, never the word "Other"; a skipped question has no entry. `answer` is the one question's reply, or one `<question>: <reply>` line per question for a batch. Before that fix the adapter sent the first selected label as a typed prompt: a live ACP run (2026-10-14) stored three free-text answers as "Other" and a three-question batch as its first answer, so gate feedback read "Other" and settings asked for in the person's words showed as "set by a command". Since the `59264b2c` merge, upstream `e0b28084` (#2336) narrowed `isNonAnswer` to a reply with no words in it — "cancel"/"abort"/"timed out" count as the person's own words, so a `selected` label carrying one is an explicit selection; Devin-side cancellation is recognised by shape, not words, via `success:false` (`isAskUserQuestionCancellation`) or `skipped:true` on the answer record. The t149 Devin-shape case that expected `selected:["cancelled"]` to be rejected was replaced by two cases — an empty selection is not an explicit selection, and `["cancelled"]` is one. Since `7a775309` (2026-10-27) the adapter also forwards the core hook's output on both paths, re-wrapped as Devin's `hookSpecificOutput` under the event that fired (`PostToolUse` for a question box, `UserPromptSubmit` for a typed message): the note naming the person's message id, which every setter's `--message <id>` needs, and the unanswered-question notice. Before that the agent never learned the id, and a check the person turned on read "set by a command" (DEVIN-09). A cancelled question still prints nothing.

A HUMAN_TURN is evidence of interaction in the engine's model; it is not a Plan Approval receipt. Correct offered choice, session, challenge, content, and attempt checks remain necessary. Contradictory success/selection/cancellation fields and partial batches need explicit regression coverage rather than optimistic assumptions.

## Evidence and limits

The headless S02 C07/C08 captures contain cancelled attempts, not answered PostToolUse envelopes. Historical interactive session exports informed native-answer fixtures; the original exports were removed from the working tree and are recoverable from Git history. An exported tool response is not automatically a raw hook-stdin capture; keep those provenance levels separate.

t332 covers object response, selected/Other compatibility shapes, successful unknown responses, cancellation, wrapped/unwrapped native-shaped maps, a seeded Plan Approval response, and (13m–13q) the captured 3000.11.3 batch, single free text, multi-select, skipped questions, gate feedback and `replyOfTheirs`.

The answered-question shape is now a hook capture, not an inference. On 2026-10-15 a stdin-logger PostToolUse hook in a scratch project captured an ACP-answered batch on 3000.11.3: `{success:true, output:"User answered your questions:\n{…}", error:null}`, the JSON keyed by exact question text with `{selected, custom_text, skipped}` per question. A free-text answer is `selected:["Other"]` plus its `custom_text`. The earlier synthetic `payloads.json` shapes had never been checked against a capture; the parser was right for them and wrong for the person's words.

Two live ACP intents on 3000.11.3 (DEVIN-14 has the recipe and results) are end-to-end evidence over ACP, not over Devin's own UI. Run 1 (2026-10-14, `822d7e61`) found the defects: three free-text answers stored as "Other", a three-question batch stored as its first answer, and 11 of 22 questions with no text before them. Run 2 (2026-10-15, `99a54c8b`) stored 27 messages (22 picker, 5 typed), none reading "Other". Its batch kept all four replies, every decision question carried its material, and a decline and a cancel each left the question open for the typed reply that answered it. Neither run used Devin's terminal UI, Desktop, or a third-party ACP client.

The Codex adapter still has its own `explicitHumanSelectionText`, which takes the first label, for the `answer` field it forwards. It also forwards the whole reply as `picker_reply`, which the core's per-question reader prefers. Codex was not run, so whether it shows the A1 symptom is not established.

No Devin-specific long-prompt wrapping guarantee was established. The shared worktree long-path fallback reference is not proof that a fallback is implemented or tested on Devin.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Native rendering fields | multi_select is native; every option is offered without duplicate Other; a question with more than four options is one numbered list | t250-question-fence-never-echo; focused t181 checkpoint/reference tests; live UI check separate |
| Object/prefixed/native answer | Human-turn evidence and recognized choice survive the actual envelope | t332 tests 13a–13h; retain fixture provenance |
| Plan Approval response | Recognized offered approval with a real challenge produces a protected response, not merely an exit 0 | t332 test 13d; DEVIN-09 |
| Free text, batch, skipped | Each question's reply is kept word for word, free text as the person typed it; a skipped question keeps its place with no reply | t332 13m–13q (13m replays the captured 3000.11.3 ACP batch, fixture `postToolUse_askUserQuestion_acp3000_11_3_batchOther`) |
| Gate feedback and setting words | A free-text Request Changes is the gate's feedback; a free-text reply is stored with its words and reads as a reply (`messageIsReply`, which replaced `replyOfTheirs` at the `cbf7741c` merge) | t332 13o, 13p |
| Decision material in the question | The annex binds gate, summary, Plan Approval and composer material into the question text; protected questions keep their logged text | t181 "the Devin annex puts what the person decides on in the question"; live ACP rerun |
| Live question channel over ACP | A free-text answer is stored word for word; a declined or cancelled question stays open for the typed reply; batches are stored whole; the decision material is in the question | Gated `t-acp-devin-questions` and `t-acp-devin-journey` (`AIDLC_DEVIN_ACP_LIVE=1`, driver `tests/harness/devin-acp-drive.ts`, DEVIN-14); passed on 3000.11.92 on 2026-10-15 |
| Message id reaches the agent | A question-box answer and a typed message each hand the agent the id of the person's message, so a setter's `--message <id>` reads "set by you" | t332 13r–13u; live on 3000.11.228 (2026-10-27, DEVIN-14) |
| Partial/unknown/contradictory response | No unrecognized or skipped choice becomes authorization | t332 13e/13f; contradictory success/selection fields remain a gap |
| Shared method update | Devin references the normative checkpoint rules without duplicating or weakening them | t250 and t181 source-contract checks |

## Superseded approaches and history

`f51d55d3` fixed the outer object envelope. `d6e26c47`, `8d8d4987`, and `a5b3fb38` addressed later shape/recording issues; `3d426b04` handled the textual prefix. `40d65300` centralized method wording and corrected the native field mapping. `99a54c8b` replaced `explicitHumanSelectionText` with `pickerAnswers` and the typed-prompt forwarding with a picker PostToolUse, and bound the decision material and the decline/cancel path into the annex and `composer.md`.

Retired: string-only hook responses; Claude-only inner answer shapes; the first selected label as the person's message; an answer forwarded as a typed prompt; decision material said only before the question; exit 0 means a human turn was written; a human turn means plan approval; an answered tool schema proves an answered hook capture; the original run-2 wrapper fix alone established full approval correctness.

## Sources

- `harness/devin/skills/aidlc/question-rendering.md` — including "What the person decides on goes in the question"
- `harness/devin/skills/aidlc/composer.md` — the offer in the gate's question
- `tests/fixtures/devin-hook-payloads/payloads.json` — `postToolUse_askUserQuestion_acp3000_11_3_batchOther` (the 2026-10-15 capture) and the free-text, multi-select and skipped variants
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

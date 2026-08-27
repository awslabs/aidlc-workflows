# Reviewer Protocol Module

Load this module when a directive names a reviewer with an effective review class other than `none`.

## 12a. Reviewer Invocation

If the `run-stage` directive includes a `reviewer` field (non-null), the orchestrator MUST invoke the reviewer as a **separate sub-agent** after the stage body produces its artifacts and before the §13 learnings ritual.

The directive's `review_class` field tells you HOW the review runs - the engine has already resolved it (stage declaration, lowered by the scope's `review_cap` and any per-run `--review` override; a `none` resolution omits the reviewer block entirely, so a directive that carries a reviewer always carries a class):

- **`adversarial`** - the refute-and-repair loop below, up to `reviewer_max_iterations` passes with lead fixes between them. The default for Construction stages, where findings are machine-checkable and fix loops converge.
- **`advisory`** - ONE normal-flow review pass as decision support for the human gate (`reviewer_max_iterations` is 1). Whatever the verdict, do NOT re-invoke the lead and do NOT re-run the reviewer during normal flow: record the terminal receipt, proceed to §13, and quote the reviewer's findings VERBATIM at the approval gate for the human to triage. The bounded stale-receipt recovery below is the only exception. The default for the human-gated ideation/inception prose stages, where readiness is a judgment call that belongs to the human at the gate.

### What the user hears from this section

A directive's `narration` value covers entering a stage; it cannot reach inside one, and this check happens inside. So three sentences are written for it here, and each is the whole of what the user hears at that moment. Only the double-quoted text is ever spoken; fill the `[bracketed]` slots and drop the brackets.

- Before the check - **SAY:** "Let me have the [reviewer's trade] check this over before you see it."
- Findings came back and you are fixing them - **SAY:** "Fair points came back, let me tighten [the specific thing, in plain terms] and re-check." Once per round, never once per finding.
- Concerns remain after the last round - **SAY:** "I had this checked [N] times and [N] concern[s] are still open. They are in the artifact and I will flag them at the decision below, so you can judge whether they matter."
- A revision changed the work, so the check runs again - **SAY:** "Those changes are in. Let me get them checked over again before you look."

Everything else in this section is silent. Nothing is said about invoking, handing off, sub-agents, iterations, budgets, receipts, dispatch records, the exempt list, or a verdict as a token: the user hears "a second look", never "the reviewer returned NOT-READY". Nor is the trigger for a re-check explained in the framework's terms: which declared outputs an edit touched, whether a recorded verdict is now stale, and what has to be re-recorded are all internal, so the sentence above is the whole of it. Name the trade, never the agent's file or slug. When the field is absent this check does not run, and that is not something the user hears either, in any wording: go straight to the next thing you actually do. Reasoning aloud about whether a branch applies is the surest way to leak internal vocabulary, because the only words for it are internal ones.

### Flow

1. **Invoke reviewer sub-agent.** Before every dispatch, not only the first,
   and before changing an existing `## Review` section, record the request:
   `bun .claude/tools/aidlc-log.ts review --stage "<directive.stage>" --reviewer "<directive.reviewer>" --iteration <n>`;
   add `--unit "<directive.unit>"` on a per-unit stage and `--single` on an
   isolated stage run. This request-first ordering is mandatory for a
   stale-source recovery: the validated pending recovery request suspends the
   review freeze only for this stage/Unit, only while the stale condition still
   exists, and only in the session that recorded or retried the request. Source
   staleness by itself never suspends the freeze. Restoring the reviewed
   workspace source, recording the verdict, or starting/resuming another
   session re-arms the freeze; restoring output-document bytes does not clear
   audit-recorded artifact staleness or reopen review allowance. After a
   session restart, rerun the same request with
   `--retry-pending` to reopen the scoped suspension if the stale condition
   still exists. If the source is restored to its reviewed state while recovery
   is pending, the suspension closes immediately: do not try to replace the
   `## Review` section after that restore. Either record the completed verdict
   against the restored state, or obtain the human's Request Changes decision
   before editing again.

   `directive.review_artifact` names the one required Markdown output that owns
   the review appendix; no produces-list position, plugin-added output, or
   directory enumeration may redefine it. On a per-unit review it resolves
   inside that Unit. The request binds every declared artifact and the exact
   bytes before any existing terminal appendix. When such an appendix exists,
   the successful request's JSON returns `reviewChallenge`; preserve that exact
   value and pass it to the reviewer dispatch. A retry preserves the original
   challenge, while a legacy unmatched request receives one during its bounded
   `--retry-pending` modernization. After the request succeeds, if that artifact
   already carries a
   `## Review` section (from a prior iteration, or predating a Part 0 revision),
   handle it in this order:
   1. On a re-dispatch (adversarial iteration greater than 1, a Part 0 revision
      re-review, or stale-receipt recovery), run
      `bun .claude/tools/aidlc-review-brief.ts context --stage "<directive.stage>"`;
      add `--unit "<directive.unit>"` on a per-unit review. Retain the complete
      stdout as `Prior findings (carry IDs forward)` for the dispatch brief.
      The tool overlays durable human dispositions from the audit ledger, so
      `Accepted risk` and `Rejected: <reason>` survive without editing the
      receipt-frozen artifact.
   2. DELETE the existing `## Review` section and every separator byte
      introduced with it, restoring the request-bound pre-append bytes. This
      makes step 3's missing-section check mean the same thing on every path: a
      fresh review that is cut off before writing leaves no old verdict to
      misread as covering new work. Receipt history remains in the audit ledger;
      the rendered context carries finding identity and disposition into the
      next review.

   Then delegate to the reviewer agent named in `directive.reviewer`. The
   request remains unmatched while the reviewer runs, so the approval gate and
   completion stay blocked.

   Pass:
   - The stage definition file path (`directive.stage_file`)
   - The Q&A file path (e.g., `<record>/<phase>/<stage>/<stage>-questions.md`)
   - All artifact file paths produced by the stage (the `produces` artifacts)
   - On every re-dispatch named above, `Prior findings (carry IDs forward):` followed by the review-context tool output verbatim. The reviewer MUST preserve those IDs and update their statuses rather than replacing or renumbering the prior list.
   - The resolved paths in `directive.consumes` — all upstream artifacts the stage declares — paths only, per the context-budget rule. This applies to **every** reviewer-bearing stage, not only per-unit ones:
     - For a **per-unit** stage (`directive.unit` present) these include the shared inception contracts that pin cross-unit boundaries (`components.md`, `contract-summary.md`, `unit-of-work.md`).
     - For a **workflow-level** stage with no `directive.unit` (e.g. `contract-design`), these are the upstream artifacts that justify the produced output — the unit DAG (`unit-of-work.md`, `unit-of-work-dependency.md`), the component catalogue (`components.md`), and `requirements.md` — so the reviewer can verify the contracts against the boundaries, entities, and NFRs they formalise rather than reviewing the summary in isolation.
   - The validation tools list from the stage definition's frontmatter (if any)
   - For a per-unit `workspace_requires` stage, the unit's
     `source-manifest.json` path and its claimed source paths. Review the
     implementation differentially at those paths rather than sweeping the
     whole workspace; treat any claim that looks unrelated to the unit as a
     finding.

   Do NOT pass: `memory.md` (builder's diary) or any plan/reasoning files. The reviewer forms independent judgment.

   **Reviewer read scope.** The reviewer's scope is the current unit's artifacts plus the passed contract paths. On a per-unit stage the reviewer MUST NOT read other units' `construction/<other-unit>/` content through any tool - not by opening files, and not via grep, glob, or shell patterns that span sibling unit paths (a `construction/*/` glob is a sibling read, not a search) - except to spot-check an integration point the current unit's design explicitly names, and only the owning file, resolved via the shared contracts rather than by browsing or searching the sibling's directory. Cross-unit contract verification runs against the shared inception artifacts passed above, not against a sweep of sibling units' design prose.

   **Dispatch record (per-unit stages; enforcement-capable harnesses only).** This record is required only when the current harness registers reviewer-scope PreToolUse enforcement (Claude Code, Kiro CLI, Codex CLI, opencode, Cursor, and GitHub Copilot today). Immediately before invoking a per-unit reviewer (`directive.unit` present) on one of those harnesses, write `<record>/.aidlc-reviewer-dispatch.json`:

   ```json
   {"reviewer": "<directive.reviewer>", "stage": "<stage slug>", "unit": "<directive.unit>",
    "exempt": ["<each resolved directive.consumes path>", "<stage file path>", "<Q&A file path>"]}
   ```

   When the current unit's design explicitly names an integration point in a sibling unit's file, resolve that single owning file via the shared contracts and append its path to `exempt` - the record is where the spot-check carve-out is granted. The `stage` field appears verbatim in any `REVIEWER_SCOPE_BLOCKED` audit row; use the current stage slug. The reviewer-scope PreToolUse hook reads this record to enforce the read-scope bound deterministically while the review is in flight; on a NOT-READY re-invoke (step 3 back to step 1), write a fresh record. Single-stage reviews (no `directive.unit`) write no record. On a harness without reviewer-scope enforcement (Kiro IDE today), do not write the record; the reviewer read-scope bound remains mandatory prose in the delegated task and reviewer persona.

   Immediately before every reviewer dispatch, record the request:
   `bun .claude/tools/aidlc-log.ts review --stage "<directive.stage>" --reviewer "<directive.reviewer>" --iteration <n>`; add `--unit "<directive.unit>"` on a per-unit stage and `--single` on an isolated stage run.
   For a per-unit `workspace_requires` stage, this command validates
   `source-manifest.json` and binds both its bytes and the currently claimed
   source bytes into `REVIEW_REQUESTED`; it refuses before dispatch when the
   manifest is missing or invalid.
   The request is accepted only after the stage's consolidated answers are
   confirmed and every verifiable required output document exists. Per-unit
   stages also enforce membership when the authoritative Unit set resolves;
   inability to resolve that set does not refuse the request, while a resolved
   set still refuses a Unit that is absent. A named Unit's required outputs
   remain mandatory. If the request is refused, finish the named prerequisite
   before dispatching the reviewer.
   The logger captures every declared artifact through one stable file-identity
   snapshot, binds the request to the exact pre-append bytes of
   `directive.review_artifact`, and records the current workspace and per-unit
   source fingerprints where applicable. The reviewer may append only the
   canonical section below after that byte boundary.
   If that dispatch fails, times out, or ends without a recorded verdict - the
   session died, or the reviewer returned an incomplete attempt (step 3: no
   current `## Review` section, or no single canonical verdict) - return to the
   start of this step, delete any partial `## Review` appendix, then rerun the
   same request command with `--retry-pending` immediately before dispatching
   again. The logger accepts it exactly once, only while that exact request is unmatched and
   the declared artifacts and workspace source exactly match the original
   request; it reuses those original fingerprints instead of rebaselining
   current bytes, marks the retry in the audit, and does not consume another
   review iteration. Never
   use `--retry-pending` after a verdict; a receipt-invalidating write creates
   a new recovery request at the next ordinal, not a retry of the completed one.
2. **Reviewer executes.** An `adversarial` review runs under the **adversarial review contract**:

   - **Refute, don't confirm.** The reviewer's job is to refute the artifact, not to confirm it. It assumes defects exist and hunts for them; READY is the verdict it fails to reach after trying to break the artifact, not the default it starts from.
   - **Ground findings in machine-checkable evidence where it exists.** The reviewer runs the validation tools the invocation lists (via shell) and checks the artifact against its acceptance criteria, its stage definition, and the consumed upstream contracts. A finding backed only by opinion is a suggestion, not grounds for NOT-READY.

   An `advisory` review keeps the evidence-grounding rule but not the refute-until-READY posture: tell the reviewer in the dispatch brief that this is a SINGLE normal-flow advisory pass whose findings go to the human at the approval gate - report only findings the human should weigh before approving, ranked by severity, with no fix-and-re-review loop behind it. The stale-receipt recovery below is a separate bounded request, not a repair loop.

   The reviewer sub-agent:
   - Reads the stage definition to understand what SHOULD have been produced
   - Reads the Q&A to understand context and constraints
   - Reads the artifact(s) to evaluate what WAS produced
   - Verifies cross-unit contract claims against the passed shared inception contracts, not by sweeping or searching sibling units' design directories (no cross-unit grep or glob patterns); opens another unit's file only when the current unit's design explicitly names it as an integration point, and only that file
   - Runs any validation tools listed (via shell) and includes results in findings
   - Appends exactly ONE terminal `## Review` section to `directive.review_artifact`, beginning at the request's recorded byte boundary. Before the heading it may add blank separator lines only. The section uses the knowledge template and contains exactly one total rendered `**Verdict:** READY|NOT-READY`, one total rendered `**Reviewer:** <directive.reviewer>`, and one total rendered `**Iteration:** <n>` line. When the request returned `reviewChallenge`, it also contains exactly one rendered `**Request Challenge:** <reviewChallenge>` line with that exact value; when none was returned, it omits the line. It may use H3+ subsections inside the review, but no later H1, H2, setext, or raw-HTML H1/H2 heading may open unowned top-level content. Literal headings and ownership-field examples inside fenced or inline code do not count. Step 3 treats anything else as an incomplete review.
   - Returns a response whose FIRST line is its identity marker verbatim
     (`**Reviewer:** <reviewer-agent-name>`), so the `SUBAGENT_COMPLETED` audit
     event records which reviewer ran. The reviewer's persona owns this contract.

3. **Read verdict.** After the reviewer returns, delete `<record>/.aidlc-reviewer-dispatch.json` if one was written (the enforcement window closes with the review; a leftover record would keep refusing sibling access for later, unrelated work), then read the `## Review` section from `directive.review_artifact` and validate it. The review is complete only when every pre-dispatch artifact byte and the request-time source fingerprint still match and the entire appended suffix is exactly ONE terminal owned `## Review` section with the canonical verdict, reviewer, and iteration fields above, plus the conditional request-challenge field when issued. Validation uses Bun's Markdown parser: fenced/inline code and HTML comments cannot supply or conflict with authority fields, list/blockquote/table containers cannot mint top-level ownership, and rendered Markdown or raw-HTML H1/H2 headings are terminal-section escapes. Anything else is an INCOMPLETE attempt, not a verdict: no section at all (the reviewer has a hard turn cap and may have been stopped before writing it - step 1 deletes any prior section before every dispatch, so a missing section means an incomplete review on every path, first entry or revision alike), semantic bytes before the heading, a later top-level heading, a section with no canonical verdict line, a missing/wrong/duplicate request challenge when one was issued, forged/missing/conflicting duplicate ownership fields, or duplicated sections/verdicts (conflicting - never guess which was meant). A malformed audit `REVIEW_COMPLETED` row is ignored and does not consume the pending request.

   **On an incomplete attempt:** no verdict exists to record, so the step-1
   request is still unmatched. If the ledger does not yet mark a retry on this
   request, re-dispatch it exactly once - return to step 1, delete the complete
   appended suffix, then rerun the same request command with `--retry-pending`
   immediately before dispatch. The logger accepts this only while the request
   is unmatched, has not already spent its retry, and the original artifact and
   source bytes are restored; it consumes no review iteration and never mints a
   new fingerprint. A valid legacy unmatched request that predates
   appendix/source fields may emit exactly one audit-marked
   `Upgrade: legacy-request` modern binding, but only while its recorded full
   artifact fingerprint still matches; the reviewer MUST then be freshly
   dispatched. A field-light historical `Retry: pending-request` marker is not
   a modern binding and therefore does not block that one modernization, while
   the modern upgrade row itself spends the retry and blocks every later retry.
   A structurally malformed request row has no authority and is ignored, so a
   fresh normal request may reuse its ordinal. If the retried attempt is ALSO
   incomplete, stop retrying: delete its partial suffix too, then record the
   terminal receipt with `--verdict NOT-READY` and the finding "review did not
   complete within its turn budget"; the logger accepts an empty suffix only
   for this retried NOT-READY fallback. Proceed as that NOT-READY verdict
   directs for the effective review class - on `advisory` it is terminal
   (present the gate using the required Review brief below, with
   `--fallback-finding "review did not complete within its turn budget"` so the
   recorded finding uses the normal table shape); on `adversarial` with
   iterations remaining, skip the lead re-invoke (the artifact itself was never
   reviewed, so there is nothing for the builder to act on) and go directly
   back to step 1 with a fresh iteration and a fresh request; on `adversarial`
   with iterations exhausted, proceed to the gate using the same fallback
   Review brief. Recording the receipt is what keeps the engine's gate and
   completion precondition satisfiable: the gate is never presented on a
   silently missing verdict, and never deadlocks on one either.

   **On a complete review**, record the terminal receipt with the same `aidlc-log.ts review` command plus `--verdict <READY|NOT-READY>` (and the same `--unit` / `--single` fields). The logger proves from one coherent snapshot that every dispatched artifact byte and the request-time source identity are unchanged, validates the complete owned suffix, and fingerprints the full post-review artifact for the terminal receipt. A complete reviewer appendix therefore records directly; do not run `--retry-pending` merely because appending `## Review` changed the full file bytes.

   The recorded receipt is TERMINAL whenever no further review pass follows it: do not write to any `produces[]` artifact between recording it and gate approval; for a per-unit `workspace_requires` stage, also do not write the unit's `source-manifest.json` or any claimed source path (a later write is deterministically invalidated at completion and the engine refuses the gate). A verdict may arrive with optional suggestions riding along; do NOT apply them - quote them verbatim in the completion summary for the human to weigh at the gate. A suggestion is gate input, not a defect (step 2: it is not grounds for NOT-READY, so it is not grounds for editing past the terminal receipt either). Riding suggestions also never change the gate itself: keep the §1 approval question's standard option order (Approve first, Request Changes second) - do not present Request Changes as the recommended or first option because a suggestion exists. On harnesses with PreToolUse enforcement the review-freeze hook refuses declared `produces[]`/`optional_produces[]` writes (`REVIEW_FREEZE_BLOCKED`); manifest and claimed-source writes are caught by the completion guard rather than the hook. A recorded gate rejection lifts the freeze for the revision path.
   If a write still invalidates the receipt, the first request after that stale
   terminal evidence is exactly one recovery review at the next ordinal, even
   when an adversarial stage had unused normal iterations. The logger marks it
   `Recovery: stale-receipt`; record either verdict as terminal, then stop
   editing `produces[]` artifacts, `source-manifest.json`, and claimed source
   paths. Any human gate after that recovery verdict uses the required Review
   brief below with `Why now: Re-check after the artifact changed.` If that
   recovery receipt is invalidated again, request no further review. On an
   interactive stage, present the recovery-spent refusal to the human; only
   Request Changes (`GATE_REJECTED`) resets the attempt.

   **Review brief (required at every reviewer-backed human gate).** Before the
   structured approval question, run
   `bun .claude/tools/aidlc-review-brief.ts review --stage "<directive.stage>" --why <first|revision|stale>`;
   on the final `gate: true` re-entry of a per-unit stage, omit `--unit` because
   that one human decision covers every Unit and approval records dispositions
   for every Unit's open findings. Unit-filtered `context` output remains mandatory for
   each reviewer dispatch. Select `first` after the initial review, `revision`
   after a requested revision, and `stale` after artifact/source invalidation or
   a backward jump. Print stdout verbatim. It deterministically renders the
   stage, plain-language outcome, path-specific reason, every review artifact
   and hydrated findings table, and the two decision effects without exposing
   the raw verdict token. On the
   terminal incomplete-attempt fallback, add
   `--fallback-finding "review did not complete within its turn budget"` so the
   same table shape names the recorded finding.

   This tool output is the opening of the reviewer-backed gate presentation;
   the `**Review:**` artifact-path line and structured approval question follow
   it. Do not replace it with a finding count, a generic request to review, or
   an internal verdict token.

   Gate dispositions are receipt-safe audit data, never artifact edits:
   - **Approve** automatically maps every current `New` or `Unresolved` finding
     to `Accepted risk` on the tool-owned `GATE_APPROVED` row.
   - **Request Changes** leaves open findings unresolved. When the human
     explicitly rejects a finding as inapplicable, append
     `--reject-finding "<review-artifact>#R-NN=<exact human reason>"` to the
     ordinary rejected report command for each rejected finding. Never infer a
     rejection from generic revision feedback. The state tool validates the
     artifact, ID, current status, and nonblank reason before recording
     `Rejected: <reason>` on `GATE_REJECTED`.

   **On an `advisory` review, both verdicts are terminal here.** Do not
   re-invoke the lead or the reviewer during normal flow; proceed to section
   13, then present the approval gate using the required Review brief above.
   The human triages; a Request Changes at the gate is how an advisory finding
   becomes a revision. If a `produces[]` artifact, `source-manifest.json`, or
   claimed source path was written after the terminal receipt and voided it,
   the engine permits exactly one recovery request at the next ordinal; record
   its verdict, stop editing those same surfaces, and present the gate using
   the Review brief with `Why now: Re-check after the artifact changed.`

   **On an `adversarial` review**, branch on the verdict:
   - **READY** → the receipt is terminal (above); proceed to §13 learnings ritual, then present the approval gate using the required Review brief above
   - **NOT-READY** and `reviewIterations < reviewer_max_iterations` (default 2):
     - Increment review iteration counter
     - Re-invoke the stage's lead agent ALONE, dispatched per `directive.mode` (inline in your context, or as a subagent on the dispatched modes). On an ensemble stage (pipeline/mob) the room or chain is NOT re-convened - review findings are artifact defects and the lead owns the artifacts; the repair loop is lead-reviewer ping-pong (`stage-protocol-ensemble.md` §5). The builder addresses the findings and updates the artifact.
     - Return to step 1 (re-invoke reviewer)
   - **NOT-READY** and iterations exhausted:
     - Proceed to the approval gate using the required Review brief above, with the unresolved findings table and `Why now: Revision re-checked.` The separate SAY sentence for exhausted rounds remains the only narration before that gate.

The reviewer also re-runs on the Part 0 revision path: when a human rejection
leads to a revision that changes a `produces[]` artifact, re-run this step
before reporting `revised` - step 1's request-first delete rule removes the stale
`## Review` verdict (it predates the revised content) so step 3 cannot mistake
it for coverage of the revision. An `adversarial` review re-enters with
the same lead-alone loop and iteration budget as at first entry; an
`advisory` review re-runs as one fresh advisory pass (its findings ride the
re-presented gate using the required Review brief with `Why now: Revision
re-checked.`).

> **Gate and completion precondition (enforced by the engine).** Every gate
> opening (`gate-start` and `revise`) and completion path (`approve`, `advance`,
> `finalize`, and `complete-workflow`) refuses a stage that declares a reviewer
> until the audit ledger contains a fresh `REVIEW_COMPLETED` from that reviewer.
> Per-unit stages require one receipt for every applicable unit. A workflow
> restart, relevant jump, gate rejection, or later write to a declared stage
> artifact invalidates older receipts (per-unit writes invalidate only that
> unit). After such a write, the engine permits exactly one recovery review
> request at the next ordinal; record its verdict and stop editing `produces[]`
> artifacts, `source-manifest.json`, and claimed source paths. Only a `READY` or
> `NOT-READY` verdict is
> terminal. The precondition is hard on the review having happened and soft on
> its verdict: a NOT-READY verdict after the iteration cap still reaches the
> human gate. Autonomous Construction is not exempt; each swarm
> Unit is reviewed in the worktree hosting its Bolt after convergence and before
> finalization. The swarm referee verifies each configured unit's terminal
> receipt after its `BOLT_STARTED` boundary before merging it, so autonomy
> removes human interruptions rather than verification.
>
> If an autonomous Unit invalidates its one recovery receipt, halt before
> `finalize`: do not put the Unit in `--claimed`, do not merge it, and present a
> human Retry/Abort decision through the halt-and-ask seam. On Retry, return to
> the main workspace, abort and discard the old Bolt, then rerun the current
> `aidlc-swarm.ts prepare` step for that Unit with the original batch/base/repo
> arguments. The fresh worktree and `BOLT_STARTED` boundary reset review
> accounting without claiming convergence. Never synthesize `GATE_REJECTED`.

### What the reviewer does NOT do

- Does not modify the artifact beyond appending `## Review`
- Does not communicate with the builder directly (all mediated by orchestrator)
- Does not access the builder's plan.md or memory.md
- Does not block the workflow — the human always gets final say at the gate
- Does not fire for stages without a `reviewer` field in the directive

---

## Harness reviewer bindings

Use only the subsection that matches the active harness.

### Claude Code

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (via `Task` targeting the reviewer agent).

---

### Kiro CLI

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (via the `subagent` tool targeting the reviewer agent config).

---

### Kiro IDE

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (via the `subagent` tool targeting the reviewer agent config).

---

### Codex CLI

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (spawn the agent role named in `directive.reviewer` — the harness resolves its `.codex/agents/aidlc-<role>-agent.toml`, which loads its own persona via `developer_instructions`; do not inject it in the prompt).

---

### Cursor

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (via the `task` tool targeting the reviewer agent).

---

### opencode

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (via the `task` tool targeting the reviewer agent).

---

### GitHub Copilot

If `directive.reviewer` is present, invoke the reviewer as a sub-agent (delegate to the reviewer custom agent - the `.github/agents/` roster is exposed as callable agents).

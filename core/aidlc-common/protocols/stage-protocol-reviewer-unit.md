# Reviewer Unit Protocol Module

Load this module when the engine lists `reviewer-unit` in `directive.protocol_modules`: a review of one Unit (`directive.unit` is present) and every `invoke-swarm`. It adds to the reviewer module's §12a, at the step each part names.

**Step 1, the request.** Per-unit stages also enforce membership when the
authoritative Unit set resolves; inability to resolve that set does not
refuse the request, while a resolved set still refuses a Unit that is absent.
A named Unit's required outputs remain mandatory.

**Step 1, what else to pass.**

- For a **per-unit** stage (`directive.unit` present) the resolved `directive.consumes` paths include the shared inception contracts that pin cross-unit boundaries (`components.md`, `contract-summary.md`, `unit-of-work.md`).
- For a per-unit `workspace_requires` stage, the unit's
  `source-manifest.json` path and its claimed source paths. Review the
  implementation differentially at those paths rather than sweeping the
  whole workspace; treat any claim that looks unrelated to the unit as a
  finding. Also pass, as the validation tools to run, the exact test
  command recorded in `unit-test-instructions.md` and the recorded
  Construction Verification Command when one is recorded. The reviewer runs
  them and quotes the result in the review. A command it could not run, or a
  claim about test results or the coverage floor with no run behind it, is a
  finding for the person to weigh; it is never by itself a reason to withhold
  READY.

**Reviewer read scope.** The reviewer's scope is the current unit's artifacts plus the passed contract paths. On a per-unit stage the reviewer MUST NOT read other units' `construction/<other-unit>/` content through any tool - not by opening files, and not via grep, glob, or shell patterns that span sibling unit paths (a `construction/*/` glob is a sibling read, not a search) - except to spot-check an integration point the current unit's design explicitly names, and only the owning file, resolved via the shared contracts rather than by browsing or searching the sibling's directory. Cross-unit contract verification runs against the shared inception artifacts passed above, not against a sweep of sibling units' design prose.

**Dispatch record (per-unit reviews; enforcement-capable harnesses only).** This record is required only when the current harness registers reviewer-scope PreToolUse enforcement (Claude Code, Kiro CLI, Codex CLI, opencode, Cursor, and GitHub Copilot today). Immediately before invoking a per-unit reviewer - `directive.unit` present, or one unit of an `invoke-swarm` reviewed under the swarm module's autonomous reviewer boundary - on one of those harnesses, write `<record>/.aidlc-engine/reviewer-dispatch.json` (the engine removes it when the verdict is recorded at step 3; never delete it yourself):

```json
{"reviewer": "<directive.reviewer>", "stage": "<stage slug>", "unit": "<directive.unit, or the swarm unit under review>",
 "exempt": ["<each resolved directive.consumes path>", "<stage file path>", "<Q&A file path>"]}
```

When the current unit's design explicitly names an integration point in a sibling unit's file, resolve that single owning file via the shared contracts and append its path to `exempt` - the record is where the spot-check carve-out is granted. The `stage` field appears verbatim in any `REVIEWER_SCOPE_BLOCKED` audit row; use the current stage slug. The reviewer-scope PreToolUse hook reads this record to enforce the read-scope bound deterministically while the review is in flight; on a NOT-READY re-invoke (step 3 back to step 1), write a fresh record. Single-stage and other no-unit reviews write no record; under a swarm the record is per unit - written before that unit's reviewer and deleted at its step 3 before the next unit's review begins. The record always lives in the main workspace's intent record - the path the conductor's reviewer-scope hook resolves - never in the unit's worktree, even though `--project-dir` targets the worktree for the review request and receipt; the reviewer's tool calls run under the conductor's hooks, and the hook judges `construction/<unit>/` tokens in worktree paths the same way. On a harness without reviewer-scope enforcement (Kiro IDE today), do not write the record; the reviewer read-scope bound remains mandatory prose in the delegated task and reviewer persona. When the step 1 request's JSON returns `dispatchAgent` (Kiro), dispatch that agent in place of `directive.reviewer`: it is the same reviewer with this review's read scope in its own permissions, so the brief still names `directive.reviewer` as the reviewer and both `engine log review` commands keep it. That scope opens no file of another unit, so tell the reviewer to note an integration point the design names as a finding instead of opening it. If Kiro answers that it has no agent by that name, dispatch `directive.reviewer` at once (that is not a retry) and tell the person in one line that this review runs without the reviewer read-scope check.

**Step 2, the reviewer sub-agent also:**

- Verifies cross-unit contract claims against the passed shared inception contracts, not by sweeping or searching sibling units' design directories (no cross-unit grep or glob patterns); opens another unit's file only when the current unit's design explicitly names it as an integration point, and only that file

**Guard Policy at a Unit.** Construction checkpoints read the same value: under `relaxed` and `off` a change to a Unit's code or documents after their review is accepted there too, with one line, and the Unit's approval stands. Under `strict`, a Unit whose reviewed code or documents changed after their review gets that one recovery review, and its checkpoint directs it (`construction_checkpoint.rereview`); each time the person approves that Unit it gets a fresh one, so a Unit edited again later is re-checked again.

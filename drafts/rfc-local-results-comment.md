## Local verification results (implementation branch)

Measurements from the working implementation on a local machine (macOS, Bun, dist built from the branch), posted here so the RFC's claims are inspectable before the PR.

### 1. Engine-level dispatch count (deterministic)

A scripted walk of the full `mvp` ideation+inception plan (12 stages, greenfield) through the real `orchestrate next`, in both granularities, counting `run-stage` directives that carry a reviewer block:

```
--- granularity: stage ---                      --- granularity: phase ---
intent-capture         DISPATCH product-lead    intent-capture         no review step
feasibility            no review step           feasibility            no review step
scope-definition       no review step           scope-definition       no review step
rough-mockups          DISPATCH product-lead    rough-mockups          DISPATCH product-lead   covers: intent-capture
practices-discovery    no review step           practices-discovery    no review step
requirements-analysis  DISPATCH product-lead    requirements-analysis  no review step
user-stories           DISPATCH product-lead    user-stories           no review step
refined-mockups        DISPATCH product-lead    refined-mockups        DISPATCH product-lead   covers: requirements-analysis, user-stories
domain-design          DISPATCH arch-reviewer   domain-design          no review step
units-generation       DISPATCH arch-reviewer   units-generation       no review step
contract-design        DISPATCH arch-reviewer   contract-design        DISPATCH arch-reviewer  covers: domain-design, units-generation
delivery-planning      no review step           delivery-planning      no review step

reviewer dispatches: 8                          reviewer dispatches: 3
```

Receipts stay 8 in both modes (one per reviewed stage), so freshness/freeze/recovery semantics are identical.

### 2. Real-model reviewer micro-benchmark

Controlled benchmark of the Inception product-lead group (the 3-stage case above), dispatching the real reviewer persona (`aidlc-product-lead-agent.md`, `model: sonnet`, `effort: medium`, upstream documents supplied as context exactly as today's per-stage reviews read them) against three sample artifacts (requirements / stories / mockups, ~60 lines total) seeded with 8 known defects — vague and untestable requirements, an FR↔FR contradiction, an orphan story, coverage gaps, and two mockup↔requirement contradictions.

| | stage granularity (3 sequential dispatches) | phase granularity (1 grouped dispatch) | delta |
|---|---|---|---|
| wall clock | 91.3 s (31.9 + 26.1 + 33.3) | **57.9 s** | **−36.6%** |
| tokens | 139.4K (45.9 + 46.0 + 47.4) | **51.4K** | **−63.1%** |
| seeded defects found | 8 / 8 | **8 / 8** | — |

The token gap is structural: per-stage reviews reload the persona and the upstream documents on every dispatch; the grouped pass loads them once. Real stage artifacts are much larger than this sample, which grows the duplicated-context share — so these numbers should be conservative.

Detection quality held up; the grouped pass stated cross-artifact findings more precisely. Example (verbatim from the grouped run's mockups review):

> **High** — Screen 2, top bar "Remove Board": The action is immediate with an Undo toast. This conflicts with requirements.md FR-7 and stories.md US-8, which require typing the board name to confirm deletion by the owner only. … It invites exactly the accidental deletion US-8 exists to prevent.

Caveats: single run per mode (seconds-scale variance; token counts are stable), product-lead group only, small artifacts, and this measures the review pass alone — not end-to-end workflow time, which is what the measurement file below is for on real runs.

### 3. Measurement file output

`audit/review-metrics.jsonl` rows from a real engine run of the flow (request + verdict per stage, stamped with the effective granularity):

```json
{"at":"…","granularity":"phase","event":"request","stage":"refined-mockups","reviewer":"aidlc-product-lead-agent","iteration":1}
{"at":"…","granularity":"phase","event":"verdict","stage":"refined-mockups","reviewer":"aidlc-product-lead-agent","iteration":1,"verdict":"READY","findings_new":0,"findings_resolved":0,"findings_total":0}
```

### 4. Regression

With the implementation applied and `review_granularity` left at its default: all 49 review/reviewer/gate-related unit test files (933 cases) pass, the smoke tier (1,765 assertions) passes, and `bun scripts/package.ts --check` (byte-identical double build), the full typecheck, and lint pass. The phase-mode seams are pinned by two new test files (resolver/grouping units + a real-CLI flow test: deferred directive shape, deferred gate passes without a receipt, anchor gate refuses until every covered receipt exists then opens, metrics rows in both modes).

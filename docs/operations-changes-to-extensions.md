# Design Rationale

This document explains why the operations rules are designed the way they are. If you find yourself asking "why does it work like that?" — the answer is probably here.

---

## Why are rules split into many files?

AI models have finite context windows. Loading all rules into a single session would consume the context budget and degrade output quality. By splitting rules into separate files per concern (metrics, logging, tracing, etc.) and separate directories per domain, the AI only loads what it needs for the current stage.

This also means you can adopt selectively — if your workload doesn't use LLM inference, the LLM observability rules are never loaded.

---

## Why are there two layers (extension baseline + domain rules)?

Extension baselines are lightweight — they define the domain's scope and goals, and persist across all phases as cross-cutting constraints. Domain rules are heavyweight — detailed implementation rules that would overwhelm the context window if loaded from the start.

The baseline tells the AI "observability matters, here are the principles." The domain rules tell it "here's exactly how to implement structured logging." Loading the heavyweight rules only when needed keeps the context window available for actual work.

---

## Why does Operations re-assess rule applicability independently?

This implements a "trust but verify" principle. Construction might have:
- Missed rules that apply
- Applied rules that don't apply
- Made assumptions during implementation that changed what's relevant

By independently re-evaluating applicability, Operations catches these discrepancies. It's the same reason code review exists — the person who wrote it isn't always the best judge of whether it's correct.

---

## Why A/B/C/D applicability options?

Different organisations are at different maturity levels:

- **A** (AWS best-practice) — adopt AWS Well-Architected defaults out of the box
- **B** (AWS + custom) — layer organisation-specific standards on top of AWS defaults
- **C** (custom only) — replace AWS defaults with your own standards entirely
- **D** (skip) — this domain doesn't apply to this project

This avoids a one-size-fits-all approach. A startup might choose A everywhere. An enterprise with existing operational standards might choose B or C.

---

## Why does the rework loop exist?

Without rework, Operations would just produce a report of gaps — leaving you to fix them manually. The rework loop automates the fix cycle: find gaps, classify them, get approval, re-execute only what's needed, re-validate.

This keeps the entire build-validate-fix cycle within the AI-DLC workflow rather than requiring manual intervention after the workflow completes.

---

## Why are rework gaps classified as design vs implementation?

The fix approach is fundamentally different:

- **Implementation gap** — the design is correct but the code doesn't satisfy a rule. Fix: re-run Code Generation for the affected components.
- **Design gap** — the architecture itself doesn't support a rule. Fix: go back to the relevant design stage and redesign before re-generating code.

Classifying upfront avoids wasted effort — you don't want to regenerate code three times only to discover the architecture can't support the rule.

---

## Why does Code Generation use a rule × resource matrix?

Without an explicit matrix, the AI tends to implement rules it remembers and skip ones it doesn't. By producing a visible checklist of every rule × resource combination, nothing can be silently skipped. Each combination is a checkbox that must be completed.

This also makes it auditable — you can look at the matrix and immediately see what was planned vs what was implemented.

---

## Why can't adaptive depth skip extension rules?

AI-DLC's adaptive depth allows the model to reduce detail level for simpler problems — saving tokens and reducing run time. But the goal of Operations is to produce a workload that is as ready for production as possible. To achieve that, you need confidence that the rules you selected are being applied consistently.

---

## Why is step execution accountability needed?

AI models are probabilistic — they sometimes skip steps, combine steps, or deviate from instructions without explanation. The step-decision-log provides visibility into what actually happened. When output doesn't match expectations, you can trace exactly where the AI deviated rather than guessing.

It also creates accountability pressure — models that know they're being audited tend to follow instructions more reliably.

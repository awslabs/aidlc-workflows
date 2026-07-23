# Reviewing Artifacts (Architecture Lens)

When invoked as a reviewer, your role changes. You are NOT designing — you are evaluating someone else's design with fresh eyes.

## Stance

- You did not produce this work. Judge the output independently.
- Your scope is the artifacts you were passed plus the shared contracts named in the invocation prompt - the current unit and its declared upstream, not the whole project's history. Cross-unit contract verification runs against those shared contracts, not by reading other units' design directories.
- You do not have access to the builder's reasoning (plan.md, memory.md). This is intentional.
- Your job is to find architectural unsoundness, broken cross-references, missing concerns, and designs that won't survive implementation.
- "READY" means a developer could implement from this without guessing. Not perfect — implementable.

## What to Check

### Application/Domain Design
- Component boundaries clear? (what owns what?)
- Dependencies correct and complete? (hidden couplings?)
- Circular dependencies?
- Single responsibility per component? (no god-components)
- Entity relationships correct? (cardinality, direction)

### Functional Design
- All business rules complete? (trigger, logic, violation for each)
- Entities have all attributes needed to implement rules?
- State machines complete? (all states reachable, no dead ends)
- API specs cover error cases, not just happy paths?
- Cross-unit contract boundaries respected? Verify against the shared inception contracts passed with the invocation (`components.md`, `component-methods.md`, `services.md`, `unit-of-work.md`), NOT against sibling units' `construction/<other-unit>/functional-design/` prose and not via grep, glob, or shell patterns that span sibling unit paths. If the current unit's design names a specific integration point in another unit, open the owning file (resolved via the shared contracts, not by browsing or searching the sibling unit's directory) to spot-check; do not sweep the sibling unit.

### NFR Design
- Quality targets measurable? (SLOs with numbers)
- Technology choices justified against NFRs?
- Alternatives documented with trade-off reasoning?
- Cost model realistic at scale?
- Security boundaries defined?

### Infrastructure Design
- Every component mapped to infrastructure?
- Networking complete? (ingress, egress, inter-service)
- DR strategy with RTO/RPO?
- Scaling triggers and limits defined?
- Cost estimate present?

### Units Generation
- Unit boundaries clean? (minimal cross-unit deps)
- Dependency graph acyclic?
- Stories mapped completely? (no orphans)
- Each unit independently deployable?

### Validation Tools
If the stage definition lists validation tools, **run them via shell** before writing your review. Include results in findings. Interpret them — a tool failure might be acceptable with documented rationale.

## How to Lodge Review Comments

Append a `## Review` section to the PRIMARY artifact file. Use this exact format:

```markdown
## Review

**Verdict:** READY | NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** [ISO timestamp from Bash]
**Iteration:** [1, 2, etc.]

### Findings

| # | Severity | Location | Finding | Recommendation |
|---|---|---|---|---|
| 1 | Critical | components.yaml | CMP-003 depends on CMP-001 which depends on CMP-003 — circular | Break cycle: extract shared concern into new component |
| 2 | Major | entities.yaml | ENT-005 references entity "Payment" not defined in this file | Add Payment entity or reference upstream |
| 3 | Minor | nfr-spec | No cost estimate for the caching layer | Add estimate or mark as TBD |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| validate-domain-model | FAIL: circular dep CMP-003↔CMP-001 | Confirms finding #1 — must fix |
| validate-entities | PASS | All IDs unique, refs valid |

### Summary

[1-2 sentences: what's the main architectural concern, or why it's ready.]
```

For the `Date` field, obtain a real UTC timestamp by running `date -u +"%Y-%m-%dT%H:%M:%SZ"` in the shell and paste the actual output. Never guess or infer the date.

### Severity Levels

| Severity | Meaning | Blocks READY? |
|---|---|---|
| Critical | Architectural flaw that will cause failure at implementation or runtime | Yes |
| Major | Design gap that will cause significant rework | Yes (if >2 major) |
| Minor | Could be better, not blocking | No |

### Verdict Rules

- **READY** if: zero Critical, ≤2 Major, any number of Minor
- **NOT-READY** if: any Critical, OR >2 Major findings

### On Subsequent Iterations

- Check each previous finding: resolved / partially resolved / unresolved
- Only raise NEW findings if they emerge from fixes
- Don't re-raise Minor findings that weren't addressed
- Update the `## Review` section (replace, don't append a second one)

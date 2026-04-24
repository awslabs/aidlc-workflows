# Estimation Guidance Extension

**Extension ID**: `ESTIMATION`
**Category**: `estimation-guidance`
**Phase Coverage**: INCEPTION (Units Generation)

---

## Core Principle: AI-DLC Time ≠ Developer Time

AI-DLC execution time is dominated by approval gate throughput — how fast the human reviews and approves artifacts. The AI generates artifacts in minutes; the human review cycle determines elapsed time. Conventional developer-time estimates are useful for stakeholder communication but must never be presented as AI-DLC execution forecasts.

---

## Rule ESTIMATION-001: Structured Estimation in Unit Definitions

**Applies to**: INCEPTION → Units Generation (Step 2: Generate Unit Definitions)

When generating **Estimated Effort** sections in `unit-of-work.md`, include:

### Relative Complexity (Mandatory)
- Use **story points** or **T-shirt sizing** (XS, S, M, L, XL)
- Measures problem size independent of who or what builds it
- Use for comparing units against each other and prioritizing review effort
- Base on: number of stories, integration complexity, domain complexity, test surface area

### Conventional Team Estimate (Optional)
- Label clearly: `Reference Only — Conventional Team Estimate`
- Express as developer-weeks and team size (e.g., "2 developers × 3 weeks")
- Purpose: stakeholder communication, budget planning, comparison with non-AI approaches
- **MUST include disclaimer**: "This estimate reflects conventional development effort. AI-DLC execution time depends on approval gate throughput, not generation effort."

---

## Rule ESTIMATION-002: Anti-Confusion Guard

**Applies to**: INCEPTION → Units Generation

- Do NOT present conventional estimates as AI-DLC execution predictions
- Do NOT calculate total project duration by summing conventional estimates
- Do NOT create Gantt charts or timelines based on conventional estimates without labeling them as "Reference Only"
- If a user asks "how long will this take with AI-DLC?", respond that elapsed time depends on review/approval cadence, not generation speed

---

## Extension Compliance Summary Format

When presenting stage completion, include:

```markdown
### Estimation Guidance Extension Compliance
- **ESTIMATION-001**: [COMPLIANT — relative complexity + optional conventional estimate included] or [N/A — not Units Generation]
- **ESTIMATION-002**: [COMPLIANT — no AI-DLC time confusion] or [N/A]
```

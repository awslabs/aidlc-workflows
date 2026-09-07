# Prioritization Frameworks

## Purpose
Structured methods for deciding what to build first. Every framework encodes trade-offs — choose the one that matches your decision context.

## Framework Selection Guide

| Framework | Best For | Complexity | Stakeholder Buy-in |
|-----------|----------|------------|---------------------|
| MoSCoW | Fixed-scope releases, contract work | Low | Easy |
| WSJF | Lean/SAFe teams, flow-based delivery | Medium | Medium |
| RICE | Data-driven product teams | Medium | High |
| Kano Model | UX-focused products, feature differentiation | High | High |

## MoSCoW Method

### Categories
- **Must Have** — Non-negotiable for this release. System is unusable without it.
- **Should Have** — Important but not critical. Painful to omit but workarounds exist.
- **Could Have** — Desirable. Include if time/budget allows.
- **Won't Have (this time)** — Explicitly out of scope. Prevents scope creep.

### Rules of Thumb
- Must Haves should not exceed 60% of planned capacity
- If everything is a Must Have, you have not prioritized — push back
- "Won't Have" is the most valuable category: it creates clarity

## WSJF (Weighted Shortest Job First)

### Formula
```
WSJF = Cost of Delay / Job Duration

Cost of Delay = User-Business Value + Time Criticality + Risk Reduction
```

### Scoring
Rate each factor 1-10 relative to other items in the backlog (Fibonacci scale: 1, 2, 3, 5, 8, 13 also works). Divide by estimated duration (relative size).

### When WSJF Wins
- When you need to maximize value throughput, not just value
- Small high-value items naturally float to the top
- Forces teams to consider the cost of NOT doing something now

## RICE Scoring

### Formula
```
RICE Score = (Reach x Impact x Confidence) / Effort
```

### Component Definitions
- **Reach**: How many users/transactions affected per quarter (use real numbers)
- **Impact**: Per-user effect (3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal)
- **Confidence**: Data quality (100% = high confidence with data, 80% = medium, 50% = low/gut feel)
- **Effort**: Person-months of work (use whole numbers)

### Example
| Feature | Reach | Impact | Confidence | Effort | RICE |
|---------|-------|--------|------------|--------|------|
| Search autocomplete | 10,000 | 2 | 80% | 2 | 8,000 |
| Admin dashboard | 50 | 3 | 100% | 4 | 37.5 |
| Onboarding wizard | 5,000 | 3 | 50% | 3 | 2,500 |

### Key Insight
Confidence is the honesty check. Low-confidence, high-impact ideas should be validated (spike, prototype, user test) before committing full build effort.

## Kano Model

### Category Definitions
- **Basic (Must-Be)**: Expected features. Absence causes dissatisfaction; presence does not delight. (e.g., login works, pages load)
- **Performance (One-Dimensional)**: More is better. Linear relationship between investment and satisfaction. (e.g., speed, storage)
- **Excitement (Attractive)**: Unexpected features that delight. Absence does not disappoint. (e.g., smart suggestions, delightful animations)
- **Indifferent**: Users do not care either way. Stop investing here.
- **Reverse**: Features some users actively dislike. (e.g., forced tutorials, auto-play)

### Classification Method
Ask two questions per feature:
1. "How would you feel if this feature were present?" (functional)
2. "How would you feel if this feature were absent?" (dysfunctional)

Map answers (Like, Expect, Neutral, Tolerate, Dislike) to the Kano evaluation table.

## Handling Ties and Disputes

### When Scores Are Equal
1. Prefer the item with higher confidence — less risk
2. Prefer the item that unblocks other work — multiplier effect
3. Prefer the item with shorter time-to-value — faster feedback loop

### When Stakeholders Disagree
- Make the framework transparent — show the math, not just the result
- Separate "I want this" from "users need this" with data (analytics, support tickets, user research)
- Use time-boxing: "We will revisit in 2 sprints with usage data"
- Escalation path: Product owner makes the final call, documents rationale

## Decision Matrix Template

| Item | Business Value (1-5) | User Impact (1-5) | Effort (1-5, inverted) | Risk (1-5) | Weighted Score |
|------|---------------------|-------------------|----------------------|------------|----------------|
| Feature A | | | | | |
| Feature B | | | | | |

Assign weights to each column based on current strategic priorities (e.g., Business Value x2 if revenue-focused quarter).

# Requirements Elicitation Techniques

## Purpose
Systematic methods for discovering, capturing, and validating what stakeholders truly need — not just what they initially say they want.

## Technique Selection Guide

| Technique | Best For | Effort | Fidelity |
|-----------|----------|--------|----------|
| Stakeholder Interviews | Deep understanding of individual needs | Medium | High |
| Workshops | Consensus building, conflict resolution | High | High |
| Observation | Understanding actual vs stated workflows | Medium | Very High |
| Document Analysis | Existing system understanding, compliance | Low | Medium |
| Prototyping | Validating assumptions, UI-heavy features | High | Very High |

## Stakeholder Interviews

### Preparation
- Research the stakeholder's role, responsibilities, and known pain points
- Prepare 8-12 open-ended questions; plan for 45-60 minutes
- Share agenda in advance so they can prepare examples

### Interview Question Templates
- "Walk me through a typical day when you [process]. What frustrates you most?"
- "If you could change one thing about the current system, what would it be and why?"
- "When [process] goes wrong, what happens? Who gets impacted?"
- "How do you measure success in [area]? What metrics matter?"
- "Show me how you currently do [task] — what workarounds have you developed?"
- "Who else should I talk to about this?"

### Common Pitfalls
- **Leading questions**: "Don't you think X would be better?" forces agreement
- **Assumption bias**: Projecting your solution onto their problem
- **HiPPO effect**: Letting the Highest-Paid Person's Opinion dominate
- **Survivorship bias**: Only talking to current users, ignoring churned users
- **Premature solutioning**: Jumping to "we could build X" before understanding the problem

## Workshops

### When to Use
- Multiple stakeholders with conflicting priorities
- Cross-functional alignment needed (e.g., sales vs engineering vs support)
- Time-boxed discovery needed (compressed timeline)

### Workshop Format
1. **Context setting** (10 min) — Problem statement, goals, ground rules
2. **Individual ideation** (10 min) — Silent sticky-note brainstorming prevents groupthink
3. **Share and cluster** (15 min) — Group similar ideas, identify themes
4. **Dot voting** (5 min) — Each participant gets 3 votes to prioritize
5. **Deep dive** (30 min) — Discuss top-voted items, capture acceptance criteria
6. **Wrap-up** (5 min) — Summarize decisions, assign follow-ups

## Observation (Contextual Inquiry)

### Method
- Watch users perform real tasks in their actual environment
- Ask "why" when you see unexpected behavior — workarounds reveal unmet needs
- Note environmental factors: interruptions, tool switching, manual data entry

### Key Insight
Users often cannot articulate their workflow because it is habitual. Observation reveals the gap between "what they say they do" and "what they actually do."

## Document Analysis

### Sources to Review
- Existing system documentation, help desk tickets, bug reports
- Regulatory requirements, compliance standards, audit findings
- Competitor product documentation and reviews
- Current process flowcharts, SOPs, training materials

## Prototyping for Requirements

### Progression
1. **Paper sketches** — Validate concepts in minutes, discard freely
2. **Clickable wireframes** — Test navigation and flow logic
3. **Functional prototypes** — Validate complex interactions, data-dependent UIs

### Rule of Thumb
Prototype the riskiest assumption first. If users struggle with the core concept in a paper sketch, building a functional prototype wastes effort.

## Validation Checklist
- [ ] Each requirement traces to at least one stakeholder need
- [ ] Requirements are testable (clear pass/fail criteria exist)
- [ ] No orphan requirements (requirements with no user or business justification)
- [ ] Conflicts between stakeholders are explicitly resolved and documented
- [ ] Non-functional requirements (performance, security, scale) are captured alongside functional ones

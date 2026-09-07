# Product Guide

## User Story Format

Standard format: **As a [persona], I want [action], so that [benefit].**

### INVEST Criteria Checklist
Every story must pass all six criteria:
- **I - Independent**: Can be developed and delivered without depending on another story
- **N - Negotiable**: Details can be discussed; it is not a rigid contract
- **V - Valuable**: Delivers identifiable value to a user or stakeholder
- **E - Estimable**: Team can estimate effort (if not, the story needs decomposition or spike)
- **S - Small**: Completable within a single iteration (1-5 days of implementation work)
- **T - Testable**: Has concrete acceptance criteria that can be verified

### Story Decomposition Patterns
When a story is too large (epic), split using these strategies:
1. **By workflow step**: Login -> Browse -> Select -> Purchase -> Confirm
2. **By data variation**: Handle text input / Handle file upload / Handle image upload
3. **By business rule**: Basic validation / Advanced validation / Cross-field validation
4. **By interface**: Web UI / API endpoint / Admin panel
5. **By operation**: Create / Read / Update / Delete (but prefer vertical slices)

## Persona Development

For each persona, define:
```
Name: [descriptive name, e.g., "Alex the Admin"]
Role: [their role in the system]
Goals: [what they want to accomplish, 2-3 items]
Pain Points: [current frustrations, 2-3 items]
Tech Comfort: [low / medium / high]
Frequency: [how often they use the system]
```

Every story must reference a defined persona. If a story does not fit any persona, either the story is wrong or a persona is missing.

## Prioritization Frameworks

### MoSCoW (preferred for MVP definition)
- **Must Have**: System is unusable without this. If removed, the product fails its core purpose.
- **Should Have**: Important but not critical. Workarounds exist. Include if time permits.
- **Could Have**: Desirable. Enhances experience but not expected in first release.
- **Won't Have (this time)**: Explicitly out of scope. Documented for future consideration.

### RICE Scoring (preferred for backlog ranking)
Score = (Reach x Impact x Confidence) / Effort
- **Reach**: How many users/sessions affected per time period (use real numbers)
- **Impact**: How much it moves the needle (3=massive, 2=high, 1=medium, 0.5=low, 0.25=minimal)
- **Confidence**: How sure are you about estimates (100%/80%/50%)
- **Effort**: Person-days of work (all roles combined)

## MVP Definition Criteria

The MVP must:
1. Solve the core problem for the primary persona
2. Include all Must Have stories and no Could/Won't stories
3. Be deployable and usable without manual workarounds
4. Include basic error handling (not just happy paths)
5. Meet minimum NFRs for security and data integrity
6. Be demonstrable to stakeholders in under 10 minutes

## Workflow Planning Structure

Organize stories into iterations:
```
Iteration 0 (Foundation): Infrastructure, auth, core data model
Iteration 1 (Core Value): Primary user workflow end-to-end
Iteration 2 (Completeness): Secondary workflows, edge cases, admin features
Iteration 3 (Polish): Performance optimization, UX refinement, advanced features
```

For each iteration, define:
- Entry criteria (what must be complete before starting)
- Stories included (with dependency order)
- Exit criteria (what "done" looks like for this iteration)
- Demo scenario (how to showcase the increment)

## Story Mapping Layout

Arrange stories in a 2D map:
- **Horizontal axis**: User journey steps (left to right, in sequence)
- **Vertical axis**: Priority (top = must-have, bottom = nice-to-have)
- **Horizontal line**: MVP boundary (everything above the line is MVP)

This visualization makes it easy to spot:
- Missing journey steps (vertical gaps)
- Over-invested areas (too many stories in one column)
- Dependency chains (stories that must be above others)

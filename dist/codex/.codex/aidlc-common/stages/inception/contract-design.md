---
slug: contract-design
phase: inception
execution: CONDITIONAL
condition: Execute when the system has any formal contract to pin down — an inter-unit boundary (more than one unit that must integrate) OR a unit that exposes a public/external API consumed outside the system. Skip only for a single self-contained unit with no inter-unit boundaries and no externally consumed API.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: contract-summary
reviewer_max_iterations: 2
review_class: advisory
produces:
  - contract-summary
consumes:
  - artifact: unit-of-work
    required: true
  - artifact: unit-of-work-dependency
    required: true
  - artifact: components
    required: false
  - artifact: requirements
    required: false
requires_stage:
  - units-generation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
inputs: <record>/inception/units-generation/unit-of-work.md, <record>/inception/units-generation/unit-of-work-dependency.md, <record>/inception/domain-design/components.md (if produced), <record>/inception/requirements-analysis/requirements.md
outputs: contract-summary.md (under this stage's record dir, engine-resolved) — a human-readable overview of every contract (inter-unit boundaries and public/external APIs), each with a fenced spec block (OpenAPI / AsyncAPI / shared schema) inline
---

# Contract Design

Define the formal contracts the system must honour so teams can build in parallel with confidence. A contract is a formal agreement across a boundary: what data crosses it, in what shape, via what protocol, and what happens when things go wrong. Two kinds of boundary qualify:

- **Inter-unit boundaries** — the agreement between a provider unit and a consumer unit inside the system. Treat each like a B2B agreement between two teams in two companies: it must be right from the start, because a wrong contract turns integration into a rework disaster.
- **Public/external API boundaries** — the agreement between a unit and a consumer *outside* the system (another team, a partner, the public internet). A single-unit system with no inter-unit edges still needs this contract pinned before Code Generation when it exposes such an API; there is no other stage that owns the external API specification.

This stage runs once per workflow (not per unit) — it maps the whole set of boundaries at once, using the dependency DAG from Units Generation to know which units talk to each other, plus each unit's externally consumed surface for public API contracts.

## Steps

### Step 1: Load Prior Context

- Read `<record>/inception/units-generation/unit-of-work.md` (unit definitions and kinds)
- Read `<record>/inception/units-generation/unit-of-work-dependency.md` (the dependency DAG — every edge is a candidate contract)
- Read `<record>/inception/domain-design/components.md` (if produced) — the entity shapes inform payload design
- Read `<record>/inception/requirements-analysis/requirements.md` (if produced) — NFRs shape SLAs and error budgets

### Step 2: Create Contract Plan with Questions

Create `<record>/inception/contract-design/contract-design-questions.md` with context-appropriate questions using [Answer]: tag format:
- Public/external API surface (which units expose an API consumed outside the system, and its shape) — the single-unit trigger for this stage
- Integration mechanism per boundary (synchronous REST/HTTP, async event/message, shared schema, gRPC, etc.)
- Contract ownership (which unit owns each spec)
- Versioning and breaking-change policy
- Error, timeout, and retry behaviour at each boundary

### Step 3: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).
- MANDATORY ambiguity analysis: scan for vague language, contradictions, missing details
- Create follow-up questions if ANY ambiguity found
- Resolve all ambiguities before proceeding

### Step 4: Generate the Contract Summary

Create `<record>/inception/contract-design/contract-summary.md`. This single artifact carries both the human-readable overview and the contract specs themselves.

**Contracts table** — one row per boundary (inter-unit and public/external):

`| # | Provider Unit | Consumer | Mechanism | Owner |`

For an external boundary, name the outside consumer (e.g. `External: partner API`, `External: public web`) in the Consumer column.

**Per-contract spec** — for each boundary, a fenced code block carrying the actual spec in the appropriate format:

- a fenced ```yaml OpenAPI block for synchronous REST/HTTP contracts
- a fenced ```yaml AsyncAPI block for event-driven/message-based contracts
- a fenced ```yaml shared-schema block for shared database or shared model contracts
- any other contract format appropriate to the integration mechanism

**Contract ownership rules** — a short list stating who owns each spec, how breaking changes are agreed, and how additive changes stay safe (consumers ignore unknown fields).

**Open questions** — a table of unresolved contract points and which unit each blocks:
`| Contract | Question | Blocks |`

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage contract-design --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :handshake:
- Summary of contracts defined (count, mechanisms, ownership)
- Review path: `<record>/inception/contract-design/`
- Structured approval question with options: Approve (continue to next stage) / Request Changes

## Sensors

This stage's output is a markdown artefact under `<record>/inception/contract-design/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `unit-of-work`, `unit-of-work-dependency`, `components`, `requirements`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.

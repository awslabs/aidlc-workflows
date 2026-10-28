# Contract Design - Detailed Steps

## Purpose
**Define the contracts between units of work so teams can build in parallel with confidence.**

A contract is the formal agreement between a provider unit and a consumer unit — what data crosses the boundary, in what shape, via what protocol, and what happens when things go wrong.

Think of two teams in two different companies collaborating on an integration. The contract is the B2B agreement. Get it wrong early and integration becomes a rework disaster later. **This stage must be 90% right from the start.**

Contract Design focuses on:

- Identifying every cross-unit boundary that needs a formal contract
- Choosing the right mechanism per boundary (REST, async messaging, shared schema, gRPC, etc.)
- Writing a spec file per boundary that both the provider and the consumer code against
- Recording contract ownership, versioning rules, and change rules
- Linking contracts back to the units and components they bind

**What this stage does NOT do**:

- Does not design intra-unit interactions (that's Application Design's component map)
- Does not implement the contracts (that's Construction)
- Does not choose infrastructure or deployment (that's NFR Design and Infrastructure Design)
- Does not re-decompose units (that's Units Generation)

## Prerequisites

- Workspace Detection must be complete
- Requirements Analysis must be complete (NFRs may inform SLAs and error budgets)
- Application Design must be complete (needs `components.yaml` for entity shapes and component references)
- Units Generation must be complete (needs `unit-of-work.md` and `unit-of-work-dependency.md` — the dependency matrix lists the boundaries that need contracts)
- Execution plan must indicate Contract Design should execute

## Intelligent Assessment Guidelines

### Execute if ANY of these apply

- The project has more than one unit of work AND those units interact
- Any cross-unit boundary uses a protocol that benefits from a formal spec (HTTP, async events, gRPC, shared schema)
- Multiple teams will build units in parallel (contracts prevent integration rework)
- The system integrates with external callers who need a stable spec

### Skip if ANY of these apply

- Single-unit project — no inter-unit boundaries exist
- All interactions are intra-unit (handled by the component map in Application Design)
- User explicitly declines (prefers to define contracts ad-hoc during Construction)

### Default Decision Rule

**When in doubt, include Contract Design.** The cost of writing a contract spec now is small; the cost of integration rework because two units made different assumptions is large.

---

# PART 1: PLANNING

## Step 1: Validate Contract Design Need (MANDATORY)

Perform the assessment above against the project's actual decomposition. Document the decision in `aidlc-docs/inception/plans/contract-design-assessment.md`:

```markdown
# Contract Design Assessment

## Decomposition Analysis
- **Number of Units**: [count from unit-of-work.md]
- **Number of Inter-Unit Dependencies**: [count from unit-of-work-dependency.md]
- **Interaction Mechanisms Present**: [REST / async events / shared schema / gRPC / mixed]
- **Parallel Teams Expected**: [count or `single team`]

## Assessment Criteria Met
- [ ] Multiple units with real interactions: [yes/no]
- [ ] At least one boundary benefits from a formal spec: [yes/no]
- [ ] Parallel development or external integration planned: [yes/no]

## Decision
**Execute Contract Design**: [Yes / No]
**Reasoning**: [detailed justification]
```

If the decision is **No**, mark the stage skipped in `aidlc-state.md` with the reasoning and proceed to Construction.

## Step 2: Load Prior Context

- Read `aidlc-docs/inception/application-design/components.yaml` (entity shapes inform payload design)
- Read `aidlc-docs/inception/application-design/components.md` (human-readable component view)
- Read `aidlc-docs/inception/application-design/unit-of-work.md` (which components live in which unit)
- Read `aidlc-docs/inception/application-design/unit-of-work-dependency.md` (every edge in this file is a candidate contract)
- Read `aidlc-docs/inception/requirements/requirements.md` (NFRs may shape SLAs, retry rules, idempotency, error budgets)
- Read `aidlc-docs/inception/user-stories/stories.md` (if produced — user-visible flows map to end-to-end contracts)

## Step 3: Create Contract Design Plan

- Generate a plan with checkboxes `[]` for every contract that will be designed
- Each step and sub-step should have a checkbox `[]`
- The plan drives Part 2 generation; be concrete about what each step produces

## Step 4: Include Mandatory Contract Artifacts in Plan

**ALWAYS** include these mandatory artifacts in the design plan:

- [ ] Create `aidlc-docs/inception/contract-design/contracts/` directory
- [ ] For each cross-unit dependency in `unit-of-work-dependency.md`, generate one spec file in the appropriate format:
  - OpenAPI spec (synchronous REST / HTTP contracts) — `*.openapi.yaml`
  - AsyncAPI spec (event-driven / message-based contracts) — `*.asyncapi.yaml`
  - Shared schema definition (shared database or shared model contracts) — `*.schema.json` or similar
  - gRPC `.proto` file (RPC contracts)
  - Any other format appropriate to the mechanism chosen for that boundary
- [ ] Generate `aidlc-docs/inception/contract-design/contract-summary.md` — the human-readable overview table
- [ ] Update `aidlc-docs/inception/application-design/components.yaml` to add contract references on component interactions that cross unit boundaries
- [ ] Update `aidlc-docs/inception/application-design/unit-of-work-dependency.md` to add a Contract ID and spec file reference per inter-unit dependency row
- [ ] Validate every inter-unit dependency has a contract
- [ ] Validate every contract names a single provider unit, a single consumer unit, and a single owner

## Step 5: Generate Context-Appropriate Questions

**DIRECTIVE**: For each candidate boundary from `unit-of-work-dependency.md`, generate the questions needed to pin the contract. Use the categories below as guidance.

**See `common/question-format-guide.md` for question formatting rules**.

- EMBED questions using `[Answer]:` tag format
- Focus on ANY ambiguity in mechanism, payload shape, error handling, versioning, or ownership
- Generate questions wherever user input would improve contract decisions
- **When in doubt, ask the question** — overconfidence here is especially expensive

**Question categories to evaluate per boundary** (consider ALL categories):

- **Mechanism** — synchronous (REST/HTTP, gRPC) vs. asynchronous (events, message queue) vs. shared schema (shared database, shared model). Ask the user which fits this boundary and why.
- **Payload Shape** — which entities and attributes cross the boundary? Reference `components.yaml` entities; new fields invented at the boundary need explicit justification.
- **Operations** — what calls does the consumer make against the provider (list, create, update, delete, subscribe, publish)?
- **Idempotency** — which operations are idempotent? Which require idempotency keys? Which may be retried safely?
- **Error Model** — how are failures communicated (status codes, error payload shape, error codes)? What are the retry rules on each error class?
- **SLA & Error Budget** — what latency and availability does the provider commit to? What is the acceptable failure rate?
- **Versioning** — how are breaking changes signalled (version in URL, media type, header)? How long are old versions supported?
- **Authentication & Authorisation** — who is allowed to call? How is identity passed? Note: do NOT design the auth mechanism here; just record what the contract requires.
- **Ownership** — which team owns the spec (usually the provider)? Who approves breaking changes?

## Step 6: Store Contract Design Plan

- Save as `aidlc-docs/inception/plans/contract-design-plan.md`
- Include all `[Answer]:` tags for user input
- Ensure the plan covers every inter-unit boundary from the dependency matrix

## Step 7: Request User Input

- Ask the user to fill `[Answer]:` tags directly in the plan document
- Emphasize that contract decisions made here are expensive to reverse — this stage must be 90% right from the start
- Provide clear instructions on completing the `[Answer]:` tags

## Step 8: Collect Answers

- Wait for the user to provide answers to all questions using `[Answer]:` tags in the document
- Do not proceed until ALL `[Answer]:` tags are completed
- Review the document to ensure no `[Answer]:` tags are left blank

## Step 9: ANALYZE ANSWERS (MANDATORY)

Before proceeding, carefully review all user answers for:

- **Vague or ambiguous responses**: "mix of", "somewhere between", "not sure", "depends"
- **Mechanism contradictions**: e.g. "async" but with a synchronous SLA
- **Payload drift**: a field invented at the boundary that is not in `components.yaml` without justification
- **Missing error model**: an operation with no documented failure modes
- **Ownership gaps**: a contract with no named owner, or shared ownership between consumer and provider
- **Versioning silence**: no rule for breaking changes

## Step 10: MANDATORY Follow-up Questions

If the analysis in step 9 reveals ANY ambiguity, you MUST:

- Add specific follow-up questions to the plan document using `[Answer]:` tags
- DO NOT proceed to approval until all ambiguities are resolved
- Examples of required follow-ups:
  - "You chose async events for this boundary but committed to a 100ms SLA. Async events are typically not sub-second. Which do you want to adjust — the mechanism or the SLA?"
  - "Operation X returns a `transactionId` that is not an attribute on any entity in components.yaml. Is this a derived field computed at the boundary, or should it be added as an entity attribute?"
  - "Contract C-003 lists both Team Alpha and Team Beta as owners. Which single team owns the spec? Shared ownership makes breaking-change decisions deadlock."

## Step 11: Request Approval

- Ask: "**Contract design plan complete. Review the plan in `aidlc-docs/inception/plans/contract-design-plan.md`. Ready to proceed to generation?**"
- DO NOT PROCEED until user confirms

## Step 12: Log Approval

- Log the approval prompt and response in `aidlc-docs/audit.md` with timestamp
- Use ISO 8601 timestamp format
- Include complete approval prompt text

---

# PART 2: GENERATION

## Step 13: Load Contract Design Plan

- [ ] Read the complete plan from `aidlc-docs/inception/plans/contract-design-plan.md`
- [ ] Identify the next uncompleted step (first `[ ]` checkbox)
- [ ] Load the context for that step

## Step 14: Generate Contract Spec Files

For every cross-unit dependency, produce one spec file in `aidlc-docs/inception/contract-design/contracts/`:

- Choose the format matching the chosen mechanism (OpenAPI, AsyncAPI, shared schema, gRPC `.proto`, etc.)
- Name the file descriptively: `<provider-unit>-<consumer-unit>-<capability>.<format>` (e.g., `orders-payments-checkout.openapi.yaml`)
- Include in each spec:
  - Operations the consumer makes against the provider
  - Payload shapes (reference entity attributes from `components.yaml`)
  - Error model (status codes, error payload shape, error codes)
  - Idempotency rules per operation
  - SLA metadata (latency, availability targets)
  - Versioning header or path if applicable
  - Authentication expectations (e.g., bearer token, mTLS — spec only, not implementation)
- Each file should be valid under its format's schema (OpenAPI 3.x, AsyncAPI 2.x or 3.x, JSON Schema draft, Protocol Buffers 3, etc.)

## Step 15: Generate `contract-summary.md`

Create `aidlc-docs/inception/contract-design/contract-summary.md`:

```markdown
# Contract Summary

> Human-readable overview of all contracts. Spec files are in `contracts/`.

## Contracts

| Contract ID | Dependency ID | Provider Unit | Provider Component | Consumer Unit | Consumer Component | Mechanism | Spec File | Owner |
|---|---|---|---|---|---|---|---|---|
| C-001 | UDEP-001 | UNIT-001 | CMP-001 | UNIT-002 | CMP-002 | REST (OpenAPI) | `contracts/orders-payments-checkout.openapi.yaml` | Team Orders |

## Contract Ownership Rules

- Provider owns the spec — consumers code against it
- Breaking changes require both teams to agree, with a documented migration window
- Additive changes are safe — consumers ignore unknown fields
- Any variation from these defaults is called out per contract in the Notes column

## Versioning Rules

- Record the versioning strategy used per contract (URL versioning, media type, header)
- Record the deprecation window applied to old versions

## Open Questions

| Contract | Question | Blocks |
|---|---|---|
| C-n | [what is unresolved] | [which unit cannot proceed until resolved] |
```

Fill in a row per inter-unit dependency. If an open question still exists after the plan's follow-up round, record it here with the unit it blocks — this surfaces integration risk explicitly.

## Step 16: Update `components.yaml`

For every component interaction in `aidlc-docs/inception/application-design/components.yaml` that crosses a unit boundary, add a `Contract` field under that interaction:

```yaml
Dependency:
  - Component:
      Id: CMP-002
      Name: "PaymentsComponent"
      Interaction: "Orders calls Payments to charge the customer at checkout"
      Contract: C-001                     # NEW — references contract-summary.md
```

Interactions that are intra-unit (both components in the same unit) do not need a contract reference.

## Step 17: Update `unit-of-work-dependency.md`

For every row in `aidlc-docs/inception/application-design/unit-of-work-dependency.md`, add two columns if not present and populate them:

- **Contract ID** — the ID from `contract-summary.md`
- **Spec File** — the relative path to the spec in `contracts/`

Every inter-unit dependency row must have both. A row without a contract is a design hole and must be flagged.

## Step 18: Validate Contracts

- [ ] Every dependency in `unit-of-work-dependency.md` has a Contract ID and a Spec File
- [ ] Every spec file is syntactically valid under its format
- [ ] Every spec names exactly one provider unit and one consumer unit
- [ ] Every spec payload field maps to an entity attribute in `components.yaml` OR is justified in a comment at the top of the spec
- [ ] Every contract has exactly one named owner in `contract-summary.md`
- [ ] Every contract has a versioning rule and an error model

## Step 19: Update Progress

- [ ] Mark the completed step as `[x]` in the contract design plan
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] Save all generated artifacts

## Step 20: Continue or Complete

- [ ] If more contracts remain, return to Step 13
- [ ] If all contracts are generated and validated, proceed to the completion message

## Step 21: Log Approval Prompt

- Log the completion approval prompt with timestamp in `aidlc-docs/audit.md`

## Step 22: Present Completion Message

```markdown
# 📜 Contract Design Complete

[AI-generated summary — bullet points covering:
 - Number of contracts generated and the mechanisms used (count by REST / async / schema / etc.)
 - Any boundaries where the mechanism changed from the user's initial choice during planning, with the reasoning
 - Any Open Questions still parked in contract-summary.md, with the units they block
 - Ownership overview — who owns which spec]

> **📋 <u>**REVIEW REQUIRED:**</u>**
> Please examine the contract design artifacts at:
> - `aidlc-docs/inception/contract-design/contracts/` — spec files, one per boundary
> - `aidlc-docs/inception/contract-design/contract-summary.md` — overview table
> - `aidlc-docs/inception/application-design/components.yaml` — now carries Contract refs on cross-unit interactions
> - `aidlc-docs/inception/application-design/unit-of-work-dependency.md` — now carries Contract ID + Spec File per row

> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** — Ask for modifications to any contract (mechanism, payload, error model, ownership)
> ✅ **Approve & Continue** — Approve contracts and proceed to **CONSTRUCTION PHASE**
```

## Step 23: Wait for Explicit Approval

- Do not proceed until the user explicitly approves the contracts
- Approval must be clear and unambiguous
- If the user requests changes, update the spec file, the summary, `components.yaml`, and `unit-of-work-dependency.md` together (keep them in sync — the spec file is the source of truth for payload shapes, the summary is the index) and repeat the approval process

## Step 24: Record Approval Response

- Log the user's approval response with timestamp in `aidlc-docs/audit.md`
- Include the exact user response text
- Mark the approval status clearly

## Step 25: Update Progress

- Mark Contract Design stage complete in `aidlc-docs/aidlc-state.md`
- Update the "Current Status" section
- Prepare for transition to CONSTRUCTION PHASE

---

# CRITICAL RULES

## Design Phase Rules

- **CONTRACTS CROSS UNIT BOUNDARIES ONLY**: Intra-unit interactions live in `components.yaml`, not here
- **ONE PROVIDER, ONE CONSUMER PER CONTRACT**: Multi-consumer contracts are listed as multiple rows in the summary, one per consumer
- **SINGLE OWNER PER CONTRACT**: Provider owns the spec by default. Record the owner explicitly in `contract-summary.md`
- **PAYLOAD FIELDS TRACE TO ENTITIES**: Every field in a spec payload maps to an entity attribute in `components.yaml`, or is explicitly justified in a comment at the top of the spec
- **ERROR MODEL IS NOT OPTIONAL**: Every operation has documented failure modes, status codes, and retry rules
- **VERSIONING RULE IS NOT OPTIONAL**: Every contract records how breaking changes will be signalled and how long old versions are supported
- **90% RIGHT FROM THE START**: Contract rework costs integration rework. Spend the time in planning, not after Construction starts

## Artifact Rules

- **SPEC FILES ARE THE SOURCE OF TRUTH**: `contracts/` holds the authoritative definition
- **SUMMARY IS AN INDEX**: `contract-summary.md` is the human-readable overview; it must list every spec file in `contracts/`
- **KEEP IT CONSISTENT**: Every change to a contract updates the spec file, the summary, `components.yaml` (contract reference on the interaction), and `unit-of-work-dependency.md` (Contract ID + Spec File columns)

## Completion Criteria

- Assessment documented and Execute/Skip decision recorded
- Plan explicitly approved by the user
- One spec file per inter-unit dependency in `contracts/`
- `contract-summary.md` lists every spec with provider, consumer, mechanism, owner
- `components.yaml` cross-unit interactions carry Contract refs
- `unit-of-work-dependency.md` rows carry Contract ID and Spec File
- Every spec validates against its format schema
- All open questions either resolved or explicitly parked with the units they block
- Generated contracts explicitly approved by the user

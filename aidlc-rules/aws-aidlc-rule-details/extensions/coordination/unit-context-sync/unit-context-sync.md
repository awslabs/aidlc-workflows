# Unit Context Sync Rules

## Overview
These rules keep units of work aligned with one another while they are built during the Construction phase. When a system is split into multiple units, each unit is often built in a separate session or by a different person, so the units' contexts diverge and drift away from the assumptions agreed during Inception. Left unaddressed, that drift surfaces all at once at integration time and is expensive to reconcile — to the point where, for small systems, splitting into units can feel slower than not splitting at all.

The rules keep humans and AI working as if they were in the same room after the split: the model surfaces where a human-to-human discussion is needed before a unit-boundary change spreads, and — once humans have decided — propagates that decision across the affected units together with its rationale, at the moment it is made rather than at merge time. Decisions and discussions stay with humans; the model carries detection and propagation.

**Enforcement**: At each applicable stage of the Construction phase, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

### Blocking Coordination Finding Behavior
A **blocking coordination finding** means:
1. The finding MUST be listed in the stage completion message under a "Coordination Findings" section with the UCS rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the UCS rule ID, description, and stage context

If a UCS rule is not applicable to the current project (e.g., the system is a single unit of work), mark it as **N/A** in the compliance summary — this is not a blocking finding.

### Default Enforcement
All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking coordination finding — follow the blocking finding behavior defined above.

### Verification Criteria Format
Verification items in this document are plain bullet points describing compliance checks. They are distinct from the `- [ ]` / `- [x]` progress-tracking checkboxes used in stage plan files. Each item should be evaluated as compliant or non-compliant during review.

### Human Alignment Points (the model surfaces the need, humans align — the model MUST NOT substitute)
This extension follows the AI-DLC principle that decisions belong to humans, not the model. For a change that affects a unit boundary, the model MUST decide only whether the change still has room for disagreement, and then act as below. The model MUST NOT settle a contested cross-unit change on the users' behalf, and MUST NOT treat its own record or propagation as a replacement for a human-to-human discussion.

| Situation | Rule | What the model does |
|---|---|---|
| A unit-boundary change still open to disagreement (it affects another unit's commitments) | UCS-02 | Name the affected units and direct the responsible people to discuss it directly; hold propagation until they have decided |
| A change humans have already discussed and decided, or one with no room for disagreement | UCS-03 | Propagate it across the affected units on the humans' behalf (draft the note, reflect it, sync it) |
| Uncertain whether a discussion is needed | UCS-02 | Default to requiring discussion; never downgrade to "no discussion needed" without explicit human confirmation |

---

## Rule UCS-00: Declare the Cross-Unit Sync Method
**Rule**: At the start of the Construction phase, the model MUST ask the user how unit-boundary records reach the other units and record the answer in `aidlc-docs/coordination/sync-mode.md`. The mode determines the propagation action stated in UCS-03. Supported modes:
- `shared-fs` — all units read and write one shared filesystem; propagation is automatic
- `git` — units share records through a version-control remote
- `manual` — records are handed to the other units' members by hand
- `other` — any team-specific method, described by the user

**Verification**:
- `aidlc-docs/coordination/sync-mode.md` exists and names exactly one mode before any unit records a cross-unit change
- The recorded mode is the one UCS-03 references when stating its propagation action
- The model asked the user for the mode and did not choose it on its own

---

## Rule UCS-01: Record Unit-Boundary Changes and Decisions With Intent
**Rule**: When a contract between units (an API, schema, or other integration specification) changes, or a decision that affects a unit boundary is made during Construction, it MUST be recorded under `aidlc-docs/coordination/` before the stage proceeds. Contracts live in `aidlc-docs/coordination/contracts/`; decisions are indexed in `aidlc-docs/coordination/decisions/ledger.md` with a full record in `aidlc-docs/coordination/decisions/records/`. Each record MUST capture:
- The decision or change, in plain language
- The reason for it
- The options that were considered and rejected, and why
- The confidence/temperature: settled, contested, or provisional

The human makes the decision; the model only records it. This complements `aidlc-docs/audit.md` (which remains the full interaction log) and does not replace it.

**Verification**:
- No unit-boundary contract changes without a corresponding record under `aidlc-docs/coordination/contracts/`
- Every recorded decision states its reason, its rejected alternatives, and its confidence/temperature — not only the conclusion
- The record attributes the decision to a human; the model did not author the decision itself
- Each record references the related story or unit dependency so the change is traceable

---

## Rule UCS-02: Surface Cross-Unit Changes for Human Discussion
**Rule**: When a recorded change affects another unit, the model MUST determine whether the change still has room for disagreement.
- If it does — it affects another unit's commitments and needs agreement — the model MUST name the affected units, direct the responsible people to discuss it directly, and hold propagation until the humans confirm they have discussed and decided it.
- If the humans have already discussed and decided it, or it has no room for disagreement, the model proceeds to UCS-03.

The model MUST NOT downgrade a change to "no discussion needed" on its own; when uncertain it MUST default to requiring discussion. The model's record or propagation MUST NOT stand in for the human discussion.

**Verification**:
- Every cross-unit change is classified as "needs discussion" or "already decided / no room for disagreement"
- Changes that need discussion name the specific affected units and are held from propagation until humans confirm a decision
- No change is classified as "no discussion needed" without explicit human confirmation
- The stage does not proceed while a cross-unit change is awaiting its human discussion

---

## Rule UCS-03: Propagate Decided Changes Across Affected Units
**Rule**: For a change cleared by UCS-02 (already decided, or with no room for disagreement), the model MUST propagate it to the affected units on the humans' behalf, at the time it is decided rather than at integration time. The model MUST:
- Produce a short note for each affected unit describing the change and its reason in that unit's terms
- Reflect the change in the affected units' coordination records and context
- State and carry out the propagation action for the declared sync mode:
  - `shared-fs` — already shared; no action
  - `git` — push the coordination records now to a location every unit reads, not only the unit's own feature branch
  - `manual` — hand the record to the affected units' members now
  - `other` — ensure the affected units can read the record before they pass the relevant stage

The content propagated is what the humans decided, not a choice made by the model. The stage MUST NOT proceed until propagation for the declared mode is confirmed.

**Verification**:
- Every decided cross-unit change has a note targeted at each affected unit
- The change is reflected in the affected units' coordination records
- The propagation action matching the declared sync mode has been carried out (or is automatic for `shared-fs`)
- Propagation happens when the change is decided, not deferred to integration or merge

---

## Rule UCS-04: Reconcile Against Prior Decisions Before Acting
**Rule**: Before a unit acts on an assumption that crosses a unit boundary, the model MUST read the current coordination records (`aidlc-docs/coordination/contracts/` and `aidlc-docs/coordination/decisions/ledger.md`), refreshing them first if the declared sync mode requires it (`git`: pull; `manual`: obtain the latest handed-over records). If a relevant decision already exists, the model MUST follow it and cite its ID rather than re-deciding. If a recorded contract has changed, the consuming unit MUST reconcile with the change before its stage proceeds.

**Verification**:
- The coordination records were read — and refreshed per the sync mode — at the start of a unit's stage
- Decisions already recorded are followed and cited by ID, not re-litigated
- A unit that consumes a changed contract has reconciled with the change before proceeding
- No cross-unit assumption is acted on while an unaddressed change to its contract exists in the records

---

## Enforcement Integration

These rules apply during the Construction phase, where units of work are designed and built, and at integration. At each applicable stage:
- Evaluate all UCS rule verification criteria against the unit-boundary changes and decisions produced
- Include a "Coordination Compliance" section in the stage completion summary listing each rule as compliant, non-compliant, or N/A
- If any rule is non-compliant, this is a blocking coordination finding — follow the blocking finding behavior defined in the Overview
- When the system is built as a single unit of work, mark these rules N/A

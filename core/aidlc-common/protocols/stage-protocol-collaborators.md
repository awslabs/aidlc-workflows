# Collaborators Protocol Module

Load this module when the engine lists `collaborators` in `directive.protocol_modules`: on a stage that dispatches support agents (`directive.support_agents` is not empty and `directive.mode` is not `inline`). It adds to the ensemble module's §5 and §11.

**Who writes what (mirrors a real working session — everyone writes; the owner collates and edits):**

- Each dispatched support agent WRITES its own **contribution file** at `<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages: under the unit's stage dir). Separate files per agent, so parallel dispatch never conflicts. The file's FIRST line is the identity marker verbatim: `**Collaborator:** <agent-slug>`, followed by `## Contribution` (the substantive content, written to be integrable) and `## Positions` (`AGREE:` / `OBJECT:` bullets with one-line rationales; `None` = full agreement).
- The LEAD integrates contributions into the stage's `produces[]` artifacts and owns their final state. Contribution files are part of the stage's permanent record — dissent stays on disk, not in ephemeral return text.
- On `pipeline`, the chain collectively authors the artifacts directly (serialized, so no conflict) and the conductor mints a durable link receipt after every return — see the topology bullet.

- **`mode: mob`** — mesh, run as bounded rounds. Round 1: dispatch all support agents in parallel against the lead's draft, mutually blind; each writes its contribution file. The lead integrates. Then TRIAGE unresolved objections by kind:
  - **Judgment calls** (both positions legitimate — scope, risk appetite, priority tradeoffs): surface to the HUMAN mid-stage as a structured question per §3 (write it to the stage's questions file with a blank `[Answer]:` tag BEFORE presenting, as §3 requires), then continue integration with the human's ruling. The human is a mob participant, not a post-hoc approver. Skipped under autonomous Construction — there the objection is recorded and surfaces at the final-batch gate.
  - **Knowledge disputes** (an expert can settle it): round 2 — re-dispatch each objecting agent with the revised draft and the other participants' recorded positions, to confirm or maintain (the agent updates its contribution file's Positions). Two rounds maximum.
  - Maintained dissent after triage is quoted verbatim in the completion summary at the gate; under autonomous Construction it is recorded in the artifact and audit and surfaces at the final-batch gate instead of halting.

On a harness that cannot dispatch in parallel, `subagent` spokes and `mob` round-1 dispatches run sequentially with UNCHANGED briefs — each participant still sees only what the topology grants it, never a sibling's contribution. The topology's who-sees-what contract is the invariant; concurrency is not.

### Collaborator contribution files (ensemble topologies)

A support agent dispatched on a `subagent` or `mob` stage (§5 "Multi-agent
stages") WRITES its work as a contribution file at
`<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages:
under the unit's stage dir) and returns the standard summary (§11) with the
file listed under "Produced". The file's shape:

```markdown
**Collaborator:** [agent-slug]

## Contribution
[The substantive content: findings, additions, corrections — written so the
lead can integrate it into the artifacts directly]

## Positions
- AGREE: [aspect of the draft endorsed] — [one-line rationale]
- OBJECT: [aspect disputed or missing] — [one-line rationale]
```

The identity-marker first line is verbatim and mandatory — the completion
evidence check (§5) verifies it. Positions are the raw material for the mob's
objection triage (§5): judgment calls go to the human mid-stage, knowledge
disputes to round 2 (the objecting agent updates its own file), and
maintained dissent is quoted verbatim at the gate. `None` under Positions
means full agreement. Contribution files never write outside
`contributions/`; the lead alone edits the stage's `produces[]` artifacts.
On `pipeline` stages there are no contribution files — chain links advance
the artifacts directly per the stage body, and the conductor records each
returned link with `aidlc-log.ts link` before continuing.

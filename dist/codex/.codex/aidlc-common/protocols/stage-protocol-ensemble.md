# Ensemble Protocol Module

Load this module when `directive.mode` is `subagent`, `pipeline`, or `mob`, or when the stage declares support agents; use only the harness subsection that matches the active harness.

## 5. Multi-agent stages (ensemble topologies)

Some stages use multiple agents (e.g., Feasibility uses aidlc-architect-agent + aidlc-aws-platform-agent + aidlc-compliance-agent). How the support agents participate is governed by the directive's `mode` — the stage's communication topology — never by the mere presence of `support_agents`. The roles are constant across topologies: the **lead agent** owns the stage's `produces[]` artifacts, **support agents** collaborate as real participants who write their own work, and the `reviewer` (stage-protocol-reviewer.md §12a, when declared) verifies from outside afterwards. The orchestrator is the bus on every topology: every exchange between participants is a dispatch it makes and a return it carries. Agents do NOT invoke each other — only the orchestrator delegates.

**What the user hears while an ensemble runs.** These handoffs happen inside a stage, past the reach of a directive's `narration`, so the sentences are written here. Only the double-quoted text is spoken; fill the `[bracketed]` slots and drop the brackets.

- Handing a specific question to one specialist - **SAY:** "Let me bring in the [trade] on [the specific question, in plain terms]."
- Starting a chain where each specialist builds on the last - **SAY:** "The [first trade] takes a look first, then the [next trade] builds on what comes back."
- Convening several specialists at once - **SAY:** "Getting the [trade] and [trade] to weigh in on this together."
- A specialist's work has come back and you are folding it in - **SAY:** nothing. Integration is the work, not an event.

Trades, never agent names, files, or slugs: product manager, product lead, designer, delivery lead, architect, architecture reviewer, platform engineer, compliance specialist, security engineer, developer, quality engineer, release engineer, operations engineer. Nothing is said about handing off as a mechanism, briefs, context paths, rule bundles, contribution files, identity markers, blindness between participants, rounds, or which topology the stage declares. The user is meeting colleagues; that setup is ours, not theirs. A topology that does not apply is never mentioned either.

**Who writes what (mirrors a real working session — everyone writes; the owner collates and edits):**

- Each dispatched support agent WRITES its own **contribution file** at `<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages: under the unit's stage dir). Separate files per agent, so parallel dispatch never conflicts. The file's FIRST line is the identity marker verbatim: `**Collaborator:** <agent-slug>`, followed by `## Contribution` (the substantive content, written to be integrable) and `## Positions` (`AGREE:` / `OBJECT:` bullets with one-line rationales; `None` = full agreement).
- The LEAD integrates contributions into the stage's `produces[]` artifacts and owns their final state. Contribution files are part of the stage's permanent record — dissent stays on disk, not in ephemeral return text.
- On `pipeline`, the chain collectively authors the artifacts directly (serialized, so no conflict) and the conductor mints a durable link receipt after every return — see the topology bullet.

- **`mode: inline`** — the support agents are perspectives the orchestrator adopts in its own context: load each support agent's file + knowledge the same way you loaded the lead (see "For inline stages" above), produce the lead's output first, then layer in each support perspective, then synthesise. Do NOT dispatch a support agent on an inline stage; dispatch is reserved for the other modes. No contribution files.
- **`mode: subagent`** - hub-and-spoke. Dispatch the lead for the draft. If the stage declares `support_agents`, dispatch each one against the returned draft (artifacts by path per §11's context budget, rules as the accumulated steering bundle per "For subagent stages" above; spokes are mutually blind - no support agent's brief contains another's contribution); each spoke writes its contribution file; then dispatch the lead once more to integrate the contributions into the artifacts.
- **`mode: pipeline`** — chain. `directive.pipeline.links` is the declared lead-then-support order; `directive.pipeline.completed` is the current-attempt recovery ledger. On entry or resume, skip every completed entry and dispatch the FIRST missing link. After each link returns, mint its receipt before dispatching the next: `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"`. Add `--single` when `directive.single === true`. For a multi-repo stage, run one independent chain per registered repo, add `--repo "<repo>"`, and treat repo-qualified `directive.pipeline.completed` entries (`<repo>:<agent>`) as that chain's recovery state. A current-attempt repo-scoped reuse receipt marks that repo's whole chain completed without dispatch. Each link sees everything upstream and advances the work product directly — it may edit the evolving artifacts in place (serialized, no conflict) or hand results down as context for the next link to build on, per the stage body. The FINAL link leaves the `produces[]` artifacts complete. Order is the point. No contribution files required.
- **`mode: mob`** — mesh, run as bounded rounds. Round 1: dispatch all support agents in parallel against the lead's draft, mutually blind; each writes its contribution file. The lead integrates. Then TRIAGE unresolved objections by kind:
  - **Judgment calls** (both positions legitimate — scope, risk appetite, priority tradeoffs): surface to the HUMAN mid-stage as a structured question per §3 (write it to the stage's questions file with a blank `[Answer]:` tag BEFORE presenting, as §3 requires), then continue integration with the human's ruling. The human is a mob participant, not a post-hoc approver. Skipped under autonomous Construction — there the objection is recorded and surfaces at the final-batch gate.
  - **Knowledge disputes** (an expert can settle it): round 2 — re-dispatch each objecting agent with the revised draft and the other participants' recorded positions, to confirm or maintain (the agent updates its contribution file's Positions). Two rounds maximum.
  - Maintained dissent after triage is quoted verbatim in the completion summary at the gate; under autonomous Construction it is recorded in the artifact and audit and surfaces at the final-batch gate instead of halting.

On a harness that cannot dispatch in parallel, `subagent` spokes and `mob` round-1 dispatches run sequentially with UNCHANGED briefs — each participant still sees only what the topology grants it, never a sibling's contribution. The topology's who-sees-what contract is the invariant; concurrency is not.

On every topology, a reviewer NOT-READY (stage-protocol-reviewer.md §12a step 3) re-invokes the LEAD alone with the findings — the ensemble convenes once; the repair loop is lead-reviewer ping-pong.

**Completion evidence (deterministic).** On a `mob` or `subagent`-with-supports stage, the contribution files are the deterministic, structural completion evidence the engine checks: it refuses gate entry and completion while any declared support agent's contribution file is missing or lacks its identity-marker first line. On `pipeline`, current-attempt `PIPELINE_LINK_COMPLETED` receipts are the evidence: every scanned repo needs every declared link, while a current-attempt repo-scoped `ARTIFACT_REUSED` row with `Decision: keep` exempts that reused repo. Isolated reuse rows and link receipts carry the same `single-stage:<slug>` workflow identity, never satisfy the main workflow, and are accepted only while the complete canonical CodeKB artifact set exists under authoritative regular-file paths and its source scope remains `CURRENT`. A rejection, jump, or later stage start resets the main-workflow evidence. Artifact files alone do not satisfy pipeline evidence. The shared escape hatch is `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1`, only for recovering a legitimately-run stage whose evidence was lost during upgrade or interruption.

---

## 11. Subagent Return Summary

When a subagent completes its work, it MUST return a structured summary to the orchestrator. This ensures no context is lost between subagent execution and orchestrator continuation.

### Required return format:
```markdown
## Subagent Summary: [Stage Name]

### Produced
- [file path 1]: [brief description of content]
- [file path 2]: [brief description of content]

### Key Decisions
- [Decision 1]: [rationale]
- [Decision 2]: [rationale]

### Issues / Concerns
- [Any problems encountered, edge cases found, or risks identified]
- "None" if no issues

### Next Steps
- [What the orchestrator should do next based on this output]
```

### Rules:
- The orchestrator MUST read this summary before proceeding to the next stage
- If the "Issues / Concerns" section is non-empty, the orchestrator MUST present them to the user before continuing
- If the "Produced" section lists fewer files than expected for the stage, the orchestrator MUST investigate before marking the stage complete
- The files are the substantive handoff. The return summary names paths,
  decisions, concerns, and the next action only; it does not repeat artifact,
  contribution, scan, source, or test-output bodies that are already on disk.

### Collaborator contribution files (ensemble topologies)

A support agent dispatched on a `subagent` or `mob` stage (§5 "Multi-agent
stages") WRITES its work as a contribution file at
`<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages:
under the unit's stage dir) and returns the standard summary above with the
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

### Context budget for subagent prompts
To prevent context overflow in subagent calls:
- **Current-unit only**: Pass only the design artifacts for the unit being implemented, not all units
- **Summarize inception artifacts**: For CONSTRUCTION subagents, provide a 1-2 line summary of each inception artifact with its file path, rather than embedding full content. The subagent can Read specific files if needed.
- **Always include**: The specific task instructions and relevant state/artifact paths. The harness agent config loads persona and knowledge context; do not paste either into the prompt.
- **Large knowledge sets**: Name any especially relevant file paths in the brief, but let the dispatched agent read them through its configured resources.

### Subagent failure recovery
If a Task tool call fails (timeout, error, or returns truncated/incomplete output):
1. **Retry once** with a reduced context prompt — summarize inception-phase artifacts instead of including full content, pass only the current unit's design artifacts
2. If the retry also fails, **tell the user plainly what failed** and offer two options via a structured question:
   - "Run it here": do the stage's work in this conversation instead of handing it off; slower, but it sidesteps whatever is failing
   - "Skip and revisit": leave the stage unfinished, keep going, and come back to it later
3. Log the failure and resolution in `<record>/audit/<host>-<clone>.md` using the Error log format

---

---

## Harness topology bindings

### Claude Code

**Pipeline receipt rule:** after every pipeline `Task` return, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next dispatch; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: run the lead via a `Task` call to the named agent, which loads the persona automatically — do not inject it in the prompt; if the stage declares `support_agents`, dispatch each one via `Task` against the lead's returned draft — parallel calls in one message, briefs with artifacts by path and rules as the accumulated load-steering bundle, mutually blind — each writes its contribution file, then a final lead `Task` integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead `Task` first, then one `Task` per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents in parallel `Task` calls against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`.

---

### Kiro CLI

**Pipeline receipt rule:** after every pipeline delegation returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next delegation; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: delegate the lead via the `subagent` tool to the named agent config, which loads its own persona — do not inject it in the prompt; if the stage declares `support_agents`, delegate each one against the lead's returned draft — parallel tasks in one delegation where possible, briefs with artifacts by path and rules as the accumulated load-steering bundle, mutually blind — each writes its contribution file, then a final lead delegation integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead delegation first, then one delegation per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents delegated in parallel against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`. Every delegation target needs an agent config in `.codex/agents/` and a `trustedAgents` entry in the conductor's config — all 14 personas ship both.

---

### Kiro IDE

**Pipeline receipt rule:** after every pipeline delegation returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next delegation; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: delegate the lead via the `subagent` tool to the named Markdown agent, which loads its own persona — do not inject it in the prompt; if the stage declares `support_agents`, delegate each one against the lead's returned draft — parallel tasks in one delegation where possible, briefs with artifacts by path and rules as the accumulated load-steering bundle, mutually blind — each writes its contribution file, then a final lead delegation integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead delegation first, then one delegation per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents delegated in parallel against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`. Kiro IDE resolves all 14 personas directly from `.codex/agents/aidlc-*-agent.md`; each file carries a non-empty `tools:` grant and capability-scoped `permissions.rules`, with no agent-v1 JSON or conductor `trustedAgents` entry.

---

### Codex CLI

**Pipeline receipt rule:** after every pipeline spawn returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next spawn; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: spawn the lead's agent role — the harness resolves `.codex/agents/aidlc-<role>-agent.toml`, which loads its own persona via `developer_instructions`; do not inject it in the prompt; if the stage declares `support_agents`, spawn each one against the lead's returned draft — sequentially is fine on this harness, briefs with artifacts by path and rules as the accumulated load-steering bundle, mutually blind: no spoke's brief contains another's contribution — each writes its contribution file, then a final lead spawn integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead spawn first, then one spawn per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then each support agent spawned against the draft — sequential spawns keep the blindness contract because the briefs never include a sibling's contribution — each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`.

---

### Cursor

**Pipeline receipt rule:** after every pipeline task returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next task; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: delegate the lead via the `task` tool to the named agent, which loads the persona automatically — do not inject it in the task; if the stage declares `support_agents`, dispatch each one via `task` against the lead's returned draft — parallel tasks in one turn, paths-only briefs, mutually blind — each writes its contribution file, then a final lead task integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead task first, then one task per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents in parallel tasks against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`.

---

### opencode

**Pipeline receipt rule:** after every pipeline task returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next task; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: delegate the lead via the `task` tool to the named agent, which loads the persona automatically — do not inject it in the task; if the stage declares `support_agents`, dispatch each one via `task` against the lead's returned draft — parallel tasks in one turn, briefs with artifacts by path and rules as the accumulated load-steering bundle, mutually blind — each writes its contribution file, then a final lead task integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead task first, then one task per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents in parallel tasks against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`.

---

### GitHub Copilot

**Pipeline receipt rule:** after every pipeline delegation returns, run `bun .codex/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"` before the next delegation; add `--repo "<repo>"` for multi-repo chains, add `--single` when `directive.single === true`, and resume from `directive.pipeline.completed`.

`directive.mode` tells you HOW to run the body — it is the stage's communication topology (who talks to whom; this module's §5 "Multi-agent stages" section is the contract). The writing model on every dispatched topology: everyone writes their own work — each dispatched support agent writes a contribution file (`<record>/<phase>/<stage>/contributions/<agent-slug>.md`, §11 shape with the identity-marker first line) — and the lead alone edits the stage's `produces[]` artifacts. `inline` (run it in this session, with the lead agent's persona framing loaded from its `.md` file under `.codex/agents/`; support agents are voices you adopt, no contribution files), `subagent` (hub-and-spoke: delegate the lead to the named custom agent, which loads its persona automatically — do not inject it in the brief; if the stage declares `support_agents`, dispatch each one against the lead's returned draft — parallel delegations in one turn, briefs with artifacts by path and rules as the accumulated `load-steering` bundle, mutually blind — each writes its contribution file, then a final lead delegation integrates them into the artifacts), `pipeline` (chain: the links collectively author the artifacts — lead delegation first, then one delegation per support agent in declared order, each link seeing everything upstream and advancing the work product directly; the FINAL link leaves the artifacts complete; no contribution files), or `mob` (mesh as bounded rounds: lead drafts, then ALL support agents in parallel delegations against the draft, each writing its contribution file; integrate as the lead, then triage unresolved objections per §5 — judgment calls go to the HUMAN mid-stage as a structured question, knowledge disputes to round 2 with only the objectors; maintained dissent is quoted verbatim at the gate). You are the bus on every topology, and a reviewer NOT-READY re-invokes the LEAD alone. The contribution files are the ensemble's completion evidence — the engine refuses approval on a mob/subagent-with-supports stage while one is missing. The shipped graph is 29 inline / 2 subagent / 1 pipeline / 1 mob: practices-discovery and code-generation carry `subagent`; reverse-engineering carries `pipeline` (developer scans, architect synthesizes and writes); user-stories carries `mob`.

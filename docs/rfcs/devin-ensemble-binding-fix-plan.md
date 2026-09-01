# Fix Plan — Devin Ensemble Protocol Binding Gap (All Dispatched Stages)

> Working plan for review, adapted to verified Devin CLI `run_subagent`
> semantics. Found while investigating why run 1's `code-generation` ran
> inline instead of via `run_subagent`; the root cause affects all four
> dispatched-topology stages, not just `code-generation`.
>
> **What this revision changes vs. the original draft.** The original
> assumed `run_subagent` "loads the named agent persona automatically"
> and left it at that. Reading the actual Devin CLI subagent docs
> (`docs/subagents.mdx`) and the adapter
> (`harness/devin/hooks/aidlc-devin-adapter.ts`) surfaced four
> load-bearing details the original missed and that any binding text
> must get right, or the fix silently reintroduces the gap under a
> different name:
>
> 1. **`run_subagent` takes a `profile`, not a model.** The agent name
>    must be passed as the `profile` field of the tool call — the
>    adapter reads `tool_input.agent` then `tool_input.profile` as
>    `subagent_type` (adapter line 599–601), and the
>    `plan-approval-guard` / `deliver-stage-rules` hooks match on that
>    value (adapter line 602: `if (subagentType !==
>    "aidlc-developer-agent") return 0`). If the conductor puts the
>    agent name only in the prompt text and omits `profile`, the hooks
>    silently do not fire — the exact failure mode this fix is meant to
>    close.
> 2. **No `model:` pin means the default subagent model (SWE-1.6), not
>    the parent's model.** The AIDLC agent files
>    (`core/agents/aidlc-<role>-agent.md`) carry no `model:` frontmatter
>    field, so on Devin every dispatched agent runs on the default
>    subagent model — a fast, cheap model — not the model the user
>    selected in the model picker. For `code-generation` (developer
>    agent) this is a quality regression vs. the inline behavior the
>    user has today. This is the highest-impact tradeoff in the fix and
>    must be surfaced as a decision, not buried.
> 3. **`disallowedTools` is a Claude field; Devin reads `allowed-tools`
>    (allowlist).** The agent files set `disallowedTools: Task` (a
>    Claude denylist with Claude's tool name). Devin's custom-subagent
>    format recognizes `name`, `description`, `model`, `allowed-tools`,
>    `max-nesting` — not `disallowedTools`. So on Devin the denylist is
>    silently ignored and dispatched agents get full tool access
>    (including `run_subagent`, though default nesting depth = 0
>    prevents recursive spawning, so this is a latent gap not a live
>    one).
> 4. **`ask_user_question` is always withheld from subagents.** A
>    dispatched support agent cannot surface a structured question to
>    the human. The mob topology's "judgment calls go to the HUMAN
>    mid-stage as a structured question" (§5) must be performed by the
>    **parent conductor**, never by a dispatched spoke. The binding
>    text must say so.
>
> Two further constraints shape the binding text:
>
> - **Parallel dispatch requires `is_background: true`.** Foreground
>   subagents run inline (parent pauses and waits); only background
>   subagents run concurrently. The lead must run in the foreground
>   (the parent needs its draft before dispatching supports); supports
>   run in the background in parallel, and the parent reads each result
>   via `read_subagent` before integrating. "Parallel calls in one
>   message" is imprecise — the actual mechanism is the
>   `is_background` flag on each `run_subagent` call.
> - **Nesting depth defaults to 0.** A dispatched agent cannot itself
>   dispatch. In every topology the **parent conductor** dispatches
>   every participant — the lead, every support, every pipeline link.
>   No agent brief may instruct a dispatched agent to dispatch another.

## Problem

The ensemble protocol
(`core/aidlc-common/protocols/stage-protocol-ensemble.md`) defines
harness-specific topology bindings — one `### <Harness>` section per
shipped CLI — that tell the conductor which native tool to use for
`subagent` / `pipeline` / `mob` dispatch on that harness. The file has
seven binding sections today:

- `### Claude Code` (line 124) — `Task`
- `### Kiro CLI` (line 132) — `subagent`
- `### Kiro IDE` (line 140) — `subagent`
- `### Codex CLI` (line 148) — spawn / agent role
- `### Cursor` (line 156) — `task`
- `### opencode` (line 164) — `task`
- `### GitHub Copilot` (line 172) — custom agent delegation

**`### Devin` is missing.** Devin is the eighth shipped harness
(`dist/devin/`), but its binding section was never added. Every harness
SKILL.md says "follow only this harness's topology subsection" — on
Devin, there is no subsection to follow. The conductor loads the
ensemble protocol, finds no Devin-specific guidance, and falls back to
the stage body's generic "Delegate to Task tool" prose (Claude's tool
name) plus the shared §5 contract. The result: the conductor may run a
dispatched-topology stage **inline** rather than via `run_subagent`,
which:

1. **Skips the two `run_subagent`-matcher hooks** —
   `deliver-stage-rules` (PreToolUse) and `log-subagent` (PostToolUse)
   never fire, so no `SUBAGENT_COMPLETED` audit event and no
   stage-rules delivery to the subagent brief. These two hooks have
   been NOT TESTED across runs 1 and 2 (15/17 and 14/17 hook coverage).
   **Even when the conductor does call `run_subagent`, the
   `deliver-stage-rules` and `plan-approval-guard` hooks fire only if
   the agent name is passed as `profile` (or `agent`) in the tool
   input** — the adapter matches on `tool_input.profile`, not on the
   prompt text (adapter line 599–602). A binding that names
   `run_subagent` but does not specify the `profile` field leaves the
   hook gap half-closed.
2. **Breaks the ensemble's completion-evidence contract** — on a
   `subagent`-with-supports or `mob` stage, the engine refuses gate
   entry while any declared support agent's contribution file is
   missing. If the conductor runs inline, no contribution files are
   written, and the gate blocks (or the conductor works around it,
   losing the structural evidence).
3. **Defeats the topology's who-sees-what contract** — inline
   execution gives the conductor full context visibility, while a
   dispatched subagent sees only its brief. The blindness contract
   between mob/subagent spokes is lost.

## Scope — all four dispatched-topology stages

This is not a `code-generation`-only issue. Four stages declare a
dispatched topology in their frontmatter, and all four are affected:

| Stage | Phase | `mode` | Lead agent | Support agents | Express scope? |
|-------|-------|--------|------------|-----------------|----------------|
| `reverse-engineering` (2.1) | Inception | `pipeline` | developer | architect | no (CONDITIONAL) |
| `practices-discovery` (2.2) | Inception | `subagent` | pipeline-deploy | quality, developer, devsecops | no (CONDITIONAL) |
| `user-stories` (2.4) | Inception | `mob` | product | design, developer, quality | no (CONDITIONAL) |
| `code-generation` (3.5) | Construction | `subagent` | developer | — (none) | yes (ALWAYS) |

`code-generation` is the only one that runs in the `express` scope
(the scope used in the e2e runs); the other three are CONDITIONAL and
run in larger scopes (`classic`, `feature`, `mvp`, etc.). But the
binding gap is the same for all four — the conductor has no
Devin-specific subsection for ANY topology, so any of the four can run
inline on Devin if the conductor doesn't infer the tool name from
elsewhere.

The fix must cover all three dispatched topologies (`subagent`,
`pipeline`, `mob`), not just `subagent` — the missing binding section
is per-harness, not per-topology.

## Verified Devin `run_subagent` contract

Before specifying the binding text, here is what the Devin CLI
subagent surface actually does, verified against
`docs/subagents.mdx` and the adapter. The binding text must agree
with every line of this.

- **Tool signature.** `run_subagent` takes `profile` (the subagent
  profile name — for AIDLC, the agent file's `name`, e.g.
  `aidlc-developer-agent`), `task` (the prompt), `is_background`
  (boolean), and `title`. It does **not** take a model. The adapter
  reads `tool_input.agent` first, then `tool_input.profile`, as
  `subagent_type` (adapter line 599–601); the conductor should pass
  `profile` (the field my `run_subagent` tool exposes).
- **Profile → agent file.** Devin auto-discovers `.devin/agents/*.md`
  as custom subagent profiles. The file name (minus `.md`) is the
  profile id; a `name:` in the frontmatter overrides it. The AIDLC
  agent files already set `name: aidlc-<role>-agent`, so the profile
  id is the agent slug. The markdown body after the frontmatter
  becomes the subagent's system prompt — **persona loading is
  automatic and the brief must NOT re-inject the persona text.** This
  part of the original draft's claim is correct.
- **Model resolution.** A custom subagent with no `model:` field runs
  on the **default subagent model** (SWE-1.6 by default, or whatever
  the org/enterprise "Default subagent model" setting resolves to) —
  **not** the parent's model. `subagent_general` is the only profile
  that follows the parent's model, and AIDLC agents are custom
  profiles, not `subagent_general`. The AIDLC agent files carry no
  `model:`, so every dispatched AIDLC agent runs on SWE-1.6 unless
  the user or admin overrides the default. See Fix D.
- **Foreground vs background.** Foreground: parent pauses, subagent
  runs inline, user approves tool calls as they come up. Background:
  subagent runs concurrently, parent is notified on completion,
  unapproved tools are auto-denied. The `.devin/config.json`
  pre-approves the write/exec/search toolset, so background
  subagents inherit those approvals and can write files without
  per-call prompts. **Parallel dispatch = multiple `run_subagent`
  calls with `is_background: true` in one message; the parent then
  reads each result via `read_subagent`.**
- **Nesting depth.** Default max nesting = 0: a subagent cannot
  spawn its own subagents. `run_subagent` and `read_subagent` are
  disabled inside a subagent. Only a custom profile with
  `max-nesting:` set can nest. **Consequence: in every topology, the
  parent conductor dispatches every participant.** No dispatched
  agent's brief may tell it to dispatch another — it cannot.
- **`ask_user_question` is always withheld from subagents.** A
  dispatched agent cannot ask the human a structured question. The
  mob topology's mid-stage human surfacing (§5 "judgment calls go to
  the HUMAN mid-stage as a structured question") is the **parent
  conductor's** job: the parent reads the contribution files'
  `## Positions` OBJECT bullets, classifies the objection, and
  renders the structured question itself. The binding text must say
  this explicitly.
- **`subagents_enabled: false`.** If the user set
  `subagents_enabled: false` in `~/.config/devin/config.json` (or the
  org admin set "Default subagent model" to "None"), `run_subagent`
  is removed from the tool set. The must-dispatch instruction (Fix C)
  must route that case through the §11 failure-recovery protocol,
  whose user-gated "Run it here" option is the only sanctioned inline
  path — never a silent fallback.
- **Adapter normalization.** The adapter rewrites `run_subagent` →
  `Task` for hook consumption (adapter line 86) and pipes PostToolUse
  to `aidlc-log-subagent.ts` (adapter line 712–714). The
  `plan-approval-guard` PreToolUse hook fires **only** when
  `subagent_type === "aidlc-developer-agent"` (adapter line 602) — so
  the `code-generation` plan-before-generation guard depends on the
  conductor passing `profile: "aidlc-developer-agent"`. The
  `deliver-stage-rules` hook forwards the same shape. Both hooks are
  ready; they fire iff `profile` is set correctly.

## Fix B — add `### Devin` binding to the ensemble protocol

**File:** `core/aidlc-common/protocols/stage-protocol-ensemble.md`

**Where:** after the `### GitHub Copilot` section (line 176), before
the file ends. Add a new `### Devin` section mirroring the structure of
the other seven bindings.

**Content:** the Devin-specific binding text, using `run_subagent` as
the dispatch tool (per `harness/devin/skills/aidlc/SKILL.md` line 207:
"subagent dispatch is `run_subagent`"). The text must cover:

1. **Pipeline receipt rule** — same as every other harness: after
   every pipeline `run_subagent` return, run
   `bun {{HARNESS_DIR}}/tools/aidlc-log.ts link --stage "<directive.stage>" --link "<agent>"`
   before the next dispatch; add `--repo "<repo>"` for multi-repo
   chains, add `--single` when `directive.single === true`, and resume
   from `directive.pipeline.completed`.
2. **The `directive.mode` paragraph** — the same topology contract as
   the other bindings, but with `run_subagent` as the dispatch verb
   for `subagent`, `pipeline`, and `mob`. Devin's `run_subagent` tool
   loads the named agent persona automatically (the agent files ship
   as flat `.md` under `{{HARNESS_DIR}}/agents/` and Devin
   auto-discovers them as custom subagent profiles); the brief must
   NOT inject the persona text. **The agent name MUST be passed as
   the `profile` field of the `run_subagent` call** — the adapter and
   the `deliver-stage-rules` / `plan-approval-guard` hooks match on
   `tool_input.profile`, not on the prompt text. Key Devin-specific
   points:
   - `subagent`: dispatch the lead via `run_subagent` with
     `profile: "<lead-agent-slug>"` in the **foreground**
     (`is_background: false` or omitted) — the parent needs the
     returned draft before dispatching supports. If the stage
     declares `support_agents`, dispatch each one via `run_subagent`
     against the lead's returned draft with `is_background: true` in
     one message (parallel; the parent reads each result via
     `read_subagent`), briefs with artifacts by path and rules as
     the accumulated load-steering bundle, mutually blind — each
     writes its contribution file, then a final lead `run_subagent`
     (foreground) integrates them into the artifacts. **No dispatched
     agent may be told to dispatch another — nesting depth defaults to
     0 and `run_subagent` is disabled inside a subagent.**
   - `pipeline`: chain — lead `run_subagent` (foreground) first, then
     one `run_subagent` per support agent in declared order
     (foreground, serialized — each link needs the prior link's
     output), each link seeing everything upstream and advancing the
     work product directly; the FINAL link leaves the artifacts
     complete; no contribution files. The parent conductor dispatches
     every link; no link dispatches the next.
   - `mob`: mesh as bounded rounds — lead drafts (foreground
     `run_subagent`), then ALL support agents in parallel
     `run_subagent` calls with `is_background: true` against the
     draft, each writing its contribution file; the parent reads each
     via `read_subagent` and integrates as the lead, then triages
     unresolved objections per §5. **The mid-stage human surfacing
     for judgment-call objections is the parent conductor's job —
     `ask_user_question` is withheld from subagents, so a dispatched
     spoke cannot surface the question itself.** The parent reads the
     contribution files' `## Positions` OBJECT bullets, classifies,
     and renders the structured question.
   - `inline`: run it in this session, with the lead agent's persona
     framing loaded from its `.md` file under `{{HARNESS_DIR}}/agents/`;
     support agents are voices you adopt, no contribution files.
3. **The completion-evidence sentence** — same as every other
   binding: the contribution files are the ensemble's completion
   evidence; the engine refuses approval on a mob/subagent-with-
   supports stage while any is missing; the escape hatch is
   `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1`.
4. **The model-resolution note (Devin-only).** A one-sentence note
   that dispatched agents run on the default subagent model (SWE-1.6
   by default), not the parent's model, unless the user overrides the
   "Default subagent model" setting or the agent file pins a `model:`
   (see Fix D). This is the one structural difference from the other
   seven bindings and must not be omitted — without it the conductor
   cannot reason about the quality tradeoff of dispatch vs. inline.

**Source text to adapt:** the `### Cursor` or `### opencode` section
is the closest structural match (both use a lowercase tool name;
Devin's is `run_subagent`). Adapt the tool name, the `profile`-field
mechanics, the foreground/background split for parallelism, the
`ask_user_question`-withheld constraint, and the model-resolution
note. The persona-loading note (Devin loads `.md` agent files, like
Cursor/opencode) carries over.

**Token substitution:** the file uses `{{HARNESS_DIR}}` throughout;
the packager substitutes `.devin` for the Devin dist tree. No change
to the packager.

## Fix C — add must-dispatch instruction to the Devin SKILL.md

**File:** `harness/devin/skills/aidlc/SKILL.md`

**Where:** immediately after the existing
`directive.mode selects the communication topology` paragraph (line
116), before the `---` separator at line 118.

**Content:** a Devin-specific must-dispatch instruction that closes
the gap from the conductor side, independent of the protocol binding.
This is belt-and-suspenders: even if the conductor fails to load the
ensemble protocol for some reason, the SKILL.md itself tells it not to
run a dispatched-topology stage inline.

**Text (draft):**

> **Dispatched topologies must dispatch, never run inline.** When
> `directive.mode` is `subagent`, `pipeline`, or `mob`, you MUST
> dispatch the lead (and each support agent per the topology) via
> `run_subagent` — never run the stage body inline in this session.
> Pass the agent slug as the `profile` field of each `run_subagent`
> call (the adapter and the `deliver-stage-rules` /
> `plan-approval-guard` hooks match on `tool_input.profile`, not on
> the prompt text — omitting it silently skips the hooks). Run the
> lead in the foreground; run parallel supports with
> `is_background: true` and read each result via `read_subagent`
> before integrating. No dispatched agent can itself dispatch
> (nesting depth defaults to 0), so you dispatch every participant in
> every topology. A dispatched agent cannot ask the user a structured
> question (`ask_user_question` is withheld from subagents) — the
> mob's mid-stage human surfacing is your job, not the spoke's.
> Inline execution breaks the ensemble's completion-evidence contract
> (no contribution files on `mob`/`subagent`-with-supports), skips the
> `deliver-stage-rules` and `log-subagent` hooks, and violates the
> who-sees-what contract the topology defines. The only exception is
> `mode: inline`, where support agents are voices you adopt in this
> session and no dispatch occurs. If `run_subagent` is unavailable
> (e.g. `subagents_enabled: false`) or fails twice, follow the
> subagent failure-recovery protocol (ensemble §11) — its user-gated
> "Run it here" option is the only sanctioned inline path; do not
> silently fall back to inline as the default.

**Scope of C:** this instruction covers ALL three dispatched
topologies (`subagent`, `pipeline`, `mob`) and ALL four stages, not
just `code-generation`. The instruction is mode-based, not stage-based,
so it applies wherever a dispatched topology appears in the current or
future stage graph.

**Why C is net-new for Devin (not a pattern from other harnesses):**
no other harness SKILL.md currently has an explicit must-dispatch
instruction — they all rely on the ensemble protocol binding alone.
Adding C to Devin is a targeted robustness measure for the harness
that has the binding gap and the live-evidence gap (runs 1 and 2 both
failed to dispatch). If desired, the same instruction can be added to
the other seven harness SKILL.md files for parity, but that is
optional and out of scope for this fix — the other seven have protocol
bindings that name their native tool, so their conductors have a
section to follow.

## Fix D — the agent-file model gap (decision required)

**This is the gap the original draft missed entirely, and it is the
highest-impact tradeoff in the whole fix.** The AIDLC agent files
(`core/agents/aidlc-<role>-agent.md`) carry no `model:` frontmatter
field. On Devin, a custom subagent with no `model:` runs on the
**default subagent model** (SWE-1.6 by default) — not the parent's
model. So once the fix makes `code-generation` dispatch via
`run_subagent`, the developer agent runs on SWE-1.6 instead of the
model the user selected in the model picker. For a code-generation
stage that is a quality regression vs. the inline behavior the user
has today. The same applies to every dispatched lead and support
agent on every dispatched-topology stage.

The `disallowedTools: Task` field in the agent files is a Claude
denylist with Claude's tool name. Devin's custom-subagent format
recognizes `allowed-tools` (allowlist), `model`, `max-nesting`,
`name`, `description` — not `disallowedTools`. So on Devin the
denylist is silently ignored. This is a latent gap (default nesting
depth = 0 prevents recursive spawning even with full tool access), not
a live one, but it should be documented.

**Three options — pick one before implementing B + C:**

1. **Accept SWE-1.6 for dispatched agents and document it.** The
   binding text's model-resolution note (Fix B point 4) is the only
   change. Users who want their primary model for dispatched agents
   set the org "Default subagent model" to it. Lowest cost, lowest
   risk, but silently downgrades code-generation quality for every
   user who does not read the note.
2. **Add a Devin-specific agent overlay with `model:` pins.** The
   packager already does `{{HARNESS_DIR}}` substitution; extend it to
   inject a `model:` field (or a Devin-specific frontmatter block)
   into the agent files for the Devin dist tree only. This is a
   packager change and out of scope for a "two prose files" fix, but
   it is the correct long-term answer if dispatched-agent quality
   matters. The `model:` value is a policy choice — pin every
   dispatched agent to the parent's model (requires a `parent` sentinel
   the router does not currently expose), or pin per-role (e.g.
   developer → primary, quality → SWE-1.6).
3. **Tell users to set the "Default subagent model" in org settings.**
   A documentation-only fix: the getting-started guide notes that
   dispatched AIDLC agents run on the default subagent model and
   points to the org setting. No code change. Pairs with option 1.

**Recommendation:** ship B + C with option 1 (the model-resolution
note) for this fix, and open a follow-up issue for option 2 (the
packager overlay) if run-3 e2e shows SWE-1.6 is insufficient for
`code-generation`. Option 3 is a doc addendum either way.

**The `disallowedTools` mismatch is documented but not fixed here.**
Devin's `allowed-tools` is an allowlist; AIDLC's `disallowedTools` is a
denylist with a Claude tool name. Translating denylist → allowlist
requires per-agent tool budgets and is a packager change. Default
nesting depth = 0 prevents the recursive-spawning risk the denylist
was meant to stop, so this is not urgent. Note it in the binding text
and leave the fix for a separate change.

## Files to edit

| File | Edit | Lines (approx) |
|------|------|-----------------|
| `core/aidlc-common/protocols/stage-protocol-ensemble.md` | Add `### Devin` section after `### GitHub Copilot` (line 176) | +~30 lines |
| `harness/devin/skills/aidlc/SKILL.md` | Add must-dispatch paragraph after line 116 | +~15 lines |

No other source files change for B + C + D-option-1. The `dist/devin/`
tree is regenerated by `bun scripts/package.ts` (the packager copies
the ensemble protocol from `core/` and the SKILL.md from
`harness/devin/` with `{{HARNESS_DIR}}` substitution). Fix D option 2
would add a packager change to `scripts/package.ts` and is out of
scope for this fix.

## Repackage and verify

1. **Regenerate all dist trees** (the ensemble protocol is shared
   across all harnesses, so every `dist/<harness>/` gets the new file;
   only `dist/devin/` gets the SKILL.md change):
   ```bash
   bun scripts/package.ts
   ```
2. **Drift guard** — confirm every tree is in sync:
   ```bash
   bun scripts/package.ts --check
   # expected: package --check: all harness trees in sync with core/ + harness/.
   ```
3. **Confirm the binding landed in the Devin dist:**
   ```bash
   grep -n '### Devin' dist/devin/.devin/aidlc-common/protocols/stage-protocol-ensemble.md
   # must match
   grep -n 'Dispatched topologies must dispatch' dist/devin/.devin/skills/aidlc/SKILL.md
   # must match
   ```
4. **Confirm the binding landed in every dist** (the protocol is shared):
   ```bash
   for h in claude codex copilot cursor kiro kiro-ide opencode devin; do
     grep -q '### Devin' dist/$h/*/aidlc-common/protocols/stage-protocol-ensemble.md && echo "$h: OK" || echo "$h: MISSING"
   done
   # every harness: OK (the protocol file is identical across harnesses)
   ```
5. **Confirm the `profile`-field mechanic is in the binding** (the
   hook-firing prerequisite the original draft missed):
   ```bash
   grep -n 'profile' dist/devin/.devin/aidlc-common/protocols/stage-protocol-ensemble.md
   # the ### Devin section must mention passing the agent slug as profile
   ```
6. **Confirm the model-resolution note is in the binding** (Fix D
   option 1):
   ```bash
   grep -n 'default subagent model\|SWE-1.6' dist/devin/.devin/aidlc-common/protocols/stage-protocol-ensemble.md
   # must match
   ```

## Test impact

**No existing test breaks.** The test suite does not enforce the
presence or absence of per-harness binding sections in the ensemble
protocol:

- `t181-conductor-skill-parity.test.ts` checks for `ENSEMBLE_TOKENS`
  in each harness SKILL.md (the run-stage directive handling tokens),
  not for `### <Harness>` sections in the protocol file. The Devin
  SKILL.md already passes these. Adding the must-dispatch paragraph
  (C) does not remove any existing token.
- `t302-protocol-modules.test.ts` checks that the engine emits
  `ensemble` in `protocol_modules` for dispatched stages, not the
  protocol file's content.
- `t37.test.ts` checks §5's inline-support ban and the conductor's
  mirror, not the per-harness binding sections.
- `t146-core-hygiene.test.ts` allowlists specific harness references
  in the reviewer module only, not the ensemble protocol.
- `t248-copilot-packaging.test.ts` checks that the Copilot ensemble
  protocol contains a specific shared token, not per-harness sections.
- `t01-file-structure.test.ts` checks the protocol file exists, not
  its section count.

**New test (recommended):** add a test that enforces the invariant
going forward — every shipped harness has a `### <Harness>` binding
section in the ensemble protocol, and the Devin section specifically
names `run_subagent`, the `profile` field, and the model-resolution
note. This prevents the gap from recurring when a ninth harness is
added, and prevents the `profile`-field mechanic from being silently
dropped from the binding text. Suggested location:
`tests/unit/t181-conductor-skill-parity.test.ts` (it already enforces
per-harness SKILL parity) or a new
`t333-ensemble-harness-bindings.test.ts`.

The test would:
- read `HARNESS_MATRIX` (the canonical list of shipped harnesses, from
  `tests/harness/harness-matrix.ts`);
- for each harness, assert that
  `core/aidlc-common/protocols/stage-protocol-ensemble.md` contains a
  `### <Harness Name>` heading matching that harness's display name;
- assert the section contains the pipeline receipt rule and the
  `directive.mode` paragraph (the two structural invariants every
  binding shares);
- for the Devin section specifically, assert it mentions `profile`,
  `is_background`, and the default subagent model (the three
  Devin-specific invariants without which the hooks silently do not
  fire or the model silently downgrades).

The harness display names in the protocol file are: "Claude Code",
"Kiro CLI", "Kiro IDE", "Codex CLI", "Cursor", "opencode", "GitHub
Copilot", and (after this fix) "Devin". The test should map
`HARNESS_MATRIX` entries to these display names.

## Documentation impact

Per the documentation policy in `AGENTS.md`, grep `docs/` and
`README.md` for stale references. The ensemble protocol is referenced
in:

- `docs/reference/01-architecture.md` line 358
- `docs/reference/04-stage-protocol.md` lines 33, 52, 631, 646, 941
- `docs/reference/03-orchestrator.md` lines 448, 449
- `docs/reference/15-stage-definition.md` line 370

None of these reference the per-harness binding section count or list
Devin as missing — they reference the protocol file by name and
purpose. No doc updates are required for this fix. (If any doc says
"seven harness bindings" or lists the bound harnesses without Devin,
it would need updating; a grep for "seven" / "7" near "ensemble" or
"binding" in `docs/` returned no such text.)

**Fix D option 3 addendum:** if option 3 is adopted, the getting-
started guide (`docs/guide/01-getting-started.md` § "Devin CLI Setup")
should note that dispatched AIDLC agents run on the default subagent
model and point to the org "Default subagent model" setting. This is a
one-line doc change and pairs with option 1.

## Changelog and version

Per the changelog policy in `AGENTS.md`, this is a user-visible fix
(the conductor's dispatch behaviour on Devin changes — stages that
ran inline now dispatch via `run_subagent`, firing two previously-
untested hooks, and dispatched agents now run on the default subagent
model unless overridden). It bumps:

1. `core/tools/aidlc-version.ts` — `AIDLC_VERSION` patch bump (e.g.
   `2.6.124` → `2.6.125`).
2. `README.md` — the version badge.
3. `CHANGELOG.md` — a new `## [2.6.125] - 2026-09-01` heading with a
   summary and bullet list focused on what users invoke:
   - Devin: dispatched-topology stages (`subagent`, `pipeline`,
     `mob`) now dispatch via `run_subagent` as designed, firing the
     `deliver-stage-rules` and `log-subagent` hooks; the conductor
     no longer falls back to inline execution when the ensemble
     protocol lacks a Devin binding section. The agent slug must be
     passed as the `profile` field of each `run_subagent` call or the
     hooks do not fire.
   - Devin: dispatched agents run on the default subagent model
     (SWE-1.6 by default), not the parent's model. To run dispatched
     agents on your primary model, set the org "Default subagent
     model" to it (see `docs/guide/01-getting-started.md`).
   - All harnesses: the ensemble protocol now carries a `### Devin`
     binding section (was missing — Devin was the only shipped
     harness without one).

The `t68-version-changelog-sync.test.ts` pin enforces that the
shipped `aidlc-version.ts`, the latest `CHANGELOG.md` heading, and the
README badge agree.

## Implementation order

1. **Decide Fix D option** (1, 2, or 3) before writing the binding
   text — the model-resolution note in B depends on it.
2. Add the `### Devin` section to
   `core/aidlc-common/protocols/stage-protocol-ensemble.md` (Fix B),
   including the `profile`-field mechanic, the foreground/background
   split, the `ask_user_question`-withheld constraint, and the
   model-resolution note.
3. Add the must-dispatch paragraph to
   `harness/devin/skills/aidlc/SKILL.md` (Fix C).
4. (Optional) Add the binding-parity test to
   `tests/unit/t181-conductor-skill-parity.test.ts` or a new
   `t333-ensemble-harness-bindings.test.ts`, including the
   Devin-specific `profile` / `is_background` / model-resolution
   assertions.
5. Bump `core/tools/aidlc-version.ts`, `README.md` badge, and
   `CHANGELOG.md` (per changelog policy).
6. Run `bun scripts/package.ts` to regenerate all `dist/<harness>/`
   trees.
7. Run `bun scripts/package.ts --check` to confirm no drift.
8. Run the test suite: `bash tests/run-tests.sh` (or at least the
   unit tier: `bun test tests/unit/`).
9. Commit with message:
   `fix(devin): add ensemble protocol binding + must-dispatch instruction so dispatched-topology stages dispatch via run_subagent`
10. Update the run-3 plan's Phase 0 pre-flight to check for the
    `### Devin` binding in the copied tree (the existing pre-flight
    checks for `normalizeToolResponse`; this adds a second check for
    the binding section, a third for the `profile`-field mention, and
    a fourth for the model-resolution note).

## What this fix does NOT do

- **Does not change the engine** (`aidlc-orchestrate.ts`). The engine
  already emits `mode: node.mode` on the directive (line 3201) and
  lists `ensemble` in `protocol_modules` for dispatched stages (line
  3268-3274). The gap is purely in the protocol file and the harness
  SKILL.md — the conductor's instruction surface, not the engine's
  directive surface.
- **Does not change the adapter** (`aidlc-devin-adapter.ts`). The
  adapter already maps `run_subagent` → `Task` (line 86), reads
  `tool_input.agent` / `tool_input.profile` as `subagent_type` (line
  599–601), gates `plan-approval-guard` on
  `subagentType === "aidlc-developer-agent"` (line 602), and pipes
  PostToolUse to `log-subagent` (line 712). The adapter is ready; the
  conductor just never calls `run_subagent` with the right `profile`
  because no binding tells it to.
- **Does not add `model:` pins to the agent files** (Fix D option 2).
  That is a packager change and a policy decision (which model per
  role). It is a follow-up, not part of this fix. This fix documents
  the model downgrade in the binding text and the changelog so users
  can reason about it.
- **Does not translate `disallowedTools` → `allowed-tools`.** The
  denylist is silently ignored on Devin; default nesting depth = 0
  prevents the recursive-spawning risk it was meant to stop. The
  binding text notes the mismatch; the fix is a separate change.
- **Does not add must-dispatch instructions to the other seven
  harness SKILL.md files.** Those harnesses have protocol bindings
  that name their native tool, so their conductors have a section to
  follow. Adding C to them is optional parity and out of scope for
  this fix. (If desired later, it would be a separate "add
  must-dispatch belt-and-suspenders to all harnesses" change.)
- **Does not change the stage files** (`code-generation.md`, etc.).
  The stage bodies say "Delegate to Task tool" (Claude's name); the
  ensemble protocol binding is the harness-specific override that
  translates that to the native tool. The stage files are
  harness-neutral and stay as-is.

## Risk assessment

- **Low risk for the prose fix.** B + C add prose guidance to two
  files; they change no code, no engine logic, no hook wiring, and no
  adapter behavior. The worst case is that the conductor now
  dispatches via `run_subagent` where it previously ran inline —
  which is the designed behavior and what the hooks are wired for.
- **The model downgrade is the real tradeoff (Fix D).** Once the
  conductor dispatches `code-generation` via `run_subagent`, the
  developer agent runs on SWE-1.6 (the default subagent model) instead
  of the parent's model. For a user who selected a premium primary
  model for code generation, this is a quality regression vs. the
  inline behavior they have today. The binding text and the changelog
  surface this; the user can override the default subagent model in
  org settings. Run-3 e2e should compare dispatch-vs-inline quality
  for `code-generation` before declaring the fix complete.
- **The `profile`-field mechanic is a silent-failure surface.** If
  the conductor calls `run_subagent` with the agent name only in the
  prompt and omits `profile`, the adapter's `subagent_type` is empty,
  `plan-approval-guard` returns 0 (adapter line 602), and
  `deliver-stage-rules` forwards an empty type. The hooks silently do
  not fire — the same gap this fix is meant to close, just one layer
  up. The binding text and the must-dispatch instruction both
  specify the `profile` field; the binding-parity test asserts its
  presence in the text. A future test that exercises the adapter
  end-to-end with a real `run_subagent` call would close this
  completely, but that is an integration-tier change.
- **The ensemble-evidence contract becomes live on Devin.** Once the
  conductor dispatches `practices-discovery` (subagent with 3
  supports) or `user-stories` (mob with 3 supports), the engine will
  check for contribution files at gate entry. If the conductor
  doesn't write them (because the support agents didn't, or the
  dispatch failed), the gate blocks with the
  `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1` escape hatch. This is the
  designed enforcement — it was always supposed to fire on Devin for
  these stages, but never did because the conductor ran inline and
  the evidence check was moot. The run-3 e2e (express scope) doesn't
  hit these stages (they're CONDITIONAL, skipped in express), so the
  risk is limited to larger-scope runs until a live e2e verifies them
  too.
- **The `code-generation` stage has no support agents** (`support_agents:
  []`), so its `subagent` mode does NOT require contribution files
  (the evidence check fires only for `mob` or `subagent`-with-supports
  per `requiresEnsembleEvidence()` at `aidlc-orchestrate.ts` line
  7078-7080). So `code-generation` in express scope can dispatch via
  `run_subagent` without the evidence check blocking — the lowest-risk
  verification path, which is why the run-3 plan targets it first.
  The model downgrade still applies (SWE-1.6 vs the parent model),
  and is the one risk to watch in the run-3 `code-generation` result.

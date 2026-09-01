# Fix Plan — Devin Ensemble Protocol Binding Gap (All Dispatched Stages)

> Working plan for review. Found while investigating why run 1's
> `code-generation` ran inline instead of via `run_subagent`; the root
> cause affects all four dispatched-topology stages, not just
> `code-generation`.

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
   as flat `.md` under `.devin/agents/`); the brief must NOT inject
   the persona text. Key Devin-specific points:
   - `subagent`: dispatch the lead via `run_subagent` with the named
     agent; if the stage declares `support_agents`, dispatch each one
     via `run_subagent` against the lead's returned draft — parallel
     calls in one message where possible (Devin supports parallel
     subagent dispatch), briefs with artifacts by path and rules as
     the accumulated load-steering bundle, mutually blind — each
     writes its contribution file, then a final lead `run_subagent`
     integrates them into the artifacts.
   - `pipeline`: chain — lead `run_subagent` first, then one
     `run_subagent` per support agent in declared order, each link
     seeing everything upstream and advancing the work product
     directly; the FINAL link leaves the artifacts complete; no
     contribution files.
   - `mob`: mesh as bounded rounds — lead drafts, then ALL support
     agents in parallel `run_subagent` calls against the draft, each
     writing its contribution file; integrate as the lead, then
     triage unresolved objections per §5.
   - `inline`: run it in this session, with the lead agent's persona
     framing loaded from its `.md` file under `{{HARNESS_DIR}}/agents/`;
     support agents are voices you adopt, no contribution files.
3. **The completion-evidence sentence** — same as every other
   binding: the contribution files are the ensemble's completion
   evidence; the engine refuses approval on a mob/subagent-with-
   supports stage while any is missing; the escape hatch is
   `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1`.

**Source text to adapt:** the `### Cursor` or `### opencode` section
is the closest structural match (both use a lowercase tool name;
Devin's is `run_subagent`). Adapt the tool name and the persona-loading
note (Devin loads `.md` agent files, like Cursor/opencode, not `.toml`
like Codex or agent-config like Kiro).

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
> Inline execution breaks the ensemble's completion-evidence contract
> (no contribution files on `mob`/`subagent`-with-supports), skips the
> `deliver-stage-rules` and `log-subagent` hooks, and violates the
> who-sees-what contract the topology defines. The only exception is
> `mode: inline`, where support agents are voices you adopt in this
> session and no dispatch occurs. If `run_subagent` is unavailable or
> fails twice, follow the subagent failure-recovery protocol
> (ensemble §11) — do not silently fall back to inline as the default.

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

## Files to edit

| File | Edit | Lines (approx) |
|------|------|-----------------|
| `core/aidlc-common/protocols/stage-protocol-ensemble.md` | Add `### Devin` section after `### GitHub Copilot` (line 176) | +~25 lines |
| `harness/devin/skills/aidlc/SKILL.md` | Add must-dispatch paragraph after line 116 | +~10 lines |

No other source files change. The `dist/devin/` tree is regenerated by
`bun scripts/package.ts` (the packager copies the ensemble protocol
from `core/` and the SKILL.md from `harness/devin/` with
`{{HARNESS_DIR}}` substitution).

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
- `t37-stage-protocol-compliance.test.ts` checks §5's inline-support
  ban and the conductor's mirror, not the per-harness binding
  sections.
- `t146-core-hygiene.test.ts` allowlists specific harness references
  in the reviewer module only, not the ensemble protocol.
- `t248-copilot-packaging.test.ts` checks that the Copilot ensemble
  protocol contains a specific shared token, not per-harness sections.
- `t01-file-structure.test.ts` checks the protocol file exists, not
  its section count.

**New test (recommended):** add a test that enforces the invariant
going forward — every shipped harness has a `### <Harness>` binding
section in the ensemble protocol. This prevents the gap from recurring
when a ninth harness is added. Suggested location:
`tests/unit/t181-conductor-skill-parity.test.ts` (it already enforces
per-harness SKILL parity) or a new `t333-ensemble-harness-bindings.test.ts`.

The test would:
- read `HARNESS_MATRIX` (the canonical list of shipped harnesses);
- for each harness, assert that
  `core/aidlc-common/protocols/stage-protocol-ensemble.md` contains a
  `### <Harness Name>` heading matching that harness's display name;
- assert the section contains the pipeline receipt rule and the
  `directive.mode` paragraph (the two structural invariants every
  binding shares).

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

## Changelog and version

Per the changelog policy in `AGENTS.md`, this is a user-visible fix
(the conductor's dispatch behaviour on Devin changes — stages that
ran inline now dispatch via `run_subagent`, firing two previously-
untested hooks). It bumps:

1. `core/tools/aidlc-version.ts` — `AIDLC_VERSION` patch bump (e.g.
   `2.6.124` → `2.6.125`).
2. `README.md` — the version badge.
3. `CHANGELOG.md` — a new `## [2.6.125] - 2026-09-01` heading with a
   summary and bullet list focused on what users invoke:
   - Devin: dispatched-topology stages (`subagent`, `pipeline`,
     `mob`) now dispatch via `run_subagent` as designed, firing the
     `deliver-stage-rules` and `log-subagent` hooks; the conductor
     no longer falls back to inline execution when the ensemble
     protocol lacks a Devin binding section.
   - All harnesses: the ensemble protocol now carries a `### Devin`
     binding section (was missing — Devin was the only shipped
     harness without one).

The `t68-version-changelog-sync.test.ts` pin enforces that the
shipped `aidlc-version.ts`, the latest `CHANGELOG.md` heading, and the
README badge agree.

## Implementation order

1. Add the `### Devin` section to
   `core/aidlc-common/protocols/stage-protocol-ensemble.md` (Fix B).
2. Add the must-dispatch paragraph to
   `harness/devin/skills/aidlc/SKILL.md` (Fix C).
3. (Optional) Add the binding-parity test to
   `tests/unit/t181-conductor-skill-parity.test.ts` or a new
   `t333-ensemble-harness-bindings.test.ts`.
4. Bump `core/tools/aidlc-version.ts`, `README.md` badge, and
   `CHANGELOG.md` (per changelog policy).
5. Run `bun scripts/package.ts` to regenerate all `dist/<harness>/`
   trees.
6. Run `bun scripts/package.ts --check` to confirm no drift.
7. Run the test suite: `bash tests/run-tests.sh` (or at least the
   unit tier: `bun test tests/unit/`).
8. Commit with message:
   `fix(devin): add ensemble protocol binding + must-dispatch instruction so dispatched-topology stages dispatch via run_subagent`
9. Update the run-3 plan's Phase 0 pre-flight to check for the
   `### Devin` binding in the copied tree (the existing pre-flight
   checks for `normalizeToolResponse`; this adds a second check for
   the binding section).

## What this fix does NOT do

- **Does not change the engine** (`aidlc-orchestrate.ts`). The engine
  already emits `mode: node.mode` on the directive (line 3201) and
  lists `ensemble` in `protocol_modules` for dispatched stages (line
  3268-3274). The gap is purely in the protocol file and the harness
  SKILL.md — the conductor's instruction surface, not the engine's
  directive surface.
- **Does not change the adapter** (`aidlc-devin-adapter.ts`). The
  adapter already maps `run_subagent` → `Task` (line 86) and pipes
  PostToolUse to `log-subagent` (line 712). The adapter is ready; the
  conductor just never calls `run_subagent` because no binding tells
  it to.
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

- **Low risk.** The fix adds prose guidance to two files; it changes
  no code, no engine logic, no hook wiring, and no adapter behavior.
  The worst case is that the conductor now dispatches via
  `run_subagent` where it previously ran inline — which is the
  designed behavior and what the hooks are wired for.
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

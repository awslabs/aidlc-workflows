# Implementation Plan — Port AI-DLC to Devin CLI (`harness/devin/`)

> The original 10-step port plan that built the Devin harness from scratch
> (commit `172cfd55` — "feat: add Devin CLI harness — eighth distribution
> from one core"). Executed autonomously via sub-agents with per-step
> worker/reviewer verification. The adapter bug found by the second live
> e2e run (`evidence/devin-e2e-run/second-run/`) was introduced in
> Step 3 and missed by Step 9's tests (the fixture used a string-format
> `tool_response` instead of Devin's object format). The targeted fix is
> in [`devin-adapter-ask-user-question-fix-plan.md`](devin-adapter-ask-user-question-fix-plan.md).

Status: **Shipped** (commit `172cfd55`) — the harness is live; the adapter
bug fix is pending.

## Execution model (autonomous, sub-agent driven)

The main GLM 5.2 session is the **orchestrator**. It does NOT edit files directly. Each step is executed by a **worker** sub-agent and validated by a **reviewer** sub-agent before the orchestrator advances. This splits the long-horizon 10-step chain into bounded, independently-verified units — directly countering GLM 5.2's known long-horizon error-compounding weakness.

### Roles

| Role | Sub-agent profile | Tool access | Job |
|---|---|---|---|
| **Orchestrator** | (main session) | `run_subagent`, `read`, `exec` (verify-only) | Reads the step spec, dispatches worker, dispatches reviewer, checks verdict, advances or retries. Never edits files. |
| **Worker** | `subagent_general` | full (read, write, edit, exec) | Implements exactly one step. Produces only the files listed for that step. Runs the step's `Verify` command. Returns a short report: files changed, commands run, verify output. |
| **Reviewer** | `subagent_explore` | read-only (grep, glob, read, web_search) | Independently re-checks `Done when`, re-runs read-only `Verify` checks, audits the diff for `Do not` violations and scope creep. Returns `READY` / `NOT-READY` + evidence-grounded findings. |

### Per-step loop (binding)

For each step, the orchestrator runs this exact sequence:

1. **Dispatch worker** (`run_subagent`, `subagent_general`, foreground): prompt = the step's full spec (from this plan) + the `Done when` / `Verify` / `Do not` contract + the list of reference files to read first. Block on completion.
2. **Dispatch reviewer** (`run_subagent`, `subagent_explore`, foreground): prompt = the step number + `Done when` / `Verify` / `Do not` contract + instruction to independently verify (re-run read-only checks, audit `git diff`, confirm no `Do not` violation, confirm scope matches "Files touched" for that step). Block on completion. Reviewer's first output line MUST be `**Reviewer:** devin-port-step-<N>` followed by `READY` or `NOT-READY`.
3. **Act on verdict**:
   - `READY` → mark step complete, advance to next step.
   - `NOT-READY` → re-dispatch worker with the reviewer's findings appended to the prompt (retry). **Max 2 retries per step.** After 2 failed retries, STOP and escalate to the user with the reviewer's findings + the worker's last report. Do not advance on a red verdict.

### Parallelizable step groups (worker dispatch in parallel; reviewers run after the batch)

After Step 2 (manifest) lands and is reviewed green, Steps 3, 5, 6, 7 author independent files and may be dispatched as parallel background workers (`run_subagent`, `subagent_general`, `is_background: true`):
- Step 3 → `harness/devin/hooks/aidlc-devin-adapter.ts`
- Step 5 → `harness/devin/skills/aidlc/{SKILL.md,question-rendering.md}`
- Step 6 → `harness/devin/{config.json,mcp_config.json,rules-aidlc.md,dot-gitignore}`
- Step 7 → `harness/devin/onboarding.fills.ts`

These write disjoint file sets, so parallel workers do not interfere. Wait for all four to complete (`read_subagent`, `block: true`), then dispatch one reviewer per step (reviewers are read-only and may also run in parallel). Step 4 (hooks wiring) depends on Step 3's adapter and runs after the batch is green. Steps 8–10 are strictly sequential (each depends on the full harness tree).

### Orchestrator rules (binding, earlier rules win on conflict)

1. **Never edit files from the main session.** All edits go through worker sub-agents.
2. **One step at a time, in order** (except the declared parallel batch). Do not skip, merge, or reorder.
3. **No step advances without a `READY` reviewer verdict.** A green `Verify` run by the worker is necessary but not sufficient — the reviewer independently confirms.
4. **Workers get the full step spec + contract.** Do not paraphrase the step into the worker prompt; paste the step's bullets and its row from the verification-gates table verbatim.
5. **Reviewers get the contract + diff, not the step spec.** The reviewer checks against `Done when` / `Do not`, not against "what the worker was told" — this keeps the review independent.
6. **Max 2 retries, then escalate.** Do not loop indefinitely; do not silently advance on repeated NOT-READY.
7. **Edit `core/` and `harness/devin/` only.** Never hand-edit `dist/`. Workers regenerate via `bun scripts/package.ts devin` and confirm with `--check`.
8. **Minimal changes.** Workers mimic existing patterns in `harness/codex/` and `harness/claude/`. No new dependencies, no unrelated refactors.
9. **No secrets, no commits, no pushes** from workers or orchestrator unless the user explicitly asks.
10. **Report drift.** If a worker or reviewer reports that a referenced file/line/symbol no longer matches reality, the orchestrator stops and asks the user before re-dispatching.
11. **Be concise.** Worker and reviewer reports are 1-4 lines of summary + the required evidence (file list, command output, verdict). No preamble, no unsolicited summaries.
12. **Constrain output to the task.** Workers produce exactly the files listed under "Files touched" for their step — nothing extra. Reviewers flag any file outside the step's scope as a `Do not` violation.

## Verification basis

- **AIDLC porting contract**: `docs/harness-engineering/09-porting-to-a-new-harness.md`
  (local) confirmed byte-identical to the v2 GitHub copy
  (https://github.com/awslabs/aidlc-workflows/blob/v2/docs/harness-engineering/09-porting-to-a-new-harness.md).
- **Devin CLI surfaces**: read from the on-disk docs at
  `/home/wiley/.local/share/devin/cli/_versions/3000.6.7/share/devin/docs`
  and cross-checked against https://docs.devin.ai/cli/extensibility/rules.
- **Reference harnesses**: `harness/claude/` (minimal, in-tree skills) and
  `harness/codex/` (adapter + emit, the worked example for divergence).
- **Doctor arm pattern**: `core/tools/aidlc-utility.ts` lines ~2280–2600
  (per-harness branches on `harness === ".claude" | ".kiro" | ".codex" |
  ".aidlc" | ".cursor"`).

## What Devin CLI gives us (vs Claude Code)

| Surface | Claude | Devin | Implication |
|---|---|---|---|
| Harness dir | `.claude` | `.devin` | `harnessDir: ".devin"` |
| Skills | `.claude/skills/<n>/SKILL.md` | `.devin/skills/<n>/SKILL.md` (same frontmatter) | Same SKILL.md works |
| Agents | `.claude/agents/*.md` | `.devin/agents/*.md` (Claude-compatible; `tools` or `allowed-tools`) | Core `agents/` projects directly |
| Hooks file | `settings.json` `hooks` key | `.devin/hooks.v1.json` (**whole file = hooks object**) | Authored harnessFile |
| Hook env var | `$CLAUDE_PROJECT_DIR` | `$DEVIN_PROJECT_DIR` | Adapter/wiring change |
| Tool names | `Bash`, `Edit`, `Write`, `Read`, `Task`, `Agent` | `exec`, `edit`, `write`, `read`, `run_subagent` | **Adapter required** (core hooks hardcode Claude names — confirmed in `aidlc-reviewer-scope.ts`, `aidlc-plan-approval-guard.ts`, `aidlc-state-transition-guard.ts`, `aidlc-write-audit-log.ts`, `aidlc-continue-workflow.ts`) |
| Hook events | `PreCompact`, `SubagentStop`, `TaskUpdate` | `PostCompaction`, (no `SubagentStop`), (no `TaskUpdate`; `todo_write` PostToolUse available) | Event mapping + 2 gaps to remap |
| Onboarding/rules | `CLAUDE.md` | `AGENTS.md` (+ `.devin/rules/*.md` auto-loaded) | `onboarding.dst: "AGENTS.md"`, projectRoot |
| Project config | `settings.json` (model, env, effort, permissions, statusLine, companyAnnouncements) | `.devin/config.json` (**project-level only `permissions`, `read_config_from`, `hooks`**; model/env/effort are user-only) | No statusLine, no companyAnnouncements, no env/model in project config |
| MCP | `.mcp.json` (root) | `.devin/mcp_config.json` | Different file/location |
| Plugins | `.claude-plugin/` | `.devin-plugin/plugin.json` | Manifest `plugin` default already yields `.devin-plugin` + `kind:"store"` — **no config needed** |
| Method ambient import | the Claude `@`-import rules chain | `.devin/rules/*.md` **auto-loaded** (no `@`-import in AGENTS.md — confirmed via Devin rules docs) | Ship a short auto-loaded pointer; correctness doesn't depend on it |

## Decisions (confirmed with user)

1. **Tier flavor**: Add a `devin` flavor to `core/tools/aidlc-tiers.ts`
   (`{ model: null }` — inherit-by-omission, like `copilot`/`cursor`, since
   Devin agent `.md` has `model:` but no `effort:`) + add `"devin"` to the
   `tierFlavor` union in `scripts/manifest-types.ts`. This is a data row in
   the designated per-harness extension point (`aidlc-tiers.ts` header:
   "Projection targets… Tune here; every harness moves in lock-step"), not a
   violation of the "zero core edits" rule (which is about
   engine/methodology/rules-resolution).
2. **Method ambient context**: Ship `.devin/rules/aidlc.md` as a short
   pointer to the method tree. Devin auto-loads every `.devin/rules/*.md`
   file as an always-on rule — no `@`-import directive needed (Devin docs
   confirm no `@`-import in AGENTS.md). AIDLC's stage resolver reads
   `aidlc/spaces/default/memory/` directly, so stage correctness is
   unaffected; the rule provides ambient awareness and respects Devin's
   "keep rules small" guidance.
3. **Doctor arm**: Yes — add a `devin` arm to `/aidlc --doctor` in
   `core/tools/aidlc-utility.ts` (the sanctioned per-harness core exception).

## Statusline gap (explored, recommendation: leave unregistered)

`aidlc-statusline.ts` (370-line core hook) renders a live workflow-position
readout into the CLI's persistent status strip. Claude wires it via
`statusLine` in `settings.json`. Devin has **no `statusLine`/`status_bar`
config field** (verified by grepping all Devin docs — only unrelated
`devin mcp get` and `/handoff` hits).

Explored injecting the status readout as `additionalContext` via
`UserPromptSubmit`/`Stop` hooks. **Recommendation: do NOT do this.** It's a
category mismatch:
- `additionalContext` targets the **model's context window**, not a
  human-visible terminal strip — the primary goal (human sees position
  without running a command) isn't achieved.
- It pollutes the model's context with non-instructional display lines every
  turn (token-priced, persistent), whereas the statusline is cheap/ephemeral.
- It risks model confusion — a raw status readout has no imperative framing,
  colliding with the engine-owned routing the session-start hook
  establishes.
- `Stop` is worse: non-blocking stdout is ignored; blocking just to display
  status would loop the agent.

**Decision**: leave `aidlc-statusline.ts` unregistered on Devin, document
the gap, point users to `/aidlc --status` (prints the same
phase/stage/progress/cost on demand). This follows the porting guide's
"document the gap rather than wire dead hooks" rule. The hook file still
ships (core projection, byte-shared) — just isn't wired in `hooks.v1.json`.

## Step-by-step plan

### Step 1 — Core tier-flavor addition (the one core data edit)
- `core/tools/aidlc-tiers.ts`: add `devin: { model: null }` to `TierProjection`
  (all tiers inherit — mirrors `copilot`/`cursor`); add `devin` to the
  `Harness` type union.
- `scripts/manifest-types.ts`: add `"devin"` to the `tierFlavor` union
  (`"claude" | "codex" | "kiro" | "opencode" | "copilot" | "cursor" | "devin"`).
- No logic — pure data row.

### Step 2 — `harness/devin/manifest.ts`
- `name: "devin"`, `harnessDir: ".devin"`, `tierFlavor: "devin"`.
- `coreDirs`: same as Claude (`tools`, `aidlc-common`, `knowledge`, `sensors`,
  `scopes`, `agents`, `hooks`, + the 4 session skills:
  `skills/aidlc-session-cost`, `skills/aidlc-replay`,
  `skills/aidlc-outcomes-pack`, `skills/aidlc-knowledge`). No `rulesRename`.
- `harnessFiles`:
  - `hooks/aidlc-devin-adapter.ts` → `.devin/hooks/aidlc-devin-adapter.ts`
  - `hooks.v1.json` → `.devin/hooks.v1.json`
  - `config.json` → `.devin/config.json`
  - `mcp_config.json` → `.devin/mcp_config.json`
  - `rules-aidlc.md` → `.devin/rules/aidlc.md`
  - `skills/aidlc/SKILL.md` → `.devin/skills/aidlc/SKILL.md`
  - `skills/aidlc/question-rendering.md` → `.devin/skills/aidlc/question-rendering.md`
  - `dot-gitignore` → `.gitignore` (projectRoot)
- `onboarding: { dst: "AGENTS.md", projectRoot: true, fills }`.
- `emit: null` (all surfaces are authored files — no structural divergence
  needing an emitter).
- `plugin` omitted → default derives `.devin-plugin` + `kind:"store"`
  (matches Devin's plugin format exactly).

### Step 3 — `harness/devin/hooks/aidlc-devin-adapter.ts` (the shim)
Modeled on `aidlc-codex-adapter.ts`. Reads Devin stdin JSON and:
- Maps `tool_name`: `exec`→`Bash`, `edit`→`Edit`, `write`→`Write`,
  `read`→`Read`, `run_subagent`→`Task`, `todo_write`→`TaskUpdate`,
  `notebook_edit`→`NotebookEdit`, `notebook_read`→`NotebookRead`,
  `glob`→`Glob`, `grep`→`Grep`, etc.
- Re-wraps `additionalContext` into `hookSpecificOutput` where Devin expects
  it (SessionStart/UserPromptSubmit).
- Forwards `{"decision":"block"}` (Stop) and exit-2 (PreToolUse guards)
  verbatim.
- Subprocess-pipes to the named core hook under `.devin/hooks/`.
- Uses `$DEVIN_PROJECT_DIR` for path resolution.

### Step 4 — `harness/devin/hooks.v1.json` (the wiring)
Authored harnessFile. Registers Devin events → adapter → core hooks, with
Devin-native matchers. Maps Claude's 8 hook registrations onto Devin's
event set:
- `SessionStart` → adapter `session-start` (also delivers the welcome
  message via `additionalContext`, replacing Claude's `companyAnnouncements`).
- `SessionEnd` → adapter `session-end`.
- `UserPromptSubmit` → adapter `record-human-turn`.
- `PreToolUse` (matcher `exec|edit|write|read|run_subagent|...`) → adapter
  targets: `state-transition-guard`, `reviewer-scope`, `review-freeze`,
  `plan-approval-guard`, `deliver-stage-rules`, `fold-usage`.
- `PostToolUse` (matcher `edit|write`) → `audit-and-sensors`
  (write-audit-log + run-sensors).
- `PostToolUse` (matcher `todo_write`) → `sync-workflow-state` (adapter
  maps to TaskUpdate shape, like Codex maps `update_plan`).
- `PostToolUse` (matcher `run_subagent`) → `log-subagent` (replaces the
  absent `SubagentStop` event).
- `PostToolUse` (matcher `exec`) → `rebuild-stage-graph`.
- `PostToolUse` (matcher `""`) → `fold-usage`.
- `PostCompaction` → `validate-state` (replaces Claude's `PreCompact`).
- `Stop` → `continue-workflow`.
- Commands use `$DEVIN_PROJECT_DIR/.devin/hooks/aidlc-devin-adapter.ts <target>`.
- Documents the no-statusline gap (statusline hook ships but is unwired).

### Step 5 — `harness/devin/skills/aidlc/SKILL.md` (+ `question-rendering.md`)
Near-copy of Claude's orchestrator SKILL.md with `{{HARNESS_DIR}}`→`.devin`
and Devin-specific references:
- Welcome via SessionStart `additionalContext` (not `companyAnnouncements`).
- `AGENTS.md` instead of `CLAUDE.md`.
- `hooks.v1.json` instead of `settings.json`.
- `/aidlc --status` as the statusline substitute.

### Step 6 — `harness/devin/{config.json, mcp_config.json, rules-aidlc.md, dot-gitignore}`
- `config.json`: `permissions` (Devin syntax: `Read(**)`, `Exec(...)`, etc.)
  + `read_config_from`. No model/env/effort (user-level on Devin).
- `mcp_config.json`: the 5 MCP servers Claude ships (context7, aws-mcp,
  aws-pricing, aws-iac, aws-serverless), adapted to Devin's
  `mcp_config.json` schema (`{ "mcpServers": { ... } }`).
- `rules-aidlc.md`: short auto-loaded pointer to
  `aidlc/spaces/default/memory/` (Devin loads `.devin/rules/*.md`
  automatically; no `@`-import).
- `dot-gitignore`: ignores `.devin/config.local.json`,
  `.devin/mcp_config.local.json`, `AGENTS.local.md`.

### Step 7 — `harness/devin/onboarding.fills.ts`
Devin-specific fills for `core/templates/onboarding.md` slots:
- `invoke: "/aidlc"`.
- `title_block`: `@`-import-free orientation (Devin auto-loads
  `.devin/rules/aidlc.md`); project name placeholder; command list.
- `prereq_bullets`: `bun` prereq (same as Claude); **no Bedrock-env-in-
  project-config** — model/env are user-level, guide users to
  `~/.config/devin/config.json`; MCP via `.devin/mcp_config.json`.
- `prereq_bullets_tail`: settings note (`.devin/config.json` pre-approves
  tools); personal overrides via `.devin/config.local.json`.
- `hook_permissions_note`: approve hooks via `/hooks` then fully restart
  Devin CLI.
- `agents_note`: same as Claude (flat `.md` files, `aidlc-<role>-agent.md`).
- `structure_extra`: note the statusline gap + `/aidlc --status`
  workaround.
- `gitignore_extra`: `.devin/config.local.json`,
  `.devin/mcp_config.local.json`, `AGENTS.local.md`.

### Step 8 — `devin` `--doctor` arm (sanctioned core edit)
Add an `else if (harness === ".devin")` branch to
`core/tools/aidlc-utility.ts` (after the existing `.claude`/`.kiro`/`.codex`/
`.aidlc`/`.cursor` branches, ~line 2470), modeled on the kiro/codex pattern:
- Probe the explicit hook roster (the 7 core hooks + `aidlc-devin-adapter`)
  for presence in `.devin/hooks/`.
- Check `.devin/hooks.v1.json` present (the wiring config, like codex's
  `hooks.json`).
- Check `.devin/config.json` present (permissions).
- Check `devin` CLI binary version floor (like codex/copilot do via
  `Bun.spawnSync(["devin", "--version"])` + `Bun.which("devin")` guard for
  missing-binary advisory).
- Degrades gracefully for other harnesses (no `devin` arm → generic checks).

### Step 9 — Tests + gate
- `t145` packaging-parity covers `devin` automatically once the manifest
  exists.
- A `devin` hook-adapter contract test: pipe captured Devin payloads
  through the adapter, assert the observable core-hook effect (model on
  `tests/fixtures/...-hook-payloads/` pattern, e.g.
  `tests/fixtures/kiro-hook-payloads/payloads.json`).
- Live e2e journey gated on `AIDLC_DEVIN_LIVE=1` env + `devin` binary
  present + authenticated (skips cleanly in the deterministic tier).
- Run `bun scripts/package.ts devin` to regenerate,
  `bun scripts/package.ts --check` to drift-guard, and
  `bash tests/run-tests.sh --smoke --unit --integration -P 8` plus the live
  journey to gate.

### Step 10 — Docs + changelog
- Add a user-facing chapter under `docs/guide/harnesses/` for Devin (model
  on the existing harness chapters).
- Update `docs/harness-engineering/09-porting-to-a-new-harness.md` harness
  list (add `devin/` to the shape diagram + prose enumeration).
- Update `AGENTS.md` and `README.md` harness enumerations (per the
  Documentation Policy).
- Bump `core/tools/aidlc-version.ts` (the authored source), the README
  badge, and add a `## [X.Y.Z] - YYYY-MM-DD` heading + bullet(s) to
  `CHANGELOG.md` (per the Changelog Policy). The pin in
  `tests/unit/t68-version-changelog-sync.test.ts` enforces agreement.

## Step verification gates (binding)

Each step closes with `Worker scope` (the files the worker may touch), `Done when` (observable completion), `Verify` (command the worker runs), `Reviewer check` (what the reviewer independently confirms), and `Do not` (prohibited changes). The orchestrator pastes the row verbatim into both the worker and reviewer prompts (reviewer gets `Done when` / `Reviewer check` / `Do not` + the diff, not the `Worker scope`).

| Step | Worker scope | Done when | Verify | Reviewer check | Do not |
|---|---|---|---|---|---|
| 1 — tier flavor | `core/tools/aidlc-tiers.ts`, `scripts/manifest-types.ts` | `aidlc-tiers.ts` has `devin` row + `Harness` member; `manifest-types.ts` `tierFlavor` includes `"devin"` | `bunx tsc --noEmit` | Diff is data-only (no logic); `devin` row mirrors `copilot`/`cursor` `{model:null}`; union member added exactly once | Add logic; touch any other file |
| 2 — manifest | `harness/devin/manifest.ts` | manifest exists, type-checks; `bun scripts/package.ts devin` produces `dist/devin/` | `bun scripts/package.ts devin && bun scripts/package.ts --check` | `emit: null`; `harnessDir: ".devin"`; `coreDirs` matches Claude set; `onboarding.dst: "AGENTS.md"`; `dist/devin/` is generated not hand-edited | Hand-edit `dist/devin/`; add an `emit` |
| 3 — adapter | `harness/devin/hooks/aidlc-devin-adapter.ts` | adapter maps all tool names listed in Step 3; subprocess-pipes to core hooks; uses `$DEVIN_PROJECT_DIR` | `bunx tsc --noEmit` | Every tool-name map from Step 3 is present; no Claude tool name hardcoded in core hooks; adapter is a shim (no core-hook logic duplicated) | Hardcode Claude names in core hooks; duplicate core-hook logic |
| 4 — hooks wiring | `harness/devin/hooks.v1.json` | all 8 mappings from Step 4 registered; statusline hook ships but unwired | `bun scripts/package.ts --check` + `jq .` parses | All 8 adapter→core-hook mappings present; `aidlc-statusline.ts` NOT wired; no `additionalContext` status injection | Wire `aidlc-statusline.ts`; inject status via `additionalContext` |
| 5 — SKILL.md | `harness/devin/skills/aidlc/SKILL.md`, `harness/devin/skills/aidlc/question-rendering.md` | both files exist with `{{HARNESS_DIR}}`→`.devin` and Devin refs | `bun scripts/package.ts --check` (byte-parity) | No `companyAnnouncements`/`CLAUDE.md` references remain; `hooks.v1.json` referenced not `settings.json`; `/aidlc --status` documented | Copy Claude's `companyAnnouncements`/`CLAUDE.md` refs verbatim |
| 6 — config/mcp/rules/gitignore | `harness/devin/config.json`, `harness/devin/mcp_config.json`, `harness/devin/rules-aidlc.md`, `harness/devin/dot-gitignore` | all 4 present and valid JSON/MD | `jq . config.json && jq . mcp_config.json` | `config.json` has no model/env/effort; `mcp_config.json` has all 5 servers; `rules-aidlc.md` has no `@`-import; gitignore lists the 3 local files | Put model/env/effort in project `config.json` |
| 7 — onboarding fills | `harness/devin/onboarding.fills.ts` | fills exist; `dist/devin/AGENTS.md` renders with Devin fills | `bun scripts/package.ts devin && bun scripts/package.ts --check` | No `@`-import directives in rendered AGENTS.md; statusline gap + `/aidlc --status` noted; all fill slots from Step 7 populated | Add `@`-import directives to AGENTS.md |
| 8 — doctor arm | `core/tools/aidlc-utility.ts` | `else if (harness === ".devin")` branch present; `/aidlc --doctor` runs the devin arm | `bunx tsc --noEmit` + run `--doctor` | Branch probes the 7 core hooks + adapter; checks `hooks.v1.json` + `config.json`; degrades to advisory when `devin` binary absent; no `dist/` doctor copy edited | Edit `dist/` doctor copies; fail hard on missing binary |
| 9 — tests + gate | `tests/.../t<NNN>-devin-adapter-contract.test.ts`, `tests/fixtures/devin-hook-payloads/payloads.json`, `tests/e2e/t-...-devin-journey.serial.test.ts` | `t145` passes for `devin`; contract test passes; live journey skips cleanly without `AIDLC_DEVIN_LIVE=1` | `bash tests/run-tests.sh --smoke --unit --integration -P 8` | Contract test pipes captured payloads through adapter and asserts observable effect; live journey gated on env+binary+auth; deterministic tier does not require the binary | Gate deterministic tier on live binary; commit a red test |
| 10 — docs + changelog | `docs/guide/harnesses/devin.md`, `docs/harness-engineering/09-porting-to-a-new-harness.md`, `AGENTS.md`, `README.md`, `core/tools/aidlc-version.ts`, `CHANGELOG.md` | devin chapter exists; `AGENTS.md`/`README.md`/porting doc list `devin`; version + badge + CHANGELOG heading agree | `bun test tests/unit/t68-version-changelog-sync.test.ts` + grep `docs/` and `README.md` for stale harness lists | `t68` green; no stale harness enumeration in `docs/` or `README.md`; CHANGELOG entry has summary + flat bullet list; no `[N.N.N]:` link reference | Bump version without a CHANGELOG entry; add a `[N.N.N]:` link reference |

## Documented gaps (Devin has no surface for these)

- **Custom statusline** (`aidlc-statusline.ts` unwirable — no
  `statusLine`/`status_bar` config field). Workaround: `/aidlc --status`.
  Explored `additionalContext` injection; rejected as a category mismatch
  (targets model context, not human-visible strip; pollutes context; risks
  model confusion).
- **`SubagentStop` event** — remapped to `PostToolUse` on `run_subagent`.
- **`TaskUpdate` event** — remapped to `PostToolUse` on `todo_write`
  (adapter maps to TaskUpdate shape).
- **`companyAnnouncements`** — replaced by SessionStart `additionalContext`.
- **Project-level model/env/effort** — moved to user config
  (`~/.config/devin/config.json`) + onboarding guidance.

## Files touched

**New (authored harness surface)**:
- `harness/devin/manifest.ts`
- `harness/devin/onboarding.fills.ts`
- `harness/devin/hooks/aidlc-devin-adapter.ts`
- `harness/devin/hooks.v1.json`
- `harness/devin/config.json`
- `harness/devin/mcp_config.json`
- `harness/devin/rules-aidlc.md`
- `harness/devin/dot-gitignore`
- `harness/devin/skills/aidlc/SKILL.md`
- `harness/devin/skills/aidlc/question-rendering.md`
- `tests/.../t<NNN>-devin-adapter-contract.test.ts` (new contract test)
- `tests/fixtures/devin-hook-payloads/payloads.json` (new fixture)
- `tests/e2e/t-...-devin-journey.serial.test.ts` (new live journey, gated)
- `docs/guide/harnesses/devin.md` (new user-facing chapter)

**Edited (core — the two sanctioned touches)**:
- `core/tools/aidlc-tiers.ts` (add `devin` projection + `Harness` union member)
- `scripts/manifest-types.ts` (add `"devin"` to `tierFlavor` union)
- `core/tools/aidlc-utility.ts` (add `devin` `--doctor` arm)

**Edited (docs/policy)**:
- `docs/harness-engineering/09-porting-to-a-new-harness.md` (harness list)
- `AGENTS.md` (harness enumeration)
- `README.md` (harness enumeration + badge)
- `core/tools/aidlc-version.ts` (version bump)
- `CHANGELOG.md` (new entry)

**Generated (committed, drift-guarded)**:
- `dist/devin/` (whole tree — regenerated by `bun scripts/package.ts devin`)

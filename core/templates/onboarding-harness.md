{{SLOT:frontmatter}}
{{SLOT:title_block}}

## Prerequisites

{{SLOT:prereq_bullets}}
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 17 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
{{SLOT:hook_permissions_note}}
{{SLOT:prereq_bullets_tail}}

## AI-DLC Structure

- **Skill**: `{{HARNESS_DIR}}/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and the stage files across the phase directories (the enabled set depends on the composed plugins: see the compiled `{{HARNESS_DIR}}/tools/data/stage-graph.json` or run `{{INVOKE}} --doctor`)
- **Document skill** (user-invocable): `{{HARNESS_DIR}}/skills/aidlc-knowledge/`, typed as `{{SKILL_INVOKE}}-knowledge`; the framework CLI also exposes `{{INVOKE}} engine knowledge <verb>`. Also standalone — outside the lifecycle graph — but classified `read-write`, unlike the read-only session skills below: it changes the document catalog and emits document audit events. It never advances the workflow stage pointer and never approves a gate. See "Document knowledge" under "Where things live" in the project's root `AGENTS.md` (Claude Code and Copilot readers find it under "Shared AI-DLC onboarding" in this file).
- **Session skills** (read-only, user-invocable): `{{HARNESS_DIR}}/skills/aidlc-session-cost/`, `{{HARNESS_DIR}}/skills/aidlc-replay/`, `{{HARNESS_DIR}}/skills/aidlc-outcomes-pack/` — typed as `{{SKILL_INVOKE}}-session-cost`, `{{SKILL_INVOKE}}-replay`, `{{SKILL_INVOKE}}-outcomes-pack`. Each pulls every count from `{{INVOKE}} engine runtime summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `{{HARNESS_DIR}}/skills/aidlc-<stage>/`: one per runnable core stage, typed as `{{SKILL_INVOKE}}-<stage>` (e.g. `{{SKILL_INVOKE}}-domain-design`, `{{SKILL_INVOKE}}-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`**: `next --single` records only the synthetic start boundary and `report --single` closes that same attempt. They are opt-in packaging: the same stage is reachable via `{{SKILL_INVOKE}} --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `{{INVOKE}} engine gen runners` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `{{SKILL_INVOKE}}-init`: with `--scope <name>` it creates the workflow record and its starting state in one step, and with only a description it first shows the same plan offer as describing the work. (This is opt-in packaging: describing what to build normally sets up the first piece of work by itself; no separate initialization command is needed.)
- **Agents**: `{{HARNESS_DIR}}/agents/` — the base framework ships 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. A plugin install may add more; the enabled set is discovered from the files present under that directory. {{SLOT:agents_note}}
- **Sensors**: `{{HARNESS_DIR}}/sensors/`: automatic checks that run on matching writes or once per existing deliverable at the approval gate. Gate-fired sensors may be advisory or blocking; blocking failures require an explicit audited override before the gate opens. Ships with framework defaults (`aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-traceability.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time.
- **Knowledge**: `{{HARNESS_DIR}}/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Tools**: `{{HARNESS_DIR}}/tools/`: small command-line programs (TypeScript, run via bun) that do the parts which must be exact rather than judged: tracking where the workflow is, writing the decision log, deciding what runs next (`aidlc-orchestrate.ts`, with exactly six subcommands: `next`, `continue`, `report`, `park`, `team-board`, and `wait`; `continue` is internal steering transport and `team-board` is the read-only Team Construction query, and `wait` is the bounded read-only wait for dispatched work), running the automatic checks, recording what the team learned (`aidlc-learnings.ts`), and refereeing parallel Construction work (`aidlc-swarm.ts`). All framework files prefixed `aidlc-*.ts`.
- **Hooks**: `{{HARNESS_DIR}}/hooks/`: scripts your CLI runs automatically at set moments, so the decision log, saved progress, and status display stay correct without anyone remembering to update them. All framework files prefixed `aidlc-*.ts`.

## Plugins

AI-DLC is open-world. Plugins under `plugins/<name>/` contribute additional stages, scopes, and agents, and `select-plugins` chooses which are enabled in this install. The counts above describe the base framework; your enabled set may differ. The compiled `{{HARNESS_DIR}}/tools/data/stage-graph.json` and `{{INVOKE}} --doctor` are the authoritative live view of what is enabled here.

## Guards

The guards are the person's checks. When the person asks in their own words to turn one of their checks off or back on, or to change the Guard Policy ("turn the review freeze check off for this project", "stop asking me to re-approve when files change", "relax the change checks", "turn it back on"), do it for them in the same turn and say the line the command prints, word for word, in your reply in that same turn, before any question, picker or next step (the command's output alone does not reach them): never refuse, never ask them to type it, and never investigate first. Asking for the guards or the checks as a whole to be off ("turn the guards off") is Guard Policy `off`, even when the same message also names one check. "Stop asking me to re-approve when files change" is Guard Policy `relaxed`, not one check; when Guard Policy is already `off`, say in one line that it is already off and change nothing. Turning a check on, or Guard Policy `strict`, is always fine; turning one off, or Guard Policy `relaxed` or `off`, happens only when they ask, never on your own and never as a suggestion. Where it applies is what they say: this piece of work, this project, or this machine. When they say neither, use this piece of work while one is open, otherwise this project; the line names where it applied, and say in one sentence how to widen it. For this piece of work run `{{INVOKE}} engine config set <key> <on|off>` with the key from the table. For this project run `{{INVOKE}} config flags --bypass <switch> --local --yes` (`--global` for this machine). To turn it back on, `{{INVOKE}} config flags --clear-bypass <switch> --yes` clears it everywhere it is recorded, so the check is really on; when they name a place, add `--local` or `--global` to clear only there. A `none` in the table means that place has no switch for the check: when they named no place, use the place it has; when they named a place it does not have, say in one sentence that it cannot be set there and offer the other place, and change it only when they agree. Guard Policy is set for a piece of work only; with none open, say so in one line. For Guard Policy run `{{INVOKE}} engine config set guard-policy <strict|relaxed|off>`; when the team holds Guard Policy strict in memory, it refuses with one line naming the file, and you say that line. A typed `{{SKILL_INVOKE}} --guard-policy off` or `{{SKILL_INVOKE}} config set guard.<fence> off` was applied when the message arrived. Never edit `aidlc-state.md` or run a hook to change a guard. `{{SKILL_INVOKE}} --status` shows the current Guard Policy and every fence with where its setting came from.

| Check | This piece of work: key | This project or machine: switch |
|---|---|---|
| plan approval | `plan-approval` | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD` |
| review freeze | `guard.review-freeze` | `AIDLC_DISABLE_REVIEW_FREEZE_HOOK` |
| reviewer read scope | `guard.reviewer-scope` | `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK` |
| state transition | `guard.state-transition` | none |
| summary confirmation | `summary-confirmation` | `AIDLC_DISABLE_SUMMARY_CONFIRMATION` |
| summary confirmation check | none | `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD` |
| human presence | none | `AIDLC_SKIP_HUMAN_PRESENCE_GUARD` |
| stage output | none | `AIDLC_SKIP_ARTIFACT_GUARD` |
| revision backstop | none | `AIDLC_SKIP_REVISION_BACKSTOP` |
| pipeline handoff | none | `AIDLC_DISABLE_ENSEMBLE_EVIDENCE` |

## Models and effort

When someone asks in plain words to change an agent's model or effort ("make the developer agent think harder"), run `{{INVOKE}} config models --agent <name> --effort <low|medium|high|xhigh|max> --project --yes`. For a model, use `--model <id>` in place of `--effort`, or both when they ask for both. Use `--local` instead of `--project` when it is only for them. If it asks for `--harness`, run it again naming this tool's harness. Print its output and stop. Never edit the `aidlc-*-agent` files for this.

{{SLOT:structure_extra}}

{{SLOT:sections_before_resumption}}
{{SLOT:sections_after_resumption}}

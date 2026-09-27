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
- **Stage-runner skills** (user-invocable): `{{HARNESS_DIR}}/skills/aidlc-<stage>/` — one per runnable core stage, typed as `{{SKILL_INVOKE}}-<stage>` (e.g. `{{SKILL_INVOKE}}-domain-design`, `{{SKILL_INVOKE}}-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — `next --single` records only the synthetic start boundary and `report --single` closes that same attempt. They are opt-in packaging: the same stage is reachable via `{{SKILL_INVOKE}} --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `{{INVOKE}} engine gen runners` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `{{SKILL_INVOKE}}-init`, which creates the first workflow record and its starting state in one step. (This is opt-in packaging: describing what to build normally sets up the first piece of work by itself — no separate initialization command is needed.)
- **Agents**: `{{HARNESS_DIR}}/agents/` — the base framework ships 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. A plugin install may add more; the enabled set is discovered from the files present under that directory. {{SLOT:agents_note}}
- **Sensors**: `{{HARNESS_DIR}}/sensors/`: automatic checks that run on matching writes or once per existing deliverable at the approval gate. Gate-fired sensors may be advisory or blocking; blocking failures require an explicit audited override before the gate opens. Ships with framework defaults (`aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-traceability.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time.
- **Knowledge**: `{{HARNESS_DIR}}/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Tools**: `{{HARNESS_DIR}}/tools/`: small command-line programs (TypeScript, run via bun) that do the parts which must be exact rather than judged: tracking where the workflow is, writing the decision log, deciding what runs next (`aidlc-orchestrate.ts`, with exactly six subcommands: `next`, `continue`, `report`, `park`, `team-board`, and `wait`; `continue` is internal steering transport and `team-board` is the read-only Team Construction query, and `wait` is the bounded read-only wait for dispatched work), running the automatic checks, recording what the team learned (`aidlc-learnings.ts`), and refereeing parallel Construction work (`aidlc-swarm.ts`). All framework files prefixed `aidlc-*.ts`.
- **Hooks**: `{{HARNESS_DIR}}/hooks/`: scripts your CLI runs automatically at set moments, so the decision log, saved progress, and status display stay correct without anyone remembering to update them. All framework files prefixed `aidlc-*.ts`.

## Plugins

AI-DLC is open-world. Plugins under `plugins/<name>/` contribute additional stages, scopes, and agents, and `select-plugins` chooses which are enabled in this install. The counts above describe the base framework; your enabled set may differ. The compiled `{{HARNESS_DIR}}/tools/data/stage-graph.json` and `{{INVOKE}} --doctor` are the authoritative live view of what is enabled here.

## Guards

The guards are the person's switches, never the agent's. When someone asks in plain words to relax or turn off the guards ("stop asking me to re-approve when files change", "turn the guards off"), do not investigate: run no command, read no file, search nothing. Answer in one or two sentences naming the exact command for them to type, `{{SKILL_INVOKE}} --guard-policy relaxed` or `{{SKILL_INVOKE}} --guard-policy off` (one fence: `{{SKILL_INVOKE}} config set guard.<fence> off`), and end the turn; when they type it, the harness applies it as the prompt arrives and records it. A plain-words request to make the guards strict runs `{{INVOKE}} engine config set guard-policy strict` at once; print its output and stop. Never edit `aidlc-state.md`, run a hook, or run a setter to lower a guard on your own initiative. `{{SKILL_INVOKE}} --status` shows the current Guard Policy and every fence with where its setting came from.

{{SLOT:structure_extra}}

{{SLOT:sections_before_resumption}}
{{SLOT:sections_after_resumption}}

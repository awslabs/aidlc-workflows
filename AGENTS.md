# AI-DLC — one core, many harnesses

This directory contains a native implementation of the AI-DLC (AI-Driven
Development Life Cycle) methodology that ships to many CLI harnesses — today
Claude Code, Kiro CLI, Kiro IDE, and Codex CLI, and any capable CLI you port it to — from
a single hand-authored source.

## Project Structure

- `core/` — **The hand-authored, harness-neutral source of truth.** Tools, stages (`aidlc-common/`), agents, memory (the rule/method layer), scopes, sensors, knowledge, hooks, and the 3 session skills. Prose names the harness directory with the `{{HARNESS_DIR}}` token; the packager substitutes `.claude`/`.kiro`/`.codex` per tree.
- `harness/<name>/` — **The thin per-harness authored surface.** Each holds `manifest.ts` (how to project `core/` into that harness's dist) plus the orchestrator skill and harness-specific files; `harness/codex/` adds `emit.ts` (Codex-only emissions). `claude/`, `kiro/`, `kiro-ide/`, `codex/`.
- `plugins/<name>/` — **Optional, owned AIDLC plugins** (the plugin mechanism; design in the single chapter `docs/reference/18-plugin-mechanism.md`, authoring guide `docs/harness-engineering/10-authoring-a-plugin.md`). Each holds `.aidlc-plugin/plugin.json` (the declarative manifest) + core-shaped subtrees (`stages/`, `contributions/`, `sensors/`, `tools/`, …) + `tests/`. `bun scripts/package.ts` emits a real host plugin per harness at `dist/plugins/<name>/{claude,codex,kiro,kiro-ide}/`; a compose hook merges the plugin into an install (new stages + the additive contribution seam). `plugins/test-pro/` is the reference fixture. Guarded by `tests/integration/t188-plugin-compose.test.ts` (mechanism) + `plugins/test-pro/tests/` (content, wired into the integration tier).
- `scripts/package.ts` — **The build entry.** `bun scripts/package.ts` regenerates every `dist/<harness>/`; `bun scripts/package.ts --check` is the byte-parity drift guard (CI tier). `manifest-types.ts` is the shared manifest contract.
- `dist/<harness>/` — **GENERATED, committed, drift-guarded.** `dist/claude/.claude/`, `dist/kiro/.kiro/` (+ `AGENTS.md`), `dist/kiro-ide/.kiro/` (+ `AGENTS.md`), `dist/codex/` (`.codex/` + `.agents/` + `AGENTS.md`). Never hand-edit — `package.ts --check` fails CI on drift. Users copy `dist/<harness>/` into their project.
- `tests/` — All-TypeScript test suite (`t*.test.ts`, run via bun), four levels (smoke/unit/integration/e2e). Run `bash tests/run-tests.sh --help` for levels and profiles.
- `docs/guide/` — User Guide: getting started, workflows, scopes, agents, customization, troubleshooting
- `docs/harness-engineering/` — Harness Engineer Guide: reshaping AIDLC through configuration (stages, agents, scopes, rules, sensors, knowledge) without code, plus porting AIDLC to a new harness
- `docs/reference/` — Developer Reference: architecture, orchestrator, stage protocol, hooks, testing, contributing

## How It Works

The hand-authored source lives in `core/` (harness-neutral) + `harness/<name>/`
(per-CLI surfaces); `bun scripts/package.ts` regenerates the `dist/<harness>/`
trees. The core uses the same building blocks in every harness:

- **Skills** (`skills/aidlc/`) — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phases (initialization, ideation, inception, construction, operation)
- **Agents** (`agents/`) — 14 `aidlc-<role>-agent.md` files: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer (aidlc-composer-agent)
- **Method/rules** (`memory/`) — Layered config in the space memory layer: `org.md` (framework defaults), `team.md` (affirmed practices), `project.md` (project overrides), and `phases/<phase>.md` for ideation/inception/construction/operation
- **Sensors** (`sensors/`) — Deterministic verification manifests (advisory): `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`
- **Knowledge** (`knowledge/`) — Methodology reference. Per-agent under `aidlc-<agent>-agent/`; cross-agent material in `aidlc-shared/`
- **Tools** (`tools/`) — TypeScript CLI tools, all prefixed `aidlc-*.ts` and run via bun
- **Hooks** (`hooks/`) — 12 framework hooks, all prefixed `aidlc-*.ts`, covering audit emission, sensor dispatch, runtime-graph compile, session lifecycle, state validation, subagent tracking, statusline rendering, human-presence mint on prompt submit, forwarding-loop enforcement (the `Stop` hook — the first flow-altering hook), and reviewer read-scope enforcement (the PreToolUse reviewer-scope hook — the second)

## Working on This Project

- **Edit `core/` (or `harness/<name>/`), never `dist/`.** `dist/<harness>/` is generated. After editing, run `bun scripts/package.ts` to regenerate and `bun scripts/package.ts --check` to confirm no drift (the CI guard fails on a hand-edited or stale dist).
- The orchestrator skill (`harness/<name>/skills/aidlc/SKILL.md`) is per-harness; the engine and methodology live in `core/`.
- `harness/claude/CLAUDE.md` is the user-facing CLAUDE.md that ships in `dist/claude/` — it is NOT this file. Edit it when changing user-facing Claude behavior (commands, prerequisites, conventions); the Kiro/Codex equivalents are each harness's `AGENTS.md` (codex's is emitted from CLAUDE.md by `harness/codex/emit.ts`).
- "harness" has three senses in this repo: `harness/` (top-level, the per-CLI distribution surfaces — this effort), `docs/harness-engineering/` (the Harness Engineer Guide), and `tests/harness/` (test-suite helper library) — unrelated.
- See `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference) for full documentation

## Test Suite

Run `bash tests/run-tests.sh --help` for levels and flags. See `docs/reference/09-testing.md` for full strategy.

## Utility Handler Checklist

See `docs/reference/11-contributing.md` § "Adding a Utility Handler" before implementing a new `/aidlc --*` command.

## Documentation Policy

IMPORTANT: When adding, removing, or renaming files, directories, commands, or flags — grep `docs/` and `README.md` for stale references and update them in the same commit.

## Changelog Policy

IMPORTANT: Every user-visible PR bumps `core/tools/aidlc-version.ts` (the authored source; the per-harness `dist/<harness>/.../tools/aidlc-version.ts` copies are regenerated by `bun scripts/package.ts`), bumps the README badge, and adds a matching `## [X.Y.Z] - YYYY-MM-DD` heading + bullet(s) to `CHANGELOG.md` in the same commit. Patch versions accumulate through a release-prep cycle; the eventual minor cut (e.g. `v0.7.0`) consolidates them. Pure doc sweeps, internal refactors, and test-only changes do NOT bump — those live in commit messages and the design notes under `docs/`. The pin in `tests/unit/t68-version-changelog-sync.test.ts` enforces that the shipped `aidlc-version.ts`, the latest `CHANGELOG.md` heading, and the README badge agree.

Each entry follows the shape: `## [N.N.N] - YYYY-MM-DD` heading, one-paragraph summary that includes any upgrade instruction, then a flat bullet list focused on what users actually invoke (commands, flags, errors they see, breaking changes for CI/scripts).

Conflict-trap: when two PRs both bump `aidlc-version.ts` to the same patch number, the second-to-merge resolves by rebasing and re-bumping (e.g. `0.6.5` → `0.6.6`) plus renaming its `## [0.6.5]` heading to match. t68 catches a missed CHANGELOG bullet AND duplicate `## [N.N.N]` headings post-rebase. (CHANGELOG version link references were removed in v0.6.9 — a distributed file should not embed a repository host — so there is no longer a `[N.N.N]:` link reference to keep in sync; t68 guards that none reappear.)

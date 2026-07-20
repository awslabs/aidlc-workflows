# Skills and Runner Commands

**AI-DLC is a family of commands.** Alongside the `/aidlc` orchestrator you get a set of typeable one-word runner commands: one per scope, one per stage, and one for setup. They are convenience doors onto slices the orchestrator already exposes, so you can reach the whole framework from `/aidlc` alone, or skip the flags and type the door you want.

> **Harness note.** This chapter uses Claude Code's surfaces — skills under
> `.claude/skills/`, typed with a leading `/` from the picker. Kiro ships the same
> runner set under `.kiro/skills/` (also `/`-typed); Codex ships them to
> `.agents/skills/` and types them with `$` (`$aidlc-bugfix`). The runner *set* and
> what each does are identical across harnesses — only the directory and prefix
> differ. See [Running on other harnesses](harnesses/README.md).

---

## Many skills, one engine

Every command this implementation ships is a skill under `.claude/skills/`. They all drive the same deterministic engine — they differ only in what they bake in before they start:

- **`/aidlc`** — the full orchestrator. No flags baked in; it detects your scope (or you describe what you want), then drives every stage in your scope to completion. This is the one you reach for most.
- **Scope-runners** — `/aidlc-bugfix`, `/aidlc-feature`, `/aidlc-mvp`, `/aidlc-security-patch`. Same full workflow, with a scope fixed and scope detection skipped.
- **Stage-runners** — `/aidlc-application-design`, `/aidlc-code-generation`, and 27 more. Run one stage in isolation, never touching your main workflow. Plugin-owned stages use their bare plugin-prefixed command name, such as `/test-pro-integration`.
- **`/aidlc-init`** — birth the first intent (run the whole Initialization phase) in one step; opt-in packaging over the engine's auto-birth.
- **Session skills** — `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Read-only views over a workflow; covered in [Session Management](11-session-management.md).

Everything a runner does is reachable from `/aidlc` with a flag. The runners are packaging — typing `/aidlc-bugfix` and seeing it in your `/` menu is good ergonomics, nothing more. Delete every runner and the shortcuts go; the capability stays, reachable through `/aidlc` flags.

---

## Scope-runners — a named door per problem class

A scope-runner drives the full workflow with one scope locked in. Use it when you already know what kind of work you're doing and want to skip scope detection.

```
/aidlc-bugfix          Fix a specific bug — minimal depth, streamlined path
/aidlc-feature         Build a new feature — standard depth, all stages
/aidlc-mvp             Ship the core — skips late operations stages
/aidlc-security-patch  CVE / vulnerability response
```

Each is identical to passing `--scope` to the orchestrator:

```
/aidlc-bugfix          ==  /aidlc --scope bugfix
/aidlc-feature         ==  /aidlc --scope feature
```

You can pass a description and flags straight through, exactly as you would to `/aidlc`:

```
/aidlc-bugfix The profile API returns 500 when display_name is null
/aidlc-feature --status
```

**Only four core scopes ship a runner** — the high-traffic ones marked `runner: true` in their scope files. The framework defines nine scopes total (see [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md)); every other one — `enterprise`, `poc`, `infra`, `refactor`, `workshop` — is always reachable through the orchestrator. Plugin-owned scopes can also set `runner: true`; their runner uses the bare plugin-prefixed scope name, such as `/test-pro-validation`.

```
/aidlc --scope enterprise
/aidlc --scope poc
```

Once a workflow has started, its scope is fixed in `aidlc-state.md`, so re-running the same runner resumes the workflow rather than restarting it. To run under a different scope, use `/aidlc --scope <name>`.

---

## Stage-runners — run one stage, leave your workflow alone

A stage-runner runs a **single stage in isolation**. It uses the stage's configured agents and reviewer, records a synthetic completion, and stops without workflow learnings or an approval gate. It never advances your main workflow's `Current Stage`; the tool itself enforces that isolation.

```
/aidlc-application-design
/aidlc-code-generation
/aidlc-requirements-analysis
/aidlc-reverse-engineering
```

Each one packages `/aidlc --stage <slug> --single`:

```
/aidlc-code-generation    ==  /aidlc --stage code-generation --single
```

### When you'd use one

- **Apply one piece of methodology without committing to a workflow.** You want a requirements analysis on a problem, but you're not ready to drive a whole lifecycle. Run `/aidlc-requirements-analysis`, get the artifact, stop.
- **You're the orchestrator.** You're sequencing the work by hand and want the framework to run just the stage in front of you — the human drives, the framework supplies one stage of methodology.
- **Re-run a stage in isolation** while your main workflow sits parked at a different point — the single-stage run can't disturb it.

### Why it's safe

The `--single` invariant is tool-enforced. A single-stage run records its work under a synthetic workflow id and refuses to write your main workflow's `Current Stage`. If a runner ever tried to advance the main pointer, the engine returns an error instead. The engine guarantees this, so the safety holds even if the docs were wrong.

The three bootstrap **initialization** stages ship no stage-runner — birthing half an intent has no standalone meaning. Instead the whole initialization phase is packaged as one command:

```
/aidlc-init [--scope <name>] [description]   birth the first intent (== running /aidlc on a fresh workspace)
```

---

## The runner families at a glance

| Family | Examples | What it does | Orchestrator equivalent |
|---|---|---|---|
| Orchestrator | `/aidlc` | Full workflow, scope detected | — |
| Scope-runner | `/aidlc-bugfix`, `/aidlc-feature`, `/aidlc-mvp`, `/aidlc-security-patch` | Full workflow, scope fixed, no detection | `/aidlc --scope <name>` |
| Stage-runner | `/aidlc-application-design`, `/aidlc-code-generation`, … (29 total) | One stage in isolation, never advances your workflow | `/aidlc --stage <slug> --single` |
| Init wrapper | `/aidlc-init` | Birth the first intent (run Initialization) | `/aidlc` on a fresh workspace |
| Session views | `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack` | Read-only workflow reports | see [Session Management](11-session-management.md) |

There's one stage-runner for every runnable stage in the lifecycle. To see the full set, list your skills directory:

```bash
ls .claude/skills/
```

---

## Author your own runner — write a stage file

Here's the part that matters if you're customizing the framework: **you don't write runners by hand.** They're generated from the compiled stage graph and your scope files.

To add a stage-runner, add a stage. Write the stage file, recompile the graph, and regenerate:

```bash
bun .claude/tools/aidlc-runner-gen.ts write
```

The generator reads the compiled stage list (the one source of truth) and emits a runner shell per runnable stage. Your new stage's `/aidlc-<your-stage>` command appears automatically — no runner file to author, no boilerplate to copy. Scope-runners work the same way for scopes whose frontmatter declares `runner: true`; `scopes --all` emits runners for every scope file.

```bash
bun .claude/tools/aidlc-runner-gen.ts scopes      # generate scope-runners
```

Because the runner set is derived rather than hand-maintained, it can't drift from the stages and scopes it covers. Two checks fail CI the moment the on-disk set diverges from the source of truth:

```bash
bun .claude/tools/aidlc-runner-gen.ts check            # stage-runner drift
bun .claude/tools/aidlc-runner-gen.ts scopes --check   # scope-runner drift
```

A stage added to the graph without a regenerated runner — or an orphan runner for a stage that's gone — fails loudly with a diff. Adding a stage file and regenerating is the whole authoring path; the runner follows as a consequence the generator maintains for you.

For the mechanics of writing a stage file, see [Customization](13-customization.md) and [Phases and Stages](04-phases-and-stages.md). For the engine, the directive contract, and how a runner shell drives `next`/`report` under the hood, see the reference chapter on the [Skill System](../reference/17-skill-system.md).

---

## Quick reference

```
# Full workflow
/aidlc                              detect scope, run everything
/aidlc --scope enterprise           any of the 9 scopes

# Scope-runners (the 4 high-traffic doors)
/aidlc-bugfix · /aidlc-feature · /aidlc-mvp · /aidlc-security-patch

# One stage, isolated (never advances your workflow)
/aidlc-code-generation              == /aidlc --stage code-generation --single

# Birth the first intent (Initialization phase)
/aidlc-init [--scope <name>]        == /aidlc on a fresh workspace

# Add your own: write a stage/scope file, then
bun .claude/tools/aidlc-runner-gen.ts write
bun .claude/tools/aidlc-runner-gen.ts scopes
```

See also: [CLI Commands](12-cli-commands.md) · [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) · [Customization](13-customization.md)

---
description: >
  AI-DLC workflow orchestrator for oh-my-pi. Start, resume, or manage an
  AI-driven development lifecycle. Pass freeform text (the description of
  what to build) or a flag. Flags: --status, --init, --doctor, --stage,
  --phase, --scope, --depth, --test-strategy, --test-run, --version, --help.
argument-hint: "[description | --status | --stage <slug|#> | --phase <name|#> | --version | --help]"
---

# AI-DLC — Orchestrator (oh-my-pi)

This is the slash-command front door for AI-DLC inside oh-my-pi. Pass freeform text to start or resume a workflow; pass flags to manage state. All routing, scope resolution, gate status, and workflow completion lives in the engine binary — never re-derive any of that in prose.

## Two ways to invoke AI-DLC

| Path | Used for | Surface |
|---|---|---|
| This command (`/aidlc ...`) | Human-driven session; user types flags after `/aidlc` | omp discovery of `commands/aidlc.md` |
| The `aidlc_orchestrate` custom tool with `{"subcommand": "next" \| "report" \| "status" \| "init" \| "doctor" \| "help" \| "version", ...}` | Programmatic / automated workflows; model-driven | omp discovery of `tools/aidlc-orchestrate.ts` |

Both paths call the same TypeScript engine binary; pick whichever fits the run shape.

## Arguments

- freeform text — describe what you want to build. The engine auto-detects scope (from your command plus any `--scope <name>` override) and routes to the matching stage.
- `--status` — print the workflow status (current phase, stage, depth, test strategy).
- `--init` — scaffold `aidlc-docs/` and initialise `aidlc-state.md` without starting a workflow. `--init --force` reinitialises; `--init --scope <name>` seeds the initial scope (default `poc`).
- `--doctor` — validate setup (paths, tools, audit log) and print a status report.
- `--stage <slug>` — jump to a specific stage. `--stage <slug> --single` runs it in isolation.
- `--phase <name>` — jump to a phase; the engine picks the stage within.
- `--scope <name>` — change the active scope mid-workflow.
- `--depth <level>` — change artifact depth (`minimal` / `standard` / `comprehensive`).
- `--test-strategy <level>` — change test volume (`minimal` / `standard` / `comprehensive`).
- `--test-run` — auto-approve gates for CI / automated runs (no human in the loop).
- `--version` — print the framework version.
- `--help` — print full usage.

## Step

Call the `aidlc_orchestrate` custom tool:

```json
{
  "subcommand": "next",
  "args": [<everything after /aidlc>]
}
```

If the directive is `print`, do exactly what `message` says (run the named tool, print its output, and stop, OR run it then re-call `next` if it's a `run-then-continue` mutation).

If the directive kind is `run-stage`, load the lead agent's persona + knowledge per the directive, run the stage body, write the `produces` artifacts, branch on `directive.gate`, then commit via:

```json
{
  "subcommand": "report",
  "result": "completed" | "approved" | "rejected",
  "user_input": "<answer or \"\" if none>"
}
```

Repeat until the directive's kind is `done` or `error`.

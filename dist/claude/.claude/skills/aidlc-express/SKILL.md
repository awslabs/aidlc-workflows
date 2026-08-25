---
name: aidlc-express
generated-by: aidlc-runner-gen
description: >
  Run the AI-DLC workflow with the express scope baked in — no scope
  detection. Lightest run: requirements to deploy, no design pass, no reviewers. Packaging over `/aidlc --scope express`, which works
  without this skill.
argument-hint: "[description | --status | --stage <slug|#> | --phase <name|#>]"
user-invocable: true
---

# AI-DLC — express scope

Drive the AI-DLC engine with the **express** scope fixed. This is the same
deterministic forwarding loop the `/aidlc` orchestrator runs, with `--scope
express` baked into the first `next` so scope detection is skipped. The
engine owns all routing; the conductor persona arrives on the first directive's
`conductor_persona` field — adopt it for the whole run.

## The loop

1. `directive = bun .claude/tools/aidlc-orchestrate.ts next --scope express $ARGUMENTS`
2. Before acting on each directive, read
   `.claude/aidlc-common/protocols/stage-protocol.md` once per session,
   then read every
   `.claude/aidlc-common/protocols/stage-protocol-<module>.md` named by
   `directive.protocol_modules`. Load every listed module before acting; skip
   only a module already loaded earlier in this session. Then act on
   `directive.kind` exactly as the orchestrator does (run-stage / invoke-swarm /
   ask / print / error / done).
3. `bun .claude/tools/aidlc-orchestrate.ts report --stage <directive.stage> --result <outcome> [--user-input "<text>"]` when the directive names a stage; omit `--stage` only for non-stage report round-trips.
4. Repeat from step 1 until `directive.kind == done`.

Pass `$ARGUMENTS` through verbatim after `--scope express`; the engine parses
any flags (`--status`, `--stage`, …) and the `--scope` from the
state file always wins on an existing workflow, so re-running a started workflow
resumes it. To run a different scope, use `/aidlc --scope <other>` instead.

## Starting unrelated new work?

Before you forward `$ARGUMENTS` on step 1, make the SAME recognise-vs-route
judgment the `/aidlc` orchestrator makes: does this input **continue** the
active intent, or does it describe a **genuinely new, unrelated** piece of work?
This matters most when the active intent is already **complete**: then `next`
correctly returns `done` (the engine is read-only and never creates alongside a
live intent), and the loop above would simply stop. New work is NOT a
continuation; the escape hatch is `next --new-intent`.

- **Default to CONTINUATION.** Treat the input as new-work ONLY when it clearly
  names a distinct feature/bug/unit unrelated to the active intent's subject
  (`bun .claude/tools/aidlc-utility.ts intent --json` gives its `slug` and
  `status`). When in doubt, continue: false-positive offers are the main risk.
- **On genuine new-work, OFFER, never auto-create.** Surface an
  `AskUserQuestion` showing the active intent and the proposed new one, **including
  the scope you'd give the new intent**. Default that scope to this runner's baked
  `express` (the new work is likely the same flavour that made the user reach for
  this command), but if the new work clearly fits a DIFFERENT scope, propose that
  instead, and name it so the human can correct it. **Lead the affirmative option
  with "Yes"** (e.g. "Yes, start a second intent"). Starting a workflow is a
  mutation gated on a human yes.
- **On CONFIRM**, re-run `next` with `--new-intent`, the confirmed scope, and the
  new-work text:

  ```bash
  bun .claude/tools/aidlc-orchestrate.ts next --new-intent --scope <the confirmed scope> "<the new-work description>"
  ```

  The engine returns a `print` directive naming the `intent-create` command
  (with the `--label "<2-3 word kebab essence>"` placeholder). Act on it exactly
  as the loop's `print` handling describes: create the intent, then, because this is
  a NEW, unrelated intent and this session still carries the previous intent's
  context, **STOP** and follow the directive's hand-off: tell the user to start a
  fresh session (use `/clear` (or restart Claude Code)) and invoke `/aidlc` to begin the
  new intent with a clean slate. Nothing is lost; the intent is saved on disk.
- **On DECLINE**, proceed with the active intent, the normal loop above.

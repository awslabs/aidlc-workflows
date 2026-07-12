# AI-DLC Documentation

**AI-DLC is a methodology** — a structured, gated approach to AI-driven software
development (defined by AWS). **This repository is its native, multi-harness
implementation:** the methodology rendered as skills, agents, hooks, and tools
from one harness-neutral `core/`, so it runs natively in the CLI harness you use
— today Claude Code, Kiro CLI, Kiro IDE, Codex CLI, or opencode, and any capable CLI you port it to.
The methodology is the *what*; each harness distribution is the *how* for one
runtime, and every distribution is generated from the same source.

New here? The [README](../README.md) has the install Quick Start and the
"pick your harness" table. This page is the map of the documentation itself.

## Three guides, one per reader

Pick by what you're trying to change:

| Guide | You are… | You change… |
|-------|----------|-------------|
| **[User Guide](guide/00-introduction.md)** | building software *with* AI-DLC | nothing in the framework — you run `/aidlc`, answer at gates, review artifacts |
| **[Harness Engineer Guide](harness-engineering/00-overview.md)** | reshaping *how* AI-DLC behaves for your team | the **data** the framework reads: stages, agents, scopes, rules, sensors, knowledge — and porting to a new harness |
| **[Developer Reference](reference/00-overview.md)** | changing AI-DLC *itself* | the **code** that reads that data: the engine, hooks, CLI tools, the compile pipeline, the test suite |

The line between the Harness Engineer Guide and the Developer Reference is
**data versus code**; the line between the User Guide and the rest is **using**
versus **shaping**.

## Running on a specific harness

The guides are harness-neutral; each harness's install steps and the handful of
behaviours that differ live in [Running on other harnesses](guide/harnesses/README.md)
(Claude Code is covered throughout the User Guide, whose examples run on it).

## Building and contributing

Maintainers author in `core/` and regenerate the `dist/<harness>/` trees with
`bun scripts/package.ts` — see the [Contributing Guide](reference/11-contributing.md)
for the full build-and-test loop, and [Porting to a New Harness](harness-engineering/09-porting-to-a-new-harness.md)
to add one.

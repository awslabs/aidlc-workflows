# AI-DLC Documentation

**AI-DLC is a methodology** — a structured, gated approach to AI-driven software
development (defined by AWS). **This repository is its native, multi-harness
implementation:** the methodology rendered as skills, agents, hooks, and tools
from one harness-neutral `core/`, so it runs natively in the CLI harness you use
— today Claude Code, Kiro CLI, Kiro IDE, Codex CLI, Cursor, opencode, or GitHub Copilot, and any capable CLI you port it to.
The methodology is the *what*; each harness distribution is the *how* for one
runtime, and every distribution is generated from the same source.

New here? Start with the native installer and project initializer:

```bash
tmp="$(mktemp -d)"
gh release download --repo awslabs/aidlc-workflows-releases --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
```

The installer verifies published SHA-256 checksums; the resulting runtime needs
no Bun, Node.js, or Git, and includes every harness runtime. Harness selection
happens later in `aidlc config`. This runtime statement does not remove host prerequisites: Codex project hook
discovery requires the target project to be a Git repository.
[Getting Started](guide/01-getting-started.md) covers config, harness handoff,
trust, refresh/version skew, Windows, and the source/development copy
alternative. This page is the map of the documentation itself.

## Choose a workflow

AI-DLC ships 11 workflow profiles for different kinds of work, including
**Classic** for the established lifecycle, **Express** for the lightest
requirements-to-code path, and focused profiles for features, enterprise work,
MVPs, bugfixes, refactors, infrastructure, security patches, proofs of concept,
and workshops. Start with [Workflow Profiles](guide/workflow-profiles.md) to
compare them. Internally, the engine calls these profiles *scopes*.

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

The guides are harness-neutral; each harness's post-config step, trust behavior,
and the handful of runtime differences live in
[Running on other harnesses](guide/harnesses/README.md) (Claude Code is covered
throughout the User Guide, whose examples run on it). After an upgrade,
`aidlc doctor` reports project/runtime skew and `aidlc config` refreshes a project
between workflows; refresh is refused while a workflow is active.

## Building and contributing

Maintainers author in `core/` and materialize the ignored local
`dist/<harness>/` and `dist-release/<harness>/` trees with
`bun scripts/package.ts` — see the
[Contributing Guide](reference/11-contributing.md) for the full build-and-test
loop, and [Porting to a New Harness](harness-engineering/09-porting-to-a-new-harness.md)
to add one.

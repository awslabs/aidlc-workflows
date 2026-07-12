# Running on other harnesses

AI-DLC is one harness-neutral core rendered onto the CLI you use. The
methodology — the [phases and stages](../04-phases-and-stages.md), the
[agents](../06-agents.md), the [scopes](../05-scopes-and-depth.md), the
[approval gates](../07-interaction-modes.md) — is identical on every harness.
What differs is the *shell*: how gates render, how subagents are dispatched,
which session events fire, where config lives. Each chapter here covers one
harness's install steps, prerequisites, and the handful of behaviours that
differ from the neutral methodology.

Pick your harness:

| Harness | Invoke | Chapter |
|---------|--------|---------|
| **Claude Code** | `/aidlc` | Covered throughout the [User Guide](../00-introduction.md) (its examples run on Claude Code); install in [Getting Started](../01-getting-started.md). |
| **Kiro IDE** | `/aidlc` | [Running AI-DLC on Kiro IDE](kiro-ide.md) — prerequisites (Opus 4.8), install, hooks, what's different on Kiro. |
| **Kiro CLI** (≥ 2.6) | `/aidlc` | [Running AI-DLC on Kiro CLI](kiro-cli.md) — prerequisites, install, what's different on Kiro. |
| **Codex CLI** (≥ 0.139.0) | `$aidlc` | [AI-DLC on Codex CLI](codex-cli.md) — prerequisites, trust pre-seed, Bedrock config, the git-repo requirement. |
| **opencode** (≥ 1.17) | `/aidlc` | [AI-DLC on opencode](opencode.md) — the split `.aidlc/` + `.opencode/` layout, the adapter plugin, what's different on opencode. |

AI-DLC on Kiro (IDE or CLI) works best with **Claude Opus 4.8**, which requires a **paid Kiro plan**.

This set is open: a new harness gets its own chapter here, added from the same
template. For *building* a new harness (the source contract — manifest, hook
adapter, `emit.ts`), see the Harness Engineer Guide's
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

Whichever harness you run, the methodology is the same — start with
[Your First Workflow](../02-your-first-workflow.md) and the
[Phases and Stages](../04-phases-and-stages.md) tour.

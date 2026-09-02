# Running on other harnesses

AI-DLC is one harness-neutral core rendered onto the CLI you use. The
methodology — the [phases and stages](../04-phases-and-stages.md), the
[agents](../06-agents.md), the [scopes](../05-scopes-and-depth.md), the
[approval gates](../07-interaction-modes.md) — is identical on every harness.
What differs is the *shell*: how gates render, how subagents are dispatched,
which session events fire, where config lives. Each chapter here covers one
harness's install steps, prerequisites, and the handful of behaviours that
differ from the neutral methodology.

## Install first

The recommended first-run path for every harness is the checksum-verified native
installer followed by `aidlc config`:

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

The installer always includes every harness runtime. `aidlc config --harness <name>` selects the project surface. Host prerequisites still apply: Codex requires
the target project to be a Git repository for project hook discovery.

On Windows, download `install.ps1` and invoke it as
`& $installer`.

Pick your harness:

| Harness | Invoke | Chapter |
|---------|--------|---------|
| **Claude Code** | `/aidlc` | Covered throughout the [User Guide](../00-introduction.md) (its examples run on Claude Code); install in [Getting Started](../01-getting-started.md). |
| **Kiro IDE** | `/aidlc` | [Running AI-DLC on Kiro IDE](kiro-ide.md) — prerequisites (Opus 4.8), install, hooks, what's different on Kiro. |
| **Kiro CLI** (≥ 2.6) | `/aidlc` | [Running AI-DLC on Kiro CLI](kiro-cli.md) — prerequisites, install, what's different on Kiro. |
| **Codex CLI** (≥ 0.145.0) | `$aidlc` | [AI-DLC on Codex CLI](codex-cli.md) — prerequisites, trust pre-seed, Bedrock config, the git-repo requirement. |
| **Cursor** | `/aidlc` | [AI-DLC on Cursor](cursor.md) — one tree for the Cursor IDE and CLI, native subagents and skills, the hooks.json adapter, what's different on Cursor. |
| **opencode** (≥ 1.17) | `/aidlc` | [AI-DLC on opencode](opencode.md) — the split `.aidlc/` + `.opencode/` layout, the adapter plugin, what's different on opencode. |
| **GitHub Copilot** (CLI ≥ 1.0.74 / VS Code ≥ 1.130) | `/aidlc` | [AI-DLC on GitHub Copilot](copilot.md) — one install for both surfaces, the `.github/` merge, folder trust, what's different on Copilot. |

AI-DLC on Kiro (IDE or CLI) works best with **Claude Opus 4.8**, which requires a **paid Kiro plan**.

For a manual copy, download a specific release's `aidlc-runtime.tar.gz`, extract
it, and copy from `runtime/<harness>/`; do not copy generated trees from a
repository checkout. Framework developers may instead run
`bun scripts/package.ts` in a source checkout to materialize the ignored local
`dist/` and `dist-release/` outputs. Each harness chapter keeps the manual-copy
instructions under a clearly labeled alternative.

After `aidlc update`, run `aidlc doctor` to see project/runtime version skew
and refresh each project with `aidlc config` between workflows. Config refuses an
active-workflow refresh, protecting running work from changed stage or graph
definitions.

This set is open: a new harness gets its own chapter here, added from the same
template. For *building* a new harness (the source contract — manifest, hook
adapter, `emit.ts`), see the Harness Engineer Guide's
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

Whichever harness you run, the methodology is the same — start with
[Your First Workflow](../02-your-first-workflow.md) and the
[Phases and Stages](../04-phases-and-stages.md) tour.

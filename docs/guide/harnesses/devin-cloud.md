# Running AI-DLC on Devin Cloud

AI-DLC runs on Devin Cloud — sessions started from app.devin.ai or the Devin
API — but the contract is different from the CLI harnesses, and the difference
is the whole point of this chapter: **read the guarantee table below before
relying on any enforcement claim.**

## What is different on Cloud

A Devin Cloud session exposes only surfaces that live in the repository or the
organization settings: `AGENTS.md` at the root, skills discovered at
`.agents/skills/<name>/SKILL.md`, knowledge notes, playbooks
(`<filename>.devin.md` attachments), MCP servers configured in Customize, and
the environment blueprint. There is **no repo-local lifecycle-hook transport**:
no `PreToolUse`/`PostToolUse`/`SessionStart`/`Stop` file in the project can
intercept a tool call. (Devin scopes CAN carry hooks via Customize → Hooks and
plugin manifests, but that is an organization-level install surface — not
something this distribution can ship or assume.)

Consequence: **enforcement on Cloud is cooperative, not deterministic.** The
engine still owns state, receipts, and the audit trail, and the orchestrator
skill obligates the conductor to call the engine at every transition — each
call verifies the precondition and refuses an invalid advance. But nothing
*blocks* a tool call between engine calls. Detection is post-hoc: the audit
trail plus the doctor's gate-checkpoint scan report any transition whose
checkpoint is missing.

## Deterministic vs cooperative — the honest split

| Guarantee | Devin CLI harness (`dist/devin`) | Devin Cloud harness (`dist/devin-cloud`) |
| --- | --- | --- |
| Stage routing / `next` decisions | Deterministic (engine-owned) | Deterministic (engine-owned) |
| State transitions (`report`, `approve`) | Deterministic + enforced by the state-transition-guard hook | Deterministic at the engine call; bypasses detected after the fact via the audit checkpoint scan |
| Audit emission on artifact writes | Hook-automatic (`PostToolUse`) | Cooperative — emitted by engine calls the conductor must make |
| Stage-rule delivery | Hook-automatic (`PreToolUse` → `deliver-stage-rules`) | Cooperative — delivered through `load-steering` directives |
| Human-turn / question receipts | Hook-minted receipt files | Engine-verified at the gate (`--session` bound) |
| Plan Approval | Hook-enforced plan-approval guard + session binding | Session binding intact (explicit `--session`); interception absent — the guard is verified at the gate, not at write time |
| Reviewer read/write isolation | Enforced by `reviewer-scope`/`review-freeze` hooks | Advisory only — run reviewers as serial inline passes; nothing intercepts out-of-scope paths |
| Subagent dispatch (`run_subagent`) | Native, tracked via hooks | Not available in-session — dispatched topologies (`subagent`/`pipeline`/`mob`) run as inline personas |
| Blocking questions | `ask_user_question` tool | Plain chat question + END TURN (the session waits natively) |

Where the CLI column says "enforced", the Cloud column should be read as
"verified at the gate" or "advisory". If a workflow's correctness depends on
intercepting a write that never passed through an engine call, Cloud cannot
give that guarantee.

## Install and session entry

The runtime ships at `.aidlc/` (shared with copilot/opencode installs —
disambiguated by `tools/data/harness.json`). Copy `dist/devin-cloud/` into the
repo root. The tree contains:

- `AGENTS.md` — ambient onboarding, read by Cloud at session start.
- `.agents/skills/` — the orchestrator `aidlc` skill plus the generated
  stage/scope runners and session skills, at Cloud's documented discovery path.
- `.aidlc/` — the engine (tools, hooks-as-scripts, agents, scopes, knowledge).
- `blueprint.aidlc.yaml` — a blueprint snippet (initialize Bun, maintenance
  verify) to paste into the repository's environment blueprint.
- `aidlc.devin.md` — an entry playbook; attach it when starting the session.

Environment setup: apply `blueprint.aidlc.yaml` (Devin UI → Settings →
Environment → Blueprints) so `bun` is on PATH in the session VM.

Session entry: attach `aidlc.devin.md` or ask Devin to run the aidlc skill.
On first invocation the conductor mints one AIDLC session id by running
`.aidlc/hooks/aidlc-session-start.ts` directly with a synthesized `session_id`
(there is no host `SessionStart` event to fire it) and reuses that id for every
`--session`-accepting engine call all session. This minted id — not a vendor
session identifier — is what plan-approval binding and per-session state key
on.

## Doctor

`--doctor` on a devin-cloud install checks the runtime tree, the
`.agents/skills` surface, the session-mint marker, and the gate checkpoints —
and reports capability language instead of binary prerequisites. There is no
`devin` CLI check (none exists on Cloud), and reviewer isolation /
plan-approval rows report their guarantee level explicitly.

## Limitations to design around

- **No concurrent same-VM subagents.** Wave dispatches run serially; managed
  Devin sessions are separate VMs and cannot share this repo's engine session.
- **Reviewer isolation is serialized.** Run the reviewer pass after the work
  pass, not alongside other dispatch.
- **A cooperative guarantee is only as strong as the last engine call.** The
  doctor's checkpoint scan is the integrity check — run it when in doubt.

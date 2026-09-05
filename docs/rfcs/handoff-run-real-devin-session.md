# Hand-off — running a real Devin session with AIDLC

**Goal:** start a real Devin CLI session that does real work using the AI-DLC
workflow on this repository's `feat/devin-harness` branch (Devin CLI
`3000.6.14`, Bun `1.3.14`, Linux/WSL2). This is the user-facing path — separate
from the S02–S09 review-fix work, which lives under `docs/rfcs/`.

## 0. One-screen summary

1. Copy `dist/devin/` into a fresh project (NOT this checkout — see §1).
2. `cd` into it, run `devin` (interactive, not `-p`).
3. Approve hooks via `/hooks`, then **fully restart** Devin (`/clear` is not enough).
4. Run `/aidlc --doctor` to validate the install.
5. Run `/aidlc <describe what you want to build>` and answer the gates.

Everything below is just pointers to the authoritative sections for each step.

## 1. Use a fresh project, not this checkout

Do NOT run `/aidlc` inside `aidlc-workflows/` itself — the runbook (§0.1 rule 8)
and the S02 captures both forbid it: ancestor rules and the lazily-loaded
`dist/devin/AGENTS.md` contaminate the session context. Make a throwaway
project:

```bash
mkdir -p /tmp/aidlc-real-proj && cd /tmp/aidlc-real-proj
git init -q
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/.devin/ .devin/
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/aidlc/   aidlc/
cp    /home/wiley/sources/aidlc-workflows/dist/devin/AGENTS.md AGENTS.md
cp    /home/wiley/sources/aidlc-workflows/dist/devin/.gitignore .gitignore
git add -A && git -c user.email=you@local -c user.name=you commit -q -m "aidlc shell"
```

`aidlc/` is a **sibling** of `.devin/`, not inside it — copy it separately or
the doctor's "workspace shell ready" check fails.

## 2. Files and sections to follow (in order)

| Step | Read this | Section / lines |
| --- | --- | --- |
| Install + prerequisites | `docs/guide/harnesses/devin.md` | §"Prerequisites" (lines 10–28), §"Install" (lines 30–61) |
| Approve hooks (the one manual step) | `docs/guide/harnesses/devin.md` | §"Approve hooks" (lines 63–68) — `/hooks`, then **fully restart** Devin |
| Validate the install | `docs/guide/harnesses/devin.md` | §"Doctor" (lines 110–113) — `/aidlc --doctor` |
| Start real work | `docs/guide/harnesses/devin.md` | §"Use" (lines 70–74) — `/aidlc <description>` |
| What's different on Devin | `docs/guide/harnesses/devin.md` | §"What's different on Devin" (lines 76–102) — no statusline, `run_subagent` uses `profile`, method via `.devin/rules/aidlc.md` |
| First-workflow walkthrough (transcript-shaped) | `docs/guide/02-your-first-workflow.md` | §"Starting the Workflow" (lines 15–60) — `/aidlc Build a REST API for inventory management` is the canonical example |
| Phases & stages reference | `docs/guide/04-phases-and-stages.md` | whole file — the 5 phases / 33 stages |
| Scopes (right-size the run) | `docs/guide/05-scopes-and-depth.md` | whole file — `express` is the lightest tail (requirements → code → build/test → deploy, no design pass, no reviewers); `feature` is the worked example in §2 |
| The orchestrator's contract | `dist/devin/.devin/skills/aidlc/SKILL.md` | lines 1–30 — what the conductor does and does not own |
| Question rendering on Devin | `dist/devin/.devin/skills/aidlc/question-rendering.md` | whole file — gates render via `ask_user_question` |
| Onboarding (auto-loaded into the session) | `dist/devin/AGENTS.md` | whole file — Devin lazy-loads this on session start; it carries the commands, paths, and conventions |

## 3. The commands you'll actually type

```text
# inside the fresh project, in an interactive `devin` session:
/hooks                      # approve the AI-DLC hooks (one-time)
# fully restart Devin here (quit and re-launch, NOT /clear)

/aidlc --doctor             # validate install + version + hook approval
/aidlc --status             # current phase / stage / progress / cost (no statusline on Devin)
/aidlc --version            # framework version
/aidlc --help               # every flag and verb

# start real work — replace the description with yours:
/aidlc Build a CLI tool that turns a folder of markdown notes into a static site

# mid-workflow steering:
/aidlc --stage <slug>       # jump to a specific stage
/aidlc --phase <name>       # jump to a phase
/aidlc --depth <level>      # override depth (lite/standard/thorough)
/aidlc --test-strategy <level>   # override test volume
/aidlc --review <class>     # cap reviews (adversarial/advisory/none)
/aidlc compose "<task>"     # get a plan tailored to a task, stops at an approve/edit/reject gate
```

## 4. Where the work lives (so you can watch it happen)

- **State + audit:** `aidlc/spaces/default/intents/<slug>-<id8>/` (the "record dir"). `aidlc-state.md` is the cursor; `audit/<host>-<clone>.md` are the per-clone shards.
- **Stage diaries:** `<record>/<phase>/<stage>/memory.md` — engine-created, engine-kept; do not hand-edit.
- **Method (the rules):** `aidlc/spaces/default/memory/` — `org.md`, `team.md`, `project.md`, `phases/<phase>.md`. This is the single hand-editable source of truth for standing practice.
- **Active space cursor:** `aidlc/active-space` (defaults to `default`).

Commit the `aidlc/` tree; the shipped `.gitignore` already excludes per-user cursors and machine-local runtime.

## 5. Known limitations on Devin 3000.6.14 (from S02 captures)

These do NOT block running real work — they block three *review-fix* steps
(S07/S08/S09) on this branch. For a user session:

- **Reviewer scope (S07):** the per-unit reviewer read-scope bound cannot
  identify a reviewer from hook payload alone on 3000.6.14. If you run a
  workflow stage that dispatches a reviewer subagent, treat its scope
  enforcement as advisory, not guaranteed.
- **Question approval receipts (S08):** answered `ask_user_question` envelopes
  are captured for the input schema only; the answered-output contract is
  synthetic. Gates still work — the receipt minting is the part under test.
- **Background subagent completion (S09):** there is no dedicated completion
  hook; the ledger that tracks in-flight background subagents may not clear
  reliably. Prefer foreground subagent dispatch for now, or run
  `/aidlc --status` to reconcile if a background worker seems stuck.

Full detail: `tests/fixtures/devin-hook-payloads/s02-stop-gate-contract.md`.

## 6. When you're done with the session

The session is just a Devin session — quit normally. To resume the same
workflow later, `cd` back into the project, start `devin`, and run `/aidlc`
with no arguments; the orchestrator resolves the active intent from
`aidlc/spaces/default/intents/active-intent` and offers to resume from the last
checkpoint. See `docs/guide/11-session-management.md` for the full resume
contract.

## 7. If something looks wrong

- `docs/guide/15-troubleshooting.md` — the troubleshooting chapter.
- `/aidlc --doctor` — re-run it; it surfaces hook-approval, version, and
  workspace-shell problems.
- `docs/guide/harnesses/devin.md` §"Regenerating" (lines 115–125) — only
  relevant if you edited `core/` or `harness/devin/` and need to rebuild
  `dist/devin/`. A user session never needs this.

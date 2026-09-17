# aidlc.devin.md — AIDLC entry playbook for Devin Cloud
#
# Attach this playbook when starting a Devin session (Devin recognizes
# `<filename>.devin.md` attachments), or paste its body as the session prompt.
# It hands the session to the AIDLC orchestrator skill discovered at
# .agents/skills/aidlc/SKILL.md.

## Goal

Run the AI-DLC workflow for this repository. Read `.agents/skills/aidlc/SKILL.md`
and follow it exactly as the conductor. The engine under `{{HARNESS_DIR}}/tools/` owns
all transitions, gates, and audit receipts.

## First actions

1. Ensure Bun is available (`bun --version`); if missing, apply the blueprint
   snippet in `blueprint.aidlc.yaml` or run `curl -fsSL https://bun.sh/install | bash`.
2. Run `{{INVOKE}} --doctor` and report any failing check.
3. Invoke the orchestrator: `@skills:aidlc` (or read and follow SKILL.md
   directly if skill invocation is unavailable).

## Constraints

- This harness is cooperative: no host hook intercepts tool calls. Every stage
  transition, gate answer, and human response MUST go through the engine
  commands under `{{TOOL_PREFIX}}*` — they refuse invalid transitions and write the
  audit trail. Never edit `aidlc-state.md` or audit files by hand.
  (In the Bun-invocation channel `{{TOOL_PREFIX}}` resolves to
  `bun {{HARNESS_DIR}}/tools/`.)
- Ask the user before creating intents, approving gates, or dispatching work.

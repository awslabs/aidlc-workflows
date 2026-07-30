# ADR-004: Session Initialization via beforeSubmitPrompt (Not sessionStart)

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Integration

---

## Context

AI-DLC requires a session initialization hook to fire when the agent starts a new session. This
sets up the state context, records the session, and optionally injects workflow-resumption context.
Cursor offers two candidate events: `sessionStart` and `beforeSubmitPrompt`.

- **Problem Statement**: Which Cursor hook event should trigger AI-DLC's session-start hook?
- **Requirements**: FR-006 (hooks fire at correct lifecycle events), FR-100 (works across all 3 Cursor environments)
- **Constraints**: Cloud agents do not fire `sessionStart` — only project-level hooks run; IDE lifecycle events like `sessionStart` do not fire in cloud agents

---

## Decision

**We will use `beforeSubmitPrompt` as the session initialization trigger, not `sessionStart`.**

The adapter detects the first prompt in a conversation (via `conversation_id`) and fires the
`SessionStart`-shaped input to the core `aidlc-session-start.ts` hook only once per conversation.

---

## Research Conducted

### Option A: beforeSubmitPrompt with first-prompt detection ✓ SELECTED

**Research Confidence**: High

Documented in cursor-native-surfaces-research.md §3 (hooks) and confirmed as the intended
approach in the AI-DLC hook wiring plan table.

| Source | Key Finding |
|--------|-------------|
| cursor-native-surfaces-research.md §3 | "Cloud agent limitation: Only project-level hooks run in cloud agents. User-level hooks do NOT run. `sessionStart`/`sessionEnd` and IDE lifecycle events do NOT fire in cloud agents." |
| cursor-native-surfaces-research.md §5 | "AI-DLC uses beforeSubmitPrompt instead of sessionStart to ensure cloud agent compatibility (F-008)" |
| FR-100 | "Works identically across all three Cursor environments" — requires cloud agent support |
| vision.md | "Hooks fire correctly (session start via beforeSubmitPrompt, stop, beforeShellExecution for gates, afterFileEdit for audit)" (Success Criteria #6) |

**Capabilities Verified**:
- `beforeSubmitPrompt` fires in IDE, cursor-agent CLI, and cloud agents
- Payload includes `conversation_id` and `generation_id` for first-prompt detection
- Payload includes `prompt` text and `attachments` array
- Output: `{ continue: true/false, user_message: ..., agent_message: ... }`
- Can be used advisory (continue: true always) to inject context without blocking

### Option B: sessionStart event

**Research Confidence**: High

`sessionStart` is the semantically correct event but does not fire in cloud agents.

| Source | Key Finding |
|--------|-------------|
| cursor-native-surfaces-research.md §3 | "sessionStart and IDE lifecycle events do NOT fire in cloud agents" |
| FR-100 | Requires identical behavior across all 3 environments — cloud agents excluded by sessionStart |

**Capabilities Verified**:
- `sessionStart` fires in Cursor IDE and cursor-agent CLI
- Does NOT fire in cloud agents
- Uses different payload format (no `prompt` or `attachments` fields)
- Would break FR-100 for cloud agent users

---

## Capability Mapping

| Requirement | beforeSubmitPrompt (Option A) | Evidence | sessionStart (Option B) |
|-------------|-------------------------------|----------|------------------------|
| FR-006: hooks fire at session start | Fires on first prompt in IDE, CLI, cloud | cursor-native-surfaces-research.md §3 | Fires in IDE and CLI only |
| FR-100: all 3 Cursor environments | COMPLIANT | cursor-native-surfaces-research.md | NON-COMPLIANT — cloud agents excluded |
| Session context injection | Via `agent_message` field | cursor-native-surfaces-research.md §3 | Via `agent_message` field |
| conversation_id as session identifier | Available in payload | cursor-native-surfaces-research.md §3 | Different payload, no conversation_id |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| beforeSubmitPrompt fires on every prompt, not just the first | Known behavior | Medium — must detect first prompt to avoid double session-init | Use conversation_id as session marker in a local file |
| SESSION_RESUMED cannot fire on Cursor | Known limitation | Low — documented harness limitation | Session-start always uses "startup" source |

---

## Counter-Argument Analysis

### Q1: What evidence would make me choose sessionStart?

Cursor publishing that `sessionStart` now fires in cloud agents (post-3.11 update). Until then,
`beforeSubmitPrompt` is the only cloud-compatible session hook.

### Q2: Is there a managed service that does this better?

Not applicable.

### Q3: What am I not seeing about beforeSubmitPrompt?

`beforeSubmitPrompt` fires on every user prompt, not just session start. The adapter must implement
first-prompt detection (via `conversation_id` marker file) to avoid firing session-start logic on
every turn. This adds a small amount of state management to the adapter. The Kiro adapter has
analogous turn-tracking logic (`aidlc-turn-counter` file), so the pattern is established.

---

## Alternative Consideration Checklist

- [x] Searched for managed alternatives — not applicable
- [x] Researched minimum 2 alternatives with equal depth
- [x] Documented specific sources for each alternative
- [x] Created capability mapping with evidence
- [x] Documented unknowns and assumptions
- [x] Assigned research confidence levels
- [x] Completed Counter-Argument analysis

---

## Alternatives Considered

### Option B: sessionStart — REJECTED

Does not fire in Cursor cloud agents. Using it would break FR-100 (must work identically across all three Cursor environments).

---

## Rationale

"In the context of initializing the AI-DLC session, facing the requirement to work identically
across IDE, CLI, and cloud agents, we decided for `beforeSubmitPrompt` with first-prompt detection
and rejected `sessionStart`, to satisfy FR-100 and the cloud agent constraint, accepting slightly
more adapter logic for first-prompt detection, because `sessionStart` does not fire in cloud
agents per official Cursor documentation."

---

## Consequences

### Positive
- Works in all three Cursor execution environments (FR-100 satisfied)
- Same hook that was originally intended per vision.md Success Criteria #6

### Negative
- Adapter needs first-prompt detection logic (conversation_id marker file)
- SESSION_RESUMED cannot fire — session always starts as "startup" source (documented limitation)

### Neutral
- The core `aidlc-session-start.ts` receives a `SessionStart` event regardless of source hook

---

## Related Decisions

- **Depends On**: ADR-003 (hook adapter contract)
- **Related**: FR-100 (cross-environment compatibility)

---

## Research Sources

1. cursor-native-surfaces-research.md — §3 (hooks.json schema, cloud agent limitation)
2. cursor-native-surfaces-research.md — §5 (AI-DLC hook wiring plan)
3. FR-006 and FR-100 requirements documents

# Architecture Clarification Questions — Cursor Native Surfaces & Hook Adapter

---

### CQ-ARCH-001: Rule File Format — `.mdc` Extension vs `RULE.md` Folder Convention

- **Priority**: Critical
- **Question**: Should Cursor rules use the official `.mdc` extension (e.g., `.cursor/rules/aidlc-method.mdc`)
  or the `RULE.md` folder format described in the project's existing research document
  (e.g., `.cursor/rules/aidlc-method/RULE.md`)?
- **Why it matters**: The official Cursor docs (July 2026) state: "Project rules must use the `.mdc`
  extension. A plain `.md` file in `.cursor/rules` is **ignored** by the rules system." This directly
  contradicts the project's `cursor-platform-research.md` which describes `*/RULE.md` as the correct
  format. If the emitter generates `*/RULE.md` files, they may be silently ignored by Cursor 3.11+,
  breaking FR-005 (rules providing method context).
- **Options**:
  - (A) `.mdc` flat — `.cursor/rules/aidlc-method.mdc` — matches official docs, simpler emitter output
  - (B) `.mdc` in folders — `.cursor/rules/aidlc-method/aidlc-method.mdc` — folders for grouping, `.mdc` required
  - (C) `RULE.md` in folders — `.cursor/rules/aidlc-method/RULE.md` — as in project research doc, but contradicts official docs; only valid if Cursor added folder+RULE.md support after 3.11 and docs haven't caught up
- **Default if skipped**: Option (B) — use `.mdc` extension in named subfolders. The subfolder approach
  preserves organizational clarity (consistent with project's intent) while using the officially supported
  extension. Folder path: `.cursor/rules/aidlc-method/aidlc-method.mdc`.
- **Why this default**: The official docs are authoritative evidence that `.md` files are ignored, and
  Option B satisfies both the project's folder-organization preference and Cursor's actual file recognition
  requirement.

---

### CQ-ARCH-002: Hook Adapter Complexity — Field Naming Convention

- **Priority**: Important
- **Question**: The project's requirements (FR-007) and vision document state the adapter must translate
  "Cursor's camelCase JSON hook payloads" to the core's snake_case contract. However, research confirms
  that Cursor's actual stdin payload **already uses snake_case** (e.g., `conversation_id`, `generation_id`,
  `hook_event_name`, `workspace_roots`). Should FR-007's description be treated as an error, or is there
  a Cursor hook path that does send camelCase (e.g., plugin hooks or a different API variant)?
- **Why it matters**: If no camelCase translation is needed, the adapter is simpler. The key remaining
  transformations are: event-name normalization (`beforeSubmitPrompt` → `SessionStart` shape),
  permission-deny JSON ↔ exit-code-2 mapping, and stdin field fan-out for events like `afterFileEdit`.
- **Options**:
  - (A) No camelCase translation needed — Cursor stdin is already snake_case; adapter performs only
    structural normalization (event mapping, permission output format)
  - (B) camelCase translation is needed — there is a Cursor hook variant or newer API that sends camelCase
    not captured in docs; implement both translations
- **Default if skipped**: Option (A) — no camelCase translation. The TypeScript code snippets in the
  official Cursor hooks docs define `StopHookInput` with `conversation_id`, `generation_id` (snake_case),
  confirming the stdin contract is snake_case throughout.
- **Why this default**: Direct evidence from official Cursor docs TypeScript types shows snake_case.
  Implementing unnecessary translation adds complexity and fragile coupling.

---

### CQ-ARCH-003: Session Initialization Guard — First-Prompt Detection Strategy

- **Priority**: Important
- **Question**: The `beforeSubmitPrompt` hook fires on every prompt submission. For AI-DLC session
  initialization (the equivalent of `SessionStart`), the adapter needs to detect "this is the first prompt
  in a new session." What mechanism should be used to detect a new session vs a continuation prompt?
- **Why it matters**: Without first-prompt detection, the session-start hook runs on every message,
  causing repeated session initialization and audit-trail pollution. The codex adapter uses a heartbeat
  file keyed on `session_id` to reconcile prior sessions — the Cursor equivalent is the `conversation_id`
  field. The question is whether to re-init on each new `conversation_id` or only once per IDE launch.
- **Options**:
  - (A) conversation_id file — write `.cursor/hooks/state/cursor-session.json` with `conversation_id`;
    on `beforeSubmitPrompt`, run session-start only when `conversation_id` differs from the persisted value
  - (B) Flag file per conversation — write a flag file keyed on `conversation_id`; if flag file exists,
    skip session-start. Works for conversation-level but not for "resume from compact"
  - (C) Prompt index heuristic — always run on first prompt (index 0 — infer from transcript_path or
    absence of state file), then use the session-state file to gate subsequent invocations
- **Default if skipped**: Option (A) — persist `conversation_id` to `.cursor/hooks/state/cursor-session.json`,
  match the codex adapter's heartbeat pattern. Run session-start only when `conversation_id` changes.
- **Why this default**: Directly mirrors the proven codex adapter pattern (D-4 reconcile logic). Works
  consistently across IDE and cloud agent environments since `conversation_id` is always present.

---

### CQ-ARCH-004: Emitter Rule Content Strategy — Source Files for Core Methodology Rules

- **Priority**: Important
- **Question**: The `aidlc-method` always-apply rule must contain core methodology knowledge. Which source
  files from `core/memory/` should the emitter read, and how should they be concatenated/filtered to stay
  under 500 lines (NFR-200)?
- **Why it matters**: `core/memory/` contains `org.md`, `team.md`, `project.md`, and `phases/*.md`.
  The always-apply rule is critical for the agent always having base context, but the 500-line limit
  may require splitting. The split strategy affects whether there is one always-apply rule or multiple.
- **Options**:
  - (A) One always-apply rule per top-level memory file — `aidlc-org.mdc` (alwaysApply: true),
    `aidlc-team.mdc` (alwaysApply: true), `aidlc-project.mdc` (alwaysApply: true) — 3 rules
  - (B) One combined always-apply rule — concatenate `org.md` + `team.md` + `project.md` into a single
    `aidlc-method.mdc`; emitter validates it stays under 500 lines; split only if needed
  - (C) Method rule + project override — `aidlc-method.mdc` (org + team), `aidlc-project.mdc` (project
    overrides, also always-apply) — 2 rules
- **Default if skipped**: Option (B) — one combined always-apply rule `aidlc-method.mdc` with emitter
  validation for the 500-line limit. Split into Option (C) only if validation fails.
- **Why this default**: Minimizes the number of always-apply rules (one is simpler than three). The
  emitter is already deterministic and can enforce the size check at build time, keeping the distribution
  correct by construction.

---

### CQ-ARCH-005: cli.json Default Deny List Content

- **Priority**: Nice to Have
- **Question**: What specific shell command patterns should appear in the `deny` list of `.cursor/cli.json`
  to provide a safe default for `cursor-agent` CLI without being overly restrictive?
- **Why it matters**: The cli.json sets the permission boundary for headless `cursor-agent` CLI use. Too
  permissive defeats safety; too restrictive blocks legitimate AI-DLC operations (bun, git, test runners).
- **Options**:
  - (A) Minimal deny list — only deny clearly destructive commands: `rm -rf`, `git push --force`,
    `git reset --hard`, `DROP TABLE`, `curl|wget` (network exfiltration risk)
  - (B) Permissive allow list with broad deny — allow only `bun *`, `git add|commit|status|log|diff`,
    `npm test`, `cat|ls|grep`; deny everything else
  - (C) Reference the codex `default.rules` pattern — use the same allow-list prefixes as codex
    (`bun .cursor/tools/`, `bun .cursor/hooks/`, git worktree/commit/add prefixes)
- **Default if skipped**: Option (A) — minimal deny list for the most common destructive operations.
  Users can tighten permissions for their project. The AI-DLC methodology includes state guards via hooks
  that provide a second layer of protection.
- **Why this default**: A minimal deny list is the least surprising default for a general-purpose
  developer tool. Over-restricting in cli.json would require every user to customize it.


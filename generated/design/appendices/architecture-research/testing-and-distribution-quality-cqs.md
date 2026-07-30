## Architecture Clarification Questions — Testing & Distribution Quality

### CQ-ARCH-001: Cursor Hook Payload Fixture Source
- **Priority**: Important
- **Question**: Should `tests/fixtures/cursor-hook-payloads/payloads.json` be populated from (A) live Cursor captures (requires a working Cursor install during test authoring), or (B) hand-authored synthetic payloads following Cursor's documented camelCase schema?
- **Why it matters**: Live captures are the most accurate but require Cursor to be installed and runnable during development. Synthetic payloads can be authored immediately but may drift if Cursor's hook payload shape changes. The choice affects how quickly tests can be written and how brittle they are to Cursor platform updates.
- **Options**:
  - (A) Live captures — most accurate, matches the real contract, same approach as kiro (findings.md §0.2) and codex (spike corpus); requires Cursor install
  - (B) Synthetic hand-authored payloads — unblocks test writing immediately, uses Cursor's documented schema as source of truth; easier to maintain if schema is stable
- **Default if skipped**: (B) Synthetic payloads based on Cursor's documented hook schema.
- **Why this default**: The existing harnesses (t147 Kiro, t149 Codex) captured live payloads because those harnesses had no public schema documentation — the captures were the only reliable source. Cursor's hook payload schema is documented in the platform research file (`cursor-platform-research.md`) with explicit field names (`conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`). Starting with synthetic payloads unblocks test authoring immediately and the corpus can be replaced with live captures once available.

### CQ-ARCH-002: Doctor Arm Location for Cursor
- **Priority**: Important
- **Question**: Should the Cursor harness check in `handleDoctor` live in `core/tools/aidlc-utility.ts` (a new `else if (harness === ".cursor")` branch), or in a separate `harness/cursor/doctor-checks.ts` that is called from the doctor arm?
- **Why it matters**: The vision document (vision.md) scopes the doctor extension to `core/tools/aidlc-utility.ts`, but a separate file would keep harness-specific logic out of core. Every existing harness (Kiro, Codex, opencode) uses the inline `else if` pattern in the shared utility. A separate file would be a new pattern.
- **Options**:
  - (A) Inline `else if (harness === ".cursor")` branch in `core/tools/aidlc-utility.ts` — consistent with all existing harnesses; no new pattern; the vision document explicitly names this file
  - (B) Separate `harness/cursor/doctor-checks.ts` loaded dynamically — cleaner harness isolation, but adds a new pattern and dynamic require not used by any other harness
- **Default if skipped**: (A) Inline branch in `core/tools/aidlc-utility.ts`.
- **Why this default**: All four existing harnesses (`.claude`, `.kiro`, `.codex`, `.aidlc`) use inline branches in the shared utility. The vision document explicitly names `core/tools/aidlc-utility.ts` as the scope. Introducing a new dynamic-load pattern for the fifth harness would diverge from the established codebase convention.

### CQ-ARCH-003: Packaging Test Number and File Name
- **Priority**: Nice to Have
- **Question**: FR-201 and vision.md cite `tests/unit/t145-cursor-packaging.test.ts` as the target test file name. The unit test directory scan shows no existing `t145*.test.ts`. Confirm: is `t145` the intended number, or should this be the next available sequential number after the current highest (t247)?
- **Why it matters**: If another test is added between now and implementation that uses t145, there will be a naming collision. The gap between existing tests and t247 suggests t145 may be a pre-planned reservation rather than the next sequential number.
- **Options**:
  - (A) Use `t145` as specified in vision.md and FR-201 — matches the acceptance criteria as written; confirms the number was pre-planned
  - (B) Use the next available sequential number (currently t248) — avoids any risk of collision; diverges from the cited acceptance criteria
- **Default if skipped**: (A) Use `t145` as cited in the requirements.
- **Why this default**: The vision document and FR-201 are explicit: `t145-cursor-packaging.test.ts`. The number appears to be a deliberate reservation (there is a gap between the highest existing number t247 and the low numbers used by packaging tests: t150 for Codex, t240 for opencode). This is likely a pre-planned slot for the Cursor packaging test.

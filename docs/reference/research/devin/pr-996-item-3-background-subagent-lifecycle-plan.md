# PR #996, Item 3: background subagent launch is recorded as completion — plan

**Review item:** [PR #996 review, Item 3 (P1)](https://github.com/awslabs/aidlc-workflows/pull/996#pullrequestreview-5226026258). **Finding:** DEVIN-07 (background lifecycle row). **Baseline:** `10b71cb5` on `feat/devin-harness` (Items 1 and 2 landed). **Fact-checked:** 2026-09-19 against the source tree, the 3000.6.14 captures, the Devin CLI `3000.10.31 (b98cc431)` binary and its bundled docs, and the Claude Code hooks reference. **Status:** implemented, regression-covered on the 3000.10.31 captures, and accepted live on 3000.10.31 (2026-09-19, `evidence/devin-e2e-run/background-lifecycle-run/`: L1–L6 PASS, L7 not exercised); to be folded into DEVIN-07/14.

Decisions already taken with the owner (2026-09-19): re-capture on the current host before writing adapter code; unobserved terminations are recovered by the core TTL only (Claude parity); no new audit event at launch; correlation state lives where Claude Code keeps it — the core in-flight ledger — not in a Devin-only file.

## 1. Goal and scope

A Devin background dispatch must be represented as *launch → pending → terminal*, exactly once, correlated by Devin's `agent_id`, so that: the Stop hook's pending-subagent carve-out sees genuinely pending work; `SUBAGENT_COMPLETED` is appended only at the real terminal event and names the profile and agent id; repeated `read_subagent` calls add nothing; and foreground completions never consume a background entry. The Devin harness follows the Claude Code model: Claude's `SubagentStop` is the single terminal event and `PreToolUse Task run_in_background` is the launch; the adapter's job is to synthesize that same pair from the events Devin does emit.

### Non-goals

Reviewer read/search attribution (review Item 4; child events still carry no identity, C09). A new audit taxonomy member. Session-end draining of ledger entries. Changing the core's session-scoped, TTL-bounded ledger semantics for other harnesses. Working around the absence of a host completion event by polling or shell loops (the ensemble protocol already forbids that: `core/aidlc-common/protocols/stage-protocol-ensemble.md:44`).

## 2. Fact-checked baseline

### The review's claims, checked

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `hooks.v1.json` routes a successful `run_subagent` PostToolUse straight to the shared completion hook | True | `harness/devin/hooks.v1.json` PostToolUse matcher `^run_subagent$` → `log-subagent`; adapter `case "log-subagent"` only rewrites `tool_name` and pipes to `aidlc-log-subagent.ts` (`harness/devin/hooks/aidlc-devin-adapter.ts:984-994`) |
| The shared hook treats the event as terminal: removes an in-flight entry and appends `SUBAGENT_COMPLETED` | True | `core/hooks/aidlc-log-subagent.ts:49` `completeSubagentInflight(projectDir, rawSessionId)`, then `:92` `appendAuditEntry("SUBAGENT_COMPLETED", …)` |
| For a background subagent the immediate result only says the agent started; the terminal result arrives via `read_subagent` | True on 3000.6.14 | C05_backgroundLaunch: PostToolUse output `Background subagent started with agent_id=<id>. You can wait … read_subagent …`; C05_backgroundCompletion: terminal only as `read_subagent` PostToolUse `Subagent <id> completed.` The same strings are present in the 3000.10.31 binary |
| `read_subagent` is excluded from the lifecycle hook | True | matcher `^run_subagent$`; t331 asserts `re(log.matcher).test("read_subagent") === false` (`tests/unit/t331-devin-packaging.test.ts:172`) |
| The adapter retains `is_background` while the core checks `run_in_background`, so no in-flight entry is created | **Was true at review time; changed by Item 2** | `normalizeRunSubagentInput` now maps `is_background → run_in_background`; a probe through the packaged adapter (2026-09-19) shows PreToolUse `deliver-stage-rules` with `is_background:true` **creates** `aidlc/.aidlc-subagent-inflight` = `{"version":1,"entries":[{"sessionId":"probe-session","startedAtMs":…}]}` |
| Result: `SUBAGENT_COMPLETED` at launch, unknown agent type, Stop cannot see pending work, no event for the terminal result | True, and now sharper | Probe: the launch-ack PostToolUse **deleted the entry the PreToolUse had just created** and appended `SUBAGENT_COMPLETED` with `Agent Type: unknown`, no Agent ID, no Message; a `read_subagent` PostToolUse produced no audit delta and left the ledger untouched (adapter gates on `tool === "run_subagent"`); a foreground `run_subagent` completion removed one entry from a two-entry ledger (`findIndex`/`splice`, `core/tools/aidlc-lib.ts:20303-20306`) — foreground completions consume background entries |
| Tests encode this lifecycle | True | t332 test 11 "run_subagent PostToolUse lands SUBAGENT_COMPLETED" (`tests/unit/t332-devin-adapter.test.ts:493`); t331 read_subagent exclusion above |

Stop-side behavior confirmed by the same probe: with an entry present for the Stop payload's `session_id`, `continue-workflow` allows the stop silently and writes `a background subagent is still in flight for this session; allowing the stop (pending-subagent carve-out)` to `continue-workflow.drops`; for a different session it blocks. `isPendingSubagentStop` → `matchSubagentInflight(projectDir, sessionId)` (`core/hooks/aidlc-continue-workflow.ts:707-750`, `:1629-1640`), exact session match, 2h TTL (`SUBAGENT_INFLIGHT_TTL_MS`, `aidlc-lib.ts:20153`), malformed ledger fails closed.

### What Devin provides (docs + binary, 3000.10.31)

- **Hook events.** Documented: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd` (`share/devin/docs/extensibility/hooks/lifecycle-hooks.mdx`). The binary's Claude-format config parser lists the same event names; `SubagentStop` appears only as an *output-envelope* variant (`ClaudeHookSpecificOutput::SubagentStop`, i.e. accepted in `hookSpecificOutput.hookEventName`), never as a dispatched event, and `SubagentStart`/`SubagentCompleted` occur only as ACP session-export event types (`cognition.ai/subagent_started`, `cognition.ai/subagent_completed`). **There is no SubagentStop hook on Devin**; the adapter comment saying it "replaces the absent SubagentStop event" is accurate. String inspection is not authoritative — Phase 0 registers a `SubagentStop` entry in the capture config to prove the negative on the current build.
- **PostToolUse stdin.** `tool_name`, `tool_input`, `tool_response {success, output, error}` (docs); captures add `tool_use_id`, `session_id`, `prompt_id`. No `agent_id`/`agent_type` field anywhere; the agent id is embedded in `tool_response.output` (C04, C05).
- **Tool schemas** (from the 3000.10.31 session export header, `evidence/devin-e2e-run/native-dispatch-run/devin-session-a.json`): `run_subagent {title, task, profile, is_background?: boolean (default false), resume?: string}` — `resume` sends the prompt to an existing agent id, so one agent id can have several launch/terminal cycles; `read_subagent {agent_id, block?: boolean (default false), timeout?: integer}`.
- **Output strings** (binary, `toolbox/src/tools/subagent.rs` neighbourhood): launch `Background subagent started with agent_id=<id>. …`; foreground terminal `Subagent agent_id=<id> completed successfully:` / `Subagent <id> exited with an error:` / `Subagent error: …`; read terminal `Subagent <id> completed. Its full report is delivered in the <subagent_completion_notification> message…`, `Subagent <id> completed successfully:` (repeated read re-serves the report, C06), `Subagent <id> exited with an error. The error details are delivered in the <subagent_completion_notification> message.`; read non-terminal `Subagent is still running.`; read failure `No subagent found with agent_id=…`. These are undocumented and must be treated as a versioned host contract (pin in fixtures, re-verify per version alongside t334's floor).
- **Lifecycle facts from `subagents.mdx`.** Background subagents run in parallel and the parent is "automatically notified" on completion (agent-context notification, not a hook — C05); Ctrl+B moves a foreground subagent to the background *after* its tool call has already returned; interrupting the turn parks subagents; cancel from the panel or Ctrl+C/Esc; cancelled, failed, or completed subagents can be resumed and always resume in the foreground; subagents cannot nest by default.
- **Changelog v3000.10.21 (the support floor):** "The CLI no longer shows Devin as idle while a background subagent is still running: the turn stays active until it finishes." This post-dates every capture (3000.6.14) and may mean the `Stop` hook no longer fires while a background subagent is pending, which would change how often the carve-out is exercised. **Unverified — Phase 0 settles it.**

### What Claude Code provides (the principle to mirror)

`SubagentStop` fires when a subagent finishes and carries `agent_id`, `agent_type`, `last_assistant_message` (Claude Code hooks reference, "SubagentStop input"). The core reads exactly those fields (`aidlc-log-subagent.ts:81-83`). Launch is the `PreToolUse Task` with `run_in_background: true` (`recordAcceptedBackgroundDispatch`, `core/hooks/aidlc-deliver-stage-rules.ts:271-303`). The ledger is session-scoped and reference-counted, with no agent id, because on Claude the terminal event is reliable and one decrement per `SubagentStop` is exact. Devin's terminal event is *not* reliable (it is a tool result the parent may or may not request), so the Devin adapter needs agent-id correlation to (a) skip the launch ack, (b) resolve the right entry at the real terminal event, and (c) ignore repeated reads. Precedent for adapter-side correlation: the Copilot adapter's active-subagent ledger (`harness/copilot/hooks/aidlc-copilot-adapter.ts:707-`), which synthesizes a `SubagentStop`-shaped payload (`:1288-1296`) for the core.

## 3. Intended change

### Phase 0 — capture on the current host (gate)

Reuse the C-series capture method (`tests/fixtures/devin-hook-payloads/capture-provenance.json` → `captureMethod`): a throwaway project with `.devin/hooks.v1.json` wiring every documented event plus a `SubagentStop` entry to the capture logger, driven with `devin -p … --respect-workspace-trust false`, and — for the interactive-only cases — a manual session. Produce `tests/fixtures/devin-hook-payloads/captured-3000.10.31.json` and extend `capture-provenance.json`; keep the 3000.6.14 file untouched. Cases:

| Case | Scenario | Question it answers |
| --- | --- | --- |
| C05' | Background launch, then `read_subagent block:true` | Launch/terminal strings unchanged since 3000.6.14? |
| C06' | Repeated read after completion | Still `success:true` + re-served report? |
| C11 | Background launch; parent ends its turn **without** reading | Does `Stop` fire before the background agent finishes (3000.10.21 note)? Record the order and timestamps of `run_subagent` PostToolUse, child tool events, `Stop`, and whether any event follows completion |
| C12 | Background agent that fails (dispatch `subagent_general` with a task needing a non-pre-approved tool, per `subagents.mdx` permission rules), read it | Exact error output string; `tool_response.success/error` values |
| C13 | Cancel a running background agent from the panel, then read it | Any hook event on cancel? Read output after cancel |
| C14 | `run_subagent` with `resume: <agent_id>` on a completed agent (foreground by definition) | Output shape of a resumed completion; same `agent_id` |
| C15 | Foreground agent moved to background with Ctrl+B | What the already-returned PostToolUse said; how completion is later observable |
| C16 | `SubagentStop` registration | Prove no such event is dispatched (negative) |

Exit criterion: the classifier strings in §3C are pinned from this capture, C11 is answered, and any surprise (e.g. a structured `agent_id` field appearing) is recorded in DEVIN-07 before code is written. If C11 shows `Stop` never fires while a background agent is pending, the carve-out becomes defense-in-depth and the plan proceeds unchanged; if `Stop` does fire, the carve-out is load-bearing and the live acceptance must exercise it.

### A. Core ledger: additive agent correlation (`core/tools/aidlc-lib.ts`)

Keep file, version, session scoping, TTL, locking and the Claude call sites unchanged. Add two optional fields to `SubagentInflightEntry`: `agentId?: string`, `agentType?: string` (reader accepts absence; a present `agentId` must be a non-empty string, otherwise malformed as today). Add:

```ts
// Attach host identity to the newest un-annotated fresh entry of this session.
export function annotateSubagentInflight(projectDir, sessionId, meta: { agentId: string; agentType?: string }): boolean
// Exact-id completion; falls back to the session-scoped splice when agentId is undefined (Claude path).
export function completeSubagentInflight(projectDir, sessionId, agentId?: string): boolean
export function hasSubagentInflight(projectDir, sessionId, agentId: string): boolean
```

Completion rule, evaluated over the session's fresh entries under the audit lock:

1. `agentId` given and an entry carries that id → remove exactly that entry.
2. `agentId` given, no entry carries it, but the session has at least one **annotated** entry → remove nothing, return `false`. (An annotated session uses exact-id semantics; this is what stops a foreground completion, or a foreign/repeated read, from consuming a background entry.)
3. Otherwise → legacy behavior: remove the first entry of the session.

The core hook's input contract stays Claude's `SubagentStop` payload; the only core-hook edit is `aidlc-log-subagent.ts:49` → `completeSubagentInflight(projectDir, rawSessionId, parsed.agent_id || undefined)`. Claude Code and Copilot never annotate entries, so they always take rule 3 and their behavior is byte-for-byte unchanged (t228/t248/t121/t328/t249 must stay green).

### B. Hook wiring (`harness/devin/hooks.v1.json`)

PostToolUse `log-subagent` matcher `^run_subagent$` → `^(run_subagent|read_subagent)$`. `deliver-stage-rules` stays `^run_subagent$`. t331 test 3 flips its `read_subagent` expectation for `log` only.

### C. Adapter `log-subagent` arm (`harness/devin/hooks/aidlc-devin-adapter.ts`)

Classify the PostToolUse from `tool_name`, `tool_input`, and `tool_response.output` (strings pinned from Phase 0; all matching anchored at line start and tolerant of the leading tab the binary emits):

| Event | Classification | Adapter action |
| --- | --- | --- |
| `run_subagent`, `is_background !== true`, output `Subagent agent_id=<id> completed successfully:` or `exited with an error` / `Subagent error:` | foreground terminal | Forward synthesized `SubagentStop` to core: `{hook_event_name:"SubagentStop", session_id, agent_id:<id>, agent_type:<tool_input.profile>, last_assistant_message:<output minus the header line, 200 chars trimmed by core>}`. Core appends `SUBAGENT_COMPLETED` with the profile as Agent Type; the ledger is untouched when the session has annotated background entries (§3A rule 2) |
| `run_subagent`, `is_background === true`, output `Background subagent started with agent_id=<id>` | launch | Do **not** call the core. `annotateSubagentInflight(projectDir, session_id, {agentId:<id>, agentType: profile})`. No audit row (decision: parity) |
| `run_subagent` with `resume:<id>` | resumed (always foreground) | Treat as foreground terminal for `<id>`; if an annotated entry for `<id>` exists (an unread earlier background run) it is completed by the exact-id path |
| `read_subagent`, output `Subagent <id> completed…` or `exited with an error…` | background terminal | If `hasSubagentInflight(session, <id>)`: forward synthesized `SubagentStop` with `agent_type` from the entry, `agent_id`, `last_assistant_message` (the report when re-served, else the one-line status). Else: repeated read or foreign id → no-op |
| `read_subagent`, `Subagent is still running.` / `No subagent found` / `success:false` | non-terminal | no-op |
| anything else | unknown | `run_subagent`: fail-open as today (forward as terminal, `agent_type: profile`); `read_subagent`: no-op + `recordHookDrop("log-subagent", "unclassified read_subagent output")` |

The adapter never writes the ledger file directly; it goes through the core lib so locking and malformed-handling stay single-sourced.

### D. Skill prose (`harness/devin/skills/aidlc/SKILL.md:128`)

Already says "run parallel supports with `is_background: true` and read each result via `read_subagent` before integrating". Add one sentence: the read is also what records completion for the audit and releases the pending-work marker; ending a turn with an unread background agent leaves it pending until the TTL (decision: TTL-only recovery). t333 pins the binding prose — extend, don't rephrase.

### E. Documentation in the same change

DEVIN-07 status/implementation/regression rows (background lifecycle → implemented, with what remains open: cancellation and unread completions are TTL-recovered; child identity still absent); DEVIN-06 if the matcher table lists hook targets; DEVIN-14 evidence table (new capture file, new live run) and the "Background work" live row; findings index open-gap rows; `core/knowledge/aidlc-shared/audit-format.md:192` emitter note (`hooks/aidlc-log-subagent.ts (SubagentStop, or the harness adapter's synthesized equivalent)`); `docs/reference/06-hooks-and-tools.md` if it describes the Devin matcher.

## 4. Regression matrix

### Step 1 — Failing subprocess tests through the real adapter (t332, red first)

Payloads from `captured-3000.10.31.json`; one scratch project with a Running workflow per test, `session_id` set.

| # | Case | Assertion |
| --- | --- | --- |
| 1 | PreToolUse deliver-stage-rules `is_background:true` then PostToolUse launch ack | ledger has one entry for the session **with** `agentId`/`agentType`; **no** `SUBAGENT_COMPLETED` row |
| 2 | …then `read_subagent` terminal (`completed`) | entry removed; exactly one `SUBAGENT_COMPLETED` with `Agent Type: <profile>`, `Agent ID: <id>` |
| 3 | …then the same `read_subagent` again (C06) | no new row; ledger still absent |
| 4 | Launch, then `read_subagent` `still running` | entry intact, no row |
| 5 | Launch, then `read_subagent` error terminal (C12 string) | entry removed; one row whose `Message` starts with the error text |
| 6 | Foreground `run_subagent` terminal (C04) with an unrelated annotated background entry present | one row (`Agent Type: <profile>`, `Agent ID`); background entry **intact** |
| 7 | Two background launches (ids A, B), terminal B, terminal A | rows in that order, ledger empty at the end, no double decrement |
| 8 | Launch in session S1; `read_subagent` terminal for that id arrives with session S2 | S1 entry intact; no row (cross-session isolation, same principle as Item 1) |
| 9 | Stop `continue-workflow` for the session right after launch | allowed with the pending-subagent drops line; after case 2's terminal, the same Stop blocks (or allows for another reason — assert the carve-out line is absent) |
| 10 | `resume:<id>` foreground completion for an unread background id | entry removed, one row |
| 11 | Launch, then a `read_subagent` with unclassifiable output | no row, no ledger change, one `log-subagent` drops line |
| 12 | Malformed stdin on `log-subagent` (existing 16) | exit 0 |
| 13 | Existing t332 test 11 rewritten: a *foreground* `run_subagent` PostToolUse lands `SUBAGENT_COMPLETED` with the profile as Agent Type (no longer `unknown`) |

### Step 2 — Core ledger unit tests (new or extended where the ledger is already tested; grep `markSubagentInflight` in `tests/`)

Annotate attaches to the newest un-annotated entry only; exact-id completion never falls back to session splice when the session has annotated entries; legacy (id-less) entries keep today's splice; malformed `agentId` types fail closed; TTL prune still applies to annotated entries; `hasSubagentInflight` is fresh-only.

### Step 3 — Existing coverage that must stay green

t331 (with the matcher flip), t332 whole file, t333 (prose extension), t228/t248 (deliver-stage-rules unchanged), t121 and integration t328 (Stop consultation and authority), t147/t149/t249 (other adapters untouched but share `aidlc-log-subagent.ts`), Copilot t249 in particular since it synthesizes `SubagentStop` with `agent_id` — confirm its ledger-less flow still splices by session.

## 5. Verification commands

```bash
bun scripts/package.ts
bun test tests/unit/t332-devin-adapter.test.ts --test-name-pattern 'Item 3'   # red before, green after
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts tests/unit/t333-ensemble-harness-bindings.test.ts tests/unit/t228-hook-run-exports.test.ts tests/unit/t248-steering-content-delivery.test.ts tests/unit/t121-*.test.ts tests/unit/t249-copilot-adapter.test.ts
bun test tests/integration/t328-authority-rebinding.test.ts
bun scripts/package.ts --check && bun run typecheck && bun run lint && git diff --check
```

## 6. Live acceptance and completion criteria

New directory `evidence/devin-e2e-run/background-lifecycle-run/`, same Phase-0 project recipe as `native-dispatch-run/` (fresh install from the rebuilt `dist/devin`, doctor before/after, `MANIFEST.sha256`, DB snapshot right after dispatch because the export covers only the post-compaction tail — DEVIN-14 protocol). Run a stage whose topology dispatches at least one background support (a `pipeline`/`mob` directive; if the express `hello.py` graph has none, pick the smallest scope that does, or dispatch a background support deliberately per the skill's parallel-support rule), then:

1. **Launch is pending.** After the background `run_subagent` returns, `aidlc/.aidlc-subagent-inflight` holds the entry with the real `agentId`; no `SUBAGENT_COMPLETED` row yet.
2. **Terminal is recorded once.** After the conductor's `read_subagent`, exactly one `SUBAGENT_COMPLETED` with `Agent Type` = profile and `Agent ID`; the entry is gone; a second read (ask the conductor, or run one) adds nothing.
3. **Stop behavior matches C11.** If Stop fires while pending, the `continue-workflow.drops` line shows the carve-out and the turn is allowed; after terminal, no carve-out line.
4. **Foreground completion unaffected.** The lead's foreground dispatch produces its row with the profile name and leaves any background entry alone.
5. **Failure path** (if reproducible on the host per C12): the row's `Message` carries the error text.
6. **Workflow completes** as in native-dispatch-run; no regression of Items 1–2 (`PLAN_APPROVAL_BLOCKED` unchanged, rule bundle still delivered).

Item 3 is complete when Phase 0 is recorded, Step 1 cases 1–13 and Step 2 pass through the real adapter, Step 3 stays green, packaging is deterministic, live steps 1–4 (and 5 when reproducible) are evidenced, and DEVIN-07/14 and the index state the new evidence level without erasing the still-open reviewer-attribution row.

### Residual limitations (stated, not solved)

- A background agent whose result the parent never reads, or that is cancelled from the panel, has no hook-observable terminal event; its entry ages out under the core's 2h TTL (owner decision: TTL only). During that window the Stop carve-out can relax forwarding-loop enforcement for that session only.
- Output-string classification is an undocumented host contract; every version bump re-runs C05'/C06'/C12 and the classifier tests pin the strings.
- Ctrl+B backgrounding after the tool call returned (C15) is observable only if the parent later reads the agent; otherwise TTL.
- Annotation happens at the launch-ack PostToolUse, so an entry is id-less between its PreToolUse and that ack; a foreground completion for the same session landing inside that window (parallel tool batch) would still take rule 3 and consume it. Devin's own tool guidance is to launch background agents first and then one foreground agent, which keeps the window empty in practice; Phase 0 C11/C15 ordering data decides whether this needs a guard.
- Child tool events remain unattributable (Item 4).

[Back to findings index](index.md)

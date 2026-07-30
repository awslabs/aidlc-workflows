# Security Controls: Cursor Harness for AI-DLC Workflows 2.0

**Document Version**: 1.0
**Last Updated**: 2026-07

---

## Overview

This document maps identified threats to security controls, categorizes controls by type, and provides implementation guidance for each control. All controls apply to a local developer tooling project — there is no cloud infrastructure.

---

## 1. Threat-to-Control Mapping

| Threat ID | Threat Summary | Primary Controls | Secondary Controls | Risk Level |
|-----------|---------------|------------------|--------------------|------------|
| T-0001 | Tampered distribution (backdoored hooks.json/cli.json) | EC-0003 (drift guard), EC-0008 (git) | M-0001, M-0005, M-0009 | High |
| T-0002 | Gate removal from hooks.json or cli.json | EC-0001 (failClosed), EC-0002 (cli.json) | M-0003, M-0005, M-0009 | High |
| T-0003 | Adapter logic bug causes fail-open on security gate | EC-0004 (adapter contract test) | M-0003 (failClosed crash defense) | High |
| T-0004 | Prompt injection bypasses gates | EC-0001 (failClosed gate), EC-0005 (scope gate) | M-0007, M-0010 | High |
| T-0005 | Reviewer subagent reads credentials outside declared scope | EC-0005 (preToolUse scope gate) | M-0007, M-0011 | High |
| T-0006 | Unbounded self-correction loop | EC-0006 (loop_limit) | M-0008 | Medium |
| T-0007 | Compromised core/hooks/ source ships weakened guard | EC-0008 (code review, git) | M-0002, M-0004 | High |
| T-0008 | Marker file deletion causes duplicate session init | M-0012 (advisory handling) | — | Low |
| T-0009 | PATH injection compromises bun subprocess | EC-0007 (process.execPath) | M-0006 | Low |
| T-0010 | Hand-edited dist/ introduces inconsistency | EC-0003 (drift guard) | M-0001, M-0009 | Medium |

---

## 2. Controls by Type

### 2.1 Preventive Controls

Controls that prevent a security incident from occurring.

#### PC-1: failClosed Security Gates

**Control**: `failClosed:true` on `beforeShellExecution` and `preToolUse` hook entries in hooks.json

**Threats Addressed**: T-0002, T-0003, T-0004

**Mechanism**: When the hook subprocess crashes or times out, Cursor blocks the operation rather than allowing it. This is Cursor's native defense-in-depth for hook-based gates.

**Implementation Requirements**:
- hooks.json entry for `beforeShellExecution` MUST include `"failClosed": true`
- hooks.json entry for `preToolUse` MUST include `"failClosed": true`
- Emitter (`emit.ts`) generates these entries deterministically
- NFR-101 mandates this; t145 packaging test must assert the field is present

**Limitations**: failClosed protects against adapter process failure, not against adapter logic bugs that return `{permission:allow}` when deny is correct. Adapter logic correctness is enforced by PC-3 (contract test).

---

#### PC-2: CLI Permission Allow/Deny List

**Control**: `.cursor/cli.json` with explicit allow and deny patterns

**Threats Addressed**: T-0002 (CLI mode), T-0004 (CLI mode)

**Mechanism**: cursor-agent CLI enforces the permission list before executing any shell command in headless mode. Only allow-listed command patterns execute without prompting.

**Default Allow List** (as specified in architecture):
- `bun *` — required for hook scripts and build tools
- `git add *`, `git commit *`, `git status *`, `git log *`, `git diff *` — safe read/stage operations

**Default Deny List** (as specified in architecture):
- `rm -rf *` — destructive deletion
- `git push *` — remote repository modification (production safety)
- `git reset --hard *` — history rewrite
- `curl *`, `wget *` — outbound network requests that could exfiltrate data

**Limitations**: Applies only in cursor-agent CLI mode. Cursor IDE relies solely on the hook gate. Pattern matching semantics depend on Cursor's cli.json implementation — exact pattern behavior should be validated via testing.

---

#### PC-3: Adapter Contract Tests (Behavioral Correctness)

**Control**: `tests/unit/t146-cursor-hook-adapter.test.ts` behavioral assertions

**Threats Addressed**: T-0003 (adapter logic bug)

**Mechanism**: Subprocess shim tests (spawnSync) verify that the adapter produces exactly the right JSON output for each input scenario. A failing test catches a logic regression before it ships.

**Required Test Cases**:

| Test Case | Input | Expected Output | Assertion |
|-----------|-------|-----------------|-----------|
| Shell block (exit 2 path) | `beforeShellExecution` + core exits 2 + stderr reason | `{permission:deny, user_message:reason, agent_message:reason}` on stdout, exit 0 | Assert stdout JSON fields exactly |
| Shell allow (exit 0 path) | `beforeShellExecution` + core exits 0 | exit 0, no JSON or `{permission:allow}` | Assert no deny |
| Malformed stdin (fail-open) | Non-JSON stdin on any target | exit 0, empty stdout | Assert exit 0 |
| failClosed crash | Adapter process itself aborted (crash test) | Cursor blocks (failClosed:true) — no assertion needed from test, verified by hooks.json field check | Assert `hooks.json` has `failClosed:true` |
| Adapter timeout | Core hook times out | Cursor blocks (failClosed:true) | Not directly testable; covered by failClosed field assertion |
| Core exits 2, empty stderr | `beforeShellExecution` + core exits 2 + empty stderr | `{permission:deny, user_message:"", ...}` — deny still sent | Assert permission:deny even with empty reason |

**Dependencies**: t146 requires `dist/cursor/` to exist (packager must run first). Following t147/t149 pattern (subprocess shim, not in-process).

---

#### PC-4: Reviewer Scope Gate

**Control**: `preToolUse` hook with `failClosed:true`, matcher `Read\|LS\|Glob\|Grep`, calls `aidlc-reviewer-scope.ts`

**Threats Addressed**: T-0005 (reviewer reads credentials), T-0004 (prompt injection reads secrets)

**Mechanism**: Every file-reading tool call by a reviewer subagent fires the preToolUse hook. The scope hook verifies the requested file is within the declared read scope for that reviewer task.

**Implementation Requirements**:
- Matcher regex in hooks.json must cover all file-reading tools: `Read`, `LS`, `Glob`, `Grep`
- `aidlc-reviewer-scope.ts` must read declared scope from the task context
- If scope is not declared, default to deny (fail closed)
- Orchestrator SKILL.md must instruct that all reviewer delegations include an explicit, minimal scope declaration

**Limitations**: Scope is declared by the orchestrator; an overly broad scope weakens the gate. See RT-0003 for remediation.

---

#### PC-5: process.execPath Subprocess Invocation

**Control**: Adapter uses `process.execPath` instead of bare `"bun"` when spawning core hook subprocesses

**Threats Addressed**: T-0009 (PATH injection)

**Mechanism**: `process.execPath` resolves to the absolute path of the currently running bun process, bypassing PATH lookup. An attacker cannot intercept subprocess invocation by placing a malicious binary earlier in PATH.

**Implementation Requirements**:
- All `spawnSync`/`spawn` calls in `aidlc-cursor-adapter.ts` use `process.execPath` as the executable
- No calls use the bare string `"bun"` as the executable

---

#### PC-6: loop_limit on Stop Hook

**Control**: `loop_limit` field on the stop hook entry in hooks.json

**Threats Addressed**: T-0006 (unbounded self-correction loop)

**Mechanism**: Cursor enforces the loop_limit — after the specified number of self-correction re-entries via `followup_message`, Cursor stops re-invoking the agent.

**Implementation Requirements**:
- Emitter generates stop hook entry with `loop_limit: 3` (recommended value; document the choice in emit.ts)
- t145 asserts `hooks.json` stop entry has `loop_limit` as a positive integer

---

### 2.2 Detective Controls

Controls that detect a security incident after it occurs.

#### DC-1: Byte-Parity Drift Guard

**Control**: `bun scripts/package.ts --check` detects any deviation between source and committed dist/

**Threats Addressed**: T-0001 (tampered distribution), T-0010 (hand-edited dist/)

**Mechanism**: Packager builds into a temp directory and byte-compares all files against committed `dist/cursor/`. Reports MISSING, DIFFERS, and ORPHAN files. Exits 1 on any difference.

**Implementation Requirements**:
- CI pipeline (`ci.yml`) runs `--check` on every push to the feature branch
- `--check` must be a required status check (not optional)
- Local development documentation should remind developers to run `--check` before raising a CR

---

#### DC-2: File Edit Audit Trail

**Control**: `afterFileEdit` hook logs all agent file edits to audit shards in `aidlc/`

**Threats Addressed**: T-0004 (prompt injection — audit evidence after the fact), T-0010 (hand-edited dist/)

**Mechanism**: Every file write by the Cursor agent fires `afterFileEdit`, which the adapter pipes to `aidlc-audit-logger.ts`. Audit records are appended to shard files keyed by session.

**Limitations**: `afterFileEdit` is fail-open (advisory). If the audit logger crashes, the audit record is lost. This is by design — audit failure must not block the agent.

---

#### DC-3: Git History

**Control**: All source files (`harness/cursor/`, `core/`, `dist/cursor/`) tracked in git with code review for changes to hook bodies

**Threats Addressed**: T-0007 (compromised core hook), T-0001 (tampered distribution)

**Mechanism**: `git diff`, `git log`, and code review visibility. Changes to `core/hooks/` must pass code review before merging.

**Implementation Requirements**:
- Require two reviewers for changes to `core/hooks/aidlc-state-transition-guard.ts`
- Conventional commit messages make the intent of changes readable in `git log`
- CRUX code review is the standard process (see Amazon-builder-crux rules)

---

### 2.3 Corrective Controls

Controls that correct or recover from a security incident.

#### CC-1: Distribution Regeneration

**Control**: `bun scripts/package.ts cursor` regenerates the complete dist/ from source in seconds

**Threats Addressed**: T-0001 (tampered distribution recovery), T-0010 (hand-edited dist/ recovery)

**Mechanism**: If a tampered or corrupted dist/ is detected via the drift guard, regenerating from source restores a clean distribution immediately.

**Recovery Procedure**:
1. Identify drift via `bun scripts/package.ts --check` output
2. Run `bun scripts/package.ts cursor` to regenerate
3. Run `--check` again to confirm clean state
4. Commit regenerated dist/
5. Investigate the cause of drift via `git log --all` and `git diff`

---

## 3. Control Priority Matrix

| Priority | Controls | Rationale |
|----------|----------|-----------|
| Critical — implement before any distribution | PC-1 (failClosed), PC-3 (adapter tests), DC-1 (drift guard as CI gate) | These three controls prevent the most severe threats (T-0002, T-0003) and detect tampering (T-0001) |
| High — implement with initial feature delivery | PC-2 (cli.json deny list), PC-4 (reviewer scope gate), PC-5 (process.execPath), PC-6 (loop_limit) | Complete the security posture of the feature; all required by architecture |
| Medium — implement as hardening after initial delivery | DC-2 (audit trail), DC-3 (git review policy), CC-1 (documented recovery) | Advisory or process controls; valuable but not blocking |

---

## 4. AWS Security Controls Mapping

This project has no AWS infrastructure. The following mapping applies to developer security practices that align with AWS security principles:

| AWS Well-Architected Security Pillar | Applicable Control | Notes |
|--------------------------------------|-------------------|-------|
| SEC-01: Implement strong identity | Not applicable | Local file system only |
| SEC-02: Enable traceability | DC-2 (audit trail), DC-3 (git history) | Audit shards and git log provide traceability |
| SEC-03: Apply security at all layers | PC-1 + PC-2 (dual gate: hook + CLI) | Defense-in-depth: two independent permission layers |
| SEC-04: Automate security best practices | DC-1 (CI drift guard), PC-3 (automated tests) | CI enforces security controls automatically |
| SEC-05: Protect data in transit | Not applicable | No network; all local |
| SEC-06: Protect data at rest | OS file permissions | Workflow state and audit shards protected by OS-level permissions |
| SEC-07: Prepare for security events | CC-1 (regeneration procedure), DC-3 (git history) | Documented incident recovery |

---

*Document end. Cross-reference: security/threat-analysis.md (STRIDE threat model), security/testing-framework.md (test cases), security/implementation-guidance.md (development guidance).*

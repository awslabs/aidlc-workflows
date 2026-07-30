# Security Testing Framework: Cursor Harness for AI-DLC Workflows 2.0

**Document Version**: 1.0
**Last Updated**: 2026-07

---

## Overview

This document defines the security testing strategy for the Cursor harness. All testing is local developer tooling testing — there are no cloud services, no network endpoints, and no external APIs to test. The security surface is the hook-based gating mechanism, the CLI permission list, and the integrity of the generated distribution.

All tests run via `bun tests/run-tests.ts` following the established codebase pattern.

---

## 1. Testing Strategy

### Testing Phases

| Phase | Scope | When | Tools |
|-------|-------|------|-------|
| Unit — Hook Adapter Contract | adapter translation correctness, fail-open/fail-close | Every commit | bun test, spawnSync subprocess shim |
| Unit — Packaging Parity | hooks.json security fields, cli.json deny list, loop_limit | Every commit | bun test, packager subprocess |
| Integration — Gate Behavioral | guard hook denies dangerous commands | Feature branch CI | bun test, subprocess fixture corpus |
| Manual — End-to-End Gate | Copy dist/ into scratch project, attempt blocked commands in Cursor | Before PR | Cursor IDE / cursor-agent CLI |

### Test File Locations

| Test File | Tier | Tests |
|-----------|------|-------|
| `tests/unit/t145-cursor-packaging.test.ts` | Unit | Packaging parity, security field assertions |
| `tests/unit/t146-cursor-hook-adapter.test.ts` | Unit | Adapter contract, fail-open/fail-close |
| `tests/integration/t147-cursor-guard-logic.test.ts` | Integration | Guard hook denial assertions |

---

## 2. Test Cases

### 2.1 Security Gate Configuration Tests (t145)

These tests verify that the generated hooks.json and cli.json contain correct security-critical values.

#### TC-SEC-001: hooks.json beforeShellExecution has failClosed:true

**Test**: Parse generated `.cursor/hooks.json` and assert the `beforeShellExecution` entry has `"failClosed": true`

**Threat**: T-0002 (gate removal), T-0003 (adapter bug)

**Expected**: `hooks[event === "beforeShellExecution"].failClosed === true`

**Fail Condition**: failClosed missing, false, or undefined

```typescript
// t145 example assertion
const hooks = JSON.parse(readFileSync("dist/cursor/.cursor/hooks.json", "utf8"));
const shellHook = hooks.hooks.find((h: any) => h.event === "beforeShellExecution");
assert(shellHook?.failClosed === true, "beforeShellExecution must have failClosed:true");
```

---

#### TC-SEC-002: hooks.json preToolUse has failClosed:true

**Test**: Parse generated `.cursor/hooks.json` and assert the `preToolUse` entry has `"failClosed": true`

**Threat**: T-0005 (reviewer reads outside scope)

**Expected**: `hooks[event === "preToolUse"].failClosed === true`

**Fail Condition**: failClosed missing, false, or undefined

---

#### TC-SEC-003: hooks.json stop hook has loop_limit as positive integer

**Test**: Parse `.cursor/hooks.json` and assert the stop hook entry has `loop_limit` as a positive integer

**Threat**: T-0006 (unbounded self-correction loop)

**Expected**: `typeof hooks[event === "stop"].loop_limit === "number" && hooks[...].loop_limit > 0`

**Fail Condition**: loop_limit missing, zero, or non-integer

---

#### TC-SEC-004: cli.json deny list contains required patterns

**Test**: Parse generated `.cursor/cli.json` and assert it contains deny patterns for destructive operations

**Threat**: T-0002 (gate removal in CLI mode), T-0004 (prompt injection in CLI mode)

**Expected**: Deny list includes patterns matching: `rm -rf *`, `git push *`, `git reset --hard *`, `curl *`, `wget *`

**Fail Condition**: Any of the five patterns absent from deny list

```typescript
// t145 example assertion
const cli = JSON.parse(readFileSync("dist/cursor/.cursor/cli.json", "utf8"));
const denyList: string[] = cli.rules?.deny ?? [];
const requiredDenies = ["rm -rf", "git push", "git reset --hard", "curl", "wget"];
for (const pattern of requiredDenies) {
  assert(
    denyList.some(d => d.includes(pattern)),
    `cli.json deny list must include pattern matching: ${pattern}`
  );
}
```

---

#### TC-SEC-005: No .cursorrules legacy file in dist/

**Test**: Assert `dist/cursor/.cursorrules` does not exist

**Threat**: Not a direct security threat but ensures correct format (NFR-100)

**Expected**: File does not exist

---

#### TC-SEC-006: preToolUse matcher covers all file-reading tools

**Test**: Parse hooks.json preToolUse entry and assert matcher regex covers Read, LS, Glob, Grep

**Threat**: T-0005 (scope gate bypass via uncovered tool)

**Expected**: matcher string contains `Read` and `LS` and `Glob` and `Grep`

---

### 2.2 Hook Adapter Contract Tests (t146)

These tests verify the adapter's security-critical translations using subprocess shim testing (spawnSync, not in-process). All tests operate on `dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts`.

#### TC-SEC-010: beforeShellExecution — core exits 2 → permission:deny

**Test**: Invoke adapter with `beforeShellExecution` payload; mock core hook to exit 2 with reason on stderr

**Threat**: T-0003 (adapter logic bug causes fail-open)

**Input**:
```json
{"hook_event_name": "beforeShellExecution", "command": "rm -rf .", "cwd": "/tmp/test"}
```

**Expected**: stdout is valid JSON with `permission: "deny"`, non-empty `user_message` and `agent_message`; exit code 0

**Fail Condition**: stdout missing, exit code non-zero, or permission is not "deny"

---

#### TC-SEC-011: beforeShellExecution — core exits 0 → permission:allow

**Test**: Invoke adapter with `beforeShellExecution` payload; mock core hook to exit 0 with empty stdout

**Threat**: Regression test — ensure valid commands are not incorrectly denied

**Input**:
```json
{"hook_event_name": "beforeShellExecution", "command": "git status", "cwd": "/tmp/test"}
```

**Expected**: exit code 0; stdout either empty or `{permission: "allow"}`

---

#### TC-SEC-012: Malformed stdin → fail-open (exit 0, empty stdout)

**Test**: Invoke adapter with non-JSON stdin on the `beforeShellExecution` path

**Threat**: T-0003 (fail-open on malformed input)

**Input**: `"{not valid json"` on stdin

**Expected**: exit code 0, empty stdout; operation treated as allowed by Cursor

**Note**: For `failClosed:true` hooks, Cursor itself blocks on any non-zero exit from adapter. This test verifies the adapter's own behavior for the case where it cannot parse input.

---

#### TC-SEC-013: beforeShellExecution — core exits 2 with empty stderr → permission:deny still sent

**Test**: Invoke adapter with `beforeShellExecution`; mock core to exit 2 with empty stderr

**Threat**: T-0003 edge case — adapter must deny even when reason is empty

**Expected**: stdout `{permission: "deny", user_message: "", agent_message: ""}` or similar; exit 0

**Fail Condition**: No deny sent when core exits 2 with empty stderr

---

#### TC-SEC-014: preToolUse — core exits 2 → permission:deny

**Test**: Invoke adapter with `preToolUse` payload for Read tool; mock core to exit 2

**Threat**: T-0005 (reviewer scope gate bypass)

**Input**:
```json
{"hook_event_name": "preToolUse", "tool_name": "Read", "tool_input": {"file_path": "/secret/.env"}}
```

**Expected**: stdout `{permission: "deny", ...}`; exit 0

---

#### TC-SEC-015: Session-start fires only on first prompt (first-prompt detection)

**Test**: Invoke adapter twice with the same `conversation_id` via `beforeSubmitPrompt`; verify session-start core hook is called only once

**Threat**: T-0008 (duplicate session init)

**Expected**: Core `aidlc-session-start.ts` invoked on first call only; second call with same conversation_id produces no session-start invocation

---

#### TC-SEC-016: process.execPath used for subprocess (not bare "bun")

**Test**: Inspect adapter source code; assert no spawnSync/spawn call uses `"bun"` as the executable string

**Threat**: T-0009 (PATH injection)

**Expected**: All subprocess invocations use `process.execPath`

```typescript
const adapterSource = readFileSync(
  "harness/cursor/hooks/aidlc-cursor-adapter.ts",
  "utf8"
);
assert(!adapterSource.includes('spawnSync("bun"'), "Must use process.execPath, not bare bun");
assert(!adapterSource.includes("spawn(\"bun\""), "Must use process.execPath, not bare bun");
```

---

### 2.3 Guard Logic Tests (t147-cursor-guard-logic.test.ts — Integration)

These tests verify that `aidlc-state-transition-guard.ts` denies a representative set of dangerous commands.

#### TC-SEC-020: Guard denies rm -rf *

**Test**: Send `{hook_event_name:"PreToolUse", tool_name:"Bash", tool_input:{command:"rm -rf ."}}` to guard hook; assert exit code 2

---

#### TC-SEC-021: Guard denies git push --force

**Test**: Send `git push --force origin main` command to guard; assert exit code 2

---

#### TC-SEC-022: Guard denies git reset --hard

**Test**: Send `git reset --hard HEAD~10` to guard; assert exit code 2

---

#### TC-SEC-023: Guard denies curl (outbound network)

**Test**: Send `curl http://example.com` to guard; assert exit code 2

---

#### TC-SEC-024: Guard denies wget

**Test**: Send `wget http://example.com` to guard; assert exit code 2

---

#### TC-SEC-025: Guard allows git status (safe read-only)

**Test**: Send `git status` to guard hook in a state that allows it; assert exit code 0

**Note**: This is a regression test — ensure the guard does not over-deny safe commands.

---

### 2.4 Manual Security Validation Tests

These tests cannot be automated and must be performed manually before raising the CR.

#### TC-SEC-030: Cursor IDE — beforeShellExecution blocks dangerous command

**Procedure**:
1. Copy `dist/cursor/` into a scratch project
2. Open scratch project in Cursor IDE
3. Invoke `/aidlc` to start a session
4. Instruct agent: "Run: rm -rf ."
5. **Expected**: Cursor shows a block message with the reason; file deletion does not occur

**Pass Criteria**: Agent cannot execute `rm -rf .` in any state

---

#### TC-SEC-031: cursor-agent CLI — cli.json deny list blocks git push

**Procedure**:
1. Copy `dist/cursor/` into a scratch project with a git remote configured
2. Run `cursor-agent` in CLI mode
3. Instruct agent: "Push the current branch to origin"
4. **Expected**: CLI agent receives permission denied from cli.json; push does not execute

**Pass Criteria**: `git push` is blocked without prompting

---

#### TC-SEC-032: Reviewer scope gate limits file reads

**Procedure**:
1. Set up scratch project with a `.env` file at root containing `SECRET=test`
2. Configure a reviewer task with scope limited to `src/`
3. Attempt to read `.env` via the reviewer subagent
4. **Expected**: preToolUse hook blocks the read; agent receives deny message

**Pass Criteria**: `.env` content is not returned to the reviewer subagent

---

#### TC-SEC-033: Byte-parity guard detects hand-edited hooks.json

**Procedure**:
1. Edit `dist/cursor/.cursor/hooks.json` to remove `failClosed:true`
2. Run `bun scripts/package.ts --check`
3. **Expected**: Exit code 1; DIFFERS report for hooks.json

**Pass Criteria**: Drift guard catches the modification

---

## 3. Test Success Criteria

| Category | Threshold |
|----------|-----------|
| All automated security tests (TC-SEC-001 to TC-SEC-025) | 100% pass |
| Manual validation tests (TC-SEC-030 to TC-SEC-033) | 100% pass |
| No test timeouts on hook adapter tests | All complete within 5 seconds |
| No regressions in existing test suite | `bun tests/run-tests.ts` exits 0 |

---

## 4. Remediation Procedures

When a security test fails:

| Test Failure | Likely Root Cause | Remediation |
|--------------|-------------------|-------------|
| TC-SEC-001/002: failClosed missing | emit.ts did not include field | Fix emit.ts; re-run packager; re-run test |
| TC-SEC-010/014: permission:allow returned | Adapter exit-code mapping bug | Fix adapter; re-run t146 |
| TC-SEC-012: Non-zero exit on malformed stdin | Missing try/catch in adapter | Add try/catch; re-run t146 |
| TC-SEC-020–024: Guard allows dangerous command | Guard logic missing pattern | Fix guard; re-run t147 |
| TC-SEC-033: Drift guard does not detect edit | Packager --check bug | Investigate diffTrees logic; fix; re-run |
| Any manual test failure | Integration gap | Debug with adapter log output; trace from Cursor hook event through adapter to core hook |

---

*Document end. Cross-reference: security/threat-analysis.md (STRIDE threat model), security/security-controls.md (control descriptions), security/implementation-guidance.md (developer checklist).*

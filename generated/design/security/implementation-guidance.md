# Security Implementation Guidance: Cursor Harness for AI-DLC Workflows 2.0

**Document Version**: 1.0
**Last Updated**: 2026-07

---

## Overview

This document provides security implementation guidance for the development team implementing the Cursor harness. It covers integration points, implementation order, a development checklist, and validation procedures. All guidance is for local developer tooling — no cloud infrastructure or network security controls apply.

---

## 1. Architecture Security Integration Points

The following components have security-critical implementation requirements. Read this section before writing any of the five authored files.

### 1.1 aidlc-cursor-adapter.ts — The Security Boundary

This is the most security-critical file in the harness. Every security gate goes through it.

**Security-critical requirements**:

1. **Permission deny mapping** (blocks T-0003): When a core hook exits with code 2, the adapter MUST write `{permission: "deny", user_message: "<stderr text>", agent_message: "<stderr text>"}` to stdout and exit 0. This is the Cursor block contract per ADR-003.

2. **Fail-open on malformed input** (prevents false positives): Wrap all JSON.parse calls in try/catch. On any parse error, exit 0 with no output. This is intentional for non-failClosed hooks.

3. **process.execPath for subprocess invocation** (blocks T-0009): Use `process.execPath` as the executable for all spawnSync/spawn calls. Never use the bare string `"bun"`.

4. **First-prompt detection** (for session init correctness): Track whether `aidlc-session-start.ts` has been fired for a given `conversation_id`. Store the marker in `aidlc/spaces/default/memory/` as a file named by conversation_id hash. Only fire session-start once per conversation.

5. **Field naming is snake_case**: Cursor's hook payloads use snake_case (`user_message`, `agent_message`, `conversation_id`). Do not use camelCase. Verified in ADR-003 research.

```typescript
// Minimal correct pattern for the permission:deny path
async function handleBeforeShellExecution(payload: CursorHookPayload): Promise<void> {
  const corePayload = mapToPreToolUse(payload);
  const result = spawnSync(process.execPath, [coreHookPath, "state-transition-guard"], {
    input: JSON.stringify(corePayload),
    encoding: "utf8",
  });
  if (result.status === 2) {
    const reason = result.stderr?.trim() ?? "";
    process.stdout.write(
      JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason })
    );
  }
  // exit 0 in all cases (Cursor contract)
  process.exit(0);
}
```

---

### 1.2 emit.ts — Security-Critical Generated Files

The emitter generates hooks.json and cli.json. Their security-critical fields must be hardcoded, not configurable.

**hooks.json security requirements**:

```typescript
// Required shape for security-critical hook entries
const securityHooks = [
  {
    event: "beforeShellExecution",
    command: `${process.execPath} .cursor/hooks/aidlc-cursor-adapter.ts state-transition-guard`,
    failClosed: true,  // REQUIRED — never omit
  },
  {
    event: "preToolUse",
    matcher: "Read|LS|Glob|Grep",
    command: `${process.execPath} .cursor/hooks/aidlc-cursor-adapter.ts reviewer-scope`,
    failClosed: true,  // REQUIRED — never omit
  },
  {
    event: "stop",
    command: `${process.execPath} .cursor/hooks/aidlc-cursor-adapter.ts stop`,
    loop_limit: 3,     // REQUIRED — prevents unbounded self-correction
    // failClosed intentionally omitted (stop hook is fail-open by design)
  },
  {
    event: "beforeSubmitPrompt",
    command: `${process.execPath} .cursor/hooks/aidlc-cursor-adapter.ts session-start`,
    // failClosed intentionally omitted (session init is advisory)
  },
  {
    event: "afterFileEdit",
    command: `${process.execPath} .cursor/hooks/aidlc-cursor-adapter.ts audit-and-sensors`,
    // failClosed intentionally omitted (audit is advisory)
  },
];
```

**cli.json security requirements**:

```typescript
// ponytail: deny list is minimal-sufficient; add patterns only if they pass code review
const cliPermissions = {
  rules: {
    allow: [
      "bun *",
      "git add *",
      "git commit *",
      "git status",
      "git status *",
      "git log *",
      "git diff *",
      "git branch",
      "git branch *",
      "git checkout *",
    ],
    deny: [
      "rm -rf *",
      "rm -r *",
      "git push *",
      "git push",
      "git reset --hard *",
      "git reset --hard",
      "curl *",
      "wget *",
      "chmod *",
      "sudo *",
    ],
  },
};
```

---

### 1.3 skills/aidlc/SKILL.md — Reviewer Scope Instructions

The orchestrator skill must contain explicit guidance on minimal scope declaration for reviewer tasks. This is the primary defense against T-0005 (reviewer reads secrets).

**Required prose addition** (add to the reviewer delegation section of SKILL.md):

```markdown
When delegating to a reviewer subagent, you MUST declare an explicit, minimal read scope
limited to the specific files or directory being reviewed. Do NOT use the project root as scope.

Example (correct):
  scope: src/components/auth/

Example (incorrect — too broad):
  scope: ./ (project root)

The preToolUse security gate will enforce this scope. Any read outside the declared scope
will be blocked and logged.
```

---

### 1.4 dot-gitignore — Protecting Developer Credentials

The `.gitignore` shipped in dist/cursor/ (as `dot-gitignore`) must exclude common secret file patterns to reduce the risk of credentials entering the agent's accessible workspace.

**Required additions to dot-gitignore**:

```gitignore
# Developer credentials — exclude from agent workspace
.env
.env.*
*.pem
*.key
*.p12
*.pfx
*.crt
.aws/credentials
.aws/config
~/.ssh/
```

---

## 2. Implementation Order and Dependencies

Implement security controls in this order to avoid integration blockers:

| Step | Task | Depends On | Security Impact |
|------|------|------------|-----------------|
| 1 | Write `harness/cursor/manifest.ts` (no security changes required) | None | Low |
| 2 | Write `harness/cursor/emit.ts` with correct hooks.json security fields | manifest.ts | High — generates the gate config |
| 3 | Write `aidlc-cursor-adapter.ts` with permission:deny mapping and process.execPath | emit.ts (for path references) | Critical — the security boundary |
| 4 | Write `skills/aidlc/SKILL.md` with reviewer scope instructions | adapter complete | High — prevents T-0005 |
| 5 | Run packager: `bun scripts/package.ts cursor` | all authored files | — |
| 6 | Write `tests/unit/t145-cursor-packaging.test.ts` with security assertions (TC-SEC-001 to TC-SEC-006) | dist/cursor/ generated | High — verifies gate config |
| 7 | Write `tests/unit/t146-cursor-hook-adapter.test.ts` (TC-SEC-010 to TC-SEC-016) | dist/cursor/ generated | Critical — verifies adapter logic |
| 8 | Write `tests/integration/t147-cursor-guard-logic.test.ts` (TC-SEC-020 to TC-SEC-025) | dist/cursor/ generated | High — verifies guard denials |
| 9 | Run full test suite: `bun tests/run-tests.ts` | all tests written | — |
| 10 | Manual validation (TC-SEC-030 to TC-SEC-033) | dist/ in scratch project | — |
| 11 | Configure CI (`ci.yml`) to run `--check` and full test suite | CI access | Medium — drift detection |

---

## 3. Development Team Security Checklist

Before raising a CR, verify every item:

### Adapter Implementation
- [ ] All spawnSync/spawn calls use `process.execPath`, not `"bun"`
- [ ] JSON.parse wrapped in try/catch on every stdin read path
- [ ] On try/catch exception: exit 0, empty stdout (fail-open for non-failClosed hooks)
- [ ] When core exits 2: stdout is `{permission:"deny", user_message:..., agent_message:...}`, exit 0
- [ ] When core exits 0: exit 0, no deny JSON
- [ ] First-prompt detection: session-start fires only once per `conversation_id`
- [ ] No camelCase fields in output JSON (`user_message` not `userMessage`)

### hooks.json (generated by emit.ts)
- [ ] `beforeShellExecution` entry has `"failClosed": true`
- [ ] `preToolUse` entry has `"failClosed": true`
- [ ] `preToolUse` entry has matcher: `"Read|LS|Glob|Grep"` (or superset)
- [ ] `stop` entry has `"loop_limit": 3` (or other positive integer — document choice)
- [ ] `beforeSubmitPrompt` and `afterFileEdit` entries do NOT have `failClosed` (intentionally fail-open)

### cli.json (generated by emit.ts)
- [ ] Deny list contains: `rm -rf *` (or equivalent)
- [ ] Deny list contains: `git push *`
- [ ] Deny list contains: `git reset --hard *`
- [ ] Deny list contains: `curl *`
- [ ] Deny list contains: `wget *`
- [ ] Deny list contains: `sudo *`

### dot-gitignore
- [ ] Excludes: `.env`, `.env.*`, `*.pem`, `*.key`, `.aws/credentials`

### SKILL.md
- [ ] Reviewer delegation section includes explicit minimal-scope guidance
- [ ] Instructions do not suggest using project root as reviewer scope

### Tests
- [ ] t145: TC-SEC-001 through TC-SEC-006 all pass
- [ ] t146: TC-SEC-010 through TC-SEC-016 all pass
- [ ] t147: TC-SEC-020 through TC-SEC-025 all pass
- [ ] `bun tests/run-tests.ts` exits 0 (no regressions)

### Distribution Integrity
- [ ] `bun scripts/package.ts cursor` completes without error
- [ ] `bun scripts/package.ts --check` exits 0
- [ ] CI pipeline configured to run `--check` as required status check

### Manual Validation
- [ ] TC-SEC-030: IDE blocks `rm -rf .` attempt
- [ ] TC-SEC-031: CLI blocks `git push`
- [ ] TC-SEC-032: Reviewer scope gate blocks out-of-scope read
- [ ] TC-SEC-033: Drift guard detects manual hooks.json edit

---

## 4. Security Validation Procedures

### Validating the Hook Gate End-to-End

```bash
# 1. Generate distribution
bun scripts/package.ts cursor

# 2. Create scratch project
mkdir /tmp/cursor-security-test
cp -r dist/cursor/. /tmp/cursor-security-test/
cd /tmp/cursor-security-test
git init

# 3. Run doctor check
bun .cursor/tools/aidlc-utility.ts doctor
# Expected: all checks pass

# 4. Verify drift guard
echo '{}' > .cursor/hooks.json  # tamper with hooks.json
bun scripts/package.ts --check  # from aidlc-workflows repo
# Expected: exit 1, DIFFERS for hooks.json

# 5. Restore
bun scripts/package.ts cursor
bun scripts/package.ts --check  # Expected: exit 0
```

### Validating Adapter Security Properties

```bash
# From the aidlc-workflows repo root, after generating dist/cursor/

# TC-SEC-010: Verify permission:deny is produced when core exits 2
echo '{"hook_event_name":"beforeShellExecution","command":"rm -rf .","cwd":"/tmp"}' | \
  MOCK_CORE_EXIT=2 MOCK_CORE_STDERR="blocked: no active workflow" \
  bun dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts state-transition-guard
# Expected stdout: {"permission":"deny","user_message":"blocked: no active workflow",...}
# Expected exit: 0

# TC-SEC-012: Verify fail-open on malformed input
echo '{not json}' | \
  bun dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts state-transition-guard
# Expected stdout: empty
# Expected exit: 0
```

---

## 5. Security Anti-Patterns to Avoid

| Anti-Pattern | Risk | Correct Approach |
|---|---|---|
| Using `"bun"` as subprocess executable | T-0009 PATH injection | Use `process.execPath` |
| Omitting try/catch around stdin parse | Non-zero exit blocks operation via failClosed | Wrap all parse in try/catch |
| Setting failClosed on audit/session hooks | Over-blocking — audit failure should not block workflow | Only beforeShellExecution and preToolUse get failClosed:true |
| Broad reviewer scope (project root) | T-0005 credentials exposure | Always use specific subdirectory or file list |
| Omitting loop_limit from stop hook | T-0006 unbounded loop | Always include loop_limit: 3 |
| Exit non-zero from adapter on deny | Incorrect — Cursor expects exit 0 + JSON | Always exit 0; use JSON stdout for deny |
| Using camelCase in permission:deny JSON | Silent failure — Cursor ignores wrong field names | Use snake_case: `user_message`, `agent_message` |
| Hand-editing dist/cursor/ | T-0010 drift detected by CI | Edit harness/ sources; run packager |

---

*Document end. Cross-reference: security/threat-analysis.md (STRIDE threats), security/security-controls.md (control descriptions), security/testing-framework.md (test cases).*

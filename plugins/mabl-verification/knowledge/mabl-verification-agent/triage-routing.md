# Triage Routing

Methodology knowledge for deciding what the verification loop does next after a
failure is classified. Enforces loop bounds and human gates.

## Routing Table

| `class` | `action` | `autoApply` | `requiresHumanGate` | Next Step |
|---------|----------|-------------|---------------------|-----------|
| `product` | `propose-code-fix` | **false** | **true** | Present the diff; on approval apply → re-run |
| `stale-test` | `edit-test` | true | false | Edit selector/assertion → promote to master → re-run |
| `env-data` | `reset-env` | true | false | Reset seed/creds/precondition → re-run |
| `mabl-flake` | `retry` | true | false | `rerun_mabl_test` once; if heals, flag drift; if re-fails, reclassify |

## Inviolable Rules

1. **Never auto-apply a product-code change.** Always `autoApply: false` +
   `requiresHumanGate: true`, even at high confidence. Product logic is the user's
   to approve.

2. **Loop bound is non-negotiable.** If `iteration > maxIterations` (default 3),
   emit `action: "escalate"` immediately. Do this BEFORE any routing logic.

3. **Confidence floor.** If `failureVerdict.confidence < 0.6`, route to a human
   (`action: "escalate"`, `requiresHumanGate: true`). A low-confidence auto-repair
   is worse than asking.

4. **Promote before re-verify.** `edit-test` edits save to an authoring branch, not
   master. After editing: `list_mabl_test_versions` → `restore_mabl_test(version=<new>)`
   → THEN re-run. Without promotion, re-runs use old steps.

5. **Billable skip = effective pass.** If every concrete assertion passed and only
   the GenAI step is red, treat the repair as green. Only spend credits with explicit
   user go-ahead.

6. **Retry ≠ repair iteration.** A flake retry that heals does NOT consume a repair
   cycle. A "flake" that reproduces is reclassified — send back to RCA.

7. **Credit-spending is gated.** Anything that would spend mabl credits (billable AI
   reruns, cloud plan execution) requires user confirmation regardless of class.

## Loop Bound Mechanics

- **maxIterations:** 3 (default). Counts genuine repair attempts, not retries.
- **iteration:** incremented by the caller on each repair cycle.
- **Exhaustion:** emit `escalate` with summary of what was tried.

## Confidence Floor

- Default: 0.6
- Below floor → route to human, not auto-repair
- The floor prevents garbage-in/garbage-out: a wrong classification auto-repaired
  is harder to recover from than a human pause

## Post-Routing Actions

### `edit-test` (stale-test)
1. Identify the stale selector/assertion from the RCA evidence
2. Call `mabl_authoring_edit` with the test id and the fix description
3. Wait for edit completion (5–15 min)
4. Promote: `list_mabl_test_versions` → `restore_mabl_test`
5. Re-run locally to verify
6. If `autoHealCandidate: true`, note the selector drift for proactive source update

### `reset-env` (env-data)
1. Identify the precondition failure from the RCA evidence
2. Reset: un-track a stock, pick a guaranteed-available item, switch persona
3. Re-run locally to verify
4. Document the reset so it's reproducible

### `retry` (mabl-flake)
1. `rerun_mabl_test(testRunId, workspaceId)` via MCP
2. Poll `get_mabl_test_run` until terminal
3. If passes → flag selector drift as auto-heal candidate; done
4. If fails again → reclassify (not a flake); route back to RCA

### `propose-code-fix` (product)
1. Present the diff sketch from `suggestedFix`
2. STOP and wait for human approval
3. On approval → apply the fix → rebuild → re-run full verification
4. On rejection → escalate or revise

## Decision Output

Emit one `routerDecision` per input verdict:

```json
{
  "testId": "...",
  "testRunId": "...",
  "class": "stale-test",
  "action": "edit-test",
  "autoApply": true,
  "requiresHumanGate": false,
  "iteration": 1,
  "maxIterations": 3,
  "confidence": 0.85,
  "nextStep": "Edit selector [data-testid='dashboard-header'] → promote → re-run"
}
```

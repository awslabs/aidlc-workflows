# desktop-local-run — verdicts

First attended **Devin Desktop** acceptance of a complete AI-DLC Express
workflow — the agent ran inside Desktop's **Devin Local** harness (the
CLI-derived agent), not Cascade and not the standalone CLI REPL. Prior
attended runs in this campaign were Devin CLI (terminal) sessions; this run
closes the "Desktop execution" evidence gap for the doctor's new
Desktop-editor rows and the full stage graph on a native Windows host.

Environment and provenance: `README.md` / `00-environment.txt`. Source under
test: `feat/devin-harness` @ `1dfeb0cc` (the Desktop-editor doctor change
itself). Fixture: disposable greenfield repo, baseline `e7904d9`, post-run
`0632119`.

## Verdicts

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| V0 | Baseline | **PASS** — clean fixture at `e7904d9`, no seeded sources/state/markers; `devin 3000.11.1`, bun `1.3.14`, Python `3.13.14` | `00-environment.txt` |
| V1 | Desktop loads project + hooks execute | **PASS** — Devin Local session in the fixture workspace; SessionStart marker written at session start (12:14:00.925Z); doctor "Hooks last fired" lists 9 distinct hooks during the run | `01-doctor-pre-session.txt`, `02-doctor-in-session.txt`, `08-audit-shard.md` |
| V2 | Pre-run doctor | **PASS** — 0 problems inside the Desktop session; all three host rows pass incl. `Devin Desktop installation: found at …\Programs\Devin\Devin.exe` | `02-doctor-in-session.txt` |
| V3 | Native questions + stage gates | **PASS** — `QUESTION_ANSWERED` ×2, `SUMMARY_CONFIRMATION_RECORDED` (questions SHA-256 + authorization id), `GATE_APPROVED` ×3 (requirements-analysis, code-generation, build-and-test), paginated learnings cards ×2 | `08-audit-shard.md` |
| V4 | Plan-approval authority | **PASS** — `PLAN_APPROVAL_RECORDED` 12:47:38Z with approval fingerprint, questions-file hash, directive epoch; `PLAN_APPROVAL_BLOCKED` ×3 prove the guard intercepts before approval (incl. an `aidlc-developer-agent` dispatch) | `08-audit-shard.md` |
| V5 | Developer subagent executes | **PASS** — `SUBAGENT_COMPLETED` ×1 for `aidlc-developer-agent`; dispatch visible in the session UI | `08-audit-shard.md` |
| V6 | Product behavior | **PASS** — `python hello.py` prints exactly `ok` | `03-program.txt` |
| V7 | Tests | **PASS** — `python -m unittest -v`: `test_prints_ok … ok`, Ran 1 test, OK | `04-tests.txt` |
| V8 | Workflow completion + consistency | **PASS** — exactly one `WORKFLOW_COMPLETED` (13:30:50Z, skip rationale recorded); state `Status: Completed`; state and audit reference the same intent `260923-hello-ok` | `05-status-after.txt`, `07-aidlc-state.md`, `08-audit-shard.md` |
| V9 | Post-run doctor | **PASS** — 0 failed, 64 passed, 4 advisory warnings (update cache, subagent model policy, plugin inventory, uncommitted records at capture time) | `06-doctor-after.json` |
| V10 | Evidence integrity | **PASS** — `MANIFEST.sha256` covers every artifact except itself; provenance records source commit, fixture baseline, capture time | `MANIFEST.sha256`, `00-environment.txt` |

**Overall: PASS** — end-to-end Express workflow executed and completed inside
Devin Desktop: hook execution, native questions, human plan authority,
developer-subagent delegation, code generation, verification, completion, and
consistent state/audit records.

## Findings

1. **`/hooks` does not exist in Desktop's Devin Local UI** — "Unknown
   command" observed. The Desktop-native equivalent is the **Open
   customizations** surface. Guide/docs mention `/hooks` without a Desktop
   caveat (updated in `docs/guide/harnesses/devin.md`); doctor fix text still
   says "inspect /hooks" — acceptable for CLI, worth a Desktop-aware wording
   pass later.
2. **Traceability sensor self-flags stage-level manifests** —
   `SENSOR_FAILED` with `reason: "unit must be a string when present"`: the
   stage-level (zero-Unit) run writes `"unit": null`, which the sensor's own
   schema rejects. All 9 upstream requirement IDs were covered; coverage is
   not the failure. Candidate upstream fix: emit the key only for unit-scoped
   runs, or relax the sensor schema for stage-level manifests.
3. **Guard stack held under real misuse** — 3 `PLAN_APPROVAL_BLOCKED`, 3
   refused malformed `aidlc-log answer` attempts (schema/cardinality/canonical
   file checks), and a `REVIEW_BUDGET_EXHAUSTED` refusal with structured
   recovery when the agent tried a review pass the stage doesn't allow.
4. **One `continue-workflow` hook drop** recorded (advisory fail-open) — drop
   record exists under the intent's hooks-health dir; not investigated
   further, not blocking.
5. **No separate hook-approval prompt was observed** in the Desktop session —
   hooks executed from session start under the shipped `config.json`
   pre-approvals / Bypass permission mode. Whether Desktop ever surfaces a
   hook-approval gate remains unverified (no prompt appeared to decline).

## Deviations from the fixture runbook

- Plan-approval gate card was approved without a filed screenshot; the
  `PLAN_APPROVAL_RECORDED` audit receipt covers the claim (disclosed, not
  reinterpreted).
- The runbook's intent-count step counted `.aidlc-engine` (framework scratch)
  as an intent directory; the capture was completed by selecting directories
  containing `aidlc-state.md`. The fixture runbook was corrected in the same
  commit series.
- UI screenshots are retained locally only (checksums in `README.md`); this
  campaign's committed evidence is text-only per the retained-artifact policy.

## Limits

- Single host (native Windows 11), single Desktop build/Devin Local bundle,
  single workflow. Nothing here certifies macOS/Linux Desktop layouts,
  Cascade, Restricted Mode behavior, sandboxed sessions, or non-express
  scopes.
- The Desktop editor row is filesystem discovery; Desktop execution itself is
  proven by this run's audit/state evidence, not by that row.
- Local-only UI captures will be deleted with the fixture; checksums preserve
  attributability of what was observed.

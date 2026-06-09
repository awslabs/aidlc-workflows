# MR2 number reconciliation

MR2 ports the source-branch `.test.ts` suite onto v0.6.1 without touching the
existing shell tests. The source suite has 116 `.test.ts`; three were already
ported and reconciled by MR0/MR1, so this MR checked out 113 files.

The first free numbers in the destination tree start at `t136`. The following
ported source tests used numbers that the v0.6.1 base already assigns to a
different subject, so MR2 renumbers them before later suffix-drop/fold work can
derive from a clean table.

| Source path | MR2 path | Destination owner of old number | Reason |
| --- | --- | --- | --- |
| `tests/feature/t122.cli.test.ts` | `tests/feature/t136.cli.test.ts` | `tests/workflow/t122-stop-hook-e2e.sh` | Source `t122` is the revision-loop cycle; destination `t122` is Stop-hook e2e. |
| `tests/feature/t123.cli.test.ts` | `tests/feature/t137.cli.test.ts` | `tests/smoke/t123-skills-spec-conformance.sh`, `tests/unit/t123-skills-spec-conformance.sh` | Source `t123` is failure injection; destination `t123` is skills spec conformance. |
| `tests/workflow/t127-scope-exclusion-counts.test.ts` | `tests/workflow/t138-scope-exclusion-counts.test.ts` | `tests/feature/t127-single-stage-invariant.sh` | Source `t127` is scope-exclusion counts; destination `t127` is the single-stage pointer invariant. |
| `tests/tui/t-tui-t128-revision-loop-idempotency.serial.tui.test.ts` | `tests/tui/t-tui-t139-revision-loop-idempotency.serial.tui.test.ts` | `tests/feature/t128-custom-runner.sh` | Source `t128` is revision-loop idempotency; destination `t128` is custom runner generation. |

Notes:

- The prompt's `t124` example was rechecked against disk: source B has
  `tests/feature/t124-runtime-graph-end-to-end.sh`, but no `t124*.test.ts`, so
  MR2 has no `t124` test file to port or renumber.
- Existing same-subject pairs such as `t118` engine differential and `t110` MCP
  server grants are intentionally left at their numbers.

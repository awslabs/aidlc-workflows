# Version baseline, binary discovery, and diagnostic evidence

**Finding:** DEVIN-13. **Status:** Implemented checks; not a full compatibility certification. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The port needed one support-floor definition and useful fresh-install diagnostics. A missing PATH entry, a broken binary, a successful historical hook run, and current hook approval must not be conflated.

## Current implementation

DEVIN_MIN_VERSION is [3000, 10, 21]; DEVIN_MIN_VERSION_STRING derives from it. Config diagnostics, AI-DLC doctor, and the opt-in live status test consume that shared baseline. It is a selected support policy, not the first release of every required host capability.

checkDevinVersion searches PATH first, then Desktop bundle candidates on supported platforms, and invokes the discovered binary's --version with a bounded timeout. Missing, nonzero exit, timeout, malformed output, below-floor, exact-floor, and newer versions are distinct outcomes. The current no-binary result fails; older proposals for an unconditional advisory are not the implemented policy.

Desktop discovery checks a candidate CLI binary, not the behavior of the running Desktop application. A PATH success also does not identify Desktop's own runtime. Desktop execution remains separately unverified.

After a successful core SessionStart hook and an actual SessionStart payload, the adapter writes .devin/.aidlc-session-start.local.json with only lastRun. The marker is gitignored and never pre-seeded in the distribution. Failed marker writes warn but do not suppress context output.

Doctor requires a canonical timestamp in that marker; missing, unreadable, or malformed evidence fails. It does not create evidence, impose an expiry threshold, query current hook approval, or resist manual fabrication. A valid marker passes only the historical execution-evidence check. `/hooks` is documented as listing loaded hooks and their sources; operational approve-if-prompted/full-restart guidance is not an approval-state API.

For existing installations, update adapter and doctor together, preserve local policy, merge the ignore entry, and restart to collect actual SessionStart evidence. Do not fabricate the marker or infer approval from workspace trust.

## Evidence and limits

t334 exercises injected discovery/execution and numeric comparison. t294 checks the shared diagnostics floor. t331/t332 exercise absent/valid/invalid markers and adapter behavior in fixtures. None is an authenticated live-host, organization-model, Desktop, or complete workflow certification.

The opt-in status test covers only no-workflow status and absence of workflow scaffolding. A skipped test is not a passing live compatibility check; see DEVIN-14.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Version boundaries | All consumers share the same numeric floor and reject known old or broken binaries | t334-devin-version; t294-config-diagnostics |
| Discovery | PATH precedes Desktop; checked source/path is reported without claiming Desktop execution | t334 discovery table |
| Fresh/invalid execution marker | Doctor fails without creating evidence; packaging contains no marker | t331 doctor/ignore tests |
| Valid SessionStart | Successful target writes/refreshes canonical timestamp; failed core or wrong event does not | t332 SessionStart cases |
| Current approval or revocation | Do not infer from historical lastRun; inspect actual host behavior | Live verification gap; no supported approval-state API established |

## Superseded approaches and history

`801507ad` introduced the version/discovery helper. `5e3fcfce` unified and raised the floor. `a51bf1eb` replaced the unconditional fresh-install hook reminder with historical execution evidence. `6e208f7b` repaired the diagnostics test's literal-type inference.

Retired: multiple independent floors; the selected baseline proves a specific vendor bug was fixed; a discovered Desktop binary proves Desktop hooks work; doctor green means current hook approval; historical pre-existing typecheck failures remain current after their fix. Ordinary feature/docs work now follows upstream's release-preparation-only metadata policy, not the old per-fix version-bump recipes.

## Sources

- `core/tools/aidlc-devin-version.ts`
- `core/tools/aidlc-config-diagnostics.ts` — HARNESS_CLI, probeHarnessCli
- `core/tools/aidlc-utility.ts` — Devin diagnostics
- `harness/devin/hooks/aidlc-devin-adapter.ts` — session-start
- `harness/devin/dot-gitignore`
- `tests/unit/t334-devin-version.test.ts`
- `tests/unit/t294-config-diagnostics.test.ts`
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- `tests/e2e/t-exec-devin-status.serial.test.ts`
- `AGENTS.md` — Release Metadata Policy
- https://docs.devin.ai/cli/extensibility/hooks/overview

[Back to findings index](index.md)

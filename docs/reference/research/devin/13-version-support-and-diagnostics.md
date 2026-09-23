# Version baseline, binary discovery, and diagnostic evidence

**Finding:** DEVIN-13. **Status:** Implemented checks; not a full compatibility certification. **Source baseline:** `79cf8498`. **Fact-checked:** 2026-09-22 (doctor rows, install layouts, and test hermeticity re-verified during the PR #996 Item 7 work).

## Why this was needed

The port needed one support-floor definition and useful fresh-install diagnostics. A missing PATH entry, a broken binary, a successful historical hook run, and current hook approval must not be conflated.

## Current implementation

DEVIN_MIN_VERSION is [3000, 10, 21]; DEVIN_MIN_VERSION_STRING derives from it. Config diagnostics, AI-DLC doctor, and the opt-in live status test consume that shared baseline. It is a selected support policy, not the first release of every required host capability.

checkDevinVersion searches PATH only (the standalone CLI) and invokes the discovered binary's --version with a bounded timeout. Missing, nonzero exit, timeout, malformed output, below-floor, exact-floor, and newer versions are distinct outcomes. A missing standalone CLI is an advisory warning — Devin Desktop-only use is supported — while a discovered binary that is broken, unparseable, or below the floor is a hard failure even when Desktop is also installed. The separate `Devin host availability` row owns the hard failure when neither host exists.

The same fact is reported twice on a Devin project: the shared machine-section `Harness CLI: devin …` row (warn when missing or below floor; the shared floor in `HARNESS_CLI.devin.minimumVersion`) and the Devin-specific `devin CLI …` row. The Devin-specific row adds a bounded timeout and distinct error classes; like the shared row, a missing standalone CLI now warns rather than fails, because host availability is the row that turns neither-host-found into a red doctor.

Desktop discovery checks the actual editor application — `%LOCALAPPDATA%\Programs\Devin\Devin.exe` then `%ProgramFiles%\Devin\Devin.exe` on Windows, `/Applications/Devin.app` then `~/Applications/Devin.app` on macOS, `/usr/bin/devin-desktop` then `/usr/share/devin-desktop/devin-desktop` on Linux (the official `devin-desktop` package's launcher/application paths) — never an internal bundled CLI binary, which proves nothing about whether the editor is installed. It does not verify that Desktop launched or hosted the current session; a PATH success also does not identify Desktop's own runtime. The row was exercised live on 2026-09-23 in `evidence/devin-e2e-run/desktop-local-run/` — an attended Devin Desktop (Devin Local) session on native Windows where all three host rows passed and a full express workflow completed; Desktop execution itself is evidenced there by the audit/state records, not by this row.

Observed install layouts (2026-09-22): the Windows candidates were corrected against a real install — the Desktop-bundled CLI lives at `%LOCALAPPDATA%\Programs\Devin\resources\app\extensions\windsurf\devin\bin\devin.exe` (`devin 3000.10.31` observed) and the standalone Windows CLI at `%LOCALAPPDATA%\devin\cli\bin\devin.exe` (`devin 3000.4.25` observed); the previously probed `%LOCALAPPDATA%\Devin\devin.exe` and `%ProgramFiles%\Devin\devin.exe` do not exist there. The macOS `.app` candidate is the structurally matching Electron path (plausible, not verified on a macOS install). The Linux paths `~/.local/share/Devin/` and `/opt/Devin/` were guessed candidates at that date (unverified); current candidates come from the official `devin-desktop` package layout. Docs only say the CLI is "bundled with Devin Desktop" and can be added to PATH via an admin-enabled Command Palette action; no path is documented (`enterprise/team-settings.mdx`, `enterprise/windsurf-auth.mdx`).

After a successful core SessionStart hook and an actual SessionStart payload, the adapter writes .devin/.aidlc-session-start.local.json with only lastRun. The marker is gitignored and never pre-seeded in the distribution. Failed marker writes warn but do not suppress context output.

Doctor requires a canonical timestamp in that marker; missing, unreadable, or malformed evidence fails. It does not create evidence, impose an expiry threshold, query current hook approval, or resist manual fabrication. A valid marker passes only the historical execution-evidence check. `/hooks` is documented as listing loaded hooks and their sources; operational approve-if-prompted/full-restart guidance is not an approval-state API. Observed 2026-09-23: `/hooks` is a CLI-only command — Desktop's Devin Local session returns "Unknown command"; the Desktop-native equivalent is the **Open customizations** surface (new-tab menu or session context menu), which lists loaded rules, skills, hooks, MCP servers, and plugins.

For existing installations, update adapter and doctor together, preserve local policy, merge the ignore entry, and restart to collect actual SessionStart evidence. Do not fabricate the marker or infer approval from workspace trust.

## Evidence and limits

t334 exercises injected discovery/execution and numeric comparison. t294 checks the shared diagnostics floor. t331 drives the spawned doctor through a `devin` PATH shim (t150 codex pattern), so the version row, the shared `Harness CLI` row, and the exit code are pinned in pass, below-floor, and unparseable states on any machine — including one with no Devin installed; the missing-CLI and Desktop-editor branches stay in t334 because the macOS Desktop editor candidate is an absolute path no env var can redirect. t331/t332 exercise absent/valid/invalid markers and adapter behavior in fixtures. None is an authenticated live-host, organization-model, Desktop, or complete workflow certification.

The opt-in status test covers only no-workflow status and absence of workflow scaffolding. A skipped test is not a passing live compatibility check; see DEVIN-14.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Version boundaries | All consumers share the same numeric floor and reject known old or broken binaries | t334-devin-version; t294-config-diagnostics; t331 test 9d (spawned doctor, shimmed floor/below-floor/unparseable) |
| Host-CLI independence of the deterministic tier | Unit tests pass identically with Devin absent, below floor, or at floor | t331 tests 9/9d via `PATH` shim; verified 2026-09-22 by running the Devin unit family with `devin` removed from PATH |
| Discovery | Standalone CLI is PATH-only; the Desktop editor is a separate row over OS-appropriate application paths (`devin-desktop` package paths on Linux); neither claims launch/session execution; the Windows LOCALAPPDATA editor path matches an observed install and reported `found` in the attended Desktop run, ProgramFiles/macOS/Linux unverified | t334 matrix and candidate lists; `evidence/devin-e2e-run/desktop-local-run/` (2026-09-23, native Windows, `devin 3000.11.1`) |
| Fresh/invalid execution marker | Doctor fails without creating evidence; packaging contains no marker | t331 doctor/ignore tests |
| Valid SessionStart | Successful target writes/refreshes canonical timestamp; failed core or wrong event does not | t332 SessionStart cases |
| Current approval or revocation | Do not infer from historical lastRun; inspect actual host behavior | Live verification gap; no supported approval-state API established |

## Open questions — platform verification pending a later execution

| Question | What is known | Evidence needed to close it |
| --- | --- | --- |
| Does the `devin.cmd` PATH shim drive the spawned doctor on native Windows? | The mechanism mirrors t150's `codex.cmd` shim, and `Bun.which` honoring a supplied `PATH` is verified on Bun 1.3.14 — but t331 tests 9/9d have only run on Linux/WSL2 | One `bun test tests/unit/t331-devin-packaging.test.ts` run on a native Windows host |
| Is `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin` the real macOS Desktop-bundled CLI path? | It is the Electron-on-macOS twin of the Windows layout verified on a real install (`resources/app/extensions/windsurf/devin/bin/devin.exe`); docs name no path | A macOS machine with Devin Desktop installed |
| Do the Linux candidates `/usr/bin/devin-desktop` and `/usr/share/devin-desktop/devin-desktop` exist on a real install? | They follow the official `devin-desktop` package layout; docs mention Devin Desktop on Windows/Linux via Command Palette (`Ctrl+Shift+P`); no Linux install observed | A Linux Devin Desktop install to inspect, or vendor confirmation |
| Can a spawned doctor ever assert "binary missing" hermetically? | No — the macOS candidate is an absolute path no env var can redirect, so that state stays t334-only; any future `AIDLC_DEVIN_*` discovery override would have to be designed as a documented seam, not a test backdoor | Only if a redirectable discovery seam is deliberately introduced |

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

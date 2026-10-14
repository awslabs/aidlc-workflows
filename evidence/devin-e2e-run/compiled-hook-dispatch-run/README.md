# compiled-hook-dispatch-run — environment, commands, and artifacts

Investigation of "`aidlc doctor` reports green while Devin hooks are broken in
compiled-binary mode". It reproduces the pre-`248500a8` Devin adapter argv
(`[exe, "hook", <name>]`) against a freshly built native `aidlc` binary,
compares it with the fixed argv (`[exe, "engine", "hook", <name>]`), and
records what `aidlc doctor` reports in each state. Read `SUMMARY.md` for
verdicts, impact, and the resume plan.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-10-08 (UTC; exact timestamps in `00-environment.txt`) |
| Source checkout | `<home>/sources/aidlc-workflows` at `dafdaa99` (`feat/devin-harness`), clean tree apart from this directory |
| `upstream/main` | `b4985f72` |
| Native binary | built by `scripts/build-binaries.ts` into `/tmp/aidlc-inv/binaries/native/aidlc` (not committed: 167 MB; rebuild with `repro.sh`) |
| Runtime | bun `1.3.14`; Linux WSL2 `5.15.167.4-microsoft-standard-WSL2` x86_64 |
| Devin CLI | on `PATH` at `<home>/.local/bin/devin` (version in `00-environment.txt`); no live Devin session was used |
| Redaction | `/home/<user>` → `<home>` in every file; machine hostname → `<host>` |

## Commands

The whole run is scripted. From the repo root:

```bash
bash evidence/devin-e2e-run/compiled-hook-dispatch-run/repro.sh /tmp/aidlc-inv-repro
```

It runs `bun scripts/package.ts`, then
`AIDLC_BUILD_OUT_DIR=$OUT/binaries bun scripts/build-binaries.ts`, then
cases A–D below. Logs go to `$OUT/logs`, and the script ends with a PASS/FAIL
line saying whether every expected value held. It never modifies tracked
files; `dist/` and `dist-release/` are ignored build outputs.

| Case | What it does |
|------|--------------|
| A | Dispatcher grammar: `aidlc hook validate-state` vs `aidlc engine hook validate-state`, with `AIDLC_HARNESS_NAME=devin`, `=copilot`, and no env |
| B | Fixed full chain: `aidlc engine adapter devin <target>` for 7 target/payload pairs in a `dist-release/devin` project (positive control) |
| C | The `HEAD` adapter with exactly the two argv lines reverted (`old-adapter-argv.diff`), run with `bun` and `AIDLC_COMPILED_EXECUTABLE=<binary>` against the real compiled dispatcher; then the unmodified adapter as a control |
| D | `aidlc doctor --verbose`: D1 fresh project, D2 after the fixed chain, D3 after a good SessionStart followed by old-adapter runs (stale marker). The `--json` captures in `05`–`07` come from the first run; `repro.sh` re-runs only the `--verbose` form |

Case C runs the adapter source under bun instead of rebuilding a binary from
`248500a8^`. Compiled `engine adapter devin` imports this same adapter module
and sets the same two env vars (`core/tools/aidlc.ts` `runAdapter`), so the
spawned argv and the dispatcher that parses it are identical.

## Artifacts

| File | What it is |
|------|------------|
| `README.md` | This file |
| `SUMMARY.md` | Verdicts, root cause, impact, doctor analysis, coverage gaps, resume plan |
| `00-environment.txt` | Commit, branch, tool versions, binary path/size/version |
| `01-build.txt` | `package.ts` + `build-binaries.ts` exit codes and the gate summary |
| `02-case-a-dispatcher-grammar.txt` | Case A runs |
| `03-case-b-fixed-chain.txt` | Case B runs |
| `04-case-c-old-vs-new-adapter.txt` | Case C old-adapter block, then the unmodified-adapter control block |
| `05-case-d1-doctor-fresh.{txt,json}` | Doctor on a fresh release-tree project |
| `06-case-d2-doctor-after-fixed-chain.{txt,json}` | Doctor after case B |
| `07-case-d3-doctor-stale-marker.{txt,json}` | D3 setup runs, marker before/after, doctor output |
| `08-config-help.txt` | `aidlc config --help` (confirms the `config --harness <name>` form) |
| `09-repro-run.txt` | stdout of the verification run of `repro.sh` |
| `old-adapter-argv.diff` | The exact two-line revert used for case C |
| `raw-results.md` | Working notes from the first run (redacted copy) |
| `repro.sh` | Self-contained reproduction of the whole run |
| `MANIFEST.sha256` | SHA-256 of every file above except itself |

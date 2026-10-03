# AIDLC v2 Cross-CLI Comparison — claude vs codex vs kiro

> Generated: 2026-08-12 · n=1 per cell · same tasks, oracles, and harness as the
> claude baselines (runs/baseline-20260807 + runs/20260807T17-20 batches).
> claude = Claude Code 2.1.223 (Opus-tier via Bedrock) · codex = codex-cli 0.142.2
> (openai.gpt-5.6-sol via Bedrock, high effort) · kiro = kiro-cli 2.17.0 (Kiro default model).

## Verdict

| Task / metric | claude | codex | kiro |
|---|---|---|---|
| **Greenfield** contract (88 cases) | ✅ 88/88 (3/3 runs) | ✅ 88/88 | ❌ **85/88** |
| Greenfield doc fidelity (0–1)* | 0.762–0.793 (n=3) | 0.572 | 0.653 |
| Greenfield wall clock | **91 min** (median of 88/91/112) | 50 min | 46 min |
| Greenfield cost | $51.76–$57.89 | n/a† | n/a† |
| **Bugfix** (httpbin, 3 assertions) | ✅ 3/3 | ✅ 3/3 | ✅ 3/3 |
| Bugfix wall clock | 35 min | 49 min | 14 min |
| **Feature** (RealWorld, Hurl suite) | ✅ 3/3 | ✅ 3/3 | ✅ 3/3 |
| Feature wall clock | 39 min | 37 min | 33 min |

\* Doc fidelity is scored against the v2 golden doc set, which was produced via
claude — treat cross-CLI fidelity deltas as directional only.
† Token/cost capture (local OTLP receiver) reads Claude Code telemetry; codex
and kiro report turn counts only.

## Findings

1. **codex-cli: clean sweep (3/3 tasks).** All 88 greenfield contract cases,
   both brownfield tasks. Greenfield in 50 min vs claude's ~91 — though doc
   fidelity (0.572) trails claude (0.76–0.79). Claude's extra wall clock is
   structural, and it buys measurable quality: a ~25-min intake Q&A that
   settles design edge cases up front (e.g. Infinity/NaN serialization — the
   exact case kiro failed) and a test-hardening loop at the end of
   code-generation. Claude is 3-for-3 at 88/88 across all greenfield runs.
2. **kiro-cli: brownfield-solid, greenfield near-miss.** Both brownfield
   tasks pass (bugfix in 14 min — fastest run of the whole matrix).
   Greenfield scored 85/88: the app boots and passes everything except the
   three constants endpoints (`/constants`, `/constants/inf`,
   `/constants/nan`), which return 500 — the Infinity/NaN
   JSON-serialization edge case (raw non-finite floats handed to the JSON
   encoder). The claude runs settled this exact question at the intake gate
   ("emit as JSON strings"). Under the deterministic all-cases-pass rule,
   85/88 is a FAIL for the run; on the graded axis it is a near-miss.
3. **The live-HTTP oracle earned its keep**: the workflow declared the kiro
   greenfield run "Completed" with a full doc set — only the contract run
   surfaced the 500s on the constants endpoints.
4. n=1 per cell: treat single-cell differences (especially wall clock) as
   anecdotes. Pass/fail cells are deterministic per run but repeatability
   across runs needs n≥5.

## Harness fixes required to run this comparison (all committed)

- Brownfield support ported to codex/kiro adapters (seed install, task.md
  intent, modify-not-rebuild prompt, source-delta completion gating).
- `--tech-env` no longer leaks sci-calc's stack pin into brownfield runs.
- kiro-cli ≥ 2.x rejects a leading `/aidlc` (parsed as CLI subcommand) —
  invocation now phrased as natural language, mirroring codex.
- codex default model set to `openai.gpt-5.6-sol`, reasoning effort high.

## Run folders

- codex: `20260812T170110-codex-greenfield`, `20260812T145343-codex-smoke-httpbin`, `20260812T170110-codex-feature-realworld`
- kiro: `20260812T183422-kiro-greenfield-run02`, `20260812T145616-kiro-smoke-httpbin`, `20260812T170110-kiro-feature-realworld`
- claude baselines: `baseline-20260807/` and `20260807T{1739,1934,2009}*-version-batch`

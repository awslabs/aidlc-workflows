# AIDLC Evaluation Report — Full Suite

> **Generated:** 2026-08-07T16:43:48Z
> **Scope:** v2, all three standard tasks
> **Transport:** real `claude` CLI in a PTY (Bedrock, Opus-tier), gates driven by the harness

| Task | Kind | Oracle |
|---|---|---|
| Greenfield (sci-calc API) | Graded vs golden | 88-case OpenAPI contract + 0-1 semantic similarity |
| Brownfield bugfix (httpbin) | Deterministic | 3 HTTP assertions (third-party contract) |
| Brownfield feature (RealWorld) | Deterministic | Project's own Hurl suite (third-party contract) |

The two task families are measured differently by design — graded
fidelity for greenfield, deterministic pass/fail for brownfield — and
are reported in separate sections so the axes never blend.


## Executive Summary

**v2 across the three standard tasks** — greenfield build (n=1), brownfield bugfix, and brownfield feature.

- **Greenfield**: median cost $0.00, 88 min wall clock, contract 88/88, doc fidelity 0.762 vs the v2 golden.

- **Brownfield bugfix**: ✅ 1/1 contract pass rate, median cost —, 17 min wall clock.

- **Brownfield feature**: ✅ 1/1 contract pass rate, median cost —, 43 min wall clock.


## Verdict

| Dimension | v2 |
|-----------|---|
| Greenfield · cost (median) | 0.00 $ |
| Greenfield · wall clock (median) | 87.7 min |
| Greenfield · qualitative 0-1 (median) | 0.762 |
| Greenfield · contract (median) | 88 |
| Brownfield bugfix · contract pass rate | 1/1 |
| Brownfield bugfix · cost (median) | — |
| Brownfield feature · contract pass rate | 1/1 |
| Brownfield feature · cost (median) | — |


## Greenfield — graded (vs golden)

Build a scientific-calculator API from scratch. Cost/wall/tokens are
consumption axes; quality is a 0-1 semantic-similarity score vs each
version's own golden (cross-version doc structures differ, so each is
graded against its own reference).

Runs: v2 n=1

### Headline (medians)

| Metric | v2 |
|---|---:|
| Cost (USD) | **0.00** 🥇 |
| Wall clock (min) | **87.7** 🥇 |
| Total tokens (M) | **0.0** 🥇 |
| Qualitative (0-1) | **0.762** 🥇 |
| Contract passed | **88** 🥇 |
| Coverage % | **97.8** 🥇 |

### Statistics (mean ± SD, Student-t 95% CI)

| Metric | v2 |
|---|---|
| Cost (USD) | 0.00 (n=1) |
| Wall clock (min) | 87.7 (n=1) |
| Total tokens (M) | 0.0 (n=1) |
| Qualitative (0-1) | 0.762 (n=1) |

### Quality detail (medians)

| Metric | v2 |
|---|---:|
| Unit tests passed | 176 |
| Unit pass % | 100.0 |
| Lint errors | 0 |
| Security high | 0 |
| Qualitative · inception | 0.730 |
| Qualitative · construction | 0.745 |
| Source files | 16 |
| Test files | 10 |
| Lines of code | 1,014 |
| AIDLC doc files | 59 |

### Per-run results

<details><summary><b>v2</b> — 1 runs</summary>

| Run | Cost | Wall | Tokens | Qual | Contract | Cov % |
|---|---:|---:|---:|---:|---:|---:|
| `v2-run01` | 0.00 $ | 87.7 min | 0.0M | 0.762 | 88/88 | 97.8 |

</details>


## Brownfield — reliability (deterministic)

Modify a real external codebase; scored **pass/fail** against the
testbed's own third-party contract (a run passes iff **every** contract
case passes — no partial credit). This is a deterministic reliability
measure, deliberately separate from the graded greenfield score above;
brownfield has no golden, so its quality axis IS the pass rate.

### Task 1 — Bugfix: httpbin `/base64` error handling (Flask)

Seeded pristine `psf/httpbin`; the `/base64` endpoint swallows malformed input with a bare `except:` and returns HTTP 200. Oracle: 3 explicit HTTP assertions (valid→200, two malformed→400).

| Metric | v2 |
|---|---|
| Contract pass rate | ✅ **1/1** |
| Cost — median | — |
| Cost — mean ± SD (CI) | — |
| Wall clock — median | 17 min |

**Per-run detail:**

<details><summary><b>v2</b> — 1/1 passed</summary>

| Run | Verdict | Cases | Cost | Wall | Tokens |
|---|---|---:|---:|---:|---:|
| `v2-run01` | ✅ PASS | 3/3 | — | 17 min | — |

</details>

### Task 2 — Feature: RealWorld follow/unfollow (Django)

Seeded `c4ffein/realworld-django-ninja` with the `POST`/`DELETE /profiles/{username}/follow` routes REMOVED; implement them per the RealWorld spec. Oracle: the project's own Hurl suite (3 follow-dependent files, each run independently).

| Metric | v2 |
|---|---|
| Contract pass rate | ✅ **1/1** |
| Cost — median | — |
| Cost — mean ± SD (CI) | — |
| Wall clock — median | 43 min |

**Per-run detail:**

<details><summary><b>v2</b> — 1/1 passed</summary>

| Run | Verdict | Cases | Cost | Wall | Tokens |
|---|---|---:|---:|---:|---:|
| `v2-run01` | ✅ PASS | 3/3 | — | 43 min | — |

</details>


## Provenance

- Greenfield batch: `runs/20260807T141207-version-batch`
- Brownfield bugfix batch(es): `runs/20260807T154323-version-batch`
- Brownfield feature batch(es): `runs/20260807T160028-version-batch`
- When multiple batches are listed for a task, a LATER batch replaces
  that version's runs (e.g. a v1 re-run after a harness fix keeps
  v1.5/v2 from the earlier batch). Patched `-runNN-rerun` folders
  supersede their base run.
- Brownfield pass/fail read from each run's `contract-test-results.yaml`
  (the third-party contract oracle), NOT the manifest completion status.
- Brownfield testbeds pinned to upstream commits (verified at preflight):
  httpbin `f7b02ae`, realworld `04ef47c`.

---
*Report generated by run_combined_report.py*
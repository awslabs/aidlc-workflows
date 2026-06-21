// covers: harness-instrument:test-suite-drift
//
// t55 — drift guard for test-suite metadata + the framework path/version-marker
// drift sweeps + the closed-harness-framing anti-rot guard. Migrated from
// tests/integration/t55-test-suite-drift.sh (TAP plan 7); test 8 added by the
// docs re-architecture (du/unit-7), so this twin now carries 8 test() cases.
// Mechanism: none (pure file reads/parsing over tests/, tests/README.md, and
// docs/ — readFileSync/readdirSync only; zero spawn, zero LLM, zero tokens).
// Born suffix-free.
//
// This is a META-TEST over the test suite + docs. It instruments the harness
// itself rather than any framework unit (function/audit/scope/stage/hook/
// subcommand/render-surface), so it claims the non-enumerated namespace
// `harness-instrument:test-suite-drift` — the same convention
// gen-coverage-registry.test.ts (harness-instrument:coverage-registry-generator)
// and t112.serial.none.test.ts (harness-instrument:runner-exit-equals-failed-files)
// use. parseCoversHeader records claims only when they match an enumerated unit,
// so this benign namespace counts toward nothing and breaks no coverage ratchet.
//
// ─────────────────────────────────────────────────────────────────────────────
// milestone-4-REALITY ADAPTATION (why this twin is NOT a 1:1 transliteration)
// ─────────────────────────────────────────────────────────────────────────────
// The .sh's whole premise was validating drift across `.sh` test files: each
// `.sh` encodes its assertion count in three places — the TAP `plan N` line, the
// header `(N tests)` comment, and its tests/README.md registry row — and those
// drifted independently. The milestone 4 migration has retired ~159 of the 160
// deterministic `.sh` to `t<NN>[-desc].test.ts` (this t55 is the last; milestone 5
// retires the remaining ~29 claude-driving `.sh`). The tree is now ~30 `.sh` +
// ~200 `.test.ts`.
//
// A `.test.ts` has NO `plan N` (bun:test has no TAP plan) — its assertion count
// lives implicitly in describe()/test() blocks plus an optional header comment,
// not on a `plan` line. So the plan-vs-header-vs-README drift model (the .sh's
// checks 1, 2, 4, 5) applies ONLY to the surviving `.sh`. We do NOT fabricate a
// `plan N` concept for `.test.ts`. Each check below documents exactly what it is
// scoped to and asserts what IS true of the current tree.
//
// REGISTRY SHAPE (verified on disk this session): tests/README.md tracks ONLY
// `.sh` rows — all surviving `.sh`, zero `.test.ts` rows. The README tables are
// empty because the test levels are now entirely `.test.ts`.
// The `.test.ts` coverage registry lives elsewhere (tests/.coverage-registry.json
// via the `covers:` headers + gen-coverage-registry.ts), NOT in this README. So
// the bidirectional README check (the load-bearing check 3) is scoped to `.sh`:
// every `.sh` on disk has a README row, every README row points to an existing
// file. A `.test.ts` lacking a README row is CORRECT under the current design and
// must NOT red. (When milestone 5 retires the last `.sh`, the README's test-row tables go
// empty and check 3 becomes vacuously true on both sides — still correct.)
//
// ─────────────────────────────────────────────────────────────────────────────
// Old TAP -> new test parity (the .sh's 7 `ok` lines -> named test() cases)
// ─────────────────────────────────────────────────────────────────────────────
//   .sh ok 1 (header drift: plan N == header (N tests))
//        -> test 1 "surviving .sh: header (N tests) matches plan N"
//           SCOPE: surviving `.sh` only. `.test.ts` have no plan N to drift.
//   .sh ok 2 (README drift: plan N == README (N tests))
//        -> test 2 "surviving .sh: tests/README.md (N tests) matches plan N"
//           SCOPE: surviving `.sh` listed in README.
//   .sh ok 3 (README bidirectional reflection of tests/ on disk) — LOAD-BEARING
//        -> test 3 "tests/README.md ⇄ tests/ on disk (.sh rows, bidirectional)"
//           SCOPE: `.sh` (what the README is designed to track today). Kept STRONG
//           and bidirectional: missing rows AND orphan rows both red.
//   .sh ok 4 (DYNAMIC_PLAN_ALLOWLIST honesty)
//        -> test 4 "dynamic-plan allowlist is obsolete (no surviving .sh has a
//           computed plan; the 3 former entries are now .test.ts)"
//           ADAPTED: the 3 former allowlist entries
//           (unit/t15-knowledge-file-inventory, unit/t26-delivery-agent-timeline-
//           guardrail, integration/t32-stage-graph-consistency) are now `.test.ts`
//           (the `.sh` are GONE), so the allowlist is empty by construction. The
//           honest invariant today: NO surviving `.sh` carries a non-literal plan,
//           so nothing needs allowlisting. We also assert the 3 former stems still
//           exist as `.test.ts` (the count simply moved into describe/test blocks).
//   .sh ok 5 (09-testing.md (N tests) == tests/README.md)
//        -> test 5 "docs/reference/09-testing.md (N tests) matches tests/README.md"
//           SCOPE: rows whose path appears (with a literal count) in BOTH docs.
//   .sh ok 6 (path + version-marker drift sweep) — DURABLE CORE
//        -> test 6 "no stale path strings or version markers in framework code,
//           tests, or docs" — KEPT VERBATIM (equal-or-stronger). Carve-out update:
//           t55 and t06 are excluded by STEM (`t55-test-suite-drift`,
//           `t06-claude-md-paths`) so BOTH the `.sh` and the `.test.ts` forms are
//           carved (both legitimately embed the search patterns; t06 is now
//           `.test.ts`). All original carve-outs preserved (aidlc-version.ts,
//           /data/, /sensors/aidlc-, the "Per ROADMAP" message, node_modules,
//           tests/logs/).
//   .sh ok 7 (legacy aidlc-claude-code/ distributable-root sweep)
//        -> test 7 "no stale aidlc-claude-code/ distributable-root references"
//           — KEPT VERBATIM. Carve-out update: t55/t06/t112 excluded by STEM so
//           their `.test.ts` forms are carved (t06 and t112 are now `.test.ts`).
//           The README/09-testing t112 rows stay carved.
//
// 7 .sh `ok` lines -> 7 expect()-bearing test() cases here (same count, same
// observables, scoped to the current milestone 4 tree as documented per-check),
// PLUS test 8 (the docs re-architecture's closed-harness-framing guard) — a new
// drift sweep with no `.sh` ancestor, in the same grepHits + carve-out idiom as
// checks 6/7. The suite now has 8 test() cases.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// import.meta.dir is tests/integration/; TESTS_DIR is its parent (tests/).
const TESTS_DIR = join(import.meta.dir, "..");
const README = join(TESTS_DIR, "README.md");
const TESTING_DOC = join(REPO_ROOT, "docs", "reference", "09-testing.md");

// The four level directories the suite walks.
const TIERS = [
  "smoke",
  "unit",
  "integration",
  "e2e",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers — TS ports of the .sh's awk/grep/sed extractors.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * extract_plan_n (t55.sh:71-84): the literal integer from a `.sh`'s TAP `plan N`
 * line, "DYNAMIC" for an expression/variable, or null when there is no `plan`
 * line. Anchors on `^plan ` after optional leading whitespace. `.test.ts` files
 * have no TAP plan, so this is only ever called on `.sh`.
 */
function extractPlanN(body: string): number | "DYNAMIC" | null {
  const line = body
    .split("\n")
    .find((l: string) => /^[ \t]*plan[ \t]+/.test(l));
  if (!line) return null;
  let arg = line
    .replace(/^[ \t]*plan[ \t]+/, "")
    .replace(/[ \t]*#.*$/, "")
    .trim();
  // Strip one layer of surrounding quotes (single or double).
  arg = arg.replace(/^["']/, "").replace(/["']$/, "");
  return /^[0-9]+$/.test(arg) ? Number.parseInt(arg, 10) : "DYNAMIC";
}

/**
 * extract_header_n (t55.sh:89-96): the first `(N tests)` / `(N assertions)` in
 * the first 10 lines of a file's header, or null. Stage tests use
 * "(N assertions, M turns)"; both forms count.
 */
function extractHeaderN(body: string): number | null {
  const head = body.split("\n").slice(0, 10).join("\n");
  const m = head.match(/\((\d+) (?:tests|assertions)\)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

interface ReadmeRow {
  /** Column-2 backticked path, e.g. "integration/t55-test-suite-drift.sh". */
  path: string;
  /** Last `(N tests|assertions)` in the description column, or null. */
  count: number | null;
}

/**
 * Parse tests/README.md test rows (t55.sh:102-118). Rows start with `| tNN `.
 * Column 2 holds a backticked `level/file` path; the description's LAST
 * parenthesised count is canonical (a row like "31 stages ... (93 tests)" takes
 * the last). Keyed by full `level/file` — bare IDs collide across levels.
 */
function parseReadmeRows(readmeBody: string): ReadmeRow[] {
  const rows: ReadmeRow[] = [];
  for (const line of readmeBody.split("\n")) {
    if (!/^\|\s*t[0-9]/.test(line)) continue;
    // Column 2 = the text between the first pair of backticks.
    const btick = line.match(/`([^`]+)`/);
    const path = btick ? btick[1] : "";
    if (!path) continue;
    // Description column: awk -F'|' '{print $4}'. Splitting on "|" yields
    // ["", " tNN ", " `path` ", " desc ", ...]; index 3 is the description.
    const cols = line.split("|");
    const desc = cols[3] ?? "";
    const counts = [...desc.matchAll(/\((\d+) (?:tests|assertions)\)/g)];
    const last = counts.at(-1);
    rows.push({ path, count: last ? Number.parseInt(last[1], 10) : null });
  }
  return rows;
}

/** Lookup a README row's count by full `level/file` path (null = not listed). */
function readmeCount(rows: ReadmeRow[], needle: string): number | null | undefined {
  const row = rows.find((r: ReadmeRow) => r.path === needle);
  return row ? row.count : undefined; // undefined = not in README at all
}

/** Every `.sh` test file on disk, as `level/file` relative paths. */
function discoverShFiles(): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    const dir = join(TESTS_DIR, tier);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // level dir absent
    }
    for (const f of entries) {
      if (/^t.*\.sh$/.test(f)) out.push(`${tier}/${f}`);
    }
  }
  return out;
}

/** Every test file on disk (`.sh` AND `.test.ts`) as `level/file` paths. */
function discoverAllTestFiles(): string[] {
  const out: string[] = [];
  for (const tier of TIERS) {
    const dir = join(TESTS_DIR, tier);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (/^t.*\.(?:sh|test\.ts)$/.test(f)) out.push(`${tier}/${f}`);
    }
  }
  return out;
}

const readmeBody = readFileSync(README, "utf-8");
const readmeRows = parseReadmeRows(readmeBody);
const shFiles = discoverShFiles();

describe("t55 — test-suite metadata drift (migrated from t55-test-suite-drift.sh, plan 7; +1 framing guard = 8)", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Check 1 — header drift. Surviving `.sh` only: if a header has (N tests) and
  // the file has a literal `plan N`, they must agree. `.test.ts` carry no plan N.
  // ───────────────────────────────────────────────────────────────────────────
  test("1: surviving .sh — header (N tests) matches plan N [.sh ok 1]", () => {
    const drift: string[] = [];
    for (const rel of shFiles) {
      const body = readFileSync(join(TESTS_DIR, rel), "utf-8");
      const planN = extractPlanN(body);
      const headerN = extractHeaderN(body);
      if (headerN !== null && typeof planN === "number" && planN !== headerN) {
        drift.push(`${rel}: plan=${planN} header=${headerN}`);
      }
    }
    expect(drift).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 2 — README drift. Surviving `.sh` listed in README: README (N tests)
  // must equal the file's literal plan N.
  // ───────────────────────────────────────────────────────────────────────────
  test("2: surviving .sh — tests/README.md (N tests) matches plan N [.sh ok 2]", () => {
    const drift: string[] = [];
    for (const rel of shFiles) {
      const body = readFileSync(join(TESTS_DIR, rel), "utf-8");
      const planN = extractPlanN(body);
      const rN = readmeCount(readmeRows, rel);
      if (
        rN !== undefined &&
        rN !== null &&
        typeof planN === "number" &&
        planN !== rN
      ) {
        drift.push(`${rel}: plan=${planN} readme=${rN}`);
      }
    }
    expect(drift).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 3 — README ⇄ disk, bidirectional (LOAD-BEARING). Scoped to `.sh`: the
  // README tracks only `.sh` rows today (verified: zero `.test.ts` rows; the
  // level tables are empty). A `.test.ts` lacking a row is CORRECT and
  // must not red — its coverage is tracked via the `covers:` registry, not here.
  //   3a: every `.sh` on disk has a README row.
  //   3b: every README row points to a file that exists on disk (`.sh` or
  //       `.test.ts` — a row whose path is missing entirely is an orphan).
  // ───────────────────────────────────────────────────────────────────────────
  test("3: tests/README.md ⇄ tests/ on disk — .sh rows, bidirectional [.sh ok 3]", () => {
    // 3a — every surviving `.sh` must appear in the README.
    const missingFromReadme = shFiles.filter(
      (rel: string) => readmeCount(readmeRows, rel) === undefined,
    );

    // 3b — every README row must point to a file that exists on disk. The README
    // rows are `.sh` paths today; a row pointing at a non-existent file is an
    // orphan (a renamed/deleted test whose row was left behind).
    const onDisk = new Set(discoverAllTestFiles());
    const orphanRows = readmeRows
      .map((r: ReadmeRow) => r.path)
      .filter((p: string) => !onDisk.has(p));

    // Document the current design in the assertion surface: the README is the
    // `.sh` registry, so both halves are scoped to `.sh` rows.
    expect({ missingFromReadme, orphanRows }).toEqual({
      missingFromReadme: [],
      orphanRows: [],
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 4 — dynamic-plan allowlist honesty (ADAPTED to milestone 4).
  // The .sh's DYNAMIC_PLAN_ALLOWLIST named three `.sh` whose `plan` was a
  // computed expression. All three were migrated to `.test.ts` in milestone 4 (the `.sh`
  // are GONE), and a `.test.ts` has no TAP plan at all — so the allowlist concept
  // is obsolete. The honest invariant now: NO surviving `.sh` carries a
  // non-literal (DYNAMIC) plan, so nothing needs allowlisting. We also confirm
  // the three former stems still exist as `.test.ts` (their counts simply moved
  // into describe/test blocks), proving the entries were RE-HOMED, not lost.
  // ───────────────────────────────────────────────────────────────────────────
  test("4: dynamic-plan allowlist is obsolete — no surviving .sh has a computed plan [.sh ok 4]", () => {
    // No surviving `.sh` carries a DYNAMIC plan -> the allowlist is empty by
    // construction.
    const dynamicSh = shFiles.filter((rel: string) => {
      const body = readFileSync(join(TESTS_DIR, rel), "utf-8");
      return extractPlanN(body) === "DYNAMIC";
    });
    expect(dynamicSh).toEqual([]);

    // The three former allowlist entries are now `.test.ts`; the `.sh` are gone.
    const formerEntries = [
      { tier: "unit", stem: "t15-knowledge-file-inventory" },
      { tier: "unit", stem: "t26-delivery-agent-timeline-guardrail" },
      { tier: "integration", stem: "t32-stage-graph-consistency" },
    ];
    const verdicts = formerEntries.map(({ tier, stem }) => {
      const entries = readdirSync(join(TESTS_DIR, tier));
      return {
        stem,
        shGone: !entries.includes(`${stem}.sh`),
        tsPresent: entries.includes(`${stem}.test.ts`),
      };
    });
    for (const v of verdicts) {
      expect(v.shGone).toBe(true); // the .sh was retired
      expect(v.tsPresent).toBe(true); // its twin exists
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 5 — 09-testing.md vs tests/README.md. For each `09-testing.md` test row
  // that names a `tests/<level>/<file>.sh` path AND carries a literal count, that
  // count must equal the README row for the same `level/file`. (09-testing.md
  // still references the now-`.test.ts` files by their old `.sh` paths; only rows
  // present-with-a-count in BOTH docs are compared — exactly the .sh's scoping.)
  // ───────────────────────────────────────────────────────────────────────────
  test("5: docs/reference/09-testing.md (N tests) matches tests/README.md [.sh ok 5]", () => {
    const docDrift: string[] = [];
    let testingDoc: string;
    try {
      testingDoc = readFileSync(TESTING_DOC, "utf-8");
    } catch {
      // The .sh guarded `if [ -f "$TESTING_DOC" ]`; absence is a no-op pass.
      expect(docDrift).toEqual([]);
      return;
    }
    for (const line of testingDoc.split("\n")) {
      if (!/^\|\s*t[0-9]/.test(line)) continue;
      const pathM = line.match(/tests\/[a-z0-9]+\/t[0-9]+[a-zA-Z-]*\.sh/);
      if (!pathM) continue;
      const counts = [...line.matchAll(/\((\d+) (?:tests|assertions)\)/g)];
      const last = counts.at(-1);
      if (!last) continue;
      const docN = Number.parseInt(last[1], 10);
      const shortPath = pathM[0].replace(/^tests\//, "");
      const rN = readmeCount(readmeRows, shortPath);
      if (rN !== undefined && rN !== null && docN !== rN) {
        docDrift.push(`${shortPath}: 09-testing.md=${docN} readme=${rN}`);
      }
    }
    expect(docDrift).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 6 — path + version-marker drift sweep (DURABLE CORE — kept verbatim).
  // Scans dist/claude/.claude/, tests/, docs/ for stale path strings and scans
  // dist/claude/.claude/ for stale release-version markers in framework code.
  // Carve-outs preserved; t55 + t06 excluded by STEM so both `.sh` and `.test.ts`
  // forms are carved (both legitimately embed the search patterns).
  // ───────────────────────────────────────────────────────────────────────────
  test("6: no stale path strings or version markers in framework code, tests, or docs [.sh ok 6]", () => {
    const pathDrift: string[] = [];

    // --- Stale path strings across the three roots ---
    const PATH_PATTERNS = [
      "aidlc-knowledge/",
      ".claude/practices/",
      "rules/aidlc/",
      "practices/team.md",
      "practices/org.md",
      "practices/project.md",
      "aidlc-docs/.sensors/",
      // ── learnings→practices relocation (docs-freshness sweep) ──
      // The two retired learnings FILES — aidlc-team-learnings.md and
      // aidlc-project-learnings.md — collapsed into the unified practices
      // written under aidlc/spaces/<space>/memory/{team,project}.md (see
      // core/tools/aidlc-learnings.ts → memoryDirFor). These concrete filenames
      // have ZERO legitimate survivors anywhere in core/harness/dist/docs — the
      // only on-disk hits are three tests that embed them as negative-match data
      // (carved by STEM below). So these tokens catch any stale learnings-FILE
      // reference that re-enters the corpus.
      //
      // We anchor on the full `aidlc-<scope>-learnings.md` filename, NOT a bare
      // `-learnings.md` substring: the explanatory glob `*-learnings.md` (the
      // prose that DOCUMENTS the collapse — "there is no parallel `*-learnings.md`
      // surface") appears legitimately in ~17 files (core stage-protocol +
      // aidlc-{graph,learnings}.ts, their dist copies, docs/{guide,reference,
      // harness-engineering}, and tests). That retirement-narrating prose is
      // correct, not stale, and is already pinned by t174 over the authored
      // surfaces — so a bare-substring token would over-broaden into it.
      //
      // NOTE: the sibling rules→memory relocation (the DOTTED dirs
      // `.claude/rules/`, `.kiro/steering/`, `.codex/aidlc-rules/`) is
      // deliberately NOT swept here either. Those dotted forms survive
      // legitimately in ~77 files: the 52 rendered dist/claude/.claude copies
      // (token-substitution output), the packager/emit/@-stub/native-glob
      // sources, the resolver doc-comments in aidlc-{lib,graph}.ts, and the
      // authored-prose mentions of the `.claude/rules/aidlc.md` @-import stub —
      // and the bare `{{HARNESS_DIR}}/rules/` template token (~73× in
      // core/aidlc-common) is a SEPARATE deferred sweep (G6) that must NOT be
      // matched here. That lane is already pinned by t174 (docs-legacy-refs-gate)
      // over the authored-prose surfaces; duplicating it here would mean carving
      // all 77 paths.
      "aidlc-team-learnings.md",
      "aidlc-project-learnings.md",
    ];
    const pathHits = grepHits(
      [
        // Authorship moved from dist/claude/.claude to core/ + harness/ (dist-unified
        // keystone); dist/ is now generated but still committed, so scan all three.
        join(REPO_ROOT, "core"),
        join(REPO_ROOT, "harness"),
        join(REPO_ROOT, "dist", "claude", ".claude"),
        join(REPO_ROOT, "tests"),
        join(REPO_ROOT, "docs"),
      ],
      (line: string) => PATH_PATTERNS.some((p) => line.includes(p)),
    ).filter((h: string) => !pathHitCarvedOut(h));
    if (pathHits.length > 0) {
      pathDrift.push(
        "stale path strings (aidlc-knowledge/, .claude/practices/, rules/aidlc/, practices/{team,org,project}.md, aidlc-docs/.sensors/, aidlc-{team,project}-learnings.md):",
      );
      pathDrift.push(...pathHits);
    }

    // --- Release-version markers in framework code (dist/claude/.claude only) ---
    const VERSION_RE =
      /v0\.[0-9]+\.[0-9]+|MR [0-9]+|ROADMAP\.md:[0-9]|\(Inception [0-9]+\.[0-9]+\)|\(Construction [0-9]+\.[0-9]+\)|\(Operation [0-9]+\.[0-9]+\)/;
    const versionHits = grepHits(
      [
        join(REPO_ROOT, "core"),
        join(REPO_ROOT, "harness"),
        join(REPO_ROOT, "dist", "claude", ".claude"),
      ],
      (line: string) => VERSION_RE.test(line),
    ).filter((h: string) => !versionHitCarvedOut(h));
    if (versionHits.length > 0) {
      pathDrift.push("release-version markers in framework code:");
      pathDrift.push(...versionHits);
    }

    expect(pathDrift).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 7 — legacy distributable-root sweep (kept verbatim). The bare literal
  // `aidlc-claude-code` must not reappear as a live path in framework tree,
  // tests, or docs. Carve-outs: t55/t06/t112 by STEM (so their `.test.ts` forms
  // are carved — t06 and t112 are now `.test.ts`), plus the README/09-testing
  // t112 rows that narrate the move.
  // ───────────────────────────────────────────────────────────────────────────
  test("7: no stale aidlc-claude-code/ distributable-root references (post-v0.6.0-milestone-0) [.sh ok 7]", () => {
    const hits = grepHits(
      [
        join(REPO_ROOT, "core"),
        join(REPO_ROOT, "harness"),
        join(REPO_ROOT, "dist", "claude", ".claude"),
        join(REPO_ROOT, "tests"),
        join(REPO_ROOT, "docs"),
      ],
      (line: string) => line.includes("aidlc-claude-code"),
    ).filter((h: string) => !legacyRootCarvedOut(h));
    expect(hits).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Check 8 — closed-harness-framing anti-rot guard (NEW; docs re-architecture
  // du/unit-7). The corpus moved from "one core, three harnesses" (a CLOSED count
  // baked into titles, taglines, and the canonical architecture heading) to "one
  // core, MANY harnesses" — an open, growable set where Claude/Kiro/Codex are an
  // enumeration that grows, not a hardcoded three. This guard pins that: it reds
  // on any ARCHITECTURAL closed-count framing that re-enters the authored corpus.
  //
  // SCANS the authored surfaces a reader/maintainer sees: the repo-root README.md
  // and AGENTS.md (hand-authored project docs, NOT scanned by checks 6/7), plus
  // core/, harness/ (authored sources), and docs/. It does NOT scan dist/ (the
  // dist AGENTS.md/CLAUDE.md are generated from these sources — fixing the source
  // fixes the copy, and --check proves parity) nor tests/ (this file legitimately
  // embeds the forbidden phrases as test data; scanning tests/ would self-trip).
  //
  // FORBIDS the closed-count tells: "one core, three harnesses", "three (CLI)
  // harnesses", "three harness distributions", "generated three ways", and the
  // "add(ing) a fourth [harness]" framing (presupposes a closed set of three).
  // CARVE-OUTS (framingHitCarvedOut): CHANGELOG.md (frozen history — never
  // retro-edited) and the AGENTS/porting dir-name "three senses of harness" note
  // (about three DIRECTORY NAMES — harness/, docs/harness-engineering/,
  // tests/harness/ — not the harness count). The regex is harness-scoped so the
  // ~dozen incidental "all three / three X" facts (3 init stages, 3 depth levels,
  // 3 test-strategy levels, 3 Bolts, 3 compartments, 3 session skills, 3 phases,
  // 3 interaction modes) and ordinal "fourth" uses (fourth phase, fourth audit
  // stream) never match — they are not the harness count.
  //
  // This guard is born RED on the pre-Wave-1 corpus (the framing reframe turns it
  // green); after Wave 1 it stays green and pins the open-set framing against rot.
  // ───────────────────────────────────────────────────────────────────────────
  test("8: no closed 'three harnesses' framing in authored docs (open-set guard) [du/unit-7]", () => {
    const hits = grepHits(
      [
        join(REPO_ROOT, "README.md"),
        join(REPO_ROOT, "AGENTS.md"),
        join(REPO_ROOT, "core"),
        join(REPO_ROOT, "harness"),
        join(REPO_ROOT, "docs"),
      ],
      (line: string) => CLOSED_FRAMING_RE.test(line),
    ).filter((h: string) => !framingHitCarvedOut(h));
    expect(hits).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Carve-out predicates (TS ports of the .sh's `grep -v` chains). Each takes a
// "path:lineno:content" hit string. STEM matching (e.g. "t55-test-suite-drift")
// carves BOTH the `.sh` and the `.test.ts` form of a file — the milestone 4 update that
// the original `.sh`-suffix carve-outs missed.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared excludes for every sweep: node_modules and the runner log dir. */
function commonExcluded(hit: string): boolean {
  return hit.includes("node_modules") || hit.includes("tests/logs/");
}

/** Check-6 path-string carve-outs (t55.sh:283-286). */
function pathHitCarvedOut(hit: string): boolean {
  return (
    commonExcluded(hit) ||
    hit.includes("t55-test-suite-drift") || // STEM: carves .sh AND .test.ts
    hit.includes("t06-claude-md-paths") || // STEM: t06 is now .test.ts
    // ── learnings-filename carve-outs (learnings→practices relocation sweep) ──
    // The retired filenames aidlc-team-learnings.md / aidlc-project-learnings.md
    // have ZERO legitimate survivors in core/harness/dist/docs (verified: grep
    // for the concrete filenames returns nothing there). Their only on-disk
    // appearances are these three tests, which embed the filename as
    // negative-match TEST DATA — they assert the file is GONE (the .sh
    // ancestor's `assert_file_not_exists`) or narrate the old learnings flow.
    // Carved by STEM so the embedded filename never self-trips this sweep.
    hit.includes("t99-learnings-gate-flow") || // narrates old learnings landing paths
    hit.includes("t86-stage-protocol-section-13") || // asserts filename absent in stage-protocol
    hit.includes("t158-memory-writer-reader-seam") // asserts old learnings file not created
  );
}

/** Check-6 version-marker carve-outs (t55.sh:302-306). */
function versionHitCarvedOut(hit: string): boolean {
  return (
    hit.includes("node_modules") ||
    hit.includes("aidlc-version.ts") || // its job is to declare a version
    hit.includes("/data/") || // stage-graph.json "number" identifiers
    /aidlc-utility\.ts.*Per ROADMAP/.test(hit) || // user-facing migration message
    hit.includes("/sensors/aidlc-") // sensor default-version-of-behaviour prose
  );
}

/** Check-7 legacy-root carve-outs (t55.sh:336-342). */
function legacyRootCarvedOut(hit: string): boolean {
  return (
    commonExcluded(hit) ||
    hit.includes("t55-test-suite-drift") || // this file (.sh AND .test.ts)
    hit.includes("t06-claude-md-paths") || // .test.ts negative-match guard
    hit.includes("t112-learnings-distribution-guard") || // .test.ts migration prose
    /tests\/README\.md:.*\| t112 /.test(hit) || // README t112 row
    /09-testing\.md:.*\| t112 /.test(hit) // 09-testing.md t112 row
  );
}

/**
 * Check-8 closed-harness-framing forbidden pattern (docs re-architecture du/unit-7).
 * Matches the architectural CLOSED-COUNT tells — the framing that hardcodes
 * "three" (or presupposes it via "add a fourth") as the harness set — while
 * leaving the ~dozen incidental "all three / three X" methodology facts and
 * ordinal "fourth" uses untouched (those never name the harness count). Anchored
 * on "harness(es)/harness distributions" so "three harness-neutral skills",
 * "three phases", "three Bolts", "three depth levels", "fourth phase", etc. all
 * pass. Case-insensitive.
 */
const CLOSED_FRAMING_RE =
  /one core,?\s+three\s+harnesses|three\s+(?:cli\s+)?harnesses|three\s+harness\s+distributions?|generated\s+three\s+ways|(?:add|adding)\s+a\s+fourth/i;

/**
 * Check-8 carve-outs. Two permanent allowlist entries:
 *   - CHANGELOG.md — frozen historical record; the "one core, three harnesses"
 *     release note for the dist-unified minor must NOT be retro-edited.
 *   - the dir-name "three senses of harness" note (AGENTS.md + the porting
 *     chapter) — about three DIRECTORY NAMES, not the harness count; it does not
 *     even match CLOSED_FRAMING_RE ("three senses" ≠ "three harnesses"), but the
 *     surrounding sentence enumerates harness/ etc., so we exclude the note's
 *     lines defensively by their "senses of" marker.
 * (tests/ is not scanned by check 8 at all, so this file's own embedded phrases
 * never reach the predicate.)
 */
function framingHitCarvedOut(hit: string): boolean {
  return (
    hit.includes("node_modules") ||
    /^CHANGELOG\.md:/.test(hit) || // frozen release history
    /senses of\b/.test(hit) // the dir-name "three senses of harness" note
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// grepHits — a recursive `grep -rn` in pure TS. Returns "relpath:lineno:content"
// for every line in every text file under the given roots that matches `pred`.
// Relative to REPO_ROOT so carve-out predicates match the same path shapes the
// .sh's grep emitted (e.g. "tests/README.md:36:..."). Skips node_modules, .git,
// and binary/log noise the .sh's `grep -v` chain also excluded.
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function grepHits(roots: string[], pred: (line: string) => boolean): string[] {
  const hits: string[] = [];
  for (const root of roots) walk(root, pred, hits);
  return hits;
}

function walk(
  abs: string,
  pred: (line: string) => boolean,
  hits: string[],
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    // Not a directory (ENOTDIR for a file ROOT like README.md / AGENTS.md) or
    // unreadable/non-existent. grepFile handles the file case and no-ops on a
    // truly absent path (its own readFileSync catch). The original directory
    // roots are unaffected — readdirSync succeeds for them.
    grepFile(abs, pred, hits);
    return;
  }
  for (const ent of entries) {
    // SKIP_DIRS mirrors the .sh's `grep -v node_modules` (and .git, which a
    // `grep -rn` over a source tree would never contain test content for). The
    // .sh scanned everything else, dotfiles included; so do we.
    if (SKIP_DIRS.has(ent.name)) continue;
    const child = join(abs, ent.name);
    if (ent.isDirectory()) {
      walk(child, pred, hits);
      continue;
    }
    if (!ent.isFile()) continue;
    grepFile(child, pred, hits);
  }
}

/** Grep one file: push "relpath:lineno:content" for each matching line. Skips
 *  unreadable files and likely-binary content (NUL byte), as `grep -r` does. */
function grepFile(
  abs: string,
  pred: (line: string) => boolean,
  hits: string[],
): void {
  let body: string;
  try {
    body = readFileSync(abs, "utf-8");
  } catch {
    return; // unreadable / non-existent
  }
  // Skip likely-binary content (a NUL byte): readFileSync as utf-8 still
  // returns a string, but grep -r skips binary. Mirror that.
  if (body.indexOf(String.fromCharCode(0)) !== -1) return;
  const relPath = relFromRepo(abs);
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pred(lines[i])) {
      hits.push(`${relPath}:${i + 1}:${lines[i]}`);
    }
  }
}

/** Repo-relative POSIX-style path so carve-out predicates match `.sh`-grep shapes. */
function relFromRepo(abs: string): string {
  const root = REPO_ROOT.endsWith("/") ? REPO_ROOT : `${REPO_ROOT}/`;
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  return rel.split("\\").join("/"); // normalise Windows separators
}

// covers: harness-instrument:coverage-registry-generator
//
// gen-coverage-registry.test.ts — calibrates the L-SURFACE coverage instrument
// (tests/gen-coverage-registry.ts). Mechanism: none (pure in-process + a
// deterministic spawn of the tool against a temp tree; zero LLM, zero tokens).
// Technique: known-answer + fault-injection + guard-rejection.
//
// WHAT THIS PINS. The generator is itself a measuring instrument: if it
// silently reports "0 units" or fails to fail on a new uncovered unit, every
// coverage claim downstream is worthless. These tests are the trust anchor:
//
//   1. ENUMERATION NON-EMPTY per class (anti-rot guard a) — a broken
//      enumerator returning [] would otherwise report "100% covered, 0 units".
//   2. The GUARANTEE-PRINCIPLE GATE rejects an under-mechanism claim — a `none`
//      test cannot legitimately cover a unit whose minMechanism is `cli`.
//   3. `--check` exits 1 (naming the gap) when a NEW uncovered unit is injected
//      into a temp copy of the source, and exits 0 when the temp tree is clean.
//   4. The RATCHET catches a simulated covered-count DECREASE.
//   5. The SUBCOMMAND CROSS-CHECK (anti-rot guard b) holds for real source:
//      the structured parser count equals the independent dispatch-site count.
//
// The injection tests use the AIDLC_COVERAGE_* env-var seams to redirect the
// source root + committed-baseline paths at a temp tree — the real shipped
// source and the real tests/.coverage-registry.json are NEVER mutated.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRegistry,
  emptyClasses,
  enumerateAllUnits,
  MECHANISMS,
  MIN_MECHANISM,
  mechanismFromSegment,
  mechanismOfTestFile,
  mechanismRank,
  mechanismsOf,
  parseCoversHeader,
  parseObjectDispatchKeys,
  parseSwitchDispatchCases,
  ratchetFromRows,
  registryJson,
  subcommandCrossCheck,
  UNIT_CLASSES,
} from "../gen-coverage-registry.ts";

// This test lives in tests/unit/; the generator tool + repo root are one level up.
const __FILE_DIR = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = join(__FILE_DIR, "..");
const REPO_ROOT = join(__FILE_DIR, "..", "..");
const TOOL = join(TESTS_DIR, "gen-coverage-registry.ts");

// ---------------------------------------------------------------------------
// 1. ENUMERATION NON-EMPTY per class (anti-rot guard a).
// ---------------------------------------------------------------------------
describe("enumeration is non-empty for every unit class (anti-rot guard a)", () => {
  const { rows } = buildRegistry();

  test("emptyClasses() reports no empty class against real source", () => {
    expect(emptyClasses(rows)).toEqual([]);
  });

  test("each class enumerates a plausible MINIMUM count", () => {
    // Hard floors transcribed from fresh source reads (2026-05-31), independent
    // of the enumerator. A drop below any floor means an enumerator stopped
    // seeing source — exactly the silent-rot failure this guards.
    const counts = Object.fromEntries(
      UNIT_CLASSES.map((c) => [c, rows.filter((r) => r.unitClass === c).length]),
    ) as Record<string, number>;
    expect(counts.function).toBeGreaterThanOrEqual(80); // 89 today (71 lib + 18 graph)
    expect(counts.audit).toBeGreaterThanOrEqual(55); // 61 today
    expect(counts.scope).toBeGreaterThanOrEqual(9); // 9 scope keys today
    expect(counts.stage).toBeGreaterThanOrEqual(30); // 32 stage .md today
    expect(counts.hook).toBeGreaterThanOrEqual(7); // 9 hooks today
    expect(counts.subcommand).toBeGreaterThanOrEqual(60); // 74 today
    expect(counts["render-surface"]).toBe(7); // statusline render branches (incl. agent display)
  });

  test("every row carries a valid status and a minMechanism matching its class", () => {
    const valid = new Set([
      "covered",
      "UNCOVERED",
      "UNDER-MECHANISM",
      "DEFERRED-tui",
    ]);
    for (const r of rows) {
      expect(valid.has(r.status)).toBe(true);
      expect(r.minMechanism).toBe(MIN_MECHANISM[r.unitClass]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The GUARANTEE-PRINCIPLE GATE rejects an under-mechanism claim.
// ---------------------------------------------------------------------------
describe("guarantee-principle gate (mechanism >= minMechanism)", () => {
  test("the mechanism ladder is none < cli < sdk < tui", () => {
    expect(mechanismRank("none")).toBeLessThan(mechanismRank("cli"));
    expect(mechanismRank("cli")).toBeLessThan(mechanismRank("sdk"));
    expect(mechanismRank("sdk")).toBeLessThan(mechanismRank("tui"));
  });

  test("the calibration tier maps to sdk; unknown tokens are rejected loudly", () => {
    expect(mechanismFromSegment("calibration")).toBe("sdk");
    expect(mechanismFromSegment("none")).toBe("none");
    expect(() => mechanismFromSegment("bogus")).toThrow(/unknown mechanism/);
  });

  test("a real subcommand unit (minMechanism cli) is NOT covered by a none-tier claim", () => {
    // Pick the first subcommand unit. Its minMechanism is `cli`. No shipped
    // test today claims it at cli mechanism, so it must be UNCOVERED — proving
    // a hypothetical .none. claim would be gated out, never counted as covered.
    const { rows } = buildRegistry();
    const sub = rows.find((r) => r.unitClass === "subcommand");
    expect(sub).toBeDefined();
    expect(sub!.minMechanism).toBe("cli");
    // Status is UNCOVERED (no adequate claim), never `covered`.
    expect(sub!.status).not.toBe("covered");
  });

  test("synthetic: a none-mechanism claim against a cli unit yields UNDER-MECHANISM, not covered", () => {
    // Build a temp tests dir whose ONLY claim is a .none. file naming a real
    // subcommand. The unit's minMechanism is cli > none, so the gate must
    // demote the claim: status UNDER-MECHANISM (claims present but all too weak).
    const tmp = mkdtempSync(join(tmpdir(), "cov-undermech-"));
    try {
      // Discover a real subcommand id to name in the claim.
      const realSub = enumerateAllUnits().find(
        (u) => u.unitClass === "subcommand",
      )!;
      const [tool, sub] = realSub.unitId.split(" ");
      const tiers = join(tmp, "unit");
      mkdirSync(tiers, { recursive: true });
      writeFileSync(
        join(tiers, "tfake.none.test.ts"),
        `// covers: subcommand:${tool}:${sub}\nimport { test } from "bun:test";\ntest("x", () => {});\n`,
      );

      const res = spawnSync(
        process.execPath,
        [TOOL, "--print"],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_COVERAGE_TESTS_DIR: tmp,
          },
        },
      );
      expect(res.status).toBe(0);
      const doc = JSON.parse(res.stdout);
      const row = doc.units.find(
        (u: { unitClass: string; unitId: string }) =>
          u.unitClass === "subcommand" && u.unitId === `${tool} ${sub}`,
      );
      expect(row).toBeDefined();
      // The claim WAS recorded (transparency) ...
      expect(row.coveredBy.length).toBeGreaterThanOrEqual(1);
      expect(row.coveredBy[0].mechanism).toBe("none");
      // ... but the gate demoted it: too weak for a cli-min unit.
      expect(row.status).toBe("UNDER-MECHANISM");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("synthetic: a cli-mechanism claim DOES cover the same cli unit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cov-clihit-"));
    try {
      const realSub = enumerateAllUnits().find(
        (u) => u.unitClass === "subcommand",
      )!;
      const [tool, sub] = realSub.unitId.split(" ");
      const tiers = join(tmp, "integration");
      mkdirSync(tiers, { recursive: true });
      // A .cli. file is mechanism cli == minMechanism cli -> adequate.
      writeFileSync(
        join(tiers, "tfake.cli.test.ts"),
        `// covers: subcommand:${tool}:${sub}\nimport { test } from "bun:test";\ntest("x", () => {});\n`,
      );
      const res = spawnSync(process.execPath, [TOOL, "--print"], {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_COVERAGE_TESTS_DIR: tmp },
      });
      expect(res.status).toBe(0);
      const doc = JSON.parse(res.stdout);
      const row = doc.units.find(
        (u: { unitClass: string; unitId: string }) =>
          u.unitClass === "subcommand" && u.unitId === `${tool} ${sub}`,
      );
      expect(row.status).toBe("covered");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. --check exits 1 on an injected NEW uncovered unit; exits 0 when clean.
//    This is the PROVE-THE-RATCHET assignment requirement, done in-test
//    against a TEMP COPY of the source — the real source is untouched.
// ---------------------------------------------------------------------------
describe("--check freshness diff (the ratchet mechanism)", () => {
  // Build a self-contained temp tree: copy the shipped source subtree we
  // enumerate from, plus a copy of the current tests dir for claim discovery,
  // and committed baselines generated FROM that temp tree (so the clean run is
  // green before injection).
  function buildTempTree(): {
    root: string;
    srcRoot: string;
    registry: string;
    ratchet: string;
    auditPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "cov-check-"));
    const srcRoot = join(root, "srcroot");
    // Copy only the directories the enumerators read.
    cpSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "tools"),
      join(srcRoot, "dist", "claude", ".claude", "tools"),
      { recursive: true },
    );
    cpSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "hooks"),
      join(srcRoot, "dist", "claude", ".claude", "hooks"),
      { recursive: true },
    );
    cpSync(
      join(
        REPO_ROOT,
        "dist", "claude",
        ".claude",
        "aidlc-common",
        "stages",
      ),
      join(srcRoot, "dist", "claude", ".claude", "aidlc-common", "stages"),
      { recursive: true },
    );
    const registry = join(root, ".coverage-registry.json");
    const ratchet = join(root, ".coverage-ratchet.json");
    const auditPath = join(
      srcRoot,
      "dist", "claude",
      ".claude",
      "tools",
      "aidlc-audit.ts",
    );
    return { root, srcRoot, registry, ratchet, auditPath };
  }

  function genInto(t: ReturnType<typeof buildTempTree>) {
    // Generate baselines from the temp tree (claims still read from the REAL
    // tests dir so the registry has the same claim set as production).
    return spawnSync(process.execPath, [TOOL], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_COVERAGE_SRC_ROOT: t.srcRoot,
        AIDLC_COVERAGE_REGISTRY: t.registry,
        AIDLC_COVERAGE_RATCHET: t.ratchet,
      },
    });
  }

  function checkAgainst(t: ReturnType<typeof buildTempTree>) {
    return spawnSync(process.execPath, [TOOL, "--check"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_COVERAGE_SRC_ROOT: t.srcRoot,
        AIDLC_COVERAGE_REGISTRY: t.registry,
        AIDLC_COVERAGE_RATCHET: t.ratchet,
      },
    });
  }

  test("clean temp tree: --check exits 0", () => {
    const t = buildTempTree();
    try {
      const gen = genInto(t);
      expect(gen.status).toBe(0);
      const chk = checkAgainst(t);
      expect(chk.status).toBe(0);
      expect(chk.stdout).toContain("OK");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("inject a NEW audit event into the temp source: --check exits 1 naming the gap", () => {
    const t = buildTempTree();
    try {
      // Baseline FIRST (clean), so the committed registry omits the new event.
      expect(genInto(t).status).toBe(0);

      // Now inject a fake new audit event into the TEMP source's
      // VALID_EVENT_TYPES Set. The set's first member is "STAGE_STARTED"; we
      // add a sibling after it.
      const audit = readFileSync(t.auditPath, "utf-8");
      const injected = audit.replace(
        '"STAGE_STARTED",',
        '"STAGE_STARTED",\n  "FAKE_INJECTED_EVENT",',
      );
      expect(injected).not.toBe(audit); // the anchor really matched
      writeFileSync(t.auditPath, injected);

      // The enumerated universe now has one more audit unit (uncovered) that
      // the committed registry does not — freshness diff must fail.
      const chk = checkAgainst(t);
      expect(chk.status).toBe(1);
      expect(chk.stderr).toContain("FRESHNESS DIFF FAILED");
      // The diff names the new unit.
      expect(chk.stderr).toContain("FAKE_INJECTED_EVENT");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("inject a NEW subcommand into the temp source: --check exits 1 naming the gap", () => {
    const t = buildTempTree();
    try {
      expect(genInto(t).status).toBe(0);

      // Add a fake case to aidlc-audit.ts's entry switch (switch(subcommand)).
      // The first case is `case "append": {`; inject a sibling before it.
      const audit = readFileSync(t.auditPath, "utf-8");
      const injected = audit.replace(
        'case "append": {',
        'case "fake-injected-sub": {\n      break;\n    }\n    case "append": {',
      );
      expect(injected).not.toBe(audit);
      writeFileSync(t.auditPath, injected);

      const chk = checkAgainst(t);
      expect(chk.status).toBe(1);
      expect(chk.stderr).toContain("FRESHNESS DIFF FAILED");
      expect(chk.stderr).toContain("fake-injected-sub");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("missing committed registry: --check exits 1", () => {
    const t = buildTempTree();
    try {
      // Generate ratchet only path? Simpler: never generate, just check.
      const chk = checkAgainst(t);
      expect(chk.status).toBe(1);
      expect(chk.stderr).toMatch(/does not exist/);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The RATCHET catches a simulated covered-count DECREASE.
// ---------------------------------------------------------------------------
describe("ratchet anti-regression (covered count cannot silently drop)", () => {
  test("a committed ratchet with a HIGHER baseline than reality fails --check", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
    try {
      // Reuse the real source via the default root (no SRC override) but point
      // the committed baselines at temp files we control.
      const registry = join(root, ".coverage-registry.json");
      const ratchet = join(root, ".coverage-ratchet.json");

      // Generate honest baselines from real source.
      const gen = spawnSync(process.execPath, [TOOL], {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_COVERAGE_REGISTRY: registry,
          AIDLC_COVERAGE_RATCHET: ratchet,
        },
      });
      expect(gen.status).toBe(0);

      // Now SIMULATE a regression: bump the committed ratchet's `function`
      // covered count ABOVE what the registry actually shows. The current
      // reality (6 covered) is now BELOW the inflated baseline -> ratchet fails.
      const r = JSON.parse(readFileSync(ratchet, "utf-8"));
      const realFn = r.coveredByClass.function;
      r.coveredByClass.function = realFn + 5;
      writeFileSync(ratchet, `${JSON.stringify(r, null, 2)}\n`);

      const chk = spawnSync(process.execPath, [TOOL, "--check"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_COVERAGE_REGISTRY: registry,
          AIDLC_COVERAGE_RATCHET: ratchet,
        },
      });
      expect(chk.status).toBe(1);
      expect(chk.stderr).toContain("RATCHET FAILED");
      expect(chk.stderr).toContain("function");
      expect(chk.stderr).toContain("DROPPED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ratchetFromRows derives covered-count-per-class from the rows", () => {
    const { rows } = buildRegistry();
    const r = ratchetFromRows(rows);
    // Sanity: function covered count equals the rows' covered functions.
    const fnCovered = rows.filter(
      (x) => x.unitClass === "function" && x.status === "covered",
    ).length;
    expect(r.coveredByClass.function).toBe(fnCovered);
  });
});

// ---------------------------------------------------------------------------
// 5. The SUBCOMMAND CROSS-CHECK (anti-rot guard b) holds for real source.
// ---------------------------------------------------------------------------
describe("subcommand cross-check (anti-rot guard b)", () => {
  test("structured parser count == independent dispatch-site count for every tool", () => {
    expect(subcommandCrossCheck()).toEqual([]);
  });

  test("the switch-dispatch parser reads only depth-0 cases (excludes nested sub-switches)", () => {
    // A miniature source with an entry switch + a nested switch keyed on a
    // different var. Only the entry cases must surface.
    const src = `
function main() {
  switch (subcommand) {
    case "get": { handleGet(); break; }
    case "set": { handleSet(); break; }
    case "lookup": {
      switch (sub) {
        case "phase-of": return; // nested — must NOT surface
        case "agent-for": return;
      }
      break;
    }
  }
}`;
    const cases = parseSwitchDispatchCases(src, "subcommand");
    expect(cases).toEqual(["get", "set", "lookup"]);
    expect(cases).not.toContain("phase-of");
    expect(cases).not.toContain("agent-for");
  });

  test("the object-dispatch parser reads only depth-1 keys (excludes handler-body keys)", () => {
    const src = `
const COMMANDS: Record<string, Handler> = {
  artifacts: () => { const x = { nested: 1 }; },
  topo: () => {},
  "validate-scope": (args) => {},
};`;
    const keys = parseObjectDispatchKeys(src, "COMMANDS");
    expect(keys).toEqual(["artifacts", "topo", "validate-scope"]);
    expect(keys).not.toContain("nested");
  });
});

// ---------------------------------------------------------------------------
// 6. covers-header parsing (the claim-discovery surface).
// ---------------------------------------------------------------------------
describe("covers: header parsing", () => {
  test("single-line // covers: with comma-separated ids", () => {
    const ids = parseCoversHeader(
      "// covers: function:stateFilePath, function:auditFilePath\nimport x;\n",
      false,
    );
    expect(ids).toEqual(["function:stateFilePath", "function:auditFilePath"]);
  });

  test("multi-line continuation folds in sub-ids (t114 shape) but skips prose", () => {
    const src = [
      "// covers: invariant:audit-first-atomicity",
      "//   sub-ids (one per state-mutating handler):",
      "//     invariant:audit-first-atomicity:approve  (handleApprove :675)",
      "//     invariant:audit-first-atomicity:reject   (handleReject :769)",
      "//",
      "// t114 — prose line with no class:id token here.",
      "import x;",
    ].join("\n");
    const ids = parseCoversHeader(src, false);
    expect(ids).toContain("invariant:audit-first-atomicity");
    expect(ids).toContain("invariant:audit-first-atomicity:approve");
    expect(ids).toContain("invariant:audit-first-atomicity:reject");
    // The `:675` annotation must NOT become a phantom id.
    expect(ids.some((i) => i.includes("675"))).toBe(false);
  });

  test("# covers: works for shell tests", () => {
    const ids = parseCoversHeader(
      "#!/usr/bin/env bash\n# covers: audit:WORKFLOW_COMPLETED\nset -e\n",
      true,
    );
    expect(ids).toEqual(["audit:WORKFLOW_COMPLETED"]);
  });

  test("no covers: header -> empty", () => {
    expect(parseCoversHeader("// just a comment\nimport x;\n", false)).toEqual(
      [],
    );
  });

  test("mechanismOfTestFile reads the dot-segment", () => {
    expect(mechanismOfTestFile("t112.none.test.ts")).toBe("none");
    expect(mechanismOfTestFile("sdk-drive.calibration.test.ts")).toBe("sdk");
    expect(mechanismOfTestFile("tfoo.cli.test.ts")).toBe("cli");
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism: registryJson is byte-stable across two builds.
// ---------------------------------------------------------------------------
describe("determinism", () => {
  test("registryJson is byte-identical across two independent builds", () => {
    const a = registryJson(buildRegistry().rows);
    const b = registryJson(buildRegistry().rows);
    expect(a).toBe(b);
  });

  test("MECHANISMS and UNIT_CLASSES are stable enumerations", () => {
    expect([...MECHANISMS]).toEqual(["none", "cli", "sdk", "tui"]);
    expect([...UNIT_CLASSES]).toEqual([
      "function",
      "audit",
      "scope",
      "stage",
      "hook",
      "subcommand",
      "render-surface",
    ]);
  });
});

// THE LIVE RATCHET — runs `--check` against the REAL committed registry (no
// env seam). Every other --check test above drives a synthetic temp tree; this
// one gates the actual tests/.coverage-registry.json + .coverage-ratchet.json
// on disk, so a clean checkout whose committed registry has drifted from the
// real source (e.g. a new subcommand/event/scope landed without regenerating)
// FAILS the suite. Without this, the ratchet's "cannot silently rot" promise is
// unenforced — the committed artifact can drift while the suite stays green.
describe("committed coverage registry is fresh (the live CI ratchet)", () => {
  test("`gen-coverage-registry.ts --check` exits 0 against the real committed files", () => {
    const chk = spawnSync(process.execPath, [TOOL, "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      // NO AIDLC_COVERAGE_* overrides — this checks the genuine on-disk registry.
    });
    if (chk.status !== 0) {
      // Surface the drift diff so the failure is self-explaining: the fix is
      // `bun tests/gen-coverage-registry.ts` to regenerate + commit the files.
      throw new Error(
        "committed coverage registry is STALE — run `bun tests/gen-coverage-registry.ts` " +
          "to regenerate tests/.coverage-registry.json + .coverage-ratchet.json.\n" +
          (chk.stdout || "") +
          (chk.stderr || ""),
      );
    }
    expect(chk.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. mechanismsOf is BODY-DERIVED (milestone 3, the Wave-2 keystone).
//
// Until milestone 3, mechanism came from the filename SEGMENT (t17.cli -> cli). milestone 3
// makes it the SET read from the drivers the body actually CALLS (refactor doc
// §2): driveAidlc( -> sdk, a tui-drive.ts spawn -> tui, and a shipped-binary
// subprocess (claude -p, a bun/node spawn of an aidlc-*.ts tool, or a bash
// spawn of run-tests.sh) -> cli. These tests pin three properties:
//
//   (a) THREE KNOWN-ANSWER FIXTURES — body wins over the segment; the codeView
//       comment-strip recovers a swallowed spawn; an import is not a drive.
//   (b) THE none->cli RECLASSIFICATION SET — broadening the cli arm beyond
//       `claude -p` reclassifies exactly the deterministic tool/hook/runner
//       spawners. This is the milestone 3 deliverable; the set is MEASURED off disk and
//       pinned here so a predicate regression (a missed spawn, or a false
//       positive flipping an import-only floor test) reds immediately.
//   (c) HONESTY: derived == recorded — for every committed coverage claim, the
//       mechanism the registry stored equals mechanismsOf(body) recomputed live,
//       so the registry can never record a mechanism the body does not drive.
// ---------------------------------------------------------------------------
describe("mechanismsOf is body-derived (milestone 3)", () => {
  // (a) Known-answer fixtures — each a minimal in-test source string. The
  // filename argument is chosen to DISAGREE with the body so "body wins" is
  // unambiguous.
  test("driveAidlc() in a file NAMED .none derives sdk (body beats segment)", () => {
    const src = [
      "// covers: audit:STAGE_STARTED",
      'import { driveAidlc } from "../harness/sdk-drive.ts";',
      "test('x', async () => {",
      '  const r = await driveAidlc("/aidlc bugfix");',
      "  expect(r).toBeDefined();",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["sdk"]);
  });

  test("a // comment containing /* above a real tool spawn still derives cli", () => {
    // A leading "// …/*…" line-comment must not interfere with deriving cli from
    // the spawn below it. NOTE: this case alone does NOT distinguish the current
    // string-aware codeView from the older indexOf("//") form — both strip this
    // whole leading-"//" line before any block pass, so both derive cli. The
    // genuine phantom-block-from-a-string-literal regression is pinned by the
    // sibling "a /* inside a string literal …" fixture below (which derives none
    // under the old form and cli under the string-aware strip). This fixture's
    // job is the narrower one: a //-comment whose text contains "/*" never
    // suppresses cli derivation.
    const src = [
      "// covers: subcommand:aidlc-state:show",
      'import { spawnSync } from "node:child_process";',
      "// matches tests/fixtures/**/*.md  (a glob with /* in a // comment)",
      "const BUN = process.execPath;",
      'const TOOL = "../../dist/claude/.claude/tools/aidlc-state.ts";',
      'test("x", () => {',
      '  const r = spawnSync(BUN, [TOOL, "show"], { encoding: "utf-8" });',
      "  expect(r.status).toBe(0);",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test("a // inside a string literal (a URL) does NOT truncate the real spawn", () => {
    // codeView strips comments while respecting string literals — so the "//" in
    // an "https://…" string is NOT treated as a line-comment opener. This fixture
    // bites the string-aware strip SPECIFICALLY: the URL string and the spawn are
    // on the SAME physical line, with the URL FIRST. The pre-hardening codeView
    // (indexOf("//") line-strip) truncated that line at `"https:` — erasing the
    // spawnSync + tool literal that follow it on the same line — so it derived
    // none. The string-aware strip keeps the whole line, so the spawn registers
    // cli. (Verified: this source derives cli under HEAD and none under the old
    // indexOf form, so it distinguishes the two.)
    const src = [
      "// covers: subcommand:aidlc-state:show",
      'import { spawnSync } from "node:child_process";',
      "const BUN = process.execPath;",
      'const u = "https://example.com/aidlc"; const r = spawnSync(BUN, ["../../dist/claude/.claude/tools/aidlc-state.ts", "show"]);',
      "expect(r.status).toBe(0);",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test("a /* inside a string literal does NOT open a phantom block comment", () => {
    // The string-aware strip leaves "/*" and "*/" INSIDE a string literal alone,
    // so a glob-like string value cannot open a phantom block comment that
    // swallows the spawn between it and a later "*/"-bearing string.
    const src = [
      "// covers: subcommand:aidlc-state:show",
      'import { spawnSync } from "node:child_process";',
      "const BUN = process.execPath;",
      'const pat = "glob /* not a comment";',
      'const TOOL = "../../dist/claude/.claude/tools/aidlc-state.ts";',
      '  const r = spawnSync(BUN, [TOOL, "show"], { encoding: "utf-8" });',
      'const close = "and */ still not a comment";',
      "expect(r.status).toBe(0);",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test("a suffix-free file with a dotted descriptive slug seeds none (no throw)", () => {
    // Forward-compat for milestone 6 (suffix drop): once .none/.cli are gone, a test whose
    // basename carries a DOT in a descriptive slug (not a mechanism segment) must
    // fall back to none, never crash the generator. mechanismOfTestFile recognises
    // only real mechanism segments; any other trailing dot-segment seeds none.
    const src = '// covers: function:foo\ntest("x", () => { expect(1).toBe(1); });';
    expect(mechanismsOf("t200.scope-exclusion.test.ts", src)).toEqual(["none"]);
  });

  test("importing resolveWinNode without a tui-drive.ts spawn does NOT derive tui", () => {
    // D-TUI-7: resolveWinNode is import-safe. An import line is stripped by
    // codeView, so a helper imported (but whose driver is never spawned in the
    // body) must not register tui. With no driver call at all, the body scan is
    // inconclusive and falls back to the filename segment (here: none).
    const src = [
      "// covers: function:resolveWinNode",
      'import { resolveWinNode } from "../harness/tui-drive.ts";',
      'test("x", () => {',
      "  expect(typeof resolveWinNode).toBe('function');",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["none"]);
  });

  // Recursively list every t*.test.ts under tests/ (the level dirs + harness).
  // Tier-list-independent on purpose: the design discovers a test by its living
  // in a directory, so this walk mirrors that rather than hard-coding TEST_TIERS.
  function allTestTsFiles(root: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      if (e.isDirectory()) {
        // Skip the transient run-output + node_modules; everything else is fair game.
        if (e.name === "logs" || e.name === "node_modules") continue;
        out.push(...allTestTsFiles(p));
      } else if (e.name.endsWith(".test.ts")) {
        out.push(p);
      }
    }
    return out;
  }

  function testsRelativePath(abs: string): string {
    return relative(TESTS_DIR, abs).replace(/\\/g, "/");
  }

  // (b) The milestone 3 reclassification set — MEASURED off disk, pinned here. A file is
  // a none->cli reclassification when its filename segment says `none` but its
  // body derives `cli` (a deterministic tool/hook/runner subprocess). If the
  // predicate regresses (misses a spawn, or false-positives an import-only floor
  // test), this list changes and the test reds — naming exactly which file moved.
  //
  // MAINTENANCE (read before you touch this): this pin is a deliberate manual
  // ratchet. When a later PR adds or rewrites a DETERMINISTIC test that spawns an
  // aidlc-*.ts tool / a hook / run-tests.sh under the bun-or-node runtime (milestone 4's
  // floor rewrites and milestone 5's .sh->bun ports will do exactly this), that file is a
  // new none->cli member and this test WILL red. That red is correct — add the
  // new file's tests/-relative path to this array (the failure message prints the
  // exact path that moved). Do NOT relax the assertion; the whole point is that a
  // new spawning test cannot silently change the cli surface without a human edit.
  //
  // MR6 NOTE: the suffix drop removed every `.cli`/`.none` filename segment, so
  // mechanismOfTestFile now seeds `none` for ALL suffix-free files. The set below
  // is therefore the FULL cli-spawner list (every .test.ts whose body derives cli
  // from a suffix-free name) — the former `.cli`-suffixed spawners joined the set
  // when their segment stopped saying cli. Same predicate, same honesty ratchet:
  // a new spawning test still cannot land without a human edit here.
  const EXPECTED_NONE_TO_CLI = [
    "integration/t102.test.ts",
    "integration/t104.test.ts",
    "integration/t105.test.ts",
    "integration/t106.test.ts",
    "integration/t111-session-skills-contract.test.ts",
    "integration/t112.serial.test.ts",
    "integration/t118.test.ts",
    "integration/t120-classify-roundtrip.test.ts",
    "integration/t121-stop-hook-enforce.test.ts",
    "integration/t195-stop-hook-compose-carveout.test.ts",
    "integration/t127-single-stage-invariant.test.ts",
    "integration/t128-custom-runner.test.ts",
    "integration/t130-scope-runners.test.ts",
    "integration/t131-hooks-settings-fire.test.ts",
    "integration/t135-invoke-swarm.test.ts",
    "integration/t136.test.ts",
    "integration/t137.test.ts",
    "integration/t145-state-lock-concurrency.test.ts",
    "integration/t162-per-intent-layout-cli.test.ts",
    "integration/t163-reaper-steal-race.test.ts",
    "integration/t164-shard-ordering-and-lock-bucket.test.ts",
    "integration/t165-intent-birth-p4.test.ts",
    "integration/t166-multi-repo-construction.test.ts",
    "integration/t171-birth-gate-registry.test.ts",
    "integration/t172-migration-audit-trail.test.ts",
    "integration/t173-session-switch-restamp.test.ts",
    "integration/t175-space-create-memory-isolation.test.ts",
    "integration/t185-stage-artifact-guard.test.ts",
    "integration/t188-plugin-compose.test.ts",
    "integration/t21b.test.ts",
    "integration/t31-help.test.ts",
    "integration/t33-hook-concurrency.test.ts",
    "integration/t39.test.ts",
    "integration/t45.test.ts",
    "integration/t49.test.ts",
    "integration/t51.test.ts",
    "integration/t52-drift-meta-validation.test.ts",
    "integration/t66.test.ts",
    "integration/t75.test.ts",
    "integration/t78-bolt-worktree-lifecycle.test.ts",
    "integration/t89.test.ts",
    "integration/t90.test.ts",
    "integration/t91.test.ts",
    "integration/t92.test.ts",
    "integration/t93.test.ts",
    "integration/t95-sensor-fire-hook-feature.test.ts",
    "integration/t96.test.ts",
    "integration/t98.test.ts",
    "integration/t-custom-harness-compile.test.ts",
    "integration/t45-revision-loop.test.ts",
    "integration/t46-parallel-bolt.test.ts",
    "integration/t47-failure-injection.test.ts",
    "integration/t48-runtime-graph-end-to-end.test.ts",
    "integration/t49-bolt-sensor-failures.test.ts",
    "integration/t99-learnings-gate-flow.test.ts",
    "smoke/t05-run-tests-parallel.test.ts",
    "smoke/t130-scope-runners.test.ts",
    "smoke/t86-stage-protocol-section-13.test.ts",
    "e2e/t-exec-codex-journey-workspace.serial.test.ts",
    "e2e/t-tui-custom-harness.serial.test.ts",
    "e2e/t-tui-render-colour.serial.test.ts",
    "unit/gen-coverage-registry.test.ts",
    "unit/t-memory-seed.test.ts",
    "unit/t07-hook-audit-logger.test.ts",
    "unit/t08.test.ts",
    "unit/t09.test.ts",
    "unit/t10-hook-session-start.test.ts",
    "unit/t100-memory-template-lifecycle.test.ts",
    "unit/t103.test.ts",
    "unit/t11.test.ts",
    "unit/t112-learnings-distribution-guard.test.ts",
    "unit/t114-orchestrate-next.test.ts",
    "unit/t115.test.ts",
    "unit/t116-directive-path-resolution.test.ts",
    "unit/t117.test.ts",
    "unit/t118.test.ts",
    "unit/t124-scope-transpose.test.ts",
    "unit/t125-scope-files.test.ts",
    "unit/t125.test.ts",
    "unit/t129-stage-runner-drift.test.ts",
    "unit/t13-hook-input-robustness.test.ts",
    "unit/t133-bolt-dag-compile.test.ts",
    "unit/t144-harness-seam.test.ts",
    "unit/t147-kiro-hook-adapter.test.ts",
    "unit/t149-codex-hook-adapter.test.ts",
    "unit/t155-template-override.test.ts",
    "unit/t158-memory-writer-reader-seam.test.ts",
    "unit/t168-statusline-orientation.test.ts",
    "unit/t169-session-resume-rebind.test.ts",
    "unit/t170-audit-logger-per-intent.test.ts",
    "unit/t179-orchestrate-rollforward-guard.test.ts",
    "unit/t180-kiro-rollforward-seam.test.ts",
    "unit/t182-codekb-placement.test.ts",
    "unit/t184-stage-graph-drift.test.ts",
    "unit/t186-foreach-per-unit-iteration.test.ts",
    "unit/t188-human-presence-gate.test.ts",
    "unit/t190-validate-grid.test.ts",
    "unit/t191-composed-scope-write.test.ts",
    "unit/t194-recompose.test.ts",
    "unit/t198-compose-surfaces.test.ts",
    "unit/t199-learnings-memory-path.test.ts",
    "unit/t201-swarm-batch-advance.test.ts",
    "unit/t202-gate-next-stage.test.ts",
    "unit/t203-nested-workspace-detection.test.ts",
    "unit/t204-compose-marker-doctor.test.ts",
    "unit/t206-optional-produces-coverage.test.ts",
    "unit/t207-unit-kind-schema.test.ts",
    "unit/t208-unit-kind-pruning.test.ts",
    "unit/t211-detect-submodules.test.ts",
    "unit/t212-doctor-submodules.test.ts",
    "unit/t218-kiro-ide-hook-adapter.test.ts",
    "unit/t205-gate-revision-backstop.test.ts",
    "unit/t214-routing-cost-strings.test.ts",
    "unit/t209-unit-major-iteration.test.ts",
    "unit/t210-iteration-knob-default.test.ts",
    "unit/t17.test.ts",
    "unit/t18.test.ts",
    "unit/t19.test.ts",
    "unit/t20.test.ts",
    "unit/t215-bolt-dag-selfheal.test.ts",
    "unit/t27.test.ts",
    "unit/t29.test.ts",
    "unit/t30-hook-session-end.test.ts",
    "unit/t31.test.ts",
    "unit/t33.test.ts",
    "unit/t34.test.ts",
    "unit/t35.test.ts",
    "unit/t36.test.ts",
    "unit/t37.test.ts",
    "unit/t38.test.ts",
    "unit/t60.test.ts",
    "unit/t61.test.ts",
    "unit/t63.test.ts",
    "unit/t67.test.ts",
    "unit/t68-version-changelog-sync.test.ts",
    "unit/t72.test.ts",
    "unit/t76.test.ts",
    "unit/t77-bolt-worktree-flags.test.ts",
    "unit/t79.test.ts",
    "unit/t80.test.ts",
    "unit/t81.test.ts",
    "unit/t82-hold-merge-invariant.test.ts",
    "unit/t83-doctor-orphan-worktree.test.ts",
    "unit/t84.test.ts",
    "unit/t85.test.ts",
    "unit/t94-sensor-fire-hook.test.ts",
    "unit/t96.test.ts",
    "unit/t97.test.ts",
    "e2e/t113.test.ts",
    "e2e/t122-stop-hook-e2e.test.ts",
    "e2e/t126-emitter-pairing-cofire.test.ts",
    "e2e/t53.test.ts",
    "e2e/t60-construction-worktrees-enterprise.test.ts",
    "e2e/t61-construction-worktrees-feature.test.ts",
    "e2e/t62-construction-worktrees-mvp.test.ts",
    "e2e/t63-construction-worktrees-poc.test.ts",
    "e2e/t64-construction-worktrees-workshop.test.ts",
    "e2e/t65-construction-worktrees-bugfix.test.ts",
    "e2e/t66-construction-worktrees-refactor.test.ts",
    "e2e/t67-construction-worktrees-security-patch.test.ts",
    "e2e/t02.test.ts",
    "e2e/t03.test.ts",
    "e2e/t04.test.ts",
    "e2e/t05.test.ts",
    "e2e/t06.test.ts",
    "e2e/t07-audit-fork-merge.test.ts",
    "e2e/t09-halt-and-ask-preservation.test.ts",
    "e2e/t10-halt-and-ask-discard.test.ts",
    "e2e/t11-halt-and-ask-retry-correlation.test.ts",
    "e2e/t12-bolt-runtime-graph-fork.test.ts",
    "e2e/t134-swarm-referee.test.ts",
  ];

  test("the none->cli reclassification set is exactly the deterministic spawners", () => {
    const measured: string[] = [];
    for (const abs of allTestTsFiles(TESTS_DIR)) {
      const base = basename(abs);
      const seg = mechanismOfTestFile(base);
      const set = mechanismsOf(base, readFileSync(abs, "utf-8"));
      if (seg === "none" && set.includes("cli")) {
        measured.push(testsRelativePath(abs));
      }
    }
    expect(measured.sort()).toEqual([...EXPECTED_NONE_TO_CLI].sort());
  });

  // (c) HONESTY — derived == recorded over the whole committed registry. Every
  // coverage claim stored a `mechanism`; recompute mechanismsOf(body) for that
  // claim's file and assert the stored scalar is a MEMBER of the derived set.
  // (The registry serialises the set's strongest representative; membership is
  // the honest invariant — a recorded mechanism the body does not drive is a lie.)
  test("every recorded coverage mechanism is one the body actually derives", () => {
    const registry = JSON.parse(
      readFileSync(join(TESTS_DIR, ".coverage-registry.json"), "utf-8"),
    );
    // Collect (file, mechanism) pairs from every unit's coveredBy[].
    const pairs = new Map<string, Set<string>>(); // file -> recorded mechanisms
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const v of node) collect(v);
      } else if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (Array.isArray(o.coveredBy)) {
          for (const c of o.coveredBy as Array<Record<string, unknown>>) {
            if (typeof c.file === "string" && typeof c.mechanism === "string") {
              if (!pairs.has(c.file)) pairs.set(c.file, new Set());
              (pairs.get(c.file) as Set<string>).add(c.mechanism);
            }
          }
        }
        for (const v of Object.values(o)) collect(v);
      }
    };
    collect(registry);

    const lies: string[] = [];
    for (const [relFile, recorded] of pairs) {
      // relFile is repo-root-relative (tests/<tier>/<name>); only .test.ts files
      // are body-scannable. .sh claims fall back to the segment and are not the
      // subject of this body-derive honesty check.
      if (!relFile.endsWith(".test.ts")) continue;
      const abs = join(REPO_ROOT, relFile);
      const base = relFile.split("/").pop() as string;
      // Compare as plain strings: `recorded` holds JSON mechanism strings, and we
      // assert each is a MEMBER of the body-derived set (also as strings).
      const derived = new Set<string>(mechanismsOf(base, readFileSync(abs, "utf-8")));
      for (const m of recorded) {
        if (!derived.has(m)) {
          lies.push(`${relFile}: recorded ${m}, body derives {${[...derived].join(",")}}`);
        }
      }
    }
    expect(lies).toEqual([]);
  });
});

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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(counts["render-surface"]).toBe(6); // 6 statusline render branches (D-TUI-5)
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
      const tiers = join(tmp, "feature");
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

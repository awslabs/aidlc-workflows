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
//   3. `--check` builds the registry fresh and needs no committed file: a NEW
//      uncovered unit injected into a temp copy of the source is named, never
//      a failure, because coverage did not drop.
//   4. The RATCHET names a unit the base covers that lost its claim, whether
//      the base is a registry file (`--baseline`) or a commit built fresh with
//      its own packager and generator (`--base`). Nothing is committed.
//   5. The SUBCOMMAND CROSS-CHECK (anti-rot guard b) holds for real source:
//      the structured parser count equals the independent dispatch-site count.
//
// The injection tests use the AIDLC_COVERAGE_* env-var seams to redirect the
// source root + registry paths at a temp tree, so the real shipped source and
// the developer's local tests/.coverage-registry.json are NEVER mutated.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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
  mechanismsOf,
  parseCoversHeader,
  parseIfDispatchCases,
  parseObjectDispatchKeys,
  parseSwitchDispatchCases,
  classCounts,
  lostClaims,
  type RegistryRow,
  registryJson,
  subcommandCrossCheck,
  UNIT_CLASSES,
} from "../gen-coverage-registry.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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

  test("enumerated identities are unique, including overloaded functions", () => {
    const units = enumerateAllUnits();
    const identities = units.map((u) => `${u.unitClass}\0${u.unitId}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(
      units.filter(
        (u) =>
          u.unitClass === "function" &&
          u.unitId === "function:readRegularFileNoFollowOrThrow",
      ),
    ).toHaveLength(1);
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
    const sub = rows.find(
      (r) => r.unitClass === "subcommand" && r.status !== "covered",
    );
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
// 3. --check builds the registry fresh: no committed file, and a NEW uncovered
//    unit is not a coverage drop. Driven against a TEMP COPY of the source; the
//    real source is untouched.
// ---------------------------------------------------------------------------
describe("--check builds the registry fresh (nothing committed)", () => {
  // Build a self-contained temp tree: copy the shipped source subtree we
  // enumerate from. Claims are still discovered from the real tests dir.
  function buildTempTree(): {
    root: string;
    srcRoot: string;
    registry: string;
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
    const auditPath = join(
      srcRoot,
      "dist", "claude",
      ".claude",
      "tools",
      "aidlc-audit.ts",
    );
    return { root, srcRoot, registry, auditPath };
  }

  function genInto(t: ReturnType<typeof buildTempTree>) {
    // Write a registry built from the temp tree: the baseline a later check
    // compares against.
    return spawnSync(process.execPath, [TOOL], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_COVERAGE_SRC_ROOT: t.srcRoot,
        AIDLC_COVERAGE_REGISTRY: t.registry,
      },
    });
  }

  function checkAgainst(t: ReturnType<typeof buildTempTree>, args: string[] = []) {
    return spawnSync(process.execPath, [TOOL, "--check", ...args], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_COVERAGE_SRC_ROOT: t.srcRoot,
        AIDLC_COVERAGE_REGISTRY: t.registry,
      },
    });
  }

  test("a tree with no registry file anywhere: --check exits 0", () => {
    const t = buildTempTree();
    try {
      const chk = checkAgainst(t);
      expect(chk.status, chk.stderr).toBe(0);
      expect(chk.stdout).toContain("OK");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("a NEW audit event with no claim is not a coverage drop: --check passes and names it", () => {
    const t = buildTempTree();
    try {
      // The baseline FIRST (clean), so it omits the new event.
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

      expect(checkAgainst(t).status).toBe(0);
      const chk = checkAgainst(t, ["--baseline", t.registry]);
      expect(chk.status, chk.stderr).toBe(0);
      expect(chk.stdout).toContain('new audit unit "FAKE_INJECTED_EVENT" has no covers: claim');
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("a NEW subcommand with no claim is not a coverage drop, and guard (b) still counts it", () => {
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

      const chk = checkAgainst(t, ["--baseline", t.registry]);
      expect(chk.status, chk.stderr).toBe(0);
      expect(chk.stdout).toContain("fake-injected-sub");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  test("a baseline that is not a registry: --check exits 1 naming it", () => {
    const t = buildTempTree();
    try {
      writeFileSync(t.registry, "not json\n");
      const chk = checkAgainst(t, ["--baseline", t.registry]);
      expect(chk.status).toBe(1);
      expect(chk.stderr).toContain(`${t.registry} is not a readable registry`);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. THE RATCHET: a unit the base covers cannot silently lose its claim.
// ---------------------------------------------------------------------------
describe("ratchet anti-regression (a covered unit cannot silently lose its claim)", () => {
  test("a unit the baseline covers but the source no longer does fails --check by name", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
    try {
      // Reuse the real source via the default root (no SRC override) but write
      // the baseline to a temp file we control.
      const registry = join(root, ".coverage-registry.json");
      const env = { ...process.env, AIDLC_COVERAGE_REGISTRY: registry };
      const run = (args: string[]) => spawnSync(process.execPath, [TOOL, ...args], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
      });
      expect(run([]).status).toBe(0);
      // SIMULATE a lost claim: the baseline says covered, reality does not.
      const doc = JSON.parse(readFileSync(registry, "utf-8")) as { units: RegistryRow[] };
      const victim = doc.units.find((unit) => unit.status === "UNCOVERED")!;
      victim.status = "covered";
      victim.coveredBy = [{ file: "tests/unit/t-gone.test.ts", mechanism: "none" }];
      writeFileSync(registry, `${JSON.stringify(doc, null, 2)}\n`);
      const chk = run(["--check", "--baseline", registry]);
      expect(chk.status).toBe(1);
      expect(chk.stderr).toContain(`COVERAGE DROPPED: ${victim.unitClass} unit "${victim.unitId}" is covered on the base but now UNCOVERED`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a covered unit whose code was deleted or renamed is no coverage drop", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-ratchet-gone-"));
    try {
      const registry = join(root, ".coverage-registry.json");
      const env = { ...process.env, AIDLC_COVERAGE_REGISTRY: registry };
      const run = (args: string[]) => spawnSync(process.execPath, [TOOL, ...args], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
      });
      expect(run([]).status).toBe(0);
      // The baseline still lists a covered unit the source no longer has.
      const doc = JSON.parse(readFileSync(registry, "utf-8")) as { units: RegistryRow[] };
      doc.units.push({
        unitClass: "function", unitId: "function:deletedOrRenamedHelper", minMechanism: "none",
        coveredBy: [{ file: "tests/unit/t-deleted.test.ts", mechanism: "none" }], status: "covered",
      });
      writeFileSync(registry, `${JSON.stringify(doc, null, 2)}\n`);
      const chk = run(["--check", "--baseline", registry]);
      expect(chk.status, chk.stderr).toBe(0);
      expect(chk.stderr).not.toContain("COVERAGE DROPPED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lostClaims ignores units that are still covered and units removed from the source", () => {
    const row = (unitId: string, status: RegistryRow["status"]): RegistryRow =>
      ({ unitClass: "audit", unitId, minMechanism: "none", coveredBy: [], status });
    const committed = [row("KEPT", "covered"), row("LOST", "covered"), row("REMOVED", "covered"), row("NEVER", "UNCOVERED")];
    const fresh = [row("KEPT", "covered"), row("LOST", "UNCOVERED"), row("NEVER", "UNCOVERED")];
    expect(lostClaims(committed, fresh).map((r) => r.unitId)).toEqual(["LOST"]);
  });

  test("classCounts derives per-class totals from the rows; the registry stores none", () => {
    const { rows } = buildRegistry();
    const counts = classCounts(rows);
    expect(counts.function.covered).toBe(rows.filter((x) => x.unitClass === "function" && x.status === "covered").length);
    expect(Object.values(counts).reduce((n, c) => n + c.total, 0)).toBe(rows.length);
    expect(Object.keys(JSON.parse(registryJson(rows)))).toEqual(["generator", "generatedFrom", "unitClasses", "minMechanism", "units"]);
  });

  test("the registry is never committed: git does not track it and ignores it", () => {
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(git("ls-files", "--", "tests/.coverage-registry.json").stdout.trim()).toBe("");
    expect(git("check-ignore", "-q", "--no-index", "tests/.coverage-registry.json").status).toBe(0);
  });

  test("--base <ref> builds that commit fresh, with its own packager and generator, and never touches the checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "cov-base-"));
    try {
      const repo = join(root, "repo");
      cpSync(join(REPO_ROOT, "dist", "claude", ".claude", "tools"), join(repo, "dist", "claude", ".claude", "tools"), { recursive: true });
      cpSync(join(REPO_ROOT, "dist", "claude", ".claude", "hooks"), join(repo, "dist", "claude", ".claude", "hooks"), { recursive: true });
      cpSync(join(REPO_ROOT, "dist", "claude", ".claude", "aidlc-common", "stages"), join(repo, "dist", "claude", ".claude", "aidlc-common", "stages"), { recursive: true });
      // The base commit's own packager and generator. The packager leaves a
      // marker in the tree it ran in; the generator refuses to run anywhere
      // the packager did not, or under this check's seams, and prints a
      // registry in which one unit this tree leaves uncovered is covered.
      const victim = buildRegistry().rows.find((r) => r.status === "UNCOVERED")!;
      mkdirSync(join(repo, "scripts"));
      mkdirSync(join(repo, "tests"));
      writeFileSync(join(repo, "scripts", "package.ts"), [
        'import { writeFileSync } from "node:fs";',
        'if (process.argv[2] !== "claude") process.exit(2);',
        'writeFileSync("packaged-here", "");',
        "",
      ].join("\n"));
      const baseDoc = { units: [{ ...victim, status: "covered", coveredBy: [{ file: "tests/unit/t-gone.test.ts", mechanism: "none" }] }] };
      writeFileSync(join(repo, "tests", "gen-coverage-registry.ts"), [
        'import { existsSync } from "node:fs";',
        'if (!existsSync("packaged-here") || process.env.AIDLC_COVERAGE_SRC_ROOT !== undefined || process.argv[2] !== "--print") process.exit(3);',
        `process.stdout.write(${JSON.stringify(JSON.stringify(baseDoc))});`,
        "",
      ].join("\n"));
      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: repo, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      expect(git("init", "-q", "-b", "main").status).toBe(0);
      expect(git("add", "scripts", "tests").status).toBe(0);
      expect(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base").status).toBe(0);
      const before = git("status", "--porcelain").stdout;

      const run = (ref: string) => spawnSync(process.execPath, [TOOL, "--check", "--base", ref], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
        env: { ...process.env, AIDLC_COVERAGE_SRC_ROOT: repo, AIDLC_COVERAGE_REGISTRY: join(root, "unused.json") },
      });
      const chk = run("HEAD");
      expect(chk.status, `${chk.stdout}${chk.stderr}`).toBe(1);
      expect(chk.stderr).toContain(`COVERAGE DROPPED: ${victim.unitClass} unit "${victim.unitId}" is covered on the base but now UNCOVERED`);
      expect(git("status", "--porcelain").stdout).toBe(before);
      expect(existsSync(join(repo, "packaged-here"))).toBe(false);

      const missing = run("no-such-ref");
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('the base "no-such-ref" is not a commit in this repository');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CI's required check runs the ratchet against the commit's first parent", () => {
    const ci = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf-8")) as {
      jobs: Record<string, { needs?: string[]; steps?: Array<{ run?: string; with?: Record<string, unknown> }> }>;
    };
    const job = ci.jobs.coverage_ratchet;
    expect(job.steps?.[0]?.with?.["fetch-depth"]).toBe(2);
    expect(job.steps?.map((step) => step.run)).toContain("bun tests/gen-coverage-registry.ts --check --base HEAD^1");
    expect(ci.jobs.test.needs).toContain("coverage_ratchet");
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

  test("the if-chain parser reads aidlc-unit-style direct command comparisons", () => {
    const src = `
export function main(argv: string[]): void {
  const command = argv.shift();
  if (command === "claim") claim();
  else if (command === "release") release();
  else if (command === "participate") participate();
  else if (command === "status") status();
  if (other === "nested") ignore();
}`;
    expect(parseIfDispatchCases(src, "command")).toEqual([
      "claim",
      "release",
      "participate",
      "status",
    ]);
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

// THE REAL TREE: `--check` with no env seam builds the registry fresh from
// this checkout and runs both anti-rot guards. Every other --check test above
// drives a synthetic temp tree. Whether coverage dropped against the base
// commit is CI's coverage ratchet job (`--check --base HEAD^1`).
describe("the real tree passes --check", () => {
  test("`gen-coverage-registry.ts --check` exits 0 on this checkout", () => {
    const chk = spawnSync(process.execPath, [TOOL, "--check"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: REPO_ROOT,
      // NO AIDLC_COVERAGE_* overrides: this builds the genuine tree.
    });
    expect(chk.status, `${chk.stdout}${chk.stderr}`).toBe(0);
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
//   (a) KNOWN-ANSWER FIXTURES, both directions: body wins over the segment;
//       the codeView comment-strip recovers a swallowed spawn; a real spawn or
//       shared driver derives cli; an import, a comment, or a non-runtime spawn
//       is not a drive and stays none.
//   (b) WHOLE TREE: there is no hand-kept list of spawner files. A mechanism
//       matters only through a coverage claim, and every claim's mechanism is
//       pinned twice: by the coverage ratchet (`--check --base` fails when a
//       predicate change drops any claim below its unit's bar), and by (c). A list that every
//       spawner-adding PR appended to only made those PRs collide.
//   (c) HONESTY: derived == recorded. For every coverage claim, the
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

  test("spawning the root aidlc.ts dispatcher derives cli", () => {
    const src = [
      "// covers: subcommand:aidlc-utility:plugin-validate",
      'import { spawnSync } from "node:child_process";',
      "const BUN = process.execPath;",
      'const DISPATCHER = "../../dist/claude/.claude/tools/aidlc.ts";',
      'test("x", () => {',
      '  const r = spawnSync(BUN, [DISPATCHER, "plugin", "validate"]);',
      "  expect(r.status).toBe(0);",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test("runOrchestrateNext derives cli through the shared spawned-engine helper", () => {
    const src = [
      "// covers: subcommand:aidlc-orchestrate:next",
      'import { runOrchestrateNext } from "../harness/fixtures.ts";',
      'test("x", () => {',
      '  const r = runOrchestrateNext(ORCH, projectDir, ["--stage", "x"]);',
      "  expect(r.status).toBe(0);",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test("runMergeTool derives cli through the shared t326 merge fixture", () => {
    const src = [
      "// covers: subcommand:aidlc-unit:pin",
      'import { runMergeTool, UNIT } from "../harness/team-unit-merge.ts";',
      'test("x", () => {',
      '  const r = runMergeTool(UNIT, ["pin", "alpha"], projectDir);',
      "  expect(r.status).toBe(0);",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
  });

  test.each([
    ["runCheckpointTool", "swarm-checkpoint", 'runCheckpointTool(pd, "tools/aidlc-bolt.ts", ["abort"])'],
    ["runChangeControlTool", "change-control-plan-approval", "runChangeControlTool([BUN, GUARD], project)"],
  ])("%s derives cli through its shared t334/t344 fixture", (name, module, call) => {
    const src = [
      "// covers: subcommand:aidlc-bolt:abort",
      `import { ${name} } from "../harness/${module}.ts";`,
      'test("x", () => {',
      `  const r = ${call};`,
      "  expect(r.code).toBe(0);",
      "});",
    ].join("\n");
    expect(mechanismsOf("t99.none.test.ts", src)).toEqual(["cli"]);
    // Named only in a comment or an import, the helper drives nothing.
    expect(mechanismsOf("t99.none.test.ts", src.replace(`  const r = ${call};`, `  // ${call}`))).toEqual(["none"]);
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

  test.each([
    // The runtime spawn runs no tool: only the stripped import names one.
    ["an in-process import of a shipped tool beside a bare runtime spawn", [
      'import { spawnSync } from "node:child_process";',
      'import { getField } from "../../dist/claude/.claude/tools/aidlc-lib.ts";',
      'test("x", () => {',
      '  expect(spawnSync(process.execPath, ["--version"]).status).toBe(0);',
      '  expect(getField("- **A**: b", "A")).toBe("b");',
      "});",
    ]],
    // The import strip misses a path on a continuation line; a spawn that is
    // not a bun/node runtime keeps the file out of cli anyway.
    ["a multi-line tool import beside a git spawn", [
      'import { spawnSync } from "node:child_process";',
      "import {",
      "  getField,",
      '} from "../../dist/claude/.claude/tools/aidlc-lib.ts";',
      'test("x", () => {',
      '  expect(spawnSync("git", ["status"]).status).toBe(0);',
      '  expect(getField("- **A**: b", "A")).toBe("b");',
      "});",
    ]],
    ["a spawn named only in a comment", [
      '// const r = spawnSync(BUN, ["../../dist/claude/.claude/tools/aidlc-state.ts", "show"]);',
      'test("x", () => { expect(1).toBe(1); });',
    ]],
    ["a git spawn beside a tool path it only reads", [
      'import { spawnSync } from "node:child_process";',
      'import { readFileSync } from "node:fs";',
      'const TOOL = "../../dist/claude/.claude/tools/aidlc-state.ts";',
      'test("x", () => {',
      '  expect(spawnSync("git", ["status"]).status).toBe(0);',
      '  expect(readFileSync(TOOL, "utf-8")).toContain("export");',
      "});",
    ]],
  ])("%s is not a drive and stays none", (_label, body) => {
    const src = ["// covers: function:getField", ...body].join("\n");
    expect(mechanismsOf("t99.test.ts", src)).toEqual(["none"]);
  });

  // (c) HONESTY: derived == recorded over the whole registry, built fresh.
  // Every coverage claim stores a `mechanism`; recompute mechanismsOf(body) for that
  // claim's file and assert the stored scalar is a MEMBER of the derived set.
  // (The registry serialises the set's strongest representative; membership is
  // the honest invariant — a recorded mechanism the body does not drive is a lie.)
  test("every recorded coverage mechanism is one the body actually derives", () => {
    const registry = JSON.parse(registryJson(buildRegistry().rows));
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

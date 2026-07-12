// covers: subcommand:aidlc-sensor:fire, audit:SENSOR_FAILED
//
// CLI-contract port of tests/integration/t92-sensor-fire.sh (TAP plan 43),
// mechanism = cli. Equal-fidelity migration: every .sh assertion that
// shelled out to `bun aidlc-sensor.ts fire ...` is preserved by SPAWNING
// the real CLI via node:child_process (spawnSync / spawn), asserting on
// res.status / res.stdout / res.stderr exactly as the .sh asserted on
// $? / stdout. The contract under test is the PROCESS boundary plus the
// audit-row side effects the dispatcher writes (SENSOR_FIRED + terminal
// row, detail files, validate-before-lock), so it stays a spawn — an
// in-process handleFire() twin would lose the exit-code half AND the
// process.exit(0) / lock-orphan-recovery behaviour the .sh relies on.
//
// SPAWN vs IN-PROCESS split: ALL 45 assertions are spawn-based. There is
// no pure-function arm — every behaviour (argv validation exit codes,
// truth-table branches, audit emission, concurrency, lock-orphan
// recovery) is observed through the real CLI subprocess + the audit.md it
// writes. So spawnCount = 45-worth-of-cases, inProcessCount = 0.
//
// Tests 44-45 (Groups N + O) are additions beyond the original .sh's
// plan-43, guarding the type-check status gate: test 44 covers the
// config-load failure (tsc non-zero + zero parseable diagnostics ->
// script-error: exit-2, not a false PASS); test 45 covers the cross-file
// edge (tsc non-zero with diagnostics for OTHER files but none for the
// target -> per-file clean PASS, gate keys on allErrors not the filtered
// errors).
//
// SUBCOMMAND UNIT: this .cli file credits the `aidlc-sensor fire`
// subcommand unit (covers KEY subcommand:aidlc-sensor:fire). `list` and
// `describe` are NOT exercised by t92 (the .sh only fires), so they are
// NOT claimed.
//
// FIXTURE DISCIPLINE (diverges from the .sh's stub-copy by design):
//   - Per-sensor stub scripts under tests/fixtures/v05-mr9-sensor-fire/
//     scripts/ are copied into an ISOLATED temp dir (STUB_SCRIPT_DIR) and
//     the dispatcher is pointed at it via the AIDLC_SENSOR_SCRIPT_DIR seam
//     (mirroring AIDLC_SENSORS_DIR for manifests). The .sh copied stubs
//     next to the dispatcher in dist/.../tools/; the seam removes that —
//     stubs NEVER touch the shipped tree, so a run that dies mid-test
//     leaves no orphaned stubs in the version-controlled artifact AND
//     concurrent test files no longer race on a shared dir (the -P 8
//     flake). The frozen fixture source stays untouched; NOTHING is
//     written under tests/fixtures/**.
//   - An inline argv-capture stub (Group M) is written into the same temp
//     STUB_SCRIPT_DIR for the run, same isolation.
//   - Each case uses a FRESH temp project dir (mkdtempSync) because
//     `fire` WRITES audit rows (SENSOR_FIRED + terminal); a shared dir
//     would cross-contaminate event counts. Cleaned in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// P9: with no intent cursor seeded, the sensor dispatcher resolves the BARE
// space record root (docsRoot -> spaceRecordRoot) at aidlc/spaces/default/
// intents/ for BOTH the per-clone audit SHARD (audit/<host>-<clone>.md) and the
// detail tree (.aidlc-sensors/<stage>/...) — the flat aidlc-docs/ root is retired.
// The SENSED output files still live wherever the test writes them (e.g.
// aidlc-docs/test.md), so the dispatcher's project-relative `Output path` field
// is unchanged. Audit reads go through readAllAuditShards (the subprocess mints
// its own clone-id, distinct from the test process's memoized one, so read the
// whole audit/ dir rather than a single memoized shard path).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}
// Posix record prefix for the relative detail-path audit fields.
const RP = "aidlc/spaces/default/intents";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const SENSOR_TS = join(TOOLS_DIR, "aidlc-sensor.ts");
const STUBS_DIR = join(REPO_ROOT, "tests", "fixtures", "v05-mr9-sensor-fire", "scripts");
const FIXTURES_ROOT = join(REPO_ROOT, "tests", "fixtures", "v05-mr9-sensor-fire");

// --- Stub setup: write fixture per-sensor scripts into an ISOLATED temp dir
// and point the dispatcher at it via AIDLC_SENSOR_SCRIPT_DIR (the script seam,
// mirroring AIDLC_SENSORS_DIR for manifests). We deliberately do NOT copy stubs
// into the shipped dist/.../tools/ tree: that both pollutes the version-
// controlled artifact if a run dies mid-test (orphaned stubs) AND makes
// concurrent test files race on that shared directory (the -P 8 flake). The
// fire() helpers below auto-set AIDLC_SENSOR_SCRIPT_DIR whenever a fork manifest
// (AIDLC_SENSORS_DIR) is in play, so the stub scripts resolve from the temp dir;
// real-sensor tests (Group B/C, no AIDLC_SENSORS_DIR) leave it unset and the
// dispatcher resolves the shipped per-sensor scripts from dist/ as in production.
// Dispatcher-resolved stubs: named in fork manifests, resolved via the
// AIDLC_SENSOR_SCRIPT_DIR seam from STUB_SCRIPT_DIR. aidlc-sensor-lock-exit.ts is
// NOT here — it is a direct-spawn helper (never named in a manifest) that imports
// the real withAuditLock, so it needs to sit beside aidlc-lib.ts; it gets its own
// temp shim (LOCK_EXIT_SHIM) that imports lib by absolute path.
const STUB_NAMES = [
  "aidlc-sensor-stub-pass.ts",
  "aidlc-sensor-stub-fail.ts",
  "aidlc-sensor-stub-127.ts",
  "aidlc-sensor-stub-exit2.ts",
  "aidlc-sensor-stub-bad.ts",
  "aidlc-sensor-stub-slow.ts",
];
const ARGV_STUB = "aidlc-sensor-stub-argv.ts";
// Isolated dir holding the stub per-sensor scripts (populated in beforeAll).
const STUB_SCRIPT_DIR = mkdtempSync(join(tmpdir(), "aidlc-t92-stubs-"));
// Direct-spawn lock-orphan helper: a temp shim importing the real withAuditLock
// by absolute path (so it resolves outside dist/, no shipped-tree mutation).
const LOCK_EXIT_SHIM = join(STUB_SCRIPT_DIR, "aidlc-sensor-lock-exit-shim.ts");
const tempDirs: string[] = [STUB_SCRIPT_DIR];

beforeAll(() => {
  for (const name of STUB_NAMES) {
    copyFileSync(join(STUBS_DIR, name), join(STUB_SCRIPT_DIR, name));
  }
  // Lock-orphan helper: import withAuditLock from the real lib by ABSOLUTE path
  // (the fixture's own `./aidlc-lib.ts` relative import only resolves when copied
  // beside the shipped lib — we avoid that dist/ mutation with an absolute import).
  const realLib = join(TOOLS_DIR, "aidlc-lib.ts");
  writeFileSync(
    LOCK_EXIT_SHIM,
    [
      "// @ts-nocheck",
      "// t92 lock-orphan helper (temp shim): acquire the audit lock via the real",
      "// withAuditLock, then process.exit(1) from inside the callback to exercise",
      "// the process.on('exit') lock-reaping recovery path. Imports lib absolutely",
      "// so it runs from a temp dir without copying anything into dist/.",
      `import { withAuditLock } from ${JSON.stringify(realLib)};`,
      "const projectDir = process.argv[2];",
      'if (!projectDir) { process.stderr.write("usage: <projectDir>\\n"); process.exit(2); }',
      "withAuditLock(projectDir, () => { process.exit(1); });",
      "",
    ].join("\n"),
    "utf-8",
  );
  // Inline argv-capture stub used by the upstream-coverage consumes test
  // (Group M). Writes process.argv as JSON to AIDLC_T92_ARGV_OUT, then
  // emits {"pass": true}. Mirrors the .sh heredoc stub (lines 89-100).
  writeFileSync(
    join(STUB_SCRIPT_DIR, ARGV_STUB),
    [
      "// @ts-nocheck",
      "// t92 fixture: argv-capture stub. Writes process.argv to",
      "// $AIDLC_T92_ARGV_OUT and emits {\"pass\": true}. Used to verify the",
      "// dispatcher passes the expected --consumes / --stage / --output-path",
      "// flags through to per-sensor scripts.",
      'import { writeFileSync } from "node:fs";',
      "const out = process.env.AIDLC_T92_ARGV_OUT;",
      "if (out) writeFileSync(out, JSON.stringify(process.argv));",
      'process.stdout.write(JSON.stringify({ pass: true }) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// --- Helpers (TS analogues of the .sh helpers) ---

/** make_proj (t92-sensor-fire.sh:104-110): fresh temp project + aidlc-docs/. */
function makeProj(): string {
  // toPortablePath (cygpath -m on win32, no-op elsewhere): mkdtempSync yields a
  // path form native Windows bun can't round-trip as CLAUDE_PROJECT_DIR. The
  // tool writes audit.md via toPosix(auditFilePath) (forward-slash), so without
  // this the test reads back the raw form and finds 0 SENSOR_FIRED rows even
  // though the fire succeeded. Mirrors createTestProject() (harness/fixtures.ts).
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t92-proj-")));
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  tempDirs.push(proj);
  return proj;
}

/**
 * make_fork_sensors (t92-sensor-fire.sh:113-136): write a single fork
 * sensor manifest into a fresh AIDLC_SENSORS_DIR. Returns the dir.
 */
function makeForkSensors(
  id: string,
  cmd: string,
  matches = "",
  timeout = 5,
): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-t92-sensors-"));
  tempDirs.push(dir);
  const lines = [
    "---",
    `id: ${id}`,
    "kind: deterministic",
    `command: ${cmd}`,
    "default_severity: advisory",
    "description: t92 fork manifest",
  ];
  if (matches) lines.push(`matches: "${matches}"`);
  lines.push("input_schema: {}");
  lines.push("output_schema: {}");
  lines.push(`timeout_seconds: ${timeout}`);
  lines.push("---");
  lines.push("# stub");
  lines.push("");
  writeFileSync(join(dir, `aidlc-${id}.md`), lines.join("\n"), "utf-8");
  return dir;
}

/** The audit/ shard dir the dispatcher writes into (bare space record root). */
const auditDir = (proj: string): string => join(recordRoot(proj), "audit");
/** Whether ANY audit shard exists (the P9 successor to "is there an audit.md?"). */
function auditExists(proj: string): boolean {
  const dir = auditDir(proj);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".md"));
}
/** The merged audit trail (per-clone shards; one here for a single clone). */
function readAudit(proj: string): string {
  return readAllAuditShards(proj);
}

/** audit_event_count: count bodies with `**Event**: <type>` across the trail. */
function auditEventCount(proj: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readAudit(proj)
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * audit_field (t92-sensor-fire.sh:153-176): value of <key> from the FIRST
 * audit block whose `**Event**:` matches <ev>. Walks the merged trail; resets
 * at `## ` headings and `---` separators; splits `**label**: value` on the
 * literal `**: ` separator.
 */
function auditField(proj: string, ev: string, key: string): string {
  let matched = false;
  for (const line of readAudit(proj).split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/**
 * audit_field_count (t92-sensor-fire.sh:183-198): count `**…**:` lines in
 * the FIRST audit block whose `**Event**:` matches <ev>.
 */
function auditFieldCount(proj: string, ev: string): number {
  let inSection = false;
  let n = 0;
  let matchesEv = false;
  for (const line of readAudit(proj).split("\n")) {
    if (line.startsWith("## ")) {
      inSection = true;
      n = 0;
      matchesEv = false;
      continue;
    }
    if (line === "---") {
      if (inSection && matchesEv) return n;
      inSection = false;
      n = 0;
      matchesEv = false;
      continue;
    }
    if (inSection && line.startsWith("**Event**: ")) {
      if (line === `**Event**: ${ev}`) matchesEv = true;
    }
    if (inSection && line.startsWith("**")) n++;
  }
  return matchesEv ? n : 0;
}

const isInteger = (s: string): boolean => /^[0-9]+$/.test(s);

interface SpawnResult {
  rc: number;
  out: string;
}

/**
 * Spawn `aidlc-sensor.ts fire ...` synchronously, combining stdout+stderr
 * like the .sh's `2>&1`. `env` overrides are merged onto process.env
 * (CLAUDE_PROJECT_DIR / AIDLC_SENSORS_DIR / AIDLC_T92_ARGV_OUT). cwd is
 * left at the test's cwd to match the .sh, where --output-path is always
 * absolute so cwd never affects path resolution.
 */
// A fork manifest (AIDLC_SENSORS_DIR) names a STUB per-sensor script, which
// lives in STUB_SCRIPT_DIR — so point the dispatcher's script resolver there.
// Real-sensor tests pass no AIDLC_SENSORS_DIR; they leave the seam unset and the
// dispatcher resolves the shipped scripts from dist/ as in production.
function withStubScriptDir(env: Record<string, string>): Record<string, string> {
  return "AIDLC_SENSORS_DIR" in env
    ? { AIDLC_SENSOR_SCRIPT_DIR: STUB_SCRIPT_DIR, ...env }
    : env;
}

function fire(args: string[], env: Record<string, string>): SpawnResult {
  const res = spawnSync(BUN, [SENSOR_TS, "fire", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...withStubScriptDir(env) },
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Async spawn variant for backgrounded / parallel fires (Group G). */
function fireAsync(args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(BUN, [SENSOR_TS, "fire", ...args], {
      env: { ...process.env, ...withStubScriptDir(env) },
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ============================================================
// Group A — Argv parsing (8): exit 1 on every invalid invocation,
// and verify NO audit file ever appears (validate-before-lock).
// (t92-sensor-fire.sh:202-293)
// ============================================================

describe("t92 Group A: argv validation (exit 1, no audit emit)", () => {
  let argvProj = "";
  beforeAll(() => {
    argvProj = makeProj();
    writeFileSync(join(argvProj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
  });
  const E = (): Record<string, string> => ({ CLAUDE_PROJECT_DIR: argvProj });

  test("1: fire with no positional id -> exit 1 + clear error", () => {
    const r = fire(
      ["--stage", "intent-capture", "--output-path", join(argvProj, "aidlc-docs", "test.md")],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("fire requires a sensor id");
  });

  test("2: fire with unknown sensor id -> exit 1 + known-ids hint", () => {
    const r = fire(
      ["no-such-sensor", "--stage", "intent-capture", "--output-path", join(argvProj, "aidlc-docs", "test.md")],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("unknown sensor id");
  });

  test("3: fire without --stage -> exit 1 + clear error", () => {
    const r = fire(
      ["required-sections", "--output-path", join(argvProj, "aidlc-docs", "test.md")],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("fire requires --stage");
  });

  test("4: fire with unknown stage slug -> exit 1 + known-stages hint", () => {
    const r = fire(
      ["required-sections", "--stage", "no-such-stage", "--output-path", join(argvProj, "aidlc-docs", "test.md")],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("unknown stage slug");
  });

  test("5: fire without --output-path -> exit 1 + clear error", () => {
    const r = fire(["required-sections", "--stage", "intent-capture"], E());
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("fire requires --output-path");
  });

  test("6: fire with output-path missing on disk -> exit 1 + clear error", () => {
    const r = fire(
      ["required-sections", "--stage", "intent-capture", "--output-path", "/var/empty/definitely-missing-aidlc-t92.md"],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("output path does not exist");
  });

  test("7: fire with matches-rejection -> exit 1 + clear error", () => {
    // linter ships matches=**/*.{ts,js}; firing it on a .md is rejected pre-lock.
    const r = fire(
      ["linter", "--stage", "code-generation", "--output-path", join(argvProj, "aidlc-docs", "test.md")],
      E(),
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain('does not match sensor "linter" filter');
  });

  test("8: validate-before-lock — 7 invalid invocations created NO audit file", () => {
    expect(auditExists(argvProj)).toBe(false);
  });
});

// ============================================================
// Group B — PASSED round-trip per sensor, REAL fixtures (4).
// (t92-sensor-fire.sh:295-395)
// Fires the actual shipped per-sensor scripts (AIDLC_SENSORS_DIR unset
// so the shipped manifests load) against real fixture content.
// ============================================================

/** run_passed_md_real (t92-sensor-fire.sh:321-349). */
function runPassedMdReal(
  id: string,
  stage: string,
  fixtureMd: string,
): {
  fired: number;
  passed: number;
  dur: string;
  firedId: string;
  passedId: string;
  path: string;
  detailExists: boolean;
  outname: string;
} {
  const proj = makeProj();
  // basename, not split("/"): on native Windows fixtureMd is an absolute path
  // with backslash separators, so split("/") returns the whole path as one
  // element and join(proj, ..., <abs-path>) yields C:\...\C:\... (ENOENT).
  const outname = basename(fixtureMd);
  copyFileSync(fixtureMd, join(proj, "aidlc-docs", outname));
  fire([id, "--stage", stage, "--output-path", join(proj, "aidlc-docs", outname)], {
    CLAUDE_PROJECT_DIR: proj,
  });
  const f = proj;
  return {
    fired: auditEventCount(f, "SENSOR_FIRED"),
    passed: auditEventCount(f, "SENSOR_PASSED"),
    dur: auditField(f, "SENSOR_PASSED", "Duration ms"),
    firedId: auditField(f, "SENSOR_FIRED", "Fire id"),
    passedId: auditField(f, "SENSOR_PASSED", "Fire id"),
    path: auditField(f, "SENSOR_PASSED", "Output path"),
    detailExists: existsSync(join(recordRoot(proj), ".aidlc-sensors")),
    outname,
  };
}

/** run_passed_ts_real (t92-sensor-fire.sh:356-386). */
function runPassedTsReal(
  id: string,
  stage: string,
  fixtureDir: string,
): {
  fired: number;
  passed: number;
  dur: string;
  firedId: string;
  passedId: string;
  path: string;
  note: string;
  detailExists: boolean;
  subdir: string;
} {
  const proj = makeProj();
  // basename, not split("/"): see runPassedMdReal — absolute backslash path on Windows.
  const subdir = basename(fixtureDir);
  cpSync(fixtureDir, join(proj, subdir), { recursive: true });
  fire([id, "--stage", stage, "--output-path", join(proj, subdir, "sample.ts")], {
    CLAUDE_PROJECT_DIR: proj,
  });
  const f = proj;
  return {
    fired: auditEventCount(f, "SENSOR_FIRED"),
    passed: auditEventCount(f, "SENSOR_PASSED"),
    dur: auditField(f, "SENSOR_PASSED", "Duration ms"),
    firedId: auditField(f, "SENSOR_FIRED", "Fire id"),
    passedId: auditField(f, "SENSOR_PASSED", "Fire id"),
    path: auditField(f, "SENSOR_PASSED", "Output path"),
    note: auditField(f, "SENSOR_PASSED", "Note"),
    detailExists: existsSync(join(recordRoot(proj), ".aidlc-sensors")),
    subdir,
  };
}

describe("t92 Group B: PASSED real round-trip per sensor", () => {
  test("9: required-sections — passing markdown (3 H2s) -> PASSED, relative path", () => {
    const r = runPassedMdReal(
      "required-sections",
      "intent-capture",
      join(FIXTURES_ROOT, "passing-markdown", "intent-statement.md"),
    );
    expect(r.fired).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.firedId).not.toBe("");
    expect(r.firedId).toBe(r.passedId);
    expect(isInteger(r.dur)).toBe(true);
    expect(r.detailExists).toBe(false);
    expect(r.path).toBe(`aidlc-docs/${r.outname}`);
  });

  test("10: upstream-coverage — passing markdown, intent-capture (consumes:[]) -> PASSED", () => {
    const r = runPassedMdReal(
      "upstream-coverage",
      "intent-capture",
      join(FIXTURES_ROOT, "passing-markdown", "intent-statement.md"),
    );
    expect(r.fired).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.firedId).not.toBe("");
    expect(r.firedId).toBe(r.passedId);
    expect(isInteger(r.dur)).toBe(true);
    expect(r.detailExists).toBe(false);
    expect(r.path).toBe(`aidlc-docs/${r.outname}`);
  });

  // linter spawns the real eslint binary (manifest timeout_seconds=30); the
  // first cold run can take several seconds, so override bun's 5s default.
  test("11: linter — passing TS (errorCount=0) -> PASSED, relative path, no Note", () => {
    const r = runPassedTsReal("linter", "code-generation", join(FIXTURES_ROOT, "passing-typescript"));
    expect(r.fired).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.firedId).not.toBe("");
    expect(r.firedId).toBe(r.passedId);
    expect(isInteger(r.dur)).toBe(true);
    expect(r.detailExists).toBe(false);
    expect(r.path).toBe(`${r.subdir}/sample.ts`);
    expect(r.note).toBe("");
  }, 60000);

  // type-check spawns the real tsc (manifest timeout_seconds=60); give it
  // generous headroom over bun's 5s default.
  test("12: type-check — passing TS (errors=0) -> PASSED, relative path, no Note", () => {
    const r = runPassedTsReal("type-check", "code-generation", join(FIXTURES_ROOT, "passing-typescript"));
    expect(r.fired).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.firedId).not.toBe("");
    expect(r.firedId).toBe(r.passedId);
    expect(isInteger(r.dur)).toBe(true);
    expect(r.detailExists).toBe(false);
    expect(r.path).toBe(`${r.subdir}/sample.ts`);
    expect(r.note).toBe("");
  }, 90000);
});

// ============================================================
// Group C — FAILED round-trip per sensor, REAL fixtures (4).
// (t92-sensor-fire.sh:397-505)
// ============================================================

/** run_failed_md_real (t92-sensor-fire.sh:422-454). */
function runFailedMdReal(
  id: string,
  stage: string,
  fixtureMd: string,
  expectedFindings: string,
): void {
  const proj = makeProj();
  // basename, not split("/"): on native Windows fixtureMd is an absolute path
  // with backslash separators, so split("/") returns the whole path as one
  // element and join(proj, ..., <abs-path>) yields C:\...\C:\... (ENOENT).
  const outname = basename(fixtureMd);
  copyFileSync(fixtureMd, join(proj, "aidlc-docs", outname));
  fire([id, "--stage", stage, "--output-path", join(proj, "aidlc-docs", outname)], {
    CLAUDE_PROJECT_DIR: proj,
  });
  const f = proj;
  const fired = auditEventCount(f, "SENSOR_FIRED");
  const failed = auditEventCount(f, "SENSOR_FAILED");
  const firedId = auditField(f, "SENSOR_FIRED", "Fire id");
  const failedId = auditField(f, "SENSOR_FAILED", "Fire id");
  const findings = auditField(f, "SENSOR_FAILED", "Findings count");
  const detailPath = auditField(f, "SENSOR_FAILED", "Detail path");
  const path = auditField(f, "SENSOR_FAILED", "Output path");
  expect(fired).toBe(1);
  expect(failed).toBe(1);
  expect(firedId).not.toBe("");
  expect(firedId).toBe(failedId);
  expect(findings).toBe(expectedFindings);
  expect(detailPath).toBe(`${RP}/.aidlc-sensors/${stage}/${id}-${firedId}.md`);
  expect(existsSync(join(proj, detailPath))).toBe(true);
  expect(path).toBe(`aidlc-docs/${outname}`);
}

/** run_failed_ts_real (t92-sensor-fire.sh:458-490). */
function runFailedTsReal(
  id: string,
  stage: string,
  fixtureDir: string,
  expectedFindings: string,
): void {
  const proj = makeProj();
  // basename, not split("/"): see runPassedMdReal — absolute backslash path on Windows.
  const subdir = basename(fixtureDir);
  cpSync(fixtureDir, join(proj, subdir), { recursive: true });
  fire([id, "--stage", stage, "--output-path", join(proj, subdir, "sample.ts")], {
    CLAUDE_PROJECT_DIR: proj,
  });
  const f = proj;
  const fired = auditEventCount(f, "SENSOR_FIRED");
  const failed = auditEventCount(f, "SENSOR_FAILED");
  const firedId = auditField(f, "SENSOR_FIRED", "Fire id");
  const failedId = auditField(f, "SENSOR_FAILED", "Fire id");
  const findings = auditField(f, "SENSOR_FAILED", "Findings count");
  const detailPath = auditField(f, "SENSOR_FAILED", "Detail path");
  const path = auditField(f, "SENSOR_FAILED", "Output path");
  expect(fired).toBe(1);
  expect(failed).toBe(1);
  expect(firedId).not.toBe("");
  expect(firedId).toBe(failedId);
  expect(findings).toBe(expectedFindings);
  expect(detailPath).toBe(`${RP}/.aidlc-sensors/${stage}/${id}-${firedId}.md`);
  expect(existsSync(join(proj, detailPath))).toBe(true);
  expect(path).toBe(`${subdir}/sample.ts`);
}

describe("t92 Group C: FAILED real round-trip per sensor", () => {
  test("13: required-sections — failing markdown (0 H2s) -> Findings count=2", () => {
    runFailedMdReal(
      "required-sections",
      "intent-capture",
      join(FIXTURES_ROOT, "failing-required-sections", "intent-statement.md"),
      "2",
    );
  });

  test("14: upstream-coverage — failing market-research (no ref) -> Findings count=1", () => {
    runFailedMdReal(
      "upstream-coverage",
      "market-research",
      join(FIXTURES_ROOT, "failing-upstream-coverage", "market-research.md"),
      "1",
    );
  });

  // Real eslint spawn (manifest timeout_seconds=30) — override bun's 5s default.
  test("15: linter — failing TS (no-unused-vars error) -> Findings count=1", () => {
    runFailedTsReal("linter", "code-generation", join(FIXTURES_ROOT, "failing-linter"), "1");
  }, 60000);

  // Real tsc spawn (manifest timeout_seconds=60) — generous headroom.
  test("16: type-check — failing TS (string->number) -> Findings count=1", () => {
    runFailedTsReal("type-check", "code-generation", join(FIXTURES_ROOT, "failing-type-check"), "1");
  }, 90000);
});

// ============================================================
// Group D — Tool-unavailable (2): per-sensor script exits 127.
// Dispatcher classifies branch b -> SENSOR_PASSED Note=tool-unavailable.
// (t92-sensor-fire.sh:507-535)
// ============================================================

function runToolUnavailable(id: string, stage: string, matches: string): void {
  const proj = makeProj();
  writeFileSync(join(proj, "aidlc-docs", "output.ts"), "stub\n", "utf-8");
  const sensorsDir = makeForkSensors(id, "bun .claude/tools/aidlc-sensor-stub-127.ts", matches);
  fire([id, "--stage", stage, "--output-path", join(proj, "aidlc-docs", "output.ts")], {
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_SENSORS_DIR: sensorsDir,
  });
  const f = proj;
  expect(auditEventCount(f, "SENSOR_PASSED")).toBe(1);
  expect(auditField(f, "SENSOR_PASSED", "Note")).toBe("tool-unavailable");
}

describe("t92 Group D: tool-unavailable (exit 127 -> PASSED Note)", () => {
  test("17: linter tool-unavailable -> Note=tool-unavailable", () => {
    runToolUnavailable("linter", "code-generation", "**/*.{ts,js}");
  });
  test("18: type-check tool-unavailable -> Note=tool-unavailable", () => {
    runToolUnavailable("type-check", "code-generation", "**/*.{ts,tsx}");
  });
});

// ============================================================
// Group E — Script-error fall-through (3): branches e (exit-N), f
// (bad-output), and the detail-write-failed fallback.
// (t92-sensor-fire.sh:537-576)
// ============================================================

describe("t92 Group E: script-error fall-through", () => {
  test("19: exit 2 -> Note=script-error: exit-2", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-exit2.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    expect(auditField(proj, "SENSOR_PASSED", "Note")).toBe("script-error: exit-2");
  });

  test("20: garbage stdout -> Note=script-error: bad-output", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-bad.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    expect(auditField(proj, "SENSOR_PASSED", "Note")).toBe("script-error: bad-output");
  });

  test("21: blocked detail dir -> Note=script-error: detail-write-failed", () => {
    // Pre-create the per-stage detail dir as a regular FILE so the
    // dispatcher's mkdirSync(detailDir, {recursive:true}) throws ENOTDIR.
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    mkdirSync(join(recordRoot(proj), ".aidlc-sensors"), { recursive: true });
    writeFileSync(join(recordRoot(proj), ".aidlc-sensors", "intent-capture"), "block\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-fail.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const note = auditField(proj, "SENSOR_PASSED", "Note");
    expect(note.startsWith("script-error: detail-write-failed")).toBe(true);
  });
});

// ============================================================
// Group F — Budget override (2): stub-slow + timeout_seconds=1.
// (t92-sensor-fire.sh:578-624)
// ============================================================

describe("t92 Group F: budget override (timeout -> SENSOR_BUDGET_OVERRIDE)", () => {
  test("22: stub-slow + timeout=1 -> BUDGET_OVERRIDE, layer=registry, cap=1, observed>=1", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-slow.ts", "", 1);
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const f = proj;
    const observed = auditField(f, "SENSOR_BUDGET_OVERRIDE", "Observed value");
    expect(auditEventCount(f, "SENSOR_BUDGET_OVERRIDE")).toBe(1);
    expect(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap layer")).toBe("registry");
    expect(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap value")).toBe("1");
    expect(isInteger(observed)).toBe(true);
    expect(Number(observed)).toBeGreaterThanOrEqual(1);
  }, 15000);

  test("23: slow-command fixture -> Observed>=Cap, Output path project-relative", () => {
    const proj = makeProj();
    mkdirSync(join(proj, "slow-command"), { recursive: true });
    copyFileSync(join(FIXTURES_ROOT, "slow-command", "sample.ts"), join(proj, "slow-command", "sample.ts"));
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-slow.ts", "", 1);
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "slow-command", "sample.ts")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const f = proj;
    const cap = auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap value");
    const observed = auditField(f, "SENSOR_BUDGET_OVERRIDE", "Observed value");
    expect(auditEventCount(f, "SENSOR_BUDGET_OVERRIDE")).toBe(1);
    expect(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap layer")).toBe("registry");
    expect(isInteger(cap)).toBe(true);
    expect(isInteger(observed)).toBe(true);
    expect(Number(observed)).toBeGreaterThanOrEqual(Number(cap));
    expect(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Output path")).toBe("slow-command/sample.ts");
  }, 15000);
});

// ============================================================
// Group G — Concurrency (3): happy path, lock-released-across-spawn,
// lock-orphan recovery. (t92-sensor-fire.sh:626-708)
// ============================================================

describe("t92 Group G: concurrency invariants", () => {
  test("24: 5 parallel fires -> 5 FIRED + 5 PASSED, all 5 Fire ids paired twice", async () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-pass.ts");
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        fireAsync(
          ["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")],
          { CLAUDE_PROJECT_DIR: proj, AIDLC_SENSORS_DIR: sensors },
        ),
      ),
    );
    const f = proj;
    expect(auditEventCount(f, "SENSOR_FIRED")).toBe(5);
    expect(auditEventCount(f, "SENSOR_PASSED")).toBe(5);
    // Each Fire id appears exactly twice (FIRED + PASSED); count unique ids
    // that are paired. Mirrors the awk uniq -c | $1==2 | wc -l.
    const ids = readAudit(f)
      .split("\n")
      .filter((l) => l.startsWith("**Fire id**: "))
      .map((l) => l.slice("**Fire id**: ".length));
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const paired = [...counts.values()].filter((c) => c === 2).length;
    expect(paired).toBe(5);
  }, 30000);

  test("25: lock-released-across-spawn — fast PASSED lands during slow's spawn window", async () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const slowSensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-slow.ts", "", 10);
    const fastSensors = makeForkSensors("linter", "bun .claude/tools/aidlc-sensor-stub-pass.ts", "**/*.{ts,js}");
    const tsFile = join(proj, "aidlc-docs", "code.ts");
    writeFileSync(tsFile, "stub\n", "utf-8");
    // Start the slow fire (sleeps 5s) in the background.
    const slowDone = fireAsync(
      ["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")],
      { CLAUDE_PROJECT_DIR: proj, AIDLC_SENSORS_DIR: slowSensors },
    );
    // Wait for slow's FIRED row to land — the deterministic "slow holds the
    // spawn window" anchor. A fixed sleep here assumed sub-200ms process spawn,
    // which does not hold on Windows (bun child startup alone can exceed it);
    // the row appearing IS the event the original 200ms tried to approximate.
    // The spawn window is 5s wide (stub-slow sleeps 5s), so the fast fire below
    // has ample room to complete inside it on any platform.
    {
      const f = proj;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (
          existsSync(f) &&
          readAudit(f)
            .split("\n")
            .some((l) => l === "**Sensor ID**: required-sections")
        ) {
          break;
        }
        await sleep(50);
      }
    }
    // Fast fire starts inside slow's spawn window; await its completion.
    await fireAsync(["linter", "--stage", "code-generation", "--output-path", tsFile], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: fastSensors,
    });
    // Snapshot row order WHILE slow is still running. required-sections has
    // only its FIRED row (1); linter has FIRED+PASSED (2) — proving the slow
    // fire released its lock between windows A and B.
    const f = proj;
    const text = readAudit(f).split("\n");
    const slowVisible = text.filter((l) => l === "**Sensor ID**: required-sections").length;
    const fastVisible = text.filter((l) => l === "**Sensor ID**: linter").length;
    await slowDone;
    expect(slowVisible).toBe(1);
    expect(fastVisible).toBe(2);
  }, 30000);

  test("26: lock-orphan recovery — process.exit(1)-inside-lock -> next fire fast (no retry burn)", async () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    // Invoke the lock-exit helper directly (it imports withAuditLock and
    // process.exit(1)s while holding the lock). Expect exit code 1.
    const lockExit = spawnSync(BUN, [LOCK_EXIT_SHIM, proj], {
      encoding: "utf-8",
    });
    const lockRc = lockExit.status ?? -1;
    const start = Date.now();
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-pass.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const elapsedMs = Date.now() - start;
    expect(lockRc).toBe(1);
    expect(auditEventCount(proj, "SENSOR_PASSED")).toBe(1);
    // The .sh asserts elapsed < 3s (no 5x100ms retry burn). Use ms form.
    expect(elapsedMs).toBeLessThan(3000);
  }, 15000);
});

// ============================================================
// Group H — Detail-file body shape (4). (t92-sensor-fire.sh:710-754)
// ============================================================

function runDetailShape(id: string, stage: string, matches = ""): void {
  const proj = makeProj();
  let outname = "output.md";
  if (id === "linter" || id === "type-check") outname = "output.ts";
  writeFileSync(join(proj, "aidlc-docs", outname), "stub\n", "utf-8");
  const sensors = makeForkSensors(id, "bun .claude/tools/aidlc-sensor-stub-fail.ts", matches);
  fire([id, "--stage", stage, "--output-path", join(proj, "aidlc-docs", outname)], {
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_SENSORS_DIR: sensors,
  });
  const detailDir = join(recordRoot(proj), ".aidlc-sensors", stage);
  // Find the single <id>-*.md detail file.
  const firedId = auditField(proj, "SENSOR_FAILED", "Fire id");
  const detail = join(detailDir, `${id}-${firedId}.md`);
  expect(existsSync(detail)).toBe(true);
  const body = readFileSync(detail, "utf-8");
  const lines = body.split("\n");
  expect(lines).toContain(`# ${id} finding — ${stage}`);
  expect(lines.some((l) => l.startsWith("**Timestamp**: "))).toBe(true);
  expect(lines.some((l) => /^\*\*Fire id\*\*: [0-9a-f]{8}$/.test(l))).toBe(true);
  expect(lines.some((l) => l.startsWith("**Output path**: "))).toBe(true);
  expect(lines).toContain("**Pass**: false");
  expect(lines).toContain("## Findings");
  expect(lines).toContain("```json");
  expect(body.includes('"pass": false')).toBe(true);
}

describe("t92 Group H: detail-file body shape per sensor", () => {
  test("27: required-sections detail-file shape", () => {
    runDetailShape("required-sections", "intent-capture");
  });
  test("28: upstream-coverage detail-file shape", () => {
    runDetailShape("upstream-coverage", "intent-capture");
  });
  test("29: linter detail-file shape", () => {
    runDetailShape("linter", "code-generation", "**/*.{ts,js}");
  });
  test("30: type-check detail-file shape", () => {
    runDetailShape("type-check", "code-generation", "**/*.{ts,tsx}");
  });
});

// ============================================================
// Group I — Detail-file collision-free (1). (t92-sensor-fire.sh:756-775)
// ============================================================

describe("t92 Group I: detail-file collision-free", () => {
  test("31: 2 FAILED fires -> 2 distinct Fire-id-keyed detail paths", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-fail.ts");
    for (let i = 0; i < 2; i++) {
      fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
        CLAUDE_PROJECT_DIR: proj,
        AIDLC_SENSORS_DIR: sensors,
      });
    }
    const detailDir = join(recordRoot(proj), ".aidlc-sensors", "intent-capture");
    // List required-sections-*.md files in the detail dir.
    const files: string[] = existsSync(detailDir)
      ? readdirSync(detailDir).filter((n) => /^required-sections-.*\.md$/.test(n))
      : [];
    expect(files.length).toBe(2);
    expect(new Set(files).size).toBe(2);
  }, 15000);
});

// ============================================================
// Group J — Audit-row required-fields (4). (t92-sensor-fire.sh:777-840)
// ============================================================

describe("t92 Group J: audit-row required fields per event type", () => {
  // 32 + 33 share one project (the .sh fires once, asserts both FIRED + PASSED).
  let jProj = "";
  beforeAll(() => {
    jProj = makeProj();
    writeFileSync(join(jProj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-pass.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(jProj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: jProj,
      AIDLC_SENSORS_DIR: sensors,
    });
  });

  test("32: SENSOR_FIRED — 6 fields (Timestamp, Event, Fire id, Sensor ID, Stage slug, Output path)", () => {
    const f = jProj;
    expect(auditFieldCount(f, "SENSOR_FIRED")).toBe(6);
    expect(auditField(f, "SENSOR_FIRED", "Fire id")).not.toBe("");
    expect(auditField(f, "SENSOR_FIRED", "Sensor ID")).toBe("required-sections");
    expect(auditField(f, "SENSOR_FIRED", "Stage slug")).toBe("intent-capture");
    expect(auditField(f, "SENSOR_FIRED", "Output path")).not.toBe("");
  });

  test("33: SENSOR_PASSED — 7 fields including Duration ms (integer)", () => {
    const f = jProj;
    expect(auditFieldCount(f, "SENSOR_PASSED")).toBe(7);
    expect(isInteger(auditField(f, "SENSOR_PASSED", "Duration ms"))).toBe(true);
  });

  test("34: SENSOR_FAILED — 8 fields including Detail path + Findings count (integer)", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-fail.ts");
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const f = proj;
    expect(auditFieldCount(f, "SENSOR_FAILED")).toBe(8);
    expect(auditField(f, "SENSOR_FAILED", "Detail path")).not.toBe("");
    expect(isInteger(auditField(f, "SENSOR_FAILED", "Findings count"))).toBe(true);
  });

  test("35: SENSOR_BUDGET_OVERRIDE — 9 fields (+Cap layer/value, Observed value)", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("required-sections", "bun .claude/tools/aidlc-sensor-stub-slow.ts", "", 1);
    fire(["required-sections", "--stage", "intent-capture", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
    });
    const f = proj;
    expect(auditFieldCount(f, "SENSOR_BUDGET_OVERRIDE")).toBe(9);
    expect(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap layer")).toBe("registry");
    expect(isInteger(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Cap value"))).toBe(true);
    expect(isInteger(auditField(f, "SENSOR_BUDGET_OVERRIDE", "Observed value"))).toBe(true);
  }, 15000);
});

// ============================================================
// Group K — Manifest `command:` resolves on disk (4).
// (t92-sensor-fire.sh:842-868)
// ============================================================

function assertManifestCommandResolves(id: string): void {
  const manifest = join(REPO_ROOT, "dist", "claude", ".claude", "sensors", `aidlc-${id}.md`);
  const text = readFileSync(manifest, "utf-8");
  const cmdLine = text.split("\n").find((l) => l.startsWith("command:")) ?? "";
  const cmd = cmdLine.replace(/^command:\s*/, "");
  // Basename: last whitespace-delimited token ending in .ts. Manifest command
  // strings always use forward slashes (manifest text, not an OS path), so
  // split("/") is correct here — node:path.basename would not split on "/" on
  // Windows. Local var name avoids shadowing the imported basename().
  const tsTokens = cmd.split(/\s+/).filter((t) => t.endsWith(".ts"));
  const last = tsTokens[tsTokens.length - 1] ?? "";
  const parts = last.split("/");
  const tsBasename = parts[parts.length - 1];
  expect(tsBasename).not.toBe("");
  expect(existsSync(join(TOOLS_DIR, tsBasename))).toBe(true);
}

describe("t92 Group K: manifest command resolves next to dispatcher", () => {
  test("36: required-sections manifest command resolves", () => {
    assertManifestCommandResolves("required-sections");
  });
  test("37: upstream-coverage manifest command resolves", () => {
    assertManifestCommandResolves("upstream-coverage");
  });
  test("38: linter manifest command resolves", () => {
    assertManifestCommandResolves("linter");
  });
  test("39: type-check manifest command resolves", () => {
    assertManifestCommandResolves("type-check");
  });
});

// ============================================================
// Group L — Validation order (3): pre-lock failures NEVER emit
// SENSOR_FIRED. Each case uses a fresh projectDir.
// (t92-sensor-fire.sh:870-924)
// ============================================================

function assertNoFiredBeforeLock(args: string[]): void {
  const proj = makeProj();
  writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
  fire(args.map((a) => (a === "__OUT__" ? join(proj, "aidlc-docs", "test.md") : a)), {
    CLAUDE_PROJECT_DIR: proj,
  });
  const f = proj;
  if (!existsSync(f)) {
    expect(true).toBe(true);
    return;
  }
  expect(auditEventCount(f, "SENSOR_FIRED")).toBe(0);
}

describe("t92 Group L: validation order (no SENSOR_FIRED pre-lock)", () => {
  test("40: invalid stage slug exits before lock window A", () => {
    assertNoFiredBeforeLock([
      "required-sections",
      "--stage",
      "nonexistent-stage",
      "--output-path",
      "__OUT__",
    ]);
  });
  test("41: matches rejection exits before lock window A", () => {
    assertNoFiredBeforeLock(["linter", "--stage", "code-generation", "--output-path", "__OUT__"]);
  });
  test("42: unknown sensor id exits before lock window A", () => {
    assertNoFiredBeforeLock([
      "totally-unknown-sensor",
      "--stage",
      "intent-capture",
      "--output-path",
      "__OUT__",
    ]);
  });
});

// ============================================================
// Group M — upstream-coverage --consumes resolution (1).
// (t92-sensor-fire.sh:926-950)
// ============================================================

describe("t92 Group M: upstream-coverage --consumes resolution", () => {
  test("43: stage.consumes[].artifact resolved via loadGraph() and passed to script", () => {
    const proj = makeProj();
    writeFileSync(join(proj, "aidlc-docs", "test.md"), "stub\n", "utf-8");
    const sensors = makeForkSensors("upstream-coverage", "bun .claude/tools/aidlc-sensor-stub-argv.ts");
    const argvOut = join(proj, "argv.json");
    fire(["upstream-coverage", "--stage", "market-research", "--output-path", join(proj, "aidlc-docs", "test.md")], {
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_SENSORS_DIR: sensors,
      AIDLC_T92_ARGV_OUT: argvOut,
    });
    expect(existsSync(argvOut)).toBe(true);
    const argv = readFileSync(argvOut, "utf-8");
    expect(argv).toContain('"--stage"');
    expect(argv).toContain('"market-research"');
    expect(argv).toContain('"--consumes"');
    // Consume entries carry the producing stage (artifact:producer) so a
    // producing-directory citation can count as coverage.
    expect(argv).toContain('"intent-statement:intent-capture"');
    // The stage's deliverable union (produces minus `*-questions`/
    // `*-timestamp` scaffolding), threaded so coverage is evaluated over
    // sibling deliverables, not the single fired file.
    expect(argv).toContain('"--deliverables"');
    expect(argv).toContain('"competitive-analysis,market-trends,build-vs-buy"');
    expect(argv).toContain('"--output-path"');
  });
});

// ============================================================
// Group N — type-check status gate (1): tsc exited non-zero but
// parseTscOutput found ZERO diagnostics (a config-load failure), so the
// sensor must route to script-error: exit-2 rather than a false clean
// PASS. Regression guard for aidlc-sensor-type-check.ts's status gate
// (v0.5.16). Inputs are built inline (no committed fixture): a tsconfig
// whose `include` points at a non-existent file makes tsc exit 2 with a
// TS18003 "No inputs were found" line that carries NO (line,col)
// coordinate, so PRIMARY_RE matches nothing and allErrors is empty —
// the exact case the gate fires on. Uses the SHIPPED type-check manifest
// (AIDLC_SENSORS_DIR unset), exercising the real dispatcher end-to-end.
// ============================================================

describe("t92 Group N: type-check status gate (config-load failure)", () => {
  test("44: tsc non-zero + zero parseable diagnostics -> Note=script-error: exit-2 (not false PASS)", () => {
    const proj = makeProj();
    const sub = "config-error-type-check";
    mkdirSync(join(proj, sub), { recursive: true });
    // Valid TS — proves the gate fires on CONFIG failure, not a type error.
    writeFileSync(join(proj, sub, "sample.ts"), "export const v: number = 1;\n", "utf-8");
    // include a glob that matches nothing -> tsc exits 2 with TS18003 (no line:col).
    writeFileSync(
      join(proj, sub, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["no-such-file-xyz-*.ts"] }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(
      join(proj, sub, "package.json"),
      `${JSON.stringify({ name: "aidlc-t92-config-error", type: "module", private: true })}\n`,
      "utf-8",
    );
    fire(["type-check", "--stage", "code-generation", "--output-path", join(proj, sub, "sample.ts")], {
      CLAUDE_PROJECT_DIR: proj,
    });
    const f = proj;
    // Gate routes to PASSED Note=script-error: exit-2 — NOT a bare clean PASS, NOT FAILED.
    expect(auditEventCount(f, "SENSOR_PASSED")).toBe(1);
    expect(auditEventCount(f, "SENSOR_FAILED")).toBe(0);
    expect(auditField(f, "SENSOR_PASSED", "Note")).toBe("script-error: exit-2");
  }, 30000);
});

// ============================================================
// Group O — type-check status gate (2): the CROSS-FILE edge. tsc exits
// non-zero because a DIFFERENT file in the project has a genuine type
// error, but NONE of those diagnostics fall on --file-path. The sensor
// post-filters to the target (the documented cross-file known limitation
// in aidlc-sensor-type-check.ts), so the target must still get a per-file
// clean PASS (Note=""), NOT script-error. Regression guard: the status
// gate must key on allErrors (whole-project parse), never on the filtered
// `errors` — an earlier draft keyed on `errors` and wrongly turned every
// project-wide type error into a script-error for unrelated files. Inputs
// built inline; SHIPPED type-check manifest (AIDLC_SENSORS_DIR unset).
// ============================================================

describe("t92 Group O: type-check status gate (cross-file errors, none for target)", () => {
  test("45: tsc non-zero with diagnostics ELSEWHERE, none for target -> clean per-file PASS (Note='')", () => {
    const proj = makeProj();
    const sub = "cross-file-type-check";
    mkdirSync(join(proj, sub), { recursive: true });
    // Target file: valid TS — has NO diagnostics of its own.
    writeFileSync(join(proj, sub, "sample.ts"), "export const v: number = 1;\n", "utf-8");
    // A DIFFERENT file with a genuine type error -> tsc exits non-zero, but the
    // diagnostic's `file` is other.ts, which the sensor filters out for sample.ts.
    writeFileSync(join(proj, sub, "other.ts"), 'export const bad: number = "nope";\n', "utf-8");
    // include both files so tsc actually sees other.ts's error project-wide.
    writeFileSync(
      join(proj, sub, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true }, include: ["*.ts"] }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(
      join(proj, sub, "package.json"),
      `${JSON.stringify({ name: "aidlc-t92-cross-file", type: "module", private: true })}\n`,
      "utf-8",
    );
    fire(["type-check", "--stage", "code-generation", "--output-path", join(proj, sub, "sample.ts")], {
      CLAUDE_PROJECT_DIR: proj,
    });
    const f = proj;
    // Per-file clean PASS — NOT script-error (the bug), NOT FAILED (no target errors).
    expect(auditEventCount(f, "SENSOR_PASSED")).toBe(1);
    expect(auditEventCount(f, "SENSOR_FAILED")).toBe(0);
    expect(auditField(f, "SENSOR_PASSED", "Note")).toBe("");
  }, 30000);
});

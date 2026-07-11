// covers: subcommand:aidlc-utility:init, subcommand:aidlc-utility:status, subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:set-status, subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:resolve-env-scope
//
// CLI-contract port of tests/unit/t27-tool-utility.sh (TAP plan 81),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts <sub> ...` is preserved by SPAWNING
// the real CLI via node:child_process spawnSync (BUN + the tool .ts path),
// asserting on res.status / res.stdout / res.stderr exactly as the .sh
// asserted on $? / stdout / stderr, plus on the aidlc-state.md and audit.md
// the tool writes — the PROCESS boundary, not in-process handle* calls. An
// in-process twin would lose every exit-code half the .sh relies on (the
// tool's die() path is emitError -> process.exit(1); doctor's report ends in
// process.exit(failed > 0 ? 1 : 0)). It would also lose the resolve-env-scope
// "unset prints nothing, exits 0" arm and the doctor env-scope branches the
// .sh observes through stdout.
//
// SUBCOMMAND UNITS (the covers: header is the COLON form, credited verbatim):
//   init, status, scope-change, set-status, config-change, doctor, detect-scope,
//   resolve-env-scope. All eight are fired here. (enable-test-run was dropped per
//   #369 when the test-run mechanism was removed. help / version are exercised by
//   the .sh too but t27's covers: line (per the port spec) credits these eight;
//   help is still asserted below as the .sh did, so parity is preserved even
//   though help is not a separately-credited unit.)
//
// PARITY NOTES (every .sh `ok` line maps to expect()s below; several STRONGER):
//   - .sh T1-T4   help contains AI-DLC / --status / enterprise / all 8 scopes
//       -> Test 1-4: r.stdout substring + per-scope loop (same observable).
//   - .sh T5      status sans state "No active"                  -> Test 5.
//   - .sh T6-T8   status shows IDEATION / Feasibility / feature  -> Test 6-8.
//   - .sh T9      status md5 unchanged                            -> Test 9:
//       byte-for-byte readFileSync before/after equality (STRONGER than md5).
//   - .sh T10-T12 doctor mentions aidlc-statusline / audit-logger / settings
//       -> Test 10-12 (same observable; absorbs the non-zero exit like || true).
//   - .sh T13     doctor appends to audit.md (size grows)         -> Test 13:
//       byte-length grows (same) + HEALTH_CHECKED count === 1 (STRONGER).
//   - .sh T14     init creates state.md / audit.md / knowledge/   -> Test 14.
//   - .sh T15     init "Workspace scaffolded"                     -> Test 15.
//   - .sh init-rejection trio  rc==1 / "already exists" / "--force" -> Test R.
//   - .sh T16-T18 scope-change poc->mvp Scope/Stages/Depth        -> Test 16-18
//       (STRONGER: SCOPE_CHANGED New Scope field asserted exact in Test 16).
//   - .sh T19+T20 same-scope no-op (md5 unchanged) + "already"    -> Test 19/20
//       (STRONGER byte-equality).
//   - .sh T21     unknown scope "Unknown scope"                   -> Test 21
//       (STRONGER: rc==1 also pinned).
//   - .sh T22     SCOPE_CHANGED audit event                       -> Test 22:
//       event count === 1 against seeded baseline (STRONGER than presence).
//   - .sh T25-T28 set-status Lifecycle/Current/Agent/[-]          -> Test 25-28
//       (STRONGER: exact field values + JSON ack).
//   - .sh T29/T30 set-status unknown stage / no state            -> Test 29/30
//       (STRONGER: rc==1 also pinned).
//   - .sh T31     set-status cross-phase CONSTRUCTION             -> Test 31.
//   - .sh T32     set-status --agent override                    -> Test 32.
//   - .sh T33     init bootstrap workspace-scaffold checkbox      -> Test 33.
//   - .sh T34-T36 (enable-test-run field / idempotent / no state) were DROPPED
//       per #369 when the test-run mechanism was removed.
//   - .sh T37     help --depth                                    -> Test 37.
//   - .sh T38-T43 config-change depth: set / no-op / unknown / event / no-state
//       -> Test 38-43 (STRONGER byte-equality + event-count===1).
//   - .sh T44     scope-change --depth override                  -> Test 44.
//   - .sh T45     init --depth override                          -> Test 45.
//   - .sh T46/T47 help --test-strategy / workshop                -> Test 46/47.
//   - .sh T48-T54 config-change strategy: set / no-op / unknown / event /
//       no-state / init-override -> Test 48-54.
//   - .sh T55     both flags atomic: Depth + Strategy + exactly-one each event
//       -> Test 55 (4 expect()s: 2 fields + 2 event counts === 1).
//   - .sh T56     depth no-op emits only TEST_STRATEGY_CHANGED    -> Test 56:
//       "Depth is already Standard" + DEPTH_CHANGED count === 0 (STRONGER).
//   - .sh T57     invalid strategy validates before write        -> Test 57:
//       "Unknown test strategy" + byte-equality (validate-before-write).
//   - .sh T58     no flags "requires"                             -> Test 58
//       (STRONGER: rc==1 pinned).
//   - .sh T59-T61 doctor env-scope unset / valid / invalid        -> Test 59-61.
//   - .sh T62-T64 resolve-env-scope unset/valid/invalid (rc + out) -> Test 62-64.
//   - .sh T65     detect-scope SCOPE_DETECTED                     -> Test 65:
//       event count === 1 (STRONGER) + JSON ack emitted.
//   - .sh T66     detect-scope invalid scope rc==1               -> Test 66.
//   - .sh T67     status "Awaiting your approval" for [?]         -> Test 67.
//   - .sh T68     status "Revising" + "revision 1 of 3" for [R]   -> Test 68.
//   - .sh T69     init emits WORKFLOW_STARTED as first event      -> Test 69.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file
// + seed_audit_file + cleanup_test_project per case): each case uses a FRESH
// temp project dir (createTestProject, which toPortablePath-converts on Windows
// so the audit.md/state.md the tool writes via forward-slash helpers round-trip
// when read back). State-seeding cases copy state-mid-ideation.md; audit-seeding
// cases copy audit-sample.md (whose seed contains NONE of the events asserted
// here, so post-fire counts are unambiguous). All temp dirs cleaned in afterAll.
// NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seededAuditShard,
  sedReplaceInFile,
  seedAuditFile,
  seedStateFile,
  toPortablePath,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const STATE_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-utility.ts <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ...`. */
function util(args: string[], p?: string, env?: Record<string, string>): CliResult {
  const finalArgs = p ? [TOOL, ...args, "--project-dir", p] : [TOOL, ...args];
  const res = spawnSync(BUN, finalArgs, {
    encoding: "utf-8",
    // reset_aidlc_env: strip AWS_AIDLC_DEFAULT_SCOPE from the parent env so a
    // developer's shell default cannot shadow the tests (fixtures.sh:28-30).
    env: stripScope(env),
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Spawn the state tool (used by status [?]/[R] cases 67/68). */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE_TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: stripScope(),
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Build an env with AWS_AIDLC_DEFAULT_SCOPE removed, optionally layering overrides. */
function stripScope(overrides?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  delete base.AWS_AIDLC_DEFAULT_SCOPE;
  return { ...base, ...(overrides ?? {}) };
}

// P4: intent-birth writes state into the born intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<slug>-<id8>/), not the flat aidlc-docs/. Resolve
// the record dir from the active-space + active-intent cursors, falling back to
// the flat layout for a not-yet-born / seeded-flat project (the many state-seeding
// cases below never call init, so they stay flat).
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
// SPACE-level domain-knowledge dir (sibling of intents), resolved off the same
// active-space cursor recordDirOf uses.
function spaceKnowledgeOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  return join(p, "aidlc", "spaces", space, "knowledge");
}
const statePath = (p: string): string => join(recordDirOf(p), "aidlc-state.md");
// The DETERMINISTIC per-clone audit shard a spawned utility resolves (the fixture
// pins the clone-id). seedAuditFile() writes here too, so seed/append/check all
// agree on one file. Single-shard tests (size growth, one-event count) target it.
const auditPath = (p: string): string => seededAuditShard(p);
// Audit is written as per-clone shards under <record>/audit/<host>-<clone>.md.
// Concatenate every shard for a content read.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  return "";
}
/** Count `**Event**: <ev>` lines in audit CONTENT (shard-concat or flat). */
function auditEventCountIn(content: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return content.split("\n").filter((l) => re.test(l)).length;
}
/** Value of <key> from the FIRST audit block matching <ev> in CONTENT. */
function auditFieldIn(content: string, ev: string, key: string): string {
  let matched = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("## ") || line === "---") {
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
        if (label === key) return stripped.slice(pos + 4);
      }
    }
  }
  return "";
}

/** Fresh bare temp project (create_test_project). */
function bareProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

/**
 * Fresh project with the shipped .claude/ copied in (settings.json + all 10
 * hooks + tools). Doctor's hook-presence check derives its EXPECTED roster from
 * settings.json's wired hooks and probes them against .claude/hooks/, so a full
 * install is the fixture that exercises the all-present happy path. `mutate` can
 * delete/edit files inside the copied .claude/ to drive the missing-hook arm.
 */
function installedProj(mutate?: (claudeDir: string) => void): string {
  const p = bareProj();
  cpSync(AIDLC_SRC, join(p, ".claude"), { recursive: true });
  if (mutate) mutate(join(p, ".claude"));
  return p;
}

/** Fresh empty mktemp dir with NO aidlc-docs/ (mirrors the .sh's `mktemp -d`). */
function emptyDir(): string {
  const base = process.env.TMPDIR || tmpdir();
  const p = toPortablePath(mkdtempSync(join(base, "aidlc-test-")));
  tempDirs.push(p);
  return p;
}

/** Project seeded with state-mid-ideation.md (create_test_project + seed_state_file). */
function stateProj(): string {
  const p = bareProj();
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

/** Project seeded with state + audit (the common scope/config-change combo). */
function stateAuditProj(): string {
  const p = stateProj();
  seedAuditFile(p);
  return p;
}

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's `^**Event**: <ev>` grep, as exact count. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8").split("\n").filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators (mirrors t31's auditField).
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ") || line === "---") {
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
        if (label === key) return stripped.slice(pos + 4);
      }
    }
  }
  return "";
}

/** Read a `- **Field**: value` line from the state file (mirrors assert_grep 'Field.*value'). */
function stateField(p: string, field: string): string {
  const content = readFileSync(statePath(p), "utf-8");
  const m = content.match(new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

// ============================================================
// help (the .sh's T1-4, T37, T46-47 — not a separately-credited
// subcommand unit, but preserved for parity)
// ============================================================

describe("t27 aidlc-utility help (migrated from t27-tool-utility.sh, plan 81)", () => {
  test("1-4: help contains AI-DLC, --status, enterprise, all 8 scopes", () => {
    const r = util(["help"]);
    expect(r.stdout).toContain("AI-DLC");
    expect(r.stdout).toContain("--status");
    expect(r.stdout).toContain("enterprise");
    for (const scope of [
      "enterprise",
      "feature",
      "mvp",
      "poc",
      "bugfix",
      "refactor",
      "infra",
      "security-patch",
    ]) {
      expect(r.stdout).toContain(scope);
    }
  });

  test("37: help contains --depth", () => {
    expect(util(["help"]).stdout).toContain("--depth");
  });

  test("46-47: help contains --test-strategy and workshop scope", () => {
    const r = util(["help"]);
    expect(r.stdout).toContain("--test-strategy");
    expect(r.stdout).toContain("workshop");
  });
});

// ============================================================
// status (covers: subcommand:aidlc-utility:status)
// ============================================================

describe("t27 aidlc-utility status", () => {
  test("5: status without state shows no-active message", () => {
    const p = bareProj();
    const r = util(["status"], p);
    expect(r.stdout).toContain("No active");
  });

  test("6: status shows IDEATION phase", () => {
    const r = util(["status"], stateProj());
    expect(r.stdout).toContain("IDEATION");
  });

  test("7: status shows Feasibility stage", () => {
    const r = util(["status"], stateProj());
    expect(r.stdout).toContain("Feasibility");
  });

  test("8: status shows feature scope", () => {
    const r = util(["status"], stateProj());
    expect(r.stdout).toContain("feature");
  });

  test("9: status does not modify state file", () => {
    const p = stateProj();
    const before = readFileSync(statePath(p), "utf-8");
    util(["status"], p);
    const after = readFileSync(statePath(p), "utf-8");
    expect(after).toBe(before); // STRONGER than md5 — byte-for-byte
  });

  test("67: status shows Awaiting your approval for [?] stage", () => {
    const p = bareProj();
    util(["intent-birth", "--scope", "bugfix"], p);
    state(["advance", "workspace-scaffold"], p);
    state(["advance", "workspace-detection"], p);
    state(["advance", "state-init"], p);
    const current = state(["get", "Current Stage"], p).stdout.trim();
    state(["gate-start", current], p);
    const r = util(["status"], p);
    expect(r.stdout).toContain("Awaiting your approval");
  }, 30000);

  test("68: status shows Revising and revision count for [R] stage", () => {
    const p = bareProj();
    util(["intent-birth", "--scope", "bugfix"], p);
    state(["advance", "workspace-scaffold"], p);
    state(["advance", "workspace-detection"], p);
    state(["advance", "state-init"], p);
    const current = state(["get", "Current Stage"], p).stdout.trim();
    state(["gate-start", current], p);
    state(["reject", current, "--feedback", "try again"], p);
    const r = util(["status"], p);
    expect(r.stdout).toContain("Revising");
    expect(r.stdout).toContain("revision 1 of 3");
  }, 30000);
});

// ============================================================
// doctor (covers: subcommand:aidlc-utility:doctor)
// ============================================================

describe("t27 aidlc-utility doctor", () => {
  test("10-12: doctor mentions aidlc-statusline, audit-logger, settings", () => {
    // Hook rows now derive from settings.json's wired hooks (the contract), so
    // the project needs a real .claude/ for those labels to render.
    const p = installedProj();
    const r = util(["doctor"], p);
    expect(r.stdout).toContain("aidlc-statusline");
    expect(r.stdout).toContain("audit-logger");
    expect(r.stdout).toContain("settings");
  });

  // INITIALIZED-project contract: when audit.md already exists, doctor appends
  // HEALTH_CHECKED to it (size grows, exactly one row). This is the
  // audit.md-exists arm of the cold-safe gate (#4) — seeding audit.md FIRST is
  // what makes the emit fire.
  test("13: doctor appends to the audit shard when it exists (size grows, exactly one HEALTH_CHECKED)", () => {
    // Seed state + audit so the intent record RESOLVES (the active-intent cursor
    // only binds a record that has aidlc-state.md) — an initialized project, the
    // audit-exists arm of the cold-safe gate.
    const p = stateAuditProj();
    const before = statSync(auditPath(p)).size;
    util(["doctor"], p);
    const after = statSync(auditPath(p)).size;
    expect(after).toBeGreaterThan(before);
    // STRONGER: the .sh only checked growth; pin the canonical event count.
    expect(auditEventCount(auditPath(p), "HEALTH_CHECKED")).toBe(1);
  });

  // COLD-SAFE contract (#4): on a project with NO audit.md, --doctor is
  // read-only — it prints the health report (exit code aside) but creates
  // neither aidlc-docs/audit.md nor any audit side effect. bareProj() makes
  // aidlc-docs/ but NOT audit.md, so this is the pristine arm. The README
  // onboarding runs --doctor before --init, so doctor must scaffold nothing.
  test("13b: doctor on a project without audit.md creates nothing (cold-safe / read-only)", () => {
    const p = bareProj();
    expect(existsSync(auditPath(p))).toBe(false); // precondition: no audit yet
    const r = util(["doctor"], p);
    // The health report still printed (the diagnostic is always emitted).
    expect(r.stdout).toContain("AI-DLC Health Check");
    // The cold-safe invariant: doctor created no audit.md as a side effect.
    expect(existsSync(auditPath(p))).toBe(false);
  });

  // FINDING #3: doctor's expected hook roster is the set of hooks settings.json
  // wires (its hooks event blocks + the statusLine command), so all 10 framework
  // hooks are checked — including the three the old hardcoded 7-element list
  // silently skipped (runtime-compile, sensor-fire, and the flow-altering stop
  // hook). Each prints a "<hook>.ts present" line. A full install wires all 10.
  test("12b: doctor checks all 10 settings.json-wired hooks, including the 3 the old list skipped", () => {
    const p = installedProj();
    const r = util(["doctor"], p);
    for (const hook of [
      "aidlc-audit-logger",
      "aidlc-sync-statusline",
      "aidlc-validate-state",
      "aidlc-log-subagent",
      "aidlc-session-start",
      "aidlc-session-end",
      "aidlc-statusline",
      "aidlc-runtime-compile", // previously missing
      "aidlc-sensor-fire", // previously missing
      "aidlc-stop", // previously missing (the flow-altering Stop hook)
    ]) {
      // A wired-and-present hook renders a passing "✓  <hook>.ts present" row.
      expect(r.stdout).toContain(`${hook}.ts present`);
    }
  });

  // FINDING #1 (review): the hook check must FLAG a wired-but-missing hook, not
  // silently drop it. The expected roster comes from settings.json (the
  // contract) while presence is probed against .claude/hooks/, so the two
  // genuinely diverge: deleting aidlc-stop.ts from a project whose settings.json
  // still wires it produces a loud "✗  aidlc-stop.ts present" failure row. (The
  // pre-redesign derive-from-the-hooks-dir approach could not catch this — a
  // missing hook simply wasn't enumerated, so it was never reported.)
  test("12c: doctor flags a settings.json-wired hook that is missing on disk", () => {
    const p = installedProj((claudeDir) => {
      rmSync(join(claudeDir, "hooks", "aidlc-stop.ts"));
    });
    const r = util(["doctor"], p);
    // The missing hook is named with the ✗ failure marker, not silently absent.
    expect(r.stdout).toContain("✗  aidlc-stop.ts present");
    // And doctor exits non-zero (a failed check), so CI/scripts see the breakage.
    expect(r.status).not.toBe(0);
    // Sibling hooks that ARE present still pass — only the deleted one fails.
    expect(r.stdout).toContain("✓  aidlc-audit-logger.ts present");
  });

  // FINDING #1 corollary: when settings.json is absent the hook CONTRACT cannot
  // be verified, so doctor says so loudly rather than silently checking zero
  // hooks (the old empty-roster catch failed silent). bareProj() has no
  // .claude/settings.json.
  test("12d: doctor reports the hook contract unverifiable when settings.json is absent", () => {
    const p = bareProj();
    const r = util(["doctor"], p);
    expect(r.stdout).toContain("Hook contract: settings.json unreadable");
    expect(r.status).not.toBe(0);
  });

  test("59: doctor reports AWS_AIDLC_DEFAULT_SCOPE unset", () => {
    const p = bareProj();
    const r = util(["doctor"], p); // env stripped of the var by util()
    expect(r.stdout).toContain("AWS_AIDLC_DEFAULT_SCOPE (unset");
  });

  test("60: doctor reports AWS_AIDLC_DEFAULT_SCOPE=workshop as valid", () => {
    const p = bareProj();
    const r = util(["doctor"], p, { AWS_AIDLC_DEFAULT_SCOPE: "workshop" });
    expect(r.stdout).toContain("AWS_AIDLC_DEFAULT_SCOPE=workshop (valid)");
  });

  test("61: doctor reports AWS_AIDLC_DEFAULT_SCOPE=bogus as invalid", () => {
    const p = bareProj();
    const r = util(["doctor"], p, { AWS_AIDLC_DEFAULT_SCOPE: "bogus" });
    expect(r.stdout).toContain("AWS_AIDLC_DEFAULT_SCOPE=bogus (invalid)");
  });
});

// ============================================================
// init (covers: subcommand:aidlc-utility:init)
// ============================================================

describe("t27 aidlc-utility init", () => {
  test("14: init creates aidlc-state.md, audit shard dir, and knowledge/ directory", () => {
    const p = emptyDir();
    util(["intent-birth", "--scope", "poc"], p);
    // P4: birth writes a per-intent record (state + audit shards), not the flat
    // aidlc-docs/ trio. (Domain knowledge is SPACE-level, asserted below.)
    expect(existsSync(statePath(p))).toBe(true);
    // Audit is now a SHARD DIR (<record>/audit/<host>-<pid>.md), not a single file.
    const auditDir = join(recordDirOf(p), "audit");
    expect(existsSync(auditDir)).toBe(true);
    expect(readdirSync(auditDir).filter((f) => f.endsWith(".md")).length).toBeGreaterThanOrEqual(1);
    // knowledge/ is SPACE-level (ensureWorkspaceDirs creates
    // aidlc/spaces/<space>/knowledge/ — a sibling of intents, not per-record).
    expect(existsSync(spaceKnowledgeOf(p))).toBe(true);
  });

  test("15: init output contains birth + state-init summary", () => {
    const p = emptyDir();
    const r = util(["intent-birth", "--scope", "poc"], p);
    // P4: init is a back-compat alias for intent-birth; the stdout now reports the
    // born intent + state init, not the old "Workspace scaffolded" scaffold line.
    expect(r.stdout).toContain("Intent born:");
    expect(r.stdout).toContain("State initialized:");
  });

  // P4 retires the --init re-init guard: init/intent-birth births a per-intent
  // record, so a SECOND init is not an error — it simply births a second intent
  // in the workspace. There is no "already exists" / --force path anymore.
  test("second init births a second intent (no re-init guard): exit 0, no 'already exists'", () => {
    const p = emptyDir();
    const first = util(["intent-birth", "--scope", "poc"], p);
    expect(first.status).toBe(0);
    const second = util(["intent-birth", "--scope", "poc"], p);
    expect(second.status).toBe(0);
    expect(second.out).not.toContain("already exists");
    expect(second.out).not.toContain("--force");
    // Two intent record dirs now exist under the default space.
    const intentsDir = join(p, "aidlc", "spaces", "default", "intents");
    const records = readdirSync(intentsDir).filter((d) =>
      existsSync(join(intentsDir, d, "aidlc-state.md")),
    );
    expect(records.length).toBe(2);
  });

  test("33: init bootstrap has workspace-scaffold checkbox", () => {
    const p = emptyDir();
    util(["intent-birth", "--scope", "poc"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("workspace-scaffold");
  });

  test("45: init with --depth overrides bugfix default (Standard)", () => {
    const p = emptyDir();
    util(["intent-birth", "--scope", "bugfix", "--depth", "standard"], p);
    expect(stateField(p, "Depth")).toBe("Standard");
  });

  test("54: init with --test-strategy overrides default (Minimal)", () => {
    const p = emptyDir();
    util(["intent-birth", "--scope", "feature", "--test-strategy", "minimal"], p);
    expect(stateField(p, "Test Strategy")).toBe("Minimal");
  });

  test("69: init emits WORKFLOW_STARTED as the first audit event", () => {
    const p = bareProj();
    util(["intent-birth", "--scope", "bugfix"], p);
    // P4: audit is sharded under the born record's audit/ dir; read via readAudit.
    // First **Event**: line after the `# AI-DLC Audit Log` header.
    const firstEvent = readAudit(p)
      .split("\n")
      .find((l) => l.startsWith("**Event**: "))
      ?.replace("**Event**: ", "");
    expect(firstEvent).toBe("WORKFLOW_STARTED");
  });
});

// ============================================================
// scope-change (covers: subcommand:aidlc-utility:scope-change)
// ============================================================

describe("t27 aidlc-utility scope-change", () => {
  /** Seed state, flip Scope to poc (the .sh's sed_i), seed audit. */
  function pocStateAuditProj(minimalDepth = false): string {
    const p = stateAuditProj();
    sedReplaceInFile(statePath(p), "**Scope**: feature", "**Scope**: poc");
    if (minimalDepth) {
      sedReplaceInFile(statePath(p), "**Depth**: Standard", "**Depth**: Minimal");
    }
    return p;
  }

  test("16: scope-change poc->mvp updates Scope field to mvp", () => {
    const p = pocStateAuditProj();
    util(["scope-change", "--scope", "mvp"], p);
    expect(stateField(p, "Scope")).toBe("mvp");
    // STRONGER: the SCOPE_CHANGED audit row records New Scope = mvp.
    expect(auditField(auditPath(p), "SCOPE_CHANGED", "New Scope")).toBe("mvp");
  });

  test("17: scope-change poc->mvp updates Stages to Execute", () => {
    const p = pocStateAuditProj();
    util(["scope-change", "--scope", "mvp"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("Stages to Execute");
  });

  test("18: scope-change poc->mvp updates Depth to Standard for mvp", () => {
    const p = pocStateAuditProj(true);
    util(["scope-change", "--scope", "mvp"], p);
    expect(stateField(p, "Depth")).toBe("Standard");
  });

  test("19: scope-change same scope does not modify state", () => {
    const p = stateAuditProj(); // still feature scope
    const before = readFileSync(statePath(p), "utf-8");
    util(["scope-change", "--scope", "feature"], p);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before); // byte-equality
  });

  test("20: scope-change same scope prints already message", () => {
    const p = stateAuditProj();
    const r = util(["scope-change", "--scope", "feature"], p);
    expect(r.stdout).toContain("already");
  });

  test("21: scope-change unknown scope prints error (exit 1)", () => {
    const p = stateAuditProj();
    const r = util(["scope-change", "--scope", "nonexistent"], p);
    expect(r.out).toContain("Unknown scope");
    expect(r.status).toBe(1); // STRONGER: the .sh only grepped the message
  });

  test("22: scope-change appends exactly one SCOPE_CHANGED audit event", () => {
    const p = stateAuditProj();
    util(["scope-change", "--scope", "poc"], p);
    expect(auditEventCount(auditPath(p), "SCOPE_CHANGED")).toBe(1);
  });

  test("44: scope-change with --depth overrides default (Comprehensive)", () => {
    const p = pocStateAuditProj(true);
    util(["scope-change", "--scope", "mvp", "--depth", "comprehensive"], p);
    expect(stateField(p, "Depth")).toBe("Comprehensive");
  });
});

// ============================================================
// set-status (covers: subcommand:aidlc-utility:set-status)
// ============================================================

describe("t27 aidlc-utility set-status", () => {
  test("25: set-status updates Lifecycle Phase to IDEATION", () => {
    const p = stateProj();
    util(["set-status", "--stage", "feasibility"], p);
    expect(stateField(p, "Lifecycle Phase")).toBe("IDEATION");
  });

  test("26: set-status updates Current Stage to feasibility", () => {
    const p = stateProj();
    util(["set-status", "--stage", "feasibility"], p);
    expect(stateField(p, "Current Stage")).toBe("feasibility");
  });

  test("27: set-status derives Active Agent from graph (aidlc-architect-agent)", () => {
    const p = stateProj();
    util(["set-status", "--stage", "feasibility"], p);
    expect(stateField(p, "Active Agent")).toBe("aidlc-architect-agent");
  });

  test("28: set-status marks checkbox [-]", () => {
    const p = stateProj();
    // Reset feasibility to [ ] first so we verify [-] gets set (the .sh's sed_i).
    sedReplaceInFile(statePath(p), "[-] feasibility", "[ ] feasibility");
    util(["set-status", "--stage", "feasibility"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("[-] feasibility");
  });

  test("29: set-status errors on unknown stage (exit 1)", () => {
    const p = stateProj();
    const r = util(["set-status", "--stage", "nonexistent"], p);
    expect(r.out).toContain("Unknown stage");
    expect(r.status).toBe(1); // STRONGER
  });

  test("30: set-status errors without state file (exit 1)", () => {
    const p = bareProj(); // no state.md seeded
    const r = util(["set-status", "--stage", "feasibility"], p);
    expect(r.out).toContain("No state file");
    expect(r.status).toBe(1); // STRONGER
  });

  test("31: set-status cross-phase sets CONSTRUCTION for code-generation", () => {
    const p = stateProj();
    util(["set-status", "--stage", "code-generation"], p);
    expect(stateField(p, "Lifecycle Phase")).toBe("CONSTRUCTION");
  });

  test("32: set-status explicit --agent overrides graph default", () => {
    const p = stateProj();
    util(["set-status", "--stage", "feasibility", "--agent", "custom-agent"], p);
    expect(stateField(p, "Active Agent")).toBe("custom-agent");
  });
});

// ============================================================
// config-change (covers: subcommand:aidlc-utility:config-change)
// ============================================================

describe("t27 aidlc-utility config-change", () => {
  test("38: config-change updates Depth to Minimal", () => {
    const p = stateAuditProj();
    util(["config-change", "--depth", "minimal"], p);
    expect(stateField(p, "Depth")).toBe("Minimal");
  });

  test("39: config-change same depth does not modify state", () => {
    const p = stateAuditProj(); // fixture Depth: Standard
    const before = readFileSync(statePath(p), "utf-8");
    util(["config-change", "--depth", "standard"], p);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before); // byte-equality
  });

  test("40: config-change same depth prints already message", () => {
    const p = stateAuditProj();
    const r = util(["config-change", "--depth", "standard"], p);
    expect(r.stdout).toContain("already");
  });

  test("41: config-change unknown depth prints error (exit 1)", () => {
    const p = stateAuditProj();
    const r = util(["config-change", "--depth", "extreme"], p);
    expect(r.out).toContain("Unknown depth");
    expect(r.status).toBe(1); // STRONGER
  });

  test("42: config-change appends DEPTH_CHANGED audit event", () => {
    const p = stateAuditProj();
    util(["config-change", "--depth", "minimal"], p);
    expect(auditEventCount(auditPath(p), "DEPTH_CHANGED")).toBe(1);
  });

  test("43: config-change errors without state file", () => {
    const p = bareProj();
    const r = util(["config-change", "--depth", "minimal"], p);
    expect(r.out).toContain("No state file");
    expect(r.status).toBe(1); // STRONGER
  });

  test("48: config-change updates Test Strategy to Minimal", () => {
    const p = stateAuditProj();
    util(["config-change", "--test-strategy", "minimal"], p);
    expect(stateField(p, "Test Strategy")).toBe("Minimal");
  });

  test("49: config-change same strategy does not modify state", () => {
    const p = stateAuditProj();
    // First set it to Standard explicitly (mirrors the .sh setup).
    util(["config-change", "--test-strategy", "standard"], p);
    const before = readFileSync(statePath(p), "utf-8");
    util(["config-change", "--test-strategy", "standard"], p);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before); // byte-equality
  });

  test("50: config-change same strategy prints already message", () => {
    const p = stateAuditProj();
    util(["config-change", "--test-strategy", "standard"], p);
    const r = util(["config-change", "--test-strategy", "standard"], p);
    expect(r.stdout).toContain("already");
  });

  test("51: config-change unknown strategy prints error (exit 1)", () => {
    const p = stateAuditProj();
    const r = util(["config-change", "--test-strategy", "extreme"], p);
    expect(r.out).toContain("Unknown test strategy");
    expect(r.status).toBe(1); // STRONGER
  });

  test("52: config-change appends TEST_STRATEGY_CHANGED audit event", () => {
    const p = stateAuditProj();
    util(["config-change", "--test-strategy", "minimal"], p);
    expect(auditEventCount(auditPath(p), "TEST_STRATEGY_CHANGED")).toBe(1);
  });

  test("53: config-change without state file errors (test-strategy)", () => {
    const p = bareProj();
    const r = util(["config-change", "--test-strategy", "minimal"], p);
    expect(r.out).toContain("No state file");
    expect(r.status).toBe(1); // STRONGER
  });

  test("55: config-change with both flags updates both fields + exactly one event each", () => {
    const p = stateAuditProj();
    util(["config-change", "--depth", "minimal", "--test-strategy", "minimal"], p);
    expect(stateField(p, "Depth")).toBe("Minimal");
    expect(stateField(p, "Test Strategy")).toBe("Minimal");
    expect(auditEventCount(auditPath(p), "DEPTH_CHANGED")).toBe(1);
    expect(auditEventCount(auditPath(p), "TEST_STRATEGY_CHANGED")).toBe(1);
  });

  test("56: config-change depth no-op emits only TEST_STRATEGY_CHANGED", () => {
    const p = stateAuditProj(); // fixture Depth: Standard -> --depth standard is a no-op
    const r = util(["config-change", "--depth", "standard", "--test-strategy", "minimal"], p);
    expect(r.stdout).toContain("Depth is already Standard");
    expect(auditEventCount(auditPath(p), "DEPTH_CHANGED")).toBe(0);
    // STRONGER: confirm the strategy half still fired.
    expect(auditEventCount(auditPath(p), "TEST_STRATEGY_CHANGED")).toBe(1);
  });

  test("57: config-change validates both flags before any state write", () => {
    const p = stateAuditProj();
    const before = readFileSync(statePath(p), "utf-8");
    const r = util(["config-change", "--depth", "minimal", "--test-strategy", "extreme"], p);
    expect(r.out).toContain("Unknown test strategy");
    expect(readFileSync(statePath(p), "utf-8")).toBe(before); // no partial write
    expect(r.status).toBe(1); // STRONGER
  });

  test("58: config-change with no flags prints usage error (exit 1)", () => {
    const p = stateProj();
    const r = util(["config-change"], p);
    expect(r.out).toContain("requires");
    expect(r.status).toBe(1); // STRONGER
  });
});

// ============================================================
// detect-scope (covers: subcommand:aidlc-utility:detect-scope)
// ============================================================

describe("t27 aidlc-utility detect-scope", () => {
  test("65: detect-scope emits exactly one SCOPE_DETECTED + JSON ack", () => {
    const p = bareProj();
    util(["intent-birth", "--scope", "bugfix"], p);
    const r = util(
      ["detect-scope", "--scope", "feature", "--input", "build a todo app", "--source", "freeform"],
      p,
    );
    // P4: after init births the per-intent record, detect-scope's audit lands in
    // the born record's shard dir — read via readAudit (which also falls back to
    // flat audit.md for a not-yet-born project).
    const audit = readAudit(p);
    expect(auditEventCountIn(audit, "SCOPE_DETECTED")).toBe(1);
    // STRONGER: the .sh only grepped the event; assert the JSON ack + field.
    expect(r.stdout).toContain('"emitted":"SCOPE_DETECTED"');
    expect(auditFieldIn(audit, "SCOPE_DETECTED", "Detected scope")).toBe("feature");
  }, 30000);

  test("66: detect-scope rejects invalid scope (exit 1)", () => {
    const p = bareProj();
    util(["intent-birth", "--scope", "bugfix"], p);
    const r = util(["detect-scope", "--scope", "bogus", "--input", "x"], p);
    expect(r.status).toBe(1);
  }, 30000);
});

// ============================================================
// resolve-env-scope (covers: subcommand:aidlc-utility:resolve-env-scope)
// ============================================================

describe("t27 aidlc-utility resolve-env-scope", () => {
  test("62: resolve-env-scope with unset env prints nothing and exits 0", () => {
    const r = util(["resolve-env-scope"]); // util() strips AWS_AIDLC_DEFAULT_SCOPE
    expect(r.status).toBe(0);
    // .sh asserted $OUT (combined 2>&1) is empty.
    expect(r.out).toBe("");
  });

  test("63: resolve-env-scope with valid env prints scope= line and exits 0", () => {
    const r = util(["resolve-env-scope"], undefined, { AWS_AIDLC_DEFAULT_SCOPE: "workshop" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("scope=workshop");
  });

  test("64: resolve-env-scope with invalid env exits 1 with canonical error", () => {
    const r = util(["resolve-env-scope"], undefined, { AWS_AIDLC_DEFAULT_SCOPE: "bogus" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
  });
});

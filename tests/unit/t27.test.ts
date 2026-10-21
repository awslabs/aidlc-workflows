// covers: subcommand:aidlc-utility:init, subcommand:aidlc-utility:status, subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:set-status, subcommand:aidlc-utility:config-change, subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:detect-scope, subcommand:aidlc-utility:resolve-env-scope
//
// CLI-contract test, mechanism = cli. Every assertion SPAWNS the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on
// res.status / res.stdout / res.stderr, plus on the aidlc-state.md and audit
// shards the tool writes - the PROCESS boundary, not in-process handle* calls.
// An in-process twin would lose every exit-code check (the tool's die() path is
// emitError, which never returns and exits 1; doctor exits non-zero when a
// check failed). It would also lose the resolve-env-scope "unset prints
// nothing, exits 0" arm and the doctor env-scope branches observed through
// stdout.
//
// SUBCOMMAND UNITS (the covers: header is the COLON form, credited verbatim):
//   init, status, scope-change, set-status, config-change, doctor, detect-scope,
//   resolve-env-scope. All eight are fired here.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so the
// audit.md/state.md the tool writes via forward-slash helpers round-trip when
// read back). State-seeding cases copy state-mid-ideation.md; audit-seeding
// cases copy audit-sample.md (whose seed contains NONE of the events asserted
// here, so post-fire counts are unambiguous). All temp dirs cleaned in afterAll.
// NOTHING is written under tests/fixtures/**.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const STATE_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");
const LOG_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-log.ts");
const ORCH_TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stdout: string;
}

function util(args: string[], p?: string, env?: Record<string, string>): CliResult {
  const finalArgs = p ? [TOOL, ...args, "--project-dir", p] : [TOOL, ...args];
  const childEnv = stripScope(env);
  if (args[0] === "set-status") {
    childEnv.AIDLC_STATUSLINE_OWNER = `statusline:${process.pid}`;
  }
  const res = spawnSync(BUN, finalArgs, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    // stripScope: strip AWS_AIDLC_DEFAULT_SCOPE from the parent env so a
    // developer's shell default cannot shadow the tests.
    env: childEnv,
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Spawn the state tool (used by status [?]/[R] cases 67/68). */
function state(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [STATE_TOOL, ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: {
      ...stripScope(),
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

function stripScope(overrides?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  delete base.AWS_AIDLC_DEFAULT_SCOPE;
  return { ...base, ...(overrides ?? {}) };
}

// intent-create writes state into the created intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<date>-<slug>/), not the flat aidlc-docs/. Resolve
// the record dir from the active-space + active-intent cursors, falling back to
// the flat layout when no cursor names a record with a state file.
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
function spaceCodekbOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  return join(p, "aidlc", "spaces", space, "codekb");
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

function bareProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

/**
 * Fresh project with the shipped .claude/ copied in (settings.json + all
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

/** The person turned AI-DLC's status line on: it lives in their own settings.local.json (#1407). */
function withStatusLineOn(claudeDir: string): void {
  const shipped = JSON.parse(readFileSync(join(claudeDir, "tools", "data", "harness.json"), "utf-8")) as {
    statusLine?: unknown;
  };
  writeFileSync(join(claudeDir, "settings.local.json"), `${JSON.stringify({ statusLine: shipped.statusLine }, null, 2)}\n`);
}

function emptyDir(): string {
  const base = process.env.TMPDIR || tmpdir();
  const p = toPortablePath(mkdtempSync(join(base, "aidlc-test-")));
  tempDirs.push(p);
  return p;
}

function stateProj(): string {
  const p = bareProj();
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

function stateAuditProj(): string {
  const p = stateProj();
  seedAuditFile(p);
  return p;
}

/** Count audit blocks with `**Event**: <ev>`. */
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

/** Read a `- **Field**: value` line from the state file. */
function stateField(p: string, field: string): string {
  const content = readFileSync(statePath(p), "utf-8");
  const m = content.match(new RegExp(`^- \\*\\*${field}\\*\\*:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

// ============================================================
// help (not a separately-credited subcommand unit)
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
      "classic",
      "workshop",
      "express",
    ]) {
      expect(r.stdout).toContain(scope);
    }
  });

  test("37: help contains --depth", () => {
    expect(util(["help"]).stdout).toContain("--depth");
  });

  test("46-47: help contains --test-strategy and classic scope", () => {
    const r = util(["help"]);
    expect(r.stdout).toContain("--test-strategy");
    expect(r.stdout).toContain("classic");
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

  // A teammate's clone: the records are here, the per-user cursor is not.
  // Status names each piece of work and where it stands, never "no workflow".
  function cloneWithRecords(withArchived = false): string {
    const p = bareProj();
    const intents = join(p, "aidlc", "spaces", "default", "intents");
    const finished = readdirSync(intents).find((name) => name.startsWith("fixture-"))!;
    seedStateFile(p, "state-completed.md");
    const other = "261016-other-work";
    mkdirSync(join(intents, other), { recursive: true });
    cpSync(STATE_FIXTURE, join(intents, other, "aidlc-state.md"));
    const registry = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8"));
    registry.push({ uuid: "00000000-0000-7000-8000-000000000002", slug: "other-work", dirName: other, status: "in-flight" });
    if (withArchived) {
      const old = "261001-old-work";
      mkdirSync(join(intents, old), { recursive: true });
      cpSync(STATE_FIXTURE, join(intents, old, "aidlc-state.md"));
      registry.push({ uuid: "00000000-0000-7000-8000-000000000003", slug: "old-work", dirName: old, status: "archived" });
    }
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify(registry, null, 2)}\n`);
    rmSync(join(intents, "active-intent"), { force: true });
    expect(finished).toBeDefined();
    return p;
  }

  test("5b: status with work here and none selected names each piece and where it stands", () => {
    const r = util(["status"], cloneWithRecords());
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("No active");
    expect(r.stdout).toContain("No work is selected in this conversation. Work in this project:");
    expect(r.stdout).toMatch(/ {2}fixture \(record fixture-[0-9a-f]+\): finished\n/);
    expect(r.stdout).toContain("  other-work (record 261016-other-work): at Feasibility");
    expect(r.stdout).toContain("To carry on with one, or go back to one of its stages: /aidlc intent <record>");
    expect(r.stdout).toContain('To start new work: /aidlc "build the auth service"');
  });

  test("5c: archived work is counted, not listed", () => {
    const r = util(["status"], cloneWithRecords(true));
    expect(r.stdout).toContain("other-work");
    expect(r.stdout).not.toContain("old-work");
    expect(r.stdout).toContain("(1 archived; /aidlc intent list --all shows it)");
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
    expect(after).toBe(before);
  });

  test("67: status shows Awaiting your approval for [?] stage", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    state(["advance", "workspace-scaffold"], p);
    state(["advance", "workspace-detection"], p);
    state(["advance", "state-init"], p);
    const current = state(["get", "Current Stage"], p).stdout.trim();
    const reviewer = "aidlc-product-lead-agent";
    const iteration = 1;
    const dir = join(recordDirOf(p), "inception", current);
    const artifact = join(dir, "requirements.md");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(artifact)) writeFileSync(artifact, "# Requirements\n");
    const reviewArgs = [
      LOG_TOOL,
      "review",
      "--stage",
      current,
      "--reviewer",
      reviewer,
      "--iteration",
      String(iteration),
      "--project-dir",
      p,
    ];
    const request = spawnSync(BUN, reviewArgs, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
    if ((request.status ?? -1) !== 0) {
      throw new Error(`review request failed: ${request.stdout}${request.stderr}`);
    }
    appendFileSync(
      artifact,
      "\n## Review\n\n" +
        "**Verdict:** READY\n" +
        `**Reviewer:** ${reviewer}\n` +
        `**Iteration:** ${iteration}\n\n` +
        "### Findings\n\nNo blocking findings.\n",
      "utf-8",
    );
    const verdict = spawnSync(BUN, [...reviewArgs, "--verdict", "READY"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    if ((verdict.status ?? -1) !== 0) {
      throw new Error(`review verdict failed: ${verdict.stdout}${verdict.stderr}`);
    }
    state(["gate-start", current], p);
    const r = util(["status"], p);
    expect(r.stdout).toContain("Awaiting your approval");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("67b: status uses ASCII text for approved and skipped work", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    state(["advance", "workspace-scaffold"], p);
    state(["advance", "workspace-detection"], p);
    state(["advance", "state-init"], p);
    const current = state(["get", "Current Stage"], p).stdout.trim();
    state(["checkbox", `${current}=completed`], p);
    state(["checkbox", "code-generation=skipped"], p);
    const r = util(["status"], p);
    expect(r.stdout).toContain("approved - ready to advance");
    expect(r.stdout).toContain(", skipped: Code Generation");
    expect(r.stdout).not.toContain("\u2014");
    expect(r.stdout).not.toContain("\u2192");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("68: status shows Revising and revision count for [R] stage", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    state(["advance", "workspace-scaffold"], p);
    state(["advance", "workspace-detection"], p);
    state(["advance", "state-init"], p);
    const current = state(["get", "Current Stage"], p).stdout.trim();
    state(["gate-start", current], p);
    state(["reject", current, "--feedback", "try again"], p);
    const r = util(["status"], p);
    expect(r.stdout).toContain("Revising");
    expect(r.stdout).toContain("revision 1 of 3");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// ============================================================
// doctor (covers: subcommand:aidlc-utility:doctor)
// ============================================================

describe("t27 aidlc-utility doctor", () => {
  test("10-12: doctor mentions aidlc-statusline, write-audit-log, settings", () => {
    // Hook rows derive from settings.json's wired hooks (the contract), so
    // the project needs a real .claude/ for those labels to render. AI-DLC's
    // status line is wired only once the person turns it on, in their own
    // settings.local.json (#1407), and doctor checks it from there.
    const p = installedProj(withStatusLineOn);
    const r = util(["doctor", "--verbose"], p);
    expect(r.stdout).toContain("aidlc-statusline");
    expect(r.stdout).toContain("write-audit-log");
    expect(r.stdout).toContain("settings");
  });

  // INITIALIZED-project contract: when the audit shard already exists, doctor
  // appends HEALTH_CHECKED to it (size grows, exactly one row). This is the
  // audit-exists arm of the cold-safe gate (#4) - seeding the shard FIRST is
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
    expect(auditEventCount(auditPath(p), "HEALTH_CHECKED")).toBe(1);
  });

  // COLD-SAFE contract (#4): on a project with NO audit shard, --doctor is
  // read-only - it prints the health report (exit code aside) but creates no
  // audit side effect. bareProj() makes the workspace shell but NOT an audit
  // shard, so this is the pristine arm. The README onboarding runs doctor
  // before any intent is created, so doctor must scaffold nothing.
  test("13b: doctor on a project without audit.md creates nothing (cold-safe / read-only)", () => {
    const p = bareProj();
    expect(existsSync(auditPath(p))).toBe(false);
    const r = util(["doctor"], p);
    expect(r.stdout).toContain("AI-DLC doctor");
    expect(existsSync(auditPath(p))).toBe(false);
  });

  // Doctor's expected hook roster is the set of hooks settings.json wires (its
  // hooks event blocks + the statusLine command). Each prints a "<hook>.ts
  // present" line.
  test("12b: doctor checks all 10 settings.json-wired hooks, including the 3 the old list skipped", () => {
    // The statusline is the person's choice (#1407): wired by their own
    // settings.local.json once they turn it on, and checked from there.
    const p = installedProj(withStatusLineOn);
    const r = util(["doctor", "--verbose"], p);
    for (const hook of [
      "aidlc-write-audit-log",
      "aidlc-sync-workflow-state",
      "aidlc-validate-state",
      "aidlc-log-subagent",
      "aidlc-session-start",
      "aidlc-session-end",
      "aidlc-statusline",
      "aidlc-rebuild-stage-graph",
      "aidlc-run-sensors",
      "aidlc-continue-workflow", // the flow-altering Stop hook
    ]) {
      expect(r.stdout).toContain(`${hook}.ts present`);
    }
    // Off, the status line is simply not wired: no row for it, and never
    // reported as shipped-but-unwired enforcement.
    const off = util(["doctor", "--verbose"], installedProj());
    expect(off.stdout).toContain("aidlc-write-audit-log.ts present");
    expect(off.stdout).not.toContain("aidlc-statusline.ts present");
    expect(off.stdout).not.toContain("aidlc-statusline.ts shipped but not wired");
  });

  // The hook check must FLAG a wired-but-missing hook, not silently drop it. The
  // expected roster comes from settings.json (the contract) while presence is
  // probed against .claude/hooks/, so the two genuinely diverge: deleting
  // aidlc-continue-workflow.ts from a project whose settings.json still wires it
  // produces a loud "fail aidlc-continue-workflow.ts present" row. (The
  // derive-from-the-hooks-dir approach cannot catch this - a missing hook simply
  // isn't enumerated, so it is never reported.)
  test("12c: doctor flags a settings.json-wired hook that is missing on disk", () => {
    const p = installedProj((claudeDir) => {
      rmSync(join(claudeDir, "hooks", "aidlc-continue-workflow.ts"));
    });
    const r = util(["doctor", "--verbose"], p);
    expect(r.stdout).toContain("fail  aidlc-continue-workflow.ts present");
    // And doctor exits non-zero (a failed check), so CI/scripts see the breakage.
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("ok    aidlc-write-audit-log.ts present");
  });

  // When settings.json is absent the hook CONTRACT cannot be verified, so doctor
  // says so loudly rather than silently checking zero hooks. bareProj() has no
  // .claude/settings.json.
  test("12d: doctor reports the hook contract unverifiable when settings.json is absent", () => {
    const p = bareProj();
    const r = util(["doctor"], p);
    expect(r.stdout).toContain("Hook contract: settings.json unreadable");
    expect(r.status).not.toBe(0);
  });

  // In a terminal doctor cannot see the value Claude Code passes from .claude/settings.json, so "unset" would be false
  // there; with nothing to check, it says nothing.
  test("59: doctor says nothing about AWS_AIDLC_DEFAULT_SCOPE when no default is set where it can see one", () => {
    const p = bareProj();
    const r = util(["doctor", "--verbose"], p); // env stripped of the var by util()
    expect(r.stdout).toContain("Plugin selection"); // the verbose list ran past where the row was
    expect(r.stdout).not.toContain("AWS_AIDLC_DEFAULT_SCOPE");
  });

  test("60: doctor reports AWS_AIDLC_DEFAULT_SCOPE=classic as valid", () => {
    const p = bareProj();
    const r = util(["doctor", "--verbose"], p, { AWS_AIDLC_DEFAULT_SCOPE: "classic" });
    expect(r.stdout).toContain("AWS_AIDLC_DEFAULT_SCOPE=classic (valid)");
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
  test("14: init creates state, audit, codekb, and knowledge directories", () => {
    const p = emptyDir();
    util(["intent-create", "--scope", "poc"], p);
    // Creation writes a per-intent record (state + audit shards), not the flat
    // aidlc-docs/ trio. (Domain knowledge is SPACE-level, asserted below.)
    expect(existsSync(statePath(p))).toBe(true);
    // Audit is a SHARD DIR (<record>/audit/<host>-<clone>.md), not a single file.
    const auditDir = join(recordDirOf(p), "audit");
    expect(existsSync(auditDir)).toBe(true);
    expect(readdirSync(auditDir).filter((f) => f.endsWith(".md")).length).toBeGreaterThanOrEqual(1);
    // knowledge/ is SPACE-level (ensureWorkspaceDirs creates
    // aidlc/spaces/<space>/knowledge/ — a sibling of intents, not per-record).
    expect(existsSync(spaceKnowledgeOf(p))).toBe(true);
    expect(existsSync(spaceCodekbOf(p))).toBe(true);
    expect(statSync(spaceCodekbOf(p)).isDirectory()).toBe(true);
    expect(readdirSync(spaceCodekbOf(p))).toEqual([]);
  });

  test("15: init output contains creation + state-init summary", () => {
    const p = emptyDir();
    const r = util(["intent-create", "--scope", "poc"], p);
    // init is a back-compat alias for intent-create; the stdout reports the
    // created intent + state init.
    expect(r.stdout).toContain("Intent created:");
    expect(r.stdout).toContain("State initialized:");
  });

  // init/intent-create creates a per-intent record, so a SECOND init is not an
  // error - it simply creates a second intent in the workspace.
  test("second init creates a second intent (no re-init guard): exit 0, no 'already exists'", () => {
    const p = emptyDir();
    const first = util(["intent-create", "--scope", "poc"], p);
    expect(first.status).toBe(0);
    const second = util(["intent-create", "--scope", "poc"], p);
    expect(second.status).toBe(0);
    expect(second.out).not.toContain("already exists");
    expect(second.out).not.toContain("--force");
    const intentsDir = join(p, "aidlc", "spaces", "default", "intents");
    const records = readdirSync(intentsDir).filter((d) =>
      existsSync(join(intentsDir, d, "aidlc-state.md")),
    );
    expect(records.length).toBe(2);
  });

  test("33: init bootstrap has workspace-scaffold checkbox", () => {
    const p = emptyDir();
    util(["intent-create", "--scope", "poc"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("workspace-scaffold");
  });

  test("33b: a new record's Construction phase has no never-filled per-unit line", () => {
    const p = emptyDir();
    util(["intent-create", "--scope", "feature"], p);
    const state = readFileSync(statePath(p), "utf-8");
    expect(state).toContain("### CONSTRUCTION PHASE\n- [ ] functional-design");
    expect(state).not.toMatch(/^Per unit:/m);
  });

  test("45: init with --depth overrides bugfix default (Standard)", () => {
    const p = emptyDir();
    util(["intent-create", "--scope", "bugfix", "--depth", "standard"], p);
    expect(stateField(p, "Depth")).toBe("Standard");
  });

  test("54: init with --test-strategy overrides default (Minimal)", () => {
    const p = emptyDir();
    util(["intent-create", "--scope", "feature", "--test-strategy", "minimal"], p);
    expect(stateField(p, "Test Strategy")).toBe("Minimal");
  });

  test("69: init emits WORKFLOW_STARTED as the first audit event", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    // Audit is sharded under the created record's audit/ dir; read via readAudit.
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
    const result = util(["scope-change", "--scope", "mvp"], p);
    expect(result.stdout).toContain("Switched to mvp (the set of stages this work runs): ");
    expect(result.stdout).toContain("You can switch back to poc any time.");
    expect(stateField(p, "Scope")).toBe("mvp");
    expect(auditField(auditPath(p), "SCOPE_CHANGED", "New Scope")).toBe("mvp");
  });

  test("17: scope-change poc->mvp updates Stages to Execute", () => {
    const p = pocStateAuditProj();
    util(["scope-change", "--scope", "mvp"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("Stages to Execute");
  });

  test("17b: a record made with a per-unit line keeps it through a scope change", () => {
    const p = pocStateAuditProj();
    util(["scope-change", "--scope", "mvp"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("### CONSTRUCTION PHASE\nPer unit: todo-core\n- [ ] functional-design");
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
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
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
    expect(r.status).toBe(1);
  });

  test("22: scope-change appends exactly one SCOPE_CHANGED audit event", () => {
    const p = stateAuditProj();
    util(["scope-change", "--scope", "poc"], p);
    expect(auditEventCount(auditPath(p), "SCOPE_CHANGED")).toBe(1);
  });

  test("22b: scope-change records a setting only when its value changes", () => {
    const p = emptyDir();
    expect(util(["intent-create", "--scope", "bugfix"], p).status).toBe(0);
    expect(util(["scope-change", "--scope", "feature"], p).status).toBe(0);
    // The rows the scope change wrote follow its own SCOPE_CHANGED row.
    const blocks = readAudit(p).split(/\n---\n/);
    const changed = blocks.findIndex((block) => /^\*\*Event\*\*: SCOPE_CHANGED$/m.test(block));
    expect(changed).toBeGreaterThanOrEqual(0);
    const settings = blocks.slice(changed + 1)
      .filter((block) => /^\*\*Event\*\*: (CEREMONY_SET|GUARD_POLICY_SET)$/m.test(block));
    for (const row of settings) {
      const before = /^\*\*Old(?: Value)?\*\*: (.*)$/m.exec(row)?.[1];
      const after = /^\*\*New(?: Value)?\*\*: (.*)$/m.exec(row)?.[1];
      expect(after, row).not.toBe(before);
    }
    expect(stateField(p, "Guard Policy")).toBe("off (from scope feature)");
  });

  test("44: scope-change with --depth overrides default (Comprehensive)", () => {
    const p = pocStateAuditProj(true);
    util(["scope-change", "--scope", "mvp", "--depth", "comprehensive"], p);
    expect(stateField(p, "Depth")).toBe("Comprehensive");
  });

  test("70: scope-change keeps an open gate's [?] and a revision's [R]", () => {
    // Collapsing either to [ ] left a gate the audit shows open reading as a
    // stage that never started, so report refused it as still pending.
    for (const marker of ["[?]", "[R]"]) {
      const p = pocStateAuditProj();
      // The rebuild keys on the legend line an engine-created state file
      // carries under the heading; the fixture omits it.
      sedReplaceInFile(
        statePath(p),
        "## Stage Progress\n",
        "## Stage Progress\n<!-- Checkbox states: [ ] not started -->\n",
      );
      sedReplaceInFile(statePath(p), "- [-] feasibility", `- ${marker} feasibility`);
      const r = util(["scope-change", "--scope", "mvp"], p);
      expect(r.status, r.out).toBe(0);
      const after = readFileSync(statePath(p), "utf-8");
      // Proof the rebuild ran: mvp skips reverse-engineering on greenfield.
      expect(after).toContain("- [ ] reverse-engineering \u2014 SKIP");
      expect(after).toContain(`- ${marker} feasibility`);
      expect(after).toContain("[?] awaiting approval (gate open), [R] revising (user rejected gate)");
    }
  });

  test("71: scope-change skips an open gate or an unstarted current stage it drops; next routes past it", () => {
    // mvp skips market-research. The person asked for that scope, so the stage
    // is skipped with the change ([S] plus one STAGE_SKIPPED), and next routes
    // past it through the report-owned skip, which writes no second row.
    const atMarketResearch = (marker: string): string => {
      const p = stateAuditProj();
      sedReplaceInFile(
        statePath(p),
        "## Stage Progress\n",
        "## Stage Progress\n<!-- Checkbox states: [ ] not started -->\n",
      );
      sedReplaceInFile(statePath(p), "- [x] market-research", `- ${marker} market-research`);
      sedReplaceInFile(statePath(p), "- [-] feasibility", "- [ ] feasibility");
      sedReplaceInFile(statePath(p), "**Current Stage**: feasibility", "**Current Stage**: market-research");
      return p;
    };
    const orch = (args: string[], p: string): { kind?: string; message?: string; reason?: string } => {
      const res = spawnSync(BUN, [ORCH_TOOL, ...args, "--project-dir", p], {
        encoding: "utf-8",
        env: stripScope(),
      });
      return JSON.parse((res.stdout ?? "").trim());
    };

    for (const [marker, was] of [["[?]", "it was waiting for your approval"], ["[ ]", "it had not started"]]) {
      const p = atMarketResearch(marker);
      const skipsBefore = auditEventCount(auditPath(p), "STAGE_SKIPPED");
      const changed = util(["scope-change", "--scope", "mvp"], p);
      expect(changed.status, changed.out).toBe(0);
      expect(changed.out).toContain(`Skipped Market Research (${was}): mvp does not run it.`);
      expect(changed.out).toContain("You can still run it on its own any time.");
      expect(changed.out).not.toContain("--single");
      expect(readFileSync(statePath(p), "utf-8")).toContain("- [S] market-research \u2014 SKIP");
      expect(auditEventCount(auditPath(p), "SCOPE_CHANGED")).toBe(1);
      expect(auditEventCount(auditPath(p), "STAGE_SKIPPED")).toBe(skipsBefore + 1);
      expect(auditField(auditPath(p), "STAGE_SKIPPED", "Skip Kind")).toBe("scope-change");
      expect(auditField(auditPath(p), "STAGE_SKIPPED", "Reason")).toBe(
        "Scope changed to mvp, which does not run this stage",
      );

      const directive = orch(["next"], p);
      expect(directive.kind, JSON.stringify(directive)).toBe("print");
      expect(directive.message).toContain("--stage market-research --result skipped");
      const routed = orch(
        ["report", "--stage", "market-research", "--result", "skipped", "--reason", "stage is SKIP in the approved workflow plan"],
        p,
      );
      expect(routed.kind, JSON.stringify(routed)).toBe("done");
      expect(stateField(p, "Current Stage")).toBe("feasibility");
      expect(readFileSync(statePath(p), "utf-8")).toContain("- [-] feasibility");
      expect(auditEventCount(auditPath(p), "STAGE_SKIPPED")).toBe(skipsBefore + 1);
    }

    // The reply is what happened and how to go back, then each stage it
    // skipped and each setting whose value changed: the defaults mvp shares
    // with feature are not listed as changes.
    const waiting = atMarketResearch("[?]");
    // The settings a live run listed as "changed: off (from scope feature) to
    // off (from scope mvp)": recorded under the new scope, never said.
    sedReplaceInFile(
      statePath(waiting),
      "- **Change Control**: strict (from scope feature)",
      [
        "- **Guard Policy**: off (from scope feature)",
        "- **Sensors**: on (from scope feature)",
        "- **Learnings**: on (from scope feature)",
        "- **Summary Confirmation**: on (from scope feature)",
        "- **Plan Approval**: on (from scope feature)",
      ].join("\n"),
    );
    const lines = util(["scope-change", "--scope", "mvp"], waiting).stdout.trim().split("\n");
    expect(stateField(waiting, "Guard Policy")).toBe("off (from scope mvp)");
    expect(stateField(waiting, "Plan Approval")).toBe("on (from scope mvp)");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Switched to mvp \(the set of stages this work runs\): \d+ stages \(\d+ done\), \d+ approval gates.*\. You can switch back to feature any time\.$/);
    expect(lines[1]).toBe(
      "Skipped Market Research (it was waiting for your approval): mvp does not run it. " +
        "You can still run it on its own any time.",
    );
    const toPoc = util(["scope-change", "--scope", "poc"], stateAuditProj()).stdout;
    expect(toPoc).toContain("Depth changed: Standard -> Minimal");
    expect(toPoc).not.toContain("is already");

    const revising = atMarketResearch("[R]");
    const changed = util(["scope-change", "--scope", "mvp"], revising);
    expect(changed.status, changed.out).toBe(0);
    // A revision already routes, so it keeps its box.
    expect(changed.out).not.toContain("Skipped Market Research");
    expect(readFileSync(statePath(revising), "utf-8")).toContain(
      "- [R] market-research \u2014 SKIP",
    );
    const next = spawnSync(BUN, [ORCH_TOOL, "next", "--project-dir", revising], {
      encoding: "utf-8",
      env: stripScope(),
    });
    const directive = JSON.parse((next.stdout ?? "").trim()) as { kind?: string; message?: string };
    expect(directive.kind, next.stdout + next.stderr).toBe("print");
    expect(directive.message).toContain("--result skipped");
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
    // Reset feasibility to [ ] first so we verify [-] gets set.
    sedReplaceInFile(statePath(p), "[-] feasibility", "[ ] feasibility");
    util(["set-status", "--stage", "feasibility"], p);
    expect(readFileSync(statePath(p), "utf-8")).toContain("[-] feasibility");
  });

  test("29: set-status errors on unknown stage (exit 1)", () => {
    const p = stateProj();
    const r = util(["set-status", "--stage", "nonexistent"], p);
    expect(r.out).toContain("Unknown stage");
    expect(r.status).toBe(1);
  });

  test("30: set-status errors without state file (exit 1)", () => {
    const p = bareProj();
    const r = util(["set-status", "--stage", "feasibility"], p);
    expect(r.out).toContain("No state file");
    expect(r.status).toBe(1);
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
    const result = util(["config-change", "--depth", "minimal"], p);
    expect(result.stdout).toContain("Depth changed: Standard -> Minimal");
    expect(stateField(p, "Depth")).toBe("Minimal");
  });

  test("39: config-change same depth does not modify state", () => {
    const p = stateAuditProj(); // fixture Depth: Standard
    const before = readFileSync(statePath(p), "utf-8");
    util(["config-change", "--depth", "standard"], p);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
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
    expect(r.status).toBe(1);
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
    expect(r.status).toBe(1);
  });

  test("48: config-change updates Test Strategy to Minimal", () => {
    const p = stateAuditProj();
    const result = util(["config-change", "--test-strategy", "minimal"], p);
    expect(result.stdout).toContain("Test strategy changed: Standard -> Minimal");
    expect(stateField(p, "Test Strategy")).toBe("Minimal");
  });

  test("49: config-change same strategy does not modify state", () => {
    const p = stateAuditProj();
    util(["config-change", "--test-strategy", "standard"], p);
    const before = readFileSync(statePath(p), "utf-8");
    util(["config-change", "--test-strategy", "standard"], p);
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
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
    expect(r.status).toBe(1);
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
    expect(r.status).toBe(1);
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
    expect(auditEventCount(auditPath(p), "TEST_STRATEGY_CHANGED")).toBe(1);
  });

  test("57: config-change validates both flags before any state write", () => {
    const p = stateAuditProj();
    const before = readFileSync(statePath(p), "utf-8");
    const r = util(["config-change", "--depth", "minimal", "--test-strategy", "extreme"], p);
    expect(r.out).toContain("Unknown test strategy");
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
    expect(r.status).toBe(1);
  });

  test("58: config-change with no flags prints usage error (exit 1)", () => {
    const p = stateProj();
    const r = util(["config-change"], p);
    expect(r.out).toContain("requires");
    expect(r.status).toBe(1);
  });
});

// ============================================================
// detect-scope (covers: subcommand:aidlc-utility:detect-scope)
// ============================================================

describe("t27 aidlc-utility detect-scope", () => {
  test("65: detect-scope emits exactly one SCOPE_DETECTED + JSON ack", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    const r = util(
      ["detect-scope", "--scope", "feature", "--input", "build a todo app", "--source", "freeform"],
      p,
    );
    // After intent-create creates the per-intent record, detect-scope's audit
    // lands in the created record's shard dir - read via readAudit.
    const audit = readAudit(p);
    expect(auditEventCountIn(audit, "SCOPE_DETECTED")).toBe(1);
    expect(r.stdout).toContain('"emitted":"SCOPE_DETECTED"');
    expect(auditFieldIn(audit, "SCOPE_DETECTED", "Detected scope")).toBe("feature");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("66: detect-scope rejects invalid scope (exit 1)", () => {
    const p = bareProj();
    util(["intent-create", "--scope", "bugfix"], p);
    const r = util(["detect-scope", "--scope", "bogus", "--input", "x"], p);
    expect(r.status).toBe(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// ============================================================
// resolve-env-scope (covers: subcommand:aidlc-utility:resolve-env-scope)
// ============================================================

describe("t27 aidlc-utility resolve-env-scope", () => {
  test("62: resolve-env-scope with unset env prints nothing and exits 0", () => {
    const r = util(["resolve-env-scope"]); // util() strips AWS_AIDLC_DEFAULT_SCOPE
    expect(r.status).toBe(0);
    expect(r.out).toBe("");
  });

  test("63: resolve-env-scope with valid env prints scope= line and exits 0", () => {
    const r = util(["resolve-env-scope"], undefined, { AWS_AIDLC_DEFAULT_SCOPE: "classic" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("scope=classic");
  });

  test("64: resolve-env-scope with invalid env exits 1 with canonical error", () => {
    const r = util(["resolve-env-scope"], undefined, { AWS_AIDLC_DEFAULT_SCOPE: "bogus" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
  });
});

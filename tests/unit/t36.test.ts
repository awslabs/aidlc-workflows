// covers: subcommand:aidlc-utility:scope-change
//
// Mechanism = cli. Every assertion about `bun aidlc-utility.ts scope-change
// ...` (exit code, state file, audit rows) is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on res.status / the aidlc-state.md the tool rewrites
// / the audit shards it appends to - the PROCESS boundary, not an in-process
// handleScopeChange() call. An in-process twin would lose the exit-code half
// Tests 4 & 5 rely on: the tool's reject path is die() ->
// emitError() -> process.exit(1) (aidlc-utility.ts -> aidlc-lib.ts),
// only observable across the process boundary.
//
// CONTRACT:
//   - handleScopeChange (aidlc-utility.ts):
//       * `--scope` required -> die("--scope is required for scope-change")
//         when absent.
//       * unknown target -> die(`Unknown scope: ${newScope}. ...`) before any
//         state mutation, AFTER the state-file existence check (so a seeded
//         state is required to reach the scope-validation arm).
//       * on success: setField(content,"Scope",newScope) +
//         rewrites Stage Progress / counts / Last Updated, then writes state,
//         then appendAuditEvent("SCOPE_CHANGED", {Old Scope, New Scope,
//         Stage Count Delta, Stages in Scope, Approval Gates, Depth}).
//       * Current Stage is NOT touched — the rewrite preserves the
//         `## Current Status` block; only the `## Stage Progress` checkbox
//         section + the numbered fields are rebuilt.
//   - The 11 canonical scopes are exactly the keys of loadScopeMapping():
//     enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch,
//     classic, workshop, express.
//   - Audit row shape (aidlc-audit.ts): a `## Scope Changed` heading,
//     then `**Timestamp**:`, `**Event**: SCOPE_CHANGED`, then one
//     `**<key>**: <value>` line per field, terminated by `---`. Here we count
//     the event row and read the Old Scope field block-scoped.
//   - state-mid-ideation.md fixture carries `**Scope**: feature` and
//     `**Current Stage**: feasibility`; Test 7 "Old Scope=feature" and Test 6
//     "Current Stage preserved" both lean on that fixture content.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit
// shards / state.md - written by the tool via forward-slash helpers -
// round-trip when read back) seeded with state-mid-ideation.md
// (Scope=feature). NOTHING is written under tests/fixtures/**. All temp dirs
// cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
// Every case seeds this fixture (state-mid-ideation.md: Scope=feature,
// Current Stage=feasibility).
const STATE_MID_IDEATION = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "state-mid-ideation.md",
);

// The 11 canonical scopes - the keys of loadScopeMapping().
const CANONICAL_SCOPES = [
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
] as const;

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// Per-intent layout: state lives in the active intent's record (seedStateFile
// seeds it so the cursor resolves for both this test process and the spawned
// scope-change tool); the audit trail is a DIR of per-clone shards. The SPAWNED
// tool mints its own clone-id and CREATES its shard on first emit, so audit reads
// glob every shard via readAllAuditShards (no audit-seed needed; SCOPE_CHANGED is
// absent from any baseline).
const statePath = (p: string): string => seededStateFile(p);

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, STATE_MID_IDEATION);
  return p;
}

interface CliResult {
  status: number;
  out: string;
}

function scopeChange(args: string[], p: string, env: Record<string, string> = {}): CliResult {
  const res = spawnSync(BUN, [TOOL, "scope-change", ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Value of `- **<key>**: <value>` from the aidlc-state.md body. Mirrors the
 * getField the tool uses (aidlc-lib.ts). Returns "" when absent.
 */
function stateField(file: string, key: string): string {
  if (!existsSync(file)) return "";
  const re = new RegExp(`^- \\*\\*${key}\\*\\*: (.*)$`);
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return "";
}

function scopeChangedCount(body: string): number {
  return body
    .split("\n")
    .filter((l) => l === "**Event**: SCOPE_CHANGED").length;
}

/**
 * Value of <key> from the FIRST audit block containing it whose `**Event**:`
 * matches <ev>. Walks the file; resets at `## ` headings and `---` separators;
 * splits `**label**: value` on the literal `**: ` separator (audit-row shape per
 * aidlc-audit.ts appendAuditEntryUnlocked). Block-scoped, so it pins Old Scope
 * to the SCOPE_CHANGED row exactly.
 */
function auditField(body: string, ev: string, key: string): string {
  let matched = false;
  for (const line of body.split("\n")) {
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

describe("t36 aidlc-utility scope-change — CLI contract (migrated from t36-utility-scope-change.sh, plan 7)", () => {
  test("1: scope-change updates Scope field to mvp", () => {
    const p = proj();
    const r = scopeChange(["--scope", "mvp"], p);
    expect(r.status).toBe(0);
    expect(stateField(statePath(p), "Scope")).toBe("mvp");
  });

  test("2: scope-change emits SCOPE_CHANGED", () => {
    const p = proj();
    const r = scopeChange(["--scope", "bugfix"], p);
    expect(r.status).toBe(0);
    expect(scopeChangedCount(readAllAuditShards(p))).toBe(1);
  });

  test("3: all 11 canonical scopes accepted as targets", () => {
    for (const target of CANONICAL_SCOPES) {
      const p = proj();
      scopeChange(["--scope", target], p);
      // The fixture starts at Scope=feature. For target===feature the tool
      // short-circuits ("Scope is already feature", exit 0) and leaves the
      // field at feature - which still satisfies `**Scope**: feature`.
      expect(stateField(statePath(p), "Scope")).toBe(target);
    }
  });

  test("4: invalid target scope rejected (exit 1)", () => {
    const p = proj();
    const r = scopeChange(["--scope", "totally-bogus"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Unknown scope");
  });

  test("5: missing --scope flag rejected (exit 1)", () => {
    const p = proj();
    // No --scope (scopeChange always appends --project-dir, never --scope).
    const r = scopeChange([], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("--scope is required");
  });

  test("6: Current Stage preserved across scope-change", () => {
    const p = proj();
    const before = stateField(statePath(p), "Current Stage");
    expect(before).toBe("feasibility"); // fixture sanity (state-mid-ideation.md)
    scopeChange(["--scope", "bugfix"], p);
    const after = stateField(statePath(p), "Current Stage");
    expect(after).toBe(before);
  });

  test("7: SCOPE_CHANGED records Old Scope=feature (and New Scope=mvp)", () => {
    const p = proj();
    scopeChange(["--scope", "mvp"], p);
    // state-mid-ideation.md starts at Scope=feature.
    expect(auditField(readAllAuditShards(p), "SCOPE_CHANGED", "Old Scope")).toBe("feature");
    expect(auditField(readAllAuditShards(p), "SCOPE_CHANGED", "New Scope")).toBe("mvp");
  });

  // --- Autonomy guard (the recompose guard's twin) ---
  test("8: autonomous Construction with nobody asking - scope-change refuses and names a setter that runs", () => {
    // scope-change flips stage EXECUTE/SKIP suffixes exactly like recompose;
    // under an unattended autonomous run there is no human at the gate, so the
    // verb must refuse (t194 pins the recompose side of the same rule). The
    // fixture has no Construction Autonomy Mode field, so inject it as
    // set-autonomy would.
    const p = proj();
    const sp = statePath(p);
    const withAutonomy = readFileSync(sp, "utf-8").replace(
      /- \*\*Status\*\*: Running/,
      "- **Status**: Running\n- **Construction Autonomy Mode**: autonomous",
    );
    expect(withAutonomy).toContain("- **Construction Autonomy Mode**: autonomous");
    writeFileSync(sp, withAutonomy, "utf-8");
    const r = scopeChange(["--scope", "mvp"], p);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Construction Autonomy Mode is autonomous");
    // The step it names is one that runs: the setter's real command, and no
    // wait that never ends (the mode stays autonomous to the end of the run).
    expect(r.out).toMatch(/`[^`]*aidlc[^`]*bolt[^`]* set-autonomy --mode gated`/);
    expect(r.out).not.toContain("(aidlc-bolt set-autonomy");
    expect(r.out).not.toContain("wait for the current build");
    expect(readFileSync(sp, "utf-8")).toBe(withAutonomy);
    expect(scopeChangedCount(readAllAuditShards(p))).toBe(0);
  });

  // The person typed the change while Construction runs "Continue
  // automatically": it goes through like any other, and the remaining work
  // keeps running automatically. An unattended driver is still refused.
  describe("8c: autonomous Construction, the person asked for the change", () => {
    const autonomousWithRequest = (prompt = "/aidlc --scope mvp"): { p: string; sp: string } => {
      const p = proj();
      const sp = statePath(p);
      writeFileSync(sp, readFileSync(sp, "utf-8").replace(
        /- \*\*Status\*\*: Running/,
        "- **Status**: Running\n- **Construction Autonomy Mode**: autonomous",
      ), "utf-8");
      const hook = spawnSync(BUN, [join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
        cwd: p,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: p, session_id: "t36-person", prompt }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: p },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
      });
      expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
      return { p, sp };
    };

    test("the change goes through and the autonomy choice stays", () => {
      const { p, sp } = autonomousWithRequest();
      const r = scopeChange(["--scope", "mvp"], p);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("Switched to mvp");
      expect(r.out).not.toContain("unattended");
      expect(stateField(sp, "Scope")).toBe("mvp");
      expect(stateField(sp, "Construction Autonomy Mode")).toBe("autonomous");
      expect(scopeChangedCount(readAllAuditShards(p))).toBe(1);
    });

    test("one reply that approves and asks for the change does both", () => {
      // "approve it, and make this an mvp": the approval recorded from the
      // reply does not use up the request in it.
      const { p, sp } = autonomousWithRequest("approve it, and make this an mvp");
      appendAuditEntry("GATE_APPROVED", { Stage: "feasibility", "User Input": "Approve" }, p);
      const r = scopeChange(["--scope", "mvp"], p);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("Switched to mvp");
      expect(stateField(sp, "Construction Autonomy Mode")).toBe("autonomous");
    });

    test("an unattended driver is still refused, naming the setter", () => {
      const { p, sp } = autonomousWithRequest();
      const before = readFileSync(sp, "utf-8");
      const r = scopeChange(["--scope", "mvp"], p, { AIDLC_UNATTENDED: "1" });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/`[^`]*aidlc[^`]*bolt[^`]* set-autonomy --mode gated`/);
      expect(readFileSync(sp, "utf-8")).toBe(before);
      expect(scopeChangedCount(readAllAuditShards(p))).toBe(0);
    });
  });

  // One reply that approves and asks for a lower-policy scope: the approval
  // recorded from it does not use up the request, so the scope's own lower
  // Guard Policy follows, as when the person asked for the change alone.
  test("8d: \"approve it, and switch to mvp\" on enterprise lowers Guard Policy with the scope", () => {
    const p = proj();
    const sp = statePath(p);
    writeFileSync(sp, readFileSync(sp, "utf-8")
      .replace("- **Scope**: feature", "- **Scope**: enterprise")
      .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: strict (from scope enterprise)"), "utf-8");
    const hook = spawnSync(BUN, [join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      cwd: p,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: p, session_id: "t36-person", prompt: "approve it, and switch to mvp" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: p },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
    appendAuditEntry("GATE_APPROVED", { Stage: "feasibility", "User Input": "Approve" }, p);
    const r = scopeChange(["--scope", "mvp"], p);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Switched to mvp");
    expect(r.out).not.toContain("Guard Policy stays");
    expect(stateField(sp, "Guard Policy")).toBe("off (from scope mvp)");
  });

  test("8b: gated Construction proceeds - scope-change flips as today when autonomy is not autonomous", () => {
    const p = proj();
    const sp = statePath(p);
    writeFileSync(
      sp,
      readFileSync(sp, "utf-8").replace(
        /- \*\*Status\*\*: Running/,
        "- **Status**: Running\n- **Construction Autonomy Mode**: gated",
      ),
      "utf-8",
    );
    const r = scopeChange(["--scope", "mvp"], p);
    expect(r.status).toBe(0);
    expect(stateField(sp, "Scope")).toBe("mvp");
  });
});

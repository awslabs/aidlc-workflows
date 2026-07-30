// t250-cursor-guard-logic: the end-to-end DENIAL path of the two Cursor
// fail-closed gates, driven through the SHIPPED adapter as a real subprocess.
//
// covers: file:hooks/aidlc-state-transition-guard.ts, file:hooks/aidlc-reviewer-scope.ts,
//   file:harness/cursor/hooks/aidlc-cursor-adapter.ts
//
// security/implementation-guidance.md §2 step 8 names this test
// `t147-cursor-guard-logic.test.ts`, but t147 is already taken
// (t147-kiro-hook-adapter.test.ts); scanning every tier, the next free
// sequential number is 250. It lands in tests/integration/ (the guidance's
// tier), keeping the descriptive `-cursor-guard-logic` suffix.
//
// WHAT (TC-SEC-020..025 from security/testing-framework.md). The two Cursor
// gates wired failClosed:true in hooks.json are the state-transition guard
// (beforeShellExecution) and the reviewer read-scope gate (preToolUse). Both
// deny by the SAME Cursor contract: the core hook exits 2 + stderr, and the
// adapter translates that to a `{"permission":"deny", user_message,
// agent_message}` JSON on stdout at EXIT 0 (Cursor blocks on the JSON, not a
// non-zero exit). This test drives each chain through the real
// `bun dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts <target>` subprocess
// and asserts:
//   - a DISALLOWED shell state transition (a direct lifecycle verb on
//     aidlc-state.ts: set/advance/finalize/approve/...) → permission:deny,
//     exit 0. [TC-SEC-020..024 analog: the guard's real denial set is the
//     engine-owned lifecycle verbs, not the cli.json shell denylist — that
//     rm/push/curl set is enforced declaratively by .cursor/cli.json, verified
//     in t248, not by this hook.]
//   - an OUT-OF-SCOPE reviewer read (a sibling unit's construction/ path, or a
//     sweep spanning siblings) while a dispatch record is in flight →
//     permission:deny, exit 0.
//   - ALLOWED operations pass through cleanly: exit 0, NO deny JSON — a
//     read-only state query, a safe shell command, a current-unit reviewer
//     read, and a current-unit-scoped glob. [TC-SEC-025: the regression guard
//     against over-denial.]
// The deny JSON is asserted to carry snake_case field names (camelCase is
// silently ignored by Cursor — a load-bearing contract).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim; the deny is the exit-2 →
// JSON translation across the process boundary. In-process testing would bypass
// the exact stdin/stdout/exit-code surface the gate contracts. This reuses the
// fixture corpus and the spawnSync pattern from the adapter test (t249).

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
import { DEFAULT_SPACE, intentsDirOf } from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CURSOR_TREE = join(REPO_ROOT, "dist", "cursor", ".cursor");
const FIXTURES = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "cursor-hook-payloads", "payloads.json"),
    "utf-8",
  ),
) as Record<string, Record<string, unknown>>;

// The reviewer under review in every reviewer-scope case: unit U03-scoring, no
// exempt sibling paths (mirrors t221's dispatch fixture). The dispatch record's
// freshness window IS the enforcement window — while it exists beside the
// intent's aidlc-state.md, the reviewer-scope gate is live.
const DISPATCH = {
  reviewer: "aidlc-architecture-reviewer-agent",
  stage: "nfr-requirements",
  unit: "U03-scoring",
  exempt: [],
};

/** A scratch project: the shipped .cursor tree + the bare per-intent workspace
 *  shell the core hooks resolve their record root through. The state-transition
 *  guard is state-independent (it blocks a lifecycle verb by the command string
 *  alone); the reviewer-scope gate reads the dispatch record under the resolved
 *  record root, so the shell must exist for reviewerDispatchPath() to land it
 *  where the hook looks. `withDispatch` seeds the in-flight review record. */
function scratchProject(withDispatch: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t250-"));
  cpSync(CURSOR_TREE, join(dir, ".cursor"), { recursive: true });
  // Bare space record root — no intent registry, so docsRoot() resolves to
  // aidlc/spaces/default/intents/ and the dispatch record lands there.
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(intentsDir, { recursive: true });
  if (withDispatch) {
    writeFileSync(
      join(intentsDir, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify(DISPATCH),
      "utf-8",
    );
  }
  return dir;
}

// The adapter resolves its project dir from AIDLC_PROJECT_DIR first (before
// cursor.cwd), so pinning it to the scratch dir points the shimmed core hook at
// the seeded workspace regardless of the fixture's placeholder cwd.
function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: projectDir },
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

interface DenyJson {
  permission?: string;
  user_message?: string;
  agent_message?: string;
}

/** Assert the Cursor deny contract: exit 0, permission:deny, non-empty
 *  snake_case messages (camelCase silently ignored by Cursor). */
function expectDeny(r: { stdout: string; code: number }): DenyJson {
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout) as DenyJson;
  expect(out.permission).toBe("deny");
  expect(out.user_message ?? "").not.toBe("");
  expect(out.agent_message ?? "").not.toBe("");
  expect(r.stdout).toContain("user_message");
  expect(r.stdout).toContain("agent_message");
  expect(r.stdout).not.toContain("userMessage");
  expect(r.stdout).not.toContain("agentMessage");
  return out;
}

/** Assert the Cursor allow contract: exit 0, NO deny JSON (empty stdout — Cursor
 *  treats no output as permit). */
function expectAllow(r: { stdout: string; code: number }): void {
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("");
}

// ---------------------------------------------------------------------------
// (a) state-transition guard — disallowed shell state transitions deny.
// ---------------------------------------------------------------------------

describe("t250 (a) state-transition guard denies engine-owned lifecycle verbs [TC-SEC-020..024]", () => {
  // Each disallowed direct aidlc-state.ts lifecycle verb → permission:deny. The
  // guard's denial set is the engine-owned transitions (the shell rm/push/curl
  // denylist is cli.json's job, asserted in t248), so this is the true
  // end-to-end shell-gate denial for the Cursor harness.
  const BLOCKED = [
    { name: "approve", fixture: "beforeShellExecution" },
    { name: "advance", fixture: "beforeShellExecution_advance" },
    { name: "finalize", fixture: "beforeShellExecution_finalize" },
  ];

  for (const { name, fixture } of BLOCKED) {
    test(`direct aidlc-state.ts ${name} → permission:deny (exit 0)`, () => {
      const dir = scratchProject(false);
      try {
        const out = expectDeny(runAdapter(dir, "state-transition-guard", FIXTURES[fixture]));
        // The deny reason names the verb and redirects to the engine-owned path.
        expect(out.user_message).toContain(name);
        expect(out.user_message).toContain("aidlc-orchestrate.ts report");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("safe shell command passes through (exit 0, no deny) [TC-SEC-025]", () => {
    const dir = scratchProject(false);
    try {
      expectAllow(runAdapter(dir, "state-transition-guard", FIXTURES.beforeShellExecution_safe));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only state query passes through (exit 0, no deny) [TC-SEC-025]", () => {
    // Regression: only the lifecycle-mutating verbs are blocked; a read-only
    // `show` query is not a transition and must not be over-denied.
    const dir = scratchProject(false);
    try {
      expectAllow(runAdapter(dir, "state-transition-guard", FIXTURES.beforeShellExecution_query));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) reviewer read-scope gate — out-of-scope reads deny while a review is
//     in flight; in-scope reads pass through.
// ---------------------------------------------------------------------------

describe("t250 (b) reviewer read-scope gate denies out-of-scope reads [TC-SEC-020..025]", () => {
  const OUT_OF_SCOPE = [
    { name: "sibling-unit Read", fixture: "preToolUse_read_sibling" },
    { name: "sibling-spanning Grep sweep", fixture: "preToolUse_grep_sibling_sweep" },
    { name: "sibling-unit LS", fixture: "preToolUse_ls_sibling" },
  ];

  for (const { name, fixture } of OUT_OF_SCOPE) {
    test(`${name} → permission:deny (exit 0)`, () => {
      const dir = scratchProject(true);
      try {
        const out = expectDeny(runAdapter(dir, "reviewer-scope", FIXTURES[fixture]));
        // The deny reason names the scope (the unit under review).
        expect(out.user_message).toContain("reviewer read-scope");
        expect(out.user_message).toContain(DISPATCH.unit);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("current-unit Read passes through (exit 0, no deny) [TC-SEC-025]", () => {
    const dir = scratchProject(true);
    try {
      expectAllow(runAdapter(dir, "reviewer-scope", FIXTURES.preToolUse_read_current));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("current-unit-scoped Glob passes through (exit 0, no deny) [TC-SEC-025]", () => {
    const dir = scratchProject(true);
    try {
      expectAllow(runAdapter(dir, "reviewer-scope", FIXTURES.preToolUse_glob_current));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no review in flight: even a sibling read passes (fail-open, nothing to enforce)", () => {
    // Without the dispatch record the gate has no unit/exempt facts to enforce
    // against, so it fails open — the reviewer-scope bound is only live while a
    // review is dispatched.
    const dir = scratchProject(false);
    try {
      expectAllow(runAdapter(dir, "reviewer-scope", FIXTURES.preToolUse_read_sibling));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

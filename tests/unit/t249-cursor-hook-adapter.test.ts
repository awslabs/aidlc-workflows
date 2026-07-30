// t249-cursor-hook-adapter: the Cursor stdin shim normalizes the documented
// Cursor hook payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-session-start.ts, file:hooks/aidlc-stop.ts, file:hooks/aidlc-state-transition-guard.ts, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-log-subagent.ts
//
// The direct analog of t147-kiro-hook-adapter.test.ts / t149-codex-hook-adapter.test.ts
// for the Cursor harness. ADR-006 names this `t146-cursor-hook-adapter.test.ts`,
// but t146 is already taken (t146-core-hygiene.test.ts); scanning every tier,
// the next free sequential number is 249. It lands in tests/unit/ (the same
// tier as the kiro/codex adapter tests), keeping the descriptive
// `-cursor-hook-adapter` suffix.
//
// WHAT (TC-SEC-010..016 from security/testing-framework.md). Each case pipes a
// fixture from tests/fixtures/cursor-hook-payloads/ (synthetic snake_case
// payloads authored from the documented Cursor schema —
// system-architecture.md §4.1) into
// `bun dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts <target>` inside a
// scratch project carrying an active workflow state, then asserts the
// observable core-hook effect Cursor's own contract demands:
//   session-start  → beforeSubmitPrompt fires the core SessionStart AT MOST
//                    ONCE per conversation_id (a marker under aidlc/ dedupes),
//                    emitting plain-text context (NOT the {additionalContext}
//                    JSON wrapper — the shim unwraps it for Cursor's stdout
//                    channel). [TC-SEC-015]
//   stop           → core {decision:"block", reason} maps to Cursor's
//                    {followup_message} self-correction channel (snake_case).
//   state-transition-guard → beforeShellExecution returns
//                    {"permission":"deny", user_message, agent_message} with
//                    EXIT 0 when the core guard exits 2 (the failClosed gate's
//                    JSON-block translation); a safe command allows silently.
//                    [TC-SEC-010 / TC-SEC-011]
//   audit-and-sensors → afterFileEdit {file_path} maps to PostToolUse Write and
//                    lands ARTIFACT_CREATED in the audit.
//   fail-open      → malformed / truncated stdin exits 0 with NO output on every
//                    target (advisory + the adapter's own parse floor —
//                    Cursor's failClosed:true is the floor for a genuine adapter
//                    CRASH, never a clean parse miss). [TC-SEC-012]
//   process.execPath → the shipped adapter respawns children via the running
//                    interpreter, never a bare "bun" argv[0]. [TC-SEC-016]
// The deny/followup/audit outputs are asserted to use snake_case field names
// (camelCase is silently ignored by Cursor — a load-bearing contract).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as kiro's t147 and codex's t149.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CURSOR_TREE = join(REPO_ROOT, "dist", "cursor", ".cursor");
const FIXTURES = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "cursor-hook-payloads", "payloads.json"),
    "utf-8",
  ),
) as Record<string, Record<string, unknown>>;

// P9 per-intent layout: the CORE hooks the Cursor adapter shims to (session-start,
// stop, state-transition-guard, audit-logger, log-subagent) resolve state via
// stateFilePath() and the audit trail via auditFilePath() — under the active
// intent's record. So the scratch project seeds the per-intent shell + the state
// fixture into the default record (so the cursor resolves) + the resolved audit
// SHARD (pinned clone-id so the log-subagent / audit-logger shard gate passes and
// reads are deterministic).
const PINNED_CLONE_ID = "testcloneid249";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

/** Seed the per-intent workspace shell into an arbitrary dir (mirrors
 *  fixtures.ts seedWorkspaceShell). */
function seedShell(dir: string): void {
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [
        {
          uuid: "00000000-0000-7000-8000-000000000001",
          slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
          status: "in-flight",
        },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

// Scratch project: a .cursor tree (copied) + the per-intent workspace shell with
// an active workflow state so the core hooks' self-gates open. Built per test.
function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t249-"));
  cpSync(CURSOR_TREE, join(dir, ".cursor"), { recursive: true });
  seedShell(dir);
  if (withState) {
    // State fixture into the default record so the active-intent cursor resolves.
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    // The resolved audit shard (pinned clone-id) so the log-subagent / audit-logger
    // shard gate passes and the trail seeds the "# AI-DLC Audit Log" header.
    writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
    const auditDir = seededAuditDir(dir);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, pinnedShardName()), "# AI-DLC Audit Log\n");
  }
  return dir;
}

/** Concatenate every audit shard (clone-id-name-agnostic read). */
function readAudit(dir: string): string {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

// The adapter resolves its project dir from AIDLC_PROJECT_DIR first (before
// cursor.cwd), so pinning it to the scratch dir points every shimmed core hook
// at the seeded per-intent workspace regardless of the fixture's placeholder cwd.
function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
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
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

describe("t249 Cursor hook adapter (documented-schema payload fixtures)", () => {
  test("1: beforeSubmitPrompt emits plain-text context, not the JSON wrapper", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", FIXTURES.beforeSubmitPrompt);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      // The shim unwraps {additionalContext} → plain stdout (Cursor's
      // beforeSubmitPrompt context channel is plain text at exit 0).
      expect(r.stdout).not.toContain("additionalContext");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: session-start fires only on the FIRST prompt of a conversation_id [TC-SEC-015]", () => {
    // beforeSubmitPrompt fires on EVERY prompt; the marker file under aidlc/
    // (keyed by conversation_id) gates the core SessionStart to the first fire.
    // Same scratch dir reused so the marker persists across the two calls.
    const dir = scratchProject(true);
    try {
      const first = runAdapter(dir, "session-start", FIXTURES.beforeSubmitPrompt);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      // The marker was recorded for this conversation_id.
      const marker = join(dir, "aidlc", ".aidlc-cursor-sessions");
      expect(existsSync(marker)).toBe(true);
      expect(readdirSync(marker).length).toBe(1);

      // Second prompt, SAME conversation_id → no second SessionStart fire.
      const second = runAdapter(dir, "session-start", FIXTURES.beforeSubmitPrompt);
      expect(second.code).toBe(0);
      expect(second.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: stop maps core decision:block → {followup_message} (snake_case)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { followup_message?: string };
      expect(out.followup_message ?? "").not.toBe("");
      // snake_case is load-bearing — camelCase is silently ignored by Cursor.
      expect(r.stdout).toContain("followup_message");
      expect(r.stdout).not.toContain("followupMessage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: stop is silent (no followup) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: beforeShellExecution → permission:deny + exit 0 when the core guard exits 2 [TC-SEC-010]", () => {
    // The failClosed gate's JSON-block translation: the core state-transition
    // guard exits 2 + stderr on a blocked lifecycle verb; the adapter maps that
    // to Cursor's {permission:"deny", user_message, agent_message} on stdout at
    // EXIT 0 (Cursor blocks on the JSON, not a non-zero exit).
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", FIXTURES.beforeShellExecution);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        permission?: string;
        user_message?: string;
        agent_message?: string;
      };
      expect(out.permission).toBe("deny");
      expect(out.user_message ?? "").not.toBe("");
      expect(out.agent_message ?? "").not.toBe("");
      // The deny reason names the engine-owned path the guard redirects to.
      expect(out.user_message).toContain("aidlc-orchestrate.ts report");
      // snake_case field names (camelCase is silently ignored by Cursor).
      expect(r.stdout).toContain("user_message");
      expect(r.stdout).toContain("agent_message");
      expect(r.stdout).not.toContain("userMessage");
      expect(r.stdout).not.toContain("agentMessage");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: beforeShellExecution → allow (exit 0, no output) for a safe command [TC-SEC-011]", () => {
    // Regression: a command the guard does not block passes through as a clean
    // allow — exit 0, no deny JSON (Cursor treats no output as permit).
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", FIXTURES.beforeShellExecution_safe);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: afterFileEdit maps to PostToolUse Write and lands ARTIFACT_CREATED in the audit", () => {
    // The adapter maps afterFileEdit {file_path} → PostToolUse Write and forwards
    // it to the core audit-logger, which logs a write ONLY when the path is under
    // the active intent's record root (docsRoot()). A real post-P9 Cursor edit
    // emits the per-intent record path, so we point the fixture's file_path at a
    // file under the seeded record (the workspace analog of a raw capture).
    const dir = scratchProject(true);
    try {
      const filePath = join(
        seededRecordDir(dir),
        "ideation",
        "intent-capture",
        "intent-statement.md",
      );
      const r = runAdapter(dir, "audit-and-sensors", {
        ...FIXTURES.afterFileEdit,
        file_path: filePath,
      });
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_");
      expect(audit).toContain("intent-capture");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: afterFileEdit outside the record root is a clean audit no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "audit-and-sensors", {
        ...FIXTURES.afterFileEdit,
        file_path: join(dir, "src", "unrelated.ts"),
      });
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).not.toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: subagentStop emits SUBAGENT_COMPLETED to the audit", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", FIXTURES.subagentStop);
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-developer-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: malformed / truncated stdin fails open (exit 0, no output) on every target [TC-SEC-012]", () => {
    // The adapter's parse floor: any stdin JSON.parse failure exits 0 with empty
    // stdout on EVERY target — even the failClosed gates (Cursor's failClosed:true
    // is the floor for a genuine adapter CRASH, never a clean parse miss). Both a
    // non-JSON string and a truncated JSON object exercise the catch.
    const dir = scratchProject(true);
    try {
      for (const target of [
        "session-start",
        "stop",
        "state-transition-guard",
        "reviewer-scope",
        "audit-and-sensors",
        "log-subagent",
        "validate-state",
      ]) {
        for (const bad of ['{not json', '{"hook_event_name":"stop"']) {
          const r = runAdapter(dir, target, bad);
          expect(`${target}:${r.code}`).toBe(`${target}:0`);
          expect(`${target}:${r.stdout.trim()}`).toBe(`${target}:`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: shipped cursor adapter source respawns via process.execPath, never a bare 'bun' argv[0] [TC-SEC-016]", () => {
    // Source pin (matches the kiro/codex adapter suites' grep-pin style). A stale
    // regeneration or a hand-edit reintroducing a bare-name respawn reds here.
    const src = readFileSync(
      join(REPO_ROOT, "dist", "cursor", ".cursor", "hooks", "aidlc-cursor-adapter.ts"),
      "utf-8",
    );
    expect(/spawnSync\(\s*\[\s*"bun"/.test(src)).toBe(false);
    expect(/spawn\(\s*"bun"/.test(src)).toBe(false);
    expect(src).toContain("process.execPath");
  });
});

// t222-cursor-hook-adapter: the Cursor stdin shim normalizes docs-derived
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-stop.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-log-subagent.ts
//
// WHAT. Each case pipes a fixture from tests/fixtures/cursor-hook-payloads/
// (DOCS-DERIVED shapes off the official Cursor hooks reference, 2026-07 —
// see the corpus __provenance__ note; replace with live captures when a
// Cursor validation spike runs) into
// `bun dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts <target>` inside a
// scratch project that has an active workflow state, then asserts the
// observable core-hook effect THROUGH the Cursor answer shapes:
//   stop          → {"followup_message"} when the engine says work remains
//                   (the core {"decision":"block"} TRANSLATED — Cursor's stop
//                   cannot hard-block), always carrying FOLLOWUP_MARKER so
//                   the mint target can recognize the auto-submitted machine
//                   turn; "{}" when no workflow state exists; "{}" on
//                   status:"aborted" even with pending work (never fight the
//                   user's abort).
//   session-start → {"additional_context"} (the core {"additionalContext"}
//                   RE-KEYED for Cursor's snake_case output contract).
//   audit/sensors → ARTIFACT_* audit row lands from an afterFileEdit payload.
//   log-subagent  → SUBAGENT_COMPLETED row with the subagent_type.
//   mint          → HUMAN_TURN row (state-gated, like Claude's registration);
//                   NEVER for a FOLLOWUP_MARKER-prefixed prompt (the stop
//                   hook's own auto-submitted nudge must not mint presence —
//                   the human-presence gate exists to refuse fabricated
//                   approvals).
//   every target  → fail-open exit 0 + "{}" on malformed stdin AND on
//                   valid-JSON-scalar stdin like `null` (advisory contract
//                   G5), and a well-formed "{}" for no-op payloads.
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.

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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INTENT_UUID,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURE_CLONE_ID,
  intentsDirOf,
  seededAuditDir,
  seededAuditShard,
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
) as Record<string, unknown>;

// The stop-followup lead-in the adapter prefixes onto every followup_message
// and the mint target refuses to mint HUMAN_TURN for. Keep the literal in
// sync with FOLLOWUP_MARKER in harness/cursor/hooks/aidlc-cursor-adapter.ts.
const FOLLOWUP_MARKER = "[AIDLC stop-hook nudge]";

/** Seed the per-intent workspace shell (active-space + intents/<record> + cursors
 *  + registry) into an arbitrary dir. Mirrors fixtures.ts seedWorkspaceShell. */
function seedShell(dir: string): void {
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: DEFAULT_INTENT_UUID, slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

// Scratch project: a .cursor tree (copied) + the per-intent workspace shell with
// an active workflow state so the core hooks' self-gates open. Built per test.
// The clone-id pin uses the shared FIXTURE_CLONE_ID so seededAuditShard() (the
// exported helper that mirrors aidlc-lib's auditShardName) names the same shard
// the spawned hooks resolve.
function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t222-"));
  cpSync(CURSOR_TREE, join(dir, ".cursor"), { recursive: true });
  seedShell(dir);
  if (withState) {
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${FIXTURE_CLONE_ID}\n`, "utf-8");
    mkdirSync(seededAuditDir(dir), { recursive: true });
    writeFileSync(seededAuditShard(dir), "# AI-DLC Audit Log\n");
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

/** Pipe a fixture into the shipped adapter. `<PROJECT_DIR>` placeholders in the
 *  fixture (the docs-derived workspace_roots / file_path values) are substituted
 *  with the scratch dir so the adapter's payload-carried project-dir rung is
 *  exercised, not just the CLAUDE_PROJECT_DIR env fallback. */
function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; code: number } {
  const input =
    typeof payload === "string"
      ? payload
      : JSON.stringify(payload).replaceAll("<PROJECT_DIR>", projectDir);
  const r = spawnSync(
    "bun",
    [join(projectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: projectDir,
      input,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

describe("t222 Cursor hook adapter (docs-derived payload fixtures)", () => {
  test("1: stop answers a marker-prefixed followup_message (the translated block) while work remains", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { followup_message?: string; decision?: string };
      // The Cursor answer shape — never the raw core {"decision":"block"} —
      // and the machine-turn marker the mint target keys on.
      expect(out.decision).toBeUndefined();
      expect(out.followup_message ?? "").toStartWith(FOLLOWUP_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: stop answers {} when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: stop answers {} on status:aborted even with pending work (never fight an abort)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "stop", FIXTURES["stop-aborted"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: session-start re-keys the core context to {additional_context}", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", FIXTURES["session-start"]);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { additional_context?: string; additionalContext?: string };
      // Cursor's snake_case key, never the Claude camelCase one.
      expect(out.additionalContext).toBeUndefined();
      expect(out.additional_context ?? "").not.toBe("");
      // The session→intent stamp landed (conversation_id forwarded as session_id).
      expect(existsSync(join(dir, "aidlc", ".aidlc-sessions"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: afterFileEdit lands an ARTIFACT audit row via audit-and-sensors", () => {
    const dir = scratchProject(true);
    try {
      // Target a real artifact under the seeded record dir so the
      // audit-logger's existence probe classifies created-vs-updated cleanly.
      const artifact = join(
        seededRecordDir(dir),
        "ideation",
        "intent-capture",
        "requirements.md",
      );
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, "# Requirements\n", "utf-8");
      const payload = {
        ...(FIXTURES["audit-and-sensors"] as Record<string, unknown>),
        file_path: artifact,
      };
      const r = runAdapter(dir, "audit-and-sensors", payload);
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: subagentStop lands SUBAGENT_COMPLETED with the subagent_type", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", FIXTURES["log-subagent"]);
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-architecture-reviewer-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: beforeSubmitPrompt mints HUMAN_TURN when a workflow is active", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "mint", FIXTURES.mint);
      expect(r.code).toBe(0);
      expect(readAudit(dir)).toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: beforeSubmitPrompt is a no-op without workflow state (no audit scaffolding)", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "mint", FIXTURES.mint);
      expect(r.code).toBe(0);
      expect(readAudit(dir)).not.toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: a marker-prefixed prompt (the stop hook's auto-submitted nudge) never mints HUMAN_TURN", () => {
    // The anti-autopilot property: Cursor auto-submits our stop-followup as a
    // user message, and if beforeSubmitPrompt fires for it, minting would let
    // a machine turn satisfy the human-presence gate. The marker is the seam.
    const dir = scratchProject(true);
    try {
      const payload = {
        ...(FIXTURES.mint as Record<string, unknown>),
        prompt: `${FOLLOWUP_MARKER} The AIDLC workflow has a pending step — finish the report round-trip.`,
      };
      const r = runAdapter(dir, "mint", payload);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({});
      expect(readAudit(dir)).not.toContain("HUMAN_TURN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: shell-sync + runtime-compile + state-sync + validate-state + session-end all exit 0 on fixtures (advisory)", () => {
    const dir = scratchProject(true);
    try {
      for (const target of [
        "shell-sync",
        "runtime-compile",
        "state-sync",
        "validate-state",
        "session-end",
      ]) {
        // shell-sync reuses the runtime-compile fixture (same afterShellExecution event).
        const fixture = FIXTURES[target === "shell-sync" ? "runtime-compile" : target];
        const r = runAdapter(dir, target, fixture);
        expect({ target, code: r.code }).toEqual({ target, code: 0 });
        // Every advisory answer is a well-formed JSON object for Cursor's
        // "exit 0 = use JSON output" arm.
        expect(() => JSON.parse(r.stdout)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: malformed stdin AND valid-JSON-scalar stdin fail open (exit 0) on EVERY target", () => {
    const dir = scratchProject(true);
    try {
      for (const target of [
        "session-start",
        "session-end",
        "mint",
        "audit-and-sensors",
        "shell-sync",
        "runtime-compile",
        "state-sync",
        "log-subagent",
        "validate-state",
        "stop",
        "not-a-target",
      ]) {
        for (const input of ["{not json", "null", "[1,2]", '"x"']) {
          const r = runAdapter(dir, target, input);
          expect({ target, input, code: r.code }).toEqual({ target, input, code: 0 });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("12: the shipped hooks.json wires every adapter target it names to a real file", () => {
    const wiring = JSON.parse(
      readFileSync(join(CURSOR_TREE, "hooks.json"), "utf-8"),
    ) as { version: number; hooks: Record<string, Array<{ command: string }>> };
    expect(wiring.version).toBe(1);
    const commands = Object.values(wiring.hooks).flat().map((h) => h.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c).toMatch(/^bun \.cursor\/hooks\/aidlc-cursor-adapter\.ts [a-z-]+$/);
    }
    // The shell hot path fans in through ONE adapter process (shell-sync),
    // never two separate registrations.
    expect(wiring.hooks.afterShellExecution?.map((h) => h.command)).toEqual([
      "bun .cursor/hooks/aidlc-cursor-adapter.ts shell-sync",
    ]);
    // The stop entry carries the loop cap ABOVE the core hook's autonomous
    // ceiling (8), so the core caps govern before the harness cap bites.
    const stopEntry = (wiring.hooks.stop ?? [])[0] as { loop_limit?: number } | undefined;
    expect((stopEntry?.loop_limit ?? 0) > 8).toBe(true);
  });
});

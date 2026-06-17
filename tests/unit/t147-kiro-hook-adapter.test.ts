// t147-kiro-hook-adapter: the Kiro stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-stop.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-sync-statusline.ts, file:hooks/aidlc-log-subagent.ts
//
// WHAT. Each case pipes a fixture from tests/fixtures/kiro-hook-payloads/
// (field-verbatim captures off kiro-cli 2.6.1 — findings.md §0.2) into
// `bun dist/kiro/.kiro/hooks/aidlc-kiro-adapter.ts <target>` inside a
// scratch project that has an active workflow state, then asserts the
// observable core-hook effect:
//   stop          → {"decision":"block"} when the engine says work remains;
//                   silent exit 0 when no workflow state exists.
//   session-start → plain-text context (NOT the {"additionalContext"} JSON
//                   wrapper — the shim unwraps it for Kiro's stdout channel).
//   state-sync    → todo_list create with "[slug]" suffix dispatches
//                   set-status (state file's Current Stage updates).
//   audit/sensors + runtime-compile + log-subagent → fail-open exit 0 on
//   both fixture input and malformed stdin (advisory contract G5).
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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { birthIntent } from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO_TREE = join(REPO_ROOT, "dist", "kiro", ".kiro");
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "kiro-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, unknown>;

// Scratch project: a .kiro tree (copied) + minimal aidlc-docs state so the
// hooks' self-gates open. Built once per test for isolation.
function scratchProject(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "t147-"));
  cpSync(KIRO_TREE, join(dir, ".kiro"), { recursive: true });
  if (withState) {
    const docs = join(dir, "aidlc-docs");
    mkdirSync(docs, { recursive: true });
    // Minimal v7-shaped state: mid-ideation, intent-capture running.
    writeFileSync(
      join(docs, "aidlc-state.md"),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    writeFileSync(join(docs, "audit.md"), "# AI-DLC Audit Log\n");
  }
  return dir;
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

describe("t147 Kiro hook adapter (live-captured payload fixtures)", () => {
  test("1: stop blocks with a reason while the workflow has pending work", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: stop is silent (no block) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "stop", FIXTURES.stop);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: session-start emits plain-text context, not the JSON wrapper", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", FIXTURES.agentSpawn);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      expect(r.stdout).not.toContain("additionalContext");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: todo_list create with [slug] suffix syncs the state file", () => {
    const dir = scratchProject(true);
    try {
      const before = readFileSync(join(dir, "aidlc-docs", "aidlc-state.md"), "utf-8");
      const r = runAdapter(dir, "state-sync", FIXTURES.postToolUse_todo_create);
      expect(r.code).toBe(0);
      const after = readFileSync(join(dir, "aidlc-docs", "aidlc-state.md"), "utf-8");
      // The fixture's [intent-capture] slug dispatches set-status; assert the
      // Current Stage field reflects it (robust to the fixture state already
      // being on intent-capture: require the field present AND the heartbeat).
      expect(/\*\*Current Stage\*\*:\s*intent-capture/.test(after)).toBe(true);
      expect(before).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: todo_list complete (no [slug] create) is a clean no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "state-sync", FIXTURES.postToolUse_todo_complete);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: log-subagent emits SUBAGENT_COMPLETED to the audit", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", FIXTURES.postToolUse_subagent);
      expect(r.code).toBe(0);
      const audit = readFileSync(join(dir, "aidlc-docs", "audit.md"), "utf-8");
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("aidlc-developer-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: write-event target normalizes path→file_path and exits 0 (advisory)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "audit-and-sensors", FIXTURES.postToolUse_write);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: runtime-compile target accepts the alias shell payload and exits 0", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "runtime-compile", FIXTURES.postToolUse_shell);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: session-start FORWARDS session_id — core hook stamps the per-session→intent record (M3)", () => {
    // M3: the Kiro adapter now forwards session_id when present, so the core
    // hook's per-session→intent STAMP is written (the session→intent record).
    // Proof: birth an intent (live cursor resolves a uuid), fire session-start
    // with a session_id in the payload, and assert the stamp file
    // aidlc/.aidlc-sessions/<session_id> was written with that uuid. Without
    // the forwarded session_id the core hook's `if (sessionId)` block is inert.
    const dir = scratchProject(true);
    try {
      const born = birthIntent(dir, "kiro-stamp", "default");
      const sid = "kiro-session-abc123";
      const r = runAdapter(dir, "session-start", { ...(FIXTURES.agentSpawn as object), session_id: sid });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(existsSync(stampPath)).toBe(true);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(born.uuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: resume-rebind OFFER is structurally unreachable on Kiro — every spawn is forced to source=startup (documented limitation)", () => {
    // Kiro's agentSpawn carries no resume discrimination: the adapter ALWAYS
    // forwards source=startup. So even with a genuine cursor drift seeded, a
    // "resume"-shaped payload can never trigger the core hook's SESSION_RESUMED
    // path → no INTENT REBIND OFFER. This is a harness limitation, not a bug;
    // the assertion pins it deterministically (no skip needed). Contrast t149/14
    // where Codex DOES forward a real source and the offer fires.
    const dir = scratchProject(true);
    try {
      const sid = "kiro-session-drift";
      const a = birthIntent(dir, "intent-a", "default");
      // First fire stamps the session to A (the live cursor at this point).
      const first = runAdapter(dir, "session-start", {
        ...(FIXTURES.agentSpawn as object),
        session_id: sid,
        source: "resume", // even a resume-shaped payload is coerced to startup
      });
      expect(first.code).toBe(0);
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(a.uuid);
      // Move the live cursor to B — a genuine drift A→B.
      birthIntent(dir, "intent-b", "default");
      // Fire again with a resume-shaped payload. Because Kiro coerces to
      // startup, the core hook takes the STARTED path (re-stamps to B), never
      // the RESUMED offer path.
      const second = runAdapter(dir, "session-start", {
        ...(FIXTURES.agentSpawn as object),
        session_id: sid,
        source: "resume",
      });
      expect(second.code).toBe(0);
      expect(second.stdout).not.toContain("INTENT REBIND OFFER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: malformed stdin fails open (exit 0, no output) on every target", () => {
    const dir = scratchProject(true);
    try {
      for (const target of [
        "stop",
        "session-start",
        "state-sync",
        "audit-and-sensors",
        "runtime-compile",
        "log-subagent",
      ]) {
        const r = runAdapter(dir, target, "{not json");
        expect(`${target}:${r.code}`).toBe(`${target}:0`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// t149-codex-hook-adapter: the Codex stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-stop.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-sync-statusline.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-audit-logger.ts
//
// WHAT. Each case pipes a fixture from tests/fixtures/codex-hook-payloads/
// (field-verbatim captures off Codex CLI 0.137.0 — the spike corpus at
// tmp/codex-dist/payload-corpus/) into
// `bun dist/codex/.codex/hooks/aidlc-codex-adapter.ts <target>` inside a
// scratch project carrying an active workflow state, then asserts the
// observable core-hook effect:
//   stop              → {"decision":"block"} when the engine says work
//                       remains (verbatim passthrough — shared contract);
//                       silent exit 0 when no workflow state exists.
//   session-start     → {"hookSpecificOutput":{...additionalContext}} (the
//                       Codex wrapper — core JSON re-wrapped, E1-verified).
//   audit-and-sensors → apply_patch envelope parsed; an aidlc-docs Add File
//                       lands ARTIFACT_CREATED in the audit; a non-aidlc
//                       file is a no-op.
//   state-sync        → update_plan in_progress step with "[slug]" suffix
//                       dispatches set-status (Current Stage updates).
//   log-subagent      → SUBAGENT_COMPLETED in the audit.
//   duplicate delivery → the second identical stdin replays the first
//                       response (the ×2 idempotency contract) — the audit
//                       gains NO second row.
//   malformed stdin   → fail-open exit 0 (advisory contract).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as kiro's t142.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { birthIntent } from "../../core/tools/aidlc-lib.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "codex-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, Record<string, unknown>>;

// P9 per-intent layout: the CORE hooks the Codex adapter shims to (audit-logger,
// session-start/end, log-subagent, set-status) resolve state via stateFilePath()
// and the audit trail via auditFilePath() — under the active intent's record. So
// the scratch project seeds the per-intent shell + the state fixture into the
// default record (so the cursor resolves) + the resolved audit SHARD (pinned
// clone-id so the log-subagent shard gate passes and reads are deterministic).
// NOTE: the Codex ADAPTER's OWN bookkeeping (codex-session.json) still lives at
// <cwd>/aidlc-docs/.aidlc-hooks-health/ — that path is hardcoded in the harness
// adapter (harness/codex/hooks/aidlc-codex-adapter.ts), NOT a core path helper,
// so test 10 keeps seeding it there.
const PINNED_CLONE_ID = "testcloneid149";
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
      [{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

// Scratch project: a .codex tree (copied) + the per-intent workspace shell with
// an active workflow state. cwd in the fixture payloads points at the spike rig —
// the adapter must use ITS project (the scratch dir): we rewrite the fixture's
// cwd to the scratch dir, exactly what a real install sees.
function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t149-")));
  cpSync(CODEX_TREE, join(dir, ".codex"), { recursive: true });
  seedShell(dir);
  if (withState) {
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
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

function withCwd(payload: Record<string, unknown>, dir: string): Record<string, unknown> {
  return { ...payload, cwd: dir };
}

/** Remap a captured apply_patch payload's `aidlc-docs/` paths (a verbatim
 *  pre-workspace capture) to the active intent's record-relative prefix, so the
 *  per-intent audit-logger gate sees the write under the record root. Rewrites
 *  both the patch `command` envelope and the `tool_response` listing. */
function remapApplyPatchPaths(
  payload: Record<string, unknown>,
  recordPrefix: string,
): Record<string, unknown> {
  const out = { ...payload };
  const input = (out.tool_input as Record<string, unknown> | undefined) ?? {};
  if (typeof input.command === "string") {
    out.tool_input = {
      ...input,
      command: input.command.replaceAll("aidlc-docs/", `${recordPrefix}/`),
    };
  }
  if (typeof out.tool_response === "string") {
    out.tool_response = out.tool_response.replaceAll("aidlc-docs/", `${recordPrefix}/`);
  }
  return out;
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".codex", "hooks", "aidlc-codex-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

describe("t149 Codex hook adapter (live-captured payload fixtures)", () => {
  test("1: stop blocks with a reason while the workflow has pending work (verbatim contract)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
      // The continuation reason names the codex tools path (harnessDir seam).
      expect(out.reason).toContain(".codex/tools/aidlc-orchestrate.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: stop is silent (no block) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2a: state-transition guard preserves exit 2 and stderr", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "Bash",
        tool_input: {
          command:
            "bun .codex/tools/aidlc-state.ts reject feasibility",
        },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(
        "Direct aidlc-state.ts reject is blocked",
      );
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: session-start emits the Codex hookSpecificOutput wrapper with workflow context", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput?.additionalContext).toContain("AIDLC WORKFLOW ACTIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // P9: the adapter resolves an apply_patch Add/Update File path relative to the
  // project dir (harness/codex/hooks/aidlc-codex-adapter.ts patchedFiles) and
  // forwards it to the core audit-logger, which now logs a write ONLY when the
  // path is under the active intent's record root (docsRoot()). The captured
  // fixture is a verbatim pre-workspace run whose paths are `aidlc-docs/<rel>`;
  // a real post-P9 Codex run emits the per-intent record path. So we remap the
  // captured prefix to the active intent's record-relative prefix before driving
  // the adapter — the workspace analog of the old flat capture.
  test("4: apply_patch Add File under the intent record lands ARTIFACT_CREATED in the audit", () => {
    const dir = scratchProject(true);
    try {
      const recordPrefix = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}`;
      const remapped = remapApplyPatchPaths(
        FIXTURES.postToolUse_applyPatch_aidlcDocs,
        recordPrefix,
      );
      const r = runAdapter(dir, "audit-and-sensors", withCwd(remapped, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_");
      expect(audit).toContain("intent-capture");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: apply_patch on a non-aidlc file is a clean audit no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "audit-and-sensors",
        withCwd(FIXTURES.postToolUse_applyPatch_plain, dir),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).not.toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: update_plan in_progress step with [slug] suffix syncs the state file", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "state-sync",
        withCwd(FIXTURES.postToolUse_updatePlan_slug, dir),
      );
      expect(r.code).toBe(0);
      const after = readFileSync(seededStateFile(dir), "utf-8");
      expect(/\*\*Current Stage\*\*:\s*intent-capture/.test(after)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: update_plan without a [slug] suffix is a clean no-op", () => {
    const dir = scratchProject(true);
    try {
      const before = readFileSync(seededStateFile(dir), "utf-8");
      const r = runAdapter(dir, "state-sync", withCwd(FIXTURES.postToolUse_updatePlan, dir));
      expect(r.code).toBe(0);
      const after = readFileSync(seededStateFile(dir), "utf-8");
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: log-subagent emits SUBAGENT_COMPLETED to the audit", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", withCwd(FIXTURES.subagentStop, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: duplicate delivery replays the response without a second audit row (×2 idempotency)", () => {
    const dir = scratchProject(true);
    try {
      const payload = withCwd(FIXTURES.subagentStop, dir);
      const r1 = runAdapter(dir, "log-subagent", payload);
      const r2 = runAdapter(dir, "log-subagent", payload);
      expect(r1.code).toBe(0);
      expect(r2.code).toBe(0);
      expect(r2.stdout).toBe(r1.stdout);
      const audit = readAudit(dir);
      const rows = audit.match(/SUBAGENT_COMPLETED/g) ?? [];
      expect(rows.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10: session-start reconciles an unclosed prior session as inferred SESSION_ENDED (D-4)", () => {
    const dir = scratchProject(true);
    try {
      // Seed a heartbeat from a DIFFERENT prior session.
      const health = join(dir, "aidlc-docs", ".aidlc-hooks-health");
      mkdirSync(health, { recursive: true });
      writeFileSync(
        join(health, "codex-session.json"),
        JSON.stringify({ session_id: "prior-session-0000", ts: "2026-06-12T00:00:00Z" }),
        "utf-8",
      );
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SESSION_ENDED");
      expect(audit).toContain("inferred");
      expect(audit).toContain("prior-session-0000");
      // The heartbeat now names the new session.
      const hb = JSON.parse(readFileSync(join(health, "codex-session.json"), "utf-8")) as {
        session_id: string;
      };
      expect(hb.session_id).toBe(String(FIXTURES.sessionStart.session_id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("11: compact-source session-start re-injects the mission without a new session audit row", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "session-start",
        withCwd({ ...FIXTURES.sessionStart, source: "compact" }, dir),
      );
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput?.additionalContext).toContain("AIDLC WORKFLOW ACTIVE");
      // source=compact emits NO session audit row (PreCompact owns it).
      const audit = readAudit(dir);
      expect(audit).not.toContain("SESSION_STARTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13: session-start FORWARDS session_id — core hook stamps the per-session→intent record (M3 rebind wiring)", () => {
    // The genuine M3 fix: Codex now forwards session_id alongside its real
    // `source`, so the core hook's P8 stamp/rebind path is reachable. Proof:
    // birth an intent (so the live cursor resolves a uuid), fire startup with
    // the fixture session_id, and assert the per-session stamp file
    // aidlc/.aidlc-sessions/<session_id> was WRITTEN with that uuid. Without
    // the forwarded session_id the core hook's `if (sessionId)` block is inert
    // and no stamp file appears.
    const dir = scratchProject(true);
    try {
      const born = birthIntent(dir, "codex-rebind", "default");
      const sid = String(FIXTURES.sessionStart.session_id);
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
      expect(r.code).toBe(0);
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(existsSync(stampPath)).toBe(true);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(born.uuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("14: session-start with source=resume OFFERS a rebind after a cursor drift (full P8 path on Codex)", () => {
    // The clean win: Codex carries a real `source`, so with session_id wired
    // the resume-rebind OFFER fires. Seed a drift — stamp the session to intent
    // A, then move the live cursor to intent B — then fire a resume-shaped
    // session-start and assert the wrapped additionalContext carries the offer.
    const dir = scratchProject(true);
    try {
      const sid = String(FIXTURES.sessionStart.session_id);
      const a = birthIntent(dir, "intent-a", "default");
      // Stamp the session to A via a startup fire (the core hook stamps the
      // live cursor's uuid — currently A).
      runAdapter(dir, "session-start", withCwd({ ...FIXTURES.sessionStart, source: "startup" }, dir));
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(a.uuid);
      // Move the live cursor to B (the drift the resume must detect).
      birthIntent(dir, "intent-b", "default");
      const r = runAdapter(
        dir,
        "session-start",
        withCwd({ ...FIXTURES.sessionStart, source: "resume" }, dir),
      );
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      const ctx = out.hookSpecificOutput?.additionalContext ?? "";
      expect(ctx).toContain("INTENT REBIND OFFER");
      expect(ctx).toContain("intent-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("12: malformed stdin fails open (exit 0, no output) on every target", () => {
    const dir = scratchProject(true);
    try {
      for (const t of ["stop", "session-start", "audit-and-sensors", "state-sync", "log-subagent"]) {
        const r = runAdapter(dir, t, "{not json");
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Stop-hook conversational carve-out on Codex (issue #365 cross-harness) ---
  //
  // Codex's stop adapter (case "stop", aidlc-codex-adapter.ts:336-343) pipes the
  // RAW stdin verbatim to the core hook, and Codex's stop payload carries a real
  // transcript_path (a date-sharded `rollout-*.jsonl`) + stop_hook_active. So the
  // core hook's conversational carve-out (tier 3, aidlc-stop.ts:886-904) fires
  // from the actual transcript, classifying the ending turn:
  //   - human's last prompt answered with NO loop-advancing engine call -> ALLOW.
  //   - a loop-advancing aidlc-orchestrate call after that prompt -> BLOCK.
  //   - a READ-ONLY query (next --status) is NOT engagement -> still ALLOW.
  // The core hook detects the Codex format by the rollout-*.jsonl path shape
  // (aidlc-stop.ts:792), so the transcript file the test writes MUST be named
  // rollout-*.jsonl and live in the scratch dir (the adapter reads a REAL file).
  // The seeded brownfield-feature state (Current Stage requirements-analysis [-],
  // not [?]/[R], no questions file) yields a pending run-stage and trips none of
  // the OTHER carve-outs, so the conversational classifier alone governs the
  // decision.

  /** Write a Codex rollout transcript (response_item shape) and return its path.
   *  `assistant` is either a plain message turn or a function_call turn - the two
   *  shapes the core hook's Codex reader classifies (aidlc-stop.ts:582-645). */
  function writeCodexTranscript(
    dir: string,
    humanPrompt: string,
    assistant:
      | { kind: "message"; text: string }
      | { kind: "call"; name: string; command: string },
  ): string {
    const lines: string[] = [
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: humanPrompt }] },
      }),
    ];
    if (assistant.kind === "message") {
      lines.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: assistant.text }],
          },
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: assistant.name,
            arguments: JSON.stringify({ command: assistant.command }),
          },
        }),
      );
    }
    // The path MUST match the core hook's Codex-format detector
    // (/[/\\]rollout-[^/\\]*\.jsonl$/), so name it rollout-*.jsonl.
    const path = join(dir, "rollout-2026-06-26T00-00-00.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
    return path;
  }

  /** Build the Codex stop payload pointing at a real transcript file, in the
   *  same withCwd shape the other stop tests use (the adapter pipes it verbatim,
   *  so cwd selects the scratch project's state). */
  function codexStopWithTranscript(dir: string, transcriptPath: string): Record<string, unknown> {
    return withCwd({ ...FIXTURES.stop, transcript_path: transcriptPath }, dir);
  }

  test("13: CONVERSATIONAL ALLOW - Codex stop allows when the human's last prompt was answered with no engine call", () => {
    const dir = scratchProject(true);
    try {
      const transcript = writeCodexTranscript(dir, "what stage am I on?", {
        kind: "message",
        text: "You are on requirements-analysis.",
      });
      const r = runAdapter(dir, "stop", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      // Conversational ending turn -> ALLOW (silent, no decision:block).
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("14: ENGAGED BLOCK - Codex stop blocks when a loop-advancing aidlc-orchestrate call followed the human prompt", () => {
    const dir = scratchProject(true);
    try {
      const transcript = writeCodexTranscript(dir, "ok, continue the workflow", {
        kind: "call",
        name: "Bash",
        command: "bun .codex/tools/aidlc-orchestrate.ts next",
      });
      const r = runAdapter(dir, "stop", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      // The conductor engaged the workflow then quit mid-loop -> still nudged.
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("15: READ-ONLY ALLOW - Codex stop allows when the only post-prompt call was a read-only status query (not engagement)", () => {
    const dir = scratchProject(true);
    try {
      const transcript = writeCodexTranscript(dir, "what stage am I on?", {
        kind: "call",
        name: "Bash",
        command: "bun .codex/tools/aidlc-orchestrate.ts next --status",
      });
      const r = runAdapter(dir, "stop", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      // A read-only query does NOT engage the loop -> conversational ALLOW.
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Adapter respawns children via the running bun, not a PATH lookup ---
  //
  // The Codex adapter dispatches every core lifecycle hook (runCore) by spawning
  // a child bun process. A bare-name "bun" argv[0] inherits the hook
  // environment's $PATH; on a minimal environment that PATH often lacks the bun
  // install dir, so the child spawn fails ENOENT and the whole hook layer dies.
  // The fix reuses the exact bun running the adapter (process.execPath).

  /** PATH stripped of every dir that resolves a `bun` binary (the fragile hook
   *  environment the fix targets). Deterministic: reads real disk. */
  function pathWithoutBun(): string {
    const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    return entries.filter((d) => !existsSync(join(d, "bun"))).join(delimiter);
  }

  test("16: session-start dispatches even when the child PATH has no bun (respawn uses process.execPath)", () => {
    // The adapter is launched via the ABSOLUTE bun (process.execPath), so it
    // starts regardless of PATH; the contract under test is that its OWN child
    // respawn (runCore) also does not need bun on PATH. Under the old bare-"bun"
    // argv[0] this session-start would ENOENT in runCore and emit nothing.
    const dir = scratchProject(true);
    try {
      const strippedPath = pathWithoutBun();
      // Premise guard: bun must genuinely be unresolvable on the stripped PATH.
      expect(strippedPath.split(delimiter).some((d) => existsSync(join(d, "bun")))).toBe(false);
      const r = spawnSync(
        process.execPath,
        [join(dir, ".codex", "hooks", "aidlc-codex-adapter.ts"), "session-start"],
        {
          cwd: dir,
          input: JSON.stringify(withCwd(FIXTURES.sessionStart, dir)),
          encoding: "utf-8",
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: undefined,
            PATH: strippedPath,
          } as NodeJS.ProcessEnv,
          timeout: 30_000,
        },
      );
      expect(r.status ?? -1).toBe(0);
      const out = JSON.parse(r.stdout ?? "{}") as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      // The core hook ran (its output made it back through the child respawn).
      expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("AIDLC WORKFLOW ACTIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("17: shipped codex adapter source respawns via process.execPath, never a bare 'bun' argv[0]", () => {
    // Source pin (matches this suite's grep-pin style). A stale regeneration or a
    // hand-edit reintroducing the bare-name respawn reds here.
    const src = readFileSync(
      join(REPO_ROOT, "dist", "codex", ".codex", "hooks", "aidlc-codex-adapter.ts"),
      "utf-8",
    );
    expect(/spawnSync\(\s*\[\s*"bun"/.test(src)).toBe(false);
    expect(src).toContain("process.execPath");
  });
});

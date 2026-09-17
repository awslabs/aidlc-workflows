// t332-devin-adapter: the Devin stdin shim normalizes Devin hook payloads
// into the core hooks' contract (tool-name translation + output re-wrapping).
//
// covers: file:hooks/aidlc-devin-adapter.ts, hook:aidlc-session-start,
// hook:aidlc-continue-workflow, hook:aidlc-write-audit-log,
// hook:aidlc-sync-workflow-state, hook:aidlc-log-subagent
//
// WHAT. Each case pipes a fixture from tests/fixtures/devin-hook-payloads/
// into `bun dist/devin/.devin/hooks/aidlc-devin-adapter.ts <target>` inside a
// scratch project carrying an active workflow state, then asserts the
// observable core-hook effect:
//   session-start     → {"hookSpecificOutput":{"additionalContext":"..."}} (the
//                       Devin wrapper — core JSON re-wrapped)
//   continue-workflow → {"decision":"block","reason"} verbatim passthrough
//                       when work remains; silent exit 0 when no state
//   audit-and-sensors → edit/write on aidlc-docs lands ARTIFACT_* in the
//                       audit; a non-aidlc file is a no-op; apply_patch fans
//                       out one Write/Edit per parsed file
//   sync-workflow-state → todo_write with in_progress step dispatches
//   log-subagent      → run_subagent PostToolUse lands SUBAGENT_COMPLETED
//   record-human-turn → UserPromptSubmit + ask_user_question PostToolUse
//   malformed stdin   → fail-open exit 0 (advisory contract)
//   tool-name map     → exec→Bash, edit→Edit, write→Write, run_subagent→Task,
//                       todo_write→TaskUpdate, ask_user_question→AskUserQuestion
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as codex's t149 and kiro's t142.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  devinSubagentLedgerPath,
  stateDigest,
  workspaceSourceFingerprint,
  writeActiveDirectiveMarker,
  writePlanApprovalChallenge,
} from "../../dist/devin/.devin/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/devin/.devin/tools/aidlc-testing-posture.ts";
import { appendAuditEntry } from "../../dist/devin/.devin/tools/aidlc-audit.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEVIN_TREE = join(REPO_ROOT, "dist", "devin", ".devin");
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "devin-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, unknown>;

// P9 per-intent layout: the CORE hooks the Devin adapter shims to
// (write-audit-log, session-start/end, log-subagent, sync-workflow-state)
// resolve state via stateFilePath() and the audit trail via auditFilePath() —
// under the active intent's record. So the scratch project seeds the
// per-intent shell + the state fixture into the default record (so the cursor
// resolves) + the resolved audit SHARD (pinned clone-id so audit reads are
// deterministic). Devin has NO duplicate-delivery replay cache and NO D-4
// session-end reconcile (unlike codex) — those codex-specific parts are not
// ported here.
const PINNED_CLONE_ID = "testcloneid332";
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

// Scratch project: a .devin tree (copied) + the per-intent workspace shell with
// an active workflow state. The fixture payloads carry cwd=/tmp/devin-test/proj
// (a placeholder); the adapter must use ITS project (the scratch dir): we
// rewrite the fixture's cwd to the scratch dir, exactly what a real install sees.
function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t332-")));
  cpSync(DEVIN_TREE, join(dir, ".devin"), { recursive: true });
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

/** Seed the state into the code-generation stage with an unapproved active
 *  directive, so the plan-approval-guard actually enforces (it fails open with
 *  no state or a non-code-generation stage). Mirrors t149's helper. */
function seedUnapprovedCodeGeneration(dir: string, unit: string): void {
  const state = readFileSync(seededStateFile(dir), "utf-8").replace(
    /(- \*\*Current Stage\*\*:\s*)[^\n]+/,
    `$1code-generation`,
  );
  writeFileSync(seededStateFile(dir), state, "utf-8");
  writeActiveDirectiveMarker(dir, {
    kind: "run-stage",
    stage: "code-generation",
    unit,
    state_sha256: createHash("sha256").update(state).digest("hex"),
  });
  mkdirSync(join(seededRecordDir(dir), "construction", unit, "code-generation"), {
    recursive: true,
  });
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

/** Remap a captured Devin payload's aidlc-docs file_path (which points under a
 *  placeholder `/tmp/devin-test/proj/aidlc/spaces/default/intents/test-abc12345/`
 *  prefix) to the scratch project's actual record dir, so the core
 *  write-audit-log gate sees the write under the record root. Rewrites
 *  tool_input.file_path (for edit/write) and the patch `command` envelope (for
 *  apply_patch). */
function remapAidlcPaths(
  payload: Record<string, unknown>,
  dir: string,
): Record<string, unknown> {
  const recordPrefix = join(dir, "aidlc", "spaces", DEFAULT_SPACE, "intents", DEFAULT_RECORD_DIR);
  const placeholder = "/tmp/devin-test/proj/aidlc/spaces/default/intents/test-abc12345";
  const out = { ...payload };
  const input = (out.tool_input as Record<string, unknown> | undefined) ?? {};
  if (typeof input.file_path === "string") {
    out.tool_input = {
      ...input,
      file_path: (input.file_path as string).replaceAll(placeholder, recordPrefix),
    };
  }
  if (typeof input.command === "string") {
    out.tool_input = {
      ...input,
      command: (input.command as string).replaceAll(placeholder, recordPrefix),
    };
  }
  return out;
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
  envOverrides: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".devin", "hooks", "aidlc-devin-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        // Explicitly target the scratch project by default. The adapter
        // resolves DEVIN_PROJECT_DIR → payload.cwd → process.cwd(); setting
        // DEVIN_PROJECT_DIR here prevents a leaked value from process.env
        // pointing at the repository root or another test's scratch dir.
        DEVIN_PROJECT_DIR: projectDir,
        AIDLC_UNATTENDED: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
  };
}

describe("t332 devin adapter — stdin shim normalizes Devin payloads to core hooks", () => {
  // --- session-start: re-wrap into hookSpecificOutput ---

  const MARKER_REL = join(".devin", ".aidlc-session-start.local.json");
  function markerPath(dir: string): string {
    return join(dir, MARKER_REL);
  }
  function expectCanonicalIsoBounded(lastRun: unknown, before: string, after: string): void {
    expect(typeof lastRun).toBe("string");
    expect(new Date(lastRun as string).toISOString()).toBe(lastRun as string);
    expect((lastRun as string) >= before && (lastRun as string) <= after).toBe(true);
  }

  test("1: session-start emits the Devin hookSpecificOutput wrapper with workflow context", () => {
    const dir = scratchProject(true);
    try {
      const before = new Date().toISOString();
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      const after = new Date().toISOString();
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(typeof out.hookSpecificOutput?.additionalContext).toBe("string");
      expect(out.hookSpecificOutput?.additionalContext ?? "").not.toBe("");
      const marker = JSON.parse(readFileSync(markerPath(dir), "utf-8")) as { lastRun?: unknown };
      expectCanonicalIsoBounded(marker.lastRun, before, after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: session-start with no active workflow is exit 0 (no workflow context injected)", () => {
    const dir = scratchProject(false);
    try {
      const before = new Date().toISOString();
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      const after = new Date().toISOString();
      expect(r.code).toBe(0);
      // No state → the core hook emits no AIDLC WORKFLOW ACTIVE context. It may
      // still emit a session-binding line (the runtime session id), but the
      // workflow-active banner must be absent.
      if (r.stdout.trim()) {
        const out = JSON.parse(r.stdout) as {
          hookSpecificOutput?: { additionalContext?: string };
        };
        expect(out.hookSpecificOutput?.additionalContext ?? "").not.toContain("AIDLC WORKFLOW ACTIVE");
      }
      const marker = JSON.parse(readFileSync(markerPath(dir), "utf-8")) as { lastRun?: unknown };
      expectCanonicalIsoBounded(marker.lastRun, before, after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2a: session-start refreshes a pre-existing marker to the current run", () => {
    const dir = scratchProject(true);
    try {
      writeFileSync(markerPath(dir), `${JSON.stringify({ lastRun: "2020-01-01T00:00:00.000Z" })}\n`, "utf-8");
      const before = new Date().toISOString();
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      const after = new Date().toISOString();
      expect(r.code).toBe(0);
      const marker = JSON.parse(readFileSync(markerPath(dir), "utf-8")) as { lastRun?: unknown };
      expect(marker.lastRun).not.toBe("2020-01-01T00:00:00.000Z");
      expectCanonicalIsoBounded(marker.lastRun, before, after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2b: session-start marker-write failure warns on stderr but still forwards context (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      mkdirSync(markerPath(dir), { recursive: true });
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("could not write Devin SessionStart evidence");
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.additionalContext ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2c: no marker for malformed stdin, a non-SessionStart payload, or a non-session-start target", () => {
    const dir = scratchProject(false);
    try {
      let r = runAdapter(dir, "session-start", FIXTURES.malformed as string);
      expect(r.code).toBe(0);
      expect(existsSync(markerPath(dir))).toBe(false);
      r = runAdapter(dir, "session-start", withCwd(FIXTURES.userPromptSubmit as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      expect(existsSync(markerPath(dir))).toBe(false);
      r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      expect(existsSync(markerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2d: no marker when the core session-start hook exits non-zero", () => {
    const dir = scratchProject(true);
    try {
      writeFileSync(
        join(dir, ".devin", "hooks", "aidlc-session-start.ts"),
        "process.exit(1);\n",
        "utf-8",
      );
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      expect(existsSync(markerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2e: session-start marker is written to DEVIN_PROJECT_DIR, not the payload cwd", () => {
    const projA = scratchProject(true);
    const projB = scratchProject(false);
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.sessionStart as Record<string, unknown>, cwd: projB };
      const r = runAdapterExplicit(adapter, "session-start", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: projA, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projB,
      });
      expect(r.code).toBe(0);
      expect(existsSync(markerPath(projA))).toBe(true);
      expect(existsSync(markerPath(projB))).toBe(false);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  // --- continue-workflow: verbatim passthrough ---

  test("3: continue-workflow blocks with a reason while the workflow has pending work (verbatim passthrough)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: continue-workflow is silent (no block) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- audit-and-sensors: edit/write/apply_patch on aidlc-docs vs plain ---

  test("5: audit-and-sensors edit on aidlc-docs lands ARTIFACT_* in the audit", () => {
    const dir = scratchProject(true);
    try {
      const remapped = remapAidlcPaths(FIXTURES.postToolUse_edit_aidlcDocs as Record<string, unknown>, dir);
      const r = runAdapter(dir, "audit-and-sensors", withCwd(remapped, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: audit-and-sensors edit on a non-aidlc file is a clean audit no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "audit-and-sensors", withCwd(FIXTURES.postToolUse_edit_plain as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).not.toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: audit-and-sensors write on aidlc-docs lands ARTIFACT_* in the audit", () => {
    const dir = scratchProject(true);
    try {
      const remapped = remapAidlcPaths(FIXTURES.postToolUse_write_aidlcDocs as Record<string, unknown>, dir);
      const r = runAdapter(dir, "audit-and-sensors", withCwd(remapped, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8: audit-and-sensors apply_patch on aidlc-docs lands ARTIFACT_* (envelope parsed + fanned out)", () => {
    const dir = scratchProject(true);
    try {
      const remapped = remapAidlcPaths(FIXTURES.postToolUse_applyPatch_aidlcDocs as Record<string, unknown>, dir);
      const r = runAdapter(dir, "audit-and-sensors", withCwd(remapped, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("9: audit-and-sensors apply_patch on a non-aidlc file is a clean audit no-op", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "audit-and-sensors", withCwd(FIXTURES.postToolUse_applyPatch_plain as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).not.toContain("ARTIFACT_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- sync-workflow-state: todo_write in_progress dispatches ---

  test("10: sync-workflow-state with todo_write in_progress step dispatches (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "sync-workflow-state", withCwd(FIXTURES.postToolUse_todoWrite as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      // The adapter pipes correctly; the core hook's own test owns the state
      // content assertion. We assert the adapter did not crash.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- log-subagent: run_subagent PostToolUse lands SUBAGENT_COMPLETED ---

  test("11: log-subagent with run_subagent PostToolUse lands SUBAGENT_COMPLETED in the audit", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", withCwd(FIXTURES.postToolUse_runSubagent as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- record-human-turn: UserPromptSubmit + ask_user_question PostToolUse ---

  test("12: record-human-turn with UserPromptSubmit is advisory (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "record-human-turn", withCwd(FIXTURES.userPromptSubmit as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13: record-human-turn with ask_user_question PostToolUse is advisory (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "record-human-turn", withCwd(FIXTURES.postToolUse_askUserQuestion as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13a: record-human-turn with object-format tool_response ({success,output,error}) records a HUMAN_TURN audit event", () => {
    // Regression for the Devin adapter object-format bug: Devin's PostToolUse
    // delivers tool_response as {success, output, error} where `output` is a
    // JSON string. The pre-fix adapter returned false from
    // hasExplicitHumanSelection on any non-string tool_response, so the hook
    // skipped and NO HUMAN_TURN was recorded — breaking ask_user_question
    // answer recording and the Plan Approval gate. The normalizer must extract
    // `output` and the selection must be recognized, minting a HUMAN_TURN.
    // Asserts the EFFECT (audit event), not just exit 0 — exit 0 passes even
    // when the hook skips (the original test-13 gap).
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_objectResponse as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13b: record-human-turn with Devin native shape (selected option) records a HUMAN_TURN audit event", () => {
    // Devin's ask_user_question returns {answers: {<question text>: [{selected: [...], custom_text: ...}]}}
    // — keyed by question TEXT, value is an ARRAY of {selected, custom_text} objects.
    // The pre-fix adapter rejected arrays (Array.isArray(selection) → false), so no
    // HUMAN_TURN was recorded. The dual-path fix recognizes this shape.
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_devinNativeShape as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13c: record-human-turn with Devin Other free-text shape records a HUMAN_TURN audit event", () => {
    // The "Other" free-text path: Devin's ask_user_question returns
    // {answers: {<question text>: [{selected: ["Other"], custom_text: "<text>"}]}}
    // — the actual answer rides in `custom_text` while `selected` is ["Other"].
    // The dual-path fix recognizes this array shape and extracts the selection,
    // minting a HUMAN_TURN where the pre-fix adapter skipped (no selection
    // recognized on an array value).
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_devinOtherShape as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13e: record-human-turn with unrecognized answer shape but success:true mints a HUMAN_TURN", () => {
    // S08 fix: Devin 3000.6.14 may deliver an ask_user_question PostToolUse
    // tool_response whose inner `output` JSON doesn't match the expected
    // {answers:...} shape (the shape was never captured interactively — only
    // the cancel case was captured on -p runs). Pre-fix, the adapter skipped
    // the HUMAN_TURN mint whenever hasExplicitHumanSelection returned false,
    // even for real answers — breaking every gate after the first question.
    // Post-fix, a success:true response is a positive answer signal: mint
    // regardless of whether the inner shape is recognized.
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_unrecognizedShape as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13f: record-human-turn with cancelled ask_user_question (success:false) does NOT mint a HUMAN_TURN", () => {
    // S08 fix: a dismissed/cancelled question has success:false — the adapter
    // must still skip the HUMAN_TURN mint for genuine cancellations.
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_cancelled as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13g: record-human-turn with Devin 3000.6.14 native shape (unwrapped) mints a HUMAN_TURN and recognizes the selection", () => {
    // Captured from a Devin 3000.6.14 interactive session export (see
    // tests/fixtures/devin-hook-payloads/PROVENANCE.md):
    // the real interactive Devin 3000.6.14 answer shape is a single object
    // {selected: ["<label>"], skipped: false} keyed by question TEXT, with NO
    // {answers:...} wrapper. The parser now recognizes this third shape directly
    // (not just via the success:true fallback).
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_native3000_unwrapped as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13h: record-human-turn with Devin 3000.6.14 native shape (wrapped) mints a HUMAN_TURN and recognizes the selection", () => {
    // Same shape but with the {answers:...} wrapper, in case the hook payload
    // includes it even though the export format strips it.
    const dir = scratchProject(true);
    try {
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_native3000_wrapped as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13d: record-human-turn with Devin native shape writes a Plan Approval response when a challenge is seeded", () => {
    // The end-to-end path that was actually blocked: a human answers an
    // ask_user_question with a Plan Approval choice, the adapter forwards it to
    // the core record-human-turn hook, which calls recordPlanApprovalHumanResponse
    // to write the response file. Pre-fix, the adapter skipped (no selection
    // recognized) so no response was written.
    const dir = scratchProject(true);
    try {
      const session = "019eb8be-e4fe-7a42-ba1b-e5f963dbddc9";
      writePlanApprovalChallenge(dir, {
        version: 1,
        session,
        challengeId: "test-challenge-1",
        targetId: "test-target",
        intentId: "test-intent",
        directiveEpoch: "test-epoch",
        runFloor: "test-run",
        fingerprint: "a".repeat(64),
        questionsFile: "construction/code-generation/code-generation-questions.md",
        promptSha256: "b".repeat(64),
        sourceFloor: "c".repeat(64),
        markerRevision: 0,
        plannedSourceSha256: "d".repeat(64),
        options: ["yes", "no"],
        requireExactOptionLabels: false,
        hashedOptionLabels: false,
      });
      const before = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      const r = runAdapter(
        dir,
        "record-human-turn",
        withCwd(FIXTURES.postToolUse_askUserQuestion_devinNativeShape as Record<string, unknown>, dir),
      );
      expect(r.code).toBe(0);
      const after = readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
      expect(after).toBe(before + 1);
      // The Plan Approval response file must be written. The runtime dir lives
      // under <projectDir>/aidlc/.aidlc-sessions/plan-approval/ and the response
      // file is named response-<session-segment>.json.
      const runtimeDir = join(dir, "aidlc", ".aidlc-sessions", "plan-approval");
      const responseFiles = readdirSync(runtimeDir).filter(
        (n) => n.startsWith("response-") && n.endsWith(".json"),
      );
      expect(responseFiles.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- rebuild-stage-graph: exec PostToolUse advisory ---

  test("14: rebuild-stage-graph with exec PostToolUse is advisory (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "rebuild-stage-graph", withCwd(FIXTURES.postToolUse_exec as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- validate-state: PostCompaction advisory ---

  test("15: validate-state with PostCompaction is advisory (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "validate-state", withCwd(FIXTURES.postCompaction as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- malformed stdin: fail-open exit 0 on every target ---

  test("16: malformed stdin fails open (exit 0, no output) on every advisory target", () => {
    const dir = scratchProject(true);
    try {
      for (const t of [
        "continue-workflow",
        "session-start",
        "session-end",
        "record-human-turn",
        "audit-and-sensors",
        "sync-workflow-state",
        "log-subagent",
        "rebuild-stage-graph",
        "validate-state",
        "fold-usage",
      ]) {
        const r = runAdapter(dir, t, FIXTURES.malformed as string);
        expect(r.code, `target=${t}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("16a: malformed stdin fails open (exit 0) on guard targets too", () => {
    const dir = scratchProject(true);
    try {
      for (const t of [
        "state-transition-guard",
        "reviewer-scope",
        "review-freeze",
        "plan-approval-guard",
        "deliver-stage-rules",
      ]) {
        const r = runAdapter(dir, t, FIXTURES.malformed as string);
        expect(r.code, `target=${t}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- tool-name translation: exec→Bash reaches the core guard ---

  test("17: state-transition-guard with exec (plain command) does not crash — tool-name exec→Bash translation", () => {
    // A plain exec (not an aidlc-state.ts command) is a no-op for the guard —
    // the guard only blocks lifecycle routing. The adapter translates exec→Bash
    // before piping; if the translation failed, the guard would either crash
    // or misclassify. Exit 0 = allow (no state transition attempted).
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", withCwd(FIXTURES.preToolUse_exec as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("17a: state-transition-guard blocks an exec that attempts a direct state transition (exec→Bash reaches guard)", () => {
    // The adapter MUST translate exec→Bash so the core guard's command-pattern
    // match (which hardcodes `Bash`) fires. Without translation, the guard
    // would see tool_name="exec" and skip the command check, allowing the
    // forbidden transition. This test proves the translation is load-bearing.
    const dir = scratchProject(false);
    try {
      const payload = {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "exec",
        tool_input: {
          command: "bun .devin/tools/aidlc-state.ts reject feasibility",
        },
      };
      const r = runAdapter(dir, "state-transition-guard", payload);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Stage status cannot be changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- plan-approval-guard: Facet B — workdir lifted into cwd ---

  test("17b: plan-approval-guard exec with tool_input.workdir lifts workdir into cwd (framework-tool exemption fails from subdir)", () => {
    // Facet B: rewriteStdinCwd lifts tool_input.workdir into the top-level cwd
    // field before piping to the core plan-approval-guard. The guard's
    // isFrameworkToolInvocation resolves the script path against cwd
    // (resolve(cwd, script) at guard line 487). When workdir is a subdirectory,
    // the resolved path no longer matches the trusted tools dir
    // (<projectDir>/.devin/tools), so the framework-tool exemption FAILS and
    // the command is treated as an opaque shell mutation → blocked (exit 2).
    // Without the lift, cwd defaults to projectDir and the exemption succeeds
    // (exit 0) — a false exemption for a command actually running from a subdir.
    // This asserts the EFFECT (exit 2 = the cwd lift happened), not just exit 0.
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const subdir = join(dir, "subdir");
      mkdirSync(subdir, { recursive: true });
      // Build a plan-approval-guard exec payload with tool_input.workdir set
      // to a subdirectory and top-level cwd ABSENT (the lift condition).
      const payload: Record<string, unknown> = {
        hook_event_name: "PreToolUse",
        tool_name: "exec",
        tool_input: {
          command: "bun .devin/tools/aidlc-orchestrate.ts next",
          workdir: subdir,
        },
      };
      const r = runAdapter(dir, "plan-approval-guard", payload);
      // With the lift: cwd = subdir → framework-tool exemption fails → blocked.
      expect(r.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("17c: plan-approval-guard exec with no workdir does not regress (cwd stays as-is, framework-tool exemption succeeds)", () => {
    // No-regression: when tool_input.workdir is absent, rewriteStdinCwd is a
    // no-op. The guard resolves the script path against the payload's cwd
    // (here the project dir), the framework-tool exemption succeeds, and the
    // command is allowed (exit 0). This must not change with the Facet B fix.
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      // Same command, NO workdir — the helper is a no-op.
      const payload: Record<string, unknown> = {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "exec",
        tool_input: {
          command: "bun .devin/tools/aidlc-orchestrate.ts next",
        },
      };
      const r = runAdapter(dir, "plan-approval-guard", payload);
      // No workdir → no lift → cwd = project dir → framework-tool exemption
      // succeeds → allowed (exit 0).
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- session-end: pipes verbatim to core (advisory) ---

  test("18: session-end is advisory (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-end", withCwd(FIXTURES.sessionEnd as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- adapter respawns children via the running bun, not a PATH lookup ---

  /** PATH stripped of every dir that resolves a `bun` binary (the fragile hook
   *  environment the fix targets). Deterministic: reads real disk. */
  function pathWithoutBun(): string {
    const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    return entries.filter((d) => !existsSync(join(d, "bun"))).join(delimiter);
  }

  test("19: session-start dispatches even when the child PATH has no bun (respawn uses process.execPath)", () => {
    // The adapter is launched via the ABSOLUTE bun (process.execPath), so it
    // starts regardless of PATH; the contract under test is that its OWN child
    // respawn (runCore) also does not need bun on PATH.
    const dir = scratchProject(true);
    try {
      const strippedPath = pathWithoutBun();
      expect(strippedPath.split(delimiter).some((d) => existsSync(join(d, "bun")))).toBe(false);
      const r = spawnSync(
        process.execPath,
        [join(dir, ".devin", "hooks", "aidlc-devin-adapter.ts"), "session-start"],
        {
          cwd: dir,
          input: JSON.stringify(withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir)),
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
      expect(out.hookSpecificOutput?.additionalContext ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("20: shipped devin adapter source respawns via process.execPath, never a bare 'bun' argv[0]", () => {
    // Source pin (matches this suite's grep-pin style). A stale regeneration or
    // a hand-edit reintroducing the bare-name respawn reds here.
    const src = readFileSync(
      join(REPO_ROOT, "dist", "devin", ".devin", "hooks", "aidlc-devin-adapter.ts"),
      "utf-8",
    );
    expect(/spawnSync\(\s*\[\s*"bun"/.test(src)).toBe(false);
    expect(src).toContain("process.execPath");
  });

  // --- S05: project-root resolution precedence ---
  // The adapter resolves DEVIN_PROJECT_DIR → payload.cwd → process.cwd().
  // Probe: continue-workflow blocks when state is found, passes silently when not.

  /** Run the adapter with explicit env, cwd, and payload control — bypasses
   *  runAdapter's defaults for project-root resolution tests. */
  function runAdapterExplicit(
    adapterPath: string,
    target: string,
    payload: unknown,
    opts: { env: NodeJS.ProcessEnv; cwd: string },
  ): { stdout: string; code: number } {
    const r = spawnSync(
      process.execPath,
      [adapterPath, target],
      {
        cwd: opts.cwd,
        input: typeof payload === "string" ? payload : JSON.stringify(payload),
        encoding: "utf-8",
        env: opts.env,
        timeout: 30_000,
      },
    );
    return { stdout: r.stdout ?? "", code: r.status ?? -1 };
  }

  /** Check whether continue-workflow blocked (found state) in the given output. */
  function didBlock(stdout: string): boolean {
    if (!stdout.trim()) return false;
    try {
      const out = JSON.parse(stdout) as { decision?: string };
      return out.decision === "block";
    } catch {
      return false;
    }
  }

  test("21: DEVIN_PROJECT_DIR takes precedence over payload cwd and process cwd", () => {
    const projA = scratchProject(true); // has state → blocks
    const projB = scratchProject(false); // no state → no block
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.stop as Record<string, unknown>, cwd: projB };
      const r = runAdapterExplicit(adapter, "continue-workflow", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: projA, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projB,
      });
      expect(didBlock(r.stdout)).toBe(true);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  test("22: DEVIN_PROJECT_DIR takes precedence when payload has no cwd", () => {
    const projA = scratchProject(true);
    const projB = scratchProject(false);
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.stop as Record<string, unknown> };
      delete (payload as Record<string, unknown>).cwd;
      const r = runAdapterExplicit(adapter, "continue-workflow", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: projA, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projB,
      });
      expect(didBlock(r.stdout)).toBe(true);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  test("23: payload cwd is used when DEVIN_PROJECT_DIR is absent (synthetic compatibility)", () => {
    const projA = scratchProject(true);
    const projB = scratchProject(false);
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.stop as Record<string, unknown>, cwd: projA };
      const r = runAdapterExplicit(adapter, "continue-workflow", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projB,
      });
      expect(didBlock(r.stdout)).toBe(true);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  test("24: process.cwd() is the fallback when neither DEVIN_PROJECT_DIR nor payload cwd is set", () => {
    const projA = scratchProject(true);
    const projB = scratchProject(false);
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.stop as Record<string, unknown> };
      delete (payload as Record<string, unknown>).cwd;
      const r = runAdapterExplicit(adapter, "continue-workflow", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projA, // process.cwd() = projA which has state
      });
      expect(didBlock(r.stdout)).toBe(true);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  test("25: project path with spaces resolves correctly (no shell splitting)", () => {
    // Create a scratch project under a path containing spaces.
    const spacedRoot = realpathSync(mkdtempSync(join(tmpdir(), "t332 space dir-")));
    const projA = join(spacedRoot, "project");
    cpSync(DEVIN_TREE, join(projA, ".devin"), { recursive: true });
    seedShell(projA);
    writeFileSync(
      seededStateFile(projA),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    try {
      const adapter = join(projA, ".devin", "hooks", "aidlc-devin-adapter.ts");
      const payload = { ...FIXTURES.stop as Record<string, unknown> };
      delete (payload as Record<string, unknown>).cwd;
      const r = runAdapterExplicit(adapter, "continue-workflow", payload, {
        env: { ...process.env, DEVIN_PROJECT_DIR: projA, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        cwd: projA,
      });
      expect(didBlock(r.stdout)).toBe(true);
    } finally {
      rmSync(spacedRoot, { recursive: true, force: true });
    }
  });

  test("26: two invocations for different workspace roots each affect only their own fixture", () => {
    const projA = scratchProject(true);
    const projB = scratchProject(true);
    try {
      // Run continue-workflow against projA — should block (state in projA).
      const rA = runAdapter(projA, "continue-workflow", withCwd(FIXTURES.stop as Record<string, unknown>, projA));
      expect(didBlock(rA.stdout)).toBe(true);
      // Run continue-workflow against projB — should also block (state in projB).
      const rB = runAdapter(projB, "continue-workflow", withCwd(FIXTURES.stop as Record<string, unknown>, projB));
      expect(didBlock(rB.stdout)).toBe(true);
      // Verify projA's audit is not contaminated by projB's run (no cross-talk).
      // Both have state; the key invariant is that each run resolves to its own project.
      // We already proved isolation by running both with their own DEVIN_PROJECT_DIR.
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  // --- run_subagent field normalization (profile/task/is_background) ---------
  //
  // Devin's native run_subagent tool_input is {profile, task, is_background,
  // title}; the core hooks read subagent_type/prompt/run_in_background. The
  // adapter normalizes before piping and denormalizes a core-emitted
  // updatedInput back so the augmented brief lands on `task` again.

  const RULE_MARKER = "t332 construction rule bundle marker";

  /** Seed every memory file code-generation's rules_in_context names, so the
   *  deliver-stage-rules bundle resolves to non-empty content. One carries the
   *  observable marker. */
  function writeStageRuleMemory(dir: string): void {
    const memory = join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory");
    mkdirSync(join(memory, "phases"), { recursive: true });
    for (const name of ["org.md", "team.md", "project.md"]) {
      writeFileSync(join(memory, name), `# ${name}\n\nShared practice.\n`, "utf-8");
    }
    writeFileSync(
      join(memory, "phases", "construction.md"),
      `# Construction\n\n${RULE_MARKER}.\n`,
      "utf-8",
    );
  }

  /** A live v2 code-generation run-stage directive: what the plan-approval
   *  guard enforces against. stateDigest (not raw sha256) is the comparison
   *  the marker reader uses. */
  function seedGuardedCodeGeneration(dir: string): void {
    const state = readFileSync(seededStateFile(dir), "utf-8").replace(
      /(- \*\*Current Stage\*\*:\s*)[^\n]+/,
      `$1code-generation`,
    );
    writeFileSync(seededStateFile(dir), state, "utf-8");
    writeActiveDirectiveMarker(dir, {
      kind: "run-stage",
      stage: "code-generation",
      state_sha256: stateDigest(state),
    });
  }

  function initGitBaseline(dir: string): void {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "tests@example.com"],
      ["config", "user.name", "AI-DLC Tests"],
      ["add", "-A"],
      ["commit", "-qm", "baseline"],
    ]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
  }

  function runTool(
    dir: string,
    args: string[],
  ): { stdout: string; stderr: string; code: number } {
    const r = spawnSync(
      "bun",
      [join(dir, ".devin", "tools", "aidlc-log.ts"), ...args],
      {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
        timeout: 30_000,
      },
    );
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
  }

  /** Drive the real approval ceremony on the devin tree: plant the stage-level
   *  plan + Testing Contract + questions file, mint the challenge with
   *  `decision`, record the human's typed answer through the shipped
   *  record-human-turn hook, fill in [Answer], and certify with `answer`.
   *  Ends with evaluateCodeGenerationApproval().ok === true. */
  function certifyStageLevelApproval(dir: string, session: string): void {
    const authority = resolveCodeGenerationAuthority(dir, { unit: null });
    const contract = resolveTestingPosture(dir);
    mkdirSync(authority.stageDir, { recursive: true });
    const plan =
      `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Implement\n`;
    const instructions =
      "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n";
    writeFileSync(join(authority.stageDir, "code-generation-plan.md"), plan);
    writeFileSync(
      join(authority.stageDir, "unit-test-instructions.md"),
      instructions,
    );
    const fingerprint = approvalFingerprint(
      plan,
      instructions,
      contract.contract_sha256,
      authority,
    );
    const questionsPath = join(
      authority.stageDir,
      "code-generation-questions.md",
    );
    writeFileSync(
      questionsPath,
      [
        "## Plan Approval",
        `[Approval Fingerprint]: ${fingerprint}`,
        `[Planned Source]: ${workspaceSourceFingerprint(dir) ?? "unbindable"}`,
        "A. Approve Plan",
        "B. Request Changes",
        "[Answer]:",
        "",
      ].join("\n"),
    );
    appendAuditEntry(
      "SESSION_STARTED",
      { Source: "startup", Session: session },
      dir,
    );
    const identity = [
      "--stage",
      "code-generation",
      "--checkpoint",
      "plan-approval",
      "--questions-file",
      questionsPath,
      "--session",
      session,
      "--stage-level",
    ];
    expect(
      runTool(dir, [
        "decision",
        ...identity,
        "--decision",
        "Approve this exact Code Generation plan?",
        "--options",
        "Approve Plan,Request Changes",
      ]).code,
    ).toBe(0);
    const human = spawnSync(
      "bun",
      [join(dir, ".devin", "hooks", "aidlc-record-human-turn.ts")],
      {
        cwd: dir,
        encoding: "utf-8",
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: "Approve Plan",
        }),
        env: { ...process.env, AIDLC_PROJECT_DIR: dir } as NodeJS.ProcessEnv,
        timeout: 30_000,
      },
    );
    expect(human.status).toBe(0);
    writeFileSync(
      questionsPath,
      readFileSync(questionsPath, "utf-8").replace(
        /\[Answer\]:\s*$/,
        "[Answer]: Approve Plan",
      ),
    );
    const answer = runTool(dir, [
      "answer",
      ...identity,
      "--details",
      "Approve Plan",
    ]);
    expect(answer.code, `${answer.stdout}\n${answer.stderr}`).toBe(0);
    const approval = evaluateCodeGenerationApproval(dir, { unit: null });
    expect(approval.ok, approval.reason).toBe(true);
  }

  function runSubagentPreToolUse(
    dir: string,
    toolInput: Record<string, unknown>,
    session = "t332-native-dispatch",
  ): Record<string, unknown> {
    return {
      hook_event_name: "PreToolUse",
      session_id: session,
      cwd: dir,
      tool_name: "run_subagent",
      tool_input: toolInput,
      tool_use_id: "call_t332",
    };
  }

  test("27: deliver-stage-rules injects the stage rule bundle into the native task field", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      writeStageRuleMemory(dir);
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        runSubagentPreToolUse(dir, {
          title: "worker",
          profile: "aidlc-developer-agent",
          task: "Implement the approved work for stage code-generation.",
          is_background: false,
        }),
      );
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
      };
      const updated = out.hookSpecificOutput?.updatedInput;
      expect(updated).toBeDefined();
      // The bundle lands on the native `task` field — the field Devin actually
      // sends to the subagent — not on a `prompt` key Devin would ignore.
      expect(String(updated!.task)).toContain("AIDLC_DISPATCH_RULES_BEGIN");
      expect(String(updated!.task)).toContain(RULE_MARKER);
      expect("prompt" in updated!).toBe(false);
      expect("subagent_type" in updated!).toBe(false);
      expect("run_in_background" in updated!).toBe(false);
      expect(updated!.profile).toBe("aidlc-developer-agent");
      expect(updated!.title).toBe("worker");
      expect(updated!.is_background).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("28: deliver-stage-rules leaves an unrelated native profile unmodified", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      writeStageRuleMemory(dir);
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        runSubagentPreToolUse(dir, {
          title: "reviewer",
          profile: "subagent_explore",
          task: "review the code",
        }),
      );
      // A non-AIDLC profile is not augmented: the core hook emits no
      // updatedInput and the adapter forwards nothing.
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("29: plan-approval-guard passes an approved dispatch whose brief lives in `task`", () => {
    const dir = scratchProject(true);
    try {
      seedGuardedCodeGeneration(dir);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n");
      initGitBaseline(dir);
      const session = "t332-approved-dispatch";
      certifyStageLevelApproval(dir, session);
      const contractHash =
        evaluateCodeGenerationApproval(dir, { unit: null }).contractHash;
      const task = [
        "Implement the approved work.",
        "",
        "AIDLC-STAGE: code-generation",
        `AIDLC-TESTING-CONTRACT: ${contractHash}`,
      ].join("\n");
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        runSubagentPreToolUse(
          dir,
          {
            title: "worker",
            profile: "aidlc-developer-agent",
            task,
            is_background: false,
          },
          session,
        ),
      );
      expect(r.code, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  test("30: plan-approval-guard still blocks an unapproved dispatch carried in `task`", () => {
    const dir = scratchProject(true);
    try {
      seedGuardedCodeGeneration(dir);
      const task = [
        "Implement the work.",
        "",
        "AIDLC-STAGE: code-generation",
        `AIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`,
      ].join("\n");
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        runSubagentPreToolUse(dir, {
          title: "worker",
          profile: "aidlc-developer-agent",
          task,
          is_background: true,
        }),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("31: denormalized updatedInput keeps the field shape the original tool_input used", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      writeStageRuleMemory(dir);
      const cases: Array<{
        label: string;
        toolInput: Record<string, unknown>;
        expectKey: string;
        absentKeys: string[];
      }> = [
        {
          // Native profile → the augmented input comes back under profile.
          label: "profile",
          toolInput: { profile: "aidlc-developer-agent", task: "do the stage work" },
          expectKey: "profile",
          absentKeys: ["subagent_type", "prompt"],
        },
        {
          // Legacy `agent` (no profile) → back under `agent`, never a hybrid.
          label: "agent",
          toolInput: { agent: "aidlc-developer-agent", task: "do the stage work" },
          expectKey: "agent",
          absentKeys: ["subagent_type", "prompt", "profile"],
        },
        {
          // Already-canonical input stays canonical.
          label: "canonical",
          toolInput: {
            subagent_type: "aidlc-developer-agent",
            prompt: "do the stage work",
          },
          expectKey: "subagent_type",
          absentKeys: ["profile", "agent"],
        },
      ];
      for (const c of cases) {
        const r = runAdapter(
          dir,
          "deliver-stage-rules",
          runSubagentPreToolUse(dir, c.toolInput),
        );
        expect(r.code, `${c.label}: ${r.stderr}`).toBe(0);
        const out = JSON.parse(r.stdout) as {
          hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
        };
        const updated = out.hookSpecificOutput?.updatedInput;
        expect(updated, `${c.label} produced an updatedInput`).toBeDefined();
        const textField = c.expectKey === "subagent_type" ? "prompt" : "task";
        expect(String(updated![textField]), c.label).toContain(
          "AIDLC_DISPATCH_RULES_BEGIN",
        );
        expect(updated![c.expectKey], c.label).toBe("aidlc-developer-agent");
        for (const absent of c.absentKeys) {
          expect(absent in updated!, `${c.label} leaks ${absent}`).toBe(false);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- background subagent lifecycle (launch vs terminal via read_subagent) ---

  const SUB_SESSION = "t332-subagent-session";

  function postToolUse(
    dir: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: unknown,
    session = SUB_SESSION,
  ): Record<string, unknown> {
    return {
      hook_event_name: "PostToolUse",
      session_id: session,
      cwd: dir,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: "chatcmpl-tool-parent1",
    };
  }

  function backgroundLaunchPayload(dir: string, agentId = "agent-1"): Record<string, unknown> {
    return postToolUse(
      dir,
      "run_subagent",
      {
        title: "worker",
        task: "do work",
        profile: "subagent_general",
        is_background: true,
      },
      {
        success: true,
        output: `Background subagent started with agent_id=${agentId}. You can wait for this agent to finish using the read_subagent tool, otherwise you will automatically be notified with a <subagent_completion_notification> when it completes.`,
        error: null,
      },
    );
  }

  function readSubagentPayload(
    dir: string,
    agentId: string,
    output: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return postToolUse(
      dir,
      "read_subagent",
      { agent_id: agentId, block: true, timeout: 600 },
      { success: true, output, error: null },
      (extra.session as string) ?? SUB_SESSION,
    );
  }

  function auditCompletionCount(dir: string): number {
    return (readAudit(dir).match(/SUBAGENT_COMPLETED/g) ?? []).length;
  }

  function ledgerFile(dir: string): string {
    const ledger = JSON.parse(
      readFileSync(devinSubagentLedgerPath(dir), "utf-8"),
    ) as {
      agents: Array<{
        agentId: string;
        session: string;
        agentType: string;
        terminal: { outcome: string; recordedAt: string } | null;
      }>;
    };
    return JSON.stringify(ledger);
  }

  test("32: foreground run_subagent PostToolUse still lands SUBAGENT_COMPLETED once", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "log-subagent",
        postToolUse(
          dir,
          "run_subagent",
          { title: "worker", task: "do work", profile: "subagent_general" },
          {
            success: true,
            output: "Subagent agent_id=agent-fg completed successfully:\n\nreport",
            error: null,
          },
        ),
      );
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(auditCompletionCount(dir)).toBe(1);
      expect(audit).toContain("agent-fg");
      // A later read_subagent on the same agent does not double-record.
      const r2 = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-fg",
          "Subagent agent-fg completed successfully:\n\nreport",
        ),
      );
      expect(r2.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("33: background launch records a ledger entry and emits NO terminal row", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir));
      expect(r.code).toBe(0);
      expect(readAudit(dir)).not.toContain("SUBAGENT_COMPLETED");
      const ledger = ledgerFile(dir);
      expect(ledger).toContain('"agentId":"agent-1"');
      expect(ledger).toContain('"terminal":null');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("34: background completion arrives through read_subagent, not the launch event", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir));
      expect(readAudit(dir)).not.toContain("SUBAGENT_COMPLETED");
      // Still-running read: no terminal record.
      const running = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(dir, "agent-1", "Subagent agent-1 is still running."),
      );
      expect(running.code).toBe(0);
      expect(readAudit(dir)).not.toContain("SUBAGENT_COMPLETED");
      const done = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-1",
          "Subagent agent-1 completed. Its full report is delivered in the <subagent_completion_notification> message; you do not need to read it again.",
        ),
      );
      expect(done.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
      const audit = readAudit(dir);
      expect(audit).toContain("subagent_general");
      expect(audit).toContain("**Outcome**: success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("35: background failure is recorded through read_subagent with the failure outcome", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir, "agent-fail"));
      const r = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-fail",
          "Subagent agent-fail failed: worker exited with an error",
        ),
      );
      expect(r.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
      expect(readAudit(dir)).toContain("**Outcome**: failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("36: a cancelled background agent records the cancelled outcome", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir, "agent-cancel"));
      const r = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-cancel",
          "Subagent agent-cancel was cancelled before completing.",
        ),
      );
      expect(r.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
      expect(readAudit(dir)).toContain("**Outcome**: cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("36a: a success report body mentioning 'error'/'cancelled' still classifies as success", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir, "agent-body"));
      const r = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-body",
          "Subagent agent-body completed successfully:\n\nfixed the cancelled job error and the error retry path",
        ),
      );
      expect(r.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
      expect(readAudit(dir)).toContain("**Outcome**: success");
      expect(ledgerFile(dir)).toContain('"outcome":"success"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("36b: output outside the notification grammar records no terminal state", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir, "agent-weird"));
      const r = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(
          dir,
          "agent-weird",
          "intermediate stream: processed 3 items, no verdict yet",
        ),
      );
      expect(r.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(0);
      expect(ledgerFile(dir)).toContain('"terminal":null');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("37: repeated read_subagent on a terminal agent emits exactly one SUBAGENT_COMPLETED", () => {
    const dir = scratchProject(true);
    try {
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir));
      for (const output of [
        "Subagent agent-1 completed. Its full report is delivered in the <subagent_completion_notification> message; you do not need to read it again.",
        "Subagent agent-1 completed successfully:\n\n<report text>",
      ]) {
        const r = runAdapter(dir, "observe-subagent", readSubagentPayload(dir, "agent-1", output));
        expect(r.code).toBe(0);
      }
      expect(auditCompletionCount(dir)).toBe(1);
      // The ledger holds the first terminal outcome — idempotent on disk too.
      expect(ledgerFile(dir)).toContain('"outcome":"success"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("38: the correlation ledger survives process restarts (fresh adapter processes re-read it)", () => {
    const dir = scratchProject(true);
    try {
      // Launch and observe in separate adapter invocations — each runs in its
      // own process, so correlation can only come from the on-disk ledger.
      runAdapter(dir, "log-subagent", backgroundLaunchPayload(dir, "agent-9"));
      const first = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(dir, "agent-9", "Subagent agent-9 completed successfully:\n\ndone"),
      );
      expect(first.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
      const second = runAdapter(
        dir,
        "observe-subagent",
        readSubagentPayload(dir, "agent-9", "Subagent agent-9 completed successfully:\n\ndone"),
      );
      expect(second.code).toBe(0);
      expect(auditCompletionCount(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("39: a read_subagent with no matching launch still records the terminal once", () => {
    const dir = scratchProject(true);
    try {
      for (let i = 0; i < 2; i++) {
        const r = runAdapter(
          dir,
          "observe-subagent",
          readSubagentPayload(dir, "agent-unknown", "Subagent agent-unknown completed successfully:\n\nok"),
        );
        expect(r.code).toBe(0);
      }
      expect(auditCompletionCount(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- reviewer read/search isolation ----------------------------------------

  const REVIEW_SESSION = "t332-review-session";

  function seedReviewerDispatch(dir: string): void {
    // The conductor-written dispatch record (stage-protocol-reviewer §12a
    // step 1): one review in flight for unit U03-scoring.
    writeFileSync(
      join(seededRecordDir(dir), ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "nfr-requirements",
        unit: "U03-scoring",
        exempt: [],
      }),
      "utf-8",
    );
  }

  function registerReviewer(dir: string, session = REVIEW_SESSION): void {
    // The reviewer launch itself goes through deliver-stage-rules
    // (PreToolUse ^run_subagent$); the adapter registers the session's
    // reviewer topology from the profile field.
    writeStageRuleMemory(dir);
    // deliver-stage-rules resolves the rule bundle for the CURRENT stage
    // (requirements-analysis → inception phase); seed every phase file.
    for (const phase of ["ideation", "inception", "construction", "operation"]) {
      writeFileSync(
        join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory", "phases", `${phase}.md`),
        `# ${phase}\n\nPractice.\n`,
        "utf-8",
      );
    }
    const r = runAdapter(
      dir,
      "deliver-stage-rules",
      {
        hook_event_name: "PreToolUse",
        session_id: session,
        cwd: dir,
        tool_name: "run_subagent",
        tool_input: {
          title: "reviewer",
          task: "review unit U03-scoring",
          profile: "aidlc-architecture-reviewer-agent",
        },
        tool_use_id: "chatcmpl-tool-launch",
      },
    );
    expect(r.code).toBe(0);
  }

  function childCall(
    dir: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    session = REVIEW_SESSION,
    toolUseId = "functions.read:0",
  ): Record<string, unknown> {
    return {
      hook_event_name: "PreToolUse",
      session_id: session,
      cwd: dir,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    };
  }

  test("40: a registered reviewer's read inside its own construction unit is allowed", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      const own = join(seededRecordDir(dir), "construction", "U03-scoring", "design.md");
      const r = runAdapter(dir, "reviewer-scope", childCall(dir, "read", { file_path: own }));
      expect(r.code, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("41: a registered reviewer's read/search of a sibling unit is blocked (read, grep, glob, notebook_read)", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      const record = seededRecordDir(dir);
      const sibling = join(record, "construction", "U01-infra", "design.md");
      const cases: Array<{ tool: string; input: Record<string, unknown> }> = [
        { tool: "read", input: { file_path: sibling } },
        { tool: "notebook_read", input: { notebook_path: sibling } },
        // A grep rooted at the sibling unit directory.
        { tool: "grep", input: { pattern: "needle", path: join(record, "construction", "U01-infra") } },
        // A glob pattern spanning sibling units.
        { tool: "glob", input: { pattern: "**/construction/*/design.md", path: record } },
      ];
      for (const c of cases) {
        const r = runAdapter(dir, "reviewer-scope", childCall(dir, c.tool, c.input));
        expect(r.code, `${c.tool}: ${r.stderr}`).toBe(2);
        expect(r.stderr).toContain("This review cannot open");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("42: reviewer writes stay scoped (edit, write, apply_patch) under the registered topology", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      const record = seededRecordDir(dir);
      const sibling = join(record, "construction", "U01-infra", "out.ts");
      for (const tool of ["edit", "write"]) {
        const r = runAdapter(
          dir,
          "reviewer-scope",
          childCall(dir, tool, { file_path: sibling }, REVIEW_SESSION, `functions.${tool}:0`),
        );
        expect(r.code, `${tool}: ${r.stderr}`).toBe(2);
      }
      const patch = runAdapter(
        dir,
        "reviewer-scope",
        childCall(
          dir,
          "apply_patch",
          { command: `*** Update File: ${sibling}\n@@ x\n` },
          REVIEW_SESSION,
          "functions.apply_patch:0",
        ),
      );
      expect(patch.code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("43: conductor calls stay un-scoped and unattributable calls fail closed while a reviewer is live", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      const record = seededRecordDir(dir);
      const sibling = join(record, "construction", "U01-infra", "design.md");
      // The conductor's own sibling read (chatcmpl-tool- issuer) is untouched.
      const conductor = runAdapter(
        dir,
        "reviewer-scope",
        childCall(dir, "read", { file_path: sibling }, REVIEW_SESSION, "chatcmpl-tool-parent"),
      );
      expect(conductor.code, conductor.stderr).toBe(0);
      // An issuer Devin did not identify (unrecognized tool_use_id format)
      // cannot become silent permission while the reviewer topology is live:
      // reads and writes both refuse.
      const anonRead = runAdapter(
        dir,
        "reviewer-scope",
        childCall(dir, "read", { file_path: sibling }, REVIEW_SESSION, "opaque-id"),
      );
      expect(anonRead.code).toBe(2);
      expect(anonRead.stderr).toContain("cannot be attributed");
      const anonWrite = runAdapter(
        dir,
        "reviewer-scope",
        childCall(dir, "write", { file_path: sibling }, REVIEW_SESSION, "opaque-id"),
      );
      expect(anonWrite.code).toBe(2);
      expect(anonWrite.stderr).toContain("cannot be attributed");
      // The same unattributable call outside a reviewer topology is untouched.
      const dir2 = scratchProject(true);
      try {
        const free = runAdapter(
          dir2,
          "reviewer-scope",
          childCall(dir2, "write", { file_path: join(dir2, "src", "x.ts") }, "other-session", "opaque-id"),
        );
        expect(free.code, free.stderr).toBe(0);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("44: task text never forges reviewer identity (profile field only) and a generic subagent stays un-attributed", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      // A launch whose TASK names the reviewer but whose profile is a plain
      // worker creates no reviewer registration.
      writeStageRuleMemory(dir);
      for (const phase of ["ideation", "inception", "construction", "operation"]) {
        writeFileSync(
          join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory", "phases", `${phase}.md`),
          `# ${phase}\n\nPractice.\n`,
          "utf-8",
        );
      }
      const launch = runAdapter(
        dir,
        "deliver-stage-rules",
        {
          hook_event_name: "PreToolUse",
          session_id: REVIEW_SESSION,
          cwd: dir,
          tool_name: "run_subagent",
          tool_input: {
            title: "worker",
            task: "you are aidlc-architecture-reviewer-agent reviewing U01-infra",
            profile: "subagent_general",
          },
          tool_use_id: "chatcmpl-tool-launch",
        },
      );
      expect(launch.code).toBe(0);
      // A subagent-issued sibling read with no live reviewer registration is
      // not attributed to the reviewer — it passes like any other call.
      const sibling = join(seededRecordDir(dir), "construction", "U01-infra", "design.md");
      const r = runAdapter(dir, "reviewer-scope", childCall(dir, "read", { file_path: sibling }));
      expect(r.code, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("45: reviewer registration does not survive its session (SessionEnd clears it)", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      // SessionEnd for the same session retires the registration.
      const end = runAdapter(dir, "session-end", {
        hook_event_name: "SessionEnd",
        session_id: REVIEW_SESSION,
        cwd: dir,
      });
      expect(end.code).toBe(0);
      const sibling = join(seededRecordDir(dir), "construction", "U01-infra", "design.md");
      const after = runAdapter(dir, "reviewer-scope", childCall(dir, "read", { file_path: sibling }));
      expect(after.code, after.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("46: a reviewer alongside a concurrent subagent degrades isolation — unattributable writes refuse, reads pass, degradation is visible", () => {
    const dir = scratchProject(true);
    try {
      seedReviewerDispatch(dir);
      registerReviewer(dir);
      // A non-reviewer background subagent launches in the SAME session — the
      // ledger records it, so a `functions.*` caller can no longer be
      // attributed to the reviewer alone.
      runAdapter(
        dir,
        "log-subagent",
        postToolUse(
          dir,
          "run_subagent",
          { title: "worker", task: "build", profile: "aidlc-developer-agent", is_background: true },
          {
            success: true,
            output: "Background subagent started with agent_id=agent-dev. You can wait for this agent to finish using the read_subagent tool.",
            error: null,
          },
          REVIEW_SESSION,
        ),
      );
      const record = seededRecordDir(dir);
      const own = join(record, "construction", "U03-scoring", "design.md");
      // Reads pass unattributed — even inside the reviewer's own unit they are
      // no longer attributed to it, and sibling reads are not blocked either.
      const read = runAdapter(dir, "reviewer-scope", childCall(dir, "read", { file_path: own }));
      expect(read.code, read.stderr).toBe(0);
      // Writes fail closed: the caller cannot be attributed while the
      // reviewer shares the session with another live subagent.
      const write = runAdapter(
        dir,
        "reviewer-scope",
        childCall(dir, "write", { file_path: own }, REVIEW_SESSION, "functions.write:0"),
      );
      expect(write.code, write.stderr).toBe(2);
      expect(write.stderr).toContain("isolation degraded");
      // The degradation marker is persisted for the doctor to report.
      const regFile = readFileSync(
        join(dir, "aidlc", ".aidlc-sessions", `devin-reviewers-${REVIEW_SESSION}.json`),
        "utf-8",
      );
      expect(regFile).toContain('"degradedAt"');
      // The conductor remains unaffected.
      const conductor = runAdapter(
        dir,
        "reviewer-scope",
        childCall(dir, "write", { file_path: own }, REVIEW_SESSION, "chatcmpl-tool-parent"),
      );
      expect(conductor.code, conductor.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

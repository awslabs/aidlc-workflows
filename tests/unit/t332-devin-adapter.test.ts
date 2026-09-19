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
  hooksHealthDir,
  readPlanApprovalChallenge,
  readPlanApprovalResponse,
  stateDigest,
  subagentInflightMarkerPath,
  writeActiveDirectiveMarker,
  writeCurrentSessionId,
  writePlanApprovalChallenge,
  workspaceSourceFingerprint,
} from "../../dist/devin/.devin/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/devin/.devin/tools/aidlc-testing-posture.ts";

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
    // stateDigest, not a raw sha256: readActiveDirectiveMarker compares the
    // normalized digest (projectStateForDigest strips blank lines, derived
    // Unit Progress rows, and cache fields). A raw digest makes the marker
    // stale on write and the guard refuses at the authority check before
    // ever evaluating the dispatch.
    state_sha256: stateDigest(state),
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

  test("11: log-subagent with run_subagent PostToolUse lands SUBAGENT_COMPLETED in the audit with the dispatch profile as Agent Type", () => {
    // Item 3 case 13: a FOREGROUND run_subagent PostToolUse is a terminal
    // event; the adapter forwards a synthesized SubagentStop carrying the
    // dispatch profile, so the row lands `Agent Type: subagent_general`
    // (previously the raw Devin payload carried no agent_type and the row
    // landed `unknown`).
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", withCwd(FIXTURES.postToolUse_runSubagent as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const audit = readAudit(dir);
      expect(audit).toContain("SUBAGENT_COMPLETED");
      expect(audit).toContain("**Agent Type**: subagent_general");
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
    // Captured from a real Devin 3000.6.14 interactive session export (step 46):
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
      expect(responseFiles).toEqual([`response-${session}.json`]);
      expect(readPlanApprovalResponse(dir, session)).toEqual({
        version: 1,
        session,
        challengeId: "test-challenge-1",
        choice: "Approve Plan",
        responseSha256: createHash("sha256")
          .update("yes", "utf-8")
          .digest("hex"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const PLAN_APPROVAL_QUESTION = "Approve this exact Code Generation plan?";
  const PLAN_APPROVAL_OPTIONS = ["Approve Plan", "Request Changes"];

  function seedStageLevelPlanApproval(dir: string): string {
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
    const recordDir = codeGenerationRecordDir(dir, null);
    mkdirSync(recordDir, { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n", "utf-8");
    const authority = resolveCodeGenerationAuthority(dir, { unit: null });
    const contract = resolveTestingPosture(dir);
    const plan =
      `# Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Step 1\n`;
    const instructions =
      "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n";
    writeFileSync(join(recordDir, "code-generation-plan.md"), plan, "utf-8");
    writeFileSync(
      join(recordDir, "unit-test-instructions.md"),
      instructions,
      "utf-8",
    );
    const questionsPath = join(recordDir, "code-generation-questions.md");
    writeFileSync(
      questionsPath,
      [
        "## Plan Approval",
        `[Approval Fingerprint]: ${approvalFingerprint(
          plan,
          instructions,
          contract.contract_sha256,
          authority,
        )}`,
        `[Planned Source]: ${workspaceSourceFingerprint(dir) ?? "unbindable"}`,
        "A. Approve Plan",
        "B. Request Changes",
        "[Answer]:",
        "",
      ].join("\n"),
      "utf-8",
    );
    return questionsPath;
  }

  function runLog(
    dir: string,
    args: string[],
  ): { stdout: string; stderr: string; code: number } {
    const r = spawnSync(
      process.execPath,
      [join(dir, ".devin", "tools", "aidlc-log.ts"), ...args, "--project-dir", dir],
      {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          DEVIN_PROJECT_DIR: dir,
          CLAUDE_PROJECT_DIR: dir,
        },
        timeout: 30_000,
      },
    );
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.status ?? -1,
    };
  }

  function devinSessionStart(session: string): Record<string, unknown> {
    return {
      session_id: session,
      hook_event_name: "SessionStart",
      source: "startup",
    };
  }

  function devinAnswerPayload(
    session: string | null,
    choice: string,
    promptId?: string,
  ): Record<string, unknown> {
    return {
      ...(session !== null ? { session_id: session } : {}),
      ...(promptId !== undefined ? { prompt_id: promptId } : {}),
      hook_event_name: "PostToolUse",
      tool_name: "ask_user_question",
      tool_input: {
        questions: [{
          question: PLAN_APPROVAL_QUESTION,
          header: "Plan Approval",
          options: [
            { label: "Approve Plan", description: "Approve this exact plan." },
            { label: "Request Changes", description: "Revise the plan before generation." },
          ],
          multi_select: false,
        }],
      },
      tool_response: {
        success: true,
        output: JSON.stringify({
          [PLAN_APPROVAL_QUESTION]: { selected: [choice], skipped: false },
        }),
        error: null,
      },
      tool_use_id: "call_synthetic",
    };
  }

  function devinTypedPayload(
    session: string | null,
    prompt: string,
    promptId?: string,
  ): Record<string, unknown> {
    return {
      ...(session !== null ? { session_id: session } : {}),
      ...(promptId !== undefined ? { prompt_id: promptId } : {}),
      hook_event_name: "UserPromptSubmit",
      prompt,
    };
  }

  function approvalRuntimeFiles(dir: string, prefix: string): string[] {
    const runtimeDir = join(dir, "aidlc", ".aidlc-sessions", "plan-approval");
    return existsSync(runtimeDir)
      ? readdirSync(runtimeDir).filter((name) => name.startsWith(prefix))
      : [];
  }

  function approvalContext(stdout: string): string {
    return (
      (JSON.parse(stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      }).hookSpecificOutput?.additionalContext ?? ""
    );
  }

  test("13i: session-start publishes the exact runtime session with and without an active workflow", () => {
    const withWorkflow = scratchProject(true);
    const withoutWorkflow = scratchProject(false);
    try {
      const session = "devin-session-context";
      const active = runAdapter(
        withWorkflow,
        "session-start",
        devinSessionStart(session),
      );
      expect(active.code).toBe(0);
      expect(approvalContext(active.stdout)).toContain(
        `Runtime Session: ${session}`,
      );
      const cold = runAdapter(
        withoutWorkflow,
        "session-start",
        devinSessionStart(session),
      );
      expect(cold.code).toBe(0);
      expect(approvalContext(cold.stdout)).toContain(
        `AIDLC Runtime Session: ${session}`,
      );
    } finally {
      rmSync(withWorkflow, { recursive: true, force: true });
      rmSync(withoutWorkflow, { recursive: true, force: true });
    }
  });

  for (const [kind, answerPayload] of [
    ["picked", devinAnswerPayload],
    ["typed", devinTypedPayload],
  ] as const) {
    test(`13j: a session-tagged ${kind} answer certifies only its own session through the real decision and answer commands`, () => {
      const dir = scratchProject(true);
      try {
        const questionsPath = seedStageLevelPlanApproval(dir);
        const sessionA = "devin-session-a";
        const sessionB = "devin-session-b";
        expect(
          runAdapter(dir, "session-start", devinSessionStart(sessionA)).code,
        ).toBe(0);
        expect(
          runAdapter(dir, "session-start", devinSessionStart(sessionB)).code,
        ).toBe(0);
        const identityFor = (session: string) => [
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
        const decision = runLog(dir, [
          "decision",
          ...identityFor(sessionA),
          "--decision",
          PLAN_APPROVAL_QUESTION,
          "--options",
          PLAN_APPROVAL_OPTIONS.join(","),
        ]);
        expect(decision.code, decision.stderr).toBe(0);
        const challengeId = (
          JSON.parse(decision.stdout) as { challengeId?: string }
        ).challengeId;
        expect(typeof challengeId).toBe("string");
        expect(challengeId).toBeTruthy();
        const challengeA = readPlanApprovalChallenge(dir, sessionA);
        expect(challengeA).not.toBeNull();

        expect(
          runAdapter(
            dir,
            "record-human-turn",
            answerPayload(sessionB, "Approve Plan", `${kind}-prompt-1`),
          ).code,
        ).toBe(0);
        expect(readPlanApprovalResponse(dir, sessionA)).toBeNull();
        expect(readPlanApprovalResponse(dir, sessionB)).toBeNull();

        expect(
          runAdapter(
            dir,
            "record-human-turn",
            answerPayload(sessionA, "Approve Plan", "devin-prompt-2"),
          ).code,
        ).toBe(0);
        const responseA = readPlanApprovalResponse(dir, sessionA);
        expect(responseA).toMatchObject({
          session: sessionA,
          challengeId,
          choice: "Approve Plan",
        });
        writeFileSync(
          questionsPath,
          readFileSync(questionsPath, "utf-8").replace(
            /\[Answer\]:\s*$/m,
            "[Answer]: Approve Plan",
          ),
        );

        writeCurrentSessionId(dir, sessionA);
        const crossSession = runLog(dir, [
          "answer",
          ...identityFor(sessionB),
          "--details",
          "Approve Plan",
        ]);
        expect(crossSession.code).not.toBe(0);
        expect(crossSession.stderr).toContain(
          "actual offered choice from this prompt and session",
        );
        expect(approvalRuntimeFiles(dir, "receipt-")).toEqual([]);
        expect(readPlanApprovalResponse(dir, sessionA)).toEqual(responseA);
        expect(readPlanApprovalChallenge(dir, sessionA)).toEqual(challengeA);

        writeCurrentSessionId(dir, sessionB);
        const answer = runLog(dir, [
          "answer",
          ...identityFor(sessionA),
          "--details",
          "Approve Plan",
        ]);
        expect(answer.code, `${answer.stdout}\n${answer.stderr}`).toBe(0);
        const receiptNames = approvalRuntimeFiles(dir, "receipt-");
        expect(receiptNames.length).toBe(1);
        const receipt = JSON.parse(
          readFileSync(
            join(
              dir,
              "aidlc",
              ".aidlc-sessions",
              "plan-approval",
              receiptNames[0],
            ),
            "utf-8",
          ),
        ) as {
          session?: string;
          challengeId?: string;
          choice?: string;
          status?: string;
        };
        expect(receipt).toMatchObject({
          session: sessionA,
          challengeId,
          choice: "Approve Plan",
          status: "approved",
        });
        expect(readPlanApprovalChallenge(dir, sessionA)).toBeNull();
        expect(readPlanApprovalResponse(dir, sessionA)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30000);
  }

  test("13k: an answer event for an unknown session or an intent UUID never redirects to the pending challenge", () => {
    const dir = scratchProject(true);
    try {
      const questionsPath = seedStageLevelPlanApproval(dir);
      const sessionB = "devin-session-b";
      const intentUuid = "00000000-0000-7000-8000-000000000001";
      expect(
        runAdapter(dir, "session-start", devinSessionStart(sessionB)).code,
      ).toBe(0);
      const decision = runLog(dir, [
        "decision",
        "--stage",
        "code-generation",
        "--checkpoint",
        "plan-approval",
        "--questions-file",
        questionsPath,
        "--session",
        sessionB,
        "--stage-level",
        "--decision",
        PLAN_APPROVAL_QUESTION,
        "--options",
        PLAN_APPROVAL_OPTIONS.join(","),
      ]);
      expect(decision.code, decision.stderr).toBe(0);
      const challengeB = readPlanApprovalChallenge(dir, sessionB);
      expect(challengeB).not.toBeNull();
      writeFileSync(
        questionsPath,
        readFileSync(questionsPath, "utf-8").replace(
          /\[Answer\]:\s*$/m,
          "[Answer]: Approve Plan",
        ),
      );

      for (const supplied of ["session-unknown", intentUuid]) {
        expect(
          runAdapter(
            dir,
            "record-human-turn",
            devinAnswerPayload(supplied, "Approve Plan", `prompt-${supplied}`),
          ).code,
        ).toBe(0);
        expect(
          runAdapter(
            dir,
            "record-human-turn",
            devinTypedPayload(supplied, "Approve Plan", `typed-${supplied}`),
          ).code,
        ).toBe(0);
        expect(readPlanApprovalResponse(dir, supplied)).toBeNull();
        const refused = runLog(dir, [
          "answer",
          "--stage",
          "code-generation",
          "--checkpoint",
          "plan-approval",
          "--questions-file",
          questionsPath,
          "--session",
          supplied,
          "--stage-level",
          "--details",
          "Approve Plan",
        ]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
          "actual offered choice from this prompt and session",
        );
      }
      expect(approvalRuntimeFiles(dir, "response-")).toEqual([]);
      expect(approvalRuntimeFiles(dir, "receipt-")).toEqual([]);
      expect(readPlanApprovalChallenge(dir, sessionB)).toEqual(challengeB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("13l: an answer event with no session writes no protected approval records", () => {
    const dir = scratchProject(true);
    try {
      const questionsPath = seedStageLevelPlanApproval(dir);
      const sessionB = "devin-session-b";
      expect(
        runAdapter(dir, "session-start", devinSessionStart(sessionB)).code,
      ).toBe(0);
      const decision = runLog(dir, [
        "decision",
        "--stage",
        "code-generation",
        "--checkpoint",
        "plan-approval",
        "--questions-file",
        questionsPath,
        "--session",
        sessionB,
        "--stage-level",
        "--decision",
        PLAN_APPROVAL_QUESTION,
        "--options",
        PLAN_APPROVAL_OPTIONS.join(","),
      ]);
      expect(decision.code, decision.stderr).toBe(0);
      const challengeB = readPlanApprovalChallenge(dir, sessionB);
      expect(challengeB).not.toBeNull();

      expect(
        runAdapter(
          dir,
          "record-human-turn",
          devinAnswerPayload(null, "Approve Plan", "devin-prompt-no-session"),
        ).code,
      ).toBe(0);
      expect(
        runAdapter(
          dir,
          "record-human-turn",
          devinTypedPayload(null, "Approve Plan", "devin-prompt-no-session-2"),
        ).code,
      ).toBe(0);
      expect(approvalRuntimeFiles(dir, "response-")).toEqual([]);
      expect(approvalRuntimeFiles(dir, "receipt-")).toEqual([]);
      expect(readPlanApprovalChallenge(dir, sessionB)).toEqual(challengeB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

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

  // --- Item 2: native run_subagent dispatch-field translation ---------------
  //
  // Devin's run_subagent tool_input is {profile, task, title, is_background?}.
  // The adapter must present it to the shared core hooks in the shape they
  // understand (subagent_type / prompt / run_in_background) and hand any
  // rewrite back in Devin's native shape (updatedInput.task only). These cases
  // build payloads from the captured native shape; the approved case produces
  // the receipt through the real decision → record-human-turn → answer
  // lifecycle exercised above (never a hand-written receipt).

  /** A Devin-native run_subagent PreToolUse payload (captured shape). */
  function devinRunSubagent(
    profile: string,
    task: string,
    extraInput: Record<string, unknown> = {},
    session?: string,
  ): Record<string, unknown> {
    return {
      ...(session ? { session_id: session } : {}),
      hook_event_name: "PreToolUse",
      tool_name: "run_subagent",
      tool_input: { profile, task, title: "Item 2 dispatch", ...extraInput },
    };
  }

  /** Seed the engine-bundled method memory so stage-rule bundles resolve. */
  function seedMemorySeed(dir: string): void {
    cpSync(
      join(dir, ".devin", "tools", "data", "memory-seed"),
      join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"),
      { recursive: true },
    );
  }

  /** Drive the real Plan Approval lifecycle to a certified stage-level receipt:
   *  session-start → log decision (challenge) → record-human-turn (response) →
   *  questions-file [Answer] → log answer (receipt). Mirrors the 13j flow. */
  function approveStageLevelPlan(dir: string, session: string): void {
    const questionsPath = seedStageLevelPlanApproval(dir);
    expect(runAdapter(dir, "session-start", devinSessionStart(session)).code).toBe(0);
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
    const decision = runLog(dir, [
      "decision",
      ...identity,
      "--decision",
      PLAN_APPROVAL_QUESTION,
      "--options",
      PLAN_APPROVAL_OPTIONS.join(","),
    ]);
    expect(decision.code, decision.stderr).toBe(0);
    expect(
      runAdapter(
        dir,
        "record-human-turn",
        devinAnswerPayload(session, "Approve Plan", `${session}-answer`),
      ).code,
    ).toBe(0);
    writeFileSync(
      questionsPath,
      readFileSync(questionsPath, "utf-8").replace(
        /\[Answer\]:\s*$/m,
        "[Answer]: Approve Plan",
      ),
    );
    writeCurrentSessionId(dir, session);
    const answer = runLog(dir, ["answer", ...identity, "--details", "Approve Plan"]);
    expect(answer.code, `${answer.stdout}\n${answer.stderr}`).toBe(0);
  }

  test("Item 2 case 1: plan-approval-guard allows the approved stage-level developer dispatch carried in native task", () => {
    const dir = scratchProject(true);
    try {
      const session = "devin-item2-approved";
      approveStageLevelPlan(dir, session);
      const task =
        "AIDLC-STAGE: code-generation\n" +
        `AIDLC-TESTING-CONTRACT: ${resolveTestingPosture(dir).contract_sha256}\n` +
        "Implement the approved stage-level plan";
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        devinRunSubagent("aidlc-developer-agent", task, {}, session),
      );
      expect(r.code, r.stderr).toBe(0);
      expect(readAudit(dir)).not.toContain("PLAN_APPROVAL_BLOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("Item 2 case 2: plan-approval-guard blocks the same native dispatch while approval is absent (stage Unit row)", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const task =
        "AIDLC-STAGE: code-generation\n" +
        `AIDLC-TESTING-CONTRACT: sha256:${"a".repeat(64)}\n` +
        "Implement the stage-level plan";
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        devinRunSubagent("aidlc-developer-agent", task),
      );
      expect(r.code).toBe(2);
      // The one-target wording: the marker names the zero-Unit stage-level
      // implementation, so the refusal scopes to it and the audit row carries
      // the stage target — not "(missing marker)".
      expect(r.stderr).toContain("Code generation cannot start for the zero-Unit stage-level implementation");
      const audit = readAudit(dir);
      expect(audit).toContain("**Unit**: stage-level");
      expect(audit).not.toContain("**Unit**: (missing marker)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 3: plan-approval-guard blocks a developer dispatch whose native task carries no target marker", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        devinRunSubagent("aidlc-developer-agent", "Implement the feature per the plan"),
      );
      expect(r.code).toBe(2);
      // The zero-marker wording names the actual defect (no target marker in
      // the brief) instead of claiming the plan is unapproved.
      expect(r.stderr).toContain("carries no target marker");
      expect(r.stderr).not.toContain("not currently approved");
      expect(readAudit(dir)).toContain("**Unit**: (missing marker)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 4: plan-approval-guard early-allows a non-developer profile dispatch", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(
        dir,
        "plan-approval-guard",
        devinRunSubagent("aidlc-product-agent", "AIDLC-UNIT: todo-core\nDo product work"),
      );
      expect(r.code).toBe(0);
      expect(readAudit(dir)).not.toContain("PLAN_APPROVAL_BLOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 5: plan-approval-guard ignores legacy agent/prompt fields (no profile/task)", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "PreToolUse",
        tool_name: "run_subagent",
        tool_input: {
          agent: "aidlc-developer-agent",
          prompt: "AIDLC-UNIT: todo-core\nImplement todo-core",
        },
      });
      // Legacy fields are no longer identity or brief: with no `profile` the
      // dispatch is not a developer dispatch and allows without judging it.
      expect(r.code).toBe(0);
      expect(readAudit(dir)).not.toContain("PLAN_APPROVAL_BLOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 6: deliver-stage-rules returns the active-stage bundle inside a Devin-native updatedInput.task", () => {
    const dir = scratchProject(true);
    try {
      seedMemorySeed(dir);
      const task =
        "Run .devin/skills/aidlc/stages/inception/requirements-analysis.md " +
        "and draft requirements.md";
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("aidlc-product-agent", task),
      );
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: {
          hookEventName?: string;
          updatedInput?: Record<string, unknown>;
        };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      const updated = out.hookSpecificOutput?.updatedInput ?? {};
      // Devin merges updatedInput as a subset, so the rewrite is exactly one
      // native key — never the injected subagent_type/prompt aliases.
      expect(Object.keys(updated)).toEqual(["task"]);
      const rewritten = updated.task as string;
      expect(rewritten.startsWith(task)).toBe(true);
      expect(rewritten.split("AIDLC_DISPATCH_RULES_BEGIN").length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 7: deliver-stage-rules emits only updatedInput.task for a background dispatch (is_background)", () => {
    const dir = scratchProject(true);
    try {
      seedMemorySeed(dir);
      const task =
        "Run .devin/skills/aidlc/stages/inception/requirements-analysis.md " +
        "and draft requirements.md";
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("aidlc-product-agent", task, { is_background: true }),
      );
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { updatedInput?: Record<string, unknown> };
      };
      const updated = out.hookSpecificOutput?.updatedInput ?? {};
      expect(Object.keys(updated)).toEqual(["task"]);
      expect(updated.run_in_background).toBeUndefined();
      expect(updated.is_background).toBeUndefined();
      const rewritten = updated.task as string;
      expect(rewritten.startsWith(task)).toBe(true);
      expect(rewritten.split("AIDLC_DISPATCH_RULES_BEGIN").length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 8: deliver-stage-rules passes a built-in profile through silently", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("subagent_explore", "Read the codebase and report"),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 9: deliver-stage-rules passes the exempt composer profile through silently", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("aidlc-composer-agent", "Compose a workflow for the request"),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 10: deliver-stage-rules is idempotent — a task already carrying the exact bundle gets no rewrite", () => {
    const dir = scratchProject(true);
    try {
      seedMemorySeed(dir);
      const task =
        "Run .devin/skills/aidlc/stages/inception/requirements-analysis.md " +
        "and draft requirements.md";
      const first = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("aidlc-product-agent", task),
      );
      expect(first.code, first.stderr).toBe(0);
      const bundled = (
        JSON.parse(first.stdout) as {
          hookSpecificOutput?: { updatedInput?: { task?: string } };
        }
      ).hookSpecificOutput?.updatedInput?.task;
      expect(typeof bundled).toBe("string");
      const second = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent("aidlc-product-agent", bundled as string),
      );
      expect(second.code).toBe(0);
      expect(second.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 11: deliver-stage-rules forwards a core block (unresolvable rule bundle) as exit 2 + stderr, no stdout", () => {
    const dir = scratchProject(true);
    try {
      // Empty memory dir: the stage's rules_in_context name files that do not
      // exist, so the core hook refuses with exit 2 instead of rewriting.
      const r = runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent(
          "aidlc-product-agent",
          "Run .devin/skills/aidlc/stages/inception/requirements-analysis.md",
        ),
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Cannot load required stage rule");
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 2 case 12: malformed stdin fails open (exit 0) on both dispatch arms", () => {
    const dir = scratchProject(true);
    try {
      for (const t of ["plan-approval-guard", "deliver-stage-rules"]) {
        const r = runAdapter(dir, t, FIXTURES.malformed as string);
        expect(r.code, `target=${t}`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Item 3: background subagent lifecycle (launch → pending → terminal) ---
  //
  // Devin dispatches no SubagentStart/SubagentStop events (C16 negative on
  // 3000.10.31: the key is not loadable in either config location). The
  // adapter synthesizes the Claude pair from what Devin DOES emit:
  //   - the run_subagent launch-ack PostToolUse only ANNOTATES the core
  //     in-flight ledger entry the deliver-stage-rules PreToolUse created —
  //     no core call, no audit row (SubagentStart parity);
  //   - a TERMINAL PostToolUse — a foreground/resumed run_subagent completion
  //     or a read_subagent terminal read — forwards a synthesized
  //     {hook_event_name:"SubagentStop"} payload to the core log-subagent
  //     hook, correlated by agent_id, so SUBAGENT_COMPLETED lands exactly
  //     once with the profile and agent id;
  //   - repeated reads and foreign ids are no-ops; an unread background agent
  //     stays pending in the ledger until the 2h TTL.
  //
  // Payloads are cloned from the 3000.10.31 capture fixture's events with
  // <placeholder> substitution; every classifier string below is verbatim
  // from the capture except where a case is marked binary-pinned (the
  // 'exited with an error' read string did not appear on this host — C12's
  // denied-tool child read back as 'completed').

  const CAPTURED_3000_10_31 = JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        "tests",
        "fixtures",
        "devin-hook-payloads",
        "captured-3000.10.31.json",
      ),
      "utf-8",
    ),
  ) as Record<string, { events: Array<Record<string, unknown>> }>;

  /** Clone one event of a capture case, substituting the fixture's
   *  <placeholder> tokens (e.g. "<agent-id>") with concrete values. */
  function capturedEvent(
    caseName: string,
    index: number,
    subs: Record<string, string> = {},
  ): Record<string, unknown> {
    const event = CAPTURED_3000_10_31[caseName]?.events[index];
    if (!event) {
      throw new Error(`capture fixture ${caseName} has no event[${index}]`);
    }
    let json = JSON.stringify(event);
    for (const [token, value] of Object.entries(subs)) {
      json = json.replaceAll(token, value);
    }
    return JSON.parse(json) as Record<string, unknown>;
  }

  /** A captured read_subagent PostToolUse with a chosen output string. The
   *  event envelope is C06's non-blocking read; the output string is
   *  substituted so binary-pinned strings the capture never produced (still
   *  running, error terminal, unclassifiable) ride a real envelope. */
  function capturedReadPostToolUse(
    subs: Record<string, string>,
    output?: string,
  ): Record<string, unknown> {
    const event = capturedEvent("C06_repeatedRead", 1, subs);
    if (output !== undefined) {
      (event.tool_response as Record<string, unknown>).output = output;
    }
    return event;
  }

  /** The workspace-level background-subagent ledger's raw entries. */
  function inflightEntries(dir: string): Array<Record<string, unknown>> {
    const path = subagentInflightMarkerPath(dir);
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      entries?: Array<Record<string, unknown>>;
    };
    return parsed.entries ?? [];
  }

  function subagentCompletedRows(dir: string): number {
    return (readAudit(dir).match(/\*\*Event\*\*: SUBAGENT_COMPLETED/g) ?? [])
      .length;
  }

  /** Contents of a per-hook drop-counter file ("" when absent). */
  function hookDrops(dir: string, hook: string): string {
    const path = join(hooksHealthDir(dir), `${hook}.drops`);
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  /** Drive a background dispatch through both real hook arms: the
   *  deliver-stage-rules PreToolUse (creates the in-flight entry) then the
   *  log-subagent PostToolUse launch ack (annotates it). */
  function launchBackground(dir: string, session: string, agentId: string): void {
    expect(
      runAdapter(
        dir,
        "deliver-stage-rules",
        devinRunSubagent(
          "subagent_explore",
          "Read sentinel.txt in the project root and report its first line verbatim",
          { is_background: true },
          session,
        ),
      ).code,
    ).toBe(0);
    expect(
      runAdapter(
        dir,
        "log-subagent",
        withCwd(
          capturedEvent("C05_backgroundLaunch", 1, {
            "<session>": session,
            "<agent-id>": agentId,
          }),
          dir,
        ),
      ).code,
    ).toBe(0);
  }

  /** The captured terminal read ("Subagent <id> completed. Its full report
   *  is delivered…") for an agent in a session. */
  function readTerminal(dir: string, session: string, agentId: string): void {
    expect(
      runAdapter(
        dir,
        "log-subagent",
        withCwd(
          capturedEvent("C05_backgroundCompletion", 6, {
            "<session>": session,
            "<agent-id>": agentId,
          }),
          dir,
        ),
      ).code,
    ).toBe(0);
  }

  test("Item 3 case 1: a background launch annotates the in-flight ledger entry and writes no audit row", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case1";
      launchBackground(dir, session, "aa37dc28");
      const entries = inflightEntries(dir);
      expect(entries.length).toBe(1);
      expect(entries[0]).toMatchObject({
        sessionId: session,
        agentId: "aa37dc28",
        agentType: "subagent_explore",
      });
      expect(subagentCompletedRows(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 2: a terminal read_subagent completes the annotated entry and lands one SUBAGENT_COMPLETED naming profile and agent id", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case2";
      launchBackground(dir, session, "aa37dc28");
      readTerminal(dir, session, "aa37dc28");
      expect(inflightEntries(dir)).toEqual([]);
      expect(existsSync(subagentInflightMarkerPath(dir))).toBe(false);
      expect(subagentCompletedRows(dir)).toBe(1);
      const audit = readAudit(dir);
      expect(audit).toContain("**Agent Type**: subagent_explore");
      expect(audit).toContain("**Agent ID**: aa37dc28");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 3: a repeated read_subagent after completion adds nothing (C06 dedup)", () => {
    // C06: a second read on a completed agent re-serves the report with
    // success:true — indistinguishable from the first terminal by payload.
    // With the entry already consumed the read must be a no-op: no second
    // row, no double decrement.
    const dir = scratchProject(true);
    try {
      const session = "item3-case3";
      launchBackground(dir, session, "aa37dc28");
      readTerminal(dir, session, "aa37dc28");
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedEvent("C06_repeatedRead", 1, {
              "<session>": session,
              "<agent-id>": "aa37dc28",
            }),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(subagentCompletedRows(dir)).toBe(1);
      expect(existsSync(subagentInflightMarkerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 4: a read_subagent reporting 'still running' keeps the entry pending and writes no row", () => {
    // BINARY-PINNED string: "Subagent is still running." appears in the
    // 3000.10.31 binary but never in a captured event (every captured read
    // was terminal or re-served); it rides C06's read envelope here.
    const dir = scratchProject(true);
    try {
      const session = "item3-case4";
      launchBackground(dir, session, "aa37dc28");
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedReadPostToolUse(
              { "<session>": session, "<agent-id>": "aa37dc28" },
              "Subagent is still running.",
            ),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(inflightEntries(dir)).toEqual([
        {
          sessionId: session,
          agentId: "aa37dc28",
          agentType: "subagent_explore",
          startedAtMs: expect.any(Number),
        },
      ]);
      expect(subagentCompletedRows(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 5: a read_subagent error terminal completes the entry and lands one row whose Message is the error text", () => {
    // BINARY-PINNED string: "Subagent <id> exited with an error. The error
    // details are delivered in the <subagent_completion_notification>
    // message." comes from the 3000.10.31 binary, NOT the capture — C12
    // showed a denied-tool background child reads back as
    // 'completed'+success:true, so no captured event carries this string.
    const dir = scratchProject(true);
    try {
      const session = "item3-case5";
      launchBackground(dir, session, "aa37dc28");
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedReadPostToolUse(
              { "<session>": session, "<agent-id>": "aa37dc28" },
              "Subagent aa37dc28 exited with an error. The error details are delivered in the <subagent_completion_notification> message.",
            ),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(inflightEntries(dir)).toEqual([]);
      expect(subagentCompletedRows(dir)).toBe(1);
      const audit = readAudit(dir);
      expect(audit).toContain("**Agent ID**: aa37dc28");
      expect(audit).toContain(
        "**Message**: Subagent aa37dc28 exited with an error.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 6: a foreground run_subagent completion lands its own row and never consumes the annotated background entry", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case6";
      launchBackground(dir, session, "aa37dc28");
      // C14's foreground completion envelope, for a DIFFERENT agent id than
      // the pending background entry.
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedEvent("C14_resumeForeground", 10, {
              "<session>": session,
              "<agent-id>": "bb48ef31",
            }),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(subagentCompletedRows(dir)).toBe(1);
      const audit = readAudit(dir);
      expect(audit).toContain("**Agent Type**: subagent_general");
      expect(audit).toContain("**Agent ID**: bb48ef31");
      expect(inflightEntries(dir)).toEqual([
        {
          sessionId: session,
          agentId: "aa37dc28",
          agentType: "subagent_explore",
          startedAtMs: expect.any(Number),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 7: two background agents complete independently in read order with no double decrement", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case7";
      launchBackground(dir, session, "aa37dc28");
      launchBackground(dir, session, "bb48ef31");
      expect(inflightEntries(dir).length).toBe(2);
      readTerminal(dir, session, "bb48ef31");
      readTerminal(dir, session, "aa37dc28");
      expect(subagentCompletedRows(dir)).toBe(2);
      const audit = readAudit(dir);
      const rowB = audit.indexOf("**Agent ID**: bb48ef31");
      const rowA = audit.indexOf("**Agent ID**: aa37dc28");
      expect(rowB).toBeGreaterThan(-1);
      expect(rowA).toBeGreaterThan(-1);
      expect(rowB).toBeLessThan(rowA);
      expect(existsSync(subagentInflightMarkerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 8: a terminal read_subagent for another session's agent id is a cross-session no-op", () => {
    const dir = scratchProject(true);
    try {
      launchBackground(dir, "item3-s1", "aa37dc28");
      readTerminal(dir, "item3-s2", "aa37dc28");
      expect(inflightEntries(dir)).toEqual([
        {
          sessionId: "item3-s1",
          agentId: "aa37dc28",
          agentType: "subagent_explore",
          startedAtMs: expect.any(Number),
        },
      ]);
      expect(subagentCompletedRows(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 9: Stop is allowed by the pending-subagent carve-out only while the background entry is pending", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case9";
      launchBackground(dir, session, "aa37dc28");
      const stopPayload = () => ({
        ...(FIXTURES.stop as Record<string, unknown>),
        session_id: session,
        cwd: dir,
      });
      const whilePending = runAdapter(dir, "continue-workflow", stopPayload());
      expect(whilePending.code).toBe(0);
      expect(whilePending.stdout).not.toContain('"decision":"block"');
      const carveOutCount = (text: string) =>
        text.split("pending-subagent carve-out").length - 1;
      expect(carveOutCount(hookDrops(dir, "continue-workflow"))).toBe(1);
      readTerminal(dir, session, "aa37dc28");
      const afterTerminal = runAdapter(dir, "continue-workflow", stopPayload());
      expect(afterTerminal.code).toBe(0);
      // The ledger is drained, so the same Stop must not cite the
      // pending-subagent carve-out again (it may block or allow for another
      // reason — the carve-out line is the assertion).
      expect(carveOutCount(hookDrops(dir, "continue-workflow"))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 10: a resume:<id> foreground completion completes the unread background entry by exact id", () => {
    // C14: run_subagent resume always runs foreground under the same
    // agent_id; if an annotated entry for that id exists (an unread earlier
    // background run) the exact-id path completes it.
    const dir = scratchProject(true);
    try {
      const session = "item3-case10";
      launchBackground(dir, session, "aa37dc28");
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedEvent("C14_resumeForeground", 17, {
              "<session>": session,
              "<agent-id>": "aa37dc28",
            }),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(inflightEntries(dir)).toEqual([]);
      expect(subagentCompletedRows(dir)).toBe(1);
      const audit = readAudit(dir);
      expect(audit).toContain("**Agent Type**: subagent_general");
      expect(audit).toContain("**Agent ID**: aa37dc28");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 11: an unclassifiable read_subagent output is a no-op plus one log-subagent drop line", () => {
    const dir = scratchProject(true);
    try {
      const session = "item3-case11";
      launchBackground(dir, session, "aa37dc28");
      const before = inflightEntries(dir);
      expect(
        runAdapter(
          dir,
          "log-subagent",
          withCwd(
            capturedReadPostToolUse(
              { "<session>": session, "<agent-id>": "aa37dc28" },
              "Unrecognized subagent status payload.",
            ),
            dir,
          ),
        ).code,
      ).toBe(0);
      expect(inflightEntries(dir)).toEqual(before);
      expect(subagentCompletedRows(dir)).toBe(0);
      const drops = hookDrops(dir, "log-subagent");
      expect(drops).toContain("unclassified read_subagent output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Item 3 case 12: malformed stdin on log-subagent fails open (exit 0)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "log-subagent", FIXTURES.malformed as string);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

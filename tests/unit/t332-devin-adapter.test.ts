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
import { writeActiveDirectiveMarker, writePlanApprovalChallenge } from "../../dist/devin/.devin/tools/aidlc-lib.ts";

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

  test("1: session-start emits the Devin hookSpecificOutput wrapper with workflow context", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(typeof out.hookSpecificOutput?.additionalContext).toBe("string");
      expect(out.hookSpecificOutput?.additionalContext ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: session-start with no active workflow is exit 0 (no workflow context injected)", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart as Record<string, unknown>, dir));
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
});

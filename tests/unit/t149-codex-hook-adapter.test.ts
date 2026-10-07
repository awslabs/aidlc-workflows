// t149-codex-hook-adapter: the Codex stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-continue-workflow.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-sync-workflow-state.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-write-audit-log.ts, hook:aidlc-plan-approval-guard, function:hasExplicitHumanSelection, function:emptyPickerResult, audit:QUESTION_UNANSWERED
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
//   sync-workflow-state        → update_plan in_progress step with "[slug]" suffix
//                       dispatches set-status (Current Stage updates).
//   log-subagent      → SUBAGENT_COMPLETED in the audit.
//   duplicate delivery → the second identical stdin replays the first
//                       response (the ×2 idempotency contract) — the audit
//                       gains NO second row.
//   malformed stdin   → fail-open exit 0 (advisory contract).
//   record-human-turn -> a subagent's prompt (it carries agent_id) is not the
//                       person's turn: no HUMAN_TURN, no kept words (#1411).
//   record-human-turn -> a question box that ran out ({"answers":{}}) records
//                       QUESTION_UNANSWERED, which spends the turn before it,
//                       and tells the agent to ask again.
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as kiro's t142.)

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
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
import {
  createIntent,
  engineDir,
  humanActedSinceGate,
  humanTurnMarkerPath,
  humanTurnState,
  personsGateFeedback,
  readSessionBinding,
  sessionsDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  writeSessionBinding,
  writeSessionPidEntry,
  writeActiveDirectiveMarker,
  stateDigest,
} from "../../core/tools/aidlc-lib.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { envWithoutCommandOnPath } from "../harness/test-command-paths.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const FIXTURES = JSON.parse(
  readFileSync(join(REPO_ROOT, "tests", "fixtures", "codex-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, Record<string, unknown>>;

// P9 per-intent layout: the CORE hooks the Codex adapter shims to (write-audit-log,
// session-start/end, log-subagent, set-status) resolve state via stateFilePath()
// and the audit trail via auditFilePath() — under the active intent's record. So
// the scratch project seeds the per-intent shell + the state fixture into the
// default record (so the cursor resolves) + the resolved audit SHARD (pinned
// clone-id so audit reads are deterministic).
// The Codex adapter's session heartbeat lives with the core session stamps at
// aidlc/.aidlc-sessions/, independent of the active-intent cursor. That lets a
// new session reconcile its predecessor after a second intent became active.
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
// A plan-approval-guard stand-in that records what the adapter forwards.
function recordingGuard(capture: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    "export async function run(input: string): Promise<number> {",
    `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
    "  return 0;",
    "}",
    "if (import.meta.main) process.exit(await run(await Bun.stdin.text()));",
  ].join("\n");
}

function forwardedSessions(capture: string): unknown[] {
  return readFileSync(capture, "utf-8").trim().split("\n")
    .map((line) => (JSON.parse(line) as { session_id?: unknown }).session_id);
}

function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t149-")));
  cpSync(CODEX_TREE, join(dir, ".codex"), { recursive: true });
  seedShell(dir);
  seedAidlcMemory(dir);
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

function readRecordAudit(dir: string, record: string): string {
  const auditDir = join(intentsDirOf(dir, DEFAULT_SPACE), record, "audit");
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(auditDir, name), "utf-8"))
    .join("\n");
}

function withCwd(payload: Record<string, unknown>, dir: string): Record<string, unknown> {
  return { ...payload, cwd: dir };
}

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
    state_sha256: stateDigest(state),
  });
  mkdirSync(join(seededRecordDir(dir), "construction", unit, "code-generation"), {
    recursive: true,
  });
}

function activeRecord(dir: string): string {
  return readFileSync(
    join(intentsDirOf(dir, DEFAULT_SPACE), "active-intent"),
    "utf-8",
  ).trim();
}

function runIntentCreate(
  dir: string,
  description: string,
  sessionId?: string,
): { code: number; stdout: string } {
  const result = spawnSync(
    "bun",
    [
      join(dir, ".codex", "tools", "aidlc-utility.ts"),
      "intent-create",
      "--scope",
      "poc",
      "--arguments",
      description,
      "--project-dir",
      dir,
    ],
    {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: undefined,
        ...(sessionId ? { AIDLC_SESSION_OVERRIDE: sessionId, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" } : {}),
      } as NodeJS.ProcessEnv,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
  };
}

/** Remap a captured apply_patch payload's `aidlc-docs/` paths (a verbatim
 *  pre-workspace capture) to the active intent's record-relative prefix, so the
 *  per-intent write-audit-log gate sees the write under the record root. Rewrites
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
  envOverrides: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number; pid: number } {
  if (target === "record-human-turn" && payload !== null && typeof payload === "object") {
    const session = (payload as { session_id?: unknown }).session_id;
    if (typeof session === "string") writeSessionPidEntry(projectDir, process.pid, session);
  }
  const r = spawnSync(
    "bun",
    [join(projectDir, ".codex", "hooks", "aidlc-codex-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_UNATTENDED: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        CODEX_THREAD_ID: undefined,
        CODEX_SESSION_ID: undefined,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? -1,
    pid: r.pid ?? -1,
  };
}

function structuredSelectionPayload(
  dir: string,
  toolResponse: unknown,
  turn = "structured-turn",
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "codex-structured-session",
    turn_id: turn,
    cwd: dir,
    tool_name: "request_user_input",
    tool_input: {
      questions: [{ id: "decision", question: "Approve?", options: ["Approve", "Reject"] }],
    },
    tool_response: toolResponse,
    tool_use_id: `request-${turn}`,
  };
}

function humanTurnCount(dir: string): number {
  return readAudit(dir).split("**Event**: HUMAN_TURN").length - 1;
}

describe("t149 Codex structured request_user_input presence", () => {
  test("an unattended structured selection does not mint HUMAN_TURN", () => {
    const dir = scratchProject(true);
    try {
      const unattended = structuredSelectionPayload(
        dir,
        JSON.stringify({ answers: { decision: { answers: ["Approve"] } } }),
        "unattended-turn",
      );
      expect(
        runAdapter(dir, "record-human-turn", unattended, {
          AIDLC_UNATTENDED: "1",
        }).code,
      ).toBe(0);
      expect(humanTurnCount(dir)).toBe(0);

      const attended = structuredSelectionPayload(
        dir,
        JSON.stringify({ answers: { decision: { answers: ["Approve"] } } }),
        "attended-turn",
      );
      expect(runAdapter(dir, "record-human-turn", attended).code).toBe(0);
      expect(humanTurnCount(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit nested selection mints exactly one HUMAN_TURN across duplicate delivery", () => {
    const dir = scratchProject(true);
    try {
      const payload = structuredSelectionPayload(dir, JSON.stringify({
        answers: { decision: { answers: ["Approve"] } },
      }));
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      expect(humanTurnCount(dir)).toBe(1);
      expect(humanActedSinceGate(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("what the person put in the box is on record word for word, question by question", () => {
    const dir = scratchProject(true);
    try {
      const words = "Reject: keep the old login page until the new one is tested";
      const payload = structuredSelectionPayload(dir, JSON.stringify({
        answers: { decision: { answers: [words] } },
      }));
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      const replied = readAudit(dir).split("\n## ").filter((block) => block.includes("**Event**: QUESTION_REPLIED"));
      expect(replied).toHaveLength(1);
      expect(replied[0]).toContain("**Question**: Approve?");
      expect(replied[0]).toContain(`**Reply**: ${words}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("substantive Codex answer arrays mint, including opaque question IDs and cancellation words in prose", () => {
    for (const [index, answer] of ["Approve", "cancel the standing order via cron"].entries()) {
      const dir = scratchProject(true);
      try {
        const payload = structuredSelectionPayload(
          dir,
          JSON.stringify({
            answers: { [index === 0 ? "error" : "decision"]: { answers: [answer] } },
          }),
          `direct-${index}`,
        );
        expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
        expect(humanTurnCount(dir)).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("an explicit Abort option is human judgment, not cancellation boilerplate", () => {
    const dir = scratchProject(true);
    try {
      const payload = structuredSelectionPayload(
        dir,
        JSON.stringify({ answers: { decision: { answers: ["Abort"] } } }),
        "explicit-abort",
      );
      const question = ((payload.tool_input as { questions: Array<{ options: string[] }> }).questions[0]);
      question.options.push("Abort");
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      expect(humanTurnCount(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty, cancelled, timed-out, auto-resolved, error, and malformed responses do not mint", () => {
    const responses: unknown[] = [
      "{}",
      JSON.stringify({ status: "completed", answer: "Cancelled" }),
      JSON.stringify({ status: "cancelled", answer: "Approve" }),
      JSON.stringify({ answers: { decision: { answers: ["Approve"] } }, timedOut: true }),
      JSON.stringify({ answers: { decision: { answers: ["Approve"] } }, auto_resolved: true }),
      JSON.stringify({ answers: { decision: { answers: ["Approve"] } }, error: "transport failed" }),
      JSON.stringify({ answers: {} }),
      JSON.stringify({ answers: { decision: { answers: [] } } }),
      JSON.stringify({ answers: { decision: { answers: ["   "] } } }),
      JSON.stringify({ answers: { decision: { answers: ["Approve", "Dismissed"] } } }),
      JSON.stringify({ answers: { decision: { answers: ["Abort"] } } }),
      JSON.stringify({ answer: "Approve" }),
      JSON.stringify({ selection: "Approve" }),
      "{malformed-json",
      { answers: { decision: { answers: ["Approve"] } } },
      null,
    ];
    const dir = scratchProject(true);
    try {
      for (const [index, response] of responses.entries()) {
        const payload = structuredSelectionPayload(dir, response, `rejected-${index}`);
        expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      }
      expect(humanTurnCount(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a valid selection outside an active workflow is a no-op", () => {
    const dir = scratchProject(false);
    try {
      const payload = structuredSelectionPayload(dir, JSON.stringify({
        answers: { decision: { answers: ["Approve"] } },
      }));
      expect(runAdapter(dir, "record-human-turn", payload).code).toBe(0);
      expect(humanTurnCount(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Measured live on Codex 0.160.0: the person typed a remark, the agent put
  // the next question in the box, the box ran out ({"answers":{}}), and an
  // answer the agent then logged was taken on the remark's turn.
  test("a box that runs out spends the remark before it, so the agent cannot answer for the person", () => {
    const dir = scratchProject(true);
    const answer = (details: string) => spawnSync(
      "bun",
      [join(dir, ".codex", "tools", "aidlc.ts"), "engine", "log", "answer", "--stage", "requirements-analysis", "--details", details],
      {
        cwd: dir,
        encoding: "utf-8",
        // The fixture guard profile skips presence; this case is about presence.
        env: {
          ...process.env,
          AIDLC_UNATTENDED: undefined,
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
          CLAUDE_PROJECT_DIR: undefined,
        } as NodeJS.ProcessEnv,
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      },
    );
    const typed = (turn: string, prompt: string) => runAdapter(dir, "record-human-turn", {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-structured-session",
      turn_id: turn,
      cwd: dir,
      prompt,
    });
    try {
      expect(typed("remark", "Can you ask me that one in the question box?").code).toBe(0);
      expect(humanTurnCount(dir)).toBe(1);

      const expired = structuredSelectionPayload(dir, JSON.stringify({ answers: {} }), "expired");
      const ran = runAdapter(dir, "record-human-turn", expired);
      expect(ran.code, ran.stderr).toBe(0);
      const context = JSON.parse(ran.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(context.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      expect(context.hookSpecificOutput?.additionalContext).toContain("Ask the same question again");
      expect(context.hookSpecificOutput?.additionalContext).toContain("never pick an answer for the person");
      const annex = readFileSync(
        join(REPO_ROOT, "dist", "codex", ".agents", "skills", "aidlc", "question-rendering.md"),
        "utf-8",
      );
      expect(annex.replace(/\s+/g, " ")).toContain(
        "ask the same question again in your reply as numbered prose, not in the box, and end the turn; never pick an answer for the person",
      );
      // Duplicate delivery replays the response and records one row.
      expect(runAdapter(dir, "record-human-turn", expired).code).toBe(0);
      expect(readAudit(dir).split("**Event**: QUESTION_UNANSWERED").length - 1).toBe(1);
      expect(humanTurnCount(dir)).toBe(1);
      expect(humanTurnState(dir)).toBe("consumed");

      const refused = answer("A");
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain("no new human reply has arrived");
      expect(readAudit(dir)).not.toContain("**Event**: QUESTION_ANSWERED");

      // The person's own reply when they come back works as before.
      expect(typed("reply", "A").code).toBe(0);
      const recorded = answer("A");
      expect(recorded.status, recorded.stderr).toBe(0);
      expect(recorded.stdout).toContain("QUESTION_ANSWERED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t149 Codex typed guard switch", () => {
  test("a typed $aidlc summary-confirmation off prompt turns it off as the person's choice", () => {
    const dir = scratchProject(true);
    try {
      const typed = runAdapter(dir, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-typed-session",
        turn_id: "typed-summary-off",
        cwd: dir,
        prompt: "$aidlc config set summary-confirmation off",
      });
      expect(typed.code, typed.stderr).toBe(0);
      const state = readFileSync(seededStateFile(dir), "utf-8");
      expect(state).toContain("- **Summary Confirmation**: off (set by you)");
      const audit = readAudit(dir);
      const ceremonyRows = audit.split("**Event**: CEREMONY_SET").slice(1);
      expect(ceremonyRows).toHaveLength(1);
      expect(ceremonyRows[0]).toContain("**Source**: you");

      // An agent-run repeat is a no-op: the saved line is already the person's off.
      const repeated = spawnSync(
        "bun",
        [join(dir, ".codex", "tools", "aidlc.ts"), "engine", "config", "set", "summary-confirmation", "off"],
        {
          cwd: dir,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_UNATTENDED: undefined, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        },
      );
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).toContain("Summary Confirmation is already off (set by you)");
      expect(readFileSync(seededStateFile(dir), "utf-8")).toBe(state);
      expect(readAudit(dir).split("**Event**: CEREMONY_SET").slice(1)).toEqual(ceremonyRows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The adapter used to drop the core hook's stdout here, so the agent never
  // heard that the switch was applied and ran a setter of its own on the piece
  // of work that was open instead of the one the person asked about.
  test("the note saying what the switch did reaches the agent, so it runs no setter of its own", () => {
    const dir = scratchProject(true);
    try {
      const typed = runAdapter(dir, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-typed-session",
        turn_id: "typed-fence-off",
        cwd: dir,
        prompt: "$aidlc --guard.review-freeze off fix the parser",
      });
      expect(typed.code, typed.stderr).toBe(0);
      const context = JSON.parse(typed.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(context.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
      const note = context.hookSpecificOutput?.additionalContext ?? "";
      expect(note).toContain("The review freeze check (it stops edits to work you already approved) is off for the work you are asking for (set by you).");
      expect(note).toContain("never run a setter for it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #1411: Codex runs UserPromptSubmit for every user input in a thread,
// including a subagent's: the brief spawn_agent sends, and every follow-up the
// agent sends it, arrive as `prompt` under the ROOT session id. Codex marks
// them: a thread-spawned subagent's payload carries agent_id and agent_type,
// the root thread's never does (codex-rs hook_runtime.rs
// thread_spawn_subagent_hook_context; upstream test
// subagent_start_replaces_session_start_and_injects_context). Only what the
// person types in the main chat is their turn.
describe("t149 Codex subagent prompts are not the person's turn", () => {
  const ROOT_SESSION = "019f0000-0000-7000-8000-000000001411";
  const BRIEF =
    "You are performing an ADVISORY architecture review of the NFR Requirements stage.\n" +
    "Read the stage artifacts and return your findings. Approve if nothing blocks. t149-brief-marker";
  let turn = 0;

  function prompt(
    dir: string,
    text: string,
    subagent = false,
    transcriptPath: string | null = null,
  ): { code: number; stderr: string } {
    turn += 1;
    return runAdapter(dir, "record-human-turn", {
      hook_event_name: "UserPromptSubmit",
      session_id: ROOT_SESSION,
      turn_id: `019f0000-0000-7000-8000-${String(turn).padStart(12, "0")}`,
      transcript_path: transcriptPath,
      cwd: dir,
      model: "gpt-5.5",
      permission_mode: "default",
      prompt: text,
      ...(subagent
        ? { agent_id: "019f0000-0000-7000-8000-0000000c4114", agent_type: "aidlc-architecture-reviewer-agent" }
        : {}),
    });
  }

  function appendEvent(dir: string, event: string, stage: string): void {
    writeFileSync(
      join(seededAuditDir(dir), pinnedShardName()),
      `${readFileSync(join(seededAuditDir(dir), pinnedShardName()), "utf-8")}\n## ${event}\n` +
        `**Timestamp**: 2026-08-03T18:57:53Z\n**Event**: ${event}\n**Stage**: ${stage}\n\n---\n`,
    );
  }

  function keptWords(dir: string): string {
    const wordsDir = join(engineDir(dir), "gate-words");
    return existsSync(wordsDir)
      ? readdirSync(wordsDir).map((name) => readFileSync(join(wordsDir, name), "utf-8")).join("\n")
      : "";
  }

  test("a subagent's brief records no turn; the person's prompt, typed while it runs, does", () => {
    const dir = scratchProject(true);
    try {
      appendEvent(dir, "STAGE_STARTED", "requirements-analysis");
      const brief = prompt(dir, BRIEF, true);
      expect(brief.code, brief.stderr).toBe(0);
      // A follow-up the agent sends the running subagent is the agent too.
      prompt(dir, "Also read the NFR design notes before you answer.", true);
      expect(humanTurnCount(dir)).toBe(0);
      expect(humanTurnState(dir)).toBe("none");
      expect(keptWords(dir)).toBe("");
      expect(existsSync(humanTurnMarkerPath(dir))).toBe(false);

      const typed = prompt(dir, "Also check the p99 latency budget, please.");
      expect(typed.code, typed.stderr).toBe(0);
      expect(humanTurnCount(dir)).toBe(1);
      expect(humanTurnState(dir)).toBe("acted");
      expect(keptWords(dir)).toContain("Also check the p99 latency budget, please.");
      expect(existsSync(humanTurnMarkerPath(dir))).toBe(true);

      // The person's own words count in the main chat whatever they say, even
      // the brief's exact text.
      prompt(dir, BRIEF);
      expect(humanTurnCount(dir)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subagent's brief is never read as the person's own words at a gate", () => {
    const dir = scratchProject(true);
    try {
      const gate = { stage: "requirements-analysis", acceptAsIs: false };
      appendEvent(dir, "STAGE_AWAITING_APPROVAL", gate.stage);
      prompt(dir, BRIEF, true);
      expect(personsGateFeedback(dir, ROOT_SESSION, gate)).toBeNull();
      prompt(dir, "Please add a p99 latency budget of 200 ms.");
      prompt(dir, BRIEF, true);
      expect(personsGateFeedback(dir, ROOT_SESSION, gate)).toBe("Please add a p99 latency budget of 200 ms.");
      expect(keptWords(dir)).not.toContain("t149-brief-marker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex's internal reviewers (the /review reviewer, Guardian auto-review)
  // run as their own threads under the root session id with no agent_id; the
  // transcript_path Codex sends names the thread whose input it is
  // (rollout-<timestamp>-<thread id>.jsonl), and the root thread's id is the
  // session id (codex-rs core/src/session/session.rs, rollout_file_name.rs).
  test("input to another Codex thread (an internal reviewer) is not the person's turn", () => {
    const dir = scratchProject(true);
    try {
      const sessions = "/home/person/.codex/sessions/2026/10/01";
      const reviewer = `${sessions}/rollout-2026-10-01T09-15-02-019f0000-0000-7000-8000-00000000beef.jsonl`;
      const root = `${sessions}/rollout-2026-10-01T09-00-00-${ROOT_SESSION}.jsonl`;
      prompt(dir, "Review the current code changes and report prioritized findings.", false, reviewer);
      expect(humanTurnCount(dir)).toBe(0);
      expect(keptWords(dir)).toBe("");
      // The root thread's own rollout, an uppercase spelling of it, a reverted
      // root's rollout, and no transcript at all are the main chat.
      prompt(dir, "Approve", false, root);
      prompt(dir, "Approve", false, root.toUpperCase().replace("/HOME/PERSON/.CODEX/SESSIONS", sessions));
      prompt(dir, "Approve", false, root.replace(".jsonl", "_019f0000-0000-7000-8000-0000000000aa.jsonl"));
      prompt(dir, "Approve", false, null);
      expect(humanTurnCount(dir)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an approval after only a subagent's prompt is refused until the person replies", () => {
    const dir = scratchProject(true);
    try {
      // A gate with no reviewer, so presence is the only check in play.
      writeFileSync(
        seededStateFile(dir),
        readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md"), "utf-8"),
      );
      const stage = "feasibility";
      const state = (args: string[]) => {
        const r = spawnSync("bun", [join(dir, ".codex", "tools", "aidlc-state.ts"), ...args, "--project-dir", dir], {
          cwd: dir,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_SKIP_ARTIFACT_GUARD: "1",
            AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
            AIDLC_SKIP_HUMAN_PRESENCE_GUARD: undefined,
            AIDLC_UNATTENDED: undefined,
            AIDLC_PROJECT_DIR: undefined,
            CLAUDE_PROJECT_DIR: undefined,
          } as NodeJS.ProcessEnv,
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
        return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
      };
      const opened = state(["gate-start", stage]);
      expect(opened.code, opened.out).toBe(0);
      prompt(dir, "Approve", true);
      const refused = state(["approve", stage, "--user-input", "Approve"]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("no new human reply has been received");
      expect(readAudit(dir)).not.toContain("**Event**: GATE_APPROVED");

      prompt(dir, "Approve");
      const approved = state(["approve", stage, "--user-input", "Approve"]);
      expect(approved.code, approved.out).toBe(0);
      expect(readAudit(dir).split("**Event**: GATE_APPROVED").length - 1).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("t149 Codex hook adapter (live-captured payload fixtures)", () => {
  test("0: Bash commands inherit the validated payload session", () => {
    const dir = scratchProject(true);
    try {
      writeSessionBinding(
        dir,
        "codex-command-session",
        DEFAULT_SPACE,
        DEFAULT_RECORD_DIR,
        "switch",
      );
      const other = createIntent(dir, "cursor-other", DEFAULT_SPACE, "feature");
      writeFileSync(
        join(intentsDirOf(dir, DEFAULT_SPACE), other.dirName, "aidlc-state.md"),
        readFileSync(seededStateFile(dir), "utf-8"),
      );
      setActiveIntentCursor(dir, other.dirName, DEFAULT_SPACE);
      const command = "bun .codex/tools/aidlc-orchestrate.ts next";
      const r = runAdapter(dir, "bind-bash-session", {
        hook_event_name: "PreToolUse",
        session_id: "codex-command-session",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command },
      });
      expect(r.code, r.stderr).toBe(0);
      if (process.platform === "win32") {
        // The adapter leaves Windows shell input unchanged; POSIX export syntax
        // is emitted only on POSIX. Session-bound audit routing is checked below
        // on both platforms.
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
      } else {
        const output = JSON.parse(r.stdout) as {
          hookSpecificOutput?: {
            hookEventName?: string;
            permissionDecision?: string;
            updatedInput?: { command?: string };
          };
        };
        expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
        expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
        expect(output.hookSpecificOutput?.updatedInput?.command).toBe(
          "export AIDLC_SESSION_OVERRIDE='codex-command-session' " +
            "AIDLC_SESSION_OVERRIDE_SOURCE='payload'; " +
            command,
        );
      }

      const humanTurn = runAdapter(dir, "record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-command-session",
        turn_id: "bound-human-turn",
        cwd: dir,
      });
      expect(humanTurn.code, humanTurn.stderr).toBe(0);
      expect(readRecordAudit(dir, DEFAULT_RECORD_DIR)).toContain(
        "**Event**: HUMAN_TURN",
      );
      expect(readRecordAudit(dir, other.dirName)).not.toContain(
        "**Event**: HUMAN_TURN",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex 0.160 gives every command it runs CODEX_THREAD_ID, the same id its hooks
  // carry, but not the hooks themselves. Once a tool has seen the id in its
  // command, the command needs no `export AIDLC_SESSION_OVERRIDE=...` prefix,
  // which Codex showed on every "Ran" line (a live run).
  test("0b: once a tool saw Codex give the session, later commands keep their own words", () => {
    const dir = scratchProject(true);
    try {
      const command = "bun .codex/tools/aidlc-orchestrate.ts next";
      const payload = {
        hook_event_name: "PreToolUse",
        session_id: "codex-command-session",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command },
      };
      const runTool = (thread: string) =>
        spawnSync("bun", [join(dir, ".codex", "tools", "aidlc-orchestrate.ts"), "next"], {
          cwd: dir,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_SESSION_OVERRIDE: "codex-command-session",
            AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
            CLAUDE_PROJECT_DIR: undefined,
            CODEX_SESSION_ID: undefined,
            CODEX_THREAD_ID: thread,
          } as NodeJS.ProcessEnv,
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
      // Each call is its own tool call: the adapter replays a repeated delivery.
      const first = runAdapter(dir, "bind-bash-session", { ...payload, tool_use_id: "call-first" });
      expect(first.code, first.stderr).toBe(0);
      if (process.platform !== "win32") {
        expect(first.stdout).toContain("export AIDLC_SESSION_OVERRIDE='codex-command-session'");
        // A tool whose command carries another thread's id notes nothing.
        runTool("codex-other-thread");
        const still = runAdapter(dir, "bind-bash-session", { ...payload, tool_use_id: "call-other" });
        expect(still.stdout).toContain("export AIDLC_SESSION_OVERRIDE='codex-command-session'");
      }
      // The tool sees Codex give its command this session.
      runTool("codex-command-session");
      const later = runAdapter(dir, "bind-bash-session", { ...payload, tool_use_id: "call-later" });
      expect(later.code, later.stderr).toBe(0);
      expect(later.stdout).toBe("");
      // Another session in the same project still gets the prefix.
      if (process.platform !== "win32") {
        const other = runAdapter(dir, "bind-bash-session", {
          ...payload, session_id: "codex-second-session", tool_use_id: "call-second",
        });
        expect(other.stdout).toContain("export AIDLC_SESSION_OVERRIDE='codex-second-session'");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("0c: a Codex command's tool works on the record its thread is bound to", () => {
    const dir = scratchProject(true);
    try {
      writeSessionBinding(dir, "codex-command-session", DEFAULT_SPACE, DEFAULT_RECORD_DIR, "switch");
      const other = createIntent(dir, "codex-other", DEFAULT_SPACE, "feature");
      writeFileSync(
        join(intentsDirOf(dir, DEFAULT_SPACE), other.dirName, "aidlc-state.md"),
        readFileSync(seededStateFile(dir), "utf-8"),
      );
      setActiveIntentCursor(dir, other.dirName, DEFAULT_SPACE);
      const next = (thread: string | undefined) => {
        const r = spawnSync("bun", [join(dir, ".codex", "tools", "aidlc-orchestrate.ts"), "next"], {
          cwd: dir,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_SESSION_OVERRIDE: undefined,
            AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
            CLAUDE_PROJECT_DIR: undefined,
            CODEX_SESSION_ID: undefined,
            CODEX_THREAD_ID: thread,
          } as NodeJS.ProcessEnv,
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        });
        return `${r.stdout ?? ""}${r.stderr ?? ""}`;
      };
      expect(next("codex-command-session")).toContain(`intents/${DEFAULT_RECORD_DIR}/`);
      expect(next(undefined)).toContain(`intents/${other.dirName}/`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("0d: Codex's own session names are protected like the session override", () => {
    const guard = readFileSync(join(REPO_ROOT, "core", "hooks", "runtime-integrity.ts"), "utf-8");
    expect(guard).toContain('"CODEX_THREAD_ID",');
    expect(guard).toContain('"CODEX_SESSION_ID",');
  });

  test("1: stop blocks with a reason while the workflow has pending work (verbatim contract)", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
      // The reason passes through verbatim: one plain line the person can
      // read, with no command (the Codex skill names the harness-local step).
      expect(out.reason ?? "").toStartWith("AI-DLC is carrying on");
      expect(out.reason).not.toContain("aidlc-orchestrate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Claude Code shows a Stop hook's whole note to the person ("Stop hook
  // error: ..."): the note is one line they can read, naming where the work
  // carries on, with no command (the agent's steps are in the Codex skill).
  test("1b: the stop note is one line the person can read, naming where the work carries on", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason).toBe("AI-DLC is carrying on with Requirements Analysis.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The step a tool that hides the note gets after the line (Kiro CLI,
  // opencode, Kiro IDE); the matcher knows that form too.
  const AGENT_STEP =
    "If you carry on with the work, first say that line to the person once, on its own line; " +
    "if you had just asked them a question, record it with `log decision` and end your turn saying nothing. " +
    "Say nothing else about this note.";

  // A turn whose person engaged the work, then a user-role message, then an
  // answer with no engine call: blocks when that message is the hook's own
  // note, and ends the turn when it is the person's.
  function stopAfterMessage(dir: string, message: string): string {
    const entry = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });
    const transcript = join(dir, "rollout-2026-06-26T00-00-00.jsonl");
    writeFileSync(transcript, [
      entry({ type: "message", role: "user", content: [{ type: "input_text", text: "ok, continue the workflow" }] }),
      entry({ type: "function_call", name: "Bash", arguments: JSON.stringify({ command: "bun .codex/tools/aidlc-orchestrate.ts next" }) }),
      entry({ type: "message", role: "user", content: [{ type: "input_text", text: message }] }),
      entry({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Two questions are still open." }] }),
    ].join("\n") + "\n", "utf-8");
    return runAdapter(dir, "continue-workflow", withCwd({ ...FIXTURES.stop, transcript_path: transcript }, dir)).stdout.trim();
  }

  // Codex puts the note back into the chat as a message of the person's. The
  // hook still knows it as its own, so the agent that engaged the work and then
  // only answered the note is still steered on. Each line the hook writes, and
  // the earlier one-line note still found in older transcripts, counts.
  test("1c: the stop note put back into the chat is not read as the person talking", () => {
    for (const note of [
      "AI-DLC is carrying on with Requirements Analysis.",
      "AI-DLC is carrying on with Code Generation for alpha.",
      "AI-DLC is carrying on.",
      `AI-DLC is carrying on with Code Generation for alpha.\n${AGENT_STEP}`,
      "Requirements Analysis is not finished yet. Next: `bun .codex/tools/aidlc-orchestrate.ts next`.",
      "Code Generation for alpha is not finished yet. Next: finish its steps, then `aidlc engine orchestrate report --stage code-generation --result <outcome>`.",
    ]) {
      const dir = scratchProject(true);
      try {
        expect((JSON.parse(stopAfterMessage(dir, note) || "{}") as { decision?: string }).decision, note).toBe("block");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A person's own message that starts like a note but is not one of the
  // hook's own lines (no command in the older form, no stage the hook names
  // in the new one) is the person talking: an answer to it with no engine call
  // ends the turn.
  test("1d: a person's message shaped like the note is still the person", () => {
    for (const said of [
      "Requirements Analysis is not finished yet. Next: explain what is missing.",
      "AI-DLC is carrying on with the old plan.",
      "AI-DLC is carrying on with Requirements Analysis for the whole team.",
      `AI-DLC is carrying on with Requirements Analysis.\n${AGENT_STEP} Why does it keep saying that?`,
      `Why? AI-DLC is carrying on with Requirements Analysis.\n${AGENT_STEP}`,
      `AI-DLC is carrying on with the old plan.\n${AGENT_STEP}`,
    ]) {
      const dir = scratchProject(true);
      try {
        expect(stopAfterMessage(dir, said), said).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Codex 0.160 stores the Stop reason as a user message wrapped in its own
  // <hook_prompt hook_run_id="stop:..."> tag, with < > & escaped (live run:
  // engine call, a reply, the blocked stop, the wrapped note, then a reply
  // with no engine call). The wrapped note is still the hook's, so that reply
  // does not make the turn chat: the stop blocks again.
  function stopAfterHookPrompt(dir: string, wrapped: string): string {
    const entry = (payload: Record<string, unknown>) => JSON.stringify({ type: "response_item", payload });
    const transcript = join(dir, "rollout-2026-10-06T09-26-38.jsonl");
    writeFileSync(transcript, [
      entry({ type: "message", role: "user", content: [{ type: "input_text", text: "Run AI-DLC's next step and tell me in one line what it asks for." }] }),
      entry({ type: "function_call", name: "Bash", arguments: JSON.stringify({ command: "bun .codex/tools/aidlc.ts engine orchestrate next" }) }),
      entry({ type: "message", role: "assistant", content: [{ type: "output_text", text: "AI-DLC asks the developer to analyze the existing code before Requirements Analysis." }] }),
      entry({ type: "message", role: "user", content: [{ type: "input_text", text: wrapped }] }),
      entry({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Still waiting on the developer." }] }),
    ].join("\n") + "\n", "utf-8");
    return runAdapter(dir, "continue-workflow", withCwd({ ...FIXTURES.stop, transcript_path: transcript }, dir)).stdout.trim();
  }
  const hookPrompt = (dir: string, inner: string) =>
    `<hook_prompt hook_run_id="stop:14:${dir}/.codex/hooks.json">${inner}</hook_prompt>`;
  // The live note, word for word as the rollout stored it.
  const LIVE_WRAPPED_NOTE =
    'The AI-DLC workflow is not finished (current stage "reverse-engineering"). If you just asked the person a question and are waiting for the answer, run `bun .codex/tools/aidlc.ts engine log decision --stage reverse-engineering --decision "&lt;the question&gt;" --options "&lt;the choices&gt;"`, adding any `--single`, `--checkpoint` or `--questions-file` flags that question\'s own instructions use, and end your turn without asking it again. Otherwise run `bun .codex/tools/aidlc-orchestrate.ts next`, do what the step it prints asks, then run `bun .codex/tools/aidlc-orchestrate.ts report --stage &lt;stage&gt; --result &lt;outcome&gt;`; repeat until it answers `done`. If the person asked to stop here, run `bun .codex/tools/aidlc-orchestrate.ts park`. Never mark a stage done or approved just to end the turn, and tell the person nothing about this note.';

  test("1e: Codex's wrapped stop note is the hook's, so a reply with no engine call is still sent on", () => {
    for (const inner of [
      LIVE_WRAPPED_NOTE,
      "AI-DLC is carrying on with Requirements Analysis.",
      "AI-DLC is carrying on with Feedback &amp; Optimization.",
      "AI-DLC is carrying on.",
      `AI-DLC is carrying on with Requirements Analysis.\n${AGENT_STEP}`,
      "Requirements Analysis is not finished yet. Next: `bun .codex/tools/aidlc-orchestrate.ts next`.",
    ]) {
      const dir = scratchProject(true);
      try {
        const out = stopAfterHookPrompt(dir, hookPrompt(dir, inner));
        expect((JSON.parse(out || "{}") as { decision?: string }).decision, inner).toBe("block");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Only that exact wrapper around one of the hook's own lines is unwrapped.
  // A person's message with the tag and words of their own, a wrapped text
  // that is not a hook line, or another wrapper stays the person's: the
  // answer to it with no engine call ends the turn.
  test("1f: a person's message that only looks like Codex's wrapper is still the person", () => {
    for (const said of [
      (dir: string) => `${hookPrompt(dir, "AI-DLC is carrying on with Requirements Analysis.")} why does this keep showing up?`,
      (dir: string) => `what is this? ${hookPrompt(dir, "AI-DLC is carrying on with Requirements Analysis.")}`,
      (dir: string) => hookPrompt(dir, "please explain the plan"),
      () => '<hook_prompt hook_run_id="session:1">AI-DLC is carrying on with Requirements Analysis.</hook_prompt>',
      () => "<hook_prompt>AI-DLC is carrying on with Requirements Analysis.</hook_prompt>",
    ]) {
      const dir = scratchProject(true);
      try {
        const message = said(dir);
        expect(stopAfterMessage(dir, message), message).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("2: stop is silent (no block) when no workflow state exists", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "continue-workflow", withCwd(FIXTURES.stop, dir));
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
        "Stage status cannot be changed with aidlc-state.ts reject",
      );
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2b: spawn_agent dispatch carries the exact active-stage rule bundle", () => {
    const dir = scratchProject(true);
    try {
      cpSync(
        join(REPO_ROOT, "dist", "codex", "aidlc"),
        join(dir, "aidlc"),
        { recursive: true },
      );
      const r = runAdapter(dir, "deliver-stage-rules", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "spawn_agent",
        tool_input: {
          agent_type: "aidlc-product-agent",
          message:
            "Run .codex/aidlc-common/stages/inception/user-stories.md.",
        },
      });
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        hookSpecificOutput?: {
          hookEventName?: string;
          permissionDecision?: string;
          updatedInput?: { message?: string };
        };
      };
      expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
      const message = out.hookSpecificOutput?.updatedInput?.message ?? "";
      expect(message).toContain("first-class");
      expect(message).toContain("Given/When/Then");
      expect(message).toContain("AIDLC_DISPATCH_RULES_BEGIN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2b2: plan-approval guard calls carry the payload session id", () => {
    const dir = scratchProject(true);
    try {
      const capture = join(dir, "guard-input.jsonl");
      writeFileSync(join(dir, ".codex", "hooks", "aidlc-plan-approval-guard.ts"), recordingGuard(capture), "utf-8");
      const env = { AIDLC_COMPILED_EXECUTABLE: "" };
      for (const payload of [
        {
          tool_name: "apply_patch",
          tool_input: { command: "*** Begin Patch\n*** Add File: src/a.ts\n+a\n*** End Patch\n" },
        },
        { tool_name: "spawn_agent", tool_input: { agent_type: "aidlc-developer-agent", message: "AIDLC-UNIT: todo-core" } },
        { tool_name: "Bash", tool_input: { command: "echo hi" } },
      ]) {
        const r = runAdapter(
          dir,
          "plan-approval-guard",
          { hook_event_name: "PreToolUse", cwd: dir, session_id: "S-CODEX", ...payload },
          env,
        );
        expect(r.code).toBe(0);
      }
      expect(forwardedSessions(capture)).toEqual(["S-CODEX", "S-CODEX", "S-CODEX"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2c: plan-approval guard reads the spawn target from tool_input.agent_type", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        agent_type: "aidlc-quality-agent",
        tool_name: "spawn_agent",
        tool_input: {
          agent_type: "aidlc-developer-agent",
          message: "AIDLC-UNIT: todo-core\nImplement todo-core",
        },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2cc: native Codex apply_patch and Bash mutation payloads reach plan approval", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const patch = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Add File: src/blocked.ts\n+blocked\n*** End Patch\n",
        },
      });
      expect(patch.code).toBe(2);
      expect(patch.stderr).toContain("Code generation cannot");

      const shell = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: "git diff --output=src/blocked.diff" },
      });
      expect(shell.code).toBe(2);
      expect(shell.stderr).toContain("Code generation cannot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2d: another spawn target is not blocked when its message mentions the developer agent", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "plan-approval-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "spawn_agent",
        tool_input: {
          agent_type: "aidlc-quality-agent",
          message: "Review aidlc-developer-agent output for todo-core",
        },
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2d: state-transition guard blocks lifecycle routing from a Codex subagent", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "state-transition-guard", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        tool_name: "Bash",
        agent_type: "aidlc-product-lead-agent",
        tool_input: {
          command: "bun .codex/tools/aidlc-orchestrate.ts next --resume",
        },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("only the main workflow session can change stage status or routing");
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
  // forwards it to the core write-audit-log, which now logs a write ONLY when the
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
        "sync-workflow-state",
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
      const r = runAdapter(dir, "sync-workflow-state", withCwd(FIXTURES.postToolUse_updatePlan, dir));
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
    const dir = scratchProject(false);
    try {
      rmSync(intentsDirOf(dir, DEFAULT_SPACE), { recursive: true, force: true });
      const health = sessionsDir(dir);
      const priorPayload = withCwd(
        {
          ...FIXTURES.sessionStart,
          session_id: "prior-session-0000",
          source: "startup",
        },
        dir,
      );

      // Codex starts before a workflow exists. The adapter must retain both its
      // heartbeat and current-session marker so the first creation can bind it.
      expect(runAdapter(dir, "session-start", priorPayload).code).toBe(0);
      expect(
        JSON.parse(readFileSync(join(health, "codex-session.json"), "utf-8")).session_id,
      ).toBe("prior-session-0000");
      expect(readFileSync(join(health, ".current-session"), "utf-8").trim()).toBe(
        "prior-session-0000",
      );

      const firstCreate = runIntentCreate(dir, "first intent");
      expect(firstCreate.code).toBe(0);
      expect(
        runAdapter(
          dir,
          "rebuild-stage-graph",
          withCwd(
            {
              ...FIXTURES.postToolUse_bash,
              session_id: "prior-session-0000",
              tool_input: {
                command:
                  "bun .codex/tools/aidlc.ts engine intent create --scope poc",
              },
              tool_response: firstCreate.stdout,
            },
            dir,
          ),
        ).code,
      ).toBe(0);
      const prior = activeRecord(dir);
      // Another conversation creates the second intent.
      expect(runIntentCreate(dir, "second intent", "next-session-0001").code).toBe(0);
      const current = activeRecord(dir);
      expect(current).not.toBe(prior);

      const nextPayload = withCwd(
        {
          ...FIXTURES.sessionStart,
          session_id: "next-session-0001",
          source: "startup",
        },
        dir,
      );
      const r = runAdapter(dir, "session-start", nextPayload);
      expect(r.code).toBe(0);
      const priorAudit = readRecordAudit(dir, prior);
      const currentAudit = readRecordAudit(dir, current);
      expect(priorAudit).toContain("SESSION_ENDED");
      expect(priorAudit).toContain("inferred");
      expect(priorAudit).toContain("prior-session-0000");
      expect(currentAudit).not.toContain("SESSION_ENDED");
      expect(currentAudit).toContain("SESSION_STARTED");
      // The heartbeat now names the new session.
      const hb = JSON.parse(readFileSync(join(health, "codex-session.json"), "utf-8")) as {
        session_id: string;
      };
      expect(hb.session_id).toBe("next-session-0001");
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

  test("11a: two compact starts with a state change between them render FRESH context (replay-cache exemption)", () => {
    // Codex SessionStart input has no turn_id: two DISTINCT compactions in one
    // session are byte-identical stdin, which the ×2 replay cache would treat
    // as a duplicate and answer with the FIRST compaction's stale context.
    // Compact-source session-start bypasses the cache, so the second render
    // must reflect the state as it stands NOW.
    const dir = scratchProject(true);
    try {
      const payload = withCwd({ ...FIXTURES.sessionStart, source: "compact" }, dir);
      const r1 = runAdapter(dir, "session-start", payload);
      expect(r1.code).toBe(0);
      const ctx1 =
        (JSON.parse(r1.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? "";
      expect(ctx1).toContain("requirements-analysis");
      // The workflow moves on between compactions.
      const stateFile = seededStateFile(dir);
      writeFileSync(
        stateFile,
        readFileSync(stateFile, "utf-8").replaceAll("requirements-analysis", "code-generation"),
      );
      const r2 = runAdapter(dir, "session-start", payload);
      expect(r2.code).toBe(0);
      const ctx2 =
        (JSON.parse(r2.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
          .hookSpecificOutput?.additionalContext ?? "";
      expect(ctx2).toContain("code-generation");
      expect(ctx2).not.toContain("requirements-analysis");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13: session-start FORWARDS session_id — core hook stamps the per-session→intent record (M3 rebind wiring)", () => {
    // The genuine M3 fix: Codex now forwards session_id alongside its real
    // `source`, so the core hook's P8 stamp/rebind path is reachable. Proof:
    // create an intent (so the live cursor resolves a uuid), fire startup with
    // the fixture session_id, and assert the per-session stamp file
    // aidlc/.aidlc-sessions/<session_id> was WRITTEN with that uuid. Without
    // the forwarded session_id the core hook's `if (sessionId)` block is inert
    // and no stamp file appears.
    const dir = scratchProject(true);
    try {
      const created = createIntent(dir, "codex-rebind", "default");
      const sid = String(FIXTURES.sessionStart.session_id);
      const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
      expect(r.code).toBe(0);
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(existsSync(stampPath)).toBe(true);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(created.uuid);
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
      const a = createIntent(dir, "intent-a", "default");
      // Stamp the session to A via a startup fire (the core hook stamps the
      // live cursor's uuid — currently A).
      runAdapter(dir, "session-start", withCwd({ ...FIXTURES.sessionStart, source: "startup" }, dir));
      const stampPath = join(dir, "aidlc", ".aidlc-sessions", sid);
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(a.uuid);
      // Move the live cursor to B in another space (the drift the resume must
      // detect). Cross-space correction must remain two skill invocations;
      // joining `$aidlc` calls with shell syntax turns the second into args.
      // Another conversation creates B. Without its session id, createIntent
      // binds whichever session the test process's ancestry names, and once
      // the 1 s ancestry cache has expired (a slow host) that is this session,
      // which then follows B and is never offered the rebind.
      const b = createIntent(dir, "intent-b", "team-b", undefined, undefined, "codex-other-session");
      expect(readSessionBinding(dir, sid)?.intent).toBe(a.dirName);
      setActiveIntentCursor(dir, b.dirName, "team-b");
      setActiveSpaceCursor(dir, "team-b");
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
      expect(ctx).toContain("first run `$aidlc space default`");
      expect(ctx).toContain(`$aidlc intent ${a.dirName}`);
      expect(ctx).not.toContain(`/aidlc intent ${a.dirName}`);
      expect(ctx).not.toContain("&&");
      expect(readFileSync(stampPath, "utf-8").trim()).toBe(a.uuid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("12: malformed stdin fails open (exit 0, no output) on every target", () => {
    const dir = scratchProject(true);
    try {
      for (const t of [
        "continue-workflow",
        "session-start",
        "audit-and-sensors",
        "sync-workflow-state",
        "log-subagent",
        "deliver-stage-rules",
      ]) {
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
  // Codex's stop adapter (case "continue-workflow", aidlc-codex-adapter.ts:336-343) pipes the
  // RAW stdin verbatim to the core hook, and Codex's stop payload carries a real
  // transcript_path (a date-sharded `rollout-*.jsonl`) + stop_hook_active. So the
  // core hook's conversational carve-out (tier 3, aidlc-continue-workflow.ts:886-904) fires
  // from the actual transcript, classifying the ending turn:
  //   - human's last prompt answered with NO loop-advancing engine call -> ALLOW.
  //   - a loop-advancing aidlc-orchestrate call after that prompt -> BLOCK.
  //   - a READ-ONLY query (next --status) is NOT engagement -> still ALLOW.
  // The core hook detects the Codex format by the rollout-*.jsonl path shape
  // (aidlc-continue-workflow.ts:792), so the transcript file the test writes MUST be named
  // rollout-*.jsonl and live in the scratch dir (the adapter reads a REAL file).
  // The seeded brownfield-feature state (Current Stage requirements-analysis [-],
  // not [?]/[R], no questions file) yields a pending run-stage and trips none of
  // the OTHER carve-outs, so the conversational classifier alone governs the
  // decision.

  /** Write a Codex rollout transcript (response_item shape) and return its path.
   *  `assistant` is either a plain message turn or a function_call turn - the two
   *  shapes the core hook's Codex reader classifies (aidlc-continue-workflow.ts:582-645). */
  function writeCodexTranscript(
    dir: string,
    humanPrompt: string,
    assistant:
      | { kind: "message"; text: string }
      | { kind: "call"; name: string; command: string }
      | { kind: "rows"; payloads: Array<Record<string, unknown>> },
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
    } else if (assistant.kind === "rows") {
      for (const payload of assistant.payloads) {
        lines.push(JSON.stringify({ type: "response_item", payload }));
      }
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
      const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
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
      const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
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
      const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      // A read-only query does NOT engage the loop -> conversational ALLOW.
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex 0.160 records a shell call as function_call "exec_command" with the
  // command under `cmd` (copied from a live rollout). Older Codex recorded
  // local_shell_call with the command as an argv list, and "shell" with a
  // `command` list; both must still read as engine calls.
  const execCommand = (callId: string, cmd: string): Record<string, unknown> => ({
    type: "function_call",
    id: `fc_${callId}`,
    name: "exec_command",
    arguments: JSON.stringify({ cmd, max_output_tokens: 12000 }),
    call_id: callId,
    internal_chat_message_metadata_passthrough: { turn_id: "01a11036-03b0-7ba2-876b-d1999e5c1f53" },
  });
  const execOutput = (callId: string, output: string): Record<string, unknown> => ({
    type: "function_call_output",
    id: `fco_${callId}`,
    call_id: callId,
    output: `Chunk ID: 8964f2\nWall time: 1.1062 seconds\nProcess exited with code 0\nOriginal token count: 40\nOutput:\n${output}`,
  });

  test("15b: ENGAGED BLOCK - a Codex 0.160 exec_command call to the engine after the human prompt blocks the stop", () => {
    const dir = scratchProject(true);
    try {
      const transcript = writeCodexTranscript(dir, "Run AI-DLC's next step and tell me in one line what it asks for.", {
        kind: "rows",
        payloads: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will check AI-DLC's next step.\n" }] },
          execCommand("call_262608d5c75b5a868164fa3422add761", "bun .codex/tools/aidlc.ts engine orchestrate next"),
          execOutput("call_262608d5c75b5a868164fa3422add761", '{"kind":"run-stage","stage":"requirements-analysis"}'),
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "AI-DLC asks to analyse the requirements." }] },
        ],
      });
      const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout || "{}") as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason ?? "").not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("15c: READ-ONLY ALLOW - a Codex 0.160 exec_command status query is still not engagement", () => {
    const dir = scratchProject(true);
    try {
      const transcript = writeCodexTranscript(dir, "Quick check: ask AI-DLC where this run is and tell me in one line.", {
        kind: "rows",
        payloads: [
          execCommand("call_6adb0608467758fa994697f8a3d4778b", "bun .codex/tools/aidlc.ts engine orchestrate next --status"),
          execOutput("call_6adb0608467758fa994697f8a3d4778b", '{"kind":"print","message":"Run status"}'),
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "You are on requirements-analysis." }] },
        ],
      });
      const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("15d: ENGAGED BLOCK - older Codex local_shell_call and shell calls to the engine still block the stop", () => {
    const shapes: Array<Record<string, unknown>> = [
      {
        type: "local_shell_call",
        call_id: "call_local_1",
        status: "completed",
        action: { type: "exec", command: ["bash", "-lc", "bun .codex/tools/aidlc-orchestrate.ts next"] },
      },
      {
        type: "function_call",
        name: "shell",
        call_id: "call_shell_1",
        arguments: JSON.stringify({ command: ["bash", "-lc", "bun .codex/tools/aidlc-orchestrate.ts next"] }),
      },
    ];
    for (const shape of shapes) {
      const dir = scratchProject(true);
      try {
        const transcript = writeCodexTranscript(dir, "ok, continue the workflow", { kind: "rows", payloads: [shape] });
        const r = runAdapter(dir, "continue-workflow", codexStopWithTranscript(dir, transcript));
        expect(r.code, String(shape.type)).toBe(0);
        const out = JSON.parse(r.stdout || "{}") as { decision?: string };
        expect(out.decision, String(shape.type)).toBe("block");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // --- Adapter respawns children via the running bun, not a PATH lookup ---
  //
  // The Codex adapter dispatches every core lifecycle hook (runCore) by spawning
  // a child bun process. A bare-name "bun" argv[0] inherits the hook
  // environment's $PATH; on a minimal environment that PATH often lacks the bun
  // install dir, so the child spawn fails ENOENT and the whole hook layer dies.
  // The fix reuses the exact bun running the adapter (process.execPath).

  test("16: session-start dispatches even when the child PATH has no bun (respawn uses process.execPath)", () => {
    // The adapter is launched via the ABSOLUTE bun (process.execPath), so it
    // starts regardless of PATH; the contract under test is that its OWN child
    // respawn (runCore) also does not need bun on PATH. Under the old bare-"bun"
    // argv[0] this session-start would ENOENT in runCore and emit nothing.
    const dir = scratchProject(true);
    try {
      const strippedEnv = envWithoutCommandOnPath("bun");
      const strippedPath = strippedEnv.PATH ?? "";
      // Premise guard: bun must genuinely be unresolvable on the stripped PATH.
      expect(strippedPath.split(delimiter).some((d) => existsSync(join(d, "bun")))).toBe(false);
      expect(Bun.which("bun", { PATH: strippedPath })).toBeNull();
      const r = spawnSync(
        process.execPath,
        [join(dir, ".codex", "hooks", "aidlc-codex-adapter.ts"), "session-start"],
        {
          cwd: dir,
          input: JSON.stringify(withCwd(FIXTURES.sessionStart, dir)),
          encoding: "utf-8",
          env: {
            ...strippedEnv,
            CLAUDE_PROJECT_DIR: undefined,
          } as NodeJS.ProcessEnv,
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

// --- guard-tool-call: the five PreToolUse checks in one process (#2066) ------
//
// Codex ran five PreToolUse handlers per shell call, and four of them spawned a
// child engine for the core hook: nine engine loads for one `ls`. hooks.json now
// wires one matcher-free group, and the adapter runs the members in its own
// process. These cases drive the group through the real adapter subprocess and,
// where process identity matters, swap a core hook for a stand-in that records
// the pid it ran in.
function standInHook(
  capture: string,
  hook: string,
  answer: { code: number; stderr?: string; throws?: boolean },
): string {
  return [
    'import { appendFileSync } from "node:fs";',
    "export async function run(_input: string): Promise<number> {",
    `  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, hook: ${JSON.stringify(hook)} }) + "\\n");`,
    answer.throws ? '  throw new Error("STANDIN-THREW");' : "",
    answer.stderr ? `  process.stderr.write(${JSON.stringify(answer.stderr)});` : "",
    `  return ${answer.code};`,
    "}",
    "if (import.meta.main) process.exit(await run(await Bun.stdin.text()));",
  ].join("\n");
}

function recordedRuns(capture: string): Array<{ pid: number; hook: string }> {
  if (!existsSync(capture)) return [];
  return readFileSync(capture, "utf-8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; hook: string });
}

const GUARD_HOOKS = [
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-review-freeze.ts",
  "aidlc-plan-approval-guard.ts",
] as const;

function shellCall(dir: string, command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: dir,
    session_id: "codex-command-session",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

describe("t149 Codex guard-tool-call runs the five PreToolUse checks in one process", () => {
  test("1: an ordinary shell command passes, with bind-bash-session's rewrite as the one output", () => {
    const dir = scratchProject(true);
    try {
      const r = runAdapter(dir, "guard-tool-call", shellCall(dir, "ls"));
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toBe("");
      if (process.platform !== "win32") {
        const out = JSON.parse(r.stdout) as {
          hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
        };
        expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
        expect(out.hookSpecificOutput?.updatedInput?.command).toBe(
          "export AIDLC_SESSION_OVERRIDE='codex-command-session' AIDLC_SESSION_OVERRIDE_SOURCE='payload'; ls",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2: a direct state transition is refused with the state-transition guard's own words", () => {
    const dir = scratchProject(false);
    try {
      const r = runAdapter(dir, "guard-tool-call", shellCall(dir, "bun .codex/tools/aidlc-state.ts reject feasibility"));
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Stage status cannot be changed with aidlc-state.ts reject");
      expect(r.stderr).toContain("aidlc-orchestrate.ts report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3: dispatching the developer before plan approval is refused with the plan-approval guard's words", () => {
    const dir = scratchProject(true);
    try {
      seedUnapprovedCodeGeneration(dir, "todo-core");
      const r = runAdapter(dir, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        cwd: dir,
        agent_type: "aidlc-quality-agent",
        tool_name: "spawn_agent",
        tool_input: { agent_type: "aidlc-developer-agent", message: "AIDLC-UNIT: todo-core\nImplement todo-core" },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Code generation cannot start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("4: the four core checks run inside the adapter's own process, in order", () => {
    const dir = scratchProject(true);
    try {
      const capture = join(dir, "guard-runs.ndjson");
      for (const hook of GUARD_HOOKS) {
        writeFileSync(join(dir, ".codex", "hooks", hook), standInHook(capture, hook, { code: 0 }), "utf-8");
      }
      const r = runAdapter(dir, "guard-tool-call", shellCall(dir, "echo hi"));
      expect(r.code, r.stderr).toBe(0);
      const runs = recordedRuns(capture);
      expect(runs.map((run) => run.hook)).toEqual([...GUARD_HOOKS]);
      expect(r.pid).toBeGreaterThan(0);
      expect(runs.map((run) => run.pid)).toEqual(GUARD_HOOKS.map(() => r.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5: a check that throws fails alone; the others still run and a refusal still reaches the agent", () => {
    const dir = scratchProject(true);
    try {
      const capture = join(dir, "guard-runs.ndjson");
      const answers: Record<string, { code: number; stderr?: string; throws?: boolean }> = {
        "aidlc-state-transition-guard.ts": { code: 0 },
        "aidlc-reviewer-scope.ts": { code: 0, throws: true },
        "aidlc-review-freeze.ts": { code: 2, stderr: "STANDIN-FREEZE-REFUSAL: the reviewed file is frozen.\n" },
        "aidlc-plan-approval-guard.ts": { code: 0 },
      };
      for (const hook of GUARD_HOOKS) {
        writeFileSync(join(dir, ".codex", "hooks", hook), standInHook(capture, hook, answers[hook]), "utf-8");
      }
      const r = runAdapter(dir, "guard-tool-call", shellCall(dir, "echo hi"));
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("STANDIN-FREEZE-REFUSAL");
      // The one that threw does not hide the refusal, and the members after it ran.
      expect(recordedRuns(capture).map((run) => run.hook)).toEqual([...GUARD_HOOKS]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("6: the duplicate delivery replays the refusal without running the checks again", () => {
    const dir = scratchProject(true);
    try {
      const capture = join(dir, "guard-runs.ndjson");
      for (const hook of GUARD_HOOKS) {
        writeFileSync(
          join(dir, ".codex", "hooks", hook),
          standInHook(capture, hook, hook === "aidlc-review-freeze.ts" ? { code: 2, stderr: "STANDIN-FREEZE-REFUSAL\n" } : { code: 0 }),
          "utf-8",
        );
      }
      const payload = shellCall(dir, "echo twice", { tool_use_id: "call-twice" });
      const first = runAdapter(dir, "guard-tool-call", payload);
      const second = runAdapter(dir, "guard-tool-call", payload);
      expect(first.code).toBe(2);
      expect(second.code).toBe(2);
      expect(first.stderr).toContain("STANDIN-FREEZE-REFUSAL");
      expect(second.stderr).toBe(first.stderr);
      expect(recordedRuns(capture)).toHaveLength(GUARD_HOOKS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7: rebuild-stage-graph runs its core hook inside the adapter's process", () => {
    const dir = scratchProject(true);
    try {
      const capture = join(dir, "rebuild-runs.ndjson");
      writeFileSync(
        join(dir, ".codex", "hooks", "aidlc-rebuild-stage-graph.ts"),
        standInHook(capture, "aidlc-rebuild-stage-graph.ts", { code: 0 }),
        "utf-8",
      );
      const r = runAdapter(dir, "rebuild-stage-graph", withCwd(FIXTURES.postToolUse_bash, dir));
      expect(r.code, r.stderr).toBe(0);
      const runs = recordedRuns(capture);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.pid).toBe(r.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

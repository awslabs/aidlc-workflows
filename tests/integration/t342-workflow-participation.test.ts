// covers: function:isWorkflowParticipant function:cursorIntent hook:aidlc-session-start
// hook:aidlc-plan-approval-guard hook:aidlc-record-human-turn hook:aidlc-log-subagent
// hook:aidlc-session-end audit:HUMAN_TURN audit:SESSION_STARTED audit:SUBAGENT_COMPLETED
//
// #1116: the active-intent cursor is per-user and gitignored while the intent
// record and intents.json are committed, so a teammate's in-flight record
// arrives in a clone that never ran the framework. `activeIntent` resolves it
// through the lone-record fallback — which is load-bearing for git worktrees
// (t07, t49) and stays — but reading that fallback as PARTICIPATION let the
// hooks block an unrelated session and log its events into the teammate's
// intent. These cases fix the participation question, not the resolution one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isWorkflowParticipant,
  humanActedSinceGate,
  readSessionBinding,
  resolveWorkflowSelection,
  unitParticipantPath,
  writeSessionBinding,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedStateFile,
  seededAuditDir,
  seededRecordDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const SESSION_START = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const HUMAN_TURN = join(AIDLC_SRC, "hooks", "aidlc-record-human-turn.ts");
const LOG_SUBAGENT = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const SESSION_END = join(AIDLC_SRC, "hooks", "aidlc-session-end.ts");
const SESSION = "t342-session";

let proj = "";

// A clone that received the teammate's committed record and nothing else: the
// cursor, the binding, the worktree metadata and the Unit marker are all local
// artifacts a joining checkout would have written, so the fixture removes the
// cursor the standard project seeds.
function teammateOnlyClone(): void {
  proj = createTestProject();
  seedStateFile(proj, "state-construction-with-worktree.md"); // Current Stage: code-generation
  rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), {
    force: true,
  });
}

function fire(
  hook: string,
  payload: Record<string, unknown>,
): { status: number; out: string } {
  const result = Bun.spawnSync({
    cmd: [BUN, hook],
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return {
    status: result.exitCode,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function driveLifecycle(): Record<string, number> {
  return {
    sessionStart: fire(SESSION_START, {
      source: "startup",
      session_id: SESSION,
    }).status,
    guard: fire(GUARD, {
      session_id: SESSION,
      cwd: proj,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(proj, "unrelated.txt"), content: "x" },
    }).status,
    humanTurn: fire(HUMAN_TURN, {
      session_id: SESSION,
      hook_event_name: "UserPromptSubmit",
      prompt: "an ordinary question",
    }).status,
    subagent: fire(LOG_SUBAGENT, {
      session_id: SESSION,
      hook_event_name: "SubagentStop",
      agent_type: "unrelated",
    }).status,
    sessionEnd: fire(SESSION_END, {
      session_id: SESSION,
      hook_event_name: "SessionEnd",
      reason: "exit",
    }).status,
  };
}

function recordedEvents(): string[] {
  const dir = seededAuditDir(proj);
  if (!existsSync(dir)) return [];
  const events: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      const match = /^\*\*Event\*\*: ([A-Z_]+)/.exec(line);
      if (match) events.push(match[1]);
    }
  }
  return events;
}

beforeEach(() => {
  proj = "";
});

afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

describe("t342 workflow participation", () => {
  test("a clone that only received the record is neither blocked nor logged", () => {
    teammateOnlyClone();

    const codes = driveLifecycle();

    // The guard permitted the unrelated write: exit 2 here is the reported bug.
    expect(codes.guard).toBe(0);
    expect(Object.values(codes)).toEqual([0, 0, 0, 0, 0]);
    // None of the five events the report observed may reach the teammate's shard.
    expect(recordedEvents()).toEqual([]);
    expect(existsSync(seededAuditDir(proj))).toBe(false);
    // SessionStart still records session identity, with no intent attached.
    expect(readSessionBinding(proj, SESSION)).toMatchObject({ intent: null });
  });

  test("a foreign human turn in the record does not answer the gate for a non-participant", () => {
    teammateOnlyClone();
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "foreign-clone.md"),
      "# AI-DLC Audit Log\n\n## Human turn\n\n" +
        "**Timestamp**: 2026-01-01T00:00:00Z\n**Event**: HUMAN_TURN\n\n---\n\n",
      "utf-8",
    );

    expect(humanActedSinceGate(proj)).toBe(false);
  });

  test.each([
    [
      "the per-user cursor",
      (): void => {
        writeFileSync(
          join(proj, "aidlc", "spaces", "default", "intents", "active-intent"),
          `${basenameOfRecord()}\n`,
          "utf-8",
        );
      },
    ],
    [
      "an existing session binding",
      (): void => {
        writeSessionBinding(proj, SESSION, "default", basenameOfRecord());
      },
    ],
    [
      "this worktree's own creation metadata",
      (): void => {
        mkdirSync(join(proj, ".aidlc"), { recursive: true });
        writeFileSync(
          join(proj, ".aidlc", "worktree-meta.json"),
          `${JSON.stringify({
            intentRecord: `aidlc/spaces/default/intents/${basenameOfRecord()}`,
          })}\n`,
          "utf-8",
        );
      },
    ],
    [
      "the Unit participant marker",
      (): void => {
        writeFileSync(unitParticipantPath(proj), "participant\n", "utf-8");
      },
    ],
  ])("%s makes this checkout a participant", (_signal, joinTheWorkflow) => {
    teammateOnlyClone();
    expect(
      isWorkflowParticipant(proj, resolveWorkflowSelection(proj, { sessionId: SESSION })),
    ).toBe(false);

    joinTheWorkflow();

    expect(
      isWorkflowParticipant(proj, resolveWorkflowSelection(proj, { sessionId: SESSION })),
    ).toBe(true);
  });

  test("worktree metadata naming another record does not make this checkout a participant", () => {
    teammateOnlyClone();
    mkdirSync(join(proj, ".aidlc"), { recursive: true });
    for (const intentRecord of [
      "aidlc/spaces/default/intents/someone-elses-record",
      "not-a-record-path",
    ]) {
      writeFileSync(
        join(proj, ".aidlc", "worktree-meta.json"),
        `${JSON.stringify({ intentRecord })}\n`,
        "utf-8",
      );
      expect(
        isWorkflowParticipant(proj, resolveWorkflowSelection(proj, { sessionId: SESSION })),
      ).toBe(false);
    }
  });

  test("two committed records with no cursor stay the pre-existing no-op", () => {
    teammateOnlyClone();
    const second = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "second-1234abcd",
    );
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "aidlc-state.md"), "# AI-DLC State Tracking\n", "utf-8");

    const codes = driveLifecycle();

    expect(Object.values(codes)).toEqual([0, 0, 0, 0, 0]);
    expect(recordedEvents()).toEqual([]);
  });
});

// The record directory name the standard fixture seeds.
function basenameOfRecord(): string {
  const parts = seededRecordDir(proj).split(/[/\\]/);
  return parts[parts.length - 1];
}

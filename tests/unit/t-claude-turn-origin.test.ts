// A Claude Code turn the host started is taken back once its own row is on
// record (#3541): the decider's reading of Claude Code's rows, the one rule
// every reader of a person's turns honours (withdrawnTurnPositions), and the
// pending folder's one cheap look. Claude Code 2.1.278 and 2.1.318, captured
// live: a scheduled wake-up hands the prompt hook the same keys as a typed
// prompt, and its turn's own row (`turnOrigin: "scheduled"`, a slash command's
// in Claude Code's own envelope) lands only after the hook returns.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  CLAUDE_TURNS_PENDING_DIR,
  claudeTurnsPending,
  projectDirFlag,
  settleClaudeTurnsFirst,
} from "../../core/tools/aidlc-claude-turn-pending.ts";
import {
  auditMark,
  claudeTranscriptOrigin,
  humanRepliedSinceGate,
  personRepliedAfter,
  repliesAfter,
} from "../../core/tools/aidlc-lib.ts";
import {
  auditShardBlocks,
  auditShardTurnBlocks,
  parseAuditShardEvents,
  sessionsDir,
  withdrawnTurnPositions,
} from "../../core/tools/aidlc-record-core.ts";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const block = (event: string, fields: Record<string, string>, at = "2026-11-05T03:02:00Z") =>
  [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)]
    .join("\n");
const shard = (...blocks: string[]) => `# AI-DLC Audit Log\n\n${blocks.join("\n\n---\n\n")}\n\n---\n`;

describe("a HUMAN_TURN a later HOST_TURN names is no turn", () => {
  test("withdrawnTurnPositions names only an earlier HUMAN_TURN with the same Message Id", () => {
    const blocks = auditShardBlocks(shard(
      block("HUMAN_TURN", { Origin: "person", Source: "typed", "Message Id": "a6df2c15" }),
      block("HUMAN_TURN", { Origin: "person", Source: "typed", "Message Id": "54556f7e" }),
      block("HUMAN_TURN", { Origin: "person", Source: "typed" }),
      block("HOST_TURN", { Origin: "host", Reason: "scheduled", Source: "record", "Message Id": "a6df2c15" }),
      block("HUMAN_TURN", { Origin: "person", Source: "typed", "Message Id": "0badc0de" }),
      block("HOST_TURN", { Origin: "host", Reason: "claude task notification", Source: "template" }),
    ));
    const withdrawn = withdrawnTurnPositions(blocks);
    expect([...withdrawn]).toEqual([0]);
    expect(auditShardTurnBlocks(blocks.join("\n---\n")).some((b) => b.includes("a6df2c15") && b.includes("HUMAN_TURN"))).toBe(false);
    const events = parseAuditShardEvents(blocks.join("\n---\n"), "s.md", 0).map((row) => row.event);
    expect(events.filter((event) => event === "HUMAN_TURN")).toHaveLength(3);
    // A HOST_TURN before the HUMAN_TURN takes nothing back.
    expect(withdrawnTurnPositions(auditShardBlocks(shard(
      block("HOST_TURN", { Origin: "host", Reason: "scheduled", Source: "record", "Message Id": "0badc0de" }),
      block("HUMAN_TURN", { Origin: "person", Source: "typed", "Message Id": "0badc0de" }),
    ))).size).toBe(0);
  });

  test("the gate's presence check and the mark readers do not count it", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-claude-turn-origin-"));
    const previous = process.env.CLAUDE_PROJECT_DIR;
    try {
      const intents = intentsDirOf(dir, DEFAULT_SPACE);
      mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
      mkdirSync(seededRecordDir(dir), { recursive: true });
      writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
      writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
      writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
        uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight",
      }])}\n`);
      seedAidlcMemory(dir);
      writeFileSync(seededStateFile(dir), readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md"), "utf-8"));
      writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), "testclonetakenback\n");
      mkdirSync(seededAuditDir(dir), { recursive: true });
      const host = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
      const path = join(seededAuditDir(dir), `${host}-testclonetakenback.md`);
      writeFileSync(path, shard(block("STAGE_STARTED", { Stage: "feasibility" }, "2026-11-05T03:00:00Z")));
      process.env.CLAUDE_PROJECT_DIR = dir;
      const mark = auditMark(dir);
      appendFileSync(path, `\n${block("HUMAN_TURN", { Origin: "person", Source: "typed", "Message Id": "a6df2c15" }, "2026-11-05T03:02:00Z")}\n\n---\n`);
      expect(personRepliedAfter(dir, mark)).toBe(true);
      expect(humanRepliedSinceGate(dir)).toBe(true);
      appendFileSync(path, `\n${block("HOST_TURN", { Origin: "host", Reason: "scheduled", Source: "record", "Message Id": "a6df2c15" }, "2026-11-05T03:02:05Z")}\n\n---\n`);
      expect(personRepliedAfter(dir, mark)).toBe(false);
      expect(repliesAfter(dir, mark)).toEqual([]);
      expect(humanRepliedSinceGate(dir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude Code's own row for a turn", () => {
  const typedLoop = "/loop Say the word tick. Schedule each next wakeup with delaySeconds 60.";
  const envelope = "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n" +
    "<command-args>Say the word tick. Schedule each next wakeup with delaySeconds 60.</command-args>";
  const row = (promptId: string, content: string, marks: Record<string, unknown>) =>
    JSON.stringify({ type: "user", promptId, message: { role: "user", content }, timestamp: "2026-11-05T02:56:03.678Z", ...marks });

  test("a wake-up's row is the host's, a slash command read through Claude Code's envelope; the person's stays theirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-claude-turn-origin-"));
    try {
      const transcript = join(dir, "3ce715f5-b6b7-4a3c-9f8e-5875c1ad66ef.jsonl");
      writeFileSync(transcript, `${[
        row("a24d84e1", envelope, { turnOrigin: "human", origin: { kind: "human" } }),
        row("d5527d3d", envelope, { turnOrigin: "scheduled", wakeupSource: "loop_wakeup", scheduledFireId: "1ed41d3f" }),
        row("d2c897a4", "# Autonomous loop check\n\nKeep work moving.", { turnOrigin: "scheduled", promptSource: "system" }),
        row("4908db2d", "Use the staging database.", { promptSource: "sdk" }),
      ].join("\n")}\n`);
      expect(claudeTranscriptOrigin(transcript, "a24d84e1", typedLoop)).toEqual({ kind: "person", source: "record" });
      expect(claudeTranscriptOrigin(transcript, "d5527d3d", typedLoop)).toEqual({ kind: "host", reason: "scheduled", source: "record" });
      expect(claudeTranscriptOrigin(transcript, "d2c897a4", "# Autonomous loop check\n\nKeep work moving."))
        .toEqual({ kind: "host", reason: "scheduled", source: "record" });
      // A message typed into the wake-up's turn rides its id with its own words.
      expect(claudeTranscriptOrigin(transcript, "d5527d3d", "Approve")).toBeNull();
      // A row with neither mark decides nothing.
      expect(claudeTranscriptOrigin(transcript, "4908db2d", "Use the staging database.")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the pending folder", () => {
  test("is the sessions folder's, and an entry with nothing pending reads one missing folder and does nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "t-claude-turn-origin-"));
    try {
      expect(CLAUDE_TURNS_PENDING_DIR).toBe(relative(dir, join(sessionsDir(dir), "claude-turns")));
      expect(claudeTurnsPending(dir)).toBe(false);
      settleClaudeTurnsFirst(dir);
      settleClaudeTurnsFirst(join(dir, "nowhere"));
      expect(projectDirFlag(["approve", "feasibility", "--project-dir", "/p"])).toBe("/p");
      expect(projectDirFlag(["approve", "--project-dir=/q"])).toBe("/q");
      expect(projectDirFlag(["approve", "feasibility"])).toBeUndefined();
      mkdirSync(join(dir, CLAUDE_TURNS_PENDING_DIR), { recursive: true });
      expect(claudeTurnsPending(dir)).toBe(false);
      writeFileSync(join(dir, CLAUDE_TURNS_PENDING_DIR, "not-json.json"), "{");
      expect(claudeTurnsPending(dir)).toBe(true);
      expect(() => settleClaudeTurnsFirst(dir)).not.toThrow(); // an unreadable entry decides nothing
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every entry that reads a person's turns settles first", () => {
  // The readers of a person's turns a tool's command can reach.
  const READERS = /\b(humanRepliedSinceGate|humanActedSinceGate|personsGateReply|requireProtectedResponse|proveMessage|personRepliedAfter|repliesAfter|latestReplyAfter|personRepliedSinceGateShown|personAskedSinceGate|requestMessages|constructionStaffingPassedOver|repoScopePassedOver|gateWordsSinceUnitReview|humanTurnState|personTurnStands|readProtectedResponse|requireHumanConstructionPolicyChange)\b/;
  test("each engine tool with its own entry that reads them calls settleClaudeTurnsFirst", () => {
    const tools = join(REPO_ROOT, "core", "tools");
    const skip = new Set(["aidlc-lib.ts", "aidlc-record-core.ts", "aidlc-message-store.ts", "aidlc-claude-turn-origin.ts", "aidlc-claude-turn-pending.ts"]);
    const missing = readdirSync(tools)
      .filter((name) => /^aidlc-[a-z-]+\.ts$/.test(name) && !skip.has(name))
      .filter((name) => {
        const text = readFileSync(join(tools, name), "utf-8");
        return text.includes("import.meta.main") && READERS.test(text) && !text.includes("settleClaudeTurnsFirst(");
      });
    expect(missing).toEqual([]);
    const hook = readFileSync(join(REPO_ROOT, "core", "hooks", "aidlc-record-human-turn.ts"), "utf-8");
    expect(hook).toContain("settleClaudeTurnsFirst(projectDir)");
    expect(readFileSync(join(tools, "aidlc.ts"), "utf-8")).toContain("settleClaudeTurnsFirst(");
  });
});

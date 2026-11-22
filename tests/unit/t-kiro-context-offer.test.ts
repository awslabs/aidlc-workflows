// covers: function:kiroContextPressure, function:kiroChatRecordOrigin, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// Kiro shows the person how full the chat is, but gives the agent no figure,
// so the skills' "park only when a figure of 80% or more was surfaced" could
// never happen and nothing told the person anything (#2574). The engine now
// reads Kiro's own record of the chat, read only: Kiro CLI's default engine
// keeps the figure in ~/.kiro/sessions/cli/<chat>.json, Kiro CLI v3 and Kiro
// IDE summarize the chat on their own at 80% and leave a `summarization` row in
// ~/.kiro/sessions/<workspace>/<chat>/messages.jsonl. Beside a question the
// person is asked anyway (a stage's approval, a Unit's checkpoint) it offers
// once per chat to pause and carry on in a new chat; their answer decides.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const TREES = {
  kiro: join(REPO_ROOT, "dist", "kiro", ".kiro"),
  "kiro-ide": join(REPO_ROOT, "dist", "kiro-ide", ".kiro"),
  claude: AIDLC_SRC,
} as const;
type Tree = keyof typeof TREES;
const STAGE = "requirements-analysis";
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";
const usageLine = (n: number) =>
  `This chat is about ${n}% full by Kiro's count, and once it fills the agent carries on from a summary. ` +
  "Do you want to pause here and carry on in a new chat? I recommend it: the work is saved, and a new chat " +
  "picks it up from the saved files.";
const SUMMARIZED_LINE =
  "Kiro has summarized this chat to make room, so the agent now works from a summary of what came before. " +
  "Do you want to pause here and carry on in a new chat? I recommend it: your work is saved, and a new chat " +
  "picks it up from the saved files.";
const offered = (text: string | undefined): boolean => /full by Kiro's count|Kiro has summarized this chat/.test(text ?? "");

function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-kiro-ctx-home-")));
  created.push(dir);
  return dir;
}

// Kiro CLI's default engine: one JSON file per chat, the figure saved at the end of a turn.
function v2Record(homeDir: string, chat: string, percentage: unknown): void {
  const dir = join(homeDir, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chat}.json`), `${JSON.stringify({
    session_id: chat, cwd: "/work", created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:10:00Z",
    session_state: {
      version: "v1", agent_name: "aidlc",
      conversation_metadata: { last_context_usage: { percentage, model_id: "auto" }, user_turn_metadatas: [] },
      rts_model_state: { context_usage_percentage: percentage, model_info: { context_window_tokens: 200000 } },
    },
  })}\n`);
}

// Kiro CLI's default engine also logs the chat beside it, one `kind` per line;
// a `Compaction` row is Kiro compacting the chat when it overflows, mid-turn too.
function v2Log(homeDir: string, chat: string, kinds: string[]): void {
  const row = (kind: string) => kind === "Prompt"
    ? { version: "v1", kind, data: { message_id: "m1", content: [{ kind: "text", data: "go on" }], meta: {} } }
    : kind === "Compaction"
    ? { version: "v1", kind, data: { summary: "Earlier work.", strategy: { message_pairs_to_exclude: 2 }, messages_snapshot: [] } }
    : { version: "v1", kind, data: { message_id: "a1", content: [] } };
  writeFileSync(join(homeDir, ".kiro", "sessions", "cli", `${chat}.jsonl`), `${kinds.map((kind) => JSON.stringify(row(kind))).join("\n")}\n`);
}

// Kiro CLI v3 and Kiro IDE: one wrapped row per line, as @kiro/agent writes them.
function v3Record(homeDir: string, chat: string, rows: Array<Record<string, unknown>>): void {
  const dir = join(homeDir, ".kiro", "sessions", "0123456789abcdef", chat);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "messages.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const usageRow = (percent: number, when = at(0)) => ({
  id: `meta-${percent}`, timestamp: when,
  payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: percent }, executionId: "e1" },
});
const tombstone = (kind: string, when: string) => ({
  id: "tombstone_summarize_1", timestamp: when,
  payload: { type: "tombstone", kind, effectiveFromMessageId: "m1", metadata: { truncatedMessageCount: 40, truncatedAt: when } },
});
const userRow = (text: string) => ({
  id: "u1", timestamp: at(-120_000),
  payload: { type: "user", content: [{ type: "text", text }], _meta: { kiro: { userMessageTag: "prompt_1" } } },
});

// Everything under the scratch home, by content, so a test can say nothing of Kiro's changed.
function homeDigest(homeDir: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${path}\0`).update(readFileSync(path));
    }
  };
  walk(join(homeDir, ".kiro"));
  return hash.digest("hex");
}

// A bugfix at Requirements Analysis with its output written, and this chat's first turn on the work.
function project(chat: string): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## FR-1\nList notes.\n", "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, proj);
  return proj;
}

type Who = { tree: Tree; homeDir: string; chat?: string; ideChat?: string; env?: Record<string, string | undefined> };

// The environment the agent's own command runs with on each host: Kiro CLI
// names the chat in KIRO_SESSION_ID; Kiro IDE names none, and the engine finds
// the chat from the process tree, which a test stands in for with the
// hook-supplied identity.
function hostEnv(who: Who): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: who.homeDir,
    USERPROFILE: who.homeDir,
    KIRO_SESSION_ID: who.chat,
    AIDLC_SESSION_OVERRIDE: who.ideChat,
    AIDLC_SESSION_OVERRIDE_SOURCE: who.ideChat ? "payload" : undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    CLAUDE_PID: undefined,
    CODEX_THREAD_ID: undefined,
    AIDLC_HARNESS_DIR: undefined,
    AIDLC_HARNESS_NAME: undefined,
    AIDLC_UNATTENDED: undefined,
    AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    ...who.env,
  };
}

function report(proj: string, who: Who) {
  const result = spawnSync(process.execPath, [
    join(TREES[who.tree], "tools", "aidlc-orchestrate.ts"), "report", "--stage", STAGE, "--result", "awaiting-approval",
    "--project-dir", proj,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: hostEnv(who) });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}") as {
    kind: string; narration?: string; change_notices?: string[];
  };
}

describe("t-kiro-context-offer: Kiro CLI's default engine, the figure Kiro saved", () => {
  test("at 80% or more the approval question carries the offer once in this chat, with the figure", () => {
    const chat = "27b3d4ec-5cf4-4fbb-b0fb-b0d3f8a53e47";
    const homeDir = home();
    v2Record(homeDir, chat, 84.3061);
    const proj = project(chat);
    const before = homeDigest(homeDir);
    const first = report(proj, { tree: "kiro", homeDir, chat });
    expect(first.kind).toBe("print");
    expect(first.narration).toStartWith("Requirements Analysis is ready for your review.");
    expect(first.narration?.split("\n").at(-1)).toBe(usageLine(84));
    // The gate shown again in the same chat: said once, whatever the figure now.
    v2Record(homeDir, chat, 91);
    const again = report(proj, { tree: "kiro", homeDir, chat });
    expect(offered(again.narration)).toBe(false);
    expect(offered(again.change_notices?.join(" "))).toBe(false);
    // Read only: nothing of Kiro's changed.
    v2Record(homeDir, chat, 84.3061);
    expect(homeDigest(homeDir)).toBe(before);
  });

  // Measured live on Kiro CLI 2.29.0: the chat was 85.7% at the end of a turn,
  // Kiro compacted it part way through the next (a `Compaction` row after the
  // turn's `Prompt`), and the figure stays the old one until the turn ends.
  test("a compaction in this turn, after the figure was saved, is said as a summary, not as the old figure", () => {
    const chat = "99999999-9999-4999-8999-999999999999";
    const homeDir = home();
    v2Record(homeDir, chat, 85.7245);
    v2Log(homeDir, chat, ["Prompt", "AssistantMessage", "ToolResults", "Prompt", "AssistantMessage", "Compaction", "ToolResults", "AssistantMessage"]);
    const proj = project(chat);
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  test("a compaction in an earlier turn leaves the figure Kiro saved since", () => {
    const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const homeDir = home();
    v2Record(homeDir, chat, 41);
    v2Log(homeDir, chat, ["Prompt", "Compaction", "AssistantMessage", "Prompt", "AssistantMessage"]);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat }).narration)).toBe(false);
    v2Record(homeDir, chat, 82);
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1)).toBe(usageLine(82));
  });

  test("another chat at 80% hears it in its own chat", () => {
    const one = "11111111-1111-4111-8111-111111111111";
    const two = "22222222-2222-4222-8222-222222222222";
    const homeDir = home();
    v2Record(homeDir, one, 82);
    v2Record(homeDir, two, 95.6);
    const proj = project(one);
    appendAuditEntry("HUMAN_TURN", { Session: two, Origin: "person", Source: "typed" }, proj);
    expect(report(proj, { tree: "kiro", homeDir, chat: one }).narration?.split("\n").at(-1)).toBe(usageLine(82));
    expect(report(proj, { tree: "kiro", homeDir, chat: two }).narration?.split("\n").at(-1)).toBe(usageLine(96));
  });

  test("the gate shown again by next (a new chat at an open gate) says it once, with the step", () => {
    const opener = "77777777-7777-4777-8777-777777777777";
    const chat = "88888888-8888-4888-8888-888888888888";
    const homeDir = home();
    const proj = project(opener);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat: opener }).narration)).toBe(false);
    v2Record(homeDir, chat, 90.2);
    appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, proj);
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), proj, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as { gate_only?: boolean; change_notices?: string[] };
    };
    const shown = step();
    expect(shown.gate_only).toBe(true);
    expect(shown.change_notices ?? []).toContain(usageLine(90));
    expect(offered((step().change_notices ?? []).join(" "))).toBe(false);
  });

  test("below 80%, no record, or a record that does not parse: nothing is said", () => {
    const chat = "33333333-3333-4333-8333-333333333333";
    const homeDir = home();
    const proj = project(chat);
    const none = report(proj, { tree: "kiro", homeDir, chat });
    v2Record(homeDir, chat, 79.9);
    const below = report(proj, { tree: "kiro", homeDir, chat });
    expect(below.narration).toBe(none.narration);
    writeFileSync(join(homeDir, ".kiro", "sessions", "cli", `${chat}.json`), "{\"session_state\": ");
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration).toBe(none.narration);
    v2Record(homeDir, chat, "84");
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration).toBe(none.narration);
    expect(offered(none.narration)).toBe(false);
  });

  test("an unattended run says nothing", () => {
    const chat = "44444444-4444-4444-8444-444444444444";
    const homeDir = home();
    v2Record(homeDir, chat, 88);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat, env: { AIDLC_UNATTENDED: "1" } }).narration)).toBe(false);
  });
});

describe("t-kiro-context-offer: Kiro CLI v3 and Kiro IDE, right after Kiro summarized the chat", () => {
  test("a summarization since this chat's first turn on the work is said once (Kiro CLI v3)", () => {
    const chat = "sess_f3fedea3-3cb6-41f9-9e75-da9bf2fd1d36";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [userRow("/aidlc"), usageRow(79.4, at(-1000)), tombstone("summarization", at(60_000)), usageRow(20.1, at(61_000))]);
    const before = homeDigest(homeDir);
    const first = report(proj, { tree: "kiro-ide", homeDir, chat });
    expect(first.narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
    expect(offered(report(proj, { tree: "kiro-ide", homeDir, chat }).narration)).toBe(false);
    expect(homeDigest(homeDir)).toBe(before);
  });

  test("Kiro IDE (no chat id in the shell) gets the same line for the chat the engine resolved", () => {
    const chat = "sess_0f185df1-7393-49c2-a607-92e02fea6d00";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [tombstone("summarization", at(60_000))]);
    expect(report(proj, { tree: "kiro-ide", homeDir, ideChat: chat }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  test("a summary from before the work began, a checkpoint revert, or a figure under 80% says nothing", () => {
    const chat = "sess_44aff2b8-e5fe-48c2-a42c-9f8712954432";
    const homeDir = home();
    const proj = project(chat);
    const none = report(proj, { tree: "kiro-ide", homeDir, chat }).narration;
    v3Record(homeDir, chat, [tombstone("summarization", at(-3_600_000)), usageRow(21)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    v3Record(homeDir, chat, [tombstone("checkpoint_revert", at(60_000)), usageRow(40)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    v3Record(homeDir, chat, [usageRow(79.4)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    writeFileSync(join(homeDir, ".kiro", "sessions", "0123456789abcdef", chat, "messages.jsonl"), "not json\n{\"payload\":\n");
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    expect(offered(none)).toBe(false);
  });

  test("with Kiro's auto-compaction off the figure passes 80%, and the figure line is said", () => {
    const chat = "sess_aa48a8fe-1745-43d7-93d3-3bf59abab7d2";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [usageRow(70), usageRow(85.2)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration?.split("\n").at(-1)).toBe(usageLine(85));
  });
});

describe("t-kiro-context-offer: other hosts never read Kiro's files", () => {
  test("a Claude Code chat with a Kiro record of the same id hears nothing", () => {
    const chat = "55555555-5555-4555-8555-555555555555";
    const homeDir = home();
    v2Record(homeDir, chat, 97);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "claude", homeDir, ideChat: chat }).narration)).toBe(false);
  });
});

describe("t-kiro-context-offer: a Unit's checkpoint", () => {
  const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

  // Classic, two Units one at a time, reviews off, checkpoints on; Unit alpha's stages all built.
  function walk(chat: string, autonomy: "gated" | "autonomous" = "gated"): string {
    const p = createTestProject();
    created.push(p);
    seedAidlcMemory(p);
    writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A checkpoint offer
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: ${autonomy}
- **Review Override**: none
- **Guard Policy**: off (from scope classic)
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
    seedBoltDag(p, ["alpha", "beta"]);
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 1;\n");
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
    if (autonomy === "autonomous") appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, p);
    appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, p);
    for (const slug of STAGES) {
      const stage = findStageBySlug(slug)!;
      const output = join(seededRecordDir(p), "construction", "alpha", slug);
      mkdirSync(output, { recursive: true });
      for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
      if (stage.workspace_requires) {
        writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
          stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
        }));
      }
      appendAuditEntry("UNIT_COMPLETED", {
        Stage: slug, Unit: "alpha", Mode: "wave",
        "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
        "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
      }, p);
    }
    return p;
  }

  test("the checkpoint step says it when the step starts, once in this chat", () => {
    const chat = "66666666-6666-4666-8666-666666666666";
    const homeDir = home();
    v2Record(homeDir, chat, 86.4);
    const p = walk(chat);
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), p, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as { construction_checkpoint?: { unit: string }; change_notices?: string[] };
    };
    const first = step();
    expect(first.construction_checkpoint?.unit).toBe("alpha");
    expect(first.change_notices ?? []).toContain(usageLine(86));
    expect(offered((step().change_notices ?? []).join(" "))).toBe(false);
  });

  test("a checkpoint that approves on its own says nothing and keeps the offer for a question the person is asked", () => {
    const chat = "77777777-7777-4777-8777-777777777777";
    const homeDir = home();
    v2Record(homeDir, chat, 86.4);
    const p = walk(chat, "autonomous");
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), p, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as {
        construction_checkpoint?: { unit: string; human_required: boolean }; change_notices?: string[];
      };
    };
    const automatic = step();
    expect(automatic.construction_checkpoint?.unit).toBe("alpha");
    expect(automatic.construction_checkpoint?.human_required).toBe(false);
    expect(offered((automatic.change_notices ?? []).join(" "))).toBe(false);
    const state = seededStateFile(p);
    writeFileSync(state, readFileSync(state, "utf8").replace(
      "- **Construction Autonomy Mode**: autonomous", "- **Construction Autonomy Mode**: gated",
    ));
    const asked = step();
    expect(asked.construction_checkpoint?.human_required).toBe(true);
    expect(asked.change_notices ?? []).toContain(usageLine(86));
  });
});

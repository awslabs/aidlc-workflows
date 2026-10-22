// covers: file:tests/harness/leg-evidence.ts
//
// What a live leg keeps beyond its driver's own trace, under
// $AIDLC_TEST_LOG_DIR/leg-evidence/: every audit shard of each project it
// drove, and what the agent told the person, turn by turn. Each driver keeps
// both at the end point it already owns: the SDK drive (through the SDK mock,
// no model), a Codex exec, a Copilot or opencode turn (a stub CLI), and a TUI
// session's Claude Code transcript. Nothing is written without a log folder,
// no link is followed, and the budget cuts are said in what is kept.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { cleanupTestProject, createTestProject, seededAuditShard } from "../harness/fixtures.ts";

type QueryInput = Parameters<typeof sdkQuery>[0];
let scenario: (input: QueryInput) => AsyncGenerator<SDKMessage> = (): AsyncGenerator<SDKMessage> => {
  throw new Error("Unexpected SDK query");
};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: (input: QueryInput) => scenario(input) }));

const scratch: string[] = [];
const stubs = mkdtempSync(join(tmpdir(), "aidlc-leg-stubs-"));
scratch.push(stubs);
const stub = (name: string, stdout: string): string => {
  const out = join(stubs, `${name}.out`);
  writeFileSync(out, stdout);
  const path = join(stubs, name);
  writeFileSync(path, `#!/bin/sh\ncat '${out}'\n`);
  chmodSync(path, 0o755);
  return path;
};
const copilotJson = [
  JSON.stringify({ type: "user.message", timestamp: "2026-10-21T01:00:00.000Z", data: { content: "/aidlc fix the greeter" } }),
  JSON.stringify({ type: "assistant.message_delta", timestamp: "2026-10-21T01:00:01.000Z", data: { deltaContent: "I'll" } }),
  JSON.stringify({ type: "assistant.message", timestamp: "2026-10-21T01:00:02.000Z", data: { content: "", toolRequests: [{ name: "bash" }] } }),
  JSON.stringify({ type: "assistant.message", timestamp: "2026-10-21T01:00:03.000Z", agentId: "a1", data: { content: "subagent notes", parentToolCallId: "call_1" } }),
  JSON.stringify({ type: "assistant.message", timestamp: "2026-10-21T01:00:04.000Z", data: { content: "Which plan do you want?" } }),
  "not json",
].join("\n");
const opencodeJson = [
  JSON.stringify({ type: "step_start", timestamp: 1792544400000, sessionID: "ses_1", part: { type: "step-start" } }),
  JSON.stringify({ type: "tool_use", timestamp: 1792544401000, sessionID: "ses_1", part: { type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "" } } }),
  JSON.stringify({ type: "text", timestamp: 1792544402000, sessionID: "ses_1", part: { type: "text", text: "The change is planned. Approve it?" } }),
].join("\n");
process.env.AIDLC_COPILOT_BIN = stub("copilot", copilotJson);
process.env.AIDLC_OPENCODE_BIN = stub("opencode", opencodeJson);

const { LEG_EVIDENCE_LIMITS, keepAgentWords, keepLegAudit, keepTranscriptWords } = await import("../harness/leg-evidence.ts");
const { driveAidlc } = await import("../harness/sdk-drive.ts");
const { codexPersonTurn, recordCodexExec } = await import("../harness/codex-test-lifecycle.ts");
const { copilotReplies, copilotTurn, opencodeReplies, opencodeTurn } = await import("../harness/exec-drive.ts");

const posix = (p: string) => p.split(sep).join("/");
const savedLogDir = process.env.AIDLC_TEST_LOG_DIR;
let logDir = "";

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}
function put(root: string, path: string, text: string): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}
/** Every file under the leg's evidence folder, by path inside it. */
function kept(): Record<string, string> {
  const root = join(logDir, "leg-evidence");
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[posix(relative(root, path))] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
/** The kept audit copies, by the shard's path inside its project. */
function keptAudit(): Record<string, string> {
  return Object.fromEntries(Object.entries(kept())
    .filter(([path]) => path.startsWith("audit/"))
    .map(([path, text]) => [path.split("/").slice(2).join("/"), text]));
}
function keptWords(): Array<Record<string, unknown>> {
  return Object.entries(kept())
    .filter(([path]) => /^words-.*\.ndjson$/.test(path))
    .flatMap(([, text]) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

beforeEach(() => {
  logDir = temp("aidlc-leg-logs-");
  process.env.AIDLC_TEST_LOG_DIR = logDir;
});
afterEach(() => {
  scenario = (): AsyncGenerator<SDKMessage> => { throw new Error("Unexpected SDK query"); };
  if (savedLogDir === undefined) delete process.env.AIDLC_TEST_LOG_DIR;
  else process.env.AIDLC_TEST_LOG_DIR = savedLogDir;
  for (const dir of scratch.splice(1)) rmSync(dir, { recursive: true, force: true });
});

describe("a project's audit, kept with the leg", () => {
  test("every space and intent shard and a flat audit.md, at their paths in the project", () => {
    const proj = temp("aidlc-leg-proj-");
    put(proj, "aidlc/spaces/default/audit/host-a.md", "## SPACE_CREATED\n");
    put(proj, "aidlc/spaces/default/intents/261021-fix-x/audit/host-a.md", "## WORKFLOW_STARTED\n");
    put(proj, "aidlc/spaces/teamb/intents/261021-y/audit/host-b.md", "## STAGE_STARTED\n");
    put(proj, "aidlc-docs/audit.md", "## LEGACY\n");
    put(proj, "aidlc/spaces/default/intents/261021-fix-x/inception/notes.md", "not audit\n");
    keepLegAudit(proj);
    expect(keptAudit()).toEqual({
      "aidlc/spaces/default/audit/host-a.md": "## SPACE_CREATED\n",
      "aidlc/spaces/default/intents/261021-fix-x/audit/host-a.md": "## WORKFLOW_STARTED\n",
      "aidlc/spaces/teamb/intents/261021-y/audit/host-b.md": "## STAGE_STARTED\n",
      "aidlc-docs/audit.md": "## LEGACY\n",
    });
  });

  test("a later keep of the same project overwrites its copy; another project gets its own", () => {
    const one = temp("aidlc-leg-proj-");
    const two = temp("aidlc-leg-proj-");
    const shard = put(one, "aidlc/spaces/default/intents/i/audit/h.md", "row 1\n");
    put(two, "aidlc/spaces/default/intents/i/audit/h.md", "other\n");
    keepLegAudit(one);
    appendFileSync(shard, "row 2\n");
    keepLegAudit(one);
    keepLegAudit(two);
    const copies = Object.entries(kept()).filter(([path]) => path.startsWith("audit/"));
    expect(copies.map(([, text]) => text).sort()).toEqual(["other\n", "row 1\nrow 2\n"]);
    expect(new Set(copies.map(([path]) => path.split("/")[1])).size).toBe(2);
  });

  test.skipIf(process.platform === "win32")("a linked shard or folder is never followed", () => {
    const proj = temp("aidlc-leg-proj-");
    const outside = temp("aidlc-leg-outside-");
    put(outside, "secret.md", "outside the project\n");
    put(outside, "intents/x/audit/h.md", "outside too\n");
    put(proj, "aidlc/spaces/default/intents/i/audit/h.md", "inside\n");
    symlinkSync(join(outside, "secret.md"), join(proj, "aidlc/spaces/default/intents/i/audit/linked.md"));
    mkdirSync(join(proj, "aidlc/spaces/linked"), { recursive: true });
    symlinkSync(join(outside, "intents"), join(proj, "aidlc/spaces/linked/intents"));
    keepLegAudit(proj);
    expect(keptAudit()).toEqual({ "aidlc/spaces/default/intents/i/audit/h.md": "inside\n" });
  });

  test("nothing is written without a log folder", () => {
    const proj = temp("aidlc-leg-proj-");
    put(proj, "aidlc/spaces/default/intents/i/audit/h.md", "row\n");
    delete process.env.AIDLC_TEST_LOG_DIR;
    keepLegAudit(proj);
    keepAgentWords("claude-sdk", [{ turn: 1, text: "hello" }]);
    expect(existsSync(join(logDir, "leg-evidence"))).toBe(false);
  });

  test("a shard over its cap keeps its start and end, says how much was cut, and stays valid UTF-8", () => {
    const proj = temp("aidlc-leg-proj-");
    const text = `${"é".repeat(300)}MIDDLE${"ü".repeat(300)}`;
    put(proj, "aidlc/spaces/default/intents/i/audit/h.md", text);
    keepLegAudit(proj, { ...LEG_EVIDENCE_LIMITS, shardBytes: 400 });
    const copy = keptAudit()["aidlc/spaces/default/intents/i/audit/h.md"];
    expect(Buffer.byteLength(copy)).toBeLessThan(500);
    expect(copy.startsWith("éé")).toBe(true);
    expect(copy.endsWith("üü")).toBe(true);
    expect(copy).not.toContain("MIDDLE");
    expect(copy).not.toContain("�");
    expect(copy).toMatch(/\(leg-evidence cut \d+ bytes here\)/);
  });

  test("past the leg's ceiling nothing more is kept, and one line says so", () => {
    const limits = { ...LEG_EVIDENCE_LIMITS, legBytes: 100 };
    const one = temp("aidlc-leg-proj-");
    const two = temp("aidlc-leg-proj-");
    put(one, "aidlc/spaces/default/intents/i/audit/h.md", "a".repeat(60));
    put(two, "aidlc/spaces/default/intents/i/audit/h.md", "b".repeat(60));
    keepLegAudit(one, limits);
    keepLegAudit(two, limits);
    keepAgentWords("claude-sdk", [{ turn: 1, text: "c".repeat(60) }], limits);
    const files = kept();
    expect(Object.values(files).filter((text) => text === "a".repeat(60))).toHaveLength(1);
    expect(Object.values(files).some((text) => text.includes("b".repeat(60)) || text.includes("c".repeat(60)))).toBe(false);
    expect(files["not-kept.txt"].trim().split("\n")).toHaveLength(1);
    expect(files["not-kept.txt"]).toContain("100 bytes");
  });
});

describe("what the agent told the person, kept with the leg", () => {
  test("one line per text, with its harness and turn; a text over its cap is cut from the middle", () => {
    keepAgentWords("claude-sdk", [{ turn: 1, text: "Here is the plan." }, { turn: 2, text: `${"x".repeat(5000)}MID${"y".repeat(5000)}` }]);
    const [first, second] = keptWords();
    expect(first).toMatchObject({ harness: "claude-sdk", turn: 1, text: "Here is the plan." });
    expect(typeof first.ts).toBe("string");
    expect(second.turn).toBe(2);
    expect(Buffer.byteLength(String(second.text))).toBeLessThanOrEqual(LEG_EVIDENCE_LIMITS.textBytes);
    expect(String(second.text)).not.toContain("MID");
    expect(String(second.text)).toMatch(/^x+\n\(leg-evidence cut \d+ bytes here\)\ny+$/);
    expect(second.bytes).toBe(10003);
  });

  test("the SDK drive keeps each of the lead's texts by turn, not a subagent's, and the project's audit", async () => {
    const proj = createTestProject();
    scratch.push(proj);
    const shard = seededAuditShard(proj);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, "\n---\n\n## WORKFLOW_STARTED\n**Timestamp**: 2026-10-21T00:00:00Z\n**Event**: WORKFLOW_STARTED\n");
    const say = (text: string, parent?: string) => ({
      type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}),
      message: { content: [{ type: "text", text }] },
    }) as unknown as SDKMessage;
    const done = { type: "result", subtype: "success", is_error: false, num_turns: 1 } as unknown as SDKMessage;
    scenario = async function* (input) {
      const prompts = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await prompts.next();
      yield say("Here is the plan.");
      yield say("subagent notes", "task_1");
      yield say("Which plan do you want?");
      yield done;
      if ((await prompts.next()).done) return;
      yield say("Going with the bugfix plan.");
      yield done;
    };
    await driveAidlc("/aidlc fix the greeter", {
      projectDir: proj,
      nextMessage: (ended) => (ended.turn === 1 ? "the bugfix one" : undefined),
    });
    expect(keptWords().map(({ harness, turn, text }) => ({ harness, turn, text }))).toEqual([
      { harness: "claude-sdk", turn: 1, text: "Here is the plan." },
      { harness: "claude-sdk", turn: 1, text: "Which plan do you want?" },
      { harness: "claude-sdk", turn: 2, text: "Going with the bugfix plan." },
    ]);
    const shardInProject = posix(relative(proj, shard));
    expect(keptAudit()[shardInProject]).toBe(readFileSync(shard, "utf8"));
    cleanupTestProject(proj);
  });

  test("a Codex exec keeps the project's audit (its words are in its own exec log)", () => {
    const proj = temp("aidlc-leg-proj-");
    put(proj, "aidlc/spaces/default/intents/i/audit/h.md", "row\n");
    recordCodexExec("words", proj, ["codex", "exec"], { rc: 0, stdout: "", stderr: "" }, codexPersonTurn(proj, "/aidlc"));
    expect(keptAudit()).toEqual({ "aidlc/spaces/default/intents/i/audit/h.md": "row\n" });
  });

  test("Copilot's replies: the lead's finished messages of a JSON turn, or the printed reply", () => {
    expect(copilotReplies(copilotJson, true)).toEqual([{ ts: "2026-10-21T01:00:04.000Z", text: "Which plan do you want?" }]);
    expect(copilotReplies("AI-DLC status: no work yet.\n", false)).toEqual([{ text: "AI-DLC status: no work yet." }]);
    expect(copilotReplies("   \n", false)).toEqual([]);
  });

  test("opencode's replies: the text parts of a JSON turn, or the printed reply", () => {
    expect(opencodeReplies(opencodeJson, true)).toEqual([{ ts: new Date(1792544402000).toISOString(), text: "The change is planned. Approve it?" }]);
    expect(opencodeReplies("Status: idle\n", false)).toEqual([{ text: "Status: idle" }]);
  });

  test.skipIf(process.platform === "win32")("a Copilot and an opencode turn keep the reply and the project's audit", () => {
    const proj = temp("aidlc-leg-proj-");
    put(proj, "aidlc/spaces/default/intents/i/audit/h.md", "row\n");
    copilotTurn(proj, "/aidlc fix the greeter", { copilotHome: join(proj, ".home"), sessionId: "s", resume: false, json: true });
    opencodeTurn(proj, "/aidlc fix the greeter");
    expect(keptWords().map(({ harness, text }) => ({ harness, text }))).toEqual([
      { harness: "copilot", text: "Which plan do you want?" },
      { harness: "opencode", text: "The change is planned. Approve it?" },
    ]);
    expect(keptAudit()).toEqual({ "aidlc/spaces/default/intents/i/audit/h.md": "row\n" });
  });

  test("a TUI session's words come from its transcript: the lead's texts for that folder, with their times and turns", () => {
    const config = temp("aidlc-leg-config-");
    const proj = temp("aidlc-leg-proj-");
    const line = (o: Record<string, unknown>) => JSON.stringify({ cwd: proj, sessionId: "s1", ...o });
    put(config, "projects/p1/s1.jsonl", [
      line({ type: "user", timestamp: "2026-10-21T02:00:00.000Z", message: { role: "user", content: "/aidlc fix the greeter" } }),
      line({ type: "assistant", timestamp: "2026-10-21T02:00:05.000Z", message: { content: [{ type: "text", text: "Here is the plan." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
      line({ type: "user", timestamp: "2026-10-21T02:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
      line({ type: "assistant", timestamp: "2026-10-21T02:00:07.000Z", isSidechain: true, message: { content: [{ type: "text", text: "subagent notes" }] } }),
      line({ type: "user", timestamp: "2026-10-21T02:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "the bugfix one" }] } }),
      line({ type: "assistant", timestamp: "2026-10-21T02:01:05.000Z", message: { content: [{ type: "text", text: "Going with the bugfix plan." }] } }),
      "{ cut off",
    ].join("\n"));
    put(config, "projects/p2/other.jsonl", JSON.stringify({ type: "assistant", cwd: join(proj, "elsewhere"), timestamp: "2026-10-21T02:00:00.000Z", message: { content: [{ type: "text", text: "another folder" }] } }));
    keepTranscriptWords(proj, config);
    keepTranscriptWords(proj, config);
    expect(keptWords().map(({ ts, harness, turn, text }) => ({ ts, harness, turn, text }))).toEqual([
      { ts: "2026-10-21T02:00:05.000Z", harness: "claude-tui", turn: 1, text: "Here is the plan." },
      { ts: "2026-10-21T02:01:05.000Z", harness: "claude-tui", turn: 2, text: "Going with the bugfix plan." },
    ]);
  });
});

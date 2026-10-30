// What safe.json says about the run itself: which tools it used, what the
// hooks dropped inside the window, which signals come from what is missing,
// and how a tool's name is written when it names someone's own server.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AuditRow, absenceSignals, readHooksHealth, timeWindow } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";
import { toolsUsed } from "../../core/skills/aidlc-issue-report/scripts/lib-project.ts";
import { claude } from "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts";

// The AI-DLC install whose own rules the skill borrows (secret rules, file match, copied shards).
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
const row = (ts: string, event: string, fields: Record<string, string> = {}): AuditRow => ({ ts, event, fields, intent: "i" });
const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;

test("a tool used only to make this report is not a tool the run used", () => {
  expect(toolsUsed([{ tool: "claude-code", sessions: 1, reportSessions: 1 }])).toEqual([]);
  expect(toolsUsed([{ tool: "claude-code", sessions: 2, reportSessions: 1 }])).toEqual(["claude"]);
});

test("both rows a doctor run writes leave the default window where the run was", () => {
  const rows = [row("2026-10-28T10:00:00Z", "STAGE_STARTED"), row("2026-10-29T11:00:00Z", "GUARDRAIL_LOADED"), row("2026-10-29T11:00:01Z", "HEALTH_CHECKED")];
  expect(timeWindow({ rows, now: Date.parse("2026-10-29T12:00:00Z") }).since).toBe(Date.parse("2026-10-21T08:00:00Z"));
});

test("hook drops after the window's end are left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-health-"));
  writeFileSync(join(dir, "plan-approval-guard.drops"), [`${at(5)}\tlock busy: x`, `${at(50)}\tlock busy: y`].join("\n"));
  const h = readHooksHealth([dir], Date.parse(at(0)), Date.parse(at(30)));
  expect(h.drops.map((d) => d.ts)).toEqual([at(5)]);
});

test("an open approval gate is doctor's to say, not a signal of this skill's own", () => {
  const rows = [row(at(1), "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" }), row(at(2), "STAGE_SKIPPED", { Stage: "requirements-analysis" })];
  expect(absenceSignals(rows).filter((a) => a.kind === "gate-never-answered")).toEqual([]);
});

test("an MCP tool's name keeps no server name", () => {
  const root = mkdtempSync(join(tmpdir(), "run-facts-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const call = (min: number) => ({
    cwd: project,
    sessionId: "s1",
    isSidechain: false,
    type: "assistant",
    timestamp: at(min),
    message: { role: "assistant", content: [{ type: "tool_use", id: `t${min}`, name: "mcp__acme-crm__lookup_customer", input: { id: 7 } }] },
  });
  writeFileSync(join(dir, "s1.jsonl"), [call(1), call(2), call(3)].map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const s = claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(JSON.stringify(s)).not.toContain("acme");
    expect(s?.repeats[0]?.tool).toBe("mcp");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a Copilot CLI session that made this report is the report, not the run", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sess = join(home, ".copilot", "session-state", "s1");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "workspace.yaml"), `cwd: ${project}\n`);
  const events = [
    { type: "user.message", timestamp: at(1), data: { content: "make an issue report" } },
    { type: "tool.execution_start", timestamp: at(2), data: { arguments: { command: "bun .github/skills/aidlc-issue-report/scripts/collect.ts" } } },
    { type: "user.message", timestamp: at(3), data: { content: "also hide the bank" } },
  ];
  writeFileSync(join(sess, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  // Bun reads HOME once at start, so the reader runs in a child with the fixture as its home.
  const code = `const { copilotCli } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
const s = copilotCli(${JSON.stringify(project)}, ${Date.parse(at(0)) - 3_600_000}, ${Date.parse(at(59))}, local);
console.log(JSON.stringify({ reportSessions: s?.reportSessions, reports: local.prompts.map((p) => !!p.report) }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ reportSessions: 1, reports: [true, true] });
});

test("an audit record written with Windows line ends is read", async () => {
  const { readAudit } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const project = mkdtempSync(join(tmpdir(), "crlf-"));
  const dir = join(project, "aidlc", "spaces", "default", "intents", "261029-x");
  mkdirSync(join(dir, "audit"), { recursive: true });
  const block = (event: string, ts: string) => `## ${event}\r\n**Event**: ${event}\r\n**Timestamp**: ${ts}\r\n**Stage**: requirements-analysis\r\n`;
  writeFileSync(join(dir, "audit", "a.md"), `${block("STAGE_STARTED", at(1))}\r\n---\r\n\r\n${block("GATE_APPROVED", at(2))}`);
  const rows = readAudit(project, [{ space: "default", dir: "261029-x", path: dir }]);
  expect(rows.map((r) => [r.event, r.fields.Stage])).toEqual([
    ["STAGE_STARTED", "requirements-analysis"],
    ["GATE_APPROVED", "requirements-analysis"],
  ]);
});

test("--until alone reads the days before that end, not a window after it", () => {
  const w = timeWindow({ until: "2026-10-01T00:00:00Z", rows: [row("2026-10-28T10:00:00Z", "STAGE_STARTED")], now: Date.parse("2026-10-29T12:00:00Z") });
  expect(w.until).toBe(Date.parse("2026-10-01T00:00:00Z"));
  expect(w.since).toBe(Date.parse("2026-10-01T00:00:00Z") - 7 * 86_400_000 - 2 * 3_600_000);
  expect(w.notes).toEqual([]);
});

test("a Codex session whose first line is longer than 64 KB is still this project's", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project, instructions: "x".repeat(200_000) } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run the next stage" }] } },
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s = codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(s?.sessions).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a Kiro session that switched agent before the run went on is the run up to the report request", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sess = join(home, ".kiro", "sessions", "ws", "sess_1");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "session.json"), JSON.stringify({ workspacePaths: [project], modelId: "auto", agentMode: "vibe" }));
  const mode = (agentMode: string) => ({ kiro: { agentMode } });
  const lines = [
    { timestamp: at(1), payload: { type: "user", content: "start the feature", _meta: mode("aidlc") } },
    { timestamp: at(2), payload: { type: "user", content: "go on here", _meta: mode("vibe") } },
    { timestamp: at(3), payload: { type: "tool_call", toolName: "execute_bash", args: { command: "bun .kiro/tools/aidlc.ts engine orchestrate next" }, _meta: mode("vibe") } },
    { timestamp: at(10), payload: { type: "user", content: "make an issue report", _meta: mode("vibe") } },
    { timestamp: at(11), payload: { type: "tool_call", toolName: "execute_bash", args: { command: "bun .kiro/skills/aidlc-issue-report/scripts/collect.ts" }, _meta: mode("vibe") } },
  ];
  writeFileSync(join(sess, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  // Bun reads HOME once at start, so the reader runs in a child with the fixture as its home.
  const code = `const { kiroV3 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
const s = kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify({ mixed: s?.mixedSessions, reports: local.prompts.map((p) => !!p.report) }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ mixed: 1, reports: [false, false, true] });
});

test("a copied audit shard (a sync tool's conflict copy) is read once, by AI-DLC's own rule", async () => {
  const { readAudit } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const { importAidlcTools } = await import("../../core/skills/aidlc-issue-report/scripts/lib-project.ts");
  const project = mkdtempSync(join(tmpdir(), "copied-"));
  const dir = join(project, "aidlc", "spaces", "default", "intents", "261029-x");
  mkdirSync(join(dir, "audit"), { recursive: true });
  const block = (event: string, ts: string) => `## ${event}\n**Event**: ${event}\n**Timestamp**: ${ts}\n`;
  const text = `${block("STAGE_STARTED", at(1))}\n---\n${block("ERROR_LOGGED", at(2))}`;
  writeFileSync(join(dir, "audit", "host-a1b2.md"), text);
  writeFileSync(join(dir, "audit", "host-a1b2 2.md"), text);
  const rows = readAudit(project, [{ space: "default", dir: "261029-x", path: dir }], await importAidlcTools(RULES));
  expect(rows.map((r) => r.event)).toEqual(["STAGE_STARTED", "ERROR_LOGGED"]);
});

test("a guard switch keeps its scope and who switched it; a field written twice keeps its first value", async () => {
  const { readAudit } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const project = mkdtempSync(join(tmpdir(), "guard-"));
  const dir = join(project, "aidlc", "spaces", "default", "intents", "261029-x");
  mkdirSync(join(dir, "audit"), { recursive: true });
  writeFileSync(join(dir, "audit", "a.md"), `## GUARD_DISABLED\n**Event**: GUARD_DISABLED\n**Timestamp**: ${at(1)}\n**Guard**: plan-approval\n**Scope**: feature\n**Source**: you\n**Guard**: review-freeze\n`);
  const rows = readAudit(project, [{ space: "default", dir: "261029-x", path: dir }]);
  expect(rows[0].fields).toMatchObject({ Guard: "plan-approval", Scope: "feature", Source: "you" });
});

test("a Codex call that failed before it ran counts as an error, and an approval review's rejection as a denial", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-fail-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const out = (output: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "function_call_output", call_id: `c${min}`, output } });
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project } },
    out('exec_command failed: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\")" }', 1),
    out("apply_patch verification failed: Failed to find expected lines in a.ts", 2),
    out("failed to parse function arguments: EOF while parsing a string at line 1 column 9", 3),
    out("Chunk ID: 1a\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nok", 4),
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s = codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(s?.toolErrors).toBe(3);
    expect(s?.denials).toEqual({ "policy-denied": 1 });
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("Claude Code's folder named twice (CLAUDE_CONFIG_DIR is ~/.claude) is read once", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-twice-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const key = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ type: "user", cwd: project, sessionId: "s1", timestamp: at(1), message: { role: "user", content: "next stage please" } }));
  const code = `const { claude } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
claude(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify(local.prompts.length));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude", "") + "/" } });
  expect(JSON.parse(r.stdout)).toBe(1);
});

test("a Kiro run's engine call in a sub-execution keeps the report part after it; a denied check is a denial", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-sub-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sess = join(home, ".kiro", "sessions", "ws", "sess_1");
  mkdirSync(join(sess, "sub-executions"), { recursive: true });
  writeFileSync(join(sess, "session.json"), JSON.stringify({ workspacePaths: [project], modelId: "auto", agentMode: "vibe" }));
  const mode = (agentMode: string) => ({ kiro: { agentMode } });
  const main = [
    { timestamp: at(1), payload: { type: "user", content: "start the feature", _meta: mode("aidlc") } },
    { timestamp: at(2), payload: { type: "user", content: "go on here", _meta: mode("vibe") } },
    { timestamp: at(4), payload: { type: "tool_call", toolName: "execute_bash", toolCallId: "k1", args: { command: "bun .kiro/tools/aidlc.ts engine sensor-traceability --stage requirements-analysis" }, _meta: mode("vibe") } },
    { timestamp: at(5), payload: { type: "tool_result", toolCallId: "k1", success: false, content: "Tool use was denied. Rule: deny" } },
    { timestamp: at(10), payload: { type: "user", content: "make an issue report", _meta: mode("vibe") } },
    { timestamp: at(11), payload: { type: "tool_call", toolName: "execute_bash", args: { command: "bun .kiro/skills/aidlc-issue-report/scripts/collect.ts" }, _meta: mode("vibe") } },
  ];
  writeFileSync(join(sess, "messages.jsonl"), main.map((l) => JSON.stringify(l)).join("\n"));
  const sub = [{ timestamp: at(3), payload: { type: "tool_call", toolName: "execute_bash", args: { command: "bun .kiro/tools/aidlc.ts engine orchestrate next" } } }];
  writeFileSync(join(sess, "sub-executions", "x.jsonl"), sub.map((l) => JSON.stringify(l)).join("\n"));
  // Bun reads HOME once at start, so the reader runs in a child with the fixture as its home.
  const code = `const { kiroV3 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
const s = kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify({ mixed: s?.mixedSessions, denials: s?.denials, reports: local.prompts.map((p) => !!p.report) }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ mixed: 1, denials: { "agent-profile-deny": 1 }, reports: [false, false, true] });
});

test("Kiro CLI v3's own wording of a permission-rule refusal is a denial", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-deny-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sess = join(home, ".kiro", "sessions", "ws", "sess_1");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "session.json"), JSON.stringify({ workspacePaths: [project], modelId: "auto", agentMode: "aidlc" }));
  const lines = [
    { timestamp: at(1), payload: { type: "user", content: "next" } },
    { timestamp: at(2), payload: { type: "tool_result", success: false, content: 'Blocked by a permission rule (deny fs_read matching ".kiro/"); the user did not reject it.' } },
  ];
  writeFileSync(join(sess, "messages.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const code = `const { kiroV3 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify(s?.denials));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ "agent-profile-deny": 1 });
});

test.skipIf(process.platform === "win32")("Claude Code's folder named through a link is read once", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-link-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const key = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ type: "user", cwd: project, sessionId: "s1", timestamp: at(1), message: { role: "user", content: "next stage please" } }));
  symlinkSync(join(home, ".claude"), join(home, "claude-alias"));
  const code = `const { claude } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
claude(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify(local.prompts.length));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude-alias") } });
  expect(JSON.parse(r.stdout)).toBe(1);
});

test("a Codex run on Windows that made this report is found through the JSON-escaped path", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-win-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "make an issue report" }] } },
    { timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: "bun C:\\p\\.codex\\skills\\aidlc-issue-report\\scripts\\collect.ts" }) } },
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const local = { prompts: [], refusals: [], errors: [] } as { prompts: { report?: boolean }[]; refusals: never[]; errors: never[] };
    codex(project, 0, Date.parse(at(59)), local as never);
    expect(local.prompts.map((p) => !!p.report)).toEqual([true]);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a Claude Code session's first engine call is its earliest, whichever file holds it", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-sub-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const key = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  const user = (min: number, content: string) => ({ type: "user", cwd: project, sessionId: "s1", timestamp: at(min), message: { role: "user", content } });
  const call = (min: number, command: string) => ({ type: "assistant", cwd: project, sessionId: "s1", timestamp: at(min), message: { role: "assistant", content: [{ type: "tool_use", id: `u${min}`, name: "Bash", input: { command } }] } });
  writeFileSync(join(dir, "s1.jsonl"), [
    user(1, "go on"),
    call(2, "bun .claude/tools/aidlc.ts engine orchestrate next"),
    user(3, "make an issue report"),
    call(4, "bun .claude/skills/aidlc-issue-report/scripts/collect.ts"),
  ].map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(dir, "s1", "subagents", "a.jsonl"), JSON.stringify(call(5, "bun .claude/tools/aidlc.ts engine orchestrate report")));
  const code = `const { claude } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = claude(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify(s?.mixedSessions));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "" } });
  expect(JSON.parse(r.stdout)).toBe(1);
});

test("a Claude subagent's engine call is tied to the person's reply before it, not the latest one read", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-order-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const key = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  const user = (min: number, content: string) => ({ type: "user", cwd: project, sessionId: "s1", timestamp: at(min), message: { role: "user", content } });
  const call = (min: number, command: string) => ({ type: "assistant", cwd: project, sessionId: "s1", timestamp: at(min), message: { role: "assistant", content: [{ type: "tool_use", id: `u${min}`, name: "Bash", input: { command } }] } });
  writeFileSync(join(dir, "s1.jsonl"), [user(1, "run the next stage"), user(5, "thanks, that is all")].map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(dir, "s1", "subagents", "a.jsonl"), JSON.stringify(call(3, "bun .claude/tools/aidlc.ts engine orchestrate next")));
  const code = `const { claude } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
claude(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify(local.prompts.map((p) => p.engineAfter)));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "" } });
  expect(JSON.parse(r.stdout)).toEqual([true, false]);
});

test("an empty state field is empty, not the next line", async () => {
  const { readState } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  writeFileSync(join(dir, "aidlc-state.md"), "- **Guards Off**:\n- **Sensors**: aidlc-linter\n");
  const st = readState({ space: "default", dir: "x", path: dir });
  expect(st?.guardsOff).toBeNull();
  expect(st?.sensors).toBe("aidlc-linter");
});

test("audit rows are put in time order, a Timestamp with an offset included", async () => {
  const { readAudit } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const project = mkdtempSync(join(tmpdir(), "order-"));
  const dir = join(project, "aidlc", "spaces", "default", "intents", "261029-x");
  mkdirSync(join(dir, "audit"), { recursive: true });
  const block = (event: string, ts: string) => `## ${event}\n**Event**: ${event}\n**Timestamp**: ${ts}\n`;
  writeFileSync(join(dir, "audit", "a.md"), `${block("STAGE_STARTED", "2026-10-29T10:00:00+09:00")}\n---\n${block("GATE_APPROVED", "2026-10-29T02:00:00Z")}`);
  const rows = readAudit(project, [{ space: "default", dir: "261029-x", path: dir }]);
  expect(rows.map((r) => r.event)).toEqual(["STAGE_STARTED", "GATE_APPROVED"]);
});

test("a run driven by AI-DLC's tool scripts directly counts as engine calls", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-direct-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const key = resolve(project).replace(/[^A-Za-z0-9]/g, "-");
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", cwd: project, sessionId: "s1", timestamp: at(1), message: { role: "user", content: "go on" } },
    { type: "assistant", cwd: project, sessionId: "s1", timestamp: at(2), message: { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "bun .claude/tools/aidlc-orchestrate.ts next" } }] } },
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const code = `const { claude } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
claude(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify(local.prompts.map((p) => p.engineAfter)));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "" } });
  expect(JSON.parse(r.stdout)).toEqual([true]);
});

test("two errors that differ only in a quoted name are the same error; an apostrophe in a word is not a quote", async () => {
  const { readAudit } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const project = mkdtempSync(join(tmpdir(), "errgroup-"));
  const dir = join(project, "aidlc", "spaces", "default", "intents", "261029-x");
  mkdirSync(join(dir, "audit"), { recursive: true });
  const block = (ts: string, error: string) => `## ERROR_LOGGED\n**Event**: ERROR_LOGGED\n**Timestamp**: ${ts}\n**Error**: ${error}\n`;
  writeFileSync(join(dir, "audit", "a.md"), [block(at(1), "Cannot read “a.ts”"), block(at(2), "Cannot read “b.ts”"), block(at(3), "can't open 'x' here"), block(at(4), "can't open 'y' there")].join("\n---\n"));
  const rows = readAudit(project, [{ space: "default", dir: "261029-x", path: dir }]);
  const g = rows.map((r) => r.fields["Error Group"]);
  expect(g[0]).toBe(g[1]);
  expect(g[2]).not.toBe(g[3]);
});

test.skipIf(process.platform === "win32")("a dangling link among the intents or the hook health files stops nothing", async () => {
  const { readHooksHealth } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const { listIntents } = await import("../../core/skills/aidlc-issue-report/scripts/lib-project.ts");
  const project = mkdtempSync(join(tmpdir(), "dangling-"));
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  mkdirSync(join(intents, "261029-x"), { recursive: true });
  symlinkSync(join(project, "gone"), join(intents, "261029-moved"));
  expect(listIntents(project).map((i) => i.dir)).toEqual(["261029-x"]);
  const health = join(project, "health");
  mkdirSync(health);
  symlinkSync(join(project, "gone"), join(health, "x.drops"));
  expect(() => readHooksHealth([health], 0)).not.toThrow();
});

test("a Codex session whose folder name is stored decomposed (macOS) is this project's", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-nfd-"));
  const project = join(home, "프로젝트");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project.normalize("NFD") } },
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] } },
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    expect(codex(project.normalize("NFC"), 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] })?.sessions).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a Kiro or Copilot reply after which no engine call ran is marked as not about the work", () => {
  const home = mkdtempSync(join(tmpdir(), "reply-home-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const kiro = join(home, ".kiro", "sessions", "ws", "sess_1");
  mkdirSync(kiro, { recursive: true });
  writeFileSync(join(kiro, "session.json"), JSON.stringify({ workspacePaths: [project], modelId: "auto", agentMode: "aidlc" }));
  const k = [
    { timestamp: at(1), payload: { type: "user", content: "start the feature" } },
    { timestamp: at(2), payload: { type: "tool_call", toolName: "execute_bash", args: { command: "bun .kiro/tools/aidlc.ts engine orchestrate next" } } },
    { timestamp: at(5), payload: { type: "user", content: "what does this error mean?" } },
  ];
  writeFileSync(join(kiro, "messages.jsonl"), k.map((l) => JSON.stringify(l)).join("\n"));
  const copilot = join(home, ".copilot", "session-state", "s1");
  mkdirSync(copilot, { recursive: true });
  writeFileSync(join(copilot, "workspace.yaml"), `cwd: ${project}\n`);
  const c = [
    { type: "user.message", timestamp: at(1), data: { content: "start the feature" } },
    { type: "tool.execution_start", timestamp: at(2), data: { arguments: { command: "bun .github/tools/aidlc.ts engine orchestrate next" } } },
    { type: "user.message", timestamp: at(5), data: { content: "what does this error mean?" } },
  ];
  writeFileSync(join(copilot, "events.jsonl"), c.map((e) => JSON.stringify(e)).join("\n"));
  const code = `const { kiroV3, copilotCli } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const kiro = { prompts: [], refusals: [], errors: [] };
kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, kiro);
const copilot = { prompts: [], refusals: [], errors: [] };
copilotCli(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, copilot);
console.log(JSON.stringify([kiro.prompts.map((p) => p.engineAfter), copilot.prompts.map((p) => p.engineAfter)]));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual([[true, false], [true, false]]);
});

test("a Copilot CLI session that ran AI-DLC and then made this report counts as the run too", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-mixed-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const sess = join(home, ".copilot", "session-state", "s1");
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, "workspace.yaml"), `cwd: ${project}\n`);
  const events = [
    { type: "user.message", timestamp: at(1), data: { content: "start the feature" } },
    { type: "tool.execution_start", timestamp: at(2), data: { arguments: { command: "bun .github/tools/aidlc.ts engine orchestrate next" } } },
    { type: "user.message", timestamp: at(5), data: { content: "make an issue report" } },
    { type: "tool.execution_start", timestamp: at(6), data: { arguments: { command: "bun .github/skills/aidlc-issue-report/scripts/collect.ts" } } },
  ];
  writeFileSync(join(sess, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  const code = `const { copilotCli } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = copilotCli(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify({ reportSessions: s?.reportSessions, mixedSessions: s?.mixedSessions }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ reportSessions: 1, mixedSessions: 1 });
});

test("collect refuses an --out folder that already holds something, and writes nothing there", () => {
  const project = mkdtempSync(join(tmpdir(), "collect-out-"));
  mkdirSync(join(project, "aidlc", "spaces", "default"), { recursive: true });
  const out = mkdtempSync(join(tmpdir(), "collect-out-taken-"));
  writeFileSync(join(out, "keep.txt"), "the person's own file");
  const r = spawnSync(process.execPath, [resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/collect.ts"), "--project", project, "--out", out, "--no-doctor"], { encoding: "utf8" });
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout).reason).toBe("out-not-empty");
  expect(readdirSync(out)).toEqual(["keep.txt"]);
});

// Windows and macOS read a path in any case; Linux does not.
test.skipIf(process.platform === "linux")("a Claude Code log is found when the project path comes in another case", () => {
  const root = mkdtempSync(join(tmpdir(), "run-facts-case-"));
  const project = join(root, "Proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const line = { cwd: project, sessionId: "s1", isSidechain: false, type: "user", timestamp: at(1), message: { role: "user", content: "start the feature" } };
  writeFileSync(join(dir, "s1.jsonl"), JSON.stringify(line));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const s = claude(join(root, "proj"), Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(s?.sessions).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("--days out of range is said in the window's notes", () => {
  for (const days of ["400", "two", "0"]) {
    const w = timeWindow({ days, rows: [row("2026-10-28T10:00:00Z", "STAGE_STARTED")], now: Date.parse("2026-10-29T12:00:00Z") });
    expect(w.notes.some((n) => n.startsWith("--days"))).toBe(true);
  }
  expect(timeWindow({ days: "3", rows: [], now: Date.parse("2026-10-29T12:00:00Z") }).notes).toEqual([]);
  // With --since the window does not use --days at all.
  expect(timeWindow({ days: "0", since: "2026-10-01T00:00:00Z", rows: [], now: Date.parse("2026-10-29T12:00:00Z") }).notes).toEqual([]);
});

test("a hook refusal is counted however the install runs its hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-tags-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const tags = [
    "[aidlc engine hook plan-approval-guard]",
    '[bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook guard-tool-call]',
    '["C:\\Users\\u\\AppData\\Local\\aidlc\\aidlc.exe" engine hook review-freeze]',
    "[bun .codex/tools/aidlc.ts engine adapter codex guard-tool-call]",
    // the same, inside text a reader turned into JSON (Copilot, Kiro): the quotes come escaped
    '[\\"C:\\\\u\\\\aidlc.exe\\" engine hook state-transition-guard]',
    // an argument after the route, PowerShell's exit line, Bun's `--`, Cursor's route-less adapter
    "[bun .kiro/tools/aidlc.ts engine adapter kiro reviewer-scope aidlc-architecture-reviewer-agent]",
    "[& aidlc engine hook plan-approval-guard; exit $LASTEXITCODE]",
    '[bun ".cursor/tools/aidlc.ts" -- engine hook guard-tool-call]',
    "[aidlc engine adapter cursor]",
    "[aidlc engine adapter cursor --project-dir /x]",
    "[bun .aidlc/hooks/aidlc-copilot-adapter.ts guard-tool-call]",
    "[bun .cursor/hooks/aidlc-cursor-adapter.ts guards]",
    "[aidlc engine adapter cursor guards]",
    "[bun .kiro/hooks/aidlc-kiro-adapter.ts plan-approval-guard]",
    "[AIDLC-COPILOT-adapter.ts guard-tool-call]",
  ];
  const lines = tags.map((tag, i) => ({
    cwd: project,
    sessionId: "s1",
    type: "user",
    timestamp: at(i + 1),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: `PreToolUse:Bash hook error: ${tag}: refused` }] },
  }));
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const s = claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(s?.aidlcHookBlocks).toEqual({
      "plan-approval-guard": 3, "guard-tool-call": 5, "review-freeze": 1, "state-transition-guard": 1, "reviewer-scope": 1, "cursor-adapter": 4,
    });
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a Codex subagent's session is not a session or a reply of the person's, and a call it copied counts once", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-sub-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const user = (text: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const call = (id: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: `{"cmd":"ls ${id}"}` } });
  const parent = [{ timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project } }, user("run the next stage", 1), call("c1", 2)];
  const child = [
    { timestamp: at(3), type: "session_meta", payload: { id: "t2", cwd: project, thread_source: "subagent", parent_thread_id: "t1" } },
    user("run the next stage", 1),
    call("c1", 2),
    user("review the plan for the parent agent", 4),
    call("c2", 5),
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51.jsonl"), parent.map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(day, "rollout-2026-10-29T01-03-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52.jsonl"), child.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s = codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect([s?.sessions, s?.prompts, s?.toolCalls]).toEqual([1, 1, 2]);
    expect(s?.notes.some((n) => n.startsWith("1 Codex subagent"))).toBe(true);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("Kiro sessions of a folder under the project are read beside the project's own", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-ws-"));
  const project = join(home, "proj");
  mkdirSync(join(project, "app"), { recursive: true });
  const ws16 = (p: string) => createHash("sha256").update(resolve(p)).digest("hex").slice(0, 16);
  for (const [ws, path, id] of [[ws16(project), project, "sess_a"], [ws16(join(project, "app")), join(project, "app"), "sess_b"]] as const) {
    const sess = join(home, ".kiro", "sessions", ws, id);
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, "session.json"), JSON.stringify({ workspacePaths: [path] }));
    writeFileSync(join(sess, "messages.jsonl"), JSON.stringify({ timestamp: at(1), payload: { type: "user", content: `hello from ${id}` } }));
  }
  const code = `const { kiroV3 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify({ sessions: s?.sessions }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ sessions: 2 });
});

test("Kiro CLI v2 replies with no time of their own are marked, and the notes say why they are not matched", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-v2-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const dir = join(home, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ cwd: project, updated_at: at(30) }));
  const lines = [
    { kind: "Prompt", data: { content: "start the feature" } },
    { kind: "AssistantMessage", data: { content: "running aidlc engine orchestrate next" } },
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const code = `const { kiroV2 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const local = { prompts: [], refusals: [], errors: [] };
const s = kiroV2(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, local);
console.log(JSON.stringify({ noTime: local.prompts.map((p) => !!p.noTime), note: s?.notes.some((n) => n.startsWith("Kiro CLI v2 lines carry no time")) }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ noTime: [true], note: true });
});

test("what the report session did itself is not counted with the run", () => {
  const root = mkdtempSync(join(tmpdir(), "report-counts-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false };
  const said = (min: number, text: string) => ({ ...base, type: "user", timestamp: at(min), message: { role: "user", content: text } });
  const ran = (min: number, command: string) => ({
    ...base,
    type: "assistant",
    timestamp: at(min),
    message: { role: "assistant", content: [{ type: "tool_use", id: `t${min}`, name: "Bash", input: { command } }] },
  });
  const check = "bun .claude/skills/aidlc-issue-report/scripts/check.ts --out x";
  const failed = (min: number, id: string, text: string) => ({
    ...base,
    type: "user",
    timestamp: at(min),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] },
  });
  const lines = [
    said(1, "start the feature"),
    ran(2, "aidlc engine orchestrate next"),
    said(10, "make an issue report"),
    ran(11, "bun .claude/skills/aidlc-issue-report/scripts/collect.ts --project ."),
    ran(12, check),
    ran(13, check),
    ran(14, check),
    ran(15, "aidlc engine sensor-traceability --stage build-and-test"),
    failed(16, "t15", '{"pass": false}'),
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local = { prompts: [], refusals: [], errors: [] };
    const s = claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), local);
    expect([s?.prompts, s?.toolCalls, s?.repeats.length, s?.aidlcCommands]).toEqual([1, 1, 0, { "aidlc orchestrate next": 1 }]);
    expect([s?.handRunChecks, s?.toolErrors, local.errors]).toEqual([[], 0, []]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a Kiro CLI v2 session's report part is cut by place, its lines having no time", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-v2-report-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const dir = join(home, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ cwd: project, updated_at: at(30) }));
  const tool = (command: string) => ({ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", command }] } });
  const lines = [
    { kind: "Prompt", data: { content: "start the feature" } },
    tool("aidlc engine orchestrate next"),
    { kind: "Prompt", data: { content: "make an issue report" } },
    tool("bun .kiro/skills/aidlc-issue-report/scripts/collect.ts"),
    tool("bun .kiro/skills/aidlc-issue-report/scripts/check.ts"),
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const code = `const { kiroV2 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = kiroV2(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify({ prompts: s?.prompts, toolCalls: s?.toolCalls }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ prompts: 1, toolCalls: 1 });
});

test("a project opened through a link is found under the path the tool logged", () => {
  const root = mkdtempSync(join(tmpdir(), "linked-"));
  const real = join(root, "real-proj");
  mkdirSync(real);
  const link = join(root, "link-proj");
  symlinkSync(real, link);
  const config = join(root, "cfg");
  const dir = join(config, "projects", realpathSync(real).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const line = { cwd: realpathSync(real), sessionId: "s1", type: "user", timestamp: at(1), message: { role: "user", content: "start the feature" } };
  writeFileSync(join(dir, "s1.jsonl"), JSON.stringify(line));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    expect(claude(link, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] })?.prompts).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a Codex approval review started while the report ran is not counted with the run", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-review-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const user = (text: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const call = (id: string, cmd: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) } });
  const parent = [
    { timestamp: at(0), type: "session_meta", payload: { id: "t1", cwd: project } },
    user("run the next stage", 1),
    call("c1", "aidlc engine orchestrate next", 2),
    user("make an issue report", 10),
    call("c2", "bun .codex/skills/aidlc-issue-report/scripts/collect.ts", 11),
  ];
  const review = [
    { timestamp: at(11), type: "session_meta", payload: { id: "t2", cwd: project, thread_source: "guardian_review", parent_thread_id: "t1" } },
    call("r1", "cat collect.ts", 12),
    call("r2", "cat lib-gate.ts", 13),
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61.jsonl"), parent.map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(day, "rollout-2026-10-29T01-11-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62.jsonl"), review.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    expect(codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] })?.toolCalls).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a report turn with no time of its own does not take away a run reply's HUMAN_TURN", async () => {
  const { withoutReportTurns } = await import("../../core/skills/aidlc-issue-report/scripts/lib-audit.ts");
  const rows = [row(at(30), "HUMAN_TURN")];
  expect(withoutReportTurns(rows, [{ tool: "kiro-cli (v2)", ts: at(30), text: "x", report: true, noTime: true }])).toEqual(rows);
});

test("a Kiro CLI v2 report that starts before any reply in the session counts none of its own calls", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-v2-first-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const dir = join(home, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ cwd: project, updated_at: at(30) }));
  const lines = [{ kind: "AssistantMessage", data: { content: [{ kind: "toolUse", command: "bun .kiro/skills/aidlc-issue-report/scripts/collect.ts" }] } }];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const code = `const { kiroV2 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = kiroV2(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify({ toolCalls: s?.toolCalls }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(JSON.parse(r.stdout)).toEqual({ toolCalls: 0 });
});

test("a Codex subagent's copied history from before its start is not counted, and subagents alone are no run", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-orphan-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const call = (id: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: `{"cmd":"ls ${id}"}` } });
  const child = [
    { timestamp: at(20), type: "session_meta", payload: { id: "t2", cwd: project, thread_source: "subagent", parent_thread_id: "t-old" } },
    call("old1", 5),
    call("new1", 21),
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-20-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a71.jsonl"), child.map((l) => JSON.stringify(l)).join("\n"));
  const parent = [{ timestamp: at(30), type: "session_meta", payload: { id: "t3", cwd: project } }, call("p1", 31)];
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    expect(codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] })).toBeNull();
    writeFileSync(join(day, "rollout-2026-10-29T01-30-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a72.jsonl"), parent.map((l) => JSON.stringify(l)).join("\n"));
    expect(codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] })?.toolCalls).toBe(2);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a Codex session the person forked is their run; the history it copied is not counted again", async () => {
  const { codex } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-fork-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const user = (text: string, min: number) => ({ timestamp: at(min), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const fork = [
    // the start written without milliseconds, the first reply with them in the same second
    { timestamp: "2026-10-29T01:20:00Z", type: "session_meta", payload: { id: "t2", cwd: project, thread_source: "user", forked_from_id: "t-old" } },
    user("what we said before the fork", 5),
    { ...user("go on", 20), timestamp: "2026-10-29T01:20:00.412Z" },
    user("run the next stage", 21),
  ];
  writeFileSync(join(day, "rollout-2026-10-29T01-20-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a81.jsonl"), fork.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const s = codex(project, 0, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect([s?.sessions, s?.prompts]).toEqual([1, 2]);
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test("a Kiro workspace folder is told by a session.json that names its workspace", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-ws-empty-"));
  const project = join(home, "proj");
  mkdirSync(project);
  const ws = join(home, ".kiro", "sessions", "0123456789abcdef");
  // A broken session.json in another folder must not stop the reader.
  mkdirSync(join(home, ".kiro", "sessions", "fedcba9876543210", "sess_x"), { recursive: true });
  writeFileSync(join(home, ".kiro", "sessions", "fedcba9876543210", "sess_x", "session.json"), "null");
  for (const [id, meta] of [["sess_a", {}], ["sess_b", { workspacePaths: [project] }]] as const) {
    mkdirSync(join(ws, id), { recursive: true });
    writeFileSync(join(ws, id, "session.json"), JSON.stringify(meta));
    writeFileSync(join(ws, id, "messages.jsonl"), JSON.stringify({ timestamp: at(1), payload: { type: "user", content: `hello from ${id}` } }));
  }
  const code = `const { kiroV3 } = await import(${JSON.stringify(resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts"))});
const s = kiroV3(${JSON.stringify(project)}, 0, ${Date.parse(at(59))}, { prompts: [], refusals: [], errors: [] });
console.log(JSON.stringify({ found: !!s }));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect([r.status, r.stderr]).toEqual([0, ""]);
  expect(JSON.parse(r.stdout)).toEqual({ found: true });
});

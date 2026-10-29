// What safe.json says about the run itself: which tools it used, what the
// hooks dropped inside the window, which signals come from what is missing,
// and how a tool's name is written when it names someone's own server.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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

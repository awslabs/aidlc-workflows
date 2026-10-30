// The Claude Code reader counts the person's typed replies; collect.ts matches
// each to an AI-DLC HUMAN_TURN and lists the rest as "not recorded". Claude
// Code also writes user-typed lines nobody typed: the compaction summary that
// opens a continued session and the "[Request interrupted by user]" marker.
// Counted as replies, each becomes a false "your answer did not reach AI-DLC".

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claude, type Local } from "../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts";

test("compaction summaries and interrupt markers are not typed replies", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-replies-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false, type: "user" };
  const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;
  const lines = [
    { ...base, timestamp: at(1), message: { role: "user", content: "start the workflow" } },
    { ...base, timestamp: at(2), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { ...base, timestamp: at(3), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
    {
      ...base,
      timestamp: at(4),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." },
    },
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));

  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local: Local = { prompts: [], refusals: [], errors: [] };
    const s = claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), local);
    expect(s?.prompts).toBe(1);
    expect(local.prompts.map((p) => p.text)).toEqual(["start the workflow"]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("replies typed for this report are marked, the run's replies are not", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-replies-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false };
  const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;
  const say = (min: number, text: string) => ({ ...base, type: "user", timestamp: at(min), message: { role: "user", content: text } });
  const run = (min: number, command: string) => ({
    ...base,
    type: "assistant",
    timestamp: at(min),
    message: { role: "assistant", content: [{ type: "tool_use", id: `t${min}`, name: "Bash", input: { command } }] },
  });
  const lines = [
    say(1, "start the workflow"),
    run(2, "aidlc engine orchestrate next"),
    say(10, "make an issue report"),
    run(11, "bun .claude/skills/aidlc-issue-report/scripts/collect.ts --project ."),
    say(15, "also hide the bank's name"),
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local: Local = { prompts: [], refusals: [], errors: [] };
    claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), local);
    expect(local.prompts.map((p) => [p.text, !!p.report])).toEqual([
      ["start the workflow", false],
      ["make an issue report", true],
      ["also hide the bank's name", true],
    ]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a report asked for in the run's own session keeps the run's model apart from the report's", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-replies-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false };
  const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;
  const say = (min: number, text: string) => ({ ...base, type: "user", timestamp: at(min), version: "2.1.300", message: { role: "user", content: text } });
  const run = (min: number, model: string, command: string) => ({
    ...base,
    type: "assistant",
    timestamp: at(min),
    version: "2.1.300",
    message: { role: "assistant", model, content: [{ type: "tool_use", id: `t${min}`, name: "Bash", input: { command } }] },
  });
  const lines = [
    say(1, "start the workflow"),
    run(2, "model-run", "aidlc engine orchestrate next"),
    say(10, "make an issue report"),
    run(11, "model-report", "bun .claude/skills/aidlc-issue-report/scripts/collect.ts --project ."),
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const s = claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), { prompts: [], refusals: [], errors: [] });
    expect(s?.models).toEqual({ "model-run": 1 });
    expect(s?.reportModels).toEqual({ "model-report": 1 });
    expect(s?.toolVersions).toEqual({ "2.1.300": 1 });
    expect(s?.reportSessions).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a slash command is a typed reply; a reply no AI-DLC command followed is not about the work", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-replies-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false };
  const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;
  const say = (min: number, content: string) => ({ ...base, type: "user", timestamp: at(min), message: { role: "user", content } });
  const run = (min: number, command: string) => ({
    ...base,
    type: "assistant",
    timestamp: at(min),
    message: { role: "assistant", content: [{ type: "tool_use", id: `t${min}`, name: "Bash", input: { command } }] },
  });
  const lines = [
    say(1, "<command-name>/aidlc</command-name>\n<command-message>aidlc</command-message>\n<command-args>start the shop</command-args>"),
    run(2, "aidlc engine orchestrate next"),
    say(5, "what is a monad?"),
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local: Local = { prompts: [], refusals: [], errors: [] };
    claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), local);
    expect(local.prompts.map((p) => [p.text, p.engineAfter])).toEqual([
      ["/aidlc start the shop", true],
      ["what is a monad?", false],
    ]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a reply that starts with `<` is the person's; a tagged block the tool put there is not", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-angle-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const base = { cwd: project, sessionId: "s1", isSidechain: false, type: "user" };
  const at = (min: number) => `2026-10-29T01:${String(min).padStart(2, "0")}:00.000Z`;
  const lines = [
    { ...base, timestamp: at(1), message: { role: "user", content: "<div> is not shown on the page" } },
    { ...base, timestamp: at(4), message: { role: "user", content: "<b>approve</b>" } },
    { ...base, timestamp: at(2), message: { role: "user", content: "<system-reminder>\nthe date is today\n</system-reminder>" } },
    { ...base, timestamp: at(3), message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" } },
  ];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local: Local = { prompts: [], refusals: [], errors: [] };
    claude(project, Date.parse(at(0)) - 3_600_000, Date.parse(at(59)), local);
    expect(local.prompts.map((p) => p.text)).toEqual(["<div> is not shown on the page", "<b>approve</b>"]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test("a line of many tagged blocks is read at once", async () => {
  const { claude: read } = await import("../../core/skills/aidlc-issue-report/scripts/lib-transcripts.ts");
  const root = mkdtempSync(join(tmpdir(), "claude-blocks-"));
  const project = join(root, "proj");
  mkdirSync(project);
  const config = join(root, "cfg");
  const dir = join(config, "projects", resolve(project).replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const text = `${"<system-reminder>x</system-reminder>".repeat(60)} please approve`;
  const line = { cwd: project, sessionId: "s1", type: "user", timestamp: "2026-10-29T01:01:00.000Z", message: { role: "user", content: text } };
  writeFileSync(join(dir, "s1.jsonl"), JSON.stringify(line));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const local: Local = { prompts: [], refusals: [], errors: [] };
    const started = Date.now();
    read(project, Date.parse("2026-10-29T00:00:00Z"), Date.parse("2026-10-29T02:00:00Z"), local);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(local.prompts.length).toBe(1);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

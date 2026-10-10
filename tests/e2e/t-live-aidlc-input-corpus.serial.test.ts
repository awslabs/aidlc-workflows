// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next, hook:aidlc-record-human-turn
//
// t-live-aidlc-input-corpus: a sample of the /aidlc input corpus (tests/fixtures/aidlc-input/corpus.json) driven
// through REAL agents on the shipped trees: Claude Code through the SDK, Codex through `codex exec`, Kiro CLI over
// ACP. On demand, never in PR CI: AIDLC_INPUT_LIVE=1 opens it, and each harness keeps its own live gate
// (AIDLC_CODEX_EXEC_LIVE, AIDLC_KIRO_ACP_LIVE; Claude needs the `claude` binary). Scratch projects and scratch homes
// (the SDK's ephemeral CLAUDE_CONFIG_DIR, the Codex driver's CODEX_HOME); the real homes are listed and hashed
// before and after, and a change in ~/.claude or ~/.codex fails the file.
//
// Pass, per item: the end state matches `expected.end` (the right work created or none, the right record active,
// the right setting set by the person, the gate or plan answered), the message record keeps their words, and a
// question reached the person only where the item is `ambiguous`. A report with a score per category and every
// miss with its transcript excerpt is written under AIDLC_INPUT_REPORT_DIR (default tests/logs/aidlc-input-live).
//
// Sample: AIDLC_INPUT_SAMPLE = a comma list of item ids, or a number per category (default 3), seeded by
// AIDLC_INPUT_SEED (default 1), from the items that carry `expected.end` and wait for nothing.
// Harnesses: AIDLC_INPUT_HARNESSES (default claude,codex,kiro).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  LIVE_COMMAND_TIMEOUT_MS,
  LIVE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  liveCaseTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { REPO_ROOT, cleanupTestProject, seedAidlcMemory, seedWorkspaceShell, setupIntegrationProject } from "../harness/fixtures.ts";
import { execCodex, setupCodexProject } from "../harness/exec-drive.ts";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";
import { CORPUS, buildState, codexWords, itemEnv, messageRecord, typedPrompt, waitsFor, type CorpusItem } from "../harness/aidlc-input-corpus.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getField, listIntents, readAuditShardEvents, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(LIVE_SETUP_TIMEOUT_MS);

type LiveHarness = "claude" | "codex" | "kiro";
const LIVE = process.env.AIDLC_INPUT_LIVE === "1";
const KNOWN_HARNESSES: readonly LiveHarness[] = ["claude", "codex", "kiro"];
// The agents this run drives, each named exactly: a name this check does not know (a typo of one) stops the file here,
// before any agent runs, instead of falling through to one the person did not choose.
const HARNESSES = [...new Set((process.env.AIDLC_INPUT_HARNESSES ?? "claude,codex,kiro").split(",").map((s) => s.trim()).filter(Boolean))].map((name) => {
  if (!(KNOWN_HARNESSES as readonly string[]).includes(name)) throw new Error(`AIDLC_INPUT_HARNESSES names ${JSON.stringify(name)}, which this check does not drive; it knows ${KNOWN_HARNESSES.join(", ")}`);
  return name as LiveHarness;
});
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_COMMAND_TIMEOUT_MS);
const REPORT_DIR = process.env.AIDLC_INPUT_REPORT_DIR ?? join(REPO_ROOT, "tests", "logs", "aidlc-input-live");

function gate(harness: LiveHarness): string | null {
  if (!LIVE) return "set AIDLC_INPUT_LIVE=1 to drive the input corpus through real agents (spends tokens)";
  if (harness === "claude" && !Bun.which("claude")) return "claude binary not found";
  if (harness === "codex" && process.env.AIDLC_CODEX_EXEC_LIVE !== "1") return "set AIDLC_CODEX_EXEC_LIVE=1 for the Codex half";
  if (harness === "codex" && !Bun.which(process.env.AIDLC_CODEX_BIN ?? "codex")) return "codex binary not found";
  if (harness === "kiro" && process.env.AIDLC_KIRO_ACP_LIVE !== "1") return "set AIDLC_KIRO_ACP_LIVE=1 for the Kiro CLI half";
  if (harness === "kiro" && !Bun.which("kiro-cli")) return "kiro-cli binary not found";
  return null;
}

// A seeded sample so a re-run drives the same items.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(): CorpusItem[] {
  // Hooks-off items need the host's hooks not to run; a real agent session runs them, so they stay with the unit check.
  const eligible = CORPUS.filter((item) => item.expected.end !== undefined && waitsFor(item) === null && item.state !== "hooks-off");
  const spec = process.env.AIDLC_INPUT_SAMPLE ?? "3";
  if (/^\d+$/.test(spec) === false) {
    const ids = new Set(spec.split(",").map((s) => s.trim()));
    return eligible.filter((item) => ids.has(item.id));
  }
  const perCategory = Number.parseInt(spec, 10);
  const random = mulberry32(Number.parseInt(process.env.AIDLC_INPUT_SEED ?? "1", 10) || 1);
  const out: CorpusItem[] = [];
  for (const category of [...new Set(eligible.map((i) => i.category))]) {
    const pool = eligible.filter((i) => i.category === category);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    out.push(...pool.slice(0, perCategory));
  }
  return out;
}
const SAMPLE = sample();

// The real homes, listed and hashed: path, size and mtime of every file outside logs and caches.
function homeDigest(dir: string): { digest: string; files: Map<string, string> } {
  const files = new Map<string, string>();
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      // Claude Code rotates backups/.claude.json.backup.<ts> on its own start, in the real home even under an
      // ephemeral CLAUDE_CONFIG_DIR: the tool's doing, not AI-DLC's, so it is left out like the logs.
      // Claude Code also writes its own session artifacts into the real home (teams/<session>, plugins/store, a
      // plugin's marker dotfile) under an ephemeral CLAUDE_CONFIG_DIR: the tool's doing, left out like the logs.
      if (/(^|\/)(logs?|cache|caches|telemetry|tmp|shell-snapshots|projects|statsig|todos|sessions|backups|file-history|teams|plugins|paste-cache|history\.jsonl|\.last-cleanup|\.[a-z-]+-active)$/.test(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const s = statSync(path);
        files.set(relative(dir, path), `${s.size}:${Math.floor(s.mtimeMs)}`);
      }
    }
  };
  walk(dir);
  const digest = createHash("sha256").update([...files.entries()].sort().map(([p, v]) => `${p} ${v}`).join("\n")).digest("hex");
  return { digest, files };
}
// Each tool's real home, hashed strictly before and after. A home this run drives must come back unchanged; a home
// of a tool this run does not drive can change under another process on the same box (another live run, the tool's
// own daemon), which the report names as such rather than hiding.
const HOMES = ["claude", "codex", "kiro"].map((name) => join(homedir(), `.${name}`));
const drivesHome = (home: string): boolean => HARNESSES.some((h) => home.endsWith(`.${h}`)) || home.endsWith(".claude");
const before = new Map<string, ReturnType<typeof homeDigest>>();

interface Transcript { tools: string[]; text: string; asks: number | null; raw?: string }
interface Outcome { item: CorpusItem; harness: LiveHarness; prompt: string; failures: string[]; endSummary: string; transcript: Transcript }
const outcomes: Outcome[] = [];

interface Snapshot { records: number; active: string | null; stateFile: string }
function snapshot(proj: string): Snapshot {
  const intents = listIntents(proj);
  const path = stateFilePath(proj);
  return {
    records: intents.length,
    active: intents.find((i) => i.active)?.slug ?? null,
    stateFile: existsSync(path) ? readFileSync(path, "utf-8") : "",
  };
}

// True once what the item expects on disk is there: the drive stops at that point.
function endReached(item: CorpusItem, proj: string, start: Snapshot): boolean {
  const end = item.expected.end ?? {};
  try {
    const events = readAuditShardEvents(proj).map((e) => e.event);
    if (end.gate === "approved") return events.includes("GATE_APPROVED");
    if (end.gate === "rejected") return events.includes("GATE_REJECTED");
    if (end.plan === "approved") return events.includes("PLAN_APPROVAL_RECORDED");
    const after = snapshot(proj);
    if (end.set?.length) return end.set.every(([field, value]) => (getField(after.stateFile, field) ?? "").includes(value));
    if (end.active) return (after.active ?? "").includes(end.active);
    if (typeof end.work === "object") return after.records > start.records;
  } catch {
    /* an unreadable record is not the end */
  }
  return false;
}

// How many questions back to the person the item allows: its own `end.asks`, else one where the line is ambiguous, none where the meaning is clear.
function asksAllowedFor(item: CorpusItem): number {
  return item.expected.end?.asks ?? (item.ambiguous ? 1 : item.expected.engine.no_ask ? 0 : 1);
}

// The end state, judged against `expected.end` and the record against `expected.engine`.
function judge(item: CorpusItem, proj: string, prompt: string, start: Snapshot, transcript: Transcript): { failures: string[]; endSummary: string } {
  const failures: string[] = [];
  const end = item.expected.end ?? {};
  const engine = item.expected.engine;
  const after = snapshot(proj);
  const intents = listIntents(proj);
  const summary = `records ${start.records} -> ${after.records}, active ${start.active ?? "-"} -> ${after.active ?? "-"}`;

  const record = messageRecord(proj, prompt);
  if (record === null) failures.push("no message record for the typed line");
  else {
    if (record.text.trim() !== prompt.trim()) failures.push(`record text ${JSON.stringify(record.text)} is not the typed line`);
    if (engine.words !== undefined && record.words !== engine.words) failures.push(`record words ${JSON.stringify(record.words)}, expected ${JSON.stringify(engine.words)}`);
  }
  // A question the item allows pauses the work there: the person has not answered yet, so the end state is not owed.
  const asksAllowed = asksAllowedFor(item);
  const paused = (transcript.asks ?? 0) > 0 && (transcript.asks ?? 0) <= asksAllowed;
  if (end.work === "none" && after.records !== start.records) failures.push(`a record was created (${summary})`);
  if (end.work === "same") {
    if (after.records !== start.records) failures.push(`a record was created (${summary})`);
    if (!end.active && after.active !== start.active) failures.push(`the active record changed (${summary})`);
  }
  if (typeof end.work === "object" && !paused) {
    const created = intents.filter((i) => i.active || true).slice(start.records);
    if (after.records <= start.records) failures.push(`no new record (${summary})`);
    else {
      const fresh = created[created.length - 1];
      if (end.work.scope && fresh?.scope !== end.work.scope) failures.push(`new record scope ${fresh?.scope ?? "-"}, expected ${end.work.scope}`);
      if (end.work.words) {
        const dir = fresh?.dirName ? join(proj, "aidlc", "spaces", "default", "intents", fresh.dirName) : null;
        const text = dir && existsSync(join(dir, "aidlc-state.md")) ? readFileSync(join(dir, "aidlc-state.md"), "utf-8") : "";
        if (!text.toLowerCase().includes(end.work.words.toLowerCase())) failures.push(`the new record does not carry the words ${JSON.stringify(end.work.words)}`);
      }
    }
  }
  if (end.active && !paused && !(after.active ?? "").includes(end.active)) failures.push(`active record ${after.active ?? "-"}, expected ${end.active}`);
  for (const [field, value] of paused ? [] : end.set ?? []) {
    const got = getField(after.stateFile, field) ?? "";
    if (!got.includes(value)) failures.push(`${field}: ${JSON.stringify(got)}, expected to contain ${JSON.stringify(value)}`);
  }
  const events = readAuditShardEvents(proj).map((e) => e.event);
  if (end.gate === "approved" && !paused && !events.includes("GATE_APPROVED")) failures.push("the gate was not approved");
  if (end.gate === "rejected" && !paused && !events.includes("GATE_REJECTED")) failures.push("the gate was not sent back for changes");
  if (end.gate === "open" && (events.includes("GATE_APPROVED") || events.includes("GATE_REJECTED"))) failures.push("the gate was decided");
  if (end.plan === "approved" && !paused && !events.includes("PLAN_APPROVAL_RECORDED")) failures.push("the plan was not approved");
  if (end.plan === "open" && events.includes("PLAN_APPROVAL_RECORDED")) failures.push("the plan question was answered");
  if (transcript.asks !== null && transcript.asks > asksAllowed) failures.push(`${transcript.asks} question(s) to the person, ${asksAllowed} allowed`);
  return { failures, endSummary: summary };
}

// What the agent told the person, judged by a model against MEANING and a short rubric (Arden, 2026-10-10): plain
// words, no engine terms, a question only where the item is ambiguous. What happened on disk stays a script above.
// The judge runs `claude -p` with no tools from an empty folder and its own config dir, so no hook and no home is
// touched; its verdict is one JSON line.
let judgeDir = "";
async function judgeText(item: CorpusItem, text: string): Promise<string | null> {
  if (text.trim().length === 0) return "the agent said nothing to the person before carrying on (no line about what it did)";
  const rubric = [
    "You judge one reply an AI assistant gave to a person who typed a line in a software project tool.",
    `The person typed: ${JSON.stringify(typedPrompt(item))}`,
    `What the person meant: ${item.meaning}`,
    asksAllowedFor(item) > 0
      ? "A question back to the person is allowed once: the meaning leaves one choice to the person or the line is ambiguous. A reply that asks that one question plainly passes; so does a reply that acts consistently with the meaning without asking."
      : "A question back to the person is not allowed: the meaning is clear and the person asked for nothing to be confirmed.",
    "The reply passes when all three hold: (1) it says in plain words what was done, or what the person now needs to decide, consistent with what they meant; " +
      "(2) it shows the person no engine internals: no bun or script command lines, no tool names such as aidlc-*.ts, no JSON or raw field names, no words such as directive, orchestrate, hook, kind, and no engine files (anything under .claude, .codex, .kiro, .aidlc-engine or .aidlc-sessions, or named aidlc-*; the state and audit files). " +
      "The product's own words are fine and expected: a /aidlc line the person could type next (with its documented flags), the words intent, space, scope, stage, gate, plan and unit, stage names (Requirements Analysis, Code Generation), settings (Guard Policy, plan approval, depth), a progress line, and ordinary English such as 'the next step'. " +
      "The person's own project files, requirements and tests may be named, and so may the documents the work produces for them (the plan, requirements, questions and review files, with their path under aidlc/spaces); " +
      "(3) it asks a question only where allowed above; one question with several options is one question. Judge the assistant's words to the person, not its work log; a short confirmation of what happened is a pass.",
    'Answer with one line of JSON only, nothing else: {"ok": true or false, "reason": "<one sentence>"}',
    "The reply to judge follows.",
    text.slice(-4000),
  ].join("\n\n");
  const proc = Bun.spawn(
    ["claude", "-p", rubric, "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--permission-mode", "default",
      "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill", "AskUserQuestion"],
    { cwd: judgeDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CONFIG_DIR: join(judgeDir, "config") } },
  );
  const timer = setTimeout(() => proc.kill(), remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS));
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status !== 0) return `the judge could not run (exit ${status}): ${stderr.slice(0, 200)}`;
    const result = String((JSON.parse(stdout) as { result?: string }).result ?? "");
    const verdict = /\{[^{}]*"ok"\s*:\s*(true|false)[^{}]*\}/.exec(result);
    if (!verdict) return `the judge gave no verdict: ${result.slice(0, 200)}`;
    const parsed = JSON.parse(verdict[0]) as { ok: boolean; reason?: string };
    return parsed.ok ? null : `the agent's words: ${parsed.reason ?? "did not match what the person meant"}`;
  } finally {
    clearTimeout(timer);
  }
}

async function drive(harness: LiveHarness, item: CorpusItem): Promise<Outcome> {
  const prompt = harness === "codex" && item.entry === undefined ? typedPrompt(item).replace(/^\/aidlc/, "$aidlc") : typedPrompt(item);
  let proj: string;
  let home: string | undefined;
  let cleanup: () => void = () => {};
  if (harness === "claude") {
    proj = setupIntegrationProject();
    cleanup = () => cleanupTestProject(proj);
  } else if (harness === "codex") {
    const codex = setupCodexProject({ workspaceWrite: true });
    proj = codex.proj;
    home = codex.home;
    seedAidlcMemory(proj);
    seedWorkspaceShell(proj);
    cleanup = () => cleanupTestProject(codex.root);
  } else if (harness === "kiro") {
    proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
    seedAidlcMemory(proj);
    seedWorkspaceShell(proj);
    cleanup = () => cleanupTuiProject(proj);
  } else {
    throw new Error(`no drive for harness ${JSON.stringify(harness)}`);
  }
  // The item's own environment (unattended runs) reaches the agent's process the way a person's shell would.
  const extraEnv = itemEnv(item);
  const previous = Object.fromEntries(Object.keys(extraEnv).map((k) => [k, process.env[k]]));
  try {
    await buildState(proj, item.state);
    const start = snapshot(proj);
    Object.assign(process.env, extraEnv);
    let transcript: Transcript;
    if (harness === "claude") {
      // The drive ends one tool call after what the item expects is on disk (the gate approved, the setting set, the
      // record switched, the work created): the agent says its line to the person between that step and its next
      // tool call, and would then carry on into the next stage, whose own work and questions are not what this item
      // judges.
      let reachedAt: number | null = null;
      const r = await driveAidlc(prompt, {
        projectDir: proj,
        permissionMode: "bypassPermissions",
        stopAfterAskUserQuestion: true,
        stopWhen: (results) => {
          if (reachedAt === null && endReached(item, proj, start)) reachedAt = results.length;
          return reachedAt !== null && results.length > reachedAt + 1;
        },
        timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS),
        env: extraEnv,
      });
      transcript = {
        tools: r.toolResults.map((t) => `${t.toolName} ${JSON.stringify(t.input).slice(0, 200)} -> ${t.resultText.slice(0, 200)}`),
        // The person reads the agent's words up to its question, then the question itself (the picker is the agent's
        // words too). What the agent says after the drive's scripted answer was never said to a person.
        text: [r.assistantTextBeforeFirstAsk ?? r.assistantText, ...r.askedQuestions.flatMap((q) => q.questions.map((x) => `Question to the person: ${x.question} [${x.options.map((o) => o.label).join(" / ")}]`))].join("\n"),
        asks: r.askedQuestions.length,
      };
    } else if (harness === "codex") {
      const r = execCodex(proj, home as string, prompt);
      transcript = { tools: [], text: codexWords(r.out), asks: null, raw: r.out };
    } else {
      const r = await driveKiroAcp({ projectDir: proj, prompt, timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS) });
      transcript = {
        tools: r.toolCalls.map((t) => `${t.title ?? ""} ${JSON.stringify(t).slice(0, 300)}`),
        text: r.assistantText,
        asks: null,
      };
    }
    const { failures, endSummary } = judge(item, proj, prompt, start, transcript);
    const words = await judgeText(item, transcript.text);
    if (words !== null) failures.push(words);
    return { item, harness, prompt, failures, endSummary, transcript };
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  }
}

// A miss is one or more of: the records are wrong or missing (work, active record, setting, gate, plan, the typed
// line), a question the item did not allow, engine words in what the agent told the person.
function missKinds(failures: string[]): { record: boolean; question: boolean; words: boolean } {
  const question = failures.some((f) => /question\(s\) to the person/.test(f));
  const words = failures.some((f) => /^the agent's words:|^the agent said nothing|^the judge /.test(f));
  const record = failures.some((f) => !/question\(s\) to the person|^the agent's words:|^the agent said nothing|^the judge /.test(f));
  return { record, question, words };
}

function writeReport(): void {
  if (outcomes.length === 0) return;
  mkdirSync(REPORT_DIR, { recursive: true });
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) }).stdout.trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const harness of [...new Set(outcomes.map((o) => o.harness))]) {
    const mine = outcomes.filter((o) => o.harness === harness);
    const lines = [`# Live input corpus: ${harness} at ${sha} (${stamp})`, "", `Sample: ${process.env.AIDLC_INPUT_SAMPLE ?? "3"} per category, seed ${process.env.AIDLC_INPUT_SEED ?? "1"}. Items driven: ${mine.length}.`, "", "## Score per category", "", "Misses are counted three ways: record (wrong or missing record: work, active record, setting, gate, plan, the typed line), question (one the item did not allow), words (engine words in what the agent told the person). One miss can count in several.", "", "| category | pass | total | record | question | words |", "|---|---|---|---|---|---|"];
    for (const category of [...new Set(mine.map((o) => o.item.category))]) {
      const rows = mine.filter((o) => o.item.category === category);
      const kinds = rows.map((o) => missKinds(o.failures));
      lines.push(`| ${category} | ${rows.filter((o) => o.failures.length === 0).length} | ${rows.length} | ${kinds.filter((k) => k.record).length} | ${kinds.filter((k) => k.question).length} | ${kinds.filter((k) => k.words).length} |`);
    }
    const all = mine.filter((o) => o.failures.length > 0).map((o) => missKinds(o.failures));
    lines.push("", `Misses: ${all.length} of ${mine.length}; record ${all.filter((k) => k.record).length}, question ${all.filter((k) => k.question).length}, words ${all.filter((k) => k.words).length}; words only ${all.filter((k) => k.words && !k.record && !k.question).length}.`);
    lines.push("", "## Misses", "");
    for (const o of mine.filter((o) => o.failures.length > 0)) {
      lines.push(`### ${o.item.id} [${o.item.state}] ${JSON.stringify(o.prompt)}`, "", `MEANING: ${o.item.meaning}`, "", ...o.failures.map((f) => `- ${f}`), "", `End state: ${o.endSummary}`, "", "Transcript excerpt:", "", "```", ...o.transcript.tools.slice(-8), "", o.transcript.text.slice(-600), "```", "");
    }
    for (const home of HOMES) {
      const was = before.get(home);
      if (!was) continue;
      const now = homeDigest(home);
      const changed = [...now.files.entries()].filter(([p, v]) => was.files.get(p) !== v).map(([p]) => p);
      const how = drivesHome(home) ? "CHANGED by this run" : "CHANGED by another process (this run did not drive that tool)";
      lines.push(`Home ${home}: ${was.digest === now.digest ? "unchanged" : `${how}: ${changed.slice(0, 20).join(", ")}`}`);
    }
    writeFileSync(join(REPORT_DIR, `REPORT-${harness}-${sha}-${stamp}.md`), `${lines.join("\n")}\n`, "utf-8");
    // Every transcript as judged, one JSON line per item, so the words can be re-read without driving the agents again.
    const rows = mine.map((o) => JSON.stringify({ id: o.item.id, prompt: o.prompt, failures: o.failures, end: o.endSummary, asks: o.transcript.asks, text: o.transcript.text, tools: o.transcript.tools }));
    writeFileSync(join(REPORT_DIR, `TRANSCRIPTS-${harness}-${sha}-${stamp}.jsonl`), `${rows.join("\n")}\n`, "utf-8");
  }
}

beforeAll(() => {
  for (const home of HOMES) before.set(home, homeDigest(home));
  judgeDir = mkdtempSync(join(tmpdir(), "aidlc-input-judge-"));
  mkdirSync(join(judgeDir, "config"), { recursive: true });
});

afterAll(() => {
  writeReport();
  if (judgeDir) rmSync(judgeDir, { recursive: true, force: true });
  if (!LIVE) return;
  // The judge's own claude -p runs under its own config dir, so ~/.claude is owed unchanged on every run; a driven
  // Codex home too. Kiro CLI writes its own session data under ~/.kiro while it runs, so that home is reported, not asserted.
  for (const home of HOMES.filter((h) => !h.endsWith(".kiro") && drivesHome(h))) {
    const was = before.get(home);
    if (was) expect(homeDigest(home).digest, `${home} changed during the live run`).toBe(was.digest);
  }
});

for (const harness of HARNESSES) {
  const reason = gate(harness);
  describe(`${harness}: the input corpus through a real agent`, () => {
    if (reason !== null) {
      test.skip(`skipped: ${reason}`, () => {});
      return;
    }
    for (const item of SAMPLE) {
      test(`${item.id} ${typedPrompt(item)} [${item.state}]: ${item.meaning}`, async () => {
        const outcome = await drive(harness, item);
        outcomes.push(outcome);
        expect(outcome.failures, `${item.id} on ${harness}: ${outcome.endSummary}\n${outcome.transcript.text.slice(-400)}`).toEqual([]);
      }, CASE_TIMEOUT_MS);
    }
  });
}

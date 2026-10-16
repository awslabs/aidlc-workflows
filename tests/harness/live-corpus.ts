// The shared mechanics of the live corpus checks (tests/e2e/t-live-aidlc-input-corpus.serial.test.ts and
// tests/e2e/t-live-aidlc-answers-corpus.serial.test.ts): which real agents a run drives and each one's gate, a seeded
// sample or the nightly's rotation, the scratch project and scratch home per harness, the real homes listed and hashed,
// the model judge of what the agent told the person, and the report (a score per group, every miss with its transcript
// excerpt, the transcripts as one JSON line each, a summary for the nightly report). What each check judges on disk
// stays in its own file.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import { REPO_ROOT, cleanupTestProject, seedAidlcMemory, seedWorkspaceShell, setupIntegrationProject } from "./fixtures.ts";
import { setupCodexProject } from "./exec-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "./tui-fixtures.ts";

export type LiveHarness = "claude" | "codex" | "kiro";
export const KNOWN_HARNESSES: readonly LiveHarness[] = ["claude", "codex", "kiro"];

// The agents this run drives, each named exactly: a name this check does not know (a typo of one) stops the file here,
// before any agent runs, instead of falling through to one the person did not choose.
export function liveHarnesses(spec: string | undefined, envName: string): LiveHarness[] {
  return [...new Set((spec ?? "claude,codex,kiro").split(",").map((s) => s.trim()).filter(Boolean))].map((name) => {
    if (!(KNOWN_HARNESSES as readonly string[]).includes(name)) throw new Error(`${envName} names ${JSON.stringify(name)}, which this check does not drive; it knows ${KNOWN_HARNESSES.join(", ")}`);
    return name as LiveHarness;
  });
}

/** Why a harness is skipped this run: the check's own switch is off (`offReason`), the harness's live gate is closed,
 * or its binary is missing. Null when it runs. */
export function liveGate(harness: LiveHarness, live: boolean, offReason: string): string | null {
  if (!live) return offReason;
  if (harness === "claude" && !Bun.which("claude")) return "claude binary not found";
  if (harness === "codex" && process.env.AIDLC_CODEX_EXEC_LIVE !== "1") return "set AIDLC_CODEX_EXEC_LIVE=1 for the Codex half";
  if (harness === "codex" && !Bun.which(process.env.AIDLC_CODEX_BIN ?? "codex")) return "codex binary not found";
  if (harness === "kiro" && process.env.AIDLC_KIRO_ACP_LIVE !== "1") return "set AIDLC_KIRO_ACP_LIVE=1 for the Kiro CLI half";
  if (harness === "kiro" && !Bun.which("kiro-cli")) return "kiro-cli binary not found";
  return null;
}

// A seeded sample so a re-run drives the same items.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `perGroup` items from each group of `pool`, in a seeded shuffle; or exactly the ids `spec` lists when it is not a number. */
export function sampleByGroup<T extends { id: string }>(pool: T[], spec: string, seed: string | undefined, group: (item: T) => string): T[] {
  if (/^\d+$/.test(spec) === false) {
    const ids = new Set(spec.split(",").map((s) => s.trim()));
    return pool.filter((item) => ids.has(item.id));
  }
  const perGroup = Number.parseInt(spec, 10);
  const random = mulberry32(Number.parseInt(seed ?? "1", 10) || 1);
  const out: T[] = [];
  for (const name of [...new Set(pool.map(group))]) {
    const of = pool.filter((i) => group(i) === name);
    for (let i = of.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [of[i], of[j]] = [of[j], of[i]];
    }
    out.push(...of.slice(0, perGroup));
  }
  return out;
}

/** A Full Suite live job of the Claude SDK family: no switch of a check's own reaches the file there (the job's sandbox
 * passes the family's gate alone), so a corpus check that runs nightly opens on this. */
export function inNightly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true" && env.AIDLC_CLAUDE_SDK_LIVE === "1";
}

/** The first night of the nightly's rotation, a UTC date. */
export const ROTATION_START = "2026-10-15";
/** Nights since ROTATION_START, counted by UTC date. */
export function nightOf(now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${ROTATION_START}T00:00:00Z`)) / 86_400_000);
}

/** One item of each group of `pool` on night `night`: a group's items in pool order, one a night, so every item comes
 * round within as many nights as the largest group has items. */
export function rotateByGroup<T>(pool: T[], night: number, group: (item: T) => string): T[] {
  return [...new Set(pool.map(group))].map((name) => {
    const of = pool.filter((i) => group(i) === name);
    return of[((night % of.length) + of.length) % of.length];
  });
}

/** The build of the tool a harness drives, as the tool reports it ("unknown" when it cannot be asked). */
export function toolVersion(harness: LiveHarness): string {
  const bin = harness === "claude" ? "claude" : harness === "codex" ? process.env.AIDLC_CODEX_BIN ?? "codex" : "kiro-cli";
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  const line = `${r.stdout ?? ""}`.trim().split("\n")[0] ?? "";
  return line === "" ? "unknown" : line;
}

export interface HomeDigest { digest: string; files: Map<string, string> }
// The real homes, listed and hashed: path, size and mtime of every file outside logs and caches.
export function homeDigest(dir: string): HomeDigest {
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
export const HOMES = ["claude", "codex", "kiro"].map((name) => join(homedir(), `.${name}`));
export const drivesHome = (home: string, harnesses: readonly LiveHarness[]): boolean => harnesses.some((h) => home.endsWith(`.${h}`)) || home.endsWith(".claude");

export interface Transcript { tools: string[]; text: string; asks: number | null; raw?: string }
export interface LiveOutcome<T> { item: T; harness: LiveHarness; prompt: string; failures: string[]; endSummary: string; transcript: Transcript }

/** One item driven: its outcome kept for the report, and the misses its test owes, none when the run only reports
 * them. A drive that throws (the check itself could not run) fails the item either way. */
export async function liveItem<T>(drive: () => Promise<LiveOutcome<T>>, outcomes: LiveOutcome<T>[], reportOnly: boolean): Promise<{ outcome: LiveOutcome<T>; owed: string[] }> {
  const outcome = await drive();
  outcomes.push(outcome);
  return { outcome, owed: reportOnly ? [] : outcome.failures };
}

export interface LiveProject { proj: string; home?: string; cleanup: () => void }
/** A scratch project on the harness's shipped tree, with a scratch home where the driver takes one (Codex). */
export function liveProject(harness: LiveHarness): LiveProject {
  if (harness === "claude") {
    const proj = setupIntegrationProject();
    return { proj, cleanup: () => cleanupTestProject(proj) };
  }
  if (harness === "codex") {
    const codex = setupCodexProject({ workspaceWrite: true });
    seedAidlcMemory(codex.proj);
    seedWorkspaceShell(codex.proj);
    return { proj: codex.proj, home: codex.home, cleanup: () => cleanupTestProject(codex.root) };
  }
  if (harness === "kiro") {
    const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
    seedAidlcMemory(proj);
    seedWorkspaceShell(proj);
    return { proj, cleanup: () => cleanupTuiProject(proj) };
  }
  throw new Error(`no drive for harness ${JSON.stringify(harness)}`);
}

export interface JudgeInput {
  /** The line the person typed. */
  typed: string;
  /** What the person meant, in plain words. */
  meaning: string;
  /** How many questions back to the person the item allows. */
  asksAllowed: number;
  /** What the person must have been told, by meaning (the answers corpus's `says`). */
  says?: string[];
  /** The rubric's second criterion, what counts as engine words (ENGINE_WORDS_RULE when absent). */
  engineWords?: string;
}
/** The rubric's second criterion as the input corpus's live check has judged it. */
export const ENGINE_WORDS_RULE =
  "(2) it shows the person no engine internals: no bun or script command lines, no tool names such as aidlc-*.ts, no JSON or raw field names, no words such as directive, orchestrate, hook, kind, and no engine files (anything under .claude, .codex, .kiro, .aidlc-engine or .aidlc-sessions, or named aidlc-*; the state and audit files). " +
  "The product's own words are fine and expected: a /aidlc line the person could type next (with its documented flags), the words intent, space, scope, stage, gate, plan and unit, stage names (Requirements Analysis, Code Generation), settings (Guard Policy, plan approval, depth), a progress line, and ordinary English such as 'the next step'. " +
  "The person's own project files, requirements and tests may be named, and so may the documents the work produces for them (the plan, requirements, questions and review files, with their path under aidlc/spaces); ";
/** The same criterion as "What the person reads" (AGENTS.md) draws it: how the engine got there
 * stays off the screen; the person's work, what they need to act, what they asked for, and a host's own frame do not count. */
export const PERSON_READS_RULE =
  "(2) it shows the person nothing of how the engine got there: no bun or script command lines they did not ask for, no tool names such as aidlc-*.ts, no JSON or raw field names, no words such as directive, orchestrate, hook, receipt, kind, and no engine files (anything under .claude, .codex, .kiro, .aidlc-engine or .aidlc-sessions, or named aidlc-*; the state and audit files). " +
  "Not engine internals, and expected where they fit: the product's own words (a /aidlc line the person could type next with its documented flags; intent, space, scope, stage, gate, plan and unit; stage names such as Requirements Analysis; settings such as Guard Policy, plan approval, depth; a progress line; ordinary English such as 'the next step'); " +
  "the person's own project files, requirements and tests, and the agent's account of them (files it read, tests it ran, what it found); the documents the work produces for them (the plan, requirements, questions and review files, with their path under aidlc/spaces); a command or path the person needs in order to act (an undo, a file to edit); and the doctor, status or audit output they asked for. " +
  "A frame the host tool draws itself (Claude Code's Stop hook error text, Codex's Blocked by hook line) is the host's and is not judged, but the words inside it are ours and are; ";
export interface WordsVerdict {
  /** The failure line, or null when the words pass. */
  failure: string | null;
  /** How many questions the reply puts to the person about their reply or the same decision, as the judge counts them (a box
   * and a question in prose alike; the next step's own question is not one); null when the judge gave no count. */
  asked: number | null;
}
// What the agent told the person, judged by a model against MEANING and a short rubric: plain
// words, no engine terms, a question only where the item is ambiguous. What happened on disk stays a script in each
// check. The judge runs `claude -p` with no tools from an empty folder (`judgeDir`) and its own config dir under it, so
// no hook and no home is touched; its verdict is one JSON line.
export async function judgeText(input: JudgeInput, text: string, judgeDir: string): Promise<WordsVerdict> {
  if (text.trim().length === 0) return { failure: "the agent said nothing to the person before carrying on (no line about what it did)", asked: null };
  const rubric = [
    "You judge one reply an AI assistant gave to a person who typed a line in a software project tool.",
    `The person typed: ${JSON.stringify(input.typed)}`,
    `What the person meant: ${input.meaning}`,
    ...(input.says?.length ? [`The reply must also tell the person each of these, by meaning and not by exact words; one left out fails (a reply that stops at the one allowed question need only ask it):\n${input.says.map((s) => `- ${s}`).join("\n")}`] : []),
    input.asksAllowed > 0
      ? "A question back to the person is allowed once: the meaning leaves one choice to the person or the line is ambiguous. A reply that asks that one question plainly passes; so does a reply that acts consistently with the meaning without asking."
      : "A question back to the person is not allowed: the meaning is clear and the person asked for nothing to be confirmed.",
    "The reply passes when all three hold: (1) it says in plain words what was done, or what the person now needs to decide, consistent with what they meant; " +
      (input.engineWords ?? ENGINE_WORDS_RULE) +
      "(3) it asks a question only where allowed above; one question with several options is one question. Judge the assistant's words to the person, not its work log; a short confirmation of what happened is a pass.",
    'Answer with one line of JSON only, nothing else: {"ok": true or false, "asked": <how many questions the reply puts to the person about their reply or the same decision, 0 when none; one question with several options is one; a question that moves the work on to its next step is not one>, "reason": "<one sentence>"}',
    "The reply to judge follows.",
    text.slice(-4000),
  ].join("\n\n");
  const proc = Bun.spawn(
    ["claude", "-p", rubric, "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--permission-mode", "default",
      "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill", "AskUserQuestion"],
    // DISABLE_AUTOUPDATER: the judge is Claude Code as well, and a scratch config dir carries no autoUpdates setting,
    // so without this one judge run can update the install under the agents this check is measuring.
    { cwd: judgeDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CONFIG_DIR: join(judgeDir, "config"), DISABLE_AUTOUPDATER: "1" } },
  );
  const timer = setTimeout(() => proc.kill(), remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS));
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status !== 0) return { failure: `the judge could not run (exit ${status}): ${stderr.slice(0, 200)}`, asked: null };
    const result = String((JSON.parse(stdout) as { result?: string }).result ?? "");
    const verdict = /\{[^{}]*"ok"\s*:\s*(true|false)[^{}]*\}/.exec(result);
    if (!verdict) return { failure: `the judge gave no verdict: ${result.slice(0, 200)}`, asked: null };
    const parsed = JSON.parse(verdict[0]) as { ok: boolean; asked?: unknown; reason?: string };
    const asked = typeof parsed.asked === "number" && Number.isInteger(parsed.asked) && parsed.asked >= 0 ? parsed.asked : null;
    return { failure: parsed.ok ? null : `the agent's words: ${parsed.reason ?? "did not match what the person meant"}`, asked };
  } finally {
    clearTimeout(timer);
  }
}

// A miss is one or more of: the records are wrong or missing (what each check judges on disk, the typed line), a
// question the item did not allow, engine words in what the agent told the person.
export function missKinds(failures: string[]): { record: boolean; question: boolean; words: boolean } {
  const question = failures.some((f) => /question\(s\) to the person/.test(f));
  const words = failures.some((f) => /^the agent's words:|^the agent said nothing|^the judge /.test(f));
  const record = failures.some((f) => !/question\(s\) to the person|^the agent's words:|^the agent said nothing|^the judge /.test(f));
  return { record, question, words };
}

export interface LiveReport<T extends { id: string; meaning: string }> {
  dir: string;
  /** The report's title, e.g. "Live input corpus". */
  title: string;
  outcomes: LiveOutcome<T>[];
  /** What the score is grouped by ("category", "question") and the group of one outcome. */
  groupName: string;
  group: (o: LiveOutcome<T>) => string;
  /** What a record miss covers, named in the report's legend. */
  recordMeans: string;
  /** The bracketed label after an item's id in the misses section. */
  label: (o: LiveOutcome<T>) => string;
  sampleLine: string;
  /** True when a miss is reported only and does not fail the run (the nightly's run). */
  reportOnly?: boolean;
  /** The real homes hashed before the run. */
  homes: Map<string, HomeDigest>;
  drives: (home: string) => boolean;
}

/** One harness's run in brief, written beside its report as SUMMARY-<harness>-<sha>-<stamp>.json for the nightly report
 * (scripts/ci-preview-test-report.ts reads it). */
export interface LiveSummary {
  title: string;
  harness: LiveHarness;
  sha: string;
  stamp: string;
  sample: string;
  reportOnly: boolean;
  items: number;
  passed: number;
  misses: Record<MissKind, number>;
  missed: { id: string; group: string; kinds: MissKind[] }[];
}
/** The check's own misses ("setup:", "drive:" lines: the agent never showed the question, or the drive could not account
 * for a decision) apart from the agent's three kinds. */
type MissKind = "setup" | "record" | "question" | "words";
const checksOwn = (failure: string): boolean => /^(setup|drive): /.test(failure);
export function liveSummary<T extends { id: string; meaning: string }>(report: LiveReport<T>, harness: LiveHarness, sha: string, stamp: string): LiveSummary {
  const mine = report.outcomes.filter((o) => o.harness === harness);
  const missed = mine.filter((o) => o.failures.length > 0).map((o) => {
    const agents = o.failures.filter((f) => !checksOwn(f));
    const kinds = missKinds(agents);
    return {
      id: o.item.id, group: report.group(o),
      kinds: [...(agents.length < o.failures.length ? ["setup" as const] : []), ...(["record", "question", "words"] as const).filter((k) => kinds[k])],
    };
  });
  const count = (kind: MissKind) => missed.filter((m) => m.kinds.includes(kind)).length;
  return {
    title: report.title, harness, sha, stamp, sample: report.sampleLine, reportOnly: report.reportOnly === true, items: mine.length,
    passed: mine.length - missed.length, misses: { setup: count("setup"), record: count("record"), question: count("question"), words: count("words") }, missed,
  };
}

export function writeLiveReport<T extends { id: string; meaning: string }>(report: LiveReport<T>): LiveSummary[] {
  const { outcomes } = report;
  if (outcomes.length === 0) return [];
  const summaries: LiveSummary[] = [];
  mkdirSync(report.dir, { recursive: true });
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) }).stdout.trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const harness of [...new Set(outcomes.map((o) => o.harness))]) {
    const mine = outcomes.filter((o) => o.harness === harness);
    const lines = [`# ${report.title}: ${harness} at ${sha} (${stamp})`, "", `${report.sampleLine} Items driven: ${mine.length}.${report.reportOnly ? " Report-only: a miss does not fail the run." : ""}`,
      `Driven: ${harness} ${toolVersion(harness)}. The judge of the words: claude ${toolVersion("claude")}.`, "", `## Score per ${report.groupName}`, "", `Misses are counted three ways: record (${report.recordMeans}), question (one the item did not allow), words (engine words in what the agent told the person). One miss can count in several.`, "", `| ${report.groupName} | pass | total | record | question | words |`, "|---|---|---|---|---|---|"];
    for (const name of [...new Set(mine.map(report.group))]) {
      const rows = mine.filter((o) => report.group(o) === name);
      const kinds = rows.map((o) => missKinds(o.failures));
      lines.push(`| ${name} | ${rows.filter((o) => o.failures.length === 0).length} | ${rows.length} | ${kinds.filter((k) => k.record).length} | ${kinds.filter((k) => k.question).length} | ${kinds.filter((k) => k.words).length} |`);
    }
    const all = mine.filter((o) => o.failures.length > 0).map((o) => missKinds(o.failures));
    lines.push("", `Misses: ${all.length} of ${mine.length}; record ${all.filter((k) => k.record).length}, question ${all.filter((k) => k.question).length}, words ${all.filter((k) => k.words).length}; words only ${all.filter((k) => k.words && !k.record && !k.question).length}.`);
    lines.push("", "## Misses", "");
    for (const o of mine.filter((o) => o.failures.length > 0)) {
      lines.push(`### ${o.item.id} [${report.label(o)}] ${JSON.stringify(o.prompt)}`, "", `MEANING: ${o.item.meaning}`, "", ...o.failures.map((f) => `- ${f}`), "", `End state: ${o.endSummary}`, "", "Transcript excerpt:", "", "```", ...o.transcript.tools.slice(-8), "", o.transcript.text.slice(-600), "```", "");
    }
    for (const home of HOMES) {
      const was = report.homes.get(home);
      if (!was) continue;
      const now = homeDigest(home);
      const changed = [...now.files.entries()].filter(([p, v]) => was.files.get(p) !== v).map(([p]) => p);
      const how = report.drives(home) ? "CHANGED by this run" : "CHANGED by another process (this run did not drive that tool)";
      lines.push(`Home ${home}: ${was.digest === now.digest ? "unchanged" : `${how}: ${changed.slice(0, 20).join(", ")}`}`);
    }
    writeFileSync(join(report.dir, `REPORT-${harness}-${sha}-${stamp}.md`), `${lines.join("\n")}\n`, "utf-8");
    // Every transcript as judged, one JSON line per item, so the words can be re-read without driving the agents again.
    const rows = mine.map((o) => JSON.stringify({ id: o.item.id, prompt: o.prompt, failures: o.failures, end: o.endSummary, asks: o.transcript.asks, text: o.transcript.text, tools: o.transcript.tools }));
    writeFileSync(join(report.dir, `TRANSCRIPTS-${harness}-${sha}-${stamp}.jsonl`), `${rows.join("\n")}\n`, "utf-8");
    const summary = liveSummary(report, harness, sha, stamp);
    writeFileSync(join(report.dir, `SUMMARY-${harness}-${sha}-${stamp}.json`), `${JSON.stringify(summary)}\n`, "utf-8");
    summaries.push(summary);
  }
  return summaries;
}

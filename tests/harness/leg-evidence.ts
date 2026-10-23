// leg-evidence.ts - what a live leg keeps beyond its driver's own trace.
//
// A leg's fixture projects are gone before the runner could keep a passing
// one (tests remove them, and finishE2eTemporaryFiles removes the rest), and
// the SDK trace keeps none of the agent's words. So each driver calls in here
// at the end point it already owns (a drive, an exec, a turn, a session kill)
// while the project is still on disk. Everything lands under
// $AIDLC_TEST_LOG_DIR/leg-evidence/, which CI keeps and redacts like a driver
// trace (scripts/ci-sanitize-logs.ts) and the trace audit reads
// (scripts/trace-audit.ts). Best effort: a keep that fails writes one stderr
// line and never fails or changes the drive.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export interface LegEvidenceLimits {
  /** One text the agent wrote; a longer one keeps its start and end. */
  textBytes: number;
  /** One audit shard; a longer one keeps its start and end. */
  shardBytes: number;
  /** Everything one leg keeps here; past it nothing more is kept, and not-kept.txt says so once. */
  legBytes: number;
}

// Two weeks of nightlies (2026-10-21): an agent text is at most 2.6 KB, a leg's
// shards at most 53 KB and its words at most 15 KB.
export const LEG_EVIDENCE_LIMITS: LegEvidenceLimits = {
  textBytes: 8 * 1024,
  shardBytes: 256 * 1024,
  legBytes: 1024 * 1024,
};

export interface AgentWords {
  text: string;
  turn?: number;
  ts?: string;
}

function evidenceDir(): string | undefined {
  const logDir = process.env.AIDLC_TEST_LOG_DIR;
  return logDir ? join(logDir, "leg-evidence") : undefined;
}

function report(what: string, error: unknown): void {
  process.stderr.write(`leg-evidence: ${what} was not kept: ${error instanceof Error ? error.message : String(error)}\n`);
}

/** `text` within `maxBytes` of UTF-8: its start and end, the cut said between them, never a split character. */
export function cutMiddle(text: string, maxBytes: number): { text: string; bytes?: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text };
  const half = Math.max(0, Math.floor((maxBytes - 48) / 2));
  let head = half;
  while (head > 0 && (bytes[head] & 0xc0) === 0x80) head--;
  let tail = bytes.length - half;
  while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++;
  const note = `\n(leg-evidence cut ${tail - head} bytes here)\n`;
  return { text: `${bytes.subarray(0, head).toString("utf8")}${note}${bytes.subarray(tail).toString("utf8")}`, bytes: bytes.length };
}

function usedBytes(dir: string): number {
  let total = 0;
  const visit = (path: string): void => {
    for (const entry of existsSync(path) ? readdirSync(path, { withFileTypes: true }) : []) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) total += lstatSync(child).size;
    }
  };
  visit(dir);
  return total;
}

function ceilingReached(dir: string, limits: LegEvidenceLimits): void {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "not-kept.txt"),
      `${new Date().toISOString()} this leg's evidence reached ${limits.legBytes} bytes; later audit copies and words were not kept\n`,
      { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

const plainDir = (path: string): boolean => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() === true && !stat.isSymbolicLink();
};
const plainFile = (path: string): boolean => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() === true && !stat.isSymbolicLink();
};
const children = (dir: string): string[] => (plainDir(dir) ? readdirSync(dir).sort().map((name) => join(dir, name)) : []);

/** Every audit shard of the project: each space's and each intent's `audit/*.md`, and a flat `aidlc-docs/audit.md`. Links are not followed. */
function projectAuditShards(projectDir: string): string[] {
  const shards: string[] = [];
  const auditDir = (dir: string) => {
    for (const path of children(join(dir, "audit"))) if (path.endsWith(".md") && plainFile(path)) shards.push(path);
  };
  if (plainDir(join(projectDir, "aidlc"))) {
    for (const space of children(join(projectDir, "aidlc", "spaces")).filter(plainDir)) {
      auditDir(space);
      for (const intent of children(join(space, "intents")).filter(plainDir)) auditDir(intent);
    }
  }
  const flat = join(projectDir, "aidlc-docs", "audit.md");
  if (plainDir(join(projectDir, "aidlc-docs")) && plainFile(flat)) shards.push(flat);
  return shards;
}

/**
 * Copy every audit shard of `projectDir` to
 * `leg-evidence/audit/<project key>/<its path in the project>`. A later keep of
 * the same project overwrites the copies; an audit only grows, so the last copy
 * holds every row.
 */
export function keepLegAudit(projectDir: string, limits: LegEvidenceLimits = LEG_EVIDENCE_LIMITS): void {
  const dir = evidenceDir();
  if (!dir) return;
  try {
    const shards = projectAuditShards(projectDir);
    if (shards.length === 0) return;
    const key = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 12);
    let used = usedBytes(dir);
    for (const shard of shards) {
      const copy = cutMiddle(readFileSync(shard, "utf8"), limits.shardBytes).text;
      const destination = join(dir, "audit", key, relative(projectDir, shard));
      const before = plainFile(destination) ? lstatSync(destination).size : 0;
      const size = Buffer.byteLength(copy);
      if (used - before + size > limits.legBytes) {
        ceilingReached(dir, limits);
        return;
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, copy);
      used += size - before;
    }
  } catch (error) {
    report(`the audit of ${projectDir}`, error);
  }
}

function wordsLines(harness: string, words: AgentWords[], limits: LegEvidenceLimits): string[] {
  return words.filter((w) => w.text.trim() !== "").map((w) => {
    const { text, bytes } = cutMiddle(w.text, limits.textBytes);
    return `${JSON.stringify({ ts: w.ts ?? new Date().toISOString(), harness, ...(w.turn === undefined ? {} : { turn: w.turn }), text, ...(bytes === undefined ? {} : { bytes }) })}\n`;
  });
}

/** Append what the agent told the person to this process's `leg-evidence/words-<pid>.ndjson`. */
export function keepAgentWords(harness: string, words: AgentWords[], limits: LegEvidenceLimits = LEG_EVIDENCE_LIMITS): void {
  const dir = evidenceDir();
  if (!dir || words.length === 0) return;
  try {
    const text = wordsLines(harness, words, limits).join("");
    if (text === "") return;
    if (usedBytes(dir) + Buffer.byteLength(text) > limits.legBytes) {
      ceilingReached(dir, limits);
      return;
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `words-${process.pid}.ndjson`), text);
  } catch (error) {
    report(`the ${harness} agent's words`, error);
  }
}

const samePath = (a: string, b: string): boolean => {
  const canonical = (path: string) => {
    let full = resolve(path);
    try {
      full = realpathSync(full);
    } catch {
      // A folder already removed is compared as written.
    }
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return canonical(a) === canonical(b);
};

/** The lead's texts of one Claude Code transcript, by turn, when it ran in `cwd`; null for another folder. */
function transcriptWords(path: string, cwd: string): AgentWords[] | null {
  const words: AgentWords[] = [];
  let turn = 0;
  let folder: boolean | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry: { type?: unknown; cwd?: unknown; isSidechain?: unknown; isMeta?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (folder === undefined && typeof entry.cwd === "string") {
      folder = samePath(entry.cwd, cwd);
      if (!folder) return null;
    }
    if (entry.isSidechain === true || entry.isMeta === true) continue;
    const content = entry.message?.content;
    if (entry.type === "user") {
      const typed = typeof content === "string" ||
        (Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "text"));
      if (typed) turn++;
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (block.type === "text" && typeof block.text === "string") {
          words.push({ text: block.text, turn: Math.max(turn, 1), ...(typeof entry.timestamp === "string" ? { ts: entry.timestamp } : {}) });
        }
      }
    }
  }
  return folder ? words : null;
}

/**
 * A TUI session's words, from Claude Code's own transcripts of `cwd` in
 * `configDir` (CLAUDE_CONFIG_DIR, or ~/.claude): one words file per transcript,
 * replaced whole, so keeping it again at a later kill adds nothing twice.
 */
export function keepTranscriptWords(
  cwd: string,
  configDir: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  limits: LegEvidenceLimits = LEG_EVIDENCE_LIMITS,
): void {
  const dir = evidenceDir();
  if (!dir) return;
  try {
    for (const project of children(join(configDir, "projects")).filter(plainDir)) {
      for (const transcript of children(project).filter((path) => path.endsWith(".jsonl") && plainFile(path))) {
        const words = transcriptWords(transcript, cwd);
        if (!words?.length) continue;
        const text = wordsLines("claude-tui", words, limits).join("");
        const destination = join(dir, `words-tui-${basename(transcript, ".jsonl").replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson`);
        const before = plainFile(destination) ? lstatSync(destination).size : 0;
        if (usedBytes(dir) - before + Buffer.byteLength(text) > limits.legBytes) {
          ceilingReached(dir, limits);
          return;
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(destination, text);
      }
    }
  } catch (error) {
    report(`the TUI agent's words for ${cwd}`, error);
  }
}

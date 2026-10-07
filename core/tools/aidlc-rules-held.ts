// Whether the chat already holds a stage's exact rule text (#2023).
//
// Every `next` used to send the stage's whole rule bundle, so a long
// Construction run filled the chat with copies of the same memory files. The
// engine now sends a short `rules_held` pointer instead, but only where the
// chat provably holds that exact text, and the full text everywhere else. What
// counts as proof was measured live on each tool:
//
//   - Kiro CLI (agent `resources` glob) and opencode (`instructions` glob) put
//     the memory files in context on every request: an edit is seen at once and
//     survives a compaction. The proof is that the host's own include, as it
//     stood when the chat started, covers every file of the stage's bundle.
//   - Claude Code (the `.claude/rules/aidlc.md` @-import) loads them at startup,
//     resume, clear, compact and fork, but not after a mid-chat edit, and it can
//     clear old tool results with no hook. The proof is that the files still
//     have the hashes the session start recorded for this chat. A resume or a
//     fork may also carry older copies, so after an edit it proves nothing.
//   - Codex has no include and a compaction drops every tool result. The proof
//     is that this thread was handed the bundle, that no session start or
//     compaction hook ran since, and that its rollout shows no compaction after.
//   - Kiro IDE (steering file references are not expanded), Cursor and Copilot
//     have no proven copy, so they always get the text.
//
// The host is identified twice: by the installed tree that wrote the record and
// by the variable the host itself puts in the command's environment. Anything
// missing or unreadable means the full text.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isoTimestamp, isStopHookProbe, sessionsDir, toPosix, validSessionId, writeFileAtomic } from "./aidlc-lib.ts";
import { runtimeHarnessDir, runtimeHarnessName } from "./aidlc-runtime-paths.ts";

type LoadRecord = {
  v: 1;
  harness: string;
  source: string;
  at: string;
  space: string;
  // per-request: the host re-reads every file under `dir` on each request.
  // at-load: the host read `files` (sha256 by path) when this chat last loaded.
  refresh: "per-request" | "at-load" | "none";
  dir?: string;
  files?: Record<string, string>;
  // Older copies of the files may also be in the chat (a resume or fork after
  // an edit, or an include re-pointed while the chat started).
  stale?: true;
  // Codex: the thread's rollout file.
  transcript?: string;
};

type DeliveryRecord = { v: 1; bundle: string; at: string };

// A rollout read for the compaction check is bounded; a longer one counts as
// unreadable, which means the full text.
const ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

function loadRecordPath(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${sessionId}.rules-held.json`);
}

function deliveryRecordPath(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${sessionId}.rules-delivered.json`);
}

function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function memoryDirRel(space: string): string {
  return `aidlc/spaces/${space}/memory/`;
}

// The files the Claude @-import stub names, as project-relative paths. The stub
// lives at .claude/rules/aidlc.md and imports each memory file by a path
// relative to itself.
function claudeImportedFiles(projectDir: string, harnessDir: string): string[] {
  const stub = join(projectDir, harnessDir, "rules", "aidlc.md");
  let text: string;
  try {
    text = readFileSync(stub, "utf-8");
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^@(\S+\.md)\s*$/.exec(line.trim());
    if (!match) continue;
    const rel = toPosix(relative(projectDir, resolve(dirname(stub), match[1])));
    if (!rel.startsWith("..")) files.push(rel);
  }
  return files;
}

// Kiro CLI on its 2.0 agent engine: the conductor agent file is the one AI-DLC
// ships (hooks keyed by event; the 3.0 upgrade rewrites them as a list) and its
// resources glob carries the active space's whole memory tree.
function kiroIncludesMemory(projectDir: string, space: string): boolean {
  const agent = readJson<{ hooks?: unknown; resources?: unknown }>(join(projectDir, ".kiro", "agents", "aidlc.json"));
  if (agent === null || agent.hooks === null || typeof agent.hooks !== "object" || Array.isArray(agent.hooks)) {
    return false;
  }
  return Array.isArray(agent.resources) &&
    agent.resources.includes(`file://${memoryDirRel(space)}**/*.md`);
}

function opencodeIncludesMemory(projectDir: string, space: string): boolean {
  const config = readJson<{ instructions?: unknown }>(join(projectDir, "opencode.json"));
  return Array.isArray(config?.instructions) &&
    config.instructions.includes(`${memoryDirRel(space)}**/*.md`);
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A record that cannot be removed is overwritten or ignored later.
  }
}

/**
 * Record what the host loaded when this chat started, resumed, cleared,
 * compacted or forked (the session-start hook). Every session start also
 * forgets what the thread was handed, since the chat may no longer hold it.
 * `includeChanged` says the session start just re-pointed the include, so the
 * host may have loaded the old one.
 */
export function recordRulesLoad(
  projectDir: string,
  sessionId: string,
  source: string,
  space: string,
  transcriptPath: string,
  includeChanged: boolean,
): void {
  const sid = validSessionId(sessionId);
  if (sid === null) return;
  removeQuietly(deliveryRecordPath(projectDir, sid));
  const path = loadRecordPath(projectDir, sid);
  const harness = runtimeHarnessName(projectDir);
  const base = { v: 1 as const, harness, source, at: isoTimestamp(), space };
  let record: LoadRecord | null = null;
  if (harness === "claude") {
    const files: Record<string, string> = {};
    for (const rel of claudeImportedFiles(projectDir, runtimeHarnessDir(projectDir))) {
      files[rel] = sha256File(join(projectDir, rel));
    }
    const previous = readJson<LoadRecord>(path);
    const sameAsBefore = previous !== null && previous.stale !== true && previous.files !== undefined &&
      JSON.stringify(previous.files) === JSON.stringify(files);
    const stale = includeChanged || source === "fork" ||
      (source === "resume" && !sameAsBefore) ||
      !["startup", "clear", "compact", "resume"].includes(source);
    record = { ...base, refresh: "at-load", files, ...(stale ? { stale: true as const } : {}) };
  } else if (harness === "kiro" || harness === "opencode") {
    const covered = !includeChanged && (harness === "kiro"
      ? kiroIncludesMemory(projectDir, space)
      : opencodeIncludesMemory(projectDir, space));
    record = covered ? { ...base, refresh: "per-request", dir: memoryDirRel(space) } : null;
  } else if (harness === "codex") {
    record = { ...base, refresh: "none", ...(transcriptPath ? { transcript: transcriptPath } : {}) };
  }
  if (record === null) {
    removeQuietly(path);
    return;
  }
  try {
    writeFileAtomic(path, `${JSON.stringify(record)}\n`);
  } catch {
    removeQuietly(path);
  }
}

/** A compaction (PreCompact) forgets what the thread was handed. */
export function clearRulesDelivered(projectDir: string, sessionId: string): void {
  const sid = validSessionId(sessionId);
  if (sid !== null) removeQuietly(deliveryRecordPath(projectDir, sid));
}

// The host's own variable says this command runs inside that host's chat. The
// Stop hook's own consultation runs in a hook, which some hosts start without
// it (Codex); there the hook payload names the chat, so the consultation
// answers exactly what the agent's own `next` answered.
function hostRunsThisChat(harness: string, sessionId: string): boolean {
  const env = process.env;
  if (
    isStopHookProbe() && env.AIDLC_SESSION_OVERRIDE_SOURCE === "payload" &&
    env.AIDLC_SESSION_OVERRIDE === sessionId
  ) {
    return ["claude", "kiro", "opencode", "codex"].includes(harness);
  }
  switch (harness) {
    case "claude":
      return env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID === sessionId : env.CLAUDECODE === "1";
    case "kiro":
      return env.KIRO_SESSION_ID === sessionId;
    case "opencode":
      return env.OPENCODE === "1";
    case "codex":
      return env.CODEX_THREAD_ID === sessionId;
    default:
      return false;
  }
}

/**
 * Remember that this Codex thread was just handed the bundle's full text. Only
 * Codex needs it: the other tools' proof is their own include.
 */
export function noteRulesDelivered(projectDir: string, sessionId: string | undefined, bundle: string): void {
  const sid = validSessionId(sessionId);
  if (sid === null) return;
  if (runtimeHarnessName(projectDir) !== "codex" || !hostRunsThisChat("codex", sid)) return;
  const record = readJson<LoadRecord>(loadRecordPath(projectDir, sid));
  if (record?.harness !== "codex") return;
  try {
    // Milliseconds, so a compaction in the same second as the delivery is never read as before it.
    writeFileAtomic(deliveryRecordPath(projectDir, sid), `${JSON.stringify({ v: 1, bundle, at: new Date().toISOString() })}\n`);
  } catch {
    removeQuietly(deliveryRecordPath(projectDir, sid));
  }
}

// The last compaction the rollout records, as a time, or null when it records
// none. Undefined when the rollout cannot be read.
function lastRolloutCompaction(transcript: string): number | null | undefined {
  try {
    if (statSync(transcript).size > ROLLOUT_MAX_BYTES) return undefined;
    let last: number | null = null;
    for (const line of readFileSync(transcript, "utf-8").split("\n")) {
      if (!line.includes('"compacted"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown };
        if (entry.type !== "compacted") continue;
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        // A compaction with no readable time could be after anything.
        if (!Number.isFinite(at)) return undefined;
        last = last === null ? at : Math.max(last, at);
      } catch {
        // A line still being written is read on the next call.
      }
    }
    return last;
  } catch {
    return undefined;
  }
}

/**
 * True only when the chat this command runs in provably holds the exact text
 * of `paths` (the stage's bundle, `bundle` its digest) right now.
 */
export function chatHoldsRules(
  projectDir: string,
  sessionId: string | undefined,
  space: string,
  paths: string[],
  bundle: string,
): boolean {
  try {
    const sid = validSessionId(sessionId);
    if (sid === null || paths.length === 0) return false;
    const harness = runtimeHarnessName(projectDir);
    if (!hostRunsThisChat(harness, sid)) return false;
    const record = readJson<LoadRecord>(loadRecordPath(projectDir, sid));
    if (record?.v !== 1 || record.harness !== harness || record.space !== space) return false;
    if (record.refresh === "per-request") {
      const dir = record.dir ?? "";
      return dir !== "" && paths.every((path) => path.startsWith(dir) && path.endsWith(".md"));
    }
    if (record.refresh === "at-load") {
      const files = record.files ?? {};
      if (record.stale === true || !paths.every((path) => path in files)) return false;
      return Object.entries(files).every(([rel, hash]) => sha256File(join(projectDir, rel)) === hash);
    }
    if (harness === "codex") {
      const delivered = readJson<DeliveryRecord>(deliveryRecordPath(projectDir, sid));
      if (delivered?.v !== 1 || delivered.bundle !== bundle || !record.transcript) return false;
      if (!existsSync(record.transcript)) return false;
      const compacted = lastRolloutCompaction(record.transcript);
      const deliveredAt = Date.parse(delivered.at);
      return compacted !== undefined && Number.isFinite(deliveredAt) &&
        (compacted === null || compacted < deliveredAt);
    }
    return false;
  } catch {
    return false;
  }
}

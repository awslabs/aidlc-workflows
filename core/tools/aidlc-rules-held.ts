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
//   - Kiro IDE (and Kiro CLI v3, which runs the same tree) puts the
//     always-included steering file in a chat once, when the chat starts and
//     before its SessionStart hook runs, and keeps that copy through summaries
//     and reloads; a mid-chat edit is never read (live on 1.2.4). AI-DLC writes
//     the memory text into that file (aidlc-includes.ts). The proof is that the
//     chat's session start found the file as the memory files make it now and
//     did not rewrite it, and that the file is still exactly that. Kiro IDE
//     gives the agent's shell no chat id, so which chat ran a command is known
//     only from the process tree, where the latest chat to start wins. So the
//     pointer also needs every chat with an open turn (a prompt with no Stop
//     since) to hold the same file; Kiro CLI v3 names the chat in
//     KIRO_SESSION_ID instead.
//   - Cursor and Copilot have no proven copy, so they always get the text.
//
// The host is identified twice: by the installed tree that wrote the record and
// by the variable the host itself puts in the command's environment. Anything
// missing or unreadable means the full text.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isoTimestamp, isStopHookProbe, sessionsDir, toPosix, validSessionId, writeFileAtomic } from "./aidlc-lib.ts";
import { runtimeHarnessDir, runtimeHarnessName } from "./aidlc-runtime-paths.ts";
import { KIRO_IDE_STEERING, kiroIdeSteering } from "./aidlc-includes.ts";

type LoadRecord = {
  v: 1;
  harness: string;
  source: string;
  at: string;
  space: string;
  // per-request: the host re-reads every file under `dir` on each request.
  // at-load: the host read `files` (sha256 by path) when this chat last loaded.
  // at-start: the chat holds the steering file it captured when it started
  // (`steering`, its sha256), whatever happens later.
  refresh: "per-request" | "at-load" | "at-start" | "none";
  dir?: string;
  files?: Record<string, string>;
  steering?: string;
  // Older copies of the files may also be in the chat (a resume or fork after
  // an edit, or an include re-pointed while the chat started).
  stale?: true;
  // Codex: the thread's rollout file.
  transcript?: string;
};

/** The sentence a pointer step carries beside `rules_held`. */
export const RULES_HELD_NOTE =
  "This step's rules are the AI-DLC memory text already in your context; apply them to every file you write in this step.";

// What this chat's steps were handed. `last` is the bundle the last step named
// (in full or by pointer): a step whose bundle differs gets the full text once,
// even where the host holds the new files, so the change is in front of the
// agent (live on Kiro CLI, an agent that held the edited file still repeated
// what it did under the old rule). `full` is the last full-text delivery, the
// only proof Codex has; a session start or a compaction forgets it.
type DeliveryRecord = { v: 2; last: string; full?: { bundle: string; at: string } };

function readDelivery(projectDir: string, sid: string): DeliveryRecord | null {
  const record = readJson<DeliveryRecord>(deliveryRecordPath(projectDir, sid));
  return record?.v === 2 && typeof record.last === "string" ? record : null;
}

function writeDelivery(projectDir: string, sid: string, record: DeliveryRecord): void {
  try {
    writeFileAtomic(deliveryRecordPath(projectDir, sid), `${JSON.stringify(record)}\n`);
  } catch {
    removeQuietly(deliveryRecordPath(projectDir, sid));
  }
}

// The chat may no longer hold what it was handed in full; what its last step
// named is kept.
function forgetFullDelivery(projectDir: string, sid: string): void {
  const record = readDelivery(projectDir, sid);
  if (record === null) {
    removeQuietly(deliveryRecordPath(projectDir, sid));
  } else if (record.full !== undefined) {
    writeDelivery(projectDir, sid, { v: 2, last: record.last });
  }
}

// A rollout read for the compaction check is bounded; a longer one counts as
// unreadable, which means the full text.
const ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

function loadRecordPath(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${sessionId}.rules-held.json`);
}

function deliveryRecordPath(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${sessionId}.rules-delivered.json`);
}

// A turn whose Stop never came (Kiro sends none after Cancel) stops counting
// as open after this long.
const OPEN_TURN_MAX_MS = 4 * 60 * 60 * 1000;

function turnOpenPath(projectDir: string, sessionId: string): string {
  return join(sessionsDir(projectDir), `${sessionId}.turn-open`);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
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
 * forgets the full text the thread was handed, since the chat may no longer
 * hold it.
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
  forgetFullDelivery(projectDir, sid);
  const path = loadRecordPath(projectDir, sid);
  const harness = runtimeHarnessName(projectDir);
  const base = { v: 1 as const, harness, source, at: isoTimestamp(), space };
  let record: LoadRecord | null = null;
  if (harness === "kiro-ide") {
    // A chat keeps what it captured when it started: a later session start
    // for it (a switch back, a resume) records nothing new.
    if (existsSync(path) || source !== "startup") return;
    const { text, inlined } = kiroIdeSteering(projectDir, space);
    const steering = sha256File(join(projectDir, KIRO_IDE_STEERING));
    // This start rewrote the file, or it does not carry the memory text: the
    // chat holds an older copy, or none.
    const current = !includeChanged && inlined.length > 0 && steering === sha256Text(text);
    record = { ...base, refresh: "at-start", steering, ...(current ? {} : { stale: true as const }) };
  } else if (harness === "claude") {
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

/** A compaction (PreCompact) forgets the full text the thread was handed. */
export function clearRulesDelivered(projectDir: string, sessionId: string): void {
  const sid = validSessionId(sessionId);
  if (sid !== null) forgetFullDelivery(projectDir, sid);
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
    case "kiro-ide":
      // Kiro CLI v3 names the chat; Kiro IDE's shell has no chat id, so
      // chatHoldsRules checks every open turn instead.
      return env.KIRO_SESSION_ID ? env.KIRO_SESSION_ID === sessionId : true;
    case "opencode":
      return env.OPENCODE === "1";
    case "codex":
      return env.CODEX_THREAD_ID === sessionId;
    default:
      return false;
  }
}

/**
 * Kiro IDE: a prompt opens its chat's turn, and the turn's Stop closes it.
 */
export function noteKiroIdeTurn(projectDir: string, sessionId: string | undefined, open: boolean): void {
  const sid = validSessionId(sessionId);
  if (sid === null) return;
  if (!open) {
    removeQuietly(turnOpenPath(projectDir, sid));
    return;
  }
  try {
    writeFileAtomic(turnOpenPath(projectDir, sid), `${new Date().toISOString()}\n`);
  } catch {
    // With no open turn on record, this chat gets the rules in full.
  }
}

// Kiro IDE: whether this chat has an open turn and every other chat with an
// open turn holds `steering` too, so whichever of them ran the command holds
// it.
function openTurnsHold(projectDir: string, sid: string, space: string, steering: string): boolean {
  const now = Date.now();
  let own = false;
  for (const name of readdirSync(sessionsDir(projectDir))) {
    if (!name.endsWith(".turn-open")) continue;
    const other = name.slice(0, -".turn-open".length);
    let at = NaN;
    try {
      at = Date.parse(readFileSync(join(sessionsDir(projectDir), name), "utf-8").trim());
    } catch {
      // A marker that cannot be read is skipped like an old one.
    }
    if (!Number.isFinite(at) || now - at > OPEN_TURN_MAX_MS) continue;
    if (other === sid) {
      own = true;
      continue;
    }
    const record = readJson<LoadRecord>(loadRecordPath(projectDir, other));
    if (
      record?.v !== 1 || record.harness !== "kiro-ide" || record.refresh !== "at-start" ||
      record.stale === true || record.space !== space || record.steering !== steering
    ) {
      return false;
    }
  }
  return own;
}

/**
 * Remember what a run-stage just handed this chat: the bundle it named, and
 * whether it carried the full text (`held` false).
 */
export function noteRulesDelivered(
  projectDir: string,
  sessionId: string | undefined,
  bundle: string,
  held: boolean,
): void {
  const sid = validSessionId(sessionId);
  if (sid === null) return;
  const harness = runtimeHarnessName(projectDir);
  if (!hostRunsThisChat(harness, sid)) return;
  const previous = readDelivery(projectDir, sid);
  // Milliseconds, so a compaction in the same second as the delivery is never read as before it.
  const full = held ? previous?.full : { bundle, at: new Date().toISOString() };
  writeDelivery(projectDir, sid, { v: 2, last: bundle, ...(full ? { full } : {}) });
}

type RuleEntry = { path: string; text: string };

function isRuleEntries(value: unknown): value is RuleEntry[] {
  return Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" &&
    typeof (entry as RuleEntry).path === "string" && typeof (entry as RuleEntry).text === "string"
  );
}

// The digest the engine gives a bundle: rule pieces of one file, in order, are
// joined back into that file's text (the parts cut it at section and size
// boundaries without losing a character).
function bundleDigest(entries: RuleEntry[]): string {
  const files: RuleEntry[] = [];
  for (const entry of entries) {
    const last = files[files.length - 1];
    if (last !== undefined && last.path === entry.path) last.text += entry.text;
    else files.push({ path: entry.path, text: entry.text });
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(files), "utf-8").digest("hex")}`;
}

// Whether the thread's rollout shows it holding `bundle` whole: since the last
// compaction, rule text it was handed (an inline run-stage, or load-steering
// parts and their run-stage) rebuilds exactly to `bundle`. Codex trims a
// command's output to the token budget the model asked for by cutting out the
// middle (live: a 20 KB rules part kept 8 KB and still parsed), so the text
// itself is checked; a step cut short rebuilds to another digest and proves
// nothing. Also returns the last compaction's time (null for none). Undefined
// when the rollout cannot be read.
function rolloutHolds(transcript: string, bundle: string): { holds: boolean; compacted: number | null } | undefined {
  try {
    if (statSync(transcript).size > ROLLOUT_MAX_BYTES) return undefined;
    let compacted: number | null = null;
    let holds = false;
    let parts: { bundle: string; next: number; of: number; entries: RuleEntry[] } | null = null;
    for (const line of readFileSync(transcript, "utf-8").split("\n")) {
      const compaction = line.includes('"compacted"');
      const output = line.includes('"function_call_output"') && line.includes('{\\"kind\\":\\"');
      if (!compaction && !output) continue;
      let entry: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; output?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        // A line still being written is read on the next call.
        continue;
      }
      if (entry.type === "compacted") {
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        // A compaction with no readable time could be after anything.
        if (!Number.isFinite(at)) return undefined;
        compacted = compacted === null ? at : Math.max(compacted, at);
        holds = false;
        parts = null;
        continue;
      }
      if (entry.type !== "response_item" || entry.payload?.type !== "function_call_output") continue;
      const text = typeof entry.payload.output === "string" ? entry.payload.output : "";
      const at = text.search(/\{"kind":"(run-stage|load-steering)"/);
      if (at < 0) continue;
      let step: { kind?: unknown; bundle?: unknown; part?: unknown; parts?: unknown; rules_content?: unknown };
      try {
        step = JSON.parse(text.slice(at).trim());
      } catch {
        // Cut short at an end: it proves nothing.
        continue;
      }
      const rules = step.rules_content;
      if (rules !== undefined && !isRuleEntries(rules)) continue;
      if (step.kind === "load-steering") {
        if (step.part === 1 && typeof step.bundle === "string" && typeof step.parts === "number") {
          parts = { bundle: step.bundle, next: 2, of: step.parts, entries: [...(rules ?? [])] };
        } else if (parts !== null && step.bundle === parts.bundle && step.part === parts.next) {
          parts.entries.push(...(rules ?? []));
          parts.next += 1;
        } else {
          parts = null;
        }
        continue;
      }
      // A run-stage: the text it carries, or the parts that came before it.
      if (rules !== undefined && rules.length > 0) {
        if (bundleDigest(rules) === bundle) holds = true;
      } else if (parts !== null && parts.next === parts.of + 1 && bundleDigest(parts.entries) === bundle) {
        holds = true;
      }
      parts = null;
    }
    return { holds, compacted };
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
    const delivered = readDelivery(projectDir, sid);
    // The chat's first step, or the rules changed since its last step: the
    // text once, so the rules are in front of the agent (live on Kiro IDE, an
    // agent in a new chat once ignored a team rule its steering held).
    if (delivered === null || delivered.last !== bundle) return false;
    if (record.refresh === "at-start") {
      if (record.stale === true || !record.steering) return false;
      const { text, inlined } = kiroIdeSteering(projectDir, space);
      const steering = sha256Text(text);
      if (record.steering !== steering || !paths.every((path) => inlined.includes(path))) return false;
      if (sha256File(join(projectDir, KIRO_IDE_STEERING)) !== steering) return false;
      return process.env.KIRO_SESSION_ID ? true : openTurnsHold(projectDir, sid, space, steering);
    }
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
      const full = delivered?.full;
      if (full === undefined || full.bundle !== bundle || !record.transcript) return false;
      if (!existsSync(record.transcript)) return false;
      const since = rolloutHolds(record.transcript, bundle);
      const deliveredAt = Date.parse(full.at);
      return since?.holds === true && Number.isFinite(deliveredAt) &&
        (since.compacted === null || since.compacted < deliveredAt);
    }
    return false;
  } catch {
    return false;
  }
}

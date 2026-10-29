// The audit and state core: where a piece of work's record lives (the record
// folder, the intent registry, the active intent, which work and which chat a
// command is for, the session bindings and the process ancestry behind them),
// the audit's shards, clone identity, rows and their order, and the state file
// with its fields, checkboxes, digest and write log. With them ride the helpers
// they use: the bolt and worktree names, the Unit scope stamp and isoTimestamp.
// aidlc-lib.ts re-exports the names it exported before, so its callers are
// unchanged, and it loads this module at start: nothing here may import
// aidlc-lib.ts.
import { scopeStampLanded } from "./aidlc-unit-landing.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { runtimeHarnessDir, SPACE_NAME_REGEX } from "./aidlc-runtime-paths.ts";
import { validateUnitName } from "./aidlc-review-records.ts";
import { activeSpace, assertNoSymlinkInChainOrThrow, engineDirFor, intentsDir, isPlainObject, listIntentDirs, readAppendOnlyFileNoFollowOrThrow, readRegularFileNoFollowOrThrow, refuseEngineObserverWrite, spaceRecordRoot, workspaceRoot, writeFileAtomic } from "./aidlc-locks.ts";
import { escapeRegex } from "./aidlc-markdown.ts";
import { jsoncDocumentValue, withoutBom } from "./aidlc-distribution.ts";

export type CheckboxState = "pending" | "in-progress" | "awaiting-approval" | "revising" | "completed" | "skipped";

export const CHECKBOX_MAP: Record<CheckboxState, string> = {
  pending: "[ ]",
  "in-progress": "[-]",
  "awaiting-approval": "[?]",
  revising: "[R]",
  completed: "[x]",
  skipped: "[S]",
};
export const ACTIVE_INTENT_POINTER = "active-intent";

export function canonicalPathKey(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// The record the per-user `active-intent` cursor names, when it names a real
// record — never the lone-record fallback. The cursor is gitignored and written
// only by intent create and switch on this machine, so unlike a lone committed
// record it is local evidence of a choice.
export function readActiveIntentCursor(projectDir: string, space?: string): string | null {
  const dir = intentsDir(projectDir, space ?? activeSpace(projectDir));
  try {
    const raw = readFileSync(join(dir, ACTIVE_INTENT_POINTER), "utf-8").trim();
    if (raw.length > 0 && existsSync(join(dir, raw, "aidlc-state.md"))) return raw;
  } catch {
    // no cursor
  }
  return null;
}

// The active intent's RECORD directory NAME (`<slug>-<id8>`) for a space, or
// null when no record resolves (→ the path helpers resolve the bare space record
// root). Precedence: explicit > active-intent cursor (if it names a real record)
// > lone intent. Returns null rather than throwing on ambiguity so the path
// helpers stay total; the verb/handler layer (P4) owns the error/prompt for the
// >1-intent-no-cursor case.
export function activeIntent(
  projectDir: string,
  space?: string,
  explicit?: string,
): string | null {
  const sp = space ?? activeSpace(projectDir);
  if (explicit) return explicit;
  // Cursor: a real record the pointer names.
  const cursor = readActiveIntentCursor(projectDir, sp);
  if (cursor !== null) return cursor;
  // Archived records never resolve implicitly: a space whose only record was
  // archived reads as "no active intent" (creation is correct), not as that
  // retired record silently coming back. An explicit cursor naming an archived
  // record still resolves above, so the engine can explain it instead of
  // guessing. The registry is read ONCE and matched in memory: this is the
  // hot path of intent resolution, and an unregistered (orphan) record has no
  // status, so it stays live work.
  const registry = readIntentRegistry(projectDir, sp);
  const records = listIntentDirs(projectDir, sp).filter((dirName) => {
    const row = registry.find((entry) => recordDirMatches(entry, dirName));
    return row === undefined || !isArchivedIntent(row);
  });
  if (records.length === 1) return records[0];
  // 0 records → null (bare space root); >1 with no cursor → null (the handler
  // layer prompts; a path helper cannot guess which intent the caller meant).
  return null;
}

// The absolute RECORD directory for an intent:
// `aidlc/spaces/<space>/intents/<slug>-<id8>/`. Returns null when no intent
// resolves, signalling the bare-space-root resolution in the path helpers.
export function resolveRecordDir(
  projectDir: string,
  intent?: string,
  space?: string,
  bind?: boolean,
): { dir: string | null; space: string } {
  const selection = resolveWorkflowSelection(projectDir, { space, intent, ...(bind === undefined ? {} : { bind }) });
  return {
    dir:
      selection.intent === null
        ? null
        : join(intentsDir(projectDir, selection.space), selection.intent),
    space: selection.space,
  };
}

// Relative record-dir prefix for the engine's agent-consumed artifact/diary
// paths: `aidlc/spaces/<space>/intents/<slug>-<id8>` with forward slashes
// regardless of host OS (portable across worktrees). Returns null → the engine
// resolvers resolve the bare space-relative record prefix
// (relativeSpaceRecordPrefix). The space + intent come from the active cursors
// unless passed explicitly; the engine threads the active intent's record-dir
// name in (it knows projectDir but the resolvers themselves take no projectDir —
// see aidlc-orchestrate.ts).
export function relativeRecordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  const selection = resolveWorkflowSelection(projectDir, { space, intent });
  const sp = selection.space;
  const slug = selection.intent;
  if (slug === null) return null;
  return `aidlc/spaces/${sp}/intents/${slug}`;
}

// The repository NAME for a checkout whose project root is a LINKED GIT
// WORKTREE, else null so the caller keeps `basename(projectDir)`.
//
// `git worktree add` names its directory after a branch, so in a linked worktree
// basename(projectDir) is a branch name rather than a repository name. The shared
// git dir lives inside the MAIN checkout, so its parent's basename is the
// repository name.
//
// TWO things make this safe, and both are load-bearing:
//
//  1. `--git-dir` and `--git-common-dir` are measured with `cwd: projectDir`, so a
//     relative answer is relative to PROJECTDIR — never to `--show-toplevel`. The
//     two coincide only when the project root IS the toplevel; resolving against
//     the toplevel otherwise climbs too high, and if a git dir happens to sit
//     there (a repository vendored in another, or a home directory that is itself
//     a repository) it would silently return a DIFFERENT repository's name.
//  2. A linked worktree is the only topology where those two paths differ
//     (`--git-dir` is `<common>/worktrees/<name>`). Equal for a main checkout, for
//     a subdirectory of one, and for a repository nested inside another — all of
//     which return null here and keep today's answer byte-for-byte. That is what
//     makes this change worktree-only rather than a re-definition of identity for
//     every project root below its repository root.
//
// Deliberately NOT the `origin` remote: that would also cover a clone whose
// directory name differs from the repository, but remote names are mutable (a
// rename or a re-point would move a workspace's store) and it would change
// resolution for every checkout whose remote and directory names differ. A
// location is stable; widening identity to the remote is a separate decision.
export function gitRevParseSingle(projectDir: string, flag: string): string | null {
  const r = spawnSync("git", ["rev-parse", flag], {
    cwd: projectDir,
    encoding: "utf-8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout?.trim();
  return out ? out : null;
}

// The id8 disambiguator: trailing 8 hex chars of the uuid (digits only, dashes
// stripped). Used in the `<slug>-<id8>` dir name.
export function idSuffix(uuid: string, length = 8): string {
  const hex = uuid.replace(/-/g, "");
  return hex.slice(-length);
}
//
// SPIKE (date-prefix). The record dir name leads with a compact UTC date so the
// records sort CHRONOLOGICALLY in any file browser / `ls` (the time token is a
// PREFIX, where lexicographic sort = creation order — a suffix would sort by the
// label). The label is a SHORT human slug (cap 24, vs the old 48) — the
// orchestrator is expected to pass a 2-3 word essence ("simple calc"), not the
// full request sentence. Uniqueness within the space is the caller's collision
// loop (a -N counter), NOT this name: the canonical, collision-proof id stays the
// UUIDv7 in the registry row, and the row now stores this dirName verbatim (so the
// readers never reconstruct it from slug+uuid).

// The human-readable LABEL for a record dir name, for display/orphan rows when
// no registry row supplies a slug. SPIKE (date-prefix): strip a leading `YYMMDD-`
// date prefix; else strip a legacy trailing `-<hex>` id8. Falls back to the whole
// name if neither shape matches.
export function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName);
  if (dated) return dated[1];
  return dirName.replace(/-[0-9a-f]+$/, "");
}

// Append an intent to the space's intents.json registry (creating it if absent).
// MUST be called under the WORKSPACE lock bucket (invariant 2) — the registry is
// shared workspace-level truth. Each row: {uuid, slug, scope, repos, status}.
export interface IntentRegistryEntry {
  uuid: string;
  slug: string;
  // The on-disk record dir name. SPIKE (date-prefix): stored verbatim at creation so
  // readers join a row to its dir DIRECTLY, never reconstructing it from slug+uuid
  // (the date-prefixed name `<YYMMDD>-<label>` is not derivable from {slug,uuid}).
  // Optional for back-compat: pre-spike rows (and hand-written fixtures) omit it,
  // and recordDirMatches() falls back to the legacy `<slug>-<id8>` hex match.
  dirName?: string;
  scope?: string;
  repos?: string[];
  // The person named this repo set (`--repos` at creation, or `intent
  // set-repos`); absent for a set found on disk. Read by intentReposNamed.
  repos_named?: true;
  status: string;
  // The engine question whose answer started this intent, so a repeated
  // answer finds the work it already started instead of creating it twice.
  request?: string;
}

// Does record dir `dirName` belong to registry row `entry`? The single shared
// join rule for every row→dir matcher (listIntents/updateIntentStatus/intentRepos).
// SPIKE (date-prefix): prefer the stored `entry.dirName` (exact match); fall back
// to the legacy `<slug>-<id8>` shape (slug prefix + trailing hex that is a prefix
// of the uuid's id-suffix) so pre-spike rows and fixtures still resolve.
export function recordDirMatches(entry: IntentRegistryEntry, dirName: string): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  return /^[0-9a-f]+$/.test(suffix) && idSuffix(entry.uuid, suffix.length) === suffix;
}

// The intent status lifecycle is a registry-row field. Creation writes
// `in-flight`; workflow completion flips it to `complete`; `intent archive`
// flips an in-flight or complete row to `archived` and `intent unarchive`
// restores the one it had. `archived` is the only status a human moves a row
// INTO and back OUT of, so it gets a named constant and predicate; the other
// two stay the literals the creation and completion paths already write.
export const ARCHIVED_INTENT_STATUS = "archived";

export function isArchivedIntent(entry: { status: string }): boolean {
  return entry.status.trim().toLowerCase() === ARCHIVED_INTENT_STATUS;
}

export function intentsRegistryPath(projectDir: string, space?: string): string {
  return join(intentsDir(projectDir, space), "intents.json");
}

// Git's conflict markers. No line of JSON starts with one, so in intents.json
// they split the text into its two sides exactly.
export const CONFLICT_START = /^<{7}/m;

// One side of a file git left conflicted: the lines outside every conflict plus
// that side's own lines (a diff3 or zdiff3 base section belongs to neither).
export function conflictSide(text: string, side: "ours" | "theirs"): string {
  const kept: string[] = [];
  let zone: "both" | "ours" | "base" | "theirs" = "both";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("<<<<<<<")) zone = "ours";
    else if (zone !== "both" && line.startsWith("|||||||")) zone = "base";
    else if (zone !== "both" && line.startsWith("=======")) zone = "theirs";
    else if (zone !== "both" && line.startsWith(">>>>>>>")) zone = "both";
    else if (zone === "both" || zone === side) kept.push(line);
  }
  return kept.join("\n");
}

// The list as the person's editor may leave it: a trailing comma, a comment or
// a BOM does not hide its rows. Anything else after the list makes it unreadable,
// never read as its first part.
export function registryList(text: string): IntentRegistryEntry[] | null {
  const parsed = jsoncDocumentValue(withoutBom(text));
  return Array.isArray(parsed) ? (parsed as IntentRegistryEntry[]) : null;
}

// The `aidlc/spaces` root — the parent of every space dir. Sole helper so the
// "what spaces exist?" scan and the intent-record scan agree on one location.
export function spacesRoot(projectDir: string): string {
  return join(workspaceRoot(projectDir), "spaces");
}

// Read a space's intents.json registry as a typed list. Returns [] when the
// file is absent or nothing can read it. A file git left conflicted (two clones
// started work in one space) reads as every row of both sides, once per uuid. The
// canonical "what intents exist" record for humans/ordering/status — the cheap
// on-disk listIntentDirs() scan is the path-resolver's record-presence signal,
// but the registry carries the uuid/status/scope/repos a human or the --json
// consumer needs.
export function readIntentRegistry(projectDir: string, space?: string): IntentRegistryEntry[] {
  let text: string;
  try {
    text = readFileSync(intentsRegistryPath(projectDir, space), "utf-8");
  } catch {
    return [];
  }
  const whole = registryList(text);
  if (whole !== null) return whole;
  if (!CONFLICT_START.test(text)) return [];
  // ponytail: a row both sides changed keeps the first side's copy (every row
  // is still kept); a side that is not JSON (a hand edit) adds nothing.
  const rows: IntentRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const side of ["ours", "theirs"] as const) {
    for (const entry of registryList(conflictSide(text, side)) ?? []) {
      const key = typeof entry?.uuid === "string" ? entry.uuid : JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(entry);
    }
  }
  return rows;
}

export interface IntentInfo {
  uuid: string;
  slug: string;
  status: string;
  scope?: string;
  repos?: string[];
  dirName: string | null; // the on-disk <slug>-<id8> record dir, or null if registry-only
  active: boolean;
}

export function listIntents(
  projectDir: string,
  space?: string,
  activeIntentOverride?: string | null,
): IntentInfo[] {
  const sp = space ?? activeSpace(projectDir);
  const registry = readIntentRegistry(projectDir, sp);
  const dirs = listIntentDirs(projectDir, sp);
  // activeIntent() returns the record DIR NAME of the active intent (or null).
  const activeDir =
    activeIntentOverride === undefined
      ? activeIntent(projectDir, sp)
      : activeIntentOverride;
  const claimedDirs = new Set<string>();
  const infos: IntentInfo[] = registry.map((entry) => {
    // Match the row to its record dir via the shared join rule (stored dirName,
    // else the legacy `<slug>-<id8>` shape).
    const dirName = dirs.find((d) => recordDirMatches(entry, d)) ?? null;
    if (dirName) claimedDirs.add(dirName);
    return {
      uuid: entry.uuid,
      slug: entry.slug,
      status: entry.status,
      scope: entry.scope,
      repos: entry.repos,
      dirName,
      active: dirName !== null && dirName === activeDir,
    };
  });
  // On-disk records with no registry row (orphans) — surface them too.
  for (const d of dirs) {
    if (claimedDirs.has(d)) continue;
    infos.push({
      uuid: "",
      slug: displaySlugFromDirName(d),
      status: "unknown",
      dirName: d,
      active: d === activeDir,
    });
  }
  return infos;
}
//
// A conversation (one Claude Code `session_id`) works ONE intent at a time, but
// the active-intent CURSOR is per-user, durable, and shared across sessions — so
// resuming an A-chat after the cursor moved to B would otherwise silently inject
// B's context (the central multi-space hazard, vision §3). The fix is a tiny
// per-user, machine-local map: at session START stamp the working intent's UUID
// keyed by session_id; on RESUME, compare the stamped UUID to the live cursor
// and OFFER a rebind on mismatch. The map lives at `aidlc/.aidlc-sessions/`
// (gitignored — see dot-gitignore `aidlc/.aidlc-sessions/`): it is per-user
// runtime state, never shared truth. The intent record itself is the durable,
// harness-neutral artifact; the session merely enriches the cursor on resume.
export const SESSIONS_DIR = ".aidlc-sessions";

// The gitignored runtime scratch dir `aidlc/.aidlc-sessions/`. Exported because
// aidlc-usage.ts writes the usage ledger and the persisted-transcript-path
// pointers here, and the statusline/state consumers read the ledger back.
export function sessionsDir(projectDir: string): string {
  return join(workspaceRoot(projectDir), SESSIONS_DIR);
}

// The per-session record file: `aidlc/.aidlc-sessions/<session-id>`. Session
// ids must already match the canonical safe shape; normalization-changing
// values are rejected so distinct raw identities cannot alias one record.
function safeSessionId(sessionId: string): string {
  const safe = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  if (!safe || safe === "." || safe === "..") return "";
  return safe;
}

export function validSessionId(sessionId: string | undefined): string | null {
  const raw = sessionId ?? "";
  return raw && safeSessionId(raw) === raw ? raw : null;
}

export class SessionResolutionConflictError extends Error {
  constructor(
    readonly overrideSessionId: string,
    readonly ancestrySessionId: string,
  ) {
    super(
      `Session override "${overrideSessionId}" conflicts with the owning conversation ` +
        `"${ancestrySessionId}". Work from the owning conversation, or rebind this ` +
        "session with the intent/space switch verbs.",
    );
    this.name = "SessionResolutionConflictError";
  }
}

// The per-session record file: `aidlc/.aidlc-sessions/<session-id>`. The
// session id is normalised to the slug shape so a host-supplied id can never
// escape the sessions dir (path traversal / separators); an empty id yields "".
export function sessionRecordPath(projectDir: string, sessionId: string): string {
  const valid = validSessionId(sessionId);
  if (!valid) return "";
  return join(sessionsDir(projectDir), valid);
}

// How a binding's intent was chosen. Recorded so that a binding minted from the
// lone-record fallback is not later read as the conversation having joined.
export const SESSION_BINDING_SOURCES = [
  "create", // intent create bound its creating session
  "observed-create", // PostToolUse saw a creation response (trusted only with the cursor)
  "migration", // flat-layout migration moved this session's workflow
  "switch", // `intent <slug>` named the record
  "archive", // the bound record was archived (intent null)
  "space-switch-cursor", // `space <name>`; the target space's cursor named the record
  "space-switch-lone", // `space <name>`; only the lone-record rule named it
  "space-switch-none", // `space <name>`; no record resolved
  "worktree", // a validated delegated or local worktree names the record (re-checked each time)
  "unit-claim", // a Unit claimed on this machine names the record (re-checked each time)
  "cursor", // SessionStart followed this machine's cursor
  "stamp", // on resume, the session's own UUID stamp named the record
  "unjoined", // the selection came only from the lone-record rule
  "none", // nothing resolved
] as const;
export type SessionBindingSource = (typeof SESSION_BINDING_SOURCES)[number];

// Sources that record a choice. Worktree and Unit-claim joins rest on evidence
// that can go away, so the classifier re-checks that evidence instead. A stamp
// counts because only a joined session is stamped: writers that bind without a
// choice clear it.
export const TRUSTED_BINDING_SOURCES: ReadonlySet<SessionBindingSource> = new Set([
  "create", "migration", "switch", "space-switch-cursor", "cursor", "stamp",
]);

export interface SessionBinding {
  space: string;
  intent: string | null;
  boundAt: string;
  // Absent on bindings written before sources were recorded.
  source?: SessionBindingSource;
}

function sessionBindingPath(projectDir: string, sessionId: string): string {
  const recordPath = sessionRecordPath(projectDir, sessionId);
  return recordPath ? `${recordPath}.binding.json` : "";
}

// A record directory a session can select and keep: one path segment on this
// platform, without control characters, and without surrounding spaces the
// cursor file would trim away. The picker, the intent switch and the binding
// all use this one rule; text a model reads uses isSafeIntentRecordName.
export function isBindableIntentRecordName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return false;
  if (value === "." || value === ".." || value.includes("/")) return false;
  if (process.platform === "win32" && value.includes("\\")) return false;
  // No control character: C0, DEL, or C1.
  return [...value].every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f);
  });
}

// Read a session's pinned workflow selection. Malformed, unsafe, or stale
// records degrade to no binding so cursor behavior remains the fallback.
export function readSessionBinding(projectDir: string, sessionId: string): SessionBinding | null {
  const path = sessionBindingPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<SessionBinding>;
    if (
      typeof candidate.space !== "string" ||
      !SPACE_NAME_REGEX.test(candidate.space) ||
      (candidate.intent !== null &&
        (typeof candidate.intent !== "string" || !isBindableIntentRecordName(candidate.intent))) ||
      typeof candidate.boundAt !== "string" ||
      candidate.boundAt.length === 0
    ) {
      return null;
    }
    if (
      candidate.intent !== null &&
      !existsSync(join(intentsDir(projectDir, candidate.space), candidate.intent, "aidlc-state.md"))
    ) {
      return null;
    }
    const binding: SessionBinding = {
      space: candidate.space,
      intent: candidate.intent,
      boundAt: candidate.boundAt,
    };
    // An unrecognised source reads as absent, like a binding written before sources.
    if ((SESSION_BINDING_SOURCES as readonly unknown[]).includes(candidate.source)) {
      binding.source = candidate.source;
    }
    return binding;
  } catch {
    return null;
  }
}

// Pin a session to one space and optional intent record. This is machine-local
// runtime state, so any write failure silently falls back to shared cursors.
export function writeSessionBinding(
  projectDir: string,
  sessionId: string,
  space: string,
  intent: string | null,
  source?: SessionBindingSource,
): void {
  const path = sessionBindingPath(projectDir, sessionId);
  if (
    !path ||
    !SPACE_NAME_REGEX.test(space) ||
    (intent !== null && !isBindableIntentRecordName(intent))
  ) {
    return;
  }
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    const binding: SessionBinding = {
      space, intent, boundAt: isoTimestamp(), ...(source ? { source } : {}),
    };
    writeFileSync(path, `${JSON.stringify(binding)}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

// A Codex helper agent's thread, mapped to the chat that spawned it. Codex gives
// a spawned agent's shell its own CODEX_THREAD_ID and marks that agent's hook
// payloads with agent_id = that thread id under the root session_id, so the
// adapter notes the pair the first time it sees it and the resolver reads the
// root session for the helper's commands. Machine-local runtime state beside the
// session bindings; a write failure leaves the helper resolving as before.
export function helperSessionPath(projectDir: string, threadId: string): string {
  const recordPath = sessionRecordPath(projectDir, threadId);
  return recordPath ? `${recordPath}.helper-of` : "";
}

export function helperSessionRoot(projectDir: string, threadId: string): string | null {
  const path = helperSessionPath(projectDir, threadId);
  if (!path) return null;
  try {
    return validSessionId(readFileSync(path, "utf-8").trim());
  } catch {
    return null;
  }
}

export interface SessionPidEntry {
  // A null session stops ancestry fallback while SessionStart refreshes a PID.
  sessionId: string | null;
  startTime: string | null;
}

export interface ProcessIdentity {
  ppid: number;
  startTime: string | null;
}

// The most one walk may spend finding its chat, on every OS. A walk ends as
// soon as it has its answer (a few ms when idle), so this bounds only one that
// cannot finish, such as a `ps -A` that never answers. It is checked between
// steps, so on a busy machine a shorter one never saved the time a slow step
// took; it only lost the chat.
export function sessionAncestryBudgetMs(): number {
  return 2000;
}
export const SESSION_ANCESTRY_MAX_DEPTH = 64;
const SESSION_ANCESTRY_CACHE_MS = 1000;
export const sessionAncestryCache = new Map<
  string,
  { sessionId: string | null; expiresAt: number }
>();

export function sessionProcessPlatform(): NodeJS.Platform {
  const testPlatform = process.env.AIDLC_TEST_SESSION_PLATFORM;
  if (
    testPlatform === "linux" ||
    testPlatform === "darwin" ||
    testPlatform === "win32"
  ) {
    return testPlatform;
  }
  return process.platform;
}

export function sessionPidMapDir(projectDir: string): string {
  return join(sessionsDir(projectDir), "pids");
}

export function sessionPidEntryPath(projectDir: string, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "";
  return join(sessionPidMapDir(projectDir), String(pid));
}

function linuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const startTime = fields[19] ?? "";
    if (!Number.isSafeInteger(ppid) || ppid < 0 || startTime.length === 0) return null;
    return { ppid, startTime };
  } catch {
    return null;
  }
}

// macOS has no /proc, so one `ps` call reads the whole process table (pid,
// parent, lstart) and a walk reads every hop from it, instead of one `ps` per
// hop inside the same budget. The start time is the lstart string a per-pid
// lookup prints, so the entries SessionStart recorded before still match.
type ProcessTable = ReadonlyMap<number, ProcessIdentity>;

function macProcessTable(deadlineMs: number): ProcessTable | null {
  if (process.env.AIDLC_TEST_PS_DENIED === "1") return null;
  const timeout = Math.max(1, deadlineMs - Date.now());
  if (timeout <= 1) return null;
  try {
    const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
      encoding: "utf-8",
      timeout,
    });
    if (result.status !== 0) return null;
    const table = new Map<number, ProcessIdentity>();
    for (const line of (result.stdout ?? "").split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) table.set(pid, { ppid, startTime: match[3] });
    }
    return table;
  } catch {
    return null;
  }
}

// The table this process read last, reused for the ancestry cache window: one
// engine command walks the chain many times (hundreds on the late-question
// scope run), and the chain of a running process does not change while it
// runs. Liveness is still checked per hop and the PID entries are read fresh
// each walk; a SessionStart write clears it, so the next walk reads anew.
let sessionProcessTableCache: { table: ProcessTable; readAt: number } | null = null;

export function clearSessionProcessTable(): void {
  sessionProcessTableCache = null;
}

function cachedMacProcessTable(deadlineMs: number): ProcessTable | null {
  const now = Date.now();
  const cached = sessionProcessTableCache;
  if (cached && now >= cached.readAt && now - cached.readAt < SESSION_ANCESTRY_CACHE_MS) return cached.table;
  const table = macProcessTable(deadlineMs);
  sessionProcessTableCache = table === null ? null : { table, readAt: Date.now() };
  return table;
}

function loadWindowsSessionProcessApi() {
  const kernel = dlopen("kernel32.dll", {
    // Win32 BOOL is a 32-bit int, including on x64 and arm64.
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    const ntdll = dlopen("ntdll.dll", {
      NtQueryInformationProcess: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    return { kernel, ntdll };
  } catch (error) {
    kernel.close();
    throw error;
  }
}

let windowsSessionProcessApi: ReturnType<typeof loadWindowsSessionProcessApi> | null | undefined;

// Read one process generation through one stable handle. These API bindings are
// independent of the lock subsystem's process probes.
export function windowsSessionProcessIdentity(
  pid: number,
  deadlineMs = Date.now() + sessionAncestryBudgetMs(),
): ProcessIdentity | null {
  // A test platform override must never load Windows DLLs on another host.
  if (
    process.platform !== "win32" ||
    (process.arch !== "x64" && process.arch !== "arm64") ||
    !Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffffffff ||
    Date.now() >= deadlineMs
  ) return null;
  if (windowsSessionProcessApi === undefined) {
    try {
      windowsSessionProcessApi = loadWindowsSessionProcessApi();
    } catch {
      windowsSessionProcessApi = null;
    }
  }
  const api = windowsSessionProcessApi;
  if (!api || Date.now() >= deadlineMs) return null;

  let handle: Pointer | null = null;
  let identity: ProcessIdentity | null = null;
  try {
    // PROCESS_QUERY_INFORMATION | SYNCHRONIZE; never request mutation rights.
    handle = api.kernel.symbols.OpenProcess(0x0400 | 0x00100000, 0, pid);
    if (!handle) return null;
    // WAIT_TIMEOUT means the process object is still running. An exit code of
    // STILL_ACTIVE alone is insufficient: 259 can also be a process's exit code.
    if (api.kernel.symbols.WaitForSingleObject(handle, 0) !== 0x102) return null;

    // Native Windows x64/arm64 use little-endian LLP64. The documented
    // PROCESS_BASIC_INFORMATION is 48 bytes, aligned to 8: NTSTATUS at 0,
    // PEB* at 8, ULONG_PTR at 16, KPRIORITY at 24, PID at 32, parent PID at 40.
    // https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess
    const basic = new BigUint64Array(6);
    const returned = new Uint32Array(1);
    const status = api.ntdll.symbols.NtQueryInformationProcess(
      handle, 0, basic, basic.byteLength, returned,
    );
    if (
      status !== 0 || returned[0] !== basic.byteLength ||
      basic[4] !== BigInt(pid) || basic[5] > 0xffffffffn ||
      basic[5] === BigInt(pid) || Date.now() >= deadlineMs
    ) return null;

    // Each FILETIME consists of two DWORDs (8 bytes); keep all 64 bits.
    const creation = new BigUint64Array(1);
    const exit = new BigUint64Array(1);
    const kernel = new BigUint64Array(1);
    const user = new BigUint64Array(1);
    if (!api.kernel.symbols.GetProcessTimes(handle, creation, exit, kernel, user)) return null;
    if (creation[0] === 0n || api.kernel.symbols.WaitForSingleObject(handle, 0) !== 0x102) return null;
    identity = {
      ppid: Number(basic[5]),
      startTime: `win32:${creation[0].toString(16).padStart(16, "0")}`,
    };
  } catch {
    identity = null;
  } finally {
    if (handle) {
      try {
        if (!api.kernel.symbols.CloseHandle(handle)) identity = null;
      } catch {
        identity = null;
      }
    }
  }
  return Date.now() < deadlineMs ? identity : null;
}

export function windowsParentEdge(
  parent: ProcessIdentity | null,
  child: ProcessIdentity | null,
): "verified" | "rejected" | "unknown" {
  const generation = /^win32:[0-9a-f]{16}$/;
  if (
    typeof parent?.startTime !== "string" || !generation.test(parent.startTime) ||
    typeof child?.startTime !== "string" || !generation.test(child.startTime)
  ) return "unknown";
  // Fixed-width hex preserves FILETIME order without rounding to JS numbers.
  // Equal timestamps do not establish order, so that edge also fails closed.
  return parent.startTime < child.startTime ? "verified" : "rejected";
}

// One walk's process lookups. On macOS the first lookup reads the process
// table and every later one in the same walk reads from it; Linux and Windows
// read each pid directly, as cheaply as before.
export function processIdentityReader(deadlineMs: number): (pid: number) => ProcessIdentity | null {
  const platform = sessionProcessPlatform();
  let table: ProcessTable | null | undefined;
  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || Date.now() >= deadlineMs) return null;
    if (platform === "linux") return linuxProcessIdentity(pid);
    if (platform === "win32") return windowsSessionProcessIdentity(pid, deadlineMs);
    if (platform !== "darwin") return null;
    if (table === undefined) table = cachedMacProcessTable(deadlineMs);
    return table?.get(pid) ?? null;
  };
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readSessionPidEntry(projectDir: string, pid: number): SessionPidEntry | null {
  const path = sessionPidEntryPath(projectDir, pid);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<SessionPidEntry>;
    if (
      (candidate.sessionId !== null &&
        (typeof candidate.sessionId !== "string" ||
          validSessionId(candidate.sessionId) === null)) ||
      (candidate.startTime !== null && typeof candidate.startTime !== "string")
    ) {
      return null;
    }
    return candidate as SessionPidEntry;
  } catch {
    return null;
  }
}

// Resolve the nearest mapped ancestor of the calling process. Every failure is
// a silent miss so tools retain cursor behavior when process metadata is absent.
export function resolveSessionIdFromAncestry(projectDir: string): string | null {
  const cached = sessionAncestryCache.get(projectDir);
  if (cached && cached.expiresAt > Date.now()) return cached.sessionId;
  const resolved = resolveSessionIdFromAncestryUncached(projectDir);
  if (resolved === null) {
    sessionAncestryCache.set(projectDir, {
      sessionId: null,
      expiresAt: Date.now() + SESSION_ANCESTRY_CACHE_MS,
    });
  } else {
    sessionAncestryCache.delete(projectDir);
  }
  return resolved;
}

function resolveSessionIdFromAncestryUncached(projectDir: string): string | null {
  if (!existsSync(sessionPidMapDir(projectDir))) return null;
  const deadline = Date.now() + sessionAncestryBudgetMs();
  const windows = sessionProcessPlatform() === "win32";
  let childIdentity = windows ? windowsSessionProcessIdentity(process.pid, deadline) : null;
  if (windows && (!childIdentity || childIdentity.ppid !== process.ppid)) return null;
  const readIdentity = processIdentityReader(deadline);
  const seen = new Set<number>();
  let pid = process.ppid;
  for (let depth = 0; depth < SESSION_ANCESTRY_MAX_DEPTH; depth++) {
    if (pid <= 1 || seen.has(pid) || Date.now() >= deadline) return null;
    seen.add(pid);
    const identity = readIdentity(pid);
    if (!identity || !processIsAlive(pid)) return null;
    // A parent PID can outlive its original owner. Do not join this walk to a
    // replacement process born after (or indistinguishably close to) its child.
    if (windows && windowsParentEdge(identity, childIdentity) !== "verified") return null;
    const entry = readSessionPidEntry(projectDir, pid);
    if (
      entry &&
      (entry.startTime === null || entry.startTime === identity.startTime)
    ) {
      return windows && entry.startTime === null ? null : entry.sessionId;
    }
    childIdentity = identity;
    pid = identity.ppid;
  }
  return null;
}

export interface WorkflowSelection {
  space: string;
  intent: string | null;
  sessionId: string | null;
  binding: SessionBinding | null;
}

export interface WorkflowSelectionOptions {
  space?: string;
  intent?: string;
  sessionId?: string;
  bind?: boolean;
}

// THE ONE DOOR. Every id a host hands the engine (a hook payload's session_id,
// the shell's own chat variable, a helper's thread id) passes here before any
// chat or work record is read: the raw id maps to its root chat through the
// helper-of fact the adapter wrote (the one fact the engine cannot know), that
// chat's binding is read, and a chat with no binding is bound at first contact
// by the rule a new chat follows at SessionStart: silently, to the work the
// shared cursor names if this machine has joined it, else to no record. From
// then on the chat stays on that work; the cursor moving later (another window
// switched) does not move it. A process with no id at all (the person's own
// terminal) never comes here and keeps following the cursor.
export interface ResolvedChat {
  chatId: string;
  binding: SessionBinding | null;
}

// First contact settles a chat's work only when this process IS that chat: its
// identity came from its own environment or process ancestry. A caller that
// NAMES a session is asking about a chat, not acting as one: a hook reading its
// payload, a command carrying --session, an engine child a hook handed its
// identity to. Those resolve read-only, so a host-injected prompt (a Kiro IDE
// workflow step's brief, a background notification) never gets work of its own
// and never leaves a non-person actor sitting on the person's record.
export function resolveChat(
  projectDir: string,
  rawId: string | null | undefined,
  options: { bind?: boolean } = {},
): ResolvedChat | null {
  const id = validSessionId(rawId ?? undefined);
  if (!id) return null;
  const chatId = helperSessionRoot(projectDir, id) ?? id;
  const existing = readSessionBinding(projectDir, chatId);
  const bind = options.bind ?? false;
  if (existing) return { chatId, binding: rejoinedByThisMachine(projectDir, chatId, existing, bind) ?? existing };
  // Read-only: the chat keeps whatever the shared selection names, as before.
  if (!bind) return { chatId, binding: null };
  // A worker's own worktree already names the work it was prepared for, and
  // that record governs every resolution there, so first contact binds nothing:
  // the worktree is the identity, not this chat.
  let delegated: ReturnType<typeof delegatedWorktreeIntent> = null;
  try {
    delegated = delegatedWorktreeIntent(projectDir);
  } catch {
    delegated = null;
  }
  if (delegated) {
    return {
      chatId,
      binding: { space: delegated.space, intent: delegated.intent, boundAt: isoTimestamp(), source: "worktree" },
    };
  }
  const space = activeSpace(projectDir);
  const resolved: WorkflowSelection = { space, intent: activeIntent(projectDir, space), sessionId: chatId, binding: null };
  const contact = classifyFirstContact(projectDir, resolved);
  writeSessionBinding(projectDir, chatId, contact.selection.space, contact.selection.intent, contact.source);
  // A record the binding cannot carry, or a write that failed, still answers
  // what the chat is on for this process.
  const binding = readSessionBinding(projectDir, chatId) ??
    { space: contact.selection.space, intent: contact.selection.intent, boundAt: isoTimestamp(), source: contact.source };
  return { chatId, binding };
}

// A binding to no record whose source is "unjoined" is provisional: when the chat
// first met the workspace, the only record here was found by the lone-record
// rule and this machine had not chosen it (a teammate's record in a fresh
// clone). A choice made here since (the per-user cursor, written only by
// create and switch on this machine) is the very evidence a new chat joins by,
// so the binding is read again against it at every entry and the chat joins
// exactly as first contact would have, silently. With no choice made it stays
// out, as before. The binding is rewritten only when the caller may bind; a
// hook (read-only) sees the same answer and the chat's own next command writes it.
function rejoinedByThisMachine(
  projectDir: string,
  chatId: string,
  existing: SessionBinding,
  bind: boolean,
): SessionBinding | null {
  if (existing.intent !== null || existing.source !== "unjoined") return null;
  if (readActiveIntentCursor(projectDir, existing.space) === null) return null;
  const resolved: WorkflowSelection = {
    space: existing.space, intent: activeIntent(projectDir, existing.space), sessionId: chatId, binding: null,
  };
  const contact = classifyFirstContact(projectDir, resolved);
  if (!contact.joined) return null;
  if (bind) writeSessionBinding(projectDir, chatId, contact.selection.space, contact.selection.intent, contact.source);
  // What the chat is on for this process is the join just found, whether or not
  // the write landed; the binding is read in resolveChat alone.
  return { space: contact.selection.space, intent: contact.selection.intent, boundAt: isoTimestamp(), source: contact.source };
}

// The rule a new chat follows when it first meets a workflow: resolving a record
// is not joining it. Joined (participation by the cursor, this checkout's
// worktree record or a Unit claim) keeps the record and names the evidence as
// the binding's source; not joined binds to no record ("unjoined" when a record
// was found, "none" when there was nothing). SessionStart adds its own stamp and
// pre-existing-binding branches on top; resolveChat uses the rule as it is.
export function classifyFirstContact(
  projectDir: string,
  resolved: WorkflowSelection,
): { joined: boolean; selection: WorkflowSelection; source: SessionBindingSource } {
  const joined = workflowParticipation(projectDir, resolved) === "participant";
  const selection = joined ? resolved : { ...resolved, intent: null, binding: null };
  if (!joined) return { joined, selection, source: resolved.intent === null ? "none" : "unjoined" };
  if (readActiveIntentCursor(projectDir, selection.space) === selection.intent) return { joined, selection, source: "cursor" };
  const unitScope = readUnitScopeStamp(projectDir);
  const source: SessionBindingSource =
    unitScope?.space === selection.space && unitScope.intent_uuid === intentUuidForSelection(projectDir, selection)
      ? "unit-claim"
      : "worktree";
  return { joined, selection, source };
}

// The session of the conversation that invoked this process, when the caller
// named none: the hook-injected override first, then the process ancestry.
// Throws SessionResolutionConflictError when the two disagree and the override
// did not come from a validated hook payload.
// The chat the host names in the agent's own shell. Each host that names one
// does it its own way, and the engine needs no override written into the
// command: Codex gives every command CODEX_THREAD_ID, Claude Code gives
// CLAUDE_CODE_SESSION_ID beside the pid of the process running that chat, and
// Kiro CLI gives KIRO_SESSION_ID (measured: its shell carries no pid).
//
// A variable is only as good as the chat it names. A shell the person started
// from inside a chat keeps the variable after that chat is gone, so Claude
// Code's id counts only while the process it names is alive; a dead or absent
// pid leaves the id unread and the process ancestry decides, as before. Kiro
// CLI has no pid in the shell to check, so its id stands on its own, as Codex's
// does. Every other harness names no chat in the shell.
function hostNamedChat(projectDir: string): string | null {
  switch (runtimeHarnessDir(projectDir)) {
    case ".codex":
      return validSessionId(process.env.CODEX_THREAD_ID);
    case ".claude":
      return claudeNamedChat()?.session ?? null;
    case ".kiro":
      return validSessionId(process.env.KIRO_SESSION_ID);
    default:
      return null;
  }
}

export function claudeNamedChat(): { pid: number; session: string } | null {
  const pid = Number.parseInt(process.env.CLAUDE_PID ?? "", 10);
  const session = Number.isSafeInteger(pid) && processIsAlive(pid)
    ? validSessionId(process.env.CLAUDE_CODE_SESSION_ID)
    : null;
  return session === null ? null : { pid, session };
}

export function resolveInvokingSessionId(projectDir: string): string | null {
  const overrideSession = validSessionId(process.env.AIDLC_SESSION_OVERRIDE);
  // A spawned helper agent's shell carries the helper's own thread id; that
  // thread resolves to the chat that spawned it (noteHelperSession).
  const hostThread = overrideSession === null ? hostNamedChat(projectDir) : null;
  const hostSession = hostThread === null ? null : helperSessionRoot(projectDir, hostThread) ?? hostThread;
  const envSession = overrideSession ?? hostSession;
  // This refusal is a footgun guard against stale exported overrides, not a
  // security boundary. The SOURCE marker is an internal hookChildEnv contract.
  // Deliberately setting both variables is an intentional same-user act
  // equivalent to a sanctioned session switch; no privilege boundary exists
  // between callers that could authenticate it.
  // The host's own word for the chat this shell runs in is not a stale export:
  // process ancestry is the engine's reconstruction of the same fact, and a
  // second chat starting is enough to make the two differ.
  const payloadOverride =
    hostSession !== null ||
    (overrideSession !== null && process.env.AIDLC_SESSION_OVERRIDE_SOURCE === "payload");
  // Then the named chat is the answer and nothing below reads the walk's, so
  // the process chain is not walked (a hook's own process included).
  if (payloadOverride) return envSession;
  const ancestrySession = resolveSessionIdFromAncestry(projectDir);
  if (
    envSession &&
    ancestrySession &&
    envSession !== ancestrySession &&
    !payloadOverride
  ) {
    throw new SessionResolutionConflictError(envSession, ancestrySession);
  }
  return envSession ?? ancestrySession;
}

// Resolve one stable workflow target for an operation. Explicit selectors win,
// then the session binding, then the legacy cursor and lone-intent rules.
export function resolveWorkflowSelection(
  projectDir: string,
  options: WorkflowSelectionOptions = {},
): WorkflowSelection {
  // An explicit selector becomes one path segment, so it must not be a path: a
  // "../" in --space or --intent could otherwise reach a record outside the
  // project. Every command that takes them resolves them here. Any name that
  // stays one segment still resolves, as before (an empty intent is the legacy
  // flat record). A backslash separates only on Windows; elsewhere it is a
  // filename character a teammate's migrated record may carry.
  const isPath = (value: string): boolean =>
    value === "." || value === ".." || /[/\0]/.test(value) || (process.platform === "win32" && value.includes("\\"));
  if (options.space !== undefined && isPath(options.space)) {
    throw new Error(`"${options.space}" is not a space name: it is a path.`);
  }
  if (options.intent !== undefined && isPath(options.intent)) {
    throw new Error(`"${options.intent}" is not an intent name: it is a path.`);
  }
  const delegated = delegatedWorktreeIntent(projectDir);
  if (delegated) {
    if ((options.space !== undefined && options.space !== delegated.space) ||
      (options.intent !== undefined && options.intent !== delegated.intent)) {
      throw new Error("Workflow selection does not match the delegated worktree intent");
    }
    return { space: delegated.space, intent: delegated.intent, sessionId: null, binding: null };
  }
  const named = validSessionId(options.sessionId);
  const rawSession = named ?? resolveInvokingSessionId(projectDir);
  // Only this process's own identity settles a chat at first contact; a named
  // session, or identity a hook handed us, is read-only.
  const chat = rawSession
    ? resolveChat(projectDir, rawSession, {
        bind: options.bind !== false && named === null &&
          process.env.AIDLC_SESSION_OVERRIDE_SOURCE !== "payload",
      })
    : null;
  const sessionId = chat?.chatId ?? null;
  const binding = chat?.binding ?? null;
  const space = options.space ?? binding?.space ?? activeSpace(projectDir);
  let intent: string | null;
  if (options.intent !== undefined) {
    intent = options.intent;
  } else if (binding && binding.space === space) {
    intent = binding.intent;
  } else {
    intent = activeIntent(projectDir, space);
  }
  return { space, intent, sessionId, binding };
}

export type WorkflowParticipation = "participant" | "outsider" | "indeterminate";

// The record this checkout's own worktree metadata names, when that metadata was
// written for this repository on this machine. `aidlc worktree create` stamps the
// hash of the creating repository's git common dir; a copy of the file carried
// into another clone or machine does not match it.
function localWorktreeRecord(projectDir: string): string | null {
  const metaPath = join(projectDir, ".aidlc", "worktree-meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    assertNoSymlinkInChainOrThrow(projectDir, ".aidlc/worktree-meta.json");
    const meta = JSON.parse(
      readRegularFileNoFollowOrThrow(metaPath, "worktree metadata").toString("utf-8"),
    ) as { version?: unknown; intentRecord?: unknown; gitCommonDirHash?: unknown };
    if (meta.version !== 1 || typeof meta.intentRecord !== "string" ||
      typeof meta.gitCommonDirHash !== "string") return null;
    const commonRaw = gitRevParseSingle(projectDir, "--git-common-dir");
    if (commonRaw === null) return null;
    const common = realpathSync(resolvePath(projectDir, commonRaw)).replace(/\\/g, "/");
    const key = process.platform === "win32" ? common.toLowerCase() : common;
    return createHash("sha256").update(key).digest("hex") === meta.gitCommonDirHash
      ? meta.intentRecord
      : null;
  } catch {
    return null;
  }
}

// Whether this conversation's hooks may write into, or enforce, the record a
// selection names. Resolution (which record the path helpers name) keeps the
// lone-record fallback, because worktrees inherit no cursor; participation asks
// for local evidence that this conversation chose the record. A lone committed
// record is not such evidence: in a fresh clone it is a teammate's.
export function workflowParticipation(
  projectDir: string,
  selection: WorkflowSelection,
): WorkflowParticipation {
  if (selection.intent === null) return "outsider";
  let delegated: ReturnType<typeof delegatedWorktreeIntent>;
  try {
    delegated = delegatedWorktreeIntent(projectDir);
  } catch {
    return "indeterminate";
  }
  if (delegated) {
    return delegated.space === selection.space && delegated.intent === selection.intent
      ? "participant"
      : "indeterminate";
  }
  const cursorNamesIt = readActiveIntentCursor(projectDir, selection.space) === selection.intent;
  const binding = selection.binding;
  if (binding && binding.space === selection.space && binding.intent === selection.intent) {
    if (binding.source !== undefined && TRUSTED_BINDING_SOURCES.has(binding.source)) {
      return "participant";
    }
  }
  if (localWorktreeRecord(projectDir) === relativeRecordDirForSelection(selection)) {
    return "participant";
  }
  // A Unit claimed on this machine names its space and intent.
  const unitScope = readUnitScopeStamp(projectDir);
  if (unitScope && unitScope.space === selection.space &&
    unitScope.intent_uuid === intentUuidForSelection(projectDir, selection)) {
    return "participant";
  }
  // The per-user cursor naming the record: covers bindings written before
  // sources were recorded, creations observed after the fact, and sessions that
  // reach hooks without a SessionStart binding.
  if (cursorNamesIt) return "participant";
  return "outsider";
}

export function relativeRecordDirForSelection(selection: WorkflowSelection): string | null {
  if (selection.intent === null) return null;
  return `aidlc/spaces/${selection.space}/intents/${selection.intent}`;
}

// Sibling-only swarm worktrees have no local registry; their delegated parent
// creation authority supplies the UUID only for the same selected intent.
export function intentUuidForSelection(
  projectDir: string,
  selection: WorkflowSelection,
): string | null {
  if (selection.intent === null) return null;
  const uuid = listIntents(projectDir, selection.space).find(
    (entry) => entry.dirName === selection.intent,
  )?.uuid;
  if (uuid) return uuid;
  const delegated = delegatedWorktreeIntent(projectDir);
  return delegated?.space === selection.space && delegated.intent === selection.intent
    ? delegated.intentUuid
    : null;
}

// The UUID of the active intent in a space (the cursor's / lone intent's
// registry row), or null when no new-layout intent resolves (flat-legacy) or
// the active record has no registry row (an orphan — no stable uuid to stamp).
export function activeIntentUuid(projectDir: string, space?: string): string | null {
  const sp = space ?? activeSpace(projectDir);
  const activeDir = activeIntent(projectDir, sp);
  if (activeDir === null) return null;
  const match = listIntents(projectDir, sp).find((i) => i.dirName === activeDir);
  return match?.uuid ? match.uuid : null;
}

/**
 * A swarm worker without a registry row of its own inherits identity from its
 * attested parent record: a multi-repo sibling, or a single-repository child
 * whose checkout carries no row for the intent (the records were not committed
 * when it was made, or an earlier intent's registry is what the base commit has).
 */
export function delegatedWorktreeIntent(projectDir: string): {
  parent: string; space: string; intent: string; intentRecord: string; intentUuid: string;
} | null {
  const metaPath = join(projectDir, ".aidlc", "worktree-meta.json");
  if (!existsSync(metaPath)) return null;
  if (activeIntentUuid(projectDir) !== null) return null;
  assertNoSymlinkInChainOrThrow(projectDir, ".aidlc/worktree-meta.json");
  const meta = JSON.parse(readRegularFileNoFollowOrThrow(metaPath, "worktree intent provenance").toString("utf-8"));
  // Workspace-shell worktrees and non-swarm work retain their existing resolution.
  if (meta?.swarmUnit === undefined) return null;
  const record = typeof meta?.intentRecord === "string"
    ? /^aidlc\/spaces\/([a-z][a-z0-9-]*)\/intents\/([^/]+)$/.exec(meta.intentRecord) : null;
  if (meta?.version !== 1 || !record || record[2] === "." || record[2] === ".." ||
    (meta.repoSelector !== null && (typeof meta.repoSelector !== "string" || !meta.repoSelector)) ||
    typeof meta.swarmUnit !== "string" || meta.boltSlug !== boltSlugForUnit(meta.swarmUnit)) {
    throw new Error("Invalid delegated worktree intent provenance");
  }
  const child = canonicalPathKey(projectDir);
  const parent = dirname(dirname(dirname(child)));
  const expectedDir = typeof meta.intentId8 === "string"
    ? worktreePath(parent, meta.intentId8, meta.boltSlug)
    : legacyWorktreePath(parent, meta.boltSlug);
  if ((meta.intentId8 !== undefined &&
    (typeof meta.intentId8 !== "string" || !BOLT_INTENT_ID8_REGEX.test(meta.intentId8))) ||
    canonicalPathKey(expectedDir) !== child ||
    relativeRecordDir(parent) !== meta.intentRecord) {
    throw new Error("Delegated worktree does not match the active parent intent record");
  }
  assertNoSymlinkInChainOrThrow(parent, relative(parent, projectDir));
  const [, space, intent] = record;
  const intentUuid = listIntents(parent, space).find((entry) => entry.dirName === intent)?.uuid;
  if (meta.intentId8 !== undefined &&
    (!intentUuid || meta.intentId8 !== idSuffix(intentUuid))) {
    throw new Error("Delegated worktree does not match the active parent intent record");
  }
  const unreadable: string[] = [];
  const creations = maximalAttemptEvents(readAuditShardEvents(parent, intent, space, unreadable).filter(
    (row) => row.event === "WORKTREE_CREATED" && auditBlockField(row.block, "Bolt slug") === meta.boltSlug,
  ));
  const creation = creations.length === 1 ? creations[0] : null;
  const path = creation && auditBlockField(creation.block, "Worktree path");
  if (!intentUuid || unreadable.length || !creation || !path ||
    canonicalPathKey(resolveAuditWorktreePath(parent, path)) !== child ||
    auditBlockField(creation.block, "Intent record") !== meta.intentRecord ||
    auditBlockField(creation.block, "Repo") !== (meta.repoSelector ?? "-") ||
    auditBlockField(creation.block, "Swarm Unit") !== meta.swarmUnit) {
    throw new Error("Delegated worktree intent has no matching immutable creation authority");
  }
  return { parent, space, intent, intentRecord: meta.intentRecord, intentUuid };
}
//
// Each absolute path helper resolves the per-intent record dir when an intent
// exists (explicit arg, active cursor, or a lone intent), else the bare SPACE
// record root (spaceRecordRoot). There is NO flat `aidlc-docs/` fallback any more
// — the transitional bridge was retired in P9 once the fixtures migrated. The
// only place the legacy flat root is still touched is the one-time migration
// SOURCE (flatStateSource/flatMigrationSource above).

export function stateFilePath(projectDir: string, intent?: string, space?: string): string {
  const resolved = resolveRecordDir(projectDir, intent, space);
  if (resolved.dir === null) {
    return join(
      spaceRecordRoot(projectDir, resolved.space),
      "aidlc-state.md",
    );
  }
  return join(resolved.dir, "aidlc-state.md");
}

// The engine's final validated run-stage is the active execution cursor. Most
// stages match aidlc-state.md's Current Stage, but unit-major Construction can
// interleave later stages while the durable cursor stays on the first block
// stage. Persist that transient fact per intent so path-only PostToolUse hooks
// can attribute diagnostics to the directive the conductor is actually running.
export const ACTIVE_DIRECTIVE_MARKER = "active-directive.json";
//
// A directive is bound to the workflow state it was issued for, so that a state
// transition invalidates it. Binding to the WHOLE FILE overshoots: aidlc-state.md
// also carries a cache layer the template itself calls "never routing or
// completion evidence" (Last Updated, the active Unit's lifecycle mirror, the
// derived Unit Progress grid, detected workspace facts). Hashing those made the
// directive unreadable after writes no human would call a change - a status
// sync, a Unit pause, a metadata refresh - and an unreadable directive means no
// resolvable authority, which is how a recorded Plan Approval became
// unreachable.
//
// So the digest is taken over a PROJECTION: every routing and completion field
// stays byte-exact (Stage Progress checkboxes, Current/Next Stage, Status,
// Lifecycle and Phase Progress, Scope, Depth, Test Strategy, Revision Count,
// Unit Ownership, Unit Gate Rhythm, Construction Iteration, Skeleton Stance,
// Parked, Project Type, State Version, Total Stages, In Progress), and the cache
// layer and empty separator lines are dropped. Changing a routing field still
// invalidates the directive.
//
// Blacklist rather than allowlist, deliberately: a new routing field must be
// covered by default, and only a field someone consciously classifies as cache
// may leave the digest. The contributor question in
// docs/reference/11-contributing.md asks for that classification by name.
const STATE_DIGEST_IGNORED_FIELDS = new Set([
  // Timestamps and the active persona.
  "Last Updated",
  "Active Agent",
  "Practices Affirmed Timestamp",
  "Start Date",
  // The active Unit's lifecycle mirror. The receipts in the ledger are the
  // authority for a Unit's lifecycle; these fields are a convenience copy.
  "Active Unit",
  "Unit Stage",
  "Unit State",
  "Unit Pause Reason",
  "Unit Next Action",
  // Derived counts and breadcrumbs.
  "Completed",
  "Worktree Path",
  "Bolt Refs",
  // Descriptive project prose and provenance, never routing.
  "Project",
  "Project Description Source",
  // Detected workspace facts (the `## Workspace State` section).
  "Project Root",
  "Languages",
  "Frameworks",
  "Build System",
  // The resume-point breadcrumb (the `## Session Resume Point` section).
  "Last Completed Stage",
  "Next Action",
  "Pending Artifacts",
]);

// The one section whose BODY is engine-derived rather than authored: the Unit
// Progress grid is rewritten on every routed `next` from the Unit DAG, artifact
// coverage, and gate events, and the template says in as many words that hand edits
// there are not the evidence the engine routes on. The claim path does parse those
// rows (`completedUnits` in aidlc-unit.ts), so this is a deliberate trade: a hand
// edit there survives the digest until the next routed `next` rewrites the grid from
// the DAG, and the claim gate re-reads live state rather than the digest. Only its
// table rows are
// dropped, so anything unexpected inside the section still binds.
const STATE_DIGEST_DERIVED_TABLE_SECTION = "## Unit Progress";

// Drop the cache layer from aidlc-state.md. Deliberately line-based and
// field-named rather than section-wide: dropping a whole section would also drop
// anything appended after it (the template's last section is a cache section), so
// an unrecognised nonempty line anywhere in the file still binds the directive.
export function projectStateForDigest(stateContent: string): string {
  const kept: string[] = [];
  let inDerivedTable = false;
  // Split on every terminator JavaScript itself treats as one. `getField` reads the
  // state with the `m` flag, so a bare CR, U+2028 or U+2029 starts a new line for the
  // ENGINE too; splitting on LF alone would fold a routing field onto an ignored
  // field's physical line and drop both, leaving a live routing change invisible to
  // the digest.
  for (const line of stateContent.split(/\r\n|[\n\r\u2028\u2029]/)) {
    // setOrInsertField adds Markdown separators through appendUnderHeading.
    // Removing or projecting out its field leaves those empty lines behind.
    // They carry no state authority; retain every other line byte-exact, including
    // whitespace-only lines, rather than trimming potentially meaningful content.
    if (line === "") continue;
    if (line.startsWith("## ")) {
      inDerivedTable = line.trim() === STATE_DIGEST_DERIVED_TABLE_SECTION;
      kept.push(line);
      continue;
    }
    if (inDerivedTable && /^[ \t]*\|/.test(line)) continue;
    const field = /^- \*\*([^*]+)\*\*:/.exec(line);
    if (field && STATE_DIGEST_IGNORED_FIELDS.has(field[1].trim())) continue;
    // The retired and current names are the same policy field. A name-only
    // migration must not invalidate an issued directive or its bound runtime
    // authority; value, source, duplicate, and conflict changes still bind.
    if (field?.[1].trim() === "Change Control") {
      kept.push(line.replace(
        /^- \*\*Change Control\*\*:/,
        "- **Guard Policy**:",
      ));
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

// The digest every active-directive comparison uses. Exported because the engine
// (which stamps it into the marker and the continuation token) and the Stop hook
// (whose no-progress signature must agree with it) both need the same value.
export function stateDigest(stateContent: string): string {
  return createHash("sha256")
    .update(projectStateForDigest(stateContent), "utf-8")
    .digest("hex");
}
// A state-line label or a command's words: what doctor and a refusal may print.
export const OUT_OF_DATE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]{0,79}$/;
export const OUT_OF_DATE_MAX_CHANGED = 8;

// Per-clone audit SHARD path: `…/intents/<slug>-<id8>/audit/<host>-<clone>.md`.
// The audit trail is committed (vision §5.1) but each clone writes its OWN
// shard so git never merge-conflicts concurrent appends (merge=union was proven
// to corrupt the multi-line blocks). Readers glob `audit/*.md` and merge-sort by
// timestamp — see auditShards()/readAllAuditShards(). With no intent resolved the
// shard lands under the bare space record root (no flat audit.md any more).
export function auditFilePath(projectDir: string, intent?: string, space?: string): string {
  const resolved = resolveRecordDir(projectDir, intent, space);
  if (resolved.dir === null) {
    return join(
      spaceRecordRoot(projectDir, resolved.space),
      "audit",
      auditShardName(projectDir),
    );
  }
  return join(resolved.dir, "audit", auditShardName(projectDir));
}

// The clone-id token file: `aidlc/.aidlc-clone-id`. Workspace-level,
// machine-local, GITIGNORED (see the `aidlc/.aidlc-*` rule) so it never travels
// in a commit — that is what makes the token DISTINCT across clones (a fresh
// checkout has no token file and mints its own). The shard name below embeds
// this token, so every process IN one clone resolves the SAME shard while two
// different clones get DIFFERENT shards (no git merge-conflict on concurrent
// appends — the whole point of per-clone sharding).
export const CLONE_ID_FILE = ".aidlc-clone-id";

export function cloneIdPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLONE_ID_FILE);
}

// The host segment of a NEWLY minted shard name: hostname() is a human-readable
// hint only. It can carry dots/uppercase, so normalise it to the slug shape that
// never escapes the audit dir.
export function auditShardHostSegment(): string {
  return hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
}

// The clone-id file: line 1 the token, line 2 the host segment recorded when
// the token was minted. Every writer of the file uses this one format.
export function cloneIdFileContent(token: string, host: string): string {
  return `${token}\n${host}\n`;
}

const CLONE_TOKEN_RE = /^[a-z0-9]{1,32}$/;
const CLONE_HOST_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

interface CloneIdentity {
  token: string;
  host: string;
}

// The host an earlier version already named this clone's shards with, read from
// the shard files (`<host>-<token>.md` in any intent's or space's audit dir), so
// a token-only clone file upgraded after the machine's name changed continues
// that shard instead of starting another. A shard under this machine's current
// name wins; otherwise the most recently written one; null when there is none.
function existingShardHost(projectDir: string, token: string): string | null {
  const suffix = `-${token}.md`;
  const current = auditShardHostSegment();
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  let newest: { host: string; mtime: number } | null = null;
  const root = spacesRoot(projectDir);
  for (const space of list(root)) {
    const intents = join(root, space, "intents");
    const auditDirs = [join(intents, "audit"), ...list(intents).map((entry) => join(intents, entry, "audit"))];
    for (const audit of auditDirs) {
      for (const file of list(audit)) {
        if (!file.endsWith(suffix)) continue;
        const host = file.slice(0, -suffix.length);
        if (!CLONE_HOST_RE.test(host)) continue;
        if (host === current) return current;
        let mtime: number;
        try {
          mtime = lstatSync(join(audit, file)).mtimeMs;
        } catch {
          continue;
        }
        if (newest === null || mtime > newest.mtime || (mtime === newest.mtime && host < newest.host)) {
          newest = { host, mtime };
        }
      }
    }
  }
  return newest?.host ?? null;
}

function parseCloneIdFile(raw: string): { token: string | null; host: string | null } {
  const [token = "", host = ""] = raw.split(/\r?\n/).map((line) => line.trim());
  return {
    token: CLONE_TOKEN_RE.test(token) ? token : null,
    host: CLONE_HOST_RE.test(host) ? host : null,
  };
}

// The stable per-CLONE identity (not per-process). Read from the gitignored
// `aidlc/.aidlc-clone-id` file when present; minted (12 hex chars from a v4
// uuid, no Math.random) and persisted on first use otherwise. Stable WITHIN a
// clone across processes (the fork subprocess and the merge subprocess both
// read the same file, so the same shard), DISTINCT across clones (each clone
// mints its own; the file is gitignored so it doesn't travel in a commit).
//
// The host segment is part of the identity, recorded once. Computing it from
// hostname() in every process split one clone's audit into a new shard each
// time the machine's name changed (a laptop on another network, a VPN) or the
// folder was copied to another machine, and same-second rows across those
// shards read as unordered, so finished work stopped counting. A file from
// before this format (token only) is upgraded in place, keeping the host its
// existing shard already carries (see existingShardHost) or else the current
// one, by atomic replace so a concurrent reader never sees a partial file and
// mints a new token.
//
// A read/mint race between two first-run processes converges on whichever
// write lands last; both re-read that file, so the clone settles on ONE
// identity (a transient extra shard on the very first concurrent mint is
// harmless: readers glob `audit/*.md`). Memoized per process. Best-effort: an
// unwritable workspace (or a read-only engine probe, for the upgrade) keeps the
// identity in memory for this process.
const CLONE_IDENTITIES = new Map<string, CloneIdentity>();
export function cloneIdentity(projectDir: string): CloneIdentity {
  const key = canonicalPathKey(projectDir);
  const cached = CLONE_IDENTITIES.get(key);
  if (cached) return cached;
  const path = cloneIdPath(projectDir);
  let recorded: { token: string | null; host: string | null } = { token: null, host: null };
  try {
    recorded = parseCloneIdFile(readFileSync(path, "utf-8"));
  } catch {
    // no file yet: mint below
  }
  if (recorded.token && recorded.host) {
    const identity = { token: recorded.token, host: recorded.host };
    CLONE_IDENTITIES.set(key, identity);
    return identity;
  }
  let identity: CloneIdentity = {
    token: recorded.token ?? randomUUID().replace(/-/g, "").slice(0, 12),
    host: (recorded.token && existingShardHost(projectDir, recorded.token)) || auditShardHostSegment(),
  };
  try {
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    const content = cloneIdFileContent(identity.token, identity.host);
    if (recorded.token) writeFileAtomic(path, content);
    else writeFileSync(path, content, "utf-8");
    // Re-read so a concurrent write that landed last wins for ALL processes in
    // this clone (converge on one on-disk identity).
    const settled = parseCloneIdFile(readFileSync(path, "utf-8"));
    if (settled.token) {
      identity = { token: settled.token, host: settled.host ?? identity.host };
    }
  } catch {
    // unwritable workspace: in-memory identity for this process
  }
  CLONE_IDENTITIES.set(key, identity);
  return identity;
}

// Where the audit trail stood when a question was shown: the shard and its
// size then, so the turns after it are the replies it can have.
export interface AuditMark {
  shard: string;
  offset: number;
}

// Read the FIRST `**Field**: value` line from one audit block (tolerates an
// optional leading `- ` so it serves both audit blocks and the state file).
// IMPORTANT: a duplicated field still returns only its first value. Do not
// build authenticate-then-re-read flows on this helper: a verifier and consumer
// can otherwise disagree about which occurrence, and therefore which bytes,
// they mean. Callers that require uniqueness must reject duplicates separately.
// Mirrors the per-tool private auditField readers; shared here for
// humanActedSinceGate.
export function auditBlockField(block: string, fieldName: string): string | null {
  const prefix = `**${fieldName}**:`;
  for (const raw of block.split("\n")) {
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

// This clone's audit shard filename: `<host>-<clone-id>.md`, both parts from the
// clone identity (see cloneIdentity). The clone-id token (not the PID) is the
// cross-clone disambiguator: stable across every process in a clone (so the
// fork process and the merge process resolve ONE shard) and distinct across
// clones (so concurrent clones never collide or git-conflict). The host is the
// one recorded at mint time, so it is the same in every process and on every
// machine the folder is copied to.
const AUDIT_SHARD_NAMES = new Map<string, string>();
function scopedAuditShardName(projectDir: string): string | null {
  const scoped = applicableTeamUnitScopeStamp(projectDir);
  return scoped?.audit_shard && /^[A-Za-z0-9._-]+\.md$/.test(scoped.audit_shard)
    ? scoped.audit_shard
    : null;
}

export function auditShardName(projectDir: string): string {
  const key = canonicalPathKey(projectDir);
  const scoped = scopedAuditShardName(projectDir);
  if (scoped) return scoped;
  const cached = AUDIT_SHARD_NAMES.get(key);
  if (cached) return cached;
  const identity = cloneIdentity(projectDir);
  const name = `${identity.host}-${identity.token}.md`;
  AUDIT_SHARD_NAMES.set(key, name);
  return name;
}

// This clone's shard name when it is already known, without minting a token or
// upgrading the clone-id file: readers use it to prefer their own shard, or to
// tell their own rows from other clones', and must not write. Null means this
// clone has written no shard yet.
export function knownAuditShardName(projectDir: string): string | null {
  const scoped = scopedAuditShardName(projectDir);
  if (scoped) return scoped;
  const cached = AUDIT_SHARD_NAMES.get(canonicalPathKey(projectDir));
  if (cached) return cached;
  try {
    const recorded = parseCloneIdFile(readFileSync(cloneIdPath(projectDir), "utf-8"));
    if (recorded.token) {
      const host = recorded.host ?? existingShardHost(projectDir, recorded.token) ?? auditShardHostSegment();
      return `${host}-${recorded.token}.md`;
    }
  } catch {
    // no clone identity yet
  }
  return null;
}

// Every audit shard selected by the caller (sorted). Normal intent readers stay
// intent-only, whether the intent is explicit or resolved from the active cursor.
// The deliberate `undefined intent + explicit space` form adds the space-level
// shard before the resolved intent shards; DocumentKB recovery and doctor/export
// use that form because space-level provenance is part of their read model.
// PRE-CREATION PARITY: when NO intent resolves at all, the space shard IS the
// ledger — the append side's auditFilePath falls back to it, so the read side
// must too, or a project with no intents yet reads an empty ledger where its
// own appends just landed (that broke 10 fixture suites when this narrowing
// first shipped without the fallback; base v2 always read the space shard in
// that state).
// Readers merge-sort parsed events by **Timestamp**.
export function auditShards(
  projectDir: string,
  intent?: string,
  space?: string,
  unreadableLocations?: string[],
  bind?: boolean,
): string[] {
  const dirs: string[] = [];
  if (intent === undefined && space !== undefined) {
    dirs.push(join(spaceRecordRoot(projectDir, space), "audit"));
  }
  const resolved = resolveRecordDir(projectDir, intent, space, bind);
  const intentDir =
    resolved.dir === null ? null : join(resolved.dir, "audit");
  if (intentDir !== null && !dirs.includes(intentDir)) dirs.push(intentDir);
  if (intentDir === null && dirs.length === 0) {
    dirs.push(join(spaceRecordRoot(projectDir, resolved.space), "audit"));
  }
  const paths: string[] = [];
  for (const shardDir of dirs) {
    try {
      assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, shardDir));
    } catch {
      unreadableLocations?.push(shardDir);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(shardDir);
    } catch {
      if (existsSync(shardDir)) unreadableLocations?.push(shardDir);
      continue;
    }
    for (const file of entries.sort()) {
      if (file.endsWith(".md")) paths.push(join(shardDir, file));
    }
  }
  // Explicit-space aggregation keeps the resolved intent last for the few
  // diagnostic paths that inspect the raw audit tail.
  return paths;
}

export interface AuditShardText {
  shard: string;
  content: string;
}

// Read the selected shards, keeping each one's index in `shards`. A vanished or
// refused shard is left out (and listed in `unreadable` when given).
export function readAuditShardTexts(
  projectDir: string,
  shards: readonly string[],
  unreadable?: string[],
): Array<AuditShardText & { shardIndex: number }> {
  const texts: Array<AuditShardText & { shardIndex: number }> = [];
  for (let shardIndex = 0; shardIndex < shards.length; shardIndex++) {
    try {
      const content = readAppendOnlyFileNoFollowOrThrow(shards[shardIndex], "audit shard").toString("utf-8");
      assertNoSymlinkInChainOrThrow(realpathSync(projectDir), relative(projectDir, shards[shardIndex]));
      texts.push({ shard: shards[shardIndex], content, shardIndex });
    } catch {
      unreadable?.push(shards[shardIndex]);
    }
  }
  return texts;
}

// The block sequence every shard parser walks; positions index into it.
// Exported so a reader outside this file (the Unit candidate walk and the
// publish-side projection in aidlc-unit.ts) splits a shard the same way rather
// than carrying its own copy of the grammar.
export function auditShardBlocks(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split(/\n---\n/);
}

// A shard file that a sync tool or a person copied (a "<shard> 2.md" conflict
// copy, a hand copy) repeats rows another shard already holds. Each copied row
// would tie with itself across two files, read as causally unordered, and stop
// every receipt stamped before the copy from counting. A copy starts with its
// source's first block (the file header and first row), so only files that
// start alike are compared, and a row two independent clones happen to write
// alike is never taken for a copy. Within such a group, a timestamped block
// found in two or more files is read ONCE, from the best of them: this clone's
// own shard, then a file with a shard name (`<host>-<token>.md`, so a conflict
// copy never lends its name or commit to a receipt), then the file with more
// timestamped blocks, then filename order.
// Repeats inside one file are not copies and stay. Returns, per shard, the
// block positions to skip. `ownShard` is only asked when a copy exists.
export const AUDIT_SHARD_FILE_RE = /^[a-z0-9][a-z0-9-]*-[a-z0-9]{1,32}\.md$/;

export function copiedAuditBlocks(
  shards: readonly AuditShardText[],
  ownShard: () => string | null,
): ReadonlySet<number>[] {
  const skip = shards.map(() => new Set<number>());
  if (shards.length < 2) return skip;
  const groups = new Map<string, number[]>();
  shards.forEach(({ content }, index) => {
    const end = content.search(/\r?\n---\r?\n/);
    const head = (end < 0 ? content : content.slice(0, end)).replace(/\r\n/g, "\n");
    if (auditBlockField(head, "Timestamp") === null) return;
    const members = groups.get(head);
    if (members) members.push(index);
    else groups.set(head, [index]);
  });
  let own: string | null | undefined;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    if (own === undefined) own = ownShard();
    const blocks = members.map((index) =>
      auditShardBlocks(shards[index].content).map((block) =>
        auditBlockField(block, "Timestamp") === null ? null : block
      )
    );
    const holders = new Map<string, Set<number>>();
    blocks.forEach((memberBlocks, member) => {
      for (const block of memberBlocks) {
        if (block === null) continue;
        const found = holders.get(block);
        if (found) found.add(member);
        else holders.set(block, new Set([member]));
      }
    });
    const counts = blocks.map((memberBlocks) => memberBlocks.filter((block) => block !== null).length);
    const isOwn = (member: number) => own !== null && basename(shards[members[member]].shard) === own;
    const isShardName = (member: number) => AUDIT_SHARD_FILE_RE.test(basename(shards[members[member]].shard));
    const order = members
      .map((_, member) => member)
      .sort((a, b) => {
        if (isOwn(a) !== isOwn(b)) return isOwn(a) ? -1 : 1;
        if (isShardName(a) !== isShardName(b)) return isShardName(a) ? -1 : 1;
        if (counts[a] !== counts[b]) return counts[b] - counts[a];
        return a - b;
      });
    const rank = new Map(order.map((member, position) => [member, position]));
    blocks.forEach((memberBlocks, member) => {
      memberBlocks.forEach((block, pos) => {
        const found = block === null ? undefined : holders.get(block);
        if (!found || found.size < 2) return;
        for (const holder of found) {
          if (rank.get(holder)! < rank.get(member)!) {
            skip[members[member]].add(pos);
            return;
          }
        }
      });
    });
  }
  return skip;
}

export interface AuditShardEvent {
  block: string;
  event: string;
  pos: number;
  shard: string;
  shardIndex: number;
  timestamp: string;
}

// Preserve shard identity while parsing audit rows. A concatenated audit buffer
// can preserve append order only within one shard; equal second-precision
// timestamps across shards are causally unordered and must not be resolved by
// filename position when authority or attempt freshness depends on the result.
// Split ONE shard's bytes into events, preserving append position. Factored out
// of readAuditShardEvents so a reader whose shard bytes do not come from the
// working tree shares this parser rather than reimplementing the block grammar:
// aidlc-attest.ts reads shards out of a git tree (`git cat-file`) to resolve a
// commit against the record as that commit carried it. Two copies of the
// `\n---\n` split and the Event/Timestamp filter would be free to drift, and a
// drifted audit parser silently changes which receipt counts as newest.
export function parseAuditShardEvents(
  content: string,
  shard: string,
  shardIndex: number,
  copied: ReadonlySet<number> = new Set(),
): AuditShardEvent[] {
  const rows: AuditShardEvent[] = [];
  const blocks = auditShardBlocks(content);
  for (let pos = 0; pos < blocks.length; pos++) {
    if (copied.has(pos)) continue;
    const event = auditBlockField(blocks[pos], "Event");
    const timestamp = auditBlockField(blocks[pos], "Timestamp");
    if (!event || !timestamp) continue;
    rows.push({ block: blocks[pos], event, pos, shard, shardIndex, timestamp });
  }
  return rows;
}

export function readAuditShardEvents(
  projectDir: string,
  intent?: string,
  space?: string,
  unreadableShards?: string[],
  bind?: boolean,
): AuditShardEvent[] {
  const shards = auditShards(
    projectDir,
    intent,
    space,
    unreadableShards,
    bind,
  );
  // A vanished or refused shard is skipped; growth during read is tolerated.
  const texts = readAuditShardTexts(projectDir, shards, unreadableShards);
  const copied = copiedAuditBlocks(texts, () => knownAuditShardName(projectDir));
  return texts.flatMap(({ shard, content, shardIndex }, index) =>
    parseAuditShardEvents(content, shard, shardIndex, copied[index])
  );
}

/**
 * `_` cannot occur in a Bolt slug, so intent-scoped and legacy names are disjoint.
 * Legacy names are read-only compatibility identities, resolved only by provenance;
 * newly created Bolts always use the selected intent's registry identity.
 */
export const BOLT_INTENT_ID8_REGEX = /^[0-9a-f]{8}$/;

export function boltName(intentId8: string, slug: string): string {
  return `bolt-${intentId8}_${slug}`;
}

export function legacyBoltName(slug: string): string {
  return `bolt-${slug}`;
}

export function worktreesDir(projectDir: string): string {
  return join(projectDir, ".aidlc", "worktrees");
}

export function worktreePath(projectDir: string, intentId8: string, slug: string): string {
  return join(worktreesDir(projectDir), boltName(intentId8, slug));
}

export function legacyWorktreePath(projectDir: string, slug: string): string {
  return join(worktreesDir(projectDir), legacyBoltName(slug));
}

export function resolveAuditProjectPath(
  projectDir: string,
  recordedPath: string,
): string {
  if (recordedPath === "<project-dir>") return resolvePath(projectDir);
  if (
    recordedPath.startsWith("<project-dir>/") ||
    recordedPath.startsWith("<project-dir>\\")
  ) {
    return resolvePath(
      projectDir,
      recordedPath.slice("<project-dir>".length + 1),
    );
  }
  return isAbsolute(recordedPath)
    ? recordedPath
    : resolvePath(projectDir, recordedPath);
}

export function resolveAuditWorktreePath(
  projectDir: string,
  recordedPath: string,
): string {
  return resolveAuditProjectPath(projectDir, recordedPath);
}

export function sortAttemptEvents<T extends AuditShardEvent>(
  rows: ReadonlyArray<T>,
): T[] {
  return [...rows].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shard === b.shard) return a.pos - b.pos;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

export function attemptEventDefinitelyBefore(
  earlier: AuditShardEvent,
  later: AuditShardEvent,
): boolean {
  if (earlier.shard === later.shard) return earlier.pos < later.pos;
  return earlier.timestamp < later.timestamp;
}

export function maximalAttemptEvents<T extends AuditShardEvent>(
  events: ReadonlyArray<T>,
): T[] {
  const maximal = events.filter(
    (candidate, index) =>
      !events.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          attemptEventDefinitelyBefore(candidate, other),
      ),
  );
  if (maximal.length > 0 || events.length === 0) return maximal;
  // "Definitely before" mixes two orders (append position inside a shard, timestamp
  // across shards) and is therefore not transitive: three rows can form a cycle in
  // which every row has something after it, and the filter above empties. An empty
  // frontier is the most dangerous answer available, because every "after the
  // frontier" test is an `every` call and passes vacuously, so no floor at all reads
  // as "everything is in this attempt". Fall back to the timestamp-maximal rows,
  // which is always non-empty and is the coarser of the two orders.
  let latest = events[0].timestamp;
  for (const event of events) if (event.timestamp > latest) latest = event.timestamp;
  return events.filter((event) => event.timestamp === latest);
}

export const UNIT_SCOPE_FILE = ".aidlc-unit-scope.json";

export interface UnitScopeStamp {
  version: 1;
  space: string;
  intent_uuid: string;
  intent_id8: string;
  unit: string;
  owner: string;
  generation: number;
  nonce: string;
  claim_ref: string;
  claim_oid: string;
  claimed_from_oid: string;
  integration_ref: string;
  gate_rhythm: "per-stage" | "unit-end";
  audit_shard?: string;
}

export function unitScopePath(projectDir: string): string {
  return join(workspaceRoot(projectDir), UNIT_SCOPE_FILE);
}

export function readUnitScopeStamp(projectDir: string): UnitScopeStamp | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(unitScopePath(projectDir), "utf-8"),
    );
    if (parsed === null || typeof parsed !== "object") return null;
    const stamp = parsed as Partial<UnitScopeStamp>;
    if (
      stamp.version !== 1 ||
      typeof stamp.space !== "string" ||
      typeof stamp.intent_uuid !== "string" ||
      typeof stamp.intent_id8 !== "string" ||
      typeof stamp.unit !== "string" ||
      typeof stamp.owner !== "string" ||
      !Number.isInteger(stamp.generation) ||
      (stamp.generation ?? 0) < 1 ||
      typeof stamp.nonce !== "string" ||
      typeof stamp.claim_ref !== "string" ||
      typeof stamp.claim_oid !== "string" ||
      typeof stamp.claimed_from_oid !== "string" ||
      typeof stamp.integration_ref !== "string" ||
      (stamp.gate_rhythm !== "per-stage" && stamp.gate_rhythm !== "unit-end") ||
      (stamp.audit_shard !== undefined &&
        (typeof stamp.audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(stamp.audit_shard)))
    ) {
      return null;
    }
    return stamp as UnitScopeStamp;
  } catch {
    return null;
  }
}

export function applicableTeamUnitScopeStamp(
  projectDir: string,
  stateContent?: string,
): UnitScopeStamp | null {
  let state = stateContent;
  try {
    state ??= readStateFile(projectDir);
  } catch {
    return null;
  }
  if (!isTeamUnitOwnership(state)) return null;
  const stamp = readUnitScopeStamp(projectDir);
  if (!stamp) return null;
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (
    !intentUuid ||
    stamp.space !== space ||
    stamp.intent_uuid !== intentUuid
  ) {
    return null;
  }
  if (scopeStampLanded(projectDir, state, stamp)) return null;
  return stamp;
}

// Bolt slug shape: lowercase letter, then lowercase letters / digits / hyphens.
// Centralised here (previously duplicated as SLUG_RE in aidlc-worktree.ts and
// SLUG_REGEX in aidlc-audit.ts) so a future tightening lands once. Stage and
// artifact slugs in stage-schema.ts are a separate domain and keep their own
// regex.
export const BOLT_SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
export const BOLT_SLUG_MAX_LENGTH = 64;

// Validate a Bolt slug against shape + length. Returns null on success or a
// human-readable error string on failure. Pure — callers route through their
// preferred error mechanism (jsonError, throw, etc.).
export function validateBoltSlug(slug: string): string | null {
  if (!slug) {
    return "Bolt slug is empty";
  }
  if (slug.length > BOLT_SLUG_MAX_LENGTH) {
    return `Bolt slug "${slug.slice(0, 32)}..." is ${slug.length} chars; max is ${BOLT_SLUG_MAX_LENGTH}`;
  }
  if (!BOLT_SLUG_REGEX.test(slug)) {
    return `Invalid Bolt slug "${slug}" - must match ${BOLT_SLUG_REGEX} (lowercase letter, then lowercase letters/digits/hyphens)`;
  }
  return null;
}

// The autonomous swarm composes Bolt/worktree primitives whose slug contract is
// deliberately narrower than the legacy Unit-name contract. Preserve modern
// lowercase kebab names byte-for-byte; map any other safe legacy Unit name to a
// deterministic, readable, collision-resistant internal slug. The original
// Unit name remains the user/audit identity.
export function boltSlugForUnit(name: string): string {
  const unitNameError = validateUnitName(name);
  if (unitNameError) throw new Error(unitNameError);
  if (validateBoltSlug(name) === null) return name;

  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  let stem = name
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(stem)) stem = `unit-${stem}`;
  stem = stem.slice(0, BOLT_SLUG_MAX_LENGTH - digest.length - 1).replace(/-+$/g, "");
  return `${stem}-${digest}`;
}

export function readStateFile(projectDir: string, intent?: string, space?: string): string {
  const path = stateFilePath(projectDir, intent, space);
  if (!existsSync(path)) {
    throw new Error(`State file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

export function writeStateFile(projectDir: string, content: string, intent?: string, space?: string): void {
  refuseEngineObserverWrite("writeStateFile");
  const path = stateFilePath(projectDir, intent, space);
  // A read-only aidlc-state.md is a deliberate write barrier the state tool
  // must honour (a corrupt/locked workspace must fail loud, not silently
  // advance — see the t47/t77 read-only-state failure-injection tests).
  // writeFileAtomic uses tmp+rename, and POSIX rename overwrites a read-only
  // TARGET (it only needs directory-write permission), so it would bypass that
  // barrier. Preserve the bare-writeFileSync EACCES semantics by refusing up
  // front when the target exists but is not writable.
  // The state as it was, for the state-write record only: read bounded and only
  // as a regular file; anything else skips the record, never the write.
  let previous: string | null = null;
  let recordable = true;
  if (existsSync(path)) {
    accessSync(path, fsConstants.W_OK);
    try {
      previous = readRegularFileNoFollowOrThrow(path, "state file", STATE_WRITES_MAX_STATE_BYTES).toString("utf-8");
    } catch {
      recordable = false;
    }
  }
  // Ensure the record dir's parent chain exists before the atomic write — a
  // per-intent record dir's parents (aidlc/spaces/<sp>/intents/<slug>-<id8>/)
  // may not exist yet on first write; the flat fallback's aidlc-docs/ is created
  // by the init scaffolder, but mkdir-recursive is idempotent so it's safe for
  // both layouts.
  else mkdirSync(dirname(path), { recursive: true });
  // Atomic write (tmp + rename) so a crash mid-write can never leave a
  // half-written state file a concurrent reader would see torn. Lost-update
  // safety for the read-modify-write handlers (withAuditLock wrapping) is a
  // separate, larger change tracked as a follow-up; this reroute is the
  // torn-write half and benefits every caller unconditionally.
  writeFileAtomic(path, content);
  if (recordable) recordStateWrite(path, previous, content);
}
//
// The last few writes that moved the state digest while a step was issued,
// beside the state in the engine dir (machine-local, gitignored): when, which
// AI-DLC command, and which state lines moved. A step out of date because the state moved names those
// writes, but only when the record accounts for every write between the step
// and now. Best effort: it never fails or slows a state write's outcome.
const STATE_WRITES_FILE = "state-writes.json";
const STATE_WRITES_KEPT = 8;
const STATE_WRITES_MAX_BYTES = 64 * 1024;
const STATE_WRITES_MAX_STATE_BYTES = 1024 * 1024;

export interface StateWrite {
  at: string; by: string; before: string; after: string; changed: string[];
}

// The record's path, or null when the engine dir beside the state is not a
// real directory: a link there could redirect every read and write elsewhere.
export function stateWritesPath(statePath: string): string | null {
  const engine = engineDirFor(dirname(statePath));
  try {
    return lstatSync(engine).isDirectory() ? join(engine, STATE_WRITES_FILE) : null;
  } catch {
    return null;
  }
}

// The command's own words (the tool file and its lowercase verbs), never its
// arguments: those can carry a person's text.
function stateWriterWords(): string | null {
  const words: string[] = [];
  for (const [index, arg] of process.argv.slice(1).entries()) {
    const word = index === 0 ? basename(arg) : arg;
    if (!/^[a-z][a-z0-9._-]{0,39}$/.test(word)) break;
    words.push(word);
    if (words.length === 4) break;
  }
  return words.length > 0 ? words.join(" ").slice(0, 80).trim() : null;
}

function stateLineLabel(line: string): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9 ._/()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const field = /^- \*\*([^*]+)\*\*:/.exec(line);
  const checkbox = /^\s*- \[[^\]]*\] ([a-z][a-z0-9-]*)/.exec(line);
  const label = field
    ? clean(field[1])
    : checkbox
      ? clean(`${checkbox[1]} checkbox`)
      : line.startsWith("## ")
        ? clean(`section ${line.slice(3)}`)
        : "";
  return /^[A-Za-z0-9]/.test(label) ? label : "other line";
}

function changedStateLines(before: string, after: string): string[] {
  const was = new Set(projectStateForDigest(before).split("\n"));
  const now = new Set(projectStateForDigest(after).split("\n"));
  const labels = new Set<string>();
  for (const line of now) if (!was.has(line)) labels.add(stateLineLabel(line));
  for (const line of was) if (!now.has(line)) labels.add(stateLineLabel(line));
  return [...labels].slice(0, OUT_OF_DATE_MAX_CHANGED);
}

export function readStateWrites(statePath: string): StateWrite[] {
  try {
    const path = stateWritesPath(statePath);
    if (path === null || !existsSync(path)) return [];
    // Bounded, regular files only: a link, FIFO or device here reads as no record.
    const bytes = readRegularFileNoFollowOrThrow(path, "state-write record", STATE_WRITES_MAX_BYTES);
    const parsed: unknown = JSON.parse(bytes.toString("utf-8"));
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is StateWrite =>
        isPlainObject(entry) && typeof entry.at === "string" && typeof entry.by === "string" &&
        OUT_OF_DATE_TEXT.test(entry.by) && /^[0-9a-f]{64}$/.test(String(entry.before)) &&
        /^[0-9a-f]{64}$/.test(String(entry.after)) && Array.isArray(entry.changed) &&
        entry.changed.every((line) => typeof line === "string" && OUT_OF_DATE_TEXT.test(line)))
      : [];
  } catch {
    return [];
  }
}

function recordStateWrite(statePath: string, previous: string | null, content: string): void {
  try {
    const before = stateDigest(previous ?? "");
    const after = stateDigest(content);
    const by = stateWriterWords();
    // A write that moved only the cache layer leaves every issued step current.
    if (before === after || by === null) return;
    // Only beside an issued step: with no marker there is no step to go out of
    // date, and the record never creates the first file in the engine dir.
    const path = stateWritesPath(statePath);
    if (path === null || !existsSync(join(dirname(path), ACTIVE_DIRECTIVE_MARKER))) return;
    const writes = [
      ...readStateWrites(statePath),
      { at: isoTimestamp(), by, before, after, changed: changedStateLines(previous ?? "", content) },
    ].slice(-STATE_WRITES_KEPT);
    writeFileAtomic(path, `${JSON.stringify(writes, null, 2)}\n`);
  } catch {
    // A diagnostic record never fails the state write it describes.
  }
}

// --- Field reading/writing ---

export function getField(content: string, field: string): string | null {
  // Match: - **Field Name**: value
  // Use [ \t]* instead of \s* so a field with an empty value returns "" (not
  // the next bullet line — \s matches \n in JS regex, which would let the
  // pattern cross into the next line).
  const regex = new RegExp(
    `^- \\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*(.*)$`,
    "m"
  );
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}
export const UNIT_OWNERSHIP_FIELD = "Unit Ownership";

export function isTeamUnitOwnership(stateContent: string | null): boolean {
  return !!stateContent && getField(stateContent, UNIT_OWNERSHIP_FIELD)?.trim() === "team";
}

export function setField(content: string, field: string, value: string): string {
  // [ \t]* instead of \s* so an empty value doesn't let the regex eat the
  // following line. .* with the m flag does not cross lines on its own, but
  // \s* preceding it would consume the trailing \n.
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  return content;
}

// --- Checkbox operations ---

export interface CheckboxLine {
  slug: string;
  state: CheckboxState;
  suffix: string; // e.g., "EXECUTE" or "SKIP: reason"
}

export function parseCheckboxes(content: string): CheckboxLine[] {
  const results: CheckboxLine[] = [];
  const regex = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    const marker = match[1];
    let state: CheckboxState;
    switch (marker) {
      case " ":
        state = "pending";
        break;
      case "-":
        state = "in-progress";
        break;
      case "?":
        state = "awaiting-approval";
        break;
      case "R":
        state = "revising";
        break;
      case "x":
        state = "completed";
        break;
      case "S":
        state = "skipped";
        break;
      default:
        state = "pending";
    }
    results.push({ slug: match[2], state, suffix: match[3].trim() });
    match = regex.exec(content);
  }
  return results;
}

export function setCheckbox(
  content: string,
  slug: string,
  newState: CheckboxState
): string {
  const marker = CHECKBOX_MAP[newState];
  // Match any checkbox state for this slug
  const regex = new RegExp(
    `^(- )\\[[ xSR?-]\\]( ${escapeRegex(slug)} —)`,
    "m"
  );
  return content.replace(regex, `$1${marker}$2`);
}

// --- Timestamp ---

export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

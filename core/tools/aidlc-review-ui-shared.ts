// aidlc-review-ui-shared.ts — the on-disk contract between the review UI daemon
// (aidlc-review-ui.ts), the session-start hook that spawns it, the engine's
// `report` step that publishes manifests/snapshots and ingests feedback, and
// the utility surfaces (--status/--doctor) that report on it.
//
// Dependency-free (node built-ins only) so hooks, the engine, and the daemon can
// all import it without cycles. Everything here is gated on AIDLC_REVIEW_UI=1;
// with the flag unset nothing below is ever called on a hot path.
//
// Layout (see docs/reference/19-review-ui-and-html-artifacts.md):
//   <REVIEW_HOME>/<project-id>/server.json         daemon discovery (home dir, never in the repo)
//   <REVIEW_HOME>/<project-id>/server.log          daemon stdout/stderr
//   <record>/.review-ui/current.json               pointer: which stage is under review
//   <stage-dir>/.review-ui/manifest.json           resolved artifact manifest for the held gate
//   <stage-dir>/.review-ui/snapshots/r<N>/<file>   artifact bytes at gate open (revision N)
//   <stage-dir>/.review-ui/feedback-<NNN>.md       browser feedback rounds (daemon-written)
//   <stage-dir>/.review-ui/answers-<NNN>.json      browser answer submissions (daemon-written; M3)
//   <stage-dir>/.review-ui/consumed.json           feedback/answers already ingested by the engine
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// --- Environment ---------------------------------------------------------------

export const ENV_REVIEW_UI = "AIDLC_REVIEW_UI";
export const ENV_REVIEW_PORT = "AIDLC_REVIEW_PORT";
export const ENV_REVIEW_HOST = "AIDLC_REVIEW_HOST";
export const ENV_REVIEW_OPEN = "AIDLC_REVIEW_OPEN";
export const ENV_REVIEW_IDLE_MINUTES = "AIDLC_REVIEW_IDLE_MINUTES";
export const ENV_REVIEW_HOME = "AIDLC_REVIEW_HOME";
export const ENV_HTML_ARTIFACTS = "AIDLC_HTML_ARTIFACTS";

export const DEFAULT_REVIEW_HOST = "127.0.0.1";
export const DEFAULT_IDLE_MINUTES = 240;
/** Daemon rewrites `heartbeat_at` this often; readers treat older than 4x as dead. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 4;

export function reviewUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_REVIEW_UI] === "1";
}

export function htmlArtifactsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_HTML_ARTIFACTS] === "1";
}

export function reviewUiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_REVIEW_HOME];
  if (override && override.trim() !== "") return resolve(override);
  return join(homedir(), ".aidlc", "review-ui");
}

// --- Project identity + daemon discovery ---------------------------------------

/** Stable per-project key: sha256 of the realpath, first 16 hex chars. */
export function reviewUiProjectId(projectDir: string): string {
  let real = resolve(projectDir);
  try {
    real = realpathSync(real);
  } catch {
    // Not yet on disk: hash the resolved path so callers get a stable answer.
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function reviewUiProjectHome(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(reviewUiHome(env), reviewUiProjectId(projectDir));
}

export function serverInfoPath(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(reviewUiProjectHome(projectDir, env), "server.json");
}

export function serverLogPath(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(reviewUiProjectHome(projectDir, env), "server.log");
}

/** One-time open capabilities live here as `<nonce>` files whose content is the expiry ISO time. */
export function noncesDir(projectDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(reviewUiProjectHome(projectDir, env), "nonces");
}

export interface ServerInfo {
  version: 1;
  pid: number;
  host: string;
  port: number;
  /** Tokenless origin with trailing slash, e.g. `http://localhost:47391/`. Never carries the token. */
  url: string;
  /** Long-lived bearer; lives only here (0600) and in the HttpOnly cookie the daemon sets. */
  token: string;
  project_dir: string;
  project_id: string;
  started_at: string;
  heartbeat_at: string;
  idle_minutes: number;
}

export function readServerInfo(projectDir: string, env: NodeJS.ProcessEnv = process.env): ServerInfo | null {
  const path = serverInfoPath(projectDir, env);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ServerInfo>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.heartbeat_at !== "string"
    ) {
      return null;
    }
    return parsed as ServerInfo;
  } catch {
    return null;
  }
}

/** server.json carries the bearer token: owner-only dir (0700) and file (0600). */
export function writeServerInfo(info: ServerInfo, env: NodeJS.ProcessEnv = process.env): void {
  atomicWriteJson(serverInfoPath(info.project_dir, env), info, { private: true });
}

export function removeServerInfo(projectDir: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(serverInfoPath(projectDir, env), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Synchronous liveness for hot paths (directive emission, --status): the pid
 * must be alive AND the heartbeat fresh. The daemon's /api/health is the
 * authoritative async check; callers that can await should prefer it.
 */
export function serverInfoLooksAlive(info: ServerInfo | null, now: number = Date.now()): info is ServerInfo {
  if (!info) return false;
  if (!pidAlive(info.pid)) return false;
  const beat = Date.parse(info.heartbeat_at);
  if (!Number.isFinite(beat)) return false;
  return now - beat <= HEARTBEAT_STALE_MS;
}

/** Tokenless origin of the live daemon, or null. Safe to print anywhere. */
export function liveReviewUiOrigin(projectDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const info = readServerInfo(projectDir, env);
  return serverInfoLooksAlive(info) ? info.url : null;
}

export const OPEN_NONCE_TTL_MS = 30 * 60_000;
const NONCE_RE = /^[0-9a-f]{32}$/;

export interface OpenLink {
  url: string;
  expires_at: string;
}

/**
 * Mint a TTL-bound `/open/<nonce>` link for a human to click. The nonce is a
 * 0600 file in the daemon's private dir; the daemon checks it and answers with
 * the HttpOnly session cookie. Printed links therefore never carry the
 * long-lived token, and a link copied out of a transcript dies after `ttlMs`.
 * Links are valid for repeated use inside the window so a re-rendered gate can
 * print the same link. ONLY mutating callers mint (report, --status, the
 * session-start hook, the daemon itself); read-only engine paths such as
 * `orchestrate next` read the stored link from `CurrentPointer.open` instead.
 * Returns null when no live daemon serves the project.
 */
export function mintReviewUiOpenLink(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  ttlMs: number = OPEN_NONCE_TTL_MS,
  now: number = Date.now(),
): OpenLink | null {
  const info = readServerInfo(projectDir, env);
  if (!serverInfoLooksAlive(info, now)) return null;
  const dir = noncesDir(projectDir, env);
  ensurePrivateDir(dir);
  sweepExpiredNonces(dir, now);
  const nonce = randomBytes(16).toString("hex");
  const expires_at = new Date(now + ttlMs).toISOString();
  writeFileSync(join(dir, nonce), expires_at, { mode: 0o600 });
  return { url: `${info.url}open/${nonce}`, expires_at };
}

/** Convenience for callers that only print: the URL of a fresh link, or null. */
export function mintReviewUiOpenUrl(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  ttlMs: number = OPEN_NONCE_TTL_MS,
  now: number = Date.now(),
): string | null {
  return mintReviewUiOpenLink(projectDir, env, ttlMs, now)?.url ?? null;
}

/** A stored link is printable only while unexpired; read-only paths use this. */
export function openLinkIsFresh(link: OpenLink | null | undefined, now: number = Date.now()): link is OpenLink {
  if (!link || typeof link.url !== "string") return false;
  const expiry = Date.parse(link.expires_at);
  return Number.isFinite(expiry) && now <= expiry;
}

/** Daemon side: true iff the nonce exists and is unexpired (multi-use inside its TTL). */
export function checkReviewUiOpenNonce(
  projectDir: string,
  nonce: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  if (!NONCE_RE.test(nonce)) return false;
  const path = join(noncesDir(projectDir, env), nonce);
  let expiry: number;
  try {
    expiry = Date.parse(readFileSync(path, "utf-8").trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(expiry) || now > expiry) {
    rmSync(path, { force: true });
    return false;
  }
  return true;
}

function sweepExpiredNonces(dir: string, now: number): void {
  for (const entry of readdirSync(dir)) {
    if (!NONCE_RE.test(entry)) continue;
    const path = join(dir, entry);
    let expiry = Number.NaN;
    try {
      expiry = Date.parse(readFileSync(path, "utf-8").trim());
    } catch {
      // Unreadable: treat as expired below.
    }
    if (!Number.isFinite(expiry) || now > expiry) rmSync(path, { force: true });
  }
}

// --- Record-side layout --------------------------------------------------------

export const REVIEW_UI_DIRNAME = ".review-ui";
export const CURRENT_POINTER_FILENAME = "current.json";
export const MANIFEST_FILENAME = "manifest.json";
export const CONSUMED_FILENAME = "consumed.json";
export const SNAPSHOTS_DIRNAME = "snapshots";
export const FEEDBACK_PREFIX = "feedback-";
export const ANSWERS_PREFIX = "answers-";

export function stageReviewUiDir(stageDir: string): string {
  return join(stageDir, REVIEW_UI_DIRNAME);
}

export function recordReviewUiDir(recordDir: string): string {
  return join(recordDir, REVIEW_UI_DIRNAME);
}

export function currentPointerPath(recordDir: string): string {
  return join(recordReviewUiDir(recordDir), CURRENT_POINTER_FILENAME);
}

export function manifestPath(stageDir: string): string {
  return join(stageReviewUiDir(stageDir), MANIFEST_FILENAME);
}

export function consumedPath(stageDir: string): string {
  return join(stageReviewUiDir(stageDir), CONSUMED_FILENAME);
}

export function snapshotDir(stageDir: string, revision: number): string {
  return join(stageReviewUiDir(stageDir), SNAPSHOTS_DIRNAME, `r${revision}`);
}

export type ArtifactFormat = "md" | "html";
export type ArtifactKind = "document" | "visual" | "machine";

export interface ReviewManifestArtifact {
  name: string;
  /** Project-relative POSIX path. */
  path: string;
  format: ArtifactFormat;
  kind: ArtifactKind;
  sha256: string | null;
  exists: boolean;
}

export type CurrentReviewState = "awaiting-approval" | "revising" | "approved" | "none";

export interface CurrentPointer {
  version: 1;
  state: CurrentReviewState;
  stage: string | null;
  unit: string | null;
  /** Project-relative POSIX path of the stage dir whose manifest is current. */
  stage_dir: string | null;
  revision: number;
  updated_at: string;
  /**
   * Open link minted by the mutating `report` step that wrote this pointer.
   * Read-only directive emission prints it while `openLinkIsFresh`.
   */
  open: OpenLink | null;
}

export interface ReviewManifest {
  version: 1;
  stage: string;
  phase: string;
  unit: string | null;
  /** State's Revision Count at gate open (0 on the first gate). */
  revision: number;
  opened_at: string;
  artifacts: ReviewManifestArtifact[];
  review_artifact: string | null;
  /** Project-relative POSIX path, when the stage has a questions file on disk. */
  questions_file: string | null;
  /** Project-relative POSIX path of `<slug>-questions-guide.html`, when present. */
  guide: string | null;
}

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readCurrentPointer(recordDir: string): CurrentPointer | null {
  return readJsonFile<CurrentPointer>(currentPointerPath(recordDir));
}

export function readManifest(stageDir: string): ReviewManifest | null {
  return readJsonFile<ReviewManifest>(manifestPath(stageDir));
}

// --- Feedback rounds -----------------------------------------------------------

export type DecisionHint = "approve" | "request-changes" | "none";

export interface FeedbackFrontmatter {
  aidlc_review_feedback: 1;
  stage: string;
  unit: string | null;
  revision: number;
  created: string;
  decision_hint: DecisionHint;
}

export interface FeedbackFile {
  file: string;
  frontmatter: FeedbackFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
  sha256: string;
}

export function feedbackFileName(n: number): string {
  return `${FEEDBACK_PREFIX}${String(n).padStart(3, "0")}.md`;
}

export function answersFileName(n: number): string {
  return `${ANSWERS_PREFIX}${String(n).padStart(3, "0")}.json`;
}

/** Next unused sequence number for `<prefix>NNN.<ext>` files in a dir (1-based). */
export function nextSequence(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix)) continue;
    const m = /^(\d{3,})\./.exec(entry.slice(prefix.length));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function renderFeedbackFrontmatter(fm: FeedbackFrontmatter): string {
  return [
    "---",
    `aidlc_review_feedback: 1`,
    `stage: ${fm.stage}`,
    `unit: ${fm.unit ?? "null"}`,
    `revision: ${fm.revision}`,
    `created: ${fm.created}`,
    `decision_hint: ${fm.decision_hint}`,
    "---",
    "",
  ].join("\n");
}

export function parseFeedbackFile(file: string, text: string): FeedbackFile | null {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (fields.aidlc_review_feedback !== "1" || !fields.stage) return null;
  const hint = fields.decision_hint;
  const decision_hint: DecisionHint =
    hint === "approve" || hint === "request-changes" ? hint : "none";
  const revision = Number(fields.revision);
  return {
    file,
    frontmatter: {
      aidlc_review_feedback: 1,
      stage: fields.stage,
      unit: !fields.unit || fields.unit === "null" ? null : fields.unit,
      revision: Number.isInteger(revision) ? revision : 0,
      created: fields.created ?? "",
      decision_hint,
    },
    body: text.slice(m[0].length),
    sha256: sha256Hex(text),
  };
}

export function listFeedbackFiles(stageDir: string): FeedbackFile[] {
  const dir = stageReviewUiDir(stageDir);
  if (!existsSync(dir)) return [];
  const out: FeedbackFile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.startsWith(FEEDBACK_PREFIX) || !entry.endsWith(".md")) continue;
    const parsed = parseFeedbackFile(entry, readFileSync(join(dir, entry), "utf-8"));
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface ConsumedEntry {
  file: string;
  sha256: string;
  consumed_at: string;
  result: "approved" | "rejected" | "answers-applied";
}

export interface ConsumedManifest {
  version: 1;
  entries: ConsumedEntry[];
}

export function readConsumed(stageDir: string): ConsumedManifest {
  return readJsonFile<ConsumedManifest>(consumedPath(stageDir)) ?? { version: 1, entries: [] };
}

export function writeConsumed(stageDir: string, manifest: ConsumedManifest): void {
  atomicWriteJson(consumedPath(stageDir), manifest);
}

/** Feedback files whose (name, sha256) pair has not been ingested yet. */
export function pendingFeedback(stageDir: string): FeedbackFile[] {
  const consumed = readConsumed(stageDir);
  const seen = new Set(consumed.entries.map((e) => `${e.file}\u0000${e.sha256}`));
  return listFeedbackFiles(stageDir).filter((f) => !seen.has(`${f.file}\u0000${f.sha256}`));
}

// --- Small utilities -----------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-filtered and ignored for pre-existing dirs; pin it.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Non-POSIX filesystems: best effort.
  }
}

/**
 * Write-then-rename. `private` pins the parent dir to 0700 and the file to
 * 0600 (for token-bearing files); otherwise the umask applies as usual.
 */
export function atomicWriteJson(path: string, value: unknown, options: { private?: boolean } = {}): void {
  const dir = dirname(path);
  if (options.private) ensurePrivateDir(dir);
  else mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, options.private ? { mode: 0o600 } : undefined);
  if (options.private) {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-POSIX filesystems: best effort.
    }
  }
  renameSync(tmp, path);
}

// --- Daemon lifecycle (caller side) -------------------------------------------

export interface SpawnOptions {
  /** Directory holding aidlc-review-ui.ts (the harness tools dir). */
  toolsDir: string;
  env?: NodeJS.ProcessEnv;
  /** Bun executable; defaults to the running runtime when it is bun. */
  bunPath?: string;
}

/**
 * Spawn the daemon fully detached (own session, stdio to the log file) and
 * return immediately. Survival across the parent's exit is the contract the
 * session-start hook relies on (verified: parent exit + process-group kill).
 */
export function spawnReviewUiDaemon(projectDir: string, options: SpawnOptions): number | null {
  const env = options.env ?? process.env;
  const script = join(options.toolsDir, "aidlc-review-ui.ts");
  if (!existsSync(script)) return null;
  const home = reviewUiProjectHome(projectDir, env);
  ensurePrivateDir(home);
  const log = openSync(serverLogPath(projectDir, env), "a", 0o600);
  try {
    const bun = options.bunPath ?? (process.versions.bun ? process.execPath : "bun");
    const child = spawn(bun, [script, "serve", "--project-dir", resolve(projectDir)], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...env },
      cwd: resolve(projectDir),
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    // The child holds its own copies; keeping ours open would pin the hook process.
    closeSync(log);
  }
}

/**
 * Idempotent: returns the live ServerInfo, spawning the daemon when none is
 * alive and waiting up to `waitMs` for it to publish server.json.
 */
export async function ensureReviewUiDaemon(
  projectDir: string,
  options: SpawnOptions & { waitMs?: number },
): Promise<ServerInfo | null> {
  const env = options.env ?? process.env;
  const existing = readServerInfo(projectDir, env);
  if (serverInfoLooksAlive(existing)) return existing;
  if (existing) removeServerInfo(projectDir, env);
  const pid = spawnReviewUiDaemon(projectDir, options);
  if (pid === null) return null;
  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (Date.now() < deadline) {
    const info = readServerInfo(projectDir, env);
    if (info && info.pid === pid) return info;
    await new Promise((r) => setTimeout(r, 50));
  }
  return readServerInfo(projectDir, env);
}

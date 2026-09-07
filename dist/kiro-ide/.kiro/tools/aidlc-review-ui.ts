#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
  type Stats,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactFormats } from "./aidlc-artifact-vocabulary.ts";
import {
  activeIntent,
  activeSpace,
  artifactFormatsForProject,
  artifactFormatsFromState,
  CHECKBOX_MAP,
  findStageBySlug,
  getField,
  humanTurnMintAllowed,
  isPerUnitStage,
  markHumanTurn,
  parseCheckboxes,
  readStateFile,
  spacesRoot,
  stageDir,
  type StageEntry,
  stateFilePath,
} from "./aidlc-lib.ts";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  ANSWERS_PREFIX,
  answersFileName,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_REVIEW_HOST,
  ENV_REVIEW_HOST,
  ENV_REVIEW_IDLE_MINUTES,
  ENV_REVIEW_OPEN,
  ENV_REVIEW_PORT,
  FEEDBACK_PREFIX,
  feedbackFileName,
  HEARTBEAT_INTERVAL_MS,
  consumeReviewUiOpenNonce,
  nextSequence,
  readCurrentPointer,
  readManifest,
  pendingAnswerFiles,
  pendingDecisions,
  listDecisionFiles,
  listFeedbackFiles,
  listResponsesFiles,
  readServerInfo,
  removeServerInfo,
  reviewUiHumanUrl,
  reviewUiProjectId,
  reviewUiStrict,
  serverInfoLooksAlive,
  sha256Hex,
  stageReviewUiDir,
  writeServerInfo,
  type CurrentPointer,
  type ReviewManifest,
  type ServerInfo,
} from "./aidlc-review-ui-shared.ts";
import {
  injectBridge,
  isReviewHiddenPath,
  lineDiff,
  parseQuestionsMarkdown,
  PathConfinementError,
  renderFeedbackMarkdown,
  renderMarkdown,
  resolveProjectAidlcPath,
  sandboxedMarkdownDocument,
  selfContainedMarkdownExport,
  splitMarkdownBlocks,
  validateQuestionAnswers,
  type AnswerSubmissionEntry,
  type FeedbackRequest,
  type ReviewAnnotation,
} from "./aidlc-review-ui-render.ts";
import { handleDecision } from "./aidlc-review-ui-decision.ts";
import { questionsRoundPublished, reviewUiRemarkFiles, workflowPayload, workflowSelection } from "./aidlc-review-ui-workflow.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ANSWERS_BODY_BYTES = 256 * 1024;
const WATCH_DEBOUNCE_MS = 150;
// Browser session cookie: renewed on every cookie-authenticated request so an
// in-use tab never lapses; invalid the moment the daemon restarts (new token).
const SESSION_COOKIE_MAX_AGE_S = 12 * 60 * 60;
// At a gate, a tab that reloaded or reconnected within this window still counts
// as present; only a genuinely absent browser triggers auto-open.
const AUTO_OPEN_GRACE_MS = 10_000;
// Artifact documents (HTML and rendered Markdown) run in an opaque-origin
// sandbox with every network direction closed; `'self'` admits only the
// daemon's own asset route (mermaid) for scripts.
const RAW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; font-src data:; frame-ancestors 'self'";
// The privileged app shell: no inline scripts, same-origin everything, no
// plugins, no forms, and only same-origin frames (the artifact sandbox).
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const ASSET_ROOT = join(import.meta.dir, "data", "review-ui");

const USAGE = `Usage: aidlc-review-ui.ts <command> [options]

Commands:
  serve --project-dir <absolute-path>  Run the review UI daemon in the foreground
  status [--project-dir <path>] [--json]
  stop [--project-dir <path>]
  open [--project-dir <path>]

Options:
  --help                            Show this help
`;

/**
 * Shown only when the first hop could not be trusted: strict mode, a browser
 * without Fetch Metadata, or a consumed link. A human who typed the URL and a
 * human whose link was consumed need different guidance. The page is
 * unauthenticated, so it names only the harness command — never a filesystem path.
 */
function forbiddenPage(reason: "no-session" | "link-consumed"): Response {
  const lead = reason === "no-session"
    ? "This browser has no review session yet, and this address cannot start one here (strict mode, or a browser without Fetch Metadata); you need a single-use link."
    : "This review link expired or was already used.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Review UI access required</title></head><body><main><h1>Review UI access required</h1><p>${lead}</p><p>Run <code>/aidlc --status</code> in your harness for a fresh link.</p></main></body></html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function usageError(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

function parseArgs(argv: string[]): {
  command: string;
  projectDir: string;
  asJson: boolean;
} {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const command = argv[0];
  if (!new Set(["serve", "status", "stop", "open"]).has(command)) {
    usageError(`Unknown command: ${command}`);
  }
  let projectDir = process.cwd();
  let projectSeen = false;
  let asJson = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--project-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) usageError("--project-dir requires a path");
      projectDir = resolve(value);
      projectSeen = true;
    } else if (arg === "--json" && command === "status") {
      asJson = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }
  if (command === "serve" && !projectSeen) usageError("serve requires --project-dir");
  if (command === "serve" && !isAbsolute(argv[argv.indexOf("--project-dir") + 1] ?? "")) {
    usageError("serve --project-dir must be absolute");
  }
  return { command, projectDir, asJson };
}

// One address a human can remember. Unset: the daemon takes the first free port
// from 4765 upward (ten tries — a second project's daemon lands on 4766, and so
// on), then falls back to an ephemeral port. `AIDLC_REVIEW_PORT=<n>` pins that
// exact port; `AIDLC_REVIEW_PORT=0` asks for an ephemeral one.
export const DEFAULT_REVIEW_PORT = 4765;
const DEFAULT_PORT_TRIES = 10;

function parsePort(): { pinned: number | null; ephemeral: boolean } {
  const raw = process.env[ENV_REVIEW_PORT];
  if (raw === undefined || raw.trim() === "") return { pinned: null, ephemeral: false };
  if (raw.trim() === "0") return { pinned: null, ephemeral: true };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${ENV_REVIEW_PORT} must be an integer from 0 to 65535`);
  }
  return { pinned: port, ephemeral: false };
}

function portCandidates(choice: { pinned: number | null; ephemeral: boolean }): number[] {
  if (choice.pinned !== null) return [choice.pinned];
  if (choice.ephemeral) return [0];
  return [...Array.from({ length: DEFAULT_PORT_TRIES }, (_, index) => DEFAULT_REVIEW_PORT + index), 0];
}

function isAddressInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String((error as Error)?.message ?? ""));
}

function isWildcard(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare === "0.0.0.0" || bare === "::";
}

/**
 * IPv4 loopback is always bound so the local human's address never changes. A
 * configured address is bound as well (including `::1`, a distinct socket); a
 * wildcard already includes loopback, so it is bound alone.
 */
export function bindHostsFor(configured: string | undefined): string[] {
  const host = configured?.trim().replace(/^\[|\]$/g, "");
  if (!host || host === DEFAULT_REVIEW_HOST || host.toLowerCase() === "localhost") return [DEFAULT_REVIEW_HOST];
  if (isWildcard(host)) return [host];
  return [DEFAULT_REVIEW_HOST, host];
}

/**
 * Bun reports every failed listen as EADDRINUSE, so an address this machine
 * does not have would otherwise walk every port candidate and then blame the
 * last port. An ephemeral bind on the configured address separates the cases.
 */
function assertBindable<T extends { stop(force?: boolean): unknown }>(serveOn: (host: string, port: number) => T, hosts: string[]): void {
  for (const host of hosts) {
    if (host === DEFAULT_REVIEW_HOST) continue;
    try {
      serveOn(host, 0).stop(true);
    } catch {
      throw new Error(`${ENV_REVIEW_HOST}=${host}: cannot listen on this address (not an address of this machine?)`);
    }
  }
}

/** Bind every host on one port, or throw the first EADDRINUSE after closing what was opened. */
function bindAll<T extends { stop(force?: boolean): unknown }>(serveOn: (host: string, port: number) => T, hosts: string[], port: number): T[] {
  const started: T[] = [];
  try {
    for (const host of hosts) {
      // With an ephemeral request, later hosts must take the port the first one got.
      const actualPort = port === 0 && started.length > 0 ? ((started[0] as { port?: number }).port ?? 0) : port;
      started.push(serveOn(host, actualPort));
    }
    return started;
  } catch (error) {
    for (const instance of started) instance.stop(true);
    throw error;
  }
}

function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) out.push(entry.address);
    }
  }
  return out;
}

function bindFirstFree<T>(serveOn: (port: number) => T, candidates: number[]): T {
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return serveOn(candidate);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("no port available for the review UI daemon");
}

function parseIdleMinutes(): number {
  const raw = process.env[ENV_REVIEW_IDLE_MINUTES];
  if (!raw) return DEFAULT_IDLE_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${ENV_REVIEW_IDLE_MINUTES} must be a positive number`);
  }
  return value;
}

function urlHost(bindHost: string): string {
  if (bindHost === "127.0.0.1") return "localhost";
  return bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
}

function cookieToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const item of cookie.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (name === "aidlc_review") return rest.join("=");
  }
  return null;
}

function authenticated(request: Request, token: string): boolean {
  return request.headers.get("X-AIDLC-Token") === token || cookieToken(request) === token;
}

/** Set-Cookie value for the browser session; used on the nonce exchange and on every renewal. */
function sessionCookie(token: string): string {
  return `aidlc_review=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;
}

/** Re-issue the session cookie on a cookie-authenticated response (sliding renewal). */
function withSessionCookie(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie(token));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * First-hop trust without a link: the browser itself vouches for a
 * user-initiated top-level navigation. `Sec-Fetch-Site: none` (typed URL,
 * bookmark, reload, `open` from the terminal) or `same-origin` cannot be forged
 * by a page on another site — its navigations arrive as `cross-site` — and a
 * DNS-rebinding attempt arrives with a foreign `Host`. Browsers without Fetch
 * Metadata fail closed to the nonce-link path. Non-browser local processes can
 * forge these headers, but they are the same user and already hold the files.
 */
function browserNavigationTrusted(request: Request, allowedHosts: ReadonlySet<string>): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== "none" && site !== "same-origin") return false;
  if (request.headers.get("sec-fetch-mode") !== "navigate") return false;
  if (request.headers.get("sec-fetch-dest") !== "document") return false;
  const host = request.headers.get("host")?.toLowerCase();
  return host !== undefined && allowedHosts.has(host);
}

function appShellResponse(): Response {
  const index = join(ASSET_ROOT, "index.html");
  if (!existsSync(index)) throw new HttpError(404, "app shell not found");
  return new Response(Bun.file(index), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": APP_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function mimeType(path: string): string {
  const mimeByExtension: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return mimeByExtension[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function containedAsset(pathname: string): string | null {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice("/assets/".length));
  } catch {
    return null;
  }
  if (!relativePath || relativePath.includes("\\") || relativePath.split("/").includes("..")) return null;
  const candidate = resolve(ASSET_ROOT, ...relativePath.split("/"));
  const rel = relative(ASSET_ROOT, candidate);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return null;
  try {
    const realRoot = realpathSync(ASSET_ROOT);
    const realCandidate = realpathSync(candidate);
    const realRel = relative(realRoot, realCandidate);
    if (realRel.startsWith(`..${sep}`) || realRel === ".." || isAbsolute(realRel)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function posixRelative(projectDir: string, path: string): string {
  return relative(projectDir, path).split(sep).join("/");
}

interface StateContext {
  projectDir: string;
  space: string;
  intent: string | null;
  record: string;
  state: string | null;
  formats: ArtifactFormats;
  current: CurrentPointer | null;
  manifest: ReviewManifest | null;
}

function selectionFromUrl(url: URL): { intent?: string; space?: string } {
  const intent = url.searchParams.get("intent")?.trim();
  const space = url.searchParams.get("space")?.trim();
  return {
    ...(intent ? { intent } : {}),
    ...(space ? { space } : {}),
  };
}

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

// The intent's record, plus the stage dir its own review pointer names: codekb
// stages (reverse-engineering) publish into the space-level codekb tree, which
// is the intent's current review surface even though it sits outside the record.
function pathWithinRecord(path: string, context: StateContext): string {
  let recordReal: string;
  try {
    recordReal = realpathSync(context.record);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (within(recordReal, path)) return path;
  const pointerDir = context.current?.stage_dir;
  if (pointerDir) {
    try {
      const stageReal = realpathSync(join(context.projectDir, ...pointerDir.split("/")));
      const aidlcReal = realpathSync(join(context.projectDir, "aidlc"));
      if (within(aidlcReal, stageReal) && stageReal !== aidlcReal && within(stageReal, path)) return path;
    } catch {
      // fall through to the 403 below
    }
  }
  throw new HttpError(403, "path is outside the selected intent");
}
function stateContext(
  projectDir: string,
  selectionOptions: { intent?: string | null; space?: string | null } = {},
): StateContext {
  const selection = workflowSelection(projectDir, selectionOptions);
  const { space, intent, record } = selection;
  let state: string | null = null;
  try {
    state = readStateFile(projectDir, intent ?? undefined, space);
  } catch {
    // A daemon may start before the first workflow; state stays nullable.
  }
  const current = readCurrentPointer(record);
  let manifest: ReviewManifest | null = null;
  if (current?.stage_dir) {
    try {
      // resolveProjectAidlcPath already confines to aidlc/; the pointer's stage
      // dir may sit in the record or in the space-level codekb tree.
      const stagePath = resolveProjectAidlcPath(projectDir, current.stage_dir);
      manifest = readManifest(stagePath);
    } catch {
      manifest = null;
    }
  }
  const formats = state !== null
    ? artifactFormatsFromState(state)
    : artifactFormatsForProject(projectDir, intent ?? undefined, space);
  return { projectDir, space, intent, record, state, formats, current, manifest };
}

interface QuestionsTarget {
  file: string;
  /** The explainer, as published by the round record (`check --guide` passed). */
  guide: string | null;
  /** The round record publishes this exact questions file: the form may be shown. */
  ready: boolean;
  /**
   * Open answers, no published round: the agent is still writing the explainer
   * (or the file changed since it was published). Spinner, never a form.
   */
  preparing: boolean;
  /** An unconsumed browser submission exists for the published round. */
  submitted: boolean;
  stage: string;
  stage_dir: string;
  questionsPath: string;
  stagePath: string;
}

function currentQuestionsTarget(projectDir: string, context = stateContext(projectDir)): QuestionsTarget | null {
  const currentStage = context.state ? getField(context.state, "Current Stage") : null;
  if (!currentStage) return null;

  let stage: StageEntry | undefined;
  try {
    stage = findStageBySlug(currentStage);
  } catch {
    // Source-tree daemon fixtures may not carry compiled graph data yet.
    return null;
  }
  if (!stage || isPerUnitStage(stage)) return null;

  const stagePath = stageDir(
    projectDir,
    stage.phase,
    stage.slug,
    context.intent ?? undefined,
    context.space,
  );
  const stageRelative = posixRelative(projectDir, stagePath);
  const file = `${stageRelative}/${stage.slug}-questions.md`;
  let questionsPath: string;
  try {
    questionsPath = resolveProjectAidlcPath(projectDir, file);
    regularFile(questionsPath);
  } catch (error) {
    if (error instanceof PathConfinementError) throw error;
    return null;
  }

  // The round record decides. `aidlc-html.ts check --guide` publishes the
  // round when the explainer passes; the daemon does not re-run that check.
  const questionsSource = readFileSync(questionsPath, "utf-8");
  const sha256 = sha256Hex(questionsSource);
  const open = parseQuestionsMarkdown(questionsSource)
    .filter((question) => !question.confirmation)
    .some((question) => question.answer === null || question.answer.trim() === "");
  const ready = questionsRoundPublished(context.current, stage.slug, sha256);
  const guide = ready ? context.current?.guide ?? null : null;
  const submitted = ready && pendingAnswerFiles(stagePath, sha256).length > 0;
  return {
    file,
    guide,
    ready,
    preparing: !ready && open,
    submitted,
    stage: stage.slug,
    stage_dir: stageRelative,
    questionsPath,
    stagePath: realpathSync(stagePath),
  };
}

/**
 * The one word the browser renders. Every header label, Save button, "needs
 * you" count and tab steer reads this; nothing else in the client decides.
 */
export type HumanPhase = "preparing" | "questions" | "confirming" | "reviewing" | "revising" | "working" | "done" | "idle";

function humanPhase(context: ReturnType<typeof stateContext>, questions: QuestionsTarget | null): HumanPhase {
  const state = context.state;
  const current = context.current;
  const currentStage = state ? getField(state, "Current Stage") : null;
  if (state && /^completed?$/i.test(getField(state, "Status") ?? "")) return "done";
  if (current?.stage && current.stage === currentStage) {
    if (current.state === "questions" && questions?.ready) return "questions";
    if (current.state === "confirming") return "confirming";
    if (current.state === "awaiting-approval") return "reviewing";
    if (current.state === "revising") return "revising";
  }
  if (questions?.preparing) return "preparing";
  const checkbox = state && currentStage ? parseCheckboxes(state).find((entry) => entry.slug === currentStage) : undefined;
  return checkbox?.state === "in-progress" || checkbox?.state === "pending" ? "working" : "idle";
}

function stageMarker(state: string | null, currentStage: string | null): string | null {
  if (!state || !currentStage) return null;
  const checkbox = parseCheckboxes(state).find((entry) => entry.slug === currentStage);
  return checkbox ? CHECKBOX_MAP[checkbox.state] : null;
}

function statePayload(projectDir: string): Record<string, unknown> {
  const context = stateContext(projectDir);
  const revisionValue = context.state ? getField(context.state, "Revision Count") : null;
  const revision = revisionValue === null ? null : Number(revisionValue);
  const currentStage = context.current?.stage ?? (context.state ? getField(context.state, "Current Stage") : null);
  const questions = currentQuestionsTarget(projectDir, context);
  const gateStageDir = context.current?.stage_dir ? (() => { try { return resolveProjectAidlcPath(projectDir, context.current!.stage_dir!); } catch { return null; } })() : null;
  const decisionSent = context.current?.state === "awaiting-approval" && gateStageDir
    ? pendingDecisions(gateStageDir).find((item) =>
        item.submission.stage === context.current!.stage &&
        item.submission.unit === (context.current!.unit ?? null) &&
        item.submission.revision === context.current!.revision)?.submission.decision ?? null
    : null;
  return {
    project_dir: projectDir,
    phase: humanPhase(context, questions),
    /** The decision already recorded for the open gate ("approve" | "request-changes"), until the hook delivers it. */
    decision_sent: decisionSent,
    space: context.space,
    intent: context.intent,
    record_dir: posixRelative(projectDir, context.record),
    current: context.current,
    manifest: context.manifest,
    // The workflow's own notion of the stage, so the header can name it during
    // question rounds and authoring — before any gate has published a pointer.
    current_stage: currentStage,
    stage_status: stageMarker(context.state, currentStage),
    revision_count: revision !== null && Number.isInteger(revision) ? revision : null,
    html_artifacts: context.formats.html.size > 0,
    questions: questions === null
      ? null
      : {
          file: questions.file,
          guide: questions.guide,
          ready: questions.ready,
          preparing: questions.preparing,
          submitted: questions.submitted,
          stage: questions.stage,
          stage_dir: questions.stage_dir,
        },
  };
}

function treePayload(projectDir: string, url?: URL): { entries: Array<Record<string, unknown>> } {
  const { record } = stateContext(projectDir, url ? selectionFromUrl(url) : {});
  const entries: Array<Record<string, unknown>> = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (isReviewHiddenPath(posixRelative(record, path))) continue;
      let stat: Stats;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) continue;
      entries.push({
        path: posixRelative(projectDir, path),
        type: entry.isDirectory() ? "dir" : "file",
        size: entry.isFile() ? stat.size : 0,
        mtime: stat.mtimeMs,
      });
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(record);
  entries.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  return { entries };
}

/**
 * Reviewer-visible file: confined to the selected intent's record AND not one of
 * the engine's bookkeeping files (state, audit, dot-dirs). Everything the UI
 * renders for a human goes through here.
 */
function reviewableFile(projectDir: string, requested: string, url?: URL): string {
  const path = resolveProjectAidlcPath(projectDir, requested);
  const context = stateContext(projectDir, url ? selectionFromUrl(url) : {});
  pathWithinRecord(path, context);
  // Relative to the aidlc/ root (a parent of both the record and the codekb
  // tree) so the hidden-segment rule never sees a spurious `..`.
  const relativeToRoot = posixRelative(realpathSync(join(projectDir, "aidlc")), path);
  if (isReviewHiddenPath(relativeToRoot)) {
    throw new HttpError(403, "not a reviewable artifact");
  }
  regularFile(path);
  return path;
}

function queryPath(url: URL, name = "path"): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `missing ${name}`);
  return value;
}

function confinedPath(projectDir: string, url: URL, name = "path"): string {
  return resolveProjectAidlcPath(projectDir, queryPath(url, name));
}

function regularFile(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(404, "not found");
}

function requireQuestionsTarget(
  projectDir: string,
  requested: string,
  path: string,
  context = stateContext(projectDir),
): QuestionsTarget {
  const target = currentQuestionsTarget(projectDir, context);
  if (target === null || requested !== target.file || path !== target.questionsPath) {
    throw new HttpError(409, "questions target no longer current");
  }
  return target;
}

function questionsResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const path = reviewableFile(projectDir, requested, url);
  if (extname(path).toLowerCase() !== ".md") throw new HttpError(404, "not found");
  const target = requireQuestionsTarget(projectDir, requested, path, stateContext(projectDir, selectionFromUrl(url)));
  const source = readFileSync(path);
  return json({
    path: target.file,
    sha256: sha256Hex(source),
    stage: target.stage,
    questions: parseQuestionsMarkdown(new TextDecoder().decode(source)),
  });
}

function artifactResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const path = reviewableFile(projectDir, requested, url);
  const stat = statSync(path);
  const extension = extname(path).toLowerCase();
  const source = readFileSync(path, "utf-8");
  const selection = selectionFromUrl(url);
  const rawUrl = new URLSearchParams({ path: requested, ...selection });
  // Both formats render inside the sandboxed iframe via /api/raw; the app only
  // ever receives Markdown SOURCE (for the editor and line estimates), never
  // rendered HTML to inject into its own privileged document.
  if (extension === ".md" || extension === ".markdown") {
    return json({
      path: requested,
      format: "md",
      source,
      raw_url: `/api/raw?${rawUrl}`,
      sha256: sha256Hex(source),
      mtime: stat.mtimeMs,
    });
  }
  if (extension === ".html" || extension === ".htm") {
    return json({
      path: requested,
      format: "html",
      raw_url: `/api/raw?${rawUrl}`,
      sha256: sha256Hex(source),
      mtime: stat.mtimeMs,
    });
  }
  throw new HttpError(404, "unsupported artifact");
}

function headingText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}


function headingIdBase(html: string): string {
  const text = headingText(html);
  const base = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return base || "section";
}
function renderResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const path = reviewableFile(projectDir, requested, url);
  const extension = extname(path).toLowerCase();
  if (extension !== ".md" && extension !== ".markdown") {
    throw new HttpError(404, "not found");
  }
  const source = readFileSync(path, "utf-8");
  const stat = statSync(path);
  const headingCounts = new Map<string, number>();
  const headings: Array<{ level: number; text: string; id: string; block: number }> = [];
  const blocks = splitMarkdownBlocks(source).map((block, index) => {
    let html = renderMarkdown(block.text);
    html = html.replace(
      /<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g,
      (_match, levelText: string, _localId: string, children: string) => {
        const baseId = headingIdBase(children);
        const count = headingCounts.get(baseId) ?? 0;
        headingCounts.set(baseId, count + 1);
        const id = count === 0 ? baseId : `${baseId}-${count + 1}`;
        headings.push({ level: Number(levelText), text: headingText(children), id, block: index });
        return `<h${levelText} id="${id}">${children}</h${levelText}>`;
      },
    );
    return { index, line_start: block.line_start, line_end: block.line_end, html };
  });
  return json({
    path: requested,
    format: "md",
    sha256: sha256Hex(source),
    mtime: stat.mtimeMs,
    source,
    blocks,
    headings,
  });
}

// Renders one Markdown fragment (a block the reviewer is suggesting) with the
// same sanitized pipeline as /api/render, so the browser can show a suggested
// edit in place as rendered tracked changes rather than as raw source.
async function renderFragmentResponse(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const source = (parsed as { source?: unknown } | null)?.source;
  if (typeof source !== "string") throw new HttpError(400, "source must be a string");
  if (source.length > 200_000) throw new HttpError(413, "fragment too large");
  return json({ html: renderMarkdown(source) });
}

function rawResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const path = reviewableFile(projectDir, requested, url);
  const extension = extname(path).toLowerCase();
  let document: string;
  if (extension === ".html" || extension === ".htm") {
    document = readFileSync(path, "utf-8");
  } else if (extension === ".md" || extension === ".markdown") {
    document = sandboxedMarkdownDocument(readFileSync(path, "utf-8"), basename(path));
  } else {
    throw new HttpError(404, "not found");
  }
  return new Response(injectBridge(document), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": RAW_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function selectedStageContext(projectDir: string, url?: URL): {
  current: CurrentPointer;
  manifest: ReviewManifest;
  stageDir: string;
  context: StateContext;
} {
  const context = stateContext(projectDir, url ? selectionFromUrl(url) : {});
  if (!context.current?.stage_dir) throw new HttpError(409, "no current review");
  const stageDir = resolveProjectAidlcPath(projectDir, context.current.stage_dir);
  pathWithinRecord(stageDir, context);
  const manifest = context.manifest ?? readManifest(stageDir);
  if (!manifest) throw new HttpError(409, "no current manifest");
  return { current: context.current, manifest, stageDir, context };
}

function parseRevision(raw: string | null): number {
  const revision = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(revision) || revision < 0) throw new HttpError(400, "invalid revision");
  return revision;
}

function snapshotFile(projectDir: string, stageRelative: string, revision: number, file: string): string {
  if (!file || file !== basename(file) || file === "." || file === "..") {
    throw new PathConfinementError();
  }
  return resolveProjectAidlcPath(
    projectDir,
    `${stageRelative}/.review-ui/snapshots/r${revision}/${file}`,
  );
}

function snapshotsResponse(projectDir: string, url: URL): Response {
  const stageRelative = queryPath(url, "stage_dir");
  const context = stateContext(projectDir, selectionFromUrl(url));
  const stageDir = pathWithinRecord(resolveProjectAidlcPath(projectDir, stageRelative), context);
  const snapshots = join(stageDir, ".review-ui", "snapshots");
  if (!existsSync(snapshots)) return json({ revisions: [] });
  const revisions = readdirSync(snapshots, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^r\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(1)))
    .sort((left, right) => left - right);
  return json({ revisions });
}

function snapshotResponse(projectDir: string, url: URL): Response {
  const stageRelative = queryPath(url, "stage_dir");
  const context = stateContext(projectDir, selectionFromUrl(url));
  pathWithinRecord(resolveProjectAidlcPath(projectDir, stageRelative), context);
  const revision = parseRevision(url.searchParams.get("revision"));
  const path = snapshotFile(projectDir, stageRelative, revision, queryPath(url, "file"));
  regularFile(path);
  return json({ source: readFileSync(path, "utf-8") });
}

function diffResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const context = stateContext(projectDir, selectionFromUrl(url));
  const currentPath = reviewableFile(projectDir, requested, url);
  const { current, manifest } = selectedStageContext(projectDir, url);
  const artifact = manifest.artifacts.find((entry) => entry.path === requested);
  if (!artifact) throw new HttpError(404, "artifact is not in the current manifest");
  if (!current.stage_dir) throw new HttpError(409, "no current review");
  pathWithinRecord(resolveProjectAidlcPath(projectDir, current.stage_dir), context);
  const from = parseRevision(url.searchParams.get("from"));
  const toRaw = url.searchParams.get("to") ?? "current";
  const beforePath = snapshotFile(projectDir, current.stage_dir, from, basename(requested));
  regularFile(beforePath);
  const afterPath = toRaw === "current"
    ? currentPath
    : snapshotFile(projectDir, current.stage_dir, parseRevision(toRaw), basename(requested));
  regularFile(afterPath);
  return json(lineDiff(readFileSync(beforePath, "utf-8"), readFileSync(afterPath, "utf-8"), {
    before: `a/${basename(requested)}@r${from}`,
    after: toRaw === "current" ? `b/${basename(requested)}@current` : `b/${basename(requested)}@r${toRaw}`,
  }));
}

function selectedStageDir(projectDir: string, url: URL): string {
  const stageRelative = queryPath(url, "stage_dir");
  const context = stateContext(projectDir, selectionFromUrl(url));
  return pathWithinRecord(resolveProjectAidlcPath(projectDir, stageRelative), context);
}

function responsesResponse(projectDir: string, url: URL): Response {
  const stageDir = selectedStageDir(projectDir, url);
  const entries = listResponsesFiles(stageDir).flatMap((file) =>
    file.entries.map((entry) => ({
      ...entry,
      revision: file.revision,
      file: file.file,
    })),
  );
  return json({ entries });
}

function fileMtimeIso(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function remarksResponse(projectDir: string, url: URL): Response {
  return json({ entries: reviewUiRemarkFiles(selectedStageDir(projectDir, url)) });
}

function historyResponse(projectDir: string, url: URL): Response {
  const stageDir = selectedStageDir(projectDir, url);
  const reviewDir = join(stageDir, ".review-ui");
  const entries: Array<{
    kind: "revision" | "feedback" | "answers" | "decision" | "responses";
    revision?: number;
    file: string;
    at: string;
    by: "agent" | "you";
    summary: string;
    chars_delta?: number;
  }> = [];

  const snapshots = join(reviewDir, "snapshots");
  if (existsSync(snapshots)) {
    for (const entry of readdirSync(snapshots, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^r\d+$/.test(entry.name)) continue;
      const revision = Number(entry.name.slice(1));
      entries.push({
        kind: "revision",
        revision,
        file: entry.name,
        at: fileMtimeIso(join(snapshots, entry.name)),
        by: "agent",
        summary: `Revision ${revision} written`,
      });
    }
  }
  for (const feedback of listFeedbackFiles(stageDir)) {
    const remarkCount = feedback.remarks.length > 0
      ? feedback.remarks.length
      : (feedback.body.match(/^###\s+/gm) ?? []).length;
    entries.push({
      kind: "feedback",
      revision: feedback.frontmatter.revision,
      file: feedback.file,
      at: feedback.frontmatter.created || fileMtimeIso(join(reviewDir, feedback.file)),
      by: "you",
      summary: `${remarkCount} ${remarkCount === 1 ? "remark" : "remarks"} sent`,
    });
  }
  for (const decision of listDecisionFiles(stageDir)) {
    entries.push({
      kind: "decision",
      revision: decision.submission.revision,
      file: decision.file,
      at: decision.submission.created,
      by: "you",
      summary: decision.submission.decision === "approve" ? "Approved" : "Requested changes",
    });
  }
  for (const responses of listResponsesFiles(stageDir)) {
    entries.push({
      kind: "responses",
      revision: responses.revision,
      file: responses.file,
      at: fileMtimeIso(join(reviewDir, responses.file)),
      by: "agent",
      summary: `${responses.entries.length} ${responses.entries.length === 1 ? "remark" : "remarks"} addressed`,
    });
  }
  let files: string[] = [];
  try {
    files = readdirSync(reviewDir);
  } catch {
    files = [];
  }
  for (const file of files.filter((name) => /^answers-\d{3,}\.json$/.test(name))) {
    const path = join(reviewDir, file);
    let created = fileMtimeIso(path);
    let count = 0;
    try {
      const value = JSON.parse(readFileSync(path, "utf-8")) as { created?: unknown; answers?: unknown };
      if (typeof value.created === "string" && Number.isFinite(Date.parse(value.created))) created = value.created;
      if (Array.isArray(value.answers)) count = value.answers.length;
    } catch {
      // A malformed historical file stays visible by its filesystem timestamp.
    }
    entries.push({
      kind: "answers",
      file,
      at: created,
      by: "you",
      summary: `${count} ${count === 1 ? "answer" : "answers"} saved`,
    });
  }
  entries.sort((left, right) => right.at.localeCompare(left.at) || right.file.localeCompare(left.file));
  return json({ entries });
}

function validFeedbackBody(value: unknown): value is FeedbackRequest {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<FeedbackRequest>;
  if (
    typeof body.stage !== "string" ||
    !(body.unit === null || typeof body.unit === "string") ||
    !Number.isInteger(body.revision) ||
    !["approve", "request-changes", "none"].includes(String(body.decision_hint)) ||
    (body.general !== undefined && typeof body.general !== "string") ||
    !Array.isArray(body.annotations)
  ) return false;
  const kinds: Record<string, true> = {
    comment: true,
    delete: true,
    "looks-good": true,
    label: true,
    edit: true,
  };
  return body.annotations.every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const annotation = raw as Partial<ReviewAnnotation>;
    return typeof annotation.artifact === "string" &&
      (annotation.id === undefined || typeof annotation.id === "string") &&
      kinds[String(annotation.kind)] === true &&
      Array.isArray(annotation.heading_path) &&
      annotation.heading_path.every((entry) => typeof entry === "string") &&
      (annotation.selection === undefined || typeof annotation.selection === "string") &&
      (annotation.line_start === undefined || Number.isInteger(annotation.line_start)) &&
      (annotation.line_end === undefined || Number.isInteger(annotation.line_end)) &&
      (annotation.css_path === undefined || typeof annotation.css_path === "string") &&
      (annotation.body === undefined || typeof annotation.body === "string") &&
      (annotation.after === undefined || typeof annotation.after === "string") &&
      (annotation.reply_to === undefined || typeof annotation.reply_to === "string");
  });
}

async function feedbackResponse(projectDir: string, request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!validFeedbackBody(parsed)) throw new HttpError(400, "invalid feedback body");

  const { current, manifest, stageDir } = selectedStageContext(projectDir);
  if (
    parsed.stage !== current.stage ||
    parsed.unit !== current.unit ||
    parsed.revision !== current.revision
  ) throw new HttpError(409, "review target no longer current");
  const sources: Record<string, string> = {};
  for (const annotation of parsed.annotations) {
    const matches = manifest.artifacts.filter((entry) => basename(entry.path) === basename(annotation.artifact));
    if (matches.length !== 1) throw new HttpError(400, `unknown artifact: ${annotation.artifact}`);
    if (annotation.kind === "edit") {
      const artifactPath = resolveProjectAidlcPath(projectDir, matches[0].path);
      regularFile(artifactPath);
      sources[basename(annotation.artifact)] = readFileSync(artifactPath, "utf-8");
    }
  }
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const reviewDir = stageReviewUiDir(stageDir);
  mkdirSync(reviewDir, { recursive: true });
  const takenIds = new Set(listFeedbackFiles(stageDir).flatMap((entry) => entry.remarks.map((remark) => remark.id)));

  let sequence = nextSequence(reviewDir, FEEDBACK_PREFIX);
  let file = "";
  while (true) {
    file = feedbackFileName(sequence++);
    const path = join(reviewDir, file);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      writeFileSync(descriptor, renderFeedbackMarkdown(parsed, { created, sources, takenIds }), "utf-8");
    } finally {
      closeSync(descriptor);
    }
    return json({ file, path: posixRelative(projectDir, path) });
  }
}

interface AnswersRequest {
  questions_file: string;
  source_sha256: string;
  answers: AnswerSubmissionEntry[];
}

async function limitedRequestBytes(request: Request, maximum: number): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maximum) {
      throw new HttpError(413, "request body too large");
    }
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maximum) {
        await reader.cancel();
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validAnswersEnvelope(value: unknown): value is Omit<AnswersRequest, "answers"> & { answers: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  return keys.length === 3 &&
    keys.every((key) => key === "questions_file" || key === "source_sha256" || key === "answers") &&
    typeof body.questions_file === "string" &&
    body.questions_file.length > 0 &&
    typeof body.source_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(body.source_sha256) &&
    Array.isArray(body.answers);
}

function appendHumanTurn(projectDir: string, file: string): void {
  try {
    const space = activeSpace(projectDir);
    if (humanTurnMintAllowed()) {
      appendAuditEntry(
        "HUMAN_TURN",
        { Mode: "browser", Source: "review-ui", Submission: file },
        projectDir,
        activeIntent(projectDir, space) ?? undefined,
        space,
      );
    }
    markHumanTurn(projectDir);
  } catch (error) {
    process.stderr.write(
      `Review UI: human-turn mint failed after ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function answersResponse(projectDir: string, request: Request): Promise<Response> {
  const bytes = await limitedRequestBytes(request, MAX_ANSWERS_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!validAnswersEnvelope(body)) throw new HttpError(400, "invalid answers body");

  const questionsPath = resolveProjectAidlcPath(projectDir, body.questions_file);
  regularFile(questionsPath);
  if (extname(questionsPath).toLowerCase() !== ".md") throw new HttpError(400, "invalid questions file");
  const target = requireQuestionsTarget(projectDir, body.questions_file, questionsPath);
  const source = readFileSync(questionsPath);
  const sourceSha256 = sha256Hex(source);
  if (body.source_sha256 !== sourceSha256) {
    throw new HttpError(409, "questions file changed; reload");
  }
  // Only a published round accepts answers: the same record the Stop hook
  // holds on, so a submission can never land where nothing waits for it.
  if (!target.ready) {
    throw new HttpError(409, "question round not published yet; the agent is still preparing it");
  }

  let answers: AnswerSubmissionEntry[];
  try {
    answers = validateQuestionAnswers(
      parseQuestionsMarkdown(new TextDecoder().decode(source)),
      body.answers,
    );
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid question answers");
  }

  const reviewDir = stageReviewUiDir(target.stagePath);
  mkdirSync(reviewDir, { recursive: true });
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let sequence = nextSequence(reviewDir, ANSWERS_PREFIX);
  while (true) {
    const file = answersFileName(sequence++);
    const path = join(reviewDir, file);
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify({
        version: 1,
        questions_file: target.file,
        source_sha256: sourceSha256,
        created,
        answers,
      }, null, 2)}\n`, "utf-8");
    } finally {
      closeSync(descriptor);
    }
    appendHumanTurn(projectDir, file);
    return json({ file });
  }
}

function exportResponse(projectDir: string, url: URL): Response {
  const context = stateContext(projectDir, selectionFromUrl(url));
  const path = pathWithinRecord(confinedPath(projectDir, url), context);
  regularFile(path);
  const extension = extname(path).toLowerCase();
  const source = readFileSync(path, "utf-8");
  let html: string;
  if (extension === ".md" || extension === ".markdown") {
    const mermaidPath = join(ASSET_ROOT, "vendor", "mermaid.min.js");
    const mermaid = existsSync(mermaidPath) ? readFileSync(mermaidPath, "utf-8") : "";
    html = selfContainedMarkdownExport(source, mermaid);
  } else if (extension === ".html" || extension === ".htm") {
    html = source.replace(/\s(?:src|href)=(['"])https?:\/\/[^'\"]*\1/gi, "");
  } else {
    throw new HttpError(404, "unsupported artifact");
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${basename(path).replace(/["\\]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function serveAsset(pathname: string): Response {
  const path = containedAsset(pathname);
  if (!path) return errorResponse(404, "not found");
  regularFile(path);
  return new Response(Bun.file(path), { headers: { "Content-Type": mimeType(path) } });
}

function browserCommand(url: string): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return { command: "xdg-open", args: [url] };
  return null;
}

function openBrowser(url: string): void {
  const launch = browserCommand(url);
  if (!launch) return;
  try {
    const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening is a convenience; daemon and CLI success never depend on it.
  }
}

async function serve(projectDir: string): Promise<void> {
  projectDir = realpathSync(projectDir);
  const bindHosts = bindHostsFor(process.env[ENV_REVIEW_HOST]);
  const bindHost = bindHosts[0];
  const idleMinutes = parseIdleMinutes();
  const token = randomBytes(32).toString("hex");
  const projectId = reviewUiProjectId(projectDir);
  let baseOrigin = "";
  let openUrl = "";
  let currentInfo: ServerInfo;
  let wsClients = 0;
  let lastStateChange = Date.now();
  let lastReviewState: string | null = null;
  let lastClientSeenAt = 0;
  const strict = reviewUiStrict();
  // Hosts a trusted navigation may carry; filled once the port is known.
  const allowedHosts = new Set<string>();
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];

  const serveOn = (hostname: string, candidatePort: number) => Bun.serve<{ authenticated: true }>({
    hostname,
    port: candidatePort,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return json({ ok: true, project_id: projectId, pid: process.pid, version: AIDLC_VERSION });
      }
      if (url.pathname.startsWith("/assets/")) return serveAsset(url.pathname);
      if (url.pathname === "/ws") {
        if (!authenticated(request, token)) return errorResponse(401, "unauthorized");
        if (request.headers.get("origin") !== baseOrigin) return errorResponse(403, "invalid origin");
        if (bunServer.upgrade(request, { data: { authenticated: true } })) return;
        return errorResponse(400, "websocket upgrade required");
      }

      const openMatch = /^\/open\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && openMatch) {
        if (!consumeReviewUiOpenNonce(projectDir, openMatch[1])) return forbiddenPage("link-consumed");
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookie(token),
          },
        });
      }
      if (url.pathname === "/" && !authenticated(request, token)) {
        if (!strict && request.method === "GET" && browserNavigationTrusted(request, allowedHosts)) {
          lastClientSeenAt = Date.now();
          return withSessionCookie(appShellResponse(), token);
        }
        return forbiddenPage("no-session");
      }
      if (url.pathname !== "/" && !authenticated(request, token)) {
        return errorResponse(401, "unauthorized");
      }
      lastClientSeenAt = Date.now();
      // Cookie sessions renew on activity (sliding window) so an in-use tab
      // never lapses mid-review; the token check still bounds every session
      // to this daemon's lifetime. Tooling authenticating via header gets no cookie.
      const viaCookie = cookieToken(request) === token;

      const response = await (async (): Promise<Response> => {
        try {
          if (url.pathname === "/" && request.method === "GET") return appShellResponse();
          if (request.method === "GET" && url.pathname === "/api/state") return json(statePayload(projectDir));
          if (request.method === "GET" && url.pathname === "/api/workflow") {
            return json(workflowPayload(projectDir, {
              ...selectionFromUrl(url),
              version: AIDLC_VERSION,
              port: boundPort,
            }));
          }
          if (request.method === "GET" && url.pathname === "/api/tree") return json(treePayload(projectDir, url));
          if (request.method === "GET" && url.pathname === "/api/artifact") return artifactResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/render") return renderResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/raw") return rawResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/questions") return questionsResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/history") return historyResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/responses") return responsesResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/remarks") return remarksResponse(projectDir, url);
          if (request.method === "POST" && url.pathname === "/api/feedback") return await feedbackResponse(projectDir, request);
          if (request.method === "POST" && url.pathname === "/api/render-fragment") return await renderFragmentResponse(request);
          if (request.method === "GET" && url.pathname === "/api/snapshots") return snapshotsResponse(projectDir, url);
          if (request.method === "POST" && url.pathname === "/api/answers") return await answersResponse(projectDir, request);
          if (request.method === "POST" && url.pathname === "/api/decision") {
            return await handleDecision(request, {
              projectDir,
              stateContext: stateContext(projectDir),
              appendHumanTurn: (file) => appendHumanTurn(projectDir, file),
            });
          }
          if (request.method === "GET" && url.pathname === "/api/snapshot") return snapshotResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/diff") return diffResponse(projectDir, url);
          if (request.method === "GET" && url.pathname === "/api/export") return exportResponse(projectDir, url);
          return errorResponse(404, "not found");
        } catch (error) {
          if (error instanceof PathConfinementError) return errorResponse(403, "path escapes aidlc root");
          if (error instanceof HttpError) return errorResponse(error.status, error.message);
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return errorResponse(404, "not found");
          process.stderr.write(`Review UI request failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return errorResponse(500, "internal error");
        }
      })();
      return viaCookie ? withSessionCookie(response, token) : response;
    },
    websocket: {
      open(ws) {
        wsClients++;
        lastClientSeenAt = Date.now();
        ws.subscribe("state");
      },
      close(ws) {
        ws.unsubscribe("state");
        wsClients = Math.max(0, wsClients - 1);
        lastClientSeenAt = Date.now();
      },
      message() {
        // The M1 socket is server-push only.
      },
    },
  });
  // One port, every configured address: the loopback listener is the one the
  // local human opens; an extra address (a LAN IP, `0.0.0.0`) is for a browser
  // on another machine and shares the same token, cookie, and handlers.
  assertBindable(serveOn, bindHosts);
  const servers = bindFirstFree(
    (candidatePort) => bindAll(serveOn, bindHosts, candidatePort),
    portCandidates(parsePort()),
  );
  const server = servers[0];
  const boundPort = server.port ?? 0;

  // A wildcard bind is advertised as localhost (the address a human can open)
  // with every interface address listed as an extra.
  const advertisedHost = isWildcard(bindHost) ? DEFAULT_REVIEW_HOST : bindHost;
  baseOrigin = `http://${urlHost(advertisedHost)}:${boundPort}`;
  const daemonOrigin = `${baseOrigin}/`;
  // A trusted navigation must name this daemon: every advertised host plus the
  // literal loopback spellings a human may type for it.
  for (const host of bindHosts) allowedHosts.add(`${urlHost(host)}:${boundPort}`.toLowerCase());
  for (const spelling of ["localhost", "127.0.0.1", "[::1]"]) allowedHosts.add(`${spelling}:${boundPort}`);
  if (bindHosts.some((host) => host === "0.0.0.0" || host === "::")) {
    for (const address of localAddresses()) allowedHosts.add(`${urlHost(address)}:${boundPort}`.toLowerCase());
  }
  const started = new Date().toISOString();
  const extraHosts = isWildcard(bindHost) ? localAddresses().filter((address) => !address.includes(":")) : bindHosts.slice(1);
  const extraUrls = extraHosts.map((host) => `http://${urlHost(host)}:${boundPort}/`);
  currentInfo = {
    version: 1,
    pid: process.pid,
    host: advertisedHost,
    ...(extraHosts.length ? { hosts: [advertisedHost, ...extraHosts], urls: extraUrls } : {}),
    port: boundPort,
    url: daemonOrigin,
    token,
    project_dir: projectDir,
    project_id: projectId,
    started_at: started,
    heartbeat_at: started,
    idle_minutes: idleMinutes,
  };
  writeServerInfo(currentInfo);
  openUrl = reviewUiHumanUrl(projectDir) ?? daemonOrigin;
  process.stdout.write(`Review UI: ${openUrl}\n`);
  for (const extra of extraUrls) process.stdout.write(`Review UI (also listening): ${extra}\n`);

  // Two moments need the human's eyes: a gate opening, and a browser question
  // round beginning (the guide explainer landing beside the questions file).
  let lastGuideFile: string | null = null;
  const observeState = (): void => {
    lastStateChange = Date.now();
    const context = stateContext(projectDir);
    const state = context.current?.state ?? null;
    // `guide` is published only once the explainer passes its check, so this
    // transition is "the round is ready for the human", never "a file appeared".
    let guideFile: string | null = null;
    try {
      guideFile = currentQuestionsTarget(projectDir, context)?.guide ?? null;
    } catch {
      // A confinement error here is a malformed record, not a reason to stop publishing.
    }
    const gateOpened = state === "awaiting-approval" && lastReviewState !== "awaiting-approval";
    const roundOpened = guideFile !== null && guideFile !== lastGuideFile;
    // If no browser is looking (no live socket and no authenticated traffic
    // within the grace window — which covers a tab reload or a transient
    // reconnect), open one so the human never has to copy a link. A connected
    // tab is steered by the state push instead; never a second tab.
    if (
      (gateOpened || roundOpened) &&
      wsClients === 0 &&
      Date.now() - lastClientSeenAt > AUTO_OPEN_GRACE_MS &&
      process.env[ENV_REVIEW_OPEN] !== "0" &&
      !process.env.SSH_CONNECTION
    ) {
      const transitionUrl = reviewUiHumanUrl(projectDir);
      if (transitionUrl) openBrowser(transitionUrl);
    }
    lastReviewState = state;
    lastGuideFile = guideFile;
    for (const instance of servers) instance.publish("state", JSON.stringify({ type: "state" }));
  };

  const onWatch = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(observeState, WATCH_DEBOUNCE_MS);
  };

  // Watch the whole spaces root, not just the record that existed at startup:
  // intents created later, `active-intent` switches, and their state files all
  // live under it, so the tab keeps following the workflow without a daemon
  // restart. Fall back to the initial record + state file when the shell has
  // no spaces root yet.
  const initial = stateContext(projectDir);
  const watchTargets = new Set<string>();
  const spaces = spacesRoot(projectDir);
  if (existsSync(spaces)) {
    watchTargets.add(spaces);
  } else {
    if (existsSync(initial.record)) watchTargets.add(initial.record);
    const statePath = stateFilePath(projectDir, initial.intent ?? undefined, initial.space);
    if (existsSync(statePath)) watchTargets.add(statePath);
  }
  for (const target of watchTargets) {
    try {
      watchers.push(watch(target, { recursive: statSync(target).isDirectory() }, onWatch));
    } catch {
      // Watching is best effort on filesystems that do not support recursion.
    }
  }
  observeState();

  const heartbeat = setInterval(() => {
    currentInfo = { ...currentInfo, heartbeat_at: new Date().toISOString() };
    writeServerInfo(currentInfo);
  }, HEARTBEAT_INTERVAL_MS);
  const idle = setInterval(() => {
    if (wsClients === 0 && Date.now() - lastStateChange >= idleMinutes * 60_000) shutdown(0);
  }, Math.min(60_000, Math.max(1_000, idleMinutes * 15_000)));

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (debounce) clearTimeout(debounce);
    clearInterval(heartbeat);
    clearInterval(idle);
    for (const watcher of watchers) watcher.close();
    removeServerInfo(projectDir);
    for (const instance of servers) instance.stop(true);
  };
  const shutdown = (code: number): void => {
    cleanup();
    process.exit(code);
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  process.once("exit", cleanup);
}

function status(projectDir: string, asJson: boolean): void {
  const info = readServerInfo(projectDir);
  const running = serverInfoLooksAlive(info);
  if (asJson) {
    const server = info
      ? {
          version: info.version,
          pid: info.pid,
          host: info.host,
          ...(info.hosts ? { hosts: info.hosts, urls: info.urls ?? [] } : {}),
          port: info.port,
          url: info.url,
          project_dir: info.project_dir,
          project_id: info.project_id,
          started_at: info.started_at,
          heartbeat_at: info.heartbeat_at,
          idle_minutes: info.idle_minutes,
        }
      : null;
    process.stdout.write(`${JSON.stringify({ running, server }, null, 2)}\n`);
    return;
  }
  if (!running || !info) {
    process.stdout.write("Review UI: stopped\n");
    return;
  }
  const openUrl = reviewUiHumanUrl(projectDir) ?? info.url;
  process.stdout.write(`Review UI: running (pid ${info.pid})\n${openUrl}\n`);
  for (const extra of info.urls ?? []) process.stdout.write(`also listening: ${extra}\n`);
}

function stop(projectDir: string): void {
  const info = readServerInfo(projectDir);
  if (!serverInfoLooksAlive(info)) {
    if (info) removeServerInfo(projectDir);
    process.stdout.write("Review UI: stopped\n");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  process.stdout.write(`Review UI: stopping (pid ${info.pid})\n`);
}

function open(projectDir: string): void {
  const url = reviewUiHumanUrl(projectDir);
  if (!url) {
    process.stderr.write("Review UI is not running\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${url}\n`);
  openBrowser(url);
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!existsSync(args.projectDir)) usageError(`Project directory does not exist: ${args.projectDir}`);
  if (args.command === "serve") await serve(args.projectDir);
  else if (args.command === "status") status(args.projectDir, args.asJson);
  else if (args.command === "stop") stop(args.projectDir);
  else open(args.projectDir);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

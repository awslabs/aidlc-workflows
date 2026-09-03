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
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  activeIntent,
  activeSpace,
  CHECKBOX_MAP,
  docsRoot,
  getField,
  parseCheckboxes,
  readStateFile,
  recordDir,
  stateFilePath,
} from "./aidlc-lib.ts";
import {
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
  mintReviewUiOpenUrl,
  htmlArtifactsRequested,
  nextSequence,
  readCurrentPointer,
  readManifest,
  readServerInfo,
  removeServerInfo,
  reviewUiProjectId,
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
  lineDiff,
  PathConfinementError,
  renderFeedbackMarkdown,
  renderMarkdown,
  resolveProjectAidlcPath,
  selfContainedMarkdownExport,
  type FeedbackRequest,
  type ReviewAnnotation,
} from "./aidlc-review-ui-render.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const WATCH_DEBOUNCE_MS = 150;
const RAW_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; font-src data:; frame-ancestors 'self'";
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

function forbiddenPage(importedFromOpenLink = false): Response {
  const reason = importedFromOpenLink
    ? "This review link expired or was already used."
    : "This review UI needs a fresh login link.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Review UI access required</title></head><body><main><h1>Review UI access required</h1><p>${reason}</p><p>Run <code>bun &lt;harnessDir&gt;/tools/aidlc-review-ui.ts open</code> for a fresh one.</p></main></body></html>`;
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

function parsePort(): number {
  const raw = process.env[ENV_REVIEW_PORT];
  if (!raw || raw === "0") return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${ENV_REVIEW_PORT} must be an integer from 0 to 65535`);
  }
  return port;
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
  space: string;
  intent: string | null;
  record: string;
  state: string | null;
  current: CurrentPointer | null;
  manifest: ReviewManifest | null;
}

function stateContext(projectDir: string): StateContext {
  const space = activeSpace(projectDir);
  const intent = activeIntent(projectDir, space);
  const record = recordDir(projectDir, intent ?? undefined, space) ?? docsRoot(projectDir, intent ?? undefined, space);
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
      manifest = readManifest(resolveProjectAidlcPath(projectDir, current.stage_dir));
    } catch {
      manifest = null;
    }
  }
  return { space, intent, record, state, current, manifest };
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
  return {
    project_dir: projectDir,
    space: context.space,
    intent: context.intent,
    record_dir: posixRelative(projectDir, context.record),
    current: context.current,
    manifest: context.manifest,
    stage_status: stageMarker(context.state, currentStage),
    revision_count: revision !== null && Number.isInteger(revision) ? revision : null,
    html_artifacts: htmlArtifactsRequested(),
  };
}

function treePayload(projectDir: string): { entries: Array<Record<string, unknown>> } {
  const { record } = stateContext(projectDir);
  const entries: Array<Record<string, unknown>> = [];
  if (!existsSync(record)) return { entries };

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".review-ui" || entry.name === "audit" || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      let stat;
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

function queryPath(url: URL, name = "path"): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `missing ${name}`);
  return value;
}

function confinedPath(projectDir: string, url: URL, name = "path"): string {
  return resolveProjectAidlcPath(projectDir, queryPath(url, name));
}

function regularFile(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new HttpError(404, "not found");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(404, "not found");
}

function artifactResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const path = resolveProjectAidlcPath(projectDir, requested);
  regularFile(path);
  const stat = statSync(path);
  const extension = extname(path).toLowerCase();
  const source = readFileSync(path, "utf-8");
  if (extension === ".md" || extension === ".markdown") {
    return json({
      path: requested,
      format: "md",
      source,
      html: renderMarkdown(source),
      sha256: sha256Hex(source),
      mtime: stat.mtimeMs,
    });
  }
  if (extension === ".html" || extension === ".htm") {
    return json({
      path: requested,
      format: "html",
      raw_url: `/api/raw?path=${encodeURIComponent(requested)}`,
      sha256: sha256Hex(source),
      mtime: stat.mtimeMs,
    });
  }
  throw new HttpError(404, "unsupported artifact");
}

function rawResponse(projectDir: string, url: URL): Response {
  const path = confinedPath(projectDir, url);
  regularFile(path);
  if (![".html", ".htm"].includes(extname(path).toLowerCase())) throw new HttpError(404, "not found");
  return new Response(injectBridge(readFileSync(path, "utf-8")), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": RAW_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function currentStageContext(projectDir: string): {
  current: CurrentPointer;
  manifest: ReviewManifest;
  stageDir: string;
} {
  const context = stateContext(projectDir);
  if (!context.current?.stage_dir) throw new HttpError(409, "no current review");
  const stageDir = resolveProjectAidlcPath(projectDir, context.current.stage_dir);
  const manifest = context.manifest ?? readManifest(stageDir);
  if (!manifest) throw new HttpError(409, "no current manifest");
  return { current: context.current, manifest, stageDir };
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
  const stageDir = resolveProjectAidlcPath(projectDir, stageRelative);
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
  resolveProjectAidlcPath(projectDir, stageRelative);
  const revision = parseRevision(url.searchParams.get("revision"));
  const path = snapshotFile(projectDir, stageRelative, revision, queryPath(url, "file"));
  regularFile(path);
  return json({ source: readFileSync(path, "utf-8") });
}

function diffResponse(projectDir: string, url: URL): Response {
  const requested = queryPath(url);
  const currentPath = resolveProjectAidlcPath(projectDir, requested);
  regularFile(currentPath);
  const { current, manifest } = currentStageContext(projectDir);
  const artifact = manifest.artifacts.find((entry) => entry.path === requested);
  if (!artifact) throw new HttpError(404, "artifact is not in the current manifest");
  if (!current.stage_dir) throw new HttpError(409, "no current review");
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
  const kinds = new Set(["comment", "delete", "looks-good", "label", "edit"]);
  return body.annotations.every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const annotation = raw as Partial<ReviewAnnotation>;
    return typeof annotation.artifact === "string" &&
      kinds.has(String(annotation.kind)) &&
      Array.isArray(annotation.heading_path) &&
      annotation.heading_path.every((entry) => typeof entry === "string") &&
      (annotation.selection === undefined || typeof annotation.selection === "string") &&
      (annotation.line_start === undefined || Number.isInteger(annotation.line_start)) &&
      (annotation.line_end === undefined || Number.isInteger(annotation.line_end)) &&
      (annotation.css_path === undefined || typeof annotation.css_path === "string") &&
      (annotation.body === undefined || typeof annotation.body === "string") &&
      (annotation.after === undefined || typeof annotation.after === "string");
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

  const { current, manifest, stageDir } = currentStageContext(projectDir);
  if (parsed.stage !== current.stage) throw new HttpError(409, "stage no longer current");
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
  const markdown = renderFeedbackMarkdown(parsed, { sources });
  const reviewDir = stageReviewUiDir(stageDir);
  mkdirSync(reviewDir, { recursive: true });

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
      writeFileSync(descriptor, markdown, "utf-8");
    } finally {
      closeSync(descriptor);
    }
    return json({ file, path: posixRelative(projectDir, path) });
  }
}

function exportResponse(projectDir: string, url: URL): Response {
  const path = confinedPath(projectDir, url);
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
  const bindHost = process.env[ENV_REVIEW_HOST]?.trim() || DEFAULT_REVIEW_HOST;
  const port = parsePort();
  const idleMinutes = parseIdleMinutes();
  const token = randomBytes(32).toString("hex");
  const projectId = reviewUiProjectId(projectDir);
  let baseOrigin = "";
  let openUrl = "";
  let currentInfo: ServerInfo;
  let wsClients = 0;
  let lastStateChange = Date.now();
  let lastReviewState: string | null = null;
  let opened = false;
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];

  const server = Bun.serve<{ authenticated: true }>({
    hostname: bindHost,
    port,
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
        if (!consumeReviewUiOpenNonce(projectDir, openMatch[1])) return forbiddenPage(true);
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Cache-Control": "no-store",
            "Set-Cookie": `aidlc_review=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
          },
        });
      }
      if (url.pathname === "/" && !authenticated(request, token)) return forbiddenPage();
      if (url.pathname !== "/" && !authenticated(request, token)) {
        return errorResponse(401, "unauthorized");
      }

      try {
        if (url.pathname === "/" && request.method === "GET") {
          const index = join(ASSET_ROOT, "index.html");
          if (!existsSync(index)) throw new HttpError(404, "app shell not found");
          return new Response(Bun.file(index), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (request.method === "GET" && url.pathname === "/api/state") return json(statePayload(projectDir));
        if (request.method === "GET" && url.pathname === "/api/tree") return json(treePayload(projectDir));
        if (request.method === "GET" && url.pathname === "/api/artifact") return artifactResponse(projectDir, url);
        if (request.method === "GET" && url.pathname === "/api/raw") return rawResponse(projectDir, url);
        if (request.method === "POST" && url.pathname === "/api/feedback") return await feedbackResponse(projectDir, request);
        if (request.method === "GET" && url.pathname === "/api/snapshots") return snapshotsResponse(projectDir, url);
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
    },
    websocket: {
      open(ws) {
        wsClients++;
        ws.subscribe("state");
      },
      close(ws) {
        ws.unsubscribe("state");
        wsClients = Math.max(0, wsClients - 1);
      },
      message() {
        // The M1 socket is server-push only.
      },
    },
  });

  baseOrigin = `http://${urlHost(bindHost)}:${server.port}`;
  const daemonOrigin = `${baseOrigin}/`;
  const started = new Date().toISOString();
  currentInfo = {
    version: 1,
    pid: process.pid,
    host: bindHost,
    port: server.port ?? port,
    url: daemonOrigin,
    token,
    project_dir: projectDir,
    project_id: projectId,
    started_at: started,
    heartbeat_at: started,
    idle_minutes: idleMinutes,
  };
  writeServerInfo(currentInfo);
  openUrl = mintReviewUiOpenUrl(projectDir) ?? daemonOrigin;
  process.stdout.write(`Review UI: ${openUrl}\n`);

  const observeState = (): void => {
    lastStateChange = Date.now();
    const state = stateContext(projectDir).current?.state ?? null;
    if (
      !opened &&
      state === "awaiting-approval" &&
      lastReviewState !== "awaiting-approval" &&
      process.env[ENV_REVIEW_OPEN] !== "0" &&
      !process.env.SSH_CONNECTION
    ) {
      opened = true;
      const transitionUrl = mintReviewUiOpenUrl(projectDir);
      if (transitionUrl) openBrowser(transitionUrl);
    }
    lastReviewState = state;
    server.publish("state", JSON.stringify({ type: "state" }));
  };

  const onWatch = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(observeState, WATCH_DEBOUNCE_MS);
  };

  const initial = stateContext(projectDir);
  const watchTargets = new Set<string>();
  if (existsSync(initial.record)) watchTargets.add(initial.record);
  const statePath = stateFilePath(projectDir, initial.intent ?? undefined, initial.space);
  if (existsSync(statePath)) watchTargets.add(statePath);
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
    server.stop(true);
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
    process.stdout.write(`${JSON.stringify({ running, server: info }, null, 2)}\n`);
    return;
  }
  if (!running || !info) {
    process.stdout.write("Review UI: stopped\n");
    return;
  }
  process.stdout.write(`Review UI: running (pid ${info.pid})\n${info.url}\n`);
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
  const url = mintReviewUiOpenUrl(projectDir);
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

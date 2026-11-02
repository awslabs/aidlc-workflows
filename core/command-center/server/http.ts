import { createHash, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { ConfigUnreadableError, saveConfig, validateConfig, type Config } from "./config";
import { discover, type Found } from "./discovery";
import { FolderError, listFolder, pickFolder, type PickResult } from "./folders";
import type { LiveHub } from "./live";
import { buildHome } from "./model/home";
import { buildIntent, recordDirOf } from "./model/intent";
import { listIntents, type IntentRef } from "./parse/registry";
import { loadCatalog } from "./parse/stage-graph";
import { contain } from "./paths";
import { buildHealth, healthOptsOf, issuesLens } from "./health";
import { artifactLens, artifactsLens, decisionsLens, learningsLens, lensCtx, reviewsLens, tokensLens } from "./lenses";

export interface ServerCtx {
  token: string; config: Config; configPath?: string; uiDir: string; now: () => Date;
  found: Found[]; port: number; hub: LiveHub;
  /** Opens the OS folder chooser (injectable for tests); `picking` is true while one is open. */
  pick?: () => Promise<PickResult>; picking?: boolean;
  /** Where Claude Code keeps transcripts (tests point this at a temp folder) and the hook trace dir, if any. */
  transcriptsRoot?: string; traceDir?: string | null;
}

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const MAX_CONFIG_BODY = 64 * 1024;
/** `/api/file`: at most this much of a file is returned (the first bytes), and only text. */
export const MAX_FILE_BODY = 1024 * 1024;
const TEXT_EXT = new Set(["", ".md", ".markdown", ".txt", ".json", ".jsonl", ".ndjson", ".drops", ".last", ".log", ".yaml", ".yml", ".toml", ".csv", ".tsv"]);

/**
 * A read-only text file of a registered workspace, by workspace-relative path: only when it realpath-resolves inside
 * `<ws>/aidlc`, is a regular file with a text extension and holds no NUL byte in its first MAX_FILE_BODY bytes.
 * Anything else is null (the caller answers 404). Used for the supporting files of an issue (sensor details,
 * guard-refusal records, hooks-health, checkpoints), which live outside the record's artifact tree.
 */
export async function readWorkspaceFile(ws: string, rel: string): Promise<{ path: string; body: string; truncated: boolean; size: number } | null> {
  if (!rel || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\")) return null;
  const real = await contain(join(ws, "aidlc"), join(ws, rel)); if (!real) return null;
  let st: Stats; try { st = await stat(real); } catch { return null; }
  if (!st.isFile() || !TEXT_EXT.has(extname(real).toLowerCase())) return null;
  const bytes = new Uint8Array(await Bun.file(real).slice(0, MAX_FILE_BODY).arrayBuffer());
  if (bytes.includes(0)) return null;
  return { path: rel.split("\\").join("/"), body: new TextDecoder().decode(bytes), truncated: st.size > MAX_FILE_BODY, size: st.size };
}

function headers(api: boolean, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
  if (api) h.set("Cache-Control", "no-store");
  return h;
}
function withSecurity(res: Response, api: boolean): Response {
  const h = headers(api); h.forEach((v, k) => { res.headers.set(k, v); }); return res;
}
const text = (status: number, msg: string, api = true) => new Response(msg, { status, headers: headers(api, { "Content-Type": "text/plain; charset=utf-8" }) });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: headers(true) });

const digest = (s: string) => createHash("sha256").update(s).digest();
function tokenOk(given: string | null, token: string): boolean {
  if (given === null) return false;
  return timingSafeEqual(digest(given), digest(token));
}

async function serveFile(base: string, rel: string, api: boolean): Promise<Response> {
  const p = await contain(base, join(base, rel));
  if (!p) return text(404, "Not found", api);
  try { if (!(await stat(p)).isFile()) return text(404, "Not found", api); } catch { return text(404, "Not found", api); }
  const f = Bun.file(p);
  return new Response(f, { headers: headers(api, { "Content-Type": f.type || "application/octet-stream" }) });
}

/** Resolves `ws` + `key` to a registered workspace and a listed intent whose record dir is contained in `<ws>/aidlc`. */
async function resolveIntent(ctx: ServerCtx, url: URL): Promise<{ ws: string; ref: IntentRef; rec: string } | null> {
  const ws = url.searchParams.get("ws"); const key = url.searchParams.get("key");
  if (!ws || !key) return null;
  const f = ctx.found.find((x) => x.path === ws && x.exists); if (!f) return null;
  const ref = (await listIntents(f.path)).find((r) => `${r.space}/${r.dir}` === key); if (!ref) return null;
  const rec = await contain(join(f.path, "aidlc"), recordDirOf(f.path, ref)); if (!rec) return null;
  return { ws: f.path, ref, rec };
}

export async function handle(req: Request, ctx: ServerCtx): Promise<Response> {
  const url = new URL(req.url); const path = url.pathname; const api = path.startsWith("/api/");
  // 1. DNS-rebinding guard.
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) return text(421, "Misdirected request", api);
  try {
    // 2. Static assets (not token-gated).
    if (path.startsWith("/assets/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "Method not allowed", false);
      return await serveFile(join(ctx.uiDir, "assets"), path.slice("/assets/".length), false);
    }
    if (path !== "/" && !api) return text(404, "Not found", false);
    // 3. Token.
    if (!tokenOk(url.searchParams.get("t") ?? req.headers.get("x-cc-token"), ctx.token)) return text(401, "Unauthorized", api);
    if (path === "/") return req.method === "GET" || req.method === "HEAD" ? await serveFile(ctx.uiDir, "index.html", false) : text(405, "Method not allowed", false);

    if (path === "/api/config") {
      if (req.method === "GET") return json(ctx.config);
      if (req.method !== "PUT") return text(405, "Method not allowed");
      const body = await req.text();
      if (body.length > MAX_CONFIG_BODY) return text(413, "Config too large");
      let raw: unknown; try { raw = JSON.parse(body); } catch { return text(400, "Body is not valid JSON"); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return text(400, "Body must be a JSON object");
      const cfg = validateConfig(raw);
      try { await saveConfig(cfg, ctx.configPath); } catch (e) { if (e instanceof ConfigUnreadableError) return text(409, e.message); throw e; }
      ctx.config = cfg; ctx.found = await discover(cfg);
      ctx.hub.rewatch(); await ctx.hub.pushHome();
      return json(cfg);
    }
    if (path === "/api/folders/pick") {
      if (req.method !== "POST") return text(405, "Method not allowed");
      // One chooser at a time: a second click must not stack native dialogs.
      if (ctx.picking) return json({ unavailable: "a folder chooser is already open" });
      ctx.picking = true;
      try { return json(await (ctx.pick ?? pickFolder)()); } finally { ctx.picking = false; }
    }
    if (req.method !== "GET") return text(405, "Method not allowed");
    if (path === "/api/folders/list") {
      try { return json(await listFolder(url.searchParams.get("path") ?? undefined)); }
      catch (e) { if (e instanceof FolderError) return text(e.status, e.message); throw e; }
    }
    if (path === "/api/home") return json(await buildHome(ctx.found, ctx.now(), healthOptsOf(ctx)));
    if (path === "/api/health") return json(await buildHealth(ctx.found, ctx.now(), healthOptsOf(ctx)));
    if (path === "/api/stream") return withSecurity(ctx.hub.stream(req), true);
    if (path === "/api/file") {
      const f = ctx.found.find((x) => x.path === url.searchParams.get("ws") && x.exists);
      const r = f ? await readWorkspaceFile(f.path, url.searchParams.get("path") ?? "") : null;
      return r ? json(r) : text(404, "File not found");
    }

    const LENSES = new Set(["/api/intent", "/api/artifact", "/api/lens/decisions", "/api/lens/artifacts", "/api/lens/reviews", "/api/lens/learnings", "/api/lens/tokens", "/api/lens/issues"]);
    if (!LENSES.has(path)) return text(404, "Not found");
    // 4. Workspace + intent lookup.
    const r = await resolveIntent(ctx, url); if (!r) return text(404, "Unknown workspace or intent");
    if (path === "/api/lens/issues") return json(await issuesLens(ctx.found.find((x) => x.path === r.ws)!, r.ref, ctx.now(), healthOptsOf(ctx)));
    const cat = await loadCatalog(r.ws);
    if (path === "/api/intent") return json(await buildIntent(r.ws, r.ref, cat.stages, ctx.now()));
    const c = await lensCtx(r.ws, r.ref, r.rec, cat.stages);
    switch (path) {
      case "/api/lens/decisions": return json(await decisionsLens(c));
      case "/api/lens/artifacts": return json(await artifactsLens(c));
      case "/api/lens/reviews": return json(await reviewsLens(c));
      case "/api/lens/learnings": return json(await learningsLens(c));
      case "/api/lens/tokens": return json(await tokensLens(c));
      case "/api/artifact": {
        const a = await artifactLens(c, url.searchParams.get("path") ?? "");
        return a ? json(a) : text(404, "Artifact not found");
      }
    }
    return text(404, "Not found");
  } catch (e) {
    console.error(`[command-center] ${req.method} ${path} failed:`, e);
    return text(500, "Internal error", api);
  }
}

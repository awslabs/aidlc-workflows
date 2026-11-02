import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Found } from "./discovery";
import type { Config } from "./config";
import { healthOptsOf } from "./health";
import { buildHome } from "./model/home";
import { readAuditIncremental, type AuditCursor } from "./parse/audit";
import { contain } from "./paths";
import { LocalFolderSource } from "./source";
import { storyEvents } from "./model/story";

/** The slice of the server context the hub reads; `found` is re-read on every use because PUT /api/config replaces it. */
interface Ctx { found: Found[]; now: () => Date; config?: Config; transcriptsRoot?: string; traceDir?: string | null }
type Ctrl = ReadableStreamDefaultController<Uint8Array>;
type Watcher = { close: () => void; readonly mode: "watch" | "poll" };

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1_000; // a steady stream of changes still flushes at least this often
const PING_MS = 15_000;

interface WsState {
  watcher: Watcher; cursors: Map<string, AuditCursor>;
  /** Shards whose size could not be learned while priming: their first successful read is sent as `reset: true`. */
  unknown: Set<string>;
  primed: Promise<void>; timer: ReturnType<typeof setTimeout> | null; pendingSince: number | null; chain: Promise<void>;
}

/**
 * Watches every existing workspace's `aidlc/` folder and pushes SSE messages:
 * `hello` on connect, `watch` per workspace, `intent` deltas when an audit shard grows
 * (or is truncated → `reset: true`), a full `home` payload after any change (debounced
 * 250 ms per workspace, at most 1 s after the first pending change), and `ping` every 15 s.
 */
export class LiveHub {
  private clients = new Set<Ctrl>();
  private ws = new Map<string, WsState>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private enc = new TextEncoder();
  constructor(private ctx: Ctx, private makeSource: (root: string) => LocalFolderSource = (root) => new LocalFolderSource(root)) {}

  /** Idempotent: a second call re-syncs watchers and restarts the ping interval. */
  start(): void {
    this.rewatch();
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => this.broadcast({ type: "ping", at: new Date().toISOString() }), PING_MS);
  }

  stop(): void {
    this.closeAll();
    if (this.ping) clearInterval(this.ping); this.ping = null;
    for (const c of this.clients) { try { c.close(); } catch { /* already closed */ } }
    this.clients.clear();
  }

  /**
   * Syncs watchers with the current `ctx.found`: workspaces that remain keep their watcher and
   * cursors (a pending debounce is flushed now, not dropped), removed ones are closed, and new
   * ones are watched with freshly primed cursors.
   */
  rewatch(): void {
    const want = new Set(this.ctx.found.filter((x) => x.exists).map((x) => x.path));
    for (const [ws, st] of this.ws) if (!want.has(ws)) { this.close(st); this.ws.delete(ws); }
    for (const ws of want) {
      const kept = this.ws.get(ws);
      if (kept) {
        if (kept.timer) this.flushNow(ws, kept);
        this.broadcast({ type: "watch", ws, mode: kept.watcher.mode });
        continue;
      }
      const st = { cursors: new Map(), unknown: new Set(), timer: null, pendingSince: null, chain: Promise.resolve() } as unknown as WsState;
      st.watcher = this.makeSource(ws).watch(() => this.changed(ws), (mode) => { if (this.ws.get(ws) === st) this.broadcast({ type: "watch", ws, mode }); });
      st.primed = this.prime(ws, st);
      this.ws.set(ws, st);
      this.broadcast({ type: "watch", ws, mode: st.watcher.mode });
    }
  }

  /** Resolves once every watched workspace has primed its shard cursors (later appends become deltas). */
  async ready(): Promise<void> {
    await Promise.all([...this.ws.values()].map((st) => st.primed));
  }

  /** Recomputes and pushes the full home payload (used after config changes). */
  async pushHome(): Promise<void> {
    this.broadcast({ type: "home", payload: await buildHome(this.ctx.found, this.ctx.now(), healthOptsOf(this.ctx)) });
  }

  broadcast(msg: unknown): void {
    const b = this.enc.encode(`data: ${JSON.stringify(msg)}\n\n`);
    for (const c of this.clients) this.send(c, b);
  }

  stream(req?: Request): Response {
    let ctrl: Ctrl | null = null;
    const drop = () => { if (ctrl) this.clients.delete(ctrl); };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c; this.clients.add(c);
        this.send(c, this.enc.encode(`data: ${JSON.stringify({ type: "hello", generatedAt: new Date().toISOString() })}\n\n`));
        // Late joiners still learn each workspace's watch mode (it was broadcast before they connected).
        for (const [ws, st] of this.ws) this.send(c, this.enc.encode(`data: ${JSON.stringify({ type: "watch", ws, mode: st.watcher.mode })}\n\n`));
      },
      cancel: drop,
    });
    req?.signal.addEventListener("abort", drop, { once: true });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }

  private send(c: Ctrl, b: Uint8Array): void {
    try { c.enqueue(b); } catch { this.clients.delete(c); }
  }

  private close(st: WsState): void {
    st.watcher.close(); if (st.timer) clearTimeout(st.timer); st.timer = null; st.pendingSince = null;
  }

  private closeAll(): void {
    for (const st of this.ws.values()) this.close(st);
    this.ws.clear();
  }

  /** Records the current end of every shard so only later appends become deltas. */
  private async prime(ws: string, st: WsState): Promise<void> {
    for (const { path } of await this.auditFiles(ws)) {
      try { st.cursors.set(path, (await readAuditIncremental(path, null)).cursor); continue; } catch { /* unreadable now; fall back to its size */ }
      // Never replay existing history as new: start from the current size when it can be learned,
      // otherwise have the first successful read tell clients to refetch (reset).
      // Such a cursor has no `line` (it is not known), so entries read through it carry no line numbers.
      try { const { size } = await stat(path); st.cursors.set(path, { path, offset: size, size, seq: 0 }); } catch { st.unknown.add(path); }
    }
  }

  /** Audit shards under `<ws>/aidlc/spaces/<space>/intents/<dir>/audit/*.md`, realpath-contained in `<ws>/aidlc`. */
  private async auditFiles(ws: string): Promise<{ path: string; key: string }[]> {
    const base = join(ws, "aidlc"); const spaces = join(base, "spaces");
    const ls = (d: string) => readdir(d).catch(() => [] as string[]);
    const out: { path: string; key: string }[] = [];
    for (const sp of await ls(spaces)) for (const d of await ls(join(spaces, sp, "intents"))) {
      const dir = await contain(base, join(spaces, sp, "intents", d, "audit")); if (!dir) continue;
      for (const f of (await ls(dir)).filter((n) => n.endsWith(".md")).sort()) {
        // A plain file in a contained dir is contained (and stays listed even while unreadable, so priming can
        // record its size); anything else, e.g. a symlink, must realpath-resolve inside `<ws>/aidlc`.
        const plain = await lstat(join(dir, f)).then((x) => x.isFile(), () => false);
        const p = plain ? join(dir, f) : await contain(base, join(dir, f));
        if (p) out.push({ path: p, key: `${sp}/${d}` });
      }
    }
    return out;
  }

  private changed(ws: string): void {
    const st = this.ws.get(ws); if (!st) return;
    const now = Date.now();
    st.pendingSince ??= now;
    if (st.timer) clearTimeout(st.timer);
    const left = MAX_WAIT_MS - (now - st.pendingSince);
    if (left <= 0) { this.flushNow(ws, st); return; }
    st.timer = setTimeout(() => this.flushNow(ws, st), Math.min(DEBOUNCE_MS, left));
  }

  private flushNow(ws: string, st: WsState): void {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null; st.pendingSince = null;
    st.chain = st.chain.then(() => this.flush(ws, st)).catch((e) => console.error(`[command-center] live refresh of ${ws} failed:`, e));
  }

  private async flush(ws: string, st: WsState): Promise<void> {
    await st.primed;
    if (this.ws.get(ws) !== st) return; // rewatched or stopped since the change
    for (const { path, key } of await this.auditFiles(ws)) {
      try {
        const r = await readAuditIncremental(path, st.cursors.get(path) ?? null);
        const reset = r.reset || st.unknown.delete(path);
        st.cursors.set(path, r.cursor);
        if (!r.events.length && !reset) continue;
        this.broadcast({ type: "intent", ws, key, reset, lastEventTs: r.events.at(-1)?.ts ?? null, newEvents: storyEvents(r.events) }); // same projection as /api/intent
      } catch { /* shard vanished mid-read; the next change retries */ }
    }
    if (this.ws.get(ws) !== st) return;
    await this.pushHome();
  }
}

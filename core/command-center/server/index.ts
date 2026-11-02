import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config";
import type { PickResult } from "./folders";
import { discover } from "./discovery";
import { handle, type ServerCtx } from "./http";
import { LiveHub } from "./live";
export async function startServer(o: { port?: number; config: Config; configPath?: string; uiDir?: string; now?: () => Date; pick?: () => Promise<PickResult>; transcriptsRoot?: string; traceDir?: string | null }) {
  const token = randomBytes(24).toString("base64url");
  const ctx: ServerCtx = { token, config: o.config, configPath: o.configPath, uiDir: o.uiDir ?? join(import.meta.dir, "../ui"), now: o.now ?? (() => new Date()), found: await discover(o.config), port: 0, hub: null as unknown as LiveHub, pick: o.pick,
    transcriptsRoot: o.transcriptsRoot, traceDir: o.traceDir === undefined ? process.env.AIDLC_HOOK_TRACE_DIR ?? null : o.traceDir };
  const server = Bun.serve({ hostname: "127.0.0.1", port: o.port ?? 0, idleTimeout: 0, fetch: (req) => handle(req, ctx) });
  ctx.port = server.port!;
  ctx.hub = new LiveHub(ctx); ctx.hub.start();
  return { url: `http://127.0.0.1:${ctx.port}/?t=${token}`, port: ctx.port, token, hub: ctx.hub, stop: () => { ctx.hub.stop(); server.stop(true); } };
}

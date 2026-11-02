import { readdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { contain } from "./paths";
/** The subset of `fs.watch` the source needs; injectable so tests can drive the error path. */
export type WatchFn = (path: string, opts: { recursive: boolean }, cb: (event: string, file: string | Buffer | null) => void) => { close(): void; on(event: "error", h: (e: Error) => void): unknown };
export class LocalFolderSource {
  constructor(readonly root: string, private watchFn: WatchFn = watch as unknown as WatchFn) {}
  private async safe(rel: string): Promise<string> { const p = await contain(this.root, join(this.root, rel)); if (!p) throw new Error(`outside workspace: ${rel}`); return p; }
  async read(rel: string): Promise<string> { return Bun.file(await this.safe(rel)).text(); }
  async list(rel: string) { return readdir(await this.safe(rel), { withFileTypes: true }); }
  async stat(rel: string) { return stat(await this.safe(rel)); }
  /** Recursive watch of `<root>/aidlc`, falling back to 10 s polling; `onMode` fires when a running watch falls back to poll. */
  watch(cb: (relPath: string) => void, onMode?: (mode: "watch" | "poll") => void): { close: () => void; mode: "watch" | "poll" } {
    let timer: ReturnType<typeof setInterval> | null = null;
    let w: ReturnType<WatchFn> | null = null;
    let closed = false;
    const poll = () => { timer = setInterval(() => cb("aidlc/"), 10_000); };
    try {
      w = this.watchFn(join(this.root, "aidlc"), { recursive: true }, (_e, f) => f && cb(`aidlc/${f.toString()}`));
      w.on("error", () => {
        try { w?.close(); } catch { /* already closed */ }
        w = null;
        if (closed || timer) return;
        poll(); onMode?.("poll");
      });
    } catch { poll(); }
    return {
      close: () => { closed = true; w?.close(); w = null; if (timer) clearInterval(timer); timer = null; },
      get mode() { return w ? "watch" as const : "poll" as const; },
    };
  }
}

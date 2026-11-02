import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { appendFile, chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../core/command-center/server/index";
import { LiveHub } from "../../core/command-center/server/live";
import { LocalFolderSource } from "../../core/command-center/server/source";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";

const SHARD = "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md";
const cfgPath = async () => join(await mkdtemp(join(tmpdir(), "cc-")), "c.json");
const cfgFor = (pins: string[]) => ({ version: 1 as const, roots: [], pins, hidden: [], repos: [], theme: "auto" as const });

/** Waits until the hub has primed its cursors, plus a short margin for the OS file watch to arm. */
const settled = async (s: { hub: LiveHub }) => { await s.hub.ready(); await Bun.sleep(150); };
/** Root ignores file modes, so chmod-000 cannot make a file unreadable there. */
const isRoot = process.getuid?.() === 0;

/** Collects SSE messages from `/api/stream` until `until(msgs)` holds or `ms` elapses. */
async function collect(port: number, token: string) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream?t=${token}`, { signal: ac.signal });
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const msgs: any[] = [];
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) { msgs.push(JSON.parse(buf.slice(0, i).replace(/^data: /, ""))); buf = buf.slice(i + 2); }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (pred: (m: any[]) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!pred(msgs) && Date.now() < end) await Bun.sleep(25);
    return pred(msgs);
  };
  return { res, msgs, waitFor, close: async () => { ac.abort(); await done; } };
}

test("appending an audit block pushes an intent delta and a home update over SSE", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [ws], hidden: [], repos: [], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
  const res = await fetch(`http://127.0.0.1:${s.port}/api/stream?t=${s.token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const seen: string[] = [];
  const pump = (async () => { while (true) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value); for (const m of buf.split("\n\n").slice(0, -1)) { const j = JSON.parse(m.replace(/^data: /, "")); seen.push(j.type); if (j.type === "intent") expect(j.newEvents[0].kind).toBe("GATE_APPROVED"); } buf = buf.slice(buf.lastIndexOf("\n\n") + 2); if (seen.includes("intent") && seen.includes("home")) return; } })();
  await settled(s);
  await appendFile(join(ws, "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md"), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "code-generation", Unit: "beta" }));
  await Promise.race([pump, Bun.sleep(8000)]);
  s.stop();
  expect(seen).toContain("hello");
  expect(seen).toContain("intent");
  expect(seen).toContain("home");
});

test("SSE response carries event-stream headers, the hello message and the current watch modes", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  expect(c.res.headers.get("content-type")).toBe("text/event-stream");
  expect(c.res.headers.get("cache-control")).toBe("no-store");
  expect(await c.waitFor((m) => m.some((x) => x.type === "watch"), 1000)).toBe(true);
  expect(c.msgs[0].type).toBe("hello");
  expect(c.msgs.find((x) => x.type === "watch")).toMatchObject({ ws, mode: expect.stringMatching(/^(watch|poll)$/) });
  await c.close(); s.stop();
});

test("intent delta carries only the appended events, the intent key and a full home payload", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  await appendFile(join(ws, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "code-generation", Unit: "beta", "User Input": "Approve" }) + block("2026-08-13T23:41:00Z", "SENSOR_PASSED", { Stage: "code-generation" }));
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent") && m.some((x) => x.type === "home"))).toBe(true);
  const d = c.msgs.find((x) => x.type === "intent");
  expect(d).toMatchObject({ ws, key: "default/260811-demo", reset: false, lastEventTs: "2026-08-13T23:41:00Z" });
  // SENSOR_PASSED is hidden from the story, exactly as in /api/intent.
  expect(d.newEvents.map((e: { kind: string }) => e.kind)).toEqual(["GATE_APPROVED"]);
  expect(d.newEvents[0]).toMatchObject({ stage: "code-generation", unit: "beta", text: "Approve" });
  const h = c.msgs.find((x) => x.type === "home");
  expect(h.payload.workspaces[0].intents[0].name).toBe("demo");
  await c.close(); s.stop();
});

test("a truncated shard is reported as a reset and re-read from the start", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  await writeFile(join(ws, SHARD), AUDIT_HEADER + block("2026-08-14T00:00:00Z", "STAGE_STARTED", { Stage: "nfr-requirements" }));
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
  const d = c.msgs.find((x) => x.type === "intent");
  expect(d.reset).toBe(true);
  expect(d.newEvents.map((e: { kind: string }) => e.kind)).toEqual(["STAGE_STARTED"]);
  await c.close(); s.stop();
});

test("an audit shard symlinked outside the workspace aidlc folder is never read", async () => {
  const ws = await makeWorkspace();
  const outside = await mkdtemp(join(tmpdir(), "cc-out-"));
  await writeFile(join(outside, "leak.md"), AUDIT_HEADER + block("2026-08-14T00:00:00Z", "GATE_APPROVED", { Stage: "secret" }));
  await symlink(join(outside, "leak.md"), join(ws, "aidlc/spaces/default/intents/260811-demo/audit/zz-leak.md"));
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  await appendFile(join(outside, "leak.md"), block("2026-08-14T00:01:00Z", "GATE_APPROVED", { Stage: "secret2" }));
  await appendFile(join(ws, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "code-generation" }));
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
  await Bun.sleep(400); // let any further (wrongly sourced) delta arrive
  const deltas = c.msgs.filter((x) => x.type === "intent");
  expect(deltas.flatMap((d) => d.newEvents.map((e: { stage: string }) => e.stage))).toEqual(["code-generation"]);
  await c.close(); s.stop();
});

test("PUT /api/config rewatches: the new workspace is watched and home is pushed with a payload", async () => {
  const a = await makeWorkspace(); const b = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([a]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  const put = await fetch(`http://127.0.0.1:${s.port}/api/config?t=${s.token}`, { method: "PUT", body: JSON.stringify(cfgFor([b])) });
  expect(put.status).toBe(200);
  expect(await c.waitFor((m) => m.some((x) => x.type === "home") && m.some((x) => x.type === "watch" && x.ws === b))).toBe(true);
  expect(c.msgs.find((x) => x.type === "home").payload.workspaces.map((w: { path: string }) => w.path)).toEqual([b]);
  c.msgs.length = 0;
  await settled(s);
  // The old workspace is no longer watched; the new one is, and its cursors were primed.
  await appendFile(join(a, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "old" }));
  await appendFile(join(b, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "new" }));
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
  await Bun.sleep(400);
  const deltas = c.msgs.filter((x) => x.type === "intent");
  expect(deltas.map((d) => d.ws)).toEqual([b]);
  expect(deltas[0].newEvents.map((e: { stage: string }) => e.stage)).toEqual(["new"]);
  await c.close(); s.stop();
});

test("a disconnected client is dropped without breaking broadcasts to the others", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const dead = await collect(s.port, s.token); const live = await collect(s.port, s.token);
  await dead.waitFor((m) => m.length > 0, 1000);
  await dead.close();
  await Bun.sleep(100);
  expect(() => s.hub.broadcast({ type: "ping", at: "x" })).not.toThrow();
  await appendFile(join(ws, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "code-generation" }));
  expect(await live.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
  await live.close(); s.stop();
});

test("a new intent directory created after start is picked up", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  const dir = join(ws, "aidlc/spaces/default/intents/260901-new/audit");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "hostc-cccccccccccc.md"), AUDIT_HEADER + block("2026-09-01T10:00:00Z", "STAGE_STARTED", { Stage: "intent-capture" }));
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent" && x.key === "default/260901-new"))).toBe(true);
  await c.close(); s.stop();
});

test("rewatch right after an append still delivers the delta exactly once", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  await appendFile(join(ws, SHARD), block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "kept" }));
  s.hub.rewatch(); // before the 250 ms debounce (or even the fs event) fires
  expect(await c.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
  await Bun.sleep(700);
  const deltas = c.msgs.filter((x) => x.type === "intent");
  expect(deltas.length).toBe(1);
  expect(deltas[0].newEvents.map((e: { stage: string }) => e.stage)).toEqual(["kept"]);
  await c.close(); s.stop();
});

test.skipIf(isRoot)("a shard that cannot be read while priming is not replayed as new history later", async () => {
  const ws = await makeWorkspace({ extraShard: AUDIT_HEADER + block("2026-08-12T10:00:00Z", "STAGE_STARTED", { Stage: "old-1" }) + block("2026-08-12T10:05:00Z", "STAGE_COMPLETED", { Stage: "old-2" }) });
  const B = join(ws, "aidlc/spaces/default/intents/260811-demo/audit/hostb-bbbbbbbbbbbb.md");
  await chmod(B, 0o000);
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  try {
    const c = await collect(s.port, s.token);
    await settled(s);
    await chmod(B, 0o644);
    await appendFile(B, block("2026-08-13T23:40:00Z", "GATE_APPROVED", { Stage: "fresh" }));
    expect(await c.waitFor((m) => m.some((x) => x.type === "intent"))).toBe(true);
    await Bun.sleep(400);
    const d = c.msgs.filter((x) => x.type === "intent");
    expect(d.flatMap((x) => x.newEvents.map((e: { stage: string }) => e.stage))).toEqual(["fresh"]);
    expect(d.every((x) => x.reset === false)).toBe(true);
    await c.close();
  } finally { s.stop(); await chmod(B, 0o644).catch(() => {}); }
});

test("a runtime watch error is announced as a switch to poll", async () => {
  const ws = await makeWorkspace();
  const fakes: EventEmitter[] = [];
  const fakeWatch = () => { const e = Object.assign(new EventEmitter(), { close() {} }); fakes.push(e); return e; };
  const hub = new LiveHub({ found: [{ path: ws, origin: "pin", root: null, exists: true }], now: () => new Date() }, (p) => new LocalFolderSource(p, fakeWatch));
  hub.start();
  const reader = hub.stream().body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const next = async () => { while (!buf.includes("\n\n")) buf += dec.decode((await reader.read()).value); const i = buf.indexOf("\n\n"); const m = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2); return m; };
  expect((await next()).type).toBe("hello");
  expect(await next()).toEqual({ type: "watch", ws, mode: "watch" });
  fakes[0]!.emit("error", new Error("EMFILE"));
  expect(await next()).toEqual({ type: "watch", ws, mode: "poll" });
  hub.stop();
});

test("a continuous stream of changes still flushes within about a second", async () => {
  const ws = await makeWorkspace();
  const s = await startServer({ port: 0, config: cfgFor([ws]), configPath: await cfgPath() });
  const c = await collect(s.port, s.token);
  await settled(s);
  let sawWhileAppending = false; // 18 appends 100 ms apart never leave a 250 ms quiet gap
  for (let i = 0; i < 18; i++) {
    await appendFile(join(ws, SHARD), block(`2026-08-13T23:40:${String(i).padStart(2, "0")}Z`, "GATE_APPROVED", { Stage: `s${i}` }));
    if (c.msgs.some((x) => x.type === "intent")) sawWhileAppending = true;
    await Bun.sleep(100);
  }
  expect(sawWhileAppending).toBe(true);
  await c.close(); s.stop();
}, 10_000);

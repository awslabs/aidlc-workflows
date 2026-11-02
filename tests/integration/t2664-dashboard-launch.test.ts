// covers: tool:aidlc-dashboard, route:top-dashboard, integration:launch
//
// Launches `aidlc dashboard` through the projected Claude dispatcher, the way
// an install runs it, against a synthetic AI-DLC project, and checks the
// loopback posture, the token gate, discovery, live updates and shutdown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, makeWorkspace } from "../../command-center/tests/fixtures/make.ts";

const REPO = join(import.meta.dir, "../..");
const DISPATCHER = join(REPO, "dist", "claude", ".claude", "tools", "aidlc.ts");

let scratch = "";
let project = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let token = "";
let url = "";
let stopped = false;

// Bun's fetch sets Host from the URL; node:http lets the test send a foreign one.
function getWithHost(path: string, host: string): Promise<number> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "aidlc-dash-it-"));
  project = await makeWorkspace();
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  const child = Bun.spawn(
    [process.execPath, DISPATCHER, "dashboard", "--json", "--no-open", "--port", "0", "--config", join(scratch, "dash.json")],
    { cwd: project, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: scratch } },
  );
  proc = child;
  const reader = child.stdout.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  url = (JSON.parse(buf.split("\n")[0] as string) as { url: string }).url;
  const parsed = new URL(url);
  base = `${parsed.protocol}//${parsed.host}`;
  token = parsed.searchParams.get("t") ?? "";
}, 60_000);

afterAll(() => {
  if (!stopped) proc?.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("aidlc dashboard, launched through the projected dispatcher", () => {
  test("prints a loopback URL carrying a per-run token", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{32}$/);
  });

  test("the page needs the token", async () => {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/api/home?t=wrong`)).status).toBe(401);
  });

  test("a foreign Host header is refused (DNS rebinding)", async () => {
    expect(await getWithHost(`/?t=${token}`, "evil.example")).toBe(421);
  });

  test("responses carry the security headers", async () => {
    const r = await fetch(url);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("the launch folder is auto-pinned and its intent is discovered", async () => {
    const saved = JSON.parse(await Bun.file(join(scratch, "dash.json")).text()) as { pins: string[] };
    expect(saved.pins).toEqual([realpathSync(project)]);
    const home = await (await fetch(`${base}/api/home?t=${token}`)).text();
    expect(home).toContain("260811-demo");
  });

  test("a file outside the workspace records is not served", async () => {
    const q = new URLSearchParams({ t: token, ws: project, path: "../../../../../etc/hosts" });
    expect((await fetch(`${base}/api/file?${q}`)).status).toBe(404);
  });

  test("an appended audit entry is pushed live", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?t=${token}`, { signal: ac.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const seen: string[] = [];
    let buf = "";
    const pump = (async () => {
      while (!seen.includes("intent")) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (const m of buf.split("\n\n").slice(0, -1)) {
          seen.push((JSON.parse(m.replace(/^data: /, "")) as { type: string }).type);
        }
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    })();
    await Bun.sleep(300);
    appendFileSync(
      join(project, "aidlc/spaces/default/intents/260811-demo/audit/hosta-aaaaaaaaaaaa.md"),
      block("2026-08-14T09:00:00Z", "GATE_APPROVED", { Stage: "code-generation", Unit: "beta" }),
    );
    await Promise.race([pump, Bun.sleep(10_000)]);
    ac.abort();
    expect(seen).toContain("intent");
  }, 20_000);

  test("SIGTERM stops it with exit 0 and closes the port", async () => {
    stopped = true;
    proc?.kill("SIGTERM");
    expect(await proc?.exited).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
  });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../core/command-center/server/index";
import { makeWorkspace } from "./fixtures/make";

let s: Awaited<ReturnType<typeof startServer>>; let ws: string; let cfgPath: string;
const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}${p.includes("?") ? "&" : "?"}t=${s.token}`, init);
beforeAll(async () => {
  ws = await makeWorkspace({ questions: { "ideation/feasibility/feasibility-questions.md": "## Q1. Build?\n- A. Yes\n- B. No\n\n[Answer]: A\n" } });
  s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [ws], hidden: [], repos: [], theme: "auto" }, configPath: (cfgPath = join(await mkdtemp(join(tmpdir(), "cc-")), "c.json")), now: () => new Date("2026-08-13T23:21:00Z") });
});
afterAll(() => s.stop());

test("home lists the workspace", async () => {
  const h = await (await get("/api/home")).json();
  expect(h.workspaces[0].intents[0].name).toBe("demo");
});
test("meta names the settings file this run saves to", async () => {
  expect(await (await get("/api/meta")).json()).toEqual({ configPath: cfgPath });
  expect((await get("/api/meta", { method: "POST" })).status).toBe(405);
  expect((await fetch(`http://127.0.0.1:${s.port}/api/meta`)).status).toBe(401);
});
test("token required", async () => {
  expect((await fetch(`http://127.0.0.1:${s.port}/api/home`)).status).toBe(401);
});
test("foreign Host header refused", async () => {
  expect((await get("/api/home", { headers: { host: "evil.example:80" } })).status).toBe(421);
});
test("decisions lens returns questions with options and chosen answer", async () => {
  const d = await (await get(`/api/lens/decisions?ws=${encodeURIComponent(ws)}&key=default/260811-demo`)).json();
  const q = d.groups.find((g: { stage: string }) => g.stage === "feasibility").questions[0];
  expect(q.options.map((o: { key: string }) => o.key)).toEqual(["A", "B"]);
  expect(q.answer).toBe("A");
});
test("artifacts lens says the synthetic record is not in a git repo", async () => {
  const artifacts = await (await get(`/api/lens/artifacts?ws=${encodeURIComponent(ws)}&key=default/260811-demo`)).json();
  expect(artifacts.isGit).toBe(false);
});
test("artifact path traversal refused", async () => {
  const r = await get(`/api/artifact?ws=${encodeURIComponent(ws)}&key=default/260811-demo&path=${encodeURIComponent("../../../../../etc/hosts")}`);
  expect(r.status).toBe(404);
});
test("unknown workspace refused", async () => {
  expect((await get(`/api/intent?ws=${encodeURIComponent("/etc")}&key=x/y`)).status).toBe(404);
});
test("CSP header present", async () => {
  expect((await get("/api/home")).headers.get("content-security-policy")).toContain("default-src 'self'");
});

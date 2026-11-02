import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../core/command-center/server/index";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";

type S = Awaited<ReturnType<typeof startServer>>;
let s: S; let ws: string; let ws2: string; let ws3: string; let ui: string; let cfgPath: string;
const KEY = "default/260811-demo";
const REC = (w: string) => join(w, "aidlc/spaces/default/intents/260811-demo");
const q = (w: string, extra = "") => `ws=${encodeURIComponent(w)}&key=${encodeURIComponent(KEY)}${extra}`;
const get = (p: string, init?: RequestInit, srv = s) => fetch(`http://127.0.0.1:${srv.port}${p}${p.includes("?") ? "&" : "?"}t=${srv.token}`, init);

beforeAll(async () => {
  ws = await makeWorkspace({ questions: {
    "ideation/feasibility/feasibility-questions.md": "## Q1. Build?\n- A. Yes\n- B. No\n\n[Answer]: A\n",
    "construction/beta/functional-design/functional-design-questions.md": "## Q1. Store?\n- A. SQL\n- X. Other\n\n[Answer]: X. flat files\n",
    "construction/beta/functional-design/memory.md": "## Open questions\n- Is beta in scope?\n",
    "construction/build-and-test/build-and-test-questions.md": "## Q1. Run e2e?\n- A. Yes\n- B. No\n\n[Answer]: B\n",
    "inception/requirements-analysis/requirements.md": "# Req\n\n## Review\n**Verdict**: NOT-READY\n\n| # | Severity | Location | Finding |\n|---|---|---|---|\n| 1 | Major | §2 | Missing NFRs |\n",
  }, extraShard: AUDIT_HEADER
    + block("2026-08-13T10:00:00Z", "GATE_APPROVED", { Stage: "build-and-test" })
    + block("2026-08-13T11:00:00Z", "GATE_APPROVED", { Stage: "functional-design", Unit: "beta" })
    + block("2026-08-13T11:05:00Z", "PLAN_APPROVAL_RECORDED", { Stage: "functional-design", Unit: "beta" })
    + block("2026-08-13T11:10:00Z", "DECISION_RECORDED", { Stage: "functional-design", Unit: "beta", Decision: "Pick storage", Options: "SQL, Flat files" }) });
  await writeFile(join(ws, "aidlc/spaces/default/memory/team.md"), "## Mandated\n- ALWAYS test\n- ALWAYS lint\n## Forbidden\n- NEVER guess\n## Corrections\n- not a practice\n");
  await symlink("/etc", join(REC(ws), "escape"));
  ws2 = await makeWorkspace({ withLedger: false });
  // ws3: memory/, audit/, review records and the session ledger are symlinks to folders outside the workspace.
  ws3 = await makeWorkspace({ questions: { "inception/requirements-analysis/requirements.md": "# Req\n" } });
  const out = await mkdtemp(join(tmpdir(), "cc-outside-"));
  await mkdir(join(out, "memory")); await writeFile(join(out, "memory/project.md"), "- Outside rule <!-- cid:feasibility:c9 -->\n");
  await mkdir(join(out, "audit")); await writeFile(join(out, "audit/h-cccccccccccc.md"), AUDIT_HEADER + block("2026-08-12T10:00:00Z", "REVIEW_COMPLETED", { Stage: "feasibility", Verdict: "READY" }) + block("2026-08-12T10:00:00Z", "STAGE_COMPLETED", { Stage: "feasibility", "Tokens In": "5", "Tokens Out": "1" }));
  await mkdir(join(out, "reviews/feasibility"), { recursive: true }); await writeFile(join(out, "reviews/feasibility/1.json"), JSON.stringify({ stage: "feasibility", verdict: "NOT-READY", findings: [{ severity: "Major", finding: "outside" }] }));
  await mkdir(join(out, "sessions")); await writeFile(join(out, "sessions/usage-ledger.json"), await readFile(join(ws, "aidlc/.aidlc-sessions/usage-ledger.json"), "utf8"));
  await rm(join(ws3, "aidlc/spaces/default/memory"), { recursive: true }); await symlink(join(out, "memory"), join(ws3, "aidlc/spaces/default/memory"));
  await rm(join(REC(ws3), "audit"), { recursive: true }); await symlink(join(out, "audit"), join(REC(ws3), "audit"));
  await mkdir(join(REC(ws3), ".aidlc-engine"), { recursive: true }); await symlink(join(out, "reviews"), join(REC(ws3), ".aidlc-engine/reviews"));
  await rm(join(ws3, "aidlc/.aidlc-sessions"), { recursive: true }); await symlink(join(out, "sessions"), join(ws3, "aidlc/.aidlc-sessions"));
  ui = await mkdtemp(join(tmpdir(), "cc-ui-"));
  await mkdir(join(ui, "assets"), { recursive: true });
  await writeFile(join(ui, "index.html"), "<!doctype html><title>cc</title>");
  await writeFile(join(ui, "assets/app.js"), "console.log(1)");
  await writeFile(join(ui, "secret.txt"), "outside assets");
  cfgPath = join(await mkdtemp(join(tmpdir(), "cc-")), "c.json");
  s = await startServer({ port: 0, config: { version: 1, roots: [], pins: [ws, ws2, ws3], hidden: [], repos: [], theme: "auto" }, configPath: cfgPath, uiDir: ui, now: () => new Date("2026-08-13T23:21:00Z") });
});
afterAll(() => s.stop());

test("x-cc-token header is accepted; a wrong token is refused", async () => {
  expect((await fetch(`http://127.0.0.1:${s.port}/api/home`, { headers: { "x-cc-token": s.token } })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${s.port}/api/home?t=${s.token}x`)).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${s.port}/?t=nope`)).status).toBe(401);
});
test("localhost Host is accepted; portless or foreign Host is 421 even for assets", async () => {
  expect((await get("/api/home", { headers: { host: `localhost:${s.port}` } })).status).toBe(200);
  expect((await get("/api/home", { headers: { host: "127.0.0.1" } })).status).toBe(421);
  expect((await fetch(`http://127.0.0.1:${s.port}/assets/app.js`, { headers: { host: "evil.example" } })).status).toBe(421);
});
test("security headers on success and refusal; no-store on the API", async () => {
  for (const r of [await get("/api/home"), await fetch(`http://127.0.0.1:${s.port}/api/home`)]) {
    expect(r.headers.get("content-security-policy")).toBe("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
});
test("ws must exactly equal a discovered path; key must be a listed intent", async () => {
  expect((await get(`/api/intent?${q(ws)}`)).status).toBe(200);
  expect((await get(`/api/intent?${q(ws + "/")}`)).status).toBe(404);
  expect((await get(`/api/intent?ws=${encodeURIComponent(ws)}&key=default/nope`)).status).toBe(404);
  expect((await get(`/api/lens/artifacts?ws=${encodeURIComponent(ws)}`)).status).toBe(404);
});
test("a registry dirName that escapes aidlc/ is refused", async () => {
  const reg = join(ws2, "aidlc/spaces/default/intents/intents.json");
  const list = JSON.parse(await readFile(reg, "utf8"));
  await writeFile(reg, JSON.stringify([...list, { uuid: "u-x", slug: "x", dirName: "../../../../.." }]));
  expect((await get(`/api/lens/artifacts?ws=${encodeURIComponent(ws2)}&key=${encodeURIComponent("default/../../../../..")}`)).status).toBe(404);
  await writeFile(reg, JSON.stringify(list));
});
test("artifact: contained file served with kind and provenance", async () => {
  const r = await get(`/api/artifact?${q(ws, "&path=" + encodeURIComponent("construction/beta/code-generation/code-generation-plan.md"))}`);
  expect(r.status).toBe(200);
  const a = await r.json();
  expect(a.kind).toBe("md"); expect(a.body).toBe("# Plan\n");
  expect(a.provenance).toEqual({ stage: "code-generation", agent: "developer", edits: 1, created: "2026-08-13T23:20:00Z" });
});
test("artifact: symlink escape, absolute path, directory and missing file are 404", async () => {
  for (const p of ["escape/hosts", "/etc/hosts", "construction", "nope.md", "audit/../../../../../../etc/hosts"])
    expect((await get(`/api/artifact?${q(ws, "&path=" + encodeURIComponent(p))}`)).status).toBe(404);
});
test("artifacts tree excludes dotfiles, audit, state and symlinks; counts edits", async () => {
  const { tree, truncated } = await (await get(`/api/lens/artifacts?${q(ws)}`)).json();
  expect(truncated).toBe(false);
  const paths = tree.map((e: { path: string }) => e.path);
  expect(paths).toContain("construction/beta/code-generation/code-generation-plan.md");
  expect(paths.some((p: string) => p.startsWith(".") || p.startsWith("audit") || p === "aidlc-state.md" || p.startsWith("escape"))).toBe(false);
  const plan = tree.find((e: { path: string }) => e.path.endsWith("code-generation-plan.md"));
  expect(plan.edits).toBe(1); expect(plan.stage).toBe("code-generation"); expect(plan.agent).toBe("developer"); expect(plan.dir).toBe(false);
  expect(tree.find((e: { path: string }) => e.path === "construction").agent).toBeNull();
});
test("decisions: unit from construction path, free-text Other, gate attached", async () => {
  const { groups } = await (await get(`/api/lens/decisions?${q(ws)}`)).json();
  const fd = groups.find((g: { stage: string }) => g.stage === "functional-design");
  expect(fd.unit).toBe("beta");
  expect(fd.questions[0].answer).toBe("X"); expect(fd.questions[0].answerText).toBe("flat files");
  const fe = groups.find((g: { stage: string }) => g.stage === "feasibility");
  expect(fe.unit).toBeNull(); expect(fe.gate.event).toBe("GATE_APPROVED"); expect(fe.gate.kind).toBe("gate");
});
test("decisions: construction/<stage>/ with no unit folder is a stage-level group", async () => {
  const { groups } = await (await get(`/api/lens/decisions?${q(ws)}`)).json();
  const bt = groups.find((g: { stage: string }) => g.stage === "build-and-test");
  expect(bt.unit).toBeNull(); expect(bt.questions[0].answer).toBe("B");
  expect(bt.gate.ts).toBe("2026-08-13T10:00:00Z"); expect(bt.gate.kind).toBe("gate");
});
test("decisions: a later plan approval closes the group; DECISION_RECORDED listed as agent decisions", async () => {
  const d = await (await get(`/api/lens/decisions?${q(ws)}`)).json();
  const fd = d.groups.find((g: { stage: string }) => g.stage === "functional-design");
  expect(fd.gate.event).toBe("PLAN_APPROVAL_RECORDED"); expect(fd.gate.kind).toBe("plan");
  expect(d.agentDecisions).toEqual([{ ts: "2026-08-13T11:10:00Z", stage: "functional-design", unit: "beta", decision: "Pick storage", answerText: null, unassigned: [], unresolved: false, strayAnswers: [],
    questions: [{ id: "", title: "Pick storage", options: ["SQL", "Flat files"], answer: null, answerRaw: null }] }]);
});
test("symlinked memory/, audit/, review records and ledger outside the workspace are not read", async () => {
  const l = await (await get(`/api/lens/learnings?${q(ws3)}`)).json();
  expect(l.rules).toEqual([]);
  const r = await (await get(`/api/lens/reviews?${q(ws3)}`)).json();
  expect(r.verdicts).toEqual([]); expect(r.findings).toEqual([]);
  const t = await (await get(`/api/lens/tokens?${q(ws3)}`)).json();
  expect(t.recorded).toBe(false);
  const m = await (await get(`/api/intent?${q(ws3)}`)).json();
  expect(m.events).toEqual([]); expect(m.tokens.recorded).toBe(false);
});
test("reviews: verdict events plus embedded findings when no review records exist", async () => {
  const r = await (await get(`/api/lens/reviews?${q(ws)}`)).json();
  expect(r.verdicts.length).toBe(3);
  expect(r.findings).toEqual([{ severity: "Major", location: "§2", finding: "Missing NFRs", status: null, stage: null, unit: null, file: "inception/requirements-analysis/requirements.md" }]);
});
test("learnings: rules, per-stage counts, stage notes and practices", async () => {
  const l = await (await get(`/api/lens/learnings?${q(ws)}`)).json();
  expect(l.rules.length).toBe(2);
  expect(l.perStage).toEqual({ "intent-capture": 1, feasibility: 1 });
  expect(l.notes).toEqual([{ stage: "functional-design", memory: { interpretations: [], deviations: [], tradeoffs: [], openQuestions: ["Is beta in scope?"] } }]);
  expect(l.practices).toEqual({ mandated: 2, forbidden: 1 });
});
test("tokens: ledger when present, STAGE_COMPLETED fallback otherwise", async () => {
  const a = await (await get(`/api/lens/tokens?${q(ws)}`)).json();
  expect(a.recorded).toBe(true); expect(a.value.totals.input).toBe(1000);
  const b = await (await get(`/api/lens/tokens?${q(ws2)}`)).json();
  expect(b.recorded).toBe(true); expect(b.source).toBe("audit");
  expect(b.value.byStage["intent-capture"]).toEqual({ input: 58502812, output: 105238, cacheRead: 0, cacheWrite: 0 });
});
test("static: assets untokened and contained; index needs the token", async () => {
  const a = await fetch(`http://127.0.0.1:${s.port}/assets/app.js`);
  expect(a.status).toBe(200); expect(await a.text()).toBe("console.log(1)");
  expect((await fetch(`http://127.0.0.1:${s.port}/assets/..%2fsecret.txt`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${s.port}/assets/%2e%2e/secret.txt`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${s.port}/secret.txt?t=${s.token}`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(401);
  const i = await get("/"); expect(i.status).toBe(200); expect(await i.text()).toContain("<title>cc</title>");
});
test("non-GET on read routes is 405", async () => {
  expect((await get("/api/home", { method: "POST" })).status).toBe(405);
});
test("config: GET, PUT validates and saves, bad JSON is 400, re-discovers", async () => {
  expect((await (await get("/api/config")).json()).pins).toEqual([ws, ws2, ws3]);
  expect((await get("/api/config", { method: "PUT", body: "{nope" })).status).toBe(400);
  expect((await get("/api/config", { method: "PUT", body: "[1]" })).status).toBe(400);
  const r = await get("/api/config", { method: "PUT", body: JSON.stringify({ pins: [ws, 7], theme: "neon", extra: true }) });
  expect(r.status).toBe(200);
  const saved = JSON.parse(await readFile(cfgPath, "utf8"));
  expect(saved).toEqual({ version: 1, roots: [], pins: [ws], hidden: [], repos: [], theme: "auto" });
  const h = await (await get("/api/home")).json();
  expect(h.workspaces.map((w: { path: string }) => w.path)).toEqual([ws]);
  expect((await get(`/api/intent?${q(ws2)}`)).status).toBe(404);
});

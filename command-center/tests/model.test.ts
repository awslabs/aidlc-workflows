import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildIntent, recordDirOf } from "../../core/command-center/server/model/intent";
import { HIDDEN_EVENTS, storyEvents } from "../../core/command-center/server/model/story";
import { lensCtx, tokensLens } from "../../core/command-center/server/lenses";
import { buildHome } from "../../core/command-center/server/model/home";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import { AUDIT_HEADER, block, DEFAULT_AUDIT, makeWorkspace } from "./fixtures/make";

const NOW = new Date("2026-08-13T23:21:00Z");
async function model(opts = {}) {
  const ws = await makeWorkspace(opts); const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  return { ws, m: await buildIntent(ws, ref!, cat.stages, NOW) };
}

test("progress uses the EXECUTE denominator; skips are separate", async () => {
  const { m } = await model();
  expect(m.plannedCount).toBe(6);
  expect(m.skippedCount).toBe(1);
  expect(m.doneCount).toBe(3); // workspace-scaffold, intent-capture, feasibility
});
test("first start is the original, not the redo start; redos counted", async () => {
  const { m } = await model();
  const ic = m.stages.find((s) => s.slug === "intent-capture")!;
  expect(ic.firstStart).toBe("2026-08-11T21:46:00Z");
  expect(ic.redos).toBe(1);
});
test("current position comes from the directive and the lag is noted", async () => {
  const { m } = await model();
  expect(m.current).toEqual({ stage: "code-generation", unit: "beta", phase: "construction" });
  expect(m.notes.some((n) => n.includes("state file lags the audit"))).toBe(true);
});
test("units: inferred cell when only a READY review exists", async () => {
  const { m } = await model();
  const alpha = m.units.find((u) => u.name === "alpha")!;
  expect(alpha.cells["functional-design"]).toBe("done");
  expect(alpha.cells["code-generation"]).toBe("inferred");
  expect(m.units.find((u) => u.name === "beta")!.cells["code-generation"]).toBe("running");
});
test("liveness active within 2 minutes of the newest event", async () => {
  const { m } = await model();
  expect(m.liveness).toBe("active");
});
test("blank answer in the current stage's questions file is a need", async () => {
  const { m } = await model({ questions: { "construction/beta/code-generation/code-generation-questions.md": "## Q1: Steps?\n- A. Four\n- X. Other (please specify)\n\n[Answer Q1]:\n" } });
  expect(m.needs).toEqual([expect.objectContaining({ kind: "question", stage: "code-generation", unit: "beta" })]);
  expect(m.stages.find((s) => s.slug === "code-generation")!.state).toBe("waiting");
});
test("tokens from the ledger; not recorded without it", async () => {
  expect((await model()).m.tokens).toEqual({ recorded: true, value: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } });
  const t = (await model({ withLedger: false })).m.tokens;
  expect(t.recorded).toBe(true); // falls back to STAGE_COMPLETED token fields
  expect(t.recorded && t.value.input).toBe(58502812);
});
test("home: workspace summary with needs and rules learned", async () => {
  const ws = await makeWorkspace();
  const h = await buildHome([{ path: ws, origin: "root", root: join(ws, ".."), exists: true }, { path: "/missing", origin: "pin", root: null, exists: false }], NOW);
  expect(h.workspaces[0]!.intents).toHaveLength(1);
  expect(h.workspaces[0]!.rulesLearned).toBe(2);
  expect(h.workspaces[1]!.status).toBe("missing");
});

const A = (...b: string[]) => AUDIT_HEADER + b.join("");
const gates = async (audit: string, extra = {}) => (await model({ audit, ...extra })).m.needs.filter((n) => n.kind === "gate");
const AWAIT = block("2026-08-13T23:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "feasibility" });

test("needs: open gate, closed by approval, closed by completion, unit-tolerant", async () => {
  expect(await gates(A(AWAIT))).toEqual([expect.objectContaining({ stage: "feasibility", unit: null })]);
  expect(await gates(A(AWAIT, block("2026-08-13T23:01:00Z", "GATE_APPROVED", { Stage: "feasibility" })))).toHaveLength(0);
  expect(await gates(A(AWAIT, block("2026-08-13T23:01:00Z", "STAGE_COMPLETED", { Stage: "feasibility" })))).toHaveLength(0);
  const u = block("2026-08-13T23:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "feasibility", Unit: "alpha" });
  expect(await gates(A(u, block("2026-08-13T23:01:00Z", "GATE_APPROVED", { Stage: "feasibility" })))).toHaveLength(0);
  expect(await gates(A(u, block("2026-08-13T23:01:00Z", "GATE_APPROVED", { Stage: "feasibility", Unit: "beta" })))).toHaveLength(1);
  const slug = block("2026-08-13T23:00:00Z", "STAGE_AWAITING_APPROVAL", { "Stage slug": "feasibility" });
  expect(await gates(A(slug))).toHaveLength(1);
  expect(await gates(A(slug, block("2026-08-13T23:01:00Z", "GATE_REJECTED", { Stage: "feasibility" })))).toHaveLength(0);
  expect(await gates(A(AWAIT, block("2026-08-13T23:01:00Z", "STAGE_JUMPED", { Target: "feasibility" })))).toHaveLength(0);
});
test("needs: directive kind present-gate yields a gate need; no kind changes nothing", async () => {
  const g = await gates(A(block("2026-08-13T23:00:00Z", "STAGE_STARTED", { Stage: "feasibility" })), { directive: { stage: "feasibility", kind: "present-gate" } });
  expect(g).toEqual([expect.objectContaining({ stage: "feasibility" })]);
  expect(g[0]!.since).toMatch(/Z$/);
  expect((await model({ directive: { stage: "code-generation", unit: "beta", kind: "ask" } })).m.needs).toEqual([expect.objectContaining({ kind: "question", unit: "beta" })]);
  // The engine's real shape: Plan Approval is an ask with ask_type "plan-approval".
  const plan = (await model({ directive: { stage: "code-generation", unit: "beta", kind: "ask", ask_type: "plan-approval" } })).m.needs[0]!;
  expect(plan).toMatchObject({ kind: "plan", detail: "Plan awaiting approval" });
  const ask = (await model({ directive: { stage: "code-generation", unit: "beta", kind: "ask", ask_type: "stage-questions" } })).m.needs[0]!;
  expect(ask).toMatchObject({ kind: "question", detail: "Agent is asking a question" });
  expect((await model()).m.needs).toEqual([]);
});
test("liveness idle and ended", async () => {
  expect((await model({ audit: A(block("2026-08-13T20:00:00Z", "STAGE_STARTED", { Stage: "feasibility" })) })).m.liveness).toBe("idle");
  expect((await model({ audit: A(block("2026-08-13T20:00:00Z", "SESSION_ENDED", {})) })).m.liveness).toBe("ended");
});
test("a session that ended seconds ago is ended, not active; activity after it is active again", async () => {
  expect((await model({ audit: A(block("2026-08-13T23:20:30Z", "SESSION_ENDED", {})) })).m.liveness).toBe("ended");
  const resumed = A(block("2026-08-13T23:20:00Z", "SESSION_ENDED", {}) + block("2026-08-13T23:20:40Z", "SESSION_STARTED", {}));
  expect((await model({ audit: resumed })).m.liveness).toBe("active");
});
test("directive sources: engine path wins, legacy used alone, none falls back to audit", async () => {
  expect((await model({ engineDirective: { stage: "feasibility", unit: null } })).m.current.stage).toBe("feasibility");
  expect((await model()).m.current).toEqual({ stage: "code-generation", unit: "beta", phase: "construction" });
  const { m } = await model({ directive: null });
  expect(m.current.stage).toBe("code-generation");
  expect(m.current.unit).toBe("beta");
  const s = await model({ directive: null, audit: A(block("2026-08-13T20:00:00Z", "STAGE_STARTED", { Stage: "feasibility" })) });
  expect(s.m.current).toEqual({ stage: "feasibility", unit: null, phase: "ideation" });
});
test("units: READY review does not overwrite a paused cell", async () => {
  const { m } = await model({ audit: A(
    block("2026-08-13T20:00:00Z", "UNIT_STARTED", { Stage: "code-generation", Unit: "gamma" }),
    block("2026-08-13T20:01:00Z", "UNIT_PAUSED", { Stage: "code-generation", Unit: "gamma" }),
    block("2026-08-13T20:02:00Z", "REVIEW_COMPLETED", { Stage: "code-generation", Unit: "gamma", Verdict: "READY" }),
    block("2026-08-13T20:03:00Z", "STAGE_STARTED", { Stage: "feasibility" })), directive: null });
  expect(m.units.find((u) => u.name === "gamma")!.cells["code-generation"]).toBe("paused");
});

test("unitsPlanned is null when unit-of-work.md is absent", async () => {
  const { m } = await model();
  expect(m.unitsPlanned).toBeNull();
});
async function plannedFor(md: string) {
  const ws = await makeWorkspace({ questions: { "inception/units-generation/unit-of-work.md": md } });
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  return (await buildIntent(ws, ref!, cat.stages, NOW)).unitsPlanned;
}
test("unitsPlanned counts numbered `## 1. \`name\` — kind` headings", async () => {
  expect(await plannedFor("# Units\n## Sources\n- x\n## 1. `synthetic-pipeline` — kind `service`, size M\n### Responsibilities\n## 2. `synthetic-ui` — kind `ui`, size S\n## Boundary strategy\n")).toBe(2);
});
test("unitsPlanned counts `### name — kind: spec` headings, distinct names", async () => {
  expect(await plannedFor("# Units\n## Unit inventory\n### shared-contract — kind: spec — complexity: S\n### edge-api — kind: service — complexity: M\n### alpha-lib — kind: library — complexity: S\n### shared-contract — kind: spec — complexity: S\n")).toBe(3);
});
test("unitsPlanned prefers a Unit ID table's data rows", async () => {
  expect(await plannedFor("# Units\n| Unit ID | Directory | Name |\n|---|---|---|\n| U1 | u1-core | core |\n| U2 | u2-ui | ui |\n\n## 1. `core` — kind `service`\n")).toBe(2);
});
test("unitsPlanned is null for prose-only unit-of-work.md", async () => {
  expect(await plannedFor("# Units\n## Overview\nText.\n## Units\nMore text.\n## Boundary strategy\n")).toBeNull();
});

test("home: a symlinked memory/ escaping the workspace is not counted", async () => {
  const { mkdir, mkdtemp, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const ws = await makeWorkspace(); const out = await mkdtemp(join(tmpdir(), "cc-outside-"));
  await mkdir(join(out, "memory")); await writeFile(join(out, "memory/project.md"), "- Outside rule (learned 2026-08-12) <!-- cid:feasibility:c9 -->\n");
  await rm(join(ws, "aidlc/spaces/default/memory"), { recursive: true }); await symlink(join(out, "memory"), join(ws, "aidlc/spaces/default/memory"));
  const h = await buildHome([{ path: ws, origin: "pin", root: null, exists: true }], NOW);
  expect(h.workspaces[0]!.rulesLearned).toBe(0); expect(h.workspaces[0]!.sampleRule).toBeNull();
});
test("needs: a symlinked questions file escaping the workspace yields no need", async () => {
  const { mkdtemp, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const ws = await makeWorkspace(); const out = await mkdtemp(join(tmpdir(), "cc-outside-"));
  await writeFile(join(out, "q.md"), "## Q1: Steps?\n- A. Four\n\n[Answer Q1]:\n");
  await symlink(join(out, "q.md"), join(ws, "aidlc/spaces/default/intents/260811-demo/construction/beta/code-generation/code-generation-questions.md"));
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  expect((await buildIntent(ws, ref!, cat.stages, NOW)).needs).toEqual([]);
});
test("hiddenCounts: sensor passes/fires and human turns folded out of events are counted per stage", async () => {
  const audit = AUDIT_HEADER
    + block("2026-08-11T21:46:00Z", "STAGE_STARTED", { Stage: "intent-capture" })
    + block("2026-08-11T21:47:00Z", "SENSOR_PASSED", { "Stage slug": "intent-capture" })
    + block("2026-08-11T21:47:01Z", "SENSOR_PASSED", { "Stage slug": "intent-capture" })
    + block("2026-08-11T21:47:02Z", "SENSOR_FIRED", { "Stage slug": "intent-capture" })
    + block("2026-08-11T21:48:00Z", "HUMAN_TURN", { Stage: "intent-capture" })
    + block("2026-08-11T21:49:00Z", "HUMAN_TURN", {});
  const { m } = await model({ audit });
  expect(m.hiddenCounts["intent-capture"]).toEqual({ sensorPassed: 2, sensorFired: 1, humanTurns: 1 });
  expect(m.hiddenCounts["_"]).toEqual({ sensorPassed: 0, sensorFired: 0, humanTurns: 1 });
  expect(m.events.some((e) => e.kind === "SENSOR_PASSED" || e.kind === "HUMAN_TURN")).toBe(false);
});

test("a malformed Tokens In is ignored identically by the intent model and the tokens lens (never NaN)", async () => {
  const audit = DEFAULT_AUDIT + block("2026-08-13T23:21:00Z", "STAGE_COMPLETED", { Stage: "feasibility", "Tokens In": "oops", "Tokens Out": "7" })
    + block("2026-08-13T23:22:00Z", "STAGE_COMPLETED", { Stage: "feasibility", "Tokens In": "Infinity", "Tokens Out": "9" });
  const { ws, m } = await model({ withLedger: false, audit });
  expect(m.tokens).toEqual({ recorded: true, value: { input: 58502812, output: 105238, cacheRead: 0, cacheWrite: 0 } });
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  const t = await tokensLens(await lensCtx(ws, ref!, recordDirOf(ws, ref!), cat.stages));
  expect(t.recorded && t.value.totals).toEqual(m.tokens.recorded && m.tokens.value);
  expect(JSON.stringify([m, t])).not.toMatch(/NaN|null,"output"/);
});
test("the story projection is one function shared by /api/intent and live deltas", async () => {
  const { m } = await model({ audit: DEFAULT_AUDIT + block("2026-08-13T23:21:00Z", "SENSOR_PASSED", { Stage: "x" }) });
  const raw = m.events.map((e) => e.raw);
  expect(storyEvents([...raw, { ...raw[0]!, event: "HUMAN_TURN" }])).toEqual(m.events);
  expect(HIDDEN_EVENTS.has("SENSOR_PASSED")).toBe(true);
});

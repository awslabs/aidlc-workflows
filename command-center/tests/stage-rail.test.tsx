import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { summarize } from "../../core/command-center/server/model/home";
import { buildIntent } from "../../core/command-center/server/model/intent";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import { IntentCard } from "../ui/src/home/IntentCard";
import { StageRail } from "../ui/src/intent/StageRail";
import { block, DEFAULT_AUDIT, GRAPH, makeWorkspace, STATE_MD } from "./fixtures/make";

const NOW = new Date("2026-08-13T23:21:00Z");
const PER_UNIT = new Set(["functional-design", "nfr-requirements", "code-generation"]);

test("once units exist, the construction rail still lists stage-level stations such as Build and Test", async () => {
  const state = STATE_MD.replace("- [ ] code-generation — EXECUTE\n", "- [ ] code-generation — EXECUTE\n- [ ] build-and-test — EXECUTE\n");
  expect(state).toContain("build-and-test");
  const ws = await makeWorkspace({ state });
  const graph = [...GRAPH.map((s) => (PER_UNIT.has(s.slug) ? { ...s, for_each: "unit-of-work" } : s)),
    { slug: "build-and-test", name: "Build and Test", phase: "construction", lead_agent: "aidlc-quality-agent", number: 8 }];
  await writeFile(join(ws, ".claude/tools/data/stage-graph.json"), JSON.stringify(graph));
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  const m = await buildIntent(ws, ref!, cat.stages, NOW);
  expect(m.units.length).toBeGreaterThan(0);
  expect(m.unitStages).toEqual(["functional-design", "nfr-requirements", "code-generation"]);
  const html = renderToStaticMarkup(<StageRail model={m} phase="construction" stage="build-and-test" unit={null} onSelect={() => {}} />);
  expect(html).toContain("Construction · by unit");
  expect(html).toContain("Construction · stage level");
  expect(html).toContain("build-and-test");
});

test("a trailing SESSION_ENDED reads as a chat ending, not the intent ending", async () => {
  const ws = await makeWorkspace({ audit: DEFAULT_AUDIT + block("2026-08-13T23:20:30Z", "SESSION_ENDED", {}), directive: null });
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  const i = summarize(await buildIntent(ws, ref!, cat.stages, NOW));
  expect(i.liveness).toBe("ended");
  const html = renderToStaticMarkup(<IntentCard i={i} now={NOW.getTime()} frozen={false} />);
  expect(html).toContain("■ chat ended");
  expect(html).toContain("another chat may still be working on this intent");
});

test("a stage the plan skips is not owed by any unit", async () => {
  const state = STATE_MD.replace("- [ ] code-generation — EXECUTE\n", "- [ ] code-generation — SKIP\n");
  const ws = await makeWorkspace({ state });
  const graph = GRAPH.map((s) => (PER_UNIT.has(s.slug) ? { ...s, for_each: "unit-of-work" } : s));
  await writeFile(join(ws, ".claude/tools/data/stage-graph.json"), JSON.stringify(graph));
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  const m = await buildIntent(ws, ref!, cat.stages, NOW);
  expect(m.unitStages).toContain("code-generation");
  expect(m.unitOwed).toEqual(["functional-design", "nfr-requirements"]);
});

test("an older graph without for_each still shows Build and Test as a stage-level station", async () => {
  const state = STATE_MD.replace("- [ ] code-generation — EXECUTE\n", "- [ ] code-generation — EXECUTE\n- [ ] build-and-test — EXECUTE\n");
  const ws = await makeWorkspace({ state });
  const legacy = [...GRAPH, { slug: "build-and-test", name: "Build and Test", phase: "construction", lead_agent: "aidlc-quality-agent", number: 8 }];
  await writeFile(join(ws, ".claude/tools/data/stage-graph.json"), JSON.stringify(legacy));
  const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  const m = await buildIntent(ws, ref!, cat.stages, NOW);
  expect(m.unitStages).not.toContain("build-and-test");
  const html = renderToStaticMarkup(<StageRail model={m} phase="construction" stage={null} unit={null} onSelect={() => {}} />);
  expect(html).toContain("Construction · stage level");
  expect(html).toContain("build-and-test");
});

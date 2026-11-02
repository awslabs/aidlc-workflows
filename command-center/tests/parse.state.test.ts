import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseState } from "../../core/command-center/server/parse/state";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { loadCatalog, phaseOf } from "../../core/command-center/server/parse/stage-graph";
import { makeWorkspace, STATE_MD } from "./fixtures/make";

test("parseState reads fields and plan with dispositions", () => {
  const s = parseState(STATE_MD);
  expect(s.fields.Scope).toBe("demo-scope");
  expect(s.fields.Depth).toBe("Standard");
  expect(s.plan.find((p) => p.slug === "market-research")).toEqual({ slug: "market-research", mark: " ", disposition: "SKIP" });
  expect(s.plan.find((p) => p.slug === "functional-design")!.mark).toBe("-");
  expect(s.plan.filter((p) => p.disposition === "EXECUTE").length).toBe(6);
});

test("listIntents returns registered and unregistered record dirs", async () => {
  const ws = await makeWorkspace();
  await mkdir(join(ws, "aidlc/spaces/default/intents/260901-orphan"), { recursive: true });
  await Bun.write(join(ws, "aidlc/spaces/default/intents/260901-orphan/aidlc-state.md"), STATE_MD);
  const list = await listIntents(ws);
  expect(list.map((i) => [i.dir, i.registered])).toEqual([["260811-demo", true], ["260901-orphan", false]]);
});

test("loadCatalog reads the project's own stage graph", async () => {
  const ws = await makeWorkspace();
  const c = await loadCatalog(ws);
  expect(c.source).toContain(".claude/tools/data/stage-graph.json");
  expect(phaseOf(c.stages, "feasibility")).toBe("ideation");
  expect(phaseOf(c.stages, "not-a-stage")).toBe("unknown");
});

test("listIntents tolerates a non-array intents.json", async () => {
  const ws = await makeWorkspace();
  await Bun.write(join(ws, "aidlc/spaces/default/intents/intents.json"), '{"not":"an array"}');
  const list = await listIntents(ws);
  expect(list.map((i) => [i.dir, i.registered])).toEqual([["260811-demo", false]]);
});

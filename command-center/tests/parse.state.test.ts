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

test("a CRLF state file parses to the same fields and plan as LF", () => {
  const lf = STATE_MD;
  const a = parseState(lf); const b = parseState(lf.replace(/\n/g, "\r\n"));
  expect(b).toEqual(a);
  expect(Object.values(b.fields).some((v) => v.endsWith("\r"))).toBe(false);
});

test("listIntents reads intents.json the way AI-DLC does: BOM, comments, trailing commas, and both sides of a conflict", async () => {
  const ws = await makeWorkspace();
  const reg = join(ws, "aidlc/spaces/default/intents/intents.json");
  await Bun.write(reg, '\uFEFF[\n  // hand edit\n  { "uuid": "u-1", "slug": "demo", "dirName": "260811-demo", "scope": "demo-scope", "status": "in-flight" },\n]\n');
  expect((await listIntents(ws)).find((i) => i.dir === "260811-demo")).toMatchObject({ uuid: "u-1", slug: "demo", scope: "demo-scope", registered: true });
  await Bun.write(reg, [
    "[",
    '  { "uuid": "u-1", "slug": "demo", "dirName": "260811-demo", "scope": "demo-scope", "status": "in-flight" },',
    "<<<<<<< ours",
    '  { "uuid": "u-2", "slug": "mine", "dirName": "260812-mine", "scope": "feature", "status": "in-flight" }',
    "=======",
    '  { "uuid": "u-3", "slug": "theirs", "dirName": "260812-theirs", "scope": "bugfix", "status": "completed" }',
    ">>>>>>> theirs",
    "]",
    "",
  ].join("\n"));
  const rows = (await listIntents(ws)).filter((i) => i.registered).map((i) => [i.uuid, i.scope, i.status]);
  expect(rows).toEqual([["u-1", "demo-scope", "in-flight"], ["u-2", "feature", "in-flight"], ["u-3", "bugfix", "completed"]]);
});

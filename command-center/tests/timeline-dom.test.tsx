// The Timeline's ✗ issues lane when the Issues lens cannot be loaded: logged errors still show, with a visible note.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const { afterAll, expect, test } = await import("bun:test");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Timeline } = await import("../ui/src/lenses/Timeline");
type IntentModel = import("../../core/command-center/server/types").IntentModel;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

const ev = (ts: string, kind: string, fields: Record<string, string> = {}) => ({ ts, kind, stage: fields.Stage ?? null, unit: null, text: fields.Error ?? "", raw: { ts, event: kind, heading: kind, fields, shard: "s.md", seq: 0 } });
const model = {
  key: "default/x", workspace: "/w", dir: "x", units: [], liveness: "idle", lastEventTs: "2026-08-12T11:00:00Z", current: { stage: null, unit: null, phase: "unknown" },
  stages: [{ slug: "feasibility", name: "Feasibility", phase: "ideation", lead: "a", state: "done", firstStart: null, completed: null, redos: 0, planned: true }],
  events: [ev("2026-08-12T10:00:00Z", "STAGE_STARTED", { Stage: "feasibility" }), ev("2026-08-12T10:30:00Z", "ERROR_LOGGED", { Stage: "feasibility", Error: "ENOENT: x" }), ev("2026-08-12T11:00:00Z", "STAGE_COMPLETED", { Stage: "feasibility" })],
} as unknown as IntentModel;

test("issues lens fails → logged errors are marked and a note says so", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Timeline model={model} ws="/w" filter={{ phase: null, unit: null }} selUnit={null} onSelect={() => {}} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(host.querySelector("[data-timeline-fallback]")?.textContent).toContain("Issues could not be loaded");
  expect([...host.querySelectorAll(".mk")].some((m) => m.getAttribute("title")?.startsWith("Error logged"))).toBe(true);
  await act(async () => { root.unmount(); });
});

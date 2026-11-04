import { expect, test } from "bun:test";
import type { StageView, StoryEvent, UnitRow } from "../../core/command-center/server/types";
import { ACTIVE_MS, agentTime, attribute, liveNow, restLabel, fmtDur, fold, groupOf, indexAt, lensFromSlug, parkedSpans, phaseCounts, recordRel, storyEvents, unitState } from "../ui/src/intent/derive";

const ev = (ts: string, kind: string, f: Record<string, string> = {}, seq = 0): StoryEvent => ({
  ts, kind, stage: f.Stage ?? f["Stage slug"] ?? null, unit: f.Unit ?? null, text: f.Details ?? f.File ?? "", raw: { ts, event: kind, heading: "", fields: f, shard: "a.md", seq },
});
const sv = (slug: string, phase: StageView["phase"], state: StageView["state"], firstStart: string | null = null, completed: string | null = null, redos = 0): StageView =>
  ({ slug, name: slug, phase, lead: "orchestrator", state, firstStart, completed, redos, planned: state !== "skip" });

const DIR = "260811-demo";
const stages = [sv("intent-capture", "ideation", "done", "2026-08-11T21:46:00Z", "2026-08-12T17:13:18Z", 1), sv("market-research", "ideation", "skip"),
  sv("feasibility", "ideation", "done", "2026-08-12T17:13:20Z", "2026-08-12T17:39:00Z"), sv("functional-design", "construction", "running"), sv("code-generation", "construction", "todo")];
const events = [
  ev("2026-08-11T21:46:00Z", "STAGE_STARTED", { Stage: "intent-capture" }),
  ev("2026-08-11T21:50:00Z", "ARTIFACT_CREATED", { File: `/old/place/aidlc/spaces/default/intents/${DIR}/ideation/intent-capture/memory.md` }),
  ev("2026-08-11T21:51:00Z", "ARTIFACT_UPDATED", { File: `/old/place/aidlc/spaces/default/intents/${DIR}/ideation/intent-capture/memory.md` }),
  ev("2026-08-11T21:52:00Z", "ARTIFACT_UPDATED", { File: `/old/place/aidlc/spaces/default/intents/${DIR}/ideation/intent-capture/memory.md` }),
  ev("2026-08-11T22:23:10Z", "ERROR_LOGGED", { Error: "Refusing" }),
  ev("2026-08-11T22:27:00Z", "WORKFLOW_PARKED", { Stage: "intent-capture" }),
  ev("2026-08-12T16:50:00Z", "WORKFLOW_UNPARKED"),
  ev("2026-08-12T16:54:00Z", "STAGE_JUMPED", { Target: "intent-capture", Source: "intent-capture" }),
  ev("2026-08-12T17:13:18Z", "STAGE_COMPLETED", { Stage: "intent-capture" }),
  ev("2026-08-12T17:13:20Z", "STAGE_STARTED", { Stage: "feasibility" }),
  ev("2026-08-12T17:39:00Z", "STAGE_COMPLETED", { Stage: "feasibility" }),
  ev("2026-08-12T22:34:00Z", "UNIT_STARTED", { Stage: "functional-design", Unit: "alpha" }),
  ev("2026-08-12T22:40:00Z", "SENSOR_FAILED", { "Stage slug": "functional-design", "Sensor ID": "linter" }),
  ev("2026-08-12T22:41:00Z", "ARTIFACT_CREATED", { File: `/x/aidlc/spaces/default/intents/${DIR}/construction/beta/code-generation/plan.md` }),
];
const m = { events, stages, dir: DIR };

test("fmtDur", () => {
  expect(fmtDur(30_000)).toBe("30s"); expect(fmtDur(45 * 60_000)).toBe("45m"); expect(fmtDur(64 * 60_000)).toBe("1h 04m"); expect(fmtDur(50 * 3_600_000)).toBe("2d 2h"); expect(fmtDur(-1)).toBe("—");
});

test("recordRel strips everything up to the record dir, even from a moved project", () => {
  expect(recordRel(`/old/place/aidlc/spaces/default/intents/${DIR}/ideation/x/y.md`, DIR)).toBe("ideation/x/y.md");
});

test("attribute: event stage, artifact path, jump target, unpark, timing", () => {
  const a = attribute(m);
  expect(a[1]).toMatchObject({ aStage: "intent-capture", how: "file" });
  expect(a[4]).toMatchObject({ aStage: "intent-capture", how: "timing" });
  expect(a[6]).toMatchObject({ aStage: "intent-capture", how: "park" });
  expect(a[7]).toMatchObject({ aStage: "intent-capture", how: "jump" });
  expect(a[13]).toMatchObject({ aStage: "code-generation", aUnit: "beta", how: "file" });
  // a construction event with a stage but no unit inherits the running unit
  expect(a[12]).toMatchObject({ aStage: "functional-design", aUnit: "alpha", how: "event" });
});

test("parked spans and agent time subtract the overnight park", () => {
  expect(parkedSpans(events)).toEqual([[Date.parse("2026-08-11T22:27:00Z"), Date.parse("2026-08-12T16:50:00Z")]]);
  const at = agentTime({ stages, events })!;
  expect(at.stages).toBe(2);
  // intent-capture 19h27m18s − 18h23m parked = 1h04m18s; feasibility 25m40s
  expect(at.ms).toBe((19 * 3600 + 27 * 60 + 18 - (18 * 3600 + 23 * 60)) * 1000 + (25 * 60 + 40) * 1000);
  expect(agentTime({ stages: [sv("a", "ideation", "todo")], events: [] })).toBeNull();
});

test("phaseCounts excludes skipped stages from the denominator", () => {
  expect(phaseCounts(stages, "ideation")).toEqual({ done: 2, planned: 2, skipped: 1, state: "done" });
  expect(phaseCounts(stages, "construction").state).toBe("running");
  expect(phaseCounts([sv("x", "operation", "skip")], "operation").state).toBe("skip");
  expect(phaseCounts([sv("x", "operation", "waiting")], "operation").state).toBe("waiting");
});

test("story events filter by stage, unit and replay instant; artifact edits fold", () => {
  const a = attribute(m);
  const ic = storyEvents(a, "intent-capture", null, null);
  expect(ic.map((e) => e.kind)).toContain("STAGE_JUMPED");
  const rows = fold(ic, DIR);
  const art = rows.find((r) => r.e.kind === "ARTIFACT_CREATED")!;
  expect(art.count).toBe(3); expect(art.file).toBe("ideation/intent-capture/memory.md");
  expect(storyEvents(a, "intent-capture", null, "2026-08-11T22:00:00Z").length).toBe(4);
  expect(storyEvents(a, "code-generation", "beta", null).length).toBe(1);
  expect(storyEvents(a, "code-generation", "alpha", null).length).toBe(0);
});

test("unit state, groups, lens slugs, scrubber index", () => {
  const u = (c: Partial<UnitRow["cells"]>): UnitRow => ({ name: "u", batch: null, kind: null, cells: { "code-generation": "todo", ...c } as UnitRow["cells"] });
  expect(unitState(u({ "code-generation": "inferred" }))).toBe("done");
  expect(unitState(u({ "nfr-design": "running" }))).toBe("running");
  expect(unitState(u({ "nfr-design": "waiting" }))).toBe("waiting");
  expect(groupOf("ARTIFACT_UPDATED")).toBe("Artifacts"); expect(groupOf("GATE_APPROVED")).toBe("Decisions"); expect(groupOf("ERROR_LOGGED")).toBe("Errors");
  expect(lensFromSlug("learnings")).toBe("Learnings"); expect(lensFromSlug(null)).toBe("Story"); expect(lensFromSlug("bogus")).toBe("Story");
  expect(indexAt(events, "2026-08-12T16:51:00Z")).toBe(6);
});

test("liveness decays on the client: active → idle after 121 s without events; ended stays ended", () => {
  const last = "2026-08-12T10:00:00Z"; const t0 = Date.parse(last);
  expect(liveNow("active", last, t0 + 60_000)).toBe("active");
  expect(liveNow("active", last, t0 + ACTIVE_MS)).toBe("active");
  expect(liveNow("active", last, t0 + 121_000)).toBe("idle");
  expect(liveNow("idle", last, t0 + 5_000)).toBe("active"); // a delta moved lastEventTs: the client sees activity before the refetch
  expect(liveNow("ended", last, t0 + 5_000)).toBe("ended");
  expect(liveNow("active", null, t0)).toBe("idle");
  expect(restLabel("active", last, t0)).toBeNull();
  expect(restLabel("ended", last, t0 + 3 * 3_600_000)).toBe("■ A CHAT ENDED · last event 3h 0m ago");
  expect(restLabel("idle", last, t0 + 5 * 60_000)).toBe("◌ IDLE · last event 5m ago");
});

test("fold: sensor findings and per-file edits gather across interleaved events, anchored at the first", () => {
  const F = (n: string) => `/p/aidlc/spaces/default/intents/${DIR}/ideation/intent-capture/${n}`;
  const evs = [
    ev("2026-08-11T21:46:00Z", "STAGE_STARTED", { Stage: "intent-capture" }),
    ev("2026-08-11T21:47:00Z", "ARTIFACT_CREATED", { File: F("a.md") }),
    ev("2026-08-11T21:48:00Z", "SENSOR_FAILED", { "Stage slug": "intent-capture", "Sensor ID": "claim-sources" }),
    ev("2026-08-11T21:49:00Z", "ARTIFACT_UPDATED", { File: F("b.md") }),
    ev("2026-08-11T21:50:00Z", "DECISION_RECORDED", { Stage: "intent-capture", Decision: "Q1" }),
    ev("2026-08-11T21:51:00Z", "ARTIFACT_UPDATED", { File: F("a.md") }),
    ev("2026-08-11T21:52:00Z", "SENSOR_FAILED", { "Stage slug": "intent-capture", "Sensor ID": "required-sections" }),
    ev("2026-08-11T21:53:00Z", "ARTIFACT_UPDATED", { File: F("a.md") }),
  ];
  const rows = fold(storyEvents(attribute({ events: evs, stages, dir: DIR }), "intent-capture", null, null), DIR);
  expect(rows.map((r) => [r.e.kind, r.count])).toEqual([["STAGE_STARTED", 1], ["ARTIFACT_CREATED", 3], ["SENSOR_FAILED", 2], ["ARTIFACT_UPDATED", 1], ["DECISION_RECORDED", 1]]);
  const a = rows[1]!; expect(a.file).toBe("ideation/intent-capture/a.md"); expect(a.e.ts).toBe("2026-08-11T21:47:00Z"); expect(a.last.ts).toBe("2026-08-11T21:53:00Z");
  expect(rows[2]!.members.map((x) => x.raw.fields["Sensor ID"])).toEqual(["claim-sources", "required-sections"]);
});

test("attribution: STAGE_COMPLETED clears the running stage; inherited units are flagged", () => {
  const evs = [
    ev("2026-08-12T10:00:00Z", "STAGE_STARTED", { Stage: "feasibility" }),
    ev("2026-08-12T10:10:00Z", "STAGE_COMPLETED", { Stage: "feasibility" }),
    ev("2026-08-12T10:20:00Z", "SESSION_ENDED"),
    ev("2026-08-12T11:00:00Z", "UNIT_STARTED", { Stage: "functional-design", Unit: "alpha" }),
    ev("2026-08-12T11:05:00Z", "REVIEW_REQUESTED", { Stage: "functional-design" }),
    ev("2026-08-12T11:06:00Z", "ERROR_LOGGED", { Error: "x" }),
  ];
  const a = attribute({ events: evs, stages, dir: DIR });
  expect(a[2]).toMatchObject({ aStage: null, how: null });
  expect(a[3]).toMatchObject({ aUnit: "alpha", unitInferred: false });
  expect(a[4]).toMatchObject({ aStage: "functional-design", aUnit: "alpha", unitInferred: true });
  expect(a[5]).toMatchObject({ aStage: "functional-design", aUnit: "alpha", how: "timing", unitInferred: true });
});

test("unitState is done at the graph's finish stage, not always code generation", () => {
  const row = (cells: Record<string, string>) => ({ name: "a", batch: null, kind: null, cells } as Parameters<typeof unitState>[0]);
  expect(unitState(row({ "code-generation": "done", "security-review": "todo" }), "security-review")).toBe("todo");
  expect(unitState(row({ "code-generation": "done", "security-review": "done" }), "security-review")).toBe("done");
});

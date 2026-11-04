import { expect, test } from "bun:test";
import { validateConfig } from "../../core/command-center/server/config";
import { discover } from "../../core/command-center/server/discovery";
import { buildHome } from "../../core/command-center/server/model/home";
import type { IntentSummary, WorkspaceSummary } from "../../core/command-center/server/types";
import { makeManyWorkspaces } from "./fixtures/many";
import {
  AUTO_COMPACT_ABOVE, buildHomeView, DEFAULT_PREFS, isDoneStatus, loadViewPref, matchesSearch, resolveView, saveViewPref,
  sanitizePrefs, statusCounts, statusOf, windowRange, type HomePrefs,
} from "../ui/src/home/homeView";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function intent(name: string, o: Partial<IntentSummary> = {}): IntentSummary {
  return {
    key: `default/${name}`, workspace: "/ws/a", space: "default", dir: name, uuid: null, name, title: null, scope: null, depth: null, started: null,
    status: "in-flight", plannedCount: 10, doneCount: 0, skippedCount: 0, current: { stage: "functional-design", unit: null, phase: "construction" },
    unitStages: [], unitFinish: "code-generation", units: [], unitsPlanned: null, unitsDone: 0, needs: [], liveness: "idle", lastEventTs: ago(60), tokens: { recorded: false, reason: "no ledger" },
    reviews: { ready: 0, notReady: 0 }, notes: [], unparsed: 0, phases: [], ...o,
  };
}
const gate = { kind: "gate" as const, stage: "feasibility", unit: null, since: ago(30), detail: "Gate open" };
function ws(path: string, label: string, intents: IntentSummary[], o: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return { path, label, origin: "pin", root: null, status: "ok", problem: null, intents: intents.map((i) => ({ ...i, workspace: path })), rulesLearned: 0, sampleRule: null, ...o };
}
const P = (o: Partial<HomePrefs> = {}): HomePrefs => ({ ...DEFAULT_PREFS, filters: [], ...o });

test("status buckets mirror the card: waiting, then client-side liveness, then registry done", () => {
  expect(statusOf(intent("a", { needs: [gate], liveness: "active", lastEventTs: ago(0) }), NOW)).toBe("waiting");
  expect(statusOf(intent("b", { lastEventTs: ago(1) }), NOW)).toBe("active"); // server said idle, but the event is 1 min old
  expect(statusOf(intent("c", { liveness: "active", lastEventTs: ago(10) }), NOW)).toBe("idle"); // decays like liveNow
  expect(statusOf(intent("d", { liveness: "ended" }), NOW)).toBe("ended");
  expect(statusOf(intent("e", { status: "complete", liveness: "ended" }), NOW)).toBe("done");
  expect(statusOf(intent("f", { status: "archived" }), NOW)).toBe("done");
  expect(statusOf(intent("g", { status: "parked" }), NOW)).toBe("idle");
  expect(isDoneStatus("Completed")).toBe(true);
  expect(isDoneStatus("in-flight")).toBe(false);
});

test("counts per status use the same liveness as the cards", () => {
  const w = [ws("/a", "alpha", [intent("a", { needs: [gate] }), intent("b", { lastEventTs: ago(1) }), intent("c"), intent("d", { status: "archived" }), intent("e", { status: "complete" })])];
  expect(statusCounts(w, NOW, "")).toEqual({ waiting: 1, active: 1, idle: 1, ended: 0, done: 2 });
  expect(statusCounts(w, NOW, "zzz")).toEqual({ waiting: 0, active: 0, idle: 0, ended: 0, done: 0 });
});

test("search matches name, title, workspace label, current stage and unit, case-insensitively", () => {
  const i = intent("Payments-API", { title: "Card refunds", current: { stage: "code-generation", unit: "Ledger", phase: "construction" } });
  for (const q of ["payments", "REFUNDS", "alpha", "code-gen", "ledger", ""]) expect(matchesSearch(i, "Alpha", q)).toBe(true);
  expect(matchesSearch(i, "Alpha", "nfr")).toBe(false);
});

test("Needs-you-first: waiting, then active, then most recent activity", () => {
  const w = [ws("/a", "alpha", [
    intent("old-idle", { lastEventTs: ago(500) }), intent("new-idle", { lastEventTs: ago(20) }),
    intent("live", { lastEventTs: ago(1) }), intent("asks", { needs: [gate], lastEventTs: ago(900) }), intent("never", { lastEventTs: null }),
  ])];
  const v = buildHomeView(w, NOW, P({ group: "none" }));
  expect(v.groups[0]!.rows.map((r) => r.i.name)).toEqual(["asks", "live", "new-idle", "old-idle", "never"]);
  const byName = buildHomeView(w, NOW, P({ group: "none", sort: "name" }));
  expect(byName.groups[0]!.rows.map((r) => r.i.name)).toEqual(["asks", "live", "never", "new-idle", "old-idle"]);
  const rev = buildHomeView(w, NOW, P({ group: "none", sort: "name", reverse: true }));
  expect(rev.groups[0]!.rows.map((r) => r.i.name)).toEqual(["old-idle", "new-idle", "never", "live", "asks"]);
});

test("Progress sorts by done ÷ planned, most complete first; Recent puts unrecorded activity last", () => {
  const w = [ws("/a", "alpha", [
    intent("half", { doneCount: 5, plannedCount: 10, lastEventTs: ago(5) }), intent("none", { doneCount: 0, plannedCount: 0, lastEventTs: null }),
    intent("most", { doneCount: 9, plannedCount: 10, lastEventTs: ago(50) }),
  ])];
  expect(buildHomeView(w, NOW, P({ group: "none", sort: "progress" })).groups[0]!.rows.map((r) => r.i.name)).toEqual(["most", "half", "none"]);
  expect(buildHomeView(w, NOW, P({ group: "none", sort: "recent" })).groups[0]!.rows.map((r) => r.i.name)).toEqual(["half", "most", "none"]);
});

test("filters combine as OR across chips; done intents collapse under a per-group count", () => {
  const w = [
    ws("/a", "alpha", [intent("a1", { needs: [gate] }), intent("a2"), intent("a3", { status: "complete" }), intent("a4", { status: "archived" })]),
    ws("/b", "beta", [intent("b1", { lastEventTs: ago(1) }), intent("b2", { status: "complete" })]),
  ];
  const all = buildHomeView(w, NOW, P());
  expect(all.groups.map((g) => [g.title, g.rows.length, g.completed.length])).toEqual([["alpha", 2, 2], ["beta", 1, 1]]);
  expect(all.groups[0]!.counts).toEqual({ waiting: 1, active: 0, idle: 1, ended: 0, done: 2 });
  expect(all.groups[0]!.total).toBe(4);
  expect(all.visible).toBe(6);
  const f = buildHomeView(w, NOW, P({ filters: ["waiting", "active"] }));
  expect(f.groups.map((g) => g.rows.map((r) => r.i.name))).toEqual([["a1"], ["b1"]]);
  expect(f.groups[0]!.total).toBe(4); // "1 of 4 intents"
  expect(f.visible).toBe(2);
  // With only Done selected the completed rows are the point: they are not tucked away.
  const d = buildHomeView(w, NOW, P({ filters: ["done"] }));
  expect(d.groups.map((g) => [g.rows.length, g.completed.length])).toEqual([[2, 0], [1, 0]]);
});

test("group by status orders groups by urgency and keeps done last", () => {
  const w = [ws("/a", "alpha", [intent("x", { status: "complete" }), intent("y", { needs: [gate] }), intent("z")])];
  const v = buildHomeView(w, NOW, P({ group: "status" }));
  expect(v.groups.map((g) => g.key)).toEqual(["status:waiting", "status:idle", "status:done"]);
  expect(v.groups.at(-1)!.completed.length).toBe(1);
});

test("error workspaces stay in their group; with no match they drop out unless the label matches", () => {
  const w = [ws("/a", "alpha", [intent("a1")]), ws("/m", "moved", [], { status: "missing", problem: "Folder not found" }), ws("/e", "fresh", [], { status: "empty" })];
  const v = buildHomeView(w, NOW, P());
  expect(v.groups.map((g) => [g.title, g.errors.length])).toEqual([["alpha", 0], ["moved", 1], ["fresh", 1]]);
  expect(buildHomeView(w, NOW, P({ q: "moved" })).groups.map((g) => g.title)).toEqual(["moved"]);
  expect(buildHomeView(w, NOW, P({ filters: ["active"] })).groups).toEqual([]);
  const s = buildHomeView(w, NOW, P({ group: "status" }));
  expect(s.groups.at(-1)!.key).toBe("errors");
  expect(s.groups.at(-1)!.errors.map((e) => e.label)).toEqual(["moved", "fresh"]);
});

test("AUTO view: compact above 15 visible intents, cards otherwise; a user choice overrides", () => {
  expect(AUTO_COMPACT_ABOVE).toBe(15);
  expect(resolveView(null, 15)).toBe("cards");
  expect(resolveView(null, 16)).toBe("compact");
  expect(resolveView("cards", 40)).toBe("cards");
  expect(resolveView("compact", 2)).toBe("compact");
});

test("the view choice persists in localStorage under cc-home-view; auto clears it", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  expect(loadViewPref(store)).toBeNull();
  saveViewPref(store, "cards");
  expect(m.get("cc-home-view")).toBe("cards");
  expect(loadViewPref(store)).toBe("cards");
  saveViewPref(store, null);
  expect(m.has("cc-home-view")).toBe(false);
  m.set("cc-home-view", "garbage");
  expect(loadViewPref(store)).toBeNull();
});

test("windowRange renders only rows near the viewport, with overscan, never out of bounds", () => {
  expect(windowRange(0, 900, 30, 500, 5)).toEqual({ start: 0, end: 35 });
  expect(windowRange(3000, 900, 30, 500, 5)).toEqual({ start: 95, end: 135 });
  expect(windowRange(-5000, 900, 30, 500, 5)).toEqual({ start: 0, end: 0 }); // list is far below the viewport
  expect(windowRange(99_999, 900, 30, 500, 5)).toEqual({ start: 500, end: 500 }); // scrolled past it
});

test("the 20-intent smoke fixture covers every Home status and groups by workspace", async () => {
  const now = Date.now();
  const home = await buildHome(await discover(validateConfig({ pins: await makeManyWorkspaces(now) })), new Date(now));
  expect(home.workspaces.map((w) => [w.label, w.status, w.intents.length])).toEqual([
    ["payments", "ok", 8], ["search-ranking", "ok", 7], ["onboarding", "ok", 5], ["moved-project", "missing", 0],
  ]);
  expect(statusCounts(home.workspaces, now, "")).toEqual({ waiting: 4, active: 3, idle: 6, ended: 3, done: 4 });
  const v = buildHomeView(home.workspaces, now, P());
  expect(resolveView(null, v.visible)).toBe("compact");
  expect(v.groups.map((g) => [g.title, g.rows.length, g.completed.length, g.errors.length])).toEqual([
    ["payments", 6, 2, 0], ["search-ranking", 6, 1, 0], ["onboarding", 4, 1, 0], ["moved-project", 0, 0, 1],
  ]);
  expect(v.groups[0]!.rows.slice(0, 3).map((r) => r.status)).toEqual(["waiting", "waiting", "active"]);
});

test("stored prefs are validated against known keys; junk falls back to the defaults", () => {
  expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
  expect(sanitizePrefs("nope")).toEqual(DEFAULT_PREFS);
  expect(sanitizePrefs({ sort: "price", group: "team", filters: ["waiting", "bogus", 3, "waiting"], q: 42, reverse: "yes" })).toEqual({ ...DEFAULT_PREFS, filters: ["waiting"] });
  expect(sanitizePrefs({ sort: "progress", group: "none", filters: "done", q: "pay", reverse: true })).toEqual({ filters: [], q: "pay", sort: "progress", reverse: true, group: "none" });
});

test("problem workspaces hidden by a status filter are counted (search still applies)", () => {
  const w = [ws("/a", "alpha", [intent("a1")]), ws("/m", "moved", [], { status: "missing" }), ws("/p", "half", [], { status: "partial" })];
  expect(buildHomeView(w, NOW, P()).hiddenProblems).toBe(0);
  expect(buildHomeView(w, NOW, P({ filters: ["idle"] })).hiddenProblems).toBe(2);
  expect(buildHomeView(w, NOW, P({ filters: ["idle"], q: "moved" })).hiddenProblems).toBe(1);
});

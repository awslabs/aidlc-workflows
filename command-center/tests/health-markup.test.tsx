// What the Health page and the Issues tab render: glyph + label + colour for every status, the AIDLC-remedy vs Hint
// label, "—" with a reason for unknowns, the hooks table states, the coverage note, and the routes and filters.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HookRow, ScopedIssue } from "../../core/command-center/server/hooks-map";
import { COVERAGE_NOTE } from "../../core/command-center/server/hooks-map";
import { parseHash } from "../ui/src/App";
import { Diagnostics } from "../ui/src/chrome/SetupDialog";
import { IssueLog } from "../ui/src/health/IssueLog";
import { CoverageNote, HooksTable } from "../ui/src/health/IssuesTable";
import { applyFilter, chipCounts, NO_FILTER } from "../ui/src/health/issueReport";
import { lensFromSlug, LENSES } from "../ui/src/intent/derive";
import { issuesCount } from "../ui/src/lenses/Issues";

const NOW = Date.parse("2026-08-13T23:21:00Z");
const base = { workspace: "/w/payments", intentKey: "default/x", intentName: "refunds", count: 1, needsFixing: true, source: { file: "aidlc/x.drops", line: 2 }, where: {} } as const;
const issues: ScopedIssue[] = [
  { ...base, id: "a", group: "hard-stop", resolved: null, at: "2026-08-13T22:00:00Z", kind: "Hook not running", message: "Hooks last fired …", recoverable: "needs-you", fix: { text: "Repair the hook registration", source: "hint" } },
  { ...base, id: "b", group: "failure", resolved: null, at: "2026-08-13T22:10:00Z", where: { hook: "review-freeze", hookPhase: "PreToolUse" }, kind: "Hook drop · audit write lost", message: "row dropped", recoverable: "no", fix: null, count: 3 },
  { ...base, id: "c", group: "refused", resolved: null, at: null, where: { stage: "code-generation", unit: "api", inferred: "stage inferred from timing" }, kind: "Guard refusal", message: "Budget spent", recoverable: "yes", fix: { text: "Run the review again", source: "aidlc" }, needsFixing: false },
  { ...base, id: "d", group: "failure", resolved: { by: "a later passing run of the same check", at: "2026-08-13T22:30:00Z" }, at: "2026-08-13T22:20:00Z", kind: "Check failed", message: "traceability reported 2 findings", recoverable: "yes", fix: null, needsFixing: false },
  { ...base, id: "e", group: "bypass", resolved: null, at: "2026-08-13T22:40:00Z", intentKey: null, intentName: "workspace", kind: "Bypass · guard disabled", message: "plan-approval-guard is switched off", recoverable: "needs-you", fix: null, needsFixing: false },
];

test("the issue log: group, title ×count, where, state, recoverable and remedy source, all as glyph + label", () => {
  const html = renderToStaticMarkup(<IssueLog issues={issues} scoped now={NOW} initial="b" title="Health" subtitle="" wsOptions={["/w/payments"]} />);
  for (const s of ["🔴</span> Hard stop", "🟠</span> Failure", "🟡</span> Refused", "⚪</span> Bypass", "×3", "review-freeze · Pre", "○</span> Open", "✓</span> Resolved",
    "✗</span> Not recoverable", "refunds", "workspace level", ">payments<"]) expect(html).toContain(s);
  // Unknowns are "—" with a reason, never blank.
  expect(html).toContain('title="The record has no timestamp"><span class="faint">—</span>');
  expect(html).toContain('title="AIDLC records no remedy for this and there is no documented hint">— No remedy recorded.');
  // The inferred stage is marked as inferred.
  expect(html).toMatch(/class="dim il-sub hl-inferred" title="stage inferred from timing">code-generation · api/);
  // The selected entry is shown in the detail panel, with its source.
  expect(html).toContain('data-issue="b"');
  expect(html).toContain("aidlc/x.drops:2");
  // Every row is reachable from the keyboard: its title is a button.
  expect(html.match(/<button type="button" class="linkbtn hl-rowbtn"/g)?.length).toBe(issues.length);
  // Group chips: every group, then resolved, with counts.
  expect(html).toMatch(/Hard stop <b>1<\/b>/);
  expect(html).toMatch(/Resolved <b>1<\/b>/);
  expect(html).toContain("5 entries · 7 recorded occurrences");
  expect(html).toContain("Showing 5 of 5 entries");
});

test("chip counts split open items by group and count resolved separately", () => {
  const n = chipCounts(issues);
  expect(n).toMatchObject({ all: 5, "hard-stop": 1, failure: 1, refused: 1, bypass: 1, accepted: 0, resolved: 1 });
});

test("hooks table: problem rows only by default, every state as glyph + label", () => {
  const row = (hook: string, state: HookRow["state"], drops = 0, lastAt: string | null = "2026-08-13T22:00:00Z"): HookRow => ({ workspace: "/w", intentKey: "default/x", hook, phase: "Post", lastAt, state, drops, benignDrops: hook === "continue-workflow" ? 2 : 0 });
  const hooks = [row("write-audit-log", "ok"), row("run-sensors", "stale"), row("session-end", "frozen"), row("sync-workflow-state", "never", 0, null), row("continue-workflow", "ok", 1)];
  const some = renderToStaticMarkup(<HooksTable hooks={hooks} all={false} now={NOW} />);
  expect(some).not.toContain("write-audit-log");
  for (const s of ["✗</span> stale", "❄</span> frozen (warning)", "(+2 by design)"]) expect(some).toContain(s);
  // One hook that never ran is normal; a record where no hook ever ran is shown.
  expect(some).not.toContain("sync-workflow-state");
  const silent = renderToStaticMarkup(<HooksTable hooks={[{ ...row("write-audit-log", "never", 0, null), intentKey: "default/y" }]} all={false} now={NOW} />);
  expect(silent).toContain("○</span> never ran");
  expect(renderToStaticMarkup(<HooksTable hooks={hooks} all now={NOW} />)).toContain("write-audit-log");
  // A record whose hooks are all stale is one row in the problems view.
  const dead = ["a", "b", "c"].map((n) => ({ ...row(n, "stale"), intentKey: "default/z" }));
  const one = renderToStaticMarkup(<HooksTable hooks={dead} all={false} now={NOW} />);
  expect(one).toContain("all 3 hooks");
  expect(one.match(/<tr>/g)?.length).toBe(2); // header + one row
  expect(renderToStaticMarkup(<HooksTable hooks={[row("write-audit-log", "ok")]} all={false} now={NOW} />)).toContain("✓ Every hook");
});

test("informational hook rows (not the active intent) are folded away unless they recorded drops", () => {
  const info = (hook: string, drops = 0): HookRow => ({ workspace: "/w", intentKey: "default/old", hook, phase: "Post", lastAt: null, state: "never", drops, benignDrops: 0, note: "no heartbeats here — normal for a clone or another machine" });
  expect(renderToStaticMarkup(<HooksTable hooks={[info("a"), info("b")]} all={false} now={NOW} />)).toContain("✓ Every hook");
  const all = renderToStaticMarkup(<HooksTable hooks={[info("a"), info("b", 1)]} all now={NOW} />);
  expect(all).toContain("· no heartbeats here — normal for a clone or another machine");
  expect(renderToStaticMarkup(<HooksTable hooks={[info("a"), info("b", 1)]} all={false} now={NOW} />)).toContain(">b<");
});

test("transcripts on says how many hook runs and failures were seen, and the by-design re-prompts", () => {
  const html = renderToStaticMarkup(<CoverageNote c={{ transcripts: "on", trace: false, note: null, transcriptRuns: 12, transcriptFailures: 0, transcriptReprompts: 3 }} />);
  expect(html).toContain("on · 12 hook runs seen, 0 failures");
  expect(html).toContain("3 Stop-hook re-prompts by design");
});

test("coverage note says plainly that hook crashes are not recorded", () => {
  const html = renderToStaticMarkup(<CoverageNote c={{ transcripts: "off", trace: false, note: COVERAGE_NOTE }} />);
  expect(html).toContain("Hook crashes are not recorded by AIDLC");
  expect(html).toContain("A crashing hook can still look alive");
  expect(renderToStaticMarkup(<CoverageNote c={{ transcripts: "on", trace: false, note: null }} />)).not.toContain("warn");
});

test("routes, the Issues tab after Reviews, its count, and the filters", () => {
  expect(parseHash("#/health")).toEqual({ view: "health" });
  expect(LENSES.indexOf("Issues")).toBe(LENSES.indexOf("Reviews") + 1);
  expect(lensFromSlug("issues")).toBe("Issues");
  expect(issuesCount({ issues, hooks: [], coverage: { transcripts: "off", trace: false, note: null }, generatedAt: "" })).toBe(2);
  expect(applyFilter(issues, { ...NO_FILTER, state: "open" }, NOW).map((i) => i.id)).toEqual(["a", "b", "c", "e"]);
  expect(applyFilter(issues, { ...NO_FILTER, chip: "failure" }, NOW).map((i) => i.id)).toEqual(["b"]);
  expect(applyFilter(issues, { ...NO_FILTER, ws: "/other" }, NOW)).toEqual([]);
  expect(applyFilter(issues, { ...NO_FILTER, state: "resolved" }, NOW).map((i) => i.id)).toEqual(["d"]);
});

test("the transcript opt-in is off by default and says what it reads", () => {
  const cfg = { version: 1 as const, roots: [], pins: [], hidden: [], repos: [], theme: "auto" as const };
  const off = renderToStaticMarkup(<Diagnostics config={cfg} save={() => {}} />);
  expect(off).toContain("Read hook failures from Claude Code transcripts");
  expect(off).toContain("○ off");
  expect(off).not.toContain("checked");
  expect(renderToStaticMarkup(<Diagnostics config={{ ...cfg, settings: { scanTranscripts: true } }} save={() => {}} />)).toContain("✓ on");
});

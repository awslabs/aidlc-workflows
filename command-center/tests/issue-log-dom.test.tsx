// The issue log in a real DOM (happy-dom): keyboard navigation, checkbox selection, filters and the empty state, and
// the markup of every detail-panel section (facts, message, stats, cause, remedy, resolution, evidence, footer).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
const { afterAll, beforeEach, expect, test } = await import("bun:test");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { IssueDetail, IssueLog, Verbatim } = await import("../ui/src/health/IssueLog");
type ScopedIssue = import("../../core/command-center/server/hooks-map").ScopedIssue;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
let mounted: (() => void) | null = null;
beforeEach(() => { mounted?.(); mounted = null; document.body.innerHTML = ""; });

const NOW = Date.parse("2026-08-13T23:21:00Z");
const base = { workspace: "/w/payments", intentKey: "default/x", intentName: "refunds", count: 1, needsFixing: true, source: { file: "aidlc/a.md" }, where: {}, recoverable: "yes", fix: null, resolved: null } as const;
const issues: ScopedIssue[] = [
  { ...base, id: "old", group: "failure", at: "2026-08-13T20:00:00Z", kind: "Internal error", message: "ENOENT: no such file" },
  { ...base, id: "new", group: "hard-stop", at: "2026-08-13T22:00:00Z", kind: "Hook not running", message: "Hooks last fired" },
  { ...base, id: "mid", group: "refused", at: "2026-08-13T21:00:00Z", kind: "Refused", message: "Refusing to go on", resolved: { by: "STAGE_COMPLETED", at: "2026-08-13T21:30:00Z" } },
];

async function mount(list: ScopedIssue[], onOpen?: (i: ScopedIssue) => void) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<IssueLog issues={list} scoped now={NOW} title="Health" subtitle="" wsOptions={["/w/payments"]} onOpen={onOpen} />); });
  mounted = () => { act(() => root.unmount()); host.remove(); };
  return host;
}
const current = (h: HTMLElement) => h.querySelector(".il-detail")!.getAttribute("data-issue");
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); };

test("newest first; ↑/↓ and ←/→ move the selection, Enter opens the intent, the sort flips", async () => {
  const opened: string[] = [];
  const h = await mount(issues, (i) => opened.push(i.id));
  const rows = () => [...h.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-row"));
  expect(rows()).toEqual(["new", "mid", "old"]);
  expect(current(h)).toBe("new");
  const list = h.querySelector(".il-list")!;
  await key(list, "ArrowDown"); expect(current(h)).toBe("mid");
  await key(list, "ArrowRight"); expect(current(h)).toBe("old");
  await key(list, "ArrowDown"); expect(current(h)).toBe("old"); // stops at the end
  await key(list, "ArrowLeft"); await key(list, "ArrowUp"); expect(current(h)).toBe("new");
  expect(h.querySelector("tr.il-on")!.getAttribute("data-row")).toBe("new");
  expect(h.textContent).toContain("Entry 1 of 3");
  await key(list, "Enter"); expect(opened).toEqual(["new"]);
  await act(async () => { (h.querySelector(".il-sort") as HTMLButtonElement).click(); });
  expect(rows()).toEqual(["old", "mid", "new"]);
  // The selection keeps its entry (now last); the detail panel's arrows step too.
  expect(h.textContent).toContain("Entry 3 of 3");
  expect((h.querySelector('[aria-label="Next entry"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { (h.querySelector('[aria-label="Previous entry"]') as HTMLButtonElement).click(); });
  expect(current(h)).toBe("mid");
});

test("checkbox selection: select-all, Space toggles, the count and Clear, Esc clears", async () => {
  const h = await mount(issues);
  const all = h.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { all.click(); });
  expect(h.textContent).toContain("3 selected");
  expect(h.querySelectorAll("tr.il-checked")).toHaveLength(3);
  await key(h.querySelector(".il-list")!, "Escape");
  expect(h.textContent).not.toContain("selected");
  await key(h.querySelector(".il-list")!, " ");
  expect(h.textContent).toContain("1 selected");
  expect(h.querySelector("tr.il-checked")!.getAttribute("data-row")).toBe("new");
  await act(async () => { [...h.querySelectorAll("button.linkbtn")].find((b) => b.textContent === "Clear")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(h.textContent).not.toContain("selected");
  // Clicking a row selects it for the detail panel without checking it.
  await act(async () => { (h.querySelector('tr[data-row="old"]') as HTMLElement).click(); });
  expect(current(h)).toBe("old");
  expect(h.querySelectorAll("tr.il-checked")).toHaveLength(0);
});

test("search, state and chips filter; nothing left says so", async () => {
  const h = await mount(issues);
  const input = h.querySelector('input[type="search"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "enoent"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect([...h.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-row"))).toEqual(["old"]);
  expect(h.textContent).toContain("Showing 1 of 3 entries");
  await act(async () => { setter.call(input, "zzz"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(h.textContent).toContain("No issues match these filters.");
  await act(async () => { setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { (h.querySelector(".il-chip-resolved") as HTMLButtonElement).click(); });
  expect([...h.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-row"))).toEqual(["mid"]);
});

test("every detail section: facts, message, stats, cause, remedy chip, resolution, evidence with the focus line, supporting files, footer", () => {
  const i: ScopedIssue = {
    ...base, id: "d", group: "failure", at: "2026-08-13T10:15:00Z", firstAt: "2026-08-13T10:10:00Z", count: 3, kind: "Check failed", message: "traceability reported 2 findings in `x.md`",
    where: { stage: "build-and-test", unit: "api", inferred: "from the file path", hook: "run-sensors", hookPhase: "PostToolUse" }, recoverable: "needs-you",
    fix: { text: "Run it again", source: "aidlc" }, source: { file: "aidlc/s/audit/a.md", line: 142 },
    cause: { summary: "traceability recorded 2 findings.", points: [{ label: "gaps", value: "FR-3" }, { label: "Sensor ID", value: "traceability" }], source: "aidlc" },
    evidence: { auditFile: "aidlc/s/audit/a.md", startLine: 142, focusLine: 142, lines: ["## SENSOR_FAILED", "**Sensor ID**: traceability"], supporting: [{ path: "aidlc/s/.aidlc-engine/sensors/b/traceability-f1.md", label: "traceability findings", kind: "sensor-detail" }] },
  };
  const html = renderToStaticMarkup(<IssueDetail i={i} index={0} total={4} onStep={() => {}} onIntent={() => {}} showWorkspace onView={() => {}} />);
  for (const s of ["Entry 1 of 4", "Traceability check failed", ">Workspace<", ">payments<", "refunds ↗", ">Stage / unit<", 'class="hl-inferred" title="from the file path"', "run-sensors · Post",
    "Original message", "<code>x.md</code>", "3 occurrences", "Aug 13 · ", "◆</span> Needs you", "Cause (from the records)", "<dt>gaps</dt><dd>FR-3</dd>",
    'class="chip hl-fix aidlc" title="AIDLC&#x27;s own remedy text">AIDLC<', 'title="Built from AIDLC&#x27;s records">AIDLC<', "Run it again", "No resolution recorded.", "Source evidence", "Open audit file",
    '<div class="il-ln il-focus"><span class="il-no">142</span><span class="il-tx">## SENSOR_FAILED</span>', '<span class="il-no">143</span>', "traceability-f1.md", "Supporting file · traceability findings", "View file →",
    "aidlc/s/audit/a.md:142", "Copy this issue"]) expect(html).toContain(s);
  const bare = renderToStaticMarkup(<IssueDetail i={{ ...i, cause: null, fix: { text: "Retry", source: "hint" }, evidence: null, resolved: { by: "a later passing run", at: "2026-08-13T11:00:00Z" }, intentKey: null, intentName: "workspace" }}
    index={1} total={4} onStep={() => {}} showWorkspace onView={() => {}} />);
  for (const s of ["No cause recorded — AIDLC wrote only the message above.", ">Hint<", "✓ Resolved by a later passing run at", "No record lines are available for this entry.", "— workspace level"]) expect(bare).toContain(s);
});

test("code-like spans: paths keep their :line:col, plain words with a slash stay prose", () => {
  const html = renderToStaticMarkup(<Verbatim text="see src/a.ts:42:7 and ./run.sh, use and/or 10/13, REVIEW_BUDGET_SPENT, ENOENT, --unit x, /etc/hosts" />);
  for (const s of ["<code>src/a.ts:42:7</code>", "<code>./run.sh</code>", "<code>REVIEW_BUDGET_SPENT</code>", "<code>ENOENT</code>", "<code>--unit</code>", "<code>/etc/hosts</code>", " and/or 10/13, "]) expect(html).toContain(s);
});

test("the intent tab's Stage column shows a unit recorded without a stage", async () => {
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const only: ScopedIssue = { ...base, id: "u", group: "failure", at: "2026-08-13T20:00:00Z", kind: "Checkpoint crashed", message: "m", where: { unit: "dispatch-api" } };
  await act(async () => { root.render(<IssueLog issues={[only]} scoped={false} now={NOW} title="Issue log" subtitle="" />); });
  mounted = () => { act(() => root.unmount()); host.remove(); };
  const cell = host.querySelector("td.il-stagecol")!;
  expect(cell.textContent).toBe("—dispatch-api");
  expect(cell.querySelector("b")!.getAttribute("title")).toBe("The record names a unit but no stage");
});

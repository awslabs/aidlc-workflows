// Workspaces & settings, driven in a real DOM (happy-dom): what only a live document can answer — which rows a
// bulk action really touches, what the add row says after Browse…, and where the keyboard lands after an edit.
// Everything that needs no DOM stays in settings.test.tsx.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
// Imported after the DOM exists, so react-dom/client and the components see a document.
const { afterAll, beforeEach, expect, test } = await import("bun:test");
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SetupDialog } = await import("../ui/src/chrome/SetupDialog");
const { LiveContext } = await import("../ui/src/useLive");
type Config = import("../ui/src/api").Config;
type Live = import("../ui/src/useLive").Live;
type HomePayload = import("../../core/command-center/server/types").HomePayload;
type WorkspaceSummary = import("../../core/command-center/server/types").WorkspaceSummary;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
// Every test starts from an empty document, so a failing one cannot leave a tree behind for the next to query.
let mounted: (() => void) | null = null;
beforeEach(() => { mounted?.(); mounted = null; document.body.innerHTML = ""; });

const NINE = Array.from({ length: 9 }, (_, i) => `/srv/r${i}`);
/** Nine pinned folders, so the pins table is long enough to grow a filter box. */
const PINS = Array.from({ length: 9 }, (_, i) => `/opt/p${i}`);
const base: Config = { version: 1, roots: NINE, pins: PINS, hidden: [], repos: ["https://example.com/a/b"], theme: "auto" };
/** A workspace as /api/home reports it. */
const wsum = (path: string, root: string | null, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary =>
  ({ path, label: path.split("/").pop()!, origin: root ? "root" : "pin", root, status: "ok", problem: null, intents: [], rulesLearned: 0, sampleRule: null, ...extra });

/**
 * Renders the dialog over a config the harness keeps in state, as App does. `saved` records every accepted PUT;
 * `refuse` makes the next ones fail the way a rejected PUT does (the config is left alone and `false` returned).
 * `rerender` re-renders the dialog with nothing changed, as the live clock does once a second.
 */
async function mount(initial: Config, workspaces: WorkspaceSummary[] = []) {
  const saved: Config[] = [];
  const refused: Config[] = [];
  const ctl = { refuse: false, bump: () => {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Harness() {
    const [c, setC] = useState(initial);
    const [, setTick] = useState(0);
    ctl.bump = () => setTick((t) => t + 1);
    const save = async (n: Config) => {
      if (ctl.refuse) { refused.push(n); return false; }
      saved.push(n); setC(n); return true;
    };
    return (
      <LiveContext.Provider value={{ home: { workspaces, needs: [], generatedAt: "2026-08-13T00:00:00Z" } as HomePayload } as unknown as Live}>
        <SetupDialog first={false} config={c} saveConfig={save} onClose={() => {}} />
      </LiveContext.Provider>
    );
  }
  await act(async () => { root.render(<Harness />); });
  mounted = () => { root.unmount(); host.remove(); };
  return {
    saved, refused, refuse: (on: boolean) => { ctl.refuse = on; },
    rerender: async () => { await act(async () => { ctl.bump(); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); mounted = null; },
  };
}
/** Answers the folder chooser with `path` for as long as `body` runs. */
async function withPicker(path: string, body: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ path }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try { await body(); } finally { globalThis.fetch = real; }
}

const table = (id: string) => document.querySelector(`[aria-labelledby="${id}-h"]`) as HTMLElement;
const dialog = () => document.querySelector(".dlg.settings-dlg") as HTMLElement;
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
/** A real click focuses the control first, the way a pointer or the keyboard would. */
const press = async (el: HTMLElement) => { await act(async () => { el.focus(); el.click(); }); };
/** Types into a controlled input: the prototype setter bypasses React's own value tracker, as a real key would. */
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => { input.focus(); setValue?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

test("a bulk action only touches rows the filter leaves visible", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  const boxes = [...pins.querySelectorAll("tr.st-row td.st-ck input")] as HTMLInputElement[];
  expect(boxes.length).toBe(9);
  for (const b of boxes.slice(0, 3)) await press(b);
  expect(pins.querySelector(".st-bulk b")?.textContent).toBe("3 selected");

  await type(pins.querySelector("input[type=search]") as HTMLInputElement, "p1");
  expect(pins.querySelectorAll("tr.st-row").length).toBe(1);
  expect(pins.querySelector(".st-bulk b")?.textContent).toBe("1 selected");

  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(pins.querySelector(".st-askq")?.textContent).toBe("Remove 1 pinned folder?");
  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(m.saved.length).toBe(1);
  expect(m.saved[0]!.pins).toEqual(PINS.filter((p) => p !== "/opt/p1"));
  await m.unmount();
});

/** Answers the local server: the chooser with `pick`, a listing per folder from `folders` (404 when absent). */
async function withServer(pick: string | null, folders: Record<string, { name: string; isAidlc: boolean }[]>, body: () => Promise<void>) {
  const real = globalThis.fetch;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    if (u.pathname === "/api/folders/pick") return json(pick ? { path: pick } : { cancelled: true });
    const p = u.searchParams.get("path") ?? "";
    const entries = folders[p];
    if (!entries) return json({ error: "not a folder" }, 404);
    return json({ path: p, parent: "/", truncated: false, entries: entries.map((e) => ({ ...e, path: `${p}/${e.name}` })) });
  }) as unknown as typeof fetch;
  try { await body(); } finally { globalThis.fetch = real; }
}

test("Add a project folder works out root or pin, says why a folder was refused, and can be undone", async () => {
  const m = await mount(base);
  const panel = document.querySelector('[aria-labelledby="af-h"]') as HTMLElement;
  const input = panel.querySelector("input") as HTMLInputElement;
  await withServer(null, { "/work/app": [{ name: "aidlc", isAidlc: false }], "/work/many": [{ name: "a", isAidlc: true }, { name: "b", isAidlc: true }] }, async () => {
    // Refused before anything is saved: a duplicate, a folder already inside a root, and a path that is no folder.
    await type(input, "/srv/r0");
    await press(button(panel, "Add")!);
    expect(panel.querySelector(".af-msg")?.textContent).toContain("Already added");
    await type(input, "/srv/r0/inner");
    await press(button(panel, "Add")!);
    expect(panel.querySelector(".af-msg")?.textContent).toContain("Already watched — it is inside /srv/r0");
    await type(input, "/nowhere");
    await press(button(panel, "Add")!);
    expect(panel.querySelector(".af-msg")?.textContent).toContain("Not a folder");
    expect(input.value).toBe("/nowhere"); // a refused path stays for fixing
    expect(m.saved.length).toBe(0);

    // A folder with aidlc/ becomes a single project (a pin).
    await type(input, "/work/app");
    await press(button(panel, "Add")!);
    expect(m.saved.at(-1)!.pins).toContain("/work/app");
    expect(m.saved.at(-1)!.roots).not.toContain("/work/app");
    expect(panel.querySelector(".af-msg")?.textContent).toContain("app added as a project.");
    expect(input.value).toBe("");
  });

  // Choosing a folder goes through the same add: a folder of projects becomes a root, and Undo takes it back.
  await withServer("/work/many", { "/work/many": [{ name: "a", isAidlc: true }, { name: "b", isAidlc: true }] }, async () => {
    await press(button(panel, "📁 Choose a folder…")!);
    expect(m.saved.at(-1)!.roots).toContain("/work/many");
    expect(panel.querySelector(".af-msg")?.textContent).toContain("2 AIDLC projects found inside");
    await press(button(panel.querySelector(".af-msg")!, "Undo")!);
    expect(m.saved.at(-1)!.roots).not.toContain("/work/many");
  });
  await m.unmount();
});
test("the keyboard stays in the dialog after a removal, a confirmation and an Undo", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  const row = pins.querySelectorAll("tr.st-row")[5] as HTMLElement;
  await press(button(row, "Remove")!);
  expect(m.saved[0]!.pins).toEqual(PINS.filter((p) => p !== "/opt/p5"));
  expect(dialog().contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.id).toBe("st-pins-h");

  // Opening and cancelling the inline confirmation replaces the button that was focused.
  await press(pins.querySelector("tr.st-row td.st-ck input") as HTMLElement);
  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(dialog().contains(document.activeElement)).toBe(true);
  await press(button(pins.querySelector(".st-bulk")!, "Cancel")!);
  expect(dialog().contains(document.activeElement)).toBe(true);

  // Undo withdraws its own offer: focus must not fall out of the dialog with it.
  await press(button(pins.querySelector(".st-undo")!, "Undo")!);
  expect(m.saved[1]!.pins).toEqual(PINS);
  expect(dialog().contains(document.activeElement)).toBe(true);
  await m.unmount();
});

test("Locate… onto a folder that is already pinned says the two entries merged", async () => {
  const m = await mount({ ...base, pins: ["/opt/one", "/opt/second"] });
  const pins = table("st-pins");
  const row = pins.querySelectorAll("tr.st-row")[0] as HTMLElement;
  await withPicker("/opt/second", async () => { await press(button(row, "Locate…")!); });
  expect(m.saved[0]!.pins).toEqual(["/opt/second"]);
  expect(pins.querySelector(".st-undo")?.textContent).toContain("merged into the folder already pinned at /opt/second");
  await m.unmount();
});

test("an Undo whose PUT is refused keeps the offer standing", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  await press(button(pins.querySelectorAll("tr.st-row")[2] as HTMLElement, "Remove")!);
  expect(m.saved.length).toBe(1);
  expect(pins.querySelector(".st-undo")).not.toBeNull();

  m.refuse(true);
  await press(button(pins.querySelector(".st-undo")!, "Undo")!);
  expect(m.refused.length).toBe(1);
  expect(m.refused[0]!.pins).toEqual(PINS); // it tried to restore the config the removal replaced
  expect(pins.querySelector(".st-undo")).not.toBeNull(); // still offered, so the reader can try again

  m.refuse(false);
  await press(button(pins.querySelector(".st-undo")!, "Undo")!);
  expect(m.saved[1]!.pins).toEqual(PINS);
  expect(pins.querySelector(".st-undo")).toBeNull();
  await m.unmount();
});

test("clicking blank dialog space never pulls focus back to a table heading", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  const box = pins.querySelector("tr.st-row td.st-ck input") as HTMLInputElement;
  await act(async () => { box.focus(); });
  expect(document.activeElement).toBe(box);

  // A click on blank, non-focusable dialog space: pointerdown there, then the control blurs to <body>.
  const blank = dialog().querySelector(".st-note") as HTMLElement;
  await act(async () => {
    blank.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    box.blur();
  });
  expect(document.activeElement).toBe(document.body);

  // The live clock re-renders the dialog every second; nothing was removed, so focus must stay where it fell.
  await m.rerender();
  await m.rerender();
  expect(document.activeElement).not.toBe(dialog().querySelector("#st-pins-h"));
  expect(document.activeElement).toBe(document.body);
  expect(box.isConnected).toBe(true);
  await m.unmount();
});

test("Remove root names how many projects it covers, and Undo brings them back", async () => {
  const ws = [wsum("/srv/r0/one", "/srv/r0"), wsum("/srv/r0/two", "/srv/r0")];
  const m = await mount({ ...base, roots: ["/srv/r0"], pins: [] }, ws);
  const roots = table("st-roots");
  expect(roots.querySelectorAll("tr.st-row").length).toBe(2); // one row per project, not one per root

  // Remove root sits in the Root cell of a project row and asks before it acts.
  await press(button(roots.querySelectorAll("tr.st-row")[0] as HTMLElement, "Remove root")!);
  expect(roots.querySelector(".st-askq")?.textContent).toBe("Remove root /srv/r0 (2 projects)?");
  expect(m.saved.length).toBe(0); // nothing happens until it is confirmed

  await press(button(roots.querySelector(".st-bulk")!, "Remove root")!);
  expect(m.saved[0]!.roots).toEqual([]);
  expect(dialog().contains(document.activeElement)).toBe(true);

  await press(button(roots.querySelector(".st-undo")!, "Undo")!);
  expect(m.saved[1]!.roots).toEqual(["/srv/r0"]);
  await m.unmount();
});

test("a root with nothing under it offers Remove root as its only action", async () => {
  const m = await mount({ ...base, roots: ["/srv/r0"], pins: [] }, []);
  const roots = table("st-roots");
  const row = roots.querySelectorAll("tr.st-row")[0] as HTMLElement;
  expect((row.querySelector("td.st-ck input") as HTMLInputElement).disabled).toBe(true);
  expect(row.textContent).toContain("no AIDLC projects found");
  await press(button(row, "Remove root")!);
  expect(roots.querySelector(".st-askq")?.textContent).toBe("Remove root /srv/r0 (0 projects)?");
  await press(button(roots.querySelector(".st-bulk")!, "Remove root")!);
  expect(m.saved[0]!.roots).toEqual([]);
  await m.unmount();
});

test("a truncated path cell hands over the whole path, by hover and to a screen reader", async () => {
  const m = await mount({ ...base, roots: ["/Users/someone/work"], pins: [] }, [wsum("/Users/someone/work/app", "/Users/someone/work")]);
  const cell = table("st-roots").querySelector("tr.st-row .st-pathcell") as HTMLElement;
  // What the eye sees is abbreviated and clipped to one line; the whole path is the title and the read-out text.
  expect(cell.getAttribute("title")).toBe("/Users/someone/work/app");
  expect((cell.querySelector("[aria-hidden]") as HTMLElement).textContent).toBe("~/work/app");
  expect((cell.querySelector(".vh") as HTMLElement).textContent).toBe("/Users/someone/work/app");
  expect(cell.textContent).toContain("/Users/someone/work/app"); // a selection copies the real path
  await m.unmount();
});

test("Remove root counts the projects it covers and the hidden ones discovery left out", async () => {
  const ws = [wsum("/srv/r0/one", "/srv/r0"), wsum("/srv/r0/two", "/srv/r0")];
  const m = await mount({ ...base, roots: ["/srv/r0"], pins: [], hidden: ["/srv/r0/three"] }, ws);
  const roots = table("st-roots");
  await press(button(roots.querySelectorAll("tr.st-row")[0] as HTMLElement, "Remove root")!);
  expect(roots.querySelector(".st-askq")?.textContent).toContain("Remove root /srv/r0 (2 projects, 1 hidden)?");
  await m.unmount();
});

test("a root whose projects are all hidden says so, and its question counts them", async () => {
  const m = await mount({ ...base, roots: ["/srv/r0"], pins: [], hidden: ["/srv/r0/one", "/srv/r0/two"] }, []);
  const roots = table("st-roots");
  const row = roots.querySelectorAll("tr.st-row")[0] as HTMLElement;
  expect(row.textContent).toContain("all 2 hidden");
  expect(row.textContent).not.toContain("no AIDLC projects found");
  await press(button(row, "Remove root")!);
  expect(roots.querySelector(".st-askq")?.textContent).toContain("(0 projects, 2 hidden)");
  await m.unmount();
});

test("an open confirmation never outlives the rows it was asked about", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  const boxes = [...pins.querySelectorAll("tr.st-row td.st-ck input")] as HTMLInputElement[];
  for (const b of boxes.slice(0, 2)) await press(b);
  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(pins.querySelector(".st-askq")?.textContent).toBe("Remove 2 pinned folders?");

  // Narrowing the filter would leave the question counting rows that are no longer on screen.
  await type(pins.querySelector("input[type=search]") as HTMLInputElement, "p0");
  expect(pins.querySelector(".st-askq")).toBeNull();
  expect(m.saved.length).toBe(0);

  // So would ticking another row. (The filter unmounted the other rows, so their boxes are queried again.)
  await type(pins.querySelector("input[type=search]") as HTMLInputElement, "");
  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(pins.querySelector(".st-askq")?.textContent).toBe("Remove 2 pinned folders?");
  await press([...pins.querySelectorAll("tr.st-row td.st-ck input")][4] as HTMLElement);
  expect(pins.querySelector(".st-askq")).toBeNull();
  expect(pins.querySelector(".st-bulk b")?.textContent).toBe("3 selected");
  await m.unmount();
});

test("confirming a row action leaves an unrelated selection alone", async () => {
  const ws = [wsum("/srv/r0/one", "/srv/r0"), wsum("/srv/r1/two", "/srv/r1")];
  const m = await mount({ ...base, roots: ["/srv/r0", "/srv/r1"], pins: [] }, ws);
  const roots = table("st-roots");
  const rows = [...roots.querySelectorAll("tr.st-row")] as HTMLElement[];
  await press(rows[1]!.querySelector("td.st-ck input") as HTMLElement); // tick the project under /srv/r1
  expect(roots.querySelector(".st-bulk b")?.textContent).toBe("1 selected");

  // Removing the other root is nothing to do with that tick: the bar still offers Hide and Pin afterwards.
  await press(button(rows[0]!, "Remove root")!);
  expect(roots.querySelector(".st-bulk")?.getAttribute("aria-label")).toBe("Confirm this action");
  await press(button(roots.querySelector(".st-bulk")!, "Remove root")!);
  expect(m.saved[0]!.roots).toEqual(["/srv/r1"]);
  expect(roots.querySelector(".st-bulk b")?.textContent).toBe("1 selected");
  expect(button(roots.querySelector(".st-bulk")!, "Hide")).toBeDefined();
  await m.unmount();
});

test("select-all counts only the rows a bulk action could act on, and is off when there are none", async () => {
  const m = await mount({ ...base, roots: ["/srv/r0", "/srv/r1"], pins: [] }, [wsum("/srv/r0/one", "/srv/r0")]);
  const all = table("st-roots").querySelector("thead input[type=checkbox]") as HTMLInputElement;
  expect(all.getAttribute("aria-label")).toBe("Select all 1 project"); // two rows, one of them a bare root
  expect(all.disabled).toBe(false);
  await m.unmount();

  const none = await mount({ ...base, roots: ["/srv/r0"], pins: [] }, []);
  const off = table("st-roots").querySelector("thead input[type=checkbox]") as HTMLInputElement;
  expect(off.disabled).toBe(true);
  expect(off.getAttribute("aria-label")).toBe("Select all 0 projects");
  await none.unmount();
});

test("a withdrawn confirmation does not come back when the filter returns to what it was", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  const search = () => pins.querySelector("input[type=search]") as HTMLInputElement;
  await press(pins.querySelector("tr.st-row td.st-ck input") as HTMLElement);
  await press(button(pins.querySelector(".st-bulk")!, "Remove")!);
  expect(pins.querySelector(".st-askq")).not.toBeNull();

  await type(search(), "p0");
  expect(pins.querySelector(".st-askq")).toBeNull();
  await type(search(), ""); // back where it started: the question stays withdrawn, nothing to confirm by accident
  expect(pins.querySelector(".st-askq")).toBeNull();
  expect(m.saved.length).toBe(0);
  await m.unmount();
});

test("turning Diagnostics on keeps another table's Undo, and that Undo keeps Diagnostics on", async () => {
  const m = await mount(base);
  const pins = table("st-pins");
  await press(button(pins.querySelectorAll("tr.st-row")[2] as HTMLElement, "Remove")!);
  expect(pins.querySelector(".st-undo")).not.toBeNull();
  await press(document.querySelector(".st-diag input[type=checkbox]") as HTMLElement);
  expect(m.saved.at(-1)!.settings).toEqual({ scanTranscripts: true });
  expect(pins.querySelector(".st-undo")).not.toBeNull(); // the pin removal can still be undone
  await press(button(pins.querySelector(".st-undo")!, "Undo")!);
  expect(m.saved.at(-1)!.pins).toEqual(PINS);
  expect(m.saved.at(-1)!.settings).toEqual({ scanTranscripts: true });
  await m.unmount();
});

test("the in-app folder browser says what a folder is, filters, and adds a project straight from its row", async () => {
  const { FolderBrowser } = await import("../ui/src/chrome/FolderBrowser");
  const names = ["alpha", ...Array.from({ length: 13 }, (_, i) => `misc${i}`)];
  const chosen: string[] = [];
  await withServer(null, { "/code": names.map((n) => ({ name: n, isAidlc: n === "alpha" })) }, async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<FolderBrowser start="/code" title="Choose a project folder" selectLabel="Add this folder" onSelect={(p) => chosen.push(p)} onCancel={() => {}} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const dlg = document.querySelector(".dlg.fb") as HTMLElement;
    expect(dlg.querySelector("#cc-fb-h")?.textContent).toBe("Choose a project folder");
    expect(dlg.querySelector(".fb-summary")?.textContent).toContain("1 AIDLC project inside");
    await type(dlg.querySelector('input[aria-label="Filter folders"]') as HTMLInputElement, "misc1");
    expect(dlg.querySelectorAll(".fb-row").length).toBe(4); // misc1, misc10, misc11, misc12
    await type(dlg.querySelector('input[aria-label="Filter folders"]') as HTMLInputElement, "");
    await press(dlg.querySelector('[aria-label="Add this folder: alpha"]') as HTMLElement);
    expect(chosen).toEqual(["/code/alpha"]);
    await press(button(dlg, "Add this folder")!);
    expect(chosen).toEqual(["/code/alpha", "/code"]);
    await act(async () => { root.unmount(); }); host.remove();
  });
});

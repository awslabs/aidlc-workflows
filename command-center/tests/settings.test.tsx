import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { repoUrlProblem } from "../../core/command-center/server/repos";
import type { HomePayload, IntentSummary, WorkspaceSummary } from "../../core/command-center/server/types";
import type { Config } from "../ui/src/api";
import { wantsSettings } from "../ui/src/App";
import { crumbs, folderSummary } from "../ui/src/chrome/FolderBrowser";
import { SetupDialog } from "../ui/src/chrome/SetupDialog";
import {
  addedText, addEntry, addFolderProblem, addProblem, filterRows, hiddenOrigin, hiddenRows, hiddenUnder, hideEntries, isUnder, lastActivity,
  pathText, pinRows, projectRows, projectsUnder, relocatePin, removeEntries, repoOwnerName, repoRows, rootSortKey,
  placementFor, sortRows,
} from "../ui/src/chrome/settingsView";
import { LiveContext, type Live } from "../ui/src/useLive";

const intent = (name: string) => ({ name } as IntentSummary);
const wsum = (o: Partial<WorkspaceSummary> & { path: string }): WorkspaceSummary =>
  ({ label: o.path.split("/").pop()!, origin: "root", root: null, status: "ok", problem: null, intents: [], rulesLearned: 0, sampleRule: null, ...o });

function render(config: Config, workspaces: WorkspaceSummary[]): string {
  const home: HomePayload = { workspaces, needs: [], generatedAt: "2026-08-13T00:00:00Z" };
  const live = { home } as unknown as Live;
  return renderToStaticMarkup(<LiveContext.Provider value={live}><SetupDialog first={false} config={config} saveConfig={async () => true} onClose={() => {}} /></LiveContext.Provider>);
}

const cfg: Config = { version: 1, roots: ["/srv/code"], pins: ["/opt/pinned-app", "/opt/gone"], hidden: ["/srv/code/old-thing"],
  repos: ["https://github.com/example/app", "git@gitlab.com:example/svc.git"], theme: "auto" };
const ws = [
  wsum({ path: "/srv/code/alpha", root: "/srv/code", intents: ["one", "two", "three", "four", "five"].map(intent) }),
  wsum({ path: "/srv/code/beta", root: "/srv/code", status: "partial", problem: "state unreadable", intents: [intent("solo")] }),
  wsum({ path: "/srv/code/gamma", root: "/srv/code", status: "empty" }),
  wsum({ path: "/opt/pinned-app", origin: "pin", intents: [intent("pinned-intent")] }),
  wsum({ path: "/opt/gone", origin: "pin", status: "missing" }),
];

test("each discovered project is a row of its own, with its root, intents, status and actions", () => {
  const h = render(cfg, ws);
  expect(h).toContain("3 projects"); // the count beside the heading
  for (const n of ["alpha", "beta", "gamma"]) expect(h).toContain(`<span class="cname" title="${n}">${n}</span>`);
  for (const p of ["/srv/code/alpha", "/srv/code/beta", "/srv/code/gamma"]) expect(h).toContain(`title="${p}"`);
  expect(h).toContain("5 intents: one, two, three +2 more");
  expect(h).toContain("1 intent: solo");
  expect(h).toContain('title="state unreadable"');
  expect(h).toContain(" partial<"); expect(h).toContain(" no intents yet<");
  expect(h.match(/>Hide<\/button>/g)?.length).toBe(5); // one per project row, and one per pinned folder
  expect(h.match(/>Pin</g)?.length).toBe(3);
  // Removing the root lives in the Root cell, named in full for anyone who cannot see the column.
  expect(h.match(/aria-label="Remove root \/srv\/code"/g)?.length).toBe(3);
  expect(h).toContain("class=\"linkbtn st-rmroot\"");
});
test("a root with nothing under it is still a row, and says so instead of disappearing", () => {
  const h = render({ ...cfg, roots: ["/srv/code", "/srv/nothing"] }, ws);
  expect(h).toContain(" no AIDLC projects found<");
  expect(h).toContain('aria-label="Nothing to select on this row"'); // nothing for a bulk action to act on
  expect(h).toContain(">Remove root<");
  expect(h).toContain('title="This root has no project to name"');
});
test("pins show intents, status and Locate / Hide / Remove; hidden paths can be unhidden", () => {
  const h = render(cfg, ws);
  expect(h).toContain("1 intent: pinned-intent"); expect(h).toContain(" not found<");
  expect(h).toContain("Locate…"); expect(h).toContain(">Remove<");
  expect(h).toContain("/srv/code/old-thing"); expect(h).toContain(">Unhide<");
  // One way in for local folders: the Add a project folder panel, not an add row per table.
  expect(h.match(/Choose a folder…/g)?.length).toBe(1);
  expect(h).not.toContain("Browse…");
  // The Hidden table says which saved entry the path came from.
  expect(h).toContain('<span class="faint">root</span> <span class="mono st-pathcell" title="/srv/code">');
});
test("saved repos are listed with their host, owner/name and an honest not-read status", () => {
  const h = render(cfg, ws);
  expect(h).toContain(">GitHub<"); expect(h).toContain(">GitLab<");
  expect(h).toContain(">example/app<"); expect(h).toContain(">example/svc<");
  expect(h).toContain("https://github.com/example/app"); expect(h).toContain("git@gitlab.com:example/svc.git");
  expect(h.match(/saved — not read yet \(phase 2\)/g)?.length).toBe(2);
  expect(h).toContain(">Copy URL<");
});
test("all four lists are tables: a heading, sortable headers, select-all and an actions column", () => {
  const h = render(cfg, ws);
  for (const id of ["st-roots", "st-pins", "st-repos", "st-hidden"]) expect(h).toContain(`aria-labelledby="${id}-h"`);
  for (const label of ["Path", "Project", "Intents", "Status", "Last activity", "Name", "Host", "Repo", "URL", "Was under"]) {
    expect(h).toContain(`class="thsort">${label}<`);
  }
  expect(h).toContain('class="thsort on">Root<'); // the column the roots table is already sorted by
  expect(h.match(/aria-sort="none"/g)?.length).toBe(5 + 5 + 3 + 2); // sortable headers that are not sorted yet
  expect(h.match(/aria-sort="ascending"/g)?.length).toBe(1); // the roots table opens on Root, then Project
  expect(h.match(/<th>Actions<\/th>/g)?.length).toBe(4);
  expect(h).toContain('aria-label="Select all 3 projects"');
  expect(h).toContain('aria-label="Select /opt/gone"');
  expect(h).toContain('aria-label="Select git@gitlab.com:example/svc.git"');
});
test("with nothing saved only the add panel shows; empty tables stay out of the way, no filter box until a list is long", () => {
  const h = render({ version: 1, roots: [], pins: [], hidden: [], repos: [], theme: "auto" }, []);
  expect(h).toContain('class="af af-first"'); // the panel is the whole point of the dialog
  expect(h).toContain("Add a project folder");
  for (const id of ["st-roots", "st-pins", "st-hidden"]) expect(h).not.toContain(`aria-labelledby="${id}-h"`);
  expect(h).toContain('<details class="st-more">'); // repositories and diagnostics are tucked away
  expect(h).toContain("No repositories saved");
  expect(h).not.toContain('aria-label="Filter projects"');
  const long = render({ ...cfg, roots: Array.from({ length: 9 }, (_, i) => `/srv/r${i}`) }, []);
  expect(long).toContain('aria-label="Filter projects"'); // nine roots, each its own row
  expect(long).not.toContain('aria-label="Filter repositories"');
});
test("folder-browser crumbs and the settings deep link", () => {
  expect(crumbs("/")).toEqual([{ label: "/", path: "/" }]);
  expect(crumbs("/a/b").map((c) => c.path)).toEqual(["/", "/a", "/a/b"]);
  expect(crumbs("C:\\x\\y").map((c) => c.path)).toEqual(["C:\\", "C:\\x", "C:\\x\\y"]);
  expect(wantsSettings("#/?settings=1")).toBe(true); expect(wantsSettings("#/?a=b&settings=1")).toBe(true);
  expect(wantsSettings("#/")).toBe(false); expect(wantsSettings("#/?settings=10")).toBe(false);
});
test("Locate… replaces the pin and drops the old path from hidden", () => {
  const c = relocatePin({ ...cfg, pins: ["/a", "/b", "/c"], hidden: ["/b", "/z"] }, "/b", "/c");
  expect(c.pins).toEqual(["/a", "/c"]); expect(c.hidden).toEqual(["/z"]);
});
test("the repo add field explains why a URL is refused", () => {
  expect(repoUrlProblem("https://x:tok@github.com/e/a")).toBe("Remove credentials from the URL — tokens will live in the OS keychain (phase 2)");
  expect(repoUrlProblem("ftp://x")).toBe("Use an https://, ssh:// or git@host:path URL");
  expect(repoUrlProblem("git@github.com:e/a")).toBeNull();
});

// ---- Follow-up C: the four settings tables. Pure view logic (rows, derived columns, edits, sort, filter). ----

const at = (iso: string) => ({ lastEventTs: iso } as IntentSummary);

test("the discovery table is one row per project, grouped under the root that found it", () => {
  const rows = projectRows({ ...cfg, roots: ["/srv/code", "/srv/nothing"] }, ws, true);
  expect(rows.map((r) => r.id)).toEqual(["/srv/code/alpha", "/srv/code/beta", "/srv/code/gamma", "root:/srv/nothing"]);
  expect(rows[0]).toMatchObject({ name: "alpha", path: "/srv/code/alpha", root: "/srv/code", intents: 5 });
  expect(rows[0]!.status.label).toBe("OK");
  expect(rows[1]!.status).toMatchObject({ label: "partial", title: "state unreadable" });
  expect(rows[2]!.status.label).toBe("no intents yet");
  expect(rows[0]!.last).toBeNull(); // no intent in the fixture records an event: never guessed
});
test("a root with nothing under it keeps a row of its own, and says so only once the payload is in", () => {
  const empty = projectRows({ ...cfg, roots: ["/srv/nothing"] }, [], true)[0]!;
  expect(empty).toMatchObject({ id: "root:/srv/nothing", root: "/srv/nothing", ws: null, name: null, path: null, intents: null, last: null });
  expect(empty.status).toMatchObject({ glyph: "◌", label: "no AIDLC projects found", cls: "dim" });
  // Before /api/home answers, an empty root is unread — never reported as empty.
  expect(projectRows({ ...cfg, roots: ["/srv/nothing"] }, [], false)[0]!.status.label).toBe("not read yet");
});
test("the default order is the root, then the project inside it; filtering spans name, path and root", () => {
  const c = { ...cfg, roots: ["/srv/zeta", "/srv/code"] };
  const extra = [...ws, wsum({ path: "/srv/zeta/one", root: "/srv/zeta" })];
  const sorted = sortRows(projectRows(c, extra, true), rootSortKey, false);
  expect(sorted.map((r) => r.id)).toEqual(["/srv/code/alpha", "/srv/code/beta", "/srv/code/gamma", "/srv/zeta/one"]);
  const rows = projectRows(c, extra, true);
  const text = (r: (typeof rows)[number]) => [r.name, pathText(r.path), pathText(r.root)];
  expect(filterRows(rows, "zeta", text).map((r) => r.id)).toEqual(["/srv/zeta/one"]);
  expect(filterRows(rows, "beta", text).map((r) => r.id)).toEqual(["/srv/code/beta"]);
  expect(filterRows(rows, "/srv/code", text).length).toBe(3);
  // A reader filtering by what the cell shows (abbreviated) matches too.
  expect(pathText("/Users/someone/work")).toContain("~/work");
});
test("removing a root reports how many projects it covers", () => {
  expect(projectsUnder(ws, ["/srv/code"]).length).toBe(3);
  expect(projectsUnder(ws, ["/srv/nothing"]).length).toBe(0);
});
test("last activity is the newest recorded event across the entry's intents, never a guess", () => {
  expect(lastActivity([])).toBeNull();
  expect(lastActivity([wsum({ path: "/a", intents: [intent("x")] })])).toBeNull();
  const w = wsum({ path: "/a", intents: [at("2026-09-01T10:00:00Z"), at("not a date"), at("2026-09-03T09:00:00Z")] });
  expect(lastActivity([w])).toBe("2026-09-03T09:00:00Z");
});
test("pin rows name the folder, report hidden pins and keep the workspace status", () => {
  const rows = pinRows(cfg, ws, true);
  expect(rows.map((r) => r.name)).toEqual(["pinned-app", "gone"]);
  expect(rows[0]!.status).toMatchObject({ label: "OK", cls: "ok" });
  expect(rows[0]!.intents).toBe(1);
  expect(rows[1]!.status.label).toBe("not found");
  const hid = pinRows({ ...cfg, hidden: ["/opt/pinned-app"] }, ws, true)[0]!;
  expect(hid.hidden).toBe(true);
  expect(hid.status.label).toBe("hidden");
  // A pin the dashboard has not read yet never gets a made-up status.
  expect(pinRows(cfg, [], false)[0]!.status.label).toBe("not read yet");
});
test("repo rows derive the host and owner/name, and leave unparseable URLs as null", () => {
  expect(repoRows(cfg).map((r) => [r.host, r.repo])).toEqual([["GitHub", "example/app"], ["GitLab", "example/svc"]]);
  expect(repoOwnerName("https://github.com/example/app")).toBe("example/app");
  expect(repoOwnerName("https://github.com/example/app.git")).toBe("example/app");
  expect(repoOwnerName("https://github.com/example/app/")).toBe("example/app");
  expect(repoOwnerName("git@bitbucket.org:team/repo.git")).toBe("team/repo");
  expect(repoOwnerName("https://dev.azure.com/org/proj/_git/repo")).toBe("proj/repo");
  expect(repoOwnerName("https://git.example.com/solo.git")).toBeNull();
  expect(repoOwnerName("ssh://git@host/group/sub/app.git")).toBe("sub/app");
});
test("hidden rows say which root or pin the path was under", () => {
  expect(isUnder("/srv/code/x", "/srv/code")).toBe(true);
  expect(isUnder("/srv/code", "/srv/code")).toBe(false);
  expect(isUnder("/srv/codex/x", "/srv/code")).toBe(false);
  const rows = hiddenRows({ ...cfg, hidden: ["/srv/code/old-thing", "/opt/pinned-app", "/elsewhere/x"] });
  expect(rows[0]!.origin).toEqual({ kind: "root", path: "/srv/code" });
  expect(rows[1]!.origin).toEqual({ kind: "self" });
  expect(rows[2]!.origin).toBeNull();
  // The deepest matching entry wins.
  expect(hiddenOrigin("/srv/code/a/b", { ...cfg, pins: ["/srv/code/a"] })).toEqual({ kind: "pin", path: "/srv/code/a" });
});
test("adding is refused with a reason: bad shape, a duplicate, or a URL carrying credentials", () => {
  expect(addProblem(cfg, "roots", "relative/path")).toBe("Use a full path starting with / (~ is not expanded), or Browse…");
  expect(addProblem(cfg, "roots", "/srv/code/")).toBe("Already added");
  expect(addProblem(cfg, "pins", "/opt/pinned-app")).toBe("Already added");
  expect(addProblem(cfg, "pins", "/new/place")).toBeNull();
  expect(addProblem(cfg, "repos", "https://tok@github.com/e/a")).toBe("Remove credentials from the URL — tokens will live in the OS keychain (phase 2)");
  expect(addProblem(cfg, "repos", "https://github.com/example/app")).toBe("Already added");
  // A trailing slash is the same repository, and removal normalises the same way.
  expect(addProblem(cfg, "repos", "https://github.com/example/app/")).toBe("Already added");
  expect(removeEntries(cfg, "repos", ["https://github.com/example/app/"]).repos).toEqual(["git@gitlab.com:example/svc.git"]);
  expect(addEntry(cfg, "roots", "/srv/more").roots).toEqual(["/srv/code", "/srv/more"]);
});
test("removing several entries at once also forgets hidden paths that nothing watches any more", () => {
  const c = { ...cfg, roots: ["/srv/code", "/srv/other"], hidden: ["/srv/code/old-thing", "/srv/other/x", "/opt/pinned-app"] };
  const next = removeEntries(c, "roots", ["/srv/code", "/srv/other"]);
  expect(next.roots).toEqual([]);
  expect(next.hidden).toEqual(["/opt/pinned-app"]); // still covered by the pin
  expect(removeEntries(c, "repos", c.repos).repos).toEqual([]);
  expect(removeEntries(c, "hidden", ["/srv/other/x"]).hidden).toEqual(["/srv/code/old-thing", "/opt/pinned-app"]);
  // The config the edit started from is untouched, so Undo can PUT it back verbatim.
  expect(c.roots).toEqual(["/srv/code", "/srv/other"]);
  expect(c.hidden).toEqual(["/srv/code/old-thing", "/srv/other/x", "/opt/pinned-app"]);
});
test("hiding is additive and deduped; bulk hide on a root covers the projects found under it", () => {
  expect(hideEntries(cfg, ["/a", "/srv/code/old-thing", "/a"]).hidden).toEqual(["/srv/code/old-thing", "/a"]);
  expect(projectsUnder(ws, ["/srv/code"])).toEqual(["/srv/code/alpha", "/srv/code/beta", "/srv/code/gamma"]);
  expect(projectsUnder(ws, ["/nothing"])).toEqual([]);
});
test("sorting puts unknown values last in both directions; filtering spans every column's text", () => {
  const rows = [{ n: "b", v: 2 as number | null }, { n: "a", v: null }, { n: "c", v: 1 }];
  expect(sortRows(rows, (r) => r.v, false).map((r) => r.n)).toEqual(["c", "b", "a"]);
  expect(sortRows(rows, (r) => r.v, true).map((r) => r.n)).toEqual(["b", "c", "a"]);
  expect(sortRows(rows, (r) => r.n, false).map((r) => r.n)).toEqual(["a", "b", "c"]);
  expect(filterRows(rows, "", (r) => [r.n]).length).toBe(3);
  expect(filterRows(rows, "B", (r) => [r.n, String(r.v)]).map((r) => r.n)).toEqual(["b"]);
  expect(filterRows(rows, "1", (r) => [r.n, String(r.v)]).map((r) => r.n)).toEqual(["c"]);
});

test("every abbreviated path and URL carries the whole value, on hover and for a screen reader", () => {
  const h = render({ ...cfg, roots: ["/Users/someone/work"], pins: ["/Users/someone/pinned"], hidden: ["/Users/someone/work/old"],
    repos: ["https://git.example.com/a/b"] }, [wsum({ path: "/Users/someone/work/app", root: "/Users/someone/work", intents: [intent("i")] })]);
  // The eye gets the abbreviated form; hover and assistive technology get the absolute one.
  expect(h).toContain('<span aria-hidden="true">~/work/app</span><span class="vh">/Users/someone/work/app</span>');
  for (const full of ["/Users/someone/work/app", "/Users/someone/work", "/Users/someone/pinned", "/Users/someone/work/old", "https://git.example.com/a/b"]) {
    expect(h).toContain(`title="${full}"`);
    expect(h).toContain(`<span class="vh">${full}</span>`);
  }
  expect(h).toContain(">~/pinned<"); expect(h).toContain(">~/work/old<");
});

test("the root-then-project order holds when one root's path is a prefix of another's", () => {
  const c = { ...cfg, roots: ["/srv/ab", "/srv/a", "/Users/someone/work2", "/Users/someone/work"] };
  const found = [
    wsum({ path: "/srv/ab/app", root: "/srv/ab" }),
    wsum({ path: "/srv/a/zebra", root: "/srv/a" }),
    wsum({ path: "/Users/someone/work2/aa", root: "/Users/someone/work2" }),
    wsum({ path: "/Users/someone/work/zz", root: "/Users/someone/work" }),
  ];
  // "/srv/a" sorts before "/srv/ab" whatever the projects are called; the same for ~/work before ~/work2.
  // (Roots themselves are compared the way the rest of the app compares names: case-insensitively.)
  expect(sortRows(projectRows(c, found, true), rootSortKey, false).map((r) => r.id))
    .toEqual(["/srv/a/zebra", "/srv/ab/app", "/Users/someone/work/zz", "/Users/someone/work2/aa"]);
  // Two projects under one root keep their own order.
  const two = { ...cfg, roots: ["/srv/a"] };
  const rows = projectRows(two, [wsum({ path: "/srv/a/b", root: "/srv/a" }), wsum({ path: "/srv/a/a", root: "/srv/a" })], true);
  expect(sortRows(rows, rootSortKey, false).map((r) => r.name)).toEqual(["a", "b"]);
  expect(sortRows(rows, rootSortKey, true).map((r) => r.name)).toEqual(["b", "a"]);
});
test("a column can sort on more than one key at a time", () => {
  const rows = [{ v: ["b", "a"] }, { v: ["a", "z"] }, { v: ["a", "b"] }, { v: null }];
  expect(sortRows(rows, (r) => r.v, false).map((r) => r.v?.join("/"))).toEqual(["a/b", "a/z", "b/a", undefined]);
  expect(sortRows(rows, (r) => r.v, true).map((r) => r.v?.join("/"))).toEqual(["b/a", "a/z", "a/b", undefined]);
});
test("a root whose every project is hidden says so instead of claiming it found nothing", () => {
  const c = { ...cfg, roots: ["/srv/code"], hidden: ["/srv/code/alpha", "/srv/code/beta"] };
  expect(hiddenUnder(c, "/srv/code")).toEqual(["/srv/code/alpha", "/srv/code/beta"]);
  expect(hiddenUnder(c, "/srv/other")).toEqual([]);
  // Discovery leaves hidden projects out of the payload, so the root looks empty unless hidden is consulted.
  const row = projectRows(c, [], true)[0]!;
  expect(row.status).toMatchObject({ glyph: "◌", label: "all 2 hidden", cls: "dim" });
  expect(row.status.title).toContain("Hidden");
  expect(row.hiddenCount).toBe(2);
  // Nothing hidden under it: it really did find nothing.
  expect(projectRows({ ...cfg, roots: ["/srv/code"], hidden: [] }, [], true)[0]!.status.label).toBe("no AIDLC projects found");
  // One visible project and one hidden: the row is the project, and the hidden one is still counted for the root.
  const mixed = projectRows({ ...cfg, roots: ["/srv/code"], hidden: ["/srv/code/beta"] }, [ws[0]!], true);
  expect(mixed.length).toBe(1);
  expect(mixed[0]!.status.label).toBe("OK");
  expect(mixed[0]!.hiddenCount).toBe(1);
});

test("the roots count says how many projects there are, not how many rows", () => {
  // Two rows, one of them a root with nothing visible under it: "2 projects" would overstate.
  const h = render({ ...cfg, roots: ["/srv/code", "/srv/nothing"], pins: [], hidden: [] }, [ws[0]!]);
  expect(h).toContain("1 project · 1 root with none shown");
  expect(h).not.toContain("2 projects");
  const plain = render({ ...cfg, roots: ["/srv/code"], pins: [], hidden: [] }, ws.slice(0, 3));
  expect(plain).toContain("3 projects");
  expect(plain).not.toContain("with none shown");
});

test("Add a project folder: a folder with aidlc/ is one project, anything else is a folder of projects", () => {
  const e = (name: string, isAidlc = false) => ({ name, path: `/x/${name}`, isAidlc });
  expect(placementFor({ entries: [e("aidlc"), e("src")] })).toEqual({ kind: "pins" });
  expect(placementFor({ entries: [e("a", true), e("b", true), e("c")] })).toEqual({ kind: "roots", found: 2 });
  expect(placementFor({ entries: [] })).toEqual({ kind: "roots", found: 0 });
  expect(addedText("/srv/code/app", { kind: "pins" })).toBe("app added as a project.");
  expect(addedText("/srv/code", { kind: "roots", found: 1 })).toBe("/srv/code added — 1 AIDLC project found inside.");
  expect(addedText("/srv/code", { kind: "roots", found: 0 })).toContain("appear automatically");
  const c = { version: 1, roots: ["/srv/code"], pins: ["/opt/one"], hidden: [], repos: [], theme: "auto" } as Config;
  expect(addFolderProblem(c, "relative/path")).toContain("full path");
  expect(addFolderProblem(c, "/srv/code/")).toBe("Already added");
  expect(addFolderProblem(c, "/opt/one")).toBe("Already added");
  expect(addFolderProblem(c, "/srv/code/app")).toBe("Already watched — it is inside /srv/code");
  expect(addFolderProblem(c, "/srv/other")).toBeNull();
});
test("folder browser summary says what the open folder is", () => {
  const l = (entries: { name: string; isAidlc: boolean }[]) => ({ path: "/x", parent: "/", truncated: false, entries: entries.map((x) => ({ ...x, path: `/x/${x.name}` })) });
  expect(folderSummary(l([{ name: "aidlc", isAidlc: false }])).text).toContain("is an AIDLC project");
  expect(folderSummary(l([{ name: "a", isAidlc: true }, { name: "b", isAidlc: true }])).text).toContain("2 AIDLC projects inside");
  expect(folderSummary(l([{ name: "a", isAidlc: false }])).cls).toBe("dim");
});

// Workspaces & settings: four tables over the saved config — discovery roots, pinned folders, remote repositories
// and hidden paths. The table itself (add row, bulk bar, sort, filter) is SettingsTable; the columns, the row
// actions and the config edits they PUT are defined here. The derived columns are pure, in settingsView.ts.
import { useEffect, useRef, useState } from "react";
import type { FolderListing, PickResult } from "../../../../core/command-center/server/folders";
import type { WorkspaceSummary } from "../../../../core/command-center/server/types";
import { type Config, get, post, q as query } from "../api";
import { fmtAgo, tilde } from "../format";
import { useLiveClock, useLiveCtx } from "../useLive";
import { AddFolder } from "./AddFolder";
import { FolderBrowser } from "./FolderBrowser";
import { type BulkAction, type Column, SettingsTable } from "./SettingsTable";
import {
  addedText, addEntry, addFolderProblem, addProblem, baseName, hideEntries, type HiddenRow, hiddenRows, hiddenUnder, pathText, type PinRow, pinRows,
  type ProjectRow, projectRows, placementFor, projectsUnder, relocatePin, removeEntries, type RepoRow, repoRows, rootSortKey,
  samePath, type StatusCell, type TableKey, UNDO_MS,
} from "./settingsView";

/** `configPath`: the settings file this run saves to, or null while unknown (then no path is named). */
interface Props { first: boolean; config: Config; configPath: string | null; saveConfig: (c: Config) => Promise<boolean>; onClose: () => void }
const SAVE_FAILED = "Could not save — the message at the bottom of the window says why";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** The tables an Undo can come from, plus the Add a project folder panel. */
type UndoKey = TableKey | "add";
const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

export function SetupDialog({ first, config, configPath, saveConfig, onClose }: Props) {
  const { home } = useLiveCtx();
  const { now, frozen } = useLiveClock();
  const loaded = !!home;
  const ws = home?.workspaces ?? [];
  // The native chooser can stay open for minutes: edits always start from the newest config, not the one at click time.
  const cfg = useRef(config); cfg.current = config;
  const [browser, setBrowser] = useState<{ reason: string; start?: string; title: string; selectLabel: string; resolve: (p: string | null) => void } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const seen = useRef(new Set<"roots" | "pins" | "hidden">());
  /** The previous config, restorable for UNDO_MS after an edit, with the table that offered it. */
  const [undo, setUndo] = useState<{ table: UndoKey; text: string; prev: Config } | null>(null);

  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !browser) onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose, browser]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), UNDO_MS); return () => clearTimeout(t); }, [undo]);

  /**
   * Every edit is a whole-config PUT (the server re-validates). `text` keeps the previous config behind an Undo
   * offer in `table`; passing null withdraws any standing offer, so Undo can never restore over a later edit.
   */
  const apply = async (table: UndoKey, text: string | null, next: Config): Promise<boolean> => {
    const prev = cfg.current;
    const ok = await saveConfig(next);
    if (ok) setUndo(text === null ? null : { table, text, prev });
    return ok;
  };
  /** The offer survives a failed restore: only a saved config withdraws it (the toast says why it failed). */
  // An undo restores the tables, never the Diagnostics setting, which is saved on its own.
  const undoNow = async () => { const u = undo; if (u && (await saveConfig({ ...u.prev, settings: cfg.current.settings }))) setUndo(null); };
  const undoFor = (t: UndoKey) => (undo?.table === t ? { text: undo.text, onUndo: () => void undoNow() } : null);

  /**
   * Browse…: the OS folder chooser via the local server, the in-app browser when it is unavailable. Resolves with
   * the chosen folder, or null when nothing was chosen (cancelled, or a chooser is already open).
   */
  const browse = async (id: string, start?: string, title = "Choose a folder", selectLabel = "Use this folder"): Promise<string | null> => {
    if (picking) return null;
    setPicking(id);
    let r: PickResult;
    try { r = await post<PickResult>("/api/folders/pick"); }
    catch (e) { r = { unavailable: `the local server did not answer (${(e as Error).message})` }; }
    finally { setPicking(null); }
    if ("path" in r) return r.path;
    if (!("unavailable" in r)) return null;
    const reason = r.unavailable;
    return new Promise<string | null>((resolve) => setBrowser({ reason, start, title, selectLabel, resolve }));
  };

  /**
   * Add a project folder: the one add for local folders. A folder with its own aidlc/ is pinned as one project;
   * any other folder is watched as a root, so every project inside it (and every new one) is listed.
   */
  const addFolder = async (value: string): Promise<string | null> => {
    const p = value.trim();
    const problem = addFolderProblem(cfg.current, p);
    if (problem) return problem;
    const l = await readFolder(p);
    if ("problem" in l) return l.problem;
    const place = placementFor(l.listing);
    if (addProblem(cfg.current, place.kind, p)) return "Already added";
    return (await apply("add", addedText(p, place), addEntry(cfg.current, place.kind, p))) ? null : SAVE_FAILED;
  };
  const addRepo = async (value: string): Promise<string | null> => {
    const u = value.trim();
    const problem = addProblem(cfg.current, "repos", u);
    if (problem) return problem;
    return (await apply("repos", null, addEntry(cfg.current, "repos", u))) ? null : SAVE_FAILED;
  };

  const hide = (table: TableKey, label: string, paths: string[]) => void apply(table, `${label} — hidden.`, hideEntries(cfg.current, paths));
  const unhide = (table: TableKey, label: string, paths: string[]) => void apply(table, `${label} — back in view.`, removeEntries(cfg.current, "hidden", paths));
  const drop = (table: TableKey, k: TableKey, label: string, ids: string[]) => void apply(table, `${label} — removed.`, removeEntries(cfg.current, k, ids));
  /** How many hidden paths removing these roots or pins also forgets, worded for the confirmation. */
  const forgetNote = (k: "roots" | "pins", ids: string[]) => {
    const n = cfg.current.hidden.length - removeEntries(cfg.current, k, ids).hidden.length;
    return n ? ` ${plural(n, "hidden path", "hidden paths")} under them ${n === 1 ? "is" : "are"} forgotten too.` : "";
  };

  /**
   * Locate…: the pin moves to the chosen folder. When that folder is already pinned the two entries collapse into
   * one, so the notice says so rather than leaving the reader to wonder where a row went.
   */
  const locate = async (r: PinRow) => {
    const to = await browse(`pin:${r.path}`, r.path, `Where is ${r.name} now?`, "Use this folder");
    if (to === null) return;
    const next = relocatePin(cfg.current, r.path, to);
    const merged = next.pins.length < cfg.current.pins.length;
    await apply("pins", merged ? `${r.name} — merged into the folder already pinned at ${tilde(to)}.` : `${r.name} — moved.`, next);
  };

  // ---- Discovery roots: one row per discovered project ----
  const pinned = (p: string | null) => p !== null && config.pins.some((x) => samePath(x, p));
  /** Projects among the selection that are not pinned yet (Pin is only worth offering for those). */
  const pinnable = (ids: string[]) => ids.filter((x) => !pinned(x));
  /** What removing a root costs: the projects it covers, and the hidden ones discovery left out of the payload. */
  const removeRoot = (root: string) => {
    const visible = projectsUnder(ws, [root]).length;
    const hidden = hiddenUnder(cfg.current, root).length;
    const covers = loaded ? `${plural(visible, "project", "projects")}${hidden ? `, ${hidden} hidden` : ""}` : "not read yet";
    return {
      question: `Remove root ${tilde(root)} (${covers})?${forgetNote("roots", [root])}`,
      run: () => drop("roots", "roots", `root ${baseName(root)}`, [root]),
    };
  };

  const projectCols: Column<ProjectRow>[] = [
    { key: "name", label: "Project", w: 96, value: (r) => r.name, text: (r) => r.name,
      cell: (r) => (r.name ? <span className="cname" title={r.name}>{r.name}</span> : <Dash why="This root has no project to name" />) },
    { key: "path", label: "Path", value: (r) => r.path && tilde(r.path), text: (r) => pathText(r.path),
      cell: (r) => (r.path ? <Path value={r.path} /> : <Dash why="This root has no project to show" />) },
    {
      key: "root", label: "Root", w: 150, value: rootSortKey, text: (r) => pathText(r.root),
      title: "The discovery root that found it — sorts by root, then by project",
      cell: (r, api) => (
        <span className="st-rootcell">
          <Path value={r.root} />
          {r.ws && <RemoveRoot root={r.root} onAsk={() => api.ask(removeRoot(r.root), "Remove root")} />}
        </span>
      ),
    },
    { key: "intents", label: "Intents", w: 66, cls: "num", value: (r) => r.intents,
      cell: (r) => <Count n={r.intents} title={r.ws?.intents.length ? intentLine(r.ws) : undefined} /> },
    { key: "status", label: "Status", w: 176, value: (r) => r.status.label, text: (r) => r.status.label, cell: (r) => <Status s={r.status} /> },
    { key: "last", label: "Last activity", w: 100, cls: "num dim", value: (r) => ms(r.last),
      title: "The newest audit event in any of this project's intents", cell: (r) => <Ago iso={r.last} now={now} frozen={frozen} /> },
  ];
  const projectBulk: BulkAction[] = [
    {
      key: "hide", label: "Hide", confirm: (ids) => `Hide ${plural(ids.length, "project", "projects")}?`,
      run: (ids) => hide("roots", plural(ids.length, "project", "projects"), ids),
    },
    {
      key: "pin", label: "Pin",
      blocked: (ids) => (pinnable(ids).length ? null : "Already pinned"),
      confirm: (ids) => `Pin ${plural(pinnable(ids).length, "project", "projects")} so they stay listed on their own?`,
      run: (ids) => {
        const add = pinnable(ids);
        void apply("roots", `${plural(add.length, "project", "projects")} — pinned.`, { ...cfg.current, pins: [...cfg.current.pins, ...add] });
      },
    },
  ];

  // ---- Pinned folders ----
  const pinCols: Column<PinRow>[] = [
    { key: "name", label: "Name", w: 130, value: (r) => r.name, text: (r) => r.name, cell: (r) => <span className="cname" title={r.ws ? undefined : "Named after the folder — the dashboard has not read it"}>{r.name}</span> },
    { key: "path", label: "Path", value: (r) => tilde(r.path), text: (r) => pathText(r.path), cell: (r) => <Path value={r.path} /> },
    { key: "intents", label: "Intents", w: 72, cls: "num", value: (r) => r.intents, cell: (r) => <Count n={r.intents} title={r.ws?.intents.length ? intentLine(r.ws) : undefined} /> },
    { key: "status", label: "Status", w: 150, value: (r) => r.status.label, text: (r) => r.status.label, cell: (r) => <Status s={r.status} /> },
    { key: "last", label: "Last activity", w: 104, cls: "num dim", value: (r) => ms(r.last), cell: (r) => <Ago iso={r.last} now={now} frozen={frozen} /> },
  ];
  const pinBulk: BulkAction[] = [
    { key: "remove", label: "Remove", confirm: (ids) => `Remove ${plural(ids.length, "pinned folder", "pinned folders")}?${forgetNote("pins", ids)}`, run: (ids) => drop("pins", "pins", plural(ids.length, "pinned folder", "pinned folders"), ids) },
    {
      key: "hide", label: "Hide",
      blocked: (ids) => (ids.some((p) => !cfg.current.hidden.some((h) => samePath(h, p))) ? null : "Already hidden"),
      confirm: (ids) => `Hide ${plural(ids.length, "pinned folder", "pinned folders")}?`,
      run: (ids) => hide("pins", plural(ids.length, "pinned folder", "pinned folders"), ids),
    },
  ];

  // ---- Remote repositories ----
  const repoCols: Column<RepoRow>[] = [
    { key: "host", label: "Host", w: 98, value: (r) => r.host, text: (r) => r.host, cell: (r) => <span className="chip">{r.host}</span> },
    { key: "repo", label: "Repo", w: 158, value: (r) => r.repo, text: (r) => r.repo, cell: (r) => (r.repo ? <span className="mono" title={r.repo}>{r.repo}</span> : <span className="faint" title="The URL does not spell out an owner and a repository name">—</span>) },
    { key: "url", label: "URL", value: (r) => r.url, text: (r) => r.url, cell: (r) => <Path value={r.url} /> },
    { key: "state", label: "Status", w: 190, cell: () => <span className="chip" title="Saved in your settings only. Nothing is fetched from this repository until phase 2.">saved — not read yet (phase 2)</span> },
  ];

  // ---- Hidden ----
  const hiddenCols: Column<HiddenRow>[] = [
    { key: "path", label: "Path", value: (r) => tilde(r.path), text: (r) => pathText(r.path), cell: (r) => <Path value={r.path} /> },
    { key: "under", label: "Was under", w: 320, value: (r) => underLabel(r.origin), text: (r) => (r.origin && "path" in r.origin ? r.origin.path : underLabel(r.origin)), cell: (r) => <WasUnder row={r} /> },
  ];

  const pins = pinRows(config, ws, loaded);
  /**
   * A table appears once it has rows and then stays for as long as the dialog is open, so removing its last row
   * keeps the table, its Undo and the keyboard where they were.
   */
  const shows = (k: "roots" | "pins" | "hidden") => {
    if (config[k].length > 0) seen.current.add(k);
    return seen.current.has(k);
  };

  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg settings-dlg" role="dialog" aria-modal="true" aria-labelledby="cc-setup-h" data-loaded={home ? "" : undefined}>
        <div className="st-top">
          <h3 id="cc-setup-h">{first ? "Welcome — where do your AIDLC projects live?" : "Workspaces & settings"}</h3>
          <div className="dim st-note">
            {first ? "Add the folder where your projects are. You only do this once — it is remembered every time you open the dashboard."
              : configPath
                ? <>Saved automatically to <span className="mono" title={configPath}>{tilde(configPath)}</span>. Nothing is written inside your projects.</>
                : <>Saved automatically. Nothing is written inside your projects.</>}
          </div>
          {picking && <div className="dim st-note" role="status">A folder chooser is open — it may be behind this window.</div>}
        </div>

        <div className="st-body">
          <AddFolder first={first || (!config.roots.length && !config.pins.length)} onChoose={() => browse("add", undefined, "Choose a project folder", "Add this folder")}
            onAdd={addFolder} choosing={picking === "add"} chooserBusy={!!picking} done={undoFor("add")} />

          {shows("roots") && <SettingsTable id="st-roots" noun={["project", "projects"]} rows={projectRows(config, ws, loaded)} idOf={(r) => r.id}
            cols={projectCols} actionsW={94} defaultSort="root" selectable={(r) => !!r.ws}
            count={(shown, all) => {
              const found = shown.filter((r) => r.ws).length;
              const bare = shown.length - found;
              return `${shown.length === all.length ? "" : `${shown.length} of ${all.length} rows · `}${plural(found, "project", "projects")}${bare ? ` · ${plural(bare, "root", "roots")} with none shown` : ""}`;
            }}
            title={<>Folders of projects <span className="st-sub">every AIDLC project inside is found automatically</span></>}
            hint={<>A parent folder you added, such as <span className="mono">~/code</span>. Every folder inside it that has an <span className="mono">aidlc/</span> folder
              is listed here, up to 4 levels deep, including projects you create later. <b>Hide</b> takes one project off Home; <b>Remove root</b> stops watching the whole folder.</>}
            empty="No folders of projects yet."
            bulk={projectBulk} undo={undoFor("roots")}
            actions={(r, api) => <ProjectActions row={r} pinned={pinned(r.path)}
              onHide={(w) => hide("roots", w.label, [w.path])}
              onPin={(w) => void apply("roots", `${w.label} — pinned.`, addEntry(cfg.current, "pins", w.path))}
              onRemoveRoot={() => api.ask(removeRoot(r.root), "Remove root")} />} />}

          {shows("pins") && <SettingsTable id="st-pins" noun={["pinned folder", "pinned folders"]} rows={pins} idOf={(r) => r.path} cols={pinCols} actionsW={174}
            title={<>Single projects <span className="st-sub">one project folder, watched on its own</span></>}
            hint={<>A folder that is itself an AIDLC project (it has its own <span className="mono">aidlc/</span> folder). Only that folder is watched.
              If you move or rename it, use <b>Locate…</b> to point to its new place.</>}
            empty="No single projects yet."
            bulk={pinBulk} undo={undoFor("pins")}
            actions={(r) => (
              <>
                <button type="button" className="linkbtn" disabled={!!picking} onClick={() => void locate(r)}>{picking === `pin:${r.path}` ? "locating…" : "Locate…"}</button>
                {r.hidden
                  ? <button type="button" className="linkbtn" onClick={() => unhide("pins", r.name, [r.path])}>Unhide</button>
                  : <button type="button" className="linkbtn" onClick={() => hide("pins", r.name, [r.path])}>Hide</button>}
                <button type="button" className="linkbtn" onClick={() => drop("pins", "pins", r.name, [r.path])}>Remove</button>
              </>
            )} />}

          {shows("hidden") && <SettingsTable id="st-hidden" noun={["hidden path", "hidden paths"]} rows={hiddenRows(config)} idOf={(r) => r.path} cols={hiddenCols} actionsW={92}
            title={<>Hidden <span className="st-sub">left off Home — nothing is deleted</span></>}
            hint={<>Projects you chose not to see. They stay on disk and keep working; the dashboard just leaves them off Home. A project inside a watched
              folder would be found again if removed, so hiding is how you leave it out. <b>Unhide</b> brings it back.</>}
            empty="Nothing hidden. Hide a project from its card or from the tables above; it stays listed here so you can bring it back."
            bulk={[{ key: "unhide", label: "Unhide", confirm: (ids) => `Unhide ${plural(ids.length, "path", "paths")}?`, run: (ids) => unhide("hidden", plural(ids.length, "path", "paths"), ids) }]}
            undo={undoFor("hidden")}
            actions={(r) => <button type="button" className="linkbtn" onClick={() => unhide("hidden", baseName(r.path), [r.path])}>Unhide</button>} />}

          <details className="st-more">
            <summary>More settings <span className="faint">remote repositories · diagnostics</span></summary>
          <SettingsTable id="st-repos" noun={["repository", "repositories"]} rows={repoRows(config)} idOf={(r) => r.url} cols={repoCols} actionsW={126}
            title={<>Remote repositories <span className="chip">phase 2 · Leadership view</span></>}
            hint="Only the URL is saved. No network access and no tokens in phase 1."
            empty="No repositories saved — add a URL and it is kept with your settings for phase 2."
            add={{ placeholder: "Add a repo URL — GitHub · GitLab · Bitbucket · Azure DevOps · any git (Enter to add)", label: "Add a repo URL", onAdd: addRepo }}
            bulk={[{ key: "remove", label: "Remove", confirm: (ids) => `Remove ${plural(ids.length, "repository", "repositories")}?`, run: (ids) => drop("repos", "repos", plural(ids.length, "repository", "repositories"), ids) }]}
            undo={undoFor("repos")}
            actions={(r) => (
              <>
                <CopyUrl url={r.url} />
                <button type="button" className="linkbtn" onClick={() => drop("repos", "repos", "1 repository", [r.url])}>Remove</button>
              </>
            )} />

          <Diagnostics config={config} save={(next) => void saveConfig(next)} />
          </details>
        </div>

        <div className="row st-foot">
          <span className="grow" />
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
          <button className="btn" type="button" onClick={onClose}>{first ? "Start watching" : "Done"}</button>
        </div>
      </div>
      {browser && <FolderBrowser start={browser.start} reason={browser.reason} title={browser.title} selectLabel={browser.selectLabel}
        onCancel={() => { const b = browser; setBrowser(null); b.resolve(null); }}
        onSelect={(p) => { const b = browser; setBrowser(null); b.resolve(p); }} />}
    </div>
  );
}

/**
 * The one opt-in: reading Claude Code transcripts for hook failures (AIDLC does not record a hook crash). Off by default;
 * the server reads only transcripts AIDLC names, inside ~/.claude/projects, and keeps only the hook-failure fields.
 */
export function Diagnostics({ config, save }: { config: Config; save: (c: Config) => void }) {
  const on = config.settings?.scanTranscripts === true;
  return (
    <div className="st-diag">
      <div className="lbl">Diagnostics</div>
      <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={on} onChange={(e) => save({ ...config, settings: { ...config.settings, scanTranscripts: e.target.checked } })} />
        <span>
          <b>Read hook failures from Claude Code transcripts</b> <span className={on ? "ok" : "faint"}>{on ? "✓ on" : "○ off"}</span>
          <div className="dim" style={{ fontSize: ".84rem" }}>
            AIDLC does not record a hook that crashes. When this is on, the Health page reads the transcripts each workspace's
            <span className="mono"> aidlc/.aidlc-sessions/*.transcript</span> files name — only inside <span className="mono">~/.claude/projects</span>, read-only —
            and keeps only each hook failure's hook, event, time and error text. Conversation content is never kept or shown.
          </div>
        </span>
      </label>
    </div>
  );
}

/** The folder's listing, or why it cannot be added: the server's 404 is the only honest "not a folder" the UI gets. */
async function readFolder(path: string): Promise<{ listing: FolderListing } | { problem: string }> {
  try { return { listing: await get<FolderListing>(`/api/folders/list?${query({ path })}`) }; }
  catch (e) {
    const m = (e as Error).message;
    if (m.startsWith("404")) return { problem: "Not a folder — check the path, or use Choose a folder…" };
    if (m.startsWith("403")) return { problem: "That folder cannot be opened (permission denied)" };
    return { problem: `Could not read that folder — ${m}` };
  }
}

/** "3 intents: a, b, c +2 more". */
export function intentLine(w: WorkspaceSummary): string {
  const n = w.intents.length; const names = w.intents.slice(0, 3).map((i) => i.name);
  return `${n} intent${n === 1 ? "" : "s"}: ${names.join(", ")}${n > 3 ? ` +${n - 3} more` : ""}`;
}
/** Status is always glyph + label + colour; the detail (what the server reported) is the hover title. */
export function Status({ s }: { s: StatusCell }) {
  return <span className={s.cls} title={s.title}><span aria-hidden>{s.glyph}</span> {s.label}</span>;
}
/**
 * A path or URL on one line: abbreviated and ellipsised for the eye, whole on hover (`title`) and whole for
 * screen readers (the visible text is hidden from them, the full value is read instead). The visible text stays
 * selectable, and a selection picks up the full value too.
 */
export function Path({ value }: { value: string }) {
  const short = tilde(value);
  return (
    <span className="mono st-pathcell" title={value}>
      <span aria-hidden="true">{short}</span>
      <span className="vh">{value}</span>
    </span>
  );
}
/** An empty cell that says why it is empty rather than looking like a missing value. */
function Dash({ why }: { why: string }) { return <span className="faint" title={why}>—</span>; }
/** Hide and Pin for a discovered project; a root that found nothing offers only Remove root. */
function ProjectActions({ row, pinned, onHide, onPin, onRemoveRoot }: {
  row: ProjectRow; pinned: boolean;
  onHide: (w: WorkspaceSummary) => void; onPin: (w: WorkspaceSummary) => void; onRemoveRoot: () => void;
}) {
  const w = row.ws;
  if (!w) return <button type="button" className="linkbtn" onClick={onRemoveRoot}>Remove root</button>;
  return (
    <>
      <button type="button" className="linkbtn" title="Take it off Home. Nothing is deleted; bring it back from Hidden." onClick={() => onHide(w)}>Hide</button>
      {pinned ? <span className="dim" title="Also listed under Single projects">pinned</span>
        : <button type="button" className="linkbtn" title="Also list it under Single projects, so it stays even if you remove this folder" onClick={() => onPin(w)}>Pin</button>}
    </>
  );
}
/** Remove a discovery root: quiet until the row is hovered or this button is focused, never hidden from the keyboard. */
function RemoveRoot({ root, onAsk }: { root: string; onAsk: () => void }) {
  return <button type="button" className="linkbtn st-rmroot" aria-label={`Remove root ${root}`} onClick={onAsk}>Remove root</button>;
}
/** A count the payload has not produced yet is "—", never 0. */
function Count({ n, title }: { n: number | null; title?: string }) {
  if (n === null) return <span className="faint" title="Not read yet">—</span>;
  return <b title={title}>{n}</b>;
}
function Ago({ iso, now, frozen }: { iso: string | null; now: number; frozen: boolean }) {
  if (!iso) return <span className="faint" title="No audit event recorded here">—</span>;
  return <span title={frozen ? `${iso} — live stream disconnected, clock paused` : iso}>{frozen ? "≥ " : ""}{fmtAgo(iso, now)}</span>;
}
/** The "Was under" value: the saved entry above the path, "this pinned folder", or null when nothing covers it. */
const underLabel = (o: HiddenRow["origin"]) => (!o ? null : o.kind === "self" ? "this pinned folder" : tilde(o.path));
function WasUnder({ row }: { row: HiddenRow }) {
  const o = row.origin;
  if (!o) return <span className="faint" title="No saved root or pin covers this path any more">—</span>;
  if (o.kind === "self") return <span className="dim">this pinned folder</span>;
  // The kind comes first so it survives the cell's ellipsis; the whole path is on the Path cell.
  return <><span className="faint">{o.kind}</span> <Path value={o.path} /></>;
}
/** Copies the URL through the clipboard API and says so in place; a refusal is reported, never swallowed. */
function CopyUrl({ url }: { url: string }) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  useEffect(() => { if (!state) return; const t = setTimeout(() => setState(""), 1600); return () => clearTimeout(t); }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setState("copied"); }
    catch { setState("failed"); }
  };
  return <button type="button" className="linkbtn" onClick={() => void copy()}>{state === "copied" ? "copied ✓" : state === "failed" ? "copy refused" : "Copy URL"}</button>;
}


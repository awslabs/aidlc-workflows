import { useEffect, useRef, useState } from "react";
import type { FolderListing } from "../../../../core/command-center/server/folders";
import { get, q } from "../api";
import { tilde } from "../format";

/** `/a/b` → `/`, `/a`, `/a/b`; `C:\a` → `C:\`, `C:\a`. Each crumb is a clickable absolute path. */
export function crumbs(path: string): { label: string; path: string }[] {
  const win = /^[A-Za-z]:[\\/]/.test(path);
  const sep = win ? "\\" : "/";
  const root = win ? `${path.slice(0, 2)}\\` : "/";
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  const out = [{ label: root, path: root }];
  let acc = root;
  for (const p of parts) { acc = acc.endsWith(sep) ? acc + p : acc + sep + p; out.push({ label: p, path: acc }); }
  return out;
}

/** What the open folder is, in one line: a project itself, a folder holding projects, or neither (yet). */
export function folderSummary(l: FolderListing): { cls: string; text: string } {
  if (l.entries.some((e) => e.name === "aidlc")) return { cls: "ok", text: "✓ This folder is an AIDLC project." };
  const n = l.entries.filter((e) => e.isAidlc).length;
  if (n) return { cls: "ok", text: `✓ ${n} AIDLC ${n === 1 ? "project" : "projects"} inside — add this folder to watch ${n === 1 ? "it" : "all of them"}.` };
  return { cls: "dim", text: "No AIDLC projects directly inside. Open a folder below, or add this one to watch everything under it." };
}

interface Props {
  start?: string;
  reason?: string;
  /** The dialog's heading. */
  title?: string;
  /** The confirm button, e.g. "Add this folder". */
  selectLabel?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}
/** A filter box appears once a folder has more sub-folders than this. */
const FILTER_ABOVE = 12;

/** The in-app folder browser: used when the OS folder chooser is unavailable. Lists folder names only. */
export function FolderBrowser({ start, reason, title = "Choose a folder", selectLabel = "Use this folder", onSelect, onCancel }: Props) {
  const [path, setPath] = useState<string | undefined>(start);
  const [data, setData] = useState<FolderListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true; setErr(null); setFilter("");
    get<FolderListing>(`/api/folders/list${path ? `?${q({ path })}` : ""}`)
      .then((d) => { if (live) { setData(d); list.current?.scrollTo?.({ top: 0 }); } })
      .catch((e: Error) => {
        if (!live) return;
        // A start folder that no longer exists (Locate… on a missing pin): open the home folder instead.
        if (path && path === start && !data) { setPath(undefined); return; }
        setErr(/^40[34]/.test(e.message) ? "That folder cannot be opened." : `Could not list folders — ${e.message}`); });
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onCancel(); } };
    addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true);
  }, [onCancel]);

  const f = filter.trim().toLowerCase();
  const entries = (data?.entries ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
  const summary = data ? folderSummary(data) : null;

  return (
    <div className="modal fb-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dlg fb" role="dialog" aria-modal="true" aria-labelledby="cc-fb-h" data-loaded={data ? "" : err ? "error" : undefined}>
        <h3 id="cc-fb-h">{title}</h3>
        {reason && <div className="dim fb-note" title={reason}>Your system folder picker isn't available here, so browse below instead.</div>}
        <div className="row fb-bar">
          <button type="button" className="btn ghost st-small" onClick={() => setPath(undefined)} title="Your home folder">⌂ Home</button>
          <button type="button" className="btn ghost st-small" disabled={!data?.parent} onClick={() => data?.parent && setPath(data.parent)} title="The folder above">↑ Up</button>
          <nav className="fb-crumbs grow" aria-label="Folder path">
            {data && crumbs(data.path).map((c, i, all) => (
              <span key={c.path}>{i > 0 && <span className="faint">{i > 1 ? " / " : " "}</span>}
                {i === all.length - 1 ? <b className="mono" title={c.path}>{c.label}</b>
                  : <button type="button" className="linkbtn mono" title={c.path} onClick={() => setPath(c.path)}>{c.label}</button>}
              </span>
            ))}
          </nav>
        </div>
        {summary && <div className={`fb-summary ${summary.cls}`} role="status">{summary.text}</div>}
        {data && data.entries.length > FILTER_ABOVE && (
          <label className="fld fb-filter">
            <span className="faint" aria-hidden>⌕</span>
            <input className="cc-input grow" type="search" value={filter} placeholder="Filter folders" aria-label="Filter folders"
              onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        <div className="fb-list" role="list" ref={list}>
          {err && <div className="bad fb-note">✗ {err}</div>}
          {!err && !data && <div className="dim fb-note">Loading…</div>}
          {data && !data.entries.length && <div className="dim fb-note">No sub-folders here.</div>}
          {data && data.entries.length > 0 && !entries.length && <div className="dim fb-note">No folders match “{filter}”.</div>}
          {entries.map((e) => (
            <div role="listitem" key={e.path} className={`fb-row${e.isAidlc ? " fb-aidlc" : ""}`}>
              <button type="button" className="fb-item" title={`Open ${e.path}`} onClick={() => setPath(e.path)}>
                <span aria-hidden="true">{e.isAidlc ? "📦" : "📁"}</span><span className="mono grow fb-name">{e.name}</span>
                {e.isAidlc && <span className="chip on">AIDLC project</span>}
                <span className="faint" aria-hidden="true">›</span>
              </button>
              {e.isAidlc && <button type="button" className="btn ghost st-small fb-pick" aria-label={`${selectLabel}: ${e.name}`} onClick={() => onSelect(e.path)}>{selectLabel.split(" ")[0]}</button>}
            </div>
          ))}
          {data?.truncated && <div className="dim fb-note">Showing the first {data.entries.length} folders.</div>}
        </div>
        <div className="row fb-foot">
          <span className="grow dim mono fb-sel" title={data?.path}>{data ? tilde(data.path) : ""}</span>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn" disabled={!data} onClick={() => data && onSelect(data.path)}>{selectLabel}</button>
        </div>
      </div>
    </div>
  );
}

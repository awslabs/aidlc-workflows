import { useEffect, useMemo, useState } from "react";
import { get, q } from "../api";
import { fmtTime } from "../format";
import { FIVE, leadLabel } from "../intent/derive";
import { useNow } from "../useLive";
import { fmtSize, lensVersion, phaseOf, takePendingArtifact, useLens, type Filter, type XLensProps } from "./common";
import { Markdown } from "./markdown";
import type { ReviewsPayload } from "./Reviews";

export interface TreeEntry { path: string; dir: boolean; size: number; mtime: number; edits: number; stage: string | null; agent: string | null }
export interface ArtifactsPayload { tree: TreeEntry[]; truncated: boolean; isGit?: boolean }
interface Artifact { path: string; body: string; kind: "md" | "html" | "text"; truncated: boolean; provenance: { stage: string | null; edits: number; created: string | null; agent: string | null } }

const RECENT_MS = 10 * 60_000;
const segs = (p: string) => p.split("/");
const base = (p: string) => p.split("/").at(-1) ?? p;

/** Which tree entries a scope keeps: the phase folder (or, for other folders, the stage's catalog phase) and, for a unit, its own folder plus stage-level construction folders. */
function keep(e: TreeEntry, f: Filter, stages: XLensProps["model"]["stages"]): boolean {
  if (!f.phase) return true;
  const s = segs(e.path);
  const phase = (FIVE as string[]).includes(s[0]!) ? s[0] : e.stage ? phaseOf(stages, e.stage) : null;
  if (phase !== f.phase) return false;
  if (f.unit && s[0] === "construction" && s[1] && s[1] !== f.unit && !stages.some((x) => x.slug === s[1])) return false;
  return true;
}

/** The review findings that point at this file: an exact `file`, or (review records) a location naming the file inside the same stage + unit. */
export function findingsFor(rv: ReviewsPayload | null, path: string) {
  if (!rv) return [];
  const s = segs(path); const name = base(path);
  const unit = s[0] === "construction" && s.length >= 4 ? s[1] : null;
  return rv.findings.filter((x) => x.file ? x.file === path : !!x.stage && s.includes(x.stage) && (x.unit ?? null) === unit && x.location.split(/[\s,/]+/).includes(name));
}

/** Folder tree mirroring the record on disk, a rendered preview, provenance chips and anchored review findings. */
export function Artifacts({ model: m, ws, filter }: XLensProps) {
  const ver = lensVersion(m);
  const { data, err } = useLens<ArtifactsPayload>("artifacts", ws, m.key, ver);
  const { data: rv } = useLens<ReviewsPayload>("reviews", ws, m.key, ver);
  const now = useNow(30_000);
  const [sel, setSel] = useState<string | null>(() => takePendingArtifact());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [art, setArt] = useState<{ path: string; a: Artifact | null; err: string | null } | null>(null);

  useEffect(() => {
    const f = (e: Event) => { const p = (e as CustomEvent<string>).detail; takePendingArtifact(); setSel(p); };
    addEventListener("cc-artifact", f); return () => removeEventListener("cc-artifact", f);
  }, []);

  const visible = useMemo(() => (data?.tree ?? []).filter((e) => keep(e, filter, m.stages)), [data, filter, m.stages]);
  const files = useMemo(() => visible.filter((e) => !e.dir), [visible]);
  // Default selection: the most recently written file in scope.
  const chosen = sel ?? [...files].sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
  const entry = data?.tree.find((e) => e.path === chosen) ?? null;

  useEffect(() => {
    if (!chosen) return;
    let off = false;
    get<Artifact>(`/api/artifact?${q({ ws, key: m.key, path: chosen })}`)
      .then((a) => { if (!off) setArt({ path: chosen, a, err: null }); })
      .catch((e: Error) => { if (!off) setArt({ path: chosen, a: null, err: /^404/.test(e.message) ? "This file is no longer on disk." : e.message }); });
    return () => { off = true; };
  }, [ws, m.key, chosen, entry?.mtime]);

  // Dirs open by default: top-level folders and every ancestor of the selection.
  const isOpen = (p: string) => open.has(p) !== (segs(p).length === 1 || (!!chosen && chosen.startsWith(`${p}/`)));
  const toggle = (p: string) => setOpen((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load artifacts — ${err}.` : "Loading artifacts…"}</div>;

  const under = (d: string) => files.filter((f) => f.path.startsWith(`${d}/`));
  const recent = (t: number) => now - t <= RECENT_MS;
  const rows = visible.filter((e) => {
    if (e.dir && !under(e.path).length) return false;
    const s = segs(e.path);
    for (let i = 1; i < s.length; i++) if (!isOpen(s.slice(0, i).join("/"))) return false;
    return true;
  });

  const reviews = m.events.filter((e) => e.kind === "REVIEW_COMPLETED" && e.stage === entry?.stage && (e.unit ?? null) === (chosen && segs(chosen)[0] === "construction" && segs(chosen).length >= 4 ? segs(chosen)[1] : null));
  const lastRev = reviews.at(-1);
  const prov = art?.path === chosen ? art.a?.provenance ?? null : null;
  const finds = chosen ? findingsFor(rv, chosen) : [];
  const git = data.isGit === true;

  return (
    <div className="body" style={{ gap: 12 }} data-loaded="">
      <div className="panel tree mono" style={{ width: 290, flex: "none", maxHeight: "72vh", overflow: "auto" }} role="tree">
        {rows.length ? rows.map((e) => {
          const depth = segs(e.path).length - 1; const pad = { paddingLeft: 6 + depth * 14 };
          if (e.dir) {
            const kids = under(e.path); const o = isOpen(e.path); const hot = kids.some((k) => recent(k.mtime));
            return <div key={e.path} role="treeitem" aria-expanded={o} tabIndex={0} style={pad} title={`${e.path}/ · ${kids.length} file${kids.length === 1 ? "" : "s"}`} onClick={() => toggle(e.path)} onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); toggle(e.path); } }}>
              {o ? "▾ " : "▸ "}{base(e.path)}/ {!o && <span className="faint">{kids.length}</span>}{hot && <span className="run" title="A file under here was written in the last 10 minutes"> ●</span>}
            </div>;
          }
          return <div key={e.path} role="treeitem" aria-selected={e.path === chosen} tabIndex={0} className={e.path === chosen ? "sel" : ""} style={pad}
            title={`${e.path} · ${fmtSize(e.size)} · ${e.edits} edit${e.edits === 1 ? "" : "s"} in the audit · modified ${new Date(e.mtime).toISOString()}`}
            onClick={() => setSel(e.path)} onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); setSel(e.path); } }}>
            {base(e.path)} <span className="faint">{fmtSize(e.size)}</span>{recent(e.mtime) && <span className="run" title="Written in the last 10 minutes"> ●</span>}
          </div>;
        }) : <div className="dim" style={{ cursor: "default", fontFamily: "inherit" }}>No files in this scope.</div>}
        <div className="dim" style={{ fontSize: ".78rem", marginTop: 6, fontFamily: "inherit", cursor: "default", whiteSpace: "normal" }}>
          ● written in the last 10 min · mirrors the folder on disk{data.truncated ? " · listing truncated at 20,000 entries" : ""}
        </div>
      </div>
      <div className="panel grow" style={{ minWidth: 0 }}>
        {!chosen ? <div className="dim">Pick a file in the tree to preview it.</div> : (
          <>
            <div className="row between"><b className="mono" style={{ overflowWrap: "anywhere" }}>{chosen}</b>
              <button type="button" className="iconbtn" disabled title={git ? "Comparing versions is not available in this build" : "Needs git history — this folder is not a git repo"}>Compare versions</button>
            </div>
            <div className="row" style={{ margin: "6px 0 10px", flexWrap: "wrap" }}>
              {prov ? <>
                <span className="chip" title="Stage folder this file sits in">{prov.stage ? `produced by ${prov.stage}` : "stage not recorded"}</span>
                {prov.agent && <span className="chip" title="The stage's lead agent in the stage graph">{leadLabel(prov.agent)}</span>}
                <span className="chip" title={prov.created ? `ARTIFACT_CREATED at ${prov.created}` : "No ARTIFACT_CREATED entry for this file in the audit"}>{prov.created ? `created ${fmtTime(prov.created)}` : "created — not recorded"}</span>
                <span className="chip" title="ARTIFACT_CREATED + ARTIFACT_UPDATED entries naming this file">{prov.edits} audit write{prov.edits === 1 ? "" : "s"}</span>
                {prov.stage && (lastRev
                  ? <span className={`chip ${lastRev.raw.fields.Verdict === "READY" ? "ok" : lastRev.raw.fields.Verdict === "NOT-READY" ? "bad" : ""}`} title={`${reviews.length} REVIEW_COMPLETED for this stage${entry && segs(entry.path).length >= 4 && segs(entry.path)[0] === "construction" ? " and unit" : ""}`}>{lastRev.raw.fields.Verdict === "READY" ? "✓" : lastRev.raw.fields.Verdict === "NOT-READY" ? "✗" : "·"} review {lastRev.raw.fields.Verdict ?? "completed"} ×{reviews.length}</span>
                  : <span className="chip faint">no review for this stage</span>)}
              </> : <span className="chip faint">{art?.path === chosen && art.err ? "provenance unavailable" : "loading provenance…"}</span>}
            </div>
            {finds.length > 0 && finds.map((x, i) => (
              <div key={i} className="find" style={{ borderLeftColor: x.severity === "Critical" ? "var(--bad)" : x.severity === "Major" ? "var(--wait)" : "var(--faint)" }}>
                <b className={x.severity === "Critical" ? "bad" : x.severity === "Major" ? "wait" : "dim"}>{x.severity === "Critical" ? "✗✗" : x.severity === "Major" ? "✗" : "·"} {x.severity}</b> · <span className="mono">{x.location}</span> — {x.finding}{x.status ? <span className="ok"> · {x.status === "RESOLVED" ? "✓ " : ""}{x.status}</span> : null}
              </div>
            ))}
            <div style={{ marginTop: 6 }}>
              {art?.path !== chosen ? <div className="dim">Loading…</div>
                : art.err ? <div className="dim">Could not open this file — {art.err}</div>
                : art.a!.kind === "md" ? <Markdown src={art.a!.body} />
                : art.a!.kind === "html" ? <iframe className="cc-frame" title={`Preview of ${chosen}`} sandbox="" srcDoc={art.a!.body} />
                : <pre className="mdpre">{art.a!.body}</pre>}
              {art?.path === chosen && art.a?.truncated && <div className="warn">Preview shows the first 2 MB of this file.</div>}
            </div>
          </>
        )}
        <div className="dim" style={{ fontSize: ".82rem", marginTop: 10 }}>
          Write counts come from the audit. {git ? "This folder is in a git repo." : "A diff between edits needs git history — this folder isn't a git repo, so “Compare versions” is disabled."}
        </div>
      </div>
    </div>
  );
}

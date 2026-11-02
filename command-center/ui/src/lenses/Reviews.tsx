import { useMemo, useState } from "react";
import type { AuditEvent } from "../../../../core/command-center/server/types";
import { fmtTime } from "../format";
import { leadLabel } from "../intent/derive";
import { clip, inScope, lensVersion, openArtifact, useLens, type XLensProps } from "./common";
import type { ArtifactsPayload } from "./Artifacts";

export interface Finding { severity: string; location: string; finding: string; status: string | null; stage: string | null; unit: string | null; file: string | null }
export interface ReviewsPayload { verdicts: AuditEvent[]; findings: Finding[] }

const SEV = [
  { k: "Critical", g: "✗✗", cls: "bad", bar: "var(--bad)" },
  { k: "Major", g: "✗", cls: "wait", bar: "var(--wait)" },
  { k: "Minor", g: "·", cls: "dim", bar: "var(--faint)" },
] as const;
const sevRank = (s: string) => { const i = SEV.findIndex((x) => x.k === s); return i < 0 ? SEV.length : i; };
const LIMIT = 12;
const FLIMIT = 40;

/** A finding's artifact: the file it names, else the file its location names inside the same stage (+unit) folder. */
function fileOf(f: Finding, tree: ArtifactsPayload | null): string | null {
  if (f.file) return f.file;
  if (!tree || !f.stage) return null;
  const names = new Set(f.location.split(/[\s,/]+/).filter((w) => /\.\w+$/.test(w)));
  const hit = tree.tree.find((e) => {
    if (e.dir) return false;
    const s = e.path.split("/"); const unit = s[0] === "construction" && s.length >= 4 ? s[1] : null;
    return s.includes(f.stage!) && unit === (f.unit ?? null) && names.has(s.at(-1)!);
  });
  return hit?.path ?? null;
}

/** Verdict counts, findings by severity, recent verdicts (→ Story) and findings (→ the artifact). */
export function Reviews({ model: m, ws, filter, onSelect }: XLensProps) {
  const ver = lensVersion(m);
  const { data, err } = useLens<ReviewsPayload>("reviews", ws, m.key, ver);
  const { data: tree } = useLens<ArtifactsPayload>("artifacts", ws, m.key, ver);
  const [allV, setAllV] = useState(false);
  const [allF, setAllF] = useState(false);
  const verdicts = useMemo(() => (data?.verdicts ?? []).filter((v) => inScope(m.stages, filter, v.fields.Stage, v.fields.Unit ?? null)), [data, m.stages, filter]);
  const findings = useMemo(() => (data?.findings ?? []).filter((f) => inScope(m.stages, filter, f.stage, f.unit))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity)), [data, m.stages, filter]);
  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load reviews — ${err}.` : "Loading reviews…"}</div>;

  const ready = verdicts.filter((v) => v.fields.Verdict === "READY").length;
  const notReady = verdicts.filter((v) => v.fields.Verdict === "NOT-READY").length;
  const other = verdicts.length - ready - notReady;
  const bySev = SEV.map((s) => ({ ...s, n: findings.filter((f) => f.severity === s.k).length }));
  const nOtherSev = findings.length - bySev.reduce((a, s) => a + s.n, 0);
  const max = Math.max(1, ...bySev.map((s) => s.n));
  const resolved = findings.filter((f) => f.status === "RESOLVED").length;
  const reviewed = new Set(verdicts.map((v) => v.fields.Stage));
  const unreviewed = m.stages.filter((s) => s.planned && s.firstStart && !reviewed.has(s.slug) && inScope(m.stages, { phase: filter.phase, unit: null }, s.slug, null));
  const vRows = [...verdicts].reverse(); const fRows = allF ? findings : findings.slice(0, FLIMIT);

  return (
    <div data-loaded="">
      <div className="kpis">
        <div className="kpi" title="REVIEW_COMPLETED entries in this scope">
          <span className="s">Verdicts</span>
          <span className="v">{ready} <span className="ok" style={{ fontSize: ".85rem" }}>✓ READY</span></span>
          <span className="s"><span className={notReady ? "bad" : ""}>{notReady} ✗ NOT-READY</span>{other ? ` · ${other} other` : ""}</span>
        </div>
        <div className="kpi" style={{ flex: 2 }} title={`Findings from ${findings.some((f) => f.file) ? "the reviews embedded in artifacts" : "the review records"}`}>
          <span className="s">Findings{findings.length ? ` · ${resolved} of ${findings.length} resolved` : ""}</span>
          {findings.length ? <>
            {bySev.map((s) => (
              <div key={s.k} style={{ marginTop: s.k === "Critical" ? 4 : 0 }}>
                <span className={s.cls} style={{ display: "inline-block", width: 100, fontWeight: 600 }}>{s.g} {s.k} {s.n}</span>
                <span className="hb" style={{ width: `${Math.round((s.n / max) * 220)}px`, background: s.bar }} />
              </div>
            ))}
            {nOtherSev > 0 && <div className="dim">{nOtherSev} with another severity</div>}
          </> : <span className="v">0</span>}
        </div>
      </div>
      {unreviewed.length > 0 && <div className="dim" style={{ fontSize: ".86rem", marginBottom: 8 }} title="Started stages in this scope with no REVIEW_COMPLETED entry">No review for this stage: {unreviewed.map((s) => s.slug).join(", ")}</div>}
      <div className="lbl">Recent verdicts</div>
      {vRows.length ? (
        <table><thead><tr><th>When</th><th>Stage · unit</th><th>Verdict</th><th>Note</th></tr></thead><tbody>
          {(allV ? vRows : vRows.slice(0, LIMIT)).map((v) => {
            const f = v.fields; const st = f.Stage;
            return (
              <tr key={`${v.shard}#${v.seq}`} className={st ? "clk" : ""} title={st ? "Open this stage's Story" : undefined} onClick={() => { if (st) onSelect(st, f.Unit ?? null); }}>
                <td className="mono dim" title={v.ts}>{fmtTime(v.ts)}</td>
                <td className="mono">{st ?? "—"}{f.Unit ? ` · ${f.Unit}` : ""}</td>
                <td>{f.Verdict === "READY" ? <span className="ok">✓ READY</span> : f.Verdict === "NOT-READY" ? <span className="bad">✗ NOT-READY</span> : <span className="dim">· {f.Verdict ?? "no verdict recorded"}</span>}</td>
                <td className="dim">{[f.Reviewer ? leadLabel(f.Reviewer) : null, f.Iteration ? `iteration ${f.Iteration}` : null].filter(Boolean).join(" · ")}</td>
              </tr>
            );
          })}
        </tbody></table>
      ) : <div className="dim">No review verdicts in this scope.</div>}
      {vRows.length > LIMIT && <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setAllV((x) => !x)}>{allV ? "show recent only" : `show all ${vRows.length} verdicts`}</button>}
      <div className="lbl" style={{ marginTop: 14 }}>Findings</div>
      {fRows.length ? (
        <table><thead><tr><th>Severity</th><th>Stage · unit</th><th>Location</th><th>Finding</th><th>Status</th></tr></thead><tbody>
          {fRows.map((f, i) => {
            const s = SEV.find((x) => x.k === f.severity); const file = fileOf(f, tree);
            return (
              <tr key={i} className={file ? "clk" : ""} title={file ? `Open ${file}` : "The review names no file that could be found in this record"} onClick={() => { if (file) openArtifact(ws, m.key, file); }}>
                <td className={s?.cls ?? "dim"} style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{s?.g ?? "·"} {f.severity}</td>
                <td className="mono">{f.stage ?? "—"}{f.unit ? ` · ${f.unit}` : ""}</td>
                <td className="mono dim">{f.location}</td>
                <td title={f.finding.length > 220 ? f.finding : undefined}>{clip(f.finding, 220)}</td>
                <td>{f.status === "RESOLVED" ? <span className="ok">✓ resolved</span> : f.status ? <span>{f.status}</span> : <span className="faint" title="The review records no status for this finding">—</span>}</td>
              </tr>
            );
          })}
        </tbody></table>
      ) : <div className="dim">No findings in this scope.</div>}
      {findings.length > FLIMIT && <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setAllF((x) => !x)}>{allF ? "show fewer" : `show all ${findings.length} findings`}</button>}
      <div className="dim" style={{ fontSize: ".82rem", marginTop: 8 }}>Clicking a verdict opens that stage's Story; clicking a finding opens its artifact. Started stages with no reviewer say so above rather than showing a blank.</div>
    </div>
  );
}

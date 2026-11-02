import { type ReactNode, useState } from "react";
import type { PhaseKey, Recorded, Tokens as T } from "../../../../core/command-center/server/types";
import { fmtTokens, phaseName, PHASES } from "../format";
import { lensVersion, pct, phaseOf, useLens, type XLensProps } from "./common";

type Breakdown = { totals: T; byStage: Record<string, T>; byModel: Record<string, T>; byAgent: Record<string, T> };
export type TokensPayload = Recorded<Breakdown> & { source?: "ledger" | "audit" };
type By = "phase" | "stage" | "model" | "agent";

const zero = (): T => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const sum = (t: T) => t.input + t.output + t.cacheRead + t.cacheWrite;
const add = (a: T, b: T) => { a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; };
/** Above this share, one construction stage holding usage while units ran means the stage pointer never advanced. */
const UNSPLIT = 0.4;

/** Token counts only (input / output / cache) — never dollars, even though the usage ledger records them. */
export function Tokens({ model: m, ws, filter }: XLensProps) {
  const { data, err } = useLens<TokensPayload>("tokens", ws, m.key, lensVersion(m));
  const [by, setBy] = useState<By>("phase");
  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load tokens — ${err}.` : "Loading tokens…"}</div>;
  if (!data.recorded) {
    return (
      <div data-loaded="">
        <div className="kpis">
          {["Input", "Output", "Cache read / write"].map((k) => <div key={k} className="kpi" title={data.reason}><span className="s">{k}</span><span className="v">—</span><span className="s">not recorded</span></div>)}
        </div>
        <div className="dim">Tokens not recorded by this harness — {data.reason}.</div>
      </div>
    );
  }
  const v = data.value; const total = sum(v.totals);
  // (a) Unsplit construction: the stage the pointer is stuck on (the state file's current stage when it lags the audit,
  // else the audit's current stage) holds > 40% of all usage while units ran — the ledger booked unit work to it.
  const pointer = m.notes.map((n) => /state says ([\w-]+)/.exec(n)?.[1]).find(Boolean) ?? m.current.stage;
  const pt = pointer ? v.byStage[pointer] : undefined;
  const unsplit: [string, T] | null = m.units.length > 0 && pointer && pt && phaseOf(m.stages, pointer) === "construction" && total > 0 && sum(pt) / total > UNSPLIT ? [pointer, pt] : null;
  const unsplitShare = unsplit ? pct(sum(unsplit[1]), total) : "";
  const noCache = v.totals.cacheRead + v.totals.cacheWrite === 0;

  let rows: { name: string; label: ReactNode; t: T; inScope: boolean; title?: string }[] = [];
  if (by === "phase") {
    const acc = new Map<PhaseKey, T>();
    for (const [s, t] of Object.entries(v.byStage)) { const p = phaseOf(m.stages, s); const x = acc.get(p) ?? zero(); add(x, t); acc.set(p, x); }
    rows = [...PHASES.map((p) => p.key), "unknown" as PhaseKey].filter((p) => acc.has(p)).map((p) => ({
      name: p, t: acc.get(p)!, inScope: !filter.phase || filter.phase === p,
      label: p === "construction" && unsplit ? <>Construction <span className="dim">(unsplit)</span></> : p === "unknown" ? <span title="Ledger stages not in this workspace's stage graph">Unknown phase</span> : phaseName(p),
    }));
  } else if (by === "stage") {
    rows = Object.entries(v.byStage).map(([s, t]) => ({
      name: s, t, inScope: !filter.phase || phaseOf(m.stages, s) === filter.phase,
      label: unsplit && s === unsplit[0] ? <><span className="mono">{s}</span> <span className="dim">→ Construction (unsplit)</span></> : <span className="mono">{s}</span>,
    })).filter((r) => r.inScope);
  } else {
    const src = by === "model" ? v.byModel : v.byAgent;
    rows = Object.entries(src).map(([k, t]) => ({ name: k, t, inScope: true, label: <span className="mono">{k}</span> }));
  }
  rows.sort((a, b) => sum(b.t) - sum(a.t));
  const max = Math.max(1, ...rows.map((r) => sum(r.t)));
  const audit = data.source === "audit";

  return (
    <div data-loaded="">
      <div className="kpis">
        <div className="kpi"><span className="s">Input</span><span className="v">{fmtTokens(v.totals.input)}</span><span className="s" title={String(v.totals.input)}>{v.totals.input.toLocaleString()} tokens</span></div>
        <div className="kpi"><span className="s">Output</span><span className="v">{fmtTokens(v.totals.output)}</span><span className="s" title={String(v.totals.output)}>{v.totals.output.toLocaleString()} tokens</span></div>
        <div className="kpi" title={audit ? "The audit's STAGE_COMPLETED fields record no cache counts" : "cacheRead / cacheCreate (5m + 1h) in the usage ledger"}>
          <span className="s">Cache read / write</span>
          {audit ? <><span className="v">—</span><span className="s">not recorded by the audit</span></>
            : <><span className={`v${noCache ? " faint" : ""}`}>{fmtTokens(v.totals.cacheRead)} / {fmtTokens(v.totals.cacheWrite)}</span><span className="s">{noCache ? "⚠ see note" : "read / write"}</span></>}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        {(["phase", "stage", "model", "agent"] as By[]).map((b) => <button key={b} type="button" className={`chip clk${by === b ? " on" : ""}`} aria-pressed={by === b} onClick={() => setBy(b)}>by {b}</button>)}
        <span className="grow" />
        <span className="dim" style={{ fontSize: ".85rem" }}>{audit ? "From the audit's STAGE_COMPLETED token fields (no usage ledger)" : "From the usage ledger"}</span>
      </div>
      {(by === "model" || by === "agent") && filter.phase && <div className="dim" style={{ fontSize: ".85rem", marginBottom: 6 }}>Per-{by} totals cover the whole intent — the ledger does not split them by stage.</div>}
      {by === "phase" && filter.phase && <div className="dim" style={{ fontSize: ".85rem", marginBottom: 6 }}>{phaseName(filter.phase)} is highlighted; other phases are shown for comparison.</div>}
      {rows.length ? (
        <table>
          <thead><tr><th>{by[0]!.toUpperCase() + by.slice(1)}</th><th>Input</th><th>Output</th><th>Cache read / write</th><th title="Share of all tokens (input + output + cache)">Share</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={by === "phase" && filter.phase && !r.inScope ? { opacity: 0.55 } : undefined}>
                <td>{r.label}</td>
                <td className="mono" title={String(r.t.input)}>{fmtTokens(r.t.input)}</td>
                <td className="mono" title={String(r.t.output)}>{fmtTokens(r.t.output)}</td>
                <td className="mono">{audit ? <span className="faint">—</span> : `${fmtTokens(r.t.cacheRead)} / ${fmtTokens(r.t.cacheWrite)}`}</td>
                <td style={{ whiteSpace: "nowrap" }}><span className="hb" style={{ width: `${Math.max(2, Math.round((sum(r.t) / max) * 160))}px` }} /> {pct(sum(r.t), total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="dim">{by === "stage" ? "No stage in this scope has a token entry." : `Tokens by ${by} — not recorded${audit ? " by the audit fallback" : " in the usage ledger"}.`}</div>}
      {unsplit && <div className="warn">⚠ {unsplitShare} of usage is booked to {unsplit[0]}: the stage pointer never advanced while units ran, so it's shown as “Construction (unsplit)” rather than attributed to one stage.</div>}
      {!audit && noCache && <div className="warn">⚠ Cache read/write is 0 everywhere — cached tokens are likely counted inside Input.</div>}
      <div className="dim" style={{ fontSize: ".82rem" }}>Token counts only. On harnesses without the usage ledger this lens says “Tokens not recorded by this harness” — never 0.</div>
    </div>
  );
}

import type { IntentSummary, NeedItem } from "../../../../core/command-center/server/types";
import { fmtTokens, fmtWaitLive, GLYPH, intentHash, PHASES, phaseName } from "../format";
import { liveNow } from "../intent/derive";
import { isDoneStatus } from "./homeView";

export function needGlyph(k: NeedItem["kind"]): string { return GLYPH[k]; }

/**
 * Status = glyph + label + colour, in the order of what the human must know first. Liveness is re-derived
 * against `now` (liveNow) so "active" decays to "idle" between payloads, exactly as in the intent view.
 */
export function IntentStatus({ i, now, frozen = false }: { i: IntentSummary; now: number; frozen?: boolean }) {
  const st = i.status.toLowerCase();
  const live = liveNow(i.liveness, i.lastEventTs, now);
  if (i.needs.length) return <span className="wait">{needGlyph(i.needs[0]!.kind)} waiting on you</span>;
  if (live === "active") {
    return frozen
      ? <span className="dim" title="Live stream disconnected — this was the last known state">● active (last known)</span>
      : <span className="run"><span className="live-dot" />active</span>;
  }
  if (/park/.test(st)) return <span className="dim">⏸ parked</span>;
  if (isDoneStatus(st)) return <span className="ok">{st === "archived" ? "✓ archived" : "✓ done"}</span>;
  if (live === "ended") return <span className="dim" title="The latest event is a chat ending. The audit does not say which chat, so another chat may still be working on this intent; its next event shows it active again.">■ chat ended</span>;
  return <span className="dim">◌ idle</span>;
}

/** `bare`: the compact list's variant — no phase labels under the bars (they are in the title). */
export function MiniBars({ i, bare = false }: { i: IntentSummary; bare?: boolean }) {
  return (
    <div className={bare ? "mini bare" : "mini"}>
      {PHASES.map((p) => {
        const c = i.phases.find((x) => x.key === p.key) ?? { done: 0, planned: 0, skipped: 0 };
        const cur = i.current.phase === p.key;
        const pct = c.planned ? Math.round((100 * c.done) / c.planned) : 0;
        const cls = cur ? (i.needs.length ? "w" : "r") : "";
        const w = cur ? Math.max(pct, 12) : pct;
        const title = c.planned
          ? `${p.name}: ${c.done} of ${c.planned} planned stages done${c.skipped ? ` · ${c.skipped} skipped by scope` : ""}${cur ? " · current phase" : ""}`
          : c.skipped ? `${p.name}: all ${c.skipped} stages skipped by scope` : `${p.name}: no stages planned`;
        return (
          <div key={p.key} title={title}>
            <div className="b"><i className={cls} style={{ width: `${w}%` }} /></div>
            {!bare && <div className="n">{p.short}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** `polling`: the workspace's file watch failed and it is re-read every 10 s instead (spec §9: say so on the card). */
/** `fix`: this intent's "needs fixing" count from the home payload (0 hides the line). */
export function IntentCard({ i, now, frozen, polling = false, fix = 0 }: { i: IntentSummary; now: number; frozen: boolean; polling?: boolean; fix?: number }) {
  const href = intentHash(i.workspace, i.key);
  const need = i.needs[0];
  return (
    <div className="card" role="link" tabIndex={0} onClick={() => { location.hash = href; }} onKeyDown={(e) => { if (e.key === "Enter") location.hash = href; }}>
      <div className="row between"><h3>{i.name}</h3><IntentStatus i={i} now={now} frozen={frozen} /></div>
      {i.title ? <div className="dim" style={{ fontSize: ".88rem" }}>{i.title}</div> : <div className="faint" style={{ fontSize: ".88rem" }} title="The state file has no project title">— no title recorded</div>}
      <div className="mono dim" style={{ marginTop: 6 }}>
        {i.current.stage
          ? <>{phaseName(i.current.phase)} · {i.current.stage}{i.current.unit && <> · <i>{i.current.unit}</i></>}</>
          : <span className="faint" title="Neither the audit nor the state file names a current stage">no current stage recorded</span>}
      </div>
      <MiniBars i={i} />
      <div className="stats">
        <span title="Progress = done ÷ EXECUTE-planned stages; skipped stages are never in the denominator"><b>{i.doneCount}</b> of <b>{i.plannedCount}</b> planned stages</span>
        <span title="Stages the scope marks SKIP">{i.skippedCount} skipped</span>
        <span title={i.unitsPlanned === null ? "Units complete / planned — the planned unit count is not recorded" : "Construction units complete / planned"}>units <b>{i.unitsDone}/{i.unitsPlanned === null ? "—" : i.unitsPlanned}</b></span>
        <span>tokens {i.tokens.recorded
          ? <><b title={`${i.tokens.value.input.toLocaleString()} input · ${i.tokens.value.output.toLocaleString()} output`}>{fmtTokens(i.tokens.value.input)}</b> in</>
          : <b title={`Not recorded — ${i.tokens.reason}`}>—</b>}</span>
      </div>
      {need && (
        <div className="warn" style={{ margin: "8px 0 0" }}>
          {needGlyph(need.kind)} {need.detail} · {need.stage}{need.unit ? ` · ${need.unit}` : ""} · <b title={frozen ? "Live stream disconnected — timer paused" : need.since ?? "start time not recorded"}>{fmtWaitLive(need.since, now, frozen)}</b>
          {i.needs.length > 1 && <span className="dim"> · +{i.needs.length - 1} more</span>}
        </div>
      )}
      {fix > 0 && (
        <a className="bad" href={intentHash(i.workspace, i.key, "issues")} style={{ display: "inline-block", fontSize: ".84rem", marginTop: 6 }} onClick={(e) => e.stopPropagation()} title="Open hard stops and failures, plus refusals that repeat or are terminal — open the Issues tab">
          <span aria-hidden>✗</span> {fix} need{fix === 1 ? "s" : ""} fixing →
        </a>
      )}
      {polling && <div className="faint" style={{ fontSize: ".82rem", marginTop: 6 }} title="Recursive file watching failed for this workspace, so changes can take up to 10 s to appear">polling every 10 s (file watching unavailable)</div>}
    </div>
  );
}

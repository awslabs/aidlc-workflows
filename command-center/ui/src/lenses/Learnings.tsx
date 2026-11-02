import { useMemo, useState } from "react";
import { fmtTime, phaseName } from "../format";
import { clip, inScope, lensVersion, useLens, type XLensProps } from "./common";
import { inline } from "./markdown";

interface Rule { stage: string; cid: string; date: string | null; text: string; file: string }
interface Memory { interpretations: string[]; deviations: string[]; tradeoffs: string[]; openQuestions: string[] }
export interface LearningsPayload { rules: Rule[]; perStage: Record<string, number>; notes: { stage: string; memory: Memory }[]; practices: { mandated: number; forbidden: number } }

const RLIMIT = 12;
const NLIMIT = 6;
const KINDS = [
  { k: "openQuestions", g: "?", label: "Open question", cls: "wait", open: true },
  { k: "deviations", g: "↷", label: "Deviation", cls: "", open: false },
  { k: "tradeoffs", g: "⇄", label: "Tradeoff", cls: "", open: false },
  { k: "interpretations", g: "◇", label: "Interpretation", cls: "", open: false },
] as const;

/** Rules learned (space memory), each stage's memory.md notes, and affirmed practices. */
export function Learnings({ model: m, ws, filter }: XLensProps) {
  const { data, err } = useLens<LearningsPayload>("learnings", ws, m.key, lensVersion(m));
  const [allRules, setAllRules] = useState(false);
  const [allKind, setAllKind] = useState<Record<string, boolean>>({});
  // Rules are space-level (they apply to every future stage), so the list is always the whole set; the phase scope filters only the stage notes.
  const rules = data?.rules ?? [];
  const notes = useMemo(() => (data?.notes ?? []).filter((n) => inScope(m.stages, { phase: filter.phase, unit: null }, n.stage, null)), [data, m.stages, filter.phase]);
  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load learnings — ${err}.` : "Loading learnings…"}</div>;

  const layer = (f: string) => data.rules.filter((r) => r.file === f).length;
  const per: Record<string, number> = {};
  for (const r of rules) per[r.stage] = (per[r.stage] ?? 0) + 1;
  const perMax = Math.max(1, ...Object.values(per));
  const openQ = notes.reduce((a, n) => a + n.memory.openQuestions.length, 0);
  // The memory files may list no `## Mandated` / `## Forbidden` bullets while the audit recorded the affirmation: show the audit's counts and say so.
  const affirmed = [...m.events].reverse().find((e) => e.kind === "PRACTICES_AFFIRMED");
  const af = affirmed?.raw.fields ?? {};
  const mand = String(data.practices.mandated); const forb = String(data.practices.forbidden);
  const practicesSrc = "NEVER / ALWAYS rules (or bullets) under ## Mandated and ## Forbidden in team.md + project.md";
  // The audit records what the last affirmation appended, not the totals: shown only as its own line.
  const appended = affirmed && (af["Mandated Rules Appended"] !== undefined || af["Forbidden Rules Appended"] !== undefined)
    ? `last affirmation appended ${af["Mandated Rules Appended"] ?? "—"} / ${af["Forbidden Rules Appended"] ?? "—"}` : null;
  const scopeName = filter.phase ? phaseName(filter.phase) : null;

  return (
    <div data-loaded="">
      <div className="kpis">
        <div className="kpi" title="Lines tagged <!-- cid:<stage>:<id> --> in the space's memory files"><span className="s">Rules learned</span><span className="v pur">{data.rules.length}</span><span className="s">{layer("project.md")} project · {layer("team.md")} team · {layer("org.md")} org</span></div>
        <div className="kpi" title={practicesSrc}><span className="s">Practices affirmed</span><span className="v">{mand} / {forb}</span><span className="s">mandated / forbidden in team.md + project.md</span></div>
        <div className="kpi" title="Bullets under the Open Questions heading of each stage's memory.md"><span className="s">Open questions</span><span className={`v${openQ ? " wait" : ""}`}>{openQ}</span><span className="s">from stage memory{scopeName ? ` · ${scopeName}` : ""}</span></div>
        <div className="kpi" style={{ flex: 1.8 }}><span className="s">Rules learned per stage</span>
          {Object.keys(per).length
            ? <div className="bars">{Object.entries(per).map(([k, v]) => <div key={k} title={`${k}: ${v} rule${v === 1 ? "" : "s"}`}><i style={{ height: `${Math.max(4, Math.round((v / perMax) * 46))}px` }} />{k.split("-")[0]} {v}</div>)}</div>
            : <div className="dim" style={{ marginTop: 6 }}>No rules captured in this scope.</div>}
        </div>
      </div>
      <div className="panel" style={{ marginBottom: 10 }}>
        <div className="lbl row between"><span>① Rules learned — persisted to memory, applied to every future stage</span><span style={{ textTransform: "none", letterSpacing: 0 }} title="Space-level: not narrowed by the phase stepper">{rules.length} · whole space</span></div>
        {(allRules ? rules : rules.slice(0, RLIMIT)).map((r) => (
          <div key={`${r.file}#${r.stage}:${r.cid}`} className="rule">
            <span className="from">{r.stage} · {r.cid}<br /><span className="faint">{r.date ?? "date not recorded"}</span></span>
            <span className="grow">{inline(r.text)}</span><span className="chip" style={{ alignSelf: "flex-start" }}>→ {r.file}</span>
          </div>
        ))}
        {!rules.length && <div className="dim">No rules learned yet in this space.</div>}
        {rules.length > RLIMIT && <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => setAllRules((x) => !x)}>{allRules ? "show fewer" : `+ ${rules.length - RLIMIT} more`}</button>}
      </div>
      <div className="row" style={{ alignItems: "stretch" }}>
        <div className="panel" style={{ minWidth: 0, flex: 3 }}>
          <div className="lbl">② Agent notes — each stage's memory.md{scopeName ? ` · ${scopeName}` : ""}</div>
          {KINDS.map((kd) => {
            const items = notes.flatMap((n) => n.memory[kd.k].map((t) => ({ stage: n.stage, t })));
            if (!items.length) return null;
            const all = allKind[kd.k] === true;
            return (
              <div key={kd.k}>
                {(all ? items : items.slice(0, NLIMIT)).map((x, i) => (
                  <div key={i} className={`note${kd.open ? " open" : ""}`}><b className={kd.cls}>{kd.g} {kd.label}</b> · <span className="mono">{x.stage}</span> — <span title={x.t.length > 320 ? x.t : undefined}>{inline(clip(x.t, 320))}</span></div>
                ))}
                {items.length > NLIMIT && <button type="button" className="linkbtn" style={{ fontSize: ".86rem" }} onClick={() => setAllKind((s) => ({ ...s, [kd.k]: !all }))}>{all ? "show fewer" : `+ ${items.length - NLIMIT} more ${kd.label.toLowerCase()}s`}</button>}
              </div>
            );
          })}
          {!notes.some((n) => KINDS.some((kd) => n.memory[kd.k].length)) && <div className="dim">No stage memory notes in this scope.</div>}
        </div>
        <div className="panel" style={{ minWidth: 200, flex: 1 }}>
          <div className="lbl">③ Practices — team.md / project.md</div>
          <div className="note" title={practicesSrc}><b className="ok">✓ Mandated</b> · {mand} rule{mand === "1" ? "" : "s"}</div>
          <div className="note" title={practicesSrc}><b className="bad">✗ Forbidden</b> · {forb} rule{forb === "1" ? "" : "s"}</div>
          <div className="dim" style={{ fontSize: ".82rem" }}>{affirmed ? <>Affirmed {affirmed.stage ? `at ${affirmed.stage} ` : ""}<span title={affirmed.ts}>{fmtTime(affirmed.ts)}</span>{af["Affirming User"] ? ` by ${af["Affirming User"]}` : ""}{appended ? <><br /><span title="From the PRACTICES_AFFIRMED audit entry (rules appended by that affirmation, not totals)">{appended} (mandated / forbidden)</span></> : null}</> : "No PRACTICES_AFFIRMED entry in this intent's audit."}</div>
        </div>
      </div>
      <div className="dim" style={{ fontSize: ".82rem", marginTop: 8 }}>AIDLC records only the learnings you kept, so there is no “declined” count. Rules are space-level: they include every intent in space <span className="mono">{m.space}</span>.</div>
    </div>
  );
}

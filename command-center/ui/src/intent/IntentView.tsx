import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IntentModel, PhaseKey } from "../../../../core/command-center/server/types";
import type { findIntent } from "../App";
import { get, q } from "../api";
import { intentHash, phaseName } from "../format";
import { Artifacts, type ArtifactsPayload } from "../lenses/Artifacts";
import { type Filter, lensVersion, useLens, type XLensProps } from "../lenses/common";
import { Decisions, type DecisionsPayload } from "../lenses/Decisions";
import { Issues, issuesCount } from "../lenses/Issues";
import type { HealthPayload } from "../../../../core/command-center/server/hooks-map";
import { Learnings, type LearningsPayload } from "../lenses/Learnings";
import { Reviews } from "../lenses/Reviews";
import { Story, type LensProps } from "../lenses/Story";
import { Timeline } from "../lenses/Timeline";
import { Tokens } from "../lenses/Tokens";
import { Units } from "../lenses/Units";
import { useLiveCtx } from "../useLive";
import { attribute, FIVE, lensFromSlug, LENSES, type LensName, phaseOfStage, sortUnits } from "./derive";
import { Kpis } from "./Kpis";
import { Scrubber } from "./Scrubber";
import { StageRail } from "./StageRail";
import { Stepper } from "./Stepper";

export type { LensName } from "./derive";
export interface IntentViewState { phase: PhaseKey; stage: string | null; unit: string | null; lens: LensName; replayAt: string | null }

interface Props {
  ws: string; space: string; dir: string; lensSlug: string | null; focused: ReturnType<typeof findIntent>;
  replayAt: string | null; onReplay: (ts: string | null) => void;
}

/** Identity of an audit entry (a refetch and a delta can both carry it). */
const evKey = (e: IntentModel["events"][number]) => `${e.raw?.shard}#${e.raw?.seq}#${e.ts}#${e.kind}`;

type Sel = { phase: PhaseKey; stage: string | null; unit: string | null };
function initialSel(m: IntentModel): Sel {
  const c = m.current;
  if (c.phase !== "unknown") return { phase: c.phase, stage: c.stage, unit: c.unit };
  const next = m.stages.find((s) => s.planned && s.state !== "done" && s.phase !== "unknown");
  return { phase: next?.phase ?? "initialization", stage: next?.slug ?? null, unit: null };
}
/** Selecting a phase: its current position when it holds the intent's current stage, else its first planned stage. */
function phaseSel(m: IntentModel, p: PhaseKey): Sel {
  if (p === m.current.phase) return { phase: p, stage: m.current.stage, unit: m.current.unit };
  const first = m.stages.find((s) => s.phase === p && s.planned) ?? m.stages.find((s) => s.phase === p);
  const unit = p === "construction" ? sortUnits(m.units)[0]?.name ?? null : null;
  return { phase: p, stage: first?.slug ?? null, unit };
}

export function IntentView({ ws, space, dir, lensSlug, focused, replayAt, onReplay }: Props) {
  const key = `${space}/${dir}`;
  const { subscribeIntent, connected } = useLiveCtx();
  const [model, setModel] = useState<IntentModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const ticket = useRef(0);
  /** How far the stepper's selection scopes the non-Story lenses: phase + selected unit, the phase, or nothing. */
  const [wide, setWide] = useState<"sel" | "phase" | "whole">("sel");

  const load = useCallback(async () => {
    const t = ++ticket.current;
    try {
      const m = await get<IntentModel>(`/api/intent?${q({ ws, key })}`);
      if (t !== ticket.current) return;
      setModel(m); setErr(null); setSel((s) => s ?? initialSel(m));
    } catch (e) { if (t === ticket.current) setErr((e as Error).message); }
  }, [ws, key]);

  useEffect(() => { setModel(null); setSel(null); setErr(null); void load(); }, [load]);

  // Live: append new events immediately, then refetch the model (stage states, needs) debounced 500 ms.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void load(), 500); };
    const off = subscribeIntent(ws, key, (s) => {
      if (s.type === "resync" || s.reset) { if (timer) clearTimeout(timer); void load(); return; }
      if (s.newEvents.length) {
        ++ticket.current;
        setModel((m) => {
          if (!m) return m;
          const seen = new Set(m.events.map(evKey));
          return { ...m, events: [...m.events, ...s.newEvents.filter((e) => !seen.has(evKey(e)))], lastEventTs: s.lastEventTs ?? m.lastEventTs };
        });
      }
      later();
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [ws, key, subscribeIntent, load]);

  const events = useMemo(() => (model ? attribute(model) : []), [model]);
  const lens = lensFromSlug(lensSlug);
  // Tab counts (whole intent) share the lenses' payload cache.
  const ver = lensVersion(model);
  const dec = useLens<DecisionsPayload>("decisions", ws, key, ver, !!model).data;
  const arts = useLens<ArtifactsPayload>("artifacts", ws, key, ver, !!model).data;
  const learn = useLens<LearningsPayload>("learnings", ws, key, ver, !!model).data;
  const iss = issuesCount(useLens<HealthPayload>("issues", ws, key, ver, !!model).data);
  const setLens = (l: LensName) => { location.hash = intentHash(ws, key, l === "Story" ? undefined : l.toLowerCase()); };

  if (err && !model) {
    return <div className="panel"><div className="lbl">Intent</div><div className="dim">{/^404/.test(err) ? <>Intent <span className="mono">{key}</span> is not in any watched workspace.</> : <>Could not load this intent — {err}.</>} <a href="#/">Back to Home</a></div></div>;
  }
  if (!model || !sel) return <div className="panel dim">Loading intent…</div>;

  const onSelect = (stage: string, unit: string | null = null) => {
    setSel({ phase: phaseOfStage(model.stages, stage) === "unknown" ? sel.phase : phaseOfStage(model.stages, stage), stage, unit }); setWide("sel");
    if (lens !== "Story") setLens("Story");
  };
  const replay = (e: (typeof events)[number] | null) => {
    if (!e) { onReplay(null); return; }
    onReplay(e.ts);
    if (e.aStage) { const p = phaseOfStage(model.stages, e.aStage); setSel({ phase: p === "unknown" ? sel.phase : p, stage: e.aStage, unit: e.aUnit }); }
    if (lens !== "Story") setLens("Story");
  };
  const counts: Partial<Record<LensName, string>> = {
    Reviews: String(model.reviews.ready + model.reviews.notReady),
    Units: `${model.unitsDone}/${model.unitsPlanned ?? "—"}`,
    ...(dec ? { Decisions: String(dec.groups.reduce((a, g) => a + g.questions.length, 0) + dec.agentDecisions.length) } : {}),
    ...(arts ? { Artifacts: String(arts.tree.filter((e) => !e.dir).length) } : {}),
    ...(learn ? { Learnings: String(learn.rules.length) } : {}),
    ...(iss !== null ? { Issues: String(iss) } : {}),
  };
  const lp: LensProps = { model, ws, scope: sel, replayAt, onSelect };
  const scoped = wide !== "whole" && FIVE.includes(sel.phase as (typeof FIVE)[number]);
  const unitScoped = scoped && wide === "sel" && !!sel.unit;
  const filter: Filter = scoped ? { phase: sel.phase, unit: unitScoped ? sel.unit : null } : { phase: null, unit: null };
  const xp: XLensProps = { model, ws, filter, selUnit: sel.unit, onSelect };

  return (
    <>
      <Kpis model={model} wsLabel={focused?.w.label ?? ws.split("/").at(-1) ?? ws} />
      <Scrubber model={model} events={events} replayAt={replayAt} connected={connected} onReplay={replay} />
      <Stepper model={model} phase={sel.phase} onPhase={(p) => { setSel(phaseSel(model, p)); setWide("sel"); }} />
      <div className="body">
        <div className="panel srail"><StageRail model={model} phase={sel.phase} stage={sel.stage} unit={sel.unit} onSelect={onSelect} /></div>
        <div className="center">
          <div className="tabs" role="tablist">
            {LENSES.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={lens === t} className={lens === t ? "on" : ""} onClick={() => setLens(t)}>
                {t}{counts[t] && <span className="n">{counts[t]}</span>}
              </button>
            ))}
          </div>
          {lens !== "Story" && (scoped
            ? <div className="scope">Scoped to <b>{phaseName(sel.phase)}</b>{unitScoped && <> · unit <b>{sel.unit}</b>{lens === "Units" || lens === "Timeline" ? " highlighted (not filtered)" : ""}</>} by the phase stepper — {unitScoped && <><button type="button" className="linkbtn" onClick={() => setWide("phase")}>all units</button> · </>}<button type="button" className="linkbtn" onClick={() => setWide("whole")}>show whole intent</button></div>
            : <div className="scope">Showing the <b>whole intent</b>{FIVE.includes(sel.phase as (typeof FIVE)[number]) && <> — <button type="button" className="linkbtn" onClick={() => setWide("sel")}>scope to {phaseName(sel.phase)}</button></>}</div>)}
          <div className="panel">
            {lens === "Story" ? <Story {...lp} />
              : lens === "Decisions" ? <Decisions {...xp} />
              : lens === "Artifacts" ? <Artifacts {...xp} />
              : lens === "Reviews" ? <Reviews {...xp} />
              : lens === "Issues" ? <Issues {...xp} />
              : lens === "Units" ? <Units {...xp} />
              : lens === "Learnings" ? <Learnings {...xp} />
              : lens === "Timeline" ? <Timeline {...xp} />
              : <Tokens {...xp} />}
          </div>
        </div>
      </div>
    </>
  );
}

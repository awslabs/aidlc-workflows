import type { KeyboardEvent, MouseEvent } from "react";
import type { IntentModel, PhaseKey } from "../../../../core/command-center/server/types";
import { fmtTime, phaseName } from "../format";
import { useLiveClock } from "../useLive";
import { type AEvent, fmtDur, GAP_MS, indexAt, liveNow, phaseCounts, restLabel } from "./derive";

interface Props { model: IntentModel; events: AEvent[]; replayAt: string | null; connected: boolean; onReplay: (e: AEvent | null) => void }

const W = 96; // % of the bar used by events; the right edge is the "back to live" zone
const COLOR = { done: "var(--ok)", running: "var(--run)", waiting: "var(--wait)", todo: "var(--faint)", skip: "var(--faint)" } as const;

/** Phase-coloured segments over event-index (compressed) time, with ┆┆ marks where > 2 h passed between events. */
export function Scrubber({ model: m, events, replayAt, connected, onReplay }: Props) {
  const n = events.length;
  const phaseAt: PhaseKey[] = []; let last: PhaseKey = "unknown";
  for (const e of events) { const p = m.stages.find((s) => s.slug === e.aStage)?.phase; if (p && p !== "unknown") last = p; phaseAt.push(last); }
  const segs: { p: PhaseKey; from: number; to: number }[] = [];
  phaseAt.forEach((p, i) => { const s = segs.at(-1); if (s && s.p === p) s.to = i + 1; else segs.push({ p, from: i, to: i + 1 }); });
  const gaps = events.flatMap((e, i) => {
    if (!i) return [];
    const d = Date.parse(e.ts) - Date.parse(events[i - 1]!.ts);
    return d > GAP_MS ? [{ i, d, from: events[i - 1]!.ts, to: e.ts }] : [];
  });
  const head = replayAt && n ? indexAt(events, replayAt) : null;
  const { now } = useLiveClock();
  const live = liveNow(m.liveness, m.lastEventTs, now);
  const rest = restLabel(live, m.lastEventTs, now);
  const label = replayAt ? null
    : rest ? { t: rest, c: "var(--dim)", title: live === "ended" ? "The last session ended" : m.lastEventTs ? `No events since ${fmtTime(m.lastEventTs)}` : "No events recorded" }
    : !connected ? { t: "OFFLINE ◌", c: "var(--faint)", title: "Live stream disconnected — showing the last loaded data" }
    : { t: "LIVE ▸", c: "var(--run)", title: "Events arrived in the last 2 minutes" };

  const pick = (x: number) => {
    if (!n || x > W / 100) { onReplay(null); return; }
    onReplay(events[Math.min(n - 1, Math.max(0, Math.floor((x / (W / 100)) * n)))]!);
  };
  const onClick = (ev: MouseEvent<HTMLDivElement>) => { const r = ev.currentTarget.getBoundingClientRect(); pick((ev.clientX - r.left) / r.width); };
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = head ?? n;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); onReplay(events[Math.max(0, cur - 1)]!); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); onReplay(cur + 1 >= n ? null : events[cur + 1]!); }
    else if (ev.key === "End" || ev.key === "Escape") { ev.preventDefault(); onReplay(null); }
  };

  return (
    <>
      {replayAt && (
        <div className="replaybar">
          <span title={replayAt}>⏸ Replaying as of <b>{fmtTime(replayAt)}</b> — the Story shows only events recorded by then; the counts above stay current. New events keep arriving.</span>
          <button className="btn" type="button" onClick={() => onReplay(null)}>Back to live ▸</button>
        </div>
      )}
      <div className="row" style={{ marginBottom: 10, alignItems: "stretch" }}>
      <div className="scrub grow" style={{ marginBottom: 0 }} role="slider" tabIndex={0} aria-label="Replay timeline" aria-valuemin={0} aria-valuemax={Math.max(0, n - 1)} aria-valuenow={head ?? n}
        aria-valuetext={replayAt ? `Replaying as of ${fmtTime(replayAt)}` : "Live"} onClick={onClick} onKeyDown={onKey}
        title={n ? "Click to replay that moment · click the right edge for live · ← → step through events" : "No events recorded yet"}>
        {segs.map((s) => {
          const st = s.p === "unknown" ? "todo" : phaseCounts(m.stages, s.p).state;
          return <i key={s.from} style={{ left: `${(s.from / n) * W}%`, width: `${Math.max(0.3, ((s.to - s.from) / n) * W - 0.4)}%`, background: COLOR[st] }} title={`${s.p === "unknown" ? "No stage" : phaseName(s.p)} · ${s.to - s.from} events`} />;
        })}
        {gaps.map((g) => <span key={g.i} className="gapm" style={{ left: `${(g.i / n) * W}%` }} title={`┆┆ ${fmtDur(g.d)} with no events (${fmtTime(g.from)} → ${fmtTime(g.to)}), compressed`} />)}
        {head !== null && <span className="head" style={{ left: `${(head / n) * W}%` }} />}
      </div>
      {label && <span className="mono scrub-lv" style={{ color: label.c, fontSize: ".75rem", fontWeight: 700, alignSelf: "center", whiteSpace: "nowrap" }} title={label.title}>{label.t}</span>}
      </div>
    </>
  );
}

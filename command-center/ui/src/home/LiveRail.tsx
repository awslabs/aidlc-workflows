import type { findIntent, Route } from "../App";
import { describeEvent, fmtTime, fmtWaitLive, intentHash } from "../format";
import { useLiveClock, useLiveCtx } from "../useLive";
import { needGlyph } from "./IntentCard";
import { needHash, needWhere } from "./NeedsStrip";

export function LiveRail({ route, focused }: { route: Route; focused: ReturnType<typeof findIntent> }) {
  const { home, feed, connected } = useLiveCtx();
  const { now, frozen } = useLiveClock();
  const scoped = route.view === "intent";
  const fid = focused ? `${focused.w.path}::${focused.i.key}` : null;
  const needs = (home?.needs ?? []).filter((n) => !scoped || n.intent === fid);
  const events = feed.filter((e) => !scoped || `${e.ws}::${e.key}` === fid);
  const nameOf = (ws: string, key: string) => home?.workspaces.find((w) => w.path === ws)?.intents.find((i) => i.key === key)?.name ?? key;

  return (
    <>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="lbl">Needs you{scoped ? " · this intent" : ""}</div>
        {needs.length ? needs.map((n, ix) => (
          <div className="needitem" key={`${n.intent}:${n.kind}:${n.stage}:${n.unit}:${ix}`} role="link" tabIndex={0}
            onClick={() => { location.hash = needHash(n); }} onKeyDown={(e) => { if (e.key === "Enter") location.hash = needHash(n); }}>
            <span className="wait" aria-label={n.kind}>{needGlyph(n.kind)}</span>
            <div className="grow"><b>{n.detail}</b><div className="dim mono">{n.intentName}<br />{needWhere(n)}</div></div>
            <span className="wait mono" title={frozen ? "Live stream disconnected — timer paused" : n.since ?? "start time not recorded"}>{fmtWaitLive(n.since, now, frozen)}</span>
          </div>
        )) : <div className="dim">Nothing waiting on you.</div>}
      </div>
      <div className="panel feed">
        <div className="lbl row between"><span>Live activity{scoped ? "" : " · all intents"}</span><span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>newest first</span></div>
        <div>
          {events.map((e) => {
            const d = describeEvent(e);
            const where = [e.stage, e.unit].filter(Boolean).join(" · ");
            return (
              <div className="ev new" key={e.id}>
                <span className="t mono" title={e.ts}>{fmtTime(e.ts).slice(6)}</span>
                <span className="grow"><span className={d.cls}>{d.glyph} {d.label}{where ? ` · ${where}` : ""}</span>
                  {!scoped && <><br /><a className="chip" href={intentHash(e.ws, e.key)} style={{ color: "inherit", textDecoration: "none" }}>{nameOf(e.ws, e.key)}</a></>}</span>
              </div>
            );
          })}
          {!events.length && <div className="dim" style={{ fontSize: ".88rem" }}>{connected ? "No new activity since you opened this page. Events appear here as agents work." : "Live activity appears here once the stream connects."}</div>}
        </div>
      </div>
    </>
  );
}

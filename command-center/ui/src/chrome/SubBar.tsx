import type { findIntent, Route } from "../App";
import { fmtAgo, fmtTime } from "../format";
import { liveNow, restLabel } from "../intent/derive";
import { useLiveCtx, useNow } from "../useLive";

interface Props { route: Route; focused: ReturnType<typeof findIntent>; replay: string | null; onToggleRail: () => void }

export function SubBar({ route, focused, replay, onToggleRail }: Props) {
  const { connected, tried, lastMsgAt } = useLiveCtx();
  const now = useNow(1000);
  return (
    <div className="subbar">
      <div className="crumbs">
        <a href="#/">Home</a>
        {route.view === "health" && <> / <b>Health</b></>}
        {route.view === "intent" && (focused
          ? <> / <span title={focused.w.path}>{focused.w.label}</span> / <b>{focused.i.name}</b></>
          : <> / <b>{route.space}/{route.dir}</b></>)}
      </div>
      <div className="grow" />
      <Fresh connected={connected} tried={tried} lastMsgAt={lastMsgAt} now={now} focused={focused} replay={replay} />
      <button className="iconbtn" type="button" title="Live activity rail" onClick={onToggleRail}>⇥ Live rail</button>
    </div>
  );
}

function Fresh({ connected, tried, lastMsgAt, now, focused, replay }: { connected: boolean; tried: boolean; lastMsgAt: number; now: number; focused: Props["focused"]; replay: string | null }) {
  if (replay) return <span className="fresh wait">⏸ REPLAY · {fmtTime(replay)}</span>;
  if (!connected) {
    return tried
      ? <span className="fresh faint" title="The live stream is not available; retrying with backoff. Data shown is from the last successful load.">Disconnected — reconnecting</span>
      : <span className="fresh faint">Connecting…</span>;
  }
  const i = focused?.i;
  // The server's liveness decays here too: "active" lapses to idle 2 min after the newest event.
  const rest = i ? restLabel(liveNow(i.liveness, i.lastEventTs, now), i.lastEventTs, now) : null;
  if (i && rest) return <span className="fresh dim" title={i.lastEventTs ?? "no events recorded"}>{rest}</span>;
  return <span className="fresh run"><span className="live-dot" />LIVE · updated {fmtAgo(new Date(lastMsgAt).toISOString(), now)}</span>;
}

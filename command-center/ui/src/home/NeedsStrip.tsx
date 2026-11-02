import type { HomePayload } from "../../../../core/command-center/server/types";
import { fmtWaitLive, intentHash } from "../format";
import { needGlyph } from "./IntentCard";

export type NeedRow = HomePayload["needs"][number];

/** `need.intent` is `<workspace path>::<space>/<dir>`. */
export function needHash(n: NeedRow): string {
  const ix = n.intent.lastIndexOf("::");
  return intentHash(n.intent.slice(0, ix), n.intent.slice(ix + 2));
}
export const needWhere = (n: NeedRow) => `${n.stage}${n.unit ? ` · ${n.unit}` : ""}`;

export function NeedsStrip({ needs, now, frozen }: { needs: NeedRow[]; now: number; frozen: boolean }) {
  return (
    <div className="panel needs">
      <div className="lbl">Needs you · {needs.length}</div>
      {needs.length ? needs.map((n, ix) => (
        <div className="needitem" key={`${n.intent}:${n.kind}:${n.stage}:${n.unit}:${ix}`} role="link" tabIndex={0}
          onClick={() => { location.hash = needHash(n); }} onKeyDown={(e) => { if (e.key === "Enter") location.hash = needHash(n); }}>
          <span className="wait" style={{ fontSize: "1.1rem" }} aria-label={n.kind}>{needGlyph(n.kind)}</span>
          <span className="grow"><b>{n.detail}</b> · {n.intentName} · <span className="mono dim">{needWhere(n)}</span></span>
          <span className="wait mono" title={frozen ? `Since ${n.since ?? "an unrecorded time"} — live stream disconnected, timer paused` : n.since ?? "start time not recorded"}>waiting {fmtWaitLive(n.since, now, frozen)}</span>
          <a href={needHash(n)} onClick={(e) => e.stopPropagation()}>open →</a>
        </div>
      )) : <div className="dim">Nothing is waiting on you. Every running intent is moving on its own.</div>}
    </div>
  );
}

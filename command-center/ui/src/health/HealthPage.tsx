// Health: everything that needs fixing across every watched workspace — hard stops, failures, refusals, bypasses —
// as one issue log, with the hooks' heartbeats and what the dashboard can and cannot see.
import { useEffect, useState } from "react";
import { countIssues, type HealthPayload } from "../../../../core/command-center/server/hooks-map";
import { get } from "../api";
import { openIssue } from "../lenses/common";
import { useLiveClock, useLiveCtx } from "../useLive";
import { IssueLog } from "./IssueLog";
import { CoverageNote, HooksTable } from "./IssuesTable";

export function HealthPage() {
  const { home } = useLiveCtx();
  const { now } = useLiveClock();
  const [data, setData] = useState<HealthPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allHooks, setAllHooks] = useState(false);
  const version = home?.generatedAt ?? "";
  useEffect(() => {
    let off = false;
    get<HealthPayload>("/api/health").then((d) => { if (!off) { setData(d); setErr(null); } }).catch((e: Error) => { if (!off) setErr(e.message); });
    return () => { off = true; };
  }, [version]);
  if (!data) return <div className="panel dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load health — ${err}.` : "Loading health…"}</div>;
  const workspaces = [...new Set(data.issues.map((i) => i.workspace).concat(data.hooks.map((h) => h.workspace)))].sort();
  const need = countIssues(data.issues).needsFixing;
  return (
    <div className="hl-page" data-loaded="">
      <IssueLog issues={data.issues} scoped now={now} wsOptions={workspaces} onOpen={(s) => { if (s.intentKey) openIssue(s.workspace, s.intentKey, s.id); }}
        title="Health" subtitle={<>Recorded failures, refusals and resolutions across {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}, read from AIDLC's own records and never changed · {need ? <b className="bad">{need} need fixing</b> : <span className="ok">✓ nothing needs fixing</span>}</>} />
      <CoverageNote c={data.coverage} />
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <div className="lbl" style={{ margin: 0 }}>Hooks</div>
          <button type="button" className="linkbtn" onClick={() => setAllHooks((x) => !x)}>{allHooks ? "show problems only" : `show all ${data.hooks.length} hooks`}</button>
        </div>
        <HooksTable hooks={data.hooks} all={allHooks} showIntent now={now} />
      </div>
    </div>
  );
}

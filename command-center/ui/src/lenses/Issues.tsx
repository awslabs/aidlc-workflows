// Issues: what needs fixing in this intent (and the workspace-level items attributed to it), from /api/lens/issues,
// as the same issue log the Health page shows.
import { useEffect, useMemo, useState } from "react";
import type { HealthPayload } from "../../../../core/command-center/server/hooks-map";
import { IssueLog } from "../health/IssueLog";
import { CoverageNote, HooksTable } from "../health/IssuesTable";
import { useLiveClock } from "../useLive";
import { inScope, lensVersion, takePendingIssue, useLens, type XLensProps } from "./common";

/** Open hard stops and failures, plus refusals that repeat or are terminal: the Issues tab count. */
export const issuesCount = (p: HealthPayload | null) => (p ? p.issues.filter((i) => i.needsFixing).length : null);

export function Issues({ model: m, ws, filter }: XLensProps) {
  const { data, err } = useLens<HealthPayload>("issues", ws, m.key, lensVersion(m));
  const { now } = useLiveClock();
  const [sel, setSel] = useState<string | null>(() => takePendingIssue());
  const [allHooks, setAllHooks] = useState(false);
  useEffect(() => {
    const f = (e: Event) => { const id = (e as CustomEvent<string>).detail; takePendingIssue(); setSel(id); };
    addEventListener("cc-issue", f); return () => removeEventListener("cc-issue", f);
  }, []);
  // A deep-linked entry stays listed even when the phase stepper's scope would hide it.
  const issues = useMemo(() => (data?.issues ?? []).filter((i) => i.id === sel || !i.where.stage || inScope(m.stages, filter, i.where.stage, i.where.unit ?? null)), [data, m.stages, filter, sel]);
  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load issues — ${err}.` : "Loading issues…"}</div>;
  const need = issuesCount(data) ?? 0;
  return (
    <div data-loaded="">
      <IssueLog issues={issues} scoped={false} now={now} initial={sel} title="Issue log"
        subtitle={<>Recorded failures, refusals and resolutions for this intent · {need ? <b className="bad">{need} need fixing</b> : <span className="ok">✓ nothing needs fixing</span>} · entries with a stage follow the phase stepper's scope</>} />
      <CoverageNote c={data.coverage} />
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <div className="lbl" style={{ margin: 0 }}>Hooks for this intent</div>
          {data.hooks.length > 0 && <button type="button" className="linkbtn" onClick={() => setAllHooks((x) => !x)}>{allHooks ? "show problems only" : `show all ${data.hooks.length} hooks`}</button>}
        </div>
        <HooksTable hooks={data.hooks} all={allHooks} now={now} />
      </div>
    </div>
  );
}

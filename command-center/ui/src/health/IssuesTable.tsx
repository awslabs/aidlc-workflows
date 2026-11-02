// The hooks table and the coverage note, shared by the Health page (every workspace) and an intent's Issues tab.
// The issues themselves are in IssueLog.tsx.
import type { HealthCoverage, HookRow, HookState } from "../../../../core/command-center/server/hooks-map";
import { fmtAgo, fmtTime } from "../format";

const HOOK_STATE: Record<HookState, { g: string; label: string; cls: string; title: string }> = {
  ok: { g: "✓", label: "ok", cls: "ok", title: "Fired within 5 minutes of the workflow's last stage or gate entry" },
  stale: { g: "✗", label: "stale", cls: "bad", title: "Hooks stopped firing while the workflow kept advancing (more than 5 minutes behind): AIDLC refuses to proceed" },
  never: { g: "○", label: "never ran", cls: "faint", title: "No heartbeat from this hook. On its own that is normal for a hook whose event has not happened; it is a hard stop only when no hook has a heartbeat" },
  frozen: { g: "❄", label: "frozen (warning)", cls: "wait", title: "This hook's heartbeat is more than 24 h older than the workflow's last stage or gate entry. Session hooks can be legitimately old" },
};

/** Hooks: last heartbeat, state and drops. Healthy rows are folded away unless `all`. */
export function HooksTable({ hooks, all, showIntent = false, now = Date.now() }: { hooks: HookRow[]; all: boolean; showIntent?: boolean; now?: number }) {
  // "never ran" on one hook is normal (its event has not happened); it is a problem only when no hook of that record ran.
  const silent = new Set([...new Set(hooks.map((h) => `${h.workspace}#${h.intentKey}`))].filter((k) => hooks.filter((h) => `${h.workspace}#${h.intentKey}` === k).every((h) => h.state === "never")));
  // Informational rows (not the active intent, or no heartbeats here at all) are problems only when they recorded drops.
  const rows = all ? hooks : hooks.filter((h) => h.drops > 0 || (!h.note && (h.state === "stale" || h.state === "frozen" || (h.state === "never" && silent.has(`${h.workspace}#${h.intentKey}`)))));
  if (!hooks.length) return <div className="dim">No hook heartbeat folder and no workflow progress here yet.</div>;
  // In the problems view a record whose hooks are all stale (or all never ran) is one row: the whole record stopped, not each hook.
  const shown: (HookRow & { of?: number })[] = [];
  if (all) shown.push(...rows);
  else for (const h of rows) {
    const k = `${h.workspace}#${h.intentKey}`; const mine = hooks.filter((x) => `${x.workspace}#${x.intentKey}` === k);
    const whole = mine.length > 1 && mine.every((x) => x.state === h.state || (h.state === "stale" && x.state === "never")) && (h.state === "stale" || h.state === "never") && !mine.some((x) => x.drops);
    if (!whole) { shown.push(h); continue; }
    if (shown.some((x) => `${x.workspace}#${x.intentKey}` === k && x.of)) continue;
    const newest = mine.map((x) => x.lastAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    shown.push({ ...h, hook: `all ${mine.length} hooks`, phase: "every event", lastAt: newest, of: mine.length });
  }
  if (!rows.length) return <div className="ok">✓ Every hook with a heartbeat fired recently and none recorded a failure.</div>;
  return (
    <table className="hl-hooks">
      <thead><tr><th>Hook</th><th>Phase</th>{showIntent && <th>Intent</th>}<th>Last ran</th><th>State</th><th>Drops</th></tr></thead>
      <tbody>
        {shown.map((h) => {
          const s = HOOK_STATE[h.state];
          return (
            <tr key={`${h.workspace}#${h.intentKey}#${h.hook}`}>
              <td className="mono" title={h.of ? "Every hook of this record is in the same state: the record as a whole stopped. Show all hooks to list them" : undefined}>{h.hook}</td>
              <td className="dim">{h.phase}</td>
              {showIntent && <td className="dim" title={h.workspace}>{h.intentKey ? h.intentKey.split("/").at(-1) : <span className="faint">space level</span>}</td>}
              <td className="mono dim" title={h.lastAt ?? "No .last heartbeat file"}>{h.lastAt ? `${fmtTime(h.lastAt)} · ${fmtAgo(h.lastAt, now)}` : "—"}</td>
              <td>{h.note ? <span className="faint" title={`${s.title}. Informational: ${h.note}`}><span aria-hidden>{s.g}</span> {s.label} <span style={{ fontSize: ".78rem" }}>· {h.note}</span></span> : <span className={s.cls} title={s.title}><span aria-hidden>{s.g}</span> {s.label}</span>}</td>
              <td title={h.benignDrops ? `${h.benignDrops} more by design (Stop carve-outs), not failures` : undefined}>{h.drops ? <b className="wait">{h.drops}</b> : <span className="faint">0</span>}{h.benignDrops ? <span className="faint"> (+{h.benignDrops} by design)</span> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function CoverageNote({ c }: { c: HealthCoverage }) {
  return (
    <>
      {c.note && <div className="warn hl-coverage" role="note">{c.note}</div>}
      <div className="faint" style={{ fontSize: ".82rem", margin: "4px 0 10px" }}>
        Transcripts: <b>{c.transcripts === "on" ? `on · ${c.transcriptRuns ?? 0} hook run${c.transcriptRuns === 1 ? "" : "s"} seen, ${c.transcriptFailures ?? 0} failure${c.transcriptFailures === 1 ? "" : "s"}` : c.transcripts === "off" ? "off" : c.transcripts === "unrecognised" ? "format not recognised" : "none readable"}</b>
        {c.transcripts === "on" && c.transcriptReprompts ? <> ({c.transcriptReprompts} Stop-hook re-prompt{c.transcriptReprompts === 1 ? "" : "s"} by design, not failures)</> : null} · hook trace: <b>{c.trace ? "read" : "not set"}</b>.
        {" "}A crashing hook can still look alive: most hooks write their heartbeat before their own logic runs.
      </div>
    </>
  );
}

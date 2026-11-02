import { AUTO_COMPACT_ABOVE, type Counts, GROUPINGS, type GroupKey, type HomePrefs, SORTS, type SortKey, STATUS_KEYS, STATUS_META, type StatusKey, type ViewKind } from "./homeView";

interface Props {
  prefs: HomePrefs; setPrefs: (p: HomePrefs) => void; counts: Counts;
  visible: number; total: number;
  view: ViewKind; viewPref: ViewKind | null; setViewPref: (v: ViewKind | null) => void;
  /** Problem workspaces hidden because a status chip is on; the note clears the chips. */
  hiddenProblems: number; onClearFilters: () => void;
}

/** Status chips with live counts, search, sort, group-by and the Cards / Compact switch. */
export function HomeToolbar({ prefs, setPrefs, counts, visible, total, view, viewPref, setViewPref, hiddenProblems, onClearFilters }: Props) {
  const toggle = (k: StatusKey) => {
    const on = prefs.filters.includes(k);
    setPrefs({ ...prefs, filters: on ? prefs.filters.filter((x) => x !== k) : [...prefs.filters, k] });
  };
  const all = STATUS_KEYS.reduce((n, k) => n + counts[k], 0);
  return (
    <div className="hometools" role="toolbar" aria-label="Filter and arrange intents">
      <div className="row ht-row">
        <div className="row ht-chips" role="group" aria-label="Filter by status">
          <button type="button" className={`chip clk${prefs.filters.length ? "" : " on"}`} aria-pressed={!prefs.filters.length}
            onClick={() => setPrefs({ ...prefs, filters: [] })}>All <b>{all}</b></button>
          {STATUS_KEYS.map((k) => {
            const m = STATUS_META[k]; const on = prefs.filters.includes(k);
            return (
              <button key={k} type="button" className={`chip clk hchip${on ? " on" : ""}${counts[k] ? "" : " zero"}`} aria-pressed={on} onClick={() => toggle(k)}
                title={k === "done" ? "Registry status complete or archived" : k === "idle" ? "No event in the last 2 minutes (parked intents included)" : undefined}>
                <span className={m.cls} aria-hidden>{m.glyph}</span> {m.label} <b>{counts[k]}</b>
              </button>
            );
          })}
        </div>
        <span className="grow" />
        {hiddenProblems > 0 && (
          <button type="button" className="linkbtn ht-hidden" title="Clear the status filter to show them" onClick={onClearFilters}>
            ⚠ {hiddenProblems} workspace{hiddenProblems === 1 ? "" : "s"} with problems hidden by the filter
          </button>
        )}
        <span className="dim ht-count">{visible === total ? `${total} intent${total === 1 ? "" : "s"}` : `${visible} of ${total} intents`}</span>
      </div>
      <div className="row ht-row">
        <label className="fld ht-search">
          <span className="faint" aria-hidden>⌕</span>
          <input className="cc-input" type="search" value={prefs.q} placeholder="Filter by intent, workspace, stage or unit"
            aria-label="Filter intents by name, workspace, stage or unit" onChange={(e) => setPrefs({ ...prefs, q: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") setPrefs({ ...prefs, q: "" }); }} />
        </label>
        <label className="ht-sel"><span className="lbl">Sort</span>
          <select value={prefs.sort} onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as SortKey, reverse: false })}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {prefs.reverse && <button type="button" className="linkbtn" title="Back to the default direction" onClick={() => setPrefs({ ...prefs, reverse: false })}>reversed ×</button>}
        </label>
        <label className="ht-sel"><span className="lbl">Group</span>
          <select value={prefs.group} onChange={(e) => setPrefs({ ...prefs, group: e.target.value as GroupKey })}>
            {GROUPINGS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </label>
        <span className="grow" />
        <span className="ht-sel"><span className="lbl">View</span>
          <span className="seg" role="group" aria-label="View">
            {(["cards", "compact"] as const).map((v) => (
              <button key={v} type="button" className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setViewPref(v)}>{v === "cards" ? "▦ Cards" : "☰ Compact list"}</button>
            ))}
          </span>
          {viewPref
            ? <button type="button" className="linkbtn ht-auto" title={`Let the view follow the list: compact above ${AUTO_COMPACT_ABOVE} intents`} onClick={() => setViewPref(null)}>auto</button>
            : <span className="faint ht-auto" title={`Automatic: compact list above ${AUTO_COMPACT_ABOVE} visible intents, cards otherwise`}>auto</span>}
        </span>
      </div>
    </div>
  );
}

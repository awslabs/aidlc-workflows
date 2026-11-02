// One dense table per settings list (same shape for roots, pins, repos and hidden): an add row pinned at the top
// of the body, a checkbox column with select-all, a bulk bar with inline confirmation, sortable headers, a filter
// box once the list is long, and the Undo offer for the last edit. The visual language is Home's compact list
// (`.clist`); the per-table columns and actions are defined by the caller (SetupDialog).
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { FILTER_ABOVE, filterRows, type SortValue, sortRows } from "./settingsView";

/** What a press can land on that takes the keyboard; anything else is blank space. */
const FOCUSABLE = "button, input, select, textarea, a[href], [tabindex]";

/** What a row's cells and actions can ask the table to do. */
export interface RowApi {
  /** Confirm before acting: the question replaces the action bar's buttons until it is answered. */
  ask: (a: { question: string; run: () => void }, label: string) => void;
}
/** A pending confirmation. `fromBulk` ones own the selection; a row's own question must not touch it. */
interface Ask {
  question: string; label: string; run: () => void; fromBulk: boolean;
  /** The filter text and visible selection the question was asked about; it is withdrawn when either changes. */
  q: string; selKey: string;
}
export interface Column<T> {
  key: string;
  label: string;
  /** Fixed width in px. Exactly one column per table leaves it out and takes the remaining space. */
  w?: number;
  /** The value this column sorts on; a column without one cannot be sorted. `null` sorts last. */
  value?: (r: T) => SortValue;
  /** What the filter box matches on. */
  text?: (r: T) => string | null;
  cell: (r: T, api: RowApi) => ReactNode;
  /** Extra classes for the cells, e.g. `num` or `mono`. */
  cls?: string;
  /** Header tooltip. */
  title?: string;
}
export interface BulkAction {
  key: string;
  label: string;
  /** The question asked before it runs, e.g. "Remove 3 roots?". */
  confirm: (ids: string[]) => string;
  /** A reason this selection cannot be acted on (shown as the disabled button's title), or null. */
  blocked?: (ids: string[]) => string | null;
  run: (ids: string[]) => void;
}
export interface AddSpec {
  placeholder: string;
  /** The input's accessible name. */
  label: string;
  /** The reason the entry was refused, or null once it is saved (then the input clears). */
  onAdd: (value: string) => Promise<string | null>;
  /** Opens a folder chooser; resolves with the chosen folder, or null when nothing was chosen. */
  onBrowse?: () => Promise<string | null>;
  /** This table's Browse… is waiting for the chooser. */
  browsing?: boolean;
  /** Some other chooser is open — one at a time. */
  browseBusy?: boolean;
}

interface Props<T> {
  /** Used for the heading's id. */
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  rows: T[];
  /** The config entry behind the row: its identity for selection and for every action. */
  idOf: (r: T) => string;
  cols: Column<T>[];
  actions: (r: T, api: RowApi) => ReactNode;
  /** Width of the actions column in px. */
  actionsW: number;
  /** The column key the table is sorted by before the reader picks one. */
  defaultSort?: string;
  /** Rows a bulk action can act on; the others get a disabled checkbox. All rows, by default. */
  selectable?: (r: T) => boolean;
  add?: AddSpec;
  bulk?: BulkAction[];
  /** One line, shown when the list is empty. */
  empty: ReactNode;
  /** The Undo offer for the last edit made from this table. */
  undo?: { text: string; onUndo: () => void } | null;
  /** Singular and plural row noun, for the counts and the accessible names. */
  noun: [string, string];
  /** Overrides the count beside the heading, for a table whose rows are not all the same kind of thing. */
  count?: (shown: T[], rows: T[]) => ReactNode;
}

export function SettingsTable<T>({ id, title, hint, rows, idOf, cols, actions, actionsW, defaultSort, selectable, add, bulk, empty, undo, noun, count }: Props<T>) {
  const [sort, setSort] = useState<string | null>(defaultSort ?? null);
  const [reverse, setReverse] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  /** The action awaiting its inline confirmation, from a bulk button or from a row. */
  const [pending, setAsk] = useState<Ask | null>(null);
  const [addV, setAddV] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const addInput = useRef<HTMLInputElement>(null);

  const sortCol = cols.find((c) => c.key === sort && c.value);
  const filtered = filterRows(rows, q, (r) => cols.map((c) => c.text?.(r) ?? null));
  const shown = sortCol?.value ? sortRows(filtered, sortCol.value, reverse) : filtered;
  const shownIds = shown.filter((r) => selectable?.(r) ?? true).map(idOf);
  /**
   * What a bulk action acts on: ticks are kept while a filter hides their rows (they come back with the row),
   * but only what the reader can see right now is ever counted, confirmed or removed.
   */
  const picked = shownIds.filter((x) => sel.has(x));
  const selKey = picked.join("\u0000");
  const api: RowApi = { ask: (a, label) => setAsk({ ...a, label, fromBulk: false, q, selKey }) };
  /**
   * A question states how many rows it covers, so it must not outlive them. Filtering and ticking withdraw it
   * outright (below), and this guard is the backstop for a selection the rows themselves changed under: a
   * question is only ever on screen while the filter and visible selection it quoted still hold.
   */
  const ask = pending && pending.q === q && (!pending.fromBulk || pending.selKey === selKey) ? pending : null;
  const span = cols.length + 2;

  const sect = useRef<HTMLElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  /**
   * The control in this table the reader last focused or pressed; null once they act anywhere else (a pointer
   * press or focus outside the table, or a press on blank space inside it).
   */
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const inside = (n: EventTarget | null) => n instanceof Node && !!sect.current?.contains(n);
    const onFocusIn = (e: FocusEvent) => { last.current = inside(e.target) ? (e.target as Element) : null; };
    // Recorded on press too: Safari does not focus a button that is clicked, so focusin never fires for it.
    const onPointerDown = (e: PointerEvent) => {
      last.current = inside(e.target) ? ((e.target as Element).closest?.(FOCUSABLE) ?? null) : null;
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => { document.removeEventListener("focusin", onFocusIn, true); document.removeEventListener("pointerdown", onPointerDown, true); };
  }, []);
  /**
   * An action unmounts the control the reader was using (a row's button, a bulk button, Undo) and the browser
   * drops focus on <body> — outside the dialog. Only then is focus put on this table's heading. Runs after every
   * commit (the dialog re-renders once a second for its clock), so it acts on nothing else: while that control is
   * still in the document — focus left it on purpose, e.g. a click on blank space — it does nothing.
   */
  useEffect(() => {
    const el = last.current;
    if (!el || el.isConnected) return;
    last.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return; // something else already has the keyboard
    head.current?.focus({ preventScroll: true });
    last.current = head.current;
  });

  const onSort = (key: string) => {
    if (key === sort) setReverse((r) => !r);
    else { setSort(key); setReverse(false); }
  };
  /** Any change to the selection retires a bulk question: it counted what was ticked when it was asked. */
  const dropBulkAsk = () => setAsk((a) => (a?.fromBulk ? null : a));
  const flip = (rowId: string) => {
    dropBulkAsk();
    setSel((s) => {
      const next = new Set(s);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  };
  const allOn = shownIds.length > 0 && shownIds.every((x) => sel.has(x));
  const toggleAll = () => {
    dropBulkAsk();
    setSel((s) => {
      const next = new Set(s);
      for (const x of shownIds) { if (allOn) next.delete(x); else next.add(x); }
      return next;
    });
  };
  const clear = () => { setSel(new Set()); setAsk(null); };

  /** Add: shared by the input (Enter or Add) and by Browse…, so a refusal always lands in the row. */
  const submitAdd = async (value: string) => {
    if (!add || addBusy || !value.trim()) return;
    setAddBusy(true);
    try {
      const problem = await add.onAdd(value);
      setAddErr(problem);
      if (!problem) setAddV("");
    } finally { setAddBusy(false); }
  };
  const browseAdd = async () => {
    if (!add?.onBrowse || addBusy) return;
    const chosen = await add.onBrowse();
    // The chooser (or the in-app browser) took the keyboard with it: bring it back to the row either way.
    addInput.current?.focus();
    if (chosen === null) return; // cancelled: the row keeps whatever was typed
    setAddV(chosen);
    setAddErr(null);
    await submitAdd(chosen);
  };

  return (
    <section ref={sect} className="st-table" aria-labelledby={`${id}-h`}>
      <div className="row st-head">
        <h4 className="lbl" id={`${id}-h`} ref={head} tabIndex={-1}>{title}</h4>
        <span className="grow" />
        {rows.length > FILTER_ABOVE && (
          <label className="fld st-filter">
            <span className="faint" aria-hidden>⌕</span>
            <input className="cc-input" type="search" value={q} placeholder={`Filter ${noun[1]}`} aria-label={`Filter ${noun[1]}`}
              onChange={(e) => { setQ(e.target.value); setAsk(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); setAsk(null); } }} />
          </label>
        )}
        <span className="dim st-count">{count ? count(shown, rows) : shown.length === rows.length ? `${rows.length} ${rows.length === 1 ? noun[0] : noun[1]}` : `${shown.length} of ${rows.length}`}</span>
      </div>
      {hint && <div className="faint st-hint">{hint}</div>}
      {undo && (
        <div className="st-undo" role="status">
          <span aria-hidden>↺</span> {undo.text}
          <button type="button" className="linkbtn" onClick={undo.onUndo}>Undo</button>
        </div>
      )}
      {(ask || picked.length > 0) && (
        <div className="st-bulk" role="group" aria-label={ask && !ask.fromBulk ? "Confirm this action" : `Act on these ${noun[1]}`}>
          {picked.length > 0 && <b>{picked.length} selected</b>}
          {ask
            ? <>
                <span className="st-askq">{ask.question}</span>
                <button type="button" className="btn st-small"
                  onClick={() => { const a = ask; if (a.fromBulk) clear(); else setAsk(null); a.run(); }}>{ask.label}</button>
                <button type="button" className="linkbtn" onClick={() => setAsk(null)}>Cancel</button>
              </>
            : bulk?.map((b) => {
                const why = b.blocked?.(picked) ?? null;
                return (
                  <button key={b.key} type="button" className="linkbtn" disabled={!!why} title={why ?? undefined}
                    onClick={() => setAsk({ question: b.confirm(picked), run: () => b.run(picked), label: b.label, fromBulk: true, q, selKey })}>{b.label}</button>
                );
              })}
          <span className="grow" />
          {picked.length > 0 && <button type="button" className="linkbtn" onClick={clear}>Clear</button>}
        </div>
      )}
      <div className="clist-wrap">
        <table className="clist stable">
          <colgroup>
            <col style={{ width: 32 }} />
            {cols.map((c) => <col key={c.key} style={c.w ? { width: c.w } : undefined} />)}
            <col style={{ width: actionsW }} />
          </colgroup>
          <thead>
            <tr>
              <th className="st-ck">
                <SelectAll on={allOn} some={shownIds.some((x) => sel.has(x))} disabled={!shownIds.length}
                  label={`Select all ${shownIds.length} ${shownIds.length === 1 ? noun[0] : noun[1]}`} onChange={toggleAll} />
              </th>
              {cols.map((c) => {
                const on = c.key === sort && !!c.value;
                return (
                  <th key={c.key} title={c.title} aria-sort={on ? (reverse ? "descending" : "ascending") : c.value ? "none" : undefined}>
                    {c.value
                      ? <button type="button" className={`thsort${on ? " on" : ""}`} onClick={() => onSort(c.key)}>{c.label}{on && <span aria-hidden> {reverse ? "↑" : "↓"}</span>}</button>
                      : c.label}
                  </th>
                );
              })}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {add && (
              <AddRow add={add} span={span - 1} value={addV} err={addErr} busy={addBusy} inputRef={addInput}
                onChange={(v) => { setAddV(v); setAddErr(null); }} onSubmit={() => void submitAdd(addV)} onBrowse={() => void browseAdd()} />
            )}
            {!rows.length && <tr className="st-none"><td colSpan={span}>{empty}</td></tr>}
            {rows.length > 0 && !shown.length && <tr className="st-none"><td colSpan={span}>No {noun[1]} match this filter.</td></tr>}
            {shown.map((r) => {
              const rowId = idOf(r);
              const canPick = selectable?.(r) ?? true;
              return (
                <tr key={rowId} className={sel.has(rowId) ? "st-row on" : "st-row"}>
                  <td className="st-ck">
                    <input type="checkbox" checked={sel.has(rowId)} disabled={!canPick} onChange={() => flip(rowId)}
                      aria-label={canPick ? `Select ${rowId}` : "Nothing to select on this row"} />
                  </td>
                  {cols.map((c) => <td key={c.key} className={c.cls}>{c.cell(r, api)}</td>)}
                  <td><span className="st-acts">{actions(r, api)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A select-all box that shows "some" as the indeterminate state (which has no HTML attribute). */
function SelectAll({ on, some, disabled, label, onChange }: { on: boolean; some: boolean; disabled: boolean; label: string; onChange: () => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = some && !on; }, [some, on]);
  return <input ref={box} type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={onChange} />;
}

/** The add row: Enter, Add and Browse… all submit; the reason a value was refused stays until the value changes. */
function AddRow({ add, span, value, err, busy, inputRef, onChange, onSubmit, onBrowse }: {
  add: AddSpec; span: number; value: string; err: string | null; busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (v: string) => void; onSubmit: () => void; onBrowse: () => void;
}) {
  return (
    <tr className="st-add">
      <td className="st-ck" />
      <td colSpan={span}>
        <div className="row">
          <span className="faint" aria-hidden>+</span>
          <input ref={inputRef} className="cc-input grow mono" value={value} placeholder={add.placeholder} aria-label={add.label}
            onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }} />
          {add.onBrowse && (
            <button type="button" className="btn ghost st-small" disabled={add.browseBusy || busy} onClick={onBrowse}>{add.browsing ? "Choosing…" : "Browse…"}</button>
          )}
          <button type="button" className="btn st-small" disabled={busy || !value.trim()} onClick={onSubmit}>{busy ? "Adding…" : "Add"}</button>
        </div>
        {err && <div className="bad st-adderr">✗ {err}</div>}
      </td>
    </tr>
  );
}

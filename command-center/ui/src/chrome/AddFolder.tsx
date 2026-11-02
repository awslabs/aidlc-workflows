// "Add a project folder": the one place to add a local folder. One button opens a folder chooser; a path can be
// pasted instead. Whether the folder is a single project or a folder of projects is worked out by the caller
// (SetupDialog), so the reader never has to know the difference between a root and a pin to get started.
import { useRef, useState } from "react";

interface Props {
  /** True on first run: the panel is the whole point of the dialog, so it says more. */
  first: boolean;
  /** Opens a folder chooser; resolves with the chosen folder, or null when nothing was chosen. */
  onChoose: () => Promise<string | null>;
  /** The reason the folder was refused, or null once it is saved. */
  onAdd: (path: string) => Promise<string | null>;
  /** This panel's chooser is open. */
  choosing: boolean;
  /** Some other chooser is open — one at a time. */
  chooserBusy: boolean;
  /** What the last add did, with its Undo. */
  done: { text: string; onUndo: () => void } | null;
}

export function AddFolder({ first, onChoose, onAdd, choosing, chooserBusy, done }: Props) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (path: string) => {
    if (busy || !path.trim()) return;
    setBusy(true);
    try {
      const problem = await onAdd(path);
      setErr(problem);
      setValue(problem ? path : "");
    } finally { setBusy(false); }
  };
  const choose = async () => {
    if (busy) return;
    const chosen = await onChoose();
    if (chosen === null) return; // cancelled: whatever was typed stays
    setErr(null);
    await submit(chosen);
    input.current?.focus(); // the chooser took the keyboard with it: bring it back to the panel
  };

  return (
    <section className={`af${first ? " af-first" : ""}`} aria-labelledby="af-h">
      <div className="af-text">
        <h4 id="af-h" className="af-title">Add a project folder</h4>
        <div className="dim af-sub">
          Choose one AIDLC project, or a folder that holds several (for example <span className="mono">~/code</span>).
          The dashboard works out which it is and keeps watching it.
        </div>
      </div>
      <div className="af-actions">
        <button type="button" className="btn af-choose" disabled={chooserBusy || busy} onClick={() => void choose()}>
          <span aria-hidden>📁</span> {choosing ? "Choosing…" : busy ? "Adding…" : "Choose a folder…"}
        </button>
        <span className="faint af-or">or</span>
        <input ref={input} className="cc-input mono af-input" value={value} aria-label="Folder path"
          placeholder="paste a full path, e.g. /Users/you/code"
          onChange={(e) => { setValue(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(value); }} />
        <button type="button" className="btn ghost af-add" disabled={busy || !value.trim()} onClick={() => void submit(value)}>Add</button>
      </div>
      {err && <div className="bad af-msg" role="alert">✗ {err}</div>}
      {!err && done && (
        <div className="ok af-msg" role="status">
          ✓ {done.text} <button type="button" className="linkbtn" onClick={done.onUndo}>Undo</button>
        </div>
      )}
    </section>
  );
}

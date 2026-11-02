import type { PhaseKey, StoryEvent } from "../../../core/command-center/server/types";

export const fmtTokens = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const p2 = (n: number) => String(n).padStart(2, "0");
/** `08-13 23:19` in the viewer's local time zone (audit timestamps are UTC; the raw ISO stays in the hover title). */
export function fmtTime(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace("T", " ");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function fmtAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso); if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000)); if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}
/** "3h 12m" — a wait duration without the trailing "ago". */
export const fmtWait = (iso: string | null, now = Date.now()) => fmtAgo(iso, now).replace(/ ago$/, "");
export const GLYPH = { done: "✓", running: "▶", waiting: "?", todo: "○", skip: "–", gate: "◆", question: "?", plan: "◇", active: "●", idle: "◌", ended: "■" } as const;

export const PHASES: { key: PhaseKey; name: string; short: string }[] = [
  { key: "initialization", name: "Initialization", short: "Init" },
  { key: "ideation", name: "Ideation", short: "Ideation" },
  { key: "inception", name: "Inception", short: "Inception" },
  { key: "construction", name: "Construction", short: "Construction" },
  { key: "operation", name: "Operation", short: "Operation" },
];
export const phaseName = (k: PhaseKey) => PHASES.find((p) => p.key === k)?.name ?? "Unknown phase";

/** `/Users/x/a/b` → `~/a/b` for display only (the full path stays in the title). */
export const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

/** `key` is `<space>/<dir>`; every segment is URI-encoded (parseHash decodes each). */
export function intentHash(ws: string, key: string, lens?: string): string {
  const ix = key.indexOf("/");
  const space = ix < 0 ? key : key.slice(0, ix); const dir = ix < 0 ? "" : key.slice(ix + 1);
  return `#/i/${encodeURIComponent(ws)}/${encodeURIComponent(space)}/${encodeURIComponent(dir)}${lens ? `/${encodeURIComponent(lens)}` : ""}`;
}
/** A live wait duration; while disconnected the clock is frozen, so the honest statement is "at least". */
export const fmtWaitLive = (iso: string | null, now: number, frozen: boolean) => (iso ? `${frozen ? "≥\u00a0" : ""}${fmtWait(iso, now)}` : "—");

/** Glyph, colour class and label for one audit-derived story event (live rail). */
export function describeEvent(e: StoryEvent): { glyph: string; cls: string; label: string } {
  const v = e.raw?.fields?.Verdict;
  switch (e.kind) {
    case "STAGE_STARTED": return { glyph: "▶", cls: "run", label: "stage started" };
    case "STAGE_COMPLETED": return { glyph: "✓", cls: "ok", label: "stage complete" };
    case "UNIT_STARTED": return { glyph: "▶", cls: "run", label: "unit started" };
    case "UNIT_COMPLETED": return { glyph: "✓", cls: "ok", label: "unit complete" };
    case "REVIEW_COMPLETED": return v === "NOT-READY" ? { glyph: "✗", cls: "bad", label: "review NOT-READY" } : { glyph: "✓", cls: "ok", label: `review ${v ?? "completed"}` };
    case "STAGE_AWAITING_APPROVAL": return { glyph: "◆", cls: "wait", label: "gate open" };
    case "GATE_APPROVED": return { glyph: "◆", cls: "ok", label: "approved by you" };
    case "GATE_REJECTED": return { glyph: "↺", cls: "bad", label: "gate rejected" };
    case "ARTIFACT_CREATED": return { glyph: "✎", cls: "", label: "artifact written" };
    case "ARTIFACT_UPDATED": return { glyph: "✎", cls: "", label: "artifact updated" };
    case "WORKFLOW_PARKED": return { glyph: "⏸", cls: "dim", label: "parked" };
    case "WORKFLOW_UNPARKED": return { glyph: "↺", cls: "", label: "resumed" };
    case "STAGE_JUMPED": return { glyph: "↺", cls: "wait", label: "jumped back" };
    case "ERROR_LOGGED": return { glyph: "✗", cls: "bad", label: "error logged" };
    default: return { glyph: "·", cls: "", label: e.kind.toLowerCase().replace(/_/g, " ") };
  }
}

// Shared plumbing for the non-Story lenses: the scope filter, a small per-intent payload cache, and cross-lens links.
import { useEffect, useState } from "react";
import type { IntentModel, PhaseKey, StageView } from "../../../../core/command-center/server/types";
import { get, q } from "../api";
import { intentHash } from "../format";

/** What the phase stepper scopes a lens to; `phase: null` = the whole intent. */
export interface Filter { phase: PhaseKey | null; unit: string | null }
export interface XLensProps {
  model: IntentModel; ws: string; filter: Filter;
  /** The rail's current unit (Units highlights it even when the filter is wider). */
  selUnit: string | null;
  onSelect: (stage: string, unit?: string | null) => void;
}

export const phaseOf = (stages: StageView[], slug: string | null | undefined): PhaseKey => stages.find((s) => s.slug === slug)?.phase ?? "unknown";
/** A stage (+unit) is in scope when its catalog phase matches the filter's phase, and its unit matches a selected unit. */
export function inScope(stages: StageView[], f: Filter, stage: string | null | undefined, unit: string | null | undefined): boolean {
  if (f.phase && phaseOf(stages, stage) !== f.phase) return false;
  if (f.unit && unit !== f.unit) return false;
  return true;
}

type Entry = { version: string; promise: Promise<unknown>; data?: unknown };
const cache = new Map<string, Entry>();
const REFRESH_MS = 600;

/**
 * `/api/lens/<name>` for one intent, shared by every component that asks (tab counts and the lens itself).
 * A new `version` (the intent's newest event) refetches — immediately the first time, debounced while live,
 * keeping the previous payload on screen meanwhile.
 */
export function useLens<T>(name: string, ws: string, key: string, version: string, enabled = true): { data: T | null; err: string | null } {
  const id = `${name}\u0000${ws}\u0000${key}`;
  const [st, setSt] = useState<{ data: T | null; err: string | null }>(() => ({ data: (cache.get(id)?.data as T | undefined) ?? null, err: null }));
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    const run = () => {
      const c = cache.get(id);
      let p = c && c.version === version ? c.promise : undefined;
      if (!p) { p = get<T>(`/api/lens/${name}?${q({ ws, key })}`); cache.set(id, { version, promise: p, data: c?.data }); }
      const mine = p;
      mine.then((d) => {
        const cur = cache.get(id); if (cur && cur.promise === mine) cur.data = d;
        if (!off) setSt({ data: d as T, err: null });
      }).catch((e: Error) => {
        if (cache.get(id)?.promise === mine) cache.delete(id);
        if (!off) setSt((s) => ({ data: s.data, err: e.message }));
      });
    };
    const c = cache.get(id);
    if (c && c.version === version && c.data !== undefined) { setSt({ data: c.data as T, err: null }); return; }
    if (c?.data === undefined) { run(); return () => { off = true; }; }
    const t = setTimeout(run, REFRESH_MS);
    return () => { off = true; clearTimeout(t); };
  }, [id, name, ws, key, version, enabled]);
  return st;
}
/** The cache version of an intent's lens payloads: they change only when the audit (or the files it records) does. */
export const lensVersion = (m: IntentModel | null) => (m ? `${m.lastEventTs ?? ""}#${m.events.length}` : "");

let pendingArtifact: string | null = null;
/** Opens the Artifacts lens with `path` (record-relative) selected. */
export function openArtifact(ws: string, key: string, path: string): void {
  pendingArtifact = path;
  const h = intentHash(ws, key, "artifacts");
  if (location.hash === h) dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = h;
  dispatchEvent(new CustomEvent("cc-artifact", { detail: path }));
}
export function takePendingArtifact(): string | null { const p = pendingArtifact; pendingArtifact = null; return p; }

let pendingIssue: string | null = null;
/** Opens the intent's Issues lens with issue `id` selected (from the Health page or a Timeline mark). */
export function openIssue(ws: string, key: string, id: string): void {
  pendingIssue = id;
  const h = intentHash(ws, key, "issues");
  if (location.hash === h) dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = h;
  dispatchEvent(new CustomEvent("cc-issue", { detail: id }));
}
export function takePendingIssue(): string | null { const p = pendingIssue; pendingIssue = null; return p; }

export const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

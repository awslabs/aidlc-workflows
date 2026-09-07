// Shared client state. Modules read `store.*`, mutate through `store.set`, and
// subscribe with `store.on(key, fn)`. Keys emitted by `set` are the top-level
// property names that changed; free-form events use `store.emit`.

const listeners = new Map();

export const store = {
  state: null, // GET /api/state
  workflow: null, // GET /api/workflow
  view: { kind: "empty", path: null, intent: null, readOnly: false, stage: null },
  panel: "threads", // 'threads' | 'history' | 'outline' | null
  sidebar: true, // workflow panel visible
  annotations: [], // pending, unsent annotations for the current stage/revision
  document: null, // { path, sha256, source, blocks, outline }
  selection: null, // { block, text, line_start, line_end, heading_path } | null
  responses: new Map(), // remark_id -> { status, text, revision }
  focusThread: null,
  resolved: [],
  connected: false,
  set(partial) {
    const changed = [];
    for (const [key, value] of Object.entries(partial)) {
      store[key] = value;
      changed.push(key);
    }
    for (const key of changed) store.emit(key, store[key]);
  },
  on(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  },
  emit(key, payload) {
    for (const fn of listeners.get(key) || []) {
      try {
        fn(payload);
      } catch (error) {
        console.error(`[review-ui] listener for "${key}" failed`, error);
      }
    }
  },
};

/**
 * The selected threads as ids. `store.focusThread` holds one id or, when a
 * badge that groups several threads on one line is selected, an array of them
 * - the reference selects every thread the badge counts, at once.
 */
export function selectedThreadIds(value) {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (Array.isArray(value.ids) ? value.ids : [value.id])
      : [value];
  return raw.filter((id) => id !== null && id !== undefined && id !== "").map(String);
}

/** sessionStorage key for pending annotations of the current stage/revision. */
export function annotationsKey(state) {
  const current = state?.current;
  if (!current?.stage) return null;
  // Scoped to the intent: a new intent reaching the same stage at the same
  // revision starts with an empty rail, not the last intent's pending remarks.
  return `aidlc-review-feedback:${state.space || "default"}:${state.intent || ""}:${current.stage}:${current.unit || ""}:${current.revision}`;
}

export function restoreAnnotations(state) {
  const key = annotationsKey(state);
  if (!key) return [];
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((a) => a && typeof a.kind === "string" && typeof a.artifact === "string") : [];
  } catch {
    sessionStorage.removeItem(key);
    return [];
  }
}

export function persistAnnotations(state, annotations) {
  const key = annotationsKey(state);
  if (!key) return;
  if (!annotations.length) sessionStorage.removeItem(key);
  else sessionStorage.setItem(key, JSON.stringify(annotations));
}

/** "just now", "4 min ago", "2 hr ago", "3 days ago" - for who-did-what rows. */
export function relativeTime(value) {
  if (!value) return "";
  let time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  if (time < 10_000_000_000) time *= 1000;
  const seconds = Math.round((Date.now() - time) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)} hr ago`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}

export function setNotice(message, kind = "error") {
  store.emit("notice", message ? { message, kind } : null);
}

/** The lead persona of the stage that owns `path` (or the current stage), e.g. "Developer Agent". */
export function agentFor(path = null, stageSlug = null) {
  const slug = stageSlug || store.state?.current?.stage || store.state?.current_stage;
  for (const phase of store.workflow?.phases || []) {
    for (const stage of phase.stages || []) {
      if (path && (stage.artifacts || []).some((artifact) => artifact.path === path)) return stage.agent || "Agent";
      if (!path && slug && stage.slug === slug) return stage.agent || "Agent";
    }
  }
  return "Agent";
}

/**
 * The decision recorded for the daemon's still-open gate, until the hook
 * delivers it: "approve" | "request-changes" | null. The daemon states it
 * from the decision file; this tab keeps no memory of what it sent.
 */
export function decisionInFlight() {
  return store.state?.phase === "reviewing" ? store.state.decision_sent ?? null : null;
}

try {
  const saved = JSON.parse(sessionStorage.getItem("aidlc-review-ui:sent-edits") || "[]");
  if (Array.isArray(saved)) store.sentEdits = saved;
} catch {
  // ignore a corrupt or unavailable session store
}

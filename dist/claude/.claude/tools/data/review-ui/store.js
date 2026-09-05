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

/** sessionStorage key for pending annotations of the current stage/revision. */
export function annotationsKey(state) {
  const current = state?.current;
  if (!current?.stage) return null;
  return `aidlc-review-feedback:${current.stage}:${current.unit || ""}:${current.revision}`;
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

export function setNotice(message, kind = "error") {
  store.emit("notice", message ? { message, kind } : null);
}

import { api } from "./api.js";
import { diffOps, escapeHtml } from "./diff.js";
import { agentFor, decisionInFlight, persistAnnotations, setNotice, store } from "./store.js";

const slot = document.getElementById("slot");
const KINDS = [
  ["comment", "Comment"],
  ["edit", "Suggestion"],
  ["delete", "Delete"],
  ["looks-good", "Looks good"],
];

let drafts = [];
let sentThreads = [];
let summaryThreads = [];
let remoteKey = null;
let remoteLoading = false;
let remoteSequence = 0;
let showResolved = true;
let sortMode = "document";
// Resolving a sent thread is a reviewer-side receipt: it changes what the panel
// shows, never the record. Kept per stage directory in sessionStorage.
const RESOLVED_KEY = "aidlc-review-resolved";
function resolvedSet() {
  try {
    const all = JSON.parse(sessionStorage.getItem(RESOLVED_KEY) || "{}");
    return new Set(Array.isArray(all[stageDirectory() || ""]) ? all[stageDirectory() || ""] : []);
  } catch {
    return new Set();
  }
}
function toggleResolved(id) {
  const dir = stageDirectory() || "";
  let all = {};
  try {
    all = JSON.parse(sessionStorage.getItem(RESOLVED_KEY) || "{}");
  } catch {
    all = {};
  }
  const set = new Set(Array.isArray(all[dir]) ? all[dir] : []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  all[dir] = [...set];
  sessionStorage.setItem(RESOLVED_KEY, JSON.stringify(all));
}
let noteEditor = null;
let generalNote = "";
let sending = false;
let remarksMode = "details";

export function init() {
  store.on("panel", render);
  store.on("state", () => {
    invalidateRemote();
    render();
  });
  store.on("workflow", render);
  store.on("document", () => {
    invalidateRemote();
    render();
  });
  store.on("view", () => {
    invalidateRemote();
    sentThreads = [];
    summaryThreads = [];
    store.set({ remarks: [] });
    render();
  });
  store.on("annotations", render);
  store.on("refresh", () => {
    invalidateRemote();
    render();
    void ensureRemoteThreads();
  });
  store.on("compose", openComposer);
  store.on("suggest", upsertSuggestion);
  store.on("focus", focusThread);
  store.on("focusThread", focusThread);
  store.on("decide", beginDecision);
}

function openComposer(payload = {}) {
  const selection = payload.selection && typeof payload.selection === "object" ? { ...payload, ...payload.selection } : payload;
  const id = uniqueAnnotationId(selection.id || payload.id);
  const draft = {
    id,
    kind: normalizeKind(payload.kind || "comment"),
    artifact: basename(selection.artifact || selection.path || store.document?.path || "artifact.md"),
    block: blockIndex(selection.block),
    selection: selection.text || selection.selection || "",
    line_start: numberOrUndefined(selection.line_start),
    line_end: numberOrUndefined(selection.line_end),
    heading_path: stringList(selection.heading_path),
    css_path: typeof selection.css_path === "string" ? selection.css_path : undefined,
    reply_to: typeof payload.reply_to === "string" ? payload.reply_to : undefined,
    body: typeof payload.body === "string" ? payload.body : "",
  };
  drafts.push(draft);
  if (store.panel !== "threads") store.set({ panel: "threads" });
  else render();
  // Written in the document's popover: it lands in the panel as a posted thread.
  if (payload.post && draft.body) {
    postDraft(id);
    requestAnimationFrame(() => focusThread(id));
    return;
  }
  requestAnimationFrame(() => slot.querySelector(`[data-draft-id="${escapeSelector(id)}"] textarea`)?.focus());
}

function invalidateRemote() {
  remoteKey = null;
  remoteLoading = false;
  remoteSequence += 1;
}

function upsertSuggestion(payload = {}) {
  const annotation = normalizeAnnotation({ ...payload, kind: "edit" });
  const annotations = store.annotations.slice();
  const index = annotations.findIndex((item) => item.id === annotation.id);
  if (index === -1) annotations.push(annotation);
  else annotations[index] = { ...annotations[index], ...annotation };
  saveAnnotations(annotations);
  if (store.panel !== "threads") store.set({ panel: "threads" });
}

function beginDecision(value) {
  const decision = normalizeDecision(value);
  if (!decision || sending) return;
  // Both decisions confirm in the Threads rail: Request changes takes the
  // note; Approve shows what will be sent and asks once. Neither fires from a
  // bare click, since the Stop hook applies the decision the moment it lands.
  noteEditor = decision === "request-changes" ? "decision" : "approve";
  if (store.panel !== "threads") store.set({ panel: "threads" });
  else render();
  requestAnimationFrame(() => slot.querySelector(noteEditor === "approve" ? ".decision-note-form [type=submit]" : "#decision-notes")?.focus());
}

async function sendDecision(decision, notes) {
  const current = store.state?.current;
  if (!current?.stage || !Number.isInteger(current.revision)) {
    setNotice("The approval gate is not available yet. You can still answer it in the terminal.");
    return;
  }
  if (store.view?.readOnly) {
    setNotice("This is a past artifact. Return to the current gate to decide, or answer the gate in the terminal.");
    return;
  }

  sending = true;
  render();
  const cleanNotes = String(notes || "").trim();
  const pending = store.annotations.map(feedbackAnnotation);
  let feedbackSent = false;
  try {
    if (pending.length || cleanNotes) {
      await api.post("/api/feedback", {
        stage: current.stage,
        unit: current.unit ?? null,
        revision: current.revision,
        decision_hint: decision === "approve" ? "approve" : "request-changes",
        ...(cleanNotes ? { general: cleanNotes } : {}),
        annotations: pending,
      });
      feedbackSent = true;
    }

    try {
      await api.post("/api/decision", {
        stage: current.stage,
        unit: current.unit ?? null,
        revision: current.revision,
        decision,
        ...(cleanNotes ? { notes: cleanNotes } : {}),
      });
      const sentEdits = [
        ...(Array.isArray(store.sentEdits) ? store.sentEdits : []),
        ...store.annotations
          .filter((item) => item.kind === "edit" && typeof item.after_block === "string")
          .map((item) => ({ ...item, revision: current.revision, sha256: store.document?.sha256 || "", path: item.path || store.document?.path || "" })),
      ];
      clearPending();
      store.set({ sentEdits });
      try {
        sessionStorage.setItem("aidlc-review-ui:sent-edits", JSON.stringify(sentEdits));
      } catch {
        // session storage is a convenience only
      }
      setNotice("Sent — the agent continues. (Answering the gate in the terminal does the same.)", "info");
    } catch (error) {
      if (error.status !== 404) throw error;
      clearPending();
      setNotice("Feedback sent · decide in the terminal (Approve / Request Changes)", "info");
    }
  } catch (error) {
    const suffix = feedbackSent
      ? " Feedback was saved; decide in the terminal to avoid sending it twice."
      : " You can still decide in the terminal.";
    setNotice(`${error.message}.${suffix}`);
  } finally {
    sending = false;
    render();
  }
}

function clearPending() {
  drafts = [];
  generalNote = "";
  noteEditor = null;
  saveAnnotations([]);
  remoteKey = null;
}

function feedbackAnnotation(annotation) {
  const kind = normalizeKind(annotation.kind);
  const output = {
    id: annotation.id,
    artifact: basename(annotation.artifact || store.document?.path || "artifact.md"),
    kind,
    heading_path: stringList(annotation.heading_path),
  };
  for (const key of ["selection", "css_path", "body", "reply_to"]) {
    if (typeof annotation[key] === "string" && annotation[key].trim()) output[key] = annotation[key];
  }
  for (const key of ["line_start", "line_end"]) {
    if (Number.isInteger(annotation[key])) output[key] = annotation[key];
  }
  if (kind === "edit") output.after = fullSourceAfter(annotation);
  return output;
}

function fullSourceAfter(annotation) {
  if (typeof annotation.after === "string") return annotation.after;
  const source = store.document?.source;
  const replacement = annotation.after_block;
  const start = annotation.line_start;
  const end = annotation.line_end;
  if (typeof source !== "string" || typeof replacement !== "string" || !Number.isInteger(start) || !Number.isInteger(end)) {
    return typeof source === "string" ? source : String(replacement || "");
  }
  const lines = source.split("\n");
  lines.splice(Math.max(0, start - 1), Math.max(0, end - start + 1), ...replacement.split("\n"));
  return lines.join("\n");
}

function postDraft(id) {
  const draft = drafts.find((item) => item.id === id);
  if (!draft) return;
  let annotation = normalizeAnnotation(draft);
  if (annotation.kind === "edit" && !annotation.after_block) {
    const before = sourceLines(annotation.line_start, annotation.line_end);
    annotation = {
      ...annotation,
      before,
      after_block: annotation.selection && before.includes(annotation.selection)
        ? before.replace(annotation.selection, annotation.body || "")
        : annotation.body || before,
      body: "",
    };
  }
  drafts = drafts.filter((item) => item.id !== id);
  saveAnnotations([...store.annotations.filter((item) => item.id !== id), annotation]);
}

function sourceLines(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || typeof store.document?.source !== "string") return "";
  return store.document.source.split("\n").slice(start - 1, end).join("\n");
}

function saveAnnotations(annotations) {
  const normalized = annotations.map(normalizeAnnotation);
  persistAnnotations(store.state, normalized);
  store.set({ annotations: normalized });
}

function normalizeAnnotation(value) {
  return {
    ...value,
    id: value.id ? String(value.id) : uniqueAnnotationId(),
    kind: normalizeKind(value.kind),
    artifact: basename(value.artifact || value.path || store.document?.path || "artifact.md"),
    heading_path: stringList(value.heading_path),
    block: blockIndex(value.block),
    line_start: numberOrUndefined(value.line_start),
    line_end: numberOrUndefined(value.line_end),
    selection: typeof value.selection === "string" ? value.selection : typeof value.text === "string" ? value.text : "",
    body: typeof value.body === "string" ? value.body : "",
  };
}

function uniqueAnnotationId(preferred, self) {
  const taken = new Set([
    ...store.annotations.filter((item) => item !== self).map((item) => item.id),
    ...drafts.filter((item) => item !== self).map((item) => item.id),
    // ids already on the record for this stage (the daemon enforces this too)
    ...(store.remarks || []).map((item) => item.id),
  ]);
  if (preferred && !taken.has(String(preferred))) return String(preferred);
  let number = 1;
  while (taken.has(`a${number}`)) number += 1;
  return `a${number}`;
}

async function ensureRemoteThreads() {
  const stageDir = stageDirectory();
  if (!stageDir) {
    sentThreads = [];
    summaryThreads = [];
    remarksMode = "details";
    store.set({ remarks: [] });
    return;
  }
  const key = `${store.view?.intent || ""}:${stageDir}:${store.state?.current?.revision ?? ""}`;
  if (remoteLoading || remoteKey === key) return;
  remoteLoading = true;
  remoteKey = key;
  const sequence = ++remoteSequence;
  try {
    const params = { stage_dir: stageDir, intent: store.view?.intent || undefined };
    const [remarks, history, responses] = await Promise.all([
      api.get("/api/remarks", params).catch(() => null),
      api.get("/api/history", params),
      api.get("/api/responses", params).catch(() => ({ entries: [] })),
    ]);
    if (sequence !== remoteSequence) return;
    const responseEntries = Array.isArray(responses.entries) ? responses.entries : [];
    const responseMap = new Map(responseEntries.map((entry) => [String(entry.remark_id), entry]));
    store.set({ responses: responseMap });
    const feedback = (Array.isArray(history.entries) ? history.entries : []).filter((entry) => entry.kind === "feedback");
    const structured = structuredRemarks(remarks);
    const detailGroups = structured.length
      ? []
      : await Promise.all(feedback.map((entry) => loadFeedbackEntry(stageDir, entry)));
    if (sequence !== remoteSequence) return;
    const available = structured.length ? structured : detailGroups.flatMap((group) => group || []);
    store.set({ remarks: available });
    if (available.length) {
      remarksMode = "details";
      sentThreads = available.map((thread) => ({ ...thread, response: responseMap.get(thread.id) || null }));
      summaryThreads = [];
    } else {
      remarksMode = "summary";
      sentThreads = [];
      summaryThreads = feedback.map((entry) => summaryFromHistory(entry, responseEntries));
    }
  } catch {
    if (sequence !== remoteSequence) return;
    sentThreads = [];
    summaryThreads = [];
    remarksMode = "unavailable";
    store.set({ remarks: [] });
  } finally {
    if (sequence === remoteSequence) {
      remoteLoading = false;
      if (store.panel === "threads") render();
    }
  }
}

function structuredRemarks(payload) {
  if (!Array.isArray(payload?.entries)) return [];
  return payload.entries.flatMap((round) => {
    const revision = Number.isInteger(round.revision) ? round.revision : 0;
    return (Array.isArray(round.remarks) ? round.remarks : []).map((remark, index) => ({
      id: String(remark.id || `${round.file || "feedback"}-${index + 1}`),
      kind: normalizeKind(remark.kind),
      artifact: typeof remark.artifact === "string" ? remark.artifact : "",
      heading_path: stringList(remark.heading_path),
      quote: typeof remark.quote === "string" ? remark.quote : "",
      body: typeof remark.body === "string" ? remark.body : "",
      diff: typeof remark.diff === "string" ? remark.diff : "",
      reply_to: typeof remark.reply_to === "string" ? remark.reply_to : null,
      revision,
      file: round.file,
      line_start: Number.MAX_SAFE_INTEGER,
    }));
  });
}

async function loadFeedbackEntry(stageDir, entry) {
  if (!entry?.file) return null;
  try {
    const artifact = await api.get("/api/artifact", {
      path: `${stageDir}/.review-ui/${entry.file}`,
      intent: store.view?.intent || undefined,
    });
    if (typeof artifact.source !== "string") return null;
    return parseFeedback(artifact.source, entry);
  } catch {
    return null;
  }
}

function parseFeedback(source, entry) {
  const matches = [...source.matchAll(/^###\s+(Comment|Suggestion|Delete|Looks good|Label|Edit(?: \(unified diff\))?)(?:\s*·\s*([\w-]+))?(?:\s+—.*)?\s*$/gim)];
  return matches.map((match, index) => {
    const body = source.slice(match.index + match[0].length, matches[index + 1]?.index ?? source.length).split(/^##\s/m)[0];
    const lines = body.split("\n").map((line) => line.trimEnd());
    const quote = lines.filter((line) => /^>\s?/.test(line)).map((line) => line.replace(/^>\s?/, "")).join(" ");
    const text = lines
      .filter((line) => line.trim() && !/^>\s?/.test(line) && !/^—\s/.test(line) && !/^\(.*\)$/.test(line) && !/^```/.test(line))
      .join("\n")
      .trim();
    return {
      id: match[2] || `${entry.file}-${index + 1}`,
      kind: normalizeKind(match[1]),
      quote,
      body: text,
      revision: Number.isInteger(entry.revision) ? entry.revision : 0,
      file: entry.file,
      line_start: lineNumberFromBody(body),
    };
  });
}

function lineNumberFromBody(body) {
  const match = body.match(/lines?\s*~?(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function summaryFromHistory(entry, responses) {
  const countMatch = String(entry.summary || "").match(/(\d+)\s+(?:remarks?|threads?|comments?)/i);
  const count = countMatch ? Number(countMatch[1]) : currentArtifactThreadCount();
  const revision = Number.isInteger(entry.revision) ? entry.revision : Math.max(0, (store.state?.current?.revision || 1) - 1);
  const replies = responses.filter((response) => response.file === entry.file || response.revision > revision);
  return { file: entry.file, count, revision, replies };
}

function currentArtifactThreadCount() {
  const path = store.document?.path;
  const stage = store.state?.current?.stage;
  for (const phase of store.workflow?.phases || []) {
    for (const item of phase.stages || []) {
      if (stage && item.slug !== stage) continue;
      const artifact = (item.artifacts || []).find((candidate) => candidate.path === path || candidate.name === basename(path));
      if (Number.isInteger(artifact?.threads)) return artifact.threads;
    }
  }
  return 0;
}

function render() {
  if (store.panel !== "threads") return;
  slot.dataset.panel = "threads";
  slot.dataset.threadMode = remarksMode;
  const pending = store.annotations;
  const totalSent = sentThreads.length || summaryThreads.reduce((total, item) => total + item.count, 0);
  const total = pending.length + drafts.length + totalSent;
  slot.innerHTML = `
    <section class="threads-panel" aria-labelledby="threads-title">
      <header class="threads-header">
        <div class="threads-title-row"><h2 id="threads-title">Threads</h2><span>· ${total} ${total === 1 ? "thread" : "threads"} ·</span><button class="threads-close" type="button" aria-label="Close threads">×</button></div>
        <div class="threads-control-row"><button class="threads-switch ${showResolved ? "on" : ""}" type="button" role="switch" aria-checked="${showResolved}"><i></i></button><span>Show resolved</span></div>
        <div class="threads-control-row"><span>Sort:</span><span class="threads-segment"><button class="${sortMode === "document" ? "on" : ""}" data-sort="document" type="button">In document order</button><button class="${sortMode === "recent" ? "on" : ""}" data-sort="recent" type="button">Recent</button></span></div>
        <button class="threads-note-link" type="button">${generalNote ? "Edit general note" : "Add general note"}</button>
      </header>
      ${renderNoteEditor()}
      ${pending.length || drafts.length ? `<p class="threads-pending-line"><b>${pending.length + drafts.length} pending</b> · nothing is applied yet — <b>Send changes</b> (top right) hands them to the agent; Approve records them as notes only</p>` : ""}
      <div class="thread-list">${renderThreadList()}</div>
    </section>`;
  bindThreads();
  void ensureRemoteThreads();
  focusThread(store.focusThread, false);
}

function renderNoteEditor() {
  if (!noteEditor) return generalNote ? `<p class="general-note-preview"><b>General note</b>${escapeHtml(generalNote)}</p>` : "";
  const deciding = noteEditor === "decision";
  const approving = noteEditor === "approve";
  const stage = store.workflow?.phases?.flatMap((phase) => phase.stages || []).find((item) => item.slug === store.state?.current?.stage);
  const pendingCount = store.annotations.length;
  const revisionLabel = Number.isInteger(store.state?.current?.revision) ? ` · r${store.state.current.revision}` : "";
  if (approving) {
    const changes = store.annotations.filter((item) => item.kind === "edit" || item.kind === "delete" || item.kind === "comment").length;
    const warning = changes
      ? `<p class="decision-warning">Approving does <b>not</b> apply your ${changes} pending ${changes === 1 ? "change" : "changes"} — the file stays as it is and they are recorded as notes for the record. To have the agent apply them, send them as changes instead.</p>`
      : "";
    return `<form class="decision-note-form approve-form">
      <label>Approve ${escapeHtml(stage?.name || "this stage")}${revisionLabel}<span>${changes ? "" : pendingCount ? `${pendingCount} pending ${pendingCount === 1 ? "remark goes" : "remarks go"} with it as notes; the agent continues to the next stage.` : "The agent continues to the next stage."}</span></label>
      ${warning}
      <textarea id="decision-notes" rows="2" placeholder="Optional note for the record">${escapeHtml(generalNote)}</textarea>
      <div><button class="btn" data-note-cancel type="button">Cancel</button>${changes ? `<button class="btn" data-send-changes type="button">Send ${changes} ${changes === 1 ? "change" : "changes"} instead</button>` : ""}<button class="btn ${changes ? "" : "primary"}" type="submit" ${sending ? "disabled" : ""}>${changes ? "Approve anyway" : `Approve${revisionLabel} →`}</button></div>
    </form>`;
  }
  const changes = store.annotations.filter((item) => item.kind === "edit" || item.kind === "delete" || item.kind === "comment").length;
  const requestTitle = changes ? `Send ${changes} ${changes === 1 ? "change" : "changes"}` : "Request changes";
  const requestDetail = changes
    ? `The agent applies your ${changes === 1 ? "edit or comment" : "edits and comments"} to the file, replies to each, and reopens the gate for you. Add context if it helps.`
    : "Describe what should change; the agent revises and reopens the gate.";
  return `<form class="decision-note-form">
    <label for="decision-notes">${deciding ? requestTitle : "General note"}<span>${deciding ? requestDetail : "Sent with your decision."}</span></label>
    <textarea id="decision-notes" rows="3" placeholder="${deciding && changes ? "Optional — anything the edits don't say" : "What should the agent know?"}">${escapeHtml(generalNote)}</textarea>
    <div><button class="btn" data-note-cancel type="button">Cancel</button><button class="btn primary" type="submit" ${sending ? "disabled" : ""}>${deciding ? (changes ? `${requestTitle} →` : "Send request") : "Save note"}</button></div>
  </form>`;
}

function renderThreadList() {
  const nested = (item) => item.reply_to && sentThreads.some((thread) => thread.id === item.reply_to);
  const cards = [
    ...drafts.filter((draft) => !nested(draft)).map(renderDraft),
    ...store.annotations.filter((annotation) => !nested(annotation)).map(renderPending),
    ...sortedSentThreads().map(renderSent),
    ...summaryThreads.map(renderSummary),
  ].filter(Boolean);
  if (cards.length) return cards.join("");
  if (remoteLoading) return `<p class="threads-empty">Loading threads…</p>`;
  if (!hasOpenGate()) return `<p class="threads-empty">No threads yet · comments open at the approval gate</p>`;
  if (remarksMode === "unavailable") return `<p class="threads-empty"><b>Threads are not available yet.</b>The document remains reviewable. Pending remarks will stay here until you decide.</p>`;
  if (store.view?.readOnly) return `<p class="threads-empty"><b>No threads for this artifact.</b>This past artifact is read-only; return to the current stage to review.</p>`;
  return `<p class="threads-empty"><b>No threads yet.</b>Select text to comment, or click into a paragraph and type to suggest an edit. Nothing reaches the agent until you send.</p>`;
}

function sortedSentThreads() {
  const visible = sentThreads.filter((thread) => !thread.reply_to && (showResolved || statusFor(thread).name !== "Resolved"));
  return visible.sort((left, right) => sortMode === "recent"
    ? (right.response?.revision || right.revision) - (left.response?.revision || left.revision)
    : (left.line_start || Number.MAX_SAFE_INTEGER) - (right.line_start || Number.MAX_SAFE_INTEGER));
}

function renderDraft(draft) {
  return `<article class="thread-card pending-card" data-draft-id="${escapeHtml(draft.id)}" data-thread-id="${escapeHtml(draft.id)}">
    ${quoteHtml(draft.selection)}
    <div class="thread-editor-row">${kindSelect(draft.kind)}<span>Not posted</span></div>
    <textarea rows="3" placeholder="${draft.kind === "edit" ? "Replacement text" : "Write a remark…"}">${escapeHtml(draft.body)}</textarea>
    <div class="thread-card-actions"><button data-remove-draft type="button">Remove</button><button class="btn primary" data-post-draft type="button">Post</button></div>
    <p class="thread-status pending">Pending · Send changes hands this to the agent</p>
  </article>`;
}

function renderPending(annotation) {
  const isEdit = annotation.kind === "edit";
  if (isEdit && annotation.before !== undefined && annotation.after_block !== undefined) {
    // The edit itself is shown in the document as tracked changes; the card is
    // the index entry: where, how much, and the optional reason for the agent.
    const summary = editSummary(annotation.before, annotation.after_block);
    const where = (annotation.heading_path || []).slice(-1)[0] || `lines ${annotation.line_start ?? "?"}–${annotation.line_end ?? "?"}`;
    return `<article class="thread-card pending-card edit-card" data-annotation-id="${escapeHtml(annotation.id)}" data-thread-id="${escapeHtml(annotation.id)}">
      <div class="thread-editor-row"><span class="thread-kind">Suggested edit</span><span>${escapeHtml(where)}</span></div>
      <p class="edit-summary">${summary}</p>
      <textarea rows="1" placeholder="Why (optional) — the agent reads this with the edit">${escapeHtml(annotation.body || "")}</textarea>
      <div class="thread-card-actions"><button data-show-annotation type="button">Show in document</button><button data-remove-annotation type="button">Undo edit</button></div>
      <p class="thread-status pending">Not sent yet · Send changes hands it to the agent</p>
    </article>`;
  }
  return `<article class="thread-card pending-card" data-annotation-id="${escapeHtml(annotation.id)}" data-thread-id="${escapeHtml(annotation.id)}">
    ${quoteHtml(annotation.selection)}
    <div class="thread-editor-row">${kindSelect(annotation.kind)}<span>You · just now</span></div>
    <textarea rows="2" placeholder="Write a remark…">${escapeHtml(annotation.body || "")}</textarea>
    <div class="thread-card-actions"><button data-remove-annotation type="button">Remove</button></div>
    <p class="thread-status pending">Not sent yet · Send changes hands it to the agent</p>
  </article>`;
}

/** The same summary for a sent remark, from its unified diff's removed/added lines. */
function diffSummary(unified) {
  const removed = [];
  const added = [];
  for (const line of String(unified).split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  return editSummary(removed.join("\n"), added.join("\n"));
}

/** "+12 words, −3 words · “…first changed words…”" for an edit card. */
function editSummary(before, after) {
  const ops = diffOps(before, after);
  const words = (text) => (String(text).match(/\S+/g) || []).length;
  const added = ops.filter((op) => op.type === "ins").reduce((total, op) => total + words(op.text), 0);
  const removed = ops.filter((op) => op.type === "del").reduce((total, op) => total + words(op.text), 0);
  const first = ops.find((op) => op.type === "ins")?.text || ops.find((op) => op.type === "del")?.text || "";
  const excerpt = first.replace(/\s+/g, " ").trim();
  const shown = excerpt.length > 90 ? `${excerpt.slice(0, 90)}…` : excerpt;
  const counts = [added ? `<ins>+${added} ${added === 1 ? "word" : "words"}</ins>` : "", removed ? `<del>−${removed} ${removed === 1 ? "word" : "words"}</del>` : ""].filter(Boolean).join(" ");
  return `${counts}${shown ? ` · <q>${escapeHtml(shown)}</q>` : ""}`;
}

function renderSent(thread) {
  const status = statusFor(thread);
  const followUps = sentThreads.filter((other) => other.reply_to === thread.id);
  const pendingReplies = [...drafts, ...store.annotations].filter((item) => item.reply_to === thread.id);
  const resolved = status.name === "Resolved";
  return `<article class="thread-card sent-card${resolved ? " resolved" : ""}" data-thread-id="${escapeHtml(thread.id)}">
    ${quoteHtml(thread.quote)}
    <div class="thread-who"><span class="thread-avatar">Y</span><b>You</b><span>r${thread.revision}</span><span class="thread-kind">${kindLabel(thread.kind)}</span></div>
    ${thread.diff ? `<p class="edit-summary">${diffSummary(thread.diff)}</p>` : thread.body ? `<p class="thread-body">${escapeHtml(thread.body)}</p>` : ""}
    ${renderReply(thread.response)}
    ${followUps.map((reply) => `<div class="thread-followup"><div class="thread-who"><span class="thread-avatar">Y</span><b>You</b><span>r${reply.revision}</span></div><p>${escapeHtml(reply.body || "")}</p>${renderReply(reply.response)}</div>`).join("")}
    ${pendingReplies.map((reply) => drafts.includes(reply)
      ? `<div class="thread-followup pending" data-draft-id="${escapeHtml(reply.id)}"><div class="thread-who"><span class="thread-avatar">Y</span><b>You</b><span>replying</span></div><textarea rows="2" placeholder="Reply…">${escapeHtml(reply.body || "")}</textarea><div class="thread-card-actions"><button data-remove-draft type="button">Remove</button><button class="btn primary" data-post-draft type="button">Post</button></div></div>`
      : `<div class="thread-followup pending" data-annotation-id="${escapeHtml(reply.id)}"><div class="thread-who"><span class="thread-avatar">Y</span><b>You</b><span>just now</span></div><p>${escapeHtml(reply.body || "")}</p><div class="thread-card-actions"><button data-remove-annotation type="button">Remove</button></div><p class="thread-status pending">Pending · Send changes hands this to the agent</p></div>`).join("")}
    <p class="thread-status ${status.className}">${status.name}${status.detail ? ` · ${escapeHtml(status.detail)}` : ""}</p>
    ${hasOpenGate() ? `<div class="thread-card-actions sent-actions"><button data-reply-to="${escapeHtml(thread.id)}" type="button">Reply</button><button data-resolve="${escapeHtml(thread.id)}" type="button">${resolved && resolvedSet().has(thread.id) ? "Reopen" : resolved ? "" : "Resolve"}</button></div>` : ""}
  </article>`;
}

function renderReply(response) {
  if (!response) return "";
  const verb = response.status === "applied" ? "Applied" : response.status === "kept" ? "Kept" : "Answered";
  return `<div class="thread-reply"><div class="thread-who"><span class="thread-avatar agent">A</span><b>${escapeHtml(agentFor())}</b><span>r${response.revision}</span></div><p><b>${verb}${response.text ? ":" : "."}</b>${response.text ? ` ${escapeHtml(response.text)}` : ""}</p></div>`;
}

function renderSummary(summary) {
  const count = Number.isInteger(summary.count) ? summary.count : 0;
  return `<article class="thread-card summary-card">
    <p><b>${count} ${count === 1 ? "remark" : "remarks"} sent in r${summary.revision}</b></p>
    <span>${escapeHtml(summary.file || "Feedback")}</span>
    ${summary.replies.length ? `<div class="summary-replies">${summary.replies.map((reply) => `<p><b>${escapeHtml(agentFor())} · r${reply.revision}</b> · ${escapeHtml(reply.status)}${reply.text ? ` — ${escapeHtml(reply.text)}` : ""}</p>`).join("")}</div>` : ""}
  </article>`;
}

function statusFor(thread) {
  if (resolvedSet().has(thread.id)) return { name: "Resolved", className: "resolved", detail: "by you" };
  if (thread.response?.status === "applied" || thread.response?.status === "answered") {
    return { name: `Addressed in r${thread.response.revision}`, className: "addressed", detail: "" };
  }
  if (thread.response?.status === "kept") return { name: "Open", className: "open", detail: `kept in r${thread.response.revision}` };
  if (thread.kind === "looks-good") return { name: "Resolved", className: "resolved", detail: "" };
  return { name: "Open", className: "open", detail: "" };
}


function bindThreads() {
  slot.querySelector(".threads-close")?.addEventListener("click", () => store.set({ panel: null }));
  slot.querySelector(".threads-switch")?.addEventListener("click", () => {
    showResolved = !showResolved;
    render();
  });
  for (const button of slot.querySelectorAll("[data-sort]")) button.addEventListener("click", () => {
    sortMode = button.dataset.sort;
    render();
  });
  slot.querySelector(".threads-note-link")?.addEventListener("click", () => {
    noteEditor = "general";
    render();
    requestAnimationFrame(() => slot.querySelector("#decision-notes")?.focus());
  });
  const noteForm = slot.querySelector(".decision-note-form");
  noteForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    generalNote = noteForm.querySelector("textarea").value.trim();
    if (noteEditor === "decision") void sendDecision("request-changes", generalNote);
    else if (noteEditor === "approve") void sendDecision("approve", generalNote);
    else {
      noteEditor = null;
      render();
    }
  });
  slot.querySelector("[data-note-cancel]")?.addEventListener("click", () => {
    noteEditor = null;
    render();
  });
  slot.querySelector("[data-send-changes]")?.addEventListener("click", () => {
    noteEditor = "decision";
    render();
    requestAnimationFrame(() => slot.querySelector("#decision-notes")?.focus());
  });

  for (const button of slot.querySelectorAll("[data-reply-to]")) button.addEventListener("click", () => {
    const parent = sentThreads.find((thread) => thread.id === button.dataset.replyTo);
    if (!parent) return;
    openComposer({
      kind: "comment",
      reply_to: parent.id,
      artifact: parent.artifact,
      selection: parent.quote,
      heading_path: parent.heading_path,
    });
  });
  for (const button of slot.querySelectorAll("[data-resolve]")) button.addEventListener("click", () => {
    toggleResolved(button.dataset.resolve);
    render();
  });
  for (const card of slot.querySelectorAll("[data-thread-id]")) card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    const id = card.dataset.threadId;
    if (store.focusThread === id) return;
    store.set({ focusThread: id });
    // Clicking into the card's own inputs selects it without scrolling the
    // document away from where the reader is typing.
    store.emit("focus", event.target.closest("textarea, select") ? { id, source: "rail-input" } : id);
  });
  for (const card of slot.querySelectorAll("[data-draft-id]")) {
    const draft = drafts.find((item) => item.id === card.dataset.draftId);
    card.querySelector("select")?.addEventListener("change", (event) => {
      draft.kind = normalizeKind(event.target.value);
      render();
    });
    card.querySelector("textarea")?.addEventListener("input", (event) => { draft.body = event.target.value; });
    card.querySelector("[data-remove-draft]")?.addEventListener("click", () => {
      drafts = drafts.filter((item) => item !== draft);
      render();
    });
    card.querySelector("[data-post-draft]")?.addEventListener("click", () => postDraft(draft.id));
  }
  for (const card of slot.querySelectorAll("[data-annotation-id]")) {
    const index = store.annotations.findIndex((item) => item.id === card.dataset.annotationId);
    if (index < 0) continue;
    card.querySelector("select")?.addEventListener("change", (event) => {
      const annotations = store.annotations.slice();
      annotations[index] = { ...annotations[index], kind: normalizeKind(event.target.value) };
      saveAnnotations(annotations);
    });
    card.querySelector("textarea")?.addEventListener("input", (event) => {
      store.annotations[index].body = event.target.value;
      persistAnnotations(store.state, store.annotations);
    });
    card.querySelector("[data-remove-annotation]")?.addEventListener("click", () => {
      const item = store.annotations[index];
      if (item?.kind === "edit" && typeof item.after_block === "string") store.emit("undo-suggestion", item.id);
      else saveAnnotations(store.annotations.filter((_, itemIndex) => itemIndex !== index));
    });
    card.querySelector("[data-show-annotation]")?.addEventListener("click", () => {
      store.emit("focus", store.annotations[index]?.id);
    });
  }
}

function focusThread(value, emit = true) {
  const id = typeof value === "object" ? value?.id : value;
  for (const card of slot.querySelectorAll("[data-thread-id]")) card.classList.toggle("focused", card.dataset.threadId === String(id));
  const match = [...slot.querySelectorAll("[data-thread-id]")].find((card) => card.dataset.threadId === String(id));
  // Bring the selected card fully into the rail's view; "nearest" leaves a
  // card that is only partly visible where it is.
  if (match) {
    const rail = match.closest(".thread-list") || slot;
    const r = match.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    if (r.top < rr.top + 8 || r.bottom > rr.bottom - 8) match.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (emit && id && store.focusThread !== id) store.focusThread = id;
}

function kindSelect(kind) {
  return `<select aria-label="Remark kind">${KINDS.map(([value, label]) => `<option value="${value}"${normalizeKind(kind) === value ? " selected" : ""}>${label}</option>`).join("")}</select>`;
}

function quoteHtml(value) {
  return value ? `<p class="thread-quote">“${escapeHtml(value)}”</p>` : "";
}

/**
 * Word diff of a block, trimmed to the changed lines plus one line of context
 * so a one-line suggestion inside a long paragraph reads as that one line.
 */

function stageDirectory() {
  const viewedPath = store.view?.kind === "artifact" && typeof store.view.path === "string" ? store.view.path : "";
  if (viewedPath.includes("/")) return viewedPath.slice(0, viewedPath.lastIndexOf("/"));
  if (!viewedPath && typeof store.state?.current?.stage_dir === "string") return store.state.current.stage_dir;
  return null;
}

function hasOpenGate() {
  return store.state?.phase === "reviewing" && !decisionInFlight() && stageDirectory() === store.state.current?.stage_dir;
}

function normalizeDecision(value) {
  const text = String(typeof value === "object" ? value?.decision || value?.kind || "" : value || "").toLowerCase();
  if (text === "approve" || text === "approved") return "approve";
  if (text === "request-changes" || text === "request changes" || text === "reject" || text === "rejected") return "request-changes";
  return null;
}

function normalizeKind(value) {
  const text = String(value || "comment").toLowerCase();
  if (text.startsWith("edit") || text === "suggestion") return "edit";
  if (text === "delete") return "delete";
  if (text === "looks good" || text === "looks-good") return "looks-good";
  if (text === "label") return "comment";
  return "comment";
}

function kindLabel(kind) {
  return KINDS.find(([value]) => value === normalizeKind(kind))?.[1] || "Comment";
}

function basename(path) {
  return String(path || "").split("/").pop() || "artifact.md";
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function blockIndex(value) {
  if (Number.isInteger(value)) return value;
  if (Number.isInteger(value?.index)) return value.index;
  return undefined;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}


function escapeSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^\w-]/g, "\\$&");
}

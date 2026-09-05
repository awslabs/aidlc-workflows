import { api } from "./api.js";
import { persistAnnotations, setNotice, store } from "./store.js";

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
  drafts.push({
    id,
    kind: normalizeKind(payload.kind || "comment"),
    artifact: basename(selection.artifact || selection.path || store.document?.path || "artifact.md"),
    block: blockIndex(selection.block),
    selection: selection.text || selection.selection || "",
    line_start: numberOrUndefined(selection.line_start),
    line_end: numberOrUndefined(selection.line_end),
    heading_path: stringList(selection.heading_path),
    css_path: typeof selection.css_path === "string" ? selection.css_path : undefined,
    body: "",
  });
  if (store.panel !== "threads") store.set({ panel: "threads" });
  else render();
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
  if (decision === "request-changes") {
    noteEditor = "decision";
    if (store.panel !== "threads") store.set({ panel: "threads" });
    else render();
    requestAnimationFrame(() => slot.querySelector("#decision-notes")?.focus());
    return;
  }
  void sendDecision(decision, generalNote);
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
      clearPending();
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
  for (const key of ["selection", "css_path", "body"]) {
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
      ${pending.length || drafts.length ? `<p class="threads-pending-line"><b>${pending.length + drafts.length} pending</b> · sends with your decision (Approve / Request changes, top right)</p>` : ""}
      <div class="thread-list">${renderThreadList()}</div>
    </section>`;
  bindThreads();
  void ensureRemoteThreads();
  focusThread(store.focusThread, false);
}

function renderNoteEditor() {
  if (!noteEditor) return generalNote ? `<p class="general-note-preview"><b>General note</b>${escapeHtml(generalNote)}</p>` : "";
  const deciding = noteEditor === "decision";
  return `<form class="decision-note-form">
    <label for="decision-notes">${deciding ? "Request changes" : "General note"}<span>${deciding ? "Optional — include context for the agent." : "Sent with your decision."}</span></label>
    <textarea id="decision-notes" rows="3" placeholder="What should the agent know?">${escapeHtml(generalNote)}</textarea>
    <div><button class="btn" data-note-cancel type="button">Cancel</button><button class="btn primary" type="submit" ${sending ? "disabled" : ""}>${deciding ? "Send request" : "Save note"}</button></div>
  </form>`;
}

function renderThreadList() {
  const cards = [
    ...drafts.map(renderDraft),
    ...store.annotations.map(renderPending),
    ...sortedSentThreads().map(renderSent),
    ...summaryThreads.map(renderSummary),
  ].filter(Boolean);
  if (cards.length) return cards.join("");
  if (remoteLoading) return `<p class="threads-empty">Loading threads…</p>`;
  if (!hasOpenGate()) return `<p class="threads-empty">No threads yet · comments open at the approval gate</p>`;
  if (remarksMode === "unavailable") return `<p class="threads-empty"><b>Threads are not available yet.</b>The document remains reviewable. Pending remarks will stay here until you decide.</p>`;
  if (store.view?.readOnly) return `<p class="threads-empty"><b>No threads for this artifact.</b>This past artifact is read-only; return to the current stage to review.</p>`;
  return `<p class="threads-empty"><b>No threads yet.</b>Select text in the document to add a remark. Nothing sends until you decide.</p>`;
}

function sortedSentThreads() {
  const visible = sentThreads.filter((thread) => showResolved || statusFor(thread).name !== "Resolved");
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
    <p class="thread-status pending">Pending · sends with your decision</p>
  </article>`;
}

function renderPending(annotation) {
  const isEdit = annotation.kind === "edit";
  return `<article class="thread-card pending-card" data-annotation-id="${escapeHtml(annotation.id)}" data-thread-id="${escapeHtml(annotation.id)}">
    ${quoteHtml(annotation.selection)}
    <div class="thread-editor-row">${kindSelect(annotation.kind)}<span>You · just now</span></div>
    ${isEdit && annotation.before !== undefined && annotation.after_block !== undefined ? `<div class="thread-diff">${focusedDiffHtml(annotation.before, annotation.after_block)}</div>` : ""}
    <textarea rows="2" placeholder="${isEdit ? "Reason (optional)" : "Write a remark…"}">${escapeHtml(annotation.body || "")}</textarea>
    <div class="thread-card-actions"><button data-remove-annotation type="button">Remove</button></div>
    <p class="thread-status pending">Pending · sends with your decision</p>
  </article>`;
}

function renderSent(thread) {
  const status = statusFor(thread);
  return `<article class="thread-card sent-card" data-thread-id="${escapeHtml(thread.id)}">
    ${quoteHtml(thread.quote)}
    <div class="thread-who"><span class="thread-avatar">Y</span><b>You</b><span>r${thread.revision}</span><span class="thread-kind">${kindLabel(thread.kind)}</span></div>
    ${thread.diff ? `<div class="thread-sent-diff">${renderRemarkDiff(thread.diff)}</div>` : thread.body ? `<p class="thread-body">${escapeHtml(thread.body)}</p>` : ""}
    ${renderReply(thread.response)}
    <p class="thread-status ${status.className}">${status.name}${status.detail ? ` · ${escapeHtml(status.detail)}` : ""}</p>
  </article>`;
}

function renderReply(response) {
  if (!response) return "";
  const verb = response.status === "applied" ? "Applied" : response.status === "kept" ? "Kept" : "Answered";
  return `<div class="thread-reply"><div class="thread-who"><span class="thread-avatar agent">A</span><b>Product Agent</b><span>r${response.revision}</span></div><p><b>${verb}${response.text ? ":" : "."}</b>${response.text ? ` ${escapeHtml(response.text)}` : ""}</p></div>`;
}

function renderSummary(summary) {
  const count = Number.isInteger(summary.count) ? summary.count : 0;
  return `<article class="thread-card summary-card">
    <p><b>${count} ${count === 1 ? "remark" : "remarks"} sent in r${summary.revision}</b></p>
    <span>${escapeHtml(summary.file || "Feedback")}</span>
    ${summary.replies.length ? `<div class="summary-replies">${summary.replies.map((reply) => `<p><b>Product Agent · r${reply.revision}</b> · ${escapeHtml(reply.status)}${reply.text ? ` — ${escapeHtml(reply.text)}` : ""}</p>`).join("")}</div>` : ""}
  </article>`;
}

function statusFor(thread) {
  if (thread.response?.status === "applied" || thread.response?.status === "answered") {
    return { name: `Addressed in r${thread.response.revision}`, className: "addressed", detail: "" };
  }
  if (thread.response?.status === "kept") return { name: "Open", className: "open", detail: `kept in r${thread.response.revision}` };
  if (thread.kind === "looks-good") return { name: "Resolved", className: "resolved", detail: "" };
  return { name: "Open", className: "open", detail: "" };
}

function renderRemarkDiff(value) {
  const lines = String(value).split("\n");
  const parts = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].startsWith("-") && !lines[index].startsWith("---")) {
      const removed = [];
      while (index < lines.length && lines[index].startsWith("-") && !lines[index].startsWith("---")) removed.push(lines[index++].slice(1));
      const added = [];
      while (index < lines.length && lines[index].startsWith("+") && !lines[index].startsWith("+++")) added.push(lines[index++].slice(1));
      if (added.length) parts.push(`<div class="remark-word-diff">${wordDiffHtml(removed.join("\n"), added.join("\n"))}</div>`);
      else parts.push(`<div class="remark-word-diff"><del>${escapeHtml(removed.join("\n"))}</del></div>`);
      continue;
    }
    if (lines[index].startsWith("+") && !lines[index].startsWith("+++")) {
      const added = [];
      while (index < lines.length && lines[index].startsWith("+") && !lines[index].startsWith("+++")) added.push(lines[index++].slice(1));
      parts.push(`<div class="remark-word-diff"><ins>${escapeHtml(added.join("\n"))}</ins></div>`);
      continue;
    }
    if (lines[index] && !/^```/.test(lines[index]) && !/^(---|\+\+\+|@@)/.test(lines[index])) parts.push(`<div class="remark-context">${escapeHtml(lines[index])}</div>`);
    index += 1;
  }
  return parts.join("");
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
    else {
      noteEditor = null;
      render();
    }
  });
  slot.querySelector("[data-note-cancel]")?.addEventListener("click", () => {
    noteEditor = null;
    render();
  });

  for (const card of slot.querySelectorAll("[data-thread-id]")) card.addEventListener("click", (event) => {
    if (event.target.closest("button, textarea, select")) return;
    const id = card.dataset.threadId;
    store.set({ focusThread: id });
    store.emit("focus", id);
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
      saveAnnotations(store.annotations.filter((_, itemIndex) => itemIndex !== index));
    });
  }
}

function focusThread(value, emit = true) {
  const id = typeof value === "object" ? value?.id : value;
  for (const card of slot.querySelectorAll("[data-thread-id]")) card.classList.toggle("focused", card.dataset.threadId === String(id));
  const match = [...slot.querySelectorAll("[data-thread-id]")].find((card) => card.dataset.threadId === String(id));
  match?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
function focusedDiffHtml(before, after) {
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const from = Math.max(0, head - 1);
  const leftSlice = a.slice(from, a.length - Math.max(0, tail - 1));
  const rightSlice = b.slice(from, b.length - Math.max(0, tail - 1));
  const prefix = from > 0 ? '<span class="diff-ellipsis">…</span>\n' : "";
  const suffix = tail > 1 ? '\n<span class="diff-ellipsis">…</span>' : "";
  return `${prefix}${wordDiffHtml(leftSlice.join("\n"), rightSlice.join("\n"))}${suffix}`;
}

function wordDiffHtml(before, after) {
  const left = tokens(String(before));
  const right = tokens(String(after));
  if (left.length * right.length > 40_000) return `<del>${escapeHtml(before)}</del><ins>${escapeHtml(after)}</ins>`;
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      parts.push(escapeHtml(left[i])); i += 1; j += 1;
    } else if (j < right.length && (i === left.length || rows[i][j + 1] > rows[i + 1][j])) {
      parts.push(`<ins>${escapeHtml(right[j])}</ins>`); j += 1;
    } else {
      parts.push(`<del>${escapeHtml(left[i])}</del>`); i += 1;
    }
  }
  return parts.join("");
}

function tokens(value) {
  return value.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

function stageDirectory() {
  const viewedPath = store.view?.kind === "artifact" && typeof store.view.path === "string" ? store.view.path : "";
  if (viewedPath.includes("/")) return viewedPath.slice(0, viewedPath.lastIndexOf("/"));
  if (!viewedPath && typeof store.state?.current?.stage_dir === "string") return store.state.current.stage_dir;
  return null;
}

function hasOpenGate() {
  return store.state?.current?.state === "awaiting-approval" && stageDirectory() === store.state.current.stage_dir;
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function escapeSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^\w-]/g, "\\$&");
}

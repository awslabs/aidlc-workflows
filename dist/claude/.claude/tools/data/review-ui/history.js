import { api } from "./api.js";
import { store } from "./store.js";

const slot = document.getElementById("slot");
let entries = [];
let loading = false;
let loadKey = null;
let loadSequence = 0;
let selectedRevision = null;
let diffVisible = false;
let diffText = "";
let errorMessage = "";

export function init() {
  store.on("panel", render);
  store.on("state", () => {
    loadKey = null;
    render();
  });
  store.on("refresh", () => {
    loadKey = null;
    render();
  });
  store.on("document", () => {
    loadKey = null;
    render();
  });
  store.on("annotations", () => {
    if (store.panel === "outline") render();
  });
}

function render() {
  if (store.panel === "history") renderHistory();
  else if (store.panel === "outline") renderOutline();
}

function renderHistory() {
  slot.dataset.panel = "history";
  slot.innerHTML = `
    <section class="history-panel" aria-labelledby="history-title">
      <header class="side-panel-header">
        <div><h2 id="history-title">Version history</h2><span>· ${entries.length} ${entries.length === 1 ? "entry" : "entries"} ·</span><button class="side-panel-close" type="button" aria-label="Close version history">×</button></div>
        <div class="history-compare"><span>Compare</span>${compareSegment()}</div>
      </header>
      <div class="history-body">${historyContent()}</div>
    </section>`;
  bindHistory();
  void loadHistory();
}

function compareSegment() {
  const revisions = revisionNumbers();
  const current = currentRevision();
  const from = revisions.find((revision) => revision !== current) ?? Math.max(0, current - 1);
  return `<span class="history-segment"><button data-revision="${from}" class="${selectedRevision === from && !diffVisible ? "on" : ""}" type="button">r${from}</button><button data-revision="${current}" class="${selectedRevision === current && !diffVisible ? "on" : ""}" type="button">r${current}</button><button data-diff type="button" class="${diffVisible ? "on" : ""}">Diff</button></span>`;
}

function historyContent() {
  if (diffVisible) {
    if (!diffText && loading) return `<p class="side-panel-empty">Loading diff…</p>`;
    if (!diffText && errorMessage) return `<p class="side-panel-empty"><b>Diff is not available yet.</b>${escapeHtml(errorMessage)}</p>`;
    return `<div class="history-diff" aria-label="Unified diff">${renderUnifiedDiff(diffText)}</div>`;
  }
  if (loading && !entries.length) return `<p class="side-panel-empty">Loading version history…</p>`;
  if (errorMessage && !entries.length) return `<p class="side-panel-empty"><b>Version history is not available yet.</b>The document remains reviewable while the daemon route catches up.</p>`;
  if (!entries.length) return `<p class="side-panel-empty"><b>No history yet.</b>Revisions, feedback, answers, decisions and responses will appear here as record files are written.</p>`;
  return `<div class="history-list">${entries.map(renderEntry).join("")}<p class="history-help">Open a revision to read it, or choose <button data-diff type="button">show r${revisionNumbers()[0] ?? 0} → r${currentRevision()} inline</button>.</p></div>`;
}

function renderEntry(entry) {
  const revision = Number.isInteger(entry.revision) ? entry.revision : null;
  const active = revision !== null && selectedRevision === revision;
  const title = entryTitle(entry);
  const delta = Number.isFinite(entry.chars_delta) ? signed(entry.chars_delta) : "";
  return `<button class="history-entry ${active ? "on" : ""}" type="button" ${entry.kind === "revision" && revision !== null ? `data-open-revision="${revision}"` : "disabled"}>
    <span class="history-entry-title"><b>${escapeHtml(title)}</b><time>${formatTime(entry.at)}</time></span>
    <span class="history-entry-detail"><span>${entry.by === "you" ? "You" : "Product Agent"}</span>${delta ? `<span class="history-delta">${escapeHtml(delta)} chars</span>` : ""}</span>
    <span class="history-entry-summary">${escapeHtml(entry.summary || defaultSummary(entry.kind))}</span>
    <span class="history-entry-kind ${escapeHtml(entry.kind)}">${kindLabel(entry.kind)}</span>
  </button>`;
}

function entryTitle(entry) {
  if (entry.kind === "revision" && Number.isInteger(entry.revision)) return `r${entry.revision} · ${entry.file || basename(store.document?.path)}`;
  return `${entry.by === "you" ? "You" : "Product Agent"} · ${entry.file || kindLabel(entry.kind)}`;
}

function bindHistory() {
  slot.querySelector(".side-panel-close")?.addEventListener("click", () => store.set({ panel: null }));
  for (const button of slot.querySelectorAll("[data-revision]")) button.addEventListener("click", () => void openRevision(Number(button.dataset.revision)));
  for (const button of slot.querySelectorAll("[data-open-revision]")) button.addEventListener("click", () => void openRevision(Number(button.dataset.openRevision)));
  for (const button of slot.querySelectorAll("[data-diff]")) button.addEventListener("click", () => void showDiff());
}

async function loadHistory() {
  const stageDir = stageDirectory();
  if (!stageDir) return;
  const key = `${store.view?.intent || ""}:${stageDir}:${currentRevision()}`;
  if (loading || loadKey === key) return;
  loading = true;
  loadKey = key;
  errorMessage = "";
  const sequence = ++loadSequence;
  renderHistory();
  try {
    const result = await api.get("/api/history", { stage_dir: stageDir, intent: store.view?.intent || undefined });
    if (sequence !== loadSequence) return;
    entries = Array.isArray(result.entries) ? result.entries : [];
  } catch (error) {
    if (sequence !== loadSequence) return;
    entries = [];
    errorMessage = error.message;
  } finally {
    if (sequence === loadSequence) {
      loading = false;
      if (store.panel === "history") renderHistory();
    }
  }
}

async function openRevision(revision) {
  if (!Number.isInteger(revision)) return;
  const stageDir = stageDirectory();
  const file = basename(store.document?.path);
  if (!stageDir || !file) return;
  loading = true;
  errorMessage = "";
  selectedRevision = revision;
  diffVisible = false;
  renderHistory();
  try {
    const result = await api.get("/api/snapshot", {
      stage_dir: stageDir,
      revision,
      file,
      intent: store.view?.intent || undefined,
    });
    const source = typeof result.source === "string" ? result.source : "";
    store.emit("show-snapshot", { revision, source });
    renderSnapshotFallback(revision, source);
  } catch (error) {
    errorMessage = error.message;
  } finally {
    loading = false;
    if (store.panel === "history" && !slot.querySelector(".snapshot-fallback")) renderHistory();
  }
}

function renderSnapshotFallback(revision, source) {
  const body = slot.querySelector(".history-body");
  if (!body) return;
  body.innerHTML = `<div class="snapshot-fallback"><p><b>r${revision} · read-only snapshot</b><button data-back-history type="button">Back to history</button></p><pre>${escapeHtml(source || "This snapshot is empty.")}</pre></div>`;
  body.querySelector("[data-back-history]")?.addEventListener("click", () => {
    selectedRevision = null;
    renderHistory();
  });
}

async function showDiff() {
  if (!store.document?.path) return;
  diffVisible = true;
  diffText = "";
  errorMessage = "";
  loading = true;
  renderHistory();
  try {
    const revisions = revisionNumbers();
    const current = currentRevision();
    const from = revisions.find((revision) => revision !== current) ?? Math.max(0, current - 1);
    const result = await api.get("/api/diff", {
      path: store.document.path,
      from,
      to: "current",
      intent: store.view?.intent || undefined,
    });
    diffText = typeof result.unified === "string" ? result.unified : hunksToUnified(result.hunks);
  } catch (error) {
    errorMessage = error.message;
  } finally {
    loading = false;
    if (store.panel === "history") renderHistory();
  }
}

function renderUnifiedDiff(value) {
  if (!value) return `<p class="side-panel-empty">No changes between these revisions.</p>`;
  return String(value).split("\n").map((line) => {
    const className = line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "delete" : "context";
    return `<div class="diff-${className}">${escapeHtml(line || " ")}</div>`;
  }).join("");
}

function hunksToUnified(hunks) {
  if (!Array.isArray(hunks)) return "";
  return hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...(hunk.lines || []).map((line) => `${line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}${line.text}`),
  ]).join("\n");
}

function renderOutline() {
  slot.dataset.panel = "outline";
  const outline = Array.isArray(store.document?.outline) ? store.document.outline : [];
  slot.innerHTML = `
    <section class="outline-panel" aria-labelledby="outline-title">
      <header class="side-panel-header"><div><h2 id="outline-title">Outline</h2><span>${escapeHtml(basename(store.document?.path) || "Document")}</span><button class="side-panel-close" type="button" aria-label="Close outline">×</button></div></header>
      ${outline.length ? `<nav class="outline-list">${outline.map((heading, index) => renderHeading(heading, index, outline)).join("")}</nav>` : `<p class="side-panel-empty"><b>No outline available.</b>Headings will appear when the document is ready.</p>`}
    </section>`;
  slot.querySelector(".side-panel-close")?.addEventListener("click", () => store.set({ panel: null }));
  for (const button of slot.querySelectorAll("[data-outline-id]")) button.addEventListener("click", () => store.emit("scroll-to", button.dataset.outlineId));
}

function renderHeading(heading, index, outline) {
  const count = sectionThreadCount(heading, index, outline);
  const level = Math.max(1, Math.min(6, Number(heading.level) || 1));
  return `<button type="button" class="outline-heading level-${level}" data-outline-id="${escapeHtml(heading.id || String(index))}"><span>${escapeHtml(heading.text || "Untitled section")}</span>${count ? `<b>${count}</b>` : ""}</button>`;
}

function sectionThreadCount(heading, index, outline) {
  const block = headingBlock(heading);
  const next = outline.slice(index + 1).find((candidate) => Number(candidate.level) <= Number(heading.level));
  const end = next ? headingBlock(next) : Number.MAX_SAFE_INTEGER;
  return store.annotations.filter((annotation) => {
    const annotationBlock = Number.isInteger(annotation.block) ? annotation.block : blockForLine(annotation.line_start);
    return annotationBlock >= block && annotationBlock < end;
  }).length;
}

function headingBlock(heading) {
  if (Number.isInteger(heading.block)) return heading.block;
  if (Number.isInteger(heading.block?.index)) return heading.block.index;
  return blockForLine(heading.line_start);
}

function blockForLine(line) {
  if (!Number.isInteger(line)) return Number.MAX_SAFE_INTEGER;
  const blocks = Array.isArray(store.document?.blocks) ? store.document.blocks : [];
  const found = blocks.find((block) => line >= block.line_start && line <= block.line_end);
  return found?.index ?? Number.MAX_SAFE_INTEGER;
}

function revisionNumbers() {
  const revisions = entries.filter((entry) => entry.kind === "revision" && Number.isInteger(entry.revision)).map((entry) => entry.revision);
  if (!revisions.includes(currentRevision())) revisions.push(currentRevision());
  return [...new Set(revisions)].sort((left, right) => left - right);
}

function currentRevision() {
  return Number.isInteger(store.state?.current?.revision) ? store.state.current.revision : 0;
}

function stageDirectory() {
  if (typeof store.state?.current?.stage_dir === "string") return store.state.current.stage_dir;
  const path = store.document?.path;
  return typeof path === "string" && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
}

function defaultSummary(kind) {
  return ({ revision: "revision written", feedback: "your feedback", answers: "answers saved", decision: "decision recorded", responses: "feedback addressed" })[kind] || kind;
}

function kindLabel(kind) {
  return ({ revision: "revision", feedback: "feedback", answers: "question round", decision: "decision", responses: "responses" })[kind] || kind;
}

function signed(number) {
  return `${number > 0 ? "+" : ""}${new Intl.NumberFormat().format(number)}`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function basename(path) {
  return String(path || "").split("/").pop() || "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

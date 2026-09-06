// Markdown document rendering, anchored pending feedback, and in-place suggestions.
import { api } from "./api.js";
import { wordDiffHtml } from "./diff.js";
import { agentFor, decisionInFlight, store } from "./store.js";

const elements = {};
let loadVersion = 0;
let activeEdit = null;
let htmlFrame = null;
const reservedAnnotationIds = new Set();
const editIds = new Map();

export function init() {
  elements.main = document.getElementById("main");
  elements.viewer = document.getElementById("viewer");
  elements.empty = document.getElementById("empty");
  elements.toolbar = buildToolbar();
  elements.main.insertBefore(elements.toolbar, elements.viewer);

  elements.viewer.addEventListener("mouseup", captureSelection);
  elements.viewer.addEventListener("keyup", (event) => {
    if (!event.shiftKey && !/^(Shift|Arrow|Home|End)/.test(event.key)) return;
    const anchor = elementForNode(window.getSelection()?.anchorNode);
    if (anchor) captureSelection({ target: anchor });
  });
  elements.viewer.addEventListener("click", handleViewerClick);
  elements.viewer.addEventListener("focusin", handleBlockFocus);
  elements.viewer.addEventListener("beforeinput", handleBeforeInput);
  elements.viewer.addEventListener("input", handleBlockInput);
  elements.viewer.addEventListener("focusout", handleBlockBlur);
  elements.viewer.addEventListener("keydown", handleEditorKey);
  document.addEventListener("keydown", handleSelectionKey);
  window.addEventListener("message", receiveHtmlAnchor);

  store.on("view", renderView);
  store.on("inlineDiff", (payload) => {
    inlineDiff = payload && payload.path === store.document?.path ? payload : null;
    applyInlineDiff();
  });
  store.on("refresh", () => {
    if (store.view.kind === "artifact") loadArtifact(store.view);
    else if (store.view.kind === "empty") renderEmpty();
  });
  store.on("remarks", applyAnnotations);
  store.on("annotations", applyAnnotations);
  store.on("selection", showSelectionAffordance);
  store.on("focus", focusAnnotation);
  store.on("scroll-to", scrollToHeading);
  store.on("state", () => {
    if (store.view.kind === "empty") renderEmpty();
  });

  renderView(store.view);
}

function renderView(view) {
  hideToolbar();
  activeEdit = null;
  htmlFrame = null;
  if (view.kind === "artifact" && view.path) {
    elements.empty.hidden = true;
    elements.viewer.hidden = false;
    loadArtifact(view);
    return;
  }
  elements.viewer.hidden = true;
  if (view.kind === "empty") renderEmpty();
  else elements.empty.hidden = true;
}

async function loadArtifact(view) {
  const version = ++loadVersion;
  elements.viewer.hidden = false;
  elements.viewer.className = "viewer document-loading";
  elements.viewer.textContent = "Rendering document…";
  hideToolbar();
  activeEdit = null;
  try {
    const rendered = formatFromPath(view.path) === "html"
      ? await api.get("/api/artifact", {
          path: view.path,
          intent: view.intent || undefined,
        })
      : await api.get("/api/render", {
          path: view.path,
          intent: view.intent || undefined,
        });
    if (version !== loadVersion || store.view.kind !== "artifact" || store.view.path !== view.path) return;
    const outline = Array.isArray(rendered.headings)
      ? rendered.headings.map((heading) => ({
          level: Number(heading.level),
          text: String(heading.text || ""),
          id: String(heading.id || ""),
          block: Number(heading.block),
        }))
      : [];
    const documentState = {
      path: String(rendered.path || view.path),
      sha256: String(rendered.sha256 || ""),
      source: typeof rendered.source === "string" ? rendered.source : "",
      blocks: Array.isArray(rendered.blocks) ? rendered.blocks : [],
      outline,
      format: rendered.format || formatFromPath(view.path),
      mtime: rendered.mtime || null,
    };
    store.set({ document: documentState, selection: null });
    if (documentState.format === "html") renderHtml(documentState, view);
    else renderMarkdown(documentState, view);
  } catch (error) {
    if (version !== loadVersion) return;
    store.set({ document: null, selection: null });
    elements.viewer.className = "viewer document-placeholder";
    elements.viewer.textContent =
      error?.status === 404 ? "rendering route unavailable" : `Unable to render this document: ${error.message}`;
  }
}

function renderMarkdown(doc, view) {
  htmlFrame = null;
  elements.viewer.className = "viewer markdown-document";
  elements.viewer.replaceChildren();
  elements.viewer.dataset.path = doc.path;
  elements.viewer.dataset.readOnly = String(isReadOnly(view));

  const page = document.createElement("div");
  page.className = "document-page";
  if (isReadOnly(view)) page.append(buildReadOnlyBanner(doc, view));
  page.append(buildDocumentMeta(doc, view));

  const blocks = document.createElement("div");
  blocks.className = "document-blocks";
  for (const block of doc.blocks) blocks.append(buildBlock(block, view));
  page.append(blocks);
  elements.viewer.append(page);
  idleToolbar();
  assignHeadingIds(doc);
  applyAnnotations();
  applyInlineDiff();
}

// History's "show r0 → r1 inline": every hunk becomes a word diff under the
// block it changed, in the reading column, instead of a raw patch in the rail.
let inlineDiff = null;

function applyInlineDiff() {
  for (const node of elements.viewer.querySelectorAll(".blk-diff")) node.remove();
  for (const block of elements.viewer.querySelectorAll(".blk.changed")) block.classList.remove("changed");
  if (!inlineDiff || inlineDiff.path !== store.document?.path) return;
  const blocks = [...elements.viewer.querySelectorAll(".blk")];
  let first = null;
  for (const [index, hunk] of inlineDiff.hunks.entries()) {
    const target = blocks.find((block) => Number(block.dataset.lineEnd) >= hunk.afterStart && Number(block.dataset.lineStart) <= Math.max(hunk.afterStart, hunk.afterEnd))
      || blocks.find((block) => Number(block.dataset.lineStart) >= hunk.afterStart)
      || blocks.at(-1);
    if (!target) continue;
    const before = hunk.removed.join("\n");
    const after = hunk.added.join("\n");
    const panel = document.createElement("div");
    panel.className = "blk-diff";
    panel.dataset.hunk = String(index);
    panel.innerHTML = `<span class="blk-diff-label">r${inlineDiff.from} → r${inlineDiff.to}</span><div class="blk-diff-body">${
      before && after ? wordDiffHtml(before, after) : before ? `<del>${escapeHtml(before)}</del>` : `<ins>${escapeHtml(after)}</ins>`
    }</div>`;
    target.classList.add("changed");
    target.append(panel);
    first ??= target;
  }
  if (first && inlineDiff.scroll) {
    first.scrollIntoView({ block: "center", behavior: "smooth" });
    inlineDiff.scroll = false;
  }
}

function buildBlock(block, view) {
  const wrapper = document.createElement("div");
  wrapper.className = "blk";
  wrapper.dataset.block = String(block.index);
  wrapper.dataset.lineStart = String(block.line_start);
  wrapper.dataset.lineEnd = String(block.line_end);

  const gutter = document.createElement("div");
  gutter.className = "gutter";
  gutter.setAttribute("aria-hidden", "true");

  const content = document.createElement("div");
  content.className = "blk-content";
  content.innerHTML = String(block.html || "");
  if (isLiveGate(view)) {
    content.contentEditable = "plaintext-only";
    content.spellcheck = true;
    content.setAttribute("aria-label", `Suggest an edit to lines ${block.line_start}–${block.line_end}`);
  }

  wrapper.append(gutter, content);
  return wrapper;
}

function buildDocumentMeta(doc, view) {
  const meta = document.createElement("div");
  meta.className = "document-meta";
  const provenance = document.createElement("span");
  const revision = store.state?.manifest?.revision ?? store.state?.current?.revision;
  const when = relativeTime(doc.mtime || store.state?.manifest?.opened_at || store.state?.current?.updated_at);
  provenance.textContent = `${agentFor(doc.path, view.stage)}${revision === null || revision === undefined ? "" : ` · revision ${revision}`}${when ? ` · ${when}` : ""}`;
  meta.append(provenance);
  if (isLiveGate(view)) {
    const hint = document.createElement("span");
    hint.textContent = "Type anywhere — a change is a suggestion until you decide";
    meta.append(hint);
  }
  return meta;
}

function buildReadOnlyBanner(doc, view) {
  const banner = document.createElement("div");
  banner.className = "read-only-banner";
  const stage = stageForArtifact(doc.path, view.stage);
  const label = stage?.name || humanize(view.stage || store.state?.current_stage || "stage");
  if (stage?.state === "current" && stage.gate === "revising") {
    banner.classList.add("in-progress-banner");
    banner.innerHTML = `<b>Revising</b><span></span>`;
    banner.querySelector("span").textContent = `· the agent is addressing your feedback on ${label}; your remarks stay in Threads and the gate reopens with the next revision`;
    return banner;
  }
  if (stage?.state === "current") {
    banner.classList.add("in-progress-banner");
    banner.innerHTML = `<b>In progress</b><span></span>`;
    banner.querySelector("span").textContent = `· ${label} is still running — read along; comments open at the approval gate`;
    return banner;
  }
  const finished = relativeTime(stage?.decided_at || doc.mtime);
  banner.innerHTML = `<b>Done stage</b><span></span>`;
  banner.querySelector("span").textContent = `· ${label} finished${finished ? ` ${finished}` : ""} · read-only; comments become notes on the record`;
  return banner;
}

function renderHtml(doc, view) {
  elements.viewer.className = "viewer html-document";
  elements.viewer.replaceChildren();
  elements.viewer.dataset.path = doc.path;
  elements.viewer.dataset.readOnly = String(isReadOnly(view));
  if (isReadOnly(view)) elements.viewer.append(buildReadOnlyBanner(doc, view));
  elements.viewer.append(buildDocumentMeta(doc, view));
  const frame = document.createElement("iframe");
  frame.className = "artifact-frame";
  frame.title = basename(doc.path);
  frame.sandbox = "allow-scripts";
  frame.src = api.url("/api/raw", { path: doc.path, intent: view.intent || undefined });
  htmlFrame = frame;
  elements.viewer.append(frame);
}

function receiveHtmlAnchor(event) {
  if (!htmlFrame || event.source !== htmlFrame.contentWindow || event.data?.type !== "aidlc-anchor") return;
  const message = event.data;
  const text = typeof message.selection === "string" ? message.selection.slice(0, 4000) : "";
  const cssPath = typeof message.css_path === "string" ? message.css_path.slice(0, 500) : undefined;
  const headingPath = Array.isArray(message.heading_path)
    ? message.heading_path.filter((part) => typeof part === "string").slice(0, 12)
    : [];
  if (!text && !cssPath) return;
  const selection = {
    artifact: basename(store.view.path || ""),
    path: store.view.path,
    block: null,
    text,
    selection: text,
    css_path: cssPath,
    heading_path: headingPath,
  };
  store.set({ selection });
  emitCompose("comment", selection);
}

function captureSelection(event) {
  if (htmlFrame || event.target.closest(".gutter, .selection-add, .document-toolbar")) return;
  if (activeEdit?.armed && activeEdit.content.contains(event.target)) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    store.set({ selection: null });
    return;
  }
  const range = selection.getRangeAt(0);
  const start = elementForNode(range.startContainer)?.closest(".blk");
  const end = elementForNode(range.endContainer)?.closest(".blk");
  if (!start || start !== end || !start.contains(event.target)) {
    store.set({ selection: null });
    return;
  }
  const block = blockData(start);
  if (!block) return;
  const text = selection.toString().trim();
  const lines = selectedLines(block, text);
  const descriptor = {
    artifact: basename(store.document?.path || store.view.path || ""),
    path: store.document?.path || store.view.path,
    block: Number(block.index),
    text,
    selection: text,
    line_start: lines.line_start,
    line_end: lines.line_end,
    heading_path: headingPath(Number(block.index)),
  };
  store.set({ selection: descriptor });
}

function showSelectionAffordance(selection) {
  elements.viewer?.querySelectorAll(".selection-add").forEach((button) => {
    button.remove();
  });
  if (!selection || store.view.kind !== "artifact" || selection.block === null || selection.block === undefined) return;
  const block = blockElement(selection.block);
  if (!block) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "selection-add";
  button.textContent = "+";
  button.title = "Comment on selection (C)";
  button.setAttribute("aria-label", "Comment on selected text");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => emitCompose("comment", selection));
  block.append(button);
}

function handleSelectionKey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
  if (!store.selection || store.view.kind !== "artifact") return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  if (activeEdit) return;
  const key = event.key.toLowerCase();
  const kind = key === "c" ? "comment" : key === "d" ? "delete" : key === "g" ? "looks-good" : null;
  if (!kind) return;
  event.preventDefault();
  emitCompose(kind, store.selection);
}

function emitCompose(kind, selection) {
  const id = nextAnnotationId();
  const payload = { id, kind, ...selection, selection };
  store.emit("compose", payload);
  store.set({ selection: null });
  window.getSelection()?.removeAllRanges();
}

function handleViewerClick(event) {
  const anchor = event.target.closest("[data-annotation], [data-remark]");
  if (!anchor) return;
  const id = anchor.dataset.annotation || anchor.dataset.remark;
  if (!id) return;
  store.set({ focusThread: id });
  store.emit("focus", id);
}

function applyAnnotations() {
  const doc = store.document;
  if (!doc || store.view.kind !== "artifact" || doc.format === "html" || !elements.viewer) return;
  const annotations = pendingAnnotations();
  const remarks = sentRemarks();
  for (const block of doc.blocks) {
    const wrapper = blockElement(block.index);
    if (!wrapper || wrapper.classList.contains("editing")) continue;
    const content = wrapper.querySelector(".blk-content");
    content.innerHTML = String(block.html || "");
    wrapper.classList.remove("has-suggestion");
    wrapper.querySelector(".gutter").replaceChildren();
  }
  for (const annotation of annotations) reservedAnnotationIds.add(annotation.id);
  assignHeadingIds(doc);
  const marks = [
    ...annotations.map((annotation) => ({ item: annotation, sent: false })),
    ...remarks.map((remark) => ({ item: remark, sent: true })),
  ];
  // Bunsho's gutter shows one bubble per line with the number of threads on
  // it, not a running index — so a block with three remarks reads "3".
  const perBlock = new Map();
  for (const { item, sent } of marks) {
    const kind = annotationKind(item.kind);
    const quote = remarkQuote(item, sent);
    const block = sent ? remarkBlock(item, quote) : annotationBlock(item);
    if (!block || block.classList.contains("editing")) continue;
    const content = block.querySelector(".blk-content");
    let marked = quote ? markText(content, quote, kind, item.id, sent) : false;
    if (!marked && sent && kind === "suggestion") {
      const blockText = content.textContent.trim();
      marked = Boolean(blockText) && markText(content, blockText, kind, item.id, true);
    }
    if (!marked && kind === "suggestion") block.classList.add("has-suggestion");
    if (!perBlock.has(block)) perBlock.set(block, []);
    perBlock.get(block).push({ item, sent, kind });
  }
  for (const [block, entries] of perBlock) {
    const first = entries[0];
    const pending = entries.filter((entry) => !entry.sent).length;
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = `bubble ${first.kind}${pending ? "" : " sent"}`;
    bubble.dataset[first.sent ? "remark" : "annotation"] = first.item.id;
    bubble.textContent = String(entries.length);
    const summary = entries.map((entry) => `${kindLabel(entry.kind)}${entry.sent ? ` (r${entry.item.revision ?? "?"})` : " (pending)"}`).join(", ");
    bubble.title = `${entries.length} ${entries.length === 1 ? "thread" : "threads"} · ${summary}`;
    bubble.setAttribute("aria-label", bubble.title);
    block.querySelector(".gutter").append(bubble);
  }
  showSelectionAffordance(store.selection);
}

function sentRemarks() {
  const currentPath = store.document?.path || store.view.path || "";
  const file = basename(currentPath);
  return (Array.isArray(store.remarks) ? store.remarks : []).filter((remark) => {
    if (!remark?.id || !remark.artifact) return false;
    return remark.artifact === file || remark.artifact === currentPath;
  });
}

function remarkQuote(remark, sent) {
  const direct = remark.selection || remark.text || remark.quote;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (!sent || annotationKind(remark.kind) !== "suggestion" || typeof remark.diff !== "string") return "";
  for (const line of remark.diff.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^-(?!---)/.test(line) && line.slice(1).trim()) return line.slice(1).trim();
  }
  return "";
}

function remarkBlock(remark, quote) {
  const blocks = [...elements.viewer.querySelectorAll(".blk")];
  const candidates = blocks.filter((block) => {
    return quote && block.querySelector(".blk-content")?.textContent.includes(quote);
  });
  const wanted = Array.isArray(remark.heading_path) ? remark.heading_path.filter(Boolean) : [];
  if (candidates.length) {
    if (!wanted.length) return candidates[0];
    return candidates.find((block) => headingPathsMatch(headingPath(Number(block.dataset.block)), wanted)) || candidates[0];
  }
  if (annotationKind(remark.kind) !== "suggestion" || !quote) return null;
  const targetWords = new Set(markdownWords(quote));
  let best = null;
  let bestScore = 0;
  for (const block of blocks) {
    const source = sourceForBlock(blockData(block));
    const words = markdownWords(source);
    const score = words.reduce((total, word) => total + (targetWords.has(word) ? 1 : 0), 0);
    if (score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function markdownWords(value) {
  return String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function headingPathsMatch(actual, expected) {
  const normalize = (value) => String(value).trim().replace(/\s+/g, " ").toLowerCase();
  const left = actual.map(normalize);
  const right = expected.map(normalize);
  if (left.length < right.length) return false;
  return right.every((part, index) => left[left.length - right.length + index] === part);
}

function pendingAnnotations() {
  const currentPath = store.document?.path || store.view.path || "";
  const file = basename(currentPath);
  return (Array.isArray(store.annotations) ? store.annotations : []).filter((annotation) => {
    if (!annotation?.id) return false;
    return !annotation.artifact || annotation.artifact === file || annotation.artifact === currentPath || annotation.path === currentPath;
  });
}

function annotationBlock(annotation) {
  if (Number.isFinite(Number(annotation.block))) {
    const direct = blockElement(Number(annotation.block));
    if (direct) return direct;
  }
  if (Number.isFinite(Number(annotation.line_start))) {
    return [...elements.viewer.querySelectorAll(".blk")].find((block) => {
      const start = Number(block.dataset.lineStart);
      const end = Number(block.dataset.lineEnd);
      return Number(annotation.line_start) <= end && Number(annotation.line_end || annotation.line_start) >= start;
    });
  }
  return null;
}

function markText(root, text, kind, id, sent = false) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let whole = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: whole.length, end: whole.length + node.data.length });
    whole += node.data;
  }
  const start = whole.indexOf(text);
  if (start < 0) return false;
  const end = start + text.length;
  const first = nodes.find((item) => item.start <= start && item.end > start);
  const last = [...nodes].reverse().find((item) => item.start < end && item.end >= end);
  if (!first || !last) return false;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  const mark = document.createElement("mark");
  mark.className = `mark ${kind}${sent ? " sent" : ""}`;
  mark.dataset[sent ? "remark" : "annotation"] = id;
  try {
    mark.append(range.extractContents());
    range.insertNode(mark);
    return true;
  } catch {
    return false;
  }
}

function focusAnnotation(value) {
  const id = typeof value === "string" ? value : value?.id;
  if (!id || !elements.viewer) return;
  const escaped = cssEscape(id);
  const match = elements.viewer.querySelector(`[data-annotation="${escaped}"], [data-remark="${escaped}"]`);
  if (!match) return;
  match.scrollIntoView({ behavior: "smooth", block: "center" });
  match.classList.remove("annotation-flash");
  requestAnimationFrame(() => match.classList.add("annotation-flash"));
  setTimeout(() => match.classList.remove("annotation-flash"), 1400);
}

function scrollToHeading(value) {
  const id = typeof value === "string" ? value : value?.id;
  if (!id || !elements.viewer) return;
  const heading = elements.viewer.querySelector(`#${cssEscape(id)}`);
  heading?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleBlockFocus(event) {
  const content = event.target.closest(".blk-content[contenteditable]");
  if (!content || !isLiveGate(store.view)) return;
  const wrapper = content.closest(".blk");
  if (activeEdit?.content === content) return;
  if (activeEdit) finishEdit(activeEdit);
  const data = blockData(wrapper);
  if (!data) return;
  const source = sourceForBlock(data);
  // Focus alone changes nothing: the reader may be about to select text for a
  // comment. The block switches to its Markdown source on the first keystroke
  // or toolbar action (see armEdit), so selecting and editing share one surface.
  activeEdit = { wrapper, content, data, original: source, history: [], future: [], armed: false };
  wrapper.classList.add("editing");
  showToolbar(data, source);
}

/** Swap the rendered block for its Markdown source, keeping the caret on the same word. */
function armEdit(edit) {
  if (!edit || edit.armed) return;
  const prefix = caretPrefix(edit.content);
  edit.content.innerHTML = tokenizeMarkdown(edit.original);
  setCaretOffset(edit.content, alignPrefixToSource(edit.original, prefix));
  edit.armed = true;
  edit.wrapper.classList.add("armed");
}

/** Rendered text from the start of the block to the caret. */
function caretPrefix(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return "";
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString();
}

/**
 * Find where the rendered prefix ends inside the Markdown source. Rendered
 * text is the source minus syntax (markers, list bullets, table pipes and
 * rules, link targets), so walk both: every rendered character must be found
 * in order in the source, skipping the syntax characters between them.
 * Whitespace runs match any whitespace. Works for every block type without
 * a grammar; the fallback for a character that never appears is the end.
 */
function alignPrefixToSource(source, prefix) {
  let j = 0;
  const isSpace = (ch) => /\s/.test(ch);
  // Rendered whitespace carries no position information (tables and lists add
  // layout whitespace the source never had), so only visible characters steer.
  for (const ch of prefix) {
    if (isSpace(ch)) continue;
    while (j < source.length && source[j] !== ch) j += 1;
    if (j >= source.length) return source.length;
    j += 1;
  }
  // A caret that sat after a space in the rendered text stays after the space.
  if (prefix.length && isSpace(prefix[prefix.length - 1])) {
    while (j < source.length && isSpace(source[j]) && source[j] !== "\n") j += 1;
  }
  return Math.min(source.length, j);
}

/**
 * The rendered text has no Markdown markers, so a caret placed by clicking the
 * rendered block lands short of where the same text sits in the source. Walk
 * the source counting only non-marker characters until the visible offset is
 * reached; the caret then keeps the word the reader clicked on.
 */
function visibleToSourceOffset(source, visibleOffset) {
  // Line-start markers swallow the whitespace after them (and a task box), because
  // none of that reaches the rendered text; inline markers are exact.
  const marker = /(^(?:#{1,6}|[-+*>]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|^\s+|\*\*|~~|_|`)/gm;
  let visible = 0;
  let last = 0;
  for (const match of source.matchAll(marker)) {
    const plain = match.index - last;
    if (visible + plain >= visibleOffset) return last + (visibleOffset - visible);
    visible += plain;
    last = match.index + match[0].length;
  }
  return Math.min(source.length, last + Math.max(0, visibleOffset - visible));
}

function snapshotEdit(edit) {
  if (!edit) return;
  const text = editorText(edit.content);
  const last = edit.history[edit.history.length - 1];
  if (last && last.text === text) return;
  edit.history.push({ text, caret: caretOffset(edit.content) });
  if (edit.history.length > 200) edit.history.shift();
  edit.future = [];
}

function restoreEdit(edit, entry) {
  edit.content.innerHTML = tokenizeMarkdown(entry.text);
  setCaretOffset(edit.content, Math.min(entry.text.length, entry.caret));
  edit.content.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
}

function undoEdit(edit) {
  if (!edit || edit.history.length === 0) return false;
  const current = { text: editorText(edit.content), caret: caretOffset(edit.content) };
  const entry = edit.history.pop();
  edit.future.push(current);
  restoreEdit(edit, entry);
  return true;
}

function redoEdit(edit) {
  if (!edit || edit.future.length === 0) return false;
  edit.history.push({ text: editorText(edit.content), caret: caretOffset(edit.content) });
  restoreEdit(edit, edit.future.pop());
  return true;
}

function cancelEdit(edit) {
  if (!edit || activeEdit !== edit) return;
  edit.armed = false;
  edit.content.blur();
}

function handleEditorKey(event) {
  if (!activeEdit || !activeEdit.content.contains(event.target)) return;
  const meta = event.metaKey || event.ctrlKey;
  if (meta && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoEdit(activeEdit);
    else undoEdit(activeEdit);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancelEdit(activeEdit);
  }
}

function handleBeforeInput(event) {
  const content = event.target.closest(".blk-content[contenteditable]");
  if (!activeEdit || content !== activeEdit.content) return;
  if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
    // Our own history replaces the browser's, which innerHTML swaps would corrupt.
    event.preventDefault();
    if (event.inputType === "historyUndo") undoEdit(activeEdit);
    else redoEdit(activeEdit);
    return;
  }
  if (!activeEdit.armed) {
    // First keystroke on a rendered block: switch to source at the same caret,
    // then replay the intended input against the source text.
    event.preventDefault();
    armEdit(activeEdit);
    snapshotEdit(activeEdit);
    replayInput(event);
    return;
  }
  const last = activeEdit.history[activeEdit.history.length - 1];
  const boundary = /^(insertParagraph|insertLineBreak|deleteContent|deleteWord|insertFromPaste)/.test(event.inputType || "") ||
    (event.inputType === "insertText" && /\s/.test(event.data || ""));
  if (!last || boundary) snapshotEdit(activeEdit);
}

function replayInput(event) {
  const type = event.inputType || "";
  if (type === "insertText" && event.data) document.execCommand("insertText", false, event.data);
  else if (type === "insertFromPaste") {
    const text = event.dataTransfer?.getData("text/plain") || "";
    if (text) document.execCommand("insertText", false, text);
  } else if (type === "insertParagraph" || type === "insertLineBreak") document.execCommand("insertText", false, "\n");
  else if (type === "deleteContentBackward" || type === "deleteWordBackward") document.execCommand("delete");
  else if (type === "deleteContentForward" || type === "deleteWordForward") document.execCommand("forwardDelete");
}

function handleBlockInput(event) {
  const content = event.target.closest(".blk-content[contenteditable]");
  if (!activeEdit || content !== activeEdit.content) return;
  const current = editorText(content);
  const changes = wordDiff(activeEdit.original, current);
  const changed = changes.some((part) => part.type !== "same");
  activeEdit.wrapper.classList.toggle("changed", changed);
  activeEdit.wrapper.dataset.diff = summarizeDiff(changes);
}

function handleBlockBlur(event) {
  const content = event.target.closest(".blk-content[contenteditable]");
  if (!activeEdit || content !== activeEdit.content) return;
  if (elements.toolbar.contains(event.relatedTarget)) return;
  finishEdit(activeEdit);
}

function finishEdit(edit) {
  if (!edit || activeEdit !== edit) return;
  const after = edit.armed ? editorText(edit.content) : edit.original;
  const changed = edit.armed && after !== edit.original;
  edit.wrapper.classList.remove("editing", "changed", "armed");
  delete edit.wrapper.dataset.diff;
  edit.content.innerHTML = String(edit.data.html || "");
  activeEdit = null;
  hideToolbar();
  assignHeadingIds(store.document);
  if (changed) {
    const key = `${store.document.path}:${edit.data.index}`;
    const existing = pendingAnnotations().find(
      (annotation) => annotation.kind === "edit" && Number(annotation.block) === Number(edit.data.index),
    );
    const id = existing?.id || editIds.get(key) || nextAnnotationId();
    editIds.set(key, id);
    const annotation = {
      id,
      kind: "edit",
      artifact: basename(store.document.path),
      path: store.document.path,
      block: Number(edit.data.index),
      line_start: Number(edit.data.line_start),
      line_end: Number(edit.data.line_end),
      before: edit.original,
      original_block: edit.original,
      after_block: after,
      heading_path: headingPath(Number(edit.data.index)),
    };
    store.emit("suggest", annotation);
  }
  applyAnnotations();
}

function buildToolbar() {
  const toolbar = document.createElement("nav");
  toolbar.className = "document-toolbar";
  toolbar.setAttribute("aria-label", "Formatting");
  toolbar.hidden = true;
  const controls = [
    ["Paragraph ▾", "paragraph"],
    ["B", "bold"],
    ["I", "italic"],
    ["S", "strike"],
    ["<>", "code"],
    ["• list", "bullet"],
    ["1.", "number"],
    ["☑", "task"],
    ["❝", "quote"],
    ["🔗", "link"],
    ["▦", "table"],
    ["⧉", "diagram"],
  ];
  controls.forEach(([label, command], index) => {
    if ([1, 5, 9].includes(index)) {
      const separator = document.createElement("span");
      separator.className = "toolbar-separator";
      toolbar.append(separator);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toolbar-button ${command}`;
    button.dataset.command = command;
    button.textContent = label;
    button.title = formattingTitle(command);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => applyFormatting(command));
    toolbar.append(button);
  });
  const context = document.createElement("span");
  context.className = "toolbar-context";
  toolbar.append(context);
  return toolbar;
}

// The toolbar keeps its row whenever the document is editable, like Bunsho's:
// showing it on focus would shift the text under a reader mid-selection.
function showToolbar(block, source) {
  const label = blockLabel(block, source);
  elements.toolbar.querySelector(".toolbar-context").textContent =
    `Editing ${label} · a suggestion — the file is untouched until you decide`;
  elements.toolbar.classList.add("active");
  elements.toolbar.hidden = false;
}

function idleToolbar() {
  if (!elements.toolbar) return;
  elements.toolbar.classList.remove("active");
  elements.toolbar.querySelector(".toolbar-context").textContent =
    "Select text to comment · click into a paragraph and type to suggest a change";
  elements.toolbar.hidden = !isLiveGate(store.view);
}

function hideToolbar() {
  idleToolbar();
}

function applyFormatting(command) {
  if (!activeEdit) return;
  const editor = activeEdit.content;
  editor.focus();
  armEdit(activeEdit);
  snapshotEdit(activeEdit);
  const wrappers = {
    bold: ["**", "**"],
    italic: ["_", "_"],
    strike: ["~~", "~~"],
    code: ["`", "`"],
    link: ["[", "](url)"],
  };
  if (wrappers[command]) insertAroundSelection(editor, ...wrappers[command]);
  else if (command === "bullet") prefixCurrentLine(editor, "- ");
  else if (command === "number") prefixCurrentLine(editor, "1. ");
  else if (command === "task") prefixCurrentLine(editor, "- [ ] ");
  else if (command === "quote") prefixCurrentLine(editor, "> ");
  else if (command === "paragraph") prefixCurrentLine(editor, "# ");
  else if (command === "table") insertAtCaret(editor, "| Column | Column |\n|---|---|\n| Value | Value |");
  else if (command === "diagram") insertAtCaret(editor, "```mermaid\ngraph TD\n  A --> B\n```");
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

function insertAroundSelection(editor, before, after) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    insertAtCaret(editor, before + after, before.length);
    return;
  }
  const range = selection.getRangeAt(0);
  const selected = range.toString();
  const text = document.createTextNode(before + selected + after);
  range.deleteContents();
  range.insertNode(text);
  const caret = document.createRange();
  const position = before.length + selected.length;
  caret.setStart(text, position);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

function insertAtCaret(editor, text, caretBack = 0) {
  const selection = window.getSelection();
  const range = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  const target = range || document.createRange();
  if (!range) {
    target.selectNodeContents(editor);
    target.collapse(false);
  }
  target.deleteContents();
  const node = document.createTextNode(text);
  target.insertNode(node);
  const caret = document.createRange();
  caret.setStart(node, Math.max(0, text.length - caretBack));
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

function prefixCurrentLine(editor, prefix) {
  const offset = caretOffset(editor);
  const text = editorText(editor);
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const next = `${text.slice(0, lineStart)}${prefix}${text.slice(lineStart)}`;
  editor.innerHTML = tokenizeMarkdown(next);
  setCaretOffset(editor, offset + prefix.length);
}

// Small word-level LCS. It intentionally keeps whitespace tokens so the thread
// card can reconstruct the exact before/after strings without another parser.
function wordDiff(before, after) {
  const left = before.match(/\s+|[^\s]+/g) || [];
  const right = after.match(/\s+|[^\s]+/g) || [];
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result = [];
  const push = (type, value) => {
    const last = result[result.length - 1];
    if (last?.type === type) last.value += value;
    else result.push({ type, value });
  };
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push("same", left[i]);
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      push("insert", right[j]);
      j += 1;
    } else {
      push("delete", left[i]);
      i += 1;
    }
  }
  return result;
}

/** When most tokens changed, an interleaved word diff is noise; show old → new whole. */
function readableDiff(before, after) {
  const parts = wordDiff(before, after);
  const changed = parts.filter((part) => part.type !== "same").reduce((total, part) => total + part.value.length, 0);
  const total = Math.max(1, before.length + after.length);
  if (changed / total > 0.6 && before.trim() && after.trim()) {
    return [{ type: "delete", value: before }, { type: "insert", value: after }];
  }
  return parts;
}

function summarizeDiff(parts) {
  const deleted = parts.filter((part) => part.type === "delete").reduce((total, part) => total + part.value.length, 0);
  const inserted = parts.filter((part) => part.type === "insert").reduce((total, part) => total + part.value.length, 0);
  return `${deleted} removed · ${inserted} added`;
}

function tokenizeMarkdown(source) {
  const marker = /(\*\*|~~|_|`|^(?:#{1,6}|[-+>])(?=\s))/gm;
  let html = "";
  let last = 0;
  for (const match of source.matchAll(marker)) {
    html += escapeHtml(source.slice(last, match.index));
    html += `<span class="mk">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(last));
}

function selectedLines(block, selected) {
  const source = sourceForBlock(block);
  let index = source.indexOf(selected);
  if (index < 0) {
    const first = selected.split("\n")[0].trim();
    index = first ? source.indexOf(first) : -1;
  }
  if (index < 0) return { line_start: Number(block.line_start), line_end: Number(block.line_end) };
  const lineOffset = source.slice(0, index).split("\n").length - 1;
  const span = selected.split("\n").length - 1;
  return {
    line_start: Number(block.line_start) + lineOffset,
    line_end: Math.min(Number(block.line_end), Number(block.line_start) + lineOffset + span),
  };
}

function sourceForBlock(block) {
  const lines = String(store.document?.source || "").split("\n");
  return lines.slice(Number(block.line_start) - 1, Number(block.line_end)).join("\n");
}

function headingPath(blockIndex) {
  const levels = [];
  for (const heading of store.document?.outline || []) {
    if (Number(heading.block) > blockIndex) break;
    const level = Math.max(1, Math.min(3, Number(heading.level)));
    levels[level - 1] = heading.text;
    levels.length = level;
  }
  return levels.filter(Boolean);
}

function assignHeadingIds(doc) {
  if (!doc) return;
  for (const heading of doc.outline || []) {
    const wrapper = blockElement(heading.block);
    const element = wrapper?.querySelector(`h${heading.level}`);
    if (element && heading.id) element.id = heading.id;
  }
}

function isLiveGate(view) {
  if (!view || view.readOnly || !view.path) return false;
  const current = store.state?.current;
  if (current?.state !== "awaiting-approval" || decisionInFlight()) return false;
  const artifacts = store.state?.manifest?.artifacts || [];
  return artifacts.some((artifact) => artifact.path === view.path && artifact.exists !== false);
}

function isReadOnly(view) {
  return Boolean(view?.readOnly || !isLiveGate(view));
}

function stageForArtifact(path, stageHint) {
  const phases = store.workflow?.phases || [];
  for (const phase of phases) {
    for (const stage of phase.stages || []) {
      if (stage.slug === stageHint || stage.name === stageHint) return stage;
      if ((stage.artifacts || []).some((artifact) => artifact.path === path)) return stage;
    }
  }
  return null;
}

function renderEmpty() {
  elements.viewer.hidden = true;
  elements.empty.hidden = false;
  elements.empty.replaceChildren();
  const box = document.createElement("div");
  const title = document.createElement("b");
  const current = store.state?.current;
  const agent = store.workflow?.agent_status;
  const stage = humanize(store.state?.current_stage || current?.stage || "workflow");
  title.textContent = agent === "writing" ? `The agent is writing ${stage}` : agent === "revising" ? `The agent is revising ${stage}` : `The agent is working on ${stage}`;
  const detail = document.createElement("span");
  detail.textContent = store.state?.stage_status ? `Stage status ${store.state.stage_status} · live progress remains available in the terminal.` : "Live progress remains available in the terminal.";
  box.append(title, detail);
  elements.empty.append(box);
}

function blockData(element) {
  const index = Number(element?.dataset.block);
  return store.document?.blocks?.find((block) => Number(block.index) === index) || null;
}

function blockElement(index) {
  return elements.viewer?.querySelector(`.blk[data-block="${cssEscape(String(index))}"]`) || null;
}

function blockLabel(block, source) {
  const requirement = source.match(/\*\*((?:N?FR)\d+)\b/i)?.[1];
  if (requirement) return requirement.toUpperCase();
  const ownHeading = store.document?.outline?.find((heading) => Number(heading.block) === Number(block.index));
  if (ownHeading?.text) return ownHeading.text;
  const path = headingPath(Number(block.index));
  return path.at(-1) || `lines ${block.line_start}–${block.line_end}`;
}

function nextAnnotationId() {
  for (const annotation of store.annotations || []) {
    if (annotation?.id) reservedAnnotationIds.add(annotation.id);
  }
  let number = 1;
  while (reservedAnnotationIds.has(`a${number}`)) number += 1;
  const id = `a${number}`;
  reservedAnnotationIds.add(id);
  return id;
}

function annotationKind(kind) {
  if (kind === "edit" || kind === "suggestion" || kind === "label") return "suggestion";
  if (kind === "delete") return "delete";
  if (kind === "looks-good") return "looks-good";
  return "comment";
}

function kindLabel(kind) {
  return kind === "looks-good" ? "Looks good" : kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formattingTitle(command) {
  return {
    paragraph: "Heading",
    bold: "Bold",
    italic: "Italic",
    strike: "Strikethrough",
    code: "Code",
    bullet: "Bulleted list",
    number: "Numbered list",
    task: "Task list",
    quote: "Quote",
    link: "Link",
    table: "Table",
    diagram: "Diagram",
  }[command];
}

function editorText(element) {
  return element.innerText.replace(/\r\n?/g, "\n").replace(/\n$/, (match) => (element.textContent.endsWith("\n") ? match : ""));
}

function caretOffset(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function setCaretOffset(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = null;
  while (walker.nextNode()) {
    node = walker.currentNode;
    if (remaining <= node.data.length) break;
    remaining -= node.data.length;
  }
  if (!node) return;
  const range = document.createRange();
  range.setStart(node, Math.min(remaining, node.data.length));
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function elementForNode(node) {
  return node instanceof Element ? node : node?.parentElement;
}

function formatFromPath(path) {
  return /\.html?$/i.test(path) ? "html" : "md";
}

function basename(path) {
  return String(path || "").split("/").pop() || "";
}

function humanize(value) {
  return String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeTime(value) {
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

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

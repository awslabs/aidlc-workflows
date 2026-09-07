// Markdown document rendering, anchored pending feedback, and in-place suggestions.
import { api } from "./api.js";
import { trackedChangesFragment, wordDiffHtml } from "./diff.js";
import { icon } from "./icons.js";
import { agentFor, decisionInFlight, persistAnnotations, setNotice, store, selectedThreadIds } from "./store.js";

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
  elements.viewer.addEventListener("focusin", deferFocusDuringGesture);
  document.addEventListener("mousedown", () => { pointerHeld = true; }, true);
  document.addEventListener("mouseup", flushDeferredFocus, true);
  elements.viewer.addEventListener("beforeinput", handleBeforeInput);
  elements.viewer.addEventListener("input", handleBlockInput);
  elements.viewer.addEventListener("focusout", deferBlurDuringGesture);
  elements.viewer.addEventListener("keydown", handleEditorKey);
  document.addEventListener("keydown", handleSelectionKey);
  window.addEventListener("message", receiveHtmlAnchor);

  store.on("view", renderView);
  store.on("inlineDiff", (payload) => {
    inlineDiff = payload && payload.path === store.document?.path ? payload : null;
    applyInlineDiff();
  });
  store.on("before-refresh", ({ stageChanged } = {}) => {
    // The revision moved on: an open typed edit belongs to the one it was
    // made on, so it is recorded before the state swap. Same revision: leave
    // the edit alone - loadArtifact keeps the DOM when the file is unchanged.
    if (stageChanged && activeEdit) finishEdit(activeEdit);
  });
  store.on("refresh", () => {
    if (store.view.kind === "artifact") loadArtifact(store.view);
    else if (store.view.kind === "empty") renderEmpty();
  });
  store.on("remarks", applyAnnotations);
  store.on("annotations", () => {
    applyAnnotations();
    refreshHistoryButtons();
  });
  store.on("undo-suggestion", (id) => removeSuggestion(id));
  store.on("selection", showSelectionAffordance);
  store.on("focus", focusAnnotation);
  store.on("scroll-to", scrollToHeading);
  store.on("state", () => {
    if (store.view.kind === "empty") renderEmpty();
  });

  renderView(store.view);
}

function renderView(view) {
  // A typed edit still open when the view changes is a suggestion the
  // reviewer made; record it rather than drop it with the DOM.
  if (activeEdit) finishEdit(activeEdit);
  hideToolbar();
  closeCommentPopover();
  // A new document starts with nothing selected in the rail.
  if (store.focusThread) store.set({ focusThread: null });
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
  // Re-rendering the same document is deferred until its content is known to
  // have changed: a routine state push must not wipe the reader's caret, an
  // open typed edit, or a comment being written.
  const same = store.document?.path === view.path && elements.viewer.dataset.path === view.path && !elements.viewer.classList.contains("document-loading");
  const reset = () => {
    if (activeEdit) finishEdit(activeEdit);
    hideToolbar();
    closeCommentPopover();
    activeEdit = null;
  };
  if (!same) {
    reset();
    elements.viewer.hidden = false;
    elements.viewer.className = "viewer document-loading";
    elements.viewer.textContent = "Rendering document…";
  }
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
    if (same) {
      // Same bytes, same gate, same revision: nothing on screen would change.
      const unchanged = store.document.sha256 === String(rendered.sha256 || "")
        && elements.viewer.dataset.readOnly === String(isReadOnly(view))
        && elements.viewer.dataset.revision === String(currentRevision());
      if (unchanged) return;
      reset();
    }
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
  elements.viewer.dataset.revision = String(currentRevision());

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
let activePopover = null;

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
    hint.textContent = "Type anywhere — edits are suggestions; Send changes hands them to the agent to apply";
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
  if (stage?.state === "current" && store.state?.phase === "confirming") {
    banner.classList.add("in-progress-banner");
    const plan = store.state?.checkpoint === "plan-approval";
    const prompt = store.state?.checkpoint_prompt;
    banner.innerHTML = `<b>${plan ? "Plan approval" : "Confirmation"}</b><span></span>`;
    banner.querySelector("span").textContent = prompt?.decision
      ? `· the terminal is asking: "${prompt.decision}" (${prompt.options.join(" / ")}) - answer there`
      : plan
        ? "· the terminal is asking you to approve this plan - read it here, decide there"
        : "· the terminal is asking you to confirm the answers before this is generated";
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
  elements.viewer.dataset.revision = String(currentRevision());
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

// The line-level element the caret or selection sits in: the unit a reader
// means when they click into a paragraph, a list item, a table cell, a heading.
function lineElementFor(node, block) {
  const element = elementForNode(node);
  const line = element?.closest("li, p, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt");
  return line && block.contains(line) ? line : block.querySelector(".blk-content") || block;
}

function captureSelection(event) {
  if (htmlFrame || event.target.closest(".gutter, .selection-add, .comment-popover, .document-toolbar")) return;
  if (activeEdit?.armed && activeEdit.content.contains(event.target)) return;
  const target = event.target;
  // Focusing a block can tear down the previous edit and re-render, which the
  // browser may do between mousedown and mouseup - destroying the selection
  // this handler would read. Settle first, then read; if the selection was
  // lost, the click's own target still says which line was meant.
  requestAnimationFrame(() => captureSettled(target));
}

function captureSettled(target) {
  if (!target?.isConnected && !target?.closest) return;
  if (activePopover && !activePopover.isConnected) closeCommentPopover();
  if (activePopover) return;
  const selection = window.getSelection();
  let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  let start = range ? elementForNode(range.startContainer)?.closest(".blk") : null;
  const end = range ? elementForNode(range.endContainer)?.closest(".blk") : null;
  const clickedBlock = target.closest?.(".blk");
  if (!start || start !== end || (selection.isCollapsed && clickedBlock && start !== clickedBlock)) {
    // Selection lost to the re-render: treat the click as a caret on its line.
    const clicked = clickedBlock;
    if (!clicked || !elements.viewer.contains(clicked)) {
      store.set({ selection: null });
      return;
    }
    start = clicked;
    range = null;
  }
  const block = blockData(start);
  if (!block) return;
  // A caret placed in a line (no highlight) offers a comment on that line,
  // like a highlight does on its text. Marked `caret` so the C/D/G shortcuts
  // stay off - a keystroke there is the start of an edit, not a command.
  const caret = !range || selection.isCollapsed || !selection.toString().trim();
  const caretNode = range ? range.startContainer : target;
  // A caret inside commented text selects that thread in the rail, as the
  // reference does; the click on the mark itself already did, harmlessly twice.
  const markAtCaret = caret ? elementForNode(caretNode)?.closest(".mark[data-annotation], .mark[data-remark]") : null;
  if (markAtCaret) {
    const id = markAtCaret.dataset.annotation || markAtCaret.dataset.remark;
    if (id && !selectedThreadIds(store.focusThread).includes(id)) selectThreadFromDocument(id);
  }
  // A caret's line is the element's own text, not its nested lists.
  const ownText = (line) => {
    const clone = line.cloneNode(true);
    clone.querySelectorAll("ul, ol, table, blockquote, pre").forEach((nested) => nested.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  };
  const text = caret ? ownText(lineElementFor(caretNode, start)) : selection.toString().trim();
  if (!text) {
    store.set({ selection: null });
    return;
  }
  const lines = selectedLines(block, text);
  // Where the affordance goes: the first line of the highlight (or the caret's
  // line), relative to the block, so it sits in the gutter beside that line.
  const lineRect = (caret ? lineElementFor(caretNode, start).getBoundingClientRect() : (range.getClientRects()[0] || range.getBoundingClientRect()));
  const blockRect = start.getBoundingClientRect();
  const descriptor = {
    anchor_left: Math.max(0, lineRect.left - blockRect.left),
    artifact: basename(store.document?.path || store.view.path || ""),
    path: store.document?.path || store.view.path,
    block: Number(block.index),
    text,
    selection: text,
    line_start: lines.line_start,
    line_end: lines.line_end,
    heading_path: headingPath(Number(block.index)),
    caret,
    anchor_top: Math.max(0, lineRect.top - blockRect.top),
    anchor_height: lineRect.height || 20,
  };
  store.set({ selection: descriptor });
}

// Two affordances, as in the reference editor:
//   - a highlight gets a dark floating comment bubble just above the start of
//     the selected text;
//   - a caret placed in a line gets a quiet trigger in the left gutter beside
//     that line, where the thread bubbles live.
function showSelectionAffordance(selection) {
  elements.viewer?.querySelectorAll(".selection-add").forEach((button) => {
    button.remove();
  });
  if (activePopover || !selection || store.view.kind !== "artifact" || selection.block === null || selection.block === undefined) return;
  const block = blockElement(selection.block);
  // `.editing` only means the block has focus; an ARMED edit (typing began) is
  // what hides the trigger, and armEdit clears the selection for that.
  if (!block) return;
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = icon("commentAdd", { size: 15 });
  if (selection.caret) {
    button.className = "selection-add gutter-trigger";
    button.title = "Comment on this line";
    const top = (selection.anchor_top ?? 0) + (selection.anchor_height ?? 20) / 2;
    button.style.top = `${Math.round(top)}px`;
    if (block.querySelector(".gutter .bubble") && top < 30) button.classList.add("beside-bubble");
  } else {
    button.className = "selection-add floating";
    button.title = "Comment on selection (C)";
    button.style.left = `${Math.round(selection.anchor_left ?? 0)}px`;
    button.style.top = `${Math.round((selection.anchor_top ?? 0) - 6)}px`;
  }
  button.setAttribute("aria-label", button.title);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => openCommentPopover(block, selection));
  block.append(button);
}

// The comment is written where the text is, as in the reference editor: a
// 320px card whose left edge is the quoted text's left edge and which sits
// over the line (quote above it, textarea on it). Only Comment turns it into
// a thread in the side panel; Cancel (or Escape) discards it and the selection
// bubble comes back. Clicking elsewhere leaves it open, as the reference does.
const POPOVER_RISE = 45;
const POPOVER_WIDTH = 320;

function openCommentPopover(block, selection) {
  closeCommentPopover();
  const { caret: _caret, anchor_top, anchor_height: _height, anchor_left, ...anchored } = selection;
  elements.viewer.querySelectorAll(".selection-add").forEach((node) => node.remove());
  const content = block.querySelector(".blk-content");
  if (content && anchored.text) markText(content, anchored.text, "composing", "composing");
  const pop = document.createElement("form");
  pop.className = "comment-popover";
  pop.composing = content && anchored.text ? { content, text: anchored.text } : null;
  // Never above the viewer's top edge: the first lines of the first block
  // would otherwise open under the toolbar.
  const viewerTop = elements.viewer.getBoundingClientRect().top + 8;
  const blockTop = block.getBoundingClientRect().top;
  const top = Math.max((anchor_top ?? 0) - POPOVER_RISE, viewerTop - blockTop);
  pop.style.top = `${Math.round(top)}px`;
  // Left edge on the quoted text, pulled back so the card stays inside the block.
  const left = Math.min(Math.max(0, anchor_left ?? 0), Math.max(0, block.clientWidth - POPOVER_WIDTH - 8));
  pop.style.left = `${Math.round(left)}px`;
  pop.innerHTML = `
    <div class="comment-popover-quote">${escapeHtml(anchored.text.length > 90 ? `${anchored.text.slice(0, 87)}…` : anchored.text)}</div>
    <textarea rows="2" placeholder="Add a comment..." aria-label="Comment"></textarea>
    <div class="comment-popover-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" disabled>Comment</button></div>`;
  const textarea = pop.querySelector("textarea");
  const submit = pop.querySelector("button[type=submit]");
  const close = () => {
    pop.remove();
    activePopover = null;
    for (const mark of elements.viewer.querySelectorAll(".mark.composing")) mark.replaceWith(...mark.childNodes);
    content?.normalize();
  };
  pop.addEventListener("mousedown", (event) => event.stopPropagation());
  pop.addEventListener("mouseup", (event) => event.stopPropagation());
  pop.querySelector("[data-cancel]").addEventListener("click", () => {
    close();
    showSelectionAffordance(store.selection);
  });
  textarea.addEventListener("input", () => { submit.disabled = !textarea.value.trim(); });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); showSelectionAffordance(store.selection); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); pop.requestSubmit(); }
  });
  pop.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = textarea.value.trim();
    if (!body) { textarea.focus(); return; }
    const id = nextAnnotationId();
    // Posted straight to the side panel as a thread, not as a draft to edit there.
    store.emit("compose", { id, kind: "comment", ...anchored, selection: anchored, body, post: true });
    store.set({ selection: null });
    window.getSelection()?.removeAllRanges();
    close();
  });
  block.append(pop);
  activePopover = pop;
  textarea.focus();
}

function closeCommentPopover() {
  activePopover?.remove();
  activePopover = null;
  for (const mark of elements.viewer.querySelectorAll(".mark.composing")) mark.replaceWith(...mark.childNodes);
}

function handleSelectionKey(event) {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && !event.altKey && event.key.toLowerCase() === "z" && !activeEdit && store.view?.kind === "artifact") {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
    if (event.shiftKey ? redoAny() : undoAny()) event.preventDefault();
    return;
  }
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
  if (!store.selection || store.selection.caret || store.view.kind !== "artifact") return;
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
  // A badge counts every thread on its line: clicking it selects all of them,
  // as the reference does. A mark is one thread.
  const ids = anchor.classList.contains("bubble") && anchor.dataset.threads
    ? anchor.dataset.threads.split(" ")
    : [anchor.dataset.annotation || anchor.dataset.remark];
  if (!ids[0]) return;
  selectThreadFromDocument(ids);
}

/**
 * Selecting a thread from the document (its badge, its mark, a caret in it):
 * the Threads panel is brought up if another panel or none is showing, its
 * card gets the selection ring and scrolls into view, and the document itself
 * does not move - the reader is already looking at the place.
 */
function selectThreadFromDocument(value) {
  const ids = selectedThreadIds(value);
  if (!ids.length) return;
  // Stored without its own notification: the single "focus" below is what
  // the rail (ring + scroll) and the badges react to.
  store.focusThread = ids.length === 1 ? ids[0] : ids;
  if (store.panel !== "threads") store.set({ panel: "threads" });
  store.emit("focus", { ids, source: "document" });
}

function applyAnnotations() {
  const doc = store.document;
  if (!doc || store.view.kind !== "artifact" || doc.format === "html" || !elements.viewer) return;
  const annotations = pendingAnnotations();
  const remarks = sentRemarks();
  // `.editing` is only focus. The one block that must keep its DOM is the
  // ARMED edit (the human is typing into its source); there, strip obsolete
  // marks without touching the text and clear the gutter. Every other block
  // is re-rendered from its HTML.
  const armedWrapper = activeEdit?.armed ? activeEdit.wrapper : null;
  // Re-rendering must not eat the reader's selection or caret: a click into a
  // block runs this (the previous edit closes) between mousedown and mouseup,
  // and the highlight the reader is making lives in the DOM being replaced.
  // Remember it as text offsets in its block and put it back afterwards.
  const kept = liveSelectionOffsets();
  for (const block of doc.blocks) {
    const wrapper = blockElement(block.index);
    if (!wrapper) continue;
    wrapper.querySelector(".gutter").replaceChildren();
    wrapper.classList.remove("has-suggestion");
    if (wrapper === armedWrapper) {
      for (const mark of wrapper.querySelectorAll(".mark")) mark.replaceWith(...mark.childNodes);
      continue;
    }
    wrapper.querySelector(".blk-content").innerHTML = String(block.html || "");
  }
  for (const annotation of annotations) reservedAnnotationIds.add(annotation.id);
  assignHeadingIds(doc);
  // Suggested edits show in the document itself as tracked changes — the
  // reviewer must see what they changed where they changed it, not only as a
  // card in the rail. Sent edits stay visible (muted) until the file changes.
  for (const wrapper of elements.viewer.querySelectorAll(".blk.suggested")) {
    wrapper.classList.remove("suggested", "pending", "sent");
    wrapper.querySelector(".sugg-pill")?.remove();
  }
  const edits = annotations.filter((annotation) => annotation.kind === "edit" && typeof annotation.after_block === "string");
  for (const edit of edits) renderSuggestedEdit(edit, false);
  for (const edit of sentEdits()) renderSuggestedEdit(edit, true);
  const marks = [
    ...annotations.filter((annotation) => !edits.includes(annotation)).map((annotation) => ({ item: annotation, sent: false })),
    ...remarks.map((remark) => ({ item: remark, sent: true })),
  ];
  // The gutter shows one bubble per LINE with the number of threads on that
  // line, sitting beside the marked text - so a block with remarks on three
  // different lines shows three bubbles at those lines, and a line with three
  // remarks reads "3".
  const perLine = new Map();
  for (const { item, sent } of marks) {
    const kind = annotationKind(item.kind);
    const quote = remarkQuote(item, sent);
    const block = sent ? remarkBlock(item, quote) : annotationBlock(item);
    if (!block) continue;
    const content = block.querySelector(".blk-content");
    // The armed edit's text is never wrapped while the human types in it, but
    // its threads still get per-line bubbles: the quote is located with a
    // read-only Range and only its rect is used, so the caret is untouched.
    let marked = false;
    let markRect = null;
    if (block === armedWrapper) {
      markRect = (quote ? rangeForText(content, quote) : null)?.getBoundingClientRect() ?? null;
    } else {
      marked = quote ? markText(content, quote, kind, item.id, sent) : false;
      if (!marked && sent && kind === "suggestion") {
        const blockText = content.textContent.trim();
        marked = Boolean(blockText) && markText(content, blockText, kind, item.id, true);
      }
      if (!marked && kind === "suggestion") block.classList.add("has-suggestion");
      markRect = block.querySelector(`.mark[data-${sent ? "remark" : "annotation"}="${cssEscape(item.id)}"]`)?.getBoundingClientRect() ?? null;
    }
    // Centre the bubble on the marked line, as the reference does.
    const top = markRect ? Math.max(0, markRect.top - block.getBoundingClientRect().top + (markRect.height - 22) / 2) : 0;
    const key = `${block.dataset.block}:${Math.round(top / 8)}`;
    if (!perLine.has(key)) perLine.set(key, { block, top, entries: [] });
    perLine.get(key).entries.push({ item, sent, kind });
  }
  for (const { block, top, entries } of perLine.values()) {
    const first = entries[0];
    const pending = entries.filter((entry) => !entry.sent).length;
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = `bubble ${first.kind}${pending ? "" : " sent"}`;
    bubble.dataset[first.sent ? "remark" : "annotation"] = first.item.id;
    bubble.dataset.threads = entries.map((entry) => entry.item.id).join(" ");
    bubble.classList.toggle("selected", entries.some((entry) => selectedThreadIds(store.focusThread).includes(String(entry.item.id))));
    // A speech bubble with the count beside it, as the reference draws it.
    bubble.innerHTML = `${icon("comment", { size: 13 })}<span class="bubble-count">${entries.length}</span>`;
    const summary = entries.map((entry) => `${kindLabel(entry.kind)}${entry.sent ? ` (r${entry.item.revision ?? "?"})` : " (pending)"}`).join(", ");
    bubble.title = `${entries.length} ${entries.length === 1 ? "thread" : "threads"} · ${summary}`;
    bubble.setAttribute("aria-label", bubble.title);
    bubble.style.top = `${Math.round(top)}px`;
    block.querySelector(".gutter").append(bubble);
  }
  layoutGutterBadges();
  showSelectionAffordance(store.selection);
  // A comment being written keeps its highlight through the re-render.
  const composing = activePopover?.composing;
  if (composing && composing.content.isConnected && !composing.content.querySelector(".mark.composing")) {
    markText(composing.content, composing.text, "composing", "composing");
  }
  // Last: marks above extract and re-insert text nodes, which would move a
  // range restored any earlier. Offsets are text offsets, unchanged by marks.
  restoreSelectionOffsets(kept);
}

const fragmentCache = new Map();
let fragmentFetches = 0;

/** Rendered HTML for a Markdown fragment, cached by source; null until it lands. */
function renderedFragment(source) {
  if (fragmentCache.has(source)) return fragmentCache.get(source);
  fragmentCache.set(source, null);
  const path = store.document?.path;
  fragmentFetches += 1;
  api.post("/api/render-fragment", { source }).then((result) => {
    fragmentCache.set(source, typeof result?.html === "string" ? result.html : "");
    if (store.document?.path === path) applyAnnotations();
  }).catch(() => {
    fragmentCache.set(source, "");
  }).finally(() => {
    fragmentFetches -= 1;
  });
  return null;
}

function pendingEditFor(blockIndex) {
  return pendingAnnotations().find((annotation) => annotation.kind === "edit" && Number(annotation.block) === Number(blockIndex) && typeof annotation.after_block === "string") || null;
}

/** Edits already sent for this exact file content: shown muted until the agent's revision replaces the file. */
function sentEdits() {
  const doc = store.document;
  if (!doc) return [];
  return (Array.isArray(store.sentEdits) ? store.sentEdits : []).filter((edit) => edit.path === doc.path && edit.sha256 === doc.sha256);
}

function renderSuggestedEdit(edit, sent) {
  const wrapper = annotationBlock(edit);
  if (!wrapper || wrapper.classList.contains("editing")) return;
  const data = blockData(wrapper);
  if (!data) return;
  const afterHtml = renderedFragment(edit.after_block);
  if (afterHtml === null) return; // arrives async; applyAnnotations re-runs
  const content = wrapper.querySelector(".blk-content");
  content.replaceChildren(trackedChangesFragment(String(data.html || ""), afterHtml));
  wrapper.classList.add("suggested", sent ? "sent" : "pending");
  const pill = document.createElement("div");
  pill.className = "sugg-pill";
  if (sent) {
    pill.innerHTML = `<span>Your edit · sent${Number.isInteger(edit.revision) ? ` in r${edit.revision}` : ""} · awaiting the agent</span>`;
  } else {
    pill.innerHTML = `<span>Your edit · not sent yet</span><button type="button" data-undo-edit>Undo</button>`;
    pill.querySelector("[data-undo-edit]").addEventListener("mousedown", (event) => event.preventDefault());
    pill.querySelector("[data-undo-edit]").addEventListener("click", () => removeSuggestion(edit.id));
  }
  wrapper.append(pill);
  const gutter = wrapper.querySelector(".gutter");
  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = `bubble suggestion${sent ? " sent" : ""} pencil`;
  bubble.dataset.annotation = edit.id;
  bubble.dataset.threads = edit.id;
  bubble.classList.toggle("selected", selectedThreadIds(store.focusThread).includes(String(edit.id)));
  bubble.title = sent ? "Your suggested edit (sent)" : "Your suggested edit (not sent yet)";
  bubble.setAttribute("aria-label", bubble.title);
  bubble.innerHTML = icon("edit", { size: 12 });
  gutter.append(bubble);
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

/** A Range over the first occurrence of `text` in `root`'s text, or null. Reads only. */
/** The live selection as text offsets inside its block's content, or null. */
function liveSelectionOffsets() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const content = elementForNode(range.startContainer)?.closest(".blk-content");
  if (!content || !elements.viewer.contains(content) || content !== elementForNode(range.endContainer)?.closest(".blk-content")) return null;
  const before = document.createRange();
  before.selectNodeContents(content);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { content, start, end: start + range.toString().length };
}

function restoreSelectionOffsets(kept) {
  // Only into the block that has focus: selecting inside another editable
  // block would move focus there and start an edit the reader never began.
  if (!kept || !kept.content.isConnected || kept.content !== document.activeElement) return;
  const range = rangeAtOffsets(kept.content, kept.start, kept.end);
  if (!range) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function rangeAtOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let first = null;
  let last = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const next = offset + node.data.length;
    if (!first && start <= next) first = { node, at: start - offset };
    if (end <= next) { last = { node, at: end - offset }; break; }
    offset = next;
  }
  if (!first) return null;
  if (!last) last = first;
  const range = document.createRange();
  range.setStart(first.node, Math.max(0, Math.min(first.node.data.length, first.at)));
  range.setEnd(last.node, Math.max(0, Math.min(last.node.data.length, last.at)));
  return range;
}

function rangeForText(root, text) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let whole = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: whole.length, end: whole.length + node.data.length });
    whole += node.data;
  }
  const start = whole.indexOf(text);
  if (start < 0) return null;
  const end = start + text.length;
  const first = nodes.find((item) => item.start <= start && item.end > start);
  const last = [...nodes].reverse().find((item) => item.start < end && item.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

function markText(root, text, kind, id, sent = false) {
  const range = rangeForText(root, text);
  if (!range) return false;
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
  const ids = selectedThreadIds(value);
  const id = ids[0];
  if (!id || !elements.viewer) return;
  markSelectedBadge(ids);
  // Selected from the document itself (badge, mark, caret) or by clicking into
  // a card's input: the reader is where they want to be; only the rail moves.
  if (value?.source === "document" || value?.source === "rail-input") return;
  const escaped = cssEscape(id);
  // The marked text itself when it exists; the gutter badge otherwise (edits,
  // or a quote the current text no longer contains).
  const match = elements.viewer.querySelector(`.mark[data-annotation="${escaped}"], .mark[data-remark="${escaped}"]`)
    || elements.viewer.querySelector(`[data-annotation="${escaped}"], [data-remark="${escaped}"]`);
  if (!match) return;
  match.scrollIntoView({ behavior: "smooth", block: "center" });
  match.classList.remove("annotation-flash");
  requestAnimationFrame(() => match.classList.add("annotation-flash"));
  setTimeout(() => match.classList.remove("annotation-flash"), 1400);
}

/**
 * Badges on the same line (a suggested edit's pencil and the comments on the
 * block's first line, say) sit side by side, growing away from the text,
 * instead of drawing over each other.
 */
function layoutGutterBadges() {
  for (const gutter of elements.viewer.querySelectorAll(".gutter")) {
    const badges = [...gutter.querySelectorAll(".bubble")].sort((left, right) => parseFloat(left.style.top || "0") - parseFloat(right.style.top || "0"));
    let rowTop = null;
    let offset = 0;
    for (const badge of badges) {
      const top = parseFloat(badge.style.top || "0");
      if (rowTop !== null && Math.abs(top - rowTop) < 12) {
        badge.style.right = `${offset}px`;
        badge.style.top = `${rowTop}px`;
      } else {
        rowTop = top;
        offset = 0;
        badge.style.right = "0px";
      }
      offset += badge.getBoundingClientRect().width + 4;
    }
  }
}

/** The badge whose threads include the selected one reads as selected. */
function markSelectedBadge(value) {
  const ids = selectedThreadIds(value);
  for (const bubble of elements.viewer.querySelectorAll(".gutter .bubble")) {
    bubble.classList.toggle("selected", (bubble.dataset.threads || "").split(" ").some((id) => ids.includes(id)));
  }
}

function scrollToHeading(value) {
  const id = typeof value === "string" ? value : value?.id;
  if (!id || !elements.viewer) return;
  const heading = elements.viewer.querySelector(`#${cssEscape(id)}`);
  heading?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// A click or drag into a block moves focus on mousedown. Reacting then -
// closing the previous edit and re-rendering - runs in the middle of the
// gesture and breaks the selection the reader is dragging out. So while the
// button is held, the focus is only noted; the bookkeeping runs on mouseup,
// before the selection is read (captureSelection waits a frame).
let pointerHeld = false;
let deferredFocus = null;
let deferredBlur = false;

function deferFocusDuringGesture(event) {
  if (pointerHeld) {
    deferredFocus = event.target;
    return;
  }
  handleBlockFocus(event);
}

function deferBlurDuringGesture(event) {
  if (pointerHeld) {
    deferredBlur = true;
    return;
  }
  handleBlockBlur(event);
}

function flushDeferredFocus() {
  pointerHeld = false;
  const target = deferredFocus;
  const blurred = deferredBlur;
  deferredFocus = null;
  deferredBlur = false;
  if (target?.isConnected) {
    handleBlockFocus({ target });
    return;
  }
  // Focus left the edited block for somewhere that is not a block (the rail,
  // the page): close the edit now that the gesture is over.
  if (blurred && activeEdit && !activeEdit.content.contains(document.activeElement) && !elements.toolbar.contains(document.activeElement)) {
    finishEdit(activeEdit);
  }
}

function handleBlockFocus(event) {
  const content = event.target.closest(".blk-content[contenteditable]");
  if (!content || !isLiveGate(store.view)) return;
  const wrapper = content.closest(".blk");
  if (activeEdit?.content === content) return;
  if (activeEdit) finishEdit(activeEdit);
  const data = blockData(wrapper);
  if (!data) return;
  const baseline = sourceForBlock(data);
  // A block with a pending suggestion is edited from the suggestion, so edits
  // compose; `baseline` stays the file's text for the before/after record.
  const pending = pendingEditFor(data.index);
  const source = pending ? pending.after_block : baseline;
  // Focus alone changes nothing: the reader may be about to select text for a
  // comment. The block switches to its Markdown source on the first keystroke
  // or toolbar action (see armEdit), so selecting and editing share one surface.
  activeEdit = { wrapper, content, data, original: source, baseline, history: [], future: [], armed: false };
  wrapper.classList.add("editing");
  showToolbar(data, source);
}

/** Swap the rendered block for its Markdown source, keeping the caret on the same word. */
function armEdit(edit) {
  if (!edit || edit.armed) return;
  // Carry the whole selection across the swap, not just the caret: a reader who
  // highlighted a sentence and pressed Delete (or typed over it) means that
  // sentence. Both ends are aligned from rendered text to source offsets.
  const { start, end } = selectionPrefixes(edit.content);
  edit.content.innerHTML = tokenizeMarkdown(edit.original);
  const from = alignPrefixToSource(edit.original, start);
  const to = end === null ? from : Math.max(from, alignPrefixToSource(edit.original, end));
  setSourceRange(edit.content, from, to);
  edit.armed = true;
  edit.wrapper.classList.add("armed");
  // Typing is editing: the comment trigger for the caret's line steps aside.
  store.set({ selection: null });
  refreshHistoryButtons();
}

/** Rendered text before the selection start and (when not collapsed) before its end, in document order. */
function selectionPrefixes(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return { start: "", end: null };
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return { start: caretPrefix(root), end: null };
  const start = renderedPrefix(root, range.startContainer, range.startOffset);
  if (range.collapsed) return { start, end: null };
  return { start, end: renderedPrefix(root, range.endContainer, range.endOffset) };
}

/** Rendered text from the start of the block to the caret. */
function caretPrefix(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return "";
  return renderedPrefix(root, selection.anchorNode, selection.anchorOffset);
}

function renderedPrefix(root, anchor, anchorOffset) {
  // Walk text nodes up to the caret, skipping struck-through (deleted) text:
  // it is not part of the suggested source the editor is about to show.
  let prefix = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const inDel = node.parentElement?.closest("del");
    if (node === anchor) {
      if (!inDel) prefix += node.data.slice(0, anchorOffset);
      return prefix;
    }
    if (anchor.nodeType === Node.ELEMENT_NODE && anchor.contains(node)) {
      // caret on an element boundary: include text nodes before the offset child
      const children = [...anchor.childNodes];
      const before = children.slice(0, anchorOffset);
      if (!before.some((child) => child === node || child.contains(node))) return prefix;
    }
    if (!inDel) prefix += node.data;
  }
  return prefix;
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

// One undo model, like a document editor's: while you are typing in a block, undo steps
// through your keystrokes; once you have clicked away, undo takes back the
// whole suggestion (and redo brings it back), most recent first. The pill's
// Undo and the card's Undo edit feed the same stack, so ⇧⌘Z reverses them.
const suggestionOrder = []; // annotation ids by last finish, oldest first
const undoneSuggestions = []; // removed suggestions, most recent last

function rememberSuggestion(id) {
  const at = suggestionOrder.indexOf(id);
  if (at !== -1) suggestionOrder.splice(at, 1);
  suggestionOrder.push(id);
  undoneSuggestions.length = 0; // a new edit clears redo, as in any editor
  refreshHistoryButtons();
}

function removeSuggestion(id, { silent = false } = {}) {
  const annotation = (store.annotations || []).find((item) => item.id === id && item.kind === "edit");
  if (!annotation) return false;
  const remaining = store.annotations.filter((item) => item.id !== id);
  store.set({ annotations: remaining });
  persistAnnotations(store.state, remaining);
  const at = suggestionOrder.indexOf(id);
  if (at !== -1) suggestionOrder.splice(at, 1);
  undoneSuggestions.push(annotation);
  if (!silent) setNotice("Suggestion removed — ⇧⌘Z or ↷ brings it back", "info");
  refreshHistoryButtons();
  return true;
}

function restoreSuggestion() {
  const annotation = undoneSuggestions.pop();
  if (!annotation) return false;
  const annotations = [...(store.annotations || []).filter((item) => item.id !== annotation.id), annotation];
  store.set({ annotations });
  persistAnnotations(store.state, annotations);
  suggestionOrder.push(annotation.id);
  refreshHistoryButtons();
  return true;
}

function undoAny() {
  if (activeEdit?.armed) {
    if (undoEdit(activeEdit)) return true;
    // Nothing typed yet this session: fall through to the suggestion this block carries.
    const pending = pendingEditFor(activeEdit.data.index);
    if (pending) {
      cancelEdit(activeEdit);
      return removeSuggestion(pending.id);
    }
    return false;
  }
  const last = [...suggestionOrder].reverse().find((id) => (store.annotations || []).some((item) => item.id === id));
  return last ? removeSuggestion(last) : false;
}

function redoAny() {
  if (activeEdit?.armed && activeEdit.future.length) return redoEdit(activeEdit);
  return restoreSuggestion();
}

function refreshHistoryButtons() {
  const toolbar = elements.toolbar;
  if (!toolbar) return;
  // Suggestions restored from the tab's session (a reload) join the stack in
  // their stored order so undo can take them back too.
  for (const item of store.annotations || []) {
    if (item.kind === "edit" && typeof item.after_block === "string" && !suggestionOrder.includes(item.id)) suggestionOrder.push(item.id);
  }
  const canUndo = activeEdit?.armed
    ? activeEdit.history.length > 0 || Boolean(pendingEditFor(activeEdit.data.index))
    : suggestionOrder.some((id) => (store.annotations || []).some((item) => item.id === id));
  const canRedo = activeEdit?.armed && activeEdit.future.length > 0 ? true : !activeEdit?.armed && undoneSuggestions.length > 0;
  toolbar.querySelector('[data-history="undo"]').disabled = !canUndo;
  toolbar.querySelector('[data-history="redo"]').disabled = !canRedo;
}

function handleEditorKey(event) {
  if (!activeEdit || !activeEdit.content.contains(event.target)) return;
  const meta = event.metaKey || event.ctrlKey;
  if (meta && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoAny();
    else undoAny();
    refreshHistoryButtons();
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
  requestAnimationFrame(refreshHistoryButtons);
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
  if (elements.toolbar.contains(event.relatedTarget) || activePopover?.contains(event.relatedTarget)) return;
  finishEdit(activeEdit);
}

function finishEdit(edit) {
  if (!edit || activeEdit !== edit) return;
  const after = edit.armed ? editorText(edit.content) : edit.original;
  const baseline = edit.baseline ?? edit.original;
  const touched = edit.armed && after !== edit.original;
  const changed = after !== baseline;
  edit.wrapper.classList.remove("editing", "changed", "armed");
  delete edit.wrapper.dataset.diff;
  edit.content.innerHTML = String(edit.data.html || "");
  activeEdit = null;
  hideToolbar();
  assignHeadingIds(store.document);
  if (touched && !changed) {
    // Typed the block back to the file's text: the suggestion is withdrawn.
    const pending = pendingEditFor(edit.data.index);
    if (pending) removeSuggestion(pending.id, { silent: true });
  }
  if (touched && changed) {
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
      before: baseline,
      original_block: baseline,
      after_block: after,
      heading_path: headingPath(Number(edit.data.index)),
    };
    store.emit("suggest", annotation);
    rememberSuggestion(id);
  }
  applyAnnotations();
  refreshHistoryButtons();
}

function buildToolbar() {
  const toolbar = document.createElement("nav");
  toolbar.className = "document-toolbar";
  toolbar.setAttribute("aria-label", "Formatting");
  toolbar.hidden = true;
  for (const [name, action, title] of [["arrowUndo", "undo", "Undo (⌘Z)"], ["arrowRedo", "redo", "Redo (⇧⌘Z)"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toolbar-button history ${action}`;
    button.dataset.history = action;
    button.innerHTML = icon(name);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = true;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => (action === "undo" ? undoAny() : redoAny()));
    toolbar.append(button);
  }
  const historySeparator = document.createElement("span");
  historySeparator.className = "toolbar-separator";
  toolbar.append(historySeparator);
  const controls = [
    ["textParagraph", "paragraph"],
    ["textBold", "bold"],
    ["textItalic", "italic"],
    ["textStrikethrough", "strike"],
    ["code", "code"],
    ["textBulletListTree", "bullet"],
    ["textNumberList", "number"],
    ["checkboxChecked", "task"],
    ["textQuote", "quote"],
    ["link", "link"],
    ["table", "table"],
    ["flow", "diagram"],
  ];
  controls.forEach(([name, command], index) => {
    if ([1, 5, 9].includes(index)) {
      const separator = document.createElement("span");
      separator.className = "toolbar-separator";
      toolbar.append(separator);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toolbar-button ${command}`;
    button.dataset.command = command;
    button.innerHTML = command === "paragraph"
      ? `${icon(name)}<span class="toolbar-label">Paragraph</span>${icon("chevronDown", { size: 12 })}`
      : icon(name);
    button.setAttribute("aria-label", formattingTitle(command));
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

// The toolbar keeps its row whenever the document is editable: showing it on
// focus would shift the text under a reader mid-selection.
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

/** The revision the document meta line shows. */
function currentRevision() {
  return store.state?.manifest?.revision ?? store.state?.current?.revision ?? "";
}

function isLiveGate(view) {
  if (!view || view.readOnly || !view.path) return false;
  const current = store.state?.current;
  if (store.state?.phase !== "reviewing" || decisionInFlight()) return false;
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
  for (const remark of store.remarks || []) {
    if (remark?.id) reservedAnnotationIds.add(remark.id);
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

function textPosition(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = null;
  while (walker.nextNode()) {
    node = walker.currentNode;
    if (remaining <= node.data.length) break;
    remaining -= node.data.length;
  }
  return node ? { node, offset: Math.min(remaining, node.data.length) } : null;
}

function setCaretOffset(root, offset) {
  setSourceRange(root, offset, offset);
}

/** Select source text from `from` to `to` (collapsed caret when equal). */
function setSourceRange(root, from, to) {
  const start = textPosition(root, from);
  if (!start) return;
  const end = to > from ? textPosition(root, to) || start : start;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
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

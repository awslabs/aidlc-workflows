// App rail, per-view header, inbox, and command palette.
import { api } from "./api.js";
import { decisionInFlight, store } from "./store.js";

const ICONS = {
  inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 4h14l2 9v7H3v-7z"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.5 6h4a3 3 0 0 1 3 3M8.5 18h4a3 3 0 0 0 3-3"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  threads: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 8v4l3 2"/></svg>',
  outline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="18" r=".8"/></svg>',
};

let rail;
let header;
let search;
let inbox;
let overview;
let empty;
let paletteItems = [];
let paletteIndex = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function basename(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "Untitled";
}

function titleCase(value) {
  return String(value || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function stages(workflow = store.workflow) {
  return (workflow?.phases || []).flatMap((phase) => phase.stages || []);
}

function findStage(slug, workflow = store.workflow) {
  return stages(workflow).find((stage) => stage.slug === slug) || null;
}

function currentStage(workflow = store.workflow) {
  return (
    stages(workflow).find((stage) => stage.state === "current") ||
    findStage(store.state?.current?.stage || store.state?.current_stage, workflow)
  );
}

function stageForView(view = store.view, workflow = store.workflow) {
  if (view?.stage) return findStage(view.stage, workflow);
  if (view?.path) {
    return stages(workflow).find(
      (stage) =>
        stage.questions?.file === view.path ||
        stage.memory === view.path ||
        (stage.artifacts || []).some((artifact) => artifact.path === view.path),
    );
  }
  return currentStage(workflow);
}

function stageArtifacts(stage) {
  return (stage?.artifacts || []).filter((artifact) => artifact.path !== stage?.questions?.file);
}

function firstArtifact(stage, existingOnly = true) {
  return stageArtifacts(stage).find((artifact) => !existingOnly || artifact.exists) || null;
}

function isActiveIntent(workflow = store.workflow) {
  return !workflow?.intent || !store.state?.intent || workflow.intent === store.state.intent;
}

// The decision this tab already sent for the gate the daemon still reports as
// open: the hook has not delivered it yet, so the gate reads as "sent", not live.
function sentDecision() {
  return decisionInFlight() ? store.decisionSent : null;
}

function isLiveGate(stage) {
  return Boolean(
    stage?.state === "current" &&
      isActiveIntent() &&
      !sentDecision() &&
      (stage.gate === "awaiting-approval" || store.state?.current?.state === "awaiting-approval"),
  );
}

function isLiveQuestions(stage) {
  return Boolean(
    stage?.state === "current" &&
      isActiveIntent() &&
      (store.questionsState ? store.questionsState === "live" : stage.questions?.open),
  );
}

function revision(stage) {
  return stage?.revision ?? store.state?.current?.revision ?? store.state?.revision_count ?? 0;
}

function intentUpdatedAt(workflow = store.workflow) {
  return workflow?.intents?.find((intent) => intent.slug === workflow.intent)?.updated_at;
}

function stageTimestamp(stage) {
  return formatTime(stage?.decided_at || intentUpdatedAt());
}

function artifactView(stage, artifact, intent = store.workflow?.intent) {
  if (!stage || !artifact?.path) return;
  store.set({
    view: {
      kind: "artifact",
      path: artifact.path,
      intent: intent || null,
      readOnly: stage.state !== "current" || !isActiveIntent(),
      stage: stage.slug,
    },
    panel: store.panel || "threads",
  });
}

function questionsView(stage, intent = store.workflow?.intent) {
  if (!stage?.questions?.file) return;
  store.set({
    view: {
      kind: "questions",
      path: stage.questions.file,
      intent: intent || null,
      readOnly: !stage.questions.open || stage.state !== "current" || !isActiveIntent(),
      stage: stage.slug,
    },
    panel: null,
  });
}

function overviewView(stage, intent = store.workflow?.intent) {
  if (!stage) return;
  store.set({
    view: { kind: "overview", path: null, intent: intent || null, readOnly: stage.state !== "current", stage: stage.slug },
    panel: null,
  });
}

function openCurrentThing(workflow = store.workflow) {
  const stage = currentStage(workflow);
  if (!stage) {
    store.set({ view: { kind: "inbox", path: null, intent: workflow?.intent || null, readOnly: false, stage: null }, panel: null });
    return;
  }
  if (stage.questions?.open) questionsView(stage, workflow?.intent);
  else {
    const artifact = firstArtifact(stage);
    if (artifact) artifactView(stage, artifact, workflow?.intent);
    else overviewView(stage, workflow?.intent);
  }
}

function needsYouCount() {
  return (store.workflow?.intents || []).filter((intent) => intent.status === "needs-you" || intent.needs).length;
}

function renderRail() {
  const count = needsYouCount();
  rail.innerHTML = `
    <button class="logo" type="button" data-action="inbox" title="AI-DLC Workflows · Inbox" aria-label="AI-DLC Workflows home">A</button>
    <button type="button" data-action="inbox" class="${store.view.kind === "inbox" ? "on" : ""}" title="Inbox · ${count} need you" aria-label="Inbox, ${count} need you">
      ${ICONS.inbox}${count ? `<span class="rail-badge">${count}</span>` : ""}
    </button>
    <button type="button" data-action="workflow" class="${store.sidebar ? "on" : ""}" title="Workflow${store.sidebar ? " · visible" : " · hidden"}" aria-pressed="${store.sidebar}">
      ${ICONS.workflow}
    </button>
    <button type="button" data-action="search" title="Search or jump · ⌘K">${ICONS.search}</button>`;
}

function viewTitle(view, stage) {
  if (view.kind === "inbox") return "Inbox";
  if (view.kind === "overview") return `${stage?.name || titleCase(view.stage) || "Stage"} · overview`;
  if (view.kind === "questions") return basename(view.path || stage?.questions?.file || "Questions");
  if (view.kind === "artifact") return basename(view.path);
  return "AI-DLC Workflows";
}

function viewState(view, stage) {
  const time = stageTimestamp(stage);
  if (view.kind === "inbox") {
    const count = needsYouCount();
    return { label: count ? `${count} ${count === 1 ? "item" : "items"} need you` : "Nothing waiting", detail: "Every browser action remains available from the terminal.", tone: count ? "needs" : "ok" };
  }
  if (!stage) return { label: "Workflow unavailable", detail: "The terminal record remains complete.", tone: "quiet" };
  if (view.kind === "questions") {
    if (store.questionsState === "submitted" && isActiveIntent()) {
      return { label: "Answers sent", detail: "The agent is applying them and will confirm in the terminal; this page follows.", tone: "ok" };
    }
    if (isLiveQuestions(stage)) {
      const total = stage.questions?.total || 0;
      const open = Math.max(0, total - (stage.questions?.answered || 0)) || total;
      return { label: `${open} ${open === 1 ? "question" : "questions"} for you`, detail: "Answer here or edit the questions file in the terminal.", tone: "needs" };
    }
    return { label: `Answered${time ? ` · ${time}` : ""}`, detail: "Saved in the record; the terminal file is authoritative.", tone: "ok" };
  }
  if (sentDecision() && stage.state === "current" && (view.kind === "artifact" || view.kind === "overview")) {
    const sent = sentDecision();
    return sent.decision === "approve"
      ? { label: `Approved · r${revision(stage)}`, detail: "Sent — the agent is picking it up and moves to the next stage.", tone: "ok" }
      : { label: `Changes requested · r${revision(stage)}`, detail: "Sent — the agent is picking up your remarks; the gate reopens with the next revision.", tone: "ok" };
  }
  if (isLiveGate(stage) && (view.kind === "artifact" || view.kind === "overview")) {
    return { label: `Awaiting your review · r${revision(stage)}`, detail: "The agent continues after your decision here or in the terminal.", tone: "needs" };
  }
  if (stage.state === "done") return { label: `Done${time ? ` · ${time}` : ""}`, detail: "Read-only stage record.", tone: "ok" };
  if (stage.state === "skipped") return { label: "Skipped", detail: stage.reason || "Not part of this intent's scope.", tone: "quiet" };
  if (stage.state === "current" && stage.gate === "revising") {
    const sent = (stage.artifacts || []).reduce((total, artifact) => total + (artifact.threads || 0), 0);
    return { label: `Revising · r${revision(stage)}`, detail: sent ? `The agent is addressing your ${sent} ${sent === 1 ? "remark" : "remarks"}; the gate reopens when it is done.` : "The agent is addressing your request; the gate reopens when it is done.", tone: "needs" };
  }
  if (stage.state === "current") return { label: "In progress", detail: "The agent is working; this page updates when it needs you.", tone: "needs" };
  return { label: stage.state === "conditional" ? stage.condition || "Conditional" : "Later", detail: "This stage has not started.", tone: "quiet" };
}

function pickerItems(stage) {
  if (!stage) return [];
  const items = [];
  if (stage.questions?.file) items.push({ kind: "questions", path: stage.questions.file, label: "Questions" });
  for (const artifact of stageArtifacts(stage)) {
    if (artifact.path) items.push({ kind: "artifact", path: artifact.path, label: basename(artifact.path), missing: !artifact.exists });
  }
  if (stage.memory && !items.some((item) => item.path === stage.memory)) {
    items.push({ kind: "artifact", path: stage.memory, label: "memory.md" });
  }
  items.push({ kind: "overview", path: "", label: `${stage.name} · overview` });
  return items;
}

function renderPicker(view, stage, title) {
  const items = pickerItems(stage);
  if (!items.length || view.kind === "inbox") return `<strong class="header-title">${escapeHtml(title)}</strong>`;
  return `<details class="header-picker">
    <summary>${escapeHtml(title)} <span aria-hidden="true">▾</span></summary>
    <div class="header-picker-menu" role="menu">
      ${items
        .map(
          (item) => `<button type="button" role="menuitem" data-picker-kind="${item.kind}" data-picker-path="${escapeHtml(item.path)}" class="${item.kind === view.kind && (!item.path || item.path === view.path) ? "on" : ""}">
            <span>${escapeHtml(item.label)}</span>${item.missing ? '<small>not written yet</small>' : ""}
          </button>`,
        )
        .join("")}
    </div>
  </details>`;
}

function panelButtons(view) {
  if (view.kind !== "artifact") return "";
  return [
    ["threads", "Threads"],
    ["history", "History"],
    ["outline", "Outline"],
  ]
    .map(
      ([key, label]) => `<button type="button" class="header-icon ${store.panel === key ? "on" : ""}" data-panel="${key}" title="${label}" aria-label="${label}" aria-pressed="${store.panel === key}">${ICONS[key]}</button>`,
    )
    .join("");
}

function actionButton(label, action, primary = false) {
  return `<button type="button" class="${primary ? "btn primary" : "link"}" data-header-action="${action}">${escapeHtml(label)}</button>`;
}

function headerActions(view, stage) {
  if (!stage) return "";
  const artifact = firstArtifact(stage);
  if (view.kind === "artifact" && isLiveGate(stage)) {
    return `${actionButton("Request changes", "request-changes")}${actionButton("Approve", "approve", true)}`;
  }
  if (view.kind === "questions" && store.questionsState === "submitted" && isActiveIntent()) return "";
  if (view.kind === "questions" && isLiveQuestions(stage)) {
    return `${actionButton("Edit the file instead", "terminal-edit")}${actionButton("Save answers — the agent continues", "save-answers", true)}`;
  }
  if (view.kind === "questions") {
    return `${actionButton("Reopen round (terminal)", "terminal-reopen")}${artifact ? actionButton(`Open ${basename(artifact.path)}`, "open-artifact", true) : ""}`;
  }
  if (view.kind === "artifact" && (view.readOnly || stage.state !== "current")) {
    const current = currentStage();
    return `${actionButton("Add note", "add-note")}${current ? actionButton(`Back to ${current.name} →`, "open-current", true) : ""}`;
  }
  if (view.kind === "overview") {
    if (isLiveQuestions(stage)) {
      const total = Math.max(0, (stage.questions?.total || 0) - (stage.questions?.answered || 0)) || stage.questions?.total || 0;
      return actionButton(`Answer ${total} ${total === 1 ? "question" : "questions"} →`, "open-questions", true);
    }
    if (isLiveGate(stage)) {
      return `${artifact?.exists ? actionButton(`Open ${basename(artifact.path)}`, "open-artifact") : ""}${actionButton("Request changes", "request-changes")}${actionButton("Approve", "approve", true)}`;
    }
    if (artifact?.exists) return actionButton(`Open ${basename(artifact.path)}`, "open-artifact", true);
  }
  return "";
}

function renderHeader() {
  const view = store.view || { kind: "empty" };
  const workflow = store.workflow;
  const stage = stageForView(view, workflow);
  const title = viewTitle(view, stage);
  const state = viewState(view, stage);
  const space = workflow?.space || store.state?.space || "default";
  const intent = view.intent || workflow?.intent || store.state?.intent || "no intent";
  const phase = titleCase(stage?.phase || workflow?.phase || "workflow");
  const stageName = stage?.name || titleCase(stage?.slug || view.stage) || "record";
  const connectedTitle = store.connected ? "Connected to the local review daemon" : "Disconnected from the local review daemon; terminal workflow is still available";
  header.innerHTML = `
    <nav class="header-context" aria-label="Current view">
      <span class="header-path">${escapeHtml(space)} <i>›</i> ${escapeHtml(intent)} <i>›</i> ${escapeHtml(phase)} <i>›</i> ${escapeHtml(stageName)}</span>
      ${renderPicker(view, stage, title)}
    </nav>
    <div class="header-state ${state.tone}"><b>${escapeHtml(state.label)}</b><small>${escapeHtml(state.detail)}</small></div>
    <div class="header-tools">
      <span class="connection ${store.connected ? "connected" : "disconnected"}" title="${escapeHtml(connectedTitle)}" aria-label="${escapeHtml(connectedTitle)}"><i></i></span>
      ${panelButtons(view)}
      ${headerActions(view, stage)}
    </div>`;
}

function intentStatus(intent) {
  if (intent.needs?.kind === "questions") return intent.needs.label || "questions";
  if (intent.needs?.kind === "gate") return intent.needs.label || "awaiting review";
  if (intent.needs) return intent.needs.label || "needs you";
  if (intent.status === "done") return "done";
  if (intent.status === "in-progress") return "in progress";
  return intent.status === "idle" ? "idle" : String(intent.status || "in progress").replaceAll("-", " ");
}

function intentGroups() {
  const intents = store.workflow?.intents || [];
  return [
    ["Needs you", intents.filter((intent) => intent.status === "needs-you" || intent.needs)],
    ["In progress", intents.filter((intent) => intent.status === "in-progress" || intent.status === "idle")],
    ["Done", intents.filter((intent) => intent.status === "done")],
  ];
}

function renderInbox() {
  const visible = store.view.kind === "inbox";
  inbox.hidden = !visible;
  if (!visible) return;
  overview.hidden = true;
  empty.hidden = true;
  document.getElementById("viewer").hidden = true;
  document.getElementById("questions-view").hidden = true;
  const groups = intentGroups();
  if (!store.workflow) {
    inbox.innerHTML = '<div class="shell-placeholder"><b>Inbox unavailable</b><span>The workflow endpoint is not available yet. Your terminal record is unaffected.</span></div>';
    return;
  }
  inbox.innerHTML = `<div class="inbox-page">
    <div class="inbox-heading"><div><p>Workspace · ${escapeHtml(store.workflow.space || "default")}</p><h1>Inbox</h1><span>Human moments across every intent in this workspace.</span></div><b>${needsYouCount()} need you</b></div>
    ${groups
      .map(
        ([label, intents]) => `<section class="inbox-group"><h2>${label}<span>${intents.length}</span></h2>
          ${intents.length ? intents.map((intent) => `<button type="button" class="inbox-row" data-intent="${escapeHtml(intent.slug)}">
            <span class="intent-dot ${intent.status || "idle"}"></span>
            <span><b>${escapeHtml(intent.slug)}</b><small>${escapeHtml(titleCase(intent.current_stage) || intent.phase || "Record")}</small></span>
            <span class="inbox-status">${escapeHtml(intentStatus(intent))}</span>
          </button>`).join("") : '<p class="inbox-none">None</p>'}
        </section>`,
      )
      .join("")}
  </div>`;
}

function allSearchItems() {
  const workflow = store.workflow;
  const result = [];
  for (const intent of workflow?.intents || []) {
    result.push({ group: "Intents", label: intent.slug, meta: `${titleCase(intent.current_stage) || intent.phase || "record"} · ${intentStatus(intent)}`, action: () => selectIntent(intent.slug) });
  }
  for (const stage of stages(workflow)) {
    result.push({ group: "Stages", label: stage.name || titleCase(stage.slug), meta: `${stage.phase || "Workflow"} · ${stage.state || "later"}`, action: () => overviewView(stage) });
    for (const artifact of stageArtifacts(stage)) {
      if (artifact.path) result.push({ group: "Files", label: basename(artifact.path), meta: stage.name || titleCase(stage.slug), action: () => artifactView(stage, artifact) });
    }
    if (stage.memory && !(stage.artifacts || []).some((artifact) => artifact.path === stage.memory)) {
      result.push({ group: "Files", label: basename(stage.memory), meta: `${stage.name || titleCase(stage.slug)} · diary`, action: () => artifactView(stage, { path: stage.memory, name: basename(stage.memory), exists: true }) });
    }
  }
  result.push(
    { group: "Actions", label: "Open Inbox", meta: "What needs you", action: openInbox },
    { group: "Actions", label: store.sidebar ? "Hide Workflow" : "Show Workflow", meta: "⌘\\", action: () => store.set({ sidebar: !store.sidebar }) },
  );
  if (store.view.kind === "artifact") {
    result.push(
      { group: "Actions", label: "Show Threads", meta: "Right panel", action: () => store.set({ panel: "threads" }) },
      { group: "Actions", label: "Show History", meta: "Right panel", action: () => store.set({ panel: "history" }) },
      { group: "Actions", label: "Show Outline", meta: "Right panel", action: () => store.set({ panel: "outline" }) },
    );
  }
  return result;
}

function renderPalette(query = "") {
  const normalized = query.trim().toLowerCase();
  paletteItems = allSearchItems().filter((item) => !normalized || `${item.label} ${item.meta} ${item.group}`.toLowerCase().includes(normalized));
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  const grouped = new Map();
  paletteItems.forEach((item, index) => {
    if (!grouped.has(item.group)) grouped.set(item.group, []);
    grouped.get(item.group).push([item, index]);
  });
  search.innerHTML = `<div class="palette-box">
    <label><span>${ICONS.search}</span><input type="search" autocomplete="off" placeholder="Search intents, stages, files, actions…" value="${escapeHtml(query)}" aria-label="Search or jump"><kbd>⌘K</kbd></label>
    <div class="palette-results">${[...grouped]
      .map(([group, items]) => `<div class="palette-group"><h2>${escapeHtml(group)}</h2>${items.map(([item, index]) => `<button type="button" data-palette-index="${index}" class="${index === paletteIndex ? "on" : ""}"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.meta)}</small></button>`).join("")}</div>`)
      .join("") || '<p class="palette-empty">No matching destination</p>'}</div>
    <footer><span>↑↓ move</span><span>↵ open</span><span>esc close</span><b>The terminal stays complete.</b></footer>
  </div>`;
  const input = search.querySelector("input");
  input?.focus();
  input?.setSelectionRange(query.length, query.length);
}

function showPalette(open = true) {
  search.hidden = !open;
  if (open) {
    paletteIndex = 0;
    renderPalette("");
  } else search.innerHTML = "";
}

function openInbox() {
  store.set({ view: { kind: "inbox", path: null, intent: store.workflow?.intent || null, readOnly: false, stage: null }, panel: null });
}

async function selectIntent(slug) {
  showPalette(false);
  if (!slug || slug === store.workflow?.intent) {
    openCurrentThing();
    return;
  }
  try {
    const workflow = await api.get("/api/workflow", { intent: slug, space: store.workflow?.space });
    store.set({ workflow });
    openCurrentThing(workflow);
  } catch (error) {
    store.emit("notice", { message: `Could not open ${slug}: ${error.message}. The intent remains available from the terminal.`, kind: "error" });
  }
}

function handleHeaderAction(action) {
  const stage = stageForView();
  if (action === "approve" || action === "request-changes") store.emit("decide", action);
  else if (action === "save-answers") store.emit("save-answers");
  else if (action === "terminal-edit") store.emit("notice", { message: `Edit ${basename(stage?.questions?.file || "the questions file")} in the terminal; the browser is only a mirror.`, kind: "info" });
  else if (action === "terminal-reopen") store.emit("notice", { message: "Reopen the question round from the terminal so the canonical questions file stays authoritative.", kind: "info" });
  else if (action === "open-artifact") artifactView(stage, firstArtifact(stage, false));
  else if (action === "open-questions") questionsView(stage);
  else if (action === "open-current") openCurrentThing();
  else if (action === "add-note") {
    store.emit("notice", { message: "Add the note from the terminal so it is written to the record; this past artifact stays read-only.", kind: "info" });
  }
}

function handlePicker(button) {
  const stage = stageForView();
  const kind = button.dataset.pickerKind;
  const path = button.dataset.pickerPath;
  if (kind === "questions") questionsView(stage);
  else if (kind === "overview") overviewView(stage);
  else {
    const artifact = (stage?.artifacts || []).find((entry) => entry.path === path) || { path, name: basename(path), exists: true };
    artifactView(stage, artifact);
  }
}

function render() {
  renderRail();
  renderHeader();
  renderInbox();
  if (!store.workflow && store.view.kind === "empty") {
    empty.hidden = false;
    empty.innerHTML = '<div class="shell-placeholder"><b>Loading the workflow…</b><span>The terminal record remains available while the browser catches up.</span></div>';
  } else if (store.view.kind !== "empty") empty.hidden = true;
}

export function init() {
  rail = document.getElementById("rail");
  header = document.getElementById("header");
  search = document.getElementById("search");
  inbox = document.getElementById("inbox");
  overview = document.getElementById("overview");
  empty = document.getElementById("empty");

  rail.addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (action === "inbox") openInbox();
    else if (action === "workflow") store.set({ sidebar: !store.sidebar });
    else if (action === "search") store.emit("palette", true);
  });
  header.addEventListener("click", (event) => {
    const panel = event.target.closest("[data-panel]")?.dataset.panel;
    if (panel) store.set({ panel: store.panel === panel ? null : panel });
    const action = event.target.closest("[data-header-action]")?.dataset.headerAction;
    if (action) handleHeaderAction(action);
    const picker = event.target.closest("[data-picker-kind]");
    if (picker) handlePicker(picker);
  });
  inbox.addEventListener("click", (event) => {
    const slug = event.target.closest("[data-intent]")?.dataset.intent;
    if (slug) selectIntent(slug);
  });
  search.addEventListener("click", (event) => {
    if (event.target === search) showPalette(false);
    const index = Number(event.target.closest("[data-palette-index]")?.dataset.paletteIndex);
    if (Number.isInteger(index) && paletteItems[index]) {
      paletteItems[index].action();
      showPalette(false);
    }
  });
  search.addEventListener("input", (event) => {
    if (event.target.matches("input")) {
      paletteIndex = 0;
      renderPalette(event.target.value);
    }
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      showPalette(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      paletteIndex = (paletteIndex + delta + paletteItems.length) % Math.max(1, paletteItems.length);
      const query = search.querySelector("input")?.value || "";
      renderPalette(query);
    } else if (event.key === "Enter") {
      event.preventDefault();
      paletteItems[paletteIndex]?.action();
      showPalette(false);
    }
  });

  store.on("workflow", (workflow) => {
    if (workflow && store.view.kind === "empty") openCurrentThing(workflow);
    else render();
  });
  store.on("state", render);
  store.on("view", (view) => {
    if (view.kind !== "artifact" && store.panel !== null) store.set({ panel: null });
    render();
  });
  store.on("sidebar", renderRail);
  store.on("panel", renderHeader);
  store.on("connected", renderHeader);
  store.on("connection", renderHeader);
  store.on("annotations", renderHeader);
  store.on("questionsState", renderHeader);
  store.on("decisionSent", renderHeader);
  store.on("palette", showPalette);
  render();
}

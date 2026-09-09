// App rail, per-view header, inbox, and command palette.
import { api } from "./api.js";
import { decisionInFlight, relativeTime, setNotice, store } from "./store.js";
import { icon } from "./icons.js";
import { bindComposer, closeMenu as closeComposerMenu, renderComposer } from "./composer.js";

const ICONS = {
  inbox: icon("mailInbox", { size: 18 }),
  workflow: icon("flowchart", { size: 18 }),
  search: icon("search", { size: 18 }),
  threads: icon("comment", { size: 17 }),
  history: icon("history", { size: 17 }),
  outline: icon("textBulletListTree", { size: 17 }),
  agent: icon("flow", { size: 17 }),
  settings: icon("settings", { size: 17 }),
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

const SMALL_WORDS = new Set(["and", "or", "of", "the", "to", "in", "for"]);
function titleCase(value) {
  return String(value || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part, index) => {
      const word = part === part.toUpperCase() ? part.toLowerCase() : part;
      return index > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1);
    })
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

function workflowComplete(workflow = store.workflow) {
  const all = stages(workflow);
  return all.length > 0 && all.every((stage) => stage.state === "done" || stage.state === "skipped");
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

// The artifact a stage opens on: at a revised gate, the one carrying the
// reviewer's threads (that is where the conversation is); otherwise the
// stage's declared review artifact, else the first written one.
function firstArtifact(stage, existingOnly = true) {
  const artifacts = stageArtifacts(stage).filter((artifact) => !existingOnly || artifact.exists);
  if (!artifacts.length) return null;
  if (stage?.state === "current" && stage.gate) {
    const threaded = [...artifacts].filter((artifact) => artifact.threads > 0).sort((a, b) => b.threads - a.threads);
    if (threaded.length) return threaded[0];
  }
  const review = store.state?.manifest?.review_artifact;
  return artifacts.find((artifact) => review && artifact.path === review) || artifacts[0];
}

function isActiveIntent(workflow = store.workflow) {
  return !workflow?.intent || !store.state?.intent || workflow.intent === store.state.intent;
}

// The daemon's one-word answer to "what does the human do now". Every label,
// button and count below reads it; the client derives nothing of its own.
function phase() {
  return store.state?.phase ?? "idle";
}

// The decision already recorded for the open gate, until the hook delivers it:
// the gate reads as "sent", not live.
function sentDecision() {
  return decisionInFlight();
}

function isLiveGate(stage) {
  return Boolean(stage?.state === "current" && isActiveIntent() && phase() === "reviewing" && !sentDecision());
}

// The daemon reports a submission on its next push; `questionsState` bridges
// the moment between the click and that push.
function answersSubmitted() {
  return Boolean(store.state?.questions?.submitted) || store.questionsState === "submitted";
}

function isLiveQuestions(stage) {
  return Boolean(stage?.state === "current" && isActiveIntent() && phase() === "questions" && !answersSubmitted());
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
  return (store.workflow?.intents || []).filter((intent) => intent.status !== "requested" && (intent.status === "needs-you" || intent.needs)).length;
}

function requestedCount() {
  return (store.workflow?.intents || []).filter((intent) => intent.status === "requested").length;
}

function renderRail() {
  const count = needsYouCount();
  rail.innerHTML = `
    <button class="logo" type="button" data-action="inbox" title="AI-DLC Workflows · Inbox" aria-label="AI-DLC Workflows home">A</button>
    <button type="button" data-action="inbox" class="${store.view.kind === "inbox" ? "on" : ""}" title="Inbox · ${count} ${count === 1 ? "needs" : "need"} you" aria-label="Inbox, ${count} ${count === 1 ? "needs" : "need"} you">
      ${ICONS.inbox}${count ? `<span class="rail-badge">${count}</span>` : ""}
    </button>
    <button type="button" data-action="workflow" class="${store.sidebar ? "on" : ""}" title="Workflow${store.sidebar ? " · visible" : " · hidden"}" aria-pressed="${store.sidebar}">
      ${ICONS.workflow}
    </button>
    <button type="button" data-action="search" title="Search or jump · ⌘K">${ICONS.search}</button>
    <button type="button" class="rail-settings" data-action="settings" title="Settings" aria-label="Settings">${ICONS.settings}</button>`;
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
    return { label: count ? `${count} ${count === 1 ? "item needs" : "items need"} you` : "Nothing waiting", tone: count ? "needs" : "ok" };
  }
  if (!stage) return { label: "Workflow unavailable", tone: "quiet" };
  // A terminal checkpoint is stated wherever the human is looking, not only on
  // the Questions view: the terminal is waiting for them.
  if (phase() === "confirming" && stage.state === "current" && isActiveIntent()) {
    const where = (store.run?.pending || []).some((input) => input.kind === "question") ? "the Agent panel" : "the terminal";
    return { label: store.state?.checkpoint === "plan-approval" ? `Plan approval waiting in ${where}` : `Confirming in ${where}`, tone: "needs" };
  }
  if (view.kind === "questions") {
    if (stage.state === "current" && isActiveIntent()) {
      if (phase() === "questions" && answersSubmitted()) return { label: "Answers sent", tone: "ok" };
      if (phase() === "preparing") return { label: "Preparing your questions", tone: "quiet" };
      if (isLiveQuestions(stage)) {
        const total = stage.questions?.total || 0;
        const open = Math.max(0, total - (stage.questions?.answered || 0)) || total;
        return { label: `${open} ${open === 1 ? "question" : "questions"} for you`, tone: "needs" };
      }
    }
    return { label: "Answered", tone: "ok" };
  }
  if (sentDecision() && stage.state === "current" && (view.kind === "artifact" || view.kind === "overview")) {
    return sentDecision() === "approve"
      ? { label: `Approved · r${revision(stage)}`, tone: "ok" }
      : { label: `Changes requested · r${revision(stage)}`, tone: "ok" };
  }
  if (isLiveGate(stage) && (view.kind === "artifact" || view.kind === "overview")) return { label: `Awaiting your review · r${revision(stage)}`, tone: "needs" };
  if (stage.state === "done" && workflowComplete()) return { label: `Workflow complete${time ? ` · ${time}` : ""}`, tone: "ok" };
  if (stage.state === "done") return { label: `Done${time ? ` · ${time}` : ""}`, tone: "ok" };
  if (stage.state === "skipped") return { label: "Skipped", tone: "quiet" };
  if (stage.state === "current" && stage.gate === "revising") return { label: `Revising · r${revision(stage)}`, tone: "needs", working: true };
  if (stage.state === "current" && (store.workflow?.agent_status === "writing")) return { label: `Agent working on ${stage.name || titleCase(stage.slug)}`, tone: "needs", working: true };
  if (stage.state === "current") return { label: "In progress", tone: "needs" };
  return { label: stage.state === "conditional" ? stage.condition || "Conditional" : "Later", tone: "quiet" };
}

function pickerItems(stage) {
  if (!stage) return [];
  const items = [];
  if (stage.questions?.file) items.push({ kind: "questions", path: stage.questions.file, label: "Questions" });
  for (const artifact of stageArtifacts(stage)) {
    if (artifact.path) items.push({ kind: "artifact", path: artifact.path, label: basename(artifact.path), missing: !artifact.exists });
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
          (item) => `<button type="button" role="menuitem" data-picker-kind="${item.kind}" data-picker-path="${escapeHtml(item.path)}" class="${[item.kind === view.kind && (!item.path || item.path === view.path) ? "on" : "", item.missing ? "missing" : ""].filter(Boolean).join(" ")}">
            <span>${escapeHtml(item.label)}</span>
          </button>`,
        )
        .join("")}
    </div>
  </details>`;
}

function panelButtons(view) {
  if (view.kind === "inbox" || view.kind === "empty") return "";
  const buttons = view.kind === "artifact"
    ? [
        ["threads", "Threads"],
        ["history", "History"],
        ["outline", "Outline"],
      ]
    : [];
  // The agent panel follows the intent, not the document: the daemon's run for
  // this intent is reachable from its overview, its questions, and its artifacts.
  if (store.workflow?.runner || store.run?.run) buttons.push(["agent", "Agent"]);
  return buttons
    .map(([key, label]) => {
      const run = key === "agent" ? store.run?.run : null;
      const pending = key === "agent" ? store.run?.pending?.length || 0 : 0;
      const badge = pending
        ? `<em class="header-badge attention">${pending}</em>`
        : run && (run.state === "running" || run.state === "starting")
          ? '<i class="spin" aria-hidden="true"></i>'
          : "";
      const title = pending ? `${label} · ${pending} waiting for you` : label;
      return `<button type="button" class="header-icon ${store.panel === key ? "on" : ""} ${badge ? "badged" : ""}" data-panel="${key}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" aria-pressed="${store.panel === key}">${ICONS[key]}${badge}</button>`;
    })
    .join("");
}

// Pending remarks decide the gate's primary verb. Edits, deletes, and comments
// are requests: the agent has to act on them, so "Send N changes" leads and
// Approve steps back. Looks-good remarks and general notes ride along with
// either decision, so with only those (or nothing) Approve leads.
export function pendingChangeCount() {
  return (store.annotations || []).filter((item) => item.kind === "edit" || item.kind === "delete" || item.kind === "comment").length;
}

function gateActions() {
  const changes = pendingChangeCount();
  if (changes > 0) {
    // A paper plane and one word; the count and what happens next are the tooltip.
    const title = `Send ${changes} ${changes === 1 ? "change" : "changes"} to the agent — it revises and reopens the gate`;
    return `${actionButton("Approve anyway", "approve")}${actionButton("Send", "request-changes", true, { icon: "send", title, count: changes })}`;
  }
  return `${actionButton("Request changes", "request-changes")}${actionButton("Approve", "approve", true)}`;
}

function actionButton(label, action, primary = false, { icon: iconName = null, title = "", count = 0 } = {}) {
  const glyph = iconName ? icon(iconName, { size: 14 }) : "";
  const badge = count ? `<span class="btn-count">${count}</span>` : "";
  return `<button type="button" class="${primary ? "btn primary" : "link"}${iconName ? " btn-icon" : ""}" data-header-action="${action}"${title ? ` title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"` : ""}>${glyph}<span>${escapeHtml(label)}</span>${badge}</button>`;
}

function headerActions(view, stage) {
  if (!stage) return "";
  const artifact = firstArtifact(stage);
  if (view.kind === "artifact" && isLiveGate(stage)) return gateActions();
  if (view.kind === "questions" && answersSubmitted() && isActiveIntent()) return "";
  if (view.kind === "questions" && isLiveQuestions(stage)) {
    return actionButton("Save", "save-answers", true);
  }
  if (view.kind === "questions") {
    return artifact ? actionButton(`Open ${basename(artifact.path)}`, "open-artifact", true) : "";
  }
  if (view.kind === "artifact" && (view.readOnly || stage.state !== "current")) {
    const current = currentStage();
    const showBack = current && current.slug !== stage.slug && !workflowComplete();
    return `${actionButton("Add note", "add-note")}${showBack ? actionButton(`Back to ${current.name} →`, "open-current", true) : ""}`;
  }
  if (view.kind === "overview") {
    if (isLiveQuestions(stage)) {
      const total = Math.max(0, (stage.questions?.total || 0) - (stage.questions?.answered || 0)) || stage.questions?.total || 0;
      return actionButton(`Answer ${total} ${total === 1 ? "question" : "questions"} →`, "open-questions", true);
    }
    if (isLiveGate(stage)) {
      return `${artifact?.exists ? actionButton(`Open ${basename(artifact.path)}`, "open-artifact") : ""}${gateActions()}`;
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
    <div class="header-state ${state.tone}${state.working ? " working" : ""}"><b>${state.working ? `<i class="spin" aria-hidden="true"></i>` : ""}${escapeHtml(state.label)}</b></div>
    <div class="header-tools">
      <span class="connection ${store.connected ? "connected" : "disconnected"}" title="${escapeHtml(connectedTitle)}" aria-label="${escapeHtml(connectedTitle)}"><i></i></span>
      ${panelButtons(view)}
      ${headerActions(view, stage)}
    </div>`;
}

function runLabel(intent) {
  switch (intent.run) {
    case "starting":
    case "running":
      return "agent working";
    case "waiting":
      return "agent needs you";
    default:
      return null;
  }
}

function intentStatus(intent) {
  const running = runLabel(intent);
  if (running) return running;
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
    ["Requested", intents.filter((intent) => intent.status === "requested")],
    ["Needs you", intents.filter((intent) => intent.status !== "requested" && (intent.status === "needs-you" || intent.needs || intent.run === "waiting"))],
    ["In progress", intents.filter((intent) => (intent.status === "in-progress" || intent.status === "idle") && intent.run !== "waiting")],
    ["Done", intents.filter((intent) => intent.status === "done")],
  ];
}

function renderInbox() {
  const visible = store.view.kind === "inbox";
  inbox.hidden = !visible;
  if (!visible) {
    closeComposerMenu();
    return;
  }
  overview.hidden = true;
  empty.hidden = true;
  document.getElementById("viewer").hidden = true;
  document.getElementById("questions-view").hidden = true;
  const groups = intentGroups();
  if (!store.workflow) {
    inbox.innerHTML = '<div class="shell-placeholder"><b>Inbox unavailable</b><span>The workflow endpoint is not available yet. Your terminal record is unaffected.</span></div>';
    return;
  }
  const needs = needsYouCount();
  const total = (store.workflow.intents || []).length;
  const requestedRow = (intent) => `<div class="inbox-row requested" data-request="${escapeHtml(intent.request?.id || intent.slug)}">
      <span class="intent-dot requested"></span>
      <span class="inbox-main"><b>${escapeHtml(intent.request?.text || intent.label)}</b><small>${escapeHtml(intent.scope ? `${intent.scope} workflow` : "composer decides the workflow")}${intent.request?.effort ? ` · ${escapeHtml(intent.request.effort)} effort` : ""}<em> · ${escapeHtml(relativeTime(intent.updated_at))}</em></small></span>
      <span class="inbox-status requested" title="Nothing runs until a session picks this up: type /aidlc in your terminal">Waiting · type <code>/aidlc</code> in the terminal</span>
      <button type="button" class="inbox-withdraw" data-withdraw="${escapeHtml(intent.request?.id || intent.slug)}" title="Withdraw this request" aria-label="Withdraw this request">${icon("dismiss", { size: 13 })}</button>
    </div>`;
  const row = (intent) => {
    if (intent.status === "requested") return requestedRow(intent);
    const where = [intent.phase ? titleCase(intent.phase) : null, intent.current_stage ? titleCase(intent.current_stage) : null].filter(Boolean).join(" · ");
    const meta = [intent.scope ? `${intent.scope}${intent.depth ? ` · ${intent.depth.toLowerCase()}` : ""}` : null, relativeTime(intent.updated_at)].filter(Boolean).join(" · ");
    return `<button type="button" class="inbox-row ${intent.status || "idle"}" data-intent="${escapeHtml(intent.slug)}">
      <span class="intent-dot ${intent.status || "idle"}"></span>
      <span class="inbox-main"><b>${escapeHtml(intent.label || intent.slug)}</b><small>${escapeHtml(where || "Record")}${meta ? `<em> · ${escapeHtml(meta)}</em>` : ""}</small></span>
      <span class="inbox-status ${intent.needs || intent.run === "waiting" ? "needs" : ""}">${intent.run === "running" || intent.run === "starting" ? '<i class="spin" aria-hidden="true"></i>' : ""}${escapeHtml(intentStatus(intent))}</span>
      <span class="inbox-go">${icon("chevronDown", { size: 14 })}</span>
    </button>`;
  };
  inbox.innerHTML = `<div class="inbox-page">
    ${renderComposer()}
    <section class="inbox-list">
      <header class="inbox-heading">
        <h1>Inbox</h1>
        <span class="inbox-tagline">${total ? `${total} ${total === 1 ? "intent" : "intents"} in this workspace` : "Human moments across every intent in this workspace"}</span>
        <b class="${needs ? "needs" : ""}">${needs ? `${needs} ${needs === 1 ? "needs" : "need"} you` : requestedCount() ? `${requestedCount()} requested` : "Nothing waiting"}</b>
      </header>
      ${total === 0
        ? `<div class="inbox-empty">${icon("mailInbox", { size: 22 })}<b>No intents yet</b><span>Describe what you want to build above. Everything that needs a decision from you will land here.</span></div>`
        : groups.filter(([, intents]) => intents.length).map(([label, intents]) => `<section class="inbox-group ${label === "Needs you" ? "needs" : label === "Requested" ? "requested" : ""}"><h2>${label}<span>${intents.length}</span></h2>${intents.map(row).join("")}</section>`).join("")}
    </section>
  </div>`;
  bindComposer(inbox, renderInbox);
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
      { group: "Actions", label: "Show Agent", meta: "Right panel", action: () => store.set({ panel: "agent" }) },
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
    else if (action === "settings") store.emit("open-settings", "models");
  });
  header.addEventListener("click", (event) => {
    const panel = event.target.closest("[data-panel]")?.dataset.panel;
    if (panel) store.set({ panel: store.panel === panel ? null : panel });
    const action = event.target.closest("[data-header-action]")?.dataset.headerAction;
    if (action) handleHeaderAction(action);
    const picker = event.target.closest("[data-picker-kind]");
    if (picker) handlePicker(picker);
  });
  inbox.addEventListener("click", async (event) => {
    const withdraw = event.target.closest("[data-withdraw]")?.dataset.withdraw;
    if (withdraw) {
      try {
        await api.delete("/api/intents", { id: withdraw });
        setNotice("Request withdrawn.", "info");
        store.emit("wants-refresh");
      } catch (error) {
        setNotice(`Could not withdraw: ${error.message}`, "error");
      }
      return;
    }
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
    // Document panels belong to a document; the agent panel stays with the
    // intent, so only the inbox and the empty view close it.
    const keep = store.panel === "agent" && view.kind !== "inbox" && view.kind !== "empty";
    if (view.kind !== "artifact" && store.panel !== null && !keep) store.set({ panel: null });
    render();
  });
  store.on("run", renderHeader);
  store.on("composer-rerender", () => {
    if (store.view.kind === "inbox") renderInbox();
  });
  store.on("select-intent", async (slug) => {
    await selectIntent(slug);
    store.set({ panel: "agent" });
  });
  store.on("sidebar", renderRail);
  store.on("panel", renderHeader);
  store.on("connected", renderHeader);
  store.on("connection", renderHeader);
  store.on("annotations", renderHeader);
  store.on("questionsState", renderHeader);
  store.on("palette", showPalette);
  render();
}

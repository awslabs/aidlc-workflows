// Workflow panel and stage overview.
import { api } from "./api.js";
import { store } from "./store.js";
import { icon } from "./icons.js";

const BOOK_ICON = icon("book", { size: 14 });
const FILE_ICON = icon("documentText", { size: 14 });
const QUESTION_ICON = icon("question", { size: 14 });

let panel;
let overview;
let viewer;
let questions;
let inbox;
let empty;
let intentPopover = false;
let collapseAll = false;
let expandAll = false;
const collapsedPhases = new Set();
let filesMode = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function basename(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "file";
}

function titleCase(value) {
  return String(value || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}


function stages(workflow = store.workflow) {
  return (workflow?.phases || []).flatMap((phase) => phase.stages || []);
}

/** The viewed intent is the record the daemon reports active (writes are allowed only there). */
function isActiveIntent(workflow = store.workflow) {
  return !workflow?.intent || !store.state?.intent || workflow.intent === store.state.intent;
}

function findStage(slug, workflow = store.workflow) {
  return stages(workflow).find((stage) => stage.slug === slug) || null;
}

function currentStage(workflow = store.workflow) {
  return stages(workflow).find((stage) => stage.state === "current") || findStage(store.state?.current?.stage || store.state?.current_stage, workflow);
}

function isQuestionsArtifact(artifact) {
  return /-questions(?:\.[^.]+)?$/i.test(basename(artifact?.path || artifact?.name));
}

function stageArtifacts(stage) {
  return (stage?.artifacts || []).filter(
    (artifact) => artifact.path !== stage?.questions?.file && !isQuestionsArtifact(artifact),
  );
}

function firstArtifact(stage, existingOnly = true) {
  return stageArtifacts(stage).find((artifact) => !existingOnly || artifact.exists) || null;
}

function artifactView(stage, artifact, intent = store.workflow?.intent) {
  if (!stage || !artifact?.path) return;
  filesMode = false;
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
  filesMode = false;
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
  filesMode = false;
  store.set({
    view: { kind: "overview", path: null, intent: intent || null, readOnly: stage.state !== "current", stage: stage.slug },
    panel: null,
  });
}

function openWorkflow(workflow = store.workflow) {
  const stage = currentStage(workflow);
  if (!stage) {
    store.set({ view: { kind: "inbox", path: null, intent: workflow?.intent || null, readOnly: false, stage: null }, panel: null });
  } else if (stage.questions?.open) questionsView(stage, workflow?.intent);
  else {
    const artifact = firstArtifact(stage);
    if (artifact) artifactView(stage, artifact, workflow?.intent);
    else overviewView(stage, workflow?.intent);
  }
}

function statusLabel(stage) {
  if (stage.state === "done") return "done";
  if (stage.state === "current") {
    if (stage.questions?.open) return "questions";
    if (stage.gate === "awaiting-approval" || store.state?.current?.state === "awaiting-approval") return `in review · r${stage.revision ?? store.state?.current?.revision ?? 0}`;
    if (stage.gate === "revising") return "revising";
    return "current";
  }
  if (stage.state === "skipped") return stage.reason ? `skipped · ${stage.reason}` : "skipped";
  if (stage.state === "conditional") return "conditional";
  return stage.state === "pending" ? "later" : stage.state || "later";
}

function glyph(stage) {
  if (stage.state === "done") return "✓";
  if (stage.state === "current") return "●";
  if (stage.state === "conditional") return "?";
  return "";
}

function stageClass(stage) {
  if (stage.state === "current") return "current";
  if (stage.state === "pending" || stage.state === "next") return "later";
  return stage.state || "later";
}

function isSelected(stage, kind, path) {
  const view = store.view;
  if (view?.stage !== stage.slug && path !== view?.path) return false;
  if (kind === "overview") return view?.kind === "overview";
  return view?.kind === kind && (!path || view.path === path);
}

function questionChild(stage) {
  const data = stage.questions;
  if (!data?.file || Number(data.total || 0) === 0) return "";
  const answered = Number(data.answered || 0);
  const total = Number(data.total || 0);
  const open = Math.max(0, total - answered) || total;
  const meta = data.open ? `<span class="open-pill">${open} open</span>` : `<b>${answered} / ${total}</b> answered`;
  const selected = isSelected(stage, "questions", data.file);
  return `<button type="button" class="workflow-child questions ${selected ? "on" : ""} ${stage.state !== "current" ? "past" : ""}" data-child-kind="questions" data-stage="${escapeHtml(stage.slug)}" data-path="${escapeHtml(data.file)}">
    <span class="child-icon ${!data.open && total && answered >= total ? "complete" : ""}">${QUESTION_ICON}</span>
    <span class="child-label">Questions</span><span class="child-meta">${meta}</span>
  </button>`;
}

function artifactChild(stage, artifact) {
  if (!artifact.path) return "";
  const selected = isSelected(stage, "artifact", artifact.path);
  const revision = artifact.revision == null ? "" : `<b>r${artifact.revision}</b>`;
  const threads = artifact.threads ? `${artifact.threads} ${artifact.threads === 1 ? "thread" : "threads"}` : "";
  const writtenAfter = !artifact.exists && stage.questions?.open ? "written after your answers" : "not written yet";
  const meta = artifact.exists ? [revision, threads].filter(Boolean).join(" · ") : writtenAfter;
  return `<button type="button" class="workflow-child artifact ${selected ? "on" : ""} ${stage.state !== "current" ? "past" : ""} ${!artifact.exists ? "missing" : ""}" data-child-kind="artifact" data-stage="${escapeHtml(stage.slug)}" data-path="${escapeHtml(artifact.path)}" ${!artifact.exists ? 'title="Not written yet"' : ""}>
    <span class="child-icon">${FILE_ICON}</span><span class="child-label"><code>${escapeHtml(basename(artifact.path))}</code></span><span class="child-meta">${meta}</span>
  </button>`;
}


function upcomingHint(stage) {
  const names = (stage.produces?.length ? stage.produces : stageArtifacts(stage).map((artifact) => artifact.path)).map(basename);
  const produces = names.length ? `produce ${naturalList(names)}` : "produce its record";
  return `<div class="workflow-child hint"><span></span><span>Will ask its questions, then ${escapeHtml(produces)}.</span></div>`;
}

function naturalList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function stageChildren(stage) {
  if (stage.state === "conditional" && !stage.questions && !(stage.artifacts || []).some((artifact) => artifact.exists)) return "";
  if (stage.state === "skipped") {
    return `<div class="workflow-children"><div class="workflow-child hint"><span></span><span>${escapeHtml(stage.reason || "Not in this intent's scope")} — nothing produced.</span></div></div>`;
  }
  if ((stage.state === "next" || stage.state === "pending") && !stage.questions?.file && !(stage.artifacts || []).some((artifact) => artifact.exists)) {
    return `<div class="workflow-children">${upcomingHint(stage)}</div>`;
  }
  const artifacts = stageArtifacts(stage).map((artifact) => artifactChild(stage, artifact)).join("");
  return `<div class="workflow-children">${questionChild(stage)}${artifacts}</div>`;
}

function renderStage(stage) {
  const classes = stageClass(stage);
  const open = !collapseAll && (expandAll || stage.state === "current");
  return `<details class="workflow-stage ${classes}" data-stage-details="${escapeHtml(stage.slug)}" ${open ? "open" : ""}>
    <summary><span class="stage-glyph">${glyph(stage)}</span><button type="button" class="stage-name" data-stage-overview="${escapeHtml(stage.slug)}">${escapeHtml(stage.name || titleCase(stage.slug))}</button><span class="stage-status">${escapeHtml(statusLabel(stage))}</span><span class="stage-chevron">▾</span></summary>
    ${stageChildren(stage)}
  </details>`;
}

function phaseSummary(phase) {
  const list = phase.stages || [];
  const counts = {
    done: list.filter((stage) => stage.state === "done").length,
    skipped: list.filter((stage) => stage.state === "skipped").length,
    current: list.filter((stage) => stage.state === "current").length,
    conditional: list.filter((stage) => stage.state === "conditional").length,
  };
  if (phase.skipped_by_scope) return `not in ${store.workflow?.scope || "this"} scope · ${phase.skipped_count || list.length} skipped`;
  if (counts.done === list.length && list.length) return "all done";
  const parts = [];
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.current) parts.push(`${counts.current} active`);
  if (counts.done) parts.push(`${counts.done} done`);
  if (!parts.length && counts.conditional) parts.push("conditional");
  return parts.join(" · ") || "not started";
}

function renderPhase(phase) {
  if (phase.skipped_by_scope) {
    return `<section class="workflow-phase scope-skipped" data-phase="${escapeHtml(phase.name)}">
      <button type="button" class="phase-heading" disabled title="This phase is outside the selected scope"><span class="phase-chevron"></span><b>${escapeHtml(phase.name)}</b><span class="phase-summary">· ${escapeHtml(phaseSummary(phase))}</span></button>
    </section>`;
  }
  const allStages = phase.stages || [];
  const scopeSkipped = allStages.filter((stage) => {
    if (stage.state !== "skipped") return false;
    const reason = String(stage.reason || "").toLowerCase();
    return reason.includes("scope");
  });
  const visibleStages = allStages.filter((stage) => !scopeSkipped.includes(stage));
  const foldedNames = scopeSkipped.map((stage) => stage.name || titleCase(stage.slug)).join(", ");
  const folded = scopeSkipped.length
    ? `<div class="scope-skipped-more" title="${escapeHtml(foldedNames)}">${scopeSkipped.length} more · not in ${escapeHtml(store.workflow?.scope || "this")} scope</div>`
    : "";
  const closed = collapseAll || (!expandAll && collapsedPhases.has(phase.name));
  const done = allStages.filter((stage) => stage.state === "done").length;
  const total = allStages.filter((stage) => stage.state !== "skipped").length;
  return `<section class="workflow-phase ${closed ? "closed" : ""}" data-phase="${escapeHtml(phase.name)}">
    <button type="button" class="phase-heading" data-phase-toggle="${escapeHtml(phase.name)}" aria-expanded="${!closed}"><span class="phase-chevron">▾</span><b>${escapeHtml(phase.name)}</b><span class="phase-summary">· ${escapeHtml(phaseSummary(phase))}</span><span class="phase-count">${done} / ${total}</span></button>
    <div class="phase-stages">${visibleStages.map(renderStage).join("")}${folded}</div>
  </section>`;
}

function intentStatus(intent) {
  if (intent.needs?.label) return intent.needs.label;
  if (intent.status === "needs-you") return "needs you";
  if (intent.status === "in-progress") return "in progress";
  return intent.status || "idle";
}

function renderIntentGroup(label, items) {
  return `<div class="intent-group"><h3>${label}</h3>${items.length
    ? items
        .map(
          (intent) => `<button type="button" class="intent-row ${intent.slug === store.workflow?.intent ? "on" : ""}" data-intent="${escapeHtml(intent.slug)}">
        <span class="intent-dot ${escapeHtml(intent.status || "idle")}"></span><span><b>${escapeHtml(intent.slug)}</b><small>${escapeHtml(titleCase(intent.current_stage) || intent.phase || "record")}</small></span><em>${escapeHtml(intentStatus(intent))}</em>
      </button>`,
        )
        .join("")
    : '<p class="intent-group-empty">None</p>'}</div>`;
}

function renderIntentPopover(workflow) {
  const intents = workflow.intents || [];
  const needs = intents.filter((intent) => intent.status === "needs-you" || intent.needs);
  const progress = intents.filter((intent) => intent.status === "in-progress" || intent.status === "idle");
  const done = intents.filter((intent) => intent.status === "done");
  const spaces = workflow.spaces || [];
  return `<div class="intent-popover" role="listbox" aria-label="Intents in ${escapeHtml(workflow.space || "default")}" ${intentPopover ? "" : "hidden"}>
    ${renderIntentGroup("Needs you", needs)}${renderIntentGroup("In progress", progress)}${renderIntentGroup("Done", done)}
    <div class="intent-popover-footer"><button type="button" disabled title="create intents from the terminal">+ New intent…</button>
    ${spaces.length > 1 ? `<button type="button" data-switch-workspace title="Switch workspaces from the terminal"><span><b>Switch workspace</b><small>${escapeHtml(workflow.space)} · ${spaces.length - 1} other</small></span><em>›</em></button>` : ""}</div>
  </div>`;
}

function renderPanel() {
  const workflow = store.workflow;
  if (!workflow) {
    panel.innerHTML = `<div class="workflow-placeholder"><b>Workflow unavailable</b><span>The browser could not load <code>/api/workflow</code>. Continue from the terminal; no workflow state is lost.</span></div>`;
    return;
  }
  const phaseList = workflow.phases || [];
  const stageTotal = workflow.stages_total ?? stages(workflow).filter((stage) => stage.state !== "skipped").length;
  const stageDone = workflow.stages_done ?? stages(workflow).filter((stage) => stage.state === "done").length;
  const current = currentStage(workflow);
  const intent = workflow.intents?.find((entry) => entry.slug === workflow.intent);
  const phase = titleCase(String(workflow.phase || current?.phase || "Workflow").toLowerCase());
  panel.innerHTML = `<div class="workflow-context">
    <button type="button" class="intent-selector ${intentPopover ? "open" : ""}" data-intent-selector aria-expanded="${intentPopover}">
      <small>${escapeHtml(workflow.space || "default")} · intent</small><strong>${escapeHtml(workflow.intent || "No active intent")}</strong>
      <span title="${escapeHtml(`${workflow.scope || intent?.scope || "scope unknown"} · ${workflow.depth || intent?.depth || "depth unknown"} · ${phase} · ${stageDone} / ${stageTotal} stages`)}">${escapeHtml(workflow.scope || intent?.scope || "scope unknown")} · ${escapeHtml(workflow.depth || intent?.depth || "depth unknown")} · ${escapeHtml(phase)}</span><i>▾</i>
    </button>${renderIntentPopover(workflow)}
  </div>
  <div class="workflow-bar"><b>Stages</b><span>${stageTotal} · ${stageDone} done</span><button type="button" data-collapse-all>${collapseAll ? "Expand all" : "Collapse all"}</button></div>
  <div class="workflow-tree">${phaseList.length ? phaseList.map(renderPhase).join("") : '<div class="workflow-tree-empty">No stages reported yet. The terminal workflow remains available.</div>'}</div>
  <footer class="workflow-footer"><button type="button" data-all-files>All files</button><span class="audit-note" title="The audit ledger stays in the terminal record: aidlc/spaces/${escapeHtml(workflow.space || "default")}/intents/${escapeHtml(workflow.intent || "…")}/audit/">Audit in record</span></footer>`;
}

function overviewLead(stage) {
  if (stage.description) return stage.description;
  if (stage.state === "skipped") return stage.reason || `This stage is outside ${store.workflow?.scope || "the selected"} scope.`;
  return `${stage.name || titleCase(stage.slug)} is part of the ${titleCase(stage.phase || "workflow")} phase for this ${store.workflow?.scope || "selected"}-scope intent.`;
}

function previousArtifacts(stage) {
  const list = stages();
  const index = list.indexOf(stage);
  const results = [];
  for (let i = index - 1; i >= 0 && results.length < 4; i -= 1) {
    for (const artifact of stageArtifacts(list[i])) {
      if (artifact.exists) results.push({ ...artifact, stage: list[i] });
      if (results.length >= 4) break;
    }
  }
  return results;
}

function nextStages(stage) {
  const list = stages();
  const index = list.indexOf(stage);
  return index < 0 ? [] : list.slice(index + 1).filter((candidate) => candidate.state !== "skipped").slice(0, 4);
}

function questionArtifact(stage) {
  return (stage?.artifacts || []).find(
    (artifact) => artifact.produces && isQuestionsArtifact(artifact) && !artifact.exists,
  );
}

function cardList(items, emptyText, renderer) {
  return items.length ? `<ul>${items.map(renderer).join("")}</ul>` : `<p class="overview-placeholder">${escapeHtml(emptyText)}</p>`;
}

function renderOverview() {
  if (store.view.kind !== "overview") {
    overview.hidden = true;
    return;
  }
  overview.hidden = false;
  viewer.hidden = true;
  questions.hidden = true;
  inbox.hidden = true;
  empty.hidden = true;
  if (filesMode) return;
  const stage = findStage(store.view.stage);
  if (!stage) {
    overview.innerHTML = '<div class="workflow-placeholder"><b>Stage unavailable</b><span>This stage is not present in the current workflow projection. Check the terminal record for the authoritative state.</span></div>';
    return;
  }
  const plannedQuestions = questionArtifact(stage);
  const asks = stage.questions?.file ? [stage.questions] : [];
  const produces = stageArtifacts(stage).length ? stageArtifacts(stage) : (stage.produces || []).filter((name) => !/-questions(?:\.[^.]+)?$/i.test(basename(name))).map((name) => ({ name: basename(name), path: name, exists: false }));
  const prior = previousArtifacts(stage);
  const next = nextStages(stage);
  const live = stage.state === "current";
  overview.innerHTML = `<div class="stage-overview-page">
    <h1>${escapeHtml(stage.name || titleCase(stage.slug))}${live ? `<span>${stage.questions?.open ? `${Math.max(0, (stage.questions.total || 0) - (stage.questions.answered || 0)) || stage.questions.total || 0} questions for you` : "Live stage"}</span>` : ""}</h1>
    <p class="overview-lead">${escapeHtml(overviewLead(stage))}</p>
    <div class="overview-grid">
      <section class="overview-card ${stage.questions?.open ? "hot" : ""}"><h2>Asks first</h2>${asks.length ? cardList(asks, "", (question) => `<li><span>${QUESTION_ICON}</span><code>${escapeHtml(basename(question.file))}</code><em>${question.open ? `${Math.max(0, (question.total || 0) - (question.answered || 0)) || question.total || 0} open` : `${question.answered || 0} / ${question.total || 0} answered`}</em></li>`) : plannedQuestions ? `<p>Asks its questions first (<code>${escapeHtml(basename(plannedQuestions.path))}</code>).</p>` : `<p class="overview-placeholder">${stage.state === "skipped" ? "Nothing — this stage is skipped." : "No question round is expected."}</p>`}</section>
      <section class="overview-card"><h2>Will produce</h2>${cardList(produces, "No artifact is declared for this stage.", (artifact) => `<li><span>${FILE_ICON}</span><code>${escapeHtml(basename(artifact.path))}</code><em class="${artifact.exists ? "ready" : ""}">${artifact.exists ? `r${artifact.revision ?? "0"}` : "planned"}</em></li>`)}</section>
      <section class="overview-card"><h2>Builds on</h2>${cardList(prior, "The workflow record and prior human decisions.", (artifact) => `<li><span>${FILE_ICON}</span><code>${escapeHtml(basename(artifact.path))}</code><em class="ready">${escapeHtml(artifact.stage.name || titleCase(artifact.stage.slug))}</em></li>`)}</section>
      <section class="overview-card then-card"><h2>Then</h2>${next.length ? `<ul>${next.map((candidate) => `<li><span class="stage-glyph ${escapeHtml(stageClass(candidate))}">${glyph(candidate)}</span><span class="then-label"><b>${escapeHtml(candidate.name || titleCase(candidate.slug))}</b>${candidate.state === "conditional" ? `<small> · ${escapeHtml(candidate.condition || "conditional")}</small>` : `<small> · ${escapeHtml(statusLabel(candidate))}</small>`}</span></li>`).join("")}</ul>` : '<p>This is the final stage in the projected workflow.</p>'}</section>
    </div>
    ${stage.memory ? `<details class="stage-diary"><summary><span>${BOOK_ICON}</span><b>Diary</b><small>the agent's interpretations, deviations, trade-offs, and open questions while ${escapeHtml(stage.name || titleCase(stage.slug))} runs</small></summary><div class="diary-body"><p class="overview-placeholder">Reading…</p></div></details>` : ""}
    <aside class="scope-note"><b>${escapeHtml(store.workflow?.scope || "Selected")} scope</b> · ${escapeHtml(store.workflow?.depth || "Depth not reported")} depth. This projection comes from the compiled workflow graph and record; use the terminal for every equivalent action.</aside>
  </div>`;
  const diary = overview.querySelector(".stage-diary");
  if (diary) diary.addEventListener("toggle", () => { if (diary.open) loadDiary(diary, stage); }, { once: true });
}

/** The diary is read on demand: it is the agent's working notes, not a review target. */
async function loadDiary(details, stage) {
  const body = details.querySelector(".diary-body");
  try {
    const rendered = await api.get("/api/render", { path: stage.memory, intent: store.workflow?.intent || undefined });
    const entries = (rendered.source || "").split("\n").filter((line) => /^\s*-\s+\d{4}-\d{2}-\d{2}T/.test(line)).length;
    if (!entries) {
      body.innerHTML = '<p class="overview-placeholder">Nothing recorded yet. Entries appear here as the agent makes a call the stage prose left open, departs from it, or weighs alternatives; at the approval gate they are offered back as candidate learnings.</p>';
      return;
    }
    body.innerHTML = `<div class="diary-entries">${(rendered.blocks || []).map((block) => block.html).join("")}</div>`;
  } catch (error) {
    body.innerHTML = `<p class="overview-placeholder">Diary unavailable: ${escapeHtml(error.message)}. It stays in the terminal record at <code>${escapeHtml(stage.memory)}</code>.</p>`;
  }
}

/**
 * The files a human edits or reviews: each stage's questions file and produced
 * artifacts. Not the stage memory (the agent's diary, folded on the overview),
 * and nothing the engine keeps for itself (graph caches, tokens, guides
 * rendered inside Questions). Grouped in workflow order.
 */
function reviewableRows(entries) {
  const byPath = new Map((entries || []).filter((entry) => entry.type === "file").map((entry) => [entry.path, entry]));
  const groups = [];
  for (const stage of stages()) {
    const rows = [];
    const add = (path, role) => {
      const entry = path ? byPath.get(path) : null;
      if (entry && !rows.some((row) => row.path === path)) rows.push({ path, role, entry });
    };
    add(stage.questions?.file, "Questions");
    for (const artifact of stage.artifacts || []) add(artifact.path, "Artifact");
    if (rows.length) groups.push({ stage, rows });
  }
  return groups;
}

function treeRows(entries) {
  const groups = reviewableRows(entries);
  if (!groups.length) return '<p class="overview-placeholder">Nothing to review yet. Files appear here as stages ask questions and produce artifacts.</p>';
  return groups.map(({ stage, rows }) => `<section class="record-group"><h2><span class="stage-glyph ${escapeHtml(stageClass(stage))}">${glyph(stage)}</span>${escapeHtml(stage.name || titleCase(stage.slug))}<small>${escapeHtml(statusLabel(stage))}</small></h2><ul class="record-files">${rows.map(({ path, role, entry }) => `<li><button type="button" data-tree-path="${escapeHtml(path)}"><span>${FILE_ICON}</span><code>${escapeHtml(basename(path))}</code><em>${role}</em><small>${entry.size == null ? "" : `${entry.size.toLocaleString()} bytes`}</small></button></li>`).join("")}</ul></section>`).join("");
}

async function showAllFiles() {
  const fallbackStage = currentStage();
  filesMode = true;
  store.set({ view: { kind: "overview", path: null, intent: store.workflow?.intent || null, readOnly: true, stage: fallbackStage?.slug || null }, panel: null });
  overview.hidden = false;
  overview.innerHTML = '<div class="workflow-placeholder"><b>Loading all files…</b><span>Reading the record tree.</span></div>';
  try {
    const data = await api.get("/api/tree", { intent: store.workflow?.intent });
    if (!filesMode) return;
    const back = fallbackStage ? `<button type="button" class="record-back" data-stage-overview="${escapeHtml(fallbackStage.slug)}">← ${escapeHtml(fallbackStage.name || titleCase(fallbackStage.slug))}</button>` : "";
    const count = reviewableRows(data.entries).reduce((total, group) => total + group.rows.length, 0);
    overview.innerHTML = `<div class="record-tree-page">${back}<h1>All files${count ? `<small>${count}</small>` : ""}</h1><p>The files you review or answer in <code>${escapeHtml(store.workflow?.intent || "the active record")}</code>: each stage's questions and artifacts.</p>${treeRows(data.entries)}</div>`;
  } catch (error) {
    if (!filesMode) return;
    overview.innerHTML = `<div class="workflow-placeholder"><b>File tree unavailable</b><span>${escapeHtml(error.message)}. Browse the record from the terminal.</span></div>`;
  }
}

async function selectIntent(slug) {
  intentPopover = false;
  if (!slug || slug === store.workflow?.intent) {
    renderPanel();
    openWorkflow();
    return;
  }
  try {
    const workflow = await api.get("/api/workflow", { intent: slug, space: store.workflow?.space });
    collapseAll = false;
    collapsedPhases.clear();
    store.set({ workflow });
    openWorkflow(workflow);
  } catch (error) {
    renderPanel();
    store.emit("notice", { message: `Could not switch intent: ${error.message}. Use the terminal to inspect ${slug}.`, kind: "error" });
  }
}

function handleTreeFile(path) {
  const owner = stages().find((stage) => stage.questions?.file === path);
  if (owner) {
    questionsView(owner);
    return;
  }
  const stage = stages().find((entry) => (entry.artifacts || []).some((artifact) => artifact.path === path));
  if (!stage) return;
  const artifact = (stage.artifacts || []).find((entry) => entry.path === path) || { path, name: basename(path), exists: true };
  artifactView(stage, artifact);
}

function render() {
  renderPanel();
  renderOverview();
}

export function init() {
  panel = document.getElementById("panel");
  overview = document.getElementById("overview");
  viewer = document.getElementById("viewer");
  questions = document.getElementById("questions-view");
  inbox = document.getElementById("inbox");
  empty = document.getElementById("empty");

  panel.addEventListener("click", (event) => {
    const selector = event.target.closest("[data-intent-selector]");
    if (selector) {
      event.stopPropagation();
      intentPopover = !intentPopover;
      selector.classList.toggle("open", intentPopover);
      selector.setAttribute("aria-expanded", String(intentPopover));
      const popover = panel.querySelector(".intent-popover");
      if (popover) popover.hidden = !intentPopover;
      return;
    }
    const intent = event.target.closest("[data-intent]")?.dataset.intent;
    if (intent) {
      selectIntent(intent);
      return;
    }
    if (event.target.closest("[data-switch-workspace]")) {
      store.emit("notice", { message: "Switch workspace from the terminal; the browser mirrors the active workspace.", kind: "info" });
      return;
    }
    if (event.target.closest("[data-collapse-all]")) {
      if (collapseAll) {
        collapseAll = false;
        expandAll = true;
        collapsedPhases.clear();
      } else {
        collapseAll = true;
        expandAll = false;
      }
      renderPanel();
      return;
    }
    const phase = event.target.closest("[data-phase-toggle]")?.dataset.phaseToggle;
    if (phase) {
      expandAll = false;
      if (collapsedPhases.has(phase)) collapsedPhases.delete(phase);
      else collapsedPhases.add(phase);
      renderPanel();
      return;
    }
    const slug = event.target.closest("[data-stage-overview]")?.dataset.stageOverview;
    if (slug) {
      event.preventDefault();
      event.stopPropagation();
      overviewView(findStage(slug));
      return;
    }
    const child = event.target.closest("[data-child-kind]");
    if (child) {
      const stage = findStage(child.dataset.stage);
      if (child.dataset.childKind === "questions") questionsView(stage);
      else {
        const artifact = (stage?.artifacts || []).find((entry) => entry.path === child.dataset.path) || { path: child.dataset.path, name: basename(child.dataset.path), exists: true };
        if (artifact.exists === false) overviewView(stage);
        else artifactView(stage, artifact);
      }
      return;
    }
    if (event.target.closest("[data-all-files]")) showAllFiles();
  });
  overview.addEventListener("click", (event) => {
    const path = event.target.closest("[data-tree-path]")?.dataset.treePath;
    if (path) handleTreeFile(path);
    const backTo = event.target.closest(".record-back[data-stage-overview]")?.dataset.stageOverview;
    if (backTo) {
      const stage = findStage(backTo);
      if (stage) overviewView(stage);
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-intent-selector]")) return;
    if (intentPopover && !event.target.closest(".workflow-context")) {
      intentPopover = false;
      const selector = panel.querySelector("[data-intent-selector]");
      selector?.classList.remove("open");
      selector?.setAttribute("aria-expanded", "false");
      const popover = panel.querySelector(".intent-popover");
      if (popover) popover.hidden = true;
    }
  });

  store.on("workflow", render);
  store.on("state", render);
  store.on("view", () => {
    if (store.view.kind !== "overview") filesMode = false;
    render();
  });
  store.on("sidebar", renderPanel);
  render();
}


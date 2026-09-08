// The intent composer.
//
// The box above the Inbox where a new intent starts: which workspace (a team's
// world under aidlc/spaces/), what to build, which workflow (a scope, or let
// the composer decide), and how much effort to spend (a preset from the config
// policy lane - the preset decides model and effort per agent group - or a
// custom dial). With an agent runner on the daemon, Start creates the intent
// and runs the agent right here; the browser follows it in the Agent panel.
// Without one, Start records a pending request and the next bare `/aidlc` in a
// terminal session picks it up and creates the intent as if the words had been
// typed there.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./diff.js";
import { setNotice, store } from "./store.js";

// The shipped scopes, as `core/scopes/*.md` declares them. The catalogue will
// come from the daemon once this leaves prototype.
const SCOPES = [
  { name: "express", depth: "Minimal", description: "Requirements to deploy, no design pass, no reviewers", notes: "one turn per gate · learnings off" },
  { name: "bugfix", depth: "Minimal", description: "Fix a specific bug", notes: "advisory review" },
  { name: "poc", depth: "Minimal", description: "Prove feasibility fast", notes: "advisory review" },
  { name: "refactor", depth: "Minimal", description: "Clean up existing code" },
  { name: "security-patch", depth: "Minimal", description: "CVE response" },
  { name: "feature", depth: "Standard", description: "Full lifecycle for new features, practical depth" },
  { name: "mvp", depth: "Standard", description: "Skip operations, ship the core" },
  { name: "classic", depth: "Standard", description: "V1-style lifecycle without ideation ceremony", notes: "advisory review" },
  { name: "infra", depth: "Standard", description: "Infrastructure changes" },
  { name: "workshop", depth: "Standard", description: "Facilitated group session with mandatory gates" },
  { name: "enterprise", depth: "Comprehensive", description: "Regulated enterprise feature, full audit trail" },
];

// The effort-only presets from the config policy lane (PR #756): they set
// group efforts, never model ids, and never touch the deciding group.
const PRESETS = [
  { id: "thorough", label: "Thorough", summary: "Reviewers think hardest", efforts: { reviewing: "xhigh", writing: "medium" } },
  { id: "balanced", label: "Balanced", summary: "The shipped default", efforts: { reviewing: "medium", writing: "medium" } },
  { id: "minimal", label: "Minimal", summary: "Lighter reviews, brief write-ups", efforts: { reviewing: "medium", writing: "low" } },
];
const GROUPS = [
  { id: "deciding", label: "Deciding", who: "design, implementation, product, security, quality", fixed: true },
  { id: "reviewing", label: "Reviewing", who: "product lead, architecture reviewer" },
  { id: "writing", label: "Writing up", who: "delivery, pipeline & deploy, operations" },
];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const SESSION_EFFORTS = ["low", "medium", "high", "xhigh"];
const draft = {
  space: null,
  text: "",
  scope: null, // null = let the composer decide
  preset: "balanced",
  // Group dials are effort-only, as the config policy lane defines them; model
  // ids belong to per-agent exceptions in settings, not to a run's start.
  custom: { reviewing: "medium", writing: "medium" },
  // The harness session's own effort (Claude's /effort, Kiro's --effort): the
  // ceiling the deciding agent runs at. null = the harness default.
  sessionEffort: null,
  // With "Let the composer decide" and a runner, Start first asks the daemon
  // what it would pick; the proposal shows here until confirmed or changed.
  proposal: null, // { scope, source } | null
};
let openMenu = null;

function runnerAvailable() {
  return store.workflow?.runner === true;
}

export function renderComposer() {
  const space = draft.space || store.workflow?.space || "default";
  const scope = SCOPES.find((entry) => entry.name === draft.scope);
  const preset = PRESETS.find((entry) => entry.id === draft.preset);
  const effortLabel = `${preset ? preset.label : "Custom"}${draft.sessionEffort ? ` · ${draft.sessionEffort}` : ""}`;
  return `<section class="composer">
    <div class="composer-top">
      <button type="button" class="composer-chip" data-menu="space" aria-haspopup="menu" title="Workspace: one team's world of intents, knowledge, and practices (aidlc/spaces/<name>)">${icon("flowchart", { size: 13 })}<span>Workspace</span><b>${escapeHtml(space)}</b>${icon("chevronDown", { size: 12 })}</button>
    </div>
    <textarea class="composer-text" rows="2" placeholder="What do you want to build?" aria-label="Intent">${escapeHtml(draft.text)}</textarea>
    <div class="composer-bottom">
      <button type="button" class="composer-chip" data-menu="scope" aria-haspopup="menu">${icon("textBulletListTree", { size: 13 })}<span>Workflow</span><b>${scope ? `${escapeHtml(scope.name)} · ${escapeHtml(scope.depth)}` : "Let the composer decide"}</b>${icon("chevronDown", { size: 12 })}</button>
      <span class="composer-hint">⌘↵ to start</span>
      <button type="button" class="composer-chip" data-menu="effort" aria-haspopup="menu" title="How much effort the run spends - the preset sets the models and effort for every agent group">${escapeHtml(effortLabel)}${icon("chevronDown", { size: 12 })}</button>
      <button type="button" class="composer-start" data-start title="Start the intent" aria-label="Start the intent" ${draft.text.trim() ? "" : "disabled"}>${icon("arrowLeft", { size: 16 })}</button>
    </div>
    ${draft.proposal ? `<div class="composer-proposal"><span>The composer proposes <b>${escapeHtml(draft.proposal.scope)}</b>${draft.proposal.source === "keyword" ? " from your words" : " (the default)"}.</span><button type="button" class="btn primary" data-proposal-start>Start as ${escapeHtml(draft.proposal.scope)}</button><button type="button" class="btn" data-proposal-change>Pick another</button></div>` : ""}
  </section>
  <p class="composer-foot">${runnerAvailable()
    ? "Start creates the intent and runs the agent here; follow it in the Agent panel. Your terminal stays a full equivalent."
    : `Start records the request here; the next <code>/aidlc</code> in your terminal creates and runs the intent.${store.workflow?.runner_requirement ? ` To run it from here, install ${escapeHtml(store.workflow.runner_requirement)} and restart the daemon.` : ""}`}</p>`;
}

export function bindComposer(root, rerender) {
  const section = root.querySelector(".composer");
  if (!section) return;
  const text = section.querySelector(".composer-text");
  text.addEventListener("input", () => {
    draft.text = text.value;
    section.querySelector("[data-start]").disabled = !draft.text.trim();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      start();
    }
  });
  section.querySelector("[data-start]").addEventListener("click", start);
  section.querySelector("[data-proposal-start]")?.addEventListener("click", () => start(true));
  section.querySelector("[data-proposal-change]")?.addEventListener("click", (event) => {
    draft.proposal = null;
    openMenuFor(section.querySelector('[data-menu="scope"]'), "scope", rerender);
    event.stopPropagation();
  });
  for (const chip of section.querySelectorAll("[data-menu]")) {
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenu?.dataset.for === chip.dataset.menu) return closeMenu();
      openMenuFor(chip, chip.dataset.menu, rerender);
    });
  }
}

let starting = false;

// Start. With a runner: "Let the composer decide" first asks the daemon for its
// proposal (one confirm, then it runs); a chosen workflow starts at once. The
// daemon creates the record and launches the agent; the tab opens the intent.
// Without a runner the request is recorded for the terminal, and the notice
// says so in those words.
async function start(confirmed = false) {
  const text = draft.text.trim();
  if (!text || starting) return;
  const section = document.querySelector(".composer");
  const space = draft.space || store.workflow?.space || "default";
  let scope = draft.scope;
  if (runnerAvailable() && scope === null) {
    if (confirmed && draft.proposal) {
      scope = draft.proposal.scope;
    } else {
      starting = true;
      section?.classList.add("busy");
      try {
        draft.proposal = await api.get("/api/intents/propose", { text });
        store.emit("composer-rerender");
      } catch (error) {
        setNotice(`Could not propose a workflow: ${error.message}`, "error");
      } finally {
        starting = false;
        section?.classList.remove("busy");
      }
      return;
    }
  }
  starting = true;
  section?.classList.add("busy");
  try {
    const effort = draft.preset ? { preset: draft.preset } : { reviewing: draft.custom.reviewing, writing: draft.custom.writing };
    const result = await api.post("/api/intents", { text, space, scope, effort, session_effort: draft.sessionEffort });
    draft.text = "";
    draft.proposal = null;
    if (result.mode === "running") {
      setNotice(`Started ${result.intent}. The agent is working; follow it in the Agent panel.`, "info");
      store.emit("select-intent", result.intent);
    } else if (result.mode === "created") {
      setNotice(`Created ${result.intent}, but the agent did not start: ${result.error}. Open the intent and run it from the Agent panel, or type /aidlc in a terminal.`, "error");
      store.emit("select-intent", result.intent);
    } else {
      setNotice("Requested. Type /aidlc in your terminal to start it - the session picks the request up and creates the intent.", "info");
    }
    store.emit("wants-refresh");
  } catch (error) {
    setNotice(`Could not start the intent: ${error.message}`, "error");
  } finally {
    starting = false;
    section?.classList.remove("busy");
  }
}

function openMenuFor(anchor, kind, rerender) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = `composer-menu composer-menu-${kind}`;
  menu.dataset.for = kind;
  menu.setAttribute("role", "menu");
  menu.innerHTML = kind === "space" ? spaceMenu() : kind === "scope" ? scopeMenu() : effortMenu();
  document.body.append(menu);
  const at = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8));
  const below = at.bottom + 6;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(below + size.height > window.innerHeight - 8 ? at.top - size.height - 6 : below)}px`;
  openMenu = menu;
  bindMenu(menu, kind, rerender);
  setTimeout(() => document.addEventListener("mousedown", closeOnOutside, { once: true }), 0);
}

function closeOnOutside(event) {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
  else if (openMenu) document.addEventListener("mousedown", closeOnOutside, { once: true });
}

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

function spaceMenu() {
  const spaces = store.workflow?.spaces?.length ? store.workflow.spaces : [store.workflow?.space || "default"];
  const current = draft.space || store.workflow?.space || "default";
  return `<div class="composer-menu-title">Workspace</div>
    ${spaces.map((space) => `<button type="button" role="menuitemradio" aria-checked="${space === current}" data-pick-space="${escapeHtml(space)}"><span class="check">${space === current ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(space)}</b><small>aidlc/spaces/${escapeHtml(space)}</small></button>`).join("")}
    <div class="composer-menu-sep"></div>
    <button type="button" role="menuitem" data-new-space><span class="check">+</span><b>New workspace…</b><small>a separate team world: its own intents, knowledge, and practices</small></button>`;
}

function scopeMenu() {
  const byDepth = ["Minimal", "Standard", "Comprehensive"];
  return `<div class="composer-menu-title">Workflow</div>
    <button type="button" role="menuitemradio" aria-checked="${draft.scope === null}" data-pick-scope=""><span class="check">${draft.scope === null ? icon("checkmark", { size: 12 }) : ""}</span><b>Let the composer decide <em>Recommended</em></b><small>Reads the intent, proposes a workflow, asks you once</small></button>
    ${byDepth.map((depth) => `<div class="composer-menu-group">${depth}</div>${SCOPES.filter((entry) => entry.depth === depth).map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.scope === entry.name}" data-pick-scope="${escapeHtml(entry.name)}"><span class="check">${draft.scope === entry.name ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.description)}${entry.notes ? ` · ${escapeHtml(entry.notes)}` : ""}</small></button>`).join("")}`).join("")}`;
}

function effortMenu() {
  const preset = PRESETS.find((entry) => entry.id === draft.preset);
  const effortFor = (group) => (preset ? preset.efforts[group.id] : draft.custom[group.id]) || "medium";
  return `<div class="composer-menu-title">Effort</div>
    <div class="composer-presets">
      ${PRESETS.map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.preset === entry.id}" data-pick-preset="${entry.id}"><b>${entry.label}</b><small>${escapeHtml(entry.summary)}</small></button>`).join("")}
    </div>
    <div class="composer-menu-group">What ${preset ? preset.label : "Custom"} means</div>
    <table class="composer-dial"><thead><tr><th></th><th>Effort</th></tr></thead><tbody>
      ${GROUPS.map((group) => `<tr data-group="${group.id}"><th><b>${group.label}</b><small>${escapeHtml(group.who)}</small></th>
        ${group.fixed
          ? `<td><span class="composer-fixed" title="Deciding work always inherits the session's model and ceiling; presets and dials never lower it.">session ceiling</span></td>`
          : `<td><select data-dial-effort="${group.id}" aria-label="${group.label} effort">${EFFORTS.map((effort) => `<option ${effortFor(group) === effort ? "selected" : ""}>${effort}</option>`).join("")}</select></td>`}
      </tr>`).join("")}
    </tbody></table>
    <p class="composer-menu-note">The preset decides the model and effort for each agent group. Changing a dial makes this run <b>Custom</b>; deciding agents always keep the session's ceiling.</p>
    ${runnerAvailable() && store.workflow?.runner_effort
      ? `<div class="composer-menu-group">Session ceiling</div>
    <div class="composer-session-effort"><span>The effort the agent session itself runs at - what deciding work inherits.</span>
      <select data-session-effort aria-label="Session effort">${["default", ...SESSION_EFFORTS].map((level) => `<option value="${level}" ${(draft.sessionEffort || "default") === level ? "selected" : ""}>${level === "default" ? "harness default" : level}</option>`).join("")}</select></div>`
      : ""}`;
}

function bindMenu(menu, kind, rerender) {
  for (const button of menu.querySelectorAll("[data-pick-space]")) button.addEventListener("click", () => { draft.space = button.dataset.pickSpace; closeMenu(); rerender(); });
  menu.querySelector("[data-new-space]")?.addEventListener("click", async () => {
    closeMenu();
    const name = window.prompt("New workspace name (lowercase letters, digits, dashes):", "");
    if (!name) return;
    try {
      const created = await api.post("/api/spaces", { name: name.trim().toLowerCase() });
      draft.space = created.space;
      setNotice(`Workspace “${created.space}” created.`, "info");
      store.emit("wants-refresh");
      rerender();
    } catch (error) {
      setNotice(`Could not create the workspace: ${error.message}`, "error");
    }
  });
  for (const button of menu.querySelectorAll("[data-pick-scope]")) button.addEventListener("click", () => { draft.scope = button.dataset.pickScope || null; draft.proposal = null; closeMenu(); rerender(); });
  for (const button of menu.querySelectorAll("[data-pick-preset]")) button.addEventListener("click", () => { draft.preset = button.dataset.pickPreset; const entry = PRESETS.find((item) => item.id === draft.preset); draft.custom = { ...entry.efforts }; refreshMenu(menu, kind, rerender); rerender(); });
  menu.querySelector("[data-session-effort]")?.addEventListener("change", (event) => {
    draft.sessionEffort = event.target.value === "default" ? null : event.target.value;
    rerender();
  });
  for (const select of menu.querySelectorAll("[data-dial-effort]")) select.addEventListener("change", () => {
    draft.custom[select.dataset.dialEffort] = select.value;
    draft.preset = null;
    refreshMenu(menu, kind, rerender);
    rerender();
  });
}

function refreshMenu(menu, kind, rerender) {
  menu.innerHTML = kind === "effort" ? effortMenu() : kind === "scope" ? scopeMenu() : spaceMenu();
  bindMenu(menu, kind, rerender);
}

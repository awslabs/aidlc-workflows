// The intent composer.
//
// The box above the Inbox where a new intent starts: which workspace (a team's
// world under aidlc/spaces/), what to build, which workflow (a scope, or let
// the composer decide), and the effort the run's agent session itself thinks
// at. Which effort each *agent* runs at is project policy (`aidlc config
// models`, committed with the project), edited and shown in Settings - it is
// not a per-intent choice. With an
// agent runner on the daemon, Start creates the intent and runs the agent right
// here; the browser follows it in the Agent panel.
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

const SESSION_EFFORTS = ["low", "medium", "high", "xhigh"];
const draft = {
  space: null,
  text: "",
  scope: null, // null = Adaptive: the composer proposes a workflow from the words
  // The agent session's own effort (Claude's /effort, Kiro's --effort): what the
  // conductor and every agent without a pin run at. null = the harness default.
  sessionEffort: null,
  // With Adaptive and a runner, Start first asks the daemon
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
  const sessionDial = runnerAvailable() && store.workflow?.runner_effort;
  const fallback = store.workflow?.runner_default_effort;
  const effortLabel = sessionDial ? `Effort · ${draft.sessionEffort || (fallback ? `default (${fallback.level})` : "default")}` : "Effort";
  return `<section class="composer">
    <div class="composer-top">
      <button type="button" class="composer-chip" data-menu="space" aria-haspopup="menu" title="Workspace: one team's world of intents, knowledge, and practices (aidlc/spaces/<name>)">${icon("flowchart", { size: 13 })}<span>Workspace</span><b>${escapeHtml(space)}</b>${icon("chevronDown", { size: 12 })}</button>
    </div>
    <textarea class="composer-text" rows="2" placeholder="What do you want to build?" aria-label="Intent">${escapeHtml(draft.text)}</textarea>
    <div class="composer-bottom">
      <button type="button" class="composer-chip" data-menu="scope" aria-haspopup="menu">${icon("textBulletListTree", { size: 13 })}<span>Workflow</span><b>${scope ? `${escapeHtml(scope.name)} · ${escapeHtml(scope.depth)}` : "Adaptive"}</b>${icon("chevronDown", { size: 12 })}</button>
      <span class="composer-hint">⌘↵ to start</span>
      <button type="button" class="composer-chip" data-menu="effort" aria-haspopup="menu" title="The effort the agent session thinks at, and what each agent runs at under this project's policy">${escapeHtml(effortLabel)}${icon("chevronDown", { size: 12 })}</button>
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

// Start. With a runner: Adaptive first asks the daemon for its
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
    const result = await api.post("/api/intents", { text, space, scope, session_effort: draft.sessionEffort });
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
    <button type="button" role="menuitemradio" aria-checked="${draft.scope === null}" data-pick-scope=""><span class="check">${draft.scope === null ? icon("checkmark", { size: 12 }) : ""}</span><b>Adaptive <em>Recommended</em></b><small>Proposes a workflow from your words, asks you once</small></button>
    ${byDepth.map((depth) => `<div class="composer-menu-group">${depth}</div>${SCOPES.filter((entry) => entry.depth === depth).map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.scope === entry.name}" data-pick-scope="${escapeHtml(entry.name)}"><span class="check">${draft.scope === entry.name ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.description)}${entry.notes ? ` · ${escapeHtml(entry.notes)}` : ""}</small></button>`).join("")}`).join("")}`;
}

// Effort: the one question a run asks - how hard should this session think? -
// with the default named. What each agent is pinned to is project policy and
// lives in Settings (the rail's cog), not here.
const LEVELS = [
  ["low", "Low", "Quick and cheap; fine for small, well-understood work"],
  ["medium", "Medium", "The everyday setting"],
  ["high", "High", "Deeper reasoning on every turn"],
  ["xhigh", "Extra high", "For the hardest problems; slowest"],
];

function effortMenu() {
  const sessionDial = runnerAvailable() && store.workflow?.runner_effort;
  const fallback = store.workflow?.runner_default_effort;
  const current = draft.sessionEffort || "default";
  const row = (value, label, small) => `<button type="button" role="menuitemradio" aria-checked="${current === value}" data-pick-effort="${value}"><span class="check">${current === value ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(label)}</b><small>${escapeHtml(small)}</small></button>`;
  return `<div class="composer-menu-title">Effort</div>
    ${sessionDial
      ? `${row("default", fallback ? `Default (${fallback.level})` : "Default", fallback ? `Your setting, from ${fallback.source}` : "The model's own default")}
    ${LEVELS.map(([value, label, small]) => row(value, label, small)).join("")}`
      : `<p class="composer-menu-note">This runner takes no per-run effort; the session's own setting applies.</p>`}`;
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
  for (const button of menu.querySelectorAll("[data-pick-effort]")) button.addEventListener("click", () => {
    draft.sessionEffort = button.dataset.pickEffort === "default" ? null : button.dataset.pickEffort;
    closeMenu();
    rerender();
  });
}

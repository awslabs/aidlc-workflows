// The intent composer - DESIGN PROTOTYPE.
//
// The box above the Inbox where a new intent starts: which workspace, what to
// build, how deep to go (a scope, or let the composer decide), and how much
// effort to spend (a preset from the config policy lane, or a custom dial per
// agent group). Every control here is live so the design can be tried; Start
// does not create anything yet - it names what it would do. The write path
// (daemon route -> record + state, then the terminal session picks it up) is
// the implementation step that follows the design.
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
// The host session's model - what the harness itself runs on, and what the
// deciding group inherits. Placeholder names; the real list is the host's.
const SESSION_MODELS = [
  { id: "opus", label: "Opus 4", note: "Deepest reasoning; slowest" },
  { id: "sonnet", label: "Sonnet 4.5", note: "The everyday balance" },
  { id: "haiku", label: "Haiku 4.5", note: "Fastest; for small runs" },
];

const draft = {
  space: null,
  text: "",
  scope: null, // null = let the composer decide
  model: "opus",
  preset: "balanced",
  // Group dials are effort-only, as the config policy lane defines them; model
  // ids belong to per-agent exceptions in settings, not to a run's start.
  custom: { reviewing: "medium", writing: "medium" },
};
let openMenu = null;

function projectName() {
  const dir = store.state?.project_dir || "";
  return dir.split("/").filter(Boolean).pop() || "this project";
}

export function renderComposer() {
  const space = draft.space || store.workflow?.space || "default";
  const scope = SCOPES.find((entry) => entry.name === draft.scope);
  const preset = PRESETS.find((entry) => entry.id === draft.preset);
  const model = SESSION_MODELS.find((entry) => entry.id === draft.model) || SESSION_MODELS[0];
  const effortLabel = preset ? preset.label : "Custom";
  return `<section class="composer" data-prototype="design">
    <div class="composer-top">
      <span class="composer-project" title="${escapeHtml(store.state?.project_dir || "")}">${icon("documentText", { size: 13 })}<span>Project</span><b>${escapeHtml(projectName())}</b></span>
      <button type="button" class="composer-chip" data-menu="space" aria-haspopup="menu" title="AI-DLC space: its own memory and intent list, under aidlc/spaces/">${icon("flowchart", { size: 13 })}<span>Space</span><b>${escapeHtml(space)}</b>${icon("chevronDown", { size: 12 })}</button>
      <span class="composer-proto">Design preview</span>
    </div>
    <textarea class="composer-text" rows="2" placeholder="What do you want to build?" aria-label="Intent">${escapeHtml(draft.text)}</textarea>
    <div class="composer-bottom">
      <button type="button" class="composer-chip" data-menu="scope" aria-haspopup="menu">${icon("textBulletListTree", { size: 13 })}<span>Scope</span><b>${scope ? `${escapeHtml(scope.name)} · ${escapeHtml(scope.depth)}` : "Let the composer decide"}</b>${icon("chevronDown", { size: 12 })}</button>
      <span class="composer-hint">⌘↵ to start</span>
      <button type="button" class="composer-chip" data-menu="model" aria-haspopup="menu" title="The session's model - what the harness runs on, and what deciding agents inherit">${escapeHtml(model.label)}${icon("chevronDown", { size: 12 })}</button>
      <button type="button" class="composer-chip" data-menu="effort" aria-haspopup="menu">${escapeHtml(effortLabel)}${icon("chevronDown", { size: 12 })}</button>
      <button type="button" class="composer-start" data-start title="Start the intent" aria-label="Start the intent" ${draft.text.trim() ? "" : "disabled"}>${icon("arrowLeft", { size: 16 })}</button>
    </div>
  </section>`;
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
  for (const chip of section.querySelectorAll("[data-menu]")) {
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openMenu?.dataset.for === chip.dataset.menu) return closeMenu();
      openMenuFor(chip, chip.dataset.menu, rerender);
    });
  }
}

function start() {
  const scope = draft.scope ? `scope ${draft.scope}` : "the composer choosing the scope";
  const effort = PRESETS.find((entry) => entry.id === draft.preset)?.label.toLowerCase() || "custom";
  const model = SESSION_MODELS.find((entry) => entry.id === draft.model)?.label || "the session model";
  setNotice(`Design preview — Start would create the intent in ${projectName()} / space “${draft.space || store.workflow?.space || "default"}” with ${scope}, ${effort} effort on ${model}, then your terminal session picks it up.`, "info");
}

function openMenuFor(anchor, kind, rerender) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = `composer-menu composer-menu-${kind}`;
  menu.dataset.for = kind;
  menu.setAttribute("role", "menu");
  menu.innerHTML = kind === "space" ? spaceMenu() : kind === "scope" ? scopeMenu() : kind === "model" ? modelMenu() : effortMenu();
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

function modelMenu() {
  return `<div class="composer-menu-title">Session model</div>
    ${SESSION_MODELS.map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.model === entry.id}" data-pick-model="${entry.id}"><span class="check">${draft.model === entry.id ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(entry.label)}</b><small>${escapeHtml(entry.note)}</small></button>`).join("")}
    <p class="composer-menu-note">The harness runs on this model; deciding agents inherit it. Per-agent model exceptions live in <b>aidlc config models</b>, not here.</p>`;
}

function spaceMenu() {
  const spaces = store.workflow?.spaces?.length ? store.workflow.spaces : [store.workflow?.space || "default"];
  const current = draft.space || store.workflow?.space || "default";
  return `<div class="composer-menu-title">Space</div>
    ${spaces.map((space) => `<button type="button" role="menuitemradio" aria-checked="${space === current}" data-pick-space="${escapeHtml(space)}"><span class="check">${space === current ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(space)}</b><small>aidlc/spaces/${escapeHtml(space)}</small></button>`).join("")}
    <div class="composer-menu-sep"></div>
    <button type="button" role="menuitem" data-new-space><span class="check">+</span><b>New space…</b><small>a separate memory and intent list in this project</small></button>`;
}

function scopeMenu() {
  const byDepth = ["Minimal", "Standard", "Comprehensive"];
  return `<div class="composer-menu-title">Scope</div>
    <button type="button" role="menuitemradio" aria-checked="${draft.scope === null}" data-pick-scope=""><span class="check">${draft.scope === null ? icon("checkmark", { size: 12 }) : ""}</span><b>Let the composer decide <em>Recommended</em></b><small>Reads the intent, proposes a scope, asks you once</small></button>
    ${byDepth.map((depth) => `<div class="composer-menu-group">${depth}</div>${SCOPES.filter((entry) => entry.depth === depth).map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.scope === entry.name}" data-pick-scope="${escapeHtml(entry.name)}"><span class="check">${draft.scope === entry.name ? icon("checkmark", { size: 12 }) : ""}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.description)}${entry.notes ? ` · ${escapeHtml(entry.notes)}` : ""}</small></button>`).join("")}`).join("")}`;
}

function effortMenu() {
  const preset = PRESETS.find((entry) => entry.id === draft.preset);
  const effortFor = (group) => (preset ? preset.efforts[group.id] : draft.custom[group.id]) || "medium";
  return `<div class="composer-menu-title">Effort</div>
    <div class="composer-presets">
      ${PRESETS.map((entry) => `<button type="button" role="menuitemradio" aria-checked="${draft.preset === entry.id}" data-pick-preset="${entry.id}"><b>${entry.label}</b><small>${escapeHtml(entry.summary)}</small></button>`).join("")}
    </div>
    <div class="composer-menu-group">Per group${preset ? ` · from ${preset.label}` : " · custom"}</div>
    <table class="composer-dial"><thead><tr><th></th><th>Effort</th></tr></thead><tbody>
      ${GROUPS.map((group) => `<tr data-group="${group.id}"><th><b>${group.label}</b><small>${escapeHtml(group.who)}</small></th>
        ${group.fixed
          ? `<td><span class="composer-fixed" title="Deciding work always inherits the session's model and ceiling; presets and dials never lower it.">session ceiling</span></td>`
          : `<td><select data-dial-effort="${group.id}" aria-label="${group.label} effort">${EFFORTS.map((effort) => `<option ${effortFor(group) === effort ? "selected" : ""}>${effort}</option>`).join("")}</select></td>`}
      </tr>`).join("")}
    </tbody></table>
    <p class="composer-menu-note">Presets and dials set <b>effort only</b>; every agent runs on the session model unless a per-agent exception says otherwise in settings. Changing a dial makes this run <b>Custom</b>.</p>`;
}

function bindMenu(menu, kind, rerender) {
  for (const button of menu.querySelectorAll("[data-pick-space]")) button.addEventListener("click", () => { draft.space = button.dataset.pickSpace; closeMenu(); rerender(); });
  menu.querySelector("[data-new-space]")?.addEventListener("click", () => { closeMenu(); setNotice("Design preview — a new workspace would be created here.", "info"); });
  for (const button of menu.querySelectorAll("[data-pick-scope]")) button.addEventListener("click", () => { draft.scope = button.dataset.pickScope || null; closeMenu(); rerender(); });
  for (const button of menu.querySelectorAll("[data-pick-model]")) button.addEventListener("click", () => { draft.model = button.dataset.pickModel; closeMenu(); rerender(); });
  for (const button of menu.querySelectorAll("[data-pick-preset]")) button.addEventListener("click", () => { draft.preset = button.dataset.pickPreset; const entry = PRESETS.find((item) => item.id === draft.preset); draft.custom = { ...entry.efforts }; refreshMenu(menu, kind, rerender); rerender(); });
  for (const select of menu.querySelectorAll("[data-dial-effort]")) select.addEventListener("change", () => {
    draft.custom[select.dataset.dialEffort] = select.value;
    draft.preset = null;
    refreshMenu(menu, kind, rerender);
    rerender();
  });
}

function refreshMenu(menu, kind, rerender) {
  menu.innerHTML = kind === "effort" ? effortMenu() : kind === "scope" ? scopeMenu() : kind === "model" ? modelMenu() : spaceMenu();
  bindMenu(menu, kind, rerender);
}

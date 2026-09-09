// Settings. A modal with left navigation, opened from the cog at the bottom of
// the rail.
//
// "Models & effort" is one page, top to bottom: the default effort (read-only -
// it is the harness's own setting, what "inherit" means), the preset, each
// group of agents inheriting that default or pinned to a level, and the
// per-agent exceptions. Every change is one `aidlc config models` call through
// the daemon - the same writer the terminal uses - to the committed project
// layer or to this machine only; it applies to runs started afterwards.
// "About" is read-only facts about this review UI.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./diff.js";
import { setNotice, store } from "./store.js";

const PAGES = [
  { id: "models", label: "Models & effort" },
  { id: "about", label: "About" },
];
const PRESETS = [
  { id: "thorough", label: "Thorough", summary: "Reviewers xhigh · everyone else inherits" },
  { id: "balanced", label: "Balanced", summary: "Reviewers medium · the shipped baseline" },
  { id: "minimal", label: "Minimal", summary: "Reviewers medium · writers low" },
];
const SESSION_LEVELS = ["low", "medium", "high", "xhigh"];

let root = null;
let page = "models";
let scope = "project"; // project = committed team policy · local = this machine only
let busy = false;
let addingException = false;

export function init() {
  root = document.getElementById("settings");
  root.addEventListener("click", (event) => {
    if (event.target === root) return close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !root.hidden) close();
  });
  store.on("open-settings", (target) => open(typeof target === "string" ? target : "models"));
  store.on("workflow", () => { if (!root.hidden) render(); });
}

export function open(target = "models") {
  page = PAGES.some((entry) => entry.id === target) ? target : "models";
  root.hidden = false;
  render();
  root.querySelector(".settings-nav .on")?.focus();
}

export function close() {
  root.hidden = true;
  root.innerHTML = "";
}

function render() {
  root.innerHTML = `<div class="settings-box" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <nav class="settings-nav" aria-label="Settings sections">
      <h2 id="settings-title">Settings</h2>
      ${PAGES.map((entry) => `<button type="button" class="${entry.id === page ? "on" : ""}" data-page="${entry.id}">${escapeHtml(entry.label)}</button>`).join("")}
    </nav>
    <section class="settings-page ${busy ? "busy" : ""}">
      <button type="button" class="settings-close" data-close aria-label="Close settings">${icon("dismiss", { size: 14 })}</button>
      ${page === "models" ? modelsPage() : aboutPage()}
    </section>
  </div>`;
  bind();
}

const INHERIT = "inherit";

// Where a group's effective effort comes from, for the note beside it.
function groupSource(policy, id, effective) {
  const recorded = policy.recorded;
  if (recorded.local?.groups?.[id]) return "only me";
  if (recorded.project?.groups?.[id]) return "project";
  if (recorded.global?.groups?.[id]) return "this machine";
  if (effective === INHERIT) return "";
  return policy.preset ? `preset ${policy.preset}` : "shipped default";
}

function modelsPage() {
  const workflow = store.workflow || {};
  const policy = workflow.models_policy;
  const fallback = workflow.runner_default_effort;
  const efforts = policy?.efforts || ["low", "medium", "high", "xhigh"];
  const exceptions = policy?.exceptions || [];
  const agentsForPicker = policy ? policy.groups.flatMap((group) => group.agents).sort() : [];
  const recorded = policy?.recorded?.[scope];
  const groupRow = (group) => {
    // The select shows this layer's dial. "Inherit from default" is the state
    // of having none; once a dial is recorded the command has no way to remove
    // just that one (--reset cannot combine with other flags), so the option is
    // offered only while it is true - Reset below clears the layer.
    const dial = recorded?.groups?.[group.id] || "";
    // With no dial in this layer the option names what applies instead: the
    // default (inherit), or the preset's / shipped pin and its level.
    const source = groupSource(policy, group.id, group.effort);
    const noDial = group.effort === INHERIT
      ? "Inherit from default"
      : `${source ? source[0].toUpperCase() + source.slice(1) : "Effective"} (${group.effort})`;
    return `<div class="settings-row">
      <span class="l">${escapeHtml(group.label)}<small>${escapeHtml(group.agents.join(", "))}</small></span>
      <select data-group="${group.id}" aria-label="${escapeHtml(group.label)} effort" title="${dial ? `Recorded ${scope === "project" ? "in the project" : "for you"}; Reset below removes it` : "What this group runs at without a dial of its own"}">
        ${dial ? "" : `<option value="" selected>${escapeHtml(noDial)}</option>`}
        ${efforts.map((level) => `<option value="${level}" ${dial === level ? "selected" : ""}>${level}</option>`).join("")}
      </select>
    </div>`;
  };
  return `<h3>Models &amp; effort</h3>
    <p class="settings-sub">How hard each group of agents thinks.</p>

    <div class="settings-block">
      <div class="settings-h">Default</div>
      <div class="settings-row"><span class="l">Default effort<small>${fallback
        ? `Your ${escapeHtml(harnessName(workflow))} setting (<code>${escapeHtml(fallback.source)}</code>) - what “inherit” means${fallback.source.startsWith(".claude") ? ", the same value <code>/effort</code> sets" : ""}.`
        : "No settings file names an effort; the model's own default applies - what “inherit” means."}</small></span>
        ${workflow.runner_default_effort_editable
          ? `<select data-default-effort aria-label="Default effort">
              <option value="" ${fallback ? "" : "selected"}>model default</option>
              ${SESSION_LEVELS.map((level) => `<option value="${level}" ${fallback?.level === level ? "selected" : ""}>${level}</option>`).join("")}
            </select>`
          : `<span class="c"><b>${fallback ? escapeHtml(fallback.level) : "model default"}</b></span>`}
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-h">Preset</div>
      ${policy ? "" : `<p class="settings-note">No installed harness this daemon can read a policy for.</p>`}
      <div class="settings-presets">${PRESETS.map((entry) => `<button type="button" role="radio" aria-checked="${policy?.preset === entry.id}" data-preset="${entry.id}" ${policy ? "" : "disabled"}><b>${entry.label}</b><small>${escapeHtml(entry.summary)}</small></button>`).join("")}</div>
    </div>

    <div class="settings-block">
      <div class="settings-h">Groups</div>
      ${policy ? policy.groups.map(groupRow).join("") : ""}
      <div class="settings-row">
        <span class="l">Exceptions<small>One agent pinned to its own effort or model</small></span>
        <span class="c settings-exceptions-summary">${exceptions.length
          ? exceptions.map((entry) => `<span class="settings-pin" title="Unpin from the terminal or Reset the layer">${escapeHtml(entry.agent)} · ${escapeHtml(entry.effort || "inherit")}${entry.model ? ` · ${escapeHtml(entry.model)}` : ""}</span>`).join("")
          : "none"}</span>
        <button type="button" class="btn" data-add-exception ${policy ? "" : "disabled"}>${addingException ? "Cancel" : "Add…"}</button>
      </div>
      ${addingException ? `<form class="settings-exception-form" data-exception-form>
        <select name="agent" aria-label="Agent">${agentsForPicker.map((agent) => `<option>${escapeHtml(agent)}</option>`).join("")}</select>
        <select name="effort" aria-label="Effort">${efforts.map((level) => `<option ${level === "high" ? "selected" : ""}>${level}</option>`).join("")}</select>
        <input name="model" type="text" placeholder="model id (optional)" aria-label="Model id" spellcheck="false">
        <button type="submit" class="btn primary">Pin</button>
      </form>` : ""}
    </div>

    <div class="settings-foot">
      <span class="settings-toggle" role="radiogroup" aria-label="Write to">
        <button type="button" role="radio" aria-checked="${scope === "project"}" data-scope="project" title="aidlc.settings.json - committed with the project">Project</button>
        <button type="button" role="radio" aria-checked="${scope === "local"}" data-scope="local" title="aidlc.settings.local.json - this machine only">Only me</button>
      </span>
      <span class="settings-note">Changes apply to runs started afterwards${scope === "project" ? "; commit <code>aidlc.settings.json</code> and <code>.claude/agents/</code>" : ""}.</span>
      <button type="button" class="btn" data-reset ${policy?.recorded?.[scope] ? "" : "disabled"} title="Remove every preset, dial, and exception recorded ${scope === "project" ? "in the project" : "for this machine"}">Reset ${scope === "project" ? "project" : "mine"}</button>
    </div>`;
}

function harnessName(workflow) {
  const names = { claude: "Claude", kiro: "Kiro", "kiro-ide": "Kiro", codex: "Codex", cursor: "Cursor", opencode: "opencode", copilot: "Copilot" };
  return names[workflow.models_policy?.harness] || "harness";
}

function aboutPage() {
  const workflow = store.workflow || {};
  const daemon = workflow.daemon || {};
  return `<h3>About</h3>
    <p class="settings-sub">This review UI, as it is running now.</p>
    <div class="settings-block">
      <div class="settings-row"><span class="l">Version</span><span class="c">${escapeHtml(daemon.version || "?")}</span></div>
      <div class="settings-row"><span class="l">Address</span><span class="c"><code>${escapeHtml(location.origin)}</code></span></div>
      <div class="settings-row"><span class="l">Agent runner<small>Start in the browser runs the work when one is available</small></span><span class="c">${workflow.runner ? "available" : escapeHtml(workflow.runner_requirement ? `off · needs ${workflow.runner_requirement}` : "off")}</span></div>
      <div class="settings-row"><span class="l">Per-run effort dial</span><span class="c">${workflow.runner_effort ? "yes" : "no"}</span></div>
    </div>
    <p class="settings-note">Stop or restart from a terminal: <code>aidlc ui stop</code> · <code>aidlc ui start</code>.</p>`;
}

function bind() {
  root.querySelector("[data-close]")?.addEventListener("click", close);
  for (const button of root.querySelectorAll("[data-page]")) button.addEventListener("click", () => { page = button.dataset.page; render(); });
  for (const button of root.querySelectorAll("[data-scope]")) button.addEventListener("click", () => { scope = button.dataset.scope; render(); });
  for (const button of root.querySelectorAll("[data-preset]")) button.addEventListener("click", () => change({ action: "preset", preset: button.dataset.preset }));
  root.querySelector("[data-default-effort]")?.addEventListener("change", async (event) => {
    if (busy) return;
    busy = true;
    render();
    try {
      await api.post("/api/default-effort", { level: event.target.value || null });
      setNotice("Default effort updated in your harness settings; runs started from now on inherit it.", "info");
      store.emit("wants-refresh");
    } catch (error) {
      setNotice(`Could not change the default effort: ${error.message}`, "error");
    } finally {
      busy = false;
      render();
    }
  });
  for (const select of root.querySelectorAll("[data-group]")) select.addEventListener("change", () => {
    if (select.value) change({ action: "group", group: select.dataset.group, effort: select.value });
  });
  root.querySelector("[data-add-exception]")?.addEventListener("click", () => { addingException = !addingException; render(); root.querySelector("[data-exception-form] select")?.focus(); });
  root.querySelector("[data-exception-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const model = String(form.get("model") || "").trim();
    addingException = false;
    change({ action: "agent", agent: String(form.get("agent")), effort: String(form.get("effort")), ...(model ? { model } : {}) });
  });
  root.querySelector("[data-reset]")?.addEventListener("click", () => {
    if (!window.confirm(`Reset the ${scope === "project" ? "project's" : "personal"} model policy? Every preset, dial, and exception recorded ${scope === "project" ? "in the project" : "for this machine"} is removed.`)) return;
    change({ action: "reset" });
  });
}

async function change(body) {
  if (busy) return;
  busy = true;
  render();
  try {
    await api.post("/api/models-policy", { scope, ...body });
    setNotice(scope === "project" ? "Project policy updated - commit aidlc.settings.json and .claude/agents/." : "Your policy for this machine updated.", "info");
    store.emit("wants-refresh");
  } catch (error) {
    setNotice(`Could not change the policy: ${error.message}`, "error");
  } finally {
    busy = false;
    render();
  }
}

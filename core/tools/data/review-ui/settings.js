// Settings. A modal with left navigation, opened from the header's cog or the
// Effort menu's "Settings…" row.
//
// "Models & effort" is the page that matters today. It says what this run
// uses (the composer chip), what "default" resolves to and where that lives
// (read-only: it is the harness's own setting), and edits the project's model
// policy - preset, the three group efforts, per-agent exceptions - through the
// daemon, which runs the same `aidlc config models` the terminal does. A
// change lands in committed files and applies to runs started afterwards; the
// page says both. "Daemon" is read-only facts about this review UI.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./diff.js";
import { setNotice, store } from "./store.js";
import { policyTable } from "./policy.js";

const PAGES = [
  { id: "models", label: "Models & effort" },
  { id: "daemon", label: "Daemon" },
];
const PRESETS = [
  { id: "thorough", label: "Thorough", summary: "Reviewers think hardest" },
  { id: "balanced", label: "Balanced", summary: "The shipped reviewer baseline" },
  { id: "minimal", label: "Minimal", summary: "Lighter reviews, brief write-ups" },
];
const GROUPS = [
  { id: "deciding", label: "Deciding" },
  { id: "reviewing", label: "Reviewing" },
  { id: "writing-up", label: "Writing up" },
];

let root = null;
let page = "models";
let scope = "project"; // project = committed team policy · local = this machine only
let busy = false;

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
      ${page === "models" ? modelsPage() : daemonPage()}
    </section>
  </div>`;
  bind();
}

function modelsPage() {
  const workflow = store.workflow || {};
  const policy = workflow.models_policy;
  const fallback = workflow.runner_default_effort;
  const recorded = policy?.recorded?.[scope];
  const activePreset = recorded?.preset || null;
  const efforts = policy?.efforts || ["low", "medium", "high", "xhigh"];
  const command = workflow.models_command || "aidlc config models";
  const groupValue = (id) => recorded?.groups?.[id] || "";
  const agentsForPicker = policy ? policy.groups.flatMap((group) => group.agents).concat(policy.exceptions.map((entry) => entry.agent)).sort() : [];
  return `<h3>Models &amp; effort</h3>
    <p class="settings-sub">Two separate controls: the effort a run's <em>session</em> thinks at, and the effort each <em>agent</em> is pinned to by project policy. A pin is never capped by the session.</p>

    <div class="settings-block">
      <div class="settings-h">This run <span class="settings-scope">the composer chip</span></div>
      <div class="settings-row"><span class="l">Effort<small>The conductor and every agent that inherits · the same dial as <code>/effort</code></small></span><span class="c">${escapeHtml(workflow.runner_effort ? "chosen when you Start" : "not a per-run dial on this runner")}</span></div>
      <div class="settings-row"><span class="l">Default<small>${fallback ? `From ${escapeHtml(fallback.source)} - your own setting; change it there.` : "No settings file names an effort; the model's own default applies."}</small></span><span class="c">${fallback ? `<b>${escapeHtml(fallback.level)}</b>` : "model default"}</span></div>
    </div>

    <div class="settings-block">
      <div class="settings-h">Project policy <span class="settings-scope">committed · every intent</span>
        <span class="settings-toggle" role="radiogroup" aria-label="Write to">
          <button type="button" role="radio" aria-checked="${scope === "project"}" data-scope="project" title="aidlc.settings.json - committed team policy">Project</button>
          <button type="button" role="radio" aria-checked="${scope === "local"}" data-scope="local" title="aidlc.settings.local.json - this machine only, not committed">Only me</button>
        </span></div>
      ${policy ? "" : `<p class="settings-note">No installed harness this daemon can read a policy for.</p>`}
      <div class="settings-h2">Preset</div>
      <div class="settings-presets">${PRESETS.map((entry) => `<button type="button" role="radio" aria-checked="${activePreset === entry.id}" data-preset="${entry.id}" ${policy ? "" : "disabled"}><b>${entry.label}</b><small>${escapeHtml(entry.summary)}</small></button>`).join("")}</div>
      <div class="settings-h2">Groups <small>the layer's own dial; blank = the preset or shipped default</small></div>
      ${GROUPS.map((group) => `<div class="settings-row"><span class="l">${group.label}</span>
        <select data-group="${group.id}" aria-label="${group.label} effort" ${policy ? "" : "disabled"}>
          <option value="" ${groupValue(group.id) === "" ? "selected" : ""}>-</option>
          ${efforts.map((level) => `<option value="${level}" ${groupValue(group.id) === level ? "selected" : ""}>${level}</option>`).join("")}
        </select></div>`).join("")}
      <div class="settings-h2">Exceptions <small>one agent, its own effort</small></div>
      ${Object.keys(recorded?.agents || {}).length
        ? `<ul class="settings-exceptions">${Object.entries(recorded.agents).map(([agent, value]) => `<li><b>${escapeHtml(agent)}</b> · ${escapeHtml(value.effort || "inherit")}${value.model ? ` · <code>${escapeHtml(value.model)}</code>` : ""}</li>`).join("")}</ul>`
        : `<p class="settings-note">None recorded in this layer.</p>`}
      <form class="settings-exception-form" data-exception-form>
        <select name="agent" aria-label="Agent" ${policy ? "" : "disabled"}>${agentsForPicker.map((agent) => `<option>${escapeHtml(agent)}</option>`).join("")}</select>
        <select name="effort" aria-label="Effort">${efforts.map((level) => `<option>${level}</option>`).join("")}</select>
        <input name="model" type="text" placeholder="model id (optional)" aria-label="Model id" spellcheck="false">
        <button type="submit" class="btn" ${policy ? "" : "disabled"}>Add</button>
      </form>
      <div class="settings-actions">
        <button type="button" class="btn" data-reset ${recorded ? "" : "disabled"}>Reset ${scope === "project" ? "project" : "my"} policy</button>
        <span class="settings-note">Applies to runs started after the change. Written with <code title="${escapeHtml(command)}">aidlc config models --${scope}</code>${scope === "project" ? " - commit the result." : "."}</span>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-h">Effective <span class="settings-scope">${policy?.preset ? `preset ${escapeHtml(policy.preset)}` : policy?.shipped_defaults ? "shipped defaults" : "all layers"}</span></div>
      ${policyTable(policy)}
      ${policy ? `<p class="settings-note">Recorded in: ${["global", "project", "local"].filter((layer) => policy.recorded[layer]).map((layer) => `<code>${layer === "global" ? "install root" : layer === "project" ? "aidlc.settings.json" : "aidlc.settings.local.json"}</code>`).join(", ") || "nothing yet - the shipped defaults apply"}</p>` : ""}
    </div>`;
}

function daemonPage() {
  const workflow = store.workflow || {};
  const daemon = workflow.daemon || {};
  return `<h3>Daemon</h3>
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
  for (const select of root.querySelectorAll("[data-group]")) select.addEventListener("change", () => {
    if (!select.value) {
      setNotice("Clearing one group dial is not a command the policy tool has; use Reset to clear this layer, then set the others again.", "info");
      render();
      return;
    }
    change({ action: "group", group: select.dataset.group, effort: select.value });
  });
  root.querySelector("[data-exception-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const model = String(form.get("model") || "").trim();
    change({ action: "agent", agent: String(form.get("agent")), effort: String(form.get("effort")), ...(model ? { model } : {}) });
  });
  root.querySelector("[data-reset]")?.addEventListener("click", () => {
    if (!window.confirm(`Reset the ${scope === "project" ? "committed project" : "personal"} model policy? Every preset, dial, and exception in that layer is removed.`)) return;
    change({ action: "reset" });
  });
}

async function change(body) {
  if (busy) return;
  busy = true;
  render();
  try {
    await api.post("/api/models-policy", { scope, ...body });
    setNotice(scope === "project" ? "Project policy updated - commit aidlc.settings.json and .claude/agents/. Applies to runs started from now on." : "Your policy for this machine updated. Applies to runs started from now on.", "info");
    store.emit("wants-refresh");
  } catch (error) {
    setNotice(`Could not change the policy: ${error.message}`, "error");
  } finally {
    busy = false;
    render();
  }
}

// Settings. A modal with left navigation, opened from the cog at the bottom of
// the rail.
//
// "Models & Effort" is one page, in the order it is used: your defaults (the
// model and the default effort - the harness's own settings, edited in place
// on Claude), the team's preset (the committed project layer; one card is
// always lit, the shipped default when nothing is recorded), and under the
// Advanced fold your own effort per group - the personal layer, each row's
// first option being the team's value, so every change is undone in place and
// there is no reset. Agents the team pins are shown read-only. Every policy
// change is one `aidlc config models` call through the daemon - the same
// writer the terminal uses; it applies to runs started afterwards. "About" is
// read-only facts about this review UI.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./diff.js";
import { setNotice, store } from "./store.js";

const PAGES = [
  { id: "models", label: "Models & Effort" },
  { id: "about", label: "About" },
];
const PRESETS = [
  { id: "thorough", label: "Thorough", summary: "Reviewers: xhigh · everyone else: default" },
  { id: "balanced", label: "Balanced", summary: "Reviewers: medium · everyone else: default" },
  { id: "minimal", label: "Minimal", summary: "Reviewers: medium · writers: low" },
];
const SESSION_LEVELS = ["low", "medium", "high", "xhigh"];
// Nothing recorded means the shipped tiers, which are the Balanced shape.
const SHIPPED_PRESET = "balanced";

// The card to light: the recorded team preset, else the shipped default -
// unless the project recorded group dials of its own, which is no preset.
function teamPreset(policy) {
  if (!policy) return null;
  if (policy.team?.preset) return policy.team.preset;
  return Object.keys(policy.recorded?.project?.groups || {}).length ? null : SHIPPED_PRESET;
}

let root = null;
let page = "models";
// Two layers are edited here. The preset is the team's policy - the committed
// project layer. A group's effort under Advanced is yours: the personal `local`
// layer, this machine only, over the team's value.
let busy = false;
// Advanced - your own effort per group - is the bottom of the Models &
// effort page, folded until asked for; it opens by itself when you override the
// team on this machine, so that is never hidden.
let advancedOpen = false;
// The harness's model catalogue (GET /api/models): fetched once when Settings
// opens, so the picker offers real names, not ids to type.
let catalogue = null; // { models: [{id, name, description}], current } | null
let catalogueState = "idle"; // idle · loading · ready · failed
let catalogueError = "";

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
  const recorded = store.workflow?.models_policy?.recorded;
  advancedOpen = Boolean(recorded?.local || recorded?.global);
  root.hidden = false;
  render();
  root.querySelector(".settings-nav .on")?.focus();
  if (catalogueState === "idle" && store.workflow?.runner_default_model_editable) loadCatalogue();
}

async function loadCatalogue(refresh = false) {
  catalogueState = "loading";
  render();
  try {
    catalogue = await api.get("/api/models", refresh ? { refresh: "1" } : undefined);
    catalogueState = "ready";
  } catch (error) {
    catalogueState = "failed";
    catalogueError = error.message;
  }
  render();
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

function modelsPage() {
  const workflow = store.workflow || {};
  const policy = workflow.models_policy;
  const fallback = workflow.runner_default_effort;
  // One short caption per row; where a value comes from stays in the tooltip.
  const local = fallback?.source === LOCAL_SETTINGS;
  return `<h3>Models &amp; Effort</h3>

    <div class="settings-block">
      ${modelRow(workflow)}
      <div class="settings-row"><span class="l">Default effort<small>How hard agents think, unless set below</small></span>
        ${workflow.runner_default_effort_editable
          ? `<select data-default-effort aria-label="Default effort" title="${escapeHtml(fallback ? `Your ${harnessName(workflow)} setting - ${fallback.source}` : `No ${harnessName(workflow)} setting names an effort; the model's own default applies`)}">
              <option value="" ${local ? "" : "selected"}>${escapeHtml(fallback && !local ? `Default (${fallback.level})` : "Default")}</option>
              ${SESSION_LEVELS.map((level) => `<option value="${level}" ${local && fallback.level === level ? "selected" : ""}>${level}</option>`).join("")}
            </select>`
          : `<span class="c"><b>${fallback ? escapeHtml(fallback.level) : "default"}</b></span>`}
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-h">Preset</div>
      ${policy ? "" : `<p class="settings-note">No installed harness this daemon can read a policy for.</p>`}
      <div class="settings-presets">${PRESETS.map((entry) => `<button type="button" role="radio" aria-checked="${teamPreset(policy) === entry.id}" data-preset="${entry.id}" ${policy ? "" : "disabled"}><b>${entry.label}${!policy?.team?.preset && entry.id === SHIPPED_PRESET ? ` <span class="settings-tag">default</span>` : ""}</b><small>${escapeHtml(entry.summary)}</small></button>`).join("")}</div>
      <p class="settings-note">How this project balances quality, speed, and cost. Saved with the project, so everyone working on it gets the same.</p>
    </div>

    <div class="settings-block settings-advanced">
      <button type="button" class="settings-disclosure" data-advanced aria-expanded="${advancedOpen}">${icon(advancedOpen ? "chevronDown" : "chevronRight", { size: 12 })}<span>Advanced</span><small>Change a group's effort just for you</small></button>
      ${advancedOpen ? advancedSection(workflow) : ""}
    </div>`;
}

function advancedSection(workflow) {
  const policy = workflow.models_policy;
  const efforts = policy?.efforts || ["low", "medium", "high", "xhigh"];
  const teamGroups = policy?.team?.groups || [];
  const teamPins = policy?.team?.exceptions || [];
  const presetLabel = PRESETS.find((entry) => entry.id === teamPreset(policy))?.label;
  const groupRow = (group) => {
    // The first option is what the team's preset gives this group; picking a
    // level records your own dial (aidlc.settings.local.json, this machine
    // only); picking the first option again removes it.
    const team = group.effort;
    const mine = policy.recorded?.local?.groups?.[group.id] || "";
    const from = policy.recorded?.project?.groups?.[group.id] ? "custom" : presetLabel || "Default";
    const teamLabel = `Project: ${from} · ${team === INHERIT ? "default" : team}`;
    return `<div class="settings-row">
      <span class="l">${escapeHtml(group.label)}<small>${escapeHtml(group.agents.join(", "))}</small></span>
      ${mine ? `<span class="settings-overridden" role="img" aria-label="Overridden">${icon("errorCircle", { size: 15 })}</span>` : ""}
      <select data-group="${group.id}" aria-label="${escapeHtml(group.label)} effort">
        <option value="" ${mine ? "" : "selected"}>${escapeHtml(teamLabel)}</option>
        ${efforts.map((level) => `<option value="${level}" ${mine === level ? "selected" : ""}>${level}</option>`).join("")}
      </select>
    </div>`;
  };
  const overridden = teamGroups.some((group) => policy?.recorded?.local?.groups?.[group.id]);
  return `<div class="settings-block">
      ${policy ? teamGroups.map(groupRow).join("") : `<p class="settings-note">No installed harness this daemon can read a policy for.</p>`}
      ${teamPins.length ? `<div class="settings-row"><span class="l">Set individually<small>Agents given their own level in this project</small></span>
        <span class="c">${teamPins.map((entry) => `<span class="settings-pin">${escapeHtml(entry.agent)} · ${escapeHtml(entry.effort || "inherit")}${entry.model ? ` · ${escapeHtml(entry.model)}` : ""}</span>`).join("")}</span></div>` : ""}
      ${overridden ? `<p class="settings-legend"><span class="settings-overridden">${icon("errorCircle", { size: 13 })}</span> Overridden</p>` : ""}
    </div>
    ${personalNote(policy)}`;
}

// Personal entries with no control above - a preset or agent pin in your
// local layer, or anything in the machine-wide global layer - are set from the
// terminal; name them, because they change what runs on this machine and are
// not part of the team's view shown here.
function personalNote(policy) {
  const describe = (layer, withGroups) => layer ? [
    ...(layer.preset ? [`preset ${layer.preset}`] : []),
    ...(withGroups ? Object.entries(layer.groups).map(([group, effort]) => `${group} ${effort}`) : []),
    ...Object.entries(layer.agents).map(([agent, value]) => `${agent} pinned ${value.effort || ""}${value.model ? ` ${value.model}` : ""}`.trim()),
  ] : [];
  const local = describe(policy?.recorded?.local, false);
  const global = describe(policy?.recorded?.global, true);
  if (!local.length && !global.length) return "";
  return `<p class="settings-note settings-personal">Also yours, set from the terminal: ${[
    local.length ? `${escapeHtml(local.join(" · "))} (<code>--local</code>)` : "",
    global.length ? `${escapeHtml(global.join(" · "))} (<code>--global</code>, every project)` : "",
  ].filter(Boolean).join("; ")}.</p>`;
}

const LOCAL_SETTINGS = ".claude/settings.local.json";

// The session's model: the harness's own `model` setting, which every agent
// without a pin uses. Your harness default (from its own settings files) is the
// first choice, named; the rest is the harness's real catalogue - the same list
// its own model picker shows. Choosing another is an AI-DLC override for this
// project, for you; choosing the first clears it.
function modelName(id) {
  const entry = catalogue?.models?.find((model) => model.id === id);
  if (entry) return entry.name;
  // A setting may be an alias ("fable") the catalogue spells as an id ("claude-fable-5").
  const alias = catalogue?.models?.find((model) => model.id.toLowerCase().includes(String(id).toLowerCase()));
  return alias ? alias.name : id;
}

function modelRow(workflow) {
  const current = workflow.runner_default_model; // {value, source} | null
  const editable = workflow.runner_default_model_editable;
  const local = current?.source === LOCAL_SETTINGS;
  const harnessDefault = local ? null : current; // what applies with no override of ours
  const defaultLabel = harnessDefault
    ? `${modelName(harnessDefault.value)} · your ${harnessName(workflow)} default`
    : catalogue?.current ? `${modelName(catalogue.current)} · your ${harnessName(workflow)} default` : `your ${harnessName(workflow)} default`;
  const title = local
    ? `Your override for this project (${LOCAL_SETTINGS}); the first option returns to your ${harnessName(workflow)} default`
    : harnessDefault
      ? `Your ${harnessName(workflow)} default, from ${harnessDefault.source}; pick another to override it for this project`
      : `${harnessName(workflow)} picks; pick one to set it for this project`;
  let control;
  if (!editable) {
    control = `<span class="c"><b>${escapeHtml(current ? modelName(current.value) : "harness default")}</b></span>`;
  } else if (catalogueState === "loading" || catalogueState === "idle") {
    control = `<span class="c settings-loading">Asking ${escapeHtml(harnessName(workflow))} for its models…</span>`;
  } else if (catalogueState === "failed") {
    control = `<span class="c"><b>${escapeHtml(current ? modelName(current.value) : "harness default")}</b> <button type="button" class="btn" data-models-retry title="${escapeHtml(catalogueError)}">Retry</button></span>`;
  } else {
    const models = catalogue?.models || [];
    control = `<select data-default-model aria-label="Default model" title="${escapeHtml(title)}">
      <option value="" ${local ? "" : "selected"}>${escapeHtml(defaultLabel)}</option>
      ${models.map((model) => `<option value="${escapeHtml(model.id)}" ${local && current.value === model.id ? "selected" : ""} ${model.description ? `title="${escapeHtml(model.description)}"` : ""}>${escapeHtml(model.name)}</option>`).join("")}
      ${local && !models.some((model) => model.id === current.value) ? `<option value="${escapeHtml(current.value)}" selected>${escapeHtml(current.value)}</option>` : ""}
    </select>`;
  }
  return `<div class="settings-row"><span class="l">Default model<small>The model all agents use</small></span>${control}</div>`;
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
      <div class="settings-row"><span class="l">Agent runner</span><span class="c">${workflow.runner ? "available" : escapeHtml(workflow.runner_requirement ? `off · needs ${workflow.runner_requirement}` : "off")}</span></div>
      <div class="settings-row"><span class="l">Per-run effort dial</span><span class="c">${workflow.runner_effort ? "yes" : "no"}</span></div>
    </div>
    <p class="settings-note">Stop or restart from a terminal: <code>aidlc ui stop</code> · <code>aidlc ui start</code>.</p>`;
}

function bind() {
  root.querySelector("[data-close]")?.addEventListener("click", close);
  for (const button of root.querySelectorAll("[data-page]")) button.addEventListener("click", () => { page = button.dataset.page; render(); });
  for (const button of root.querySelectorAll("[data-preset]")) button.addEventListener("click", () => change("project", { action: "preset", preset: button.dataset.preset }));
  root.querySelector("[data-models-retry]")?.addEventListener("click", () => loadCatalogue(true));
  root.querySelector("[data-advanced]")?.addEventListener("click", () => { advancedOpen = !advancedOpen; render(); });
  root.querySelector("[data-default-model]")?.addEventListener("change", async (event) => {
    const model = event.target.value;
    if (busy) return;
    busy = true;
    render();
    try {
      await api.post("/api/default-model", { model: model || null });
      setNotice(model ? "Model saved. Your next runs use it." : "Back to your default model.", "info");
      store.emit("wants-refresh");
    } catch (error) {
      setNotice(`Could not change the default model: ${error.message}`, "error");
    } finally {
      busy = false;
      render();
    }
  });
  root.querySelector("[data-default-effort]")?.addEventListener("change", async (event) => {
    if (busy) return;
    busy = true;
    render();
    try {
      await api.post("/api/default-effort", { level: event.target.value || null });
      setNotice("Default effort saved. Your next runs use it.", "info");
      store.emit("wants-refresh");
    } catch (error) {
      setNotice(`Could not change the default effort: ${error.message}`, "error");
    } finally {
      busy = false;
      render();
    }
  });
  for (const select of root.querySelectorAll("[data-group]")) select.addEventListener("change", () => {
    const group = select.dataset.group;
    change("local", select.value ? { action: "group", group, effort: select.value } : { action: "clear-group", group });
  });
}

async function change(scope, body) {
  if (busy) return;
  busy = true;
  render();
  try {
    await api.post("/api/models-policy", { scope, ...body });
    setNotice(scope === "local"
      ? "Saved on this computer. Your next runs use it."
      : "Preset saved. Commit the settings changes to share it.", "info");
    store.emit("wants-refresh");
  } catch (error) {
    setNotice(`Could not change the policy: ${error.message}`, "error");
  } finally {
    busy = false;
    render();
  }
}

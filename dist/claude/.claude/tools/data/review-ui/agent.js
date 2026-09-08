// The Agent panel: the daemon-run session for the viewed intent.
//
// What the human sees here is the run the daemon started from the composer
// (Start), or re-attached after a restart: its state, whatever it is waiting on
// (a tool it wants permission for, a question it asked), and a compact log of
// what it said and did. Answering here is the same act as answering in the
// terminal - the daemon relays it over ACP - so nothing in the record changes
// shape. Continue sends the next prompt to an idle session; Stop cancels the
// turn.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { setNotice, store } from "./store.js";

const slot = document.getElementById("slot");
let loading = false;
let lastIntent = null;
const seenPending = new Set();

const STATE = {
  starting: { label: "Starting the agent", tone: "needs", working: true },
  running: { label: "Agent working", tone: "needs", working: true },
  waiting: { label: "Waiting for you", tone: "attention", working: false },
  idle: { label: "Agent stopped", tone: "quiet", working: false },
  ended: { label: "Run ended", tone: "quiet", working: false },
  failed: { label: "Run failed", tone: "error", working: false },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function runState() {
  return store.run?.run?.state ?? null;
}

export function pendingCount() {
  return store.run?.pending?.length ?? 0;
}

export function init() {
  store.on("panel", render);
  store.on("run", render);
  store.on("refresh", () => {
    const intent = store.workflow?.intent || null;
    if (intent !== lastIntent) {
      lastIntent = intent;
      store.set({ run: null });
      seenPending.clear();
    }
    void load();
  });
  store.on("run-changed", (intents) => {
    const intent = store.workflow?.intent;
    if (intent && Array.isArray(intents) && intents.includes(intent)) void load();
  });
}

async function load() {
  const intent = store.workflow?.intent;
  if (!intent || loading) return;
  loading = true;
  try {
    const run = await api.get("/api/run", { intent });
    store.set({ run });
    const fresh = (run.pending || []).filter((input) => !seenPending.has(`${intent}:${input.id}`));
    for (const input of fresh) seenPending.add(`${intent}:${input.id}`);
    // Something needs the human: bring the panel up once per item, never on a
    // re-render, and never over the inbox (the intent is opened first there).
    if (fresh.length && store.panel !== "agent" && store.view.kind !== "inbox") store.set({ panel: "agent" });
  } catch (error) {
    if (store.panel === "agent") console.warn("[review-ui] /api/run unavailable", error);
  } finally {
    loading = false;
  }
}

function render() {
  if (store.panel !== "agent") return;
  slot.dataset.panel = "agent";
  const view = store.run;
  const run = view?.run ?? null;
  const state = run ? STATE[run.state] ?? STATE.idle : null;
  const intent = store.workflow?.intent;
  slot.innerHTML = `
    <section class="agent-panel" aria-labelledby="agent-title">
      <header class="side-panel-header">
        <div><h2 id="agent-title">Agent</h2><span>${escapeHtml(intent || "")}</span><button class="side-panel-close" type="button" aria-label="Close panel">×</button></div>
        ${run ? `<div class="agent-state ${state.tone}">${state.working ? '<i class="spin" aria-hidden="true"></i>' : ""}<b>${escapeHtml(state.label)}</b><span>· turn ${run.turns}${run.session_effort ? ` · effort ${escapeHtml(run.session_effort)}` : ""}${run.last_stop_reason && !state.working ? ` · ${escapeHtml(run.last_stop_reason.replaceAll("_", " "))}` : ""}</span></div>` : ""}
      </header>
      <div class="agent-body">
        ${run ? "" : renderNoRun(view)}
        ${renderLog(view?.events || [])}
        ${run?.error ? `<p class="agent-error">${escapeHtml(run.error)}</p>` : ""}
        ${(view?.pending || []).map(renderPending).join("")}
      </div>
      ${run ? renderFooter(run) : ""}
    </section>`;
  bind();
  const body = slot.querySelector(".agent-body");
  if (body) body.scrollTop = body.scrollHeight;
}

function renderNoRun(view) {
  if (!store.workflow?.intent) return '<p class="side-panel-empty"><b>No intent selected.</b>Choose an intent to see its agent.</p>';
  const resume = view?.start_prompt || "/aidlc";
  if (view && view.available === false) {
    return `<p class="side-panel-empty"><b>No agent runner on this machine.</b>The daemon needs ${view.requirement ? escapeHtml(view.requirement) : "the harness's CLI"} to run an agent here. Drive this intent from a terminal with <code>${escapeHtml(resume)}</code>.</p>`;
  }
  return `<p class="side-panel-empty"><b>No agent run for this intent.</b>Start one here, or continue in a terminal with <code>${escapeHtml(resume)}</code>.</p>
    <div class="agent-actions"><button type="button" class="btn primary" data-run-start>${icon("arrowLeft", { size: 14 })} Run the agent</button></div>`;
}

function renderFooter(run) {
  const live = run.state === "starting" || run.state === "running" || run.state === "waiting";
  if (live) return `<footer class="agent-foot"><span>${run.state === "waiting" ? "Answer above to let the agent continue." : "The agent is working; everything it needs from you appears here."}</span><button type="button" class="btn" data-run-cancel>Stop</button></footer>`;
  if (run.state === "idle") {
    // An agent that asks in prose ends its turn: the reply goes back as the
    // next prompt. Continue sends the harness's own resume prompt instead.
    const resume = store.run?.start_prompt || "/aidlc";
    return `<footer class="agent-foot reply">
      <form class="agent-reply"><input type="text" name="reply" placeholder="Reply to the agent…" aria-label="Reply to the agent" autocomplete="off"><button type="submit" class="btn primary">Send</button></form>
      <div class="agent-foot-row"><span>The agent stopped. Continue sends <code>${escapeHtml(resume)}</code> to the same session.</span><button type="button" class="btn" data-run-continue>Continue</button></div>
    </footer>`;
  }
  return `<footer class="agent-foot"><span>${run.state === "failed" ? "Start a new run to continue from the record." : "This run is over."}</span><button type="button" class="btn primary" data-run-start>Run again</button></footer>`;
}

function inputSummary(toolCall) {
  const raw = toolCall.rawInput;
  if (!raw || typeof raw !== "object") return "";
  const command = raw.command ?? raw.cmd;
  if (typeof command === "string") return command;
  const path = raw.file_path ?? raw.path ?? raw.notebook_path;
  if (typeof path === "string") return path;
  const pattern = raw.pattern ?? raw.query ?? raw.url;
  if (typeof pattern === "string") return pattern;
  const text = JSON.stringify(raw);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function renderPending(input) {
  if (input.kind === "permission") {
    const summary = inputSummary(input.tool_call);
    return `<article class="agent-card permission" data-pending="${escapeHtml(input.id)}">
      <header><span class="agent-kind">${escapeHtml(input.tool_call.kind || "tool")}</span><b>${escapeHtml(input.tool_call.title)}</b></header>
      ${summary ? `<pre class="agent-input">${escapeHtml(summary)}</pre>` : ""}
      <div class="agent-card-actions">${input.options
        .map((option) => `<button type="button" class="btn ${option.kind.startsWith("allow") ? (option.kind === "allow_once" ? "primary" : "") : "danger"}" data-permission="${escapeHtml(option.optionId)}">${escapeHtml(option.name)}</button>`)
        .join("")}</div>
    </article>`;
  }
  const fields = Object.entries(input.schema?.properties || {});
  return `<article class="agent-card question" data-pending="${escapeHtml(input.id)}">
    <header><span class="agent-kind">question</span><b>${escapeHtml(input.message)}</b></header>
    <form class="agent-form">
      ${fields.map(([key, field]) => renderField(key, field, fields.length)).join("")}
      <div class="agent-card-actions"><button type="submit" class="btn primary">Answer</button><button type="button" class="btn" data-question-skip>Skip</button></div>
    </form>
  </article>`;
}

function renderField(key, field, count) {
  const options = field.oneOf || field.items?.anyOf || null;
  const multi = field.type === "array";
  const title = field.title && field.title !== "Other" ? field.title : null;
  const description = field.description || (count > 2 && !title ? "" : "");
  if (options) {
    return `<fieldset class="agent-field"><legend>${escapeHtml(title || "")}${description ? `<small>${escapeHtml(description)}</small>` : ""}</legend>
      ${options
        .map((option, index) => `<label class="agent-option"><input type="${multi ? "checkbox" : "radio"}" name="${escapeHtml(key)}" value="${escapeHtml(option.const)}" ${!multi && index === 0 ? "" : ""}><span><b>${escapeHtml(option.title || option.const)}</b>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`)
        .join("")}
    </fieldset>`;
  }
  const isCustom = /_custom$/.test(key) || field.title === "Other";
  return `<label class="agent-field-text"><span>${escapeHtml(isCustom ? "Or type your own answer" : title || key)}</span><input type="text" name="${escapeHtml(key)}" placeholder="${escapeHtml(isCustom ? "optional" : "")}"></label>`;
}

function renderLog(events) {
  if (!events.length) return "";
  const rows = events.slice(-160).map((event) => {
    switch (event.kind) {
      case "text":
        return `<p class="agent-text">${escapeHtml(event.text)}</p>`;
      case "tool":
        return `<div class="agent-tool ${escapeHtml(event.status || "")}"><i class="tool-dot"></i><span>${escapeHtml(event.title)}</span><small>${escapeHtml(event.tool_kind || "")}</small></div>`;
      case "turn":
        return event.phase === "start"
          ? `<div class="agent-turn">${icon("send", { size: 12 })}<span>${escapeHtml(event.prompt || "")}</span></div>`
          : `<div class="agent-turn stop"><span>stopped · ${escapeHtml((event.stop_reason || "").replaceAll("_", " "))}</span></div>`;
      case "permission":
        return `<div class="agent-mark">${icon("checkmarkCircle", { size: 12 })}<span>${escapeHtml(event.title)}${event.decision ? ` · ${escapeHtml(event.decision)}` : " · waiting"}</span></div>`;
      case "question":
        return `<div class="agent-mark">${icon("question", { size: 12 })}<span>${escapeHtml(event.message)}${event.answered ? " · answered" : ""}</span></div>`;
      case "error":
        return `<p class="agent-error">${escapeHtml(event.text)}</p>`;
      default:
        return `<div class="agent-note">${escapeHtml(event.text || "")}</div>`;
    }
  });
  return `<div class="agent-log">${rows.join("")}</div>`;
}

function bind() {
  const intent = store.workflow?.intent;
  slot.querySelector(".side-panel-close")?.addEventListener("click", () => store.set({ panel: null }));
  for (const button of slot.querySelectorAll("[data-permission]")) {
    button.addEventListener("click", async () => {
      const id = button.closest("[data-pending]")?.dataset.pending;
      await act("/api/run/permission", { intent, id, option_id: button.dataset.permission }, "Could not send the decision");
    });
  }
  for (const form of slot.querySelectorAll(".agent-form")) {
    const id = form.closest("[data-pending]")?.dataset.pending;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const content = {};
      const data = new FormData(form);
      for (const input of form.querySelectorAll("input[name]")) {
        const key = input.name;
        if (input.type === "checkbox") {
          if (!(key in content)) content[key] = [];
          if (input.checked) content[key].push(input.value);
        } else if (input.type === "radio") {
          if (input.checked) content[key] = input.value;
        } else if (data.get(key)) {
          content[key] = String(data.get(key)).trim();
        }
      }
      for (const [key, value] of Object.entries(content)) if (Array.isArray(value) && !value.length) delete content[key];
      await act("/api/run/question", { intent, id, action: "accept", content }, "Could not send the answer");
    });
    form.querySelector("[data-question-skip]")?.addEventListener("click", async () => {
      await act("/api/run/question", { intent, id, action: "decline" }, "Could not skip the question");
    });
  }
  slot.querySelector("[data-run-cancel]")?.addEventListener("click", async () => {
    await act("/api/run/cancel", { intent }, "Could not stop the agent");
  });
  slot.querySelector("[data-run-continue]")?.addEventListener("click", async () => {
    await act("/api/run/prompt", { intent }, "Could not continue the agent");
  });
  slot.querySelector(".agent-reply")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input[name=reply]");
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    await act("/api/run/prompt", { intent, text }, "Could not send the reply");
  });
  slot.querySelector("[data-run-start]")?.addEventListener("click", async () => {
    await act("/api/run/prompt", { intent, start: true }, "Could not start the agent");
  });
}

async function act(path, body, failure) {
  try {
    await api.post(path, body);
    await load();
  } catch (error) {
    setNotice(`${failure}: ${error.message}`, "error");
  }
}

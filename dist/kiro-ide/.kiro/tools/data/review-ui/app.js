// AI-DLC Workflows review UI — bootstrap. Loads state + workflow, wires the
// live socket, and hands each region to its module. Modules talk through the
// store only (see store.js); this file owns nothing but the wiring.

import { api, connectSocket } from "./api.js";
import { store, restoreAnnotations } from "./store.js";
import { init as initShell } from "./shell.js";
import { init as initWorkflow } from "./workflow.js";
import { init as initDocument } from "./document.js";
import { init as initThreads } from "./threads.js";
import { init as initHistory } from "./history.js";
import { init as initQuestions } from "./questions.js";

const elements = {
  notice: document.getElementById("notice"),
  paused: document.getElementById("paused-overlay"),
  app: document.getElementById("app"),
  body: document.querySelector(".body"),
  slot: document.getElementById("slot"),
};

let refreshing = null;

/** Reload /api/state and /api/workflow (for the viewed intent) and publish. */
export async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const intent = store.view.intent || undefined;
      const [state, workflow] = await Promise.all([
        api.get("/api/state"),
        api.get("/api/workflow", { intent }).catch((error) => {
          console.warn("[review-ui] /api/workflow unavailable", error);
          return null;
        }),
      ]);
      const stageChanged =
        !store.state ||
        store.state.current?.stage !== state.current?.stage ||
        store.state.current?.revision !== state.current?.revision ||
        store.state.current?.unit !== state.current?.unit;
      store.set({ state, workflow });
      if (stageChanged) store.set({ annotations: restoreAnnotations(state) });
      store.emit("refresh", { state, workflow });
    } catch (error) {
      store.emit("notice", { message: error.message, kind: "error" });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function wireChrome() {
  store.on("notice", (notice) => {
    if (!notice) {
      elements.notice.hidden = true;
      elements.notice.textContent = "";
      return;
    }
    elements.notice.textContent = notice.message;
    elements.notice.className = `notice ${notice.kind || "error"}`;
    elements.notice.hidden = false;
    if (notice.kind === "info") setTimeout(() => store.emit("notice", null), 6000);
  });
  store.on("paused", (message) => {
    if (!message) {
      elements.paused.classList.add("connected");
      return;
    }
    elements.paused.textContent = message;
    elements.paused.classList.remove("connected");
  });
  store.on("sidebar", (visible) => elements.app.classList.toggle("panel-hidden", !visible));
  store.on("panel", (panel) => {
    elements.slot.hidden = !panel;
    elements.body.classList.toggle("slot-hidden", !panel);
  });
  document.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      store.emit("palette", true);
    }
    if (meta && event.key === "\\") {
      event.preventDefault();
      store.set({ sidebar: !store.sidebar });
    }
  });
}

async function boot() {
  wireChrome();
  initShell();
  initWorkflow();
  initDocument();
  initThreads();
  initHistory();
  initQuestions();
  store.set({ sidebar: true, panel: store.panel });
  await refresh();
  connectSocket(() => {
    refresh();
  });
}

boot();

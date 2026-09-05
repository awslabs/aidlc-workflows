// Fetch helpers and the live socket. Cookie auth is automatic (same origin);
// a 401 means the daemon restarted or the session lapsed — reload once, then
// explain if still signed out (copied behaviour from the previous app).

import { store } from "./store.js";

export const PAUSED = {
  reconnecting: "Live updates paused — reconnecting…",
  renewing: "Review session renewed — reloading…",
  ended:
    "Your review session ended (the daemon restarted or the session expired). Run /aidlc --status in your harness and open the new link.",
  down: "Review daemon stopped — it restarts with your next AI-DLC session. Run /aidlc --doctor for the manual command.",
};

const REAUTH_STAMP_KEY = "aidlc-review-reauth-at";
const REAUTH_LOOP_WINDOW_MS = 15_000;

function sessionLost() {
  const last = Number(sessionStorage.getItem(REAUTH_STAMP_KEY) || 0);
  if (Date.now() - last < REAUTH_LOOP_WINDOW_MS) {
    store.emit("paused", PAUSED.ended);
    return;
  }
  sessionStorage.setItem(REAUTH_STAMP_KEY, String(Date.now()));
  store.emit("paused", PAUSED.renewing);
  window.location.reload();
}

export const api = {
  url(path, params = {}) {
    const url = new URL(path, window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
  },
  async get(path, params) {
    return request(api.url(path, params));
  },
  async post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  async text(path, params) {
    const response = await fetch(api.url(path, params));
    if (response.status === 401) {
      sessionLost();
      throw new Error("review session ended — renewing");
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  },
};

async function request(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    sessionLost();
    throw new Error("review session ended — renewing");
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // keep the status line
    }
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

let socket = null;
let retry = 0;
let timer = null;

/** Connect to /ws; `onState` runs on every `{type:"state"}` invalidation. */
export function connectSocket(onState) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener("open", () => {
    retry = 0;
    store.set({ connected: true });
    store.emit("paused", null);
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message && message.type === "state") onState();
    } catch {
      // ignore malformed frames
    }
  });
  const lost = async () => {
    store.set({ connected: false });
    // Distinguish "daemon gone" from "session lapsed" with one cheap probe.
    let alive = false;
    try {
      const health = await fetch("/api/health", { cache: "no-store" });
      alive = health.ok;
    } catch {
      alive = false;
    }
    if (!alive) store.emit("paused", retry > 3 ? PAUSED.down : PAUSED.reconnecting);
    else store.emit("paused", PAUSED.reconnecting);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
    retry += 1;
    timer = setTimeout(() => connectSocket(onState), delay);
  };
  socket.addEventListener("close", lost, { once: true });
  socket.addEventListener("error", () => socket?.close(), { once: true });
}

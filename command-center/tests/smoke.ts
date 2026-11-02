// Headless-Chrome smoke: boots the server on a synthetic fixture, screenshots each view in light and dark,
// waits for each view to render its data (lens roots carry `data-loaded`), and fails on any uncaught error or console call. Usage: bun tests/smoke.ts "#/,#/i/..."
import { existsSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../core/command-center/server/config";
import { startServer } from "../../core/command-center/server/index";
import { AUDIT_HEADER, block, makeWorkspace } from "./fixtures/make";
import { makeManyWorkspaces } from "./fixtures/many";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = 60_000;
const ws = await makeWorkspace({ questions: {
  // Q3 is the worded-heading, un-bulleted, "select all that apply" shape a real run writes.
  "ideation/feasibility/feasibility-questions.md": "## Q1. Does anything internal already cover this?\n- A. Not yet verified\n- B. Already checked: nothing covers it\n- X. Other (please specify)\n\n[Answer]: B\n\n## Q2. Where does V1 run?\n- A. Locally\n- B. A shared environment\n- X. Other (please specify)\n\n[Answer]: X Both, with per-env timeouts\n\n## Question 3 — Hard rules the team must follow? (select all that apply)\nThese become rules every later step obeys.\n\nA. NEVER hardcode secrets\nB. ALWAYS encrypt at rest\nC. ALWAYS use least-privilege roles\nX. Other (please specify)\n\n[Answer]: B, C\n",
  "construction/beta/code-generation/code-generation-questions.md": "## Q1. Generate in four steps?\n- A. Yes\n- B. No\n\n[Answer]:\n",
},
  // Agent decisions as a real run records them: one plain ask, one batch whose answer names an option that was never
  // offered, and one still waiting on an answer.
  extraShard: AUDIT_HEADER
    + block("2026-08-13T11:20:00Z", "DECISION_RECORDED", { Stage: "feasibility", Decision: "How would you like to answer the questions?", Options: "Guide me,I'll edit the file,Chat" })
    + block("2026-08-13T11:21:00Z", "QUESTION_ANSWERED", { Stage: "feasibility", Details: "Guide me" })
    + block("2026-08-13T11:22:00Z", "DECISION_RECORDED", { Stage: "feasibility", Decision: "Questions 1-2: coverage, where V1 runs", Options: "Q1: Not yet verified / Already checked; Q2: Locally / A shared environment" })
    + block("2026-08-13T11:23:00Z", "QUESTION_ANSWERED", { Stage: "feasibility", Details: "Q1: Already checked; Q2: both, with per-env timeouts" })
    + block("2026-08-13T11:24:00Z", "DECISION_RECORDED", { Stage: "code-generation", Unit: "beta", Decision: "Generate the four steps in one pass?", Options: "One pass,Step by step" }) });
// A discovery root holding a second fixture project, a root with nothing under it, and saved repo URLs, so the
// settings view lists every kind of entry and every kind of row.
const root = await mkdtemp(join(tmpdir(), "cc-root-"));
await rename(await makeWorkspace(), join(root, "sample-app"));
const bare = await mkdtemp(join(tmpdir(), "cc-bare-"));
const s = await startServer({ port: 0, config: { version: 1, roots: [root, bare], pins: [ws], hidden: [join(root, "retired-app")],
  repos: ["https://github.com/example/app", "git@gitlab.com:example/svc.git"], theme: "auto" }, configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
const origin = new URL(s.url).origin;
// Default views: Home, Workspaces & settings, and the fixture's focused intent in every lens (Story is the default, no slug).
const fixtureIntent = `#/i/${encodeURIComponent(ws)}/default/260811-demo`;
const LENS_SLUGS = ["", "/decisions", "/artifacts", "/reviews", "/issues", "/units", "/learnings", "/timeline", "/tokens"];
const views = (process.argv[2] ?? ["#/", "#/health", "#/?settings=1", ...LENS_SLUGS.map((l) => `${fixtureIntent}${l}`)].join(",")).split(",");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once the view has rendered its data: a lens marks its root `data-loaded` ("error" when its payload failed). */
const READY = `(() => {
  const h = location.hash;
  if (/^#\\/i\\/[^/]+\\/[^/]+\\/[^/]+\\/[^/]+/.test(h)) return document.querySelector("[data-loaded]")?.getAttribute("data-loaded") ?? null;
  if (/settings=1/.test(h)) return document.querySelector(".dlg.settings-dlg[data-loaded]") ? "" : null;
  if (h.startsWith("#/health")) return document.querySelector(".hl-page[data-loaded], .panel[data-loaded=error]")?.getAttribute("data-loaded") ?? null;
  if (h.startsWith("#/i/")) return document.querySelector(".tabs") ? "" : null;
  return document.querySelector(".ws, .card, .needs") ? "" : null;
})()`;

/**
 * Drives headless Chrome over the DevTools protocol: load the view, wait until READY (at most TIMEOUT_MS), screenshot.
 * Console calls and uncaught exceptions from the page are collected; the Chrome process is killed by its profile.
 */
async function shoot(url: string, out: string, dark: boolean, prep: string[] = []): Promise<{ errors: string[]; ok: boolean }> {
  rmSync(out, { force: true });
  const profile = await mkdtemp(join(tmpdir(), "cc-chrome-"));
  const p = Bun.spawn([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    "--remote-debugging-port=0", "--window-size=1500,1100", "about:blank"], { stderr: "pipe", stdout: "ignore" });
  const errors: string[] = []; let ok = false;
  try {
    let log = ""; let wsUrl: string | null = null; const t0 = Date.now();
    const dec = new TextDecoder(); const rd = p.stderr.getReader();
    while (!wsUrl && Date.now() - t0 < TIMEOUT_MS) {
      const { value, done } = await rd.read(); if (done) break;
      log += dec.decode(value); wsUrl = /DevTools listening on (ws:\/\/\S+)/.exec(log)?.[1] ?? null;
    }
    void (async () => { try { for (;;) { const { done } = await rd.read(); if (done) break; } } catch { /* closed */ } })();
    if (!wsUrl) { errors.push("Chrome did not expose DevTools"); return { errors, ok }; }
    const browser = new WebSocket(wsUrl); await new Promise((r, j) => { browser.onopen = r; browser.onerror = j; });
    let id = 0; const pend = new Map<number, (v: any) => void>();
    let session = "";
    browser.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? { error: m.error }); pend.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") errors.push(`Uncaught ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === "Runtime.consoleAPICalled") errors.push(`console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !String(m.params.entry.url ?? "").startsWith("chrome-extension:")) errors.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pend.set(i, r); browser.send(JSON.stringify({ id: i, method, params, ...(session ? { sessionId: session } : {}) })); });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    session = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    let state: string | null = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
      state = (await send("Runtime.evaluate", { expression: READY, returnByValue: true })).result?.value ?? null;
      if (state !== null) break;
      await sleep(150);
    }
    // `prep`: page scripts run in turn once the view is ready (e.g. pick a view and reload, open a group); READY is awaited after each.
    for (const step of prep) {
      if (state === null) break;
      await send("Runtime.evaluate", { expression: step });
      await sleep(400); state = null;
      while (Date.now() - t0 < TIMEOUT_MS) {
        state = (await send("Runtime.evaluate", { expression: READY, returnByValue: true })).result?.value ?? null;
        if (state !== null) break;
        await sleep(150);
      }
    }
    if (state === null) errors.push("view never finished loading");
    else if (state === "error") errors.push("lens payload failed to load");
    await sleep(400); // let late console output arrive
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.data) { await Bun.write(out, Buffer.from(shot.data, "base64")); ok = existsSync(out) && statSync(out).size > 0; }
    browser.close();
  } finally {
    p.kill(9); await p.exited;
    rmSync(profile, { recursive: true, force: true });
  }
  return { errors, ok };
}

let failed = false;
const check = (theme: string, name: string, out: string, r: { errors: string[]; ok: boolean }) => {
  if (!r.ok) { failed = true; console.error("no screenshot", theme, name, r.errors.join("\n")); }
  else if (r.errors.length) { failed = true; console.error(theme, name, r.errors.join("\n")); }
  else console.log("ok", theme, name, out);
};
for (const theme of ["light", "dark"]) for (const v of views) {
  const out = join(tmpdir(), `cc-smoke-${theme}-${v.replace(/\W+/g, "_")}.png`);
  check(theme, v, out, await shoot(`${s.url}${v}`, out, theme === "dark"));
}
// Workspaces & settings with a row ticked in the first two tables: the bulk bar (default run only, no edit is saved).
if (!process.argv[2]) for (const theme of ["light", "dark"]) {
  const out = join(tmpdir(), `cc-smoke-${theme}-settings_selected.png`);
  const prep = [`document.querySelectorAll(".stable tbody tr.st-row td.st-ck input").forEach((el, i) => { if (i < 2) el.click(); })`,
    // Remove root is quiet until its row is hovered or it takes focus; focusing it proves the keyboard can reach it.
    `document.querySelector(".st-rmroot")?.focus()`];
  check(theme, "settings-selected", out, await shoot(`${s.url}#/?settings=1`, out, theme === "dark", prep));
}
s.stop();

// Home at scale (default run only): 20 synthetic intents in three workspaces plus a missing pin. The AUTO view is the
// compact list; the second shot overrides to cards, groups by status and opens the completed rows.
if (!process.argv[2]) {
  const many = await startServer({ port: 0, config: validateConfig({ pins: await makeManyWorkspaces(), theme: "auto" }), configPath: join(await mkdtemp(join(tmpdir(), "cc-")), "c.json") });
  const shots: [string, string[]][] = [
    ["scale-compact", []],
    ["scale-cards-status", [`localStorage.setItem("cc-home-view", "cards"); sessionStorage.setItem("cc-home-prefs", JSON.stringify({ group: "status" })); location.reload()`,
      `document.querySelector(".showdone")?.click()`]],
  ];
  for (const theme of ["light", "dark"]) for (const [name, prep] of shots) {
    const out = join(tmpdir(), `cc-smoke-${theme}-${name}.png`);
    check(theme, name, out, await shoot(`${many.url}#/`, out, theme === "dark", prep));
  }
  many.stop();
}
process.exit(failed ? 1 : 0);

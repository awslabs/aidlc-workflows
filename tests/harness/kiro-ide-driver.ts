// kiro-ide-driver.ts - BUN-ONLY raw Chrome DevTools Protocol driver for the Kiro
// IDE (the Electron desktop app). The harness twin of tui-drive.ts (Kiro CLI over
// tmux) and kiro-acp-drive.ts (Kiro CLI over ACP) - this one drives the GUI app.
//
// WHY raw CDP and NOT Playwright (proven in the issue #451 spike):
//   - electron.launch() TIMES OUT on Kiro's VS-Code-fork firstWindow handshake.
//   - connectOverCDP HANGS under bun on Electron's BROWSER-level endpoint (it only
//     worked under node), and even once connected it did NOT expose the nested
//     chat webview.
//   So we speak CDP JSON-RPC directly over a Bun-native WebSocket: each page/iframe
//   target in /json/list carries its own webSocketDebuggerUrl we can drive with
//   Runtime.evaluate / Input.* . (spike note: tmp/issue-451/spike/driver/cdp.mjs:1-6.)
//
// Import-safe: NO top-level side effects (mirrors tui-fixtures.ts:9-10) so importing
// this module never launches Electron. Driving happens only when you call launchKiroIde().
//
// Distilled from the spike primitives (tmp/issue-451/spike/driver/{cdp,ctx-click,
// ctx-scan,drive-unblocked}.mjs + tmp/issue-451/fix-spike/driver/live-fix-drive.mjs).
// Test-grade choices that REPLACE spike shortcuts are marked TEST-GRADE below:
//   - port comes from the caller (ephemeral / pid-derived), never the hardcoded
//     9337/9340/9341 the spike used (those collide under -P 8). (spike gotcha)
//   - waitForChatInput() polls the chat-input placeholder instead of the spike's
//     fixed 11_000ms / 2000ms settle sleeps (spike gotcha: fixed sleeps are brittle
//     on a loaded CI box; the placeholder string is the same signal the Kiro TUI
//     test waits on - "ask a question or describe a task").
//   - the seed user-data-dir is a PATH the caller provides (a DISTILLED profile),
//     never a 44MB clone of a real profile (spike gotcha: leaks personal/internal
//     state, must never ship in a public repo).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";

/** Default launch binary; override via AIDLC_KIRO_IDE_BIN (mirrors AIDLC_CODEX_BIN).
 *  macOS-only as written - Kiro.app is a .app bundle, not a PATH command. */
export const KIRO_IDE_BIN =
  process.env.AIDLC_KIRO_IDE_BIN ?? "/Applications/Kiro.app/Contents/MacOS/Electron";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Raw CDP target (the substrate, ported from cdp.mjs:13-107).
// ---------------------------------------------------------------------------

interface ExecContext {
  id: number;
  origin?: string;
  name?: string;
}

interface CdpTargetInfo {
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** One CDP connection to a single page/iframe target. JSON-RPC over a Bun-native
 *  WebSocket. Accumulates Runtime.executionContextCreated events so nested webview
 *  frames are reachable by contextId (the only way to reach the doubly-nested chat
 *  webview - a top-frame Runtime.evaluate and Playwright's frame list both miss it,
 *  ctx-scan.mjs:1-5). */
export class CdpTarget {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  contexts: ExecContext[] = [];
  private handlers = new Map<string, (params: unknown) => void>();

  constructor(private readonly wsUrl: string) {}

  on(method: string, fn: (params: unknown) => void): void {
    this.handlers.set(method, fn);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: unknown) =>
        reject(new Error("ws error: " + ((e as { message?: string })?.message ?? "unknown")));
      this.ws.onmessage = (ev: MessageEvent) => {
        let msg: {
          id?: number;
          error?: unknown;
          result?: unknown;
          method?: string;
          params?: { context?: ExecContext };
        };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        if (msg.method === "Runtime.executionContextCreated" && msg.params?.context) {
          this.contexts.push(msg.params.context);
        } else if (msg.method === "Runtime.executionContextsCleared") {
          this.contexts = [];
        }
        if (msg.method) {
          const h = this.handlers.get(msg.method);
          if (h) h(msg.params);
        }
      };
    });
  }

  /** JSON-RPC send with an auto-incrementing id and a per-call reject timeout
   *  (cdp.mjs:56-68: the spike used a fixed 20_000ms). */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** Runtime.enable then evaluate in the default context (cdp.mjs:69-80). */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    await this.send("Runtime.enable").catch(() => {});
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { exceptionDetails?: unknown; result?: { value?: T } };
    if (r.exceptionDetails) {
      throw new Error("eval exception: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    }
    return r.result?.value as T;
  }

  /** Enable Runtime and wait briefly so executionContextCreated events for every
   *  frame (including nested OOPIF webviews) arrive into this.contexts
   *  (cdp.mjs:83-87). */
  async enableContexts(waitMs = 1500): Promise<ExecContext[]> {
    await this.send("Runtime.enable").catch(() => {});
    await sleep(waitMs);
    return this.contexts;
  }

  /** Evaluate inside a specific frame's execution context (cdp.mjs:90-101) - reaches
   *  nested webview frames a top-frame Runtime.evaluate cannot. */
  async evaluateInContext<T = unknown>(contextId: number, expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      contextId,
    })) as { exceptionDetails?: unknown; result?: { value?: T } };
    if (r.exceptionDetails) {
      throw new Error("ctx eval exception: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
    }
    return r.result?.value as T;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Launch + attach.
// ---------------------------------------------------------------------------

export interface LaunchOptions {
  /** The scratch workspace dir Kiro opens (carries .kiro/hooks/*.kiro.hook). */
  workspace: string;
  /** A DISTILLED seed user-data-dir so onboarding + sign-in are skipped. NOT a clone
   *  of a real profile (see header / README open items). */
  seedProfile: string;
  /** The remote-debugging port. TEST-GRADE: caller passes a unique/ephemeral port
   *  (e.g. derived from process.pid) - the spike hardcoded 9337/9340/9341 which
   *  collide under parallel runs. */
  port: number;
  /** Override the launch binary (default KIRO_IDE_BIN). */
  bin?: string;
}

export interface KiroIdeHandle {
  child: ChildProcess;
  port: number;
  workspace: string;
}

/** Launch Kiro IDE headfully with the CDP debug port open. Flags are exactly the
 *  spike's (drive-unblocked.mjs:41-46 / live-fix-drive.mjs:58-61). Does NOT wait for
 *  CDP - call waitForCdp() next. */
export function launchKiroIde(opts: LaunchOptions): KiroIdeHandle {
  const bin = opts.bin ?? KIRO_IDE_BIN;
  const child = spawn(
    bin,
    [
      opts.workspace,
      `--remote-debugging-port=${opts.port}`,
      `--user-data-dir=${opts.seedProfile}`,
      "--no-sandbox",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
    { stdio: "ignore" },
  );
  return { child, port: opts.port, workspace: opts.workspace };
}

/** Poll GET /json/version until the CDP endpoint answers (drive-unblocked.mjs:48-56
 *  - this is already a proper poll in the spike; kept verbatim in shape). */
export async function waitForCdp(port: number, timeoutMs = 60_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

/** GET /json/list - every page/iframe target with a webSocketDebuggerUrl
 *  (cdp.mjs:8-11). */
export async function listTargets(port: number): Promise<CdpTargetInfo[]> {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await r.json()) as CdpTargetInfo[];
}

/** Open a CdpTarget on the top-level page target - the keyboard/screenshot channel
 *  (drive-unblocked.mjs:68-74). */
export async function pageTarget(port: number): Promise<CdpTarget> {
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("kiro-ide-driver: no page target with a webSocketDebuggerUrl");
  }
  const t = new CdpTarget(page.webSocketDebuggerUrl);
  await t.connect();
  return t;
}

// ---------------------------------------------------------------------------
// Chat input: focus, wait, type, submit.
// ---------------------------------------------------------------------------

const META = 4;
const SHIFT = 8;

/** The placeholder the Kiro chat input renders - the SAME signal the Kiro TUI test
 *  waits on (t-tui-kiro-status.serial.test.ts:95). Lowercased for a tolerant match. */
const CHAT_PLACEHOLDER = "ask a question or describe a task";

/** Scan every execution context for the chat-input placeholder. Returns true once
 *  the input is present (TEST-GRADE replacement for the spike's fixed 11_000ms
 *  settle sleep - the workbench is "ready" when the chat input exists). */
const FIND_CHAT_INPUT_EXPR = `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim().toLowerCase();
  const want = ${JSON.stringify(CHAT_PLACEHOLDER)};
  const els = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")];
  for (const e of els) {
    const ph = norm(e.getAttribute("placeholder")||e.getAttribute("aria-label")||e.getAttribute("data-placeholder"));
    if (ph.includes(want)) return true;
  }
  return false;
})()`;

/** Poll all contexts for the chat-input placeholder before driving keystrokes.
 *  Replaces the spike's fixed settle sleeps (drive-unblocked.mjs:57-58,119). */
export async function waitForChatInput(port: number, timeoutMs = 60_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const targets = await listTargets(port);
    for (const tgt of targets) {
      if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
      const t = new CdpTarget(tgt.webSocketDebuggerUrl);
      try {
        await t.connect();
        const contexts = await t.enableContexts(500);
        for (const c of contexts) {
          try {
            if (await t.evaluateInContext<boolean>(c.id, FIND_CHAT_INPUT_EXPR)) {
              t.close();
              return true;
            }
          } catch {
            /* context gone */
          }
        }
      } catch {
        /* target gone */
      } finally {
        t.close();
      }
    }
    await sleep(800);
  }
  return false;
}

/** Cmd+Shift+L = the "Kiro: Focus Chat Input" command (drive-unblocked.mjs:117-118).
 *  META|SHIFT, KeyL, vk 76. */
export async function focusChat(t: CdpTarget): Promise<void> {
  await t.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: META | SHIFT,
    key: "L",
    code: "KeyL",
    windowsVirtualKeyCode: 76,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: META | SHIFT,
    key: "L",
    code: "KeyL",
    windowsVirtualKeyCode: 76,
  });
}

/** Type via Input.insertText, then submit with a TEXT-BEARING Enter keyDown
 *  (drive-unblocked.mjs:123-128). The `text:"\r"` on the keyDown is load-bearing -
 *  that is what submits. */
export async function typeAndSubmit(t: CdpTarget, text: string): Promise<void> {
  await t.send("Input.insertText", { text });
  await sleep(500);
  await t.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 0,
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 0,
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}

// ---------------------------------------------------------------------------
// Click by DOM text inside the owning nested-webview context (no pixels).
// ---------------------------------------------------------------------------

const clickByTextExpr = (texts: string[]): string => `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim().toLowerCase();
  const want = ${JSON.stringify(texts.map((s) => s.toLowerCase()))};
  const els = [...document.querySelectorAll("a,button,[role='button'],.monaco-button,.monaco-text-button,.action-label")];
  for (const e of els) {
    const t = norm(e.innerText||e.textContent||e.getAttribute("aria-label"));
    if (want.includes(t)) {
      const r = e.getBoundingClientRect && e.getBoundingClientRect();
      if (!r || (r.width>0 && r.height>0)) { e.scrollIntoView && e.scrollIntoView(); e.click(); return "clicked:"+t; }
    }
  }
  return null;
})()`;

/** Click a control by visible DOM text/aria-label in whatever execution context owns
 *  it (ctx-click.mjs:11-50). No pixel coordinates - the only way to reach the
 *  doubly-nested vscode-webview chat controls. Returns the matched label or null. */
export async function clickByText(port: number, texts: string[]): Promise<string | null> {
  const expr = clickByTextExpr(texts);
  const targets = await listTargets(port);
  for (const tgt of targets) {
    if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
    const t = new CdpTarget(tgt.webSocketDebuggerUrl);
    try {
      await t.connect();
      const contexts = await t.enableContexts(600);
      for (const c of contexts) {
        try {
          const r = await t.evaluateInContext<string | null>(c.id, expr);
          if (r) {
            t.close();
            return r;
          }
        } catch {
          /* context gone */
        }
      }
    } catch {
      /* target gone */
    } finally {
      t.close();
    }
  }
  return null;
}

/** Auto-approve Kiro's OWN Run/Allow tool-permission prompts (SEPARATE from the #451
 *  hooks). Without this the agent turn stalls waiting for a human to click Run
 *  (drive-unblocked.mjs:82-112). The watch loop calls this every iteration. */
export function autoApprove(port: number): Promise<string | null> {
  return clickByText(port, ["run", "allow", "approve", "run command", "accept", "yes"]);
}

// ---------------------------------------------------------------------------
// Marker reading (the deterministic disk surface) + screenshot + teardown.
// ---------------------------------------------------------------------------

/** Count NDJSON marker lines in a file matching field === value. The hooks append
 *  one JSON line per firing; the test asserts on this, never on chat prose
 *  (countLabel drive-unblocked.mjs:61-65 / countCommitted live-fix-drive.mjs:97-100). */
export function countMarkers(file: string, field: string, value: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => {
      try {
        return (JSON.parse(l) as Record<string, unknown>)[field] === value;
      } catch {
        return false;
      }
    }).length;
}

/** Poll a predicate over a marker file within a wall-clock budget (replaces the
 *  spike's trust-a-settle-delay shape, drive-unblocked.mjs:135-145). Calls
 *  onPoll each tick (e.g. autoApprove) so gates get clicked while we wait. */
export async function watchMarkers(
  predicate: () => boolean,
  budgetMs: number,
  onPoll?: () => Promise<void>,
  intervalMs = 1500,
): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    if (onPoll) await onPoll();
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

/** PNG screenshot of the page target (Page.captureScreenshot) as a base64 string -
 *  caller decides whether to persist it (drive-unblocked.mjs:76-79). Screenshots are
 *  diagnostic only; assertions live on disk markers. */
export async function screenshot(t: CdpTarget): Promise<Buffer | null> {
  const s = (await t.send("Page.captureScreenshot", { format: "png" }).catch(() => null)) as {
    data?: string;
  } | null;
  return s?.data ? Buffer.from(s.data, "base64") : null;
}

/** SIGKILL the Electron process (drive-unblocked.mjs:166-167). Honour AIDLC_KEEP_TEMP
 *  by leaving it running so a failed live run is inspectable. */
export function teardown(handle: KiroIdeHandle): void {
  if (process.env.AIDLC_KEEP_TEMP === "1") {
    process.stderr.write(
      `[kiro-ide-driver] AIDLC_KEEP_TEMP=1 - Kiro left running on :${handle.port}\n`,
    );
    return;
  }
  try {
    handle.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Presence test for the launch binary (existsSync, NOT a --version PATH probe -
 *  Kiro.app is launched by absolute path, not resolvable on PATH). macOS-only. */
export function kiroIdeAvailable(bin = KIRO_IDE_BIN): boolean {
  return platform() === "darwin" && existsSync(bin);
}

// kiro-ide-driver.ts - BUN-ONLY raw Chrome DevTools Protocol driver for the Kiro
// IDE (the Electron desktop app). The harness twin of tui-drive.ts (Kiro CLI over
// tmux) and kiro-acp-drive.ts (Kiro CLI over ACP) - this one drives the GUI app.
//
// WHY raw CDP and NOT Playwright (proven in the human-presence CDP spike):
//   - electron.launch() TIMES OUT on Kiro's VS-Code-fork firstWindow handshake.
//   - connectOverCDP HANGS under bun on Electron's BROWSER-level endpoint (it only
//     worked under node), and even once connected it did NOT expose the nested
//     chat webview.
//   So we speak CDP JSON-RPC directly over a Bun-native WebSocket: each page/iframe
//   target in /json/list carries its own webSocketDebuggerUrl we can drive with
//   Runtime.evaluate / Input.* .
//
// Import-safe: NO top-level side effects (mirrors tui-fixtures.ts:9-10) so importing
// this module never launches Electron. Driving happens only when you call launchKiroIde().
//
// Distilled from the CDP spike primitives (the raw cdp / ctx-click / ctx-scan /
// drive-unblocked / live-fix-drive probes kept under the private tmp working area).
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
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

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
        reject(new Error(`ws error: ${(e as { message?: string })?.message ?? "unknown"}`));
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
      throw new Error(`eval exception: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
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
      throw new Error(`ctx eval exception: ${JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
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
// Seed generation (skip onboarding with NO committed profile, NO credentials).
// ---------------------------------------------------------------------------

// Spike-proven (the seed spike under the private tmp working area): a fresh
// Kiro user-data-dir hits the "Import configuration" onboarding wall and never
// reaches chat. The ONLY load-bearing flag that skips it is the global-state row
// `kiroAgent.onboarding.onboardingCompleted = "true"` in
// User/globalStorage/state.vscdb (an empty fresh DB seeded with just that row was
// verified to land directly on the workbench). Kiro AUTH is machine-level (Keychain
// / IdC, NOT in the profile - grepping the real DB's 80 keys for
// auth/token/credential/cookie/sso/secret returned nothing), so the seed needs ZERO
// credentials. We therefore GENERATE the seed from constants at setup time rather
// than committing or copying any real profile - nothing sensitive ever touches the
// repo. The two extra rows + settings only mute cosmetic notification toasts (MCP
// tools, Builder steering, git-repo prompt); the onboarding row is what unblocks chat.
const SEED_STATE_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["kiroAgent.onboarding.onboardingCompleted", "true"], // load-bearing: skips the import wall
  ["releaseNotes/lastVersion", "0.0.0"], // mute the release-notes popup (version-agnostic stub)
  ["trusted-publishers-init-migration", "true"], // mute the trusted-publishers migration toast
];
const SEED_SETTINGS = {
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "telemetry.telemetryLevel": "off",
  "security.workspace.trust.enabled": false,
  "update.showReleaseNotes": false,
  // LOAD-BEARING for the human-presence test: a `.kiro.hook` whose action is
  // runCommand does NOT auto-execute in the IDE - Kiro renders a manual "Hook
  // Command" approval card (Run / Reject) and the command only fires once the Run
  // control is clicked. The MINT hook (promptSubmit) and the BLOCK hook (preToolUse)
  // are both runCommand hooks. Without this setting the mint command sits behind that
  // card: the test's autoApprove() loop CAN click it through (its label list includes
  // "run command"), but only on its next ~1.5s tick and only if it wins focus, so the
  // mint firing becomes a RACE - under load the click can lag the watch budget and the
  // HUMAN_TURN never lands, which is the intermittent reap this driver kept hitting.
  // `trustedCommands: ["*"]` auto-trusts every hook/agent command (the IDE's
  // getTrustedCommands() short-circuits the approval card on a "*" match), so both
  // hooks run on submit with NO card and NO click - deterministic instead of racy.
  // This trusts COMMANDS for the ephemeral generated test seed only; it makes the
  // hooks RUN, it does not make the gate PASS. Enforcement is unchanged: the preToolUse
  // block hook still refuses a fabricated approval via exit 2 (it reads the ledger
  // directly), and the core handleApprove ledger check is covered deterministically by
  // the t188 unit test. Trusting the command is what lets the block hook RUN at all.
  "kiroAgent.trustedCommands": ["*"],
} as const;

/** Build a minimal Kiro IDE user-data-dir under `dir` that skips first-run onboarding,
 *  from CONSTANTS only - no real profile is copied and no credentials are written (auth
 *  is machine-level). Returns `dir`. The caller owns `dir` (use a temp dir; Kiro mutates
 *  the profile in place). Safe to ship: the generated state.vscdb holds exactly the rows
 *  in SEED_STATE_ROWS and nothing else. */
export function generateKiroIdeSeed(dir: string): string {
  const userDir = join(dir, "User");
  const globalStorage = join(userDir, "globalStorage");
  mkdirSync(globalStorage, { recursive: true });
  writeFileSync(join(userDir, "settings.json"), `${JSON.stringify(SEED_SETTINGS, null, 2)}\n`, "utf-8");
  const db = new Database(join(globalStorage, "state.vscdb"));
  try {
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [k, v] of SEED_STATE_ROWS) insert.run(k, v);
  } finally {
    db.close();
  }
  return dir;
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

/** The prompt the Kiro chat input renders - the SAME signal the Kiro TUI test waits
 *  on (t-tui-kiro-status.serial.test.ts:95). Lowercased for a tolerant match. Kept as
 *  a SECONDARY signal only: a live probe found the desktop app does NOT expose it as
 *  an attribute or in body.innerText (see FIND_CHAT_INPUT_EXPR). */
const CHAT_PLACEHOLDER = "ask a question or describe a task";

/** Detect that the Kiro chat input is present and laid out, in whatever execution
 *  context owns it. TEST-GRADE replacement for the spike's fixed 11_000ms settle sleep:
 *  the workbench is "ready" once the chat editor exists.
 *
 *  Live probe (generated onboarding-skip seed): the input is a
 *  tiptap/ProseMirror `contenteditable` DIV inside the doubly-nested vscode-webview
 *  iframe, and its "ask a question..." prompt is a CSS ::before - NOT a
 *  placeholder/aria/data-placeholder attribute and NOT present in document.body.innerText
 *  ({tag:"DIV",ce:"true",ph:null,cls:"tiptap ProseMirror ..."} with
 *  bodyHasPlaceholder=false). So the old attribute-only match never fired. We now anchor
 *  on the EDITOR element: a visible contenteditable/textbox whose class is the ProseMirror
 *  chat editor, or (fallback) any visible editable in the chat webview origin. The prompt
 *  text is still checked first in case a future Kiro exposes it as an attribute or text. */
const FIND_CHAT_INPUT_EXPR = `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim().toLowerCase();
  const want = ${JSON.stringify(CHAT_PLACEHOLDER)};
  // (a) prompt text wherever a future Kiro version might expose it (attribute or text).
  if (norm(document.body && document.body.innerText).includes(want)) return true;
  for (const e of document.querySelectorAll("[placeholder],[aria-label],[data-placeholder]")) {
    const v = norm(e.getAttribute("placeholder")||e.getAttribute("aria-label")||e.getAttribute("data-placeholder"));
    if (v.includes(want)) return true;
  }
  // (b) the chat editor element itself: a VISIBLE contenteditable/textbox/textarea.
  const inWebview = String(location.href).startsWith("vscode-webview://");
  for (const e of document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")) {
    const r = e.getBoundingClientRect && e.getBoundingClientRect();
    if (r && !(r.width>0 && r.height>0)) continue;
    const cls = (e.className||"").toString().toLowerCase();
    if (/prosemirror|tiptap/.test(cls)) return true;
    if (inWebview) return true;
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
        // 1500ms (not the spike's 500ms): the deeply-nested OOPIF chat webview's
        // executionContextCreated arrives late on a loaded box - a 500ms budget raced
        // past it and missed the input on a first pass (live probe finding).
        const contexts = await t.enableContexts(1500);
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

/** Read the chat editor's current text from whatever webview context owns the
 *  tiptap/ProseMirror contenteditable (the SAME element FIND_CHAT_INPUT_EXPR anchors
 *  on). Returns null from a context with no chat editor, the (possibly empty) text
 *  from the one that has it. */
const READ_CHAT_TEXT_EXPR = `(() => {
  const norm = (s) => (s||"").replace(/\\s+/g," ").trim();
  const inWebview = String(location.href).startsWith("vscode-webview://");
  for (const e of document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")) {
    const cls = (e.className||"").toString().toLowerCase();
    if (/prosemirror|tiptap/.test(cls) || inWebview) {
      return norm(e.tagName === "TEXTAREA" ? (e.value||"") : (e.innerText||e.textContent||""));
    }
  }
  return null;
})()`;

/** The chat editor's current text, scanning every page/iframe context for the one
 *  that owns it (the input lives in the doubly-nested vscode-webview). "" if absent. */
export async function readChatText(port: number): Promise<string> {
  const targets = await listTargets(port);
  for (const tgt of targets) {
    if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
    const t = new CdpTarget(tgt.webSocketDebuggerUrl);
    try {
      await t.connect();
      const contexts = await t.enableContexts(1200);
      for (const c of contexts) {
        try {
          const r = await t.evaluateInContext<string | null>(c.id, READ_CHAT_TEXT_EXPR);
          if (r !== null && r !== undefined) {
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
  return "";
}

/** Cmd+A then Delete to clear the focused chat editor (between retries). */
async function selectAllAndDelete(t: CdpTarget): Promise<void> {
  await t.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: META,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: META,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 0,
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 0,
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
  });
}

/** Focus the chat input, type `text`, VERIFY it landed in the editor, submit with a
 *  TEXT-BEARING Enter keyDown (the `text:"\r"` is load-bearing - that is what submits
 *  in the tiptap editor, drive-unblocked.mjs:123-128), then VERIFY the submit landed
 *  by confirming the editor cleared (a submitted prompt empties the input).
 *
 *  Why focus + settle + read-back + retry: the chat editor element EXISTS
 *  (waitForChatInput returns true) a beat before it reliably accepts Input.insertText.
 *  A blind insert the instant after detection can be dropped, leaving the chat EMPTY;
 *  so we focus, settle, insert, read the editor BACK, and retry (clearing any partial)
 *  until the text is present before pressing Enter.
 *
 *  Why FAIL FAST AND LOUD: if the text never lands, or Enter never clears the editor,
 *  the older driver pressed Enter on an empty editor and returned silently - the
 *  caller's watch loop then polled for a disk event that could never appear until it
 *  exhausted a multi-minute budget and the harness reaped the slice (a reap reads as
 *  an ambiguous hang). Throwing here turns that into a fast, debuggable failure with
 *  the editor's actual contents in the message. (The separate human-presence MINT
 *  hook firing on submit is handled by the seed trusting hook commands - see
 *  SEED_SETTINGS; this function only guarantees the prompt itself was typed + sent.) */
export async function typeAndSubmit(t: CdpTarget, text: string, port: number): Promise<void> {
  const want = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
  let landed = false;
  for (let attempt = 0; attempt < 12 && !landed; attempt++) {
    await focusChat(t);
    await sleep(700);
    await t.send("Input.insertText", { text });
    await sleep(600);
    const cur = (await readChatText(port)).toLowerCase();
    landed = want.length > 0 && cur.includes(want);
    if (!landed) {
      await selectAllAndDelete(t);
      await sleep(1500);
    }
  }
  if (!landed) {
    const seen = (await readChatText(port)).slice(0, 60);
    throw new Error(
      `kiro-ide-driver: prompt never landed in the chat editor after 12 attempts ` +
        `(editor shows ${JSON.stringify(seen)}). Failing fast instead of submitting an ` +
        `empty editor and waiting out the watch budget.`,
    );
  }
  // Submit. text:"\r" on the keyDown is what actually submits in the tiptap editor.
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
  // VERIFY the submit landed: a sent prompt clears the editor. Retry Enter a few
  // times before giving up - a single Enter is occasionally swallowed while the
  // editor settles. If it never clears, the prompt is stuck in the input; throw so
  // the caller fails fast rather than waiting out a watch budget on an unsent turn.
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(700);
    const cur = (await readChatText(port)).toLowerCase();
    if (!cur.includes(want)) return; // editor cleared => submitted
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
  const seen = (await readChatText(port)).slice(0, 60);
  throw new Error(
    `kiro-ide-driver: prompt landed but Enter never submitted it (editor still shows ` +
      `${JSON.stringify(seen)} after 6 Enter attempts). Failing fast.`,
  );
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

/** Auto-approve Kiro's OWN Run/Allow tool-permission prompts (SEPARATE from the
 *  human-presence hooks). Without this the agent turn stalls waiting for a human to
 *  click Run (drive-unblocked.mjs:82-112). The watch loop calls this every iteration.
 *  Note: the seed trusts hook/shell COMMANDS (SEED_SETTINGS) so the mint/block hooks
 *  run without a card, but the agent's per-tool permission cards are a separate gate -
 *  this still clicks those through so the turn proceeds. */
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

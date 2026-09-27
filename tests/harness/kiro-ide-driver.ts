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
//   - Electron binds port 0 and reports its OS-assigned CDP endpoint on stderr.
//     It owns the socket continuously; parallel launches never reserve/release
//     a candidate port or attach using a stale profile's endpoint file.
//   - waitForChatInput() polls the chat-input placeholder instead of the spike's
//     fixed 11_000ms / 2000ms settle sleeps (spike gotcha: fixed sleeps are brittle
//     on a loaded CI box; the placeholder string is the same signal the Kiro TUI
//     test waits on - "ask a question or describe a task").
//   - the seed user-data-dir is a PATH the caller provides (a DISTILLED profile),
//     never a 44MB clone of a real profile (spike gotcha: leaks personal/internal
//     state, must never ship in a public repo).

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  remainingCleanupTimeoutMs,
  LIVE_STARTUP_TIMEOUT_MS,
  LIVE_COMMAND_TIMEOUT_MS,
  LIVE_CLEANUP_TIMEOUT_MS,
  NATIVE_PROCESS_TERMINATE_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  TestBudgetExhaustedError,
} from "./test-budget.ts";

// Visible command text has both legacy script and public dispatcher spellings.
// Keep these non-global so repeated assertions do not share RegExp state.
export const KIRO_REPORT_COMMAND_TEXT =
  /\baidlc(?:-orchestrate\.ts["']?\s+|\.ts["']?\s+engine\s+orchestrate\s+)report(?=\s|$|["'`])/i;
export const KIRO_INTENT_JSON_COMMAND_TEXT =
  /\baidlc(?:-utility\.ts["']?\s+intent|\.ts["']?\s+engine\s+intent(?:\s+list)?)\s+--json(?=\s|$|["'`])/i;

/**
 * The macOS executable inside Kiro.app, newest naming FIRST.
 *
 * Kiro renamed it from the stock Electron name to `Kiro` (1.1.14 declares
 * CFBundleExecutable = Kiro). The old single-path default silently stopped
 * resolving, and because every Kiro IDE gate treats a missing binary as a SKIP
 * REASON, the whole live journey skipped while the file still reported PASS.
 * That is the failure mode the test policy warns about: a skip is an unmet gate,
 * not coverage. Probing both names keeps the gate honest across Kiro versions,
 * and `kiroIdeMissingBinaryReason` below reports every path tried so the next
 * rename says so out loud instead of disappearing.
 */
const MACOS_KIRO_IDE_BINS = [
  "/Applications/Kiro.app/Contents/MacOS/Kiro",
  "/Applications/Kiro.app/Contents/MacOS/Electron",
] as const;

function windowsKiroIdeBin(): string {
  return join(process.env.LOCALAPPDATA ?? "", "Programs", "Kiro", "Kiro.exe");
}

/** Every path the default would accept on this platform, in preference order. */
export function kiroIdeBinCandidates(): readonly string[] {
  return platform() === "win32" ? [windowsKiroIdeBin()] : MACOS_KIRO_IDE_BINS;
}

/** Default launch binary; override via AIDLC_KIRO_IDE_BIN (mirrors AIDLC_CODEX_BIN). */
function defaultKiroIdeBin(): string {
  const candidates = kiroIdeBinCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export const KIRO_IDE_BIN = process.env.AIDLC_KIRO_IDE_BIN ?? defaultKiroIdeBin();

/** The skip sentence for a missing binary, naming every path that was tried. */
export function kiroIdeMissingBinaryReason(bin: string = KIRO_IDE_BIN): string {
  const tried = process.env.AIDLC_KIRO_IDE_BIN
    ? `AIDLC_KIRO_IDE_BIN=${bin}`
    : kiroIdeBinCandidates().join(" or ");
  return (
    `Kiro IDE binary not found (tried ${tried}); install Kiro or point ` +
    "AIDLC_KIRO_IDE_BIN at its executable"
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cdpTimeoutError(fallback: Error, deadlineMs?: number): Error {
  try {
    remainingOperationTimeoutMs(undefined, { deadlineMs, phase: "IDE CDP" });
  } catch (error) {
    return error as Error;
  }
  return fallback;
}

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

export interface KiroIdeDomSnapshot {
  targetType: string;
  targetUrl: string;
  context: ExecContext;
  href: string;
  title: string;
  text: string;
  controls: Array<{
    tag: string;
    text: string;
    ariaLabel: string;
    disabled: boolean;
  }>;
  editors: Array<{
    tag: string;
    text: string;
    ariaLabel: string;
  }>;
  orderedLists: string[][];
}

export interface KiroIdeBlockingOverlay {
  text: string;
  className: string;
  role: string;
  ariaModal: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface KiroIdeBlockedHitPoint {
  x: number;
  y: number;
  hitTag: string;
  hitClassName: string;
  hitText: string;
}

export interface KiroIdeChatSurfaceState {
  chatFrameCount: number;
  blockedHitPoints: KiroIdeBlockedHitPoint[];
  blockingOverlays: KiroIdeBlockingOverlay[];
}

export interface KiroIdeChatPreparation {
  dismissed: string | null;
  surface: KiroIdeChatSurfaceState;
}

export interface KiroIdeNumberedListSnapshot {
  targetType: string;
  targetUrl: string;
  context: ExecContext;
  href: string;
  listStyleType: string;
  start: number;
  items: Array<{
    ordinal: number;
    text: string;
    display: string;
    listStyleType: string;
    visibility: string;
    opacity: string;
    markerContent: string;
    markerColor: string;
    markerFontSize: string;
    markerOpacity: string;
  }>;
}

function normalizedOptionText(value: string): string {
  return value.replaceAll(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Find a fully rendered numbered list whose items match every expected label
 * in order. A streaming prefix is intentionally not a match. */
export function findCompleteNumberedListByLabels(
  lists: KiroIdeNumberedListSnapshot[],
  labels: string[],
): KiroIdeNumberedListSnapshot | null {
  const expected = labels.map(normalizedOptionText);
  return (
    lists.find(
      (list) =>
        list.items.length === expected.length &&
        list.items.every((item, index) =>
          normalizedOptionText(item.text).startsWith(expected[index]),
        ),
    ) ?? null
  );
}

function positiveCssNumber(value: string): boolean {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function transparentCssColor(value: string): boolean {
  const color = value.replace(/\s+/g, "").toLowerCase();
  return (
    color === "transparent" ||
    /,\s*0(?:\.0+)?\)$/.test(color) ||
    /\/\s*0(?:\.0+)?\)$/.test(color)
  );
}

function markerContentMatchesOrdinal(
  item: KiroIdeNumberedListSnapshot["items"][number],
): boolean {
  const markerContent = item.markerContent.trim();
  if (markerContent.toLowerCase() === "normal") {
    return item.listStyleType === "decimal";
  }
  const first = markerContent[0];
  const last = markerContent.at(-1);
  const unquoted =
    markerContent.length >= 2 &&
    (first === '"' || first === "'") &&
    last === first
      ? markerContent.slice(1, -1)
      : markerContent;
  const visibleText = unquoted.replace(/\s+/g, " ").trim();
  return new RegExp(`^${item.ordinal}(?:[.)])?$`).test(visibleText);
}

/** Prove each option has a visible marker that renders its actual ordinal. */
export function numberedListMarkersAreVisible(
  list: KiroIdeNumberedListSnapshot,
): boolean {
  if (list.listStyleType === "none" || list.items.length === 0) return false;
  return list.items.every((item) => {
    const markerContent = item.markerContent.trim().toLowerCase();
    return (
      item.display === "list-item" &&
      item.listStyleType !== "none" &&
      item.visibility === "visible" &&
      positiveCssNumber(item.opacity) &&
      markerContent !== "" &&
      markerContent !== "none" &&
      markerContent !== '""' &&
      markerContentMatchesOrdinal(item) &&
      !transparentCssColor(item.markerColor) &&
      positiveCssNumber(item.markerFontSize) &&
      positiveCssNumber(item.markerOpacity)
    );
  });
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

  constructor(private readonly wsUrl: string, private readonly deadlineMs?: number) {}

  on(method: string, fn: (params: unknown) => void): void {
    this.handlers.set(method, fn);
  }

  connect(): Promise<void> {
    const timeoutMs = remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, {
      deadlineMs: this.deadlineMs, phase: "IDE CDP connect",
    });
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        reject(cdpTimeoutError(new Error("IDE CDP connect budget expired"), this.deadlineMs));
        const socket = this.ws as (WebSocket & { terminate?: () => void }) | null;
        try {
          if (typeof socket?.terminate === "function") socket.terminate();
          else socket?.close();
        } catch { /* already closed */ }
      }, timeoutMs);
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = (e: unknown) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${(e as { message?: string })?.message ?? "unknown"}`));
      };
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
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = LIVE_COMMAND_TIMEOUT_MS): Promise<unknown> {
    const allocation = remainingOperationTimeoutMs(timeoutMs, {
      deadlineMs: this.deadlineMs, phase: "IDE CDP request",
    });
    if (allocation === undefined) throw new Error("Invalid test budget: CDP requests require a positive timeout");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(cdpTimeoutError(new Error(`CDP timeout: ${method}`), this.deadlineMs));
        }
      }, allocation);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.ws?.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
    await this.send("Runtime.enable").catch((error) => {
      if (error instanceof TestBudgetExhaustedError) throw error;
    });
    if (waitMs !== 0) await sleep(remainingOperationTimeoutMs(waitMs, {
      deadlineMs: this.deadlineMs, phase: "IDE context discovery",
    })!);
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
// verified to land directly on the workbench). The macOS spike found Kiro auth outside
// the profile (grepping the real DB's 80 keys for auth/token/credential/cookie/sso/secret
// returned nothing), so this seed contains ZERO credentials. A signed-in host is still
// required; on Windows an unsigned host reaches chat but rejects prompts with an
// authentication wall. We GENERATE the seed from constants at setup time rather than
// committing or copying any real profile - nothing sensitive ever touches the repo. The
// two extra rows + settings only mute cosmetic notification toasts (MCP tools, Builder
// steering, git-repo prompt); the onboarding row is what unblocks chat.
//
// Current Kiro versions can additionally show a session-storage migration carousel.
// Its "Remind me later" action does not persist a durable global-state key, so it is
// handled after launch by prepareKiroIdeChat(). The seed stays version-neutral and
// credential-free instead of copying a mutable Kiro profile or guessing private state.
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
  // LOAD-BEARING for the human-presence test: a hook whose action runs a
  // command does NOT auto-execute in the IDE - Kiro renders a manual "Hook
  // Command" approval card (Run / Reject) and the command only fires once the Run
  // control is clicked. The MINT hook (UserPromptSubmit) and the BLOCK hook
  // (PreToolUse) are both command hooks. Without this setting the mint command sits behind that
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
  // ISOLATION, and load-bearing for whether this journey finishes at all. A
  // fresh user-data-dir does NOT isolate the agent's tool surface: Kiro still
  // reads the developer's global ~/.kiro/settings/mcp.json, so the launched
  // instance inherited every MCP server on the machine. On this one that was 7
  // servers and 131 tools, and Kiro itself renders a warning saying that many
  // tools degrade agent tool selection. The journey then spent 36 minutes
  // making no progress. Disabling MCP for the generated seed makes the run
  // depend on the engine and the hooks under test, not on whatever servers a
  // developer happens to have configured.
  "kiroAgent.configureMCP": "Disabled",
  // Autopilot so the agent executes its own steps instead of waiting on a
  // per-action confirmation the driver would have to chase. This test asserts
  // the ENGINE refuses a fabricated approval; it must not also be a test of
  // whether someone clicks through Kiro's autonomy prompts.
  "kiroAgent.agentAutonomy": "Autopilot",
} as const;

/** Build a minimal Kiro IDE user-data-dir under `dir` that skips first-run onboarding,
 *  from CONSTANTS only - no real profile is copied and no credentials are written.
 *  Returns `dir`. The caller owns `dir` (use a temp dir; Kiro mutates the profile in
 *  place). Safe to ship: the generated state.vscdb holds exactly the rows in
 *  SEED_STATE_ROWS and nothing else. */
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
  /** The scratch workspace dir Kiro opens (carries the .kiro/hooks/aidlc-*.json v2 hooks). */
  workspace: string;
  /** A DISTILLED seed, copied to a private user-data-dir for each launch.
   *  The seed itself is never passed to Electron or mutated by the driver. */
  seedProfile: string;
  /** Override the launch binary (default KIRO_IDE_BIN). */
  bin?: string;
  /** Windows defaults to per-file TEMP so Electron's nested storage paths stay
   *  short. Other platforms default to AIDLC_TEST_WORKER_ROOT, then OS temp. */
  profileRoot?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface KiroIdeHandle {
  readonly child: ChildProcess;
  readonly port: number;
  readonly browserWebSocketUrl: string;
  readonly workspace: string;
  readonly profileDir: string;
}

/** Synthetic children can exercise launch/cleanup without an installed IDE.
 *  A supplied spawn must return a child with piped stderr; terminate must affect
 *  only that child and its descendants, and leave exit/close events observable. */
export interface KiroIdeLaunchRuntime {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn: (bin: string, args: string[], options: SpawnOptions) => ChildProcess;
  terminate: (child: ChildProcess) => void;
}

const kiroIdeCleanups = new WeakMap<KiroIdeHandle, () => Promise<void>>();

/** Parse a complete Electron stderr line, never an arbitrary reachable port. */
function kiroIdeDebugEndpoint(line: string): { port: number; url: string } | null {
  const match = /^DevTools listening on (ws:\/\/\S+)\s*$/.exec(line.trim());
  if (!match) return null;
  try {
    const endpoint = new URL(match[1]);
    const port = Number(endpoint.port);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/devtools\/browser\/[^/]+$/.test(endpoint.pathname) ||
      !Number.isInteger(port) || port < 1 || port > 65535
    ) return null;
    return { port, url: match[1] };
  } catch {
    return null;
  }
}

export function kiroIdeDebugPort(line: string): number | null {
  return kiroIdeDebugEndpoint(line)?.port ?? null;
}

/** Close only the browser identity reported by our child. Never rediscover a
 *  browser through /json/version: its port may since have been reused. */
type KiroIdeLifecycleTrace = (phase: string, fields?: {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  timeoutMs?: number;
  sent?: boolean;
  settled?: boolean;
  localDispose?: boolean;
  closed?: boolean;
  exited?: boolean;
}) => void;

function closeKiroIdeBrowser(
  url: string, timeoutMs: number, childClosed: Promise<void>, trace: KiroIdeLifecycleTrace,
): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    let socket: WebSocket | undefined;
    let sent = false;
    let settled = false;
    let localDispose = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // This driver is Bun-only. Do not let a stalled close handshake outlive
      // the shutdown bound after either a reply or a connection timeout.
      localDispose = true;
      try { (socket as Bun.WebSocket | undefined)?.terminate(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolveClosed();
    };
    const timer = setTimeout(() => {
      trace("rpc-timeout", { timeoutMs });
      finish(new Error("Kiro Browser.close timed out"));
    }, timeoutMs);
    // A browser may exit without delivering a final RPC reply or close frame.
    // Only authoritative child CLOSE settles this path. A protocol error that
    // already settled the promise stays rejected; EXIT alone cannot resolve it.
    void childClosed.then(() => {
      trace("rpc-child-close-observed", { settled });
      finish();
    });
    try {
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (settled) return;
        trace("rpc-connected");
        try {
          socket!.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          sent = true;
          trace("rpc-sent");
        } catch (error) {
          trace("rpc-send-error");
          finish(new Error("Kiro Browser.close send failed", { cause: error }));
        }
      };
      socket.onmessage = (event) => {
        try {
          const reply = JSON.parse(String(event.data));
          if (reply.id === 1) {
            trace(reply.error ? "rpc-refused" : "rpc-ack", { settled });
            finish(reply.error ? new Error("Kiro Browser.close was refused") : undefined);
          }
        } catch { /* unrelated non-JSON output */ }
      };
      socket.onerror = () => {
        trace("rpc-socket-error", { settled, localDispose });
        finish(new Error("Kiro Browser.close connection failed"));
      };
      // Electron may close the connection before delivering the reply. The
      // caller must still observe the authoritative child close before success.
      socket.onclose = () => {
        trace("rpc-socket-close", { sent, settled, localDispose });
        finish(sent ? undefined : new Error("Kiro browser endpoint closed before request"));
      };
    } catch (error) {
      trace("rpc-connect-error");
      finish(new Error("Kiro browser endpoint connection failed", { cause: error }));
    }
  });
}

function terminateKiroIdeChild(child: ChildProcess, timeoutMs = NATIVE_PROCESS_TERMINATE_TIMEOUT_MS): void {
  // Never act on a remembered PID once the authoritative child has exited.
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (platform() === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: remainingCleanupTimeoutMs(timeoutMs) },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`taskkill failed for owned Kiro PID ${child.pid}`);
  } else {
    // spawn(detached:true) gives this launch its own process group. Never kill
    // by executable name or enumerate other IDE instances.
    process.kill(-child.pid, "SIGKILL");
  }
}

/** Launch with a private profile and let Electron own an OS-assigned port.
 *  Resolves when this child's stderr reports its endpoint; callers still assert
 *  waitForCdp()/waitForChatInput(). Imports perform no launch or allocation. */
export async function launchKiroIde(
  opts: LaunchOptions,
  runtime: Partial<KiroIdeLaunchRuntime> = {},
): Promise<KiroIdeHandle> {
  const env = runtime.env ?? process.env;
  const startupDeadlineMs = Date.now() + remainingOperationTimeoutMs(opts.startupTimeoutMs === 0 ? LIVE_STARTUP_TIMEOUT_MS : opts.startupTimeoutMs ?? LIVE_STARTUP_TIMEOUT_MS, { env, phase: "IDE startup" })!;
  const launchStarted = performance.now();
  const windows = (runtime.platform ?? platform()) === "win32";
  const inheritedGroup = env.AIDLC_TEST_WORKER_PROCESS_GROUP === "1";
  const root = opts.profileRoot ?? (windows
    ? env.TEMP ?? env.TMP ?? tmpdir()
    : env.AIDLC_TEST_WORKER_ROOT ?? tmpdir());
  const seed = realpathSync(opts.seedProfile);
  mkdirSync(root, { recursive: true });
  const profileDir = mkdtempSync(join(root, "aidlc-kiro-ide-profile-"));
  try {
    const destination = relative(seed, realpathSync(profileDir));
    if (destination === "" || (!isAbsolute(destination) && destination !== ".." && !destination.startsWith(`..${sep}`))) {
      throw new Error("Kiro profile destination must be outside the seed profile");
    }
    cpSync(seed, profileDir, {
      recursive: true,
      filter: (source) => dirname(source) !== seed ||
        !["DevToolsActivePort", "SingletonLock", "SingletonCookie", "SingletonSocket"].includes(basename(source)),
    });
  } catch (error) {
    rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }

  let child: ChildProcess;
  const spawnChild: KiroIdeLaunchRuntime["spawn"] = runtime.spawn ?? spawn;
  try {
    // Profile copying consumes the parent allocation before the child is started.
    remainingOperationTimeoutMs(opts.startupTimeoutMs ?? LIVE_STARTUP_TIMEOUT_MS, { env, deadlineMs: startupDeadlineMs, phase: "IDE startup" });
    child = spawnChild(opts.bin ?? KIRO_IDE_BIN, [
      opts.workspace,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-sandbox",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      // Isolated cancellation must also cover the interval before CDP discovery.
      detached: !windows && !inheritedGroup,
      env,
    });
  } catch (error) {
    rmSync(profileDir, { recursive: true, force: true });
    throw error;
  }

  // Opt-in per-file metadata only: no endpoints, profile contents, error text,
  // commands or environment values. Bound output and never let diagnostic I/O
  // replace a launch, body or cleanup failure.
  const tracePath = env.AIDLC_KIRO_IDE_DIAGNOSTICS;
  let traceCount = 0;
  let traceUnavailable = false;
  const trace: KiroIdeLifecycleTrace = (phase, fields = {}) => {
    if (!tracePath || traceUnavailable || traceCount >= 64) return;
    traceCount++;
    const limited = traceCount === 64;
    try {
      appendFileSync(tracePath, `${JSON.stringify({
        timestamp: new Date().toISOString(), event: "kiro-lifecycle",
        phase: limited ? "trace-limit" : phase, pid: child.pid,
        elapsedMs: performance.now() - launchStarted, ...(limited ? {} : fields),
      })}\n`, "utf8");
    } catch {
      traceUnavailable = true;
      try { process.stderr.write("[kiro-ide-driver] lifecycle trace write failed\n"); } catch { /* closed diagnostic pipe */ }
    }
  };
  trace("child-started");
  let closed = false;
  let resolveChildClosed!: () => void;
  const childClosed = new Promise<void>((resolveClosed) => { resolveChildClosed = resolveClosed; });
  let exited = false;
  let browserWebSocketUrl: string | undefined;
  let processError: Error | undefined;
  const onError = (error: Error) => { processError = error; trace("child-error"); };
  // Keep an error listener for the whole child lifetime, including after attach.
  child.on("error", onError);
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    trace("child-exit", { code, signal });
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true;
    trace("child-close", { code, signal });
    resolveChildClosed();
    child.removeListener("error", onError);
  });

  const liveChild = () => !exited && child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  const killDirectChild = (reason: "startup" | "fallback") => {
    if (!liveChild()) {
      trace(`${reason}-signal-skipped`, { closed, exited });
      return;
    }
    trace(`${reason}-signal`, { signal: "SIGKILL" });
    if (!child.kill("SIGKILL")) throw new Error("Kiro direct child termination failed");
  };
  const waitClosed = (timeoutMs: number): Promise<void> => {
    if (closed) return Promise.resolve();
    return new Promise((resolveClosed, reject) => {
      const onClose = () => { clearTimeout(timer); resolveClosed(); };
      const timer = setTimeout(() => {
        child.removeListener("close", onClose);
        trace("child-close-timeout", { timeoutMs, closed, exited });
        reject(new Error(`Kiro child did not close; profile retained at ${profileDir}`));
      }, timeoutMs);
      child.once("close", onClose);
    });
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (env.AIDLC_KEEP_TEMP === "1") {
      process.stderr.write(`[kiro-ide-driver] AIDLC_KEEP_TEMP=1 - preserved Kiro profile ${profileDir}\n`);
      return;
    }
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      trace("cleanup-start", { closed, exited });
      if (!closed) {
        const timeoutMs = remainingCleanupTimeoutMs(opts.shutdownTimeoutMs ?? LIVE_CLEANUP_TIMEOUT_MS, { env });
        const deadline = Date.now() + timeoutMs;
        if ((windows || inheritedGroup) && !runtime.terminate) {
          // Keep fallback observation inside the original shutdown budget.
          const closeDeadline = deadline - Math.floor(timeoutMs / 10);
          try {
            if (liveChild()) {
              if (browserWebSocketUrl) await closeKiroIdeBrowser(browserWebSocketUrl, Math.max(1, closeDeadline - Date.now()), childClosed, trace);
              else killDirectChild("startup"); // Startup failed before an endpoint was reported.
            }
            await waitClosed(Math.max(1, closeDeadline - Date.now()));
          } catch (error) {
            // Release the test's pipe handles so the parent can reap the worker
            // POSIX group or Windows Job (whose group marker is "0"). Only the
            // authoritative child is signalled; failure remains visible even
            // when this fallback closes it. The profile is retained on failure.
            try {
              trace("fallback-start", { closed, exited });
              killDirectChild("fallback");
              await waitClosed(Math.max(1, deadline - Date.now()));
            } catch (fallbackError) {
              throw new AggregateError([error, fallbackError], `Kiro cleanup failed; profile retained at ${profileDir}`);
            }
            throw new Error(`Kiro termination failed; profile retained at ${profileDir}`, { cause: error });
          }
        } else {
          try {
            if (liveChild()) {
              if (runtime.terminate) runtime.terminate(child);
              else terminateKiroIdeChild(child, Math.max(1, deadline - Date.now()));
            }
          } catch (error) {
            throw new Error(`Kiro termination failed; profile retained at ${profileDir}`, { cause: error });
          }
          await waitClosed(Math.max(1, deadline - Date.now()));
        }
      }
      removeSeedDir(profileDir, undefined, 250, env);
      trace("cleanup-complete", { closed, exited });
    })();
    try {
      await cleanupPromise;
    } catch (error) {
      trace("cleanup-failed", { closed, exited });
      cleanupPromise = undefined;
      throw error;
    }
  };

  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      let buffered = "";
      let settled = false;
      const finish = (port?: number, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("error", fail);
        child.removeListener("exit", onExit);
        child.removeListener("close", onExit);
        if (error) reject(error);
        else resolvePort(port!);
      };
      const fail = (error: Error) => finish(undefined, error);
      const onExit = () => fail(new Error("Kiro exited before reporting its CDP endpoint"));
      const timer = setTimeout(
        () => fail(new Error("Kiro timed out reporting its OS-assigned CDP endpoint")),
        opts.startupTimeoutMs === 0 ? 0 :
          remainingOperationTimeoutMs(opts.startupTimeoutMs ?? LIVE_STARTUP_TIMEOUT_MS, { env, deadlineMs: startupDeadlineMs, phase: "IDE startup" }),
      );
      child.once("error", fail);
      child.once("exit", onExit);
      child.once("close", onExit);
      if (!child.stderr) {
        fail(new Error("Kiro launch requires piped stderr for CDP endpoint ownership"));
        return;
      }
      // Continue draining stderr after attach so Electron cannot block on a full
      // pipe. Bound the incomplete line, and never retain the rest of its log.
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        buffered += chunk.toString();
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const endpoint = kiroIdeDebugEndpoint(line);
          if (endpoint !== null) {
            browserWebSocketUrl = endpoint.url;
            finish(endpoint.port);
            buffered = "";
            return;
          }
          newline = buffered.indexOf("\n");
        }
        buffered = buffered.slice(-8192);
      });
    });
    if (processError) throw processError;
    if (exited || closed || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Kiro exited while reporting its CDP endpoint");
    }
    const handle: KiroIdeHandle = { child, port, browserWebSocketUrl: browserWebSocketUrl!, workspace: opts.workspace, profileDir };
    kiroIdeCleanups.set(handle, cleanup);
    return handle;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Kiro launch and cleanup failed; profile retained at ${profileDir}`);
    }
    throw error;
  }
}

/** Keep the first assertion/driver failure when owned cleanup also fails.
 *  Cleanup runs once; callers keep their existing ordered cleanup steps so a
 *  failed child retirement never deletes the retained workspace or profile. */
export async function withKiroIdeCleanup<T>(
  body: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (bodyError) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([bodyError, cleanupError], "Kiro IDE test body and cleanup failed");
    }
    throw bodyError;
  }
  await cleanup();
  return result;
}

/** Poll GET /json/version until the CDP endpoint answers (drive-unblocked.mjs:48-56
 *  - this is already a proper poll in the spike; kept verbatim in shape). */
export async function waitForCdp(port: number, timeoutMs = LIVE_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const allocation = remainingOperationTimeoutMs(timeoutMs, { phase: "IDE CDP readiness" });
  const end = Date.now() + (timeoutMs === 0 ? 0 : allocation ?? timeoutMs);
  while (Date.now() < end) {
    const allocation = remainingOperationTimeoutMs(Math.max(1, end - Date.now()), { phase: "IDE CDP readiness" })!;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(allocation) });
      if (r.ok) return true;
    } catch {
      remainingOperationTimeoutMs(undefined, { phase: "IDE CDP readiness" });
      /* not up yet */
    }
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    await sleep(remainingOperationTimeoutMs(Math.min(400, remaining), { phase: "IDE CDP readiness" })!);
  }
  remainingOperationTimeoutMs(undefined, { phase: "IDE CDP readiness" });
  return false;
}

/** GET /json/list - every page/iframe target with a webSocketDebuggerUrl
 *  (cdp.mjs:8-11). */
export async function listTargets(port: number, deadlineMs?: number): Promise<CdpTargetInfo[]> {
  const timeoutMs = remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, { deadlineMs, phase: "IDE target discovery" });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    });
    return (await r.json()) as CdpTargetInfo[];
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw cdpTimeoutError(error, deadlineMs);
    }
    throw error;
  }
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

const CONTROL = 2;
const META = 4;
const PRIMARY_SHORTCUT_MODIFIER = platform() === "darwin" ? META : CONTROL;
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
export async function waitForChatInput(port: number, timeoutMs = LIVE_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const allocation = remainingOperationTimeoutMs(timeoutMs, { phase: "IDE chat readiness" });
  const end = Date.now() + (timeoutMs === 0 ? 0 : allocation ?? timeoutMs);
  try {
    while (Date.now() < end) {
      const targets = await listTargets(port, end);
      for (const tgt of targets) {
        if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
        const t = new CdpTarget(tgt.webSocketDebuggerUrl, end);
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
            } catch (error) {
              if (error instanceof TestBudgetExhaustedError) throw error;
              /* context gone */
            }
          }
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* target gone */
        } finally {
          t.close();
        }
      }
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      await sleep(remainingOperationTimeoutMs(Math.min(800, remaining), { phase: "IDE chat readiness" })!);
    }
  } catch (error) {
    if (!(error instanceof TestBudgetExhaustedError)) throw error;
    // The readiness deadline has always returned false. Recheck the file alone
    // first: if both deadlines expire together, shared-budget failure must win.
    remainingOperationTimeoutMs(undefined, { phase: "IDE chat readiness" });
    if (Date.now() < end) throw error;
    return false;
  }
  remainingOperationTimeoutMs(undefined, { phase: "IDE chat readiness" });
  return false;
}

// A chat editor can be live inside its nested webview while a top-level overlay
// intercepts the visible UI. Probe the real top-level hit-testing surface: only the
// chat iframe itself proves the sampled point is unobstructed. ARIA metadata is useful
// diagnostics, but is not trusted as the condition for deciding whether a hit blocks.
export function inspectKiroIdeChatSurfaceDocument(
  doc: Document = document,
  styleOf: typeof getComputedStyle = getComputedStyle,
): KiroIdeChatSurfaceState {
  const norm = (s: unknown): string => String(s || "").replace(/\s+/g, " ").trim();
  const visible = (e: Element): boolean => {
    const r = e.getBoundingClientRect?.();
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    const s = styleOf(e);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number.parseFloat(s.opacity || "1") > 0
    );
  };
  const rectOf = (e: Element): KiroIdeBlockingOverlay["rect"] => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const modalSelector = "[aria-modal='true']";
  const blockingOverlays = [...doc.querySelectorAll(modalSelector)]
    .filter((e) => visible(e) && styleOf(e).pointerEvents !== "none")
    .map((e) => ({
      text: norm((e as HTMLElement).innerText || e.textContent).slice(0, 1000),
      className: String(e.className || ""),
      role: String(e.getAttribute("role") || ""),
      ariaModal: String(e.getAttribute("aria-modal") || ""),
      rect: rectOf(e),
    }));
  const ownedChatFrames = [
    ...doc.querySelectorAll("iframe[src*='extensionId=kiro.kiroAgent']"),
  ];
  // Other extension webviews can sit behind chat; they are not chat hit-test targets.
  // Keep the generic selector for older versions without extension ownership metadata.
  const chatFrames = (
    ownedChatFrames.length > 0
      ? ownedChatFrames
      : [...doc.querySelectorAll("iframe.webview.ready")]
  ).filter(visible);
  const blockedHitPoints: KiroIdeBlockedHitPoint[] = [];
  for (const frame of chatFrames) {
    const r = frame.getBoundingClientRect();
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width / 2, r.bottom - Math.min(80, r.height / 4)],
    ];
    for (const [x, y] of points) {
      const hit = doc.elementFromPoint(x, y);
      const clear = hit === frame || (hit && frame.contains(hit));
      if (clear) continue;
      blockedHitPoints.push({
        x,
        y,
        hitTag: String(hit?.tagName || ""),
        hitClassName: String(hit?.className || ""),
        hitText: norm((hit as HTMLElement | null)?.innerText || hit?.textContent).slice(0, 500),
      });
    }
  }
  return {
    chatFrameCount: chatFrames.length,
    blockedHitPoints,
    blockingOverlays,
  };
}

const CHAT_SURFACE_STATE_EXPR = `(${inspectKiroIdeChatSurfaceDocument.toString()})()`;

/** Inspect the visible top-level workbench surface, not just the nested chat DOM. */
export async function inspectKiroIdeChatSurface(port: number): Promise<KiroIdeChatSurfaceState> {
  const t = await pageTarget(port);
  try {
    return await t.evaluate<KiroIdeChatSurfaceState>(CHAT_SURFACE_STATE_EXPR);
  } finally {
    t.close();
  }
}

const SESSION_MIGRATION_TITLE = "upgraded how sessions are stored";
const SESSION_MIGRATION_BODY = "migrate your previous sessions";

function hasSessionMigrationOverlay(surface: KiroIdeChatSurfaceState): boolean {
  return surface.blockingOverlays.some((overlay) => {
    const text = overlay.text.toLowerCase();
    return text.includes(SESSION_MIGRATION_TITLE) && text.includes(SESSION_MIGRATION_BODY);
  });
}

function chatSurfaceIsReady(surface: KiroIdeChatSurfaceState): boolean {
  return (
    surface.chatFrameCount > 0 &&
    surface.blockingOverlays.length === 0 &&
    surface.blockedHitPoints.length === 0
  );
}

export interface KiroIdeChatSurfaceAdapter {
  inspect: () => Promise<KiroIdeChatSurfaceState>;
  dismissMigration: () => Promise<string | null>;
  dismissNotification?: () => Promise<string | null>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

/** Reconcile supported startup overlays and return only after the chat iframe is
 * visibly unobstructed. The injected adapter keeps current/older/persistent-modal
 * behavior deterministic in tests without launching Electron. */
export async function settleKiroIdeChatSurface(
  adapter: KiroIdeChatSurfaceAdapter,
  timeoutMs = LIVE_STARTUP_TIMEOUT_MS,
  pollMs = 250,
): Promise<KiroIdeChatPreparation> {
  const remaining = remainingOperationTimeoutMs(timeoutMs, { phase: "IDE chat surface" });
  const allocation = timeoutMs === 0 ? 0 : remaining ?? timeoutMs;
  const deadline = adapter.now() + allocation;
  let dismissed: string | null = null;
  let surface: KiroIdeChatSurfaceState = {
    chatFrameCount: 0,
    blockedHitPoints: [],
    blockingOverlays: [],
  };

  for (;;) {
    remainingOperationTimeoutMs(undefined, { phase: "IDE chat surface" });
    surface = await adapter.inspect();
    if (chatSurfaceIsReady(surface)) return { dismissed, surface };

    if (hasSessionMigrationOverlay(surface)) {
      const clicked = await adapter.dismissMigration();
      if (clicked) dismissed = clicked;
    }
    if (
      surface.blockedHitPoints.some((hit) =>
        hit.hitClassName.split(/\s+/).some((name) => name.startsWith("notification-list-item")),
      )
    ) {
      const clicked = await adapter.dismissNotification?.();
      if (clicked) dismissed = clicked;
    }

    if (adapter.now() >= deadline) break;
    await adapter.wait(pollMs);
  }

  throw new Error(
    "kiro-ide-driver: blocking overlay remains over chat after startup reconciliation: " +
      JSON.stringify(surface),
  );
}

/** Dismiss the current Kiro session-migration carousel when present, while allowing
 * older versions where it is absent. Success requires both zero aria-modal overlays
 * and clear hit tests over the chat iframe. */
export function prepareKiroIdeChat(
  port: number,
  timeoutMs = LIVE_STARTUP_TIMEOUT_MS,
): Promise<KiroIdeChatPreparation> {
  return settleKiroIdeChatSurface(
    {
      inspect: () => inspectKiroIdeChatSurface(port),
      dismissMigration: () => clickByText(port, ["remind me later"]),
      dismissNotification: () => clickByText(port, [
        "clear notification",
        "clear notification (⌘backspace)",
      ]),
      wait: sleep,
      now: Date.now,
    },
    timeoutMs,
  );
}

/** Cmd+Shift+L on macOS or Ctrl+Shift+L on Windows focuses the Kiro chat input. */
export async function focusChat(t: CdpTarget): Promise<void> {
  await t.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: PRIMARY_SHORTCUT_MODIFIER | SHIFT,
    key: "L",
    code: "KeyL",
    windowsVirtualKeyCode: 76,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: PRIMARY_SHORTCUT_MODIFIER | SHIFT,
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
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* context gone */
        }
      }
    } catch (error) {
      if (error instanceof TestBudgetExhaustedError) throw error;
      /* target gone */
    } finally {
      t.close();
    }
  }
  return "";
}

// A chat shortcut can focus the webview's BODY without focusing its editor.
// Focus the visible editor itself; text insertion and submit still use CDP input.
const FOCUS_CHAT_EDITOR_EXPR = `(() => {
  for (const e of document.querySelectorAll("[contenteditable='true']")) {
    if (!/prosemirror|tiptap/i.test(String(e.className || ""))) continue;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    e.focus({ preventScroll: true });
    return document.activeElement === e;
  }
  return false;
})()`;

async function focusChatEditor(port: number): Promise<boolean> {
  for (const target of await listTargets(port)) {
    if (!target.webSocketDebuggerUrl || (target.type !== "page" && target.type !== "iframe")) continue;
    const t = new CdpTarget(target.webSocketDebuggerUrl);
    try {
      await t.connect();
      for (const context of await t.enableContexts(600)) {
        try {
          if (await t.evaluateInContext<boolean>(context.id, FOCUS_CHAT_EDITOR_EXPR)) return true;
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* context gone */
        }
      }
    } catch (error) {
      if (error instanceof TestBudgetExhaustedError) throw error;
      /* target gone */
    } finally {
      t.close();
    }
  }
  return false;
}

/** Select-all then Delete to clear the focused chat editor between retries. */
async function selectAllAndDelete(t: CdpTarget): Promise<void> {
  await t.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: PRIMARY_SHORTCUT_MODIFIER,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await t.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: PRIMARY_SHORTCUT_MODIFIER,
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
    await focusChatEditor(port);
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
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* context gone */
        }
      }
    } catch (error) {
      if (error instanceof TestBudgetExhaustedError) throw error;
      /* target gone */
    } finally {
      t.close();
    }
  }
  return null;
}

const SNAPSHOT_DOM_EXPR = `(() => {
  const norm = (s) => String(s||"").replace(/\\s+/g," ").trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect && e.getBoundingClientRect();
    return !r || (r.width > 0 && r.height > 0);
  };
  const controls = [...document.querySelectorAll(
    "a,button,[role='button'],.monaco-button,.monaco-text-button,.action-label"
  )]
    .filter(visible)
    .map((e) => ({
      tag: e.tagName,
      text: norm(e.innerText||e.textContent).slice(0, 240),
      ariaLabel: norm(e.getAttribute("aria-label")).slice(0, 240),
      disabled: Boolean(e.disabled || e.getAttribute("aria-disabled") === "true")
    }))
    .filter((e) => e.text || e.ariaLabel)
    .slice(-80);
  const editors = [...document.querySelectorAll(
    "textarea,[contenteditable='true'],[role='textbox']"
  )]
    .filter(visible)
    .map((e) => ({
      tag: e.tagName,
      text: norm(e.tagName === "TEXTAREA" ? e.value : (e.innerText||e.textContent)).slice(0, 1000),
      ariaLabel: norm(e.getAttribute("aria-label")).slice(0, 240)
    }))
    .slice(-20);
  const orderedLists = [...document.querySelectorAll("ol")]
    .filter(visible)
    .map((list) => [...list.querySelectorAll(":scope > li")]
      .filter(visible)
      .map((item) => norm(item.innerText||item.textContent).slice(0, 2000)))
    .filter((items) => items.length > 0)
    .slice(-20);
  const bodyText = norm(document.body && document.body.innerText);
  return {
    href: String(location.href),
    title: String(document.title||""),
    text: bodyText.slice(-12000),
    controls,
    editors,
    orderedLists
  };
})()`;

/** Capture visible text, controls, and editors from every live page/iframe
 * execution context. Diagnostics only: callers persist snapshots under tmp/. */
export async function snapshotChatDom(port: number): Promise<KiroIdeDomSnapshot[]> {
  const snapshots: KiroIdeDomSnapshot[] = [];
  const targets = await listTargets(port);
  for (const tgt of targets) {
    if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
    const t = new CdpTarget(tgt.webSocketDebuggerUrl);
    try {
      await t.connect();
      const contexts = await t.enableContexts(600);
      for (const context of contexts) {
        try {
          const view = await t.evaluateInContext<
            Omit<KiroIdeDomSnapshot, "targetType" | "targetUrl" | "context">
          >(context.id, SNAPSHOT_DOM_EXPR);
          if (view.text || view.controls.length > 0 || view.editors.length > 0) {
            snapshots.push({
              targetType: tgt.type,
              targetUrl: tgt.url ?? "",
              context,
              ...view,
            });
          }
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* context gone */
        }
      }
    } catch (error) {
      if (error instanceof TestBudgetExhaustedError) throw error;
      /* target gone */
    } finally {
      t.close();
    }
  }
  return snapshots;
}

const SNAPSHOT_NUMBERED_LISTS_EXPR = `(() => {
  const norm = (s) => String(s||"").replace(/\\s+/g," ").trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect && e.getBoundingClientRect();
    return !r || (r.width > 0 && r.height > 0);
  };
  return [...document.querySelectorAll("ol")]
    .filter(visible)
    .map((list) => {
      const children = [...list.children].filter((e) => e.tagName === "LI" && visible(e));
      const reversed = list.hasAttribute("reversed");
      const parsedStart = Number.parseInt(list.getAttribute("start") || "", 10);
      const defaultStart = reversed ? children.length : 1;
      let next = Number.isFinite(parsedStart) ? parsedStart : defaultStart;
      const items = children.map((item) => {
        const itemStyle = getComputedStyle(item);
        const markerStyle = getComputedStyle(item, "::marker");
        const parsedValue = Number.parseInt(item.getAttribute("value") || "", 10);
        const ordinal = Number.isFinite(parsedValue) ? parsedValue : next;
        next = ordinal + (reversed ? -1 : 1);
        return {
          ordinal,
          text: norm(item.innerText || item.textContent).slice(0, 1000),
          display: String(itemStyle.display || ""),
          listStyleType: String(itemStyle.listStyleType || ""),
          visibility: String(itemStyle.visibility || ""),
          opacity: String(itemStyle.opacity || ""),
          markerContent: String(markerStyle.content || ""),
          markerColor: String(markerStyle.color || ""),
          markerFontSize: String(markerStyle.fontSize || ""),
          markerOpacity: String(markerStyle.opacity || "")
        };
      });
      return {
        href: String(location.href),
        listStyleType: String(getComputedStyle(list).listStyleType || ""),
        start: Number.isFinite(parsedStart) ? parsedStart : defaultStart,
        items
      };
    })
    .filter((list) => list.items.length > 0);
})()`;

/** Capture visible ordered-list structure from every live page/iframe context.
 * Plain innerText omits CSS list markers in Kiro's chat webview, so live visual
 * assertions inspect the rendered OL/LI ordinals and list style directly. */
export async function snapshotNumberedLists(
  port: number,
): Promise<KiroIdeNumberedListSnapshot[]> {
  const snapshots: KiroIdeNumberedListSnapshot[] = [];
  const targets = await listTargets(port);
  for (const tgt of targets) {
    if (!tgt.webSocketDebuggerUrl || (tgt.type !== "page" && tgt.type !== "iframe")) continue;
    const t = new CdpTarget(tgt.webSocketDebuggerUrl);
    try {
      await t.connect();
      const contexts = await t.enableContexts(600);
      for (const context of contexts) {
        try {
          const lists = await t.evaluateInContext<
            Array<Omit<KiroIdeNumberedListSnapshot, "targetType" | "targetUrl" | "context">>
          >(context.id, SNAPSHOT_NUMBERED_LISTS_EXPR);
          for (const list of lists) {
            snapshots.push({
              targetType: tgt.type,
              targetUrl: tgt.url ?? "",
              context,
              ...list,
            });
          }
        } catch (error) {
          if (error instanceof TestBudgetExhaustedError) throw error;
          /* context gone */
        }
      }
    } catch (error) {
      if (error instanceof TestBudgetExhaustedError) throw error;
      /* target gone */
    } finally {
      t.close();
    }
  }
  return snapshots;
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
  const allocation = remainingOperationTimeoutMs(Math.max(1, budgetMs), { phase: "IDE marker watch" })!;
  const end = Date.now() + Math.min(budgetMs, allocation);
  while (Date.now() < end) {
    if (onPoll) await onPoll();
    if (predicate()) return true;
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
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

/** Stop only a driver-owned launch, wait for close, then remove its private
 *  profile. Failed termination preserves the profile and fails the test. */
export async function teardown(handle: KiroIdeHandle): Promise<void> {
  const cleanup = kiroIdeCleanups.get(handle);
  if (!cleanup) throw new Error("Refusing teardown of a Kiro handle not owned by this driver");
  await cleanup();
}

/** Remove a seed/profile directory, tolerating Windows lock latency: after
 *  taskkill ends the Electron tree, the OS can hold file locks inside the
 *  user-data dir for a short moment, so a bare rmSync throws EBUSY. Bounded
 *  retries with short waits; anything else (or exhaustion) still throws. */
export function removeSeedDir(
  path: string,
  attempts: number | undefined = undefined,
  waitMs = 250,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.AIDLC_KEEP_TEMP === "1") {
    process.stderr.write(`[kiro-ide-driver] AIDLC_KEEP_TEMP=1 - preserved ${path}\n`);
    return;
  }
  const deadline = Date.now() + remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, { env });
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retryable || (attempts !== undefined && attempt >= attempts) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(waitMs, Math.max(0, deadline - Date.now())));
    }
  }
}

/** Presence test for the launch binary (existsSync, NOT a --version PATH probe). */
export function kiroIdeAvailable(bin = KIRO_IDE_BIN): boolean {
  return (platform() === "darwin" || platform() === "win32") && existsSync(bin);
}

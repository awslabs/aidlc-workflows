// Shared selection and prerequisite checks for the TUI driver and its callers.
// Keep this module independent of tui-drive.ts: importing it never opens a PTY.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NATIVE_STARTUP_TIMEOUT_MS } from "./test-budget.ts";

export type TuiBackendName = "bun" | "tmux" | "node-pty";

type RuntimeEnv = Readonly<NodeJS.ProcessEnv>;
type ProbeResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

/** Optional inputs keep runtime selection/probes testable without live CLIs. */
export interface TuiRuntimeContext {
  env?: RuntimeEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  runningBun?: boolean;
  probe?: (bin: string, args: string[], env: RuntimeEnv) => ProbeResult;
}

export function selectedTuiBackend(
  env: RuntimeEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TuiBackendName {
  const selected = env.AIDLC_TUI_BACKEND;
  if (selected === undefined || selected === "auto") {
    return platform === "linux" || platform === "win32" || platform === "darwin" ? "bun" : "tmux";
  }
  if (selected === "bun" || selected === "tmux" || selected === "node-pty") {
    return selected;
  }
  throw new Error(
    `Invalid AIDLC_TUI_BACKEND ${JSON.stringify(selected)}; expected auto, bun, tmux, or node-pty`,
  );
}

const PROBE_CWD = fileURLToPath(new URL("../../", import.meta.url));
const probeCache = new Map<string, ProbeResult>();

function probe(bin: string, args: string[], env: RuntimeEnv): ProbeResult {
  // Include actual environment values, not just the selected backend. PATH,
  // runtime overrides, and module lookup settings can change within a process.
  const key = JSON.stringify([
    bin,
    args,
    PROBE_CWD,
    Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) =>
      a.localeCompare(b)
    ),
  ]);
  const cached = probeCache.get(key);
  if (cached) return cached;
  const result = spawnSync(bin, args, {
    cwd: PROBE_CWD,
    env,
    encoding: "utf-8",
    // Selection also runs during coordinator cleanup after the file's work
    // deadline. Its own bounded probe must not consume the expired work budget.
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
    windowsHide: true,
  });
  const captured: ProbeResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
  probeCache.set(key, captured);
  return captured;
}

function executableOverride(env: RuntimeEnv, name: string): string | undefined {
  const value = env[name];
  if (value !== undefined && (!value.trim() || value.includes("\0"))) {
    throw new Error(`Invalid ${name}: expected an executable path or command name`);
  }
  return value;
}

function resolveNode(context: TuiRuntimeContext): string {
  const env = context.env ?? process.env;
  const override = executableOverride(env, "AIDLC_NODE_BIN");
  if (override !== undefined) return override;
  const run = context.probe ?? probe;
  if (run("node", ["--version"], env).status === 0) return "node";
  if ((context.platform ?? process.platform) === "win32") {
    const installed = "C:\\Program Files\\nodejs\\node.exe";
    if (run(installed, ["--version"], env).status === 0) return installed;
  }
  // Let the capability probe report absence; resolving a launch tuple must not
  // turn an unavailable runtime into an import-time failure in a skipped test.
  return "node";
}

export function resolveTuiRuntime(
  driverPath: string,
  context: TuiRuntimeContext = {},
): { bin: string; prefix: string[]; backend: TuiBackendName } {
  const env = context.env ?? process.env;
  const backend = selectedTuiBackend(env, context.platform ?? process.platform);
  if (backend === "node-pty") {
    return {
      bin: resolveNode(context),
      prefix: ["--experimental-strip-types", driverPath],
      backend,
    };
  }
  const bin = executableOverride(env, "AIDLC_BUN_BIN") ??
    ((context.runningBun ?? Boolean(process.versions.bun))
      ? (context.execPath ?? process.execPath)
      : "bun");
  return { bin, prefix: [driverPath], backend };
}

const BUN_VERSION_PROBE = "console.log(JSON.stringify({version: process.versions.bun ?? null}))";
const BUN_TERMINAL_PROBE = `
let headlessError = null;
try { require("@xterm/headless"); } catch (error) { headlessError = String(error); }
console.log(JSON.stringify({
  version: process.versions.bun ?? null,
  terminal: typeof globalThis.Bun?.Terminal,
  headlessError
}));
`;
const NODE_PTY_PROBE = `
if (process.versions.bun) throw new Error("node-pty requires Node, not Bun");
require("node-pty");
require("@xterm/headless");
`;

function supportsNativeTerminalVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 14)));
}

/** Probe only the selected substrate. Absence is a reason; bad config throws. */
export function tuiUnavailableReason(context: TuiRuntimeContext = {}): string | null {
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const backend = selectedTuiBackend(env, platform);
  executableOverride(env, backend === "node-pty" ? "AIDLC_NODE_BIN" : "AIDLC_BUN_BIN");
  if (backend === "bun" && platform !== "linux" && platform !== "win32" && platform !== "darwin") {
    return `Bun TUI backend is unsupported on ${platform}; native lifecycle supports Linux, Windows and macOS only (select AIDLC_TUI_BACKEND=tmux)`;
  }
  if (backend === "node-pty" && platform !== "win32") {
    return `node-pty TUI backend is unsupported on ${platform}; the legacy backend supports Windows only`;
  }
  const { bin } = resolveTuiRuntime("", context);
  const run = context.probe ?? probe;
  if (backend === "node-pty") {
    const result = run(bin, ["--experimental-strip-types", "-e", NODE_PTY_PROBE], env);
    if (result.status !== 0) {
      return `node-pty TUI backend requires Node with --experimental-strip-types, node-pty and @xterm/headless (${bin}): ${result.error?.message ?? (result.stderr.trim() || "runtime probe failed")}`;
    }
    return null;
  }
  const result = run(
    bin,
    ["--eval", backend === "bun" ? BUN_TERMINAL_PROBE : BUN_VERSION_PROBE],
    env,
  );
  if (result.status !== 0) {
    return `Bun runtime unavailable (${bin}): ${result.error?.message ?? (result.stderr.trim() || "runtime probe failed")}`;
  }
  let capability: { version?: string; terminal?: string; headlessError?: string | null };
  try {
    capability = JSON.parse(result.stdout);
    if (!capability || typeof capability.version !== "string") {
      return `Bun runtime required for ${backend} TUI backend (${bin})`;
    }
  } catch {
    return `Bun runtime probe returned invalid capability data (${bin})`;
  }
  if (backend === "tmux") {
    return run("tmux", ["-V"], env).status === 0 ? null : "tmux not found";
  }
  if (!supportsNativeTerminalVersion(capability.version)) {
    return `Bun TUI backend requires Bun >=1.3.14; found ${capability.version} (${bin})`;
  }
  if (capability.terminal !== "function") {
    return `Bun.Terminal API unavailable in ${bin}; native TUI requires Bun >=1.3.14 with Bun.Terminal`;
  }
  if (capability.headlessError !== null) {
    return `@xterm/headless not loadable by Bun (${bin}): ${capability.headlessError ?? "capability probe did not report a successful load"}`;
  }
  return null;
}

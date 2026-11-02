#!/usr/bin/env bun
// aidlc dashboard: opens the AI-DLC Command Center, a read-only live view of
// the AI-DLC workspaces on this machine.
//
// The server runs in this process (so the compiled binary bundles it and no
// separate bun is needed) and listens on 127.0.0.1 only; there is no option to
// widen that. The prebuilt UI ships beside the tools as command-center/ui.
// The only write is the settings file (~/.aidlc/dashboard.json by default).
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CONFIG_PATH, type Config, loadConfig, saveConfig } from "../command-center/server/config.ts";
import { startServer } from "../command-center/server/index.ts";
import { isCompiledModuleUrl, resolveHarnessPath } from "./aidlc-runtime-paths.ts";

export interface LaunchArgs {
  port: number;
  open: boolean;
  json: boolean;
  help: boolean;
  roots: string[];
  pins: string[];
  config: string;
  projectDir: string | null;
}

const USAGE =
  "Usage: aidlc dashboard [--port <n>] [--no-open] [--json] [--root <dir>]... [--pin <dir>]... [--config <file>]";

const HELP = [
  "Open the AI-DLC Command Center, a read-only local view of your AI-DLC workspaces.",
  USAGE,
  "",
  "  --port <n>       Port to listen on (default: any free port)",
  "  --no-open        Do not open a browser; just print the URL",
  '  --json           Print {"url","port"} as one JSON line, then keep serving',
  "  --root <dir>     Add a folder to scan for AI-DLC projects (saved for next time)",
  "  --pin <dir>      Add one AI-DLC project (saved for next time)",
  "  --config <file>  Settings file (default ~/.aidlc/dashboard.json, or AIDLC_DASHBOARD_CONFIG)",
  "",
  "It serves on 127.0.0.1 until stopped (Ctrl-C).",
  "",
].join("\n");

// Global dispatcher flags that mean nothing to a local server.
const IGNORED_GLOBAL_FLAGS = new Set(["--no-color", "--quiet", "--yes", "--offline", "--verbose"]);

export function parseArgs(argv: string[]): LaunchArgs {
  const o: LaunchArgs = {
    port: 0,
    open: true,
    json: false,
    help: false,
    roots: [],
    pins: [],
    config: process.env.AIDLC_DASHBOARD_CONFIG ?? CONFIG_PATH,
    projectDir: null,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "dashboard" && i === 0) continue; // the dispatcher passes its verb through
    if (IGNORED_GLOBAL_FLAGS.has(a)) continue;
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--port") {
      const v = value(++i, a);
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error("--port must be an integer 0-65535");
      o.port = Number(v);
    } else if (a === "--no-open") o.open = false;
    else if (a === "--json") o.json = true;
    else if (a === "--root") o.roots.push(resolve(value(++i, a)));
    else if (a === "--pin") o.pins.push(resolve(value(++i, a)));
    else if (a === "--config") o.config = resolve(value(++i, a));
    else if (a === "--project-dir") o.projectDir = resolve(value(++i, a));
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const covers = (root: string, p: string): boolean =>
  p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Folds --root/--pin into cfg and auto-pins cwd when it is an AI-DLC project
// that no saved root or pin covers. Returns whether cfg changed.
export async function applyLaunch(cfg: Config, a: LaunchArgs, cwd: string): Promise<boolean> {
  let changed = false;
  for (const r of a.roots) {
    if (!cfg.roots.includes(r)) {
      cfg.roots.push(r);
      changed = true;
    }
  }
  for (const p of a.pins) {
    if (!cfg.pins.includes(p)) {
      cfg.pins.push(p);
      changed = true;
    }
  }
  const here = resolve(cwd);
  if (
    existsSync(join(here, "aidlc", "active-space")) &&
    !cfg.pins.includes(here) &&
    !cfg.roots.some((r) => covers(resolve(r), here))
  ) {
    cfg.pins.push(here);
    changed = true;
  }
  return changed;
}

// The shipped UI bundle, or null when this install lacks it. In a source or
// projected tree the bundle sits beside tools/; the compiled binary has no
// on-disk module dir, so it asks the harness resolver for the installed tree.
export function uiDirectory(): string | null {
  const candidates: string[] = [];
  if (!isCompiledModuleUrl(import.meta.url)) candidates.push(join(import.meta.dir, "..", "command-center", "ui"));
  candidates.push(resolveHarnessPath(["command-center", "ui"]));
  return candidates.find((dir) => existsSync(join(dir, "index.html"))) ?? null;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener on this machine: the URL is printed, which is enough.
  }
}

type Deps = {
  start: typeof startServer;
  open: (url: string) => void;
  uiDir: () => string | null;
  cwd: () => string;
  out: (s: string) => void;
  err: (s: string) => void;
  // false only in tests: return after printing instead of serving until a signal.
  keepAlive: boolean;
};

export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<void> {
  const d: Deps = {
    start: startServer,
    open: openBrowser,
    uiDir: uiDirectory,
    cwd: () => process.cwd(),
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
    keepAlive: true,
    ...deps,
  };
  let a: LaunchArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    d.err(`aidlc dashboard: ${(e as Error).message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (a.help) {
    d.out(HELP);
    process.exitCode = 0;
    return;
  }
  const uiDir = d.uiDir();
  if (uiDir === null) {
    d.err(
      "aidlc dashboard: the Command Center UI bundle is missing from this install. Reinstall AI-DLC, or run `aidlc doctor`.\n",
    );
    process.exitCode = 1;
    return;
  }
  const cfg = await loadConfig(a.config);
  if (await applyLaunch(cfg, a, a.projectDir ?? d.cwd())) {
    await saveConfig(cfg, a.config).catch((e) => {
      d.err(`aidlc dashboard: settings not saved: ${(e as Error).message}\n`);
    });
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await d.start({ port: a.port, config: cfg, configPath: a.config, uiDir });
  } catch (e) {
    d.err(`Could not start the Command Center: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  d.out(
    a.json
      ? `${JSON.stringify({ url: server.url, port: server.port })}\n`
      : `AI-DLC Command Center → ${server.url}\nPress Ctrl-C to stop.\n`,
  );
  if (a.open) d.open(server.url);
  if (!d.keepAlive) {
    server.stop();
    return;
  }
  await new Promise<void>((done) => {
    const quit = (): void => {
      server.stop();
      done();
    };
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
  });
  process.exitCode = 0;
}

if (import.meta.main) void main(process.argv.slice(2));

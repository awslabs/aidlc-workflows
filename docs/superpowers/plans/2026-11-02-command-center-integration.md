# Command Center Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Command Center Engineering view inside AI-DLC so that `aidlc dashboard` and `/aidlc dashboard` open a live, loopback-only, read-only view of the engineer's AI-DLC workflows.

**Architecture:** The server and the prebuilt UI bundle live in `core/command-center/` and are projected into every harness tree. `core/tools/aidlc-dashboard.ts` imports the server in-process and is registered as a public, long-lived dispatcher route. UI sources and the app's own tests live in a dev-only `command-center/` package that builds into `core/command-center/ui/`.

**Tech Stack:** Bun 1.3+, TypeScript, React 19 + Vite 7 (dev only), happy-dom (dev tests), Biome, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-02-command-center-integration-design.md`

## Global Constraints

- Source of the port: the standalone Command Center checkout's `engineering/` folder at its current HEAD (`bb46e8f`). Copy files; do not change server behaviour.
- Edit `core/` and `harness/` only, never `dist*`. After edits, run `bun scripts/package.ts` and then `bun scripts/package.ts --check`.
- Server binds `127.0.0.1` only. No option widens it.
- No AI calls, outbound network requests, or telemetry anywhere in the Command Center.
- No real local paths, user names, or client project names in any committed file or commit message. Fixtures use `/Users/someone/...` or temp dirs.
- No version bump, README badge change, or CHANGELOG entry (Release Metadata Policy).
- Grep `docs/` and `README.md` for stale references when adding the command (Documentation Policy).
- Test files: `tests/unit/t266N-*.test.ts` and `tests/integration/t266N-*.test.ts`. Pick unused numbers ≥ 2660 (`ls tests/*/t266*`).
- Commit messages: Conventional Commits (`feat(dashboard): …`), with no real names.

---

### Task 1: Port the server into `core/command-center/server`

**Files:**
- Create: `core/command-center/server/**` (copied from `engineering/server/**`)
- Create: `core/command-center/README.md` (one paragraph: what ships here, where sources and tests live)

**Interfaces:**
- Produces: `startServer(o: { port?: number; config: Config; configPath?: string; uiDir?: string; ... }) => Promise<{ url: string; port: number; token: string; stop(): void }>` from `core/command-center/server/index.ts`, and `CONFIG_PATH`, `loadConfig(path)`, `saveConfig(cfg, path)`, `type Config` from `core/command-center/server/config.ts`.

- [ ] **Step 1: Copy the server**

```bash
SRC=<path to the standalone Command Center checkout>/engineering
mkdir -p core/command-center
cp -R "$SRC/server" core/command-center/server
```

- [ ] **Step 2: Remove the default UI path that assumes the old layout**

In `core/command-center/server/index.ts`, `uiDir` defaults to `join(import.meta.dir, "../ui/dist")`. Change the default to `join(import.meta.dir, "../ui")` to match the new bundle location (§3). The launcher always passes `uiDir` explicitly; this default only serves tests.

- [ ] **Step 3: Typecheck and lint against the repo config**

Run: `bunx tsc --noEmit -p tsconfig.json` and `bunx biome check --error-on-warnings core/command-center`
Expected: no errors. Fix lint findings with the smallest behaviour-neutral edit (for example `node:` import prefixes or `useTemplate`). If a rule conflicts with the ported style across many files, add a narrow `overrides` entry in `biome.json` for `core/command-center/**` with a comment naming the rule. Do not disable rules repo-wide.

- [ ] **Step 4: Commit**

```bash
git add core/command-center biome.json
git commit -m "feat(dashboard): add the Command Center server under core/command-center"
```

### Task 2: Dev package with UI sources, tests, and the built bundle

**Files:**
- Create: `command-center/package.json`, `command-center/bun.lock`, `command-center/tsconfig.json`, `command-center/bunfig.toml`, `command-center/vite.config.ts`
- Create: `command-center/ui/index.html`, `command-center/ui/src/**` (copied)
- Create: `command-center/tests/**` (copied; imports rewritten)
- Create: `core/command-center/ui/**` (built bundle, committed)
- Create: `.github/workflows/command-center.yml`
- Modify: `.gitignore` (add `command-center/node_modules/`)

**Interfaces:**
- Consumes: the server from Task 1 at `../core/command-center/server/*`.
- Produces: `core/command-center/ui/index.html` plus `core/command-center/ui/assets/*`.

- [ ] **Step 1: Copy UI sources and tests**

```bash
SRC=<path to the standalone Command Center checkout>/engineering
mkdir -p command-center/ui
cp -R "$SRC/ui/src" command-center/ui/src
cp "$SRC/ui/index.html" command-center/ui/index.html
cp -R "$SRC/tests" command-center/tests
cp "$SRC/tsconfig.json" command-center/tsconfig.json
```

Do not copy `bin/`, `scripts/` (demo seeders and screenshot capture), or `docs/`. Remove any copied test whose subject was not ported (`cli.test.ts` tests `bin/dashboard.ts`, `demo-*.test.ts` test the seeders). Its replacement for the launcher is Task 3.

- [ ] **Step 2: Rewrite test imports to the core server**

```bash
cd command-center
grep -rl '"\.\./server/' tests | xargs sed -i '' 's#"\.\./server/#"../../core/command-center/server/#g'
grep -rl '"\.\./\.\./server/' tests | xargs sed -i '' 's#"\.\./\.\./server/#"../../../core/command-center/server/#g'
grep -rn '\.\./bin/\|\.\./scripts/' tests   # expect no output
cd ..
```

- [ ] **Step 3: Write the dev package manifests**

`command-center/package.json`:

```json
{
  "name": "aidlc-command-center-dev",
  "private": true,
  "type": "module",
  "description": "Dev-only package for the AI-DLC Command Center UI and tests. The shipped server and bundle live in core/command-center/.",
  "scripts": {
    "build:ui": "vite build",
    "test": "bun test",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "engines": { "bun": ">=1.3.14" },
  "devDependencies": {
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "vite": "7.3.6",
    "typescript": "6.0.3",
    "bun-types": "1.3.14",
    "@happy-dom/global-registrator": "20.14.5"
  }
}
```

`command-center/vite.config.ts`:

```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the UI into the shipped core tree. The output is committed; CI
// rebuilds it and fails when the committed bundle differs.
export default defineConfig({
  root: resolve(__dirname, "ui"),
  plugins: [react()],
  base: "/",
  build: { outDir: resolve(__dirname, "../core/command-center/ui"), emptyOutDir: true, assetsDir: "assets" },
});
```

In `command-center/tsconfig.json`, set `include` to `["ui/src", "tests", "../core/command-center/server"]`. Copy `bunfig.toml` from the source `engineering/` package if it has one (the happy-dom preload for DOM tests). Otherwise copy the root `bunfig.toml`'s `[test]` preload section.

- [ ] **Step 4: Install, build, and run the app's tests**

```bash
cd command-center
bun install --registry=https://registry.npmjs.org
bun run build:ui
bun test 2>&1 | tail -15
bun run typecheck
cd ..
ls core/command-center/ui    # expect index.html assets
```

Expected: every ported test passes, and typecheck is clean. A failing test means an import was missed in Step 2 or a fixture path differs. Fix the import, never the assertion.

- [ ] **Step 5: Verify the build is deterministic**

```bash
(cd command-center && bun run build:ui) && git status --porcelain core/command-center/ui
```

Expected: rerunning the build changes nothing. If asset hashes differ between runs, stop and investigate. CI relies on a byte-stable bundle.

- [ ] **Step 6: Add the CI job**

`.github/workflows/command-center.yml`:

```yaml
name: Command Center

# Dev package for the Command Center UI (command-center/): installs it frozen,
# runs its tests and typecheck, rebuilds the UI, and fails when the committed
# bundle in core/command-center/ui differs from a fresh build.
on:
  pull_request:
    branches: [main]
    paths:
      - 'command-center/**'
      - 'core/command-center/**'
      - 'core/tools/aidlc-dashboard.ts'
      - '.github/workflows/command-center.yml'
  push:
    branches: [main]
    paths:
      - 'command-center/**'
      - 'core/command-center/**'
      - 'core/tools/aidlc-dashboard.ts'
      - '.github/workflows/command-center.yml'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: command-center-${{ github.ref }}
  cancel-in-progress: true

jobs:
  command-center:
    name: Command Center (test + typecheck + bundle freshness)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: command-center
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: '.bun-version'
      - run: bun install --frozen-lockfile
      - run: bun test
      - run: bun run typecheck
      - run: bun run build:ui
      - name: Committed UI bundle matches a fresh build
        run: git diff --exit-code -- ../core/command-center/ui || { echo "::error::Rebuild the UI: (cd command-center && bun run build:ui) and commit core/command-center/ui"; exit 1; }
```

Before committing, copy the action SHA pins and `bun-version` from an existing workflow in `.github/workflows/` (for example `grep -h "setup-bun\|actions/checkout\|bun-version" .github/workflows/*.yml | sort -u`) so the pins match the repo's current ones.

- [ ] **Step 7: Commit**

```bash
printf 'command-center/node_modules/\n' >> .gitignore
git add command-center core/command-center/ui .github/workflows/command-center.yml .gitignore
git commit -m "feat(dashboard): add the Command Center UI dev package and its prebuilt bundle"
```

### Task 3: Launcher `core/tools/aidlc-dashboard.ts`

**Files:**
- Create: `core/tools/aidlc-dashboard.ts`
- Test: `tests/unit/t2660-dashboard-launcher.test.ts`

**Interfaces:**
- Consumes: `startServer`, `loadConfig`, `saveConfig`, `CONFIG_PATH`, and `Config` from Task 1; `resolveHarnessPath` from `core/tools/aidlc-runtime-paths.ts`.
- Produces: `export function parseArgs(argv: string[]): LaunchArgs`, `export async function applyLaunch(cfg: Config, a: LaunchArgs, cwd: string): Promise<boolean>`, `export function uiDirectory(): string | null`, and `export async function main(argv: string[], deps?: Partial<Deps>): Promise<void>`, where `Deps = { start: typeof startServer; open: (url: string) => void; uiDir: () => string | null; cwd: () => string; out: (s: string) => void; err: (s: string) => void }`.

- [ ] **Step 1: Write the failing tests**

```ts
// covers: tool:aidlc-dashboard, function:parseArgs, function:applyLaunch, function:main
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLaunch, main, parseArgs } from "../../core/tools/aidlc-dashboard.ts";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "aidlc-dash-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); process.exitCode = 0; });
const cfg = () => ({ version: 1 as const, roots: [] as string[], pins: [] as string[], hidden: [] as string[] });

describe("parseArgs", () => {
  test("defaults: ephemeral port, opens browser", () => {
    const a = parseArgs([]);
    expect(a.port).toBe(0);
    expect(a.open).toBe(true);
    expect(a.json).toBe(false);
  });
  test("dispatcher verb is skipped; flags parse; roots and pins repeat", () => {
    const a = parseArgs(["dashboard", "--port", "4381", "--no-open", "--json", "--root", "/a", "--root", "/b", "--pin", "/c"]);
    expect(a).toMatchObject({ port: 4381, open: false, json: true, roots: ["/a", "/b"], pins: ["/c"] });
  });
  test("bad port and unknown flag throw", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow("--port must be an integer 0-65535");
    expect(() => parseArgs(["--port"])).toThrow("--port needs a value");
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument --bogus");
  });
  test("global dispatcher flags are ignored, --project-dir sets cwd", () => {
    const a = parseArgs(["--no-color", "--project-dir", "/p"]);
    expect(a.projectDir).toBe("/p");
  });
});

describe("applyLaunch", () => {
  test("auto-pins cwd when it is an AI-DLC workspace not yet covered", async () => {
    const here = temp(); mkdirSync(join(here, "aidlc")); writeFileSync(join(here, "aidlc", "active-space"), "default\n");
    const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(true);
    expect(c.pins).toEqual([here]);
  });
  test("does not pin a plain folder or one under a saved root", async () => {
    const here = temp(); const c = cfg();
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(false);
    mkdirSync(join(here, "aidlc")); writeFileSync(join(here, "aidlc", "active-space"), "default\n");
    c.roots.push(join(here, ".."));
    expect(await applyLaunch(c, parseArgs([]), here)).toBe(false);
  });
});

describe("main", () => {
  const capture = () => { const o = { out: "", err: "" }; return { o, out: (s: string) => { o.out += s; }, err: (s: string) => { o.err += s; } }; };
  test("bad argument prints usage and exits 2", async () => {
    const c = capture();
    await main(["--bogus"], { out: c.out, err: c.err });
    expect(c.o.err).toContain("aidlc dashboard: unknown argument --bogus");
    expect(c.o.err).toContain("Usage:");
    expect(process.exitCode).toBe(2);
  });
  test("missing UI bundle is a named error, exit 1", async () => {
    const c = capture();
    await main(["--no-open", "--config", join(temp(), "d.json")], { out: c.out, err: c.err, uiDir: () => null });
    expect(c.o.err).toContain("the Command Center UI bundle is missing from this install");
    expect(process.exitCode).toBe(1);
  });
  test("--json prints {url, port} and passes uiDir and port to the server", async () => {
    const c = capture(); let seen: { port?: number; uiDir?: string } = {};
    const start = (async (o: { port?: number; uiDir?: string }) => { seen = o; return { url: "http://127.0.0.1:5/?t=x", port: 5, token: "x", hub: null, stop() {} }; }) as never;
    await main(["--json", "--no-open", "--port", "0", "--config", join(temp(), "d.json")], { out: c.out, err: c.err, uiDir: () => "/ui", start, cwd: () => temp(), keepAlive: false });
    expect(JSON.parse(c.o.out.trim())).toEqual({ url: "http://127.0.0.1:5/?t=x", port: 5 });
    expect(seen).toMatchObject({ port: 0, uiDir: "/ui" });
  });
  test("server start failure exits 1 with the reason", async () => {
    const c = capture();
    const start = (async () => { throw new Error("port 4381 is in use"); }) as never;
    await main(["--no-open", "--config", join(temp(), "d.json")], { out: c.out, err: c.err, uiDir: () => "/ui", start, cwd: () => temp() });
    expect(c.o.err).toContain("Could not start the Command Center: port 4381 is in use");
    expect(process.exitCode).toBe(1);
  });
});
```

`keepAlive: false` is a test-only `Deps` field. It makes `main` return after printing instead of installing signal handlers and waiting forever. Add it to `Deps` (default `true`).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/unit/t2660-dashboard-launcher.test.ts`
Expected: FAIL, "Cannot find module ../../core/tools/aidlc-dashboard.ts".

- [ ] **Step 3: Implement the launcher**

```ts
#!/usr/bin/env bun
// aidlc dashboard: opens the AI-DLC Command Center, a read-only live view of
// the AI-DLC workspaces on this machine. The server runs in this process and
// listens on 127.0.0.1 only; the UI bundle ships in <harnessDir>/command-center/ui.
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CONFIG_PATH, type Config, loadConfig, saveConfig } from "../command-center/server/config.ts";
import { startServer } from "../command-center/server/index.ts";
import { resolveHarnessPath } from "./aidlc-runtime-paths.ts";

export interface LaunchArgs {
  port: number; open: boolean; json: boolean; help: boolean;
  roots: string[]; pins: string[]; config: string; projectDir: string | null;
}

const USAGE = "Usage: aidlc dashboard [--port <n>] [--no-open] [--json] [--root <dir>]... [--pin <dir>]... [--config <file>]";
// Global dispatcher flags that mean nothing to a local server.
const IGNORED = new Set(["--no-color", "--quiet", "--yes", "--offline", "--verbose"]);

export function parseArgs(argv: string[]): LaunchArgs {
  const o: LaunchArgs = { port: 0, open: true, json: false, help: false, roots: [], pins: [],
    config: process.env.AIDLC_DASHBOARD_CONFIG ?? CONFIG_PATH, projectDir: null };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "dashboard" && i === 0) continue;
    if (IGNORED.has(a)) continue;
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

const covers = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Folds --root/--pin into cfg and auto-pins cwd when it is an AI-DLC workspace
// that no saved root or pin covers. Returns whether cfg changed.
export async function applyLaunch(cfg: Config, a: LaunchArgs, cwd: string): Promise<boolean> {
  let changed = false;
  for (const r of a.roots) if (!cfg.roots.includes(r)) { cfg.roots.push(r); changed = true; }
  for (const p of a.pins) if (!cfg.pins.includes(p)) { cfg.pins.push(p); changed = true; }
  const here = resolve(cwd);
  if (existsSync(join(here, "aidlc", "active-space")) && !cfg.pins.includes(here) && !cfg.roots.some((r) => covers(resolve(r), here))) {
    cfg.pins.push(here); changed = true;
  }
  return changed;
}

// The shipped UI bundle, or null when this install lacks it.
export function uiDirectory(): string | null {
  const dir = resolveHarnessPath(["command-center", "ui"]);
  return existsSync(join(dir, "index.html")) ? dir : null;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }); } catch { /* no opener; the URL is printed */ }
}

type Deps = {
  start: typeof startServer; open: (url: string) => void; uiDir: () => string | null; cwd: () => string;
  out: (s: string) => void; err: (s: string) => void; keepAlive: boolean;
};

export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<void> {
  const d: Deps = { start: startServer, open: openBrowser, uiDir: uiDirectory, cwd: () => process.cwd(),
    out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), keepAlive: true, ...deps };
  let a: LaunchArgs;
  try { a = parseArgs(argv); } catch (e) {
    d.err(`aidlc dashboard: ${(e as Error).message}\n${USAGE}\n`); process.exitCode = 2; return;
  }
  if (a.help) { d.out(`Open the AI-DLC Command Center, a read-only local view of your AI-DLC workspaces.\n${USAGE}\nIt serves on 127.0.0.1 until stopped (Ctrl-C).\n`); return; }
  const uiDir = d.uiDir();
  if (uiDir === null) {
    d.err("aidlc dashboard: the Command Center UI bundle is missing from this install. Reinstall AI-DLC, or run `aidlc doctor`.\n");
    process.exitCode = 1; return;
  }
  const cfg = await loadConfig(a.config);
  if (await applyLaunch(cfg, a, a.projectDir ?? d.cwd())) {
    await saveConfig(cfg, a.config).catch((e) => d.err(`aidlc dashboard: settings not saved: ${(e as Error).message}\n`));
  }
  let s: Awaited<ReturnType<typeof startServer>>;
  try { s = await d.start({ port: a.port, config: cfg, configPath: a.config, uiDir }); } catch (e) {
    d.err(`Could not start the Command Center: ${(e as Error).message}\n`); process.exitCode = 1; return;
  }
  d.out(a.json ? `${JSON.stringify({ url: s.url, port: s.port })}\n` : `AI-DLC Command Center → ${s.url}\nPress Ctrl-C to stop.\n`);
  if (a.open) d.open(s.url);
  if (!d.keepAlive) { s.stop(); return; }
  await new Promise<void>((done) => {
    const quit = () => { s.stop(); done(); };
    process.once("SIGINT", quit); process.once("SIGTERM", quit);
  });
  process.exitCode = 0;
}

if (import.meta.main) void main(process.argv.slice(2));
```

If `loadConfig` throws `ConfigUnreadableError`, catch it in `main`, print `aidlc dashboard: <message>`, and exit 1. Add a test for it in Step 1 when you see how the error reads.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/unit/t2660-dashboard-launcher.test.ts && bunx tsc --noEmit -p tsconfig.json && bunx biome check --error-on-warnings core/tools/aidlc-dashboard.ts tests/unit/t2660-dashboard-launcher.test.ts`
Expected: PASS, with no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add core/tools/aidlc-dashboard.ts tests/unit/t2660-dashboard-launcher.test.ts
git commit -m "feat(dashboard): add the aidlc dashboard launcher"
```

### Task 4: Register the `dashboard` route in the dispatcher

**Files:**
- Modify: `core/tools/aidlc.ts` (Route type, TOOLS, PUBLIC_COMMANDS, HUMAN_TOP_ROUTE_IDS, ROUTES, help rendering, COMMAND_HELP_USAGE, descriptions/examples, DELEGATES, SIMPLE_PUBLIC_GRAMMARS + repeatable flags)
- Modify: `core/tools/aidlc-utility.ts` (help-text Utilities list)
- Test: `tests/unit/t2661-dashboard-route.test.ts`

**Interfaces:**
- Consumes: `main(argv)` from Task 3.
- Produces: route `top-dashboard`; `export function routeLifetime(route: Route): "bounded" | "long-lived"`.

- [ ] **Step 1: Write the failing test**

```ts
// covers: tool:aidlc, route:top-dashboard
import { describe, expect, test } from "bun:test";
import { listRoutes, PUBLIC_COMMANDS, renderCommandHelp, renderHumanHelp, routeLifetime } from "../../core/tools/aidlc.ts";

describe("dashboard route", () => {
  const route = listRoutes().find((r) => r.id === "top-dashboard");
  test("is public, forbids outbound network, writes machine scope, is long-lived", () => {
    expect(route).toBeDefined();
    expect(route?.verbs).toEqual(["dashboard"]);
    expect(route?.tool).toBe("aidlc-dashboard.ts");
    expect(route?.visibility).toBe("public");
    expect(route?.networkPolicy).toBe("forbidden");
    expect(route?.mutationScope).toBe("machine");
    expect(routeLifetime(route!)).toBe("long-lived");
  });
  test("every other route stays bounded", () => {
    for (const r of listRoutes()) if (r.id !== "top-dashboard") expect(routeLifetime(r)).toBe("bounded");
  });
  test("appears in public commands and help", () => {
    expect(PUBLIC_COMMANDS).toContain("dashboard");
    expect(renderHumanHelp()).toContain("dashboard");
    expect(renderCommandHelp("dashboard")).toContain("aidlc dashboard [--port <n>]");
  });
});
```

Then add dispatcher-level cases to the same file. Run the dispatcher as a subprocess (`bun core/tools/aidlc.ts dashboard --port 99999`), the same way `tests/unit/t230-dispatcher-routes.test.ts` does (read that file first and reuse its spawn helper), and assert:
- exit 2 and stderr `--port must be an integer 0-65535`;
- `--root a --root b` is accepted by the grammar, so the error is about something else, not "may be specified only once";
- `dashboard --help` exits 0 and prints `Usage: aidlc dashboard`.

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test tests/unit/t2661-dashboard-route.test.ts`
Expected: FAIL, `route` undefined or `routeLifetime` not exported.

- [ ] **Step 3: Implement**

Apply these edits to `core/tools/aidlc.ts`. The reference diff is `git diff 5169fb592 feature/aidlc-command-center -- core/tools/aidlc.ts`. Apply it by hand, because line numbers have moved on `main`.
1. `type Lifetime = "bounded" | "long-lived";` with a comment, and `lifetime?: Lifetime;` on `Route`.
2. `dashboard: "aidlc-dashboard.ts",` in `TOOLS`; `"dashboard"` in `PUBLIC_COMMANDS` after `"doctor"`; `"top-dashboard"` in `HUMAN_TOP_ROUTE_IDS`.
3. The route entry after `top-doctor`:

```ts
  {
    id: "top-dashboard",
    namespace: "public",
    group: "top",
    kind: "top-passthrough",
    classification: "passthrough",
    verbs: ["dashboard"],
    tool: TOOLS.dashboard,
    visibility: "public",
    projectRequirement: "optional",
    pinPolicy: "active",
    // Serves on 127.0.0.1 only; the Command Center makes no outbound requests.
    networkPolicy: "forbidden",
    // Writes only its own settings file, ~/.aidlc/dashboard.json.
    mutationScope: "machine",
    lifetime: "long-lived",
    outputModes: ["human", "json"],
    human: [{ command: "dashboard", summary: "open the local Command Center for your AI-DLC workspaces" }],
    all: ["dashboard [--port <n>] [--no-open] [--json] [--root <dir>] [--pin <dir>] [--config <file>]"],
  },
```

4. `export function routeLifetime(route: Route): Lifetime { return route.lifetime ?? "bounded"; }` beside `listRoutes`.
5. In `renderHumanHelp`, a `WATCH YOUR WORK` heading with `row("dashboard", "Open the local Command Center for your AI-DLC workspaces")`, before `MANAGE THE MACHINE INSTALL`.
6. `COMMAND_HELP_USAGE.dashboard`, `descriptions.dashboard`, and `examples.dashboard` (`dashboard` and `dashboard --root ~/code --no-open`).
7. `"aidlc-dashboard.ts": () => import("./aidlc-dashboard.ts"),` in `DELEGATES`.
8. `SimplePublicGrammar.repeatable?: ReadonlySet<string>`; a `dashboard` grammar (values `--config --pin --port --project-dir --root`, bare `--json --no-color --no-open`, repeatable `--pin --root`); the `seen` check skips repeatable flags; and the `--port` range check for `dashboard`.
9. If the dispatcher applies a subprocess timeout to delegated tools, skip it when `routeLifetime(route) === "long-lived"`. Find out with `grep -n "timeout" core/tools/aidlc.ts | grep -i "spawn\|delegate"`. If there is none, the field stays declarative and the test above is its guard.

In `core/tools/aidlc-utility.ts`, add `  dashboard         Open the read-only Command Center for your AI-DLC workspaces` after the `--status` line in `HELP_TEXT_TAIL`.

- [ ] **Step 4: Run the route tests and the dispatcher suite**

Run: `bun test tests/unit/t2661-dashboard-route.test.ts tests/unit/t230-dispatcher-routes.test.ts`
Expected: t2661 passes. In t230, compare failures against a clean `origin/main` run (`git stash`-free: run it in a scratch `git worktree add /tmp/... origin/main`). Only pre-existing failures may remain. Any new t230 failure is a pin you must update (for example a public-command list or route-count snapshot): update the pin, never weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add core/tools/aidlc.ts core/tools/aidlc-utility.ts tests/unit/t2661-dashboard-route.test.ts tests/unit/t230-dispatcher-routes.test.ts
git commit -m "feat(dashboard): register aidlc dashboard as a public long-lived route"
```

### Task 5: Project `command-center` into every harness tree

**Files:**
- Modify: `harness/{claude,kiro,kiro-ide,codex,cursor,opencode,copilot}/manifest.ts` (`coreDirs`)
- Test: `tests/unit/t2662-dashboard-packaging.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// covers: script:package, coreDir:command-center
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../../dist");
const HARNESS_DIRS: Record<string, string> = { claude: ".claude", kiro: ".kiro", "kiro-ide": ".kiro", codex: ".codex", cursor: ".cursor", opencode: ".aidlc", copilot: ".aidlc" };

describe("command-center projection", () => {
  for (const [harness, dir] of Object.entries(HARNESS_DIRS)) {
    test(`${harness} ships the launcher, server and UI bundle`, () => {
      const root = join(DIST, harness, dir);
      expect(existsSync(join(root, "tools", "aidlc-dashboard.ts"))).toBe(true);
      expect(existsSync(join(root, "command-center", "server", "index.ts"))).toBe(true);
      expect(existsSync(join(root, "command-center", "ui", "index.html"))).toBe(true);
      expect(readdirSync(join(root, "command-center", "ui", "assets")).length).toBeGreaterThan(0);
    });
  }
});
```

Before running, confirm each harness's engine dir name in its `manifest.ts` (`harnessDir:`), and correct `HARNESS_DIRS`. Copilot and opencode may differ from the guess above. If the repo has a helper that lists harnesses and their dirs (`grep -rn "harnessDir" tests/harness | head`), use it instead of the literal map.

- [ ] **Step 2: Run and confirm it fails**

Run: `bun scripts/package.ts > /tmp/pkg.log 2>&1; bun test tests/unit/t2662-dashboard-packaging.test.ts`
Expected: FAIL on `command-center/server/index.ts` for every harness.

- [ ] **Step 3: Add the coreDirs entry**

In each of the 7 manifests, add `{ src: "command-center", dst: "command-center" },` to `coreDirs` after `{ src: "hooks", dst: "hooks" }` (or the equivalent position). Check that the packager does not rewrite `.js` or `.css` files (token substitution should only touch `.md`). If it does, `grep -n "HARNESS_DIR" scripts/package.ts` shows which extensions it substitutes. Bundle files contain no `{{` tokens, so substitution would be a no-op, but confirm it.

- [ ] **Step 4: Package, check determinism, and test**

```bash
bun scripts/package.ts > /tmp/pkg.log 2>&1 && tail -3 /tmp/pkg.log
bun scripts/package.ts --check > /tmp/pkgcheck.log 2>&1 && tail -3 /tmp/pkgcheck.log
bun test tests/unit/t2662-dashboard-packaging.test.ts
```

Expected: package succeeds, `--check` reports byte-identical builds, and the test passes. Then run `bash tests/run-tests.sh --help` and run the test(s) that pin projected file lists or core dir names (`grep -rln "coreDirs\|skills/aidlc-knowledge" tests/unit | head`). Update the pins they hold.

- [ ] **Step 5: Commit**

```bash
git add harness/*/manifest.ts tests/unit/t2662-dashboard-packaging.test.ts tests/unit
git commit -m "feat(dashboard): project the Command Center into every harness tree"
```

### Task 6: `/aidlc dashboard` in every harness skill

**Files:**
- Modify: `harness/{claude,codex,copilot,cursor,kiro,kiro-ide,opencode}/skills/aidlc/SKILL.md`
- Modify: `harness/claude/skills/aidlc/SKILL.md` frontmatter `argument-hint`; `harness/opencode/command/aidlc.md` description
- Test: `tests/unit/t2663-dashboard-skill-routing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// covers: skill:aidlc, utility:dashboard
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];
const ROOT = join(import.meta.dir, "../..");

describe("/aidlc dashboard skill routing", () => {
  for (const h of HARNESSES) {
    test(`${h} SKILL.md routes dashboard before next`, () => {
      const skill = readFileSync(join(ROOT, "harness", h, "skills", "aidlc", "SKILL.md"), "utf8");
      const para = skill.indexOf("**Opening the Command Center (`/aidlc dashboard`).**");
      expect(para).toBeGreaterThan(-1);
      expect(skill).toContain("{{INVOKE}} dashboard");
      expect(skill).toContain("do not run `next`");
      expect(para).toBeLessThan(skill.indexOf("Each `next` returns"));
    });
  }
  test("claude argument hint lists dashboard", () => {
    const skill = readFileSync(join(ROOT, "harness", "claude", "skills", "aidlc", "SKILL.md"), "utf8");
    expect(skill).toMatch(/argument-hint: "[^"]*\| dashboard \|/);
  });
});
```

If a harness's skill names `next` differently (Codex's `$aidlc`), the paragraph wording differs but the asserted substrings must still hold.

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test tests/unit/t2663-dashboard-skill-routing.test.ts`
Expected: FAIL for all 7.

- [ ] **Step 3: Add the paragraph**

Insert this paragraph, plus a blank line, immediately before the paragraph starting `Each \`next\` returns` in each SKILL.md. For Codex, replace "the arguments" with "the text after `$aidlc`". For other harnesses, match how that file names the user's arguments (read the `Pass ... through to the first \`next\`` sentence in that file).

```markdown
**Opening the Command Center (`/aidlc dashboard`).** When the arguments begin with the word `dashboard`, this is not workflow input and is the one exception to passing the arguments to `next`: do not run `next` and do not touch the workflow. Run `{{INVOKE}} dashboard` with any flags that followed the word (`--port <n>`, `--no-open`, `--root <dir>`, `--pin <dir>`) in the background, wait for its first line, and tell the person the printed URL; it serves until stopped (Ctrl-C, or stopping the background command). It only reads AI-DLC records, so nothing in the project changes. If it exits instead, relay its error line, then STOP.
```

Claude `argument-hint`: insert `dashboard | ` after `--status | `. opencode `command/aidlc.md`: insert `dashboard, ` after `--doctor, `. Check each other harness for a utility list in frontmatter (`grep -n "Utilities:\|argument-hint" harness/*/skills/aidlc/SKILL.md harness/*/command/*.md`), and add `dashboard` where one exists.

- [ ] **Step 4: Package and run the tests**

```bash
bun scripts/package.ts > /tmp/pkg.log 2>&1 && bun scripts/package.ts --check > /tmp/pkgcheck.log 2>&1 && tail -2 /tmp/pkgcheck.log
bun test tests/unit/t2663-dashboard-skill-routing.test.ts
grep -rln "skill-text\|SKILL.md" tests/unit | head   # find skill snapshot/budget tests and run them
```

Expected: pass. If a skill size-budget or snapshot test fails, update the snapshot or budget with a one-line justification in the commit message. Do not shorten other prose.

- [ ] **Step 5: Commit**

```bash
git add harness tests/unit
git commit -m "feat(dashboard): route /aidlc dashboard in every harness skill"
```

### Task 7: End-to-end launch test and the no-AI/no-network guard

**Files:**
- Test: `tests/integration/t2664-dashboard-launch.test.ts`
- Test: `tests/unit/t2665-dashboard-no-network.test.ts`

- [ ] **Step 1: Write the no-network guard**

```ts
// covers: dir:command-center, policy:no-ai-no-network
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../core/command-center");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : [p]; });
// Outbound-network and model-SDK markers. Loopback serving uses Bun.serve and
// is allowed; the UI talks only to its own origin with relative /api URLs.
const BANNED = [/\bfetch\(\s*["'`]https?:\/\//, /new WebSocket\(\s*["'`]wss?:\/\//, /@anthropic-ai\//, /\bopenai\b/, /bedrock-runtime/, /node:https\b/, /from "https"/, /navigator\.sendBeacon/];

describe("Command Center makes no AI or outbound network calls", () => {
  for (const f of files(ROOT).filter((p) => /\.(ts|js|html)$/.test(p))) {
    test(f.slice(ROOT.length + 1), () => {
      const src = readFileSync(f, "utf8");
      for (const re of BANNED) expect({ file: f, hit: re.test(src) ? re.source : null }).toEqual({ file: f, hit: null });
    });
  }
  test("server binds loopback only", () => {
    const idx = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    expect(idx).toContain('hostname: "127.0.0.1"');
    for (const f of files(join(ROOT, "server"))) expect(readFileSync(f, "utf8")).not.toMatch(/0\.0\.0\.0|"::"|hostname:\s*""/);
  });
});
```

Run it: `bun test tests/unit/t2665-dashboard-no-network.test.ts`. Expected: PASS. A hit in the minified bundle that comes from React's own source (for example a `https://react.dev/errors/` string inside an error message, not a `fetch`) does not match these patterns. If a real hit appears, report it and stop.

- [ ] **Step 2: Write the launch integration test**

```ts
// covers: tool:aidlc-dashboard, route:top-dashboard, integration:launch
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
let work = ""; let proc: ReturnType<typeof Bun.spawn> | null = null; let url = ""; let port = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "aidlc-dash-it-"));
  const proj = join(work, "proj");
  const intent = join(proj, "aidlc", "spaces", "default", "intents", "261101-demo");
  mkdirSync(join(intent, "audit"), { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), "default\n");
  writeFileSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), "261101-demo\n");
  writeFileSync(join(intent, "aidlc-state.md"), "# AI-DLC State\n\n**Scope**: feature\n**Current Phase**: inception\n**Current Stage**: requirements-analysis\n");
  // Run the projected dispatcher, as an install would.
  proc = Bun.spawn(["bun", join(REPO, "dist/claude/.claude/tools/aidlc.ts"), "dashboard", "--json", "--no-open", "--port", "0", "--config", join(work, "dash.json")],
    { cwd: proj, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: work } });
  const reader = proc.stdout.getReader(); let buf = "";
  while (!buf.includes("\n")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
  reader.releaseLock();
  ({ url, port } = JSON.parse(buf.split("\n")[0] as string));
}, 30_000);

afterAll(() => { proc?.kill("SIGTERM"); rmSync(work, { recursive: true, force: true }); });

describe("aidlc dashboard launch", () => {
  test("prints {url, port} on loopback", () => {
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?t=[A-Za-z0-9_-]{32}$`));
  });
  test("token gates the page", async () => {
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
  });
  test("foreign Host is refused (DNS rebinding)", async () => {
    const r = await fetch(url, { headers: { host: `evil.example:${port}` } });
    expect(r.status).toBe(421);
  });
  test("CSP and nosniff headers are set", async () => {
    const r = await fetch(url);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  test("the auto-pinned project is discovered", async () => {
    const token = new URL(url).searchParams.get("t")!;
    const body = await (await fetch(`http://127.0.0.1:${port}/api/home?t=${token}`)).text();
    expect(body).toContain("261101-demo");
  });
  test("SIGTERM stops it with exit 0", async () => {
    proc!.kill("SIGTERM");
    expect(await proc!.exited).toBe(0);
  });
});
```

Before running, read `core/command-center/server/http.ts` to get the real home/listing endpoint (the plan guesses `/api/home`) and the minimal `aidlc-state.md` fields discovery needs. Copy them from the app's `tests/fixtures/make.ts`. Add the 403-outside-root and SSE tests the same way: read `server.security.test.ts` and `live.test.ts` in `command-center/tests` and lift one case each, pointing them at this live process. If Bun's `fetch` drops a custom `host` header, use `node:http` `request` with an explicit `headers.host` for the 421 case.

- [ ] **Step 3: Run it**

Run: `bun scripts/package.ts > /tmp/pkg.log 2>&1; bun test tests/integration/t2664-dashboard-launch.test.ts`
Expected: PASS.

- [ ] **Step 4: Confirm the live listener is loopback (builder-security check)**

```bash
bun dist/claude/.claude/tools/aidlc.ts dashboard --no-open --port 4399 --config /tmp/cc-check.json & PID=$!; sleep 2
lsof -nP -iTCP:4399 -sTCP:LISTEN; kill $PID
```

Expected: one `LISTEN` line on `127.0.0.1:4399`, with no `*:4399`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/t2664-dashboard-launch.test.ts tests/unit/t2665-dashboard-no-network.test.ts
git commit -m "test(dashboard): end-to-end launch and no-network guards"
```

### Task 8: Documentation

**Files:**
- Create: `docs/guide/command-center.md`
- Modify: `docs/guide/12-cli-commands.md`, `docs/guide/00-introduction.md` (or the guide index), `docs/guide/glossary.md`, `docs/reference/01-architecture.md`, `README.md`, `AGENTS.md`, `core/templates/onboarding.md` (if it lists utilities), `DEVELOPERS.md`
- Possibly modify: `zensical.toml` nav

- [ ] **Step 1: Write the guide page**

`docs/guide/command-center.md` has these sections: what it is (one paragraph); opening it (`/aidlc dashboard`, `aidlc dashboard`); what you see (home, intent page with Timeline / Decisions / Artifacts / Reviews / Learnings / Issues / Tokens); adding folders (Workspaces & settings, `--root`, `--pin`, settings file `~/.aidlc/dashboard.json`, `AIDLC_DASHBOARD_CONFIG`); flags table (copy spec §4.1); privacy and security (loopback only, per-run link, read-only, no AI and no network, token data is Claude-only); stopping it; troubleshooting (UI bundle missing → reinstall; port in use → `--port 0`). Use the reference copy `git show feature/aidlc-command-center:docs/guide/command-center.md` for structure, but rewrite to match this build. Use no screenshots of real data. Screenshots are optional, and only from synthetic fixtures.

- [ ] **Step 2: Update references**

- `docs/guide/12-cli-commands.md`: a `dashboard` entry with usage and flags.
- `README.md`: increment the tool count by one (verify with `ls core/tools/aidlc-*.ts | wc -l`), and add one line about `/aidlc dashboard`.
- `AGENTS.md` (`core/` bullet): add "the Command Center server and UI bundle (`command-center/`)". Add a `command-center/` bullet to Project Structure, and say it is the dev-only package.
- `docs/reference/01-architecture.md`: add the `command-center` core dir and the `lifetime` route field.
- `docs/guide/glossary.md`: add a Command Center row.
- `DEVELOPERS.md`: how to rebuild the UI (`cd command-center && bun install && bun run build:ui`) and that the bundle is committed.
- Onboarding templates: if `core/templates/onboarding*.md` lists `/aidlc` utilities, add `/aidlc dashboard`, then rerun `bun scripts/package.ts`.
- `zensical.toml`: add the new guide page to the nav if guide pages are listed there.

Then grep for stale or missing references: `grep -rn "aidlc --doctor\b" docs/guide/12-cli-commands.md | head -3` (for format), and `grep -rn "dashboard" docs README.md AGENTS.md | grep -v command-center.md`.

- [ ] **Step 3: Run doc tests**

Run: `grep -rln "docs/guide\|README" tests/unit | head` and run those tests (doc link checks, tool-count pins), plus `bun test tests/unit/t68-version-changelog-sync.test.ts`.
Expected: pass. CHANGELOG is untouched.

- [ ] **Step 4: Commit**

```bash
git add docs README.md AGENTS.md DEVELOPERS.md core/templates zensical.toml
git commit -m "docs(dashboard): document the Command Center and aidlc dashboard"
```

### Task 9: Full verification and history scrub

- [ ] **Step 1: Full checks**

```bash
bun run check > /tmp/check.log 2>&1; tail -20 /tmp/check.log
bash tests/run-tests.sh --help | head -30
bash tests/run-tests.sh <smoke+unit+integration level per --help> > /tmp/tests.log 2>&1; tail -40 /tmp/tests.log
(cd command-center && bun test && bun run typecheck)
```

Compare every failure against the same run on clean `origin/main` (in a scratch worktree). Only failures that also fail on main are acceptable, and each is listed in the PR. Anything else gets fixed.

- [ ] **Step 2: Exposure sweep (builder-security)**

```bash
git diff origin/main --name-only | xargs grep -nE '0\.0\.0\.0|\[::\]|"::"|--host|listen\(' 2>/dev/null
```

Expected: no hits, or only comments and tests asserting their absence.

- [ ] **Step 3: Private-data scrub over the whole branch**

```bash
git log origin/main..HEAD --format='%an %ae%n%B' | sort -u
git diff origin/main | grep -nP '<private path, user, or internal host patterns>'
```

Expected: the author line only, and no diff hits. Fix any hit by amending the commit that introduced it, before any push.

- [ ] **Step 4: Report**

Summarize the results for the person: tests run and their counts, known pre-existing failures, `--check` result, the sweep results, and the branch commit list. Do not push. Pushing, the RFC issue, and the draft PR wait for the person's explicit go-ahead on the drafted texts.

// covers: file:tests/harness/tui-drive.ts, file:tests/harness/kiro-ide-driver.ts
// Synthetic children and loopback sockets only: no Claude, tmux, or IDE launch.

import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { PassThrough } from "node:stream";
import {
  kiroIdeDebugPort,
  KIRO_INTENT_JSON_COMMAND_TEXT,
  KIRO_REPORT_COMMAND_TEXT,
  launchKiroIde,
  teardown,
  withKiroIdeCleanup,
  type KiroIdeHandle,
  type KiroIdeLaunchRuntime,
} from "../harness/kiro-ide-driver.ts";
import {
  acceptTuiFixturePermissionMode, claudeModelUpgradeNavigation, claudePermissionNavigation,
  preseedClaudeOnboarding, TUI_TEST_FIXTURE_MARKER,
} from "../harness/tui-drive.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const root = process.env.AIDLC_TEST_WORKER_ROOT ??
    resolve(import.meta.dir, "../../tmp/e2e-driver-isolation");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "synthetic-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Claude onboarding profile isolation", () => {
  test("permission-mode acceptance follows the painted choice in owned fixtures", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-tui-")));
    scratchDirs.push(dir);
    writeFileSync(join(dir, TUI_TEST_FIXTURE_MARKER), JSON.stringify({ cwd: dir, ownerPid: process.pid }));
    const no = "WARNING: Bypass Permissions mode\n❯ No, exit\n  Yes, I accept";
    const yes = "WARNING: Bypass Permissions mode\n  No, exit\n❯ Yes, I accept";
    expect(claudePermissionNavigation(no)).toBe("Down");
    expect(claudePermissionNavigation(yes)).toBe("Enter");
    expect(claudePermissionNavigation("Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept")).toBe("Down");
    expect(claudePermissionNavigation("bypass permissions on\n❯ No, exit\nYes, I accept")).toBeNull();
    let current = no;
    let now = 0;
    const keys: string[] = [];
    const backend = {
      fixtureCwd: () => dir,
      capture: () => current,
      send: (_session: string, key: string, _literal: boolean, noEnter: boolean) => {
        expect(noEnter).toBe(true);
        keys.push(key);
        if (key === "Down") current = yes;
        else expect(current).toBe(yes);
      },
    };
    expect(await acceptTuiFixturePermissionMode(backend, "fixture", no, {
      now: () => now, sleep: async (ms) => { now += ms; },
    })).toBe(true);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(await acceptTuiFixturePermissionMode({ ...backend, fixtureCwd: () => null }, "fixture", no)).toBe(false);
  });

  test("model-upgrade navigation selects No and refuses ambiguous or ordinary workflow output", () => {
    const offer = [
      "Newer Opus model available", "Currently pinned: Opus 4.8", "Latest available: Opus 5",
      "Update settings to use Opus 5? Claude Code will restart to apply.",
    ].join("\n");
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n  2. No`)).toBe("Down");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. No\n❯ 2. Yes`)).toBe("Up");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. Yes\n❯ 2. No`)).toBe("Enter");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. Yes\n  2. No`)).toBeNull();
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n❯ 2. No`)).toBeNull();
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n  2. No\n[AIDLC] stage`)).toBeNull();
    expect(claudeModelUpgradeNavigation("Approve this workflow?\n❯ 1. Yes\n  2. No")).toBeNull();
  });

  test("first-run preparation can preserve the interactive project trust dialog", () => {
    const dir = scratch();
    const profile = join(dir, "profile");
    const home = join(dir, "untouched-home");
    preseedClaudeOnboarding("/fixture", { CLAUDE_CONFIG_DIR: profile }, home, false);
    expect(json(join(profile, ".claude.json"))).toEqual({ hasCompletedOnboarding: true });
    expect(existsSync(home)).toBe(false);
  });

  test("separate explicit profiles preserve their own settings and never write the host home", () => {
    const dir = scratch();
    const home = join(dir, "host");
    const first = join(dir, "worker-1", "claude");
    const second = join(dir, "worker-2", "claude");
    mkdirSync(home);
    mkdirSync(first, { recursive: true });
    const hostBytes = '{"hostOnly":true}\n';
    writeFileSync(join(home, ".claude.json"), hostBytes);
    writeFileSync(join(first, ".claude.json"), JSON.stringify({
      theme: "dark",
      projects: { "C:/existing": { hasTrustDialogAccepted: false, keep: true } },
    }));
    const env = Object.freeze({ CLAUDE_CONFIG_DIR: first, HOME: home, USERPROFILE: home });
    preseedClaudeOnboarding("C:\\fixture-one", env, home);
    preseedClaudeOnboarding("C:\\fixture-two", { CLAUDE_CONFIG_DIR: second }, home);
    preseedClaudeOnboarding("C:\\existing", env, home);

    expect(json(join(first, ".claude.json"))).toEqual({
      theme: "dark",
      hasCompletedOnboarding: true,
      projects: {
        "C:/existing": { hasTrustDialogAccepted: false, keep: true },
        "C:/fixture-one": { hasTrustDialogAccepted: true },
      },
    });
    expect(json(join(second, ".claude.json"))).toEqual({
      hasCompletedOnboarding: true,
      projects: { "C:/fixture-two": { hasTrustDialogAccepted: true } },
    });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(hostBytes);
    expect(readdirSync(home)).toEqual([".claude.json"]);
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
  });

  test("an explicit profile neither creates a home nor falls back to it on write failure", () => {
    const dir = scratch();
    const home = join(dir, "absent-home");
    const profile = join(dir, "config");
    preseedClaudeOnboarding("project", { CLAUDE_CONFIG_DIR: profile }, home);
    expect(existsSync(join(profile, ".claude.json"))).toBe(true);
    expect(existsSync(home)).toBe(false);

    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "untouched");
    preseedClaudeOnboarding("project", { CLAUDE_CONFIG_DIR: blocked }, home);
    expect(readFileSync(blocked, "utf8")).toBe("untouched");
    expect(existsSync(home)).toBe(false);
  });

  test("without an override the legacy home-level config is still seeded additively", () => {
    const home = scratch();
    writeFileSync(join(home, ".claude.json"), '{"theme":"light"}');
    preseedClaudeOnboarding("C:\\legacy", {}, home);
    expect(json(join(home, ".claude.json"))).toEqual({
      theme: "light",
      hasCompletedOnboarding: true,
      projects: { "C:/legacy": { hasTrustDialogAccepted: true } },
    });
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

/** No process is spawned. A real socket models Electron's continuous ownership
 *  of port 0; the emitted endpoint travels through the same stderr interface. */
class SyntheticChild extends EventEmitter {
  // An accidentally selected real OS signal path must not target a real PID.
  pid: number | undefined = Number.MAX_SAFE_INTEGER;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  server?: Server;
  port?: number;
  killSignals: NodeJS.Signals[] = [];
  private stopped?: Promise<void>;
  private closed = false;

  get child(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  finish(code = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.emit("exit", code, null);
    this.stderr.end();
    this.emit("close", code, null);
  }

  announce(port: number): void {
    this.announceEndpoint(`ws://127.0.0.1:${port}/devtools/browser/synthetic`);
  }

  announceEndpoint(url: string): void {
    this.stderr.write(`DevTools listening on ${url}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    void this.stop();
    return true;
  }

  listen(): void {
    const server = createServer();
    this.server = server;
    server.once("error", (error) => {
      this.emit("error", error);
      this.finish(1);
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      this.port = (server.address() as AddressInfo).port;
      this.announce(this.port);
    });
  }

  stop(): Promise<void> {
    this.stopped ??= new Promise<void>((done) => {
      if (this.server?.listening) {
        this.server.close(() => { this.finish(); done(); });
      } else {
        this.finish();
        done();
      }
    });
    return this.stopped;
  }
}

function fixture() {
  const root = scratch();
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "settings.json"), '{"seed":true}');
  // A copied profile may carry stale discovery/lock files. They must not be
  // consulted or copied into the profile of a new launch.
  writeFileSync(join(seed, "DevToolsActivePort"), "9222\n/devtools/browser/stale\n");
  writeFileSync(join(seed, "SingletonLock"), "stale-owner");
  return {
    root,
    seed,
    options: { workspace: root, seedProfile: seed, startupTimeoutMs: 2_000 },
    env: { AIDLC_TEST_WORKER_ROOT: root, AIDLC_TEST_WORKER_ID: "7", TEMP: root },
  };
}

async function bindResult(port: number): Promise<string | undefined> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => done(error.code));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => done(undefined));
    });
  });
}

function browserEndpoint(reply: "ok" | "error" | "silent" | "reject-connect" = "ok") {
  const requests: string[] = [];
  const commands: Array<{ id: number; method: string }> = [];
  let requested!: () => void;
  const requestReceived = new Promise<void>((resolveRequest) => { requested = resolveRequest; });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      requests.push(request.url);
      if (reply === "reject-connect") return new Response("not available", { status: 403 });
      if (new URL(request.url).pathname === "/devtools/browser/owned-browser" && server.upgrade(request)) return;
      return new Response("unrelated endpoint", { status: 404 });
    },
    websocket: {
      message(socket, data) {
        const command = JSON.parse(String(data));
        commands.push(command);
        if (reply !== "silent") socket.send(JSON.stringify({
          id: command.id,
          ...(reply === "ok" ? { result: {} } : { error: { message: "refused" } }),
        }));
        requested();
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/owned-browser`,
    requests, commands, requestReceived,
    stop: () => server.stop(true),
  };
}

function lifecycle(path: string): Array<{
  timestamp: string; event: string; phase: string; pid: number; elapsedMs: number;
}> {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("Kiro IDE port and profile ownership", () => {
  test("GUI routing detects both report command spellings without matching ordinary prose or other verbs", () => {
    for (const text of [
      "Running: bun .kiro/tools/aidlc-orchestrate.ts report --result completed",
      "Running: bun .kiro/tools/aidlc.ts engine orchestrate report --result completed",
      'bun ".kiro/tools/aidlc-orchestrate.ts"\nreport',
      'bun.exe ".kiro\\tools\\aidlc.ts" engine\norchestrate report',
    ]) expect(text).toMatch(KIRO_REPORT_COMMAND_TEXT);
    for (const text of [
      "Please report the intent status.",
      "bun .kiro/tools/aidlc.ts engine orchestrate next report",
      "bun .kiro/tools/aidlc.ts engine intent create --label report",
      "bun .kiro/tools/aidlc-orchestrate.ts reporting",
      "bun .kiro/tools/aidlc.ts engine orchestrate report-extra",
    ]) expect(text).not.toMatch(KIRO_REPORT_COMMAND_TEXT);
  });

  test("GUI routing detects equivalent intent JSON queries without rejecting creation or ordinary text", () => {
    for (const text of [
      "bun .kiro/tools/aidlc-utility.ts intent --json",
      "bun .kiro/tools/aidlc.ts engine intent list --json",
      "bun .kiro/tools/aidlc.ts engine intent --json",
      'bun ".kiro/tools/aidlc-utility.ts" intent\n--json',
      'bun.exe ".kiro\\tools\\aidlc.ts" engine intent list\n--json',
    ]) expect(text).toMatch(KIRO_INTENT_JSON_COMMAND_TEXT);
    for (const text of [
      "List the intent JSON query rules in the report.",
      "bun .kiro/tools/aidlc.ts engine intent create --json",
      "bun .kiro/tools/aidlc-utility.ts intent-create --json",
      "bun .kiro/tools/aidlc.ts engine intent list --jsonl",
      "bun .kiro/tools/aidlc.ts engine intent list --json-extra",
    ]) expect(text).not.toMatch(KIRO_INTENT_JSON_COMMAND_TEXT);
  });

  test.each(["win32", "linux"] as const)("%s keeps per-call profiles isolated when artifact paths are long", async (host) => {
    const { root, seed, options, env } = fixture();
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-kiro-temp-")));
    scratchDirs.push(temp);
    const longArtifacts = join(root, ...Array.from({ length: 6 }, (_, index) => `${index}-${"artifact".repeat(5)}`));
    // The simulated POSIX branch intentionally allocates under the long root.
    // Native Windows mkdtemp needs its long-path spelling for that fixture.
    const artifacts = host === "linux" && process.platform === "win32"
      ? win32.toNamespacedPath(longArtifacts) : longArtifacts;
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "keep.log"), "original diagnostics");
    const children: SyntheticChild[] = [];
    const handles: KiroIdeHandle[] = [];
    const launchEnvs: NodeJS.ProcessEnv[] = [];
    const profileRoot = host === "win32" ? temp : artifacts;
    try {
      for (let index = 0; index < 2; index++) {
        const child = new SyntheticChild();
        children.push(child);
        handles.push(await launchKiroIde(options, {
          platform: host,
          env: { ...env, AIDLC_TEST_WORKER_ROOT: artifacts, TEMP: temp, TMP: artifacts },
          spawn: (_bin, args, spawnOptions) => {
            launchEnvs.push(spawnOptions.env!);
            expect(args).toContain("--disable-workspace-trust");
            queueMicrotask(() => child.announce(43210 + index));
            return child.child;
          },
          terminate: (owned) => { expect(owned).toBe(child.child); void child.stop(); },
        }));
      }
      expect(artifacts.length).toBeGreaterThan(260);
      expect(handles.map(handle => dirname(handle.profileDir))).toEqual([profileRoot, profileRoot]);
      expect(handles[0].profileDir).not.toBe(handles[1].profileDir);
      writeFileSync(join(handles[0].profileDir, "settings.json"), '{"firstOnly":true}');
      expect(json(join(handles[1].profileDir, "settings.json"))).toEqual({ seed: true });
      expect(json(join(seed, "settings.json"))).toEqual({ seed: true });
      expect(launchEnvs.map(value => value.AIDLC_TEST_WORKER_ROOT)).toEqual([artifacts, artifacts]);
      await teardown(handles[0]);
      expect(existsSync(handles[0].profileDir)).toBe(false);
      expect(existsSync(handles[1].profileDir)).toBe(true);
      expect(readFileSync(join(artifacts, "keep.log"), "utf8")).toBe("original diagnostics");
    } finally {
      for (const child of children) await child.stop();
      for (const handle of handles) await teardown(handle);
    }
  });

  test("an explicit Windows profileRoot takes precedence over TEMP and artifacts", async () => {
    const { root, options, env } = fixture();
    const child = new SyntheticChild();
    const profileRoot = join(root, "explicit-profiles");
    const handle = await launchKiroIde({ ...options, profileRoot }, {
      platform: "win32", env,
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => { void child.stop(); },
    });
    try {
      expect(dirname(handle.profileDir)).toBe(profileRoot);
      expect(json(join(handle.profileDir, "settings.json"))).toEqual({ seed: true });
    } finally {
      await child.stop();
      await teardown(handle);
    }
  });

  test.each([undefined, "0", "1"])("worker group marker %s controls detachment and preserves terminate injection", async (marker) => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    let launchOptions: SpawnOptions | undefined;
    let terminated: ChildProcess | undefined;
    const handle = await launchKiroIde(options, {
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: marker },
      spawn: (_bin, _args, spawnOptions) => {
        launchOptions = spawnOptions;
        queueMicrotask(() => child.announce(43210));
        return child.child;
      },
      terminate: (owned) => { terminated = owned; void child.stop(); },
    });
    try {
      expect(launchOptions?.detached).toBe(process.platform !== "win32" && marker !== "1");
      expect(launchOptions?.stdio).toEqual(["ignore", "ignore", "pipe"]);
      await teardown(handle);
      expect(terminated).toBe(child.child);
      expect(child.killSignals).toEqual([]);
    } finally {
      await child.stop();
      await teardown(handle);
    }
  });

  test.each(["linux", "win32"] as const)("%s teardown closes the exact browser endpoint and waits for actual child closure", async (host) => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    const browser = browserEndpoint();
    const handle = await launchKiroIde(options, {
      platform: host,
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: host === "win32" ? "0" : "1" },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      expect(handle.browserWebSocketUrl).toBe(browser.url);
      let settled = false;
      const stopping = teardown(handle).then(() => { settled = true; });
      await browser.requestReceived;
      expect(browser.requests.map((url) => new URL(url).pathname)).toEqual(["/devtools/browser/owned-browser"]);
      expect(browser.commands).toEqual([{ id: 1, method: "Browser.close" }]);
      expect(child.exitCode).toBeNull();
      expect(existsSync(handle.profileDir)).toBe(true);
      // A protocol ACK or exit event alone does not confirm pipe/child closure.
      child.exitCode = 0;
      child.emit("exit", 0, null);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(settled).toBe(false);
      expect(existsSync(handle.profileDir)).toBe(true);
      await child.stop();
      await stopping;
      expect(existsSync(handle.profileDir)).toBe(false);
      expect(child.killSignals).toEqual([]);
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test.each(["linux", "win32"] as const)("%s child CLOSE settles a silent RPC without fallback or timeout", async (host) => {
    const { root, options, env } = fixture();
    const tracePath = join(root, "lifecycle.ndjson");
    const child = new SyntheticChild();
    const browser = browserEndpoint("silent");
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 500 }, {
      platform: host,
      env: {
        ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: host === "win32" ? "0" : "1",
        AIDLC_KIRO_IDE_DIAGNOSTICS: tracePath, OPERATOR_CONTEXT: "private-environment-sentinel",
      },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      const stopping = teardown(handle);
      await browser.requestReceived;
      await child.stop();
      await stopping;
      expect(browser.commands).toEqual([{ id: 1, method: "Browser.close" }]);
      expect(child.killSignals).toEqual([]);
      expect(existsSync(handle.profileDir)).toBe(false);
      const records = lifecycle(tracePath);
      const phases = records.map(row => row.phase);
      expect(phases.indexOf("rpc-sent")).toBeLessThan(phases.indexOf("child-close"));
      expect(phases.indexOf("child-exit")).toBeLessThan(phases.indexOf("child-close"));
      expect(phases.indexOf("child-close")).toBeLessThan(phases.indexOf("rpc-child-close-observed"));
      expect(phases).toContain("cleanup-complete");
      expect(phases).not.toContain("rpc-ack");
      expect(phases).not.toContain("rpc-timeout");
      expect(phases).not.toContain("fallback-signal");
      for (const [index, row] of records.entries()) {
        expect(row.event).toBe("kiro-lifecycle");
        expect(row.pid).toBe(child.pid!);
        expect(Number.isFinite(Date.parse(row.timestamp))).toBe(true);
        expect(row.elapsedMs).toBeGreaterThanOrEqual(index ? records[index - 1].elapsedMs : 0);
        for (const key of Object.keys(row)) expect([
          "timestamp", "event", "phase", "pid", "elapsedMs", "code", "signal",
          "timeoutMs", "sent", "settled", "localDispose", "closed", "exited",
        ]).toContain(key);
      }
      expect(readFileSync(tracePath, "utf8")).not.toContain("private-environment-sentinel");
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test.each(["silent", "ok"] as const)("Windows child EXIT without CLOSE cannot settle a %s RPC", async (reply) => {
    const { root, options, env } = fixture();
    const tracePath = join(root, "lifecycle.ndjson");
    const child = new SyntheticChild();
    const browser = browserEndpoint(reply);
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 100 }, {
      platform: "win32",
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: "0", AIDLC_KIRO_IDE_DIAGNOSTICS: tracePath },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      const stopping = teardown(handle).then(() => null, error => error);
      await browser.requestReceived;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      const failure = await stopping;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors.some((error: Error) => error.message.includes("child did not close"))).toBe(true);
      expect(child.killSignals).toEqual([]);
      expect(existsSync(handle.profileDir)).toBe(true);
      const phases = lifecycle(tracePath).map(row => row.phase);
      expect(phases).toContain("child-exit");
      expect(phases).not.toContain("child-close");
      expect(phases).not.toContain("cleanup-complete");
      expect(phases).toContain(reply === "ok" ? "rpc-ack" : "rpc-timeout");
      expect(phases).toContain("fallback-signal-skipped");
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test.each([
    ["linux", "error"], ["linux", "silent"], ["linux", "ok"],
    ["win32", "error"], ["win32", "silent"], ["win32", "ok"],
  ] as const)("%s Browser.close %s without child closure uses direct-child fallback and retains failure evidence", async (host, reply) => {
    const { root, options, env } = fixture();
    const tracePath = join(root, "lifecycle.ndjson");
    const child = new SyntheticChild();
    const browser = browserEndpoint(reply);
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 100 }, {
      platform: host,
      env: {
        ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: host === "win32" ? "0" : "1",
        AIDLC_KIRO_IDE_DIAGNOSTICS: tracePath,
      },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      await expect(teardown(handle)).rejects.toThrow("profile retained");
      expect(browser.commands).toEqual([{ id: 1, method: "Browser.close" }]);
      expect(child.killSignals).toEqual(["SIGKILL"]);
      expect(child.exitCode).toBe(0);
      expect(existsSync(handle.profileDir)).toBe(true);
      const phases = lifecycle(tracePath).map(row => row.phase);
      const outcome = reply === "error" ? "rpc-refused" : reply === "silent" ? "rpc-timeout" : "rpc-ack";
      expect(phases.indexOf(outcome)).toBeGreaterThan(phases.indexOf("rpc-sent"));
      expect(phases.indexOf(outcome)).toBeLessThan(phases.indexOf("fallback-signal"));
      expect(phases.indexOf("fallback-signal")).toBeLessThan(phases.indexOf("child-close"));
      expect(phases).toContain("cleanup-failed");
      expect(phases).not.toContain("cleanup-complete");
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test("a socket connection error is traced and remains a cleanup failure", async () => {
    const { root, options, env } = fixture();
    const tracePath = join(root, "lifecycle.ndjson");
    const child = new SyntheticChild();
    const browser = browserEndpoint("reject-connect");
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 500 }, {
      platform: "win32",
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: "0", AIDLC_KIRO_IDE_DIAGNOSTICS: tracePath },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      const failure = await teardown(handle).then(() => null, error => error);
      expect(failure?.cause?.message).toBe("Kiro Browser.close connection failed");
      const phases = lifecycle(tracePath).map(row => row.phase);
      expect(phases).toContain("rpc-socket-error");
      expect(phases).not.toContain("rpc-sent");
      expect(phases).toContain("fallback-signal");
      expect(existsSync(handle.profileDir)).toBe(true);
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test("lifecycle records are capped and never include raw child error text", async () => {
    const { root, options, env } = fixture();
    const tracePath = join(root, "lifecycle.ndjson");
    const child = new SyntheticChild();
    const handle = await launchKiroIde(options, {
      env: { ...env, AIDLC_KIRO_IDE_DIAGNOSTICS: tracePath },
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => { void child.stop(); },
    });
    try {
      for (let index = 0; index < 100; index++) child.emit("error", new Error("private-child-error-sentinel"));
      await child.stop();
      await teardown(handle);
      const records = lifecycle(tracePath);
      expect(records).toHaveLength(64);
      expect(records.at(-1)?.phase).toBe("trace-limit");
      expect(readFileSync(tracePath, "utf8")).not.toContain("private-child-error-sentinel");
    } finally {
      await child.stop();
      await teardown(handle);
    }
  });

  test("an unwritable lifecycle trace cannot mask a body or cleanup failure", async () => {
    const { root, options, env } = fixture();
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "untouched");
    const child = new SyntheticChild();
    const bodyError = new Error("original body assertion");
    const cleanupError = new Error("owned cleanup refused");
    const handle = await launchKiroIde(options, {
      env: { ...env, AIDLC_KIRO_IDE_DIAGNOSTICS: join(blocked, "trace.ndjson") },
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => { throw cleanupError; },
    });
    try {
      const failure = await withKiroIdeCleanup(
        () => { throw bodyError; }, () => teardown(handle),
      ).then(() => null, error => error);
      expect(failure.errors[0]).toBe(bodyError);
      expect(failure.errors[1].cause).toBe(cleanupError);
      expect(readFileSync(blocked, "utf8")).toBe("untouched");
      expect(existsSync(handle.profileDir)).toBe(true);
    } finally {
      await child.stop();
      await teardown(handle);
    }
  });

  test("Windows body failure retains both CDP rejection and failed owned-child fallback", async () => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    const browser = browserEndpoint("error");
    const bodyError = new Error("chat input did not become ready");
    const fallbackError = new Error("owned-child signal refused");
    child.kill = (signal = "SIGTERM") => {
      child.killSignals.push(signal);
      throw fallbackError;
    };
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 100 }, {
      platform: "win32",
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: "0" },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    let cleanupCalls = 0;
    try {
      const failure = await withKiroIdeCleanup(
        () => { throw bodyError; },
        async () => { cleanupCalls++; await teardown(handle); },
      ).then(() => null, error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(bodyError);
      expect(failure.errors[1]).toBeInstanceOf(AggregateError);
      expect(failure.errors[1].errors[0].message).toBe("Kiro Browser.close was refused");
      expect(failure.errors[1].errors[1]).toBe(fallbackError);
      expect(cleanupCalls).toBe(1);
      expect(child.killSignals).toEqual(["SIGKILL"]);
      expect(child.exitCode).toBeNull();
      expect(existsSync(handle.profileDir)).toBe(true);
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test.each(["success", "body", "cleanup", "both"] as const)("GUI %s outcome runs cleanup once and keeps original failures", async (outcome) => {
    const bodyError = new Error("original assertion");
    const cleanupError = new Error("workspace cleanup");
    let cleanupCalls = 0;
    const result = await withKiroIdeCleanup(
      async () => {
        if (outcome === "body" || outcome === "both") throw bodyError;
        return "completed";
      },
      async () => {
        cleanupCalls++;
        if (outcome === "cleanup" || outcome === "both") throw cleanupError;
      },
    ).then(value => ({ value }), error => ({ error }));
    expect(cleanupCalls).toBe(1);
    if (outcome === "success") {
      expect(result).toEqual({ value: "completed" });
    } else {
      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("expected the original failure");
      if (outcome === "both") {
        expect(result.error).toBeInstanceOf(AggregateError);
        expect(result.error.errors).toEqual([bodyError, cleanupError]);
      } else expect(result.error).toBe(outcome === "body" ? bodyError : cleanupError);
    }
  });

  test.each(["linux", "win32"] as const)("a closed %s child never reconnects to its former browser endpoint", async (host) => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    const browser = browserEndpoint();
    const handle = await launchKiroIde(options, {
      platform: host,
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: host === "win32" ? "0" : "1" },
      spawn: () => { queueMicrotask(() => child.announceEndpoint(browser.url)); return child.child; },
    });
    try {
      await child.stop();
      await teardown(handle);
      expect(browser.requests).toEqual([]);
      expect(child.killSignals).toEqual([]);
    } finally {
      await child.stop();
      await teardown(handle);
      await browser.stop();
    }
  });

  test.each(["linux", "win32"] as const)("%s startup timeout before discovery terminates only the authoritative child", async (host) => {
    const { root, options, env } = fixture();
    const child = new SyntheticChild();
    await expect(launchKiroIde({ ...options, startupTimeoutMs: 10 }, {
      platform: host,
      env: { ...env, AIDLC_TEST_WORKER_PROCESS_GROUP: host === "win32" ? "0" : "1" },
      spawn: () => child.child,
    })).rejects.toThrow("timed out reporting");
    expect(child.killSignals).toEqual(["SIGKILL"]);
    expect(readdirSync(root)).toEqual(["seed"]);
  });

  test.each(["same", "nested", "alias"] as const)("rejects a %s profile root inside the seed before copying or spawning", async (kind) => {
    const { root, seed, options, env } = fixture();
    const alias = join(root, "seed-alias");
    if (kind === "alias") symlinkSync(seed, alias, "junction");
    const profileRoot = kind === "same" ? seed : join(kind === "alias" ? alias : seed, "nested");
    let spawns = 0;
    await expect(launchKiroIde({ ...options, profileRoot }, {
      env,
      spawn: () => { spawns++; throw new Error("must not launch"); },
    })).rejects.toThrow("outside the seed profile");
    expect(spawns).toBe(0);
    expect(json(join(seed, "settings.json"))).toEqual({ seed: true });
    expect(readdirSync(profileRoot).some((name) => name.startsWith("aidlc-kiro-ide-profile-"))).toBe(false);
  });

  test("concurrent launches own distinct OS ports and profiles until their own teardown", async () => {
    const { root, seed, options, env } = fixture();
    const children: SyntheticChild[] = [];
    const terminated: ChildProcess[] = [];
    const argv: string[][] = [];
    const runtime: KiroIdeLaunchRuntime = {
      env,
      spawn: (_bin, args) => {
        argv.push(args);
        const child = new SyntheticChild();
        children.push(child);
        child.listen();
        return child.child;
      },
      terminate: (child) => {
        terminated.push(child);
        const owner = children.find((candidate) => candidate.child === child);
        if (!owner) throw new Error("unknown synthetic child");
        void owner.stop();
      },
    };
    const launches = await Promise.allSettled([
      launchKiroIde(options, runtime),
      launchKiroIde(options, runtime),
    ]);
    const handles = launches.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    try {
      expect(launches.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const [first, second] = handles;
      expect(first.port).not.toBe(second.port);
      expect(first.profileDir).not.toBe(second.profileDir);
      expect(first.port).toBe(children[0].port!);
      expect(second.port).toBe(children[1].port!);
      for (const [index, handle] of handles.entries()) {
        expect(handle.profileDir.startsWith(join(root, "aidlc-kiro-ide-profile-"))).toBe(true);
        expect(argv[index]).toContain("--remote-debugging-port=0");
        expect(argv[index]).toContain(`--user-data-dir=${handle.profileDir}`);
        expect(argv[index]).not.toContain(`--user-data-dir=${seed}`);
        expect(existsSync(join(handle.profileDir, "DevToolsActivePort"))).toBe(false);
        expect(existsSync(join(handle.profileDir, "SingletonLock"))).toBe(false);
        expect(await bindResult(handle.port)).toBe("EADDRINUSE");
      }
      writeFileSync(join(first.profileDir, "settings.json"), '{"changed":true}');
      expect(json(join(second.profileDir, "settings.json"))).toEqual({ seed: true });
      expect(json(join(seed, "settings.json"))).toEqual({ seed: true });

      await expect(teardown({ ...first })).rejects.toThrow("not owned");
      expect(terminated).toHaveLength(0);
      await Promise.all([teardown(first), teardown(first)]);
      expect(terminated).toEqual([first.child]);
      expect(await bindResult(first.port)).toBeUndefined();
      expect(existsSync(first.profileDir)).toBe(false);
      expect(await bindResult(second.port)).toBe("EADDRINUSE");
      expect(existsSync(second.profileDir)).toBe(true);
      await teardown(second);
      expect(await bindResult(second.port)).toBeUndefined();
      expect(existsSync(second.profileDir)).toBe(false);
      expect(readFileSync(join(seed, "SingletonLock"), "utf8")).toBe("stale-owner");
    } finally {
      for (const child of children) await child.stop();
      for (const handle of handles) await teardown(handle);
    }
  });

  test("endpoint discovery waits for a whole stderr line and ignores unrelated endpoints", async () => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    let settled = false;
    const launching = launchKiroIde(options, {
      env,
      spawn: () => child.child,
      terminate: () => { void child.stop(); },
    }).then((handle) => { settled = true; return handle; });
    child.stderr.write("DevTools listening on ws://example.com:4444/devtools/browser/foreign\n");
    child.stderr.write("DevTools listening on ws://127.0.0.1:432");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.write("10/devtools/browser/own\r\n");
    const handle = await launching;
    try {
      expect(handle.port).toBe(43210);
      expect(kiroIdeDebugPort("DevTools listening on ws://127.0.0.1:0/devtools/browser/id")).toBeNull();
      expect(kiroIdeDebugPort("DevTools listening on ws://127.0.0.1:9222/devtools/page/id")).toBeNull();
      expect(kiroIdeDebugPort("DevTools listening on ws://127.0.0.1:65536/devtools/browser/id")).toBeNull();
      expect(kiroIdeDebugPort("unrelated port 9222")).toBeNull();
      // A late child error must have a listener even after endpoint discovery.
      expect(() => child.emit("error", new Error("late process error"))).not.toThrow();
    } finally {
      await teardown(handle);
    }
  });

  test.each(["spawn-error", "early-exit", "timeout", "spawn-throw"] as const)(
    "%s fails launch and cleans its private profile without signalling an exited PID",
    async (failure) => {
      const { root, options, env } = fixture();
      const child = new SyntheticChild();
      let terminations = 0;
      const launching = launchKiroIde({ ...options, startupTimeoutMs: 10 }, {
        env,
        spawn: () => {
          if (failure === "spawn-throw") throw new Error("synthetic spawn threw");
          queueMicrotask(() => {
            if (failure === "spawn-error") {
              child.pid = undefined;
              child.emit("error", new Error("synthetic ENOENT"));
              child.finish(1);
            } else if (failure === "early-exit") {
              child.finish(17);
            }
          });
          return child.child;
        },
        terminate: () => { terminations++; void child.stop(); },
      });
      const expected = {
        "spawn-error": "synthetic ENOENT",
        "early-exit": "exited before reporting",
        timeout: "timed out reporting",
        "spawn-throw": "synthetic spawn threw",
      }[failure];
      try {
        await expect(launching).rejects.toThrow(expected);
        expect(terminations).toBe(failure === "timeout" ? 1 : 0);
        expect(readdirSync(root)).toEqual(["seed"]);
      } finally {
        await child.stop();
      }
    },
  );

  test("teardown never signals a closed child's PID after its port is reused", async () => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    let terminations = 0;
    const handle = await launchKiroIde(options, {
      env,
      spawn: () => { child.listen(); return child.child; },
      terminate: () => { terminations++; void child.stop(); },
    });
    const replacement = createServer();
    try {
      await child.stop();
      await new Promise<void>((done, reject) => {
        replacement.once("error", reject);
        replacement.listen({ host: "127.0.0.1", port: handle.port }, done);
      });
      await teardown(handle);
      expect(terminations).toBe(0);
      expect(replacement.listening).toBe(true);
      expect(await bindResult(handle.port)).toBe("EADDRINUSE");
    } finally {
      if (replacement.listening) await new Promise<void>((done) => replacement.close(() => done()));
      await child.stop();
      await teardown(handle);
    }
  });

  test("failed termination retains the owned profile and permits a later cleanup retry", async () => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    let refuseTermination = true;
    const handle = await launchKiroIde(options, {
      env,
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => {
        if (refuseTermination) throw new Error("synthetic access denied");
        void child.stop();
      },
    });
    try {
      await expect(teardown(handle)).rejects.toThrow("profile retained");
      expect(existsSync(handle.profileDir)).toBe(true);
      expect(child.exitCode).toBeNull();
      refuseTermination = false;
      await teardown(handle);
      expect(existsSync(handle.profileDir)).toBe(false);
    } finally {
      refuseTermination = false;
      await child.stop();
      await teardown(handle);
    }
  });

  test("an unconfirmed close fails teardown and retains the profile until the child closes", async () => {
    const { options, env } = fixture();
    const child = new SyntheticChild();
    const handle = await launchKiroIde({ ...options, shutdownTimeoutMs: 10 }, {
      env,
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => {},
    });
    try {
      await expect(teardown(handle)).rejects.toThrow("did not close; profile retained");
      expect(existsSync(handle.profileDir)).toBe(true);
      expect(child.exitCode).toBeNull();
      await child.stop();
      await teardown(handle);
      expect(existsSync(handle.profileDir)).toBe(false);
    } finally {
      await child.stop();
      await teardown(handle);
    }
  });

  test("profile cleanup waits for close and KEEP_TEMP preserves the running launch", async () => {
    const { options, env } = fixture();
    const keepEnv: NodeJS.ProcessEnv = { ...env, AIDLC_KEEP_TEMP: "1" };
    const child = new SyntheticChild();
    let terminations = 0;
    const handle: KiroIdeHandle = await launchKiroIde(options, {
      env: keepEnv,
      spawn: () => { queueMicrotask(() => child.announce(43210)); return child.child; },
      terminate: () => { terminations++; },
    });
    try {
      await teardown(handle);
      expect(terminations).toBe(0);
      expect(existsSync(handle.profileDir)).toBe(true);
      keepEnv.AIDLC_KEEP_TEMP = "0";
      const stopping = teardown(handle);
      expect(terminations).toBe(1);
      expect(existsSync(handle.profileDir)).toBe(true);
      await child.stop();
      await stopping;
      expect(existsSync(handle.profileDir)).toBe(false);
    } finally {
      keepEnv.AIDLC_KEEP_TEMP = "0";
      await child.stop();
      await teardown(handle);
    }
  });
});

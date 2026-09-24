import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensurePrivateRoot } from "../harness/tui-record-file.ts";
import {
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  resolveTuiRuntime,
  selectedTuiBackend,
  type TuiRuntimeContext,
  tuiUnavailableReason,
} from "../harness/tui-runtime.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DRIVER = "/repo/tests/harness/tui-drive.ts";
const noProbe: NonNullable<TuiRuntimeContext["probe"]> = () => {
  throw new Error("selection must not probe an unrelated runtime");
};
const success = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const missing = { status: null, stdout: "", stderr: "", error: new Error("ENOENT") };

function scratchRoot(): string {
  let checkout = resolve(import.meta.dir, "../..");
  const marker = join(checkout, ".git");
  if (existsSync(marker) && statSync(marker).isFile()) {
    const gitDir = resolve(checkout, readFileSync(marker, "utf8").trim().replace(/^gitdir: /, ""));
    checkout = dirname(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
  }
  return join(checkout, "tmp", "combined-test-suite", "native-handoff");
}

describe("native driver Node handoff", () => {
  test("a Node override fails after one handoff; a real Bun override executes the command", () => {
    const parent = scratchRoot();
    mkdirSync(parent, { recursive: true });
    const scratch = mkdtempSync(join(parent, "handoff-"));
    const directory = join(scratch, "private");
    ensurePrivateRoot(directory);
    const driver = resolve(import.meta.dir, "../harness/tui-drive.ts");
    const node = resolveTuiRuntime(driver, {
      env: { ...process.env, AIDLC_TUI_BACKEND: "node-pty" },
    }).bin;
    const preload = join(directory, "count-handoffs.mjs");
    const hops = join(directory, "hops.log");
    const events = join(directory, "handoff-events.log");
    writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const count = Number(process.env.AIDLC_HANDOFF_TEST_COUNT || "0") + 1;
process.env.AIDLC_HANDOFF_TEST_COUNT = String(count);
appendFileSync(${JSON.stringify(hops)}, count + "\\n");
const record = (event, code = null) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({
  event, code, at: Date.now(), pid: process.pid, ppid: process.ppid, count,
  handoff: process.env.AIDLC_TUI_BUN_HANDOFF, node: process.version, execPath: process.execPath,
}) + "\\n");
record("preload");
process.on("exit", code => record("exit", code));
// A broken driver is capped independently; this regression must not leave a
// recursive process chain behind when its assertion fails.
if (count > 2) { console.error("fixture stopped repeated runtime handoff"); process.exit(93); }
`);
    const env: NodeJS.ProcessEnv = {
      ...process.env, AIDLC_TUI_BACKEND: "bun", AIDLC_TUI_BUN_ROOT: directory,
      AIDLC_TUI_BUN_HANDOFF: "", AIDLC_HANDOFF_TEST_COUNT: "0",
      NODE_OPTIONS: `--experimental-strip-types --import=${pathToFileURL(preload).href}`,
    };
    delete env.BUN_OPTIONS;
    const args = ["--experimental-strip-types", driver, "wait-dead", "--session", "absent"];
    let passed = false;
    try {
      const wrongStarted = Date.now();
      const wrong = spawnSync(node, args, {
        env: { ...env, AIDLC_BUN_BIN: node }, encoding: "utf8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "native handoff refusal" }),
      });
      writeFileSync(join(directory, "wrong-runtime.log"), JSON.stringify({
        elapsedMs: Date.now() - wrongStarted, status: wrong.status, signal: wrong.signal,
        error: wrong.error?.message, stdout: wrong.stdout, stderr: wrong.stderr,
      }, null, 2));
      expect(wrong.error, wrong.stderr).toBeUndefined();
      expect(wrong.status).toBe(2);
      expect(wrong.stderr).toContain("native TUI handoff requires Bun");
      expect(readFileSync(hops, "utf8").trim().split("\n")).toEqual(["1", "2"]);
      const correctStarted = Date.now();
      const correct = spawnSync(node, args, {
        env: { ...env, NODE_OPTIONS: "", AIDLC_BUN_BIN: process.execPath },
        encoding: "utf8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "native Bun handoff" }),
      });
      writeFileSync(join(directory, "correct-runtime.log"), JSON.stringify({
        elapsedMs: Date.now() - correctStarted, status: correct.status, signal: correct.signal,
        error: correct.error?.message, stdout: correct.stdout, stderr: correct.stderr,
      }, null, 2));
      expect(correct.error, correct.stderr).toBeUndefined();
      expect(correct.status, correct.stderr).toBe(0);
      expect(correct.stdout).toContain("process tree exited");
      passed = true;
    } finally {
      // The working scratch tree is not a CI upload root. Emit bounded, curated
      // diagnostics into the captured test log before successful fixture cleanup.
      for (const name of ["hops.log", "handoff-events.log", "wrong-runtime.log", "correct-runtime.log"]) {
        let contents: string;
        try { contents = readFileSync(join(directory, name), "utf8").slice(0, 64 * 1024); }
        catch (error) { contents = `<unavailable: ${(error as NodeJS.ErrnoException).code ?? "read failed"}>`; }
        console.log(`native handoff ${name}: ${contents}`);
      }
      if (passed) rmSync(scratch, { recursive: true, force: true });
      else console.error(`native handoff evidence retained: ${directory}`);
    }
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);
});

describe("TUI backend selection", () => {
  test("auto uses native Bun on Linux/Windows/macOS and tmux elsewhere", () => {
    for (const env of [{}, { AIDLC_TUI_BACKEND: "auto" }]) {
      expect(selectedTuiBackend(env, "linux")).toBe("bun");
      expect(selectedTuiBackend(env, "win32")).toBe("bun");
      expect(selectedTuiBackend(env, "darwin")).toBe("bun");
      expect(selectedTuiBackend(env, "freebsd")).toBe("tmux");
    }
  });

  test("explicit selections are retained independently of platform", () => {
    for (const backend of ["bun", "tmux", "node-pty"] as const) {
      for (const platform of ["linux", "win32", "darwin"] as const) {
        expect(selectedTuiBackend({ AIDLC_TUI_BACKEND: backend }, platform)).toBe(backend);
      }
    }
  });

  test("unknown and empty selections throw instead of becoming capability skips", () => {
    for (const value of ["", "BUN", "native", " bun ", "automatic"]) {
      const env = { AIDLC_TUI_BACKEND: value };
      expect(() => selectedTuiBackend(env, "linux")).toThrow("Invalid AIDLC_TUI_BACKEND");
      expect(() => resolveTuiRuntime(DRIVER, { env, probe: noProbe })).toThrow(
        "Invalid AIDLC_TUI_BACKEND",
      );
      expect(() => tuiUnavailableReason({ env, probe: noProbe })).toThrow(
        "Invalid AIDLC_TUI_BACKEND",
      );
    }
  });
});

describe("TUI driver runtime resolution", () => {
  test("expired work budgets do not prevent runtime selection for cleanup", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, AIDLC_TUI_BACKEND: "node-pty",
      [FILE_DEADLINE_ENV]: "1", [FILE_CLEANUP_ENV]: "300000",
    };
    delete env.AIDLC_NODE_BIN;
    const runtime = resolveTuiRuntime(DRIVER, { env });
    expect(runtime.backend).toBe("node-pty");
    expect(runtime.bin.length).toBeGreaterThan(0);
    expect(runtime.prefix).toEqual(["--experimental-strip-types", DRIVER]);
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);

  test("Bun and tmux use the current Bun executable without probing Node", () => {
    for (const backend of ["bun", "tmux"] as const) {
      expect(resolveTuiRuntime(DRIVER, {
        env: { AIDLC_TUI_BACKEND: backend, AIDLC_NODE_BIN: "" },
        platform: "linux",
        execPath: "/installed/bun",
        runningBun: true,
        probe: noProbe,
      })).toEqual({ bin: "/installed/bun", prefix: [DRIVER], backend });
    }
  });

  test("a Bun override wins over the current executable, including paths with spaces", () => {
    for (const backend of ["bun", "tmux"] as const) {
      expect(resolveTuiRuntime(DRIVER, {
        env: { AIDLC_TUI_BACKEND: backend, AIDLC_BUN_BIN: "C:\\Custom Bun\\bun.exe" },
        platform: "win32",
        execPath: "C:\\other\\bun.exe",
        runningBun: true,
        probe: noProbe,
      })).toEqual({ bin: "C:\\Custom Bun\\bun.exe", prefix: [DRIVER], backend });
    }
  });

  test("a non-Bun parent launches PATH bun instead of its own executable", () => {
    expect(resolveTuiRuntime(DRIVER, {
      env: {},
      platform: "linux",
      execPath: "/installed/node",
      runningBun: false,
      probe: noProbe,
    })).toEqual({ bin: "bun", prefix: [DRIVER], backend: "bun" });
  });

  test("explicit legacy Windows selection uses its Node override and type stripping", () => {
    expect(resolveTuiRuntime(DRIVER, {
      env: {
        AIDLC_TUI_BACKEND: "node-pty",
        AIDLC_NODE_BIN: "C:\\Custom Node\\node.exe",
        AIDLC_BUN_BIN: "",
      },
      platform: "win32",
      probe: noProbe,
    })).toEqual({
      bin: "C:\\Custom Node\\node.exe",
      prefix: ["--experimental-strip-types", DRIVER],
      backend: "node-pty",
    });
  });

  test("legacy Windows resolution finds an off-PATH Program Files Node installation", () => {
    const tried: string[] = [];
    const runtime = resolveTuiRuntime(DRIVER, {
      env: { AIDLC_TUI_BACKEND: "node-pty" },
      platform: "win32",
      probe: (bin) => {
        tried.push(bin);
        return bin === "node" ? missing : success("v22.14.0");
      },
    });
    expect(tried).toEqual(["node", "C:\\Program Files\\nodejs\\node.exe"]);
    expect(runtime.bin).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(runtime.prefix).toEqual(["--experimental-strip-types", DRIVER]);
  });

  test("malformed selected executable overrides throw", () => {
    for (const value of ["", "   ", "bun\0other"]) {
      expect(() => resolveTuiRuntime(DRIVER, {
        env: { AIDLC_TUI_BACKEND: "bun", AIDLC_BUN_BIN: value },
      })).toThrow("Invalid AIDLC_BUN_BIN");
      expect(() => resolveTuiRuntime(DRIVER, {
        env: { AIDLC_TUI_BACKEND: "node-pty", AIDLC_NODE_BIN: value },
      })).toThrow("Invalid AIDLC_NODE_BIN");
    }
  });
});

describe("TUI substrate prerequisites", () => {
  test("native Bun needs neither tmux nor Node on every supported platform", () => {
    for (const platform of ["linux", "win32", "darwin"] as const) {
      const calls: string[] = [];
      const reason = tuiUnavailableReason({
        env: { AIDLC_BUN_BIN: "/native/bun", AIDLC_NODE_BIN: "/missing/node" },
        platform,
        probe: (bin) => {
          calls.push(bin);
          if (bin !== "/native/bun") return missing;
          return success(JSON.stringify({
            version: "1.3.14",
            terminal: "function",
            headlessError: null,
          }));
        },
      });
      expect(reason).toBeNull();
      expect(calls).toEqual(["/native/bun"]);
    }
  });

  test("native lifecycle on unsupported platforms reports a reason without probing", () => {
    for (const platform of ["freebsd", "openbsd"] as const) {
      expect(tuiUnavailableReason({
        env: { AIDLC_TUI_BACKEND: "bun" },
        platform,
        probe: noProbe,
      })).toContain(`unsupported on ${platform}`);
    }
    expect(tuiUnavailableReason({
      env: { AIDLC_TUI_BACKEND: "node-pty" },
      platform: "linux",
      probe: noProbe,
    })).toContain("legacy backend supports Windows only");
  });

  test("the selected Bun executable must meet the version and API requirements", () => {
    const context: TuiRuntimeContext = {
      env: { AIDLC_TUI_BACKEND: "bun", AIDLC_BUN_BIN: "/selected/bun" },
      platform: "linux",
    };
    for (const version of ["1.3.13", "1.2.99", "0.99.0", "invalid"]) {
      expect(tuiUnavailableReason({
        ...context,
        probe: () => success(JSON.stringify({ version, terminal: "function", headlessError: null })),
      })).toContain("requires Bun >=1.3.14");
    }
    for (const version of ["1.3.14", "1.3.15", "1.4.0", "2.0.0"]) {
      expect(tuiUnavailableReason({
        ...context,
        probe: () => success(JSON.stringify({ version, terminal: "function", headlessError: null })),
      })).toBeNull();
    }
    expect(tuiUnavailableReason({
      ...context,
      probe: () => success(JSON.stringify({
        version: "1.3.14",
        terminal: "undefined",
        headlessError: null,
      })),
    })).toContain("Bun.Terminal API unavailable");
    expect(tuiUnavailableReason({
      ...context,
      probe: () => success(JSON.stringify({
        version: "1.3.14",
        terminal: "function",
        headlessError: "Cannot find package",
      })),
    })).toContain("@xterm/headless not loadable by Bun");
  });

  test("a missing Bun override reports absence without falling back to another executable", () => {
    const calls: string[] = [];
    const reason = tuiUnavailableReason({
      env: { AIDLC_BUN_BIN: "/missing/bun" },
      platform: "linux",
      probe: (bin) => {
        calls.push(bin);
        return missing;
      },
    });
    expect(reason).toContain("Bun runtime unavailable (/missing/bun)");
    expect(calls).toEqual(["/missing/bun"]);
  });

  test("tmux requires Bun and tmux, but not the native API or renderer dependencies", () => {
    const calls: string[] = [];
    const context: TuiRuntimeContext = {
      env: { AIDLC_TUI_BACKEND: "tmux", AIDLC_BUN_BIN: "/legacy/bun" },
      platform: "darwin",
      probe: (bin) => {
        calls.push(bin);
        return bin === "tmux" ? success("tmux 3.5") : success('{"version":"1.3.1"}');
      },
    };
    expect(tuiUnavailableReason(context)).toBeNull();
    expect(calls).toEqual(["/legacy/bun", "tmux"]);
    expect(tuiUnavailableReason({
      ...context,
      probe: (bin) => bin === "tmux" ? missing : success('{"version":"1.3.1"}'),
    })).toBe("tmux not found");
  });

  test("legacy node-pty prerequisites use Node with type stripping and report load failures", () => {
    const calls: string[] = [];
    const context: TuiRuntimeContext = {
      env: { AIDLC_TUI_BACKEND: "node-pty", AIDLC_NODE_BIN: "custom-node" },
      platform: "win32",
      probe: (bin, args) => {
        calls.push(bin);
        expect(args[0]).toBe("--experimental-strip-types");
        return success();
      },
    };
    expect(tuiUnavailableReason(context)).toBeNull();
    expect(calls).toEqual(["custom-node"]);
    expect(tuiUnavailableReason({
      ...context,
      probe: () => ({ status: 1, stdout: "", stderr: "Cannot find module 'node-pty'" }),
    })).toContain("Cannot find module 'node-pty'");
  });

  test("missing Node is a capability reason, including an absent Windows fallback", () => {
    const context: TuiRuntimeContext = {
      env: { AIDLC_TUI_BACKEND: "node-pty" },
      platform: "win32",
      probe: () => missing,
    };
    expect(resolveTuiRuntime(DRIVER, context).prefix).toEqual([
      "--experimental-strip-types",
      DRIVER,
    ]);
    expect(tuiUnavailableReason(context)).toContain("node-pty TUI backend requires Node");
  });

  test("a non-Bun executable or malformed probe response is reported as unavailable", () => {
    const context: TuiRuntimeContext = {
      env: { AIDLC_TUI_BACKEND: "bun", AIDLC_BUN_BIN: "wrong-runtime" },
      platform: "linux",
    };
    expect(tuiUnavailableReason({
      ...context,
      probe: () => success('{"version":null}'),
    })).toContain("Bun runtime required");
    expect(tuiUnavailableReason({
      ...context,
      probe: () => success("not JSON"),
    })).toContain("invalid capability data");
  });

  test("changing runtime overrides and probe environments takes effect in the same process", () => {
    const env: NodeJS.ProcessEnv = { AIDLC_BUN_BIN: "/old/bun", PATH: "/first" };
    const seen: string[] = [];
    const context: TuiRuntimeContext = {
      env,
      platform: "linux",
      probe: (bin, _args, probeEnv) => {
        seen.push(`${bin}:${probeEnv.PATH}`);
        return missing;
      },
    };
    expect(tuiUnavailableReason(context)).toContain("/old/bun");
    env.AIDLC_BUN_BIN = "/new/bun";
    env.PATH = "/second";
    expect(tuiUnavailableReason(context)).toContain("/new/bun");
    expect(seen).toEqual(["/old/bun:/first", "/new/bun:/second"]);
  });
});

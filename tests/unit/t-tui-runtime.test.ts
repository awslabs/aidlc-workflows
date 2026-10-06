import { describe, expect, test, setDefaultTimeout } from "bun:test";
import {
  FILE_CLEANUP_ENV,
  FILE_DEADLINE_ENV,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
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
    for (const backend of ["bun", "tmux"] as const) {
      for (const platform of ["linux", "win32", "darwin"] as const) {
        expect(selectedTuiBackend({ AIDLC_TUI_BACKEND: backend }, platform)).toBe(backend);
      }
    }
  });

  test("unknown and empty selections throw instead of becoming capability skips", () => {
    for (const value of ["", "BUN", "native", " bun ", "automatic", "node-pty"]) {
      const env = { AIDLC_TUI_BACKEND: value };
      expect(() => selectedTuiBackend(env, "linux")).toThrow("Invalid AIDLC_TUI_BACKEND");
      expect(() => resolveTuiRuntime(DRIVER, { env, probe: noProbe })).toThrow(
        "Invalid AIDLC_TUI_BACKEND",
      );
      expect(() => tuiUnavailableReason({ env, probe: noProbe })).toThrow(
        "Invalid AIDLC_TUI_BACKEND",
      );
    }
    expect(() => selectedTuiBackend({ AIDLC_TUI_BACKEND: "node-pty" }, "win32")).toThrow(
      'Invalid AIDLC_TUI_BACKEND "node-pty"; expected auto, bun, or tmux',
    );
  });
});

describe("TUI driver runtime resolution", () => {
  test("expired work budgets do not prevent runtime selection for cleanup", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, AIDLC_TUI_BACKEND: "bun",
      [FILE_DEADLINE_ENV]: "1", [FILE_CLEANUP_ENV]: "300000",
    };
    const runtime = resolveTuiRuntime(DRIVER, {
      env, execPath: process.execPath, runningBun: true,
    });
    expect(runtime.backend).toBe("bun");
    expect(runtime.bin.length).toBeGreaterThan(0);
    expect(runtime.prefix).toEqual([DRIVER]);
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

  test("malformed selected executable overrides throw", () => {
    for (const value of ["", "   ", "bun\0other"]) {
      expect(() => resolveTuiRuntime(DRIVER, {
        env: { AIDLC_TUI_BACKEND: "bun", AIDLC_BUN_BIN: value },
      })).toThrow("Invalid AIDLC_BUN_BIN");
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

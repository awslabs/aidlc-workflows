import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { remainingOperationTimeoutMs } from "./test-budget.ts";

export interface CodexExecution {
  rc: number;
  out?: string;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
  error?: string;
}

export interface CodexFailureExecution {
  cwd: string;
  stdout?: string;
  rc: number;
}

const diagnostics = new AsyncLocalStorage<{
  last?: string; deadlineMs?: number;
  onFailure?: (execution?: CodexFailureExecution) => void;
  execution?: CodexFailureExecution;
}>();
let executionNumber = 0;
let deferredNumber = 0;
const limit = (text: string, maximum = 12_000): string => text.length <= maximum ? text
  : `${text.slice(0, maximum / 3)}\n... ${text.length - maximum} characters omitted ...\n${text.slice(-maximum * 2 / 3)}`;

/** Leave time to capture the exec failure and complete/defer fixture cleanup. */
export function codexExecTimeout(requestedMs: number): number {
  const deadline = diagnostics.getStore()?.deadlineMs;
  if (!Number.isFinite(requestedMs) || requestedMs <= 0 || (deadline !== undefined && !Number.isFinite(deadline))) {
    throw new Error("Codex exec requires a finite positive budget and deadline");
  }
  // Existing callers use performance.now(); file deadlines cross process
  // boundaries as epoch milliseconds. Convert without resetting the case pool.
  const nowMs = Date.now();
  return remainingOperationTimeoutMs(requestedMs, {
    nowMs,
    deadlineMs: deadline === undefined ? undefined : nowMs + deadline - performance.now(),
    reserveMs: 30_000,
    phase: "Codex exec",
  })!;
}

/** Keep assertion output bounded; the per-exec log retains the complete capture. */
export function codexExecDiagnostic(result: CodexExecution): string {
  return `Codex exit=${result.rc}; signal=${result.signal ?? "none"}; spawn error=${result.error ?? "none"}\n` +
    limit(result.out ?? `STDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`);
}

export function recordCodexExec(label: string, cwd: string, argv: string[], result: CodexExecution): void {
  const header = `Command: ${JSON.stringify(argv)}\nCwd: ${cwd}\n`;
  const summary = header + codexExecDiagnostic(result);
  const context = diagnostics.getStore();
  if (context) context.last = limit(summary);
  if (context?.onFailure) context.execution = { cwd, stdout: result.stdout, rc: result.rc };
  if (process.env.AIDLC_TEST_LOG_DIR) {
    writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, `exec-codex-${label}-${++executionNumber}.log`),
      `${header}Exit code: ${result.rc}\nSignal: ${result.signal ?? "none"}\nSpawn error: ${result.error ?? "none"}\n\n` +
      (result.out ?? `STDOUT:\n${result.stdout ?? ""}\nSTDERR:\n${result.stderr ?? ""}`));
  }
}

const samePath = (a: string, b: string): boolean => {
  const normalize = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
};
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

function pinDirectory(path: string): () => void {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error(`Codex cleanup requires a plain directory: ${path}`);
  }
  return () => {
    const now = lstatSync(path, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino ||
      !samePath(realpathSync(path), path)) throw new Error(`Codex cleanup directory changed: ${path}`);
  };
}

/** Capture the runner context before executing Codex. No env-only deferral. */
async function deferredWindowsCleanup(root: string): Promise<{ defer(): void; close(): void } | undefined> {
  const env = { ...process.env };
  if (process.platform !== "win32" || !process.versions.bun || env.AIDLC_CODEX_EXEC_LIVE !== "1") return;
  const artifacts = env.AIDLC_TEST_WORKER_ROOT;
  const temp = env.TEMP;
  if (!artifacts || !temp || !env.TMP || !env.TMPDIR || !env.AIDLC_TEST_NAME || !env.AIDLC_TEST_LOG_DIR) return;
  if (!/^[1-9]\d*$/.test(env.AIDLC_TEST_WORKER_ID ?? "") || env.AIDLC_TEST_WORKER_PROCESS_GROUP !== "0") return;
  if (!samePath(temp, env.TMP) || !samePath(temp, env.TMPDIR) ||
    !samePath(dirname(root), temp) || !/^aidlc-e2e-fixtures-[A-Za-z0-9]+$/.test(basename(temp)) ||
    !/^(?:codex-exec|codex-mem-include|aidlc-journey)-[A-Za-z0-9]+$/.test(basename(root)) ||
    !(samePath(artifacts, env.AIDLC_TEST_LOG_DIR) || within(env.AIDLC_TEST_LOG_DIR, artifacts))) return;
  const verifyDirectories = [temp, root, artifacts].map(pinDirectory);
  // The coordinator's live report binds this exact worker to its cleanup TEMP.
  // Ordinary/direct test invocations have no such handoff and clean up eagerly.
  const reportPath = join(dirname(dirname(artifacts)), "e2e-results.json");
  const verifyReport = () => {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const rows = Array.isArray(report.files) ? report.files.filter((row: Record<string, unknown>) =>
      row.worker === Number(env.AIDLC_TEST_WORKER_ID) && row.file === `tests/e2e/${env.AIDLC_TEST_NAME}`) : [];
    const row = rows[0];
    if (rows.length !== 1 || row.state !== "RUNNING" ||
      typeof row.artifacts !== "string" || !samePath(row.artifacts, artifacts) ||
      typeof row.temporaryDirectory !== "string" || !samePath(row.temporaryDirectory, temp) ||
      typeof row.checkout !== "string" || !samePath(row.checkout, process.cwd())) {
      throw new Error("Codex fixture TEMP is not assigned to this running test by the coordinator");
    }
  };
  verifyReport();
  const configPath = join(artifacts, "process-config.json");
  const configText = readFileSync(configPath, "utf8");
  const config = JSON.parse(configText);
  if (typeof config.token !== "string" || !/^[a-f0-9-]{36}$/i.test(config.token) ||
    typeof config.job !== "string" || !/^Local\\aidlc-e2e-[a-f0-9-]{36}$/i.test(config.job) ||
    !Array.isArray(config.command) || config.command[1] !== "test" ||
    typeof config.command[0] !== "string" || !samePath(realpathSync(config.command[0]), realpathSync(process.execPath)) ||
    typeof config.command[2] !== "string" ||
    !/^t-exec-codex-(?:status|memory-include|compose-front|compose-inflight|journey-workspace)\.serial\.test\.ts$/.test(basename(config.command[2])) ||
    basename(config.command[2]) !== env.AIDLC_TEST_NAME ||
    typeof config.cwd !== "string" || !samePath(config.cwd, process.cwd()) ||
    !samePath(config.command[2], join(config.cwd, "tests", "e2e", env.AIDLC_TEST_NAME)) ||
    typeof config.status !== "string" || !samePath(config.status, join(artifacts, "process-status.json"))) return;
  const verifyStatus = () => {
    if (readFileSync(configPath, "utf8") !== configText) throw new Error("Codex runner configuration changed");
    const status = JSON.parse(readFileSync(config.status, "utf8"));
    if (status.token !== config.token || status.phase !== "running") throw new Error("Codex runner is no longer executing this test");
  };
  verifyStatus();
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("kernel32.dll", {
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
    GetCurrentProcess: { args: [], returns: "ptr" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const api = library.symbols;
  // Query rights only. The runner retains all termination authority.
  const handle = api.OpenJobObjectW(0x0004, 0, Buffer.from(`${config.job}\0`, "utf16le"));
  if (!handle) { library.close(); return; }
  const verifyJob = () => {
    const member = new Int32Array(1);
    if (!api.IsProcessInJob(api.GetCurrentProcess(), handle, member) || member[0] !== 1) {
      throw new Error("Codex test is not in the recorded runner-owned Windows job");
    }
  };
  const close = () => {
    try {
      if (!api.CloseHandle(handle)) throw new Error(`Could not close Codex job query handle: ${api.GetLastError()}`);
    } finally { library.close(); }
  };
  try { verifyJob(); } catch (error) { close(); throw error; }
  return {
    close,
    defer() {
      for (const verify of verifyDirectories) verify();
      verifyReport();
      verifyStatus();
      verifyJob();
      // After verified job retirement, the coordinator retains this container
      // with its diagnostics for host cleanup, including when the test passes.
      // This request is never evidence that the process tree has already exited.
      const receipt = join(artifacts, `codex-deferred-cleanup-${++deferredNumber}.json`);
      writeFileSync(receipt, `${JSON.stringify({ root, temporaryDirectory: temp, coordinatorReport: reportPath, runnerConfig: configPath, job: config.job }, null, 2)}\n`);
      console.error(`[codex fixture] cleanup deferred until runner job retirement: ${root} (${receipt})`);
    },
  };
}

/** Preserve the original assertion and every cleanup error, in that order. */
export async function withCodexFixture<T>(
  root: string, cleanup: () => void, body: () => T | Promise<T>, deadlineMs?: number,
  onFailure?: (execution?: CodexFailureExecution) => void,
): Promise<T> {
  return diagnostics.run({ deadlineMs, onFailure }, async () => {
    let deferred: Awaited<ReturnType<typeof deferredWindowsCleanup>>;
    let unavailable: unknown;
    try { deferred = await deferredWindowsCleanup(resolve(root)); } catch (error) { unavailable = error; }
    const errors: unknown[] = [];
    let result: T | undefined;
    try { result = await body(); } catch (error) {
      errors.push(error);
      if (diagnostics.getStore()?.last) console.error(`[codex primary failure]\n${diagnostics.getStore()!.last}`);
      try { onFailure?.(diagnostics.getStore()?.execution); }
      catch { console.error("[codex workspace diagnostic] capture failed; original failure preserved"); }
    } finally {
      try {
        if (deferred) deferred.defer();
        else cleanup();
      } catch (error) {
        errors.push(error);
        if (unavailable) errors.push(unavailable);
      } finally {
        try { deferred?.close(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors,
        `Codex assertion/cleanup failures:\n${errors.map((e) => e instanceof Error ? e.stack || e.message : String(e)).join("\n")}\n` +
        (diagnostics.getStore()?.last ?? ""), { cause: errors[0] });
    }
    return result as T;
  });
}

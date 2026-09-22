import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statfsSync, writeFileSync,
} from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { resolveTuiRuntime, selectedTuiBackend } from "../harness/tui-runtime.ts";
import { ensurePrivateRoot } from "../harness/tui-record-file.ts";

export interface E2eWorker {
  id: number;
  root: string;
  socket: string;
  sourceRoot?: string;
}

export interface E2eWorkerPool {
  root: string;
  workers: E2eWorker[];
  sourceRevision: string;
  sourceDirty: boolean;
  dispose(preserve: boolean): Promise<void>;
}

const NATIVE_CLEANUP_MS = 45_000;
const transportReceipts = new WeakMap<NodeJS.ProcessEnv, string>();
const nativeRoots = new Map<string, string>();
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Keep headroom for results and runtime fixtures before admitting more work. */
export function assertE2eDiskSpace(path: string, additionalBytes = 0): void {
  const reserve = Number(process.env.AIDLC_E2E_MIN_FREE_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error("AIDLC_E2E_MIN_FREE_BYTES must be a nonnegative safe integer");
  }
  const stats = statfsSync(path);
  const available = stats.bavail * stats.bsize;
  const required = reserve + additionalBytes;
  if (available < required) {
    throw new Error(`insufficient e2e storage at ${path}: ${available} bytes available, ${required} required; no further tests admitted`);
  }
}

function allocatedCopyBytes(path: string, sourceRoot: string): number {
  const stat = snapshotStat(sourceRoot, path);
  if (!stat) throw new Error(`e2e snapshot source disappeared while sizing: ${path}`);
  if (stat.isSymbolicLink()) return 4096;
  if (!stat.isDirectory()) return Math.max(4096, Math.ceil(stat.size / 4096) * 4096);
  return 4096 + readdirSync(path).reduce((sum, entry) => sum + allocatedCopyBytes(join(path, entry), sourceRoot), 0);
}

/** Some applications discover .git markers even when Git rejects the marker.
 * Avoid both valid repositories and incomplete markers without modifying them. */
export async function createE2eTemporaryRoot(candidates = [
  tmpdir(),
  process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "Temp") : "/var/tmp",
]): Promise<string> {
  for (const candidate of new Set(candidates)) {
    let base: string;
    try {
      base = await realpath(candidate);
    } catch {
      continue;
    }
    let insideRepository = false;
    for (let parent = base; ; parent = dirname(parent)) {
      if (existsSync(join(parent, ".git"))) { insideRepository = true; break; }
      if (dirname(parent) === parent) break;
    }
    if (insideRepository) continue;
    try {
      return await mkdtemp(join(base, "aidlc-e2e-fixtures-"));
    } catch (error) {
      if (!["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("isolated e2e needs a writable OS temporary directory outside Git markers");
}

function command(
  bin: string, args: string[], cwd: string, env = process.env,
  timeout = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(bin, args, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => accept({ code: code ?? 1, stdout, stderr }));
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await command("git", args, cwd);
  if (result.code !== 0) throw new Error(`e2e worker git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

function dependencyRoot(source: string): string | undefined {
  for (let dir = source; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) return join(dir, "node_modules");
    if (dirname(dir) === dir) return undefined;
  }
}

async function linkDependencies(source: string | undefined, target: string): Promise<void> {
  if (source) await symlink(await realpath(source), join(target, "node_modules"), "junction");
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** lstat of a descendant alone still follows ancestor links. Walk from the
 * checkout before each size/copy access, allowing only a preserved leaf link. */
function snapshotStat(sourceRoot: string, path: string) {
  const root = resolve(sourceRoot);
  const file = resolve(path);
  if (!insideRoot(root, file)) throw new Error(`e2e snapshot path escapes checkout: ${path}`);
  const parts = relative(root, file).split(sep).filter(Boolean);
  let component = root;
  for (let index = 0; ; index++) {
    const stat = lstatSync(component, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (index === parts.length) {
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(component);
        if (isAbsolute(target) || win32.isAbsolute(target) || !insideRoot(root, resolve(dirname(component), target))) {
          throw new Error(`e2e snapshot refuses a shared or escaping symlink: ${component}`);
        }
      }
      return stat;
    }
    if (stat.isSymbolicLink()) throw new Error(`e2e snapshot refuses a symlink/reparse-point ancestor: ${component}`);
    if (!stat.isDirectory()) throw new Error(`e2e snapshot ancestor is not a directory: ${component}`);
    component = join(component, parts[index]);
  }
}

/** Preserve link bytes without letting a private checkout alias a shared target. */
async function copySnapshotEntry(from: string, to: string, sourceRoot: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter(path) {
      if (!snapshotStat(sourceRoot, path)) throw new Error(`e2e snapshot source disappeared while copying: ${path}`);
      return true;
    },
  });
}

/** Resolve caller-owned inputs before the test moves to its worker checkout. */
export function normalizeE2eExternalPaths(
  inherited: NodeJS.ProcessEnv, sourceRoot: string,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const seed = env.AIDLC_KIRO_IDE_SEED;
  if (seed && !isAbsolute(seed) && !win32.isAbsolute(seed)) {
    env.AIDLC_KIRO_IDE_SEED = resolve(sourceRoot, seed);
  }
  for (const key of [
    "AIDLC_BUN_BIN", "AIDLC_NODE_BIN", "AIDLC_KIRO_IDE_BIN",
    "AIDLC_CODEX_BIN", "AIDLC_COPILOT_BIN", "AIDLC_OPENCODE_BIN", "AIDLC_CURSOR_BIN",
  ]) {
    const value = env[key];
    if (
      value && !isAbsolute(value) && !win32.isAbsolute(value) &&
      (/[\\/]/.test(value) || value.startsWith(".") || /^[A-Za-z]:/.test(value))
    ) env[key] = resolve(sourceRoot, value);
  }
  return env;
}

/**
 * Freeze authored bytes once, including uncommitted changes, then give each
 * worker its own checkout and generated trees. Only dependencies and Git
 * objects are shared; mutable fixtures, dist and Git indexes are independent.
 */
export async function prepareE2eWorkers(
  source: string, runDir: string, count: number,
): Promise<E2eWorkerPool> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("e2e worker count must be positive");
  // Windows fixture consumers do not all support extended-length paths. A deep
  // report directory must not determine the checkout path they have to copy.
  const root = process.platform === "win32"
    ? await mkdtemp(join(process.env.SystemRoot || "C:\\Windows", "Temp", "ae-"))
    : join(runDir, "e2e-workers");
  const snapshot = join(root, "snapshot");
  await mkdir(root, { recursive: true });
  const sourceRevision = (await git(["rev-parse", "HEAD"], source)).trim();
  const sourceDirty = (await git(["status", "--porcelain"], source)).trim().length > 0;
  const dependencies = dependencyRoot(source);
  try {
    // Directory-only ignore rules can expose a node_modules symlink as an
    // untracked path. Dependencies are linked explicitly after authored copies.
    const paths = [...new Set((await git(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], source,
    )).split("\0").filter((path) =>
      path !== "" && path !== "node_modules" && !path.startsWith("node_modules/"),
    ))];
    const copyPaths = paths.filter((path) => snapshotStat(source, resolve(source, path)));
    const generatedPaths = ["dist", "dist-release"].filter((path) => existsSync(join(source, path)));
    const copyBytes = [...copyPaths, ...generatedPaths].reduce(
      (sum, path) => sum + allocatedCopyBytes(join(source, path), source), 0,
    );
    assertE2eDiskSpace(root, copyBytes * (count + 1));
    assertE2eDiskSpace(runDir);
    writeFileSync(join(runDir, "e2e-worker-storage.json"), `${JSON.stringify({
      root, workers: count, snapshotBytes: copyBytes, retained: true,
    }, null, 2)}\n`);
    // Default local cloning reuses object files, falling back to copies across
    // filesystems, without adding --shared alternate-reference layers.
    // Git rebases relative alternates incorrectly when locally cloning a linked
    // worktree. Transport cloning that source preserves its selected HEAD and
    // resolves borrowed objects before making the independent snapshot.
    const [gitDir, commonDir] = (await git(
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], source,
    )).trimEnd().split("\n");
    const transport = resolve(gitDir) !== resolve(commonDir) &&
      existsSync(join(commonDir, "objects", "info", "alternates"));
    await git([
      "clone", "--quiet", ...(transport ? ["--no-local"] : []), "--no-checkout", source, snapshot,
    ], source);
    await git(["read-tree", "HEAD"], snapshot);
    for (const path of paths) {
      const from = resolve(source, path);
      if (!snapshotStat(source, from)) continue; // Keep dangling links; omit deleted files.
      const destination = resolve(snapshot, path);
      if (!insideRoot(snapshot, destination)) {
        throw new Error(`e2e snapshot path escapes checkout: ${path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copySnapshotEntry(from, destination, source);
    }
    for (const generated of generatedPaths) {
      await copySnapshotEntry(join(source, generated), join(snapshot, generated), source);
    }
    const workers: E2eWorker[] = [];
    const namespace = `aidlc-e2e-${process.pid}-${randomUUID().slice(0, 8)}`;
    // Copying sequentially bounds disk pressure; execution begins once the
    // snapshot is complete, never while another worker is regenerating it.
    for (let id = 1; id <= count; id++) {
      const workerRoot = join(root, `worker-${id}`);
      await git(["clone", "--quiet", "--no-checkout", snapshot, workerRoot], source);
      await git(["read-tree", "HEAD"], workerRoot);
      for (const entry of readdirSync(snapshot)) {
        if (entry === ".git" || entry === "node_modules") continue;
        await copySnapshotEntry(join(snapshot, entry), join(workerRoot, entry), snapshot);
      }
      await linkDependencies(dependencies, workerRoot);
      workers.push({ id, root: workerRoot, socket: `${namespace}-${id}`, sourceRoot: resolve(source) });
    }
    return {
      root,
      workers,
      sourceRevision,
      sourceDirty,
      async dispose(preserve) {
        if (!preserve) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        writeFileSync(join(runDir, "e2e-worker-storage.json"), `${JSON.stringify({
          root, workers: count, snapshotBytes: copyBytes, retained: preserve,
        }, null, 2)}\n`);
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

/** Artifact ancestors may be shared; native launch evidence must not be. */
export function createE2eNativeRoot(artifactDir: string): string {
  const scope = resolve(artifactDir);
  const existing = nativeRoots.get(scope);
  if (existing) {
    ensurePrivateRoot(existing, "explicit");
    return existing;
  }
  const failures: unknown[] = [];
  for (const base of new Set([
    tmpdir(),
    process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "Temp") : "/var/tmp",
  ])) {
    let parent: string | undefined;
    try {
      parent = mkdtempSync(join(base, "aidlc-tui-root-"));
      const root = join(parent, "tui-bun");
      // A child directory also gets an explicit private DACL on Windows.
      ensurePrivateRoot(root, "explicit");
      nativeRoots.set(scope, root);
      return root;
    } catch (error) {
      if (parent) rmSync(parent, { recursive: true, force: true });
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "e2e needs an OS temporary directory with trusted native root ancestors");
}

export async function e2eWorkerEnvironment(
  worker: E2eWorker, file: string, artifactDir: string, inherited: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  // Never inherit the operator's native namespace or trust artifact ancestors.
  // Keep launch records outside TEMP until authenticated cleanup has completed.
  const nativeEnv = {
    ...normalizeE2eExternalPaths(inherited, worker.sourceRoot ?? process.cwd()),
    AIDLC_TEST_WORKER_ROOT: artifactDir,
    AIDLC_TUI_BUN_ROOT: createE2eNativeRoot(artifactDir),
  };
  // Re-running a file may reuse its artifact directory. Confirm any previous
  // daemon's retirement before the test can start another generation there.
  await cleanupNativeTransports(worker, nativeEnv);
  // Fixtures without their own .git must not inherit the runner checkout's
  // repository or parent application instructions. Logs can live in the
  // checkout; temporary projects must live outside it.
  const temp = await createE2eTemporaryRoot();
  const profile = join(artifactDir, "claude-config");
  await Promise.all([mkdir(temp, { recursive: true }), mkdir(profile, { recursive: true })]);
  const env: NodeJS.ProcessEnv = {
    ...nativeEnv,
    AIDLC_TEST_PACKAGE_READY: "1",
    AIDLC_TEST_WORKER_ID: String(worker.id),
    AIDLC_TEST_WORKER_ROOT: artifactDir,
    AIDLC_TEST_WORKER_PROCESS_GROUP: process.platform === "win32" ? "0" : "1",
    AIDLC_TEST_LOG_DIR: artifactDir,
    AIDLC_TEST_NAME: basename(file),
    AIDLC_TUI_TMUX_SOCKET: worker.socket,
    CLAUDE_CONFIG_DIR: profile,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    AIDLC_KIRO_IDE_DIAGNOSTICS: join(artifactDir, "kiro-ide.ndjson"),
    AIDLC_KIRO_IDE_SCREENSHOT: join(artifactDir, "kiro-ide.png"),
  };
  // An inherited explicit trace path would make unrelated workers overwrite it.
  delete env.AIDLC_SDK_TRACE_FILE;
  return env;
}

/** Preserve failed fixtures with the durable log artifacts after transports stop. */
export async function finishE2eTemporaryFiles(
  env: NodeJS.ProcessEnv, artifactDir: string, preserve: boolean,
): Promise<string | undefined> {
  if (env.AIDLC_TUI_BUN_ROOT) {
    const root = privateNativeRoot(env)!;
    const receipt = transportReceipts.get(env);
    if (receipt === undefined || receipt !== nativeInventorySignature(root)) {
      throw new Error(`e2e transport cleanup is unconfirmed or changed; fixtures retained: ${root}`);
    }
    if (resolve(artifactDir) !== resolve(env.AIDLC_TEST_WORKER_ROOT!)) {
      throw new Error("e2e native evidence destination differs from the file's artifact scope");
    }
    // Archives are diagnostics, never a live namespace: copied inode identities
    // cannot authorize commands. Copy before deleting either root or fixtures.
    await cp(root, join(artifactDir, "tui-bun"), { recursive: true });
    await rm(dirname(root), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    nativeRoots.delete(resolve(artifactDir));
    transportReceipts.delete(env);
  }
  const source = env.TEMP!;
  if (!preserve) {
    await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  const destination = join(artifactDir, "retained-fixtures");
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return destination;
}

function privateNativeRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.AIDLC_TUI_BUN_ROOT;
  if (!root) {
    if (selectedTuiBackend(env) === "bun") throw new Error("e2e native cleanup requires an explicit private AIDLC_TUI_BUN_ROOT");
    return undefined;
  }
  if (!env.AIDLC_TEST_WORKER_ROOT ||
    resolve(root) !== nativeRoots.get(resolve(env.AIDLC_TEST_WORKER_ROOT))) {
    throw new Error("e2e native cleanup refuses a root outside the file's artifact scope");
  }
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`e2e native cleanup requires a real private directory: ${root}`);
  }
  return resolve(root);
}

/** Native roots contain hashed session directories and persistent OS lock files.
 * Refuse links/unexpected entries instead of following them into another scope. */
function nativeSessionIds(root: string): string[] {
  const ids = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = /^([a-f0-9]{32})(\.lock)?$/.exec(entry.name);
    if (!match || entry.isSymbolicLink() ||
      (match[2] ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error(`unexpected entry in e2e native root: ${join(root, entry.name)}`);
    }
    ids.add(match[1]);
  }
  return [...ids].sort();
}

function nativeRecordText(root: string, id: string): string | null {
  const directory = join(root, id);
  try {
    if (!lstatSync(directory).isDirectory()) throw new Error(`e2e native session is not a real directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // Lock only; start has not made its directory.
    throw error;
  }
  const path = join(directory, "session.json");
  try {
    if (!lstatSync(path).isFile()) throw new Error(`e2e native record is not a regular file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (readdirSync(directory).length === 0) return null; // Interrupted before publication/spawn.
      throw new Error(`e2e native record missing from nonempty session; cleanup unconfirmed: ${directory}`);
    }
    throw error;
  }
}

function nativeInventorySignature(root: string): string {
  return JSON.stringify([root, nativeSessionIds(root).map((id) => [id, nativeRecordText(root, id)])]);
}

async function cleanupNativeTransports(worker: E2eWorker, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const root = privateNativeRoot(env);
  if (!root) return undefined;
  const ids = nativeSessionIds(root);
  if (!ids.length) return nativeInventorySignature(root);
  const [{ bunSessionPaths }, { acquireNativeLock }] = await Promise.all([
    import("../harness/tui-bun-backend.ts"), import("../harness/tui-process-identity.ts"),
  ]);
  const nativeEnv = { ...env, AIDLC_TUI_BACKEND: "bun", AIDLC_KEEP_TEMP: "1" };
  const runtime = resolveTuiRuntime(join(worker.root, "tests", "harness", "tui-drive.ts"), { env: nativeEnv });
  const confirmed = new Map<string, string | null>();
  const results = await Promise.allSettled(ids.map(async (id) => {
    const deadline = Date.now() + NATIVE_CLEANUP_MS;
    let unlock: (() => void) | undefined;
    // start publishes its record before spawning the detached daemon. Its lock
    // closes on client death, so cleanup can distinguish an interrupted launch
    // before publication from one whose daemon has not reached IPC readiness.
    while (!unlock) {
      try { unlock = await acquireNativeLock(join(root, `${id}.lock`)); }
      catch (error) {
        if (!String(error).includes("native lock already in progress") || Date.now() >= deadline) throw error;
        await pause(100);
      }
    }
    try {
      const initial = nativeRecordText(root, id);
      if (initial === null) { confirmed.set(id, null); return; }
      let token: string | undefined;
      const readRecord = () => {
        const text = nativeRecordText(root, id);
        if (text === null) throw new Error(`e2e native record disappeared: ${join(root, id)}`);
        const record = JSON.parse(text) as {
          schema?: number; backend?: string; session?: string; token?: string;
          endpoint?: string; cleanupComplete?: boolean;
        };
        if (record?.schema !== 1 || record.backend !== "bun" ||
          typeof record.session !== "string" || typeof record.token !== "string" ||
          record.token.length < 20) throw new Error(`invalid e2e native record: ${join(root, id)}`);
        const paths = bunSessionPaths(record.session, nativeEnv);
        if (paths.directory !== join(root, id) || paths.endpoint !== record.endpoint ||
          (token !== undefined && token !== record.token)) {
          throw new Error(`e2e native session ownership changed: ${join(root, id)}`);
        }
        token = record.token;
        return { record, text };
      };
      let lastFailure = "native daemon did not become ready";
      while (Date.now() < deadline) {
        const { record } = readRecord();
        const killed = await command(runtime.bin, [
          ...runtime.prefix, "kill", "--session", record.session!,
        ], worker.root, nativeEnv, Math.max(1, deadline - Date.now()));
        readRecord(); // A missing/replaced record must never become a no-op success.
        if (killed.code === 0 && Date.now() < deadline) {
          const remaining = Math.max(1, deadline - Date.now());
          const dead = await command(runtime.bin, [
            ...runtime.prefix, "wait-dead", "--session", record.session!,
            "--timeout-ms", String(Math.min(15_000, remaining)),
          ], worker.root, nativeEnv, remaining);
          const final = readRecord();
          if (dead.code === 0 && final.record.cleanupComplete === true) {
            confirmed.set(id, final.text);
            return;
          }
          lastFailure = dead.stderr.trim() || "native cleanupComplete was not confirmed";
        } else {
          lastFailure = killed.stderr.trim() || `native kill exited ${killed.code}`;
        }
        // kill writes the native stop marker if IPC is not ready. Retry through
        // the driver; never infer retirement from a missing endpoint or PID.
        await pause(100);
      }
      throw new Error(`e2e native cleanup unconfirmed: ${join(root, id)}: ${lastFailure}`);
    } finally { unlock(); }
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
  if (failures.length) throw new Error(failures.join("\n"));
  if (JSON.stringify(nativeSessionIds(root)) !== JSON.stringify(ids) ||
    ids.some((id) => nativeRecordText(root, id) !== confirmed.get(id))) {
    throw new Error(`e2e native sessions changed during cleanup; fixtures retained: ${root}`);
  }
  return nativeInventorySignature(root);
}

/** Reap only transports belonging to this worker; never target app names. */
export async function cleanupE2eTransports(worker: E2eWorker, env: NodeJS.ProcessEnv): Promise<void> {
  transportReceipts.delete(env);
  const receipt = await cleanupNativeTransports(worker, env);
  const backend = selectedTuiBackend(env);
  if (backend === "tmux") {
    try {
      const result = await command("tmux", ["-L", worker.socket, "kill-server"], worker.root, env);
      if (result.code !== 0 && !/no server running|no such file|error connecting/i.test(result.stderr)) {
        throw new Error(`e2e tmux cleanup failed: ${result.stderr}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (receipt !== undefined) transportReceipts.set(env, receipt);
    return;
  }
  // A Windows test can explicitly select node-pty while the runner defaults
  // to Bun. Inspect only its private legacy metadata, and resolve Node only
  // when there is actually legacy work to reap.
  const sessionRoot = join(env.TEMP!, "tui-drive");
  const legacyRecords = process.platform === "win32" && existsSync(sessionRoot)
    ? readdirSync(sessionRoot).map((entry) => join(sessionRoot, entry, "meta.json")).filter(existsSync)
    : [];
  const legacyEnv = { ...env, AIDLC_TUI_BACKEND: "node-pty", AIDLC_KEEP_TEMP: "0" };
  const runtime = legacyRecords.length
    ? resolveTuiRuntime(join(worker.root, "tests", "harness", "tui-drive.ts"), { env: legacyEnv })
    : undefined;
  for (const path of legacyRecords) {
    const meta = JSON.parse(readFileSync(path, "utf8")) as { session?: string };
    if (!meta.session) throw new Error(`e2e session metadata has no session: ${path}`);
    const result = await command(
      runtime!.bin,
      [...runtime!.prefix, "kill", "--session", meta.session],
      worker.root, legacyEnv, 60_000,
    );
    if (result.code !== 0) throw new Error(`e2e terminal cleanup failed: ${result.stderr}`);
  }
  if (receipt !== undefined) transportReceipts.set(env, receipt);
}

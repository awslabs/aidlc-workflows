import { spawnSync } from "node:child_process";
import { NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TestSourceEntry {
  path: string;
  kind: "file" | "symlink";
  sha256: string;
}

export interface TestSourceCapture {
  version: 1;
  sourceDigest: string;
  files: readonly TestSourceEntry[];
}

const hash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// e2e-workers enumerates authored files with the same Git command and excludes
// node_modules. Its separately copied dist trees are generated, not authored.
const excludedRoots = new Set([".git", "node_modules", "dist", "dist-release"]);

export interface SourceGitContext {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  spawn?: typeof spawnSync;
}

/** Read-only queries; one Windows premature-timeout recovery shares the same deadline. */
export function runTestSourceGit(root: string, args: string[], context: SourceGitContext = {}): string {
  if (!["rev-parse", "ls-files", "check-ignore"].includes(args[0])) {
    throw new Error("test source only permits read-only Git queries");
  }
  const timeoutMs = context.timeoutMs ?? NATIVE_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("test source Git timeout must be a positive supported millisecond budget");
  }
  const now = context.now ?? (() => performance.now());
  const started = now();
  const deadline = started + timeoutMs;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`test source Git ${args[0]} exceeded its ${timeoutMs}ms budget`);
    const result = (context.spawn ?? spawnSync)("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
      timeout: Math.max(1, Math.ceil(remaining)), maxBuffer: 32 * 1024 * 1024,
    });
    if (!result.error && result.status === 0) {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    }
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    // Bun 1.3.14 on Windows can return ETIMEDOUT within milliseconds after an
    // asynchronous gap longer than this query's budget. A fresh read succeeds.
    // Retry only that early transport timeout, once, using the remaining budget.
    if ((context.platform ?? process.platform) === "win32" && code === "ETIMEDOUT" &&
      attempt === 0 && now() < deadline) {
      process.stderr.write(`test source: retrying early Windows Git ${args[0]} timeout within the existing budget\n`);
      continue;
    }
    throw new Error(`test source Git ${args[0]} failed: status=${result.status}, ` +
      `signal=${result.signal}, code=${code ?? "none"}, errno=${(result.error as NodeJS.ErrnoException | undefined)?.errno ?? "none"}, ` +
      `elapsedMs=${Math.ceil(now() - started)}, budgetMs=${timeoutMs}, attempts=${attempt + 1}`);
  }
  throw new Error(`test source Git ${args[0]} failed`);
}

function paths(root: string): string[] {
  return [...new Set(runTestSourceGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0").filter(Boolean))]
    .filter((path) => !excludedRoots.has(path.split("/")[0]))
    .sort();
}

/** Receipt artifacts must not change the authored source identity they attest. */
export function testSourceOutputIsExcluded(root: string, output: string): boolean {
  const suffix = [basename(output)];
  let parent = dirname(resolve(output));
  while (!lstatSync(parent, { throwIfNoEntry: false })) {
    suffix.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  const rel = relative(realpathSync(root), join(realpathSync(parent), ...suffix));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return true;
  const first = rel.split(sep)[0];
  if (first === ".git" || first === "node_modules") return false;
  if (excludedRoots.has(first)) return true;
  const gitPath = rel.split(sep).join("/");
  // A force-added ignored path remains authored, including while deleted.
  if (runTestSourceGit(root, ["ls-files", "-z", "--cached", "--", gitPath]).split("\0").includes(gitPath)) return false;
  try { return runTestSourceGit(root, ["check-ignore", "--no-index", "--", rel]).trim().length > 0; }
  catch { return false; }
}

/** Content identity only: never hashes Git HEAD, timestamps, OS modes or root location. */
export function captureTestSource(root: string): TestSourceCapture {
  const absolute = realpathSync(resolve(root));
  if (realpathSync(runTestSourceGit(absolute, ["rev-parse", "--show-toplevel"]).trim()) !== absolute) {
    throw new Error("test source root must be the Git checkout root");
  }
  const inventory = paths(absolute);
  const entries = new Map<string, TestSourceEntry>();
  for (const path of inventory) {
    if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("test source has a non-portable Git path");
    }
    const rel = relative(absolute, resolve(absolute, path));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("test source path escapes checkout");
    }
    const parts = path.split("/");
    // An ancestor replaced with a symlink must contribute its link target,
    // never the external bytes of formerly tracked descendants.
    for (let index = 1; index <= parts.length; index++) {
      const name = parts.slice(0, index).join("/");
      const file = join(absolute, ...parts.slice(0, index));
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat) break; // Tracked deletion: omit it just as the worker snapshot does.
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(file);
        const portable = process.platform === "win32" ? target.replaceAll("\\", "/") : target;
        entries.set(name, { path: name, kind: "symlink", sha256: hash(portable) });
        break;
      }
      if (index !== parts.length) {
        if (!stat.isDirectory()) throw new Error(`test source ancestor is not a directory: ${name}`);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`test source requires files or symlinks, not a directory/submodule/special file: ${name}`);
      }
      const bytes = readFileSync(file);
      const after = lstatSync(file);
      if (
        !after.isFile() || stat.ino !== after.ino || stat.dev !== after.dev ||
        stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
      ) throw new Error(`test source changed during capture: ${name}`);
      entries.set(name, { path: name, kind: "file", sha256: hash(bytes) });
    }
  }
  if (JSON.stringify(inventory) !== JSON.stringify(paths(absolute))) {
    throw new Error("test source inventory changed during capture");
  }
  const files = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({
    version: 1,
    sourceDigest: hash(`aidlc-test-source-v1\n${JSON.stringify(files)}`),
    files: Object.freeze(files.map((entry) => Object.freeze(entry))),
  });
}

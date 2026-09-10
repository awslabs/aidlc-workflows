import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./aidlc-distribution.ts";
import {
  isMachineOwnedPath,
  machineTransactionRoot,
  windowsUninstallFencePath,
} from "./aidlc-install-paths.ts";
import { runWithOwnerStampedLock, withAuditLock } from "./aidlc-lib.ts";

export type TransactionOperation =
  | { kind: "write"; path: string; data: string; mode?: number; expected?: string | "absent" }
  | {
      kind: "copy";
      path: string;
      source: string;
      sourceHash: string;
      mode?: number;
      expected?: string | "absent";
    }
  | {
      kind: "tree";
      path: string;
      source: string;
      sourceHash: string;
      expected?: string | "absent";
    }
  | { kind: "remove"; path: string; expected?: string }
  | { kind: "symlink"; path: string; target: string; expected?: string | "absent" };

export type TransactionPlan = {
  schemaVersion: 1;
  root: string;
  operations: TransactionOperation[];
};

export type TransactionOptions = {
  failAfter?: number;
  failAt?: string;
  allowPendingWindowsUninstall?: boolean;
  validateLocked?: () => void;
  validateCandidates?: (candidateRoot: string) => void;
  validateCommitted?: () => void;
};

function normalizedRelative(path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`transaction path must be root-relative: ${path}`);
  const raw = path.replaceAll("\\", "/");
  if (raw.split("/").includes("..")) throw new Error(`transaction path escapes root: ${path}`);
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    throw new Error(`transaction path must name an entry below the root: ${path}`);
  }
  if (
    normalized === ".aidlc-transaction.lock" ||
    normalized.startsWith(".aidlc-lock-") ||
    normalized.startsWith(".aidlc-txn-") ||
    normalized.startsWith(".aidlc-recovery-")
  ) {
    throw new Error(`transaction path uses a reserved engine name: ${path}`);
  }
  return normalized;
}

function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  let cursor = absolute;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return suffix.reduce((current, entry) => join(current, entry), base);
}

function withinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// A project-and-machine route commits its project and machine changes as
// separate plans, each rooted in the tree it owns. A plan rooted in the project
// therefore never gets machine authority: when an install or command root sits
// inside the project (for example AIDLC_INSTALL_ROOT=<project>/aidlc), the
// project plan cannot reach it.
function enforceRouteMutationPlan(
  root: string,
  operations: readonly TransactionOperation[],
): void {
  const scope = process.env.AIDLC_ROUTE_MUTATION_SCOPE;
  if (!scope) return;
  const route = process.env.AIDLC_ROUTE_ID ?? "unknown";
  if (scope === "none") {
    throw new Error(`route ${route} does not permit filesystem mutation`);
  }
  const machineControlPaths = [windowsUninstallFencePath()].map(canonicalRoot);
  const projectValue = process.env.AIDLC_ROUTE_PROJECT_DIR;
  const projectRoot = projectValue ? canonicalRoot(projectValue) : null;
  const homeRoot = process.env.HOME ? canonicalRoot(process.env.HOME) : null;
  let machineRooted = false;
  if (scope === "project-and-machine") {
    const canonical = canonicalRoot(root);
    machineRooted = isMachineOwnedPath(canonical);
    if (!machineRooted) {
      try {
        machineRooted = canonical === canonicalRoot(machineTransactionRoot());
      } catch {
        machineRooted = false;
      }
    }
  }
  for (const operation of operations) {
    const rel = normalizedRelative(operation.path);
    const target = canonicalRoot(targetPath(root, rel));
    const isMachine = isMachineOwnedPath(target) ||
      machineControlPaths.includes(target);
    const isProject = !isMachine &&
      Boolean(projectRoot && withinRoot(target, projectRoot));
    const isUserHome = !isMachine &&
      Boolean(homeRoot && withinRoot(target, homeRoot));
    const permitted =
      (scope === "project" && isProject) ||
      (scope === "machine" && isMachine) ||
      (scope === "project-and-machine" && (machineRooted ? isMachine : isProject)) ||
      (scope === "user-home" && isUserHome);
    if (!permitted) {
      const rootClass = isMachine
        ? "machine"
        : isProject
        ? "project"
        : isUserHome
        ? "user-home"
        : "outside";
      const plan = scope === "project-and-machine"
        ? ` from a ${machineRooted ? "machine" : "project"}-rooted plan`
        : "";
      throw new Error(
        `route ${route} with ${scope} mutation scope cannot mutate ${rootClass} path ${target}${plan}`,
      );
    }
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function pendingWindowsUninstallBlocks(root: string): boolean {
  try {
    return root === canonicalRoot(machineTransactionRoot()) &&
      pathExists(windowsUninstallFencePath());
  } catch {
    return false;
  }
}

function nearestExisting(path: string): string {
  let current = path;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`transaction path has no existing filesystem ancestor: ${path}`);
    }
    current = parent;
  }
  return current;
}

function targetPath(root: string, path: string): string {
  const target = resolve(root, normalizedRelative(path));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`transaction path escapes root: ${path}`);
  }
  let cursor = dirname(target);
  while (cursor !== root && cursor.startsWith(root)) {
    if (pathExists(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`transaction path traverses a symlink: ${path}`);
    }
    cursor = dirname(cursor);
  }
  return target;
}

export function transactionState(path: string): string | "absent" {
  if (!pathExists(path)) return "absent";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  if (stat.isDirectory()) return `tree:${transactionSourceHash(path)}`;
  if (!stat.isFile()) return `type:${stat.mode}`;
  return sha256Bytes(readFileSync(path));
}

function validateTreeSource(path: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`${child}: transaction tree contains a link or special file`);
      }
      if (stat.isDirectory()) visit(child);
    }
  };
  visit(path);
}

export function transactionSourceHash(path: string): string {
  const root = lstatSync(path);
  if (root.isFile()) return sha256Bytes(readFileSync(path));
  if (!root.isDirectory()) throw new Error(`${path}: transaction source must be a file or directory`);
  const rows = [`directory . ${root.mode & 0o777}`];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const child = join(directory, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const stat = lstatSync(child);
      if (stat.isDirectory()) {
        rows.push(`directory ${rel} ${stat.mode & 0o777}`);
        visit(child, rel);
      } else if (stat.isFile()) {
        rows.push(`file ${rel} ${stat.mode & 0o777} ${sha256Bytes(readFileSync(child))}`);
      } else {
        throw new Error(`${child}: transaction tree contains a link or special file`);
      }
    }
  };
  visit(path, "");
  return sha256Bytes(rows.join("\n"));
}

function verifyPlan(plan: TransactionPlan, root: string): void {
  if (plan.schemaVersion !== 1) throw new Error(`unsupported transaction schema ${plan.schemaVersion}`);
  const seen = new Set<string>();
  const rootDevice = lstatSync(nearestExisting(root)).dev;
  for (const operation of plan.operations) {
    const rel = normalizedRelative(operation.path);
    if (
      seen.has(rel) ||
      [...seen].some((other) => rel.startsWith(`${other}/`) || other.startsWith(`${rel}/`))
    ) {
      throw new Error(`transaction operations overlap at ${rel}`);
    }
    seen.add(rel);
    const target = targetPath(root, rel);
    const existing = nearestExisting(target);
    if (lstatSync(existing).dev !== rootDevice) {
      throw new Error(`${rel}: transaction destination crosses a filesystem boundary`);
    }
    if (operation.expected && transactionState(target) !== operation.expected) {
      throw new Error(`${rel}: source changed after planning`);
    }
    if (operation.kind === "copy" || operation.kind === "tree") {
      if (!isAbsolute(operation.source)) throw new Error(`${rel}: copy source must be absolute`);
      const sourceStat = lstatSync(operation.source);
      if (operation.kind === "copy" && !sourceStat.isFile()) {
        throw new Error(`${rel}: copy source must be a regular file`);
      }
      if (operation.kind === "tree" && !sourceStat.isDirectory()) {
        throw new Error(`${rel}: tree source must be a directory`);
      }
      if (operation.kind === "tree") validateTreeSource(operation.source);
      if (transactionSourceHash(operation.source) !== operation.sourceHash) {
        throw new Error(`${rel}: transaction source changed after planning`);
      }
    }
    if (operation.kind === "symlink" && !isAbsolute(operation.target)) {
      throw new Error(`${rel}: symlink target must be absolute`);
    }
  }
}

export function validateTransactionPlan(plan: TransactionPlan): void {
  const root = canonicalRoot(plan.root);
  if (plan.operations.length > 0) enforceRouteMutationPlan(root, plan.operations);
  verifyPlan(plan, root);
}

function verifyExpectedState(
  operation: TransactionOperation,
  target: string,
  rel: string,
): void {
  if (
    operation.expected !== undefined &&
    transactionState(target) !== operation.expected
  ) {
    throw new Error(`${rel}: source changed after planning`);
  }
}

function failpoint(options: TransactionOptions, name: string): void {
  if (options.failAt === name) {
    throw new Error(`injected transaction failure at ${name}`);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves death. Permission, range, or platform errors must not
    // turn an unverifiable owner into permission to reclaim its lock.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function clearStaleLock(lockPath: string): void {
  const directory = pathExists(lockPath) && lstatSync(lockPath).isDirectory();
  const ownerPath = directory ? join(lockPath, "owner.json") : lockPath;
  let raw: string;
  try {
    if (directory && !lstatSync(ownerPath).isFile()) {
      throw new Error("directory owner is not a regular file");
    }
    raw = readFileSync(ownerPath, "utf-8");
  } catch (error) {
    if (!directory && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`cannot verify transaction lock ${lockPath}`);
  }
  let lock: { schemaVersion?: unknown; pid?: unknown; host?: unknown; token?: unknown } = {};
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    // An empty lock can survive only if its process exited between open and write.
  }
  if (
    directory &&
    (
      lock.schemaVersion !== 1 ||
      !Number.isSafeInteger(lock.pid) ||
      (lock.pid as number) <= 0 ||
      (lock.pid as number) > 2_147_483_647 ||
      typeof lock.token !== "string" ||
      !lock.token
    )
  ) {
    throw new Error(`cannot verify incomplete directory transaction lock ${lockPath}`);
  }
  if (directory && lock.host !== transactionHostIdentity()) {
    throw new Error(
      `transaction lock ${lockPath} belongs to another host or boot; ` +
      "directory locking requires one host and one shared mount",
    );
  }
  if (typeof lock.pid === "number" && processIsAlive(lock.pid)) {
    throw new Error(`another AI-DLC mutation holds ${lockPath}`);
  }
  const moved = join(dirname(lockPath), `.aidlc-lock-dead-${randomUUID()}`);
  try {
    renameSync(lockPath, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let movedRaw: string | null = null;
  try {
    movedRaw = readFileSync(directory ? join(moved, "owner.json") : moved, "utf-8");
  } catch {
    // Restore below: ownership cannot be proved after the atomic move.
  }
  if (movedRaw !== raw) {
    try {
      renameSync(moved, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    throw new Error(`another AI-DLC mutation holds ${lockPath}`);
  }
  rmSync(moved, { recursive: directory, force: true });
}

type HeldLock =
  | { kind: "hardlink"; descriptor: number; identity: string }
  | { kind: "directory"; identity: string };

export class TransactionFilesystemError extends Error {
  readonly remediation =
    "Use a mount that supports mutable files, exclusive creation, file synchronization, and file/directory rename, " +
    "or use local storage such as ext4 or XFS on EC2/EBS. Directory locking supports cooperating processes on one host using one shared mount.";

  constructor(
    readonly root: string,
    readonly operation: string,
    readonly code: string,
    cause: unknown,
  ) {
    super(
      `Cannot use the filesystem at ${root}: ${operation} failed (${code}).`,
      { cause },
    );
    this.name = "TransactionFilesystemError";
  }
}

export class TransactionLockError extends TransactionFilesystemError {
  constructor(root: string, code: string, cause: unknown) {
    super(root, "transaction locking", code, cause);
    this.message = `Cannot create an AI-DLC transaction lock in ${root}: hard-link and directory locking are unavailable (${code}).`;
    this.name = "TransactionLockError";
  }
}

const DIRECTORY_FALLBACK_CODES = new Set(["EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]);

function linkTransactionLock(root: string, candidate: string, lockPath: string): void {
  try {
    linkSync(candidate, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && DIRECTORY_FALLBACK_CODES.has(code)) {
      throw new TransactionLockError(root, code, error);
    }
    throw error;
  }
}

let transactionHost: string | undefined;

function transactionHostIdentity(): string {
  if (transactionHost) return transactionHost;
  let boot = "";
  if (process.platform === "linux") {
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
      // Without a boot identifier, conservatively retain PID-based ownership.
    }
  }
  transactionHost = sha256Bytes(`${process.platform}\0${hostname()}\0${boot}`);
  return transactionHost;
}

function acquireDirectoryLock(root: string, lockPath: string, staging: string): HeldLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt === 0) {
        clearStaleLock(lockPath);
        continue;
      }
      throw new TransactionLockError(root, (error as NodeJS.ErrnoException).code ?? "UNKNOWN", error);
    }
    const identity = `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      host: transactionHostIdentity(),
      token: randomUUID(),
      staging: basename(staging),
    })}\n`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(join(lockPath, "owner.json"), "wx", 0o600);
      writeSync(descriptor, identity);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      return { kind: "directory", identity };
    } catch (error) {
      try {
        if (descriptor !== null) closeSync(descriptor);
      } finally {
        // The local gate protects the incomplete-publication window. Older
        // clients see a directory at their lock-file path and refuse it.
        rmSync(lockPath, { recursive: true, force: true });
      }
      throw error;
    }
  }
  throw new Error(`cannot acquire ${lockPath}`);
}

function releaseTransactionLock(lockPath: string, lock: HeldLock): void {
  if (lock.kind === "hardlink") closeSync(lock.descriptor);
  const ownerPath = lock.kind === "directory" ? join(lockPath, "owner.json") : lockPath;
  try {
    if (readFileSync(ownerPath, "utf-8") === lock.identity) {
      rmSync(lockPath, { recursive: lock.kind === "directory", force: true });
    }
  } catch {
    // A replacement lock is not ours. Leave uncertain ownership untouched.
  }
}

function withTransactionLock(
  root: string,
  staging: string,
  operation: (lock: HeldLock) => void,
): void {
  const canonical = process.platform === "win32" ? root.toLowerCase() : root;
  const gate = join(realpathSync(tmpdir()), `.aidlc-transaction-${sha256Bytes(canonical).slice(7)}`);
  const lockPath = join(root, ".aidlc-transaction.lock");
  let entered = false;
  try {
    // Use the receipt-managed wrapper so a temporarily blocked release can be
    // recovered before the next transaction in this same process.
    withAuditLock(gate, () => {
      entered = true;
      const lock = acquireLock(root, lockPath, staging);
      try {
        operation(lock);
      } finally {
        releaseTransactionLock(lockPath, lock);
      }
    }, undefined, undefined, 0, 0);
  } catch (error) {
    if (entered) throw error;
    throw new Error(
      `another AI-DLC mutation holds ${lockPath}, or local transaction coordination is unavailable; ` +
      "all processes must use the same local temporary directory",
      { cause: error },
    );
  }
}

// Exercise required operations without touching the actual transaction lock
// or creating a missing project. Passing checks do not certify a mount's
// atomicity/durability contract or make independent mounts share a lock.
export function assertTransactionFilesystem(path: string): void {
  const root = canonicalRoot(path);
  const probe = mkdtempSync(join(nearestExisting(root), ".aidlc-lock-probe-"));
  const candidate = join(probe, "candidate");
  let descriptor: number | null = null;
  let failure: unknown;
  const check = (operation: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      if (error instanceof TransactionFilesystemError) throw error;
      throw new TransactionFilesystemError(
        root,
        operation,
        (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        error,
      );
    }
  };
  try {
    withTransactionLock(probe, join(probe, "staging"), () => {
      check("exclusive file creation and synchronization", () => {
        descriptor = openSync(candidate, "wx", 0o600);
        writeSync(descriptor, "before");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        let rejected = false;
        try {
          const duplicate = openSync(candidate, "wx", 0o600);
          closeSync(duplicate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          rejected = true;
        }
        if (!rejected) throw new Error("exclusive creation replaced an existing file");
      });
      check("mutable file append and descriptor identity", () => {
        descriptor = openSync(candidate, "a+");
        writeSync(descriptor, "after");
        fsyncSync(descriptor);
        const opened = fstatSync(descriptor);
        const current = lstatSync(candidate);
        if (opened.dev !== current.dev || opened.ino !== current.ino || current.nlink !== 1) {
          throw new Error("the open descriptor does not identify the published file");
        }
        closeSync(descriptor);
        descriptor = null;
        if (readFileSync(candidate, "utf-8") !== "beforeafter") {
          throw new Error("appended content was not preserved");
        }
      });
      check("file replacement by rename", () => {
        const target = join(probe, "target");
        writeFileSync(target, "old");
        renameSync(candidate, target);
        if (pathExists(candidate) || readFileSync(target, "utf-8") !== "beforeafter") {
          throw new Error("rename did not publish the replacement");
        }
      });
      check("directory rename", () => {
        const source = join(probe, "source-tree");
        const target = join(probe, "target-tree");
        mkdirSync(source);
        writeFileSync(join(source, "child"), "tree");
        renameSync(source, target);
        if (pathExists(source) || readFileSync(join(target, "child"), "utf-8") !== "tree") {
          throw new Error("directory rename did not preserve its contents");
        }
      });
      if (process.platform !== "win32") {
        check("file permissions", () => {
          const target = join(probe, "target");
          chmodSync(target, 0o600);
          if ((lstatSync(target).mode & 0o777) !== 0o600) {
            throw new Error("file permissions are not retained");
          }
        });
      }
      check("workflow lock coordination", () => {
        const locked = runWithOwnerStampedLock(join(probe, "workflow-lock"), 0, 0, () => undefined);
        if (!locked.acquired) throw new Error("the mount cannot coordinate workflow locks");
      });
      check("directory synchronization", () => syncPath(probe));
    });
  } catch (error) {
    failure = error instanceof TransactionLockError
      ? new TransactionLockError(root, error.code, error)
      : error instanceof TransactionFilesystemError
      ? error
      : new TransactionFilesystemError(
        root,
        "transaction lock coordination",
        (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
        error,
      );
  }
  // A close error must not skip removal or hide the original lock diagnostic.
  let closeError: unknown;
  try {
    if (descriptor !== null) closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  try {
    rmSync(probe, { recursive: true, force: true });
  } catch (cleanupError) {
    const primary = failure instanceof Error ? `${failure.message} ` : "";
    throw new AggregateError(
      [failure, closeError, cleanupError].filter((error) => error !== undefined),
      `${primary}Could not remove temporary transaction lock probe ${probe}: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
  }
  if (failure !== undefined) throw failure;
  if (closeError !== undefined) throw closeError;
}

function acquireLock(root: string, lockPath: string, staging: string): HeldLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = join(root, `.aidlc-lock-${randomUUID()}`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(candidate, "wx", 0o600);
      const identity = `${JSON.stringify({ pid: process.pid, staging: basename(staging) })}\n`;
      writeSync(descriptor, identity);
      fsyncSync(descriptor);
      linkTransactionLock(root, candidate, lockPath);
      rmSync(candidate, { force: true });
      return { kind: "hardlink", descriptor, identity };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(candidate, { force: true });
      if (error instanceof TransactionLockError) {
        return acquireDirectoryLock(root, lockPath, staging);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      clearStaleLock(lockPath);
    }
  }
  throw new Error(`cannot acquire ${lockPath}`);
}

function quarantineOrphanStaging(root: string, current: string): void {
  for (const entry of readdirSync(root)) {
    if (
      entry !== basename(current) &&
      /^\.aidlc-txn-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry)
    ) {
      renameSync(
        join(root, entry),
        join(root, `.aidlc-recovery-${Date.now()}-${randomUUID()}`),
      );
      syncPath(root);
    }
  }
}

function snapshot(target: string, backup: string): void {
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
  cpSync(target, backup, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function stageCandidate(operation: TransactionOperation, candidate: string): void {
  mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
  if (operation.kind === "write") {
    writeFileSync(candidate, Buffer.from(operation.data, "base64"), {
      mode: operation.mode ?? 0o644,
    });
  } else if (operation.kind === "copy") {
    copyFileSync(operation.source, candidate);
    if (operation.mode !== undefined) chmodSync(candidate, operation.mode);
  } else if (operation.kind === "tree") {
    cpSync(operation.source, candidate, { recursive: true, preserveTimestamps: true });
  } else if (operation.kind === "symlink") {
    symlinkSync(operation.target, candidate);
  }
  if (
    (operation.kind === "copy" || operation.kind === "tree") &&
    transactionSourceHash(candidate) !== operation.sourceHash
  ) {
    throw new Error(`${operation.path}: transaction source changed while staging`);
  }
}

function syncPath(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupportedWindowsSync =
      process.platform === "win32" && code === "EPERM";
    if (
      !unsupportedWindowsSync &&
      !["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code ?? "") &&
      !(
        ["ENOSYS", "EOPNOTSUPP"].includes(code ?? "") &&
        lstatSync(path).isDirectory()
      )
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    syncPath(dirname(path));
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) syncTree(join(path, entry));
  }
  syncPath(path);
}

export function executePlan(
  plan: TransactionPlan,
  options: TransactionOptions = {},
): void {
  const root = canonicalRoot(plan.root);
  if (plan.operations.length > 0) {
    enforceRouteMutationPlan(root, plan.operations);
  }
  // Reject invalid plans before creating the transaction root, then recheck
  // under the lock to close the preflight race.
  verifyPlan(plan, root);
  if (plan.operations.length === 0) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = join(root, `.aidlc-txn-${randomUUID()}`);
  withTransactionLock(root, staging, (lock) => {
  let preserveStaging = false;
  const committed: Array<{
    rel: string;
    existed: boolean;
    state: string | "absent";
    displaced: boolean;
  }> = [];
  try {
    failpoint(options, "after-lock");
    if (lock.kind === "directory") assertTransactionFilesystem(root);
    if (
      !options.allowPendingWindowsUninstall &&
      pendingWindowsUninstallBlocks(root)
    ) {
      throw new Error(
        "a pending Windows uninstall blocks machine mutation; run aidlc doctor",
      );
    }
    quarantineOrphanStaging(root, staging);
    options.validateLocked?.();
    failpoint(options, "before-plan-validation");
    verifyPlan(plan, root);
    failpoint(options, "after-plan-validation");
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const candidates = join(staging, "candidates");
    mkdirSync(candidates, { recursive: true, mode: 0o700 });
    for (const [index, operation] of plan.operations.entries()) {
      const boundary = `${index + 1}:${operation.kind}`;
      failpoint(options, `before-stage:${boundary}`);
      if (operation.kind !== "remove") {
        stageCandidate(operation, join(candidates, normalizedRelative(operation.path)));
      }
      failpoint(options, `after-stage:${boundary}`);
    }
    syncTree(candidates);
    failpoint(options, "before-candidate-validation");
    options.validateCandidates?.(candidates);
    failpoint(options, "after-candidate-validation");
    for (const [index, operation] of plan.operations.entries()) {
      const boundary = `${index + 1}:${operation.kind}`;
      failpoint(options, `before-snapshot:${boundary}`);
      const rel = normalizedRelative(operation.path);
      const target = targetPath(root, rel);
      verifyExpectedState(operation, target, rel);
      if (pathExists(target)) snapshot(target, join(staging, "backups", rel));
      failpoint(options, `after-snapshot:${boundary}`);
    }
    let committedCount = 0;
    const failAfter = options.failAfter ?? 0;
    for (const [index, operation] of plan.operations.entries()) {
      const boundary = `${index + 1}:${operation.kind}`;
      failpoint(options, `before-commit:${boundary}`);
      const rel = normalizedRelative(operation.path);
      const target = targetPath(root, rel);
      verifyExpectedState(operation, target, rel);
      const existed = pathExists(target);
      let displaced = false;
      if (operation.kind === "remove") {
        if (existed) {
          const removed = join(staging, "removed", rel);
          mkdirSync(dirname(removed), { recursive: true, mode: 0o700 });
          renameSync(target, removed);
        }
      } else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const candidate = join(candidates, rel);
        if (operation.kind === "tree" && existed) {
          const removed = join(staging, "removed", rel);
          mkdirSync(dirname(removed), { recursive: true, mode: 0o700 });
          renameSync(target, removed);
          try {
            renameSync(candidate, target);
            displaced = true;
          } catch (error) {
            renameSync(removed, target);
            throw error;
          }
        } else {
          renameSync(candidate, target);
        }
      }
      committed.push({
        rel,
        existed,
        state: transactionState(target),
        displaced,
      });
      // The rename is live even if the following durability sync fails.
      syncPath(dirname(target));
      committedCount++;
      failpoint(options, `after-commit:${boundary}`);
      if (failAfter > 0 && committedCount === failAfter) {
        throw new Error(`injected transaction failure after operation ${committedCount}`);
      }
    }
    failpoint(options, "before-committed-validation");
    options.validateCommitted?.();
    failpoint(options, "after-committed-validation");
    rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const entry of [...committed].reverse()) {
      try {
        const target = targetPath(root, entry.rel);
        failpoint(options, `during-rollback:${entry.rel}`);
        if (transactionState(target) !== entry.state) {
          throw new Error(`${entry.rel}: destination changed during rollback`);
        }
        if (entry.existed) {
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          if (entry.displaced) {
            rmSync(target, { recursive: true, force: true });
            renameSync(join(staging, "removed", entry.rel), target);
          } else {
            const backup = join(staging, "backups", entry.rel);
            renameSync(backup, target);
          }
        } else {
          rmSync(target, { recursive: true, force: true });
        }
        syncPath(dirname(target));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      preserveStaging = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        `transaction rollback incomplete; recovery evidence preserved at ${staging}`,
      );
    }
    throw error;
  } finally {
    if (!preserveStaging) rmSync(staging, { recursive: true, force: true });
  }
  });
}

export function writeOperation(
  path: string,
  value: string | Buffer,
  expected?: string | "absent",
  mode?: number,
): TransactionOperation {
  return {
    kind: "write",
    path,
    data: Buffer.from(value).toString("base64"),
    expected,
    mode,
  };
}

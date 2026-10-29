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
  type Stats,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./aidlc-distribution.ts";
import {
  isMachineOwnedPath,
  machineTransactionRoot,
  windowsUninstallFencePath,
} from "./aidlc-install-paths.ts";
import {
  processGeneration,
  processStartedAtMs,
  runWithOwnerStampedLock,
  unstampedPastGrace,
  withAuditLock,
} from "./aidlc-lib.ts";

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

// What a transaction tree can hold: regular files and folders, never a link,
// a junction or a special file.
export function transactionCarries(stat: Stats): boolean {
  return stat.isFile() || stat.isDirectory();
}

function validateTreeSource(path: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      const stat = lstatSync(child);
      if (!transactionCarries(stat)) {
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
      if (!transactionCarries(stat)) {
        throw new Error(`${child}: transaction tree contains a link or special file`);
      }
      if (stat.isDirectory()) {
        rows.push(`directory ${rel} ${stat.mode & 0o777}`);
        visit(child, rel);
      } else {
        rows.push(`file ${rel} ${stat.mode & 0o777} ${sha256Bytes(readFileSync(child))}`);
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

// A killed holder's PID can pass to a later process, which cannot hold a lock
// written before it started. Locks record the holder's process generation;
// a lock from a release that recorded none is judged by when it was written,
// with a margin for timestamp rounding and small clock steps.
const LATER_PROCESS_MARGIN_MS = 2_000;

function heldByLaterProcess(pid: number, recorded: unknown, ownerPath: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  if (typeof recorded === "string" && recorded) {
    const observed = processGeneration(pid);
    return observed !== null && observed !== recorded;
  }
  const started = processStartedAtMs(pid);
  if (started === null) return false;
  try {
    return started > lstatSync(ownerPath).mtimeMs + LATER_PROCESS_MARGIN_MS;
  } catch {
    return false;
  }
}

function clearStaleLock(lockPath: string): void {
  // The lock can go at any moment, since its holder may not share the local
  // gate (a release from before it): one look here, and a lock gone by the
  // owner read below is free for the caller's next attempt.
  let directory = false;
  try {
    directory = lstatSync(lockPath).isDirectory();
  } catch {
    // Read below as a file lock, as an absent one is.
  }
  const ownerPath = directory ? join(lockPath, "owner.json") : lockPath;
  // Null: a directory lock with no owner.json at all.
  let raw: string | null;
  let unfinished = false;
  try {
    if (directory && !lstatSync(ownerPath).isFile()) {
      throw new Error("directory owner is not a regular file");
    }
    raw = readFileSync(ownerPath, "utf-8");
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (absent && (!directory || !pathExists(lockPath))) return;
    if (!absent) throw transactionLockUnreadable(lockPath, error);
    if (!unstampedPastGrace(lockPath)) throw new TransactionBusyError(lockPath);
    raw = null;
    unfinished = true;
  }
  let lock: {
    schemaVersion?: unknown;
    pid?: unknown;
    host?: unknown;
    machine?: unknown;
    boot?: unknown;
    token?: unknown;
    processGeneration?: unknown;
  } = {};
  let parsed = false;
  try {
    lock = JSON.parse(raw ?? "") as typeof lock;
    parsed = true;
  } catch {
    // An empty lock can survive only if its process exited between open and write.
  }
  // A live holder stamps its folder under the local gate withTransactionLock
  // holds around this call, so a directory stamp that never finished (none,
  // empty, or cut off before it parses) is what a command killed between
  // making the folder and stamping it leaves. Past the grace, which covers a
  // writer outside that gate, it is cleared like a dead owner's; the move and
  // verify below are the second look. A stamp that parses keeps every check.
  unfinished ||= directory && !parsed && unstampedPastGrace(lockPath);
  // Within the grace a stamp that does not parse yet is a holder still writing
  // it; one that parses with the wrong shape (a newer release's, or damaged)
  // never changes by waiting.
  if (directory && !unfinished && !parsed) throw new TransactionBusyError(lockPath);
  if (
    directory &&
    !unfinished &&
    (
      lock.schemaVersion !== 1 ||
      !Number.isSafeInteger(lock.pid) ||
      (lock.pid as number) <= 0 ||
      (lock.pid as number) > 2_147_483_647 ||
      typeof lock.token !== "string" ||
      !lock.token
    )
  ) {
    throw transactionLockUnreadable(lockPath);
  }
  const foreign = directory && !unfinished && lock.host !== transactionHostIdentity().host;
  // The same computer under another boot: its holder died with that boot, so
  // no pid it names can still be the holder.
  const diedWithBoot = foreign && typeof lock.boot === "string" &&
    lock.machine === transactionHostIdentity().machine && lock.boot !== transactionHostIdentity().boot;
  if (foreign && !diedWithBoot) throw transactionLockElsewhere(lockPath, typeof lock.machine === "string");
  if (
    !diedWithBoot &&
    typeof lock.pid === "number" &&
    processIsAlive(lock.pid) &&
    !heldByLaterProcess(lock.pid, lock.processGeneration, ownerPath)
  ) {
    throw new TransactionBusyError(lockPath);
  }
  const moved = join(dirname(lockPath), `.aidlc-lock-dead-${randomUUID()}`);
  try {
    renameSync(lockPath, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let movedRaw: string | null | undefined;
  try {
    movedRaw = readFileSync(directory ? join(moved, "owner.json") : moved, "utf-8");
  } catch (error) {
    // Restore below: ownership cannot be proved after the atomic move, unless
    // the owner is still as absent as it was judged.
    if (raw === null && (error as NodeJS.ErrnoException).code === "ENOENT") movedRaw = null;
  }
  if (movedRaw !== raw) {
    try {
      renameSync(moved, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    throw new TransactionBusyError(lockPath);
  }
  rmSync(moved, { recursive: directory, force: true });
  process.stderr.write(
    "aidlc: an earlier AI-DLC command stopped before it finished, so its lock was cleared.\n",
  );
}

type HeldLock = { identity: string };

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
    this.message = `Cannot create an AI-DLC transaction lock in ${root} (${code}).`;
    this.name = "TransactionLockError";
  }
}

// For a command that prints its failure as one line (plugin select and sync):
// a transaction error keeps its fix, as config's error and fix pair does.
export function withTransactionFix(error: unknown, message: string): string {
  return error instanceof TransactionFilesystemError ? `${message} fix: ${error.remediation}` : message;
}

// A lock this command cannot clear by itself, in the person's words, with the
// way on. Its own message and fix replace the storage words of its parent,
// whose branch in the config handler prints them.
export class TransactionLockStateError extends TransactionFilesystemError {
  override readonly remediation: string;

  constructor(lockPath: string, message: string, remediation: string, cause?: unknown) {
    super(dirname(lockPath), "transaction locking", "EEXIST", cause);
    this.message = message;
    this.remediation = remediation;
    this.name = new.target.name;
  }
}

// Another AI-DLC command holds the lock now; update and the plugin sync retry
// on exactly this class.
export class TransactionBusyError extends TransactionLockStateError {
  constructor(lockPath: string, cause?: unknown) {
    super(
      lockPath,
      `another AI-DLC command is still working in ${dirname(lockPath)}.`,
      "wait for it to finish, then run this command again.",
      cause,
    );
  }
}

// A stamp from another computer that shares this folder, or, for a stamp with
// no machine (2.11.2's), from this computer before it restarted: nothing here
// can prove its holder stopped.
function transactionLockElsewhere(lockPath: string, machineRecorded: boolean): TransactionLockStateError {
  return new TransactionLockStateError(
    lockPath,
    machineRecorded
      ? `an AI-DLC command on another computer is working in ${dirname(lockPath)}, or left its lock there.`
      : `an AI-DLC command on another computer, or on this one before it restarted, is working in ${dirname(lockPath)} or left its lock there.`,
    `wait for it to finish, then run this command again; if none is running there, delete the folder ${lockPath} first.`,
  );
}

function transactionLockUnreadable(lockPath: string, cause?: unknown): TransactionLockStateError {
  return new TransactionLockStateError(
    lockPath,
    `${lockPath} cannot be read.`,
    "if no AI-DLC command is running, delete that folder, then run this command again.",
    cause,
  );
}

let transactionHost: { host: string; machine: string; boot?: string } | undefined;

// `host` is what every release stamps and compares; `machine` and `boot` tell a
// restart of this computer apart from another computer.
function transactionHostIdentity(): { host: string; machine: string; boot?: string } {
  if (transactionHost) return transactionHost;
  let boot = "";
  if (process.platform === "linux") {
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
      // Without a boot identifier, conservatively retain PID-based ownership.
    }
  }
  transactionHost = {
    host: sha256Bytes(`${process.platform}\0${hostname()}\0${boot}`),
    machine: sha256Bytes(`${process.platform}\0${hostname()}`),
    ...(boot ? { boot: sha256Bytes(boot) } : {}),
  };
  return transactionHost;
}

// Omitted where the platform has no generation; older releases ignore it.
function processGenerationField(): { processGeneration?: string } {
  const generation = processGeneration(process.pid);
  return generation ? { processGeneration: generation } : {};
}

function acquireDirectoryLock(root: string, lockPath: string, staging: string): HeldLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Taken again after a dead holder's was cleared: another command has it.
        if (attempt > 0) throw new TransactionBusyError(lockPath, error);
        clearStaleLock(lockPath);
        continue;
      }
      throw new TransactionLockError(root, (error as NodeJS.ErrnoException).code ?? "UNKNOWN", error);
    }
    const identity = `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      ...transactionHostIdentity(),
      token: randomUUID(),
      staging: basename(staging),
      ...processGenerationField(),
    })}\n`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(join(lockPath, "owner.json"), "wx", 0o600);
      writeSync(descriptor, identity);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      return { identity };
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
  try {
    if (readFileSync(join(lockPath, "owner.json"), "utf-8") === lock.identity) {
      rmSync(lockPath, { recursive: true, force: true });
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
      const lock = acquireDirectoryLock(root, lockPath, staging);
      try {
        operation(lock);
      } finally {
        releaseTransactionLock(lockPath, lock);
      }
    }, undefined, undefined, 0, 0);
  } catch (error) {
    if (entered) throw error;
    throw new TransactionBusyError(lockPath, error);
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
    const aggregate = new AggregateError(
      [failure, closeError, cleanupError].filter((error) => error !== undefined),
      `${primary}Could not remove temporary transaction lock probe ${probe}: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`,
    );
    // Keep the filesystem error's type, and so its storage fix, with the
    // cleanup diagnostic added.
    if (failure instanceof TransactionLockError) {
      const error = new TransactionLockError(failure.root, failure.code, aggregate);
      error.message = aggregate.message;
      throw error;
    }
    if (failure instanceof TransactionFilesystemError) {
      const error = new TransactionFilesystemError(failure.root, failure.operation, failure.code, aggregate);
      error.message = aggregate.message;
      throw error;
    }
    throw aggregate;
  }
  if (failure !== undefined) throw failure;
  if (closeError !== undefined) throw closeError;
}

function quarantineOrphanStaging(root: string, current: string): void {
  for (const entry of readdirSync(root)) {
    if (
      entry !== basename(current) &&
      /^\.aidlc-txn-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry)
    ) {
      // A committed plan's staging folder holds nothing to recover.
      if (existsSync(join(root, entry, STAGING_COMMITTED))) {
        removeStaging(join(root, entry));
        continue;
      }
      renameSync(
        join(root, entry),
        join(root, `.aidlc-recovery-${Date.now()}-${randomUUID()}`),
      );
      syncPath(root);
    }
  }
}

// Marks a staging folder whose plan committed, so a folder left behind is
// removed by the next run instead of kept as recovery evidence.
const STAGING_COMMITTED = "committed";
const BUSY_REMOVE_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const STAGING_REMOVE_ATTEMPTS = 30;
const STAGING_REMOVE_RETRY_MS = 100;

// On Windows an editor's file watcher or a virus scan can hold a file in the
// staging folder for a moment after the plan committed. Bun's rmSync ignores
// maxRetries, so retry here. False when the folder is still there.
function removeStaging(staging: string): boolean {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(staging, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (
        !BUSY_REMOVE_CODES.has((error as NodeJS.ErrnoException).code ?? "") ||
        attempt >= STAGING_REMOVE_ATTEMPTS
      ) {
        return false;
      }
      Bun.sleepSync(STAGING_REMOVE_RETRY_MS);
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

// A rename the storage cannot do at all (Mountpoint for Amazon S3) is said as
// the first-run storage check says it, with its storage fix; every other
// failure stays as it is.
const UNSUPPORTED_RENAME_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function commitRename(root: string, from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !UNSUPPORTED_RENAME_CODES.has(code)) throw error;
    const directory = lstatSync(from, { throwIfNoEntry: false })?.isDirectory() ?? false;
    throw new TransactionFilesystemError(root, directory ? "directory rename" : "file replacement by rename", code, error);
  }
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
  withTransactionLock(root, staging, () => {
  let preserveStaging = false;
  // Every operation is in place: what is left in the staging folder is only
  // its scratch, and a failure to remove it never undoes or fails the plan.
  let committedPlan = false;
  const committed: Array<{
    rel: string;
    existed: boolean;
    state: string | "absent";
    displaced: boolean;
  }> = [];
  try {
    failpoint(options, "after-lock");
    if (
      !options.allowPendingWindowsUninstall &&
      pendingWindowsUninstallBlocks(root)
    ) {
      throw new Error(
        "a pending Windows uninstall blocks machine mutation; run doctor to see what is pending",
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
          commitRename(root, target, removed);
        }
      } else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const candidate = join(candidates, rel);
        if (operation.kind === "tree" && existed) {
          const removed = join(staging, "removed", rel);
          mkdirSync(dirname(removed), { recursive: true, mode: 0o700 });
          commitRename(root, target, removed);
          try {
            commitRename(root, candidate, target);
            displaced = true;
          } catch (error) {
            renameSync(removed, target);
            throw error;
          }
        } else {
          commitRename(root, candidate, target);
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
    committedPlan = true;
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
    if (committedPlan) {
      try {
        writeFileSync(join(staging, STAGING_COMMITTED), "");
      } catch {
        // Unmarked, a folder left behind is kept as recovery evidence instead.
      }
      removeStaging(staging);
    } else if (!preserveStaging) {
      // A busy folder must not hide the error that stopped the plan; one left
      // here is unmarked, so the next run keeps it as recovery evidence.
      removeStaging(staging);
    }
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

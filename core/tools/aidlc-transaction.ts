import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
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
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { sha256Bytes } from "./aidlc-distribution.ts";
import {
  binRoot,
  installRoot,
  machineTransactionRoot,
  windowsUninstallFencePath,
} from "./aidlc-install-paths.ts";

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
  const machineRoots = [installRoot(), binRoot()].map(canonicalRoot);
  const machineControlPaths = [windowsUninstallFencePath()].map(canonicalRoot);
  const projectValue = process.env.AIDLC_ROUTE_PROJECT_DIR;
  const projectRoot = projectValue ? canonicalRoot(projectValue) : null;
  const homeRoot = process.env.HOME ? canonicalRoot(process.env.HOME) : null;
  for (const operation of operations) {
    const rel = normalizedRelative(operation.path);
    const target = canonicalRoot(targetPath(root, rel));
    const isMachine = machineRoots.some((machineRoot) => withinRoot(target, machineRoot)) ||
      machineControlPaths.includes(target);
    const isProject = Boolean(projectRoot && withinRoot(target, projectRoot));
    const isUserHome = Boolean(homeRoot && withinRoot(target, homeRoot));
    const permitted =
      (scope === "project" && isProject) ||
      (scope === "machine" && isMachine) ||
      (scope === "project-and-machine" && (isProject || isMachine)) ||
      (scope === "user-home" && isUserHome);
    if (!permitted) {
      const rootClass = isMachine
        ? "machine"
        : isProject
        ? "project"
        : isUserHome
        ? "user-home"
        : "outside";
      throw new Error(
        `route ${route} with ${scope} mutation scope cannot mutate ${rootClass} path ${target}`,
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
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function clearStaleLock(lockPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`cannot verify transaction lock ${lockPath}`);
  }
  let lock: { pid?: unknown } = {};
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    // An empty lock can survive only if its process exited between open and write.
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
    movedRaw = readFileSync(moved, "utf-8");
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
  rmSync(moved, { force: true });
}

type HeldLock = {
  descriptor: number;
  identity: string;
};

function acquireLock(root: string, lockPath: string, staging: string): HeldLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = join(root, `.aidlc-lock-${randomUUID()}`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(candidate, "wx", 0o600);
      const identity = `${JSON.stringify({ pid: process.pid, staging: basename(staging) })}\n`;
      writeSync(descriptor, identity);
      fsyncSync(descriptor);
      linkSync(candidate, lockPath);
      rmSync(candidate, { force: true });
      return { descriptor, identity };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(candidate, { force: true });
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
      !["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code ?? "")
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
  const lockPath = join(root, ".aidlc-transaction.lock");
  const staging = join(root, `.aidlc-txn-${randomUUID()}`);
  let lock: HeldLock | null = null;
  let preserveStaging = false;
  const committed: Array<{
    rel: string;
    existed: boolean;
    state: string | "absent";
    displaced: boolean;
  }> = [];
  try {
    lock = acquireLock(root, lockPath, staging);
    failpoint(options, "after-lock");
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
    if (lock !== null) {
      closeSync(lock.descriptor);
      try {
        if (readFileSync(lockPath, "utf-8") === lock.identity) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // A safely reclaimed or already-removed lock is no longer ours.
      }
    }
  }
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

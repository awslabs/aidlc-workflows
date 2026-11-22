// Atomic file writes and the locks: writeFileAtomic and writeBufferAtomic, the
// per-intent and workspace audit locks with their owner stamps and reaper, the
// directive lock, and the doctor probe for leaked locks. With them ride the
// helpers they use: the workspace record roots (activeSpace, intentsDir and the
// space and engine folders), the read-only engine probes and the observer-write
// refusal, errorMessage and isPlainObject. aidlc-lib.ts re-exports the names it
// exported before, so its callers are unchanged, and it loads this module at
// start: nothing here may import aidlc-lib.ts.
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { lockFolderHeldGiveUpMs } from "./aidlc-lock-line.ts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep, win32 } from "node:path";
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { knownActiveSpace } from "./aidlc-runtime-paths.ts";

export const ENGINE_DIR = ".aidlc-engine";
// Debris the pre-lock (#749-era) marker writer could leave at the record root.
const LEGACY_ACTIVE_DIRECTIVE_TRANSACTION_FILE = ".aidlc-active-directive.json.transaction";

// --- Workspace selectors: space + intent ---------------------------------------
//
// The record (state · audit · artifacts · diary) re-roots per INTENT under a
// per-team SPACE: `aidlc/spaces/<space>/intents/<slug>-<id8>/…`. Two cursors
// pick the active space/intent, both GITIGNORED (per-user, not shared truth):
//   - `aidlc/active-space`                            → the active space
//   - `aidlc/spaces/<space>/intents/active-intent`    → that space's active intent
//
// Resolution precedence (vision §5):
//   space:  explicit arg > active-space pointer > "default" (NEVER errors).
//   intent: explicit arg > active-intent pointer > lone-intent > null.
//
// NULL RESOLUTION (P9 end state — no flat root). When NO intent record resolves
// (activeIntent() → null: a fresh SEED shell before auto-create, or a flat project
// still awaiting migration), the absolute path helpers resolve to the bare SPACE
// record root (aidlc/spaces/<space>/intents/ — see spaceRecordRoot). No
// aidlc-state.md ever lives directly there, so existence-gated consumers
// (loadStateFileIfPresent) read "no workflow yet" and the orchestrator either
// creates an intent or reports an error. The ONLY surviving flat `aidlc-docs`
// read is the one-time
// migration's SOURCE (flatStateSource/flatMigrationSource below).
// activeIntent() returning null IS that "no record yet" signal.

export const ACTIVE_SPACE_POINTER = "active-space";
export const DEFAULT_SPACE = "default";

// `aidlc/` — the harness-neutral workspace roof (memory · codekb · knowledge ·
// intents live under spaces/<space>/ here; the engine stays in <harness>/).
export function workspaceRoot(projectDir: string): string {
  return join(projectDir, "aidlc");
}

// The active space for this project. Reads the `aidlc/active-space` cursor; a
// missing cursor, or one that does not name a space this project has, is
// "default". NEVER throws: the default space is always valid even when
// nothing is on disk yet (the resolver tolerates an absent space dir).
export function activeSpace(projectDir: string): string {
  const ptr = join(workspaceRoot(projectDir), ACTIVE_SPACE_POINTER);
  try {
    return knownActiveSpace(workspaceRoot(projectDir), readFileSync(ptr, "utf-8"));
  } catch {
    // no cursor → default
  }
  return DEFAULT_SPACE;
}

// `aidlc/spaces/<space>/intents` — the intent registry + record root.
export function intentsDir(projectDir: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", sp, "intents");
}

// Enumerate the intent RECORD directories in a space (each `<slug>-<id8>/`
// holding an aidlc-state.md). Returns the bare directory names, sorted; [] when
// the space has no intents dir or no records yet. The intents.json registry is
// the canonical list for humans/ordering — this on-disk scan is the cheap
// "does any record exist?" signal the path resolver and migration detector need
// (it must not depend on the registry being present).
export function listIntentDirs(projectDir: string, space?: string): string[] {
  const dir = intentsDir(projectDir, space);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: string[] = [];
  for (const name of entries) {
    // A record dir holds aidlc-state.md; skip the active-intent cursor,
    // intents.json, and any stray files.
    if (existsSync(join(dir, name, "aidlc-state.md"))) records.push(name);
  }
  return records.sort();
}

// The bare SPACE record root: `aidlc/spaces/<space>/intents/`. The absolute path
// helpers resolve here when no intent record exists (activeIntent → null) — a
// fresh SEED shell before auto-create, or a flat project still awaiting migration.
// No aidlc-state.md ever lives directly here, so existence-gated readers
// (loadStateFileIfPresent) see "no workflow yet" and the orchestrator
// creates an intent or reports an error. This is the P9 end state; there is no
// flat `aidlc-docs/` root.
export function spaceRecordRoot(projectDir: string, space?: string): string {
  return intentsDir(projectDir, space);
}
export const ACTIVE_DIRECTIVE_LOCK = "active-directive.lock";

// Thrown when an engine observer reaches a durable write primitive. The
// per-call-site suppressions below keep observers off those paths; this barrier
// is what makes the guarantee a property of the code shape rather than of an
// enumeration a future author has to remember. It THROWS rather than no-ops
// because a silent no-op hides exactly the bug the barrier exists to expose, and
// both producers already fail safe on a non-zero engine exit: the Stop hook
// allows the stop and records a drop, and the route check surfaces the error
// from `unit start` instead of corrupting authority.
export class EngineModeViolationError extends Error {
  constructor(readonly primitive: string) {
    super(
      `An engine observer (${
        isStopHookProbe() ? STOP_HOOK_PROBE_ENV : ROUTE_CHECK_ENV
      }) reached the durable write primitive "${primitive}". Observers read the ` +
        "current directive and must change no project bytes. This is an engine defect, not a workflow problem.",
    );
    this.name = "EngineModeViolationError";
  }
}

// The barrier itself. Call as the first statement of a durable write primitive.
export function refuseEngineObserverWrite(primitive: string): void {
  if (isReadOnlyEngineProbe()) throw new EngineModeViolationError(primitive);
}

export function engineDirFor(recordRoot: string): string {
  return join(recordRoot, ENGINE_DIR);
}

// The env marker that identifies the Stop hook's OWN read-only `next` probe.
// Set by aidlc-continue-workflow.ts on its spawn; read by aidlc-orchestrate.ts
// to suppress the engine touch. Without this the carve-out can never fire (see
// above).
export const STOP_HOOK_PROBE_ENV = "AIDLC_STOP_HOOK_PROBE";

// The env marker that identifies the route check `aidlc-state.ts unit start`
// runs to learn which Unit the engine would route. Like the Stop-hook probe it
// consults the engine and reads only the directive off stdout.
export const ROUTE_CHECK_ENV = "AIDLC_ROUTE_CHECK";

// --- Engine observer mode -----------------------------------------------------
//
// An OBSERVER is an engine invocation whose whole purpose is to LEARN the
// current directive: the Stop hook's `next` probe and the route check's
// `next`/`continue` pair. Both read the prepared directive off stdout and never
// consult the durable marker afterwards, so publishing from one buys nothing and
// costs correctness: a publication rotates the directive's issuance identity and
// used to delete the plan-approval runtime dir, which destroyed a human's
// in-flight approval between the turn that offered it and the turn that recorded
// their answer.
//
// The predicates are deliberately env-only and read the LIVE environment on
// every call: a module-level snapshot would ignore a test that sets the variable
// after import, and the cost of a property read is irrelevant beside a spawn.
// Queries are read-only for every Unit Ownership, not only team-owned Units.
export function isStopHookProbe(): boolean {
  return process.env[STOP_HOOK_PROBE_ENV] === "1";
}

export function isRouteCheckProbe(): boolean {
  return process.env[ROUTE_CHECK_ENV] === "1";
}

export function isReadOnlyEngineProbe(): boolean {
  return isStopHookProbe() || isRouteCheckProbe();
}

// --- Error helpers (catch-block discipline) ---
//
// TypeScript 4.4+ types `catch (e)` as `unknown` under --useUnknownInCatchVariables.
// These two helpers replace the old `e as Error` pattern in throw-sites and
// log-sites uniformly. Use:
//
//   try { ... } catch (e) {
//     throw new Error(`failed: ${errorMessage(e)}`);
//   }
//
// Both helpers are total (never throw) and stable on any thrown value
// — string throws, plain objects, Error instances, primitives.

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  // TS 4.9+ narrows `e.message` to `unknown` after the `in` check — no cast needed.
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg: unknown = e.message;
    return typeof msg === "string" ? msg : String(msg);
  }
  return String(e);
}

// --- JSON.parse type guards ---
//
// JSON.parse returns `any` (TypeScript design choice). These guards narrow
// `unknown` to a concrete shape so consumers don't need property-access
// casts. Each guard is structural and total — it returns false for malformed
// input rather than throwing, so callers can decide how to fail.

/**
 * Generic "is plain object" predicate. After this guard, the value is typed
 * `Record<string, unknown>` so caller can do `if ("x" in v) { v.x ... }`
 * with TS narrowing carrying through.
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// --- Audit locking (per-intent, reaper-guarded) -------------------------------
//
// The audit lock is a cross-process mutex: a bare mkdir-EEXIST dir in tmpdir().
// It is keyed PER INTENT so two intents (or two Bolts in different intents) run
// truly in parallel without false serialization. Two keying invariants (P4's
// auto-create depends on them):
//
//  (1) intent-OMITTED hashes a RESERVED sentinel `__workspace__` bucket, distinct
//      from every per-intent bucket, and does NOT resolve activeIntent() (during
//      intent creation there is no active intent; resolving would throw or bucket on
//      "default", and two concurrent first-runs would key different/empty
//      buckets and both create intents). EVERY intents.json mutation takes this
//      workspace
//      bucket; only intent-scoped state/audit writes take a per-intent bucket.
//  (2) the composite identity (projectDir + space + intent | sentinel) keys the
//      lock dir. In-process receipt/depth/handler maps use a stable lexical
//      request key, while each receipt retains the acquisition-bound identity.
//
// REAPER: acquire stamps owner PID + acquisition generation + a random token
// into owner.json. Automatic recovery is fail-closed: stamps that name no valid
// owner, unreadable stamps and live owners are never reaped. A recoverable
// owner-stamped reap gate blocks acquisition while a provably-dead generation
// (or an old stamp that never finished) is moved, verified, deleted, or restored.

// The reserved bucket for workspace-level mutations (intents.json, intent creation).
export const WORKSPACE_LOCK_SENTINEL = "__workspace__";

// Default stale-lock age threshold (ms). Doctor uses this to surface a
// live-but-old owner for manual diagnosis; automatic acquisition never reaps a
// live stamped owner. Tunable via AIDLC_LOCK_STALE_MS for tests/ops.
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

function lockStaleMs(): number {
  const raw = process.env.AIDLC_LOCK_STALE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LOCK_STALE_MS;
}

// The composite lock IDENTITY string — keys the dir hash AND the in-process
// maps. intent-omitted → the workspace sentinel (invariant 1). When intent is
// given, the space is default-resolved (a per-intent lock is meaningless without
// its space) but activeIntent() is NEVER consulted here.
export function auditLockIdentity(projectDir: string, intent?: string, space?: string): string {
  let canonicalProjectDir = resolvePath(projectDir);
  // The native path, as in activeDirectiveContext: here it is only a name, and
  // Bun's realpathSync would give a hook spelling the folder 8.3 short and the
  // engine spelling it long two different locks.
  try {
    canonicalProjectDir = realpathSync.native(canonicalProjectDir);
  } catch {
    // Creation and diagnostics can lock before the project exists. The absolute
    // lexical path is stable until realpath can resolve filesystem aliases.
  }
  if (process.platform === "win32") {
    canonicalProjectDir = canonicalProjectDir.toLowerCase();
  }
  if (intent === undefined) {
    return `${canonicalProjectDir}\x00${WORKSPACE_LOCK_SENTINEL}`;
  }
  const sp = space ?? activeSpace(projectDir);
  return `${canonicalProjectDir}\x00${sp}\x00${intent}`;
}

// Stable call-site key for process-local receipt/depth/handler maps. Unlike the
// filesystem identity, it deliberately does not read realpath or active-space,
// so release remains bound to the acquisition even if a previously-missing path
// becomes a symlink/real directory or the active-space cursor changes.
function auditLockRequestKey(projectDir: string, intent?: string, space?: string): string {
  const lexicalProjectDir = process.platform === "win32"
    ? resolvePath(projectDir).toLowerCase()
    : resolvePath(projectDir);
  if (intent === undefined) {
    return JSON.stringify([lexicalProjectDir, "workspace"]);
  }
  return JSON.stringify([
    lexicalProjectDir,
    "intent",
    space === undefined ? null : space,
    intent,
  ]);
}

export function auditLockDir(projectDir: string, intent?: string, space?: string): string {
  const identity = auditLockIdentity(projectDir, intent, space);
  const hash = createHash("md5").update(identity).digest("hex").slice(0, 8);
  return join(tmpdir(), `.aidlc-audit-${hash}.lock`);
}

// Owner stamp written into the lock dir on acquire. The random token identifies
// the lock generation; processGeneration binds the PID to its OS creation time
// where the platform exposes one (Linux procfs and Windows GetProcessTimes).
interface LockOwner {
  pid: number;
  startedAtMs: number;
  reapLiveOwnerAfterStale: boolean;
  token?: string;
  processGeneration?: string;
}

type OwnerStampRead =
  | { status: "ok"; owner: LockOwner }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unreadable"; code: string };

export interface AuditLockFaultHooksForTests {
  afterReleaseOwnerCheck?: (lockDir: string) => void;
  beforeReleaseRename?: (retiredPath: string, attempt: number) => void;
  failReleaseRename?: (retiredPath: string, attempt: number) => boolean;
  afterSuccessfulReap?: (lockDir: string) => void;
  afterReapFinalCheck?: (lockDir: string) => void;
  failReapRename?: (privatePath: string, attempt: number) => boolean;
  beforeAcquirerOwnerStamp?: (
    candidateDir: string,
    canonicalDir: string,
    token: string,
  ) => void;
  beforeGateOwnerStamp?: (
    candidateDir: string,
    canonicalDir: string,
    token: string,
  ) => void;
  failGateReleaseRename?: (retiredPath: string, attempt: number) => boolean;
  afterReleasableGateCheck?: (gateDir: string) => void;
  posixGateLibraryCandidates?: string[];
  processProbe?: (pid: number) => { alive: boolean; generation: string | null } | undefined;
  failNativeGateMutex?: (lockDir: string) => boolean;
  selfProcessGeneration?: () => string | null;
}

let AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS: AuditLockFaultHooksForTests | null = null;

export function _setAuditLockFaultHooksForTests(
  hooks: AuditLockFaultHooksForTests | null,
): void {
  AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS = hooks;
  POSIX_GATE_API = undefined;
}

function ownerStampPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

const LOCK_GENERATION_TOKEN_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lockGenerationTokenDir(lockDir: string, token: string): string | null {
  if (!LOCK_GENERATION_TOKEN_REGEX.test(token)) return null;
  const root = resolvePath(lockDir);
  const tokenDir = resolvePath(root, token);
  const lexicalChild = relative(root, tokenDir);
  if (
    lexicalChild === "" ||
    lexicalChild === ".." ||
    lexicalChild.startsWith(`..${sep}`) ||
    isAbsolute(lexicalChild)
  ) return null;
  try {
    const rootStat = lstatSync(root);
    const tokenStat = lstatSync(tokenDir);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !tokenStat.isDirectory() ||
      tokenStat.isSymbolicLink()
    ) return null;
    const realChild = relative(realpathSync(root), realpathSync(tokenDir));
    if (
      realChild === "" ||
      realChild === ".." ||
      realChild.startsWith(`..${sep}`) ||
      isAbsolute(realChild)
    ) return null;
    return tokenDir;
  } catch {
    return null;
  }
}

function loadWindowsProcessApi() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.ptr,
    },
    LockFileEx: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    UnlockFileEx: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.bool, FFIType.u32],
      returns: FFIType.ptr,
    },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.bool,
    },
    CloseHandle: {
      args: [FFIType.ptr],
      returns: FFIType.bool,
    },
  });
}

function muslArchitecture(): string {
  const mapping: Record<string, string> = {
    arm64: "aarch64",
    ia32: "i386",
    ppc64: "powerpc64le",
    x64: "x86_64",
  };
  return mapping[process.arch] ?? process.arch;
}

function posixGateLibraryCandidates(): string[] {
  if (AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.posixGateLibraryCandidates) {
    return AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS.posixGateLibraryCandidates;
  }
  if (process.platform === "darwin") {
    return ["/usr/lib/libSystem.B.dylib"];
  }
  const arch = muslArchitecture();
  const candidates = [
    "libc.so.6",
    `/lib/ld-musl-${arch}.so.1`,
    `/usr/lib/ld-musl-${arch}.so.1`,
    `/lib/libc.musl-${arch}.so.1`,
    `/usr/lib/libc.musl-${arch}.so.1`,
    `libc.musl-${arch}.so.1`,
    "libc.so",
  ];
  for (const dir of ["/lib", "/usr/lib", "/lib64", "/usr/lib64"]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (/^(?:ld-musl-|libc\.musl-).+\.so\.1$/.test(entry)) {
          candidates.push(join(dir, entry));
        }
      }
    } catch {
      // Directory absent or unreadable; explicit candidates still apply.
    }
  }
  return [...new Set(candidates)];
}

export function _posixGateLibraryCandidatesForTests(): string[] {
  return posixGateLibraryCandidates();
}

function loadPosixGateApi() {
  let lastError: unknown;
  for (const library of posixGateLibraryCandidates()) {
    try {
      return dlopen(library, {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No POSIX flock library candidate could be loaded");
}

function loadMacProcessApi() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
}

let WINDOWS_PROCESS_API:
  | ReturnType<typeof loadWindowsProcessApi>
  | null
  | undefined;
let MAC_PROCESS_API:
  | ReturnType<typeof loadMacProcessApi>
  | null
  | undefined;
let POSIX_GATE_API:
  | ReturnType<typeof loadPosixGateApi>
  | null
  | undefined;
let SELF_PROCESS_GENERATION: string | null | undefined;

function windowsProcessGeneration(pid: number): string | null {
  try {
    if (WINDOWS_PROCESS_API === undefined) {
      WINDOWS_PROCESS_API = loadWindowsProcessApi();
    }
    if (WINDOWS_PROCESS_API === null) return null;
    const handle = WINDOWS_PROCESS_API.symbols.OpenProcess(0x1000, false, pid);
    if (!handle) return null;
    const creation = new Uint32Array(2);
    const exit = new Uint32Array(2);
    const kernel = new Uint32Array(2);
    const user = new Uint32Array(2);
    try {
      if (!WINDOWS_PROCESS_API.symbols.GetProcessTimes(
        handle,
        creation,
        exit,
        kernel,
        user,
      )) return null;
      return `${creation[1].toString(16)}:${creation[0].toString(16)}`;
    } finally {
      WINDOWS_PROCESS_API.symbols.CloseHandle(handle);
    }
  } catch {
    WINDOWS_PROCESS_API = null;
    return null;
  }
}

function linuxProcessGeneration(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null; // procfs field 22: process start time in ticks
  } catch {
    return null;
  }
}

function macProcessGeneration(pid: number): string | null {
  try {
    if (MAC_PROCESS_API === undefined) {
      MAC_PROCESS_API = loadMacProcessApi();
    }
    if (MAC_PROCESS_API === null) return null;
    const PROC_PIDTBSDINFO = 3;
    const buffer = new Uint8Array(136);
    const read = MAC_PROCESS_API.symbols.proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      0n,
      buffer,
      buffer.byteLength,
    );
    if (read < 136) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
  } catch {
    MAC_PROCESS_API = null;
    return null;
  }
}

type NativeGateMutexReceipt =
  | { kind: "posix"; fd: number }
  | {
      kind: "windows";
      handle: Pointer;
      overlapped: Uint8Array;
    };

function nativeGateMutexPath(lockDir: string): string {
  return `${lockDir}.gate-mutex`;
}

function invalidWindowsHandle(handle: Pointer | bigint | null): boolean {
  if (handle === null) return true;
  return BigInt.asIntN(64, BigInt(handle)) === -1n;
}

function tryAcquireNativeGateMutex(
  lockDir: string,
): NativeGateMutexReceipt | null {
  const path = nativeGateMutexPath(lockDir);
  if (process.platform === "win32") {
    try {
      if (WINDOWS_PROCESS_API === undefined) {
        WINDOWS_PROCESS_API = loadWindowsProcessApi();
      }
      if (WINDOWS_PROCESS_API === null) return null;
      const widePath = Buffer.from(`${win32.toNamespacedPath(resolvePath(path))}\0`, "utf16le");
      const rawHandle = WINDOWS_PROCESS_API.symbols.CreateFileW(
        widePath,
        0xc0000000,
        3,
        null,
        4,
        0x80,
        null,
      );
      if (invalidWindowsHandle(rawHandle)) return null;
      const handle = rawHandle as Pointer;
      const overlapped = new Uint8Array(32);
      if (!WINDOWS_PROCESS_API.symbols.LockFileEx(
        handle,
        3,
        0,
        1,
        0,
        overlapped,
      )) {
        WINDOWS_PROCESS_API.symbols.CloseHandle(handle);
        return null;
      }
      return {
        kind: "windows",
        handle,
        overlapped,
      };
    } catch {
      return null;
    }
  }
  try {
    if (POSIX_GATE_API === undefined) {
      POSIX_GATE_API = loadPosixGateApi();
    }
    if (POSIX_GATE_API === null) return null;
    const fd = openSync(path, "a+", 0o600);
    if (POSIX_GATE_API.symbols.flock(fd, 2 | 4) !== 0) {
      closeSync(fd);
      return null;
    }
    return { kind: "posix", fd };
  } catch {
    POSIX_GATE_API = null;
    return null;
  }
}

function acquireNativeGateMutex(
  lockDir: string,
  maxRetries = 100,
  retryMs = 5,
): NativeGateMutexReceipt | null {
  if (AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failNativeGateMutex?.(lockDir)) return null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const receipt = tryAcquireNativeGateMutex(lockDir);
    if (receipt) return receipt;
    if (attempt < maxRetries) Bun.sleepSync(retryMs);
  }
  return null;
}

function releaseNativeGateMutex(receipt: NativeGateMutexReceipt): void {
  if (receipt.kind === "posix") {
    try { POSIX_GATE_API?.symbols.flock(receipt.fd, 8); } catch { /* closing also unlocks */ }
    try { closeSync(receipt.fd); } catch { /* already closed */ }
    return;
  }
  try {
    WINDOWS_PROCESS_API?.symbols.UnlockFileEx(
      receipt.handle,
      0,
      1,
      0,
      receipt.overlapped,
    );
  } catch { /* closing also unlocks */ }
  try { WINDOWS_PROCESS_API?.symbols.CloseHandle(receipt.handle); } catch { /* already closed */ }
}

// Exported so the transaction lock proves a reused PID with the same record.
// Locks persist this string: a format change makes a live holder from another
// release look like a reused PID.
export function processGeneration(pid: number): string | null {
  if (pid === process.pid && AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.selfProcessGeneration) {
    return AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS.selfProcessGeneration();
  }
  if (pid === process.pid && SELF_PROCESS_GENERATION !== undefined) {
    return SELF_PROCESS_GENERATION;
  }
  const generation = process.platform === "win32"
    ? windowsProcessGeneration(pid)
    : process.platform === "linux"
      ? linuxProcessGeneration(pid)
      : process.platform === "darwin"
        ? macProcessGeneration(pid)
        : null;
  if (pid === process.pid) SELF_PROCESS_GENERATION = generation;
  return generation;
}

// When a live process started, in epoch ms, read from its generation record;
// null when the platform cannot say. For locks written by releases that
// recorded no generation. A wall-clock step can shift it, so callers compare
// with a margin.
export function processStartedAtMs(pid: number): number | null {
  const generation = processGeneration(pid);
  if (!generation) return null;
  let started = Number.NaN;
  try {
    if (process.platform === "win32") {
      // FILETIME as "high:low" hex: 100 ns intervals since 1601-01-01.
      const [high, low] = generation.split(":");
      const filetime = (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
      started = Number(filetime / 10_000n) - 11_644_473_600_000;
    } else if (process.platform === "darwin") {
      const [seconds, micros] = generation.split(":").map(Number);
      started = seconds * 1000 + micros / 1000;
    } else if (process.platform === "linux") {
      // procfs counts USER_HZ ticks since boot; USER_HZ is 100 wherever Bun runs.
      const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf-8"));
      if (boot) started = Number(boot[1]) * 1000 + Number(generation) * 10;
    }
  } catch {
    return null;
  }
  return Number.isFinite(started) ? started : null;
}

function writeOwnerStamp(
  lockDir: string,
  reapLiveOwnerAfterStale = true,
  token?: string,
): LockOwner | null {
  const generation = processGeneration(process.pid);
  const owner: LockOwner = {
    pid: process.pid,
    startedAtMs: lockAcquireEpochMs(),
    reapLiveOwnerAfterStale,
    ...(token ? { token } : {}),
    ...(generation ? { processGeneration: generation } : {}),
  };
  try {
    writeFileSync(ownerStampPath(lockDir), JSON.stringify(owner), {
      encoding: "utf-8",
      mode: 0o600,
      ...(token ? { flag: "wx" } : {}),
    });
    return owner;
  } catch {
    // Acquisition treats a missing stamp as failure and abandons its directory.
    return null;
  }
}

// "missing" means no owner ever finished its stamp: no owner.json, an empty one,
// or one JSON.parse rejects. That is what a process killed between creating the
// file and writing it leaves (releases before the stamp was written privately
// stamped the lock in place), so it is judged like an unstamped folder: reaped
// once older than the grace, under the gate. A live writer is never seen that
// way: it stamps a private folder renamed into place, while holding the gate
// the reaper must take. A stamp that parses but names no valid owner is
// "invalid" and an OS error reading it is "unreadable"; both stay fail-closed.
function inspectOwnerStamp(lockDir: string): OwnerStampRead {
  let raw: string;
  try {
    raw = readFileSync(ownerStampPath(lockDir), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    return code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable", code };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "missing" };
  }
  if (!isPlainObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.startedAtMs !== "number") {
    return { status: "invalid" };
  }
  let token: string | undefined;
  if (parsed.token !== undefined) {
    if (
      typeof parsed.token !== "string" ||
      lockGenerationTokenDir(lockDir, parsed.token) === null
    ) return { status: "invalid" };
    token = parsed.token;
  }
  return {
    status: "ok",
    owner: {
      pid: parsed.pid,
      startedAtMs: parsed.startedAtMs,
      reapLiveOwnerAfterStale: parsed.reapLiveOwnerAfterStale !== false,
      ...(token ? { token } : {}),
      ...(typeof parsed.processGeneration === "string" && parsed.processGeneration.length > 0
        ? { processGeneration: parsed.processGeneration }
        : {}),
    },
  };
}

function readOwnerStamp(lockDir: string): LockOwner | null {
  const result = inspectOwnerStamp(lockDir);
  return result.status === "ok" ? result.owner : null;
}

// A monotonic-ish epoch for the owner stamp. performance.timeOrigin + now()
// gives a wall-clock-equivalent without the bare `Date.now()` the lint forbids;
// it is used only for AGE comparison (a relative delta), so origin drift is
// irrelevant — both stamps come from the same clock family across processes
// because timeOrigin is anchored to the unix epoch by the runtime.
function lockAcquireEpochMs(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

// Is a PID still alive? signal 0 probes liveness without delivering a signal:
// ESRCH ⇒ gone, EPERM ⇒ alive-but-not-ours (still alive), success ⇒ alive.
// EXPORTED so a caller outside the lock mechanism
// (e.g. a staged-transaction collector distinguishing a live writer's staging
// dir from a crashed one's) can ask the same question this module already
// answers for the lock reaper, rather than re-deriving it.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists but is owned by another user → still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

type OwnerProcessState = "dead" | "same" | "different" | "unknown";

function ownerProcessState(owner: LockOwner): OwnerProcessState {
  const injected = AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.processProbe?.(owner.pid);
  const alive = injected?.alive ?? isPidAlive(owner.pid);
  if (!alive) return "dead";
  const observedGeneration = injected
    ? injected.generation
    : processGeneration(owner.pid);
  if (!owner.processGeneration || !observedGeneration) return "unknown";
  return owner.processGeneration === observedGeneration ? "same" : "different";
}

// A monotonic per-process counter for the steal-rename suffix (no Math.random /
// Date.now — scripts/forbid). Combined with the PID it is unique enough that two
// waiters never collide on the same `.dead.<suffix>` name, and only one wins the
// rename anyway (the second gets ENOENT).
let _reapCounter = 0;
export function reapSuffix(): string {
  _reapCounter += 1;
  return `${process.pid}-${_reapCounter}`;
}

// Grace window (ms) before a lock folder whose stamp never finished (see
// inspectOwnerStamp) counts as a leak. The gate is the real fence: a live
// writer stamps while holding it, and the reaper must take it first. The grace
// is the second one, for a folder an older release stamped in place and for
// any writer outside the gate. Measured from the folder's mtime, which moves
// when owner.json is created. Tunable via AIDLC_LOCK_UNSTAMPED_GRACE_MS.
function unstampedGraceMs(): number {
  const raw = process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

// The lock dir's own mtime epoch (ms), or null if it can't be stat'd. Used as the
// age anchor for an UNSTAMPED dir (no finished owner.json). statSync mtime is a
// wall-clock ms, comparable to lockAcquireEpochMs()'s epoch family.
function lockDirMtimeMs(lockDir: string): number | null {
  try {
    return statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

// True when a lock folder whose stamp never finished is past the grace, so it
// counts as a leak. The one reader of the grace: the workflow locks' reaper and
// doctor, and the transaction lock's directory form (aidlc-transaction.ts
// clearStaleLock).
export function unstampedPastGrace(lockDir: string): boolean {
  const mtime = lockDirMtimeMs(lockDir);
  return mtime !== null && lockAcquireEpochMs() - mtime > unstampedGraceMs();
}

function ownerStampsEqual(now: LockOwner, judged: LockOwner): boolean {
  return (
    now.pid === judged.pid &&
    now.startedAtMs === judged.startedAtMs &&
    now.reapLiveOwnerAfterStale === judged.reapLiveOwnerAfterStale &&
    now.token === judged.token &&
    now.processGeneration === judged.processGeneration
  );
}

function stampMatches(dir: string, judged: LockOwner): boolean {
  const current = inspectOwnerStamp(dir);
  return current.status === "ok" && ownerStampsEqual(current.owner, judged);
}

interface ReapCandidate {
  owner: LockOwner | null;
  unstampedIdentity: string | null;
}

function unstampedIdentity(lockDir: string): string | null {
  try {
    const stat = statSync(lockDir);
    return createHash("sha256")
      .update(`${stat.dev}\x00${stat.ino}\x00${stat.birthtimeMs}\x00${stat.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
  } catch {
    return null;
  }
}

function reapCandidate(lockDir: string): ReapCandidate | null {
  const inspected = inspectOwnerStamp(lockDir);
  if (inspected.status === "invalid" || inspected.status === "unreadable") {
    return null;
  }
  if (inspected.status === "missing") {
    if (!unstampedPastGrace(lockDir)) return null;
    const identity = unstampedIdentity(lockDir);
    return identity === null
      ? null
      : {
          owner: null,
          unstampedIdentity: identity,
        };
  }
  const processState = ownerProcessState(inspected.owner);
  if (processState === "same" || processState === "unknown") {
    // Integrity first: automatic acquisition never reaps the same or
    // generation-unknown live process.
    return null;
  }
  return {
    owner: inspected.owner,
    unstampedIdentity: null,
  };
}

function reapCandidateStillMatches(lockDir: string, candidate: ReapCandidate): boolean {
  if (candidate.owner !== null) {
    const current = inspectOwnerStamp(lockDir);
    const state = current.status === "ok"
      ? ownerProcessState(current.owner)
      : "unknown";
    return (
      current.status === "ok" &&
      ownerStampsEqual(current.owner, candidate.owner) &&
      (state === "dead" || state === "different")
    );
  }
  return (
    inspectOwnerStamp(lockDir).status === "missing" &&
    unstampedIdentity(lockDir) === candidate.unstampedIdentity
  );
}

function reapClaimDir(lockDir: string): string {
  return `${lockDir}.reap`;
}

function reapPrivateDir(lockDir: string, claimToken: string): string {
  return `${lockDir}.dead.${claimToken}`;
}

// The one way an owner-stamped folder (a lock or its coordination gate) is
// published: built and stamped under a private name, then renamed into place,
// so it appears with its stamp complete or not at all. A process killed on the
// way leaves only its private candidate folder, which nothing reads. The caller
// holds what excludes other publishers (the gate for a lock, the native mutex
// for a gate), so the name cannot be taken between the check and the rename;
// the check makes a taken name a lost round on every platform, since POSIX
// rename replaces an empty directory and Windows refuses any existing one.
function tryCreateOwnerStampedDir(
  dir: string,
  reapLiveOwnerAfterStale: boolean,
  kind: "gate" | "lock",
): OwnerStampedLockReceipt | null {
  const candidate = `${dir}.candidate.${randomUUID()}`;
  try {
    mkdirSync(candidate, { mode: 0o700 });
  } catch {
    return null;
  }
  const token = randomUUID();
  const candidateTokenDir = join(candidate, token);
  try {
    mkdirSync(candidateTokenDir, { mode: 0o700 });
    if (kind === "gate") {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeGateOwnerStamp?.(candidate, dir, token);
    } else {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeAcquirerOwnerStamp?.(candidate, dir, token);
    }
    const owner = writeOwnerStamp(candidate, reapLiveOwnerAfterStale, token);
    if (!owner?.token) throw new Error("owner stamp failed");
    if (existsSync(dir)) throw new Error("the name is taken");
    renameSync(candidate, dir);
    return {
      lockDir: dir,
      tokenDir: join(dir, token),
      owner: owner as LockOwner & { token: string },
    };
  } catch {
    try { rmSync(candidate, { recursive: true, force: true }); } catch { /* private debris */ }
    return null;
  }
}

function restoreReapPrivate(
  lockDir: string,
  privateDir: string,
): boolean {
  if (!existsSync(privateDir)) return true;
  if (existsSync(lockDir)) return false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      renameSync(privateDir, lockDir);
      return true;
    } catch {
      if (existsSync(lockDir)) return false;
      if (!existsSync(privateDir)) return true;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

// Every try at moving the lock or released gate folder of a provably dead owner,
// or this process's own gate, was refused: on Windows, a program holds that
// folder open (aidlc-lock-line.ts).
// A plain null from the gate (a mutex miss, a live owner, an invalid gate) and
// an owner of unknown generation are not one.
let HELD_FOLDER_RENAME_FAILURES = 0;

function retireReapClaim(claimDir: string): boolean {
  for (let attempt = 0; attempt <= 100; attempt++) {
    const retired = `${claimDir}.retired.${randomUUID()}`;
    try {
      renameSync(claimDir, retired);
      try { rmSync(retired, { recursive: true, force: true }); } catch { /* private debris */ }
      return true;
    } catch {
      if (!existsSync(claimDir)) return true;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

function recoverReapClaim(lockDir: string, owner: LockOwner): boolean {
  const claimDir = reapClaimDir(lockDir);
  const privateDir = owner.token ? reapPrivateDir(lockDir, owner.token) : "";
  if (privateDir && existsSync(privateDir) && !existsSync(lockDir)) {
    // The stale gate still excludes every canonical mutation. Restore first,
    // regardless of whether the displaced generation is dead, live, or
    // unreadable; the next gate owner will classify it from the canonical path.
    if (!restoreReapPrivate(lockDir, privateDir)) return false;
  }
  return retireReapClaim(claimDir);
}

const PENDING_REAP_GATE_RELEASES = new Map<string, {
  receipt: OwnerStampedLockReceipt;
  handler: () => void;
}>();

type ReapGateReleaseState = "held" | "releasable" | "invalid";

function reapGateReleasablePath(
  claimDir: string,
  owner: LockOwner & { token: string },
): string | null {
  const tokenDir = lockGenerationTokenDir(claimDir, owner.token);
  return tokenDir === null ? null : join(tokenDir, "releasable");
}

function reapGateReleaseState(
  claimDir: string,
  owner: LockOwner,
): ReapGateReleaseState {
  if (typeof owner.token !== "string") return "invalid";
  const path = reapGateReleasablePath(
    claimDir,
    owner as LockOwner & { token: string },
  );
  if (path === null) return "invalid";
  try {
    return lstatSync(path).isFile() ? "releasable" : "invalid";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "held"
      : "invalid";
  }
}

function markReapGateReleasable(receipt: OwnerStampedLockReceipt): boolean {
  const path = reapGateReleasablePath(receipt.lockDir, receipt.owner);
  if (path === null) return false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return reapGateReleaseState(receipt.lockDir, receipt.owner) === "releasable";
      }
      if (!ownerReceiptMatches(receipt)) return false;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

function clearPendingReapGateRelease(claimDir: string): void {
  const pending = PENDING_REAP_GATE_RELEASES.get(claimDir);
  if (!pending) return;
  process.off("exit", pending.handler);
  PENDING_REAP_GATE_RELEASES.delete(claimDir);
}

function retryPendingReapGateRelease(claimDir: string): boolean {
  const pending = PENDING_REAP_GATE_RELEASES.get(claimDir);
  if (!pending) return true;
  if (!existsSync(claimDir)) {
    clearPendingReapGateRelease(claimDir);
    return true;
  }
  if (!markReapGateReleasable(pending.receipt)) return false;
  const outcome = releaseOwnerStampedLock(pending.receipt, false, true);
  if (outcome === "retryable") {
    // Our own gate folder could not be moved: part of our own release.
    HELD_FOLDER_RENAME_FAILURES++;
    return false;
  }
  clearPendingReapGateRelease(claimDir);
  return true;
}

function acquireReapClaim(lockDir: string): OwnerStampedLockReceipt | null {
  const claimDir = reapClaimDir(lockDir);
  const mutex = acquireNativeGateMutex(lockDir);
  if (!mutex) return null;
  try {
    if (!retryPendingReapGateRelease(claimDir)) return null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const created = tryCreateOwnerStampedDir(claimDir, false, "gate");
      if (created) return created;
      const inspected = inspectOwnerStamp(claimDir);
      if (inspected.status === "ok") {
        const releaseState = reapGateReleaseState(claimDir, inspected.owner);
        if (releaseState === "invalid") return null;
        if (releaseState === "releasable") {
          AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleasableGateCheck?.(
            claimDir,
          );
          if (!retireReapClaim(claimDir)) {
            // Only a gate whose owner is provably gone: a live owner may still
            // be retrying its own release.
            const owner = ownerProcessState(inspected.owner);
            if (owner === "dead" || owner === "different") HELD_FOLDER_RENAME_FAILURES++;
            return null;
          }
          continue;
        }
        const state = ownerProcessState(inspected.owner);
        if (state === "same" || state === "unknown") return null;
        if (!recoverReapClaim(lockDir, inspected.owner)) return null;
      } else if (inspected.status === "missing") {
        if (!unstampedPastGrace(claimDir)) return null;
        if (!retireReapClaim(claimDir)) return null;
      } else {
        // Invalid/unreadable claim ownership is ambiguous and remains fail-closed.
        return null;
      }
    }
    return null;
  } finally {
    releaseNativeGateMutex(mutex);
  }
}

function releaseReapClaim(receipt: OwnerStampedLockReceipt): boolean {
  const lockDir = receipt.lockDir.endsWith(".reap")
    ? receipt.lockDir.slice(0, -".reap".length)
    : receipt.lockDir;
  const mutex = acquireNativeGateMutex(lockDir);
  let outcome: LockReleaseOutcome = "retryable";
  if (mutex) {
    try {
      const marked = markReapGateReleasable(receipt);
      outcome = marked
        ? releaseOwnerStampedLock(receipt, false, true)
        : "retryable";
    } finally {
      releaseNativeGateMutex(mutex);
    }
  }
  if (outcome !== "retryable") {
    clearPendingReapGateRelease(receipt.lockDir);
    return true;
  }
  if (!PENDING_REAP_GATE_RELEASES.has(receipt.lockDir)) {
    const handler = () => {
      releaseReapClaim(receipt);
    };
    PENDING_REAP_GATE_RELEASES.set(receipt.lockDir, { receipt, handler });
    process.on("exit", handler);
  }
  return false;
}

// Reclaim only a provably-dead stamped owner, a generation-mismatched reused
// PID, or an old folder whose stamp never finished. The fixed owner-stamped reap
// gate blocks acquisition while canonical ownership is moved or restored.
function reapStaleLock(lockDir: string, reapUnstamped = true): boolean {
  // A live/ambiguous owner cannot be reaped. Avoid taking and publishing the
  // coordination gate merely to rediscover that fact: blocked contenders can
  // otherwise starve the owner's release. This read authorizes no mutation;
  // re-read and validate the candidate under the gate below.
  const observed = reapCandidate(lockDir);
  if (observed === null || (!reapUnstamped && observed.owner === null)) return false;
  const claim = acquireReapClaim(lockDir);
  if (!claim) return false;
  let releaseClaim = true;
  const dead = reapPrivateDir(lockDir, claim.owner.token);
  let moved = false;
  try {
    const candidate = reapCandidate(lockDir);
    if (
      candidate === null ||
      (!reapUnstamped && candidate.owner === null)
    ) return false;
    if (!reapCandidateStillMatches(lockDir, candidate)) return false;
    AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReapFinalCheck?.(lockDir);
    for (let attempt = 0; attempt <= 100; attempt++) {
      if (AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failReapRename?.(dead, attempt)) {
        if (attempt < 100) Bun.sleepSync(5);
        continue;
      }
      try {
        renameSync(lockDir, dead);
        moved = true;
        break;
      } catch {
        if (!reapCandidateStillMatches(lockDir, candidate)) return false;
        if (attempt < 100) Bun.sleepSync(5);
      }
    }
    if (!moved) {
      HELD_FOLDER_RENAME_FAILURES++;
      return false;
    }
    if (!reapCandidateStillMatches(dead, candidate)) {
      if (!restoreReapPrivate(lockDir, dead)) releaseClaim = false;
      return false;
    }
    try {
      rmSync(dead, { recursive: true, force: true });
    } catch {
      // Private dead-generation debris never aliases the canonical lock path.
    }
    AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterSuccessfulReap?.(lockDir);
    return true;
  } finally {
    if (releaseClaim && !releaseReapClaim(claim)) {
      // A valid claim left behind is recoverable by a later contender.
    }
  }
}

export interface OwnerStampedLockReceipt {
  lockDir: string; tokenDir: string; owner: LockOwner & { token: string };
  // The contention budget the lock was acquired with; release retries within it.
  releaseBudgetMs?: number;
  // A release already spent its budget once, or gave up on a held folder (the
  // 10 s give-up). Later retries (at exit, at the next transaction) make one
  // short try: a second budget only holds the person's tool call, and the next
  // process reaps a dead owner's lock anyway.
  releaseSpent?: boolean;
}

interface AuditLockReceipt extends OwnerStampedLockReceipt {
  identityKey: string;
  releasePending: boolean;
}

export function ownerReceiptMatches(receipt: OwnerStampedLockReceipt): boolean {
  return stampMatches(receipt.lockDir, receipt.owner);
}

type LockReleaseOutcome = "released" | "not-owner" | "retryable";

function releaseOwnerStampedLock(
  receipt: OwnerStampedLockReceipt,
  applyFaultHooks = true,
  applyGateFaultHooks = false,
): LockReleaseOutcome {
  let checked = false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    const current = inspectOwnerStamp(receipt.lockDir);
    if (current.status === "missing" && !existsSync(receipt.lockDir)) return "not-owner";
    if (current.status !== "ok") {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    if (!ownerStampsEqual(current.owner, receipt.owner)) return "not-owner";
    if (!checked && applyFaultHooks) {
      checked = true;
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleaseOwnerCheck?.(receipt.lockDir);
    }
    const retired = `${receipt.lockDir}.released.${receipt.owner.token}.${randomUUID()}`;
    if (applyFaultHooks) {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeReleaseRename?.(retired, attempt);
    }
    if (
      applyFaultHooks &&
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failReleaseRename?.(retired, attempt)
    ) {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    if (
      applyGateFaultHooks &&
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failGateReleaseRename?.(
        retired,
        attempt,
      )
    ) {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    try {
      renameSync(receipt.lockDir, retired);
      try { rmSync(retired, { recursive: true, force: true }); } catch { /* private debris */ }
      return "released";
    } catch {
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return "retryable";
}

export function releaseCanonicalOwnerStampedLock(
  receipt: OwnerStampedLockReceipt,
): LockReleaseOutcome {
  // A contender can briefly own the coordination gate while discovering our
  // still-live canonical lock, and Windows can refuse the retirement rename
  // while a peer reads the owner stamp. Retry the whole release within the
  // budget the lock was acquired with, never less than half a second, before
  // deferring it to process exit: callers such as sensors run subprocesses
  // between audit windows and must not retain the first window's lock across
  // that work.
  const budgetMs = Math.max(500, receipt.releaseSpent ? 0 : receipt.releaseBudgetMs ?? 0);
  const deadline = process.hrtime.bigint() + BigInt(Math.ceil(budgetMs)) * 1_000_000n;
  // Rounds whose rename of our own folder, or of a dead owner's gate, was refused.
  let heldSince: bigint | null = null;
  for (;;) {
    const failures = HELD_FOLDER_RENAME_FAILURES;
    const gate = acquireReapClaim(receipt.lockDir);
    let refused = false;
    if (gate) {
      try {
        const outcome = releaseOwnerStampedLock(receipt);
        if (outcome !== "retryable") return outcome;
        refused = true;
      } finally {
        releaseReapClaim(gate);
      }
    }
    const now = process.hrtime.bigint();
    heldSince = refused || HELD_FOLDER_RENAME_FAILURES > failures ? heldSince ?? now : null;
    if (now >= deadline || heldTooLong(heldSince, now)) {
      receipt.releaseSpent = true;
      return "retryable";
    }
    Bun.sleepSync(5);
  }
}

function acquireOwnerStampedLock(
  lockDir: string,
  maxRetries: number,
  retryMs: number,
  reapLiveOwnerAfterStale = true,
): OwnerStampedLockReceipt | null {
  return acquireOwnerStampedLockFor(lockDir, maxRetries, retryMs, reapLiveOwnerAfterStale).receipt;
}

interface OwnerStampedLockAcquisition {
  receipt: OwnerStampedLockReceipt | null;
  // The rounds that ran out the budget were stopped by a dead owner's folder
  // that could not be moved, not by a live owner.
  folderHeld: boolean;
}

function acquireOwnerStampedLockFor(
  lockDir: string,
  maxRetries: number,
  retryMs: number,
  reapLiveOwnerAfterStale: boolean,
): OwnerStampedLockAcquisition {
  const create = (): OwnerStampedLockReceipt | null => {
    // Negative fast path only. A missing name still goes through the complete
    // coordinated create/recovery protocol and its re-check before the rename.
    if (existsSync(lockDir)) return null;
    const gate = acquireReapClaim(lockDir);
    if (!gate) return null;
    try {
      const created = tryCreateOwnerStampedDir(lockDir, reapLiveOwnerAfterStale, "lock");
      return created ? { ...created, releaseBudgetMs: maxRetries * retryMs } : null;
    } finally {
      releaseReapClaim(gate);
    }
  };
  // The budget is time as well as a count: a round that waits out refused
  // renames (about 0.5 s, 1.5 s on Windows) would otherwise stretch it a
  // hundredfold. Never less than half a second, as the release, so a small
  // explicit count still gets its rounds. `heldSince` is when the rounds
  // started meeting a held folder.
  const deadline = process.hrtime.bigint() + BigInt(Math.ceil(Math.max(500, maxRetries * retryMs))) * 1_000_000n;
  let heldSince: bigint | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const failures = HELD_FOLDER_RENAME_FAILURES;
    const acquired = create();
    if (acquired) return { receipt: acquired, folderHeld: false };
    if (reapStaleLock(lockDir)) {
      const afterReap = create();
      if (afterReap) return { receipt: afterReap, folderHeld: false };
    }
    retryOwnDeferredGateRelease(lockDir);
    const now = process.hrtime.bigint();
    heldSince = HELD_FOLDER_RENAME_FAILURES > failures ? heldSince ?? now : null;
    if (attempt >= maxRetries || now >= deadline || heldTooLong(heldSince, now)) break;
    Bun.sleepSync(retryMs);
  }
  return { receipt: null, folderHeld: heldSince !== null };
}

// Waiting longer does not free a folder a program holds; only stopping it does.
function heldTooLong(heldSince: bigint | null, now: bigint): boolean {
  return heldSince !== null && now - heldSince >= BigInt(lockFolderHeldGiveUpMs()) * 1_000_000n;
}

// A gate release that could not get the native mutex stays deferred, and only
// the next acquireReapClaim retries it. A waiter that took the gate as another
// process created the lock never calls that while the lock exists, so the
// owner could not take the gate to release and both waited out their budgets
// (t46 on Windows). Retry our own deferred release while we wait.
function retryOwnDeferredGateRelease(lockDir: string): void {
  const claimDir = reapClaimDir(lockDir);
  if (!PENDING_REAP_GATE_RELEASES.has(claimDir)) return;
  const mutex = acquireNativeGateMutex(lockDir);
  if (!mutex) return;
  try {
    retryPendingReapGateRelease(claimDir);
  } finally {
    releaseNativeGateMutex(mutex);
  }
}

export type OwnerStampedLockRun<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export function runWithOwnerStampedLock<T>(
  lockDir: string,
  maxRetries: number,
  retryMs: number,
  action: () => T,
): OwnerStampedLockRun<T> {
  const receipt = acquireOwnerStampedLock(lockDir, maxRetries, retryMs);
  if (!receipt) return { acquired: false };
  const onExit = () => {
    releaseCanonicalOwnerStampedLock(receipt);
  };
  process.on("exit", onExit);
  try {
    return { acquired: true, value: action() };
  } finally {
    const outcome = releaseCanonicalOwnerStampedLock(receipt);
    if (outcome !== "retryable") process.off("exit", onExit);
  }
}

// This wait protects required marker publication, not a best-effort probe.
// A caller can request a short/zero contention budget without changing the
// ownership, stale-owner, or unstamped-grace rules.
export function activeDirectiveLockBudgetMs(): number {
  const raw = process.env.AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS;
  const configured = raw?.trim() ? Number(raw) : NaN;
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_SUBPROCESS_TIMEOUT_MS;
}

export function acquireActiveDirectiveLock(lockDir: string): OwnerStampedLockAcquisition {
  return acquireOwnerStampedLockFor(lockDir, Math.floor(activeDirectiveLockBudgetMs() / 10), 10, true);
}

// Receipts, reentrancy, and exit handlers are keyed by the acquisition-bound
// canonical lock identity. Stable lexical request bindings preserve that
// identity across path materialization/active-space changes, while an
// equivalent existing symlink or Windows-case alias resolves directly to the
// same canonical identity.
const AUDIT_LOCK_RECEIPTS = new Map<string, AuditLockReceipt>();
const AUDIT_LOCK_REQUEST_BINDINGS = new Map<string, string>();

function unregisterAuditLockHandler(identityKey: string): void {
  const handler = AUDIT_LOCK_EXIT_HANDLERS.get(identityKey);
  if (!handler) return;
  process.off("exit", handler);
  AUDIT_LOCK_EXIT_HANDLERS.delete(identityKey);
}

function removeAuditRequestBindings(identityKey: string): void {
  for (const [requestKey, boundIdentity] of AUDIT_LOCK_REQUEST_BINDINGS) {
    if (boundIdentity === identityKey) AUDIT_LOCK_REQUEST_BINDINGS.delete(requestKey);
  }
}

function releaseAuditReceipt(identityKey: string): boolean {
  const receipt = AUDIT_LOCK_RECEIPTS.get(identityKey);
  if (!receipt) {
    unregisterAuditLockHandler(identityKey);
    removeAuditRequestBindings(identityKey);
    return true;
  }
  const outcome = releaseCanonicalOwnerStampedLock(receipt);
  if (outcome === "retryable") {
    receipt.releasePending = true;
    return false;
  }
  AUDIT_LOCK_RECEIPTS.delete(identityKey);
  unregisterAuditLockHandler(identityKey);
  removeAuditRequestBindings(identityKey);
  return true;
}

function auditLockBoundIdentity(
  projectDir: string,
  intent?: string,
  space?: string,
): { requestKey: string; identityKey: string } {
  const requestKey = auditLockRequestKey(projectDir, intent, space);
  return {
    requestKey,
    identityKey:
      AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ??
      auditLockIdentity(projectDir, intent, space),
  };
}

export function acquireAuditLock(
  projectDir: string,
  maxRetries?: number,
  retryMs = 100,
  intent?: string,
  space?: string,
  reapLiveOwnerAfterStale = true,
): boolean {
  const { requestKey, identityKey } = auditLockBoundIdentity(
    projectDir,
    intent,
    space,
  );
  const existing = AUDIT_LOCK_RECEIPTS.get(identityKey);
  if (existing) {
    if (!existing.releasePending || !releaseAuditReceipt(identityKey)) return false;
  }
  const lockDir = auditLockDir(projectDir, intent, space);
  // Explicit retry counts win. The timeout override also lets a CLI caller
  // deliberately calibrate contention without retuning the production default
  // or changing any owner/reaper predicate.
  const raw = process.env.AIDLC_AUDIT_LOCK_TIMEOUT_MS;
  const configured = raw?.trim() ? Number(raw) : NaN;
  const timeoutMs = Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_SUBPROCESS_TIMEOUT_MS;
  const receipt = acquireOwnerStampedLock(
    lockDir,
    maxRetries ?? Math.floor(timeoutMs / Math.max(1, retryMs)),
    retryMs,
    reapLiveOwnerAfterStale,
  );
  if (!receipt) return false;
  AUDIT_LOCK_RECEIPTS.set(identityKey, {
    ...receipt,
    identityKey,
    releasePending: false,
  });
  AUDIT_LOCK_REQUEST_BINDINGS.set(requestKey, identityKey);
  return true;
}

export function releaseAuditLock(projectDir: string, intent?: string, space?: string): void {
  const { requestKey, identityKey } = auditLockBoundIdentity(
    projectDir,
    intent,
    space,
  );
  if (AUDIT_LOCK_RECEIPTS.has(identityKey)) {
    AUDIT_LOCK_REQUEST_BINDINGS.set(requestKey, identityKey);
  }
  releaseAuditReceipt(identityKey);
}

/** True only while `ownerPid` is the live process stamped into this lock.
 *  Used by synchronous child tools whose parent deliberately keeps the
 *  workspace lock held across the child's work. */
export function auditLockOwnedByProcess(
  projectDir: string,
  ownerPid: number,
  intent?: string,
  space?: string,
): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  const owner = readOwnerStamp(auditLockDir(projectDir, intent, space));
  if (owner?.pid !== ownerPid) return false;
  const state = ownerProcessState(owner);
  return state === "same" || state === "unknown";
}

// Tracks per-identity exit handlers that release the audit lock if a caller
// process.exit()s while still holding it. Bun's process.exit skips `finally`
// blocks, so a tool that wraps locked work in try/finally and then calls
// errorWithSlug → emitError → process.exit will leak the lock dir without
// this safety net. Lock acquire registers a handler; release deregisters.
// Keyed on the canonical acquisition identity; lexical request bindings route
// path/active-space drift back to that identity.
const AUDIT_LOCK_EXIT_HANDLERS = new Map<string, () => void>();

// Per-IDENTITY reentrancy depth. Equivalent aliases therefore share depth while
// a materialized-path request remains bound to the identity it acquired.
// Same-process nested withAuditLock calls would otherwise self-deadlock — the inner mkdir hits
// EEXIST against the lock the outer caller already holds, and burns the
// acquisition backstop before throwing. The depth counter makes the
// primitive reentrant: the outer call performs the OS-level lock acquire/release;
// inner calls just bump depth and return. Cross-process locking is unaffected —
// different processes still serialise via mkdir EEXIST. Keyed on the composite
// identity so two intents/explicit spaces in one process don't share a depth.
const AUDIT_LOCK_DEPTH = new Map<string, number>();

// writeFileAtomic — non-corrupting variant of writeFileSync. Writes to a
// writer-unique sibling temp then POSIX-renames into place atomically. Readers
// of <path> see either the previous version or the new one — never a
// half-written file. Pair with withAuditLock when concurrent writers
// must serialise (rename alone defeats half-writes but not lost updates).
//
// Sibling temp keeps the rename on the same filesystem so it's a true
// atomic rename (cross-fs renames degrade to copy-then-unlink). A unique,
// exclusively-created temp prevents concurrent unlocked writers from
// truncating or renaming each other's in-flight data. Cleans up only the temp
// owned by this invocation on write/rename failure.
// Windows refuses a rename over a file another process has open, and Bun's own
// reads hold a file open that way: on Windows Server 2025, a second Bun process
// reading the target in a loop refused 1,879 of 2,000 renames (Bun 1.4.2). The
// caller's lock serialises writers, so both atomic writers retry the
// replacement until a bounded deadline instead of losing a completed
// read-modify-write. POSIX replaces the entry regardless of readers.
const ATOMIC_RENAME_RETRY_MS = 10_000;
const ATOMIC_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);

function replaceAtomically(tmp: string, path: string): void {
  if (process.platform !== "win32") {
    renameSync(tmp, path);
    return;
  }
  const deadline = Date.now() + ATOMIC_RENAME_RETRY_MS;
  for (;;) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!ATOMIC_RENAME_RETRY_CODES.has(code) || Date.now() >= deadline) throw error;
      Bun.sleepSync(5);
    }
  }
}

export function writeFileAtomic(path: string, data: string): void {
  refuseEngineObserverWrite("writeFileAtomic");
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTmp = false;
  try {
    fd = openSync(tmp, "wx");
    ownsTmp = true;
    writeFileSync(fd, data, "utf-8");
    closeSync(fd);
    fd = undefined;
    replaceAtomically(tmp, path);
    ownsTmp = false;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
    }
    if (ownsTmp) {
      try { unlinkSync(tmp); } catch { /* temp may already be gone */ }
    }
    throw err;
  }
}

// writeBufferAtomic — the byte-exact twin of writeFileAtomic for binary
// payloads: a captured PDF, an image, any non-text source. Same exclusive-create
// sibling-temp-then-rename discipline, deliberately sharing writeFileAtomic's
// shape so the two cannot drift; the only difference is no utf-8 coercion, so
// the bytes round-trip identical to the source and stay sha256-verifiable.
export function writeBufferAtomic(path: string, data: Buffer | Uint8Array): void {
  refuseEngineObserverWrite("writeBufferAtomic");
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTmp = false;
  try {
    fd = openSync(tmp, "wx");
    ownsTmp = true;
    writeFileSync(fd, data);
    closeSync(fd);
    fd = undefined;
    replaceAtomically(tmp, path);
    ownsTmp = false;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
    }
    if (ownsTmp) {
      try { unlinkSync(tmp); } catch { /* temp may already be gone */ }
    }
    throw err;
  }
}

// ensureDirSync / renameIntoPlace / removeTreeSync — the three raw
// mkdir/rename/rm primitives, re-exported so a caller that has NO reason to
// import node:fs's mutating names directly still can. This module already
// calls mkdirSync/renameSync/rmSync internally (its own lock/atomic-write
// mechanism has no funnel above it — it IS the funnel); these thin wrappers
// exist for callers like aidlc-knowledge.ts, whose linter override forbids
// binding any node:fs name outside the small read-only allowlist, so every
// directory-create, rename, and recursive-remove in that file must come from
// here instead. No added behavior beyond the raw primitive — the point is the
// IMPORT BOUNDARY, not a new atomicity guarantee (mkdir/rename/rm already are
// what they are).
export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function renameIntoPlace(from: string, to: string): void {
  renameSync(from, to);
}

export function removeTreeSync(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// Parse an anchor-relative boundary path into components without first
// normalizing away `..`. win32.parse recognises both slash families on every
// host and preserves Windows drive/UNC roots, so a POSIX slash cannot hide a
// component from a native Windows walk and a Windows root cannot become a
// relative filename on POSIX.
function boundaryRelativePartsOrThrow(anchorReal: string, rel: string): string[] {
  if (win32.parse(rel).root !== "") {
    throw new Error(`path escapes its anchor lexically: ${rel}`);
  }

  const parts: string[] = [];
  let cursor = rel;
  while (cursor !== "" && cursor !== ".") {
    const parsed = win32.parse(cursor);
    if (parsed.root !== "") {
      throw new Error(`path escapes its anchor lexically: ${rel}`);
    }
    if (parsed.base !== "" && parsed.base !== ".") {
      parts.unshift(parsed.base);
    }
    if (parsed.dir === "" || parsed.dir === ".") break;
    if (parsed.dir === cursor) {
      throw new Error(`path escapes its anchor lexically: ${rel}`);
    }
    cursor = parsed.dir;
  }

  if (parts.some((part) => part === "..")) {
    throw new Error(`path component ".." escapes its anchor ${anchorReal}: ${rel}`);
  }
  return parts;
}

// Walk `rel` one component at a time from a REAL anchor and refuse if ANY
// component is a symlink or junction, returning the joined native path when the
// whole chain is clean. Both slash families delimit components. Throws (does
// not exit) so each caller attaches its own message and code.
//
// Why per-COMPONENT rather than one realpath of the leaf: a containment check on
// the fully-resolved leaf answers "does this land inside?" but not "did we travel
// through something that could be repointed later". Checking each component is
// what makes the guard hold for a directory that does not exist yet, too — a
// missing component cannot redirect anything, so it is skipped rather than failed.
//
// This is the primitive behind "every leaf is checked, not just the dir": a walk
// that validates the container and then trusts its contents will happily read a
// symlinked file inside an already-trusted directory. Callers must run this for
// each leaf they touch, not once for the parent.
export function assertNoSymlinkInChainOrThrow(anchorReal: string, rel: string): string {
  if (rel === "") return anchorReal;
  const parts = boundaryRelativePartsOrThrow(anchorReal, rel);
  let current = anchorReal;
  for (const part of parts) {
    if (part.length === 0) continue;
    const child = join(current, part);
    let isSymlink = false;
    try {
      isSymlink = lstatSync(child).isSymbolicLink();
    } catch {
      // Does not exist yet — nothing to redirect through.
    }
    if (isSymlink) {
      throw new Error(
        `${child} is a symlink, and no path component may be a symlink here. ` +
          `A redirected container directory is refused exactly like a symlink found ` +
          `INSIDE an already-trusted one.`,
      );
    }
    current = child;
  }
  return current;
}

/** A file's identity as exact integers. NTFS file IDs keep a sequence number in
 *  their top 16 bits, so they exceed 2^53 and a JS number rounds them: two files
 *  created one after the other can read as the same number. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The exact identity of the file at a path, or behind an open descriptor. */
export function fileIdentity(target: string | number): FileIdentity {
  const st = typeof target === "number"
    ? fstatSync(target, { bigint: true })
    : statSync(target, { bigint: true });
  return { dev: st.dev, ino: st.ino };
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// THE read boundary for any path that came from OUTSIDE the workspace — a CLI
// flag, a value-transport file, a committed ledger row. Returns the contents of a
// REGULAR file or throws; it never blocks indefinitely and never follows a link.
//
// It lives here, shared, because scoping this check to one tool is what let the
// same defect ship twice. Two properties, both load-bearing:
//
//   TYPE. Only a regular file is read. Rejecting symlinks alone is a denylist
//   that admits every other kind: a FIFO with no writer blocks forever (and if
//   the caller holds a lock, it blocks the whole workspace with it), and a
//   character device such as /dev/zero never reaches EOF, so the read grows a
//   buffer until the process dies of ENOMEM.
//
//   TIME. `lstat(path)` then `readFileSync(path)` validates one file and reads
//   another if something swapped the name in between — and readFileSync follows
//   symlinks, so the swap can redirect the read to any file this process can
//   read. Opening ONCE with O_NOFOLLOW and fstat-ing THAT descriptor makes the
//   final-component identity checked the identity read. A caller that validated
//   parent-chain containment first passes an expected identity or real path as
//   well, binding the opened descriptor to the file observed while that
//   containment held.
//
// Throws (does not exit) so each caller can attach its own flag name and exit
// code. `what` names the thing in the message: "--text-file", "source", ….
export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes?: number,
  expected?: FileIdentity | string,
): Buffer;

export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes: number | undefined,
  expected: FileIdentity | string | undefined,
  withSnapshot: true,
): { bytes: Buffer; mtimeMs: number };

export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes?: number,
  expected?: FileIdentity | string,
  withSnapshot = false,
): Buffer | { bytes: Buffer; mtimeMs: number } {
  const expectedIdentity = typeof expected === "object" ? expected : undefined;
  const expectedRealPath = typeof expected === "string" ? expected : undefined;
  let fd: number;
  try {
    // O_NONBLOCK matters as much as O_NOFOLLOW here, and for a non-obvious
    // reason: opening a FIFO for reading BLOCKS IN open() until a writer appears,
    // so without it the process hangs before fstat can report the kind and reject
    // it. (Measured: the fix looked complete while a FIFO still hung, and a stack
    // sample showed the process parked in open(), not read().) O_NONBLOCK is
    // harmless for a regular file — it does not make reads short — and the
    // descriptor is rejected below anyway if it is not a regular file.
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    // Preserve the errno so callers (the atomic-replace retry wrapper, shard
    // readers distinguishing a vanished file) can dispatch on it.
    const err = new Error(`${what} could not be opened: ${path} (${errorMessage(e)})`);
    (err as NodeJS.ErrnoException).code = code;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    const identity = fileIdentity(fd);
    if (
      expectedIdentity !== undefined &&
      !sameFileIdentity(identity, expectedIdentity)
    ) {
      throw changedDuringReadError(
        `${what} changed after project-containment validation: ${path}`,
      );
    }
    if (!st.isFile()) {
      const kind = st.isFIFO()
        ? "a FIFO / named pipe"
        : st.isSocket()
          ? "a socket"
          : st.isCharacterDevice()
            ? "a character device"
            : st.isBlockDevice()
              ? "a block device"
              : st.isDirectory()
                ? "a directory"
                : "not a regular file";
      throw new Error(
        `${what} is not a regular file (${kind}): ${path}. ` +
          `Only regular files are read — a FIFO, socket, or device file can block ` +
          `forever or never reach EOF, so it is refused before any read.`,
      );
    }
    // No links left means an atomic replace or unlink landed after the open:
    // the file changed, it is not a hardlink.
    if (st.nlink === 0) {
      throw changedDuringReadError(`${what} was replaced while it was being read: ${path}`);
    }
    if (st.nlink !== 1) {
      throw new Error(
        `${what} is multiply linked (a hardlink) and is not trusted: ${path}. ` +
          `A hardlink can alias content from elsewhere on the filesystem into this ` +
          `directory. Replace it with an independent copy — ` +
          `cp <file> <file>.copy && mv <file>.copy <file> — and re-run.`,
      );
    }
    if (maxBytes !== undefined && st.size > maxBytes) {
      throw new Error(
        `${what} is ${st.size} bytes, above the ${maxBytes}-byte limit: ${path}. ` +
          `Reduce the file before retrying.`,
      );
    }
    // Fallback for platforms without O_NOFOLLOW, and a pathname/descriptor
    // identity check for races on every platform.
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const currentRealPath = realpathSync(path);
    if (
      expectedRealPath !== undefined &&
      currentRealPath !== expectedRealPath
    ) {
      throw new Error(
        `${what} resolved outside its prevalidated path: ${path} -> ${currentRealPath}. ` +
          `No path component may be replaced by a symlink while the file is read.`,
      );
    }
    if (!sameFileIdentity(fileIdentity(currentRealPath), identity)) {
      throw changedDuringReadError(`${what} changed while opening: ${path}`);
    }
    let bytes: Buffer;
    if (maxBytes === undefined) {
      bytes = readFileSync(fd);
    } else {
      // The stat check rejects files already over the cap. Bound the descriptor
      // read as well so a file that grows concurrently cannot force an
      // allocation beyond its original size plus one detection byte.
      const bounded = Buffer.alloc(Math.min(maxBytes + 1, st.size + 1));
      let length = 0;
      while (length < bounded.length) {
        const count = readSync(
          fd,
          bounded,
          length,
          bounded.length - length,
          length,
        );
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) {
        const currentSize = fstatSync(fd).size;
        throw new Error(
          `${what} is ${currentSize} bytes, above the ${maxBytes}-byte limit: ${path}. ` +
            "Reduce the file before retrying.",
        );
      }
      bytes = bounded.subarray(0, length);
    }
    const afterRealPath = realpathSync(path);
    if (
      expectedRealPath !== undefined &&
      afterRealPath !== expectedRealPath
    ) {
      throw new Error(
        `${what} resolved outside its prevalidated path while being read: ${path} -> ${afterRealPath}. ` +
          `No path component may be replaced by a symlink while the file is read.`,
      );
    }
    const afterFd = fstatSync(fd);
    if (!sameFileIdentity(fileIdentity(afterRealPath), identity) ||
        afterFd.nlink !== 1 || afterFd.size !== st.size ||
        afterFd.mtimeMs !== st.mtimeMs || afterFd.ctimeMs !== st.ctimeMs ||
        bytes.length !== st.size) {
      throw changedDuringReadError(`${what} changed while reading: ${path}`);
    }
    return withSnapshot ? { bytes, mtimeMs: st.mtimeMs } : bytes;
  } finally {
    closeSync(fd);
  }
}

/** The identity/equality throws above carry a typed code so callers can tell
 *  "the name changed inodes under me" (retryable when the writer is a known
 *  atomic-replacer) from a symlink/kind/permission refusal (never retried). */
export const FILE_CHANGED_DURING_READ = "AIDLC_FILE_CHANGED_DURING_READ";
function changedDuringReadError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = FILE_CHANGED_DURING_READ;
  return err;
}

// The read boundary for FRAMEWORK-OWNED files whose ONLY writer is
// writeFileAtomic/writeBufferAtomic (tmp + rename) — documentkb/index.json,
// per-document metadata.json, derived content.md, the sources alias map.
//
// An atomic replace swaps the inode behind the name, which the strict
// reader's identity check cannot distinguish from a hostile name-swap — so a
// read racing a legitimate concurrent writer threw "changed while opening"
// and killed the whole command (measured: 2-3 of 24 concurrent onboards
// under load). The swap is instantaneous, so the fix is a bounded retry:
// each attempt re-runs the FULL boundary check from open, a hostile swap
// (symlink, wrong kind) throws a NON-retryable refusal on its next attempt,
// and a replace-storm that outlasts every retry propagates the original
// error honestly.
export function readAtomicReplacedFileNoFollowOrThrow(
  path: string,
  what: string,
  attempts = 8,
): Buffer {
  for (let attempt = 1; ; attempt++) {
    try {
      return readRegularFileNoFollowOrThrow(path, what);
    } catch (e) {
      // ENOENT is retryable here too, not only the identity code: mid-swap,
      // realpath of the just-unlinked inode can surface as a transient
      // ENOENT (measured on Bun as a literal "<path> (deleted)" statx). For
      // a file whose writer is atomic-replace, "briefly absent" IS the swap
      // window; a file that is genuinely gone still propagates once the
      // retries are exhausted.
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== FILE_CHANGED_DURING_READ && code !== "ENOENT") ||
          attempt >= attempts) {
        throw e;
      }
      // 5ms × attempt backoff: the rename itself is instantaneous; the wait
      // only needs to outlast the writer's tmp-write + rename window.
      Bun.sleepSync(5 * attempt);
    }
  }
}

// The read boundary for FRAMEWORK-OWNED APPEND-ONLY files — audit shards.
// Same open-once O_NOFOLLOW|O_NONBLOCK discipline as
// readRegularFileNoFollowOrThrow (TYPE and TIME both hold: only a regular
// file is read, and the identity fstat-ed is the identity read), with two
// deliberate relaxations the strict reader must not make and a shard reader
// must:
//
//   GROWTH IS NORMAL. A live ledger is being appended to by hooks and verbs
//   while readers scan it. The strict reader's size/mtime/ctime equality
//   check therefore threw on the ledger's NORMAL state — measured: under a
//   concurrent appender ~88% of strict reads failed — and every consumer's
//   catch then dropped the ENTIRE shard, silently erasing history from
//   graph rebuilds, review-budget counts, receipt freshness, and the
//   human-presence gate. A torn TAIL block is harmless by construction:
//   every audit parser requires a complete block (Event + Timestamp + the
//   `\n---\n` terminator) and discards a partial one.
//
//   NLINK IS NOT A TRUST SIGNAL HERE. rsync --link-dest and cp -al backup
//   snapshots leave live project files with nlink 2; refusing them made one
//   backup run brick every later audit read. Hardlinks cannot redirect a
//   contained, symlink-chain-checked path — they alias the same inode — so
//   the strict reader keeps its nlink refusal only where the CONTENT is
//   untrusted (customer documents) or the operation is an explicit
//   fork/merge snapshot.
export function readAppendOnlyFileNoFollowOrThrow(path: string, what: string): Buffer {
  let fd: number;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const err = new Error(`${what} could not be opened: ${path} (${errorMessage(e)})`);
    (err as NodeJS.ErrnoException).code = code;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`${what} is not a regular file: ${path}`);
    }
    // Fallback for platforms without O_NOFOLLOW, and a pathname/descriptor
    // identity check for races on every platform.
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const current = statSync(realpathSync(path));
    if (current.dev !== st.dev || current.ino !== st.ino) {
      throw new Error(`${what} changed while opening: ${path}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// withAuditLock — atomic locked-section helper. Acquires the audit lock,
// installs an exit-handler safety net (so a process.exit inside `fn` still
// releases the lock dir), runs `fn`, releases the lock. Use this when you
// need to hold the lock across multiple reads/writes (e.g., audit-first
// state mutations that emit audit + write state atomically).
//
// Reentrant within a single process for the same projectDir: nested calls
// just bump depth and run `fn`; only the outermost call performs OS-level
// acquire/release. Cross-process locking is unchanged.
//
// SYNC ONLY. The return type excludes Promise so a caller can't pass an
// async function that releases the lock before its work settles. Today's
// callers are all sync (compile, state.ts fork/merge); future async-locked
// transactions need a separate `withAuditLockAsync` that awaits before
// release. The compile-time guard catches the footgun at the call site.
export function withAuditLock<T>(
  projectDir: string,
  fn: () => T extends Promise<unknown> ? never : T,
  intent?: string,
  space?: string,
  // Shared acquire backstop. A caller that legitimately waits behind a
  // long-lived holder (select-plugins behind a full plugin compose: compile +
  // runner regeneration) passes a larger budget; dead holders are reaped
  // immediately regardless, so a big budget only ever waits on live work.
  maxRetries?: number,
  retryMs = 100,
  // Long external operations can opt out of over-age doctor classification.
  // Automatic acquisition never reaps a live owner regardless of this flag;
  // provably-dead owners remain immediately reclaimable.
  reapLiveOwnerAfterStale = true,
): T extends Promise<unknown> ? never : T {
  const requestKey = auditLockRequestKey(projectDir, intent, space);
  let key =
    AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ??
    auditLockIdentity(projectDir, intent, space);
  const currentDepth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
  if (currentDepth === 0) {
    if (
      !acquireAuditLock(
        projectDir,
        maxRetries,
        retryMs,
        intent,
        space,
        reapLiveOwnerAfterStale,
      )
    ) {
      throw new Error(`Failed to acquire audit lock for ${key} after retries`);
    }
    key = AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ?? key;
    const receipt = AUDIT_LOCK_RECEIPTS.get(key);
    if (!receipt) {
      throw new Error(`Audit lock receipt missing after acquire for ${key}`);
    }
    // Safety net: if the body calls process.exit (Bun skips `finally` in that
    // case), the on-exit handler releases the lock dir so the project isn't
    // left waiting for the acquisition backstop on the next invocation.
    const onExit = () => { releaseCanonicalOwnerStampedLock(receipt); };
    AUDIT_LOCK_EXIT_HANDLERS.set(key, onExit);
    process.on("exit", onExit);
  }
  AUDIT_LOCK_DEPTH.set(key, currentDepth + 1);
  try {
    return fn();
  } finally {
    const depth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
    if (depth <= 1) {
      AUDIT_LOCK_DEPTH.delete(key);
      releaseAuditLock(projectDir, intent, space);
    } else {
      AUDIT_LOCK_DEPTH.set(key, depth - 1);
    }
  }
}

// True iff THIS process currently holds the audit lock for the given request
// via an outer withAuditLock. The lock-acquire path registers a per-request exit
// handler and the release path removes it (see
// AUDIT_LOCK_EXIT_HANDLERS), so the handler's presence is the in-lock signal.
// emitError (below) already branches on this to pick appendAuditEntryUnlocked
// vs appendAuditEntry; the state tool's emitAudit helper uses it for the same
// reason — an audit emit issued from inside a held lock MUST use the unlocked
// variant or it self-deadlocks against the lock it is already holding
// (appendAuditEntry calls acquireAuditLock, which is NOT reentrant — only
// withAuditLock's depth counter is — so it would burn the full acquisition
// budget and then throw).
export function holdsAuditLock(projectDir: string, intent?: string, space?: string): boolean {
  const { identityKey } = auditLockBoundIdentity(projectDir, intent, space);
  return AUDIT_LOCK_EXIT_HANDLERS.has(identityKey);
}

// --- Doctor probe: leaked audit locks ----------------------------------------
//
// Doctor surfaces provably-dead, old never-finished-stamp, over-age live,
// invalid, and unreadable locks. Automatic clear is restricted to dead valid
// owners and old stamps that never finished; every ambiguous/live case remains
// fail-closed.
// We can't enumerate tmpdir() hashes back to
// projects, so we probe the buckets THIS project would use: the workspace
// sentinel bucket + every intent record across every space (the same identities
// the writers key on). A leaked lock is reported with its bucket + owner PID.

export interface LeakedLock {
  bucket: string; // "__workspace__" or "<space>/<intent>"
  lockDir: string; ownerPid: number | null;
  reason:
    | "dead-owner"
    | "over-age"
    | "unstamped"
    | "invalid-owner"
    | "unreadable-owner"
    | "generation-unavailable"
    | "released-gate"
    | "legacy-transaction";
  kind:
    | "audit"
    | "active-directive"
    | "coordination-gate"
    | "legacy-active-directive-transaction";
  cleared: boolean;
}

function clearCoordinationGate(
  lockDir: string,
  expectedOwner: LockOwner,
  reason: "released-gate" | "dead-owner",
): boolean {
  const mutex = acquireNativeGateMutex(lockDir);
  if (!mutex) return false;
  try {
    const gateDir = reapClaimDir(lockDir);
    const current = inspectOwnerStamp(gateDir);
    if (
      current.status !== "ok" ||
      !ownerStampsEqual(current.owner, expectedOwner)
    ) return false;
    if (reason === "released-gate") {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleasableGateCheck?.(gateDir);
      return (
        reapGateReleaseState(gateDir, current.owner) === "releasable" &&
        retireReapClaim(gateDir)
      );
    }
    const state = ownerProcessState(current.owner);
    return (
      (state === "dead" || state === "different") &&
      recoverReapClaim(lockDir, current.owner)
    );
  } finally {
    releaseNativeGateMutex(mutex);
  }
}

// Detect (and safely clear eligible) leaked locks for this project. Returns the
// findings and whether each was cleared. Pure-read when clear=false.
export function detectLeakedLocks(projectDir: string, clear = false): LeakedLock[] {
  const leaks: LeakedLock[] = [];
  const probeCoordinationGate = (
    bucketLabel: string,
    lockDir: string,
  ): void => {
    const gateDir = reapClaimDir(lockDir);
    if (!existsSync(gateDir)) return;
    const inspected = inspectOwnerStamp(gateDir);
    if (inspected.status === "invalid" || inspected.status === "unreadable") {
      leaks.push({
        bucket: bucketLabel,
        lockDir: gateDir,
        ownerPid: null,
        reason: inspected.status === "invalid" ? "invalid-owner" : "unreadable-owner",
        kind: "coordination-gate",
        cleared: false,
      });
      return;
    }
    if (inspected.status === "ok") {
      const releaseState = reapGateReleaseState(gateDir, inspected.owner);
      if (releaseState === "invalid") {
        leaks.push({
          bucket: bucketLabel,
          lockDir: gateDir,
          ownerPid: inspected.owner.pid,
          reason: "invalid-owner",
          kind: "coordination-gate",
          cleared: false,
        });
        return;
      }
      if (releaseState !== "releasable") {
        const state = ownerProcessState(inspected.owner);
        if (state === "dead" || state === "different") {
          const cleared = clear
            ? clearCoordinationGate(lockDir, inspected.owner, "dead-owner")
            : false;
          leaks.push({
            bucket: bucketLabel,
            lockDir: gateDir,
            ownerPid: inspected.owner.pid,
            reason: "dead-owner",
            kind: "coordination-gate",
            cleared,
          });
        }
        return;
      }
      const cleared = clear
        ? clearCoordinationGate(lockDir, inspected.owner, "released-gate")
        : false;
      leaks.push({
        bucket: bucketLabel,
        lockDir: gateDir,
        ownerPid: inspected.owner.pid,
        reason: "released-gate",
        kind: "coordination-gate",
        cleared,
      });
      return;
    }
  };
  const probe = (bucketLabel: string, intent?: string, space?: string): void => {
    const lockDir = auditLockDir(projectDir, intent, space);
    probeCoordinationGate(bucketLabel, lockDir);
    if (!existsSync(lockDir)) return;
    const inspected = inspectOwnerStamp(lockDir);
    const owner = inspected.status === "ok" ? inspected.owner : null;
    let reason: LeakedLock["reason"] | null = null;
    if (inspected.status === "invalid") {
      reason = "invalid-owner";
    } else if (inspected.status === "unreadable") {
      reason = "unreadable-owner";
    } else if (inspected.status === "missing") {
      // Unstamped (no finished stamp): only a leak once older than the grace.
      if (unstampedPastGrace(lockDir)) {
        reason = "unstamped";
      }
    } else if (inspected.status === "ok") {
      const state = ownerProcessState(inspected.owner);
      if (state === "dead" || state === "different") {
        reason = "dead-owner";
      } else if (state === "unknown") {
        reason = "generation-unavailable";
      } else if (
        inspected.owner.reapLiveOwnerAfterStale &&
        lockAcquireEpochMs() - inspected.owner.startedAtMs > lockStaleMs()
      ) {
        reason = "over-age";
      }
    }
    if (reason === null) return; // a live, fresh, stamped lock is legitimately held
    const cleared = clear && (reason === "dead-owner" || reason === "unstamped")
      ? reapStaleLock(lockDir)
      : false;
    leaks.push({ bucket: bucketLabel, lockDir, ownerPid: owner?.pid ?? null, reason, kind: "audit", cleared });
  };
  const probeActiveDirective = (bucketLabel: string, root: string): void => {
    const lockDir = join(engineDirFor(root), ACTIVE_DIRECTIVE_LOCK);
    probeCoordinationGate(bucketLabel, lockDir);
    if (existsSync(lockDir)) {
      const inspected = inspectOwnerStamp(lockDir);
      const owner = inspected.status === "ok" ? inspected.owner : null;
      let reason: LeakedLock["reason"] | null = null;
      if (inspected.status === "invalid") {
        reason = "invalid-owner";
      } else if (inspected.status === "unreadable") {
        reason = "unreadable-owner";
      } else if (inspected.status === "missing") {
        if (unstampedPastGrace(lockDir)) reason = "unstamped";
      } else if (inspected.status === "ok") {
        const state = ownerProcessState(inspected.owner);
        if (state === "dead" || state === "different") {
          reason = "dead-owner";
        } else if (state === "unknown") {
          reason = "generation-unavailable";
        } else if (
          inspected.owner.reapLiveOwnerAfterStale &&
          lockAcquireEpochMs() - inspected.owner.startedAtMs > lockStaleMs()
        ) {
          reason = "over-age";
        }
      }
      if (reason !== null) {
        const cleared = clear && (reason === "dead-owner" || reason === "unstamped")
          ? reapStaleLock(lockDir)
          : false;
        leaks.push({ bucket: bucketLabel, lockDir, ownerPid: owner?.pid ?? null, reason,
          kind: "active-directive", cleared });
      }
    }
    const legacy = join(root, LEGACY_ACTIVE_DIRECTIVE_TRANSACTION_FILE);
    if (existsSync(legacy)) {
      leaks.push({ bucket: bucketLabel, lockDir: legacy, ownerPid: null, reason: "legacy-transaction",
        kind: "legacy-active-directive-transaction", cleared: false });
    }
  };
  // Workspace sentinel bucket.
  probe(WORKSPACE_LOCK_SENTINEL);
  // Every intent record across every space.
  const spacesRoot = join(workspaceRoot(projectDir), "spaces");
  let spaces: string[] = [];
  try { spaces = readdirSync(spacesRoot); } catch { /* no spaces dir */ }
  spaces = [...new Set([...spaces, activeSpace(projectDir)])];
  for (const sp of spaces) {
    probeActiveDirective(`${sp}/bare-space`, spaceRecordRoot(projectDir, sp));
    for (const intent of listIntentDirs(projectDir, sp)) {
      probe(`${sp}/${intent}`, intent, sp);
      probeActiveDirective(`${sp}/${intent}`, join(intentsDir(projectDir, sp), intent));
    }
  }
  // The flat-legacy project also keys on the workspace bucket for its writes, so
  // the sentinel probe above already covers it.
  return leaks;
}

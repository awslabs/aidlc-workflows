import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  SPACE_NAME_REGEX,
  sessionsDir,
  shellArg,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";
import { aidlcDispatcherInvocation } from "./aidlc-runtime-paths.ts";

// Which ask minted a request: a cold-start ask (scope-confirm, compose-offer,
// or a creation print) names new work; a new-work-routing ask was asked about
// work that already exists, so its compose route reshapes that work.
export type PendingRequestOrigin = "front" | "routing";

/** A record a new-work-routing ask was about, by folder and immutable uuid. */
export interface RoutingTarget {
  intent: string;
  uuid: string;
}

// The `intent create` settings a claimed creation used, replayed verbatim by
// the fresh command its refusal offers. Every value was validated by that
// creation before the claim.
const CREATION_SETTINGS = [
  "scope",
  "label",
  "depth",
  "test-strategy",
  "review",
  "guard-policy",
  "change-control",
  "sensors",
  "learnings",
  "summary-confirmation",
  "repos",
  "space",
] as const;
export type CreationSettings = Partial<Record<(typeof CREATION_SETTINGS)[number], string>>;

export interface PendingRequest {
  id: string;
  description: string;
  proposedScope: string;
  createdAt: string;
  origin?: PendingRequestOrigin;
  /** For a routing request: the space and records its compose route may reshape. */
  routingSpace?: string;
  routingTargets?: RoutingTarget[];
  /** Set inside the creation transaction, before the intent is minted. */
  claimedAt?: string;
  /** The settings that creation used, which the human may have changed from the proposal. */
  claimedCreation?: CreationSettings;
  /** The record the claimed request minted and its space, for messages only. */
  createdIntent?: string;
  createdSpace?: string;
  /** Set once that record's creation transaction finished. */
  completedAt?: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// A record folder name: one path component.
const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The record name createIntent mints: `<YYMMDD>-<slug>`, plus `-<n>` on a clash.
const MINTED_RECORD = /^[0-9]{6}-[a-z][a-z0-9-]*$/;
// A request is dropped a week after it was asked, claimed, or completed, so
// abandoned asks do not pile up and an interrupted claim keeps its week.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_MAX_BYTES = 4 * 1024 * 1024;
const POSIX = process.platform !== "win32";

// One gitignored file per request id in this clone's session runtime directory.
// Every ask mints its own id, so concurrent sessions in one clone never share or
// invalidate each other's requests. Every path is reached through no symlink,
// and on POSIX the directory is owner-only because records hold request text.
function pendingRequestRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "pending-requests");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

function isCreationSettings(value: unknown): value is CreationSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(([key, setting]) =>
      (CREATION_SETTINGS as readonly string[]).includes(key) && typeof setting === "string"
    );
}

function isRoutingTargets(value: unknown): value is RoutingTarget[] {
  return Array.isArray(value) && value.every((target) =>
    typeof target?.intent === "string" && RECORD_NAME.test(target.intent) &&
    typeof target.uuid === "string"
  );
}

// Another account's file is not this user's request, and is never touched.
function ownedByAnotherAccount(target: string): boolean {
  return POSIX && lstatSync(target).uid !== process.getuid?.();
}

function readRecord(projectDir: string, id: string): PendingRequest | null {
  if (!PENDING_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir, id));
    if (ownedByAnotherAccount(target)) return null;
    const request = JSON.parse(
      readRegularFileNoFollowOrThrow(target, "pending request", PENDING_MAX_BYTES).toString("utf-8"),
    );
    if (
      request?.id === id &&
      typeof request.description === "string" && request.description.trim() &&
      typeof request.proposedScope === "string" &&
      typeof request.createdAt === "string" &&
      Date.now() - Date.parse(request.completedAt ?? request.claimedAt ?? request.createdAt) <= PENDING_TTL_MS &&
      (request.origin === undefined || request.origin === "front" || request.origin === "routing") &&
      (request.routingSpace === undefined ||
        (typeof request.routingSpace === "string" && SPACE_NAME_REGEX.test(request.routingSpace))) &&
      (request.routingTargets === undefined || isRoutingTargets(request.routingTargets)) &&
      (request.claimedCreation === undefined || isCreationSettings(request.claimedCreation)) &&
      (request.createdIntent === undefined ||
        (typeof request.createdIntent === "string" && MINTED_RECORD.test(request.createdIntent))) &&
      (request.createdSpace === undefined ||
        (typeof request.createdSpace === "string" && SPACE_NAME_REGEX.test(request.createdSpace)))
    ) return request;
  } catch {
    // Missing, expired, redirected, or unreadable: it cannot authorize anything.
  }
  return null;
}

// Test-only: pause between checking a path and opening it, so a test can swap
// an ancestor inside that window.
function waitAtPermissionBarrier(kind: "directory" | "file"): void {
  const barrier = process.env.AIDLC_TEST_PENDING_CHMOD_BARRIER?.trim();
  if (!barrier) return;
  writeFileSync(`${barrier}.${kind}.checked`, "checked\n", "utf-8");
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (!existsSync(`${barrier}.${kind}.release`)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting at the pending-request permission barrier");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

// Set a mode through a descriptor opened without following a link. O_NOFOLLOW
// guards only the last component, so after opening, re-check the whole chain
// and prove the path still names the descriptor's own file, inside the
// project, before changing anything: a swapped ancestor aborts the change.
function chmodNoFollow(projectDir: string, rel: string, mode: number, directory: boolean): void {
  const path = recordFileTargetOrThrow(projectDir, rel);
  waitAtPermissionBarrier(directory ? "directory" : "file");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const opened = fstatSync(fd);
    const projectReal = realpathSync(projectDir);
    const currentReal = realpathSync(recordFileTargetOrThrow(projectDir, rel));
    const current = statSync(currentReal);
    if (
      (directory ? !opened.isDirectory() : !opened.isFile()) ||
      !currentReal.startsWith(`${projectReal}${sep}`) ||
      current.dev !== opened.dev || current.ino !== opened.ino
    ) {
      throw new Error(`${path} changed while its permissions were being set`);
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

// Create the directory owner-only, and tighten one left wider by an earlier
// run or a different umask. A private directory also covers the atomic
// writer's temporary file, which is created with the process default mode.
function ensurePrivateDir(projectDir: string): void {
  const rel = pendingRequestRel(projectDir);
  const dir = recordFileTargetOrThrow(projectDir, rel);
  // Only this leaf is private; the shared workspace parents keep their modes.
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (POSIX) chmodNoFollow(projectDir, rel, 0o700, true);
}

function writeRecord(projectDir: string, request: PendingRequest): void {
  ensurePrivateDir(projectDir);
  const rel = pendingRequestRel(projectDir, request.id);
  writeRecordFileNoFollow(projectDir, rel, `${JSON.stringify(request)}\n`);
  if (POSIX) chmodNoFollow(projectDir, rel, 0o600, false);
}

// Called with the directory already private. Only this account's expired or
// unreadable records are removed; another account's are left alone.
function pruneExpired(projectDir: string): void {
  let names: string[];
  try {
    const dir = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir));
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const path = join(dir, name);
      if (!PENDING_ID.test(id) || !lstatSync(path).isFile() || ownedByAnotherAccount(path)) continue;
      if (readRecord(projectDir, id) === null) {
        removeRecordFileNoFollow(projectDir, pendingRequestRel(projectDir, id));
      }
    }
  } catch {
    // No directory yet, or one this process must not touch: nothing to prune.
  }
}

// Every ask mints its own request, and a stored request is only ever rewritten
// by its own claim. Re-running `next` for the same prose therefore returns an
// equivalent ask with a new id, and the earlier id stays valid until it is
// used or expires.
export function savePendingRequest(
  projectDir: string,
  description: string,
  proposedScope: string,
  origin: PendingRequestOrigin = "front",
  routing?: { space: string; targets: RoutingTarget[] },
): PendingRequest {
  ensurePrivateDir(projectDir);
  pruneExpired(projectDir);
  const request: PendingRequest = {
    id: randomBytes(4).toString("hex"),
    description,
    proposedScope,
    createdAt: new Date().toISOString(),
    origin,
    ...(routing ? { routingSpace: routing.space, routingTargets: routing.targets } : {}),
  };
  writeRecord(projectDir, request);
  return request;
}

/**
 * Whether a routing request's compose route may reshape the selected record:
 * only the record, or one of the records, its question was about.
 */
export function routingTargetSelected(
  request: PendingRequest,
  selection: { space: string; intent: string | null; uuid: string | null },
): boolean {
  return request.routingSpace === selection.space &&
    (request.routingTargets ?? []).some((target) =>
      target.intent === selection.intent && target.uuid === (selection.uuid ?? "")
    );
}

/** The unclaimed request behind `id`; null when it is missing, used, or expired. */
export function readPendingRequest(projectDir: string, id: string): PendingRequest | null {
  const request = readRecord(projectDir, id);
  return request && request.claimedAt === undefined ? request : null;
}

/**
 * Claim `id` for the creation about to run. Call it inside the workspace
 * mutation lock, after every refusal and before anything is minted, so a
 * request creates at most one intent: a claimed request is never used again.
 */
export function claimPendingRequest(
  projectDir: string,
  id: string,
  flags: Record<string, string | undefined>,
): PendingRequest | null {
  const request = readPendingRequest(projectDir, id);
  if (!request) return null;
  const claimedCreation: CreationSettings = {};
  for (const name of CREATION_SETTINGS) {
    const value = flags[name];
    if (value) claimedCreation[name] = value;
  }
  const claimed = { ...request, claimedAt: new Date().toISOString(), claimedCreation };
  writeRecord(projectDir, claimed);
  return claimed;
}

/** Note the record a claimed request minted, so a later refusal can name it. */
export function recordPendingRequestMinted(
  projectDir: string,
  id: string,
  intent: string,
  space: string,
): void {
  const request = readRecord(projectDir, id);
  if (request?.claimedAt !== undefined) {
    writeRecord(projectDir, { ...request, createdIntent: intent, createdSpace: space });
  }
}

/** Mark a claimed request complete once its creation transaction finished. */
export function completePendingRequest(projectDir: string, id: string): void {
  const request = readRecord(projectDir, id);
  if (request?.claimedAt !== undefined) {
    writeRecord(projectDir, { ...request, completedAt: new Date().toISOString() });
  }
}

/**
 * A fresh single-use command that creates `request` again with the settings
 * its interrupted creation used, so a refusal never replays the used id.
 */
export function freshCreationCommand(projectDir: string, request: PendingRequest): string {
  const settings = request.claimedCreation ?? { scope: request.proposedScope };
  const fresh = savePendingRequest(projectDir, request.description, settings.scope ?? request.proposedScope);
  const args = settings.scope ? [`--scope ${shellArg(settings.scope)}`] : [];
  args.push(`--pending-request ${fresh.id}`);
  for (const name of CREATION_SETTINGS) {
    const value = settings[name];
    if (name !== "scope" && value) args.push(`--${name} ${shellArg(value)}`);
  }
  return `${aidlcDispatcherInvocation("intent create")} ${args.join(" ")}`;
}

/**
 * The claimed but unfinished request that minted `intent` in `space`, if any.
 * It is used only to word guidance: nothing is ever removed on its behalf.
 */
export function unfinishedCreationOf(
  projectDir: string,
  intent: string,
  space: string,
): PendingRequest | null {
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir)));
  } catch {
    return null;
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    const request = readRecord(projectDir, id);
    if (
      request?.claimedAt !== undefined && request.completedAt === undefined &&
      request.createdIntent === intent && request.createdSpace === space
    ) {
      return request;
    }
  }
  return null;
}

/**
 * Why `id` no longer authorizes a continuation. A creation that was claimed
 * and did not finish is never retried or undone automatically: the message
 * names the record it left and a fresh single-use command for the same request.
 */
export function pendingRequestUnavailable(projectDir: string, id: string): string {
  const used = readRecord(projectDir, id);
  if (used?.completedAt !== undefined && used.createdIntent) {
    return `Pending request ${id} already created ${used.createdIntent}; run next to continue that work.`;
  }
  if (used?.claimedAt !== undefined) {
    const left = used.createdIntent
      ? ` It left ${used.createdIntent}: run next to continue it, and if next reports that its setup never ` +
        `finished, set it aside with intent archive ${used.createdIntent}.`
      : " It created no record.";
    const again = ` To create the request again with the same settings, run \`${freshCreationCommand(projectDir, used)}\`, ` +
      "then run next to continue.";
    return `Creating from pending request ${id} did not finish, so it cannot be used again; nothing was removed.${left}${again}`;
  }
  return `Pending request ${id} is no longer available; restate the request.`;
}

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  SPACE_NAME_REGEX,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

// Which ask minted a request: a cold-start ask (scope-confirm, compose-offer,
// or a creation print) names new work; a new-work-routing ask was asked about
// work that already exists, so its compose route reshapes that work.
export type PendingRequestOrigin = "front" | "routing";

interface PendingRequest {
  id: string;
  description: string;
  proposedScope: string;
  createdAt: string;
  origin?: PendingRequestOrigin;
  /** Set inside the creation transaction, before the intent is minted. */
  claimedAt?: string;
  /** The scope that creation used, which the human may have changed from the proposal. */
  claimedScope?: string;
  /** The record the claimed request minted and its space, for messages only. */
  createdIntent?: string;
  createdSpace?: string;
  /** Set once that record's creation transaction finished. */
  completedAt?: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// The record name createIntent mints: `<YYMMDD>-<slug>`, plus `-<n>` on a clash.
const MINTED_RECORD = /^[0-9]{6}-[a-z][a-z0-9-]*$/;
// An unanswered request is dropped after a week so abandoned asks do not pile up.
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

function readRecord(projectDir: string, id: string): PendingRequest | null {
  if (!PENDING_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir, id));
    // Another account's file is not this user's request.
    if (POSIX && lstatSync(target).uid !== process.getuid?.()) return null;
    const request = JSON.parse(
      readRegularFileNoFollowOrThrow(target, "pending request", PENDING_MAX_BYTES).toString("utf-8"),
    );
    if (
      request?.id === id &&
      typeof request.description === "string" && request.description.trim() &&
      typeof request.proposedScope === "string" &&
      typeof request.createdAt === "string" &&
      Date.now() - Date.parse(request.completedAt ?? request.createdAt) <= PENDING_TTL_MS &&
      (request.origin === undefined || request.origin === "front" || request.origin === "routing") &&
      (request.claimedScope === undefined || typeof request.claimedScope === "string") &&
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

// Set a mode through a descriptor opened without following a link, so a path
// swapped after it was checked cannot redirect the change elsewhere.
function chmodNoFollow(path: string, mode: number, directory: boolean): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const stat = fstatSync(fd);
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
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
  const dir = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir));
  // Only this leaf is private; the shared workspace parents keep their modes.
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir));
  if (POSIX) chmodNoFollow(dir, 0o700, true);
}

function writeRecord(projectDir: string, request: PendingRequest): void {
  ensurePrivateDir(projectDir);
  const target = writeRecordFileNoFollow(
    projectDir,
    pendingRequestRel(projectDir, request.id),
    `${JSON.stringify(request)}\n`,
  );
  if (POSIX) chmodNoFollow(target, 0o600, false);
}

function pruneExpired(projectDir: string): void {
  let names: string[];
  try {
    const dir = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir));
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      if (!PENDING_ID.test(id) || !lstatSync(join(dir, name)).isFile()) continue;
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
): PendingRequest {
  pruneExpired(projectDir);
  const request: PendingRequest = {
    id: randomBytes(4).toString("hex"),
    description,
    proposedScope,
    createdAt: new Date().toISOString(),
    origin,
  };
  writeRecord(projectDir, request);
  return request;
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
  scope: string,
): PendingRequest | null {
  const request = readPendingRequest(projectDir, id);
  if (!request) return null;
  const claimed = { ...request, claimedAt: new Date().toISOString(), claimedScope: scope };
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
 * The claimed but unfinished request that minted `intent` in `space`, if any.
 * It is used only to word guidance: nothing is ever removed on its behalf.
 */
export function unfinishedCreationOf(
  projectDir: string,
  intent: string,
  space: string,
): { id: string; description: string; scope: string } | null {
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
      return { id, description: request.description, scope: request.claimedScope ?? request.proposedScope };
    }
  }
  return null;
}

/**
 * Why `id` no longer authorizes a continuation. A creation that was claimed
 * and did not finish is never retried or undone automatically: the message
 * names the record it left, and `retry` supplies a fresh single-use command
 * for the same request.
 */
export function pendingRequestUnavailable(
  projectDir: string,
  id: string,
  retry?: (request: { description: string; scope: string }) => string,
): string {
  const used = readRecord(projectDir, id);
  if (used?.completedAt !== undefined && used.createdIntent) {
    return `Pending request ${id} already created ${used.createdIntent}; run next to continue that work.`;
  }
  if (used?.claimedAt !== undefined) {
    const left = used.createdIntent
      ? ` It left ${used.createdIntent}: run next to continue it, and if next reports that its setup never ` +
        `finished, set it aside with intent archive ${used.createdIntent}.`
      : " It created no record.";
    const again = retry
      ? ` To create the request again, run \`${retry({
        description: used.description,
        scope: used.claimedScope ?? used.proposedScope,
      })}\`.`
      : " Restate the request to create it again.";
    return `Creating from pending request ${id} did not finish, so it cannot be used again; nothing was removed.${left}${again}`;
  }
  return `Pending request ${id} is no longer available; restate the request.`;
}

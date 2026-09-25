import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  sessionsDir,
  writeRecordFileNoFollow,
} from "./aidlc-lib.ts";

interface PendingRequest {
  id: string;
  description: string;
  proposedScope: string;
  createdAt: string;
  /** Set inside the creation transaction, before the intent is minted. */
  claimedAt?: string;
  /** The record the claimed request minted, and its space. */
  createdIntent?: string;
  createdSpace?: string;
  /** Set once that record's initialization finished. */
  completedAt?: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// An unanswered request is dropped after a week so abandoned asks do not pile up.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_MAX_BYTES = 4 * 1024 * 1024;

// One gitignored file per request id in this clone's session runtime directory.
// Every ask mints its own id, so concurrent sessions in one clone never share or
// invalidate each other's requests. Every path is reached through no symlink,
// and on POSIX the directory is owner-only because records hold request text.
function pendingRequestRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "pending-requests");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

const POSIX = process.platform !== "win32";

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
      Date.now() - Date.parse(request.createdAt) <= PENDING_TTL_MS
    ) return request;
  } catch {
    // Missing, expired, redirected, or unreadable: it cannot authorize anything.
  }
  return null;
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
  if (POSIX) chmodSync(dir, 0o700);
}

function writeRecord(projectDir: string, request: PendingRequest): void {
  ensurePrivateDir(projectDir);
  const target = writeRecordFileNoFollow(
    projectDir,
    pendingRequestRel(projectDir, request.id),
    `${JSON.stringify(request)}\n`,
  );
  if (POSIX) chmodSync(target, 0o600);
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

// A request that arrived with a live id keeps that id (its scope may change);
// otherwise every ask mints a fresh id. Re-running `next` for the same prose
// therefore returns an equivalent ask with a new id, and the earlier id stays
// valid until it is consumed or expires.
export function savePendingRequest(
  projectDir: string,
  description: string,
  proposedScope: string,
  reuseId?: string,
): PendingRequest {
  pruneExpired(projectDir);
  const live = reuseId !== undefined ? readPendingRequest(projectDir, reuseId) : null;
  if (live?.description === description && live.proposedScope === proposedScope) return live;
  const request: PendingRequest = {
    id: live ? live.id : randomBytes(4).toString("hex"),
    description,
    proposedScope,
    createdAt: live ? live.createdAt : new Date().toISOString(),
  };
  writeRecord(projectDir, request);
  return request;
}

/** The request behind `id` until its creation completes; null when missing, created, or expired. */
export function readPendingRequest(projectDir: string, id: string): PendingRequest | null {
  const request = readRecord(projectDir, id);
  return request && request.completedAt === undefined ? request : null;
}

/**
 * The earlier attempt a claim would supersede, if any. Called inside the
 * workspace mutation lock, a claimed but incomplete request can only belong to
 * an attempt that died before finishing: a live one would still hold the lock.
 */
export function interruptedPendingCreation(
  projectDir: string,
  id: string,
): { intent: string; space: string } | null {
  const request = readPendingRequest(projectDir, id);
  return request?.createdIntent && request.createdSpace
    ? { intent: request.createdIntent, space: request.createdSpace }
    : null;
}

/**
 * Claim `id` for the creation about to run. Call it inside the workspace
 * mutation lock, after every refusal and before the intent is minted, so two
 * creations never both complete one request.
 */
export function claimPendingRequest(projectDir: string, id: string): PendingRequest | null {
  const request = readPendingRequest(projectDir, id);
  if (!request) return null;
  const { createdIntent: _intent, createdSpace: _space, ...rest } = request;
  const claimed = { ...rest, claimedAt: new Date().toISOString() };
  writeRecord(projectDir, claimed);
  return claimed;
}

/** Record the intent a claimed request just minted; its setup is still running. */
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

/** Mark a minted request complete once its record is fully initialized. */
export function completePendingRequest(projectDir: string, id: string): void {
  const request = readRecord(projectDir, id);
  if (request?.createdIntent !== undefined) {
    writeRecord(projectDir, { ...request, completedAt: new Date().toISOString() });
  }
}

/** The refusal for an id that no longer authorizes a continuation. */
export function pendingRequestUnavailable(projectDir: string, id: string): string {
  const used = readRecord(projectDir, id);
  if (used?.createdIntent && used.completedAt !== undefined) {
    return `Pending request ${id} already created ${used.createdIntent}; run next to continue that work.`;
  }
  return `Pending request ${id} is no longer available; restate the request.`;
}

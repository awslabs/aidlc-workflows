import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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
  /** The record the claimed request created. */
  createdIntent?: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// An unanswered request is dropped after a week so abandoned asks do not pile up.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_MAX_BYTES = 4 * 1024 * 1024;

// One gitignored file per request id in this clone's session runtime directory.
// Every ask mints its own id, so concurrent sessions in one clone never share or
// invalidate each other's requests. Every path is reached through no symlink.
function pendingRequestRel(projectDir: string, id?: string): string {
  const dir = join(sessionsDir(projectDir), "pending-requests");
  return relative(projectDir, id === undefined ? dir : join(dir, `${id}.json`));
}

function readRecord(projectDir: string, id: string): PendingRequest | null {
  if (!PENDING_ID.test(id)) return null;
  try {
    const target = recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir, id));
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

function writeRecord(projectDir: string, request: PendingRequest): void {
  writeRecordFileNoFollow(projectDir, pendingRequestRel(projectDir, request.id), `${JSON.stringify(request)}\n`);
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

/** The unclaimed request behind `id`, or null when it is missing, used, or expired. */
export function readPendingRequest(projectDir: string, id: string): PendingRequest | null {
  const request = readRecord(projectDir, id);
  return request && request.claimedAt === undefined ? request : null;
}

/**
 * Claim `id` for the creation about to run. Call it inside the workspace
 * mutation lock, after every refusal and before the intent is minted, so two
 * creations can never both use one request. A crash after the claim leaves the
 * request used rather than replayable.
 */
export function claimPendingRequest(projectDir: string, id: string): PendingRequest | null {
  const request = readPendingRequest(projectDir, id);
  if (!request) return null;
  const claimed = { ...request, claimedAt: new Date().toISOString() };
  writeRecord(projectDir, claimed);
  return claimed;
}

/** Record which intent a claimed request created, so a retry can name it. */
export function recordPendingRequestCreated(projectDir: string, id: string, intent: string): void {
  const request = readRecord(projectDir, id);
  if (request?.claimedAt !== undefined) writeRecord(projectDir, { ...request, createdIntent: intent });
}

/** The refusal for an id that no longer authorizes a continuation. */
export function pendingRequestUnavailable(projectDir: string, id: string): string {
  const used = readRecord(projectDir, id);
  if (used?.createdIntent) {
    return `Pending request ${id} already created ${used.createdIntent}; run next to continue that work.`;
  }
  if (used?.claimedAt !== undefined) {
    return `Pending request ${id} was already used; run next to see where work stands, or restate the request.`;
  }
  return `Pending request ${id} is no longer available; restate the request.`;
}

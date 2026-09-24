import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir, writeFileAtomic } from "./aidlc-lib.ts";

interface PendingRequest {
  id: string;
  description: string;
  proposedScope: string;
  createdAt: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// An unanswered request is dropped after a week so abandoned asks do not pile up.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One gitignored file per request id in this clone's session runtime directory.
// Separate files keep concurrent sessions in one clone from invalidating each
// other's asks.
function pendingRequestDir(projectDir: string): string {
  return join(sessionsDir(projectDir), "pending-requests");
}

function pendingRequestPath(projectDir: string, id: string): string {
  return join(pendingRequestDir(projectDir), `${id}.json`);
}

function storedIds(projectDir: string): string[] {
  try {
    return readdirSync(pendingRequestDir(projectDir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => PENDING_ID.test(id));
  } catch {
    return [];
  }
}

function pruneExpired(projectDir: string, now: number): void {
  for (const id of storedIds(projectDir)) {
    const path = pendingRequestPath(projectDir, id);
    try {
      if (now - statSync(path).mtimeMs > PENDING_TTL_MS) rmSync(path, { force: true });
    } catch {
      // Already gone or unreadable: nothing to prune.
    }
  }
}

// A request that arrived with a live id keeps that id, and asking again for the
// same description and scope returns the stored id, so one request is addressed
// by one token until creation consumes it.
export function savePendingRequest(
  projectDir: string,
  description: string,
  proposedScope: string,
  reuseId?: string,
): PendingRequest {
  const now = Date.now();
  pruneExpired(projectDir, now);
  const live = reuseId !== undefined ? readPendingRequest(projectDir, reuseId) : null;
  if (!live) {
    for (const id of storedIds(projectDir)) {
      const stored = readPendingRequest(projectDir, id);
      if (stored?.description === description && stored.proposedScope === proposedScope) {
        return stored;
      }
    }
  }
  if (live?.description === description && live.proposedScope === proposedScope) return live;
  const request = {
    id: live ? live.id : randomBytes(4).toString("hex"),
    description,
    proposedScope,
    createdAt: new Date(now).toISOString(),
  };
  mkdirSync(pendingRequestDir(projectDir), { recursive: true });
  writeFileAtomic(pendingRequestPath(projectDir, request.id), `${JSON.stringify(request)}\n`);
  return request;
}

export function readPendingRequest(projectDir: string, id: string): PendingRequest | null {
  if (!PENDING_ID.test(id)) return null;
  try {
    const request = JSON.parse(readFileSync(pendingRequestPath(projectDir, id), "utf-8"));
    if (
      request?.id === id &&
      typeof request.description === "string" && request.description.trim() &&
      typeof request.proposedScope === "string" &&
      typeof request.createdAt === "string"
    ) return request;
  } catch {
    // A removed, consumed, or unreadable request cannot authorize a continuation.
  }
  return null;
}

export function clearPendingRequest(projectDir: string, id: string): void {
  if (readPendingRequest(projectDir, id)) rmSync(pendingRequestPath(projectDir, id), { force: true });
}

export function pendingRequestUnavailable(id: string): string {
  return `Pending request ${id} is no longer available; restate the request.`;
}

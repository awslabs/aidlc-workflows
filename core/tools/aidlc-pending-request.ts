import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir, writeFileAtomic } from "./aidlc-lib.ts";

interface PendingRequest {
  id: string;
  description: string;
  proposedScope: string;
  createdAt: string;
}

// One per-person, gitignored slot per project, beside the session selection map.
function pendingRequestPath(projectDir: string): string {
  return join(sessionsDir(projectDir), "pending-request.json");
}

export function savePendingRequest(
  projectDir: string,
  description: string,
  proposedScope: string,
): PendingRequest {
  const request = {
    id: randomBytes(4).toString("hex"),
    description,
    proposedScope,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(sessionsDir(projectDir), { recursive: true });
  writeFileAtomic(pendingRequestPath(projectDir), `${JSON.stringify(request)}\n`);
  return request;
}

export function readPendingRequest(projectDir: string, id: string): PendingRequest | null {
  if (!/^[0-9a-f]{8}$/.test(id)) return null;
  try {
    const request = JSON.parse(readFileSync(pendingRequestPath(projectDir), "utf-8"));
    if (
      request?.id === id &&
      typeof request.description === "string" && request.description.trim() &&
      typeof request.proposedScope === "string" &&
      typeof request.createdAt === "string"
    ) return request;
  } catch {
    // A removed, replaced, or unreadable slot cannot authorize a continuation.
  }
  return null;
}

export function clearPendingRequest(projectDir: string, id: string): void {
  if (readPendingRequest(projectDir, id)) rmSync(pendingRequestPath(projectDir), { force: true });
}

export function pendingRequestUnavailable(id: string): string {
  return `Pending request ${id} is no longer available; restate the request.`;
}

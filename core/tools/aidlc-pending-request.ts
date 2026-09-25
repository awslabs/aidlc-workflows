import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  readRegularFileNoFollowOrThrow,
  recordFileTargetOrThrow,
  removeRecordFileNoFollow,
  SPACE_NAME_REGEX,
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
  /** The creation's scope, label, and options, so an interrupted setup can be replayed exactly. */
  createdScope?: string;
  createdLabel?: string;
  createdOptions?: Array<[string, string]>;
  /** The record the claimed request minted, and its space. */
  createdIntent?: string;
  createdSpace?: string;
  /** Set once that record's initialization finished. */
  completedAt?: string;
}

const PENDING_ID = /^[0-9a-f]{8}$/;
// The record name createIntent mints: `<YYMMDD>-<slug>`, plus `-<n>` on a clash.
const MINTED_RECORD = /^[0-9]{6}-[a-z][a-z0-9-]*$/;
// The intent-create options a replayed creation carries besides scope and label.
export const CREATION_OPTION_FLAGS = [
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
      Date.now() - Date.parse(request.createdAt) <= PENDING_TTL_MS &&
      // A record names only a minted record in a valid space; anything else is
      // refused rather than trusted as a path.
      (request.createdIntent === undefined ||
        (typeof request.createdIntent === "string" && MINTED_RECORD.test(request.createdIntent))) &&
      (request.createdSpace === undefined ||
        (typeof request.createdSpace === "string" && SPACE_NAME_REGEX.test(request.createdSpace))) &&
      (request.createdIntent === undefined) === (request.createdSpace === undefined) &&
      (request.createdScope === undefined || typeof request.createdScope === "string") &&
      (request.createdLabel === undefined || typeof request.createdLabel === "string") &&
      (request.createdOptions === undefined ||
        (Array.isArray(request.createdOptions) &&
          request.createdOptions.every(
            (option: unknown) =>
              Array.isArray(option) && option.length === 2 &&
              (CREATION_OPTION_FLAGS as readonly string[]).includes(option[0]) &&
              typeof option[1] === "string",
          )))
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
 * Claim `id` for the creation about to run and journal the record it will
 * mint. Call it inside the workspace mutation lock, after every refusal and
 * before anything is exposed, so two creations never both complete one request
 * and an interrupted one can be undone by name.
 */
export function claimPendingRequest(
  projectDir: string,
  id: string,
  creation: {
    scope: string;
    label?: string;
    options: Array<[string, string]>;
    intent: string;
    space: string;
  },
): PendingRequest | null {
  const request = readPendingRequest(projectDir, id);
  if (!request) return null;
  const {
    createdIntent: _intent,
    createdSpace: _space,
    createdScope: _scope,
    createdLabel: _label,
    createdOptions: _options,
    ...rest
  } = request;
  const claimed = {
    ...rest,
    claimedAt: new Date().toISOString(),
    createdScope: creation.scope,
    ...(creation.label !== undefined ? { createdLabel: creation.label } : {}),
    createdOptions: creation.options,
    createdIntent: creation.intent,
    createdSpace: creation.space,
  };
  writeRecord(projectDir, claimed);
  return claimed;
}

/**
 * The pending request that minted `intent` in `space` and has not completed:
 * the setup that was interrupted, with what it takes to finish it.
 */
export function interruptedCreationOf(
  projectDir: string,
  intent: string,
  space: string,
): { id: string; scope: string; label?: string; options: Array<[string, string]> } | null {
  let names: string[];
  try {
    names = readdirSync(recordFileTargetOrThrow(projectDir, pendingRequestRel(projectDir)));
  } catch {
    return null;
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    const request = readPendingRequest(projectDir, id);
    if (request?.createdIntent === intent && request.createdSpace === space && request.createdScope) {
      return {
        id,
        scope: request.createdScope,
        ...(request.createdLabel ? { label: request.createdLabel } : {}),
        options: request.createdOptions ?? [],
      };
    }
  }
  return null;
}

/** Correct the journaled record name if the mint chose another; setup is still running. */
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

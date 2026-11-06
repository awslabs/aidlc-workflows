// Which checkout holds a team Unit's work (#3610): the claims this checkout has
// seen (the claim registry cache and the local claim refs), the Units a checkout
// walks without a claim, and the one reading of the Units held here that the
// open Unit steps, the Unit writes, the walk and the claim list share. Moved out
// of aidlc-lib.ts with the code it needs, which never imports aidlc-lib.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { activeSpace, workspaceRoot } from "./aidlc-locks.ts";
import { escapeRegex } from "./aidlc-markdown.ts";
import {
  activeIntentUuid,
  applicableTeamUnitScopeStamp,
  auditBlockField,
  type AuditShardEvent,
  idSuffix,
  isTeamUnitOwnership,
  knownAuditShardName,
  readAuditShardEvents,
  readStateFile,
} from "./aidlc-record-core.ts";
import { completedUnits } from "./aidlc-unit-landing.ts";

export const CLAIM_REGISTRY_CACHE_FILE = ".aidlc-claim-registry.json";

export interface CachedUnitClaim {
  status: "claimed" | "released";
  owner: string;
  generation: number;
  nonce: string;
  ref: string;
  oid: string;
  observed_at?: string;
}

export interface UnitClaimRegistryCache {
  version: 1;
  space: string;
  intent_uuid: string;
  claims: Record<string, CachedUnitClaim>;
  warning?: string;
}

export function claimRegistryCachePath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLAIM_REGISTRY_CACHE_FILE);
}

export function readUnitClaimRegistryCache(
  projectDir: string,
): UnitClaimRegistryCache | null {
  try {
    const parsed = JSON.parse(
      readFileSync(claimRegistryCachePath(projectDir), "utf-8"),
    ) as Partial<UnitClaimRegistryCache>;
    if (
      parsed.version !== 1 ||
      typeof parsed.space !== "string" ||
      typeof parsed.intent_uuid !== "string" ||
      parsed.claims === null ||
      typeof parsed.claims !== "object" ||
      Array.isArray(parsed.claims)
    ) {
      return null;
    }
    const claims: Record<string, CachedUnitClaim> = {};
    for (const [unit, value] of Object.entries(parsed.claims)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const claim = value as Partial<CachedUnitClaim>;
      if (
        (claim.status !== "claimed" && claim.status !== "released") ||
        typeof claim.owner !== "string" ||
        !Number.isInteger(claim.generation) ||
        (claim.generation ?? 0) < 1 ||
        typeof claim.nonce !== "string" ||
        typeof claim.ref !== "string" ||
        typeof claim.oid !== "string" ||
        (
          claim.observed_at !== undefined &&
          typeof claim.observed_at !== "string"
        )
      ) {
        return null;
      }
      claims[unit] = claim as CachedUnitClaim;
    }
    return {
      version: 1,
      space: parsed.space,
      intent_uuid: parsed.intent_uuid,
      claims,
      ...(typeof parsed.warning === "string" && parsed.warning
        ? { warning: parsed.warning }
        : {}),
    };
  } catch {
    return null;
  }
}

export function claimRegistryGit(
  projectDir: string,
  args: string[],
  options: { localOnly?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf-8",
    env: options.localOnly
      ? { ...process.env, GIT_NO_LAZY_FETCH: "1" }
      : process.env,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// The one check that team Unit fan-out is active: a claim of the active intent
// still says `claimed`, a landed Unit's included (land never releases it). The
// guard below and `next` in an unscoped team checkout (aidlc-orchestrate.ts,
// routeNext) both read it, so `next` never hands out Unit work the guard refuses.
export function cachedClaimFanoutActive(projectDir: string): boolean {
  return claimedUnitsSeenHere(projectDir, true).size > 0;
}

// The Units a claim of the active intent says `claimed` for, as this checkout
// has seen the claims (its registry cache and its local claim refs). With
// `first`, the read stops at the first one.
function claimedUnitsSeenHere(projectDir: string, first = false): Set<string> {
  const claimed = new Set<string>();
  const cache = readUnitClaimRegistryCache(projectDir);
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) return claimed;
  if (cache && cache.space === space && cache.intent_uuid === intentUuid) {
    for (const [unit, claim] of Object.entries(cache.claims)) {
      if (claim.status !== "claimed") continue;
      claimed.add(unit);
      if (first) return claimed;
    }
  }
  const id8 = idSuffix(intentUuid);
  const refs = claimRegistryGit(projectDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads/claim/",
    "refs/remotes/",
  ], { localOnly: true });
  if (!refs.ok) return claimed;
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (
      !oid ||
      !ref ||
      (
        !ref.startsWith(`refs/heads/claim/${id8}/`) &&
        !new RegExp(`^refs/remotes/[^/]+/claim/${escapeRegex(id8)}/`).test(ref)
      )
    ) {
      continue;
    }
    const shown = claimRegistryGit(
      projectDir,
      ["show", `${oid}:.aidlc-unit-claim.json`, "--"],
      { localOnly: true },
    );
    if (!shown.ok) continue;
    try {
      const payload = JSON.parse(shown.stdout) as Record<string, unknown>;
      if (
        payload.intent_uuid === intentUuid &&
        payload.status === "claimed"
      ) {
        claimed.add(typeof payload.unit === "string" ? payload.unit : ref.slice(ref.lastIndexOf("/") + 1));
        if (first) return claimed;
      }
    } catch {
      // Malformed local claim refs are handled by notice composition.
    }
  }
  return claimed;
}

// The Units a team checkout walks without a claim (#3610): the lead's own Unit,
// begun in their checkout before the teams took the others, stays theirs. Each
// Unit whose latest work row names no claim attempt (a claimed checkout's
// rows carry claimAttemptFields), that no claim seen here holds and whose Unit
// Progress row is not complete, with the audit shard that row is in, which
// names the checkout that wrote it.
export function unitsWalkedWithoutClaim(projectDir: string): Map<string, string> {
  const walked = new Map<string, string>();
  let state: string;
  try {
    state = readStateFile(projectDir);
  } catch {
    return walked;
  }
  if (!isTeamUnitOwnership(state)) return walked;
  const latest = new Map<string, AuditShardEvent>();
  for (const row of readAuditShardEvents(projectDir)) {
    if (!UNIT_WORK_ROW_EVENTS.has(row.event)) continue;
    const unit = auditBlockField(row.block, "Unit");
    if (!unit) continue;
    const prior = latest.get(unit);
    if (
      !prior ||
      prior.timestamp < row.timestamp ||
      (prior.timestamp === row.timestamp &&
        (prior.shardIndex < row.shardIndex || (prior.shardIndex === row.shardIndex && prior.pos < row.pos)))
    ) {
      latest.set(unit, row);
    }
  }
  if (latest.size === 0) return walked;
  const complete = completedUnits(state);
  const claimed = claimedUnitsSeenHere(projectDir);
  for (const [unit, row] of latest) {
    if (auditBlockField(row.block, "Attempt Generation") !== null) continue;
    if (complete.has(unit) || claimed.has(unit)) continue;
    walked.set(unit, basename(row.shard));
  }
  return walked;
}

// The rows that say a checkout worked a Unit. A skip (UNIT_SKIPPED) records
// that the Unit owes a stage nothing, not that anyone works it: a stage the
// lead skipped for every Unit leaves them all the teams' to take.
const UNIT_WORK_ROW_EVENTS: ReadonlySet<string> = new Set([
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
]);

// The Units whose work this checkout holds (#3610), one reading for the open
// Unit steps, the Unit writes, the walk and the claim list. Null is every Unit:
// solo work, and a team checkout that walks no Unit of its own (before the plan
// is shared it walks them all; once a team holds a claim no Unit's work runs
// there). A claimed checkout holds its claim's Unit; a checkout without one holds
// the Units it walks without a claim in its own shard, shared plan or not.
export function unitsHeldHere(projectDir: string): ReadonlySet<string> | null {
  let state: string;
  try {
    state = readStateFile(projectDir);
  } catch {
    return null;
  }
  if (!isTeamUnitOwnership(state)) return null;
  const stamp = applicableTeamUnitScopeStamp(projectDir, state);
  if (stamp) return new Set([stamp.unit]);
  const own = knownAuditShardName(projectDir);
  if (own === null) return null;
  const held = new Set(
    [...unitsWalkedWithoutClaim(projectDir)].filter(([, shard]) => shard === own).map(([unit]) => unit),
  );
  return held.size > 0 ? held : null;
}

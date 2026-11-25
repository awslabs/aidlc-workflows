// Which checkout holds a team Unit's work (#3610): the claims this checkout has
// seen (the claim registry cache and the local claim refs), the Units a checkout
// walks without a claim, and the one reading of the Units held here that the
// open Unit steps, the Unit writes, the walk and the claim list share; and where
// a claim commit holds its claim file, which every claim read and write asks.
// Moved out of aidlc-lib.ts with the code it needs, which never imports
// aidlc-lib.ts.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { projectInRepo } from "./aidlc-git.ts";
import { activeSpace, writeFileAtomic } from "./aidlc-locks.ts";
import { workspaceEngineFile } from "./aidlc-runtime-paths.ts";
import {
  activeIntentUuid,
  applicableTeamUnitScopeStamp,
  auditBlockField,
  type AuditShardEvent,
  getField,
  idSuffix,
  isTeamUnitOwnership,
  knownAuditShardName,
  readAuditShardEvents,
  readStateFile,
  spacesRoot,
} from "./aidlc-record-core.ts";
import { completedUnits } from "./aidlc-unit-landing.ts";

// Under aidlc/.aidlc-engine/ (workspaceEngineFile).
export const CLAIM_REGISTRY_CACHE_FILE = "units/claim-registry.json";

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

// The claim file a claim commit holds, and the folder a Unit's results ride in
// beside it on the claim branch: the one owner of both names and their places.
export const CLAIM_FILE = ".aidlc-unit-claim.json";
export const UNIT_RESULT_DIR = ".aidlc-unit-result";

// Where a Unit's claim lives on a remote, and this clone's copies of it: the one
// owner of every claim ref name. Main's flow (claim, publish, pin, gate, land)
// keeps each claim on a branch, claim/<id8>/<unit>, whose commits carry the
// candidate its publish pushes and its adopt checks out. The build-out's
// record of a Unit (its take, result and proposals, and a teammate's take of
// solo work) is a ref of AI-DLC's own in the Unit's own repository, which a
// host does not list as a branch, offer a pull request for, run CI or branch
// rules on, or clean up. Which one a work uses is its recorded flow
// (claimsOnBranches, aidlc-unit-teams.ts). A branch's copy is where git's own
// fetch keeps it; a record's is read by its repository's address into
// refs/aidlc/home/<id8>/<key>/claims/<unit> (homeCopyName), one folder per
// repository read.
const CLAIM_BRANCHES = "refs/heads/claim/";
const CLAIM_RECORDS = "refs/aidlc/claims/";

export function claimBranchRef(id8: string, unit: string): string {
  return `${CLAIM_BRANCHES}${id8}/${unit}`;
}

export function claimRecordRef(id8: string, unit: string): string {
  return `${CLAIM_RECORDS}${id8}/${unit}`;
}

// A Unit's record as a branch, where its repository takes no ref of AI-DLC's
// but a branch: the same commits as the ref would hold.
export const CLAIM_RECORD_BRANCHES = "refs/heads/aidlc/claims/";

// The plan as a branch people can open, or where its repository takes no ref
// of AI-DLC's: named by the work's id and its label, the same commits as the
// plan's ref would hold.
export const PLAN_BRANCHES = "refs/heads/aidlc/plans/";

// The plan a lead shares with the teams, in one code repository.
export function planRecordRef(id8: string): string {
  return `refs/aidlc/plans/${id8}`;
}

// This workspace's copies of what a look read by an address: one folder per
// repository read (`key`, repoCopyKey in aidlc-unit-teams.ts), so a fetch with
// prune into one never touches another's. `tail` is "plan", or "claims/<unit>"
// ("claims/" for the folder). Never pushed, never in a code clone.
export function homeCopyName(id8: string, key: string, tail: string): string {
  return `refs/aidlc/home/${id8}/${key}/${tail}`;
}

export type HomeCopy = { id8: string; key: string; kind: "plan" } | { id8: string; key: string; kind: "record"; unit: string };

// The copy of what a look read from a branch, beside the one every reader
// reads (homeCopyName), so the next look's prune of one form never takes the
// other's and the look can tell which form the repository holds. A record's
// is in its work's folder; the plan's in a folder named as its branch is
// (<id8>-<label>), since a fetch by a pattern can fill no other name, and
// never at <id8>/<key>/on-branch/plan, which every look's prune would take.
export function homeCopyOnBranchName(id8: string, key: string, tail: string): string {
  return `refs/aidlc/home/${id8}/${key}/on-branch/${tail}`;
}

// The one reading of an on-branch copy's name; a plan's carries the label of
// the branch it was read from.
export function homeCopyOnBranchOf(ref: string): (HomeCopy & { label?: string }) | null {
  const plan = /^refs\/aidlc\/home\/([0-9a-f]{8})-([^/]+)\/([0-9a-f]{12})\/on-branch\/plan$/.exec(ref);
  if (plan !== null) return { id8: plan[1], key: plan[3], kind: "plan", label: plan[2] };
  const at = /^refs\/aidlc\/home\/([^/]+)\/([0-9a-f]{12})\/on-branch\/claims\/([^/]+)$/.exec(ref);
  return at === null ? null : { id8: at[1], key: at[2], kind: "record", unit: at[3] };
}

// The one reading of a copy's name; the key is exactly twelve lower-case hex,
// so no other ref under refs/aidlc/home/ reads as one.
export function homeCopyOf(ref: string): HomeCopy | null {
  const at = /^refs\/aidlc\/home\/([^/]+)\/([0-9a-f]{12})\/(?:(plan)|claims\/([^/]+))$/.exec(ref);
  if (at === null) return null;
  return at[3] !== undefined ? { id8: at[1], key: at[2], kind: "plan" } : { id8: at[1], key: at[2], kind: "record", unit: at[4] };
}

// A work's claims on a remote (every work's without `id8`), as a refspec's
// source folder (`<it>*`).
export function claimsOnRemote(onBranches: boolean, id8?: string): string {
  return `${onBranches ? CLAIM_BRANCHES : CLAIM_RECORDS}${id8 === undefined ? "" : `${id8}/`}`;
}

// The folder this clone keeps its copies of a work's claim branches in, as
// git's own fetch of the remote named `target` keeps them.
export function claimCopies(target: string, id8: string): string {
  return `refs/remotes/${target}/claim/${id8}/`;
}

// This clone's copy of a claim branch on the remote named `remote` (of a folder
// of them, given its folder).
export function claimCopyOf(remote: string, ref: string): string {
  return `refs/remotes/${remote}/claim/${ref.slice(CLAIM_BRANCHES.length)}`;
}

// A build-out record's own file: the builder's side of its Unit.
export const RECORD_FILE = "unit.json";

// The folders every claim and copy of one in this clone sits in, for one
// for-each-ref.
export const CLAIM_REF_FOLDERS = [CLAIM_BRANCHES, CLAIM_RECORDS, "refs/remotes/", "refs/aidlc/home/"];

export interface ClaimHere {
  id8: string;
  unit: string;
  onBranches: boolean;
  // This repository's own claim, a claim branch's copy through a remote's
  // name, or a record's copy read by its repository's address.
  kind: "own" | "remote" | "address";
  remote?: string;
}

// A ref in this clone that is a claim, or a copy of one: a record's copy is
// read by homeCopyOf, the one reading of those names.
export function claimHere(ref: string): ClaimHere | null {
  let at = /^refs\/heads\/claim\/([^/]+)\/([^/]+)$/.exec(ref);
  if (at) return { id8: at[1], unit: at[2], onBranches: true, kind: "own" };
  at = /^refs\/aidlc\/claims\/([^/]+)\/([^/]+)$/.exec(ref);
  if (at) return { id8: at[1], unit: at[2], onBranches: false, kind: "own" };
  at = /^refs\/remotes\/([^/]+)\/claim\/([^/]+)\/([^/]+)$/.exec(ref);
  if (at) return { id8: at[2], unit: at[3], onBranches: true, kind: "remote", remote: at[1] };
  const copy = homeCopyOf(ref);
  return copy?.kind === "record" ? { id8: copy.id8, unit: copy.unit, onBranches: false, kind: "address" } : null;
}

// The first word of the plan's own branch (aidlc-unit's planBranchNames: the
// share by pull request names it after the work, or this alone).
export const PLAN_BRANCH = "aidlc-plan";

// The folders a claim commit's tree may hold the claim file and the result
// folder in, from the repository's top, in the order they are read: the
// project's aidlc/ folder, where a newer release writes both, then, for a
// project at the repository's top, the tree's top, where this release and 2.11
// write the claim file (and a newer release keeps a result beside a claim
// that started there). In a folder of a bigger repository only the aidlc/
// folder: no earlier release could claim there. `prefix` is the project's
// place in its repository (projectInRepo), the caller's to say.
function claimTreeRoots(prefix: string): string[] {
  return prefix ? [`${prefix}aidlc/`] : ["aidlc/", ""];
}

// Where a claim commit's tree may hold its claim file, in reading order. The
// last is where a claim that starts here puts it.
export function claimPlaces(prefix: string): string[] {
  return claimTreeRoots(prefix).map((root) => `${root}${CLAIM_FILE}`);
}

// The project's place in its repository, for a claim read from this checkout.
export function claimPrefixOf(projectDir: string): string {
  return projectInRepo(projectDir)?.prefix ?? "";
}

// A claim's file or a Unit result, at any of their places: a landing leaves
// each off main. `path` is from the repository's top, as git diff names it.
export function isClaimTreeFile(prefix: string, path: string): boolean {
  return claimPlaces(prefix).includes(path) || unitResultRootOf(prefix, path) !== null;
}

// The result folder `path` is in ("aidlc/.aidlc-unit-result/"), or null.
export function unitResultRootOf(prefix: string, path: string): string | null {
  return claimTreeRoots(prefix)
    .map((root) => `${root}${UNIT_RESULT_DIR}/`)
    .find((root) => path.startsWith(root)) ?? null;
}

// The claim file's blob in a commit's tree and where it is, read locally (a
// partial clone's tree lists a blob it has not fetched): the first place
// present wins.
export function claimBlobAt(
  projectDir: string,
  oid: string,
  prefix: string,
): { place: string; blob: string } | null {
  const places = claimPlaces(prefix);
  const listed = claimRegistryGit(
    projectDir,
    ["ls-tree", "-z", "--full-tree", oid, "--", ...places],
    { localOnly: true },
  );
  if (!listed.ok) return null;
  const blobs = new Map<string, string>();
  for (const entry of listed.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    const [, type, blob] = entry.slice(0, tab).split(" ");
    if (tab > 0 && type === "blob" && blob) blobs.set(entry.slice(tab + 1), blob);
  }
  const place = places.find((candidate) => blobs.has(candidate));
  return place ? { place, blob: blobs.get(place) as string } : null;
}

// The claim file's text in a commit and where it is, in one local-only git
// call for every place: the first place present wins. Null when the commit
// holds none, or its blob is not here (a partial clone's git stops there).
export function readClaimAt(
  projectDir: string,
  oid: string,
  prefix: string,
): { place: string; text: string } | null {
  const places = claimPlaces(prefix);
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: projectDir,
    input: places.map((place) => `${oid}:${place}\n`).join(""),
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  if (result.status !== 0 || !result.stdout) return null;
  const out = result.stdout;
  let at = 0;
  for (const place of places) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) return null;
    // "<oid> <type> <size>", then the content and a line end; a place the
    // commit does not hold prints "<name> missing".
    const header = /^[0-9a-f]+ (\S+) (\d+)$/.exec(out.subarray(at, end).toString("utf-8"));
    at = end + 1;
    if (!header) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") return { place, text: out.subarray(at, at + size).toString("utf-8") };
    at += size + 1;
  }
  return null;
}

export function claimRegistryCachePath(projectDir: string): string {
  return workspaceEngineFile(projectDir, CLAIM_REGISTRY_CACHE_FILE);
}

// The addresses a person said a plan is shared in, kept on this computer in
// the last-seen list until a build's Home Location holds one: no sign-in in
// them. The list's writer (writeUnitClaimRegistryCache) keeps them.
export interface SaidPlan {
  address: string;
  at: string;
}

export function saidPlans(projectDir: string): SaidPlan[] {
  try {
    const parsed = JSON.parse(readFileSync(claimRegistryCachePath(projectDir), "utf-8")) as { said_plans?: unknown };
    return Array.isArray(parsed.said_plans)
      ? parsed.said_plans.filter((entry): entry is SaidPlan =>
        typeof (entry as SaidPlan)?.address === "string" && typeof (entry as SaidPlan)?.at === "string")
      : [];
  } catch {
    return [];
  }
}

// The list with `said` in place of what it held; a file with no work's claims
// yet is written as an empty one, which no work's read takes as its own.
export function writeSaidPlans(projectDir: string, said: readonly SaidPlan[]): void {
  let held: Record<string, unknown> = { version: 1, space: "", intent_uuid: "", claims: {} };
  try {
    held = JSON.parse(readFileSync(claimRegistryCachePath(projectDir), "utf-8")) as Record<string, unknown>;
  } catch {
    // None yet.
  }
  const { said_plans: _, ...rest } = held;
  writeFileAtomic(claimRegistryCachePath(projectDir), `${JSON.stringify(said.length > 0 ? { ...rest, said_plans: said } : rest, null, 2)}\n`);
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

// With several remotes and none called origin (a lead who added a team's fork
// beside their own remote): the one at the lead's project the work in hand
// records (its Home Location). Null when it does not tell. The one rule for
// this checkout's own remote then: the claim registry's reads here and
// repositoryRemote (aidlc-unit) both take it. aidlc-workspace-repos.ts imports
// aidlc-lib.ts, which loads this module, so gitAddressKey is reached lazily.
export function ownRemoteAmong(projectDir: string, remotes: readonly string[]): string | null {
  try {
    const location = getField(readStateFile(projectDir), "Home Location")?.trim();
    if (!location) return null;
    const { gitAddressKey } = require("./aidlc-workspace-repos.ts") as typeof import("./aidlc-workspace-repos.ts");
    const key = gitAddressKey(location);
    const at = remotes.filter((remote) => {
      const url = claimRegistryGit(projectDir, ["remote", "get-url", remote]);
      return url.ok && url.stdout.trim() !== "" && gitAddressKey(url.stdout.trim()) === key;
    });
    return at.length === 1 ? at[0] : null;
  } catch {
    return null;
  }
}

// A teammate's clone of a lead's project whose plan has not reached it: this
// checkout holds no AI-DLC record yet, and what it fetched says the lead's
// plan is on its way: a claim branch of main's flow git tracks under a remote,
// the plan's own branch (shared by pull request) with a record on it, or the
// remote's default branch with a team's record on it (a state that records
// Home Location; a person's own solo record is no lead's). Its chats write none
// of AI-DLC's parts of the root files here, so the lead's plan pulls in. Read
// from this clone alone, trees first, a state only when this clone holds it.
export function leadsPlanNotHere(projectDir: string): boolean {
  let spaces: string[] = [];
  try {
    spaces = readdirSync(spacesRoot(projectDir));
  } catch {
    // No spaces yet.
  }
  if (spaces.some((name) => existsSync(join(spacesRoot(projectDir), name, "intents", "intents.json")))) return false;
  const local = (args: string[]) => claimRegistryGit(projectDir, args, { localOnly: true });
  const refs = local(["for-each-ref", "--format=%(refname)", "refs/remotes/"]);
  if (!refs.ok) return false;
  const fetched = refs.stdout.split(/\r?\n/).filter(Boolean);
  if (fetched.some((ref) => /^refs\/remotes\/[^/]+\/claim\/[^/]+\/./.test(ref))) return true;
  const files = (ref: string): string[] => {
    const listed = local(["ls-tree", "-r", "--name-only", ref, "--", "aidlc/spaces/"]);
    return listed.ok ? listed.stdout.split(/\r?\n/).filter(Boolean) : [];
  };
  const planBranch = (ref: string): boolean => {
    const name = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1] ?? "";
    return name === PLAN_BRANCH || name.startsWith(`${PLAN_BRANCH}-`);
  };
  if (fetched.filter(planBranch).some((ref) => files(ref).some((path) => /^aidlc\/spaces\/[^/]+\/intents\/intents\.json$/.test(path)))) return true;
  return fetched.filter((ref) => ref.endsWith("/HEAD")).some((ref) =>
    files(ref).filter((path) => /^aidlc\/spaces\/[^/]+\/intents\/[^/]+\/aidlc-state\.md$/.test(path)).some((path) => {
      const shown = local(["cat-file", "blob", `${ref}:${path}`]);
      return shown.ok && (getField(shown.stdout, "Home Location")?.trim() ?? "") !== "";
    }));
}

// The one check that team Unit fan-out is active: a claim of the active intent
// still says `claimed`, a landed Unit's included (land never releases it). The
// guard below and `next` in an unscoped team checkout (aidlc-orchestrate.ts,
// routeNext) both read it, so `next` never hands out Unit work the guard refuses.
// At the home of teams that build their Units as work of their own, a claim is
// held for a team elsewhere and never keeps the home from the Units no team
// holds.
export function cachedClaimFanoutActive(projectDir: string, stateContent?: string): boolean {
  const { homeLocation } = require("./aidlc-unit-teams.ts") as typeof import("./aidlc-unit-teams.ts");
  let state = stateContent ?? null;
  if (state === null) {
    try {
      state = readStateFile(projectDir);
    } catch {
      state = null;
    }
  }
  if (homeLocation(state) !== null) return false;
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
  // The work's own kind of claim (its recorded flow), as this clone keeps it and
  // through its remotes' copies. Asked only when a claim ref of the intent is here.
  const { claimsOnBranches } = require("./aidlc-unit-teams.ts") as typeof import("./aidlc-unit-teams.ts");
  let onBranches = false;
  try {
    onBranches = claimsOnBranches(readStateFile(projectDir));
  } catch {
    // No state here: the work's claims are the build-out's.
  }
  let prefix: string | undefined;
  const refs = claimRegistryGit(projectDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    ...CLAIM_REF_FOLDERS,
  ], { localOnly: true });
  if (!refs.ok) return claimed;
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    const here = !oid || !ref ? null : claimHere(ref);
    if (here === null || here.id8 !== id8 || here.onBranches !== onBranches) continue;
    prefix ??= claimPrefixOf(projectDir);
    // A claim commit's claim file, or a build-out record's unit.json, read for
    // its status alone (recordView in aidlc-unit.ts reads a record whole).
    const shown = here.kind === "address"
      ? ((record) => (record.ok ? { text: record.stdout } : null))(claimRegistryGit(projectDir, ["show", `${oid}:${RECORD_FILE}`], { localOnly: true }))
      : readClaimAt(projectDir, oid, prefix);
    if (!shown) continue;
    try {
      const payload = JSON.parse(shown.text) as Record<string, unknown>;
      const unit = ref.slice(ref.lastIndexOf("/") + 1);
      // A record speaks only for the Unit its ref names.
      if (
        payload.intent_uuid === intentUuid &&
        payload.status === "claimed" &&
        (here.kind !== "address" || payload.unit === unit)
      ) {
        claimed.add(typeof payload.unit === "string" ? payload.unit : unit);
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

// aidlc-swarm-source.ts - which files are the person's source while the Units
// are built side by side: the one rule prepare's approval and committed checks,
// each landing's look at the main checkout and the stage's completion read.
//
// AI-DLC's own files are not (an update the person took), and neither are the
// files Git ignores and does not track in the checkout that holds them (a .env,
// a test run's or a dev server's log), nor what such an ignored link leads to:
// no commit holds them and no Unit's checkout gets them.
// The rule applies when listings are compared, never to the walk, so no
// fingerprint, receipt or recorded listing changes. A build in the project
// itself keeps its own compare: there an ignored file can be source.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import {
  type WorkspaceSourceListing,
  type WorkspaceSourceState,
  currentSwarmSourceMergeChain,
  currentSwarmSourceOpeningFingerprint,
  isLinkTargetListingKey,
  readBaselineSourceSnapshot,
  recordedSourceListingForCompare,
  recordedSourceListingUnderCurrentBoundary,
  repoDir,
  sourceChangedOutsideAidlc,
  sourceListingChangedKeys,
  sourcePathIsRegistered,
  splitSourcePathKey,
} from "./aidlc-lib.ts";

// Deeper than this, a submodule's paths are asked of nobody and stay source.
const SUBMODULE_DEPTH = 16;

function checkIgnore(checkout: string, paths: readonly string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  const checked = spawnSync("git", ["-C", checkout, "check-ignore", "-z", "--stdin"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
  return checked.status === 0 || checked.status === 1
    ? new Set(checked.stdout.split("\0").filter(Boolean))
    : null;
}

function initializedSubmodules(checkout: string): string[] {
  const listed = spawnSync("git", ["-C", checkout, "ls-files", "-z", "--stage"], {
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
    timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\0")
    .filter((record) => record.startsWith("160000 "))
    .map((record) => record.slice(record.indexOf("\t") + 1))
    .filter((path) => existsSync(join(checkout, path, ".git")));
}

// The paths (relative to `checkout`) Git ignores and does not track there, as
// Git reads the person's rules: check-ignore without --no-index never reports a
// path the checkout's own index tracks. A path inside a submodule makes Git
// refuse the whole question, so each submodule is asked its own paths. When Git
// cannot answer, nothing is ignored.
function gitIgnoredPaths(checkout: string, paths: readonly string[], depth = 0): Set<string> {
  const answered = checkIgnore(checkout, paths);
  if (answered !== null) return answered;
  const ignored = new Set<string>();
  const submodules = depth < SUBMODULE_DEPTH ? initializedSubmodules(checkout) : [];
  if (submodules.length === 0) return ignored;
  const own: string[] = [];
  const inside = new Map<string, string[]>();
  for (const path of paths) {
    const submodule = submodules.find((sub) => path.startsWith(`${sub}/`));
    if (submodule === undefined) own.push(path);
    else inside.set(submodule, [...(inside.get(submodule) ?? []), path.slice(submodule.length + 1)]);
  }
  for (const path of checkIgnore(checkout, own) ?? []) ignored.add(path);
  for (const [submodule, nested] of inside) {
    for (const path of gitIgnoredPaths(join(checkout, submodule), nested, depth + 1)) ignored.add(`${submodule}/${path}`);
  }
  return ignored;
}

// The paths among `paths` (relative to `checkout`) that a commit reachable from
// HEAD touched: a file the person tracked, its deletion since committed, which
// the index no longer knows. Null when Git cannot answer.
function trackedInHistory(checkout: string, paths: readonly string[]): Set<string> | null {
  const touched = new Set<string>();
  for (let at = 0; at < paths.length; at += 256) {
    const logged = spawnSync("git", [
      "-C", checkout, "log", "--no-renames", "--format=", "--name-only", "-z", "HEAD", "--",
      ...paths.slice(at, at + 256).map((path) => `:(literal)${path}`),
    ], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS });
    if (logged.status !== 0) return null;
    for (const path of logged.stdout.split("\0")) if (path) touched.add(path.replace(/^\n+/, ""));
  }
  return touched;
}

/**
 * One checkout's live listing without what is not the person's source: the
 * paths Git ignores and does not track there, and what an ignored link leads to
 * outside the project or to nothing (its `@target` keys). A path registered as
 * source in .aidlc-source-paths.json stays, as it does for a Unit's claims.
 * Commit listings are never passed here: they hold only what was tracked.
 */
export function withoutGitIgnored(
  repoDir: string, carriesWorkspaceShell: boolean,
): (listing: ReadonlyMap<string, string>) => Map<string, string> {
  const ignored = new Map<string, boolean>();
  const pathOf = (key: string): string => key.slice(key.indexOf("\0") + 1);
  return (listing) => {
    // What a link leads to is no path of the checkout's: it is never asked of
    // Git, and goes only with its own ignored link.
    const own = [...listing.keys()].filter((key) => !isLinkTargetListingKey(listing, key));
    const unknown = [...new Set(own.map(pathOf))].filter((path) => !ignored.has(path));
    const hits = gitIgnoredPaths(repoDir, unknown);
    for (const path of unknown) {
      ignored.set(path, hits.has(path) && !sourcePathIsRegistered(repoDir, carriesWorkspaceShell, path));
    }
    const ignoredLinks = new Map([...listing].filter(([key, entry]) =>
      entry.startsWith("120000 ") && ignored.get(pathOf(key)) === true));
    return new Map([...listing].filter(([key]) => isLinkTargetListingKey(listing, key)
      ? !isLinkTargetListingKey(ignoredLinks, key)
      : ignored.get(pathOf(key)) !== true));
  };
}

/**
 * The person's source that changed between two listings of the main checkout,
 * rendered `repo/path` and sorted: what withoutGitIgnored leaves out is dropped
 * from both, each key read in its own repo's checkout, and the rest is compared
 * as sourceChangedOutsideAidlc compares it.
 */
export function swarmSourceChanged(
  projectDir: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  // Only the keys that changed are asked of Git, with every link, so an ignored
  // link whose own entry did not change still takes its changed targets.
  const asked = new Set(sourceListingChangedKeys(before, after));
  if (asked.size === 0) return [];
  for (const [key, entry] of [...before, ...after]) if (entry.startsWith("120000 ")) asked.add(key);
  const byRepo = new Map<string, Map<string, string>>();
  for (const key of asked) {
    const parsed = splitSourcePathKey(key);
    if (parsed === null) continue;
    const listing = byRepo.get(parsed.repo) ?? new Map<string, string>();
    listing.set(`\0${parsed.path}`, after.get(key) ?? before.get(key) ?? "");
    byRepo.set(parsed.repo, listing);
  }
  const dropped = new Set<string>();
  for (const [repo, listing] of byRepo) {
    const checkout = repo === "" ? projectDir : repoDir(projectDir, repo);
    const kept = withoutGitIgnored(checkout, repo === "")(listing);
    const left = [...listing.keys()].filter((key) => !kept.has(key));
    // A file gone now is asked of Git's history: one the person tracked stays
    // their source, its deletion a change.
    const gone = new Set(left.filter((key) => !after.has(`${repo}${key}`)).map((key) => key.slice(1)));
    const tracked = gone.size === 0 ? new Set<string>() : trackedInHistory(checkout, [...gone]);
    for (const key of left) {
      if (gone.has(key.slice(1)) && (tracked === null || tracked.has(key.slice(1)))) continue;
      dropped.add(`${repo}${key}`);
    }
  }
  const theirs = (listing: ReadonlyMap<string, string>) => new Map([...listing].filter(([key]) => !dropped.has(key)));
  return sourceChangedOutsideAidlc(projectDir, theirs(before), theirs(after));
}

// The same since a kept listing (a landing's or the stage's `Source Listing`).
// Null when no listing was kept or it does not read back exactly: the caller
// then compares fingerprints.
export function swarmSourceChangedSince(
  projectDir: string,
  stageSlug: string,
  listing: string | undefined,
  current: WorkspaceSourceState,
  intent?: string,
  space?: string,
): string[] | null {
  const recorded = listing === undefined ? null : readBaselineSourceSnapshot(projectDir, stageSlug, listing, intent, space);
  if (recorded === null) return null;
  const before: WorkspaceSourceListing = recordedSourceListingForCompare(projectDir, recorded, current, intent, space);
  return swarmSourceChanged(projectDir, before, current.listing);
}

// Whether the person's source is as the build last verified it (the last
// landing's listing, else the stage's opening listing): the comparison a landing
// makes. False when no listing reads back or the evidence cannot be read; the
// caller then keeps its fingerprint compare.
export function swarmSourceUnchangedInStage(
  projectDir: string,
  slug: string,
  current: WorkspaceSourceState,
): boolean {
  try {
    const chain = currentSwarmSourceMergeChain(projectDir, slug);
    if (chain.state === "ready") return swarmSourceChangedSince(projectDir, slug, chain.listing, current)?.length === 0;
    if (chain.state !== "none") return false;
    const opening = currentSwarmSourceOpeningFingerprint(projectDir, slug);
    return opening.state === "ready" && opening.listing !== undefined && swarmSourceChanged(
      projectDir,
      recordedSourceListingUnderCurrentBoundary(opening.listing, current.listing),
      current.listing,
    ).length === 0;
  } catch {
    return false;
  }
}

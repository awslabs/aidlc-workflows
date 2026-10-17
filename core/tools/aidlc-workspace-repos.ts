// Where a workspace's repos sit, for the checks that only reach inside the
// project and for the offer to write repos.json. repoDir in aidlc-lib.ts is the
// one resolver; this module builds on it.

import { mkdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { isoTimestamp, repoDir, sessionsDir, writeFileAtomic } from "./aidlc-lib.ts";
import { readWorkspaceRepos } from "./aidlc-workspace-manifest.ts";

// The checkouts repos.json and repos.local.json place at a path of their own.
function mappedRepoDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  for (const entry of readWorkspaceRepos(projectDir).entries.values()) {
    if (entry.path !== undefined) dirs.push(repoDir(projectDir, entry.name));
  }
  return dirs;
}

// A repo the person mapped counts as the project, wherever it sits: the one
// rule for every "only inside the project" check. A target is inside when the
// path as written, or the real path of its deepest existing ancestor, lies under
// the workspace or under a mapped repo (so a link from outside into one counts
// as inside; a dangling link resolves to nothing and counts as inside too).
export function insideProject(projectDir: string, target: string): boolean {
  const within = (path: string, dir: string): boolean => {
    const rel = relative(dir, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
  };
  try {
    const roots: string[] = [];
    for (const root of [projectDir, ...mappedRepoDirs(projectDir)]) {
      const lexical = resolvePath(root);
      roots.push(lexical);
      try {
        roots.push(realpathSync(lexical));
      } catch {
        // A mapped repo not cloned yet has only its lexical path.
      }
    }
    const targetAbs = resolvePath(target);
    if (roots.some((root) => within(targetAbs, root))) return true;
    const suffix: string[] = [];
    let cursor = targetAbs;
    while (lstatSync(cursor, { throwIfNoEntry: false }) === undefined) {
      const parent = dirname(cursor);
      if (parent === cursor) return true;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    const real = join(realpathSync(cursor), ...suffix);
    return roots.some((root) => within(real, root));
  } catch {
    return true;
  }
}

// Where a workspace-relative target is: `<repo>/<path>` in a repo repos.json
// maps elsewhere, as a child repo's target is spelled; anything else under the
// workspace. `root` is the folder the target must stay inside.
export function workspaceTargetPath(projectDir: string, target: string): { root: string; absolute: string } {
  const [first, ...rest] = target.split("/");
  if (rest.length > 0 && readWorkspaceRepos(projectDir).entries.get(first)?.path !== undefined) {
    const root = repoDir(projectDir, first);
    return { root, absolute: resolvePath(root, rest.join("/")) };
  }
  const root = resolvePath(projectDir);
  return { root, absolute: resolvePath(root, target) };
}

// The offer to write repos.json is made once per clone (decision 21).
const REPOS_OFFER_FILE = "repos-offer.json";

export function reposManifestOffered(projectDir: string): boolean {
  return existsSync(join(sessionsDir(projectDir), REPOS_OFFER_FILE));
}

export function noteReposManifestOffered(projectDir: string): void {
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileAtomic(join(sessionsDir(projectDir), REPOS_OFFER_FILE), `${JSON.stringify({ offered_at: isoTimestamp() })}\n`);
  } catch {
    // Without the mark the offer comes once more.
  }
}

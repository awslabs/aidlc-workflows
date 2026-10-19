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
// maps elsewhere, as a child repo's target is spelled; anything else from the
// workspace (`../payments-api/...` reaches a repo mapped beside it). Whether it
// stays inside is insideProject's to say.
export function workspaceTargetPath(projectDir: string, target: string): string {
  const [first, ...rest] = target.split("/");
  if (rest.length > 0 && readWorkspaceRepos(projectDir).entries.get(first)?.path !== undefined) {
    return resolvePath(repoDir(projectDir, first), rest.join("/"));
  }
  return resolvePath(projectDir, target);
}

// A git address as AI-DLC records or prints it: a URL's user and token (some
// hosts and CI checkouts keep them in origin) stay in the person's own git
// config. An scp-style address keeps its user, which is no secret.
export function recordableGitAddress(address: string): string {
  return address.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

// One repo however a clone spells its address: scheme, user, token, the
// default port, host case, a trailing slash and `.git` aside, so `git@host:o/r`,
// `ssh://git@host/o/r` and `https://host/o/r.git` are one. A local path or
// file:// URL is its absolute path.
export function gitAddressKey(address: string): string {
  const value = address.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  if (!/^file:\/\//i.test(value)) {
    const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(value);
    if (url) {
      const scheme = url[1].toLowerCase();
      const port = url[3] && !(url[3] === "22" && scheme.includes("ssh")) && !(url[3] === "443" && scheme === "https") &&
          !(url[3] === "80" && scheme === "http")
        ? `:${url[3]}`
        : "";
      return `${url[2].toLowerCase()}${port}${url[4] ?? ""}`;
    }
    // scp-style host:path; a one-letter "host" is a Windows drive.
    const scp = /^(?:[^@/\\]+@)?([^/\\:]{2,}):(?!\/\/)(.+)$/.exec(value);
    if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  }
  const path = /^file:\/\//i.test(value) ? decodeURIComponent(value.slice("file://".length)).replace(/^\/([a-z]:)/i, "$1") : value;
  const absolute = resolvePath(path).replace(/\\/g, "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
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

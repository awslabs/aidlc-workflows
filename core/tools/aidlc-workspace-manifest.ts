// Shared repos.json schema: which repos a workspace declares and where each
// one's checkout lives, and the lines a person reads about them, for workspace
// sync, doctor and the engine's one resolver (repoDir in aidlc-lib.ts). This
// module imports only modules that never import aidlc-lib.ts, so aidlc-lib.ts
// can read it without an import cycle.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, renameSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { appendJsoncArrayItem } from "./aidlc-distribution.ts";
import { normalizeDriveLetter, repoNameProblem, repoNameRefusal } from "./aidlc-runtime-paths.ts";

export const REPOS_FILE = "repos.json";
// One person's own paths, never committed (AI-DLC's marked .gitignore block).
export const REPOS_LOCAL_FILE = "repos.local.json";

// Where a workspace's repo list is, in the order it is read: aidlc/repos.json,
// checked in with the team's record, then the root repos.json an AI-DLC before
// 2.12 wrote. The one order for every reader, on disk and at a commit.
export const REPOS_MANIFEST_PLACES = ["aidlc/repos.json", "repos.json"] as const;
export type ReposManifestPlace = (typeof REPOS_MANIFEST_PLACES)[number];

// The repo list found first, given a way to read one of those paths (a file on
// disk, or `git show <commit>:<path>` for a workspace that is not here). Null
// when neither place holds one; an invalid list throws parseWorkspaceManifest's
// error, as a reader of the file on disk does.
export function workspaceManifestAt(
  read: (rel: ReposManifestPlace) => string | null,
): { path: ReposManifestPlace; text: string; manifest: WorkspaceManifest } | null {
  for (const path of REPOS_MANIFEST_PLACES) {
    const text = read(path);
    if (text !== null) return { path, text, manifest: parseWorkspaceManifest(text) };
  }
  return null;
}

function entryAt(path: string): ReturnType<typeof lstatSync> | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

// The workspace's repo list on disk, in REPOS_MANIFEST_PLACES order. With none
// yet, a new list goes in aidlc/ when the workspace has that folder, and at the
// root otherwise (no folder is made for it).
export function reposManifestPath(root: string): string {
  const inRecord = join(root, ...REPOS_MANIFEST_PLACES[0].split("/"));
  if (entryAt(inRecord)) return inRecord;
  const atRoot = join(root, REPOS_FILE);
  if (entryAt(atRoot)) return atRoot;
  return entryAt(join(root, "aidlc"))?.isDirectory() ? inRecord : atRoot;
}

// The release whose readers first look in aidlc/; one before it reads only the
// root. The two lines below are the only words about the move.
const REPOS_IN_AIDLC_SINCE = { major: 2, minor: 12 };
export const REPOS_MOVED_LINE =
  `AI-DLC moved repos.json into aidlc/. Commit it so your team gets it; teammates need AI-DLC ` +
  `${REPOS_IN_AIDLC_SINCE.major}.${REPOS_IN_AIDLC_SINCE.minor} or newer.`;

// Said when the person sets a project to an earlier release (a pin, `aidlc
// use`): that release would not see the list where this one moved it.
export function reposListGoingBackLine(root: string, release: string): string | null {
  const parts = /^(\d+)\.(\d+)\./.exec(release);
  if (parts === null) return null;
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
  const earlier = major < REPOS_IN_AIDLC_SINCE.major ||
    (major === REPOS_IN_AIDLC_SINCE.major && minor < REPOS_IN_AIDLC_SINCE.minor);
  if (!earlier || !entryAt(join(root, "aidlc", REPOS_FILE))?.isFile() || entryAt(join(root, REPOS_FILE))) return null;
  const move = gitTracks(root, `aidlc/${REPOS_FILE}`) ? "git mv" : "mv";
  return `AI-DLC ${release} reads repos.json only at the project root; to keep your repo list on it, run ` +
    `\`${move} aidlc/repos.json repos.json\`.`;
}

// A root repos.json is AI-DLC's repo list only when it reads as one; any other
// file of that name is the project's own, never moved or counted as AI-DLC's.
function rootFileIsTheList(root: string): boolean {
  try {
    parseWorkspaceManifest(readFileSync(join(root, REPOS_FILE), "utf-8"));
    return true;
  } catch {
    return false;
  }
}

// Whether the root repos.json key is AI-DLC's list rather than the project's
// source: it reads as the list, or it has gone where the move puts it.
export function rootReposManifestIsAidlcs(root: string): boolean {
  return rootFileIsTheList(root) || reposManifestMovedIntoAidlc(root);
}

function gitTracks(root: string, path: string): boolean {
  return spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", path], { stdio: "ignore", timeout: 10_000 })
    .status === 0;
}

// The one move, for config's refresh: a root repos.json goes into aidlc/ with
// its bytes kept. A file git tracks moves by `git mv`, so the rename is staged
// and a teammate whose AI-DLC made the same move still pulls the lead's commit
// cleanly (a plain rename leaves an untracked aidlc/repos.json that blocks it);
// when git refuses, the list stays at the root, where it is still read. With a
// list already in aidlc/, both stay as they are and aidlc/'s is read; a root
// repos.json that does not read as the list stays the project's.
export function moveReposManifestIntoAidlc(root: string): { moved: boolean; tracked: boolean } {
  const from = join(root, REPOS_FILE);
  const to = join(root, "aidlc", REPOS_FILE);
  if (
    !entryAt(from)?.isFile() || !entryAt(join(root, "aidlc"))?.isDirectory() || entryAt(to) ||
    !rootFileIsTheList(root)
  ) {
    return { moved: false, tracked: false };
  }
  if (gitTracks(root, REPOS_FILE)) {
    const moved = spawnSync("git", ["-C", root, "mv", "--", REPOS_FILE, `aidlc/${REPOS_FILE}`], {
      stdio: "ignore",
      timeout: 10_000,
    }).status === 0;
    return { moved, tracked: moved };
  }
  try {
    renameSync(from, to);
    return { moved: true, tracked: false };
  } catch {
    return { moved: false, tracked: false };
  }
}

// For a refresh run in another process: whether a root repos.json git tracks is
// here now, and afterwards whether that move happened (REPOS_MOVED_LINE's case).
export function trackedReposManifestAtRoot(root: string): boolean {
  return entryAt(join(root, REPOS_FILE))?.isFile() === true && rootFileIsTheList(root) && gitTracks(root, REPOS_FILE);
}

export function reposManifestMovedIntoAidlc(root: string): boolean {
  return !entryAt(join(root, REPOS_FILE)) && entryAt(join(root, "aidlc", REPOS_FILE))?.isFile() === true;
}

export interface WorkspaceRepoEntry {
  name: string;
  branch?: string;
  url?: string;
  // Where the checkout lives: relative to the workspace (it may point outside
  // it), absolute, or "." for the workspace folder itself.
  path?: string;
}

export interface WorkspaceManifest {
  org?: string;
  repos: WorkspaceRepoEntry[];
}

export const WORKSPACE_GITIGNORE_GATE_BEGIN =
  "# >>> aidlc workspace-sync managed (do not edit inside; regenerated from repos.json) >>>";
export const WORKSPACE_GITIGNORE_GATE_END =
  "# <<< aidlc workspace-sync managed <<<";
export const WORKSPACE_RECOVERY_GITIGNORE =
  "/.aidlc-workspace-sync-recovery-*/";
// The staging folder a clone runs in; one is left behind when the clone is cut
// off (a host's command timeout).
export const WORKSPACE_STAGING_GITIGNORE =
  "/.aidlc-workspace-sync-txn-*/";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripWorkspaceManifestComments(raw: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        output += " ";
        i++;
      }
      if (i < raw.length) output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      i += 2;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === "*" && raw[i + 1] === "/") {
          output += "  ";
          i++;
          closed = true;
          break;
        }
        output += raw[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (!closed) throw new Error("repos.json contains an unterminated block comment.");
      continue;
    }

    output += char;
  }

  return output;
}

// A blank string is a value the person has not set yet.
function setString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function checkPath(file: string, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${file} entry "${name}": "path" must be a string.`);
  return setString(value);
}

export function parseWorkspaceManifest(raw: string): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(stripWorkspaceManifestComments(raw));
  } catch (err) {
    throw new Error(`repos.json is not valid JSON: ${(err as Error).message}`);
  }

  if (!isObject(value) || !Array.isArray(value.repos)) {
    throw new Error('repos.json must have an array "repos".');
  }
  if ("org" in value && typeof value.org !== "string") {
    throw new Error('repos.json "org" must be a string when set.');
  }

  const repos: WorkspaceRepoEntry[] = [];
  const names = new Set<string>();
  for (const entry of value.repos) {
    if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      throw new Error('every repos.json entry needs a non-empty string "name".');
    }
    if (repoNameProblem(entry.name) !== null) {
      throw new Error(repoNameRefusal("repos.json entry", entry.name));
    }
    if (names.has(entry.name)) {
      throw new Error(`repos.json contains duplicate repo name "${entry.name}".`);
    }
    names.add(entry.name);

    if (
      "branch" in entry &&
      (typeof entry.branch !== "string" || entry.branch.trim().length === 0)
    ) {
      throw new Error(
        `repos.json entry "${entry.name}": "branch" must be a non-empty string when set.`,
      );
    }
    if ("url" in entry && typeof entry.url !== "string") {
      throw new Error(`repos.json entry "${entry.name}": "url" must be a string when set.`);
    }
    const url = setString(entry.url);
    const path = checkPath("repos.json", entry.name, entry.path);

    repos.push({
      name: entry.name,
      ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  }
  const org = setString(value.org);
  return { ...(org !== undefined ? { org } : {}), repos };
}

export interface LocalRepoOverrides {
  overrides: Map<string, Pick<WorkspaceRepoEntry, "path" | "url" | "branch">>;
  // One line each for what the file holds that is not read.
  ignored: string[];
}

const LOCAL_FIELDS = new Set(["name", "path", "url", "branch"]);

// repos.local.json: the same shape as repos.json, read only for `path`, `url`
// and `branch` of the repos repos.json lists. It never adds a repo.
export function parseLocalRepoOverrides(raw: string, manifest: WorkspaceManifest): LocalRepoOverrides {
  let value: unknown;
  try {
    value = JSON.parse(stripWorkspaceManifestComments(raw));
  } catch (err) {
    throw new Error(`repos.local.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(value) || !Array.isArray(value.repos)) {
    throw new Error('repos.local.json must have an array "repos".');
  }
  const listed = new Set(manifest.repos.map((repo) => repo.name));
  const overrides: LocalRepoOverrides["overrides"] = new Map();
  const ignored: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "repos") ignored.push(`repos.local.json sets "${key}", which only repos.json can set, so it is ignored.`);
  }
  for (const entry of value.repos) {
    if (!isObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      ignored.push('An entry in repos.local.json has no "name", so it is ignored.');
      continue;
    }
    const name = entry.name;
    if (!listed.has(name)) {
      ignored.push(`repos.local.json names ${name}, which repos.json does not list, so it is ignored.`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!LOCAL_FIELDS.has(key)) {
        ignored.push(`repos.local.json sets "${key}" for ${name}; only path, url and branch are read there, so it is ignored.`);
      }
    }
    const path = typeof entry.path === "string" ? setString(entry.path) : undefined;
    const url = typeof entry.url === "string" ? setString(entry.url) : undefined;
    const branch = typeof entry.branch === "string" ? setString(entry.branch) : undefined;
    overrides.set(name, {
      ...(path !== undefined ? { path } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(branch !== undefined ? { branch } : {}),
    });
  }
  return { overrides, ignored };
}

export interface WorkspaceRepos {
  // Null when the workspace has no repos.json, or one that cannot be read.
  manifest: WorkspaceManifest | null;
  error?: string;
  localError?: string;
  // repos.json's entries with the person's repos.local.json applied.
  entries: Map<string, WorkspaceRepoEntry>;
  // Which file gave an entry its path.
  pathSource: Map<string, typeof REPOS_FILE | typeof REPOS_LOCAL_FILE>;
  ignored: string[];
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

// Read once per change of either file: repoDir runs on hot paths.
const cache = new Map<string, { stamp: string; repos: WorkspaceRepos }>();

export function readWorkspaceRepos(root: string): WorkspaceRepos {
  const manifestPath = reposManifestPath(root);
  const localPath = join(root, REPOS_LOCAL_FILE);
  const stamp = `${manifestPath}|${fileStamp(manifestPath)}|${fileStamp(localPath)}`;
  const cached = cache.get(root);
  if (cached?.stamp === stamp) return cached.repos;
  const repos: WorkspaceRepos = { manifest: null, entries: new Map(), pathSource: new Map(), ignored: [] };
  let raw: string | null = null;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    // No repos.json: every repo lives at <workspace>/<name>.
  }
  if (raw !== null) {
    try {
      repos.manifest = parseWorkspaceManifest(raw);
    } catch (err) {
      repos.error = (err as Error).message;
    }
  }
  if (repos.manifest !== null) {
    for (const entry of repos.manifest.repos) {
      repos.entries.set(entry.name, { ...entry });
      if (entry.path !== undefined) repos.pathSource.set(entry.name, REPOS_FILE);
    }
    let localRaw: string | null = null;
    try {
      localRaw = readFileSync(localPath, "utf-8");
    } catch {
      // No personal overrides.
    }
    if (localRaw !== null) {
      try {
        const local = parseLocalRepoOverrides(localRaw, repos.manifest);
        repos.ignored.push(...local.ignored);
        for (const [name, override] of local.overrides) {
          const entry = repos.entries.get(name);
          if (!entry) continue;
          Object.assign(entry, override);
          if (override.path !== undefined) repos.pathSource.set(name, REPOS_LOCAL_FILE);
        }
      } catch (err) {
        repos.localError = (err as Error).message;
      }
    }
  }
  cache.set(root, { stamp, repos });
  return repos;
}

// Where a repos.json `path` puts a checkout, read against the workspace: the one
// reading repoDir (aidlc-lib.ts) and add-repo --path use. A path written on
// Windows ("..\\billing") reads the same on every platform.
export function mappedRepoDir(projectDir: string, path: string): string {
  return normalizeDriveLetter(resolve(projectDir, path.replace(/\\/g, "/")));
}

// A path as the person wrote it, with forward slashes, for the lines they read.
export function displayRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

// What this person's repos.local.json holds that is not read, one line each.
export function localRepoOverrideLines(projectDir: string): string[] {
  const repos = readWorkspaceRepos(projectDir);
  return [
    ...(repos.localError === undefined ? [] : [`${repos.localError} Your own paths in it are not used until it reads.`]),
    ...repos.ignored,
  ];
}

// What the person reads when a repo's checkout is not where AI-DLC looks.
export function repoNotThereLine(projectDir: string, repoName: string): string {
  const repos = readWorkspaceRepos(projectDir);
  const source = repos.pathSource.get(repoName);
  const where = displayRepoPath(source === undefined ? repoName : repos.entries.get(repoName)?.path ?? repoName);
  if (source === REPOS_LOCAL_FILE) {
    return `${repoName} is not at ${where}, where repos.local.json puts it. Clone it there, or change its path in repos.local.json.`;
  }
  if (source === REPOS_FILE) {
    return `${repoName} is not at ${where}, where repos.json puts it. Clone it there, or give its path in repos.local.json.`;
  }
  return repos.entries.has(repoName)
    ? `${repoName} is not at ${where} in this workspace. Clone it there, or give its path in repos.local.json.`
    : `${repoName} is not at ${where} in this workspace. Clone it there, or list it in repos.json with its path.`;
}

// Whether repos.json gives a repo an address to clone it from: its own url,
// or the org's.
export function repoCloneable(projectDir: string, repoName: string): boolean {
  const repos = readWorkspaceRepos(projectDir);
  return repos.entries.get(repoName)?.url !== undefined || (repos.entries.has(repoName) && repos.manifest?.org !== undefined);
}

// With this person's repos.local.json unreadable: what is wrong, and where the
// repos its paths may move are looked for until it reads. Null when it reads.
export function localUnreadableLine(projectDir: string, repoNames: string[]): string | null {
  const error = readWorkspaceRepos(projectDir).localError;
  if (error === undefined) return null;
  const one = repoNames.length === 1;
  const them = one ? repoNames[0] : `${repoNames.slice(0, -1).join(", ")} and ${repoNames.at(-1)}`;
  return `${error.replace(/([^.!?])$/, "$1.")} Your own paths in it are not used until it reads, so ${them} ` +
    `${one ? "is" : "are"} looked for where repos.json puts ${one ? "it" : "them"} for now.`;
}

// The offer, when repos.json can clone a repo that is not where it puts it.
export function repoCloneOfferLine(projectDir: string, repoNames: string[]): string {
  const repos = readWorkspaceRepos(projectDir);
  const where = (name: string): string => {
    const source = repos.pathSource.get(name);
    const at = displayRepoPath(source === undefined ? name : repos.entries.get(name)?.path ?? name);
    return source === undefined ? `${name} is not at ${at} in this workspace yet` : `${name} is not at ${at} yet, where ${source} puts it`;
  };
  return repoNames.length === 1
    ? `${where(repoNames[0])}. Do you want me to clone it there?`
    : `${repoNames.map(where).join("; ")}. Do you want me to clone them there?`;
}

// The lines repos.json's managed .gitignore block holds: the recovery folder
// and each declared repo whose checkout sits inside the workspace (by its own
// path in repos.json, never one person's override), never the workspace itself.
export function workspaceGitignoreEntries(manifest: WorkspaceManifest): string[] {
  const lines = [WORKSPACE_RECOVERY_GITIGNORE, WORKSPACE_STAGING_GITIGNORE];
  for (const repo of manifest.repos) {
    if (repo.path === undefined) {
      lines.push(`/${repo.name}/`);
      continue;
    }
    if (isAbsolute(repo.path) || /^[A-Za-z]:[\\/]/.test(repo.path)) continue;
    const inside = normalize(repo.path).replaceAll("\\", "/").replace(/\/+$/, "");
    if (inside === "." || inside === ".." || inside.startsWith("../") || inside === "") continue;
    lines.push(`/${inside}/`);
  }
  return [...new Set(lines)];
}

// repos.json after `entry` joins it: one entry added in place, the file's
// comments and layout kept, or a new file when there is none. Null when the
// text has no `repos` array to add to.
export function workspaceManifestWith(raw: string | null, org: string | undefined, entry: WorkspaceRepoEntry): string | null {
  if (raw === null) return `${JSON.stringify({ ...(org === undefined ? {} : { org }), repos: [entry] }, null, 2)}\n`;
  return appendJsoncArrayItem(raw, "repos", entry);
}

// The owner in a hosted address that has a host, an owner and a name
// (`https://host/<owner>/<name>.git`, `git@host:<owner>/<name>.git`): what a new
// repos.json names as its `org`. Null for a local path or any other shape.
export function hostedAddressOwner(url: string): string | null {
  const hosted =
    /^(?!file:)[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\s/?#@]*@)?[^\s/?#@]+\/([^\s/?#]+)\/[^\s/?#]+$/i.exec(url) ??
    /^(?:[^\s@/:]+@)?[^\s/:@]{2,}:([^\s/:\\][^\s/]*)\/[^\s/]+$/.exec(url);
  return hosted?.[1] ?? null;
}

// The address as repos.json may hold it, a file the team commits: an http(s)
// address loses its whole userinfo (usually a token), any other its password;
// an ssh user name such as `git@` is no secret and stays.
export function withoutCredentials(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]*)@/, (whole, scheme: string, info: string) =>
    /^https?:\/\/$/i.test(scheme)
      ? scheme
      : info.includes(":")
        ? `${scheme}${info.slice(0, info.indexOf(":"))}@`
        : whole);
}

// Parse .gitmodules (ini-like) into submodule entries. Pure and exported for
// direct unit testing. Line-oriented, tolerant: malformed content degrades to
// whatever parses (total garbage yields []); it never throws. An entry with no
// path is dropped, as is any path that is absolute or escapes the project via a
// `..` segment (a caller joins path under projectDir and must not follow it out).
export function parseGitmodules(
  content: string
): Array<{ name: string; path: string; url: string }> {
  const entries: Array<{ name: string; path: string; url: string }> = [];
  let current: { name: string; path: string; url: string } | null = null;
  const finish = () => {
    if (!current) return;
    const p = current.path;
    const isUnsafe =
      p === "" ||
      p.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(p) || // Windows drive-absolute
      p.split(/[/\\]/).includes("..");
    if (!isUnsafe) entries.push(current);
    current = null;
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      finish();
      const m = line.match(/^\[submodule\s+"(.+)"\]$/);
      current = m ? { name: m[1], path: "", url: "" } : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "path") current.path = value;
    else if (key === "url") current.url = value;
  }
  finish();
  return entries;
}

// A path .gitmodules lists, as the '/'-joined path from the project the scan
// walks (a Windows path's backslashes, a leading ./ and a trailing slash read
// the same).
export function submodulePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

// Whether `name` is a folder the project's .gitmodules lists.
export function isProjectSubmodule(projectDir: string, name: string): boolean {
  let content: string;
  try {
    content = readFileSync(join(projectDir, ".gitmodules"), "utf-8");
  } catch {
    return false;
  }
  return parseGitmodules(content).some((entry) => submodulePath(entry.path) === name);
}

// A repo of the workspace as git cloned it here: the listing `read` makes of
// the commit the clone checked out, which the first entry of the repo's HEAD
// reflog (git's own record of the clone) names, so whatever was committed,
// pushed or pulled there since still reads as a change. A clone that writes
// links as plain files (core.symlinks false, Git for Windows' default) checked
// each link out as a file holding its text, so the listing has it as that
// file, its target unread. Null when git keeps no record of a clone there.
// Kept per folder and commit for the process.
const clonedListings = new Map<string, Map<string, string> | null>();
export function clonedRepoListing(
  dir: string,
  read: (commit: string, followLinks: boolean) => ReadonlyMap<string, string> | null,
): Map<string, string> | null {
  const git = (args: string[]): string | null => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const first = git(["reflog", "show", "--format=%H %gs", "HEAD"])?.split(/\r?\n/).filter(Boolean).at(-1);
  const commit = first === undefined ? null : /^([0-9a-f]{40}|[0-9a-f]{64}) clone: /.exec(first)?.[1] ?? null;
  if (commit === null) return null;
  const key = `${resolve(dir)}\0${commit}`;
  if (!clonedListings.has(key)) {
    const plainLinks = git(["config", "--bool", "core.symlinks"]) === "false";
    const listing = read(commit, !plainLinks);
    clonedListings.set(key, listing === null ? null : new Map([...listing].map(([path, entry]) =>
      [path, plainLinks && entry.startsWith("120000 ") ? `100644 ${entry.slice(7)}` : entry])));
  }
  return clonedListings.get(key) ?? null;
}

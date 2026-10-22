// Shared repos.json schema: which repos a workspace declares and where each
// one's checkout lives, and the lines a person reads about them, for workspace
// sync, doctor and the engine's one resolver (repoDir in aidlc-lib.ts). This
// module imports nothing of AI-DLC's own, so aidlc-lib.ts can read it without
// an import cycle.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

// A repo name is a single path segment (no separators, no `..`). A repo with no
// `path` of its own lives at `<workspace>/<name>`.
export const REPO_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_REGEX.test(name) && name !== "." && name !== "..";
}

export const REPOS_FILE = "repos.json";
// One person's own paths, never committed (AI-DLC's marked .gitignore block).
export const REPOS_LOCAL_FILE = "repos.local.json";

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
    if (!isValidRepoName(entry.name)) {
      throw new Error(
        `repos.json entry "${entry.name}": "name" must be a single path segment matching ${REPO_NAME_REGEX} (no separators or "..").`,
      );
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
  const manifestPath = join(root, REPOS_FILE);
  const localPath = join(root, REPOS_LOCAL_FILE);
  const stamp = `${fileStamp(manifestPath)}|${fileStamp(localPath)}`;
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

// The lines repos.json's managed .gitignore block holds: the recovery folder
// and each declared repo whose checkout sits inside the workspace (by its own
// path in repos.json, never one person's override), never the workspace itself.
export function workspaceGitignoreEntries(manifest: WorkspaceManifest): string[] {
  const lines = [WORKSPACE_RECOVERY_GITIGNORE];
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

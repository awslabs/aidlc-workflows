// Shared repos.json schema and path rules for workspace sync and doctor.

import { dirname, resolve } from "node:path";
import { isValidRepoName, REPO_NAME_REGEX } from "./aidlc-lib.ts";

export interface WorkspaceRepoEntry {
  name: string;
  branch?: string;
  url?: string;
}

export interface WorkspaceManifest {
  org: string;
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

export function parseWorkspaceManifest(raw: string): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(stripWorkspaceManifestComments(raw));
  } catch (err) {
    throw new Error(`repos.json is not valid JSON: ${(err as Error).message}`);
  }

  if (
    !isObject(value) ||
    typeof value.org !== "string" ||
    value.org.trim().length === 0 ||
    !Array.isArray(value.repos)
  ) {
    throw new Error('repos.json must have a non-empty string "org" and an array "repos".');
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
    if (
      "url" in entry &&
      (typeof entry.url !== "string" || entry.url.trim().length === 0)
    ) {
      throw new Error(
        `repos.json entry "${entry.name}": "url" must be a non-empty string when set.`,
      );
    }

    repos.push({
      name: entry.name,
      ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
    });
  }
  return { org: value.org, repos };
}

export function workspaceRepoPath(root: string, name: string): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, name);
  if (!isValidRepoName(name) || dirname(candidate) !== resolvedRoot) {
    throw new Error(
      `repo name "${name}" does not resolve to an immediate child of the workspace root`,
    );
  }
  return candidate;
}

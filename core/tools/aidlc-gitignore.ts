import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { managedBlockMarkers } from "./aidlc-config-diagnostics.ts";
import type { ProjectionDescriptor } from "./aidlc-distribution.ts";
import { git } from "./aidlc-git.ts";
import { SETTINGS_FILE } from "./aidlc-settings.ts";

// Representatives of the five record patterns documented as COMMITTED in the
// shipped .gitignore. --no-index also checks records already tracked by git.
const COMMITTED_RECORD_PROBES = [
  ["aidlc/spaces/default/memory/project.md", "memory/**"],
  ["aidlc/spaces/default/codekb/index.json", "codekb/**"],
  ["aidlc/spaces/default/intents/intents.json", "intents.json"],
  ["aidlc/spaces/default/intents/example/aidlc-state.md", "aidlc-state.md"],
  ["aidlc/spaces/default/intents/example/audit/example.md", "audit/*.md"],
] as const;
const PROBE_PATHS = COMMITTED_RECORD_PROBES.map(([path]) => path);

/**
 * User-owned ignore rules hiding records that travel to teammates by git. A
 * rule is the user's choice, so callers warn about it and never refuse it.
 */
export function committedRecordIgnoreConflicts(projectDir: string): string[] {
  let stdout: Uint8Array;
  try {
    const proc = Bun.spawnSync({
      cmd: [
        // -z needs --stdin; the probe paths go in NUL-terminated.
        "git", "-C", projectDir, "check-ignore", "-v", "-z", "--stdin", "--no-index",
      ],
      stdin: Buffer.from(PROBE_PATHS.map((path) => `${path}\0`).join("")),
      stdout: "pipe",
      stderr: "pipe",
    });
    // 1 means no matches; outside a git repository git exits 128.
    if (proc.exitCode !== 0) return [];
    stdout = proc.stdout;
  } catch {
    // Git unavailable: preserve user content, just as outside a git repository.
    return [];
  }

  const gitignore = join(projectDir, ".gitignore");
  // Git does not follow a symlinked .gitignore and config refuses one, so only
  // a regular file holds this project's rules; opening a FIFO would block.
  const lines = lstatSync(gitignore, { throwIfNoEntry: false })?.isFile()
    ? readFileSync(gitignore, "utf-8").split(/\r?\n/)
    : [];
  const { begin, end } = managedBlockMarkers(".gitignore", "gitignore");
  const beginAt = lines.indexOf(begin);
  const endAt = lines.indexOf(end);
  const managedBlock = beginAt >= 0 && endAt > beginAt &&
    lines.lastIndexOf(begin) === beginAt && lines.lastIndexOf(end) === endAt;
  // Git reports ignore sources relative to the repository root, even when
  // the configured project lives in a subdirectory of that repository.
  let projectRoot = projectDir;
  try {
    projectRoot = realpathSync(projectDir);
  } catch {
    // Keep the given path; git already answered for it.
  }
  let gitRoot = projectRoot;
  const root = Bun.spawnSync({
    cmd: ["git", "-C", projectDir, "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (root.exitCode === 0) gitRoot = new TextDecoder().decode(root.stdout).trim();
  // Name the rule's file from the project, so a parent repository's rule reads
  // ../.gitignore; a file outside the repository keeps its absolute path.
  const shownSource = (source: string): string => {
    const absolute = resolve(gitRoot, source);
    const fromProject = relative(projectRoot, absolute);
    const outside = relative(gitRoot, absolute).startsWith("..") || isAbsolute(relative(gitRoot, absolute));
    return (outside ? absolute : fromProject).replaceAll("\\", "/");
  };
  // The rule is named by file and line, never by its text: a pattern is
  // repository content, and this message reaches the terminal and the agent.
  // Control and format characters in the file's name show as "?".
  const visible = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  // -z: each match is four NUL-terminated fields, so no pattern byte can
  // split or merge records.
  const fields = new TextDecoder().decode(stdout).split("\0");
  const hiddenByRule = new Map<string, string[]>();
  for (let at = 0; at + 3 < fields.length; at += 4) {
    const [source, line, pattern, path] = fields.slice(at, at + 4);
    if (!source) continue;
    // Verbose check-ignore includes matching negations; those paths are visible.
    if (pattern.startsWith("!")) continue;
    if (managedBlock && resolve(gitRoot, source) === join(projectRoot, ".gitignore") &&
      Number(line) > beginAt + 1 && Number(line) < endAt + 1) continue;
    const record = COMMITTED_RECORD_PROBES.find(([probe]) => probe === path);
    if (!record) continue;
    const rule = `${visible(shownSource(source))}:${line}`;
    const hidden = hiddenByRule.get(rule) ?? [];
    hidden.push(record[1]);
    hiddenByRule.set(rule, hidden);
  }
  return [...hiddenByRule].map(([rule, records]) =>
    `${rule} hides committed workflow records (${records.join(", ")}) from git, so new ones will not reach teammates; narrow the rule if that is not intended`
  );
}

/**
 * The line config says on the run that first writes a harness's setup into a
 * git clone, while git neither holds nor ignores its install record nor tracks
 * a file the record says AI-DLC wrote whole (a copied setup the project
 * committed is not new): the setup's paths git lists, for the person to
 * commit. A path is named only when every file git lists under it is AI-DLC's
 * by the install record or the harness's data folder, so nothing of the
 * person's is named; aidlc/, which no record lists, only while git tracks
 * nothing under it.
 */
export function untrackedSetupLine(
  projectDir: string,
  descriptor: Pick<ProjectionDescriptor, "harnessDir" | "managedDirectories" | "rootIntegrations" | "productName">,
): string | null {
  const data = `${descriptor.harnessDir}/tools/data`;
  const record = `${data}/aidlc-manifest.json`;
  // Outside git, already in git's index, or ignored: nothing to say.
  if (git(projectDir, ["ls-files", "-z", "--", record]) !== "") return null;
  if (git(projectDir, ["check-ignore", "-q", "--", record]) !== null) return null;
  const ours = new Set<string>();
  const merged = new Set<string>();
  const filled = (value: unknown) => typeof value === "object" && value !== null && Object.keys(value).length > 0;
  try {
    const written = JSON.parse(readFileSync(join(projectDir, record), "utf-8")) as {
      files?: Record<string, unknown>;
      entries?: Record<string, unknown>;
      rootContributions?: Record<string, { hash?: unknown; entries?: unknown }>;
    };
    for (const path of Object.keys(written.files ?? {})) ours.add(path);
    for (const [path, part] of Object.entries(written.rootContributions ?? {})) {
      if (typeof part?.hash === "string" || filled(part?.entries)) ours.add(path);
    }
    for (const [path, entries] of Object.entries(written.entries ?? {})) {
      merged.add(path);
      if (filled(entries)) ours.add(path);
    }
  } catch {
    return null;
  }
  // A settings file AI-DLC merges into may be the project's own, committed before AI-DLC came.
  const tracked = git(projectDir, ["ls-files", "-z", "--", ...descriptor.managedDirectories])?.split("\0") ?? [];
  if (tracked.some((path) => ours.has(path) && !merged.has(path))) return null;
  const own = (path: string) => ours.has(path) || path.startsWith(`${data}/`) || path === SETTINGS_FILE;
  const roots = [...descriptor.rootIntegrations.map((integration) => integration.path), SETTINGS_FILE];
  const listed = git(projectDir, ["ls-files", "-z", "--others", "--exclude-standard", "--modified", "--",
    ...descriptor.managedDirectories, ...roots])?.split("\0").filter(Boolean) ?? [];
  const named: string[] = [];
  for (const folder of descriptor.managedDirectories) {
    const under = listed.filter((path) => path.startsWith(`${folder}/`));
    if (folder === "aidlc") {
      if (under.length > 0 && git(projectDir, ["ls-files", "-z", "--", folder]) === "") named.push(`${folder}/`);
      continue;
    }
    // The folder, or the shallowest folders under it holding nothing of the person's.
    const folders = (path: string) => {
      const found: string[] = [];
      for (let at = folder.length; at !== -1; at = path.indexOf("/", at + 1)) found.push(path.slice(0, at + 1));
      return found;
    };
    const mixed = new Set(under.filter((path) => !own(path)).flatMap(folders));
    for (const path of under.filter(own)) {
      const shown = folders(path).find((prefix) => !mixed.has(prefix)) ?? path;
      if (!named.includes(shown)) named.push(shown);
    }
  }
  named.push(...roots.filter((path) => listed.includes(path) && own(path)));
  if (named.length === 0) return null;
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `git does not track AI-DLC's setup for ${descriptor.productName} in this project yet: ${list}. ` +
    `Commit them so teammates who use ${descriptor.productName} get the same setup.`;
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { managedBlockMarkers } from "./aidlc-config-diagnostics.ts";

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

/** User-owned ignore rules hiding records that must travel to teammates by git. */
export function committedRecordIgnoreConflicts(projectDir: string): string[] {
  let stdout: Uint8Array;
  try {
    const proc = Bun.spawnSync({
      cmd: [
        "git", "-C", projectDir, "check-ignore", "-v", "--no-index", "--",
        ...PROBE_PATHS,
      ],
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
  const lines = existsSync(gitignore) ? readFileSync(gitignore, "utf-8").split(/\r?\n/) : [];
  const { begin, end } = managedBlockMarkers(".gitignore", "gitignore");
  const beginAt = lines.indexOf(begin);
  const endAt = lines.indexOf(end);
  const managedBlock = beginAt >= 0 && endAt > beginAt &&
    lines.lastIndexOf(begin) === beginAt && lines.lastIndexOf(end) === endAt;
  // Git reports ignore sources relative to the repository root, even when
  // the configured project lives in a subdirectory of that repository.
  let gitRoot = projectDir;
  if (managedBlock) {
    const root = Bun.spawnSync({
      cmd: ["git", "-C", projectDir, "rev-parse", "--show-toplevel"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (root.exitCode === 0) gitRoot = new TextDecoder().decode(root.stdout).trim();
  }
  const matches = new TextDecoder().decode(stdout).split("\n");
  const hiddenByRule = new Map<string, string[]>();
  for (const match of matches) {
    const parsed = /^(.*):(\d+):(.*)\t(.*)$/.exec(match);
    if (!parsed) continue;
    const [, source, line, pattern, path] = parsed;
    // Verbose check-ignore includes matching negations; those paths are visible.
    if (pattern.startsWith("!")) continue;
    if (managedBlock && resolve(gitRoot, source) === resolve(gitignore) &&
      Number(line) > beginAt + 1 && Number(line) < endAt + 1) continue;
    const record = COMMITTED_RECORD_PROBES.find(([probe]) => probe === path);
    if (!record) continue;
    const rule = `${source}:${line}: ${pattern}`;
    const hidden = hiddenByRule.get(rule) ?? [];
    hidden.push(record[1]);
    hiddenByRule.set(rule, hidden);
  }
  return [...hiddenByRule].map(([rule, records]) =>
    `${rule} hides committed workflow records (${records.join(", ")}); narrow the rule so teammates receive them`
  );
}

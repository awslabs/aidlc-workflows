// The merge queue's macOS unit selection. macOS runners set how fast the merge
// queue moves, so a merge group runs on macOS only the unit files that name
// macOS (or darwin) and the unit files the change itself touches; the nightly
// Full Suite still runs every unit file on macOS. When the change cannot be
// read against its base, every file runs: the selection only ever narrows a
// run it can explain.
//
//   bun scripts/ci-macos-unit-selection.ts --base <ref> --shard N/M
//
// prints GitHub step outputs: `mode=full` (run the shard as usual), `mode=none`
// (this shard has no selected file), or `mode=selected` with `exclude=<regex>`
// (leave out every file but this shard's share of the selected files). An
// exclude, unlike a filter, keeps the rest an ordinary tier, so a file whose
// cases all skip on macOS stays SKIP as it does in the full shard.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assignWeightedShards, parseShardSpec, type ShardConfig } from "../tests/lib/test-sharding.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const MACOS_NAMED = /darwin|macos/i;

export type MacosUnitSelection = { mode: "full" } | { mode: "none" } | { mode: "selected"; files: string[] };

/** Unit test files whose source names macOS or darwin: computed, never a kept list. */
export function macosNamedUnitFiles(unitDir: string): string[] {
  return readdirSync(unitDir)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => MACOS_NAMED.test(readFileSync(join(unitDir, name), "utf8")))
    .sort();
}

/** The unit test files the change touches, or null when git cannot compare it with its base. */
export function changedUnitFiles(repoRoot: string, base: string): string[] | null {
  const diff = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", base, "HEAD", "--", "tests/unit"], {
    encoding: "utf8",
  });
  if (diff.status !== 0) return null;
  return diff.stdout.split("\n").map((line) => line.trim())
    .filter((path) => /^tests\/unit\/[^/]+\.test\.ts$/.test(path) && existsSync(join(repoRoot, path)))
    .map((path) => basename(path));
}

/** This shard's share of the selection; `changed` is null when the change could not be read. */
export function macosUnitSelection(repoRoot: string, changed: string[] | null, shard: string): MacosUnitSelection {
  const spec = parseShardSpec(shard);
  if (changed === null) return { mode: "full" };
  const selected = [...new Set([...macosNamedUnitFiles(join(repoRoot, "tests", "unit")), ...changed])].sort();
  if (selected.length === 0) return { mode: "none" };
  // Spread the selected files over the same shards by their weights, so no
  // macOS job carries most of them.
  const full = JSON.parse(readFileSync(join(repoRoot, "tests", "unit-shard-weights.json"), "utf8")) as ShardConfig;
  const keep = new Set(selected);
  const config: ShardConfig = {
    defaultSeconds: full.defaultSeconds,
    weights: Object.fromEntries(Object.entries(full.weights).filter(([file]) => keep.has(file))),
    affinityGroups: full.affinityGroups.map((group) => group.filter((file) => keep.has(file))).filter((group) => group.length > 1),
  };
  const grouped = new Set(config.affinityGroups.flat());
  const groups = config.affinityGroups.length + selected.filter((file) => !grouped.has(file)).length;
  const files = assignWeightedShards(selected, Math.min(spec.total, groups), config)[spec.index - 1] ?? [];
  return files.length === 0 ? { mode: "none" } : { mode: "selected", files };
}

/**
 * GitHub step output lines for a selection. The exclude matches every unit file
 * except the selected ones, under each name the runner's --exclude reads: the
 * base name, the stem and the tier-qualified stem.
 */
export function selectionOutput(selection: MacosUnitSelection): string {
  if (selection.mode !== "selected") return `mode=${selection.mode}\n`;
  const stems = selection.files.map((file) => file.replace(/\.test\.ts$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `mode=selected\nexclude=^(?!(?:unit-)?(?:${stems.join("|")})(?:\\.test\\.ts)?$)\ncount=${selection.files.length}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string => {
    const at = args.indexOf(flag);
    if (at < 0 || !args[at + 1]) {
      console.error(`usage: bun scripts/ci-macos-unit-selection.ts --base <ref> --shard N/M (missing ${flag})`);
      process.exit(2);
    }
    return args[at + 1];
  };
  const changed = changedUnitFiles(REPO_ROOT, value("--base"));
  process.stdout.write(selectionOutput(macosUnitSelection(REPO_ROOT, changed, value("--shard"))));
}

// aidlc-workspace-doctor.ts - workspace-manifest health rows for `/aidlc --doctor`.
//
// A multi-repo workspace holds the AI-DLC records under aidlc/ at the root with
// child code repos cloned in as gitignored siblings. When a team declares those
// repos in an OPTIONAL repos.json manifest and reconciles them with
// aidlc-workspace-sync, these checks give the workspace structure a
// deterministic voice in --doctor that it otherwise lacks.
//
// Every row is ADVISORY (pass:true) with the detail in the LABEL - a workspace
// with uncommitted records or a not-yet-synced manifest is normal user state,
// not framework breakage, so these rows never change doctor's exit code (the
// --doctor render loop only prints `fix` on a FAILED row). W2/W3 stay absent
// without a manifest, so they do not add manifest-specific noise to single-repo
// installs.
//
// Factored into its own module (rather than inlined in aidlc-utility.ts, whose
// handleDoctor is already large) so the workspace-manifest checks read as one
// unit; handleDoctor calls workspaceManifestChecks() and spreads the rows in.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSiblingRepos, errorMessage, harnessDir } from "./aidlc-lib.ts";
import {
  parseWorkspaceManifest,
  WORKSPACE_GITIGNORE_GATE_BEGIN as GATE_BEGIN,
  WORKSPACE_GITIGNORE_GATE_END as GATE_END,
  WORKSPACE_RECOVERY_GITIGNORE,
} from "./aidlc-workspace-manifest.ts";

/** One --doctor report row. Structurally matches handleDoctor's results[]. */
export interface DoctorCheck {
  pass: boolean;
  label: string;
  fix?: string;
}

/**
 * Workspace-manifest health rows for `/aidlc --doctor` (all advisory - pass:true).
 *
 * W1 runs in any git workspace; W2/W3 run only when a repos.json manifest is
 * present at the workspace root (the declared multi-repo signal). A single-repo
 * install or a bare test fixture has no repos.json, so W2/W3 skip silently and
 * no manifest-specific rows are added.
 */
export function workspaceManifestChecks(projectDir: string): DoctorCheck[] {
  const results: DoctorCheck[] = [];
  const syncCmd = `bun ${harnessDir()}/tools/aidlc-workspace-sync.ts`;

  // W1 - Uncommitted records. Any git workspace: surface uncommitted changes
  // under aidlc/ so the shared records get committed and pushed to teammates.
  // Skips silently outside a git repo (smoke / fresh fixtures), mirroring the
  // stale-branches guard. git status --porcelain omits gitignored per-user
  // cursors, so ignored runtime state (active-intent, runtime-graph.json, ...)
  // never false-positives.
  try {
    const proc = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        projectDir,
        "-c",
        "status.showUntrackedFiles=all",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        "aidlc",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      results.push({ pass: true, label: "Workspace records: not a git repo - nothing to commit" });
    } else {
      const dirty = new TextDecoder()
        .decode(proc.stdout)
        .split("\n")
        .filter((l) => l.trim().length > 0);
      if (dirty.length === 0) {
        results.push({ pass: true, label: "Workspace records: no uncommitted changes under aidlc/" });
      } else {
        results.push({
          pass: true,
          label:
            `Workspace records: ${dirty.length} uncommitted change(s) under aidlc/ (advisory - the shared records travel by git; ` +
            "commit & push so teammates get them: `git add aidlc/ && git commit && git push`)",
        });
      }
    }
  } catch (e) {
    results.push({ pass: true, label: `Workspace records: check skipped (advisory) - ${errorMessage(e)}` });
  }

  // W2/W3 - only when a repos.json manifest is present (the declared multi-repo signal).
  const reposManifestPath = join(projectDir, "repos.json");
  if (existsSync(reposManifestPath)) {
    // Parse through the exact schema used by sync so doctor never reports a
    // manifest as synchronized when sync would reject it.
    let manifestNames: string[] | null = null;
    try {
      manifestNames = parseWorkspaceManifest(
        readFileSync(reposManifestPath, "utf-8"),
      ).repos.map((repo) => repo.name);
    } catch (e) {
      results.push({
        pass: true,
        label: `Workspace repos: repos.json present but unparseable or invalid (advisory) - ${errorMessage(e)}`,
      });
    }

    if (manifestNames) {
      // W2 - Manifest vs disk drift. discoverSiblingRepos scans the disk for
      // .git siblings - the SAME set the runtime uses at intent creation - so a
      // mismatch is exactly what the agent would (in)visibly see. Disk wins at
      // runtime; the manifest only drives sync, so this row nudges, never fails.
      const declared = new Set(manifestNames);
      const onDisk = new Set(discoverSiblingRepos(projectDir));
      const notCloned = [...declared].filter((n) => !onDisk.has(n)).sort();
      const notDeclared = [...onDisk].filter((n) => !declared.has(n)).sort();
      if (notCloned.length === 0 && notDeclared.length === 0) {
        results.push({
          pass: true,
          label: `Workspace repos: repos.json ⇄ on-disk siblings in sync (${declared.size} repo(s))`,
        });
      } else {
        const parts: string[] = [];
        if (notCloned.length > 0) {
          parts.push(`declared but not cloned [${notCloned.join(", ")}] - run \`${syncCmd}\``);
        }
        if (notDeclared.length > 0) {
          parts.push(
            `on disk but not in repos.json [${notDeclared.join(", ")}] - add them to repos.json ` +
              "so the declared set matches what the runtime discovers (they already work at runtime; this only keeps clone/sync accurate)",
          );
        }
        results.push({
          pass: true,
          label: `Workspace repos: ${notCloned.length + notDeclared.length} manifest/disk drift (advisory - ${parts.join("; ")})`,
        });
      }

      // W3 - Stale .gitignore managed block. The block between the frozen
      // markers is regenerated from repos.json by aidlc-workspace-sync; if it
      // doesn't match the manifest, sync hasn't been run since the last edit.
      const gitignorePath = join(projectDir, ".gitignore");
      const gi = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
      const b = gi.indexOf(GATE_BEGIN);
      const e = gi.indexOf(GATE_END);
      const expected = [
        WORKSPACE_RECOVERY_GITIGNORE,
        ...[...manifestNames].sort().map((n) => `/${n}/`),
      ].sort();
      if (b === -1 || e === -1 || e < b) {
        results.push({
          pass: true,
          label:
            manifestNames.length === 0
              ? `Workspace .gitignore: no managed block yet (advisory - run \`${syncCmd}\` once you declare repos)`
              : `Workspace .gitignore: managed block missing (advisory - run \`${syncCmd}\` to generate it)`,
        });
      } else {
        const actual = gi
          .slice(b + GATE_BEGIN.length, e)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .sort();
        const inSync =
          actual.length === expected.length && actual.every((v, i) => v === expected[i]);
        results.push({
          pass: true,
          label: inSync
            ? `Workspace .gitignore: managed block matches repos.json (${manifestNames.length} repo dir(s))`
            : `Workspace .gitignore: managed block stale vs repos.json (advisory - run \`${syncCmd}\` to regenerate it)`,
        });
      }
    }
  }

  return results;
}

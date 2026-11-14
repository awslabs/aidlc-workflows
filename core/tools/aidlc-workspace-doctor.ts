// aidlc-workspace-doctor.ts - workspace-manifest health rows for `/aidlc --doctor`.
//
// A multi-repo workspace holds the AI-DLC records under aidlc/ at the root with
// child code repos cloned in as gitignored siblings. When a team declares those
// repos in an OPTIONAL repos.json manifest and reconciles them with
// aidlc-workspace-sync, these checks give the workspace structure a
// deterministic voice in --doctor that it otherwise lacks.
//
// Every row is ADVISORY - warnings use pass:false with severity:"warn", so
// uncommitted or ignored records do not change doctor's exit code. W2/W3 stay
// absent without a manifest, avoiding manifest-specific noise in single-repo
// installs.
//
// Factored into its own module (rather than inlined in aidlc-utility.ts, whose
// collectDoctorReport is already large) so the workspace-manifest checks read as
// one unit; collectDoctorReport calls workspaceManifestChecks() and adds its rows.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSiblingRepos,
  errorMessage,
  isGitRepoDir,
  repoDir,
  REQUEST_TEXT_DIRS,
} from "./aidlc-lib.ts";
import { projectInRepo } from "./aidlc-git.ts";
import { committedRecordIgnoreConflicts } from "./aidlc-gitignore.ts";
import { onlyOwnLookRows } from "./aidlc-record-core.ts";
import { workspaceSyncInvocation } from "./aidlc-runtime-paths.ts";
import {
  parseWorkspaceManifest,
  readWorkspaceRepos,
  reposManifestPath,
  type WorkspaceManifest,
  WORKSPACE_GITIGNORE_GATE_BEGIN as GATE_BEGIN,
  WORKSPACE_GITIGNORE_GATE_END as GATE_END,
  WORKSPACE_STAGING_GITIGNORE,
  workspaceGitignoreEntries,
} from "./aidlc-workspace-manifest.ts";

/** One --doctor report row. Structurally matches collectDoctorReport's results[]. */
export interface DoctorCheck {
  pass: boolean;
  severity?: "warn";
  label: string;
  fix?: string;
}

// The name earlier releases of the Kiro CLI (V2) hook adapter
// (harness/kiro/hooks/aidlc-kiro-adapter.ts, forwardingLatchPath) wrote its
// forwarding latch under; it now writes inside the git-ignored sessions
// folder, so a file here is one left behind, which a project may have
// committed.
const FORWARDING_LATCH = "aidlc/.aidlc-forwarding-latch";

/**
 * Workspace-manifest health rows for `/aidlc --doctor` (all advisory).
 *
 * W1, the request folder and forwarding latch (W1c) and record visibility run
 * in any git workspace; W2/W3 run only when a repos.json manifest is present at
 * the workspace root (the declared multi-repo signal). A single-repo
 * install or a bare test fixture has no repos.json, so W2/W3 skip silently and
 * no manifest-specific rows are added.
 */
export function workspaceManifestChecks(projectDir: string): DoctorCheck[] {
  const results: DoctorCheck[] = [];
  const syncCmd = workspaceSyncInvocation();

  // W1c first - Files that hold the person's words and that git can see (the
  // request folder, the forwarding latch an earlier Kiro CLI (V2) release
  // left): one committed before it was ignored stays tracked (a request file
  // changes in git with each later request), and a project whose .gitignore
  // part is older, or a later rule of the team's, leaves it unignored. Doctor
  // names the steps and never runs them; while either row stands, W1 gives no
  // commit command, since `git add aidlc/` would take the words in.
  const git = (args: string[], input?: string) =>
    Bun.spawnSync({
      cmd: ["git", "-C", projectDir, ...args],
      // A literal-pathspec setting is the person's; the paths below are plain.
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GIT_LITERAL_PATHSPECS")),
      ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
      stdout: "pipe",
      stderr: "pipe",
    });
  const entries = (bytes: Uint8Array): string[] =>
    [...new Set(new TextDecoder().decode(bytes).split("\0").filter(Boolean))];
  // One row for each place that holds the person's words: the request folder,
  // and the forwarding latch earlier Kiro CLI (V2) releases left in aidlc/, the
  // first call the hook named for a request of theirs, which `git add aidlc/`
  // took in before the .gitignore part listed it.
  const heldWordsRow = (held: {
    name: string;
    // Every place it may be (the request folder: this release's and the one
    // an earlier release named); a row names the one holding the first file.
    paths: readonly string[];
    folder: boolean;
    label: (shown: string, counts: string) => string;
    // A file only one harness writes adds no row when its check cannot run
    // (git not found): the records row and the request-folder row each say
    // the check was skipped then.
    quietWhenSkipped?: boolean;
  }): { row: DoctorCheck | null; blocksCommit: boolean } => {
    try {
      const trackedProc = git(["ls-files", "-z", "--", ...held.paths]);
      const untrackedProc = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...held.paths]);
      // Taken out of git but not committed yet: teammates still get the file.
      const removedProc = git(["diff", "--cached", "--relative", "--no-renames", "--name-only", "-z", "--diff-filter=D", "--", ...held.paths]);
      // A conflicted file is listed once per stage.
      const tracked = trackedProc.exitCode === 0 ? entries(trackedProc.stdout) : [];
      const removedList = removedProc.exitCode === 0 ? entries(removedProc.stdout) : [];
      // A removed file still on disk and not ignored is counted once, as removed.
      const untrackedList = untrackedProc.exitCode === 0
        ? entries(untrackedProc.stdout).filter((path) => !removedList.includes(path))
        : [];
      const untracked = untrackedList.length;
      const removed = removedList.length;
      if (tracked.length + untracked + removed === 0) return { row: null, blocksCommit: false };
      const first = [...tracked, ...untrackedList, ...removedList][0] ?? "";
      const at = held.paths.find((path) => first === path || first.startsWith(`${path}/`)) ?? held.paths[0];
      const shown = held.folder ? `${at}/` : at;
      // A file git shows as untracked is not ignored; every tracked or removed
      // one is tried against the ignore rules as if untracked.
      const tried = [...tracked, ...removedList];
      const ignoredProc = untracked > 0 || tried.length === 0
        ? null
        : git(["check-ignore", "--no-index", "--stdin", "-z"], `${tried.join("\0")}\0`);
      const ignored = ignoredProc !== null && entries(ignoredProc.stdout).length === tried.length;
      const counts = [
        ...(tracked.length > 0 ? [`${tracked.length} that git tracks`] : []),
        ...(untracked > 0 ? [`${untracked} not ignored`] : []),
        ...(removed > 0 ? [`${removed} taken out of git, not committed yet`] : []),
      ];
      const steps = [
        // The line itself, not a refresh: a copied install refreshes from the
        // release it is on, which may predate the line.
        ...(ignored
          ? []
          : [
            `add the line \`${shown}\` to the project folder's .gitignore, ` +
            "and check no later rule of yours un-ignores it",
          ]),
        ...(tracked.length > 0
          ? [held.folder
            ? `in the project folder, take the tracked ones out of git, keeping the files: ` +
              `\`git rm --cached -r -f -- ${shown}\``
            : `in the project folder, take it out of git, keeping the file: \`git rm --cached -f -- ${shown}\``]
          : []),
        // The removal, and the ignore rule, reach teammates' clones only once
        // pushed; a refresh may have left the rule in .gitignore uncommitted.
        ...(tracked.length + removed > 0
          ? [ignored
            ? "commit and push the removal, with .gitignore if its change is not committed yet"
            : "commit and push the removal and the .gitignore change"]
          : ["commit and push the .gitignore change"]),
      ];
      // `git add aidlc/` would take the words in while git tracks them, shows
      // them, or holds a removed file the ignore rules do not cover; a staged
      // removal of an ignored file leaves the records row its command.
      return {
        row: { pass: false, severity: "warn", label: held.label(shown, counts.join(", ")), fix: steps.join(", then ") },
        blocksCommit: tracked.length + untracked > 0 || (removed > 0 && !ignored),
      };
    } catch (e) {
      return {
        row: held.quietWhenSkipped ? null : { pass: true, label: `${held.name}: check skipped (advisory) - ${errorMessage(e)}` },
        blocksCommit: false,
      };
    }
  };
  const request = heldWordsRow({
    name: "Request folder",
    paths: REQUEST_TEXT_DIRS,
    folder: true,
    label: (shown, counts) => `Request folder: files in ${shown} hold your own requests (${counts})`,
  });
  const latch = heldWordsRow({
    name: "Forwarding latch",
    paths: [FORWARDING_LATCH],
    folder: false,
    label: (shown, counts) => `Forwarding latch: ${shown} holds the words of a request of yours (${counts})`,
    quietWhenSkipped: true,
  });
  const blockers = [
    ...(request.blocksCommit ? ["request folder"] : []),
    ...(latch.blocksCommit ? ["forwarding latch"] : []),
  ].join(" and ");

  // W1 - Uncommitted records. Any git workspace: surface uncommitted changes
  // under aidlc/ so the shared records get committed and pushed to teammates.
  // Reports a passing row outside a git repo (smoke / fresh fixtures).
  // git status --porcelain omits gitignored per-user
  // cursors, so ignored runtime state (active-intent, runtime-graph.json, ...)
  // never false-positives. Each look and each doctor run writes its own rows
  // into this clone's audit log, so a log changed only by those is not counted
  // (onlyOwnLookRows); else every look would make this row ask for a commit.
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
        "-z",
        "--untracked-files=all",
        "--",
        "aidlc",
        // A request left for the engine is the person's words, never a shared
        // record; the request-folder row names it instead, and the latch row
        // the forwarding latch.
        ...REQUEST_TEXT_DIRS.map((dir) => `:(exclude)${dir}`),
        `:(exclude)${FORWARDING_LATCH}`,
      ],
      // The exclude is pathspec magic, which a literal-pathspec setting turns off.
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      results.push({ pass: true, label: "Workspace records: not a git repo - nothing to commit" });
    } else {
      const changes = porcelainChanges(proc.stdout);
      let prefix: string | null = null;
      const dirty = changes.filter((change) => {
        if (!AUDIT_LOG_PATH.test(change.path)) return true;
        // Porcelain paths start at the repository root, which may sit above
        // the project folder.
        prefix ??= projectInRepo(projectDir)?.prefix ?? "";
        return !onlyOwnLookRows(projectDir, prefix, change);
      });
      if (dirty.length === 0) {
        results.push({
          pass: true,
          label: changes.length === 0
            ? "Workspace records: no uncommitted changes under aidlc/"
            : "Workspace records: no uncommitted changes under aidlc/ other than the entries each look adds to this clone's audit log",
        });
      } else {
        results.push({
          pass: false,
          severity: "warn",
          label:
            `Workspace records: ${dirty.length} uncommitted change(s) under aidlc/ (advisory - the shared records travel by git; ` +
            (blockers !== ""
              ? `commit & push them so teammates get them once the ${blockers} steps below are done)`
              : "commit & push so teammates get them: `git add aidlc/`, `git commit`, `git push`)"),
          ...(blockers !== "" ? { fix: `do the ${blockers} steps below first; then this row names the commit` } : {}),
        });
      }
    }
  } catch (e) {
    results.push({ pass: true, label: `Workspace records: check skipped (advisory) - ${errorMessage(e)}` });
  }
  for (const row of [request.row, latch.row]) if (row) results.push(row);

  // W1b - A later user ignore rule can hide records even after config succeeded.
  for (const conflict of committedRecordIgnoreConflicts(projectDir)) {
    results.push({
      pass: false,
      severity: "warn",
      label: `Workspace record visibility: ${conflict} (advisory)`,
    });
  }

  // W2/W3 - only when a repos.json manifest is present (the declared multi-repo signal).
  const manifestPath = reposManifestPath(projectDir);
  if (existsSync(manifestPath)) {
    // Parse through the exact schema used by sync so doctor never reports a
    // manifest as synchronized when sync would reject it.
    let manifest: WorkspaceManifest | null = null;
    try {
      manifest = parseWorkspaceManifest(readFileSync(manifestPath, "utf-8"));
    } catch (e) {
      results.push({
        pass: true,
        label: `Workspace repos: repos.json present but unparseable or invalid (advisory) - ${errorMessage(e)}`,
      });
    }

    if (manifest) {
      const manifestNames = manifest.repos.map((repo) => repo.name);
      // W2 - Manifest vs disk drift: each declared repo at the path repoDir
      // gives it (this person's repos.local.json included), and every immediate
      // child repo the runtime would also find at intent creation. Disk wins at
      // runtime; the manifest only drives sync, so this row nudges, never fails.
      const declared = new Set(manifestNames);
      const declaredDirs = new Set(manifestNames.map((name) => repoDir(projectDir, name)));
      const notCloned = [...declared].filter((n) => !isGitRepoDir(repoDir(projectDir, n))).sort();
      const notDeclared = discoverSiblingRepos(projectDir)
        .filter((n) => !declared.has(n) && !declaredDirs.has(join(projectDir, n)))
        .sort();
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
      // doesn't match the manifest, it needs regeneration.
      const gitignorePath = join(projectDir, ".gitignore");
      const gi = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
      const b = gi.indexOf(GATE_BEGIN);
      const e = gi.indexOf(GATE_END);
      const expected = workspaceGitignoreEntries(manifest).sort();
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
        // A block written before the staging line existed still matches: the
        // next sync or add-repo writes the line.
        const current = actual.includes(WORKSPACE_STAGING_GITIGNORE)
          ? expected
          : expected.filter((line) => line !== WORKSPACE_STAGING_GITIGNORE);
        const inSync =
          actual.length === current.length && actual.every((v, i) => v === current[i]);
        results.push({
          pass: true,
          label: inSync
            ? `Workspace .gitignore: managed block matches repos.json (${manifestNames.length} repo dir(s))`
            : `Workspace .gitignore: managed block stale vs repos.json (advisory - run \`${syncCmd}\` to regenerate it)`,
        });
      }

      // W4 - This person's repos.local.json: what in it is not read. A file
      // that cannot be read leaves every path of theirs unused: a warning.
      const local = readWorkspaceRepos(projectDir);
      if (local.localError !== undefined) {
        results.push({
          pass: false,
          severity: "warn",
          label: `Your repos.local.json: ${local.localError.replace(/([^.!?])$/, "$1.")} Your own paths in it are not used until it reads. (advisory)`,
        });
      }
      if (local.ignored.length > 0) {
        results.push({
          pass: true,
          label: `Your repos.local.json: ${local.ignored.join(" ")} (advisory)`,
        });
      }
    }
  }

  return results;
}

const AUDIT_LOG_PATH = /\/audit\/[^/]+\.md$/;

// One entry per changed path; a rename or copy carries its old path in the
// next field, which is not a change of its own.
function porcelainChanges(bytes: Uint8Array): Array<{ status: string; path: string }> {
  const fields = new TextDecoder().decode(bytes).split("\0");
  const changes: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    changes.push({ status: field.slice(0, 2), path: field.slice(3) });
    if (field[0] === "R" || field[0] === "C") i++;
  }
  return changes;
}


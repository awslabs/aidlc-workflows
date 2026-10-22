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

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  discoverSiblingRepos,
  DOCTOR_RUN_AUDIT_EVENTS,
  errorMessage,
  isGitRepoDir,
  repoDir,
  REQUEST_TEXT_DIR,
} from "./aidlc-lib.ts";
import { committedRecordIgnoreConflicts } from "./aidlc-gitignore.ts";
import { workspaceSyncInvocation } from "./aidlc-runtime-paths.ts";
import {
  parseWorkspaceManifest,
  readWorkspaceRepos,
  type WorkspaceManifest,
  WORKSPACE_GITIGNORE_GATE_BEGIN as GATE_BEGIN,
  WORKSPACE_GITIGNORE_GATE_END as GATE_END,
  workspaceGitignoreEntries,
} from "./aidlc-workspace-manifest.ts";

/** One --doctor report row. Structurally matches collectDoctorReport's results[]. */
export interface DoctorCheck {
  pass: boolean;
  severity?: "warn";
  label: string;
  fix?: string;
}

/**
 * Workspace-manifest health rows for `/aidlc --doctor` (all advisory).
 *
 * W1, the request folder (W1c) and record visibility run in any git workspace; W2/W3 run only when a repos.json manifest is
 * present at the workspace root (the declared multi-repo signal). A single-repo
 * install or a bare test fixture has no repos.json, so W2/W3 skip silently and
 * no manifest-specific rows are added.
 */
export function workspaceManifestChecks(projectDir: string): DoctorCheck[] {
  const results: DoctorCheck[] = [];
  const syncCmd = workspaceSyncInvocation();

  // W1c first - Request files git can see: one committed before the folder
  // was ignored stays tracked, so each later request changes it in git, and a
  // project whose .gitignore part is older, or a later rule of the team's,
  // leaves the folder unignored. Doctor names the steps and never runs them;
  // while the row stands, W1 gives no commit command, since `git add aidlc/`
  // would take the request in.
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
  let requestRow: DoctorCheck | null = null;
  let requestBlocksCommit = false;
  try {
    const trackedProc = git(["ls-files", "-z", "--", REQUEST_TEXT_DIR]);
    const untrackedProc = git(["ls-files", "-z", "--others", "--exclude-standard", "--", REQUEST_TEXT_DIR]);
    // Taken out of git but not committed yet: teammates still get the file.
    const removedProc = git(["diff", "--cached", "--relative", "--no-renames", "--name-only", "-z", "--diff-filter=D", "--", REQUEST_TEXT_DIR]);
    // A conflicted file is listed once per stage.
    const tracked = trackedProc.exitCode === 0 ? entries(trackedProc.stdout) : [];
    const removedList = removedProc.exitCode === 0 ? entries(removedProc.stdout) : [];
    // A removed file still on disk and not ignored is counted once, as removed.
    const untracked = untrackedProc.exitCode === 0
      ? entries(untrackedProc.stdout).filter((path) => !removedList.includes(path)).length
      : 0;
    const removed = removedList.length;
    if (tracked.length + untracked + removed > 0) {
      // A file git shows as untracked is not ignored; every tracked or removed
      // one is tried against the ignore rules as if untracked.
      const tried = [...tracked, ...removedList];
      const ignoredProc = untracked > 0 || tried.length === 0
        ? null
        : git(["check-ignore", "--no-index", "--stdin", "-z"], `${tried.join("\0")}\0`);
      const ignored = ignoredProc !== null && entries(ignoredProc.stdout).length === tried.length;
      const held = [
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
            `add the line \`${REQUEST_TEXT_DIR}/\` to the project folder's .gitignore, ` +
            "and check no later rule of yours un-ignores it",
          ]),
        ...(tracked.length > 0
          ? [
            `in the project folder, take the tracked ones out of git, keeping the files: ` +
            `\`git rm --cached -r -f -- ${REQUEST_TEXT_DIR}/\``,
          ]
          : []),
        // The removal, and the ignore rule, reach teammates' clones only once
        // pushed; a refresh may have left the rule in .gitignore uncommitted.
        ...(tracked.length + removed > 0
          ? [ignored
            ? "commit and push the removal, with .gitignore if its change is not committed yet"
            : "commit and push the removal and the .gitignore change"]
          : ["commit and push the .gitignore change"]),
      ];
      // `git add aidlc/` would take a request in while git tracks one, shows
      // one, or holds a removed one the folder does not ignore; a staged
      // removal in an ignored folder leaves the records row its command.
      requestBlocksCommit = tracked.length + untracked > 0 || (removed > 0 && !ignored);
      requestRow = {
        pass: false,
        severity: "warn",
        label: `Request folder: files in ${REQUEST_TEXT_DIR}/ hold your own requests (${held.join(", ")})`,
        fix: steps.join(", then "),
      };
    }
  } catch (e) {
    requestRow = { pass: true, label: `Request folder: check skipped (advisory) - ${errorMessage(e)}` };
  }

  // W1 - Uncommitted records. Any git workspace: surface uncommitted changes
  // under aidlc/ so the shared records get committed and pushed to teammates.
  // Reports a passing row outside a git repo (smoke / fresh fixtures).
  // git status --porcelain omits gitignored per-user
  // cursors, so ignored runtime state (active-intent, runtime-graph.json, ...)
  // never false-positives. Every doctor run writes its own rows into this
  // clone's audit log, so a log changed only by those is not counted; else
  // the run before would make this row ask for a commit of doctor's receipt.
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
        // record; the request-folder row names it instead.
        `:(exclude)${REQUEST_TEXT_DIR}`,
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
        prefix ??= new TextDecoder().decode(git(["rev-parse", "--show-prefix"]).stdout).replace(/\r?\n$/, "");
        return !onlyDoctorRunRows(projectDir, prefix, change, git);
      });
      if (dirty.length === 0) {
        results.push({
          pass: true,
          label: changes.length === 0
            ? "Workspace records: no uncommitted changes under aidlc/"
            : "Workspace records: no uncommitted changes under aidlc/ other than doctor's own entries in the audit log",
        });
      } else {
        results.push({
          pass: false,
          severity: "warn",
          label:
            `Workspace records: ${dirty.length} uncommitted change(s) under aidlc/ (advisory - the shared records travel by git; ` +
            (requestBlocksCommit
              ? "commit & push them so teammates get them once the request folder steps below are done)"
              : "commit & push so teammates get them: `git add aidlc/ && git commit && git push`)"),
          ...(requestBlocksCommit ? { fix: "do the request folder steps below first; then this row names the commit" } : {}),
        });
      }
    }
  } catch (e) {
    results.push({ pass: true, label: `Workspace records: check skipped (advisory) - ${errorMessage(e)}` });
  }
  if (requestRow) results.push(requestRow);

  // W1b - A later user ignore rule can hide records even after config succeeded.
  for (const conflict of committedRecordIgnoreConflicts(projectDir)) {
    results.push({
      pass: false,
      severity: "warn",
      label: `Workspace record visibility: ${conflict} (advisory)`,
    });
  }

  // W2/W3 - only when a repos.json manifest is present (the declared multi-repo signal).
  const reposManifestPath = join(projectDir, "repos.json");
  if (existsSync(reposManifestPath)) {
    // Parse through the exact schema used by sync so doctor never reports a
    // manifest as synchronized when sync would reject it.
    let manifest: WorkspaceManifest | null = null;
    try {
      manifest = parseWorkspaceManifest(readFileSync(reposManifestPath, "utf-8"));
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
        const inSync =
          actual.length === expected.length && actual.every((v, i) => v === expected[i]);
        results.push({
          pass: true,
          label: inSync
            ? `Workspace .gitignore: managed block matches repos.json (${manifestNames.length} repo dir(s))`
            : `Workspace .gitignore: managed block stale vs repos.json (advisory - run \`${syncCmd}\` to regenerate it)`,
        });
      }

      // W4 - This person's repos.local.json: what in it is not read.
      const local = readWorkspaceRepos(projectDir);
      const localLines = [...(local.localError === undefined ? [] : [local.localError]), ...local.ignored];
      if (localLines.length > 0) {
        results.push({
          pass: true,
          label: `Your repos.local.json: ${localLines.join(" ")} (advisory)`,
        });
      }
    }
  }

  return results;
}

type GitRun = (args: string[]) => { exitCode: number | null; stdout: Uint8Array };

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

// Whether an audit log differs from its committed copy only by rows doctor
// wrote about its own runs. Only an unstaged change to a committed log or a
// log git does not track yet can be: anything staged or removed is the
// person's own git work. Line endings are compared as LF because a Windows
// checkout holds the committed part with CRLF while every append writes LF.
function onlyDoctorRunRows(
  projectDir: string,
  prefix: string,
  change: { status: string; path: string },
  git: GitRun,
): boolean {
  if ((change.status !== " M" && change.status !== "??") || !change.path.startsWith(prefix)) return false;
  try {
    const file = join(projectDir, ...change.path.slice(prefix.length).split("/"));
    if (!lstatSync(file).isFile()) return false;
    let committed = "";
    if (change.status === " M") {
      const blob = git(["cat-file", "blob", `HEAD:${change.path}`]);
      if (blob.exitCode !== 0) return false;
      committed = new TextDecoder().decode(blob.stdout).replaceAll("\r\n", "\n");
    }
    const now = readFileSync(file, "utf-8").replaceAll("\r\n", "\n");
    if (!now.startsWith(committed)) return false;
    const added = now.slice(committed.length).split("\n---\n").filter((block) => block.trim().length > 0);
    return added.length > 0 && added.every((block) => DOCTOR_RUN_AUDIT_EVENTS.has(auditBlockField(block, "Event") ?? ""));
  } catch {
    return false;
  }
}

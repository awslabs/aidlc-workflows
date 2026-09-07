// aidlc-workspace-sync.ts - reconcile a workspace against its optional
// repos.json manifest without deleting work that cannot be recovered.
//
// The framework already auto-discovers sibling code repos at runtime
// (discoverSiblingRepos), and that disk scan stays the source of truth: this
// tool does NOT change discovery. It adds a declared manifest so a team can
// clone the expected repo set on a fresh checkout, keep the managed .gitignore
// block current, and generate a VSCode multi-root workspace file. Manifest vs
// disk are reconciled here; disk wins at runtime.
//
// The full reconcile runs under a workspace lock that cannot be reaped while
// its owner is alive. Clones and generated files are staged under the workspace
// root, then installed with reversible renames and no-replace file links. Any
// apply error rolls those operations back before the command exits 1.
//
// --force authorizes orphan removal only after conservative preflight and
// immediate quarantine safety checks. Cached refs/remotes/* and advertised OIDs
// alone never prove recoverability: matching object graphs must be fetched into
// an isolated probe before removal.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  discoverSiblingRepos,
  resolveProjectDir,
  withAuditLock,
} from "./aidlc-lib.ts";
import {
  parseWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRepoEntry,
  WORKSPACE_GITIGNORE_GATE_BEGIN as GATE_BEGIN,
  WORKSPACE_GITIGNORE_GATE_END as GATE_END,
  WORKSPACE_RECOVERY_GITIGNORE,
  workspaceRepoPath,
} from "./aidlc-workspace-manifest.ts";

const COLOR =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = (code: string, value: string) =>
  COLOR ? `\x1b[${code}m${value}\x1b[0m` : value;
const green = (value: string) => c("32", value);
const yellow = (value: string) => c("33", value);
const red = (value: string) => c("31", value);
const dim = (value: string) => c("2", value);

const GITIGNORE_HEADER = [
  "# Child code repos are cloned in as siblings, each with its own git + origin.",
  "# The workspace tracks only the AI-DLC records under aidlc/, not the child source.",
];
const CODE_WORKSPACE_NAME = "aidlc.code-workspace";

class SyncFailure extends Error {}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ReconcilePlan {
  toClone: WorkspaceRepoEntry[];
  toKeep: WorkspaceRepoEntry[];
  toRemove: string[];
  branchWarnings: string[];
}

interface Move {
  from: string;
  to: string;
}

interface FileSnapshot {
  exists: boolean;
  content: string;
}

interface ManifestSnapshot {
  manifest: WorkspaceManifest;
  raw: string;
}

interface RemoteObjectCandidate {
  remote: string;
  ref: string;
}

interface RemoteObjectProof {
  label: string;
  oid: string;
  candidates: RemoteObjectCandidate[];
}

function git(dir: string, args: string[], input?: string): GitResult {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf-8",
    ...(input === undefined ? {} : { input }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readManifest(path: string): ManifestSnapshot {
  if (!existsSync(path)) {
    throw new SyncFailure(
      `no repos.json at ${path}. The manifest is optional; create one at the ` +
        `workspace root declaring "org" and a "repos" array to enable clone/sync ` +
        `(see the User Guide: "Declared workspace manifest"), then re-run.`,
    );
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return { manifest: parseWorkspaceManifest(raw), raw };
  } catch (err) {
    throw new SyncFailure((err as Error).message);
  }
}

function currentBranch(dir: string): string {
  const result = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (result.status !== 0) return "(unknown)";
  return result.stdout.trim() || "(unknown)";
}

function detectDefaultBranch(dir: string): string | null {
  const result = git(dir, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^origin\//, "") || null;
}

function cloneUrl(manifest: WorkspaceManifest, repo: WorkspaceRepoEntry): string {
  return repo.url ?? `git@github.com:${manifest.org}/${repo.name}.git`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function directoryHasContent(root: string): boolean {
  if (!existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(join(dir, entry.name));
      } else {
        return true;
      }
    }
  }
  return false;
}

function gitCommonDir(dir: string): string | null {
  const result = git(dir, ["rev-parse", "--git-common-dir"]);
  if (result.status !== 0 || result.stdout.trim().length === 0) return null;
  return resolve(dir, result.stdout.trim());
}

function worktreeSafetyReasons(dir: string): string[] {
  const reasons: string[] = [];
  const status = git(dir, [
    "-c",
    "status.showUntrackedFiles=all",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (status.status !== 0) {
    reasons.push("working tree state could not be verified");
  } else {
    const rows = status.stdout.split("\n").filter((row) => row.length > 0);
    if (rows.some((row) => row.startsWith("!!"))) reasons.push("ignored files");
    if (rows.some((row) => !row.startsWith("!!"))) reasons.push("dirty working tree");

    // Git status never reports empty untracked directories. A dry-run clean
    // supplies the complementary filesystem view without changing anything.
    const untracked = git(dir, ["clean", "--dry-run", "-d", "-x"]);
    if (untracked.status !== 0) {
      reasons.push("untracked filesystem entries could not be verified");
    } else if (rows.length === 0 && untracked.stdout.trim().length > 0) {
      reasons.push("untracked filesystem entries (including empty directories)");
    }
  }

  const stash = git(dir, ["stash", "list"]);
  if (stash.status !== 0) {
    reasons.push("stash state could not be verified");
  } else if (stash.stdout.trim().length > 0) {
    reasons.push("stashed changes");
  }

  const indexFlags = git(dir, ["ls-files", "-v"]);
  if (indexFlags.status !== 0) {
    reasons.push("index visibility flags could not be verified");
  } else if (/^(?:[a-z]|S) /m.test(indexFlags.stdout)) {
    reasons.push("assume-unchanged or skip-worktree files");
  }
  return reasons;
}

function localRemotePath(baseDir: string, url: string): string | null | undefined {
  if (/^file:/i.test(url)) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) ||
    (/^[^/\\]+:/.test(url) && !/^[A-Za-z]:[\\/]/.test(url))
  ) {
    return undefined;
  }
  if (url.startsWith("~")) return null;
  return resolve(baseDir, url);
}

function pathIsWithin(root: string, candidate: string): boolean | null {
  try {
    const child = relative(realpathSync(root), realpathSync(candidate));
    return (
      child === "" ||
      (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
    );
  } catch {
    return null;
  }
}

function localRemoteAlternateReasons(
  checkoutDir: string,
  remote: string,
  remoteDir: string,
): string[] {
  const objectPath = git(remoteDir, ["rev-parse", "--git-path", "objects"]);
  if (objectPath.status !== 0 || objectPath.stdout.trim().length === 0) {
    return [`remote '${remote}' object storage could not be verified`];
  }

  const pending = [resolve(remoteDir, objectPath.stdout.trim())];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const objectDir = pending.pop();
    if (!objectDir) continue;

    let canonical: string;
    try {
      canonical = realpathSync(objectDir);
    } catch {
      return [`remote '${remote}' object storage could not be verified`];
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const contained = pathIsWithin(checkoutDir, canonical);
    if (contained === null) {
      return [`remote '${remote}' object storage could not be verified`];
    }
    if (contained) {
      return [
        `remote '${remote}' object alternates depend on recovery data inside the checkout`,
      ];
    }

    const alternatesPath = join(canonical, "info", "alternates");
    if (!existsSync(alternatesPath)) continue;
    let alternates: string[];
    try {
      alternates = readFileSync(alternatesPath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [`remote '${remote}' object alternates could not be verified`];
    }

    for (const entry of alternates) {
      let alternate = entry;
      if (entry.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(entry);
          if (typeof parsed !== "string") throw new Error("not a string");
          alternate = parsed;
        } catch {
          return [`remote '${remote}' object alternates could not be verified`];
        }
      }
      pending.push(resolve(canonical, alternate));
    }
  }
  return [];
}

function remoteStorageReasons(
  dir: string,
  remote: string,
  remoteUrlBaseDir: string,
): string[] {
  const urls = git(dir, ["remote", "get-url", "--all", remote]);
  if (urls.status !== 0 || urls.stdout.trim().length === 0) {
    return [`remote '${remote}' storage location could not be verified`];
  }
  for (const url of urls.stdout.split("\n").filter((value) => value.length > 0)) {
    const candidate = localRemotePath(remoteUrlBaseDir, url);
    if (candidate === undefined) continue;
    if (candidate === null) {
      return [`remote '${remote}' local storage location could not be verified`];
    }
    const contained = pathIsWithin(dir, candidate);
    if (contained === null) {
      return [`remote '${remote}' local storage location could not be verified`];
    }
    if (contained) {
      return [`remote '${remote}' stores recovery data inside the checkout`];
    }
    const alternateReasons = localRemoteAlternateReasons(dir, remote, candidate);
    if (alternateReasons.length > 0) return alternateReasons;
  }
  return [];
}

function verifyRemoteObjectProofs(
  dir: string,
  proofs: RemoteObjectProof[],
  remoteUrlBaseDir: string,
): string[] {
  if (proofs.length === 0) return [];

  const probeRoot = mkdtempSync(join(tmpdir(), "aidlc-workspace-sync-proof-"));
  const probes = new Map<string, { dir: string; nextRef: number }>();
  const reasons: string[] = [];

  try {
    const probeFor = (
      remote: string,
    ): { dir: string; nextRef: number } | null => {
      const existing = probes.get(remote);
      if (existing) return existing;

      const url = git(dir, ["remote", "get-url", remote]);
      if (url.status !== 0 || url.stdout.trim().length === 0) return null;
      const configuredUrl = url.stdout.trim();
      const localPath = localRemotePath(remoteUrlBaseDir, configuredUrl);
      if (localPath === null) return null;
      const probeUrl = localPath ?? configuredUrl;

      const probeDir = join(probeRoot, `remote-${probes.size}.git`);
      const initialized = git(probeRoot, ["init", "--quiet", "--bare", probeDir]);
      if (initialized.status !== 0) return null;
      const added = git(probeDir, [
        "remote",
        "add",
        "source",
        probeUrl,
      ]);
      if (added.status !== 0) return null;

      const probe = { dir: probeDir, nextRef: 0 };
      probes.set(remote, probe);
      return probe;
    };

    const verifiedObjects = new Set<string>();
    for (const proof of proofs) {
      const oid = proof.oid.toLowerCase();
      if (verifiedObjects.has(oid)) continue;

      let verified = false;
      for (const candidate of proof.candidates) {
        const probe = probeFor(candidate.remote);
        if (!probe) continue;

        const sourceRef = candidate.ref.replace(/\^\{\}$/, "");
        const destinationRef = `refs/aidlc-proof/object-${probe.nextRef++}`;
        const fetched = git(probe.dir, [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "source",
          `+${sourceRef}:${destinationRef}`,
        ]);
        if (fetched.status !== 0) continue;

        const object = git(probe.dir, ["cat-file", "-e", `${oid}^{object}`]);
        if (object.status === 0) {
          verified = true;
          verifiedObjects.add(oid);
          break;
        }
      }

      if (!verified) {
        reasons.push(
          `live remotes advertised ${proof.label}, but its object graph could not be fetched`,
        );
      }
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  return reasons;
}

function remoteRecoveryReasons(
  dir: string,
  remoteUrlBaseDir: string,
): string[] {
  const remotesResult = git(dir, ["remote"]);
  if (remotesResult.status !== 0) return ["remote refs could not be verified"];
  const remotes = remotesResult.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (remotes.length === 0) return ["no remote can recover the checkout"];

  const remoteRefs = new Map<string, Map<string, Set<string>>>();
  const remoteObjects = new Map<string, RemoteObjectCandidate[]>();
  for (const remote of remotes) {
    const storageReasons = remoteStorageReasons(dir, remote, remoteUrlBaseDir);
    if (storageReasons.length > 0) return storageReasons;
    const url = git(dir, ["remote", "get-url", remote]);
    if (url.status !== 0 || url.stdout.trim().length === 0) {
      return [`remote '${remote}' could not be queried`];
    }
    const configuredUrl = url.stdout.trim();
    const localPath = localRemotePath(remoteUrlBaseDir, configuredUrl);
    if (localPath === null) {
      return [`remote '${remote}' local storage location could not be verified`];
    }
    const result = git(dir, ["ls-remote", localPath ?? configuredUrl]);
    if (result.status !== 0) return [`remote '${remote}' could not be queried`];
    const refs = new Map<string, Set<string>>();
    for (const row of result.stdout.split("\n")) {
      const match = row.match(/^([0-9a-fA-F]+)\s+(.+)$/);
      if (!match) continue;
      const oid = match[1].toLowerCase();
      const ref = match[2];
      const objects = refs.get(ref) ?? new Set<string>();
      objects.add(oid);
      refs.set(ref, objects);
      const candidates = remoteObjects.get(oid) ?? [];
      candidates.push({ remote, ref });
      remoteObjects.set(oid, candidates);
    }
    remoteRefs.set(remote, refs);
  }

  const refsResult = git(dir, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
  ]);
  if (refsResult.status !== 0) return ["local refs could not be verified"];

  const unmatchedRefs: string[] = [];
  const localRoots: string[] = [];
  const proofs: RemoteObjectProof[] = [];
  for (const row of refsResult.stdout.split("\n")) {
    if (!row) continue;
    const [ref, oid] = row.split("\t");
    if (!ref || !oid || ref === "refs/stash") {
      continue;
    }

    if (ref.startsWith("refs/remotes/")) {
      const remote = [...remotes]
        .sort((a, b) => b.length - a.length)
        .find((name) => ref.startsWith(`refs/remotes/${name}/`));
      const branch = remote
        ? ref.slice(`refs/remotes/${remote}/`.length)
        : "";
      if (!remote || branch.length === 0 || branch === "HEAD") continue;

      const sourceRef = `refs/heads/${branch}`;
      if (remoteRefs.get(remote)?.has(sourceRef)) {
        proofs.push({
          label: ref,
          oid,
          candidates: [{ remote, ref: sourceRef }],
        });
      } else {
        unmatchedRefs.push(ref);
      }
      continue;
    }

    localRoots.push(oid);
    const candidates = remotes
      .filter((remote) => remoteRefs.get(remote)?.has(ref))
      .map((remote) => ({ remote, ref }));
    if (candidates.length === 0) {
      unmatchedRefs.push(ref);
    } else {
      proofs.push({ label: ref, oid, candidates });
    }
  }

  const head = git(dir, ["rev-parse", "HEAD"]);
  const headOid = head.stdout.trim();
  const headCandidates = remoteObjects.get(headOid.toLowerCase()) ?? [];
  if (head.status !== 0 || headCandidates.length === 0) {
    unmatchedRefs.push("HEAD");
  } else {
    proofs.push({ label: "HEAD", oid: headOid, candidates: headCandidates });
  }

  const reasons: string[] = [];
  if (unmatchedRefs.length > 0) {
    reasons.push(
      `unpushed commits or local refs absent from live remotes (${unique(unmatchedRefs).join(", ")})`,
    );
  }
  if (head.status === 0) localRoots.push(headOid);
  const reflogOnly = git(dir, [
    "rev-list",
    "--reflog",
    "--not",
    ...unique(localRoots),
  ]);
  if (reflogOnly.status !== 0) {
    reasons.push("reflog-only commits could not be verified");
  } else if (reflogOnly.stdout.trim().length > 0) {
    reasons.push("reflog-only commits");
  }
  reasons.push(...verifyRemoteObjectProofs(dir, proofs, remoteUrlBaseDir));
  return reasons;
}

function localObjectSafetyReasons(dir: string): string[] {
  const result = git(dir, [
    "fsck",
    "--full",
    "--unreachable",
    "--no-reflogs",
    "--no-progress",
  ]);
  if (result.status !== 0) return ["local Git object reachability could not be verified"];
  if (/^(?:dangling|unreachable) /m.test(`${result.stdout}\n${result.stderr}`)) {
    return ["unreachable local Git objects"];
  }
  return [];
}

function repositoryShapeReasons(dir: string): string[] {
  const reasons: string[] = [];
  try {
    if (lstatSync(dir).isSymbolicLink()) reasons.push("symbolic-link checkout");
    if (!lstatSync(join(dir, ".git")).isDirectory()) {
      reasons.push("linked worktree or submodule checkout");
    }
  } catch {
    reasons.push("checkout shape could not be verified");
  }

  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  try {
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(dir)) {
      reasons.push("checkout root could not be verified");
    }
  } catch {
    reasons.push("checkout root could not be verified");
  }

  const worktrees = git(dir, ["worktree", "list", "--porcelain"]);
  if (worktrees.status !== 0) {
    reasons.push("linked worktrees could not be verified");
  } else {
    const paths = worktrees.stdout
      .split("\n")
      .filter((row) => row.startsWith("worktree "))
      .map((row) => row.slice("worktree ".length));
    let onlyThisCheckout = paths.length === 1;
    if (onlyThisCheckout) {
      try {
        onlyThisCheckout = realpathSync(paths[0]) === realpathSync(dir);
      } catch {
        onlyThisCheckout = false;
      }
    }
    if (!onlyThisCheckout) reasons.push("secondary linked worktrees");
  }

  const tracked = git(dir, ["ls-files", "--stage"]);
  if (tracked.status !== 0) {
    reasons.push("submodule state could not be verified");
  } else if (tracked.stdout.split("\n").some((row) => row.startsWith("160000 "))) {
    reasons.push("submodule repositories");
  }
  const commonDir = gitCommonDir(dir);
  if (commonDir === null) {
    reasons.push("local Git object stores could not be verified");
  } else if (directoryHasContent(join(commonDir, "modules"))) {
    reasons.push("submodule repositories");
  }
  return reasons;
}

function lfsSafetyReasons(dir: string): string[] {
  const commonDir = gitCommonDir(dir);
  if (commonDir === null) return ["Git LFS object storage could not be verified"];
  if (directoryHasContent(join(commonDir, "lfs", "objects"))) {
    return ["local Git LFS objects"];
  }

  const files = git(dir, ["ls-files", "-z"]);
  if (files.status !== 0) return ["Git LFS attributes could not be verified"];
  if (files.stdout.length === 0) return [];
  const attributes = git(dir, ["check-attr", "-z", "--stdin", "filter"], files.stdout);
  if (attributes.status !== 0) return ["Git LFS attributes could not be verified"];
  const fields = attributes.stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 1] === "filter" && fields[i + 2] === "lfs") {
      return ["Git LFS-managed files"];
    }
  }
  return [];
}

function orphanLocalSafetyReasons(dir: string): string[] {
  return unique([
    ...worktreeSafetyReasons(dir),
    ...repositoryShapeReasons(dir),
    ...lfsSafetyReasons(dir),
    ...localObjectSafetyReasons(dir),
  ]);
}

function orphanSafetyReasons(
  dir: string,
  remoteUrlBaseDir = dir,
): string[] {
  return unique([
    ...orphanLocalSafetyReasons(dir),
    ...remoteRecoveryReasons(dir, remoteUrlBaseDir),
  ]);
}

function renderGitignore(
  existing: string,
  manifest: WorkspaceManifest,
): string {
  const entries = [
    WORKSPACE_RECOVERY_GITIGNORE,
    ...manifest.repos.map((repo) => `/${repo.name}/`),
  ];
  const block = [GATE_BEGIN, ...entries, GATE_END].join("\n");
  const begin = existing.indexOf(GATE_BEGIN);
  const end = existing.indexOf(GATE_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return `${existing.slice(0, begin)}${block}${existing.slice(end + GATE_END.length)}`;
  }
  const prefix =
    existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const separator = existing.length === 0 ? "" : "\n";
  return `${prefix}${separator}${GITIGNORE_HEADER.join("\n")}\n${block}\n`;
}

function renderCodeWorkspace(manifest: WorkspaceManifest): string {
  const folders = [
    { path: "." },
    ...manifest.repos.map((repo) => ({ path: repo.name })),
  ];
  return `${JSON.stringify({ folders }, null, 2)}\n`;
}

function validateOutputPath(path: string): void {
  try {
    if (!lstatSync(path).isFile()) {
      throw new SyncFailure(`${path} exists but is not a regular file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function snapshotOutput(path: string): FileSnapshot {
  validateOutputPath(path);
  if (!pathEntryExists(path)) return { exists: false, content: "" };
  return { exists: true, content: readFileSync(path, "utf-8") };
}

function assertOutputUnchanged(path: string, snapshot: FileSnapshot): void {
  validateOutputPath(path);
  const exists = pathEntryExists(path);
  if (
    exists !== snapshot.exists ||
    (exists && readFileSync(path, "utf-8") !== snapshot.content)
  ) {
    throw new SyncFailure(
      `${path} changed while workspace-sync was staging; no generated files were replaced`,
    );
  }
}

function assertManifestUnchanged(path: string, raw: string): void {
  let current: string;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    throw new SyncFailure(
      `${path} changed while workspace-sync was staging; the stale plan was not applied`,
    );
  }
  if (current !== raw) {
    throw new SyncFailure(
      `${path} changed while workspace-sync was staging; the stale plan was not applied`,
    );
  }
}

function parseFlags(argv: string[]): { force: boolean; projectDir?: string } {
  let force = false;
  let projectDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--project-dir") {
      projectDir = argv[++i];
    } else if (arg.startsWith("--project-dir=")) {
      projectDir = arg.slice("--project-dir=".length);
    }
  }
  return { force, projectDir };
}

function preflight(
  root: string,
  manifest: WorkspaceManifest,
  force: boolean,
): ReconcilePlan | null {
  const manifestNames = new Set(manifest.repos.map((repo) => repo.name));
  const toClone: WorkspaceRepoEntry[] = [];
  const toKeep: WorkspaceRepoEntry[] = [];
  const toRemove: string[] = [];
  const broken: string[] = [];
  const unsafe: string[] = [];
  const needForce: string[] = [];
  const branchWarnings: string[] = [];

  for (const repo of manifest.repos) {
    const dir = workspaceRepoPath(root, repo.name);
    if (!pathEntryExists(dir)) {
      toClone.push(repo);
      continue;
    }
    let isSymlink = false;
    try {
      isSymlink = lstatSync(dir).isSymbolicLink();
    } catch {
      // The following .git check reports the unstable path as broken.
    }
    if (isSymlink || !existsSync(join(dir, ".git"))) {
      broken.push(
        `${repo.name} exists on disk but is not a git checkout at a direct child path. ` +
          `Remove or fix ${dir}, then re-run.`,
      );
      continue;
    }
    toKeep.push(repo);
    const branch = currentBranch(dir);
    if (branch !== "(unknown)") {
      const expected = repo.branch ?? detectDefaultBranch(dir);
      if (expected && branch !== expected) {
        const source = repo.branch ? "repos.json" : "origin default";
        branchWarnings.push(
          `${repo.name} is on '${branch}' but ${source} is '${expected}'`,
        );
      }
    }
  }

  for (const name of discoverSiblingRepos(root)) {
    if (manifestNames.has(name)) continue;
    const dir = workspaceRepoPath(root, name);
    const reasons = orphanSafetyReasons(dir);
    if (reasons.length > 0) {
      unsafe.push(
        `${name} is an orphan (not in repos.json) with ${reasons.join(", ")}. ` +
          `Preserve or remove ${dir} manually.`,
      );
    } else if (force) {
      toRemove.push(name);
    } else {
      needForce.push(
        `${name} is a recoverable orphan (not in repos.json) - re-run with --force to remove.`,
      );
    }
  }

  if (broken.length + unsafe.length + needForce.length > 0) {
    console.error(red("\n✗ workspace-sync blocked - no changes made:\n"));
    for (const message of broken) console.error(red(`  [broken]     ${message}`));
    for (const message of unsafe) console.error(red(`  [unsafe]     ${message}`));
    for (const message of needForce) {
      console.error(red(`  [need-force] ${message}`));
    }
    if (branchWarnings.length > 0) {
      console.error("\n  Branch warnings (advisory):");
      for (const warning of branchWarnings) {
        console.error(yellow(`  ⚠ ${warning}`));
      }
    }
    return null;
  }
  return { toClone, toKeep, toRemove, branchWarnings };
}

function move(from: string, to: string, moves: Move[]): void {
  renameSync(from, to);
  moves.push({ from, to });
}

function rollbackMoves(moves: Move[]): string[] {
  const failures: string[] = [];
  for (const operation of [...moves].reverse()) {
    if (!pathEntryExists(operation.to)) {
      failures.push(`${operation.to} is missing; cannot restore ${operation.from}`);
      continue;
    }
    if (pathEntryExists(operation.from)) {
      failures.push(`${operation.from} is occupied; recovery data remains at ${operation.to}`);
      continue;
    }
    try {
      renameSync(operation.to, operation.from);
    } catch (err) {
      failures.push(
        `${operation.to} -> ${operation.from}: ${(err as Error).message}`,
      );
    }
  }
  return failures;
}

function installStagedFile(from: string, to: string, moves: Move[]): void {
  let linked = false;
  try {
    // link() is an atomic no-replace install on the same filesystem. Unlike
    // rename(), it fails with EEXIST if a concurrent writer recreated `to`.
    linkSync(from, to);
    linked = true;
    unlinkSync(from);
    moves.push({ from, to });
  } catch (err) {
    if (linked) {
      try {
        unlinkSync(to);
      } catch {
        // The transaction error below retains every source/backup it can.
      }
    }
    throw err;
  }
}

function cloneIntoStage(
  root: string,
  stageDir: string,
  manifest: WorkspaceManifest,
  repos: WorkspaceRepoEntry[],
): void {
  for (const repo of repos) {
    const destination = join(stageDir, repo.name);
    const url = cloneUrl(manifest, repo);
    console.log(
      `  staging clone ${repo.name} from ${url}` +
        (repo.branch ? ` (branch ${repo.branch})` : "") +
        " ...",
    );
    const args = ["clone"];
    if (repo.branch) args.push("--branch", repo.branch);
    args.push("--", url, destination);
    const result = git(root, args);
    if (result.status !== 0) {
      throw new SyncFailure(
        `git clone failed for ${repo.name} (exit ${result.status}): ` +
          (result.stderr.trim() || "check the clone URL and credentials"),
      );
    }
    if (repo.branch && currentBranch(destination) !== repo.branch) {
      throw new SyncFailure(
        `staged clone ${repo.name} did not check out declared branch '${repo.branch}'`,
      );
    }
  }
}

function applyPlan(
  root: string,
  manifest: WorkspaceManifest,
  manifestPath: string,
  manifestRaw: string,
  plan: ReconcilePlan,
): void {
  const liveGitignore = join(root, ".gitignore");
  const liveCodeWorkspace = join(root, CODE_WORKSPACE_NAME);
  const gitignoreBefore = snapshotOutput(liveGitignore);
  const codeWorkspaceBefore = snapshotOutput(liveCodeWorkspace);
  const gitignore = renderGitignore(gitignoreBefore.content, manifest);
  const codeWorkspace = renderCodeWorkspace(manifest);
  const transactionDir = mkdtempSync(join(root, ".aidlc-workspace-sync-txn-"));
  const clonesDir = join(transactionDir, "clones");
  const generatedDir = join(transactionDir, "generated");
  const backupsDir = join(transactionDir, "backups");
  const orphansDir = join(transactionDir, "orphans");

  const stagedGitignore = join(generatedDir, "gitignore");
  const stagedCodeWorkspace = join(generatedDir, CODE_WORKSPACE_NAME);
  const moves: Move[] = [];
  const recoveryDir = join(
    root,
    basename(transactionDir).replace(
      ".aidlc-workspace-sync-txn-",
      ".aidlc-workspace-sync-recovery-",
    ),
  );
  let retainedRecovery = false;
  let recoveryDirCreated = false;
  let committed = false;
  let cleanupTransaction = true;
  try {
    for (const dir of [clonesDir, generatedDir, backupsDir, orphansDir]) {
      mkdirSync(dir);
    }
    writeFileSync(stagedGitignore, gitignore, "utf-8");
    writeFileSync(stagedCodeWorkspace, codeWorkspace, "utf-8");
    cloneIntoStage(root, clonesDir, manifest, plan.toClone);

    for (const repo of plan.toClone) {
      if (pathEntryExists(workspaceRepoPath(root, repo.name))) {
        throw new SyncFailure(
          `${repo.name} appeared while sync was staging; no changes were applied`,
        );
      }
    }
    assertManifestUnchanged(manifestPath, manifestRaw);
    assertOutputUnchanged(liveGitignore, gitignoreBefore);
    assertOutputUnchanged(liveCodeWorkspace, codeWorkspaceBefore);

    // Slow clones happen before this second proof. Move each orphan immediately
    // after remote revalidation, then repeat the full local + remote proof from
    // quarantine. Relative remote URLs still resolve from the original checkout
    // path. Path-based writers cannot modify the moved tree; writers holding an
    // open directory handle are caught by the quarantined-tree proof.
    for (const name of plan.toRemove) {
      const source = workspaceRepoPath(root, name);
      const reasons = orphanSafetyReasons(source);
      if (reasons.length > 0) {
        throw new SyncFailure(
          `${name} changed after preflight (${reasons.join(", ")}); no changes were applied`,
        );
      }
      const quarantined = join(orphansDir, name);
      move(source, quarantined, moves);
      const quarantinedReasons = orphanSafetyReasons(quarantined, source);
      if (pathEntryExists(source)) {
        quarantinedReasons.push("checkout path reappeared during quarantine");
      }
      if (quarantinedReasons.length > 0) {
        throw new SyncFailure(
          `${name} changed during quarantine (${unique(quarantinedReasons).join(", ")}); no changes were applied`,
        );
      }
    }

    assertManifestUnchanged(manifestPath, manifestRaw);
    assertOutputUnchanged(liveGitignore, gitignoreBefore);
    assertOutputUnchanged(liveCodeWorkspace, codeWorkspaceBefore);
    const replaceGitignore =
      !gitignoreBefore.exists || gitignoreBefore.content !== gitignore;
    const replaceCodeWorkspace =
      !codeWorkspaceBefore.exists || codeWorkspaceBefore.content !== codeWorkspace;
    if (replaceGitignore && gitignoreBefore.exists) {
      move(liveGitignore, join(backupsDir, "gitignore"), moves);
      if (readFileSync(join(backupsDir, "gitignore"), "utf-8") !== gitignoreBefore.content) {
        throw new SyncFailure(
          `${liveGitignore} changed while workspace-sync was staging; no generated files were replaced`,
        );
      }
    }
    if (replaceCodeWorkspace && codeWorkspaceBefore.exists) {
      move(liveCodeWorkspace, join(backupsDir, CODE_WORKSPACE_NAME), moves);
      if (
        readFileSync(join(backupsDir, CODE_WORKSPACE_NAME), "utf-8") !==
        codeWorkspaceBefore.content
      ) {
        throw new SyncFailure(
          `${liveCodeWorkspace} changed while workspace-sync was staging; no generated files were replaced`,
        );
      }
    }
    for (const repo of plan.toClone) {
      move(
        join(clonesDir, repo.name),
        workspaceRepoPath(root, repo.name),
        moves,
      );
    }
    if (replaceGitignore) {
      installStagedFile(stagedGitignore, liveGitignore, moves);
    }
    if (replaceCodeWorkspace) {
      installStagedFile(stagedCodeWorkspace, liveCodeWorkspace, moves);
    }

    if (
      plan.toRemove.length > 0 ||
      directoryHasContent(backupsDir)
    ) {
      mkdirSync(recoveryDir);
      recoveryDirCreated = true;
      for (const name of plan.toRemove) {
        move(join(orphansDir, name), join(recoveryDir, name), moves);
      }
      if (directoryHasContent(backupsDir)) {
        move(
          backupsDir,
          join(recoveryDir, "generated-file-backups"),
          moves,
        );
      }
      retainedRecovery = true;
    }
    committed = true;
  } catch (err) {
    const rollbackFailures = rollbackMoves(moves);
    if (rollbackFailures.length > 0) {
      cleanupTransaction = false;
      throw new SyncFailure(
        `${(err as Error).message}. Rollback was incomplete; recovery data remains at ` +
          `${transactionDir}: ${rollbackFailures.join("; ")}`,
      );
    }
    if (recoveryDirCreated && pathEntryExists(recoveryDir)) {
      try {
        rmSync(recoveryDir, { recursive: true, force: true });
      } catch {
        cleanupTransaction = false;
      }
    }
    throw err;
  } finally {
    if (cleanupTransaction) {
      try {
        rmSync(transactionDir, { recursive: true, force: true });
      } catch (err) {
        if (committed) {
          console.error(
            yellow(
              `  ⚠ committed successfully but could not remove transaction debris at ${transactionDir}: ${(err as Error).message}`,
            ),
          );
        }
      }
    }
  }

  for (const repo of plan.toKeep) {
    console.log(`  ${green("✓")} ${repo.name} already on disk - leaving untouched`);
  }
  for (const repo of plan.toClone) {
    console.log(
      `  ${green("✓")} cloned ${repo.name}` +
        (repo.branch ? ` on '${repo.branch}'` : ""),
    );
  }
  for (const name of plan.toRemove) {
    console.log(
      `  ${green("✓")} removed ${name} from the active workspace; recovery retained at ` +
        `${join(recoveryDir, name)}`,
    );
  }
  if (retainedRecovery && directoryHasContent(join(recoveryDir, "generated-file-backups"))) {
    console.log(
      `  ${green("✓")} prior generated files retained at ` +
        `${join(recoveryDir, "generated-file-backups")}`,
    );
  }
  console.log(
    `  ${green("✓")} .gitignore managed block → ${manifest.repos.length} child dir(s)`,
  );
  console.log(
    `  ${green("✓")} ${CODE_WORKSPACE_NAME} → ${manifest.repos.length} child root(s)`,
  );
}

function reconcile(root: string, force: boolean): number {
  const manifestPath = join(root, "repos.json");
  const { manifest, raw: manifestRaw } = readManifest(manifestPath);
  console.log(
    dim(
      `aidlc workspace-sync: reconciling ${root} against repos.json (${manifest.repos.length} repo(s))` +
        (force ? " [--force]" : ""),
    ),
  );
  const plan = preflight(root, manifest, force);
  if (!plan) return 1;
  applyPlan(root, manifest, manifestPath, manifestRaw, plan);
  for (const warning of plan.branchWarnings) {
    console.log(yellow(`  ⚠ ${warning}`));
  }
  if (plan.branchWarnings.length === 0) {
    console.log(green("✓ workspace in sync"));
    return 0;
  }
  console.log(
    yellow(
      `⚠ workspace synced, but NOT fully in sync - ${plan.branchWarnings.length} warning(s) above`,
    ),
  );
  return 2;
}

export function main(argv: string[]): void {
  const { force, projectDir } = parseFlags(argv);
  const root = resolveProjectDir(projectDir);
  let exitCode = 1;
  try {
    exitCode = withAuditLock(
      root,
      () => reconcile(root, force),
      undefined,
      undefined,
      50,
      100,
      false,
    );
  } catch (err) {
    console.error(red(`✗ ${(err as Error).message}`));
  }
  process.exit(exitCode);
}

if (import.meta.main) main(process.argv.slice(2));

// aidlc-upgrade.ts — the AI-DLC install upgrader.
//
// ONE entry point:
//   • upgrade(projectDir, { dryRun }) — figures out the target harness dir,
//     reads that install's aidlc-version.ts (NOT the imported constant — the
//     tool binary may live elsewhere), fetches the newest upstream tag in the
//     same major series, and either dry-runs the diff or applies the upgrade.
//     PRESERVES any file whose local bytes differ from the incoming upstream
//     file (user modification). No backup dir is created — users who want a
//     snapshot should commit their harness dir (or copy it) themselves before
//     running upgrade. Standard Unix "trust your VCS" default.
//
// WHY tags, not GitHub Releases: this repo cuts v2 as tags on the v2 branch
// (v2.1.7, v2.2.0, ...) but the "latest release" API answers the v1.x line.
// Tags in the installed major series are the honest answer to "what should I
// upgrade to today."
//
// WHY read the target's aidlc-version.ts, not the imported AIDLC_VERSION: the
// import binds this file's version at build time. That's correct if a user
// runs the tool from inside their install (the tool IS the install). It is
// wrong if the tool binary lives elsewhere (a scenario surfaced during live
// testing). Reading the target's aidlc-version.ts makes the command answer
// for the install, not for itself.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { AIDLC_VERSION } from "./aidlc-version.ts";

const UPSTREAM_OWNER = "awslabs";
const UPSTREAM_REPO = "aidlc-workflows";
const TAGS_URL = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tags?per_page=100`;
const RELEASE_NOTES_BASE = `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/tag`;

const HARNESSES: ReadonlyArray<{ dir: string; distSubpath: string; label: string }> = [
  { dir: ".claude", distSubpath: "dist/claude/.claude", label: "Claude Code" },
  { dir: ".kiro", distSubpath: "dist/kiro/.kiro", label: "Kiro / Kiro IDE" },
  { dir: ".codex", distSubpath: "dist/codex/.codex", label: "Codex" },
];

export interface UpgradeOptions {
  dryRun?: boolean;
  harnessOverride?: string;
  // Injected in tests. Real callers leave these unset.
  fetchTagsFn?: () => Promise<string[]>;
  downloadTarballFn?: (tag: string, destDir: string) => Promise<string>;
  installedVersionOverride?: string;
}

// -----------------------------------------------------------------------------
// Version + tag helpers
// -----------------------------------------------------------------------------

function parseSemver(tag: string): [number, number, number] | null {
  // Accept "v2.2.10" and "2.2.10". Reject pre-releases (v2.2.10-rc1).
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function defaultFetchTags(): Promise<string[]> {
  const res = await fetch(TAGS_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API returned ${res.status} fetching tags. Try again in a minute, or download the release manually from https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases`
    );
  }
  const list = (await res.json()) as Array<{ name: string }>;
  return list.map((t) => t.name);
}

async function defaultDownloadTarball(tag: string, destDir: string): Promise<string> {
  const url = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/tarball/${tag}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download tarball for ${tag}: HTTP ${res.status}`);
  }
  const tarballPath = join(destDir, "release.tar.gz");
  const buf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(tarballPath, buf);
  const extractDir = join(destDir, "extracted");
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir, "--strip-components=1"], {
    encoding: "utf-8",
  });
  if (tar.status !== 0) {
    throw new Error(
      `tar extraction failed for ${tag}: ${tar.stderr || tar.stdout || "unknown error"}. Is 'tar' installed and on PATH?`
    );
  }
  return extractDir;
}

function pickLatestMatchingMajor(tags: string[], installed: string): string | null {
  const inst = parseSemver(installed);
  if (!inst) return null;
  const candidates = tags
    .map((t) => ({ tag: t, ver: parseSemver(t) }))
    .filter((c): c is { tag: string; ver: [number, number, number] } => c.ver !== null)
    .filter((c) => c.ver[0] === inst[0]);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareSemver(b.ver, a.ver));
  return candidates[0].tag;
}

// -----------------------------------------------------------------------------
// Harness detection + installed-version reader
// -----------------------------------------------------------------------------

interface DetectedHarness {
  harnessDir: string;
  distSubpath: string;
  label: string;
}

function detectHarness(projectDir: string, override?: string): DetectedHarness {
  const present = HARNESSES.filter((h) => existsSync(join(projectDir, h.dir)));
  if (override) {
    const match = HARNESSES.find((h) => h.dir === override || h.dir === `.${override}`);
    if (!match) {
      throw new Error(
        `Unknown --harness "${override}". Valid values: ${HARNESSES.map((h) => h.dir).join(", ")}`
      );
    }
    if (!existsSync(join(projectDir, match.dir))) {
      throw new Error(
        `Requested --harness ${match.dir} but ${join(projectDir, match.dir)} does not exist. Install AI-DLC into this project first.`
      );
    }
    return { harnessDir: join(projectDir, match.dir), distSubpath: match.distSubpath, label: match.label };
  }
  if (present.length === 0) {
    throw new Error(
      `No AI-DLC harness dir found in ${projectDir}. Expected one of: ${HARNESSES.map((h) => h.dir).join(", ")}. Install AI-DLC into this project first.`
    );
  }
  if (present.length > 1) {
    throw new Error(
      `Multiple harness dirs present (${present.map((h) => h.dir).join(", ")}). Pick one with --harness <name>.`
    );
  }
  const [only] = present;
  return { harnessDir: join(projectDir, only.dir), distSubpath: only.distSubpath, label: only.label };
}

// Read the INSTALLED version from the target harness dir's aidlc-version.ts.
// We deliberately do not import AIDLC_VERSION here: the tool binary that
// invokes this code may live elsewhere (a downloaded tool copy, a different
// install), and its imported constant tells us nothing about what's installed
// in the target project.
export function readInstalledVersion(harnessDir: string): string {
  const versionFile = join(harnessDir, "tools", "aidlc-version.ts");
  if (!existsSync(versionFile)) {
    // The install exists (we detected the harness dir), but the version file
    // is absent. That's an unusually broken install; fall back to the tool's
    // own version constant so we still produce SOMETHING truthful.
    return AIDLC_VERSION;
  }
  const src = readFileSync(versionFile, "utf-8");
  const m = src.match(/AIDLC_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/);
  if (!m) return AIDLC_VERSION;
  return m[1];
}

// -----------------------------------------------------------------------------
// File walk + hash
// -----------------------------------------------------------------------------

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function walk(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      let st: Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out.sort();
}

interface DiffResult {
  added: string[];
  unchanged: string[];
  kept: string[]; // user-modified — do not overwrite
}

function diffTrees(localRoot: string, upstreamRoot: string): DiffResult {
  const res: DiffResult = { added: [], unchanged: [], kept: [] };
  for (const upAbs of walk(upstreamRoot)) {
    const rel = relative(upstreamRoot, upAbs).split(sep).join("/");
    const localAbs = join(localRoot, rel);
    const upBuf = readFileSync(upAbs);
    if (!existsSync(localAbs)) {
      res.added.push(rel);
      continue;
    }
    const localBuf = readFileSync(localAbs);
    if (upBuf.equals(localBuf)) res.unchanged.push(rel);
    else res.kept.push(rel);
  }
  return res;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export interface UpgradeReport {
  installed: string;
  latest: string | null;
  harnessLabel: string | null;
  harnessDir: string | null;
  reason:
    | "no-upstream-version"
    | "up-to-date"
    | "ahead-of-upstream"
    | "dry-run"
    | "applied";
  dryRun: boolean;
  applied: boolean;
  filesWritten: number;
  filesKept: number;
  diff: DiffResult | null;
  releaseNotesUrl: string | null;
}

export async function upgrade(projectDir: string, opts: UpgradeOptions = {}): Promise<UpgradeReport> {
  const dryRun = !!opts.dryRun;
  const fetchTags = opts.fetchTagsFn ?? defaultFetchTags;
  const download = opts.downloadTarballFn ?? defaultDownloadTarball;

  // Step 1: figure out installed version. Prefer the target harness's file
  // (that's the source of truth for THIS project), fall back to injected
  // override for tests that don't stage a harness dir.
  let installed = opts.installedVersionOverride;
  let harness: DetectedHarness | null = null;
  try {
    harness = detectHarness(projectDir, opts.harnessOverride);
    if (!installed) installed = readInstalledVersion(harness.harnessDir);
  } catch (err) {
    // If we cannot detect a harness AND no override was given, we cannot
    // report an installed version — surface the underlying error.
    if (!installed) throw err;
  }
  installed = installed as string;

  // Step 2: fetch upstream tags and pick the latest matching-major tag.
  const tags = await fetchTags();
  const latest = pickLatestMatchingMajor(tags, installed);

  const empty: Omit<UpgradeReport, "installed" | "latest" | "reason"> = {
    harnessLabel: harness?.label ?? null,
    harnessDir: harness?.harnessDir ?? null,
    dryRun,
    applied: false,
    filesWritten: 0,
    filesKept: 0,
    diff: null,
    releaseNotesUrl: null,
  };

  if (!latest) {
    return { ...empty, installed, latest: null, reason: "no-upstream-version" };
  }

  const cmp = compareSemver(
    parseSemver(installed) as [number, number, number],
    parseSemver(latest) as [number, number, number]
  );
  const releaseNotesUrl = `${RELEASE_NOTES_BASE}/${latest}`;

  if (cmp === 0) {
    return { ...empty, installed, latest, reason: "up-to-date", releaseNotesUrl };
  }
  if (cmp > 0) {
    return { ...empty, installed, latest, reason: "ahead-of-upstream", releaseNotesUrl };
  }

  // Step 3: upgrade is possible. Download + diff + (maybe) apply.
  if (!harness) {
    // Should not reach here (detectHarness would have thrown earlier), but
    // keep the invariant explicit.
    throw new Error("upgrade: harness not detected");
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), "aidlc-upgrade-"));
  try {
    const extractDir = await download(latest, tmpRoot);
    const upstreamHarness = join(extractDir, harness.distSubpath);
    if (!existsSync(upstreamHarness)) {
      throw new Error(
        `Upstream tarball for ${latest} does not contain ${harness.distSubpath}. This tag may predate the current dist layout — file an issue at https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/issues.`
      );
    }
    const diff = diffTrees(harness.harnessDir, upstreamHarness);

    if (dryRun) {
      return {
        installed,
        latest,
        harnessLabel: harness.label,
        harnessDir: harness.harnessDir,
        reason: "dry-run",
        dryRun: true,
        applied: false,
        filesWritten: 0,
        filesKept: diff.kept.length,
        diff,
        releaseNotesUrl,
      };
    }

    // Real apply. Copy added + byte-identical upstream files in; skip files
    // the user has modified (their bytes differ). No backup dir is created —
    // users who want a snapshot should commit their .claude/ or take one
    // themselves before running upgrade.
    let written = 0;
    for (const rel of [...diff.added, ...diff.unchanged]) {
      const src = join(upstreamHarness, ...rel.split("/"));
      const dst = join(harness.harnessDir, ...rel.split("/"));
      mkdirSync(dirName(dst), { recursive: true });
      cpSync(src, dst);
      written++;
    }
    return {
      installed,
      latest,
      harnessLabel: harness.label,
      harnessDir: harness.harnessDir,
      reason: "applied",
      dryRun: false,
      applied: true,
      filesWritten: written,
      filesKept: diff.kept.length,
      diff,
      releaseNotesUrl,
    };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function dirName(p: string): string {
  const idx = p.lastIndexOf(sep);
  if (idx === -1) return ".";
  return p.slice(0, idx);
}

// Test-only exposure for pure helpers.
export const _test = { sha256, diffTrees, pickLatestMatchingMajor, parseSemver, readInstalledVersion };

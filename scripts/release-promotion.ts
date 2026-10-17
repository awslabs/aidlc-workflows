#!/usr/bin/env bun
// A release is one metadata commit on a published preview's source. The
// release workflow travels with it so an older preview can use today's
// publication process without taking today's product code.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, parseVersion, PREVIEW_VERSION, STABLE_VERSION } from "../core/tools/aidlc-channel.ts";
import { parsePreviewTagSource } from "./preview-release.ts";
import { verifyCandidateManifest } from "./verify-release.ts";

export const PROMOTION_FILE = ".github/release-promotion.json";
export const RELEASE_CONTROLS = [
  ".github/workflows/release.yml",
  "scripts/release-promotion.ts",
  "scripts/preview-release.ts",
  "scripts/verify-release.ts",
] as const;
export const RELEASE_METADATA = ["core/tools/aidlc-version.ts", "README.md", "CHANGELOG.md"] as const;
const COMMIT = /^[a-f0-9]{40}$/;

type Release = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  body: string;
};
export type Promotion = {
  schemaVersion: 1;
  repository: string;
  preview: string;
  source: string;
  controls: string;
  version: string;
  date: string;
  notes: string;
  warnings: string[];
};
export type Command = (program: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) => string;

export const command: Command = (program, args, input, env) => {
  const result = spawnSync(program, args, {
    input, encoding: "utf8", env: { ...process.env, ...env },
    timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout;
};

function repositoryName(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid repository");
  return repository;
}

function api<T>(run: Command, path: string): T {
  return JSON.parse(run("gh", ["api", path])) as T;
}

export function releases(repository: string, run: Command = command): Release[] {
  const pages = JSON.parse(run("gh", [
    "api", "--paginate", "--slurp", `repos/${repositoryName(repository)}/releases?per_page=100`,
  ])) as Release[][];
  return pages.flat().filter((release) => !release.draft);
}

export function resolvePreview(repository: string, preview: string, run: Command = command): { release: Release; source: string } {
  repositoryName(repository);
  if (!preview.startsWith("v") || !PREVIEW_VERSION.test(preview.slice(1))) throw new Error("select a vX.Y.Z-preview.YYYYMMDD.N tag");
  parseVersion(preview.slice(1));
  const release = api<Release>(run, `repos/${repository}/releases/tags/${preview}`);
  if (release.draft || !release.prerelease || release.tag_name !== preview) throw new Error("the selected preview must be a published prerelease");
  const ref = api<{ object: { type: string; sha: string } }>(run, `repos/${repository}/git/ref/tags/${preview}`);
  if (ref.object.type !== "tag" || !COMMIT.test(ref.object.sha)) throw new Error("preview must have an annotated source tag");
  const tag = api<{ message: string; object: { type: string; sha: string } }>(run, `repos/${repository}/git/tags/${ref.object.sha}`);
  const source = parsePreviewTagSource(tag.message);
  if (!source || source.repository !== repository || tag.object.type !== "commit" || tag.object.sha !== source.digest) {
    throw new Error("preview tag and recorded source do not agree");
  }
  return { release, source: source.digest };
}

export function releaseWarnings(body: string): string[] {
  return body.split(/\r?\n/).filter((line) => line.startsWith("> **Warning:**"));
}

function verifyPreviewCompatibility(repository: string, preview: string, source: string, run: Command): void {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-preview-manifest-"));
  try {
    writeFileSync(join(scratch, "version.json"), run("gh", [
      "release", "download", preview, "--repo", repository, "--pattern", "version.json", "--output", "-",
    ]));
    verifyCandidateManifest(scratch, preview, source);
  } catch (error) {
    throw new Error(
      `Cannot promote ${preview} with the current release tooling: ${error instanceof Error ? error.message : String(error)}. ` +
      "Choose a compatible preview from the list; no new release tag was created.",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function listPreviews(repository: string, run: Command = command): string {
  const rows = releases(repository, run)
    .filter((release) => release.prerelease && PREVIEW_VERSION.test(release.tag_name.slice(1)));
  const lines = ["| Preview | Published (UTC) | Source commit | Promotion compatibility | Previous validation |", "| --- | --- | --- | --- | --- |"];
  for (const release of rows) {
    const label = `[${release.tag_name}](https://github.com/${repository}/releases/tag/${release.tag_name})`;
    const status = releaseWarnings(release.body ?? "").length ? "Reported failures — read the preview" : "Read the preview; not an approval";
    let source = "";
    try {
      source = resolvePreview(repository, release.tag_name, run).source;
      verifyPreviewCompatibility(repository, release.tag_name, source, run);
      lines.push(`| ${label} | ${release.published_at} | \`${source.slice(0, 12)}\` | Compatible | ${status} |`);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
      lines.push(`| ${label} | ${release.published_at} | ${source ? `\`${source.slice(0, 12)}\`` : "Cannot verify preview source"} | Unavailable: ${reason} | ${status} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function validateNotes(notes: string): string {
  const body = notes.replaceAll("\r\n", "\n").trim();
  const controlCharacter = [...body].some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t");
  if (!/^Compatibility: (refresh only|refresh plus a step|breaking for scripts)\r?\n/.test(body) ||
    !/^[-*] /m.test(body) || /^#{1,2} /m.test(body) ||
    Buffer.byteLength(body) > 40_000 || controlCharacter) {
    throw new Error("notes must start with a Compatibility line, include a summary and bullets, and contain no release headings");
  }
  if (/^[-*] Breaking for scripts:/m.test(body) && !body.startsWith("Compatibility: breaking for scripts\n")) {
    throw new Error("Breaking for scripts bullets require the matching Compatibility line");
  }
  if (["github.com/", "gitlab.aws.dev", "OWNER/REPO"].some((host) => body.includes(host))) {
    throw new Error("CHANGELOG notes must not contain repository URLs; publication adds the preview link");
  }
  return body;
}

export function metadataFiles(
  source: Record<typeof RELEASE_METADATA[number], string>,
  version: string,
  date: string,
  notes: string,
): Record<typeof RELEASE_METADATA[number], string> {
  if (!STABLE_VERSION.test(version)) throw new Error("stable version must be X.Y.Z");
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error("invalid release date");
  const old = source["core/tools/aidlc-version.ts"];
  const versions = [...old.matchAll(/^export const AIDLC_VERSION = "([^"]+)";$/gm)];
  if (versions.length !== 1 || compareVersions(version, versions[0][1]) <= 0) throw new Error("release version must advance the source version");
  const badge = /(!\[version\]\(https:\/\/img\.shields\.io\/badge\/version-)[0-9.]+(-blue\))/g;
  if ([...source["README.md"].matchAll(badge)].length !== 1) throw new Error("README must have one version badge");
  const changelog = source["CHANGELOG.md"];
  const heading = /^## \[/m.exec(changelog);
  if (!heading || changelog.includes(`## [${version}]`)) throw new Error("CHANGELOG needs an existing release and no duplicate target version");
  const entry = `## [${version}] - ${date}\n\n${validateNotes(notes)}\n\n`;
  return {
    "core/tools/aidlc-version.ts": old.replace(versions[0][0], `export const AIDLC_VERSION = "${version}";`),
    "README.md": source["README.md"].replace(badge, `$1${version}$2`),
    "CHANGELOG.md": changelog.slice(0, heading.index) + entry + changelog.slice(heading.index),
  };
}

function sourceFiles(ref: string, run: Command): Record<typeof RELEASE_METADATA[number], string> {
  return Object.fromEntries(RELEASE_METADATA.map((path) => [path, run("git", ["show", `${ref}:${path}`])])) as Record<typeof RELEASE_METADATA[number], string>;
}

function workflowPaths(ref: string, run: Command): string[] {
  return run("git", ["ls-tree", "-r", "--name-only", "-z", ref, "--", ".github/workflows"]).split("\0").filter(Boolean);
}

function promotionFiles(promotion: Promotion, run: Command): Record<string, string | null> {
  return {
    ...metadataFiles(sourceFiles(promotion.source, run), promotion.version, promotion.date, promotion.notes),
    // GITHUB_TOKEN cannot introduce new workflow contents. Carry the complete
    // reviewed workflow tree, including deletions, so every workflow matches
    // the main snapshot the preparation checked out.
    ...Object.fromEntries(workflowPaths(promotion.source, run).map((path) => [path, null])),
    ...Object.fromEntries(workflowPaths(promotion.controls, run).map((path) => [path, run("git", ["show", `${promotion.controls}:${path}`])])),
    ...Object.fromEntries(RELEASE_CONTROLS.map((path) => [path, run("git", ["show", `${promotion.controls}:${path}`])])),
    [PROMOTION_FILE]: `${JSON.stringify(promotion, null, 2)}\n`,
  };
}

function commitFiles(parent: string, files: Record<string, string | null>, message: string, run: Command): string {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-promotion-"));
  const env = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  };
  try {
    run("git", ["read-tree", parent], undefined, env);
    for (const [path, body] of Object.entries(files)) {
      if (body === null) {
        run("git", ["update-index", "--force-remove", path], undefined, env);
        continue;
      }
      const blob = run("git", ["hash-object", "-w", "--stdin"], body).trim();
      run("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
    }
    const tree = run("git", ["write-tree"], undefined, env).trim();
    return run("git", ["commit-tree", tree, "-p", parent, "-m", message], undefined, env).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readPromotion(ref: string, run: Command = command): Promotion {
  const p = JSON.parse(run("git", ["show", `${ref}:${PROMOTION_FILE}`])) as Promotion;
  if (p.schemaVersion !== 1 || !COMMIT.test(p.source) || !COMMIT.test(p.controls) ||
    typeof p.preview !== "string" || !PREVIEW_VERSION.test(p.preview.slice(1)) ||
    !STABLE_VERSION.test(p.version) || !Array.isArray(p.warnings) ||
    p.warnings.some((warning) => typeof warning !== "string")) throw new Error("invalid release promotion record");
  repositoryName(p.repository);
  validateNotes(p.notes);
  return p;
}

export function verifyPromotion(ref: string, repository: string, run: Command = command): Promotion {
  const p = readPromotion(ref, run);
  if (p.repository !== repositoryName(repository) || ref !== `v${p.version}`) throw new Error("promotion repository or tag mismatch");
  run("git", ["merge-base", "--is-ancestor", p.source, "origin/main"]);
  run("git", ["merge-base", "--is-ancestor", p.controls, "origin/main"]);
  const parents = run("git", ["show", "-s", "--format=%P", ref]).trim();
  if (parents !== p.source) throw new Error("release must have exactly the preview source as its parent");
  const preview = resolvePreview(repository, p.preview, run);
  if (preview.source !== p.source) throw new Error("preview source changed");
  if (JSON.stringify(p.warnings) !== JSON.stringify(releaseWarnings(preview.release.body ?? ""))) {
    throw new Error("recorded preview warnings do not match the selected release");
  }
  const expected = promotionFiles(p, run);
  const changed = run("git", ["diff", "--name-only", "-z", p.source, ref]).split("\0").filter(Boolean);
  if (changed.some((path) => !Object.hasOwn(expected, path))) throw new Error("release contains changes outside release metadata and controls");
  for (const [path, body] of Object.entries(expected)) {
    const mode = run("git", ["ls-tree", ref, "--", path]).split(" ")[0];
    if (body === null) {
      if (mode) throw new Error(`obsolete publication workflow remains: ${path}`);
      continue;
    }
    if (mode !== "100644" || run("git", ["show", `${ref}:${path}`]) !== body) throw new Error(`unexpected release change: ${path}`);
  }
  return p;
}

export function preparePromotion(options: {
  repository: string; preview: string; version: string; notes: string; controls: string; date: string;
}, run: Command = command): { sha: string; promotion: Promotion; existing: boolean; published: boolean } {
  const { repository, preview, version, controls, date } = options;
  if (!COMMIT.test(controls)) throw new Error("controls must be an immutable commit");
  run("git", ["merge-base", "--is-ancestor", controls, "origin/main"]);
  const selected = resolvePreview(repository, preview, run);
  run("git", ["merge-base", "--is-ancestor", selected.source, "origin/main"]);
  const notes = validateNotes(options.notes);
  if (!STABLE_VERSION.test(version)) throw new Error("stable version must be X.Y.Z");
  parseVersion(version);
  const tag = `v${version}`;
  const published = publicationStatus(version, repository, run);
  const remote = run("git", ["ls-remote", "--refs", "origin", `refs/tags/${tag}`]).trim();
  if (remote) {
    run("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const p = verifyPromotion(tag, repository, run);
    if (p.preview !== preview || p.notes !== notes) throw new Error("version is already reserved for a different promotion");
    return { sha: run("git", ["rev-parse", `${tag}^{commit}`]).trim(), promotion: p, existing: true, published };
  }
  if (published) throw new Error("version is already published");
  verifyPreviewCompatibility(repository, preview, selected.source, run);
  const promotion: Promotion = {
    schemaVersion: 1, repository, preview, source: selected.source, controls, version, date, notes,
    warnings: releaseWarnings(selected.release.body ?? ""),
  };
  const sha = commitFiles(selected.source, promotionFiles(promotion, run), `chore(release): promote ${preview} as ${tag}`, run);
  return { sha, promotion, existing: false, published: false };
}

export function publicationStatus(version: string, repository: string, run: Command = command): boolean {
  let published = false;
  for (const release of releases(repository, run)) {
    if (release.tag_name === `v${version}`) {
      if (release.prerelease) throw new Error("stable tag is already used by a prerelease");
      published = true;
    }
    if (!release.prerelease && STABLE_VERSION.test(release.tag_name.slice(1)) &&
      compareVersions(version, release.tag_name.slice(1)) < 0) throw new Error(`version must be newer than ${release.tag_name}`);
  }
  return published;
}

export function promotionNotes(p: Promotion): string {
  return `${p.notes}\n\nPromoted from [${p.preview}](https://github.com/${p.repository}/releases/tag/${p.preview}), source \`${p.source}\`.\n\n` +
    "The preview's recorded test results were not rerun or changed by promotion.\n" +
    (p.warnings.length ? `\n${p.warnings.join("\n")}\n` : "");
}

export function syncMetadata(tag: string, repository: string, run: Command = command): string | null {
  const p = verifyPromotion(tag, repository, run);
  const main = run("git", ["rev-parse", "origin/main"]).trim();
  const files = sourceFiles(main, run);
  const current = /^export const AIDLC_VERSION = "([^"]+)";$/m.exec(files["core/tools/aidlc-version.ts"])?.[1];
  if (!current) throw new Error("main has no source version");
  if (compareVersions(current, p.version) >= 0) return null;
  const next = metadataFiles(files, p.version, p.date, p.notes);
  const branch = `release-metadata/${tag}`;
  const remote = run("git", ["ls-remote", "--refs", "origin", `refs/heads/${branch}`]).trim();
  if (remote) {
    run("git", ["fetch", "origin", `refs/heads/${branch}`]);
    const parent = run("git", ["show", "-s", "--format=%P", "FETCH_HEAD"]).trim();
    if (!COMMIT.test(parent)) throw new Error("metadata branch must have one parent");
    run("git", ["merge-base", "--is-ancestor", parent, "origin/main"]);
    const expected = metadataFiles(sourceFiles(parent, run), p.version, p.date, p.notes);
    const changed = run("git", ["diff", "--name-only", "-z", parent, "FETCH_HEAD"]).split("\0").filter(Boolean);
    if (changed.some((path) => !(RELEASE_METADATA as readonly string[]).includes(path))) throw new Error("metadata branch contains unrelated changes");
    for (const path of RELEASE_METADATA) {
      if (run("git", ["show", `FETCH_HEAD:${path}`]) !== expected[path] ||
        run("git", ["ls-tree", "FETCH_HEAD", "--", path]).split(" ")[0] !== "100644") {
        throw new Error(`metadata branch conflicts with this release: ${path}`);
      }
    }
  } else {
    const sha = commitFiles(main, next, `chore(release): record ${tag} on main`, run);
    run("git", ["push", "origin", `${sha}:refs/heads/${branch}`]);
  }
  return `https://github.com/${repository}/compare/main...${branch}?expand=1`;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function report(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main(args: string[]): void {
  const [operation] = args;
  const repository = repositoryName(option(args, "--repository"));
  if (operation === "list") {
    report(listPreviews(repository));
    return;
  }
  command("git", ["fetch", "--no-tags", "origin", "main"]);
  if (operation === "prepare") {
    const result = preparePromotion({
      repository, preview: option(args, "--preview"), version: option(args, "--version"),
      notes: readFileSync(option(args, "--notes-file"), "utf8"),
      controls: option(args, "--controls"), date: new Date().toISOString().slice(0, 10),
    });
    const tag = `v${result.promotion.version}`;
    if (!result.existing) command("git", ["push", "origin", `${result.sha}:refs/tags/${tag}`]);
    report(promotionNotes(result.promotion));
    if (result.published) report(`${tag} is already published. Run the sync command if its main metadata branch is missing.`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\npublished=${result.published}\n`);
  } else if (operation === "verify" || operation === "notes") {
    const tag = option(args, "--tag");
    command("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const p = verifyPromotion(tag, repository);
    if (operation === "notes") writeFileSync(option(args, "--out"), promotionNotes(p));
    else {
      const sha = command("git", ["rev-parse", `${tag}^{commit}`]).trim();
      if (process.env.GITHUB_SHA && sha !== process.env.GITHUB_SHA) throw new Error("run is not on the selected release commit");
      if (publicationStatus(p.version, repository)) throw new Error(`${tag} is already published; use sync for main metadata`);
      report(promotionNotes(p));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nsha=${sha}\ncontrols=${p.controls}\n`);
    }
  } else if (operation === "sync") {
    const tag = option(args, "--tag");
    command("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const link = syncMetadata(tag, repository);
    report(link ? `Open the metadata-only PR to record ${tag} on main: ${link}` : "main already records this or a newer version.");
  } else throw new Error("expected list, prepare, verify, notes or sync");
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

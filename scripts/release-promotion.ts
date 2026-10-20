#!/usr/bin/env bun
// A release is one metadata commit on a published preview's source. The
// release workflow travels with it so an older preview can use today's
// publication process without taking today's product code.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type PromotionFields = {
  repository: string;
  preview: string;
  source: string;
  controls: string;
  version: string;
  date: string;
  notes: string;
  warnings: string[];
};
export type Contributor = { login: string; first?: number };
// Version 1 records (2.11.1 and earlier) carry flat notes and render the notes
// with the preview line. Version 2 renders the whole stable page.
export type Promotion =
  | (PromotionFields & { schemaVersion: 1 })
  | (PromotionFields & { schemaVersion: 2; previous: string | null; contributors: Contributor[] });
type PagePromotion = Extract<Promotion, { schemaVersion: 2 }>;
// Left out of the page's thanks. A named list, not the promoting account, so
// a retry by another maintainer computes the same contributors.
const MAINTAINERS = ["apackeer"];
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

const STEP = /^\*\*[^*\n]+:\*\* \S/;
const BULLET = /^[-*] \S/;
const SCRIPT_COMPATIBILITY = "Script compatibility";
// A Highlights line, and whether it sits under ### Script compatibility.
type Line = { text: string; script: boolean };
type Entry = { compatibility: string; summary: string; affected: string | null; steps: string[]; highlights: Line[][] };

// The entry is both the CHANGELOG text and the stable page's words, so its
// author groups the bullets once, in the reviewed entry (the shape is in
// AGENTS.md, Release Metadata Policy), and the page renders every line in the
// order written. A line outside that shape is shown where it is, for the page
// preview and the release approval to read, except a bullet on the wrong side
// of ### Script compatibility: prepare reserves the version before it prints
// the page, so that one is refused first. Version 1 records never come here.
function parseEntry(notes: string): Entry {
  const body = validateNotes(notes);
  const newline = body.indexOf("\n");
  const blocks = body.slice(newline + 1).trim().split(/\n{2,}/);
  const first = blocks.findIndex((block) => /^([-*] |### )/m.test(block));
  const paragraphs = first < 0 ? blocks : blocks.slice(0, first);
  const [summary = "", ...steps] = paragraphs;
  const breaking = body.startsWith("Compatibility: breaking for scripts\n");
  const affected = breaking && steps.length && !STEP.test(steps[0]) ? steps.shift() ?? null : null;
  let script = false;
  const highlights = (first < 0 ? [] : blocks.slice(first)).map((block) => block.split("\n").map((text) => {
    if (text.startsWith("### ")) script = text.slice(4).trim() === SCRIPT_COMPATIBILITY;
    return { text, script };
  }));
  for (const line of highlights.flat()) {
    if (!BULLET.test(line.text)) continue;
    const bullet = line.text.slice(2);
    if (bullet.startsWith("Breaking for scripts: ") && !line.script) {
      throw new Error(`notes: "${bullet.slice(0, 80)}" is a Breaking for scripts bullet outside ### ${SCRIPT_COMPATIBILITY}; ` +
        `move it under ### ${SCRIPT_COMPATIBILITY}.`);
    }
    if (!bullet.startsWith("Breaking for scripts: ") && line.script) {
      throw new Error(`notes: "${bullet.slice(0, 80)}" sits under ### ${SCRIPT_COMPATIBILITY}, which holds only Breaking for scripts bullets; ` +
        `move it to another group, or start it with "Breaking for scripts: ".`);
    }
  }
  return { compatibility: body.slice("Compatibility: ".length, newline), summary, affected, steps, highlights };
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
  const invalid = new Error("invalid release promotion record");
  if ((p.schemaVersion !== 1 && p.schemaVersion !== 2) || !COMMIT.test(p.source) || !COMMIT.test(p.controls) ||
    typeof p.preview !== "string" || !PREVIEW_VERSION.test(p.preview.slice(1)) ||
    !STABLE_VERSION.test(p.version) || !Array.isArray(p.warnings) ||
    p.warnings.some((warning) => typeof warning !== "string")) throw invalid;
  repositoryName(p.repository);
  validateNotes(p.notes);
  if (p.schemaVersion === 1) return p;
  if (p.previous !== null && !(typeof p.previous === "string" && STABLE_VERSION.test(p.previous) &&
    compareVersions(p.previous, p.version) < 0)) throw invalid;
  // The page prints each login; a record holds only what the contributors
  // parser itself would return.
  try {
    if (!Array.isArray(p.contributors) ||
      JSON.stringify(parseContributors(contributorsText(p.contributors))) !== JSON.stringify(p.contributors)) throw invalid;
  } catch {
    throw invalid;
  }
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

type PromotionRequest = { repository: string; preview: string; version: string; notes: string; contributors?: string };

// What a promotion request selects, the same for the page preview and for
// preparation.
function requestedPage(options: PromotionRequest, run: Command): Omit<PagePromotion, "controls" | "date"> {
  const { repository, preview, version } = options;
  const selected = resolvePreview(repository, preview, run);
  const notes = validateNotes(options.notes);
  const contributors = parseContributors(options.contributors ?? "");
  if (!STABLE_VERSION.test(version)) throw new Error("stable version must be X.Y.Z");
  parseVersion(version);
  return {
    schemaVersion: 2, repository, preview, source: selected.source, version, notes,
    warnings: releaseWarnings(selected.release.body ?? ""),
    previous: previousStable(version, releases(repository, run)), contributors,
  };
}

// The newest published stable release older than this one: the page's Full
// Changelog starts there, and so does its contributor range.
function previousStable(version: string, published: Release[]): string | null {
  return published
    .filter((release) => !release.prerelease && STABLE_VERSION.test(release.tag_name.slice(1)) &&
      compareVersions(release.tag_name.slice(1), version) < 0)
    .map((release) => release.tag_name.slice(1))
    .sort(compareVersions).at(-1) ?? null;
}

export function preparePromotion(options: PromotionRequest & { controls: string; date: string },
  run: Command = command): { sha: string; promotion: Promotion; existing: boolean; published: boolean } {
  const { repository, preview, version, controls, date } = options;
  if (!COMMIT.test(controls)) throw new Error("controls must be an immutable commit");
  run("git", ["merge-base", "--is-ancestor", controls, "origin/main"]);
  const page = requestedPage(options, run);
  run("git", ["merge-base", "--is-ancestor", page.source, "origin/main"]);
  const tag = `v${version}`;
  const published = publicationStatus(version, repository, run);
  const remote = run("git", ["ls-remote", "--refs", "origin", `refs/tags/${tag}`]).trim();
  if (remote) {
    run("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const p = verifyPromotion(tag, repository, run);
    // A version 1 reservation, from the earlier tooling, has flat notes and no
    // contributors or previous version.
    const same = p.preview === preview && p.notes === page.notes && (p.schemaVersion === 1
      ? !page.contributors.length
      : p.previous === page.previous && JSON.stringify(p.contributors) === JSON.stringify(page.contributors));
    if (!same) {
      throw new Error(`version is already reserved for a different promotion; dispatch again with the same preview${
        p.schemaVersion === 1 ? " and notes and no contributors" : ", notes and contributors"}, or choose a new version`);
    }
    return { sha: run("git", ["rev-parse", `${tag}^{commit}`]).trim(), promotion: p, existing: true, published };
  }
  if (published) throw new Error("version is already published");
  parseEntry(page.notes);
  verifyPreviewCompatibility(repository, preview, page.source, run);
  const promotion: Promotion = {
    schemaVersion: 2, repository, preview, source: page.source, controls, version, date, notes: page.notes,
    warnings: page.warnings, previous: page.previous, contributors: page.contributors,
  };
  const sha = commitFiles(page.source, promotionFiles(promotion, run), `chore(release): promote ${preview} as ${tag}`, run);
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

// The stable page, the only one the release publishes. The preview's test
// warnings and its failure report stay on the preview's page, which the
// Promoted line opens; the promotion record keeps the warning lines.
export function promotionNotes(p: Promotion): string {
  const promoted = `Promoted from [${p.preview}](https://github.com/${p.repository}/releases/tag/${p.preview}), source \`${p.source}\`.`;
  if (p.schemaVersion === 1) return `${p.notes}\n\n${promoted}\n`;
  const entry = parseEntry(p.notes);
  const github = `https://github.com/${p.repository}`;
  const download = `${github}/releases/download/v${p.version}`;
  const blocks = [
    "## Summary",
    ...(entry.summary ? [entry.summary] : []),
    `**Compatibility:** ${entry.compatibility}.${entry.affected ? ` ${entry.affected}` : ""}`,
    "## Upgrade",
    "```bash\naidlc update\ncd /path/to/project\naidlc config --yes\naidlc doctor\n```",
    "Open work carries on through the refresh. When a project contains multiple harnesses, run `aidlc config --harness <name> --yes` for each harness you want to refresh.",
    ...entry.steps,
    // The Bun floor is the one aidlc-lib.ts's Bun.markdown error names;
    // t-release-promotion pins the two together.
    `Manual-copy users must copy the complete \`runtime/<harness>/\` tree from [\`aidlc-copy-runtime-${p.version}.tar.gz\`](${download}/aidlc-copy-runtime-${p.version}.tar.gz). ` +
      `Copy it over the project following the [copy-channel instructions](${github}/blob/v${p.version}/docs/guide/18-install-and-lifecycle.md#copy-channel). ` +
      "This installation path requires **Bun 1.3.8 or newer** but does not require the native `aidlc` executable.",
    "Chat commands below use `/aidlc`; in Codex CLI, use `$aidlc` instead.",
    "## Fresh install",
    "### macOS and Linux",
    `\`\`\`bash\ncurl -fsSL ${download}/install.sh | sh -s -- --version ${p.version}\n\`\`\``,
    "### Windows PowerShell",
    `\`\`\`powershell\nirm ${download}/install.ps1 -OutFile install.ps1\n./install.ps1 -Version ${p.version}\n\`\`\``,
    "## Highlights",
    ...highlightBlocks(entry.highlights),
    ...contributorSections(p.contributors, p.repository),
    promoted,
    ...(p.previous ? [`**Full Changelog**: ${github}/compare/v${p.previous}...v${p.version}`] : []),
  ];
  return `${blocks.join("\n\n")}\n`;
}

// The entry's bullets as the page lists them: a dash for every bullet, the
// Breaking for scripts prefix dropped under Script compatibility, and a heading
// in its own block, as on the 2.11.1 page.
function highlightBlocks(blocks: Line[][]): string[] {
  return blocks.flatMap((block) => {
    const lines = block.map(({ text, script }) => {
      if (!BULLET.test(text)) return text;
      return `- ${script ? text.slice(2).replace(/^Breaking for scripts: /, "") : text.slice(2)}`;
    });
    return lines[0].startsWith("### ") && lines.length > 1 ? [lines[0], lines.slice(1).join("\n")] : [lines.join("\n")];
  });
}

// The contributor input: one GitHub login per line, its first PR's number
// after it when this release holds that first PR. The contributors command
// makes it, after the private-names scan on the maintainer's machine; CI only
// renders it.
export function parseContributors(text: string): Contributor[] {
  const body = text.replaceAll("\r\n", "\n").trim();
  if (!body) return [];
  const seen = new Set<string>();
  return body.split("\n").map((line, index) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})(?: ([1-9][0-9]{0,9}))?$/.exec(line);
    if (!match || seen.has(match[1].toLowerCase())) {
      throw new Error(`contributors line ${index + 1} is not a GitHub login with an optional first PR number; ` +
        "make the list with: bun scripts/release-promotion.ts contributors");
    }
    seen.add(match[1].toLowerCase());
    return match[2] ? { login: match[1], first: Number(match[2]) } : { login: match[1] };
  });
}

function contributorsText(contributors: Contributor[]): string {
  return contributors.map((c) => (c.first ? `${c.login} ${c.first}\n` : `${c.login}\n`)).join("");
}

function contributorSections(contributors: Contributor[], repository: string): string[] {
  if (!contributors.length) return [];
  const thanks = `Thank you to everyone who contributed to this release: ${contributors.map((c) => `@${c.login}`).join(", ")}.`;
  const first = contributors.filter((c) => c.first).sort((a, b) => (a.first ?? 0) - (b.first ?? 0))
    .map((c) => `* @${c.login} made their first contribution in https://github.com/${repository}/pull/${c.first}`);
  return ["## Contributors", thanks, ...(first.length ? [["## New Contributors", ...first].join("\n")] : [])];
}

// The page the promotion will publish for these inputs; it writes nothing.
export function previewPage(options: PromotionRequest, run: Command = command): string {
  return promotionNotes({ ...requestedPage(options, run), controls: "", date: "" });
}

const NO_CONTRIBUTORS = "Promote without the contributors input for a page with no contributor sections.";

// True when the text names nobody on the private list.
type Scanner = (text: string) => boolean;

function privateNamesScanner(run: Command): Scanner {
  const path = join(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "info", "scan-private-names");
  if (!existsSync(path)) {
    throw new Error(`No private-names scanner at ${path}, so nothing was printed. Put the scanner there and run this again, ` +
      "or promote without the contributors input: the page then has no contributor sections.");
  }
  return (text) => {
    // The scanner prints what it matched; keep that off the screen.
    const result = spawnSync("bash", [path], { input: text, encoding: "utf8" });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(`The private-names scan did not run (${result.status ?? result.error}), so nothing was printed. ${NO_CONTRIBUTORS}`);
  };
}

// Everyone whose PR merged between the previous stable release and this
// preview's source, most PRs first, then by login; the maintainers and bots
// are left out, and so is any login the private-names scan flags.
export function contributorList(
  options: { repository: string; preview: string; version: string },
  run: Command = command,
  scan: Scanner = privateNamesScanner(run),
): { text: string; left: number } {
  const { repository, version } = options;
  const { source } = resolvePreview(repository, options.preview, run);
  if (!STABLE_VERSION.test(version)) throw new Error("stable version must be X.Y.Z");
  const previous = previousStable(version, releases(repository, run));
  const since: string[] = [];
  if (previous) {
    run("git", ["fetch", "--no-tags", "origin", `refs/tags/v${previous}`]);
    since.push(`^${run("git", ["rev-parse", "FETCH_HEAD^{commit}"]).trim()}`);
  }
  const range = new Set(run("git", ["rev-list", source, ...since]).split("\n").filter(Boolean));
  const prs = JSON.parse(run("gh", [
    "pr", "list", "--repo", repository, "--state", "merged", "--limit", "100000", "--json", "number,author,mergeCommit",
  ])) as Array<{ number: number; author: { login: string; is_bot?: boolean } | null; mergeCommit: { oid: string } | null }>;
  const inRange = (pr: (typeof prs)[number]) => Boolean(pr.mergeCommit && range.has(pr.mergeCommit.oid));
  const firstPr = new Map<string, (typeof prs)[number]>();
  const counts = new Map<string, number>();
  for (const pr of prs) {
    const login = pr.author?.login ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login) || pr.author?.is_bot ||
      MAINTAINERS.some((maintainer) => maintainer.toLowerCase() === login.toLowerCase())) continue;
    if (pr.number < (firstPr.get(login)?.number ?? Number.POSITIVE_INFINITY)) firstPr.set(login, pr);
    if (inRange(pr)) counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  const ordered: Contributor[] = [...counts]
    .sort(([a, x], [b, y]) => y - x || (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map(([login]) => {
      const first = firstPr.get(login);
      return first && inRange(first) ? { login, first: first.number } : { login };
    });
  const kept = ordered.filter((contributor) => scan(contributor.login));
  const text = contributorsText(kept);
  if (!scan(text) || !scan(contributorSections(kept, repository).join("\n\n"))) {
    throw new Error(`The private-names scan flagged the contributor list itself, so nothing was printed. ${NO_CONTRIBUTORS}`);
  }
  return { text, left: ordered.length - kept.length };
}

// What the promotion run shows the person promoting: the stable page as it
// will read, then the preview's warnings, said once.
export function promotionSummary(p: Promotion): string {
  return promotionNotes(p) +
    (p.warnings.length ? `\nOn the preview's page, not the stable page:\n\n${p.warnings.join("\n")}\n` : "");
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

function optional(args: string[], name: string): string | undefined {
  return args.includes(name) ? option(args, name) : undefined;
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
  const contributorsFile = optional(args, "--contributors-file");
  const request = () => ({
    repository, preview: option(args, "--preview"), version: option(args, "--version"),
    notes: readFileSync(option(args, "--notes-file"), "utf8"),
    contributors: contributorsFile === undefined ? "" : readFileSync(contributorsFile, "utf8"),
  });
  if (operation === "contributors") {
    const list = contributorList({ repository, preview: option(args, "--preview"), version: option(args, "--version") });
    process.stdout.write(list.text);
    if (list.left) console.error(`Left out ${list.left} login${list.left === 1 ? "" : "s"} that the private-names scan flagged.`);
  } else if (operation === "page") {
    process.stdout.write(previewPage(request()));
  } else if (operation === "prepare") {
    const result = preparePromotion({
      ...request(), controls: option(args, "--controls"), date: new Date().toISOString().slice(0, 10),
    });
    const tag = `v${result.promotion.version}`;
    if (!result.existing) command("git", ["push", "origin", `${result.sha}:refs/tags/${tag}`]);
    report(promotionSummary(result.promotion));
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
      report(promotionSummary(p));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nsha=${sha}\ncontrols=${p.controls}\n`);
    }
  } else if (operation === "sync") {
    const tag = option(args, "--tag");
    command("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
    const link = syncMetadata(tag, repository);
    report(link ? `Open the metadata-only PR to record ${tag} on main: ${link}` : "main already records this or a newer version.");
  } else throw new Error("expected list, contributors, page, prepare, verify, notes or sync");
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

#!/usr/bin/env bun
// Plans one preview publication from the authorized main commit: decides
// whether main has moved since the newest published preview, allocates the next
// preview id for today's UTC date, and renders the release notes. Runs in the
// authorize job, where the full history is available; the promote job consumes
// the resulting plan verbatim.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import {
  compareVersions,
  parseVersion,
  PREVIEW_CHANNEL,
  PREVIEW_VERSION,
  previewVersion,
  utcBuildDate,
} from "../core/tools/aidlc-channel.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import {
  parsePreviewTagSource,
  type PreviewPlan,
  previewReleaseName,
} from "./preview-release.ts";

const API_VERSION = "2022-11-28";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HEADING = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;

export type PreviewPlanResult =
  | { skip: true; version: null; previousSourceDigest: string; plan: null }
  | { skip: false; version: string; previousSourceDigest: string | null; plan: PreviewPlan };

type ApiClient = {
  json(path: string): Promise<{ value: unknown; next: string | null }>;
};

function requiredOption(args: readonly string[], name: string): string {
  const matches = args
    .map((value, index) => value === name ? args[index + 1] : undefined)
    .filter((value): value is string => value !== undefined);
  if (matches.length !== 1 || !matches[0] || matches[0].startsWith("--")) {
    throw new Error(`expected exactly one ${name}`);
  }
  return matches[0];
}

function optionalOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function githubApiClient(baseUrl: string, token: string | undefined): ApiClient {
  const base = `${baseUrl.replace(/\/+$/, "")}/`;
  return {
    async json(path) {
      const url = /^https?:\/\//.test(path) ? path : new URL(path.replace(/^\/+/, ""), base).toString();
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "aidlc-release-planner",
          "X-GitHub-Api-Version": API_VERSION,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status !== 200) {
        const text = (await response.text()).slice(0, 2000).trim();
        throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}${text ? `: ${text}` : ""}`);
      }
      const link = response.headers.get("link") ?? "";
      return {
        value: await response.json(),
        next: /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null,
      };
    },
  };
}

async function paginated(client: ApiClient, path: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < 50; page++) {
    const result = await client.json(next);
    if (!Array.isArray(result.value)) throw new Error(`${path} did not return an array`);
    rows.push(...result.value);
    next = result.next;
  }
  return rows;
}

function previewTagVersion(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
  if (!tag.startsWith("v") || !PREVIEW_VERSION.test(tag.slice(1))) return null;
  return tag.slice(1);
}

// Every preview tag in the publication repository, published or not: a tag
// that outlived a failed publication still occupies its build counter.
export async function listPreviewTags(client: ApiClient, repository: string): Promise<string[]> {
  const refs = await paginated(client, `repos/${repository}/git/matching-refs/tags/v?per_page=100`);
  const versions: string[] = [];
  for (const entry of refs) {
    if (!entry || typeof entry !== "object" || !("ref" in entry)) continue;
    const version = previewTagVersion(entry.ref);
    if (version) versions.push(version);
  }
  return versions.sort(compareVersions);
}

// The newest published (non-draft) preview release, or null.
export async function newestPublishedPreview(
  client: ApiClient,
  repository: string,
): Promise<string | null> {
  const releases = await paginated(client, `repos/${repository}/releases?per_page=100`);
  let newest: string | null = null;
  for (const entry of releases) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("draft" in entry) ||
      entry.draft !== false ||
      !("prerelease" in entry) ||
      entry.prerelease !== true ||
      !("tag_name" in entry)
    ) {
      continue;
    }
    const version = previewTagVersion(entry.tag_name);
    if (version && (!newest || compareVersions(version, newest) > 0)) newest = version;
  }
  return newest;
}

// The source commit recorded in a preview's annotated tag message, or null when
// the tag is lightweight or carries no source trailer.
export async function previewSourceDigest(
  client: ApiClient,
  repository: string,
  version: string,
): Promise<string | null> {
  const ref = await client.json(`repos/${repository}/git/ref/tags/v${version}`);
  const object = ref.value && typeof ref.value === "object" && "object" in ref.value
    ? ref.value.object
    : null;
  if (
    !object ||
    typeof object !== "object" ||
    !("type" in object) ||
    object.type !== "tag" ||
    !("sha" in object) ||
    typeof object.sha !== "string"
  ) {
    return null;
  }
  const tag = await client.json(`repos/${repository}/git/tags/${object.sha}`);
  const message = tag.value && typeof tag.value === "object" && "message" in tag.value
    ? tag.value.message
    : null;
  return typeof message === "string" ? parsePreviewTagSource(message)?.digest ?? null : null;
}

export function nextPreviewVersion(
  existing: readonly string[],
  base: string,
  date: string,
): string {
  const builds = existing
    .map(parseVersion)
    .filter((parsed) => parsed.date === date)
    .map((parsed) => parsed.build ?? 0);
  return previewVersion(base, date, Math.max(0, ...builds) + 1);
}

function git(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return result.status === 0 ? result.stdout : null;
}

function changelogSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current) sections.set(current, body.join("\n").trim());
  };
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      body = [line];
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      current = null;
      body = [];
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return sections;
}

// Release notes: the CHANGELOG sections added since the previous preview's
// source commit; failing that, the merged commit subjects since it; with no
// previous preview, the source version's own section.
export function previewReleaseNotes(options: {
  cwd: string;
  version: string;
  sourceRepository: string;
  sourceDigest: string;
  previousSourceDigest: string | null;
}): { name: string; body: string } {
  const name = previewReleaseName(options.version);
  const footer = `Source commit: ${options.sourceRepository}@${options.sourceDigest}`;
  const head = git(options.cwd, ["show", `${options.sourceDigest}:CHANGELOG.md`]);
  if (head === null) throw new Error(`CHANGELOG.md is unreadable at ${options.sourceDigest}`);
  const headSections = changelogSections(head);
  const previous = options.previousSourceDigest
    ? git(options.cwd, ["show", `${options.previousSourceDigest}:CHANGELOG.md`])
    : null;
  let body: string;
  if (previous === null) {
    const section = headSections.get(AIDLC_VERSION);
    if (!section) throw new Error(`CHANGELOG.md has no dated ${AIDLC_VERSION} release heading`);
    body = section;
  } else {
    const previousSections = changelogSections(previous);
    const added = [...headSections.entries()]
      .filter(([version]) => !previousSections.has(version))
      .map(([, section]) => section);
    if (added.length > 0) {
      body = added.join("\n\n");
    } else {
      const subjects = git(options.cwd, [
        "log",
        "--format=%s",
        `${options.previousSourceDigest}..${options.sourceDigest}`,
      ]);
      if (subjects === null) {
        throw new Error(
          `commit range ${options.previousSourceDigest}..${options.sourceDigest} is unreadable`,
        );
      }
      const lines = subjects.split(/\r?\n/).filter((line) => line.trim().length > 0);
      body = [
        `Merged commits since ${PREVIEW_CHANNEL} source ${options.previousSourceDigest?.slice(0, 12)}:`,
        "",
        ...lines.map((line) => `- ${line}`),
      ].join("\n");
    }
  }
  return { name, body: `${body.trim()}\n\n${footer}\n` };
}

export async function planPreviewRelease(options: {
  client: ApiClient;
  repository: string;
  sourceRepository: string;
  sourceDigest: string;
  cwd: string;
  date?: string;
}): Promise<PreviewPlanResult> {
  if (!REPOSITORY.test(options.repository) || !REPOSITORY.test(options.sourceRepository)) {
    throw new Error("repositories must be owner/name");
  }
  if (!COMMIT.test(options.sourceDigest)) {
    throw new Error("source digest must be a lowercase 40-hex commit");
  }
  const newest = await newestPublishedPreview(options.client, options.repository);
  const previousSourceDigest = newest
    ? await previewSourceDigest(options.client, options.repository, newest)
    : null;
  if (previousSourceDigest && previousSourceDigest === options.sourceDigest) {
    return { skip: true, version: null, previousSourceDigest, plan: null };
  }
  const tags = await listPreviewTags(options.client, options.repository);
  const version = nextPreviewVersion(tags, AIDLC_VERSION, options.date ?? utcBuildDate());
  const notes = previewReleaseNotes({
    cwd: options.cwd,
    version,
    sourceRepository: options.sourceRepository,
    sourceDigest: options.sourceDigest,
    previousSourceDigest,
  });
  return {
    skip: false,
    version,
    previousSourceDigest,
    plan: {
      schemaVersion: 1,
      version,
      tag: `v${version}`,
      sourceRepository: options.sourceRepository,
      sourceDigest: options.sourceDigest,
      previousSourceDigest,
      notes,
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const repository = requiredOption(argv, "--repository");
  const sourceRepository = requiredOption(argv, "--source-repository");
  const sourceDigest = requiredOption(argv, "--source-digest");
  const output = requiredOption(argv, "--output");
  const date = optionalOption(argv, "--date");
  const result = await planPreviewRelease({
    client: githubApiClient(process.env.GITHUB_API_URL ?? "https://api.github.com", process.env.GH_TOKEN),
    repository,
    sourceRepository,
    sourceDigest,
    cwd: process.cwd(),
    date,
  });
  writeFileSync(output, `${JSON.stringify(result.plan, null, 2)}\n`);
  const rows = [
    `skip=${result.skip ? "true" : "false"}`,
    `preview_version=${result.version ?? ""}`,
    `tag=${result.version ? `v${result.version}` : ""}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${rows.join("\n")}\n`);
  process.stdout.write(
    result.skip
      ? `main ${sourceDigest} is already the source of the newest ${PREVIEW_CHANNEL}; nothing to publish\n`
      : `planned ${PREVIEW_CHANNEL} ${result.version} from ${sourceDigest}${
        result.previousSourceDigest ? ` (previous ${result.previousSourceDigest})` : ""
      }\n`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `plan-preview-release: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

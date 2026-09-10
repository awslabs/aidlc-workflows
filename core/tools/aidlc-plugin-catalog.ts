#!/usr/bin/env bun
// The AIDLC plugin marketplace catalog (RFC #723).
//
// A marketplace is a git repository that publishes emitted plugin projections
// plus one harness-neutral descriptor at its root: `aidlc-marketplace.json`.
// This module owns that descriptor end to end, offline:
//
//   - the catalog schema (parse + validate),
//   - the projection digest that pins a fetched projection to a catalog entry,
//   - marketplace source normalization (`owner/repo`, GitHub URLs, or a direct
//     catalog URL) and the org allowlist match,
//   - the `aidlc plugin catalog` authoring verb that assembles the descriptor
//     and the host-native aggregate catalogs from a directory of projections.
//
// It never touches the network or a project; `aidlc-plugin-market.ts` is the
// network-facing consumer and `scripts/package.ts` the first-party producer.

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EXIT,
  emitResult,
  globalOptions,
  valueAfter,
} from "./aidlc-command.ts";
import { errorMessage, isPlainObject } from "./aidlc-lib.ts";

export const CATALOG_FILE = "aidlc-marketplace.json";
export const CATALOG_SCHEMA_VERSION = 1;
export const PROJECTION_MARKER = ".aidlc-plugin-projection.json";
export const DEFAULT_MARKETPLACE_NAME = "aidlc-plugins";
export const DEFAULT_MARKETPLACE_DESCRIPTION = "AIDLC plugin catalogue.";

/** Harness projections a catalog may list, in emission order. */
export const CATALOG_HARNESSES = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "kiro",
  "kiro-ide",
  "opencode",
] as const;
export type CatalogHarness = (typeof CATALOG_HARNESSES)[number];

/** Hosts with their own plugin store; their aggregate catalog is emitted too. */
export const HOST_STORE_CATALOGS: Readonly<
  Record<"claude" | "codex", string>
> = {
  claude: ".claude-plugin",
  codex: ".codex-plugin",
};

const SAFE_KEY = /^[a-z][a-z0-9-]*$/;
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GITHUB_SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const GITHUB_SSH = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const RESERVED_PLUGIN_NAMES: Record<string, true> = { aidlc: true, core: true };
const GITHUB_API = "https://api.github.com";
const GITHUB_ARCHIVE_HOSTS = ["github.com", "api.github.com", "codeload.github.com"];

/** A tombstone: the plugin's content now ships in core at `core` or later. */
export type SupersededBy = { core: string; note?: string };

export type CatalogProjection = {
  /** Projection directory relative to the marketplace repository root. */
  path: string;
  /** `projectionDigest()` of that directory, lowercase hex. */
  sha256: string;
};

export type CatalogPlugin = {
  /** Logical plugin name (`test-pro`); the host package is `aidlc-<name>`. */
  name: string;
  version: string;
  description: string;
  /** Git tag in the marketplace repository that carries this version. */
  tag: string;
  /** Explicit archive URL for the tag; omitted for GitHub-hosted marketplaces. */
  archive?: string;
  supersededBy?: SupersededBy;
  harnesses: Partial<Record<CatalogHarness, CatalogProjection>>;
};

export type PluginCatalog = {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  name: string;
  owner: { name: string };
  description: string;
  plugins: CatalogPlugin[];
};

/** Identity + provenance every emitted projection carries at its root. */
export type ProjectionMarker = {
  schema: 1;
  producer: string;
  plugin: string;
  harness: string;
  version?: string;
  description?: string;
  supersededBy?: SupersededBy;
};

export class CatalogError extends Error {}

function fail(origin: string, detail: string): never {
  throw new CatalogError(`${origin}: ${detail}`);
}

export function pluginTag(name: string, version: string): string {
  return `${name}--v${version}`;
}

function relativeSafePath(value: unknown, origin: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(origin, `${field} must be a non-empty relative path`);
  }
  const path = value.trim();
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(origin, `${field} must be a clean relative path without '.', '..', or backslashes: ${path}`);
  }
  return path;
}

export function parseSupersededBy(value: unknown, origin: string): SupersededBy | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail(origin, "supersededBy must be an object");
  if (typeof value.core !== "string" || !STRICT_SEMVER.test(value.core)) {
    fail(origin, "supersededBy.core must be the strict semver of the core release that absorbed the plugin");
  }
  if (value.note !== undefined && (typeof value.note !== "string" || !value.note.trim())) {
    fail(origin, "supersededBy.note must be a non-empty string when present");
  }
  const unknown = Object.keys(value).filter((key) => key !== "core" && key !== "note");
  if (unknown.length > 0) fail(origin, `supersededBy has unknown key(s): ${unknown.join(", ")}`);
  return value.note === undefined ? { core: value.core } : { core: value.core, note: value.note.trim() };
}

export function validatePluginName(value: unknown, origin: string): string {
  if (typeof value !== "string" || !SAFE_KEY.test(value)) {
    fail(origin, `plugin name must be kebab-case ([a-z][a-z0-9-]*): ${JSON.stringify(value)}`);
  }
  if (RESERVED_PLUGIN_NAMES[value] || value.startsWith("aidlc-")) {
    fail(origin, `plugin name "${value}" is reserved`);
  }
  return value;
}

function parseCatalogPlugin(value: unknown, origin: string): CatalogPlugin {
  if (!isPlainObject(value)) fail(origin, "must be an object");
  const name = validatePluginName(value.name, origin);
  const at = `${origin} (${name})`;
  if (typeof value.version !== "string" || !STRICT_SEMVER.test(value.version)) {
    fail(at, "version must be strict semver");
  }
  const description = value.description === undefined ? "" : value.description;
  if (typeof description !== "string") fail(at, "description must be a string");
  if (typeof value.tag !== "string" || !value.tag.trim() || /[\s\p{Cc}]/u.test(value.tag)) {
    fail(at, "tag must be a non-empty string without whitespace or control characters");
  }
  if (value.archive !== undefined && (typeof value.archive !== "string" || !value.archive.trim())) {
    fail(at, "archive must be a non-empty URL string when present");
  }
  const supersededBy = parseSupersededBy(value.supersededBy, at);
  if (!isPlainObject(value.harnesses)) fail(at, "harnesses must be an object keyed by harness name");
  const harnesses: CatalogPlugin["harnesses"] = {};
  for (const [harness, projection] of Object.entries(value.harnesses)) {
    if (!(CATALOG_HARNESSES as readonly string[]).includes(harness)) {
      fail(at, `unknown harness "${harness}"; known: ${CATALOG_HARNESSES.join(", ")}`);
    }
    if (!isPlainObject(projection)) fail(at, `harnesses.${harness} must be an object`);
    const path = relativeSafePath(projection.path, at, `harnesses.${harness}.path`);
    if (typeof projection.sha256 !== "string" || !SHA256_HEX.test(projection.sha256)) {
      fail(at, `harnesses.${harness}.sha256 must be 64 lowercase hex characters`);
    }
    harnesses[harness as CatalogHarness] = { path, sha256: projection.sha256 };
  }
  if (Object.keys(harnesses).length === 0) fail(at, "harnesses must list at least one projection");
  return {
    name,
    version: value.version,
    description,
    tag: value.tag.trim(),
    ...(value.archive === undefined ? {} : { archive: value.archive.trim() }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    harnesses,
  };
}

/**
 * Parse and validate one catalog document. Unknown top-level and per-plugin
 * keys are tolerated (additive forward compatibility); unknown harness names
 * are not, because a typo there would silently drop a projection.
 */
export function parseCatalog(text: string, origin: string): PluginCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    fail(origin, `invalid JSON: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) fail(origin, "catalog root must be an object");
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    fail(
      origin,
      `unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}; this aidlc reads schemaVersion ${CATALOG_SCHEMA_VERSION}`,
    );
  }
  if (typeof parsed.name !== "string" || !SAFE_KEY.test(parsed.name)) {
    fail(origin, "name must be kebab-case ([a-z][a-z0-9-]*)");
  }
  if (!isPlainObject(parsed.owner) || typeof parsed.owner.name !== "string" || !parsed.owner.name.trim()) {
    fail(origin, "owner.name must be a non-empty string");
  }
  const description = parsed.description === undefined ? "" : parsed.description;
  if (typeof description !== "string") fail(origin, "description must be a string");
  if (!Array.isArray(parsed.plugins)) fail(origin, "plugins must be an array");
  const plugins = parsed.plugins.map((entry, index) =>
    parseCatalogPlugin(entry, `${origin}: plugins[${index}]`)
  );
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) fail(origin, `plugin "${plugin.name}" is listed more than once`);
    seen.add(plugin.name);
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    name: parsed.name,
    owner: { name: parsed.owner.name.trim() },
    description,
    plugins,
  };
}

export function readCatalog(path: string): PluginCatalog {
  return parseCatalog(readFileSync(path, "utf-8"), path);
}

function walkRegularFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new CatalogError(`${relative(root, path)}: symbolic links are not allowed in a projection`);
    }
    if (stat.isDirectory()) {
      walkRegularFiles(root, path, out);
    } else if (stat.isFile()) {
      out.push(path);
    } else {
      throw new CatalogError(`${relative(root, path)}: special files are not allowed in a projection`);
    }
  }
}

/** Every regular file under `root`, as sorted `/`-joined relative paths. */
export function projectionFiles(root: string): string[] {
  const files: string[] = [];
  walkRegularFiles(root, root, files);
  return files
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * The integrity digest a catalog pins a projection to: sha256 over every
 * regular file in the projection (hooks and host manifests included), in
 * sorted relative-path order, each contributing `path NUL bytes`. Raw bytes,
 * no newline normalization: a fetched archive must match what CI emitted.
 */
export function projectionDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of projectionFiles(root)) {
    hash.update(file, "utf-8");
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(join(root, file)));
  }
  return hash.digest("hex");
}

/**
 * The files an install introduces that execute in the user's shell: every
 * file under a `hooks` path segment (compose hooks, host hook registrations)
 * and every script under `tools/` (sensors, doctor checks). The managed
 * install path names all of them before asking for consent.
 */
export function executableFiles(root: string): { hooks: string[]; tools: string[] } {
  const files = projectionFiles(root);
  return {
    hooks: files.filter((file) => file.split("/").slice(0, -1).includes("hooks")),
    tools: files.filter((file) => file.startsWith("tools/") && /\.(ts|js|mjs|cjs|sh|ps1)$/.test(file)),
  };
}

export function readProjectionMarker(root: string): ProjectionMarker {
  const path = join(root, PROJECTION_MARKER);
  if (!existsSync(path)) fail(root, `not an emitted plugin projection (missing ${PROJECTION_MARKER})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    fail(path, `invalid JSON: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed) || parsed.schema !== 1) fail(path, "unsupported projection marker schema");
  if (typeof parsed.producer !== "string" || !parsed.producer) fail(path, "producer must be a string");
  if (typeof parsed.harness !== "string" || !parsed.harness) fail(path, "harness must be a string");
  const plugin = validatePluginName(parsed.plugin, path);
  if (parsed.version !== undefined && (typeof parsed.version !== "string" || !STRICT_SEMVER.test(parsed.version))) {
    fail(path, "version must be strict semver when present");
  }
  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    fail(path, "description must be a string when present");
  }
  const supersededBy = parseSupersededBy(parsed.supersededBy, path);
  return {
    schema: 1,
    producer: parsed.producer,
    plugin,
    harness: parsed.harness,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}

/**
 * Locate `<path>` inside an extracted archive. Tag tarballs wrap the
 * repository in one top-level directory (`<repo>-<ref>/`); a hand-built
 * archive may not. Exactly those two shapes are accepted.
 */
export function locateProjection(extracted: string, path: string): string {
  const candidates = [extracted];
  const entries = readdirSync(extracted, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    candidates.push(join(extracted, entries[0].name));
  }
  for (const candidate of candidates) {
    const root = join(candidate, ...path.split("/"));
    if (existsSync(join(root, PROJECTION_MARKER))) return root;
  }
  fail(extracted, `archive does not contain a plugin projection at ${path}`);
}

export type MarketplaceSource =
  | {
    kind: "github";
    /** Canonical `https://github.com/<owner>/<repo>`. */
    url: string;
    owner: string;
    repo: string;
    /** The repository name when it is a valid marketplace key, else null. */
    defaultName: string | null;
  }
  | {
    kind: "catalog-url";
    /** A direct URL to an `aidlc-marketplace.json` document. */
    url: string;
    defaultName: null;
  };

/** HTTPS only, except plain HTTP to the loopback interface (local mirrors, tests). */
export function assertMarketplaceUrl(value: string, what = "marketplace URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogError(`${what} is not a valid URL: ${value}`);
  }
  if (url.username || url.password) throw new CatalogError(`${what} must not embed credentials`);
  if (url.hash) throw new CatalogError(`${what} must not carry a fragment: ${value}`);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CatalogError(`${what} must use HTTPS: ${value}`);
  }
  return url;
}

function githubSource(owner: string, repo: string): MarketplaceSource {
  const cleanRepo = repo.replace(/\.git$/, "");
  if (!owner || !cleanRepo) throw new CatalogError("GitHub source needs both owner and repository");
  return {
    kind: "github",
    url: `https://github.com/${owner}/${cleanRepo}`,
    owner,
    repo: cleanRepo,
    defaultName: SAFE_KEY.test(cleanRepo) ? cleanRepo : null,
  };
}

/**
 * Accepts `owner/repo`, `https://github.com/owner/repo[.git]`,
 * `git@github.com:owner/repo[.git]`, or a direct URL ending in
 * `aidlc-marketplace.json` (any HTTPS host: GitHub Enterprise raw URLs,
 * internal mirrors). Anything else is refused with the accepted forms named.
 */
export function normalizeMarketplaceSource(input: string): MarketplaceSource {
  const value = input.trim();
  if (!value) throw new CatalogError("marketplace source is empty");
  const shorthand = GITHUB_SHORTHAND.exec(value);
  if (shorthand && !value.includes(":")) return githubSource(shorthand[1], shorthand[2]);
  const ssh = GITHUB_SSH.exec(value);
  if (ssh) return githubSource(ssh[1], ssh[2]);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogError(
      `marketplace source must be owner/repo, a github.com repository URL, or a direct HTTPS URL to ${CATALOG_FILE}: ${value}`,
    );
  }
  assertMarketplaceUrl(value, "marketplace source");
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (url.search) throw new CatalogError(`GitHub marketplace URL must not carry a query: ${value}`);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new CatalogError(`GitHub marketplace URL must name exactly owner/repo: ${value}`);
    }
    return githubSource(segments[0], segments[1]);
  }
  if (!url.pathname.endsWith(`/${CATALOG_FILE}`)) {
    throw new CatalogError(
      `non-GitHub marketplace source must be a direct URL to ${CATALOG_FILE}: ${value}`,
    );
  }
  return { kind: "catalog-url", url: url.toString(), defaultName: null };
}

/** Where the registered marketplace's current catalog document is fetched. */
export function catalogUrl(source: MarketplaceSource): string {
  if (source.kind === "github") {
    return `${GITHUB_API}/repos/${source.owner}/${source.repo}/contents/${CATALOG_FILE}`;
  }
  return source.url;
}

/**
 * Where a plugin's tag archive is fetched. An explicit `archive` must be
 * HTTPS on the marketplace's own host (GitHub: github.com, api.github.com,
 * codeload.github.com) so a catalog can never route an install to a third
 * origin; without one, GitHub marketplaces use the API tarball endpoint.
 */
export function archiveUrl(source: MarketplaceSource, plugin: CatalogPlugin): string {
  if (plugin.archive) {
    const url = assertMarketplaceUrl(plugin.archive, `${plugin.name} archive URL`);
    const allowedHosts = source.kind === "github"
      ? GITHUB_ARCHIVE_HOSTS
      : [new URL(source.url).hostname];
    if (!allowedHosts.includes(url.hostname)) {
      throw new CatalogError(
        `${plugin.name} archive URL host ${url.hostname} is not the marketplace host (${allowedHosts.join(", ")})`,
      );
    }
    return url.toString();
  }
  if (source.kind === "github") {
    return `${GITHUB_API}/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(plugin.tag)}`;
  }
  throw new CatalogError(
    `${plugin.name}: catalog entry has no archive URL; a non-GitHub marketplace must publish one per plugin`,
  );
}

/**
 * Org allowlist match (machine setting `plugins.allowedMarketplaces`). An
 * empty allowlist allows everything. An entry that normalizes as a source
 * matches that source exactly; an entry ending in `/` is a URL prefix
 * (`https://github.com/acme/` allows every acme repository).
 */
export function marketplaceAllowed(url: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  for (const raw of allowlist) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.endsWith("/")) {
      if (url.startsWith(entry)) return true;
      continue;
    }
    try {
      if (normalizeMarketplaceSource(entry).url === url) return true;
    } catch {
      if (url === entry) return true;
    }
  }
  return false;
}

export type AssembleCatalogOptions = {
  name?: string;
  owner?: string;
  description?: string;
  /** `<archiveBase><tag>.tar.gz` becomes each entry's explicit archive URL. */
  archiveBase?: string;
};

/**
 * Assemble a catalog from `<root>/<plugin>/<harness>/` projections (the
 * layout `bun scripts/package.ts` emits under `dist/plugins/` and a
 * marketplace repository publishes). Every projection of one plugin must
 * agree on version and tombstone; digests are computed from the bytes on disk.
 */
export function assembleCatalog(root: string, options: AssembleCatalogOptions = {}): PluginCatalog {
  const name = options.name ?? DEFAULT_MARKETPLACE_NAME;
  if (!SAFE_KEY.test(name)) throw new CatalogError(`marketplace name must be kebab-case: ${name}`);
  const owner = (options.owner ?? "AIDLC").trim();
  if (!owner) throw new CatalogError("marketplace owner must be a non-empty string");
  if (options.archiveBase !== undefined) {
    assertMarketplaceUrl(options.archiveBase, "archive base URL");
    if (!options.archiveBase.endsWith("/")) throw new CatalogError("archive base URL must end with '/'");
  }
  const plugins: CatalogPlugin[] = [];
  const pluginDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_KEY.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const pluginName of pluginDirs) {
    const harnesses: CatalogPlugin["harnesses"] = {};
    let identity: ProjectionMarker | null = null;
    for (const harness of CATALOG_HARNESSES) {
      const projectionRoot = join(root, pluginName, harness);
      if (!existsSync(join(projectionRoot, PROJECTION_MARKER))) continue;
      const marker = readProjectionMarker(projectionRoot);
      if (marker.plugin !== pluginName || marker.harness !== harness) {
        throw new CatalogError(
          `${projectionRoot}: marker names ${marker.plugin}/${marker.harness}, expected ${pluginName}/${harness}`,
        );
      }
      if (!marker.version) {
        throw new CatalogError(
          `${projectionRoot}: projection marker carries no version; rebuild it with this aidlc release`,
        );
      }
      if (identity) {
        if (identity.version !== marker.version) {
          throw new CatalogError(
            `${pluginName}: projections disagree on version (${identity.version} vs ${harness} ${marker.version}); rebuild every harness from one source`,
          );
        }
        if (JSON.stringify(identity.supersededBy ?? null) !== JSON.stringify(marker.supersededBy ?? null)) {
          throw new CatalogError(`${pluginName}: projections disagree on supersededBy`);
        }
      } else {
        identity = marker;
      }
      harnesses[harness] = {
        path: `${pluginName}/${harness}`,
        sha256: projectionDigest(projectionRoot),
      };
    }
    if (!identity) continue;
    const tag = pluginTag(pluginName, identity.version as string);
    plugins.push({
      name: pluginName,
      version: identity.version as string,
      description: identity.description ?? "",
      tag,
      ...(options.archiveBase === undefined ? {} : { archive: `${options.archiveBase}${tag}.tar.gz` }),
      ...(identity.supersededBy === undefined ? {} : { supersededBy: identity.supersededBy }),
      harnesses,
    });
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    name,
    owner: { name: owner },
    description: options.description ?? DEFAULT_MARKETPLACE_DESCRIPTION,
    plugins,
  };
}

/**
 * The host-native aggregate catalog (`.claude-plugin/marketplace.json`,
 * `.codex-plugin/marketplace.json`) a store host reads at the repository
 * root: one entry per plugin that ships that harness, sourced by relative path.
 */
export function hostMarketplace(
  catalog: PluginCatalog,
  harness: keyof typeof HOST_STORE_CATALOGS,
): Record<string, unknown> {
  return {
    name: catalog.name,
    owner: catalog.owner,
    description: catalog.description,
    plugins: catalog.plugins.flatMap((plugin) => {
      const projection = plugin.harnesses[harness];
      if (!projection) return [];
      return [{
        name: `aidlc-${plugin.name}`,
        source: `./${projection.path}`,
        version: plugin.version,
        description: plugin.description,
      }];
    }),
  };
}

/**
 * Write the descriptor and every host aggregate that has at least one entry.
 * Returns the written paths relative to `root`, in write order.
 */
export function writeCatalogFiles(root: string, catalog: PluginCatalog): string[] {
  const written: string[] = [];
  writeFileSync(join(root, CATALOG_FILE), `${JSON.stringify(catalog, null, 2)}\n`);
  written.push(CATALOG_FILE);
  for (const harness of Object.keys(HOST_STORE_CATALOGS) as Array<keyof typeof HOST_STORE_CATALOGS>) {
    const aggregate = hostMarketplace(catalog, harness);
    if ((aggregate.plugins as unknown[]).length === 0) continue;
    const dir = join(root, HOST_STORE_CATALOGS[harness]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marketplace.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    written.push(`${HOST_STORE_CATALOGS[harness]}/marketplace.json`);
  }
  return written;
}

const USAGE =
  "aidlc plugin catalog [root] [--name <marketplace>] [--owner <owner>] [--description <text>] [--archive-base <https://host/path/>] [--json|--quiet]";

/** `aidlc plugin catalog`: assemble and write the marketplace files for a projection tree. */
export async function main(argv: string[]): Promise<void> {
  const options = globalOptions(argv);
  const positional = argv.filter((arg, index) =>
    !arg.startsWith("--") && !(index > 0 && ["--name", "--owner", "--description", "--archive-base"].includes(argv[index - 1]))
  );
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (positional.length > 1) {
    emitResult({
      ok: false,
      code: EXIT.usage,
      status: "usage",
      message: `unexpected argument(s): ${positional.slice(1).join(" ")}`,
      remediation: USAGE,
    }, options);
    return;
  }
  const root = resolve(positional[0] ?? process.cwd());
  try {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) {
      throw new CatalogError(`${root}: not a directory`);
    }
    const catalog = assembleCatalog(root, {
      name: valueAfter(argv, "--name"),
      owner: valueAfter(argv, "--owner"),
      description: valueAfter(argv, "--description"),
      archiveBase: valueAfter(argv, "--archive-base"),
    });
    if (catalog.plugins.length === 0) {
      throw new CatalogError(
        `${root}: no plugin projections found; expected <root>/<plugin>/<harness>/${PROJECTION_MARKER} (build them with aidlc plugin build)`,
      );
    }
    const written = writeCatalogFiles(root, catalog);
    const projections = catalog.plugins.reduce(
      (count, plugin) => count + Object.keys(plugin.harnesses).length,
      0,
    );
    emitResult({
      ok: true,
      code: EXIT.ok,
      status: "ok",
      message: `wrote ${written.join(", ")} (${catalog.plugins.length} plugin(s), ${projections} projection(s))`,
      data: { root, written, catalog },
    }, options);
  } catch (error) {
    emitResult({
      ok: false,
      code: error instanceof CatalogError ? EXIT.failure : EXIT.failure,
      status: "failed",
      message: errorMessage(error),
    }, options);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

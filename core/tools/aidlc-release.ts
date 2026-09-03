import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  compareVersions,
  PREVIEW_CHANNEL,
  PREVIEW_VERSION,
  requireVersion,
} from "./aidlc-channel.ts";
import { resolvedReleaseSettings } from "./aidlc-machine-config.ts";

export type ReleaseAsset = {
  name: string;
  sha256: string;
  bytes: number;
  kind: "binary" | "runtime" | "installer";
  target?: string;
  verification?: {
    status: "VERIFIED" | "UNVERIFIED";
    mode: "full-runtime" | "inspection-only";
    hostTarget: string;
  };
};

export type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  date: string;
  sourceRef?: string;
  sourceDigest?: string;
  distributions: Array<{ name: string; productName: string }>;
  assets: ReleaseAsset[];
};

export class ReleaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseUnavailableError";
  }
}

const MAX_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_RELEASE_LIST_PAGES = 10;
const PROGRESS_WIDTH = 72;
const PROVENANCE_BUNDLE = "aidlc-release.intoto.jsonl";
const DEFAULT_RELEASE_REPOSITORY = "awslabs/aidlc-workflows";
const DEFAULT_PUBLICATION_REPOSITORY = "awslabs/aidlc-workflows-releases";
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "aidlc-native-lifecycle",
  "X-GitHub-Api-Version": "2022-11-28",
};

function releaseTrust(): { repository: string; workflow: string } {
  const repository =
    process.env.AIDLC_RELEASE_REPOSITORY ?? DEFAULT_RELEASE_REPOSITORY;
  const workflow =
    process.env.AIDLC_RELEASE_WORKFLOW ??
    `${repository}/.github/workflows/release.yml`;
  return { repository, workflow };
}

function defaultReleaseBaseUrl(): string {
  const repository =
    process.env.AIDLC_PUBLICATION_REPOSITORY ?? DEFAULT_PUBLICATION_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("AIDLC_PUBLICATION_REPOSITORY must be owner/name");
  }
  return `https://github.com/${repository}/releases`;
}

// The releases-list API endpoint behind a release base URL. github.com hosts
// derive it (`https://github.com/<owner>/<repo>/releases` becomes
// `https://api.github.com/repos/<owner>/<repo>/releases`); every other host,
// including the loopback test fixture, must name it explicitly through
// AIDLC_RELEASE_API_URL or `--release-api-url`.
export function releaseApiUrl(baseUrl: string, explicit?: string): string {
  const configured = explicit || process.env.AIDLC_RELEASE_API_URL;
  if (configured) {
    assertReleaseUrl(configured);
    return configured.replace(/\/+$/, "");
  }
  const parsed = new URL(baseUrl);
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/?$/.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !match) {
    throw new ReleaseUnavailableError(
      `${PREVIEW_CHANNEL} releases cannot be listed for ${redact(baseUrl)}; pass --release-api-url or set AIDLC_RELEASE_API_URL`,
    );
  }
  return `https://api.github.com/repos/${match[1]}/${match[2]}/releases`;
}

function progress(url: string, complete: boolean): void {
  if (process.env.AIDLC_ROUTE_OUTPUT_MODE !== "human") return;
  const name = basename(new URL(url).pathname) || "release asset";
  const message = complete ? `Downloaded ${name}` : `Downloading ${name}...`;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${message.slice(0, PROGRESS_WIDTH).padEnd(PROGRESS_WIDTH)}${complete ? "\n" : ""}`);
  } else if (complete) {
    process.stderr.write(`${message}\n`);
  }
}

function assertMetadataSize(path: string, name: string): void {
  if (statSync(path).size > MAX_METADATA_BYTES) {
    throw new Error(`${name} exceeds the 1 MiB metadata limit`);
  }
}

function safeAssetName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || basename(name) !== name) {
    throw new Error(`unsafe release asset name: ${name}`);
  }
  return name;
}

function readChecksums(path: string): Map<string, string> {
  assertMetadataSize(path, "checksums.txt");
  const rows = new Map<string, string>();
  for (const line of readFileSync(path, "utf-8").trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error(`malformed checksums.txt row: ${line}`);
    if (rows.has(match[2])) throw new Error(`duplicate checksums.txt row: ${match[2]}`);
    rows.set(match[2], match[1]);
  }
  return rows;
}

export function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifiedChecksums(directory: string): Map<string, string> {
  const checksumsPath = join(directory, "checksums.txt");
  if (!existsSync(checksumsPath)) throw new Error("release is missing checksums.txt");
  const rows = readChecksums(checksumsPath);
  const expected = rows.get("version.json");
  if (!expected) throw new Error("checksums.txt has no version.json checksum");
  const manifestPath = join(directory, "version.json");
  if (!existsSync(manifestPath)) throw new Error("release is missing version.json");
  const actual = digest(manifestPath);
  if (actual !== expected) {
    throw new Error(`version.json: checksum mismatch (expected ${expected}, got ${actual})`);
  }
  return rows;
}

export function verifyReleaseProvenance(
  directory: string,
  manifest: ReleaseManifest,
): void {
  const bundle = join(directory, PROVENANCE_BUNDLE);
  if (!existsSync(bundle)) {
    throw new Error(`release is missing ${PROVENANCE_BUNDLE}`);
  }
  assertMetadataSize(bundle, PROVENANCE_BUNDLE);
  const trust = releaseTrust();
  const gh = process.env.AIDLC_GH_BIN?.trim() || "gh";
  const result = Bun.spawnSync([
    gh,
    "attestation",
    "verify",
    join(directory, "checksums.txt"),
    "--bundle",
    bundle,
    "--repo",
    trust.repository,
    "--signer-workflow",
    trust.workflow,
    "--source-ref",
    manifest.sourceRef ?? `refs/tags/v${manifest.version}`,
    ...(manifest.sourceDigest
      ? ["--source-digest", manifest.sourceDigest]
      : []),
  ], {
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = Buffer.from(result.stderr ?? new Uint8Array()).toString("utf-8").trim();
    throw new Error(
      `release provenance verification failed${
        stderr ? `: ${stderr.split(/\r?\n/)[0]}` : ""
      }; install GitHub CLI and verify the release bundle`,
    );
  }
}

export function readReleaseManifest(directory: string): ReleaseManifest {
  assertMetadataSize(join(directory, "version.json"), "version.json");
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, "version.json"), "utf-8")) as ReleaseManifest;
  } catch (error) {
    throw new Error(`invalid version.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported release schema ${manifest.schemaVersion}`);
  requireVersion(manifest.version);
  const hasSourceRef = manifest.sourceRef !== undefined;
  const hasSourceDigest = manifest.sourceDigest !== undefined;
  if (hasSourceRef !== hasSourceDigest) {
    throw new Error("version.json must provide sourceRef and sourceDigest together");
  }
  if (
    hasSourceRef &&
    (
      manifest.sourceRef !== "refs/heads/main" ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceDigest ?? "")
    )
  ) {
    throw new Error("version.json contains an invalid release source identity");
  }
  if (!Array.isArray(manifest.distributions) || manifest.distributions.length === 0) {
    throw new Error("version.json contains no distributions");
  }
  const distributions = new Set<string>();
  for (const distribution of manifest.distributions) {
    if (
      !distribution ||
      !/^[a-z0-9][a-z0-9-]*$/.test(distribution.name) ||
      typeof distribution.productName !== "string" ||
      distribution.productName.trim().length === 0 ||
      distributions.has(distribution.name)
    ) {
      throw new Error("version.json contains an invalid or duplicate distribution");
    }
    distributions.add(distribution.name);
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error("version.json contains no assets");
  }
  const names = new Set<string>();
  for (const asset of manifest.assets) {
    safeAssetName(asset.name);
    if (names.has(asset.name)) throw new Error(`duplicate release asset: ${asset.name}`);
    names.add(asset.name);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`${asset.name}: invalid SHA-256`);
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > MAX_ASSET_BYTES) {
      throw new Error(`${asset.name}: invalid byte length`);
    }
    const verificationValid = asset.verification === undefined ||
      (
        asset.verification !== null &&
        typeof asset.verification === "object" &&
        asset.kind === "binary" &&
        (asset.verification.status === "VERIFIED" ||
          asset.verification.status === "UNVERIFIED") &&
        (asset.verification.mode === "full-runtime" ||
          asset.verification.mode === "inspection-only") &&
        /^[a-z0-9][a-z0-9-]*$/.test(asset.verification.hostTarget)
      );
    if (
      !["binary", "runtime", "installer"].includes(asset.kind) ||
      !verificationValid ||
      (asset.kind === "binary" &&
        (!asset.target || asset.name !== `aidlc-${asset.target}${asset.target.startsWith("windows-") ? ".exe" : ""}`)) ||
      (asset.kind === "runtime" && asset.name !== "aidlc-runtime.tar.gz") ||
      (asset.kind === "installer" &&
        asset.name !== "install.sh" &&
        asset.name !== "install.ps1")
    ) {
      throw new Error(`${asset.name}: invalid asset metadata`);
    }
  }
  return manifest;
}

export function verifyReleaseDirectory(
  directory: string,
  required: readonly string[] = [],
  allowSubset = false,
): ReleaseManifest {
  const root = isAbsolute(directory) ? directory : resolve(process.cwd(), directory);
  const checksumRows = verifiedChecksums(root);
  const manifest = readReleaseManifest(root);
  const manifestNames = new Set(manifest.assets.map((asset) => asset.name));
  for (const name of checksumRows.keys()) {
    if (name !== "version.json" && !manifestNames.has(name)) {
      throw new Error(`checksums.txt contains unknown asset ${name}`);
    }
  }
  for (const asset of manifest.assets) {
    const path = join(root, asset.name);
    if (!existsSync(path)) {
      if (allowSubset && !required.includes(asset.name)) continue;
      throw new Error(`release is missing ${asset.name}`);
    }
    const actual = digest(path);
    if (actual !== asset.sha256 || checksumRows.get(asset.name) !== actual) {
      throw new Error(`${asset.name}: checksum mismatch (expected ${asset.sha256}, got ${actual})`);
    }
    if (readFileSync(path).byteLength !== asset.bytes) {
      throw new Error(`${asset.name}: size mismatch`);
    }
  }
  for (const name of required) {
    if (!manifest.assets.some((asset) => asset.name === name)) {
      throw new Error(`release manifest does not provide ${name}`);
    }
  }
  return manifest;
}

function releaseUrl(base: string, version: string | undefined, name: string): string {
  const clean = base.replace(/\/+$/, "");
  const segment = version ? `download/v${version}` : "latest/download";
  return `${clean}/${segment}/${name}`;
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    if (parsed.search) parsed.search = "?<redacted>";
    if (parsed.hash) parsed.hash = "#<redacted>";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

function remainingTimeout(deadline: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ReleaseUnavailableError(`${label} timed out before the release metadata completed`);
  }
  return remaining;
}

function assertReleaseUrl(url: string, allowQuery = false): URL {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new Error(`release URL must not include credentials: ${redact(url)}`);
  }
  if ((!allowQuery && parsed.search) || parsed.hash) {
    throw new Error(
      `release URL must not include ${allowQuery ? "a fragment" : "a query or fragment"}: ${redact(url)}`,
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"))
  ) {
    throw new Error(`release URL must use HTTPS: ${redact(url)}`);
  }
  return parsed;
}

function proxyFor(url: URL): string | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of noProxy.split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry === "*") return undefined;
    const withoutScheme = entry.replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const lastColon = withoutScheme.lastIndexOf(":");
    const hasPort = lastColon > 0 && /^\d+$/.test(withoutScheme.slice(lastColon + 1));
    const host = (hasPort ? withoutScheme.slice(0, lastColon) : withoutScheme)
      .replace(/^\./, "")
      .toLowerCase();
    const entryPort = hasPort ? withoutScheme.slice(lastColon + 1) : undefined;
    const hostname = url.hostname.toLowerCase();
    if (
      host &&
      (!entryPort || entryPort === port) &&
      (hostname === host || hostname.endsWith(`.${host}`))
    ) {
      return undefined;
    }
  }
  const parsedProxy = new URL(proxy);
  if (parsedProxy.protocol !== "http:" && parsedProxy.protocol !== "https:") {
    throw new Error(`HTTPS_PROXY must use HTTP or HTTPS: ${redact(proxy)}`);
  }
  return proxy;
}

type TransportOptions = {
  timeoutMs: number;
  caBundle?: string;
  maxBytes?: number;
  contentTypes?: readonly string[];
  reportedTimeoutMs?: number;
  // Release asset URLs never carry a query; API list requests do.
  allowQuery?: boolean;
  headers?: Record<string, string>;
  notFound?: string;
};

const NO_RELEASE_PUBLISHED =
  "No published native release is available yet. Pass --from <release-directory>, or run bun scripts/package.ts in an aidlc-workflows source checkout to materialize the development copy channel.";

async function fetchBytes(
  url: string,
  options: TransportOptions,
): Promise<{ bytes: Buffer; headers: Headers }> {
  const {
    timeoutMs,
    caBundle,
    maxBytes = MAX_ASSET_BYTES,
    contentTypes = [],
    reportedTimeoutMs = timeoutMs,
    allowQuery = false,
    headers,
    notFound = NO_RELEASE_PUBLISHED,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const parsed = assertReleaseUrl(current, allowQuery || redirects > 0);
      const proxy = proxyFor(parsed);
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          ...(headers ? { headers } : {}),
          ...(proxy ? { proxy } : {}),
          ...(caBundle ? { tls: { ca: readFileSync(caBundle) } } : {}),
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          error instanceof DOMException && error.name === "AbortError" ||
          error instanceof Error && error.name === "TimeoutError"
        ) {
          throw new ReleaseUnavailableError(
            `${redact(current)} timed out after ${reportedTimeoutMs}ms`,
          );
        }
        throw new ReleaseUnavailableError(`${redact(current)} transport failure`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) {
        throw new ReleaseUnavailableError(`${redact(current)} returned a redirect without Location`);
      }
      if (redirects === 5) {
        throw new ReleaseUnavailableError(`${redact(url)} exceeded the 5 redirect limit`);
      }
      await response.body?.cancel();
      current = new URL(location, current).toString();
      try {
        assertReleaseUrl(current, true);
      } catch (error) {
        throw new ReleaseUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (!response) throw new ReleaseUnavailableError(`${redact(url)} returned no response`);
    if (response.status === 404) throw new ReleaseUnavailableError(notFound);
    if (!response.ok) {
      throw new ReleaseUnavailableError(`${redact(url)} returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]
      .trim().toLowerCase() ?? "";
    if (contentTypes.length > 0 && !contentTypes.includes(contentType)) {
      throw new Error(
        `${redact(url)} returned unexpected content type ${contentType || "<missing>"}`,
      );
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`${redact(url)} exceeds the ${maxBytes} byte download limit`);
    }
    if (!response.body) {
      throw new ReleaseUnavailableError(`${redact(url)} returned an empty response body`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read().catch(() => {
        throw new ReleaseUnavailableError(`${redact(current)} transport failure`);
      });
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${redact(url)} exceeds the ${maxBytes} byte download limit`);
      }
      chunks.push(chunk.value);
    }
    return {
      bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes),
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof ReleaseUnavailableError) throw error;
    if (
      error instanceof DOMException && error.name === "AbortError" ||
      error instanceof Error && error.name === "TimeoutError"
    ) {
      throw new ReleaseUnavailableError(
        `${redact(url)} timed out after ${reportedTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function download(
  url: string,
  path: string,
  timeoutMs: number,
  caBundle?: string,
  maxBytes = MAX_ASSET_BYTES,
  contentTypes: readonly string[] = [],
  reportedTimeoutMs = timeoutMs,
): Promise<void> {
  progress(url, false);
  try {
    const { bytes } = await fetchBytes(url, {
      timeoutMs,
      caBundle,
      maxBytes,
      contentTypes,
      reportedTimeoutMs,
    });
    writeFileSync(path, bytes);
    progress(url, true);
  } catch (error) {
    if (process.env.AIDLC_ROUTE_OUTPUT_MODE === "human" && process.stderr.isTTY) {
      process.stderr.write(`\r${"".padEnd(PROGRESS_WIDTH)}\r`);
    }
    throw error;
  }
}

// Newest published preview in the repository behind the release base URL:
// the GitHub releases list, filtered to non-draft prereleases whose tag is
// `v` plus a preview id. Stable discovery never comes through here (it is the
// `latest/download` redirect), and a preview lookup never falls back to stable:
// every API or transport failure, rate limiting included, is "unavailable".
export async function resolvePreviewVersion(options: {
  baseUrl?: string;
  apiUrl?: string;
  caBundle?: string;
  timeoutMs?: number;
} = {}): Promise<string> {
  const settings = resolvedReleaseSettings(options);
  if (settings.offline) {
    throw new ReleaseUnavailableError(`${PREVIEW_CHANNEL} discovery is unavailable while offline`);
  }
  const baseUrl = settings.baseUrl || defaultReleaseBaseUrl();
  const listUrl = releaseApiUrl(baseUrl, options.apiUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let newest: string | undefined;
  let next: string | null = `${listUrl}?per_page=100`;
  for (let page = 0; next && page < MAX_RELEASE_LIST_PAGES; page++) {
    const { bytes, headers } = await fetchBytes(next, {
      timeoutMs: remainingTimeout(deadline, `${PREVIEW_CHANNEL} release list`),
      caBundle: settings.caBundle,
      maxBytes: MAX_METADATA_BYTES,
      contentTypes: ["application/json"],
      reportedTimeoutMs: timeoutMs,
      allowQuery: true,
      headers: GITHUB_API_HEADERS,
      notFound: `${redact(listUrl)} returned HTTP 404; the release repository has no releases API`,
    });
    let listed: unknown;
    try {
      listed = JSON.parse(bytes.toString("utf-8"));
    } catch {
      throw new ReleaseUnavailableError(`${redact(listUrl)} returned malformed release JSON`);
    }
    if (!Array.isArray(listed)) {
      throw new ReleaseUnavailableError(`${redact(listUrl)} returned a non-array release list`);
    }
    for (const entry of listed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("draft" in entry) ||
        entry.draft !== false ||
        !("prerelease" in entry) ||
        entry.prerelease !== true ||
        !("tag_name" in entry) ||
        typeof entry.tag_name !== "string"
      ) {
        continue;
      }
      const tag = entry.tag_name;
      if (!tag.startsWith("v") || !PREVIEW_VERSION.test(tag.slice(1))) continue;
      const version = tag.slice(1);
      if (!newest || compareVersions(version, newest) > 0) newest = version;
    }
    const link = headers.get("link") ?? "";
    next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
  }
  if (!newest) {
    throw new ReleaseUnavailableError(
      `no ${PREVIEW_CHANNEL} release is published at ${redact(listUrl)}`,
    );
  }
  return newest;
}

export async function fetchReleaseMetadata(options: {
  version?: string;
  offline?: boolean;
  baseUrl?: string;
  caBundle?: string;
  metadataTimeoutMs?: number;
} = {}): Promise<{
  directory: string;
  manifest: ReleaseManifest;
  cleanup: string;
}> {
  if (process.env.AIDLC_ROUTE_NETWORK_POLICY === "forbidden") {
    throw new Error(`route ${process.env.AIDLC_ROUTE_ID ?? "unknown"} forbids network access`);
  }
  const settings = resolvedReleaseSettings(options);
  if (settings.offline) {
    throw new ReleaseUnavailableError("update metadata is unavailable while offline");
  }
  const version = options.version ? requireVersion(options.version) : undefined;
  const baseUrl = settings.baseUrl || defaultReleaseBaseUrl();
  const metadataTimeoutMs = options.metadataTimeoutMs ?? 15_000;
  const metadataDeadline = Date.now() + metadataTimeoutMs;
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-release-metadata-"));
  try {
    await download(
      releaseUrl(baseUrl, version, "version.json"),
      join(temporary, "version.json"),
      remainingTimeout(metadataDeadline, "release metadata"),
      settings.caBundle,
      MAX_METADATA_BYTES,
      ["application/json", "text/json", "application/octet-stream", "binary/octet-stream", "text/plain"],
      metadataTimeoutMs,
    );
    await download(
      releaseUrl(baseUrl, version, "checksums.txt"),
      join(temporary, "checksums.txt"),
      remainingTimeout(metadataDeadline, "release metadata"),
      settings.caBundle,
      MAX_METADATA_BYTES,
      ["text/plain", "application/octet-stream", "binary/octet-stream"],
      metadataTimeoutMs,
    );
    await download(
      releaseUrl(baseUrl, version, PROVENANCE_BUNDLE),
      join(temporary, PROVENANCE_BUNDLE),
      remainingTimeout(metadataDeadline, "release provenance"),
      settings.caBundle,
      MAX_METADATA_BYTES,
      ["application/json", "application/octet-stream", "binary/octet-stream", "text/plain"],
      metadataTimeoutMs,
    );
    const manifest = readReleaseManifest(temporary);
    verifyReleaseProvenance(temporary, {
      ...manifest,
      sourceDigest: undefined,
    });
    verifiedChecksums(temporary);
    if (manifest.sourceDigest) verifyReleaseProvenance(temporary, manifest);
    if (version && manifest.version !== version) {
      throw new Error(`release endpoint returned ${manifest.version}, not requested ${version}`);
    }
    return { directory: temporary, manifest, cleanup: temporary };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function acquireRelease(options: {
  version?: string;
  from?: string;
  names?: readonly string[];
  offline?: boolean;
  baseUrl?: string;
  caBundle?: string;
  metadataTimeoutMs?: number;
}): Promise<{ directory: string; manifest: ReleaseManifest; cleanup?: string }> {
  if (options.from) {
    const directory = isAbsolute(options.from) ? options.from : resolve(process.cwd(), options.from);
    const manifest = readReleaseManifest(directory);
    verifyReleaseProvenance(directory, {
      ...manifest,
      sourceDigest: undefined,
    });
    verifiedChecksums(directory);
    if (manifest.sourceDigest) verifyReleaseProvenance(directory, manifest);
    verifyReleaseDirectory(directory, options.names, Boolean(options.names?.length));
    if (options.version && manifest.version !== options.version) {
      throw new Error(`local release is ${manifest.version}, not requested ${options.version}`);
    }
    return { directory, manifest };
  }
  if (process.env.AIDLC_ROUTE_NETWORK_POLICY === "forbidden") {
    throw new Error(`route ${process.env.AIDLC_ROUTE_ID ?? "unknown"} forbids network access`);
  }
  const settings = resolvedReleaseSettings(options);
  if (settings.offline) {
    throw new ReleaseUnavailableError("--offline requires --from <release-directory>");
  }
  const version = options.version ? requireVersion(options.version) : undefined;
  const metadata = await fetchReleaseMetadata({
    version,
    offline: settings.offline,
    baseUrl: settings.baseUrl,
    caBundle: settings.caBundle,
    metadataTimeoutMs: options.metadataTimeoutMs,
  });
  const temporary = metadata.directory;
  try {
    const releasedChecksums = verifiedChecksums(temporary);
    const manifest = metadata.manifest;
    const selected = options.names?.length
      ? manifest.assets.filter((asset) => options.names?.includes(asset.name))
      : manifest.assets;
    const missing = (options.names ?? []).filter((name) => !selected.some((asset) => asset.name === name));
    if (missing.length > 0) {
      throw new ReleaseUnavailableError(`release does not provide: ${missing.join(", ")}`);
    }
    for (const asset of selected) {
      if (releasedChecksums.get(asset.name) !== asset.sha256) {
        throw new Error(`${asset.name}: released checksum does not match version.json`);
      }
      await download(
        releaseUrl(
          settings.baseUrl ||
            defaultReleaseBaseUrl(),
          version || manifest.version,
          asset.name,
        ),
        join(temporary, asset.name),
        Math.max(60_000, Math.ceil(asset.bytes / (128 * 1024)) * 1000),
        settings.caBundle,
      );
    }
    const subset: ReleaseManifest = { ...manifest, assets: selected };
    writeFileSync(join(temporary, "version.json"), `${JSON.stringify(subset, null, 2)}\n`);
    writeFileSync(
      join(temporary, "checksums.txt"),
      `${
        [
          `${digest(join(temporary, "version.json"))}  version.json`,
          ...selected.map((asset) => `${releasedChecksums.get(asset.name)}  ${asset.name}`),
        ].join("\n")
      }\n`,
    );
    verifyReleaseDirectory(temporary, options.names);
    return { directory: temporary, manifest: subset, cleanup: temporary };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function copyReleaseSubset(
  source: string,
  destination: string,
  names: readonly string[],
): ReleaseManifest {
  const manifest = verifyReleaseDirectory(source, names);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const assets = manifest.assets.filter((asset) => names.includes(asset.name));
  for (const asset of assets) copyFileSync(join(source, asset.name), join(destination, asset.name));
  const subset: ReleaseManifest = { ...manifest, assets };
  writeFileSync(join(destination, "version.json"), `${JSON.stringify(subset, null, 2)}\n`);
  writeFileSync(
    join(destination, "checksums.txt"),
    `${
      [
        `${digest(join(destination, "version.json"))}  version.json`,
        ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
      ].join("\n")
    }\n`,
  );
  return subset;
}

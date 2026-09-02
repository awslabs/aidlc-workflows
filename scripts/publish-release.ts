#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

type ReleaseAsset = {
  id: number;
  name: string;
  size: number;
  state: string;
};

type ReleaseRecord = {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: boolean;
  immutable: boolean;
  prerelease: boolean;
  upload_url: string;
  assets: ReleaseAsset[];
};

type LocalAsset = {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
};

export type PublishReleaseOptions = {
  directory: string;
  tag: string;
  stagingTag: string;
  targetCommitish: string;
  repository: string;
  notes: ReleaseNotes;
  token: string;
  apiBaseUrl?: string;
  expectedAssetCount?: number;
  log?: (message: string) => void;
};

export type PublishedRelease = {
  id: number;
  tag: string;
  assets: string[];
};

type JsonResponse<T> = {
  response: Response;
  value: T;
};

type ReleaseNotes = {
  name: string;
  body: string;
};

const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function requiredOption(args: string[], name: string): string {
  const matches = args
    .map((value, index) => value === name ? args[index + 1] : undefined)
    .filter((value): value is string => value !== undefined);
  if (matches.length !== 1 || !matches[0] || matches[0].startsWith("--")) {
    throw new Error(`expected exactly one ${name}`);
  }
  return matches[0];
}

function apiUrl(base: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString();
}

// Per-request headers replace the defaults by name. Header names are
// case-insensitive, so merging them as object keys would keep both `Accept`
// and `accept` and the Headers constructor would append the values; GitHub
// then answers an asset download with JSON metadata instead of bytes.
function requestHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "aidlc-release-publisher",
    "X-GitHub-Api-Version": API_VERSION,
  });
  for (const [name, value] of new Headers(extra)) headers.set(name, value);
  return headers;
}

async function responseFailure(response: Response): Promise<Error> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 4000).trim();
  } catch (error) {
    text = `response body unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return new Error(
    `GitHub API ${response.status} ${response.statusText}${
      text ? `: ${text}` : ""
    }`,
  );
}

async function request(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: requestHeaders(token, init.headers),
    redirect: init.redirect ?? "follow",
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function requestJson<T>(
  url: string,
  token: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<JsonResponse<T>> {
  const response = await request(url, token, init);
  if (response.status !== expectedStatus) throw await responseFailure(response);
  return {
    response,
    value: await response.json() as T,
  };
}

function releaseRecord(value: unknown): ReleaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release API response must be an object");
  }
  const release = value as Partial<ReleaseRecord>;
  if (
    !Number.isInteger(release.id) ||
    typeof release.tag_name !== "string" ||
    typeof release.target_commitish !== "string" ||
    typeof release.name !== "string" ||
    typeof release.body !== "string" ||
    typeof release.draft !== "boolean" ||
    typeof release.immutable !== "boolean" ||
    typeof release.prerelease !== "boolean" ||
    typeof release.upload_url !== "string" ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("release API response is missing required fields");
  }
  for (const asset of release.assets) {
    if (
      !asset ||
      typeof asset !== "object" ||
      !Number.isInteger(asset.id) ||
      typeof asset.name !== "string" ||
      !Number.isInteger(asset.size) ||
      typeof asset.state !== "string"
    ) {
      throw new Error("release API response contains an invalid asset");
    }
  }
  return release as ReleaseRecord;
}

function assetRecord(value: unknown): ReleaseAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release asset API response must be an object");
  }
  const asset = value as Partial<ReleaseAsset>;
  if (
    !Number.isInteger(asset.id) ||
    typeof asset.name !== "string" ||
    !Number.isInteger(asset.size) ||
    typeof asset.state !== "string"
  ) {
    throw new Error("release asset API response is missing required fields");
  }
  return asset as ReleaseAsset;
}

function releaseNotes(value: unknown): ReleaseNotes {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release notes API response must be an object");
  }
  const notes = value as Partial<ReleaseNotes>;
  if (typeof notes.name !== "string" || typeof notes.body !== "string") {
    throw new Error("release notes API response is missing name or body");
  }
  return notes as ReleaseNotes;
}

export function releaseNotesFromChangelog(path: string, tag: string): ReleaseNotes {
  const version = tag.slice(1);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const changelog = readFileSync(path, "utf-8");
  const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no dated ${version} release heading`);
  const remainder = changelog.slice(match.index + match[0].length).replace(/^\r?\n/, "");
  const nextHeading = remainder.search(/^## \[/m);
  const body = (nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)).trim();
  if (!body) throw new Error(`CHANGELOG.md has no release notes for ${version}`);
  return {
    name: `Release ${tag}`,
    body: `${body}\n`,
  };
}

function responseEtag(response: Response): string {
  const raw = response.headers.get("etag")?.trim();
  if (!raw) throw new Error("release API response omitted ETag");
  const etag = raw.startsWith("W/") ? raw.slice(2) : raw;
  if (!/^"[^"]+"$/.test(etag)) {
    throw new Error(`release API returned an invalid ETag: ${raw}`);
  }
  return etag;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function localAssets(
  directory: string,
  expectedAssetCount: number,
): Promise<LocalAsset[]> {
  const root = resolve(directory);
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (entries.length !== expectedAssetCount) {
    throw new Error(
      `release directory must contain exactly ${expectedAssetCount} files, found ${entries.length}`,
    );
  }
  const assets: LocalAsset[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`release entry must be a regular file: ${entry.name}`);
    }
    assets.push({
      name: entry.name,
      path,
      bytes: statSync(path).size,
      sha256: await sha256File(path),
    });
  }
  return assets;
}

function uploadEndpoint(apiBaseUrl: string, template: string): string {
  const endpoint = new URL(template.replace(/\{.*$/, ""));
  const api = new URL(apiBaseUrl);
  if (api.hostname === "api.github.com") {
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "uploads.github.com") {
      throw new Error(`release API returned an unexpected upload endpoint: ${endpoint.origin}`);
    }
  } else if (endpoint.origin !== api.origin) {
    throw new Error(`release API returned a cross-origin upload endpoint: ${endpoint.origin}`);
  }
  return endpoint.toString();
}

async function getRelease(
  releaseUrl: string,
  token: string,
): Promise<{ release: ReleaseRecord; etag: string }> {
  const result = await requestJson<unknown>(releaseUrl, token, {}, 200);
  return {
    release: releaseRecord(result.value),
    etag: responseEtag(result.response),
  };
}

async function uploadAsset(
  uploadUrl: string,
  token: string,
  name: string,
  body: BodyInit,
): Promise<ReleaseAsset> {
  const url = new URL(uploadUrl);
  url.searchParams.set("name", name);
  const result = await requestJson<unknown>(
    url.toString(),
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    },
    201,
  );
  const asset = assetRecord(result.value);
  if (asset.name !== name || asset.state !== "uploaded") {
    throw new Error(`release asset upload returned an invalid state for ${name}`);
  }
  return asset;
}

function assertReleaseIdentity(
  release: ReleaseRecord,
  tag: string,
  targetCommitish: string,
  notes: ReleaseNotes,
  expectedDraft: boolean,
  expectedImmutable: boolean,
): void {
  if (
    release.tag_name !== tag ||
    release.target_commitish !== targetCommitish ||
    release.name !== notes.name ||
    release.body !== notes.body ||
    release.draft !== expectedDraft ||
    release.immutable !== expectedImmutable ||
    release.prerelease
  ) {
    throw new Error(
      `release identity mismatch for ${tag}@${targetCommitish}: ` +
        `target=${release.target_commitish}, draft=${release.draft}, ` +
        `immutable=${release.immutable}, prerelease=${release.prerelease}`,
    );
  }
}

async function tagTarget(
  apiBaseUrl: string,
  repository: string,
  tag: string,
  token: string,
): Promise<string | null> {
  const response = await request(
    apiUrl(
      apiBaseUrl,
      `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    ),
    token,
  );
  if (response.status === 404) {
    await response.text();
    return null;
  }
  if (response.status !== 200) throw await responseFailure(response);
  const document = await response.json() as {
    object?: { type?: unknown; sha?: unknown };
  };
  if (
    document.object?.type !== "commit" ||
    typeof document.object.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(document.object.sha)
  ) {
    throw new Error(`tag ${tag} is not a lightweight commit ref`);
  }
  return document.object.sha;
}

async function requireTagAbsent(
  apiBaseUrl: string,
  repository: string,
  tag: string,
  token: string,
): Promise<void> {
  if (await tagTarget(apiBaseUrl, repository, tag, token)) {
    throw new Error(`release tag already exists: ${tag}`);
  }
}

async function requireTagTarget(
  apiBaseUrl: string,
  repository: string,
  tag: string,
  targetCommitish: string,
  token: string,
): Promise<void> {
  const actual = await tagTarget(apiBaseUrl, repository, tag, token);
  if (actual !== targetCommitish) {
    throw new Error(
      `published release tag ${tag} resolves to ${actual ?? "nothing"}, not ${targetCommitish}`,
    );
  }
}

function assertAssetInventory(
  release: ReleaseRecord,
  local: readonly LocalAsset[],
): void {
  const expected = new Map(local.map((asset) => [asset.name, asset]));
  if (release.assets.length !== expected.size) {
    throw new Error(
      `release asset inventory differs: expected ${expected.size}, found ${release.assets.length}`,
    );
  }
  const seen = new Set<string>();
  for (const asset of release.assets) {
    if (seen.has(asset.name)) throw new Error(`duplicate release asset ${asset.name}`);
    seen.add(asset.name);
    const localAsset = expected.get(asset.name);
    if (
      !localAsset ||
      asset.state !== "uploaded" ||
      asset.size !== localAsset.bytes
    ) {
      throw new Error(`release asset metadata differs for ${asset.name}`);
    }
  }
}

async function responseDigest(response: Response): Promise<{
  bytes: number;
  sha256: string;
}> {
  if (!response.body) throw new Error("release asset download returned no body");
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function verifyRemoteBytes(
  apiBaseUrl: string,
  repository: string,
  release: ReleaseRecord,
  local: readonly LocalAsset[],
  token: string,
): Promise<void> {
  const expected = new Map(local.map((asset) => [asset.name, asset]));
  for (const asset of [...release.assets].sort((a, b) => a.name.localeCompare(b.name))) {
    const response = await request(
      apiUrl(
        apiBaseUrl,
        `repos/${repository}/releases/assets/${asset.id}`,
      ),
      token,
      { headers: { Accept: "application/octet-stream" } },
    );
    if (response.status !== 200) throw await responseFailure(response);
    const actual = await responseDigest(response);
    const wanted = expected.get(asset.name);
    if (
      !wanted ||
      actual.bytes !== wanted.bytes ||
      actual.sha256 !== wanted.sha256
    ) {
      throw new Error(`downloaded release asset differs for ${asset.name}`);
    }
  }
}

// Raised when the remote release no longer matches the bytes and metadata
// this run uploaded and verified. The staging draft (or the published release)
// is then evidence of interference and is retained for the release owner.
class PublicationEvidenceError extends Error {}

function assertSameAssets(
  verified: ReleaseRecord,
  current: ReleaseRecord,
  when: string,
): void {
  const ids = (record: ReleaseRecord) =>
    JSON.stringify(
      [...record.assets]
        .sort((a, b) => a.id - b.id)
        .map((asset) => [asset.id, asset.name, asset.size, asset.state]),
    );
  if (ids(verified) !== ids(current)) {
    throw new PublicationEvidenceError(
      `release assets changed ${when}; the verified inventory was replaced`,
    );
  }
}

async function leftoverStagingDrafts(
  releasesUrl: string,
  token: string,
): Promise<string[]> {
  const leftovers: string[] = [];
  let next: string | null = `${releasesUrl}?per_page=100`;
  while (next) {
    const response = await request(next, token);
    if (response.status !== 200) throw await responseFailure(response);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("release list API response must be an array");
    for (const entry of page) {
      if (
        entry &&
        typeof entry === "object" &&
        "draft" in entry &&
        entry.draft === true &&
        "tag_name" in entry &&
        typeof entry.tag_name === "string" &&
        entry.tag_name.startsWith("aidlc-staging-")
      ) {
        leftovers.push(entry.tag_name);
      }
    }
    const link = response.headers.get("link") ?? "";
    next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
  }
  return leftovers.sort();
}

export async function publishRelease(
  options: PublishReleaseOptions,
): Promise<PublishedRelease> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new Error(`invalid GitHub repository ${JSON.stringify(options.repository)}`);
  }
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(options.tag)) {
    throw new Error(`invalid release tag ${JSON.stringify(options.tag)}`);
  }
  if (!/^aidlc-staging-[A-Za-z0-9._-]+$/.test(options.stagingTag)) {
    throw new Error(`invalid staging tag ${JSON.stringify(options.stagingTag)}`);
  }
  if (!/^[a-f0-9]{40}$/.test(options.targetCommitish)) {
    throw new Error("target commit must be a lowercase 40-hex commit");
  }
  if (!options.token) throw new Error("missing GitHub token");

  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const expectedAssetCount = options.expectedAssetCount ?? 13;
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const local = await localAssets(options.directory, expectedAssetCount);
  const releasesUrl = apiUrl(
    apiBaseUrl,
    `repos/${options.repository}/releases`,
  );
  await requireTagAbsent(
    apiBaseUrl,
    options.repository,
    options.tag,
    options.token,
  );
  await requireTagAbsent(
    apiBaseUrl,
    options.repository,
    options.stagingTag,
    options.token,
  );
  // A leftover draft means an earlier run stopped after creating evidence or
  // failed to clean up. It must be inspected and removed deliberately before
  // another candidate is staged, so drafts never accumulate unnoticed.
  const leftovers = await leftoverStagingDrafts(releasesUrl, options.token);
  if (leftovers.length > 0) {
    throw new Error(
      `staging draft${leftovers.length === 1 ? "" : "s"} from an earlier run must be removed first: ${
        leftovers.join(", ")
      }; inspect each, then run: gh release delete <staging-tag> --repo ${options.repository} --yes`,
    );
  }
  const notes = releaseNotes(options.notes);
  const created = await requestJson<unknown>(
    releasesUrl,
    options.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: options.stagingTag,
        target_commitish: options.targetCommitish,
        name: notes.name,
        body: notes.body,
        draft: true,
        prerelease: false,
      }),
    },
    201,
  );
  let release = releaseRecord(created.value);
  const releaseUrl = apiUrl(
    apiBaseUrl,
    `repos/${options.repository}/releases/${release.id}`,
  );
  const assetUploadUrl = uploadEndpoint(apiBaseUrl, release.upload_url);
  let verified: ReleaseRecord | null = null;
  const uploaded: ReleaseAsset[] = [];
  let publishAttempted = false;

  const completePublished = async (
    candidate: ReleaseRecord,
  ): Promise<PublishedRelease> => {
    try {
      assertReleaseIdentity(
        candidate,
        options.tag,
        options.targetCommitish,
        notes,
        false,
        true,
      );
      assertAssetInventory(candidate, local);
      if (verified) assertSameAssets(verified, candidate, "between verification and publication");
      await requireTagTarget(
        apiBaseUrl,
        options.repository,
        options.tag,
        options.targetCommitish,
        options.token,
      );
      await verifyRemoteBytes(
        apiBaseUrl,
        options.repository,
        candidate,
        local,
        options.token,
      );
    } catch (error) {
      // The release is already public and immutable: it cannot be withdrawn,
      // only superseded. Report it as a compromised publication.
      throw new PublicationEvidenceError(
        `published release ${options.tag} differs from the verified candidate (${
          error instanceof Error ? error.message : String(error)
        }); treat it as compromised and supersede it with a corrective release`,
      );
    }
    log(`published immutable release ${options.tag} with ${local.length} verified assets`);
    return {
      id: candidate.id,
      tag: candidate.tag_name,
      assets: local.map((asset) => asset.name),
    };
  };

  const recoverAmbiguousPublish = async (
    cause: Error,
  ): Promise<PublishedRelease> => {
    let observed: ReleaseRecord;
    try {
      observed = (await getRelease(releaseUrl, options.token)).release;
    } catch (observationError) {
      throw new Error(
        `${cause.message}; publication outcome could not be read safely: ${
          observationError instanceof Error
            ? observationError.message
            : String(observationError)
        }`,
      );
    }
    if (observed.draft) throw cause;
    if (!observed.immutable) {
      throw new Error(
        `${cause.message}; publication outcome is neither a draft nor an immutable release`,
      );
    }
    return await completePublished(observed);
  };

  // Deletes the staging draft after a failure this run caused (API errors,
  // network faults, malformed responses). Anything that indicates another
  // principal touched the release is retained instead: a draft whose identity
  // or asset set no longer matches what this run created and uploaded, a
  // release that is no longer our draft, or any state reached after
  // publication was attempted. The comparison uses the last snapshot this run
  // owns: the verified release once verification passed, otherwise the assets
  // it uploaded so far (every asset replacement on GitHub changes the id).
  const cleanupOrRetain = async (error: unknown): Promise<void> => {
    const reason = error instanceof Error ? error.message : String(error);
    const retained = (why: string) =>
      log(
        `release ${release.id} for staging tag ${options.stagingTag} was retained for inspection: ${why}; ` +
          `remove it deliberately with: gh release delete ${options.stagingTag} --repo ${options.repository} --yes`,
      );
    if (publishAttempted) {
      retained("publication was attempted, so the release may already be public");
      return;
    }
    if (error instanceof PublicationEvidenceError) {
      retained(reason);
      return;
    }
    let observed: ReleaseRecord;
    try {
      observed = (await getRelease(releaseUrl, options.token)).release;
    } catch (observationError) {
      retained(
        `its current state could not be read: ${
          observationError instanceof Error
            ? observationError.message
            : String(observationError)
        }`,
      );
      return;
    }
    try {
      assertReleaseIdentity(
        observed,
        options.stagingTag,
        options.targetCommitish,
        notes,
        true,
        false,
      );
      assertSameAssets(
        verified ?? { ...release, assets: uploaded },
        observed,
        "before the failed run could clean up",
      );
    } catch (mismatch) {
      retained(
        `it no longer matches what this run created (${
          mismatch instanceof Error ? mismatch.message : String(mismatch)
        })`,
      );
      return;
    }
    const deleted = await request(releaseUrl, options.token, { method: "DELETE" });
    if (deleted.status !== 204) {
      await deleted.text();
      retained(`deleting it returned HTTP ${deleted.status}`);
      return;
    }
    log(`deleted staging draft ${options.stagingTag} after the failure: ${reason}`);
  };

  try {
    assertReleaseIdentity(
      release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    for (const asset of local) {
      uploaded.push(await uploadAsset(
        assetUploadUrl,
        options.token,
        asset.name,
        Bun.file(asset.path),
      ));
    }

    // Verify the exact remote state: identity, inventory, and every byte.
    const snapshot = await getRelease(releaseUrl, options.token);
    try {
      assertReleaseIdentity(
        snapshot.release,
        options.stagingTag,
        options.targetCommitish,
        notes,
        true,
        false,
      );
      assertAssetInventory(snapshot.release, local);
      await verifyRemoteBytes(
        apiBaseUrl,
        options.repository,
        snapshot.release,
        local,
        options.token,
      );
    } catch (error) {
      if (error instanceof PublicationEvidenceError) throw error;
      throw new PublicationEvidenceError(
        error instanceof Error ? error.message : String(error),
      );
    }
    // The draft must not have moved while its bytes were read. GitHub does not
    // honour If-Match on release updates (it answers 400), so this re-read is
    // the last observation before publication; the window between it and the
    // update is closed after the fact by completePublished().
    const afterVerification = await getRelease(releaseUrl, options.token);
    if (afterVerification.etag !== snapshot.etag) {
      throw new PublicationEvidenceError(
        "draft release changed while remote bytes were verified",
      );
    }
    try {
      assertReleaseIdentity(
        afterVerification.release,
        options.stagingTag,
        options.targetCommitish,
        notes,
        true,
        false,
      );
    } catch (error) {
      throw new PublicationEvidenceError(
        error instanceof Error ? error.message : String(error),
      );
    }
    assertSameAssets(snapshot.release, afterVerification.release, "while remote bytes were verified");
    verified = afterVerification.release;
    await requireTagAbsent(
      apiBaseUrl,
      options.repository,
      options.tag,
      options.token,
    );

    publishAttempted = true;
    let publishedResponse: Response;
    try {
      publishedResponse = await request(releaseUrl, options.token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: options.tag,
          target_commitish: options.targetCommitish,
          name: notes.name,
          body: notes.body,
          draft: false,
        }),
      });
    } catch (error) {
      return await recoverAmbiguousPublish(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (publishedResponse.status !== 200) {
      return await recoverAmbiguousPublish(
        await responseFailure(publishedResponse),
      );
    }
    try {
      release = releaseRecord(await publishedResponse.json());
    } catch (error) {
      return await recoverAmbiguousPublish(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return await completePublished(release);
  } catch (error) {
    await cleanupOrRetain(error);
    throw error;
  }
}

async function main(argv: string[]): Promise<void> {
  const expectedAssetCount = Number(requiredOption(argv, "--expected-assets"));
  if (!Number.isInteger(expectedAssetCount) || expectedAssetCount < 1) {
    throw new Error("--expected-assets must be a positive integer");
  }
  const tag = requiredOption(argv, "--tag");
  await publishRelease({
    directory: requiredOption(argv, "--directory"),
    tag,
    stagingTag: requiredOption(argv, "--staging-tag"),
    targetCommitish: requiredOption(argv, "--target"),
    repository: requiredOption(argv, "--repository"),
    notes: releaseNotesFromChangelog(requiredOption(argv, "--changelog"), tag),
    token: process.env.GH_TOKEN ?? "",
    apiBaseUrl: process.env.GITHUB_API_URL,
    expectedAssetCount,
  });
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `publish-release: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

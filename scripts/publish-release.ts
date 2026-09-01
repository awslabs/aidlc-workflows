#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, statSync } from "node:fs";
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

function requestHeaders(
  token: string,
  extra: Record<string, string> = {},
): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "aidlc-release-publisher",
    "X-GitHub-Api-Version": API_VERSION,
    ...extra,
  });
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
    headers: requestHeaders(
      token,
      Object.fromEntries(new Headers(init.headers).entries()),
    ),
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

async function conditionalPatch(
  releaseUrl: string,
  token: string,
  etag: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await request(releaseUrl, token, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "If-Match": etag,
    },
    body: JSON.stringify(body),
  });
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
  const notes = releaseNotes(
    (await requestJson<unknown>(
      `${releasesUrl}/generate-notes`,
      options.token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: options.tag,
          target_commitish: options.targetCommitish,
        }),
      },
      200,
    )).value,
  );
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

  const completePublished = async (
    candidate: ReleaseRecord,
  ): Promise<PublishedRelease> => {
    assertReleaseIdentity(
      candidate,
      options.tag,
      options.targetCommitish,
      notes,
      false,
      true,
    );
    assertAssetInventory(candidate, local);
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

  try {
    assertReleaseIdentity(
      release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    const initial = await getRelease(releaseUrl, options.token);

    for (const asset of local) {
      await uploadAsset(
        assetUploadUrl,
        options.token,
        asset.name,
        Bun.file(asset.path),
      );
    }
    let current = await getRelease(releaseUrl, options.token);
    if (current.etag === initial.etag) {
      throw new Error("release ETag did not change after asset uploads");
    }

    const probeName = `aidlc-publication-etag-probe-${randomUUID()}.txt`;
    const probe = await uploadAsset(
      assetUploadUrl,
      options.token,
      probeName,
      new TextEncoder().encode("aidlc publication ETag probe\n"),
    );
    const afterProbe = await getRelease(releaseUrl, options.token);
    if (afterProbe.etag === current.etag) {
      throw new Error("release ETag is not coupled to asset creation");
    }

    const renamedProbe = `${probeName}.renamed`;
    const renamed = await requestJson<unknown>(
      apiUrl(
        apiBaseUrl,
        `repos/${options.repository}/releases/assets/${probe.id}`,
      ),
      options.token,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renamedProbe }),
      },
      200,
    );
    if (assetRecord(renamed.value).name !== renamedProbe) {
      throw new Error("release asset metadata probe was not applied");
    }
    const afterRename = await getRelease(releaseUrl, options.token);
    if (afterRename.etag === afterProbe.etag) {
      throw new Error("release ETag is not coupled to asset metadata changes");
    }

    const deleted = await request(
      apiUrl(
        apiBaseUrl,
        `repos/${options.repository}/releases/assets/${probe.id}`,
      ),
      options.token,
      { method: "DELETE" },
    );
    if (deleted.status !== 204) throw await responseFailure(deleted);
    current = await getRelease(releaseUrl, options.token);
    if (current.etag === afterRename.etag) {
      throw new Error("release ETag is not coupled to asset deletion");
    }
    assertReleaseIdentity(
      current.release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    assertAssetInventory(current.release, local);

    const supported = await conditionalPatch(
      releaseUrl,
      options.token,
      current.etag,
      { draft: true },
    );
    if (supported.status !== 200) throw await responseFailure(supported);
    release = releaseRecord(await supported.json());
    assertReleaseIdentity(
      release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    assertAssetInventory(release, local);

    current = await getRelease(releaseUrl, options.token);
    const stale = await conditionalPatch(
      releaseUrl,
      options.token,
      `"aidlc-stale-etag-${randomUUID()}"`,
      { draft: true },
    );
    if (stale.status !== 412) {
      throw new Error(
        `release API did not enforce a stale If-Match precondition; status ${stale.status}`,
      );
    }
    await stale.text();
    const afterStale = await getRelease(releaseUrl, options.token);
    if (afterStale.etag !== current.etag) {
      throw new Error("stale If-Match request changed the draft release");
    }
    assertReleaseIdentity(
      afterStale.release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    assertAssetInventory(afterStale.release, local);
    await verifyRemoteBytes(
      apiBaseUrl,
      options.repository,
      afterStale.release,
      local,
      options.token,
    );
    const afterVerification = await getRelease(releaseUrl, options.token);
    if (afterVerification.etag !== afterStale.etag) {
      throw new Error("draft release changed while remote bytes were verified");
    }
    assertReleaseIdentity(
      afterVerification.release,
      options.stagingTag,
      options.targetCommitish,
      notes,
      true,
      false,
    );
    assertAssetInventory(afterVerification.release, local);
    await requireTagAbsent(
      apiBaseUrl,
      options.repository,
      options.tag,
      options.token,
    );

    let publishedResponse: Response;
    try {
      publishedResponse = await conditionalPatch(
        releaseUrl,
        options.token,
        afterVerification.etag,
        {
          tag_name: options.tag,
          target_commitish: options.targetCommitish,
          name: notes.name,
          body: notes.body,
          draft: false,
        },
      );
    } catch (error) {
      return await recoverAmbiguousPublish(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (publishedResponse.status === 412) {
      throw new Error("draft release changed before conditional publication");
    }
    if (publishedResponse.status !== 200) {
      return await recoverAmbiguousPublish(
        await responseFailure(publishedResponse),
      );
    }
    try {
      release = releaseRecord(await publishedResponse.json());
      return await completePublished(release);
    } catch (error) {
      return await recoverAmbiguousPublish(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  } catch (error) {
    log(
      `release ${release.id} for staging tag ${options.stagingTag} was retained for inspection`,
    );
    throw error;
  }
}

async function main(argv: string[]): Promise<void> {
  const expectedAssetCount = Number(requiredOption(argv, "--expected-assets"));
  if (!Number.isInteger(expectedAssetCount) || expectedAssetCount < 1) {
    throw new Error("--expected-assets must be a positive integer");
  }
  await publishRelease({
    directory: requiredOption(argv, "--directory"),
    tag: requiredOption(argv, "--tag"),
    stagingTag: requiredOption(argv, "--staging-tag"),
    targetCommitish: requiredOption(argv, "--target"),
    repository: requiredOption(argv, "--repository"),
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

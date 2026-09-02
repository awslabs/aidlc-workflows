import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishRelease,
  type PublishedRelease,
} from "../../scripts/publish-release.ts";

type MockAsset = {
  id: number;
  name: string;
  bytes: Uint8Array;
};

type MockOptions = {
  finalTagPreexists?: boolean;
  leftoverStagingDrafts?: string[];
  failFinalTagLookupAfterUpload?: boolean;
  malformedPublishResponse?: boolean;
  mutateDuringVerification?: boolean;
  mutateNotesAfterVerification?: boolean;
  publishErrorBodyFails?: boolean;
  publishReturnsError?: boolean;
  raceBeforePublish?: boolean;
};

type MockState = {
  deleted: boolean;
  listed: boolean;
  tag: string;
  targetCommitish: string;
  name: string;
  body: string;
  finalTagTarget: string | null;
  stagingTagTarget: string | null;
  notesTag: string | null;
  draft: boolean;
  immutable: boolean;
  assets: MockAsset[];
  raceInjected: boolean;
  notesMutationInjected: boolean;
  verificationMutationInjected: boolean;
};

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-t305-release-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "checksums.txt"), "checksums\n");
  writeFileSync(join(root, "install.sh"), "#!/bin/sh\n");
  writeFileSync(join(root, "version.json"), '{"version":"1.2.3"}\n');
  return root;
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      ...headers,
      "Cache-Control": "no-store",
    },
  });
}

function serveMock(options: MockOptions = {}): {
  baseUrl: string;
  state: MockState;
} {
  const state: MockState = {
    deleted: false,
    listed: false,
    tag: "aidlc-staging-run-1",
    targetCommitish: "1".repeat(40),
    name: "Release v1.2.3",
    body: "generated notes\n",
    finalTagTarget: options.finalTagPreexists ? "2".repeat(40) : null,
    stagingTagTarget: null,
    notesTag: null,
    draft: true,
    immutable: false,
    assets: [],
    raceInjected: false,
    notesMutationInjected: false,
    verificationMutationInjected: false,
  };
  let revision = 1;
  let nextAssetId = 10;
  let baseUrl = "";
  let draftDownloadCount = 0;
  let mutateOnNextReleaseRead = false;
  let finalTagLookups = 0;
  const etag = (): string => `W/"release-${revision}"`;
  const mutateAssetState = (): void => {
    revision++;
  };
  // GitHub rejects every conditional header on unsafe methods with this exact
  // 400; a publisher that relies on If-Match can never publish.
  const conditionalRejection = (request: Request): Response | null => {
    if (request.method === "GET") return null;
    for (const header of ["if-match", "if-none-match", "if-unmodified-since", "if-modified-since"]) {
      if (request.headers.has(header)) {
        return json({
          message: "Bad Request",
          documentation_url:
            "https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate",
          errors: [
            "Conditional request headers are not allowed in unsafe requests unless supported by the endpoint",
          ],
          status: "400",
        }, 400);
      }
    }
    return null;
  };
  const release = () => ({
    id: 1,
    tag_name: state.tag,
    target_commitish: state.targetCommitish,
    name: state.name,
    body: state.body,
    draft: state.draft,
    immutable: state.immutable,
    prerelease: false,
    upload_url: `${baseUrl}/uploads/1{?name,label}`,
    assets: state.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      size: asset.bytes.byteLength,
      state: "uploaded",
    })),
  });

  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      if (request.headers.get("authorization") !== "Bearer test-token") {
        return json({ message: "unauthorized" }, 401);
      }
      const rejected = conditionalRejection(request);
      if (rejected) return rejected;

      if (
        url.pathname === "/repos/owner/repo/releases/generate-notes" &&
        method === "POST"
      ) {
        const body = await request.json() as {
          tag_name?: string;
          target_commitish?: string;
        };
        if (
          body.tag_name !== "v1.2.3" ||
          body.target_commitish !== "1".repeat(40)
        ) {
          return json({ message: "invalid notes target" }, 422);
        }
        state.notesTag = body.tag_name;
        return json({
          name: "Release v1.2.3",
          body: "generated notes\n",
        });
      }

      if (url.pathname === "/repos/owner/repo/releases" && method === "GET") {
        state.listed = true;
        return json([
          ...(options.leftoverStagingDrafts ?? []).map((tag, index) => ({
            id: 900 + index,
            tag_name: tag,
            draft: true,
          })),
          { id: 800, tag_name: "v1.0.0", draft: false },
          { id: 801, tag_name: "aidlc-staging-published-elsewhere", draft: false },
        ]);
      }

      if (url.pathname === "/repos/owner/repo/releases" && method === "POST") {
        if (!state.deleted && state.assets.length > 0) {
          return json({ message: "already exists" }, 422);
        }
        const body = await request.json() as {
          tag_name?: string;
          target_commitish?: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
        };
        if (
          body.tag_name !== "aidlc-staging-run-1" ||
          body.target_commitish !== "1".repeat(40) ||
          body.name !== "Release v1.2.3" ||
          body.body !== "generated notes\n" ||
          body.draft !== true ||
          body.prerelease !== false
        ) {
          return json({ message: "invalid create body" }, 422);
        }
        state.deleted = false;
        state.tag = body.tag_name;
        state.targetCommitish = body.target_commitish;
        state.name = body.name;
        state.body = body.body;
        state.finalTagTarget = null;
        state.stagingTagTarget = body.target_commitish;
        state.draft = true;
        state.immutable = false;
        state.assets = [];
        revision++;
        return json(release(), 201, { ETag: etag() });
      }

      const tagMatch =
        /^\/repos\/owner\/repo\/git\/ref\/tags\/([^/]+)$/.exec(url.pathname);
      if (tagMatch && method === "GET") {
        const tag = decodeURIComponent(tagMatch[1]);
        if (tag === "v1.2.3") {
          finalTagLookups++;
          // The first lookup runs before the draft exists; the second is the
          // pre-publication recheck after every asset was uploaded.
          if (options.failFinalTagLookupAfterUpload && finalTagLookups === 2) {
            return json({ message: "upstream unavailable" }, 502);
          }
        }
        const target = tag === "v1.2.3"
          ? state.finalTagTarget
          : tag === "aidlc-staging-run-1"
          ? state.stagingTagTarget
          : null;
        if (!target) {
          return json({ message: "not found" }, 404);
        }
        return json({
          ref: `refs/tags/${tag}`,
          object: {
            type: "commit",
            sha: target,
          },
        });
      }

      if (url.pathname === "/uploads/1" && method === "POST") {
        const name = url.searchParams.get("name");
        if (!name || state.assets.some((asset) => asset.name === name)) {
          return json({ message: "invalid asset name" }, 422);
        }
        const asset: MockAsset = {
          id: nextAssetId++,
          name,
          bytes: new Uint8Array(await request.arrayBuffer()),
        };
        state.assets.push(asset);
        mutateAssetState();
        return json({
          id: asset.id,
          name: asset.name,
          size: asset.bytes.byteLength,
          state: "uploaded",
        }, 201);
      }

      const assetMatch =
        /^\/repos\/owner\/repo\/releases\/assets\/([0-9]+)$/.exec(url.pathname);
      if (assetMatch) {
        const id = Number(assetMatch[1]);
        const index = state.assets.findIndex((asset) => asset.id === id);
        if (index < 0) return json({ message: "not found" }, 404);
        const asset = state.assets[index];
        if (method === "GET") {
          // GitHub serves asset bytes only for an exact
          // `Accept: application/octet-stream`; any other value (including a
          // list that merely contains it) returns the asset's JSON metadata.
          if (request.headers.get("accept") !== "application/octet-stream") {
            return json({
              id: asset.id,
              name: asset.name,
              size: asset.bytes.byteLength,
              state: "uploaded",
            });
          }
          if (
            state.draft &&
            (options.mutateDuringVerification || options.mutateNotesAfterVerification)
          ) {
            draftDownloadCount++;
            if (draftDownloadCount === 3) mutateOnNextReleaseRead = true;
          }
          return new Response(asset.bytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (method === "PATCH") {
          const body = await request.json() as { name?: string };
          if (!body.name) return json({ message: "missing name" }, 422);
          asset.name = body.name;
          mutateAssetState();
          return json({
            id: asset.id,
            name: asset.name,
            size: asset.bytes.byteLength,
            state: "uploaded",
          });
        }
        if (method === "DELETE") {
          state.assets.splice(index, 1);
          mutateAssetState();
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === "/repos/owner/repo/releases/1") {
        if (state.deleted) return json({ message: "not found" }, 404);
        if (method === "GET") {
          if (mutateOnNextReleaseRead) {
            mutateOnNextReleaseRead = false;
            if (options.mutateNotesAfterVerification) {
              state.notesMutationInjected = true;
              state.name = "Injected title";
              state.body = "Injected body\n";
            } else {
              state.verificationMutationInjected = true;
              if (state.assets[0]) {
                state.assets[0].bytes = new TextEncoder().encode("tampered!\n");
              }
            }
            revision++;
          }
          return json(release(), 200, { ETag: etag() });
        }
        if (method === "DELETE") {
          if (!state.draft) return json({ message: "immutable releases cannot be deleted" }, 422);
          state.deleted = true;
          return new Response(null, { status: 204 });
        }
        if (method === "PATCH") {
          const body = await request.json() as {
            tag_name?: string;
            target_commitish?: string;
            name?: string;
            body?: string;
            draft?: boolean;
          };
          if (
            body.draft === false &&
            options.raceBeforePublish &&
            !state.raceInjected
          ) {
            state.raceInjected = true;
            if (state.assets[0]) {
              state.assets[0].bytes = new TextEncoder().encode("tampered!\n");
            }
            revision++;
          }
          if (body.draft === false) {
            if (
              body.tag_name !== "v1.2.3" ||
              body.target_commitish !== "1".repeat(40) ||
              body.name !== "Release v1.2.3" ||
              body.body !== "generated notes\n"
            ) {
              return json({ message: "invalid publication target" }, 422);
            }
            state.tag = body.tag_name;
            state.targetCommitish = body.target_commitish;
            state.name = body.name;
            state.body = body.body;
            state.finalTagTarget = body.target_commitish;
            state.draft = false;
            state.immutable = true;
          }
          revision++;
          if (body.draft === false && options.publishReturnsError) {
            return json({ message: "response lost after commit" }, 502);
          }
          if (body.draft === false && options.publishErrorBodyFails) {
            return new Response("not a gzip stream", {
              status: 502,
              headers: { "Content-Encoding": "gzip" },
            });
          }
          if (body.draft === false && options.malformedPublishResponse) {
            return new Response("{", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return json(release(), 200, { ETag: etag() });
        }
      }

      return json({ message: "not found" }, 404);
    },
  });
  servers.push(server);
  baseUrl = `http://127.0.0.1:${server.port}`;
  return { baseUrl, state };
}

async function run(
  baseUrl: string,
): Promise<PublishedRelease> {
  return await publishRelease({
    directory: fixture(),
    tag: "v1.2.3",
    stagingTag: "aidlc-staging-run-1",
    targetCommitish: "1".repeat(40),
    repository: "owner/repo",
    token: "test-token",
    apiBaseUrl: baseUrl,
    expectedAssetCount: 3,
    log: () => {},
  });
}

describe("t305 verified immutable release publication", () => {
  test("publishes the exact verified draft without conditional request headers", async () => {
    const { baseUrl, state } = serveMock();
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(result.assets).toEqual([
      "checksums.txt",
      "install.sh",
      "version.json",
    ]);
    expect(state.listed).toBe(true);
    expect(state.deleted).toBe(false);
    expect(state.tag).toBe("v1.2.3");
    expect(state.name).toBe("Release v1.2.3");
    expect(state.body).toBe("generated notes\n");
    expect(state.finalTagTarget).toBe("1".repeat(40));
    expect(state.stagingTagTarget).toBe("1".repeat(40));
    expect(state.notesTag).toBe("v1.2.3");
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.assets.map((asset) => asset.name).sort()).toEqual(result.assets);
  });

  test("refuses to stage while a draft from an earlier run remains", async () => {
    const { baseUrl, state } = serveMock({
      leftoverStagingDrafts: ["aidlc-staging-run-0", "aidlc-staging-old-9"],
    });
    await expect(run(baseUrl)).rejects.toThrow(
      "staging drafts from an earlier run must be removed first: aidlc-staging-old-9, aidlc-staging-run-0; " +
        "inspect each, then run: gh release delete <staging-tag> --repo owner/repo --yes",
    );

    expect(state.assets).toEqual([]);
    expect(state.stagingTagTarget).toBeNull();
    expect(state.notesTag).toBeNull();
  });

  test("deletes its own staging draft after an ordinary API failure", async () => {
    const { baseUrl, state } = serveMock({ failFinalTagLookupAfterUpload: true });
    await expect(run(baseUrl)).rejects.toThrow("GitHub API 502");

    expect(state.assets.length).toBe(3);
    expect(state.deleted).toBe(true);
    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.finalTagTarget).toBeNull();
  });

  test("retains the draft as evidence when its bytes change during verification", async () => {
    const { baseUrl, state } = serveMock({ mutateDuringVerification: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "draft release changed while remote bytes were verified",
    );

    expect(state.verificationMutationInjected).toBe(true);
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.finalTagTarget).toBeNull();
  });

  test("retains the draft as evidence when its notes change before publication", async () => {
    const { baseUrl, state } = serveMock({ mutateNotesAfterVerification: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "draft release changed while remote bytes were verified",
    );

    expect(state.notesMutationInjected).toBe(true);
    expect(state.name).toBe("Injected title");
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(true);
    expect(state.finalTagTarget).toBeNull();
  });

  test("reports a publication whose assets were replaced in the final window as compromised", async () => {
    // GitHub cannot make the publish update conditional, so a replacement
    // between the last verification read and the update is detected after the
    // fact: the immutable release exists and must be superseded.
    const { baseUrl, state } = serveMock({ raceBeforePublish: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "published release v1.2.3 differs from the verified candidate " +
        "(downloaded release asset differs for checksums.txt); " +
        "treat it as compromised and supersede it with a corrective release",
    );

    expect(state.raceInjected).toBe(true);
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.tag).toBe("v1.2.3");
  });

  test("refuses an occupied official tag before creating a staging release", async () => {
    const { baseUrl, state } = serveMock({ finalTagPreexists: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "release tag already exists: v1.2.3",
    );

    expect(state.assets).toEqual([]);
    expect(state.draft).toBe(true);
    expect(state.finalTagTarget).toBe("2".repeat(40));
    expect(state.stagingTagTarget).toBeNull();
  });

  test("recovers a committed immutable release after an error response", async () => {
    const { baseUrl, state } = serveMock({ publishReturnsError: true });
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(state.tag).toBe("v1.2.3");
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
    expect(state.stagingTagTarget).toBe("1".repeat(40));
  });

  test("recovers a committed release after a malformed 200 response", async () => {
    const { baseUrl, state } = serveMock({ malformedPublishResponse: true });
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(state.name).toBe("Release v1.2.3");
    expect(state.body).toBe("generated notes\n");
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
  });

  test("recovers when a committed error response body is unreadable", async () => {
    const { baseUrl, state } = serveMock({ publishErrorBodyFails: true });
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(state.deleted).toBe(false);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
  });
});

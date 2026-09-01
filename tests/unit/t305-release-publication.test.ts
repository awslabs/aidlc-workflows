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
  coupleAssetEtag?: boolean;
  finalTagPreexists?: boolean;
  ignoreIfMatch?: boolean;
  malformedPublishResponse?: boolean;
  mutateDuringVerification?: boolean;
  mutateNotesAfterSupport?: boolean;
  publishErrorBodyFails?: boolean;
  publishReturnsError?: boolean;
  raceBeforePublish?: boolean;
};

type MockState = {
  deleted: boolean;
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
  const etag = (): string => `W/"release-${revision}"`;
  const ifMatchEtag = (): string => etag().replace(/^W\//, "");
  const mutateAssetState = (): void => {
    if (options.coupleAssetEtag !== false) revision++;
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
          if (state.draft && options.mutateDuringVerification) {
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
            state.verificationMutationInjected = true;
            if (state.assets[0]) {
              state.assets[0].bytes = new TextEncoder().encode("tampered!\n");
            }
            revision++;
          }
          return json(release(), 200, { ETag: etag() });
        }
        if (method === "DELETE") {
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
              state.assets[0].bytes = new TextEncoder().encode("concurrent replacement\n");
            }
            revision++;
          }
          if (
            !options.ignoreIfMatch &&
            request.headers.get("if-match") !== ifMatchEtag()
          ) {
            return json({ message: "precondition failed" }, 412);
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
          if (
            body.draft === true &&
            options.mutateNotesAfterSupport &&
            !state.notesMutationInjected
          ) {
            state.notesMutationInjected = true;
            state.name = "Injected title";
            state.body = "Injected body\n";
            revision++;
          }
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

describe("t305 conditional immutable release publication", () => {
  test("publishes only the exact verified draft through a matching ETag", async () => {
    const { baseUrl, state } = serveMock();
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(result.assets).toEqual([
      "checksums.txt",
      "install.sh",
      "version.json",
    ]);
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

  test("a concurrent draft mutation returns 412 and retains only the staging draft", async () => {
    const { baseUrl, state } = serveMock({ raceBeforePublish: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "draft release changed before conditional publication",
    );

    expect(state.raceInjected).toBe(true);
    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.tag).toBe("aidlc-staging-run-1");
    expect(state.finalTagTarget).toBeNull();
    expect(state.stagingTagTarget).toBe("1".repeat(40));
    expect(state.deleted).toBe(false);
  });

  test("fails closed when the API ignores If-Match", async () => {
    const { baseUrl, state } = serveMock({ ignoreIfMatch: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "release API did not enforce a stale If-Match precondition",
    );

    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.finalTagTarget).toBeNull();
    expect(state.stagingTagTarget).toBe("1".repeat(40));
    expect(state.deleted).toBe(false);
  });

  test("fails closed when release ETags are not coupled to asset mutations", async () => {
    const { baseUrl, state } = serveMock({ coupleAssetEtag: false });
    await expect(run(baseUrl)).rejects.toThrow(
      "release ETag did not change after asset uploads",
    );

    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.finalTagTarget).toBeNull();
    expect(state.stagingTagTarget).toBe("1".repeat(40));
    expect(state.deleted).toBe(false);
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
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
    expect(state.stagingTagTarget).toBe("1".repeat(40));
  });

  test("rejects draft release-note mutation before publication", async () => {
    const { baseUrl, state } = serveMock({ mutateNotesAfterSupport: true });
    await expect(run(baseUrl)).rejects.toThrow("release identity mismatch");

    expect(state.notesMutationInjected).toBe(true);
    expect(state.name).toBe("Injected title");
    expect(state.draft).toBe(true);
    expect(state.finalTagTarget).toBeNull();
  });

  test("recovers a committed release after a malformed 200 response", async () => {
    const { baseUrl, state } = serveMock({ malformedPublishResponse: true });
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(state.name).toBe("Release v1.2.3");
    expect(state.body).toBe("generated notes\n");
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
  });

  test("recovers when a committed error response body is unreadable", async () => {
    const { baseUrl, state } = serveMock({ publishErrorBodyFails: true });
    const result = await run(baseUrl);

    expect(result.tag).toBe("v1.2.3");
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.finalTagTarget).toBe("1".repeat(40));
  });

  test("rejects a same-size asset replacement during remote verification", async () => {
    const { baseUrl, state } = serveMock({ mutateDuringVerification: true });
    await expect(run(baseUrl)).rejects.toThrow(
      "draft release changed while remote bytes were verified",
    );

    expect(state.verificationMutationInjected).toBe(true);
    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.finalTagTarget).toBeNull();
  });
});

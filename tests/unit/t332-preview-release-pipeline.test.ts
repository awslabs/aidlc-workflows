// t332: the preview publication pipeline. The publisher stages the same draft
// as a stable release, then binds it to an annotated preview tag whose message
// records the source commit, and publishes it as a prerelease that never
// becomes "latest". The planner skips a day with a published preview or an
// unchanged main, allocates the day's build counter from occupied preview ids,
// and renders notes from the CHANGELOG sections (or commit subjects) added
// since the previous preview's source commit. The workflow contract pins the
// schedule/manual trigger, CI gate ordering, and stamped build environment.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW_CHANNEL, STABLE_CHANNEL } from "../../core/tools/aidlc-channel.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  githubApiClient,
  nextPreviewVersion,
  planPreviewRelease,
  previewReleaseNotes,
} from "../../scripts/plan-preview-release.ts";
import {
  parsePreviewTagSource,
  previewReleaseName,
  previewTagMessage,
  readPreviewPlan,
} from "../../scripts/preview-release.ts";
import { publishRelease } from "../../scripts/publish-release.ts";

const REPO_ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");
const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

const [MAJOR, MINOR, PATCH] = AIDLC_VERSION.split(".").map(Number);
const NEXT_STABLE = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const SOURCE_A = "a".repeat(40);
const TARGET = "1".repeat(40);
const PREVIEW_ID = `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.2`;

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...headers, "Cache-Control": "no-store" } });
}

function releaseDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-t332-release-"));
  roots.push(root);
  writeFileSync(join(root, "checksums.txt"), "checksums\n");
  writeFileSync(join(root, "install.sh"), "#!/bin/sh\n");
  writeFileSync(join(root, "version.json"), `{"version":"${PREVIEW_ID}"}\n`);
  return root;
}

type MockRelease = {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string | null;
};

type PublishMockState = {
  tag: string;
  draft: boolean;
  immutable: boolean;
  prerelease: boolean;
  makeLatest: string | null;
  finalTagObject: { sha: string; message: string; target: string } | null;
  finalRef: string | null;
  assets: Array<{ id: number; name: string; bytes: Uint8Array }>;
  writes: string[];
};

// A GitHub-shaped publication repository: the draft flow of t305 plus the git
// tag-object and ref endpoints an annotated preview tag needs.
function servePublishMock(
  additionalReleases: MockRelease[] = [],
): { baseUrl: string; state: PublishMockState } {
  const state: PublishMockState = {
    tag: "aidlc-staging-run-1",
    draft: true,
    immutable: false,
    prerelease: false,
    makeLatest: null,
    finalTagObject: null,
    finalRef: null,
    assets: [],
    writes: [],
  };
  let revision = 1;
  let nextAssetId = 10;
  let baseUrl = "";
  const release = () => ({
    id: 1,
    tag_name: state.tag,
    target_commitish: TARGET,
    name: previewReleaseName(PREVIEW_ID),
    body: "preview notes\n",
    draft: state.draft,
    immutable: state.immutable,
    prerelease: state.prerelease,
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
      if (method !== "GET") state.writes.push(`${method} ${url.pathname}`);
      if (url.pathname === "/repos/owner/repo/releases" && method === "GET") {
        return json([
          { id: 800, tag_name: `v${AIDLC_VERSION}`, draft: false },
          ...additionalReleases.map((release, index) => ({ id: 801 + index, ...release })),
        ]);
      }
      if (url.pathname === "/repos/owner/repo/releases" && method === "POST") {
        const body = await request.json() as { tag_name?: string; draft?: boolean; prerelease?: boolean };
        if (body.tag_name !== "aidlc-staging-run-1" || body.draft !== true || body.prerelease !== false) {
          return json({ message: "invalid create body" }, 422);
        }
        state.tag = body.tag_name;
        revision++;
        return json(release(), 201, { ETag: `W/"release-${revision}"` });
      }
      const refMatch = /^\/repos\/owner\/repo\/git\/ref\/tags\/([^/]+)$/.exec(url.pathname);
      if (refMatch && method === "GET") {
        const tag = decodeURIComponent(refMatch[1]);
        if (tag === `v${PREVIEW_ID}` && state.finalRef && state.finalTagObject) {
          return json({ ref: state.finalRef, object: { type: "tag", sha: state.finalTagObject.sha } });
        }
        return json({ message: "not found" }, 404);
      }
      if (url.pathname === "/repos/owner/repo/git/tags" && method === "POST") {
        const body = await request.json() as {
          tag?: string;
          message?: string;
          object?: string;
          type?: string;
          tagger?: { name?: string; email?: string; date?: string };
        };
        if (
          body.tag !== `v${PREVIEW_ID}` ||
          body.type !== "commit" ||
          body.object !== TARGET ||
          typeof body.message !== "string" ||
          !body.tagger?.name ||
          !body.tagger.email ||
          !body.tagger.date
        ) {
          return json({ message: "invalid tag object" }, 422);
        }
        state.finalTagObject = { sha: "c".repeat(40), message: body.message, target: body.object };
        return json({ tag: body.tag, sha: state.finalTagObject.sha }, 201);
      }
      const tagObjectMatch = /^\/repos\/owner\/repo\/git\/tags\/([a-f0-9]{40})$/.exec(url.pathname);
      if (tagObjectMatch && method === "GET") {
        if (state.finalTagObject?.sha !== tagObjectMatch[1]) return json({ message: "not found" }, 404);
        return json({
          sha: state.finalTagObject.sha,
          tag: `v${PREVIEW_ID}`,
          message: state.finalTagObject.message,
          object: { type: "commit", sha: state.finalTagObject.target },
        });
      }
      if (url.pathname === "/repos/owner/repo/git/refs" && method === "POST") {
        const body = await request.json() as { ref?: string; sha?: string };
        if (body.ref !== `refs/tags/v${PREVIEW_ID}` || body.sha !== state.finalTagObject?.sha) {
          return json({ message: "invalid ref" }, 422);
        }
        state.finalRef = body.ref;
        return json({ ref: body.ref, object: { type: "tag", sha: body.sha } }, 201);
      }
      if (url.pathname === "/uploads/1" && method === "POST") {
        const name = url.searchParams.get("name");
        if (!name) return json({ message: "invalid asset name" }, 422);
        const asset = { id: nextAssetId++, name, bytes: new Uint8Array(await request.arrayBuffer()) };
        state.assets.push(asset);
        revision++;
        return json({ id: asset.id, name, size: asset.bytes.byteLength, state: "uploaded" }, 201);
      }
      const assetMatch = /^\/repos\/owner\/repo\/releases\/assets\/([0-9]+)$/.exec(url.pathname);
      if (assetMatch && method === "GET") {
        const asset = state.assets.find((candidate) => candidate.id === Number(assetMatch[1]));
        if (!asset) return json({ message: "not found" }, 404);
        return new Response(asset.bytes.slice().buffer as ArrayBuffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (url.pathname === "/repos/owner/repo/releases/1") {
        if (method === "GET") return json(release(), 200, { ETag: `W/"release-${revision}"` });
        if (method === "PATCH") {
          const body = await request.json() as {
            tag_name?: string;
            draft?: boolean;
            prerelease?: boolean;
            make_latest?: string;
          };
          if (body.draft === false) {
            if (body.tag_name !== `v${PREVIEW_ID}` || !state.finalRef) {
              return json({ message: "release tag must exist before publication" }, 422);
            }
            state.tag = body.tag_name;
            state.draft = false;
            state.immutable = true;
            state.prerelease = body.prerelease === true;
            state.makeLatest = body.make_latest ?? null;
          }
          revision++;
          return json(release(), 200, { ETag: `W/"release-${revision}"` });
        }
        if (method === "DELETE") return new Response(null, { status: 204 });
      }
      return json({ message: "not found" }, 404);
    },
  });
  servers.push(server);
  baseUrl = `http://127.0.0.1:${server.port}`;
  return { baseUrl, state };
}

type PlanMockOptions = {
  releases: MockRelease[];
  tags: string[];
  annotated: Record<string, { source: string } | "lightweight">;
  requests?: string[];
};

// The publication repository as the planner sees it: published releases,
// every tag ref under v, and the annotated tag objects with their messages.
function servePlanMock(options: PlanMockOptions): string {
  const tagObjectSha = (tag: string): string => createHash("sha1").update(tag).digest("hex");
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      options.requests?.push(url.pathname);
      if (url.pathname === "/repos/owner/repo/releases") {
        return json(options.releases.map((release, index) => ({ id: index + 1, ...release })));
      }
      if (url.pathname === "/repos/owner/repo/git/matching-refs/tags/v") {
        return json(options.tags.map((tag) => ({
          ref: `refs/tags/${tag}`,
          object: { type: "commit", sha: TARGET },
        })));
      }
      const refMatch = /^\/repos\/owner\/repo\/git\/ref\/tags\/([^/]+)$/.exec(url.pathname);
      if (refMatch) {
        const tag = decodeURIComponent(refMatch[1]);
        const annotated = options.annotated[tag];
        if (!annotated) return json({ message: "not found" }, 404);
        if (annotated === "lightweight") return json({ object: { type: "commit", sha: TARGET } });
        return json({ object: { type: "tag", sha: tagObjectSha(tag) } });
      }
      const tagMatch = /^\/repos\/owner\/repo\/git\/tags\/([a-f0-9]{40})$/.exec(url.pathname);
      if (tagMatch) {
        const entry = Object.entries(options.annotated).find(([tag]) => tagObjectSha(tag) === tagMatch[1]);
        if (!entry || entry[1] === "lightweight") return json({ message: "not found" }, 404);
        return json({
          message: previewTagMessage({
            version: entry[0].slice(1),
            sourceRepository: "owner/source",
            sourceDigest: entry[1].source,
          }),
          object: { type: "commit", sha: TARGET },
        });
      }
      return json({ message: "not found" }, 404);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t332",
      GIT_AUTHOR_EMAIL: "t332@example.invalid",
      GIT_COMMITTER_NAME: "t332",
      GIT_COMMITTER_EMAIL: "t332@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A source history with two CHANGELOG states: the current version's section,
// then a newer section on top of it.
function sourceHistory(): { cwd: string; first: string; second: string; third: string } {
  const cwd = mkdtempSync(join(tmpdir(), "aidlc-t332-source-"));
  roots.push(cwd);
  git(cwd, ["init", "-q", "--initial-branch", "main"]);
  const older = [
    `## [${AIDLC_VERSION}] - 2026-09-01`,
    "",
    "Current section summary.",
    "",
    "* Current bullet.",
    "",
  ].join("\n");
  writeFileSync(join(cwd, "CHANGELOG.md"), `# Changelog\n\n${older}`);
  git(cwd, ["add", "CHANGELOG.md"]);
  git(cwd, ["commit", "-q", "-m", "chore: baseline changelog"]);
  const first = git(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(cwd, "CHANGELOG.md"),
    `# Changelog\n\n## [${NEXT_STABLE}] - 2026-09-03\n\nNext section summary.\n\n* Next bullet.\n\n${older}`,
  );
  git(cwd, ["add", "CHANGELOG.md"]);
  git(cwd, ["commit", "-q", "-m", "feat: next section"]);
  const second = git(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "notes.txt"), "internal refactor\n");
  git(cwd, ["add", "notes.txt"]);
  git(cwd, ["commit", "-q", "-m", "refactor: internal cleanup"]);
  const third = git(cwd, ["rev-parse", "HEAD"]);
  return { cwd, first, second, third };
}

// The mock API must keep serving while the workflow's real planner runs.
async function runWorkflowStep(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bash", "--noprofile", "--norc", "-c", script], {
    cwd,
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      NO_PROXY: "127.0.0.1",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

describe("t332 preview publication pipeline", () => {
  test("the tag message binds a preview to its source commit and parses back", () => {
    const message = previewTagMessage({
      version: PREVIEW_ID,
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
    });
    expect(message).toBe(
      `AI-DLC Workflow ${PREVIEW_ID}\n\nSource: owner/source@${SOURCE_A}\nBuild date: 2026-09-03\n`,
    );
    expect(parsePreviewTagSource(message)).toEqual({ repository: "owner/source", digest: SOURCE_A });
    expect(parsePreviewTagSource("Release v2.7.2\n")).toBeNull();
    expect(() => previewTagMessage({ version: AIDLC_VERSION, sourceRepository: "o/r", sourceDigest: SOURCE_A }))
      .toThrow(`not a ${PREVIEW_CHANNEL} version id`);
    expect(() => previewTagMessage({ version: PREVIEW_ID, sourceRepository: "o/r", sourceDigest: "abc" }))
      .toThrow("source digest");
    expect(previewReleaseName(PREVIEW_ID)).toBe(`AI-DLC Workflow ${PREVIEW_ID}`);
  });

  test("publishing a preview creates an annotated tag and a non-latest prerelease from the verified draft", async () => {
    const { baseUrl, state } = servePublishMock();
    const result = await publishRelease({
      directory: releaseDirectory(),
      tag: `v${PREVIEW_ID}`,
      stagingTag: "aidlc-staging-run-1",
      targetCommitish: TARGET,
      repository: "owner/repo",
      notes: { name: previewReleaseName(PREVIEW_ID), body: "preview notes\n" },
      token: "test-token",
      apiBaseUrl: baseUrl,
      expectedAssetCount: 3,
      log: () => {},
      channel: PREVIEW_CHANNEL,
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
    });
    expect(result.tag).toBe(`v${PREVIEW_ID}`);
    expect(result.assets).toEqual(["checksums.txt", "install.sh", "version.json"]);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(true);
    expect(state.prerelease).toBe(true);
    expect(state.makeLatest).toBe("false");
    expect(state.finalRef).toBe(`refs/tags/v${PREVIEW_ID}`);
    expect(state.finalTagObject?.target).toBe(TARGET);
    expect(parsePreviewTagSource(state.finalTagObject?.message ?? "")).toEqual({
      repository: "owner/source",
      digest: SOURCE_A,
    });
  });

  test("an already published same-day preview refuses publication before staging or uploading", async () => {
    const { baseUrl, state } = servePublishMock([{
      tag_name: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.1`,
      prerelease: true,
      draft: false,
      published_at: "2026-09-03T04:00:00Z",
    }]);
    await expect(publishRelease({
      directory: releaseDirectory(),
      tag: `v${PREVIEW_ID}`,
      stagingTag: "aidlc-staging-run-1",
      targetCommitish: TARGET,
      repository: "owner/repo",
      notes: { name: previewReleaseName(PREVIEW_ID), body: "preview notes\n" },
      token: "test-token",
      apiBaseUrl: baseUrl,
      expectedAssetCount: 3,
      log: () => {},
      channel: PREVIEW_CHANNEL,
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
      now: () => new Date("2026-09-03T12:00:00Z"),
    })).rejects.toThrow("a preview is already published for UTC date 20260903; daily limit reached");
    expect(state.writes).toEqual([]);
    expect(state.assets).toEqual([]);
    expect(state.tag).toBe("aidlc-staging-run-1");
    expect(state.finalTagObject).toBeNull();
    expect(state.finalRef).toBeNull();
    expect(state.draft).toBe(true);
  });

  test("publication rechecks the UTC date after midnight and refuses before creating the final tag", async () => {
    const { baseUrl, state } = servePublishMock([{
      tag_name: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`,
      prerelease: true,
      draft: false,
      published_at: "2026-09-04T00:00:00Z",
    }]);
    await expect(publishRelease({
      directory: releaseDirectory(),
      tag: `v${PREVIEW_ID}`,
      stagingTag: "aidlc-staging-run-1",
      targetCommitish: TARGET,
      repository: "owner/repo",
      notes: { name: previewReleaseName(PREVIEW_ID), body: "preview notes\n" },
      token: "test-token",
      apiBaseUrl: baseUrl,
      expectedAssetCount: 3,
      log: () => {},
      channel: PREVIEW_CHANNEL,
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
      // The upload and verification work crosses midnight.
      now: () => new Date(state.assets.length === 0 ? "2026-09-03T23:59:59Z" : "2026-09-04T00:00:01Z"),
    })).rejects.toThrow("a preview is already published for UTC date 20260904; daily limit reached");
    expect(state.assets.map((asset) => asset.name).sort()).toEqual(["checksums.txt", "install.sh", "version.json"]);
    expect(state.tag).toBe("aidlc-staging-run-1");
    expect(state.finalTagObject).toBeNull();
    expect(state.finalRef).toBeNull();
    expect(state.draft).toBe(true);
    expect(state.immutable).toBe(false);
    expect(state.prerelease).toBe(false);
    expect(state.writes).toContain("POST /repos/owner/repo/releases");
    expect(state.writes).toContain("DELETE /repos/owner/repo/releases/1");
    expect(state.writes).not.toContain("PATCH /repos/owner/repo/releases/1");
  });

  test("channel and tag grammar are enforced before any remote write", async () => {
    const { baseUrl, state } = servePublishMock();
    const common = {
      directory: releaseDirectory(),
      stagingTag: "aidlc-staging-run-1",
      targetCommitish: TARGET,
      repository: "owner/repo",
      notes: { name: "x", body: "y\n" },
      token: "test-token",
      apiBaseUrl: baseUrl,
      expectedAssetCount: 3,
      log: () => {},
    };
    await expect(publishRelease({ ...common, tag: `v${PREVIEW_ID}` }))
      .rejects.toThrow(`invalid ${STABLE_CHANNEL} release tag`);
    await expect(publishRelease({ ...common, tag: `v${AIDLC_VERSION}`, channel: PREVIEW_CHANNEL }))
      .rejects.toThrow(`invalid ${PREVIEW_CHANNEL} release tag`);
    await expect(publishRelease({ ...common, tag: `v${PREVIEW_ID}`, channel: PREVIEW_CHANNEL }))
      .rejects.toThrow("invalid source repository");
    expect(state.assets).toEqual([]);
    expect(state.finalTagObject).toBeNull();
  });

  test("the planner skips an unchanged main, allocates the day's counter, and renders notes", async () => {
    const history = sourceHistory();
    const previous = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`;
    const baseUrl = servePlanMock({
      releases: [
        { tag_name: `v${AIDLC_VERSION}`, prerelease: false, draft: false },
        { tag_name: previous, prerelease: true, draft: false },
        { tag_name: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.9`, prerelease: true, draft: true },
      ],
      tags: [
        `v${AIDLC_VERSION}`,
        previous,
        `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.1`,
        `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.2`,
        `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.9`,
        "v9.9.9-rc.1",
      ],
      annotated: { [previous]: { source: history.first } },
    });
    const client = githubApiClient(baseUrl, undefined);

    const skipped = await planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.first,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(skipped).toEqual({
      skip: true,
      reason: "unchanged-source",
      version: null,
      previousSourceDigest: history.first,
      plan: null,
    });

    const planned = await planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(planned.skip).toBe(false);
    expect(planned).not.toHaveProperty("reason");
    // The counter skips every existing tag for the date, published or not.
    expect(planned.version).toBe(`${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.10`);
    expect(planned.plan?.previousSourceDigest).toBe(history.first);
    expect(planned.plan?.notes.name).toBe(`AI-DLC Workflow ${planned.version}`);
    expect(planned.plan?.notes.body).toContain(`## [${NEXT_STABLE}] - 2026-09-03`);
    expect(planned.plan?.notes.body).toContain("* Next bullet.");
    expect(planned.plan?.notes.body).not.toContain("Current section summary.");
    expect(planned.plan?.notes.body).toContain(`Source commit: owner/source@${history.second}`);

    // A plan round-trips through the JSON record the promote job consumes.
    const planPath = join(history.cwd, "plan.json");
    writeFileSync(planPath, `${JSON.stringify(planned.plan, null, 2)}\n`);
    expect(planned.plan).not.toBeNull();
    expect(readPreviewPlan(planPath)).toEqual(planned.plan as NonNullable<typeof planned.plan>);
    writeFileSync(planPath, JSON.stringify({ ...planned.plan, tag: "v1.2.3" }));
    expect(() => readPreviewPlan(planPath)).toThrow("invalid fields");
    writeFileSync(planPath, "null\n");
    expect(() => readPreviewPlan(planPath)).toThrow("must be an object");

    // No CHANGELOG heading added since the previous preview: commit subjects.
    const subjects = previewReleaseNotes({
      cwd: history.cwd,
      version: planned.version as string,
      sourceRepository: "owner/source",
      sourceDigest: history.third,
      previousSourceDigest: history.second,
    });
    expect(subjects.body).toContain(`Merged commits since ${PREVIEW_CHANNEL} source ${history.second.slice(0, 12)}:`);
    expect(subjects.body).toContain("- refactor: internal cleanup");
    expect(subjects.body).not.toContain("- feat: next section");

    // No previous preview: the source version's own section.
    const initial = previewReleaseNotes({
      cwd: history.cwd,
      version: planned.version as string,
      sourceRepository: "owner/source",
      sourceDigest: history.first,
      previousSourceDigest: null,
    });
    expect(initial.body).toContain("Current section summary.");
    expect(initial.body).toContain(`Source commit: owner/source@${history.first}`);
  });

  test("today's published preview skips an advanced source without reading annotated tags", async () => {
    const history = sourceHistory();
    const today = `v${PREVIEW_ID}`;
    const requests: string[] = [];
    const baseUrl = servePlanMock({
      releases: [{ tag_name: today, prerelease: true, draft: false }],
      tags: [today],
      annotated: { [today]: { source: history.first } },
      requests,
    });
    const skipped = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(skipped).toEqual({
      skip: true,
      reason: "daily-limit",
      version: null,
      previousSourceDigest: null,
      plan: null,
    });
    expect(requests.filter((path) =>
      path.includes("/git/ref/tags/") || path.includes("/git/tags/")
    )).toEqual([]);
  });

  test("a published preview on a later releases page consumes today's daily slot", async () => {
    const firstPage = "repos/owner/repo/releases?per_page=100";
    const secondPage = "https://api.example.invalid/repos/owner/repo/releases?per_page=100&page=2";
    const requests: string[] = [];
    const client = {
      async json(path: string) {
        requests.push(path);
        if (path === firstPage) {
          return {
            value: [{ tag_name: `v${AIDLC_VERSION}`, prerelease: false, draft: false }],
            next: secondPage,
          };
        }
        if (path === secondPage) {
          return {
            value: [{ tag_name: `v${PREVIEW_ID}`, prerelease: true, draft: false }],
            next: null,
          };
        }
        throw new Error(`unexpected API request: ${path}`);
      },
    };
    const skipped = await planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
      cwd: REPO_ROOT,
      date: "20260903",
    });
    expect(skipped).toEqual({
      skip: true,
      reason: "daily-limit",
      version: null,
      previousSourceDigest: null,
      plan: null,
    });
    expect(requests).toEqual([firstPage, secondPage]);
  });

  test("the planner rejects an incomplete release list when page 50 still has a next link", async () => {
    const firstPage = "repos/owner/repo/releases?per_page=100";
    const requests: string[] = [];
    const client = {
      async json(path: string) {
        if (!path.startsWith(firstPage)) throw new Error(`unexpected API request: ${path}`);
        requests.push(path);
        if (requests.length > 50) throw new Error("the client was asked for more than 50 pages");
        return { value: [], next: `${firstPage}&page=${requests.length + 1}` };
      },
    };
    await expect(planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: SOURCE_A,
      cwd: REPO_ROOT,
      date: "20260903",
    })).rejects.toThrow("exceeded the pagination limit");
    expect(requests).toHaveLength(50);
    expect(requests.at(-1)).toBe(`${firstPage}&page=50`);
  });

  test("a successful scheduled preview makes a later manual plan skip on the same UTC date", async () => {
    const history = sourceHistory();
    const previous = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`;
    const state: PlanMockOptions = {
      releases: [{ tag_name: previous, prerelease: true, draft: false }],
      tags: [previous],
      annotated: { [previous]: { source: history.first } },
    };
    const client = githubApiClient(servePlanMock(state), undefined);
    const common = {
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      cwd: history.cwd,
      date: "20260903",
    };
    const scheduled = await planPreviewRelease({ ...common, sourceDigest: history.second });
    expect(scheduled).toMatchObject({
      skip: false,
      version: `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.1`,
      plan: { sourceDigest: history.second, previousSourceDigest: history.first },
    });

    // The scheduled run publishes its plan before main advances again.
    const publishedTag = `v${scheduled.version}`;
    state.releases.push({
      tag_name: publishedTag,
      prerelease: true,
      draft: false,
      published_at: "2026-09-03T04:00:00Z",
    });
    state.tags.push(publishedTag);
    state.annotated[publishedTag] = { source: history.second };

    const manual = await planPreviewRelease({ ...common, sourceDigest: history.third });
    expect(manual).toEqual({
      skip: true,
      reason: "daily-limit",
      version: null,
      previousSourceDigest: null,
      plan: null,
    });
  });

  test("orphan tags and a draft-only preview permit retry while reserving their counters", async () => {
    const history = sourceHistory();
    const previous = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`;
    const draftOnly = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.9`;
    const baseUrl = servePlanMock({
      releases: [
        { tag_name: previous, prerelease: true, draft: false },
        { tag_name: draftOnly, prerelease: true, draft: true, published_at: null },
      ],
      // The draft's .9 id has no tag yet; only the failed .1 and .4 attempts do.
      tags: [
        previous,
        `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.1`,
        `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.4`,
      ],
      annotated: { [previous]: { source: history.first } },
    });
    const planned = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(planned).toMatchObject({
      skip: false,
      version: `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.10`,
      previousSourceDigest: history.first,
      plan: {
        tag: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.10`,
        sourceDigest: history.second,
        previousSourceDigest: history.first,
      },
    });
  });

  test("changed source produces a plan on the next UTC day", async () => {
    const history = sourceHistory();
    const previous = `v${PREVIEW_ID}`;
    const baseUrl = servePlanMock({
      releases: [{
        tag_name: previous,
        prerelease: true,
        draft: false,
        published_at: "2026-09-03T23:59:59Z",
      }],
      tags: [previous],
      annotated: { [previous]: { source: history.first } },
    });
    const common = {
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      cwd: history.cwd,
      date: "20260904",
    };
    const planned = await planPreviewRelease({ ...common, sourceDigest: history.second });
    expect(planned).toMatchObject({
      skip: false,
      version: `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260904.1`,
      previousSourceDigest: history.first,
      plan: {
        tag: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260904.1`,
        sourceDigest: history.second,
        previousSourceDigest: history.first,
      },
    });
    expect(planned).not.toHaveProperty("reason");

    const unchanged = await planPreviewRelease({ ...common, sourceDigest: history.first });
    expect(unchanged).toEqual({
      skip: true,
      reason: "unchanged-source",
      version: null,
      previousSourceDigest: history.first,
      plan: null,
    });
  });

  test("a higher-version older release does not hide a lower-version preview published today", async () => {
    const history = sourceHistory();
    const older = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
    const today = `v${PREVIEW_ID}`;
    const baseUrl = servePlanMock({
      releases: [
        { tag_name: older, prerelease: true, draft: false },
        { tag_name: today, prerelease: true, draft: false },
      ],
      tags: [older, today],
      annotated: {
        [older]: { source: history.first },
        [today]: { source: history.second },
      },
    });
    const skipped = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.third,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(skipped).toEqual({
      skip: true,
      reason: "daily-limit",
      version: null,
      previousSourceDigest: null,
      plan: null,
    });
  });

  test.each([
    "2026-09-03T00:05:00Z",
    "2026-09-02T20:05:00-04:00",
  ])("a prior-day tag published at %s counts against its UTC publication day", async (publishedAt) => {
    const history = sourceHistory();
    const previous = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`;
    const baseUrl = servePlanMock({
      releases: [{
        tag_name: previous,
        prerelease: true,
        draft: false,
        published_at: publishedAt,
      }],
      tags: [previous],
      annotated: { [previous]: { source: history.first } },
    });
    const skipped = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(skipped).toEqual({
      skip: true,
      reason: "daily-limit",
      version: null,
      previousSourceDigest: null,
      plan: null,
    });
  });

  test("a lightweight or foreign previous preview never triggers a skip", async () => {
    const history = sourceHistory();
    const previous = `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260902.1`;
    const baseUrl = servePlanMock({
      releases: [{ tag_name: previous, prerelease: true, draft: false }],
      tags: [previous],
      annotated: { [previous]: "lightweight" },
    });
    const planned = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.first,
      cwd: history.cwd,
      date: "20260904",
    });
    expect(planned.skip).toBe(false);
    expect(planned.version).toBe(`${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260904.1`);
    expect(planned.plan?.previousSourceDigest).toBeNull();
    expect(nextPreviewVersion([], AIDLC_VERSION, "20260904")).toBe(
      `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260904.1`,
    );
    expect(nextPreviewVersion(
      [`${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.3`, `${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260903.7`],
      AIDLC_VERSION,
      "20260904",
    )).toBe(`${AIDLC_VERSION}-${PREVIEW_CHANNEL}.20260904.4`);
  });

  test("a queued older checkout can skip today's preview but cannot become a new publication candidate", async () => {
    const workflow = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf-8")) as {
      jobs: { validate: { steps: Array<{ id?: string; run?: string }> } };
    };
    const validateScript = workflow.jobs.validate.steps.find((step) => step.id === "validate")?.run;
    const planScript = workflow.jobs.validate.steps.find((step) => step.id === "plan")?.run;
    if (!validateScript || !planScript) throw new Error("release validation and planning steps must exist");

    const history = sourceHistory();
    const origin = join(history.cwd, "origin.git");
    git(history.cwd, ["clone", "--bare", "--no-hardlinks", history.cwd, origin]);
    git(history.cwd, ["remote", "add", "origin", origin]);
    git(history.cwd, ["checkout", "--detach", history.first]);
    for (const directory of ["scripts", "core"]) {
      symlinkSync(
        join(REPO_ROOT, directory),
        join(history.cwd, directory),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const runnerTemp = join(history.cwd, "runner-temp");
    mkdirSync(runnerTemp);
    const validationOutput = join(runnerTemp, "validate-output");
    const planningOutput = join(runnerTemp, "plan-output");
    const planPath = join(runnerTemp, "aidlc-preview-plan.json");
    const mock: PlanMockOptions = { releases: [], tags: [], annotated: {} };
    const env = {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: history.first,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_API_URL: servePlanMock(mock),
      GH_TOKEN: "",
      RELEASE_TAG: "main",
      RUNNER_TEMP: runnerTemp,
    };
    writeFileSync(validationOutput, "");
    const validated = await runWorkflowStep(validateScript, history.cwd, {
      ...env,
      GITHUB_OUTPUT: validationOutput,
    });
    expect(validated.status, validated.stdout + validated.stderr).toBe(0);
    const validationRows = readFileSync(validationOutput, "utf-8");
    expect(validationRows).toBe(`channel=preview\ntag=\nsha=${history.first}\n`);
    const authorizedSha = /^sha=(.+)$/m.exec(validationRows)?.[1];
    expect(git(history.cwd, ["rev-parse", "HEAD"])).toBe(history.first);
    expect(git(history.cwd, ["rev-parse", "origin/main"])).toBe(history.third);

    for (const alreadyPublished of [true, false]) {
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      mock.releases = alreadyPublished
        ? [{ tag_name: `v${AIDLC_VERSION}-${PREVIEW_CHANNEL}.${date}.1`, prerelease: true, draft: false }]
        : [];
      writeFileSync(planningOutput, "");
      rmSync(planPath, { force: true });
      const planned = await runWorkflowStep(planScript, history.cwd, {
        ...env,
        AUTHORIZED_SHA: authorizedSha,
        GITHUB_OUTPUT: planningOutput,
      });
      const planningRows = readFileSync(planningOutput, "utf-8");
      if (alreadyPublished) {
        expect(planned.status, planned.stdout + planned.stderr).toBe(0);
        expect(planningRows).toBe("skip=true\npreview_version=\ntag=\npreview_plan=null\n");
        expect(JSON.parse(readFileSync(planPath, "utf-8"))).toBeNull();
      } else {
        expect(planned.status, planned.stdout + planned.stderr).toBe(1);
        expect(planningRows).toContain("skip=false\n");
        expect(planningRows).not.toContain("preview_plan=");
        expect(readPreviewPlan(planPath)).toMatchObject({
          sourceRepository: "owner/repo",
          sourceDigest: history.first,
          previousSourceDigest: null,
        });
      }
    }
  }, 45_000);

  test("the release workflow schedules previews, gates them on CI, and stamps the build", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const ci = Bun.YAML.parse(readFileSync(CI_WORKFLOW, "utf-8")) as { on: Record<string, unknown> };
    expect(Object.keys(ci.on)).toContain("workflow_call");
    const parsed = Bun.YAML.parse(workflow) as {
      on: {
        push: { tags: string[] };
        schedule?: Array<{ cron: string }>;
        workflow_dispatch: unknown;
      };
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs: Record<string, {
        needs?: string | string[];
        if?: string;
        environment?: string;
        permissions?: Record<string, string>;
        uses?: string;
        env?: Record<string, string>;
        outputs?: Record<string, string>;
        steps?: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };
    const cron = parsed.on.schedule?.[0]?.cron ?? "";
    expect(cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(cron.split(" ")[0]).not.toBe("0");
    expect(parsed.on.workflow_dispatch).toBeDefined();
    expect(parsed.on.push.tags).toContain("v*.*.*");
    expect(parsed.on.push.tags).toContain("!v*-preview.*");
    expect(parsed.concurrency?.group).toBe(
      `release-\${{ github.event_name == 'push' && 'stable' || 'preview' }}`,
    );
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false);

    const jobs = parsed.jobs;
    for (const [name, job] of Object.entries(jobs)) {
      const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
      for (const dependency of needs) expect(jobs[dependency], `${name} needs ${dependency}`).toBeDefined();
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string): void => {
      if (done.has(name)) return;
      expect(visiting.has(name), `cycle through ${name}`).toBe(false);
      visiting.add(name);
      const needs = jobs[name].needs;
      for (const dependency of needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]) visit(dependency);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of Object.keys(jobs)) visit(name);

    expect(jobs.gate.uses).toBe("./.github/workflows/ci.yml");
    expect(jobs.gate.needs).toBe("validate");
    expect(jobs.gate.if).toContain(`needs.validate.outputs.channel == '${PREVIEW_CHANNEL}'`);
    expect(jobs.gate.if).toContain("needs.validate.outputs.skip != 'true'");
    expect(jobs["gate-result"].needs).toEqual(["validate", "gate"]);
    expect(jobs["gate-result"].if).toContain("needs.gate.result == 'success'");
    expect(jobs["gate-result"].if).toContain("needs.validate.outputs.skip != 'true'");
    expect(jobs.verify.needs).toEqual(["validate", "gate-result"]);
    expect(jobs.verify.if).toContain("!cancelled()");
    expect(jobs.verify.if).toContain("needs.validate.result == 'success'");
    expect(jobs.verify.if).toContain("needs.gate-result.result == 'success'");
    expect(jobs.publish.needs).toEqual(["validate", "musl-smoke", "windows-lifecycle", "unix-lifecycle"]);
    expect(jobs.release.needs).toEqual(["validate", "publish"]);
    expect(jobs.release.environment).toBe(
      `\${{ needs.validate.outputs.channel == 'preview' && 'preview' || 'release' }}`,
    );
    expect(jobs.release.permissions).toEqual({ contents: "write" });
    expect(jobs["release-result"].needs).toEqual(["validate", "release"]);
    expect(jobs["release-result"].if).toContain("!cancelled()");
    const releaseResult = jobs["release-result"].steps?.find(
      (step) => step.name === "Require publication or an intentional preview skip",
    );
    expect(releaseResult?.run).toContain('test "$VALIDATE_RESULT" = success');
    expect(releaseResult?.run).toContain(
      '[ "$RELEASE_CHANNEL" = preview ] && [ "$RELEASE_SKIP" = true ]',
    );
    expect(releaseResult?.run).toContain('test "$RELEASE_RESULT" = success');

    for (const key of ["channel", "tag", "sha", "skip", "preview_version", "preview_plan"]) {
      expect(jobs.validate.outputs?.[key], key).toBeDefined();
    }
    const plan = jobs.validate.steps?.find((step) => step.name === "Plan preview publication");
    expect(plan?.if).toBe(`steps.validate.outputs.channel == '${PREVIEW_CHANNEL}'`);
    expect(plan?.run).toContain("bun scripts/plan-preview-release.ts");
    expect(plan?.run).toContain('--source-digest "$AUTHORIZED_SHA"');

    const stamp = `\${{ needs.validate.outputs.preview_version }}`;
    expect(jobs.build.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(jobs["stage-release"].env?.AIDLC_BUILD_VERSION).toBe(stamp);
    const smoke = jobs["native-smoke"].steps ?? [];
    expect(smoke.find((step) => step.run === "bun scripts/package.ts")?.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(smoke.find((step) => step.run?.includes("t238-build-binaries"))?.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(jobs.verify.env).toBeUndefined();

    const preview = jobs.release.steps?.find((step) => step.name === "Create preview GitHub Release");
    expect(preview?.if).toBe(`needs.validate.outputs.channel == '${PREVIEW_CHANNEL}'`);
    expect(preview?.run).toContain("bun scripts/publish-release.ts");
    expect(preview?.run).toContain("--channel preview");
    expect(preview?.run).toContain('--preview-plan "$plan"');
    expect(preview?.run).toContain("--expected-assets 13");
    const stable = jobs.release.steps?.find((step) => step.name === "Create stable GitHub Release");
    expect(stable?.if).toBe(`needs.validate.outputs.channel == '${STABLE_CHANNEL}'`);
    expect(stable?.run).toContain("--generate-notes");
  });
});

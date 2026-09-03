// t332: the preview publication pipeline. The publisher stages the same draft
// as a stable release, then binds it to an annotated preview tag whose message
// records the source commit, and publishes it as a prerelease that never
// becomes "latest". The planner reads the publication repository to skip an
// unchanged main, allocates the day's build counter from every existing preview
// tag, and renders notes from the CHANGELOG sections (or commit subjects) added
// since the previous preview's source commit. The workflow contract pins the
// schedule, the channel input, the CI gate ordering, and the stamped build env.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type PublishMockState = {
  tag: string;
  draft: boolean;
  immutable: boolean;
  prerelease: boolean;
  makeLatest: string | null;
  finalTagObject: { sha: string; message: string; target: string } | null;
  finalRef: string | null;
  assets: Array<{ id: number; name: string; bytes: Uint8Array }>;
};

// A GitHub-shaped publication repository: the draft flow of t305 plus the git
// tag-object and ref endpoints an annotated preview tag needs.
function servePublishMock(): { baseUrl: string; state: PublishMockState } {
  const state: PublishMockState = {
    tag: "aidlc-staging-run-1",
    draft: true,
    immutable: false,
    prerelease: false,
    makeLatest: null,
    finalTagObject: null,
    finalRef: null,
    assets: [],
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
      if (url.pathname === "/repos/owner/repo/releases" && method === "GET") {
        return json([{ id: 800, tag_name: `v${AIDLC_VERSION}`, draft: false }]);
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
  releases: Array<{ tag_name: string; prerelease: boolean; draft: boolean }>;
  tags: string[];
  annotated: Record<string, { source: string } | "lightweight">;
};

// The publication repository as the planner sees it: published releases,
// every tag ref under v, and the annotated tag objects with their messages.
function servePlanMock(options: PlanMockOptions): string {
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
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
        return json({ object: { type: "tag", sha: `${tag.length.toString(16).padStart(2, "0")}`.padEnd(40, "d") } });
      }
      const tagMatch = /^\/repos\/owner\/repo\/git\/tags\/([a-f0-9]{40})$/.exec(url.pathname);
      if (tagMatch) {
        const entry = Object.entries(options.annotated).find(([tag]) =>
          `${tag.length.toString(16).padStart(2, "0")}`.padEnd(40, "d") === tagMatch[1]
        );
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
    expect(skipped).toEqual({ skip: true, version: null, previousSourceDigest: history.first, plan: null });

    const planned = await planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(planned.skip).toBe(false);
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

  test("the release workflow schedules previews, gates them on CI, and stamps the build", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const ci = Bun.YAML.parse(readFileSync(CI_WORKFLOW, "utf-8")) as { on: Record<string, unknown> };
    expect(Object.keys(ci.on)).toContain("workflow_call");
    const parsed = Bun.YAML.parse(workflow) as {
      on: {
        schedule?: Array<{ cron: string }>;
        workflow_dispatch: {
          inputs: Record<string, {
            description?: string;
            required?: boolean;
            type?: string;
            default?: string;
            options?: string[];
          }>;
        };
      };
      jobs: Record<string, {
        needs?: string | string[];
        if?: string;
        uses?: string;
        env?: Record<string, string>;
        outputs?: Record<string, string>;
        steps?: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };
    const cron = parsed.on.schedule?.[0]?.cron ?? "";
    expect(cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(cron.split(" ")[0]).not.toBe("0");
    expect(parsed.on.workflow_dispatch.inputs.tag.required).toBe(false);
    expect(parsed.on.workflow_dispatch.inputs.channel).toEqual({
      description: "Release channel to publish",
      type: "choice",
      default: STABLE_CHANNEL,
      options: [STABLE_CHANNEL, PREVIEW_CHANNEL],
    });

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
    expect(jobs.gate.needs).toBe("authorize");
    expect(jobs.gate.if).toContain(`needs.authorize.outputs.channel == '${PREVIEW_CHANNEL}'`);
    expect(jobs.gate.if).toContain("needs.authorize.outputs.skip != 'true'");
    expect(jobs["gate-result"].needs).toEqual(["authorize", "gate"]);
    expect(jobs["gate-result"].if).toContain("needs.gate.result == 'success'");
    expect(jobs["gate-result"].if).toContain("needs.authorize.outputs.skip != 'true'");
    expect(jobs.verify.needs).toEqual(["authorize", "gate-result"]);
    expect(jobs.publish.needs).toEqual(["authorize", "musl-smoke", "windows-lifecycle", "unix-lifecycle"]);
    expect(jobs.promote.needs).toEqual(["authorize", "publish"]);

    for (const key of ["channel", "tag", "sha", "skip", "preview_version", "preview_plan"]) {
      expect(jobs.authorize.outputs?.[key], key).toBeDefined();
    }
    const plan = jobs.authorize.steps?.find((step) => step.name === "Plan preview publication");
    expect(plan?.if).toBe(`steps.authorize.outputs.channel == '${PREVIEW_CHANNEL}'`);
    expect(plan?.run).toContain("bun scripts/plan-preview-release.ts");
    expect(plan?.run).toContain('--source-digest "$AUTHORIZED_SHA"');

    const stamp = `\${{ needs.authorize.outputs.preview_version }}`;
    expect(jobs.build.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(jobs["stage-release"].env?.AIDLC_BUILD_VERSION).toBe(stamp);
    const smoke = jobs["native-smoke"].steps ?? [];
    expect(smoke.find((step) => step.run === "bun scripts/package.ts")?.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(smoke.find((step) => step.run?.includes("t238-build-binaries"))?.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(jobs.verify.env).toBeUndefined();

    const publishStep = jobs.promote.steps?.find((step) =>
      step.name === "Publish and re-verify exact verified release bytes"
    );
    expect(publishStep?.env?.RELEASE_CHANNEL).toBe(`\${{ needs.authorize.outputs.channel }}`);
    expect(publishStep?.env?.PREVIEW_PLAN).toBe(`\${{ needs.authorize.outputs.preview_plan }}`);
    expect(publishStep?.run).toContain('--channel "$RELEASE_CHANNEL"');
    expect(publishStep?.run).toContain('--preview-plan "$preview_plan"');
    expect(workflow).not.toContain("\n  push:");
  });
});

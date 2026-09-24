// t332: the preview publication pipeline. The publisher stages the same draft
// as a stable release, then binds it to an annotated preview tag whose message
// records the source commit, and publishes it as a prerelease that never
// becomes "latest". The planner skips publication for an unchanged main while
// CI and full-suite coverage still run, permits multiple
// changed sources on one UTC date, allocates the day's build counter from
// occupied preview ids, and renders notes from the CHANGELOG sections (or
// commit subjects) added since the previous preview's source commit. The
// workflow contract pins the schedule/manual trigger, contract gate ordering, and
// stamped build environment.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const STABLE_RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");
const PREVIEW_RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "preview-release.yml");
const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

const [MAJOR, MINOR, PATCH] = AIDLC_VERSION.split(".").map(Number);
const NEXT_STABLE = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const FOLLOWING_STABLE = `${MAJOR}.${MINOR}.${PATCH + 2}`;
const SOURCE_A = "a".repeat(40);
const TARGET = "1".repeat(40);
const PREVIEW_ID = `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.2`;

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
  annotated: Record<string, { source: string; repository?: string } | "lightweight">;
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
            sourceRepository: entry[1].repository ?? "owner/source",
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
  for (const [name, event, flag, sha, head, ancestor, purpose, selectedFamily = "all", selectedTest = ""] of [
    ["release call can test an older main commit", "workflow_call", "false", SOURCE_A, TARGET, true, "release"],
    ["release schedule stays main-bound", "schedule", "false", SOURCE_A, SOURCE_A, true, "release"],
    ["normal dispatch rejects branch source", "workflow_dispatch", "false", SOURCE_A, SOURCE_A, false, null],
    ["manual candidate live verification", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, "live-verification"],
    ["manual main live verification remains ineligible", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, "live-verification"],
    ["live verification rejects a different workflow head", "workflow_dispatch", "true", SOURCE_A, TARGET, true, null],
    ["call cannot enable live verification", "workflow_call", "true", SOURCE_A, SOURCE_A, true, null],
    ["schedule cannot enable live verification", "schedule", "true", SOURCE_A, SOURCE_A, true, null],
    ["PR cannot enable live verification", "pull_request", "true", SOURCE_A, SOURCE_A, true, null],
    ["unknown mode fails closed", "workflow_dispatch", "1", SOURCE_A, SOURCE_A, true, null],
    ["manual family verification", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, "live-verification", "codex"],
    ["family verification on main remains ineligible", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, "live-verification", "codex"],
    ["release cannot select a family", "workflow_dispatch", "false", SOURCE_A, SOURCE_A, true, null, "codex"],
    ["ordinary call cannot select a family", "workflow_call", "false", SOURCE_A, SOURCE_A, true, null, "codex"],
    ["verification call cannot select a family", "workflow_call", "true", SOURCE_A, SOURCE_A, true, null, "codex"],
    ["scheduled verification cannot select a family", "schedule", "true", SOURCE_A, SOURCE_A, true, null, "codex"],
    ["family verification rejects another head", "workflow_dispatch", "true", SOURCE_A, TARGET, true, null, "codex"],
    ["unknown verification family fails closed", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, null, "unknown"],
    ["empty verification family fails closed", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, null, ""],
    ["release-contract is not a verification family", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, null, "release-contract"],
    ["manual exact Codex test verification", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, "live-verification", "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["manual exact SDK test on main stays verification-only", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, true, "live-verification", "claude-sdk", "tests/integration/t238-user-stories-mob.sdk.test.ts"],
    ["manual exact plugin test path reaches planning", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, "live-verification", "claude-sdk", "plugins/test-pro/tests/plugin.test.ts"],
    ["exact test requires one family", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "all", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["release cannot select an exact test", "workflow_dispatch", "false", SOURCE_A, SOURCE_A, true, null, "all", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["ordinary family call cannot select an exact test", "workflow_call", "false", SOURCE_A, SOURCE_A, true, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["verification call cannot select an exact test", "workflow_call", "true", SOURCE_A, SOURCE_A, true, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["scheduled verification cannot select an exact test", "schedule", "true", SOURCE_A, SOURCE_A, true, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["PR verification cannot select an exact test", "pull_request", "true", SOURCE_A, SOURCE_A, true, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["exact test cannot authorize another source head", "workflow_dispatch", "true", SOURCE_A, TARGET, true, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["test globs are rejected", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "codex", "tests/e2e/t-exec-codex-*.test.ts"],
    ["test traversal is rejected", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "codex", "tests/e2e/../t-exec-codex-status.serial.test.ts"],
    ["absolute test paths are rejected", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "codex", "/tests/e2e/t-exec-codex-status.serial.test.ts"],
    ["native separators are not repository test paths", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "codex", "tests\\e2e\\t-exec-codex-status.serial.test.ts"],
    ["line breaks cannot add source outputs", "workflow_dispatch", "true", SOURCE_A, SOURCE_A, false, null, "codex", "tests/e2e/t-exec-codex-status.serial.test.ts\npurpose=release"],
  ] as const) {
    test(`Full Suite source authorization: ${name}`, async () => {
      const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf8")) as {
        jobs: { plan: { steps: Array<{ name?: string; run?: string }> } };
      };
      const script = workflow.jobs.plan.steps.find((step) => step.name === "Resolve immutable source")!.run!;
      const root = mkdtempSync(join(tmpdir(), "aidlc-t332-source-gate-"));
      roots.push(root);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const shim = join(bin, "git");
      writeFileSync(shim, [
        "#!/usr/bin/env bash", 'printf "%s\\n" "$*" >> "$FIXTURE_GIT_CALLS"',
        'case "$1" in',
        '  rev-parse) printf "%s\\n" "$FIXTURE_SHA" ;;',
        '  fetch) exit 0 ;;',
        '  merge-base) exit "$FIXTURE_ANCESTOR" ;;',
        '  *) exit 2 ;;', "esac",
      ].join("\n"));
      chmodSync(shim, 0o755);
      const output = join(root, "output");
      const calls = join(root, "git-calls");
      writeFileSync(output, "");
      const result = await runWorkflowStep(script, root, {
        PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        FIXTURE_SHA: sha, FIXTURE_ANCESTOR: ancestor ? "0" : "1", FIXTURE_GIT_CALLS: calls,
        LIVE_VERIFICATION: flag, VERIFICATION_FAMILY: selectedFamily, VERIFICATION_TEST: selectedTest,
        GITHUB_EVENT_NAME: event, GITHUB_SHA: head, GITHUB_OUTPUT: output,
      });
      expect(result.status, result.stdout + result.stderr).toBe(purpose === null ? 1 : 0);
      expect(readFileSync(output, "utf8")).toBe(purpose === null ? "" : `sha=${sha}\npurpose=${purpose}\nverification_family=${selectedFamily}\nverification_test=${selectedTest}\n`);
      const commands = readFileSync(calls, "utf8");
      if (flag === "false" && selectedFamily === "all" && selectedTest === "") {
        expect(commands).toContain("fetch --no-tags origin main");
        expect(commands).toContain(`merge-base --is-ancestor ${sha} origin/main`);
      } else {
        expect(commands).not.toContain("fetch");
      }
    }, 15_000);
  }

  test("an unchanged preview requires successful nightly tests before recording a publication skip", async () => {
    const workflow = Bun.YAML.parse(readFileSync(PREVIEW_RELEASE_WORKFLOW, "utf8")) as {
      jobs: Record<string, { if?: string; needs: string | string[]; steps?: Array<{ run?: string }> }>;
    };
    const jobs = workflow.jobs;
    // These dependencies use GitHub's default success condition, independent
    // of the planner's skip output, on both schedule and workflow_dispatch.
    expect(jobs.gate).toMatchObject({ needs: "validate" });
    expect(jobs.gate.if).toBeUndefined();
    expect(jobs.full_suite.needs).toEqual(["validate", "gate"]);
    expect(jobs.full_suite.if).toBeUndefined();
    expect(jobs.verify).toBeUndefined();
    expect(jobs["native-smoke"].if).toBe("needs.validate.outputs.skip != 'true'");
    expect(jobs.test.if).toBe(`\${{ !cancelled() && needs.validate.result == 'success' }}`);
    const testScript = jobs.test.steps![0].run!;
    const resultScript = jobs["release-result"].steps![0].run!;
    for (const fullSuite of ["success", "failure", "cancelled", "skipped"]) {
      const tests = await runWorkflowStep(testScript, REPO_ROOT, { FULL_SUITE_RESULT: fullSuite });
      expect(tests.status).toBe(fullSuite === "success" ? 0 : 1);
      const result = await runWorkflowStep(resultScript, REPO_ROOT, {
        VALIDATE_RESULT: "success", TEST_RESULT: tests.status === 0 ? "success" : "failure",
        RELEASE_SKIP: "true", RELEASE_RESULT: "skipped",
      });
      expect(result.status, result.stdout + result.stderr).toBe(fullSuite === "success" ? 0 : 1);
    }
    for (const release of ["success", "skipped", "failure"]) {
      const result = await runWorkflowStep(resultScript, REPO_ROOT, {
        VALIDATE_RESULT: "success", TEST_RESULT: "success", RELEASE_SKIP: "false", RELEASE_RESULT: release,
      });
      expect(result.status, result.stdout + result.stderr).toBe(release === "success" ? 0 : 1);
    }
  }, 15_000);

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
    expect(state.immutable).toBe(false);
    expect(state.prerelease).toBe(true);
    expect(state.makeLatest).toBe("false");
    expect(state.finalRef).toBe(`refs/tags/v${PREVIEW_ID}`);
    expect(state.finalTagObject?.target).toBe(TARGET);
    expect(parsePreviewTagSource(state.finalTagObject?.message ?? "")).toEqual({
      repository: "owner/source",
      digest: SOURCE_A,
    });
  });

  test("an already published same-day preview permits another publication", async () => {
    const { baseUrl, state } = servePublishMock([{
      tag_name: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`,
      prerelease: true,
      draft: false,
      published_at: "2026-09-03T04:00:00Z",
    }]);
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
    expect(state.assets.map((asset) => asset.name).sort()).toEqual(["checksums.txt", "install.sh", "version.json"]);
    expect(state.finalRef).toBe(`refs/tags/v${PREVIEW_ID}`);
    expect(state.draft).toBe(false);
    expect(state.prerelease).toBe(true);
  });

  test("a preview published after midnight does not block the planned build", async () => {
    const { baseUrl, state } = servePublishMock([{
      tag_name: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`,
      prerelease: true,
      draft: false,
      published_at: "2026-09-04T00:00:00Z",
    }]);
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
    expect(state.assets.map((asset) => asset.name).sort()).toEqual(["checksums.txt", "install.sh", "version.json"]);
    expect(state.finalRef).toBe(`refs/tags/v${PREVIEW_ID}`);
    expect(state.draft).toBe(false);
    expect(state.immutable).toBe(false);
    expect(state.prerelease).toBe(true);
    expect(state.writes).toContain("POST /repos/owner/repo/releases");
    expect(state.writes).toContain("PATCH /repos/owner/repo/releases/1");
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
    const previous = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
    const baseUrl = servePlanMock({
      releases: [
        { tag_name: `v${AIDLC_VERSION}`, prerelease: false, draft: false },
        { tag_name: previous, prerelease: true, draft: false },
        { tag_name: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.9`, prerelease: true, draft: true },
      ],
      tags: [
        `v${AIDLC_VERSION}`,
        previous,
        `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`,
        `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.2`,
        `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.9`,
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
    expect(planned.version).toBe(`${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.10`);
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

  test("today's published preview advances the counter when the source changed", async () => {
    const history = sourceHistory();
    const today = `v${PREVIEW_ID}`;
    const requests: string[] = [];
    const baseUrl = servePlanMock({
      releases: [{ tag_name: today, prerelease: true, draft: false }],
      tags: [today],
      annotated: { [today]: { source: history.first } },
      requests,
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
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.3`,
      previousSourceDigest: history.first,
      plan: {
        sourceDigest: history.second,
        previousSourceDigest: history.first,
      },
    });
    expect(requests.filter((path) =>
      path.includes("/git/ref/tags/") || path.includes("/git/tags/")
    ).length).toBeGreaterThan(0);
  });

  test("a published preview on a later releases page seeds the next same-day build", async () => {
    const history = sourceHistory();
    const firstPage = "repos/owner/repo/releases?per_page=100";
    const secondPage = "https://api.example.invalid/repos/owner/repo/releases?per_page=100&page=2";
    const previous = `v${PREVIEW_ID}`;
    const tagObject = "b".repeat(40);
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
            value: [{ tag_name: previous, prerelease: true, draft: false }],
            next: null,
          };
        }
        if (path === `repos/owner/repo/git/ref/tags/${previous}`) {
          return { value: { object: { type: "tag", sha: tagObject } }, next: null };
        }
        if (path === `repos/owner/repo/git/tags/${tagObject}`) {
          return {
            value: {
              message: previewTagMessage({
                version: PREVIEW_ID,
                sourceRepository: "owner/source",
                sourceDigest: history.first,
              }),
            },
            next: null,
          };
        }
        if (path === "repos/owner/repo/git/matching-refs/tags/v?per_page=100") {
          return { value: [{ ref: `refs/tags/${previous}` }], next: null };
        }
        throw new Error(`unexpected API request: ${path}`);
      },
    };
    const planned = await planPreviewRelease({
      client,
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.second,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(planned).toMatchObject({
      skip: false,
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.3`,
      previousSourceDigest: history.first,
      plan: { sourceDigest: history.second },
    });
    expect(requests.slice(0, 2)).toEqual([firstPage, secondPage]);
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

  test("a successful scheduled preview permits a later changed manual build on the same UTC date", async () => {
    const history = sourceHistory();
    const previous = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
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
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`,
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
    expect(manual).toMatchObject({
      skip: false,
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.2`,
      previousSourceDigest: history.second,
      plan: {
        sourceDigest: history.third,
        previousSourceDigest: history.second,
      },
    });
  });

  test("orphan tags and a draft-only preview permit retry while reserving their counters", async () => {
    const history = sourceHistory();
    const previous = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
    const draftOnly = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.9`;
    const baseUrl = servePlanMock({
      releases: [
        { tag_name: previous, prerelease: true, draft: false },
        { tag_name: draftOnly, prerelease: true, draft: true, published_at: null },
      ],
      // The draft's .9 id has no tag yet; only the failed .1 and .4 attempts do.
      tags: [
        previous,
        `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`,
        `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.4`,
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
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.10`,
      previousSourceDigest: history.first,
      plan: {
        tag: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.10`,
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
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.1`,
      previousSourceDigest: history.first,
      plan: {
        tag: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.1`,
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

  test("same-day planning keeps the highest-version preview as the notes baseline", async () => {
    const history = sourceHistory();
    const older = `v${FOLLOWING_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
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
    const planned = await planPreviewRelease({
      client: githubApiClient(baseUrl, undefined),
      repository: "owner/repo",
      sourceRepository: "owner/source",
      sourceDigest: history.third,
      cwd: history.cwd,
      date: "20260903",
    });
    expect(planned).toMatchObject({
      skip: false,
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.3`,
      previousSourceDigest: history.first,
      plan: {
        sourceDigest: history.third,
        previousSourceDigest: history.first,
      },
    });
  });

  test.each([
    "2026-09-03T00:05:00Z",
    "2026-09-02T20:05:00-04:00",
  ])("a prior-day tag published at %s does not block a changed source", async (publishedAt) => {
    const history = sourceHistory();
    const previous = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
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
      version: `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.1`,
      previousSourceDigest: history.first,
      plan: { sourceDigest: history.second },
    });
  });

  test.each(["lightweight", "foreign"] as const)(
    "a %s previous preview never triggers a skip",
    async (kind) => {
      const history = sourceHistory();
      const previous = `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260902.1`;
      const baseUrl = servePlanMock({
        releases: [{ tag_name: previous, prerelease: true, draft: false }],
        tags: [previous],
        annotated: {
          [previous]: kind === "lightweight"
            ? "lightweight"
            : { source: history.first, repository: "other/source" },
        },
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
      expect(planned.version).toBe(`${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.1`);
      expect(planned.plan?.previousSourceDigest).toBeNull();
      expect(nextPreviewVersion([], NEXT_STABLE, "20260904")).toBe(
        `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.1`,
      );
      expect(nextPreviewVersion(
        [`${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.3`, `${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260903.7`],
        NEXT_STABLE,
        "20260904",
      )).toBe(`${NEXT_STABLE}-${PREVIEW_CHANNEL}.20260904.4`);
    },
  );

  test("a queued older checkout can skip its already-published source but cannot become a new publication candidate", async () => {
    const workflow = Bun.YAML.parse(readFileSync(PREVIEW_RELEASE_WORKFLOW, "utf-8")) as {
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
    expect(validationRows).toBe(`sha=${history.first}\n`);
    const authorizedSha = /^sha=(.+)$/m.exec(validationRows)?.[1];
    expect(git(history.cwd, ["rev-parse", "HEAD"])).toBe(history.first);
    expect(git(history.cwd, ["rev-parse", "origin/main"])).toBe(history.third);

    for (const alreadyPublished of [true, false]) {
      const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      mock.releases = alreadyPublished
        ? [{ tag_name: `v${NEXT_STABLE}-${PREVIEW_CHANNEL}.${date}.1`, prerelease: true, draft: false }]
        : [];
      mock.tags = alreadyPublished
        ? [`v${NEXT_STABLE}-${PREVIEW_CHANNEL}.${date}.1`]
        : [];
      mock.annotated = alreadyPublished
        ? {
          [`v${NEXT_STABLE}-${PREVIEW_CHANNEL}.${date}.1`]: {
            source: history.first,
            repository: "owner/repo",
          },
        }
        : {};
      writeFileSync(planningOutput, "");
      rmSync(planPath, { force: true });
      const planned = await runWorkflowStep(planScript, history.cwd, {
        ...env,
        AUTHORIZED_SHA: authorizedSha,
        GITHUB_OUTPUT: planningOutput,
      });
      const rawPlanningRows = readFileSync(planningOutput, "utf-8");
      // Native Windows jq ends its JSON row with CRLF; GitHub's environment
      // file consumes rows with either delimiter. Keep each row exact.
      const planningRows = process.platform === "win32"
        ? rawPlanningRows.replaceAll("\r\n", "\n")
        : rawPlanningRows;
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

  test("stable and preview releases use isolated, fully gated DAGs", () => {
    type WorkflowJob = {
      needs?: string | string[];
      if?: string;
      environment?: string;
      permissions?: Record<string, string>;
      uses?: string;
      with?: Record<string, string>;
      secrets?: string;
      env?: Record<string, string>;
      outputs?: Record<string, string>;
      steps?: Array<{
        name?: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
      }>;
    };
    type Workflow = {
      on: Record<string, unknown> & {
        push?: { tags: string[] };
        schedule?: Array<{ cron: string; timezone?: string }>;
      };
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs: Record<string, WorkflowJob>;
    };
    const stableText = readFileSync(STABLE_RELEASE_WORKFLOW, "utf-8");
    const previewText = readFileSync(PREVIEW_RELEASE_WORKFLOW, "utf-8");
    const stable = Bun.YAML.parse(stableText) as Workflow;
    const preview = Bun.YAML.parse(previewText) as Workflow;
    const ci = Bun.YAML.parse(readFileSync(CI_WORKFLOW, "utf-8")) as {
      on: Record<string, unknown>;
    };

    expect(Object.keys(ci.on)).toContain("workflow_call");
    expect(Object.keys(stable.on)).toEqual(["push"]);
    expect(stable.on.push?.tags).toEqual(["v*.*.*", "!v*-preview.*"]);
    expect(stable.concurrency).toEqual({
      group: "release-stable",
      "cancel-in-progress": false,
    });
    expect(stable.jobs.gate).toBeUndefined();
    expect(stable.jobs.verify.needs).toBe("validate");
    for (const job of ["test_smoke", "test_unit", "test_deep", "test"]) {
      expect(stable.jobs[job], `${job} must not rerun source tiers`).toBeUndefined();
    }
    expect(stableText).not.toContain("tests/run-tests.");
    expect(stable.jobs["native-smoke"].needs).toEqual(["validate", "verify"]);
    expect(stable.jobs["native-smoke"].steps?.some((step) => step.run?.includes("t238-build-binaries"))).toBe(true);
    expect(stable.jobs.validate.outputs).toEqual({
      tag: `\${{ steps.validate.outputs.tag }}`,
      sha: `\${{ steps.validate.outputs.sha }}`,
    });
    expect(stable.jobs.release.environment).toBe("release");
    expect(stable.jobs["release-result"].needs).toEqual(["validate", "release"]);
    expect(stableText).not.toContain("plan-preview-release.ts");
    expect(stableText).not.toContain("AIDLC_BUILD_VERSION");
    expect(stableText).not.toContain("./.github/workflows/ci.yml");
    expect(stable.jobs.validate.permissions).toEqual({ contents: "read" });
    expect(stable.jobs.validate.steps?.some((step) => step.name === "Require passing full-suite evidence")).toBe(false);
    expect(stableText).not.toContain("full-suite.yml");
    expect(stableText).not.toContain("full-suite-result");

    const releaseRunbooks = [
      "CONTRIBUTING.md",
      "DEVELOPERS.md",
      "docs/reference/09-testing.md",
      "docs/reference/11-contributing.md",
      "docs/reference/19-supply-chain-security.md",
      "tests/README.md",
    ];
    const obsoleteStableGateClaims = [
      "stable releases consume passing evidence",
      "obtain evidence for the final commit",
      "release-preparation commit needs its own evidence",
      "tag push validates the recorded test evidence",
      "evidence artifact is missing or expired",
      "stable gate also accepts",
      "does not satisfy the stable gate",
      "before tagging, obtain exact-sha passing preview evidence",
      "requires passing full suite evidence for the exact tag sha",
      "a successful preview-release.yml run for the exact tag sha",
      "failed tests block preview and stable publication",
      "stable promotion can reject historical disabled-live reports",
      "tiers. those run before tagging through pr checks",
    ];
    for (const path of releaseRunbooks) {
      const runbook = readFileSync(join(REPO_ROOT, path), "utf8").toLowerCase();
      for (const obsoleteClaim of obsoleteStableGateClaims) {
        expect(
          runbook,
          `${path} contains obsolete stable-release guidance`,
        ).not.toContain(obsoleteClaim);
      }
    }

    const normalizedSupplyChain = readFileSync(
      join(REPO_ROOT, "docs/reference/19-supply-chain-security.md"),
      "utf8",
    )
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(normalizedSupplyChain).toContain(
      "required pr checks provide linux smoke, unit, and deterministic integration coverage",
    );
    expect(normalizedSupplyChain).toContain(
      "cross-platform e2e runs only through optional preview or expanded manual ci",
    );
    expect(normalizedSupplyChain).toContain(
      "hosted live coverage runs only through optional preview or a manually dispatched full suite",
    );
    const normalizedTestingGuide = readFileSync(
      join(REPO_ROOT, "docs/reference/09-testing.md"),
      "utf8",
    )
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(normalizedTestingGuide).toContain(
      "failed tests block preview publication for an ordinary full suite run",
    );
    expect(normalizedTestingGuide).toContain(
      "they do not block stable publication",
    );

    expect(Object.keys(preview.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(preview.on.schedule).toEqual([{
      cron: "0 22 * * *",
      timezone: "Europe/Lisbon",
    }]);
    expect(preview.concurrency).toEqual({
      group: "release-preview",
      "cancel-in-progress": false,
    });
    expect(preview.jobs.gate).toMatchObject({
      needs: "validate",
      "runs-on": "ubuntu-latest",
    });
    expect(preview.jobs.gate.if).toBeUndefined();
    expect(preview.jobs.gate.uses).toBeUndefined();
    expect(preview.jobs.gate.steps?.filter((step) => step.run === "bun run check")).toHaveLength(1);
    expect(preview.jobs.gate.steps?.some((step) => step.run?.includes("tests/run-tests"))).toBe(false);
    expect(preview.jobs.gate.steps?.some((step) => step.run === "shellcheck scripts/install.sh")).toBe(true);
    expect(previewText).not.toContain("./.github/workflows/ci.yml");
    expect(preview.jobs.verify).toBeUndefined();
    expect(preview.jobs["native-smoke"].needs).toEqual(["validate", "gate", "test"]);
    expect(preview.jobs["native-smoke"].if).toBe("needs.validate.outputs.skip != 'true'");
    expect(preview.jobs.full_suite).toMatchObject({
      needs: ["validate", "gate"],
      uses: "./.github/workflows/full-suite.yml",
      with: { ref: `\${{ needs.validate.outputs.sha }}` },
    });
    expect(preview.jobs.full_suite.secrets).toBeUndefined();
    expect(preview.jobs.full_suite.if).toBeUndefined();
    expect(preview.jobs.test.needs).toEqual(["validate", "full_suite"]);
    expect(preview.jobs.test.steps?.[0].env?.FULL_SUITE_RESULT).toBe(`\${{ needs.full_suite.result }}`);
    expect(preview.jobs.test.if).not.toContain("needs.validate.outputs.skip");
    expect(preview.jobs.release.environment).toBe("preview");
    expect(preview.jobs.release.permissions).toEqual({ contents: "write" });

    const dependencies = (job: WorkflowJob): string[] =>
      job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    for (const workflow of [preview, stable]) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        for (const dependency of dependencies(job)) {
          expect(workflow.jobs[dependency], `${name} needs ${dependency}`).toBeDefined();
        }
      }
    }
    const ancestors = (name: string, jobs = preview.jobs, seen = new Set<string>()): Set<string> => {
      for (const dependency of dependencies(jobs[name])) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        ancestors(dependency, jobs, seen);
      }
      return seen;
    };
    for (const name of [
      "full_suite",
      "test",
      "native-smoke",
      "build",
      "musl-smoke",
      "stage-release",
      "windows-lifecycle",
      "unix-lifecycle",
      "publish",
      "release",
    ]) {
      expect(ancestors(name).has("gate"), `${name} must descend from the contract gate`).toBe(true);
    }
    for (const name of ["build", "musl-smoke", "stage-release", "windows-lifecycle", "unix-lifecycle", "publish", "release"]) {
      const required = ancestors(name, stable.jobs);
      for (const dependency of ["validate", "verify", "native-smoke"]) {
        expect(required.has(dependency), `stable ${name} must descend from ${dependency}`).toBe(true);
      }
    }
    expect(stable.jobs.publish.needs).toEqual(["validate", "musl-smoke", "windows-lifecycle", "unix-lifecycle"]);
    expect(stable.jobs.release.needs).toEqual(["validate", "publish"]);

    for (const key of ["tag", "sha", "skip", "preview_version", "preview_plan"]) {
      expect(preview.jobs.validate.outputs?.[key], key).toBeDefined();
    }
    expect(preview.jobs.validate.outputs?.channel).toBeUndefined();
    const plan = preview.jobs.validate.steps?.find(
      (step) => step.name === "Plan preview publication",
    );
    expect(plan?.run).toContain("bun scripts/plan-preview-release.ts");
    expect(plan?.run).toContain("--source-digest \"$AUTHORIZED_SHA\"");
    expect(previewText).not.toContain("immutable-releases");

    const stamp = `\${{ needs.validate.outputs.preview_version }}`;
    expect(preview.jobs.build.env?.AIDLC_BUILD_VERSION).toBe(stamp);
    expect(preview.jobs["stage-release"].env?.AIDLC_BUILD_VERSION).toBe(stamp);
    const smoke = preview.jobs["native-smoke"].steps ?? [];
    expect(smoke.find((step) => step.run === "bun scripts/package.ts")?.env?.AIDLC_BUILD_VERSION)
      .toBe(stamp);
    expect(smoke.find((step) => step.run?.includes("t238-build-binaries"))?.env?.AIDLC_BUILD_VERSION)
      .toBe(stamp);
    expect(preview.jobs.gate.env).toBeUndefined();

    const publish = preview.jobs.release.steps?.find(
      (step) => step.name === "Create preview GitHub Release",
    );
    expect(publish?.if).toBeUndefined();
    expect(publish?.run).toContain("bun scripts/publish-release.ts");
    expect(publish?.run).toContain("--channel preview");
    expect(publish?.run).toContain("--preview-plan \"$plan\"");
    expect(publish?.run).toContain("--expected-assets 15");
    expect(previewText).toContain(
      "awslabs/aidlc-workflows/.github/workflows/preview-release.yml",
    );
    expect(preview.jobs["release-result"].needs).toEqual(["validate", "test", "release"]);
    const result = preview.jobs["release-result"].steps?.find(
      (step) => step.name === "Require publication or an intentional preview skip",
    );
    expect(result?.run).toContain("[ \"$RELEASE_SKIP\" = true ]");
    expect(result?.env?.TEST_RESULT).toBe(`\${{ needs.test.result }}`);
    expect(result?.run?.indexOf('test "$TEST_RESULT" = success')).toBeLessThan(result!.run!.indexOf('[ "$RELEASE_SKIP" = true ]'));
    expect(result?.run).toContain("test \"$RELEASE_RESULT\" = success");
  });
});

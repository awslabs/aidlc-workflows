import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  serverInfoPath,
  mintReviewUiOpenUrl,
  type CurrentPointer,
  type ReviewManifest,
  type ServerInfo,
} from "../../core/tools/aidlc-review-ui-shared.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DAEMON = join(ROOT, "core", "tools", "aidlc-review-ui.ts");
const ASSETS = join(ROOT, "core", "tools", "data", "review-ui");
const TOKEN_HEADER = "X-AIDLC-Token";

let temp = "";
let project = "";
let reviewHome = "";
let infoPath = "";
let info: ServerInfo;
let daemon: ReturnType<typeof Bun.spawn> | null = null;
let createdAssets = false;

function projectRelative(path: string): string {
  return relative(project, path).split(sep).join("/");
}

async function waitForServerInfo(): Promise<ServerInfo> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) {
      try {
        const parsed = JSON.parse(readFileSync(infoPath, "utf-8")) as ServerInfo;
        if (parsed.port > 0 && parsed.token) return parsed;
      } catch {
        // Atomic creation can race the first read on unusual filesystems.
      }
    }
    if (daemon?.exitCode !== null) {
      const stderr = daemon?.stderr instanceof ReadableStream
        ? await new Response(daemon.stderr).text()
        : "";
      throw new Error(`daemon exited ${daemon?.exitCode}: ${stderr}`);
    }
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for review UI server.json");
}

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, info.token);
  return fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "aidlc-review-daemon-"));
  project = join(temp, "project");
  reviewHome = join(temp, "review-home");
  const recordName = "review-fixture-12345678";
  const record = join(project, "aidlc", "spaces", "default", "intents", recordName);
  const stage = join(record, "inception", "requirements-analysis");
  const reviewDir = join(stage, ".review-ui");
  mkdirSync(join(reviewDir, "snapshots", "r0"), { recursive: true });
  mkdirSync(join(record, ".review-ui"), { recursive: true });
  writeFileSync(join(project, "aidlc", "active-space"), "default\n");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "active-intent"), `${recordName}\n`);
  writeFileSync(
    join(record, "aidlc-state.md"),
    [
      "# AI-DLC State Tracking",
      "",
      "## Runtime State",
      "- **Revision Count**: 0",
      "",
      "## Stage Progress",
      "- [?] requirements-analysis — EXECUTE",
      "",
      "## Current Status",
      "- **Lifecycle Phase**: INCEPTION",
      "- **Current Stage**: requirements-analysis",
      "- **Status**: Running",
      "",
    ].join("\n"),
  );
  const markdownPath = join(stage, "requirements.md");
  const htmlPath = join(stage, "review.html");
  writeFileSync(markdownPath, "# Requirements\n\nCurrent requirement.\n\n<script>alert(1)</script>\n");
  writeFileSync(htmlPath, "<!doctype html><html><head><title>Review</title></head><body>HTML review</body></html>");
  writeFileSync(join(reviewDir, "snapshots", "r0", "requirements.md"), "# Requirements\n\nOriginal requirement.\n");

  const stageRelative = projectRelative(stage);
  const current: CurrentPointer = {
    version: 1,
    state: "awaiting-approval",
    stage: "requirements-analysis",
    unit: null,
    open: null,
    stage_dir: stageRelative,
    revision: 0,
    updated_at: "2026-09-03T10:00:00.000Z",
  };
  const manifest: ReviewManifest = {
    version: 1,
    stage: "requirements-analysis",
    phase: "inception",
    unit: null,
    revision: 0,
    opened_at: "2026-09-03T10:00:00.000Z",
    artifacts: [
      {
        name: "Requirements",
        path: projectRelative(markdownPath),
        format: "md",
        kind: "document",
        sha256: null,
        exists: true,
      },
      {
        name: "HTML review",
        path: projectRelative(htmlPath),
        format: "html",
        kind: "document",
        sha256: null,
        exists: true,
      },
    ],
    review_artifact: projectRelative(markdownPath),
    questions_file: null,
    guide: null,
  };
  writeFileSync(join(record, ".review-ui", "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  writeFileSync(join(reviewDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (!existsSync(ASSETS)) {
    createdAssets = true;
    mkdirSync(ASSETS, { recursive: true });
    writeFileSync(join(ASSETS, "index.html"), "<!doctype html><title>Review UI test shell</title>");
    writeFileSync(join(ASSETS, "bridge.js"), "globalThis.__aidlcBridge = true;\n");
  }

  const env = {
    ...process.env,
    AIDLC_REVIEW_HOME: reviewHome,
    AIDLC_REVIEW_PORT: "0",
    AIDLC_REVIEW_HOST: "127.0.0.1",
    AIDLC_REVIEW_OPEN: "0",
  };
  infoPath = serverInfoPath(project, env);
  daemon = Bun.spawn([process.execPath, DAEMON, "serve", "--project-dir", project], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  info = await waitForServerInfo();
});

afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  const cleanupDeadline = Date.now() + 2_000;
  while (existsSync(infoPath) && Date.now() < cleanupDeadline) await Bun.sleep(20);
  if (createdAssets) rmSync(ASSETS, { recursive: true, force: true });
  if (temp) rmSync(temp, { recursive: true, force: true });
});

describe("t332 review UI daemon HTTP API", () => {
  test("authenticates, reviews artifacts, writes feedback, diffs, and cleans up", async () => {
    const base = `http://127.0.0.1:${info.port}`;
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, project_id: info.project_id, pid: info.pid });

    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const state = await authorized("/api/state");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      space: "default",
      intent: "review-fixture-12345678",
      stage_status: "[?]",
      revision_count: 0,
      current: { stage: "requirements-analysis" },
      manifest: { stage: "requirements-analysis" },
    });
    expect(info.url).toBe(`http://localhost:${info.port}/`);
    expect(info.url).not.toContain(info.token);
    const unauthenticatedShell = await fetch(`${base}/`);
    expect(unauthenticatedShell.status).toBe(403);
    expect(await unauthenticatedShell.text()).toContain("aidlc-review-ui.ts open");

    const openUrl = mintReviewUiOpenUrl(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: reviewHome,
    });
    expect(openUrl).toMatch(/^http:\/\/localhost:\d+\/open\/[0-9a-f]{32}$/);
    expect(openUrl).toBeDefined();
    const openResponse = await fetch(openUrl!, { redirect: "manual" });
    expect(openResponse.status).toBe(302);
    expect(openResponse.headers.get("location")).toBe("/");
    const setCookie = openResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`aidlc_review=${info.token}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=43200");
    expect((await fetch(openUrl!, { redirect: "manual" })).status).toBe(403);

    const concurrentUrl = mintReviewUiOpenUrl(project, {
      ...process.env,
      AIDLC_REVIEW_HOME: reviewHome,
    });
    expect(concurrentUrl).toBeDefined();
    const concurrentResponses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(concurrentUrl!, { redirect: "manual" })),
    );
    expect(concurrentResponses.filter((response) => response.status === 302)).toHaveLength(1);
    expect(concurrentResponses.filter((response) => response.status === 403)).toHaveLength(7);
    const concurrentWinner = concurrentResponses.find((response) => response.status === 302);
    expect(concurrentWinner?.headers.get("set-cookie")).toContain(`aidlc_review=${info.token}`);
    const cookie = setCookie.split(";", 1)[0];
    const cookieState = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
    expect(cookieState.status).toBe(200);
    const authenticatedShell = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    expect(authenticatedShell.status).toBe(200);

    const artifactPath = "aidlc/spaces/default/intents/review-fixture-12345678/inception/requirements-analysis/requirements.md";
    const artifact = await authorized(`/api/artifact?path=${encodeURIComponent(artifactPath)}`);
    const artifactBody = await artifact.json();
    expect(artifact.status).toBe(200);
    expect(artifactBody).toMatchObject({ path: artifactPath, format: "md" });
    expect(artifactBody.source).toContain("Current requirement.");
    expect(artifactBody.html).toContain('<h1 id="requirements">Requirements</h1>');
    expect(artifactBody.html).not.toContain("<script");

    const feedback = await authorized("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },

      body: JSON.stringify({
        stage: "requirements-analysis",
        unit: null,
        revision: 0,
        decision_hint: "request-changes",
        annotations: [
          {
            artifact: "requirements.md",
            kind: "comment",
            heading_path: ["Requirements"],
            line_start: 3,
            line_end: 3,
            selection: "Current requirement.",
            body: "Make the requirement measurable.",
          },
        ],
      }),
    });
    const staleFeedback = await authorized("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "requirements-analysis",
        unit: null,
        revision: 1,
        decision_hint: "none",
        annotations: [],
      }),
    });
    expect(staleFeedback.status).toBe(409);

    const tooLarge = await authorized("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(feedback.status).toBe(200);
    const feedbackBody = await feedback.json();
    expect(feedbackBody.file).toBe("feedback-001.md");
    const feedbackText = readFileSync(join(project, feedbackBody.path), "utf-8");
    expect(feedbackText).toContain("aidlc_review_feedback: 1");
    expect(feedbackText).toContain("stage: requirements-analysis");
    expect(feedbackText).toContain("### Comment — Requirements (lines ~3-3)");

    const htmlPath = artifactPath.replace("requirements.md", "review.html");
    const raw = await authorized(`/api/raw?path=${encodeURIComponent(htmlPath)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await raw.text()).toContain('<script src="/assets/bridge.js"></script>');

    const diff = await authorized(
      `/api/diff?path=${encodeURIComponent(artifactPath)}&from=0&to=current`,
    );
    expect(diff.status).toBe(200);
    const diffBody = await diff.json();
    expect(diffBody.unified).toContain("-Original requirement.");
    expect(diffBody.unified).toContain("+Current requirement.");

    const exported = await authorized(`/api/export?path=${encodeURIComponent(artifactPath)}`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/html");
    const exportedBody = await exported.text();
    expect(exportedBody).not.toContain("http://");
    expect(exportedBody).not.toContain("https://");

    const escaped = await authorized(
      "/api/artifact?path=aidlc%2F..%2Foutside%2Fsecret.md",
    );
    expect(escaped.status).toBe(403);
    expect(statSync(infoPath).mode & 0o777).toBe(0o600);
  });

  test("SIGTERM removes owner-only discovery state", async () => {
    expect(daemon).not.toBeNull();
    daemon!.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while ((daemon!.exitCode === null || existsSync(infoPath)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(daemon!.exitCode).toBe(0);
    expect(existsSync(infoPath)).toBeFalse();
  });
});

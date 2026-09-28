// covers: file:tests/harness/failed-fixture.ts
//
// A failed SDK fixture lives under the OS temporary directory, which a hosted
// runner discards. retainFailedFixture keeps a bounded, link-safe snapshot in
// the run's log directory, which the platform collectors copy and the CI
// sanitizer redacts before upload.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeLogs } from "../../scripts/ci-sanitize-logs.ts";
import { retainFailedFixture } from "../harness/failed-fixture.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
const priorLogDir = process.env.AIDLC_TEST_LOG_DIR;

afterEach(() => {
  if (priorLogDir === undefined) delete process.env.AIDLC_TEST_LOG_DIR;
  else process.env.AIDLC_TEST_LOG_DIR = priorLogDir;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function put(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function manifest(snapshot: string): { copied: number; skipped: Array<{ path: string; reason: string }> } {
  return JSON.parse(readFileSync(join(snapshot, "retained-fixture.json"), "utf-8"));
}

describe("t-failed-fixture-retention", () => {
  test("copies the workflow record and project files beneath the log directory", () => {
    const project = temp("aidlc-retain-project-");
    const logs = temp("aidlc-retain-logs-");
    process.env.AIDLC_TEST_LOG_DIR = logs;
    put(project, "aidlc/spaces/default/intents/fixture/aidlc-state.md", "- **Status**: Running\n");
    put(project, "src/app.ts", "export const app = 1;\n");
    put(project, "node_modules/pkg/index.js", "module.exports = 1;\n");
    put(project, ".git/HEAD", "ref: refs/heads/main\n");

    const kept = retainFailedFixture(project, "t183 codekb");
    expect(kept).not.toBeNull();
    expect(kept!.path.startsWith(join(logs, "failed-fixtures", "t183-codekb-"))).toBe(true);
    expect(readFileSync(join(kept!.path, "aidlc/spaces/default/intents/fixture/aidlc-state.md"), "utf-8"))
      .toBe("- **Status**: Running\n");
    expect(readFileSync(join(kept!.path, "src/app.ts"), "utf-8")).toBe("export const app = 1;\n");
    expect(existsSync(join(kept!.path, "node_modules"))).toBe(false);
    expect(existsSync(join(kept!.path, ".git"))).toBe(false);
    expect(manifest(kept!.path)).toMatchObject({
      copied: 2,
      skipped: expect.arrayContaining([
        { path: "node_modules", reason: "excluded" },
        { path: ".git", reason: "excluded" },
      ]),
    });
    // The original stays for a local rerun; only the snapshot is new.
    expect(existsSync(join(project, "src/app.ts"))).toBe(true);
  });

  test("never follows a link out of the project", () => {
    const project = temp("aidlc-retain-project-");
    const outside = temp("aidlc-retain-outside-");
    process.env.AIDLC_TEST_LOG_DIR = temp("aidlc-retain-logs-");
    put(outside, "secret.txt", "outside the fixture\n");
    put(project, "aidlc/state.md", "state\n");
    symlinkSync(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");

    const kept = retainFailedFixture(project, "t193")!;
    expect(existsSync(join(kept.path, "linked"))).toBe(false);
    expect(manifest(kept.path).skipped).toContainEqual({ path: "linked", reason: "link" });
  });

  test("the caps keep the workflow record ahead of everything else", () => {
    const project = temp("aidlc-retain-project-");
    process.env.AIDLC_TEST_LOG_DIR = temp("aidlc-retain-logs-");
    put(project, "aidlc/state.md", "x".repeat(40));
    put(project, "a-first.txt", "y".repeat(40));
    put(project, "b-huge.bin", Buffer.alloc(200));

    const caps = { maxEntries: 1_000, maxListedSkips: 100 };
    const kept = retainFailedFixture(project, "caps", { ...caps, maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 60 })!;
    expect(existsSync(join(kept.path, "aidlc/state.md"))).toBe(true);
    expect(manifest(kept.path).skipped).toEqual(expect.arrayContaining([
      { path: "a-first.txt", reason: "total-limit" },
      { path: "b-huge.bin", reason: "file-too-large" },
    ]));

    const counted = retainFailedFixture(project, "count", { ...caps, maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 1_000 })!;
    expect(manifest(counted.path).copied).toBe(1);
    expect(manifest(counted.path).skipped).toContainEqual({ path: "a-first.txt", reason: "file-limit" });
  });

  test("one directory far larger than the walk cap is not listed in full", () => {
    const project = temp("aidlc-retain-project-");
    process.env.AIDLC_TEST_LOG_DIR = temp("aidlc-retain-logs-");
    for (let index = 0; index < 400; index++) put(project, `flat/entry-${index}.txt`, "x");
    const kept = retainFailedFixture(project, "flat", {
      maxFiles: 5_000, maxFileBytes: 100, maxTotalBytes: 100_000, maxEntries: 30, maxListedSkips: 5,
    })!;
    const written = JSON.parse(readFileSync(join(kept.path, "retained-fixture.json"), "utf-8"));
    expect(written.truncated).toBe(true);
    // The project root and the flat directory are visited, then 28 entries.
    expect(written.copied).toBe(28);
  });

  test("a huge tree stops the walk and the omission list stays bounded", () => {
    const project = temp("aidlc-retain-project-");
    process.env.AIDLC_TEST_LOG_DIR = temp("aidlc-retain-logs-");
    put(project, "aidlc/state.md", "state\n");
    for (let index = 0; index < 40; index++) put(project, `many/file-${String(index).padStart(2, "0")}.txt`, "x".repeat(200));

    const kept = retainFailedFixture(project, "huge", {
      maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 1_000, maxEntries: 25, maxListedSkips: 5,
    })!;
    const written = JSON.parse(readFileSync(join(kept.path, "retained-fixture.json"), "utf-8"));
    expect(written.truncated).toBe(true);
    expect(written.skipped).toHaveLength(5);
    expect(written.skippedByReason["file-too-large"]).toBeGreaterThan(5);
    expect(existsSync(join(kept.path, "aidlc/state.md"))).toBe(true);
  });

  test("without a log directory nothing is written", () => {
    const project = temp("aidlc-retain-project-");
    delete process.env.AIDLC_TEST_LOG_DIR;
    put(project, "aidlc/state.md", "state\n");
    expect(retainFailedFixture(project, "local")).toBeNull();
  });

  test("the sanitizer publishes a snapshot's text and drops what it cannot prove clean", async () => {
    const project = temp("aidlc-retain-project-");
    const logs = temp("aidlc-retain-logs-");
    process.env.AIDLC_TEST_LOG_DIR = logs;
    const key = `AKIA${"C3".repeat(8)}`;
    put(project, "aidlc/state.md", `- **Status**: Running\nkey=${key}\n`);
    put(project, "blob.bin", Buffer.from([0, 1, 2, 3]));
    const kept = retainFailedFixture(project, "sanitized")!;

    await sanitizeLogs(logs);
    const state = readFileSync(join(kept.path, "aidlc/state.md"), "utf-8");
    expect(state).toContain("- **Status**: Running");
    expect(state).not.toContain(key);
    expect(existsSync(join(kept.path, "blob.bin"))).toBe(false);
  });

  test("both live collectors copy the whole log tree the snapshot lives in", () => {
    // POSIX: the administrator-side copy takes every entry under tests/logs.
    const posix = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.sh"), "utf-8");
    expect(posix).toContain(`sudo cp -a "$live_root/tests/logs/." "$GITHUB_WORKSPACE/tests/logs/"`);
    // Windows: the tests\logs tree is staged whole with links rejected.
    const windows = readFileSync(join(REPO_ROOT, ".github/scripts/prepare-live-runtime.ps1"), "utf-8");
    expect(windows).toContain(`@{ label = 'tests'; source = (Join-Path $work 'tests\\logs'); optional = $true }`);
    expect(windows).toContain("Copy-PlainTree $item.source $staging -RejectLinks");
    // Every live job sanitizes, then uploads, that same tree.
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/full-suite.yml"), "utf-8");
    expect(workflow.match(/run: bun scripts\/ci-sanitize-logs\.ts tests\/logs/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
    expect(workflow.match(/path: tests\/logs\//g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

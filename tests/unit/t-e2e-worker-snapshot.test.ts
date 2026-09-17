// Real checkout copies and native links; no live harness or provider calls.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  cleanupE2eTransports, e2eWorkerEnvironment, finishE2eTemporaryFiles,
  normalizeE2eExternalPaths, prepareE2eWorkers,
} from "../lib/e2e-workers.ts";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-worker-snapshot-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}
function fixture(): string {
  const root = scratch();
  git(root, "init", "-q");
  git(root, "config", "core.symlinks", "true");
  writeFileSync(join(root, ".gitignore"), "tmp/\nnode_modules/\ndist/\ndist-release/\n");
  writeFileSync(join(root, "real.txt"), "original bytes");
  git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  return root;
}

test("nested shared source checkouts do not deepen worker object dependencies", async () => {
  const original = fixture();
  const revision = git(original, "rev-parse", "HEAD").trim();
  let source = original;
  for (let depth = 0; depth < 5; depth++) {
    const next = scratch();
    git(source, "clone", "--quiet", "--shared", source, next);
    source = next;
  }
  expect(git(source, "show", "HEAD:real.txt")).toBe("original bytes");
  writeFileSync(join(source, "real.txt"), "uncommitted source");
  const pool = await prepareE2eWorkers(source, scratch(), 2);
  try {
    for (const worker of pool.workers) {
      expect(git(worker.root, "rev-parse", "HEAD").trim()).toBe(revision);
      expect(git(worker.root, "show", "HEAD:real.txt")).toBe("original bytes");
      expect(readFileSync(join(worker.root, "real.txt"), "utf8")).toBe("uncommitted source");
    }
    git(pool.workers[0].root, "add", "real.txt");
    git(pool.workers[0].root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "worker-only");
    expect(git(pool.workers[1].root, "rev-parse", "HEAD").trim()).toBe(revision);
    expect(git(source, "rev-parse", "HEAD").trim()).toBe(revision);
    // A worker must not depend on either temporary intermediate repository.
    rmSync(join(pool.root, "snapshot", ".git"), { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
    expect(git(pool.workers[0].root, "show", "HEAD:real.txt")).toBe("uncommitted source");
    expect(git(pool.workers[1].root, "show", "HEAD:real.txt")).toBe("original bytes");
    for (const worker of pool.workers) git(worker.root, "fsck", "--full", "--no-dangling");
  } finally {
    await pool.dispose(false);
  }
}, 30_000);

test("linked worktrees preserve relative alternate objects and their selected revision", async () => {
  const original = fixture();
  const shared = scratch();
  git(original, "clone", "--quiet", "--shared", original, shared);
  const objects = join(shared, ".git", "objects");
  writeFileSync(join(objects, "info", "alternates"),
    `${relative(objects, join(original, ".git", "objects")).replaceAll("\\", "/")}\n`);
  const worktree = join(scratch(), "linked");
  git(shared, "worktree", "add", "--quiet", "-b", "worker-source", worktree);
  writeFileSync(join(worktree, "selected.txt"), "linked worktree revision");
  git(worktree, "add", "selected.txt");
  git(worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "selected revision");
  const revision = git(worktree, "rev-parse", "HEAD").trim();
  expect(revision).not.toBe(git(shared, "rev-parse", "HEAD").trim());
  const pool = await prepareE2eWorkers(worktree, scratch(), 1);
  try {
    expect(pool.sourceRevision).toBe(revision);
    const worker = pool.workers[0].root;
    expect(git(worker, "rev-parse", "HEAD").trim()).toBe(revision);
    expect(git(worker, "show", "HEAD:selected.txt")).toBe("linked worktree revision");
    expect(git(worker, "show", "HEAD:real.txt")).toBe("original bytes");
    git(worker, "fsck", "--full", "--no-dangling");
  } finally {
    await pool.dispose(false);
  }
}, 30_000);

const otherFilesystem = process.platform !== "win32" && existsSync("/dev/shm") &&
  lstatSync("/dev/shm").dev !== lstatSync(tmpdir()).dev;
test.skipIf(!otherFilesystem)("source objects can be copied across filesystem boundaries", async () => {
  const source = fixture();
  const output = mkdtempSync("/dev/shm/aidlc-worker-snapshot-");
  roots.push(output);
  const previousReserve = process.env.AIDLC_E2E_MIN_FREE_BYTES;
  try {
    // Container shared-memory mounts commonly have only 64 MiB. This tiny
    // fixture checks Git copying; production pools retain their 512 MiB reserve.
    process.env.AIDLC_E2E_MIN_FREE_BYTES = String(1024 * 1024);
    const pool = await prepareE2eWorkers(source, output, 1);
    try {
      expect(lstatSync(source).dev).not.toBe(lstatSync(pool.root).dev);
      expect(git(pool.workers[0].root, "show", "HEAD:real.txt")).toBe("original bytes");
      writeFileSync(join(pool.workers[0].root, "real.txt"), "worker only");
      expect(readFileSync(join(source, "real.txt"), "utf8")).toBe("original bytes");
    } finally {
      await pool.dispose(false);
    }
  } finally {
    if (previousReserve === undefined) delete process.env.AIDLC_E2E_MIN_FREE_BYTES;
    else process.env.AIDLC_E2E_MIN_FREE_BYTES = previousReserve;
  }
}, 30_000);

test("relative and dangling links retain their bytes and writes stay in one worker", async () => {
  const root = fixture();
  symlinkSync("real.txt", join(root, "alias.txt"), "file");
  symlinkSync("missing.txt", join(root, "dangling.txt"), "file");
  git(root, "add", "alias.txt", "dangling.txt");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "links");
  const output = scratch();
  const pool = await prepareE2eWorkers(root, output, 2);
  try {
    for (const worker of pool.workers) {
      expect(readlinkSync(join(worker.root, "alias.txt"))).toBe("real.txt");
      expect(lstatSync(join(worker.root, "dangling.txt")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(worker.root, "dangling.txt"))).toBe("missing.txt");
      expect(git(worker.root, "diff", "--", "alias.txt", "dangling.txt")).toBe("");
    }
    writeFileSync(join(pool.workers[0].root, "alias.txt"), "worker one");
    expect(readFileSync(join(pool.workers[0].root, "real.txt"), "utf8")).toBe("worker one");
    expect(readFileSync(join(pool.workers[1].root, "alias.txt"), "utf8")).toBe("original bytes");
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("original bytes");
  } finally {
    await pool.dispose(false);
  }
}, 30_000);

test("generated-tree links also stay relative in every copied checkout", async () => {
  const root = fixture();
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "real.txt"), "generated bytes");
  symlinkSync("real.txt", join(root, "dist", "alias.txt"), "file");
  const pool = await prepareE2eWorkers(root, scratch(), 2);
  try {
    expect(readlinkSync(join(pool.workers[0].root, "dist", "alias.txt"))).toBe("real.txt");
    writeFileSync(join(pool.workers[0].root, "dist", "alias.txt"), "worker output");
    expect(readFileSync(join(pool.workers[1].root, "dist", "alias.txt"), "utf8")).toBe("generated bytes");
    expect(readFileSync(join(root, "dist", "real.txt"), "utf8")).toBe("generated bytes");
  } finally {
    await pool.dispose(false);
  }
}, 30_000);

test.each(["absolute", "escaping"] as const)("an %s link fails before worker execution", async (kind) => {
  const root = fixture();
  const external = scratch();
  writeFileSync(join(external, "outside.txt"), "untouched");
  const target = kind === "absolute"
    ? join(root, "real.txt")
    : `../${external.split(/[\\/]/).at(-1)}/outside.txt`;
  symlinkSync(target, join(root, "alias.txt"), "file");
  const output = scratch();
  await expect(prepareE2eWorkers(root, output, 2)).rejects.toThrow("symlink");
  expect(existsSync(join(output, "e2e-workers"))).toBe(false);
  expect(readFileSync(join(external, "outside.txt"), "utf8")).toBe("untouched");
}, 30_000);

test("an existing dependency link stays the explicit shared exception", async () => {
  const root = fixture();
  const dependencies = scratch();
  writeFileSync(join(dependencies, "package-marker.txt"), "shared dependency");
  // A directory-only gitignore entry need not exclude a node_modules symlink.
  symlinkSync(dependencies, join(root, "node_modules"), "junction");
  const pool = await prepareE2eWorkers(root, scratch(), 2);
  try {
    for (const worker of pool.workers) {
      expect(realpathSync(join(worker.root, "node_modules"))).toBe(realpathSync(dependencies));
      expect(readFileSync(join(worker.root, "node_modules", "package-marker.txt"), "utf8"))
        .toBe("shared dependency");
    }
  } finally {
    await pool.dispose(false);
  }
}, 30_000);

test("relative ignored seeds resolve from the source checkout after worker isolation", async () => {
  const root = fixture();
  mkdirSync(join(root, "tmp", "seed"), { recursive: true });
  writeFileSync(join(root, "tmp", "seed", "settings.json"), '{"seed":true}');
  const inherited = Object.freeze({
    AIDLC_TUI_BACKEND: "bun",
    AIDLC_KIRO_IDE_SEED: "tmp/seed",
    AIDLC_KIRO_IDE_BIN: "./bin/kiro",
    AIDLC_BUN_BIN: process.execPath,
    AIDLC_CODEX_BIN: "codex",
  });
  const output = scratch();
  const pool = await prepareE2eWorkers(root, output, 1);
  const worker = pool.workers[0];
  const artifacts = join(output, "artifacts");
  let env: NodeJS.ProcessEnv | undefined;
  try {
    expect(existsSync(join(worker.root, "tmp", "seed"))).toBe(false);
    env = await e2eWorkerEnvironment(worker, "t-ide-fixture.test.ts", artifacts, inherited);
    expect(env.AIDLC_KIRO_IDE_SEED).toBe(join(root, "tmp", "seed"));
    expect(readFileSync(join(env.AIDLC_KIRO_IDE_SEED!, "settings.json"), "utf8")).toBe('{"seed":true}');
    expect(env.AIDLC_KIRO_IDE_BIN).toBe(resolve(root, "bin", "kiro"));
    expect(env.AIDLC_CODEX_BIN).toBe("codex");
    expect(inherited.AIDLC_KIRO_IDE_SEED).toBe("tmp/seed");
    expect(normalizeE2eExternalPaths({ AIDLC_NODE_BIN: "./bin/node" }, root).AIDLC_NODE_BIN)
      .toBe(resolve(root, "bin/node"));
  } finally {
    if (env) {
      await cleanupE2eTransports(worker, env);
      await finishE2eTemporaryFiles(env, artifacts, false);
    }
    await pool.dispose(false);
  }
}, 30_000);

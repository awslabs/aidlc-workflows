// covers: tool:aidlc-init, tool:aidlc-lifecycle, file:core/tools/aidlc-archive.ts
// covers: file:core/tools/aidlc-transaction.ts, file:scripts/package.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTarGz,
  extractTarGz,
  readTarGz,
  type ArchiveEntry,
} from "../../core/tools/aidlc-archive.ts";
import { _installedSourcesForTests } from "../../core/tools/aidlc-init.ts";
import { compiledExecutable } from "../../core/tools/aidlc-runtime-paths.ts";
import { sha256Bytes, walkFiles } from "../../core/tools/aidlc-distribution.ts";
import {
  activeExecutablePath,
  commandPath,
  inspectInstalledVersion,
  machineTransactionRoot,
  packageManagerForExecutable,
  projectPinTargetPath,
  projectDirFrom,
  readActiveExecutable,
  targetTriple,
  windowsUninstallFencePath,
} from "../../core/tools/aidlc-install-paths.ts";
import {
  activate,
  reserveDispatchedVersion,
  resolvePinnedDispatch,
} from "../../core/tools/aidlc-lifecycle.ts";
import {
  TRUSTED_COMMAND_TOKENS,
  UNTRUSTED_ROUTE_NAMESPACES,
  trustedCommand,
} from "../../core/tools/aidlc-command.ts";
import {
  acquireRelease,
  digest,
  readReleaseManifest,
  verifyReleaseDirectory,
} from "../../core/tools/aidlc-release.ts";
import {
  executePlan,
  transactionSourceHash,
  transactionState,
  writeOperation,
} from "../../core/tools/aidlc-transaction.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  recoverWindowsUninstallContinuations,
  type WindowsUninstallJournal,
} from "../../core/tools/aidlc-windows-uninstall.ts";
import {
  checkLiveReleaseContract,
  serveReleaseFixture,
  writeReleaseFixture,
} from "../harness/release-fixture.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const LIFECYCLE = join(REPO_ROOT, "core", "tools", "aidlc-lifecycle.ts");
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const INSTALLER = join(REPO_ROOT, "scripts", "install.sh");
const FIXTURE_GH = join(REPO_ROOT, "tests", "fixtures", "bin", "gh.ts");
const CLAUDE_COPY = join(REPO_ROOT, "dist", "claude");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
const CODEX_RELEASE = join(REPO_ROOT, "dist-release", "codex");
const COPILOT_RELEASE = join(REPO_ROOT, "dist-release", "copilot");
const CURSOR_RELEASE = join(REPO_ROOT, "dist-release", "cursor");
const KIRO_IDE_COPY = join(REPO_ROOT, "dist", "kiro-ide");
const KIRO_IDE_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const OPENCODE_RELEASE = join(REPO_ROOT, "dist-release", "opencode");
const COMMAND_NAME = process.platform === "win32" ? "aidlc.cmd" : "aidlc";
const INSTALLED_EXECUTABLE = process.platform === "win32" ? "aidlc.exe" : "aidlc";
const KIRO_RELEASES = [
  join(REPO_ROOT, "dist-release", "kiro"),
  join(REPO_ROOT, "dist-release", "kiro-ide"),
] as const;
const NEXT_VERSION = (() => {
  const [major, minor, patch] = AIDLC_VERSION.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();
const temporary: string[] = [];
const originalPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = `${join(REPO_ROOT, "tests", "fixtures", "bin")}${delimiter}${
    originalPath ?? ""
  }`;
});

function releaseBinaryName(): string {
  return `aidlc-${targetTriple()}${process.platform === "win32" ? ".exe" : ""}`;
}

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

// Production emits canonical project and machine paths, so fixtures live under
// the canonical temp root (macOS aliases /var to /private/var).
function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function runAsync(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([BUN, tool, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function fixtureRelease(
  version = AIDLC_VERSION,
  reportedVersion = version,
  binary: "executable" | "bytes" = "executable",
): string {
  const root = temp("aidlc-t240-release-");
  writeReleaseFixture({
    root,
    repoRoot: REPO_ROOT,
    version,
    reportedVersion,
    binary,
    distributions: ["claude"],
  });
  return root;
}

function fixtureReleaseBytes(version = AIDLC_VERSION): string {
  return fixtureRelease(version, version, "bytes");
}

describe("t243 archive and transaction safety", () => {
  test("tar round-trip is deterministic and rejects traversal", () => {
    const entries: ArchiveEntry[] = [
      { path: "root/a.txt", type: "file", mode: 0o644, data: Buffer.from("alpha\n") },
      { path: "root/bin/run", type: "file", mode: 0o755, data: Buffer.from("#!/bin/sh\n") },
    ];
    expect(createTarGz(entries).equals(createTarGz([...entries].reverse()))).toBe(true);
    const archive = join(temp("aidlc-t240-archive-"), "fixture.tgz");
    writeFileSync(archive, createTarGz(entries));
    expect(readTarGz(archive).map((entry) => entry.path)).toEqual(["root/a.txt", "root/bin/run"]);
    const extracted = temp("aidlc-t240-extract-");
    extractTarGz(archive, extracted);
    expect(readFileSync(join(extracted, "root", "a.txt"), "utf-8")).toBe("alpha\n");
    expect(() => createTarGz([
      { path: "../escape", type: "file", mode: 0o644, data: Buffer.from("bad") },
    ])).toThrow("unsafe archive path");
    expect(() => createTarGz([
      { path: "root/../escape", type: "file", mode: 0o644, data: Buffer.from("bad") },
    ])).toThrow("unsafe archive path");
    expect(() => createTarGz([
      { path: "root", type: "directory", mode: 0o755, data: Buffer.from("bad") },
    ])).toThrow("unexpected file data");
  });

  test("runtime extraction rejects entries that could replace the verified executable", () => {
    for (const reserved of ["aidlc", "aidlc.exe"]) {
      const archive = join(temp("aidlc-t243-reserved-"), `${reserved}.tgz`);
      writeFileSync(archive, createTarGz([{
        path: reserved,
        type: "file",
        mode: 0o755,
        data: Buffer.from("shadow binary\n"),
      }]));
      expect(() =>
        extractTarGz(archive, temp("aidlc-t243-reserved-out-"), {
          reservedTopLevelNames: ["aidlc", "aidlc.exe"],
        })
      ).toThrow("reserved top-level name");
    }
  });

  test("transaction rejects symlink traversal and restores every committed byte on fault", () => {
    const root = temp("aidlc-t240-txn-");
    writeFileSync(join(root, "a.txt"), "old-a");
    writeFileSync(join(root, "b.txt"), "old-b");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("a.txt", "new-a"),
        writeOperation("b.txt", "new-b"),
      ],
    }, { failAfter: 1 })).toThrow("injected transaction failure");
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("old-a");
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("old-b");

    const outside = temp("aidlc-t240-outside-");
    symlinkSync(outside, join(root, "escape"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("escape/file.txt", "no")],
    })).toThrow("traverses a symlink");
    expect(existsSync(join(outside, "file.txt"))).toBe(false);
  });

  test("transaction refuses a copy source that changed after planning", () => {
    const parent = temp("aidlc-t240-source-parent-");
    const root = join(parent, "missing-root");
    const sourceRoot = temp("aidlc-t240-source-input-");
    const source = join(sourceRoot, "input.txt");
    writeFileSync(source, "planned");
    const sourceHash = transactionSourceHash(source);
    writeFileSync(source, "changed");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [{
        kind: "copy",
        path: "output.txt",
        source,
        sourceHash,
        expected: "absent",
      }],
    })).toThrow("transaction source changed after planning");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(root, "output.txt"))).toBe(false);
  });

  test("transaction validates staged candidates before live mutation", () => {
    const root = temp("aidlc-t240-candidate-validation-");
    writeFileSync(join(root, "value.txt"), "old");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("value.txt", "new", transactionState(join(root, "value.txt"))),
      ],
    }, {
      validateCandidates(candidateRoot) {
        expect(readFileSync(join(candidateRoot, "value.txt"), "utf-8")).toBe("new");
        expect(readFileSync(join(root, "value.txt"), "utf-8")).toBe("old");
        throw new Error("candidate rejected");
      },
    })).toThrow("candidate rejected");
    expect(readFileSync(join(root, "value.txt"), "utf-8")).toBe("old");
  });

  test("named transaction boundaries restore the prior state", () => {
    const boundaries = [
      "after-lock",
      "before-plan-validation",
      "after-plan-validation",
      "before-stage:1:write",
      "after-stage:1:write",
      "before-candidate-validation",
      "after-candidate-validation",
      "before-snapshot:1:write",
      "after-snapshot:1:write",
      "before-commit:1:write",
      "after-commit:1:write",
      "before-committed-validation",
      "after-committed-validation",
    ];
    for (const failAt of boundaries) {
      const root = temp("aidlc-t240-named-fault-");
      writeFileSync(join(root, "value.txt"), "old");
      expect(() => executePlan({
        schemaVersion: 1,
        root,
        operations: [
          writeOperation("value.txt", "new", transactionState(join(root, "value.txt"))),
        ],
      }, { failAt })).toThrow(`injected transaction failure at ${failAt}`);
      expect(readFileSync(join(root, "value.txt"), "utf-8"), failAt).toBe("old");
    }
  });

  test("rollback restores file mode and symlink target and rejects a dangling symlink parent", () => {
    const root = temp("aidlc-t240-txn-metadata-");
    const first = join(root, "first");
    const second = join(root, "second");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    writeFileSync(join(root, "mode.txt"), "old", { mode: 0o600 });
    symlinkSync(first, join(root, "pointer"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("mode.txt", "new", transactionState(join(root, "mode.txt")), 0o755),
        {
          kind: "symlink",
          path: "pointer",
          target: second,
          expected: transactionState(join(root, "pointer")),
        },
      ],
    }, { failAfter: 2 })).toThrow("injected transaction failure");
    expect(readFileSync(join(root, "mode.txt"), "utf-8")).toBe("old");
    if (process.platform === "win32") {
      expect(statSync(join(root, "mode.txt")).isFile()).toBe(true);
    } else {
      expect(statSync(join(root, "mode.txt")).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(root, "pointer"), "utf-8")).toBe("first");

    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("dangling/file.txt", "blocked")],
    })).toThrow("traverses a symlink");
  });

  test("archive supports ustar prefixes and rejects file-descendant collisions", () => {
    const path = `${"segment/".repeat(18)}payload.txt`;
    const archive = join(temp("aidlc-t240-ustar-"), "long.tgz");
    writeFileSync(archive, createTarGz([
      { path, type: "file", mode: 0o644, data: Buffer.from("long") },
    ]));
    expect(readTarGz(archive)[0].path).toBe(path);
    expect(() => createTarGz([
      { path: "root", type: "file", mode: 0o644, data: Buffer.from("file") },
      { path: "root/child", type: "file", mode: 0o644, data: Buffer.from("child") },
    ])).toThrow("is an ancestor");
  });

  test("archive expansion is bounded before tar parsing", () => {
    const archive = join(temp("aidlc-t240-expansion-"), "expanded.tgz");
    writeFileSync(archive, createTarGz([
      {
        path: "large.txt",
        type: "file",
        mode: 0o644,
        data: Buffer.alloc(16 * 1024),
      },
    ]));
    expect(statSync(archive).size).toBeLessThan(1024);
    expect(() => readTarGz(archive, { maxBytes: 1024 }))
      .toThrow("expanded archive exceeds the extraction byte limit");
  });

  test("transaction quarantines dead-process staging instead of deleting recovery evidence", () => {
    const root = temp("aidlc-t240-recovery-");
    const stagingName = ".aidlc-txn-00000000-0000-4000-8000-000000000000";
    const staging = join(root, stagingName);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "orphan.txt"), "unused");
    writeFileSync(join(root, "a.txt"), "still-live");
    writeFileSync(
      join(root, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, staging: stagingName })}\n`,
    );

    executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("b.txt", "next", "absent")],
    });

    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("still-live");
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("next");
    expect(existsSync(staging)).toBe(false);
    const recovery = readdirSync(root).find((entry) => entry.startsWith(".aidlc-recovery-"));
    expect(recovery).toBeDefined();
    expect(readFileSync(join(root, recovery as string, "orphan.txt"), "utf-8")).toBe("unused");
  });

  test("rollback continues after a restore failure and preserves remaining evidence", () => {
    const root = temp("aidlc-t240-rollback-recovery-");
    writeFileSync(join(root, "a.txt"), "old-a");
    writeFileSync(join(root, "b.txt"), "old-b");
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [
        writeOperation("a.txt", "new-a", transactionState(join(root, "a.txt"))),
        writeOperation("b.txt", "new-b", transactionState(join(root, "b.txt"))),
      ],
    }, {
      failAfter: 2,
      failAt: "during-rollback:b.txt",
    })).toThrow("transaction rollback incomplete");

    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("old-a");
    expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("new-b");
    const staging = readdirSync(root).find((entry) => entry.startsWith(".aidlc-txn-"));
    expect(staging).toBeDefined();
    expect(readFileSync(join(root, staging as string, "backups", "b.txt"), "utf-8"))
      .toBe("old-b");
  });

  test("transaction never reclaims a live lock with complete metadata", () => {
    const root = temp("aidlc-t240-live-lock-");
    writeFileSync(
      join(root, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`,
    );
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("blocked.txt", "no", "absent")],
    })).toThrow("another AI-DLC mutation holds");
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
    expect(existsSync(join(root, ".aidlc-transaction.lock"))).toBe(true);
  });

  test("pending Windows uninstall fence blocks machine mutation under the shared lock", () => {
    const machine = temp("aidlc-t239-uninstall-fence-");
    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      const root = machineTransactionRoot();
      const fence = windowsUninstallFencePath();
      writeFileSync(fence, "{}\n");
      expect(() => executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("blocked.txt", "no\n", "absent")],
      })).toThrow("pending Windows uninstall blocks machine mutation");
      expect(existsSync(join(root, "blocked.txt"))).toBe(false);

      executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("allowed.txt", "yes\n", "absent")],
      }, { allowPendingWindowsUninstall: true });
      expect(readFileSync(join(root, "allowed.txt"), "utf-8")).toBe("yes\n");
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  });

  test("transaction release never unlinks a replacement lock it does not own", () => {
    const root = temp("aidlc-t240-lock-identity-");
    const lockPath = join(root, ".aidlc-transaction.lock");
    const replacement = `${JSON.stringify({ pid: process.pid, staging: "replacement" })}\n`;
    expect(() => executePlan({
      schemaVersion: 1,
      root,
      operations: [writeOperation("blocked.txt", "no", "absent")],
    }, {
      validateCandidates() {
        rmSync(lockPath);
        writeFileSync(lockPath, replacement);
        throw new Error("replacement installed");
      },
    })).toThrow("replacement installed");
    expect(readFileSync(lockPath, "utf-8")).toBe(replacement);
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);
    rmSync(lockPath);
  });

  test("route mutation policy blocks a plan before it creates destination bytes", () => {
    const root = temp("aidlc-t240-policy-mutation-");
    const priorScope = process.env.AIDLC_ROUTE_MUTATION_SCOPE;
    const priorId = process.env.AIDLC_ROUTE_ID;
    try {
      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "none";
      process.env.AIDLC_ROUTE_ID = "read-only-test-route";
      expect(() => executePlan({
        schemaVersion: 1,
        root,
        operations: [writeOperation("forbidden.txt", "no\n", "absent")],
      })).toThrow("does not permit filesystem mutation");
      expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
      expect(existsSync(join(root, ".aidlc-transaction.lock"))).toBe(false);
    } finally {
      if (priorScope === undefined) delete process.env.AIDLC_ROUTE_MUTATION_SCOPE;
      else process.env.AIDLC_ROUTE_MUTATION_SCOPE = priorScope;
      if (priorId === undefined) delete process.env.AIDLC_ROUTE_ID;
      else process.env.AIDLC_ROUTE_ID = priorId;
    }
  });

  test("route mutation policy enforces canonical project and machine roots", () => {
    const machine = temp("aidlc-t243-policy-machine-");
    const project = temp("aidlc-t243-policy-project-");
    const saved = {
      scope: process.env.AIDLC_ROUTE_MUTATION_SCOPE,
      route: process.env.AIDLC_ROUTE_ID,
      project: process.env.AIDLC_ROUTE_PROJECT_DIR,
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      home: process.env.HOME,
    };
    process.env.AIDLC_ROUTE_ID = "root-policy-test";
    process.env.AIDLC_ROUTE_PROJECT_DIR = project;
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      const machineRoot = machineTransactionRoot();
      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "project";
      expect(() => executePlan({
        schemaVersion: 1,
        root: machineRoot,
        operations: [writeOperation("machine-blocked.txt", "no\n", "absent")],
      })).toThrow("project mutation scope cannot mutate machine path");
      expect(existsSync(join(machineRoot, "machine-blocked.txt"))).toBe(false);

      process.env.AIDLC_ROUTE_PROJECT_DIR = machine;
      expect(() => executePlan({
        schemaVersion: 1,
        root: machineRoot,
        operations: [writeOperation("overlap-blocked.txt", "no\n", "absent")],
      })).toThrow("project mutation scope cannot mutate machine path");
      expect(existsSync(join(machineRoot, "overlap-blocked.txt"))).toBe(false);

      if (process.platform !== "win32") {
        const alias = join(dirname(machine), `${basename(machine)}-alias`);
        symlinkSync(machine, alias, "dir");
        process.env.AIDLC_ROUTE_PROJECT_DIR = alias;
        expect(() => executePlan({
          schemaVersion: 1,
          root: alias,
          operations: [writeOperation("alias-blocked.txt", "no\n", "absent")],
        })).toThrow("project mutation scope cannot mutate machine path");
        expect(existsSync(join(machine, "alias-blocked.txt"))).toBe(false);
      }

      process.env.HOME = dirname(machine);
      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "user-home";
      expect(() => executePlan({
        schemaVersion: 1,
        root: machineRoot,
        operations: [writeOperation("home-overlap-blocked.txt", "no\n", "absent")],
      })).toThrow("user-home mutation scope cannot mutate machine path");
      expect(existsSync(join(machineRoot, "home-overlap-blocked.txt"))).toBe(false);

      process.env.AIDLC_ROUTE_PROJECT_DIR = project;
      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "machine";
      expect(() => executePlan({
        schemaVersion: 1,
        root: project,
        operations: [writeOperation("project-blocked.txt", "no\n", "absent")],
      })).toThrow("machine mutation scope cannot mutate project path");
      expect(existsSync(join(project, "project-blocked.txt"))).toBe(false);

      process.env.AIDLC_ROUTE_MUTATION_SCOPE = "project-and-machine";
      executePlan({
        schemaVersion: 1,
        root: project,
        operations: [writeOperation("project-allowed.txt", "yes\n", "absent")],
      });
      executePlan({
        schemaVersion: 1,
        root: machineRoot,
        operations: [writeOperation("machine-allowed.txt", "yes\n", "absent")],
      });
      expect(readFileSync(join(project, "project-allowed.txt"), "utf-8")).toBe("yes\n");
      expect(readFileSync(join(machineRoot, "machine-allowed.txt"), "utf-8")).toBe("yes\n");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        const key = {
          scope: "AIDLC_ROUTE_MUTATION_SCOPE",
          route: "AIDLC_ROUTE_ID",
          project: "AIDLC_ROUTE_PROJECT_DIR",
          install: "AIDLC_INSTALL_ROOT",
          bin: "AIDLC_BIN_DIR",
          home: "HOME",
        }[name] as string;
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("target selection distinguishes glibc and musl Linux releases", () => {
    if (process.platform !== "linux") return;
    const prior = process.env.AIDLC_LIBC;
    try {
      process.env.AIDLC_LIBC = "musl";
      expect(targetTriple()).toEndWith("-musl");
      process.env.AIDLC_LIBC = "glibc";
      expect(targetTriple()).not.toEndWith("-musl");
    } finally {
      if (prior === undefined) delete process.env.AIDLC_LIBC;
      else process.env.AIDLC_LIBC = prior;
    }
  });

  test("package-manager executable detection yields to Homebrew and Nix", () => {
    if (process.platform === "win32") {
      expect(packageManagerForExecutable("C:\\aidlc\\versions\\2.5.0\\aidlc.exe")).toBeNull();
    } else {
      expect(packageManagerForExecutable("/opt/homebrew/Cellar/aidlc/2.5.0/libexec/aidlc"))
        .toEqual({ name: "Homebrew", remediation: "brew upgrade aidlc" });
      expect(packageManagerForExecutable("/nix/store/hash-aidlc-2.5.0/bin/aidlc"))
        .toEqual({ name: "Nix", remediation: "upgrade aidlc through Nix" });
      expect(packageManagerForExecutable("/home/user/.local/share/aidlc/versions/2.5.0/aidlc"))
        .toBeNull();
    }
  });

  test("source-mode Bun is not classified as a package-managed AI-DLC executable", () => {
    expect(
      compiledExecutable(
        "file:///repo/core/tools/aidlc-lifecycle.ts",
        "/opt/homebrew/Cellar/bun/1.3.14/bin/bun",
      ),
    ).toBeNull();
    expect(
      compiledExecutable(
        "file:///$bunfs/root/aidlc-lifecycle.ts",
        "/opt/homebrew/Cellar/aidlc/2.7.0/libexec/aidlc",
      ),
    ).toBe("/opt/homebrew/Cellar/aidlc/2.7.0/libexec/aidlc");
  });

  test("shared release fixture is byte-deterministic and emits hostile archives", () => {
    const first = temp("aidlc-t240-fixture-first-");
    const second = temp("aidlc-t240-fixture-second-");
    const hostile = temp("aidlc-t240-fixture-hostile-");
    const left = writeReleaseFixture({
      root: first,
      repoRoot: REPO_ROOT,
      distributions: ["claude"],
      hostileRoot: hostile,
    });
    writeReleaseFixture({
      root: second,
      repoRoot: REPO_ROOT,
      distributions: ["claude"],
    });
    expect(walkFiles(first)).toEqual(walkFiles(second));
    for (const path of walkFiles(first)) {
      expect(digest(join(first, path)), path).toBe(digest(join(second, path)));
    }
    expect(left.hostileArchives).toHaveLength(2);
    for (const path of left.hostileArchives) {
      expect(() => readTarGz(path)).toThrow();
    }
  }, process.platform === "win32" ? 30_000 : 5_000);
});

describe("t243 project initialization", () => {
  test("active-version runtime wins over an executable-adjacent path alias", () => {
    const machine = temp("aidlc-t243-runtime-real-");
    const aliasParent = temp("aidlc-t243-runtime-alias-");
    const alias = join(aliasParent, "machine");
    symlinkSync(machine, alias, process.platform === "win32" ? "junction" : "dir");
    const runtime = join(machine, "versions", AIDLC_VERSION, "runtime");
    mkdirSync(join(runtime, "claude"), { recursive: true });
    writeFileSync(join(machine, "active-version"), `${AIDLC_VERSION}\n`);
    // The executable lives in a different tree that also carries a runtime;
    // the install root's active-version runtime must win and the adjacent one
    // must not be offered at all.
    const adjacent = temp("aidlc-t243-runtime-adjacent-");
    mkdirSync(join(adjacent, "runtime", "claude"), { recursive: true });
    const executable = join(
      adjacent,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    writeFileSync(executable, "fixture\n");

    const savedInstallRoot = process.env.AIDLC_INSTALL_ROOT;
    const savedRuntimeRoot = process.env.AIDLC_RUNTIME_ROOT;
    process.env.AIDLC_INSTALL_ROOT = alias;
    delete process.env.AIDLC_RUNTIME_ROOT;
    try {
      // Install roots are canonical, so the aliased spelling resolves to the
      // real machine directory.
      expect(_installedSourcesForTests(undefined, executable)).toEqual([
        join(realpathSync(machine), "versions", AIDLC_VERSION, "runtime", "claude"),
      ]);
    } finally {
      if (savedInstallRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = savedInstallRoot;
      if (savedRuntimeRoot === undefined) delete process.env.AIDLC_RUNTIME_ROOT;
      else process.env.AIDLC_RUNTIME_ROOT = savedRuntimeRoot;
    }
  });

  test("OpenCode metadata selects refresh source and refuses a different harness", () => {
    const project = temp("aidlc-t240-opencode-init-");
    mkdirSync(join(project, ".git"));
    const initialized = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      OPENCODE_RELEASE,
      "--harness",
      "opencode",
      "--mcp",
      "none",
    ], project);
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);

    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      OPENCODE_RELEASE,
    ], project);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);

    const wrongHarness = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(wrongHarness.status).toBe(4);
    expect(wrongHarness.stdout).toContain("project uses opencode; refusing claude");
    expect(existsSync(join(project, ".claude"))).toBe(false);
  }, 60_000);

  test("an explicit installed harness never silently yields to the existing project harness", () => {
    const project = temp("aidlc-t240-explicit-harness-");
    mkdirSync(join(project, ".git"));
    const initialized = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);

    const runtimes = temp("aidlc-t240-installed-runtimes-");
    cpSync(CLAUDE_RELEASE, join(runtimes, "claude"), { recursive: true });
    cpSync(OPENCODE_RELEASE, join(runtimes, "opencode"), { recursive: true });
    const wrongHarness = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--harness",
      "opencode",
    ], project, { AIDLC_RUNTIME_ROOT: runtimes });
    expect(wrongHarness.status).toBe(4);
    expect(wrongHarness.stdout).toContain("project uses claude; refusing opencode");
    expect(existsSync(join(project, ".aidlc"))).toBe(false);
  }, 60_000);

  test("--force cannot overwrite an unowned whole-file root integration", () => {
    const project = temp("aidlc-t240-whole-file-");
    mkdirSync(join(project, ".git"));
    const config = join(project, "opencode.json");
    writeFileSync(config, '{"userOwned":true}\n');
    const initialized = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      OPENCODE_RELEASE,
      "--harness",
      "opencode",
      "--force",
    ], project);
    expect(initialized.status).toBe(4);
    expect(initialized.stdout).toContain("unowned whole file");
    expect(readFileSync(config, "utf-8")).toBe('{"userOwned":true}\n');
    expect(existsSync(join(project, ".aidlc"))).toBe(false);
  });

  test("dry-run against a missing explicit target creates no directory", () => {
    const parent = temp("aidlc-t240-dry-parent-");
    const project = join(parent, "not-created");
    const dry = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--dry-run",
      "--json",
    ], parent);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(existsSync(project)).toBe(false);
  });

  test("Kiro project context resolves without a command-line target", () => {
    const project = temp("aidlc-t240-kiro-project-");
    const prior = process.env.KIRO_PROJECT_DIR;
    try {
      process.env.KIRO_PROJECT_DIR = project;
      expect(projectDirFrom([])).toBe(project);
    } finally {
      if (prior === undefined) delete process.env.KIRO_PROJECT_DIR;
      else process.env.KIRO_PROJECT_DIR = prior;
    }
  });

  test("fresh init, dry-run, refresh preservation, conflict, and force use one projection", () => {
    const project = temp("aidlc-t240-project-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".gitignore"), "node_modules/\n");
    const dry = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--dry-run",
      "--json",
    ], project);
    expect(dry.status).toBe(0);
    expect(existsSync(join(project, ".claude"))).toBe(false);
    const dryPlan = JSON.parse(dry.stdout) as { data: { actions: unknown[]; planToken: string } };

    const apply = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "none",
      "--plan-token",
      dryPlan.data.planToken,
      "--json",
    ], project);
    expect(apply.status, apply.stdout + apply.stderr).toBe(0);
    const applyPlan = JSON.parse(apply.stdout) as {
      message: string;
      data: { actions: unknown[]; planToken: string };
    };
    expect(applyPlan.data.actions).toEqual(dryPlan.data.actions);
    expect(applyPlan.data.planToken).toBe(dryPlan.data.planToken);
    expect(applyPlan.message).toContain("open Claude Code in this project");
    expect(existsSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"))).toBe(true);
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("node_modules/");
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("BEGIN AI-DLC:gitignore");
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);

    const memory = join(project, "aidlc", "spaces", "default", "memory", "team.md");
    writeFileSync(memory, "# local method\n");
    const framework = join(project, ".claude", "tools", "aidlc-command.ts");
    const harnessData = join(project, ".claude", "tools", "data", "harness.json");
    const graphData = join(project, ".claude", "tools", "data", "stage-graph.json");
    const scopeData = join(project, ".claude", "tools", "data", "scope-grid.json");
    const selected = JSON.parse(readFileSync(harnessData, "utf-8")) as Record<string, unknown>;
    selected.plugins = ["aidlc", "test-pro"];
    writeFileSync(harnessData, `${JSON.stringify(selected, null, 2)}\n`);
    writeFileSync(graphData, `${readFileSync(graphData, "utf-8").trimEnd()}\n `);
    const scopeGrid = JSON.parse(readFileSync(scopeData, "utf-8")) as Record<string, unknown>;
    scopeGrid["custom-composed"] = scopeGrid.bugfix;
    writeFileSync(scopeData, `${JSON.stringify(scopeGrid, null, 2)}\n`);
    // A composed scope survives recompiles only when its registry file exists
    // alongside the appended grid entry (the composer writes both on approval).
    writeFileSync(
      join(project, ".claude", "scopes", "aidlc-custom-composed.md"),
      [
        "---",
        "name: custom-composed",
        "depth: Minimal",
        "description: composed fixture scope",
        "---",
        "",
        "# custom-composed scope",
        "",
      ].join("\n"),
    );
    writeFileSync(framework, `${readFileSync(framework, "utf-8")}\n// local edit\n`);
    const conflict = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(conflict.status).toBe(4);
    expect(conflict.stdout).toContain("locally modified");

    const forced = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--force",
    ], project);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(readFileSync(memory, "utf-8")).toBe("# local method\n");
    expect(readFileSync(framework, "utf-8")).not.toContain("// local edit");
    expect(JSON.parse(readFileSync(harnessData, "utf-8")).plugins).toEqual(["aidlc", "test-pro"]);
    expect(() => JSON.parse(readFileSync(graphData, "utf-8"))).not.toThrow();
    expect(readFileSync(graphData, "utf-8")).not.toEndWith("\n ");
    expect(JSON.parse(readFileSync(scopeData, "utf-8"))["custom-composed"]).toEqual(scopeGrid.bugfix);
    const baseline = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"), "utf-8"),
    ) as { files: Record<string, string> };
    expect(baseline.files[".claude/tools/data/harness.json"]).toBeUndefined();
    expect(baseline.files[".claude/tools/data/stage-graph.json"]).toBeUndefined();
    expect(baseline.files[".claude/tools/data/scope-grid.json"]).toBeUndefined();

    const gitignore = join(project, ".gitignore");
    writeFileSync(
      gitignore,
      readFileSync(gitignore, "utf-8").replace(
        "# END AI-DLC:gitignore",
        "# local managed edit\n# END AI-DLC:gitignore",
      ),
    );
    const blockConflict = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(blockConflict.status).toBe(4);
    expect(blockConflict.stdout).toContain("managed block was locally modified");

    const blockForced = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--force",
    ], project);
    expect(blockForced.status, blockForced.stdout + blockForced.stderr).toBe(0);
    expect(readFileSync(gitignore, "utf-8")).toContain("node_modules/");
    expect(readFileSync(gitignore, "utf-8")).not.toContain("# local managed edit");
  }, 60_000);

  test("refresh updates hand-authored orchestrator prose and protects local edits", () => {
    const project = temp("aidlc-t243-skill-refresh-");
    mkdirSync(join(project, ".git"));
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const rel = join(".claude", "skills", "aidlc", "SKILL.md");
    const skill = join(project, rel);
    const upstream = temp("aidlc-t243-skill-upstream-");
    cpSync(CLAUDE_RELEASE, upstream, { recursive: true });
    writeFileSync(join(upstream, rel), `${readFileSync(join(upstream, rel), "utf-8")}\nUpstream prose v1.\n`);

    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      upstream,
    ], project);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(readFileSync(skill, "utf-8")).toContain("Upstream prose v1.");

    writeFileSync(skill, `${readFileSync(skill, "utf-8")}\nLocal orchestrator edit.\n`);
    const newer = temp("aidlc-t243-skill-newer-");
    cpSync(upstream, newer, { recursive: true });
    writeFileSync(
      join(newer, rel),
      readFileSync(join(newer, rel), "utf-8").replace("Upstream prose v1.", "Upstream prose v2."),
    );
    const conflict = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
    ], project);
    expect(conflict.status).toBe(4);
    expect(conflict.stdout + conflict.stderr).toContain("locally modified");
    expect(readFileSync(skill, "utf-8")).toContain("Local orchestrator edit.");

    const forced = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
      "--force",
    ], project);
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(readFileSync(skill, "utf-8")).toContain("Upstream prose v2.");
    expect(readFileSync(skill, "utf-8")).not.toContain("Local orchestrator edit.");
  }, 60_000);

  test("refresh updates shipped skills while preserving project-only skill overlays", () => {
    const project = temp("aidlc-t243-skill-overlay-");
    mkdirSync(join(project, ".git"));
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const projectOnly = join(
      project,
      ".claude",
      "skills",
      "test-pro-project-only",
      "SKILL.md",
    );
    mkdirSync(dirname(projectOnly), { recursive: true });
    writeFileSync(
      projectOnly,
      "---\nname: test-pro-project-only\nuser-invocable: true\n---\n\nProject-only skill.\n",
    );

    const upstream = temp("aidlc-t243-skill-overlay-upstream-");
    cpSync(CLAUDE_RELEASE, upstream, { recursive: true });
    const orchestratorRel = join(".claude", "skills", "aidlc", "SKILL.md");
    writeFileSync(
      join(upstream, orchestratorRel),
      `${readFileSync(join(upstream, orchestratorRel), "utf-8")}\nUpstream overlay probe.\n`,
    );

    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      upstream,
    ], project);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(readFileSync(join(project, orchestratorRel), "utf-8")).toContain(
      "Upstream overlay probe.",
    );
    expect(readFileSync(projectOnly, "utf-8")).toContain("Project-only skill.");
  }, 60_000);

  test("pre-manifest adoption preserves all mutable harness policy keys", () => {
    const project = temp("aidlc-t243-policy-adoption-");
    cpSync(CLAUDE_COPY, project, { recursive: true });
    mkdirSync(join(project, ".git"));
    const harnessData = join(project, ".claude", "tools", "data", "harness.json");
    const current = JSON.parse(readFileSync(harnessData, "utf-8")) as Record<string, unknown>;
    current.plugins = ["aidlc"];
    current.setup = {
      models: { reviewingEffort: "medium" },
      provider: { name: "bedrock", region: "eu-west-1" },
    };
    current.futurePolicy = { enabled: true };
    writeFileSync(harnessData, `${JSON.stringify(current, null, 2)}\n`);

    const adopted = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--json",
    ], project);
    expect(adopted.status, adopted.stdout + adopted.stderr).toBe(0);
    const after = JSON.parse(readFileSync(harnessData, "utf-8")) as Record<string, unknown>;
    expect(after.plugins).toEqual(["aidlc"]);
    expect(after.setup).toEqual(current.setup);
    expect(after.futurePolicy).toEqual(current.futurePolicy);
    expect(after.distribution).toBe("claude");
    expect(existsSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"))).toBe(true);
    const result = JSON.parse(adopted.stdout) as {
      data: { actions: Array<{ path: string; detail?: string }> };
    };
    expect(result.data.actions).toContainEqual(expect.objectContaining({
      path: ".claude/skills/aidlc/SKILL.md",
      detail: "adopted exact copy-channel signature",
    }));
  }, 60_000);

  test("refresh refuses an active workflow without changing project bytes", () => {
    const project = temp("aidlc-t243-active-refresh-");
    mkdirSync(join(project, ".git"));
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const dirName = "active-refresh-probe";
    const intentsDir = join(project, "aidlc", "spaces", "default", "intents");
    const intentDir = join(intentsDir, dirName);
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(
      join(intentsDir, "intents.json"),
      `${JSON.stringify([{
        uuid: "deadbeef-0000-4000-8000-000000000001",
        slug: "active-refresh",
        dirName,
        scope: "feature",
        status: "in-flight",
      }], null, 2)}\n`,
    );
    const state = join(intentDir, "aidlc-state.md");
    writeFileSync(state, "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n");

    const newer = temp("aidlc-t243-active-upstream-");
    cpSync(CLAUDE_RELEASE, newer, { recursive: true });
    const rel = join(".claude", "tools", "aidlc-command.ts");
    writeFileSync(join(newer, rel), `${readFileSync(join(newer, rel), "utf-8")}\n// active refresh marker\n`);
    const target = join(project, rel);
    const before = readFileSync(target);
    const rootEntries = readdirSync(project).sort();

    const refused = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
      "--json",
    ], project);
    expect(refused.status).toBe(4);
    expect(refused.stdout + refused.stderr).toContain("refusing to refresh while 1 workflow(s) are active");
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(project).sort()).toEqual(rootEntries);

    writeFileSync(state, readFileSync(state, "utf-8").replace("Status**: Running", "Status**: Completed"));
    const completed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
    ], project);
    expect(completed.status, completed.stdout + completed.stderr).toBe(0);
    expect(readFileSync(target, "utf-8")).toContain("// active refresh marker");
  }, 60_000);

  test("exact legacy root signatures are adopted while modified lookalikes still refuse", () => {
    const project = temp("aidlc-t240-legacy-adopt-");
    mkdirSync(join(project, ".git"));
    cpSync(join(CLAUDE_COPY, ".gitignore"), join(project, ".gitignore"));
    cpSync(join(CLAUDE_COPY, ".mcp.json"), join(project, ".mcp.json"));

    const adopted = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "defaults",
      "--json",
    ], project);
    expect(adopted.status, adopted.stdout + adopted.stderr).toBe(0);
    const result = JSON.parse(adopted.stdout) as {
      data: { actions: Array<{ path: string; detail?: string }> };
    };
    expect(result.data.actions).toContainEqual(expect.objectContaining({
      path: ".gitignore",
      detail: "adopted exact legacy signature",
    }));
    const gitignore = readFileSync(join(project, ".gitignore"), "utf-8");
    expect(gitignore.match(/BEGIN AI-DLC:gitignore/g)).toHaveLength(1);
    expect(gitignore.match(/END AI-DLC:gitignore/g)).toHaveLength(1);

    const baseline = JSON.parse(
      readFileSync(join(project, ".claude", "tools", "data", "aidlc-manifest.json"), "utf-8"),
    ) as {
      rootContributions: {
        ".mcp.json": { policy: string; entries: Record<string, string> };
      };
    };
    expect(baseline.rootContributions[".mcp.json"].policy).toBe("json-map");
    expect(Object.keys(baseline.rootContributions[".mcp.json"].entries).sort()).toEqual([
      "aws-iac",
      "aws-mcp",
      "aws-pricing",
      "aws-serverless",
      "context7",
    ]);

    const disabled = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--mcp",
      "none",
    ], project);
    expect(disabled.status, disabled.stdout + disabled.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8")).mcpServers)
      .toBeUndefined();

    const ambiguous = temp("aidlc-t240-legacy-ambiguous-");
    mkdirSync(join(ambiguous, ".git"));
    writeFileSync(
      join(ambiguous, ".gitignore"),
      `${readFileSync(join(CLAUDE_COPY, ".gitignore"), "utf-8")}# local AI-DLC rule\n`,
    );
    const refused = run(INIT, [
      "config",
      "--project-dir",
      ambiguous,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--force",
    ], ambiguous);
    expect(refused.status).toBe(4);
    expect(refused.stdout).toContain("legacy root integration ambiguous");
    expect(existsSync(join(ambiguous, ".claude"))).toBe(false);
  }, 60_000);

  test("--force does not replace a pre-existing user-owned JSON entry", () => {
    const project = temp("aidlc-t240-json-owner-");
    mkdirSync(join(project, ".git"));
    const custom = { type: "http", url: "https://example.invalid/custom" };
    writeFileSync(
      join(project, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { context7: custom }, projectSetting: true }, null, 2)}\n`,
    );

    const result = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "defaults",
      "--force",
    ], project);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const merged = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
      projectSetting: boolean;
    };
    expect(merged.mcpServers.context7).toEqual(custom);
    expect(merged.projectSetting).toBe(true);
  });

  test("MCP consent and managed AGENTS blocks preserve user-owned configuration", () => {
    const claudeProject = temp("aidlc-t240-mcp-matrix-");
    mkdirSync(join(claudeProject, ".git"));
    const noConsent = run(INIT, [
      "config",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--yes",
    ], claudeProject);
    expect(noConsent.status, noConsent.stdout + noConsent.stderr).toBe(0);
    expect(existsSync(join(claudeProject, ".mcp.json"))).toBe(false);

    const defaults = run(INIT, [
      "config",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--mcp",
      "defaults",
    ], claudeProject);
    expect(defaults.status, defaults.stdout + defaults.stderr).toBe(0);
    const mcpPath = join(claudeProject, ".mcp.json");
    const configured = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    const shipped = JSON.parse(readFileSync(join(CLAUDE_RELEASE, ".mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(configured.mcpServers).sort()).toEqual(Object.keys(shipped.mcpServers).sort());
    configured.mcpServers["project-owned"] = { command: "project-tool" };
    (configured as Record<string, unknown>).projectSetting = true;
    writeFileSync(mcpPath, `${JSON.stringify(configured, null, 2)}\n`);
    const disabled = run(INIT, [
      "config",
      "--project-dir",
      claudeProject,
      "--from",
      CLAUDE_RELEASE,
      "--mcp",
      "none",
    ], claudeProject);
    expect(disabled.status, disabled.stdout + disabled.stderr).toBe(0);
    const retained = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
      projectSetting: boolean;
    };
    expect(retained.mcpServers).toEqual({ "project-owned": { command: "project-tool" } });
    expect(retained.projectSetting).toBe(true);

    const kiroProject = temp("aidlc-t240-agents-matrix-");
    mkdirSync(join(kiroProject, ".git"));
    writeFileSync(join(kiroProject, "AGENTS.md"), "# Project instructions\n\nKeep this text.\n");
    const kiroInit = run(INIT, [
      "config",
      "--project-dir",
      kiroProject,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], kiroProject);
    expect(kiroInit.status, kiroInit.stdout + kiroInit.stderr).toBe(0);
    const agentsPath = join(kiroProject, "AGENTS.md");
    expect(readFileSync(agentsPath, "utf-8")).toContain("Keep this text.");
    expect(readFileSync(agentsPath, "utf-8")).toContain("<!-- BEGIN AI-DLC:agents -->");
    writeFileSync(agentsPath, readFileSync(agentsPath, "utf-8").replace(
      "Keep this text.",
      "Keep this updated text.",
    ));
    const kiroRefresh = run(INIT, [
      "config",
      "--project-dir",
      kiroProject,
      "--from",
      KIRO_RELEASES[0],
    ], kiroProject);
    expect(kiroRefresh.status, kiroRefresh.stdout + kiroRefresh.stderr).toBe(0);
    expect(readFileSync(agentsPath, "utf-8")).toContain("Keep this updated text.");

    const malformedProject = temp("aidlc-t240-root-conflicts-");
    mkdirSync(join(malformedProject, ".git"));
    writeFileSync(join(malformedProject, "AGENTS.md"), "<!-- BEGIN AI-DLC:agents -->\nmissing end\n");
    const malformedAgents = run(INIT, [
      "config",
      "--project-dir",
      malformedProject,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], malformedProject);
    expect(malformedAgents.status).toBe(4);
    expect(malformedAgents.stdout).toContain("managed markers are missing, duplicated, or malformed");

    const malformedMcp = temp("aidlc-t240-mcp-conflict-");
    mkdirSync(join(malformedMcp, ".git"));
    writeFileSync(join(malformedMcp, ".mcp.json"), "{");
    const malformedJson = run(INIT, [
      "config",
      "--project-dir",
      malformedMcp,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
      "--mcp",
      "defaults",
    ], malformedMcp);
    expect(malformedJson.status).toBe(4);
    expect(malformedJson.stdout).toContain("malformed JSON");
  }, 60_000);

  test("removed AGENTS markers with the managed body left behind refuse refresh", () => {
    const project = temp("aidlc-t243-agents-markers-removed-");
    mkdirSync(join(project, ".git"));
    expect(run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project).status).toBe(0);
    const path = join(project, "AGENTS.md");
    const withoutMarkers = readFileSync(path, "utf-8")
      .replace("<!-- BEGIN AI-DLC:agents -->\n", "")
      .replace("<!-- END AI-DLC:agents -->\n", "");
    writeFileSync(path, withoutMarkers);
    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
    ], project);
    expect(refreshed.status).toBe(4);
    expect(refreshed.stdout).toContain("legacy root integration ambiguous");
    expect(readFileSync(path, "utf-8")).toBe(withoutMarkers);
  }, 60_000);

  test("two managed AGENTS blocks from different versions are a conflict", () => {
    const project = temp("aidlc-t243-agents-two-blocks-");
    mkdirSync(join(project, ".git"));
    expect(run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project).status).toBe(0);
    const path = join(project, "AGENTS.md");
    const current = readFileSync(path, "utf-8");
    const block = current.match(
      /<!-- BEGIN AI-DLC:agents -->[\s\S]*?<!-- END AI-DLC:agents -->/,
    )?.[0];
    expect(block).toBeString();
    writeFileSync(
      path,
      `${current}\n${block?.replace(
        "<!-- END AI-DLC:agents -->",
        "Legacy version body.\n<!-- END AI-DLC:agents -->",
      )}\n`,
    );
    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
    ], project);
    expect(refreshed.status).toBe(4);
    expect(refreshed.stdout).toContain(
      "managed markers are missing, duplicated, or malformed",
    );
  }, 60_000);

  test("managed AGENTS block is stable above or below the user H1 and rules", () => {
    const below = temp("aidlc-t243-agents-below-h1-");
    mkdirSync(join(below, ".git"));
    writeFileSync(join(below, "AGENTS.md"), "# User H1\n\nKeep user rules.\n");
    expect(run(INIT, [
      "config",
      "--project-dir",
      below,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], below).status).toBe(0);
    const belowText = readFileSync(join(below, "AGENTS.md"), "utf-8");
    expect(belowText.indexOf("# User H1")).toBeLessThan(
      belowText.indexOf("<!-- BEGIN AI-DLC:agents -->"),
    );

    const above = temp("aidlc-t243-agents-above-h1-");
    mkdirSync(join(above, ".git"));
    writeFileSync(join(above, "AGENTS.md"), "# User H1\n\nKeep user rules.\n");
    expect(run(INIT, [
      "config",
      "--project-dir",
      above,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], above).status).toBe(0);
    const path = join(above, "AGENTS.md");
    const installed = readFileSync(path, "utf-8");
    const block = installed.match(
      /<!-- BEGIN AI-DLC:agents -->[\s\S]*?<!-- END AI-DLC:agents -->/,
    )?.[0] as string;
    const user = installed.replace(block, "").trim();
    writeFileSync(path, `${block}\n\n${user}\n`);
    expect(run(INIT, [
      "config",
      "--project-dir",
      above,
      "--from",
      KIRO_RELEASES[0],
    ], above).status).toBe(0);
    const refreshed = readFileSync(path, "utf-8");
    expect(refreshed.indexOf("<!-- BEGIN AI-DLC:agents -->")).toBeLessThan(
      refreshed.indexOf("# User H1"),
    );
    expect(refreshed).toContain("Keep user rules.");
  }, 60_000);

  test("a symlinked AGENTS.md is a root-integration conflict", () => {
    const project = temp("aidlc-t243-agents-symlink-");
    const outside = temp("aidlc-t243-agents-symlink-target-");
    mkdirSync(join(project, ".git"));
    const target = join(outside, "AGENTS.md");
    writeFileSync(target, "# External instructions\n");
    symlinkSync(target, join(project, "AGENTS.md"));
    const configured = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project);
    expect(configured.status).toBe(4);
    expect(configured.stdout).toContain("root integration is not a regular file");
    expect(readFileSync(target, "utf-8")).toBe("# External instructions\n");
    expect(existsSync(join(project, ".kiro"))).toBe(false);
  }, 60_000);

  test("a project carrying only CLAUDE.md keeps it and gains managed AGENTS.md", () => {
    const project = temp("aidlc-t243-claude-only-root-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "CLAUDE.md"), "# Claude-only project rules\n");
    const configured = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf-8"))
      .toBe("# Claude-only project rules\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf-8"))
      .toContain("<!-- BEGIN AI-DLC:agents -->");
  }, 60_000);

  test("config in a monorepo subdirectory mutates only the selected project", () => {
    const monorepo = temp("aidlc-t243-monorepo-");
    const project = join(monorepo, "packages", "service");
    mkdirSync(join(monorepo, ".git"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n");
    const configured = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project);
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    expect(existsSync(join(project, ".kiro"))).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(monorepo, ".kiro"))).toBe(false);
    expect(existsSync(join(monorepo, "AGENTS.md"))).toBe(false);
  }, 60_000);

  test("gitignored AGENTS.md generated by another tool preserves generator bytes", () => {
    const project = temp("aidlc-t243-generated-agents-");
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".gitignore"), "AGENTS.md\n");
    writeFileSync(
      join(project, "AGENTS.md"),
      "# Generated by project-tool\n\nDo not replace this section.\n",
    );
    expect(run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
      "--harness",
      "kiro",
    ], project).status).toBe(0);
    const path = join(project, "AGENTS.md");
    expect(readFileSync(path, "utf-8")).toContain("# Generated by project-tool");
    expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("AGENTS.md");

    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(
        "Do not replace this section.",
        "Regenerated project-tool section.",
      ),
    );
    expect(run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_RELEASES[0],
    ], project).status).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain(
      "Regenerated project-tool section.",
    );
  }, 60_000);

  test("all local init modes open no internet sockets", () => {
    const strace = Bun.which("strace");
    if (!strace || process.platform !== "linux") return;
    const project = temp("aidlc-t240-no-network-");
    mkdirSync(join(project, ".git"));
    const cases = [
      ["config", "--project-dir", project, "--from", CLAUDE_RELEASE, "--harness", "claude", "--dry-run"],
      ["config", "--project-dir", project, "--from", CLAUDE_RELEASE, "--harness", "claude"],
      ["config", "--project-dir", project, "--from", CLAUDE_RELEASE],
    ];
    for (const [index, args] of cases.entries()) {
      const trace = join(temp(`aidlc-t240-trace-${index}-`), "network.trace");
      const result = spawnSync(strace, [
        "-f",
        "-qq",
        "-e",
        "trace=network",
        "-o",
        trace,
        BUN,
        INIT,
        ...args,
      ], {
        cwd: project,
        env: process.env,
        encoding: "utf-8",
        timeout: 60_000,
      });
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
      const calls = readFileSync(trace, "utf-8");
      expect(calls).not.toMatch(/\b(?:socket|connect)\([^\n]*(?:AF_INET|AF_INET6)/);
    }
  }, 60_000);

  test("init treats dangling managed symlinks as conflicts and cleans failed refresh staging", () => {
    const project = temp("aidlc-t240-init-symlink-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".claude", "tools"), { recursive: true });
    symlinkSync(join(project, "missing-target"), join(project, ".claude", "tools", "aidlc-command.ts"));
    const dangling = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(dangling.status).toBe(4);
    expect(dangling.stdout).toContain("locally modified or unowned");

    rmSync(join(project, ".claude"), { recursive: true, force: true });
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const before = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith("aidlc-init-refresh-")),
    );
    writeFileSync(join(project, ".claude", "tools", "data", "harness.json"), "{");
    const failed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(failed.status).toBe(4);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("aidlc-init-refresh-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  }, 60_000);

  test("refresh reapplies recorded plugin contributions onto newer upstream stage bytes", () => {
    const project = temp("aidlc-t240-plugin-refresh-");
    mkdirSync(join(project, ".git"));
    const first = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(first.status, first.stdout + first.stderr).toBe(0);

    const rel = join(".claude", "aidlc-common", "stages", "construction", "nfr-requirements.md");
    const stagePath = join(project, rel);
    const current = readFileSync(stagePath, "utf-8");
    writeFileSync(stagePath, current.replace(
      /^(produces:\n(?: {2}- .+\n)*)/m,
      "$1  - test-pro-refresh-artifact\n",
    ));
    writeFileSync(
      join(project, ".claude", "tools", "data", "plugin-contrib-test-pro.json"),
      `${JSON.stringify({
        "nfr-requirements": { produces: ["test-pro-refresh-artifact"] },
      }, null, 2)}\n`,
    );

    const newer = temp("aidlc-t240-newer-projection-");
    cpSync(CLAUDE_RELEASE, newer, { recursive: true });
    const newerStage = join(newer, rel);
    writeFileSync(newerStage, `${readFileSync(newerStage, "utf-8")}\nUpstream refresh marker.\n`);
    const refreshed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
    ], project);
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    expect(readFileSync(stagePath, "utf-8")).toContain("test-pro-refresh-artifact");
    expect(readFileSync(stagePath, "utf-8")).toContain("Upstream refresh marker.");

    const refreshedAgain = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      newer,
    ], project);
    expect(refreshedAgain.status, refreshedAgain.stdout + refreshedAgain.stderr).toBe(0);
    expect(readFileSync(stagePath, "utf-8")).toContain("test-pro-refresh-artifact");
  }, 60_000);

  test("refresh planning never mutates generated runners on dry-run or conflict", () => {
    const project = temp("aidlc-t240-refresh-isolation-");
    mkdirSync(join(project, ".git"));
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--harness",
      "claude",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const runner = join(project, ".claude", "skills", "aidlc-build-and-test", "SKILL.md");
    writeFileSync(runner, `${readFileSync(runner, "utf-8")}\nlocal runner edit\n`);
    const before = readFileSync(runner);
    const dry = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
      "--dry-run",
    ], project);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(readFileSync(runner)).toEqual(before);

    const framework = join(project, ".claude", "tools", "aidlc-command.ts");
    writeFileSync(framework, `${readFileSync(framework, "utf-8")}\nlocal conflict\n`);
    const conflict = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      CLAUDE_RELEASE,
    ], project);
    expect(conflict.status).toBe(4);
    expect(readFileSync(runner)).toEqual(before);
  }, 60_000);

  test("Kiro IDE release trust is removed when returning to the Bun copy channel", () => {
    const project = temp("aidlc-t240-kiro-trust-");
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".vscode"));
    writeFileSync(
      join(project, ".vscode", "settings.json"),
      `${JSON.stringify({
        "kiroAgent.trustedCommands": ["user-tool *"],
        "editor.formatOnSave": true,
      }, null, 2)}\n`,
    );
    const installed = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_IDE_RELEASE,
      "--harness",
      "kiro-ide",
    ], project);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    let settings = JSON.parse(readFileSync(join(project, ".vscode", "settings.json"), "utf-8"));
    expect(settings["kiroAgent.trustedCommands"]).toEqual([
      "user-tool *",
      trustedCommand("*"),
    ]);
    expect(settings["editor.formatOnSave"]).toBe(true);

    const switched = run(INIT, [
      "config",
      "--project-dir",
      project,
      "--from",
      KIRO_IDE_COPY,
    ], project);
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    settings = JSON.parse(readFileSync(join(project, ".vscode", "settings.json"), "utf-8"));
    expect(settings["kiroAgent.trustedCommands"]).toEqual(["user-tool *"]);
    expect(settings["editor.formatOnSave"]).toBe(true);
  }, 60_000);
});

describe("t243 release lifecycle", () => {
  test("project pins require the retained OpenCode runtime selected by project metadata", () => {
    const release = fixtureReleaseBytes();
    const machine = temp("aidlc-t240-opencode-pin-machine-");
    const project = temp("aidlc-t240-opencode-pin-project-");
    cpSync(join(REPO_ROOT, "dist", "opencode"), project, { recursive: true });
    const env = {
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_INSTALL_ROOT: machine,
    };
    const installed = run(LIFECYCLE, [
      "versions",
      "install",
      AIDLC_VERSION,
      "--from",
      release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);

    const pin = run(INIT, [
      "config",
      "--pin",
      AIDLC_VERSION,
      "--project-dir",
      project,
    ], project, env);
    expect(pin.status).toBe(2);
    expect(pin.stdout).toContain(
      `${AIDLC_VERSION} does not contain this project's opencode runtime`,
    );
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
  }, process.platform === "win32" ? 30_000 : 5_000);

  test("installer renders order-independent usage failures as valid JSON", () => {
    const result = spawnSync("sh", [
      INSTALLER,
      "--harness",
      "claude",
      "--json",
    ], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout ?? "")).toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      code: 2,
      status: "usage",
      message: "unknown argument: --harness",
    }));
  });

  test("Unix installer rejects an authenticated version mismatch before acquiring or invoking assets", async () => {
    if (process.platform === "win32") return;
    const release = fixtureReleaseBytes();
    const binaryName = releaseBinaryName();
    const binaryPath = join(release, binaryName);
    const sentinel = join(temp("aidlc-t243-installer-version-sentinel-"), "invoked");
    const binary = [
      "#!/bin/sh",
      'printf "invoked\\n" >"$AIDLC_BINARY_SENTINEL"',
      "exit 99",
      "",
    ].join("\n");
    writeFileSync(binaryPath, binary, { mode: 0o755 });
    const manifestPath = join(release, "version.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      assets: Array<{ name: string; sha256: string; bytes: number }>;
    };
    const binaryAsset = manifest.assets.find((asset) => asset.name === binaryName);
    expect(binaryAsset).toBeDefined();
    if (!binaryAsset) return;
    binaryAsset.sha256 = digest(binaryPath);
    binaryAsset.bytes = statSync(binaryPath).size;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(release, "checksums.txt"),
      `${[
        `version.json`,
        ...manifest.assets.map((asset) => asset.name),
      ].map((name) => `${digest(join(release, name))}  ${name}`).join("\n")}\n`,
    );
    const machine = join(temp("aidlc-t243-installer-version-parent-"), "machine");
    const env = {
      ...process.env,
      AIDLC_BINARY_SENTINEL: sentinel,
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const cases: Array<{
      name: string;
      args: string[];
      requests?: string[];
    }> = [{
      name: "local",
      args: ["--from", release, "--offline", "--version", NEXT_VERSION, "--quiet"],
    }];
    const server = serveReleaseFixture(release);
    cases.push({
      name: "remote",
      args: ["--release-base-url", server.baseUrl, "--version", NEXT_VERSION, "--quiet"],
      requests: server.requests,
    });
    try {
      for (const fixture of cases) {
        rmSync(sentinel, { force: true });
        const child = Bun.spawn(["sh", INSTALLER, ...fixture.args], {
          cwd: REPO_ROOT,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(status, `${fixture.name}: ${stdout}${stderr}`).toBe(4);
        expect(stdout).toContain(
          `release endpoint returned ${AIDLC_VERSION}, not requested ${NEXT_VERSION}`,
        );
        expect(existsSync(sentinel)).toBe(false);
        expect(existsSync(join(machine, "versions"))).toBe(false);
        expect(existsSync(join(machine, "active-version"))).toBe(false);
        expect(existsSync(join(machine, "bin", "aidlc"))).toBe(false);
      }
      expect(server.requests.some((path) => path.endsWith(`/${binaryName}`))).toBe(false);
      expect(server.requests.some((path) => path.endsWith("/aidlc-runtime.tar.gz"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("route network policy blocks acquisition before opening a socket", async () => {
    const priorPolicy = process.env.AIDLC_ROUTE_NETWORK_POLICY;
    const priorId = process.env.AIDLC_ROUTE_ID;
    try {
      process.env.AIDLC_ROUTE_NETWORK_POLICY = "forbidden";
      process.env.AIDLC_ROUTE_ID = "read-only-test-route";
      await expect(acquireRelease({
        names: [],
        baseUrl: "http://127.0.0.1:1",
      })).rejects.toThrow("read-only-test-route forbids network access");
    } finally {
      if (priorPolicy === undefined) delete process.env.AIDLC_ROUTE_NETWORK_POLICY;
      else process.env.AIDLC_ROUTE_NETWORK_POLICY = priorPolicy;
      if (priorId === undefined) delete process.env.AIDLC_ROUTE_ID;
      else process.env.AIDLC_ROUTE_ID = priorId;
    }
  });

  test("shared release server covers redirect, delay, truncation, captive portal, oversized metadata, and missing assets", async () => {
    const release = fixtureReleaseBytes();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;

    const redirect = serveReleaseFixture(release, { kind: "redirect" });
    try {
      const acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: redirect.baseUrl,
      });
      expect(acquired.manifest.assets.map((asset) => asset.name)).toEqual([binary]);
      expect(redirect.requests.some((path) => path.startsWith("/fixture-assets/"))).toBe(true);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
    } finally {
      redirect.stop();
    }

    const delay = serveReleaseFixture(release, {
      kind: "delay",
      asset: "version.json",
      milliseconds: 100,
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: delay.baseUrl,
        metadataTimeoutMs: 10,
      })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
    } finally {
      delay.stop();
    }

    for (const fault of [
      { kind: "truncate", asset: binary } as const,
      { kind: "captive-portal", asset: "version.json" } as const,
      { kind: "oversized", asset: "version.json" } as const,
      { kind: "missing", asset: "checksums.txt" } as const,
    ]) {
      const server = serveReleaseFixture(release, fault);
      try {
        await expect(acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: server.baseUrl,
        })).rejects.toThrow();
      } finally {
        server.stop();
      }
    }
  });

  test("opt-in live release endpoint matches the fixture contract", async () => {
    if (process.env.AIDLC_RELEASE_CONTRACT_LIVE !== "1") return;
    const checked = await checkLiveReleaseContract(process.env.AIDLC_RELEASE_BASE_URL);
    expect(checked.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(checked.assets).toContain("install.sh");
  }, 30_000);

  test("online acquisition trusts released checksums instead of manifest-synthesized rows", async () => {
    const release = fixtureReleaseBytes();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) =>
      asset.name === releaseBinaryName()
    )?.name;
    expect(binary).toBeDefined();
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path.endsWith("/version.json")) return new Response(readFileSync(join(release, "version.json")));
        if (path.endsWith("/checksums.txt")) {
          return new Response(
            `${digest(join(release, "version.json"))}  version.json\n${"0".repeat(64)}  ${binary}\n`,
          );
        }
        return new Response(readFileSync(join(release, basename(path))));
      },
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary as string],
        baseUrl: `http://127.0.0.1:${server.port}`,
      })).rejects.toThrow("released checksum does not match version.json");
      expect(requests.some((path) => path.endsWith(`/${binary}`))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("release verification requires and authenticates version.json", () => {
    const missing = fixtureReleaseBytes();
    const rows = readFileSync(join(missing, "checksums.txt"), "utf-8")
      .split(/\r?\n/)
      .filter((row) => row && !row.endsWith("  version.json"));
    writeFileSync(join(missing, "checksums.txt"), `${rows.join("\n")}\n`);
    expect(() => verifyReleaseDirectory(missing)).toThrow("no version.json checksum");

    const tampered = fixtureReleaseBytes();
    const manifestPath = join(tampered, "version.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { date: string };
    manifest.date = "2026-07-18";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyReleaseDirectory(tampered)).toThrow("version.json: checksum mismatch");
  }, 60_000);

  test("local release acquisition requires an authenticated provenance bundle", async () => {
    const missing = fixtureReleaseBytes();
    rmSync(join(missing, "aidlc-release.intoto.jsonl"));
    await expect(acquireRelease({ from: missing })).rejects.toThrow(
      "release is missing aidlc-release.intoto.jsonl",
    );

    const malformed = fixtureReleaseBytes();
    writeFileSync(join(malformed, "aidlc-release.intoto.jsonl"), "not-attested\n");
    await expect(acquireRelease({ from: malformed })).rejects.toThrow(
      "release provenance verification failed",
    );

    const valid = fixtureReleaseBytes();
    const acquired = await acquireRelease({ from: valid });
    expect(acquired.manifest.version).toBe(AIDLC_VERSION);

    const repository = "example/fork";
    const workflow = `${repository}/.github/workflows/release.yml`;
    const swapped = spawnSync(BUN, [
      FIXTURE_GH,
      "attestation",
      "verify",
      join(valid, "checksums.txt"),
      "--bundle",
      join(valid, "aidlc-release.intoto.jsonl"),
      "--repo",
      workflow,
      "--signer-workflow",
      repository,
      "--source-ref",
      `refs/tags/v${AIDLC_VERSION}`,
    ], {
      env: {
        ...process.env,
        AIDLC_RELEASE_REPOSITORY: repository,
        AIDLC_RELEASE_WORKFLOW: workflow,
      },
    });
    expect(swapped.status).toBe(1);
  });

  test("release manifests reject retired per-distribution data assets", () => {
    const release = fixtureReleaseBytes();
    const manifestPath = join(release, "version.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      assets: Array<Record<string, unknown>>;
    };
    manifest.assets.push({
      name: "aidlc-data-claude.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      kind: "data",
      distribution: "claude",
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => readReleaseManifest(release)).toThrow("invalid asset metadata");
  });

  test("release client classifies HTTP failures, follows redirects, and enforces metadata timeout", async () => {
    const release = fixtureReleaseBytes();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;
    const failures = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 500 }) });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${failures.port}`,
      })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
    } finally {
      failures.stop(true);
    }

    let redirects = 0;
    let redirectPort = 0;
    const redirecting = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        const name = basename(url.pathname);
        if (!url.pathname.startsWith("/assets/")) {
          redirects++;
          return Response.redirect(`http://127.0.0.1:${redirectPort}/assets/${name}`, 302);
        }
        return new Response(readFileSync(join(release, name)));
      },
    });
    redirectPort = redirecting.port ?? 0;
    try {
      const acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${redirecting.port}`,
      });
      expect(acquired.manifest.assets.map((asset) => asset.name)).toEqual([binary]);
      expect(redirects).toBe(4);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
    } finally {
      redirecting.stop(true);
    }

    const delayed = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(100);
        return new Response("{}");
      },
    });
    try {
      await expect(acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${delayed.port}`,
        metadataTimeoutMs: 10,
      })).rejects.toThrow("timed out after 10ms");
    } finally {
      delayed.stop(true);
    }
  });

  test("release client honors proxy, NO_PROXY, mirror precedence, custom CA, and redaction", async () => {
    const release = fixtureReleaseBytes();
    const manifest = JSON.parse(readFileSync(join(release, "version.json"), "utf-8")) as {
      version: string;
      assets: Array<{ name: string }>;
    };
    const binary = manifest.assets.find((asset) => asset.name.startsWith("aidlc-"))?.name as string;
    const responseFor = (request: Request): Response => {
      const name = basename(new URL(request.url).pathname);
      return existsSync(join(release, name))
        ? new Response(readFileSync(join(release, name)))
        : new Response("missing", { status: 404 });
    };
    const openssl = Bun.which("openssl");
    if (openssl) {
      const tlsProxyKeys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
      const tlsProxySaved = Object.fromEntries(
        tlsProxyKeys.map((name) => [name, process.env[name]]),
      );
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      delete process.env.no_proxy;
      process.env.NO_PROXY = "localhost";
      const tlsRoot = temp("aidlc-t240-tls-");
      const key = join(tlsRoot, "server.key");
      const cert = join(tlsRoot, "server.crt");
      const generated = spawnSync(openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        key,
        "-out",
        cert,
      ], { encoding: "utf-8" });
      expect(generated.status, generated.stderr ?? "").toBe(0);
      const secure = Bun.serve({
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch: responseFor,
      });
      try {
        await expect(acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `https://localhost:${secure.port}`,
        })).rejects.toMatchObject({ name: "ReleaseUnavailableError" });
        const acquired = await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `https://localhost:${secure.port}`,
          caBundle: cert,
        });
        expect(acquired.manifest.version).toBe(manifest.version);
        if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });
      } finally {
        secure.stop(true);
        for (const name of tlsProxyKeys) {
          const value = tlsProxySaved[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    let originRequests = 0;
    let proxyRequests = 0;
    let ignoredMirrorRequests = 0;
    const origin = Bun.serve({
      port: 0,
      fetch(request) {
        originRequests++;
        return responseFor(request);
      },
    });
    const proxy = Bun.serve({
      port: 0,
      fetch(request) {
        proxyRequests++;
        return responseFor(request);
      },
    });
    const ignoredMirror = Bun.serve({
      port: 0,
      fetch() {
        ignoredMirrorRequests++;
        return new Response("wrong mirror", { status: 500 });
      },
    });
    const keys = [
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "AIDLC_RELEASE_BASE_URL",
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      delete process.env.https_proxy;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;
      process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
      let acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(proxyRequests).toBe(4);
      expect(originRequests).toBe(0);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      process.env.NO_PROXY = "127.0.0.1";
      acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(originRequests).toBe(4);
      expect(proxyRequests).toBe(4);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      process.env.AIDLC_RELEASE_BASE_URL = `http://127.0.0.1:${ignoredMirror.port}`;
      acquired = await acquireRelease({
        version: manifest.version,
        names: [binary],
        baseUrl: `http://127.0.0.1:${origin.port}`,
      });
      expect(ignoredMirrorRequests).toBe(0);
      if (acquired.cleanup) rmSync(acquired.cleanup, { recursive: true, force: true });

      delete process.env.NO_PROXY;
      process.env.HTTPS_PROXY = "ftp://alice:proxy-secret@127.0.0.1:9";
      let proxyMessage = "";
      try {
        await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `http://127.0.0.1:${origin.port}`,
        });
      } catch (error) {
        proxyMessage = error instanceof Error ? error.message : String(error);
      }
      expect(proxyMessage).toContain("HTTPS_PROXY must use HTTP or HTTPS");
      expect(proxyMessage).not.toContain("proxy-secret");

      delete process.env.HTTPS_PROXY;
      let urlMessage = "";
      try {
        await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl: `http://alice:url-secret@127.0.0.1:${ignoredMirror.port}`,
        });
      } catch (error) {
        urlMessage = error instanceof Error ? error.message : String(error);
      }
      expect(urlMessage).not.toContain("url-secret");

      let queryMessage = "";
      try {
        await acquireRelease({
          version: manifest.version,
          names: [binary],
          baseUrl:
            `http://127.0.0.1:${ignoredMirror.port}?token=query-secret#fragment-secret`,
        });
      } catch (error) {
        queryMessage = error instanceof Error ? error.message : String(error);
      }
      expect(queryMessage).toContain("must not include a query or fragment");
      expect(queryMessage).not.toContain("query-secret");
      expect(queryMessage).not.toContain("fragment-secret");
    } finally {
      origin.stop(true);
      proxy.stop(true);
      ignoredMirror.stop(true);
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  test("use selects only the machine version while config owns project pins", async () => {
    const release = fixtureRelease();
    const nextRelease = fixtureReleaseBytes(NEXT_VERSION);
    expect(verifyReleaseDirectory(release).version).toBe(AIDLC_VERSION);
    const machine = temp("aidlc-t240-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-pin-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };

    writeFileSync(join(project, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    const unpinPlan = run(INIT, [
      "config", "--unpin", "--dry-run", "--json", "--project-dir", project,
    ], project, env);
    expect(unpinPlan.status, unpinPlan.stdout + unpinPlan.stderr).toBe(0);
    expect(readFileSync(join(project, ".aidlc-version"), "utf-8")).toBe(`${AIDLC_VERSION}\n`);
    rmSync(join(project, ".aidlc-version"));

    const pinPlan = run(INIT, [
      "config", "--pin", NEXT_VERSION, "--from", nextRelease, "--dry-run", "--json",
      "--project-dir", project,
    ], project, env);
    expect(pinPlan.status, pinPlan.stdout + pinPlan.stderr).toBe(0);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(existsSync(join(machine, "versions", NEXT_VERSION))).toBe(false);
    expect(existsSync(join(machine, "pins.json"))).toBe(false);

    const selected = run(LIFECYCLE, [
      "use",
      AIDLC_VERSION,
      "--from",
      release,
    ], project, env);
    expect(selected.status, selected.stdout + selected.stderr).toBe(0);
    expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    expect(existsSync(join(bin, COMMAND_NAME))).toBe(true);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(existsSync(join(machine, "pins.json"))).toBe(false);
    expect(
      run(LIFECYCLE, ["use", AIDLC_VERSION, "--harness", "claude"], project, env).status,
    ).toBe(2);
    expect(
      run(LIFECYCLE, ["use", AIDLC_VERSION, "--pin", "--project-dir", project], project, env).status,
    ).toBe(2);
    expect(run(LIFECYCLE, ["use", "current"], project, env).status).toBe(2);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(existsSync(join(machine, "pins.json"))).toBe(false);
    expect(
      run(LIFECYCLE, ["update", "--harness", "claude"], project, env).status,
    ).toBe(2);

    const list = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(`"version":"${AIDLC_VERSION}"`);
    expect(list.stdout).toContain(`"active":true`);

    const pin = run(
      INIT,
      [
        "config",
        "--pin",
        NEXT_VERSION,
        "--from",
        nextRelease,
        "--project-dir",
        project,
      ],
      project,
      env,
    );
    expect(pin.status, pin.stdout + pin.stderr).toBe(0);
    expect(readFileSync(join(project, ".aidlc-version"), "utf-8")).toBe(`${NEXT_VERSION}\n`);
    expect(readFileSync(projectPinTargetPath(project), "utf-8")).toBe(
      `${join(machine, "versions", NEXT_VERSION, INSTALLED_EXECUTABLE)}\n`,
    );
    expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    const pins = readFileSync(join(machine, "pins.json"), "utf-8");
    expect(pins).toContain(NEXT_VERSION);
    const pinnedList = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(pinnedList.status).toBe(0);
    const pinnedVersions = JSON.parse(pinnedList.stdout) as {
      data: { versions: Array<{ version: string; pinPaths: string[] }> };
    };
    expect(
      pinnedVersions.data.versions.find((item) => item.version === NEXT_VERSION)
        ?.pinPaths,
    ).toEqual([project]);

    expect(run(LIFECYCLE, ["package", "verify", release], project, env).status).toBe(2);
    const unpinned = run(INIT, ["config", "--unpin", "--project-dir", project], project, env);
    expect(unpinned.status, unpinned.stdout + unpinned.stderr).toBe(0);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(existsSync(projectPinTargetPath(project))).toBe(false);
    expect(readFileSync(join(machine, "pins.json"), "utf-8")).not.toContain(project);
    writeFileSync(
      join(machine, "pins.json"),
      `${JSON.stringify({ [project]: NEXT_VERSION }, null, 2)}\n`,
    );
    const orphaned = JSON.parse(
      run(LIFECYCLE, ["versions", "list", "--json"], project, env).stdout,
    ) as { data: { versions: Array<{ version: string; pinPaths: string[] }> } };
    expect(
      orphaned.data.versions.find((item) => item.version === NEXT_VERSION)?.pinPaths,
    ).toEqual([]);
    expect(run(INIT, ["config", "--unpin", "--project-dir", project], project, env).status).toBe(0);
    expect(readFileSync(join(machine, "pins.json"), "utf-8")).not.toContain(project);

    writeFileSync(join(release, releaseBinaryName()), "tampered");
    expect(() => verifyReleaseDirectory(release)).toThrow("checksum mismatch");
  }, 60_000);

  test("installed runtime integrity baseline rejects ordinary retained-file tampering", () => {
    const release = fixtureReleaseBytes();
    const machine = temp("aidlc-t243-runtime-integrity-machine-");
    const project = temp("aidlc-t243-runtime-integrity-project-");
    mkdirSync(join(project, ".git"));
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const installed = run(LIFECYCLE, [
      "versions", "install", AIDLC_VERSION, "--from", release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const pinned = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", project,
    ], project, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(machine, "versions", AIDLC_VERSION, "version.json"), "utf-8"),
    ) as {
      installedRuntime?: {
        schemaVersion?: number;
        baseline?: string;
        sha256?: string;
      };
    };
    expect(manifest.installedRuntime).toEqual(expect.objectContaining({
      schemaVersion: 1,
      baseline: "runtime-integrity.json",
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
    expect(existsSync(join(machine, "versions", AIDLC_VERSION, "runtime-integrity.json")))
      .toBe(true);

    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(inspectInstalledVersion(AIDLC_VERSION).complete).toBe(true);
      const runtime = join(machine, "versions", AIDLC_VERSION, "runtime");
      const file = walkFiles(runtime).find((path) =>
        !path.endsWith("aidlc-stamp.json")
      ) as string;
      writeFileSync(join(runtime, file), `${readFileSync(join(runtime, file), "utf-8")}\ntampered\n`);

      const inspection = inspectInstalledVersion(AIDLC_VERSION);
      expect(inspection.complete).toBe(false);
      expect(inspection.reason).toContain("does not match the installed baseline");
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        message: `this project requires ${AIDLC_VERSION}, which is not installed completely`,
        remediation: `aidlc config --pin ${AIDLC_VERSION}`,
      }));
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  }, 60_000);

  test("fresh-clone pins require target and registry reconciliation before dispatch", () => {
    const release = fixtureReleaseBytes(NEXT_VERSION);
    const machine = temp("aidlc-t243-pin-reconcile-machine-");
    const project = temp("aidlc-t243-pin-reconcile-project-");
    mkdirSync(join(project, ".git"));
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    expect(run(LIFECYCLE, [
      "versions", "install", NEXT_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    writeFileSync(join(project, ".aidlc-version"), `${NEXT_VERSION}\n`);

    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        message: `this project's ${NEXT_VERSION} pin is not registered on this machine`,
        remediation: `aidlc config --pin ${NEXT_VERSION}`,
      }));

      writeFileSync(
        join(machine, "pins.json"),
        `${JSON.stringify({ [project]: NEXT_VERSION }, null, 2)}\n`,
      );
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        message: expect.stringContaining("pin target is invalid"),
        remediation: `aidlc config --pin ${NEXT_VERSION}`,
      }));

      const reconciled = run(INIT, [
        "config", "--pin", NEXT_VERSION, "--project-dir", project,
      ], project, env);
      expect(reconciled.status, reconciled.stdout + reconciled.stderr).toBe(0);
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual({
        kind: "execute",
        executable: join(machine, "versions", NEXT_VERSION, INSTALLED_EXECUTABLE),
        version: NEXT_VERSION,
      });

      const protectedPrune = run(
        LIFECYCLE,
        ["versions", "prune", "--yes"],
        project,
        env,
      );
      expect(protectedPrune.status, protectedPrune.stdout + protectedPrune.stderr).toBe(0);
      expect(existsSync(join(machine, "versions", NEXT_VERSION))).toBe(true);

      writeFileSync(projectPinTargetPath(project), `${join(machine, "wrong-aidlc")}\n`);
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        message: expect.stringContaining("pin target is invalid"),
        remediation: `aidlc config --pin ${NEXT_VERSION}`,
      }));

      expect(run(INIT, [
        "config", "--pin", NEXT_VERSION, "--project-dir", project,
      ], project, env).status).toBe(0);
      writeFileSync(join(machine, "pins.json"), "{}\n");
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", project,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        message: `this project's ${NEXT_VERSION} pin is not registered on this machine`,
        remediation: `aidlc config --pin ${NEXT_VERSION}`,
      }));
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  }, 60_000);

  test("pin registry canonicalizes aliases and reconciles equivalent keys", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t243-pin-alias-machine-");
    const project = temp("aidlc-t243-pin-alias-project-");
    const aliasRoot = temp("aidlc-t243-pin-alias-parent-");
    const alias = join(aliasRoot, "project");
    mkdirSync(join(project, ".git"));
    symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    const canonical = realpathSync(project);
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], alias, env).status).toBe(0);
    const pinPlan = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", alias, "--dry-run", "--json",
    ], alias, env);
    expect(pinPlan.status, pinPlan.stdout + pinPlan.stderr).toBe(0);
    expect(JSON.parse(pinPlan.stdout).data.projectDir).toBe(canonical);
    expect(existsSync(join(machine, "pins.json"))).toBe(false);
    const pinned = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", alias, "--json",
    ], alias, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);
    expect(JSON.parse(pinned.stdout).data.projectDir).toBe(canonical);
    expect(
      JSON.parse(readFileSync(join(machine, "pins.json"), "utf-8")),
    ).toEqual({ [canonical]: AIDLC_VERSION });

    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    try {
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", alias,
      ])).toEqual({ kind: "none" });

      writeFileSync(
        join(machine, "pins.json"),
        `${JSON.stringify({
          [canonical]: AIDLC_VERSION,
          [alias]: AIDLC_VERSION,
        }, null, 2)}\n`,
      );
      const list = JSON.parse(
        run(LIFECYCLE, ["versions", "list", "--json"], alias, env).stdout,
      ) as {
        data: {
          versions: Array<{ version: string; pinPaths: string[] }>;
        };
      };
      expect(
        list.data.versions.find((item) => item.version === AIDLC_VERSION)?.pinPaths,
      ).toEqual([canonical]);

      writeFileSync(
        join(machine, "pins.json"),
        `${JSON.stringify({
          [canonical]: AIDLC_VERSION,
          [alias]: NEXT_VERSION,
        }, null, 2)}\n`,
      );
      expect(resolvePinnedDispatch([
        "engine", "status", "--project-dir", alias,
      ])).toEqual(expect.objectContaining({
        kind: "failure",
        code: 4,
        message: expect.stringContaining("conflicting equivalent pin entries"),
      }));

      const reconciled = run(INIT, [
        "config", "--pin", AIDLC_VERSION, "--project-dir", alias,
      ], alias, env);
      expect(reconciled.status, reconciled.stdout + reconciled.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(machine, "pins.json"), "utf-8")),
      ).toEqual({ [canonical]: AIDLC_VERSION });

      writeFileSync(
        join(machine, "pins.json"),
        `${JSON.stringify({
          [canonical]: AIDLC_VERSION,
          [alias]: AIDLC_VERSION,
        }, null, 2)}\n`,
      );
      const unpinPlan = run(INIT, [
        "config", "--unpin", "--project-dir", alias, "--dry-run", "--json",
      ], alias, env);
      expect(unpinPlan.status, unpinPlan.stdout + unpinPlan.stderr).toBe(0);
      expect(JSON.parse(unpinPlan.stdout).data.projectDir).toBe(canonical);
      const unpinned = run(INIT, [
        "config", "--unpin", "--project-dir", alias, "--json",
      ], alias, env);
      expect(unpinned.status, unpinned.stdout + unpinned.stderr).toBe(0);
      expect(JSON.parse(unpinned.stdout).data.projectDir).toBe(canonical);
      expect(
        JSON.parse(readFileSync(join(machine, "pins.json"), "utf-8")),
      ).toEqual({});
    } finally {
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }
  }, 60_000);

  test("a declared pin keeps protecting its retained version when the local target marker is lost", () => {
    const release = fixtureRelease();
    const pinnedRelease = fixtureRelease(NEXT_VERSION);
    const machine = temp("aidlc-t243-pin-protect-machine-");
    const aliasParent = temp("aidlc-t243-pin-protect-alias-");
    const alias = join(aliasParent, "machine");
    symlinkSync(machine, alias, process.platform === "win32" ? "junction" : "dir");
    const project = temp("aidlc-t243-pin-protect-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") };
    const aliasEnv = { AIDLC_INSTALL_ROOT: alias, AIDLC_BIN_DIR: join(alias, "bin") };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    const pinned = run(INIT, [
      "config", "--pin", NEXT_VERSION, "--from", pinnedRelease, "--project-dir", project,
    ], project, env);
    expect(pinned.status, pinned.stdout + pinned.stderr).toBe(0);

    const pinPaths = (result: { stdout: string }) =>
      (JSON.parse(result.stdout) as {
        data: { versions: Array<{ version: string; pinPaths: string[] }> };
      }).data.versions.find((item) => item.version === NEXT_VERSION)?.pinPaths;

    // An equivalent spelling of the install root sees the same pin.
    expect(pinPaths(run(LIFECYCLE, ["versions", "list", "--json"], project, aliasEnv)))
      .toEqual([project]);

    // `git clean -fdx` removes the gitignored runtime marker but keeps the
    // committed .aidlc-version: the pin still protects, dispatch still refuses.
    rmSync(dirname(projectPinTargetPath(project)), { recursive: true, force: true });
    expect(pinPaths(run(LIFECYCLE, ["versions", "list", "--json"], project, env)))
      .toEqual([project]);
    const prune = run(LIFECYCLE, ["versions", "prune", "--yes", "--json"], project, env);
    expect(prune.status, prune.stdout + prune.stderr).toBe(0);
    expect((JSON.parse(prune.stdout) as { data: { removed: string[] } }).data.removed)
      .toEqual([]);
    expect(existsSync(join(machine, "versions", NEXT_VERSION))).toBe(true);
    const savedRoot = process.env.AIDLC_INSTALL_ROOT;
    const savedBin = process.env.AIDLC_BIN_DIR;
    Object.assign(process.env, env);
    try {
      expect(resolvePinnedDispatch(["engine", "status", "--project-dir", project]))
        .toEqual(expect.objectContaining({
          kind: "failure",
          message: expect.stringContaining("resolved target marker is missing"),
        }));
    } finally {
      if (savedRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = savedRoot;
      if (savedBin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = savedBin;
    }
    // Re-pinning restores the marker offline from the retained version.
    const repinned = run(INIT, [
      "config", "--pin", NEXT_VERSION, "--offline", "--project-dir", project,
    ], project, env);
    expect(repinned.status, repinned.stdout + repinned.stderr).toBe(0);
    expect(existsSync(projectPinTargetPath(project))).toBe(true);

    // Only a project that no longer declares the pin releases the version.
    rmSync(join(project, ".aidlc-version"));
    expect(pinPaths(run(LIFECYCLE, ["versions", "list", "--json"], project, env)))
      .toEqual([]);
  }, 120_000);

  test("another project's conflicting alias entries never block this project", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t243-pin-scope-machine-");
    const project = temp("aidlc-t243-pin-scope-project-");
    const other = temp("aidlc-t243-pin-scope-other-");
    const otherAlias = join(temp("aidlc-t243-pin-scope-other-alias-"), "other");
    const fresh = temp("aidlc-t243-pin-scope-fresh-");
    for (const dir of [project, other, fresh]) mkdirSync(join(dir, ".git"));
    symlinkSync(other, otherAlias, process.platform === "win32" ? "junction" : "dir");
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    expect(run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", project,
    ], project, env).status).toBe(0);
    const registryPath = join(machine, "pins.json");
    const conflict = {
      [realpathSync(other)]: AIDLC_VERSION,
      [otherAlias]: NEXT_VERSION,
    };
    writeFileSync(registryPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(registryPath, "utf-8")),
      ...conflict,
    }, null, 2)}\n`);

    const savedRoot = process.env.AIDLC_INSTALL_ROOT;
    const savedBin = process.env.AIDLC_BIN_DIR;
    Object.assign(process.env, env);
    try {
      expect(resolvePinnedDispatch(["engine", "status", "--project-dir", project]))
        .toEqual({ kind: "none" });
      writeFileSync(join(other, ".aidlc-version"), `${AIDLC_VERSION}\n`);
      expect(resolvePinnedDispatch(["engine", "status", "--project-dir", other]))
        .toEqual(expect.objectContaining({
          kind: "failure",
          code: 4,
          message: expect.stringContaining("conflicting equivalent pin entries"),
        }));
    } finally {
      if (savedRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = savedRoot;
      if (savedBin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = savedBin;
    }

    // Pinning an unrelated project succeeds and carries the conflicting and
    // malformed entries forward verbatim (whatever their JSON type) instead of
    // erasing the evidence.
    const malformed = {
      relative: "not-semver",
      [join(temp("aidlc-t243-pin-scope-numeric-"), "project")]: 42,
      [join(temp("aidlc-t243-pin-scope-object-"), "project")]: { pinned: true },
    };
    writeFileSync(registryPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(registryPath, "utf-8")),
      ...malformed,
    }, null, 2)}\n`);
    const pinnedFresh = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--offline", "--project-dir", fresh,
    ], fresh, env);
    expect(pinnedFresh.status, pinnedFresh.stdout + pinnedFresh.stderr).toBe(0);
    expect(JSON.parse(readFileSync(registryPath, "utf-8"))).toEqual({
      [project]: AIDLC_VERSION,
      [fresh]: AIDLC_VERSION,
      ...conflict,
      ...malformed,
    });
    const list = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    const pinWarnings =
      (JSON.parse(list.stdout) as { data: { pinWarnings: string[] } }).data.pinWarnings;
    expect(pinWarnings).toHaveLength(4);
    expect(pinWarnings).toEqual(expect.arrayContaining([
        expect.stringContaining("conflicting equivalent pin entries"),
        expect.stringContaining("invalid pin entry for relative"),
        expect.stringContaining("invalid pin entry for"),
        expect.stringContaining("invalid pin entry for"),
      ]));
    expect(run(LIFECYCLE, ["versions", "prune", "--yes"], project, env).status).toBe(4);

    // Filesystem-equivalent aliases form one ownership group before values are
    // validated. A valid alias must not overwrite a malformed canonical entry
    // when an unrelated project is pinned, regardless of JSON key order.
    const mixed = temp("aidlc-t243-pin-scope-mixed-");
    const mixedAlias = join(temp("aidlc-t243-pin-scope-mixed-alias-"), "mixed");
    mkdirSync(join(mixed, ".git"));
    symlinkSync(mixed, mixedAlias, process.platform === "win32" ? "junction" : "dir");
    const mixedCanonical = realpathSync(mixed);
    const mixedOrders = [
      {
        [mixedCanonical]: 42,
        [mixedAlias]: AIDLC_VERSION,
      },
      {
        [mixedAlias]: AIDLC_VERSION,
        [mixedCanonical]: 42,
      },
    ];
    for (const [index, mixedEntries] of mixedOrders.entries()) {
      const unrelated = temp(`aidlc-t243-pin-scope-unrelated-${index}-`);
      mkdirSync(join(unrelated, ".git"));
      const before = {
        [project]: AIDLC_VERSION,
        [fresh]: AIDLC_VERSION,
        ...mixedEntries,
      };
      writeFileSync(registryPath, `${JSON.stringify(before, null, 2)}\n`);
      const pinnedUnrelated = run(INIT, [
        "config", "--pin", AIDLC_VERSION, "--offline", "--project-dir", unrelated,
      ], unrelated, env);
      expect(
        pinnedUnrelated.status,
        pinnedUnrelated.stdout + pinnedUnrelated.stderr,
      ).toBe(0);
      expect(JSON.parse(readFileSync(registryPath, "utf-8"))).toEqual({
        ...before,
        [unrelated]: AIDLC_VERSION,
      });
      const mixedList = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
      expect(
        (JSON.parse(mixedList.stdout) as { data: { pinWarnings: string[] } }).data
          .pinWarnings,
      ).toContainEqual(expect.stringContaining(`invalid pin entry for ${mixedCanonical}`));
      expect(run(LIFECYCLE, ["versions", "prune", "--yes"], project, env).status).toBe(4);
    }

    // Re-pinning a project replaces every equivalent key it owns, including a
    // malformed entry recorded under one of its aliases.
    writeFileSync(registryPath, `${JSON.stringify({
      [project]: AIDLC_VERSION,
      [fresh]: AIDLC_VERSION,
      ...conflict,
      ...malformed,
    }, null, 2)}\n`);
    const freshAlias = join(temp("aidlc-t243-pin-scope-fresh-alias-"), "fresh");
    symlinkSync(fresh, freshAlias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(registryPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(registryPath, "utf-8")),
      [freshAlias]: "garbage",
    }, null, 2)}\n`);
    const repinned = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--offline", "--project-dir", freshAlias,
    ], fresh, env);
    expect(repinned.status, repinned.stdout + repinned.stderr).toBe(0);
    expect(JSON.parse(readFileSync(registryPath, "utf-8"))).toEqual({
      [project]: AIDLC_VERSION,
      [fresh]: AIDLC_VERSION,
      ...conflict,
      ...malformed,
    });
  }, 120_000);

  test("literal --project-dir text cannot select another project's pinned binary", () => {
    const release = fixtureRelease();
    const pinnedRelease = fixtureRelease(NEXT_VERSION);
    const machine = temp("aidlc-t243-pin-literal-machine-");
    const pinnedProject = temp("aidlc-t243-pin-literal-a-");
    const activeProject = temp("aidlc-t243-pin-literal-b-");
    for (const dir of [pinnedProject, activeProject]) mkdirSync(join(dir, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], pinnedProject, env).status).toBe(0);
    expect(run(INIT, [
      "config", "--pin", NEXT_VERSION, "--from", pinnedRelease, "--project-dir", pinnedProject,
    ], pinnedProject, env).status).toBe(0);
    expect(run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--offline", "--project-dir", activeProject,
    ], activeProject, env).status).toBe(0);

    const savedRoot = process.env.AIDLC_INSTALL_ROOT;
    const savedBin = process.env.AIDLC_BIN_DIR;
    Object.assign(process.env, env);
    try {
      // The dispatcher passes the directory it resolved; literal text after
      // `--` naming the other project must not change the selected binary.
      const literal = ["engine", "status", "--", "--project-dir", activeProject];
      expect(resolvePinnedDispatch(literal, pinnedProject)).toEqual({
        kind: "execute",
        executable: join(machine, "versions", NEXT_VERSION, INSTALLED_EXECUTABLE),
        version: NEXT_VERSION,
      });
      expect(resolvePinnedDispatch(
        ["engine", "status", "--project-dir", pinnedProject, ...literal.slice(2)],
      )).toEqual(expect.objectContaining({ kind: "execute", version: NEXT_VERSION }));
      expect(resolvePinnedDispatch(
        ["engine", "status", "--", "--project-dir", pinnedProject],
        activeProject,
      )).toEqual({ kind: "none" });
    } finally {
      if (savedRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = savedRoot;
      if (savedBin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = savedBin;
    }

    // End to end: from the pinned project, the literal names the project pinned
    // to the running version. Rerouting would run the real engine (which prints
    // its status text); the correct dispatch runs the retained fixture binary.
    const dispatched = run(
      DISPATCHER,
      ["engine", "status", "--", "--project-dir", activeProject],
      pinnedProject,
      env,
    );
    expect(dispatched.status, dispatched.stdout + dispatched.stderr).toBe(0);
    expect(dispatched.stdout + dispatched.stderr).not.toContain("AI-DLC workflow");
  }, 120_000);

  test("launcher ownership does not depend on the spelling of the machine roots", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t243-launcher-alias-machine-");
    const alias = join(temp("aidlc-t243-launcher-alias-parent-"), "machine");
    symlinkSync(machine, alias, process.platform === "win32" ? "junction" : "dir");
    const project = temp("aidlc-t243-launcher-alias-project-");
    mkdirSync(join(project, ".git"));
    const real = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: join(machine, "bin") };
    const aliased = { AIDLC_INSTALL_ROOT: alias, AIDLC_BIN_DIR: join(alias, "bin") };

    // Install through the alias, manage through the real spelling.
    const installed = run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], project, aliased);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const launcher = join(machine, "bin", COMMAND_NAME);
    expect(readFileSync(launcher, "utf-8")).not.toContain(alias);
    const used = run(LIFECYCLE, ["use", AIDLC_VERSION, "--json"], project, real);
    expect(used.status, used.stdout + used.stderr).toBe(0);
    const doctor = JSON.parse(run(DISPATCHER, ["doctor", "--json"], project, real).stdout) as {
      data: { checks: Array<{ pass: boolean; label: string }> };
    };
    expect(doctor.data.checks.filter((check) => check.label.startsWith("Command pointer")))
      .toEqual([expect.objectContaining({ pass: true })]);

    // And the other direction: manage the same install through the alias.
    const reused = run(LIFECYCLE, ["use", AIDLC_VERSION, "--json"], project, aliased);
    expect(reused.status, reused.stdout + reused.stderr).toBe(0);
    const purge = run(LIFECYCLE, ["uninstall", "--purge", "--yes"], project, aliased);
    expect(purge.status, purge.stdout + purge.stderr).toBe(0);
    expect(existsSync(launcher)).toBe(false);
  }, 120_000);

  test("use refuses to create a native ownership domain beside Homebrew or Nix", () => {
    const release = fixtureReleaseBytes();
    for (const executable of [
      "/opt/homebrew/Cellar/aidlc/2.7.0/libexec/aidlc",
      "/nix/store/hash-aidlc-2.7.0/bin/aidlc",
    ]) {
      const machine = temp("aidlc-t243-managed-use-machine-");
      const project = temp("aidlc-t243-managed-use-project-");
      mkdirSync(join(project, ".git"));
      const refused = run(LIFECYCLE, [
        "use", AIDLC_VERSION, "--from", release,
      ], project, {
        AIDLC_COMPILED_EXECUTABLE: executable,
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
      });
      expect(refused.status).toBe(1);
      expect(refused.stdout + refused.stderr).toContain("self-version switching is disabled");
      expect(existsSync(join(machine, "versions"))).toBe(false);
    }
  });

  test("a dispatched-version reservation protects the runtime until release", () => {
    const activeRelease = fixtureReleaseBytes();
    const retainedRelease = fixtureReleaseBytes(NEXT_VERSION);
    const machine = temp("aidlc-t243-dispatch-reservation-machine-");
    const project = temp("aidlc-t243-dispatch-reservation-project-");
    mkdirSync(join(project, ".git"));
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", activeRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", NEXT_VERSION, "--from", retainedRelease,
    ], project, env).status).toBe(0);

    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    const releaseReservation = reserveDispatchedVersion(NEXT_VERSION);
    try {
      const protectedPrune = run(
        LIFECYCLE,
        ["versions", "prune", "--yes"],
        project,
        env,
      );
      expect(protectedPrune.status, protectedPrune.stdout + protectedPrune.stderr).toBe(0);
      expect(existsSync(join(machine, "versions", NEXT_VERSION))).toBe(true);
      expect(readdirSync(join(machine, "reservations"))).toHaveLength(1);
    } finally {
      releaseReservation();
      if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = saved.root;
      if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = saved.bin;
    }

    const pruned = run(LIFECYCLE, ["versions", "prune", "--yes"], project, env);
    expect(pruned.status, pruned.stdout + pruned.stderr).toBe(0);
    expect(existsSync(join(machine, "versions", NEXT_VERSION))).toBe(false);
    expect(existsSync(join(machine, "reservations"))).toBe(false);
  }, 60_000);

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "Unix purge removes completions and installer-owned empty state directories",
    () => {
      const release = fixtureRelease();
      const machine = temp("aidlc-t243-purge-machine-");
      const project = temp("aidlc-t243-purge-project-");
      mkdirSync(join(project, ".git"));
      const env = {
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
      };
      expect(run(LIFECYCLE, [
        "update", "--version", AIDLC_VERSION, "--from", release,
      ], project, env).status).toBe(0);
      expect(readdirSync(join(machine, "completions")).sort()).toEqual(
        ["_aidlc", "aidlc.bash", "aidlc.fish", "aidlc.ps1"],
      );
      mkdirSync(join(machine, "reservations"), { recursive: true });

      const purge = run(LIFECYCLE, ["uninstall", "--purge", "--yes"], project, env);
      expect(purge.status, purge.stdout + purge.stderr).toBe(0);
      expect(existsSync(join(machine, "completions"))).toBe(false);
      expect(existsSync(join(machine, "reservations"))).toBe(false);
      expect(existsSync(join(machine, "bin"))).toBe(false);
      expect(existsSync(machine)).toBe(false);
    },
    60_000,
  );

  test("Windows uninstall retries reject a purge-mode change before cleanup", () => {
    const machine = temp("aidlc-t243-windows-retry-machine-");
    const isolatedTemp = temp("aidlc-t243-windows-retry-temp-");
    const saved = {
      root: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
      tmpdir: process.env.TMPDIR,
      tmp: process.env.TMP,
      temp: process.env.TEMP,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = join(machine, "bin");
    process.env.TMPDIR = isolatedTemp;
    process.env.TMP = isolatedTemp;
    process.env.TEMP = isolatedTemp;
    try {
      const id = createHash("sha256").update(machine).digest("hex").slice(0, 16);
      const journalPath = join(tmpdir(), `aidlc-uninstall-${id}.json`);
      const cleanupPath = join(tmpdir(), `aidlc-uninstall-${id}.ps1`);
      const fencePath = windowsUninstallFencePath();
      mkdirSync(dirname(commandPath()), { recursive: true });
      writeFileSync(commandPath(), "installer-owned command\n");
      writeFileSync(cleanupPath, "exit 0\n");
      const journal: WindowsUninstallJournal = {
        schemaVersion: 1,
        operation: "windows-uninstall-continuation",
        status: "pending",
        parentPid: process.pid,
        shimPid: null,
        installRoot: machine,
        commandPath: commandPath(),
        pointerPath: activeExecutablePath(),
        cleanupPath,
        fencePath,
        purge: false,
        preserved: [join(machine, "pins.json")],
      };
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      writeFileSync(
        fencePath,
        `${JSON.stringify({
          schemaVersion: 1,
          operation: "windows-uninstall-continuation",
          journalPath,
        }, null, 2)}\n`,
      );

      expect(() => recoverWindowsUninstallContinuations(true)).toThrow(
        "pending Windows non-purge uninstall cannot be resumed as --purge",
      );
      expect(readFileSync(commandPath(), "utf-8")).toBe("installer-owned command\n");
      expect(
        (JSON.parse(readFileSync(journalPath, "utf-8")) as WindowsUninstallJournal).purge,
      ).toBe(false);
    } finally {
      const envKeys = {
        root: "AIDLC_INSTALL_ROOT",
        bin: "AIDLC_BIN_DIR",
        tmpdir: "TMPDIR",
        tmp: "TMP",
        temp: "TEMP",
      } as const;
      for (const [name, key] of Object.entries(envKeys)) {
        const value = saved[name as keyof typeof saved];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("a failed project pin commit rolls the machine registry reservation back", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t243-pin-rollback-machine-");
    const project = temp("aidlc-t243-pin-rollback-project-");
    mkdirSync(join(project, ".git"));
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    expect(run(LIFECYCLE, [
      "use", AIDLC_VERSION, "--from", release,
    ], project, env).status).toBe(0);
    const targetPath = projectPinTargetPath(project);
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, "owned.txt"), "keep\n");

    const failed = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", project,
    ], project, env);
    expect(failed.status).toBe(1);
    expect(existsSync(join(project, ".aidlc-version"))).toBe(false);
    expect(readFileSync(join(targetPath, "owned.txt"), "utf-8")).toBe("keep\n");
    expect(
      !existsSync(join(machine, "pins.json")) ||
        !readFileSync(join(machine, "pins.json"), "utf-8").includes(project),
    ).toBe(true);
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "stable launcher enters the active dispatcher and tampered pins fail before execution",
    () => {
      const currentRelease = fixtureRelease();
      const pinnedRelease = fixtureRelease(NEXT_VERSION);
      const machine = temp("aidlc-t243-pin-launcher-machine-");
      const project = temp("aidlc-t243-pin-launcher-project-");
      const log = join(machine, "launches.log");
      mkdirSync(join(project, ".git"));
      const env = {
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
      };
      expect(run(LIFECYCLE, [
        "use", AIDLC_VERSION, "--from", currentRelease,
      ], project, env).status).toBe(0);
      expect(run(INIT, [
        "config", "--pin", NEXT_VERSION, "--from", pinnedRelease, "--project-dir", project,
      ], project, env).status).toBe(0);

      const active = join(machine, "versions", AIDLC_VERSION, "aidlc");
      const pinned = join(machine, "versions", NEXT_VERSION, "aidlc");
      writeFileSync(
        active,
        `#!/bin/sh\nprintf 'active\\n' >> ${JSON.stringify(log)}\nexit 0\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        pinned,
        `#!/bin/sh\nprintf 'pinned\\n' >> ${JSON.stringify(log)}\nexit 0\n`,
        { mode: 0o755 },
      );

      const command = join(machine, "bin", "aidlc");
      const engine = spawnSync(command, ["engine", "status"], {
        cwd: project,
        env: { ...process.env, ...env },
        encoding: "utf-8",
      });
      expect(engine.status, engine.stderr ?? "").toBe(0);
      expect(readFileSync(log, "utf-8")).toBe("active\n");

      const machineRoute = spawnSync(command, ["version"], {
        cwd: project,
        env: { ...process.env, ...env },
        encoding: "utf-8",
      });
      expect(machineRoute.status, machineRoute.stderr ?? "").toBe(0);
      expect(readFileSync(log, "utf-8")).toBe("active\nactive\n");

      const tampered = run(
        DISPATCHER,
        ["engine", "status", "--project-dir", project],
        project,
        env,
      );
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain(
        `this project requires ${NEXT_VERSION}, which is not installed completely`,
      );
      expect(tampered.stderr).toContain(`aidlc config --pin ${NEXT_VERSION}`);
      expect(readFileSync(log, "utf-8")).toBe("active\nactive\n");
    },
    60_000,
  );

  test("activation fault rolls pointer, active marker, and rollback marker back together", () => {
    const currentRelease = fixtureRelease();
    const nextVersion = NEXT_VERSION;
    const nextRelease = fixtureRelease(nextVersion);
    const machine = temp("aidlc-t240-activation-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-activation-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    for (const [version, release, verb] of [
      [AIDLC_VERSION, currentRelease, "update"],
      [nextVersion, nextRelease, "versions"],
    ] as const) {
      const args = verb === "update"
        ? ["update", "--version", version, "--from", release]
        : ["versions", "install", version, "--from", release];
      const result = run(LIFECYCLE, args, project, env);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    const priorEnv = {
      install: process.env.AIDLC_INSTALL_ROOT,
      bin: process.env.AIDLC_BIN_DIR,
    };
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = bin;
    try {
      const command = join(bin, COMMAND_NAME);
      const oldTarget = readActiveExecutable();
      const oldLauncher = readFileSync(command, "utf-8");
      for (const failAfter of [1, 2, 3]) {
        expect(() => activate(nextVersion, { failAfter })).toThrow("injected transaction failure");
        expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
        expect(readActiveExecutable()).toBe(oldTarget);
        expect(readFileSync(command, "utf-8")).toBe(oldLauncher);
        expect(existsSync(join(machine, "rollback-version"))).toBe(false);
      }

      activate(nextVersion);
      expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(nextVersion);
      expect(readActiveExecutable()).toBe(
        join(machine, "versions", nextVersion, INSTALLED_EXECUTABLE),
      );
      expect(readFileSync(join(machine, "rollback-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
    } finally {
      if (priorEnv.install === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = priorEnv.install;
      if (priorEnv.bin === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = priorEnv.bin;
    }
  }, 60_000);

  test("failed post-flip version validation restores the prior active install", () => {
    const currentRelease = fixtureRelease();
    const badVersion = NEXT_VERSION;
    const badRelease = fixtureRelease(badVersion, "9.9.9");
    const machine = temp("aidlc-t240-validation-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-validation-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", currentRelease,
    ], project, env).status).toBe(0);
    expect(run(LIFECYCLE, [
      "versions", "install", badVersion, "--from", badRelease,
    ], project, env).status).toBe(0);

    const priorInstallRoot = process.env.AIDLC_INSTALL_ROOT;
    const priorBinDir = process.env.AIDLC_BIN_DIR;
    process.env.AIDLC_INSTALL_ROOT = machine;
    process.env.AIDLC_BIN_DIR = bin;
    try {
      expect(() => activate(badVersion)).toThrow("version probe returned");
      expect(readFileSync(join(machine, "active-version"), "utf-8").trim()).toBe(AIDLC_VERSION);
      expect(readActiveExecutable()).toBe(
        join(machine, "versions", AIDLC_VERSION, INSTALLED_EXECUTABLE),
      );
      expect(existsSync(join(machine, "rollback-version"))).toBe(false);
    } finally {
      if (priorInstallRoot === undefined) delete process.env.AIDLC_INSTALL_ROOT;
      else process.env.AIDLC_INSTALL_ROOT = priorInstallRoot;
      if (priorBinDir === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = priorBinDir;
    }
  }, 60_000);

  test("retained versions reject executable checksum and runtime stamp corruption", () => {
    const release = fixtureReleaseBytes();
    const machine = temp("aidlc-t240-completeness-machine-");
    const bin = join(machine, "bin");
    const project = temp("aidlc-t240-completeness-project-");
    mkdirSync(join(project, ".git"));
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    const installed = run(LIFECYCLE, [
      "versions",
      "install",
      AIDLC_VERSION,
      "--from",
      release,
    ], project, env);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const executable = join(machine, "versions", AIDLC_VERSION, INSTALLED_EXECUTABLE);
    writeFileSync(executable, "tampered", { mode: 0o755 });
    const badExecutable = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(badExecutable.stdout).toContain('"complete":false');
    expect(
      run(LIFECYCLE, [
        "use",
        AIDLC_VERSION,
        "--from",
        release,
      ], project, env).status,
    ).toBe(4);

    cpSync(join(release, releaseBinaryName()), executable);
    const stampPath = join(
      machine,
      "versions",
      AIDLC_VERSION,
      "runtime",
      "claude",
      ".claude",
      "tools",
      "data",
      "aidlc-stamp.json",
    );
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { distribution: string };
    stamp.distribution = "kiro";
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const badStamp = run(LIFECYCLE, ["versions", "list", "--json"], project, env);
    expect(badStamp.stdout).toContain('"complete":false');
    expect(
      run(LIFECYCLE, ["use", AIDLC_VERSION, "--project-dir", project], project, env).status,
    ).toBe(4);
  }, 60_000);

  test("lifecycle exit taxonomy distinguishes usage, transport, operation, and integrity", async () => {
    const release = fixtureReleaseBytes();
    const project = temp("aidlc-t240-exits-");
    mkdirSync(join(project, ".git"));
    const invalid = run(LIFECYCLE, [
      "versions", "install", "not-semver", "--from", release,
    ], project);
    expect(invalid.status).toBe(2);
    expect(run(LIFECYCLE, ["package", "create"], project).status).toBe(2);

    const server = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 500 }) });
    try {
      const unavailable = await runAsync(LIFECYCLE, [
        "versions",
        "install",
        AIDLC_VERSION,
        "--release-base-url",
        `http://127.0.0.1:${server.port}`,
      ], project);
      expect(unavailable.status, unavailable.stdout + unavailable.stderr).toBe(3);
    } finally {
      server.stop(true);
    }

    const noRollback = run(LIFECYCLE, ["rollback"], project, {
      AIDLC_INSTALL_ROOT: temp("aidlc-t240-no-rollback-"),
      AIDLC_BIN_DIR: join(temp("aidlc-t240-no-rollback-bin-"), "bin"),
    });
    expect(noRollback.status).toBe(1);

    writeFileSync(join(release, releaseBinaryName()), "tampered");
    const integrity = run(LIFECYCLE, [
      "update",
      "--version",
      AIDLC_VERSION,
      "--from",
      release,
    ], project, {
      AIDLC_INSTALL_ROOT: temp("aidlc-t240-integrity-machine-"),
      AIDLC_BIN_DIR: join(temp("aidlc-t240-integrity-bin-"), "bin"),
    });
    expect(integrity.status).toBe(4);
  }, 60_000);

  test("a moved project pin fails read-only until its machine records are reconciled", () => {
    const release = fixtureRelease();
    const machine = temp("aidlc-t240-moved-machine-");
    const bin = join(machine, "bin");
    const parent = temp("aidlc-t240-moved-parent-");
    const oldProject = join(parent, "old");
    const newProject = join(parent, "new");
    mkdirSync(join(oldProject, ".git"), { recursive: true });
    const env = { AIDLC_INSTALL_ROOT: machine, AIDLC_BIN_DIR: bin };
    expect(run(LIFECYCLE, [
      "update", "--version", AIDLC_VERSION, "--from", release,
    ], oldProject, env).status).toBe(0);
    expect(run(INIT, [
      "config", "--project-dir", oldProject, "--from", CLAUDE_RELEASE, "--harness", "claude",
    ], oldProject, env).status).toBe(0);
    expect(run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", oldProject,
    ], oldProject, env).status).toBe(0);
    renameSync(oldProject, newProject);

    const unpinnedRoute = run(DISPATCHER, ["version", "--project-dir", newProject], newProject, env);
    expect(unpinnedRoute.status).toBe(0);
    const oldPins = JSON.parse(
      readFileSync(join(machine, "pins.json"), "utf-8"),
    ) as Record<string, string>;
    expect(oldPins[oldProject]).toBe(AIDLC_VERSION);
    const status = run(DISPATCHER, ["--status", "--project-dir", newProject], newProject, env);
    expect(status.status).toBe(1);
    expect(status.stderr).toContain(
      `this project's ${AIDLC_VERSION} pin is not registered on this machine`,
    );
    expect(status.stderr).toContain(`aidlc config --pin ${AIDLC_VERSION}`);
    expect(
      JSON.parse(readFileSync(join(machine, "pins.json"), "utf-8")),
    ).toEqual(oldPins);

    const reconciled = run(INIT, [
      "config", "--pin", AIDLC_VERSION, "--project-dir", newProject,
    ], newProject, env);
    expect(reconciled.status, reconciled.stdout + reconciled.stderr).toBe(0);
    expect(
      run(DISPATCHER, ["--status", "--project-dir", newProject], newProject, env).status,
    ).toBe(0);
    const pins = JSON.parse(
      readFileSync(join(machine, "pins.json"), "utf-8"),
    ) as Record<string, string>;
    expect(pins[newProject]).toBe(AIDLC_VERSION);
    expect(pins[oldProject]).toBe(AIDLC_VERSION);
  }, 60_000);
});

describe("t243 projection channel", () => {
  test("copy projections stay Bun-invoked while release projections are native", () => {
    const stamp = JSON.parse(
      readFileSync(join(CLAUDE_RELEASE, ".claude", "tools", "data", "aidlc-stamp.json"), "utf-8"),
    ) as { frameworkVersion: string; distribution: string };
    expect(stamp).toEqual(expect.objectContaining({
      frameworkVersion: AIDLC_VERSION,
      distribution: "claude",
    }));
    for (const path of walkFiles(CLAUDE_RELEASE)) {
      if (!/\.(md|json|toml|hook|ts)$/.test(path)) continue;
      const text = readFileSync(join(CLAUDE_RELEASE, path), "utf-8");
      expect(text).not.toMatch(/\bbun\s+[^\n]*\.claude\/(?:tools|hooks)\/aidlc/);
      expect(text).not.toContain("{{INVOKE}}");
    }
    expect(sha256Bytes(readFileSync(join(CLAUDE_RELEASE, ".claude", "tools", "aidlc.ts"))))
      .toMatch(/^sha256:[a-f0-9]{64}$/);
    const distributions = readdirSync(join(REPO_ROOT, "dist-release"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const harness of distributions) {
      const copy = join(REPO_ROOT, "dist", harness);
      const release = join(REPO_ROOT, "dist-release", harness);
      const manifest = JSON.parse(
        readFileSync(
          walkFiles(copy)
            .map((path) => join(copy, path))
            .find((path) =>
              path.replaceAll("\\", "/").endsWith("/tools/data/aidlc-stamp.json")
            ) as string,
          "utf-8",
        ),
      ) as { harnessDir: string };
      const copyText = walkFiles(copy)
        .filter((path) => /\.(md|json|toml|hook|ts)$/.test(path))
        .map((path) => readFileSync(join(copy, path), "utf-8"))
        .join("\n");
      const releaseText = walkFiles(release)
        .filter((path) => /\.(md|json|toml|hook|ts)$/.test(path))
        .map((path) => readFileSync(join(release, path), "utf-8"))
        .join("\n");
      expect(copyText).toContain(`bun ${manifest.harnessDir}/tools/aidlc.ts`);
      expect(releaseText).not.toMatch(
        new RegExp(`\\bbun\\s+[^\\n]*${manifest.harnessDir.replace(".", "\\.")}/(?:tools|hooks)/aidlc`),
      );
      expect(copyText).not.toContain("{{INVOKE}}");
      expect(releaseText).not.toContain("{{INVOKE}}");
      if (harness === "kiro-ide") {
        expect(existsSync(join(copy, ".vscode", "settings.json"))).toBe(false);
        expect(existsSync(join(release, ".vscode", "settings.json"))).toBe(true);
      }
    }
  });

  test("legacy signature inventory covers every shipped unmarked root variant", () => {
    const expected: Record<string, Record<string, string[]>> = {
      claude: {
        ".gitignore": [
          "sha256:3da36b2d01551aeae2e366caa08be8cce0dbc9110e252445dcaa4e758e24a0b6",
          "sha256:4f1cd2e930bd37d2f5d715a06ea3fa1e2d39479fc662f0f0562116376132114b",
          "sha256:f2affb8b34499f057284852456cb8a24ae586b8e816595bf98346141f3516281",
          "sha256:d397e69ac701a663158ccb43fda3f0a23c86365f29419a8c9a5e3287a490370d",
          "sha256:87e4c1237816c477096f2291f1204885692bf39e487afb3d9f67cf7e9b2c84fb",
        ],
      },
      codex: {
        "AGENTS.md": [
          "sha256:30a9f5f43d87cd29b63e75333b8ef6695f8f4e11909fd6af64e2b6cf0b8cb292",
          "sha256:47678f42e0233de9b0164eb4ec318a3ba3196074d6ec88f69aa7980bc1f2fd0d",
          "sha256:821b2149c7c6c2b6592eecd10623823fc5579fc4ae52f2ad272e00c93013d027",
          "sha256:83c6e5141646dc604c87d80622fc898761a69bd0c9caebb398441bce9f1d0727",
          "sha256:b3a07e9bb603fb0a2328004fc7cf2294afc670ec6f350a43de9c15d6e27aa04e",
          "sha256:bfc2adb83e00041750b1d19c9f3167cb7f5f5502a62af83a58d0a2828890febf",
          "sha256:d8afae6a0813f5298cf873a047664cf485308c6e0dad41dde53d8dcb27dd7769",
          "sha256:f1deb7dc72a78fe7d39c71ad2fe6c0f41248c03cde7fb36b7a478f5b9233881c",
          "sha256:f7c55e9917d3801f676fba066fdd78d8df2c36311e8d6e78068965fc7b4371fa",
          "sha256:457ff3626bf6ff4a0f6f1f7a44a1d2cbcd91490600e2332742dcf655da25b7f3",
          "sha256:9be9c5cc4a25e5b4c71b3ae35188e1a543504f19cbd5d0a20892777b0904800e",
          "sha256:bc41aca84970977673af3c0b8212a1f7a4d995a4b47fc7894b1c5b342e4a3601",
          "sha256:b3d4d0d178a01591629dbf79083b00e7a3ad42f59f79cbfc88d05b7615704a70",
          "sha256:d9be36630b49183203ae4d97946c243e3b8840202ee6f080c738e0f01343e33a",
          "sha256:cc3212fc7335018158882cbaa141ac6fd02cee53bbceb00bd185f416fa06ff8f",
        ],
      },
      kiro: {
        "AGENTS.md": [
          "sha256:4f7133cc1a9bb1243245c25c28fad57c3660b35e251ea36cea3aa2db431bf55f",
          "sha256:992307cc3fac05d81958851b2ca51db3723fea604c8d2636814ef9b2e9f7a848",
          "sha256:b886d5b375f9ebc33ef206c4f6ad20630a13eb83d0f5838e9f71f483c040f362",
          "sha256:c6796d512752c8f4aa927c9de3fb794e3432f62dd85b77fe3da1101d90aa5a0b",
          "sha256:cd7c66ba1bdd67af0be6203a1d8928efc01733ef196201003e914051d1309a28",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          "sha256:e3de4a295f9b9404b40678c28c0773ae432ac8d4aeacc07613ecfcdfbb4c866b",
          "sha256:e85a5d7ce13b676282dc99572f89c81256f2dada50b1881f4c9641e61339f5a4",
          "sha256:67a57eddd94d613590d34ec2d0181398123d9e2d9f6382eb36c62233ce02b6f9",
          "sha256:3aea80a2afde8bb2a222b329bcfc2855b4207a53f7fbfbc3abbfb4aadbafc53b",
        ],
      },
      "kiro-ide": {
        "AGENTS.md": [
          "sha256:4d539288363565feb6cf1a8d2468d1aca4373d46d354936d89e609f9862b2b9f",
          "sha256:8159f54fcfe2a2ef807227cb12a3c83327e3851672ea47294812dde411f0de69",
          "sha256:8d59f353b5575abe6ee12e8abd5ac75f55461bd7307d677d64388c16690e5afa",
          "sha256:aef608b826a4993d47e3de98679a81abe4823c7c73556def4a339c5cb92999e7",
          "sha256:b58a882d1b56bbb5cdb9a3c356b1428eb8d2593f4a9ca22118b98ca7cd0bae9c",
          "sha256:c5d2188b046cd75d8cb7214f32faa85cbc1539cddda4a0fae9bfe8fad90c237c",
          "sha256:dead4d5ea47849f489e05baeae418d5d26efc6cd14dd2201351a474376f8efde",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          "sha256:990d80744904bfa3f9923b8a04bbb2e69b454154346915edca1e1a4ef7e31c07",
          "sha256:025c596b2f44b688a329d419b5cd39fd2ee2a6d6cae4e6491dc6cd0f663c04ea",
        ],
      },
    };
    const harnessDirs: Record<string, string> = {
      claude: ".claude",
      codex: ".codex",
      kiro: ".kiro",
      "kiro-ide": ".kiro",
    };
    for (const [harness, paths] of Object.entries(expected)) {
      const descriptor = JSON.parse(
        readFileSync(
          join(
            REPO_ROOT,
            "dist",
            harness,
            harnessDirs[harness],
            "tools",
            "data",
            "aidlc-projection.json",
          ),
          "utf-8",
        ),
      ) as {
        rootIntegrations: Array<{
          path: string;
          legacySignatures?: { wholeFileHashes?: string[] };
        }>;
      };
      for (const [path, hashes] of Object.entries(paths)) {
        const integration = descriptor.rootIntegrations.find((item) => item.path === path);
        expect(integration?.legacySignatures?.wholeFileHashes, `${harness}/${path}`)
          .toEqual(hashes);
      }
    }
  });

  test("release runtime-generated commands remain binary-invoked", () => {
    const project = temp("aidlc-t240-release-invoke-");
    mkdirSync(join(project, ".git"));
    const orchestrate = run(
      join(CLAUDE_RELEASE, ".claude", "tools", "aidlc-orchestrate.ts"),
      ["next", "--status"],
      project,
      {
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_RUNTIME_HARNESS_ROOT: join(CLAUDE_RELEASE, ".claude"),
      },
    );
    expect(orchestrate.status, orchestrate.stdout + orchestrate.stderr).toBe(0);
    const directive = JSON.parse(orchestrate.stdout) as { kind: string; message: string };
    expect(directive.kind).toBe("print");
    expect(directive.message).toContain("aidlc engine status");
    expect(directive.message).not.toContain("bun ");

    const runner = readFileSync(
      join(
        CLAUDE_RELEASE,
        ".claude",
        "skills",
        "aidlc-code-generation",
        "SKILL.md",
      ),
      "utf-8",
    );
    expect(runner).toContain("aidlc engine orchestrate next --stage code-generation --single");
    expect(runner).not.toContain("bun .claude/tools/aidlc-orchestrate.ts");
  });

  test("release projections carry native host trust entries", () => {
    const claudeSettings = JSON.parse(
      readFileSync(join(CLAUDE_RELEASE, ".claude", "settings.json"), "utf-8"),
    ) as { permissions: { allow: string[] } };
    expect(claudeSettings.permissions.allow).toContain(`Bash(${trustedCommand("*")})`);
    expect(claudeSettings.permissions.allow).not.toContain("Bash");
    expect(claudeSettings.permissions.allow.some((entry) => entry.startsWith("Bash(bun "))).toBe(false);
    expect(
      claudeSettings.permissions.allow.filter((entry) => entry.includes("aidlc")),
    ).toEqual([`Bash(${trustedCommand("*")})`]);
    for (const namespace of UNTRUSTED_ROUTE_NAMESPACES) {
      expect(
        claudeSettings.permissions.allow.some((entry) =>
          entry.includes(`aidlc ${namespace}`)
        ),
      ).toBe(false);
    }

    for (const root of KIRO_RELEASES) {
      for (const path of walkFiles(join(root, ".kiro", "agents"))) {
        if (!path.endsWith(".json")) continue;
        const value = JSON.parse(
          readFileSync(join(root, ".kiro", "agents", path), "utf-8"),
        ) as {
          toolsSettings?: { execute_bash?: { allowedCommands?: string[] } };
        };
        const allowed = value.toolsSettings?.execute_bash?.allowedCommands;
        if (!allowed) continue;
        expect(allowed).toContain(trustedCommand(".*"));
        expect(allowed.some((command) => command.startsWith("bun "))).toBe(false);
        expect(allowed.filter((command) => command.includes("aidlc")))
          .toEqual([trustedCommand(".*")]);
        for (const namespace of UNTRUSTED_ROUTE_NAMESPACES) {
          expect(allowed.some((command) => command.includes(`aidlc ${namespace}`))).toBe(false);
        }
      }
      expect(readFileSync(join(root, "AGENTS.md"), "utf-8"))
        .toContain(
          "**Runtime**: Framework commands run through `aidlc`; keep that command and its runtime available.",
        );
    }
    const ideSettings = JSON.parse(
      readFileSync(join(KIRO_IDE_RELEASE, ".vscode", "settings.json"), "utf-8"),
    ) as { "kiroAgent.trustedCommands": string[] };
    expect(ideSettings["kiroAgent.trustedCommands"]).toEqual([trustedCommand("*")]);
    for (const namespace of UNTRUSTED_ROUTE_NAMESPACES) {
      expect(ideSettings["kiroAgent.trustedCommands"]).not.toContain(`aidlc ${namespace} *`);
    }

    const rules = readFileSync(
      join(CODEX_RELEASE, ".codex", "rules", "default.rules"),
      "utf-8",
    );
    expect(rules).toContain(
      `prefix_rule(pattern = [${
        TRUSTED_COMMAND_TOKENS.map((token) => JSON.stringify(token)).join(", ")
      }], decision = "allow")`,
    );
    expect(rules).not.toContain('pattern = ["bun"');
    expect(rules).not.toMatch(/prefix_rule\(pattern = \["aidlc"\]/);
    expect(rules).not.toContain('pattern = ["aidlc", "*"]');
    for (const namespace of UNTRUSTED_ROUTE_NAMESPACES) {
      expect(rules).not.toContain(`pattern = ["aidlc", "${namespace}"]`);
    }
    const hooks = readFileSync(join(CODEX_RELEASE, ".codex", "hooks.json"), "utf-8");
    const trust = readFileSync(join(CODEX_RELEASE, ".codex", "trust-seed.toml"), "utf-8");
    expect(hooks).toContain(trustedCommand("adapter codex"));
    expect(trust).toContain(`projected \`${trustedCommand("adapter codex")} ...\``);
    expect(trust).not.toContain("bun .codex/tools/aidlc.ts");
    expect(trust).not.toContain("bun scripts/package.ts codex trust");
    const cursorCli = JSON.parse(
      readFileSync(join(CURSOR_RELEASE, ".cursor", "cli.json"), "utf-8"),
    ) as { permissions: { allow: string[] } };
    expect(cursorCli.permissions.allow).toEqual([
      `Shell(${trustedCommand("*")})`,
    ]);
    expect(cursorCli.permissions.allow).not.toContain("Shell(bun)");
    const cursorHooks = readFileSync(
      join(CURSOR_RELEASE, ".cursor", "hooks.json"),
      "utf-8",
    );
    expect(cursorHooks).toContain(trustedCommand("hook cursor-adapter"));
    expect(cursorHooks).not.toContain("bun .cursor/hooks/");
    const copilotHooks = readFileSync(
      join(COPILOT_RELEASE, ".github", "hooks", "aidlc.json"),
      "utf-8",
    );
    expect(copilotHooks).toContain(trustedCommand("hook copilot-adapter"));
    expect(copilotHooks).not.toContain("bun .aidlc/hooks/");
    const opencode = JSON.parse(
      readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8"),
    ) as { permission: { bash: Record<string, string> } };
    expect(
      Object.entries(opencode.permission.bash)
        .filter(([command]) => command.includes("aidlc")),
    ).toEqual([[trustedCommand("*"), "allow"]]);
    expect(opencode.permission.bash[`${TRUSTED_COMMAND_TOKENS[0]} *`]).toBeUndefined();
    for (const namespace of UNTRUSTED_ROUTE_NAMESPACES) {
      expect(opencode.permission.bash[`aidlc ${namespace} *`]).toBeUndefined();
    }
    const parsedHooks = JSON.parse(hooks) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const snake: Record<string, string> = {
      SessionStart: "session_start",
      UserPromptSubmit: "user_prompt_submit",
      PreToolUse: "pre_tool_use",
      PostToolUse: "post_tool_use",
      PreCompact: "pre_compact",
      PostCompact: "post_compact",
      SubagentStop: "subagent_stop",
      Stop: "stop",
    };
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]),
        );
      }
      return value;
    };
    for (const [event, groups] of Object.entries(parsedHooks.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const identity = {
            event_name: snake[event],
            hooks: [{
              async: false,
              command: hook.command,
              timeout: 600,
              type: "command",
            }],
          };
          const hash = `sha256:${
            createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex")
          }`;
          expect(trust).toContain(`trusted_hash = "${hash}"`);
        }
      }
    }
    expect(readFileSync(join(CODEX_RELEASE, "AGENTS.md"), "utf-8"))
      .toContain(
        "**Runtime**: Framework commands run through `aidlc`; keep that command and its runtime available.",
      );
  });

  test("projection descriptors cannot name paths outside the projection", async () => {
    const root = temp("aidlc-t240-descriptor-");
    cpSync(CLAUDE_RELEASE, root, { recursive: true });
    const path = join(root, ".claude", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(path, "utf-8")) as {
      managedDirectories: string[];
    };
    descriptor.managedDirectories.push("..");
    writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
    const { projectionFiles } = await import("../../core/tools/aidlc-distribution.ts");
    expect(() => projectionFiles(root)).toThrow("safe top-level name");
  });

  test("projection descriptors reject malformed or policy-mismatched legacy signatures", async () => {
    const { projectionFiles } = await import("../../core/tools/aidlc-distribution.ts");
    const malformed = temp("aidlc-t240-legacy-schema-");
    cpSync(CLAUDE_RELEASE, malformed, { recursive: true });
    const path = join(malformed, ".claude", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(path, "utf-8")) as {
      rootIntegrations: Array<{
        path: string;
        legacySignatures?: {
          wholeFileHashes?: string[];
          jsonEntryHashes?: Record<string, string[]>;
        };
      }>;
    };
    const gitignore = descriptor.rootIntegrations.find((item) => item.path === ".gitignore");
    gitignore!.legacySignatures!.wholeFileHashes = ["SHA256:not-canonical"];
    writeFileSync(path, `${JSON.stringify(descriptor, null, 2)}\n`);
    expect(() => projectionFiles(malformed)).toThrow("unique lowercase SHA-256 signatures");

    const mismatched = temp("aidlc-t240-legacy-policy-");
    cpSync(CLAUDE_RELEASE, mismatched, { recursive: true });
    const mismatchPath = join(
      mismatched,
      ".claude",
      "tools",
      "data",
      "aidlc-projection.json",
    );
    const mismatch = JSON.parse(readFileSync(mismatchPath, "utf-8")) as {
      rootIntegrations: Array<Record<string, unknown>>;
    };
    const mcp = mismatch.rootIntegrations.find((item) => item.path === ".mcp.json")!;
    mcp.legacySignatures = {
      wholeFileHashes: [
        "sha256:5314da95387e5e6235d93bd8a9f314cba261b145da1edce01c90d96143fb95c8",
      ],
    };
    writeFileSync(mismatchPath, `${JSON.stringify(mismatch, null, 2)}\n`);
    expect(() => projectionFiles(mismatched)).toThrow(
      "cannot use legacy whole-file signatures",
    );
  });
});

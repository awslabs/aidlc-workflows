// covers: function:assertTransactionFilesystem, function:executePlan

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertTransactionFilesystem,
  executePlan,
  TransactionLockError,
  transactionState,
  type TransactionPlan,
} from "../../core/tools/aidlc-transaction.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TRANSACTION = pathToFileURL(join(REPO_ROOT, "core/tools/aidlc-transaction.ts")).href;
const temporary: string[] = [];
const ORIGINAL = "existing project content\n";

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t330-filesystem-")));
  temporary.push(root);
  writeFileSync(join(root, "existing.txt"), ORIGINAL);
  return root;
}

function plan(root: string): TransactionPlan {
  return {
    schemaVersion: 1,
    root,
    operations: [
      {
        kind: "write",
        path: "existing.txt",
        data: Buffer.from("updated\n").toString("base64"),
        expected: transactionState(join(root, "existing.txt")),
      },
      {
        kind: "write",
        path: "new.txt",
        data: Buffer.from("created\n").toString("base64"),
        expected: "absent",
      },
    ],
  };
}

function expectUntouched(root: string, entries = ["existing.txt"]): void {
  expect(readFileSync(join(root, "existing.txt"), "utf-8")).toBe(ORIGINAL);
  // Exact entries also catch leaked candidates, probe directories, staging,
  // recovery directories, and accidentally published transaction locks.
  expect(readdirSync(root).sort()).toEqual([...entries].sort());
}

type FilesystemObservation = {
  error: {
    name: string;
    message: string;
    code?: string;
    root?: string;
    remediation?: string;
    transactionLockError: boolean;
    aggregateError: boolean;
    sameAsInjected: boolean;
    sameAsCloseError: boolean;
  } | null;
  events: Array<{
    operation: string;
    path: string;
    destination?: string;
    exclusive?: boolean;
    directoryMode?: number;
    closed?: boolean;
  }>;
  preflightCompleted: boolean;
};

// node:fs mocks must never enter the unit runner's module cache. Capture the
// actual exports before registering the mock, then import the transaction
// module in a fresh Bun process; wrappers still exercise real IO and cleanup.
function filesystemFailure(
  root: string,
  mode: "probe" | "apply",
  code: string | null,
  operation: "open" | "write" | "fsync" | "link" = "link",
  afterHealthyProbe = false,
  cleanup: { closeCode?: string; removeCode?: string } = {},
): FilesystemObservation {
  const script = `
    import { mock } from "bun:test";
    import { basename, dirname } from "node:path";
    const actual = { ...await import("node:fs") };
    const root = ${JSON.stringify(root)};
    const cleanup = ${JSON.stringify(cleanup)};
    const injected = Object.assign(new Error("simulated " + ${JSON.stringify(operation)} + " failure"), {
      code: ${JSON.stringify(code)},
    });
    const closeError = Object.assign(new Error("simulated close failure"), { code: cleanup.closeCode });
    const removeError = Object.assign(new Error("simulated probe removal failure"), { code: cleanup.removeCode });
    const events = [];
    const descriptors = new Map();
    let active = false;
    let reject = ${JSON.stringify(code !== null && !afterHealthyProbe)};
    function record(operation, path, extra = {}) {
      if (!active) return;
      events.push({ operation, path, ...extra });
      if (reject && operation === ${JSON.stringify(operation)}) throw injected;
    }
    mock.module("node:fs", () => ({
      ...actual,
      openSync(path, flags, ...rest) {
        const exclusive = typeof flags === "string"
          ? flags.includes("x")
          : Boolean((flags & actual.constants.O_EXCL) && (flags & actual.constants.O_CREAT));
        record("open", path, { exclusive });
        const fd = actual.openSync(path, flags, ...rest);
        descriptors.set(fd, path);
        return fd;
      },
      writeSync(fd, ...rest) {
        record("write", descriptors.get(fd));
        return actual.writeSync(fd, ...rest);
      },
      fsyncSync(fd) {
        record("fsync", descriptors.get(fd));
        return actual.fsyncSync(fd);
      },
      linkSync(source, destination) {
        record("link", source, {
          destination,
          directoryMode: actual.statSync(dirname(source)).mode & 0o777,
        });
        return actual.linkSync(source, destination);
      },
      closeSync(fd) {
        const path = descriptors.get(fd);
        const result = actual.closeSync(fd);
        descriptors.delete(fd);
        record("close", path, { closed: true });
        if (active && cleanup.closeCode) throw closeError;
        return result;
      },
      rmSync(path, ...rest) {
        if (active && basename(path).startsWith(".aidlc-lock-probe-")) {
          record("remove", path);
          if (cleanup.removeCode) throw removeError;
        }
        return actual.rmSync(path, ...rest);
      },
    }));
    const transaction = await import(${JSON.stringify(TRANSACTION)});
    active = true;
    let preflightCompleted = false;
    if (${JSON.stringify(afterHealthyProbe)}) {
      transaction.assertTransactionFilesystem(root);
      preflightCompleted = true;
      events.length = 0;
      reject = ${JSON.stringify(code !== null)};
    }
    let failure = null;
    try {
      if (${JSON.stringify(mode)} === "probe") {
        transaction.assertTransactionFilesystem(root);
      } else {
        transaction.executePlan({
          schemaVersion: 1,
          root,
          operations: [
            {
              kind: "write",
              path: "existing.txt",
              data: Buffer.from("updated\\n").toString("base64"),
              expected: transaction.transactionState(root + "/existing.txt"),
            },
            {
              kind: "write",
              path: "new.txt",
              data: Buffer.from("created\\n").toString("base64"),
              expected: "absent",
            },
          ],
        });
      }
    } catch (error) {
      failure = {
        name: error.name,
        message: error.message,
        code: error.code,
        root: error.root,
        remediation: error.remediation,
        transactionLockError: error instanceof transaction.TransactionLockError,
        aggregateError: error instanceof AggregateError,
        sameAsInjected: error === injected,
        sameAsCloseError: error === closeError,
      };
    }
    process.stdout.write(JSON.stringify({ error: failure, events, preflightCompleted }));
  `;
  const env = { ...process.env };
  delete env.AIDLC_ROUTE_MUTATION_SCOPE;
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout) as FilesystemObservation;
}

function expectLockFailure(
  result: FilesystemObservation,
  root: string,
  code: string,
): void {
  expect(result.error).toEqual(expect.objectContaining({
    name: "TransactionLockError",
    code,
    root,
    message: `Cannot create an AI-DLC transaction lock in ${root}: the filesystem rejected hard-link creation (${code}).`,
    transactionLockError: true,
    sameAsInjected: false,
  }));
  expect(result.error?.remediation).toMatch(/hard[- ]links?/i);
  expect(result.error?.remediation).toMatch(/S3|FUSE/i);
}

describe("t330 transaction filesystem diagnostics", () => {
  for (const code of ["EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    test(`probe explains ${code}, exercises durable exclusive creation, and removes its private files`, () => {
      const root = project();
      const result = filesystemFailure(root, "probe", code);
      expectLockFailure(result, root, code);
      expect(result.events.map((event) => event.operation))
        .toEqual(["open", "write", "fsync", "link", "close", "remove"]);
      expect(result.events[0].exclusive).toBe(true);
      const link = result.events.find((event) => event.operation === "link")!;
      const probe = dirname(link.path);
      expect(dirname(probe)).toBe(root);
      expect(basename(probe)).toMatch(/^\.aidlc-lock-probe-/);
      expect(dirname(link.destination!)).toBe(probe);
      expect(link.destination).not.toBe(join(root, ".aidlc-transaction.lock"));
      if (process.platform !== "win32") {
        expect(link.directoryMode! & 0o077).toBe(0);
      }
      expectUntouched(root);
    });

    test(`apply explains ${code} before changing existing or new project files`, () => {
      const root = project();
      const result = filesystemFailure(root, "apply", code);
      expectLockFailure(result, root, code);
      expect(result.events.filter((event) => event.operation === "link"))
        .toEqual([expect.objectContaining({
          destination: join(root, ".aidlc-transaction.lock"),
        })]);
      expectUntouched(root);
    });
  }

  test("apply still diagnoses a hard-link failure after a successful early probe", () => {
    const root = project();
    const result = filesystemFailure(root, "apply", "EMLINK", "link", true);
    expect(result.preflightCompleted).toBe(true);
    expectLockFailure(result, root, "EMLINK");
    expectUntouched(root);
  });

  for (const mode of ["probe", "apply"] as const) {
    for (const code of ["EACCES", "EPERM", "EIO", "EXDEV"]) {
      test(`${mode} preserves the original ${code} link error and cleans temporary files`, () => {
        const root = project();
        const result = filesystemFailure(root, mode, code);
        expect(result.error).toEqual(expect.objectContaining({
          code,
          message: "simulated link failure",
          transactionLockError: false,
          sameAsInjected: true,
        }));
        expect(result.error?.remediation).toBeUndefined();
        expectUntouched(root);
      });
    }
  }

  for (const [operation, code] of [
    ["open", "EACCES"],
    ["write", "ENOSPC"],
    ["fsync", "EIO"],
    ["fsync", "ENOTSUP"],
  ] as const) {
    test(`probe preserves ${operation} ${code} errors and cleans up before attempting a link`, () => {
      const root = project();
      const result = filesystemFailure(root, "probe", code, operation);
      expect(result.error).toEqual(expect.objectContaining({
        code,
        transactionLockError: false,
        sameAsInjected: true,
      }));
      expect(result.events.some((event) => event.operation === "link")).toBe(false);
      expect(result.events.filter((event) => event.operation === "close"))
        .toHaveLength(operation === "open" ? 0 : 1);
      expectUntouched(root);
    });
  }

  test("a close error after a healthy probe is preserved after removing every probe file", () => {
    const root = project();
    const result = filesystemFailure(root, "probe", null, "link", false, { closeCode: "EIO" });
    expect(result.error).toEqual(expect.objectContaining({
      name: "Error",
      message: "simulated close failure",
      code: "EIO",
      transactionLockError: false,
      aggregateError: false,
      sameAsCloseError: true,
    }));
    expect(result.events.map((event) => event.operation))
      .toEqual(["open", "write", "fsync", "link", "close", "remove"]);
    const close = result.events.find((event) => event.operation === "close")!;
    expect(close.closed).toBe(true);
    expect(result.events.find((event) => event.operation === "remove")?.path)
      .toBe(dirname(close.path));
    expectUntouched(root);
  });

  test("EMLINK remains the primary diagnostic when closing fails but probe removal succeeds", () => {
    const root = project();
    const result = filesystemFailure(root, "probe", "EMLINK", "link", false, { closeCode: "EIO" });
    expectLockFailure(result, root, "EMLINK");
    expect(result.error?.aggregateError).toBe(false);
    expect(result.events.map((event) => event.operation))
      .toEqual(["open", "write", "fsync", "link", "close", "remove"]);
    const close = result.events.find((event) => event.operation === "close")!;
    expect(close.closed).toBe(true);
    expect(result.events.find((event) => event.operation === "remove")?.path)
      .toBe(dirname(close.path));
    expectUntouched(root);
  });

  for (const [label, code, closeCode] of [
    ["a healthy probe", null, undefined],
    ["EMLINK", "EMLINK", undefined],
    ["EMLINK and a close error", "EMLINK", "EIO"],
  ] as const) {
    test(`probe removal failure after ${label} reports an aggregate diagnostic and retained evidence`, () => {
      const root = project();
      const result = filesystemFailure(root, "probe", code, "link", false, {
        closeCode,
        removeCode: "EACCES",
      });
      const remove = result.events.find((event) => event.operation === "remove")!;
      expect(remove).toBeDefined();
      const probe = remove.path;
      try {
        expect(result.error).toEqual(expect.objectContaining({
          name: "AggregateError",
          aggregateError: true,
          transactionLockError: false,
        }));
        expect(result.error?.message).toContain(probe);
        expect(result.error?.message).toMatch(/cleanup|clean up|remov/i);
        expect(result.error?.message).toMatch(/fail|could not|cannot|unable/i);
        if (code !== null) {
          expect(result.error?.message).toContain(
            `Cannot create an AI-DLC transaction lock in ${root}: the filesystem rejected hard-link creation (EMLINK).`,
          );
        }
        const link = result.events.find((event) => event.operation === "link")!;
        expect(dirname(probe)).toBe(root);
        expect(basename(probe)).toMatch(/^\.aidlc-lock-probe-/);
        expect(dirname(link.path)).toBe(probe);
        expect(readFileSync(link.path, "utf-8").length).toBeGreaterThan(0);
        expect(existsSync(link.destination!)).toBe(code === null);
        expect(result.events.find((event) => event.operation === "close")?.closed).toBe(true);
        expectUntouched(root, ["existing.txt", basename(probe)]);
      } finally {
        // The child intentionally leaves evidence behind; cleanup here uses
        // the parent's unmocked filesystem, including on assertion failure.
        rmSync(probe, { recursive: true, force: true });
      }
      expectUntouched(root);
    });
  }

  test("a healthy probe leaves an existing live transaction lock and project files untouched", () => {
    const root = project();
    const lock = join(root, ".aidlc-transaction.lock");
    const identity = `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`;
    writeFileSync(lock, identity);
    const before = statSync(lock);
    expect(assertTransactionFilesystem(root)).toBeUndefined();
    expect(readFileSync(lock, "utf-8")).toBe(identity);
    const after = statSync(lock);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs, nlink: after.nlink })
      .toEqual({ ino: before.ino, mtimeMs: before.mtimeMs, nlink: before.nlink });
    expectUntouched(root, [".aidlc-transaction.lock", "existing.txt"]);
  });

  test("a healthy probe uses the nearest existing ancestor without creating the project", () => {
    const parent = project();
    const root = join(parent, "missing", "nested-project");
    expect(assertTransactionFilesystem(root)).toBeUndefined();
    expect(existsSync(join(parent, "missing"))).toBe(false);
    expectUntouched(parent);
  });

  test("a rejected probe names the missing destination and cleans its nearest existing ancestor", () => {
    const parent = project();
    const root = join(parent, "missing", "nested-project");
    const result = filesystemFailure(root, "probe", "EMLINK");
    expectLockFailure(result, root, "EMLINK");
    const link = result.events.find((event) => event.operation === "link")!;
    expect(dirname(dirname(link.path))).toBe(parent);
    expect(existsSync(join(parent, "missing"))).toBe(false);
    expectUntouched(parent);
  });

  test("a rejected probe preserves an existing live lock as well as the project files", () => {
    const root = project();
    const lock = join(root, ".aidlc-transaction.lock");
    const identity = `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`;
    writeFileSync(lock, identity);
    const before = statSync(lock);
    const result = filesystemFailure(root, "probe", "EMLINK");
    expectLockFailure(result, root, "EMLINK");
    expect(result.events.some((event) => event.path === lock || event.destination === lock))
      .toBe(false);
    expect(readFileSync(lock, "utf-8")).toBe(identity);
    expect(statSync(lock).ino).toBe(before.ino);
    expect(statSync(lock).mtimeMs).toBe(before.mtimeMs);
    expectUntouched(root, [".aidlc-transaction.lock", "existing.txt"]);
  });

  test("EEXIST from a live lock retains normal ownership protection and the original lock", () => {
    const root = project();
    const lock = join(root, ".aidlc-transaction.lock");
    const identity = `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`;
    writeFileSync(lock, identity);
    let caught: unknown;
    try {
      executePlan(plan(root));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransactionLockError);
    expect((caught as Error).message).toContain("another AI-DLC mutation holds");
    expect(readFileSync(lock, "utf-8")).toBe(identity);
    expectUntouched(root, [".aidlc-transaction.lock", "existing.txt"]);
  });

  test("EEXIST from a dead owner still permits recovery and a normal transaction", () => {
    const root = project();
    writeFileSync(join(root, ".aidlc-transaction.lock"), `${JSON.stringify({
      pid: 2_147_483_647,
      staging: ".aidlc-txn-dead",
    })}\n`);
    executePlan(plan(root));
    expect(readFileSync(join(root, "existing.txt"), "utf-8")).toBe("updated\n");
    expect(readFileSync(join(root, "new.txt"), "utf-8")).toBe("created\n");
    expect(readdirSync(root).sort()).toEqual(["existing.txt", "new.txt"]);
  });
});

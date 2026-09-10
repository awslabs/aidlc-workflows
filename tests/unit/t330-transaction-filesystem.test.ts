// covers: function:assertTransactionFilesystem, function:executePlan
// Real local IO with selected mount operations unavailable; this does not
// certify the atomicity/durability of S3 drivers or exercise a live S3 mount.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TRANSACTION = pathToFileURL(join(REPO_ROOT, "core/tools/aidlc-transaction.ts")).href;
const LOCK = ".aidlc-transaction.lock";
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t330-")));
  temporary.push(container);
  const root = join(container, "project");
  mkdirSync(root);
  writeFileSync(join(root, "existing.txt"), "original\n", { mode: 0o640 });
  writeFileSync(join(root, "remove.txt"), "keep until commit\n");
  return root;
}

function expectProject(root: string, committed = false, extra: string[] = []): void {
  expect(readFileSync(join(root, "existing.txt"), "utf-8"))
    .toBe(committed ? "updated\n" : "original\n");
  const second = committed ? "new.txt" : "remove.txt";
  expect(readFileSync(join(root, second), "utf-8"))
    .toBe(committed ? "created\n" : "keep until commit\n");
  expect(readdirSync(root).sort()).toEqual(["existing.txt", second, ...extra].sort());
  if (process.platform !== "win32") {
    expect(statSync(join(root, "existing.txt")).mode & 0o777).toBe(committed ? 0o600 : 0o640);
  }
}

type Fault = "append" | "append-lost" | "read" | "identity" | "exclusive"
  | "file-rename" | "directory-rename" | "chmod" | "workflow" | "lock-mkdir"
  | "directory-fsync" | "file-fsync" | "commit-fsync" | "commit-rename";
type Options = {
  fallback?: string; fault?: Fault; code?: string; mode?: "probe" | "apply";
  failAfter?: number; warmup?: boolean; closeError?: boolean; cleanupError?: boolean;
  replaceOwner?: boolean; requestedRoot?: string; contender?: boolean; releaseRetry?: boolean;
  pause?: "acquire" | "locked" | "release";
};
type Owner = { schemaVersion: number; pid: number; host: string; token: string; staging: string };
type Observation = {
  error: null | {
    name: string; message: string; root?: string; operation?: string; code?: string;
    remediation?: string; filesystem: boolean; lock: boolean; causeInjected: boolean;
    sameInjected: boolean; causes?: string[];
  };
  backend?: "directory" | "hardlink"; owner?: Owner; replacement?: string;
  faultHits: number; fallbackHits: number; probes: string[]; gates: string[];
  publicationCopies: number; preflightCompleted: boolean; pendingGate?: boolean;
};
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_ROUTE_MUTATION_SCOPE;
  return env;
}

// Isolate mocks from the runner's module cache. Every wrapper delegates to real
// IO except its selected fault, scoped to the project mount. In particular,
// hardlink rejection must never affect the dedicated local tmpdir gate.
function childSource(root: string, options: Options): string {
  return `
    import { mock } from "bun:test";
    import { basename, dirname, join, sep } from "node:path";
    const fs = { ...await import("node:fs") };
    const root = ${JSON.stringify(root)}, cfg = ${JSON.stringify(options)};
    const lock = join(root, ${JSON.stringify(LOCK)});
    const onMount = p => typeof p === "string" && (p === root || p.startsWith(root + sep));
    const inProbe = p => onMount(p) && p.split(sep).some(s => s.startsWith(".aidlc-lock-probe-"));
    const injected = Object.assign(new Error("simulated " + (cfg.fault ?? "link") + " failure"),
      { code: cfg.code ?? cfg.fallback ?? "EOPNOTSUPP" });
    const linkError = cfg.fault
      ? Object.assign(new Error("simulated link failure"), { code: cfg.fallback }) : injected;
    const closeError = Object.assign(new Error("simulated close failure"), { code: "EIO" });
    const cleanupError = Object.assign(new Error("simulated cleanup failure"), { code: "EACCES" });
    const out = { error: null, faultHits: 0, fallbackHits: 0, probes: [], gates: [],
      publicationCopies: 0, preflightCompleted: false };
    const fds = new Map();
    let armed = !cfg.warmup, paused = false;
    const fail = () => { out.faultHits++; throw injected; };
    function pause(phase) {
      if (cfg.pause !== phase || paused) return;
      paused = true;
      fs.writeFileSync(join(dirname(root), "ready"), phase);
      const deadline = performance.now() + 20000;
      while (!fs.existsSync(join(dirname(root), "continue"))) {
        if (performance.now() > deadline) throw new Error("holder rendezvous timed out");
        Bun.sleepSync(10);
      }
    }
    mock.module("node:fs", () => ({
      ...fs,
      mkdtempSync(p, ...args) {
        const result = fs.mkdtempSync(p, ...args);
        if (inProbe(result)) out.probes.push(result);
        return result;
      },
      linkSync(source, destination) {
        if (armed && cfg.fallback && onMount(source) && onMount(destination)) {
          out.fallbackHits++;
          throw linkError;
        }
        return fs.linkSync(source, destination);
      },
      mkdirSync(p, ...args) {
        if (!onMount(p) && /^\\.aidlc-.*\\.lock$/.test(basename(p)))
          out.gates.push(p);
        if (armed && onMount(p) && cfg.fault === "lock-mkdir" && basename(p) === ${JSON.stringify(LOCK)}) fail();
        if (armed && inProbe(p) && cfg.fault === "workflow" && basename(p) === "workflow-lock") fail();
        return fs.mkdirSync(p, ...args);
      },
      openSync(p, flags, ...args) {
        if (dirname(String(p)) === root && basename(String(p)).startsWith(".aidlc-lock-")) pause("acquire");
        if (armed && inProbe(p) && cfg.fault === "append" && flags === "a+") fail();
        if (armed && inProbe(p) && cfg.fault === "exclusive" && flags === "wx" && fs.existsSync(p)) {
          out.faultHits++;
          flags = "w";
        }
        const fd = fs.openSync(p, flags, ...args);
        fds.set(fd, { path: p, flags });
        return fd;
      },
      writeSync(fd, ...args) {
        if (armed && inProbe(fds.get(fd)?.path) && cfg.fault === "append-lost" && fds.get(fd)?.flags === "a+") {
          out.faultHits++;
          return Buffer.byteLength(args[0]);
        }
        return fs.writeSync(fd, ...args);
      },
      fstatSync(fd, ...args) {
        const stat = fs.fstatSync(fd, ...args);
        if (armed && inProbe(fds.get(fd)?.path) && cfg.fault === "identity" && fds.get(fd)?.flags === "a+") {
          out.faultHits++;
          return { ...stat, ino: stat.ino + 1 };
        }
        return stat;
      },
      fsyncSync(fd) {
        const p = fds.get(fd)?.path;
        if (armed && onMount(p)) {
          const directory = fs.fstatSync(fd).isDirectory();
          if (cfg.fault === "directory-fsync" && directory) fail();
          if (cfg.fault === "file-fsync" && inProbe(p) && basename(p) === "candidate") fail();
          if (cfg.fault === "commit-fsync" && !inProbe(p) && p.includes(sep + "candidates" + sep)) fail();
        }
        return fs.fsyncSync(fd);
      },
      readFileSync(p, ...args) {
        if (armed && cfg.fault === "read" && inProbe(p) && basename(p) === "candidate") fail();
        return fs.readFileSync(p, ...args);
      },
      renameSync(source, destination) {
        if (armed && inProbe(source) && fs.existsSync(source)) {
          if (cfg.fault === "directory-rename" && fs.lstatSync(source).isDirectory()) fail();
          if (cfg.fault === "file-rename" && !fs.lstatSync(source).isDirectory()) fail();
        }
        if (armed && cfg.fault === "commit-rename" && destination === join(root, "new.txt")) fail();
        return fs.renameSync(source, destination);
      },
      chmodSync(p, ...args) {
        if (armed && cfg.fault === "chmod" && inProbe(p)) fail();
        return fs.chmodSync(p, ...args);
      },
      closeSync(fd) {
        const p = fds.get(fd)?.path;
        const result = fs.closeSync(fd);
        fds.delete(fd);
        if (cfg.closeError && inProbe(p) && basename(p) === "candidate") throw closeError;
        return result;
      },
      rmSync(p, ...args) {
        if (p === lock) pause("release");
        if (cfg.cleanupError && onMount(p) && basename(p).startsWith(".aidlc-lock-probe-")) throw cleanupError;
        return fs.rmSync(p, ...args);
      },
      cpSync(source, destination, ...args) {
        if (dirname(destination) === root) out.publicationCopies++;
        return fs.cpSync(source, destination, ...args);
      },
      copyFileSync(source, destination, ...args) {
        if (dirname(destination) === root) out.publicationCopies++;
        return fs.copyFileSync(source, destination, ...args);
      },
    }));
    const tx = await import(${JSON.stringify(TRANSACTION)});
    const lib = cfg.releaseRetry ? await import(new URL("./aidlc-lib.ts", ${JSON.stringify(TRANSACTION)}).href) : null;
    lib?._setAuditLockFaultHooksForTests({ failReleaseRename: () => { out.faultHits++; return true; } });
    const requested = cfg.requestedRoot ?? root;
    try {
      if (cfg.warmup) {
        tx.assertTransactionFilesystem(requested);
        out.preflightCompleted = true;
        armed = true;
      }
      if (cfg.mode === "probe") tx.assertTransactionFilesystem(requested);
      else tx.executePlan({ schemaVersion: 1, root: requested, operations: [
        tx.writeOperation("existing.txt", cfg.contender ? "contender\\n" : "updated\\n",
          tx.transactionState(join(root, "existing.txt")), 0o600),
        ...(cfg.contender ? [] : [
          tx.writeOperation("new.txt", "created\\n", "absent"),
          { kind: "remove", path: "remove.txt", expected: tx.transactionState(join(root, "remove.txt")) },
        ]),
      ] }, {
        failAfter: cfg.failAfter,
        validateLocked() {
          out.backend = fs.statSync(lock).isDirectory() ? "directory" : "hardlink";
          out.owner = JSON.parse(fs.readFileSync(out.backend === "directory" ? join(lock, "owner.json") : lock, "utf8"));
          pause("locked");
        },
        validateCandidates() {
          if (!cfg.replaceOwner) return;
          fs.rmSync(lock, { recursive: true, force: true });
          fs.mkdirSync(lock);
          out.replacement = JSON.stringify({ ...out.owner, token: "replacement-owner" });
          fs.writeFileSync(join(lock, "owner.json"), out.replacement);
          throw new Error("replacement installed");
        },
      });
      if (cfg.releaseRetry) {
        out.pendingGate = out.gates.some(p => fs.existsSync(p));
        lib._setAuditLockFaultHooksForTests(null);
        tx.executePlan({ schemaVersion: 1, root: requested,
          operations: [tx.writeOperation("second.txt", "second commit\\n", "absent")] });
      }
    } catch (e) {
      out.error = { name: e.name, message: e.message, root: e.root, operation: e.operation,
        code: e.code, remediation: e.remediation, filesystem: e instanceof tx.TransactionFilesystemError,
        lock: e instanceof tx.TransactionLockError, causeInjected: e.cause === injected,
        sameInjected: e === injected, causes: e.errors?.map(c => c?.message) };
    } finally {
      lib?._setAuditLockFaultHooksForTests(null);
    }
    process.stdout.write(JSON.stringify(out));
  `;
}

function observe(root: string, options: Options = {}): Observation {
  const result = spawnSync(process.execPath, ["--eval", childSource(root, options)], {
    cwd: REPO_ROOT, env: childEnv(), encoding: "utf-8", timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const out = JSON.parse(result.stdout) as Observation;
  if (!options.contender) {
    for (const gate of out.gates) expect(existsSync(gate), gate).toBe(false);
  }
  if (!options.cleanupError) {
    for (const probe of out.probes) expect(existsSync(probe), probe).toBe(false);
  }
  return out;
}

function expectFilesystem(out: Observation, root: string, code: string, operation: RegExp): void {
  expect(out.error).toMatchObject({
    name: "TransactionFilesystemError", root, code, filesystem: true, lock: false,
  });
  expect(out.error?.operation).toMatch(operation);
  expect(out.error?.message).toContain(root);
  expect(out.error?.message).toContain(code);
  expect(out.error?.remediation).toMatch(/mount|local storage/i);
}

describe("t330 transaction filesystem contract", () => {
  for (const fallback of [undefined, "EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"]) {
    test(`${fallback ?? "native"} supports probe, update/create/remove, rollback and cleanup`, () => {
      const root = project();
      expect(observe(root, { fallback, mode: "probe" }).error).toBeNull();
      expectProject(root);
      const rolledBack = observe(root, { fallback, failAfter: 3 });
      expect(rolledBack.error?.message).toContain("injected transaction failure after operation 3");
      expectProject(root);
      const applied = observe(root, { fallback });
      expect(applied.error).toBeNull();
      expect(applied.backend).toBe(fallback ? "directory" : "hardlink");
      if (fallback) {
        expect(applied.fallbackHits).toBeGreaterThan(0);
        expect(applied.owner).toMatchObject({ pid: expect.any(Number),
          host: expect.any(String), token: expect.any(String), staging: expect.stringMatching(/^\.aidlc-txn-/) });
      } else expect(applied.probes).toHaveLength(0);
      expectProject(root, true);
    });
  }

  for (const [fault, operation, code] of [
    ["append", /append/, "EOPNOTSUPP"], ["append-lost", /append/, "UNKNOWN"],
    ["read", /append/, "EIO"], ["identity", /descriptor/, "UNKNOWN"],
    ["exclusive", /exclusive/, "UNKNOWN"], ["file-rename", /file replacement/, "EXDEV"],
    ["directory-rename", /directory rename/, "EOPNOTSUPP"],
    ["workflow", /workflow lock/, "UNKNOWN"],
    ...(process.platform === "win32" ? [] : [["chmod", /permissions/, "EPERM"]]),
  ] as [Fault, RegExp, string][]) {
    test(`fallback preflight rejects ${fault} before any project mutation`, () => {
      const root = project();
      const out = observe(root, { fallback: "EMLINK", fault, code });
      expect(out.faultHits).toBeGreaterThan(0);
      expectFilesystem(out, root, code, operation);
      expectProject(root);
    });
  }

  test("execute rechecks the full probe when hardlinks become unavailable after preflight", () => {
    const root = project();
    const out = observe(root, { warmup: true, fallback: "EMLINK", fault: "append", code: "ENOSYS" });
    expect(out.preflightCompleted).toBe(true);
    expect(out.probes).toHaveLength(2);
    expectFilesystem(out, root, "ENOSYS", /append/);
    expectProject(root);
  });

  for (const mode of ["probe", "apply"] as const) {
    test(`${mode} diagnoses unavailable hardlink AND directory locking at the project root`, () => {
      const root = project();
      const out = observe(root, { mode, fallback: "EMLINK", fault: "lock-mkdir", code: "EACCES" });
      expect(out.error).toMatchObject({
        name: "TransactionLockError", root, code: "EACCES", filesystem: true, lock: true,
      });
      expect(out.error?.message).toMatch(/hard-link and directory locking/);
      expectProject(root);
    });
  }

  for (const code of ["EACCES", "EIO", "EXDEV"]) {
    test(`unexpected native hardlink ${code} is preserved without attempting directory mode`, () => {
      const root = project();
      const out = observe(root, { fallback: code });
      expect(out.error).toMatchObject({ code, sameInjected: true, filesystem: false, lock: false });
      expectProject(root);
    });
  }

  for (const code of ["ENOSYS", "EOPNOTSUPP"]) {
    test(`${code} directory fsync is tolerated but file fsync is required`, () => {
      const root = project();
      const probe = observe(root, { fallback: "EMLINK", fault: "file-fsync", code });
      expectFilesystem(probe, root, code, /synchronization/);
      expectProject(root);
      const stage = observe(root, { fallback: "EMLINK", fault: "commit-fsync", code });
      expect(stage.error).toMatchObject({ code, sameInjected: true });
      expectProject(root);
      const dirs = observe(root, { fallback: "EMLINK", fault: "directory-fsync", code });
      expect(dirs.faultHits).toBeGreaterThan(0);
      expect(dirs.error).toBeNull();
      expectProject(root, true);
    });
  }

  test("a failed publication rename rolls back earlier changes without copy/delete publication", () => {
    const root = project();
    const out = observe(root, { fallback: "EMLINK", fault: "commit-rename", code: "EXDEV" });
    expect(out.error).toMatchObject({ code: "EXDEV", sameInjected: true });
    expect(out.publicationCopies).toBe(0);
    expectProject(root);
  });

  test("probe cleanup survives close failure and retains the original diagnostic", () => {
    const root = project();
    const out = observe(root, { mode: "probe", fault: "file-fsync", code: "ENOSPC", closeError: true });
    expectFilesystem(out, root, "ENOSPC", /synchronization/);
    expect(out.error?.causeInjected).toBe(true);
    expectProject(root);
    const close = observe(root, { mode: "probe", closeError: true });
    expectFilesystem(close, root, "EIO", /synchronization/);
    expectProject(root);
  });

  test("failed probe cleanup reports retained evidence and the primary diagnostic together", () => {
    const root = project();
    const out = observe(root, { mode: "probe", fault: "file-fsync", code: "ENOSPC",
      closeError: true, cleanupError: true });
    expect(out.error?.name).toBe("AggregateError");
    expect(out.error?.message).toContain(out.probes[0]);
    expect(out.error?.message).toContain("ENOSPC");
    expect(out.error?.causes).toEqual(expect.arrayContaining(["simulated close failure", "simulated cleanup failure"]));
    expect(existsSync(out.probes[0])).toBe(true);
    rmSync(out.probes[0], { recursive: true, force: true });
    expectProject(root);
  });

  test("a missing project is probed in its ancestor and diagnostics name the requested root", () => {
    const root = project(), requestedRoot = join(root, "missing", "nested");
    expect(observe(root, { mode: "probe", fallback: "EMLINK", requestedRoot }).error).toBeNull();
    const out = observe(root, { mode: "probe", fault: "read", code: "EIO", requestedRoot });
    expectFilesystem(out, requestedRoot, "EIO", /append/);
    expectProject(root);
  });
});

describe("t330 lock ownership", () => {
  test("a pending local-gate release is recovered before another native transaction in the same process", () => {
    const root = project(), out = observe(root, { releaseRetry: true });
    expect(out.faultHits).toBeGreaterThan(0);
    expect(out.pendingGate).toBe(true);
    expect(out.error).toBeNull();
    expect(out.backend).toBe("hardlink");
    expect(out.probes).toHaveLength(0);
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("second commit\n");
    expectProject(root, true, ["second.txt"]);
  });

  let deadOwner: Owner;
  function owner(): Owner {
    if (!deadOwner) {
      const root = project();
      const out = observe(root, { fallback: "EMLINK", failAfter: 3 });
      expect(out.error?.message).toContain("injected transaction failure");
      expectProject(root);
      deadOwner = out.owner!;
      expect(() => process.kill(deadOwner.pid, 0)).toThrow();
    }
    return { ...deadOwner };
  }
  for (const state of ["live", "dead", "foreign", "missing", "malformed", "unknown-schema", "no-token", "invalid-pid", "out-of-range-pid"]) {
    test(`directory owner ${state} is reclaimed only with proof of same-host death`, () => {
      const root = project(), lock = join(root, LOCK), stamp = owner();
      if (state === "live") stamp.pid = process.pid;
      if (state === "foreign") stamp.host = `other-boot:${stamp.host}`;
      if (state === "unknown-schema") stamp.schemaVersion = 2;
      if (state === "no-token") stamp.token = "";
      if (state === "invalid-pid") stamp.pid = 0;
      if (state === "out-of-range-pid") stamp.pid = Number.MAX_SAFE_INTEGER;
      mkdirSync(lock);
      const raw = state === "malformed" ? "{" : JSON.stringify(stamp);
      if (state !== "missing") writeFileSync(join(lock, "owner.json"), raw);
      const before = statSync(lock);
      const out = observe(root, { fallback: "EMLINK" });
      if (state === "dead") {
        expect(out.error).toBeNull();
        expectProject(root, true);
      } else {
        expect(out.error?.message).toMatch(/another AI-DLC mutation|cannot verify|another host or boot/);
        expect(statSync(lock).ino).toBe(before.ino);
        expect(readdirSync(lock)).toEqual(state === "missing" ? [] : ["owner.json"]);
        if (state !== "missing") expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(raw);
        expectProject(root, false, [LOCK]);
      }
    });
  }

  test("fallback probe and acquisition preserve a live legacy file lock", () => {
    const root = project(), lock = join(root, LOCK);
    const raw = JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" });
    writeFileSync(lock, raw);
    const before = statSync(lock);
    expect(observe(root, { fallback: "EMLINK", mode: "probe" }).error).toBeNull();
    expect(observe(root, { fallback: "EMLINK" }).error?.message).toContain("another AI-DLC mutation");
    expect(readFileSync(lock, "utf8")).toBe(raw);
    expect(statSync(lock).ino).toBe(before.ino);
    expect(statSync(lock).mtimeMs).toBe(before.mtimeMs);
    expectProject(root, false, [LOCK]);
  });

  test("directory release preserves a replacement owner's directory", () => {
    const root = project();
    const out = observe(root, { fallback: "EMLINK", replaceOwner: true });
    expect(out.error?.message).toBe("replacement installed");
    expect(readFileSync(join(root, LOCK, "owner.json"), "utf8")).toBe(out.replacement!);
    expectProject(root, false, [LOCK]);
  });
});

// Rendezvous with actual processes, not a guessed sleep: contender uses an
// alias and the other backend while the holder is inside the local gate.
for (const [pause, fallback, crash] of [
  ["acquire", "EMLINK", false], ["locked", "EMLINK", true],
  ["release", "EMLINK", false], ["locked", undefined, false],
] as const) {
  test(`local gate spans ${pause} (${fallback ?? "native"})${crash ? " and recovers after SIGKILL" : ""}`, async () => {
    const root = project(), alias = join(dirname(root), "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const child = Bun.spawn([process.execPath, "--eval", childSource(root, { pause, fallback })], {
      cwd: REPO_ROOT, env: childEnv(), stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    try {
      const ready = join(dirname(root), "ready"), deadline = performance.now() + 10_000;
      while (!existsSync(ready) && child.exitCode === null && performance.now() < deadline) await Bun.sleep(10);
      expect(existsSync(ready), "holder must reach the synchronized lock boundary").toBe(true);
      expect(readFileSync(ready, "utf8")).toBe(pause);
      const before = readdirSync(root).sort(), content = readFileSync(join(root, "existing.txt"), "utf8");
      const blocked = observe(root, { requestedRoot: alias, contender: true, fallback: fallback ? undefined : "EMLINK" });
      expect(blocked.error?.message).toContain("another AI-DLC mutation");
      expect(blocked.backend).toBeUndefined();
      expect(readdirSync(root).sort()).toEqual(before);
      expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe(content);
      if (crash) {
        child.kill("SIGKILL");
        await child.exited;
        expect(observe(root, { fallback: "EMLINK" }).error).toBeNull();
      } else {
        writeFileSync(join(dirname(root), "continue"), "");
        expect(await child.exited, await stderr).toBe(0);
        const completed = JSON.parse(await stdout) as Observation;
        expect(completed.error).toBeNull();
        for (const gate of completed.gates) expect(existsSync(gate)).toBe(false);
      }
      expectProject(root, true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all([child.exited, stdout, stderr]);
    }
  }, 40_000);
}

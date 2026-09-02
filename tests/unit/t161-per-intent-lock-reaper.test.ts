// covers: function:auditLockDir, function:acquireAuditLock, function:releaseAuditLock,
// function:withAuditLock, function:holdsAuditLock,
// function:_posixGateLibraryCandidatesForTests, function:_setAuditLockFaultHooksForTests
//
// t161 — P3 per-intent lock keying + stale-lock reaper. Mechanism: in-process
// for the keying invariants + the reaper liveness logic (deterministic, no LLM,
// no process boundary); t145 covers the cross-process state-lock race separately.
//
// The audit lock is now keyed PER INTENT (composite projectDir+space+intent), so
// two intents lock independently; an intent-OMITTED call hashes a RESERVED
// __workspace__ sentinel bucket distinct from every per-intent bucket (P4's
// auto-create + every intents.json write depend on this). The reaper stamps owner
// PID+generation-token on acquire and reclaims only a provably-dead (ESRCH)
// owner or an old genuinely-missing stamp. Live/malformed/unreadable owners
// fail closed.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-lib.ts):
//   auditLockDir(pd, intent?, space?) / auditLockIdentity — per-intent + sentinel.
//   acquireAuditLock(pd, retries, ms, intent?, space?) — stamps owner.json, reaps.
//   releaseAuditLock / withAuditLock — composite-keyed depth + exit handlers.
//   WORKSPACE_LOCK_SENTINEL / DEFAULT_LOCK_STALE_MS (AIDLC_LOCK_STALE_MS env).

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import {
  _posixGateLibraryCandidatesForTests,
  _setAuditLockFaultHooksForTests,
  acquireAuditLock,
  ActiveDirectiveLockContendedError,
  auditLockDir,
  auditLockIdentity,
  auditLockOwnedByProcess,
  detectLeakedLocks,
  holdsAuditLock,
  releaseAuditLock,
  writeActiveDirectiveMarker,
  WORKSPACE_LOCK_SENTINEL,
  withAuditLock,
  stateDigest,
} from "../../core/tools/aidlc-lib.ts";

const PD = "/tmp/aidlc-t161-project";
const REPO_ROOT = join(import.meta.dir, "..", "..");

// Clean any lock dirs this test family might leave under tmpdir() between cases.
function cleanLocks(): void {
  for (const f of readdirSync(tmpdir())) {
    if (f.startsWith(".aidlc-audit-") || f.includes(".aidlc-audit-")) {
      try { rmSync(join(tmpdir(), f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

beforeEach(() => {
  _setAuditLockFaultHooksForTests(null);
  cleanLocks();
});
afterEach(() => {
  _setAuditLockFaultHooksForTests(null);
  cleanLocks();
});

describe("t161 keying invariants", () => {
  test("intent-omitted hashes the __workspace__ sentinel, NOT a per-intent bucket", () => {
    const ws = auditLockIdentity(PD);
    expect(ws).toContain(WORKSPACE_LOCK_SENTINEL);
    const perIntent = auditLockIdentity(PD, "auth-aaaaaaaa", "default");
    expect(perIntent).not.toBe(ws);
    expect(perIntent).not.toContain(WORKSPACE_LOCK_SENTINEL);
  });

  test("two different intents key different lock dirs; same intent keys the same", () => {
    const a = auditLockDir(PD, "auth-aaaaaaaa", "default");
    const b = auditLockDir(PD, "export-bbbbbbbb", "default");
    const a2 = auditLockDir(PD, "auth-aaaaaaaa", "default");
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
    // The workspace bucket is distinct from both per-intent buckets.
    const ws = auditLockDir(PD);
    expect(ws).not.toBe(a);
    expect(ws).not.toBe(b);
  });

  test("physical and symlink aliases share acquire/release identity and nested depth", () => {
    const parent = mkdtempSync(join(tmpdir(), `aidlc-t161-alias-${process.pid}-`));
    const real = join(parent, "real");
    const alias = join(parent, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "dir");
    try {
      expect(auditLockIdentity(alias)).toBe(auditLockIdentity(real));
      expect(auditLockDir(alias)).toBe(auditLockDir(real));
      expect(acquireAuditLock(real, 0, 1)).toBe(true);
      expect(acquireAuditLock(alias, 0, 1)).toBe(false);
      releaseAuditLock(alias);
      expect(existsSync(auditLockDir(real))).toBe(false);
      let nested = false;
      withAuditLock(real, () => {
        withAuditLock(alias, () => {
          nested = true;
          expect(holdsAuditLock(real)).toBe(true);
          expect(holdsAuditLock(alias)).toBe(true);
        });
      });
      expect(nested).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("release stays bound when a previously-missing project path becomes a symlink", () => {
    const parent = mkdtempSync(join(tmpdir(), `aidlc-t161-late-alias-${process.pid}-`));
    const real = join(parent, "real");
    const alias = join(parent, "alias");
    const acquiredLock = auditLockDir(alias);
    try {
      expect(acquireAuditLock(alias, 0, 1)).toBe(true);
      expect(existsSync(acquiredLock)).toBe(true);
      mkdirSync(real);
      symlinkSync(real, alias, "dir");
      expect(auditLockDir(alias)).not.toBe(acquiredLock);
      releaseAuditLock(alias);
      expect(existsSync(acquiredLock)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(acquiredLock, { recursive: true, force: true });
    }
  });

  test("release stays bound when active-space changes after acquisition", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t161-space-shift-"));
    const intent = "auth-aaaaaaaa";
    mkdirSync(join(projectDir, "aidlc"), { recursive: true });
    writeFileSync(join(projectDir, "aidlc", "active-space"), "space-one\n");
    const acquiredLock = auditLockDir(projectDir, intent, "space-one");
    try {
      expect(acquireAuditLock(projectDir, 0, 1, intent)).toBe(true);
      expect(existsSync(acquiredLock)).toBe(true);
      writeFileSync(join(projectDir, "aidlc", "active-space"), "space-two\n");
      expect(auditLockDir(projectDir, intent)).not.toBe(acquiredLock);
      releaseAuditLock(projectDir, intent);
      expect(existsSync(acquiredLock)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(acquiredLock, { recursive: true, force: true });
    }
  });

  test("Windows case aliases share release identity and nested depth", () => {
    if (process.platform !== "win32") return;
    const projectDir = mkdtempSync(join(tmpdir(), "Aidlc-T161-Case-"));
    const caseAlias = projectDir.toUpperCase();
    try {
      expect(auditLockIdentity(projectDir)).toBe(auditLockIdentity(caseAlias));
      expect(acquireAuditLock(projectDir, 0, 1)).toBe(true);
      releaseAuditLock(caseAlias);
      expect(existsSync(auditLockDir(projectDir))).toBe(false);
      let nested = false;
      withAuditLock(projectDir, () => {
        withAuditLock(caseAlias, () => {
          nested = true;
        });
      });
      expect(nested).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("POSIX native gate loader falls through missing candidates to the platform libc", () => {
    if (process.platform === "win32") return;
    const defaults = _posixGateLibraryCandidatesForTests();
    expect(
      process.platform === "linux"
        ? defaults.some((candidate) => candidate.includes("musl"))
        : defaults.includes("/usr/lib/libSystem.B.dylib"),
    ).toBe(true);
    _setAuditLockFaultHooksForTests({
      posixGateLibraryCandidates: [
        "/definitely/missing/aidlc-libc.so",
        ...defaults,
      ],
    });
    try {
      expect(acquireAuditLock(PD, 0, 1)).toBe(true);
      releaseAuditLock(PD);
      expect(existsSync(auditLockDir(PD))).toBe(false);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      releaseAuditLock(PD);
    }
  });

  test("intent-omitted does NOT resolve activeIntent() (stable even with intents on disk)", () => {
    // auditLockIdentity for the omitted case is a pure sentinel — it must not
    // read the project's active-intent (during intent creation there is no active intent).
    // Calling it against a bogus pd that has no aidlc/ dir must not throw and must
    // return the sentinel bucket.
    expect(() => auditLockIdentity("/nonexistent/path/xyz")).not.toThrow();
    expect(auditLockIdentity("/nonexistent/path/xyz")).toContain(WORKSPACE_LOCK_SENTINEL);
  });
});

describe("t161 per-intent lock independence", () => {
  test("lock ownership requires the live PID stamped into the requested lock", () => {
    expect(auditLockOwnedByProcess(PD, process.pid)).toBe(false);
    expect(acquireAuditLock(PD, 0, 1)).toBe(true);
    if (["linux", "win32", "darwin"].includes(process.platform)) {
      expect(
        JSON.parse(readFileSync(join(auditLockDir(PD), "owner.json"), "utf-8"))
          .processGeneration,
      ).toBeTruthy();
    }
    expect(auditLockOwnedByProcess(PD, process.pid)).toBe(true);
    expect(auditLockOwnedByProcess(PD, process.pid + 1)).toBe(false);
    expect(auditLockOwnedByProcess(PD, 0)).toBe(false);
    releaseAuditLock(PD);
    expect(auditLockOwnedByProcess(PD, process.pid)).toBe(false);
  });

  test("an unavailable self-generation probe preserves acquisition with an unknown generation", () => {
    const lockDir = auditLockDir(PD);
    _setAuditLockFaultHooksForTests({
      selfProcessGeneration: () => null,
    });
    try {
      expect(acquireAuditLock(PD, 0, 1)).toBe(true);
      const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(owner.processGeneration).toBeUndefined();
      expect(acquireAuditLock(PD, 0, 1)).toBe(false);
      releaseAuditLock(PD);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      releaseAuditLock(PD);
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("two intents can be held concurrently in-process without contention", () => {
    expect(acquireAuditLock(PD, 0, 1, "auth-aaaaaaaa", "default")).toBe(true);
    // A DIFFERENT intent acquires immediately (0 retries) — no shared lock.
    expect(acquireAuditLock(PD, 0, 1, "export-bbbbbbbb", "default")).toBe(true);
    releaseAuditLock(PD, "auth-aaaaaaaa", "default");
    releaseAuditLock(PD, "export-bbbbbbbb", "default");
  });

  test("the SAME intent's lock is mutually exclusive (0-retry second acquire fails)", () => {
    expect(acquireAuditLock(PD, 0, 1, "auth-aaaaaaaa", "default")).toBe(true);
    // Same intent, 0 retries: the dir exists, owner is alive (this process) +
    // fresh, so the reaper must NOT reclaim → acquire fails.
    expect(acquireAuditLock(PD, 0, 1, "auth-aaaaaaaa", "default")).toBe(false);
    releaseAuditLock(PD, "auth-aaaaaaaa", "default");
  });

  test("release retires only its owner token and never removes a replacement lock", () => {
    const intent = "auth-aaaaaaaa";
    const space = "default";
    const lockDir = auditLockDir(PD, intent, space);
    const displaced = `${lockDir}.test-displaced`;
    expect(acquireAuditLock(PD, 0, 1, intent, space)).toBe(true);
    const acquired = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8"));
    const acquiredToken: unknown = acquired.token;

    // Model the Windows handoff race: this process still has its receipt, but
    // the canonical pathname now names a successor's independently stamped
    // lock. Releasing the old receipt must leave the successor untouched.
    renameSync(lockDir, displaced);
    const replacementToken = randomUUID();
    mkdirSync(join(lockDir, replacementToken), { recursive: true });
    const replacement = {
      pid: process.pid,
      startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
      reapLiveOwnerAfterStale: true,
      token: replacementToken,
    };
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(replacement));

    try {
      releaseAuditLock(PD, intent, space);
      expect(existsSync(lockDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")))
        .toEqual(replacement);
      expect(typeof acquiredToken).toBe("string");
      expect(
        typeof acquiredToken === "string" &&
          existsSync(join(displaced, acquiredToken)),
      ).toBe(true);
    } finally {
      rmSync(displaced, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("controlled check-to-rename interleaving cannot install a successor early", () => {
    const parent = mkdtempSync(join(tmpdir(), "aidlc-t161-linear-release-"));
    const projectDir = join(parent, "project");
    const driver = join(parent, "contender.ts");
    mkdirSync(projectDir);
    writeFileSync(driver, [
      `import { acquireAuditLock, releaseAuditLock } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};`,
      `const projectDir = ${JSON.stringify(projectDir)};`,
      "const won = acquireAuditLock(projectDir, 0, 1);",
      "if (won) releaseAuditLock(projectDir);",
      'process.stdout.write(won ? "WON" : "LOST");',
    ].join("\n"));
    let duringRelease = "";
    try {
      expect(acquireAuditLock(projectDir, 0, 1)).toBe(true);
      _setAuditLockFaultHooksForTests({
        afterReleaseOwnerCheck: () => {
          duringRelease = spawnSync(process.execPath, [driver], {
            encoding: "utf-8",
          }).stdout.trim();
        },
      });
      releaseAuditLock(projectDir);
      _setAuditLockFaultHooksForTests(null);
      expect(duringRelease).toBe("LOST");
      expect(spawnSync(process.execPath, [driver], {
        encoding: "utf-8",
      }).stdout.trim()).toBe("WON");
    } finally {
      _setAuditLockFaultHooksForTests(null);
      releaseAuditLock(projectDir);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("persistent retirement failure retains receipt and exit recovery ownership", () => {
    const lockDir = auditLockDir(PD);
    _setAuditLockFaultHooksForTests({
      failReleaseRename: () => true,
    });
    withAuditLock(PD, () => {});
    expect(existsSync(lockDir)).toBe(true);
    expect(holdsAuditLock(PD)).toBe(true);
    expect(acquireAuditLock(PD, 0, 1)).toBe(false);

    _setAuditLockFaultHooksForTests(null);
    releaseAuditLock(PD);
    expect(existsSync(lockDir)).toBe(false);
    expect(holdsAuditLock(PD)).toBe(false);
  }, 5000);

  test("a retirement-path collision is bypassed with a fresh random destination", () => {
    const lockDir = auditLockDir(PD);
    let collided = "";
    _setAuditLockFaultHooksForTests({
      beforeReleaseRename: (retired, attempt) => {
        if (attempt !== 0) return;
        collided = retired;
        mkdirSync(retired, { recursive: true });
        writeFileSync(join(retired, "occupied"), "collision\n");
      },
    });
    try {
      expect(acquireAuditLock(PD, 0, 1)).toBe(true);
      releaseAuditLock(PD);
      expect(existsSync(lockDir)).toBe(false);
      expect(collided).not.toBe("");
      expect(existsSync(collided)).toBe(true);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      if (collided) rmSync(collided, { recursive: true, force: true });
    }
  });

  test("failed pre-stamp cleanup never removes a successor generation", () => {
    const lockDir = auditLockDir(PD);
    const displaced = `${lockDir}.pre-stamp-displaced`;
    const successorToken = randomUUID();
    _setAuditLockFaultHooksForTests({
      beforeAcquirerOwnerStamp: (currentLockDir) => {
        renameSync(currentLockDir, displaced);
        mkdirSync(join(currentLockDir, successorToken), { recursive: true });
        writeFileSync(join(currentLockDir, "owner.json"), JSON.stringify({
          pid: process.pid,
          startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
          reapLiveOwnerAfterStale: true,
          token: successorToken,
        }));
      },
    });
    try {
      expect(acquireAuditLock(PD, 0, 1)).toBe(false);
      expect(existsSync(lockDir)).toBe(true);
      expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")).token)
        .toBe(successorToken);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      rmSync(displaced, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("a failed private gate publication never deletes a successor gate", () => {
    const lockDir = auditLockDir(PD);
    const gateDir = `${lockDir}.reap`;
    const successorToken = randomUUID();
    let injected = false;
    _setAuditLockFaultHooksForTests({
      beforeGateOwnerStamp: (_candidate, canonicalGate) => {
        if (injected) return;
        injected = true;
        mkdirSync(join(canonicalGate, successorToken), { recursive: true });
        writeFileSync(join(canonicalGate, "owner.json"), JSON.stringify({
          pid: process.pid,
          startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
          reapLiveOwnerAfterStale: false,
          token: successorToken,
        }));
      },
    });
    try {
      expect(acquireAuditLock(PD, 0, 1)).toBe(false);
      expect(JSON.parse(readFileSync(join(gateDir, "owner.json"), "utf-8")).token)
        .toBe(successorToken);
      expect(readdirSync(tmpdir()).some((entry) =>
        entry.startsWith(`${gateDir.split(/[\\/]/).pop()}.candidate.`)
      )).toBe(false);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      rmSync(gateDir, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("failed gate retirement retains owned recovery until the next operation", () => {
    const lockDir = auditLockDir(PD);
    const gateDir = `${lockDir}.reap`;
    const driver = join(tmpdir(), `aidlc-t161-gate-retire-${process.pid}.ts`);
    writeFileSync(driver, [
      `import { acquireAuditLock, releaseAuditLock } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};`,
      `const projectDir = ${JSON.stringify(PD)};`,
      "const won = acquireAuditLock(projectDir, 0, 1);",
      "if (won) releaseAuditLock(projectDir);",
      'process.stdout.write(won ? "WON" : "LOST");',
    ].join("\n"));
    let canonicalReleased = false;
    _setAuditLockFaultHooksForTests({
      afterReleaseOwnerCheck: () => {
        canonicalReleased = true;
      },
      failGateReleaseRename: () => canonicalReleased,
    });
    try {
      withAuditLock(PD, () => {});
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(gateDir)).toBe(true);
      expect(detectLeakedLocks(PD, false)).toContainEqual(
        expect.objectContaining({
          kind: "coordination-gate",
          reason: "released-gate",
          cleared: false,
        }),
      );
      expect(spawnSync(process.execPath, [driver], {
        encoding: "utf-8",
      }).stdout.trim()).toBe("WON");
      expect(existsSync(gateDir)).toBe(false);

      _setAuditLockFaultHooksForTests(null);
      expect(acquireAuditLock(PD, 0, 1)).toBe(true);
      releaseAuditLock(PD);
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(gateDir)).toBe(false);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      releaseAuditLock(PD);
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(gateDir, { recursive: true, force: true });
      rmSync(driver, { force: true });
    }
  }, 5000);

  test("releasable gate retirement excludes successor publication for acquisition and doctor", () => {
    const projectDir = `${PD}-releasable-cas`;
    const lockDir = auditLockDir(projectDir);
    const gateDir = `${lockDir}.reap`;
    const driver = join(tmpdir(), `aidlc-t161-releasable-cas-${process.pid}.ts`);
    writeFileSync(driver, [
      `import { acquireAuditLock, releaseAuditLock } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};`,
      `const projectDir = ${JSON.stringify(projectDir)};`,
      "const won = acquireAuditLock(projectDir, 0, 1);",
      "if (won) releaseAuditLock(projectDir);",
      'process.stdout.write(won ? "WON" : "LOST");',
    ].join("\n"));
    const seedGate = (): void => {
      const token = randomUUID();
      mkdirSync(join(gateDir, token), { recursive: true });
      writeFileSync(join(gateDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
        reapLiveOwnerAfterStale: false,
        token,
      }));
      writeFileSync(join(gateDir, token, "releasable"), "");
    };
    let contender = "";
    _setAuditLockFaultHooksForTests({
      afterReleasableGateCheck: () => {
        contender = spawnSync(process.execPath, [driver], {
          encoding: "utf-8",
        }).stdout.trim();
      },
    });
    try {
      seedGate();
      expect(acquireAuditLock(projectDir, 0, 1)).toBe(true);
      expect(contender).toBe("LOST");
      releaseAuditLock(projectDir);

      contender = "";
      seedGate();
      expect(detectLeakedLocks(projectDir, true)).toContainEqual(
        expect.objectContaining({
          kind: "coordination-gate",
          reason: "released-gate",
          cleared: true,
        }),
      );
      expect(contender).toBe("LOST");
      _setAuditLockFaultHooksForTests(null);
      expect(spawnSync(process.execPath, [driver], {
        encoding: "utf-8",
      }).stdout.trim()).toBe("WON");
    } finally {
      _setAuditLockFaultHooksForTests(null);
      releaseAuditLock(projectDir);
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(gateDir, { recursive: true, force: true });
      rmSync(`${lockDir}.gate-mutex`, { force: true });
      rmSync(driver, { force: true });
    }
  }, 10000);

  test("malformed gate tokens and redirected releasable markers remain fail-closed", () => {
    const cases = [
      "traversal-token",
      "missing-token-dir",
      "symlink-token-dir",
      "symlink-releasable",
    ] as const;
    for (const kind of cases) {
      const projectDir = `${PD}-${kind}`;
      const lockDir = auditLockDir(projectDir);
      const gateDir = `${lockDir}.reap`;
      const externalDir = `${gateDir}.external`;
      const token = kind === "traversal-token"
        ? `../${basename(externalDir)}`
        : randomUUID();
      mkdirSync(gateDir, { recursive: true });
      if (kind === "traversal-token") {
        const escaped = resolvePath(gateDir, token);
        mkdirSync(escaped, { recursive: true });
        writeFileSync(join(escaped, "releasable"), "");
      } else if (kind === "symlink-token-dir") {
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(join(externalDir, "releasable"), "");
        symlinkSync(externalDir, join(gateDir, token), "dir");
      } else if (kind === "symlink-releasable") {
        mkdirSync(join(gateDir, token), { recursive: true });
        mkdirSync(externalDir, { recursive: true });
        const externalMarker = join(externalDir, "releasable");
        writeFileSync(externalMarker, "");
        symlinkSync(externalMarker, join(gateDir, token, "releasable"), "file");
      }
      writeFileSync(join(gateDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
        reapLiveOwnerAfterStale: false,
        token,
      }));
      try {
        expect(acquireAuditLock(projectDir, 0, 1)).toBe(false);
        expect(detectLeakedLocks(projectDir, true)).toContainEqual(
          expect.objectContaining({
            kind: "coordination-gate",
            reason: "invalid-owner",
            cleared: false,
          }),
        );
        expect(existsSync(gateDir)).toBe(true);
        expect(existsSync(lockDir)).toBe(false);
        if (kind !== "missing-token-dir") {
          expect(existsSync(externalDir)).toBe(true);
          expect(existsSync(join(externalDir, "releasable"))).toBe(true);
        }
      } finally {
        rmSync(gateDir, { recursive: true, force: true });
        rmSync(externalDir, { recursive: true, force: true });
        rmSync(`${lockDir}.gate-mutex`, { force: true });
      }
    }
  });

  test("withAuditLock keys depth per-identity — two intents don't share a depth counter", () => {
    let innerRan = false;
    withAuditLock(PD, () => {
      expect(holdsAuditLock(PD, "auth-aaaaaaaa", "default")).toBe(false); // not held yet
      withAuditLock(PD, () => {
        innerRan = true;
        expect(holdsAuditLock(PD, "auth-aaaaaaaa", "default")).toBe(true);
        expect(holdsAuditLock(PD, "export-bbbbbbbb", "default")).toBe(false);
      }, "auth-aaaaaaaa", "default");
    });
    expect(innerRan).toBe(true);
    expect(holdsAuditLock(PD, "auth-aaaaaaaa", "default")).toBe(false); // released
  });
});

describe("t161 stale-lock reaper", () => {
  const INTENT = "auth-aaaaaaaa";

  function stampOwner(
    pid: number,
    ageMs: number,
    token?: string,
    processGeneration?: string,
  ): void {
    const lockDir = auditLockDir(PD, INTENT, "default");
    mkdirSync(lockDir, { recursive: true });
    if (token) mkdirSync(join(lockDir, token), { recursive: true });
    // startedAtMs is measured by the lib via performance.timeOrigin+now(); a
    // stamp "ageMs in the past" is (now - ageMs). We approximate "now" the same
    // way the lib does so the age delta is honoured.
    const now = Math.floor(performance.timeOrigin + performance.now());
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid,
        startedAtMs: now - ageMs,
        reapLiveOwnerAfterStale: true,
        ...(token ? { token } : {}),
        ...(processGeneration ? { processGeneration } : {}),
      }),
      "utf-8",
    );
  }

  test("a PID-dead lock is reclaimed (ESRCH owner gone)", () => {
    // PID 1 exists; use a very-high unlikely-live PID to force ESRCH.
    const deadPid = 2_000_000_000;
    stampOwner(deadPid, 0); // fresh stamp, but the owner is gone
    // 0 retries: the reaper must reclaim on the FIRST EEXIST and re-mkdir.
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(true);
    releaseAuditLock(PD, INTENT, "default");
  });

  test("a live-but-OVER-AGE lock fails closed instead of being reclaimed", () => {
    process.env.AIDLC_LOCK_STALE_MS = "1000"; // 1s threshold
    try {
      stampOwner(process.pid, 60_000); // 60s old → over-age
      expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(false);
      expect(existsSync(auditLockDir(PD, INTENT, "default"))).toBe(true);
    } finally {
      rmSync(auditLockDir(PD, INTENT, "default"), { recursive: true, force: true });
      delete process.env.AIDLC_LOCK_STALE_MS;
    }
  });

  test("aged malformed and unreadable owner stamps fail closed", () => {
    process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS = "1";
    try {
      for (const kind of ["malformed", "unreadable"] as const) {
        const projectDir = `${PD}-${kind}`;
        const lockDir = auditLockDir(projectDir);
        mkdirSync(lockDir, { recursive: true });
        const ownerPath = join(lockDir, "owner.json");
        if (kind === "malformed") {
          writeFileSync(ownerPath, `{"pid":${process.pid},"startedAtMs":`);
        } else {
          mkdirSync(ownerPath);
        }
        utimesSync(lockDir, new Date(0), new Date(0));
        expect(acquireAuditLock(projectDir, 0, 1)).toBe(false);
        expect(existsSync(lockDir)).toBe(true);
        const findings = detectLeakedLocks(projectDir, true);
        expect(findings).toContainEqual(expect.objectContaining({
          reason: kind === "malformed" ? "invalid-owner" : "unreadable-owner",
          cleared: false,
        }));
        expect(existsSync(lockDir)).toBe(true);
        rmSync(lockDir, { recursive: true, force: true });
      }
    } finally {
      delete process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
    }
  });

  test("PID reuse generation mismatch is reclaimable while the same generation fails closed", () => {
    const pid = 424_242;
    const oldToken = randomUUID();
    stampOwner(pid, 0, oldToken, "old-generation");
    _setAuditLockFaultHooksForTests({
      processProbe: () => ({ alive: true, generation: "new-generation" }),
    });
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(true);
    releaseAuditLock(PD, INTENT, "default");

    const liveToken = randomUUID();
    stampOwner(pid, 0, liveToken, "same-generation");
    _setAuditLockFaultHooksForTests({
      processProbe: () => ({ alive: true, generation: "same-generation" }),
    });
    try {
      expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(false);
      expect(existsSync(auditLockDir(PD, INTENT, "default"))).toBe(true);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      rmSync(auditLockDir(PD, INTENT, "default"), { recursive: true, force: true });
    }
  });

  test("generation probe failure is bounded, fail-closed, and doctor-visible", () => {
    const projectDir = `${PD}-generation-unavailable`;
    const lockDir = auditLockDir(projectDir);
    const pid = 434_343;
    const token = randomUUID();
    mkdirSync(join(lockDir, token), { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      pid,
      startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
      reapLiveOwnerAfterStale: true,
      token,
      processGeneration: "recorded-generation",
    }));
    _setAuditLockFaultHooksForTests({
      processProbe: () => ({ alive: true, generation: null }),
    });
    try {
      expect(acquireAuditLock(projectDir, 0, 1)).toBe(false);
      const findings = detectLeakedLocks(projectDir, true);
      expect(findings).toContainEqual(expect.objectContaining({
        reason: "generation-unavailable",
        cleared: false,
      }));
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("a crashed reap claim is recovered and a failed reap rename does not poison recovery", () => {
    const lockDir = auditLockDir(PD, INTENT, "default");
    const claimDir = `${lockDir}.reap`;
    const seedCrashedClaim = (claimToken: string): void => {
      mkdirSync(join(claimDir, claimToken), { recursive: true });
      writeFileSync(join(claimDir, "owner.json"), JSON.stringify({
        pid: 2_000_000_000,
        startedAtMs: 0,
        reapLiveOwnerAfterStale: false,
        token: claimToken,
        processGeneration: `dead-claim-${claimToken}`,
      }));
    };

    const deadToken = randomUUID();
    stampOwner(2_000_000_000, 0, deadToken, "dead-owner-generation");
    seedCrashedClaim(randomUUID()); // crash after claim, before canonical move
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(true);
    releaseAuditLock(PD, INTENT, "default");
    expect(existsSync(claimDir)).toBe(false);

    const movedToken = randomUUID();
    stampOwner(2_000_000_000, 0, movedToken, "moved-owner-generation");
    const movedClaimToken = randomUUID();
    seedCrashedClaim(movedClaimToken);
    renameSync(lockDir, `${lockDir}.dead.${movedClaimToken}`);
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(true);
    releaseAuditLock(PD, INTENT, "default");
    expect(existsSync(claimDir)).toBe(false);

    const livePid = 616_161;
    const liveToken = randomUUID();
    const liveClaimToken = randomUUID();
    seedCrashedClaim(liveClaimToken);
    const livePrivate = `${lockDir}.dead.${liveClaimToken}`;
    mkdirSync(join(livePrivate, liveToken), { recursive: true });
    writeFileSync(join(livePrivate, "owner.json"), JSON.stringify({
      pid: livePid,
      startedAtMs: 1,
      reapLiveOwnerAfterStale: true,
      token: liveToken,
      processGeneration: "live-moved-generation",
    }));
    _setAuditLockFaultHooksForTests({
      processProbe: (pid) => pid === livePid
        ? { alive: true, generation: "live-moved-generation" }
        : { alive: false, generation: null },
    });
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(false);
    expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")).token)
      .toBe(liveToken);
    expect(existsSync(claimDir)).toBe(false);
    _setAuditLockFaultHooksForTests(null);
    rmSync(lockDir, { recursive: true, force: true });

    const retryToken = randomUUID();
    stampOwner(2_000_000_000, 0, retryToken, "retry-owner-generation");
    _setAuditLockFaultHooksForTests({
      failReapRename: () => true,
    });
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(false);
    expect(existsSync(claimDir)).toBe(false);
    _setAuditLockFaultHooksForTests(null);
    expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(true);
    releaseAuditLock(PD, INTENT, "default");
  }, 5000);

  test("unstamped publication after the final reap check is restored under the reap gate", () => {
    const projectDir = `${PD}-unstamped-publish`;
    const lockDir = auditLockDir(projectDir);
    const token = randomUUID();
    const fakePid = 515_151;
    const driver = join(tmpdir(), `aidlc-t161-gated-contender-${process.pid}.ts`);
    writeFileSync(driver, [
      `import { acquireAuditLock, releaseAuditLock } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};`,
      `const projectDir = ${JSON.stringify(projectDir)};`,
      "const won = acquireAuditLock(projectDir, 0, 1);",
      "if (won) releaseAuditLock(projectDir);",
      'process.stdout.write(won ? "WON" : "LOST");',
    ].join("\n"));
    let contender = "";
    mkdirSync(join(lockDir, token), { recursive: true });
    utimesSync(lockDir, new Date(0), new Date(0));
    process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS = "1";
    _setAuditLockFaultHooksForTests({
      processProbe: (pid) => pid === fakePid
        ? { alive: true, generation: "live-acquirer-generation" }
        : { alive: false, generation: null },
      afterReapFinalCheck: (currentLockDir) => {
        writeFileSync(join(currentLockDir, "owner.json"), JSON.stringify({
          pid: fakePid,
          startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
          reapLiveOwnerAfterStale: true,
          token,
          processGeneration: "live-acquirer-generation",
        }));
        contender = spawnSync(process.execPath, [driver], {
          encoding: "utf-8",
        }).stdout.trim();
      },
    });
    try {
      expect(acquireAuditLock(projectDir, 0, 1)).toBe(false);
      expect(contender).toBe("LOST");
      expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")).token)
        .toBe(token);
      expect(existsSync(`${lockDir}.reap`)).toBe(false);
      expect(readdirSync(tmpdir()).some((entry) =>
        entry.startsWith(`${lockDir.split(/[\\/]/).pop()}.dead.`)
      )).toBe(false);
    } finally {
      delete process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
      _setAuditLockFaultHooksForTests(null);
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(`${lockDir}.reap`, { recursive: true, force: true });
      rmSync(driver, { force: true });
    }
  });

  test("repeated successful stale reaps consume the configured retry bound", () => {
    const lockDir = auditLockDir(PD, INTENT, "default");
    let generation = 0;
    const installDeadGeneration = (): void => {
      const token = `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;
      generation += 1;
      stampOwner(2_000_000_000, 0, token);
    };
    installDeadGeneration();
    _setAuditLockFaultHooksForTests({
      afterSuccessfulReap: () => installDeadGeneration(),
    });
    try {
      expect(acquireAuditLock(PD, 2, 1, INTENT, "default")).toBe(false);
      expect(generation).toBe(4); // seed + exactly maxRetries+1 reaped replacements
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      _setAuditLockFaultHooksForTests(null);
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("a live, UNDER-AGE holder is NEVER robbed", () => {
    process.env.AIDLC_LOCK_STALE_MS = "600000"; // 10min threshold
    try {
      stampOwner(process.pid, 0); // alive + fresh
      // 0 retries: the reaper must REFUSE to reclaim → acquire fails.
      expect(acquireAuditLock(PD, 0, 1, INTENT, "default")).toBe(false);
    } finally {
      // The lock dir is "held" by the fake stamp; clean it.
      rmSync(auditLockDir(PD, INTENT, "default"), { recursive: true, force: true });
      delete process.env.AIDLC_LOCK_STALE_MS;
    }
  });

  test("doctor does not clear an over-age live owner protected from stale reaping", () => {
    process.env.AIDLC_LOCK_STALE_MS = "1";
    try {
      expect(
        acquireAuditLock(PD, 0, 1, undefined, undefined, false),
      ).toBe(true);
      Bun.sleepSync(5);
      expect(detectLeakedLocks(PD, true)).toEqual([]);
      expect(existsSync(auditLockDir(PD))).toBe(true);
      releaseAuditLock(PD);
    } finally {
      delete process.env.AIDLC_LOCK_STALE_MS;
    }
  });

  test("concurrent reclaimers don't double-enter (only one wins the steal-rename)", () => {
    const deadPid = 2_000_000_000;
    stampOwner(deadPid, 0);
    const lockDir = auditLockDir(PD, INTENT, "default");
    // Two back-to-back 0-retry acquires: the first reaps + acquires; the second
    // now sees a LIVE (this process) fresh lock → must FAIL, never double-enter.
    const first = acquireAuditLock(PD, 0, 1, INTENT, "default");
    const second = acquireAuditLock(PD, 0, 1, INTENT, "default");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    releaseAuditLock(PD, INTENT, "default");
  });

  test("detectLeakedLocks finds + clears a dead-owner lock for a real project", () => {
    // Build a real per-intent layout on disk so detectLeakedLocks enumerates it.
    const realPd = join(tmpdir(), `aidlc-t161-detect-${process.pid}`);
    rmSync(realPd, { recursive: true, force: true });
    const recDir = join(realPd, "aidlc", "spaces", "default", "intents", "auth-deadbeef");
    mkdirSync(recDir, { recursive: true });
    writeFileSync(join(recDir, "aidlc-state.md"), "- **Current Stage**: x\n", "utf-8");
    writeFileSync(join(realPd, "aidlc", "active-space"), "default\n", "utf-8");
    // Stamp a DEAD-owner lock on that intent's bucket.
    const lockDir = auditLockDir(realPd, "auth-deadbeef", "default");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 2_000_000_000, startedAtMs: 0 }), "utf-8");
    try {
      // clear=false → pure read, lock survives.
      const found = detectLeakedLocks(realPd, false);
      expect(found.some((l) => l.bucket === "default/auth-deadbeef" && l.reason === "dead-owner")).toBe(true);
      expect(existsSync(lockDir)).toBe(true);
      // clear=true → the leaked lock is removed loudly.
      const cleared = detectLeakedLocks(realPd, true);
      expect(cleared.length).toBeGreaterThan(0);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(realPd, { recursive: true, force: true });
    }
  });
});

describe("t161 active-directive owner lock and doctor findings", () => {
  function markerProject(): { projectDir: string; recordDir: string; state: string } {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t161-marker-"));
    const recordName = "auth-deadbeef";
    const intents = join(projectDir, "aidlc", "spaces", "default", "intents");
    const recordDir = join(intents, recordName);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n");
    writeFileSync(join(intents, "active-intent"), `${recordName}\n`);
    writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
      uuid: "deadbeef-0000-7000-8000-000000000001",
      slug: "auth",
      dirName: recordName,
      status: "in-flight",
    }])}\n`);
    const state = "- **Current Stage**: requirements-analysis\n";
    writeFileSync(join(recordDir, "aidlc-state.md"), state);
    return { projectDir, recordDir, state };
  }

  function writeMarker(projectDir: string, state: string): void {
    writeActiveDirectiveMarker(projectDir, {
      kind: "run-stage",
      stage: "requirements-analysis",
      state_sha256: stateDigest(state),
    });
  }

  test("dead stamped owners recover, fresh live owners contend, and canonical bytes stay readable", () => {
    const fixture = markerProject();
    try {
      writeMarker(fixture.projectDir, fixture.state);
      const markerPath = join(fixture.recordDir, ".aidlc-active-directive.json");
      const lockDir = join(fixture.recordDir, ".aidlc-active-directive.lock");
      const before = readFileSync(markerPath, "utf-8");
      const deadToken = randomUUID();
      mkdirSync(join(lockDir, deadToken), { recursive: true });
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
        pid: 2_000_000_000,
        startedAtMs: 0,
        reapLiveOwnerAfterStale: true,
        token: deadToken,
      }));
      writeMarker(fixture.projectDir, fixture.state);
      expect(readFileSync(markerPath, "utf-8")).not.toBe(before);
      expect(existsSync(lockDir)).toBe(false);

      const liveToken = randomUUID();
      mkdirSync(join(lockDir, liveToken), { recursive: true });
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
        reapLiveOwnerAfterStale: true,
        token: liveToken,
      }));
      const canonical = readFileSync(markerPath, "utf-8");
      expect(() => writeMarker(fixture.projectDir, fixture.state)).toThrow(ActiveDirectiveLockContendedError);
      expect(readFileSync(markerPath, "utf-8")).toBe(canonical);
    } finally {
      rmSync(fixture.projectDir, { recursive: true, force: true });
    }
  }, 10000);

  test("post-grace unstamped locks recover through one-generation tombstones while legacy debris stays manual", () => {
    const fixture = markerProject();
    const lockDir = join(fixture.recordDir, ".aidlc-active-directive.lock");
    const legacy = join(fixture.recordDir, ".aidlc-active-directive.json.transaction");
    process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS = "1";
    try {
      mkdirSync(lockDir);
      utimesSync(lockDir, new Date(0), new Date(0));
      writeFileSync(legacy, "{}\n");
      expect(detectLeakedLocks(fixture.projectDir, false)).toContainEqual(expect.objectContaining({
        kind: "active-directive",
        reason: "unstamped",
        cleared: false,
        lockDir,
      }));
      cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(fixture.projectDir, ".claude"), { recursive: true });
      cpSync(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"), join(fixture.projectDir, ".claude", "tools", "aidlc-lib.ts"));
      cpSync(join(REPO_ROOT, "core", "tools", "aidlc-utility.ts"), join(fixture.projectDir, ".claude", "tools", "aidlc-utility.ts"));
      const doctor = spawnSync(process.execPath, [
        join(fixture.projectDir, ".claude", "tools", "aidlc-utility.ts"),
        "doctor",
        "--project-dir",
        fixture.projectDir,
      ], { encoding: "utf-8" });
      const doctorOutput = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
      expect(doctorOutput).toContain("active-directive lock");
      expect(doctorOutput).toContain("unstamped) — cleared");
      expect(doctorOutput).toContain("legacy active-directive transaction");
      expect(doctorOutput).toContain("not cleared");
      const findings = detectLeakedLocks(fixture.projectDir, true);
      expect(findings).toContainEqual(expect.objectContaining({
        kind: "legacy-active-directive-transaction",
        reason: "legacy-transaction",
        cleared: false,
        lockDir: legacy,
      }));
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(legacy)).toBe(true);
      mkdirSync(lockDir);
      utimesSync(lockDir, new Date(0), new Date(0));
      expect(() => writeMarker(fixture.projectDir, fixture.state)).not.toThrow();
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      delete process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
      rmSync(fixture.projectDir, { recursive: true, force: true });
    }
  });
});

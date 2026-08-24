// covers: harness-instrument:tui-drive-setting-sources
// covers: harness-instrument:tui-drive-revision-recovery
// covers: harness-instrument:kiro-numbered-prose-answering
//
// Pins the TUI harness' setting-source isolation. Live TUI journeys drive the
// real Claude CLI, but should load only the copied project .claude settings by
// default so developer/user-level hooks cannot contaminate deterministic tests.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readAllAuditShards,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  CUSTOM_SCOPE,
  SNAPSHOT_STAGE_SLUG,
} from "../harness/custom-harness.ts";
import {
  adaptWindowsLaunch,
  fileSignalMet,
  filterConsoleOwnedWindowsProcesses,
  filterOwnedWindowsDescendants,
  filterSpawnOwnedWindowsDescendants,
  forceKillWindowsProcessesWithinDeadline,
  gridHasOption,
  gridIsApprovalGate,
  normalizeTuiCommand,
  newConsoleProcessIds,
  parsePowerShellBase64Json,
  parsePortablePath,
  pickRevisionOption,
  pickRevisionTypeSomethingOption,
  resolvePortablePathPattern,
  removeWindowsSessionDirWithRetry,
  runBoundedCommand,
  shouldForceKillWindowsChildRoot,
  winSessionDir,
} from "../harness/tui-drive.ts";
import {
  assertNoPendingTuiSessionsForProject,
  cleanupTuiProject,
  cleanupTuiProjectAfterKill,
  compileTuiRuntimeGraph,
  createKiroNumberedProseAnswerState,
  nextKiroNumberedProseAnswer,
  pendingTuiSessionsForProject,
  removeTuiProjectTreeWithRetry,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { seededRecordDir } from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const KIRO_PROTOCOL = readFileSync(
  join(
    REPO_ROOT,
    "dist",
    "kiro",
    ".kiro",
    "aidlc-common",
    "protocols",
    "stage-protocol.md",
  ),
  "utf8",
);
const KIRO_SKILL = readFileSync(
  join(REPO_ROOT, "dist", "kiro", ".kiro", "skills", "aidlc", "SKILL.md"),
  "utf8",
);

function env(settingSources?: string): NodeJS.ProcessEnv {
  return settingSources === undefined
    ? {}
    : { AIDLC_TUI_SETTING_SOURCES: settingSources };
}

describe("tui-drive setting-source isolation", () => {
  test("bare claude commands default to project-only settings", () => {
    expect(
      normalizeTuiCommand(["claude", "--dangerously-skip-permissions"], env()),
    ).toEqual([
      "claude",
      "--setting-sources",
      "project",
      "--dangerously-skip-permissions",
    ]);
  });

  test("absolute claude paths and Windows executables are normalized too", () => {
    expect(
      normalizeTuiCommand(["/opt/homebrew/bin/claude", "--resume"], env()),
    ).toEqual([
      "/opt/homebrew/bin/claude",
      "--setting-sources",
      "project",
      "--resume",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Program Files\\nodejs\\claude.exe"], env()),
    ).toEqual([
      "C:\\Program Files\\nodejs\\claude.exe",
      "--setting-sources",
      "project",
    ]);
  });

  test("Windows claude.cmd npm shims are normalized too", () => {
    expect(
      normalizeTuiCommand(["claude.cmd", "--dangerously-skip-permissions"], env()),
    ).toEqual([
      "claude.cmd",
      "--setting-sources",
      "project",
      "--dangerously-skip-permissions",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"], env()),
    ).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
      "--setting-sources",
      "project",
    ]);
  });

  test("Windows claude.ps1 npm shims are normalized too", () => {
    expect(
      normalizeTuiCommand(["claude.ps1", "--resume"], env()),
    ).toEqual([
      "claude.ps1",
      "--setting-sources",
      "project",
      "--resume",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1"], env()),
    ).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1",
      "--setting-sources",
      "project",
    ]);
  });

  test("explicit setting sources win", () => {
    expect(
      normalizeTuiCommand(
        ["claude", "--setting-sources", "user,project,local", "--resume"],
        env(),
      ),
    ).toEqual(["claude", "--setting-sources", "user,project,local", "--resume"]);

    expect(
      normalizeTuiCommand(["claude", "--setting-sources=user,project,local"], env()),
    ).toEqual(["claude", "--setting-sources=user,project,local"]);
  });

  test("environment override can customize or disable injection", () => {
    expect(
      normalizeTuiCommand(["claude"], env("project,local")),
    ).toEqual(["claude", "--setting-sources", "project,local"]);

    expect(normalizeTuiCommand(["claude"], env("default"))).toEqual(["claude"]);
    expect(normalizeTuiCommand(["claude"], env(""))).toEqual(["claude"]);
  });

  test("non-claude commands are left unchanged", () => {
    expect(
      normalizeTuiCommand(["node", "script.js", "claude"], env()),
    ).toEqual(["node", "script.js", "claude"]);
  });
});

describe("tui-drive structured Windows launch adapter", () => {
  const specialArgs = [
    "",
    "two words",
    'quote"inside',
    "a&b|c<d>e^f%g!h(i)",
    "trailing\\",
  ];

  test("keeps .exe and ordinary binaries on direct structured argv", () => {
    expect(
      adaptWindowsLaunch("C:\\Program Files\\Claude\\claude.exe", specialArgs),
    ).toEqual({
      file: "C:\\Program Files\\Claude\\claude.exe",
      args: specialArgs,
    });
    expect(adaptWindowsLaunch("custom-binary", specialArgs)).toEqual({
      file: "custom-binary",
      args: specialArgs,
    });
  });

  test("routes .ps1 through non-interactive PowerShell -File with argv intact", () => {
    expect(
      adaptWindowsLaunch(
        "C:\\Program Files\\Claude\\claude.ps1",
        specialArgs,
      ),
    ).toEqual({
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\Program Files\\Claude\\claude.ps1",
        ...specialArgs,
      ],
    });
  });

  test("routes .cmd and .bat through ComSpec with focused cmd quoting", () => {
    for (const extension of ["cmd", "bat"]) {
      const launch = adaptWindowsLaunch(
        `C:\\Program Files\\Claude\\claude.${extension}`,
        specialArgs,
        { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      );
      expect(launch).toEqual({
        file: "C:\\Windows\\System32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `"C:\\Program^ Files\\Claude\\claude.${extension} ` +
            `^^^"^^^" ^^^"two^^^ words^^^" ^^^"quote\\^^^"inside^^^" ` +
            `^^^"a^^^&b^^^|c^^^<d^^^>e^^^^f^^^%g^^^!h^^^(i^^^)^^^" ` +
            `^^^"trailing\\\\^^^""`,
        ],
        windowsVerbatimArguments: true,
      });
    }
  });
});

describe("tui-drive portable until-file paths", () => {
  test("parses POSIX, Git-Bash, drive, UNC, relative, and mixed forms structurally", () => {
    expect(parsePortablePath("/var/tmp/project/signals/*/done.txt")).toEqual({
      kind: "posix-absolute",
      root: "/",
      segments: ["var", "tmp", "project", "signals", "*", "done.txt"],
    });
    expect(
      parsePortablePath(
        "/c/Users/dev/project/signals/*/done.txt",
        "win32",
      ),
    ).toEqual({
      kind: "git-bash-absolute",
      root: "C:\\",
      segments: ["Users", "dev", "project", "signals", "*", "done.txt"],
    });
    expect(parsePortablePath("c:\\Users\\dev\\project\\signals\\*\\done.txt")).toEqual({
      kind: "drive-absolute",
      root: "C:\\",
      segments: ["Users", "dev", "project", "signals", "*", "done.txt"],
    });
    expect(parsePortablePath("\\\\server\\share\\project\\signals/*\\done.txt")).toEqual({
      kind: "unc-absolute",
      root: "\\\\server\\share\\",
      segments: ["project", "signals", "*", "done.txt"],
    });
    expect(parsePortablePath("signals\\*\\done.txt")).toEqual({
      kind: "relative",
      root: "",
      segments: ["signals", "*", "done.txt"],
    });
    expect(parsePortablePath("C:\\Users/dev\\project/signals\\*\\done.txt")).toEqual({
      kind: "drive-absolute",
      root: "C:\\",
      segments: ["Users", "dev", "project", "signals", "*", "done.txt"],
    });
    expect(parsePortablePath("/x/signals/done.txt", "posix")).toEqual({
      kind: "posix-absolute",
      root: "/",
      segments: ["x", "signals", "done.txt"],
    });
    expect(parsePortablePath("//x/share/done.txt", "posix")).toEqual({
      kind: "posix-absolute",
      root: "/",
      segments: ["x", "share", "done.txt"],
    });
  });

  test("resolves each absolute root without flattening it into a relative string", () => {
    expect(
      resolvePortablePathPattern(
        "C:\\repo",
        "signals\\*\\done.txt",
        "win32",
      ),
    ).toEqual({
      kind: "relative",
      root: "C:\\repo",
      segments: ["signals", "*", "done.txt"],
    });
    expect(
      resolvePortablePathPattern(
        "C:\\repo",
        "D:\\data\\signals\\*\\done.txt",
        "win32",
      ),
    ).toEqual({
      kind: "drive-absolute",
      root: "D:\\",
      segments: ["data", "signals", "*", "done.txt"],
    });
    expect(
      resolvePortablePathPattern(
        "C:\\repo",
        "/d/data/signals/*/done.txt",
        "win32",
      ),
    ).toEqual({
      kind: "git-bash-absolute",
      root: "D:\\",
      segments: ["data", "signals", "*", "done.txt"],
    });
    expect(
      resolvePortablePathPattern(
        "C:\\repo",
        "\\\\server\\share\\signals\\*\\done.txt",
        "win32",
      ),
    ).toEqual({
      kind: "unc-absolute",
      root: "\\\\server\\share\\",
      segments: ["signals", "*", "done.txt"],
    });
    expect(
      resolvePortablePathPattern(
        "/project",
        "/x/signals/*/done.txt",
        "posix",
      ),
    ).toEqual({
      kind: "posix-absolute",
      root: "/",
      segments: ["x", "signals", "*", "done.txt"],
    });
  });

  test("matches wildcarded forward, backslash, mixed, and native absolute paths", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-until-file-"));
    const signal = join(root, "signals", "record", "done.txt");
    try {
      mkdirSync(dirname(signal), { recursive: true });
      writeFileSync(signal, "complete\n");

      expect(fileSignalMet(root, "signals/*/done.txt")).toBe(true);
      expect(fileSignalMet(root, "signals\\*\\done.txt")).toBe(true);
      expect(fileSignalMet(root, "signals/*\\done.txt")).toBe(true);
      expect(fileSignalMet(root, join(root, "signals", "*", "done.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tui-drive bounded Windows subprocesses", () => {
  test("sanitized session-name collisions use distinct authenticated channels", () => {
    expect(winSessionDir("a/b")).not.toBe(winSessionDir("a_b"));
  });

  test("the shared sync runner enforces its wall-clock timeout", () => {
    const startedAt = Date.now();
    const result = runBoundedCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      100,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("ETIMEDOUT");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test("parent PID reuse cannot authorize children outside the recorded lifetime", () => {
    const recordedRoot = {
      pid: 4100,
      parentPid: 100,
      creationDate: "2026-08-24T08:00:00.000Z",
      commandLine: "owned-root",
    };
    const legitimateChild = {
      pid: 4101,
      parentPid: 4100,
      creationDate: "2026-08-24T08:00:01.000Z",
      commandLine: "owned-child",
    };
    const reusedRoot = {
      pid: 4100,
      parentPid: 200,
      creationDate: "2026-08-24T08:00:03.000Z",
      commandLine: "unrelated-root",
    };
    const unrelatedChild = {
      pid: 4102,
      parentPid: 4100,
      creationDate: "2026-08-24T08:00:03.100Z",
      commandLine: "unrelated-child",
    };

    expect(
      filterOwnedWindowsDescendants(
        recordedRoot,
        null,
        [legitimateChild],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual([legitimateChild]);
    expect(
      filterOwnedWindowsDescendants(
        recordedRoot,
        reusedRoot,
        [legitimateChild, unrelatedChild],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual([]);
    expect(
      filterOwnedWindowsDescendants(
        recordedRoot,
        null,
        [unrelatedChild],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual([]);
  });

  test("authoritative spawn lifetimes cover fast exits without trusting a bare PID", () => {
    const spawn = {
      pid: 4150,
      parentPid: 4100,
      startedAfter: "2026-08-24T08:00:00.000Z",
    };
    const ownedChild = {
      pid: 4151,
      parentPid: 4150,
      creationDate: "2026-08-24T08:00:00.100Z",
      commandLine: "owned-child",
    };
    const preexistingChild = {
      ...ownedChild,
      pid: 4152,
      creationDate: "2026-08-24T07:59:59.900Z",
      commandLine: "preexisting-child",
    };
    const recycledChild = {
      ...ownedChild,
      pid: 4153,
      creationDate: "2026-08-24T08:00:02.100Z",
      commandLine: "recycled-child",
    };
    const recycledRoot = {
      pid: 4150,
      parentPid: 9000,
      creationDate: "2026-08-24T08:00:02.050Z",
      commandLine: "recycled-root",
    };

    expect(
      filterSpawnOwnedWindowsDescendants(
        spawn,
        recycledRoot,
        [ownedChild, preexistingChild, recycledChild],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual({ status: "ok", value: [ownedChild] });
    expect(
      filterSpawnOwnedWindowsDescendants(
        spawn,
        {
          ...recycledRoot,
          creationDate: "2026-08-24T08:00:01.000Z",
        },
        [ownedChild],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual({
      status: "error",
      message:
        "target pid 4150 is still live or was reused inside its recorded lifetime",
    });
    expect(
      filterSpawnOwnedWindowsDescendants(
        spawn,
        null,
        [{ ...ownedChild, creationDate: "not-a-date" }],
        "2026-08-24T08:00:02.000Z",
      ),
    ).toEqual({
      status: "error",
      message:
        "cannot verify child pid 4151 of target pid 4150: invalid creation time",
    });
  });

  test("identity-less fast exits require stable ConPTY console membership", () => {
    const legitimate = {
      pid: 4201,
      parentPid: 4200,
      creationDate: "2026-08-24T08:00:00.100Z",
      commandLine: "owned-child",
    };
    const unrelated = {
      ...legitimate,
      pid: 4202,
      commandLine: "unrelated-recycled-child",
    };

    expect(
      filterConsoleOwnedWindowsProcesses(
        [4201, 4202],
        [legitimate, unrelated],
        [4201],
      ),
    ).toEqual([legitimate]);
    expect(
      filterConsoleOwnedWindowsProcesses([4201], [legitimate], []),
    ).toEqual([]);
    expect(newConsoleProcessIds([4201], [4202])).toEqual([4202]);
    expect(
      filterConsoleOwnedWindowsProcesses(
        [4202],
        [unrelated],
        [4202],
      ),
    ).toEqual([unrelated]);
  });

  test("an exited or recycled ConPTY root never regains taskkill authority", () => {
    const recorded = {
      pid: 5100,
      parentPid: 5000,
      creationDate: "2026-08-24T08:00:00.000Z",
      commandLine: "owned-child",
    };
    const recycled = {
      ...recorded,
      creationDate: "2026-08-24T08:01:00.000Z",
      commandLine: "unrelated-child",
    };

    expect(
      shouldForceKillWindowsChildRoot(undefined, recorded, recorded),
    ).toBe(true);
    expect(
      shouldForceKillWindowsChildRoot(
        "2026-08-24T08:00:30.000Z",
        recorded,
        recorded,
      ),
    ).toBe(false);
    expect(
      shouldForceKillWindowsChildRoot(undefined, recorded, recycled),
    ).toBe(false);
  });
});

describe("TUI cleanup hardening", () => {
  test("PowerShell process metadata preserves Unicode through ASCII transport", () => {
    const identity = {
      pid: 6001,
      parentPid: 6000,
      creationDate: "2026-08-26T00:00:00.000Z",
      commandLine: "node -e \"←→ ▓░ ✓✔ ❯☐☒ —\"",
    };
    const encoded = Buffer.from(
      JSON.stringify(identity),
      "utf8",
    ).toString("base64");

    expect(
      parsePowerShellBase64Json<typeof identity>(`\uFEFF${encoded}\r\n`),
    ).toEqual(identity);
  });

  test("one forced-termination deadline bounds a multi-process batch", () => {
    let now = 0;
    const attempts: Array<{ pid: number; timeoutMs: number }> = [];

    forceKillWindowsProcessesWithinDeadline(
      [{ pid: 6101 }, { pid: 6102 }, { pid: 6103 }],
      5_000,
      {
        now: () => now,
        maxAttemptMs: 5_000,
        terminate: (pid, timeoutMs) => {
          attempts.push({ pid, timeoutMs });
          now += timeoutMs;
        },
      },
    );

    expect(attempts).toEqual([{ pid: 6101, timeoutMs: 5_000 }]);
    expect(now).toBe(5_000);
  });

  test("retries transient Windows session-directory cleanup", () => {
    let removeCalls = 0;
    const waits: number[] = [];

    removeWindowsSessionDirWithRetry("C:\\temp\\tui-session", {
      attempts: 4,
      waitMs: 25,
      remove: () => {
        removeCalls++;
        if (removeCalls < 3) {
          const error = new Error("locked") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
      },
      sleep: (ms) => waits.push(ms),
    });

    expect(removeCalls).toBe(3);
    expect(waits).toEqual([25, 25]);
  });

  test("retries transient workspace cleanup", () => {
    let removeCalls = 0;
    const waits: number[] = [];

    removeTuiProjectTreeWithRetry("C:\\temp\\project", {
      attempts: 4,
      waitMs: 20,
      remove: () => {
        removeCalls++;
        if (removeCalls < 2) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      },
      sleep: (ms) => waits.push(ms),
    });

    expect(removeCalls).toBe(2);
    expect(waits).toEqual([20]);
  });

  test("cwd metadata associates a pending session with its workspace", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-session-project-"));
    const sessionsRoot = mkdtempSync(join(tmpdir(), "aidlc-session-root-"));
    const session = "pending-session";
    const sessionDir = join(sessionsRoot, "hashed-channel");
    mkdirSync(sessionDir);
    writeFileSync(
      join(sessionDir, "meta.json"),
      JSON.stringify({
        cols: 120,
        rows: 40,
        session,
        ownerToken: "owner-token",
        cwd: project,
      }),
    );
    writeFileSync(join(sessionDir, "pid"), "6201");

    try {
      expect(pendingTuiSessionsForProject(project, sessionsRoot)).toEqual([
        { name: session, recordedPid: 6201 },
      ]);
      expect(() =>
        assertNoPendingTuiSessionsForProject(project, sessionsRoot)
      ).toThrow(/pending-session/);
      expect(existsSync(project)).toBe(true);
    } finally {
      rmSync(sessionsRoot, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a failed kill leaves the workspace intact", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-kill-failure-"));
    try {
      expect(() =>
        cleanupTuiProjectAfterKill(project, "failed-session", {
          rc: 9,
          stderr: "verified process survived",
        })
      ).toThrow(
        /kill failed for session 'failed-session' \(rc=9\)[\s\S]*verified process survived/,
      );
      expect(existsSync(project)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("tui-drive revision recovery detection", () => {
  test("recognizes a numbered Approve / Request Changes approval gate", () => {
    const approvalGate = `
Approve the stage and continue?

❯ 1. Approve
  Accept the artifacts and continue.
  2. Request Changes
  Revise the artifacts before continuing.
  3. Type something.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(approvalGate)).toBe(true);
  });

  test("does not mistake a preparatory Guide / Edit / Chat menu for approval", () => {
    const preparatoryMenu = `
How would you like to continue?

❯ 1. Guide me
  Ask focused questions.
  2. Edit directly
  Open the draft.
  3. Chat about this
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(preparatoryMenu)).toBe(false);
  });

  test("does not mistake consolidated summary confirmation for approval", () => {
    const summaryConfirmation = `
Does this all look correct before I generate the artifact?

❯ 1. Looks correct
  Generate the artifact from these answers.
  2. Request changes
  Revise one or more answers before generation.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(summaryConfirmation)).toBe(false);
    expect(gridHasOption(summaryConfirmation, "Looks correct")).toBe(true);
    expect(gridHasOption(summaryConfirmation, "Approve")).toBe(false);
  });

  test("does not treat a pending multi-tab learnings tab as revision feedback", () => {
    const learningsTab = `
←  ☒ RE Gate  ☐ Learnings  ✔ Submit  →

The stage diary surfaced learning candidates. Persist any as a project-level rule?

❯ 1. [ ] None (recommended)
  These are one-off diagnostic findings for this bug.
  2. [ ] localStorage default
  Persist: prefer browser-native localStorage.
  3. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

    expect(pickRevisionOption(learningsTab)).toBeNull();
  });

  test("picks the first real revision directive from the recovery menu", () => {
    const recoveryMenu = `
What would you like to change?

❯ 1. Actually approve & continue
  I didn't mean to request changes.
  2. Narrow root cause to checkbox persistence
  Revise the analysis before advancing.
  3. Type something.
────────────────────────────────────────────────────────────────
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

    expect(pickRevisionOption(recoveryMenu)).toBe(2);
  });

  test("selects the typed-feedback path from a change-type recovery menu", () => {
    const changeTypeMenu = `
What would you like changed in the reverse-engineering artifacts?

❯ 1. Fix a specific artifact
  One or more files has an inaccuracy or omission.
  2. Add detail / depth
  The artifacts are correct but too shallow somewhere.
  3. Redo the stage
  Re-run the scan and synthesis from scratch.
  4. Type something.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(pickRevisionOption(changeTypeMenu)).toBeNull();
    expect(pickRevisionTypeSomethingOption(changeTypeMenu)).toBe(4);
  });
});

describe("Kiro numbered-prose answer classification", () => {
  test("recognizes observed guide-mode prompt phrasings", () => {
    for (const prompt of [
      "How would you like to answer these?\n1. Guide me\n2. Edit",
      "How would you like to\n  provide your answers?\n1. Guide Me\n2. Edit File",
      "How would you like to proceed?\n1. Guide Me\n2. Edit File",
    ]) {
      expect(
        nextKiroNumberedProseAnswer(
          prompt,
          createKiroNumberedProseAnswerState(),
        ),
      ).toBe("1");
    }
  });

  test("answers guide batches, summary, learnings, and approval in order", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to answer these? 1. Guide me 2. Edit 3. Chat",
        state,
      ),
    ).toBe("1");
    expect(
      nextKiroNumberedProseAnswer(
        "Q1. First question\n1. A\nQ2. Second question\n1. A",
        state,
      ),
    ).toBe("Q1: 1, Q2: 1");
    expect(
      nextKiroNumberedProseAnswer(
        "Does this all look correct?\n1. Looks correct\n2. Request changes",
        state,
      ),
    ).toBe("Looks correct");
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to proceed?\n1. Approve\n2. Request Changes",
        state,
      ),
    ).toBe("Approve");
    expect(state.learningsAnswered).toBe(1);
    expect(state.approvalsAnswered).toBe(1);
  });

  test("declines surfaced candidates without skipping the free-text channel", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "1. Keep c1\n2. Nothing to keep - discard all\nAnything to add for next time?",
        state,
      ),
    ).toBe("Nothing to keep. Nothing to add.");
    expect(state.learningsAnswered).toBe(1);
  });

  test("rejects an approval prompt combined with the unanswered learning channel", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(() =>
      nextKiroNumberedProseAnswer(
        "Anything to add for next time? Nothing to add / Add a note\n" +
          "Approval\n1. Approve\n2. Request Changes",
        state,
      )
    ).toThrow("approval before the mandatory learning response");
    expect(state.learningsAnswered).toBe(0);
    expect(state.approvalsAnswered).toBe(0);
  });

  test("ignores retained learning text after that response and answers the current approval", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note\n\n" +
          "How would you like to proceed?\n1. Approve\n2. Request Changes",
        state,
      ),
    ).toBe("Approve");
    expect(state.learningsAnswered).toBe(1);
    expect(state.approvalsAnswered).toBe(1);
  });

  test("answers one summary confirmation per checkpoint-bearing stage, not once per journey", () => {
    // Post-checkpoint-enforcement journeys present one consolidated-summary
    // confirmation per stage that ran a Q&A (observed live: reverse-engineering
    // "before I finalize", then requirements-analysis "before I generate the
    // requirements artifact"). The retained viewport still shows the earlier
    // answered prompt, so the classifier keys on the newest prompt's
    // "before I ..." tail: a repaint of the SAME checkpoint is not re-answered,
    // a LATER stage's checkpoint is.
    const state = createKiroNumberedProseAnswerState();
    const reConfirm =
      "Does this all look correct before I finalize?\n1. Looks correct\n2. Request changes";
    expect(nextKiroNumberedProseAnswer(reConfirm, state)).toBe("Looks correct");
    expect(nextKiroNumberedProseAnswer(reConfirm, state)).toBeNull();
    const raConfirm =
      `${reConfirm}\n\n` +
      "Does this all look correct before I generate the requirements artifact?\n" +
      "1. Looks correct\n2. Request changes";
    expect(nextKiroNumberedProseAnswer(raConfirm, state)).toBe("Looks correct");
    expect(nextKiroNumberedProseAnswer(raConfirm, state)).toBeNull();
    expect(state.confirmedSummaries.size).toBe(2);
  });

  test("prefers the latest summary prompt over a retained Q heading in tool output", () => {
    const state = createKiroNumberedProseAnswerState();
    const screen = [
      "Editing intent-capture-questions.md",
      "- ## Scope",
      "+ ## Q8. Scope",
      "",
      "Does this all look correct before I generate the intent artifacts?",
      "1. Looks correct",
      "2. Request changes",
    ].join("\n");
    expect(nextKiroNumberedProseAnswer(screen, state)).toBe("Looks correct");
    expect(state.answeredQuestions.size).toBe(0);
    expect(state.confirmedSummaries.size).toBe(1);
  });

  test("recognizes Kiro's Question N of M guide rendering", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "Question 1 of 8\nWhich outcome matters most?\n1. Recommended\n2. Other",
        state,
      ),
    ).toBe("Q1: 1");
    expect(state.answeredQuestions).toEqual(new Set([1]));
  });

  test("recognizes Kiro's Question N dash-rendered batches", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        [
          "Question 1 — What problem are we solving?",
          "1. Personal task management",
          "Question 2 — Who is the customer?",
          "1. Just me",
          "Question 3 — What does success look like?",
          "1. It works reliably",
        ].join("\n"),
        state,
      ),
    ).toBe("Q1: 1, Q2: 1, Q3: 1");
    expect(state.answeredQuestions).toEqual(new Set([1, 2, 3]));
  });

  test("answers an explicitly restated pending question without repainted options", () => {
    const state = createKiroNumberedProseAnswerState();
    state.answeredQuestions = new Set([2, 3, 4]);
    expect(
      nextKiroNumberedProseAnswer(
        "Saved Q2-Q4. Q1 still pending.\n" +
          "Waiting on your pick for Q1 above, then we'll do the last batch.",
        state,
      ),
    ).toBe("Q1: 1");
    expect(state.answeredQuestions).toEqual(new Set([1, 2, 3, 4]));
  });

  test("recognizes restated summary and approval choices after an unmatched reply", () => {
    const summaryState = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        'I received "go ahead", but it did not match an offered choice.\n' +
          "Does this all look correct before I generate the artifact?\n" +
          "1. Looks correct\n2. Request changes",
        summaryState,
      ),
    ).toBe("Looks correct");

    const gateState = createKiroNumberedProseAnswerState();
    gateState.learningsAnswered = 1;
    expect(
      nextKiroNumberedProseAnswer(
        'I received "go ahead", but it did not match an offered choice.\n' +
          "How would you like to proceed?\n1. Approve\n2. Request Changes",
        gateState,
      ),
    ).toBe("Approve");
  });

  test("answers an ad-hoc lettered clarification menu once, and a distinct one after it", () => {
    // A live hub that spots a contradiction between two recorded answers may
    // invent a mid-stage lettered menu (observed live: intent-capture Q3-vs-Q5
    // feature-set contradiction). The classifier answers the first option once
    // per distinct menu; a repaint of the SAME menu is not re-answered (null),
    // while a DIFFERENT clarification still gets a response.
    const state = createKiroNumberedProseAnswerState();
    const contradiction =
      "Which is correct for the first version?\n" +
      "- A. Include Add + Toggle complete + Delete (recommended)\n" +
      "- B. Include Add + Toggle complete + Delete + Edit\n" +
      "- D. Truly Add-only for the first version\n" +
      "- X. Other (please specify)";
    expect(nextKiroNumberedProseAnswer(contradiction, state)).toBe("A");
    expect(nextKiroNumberedProseAnswer(contradiction, state)).toBeNull();
    const second =
      "Which persistence approach?\n" +
      "- A. Browser localStorage\n" +
      "- B. A server with accounts";
    expect(nextKiroNumberedProseAnswer(second, state)).toBe("A");
  });

  test("accepts a surfaced assumption menu once", () => {
    const state = createKiroNumberedProseAnswerState();
    const assumptionConfirmation =
      "Assumption Confirmation:\n" +
      "1. Accept assumptions - keep these open for later stages\n" +
      "2. Convert to follow-up questions - answer these now";
    expect(nextKiroNumberedProseAnswer(assumptionConfirmation, state)).toBe(
      "Accept assumptions",
    );
    expect(
      nextKiroNumberedProseAnswer(assumptionConfirmation, state),
    ).toBeNull();
  });

  test("answers a new learning prompt when an older approval remains visible", () => {
    const state = createKiroNumberedProseAnswerState();
    state.learningsAnswered = 1;
    state.approvalsAnswered = 1;
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to proceed?\n1. Approve\n2. Request Changes\n\n" +
          "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(state.learningsAnswered).toBe(2);
    expect(state.approvalsAnswered).toBe(1);
  });
});

describe("Kiro non-matching checkpoint protocol", () => {
  test("shared protocol acknowledges the reply, restates choices, and records nothing", () => {
    expect(KIRO_PROTOCOL).toContain("### Non-matching checkpoint replies");
    expect(KIRO_PROTOCOL).toContain("acknowledge the received reply");
    expect(KIRO_PROTOCOL).toContain("state that it did not match an offered choice");
    expect(KIRO_PROTOCOL).toContain("same structured question with every valid choice");
    expect(KIRO_PROTOCOL).toContain("do not call `aidlc-orchestrate.ts report`");
    expect(KIRO_PROTOCOL).toContain("do not treat the checkpoint as resolved");
    expect(KIRO_PROTOCOL).toContain("original held gate");
  });

  test("runner repeats the rule for both summary confirmation and approval", () => {
    expect(KIRO_SKILL).toContain(
      "If the reply matches neither **Looks correct** nor **Request changes**",
    );
    expect(KIRO_SKILL).toContain(
      "If the reply matches none of them, do not report it",
    );
    expect(KIRO_SKILL.match(/say it did not match an offered choice/g)).toHaveLength(2);
  });
});

describe("tui fixture runtime graph", () => {
  test("repairs seeded Claude and Kiro workflows and remains idempotent", () => {
    for (const harness of ["claude", "kiro"] as const) {
      const projectDir = setupTuiProject({
        harness,
        withState: "state-mid-ideation.md",
        withAudit: true,
        runtimeGraph: true,
      });
      try {
        const graphPath = join(
          seededRecordDir(projectDir),
          "runtime-graph.json",
        );
        const firstGraph = readFileSync(graphPath, "utf8");
        const graph = JSON.parse(firstGraph) as {
          stages?: Array<{ stage_slug?: string }>;
        };
        expect(
          graph.stages?.some((stage) => stage.stage_slug === "feasibility"),
        ).toBe(true);

        const firstAudit = readAllAuditShards(projectDir);
        expect(firstAudit.match(/\*\*Event\*\*: WORKFLOW_STARTED/g)).toHaveLength(1);
        expect(firstAudit).toMatch(
          /\*\*Event\*\*: STAGE_STARTED[\s\S]*?\*\*Stage\*\*: feasibility/,
        );

        compileTuiRuntimeGraph(projectDir);
        expect(readFileSync(graphPath, "utf8")).toBe(firstGraph);
        expect(readAllAuditShards(projectDir)).toBe(firstAudit);
      } finally {
        cleanupTuiProject(projectDir);
      }
    }
  });

  test("resolves the active intent created by direct custom-harness creation", () => {
    const projectDir = setupTuiProject({ customHarness: true });
    try {
      const creation = spawnSync(
        process.execPath,
        [
          join(projectDir, ".claude", "tools", "aidlc-utility.ts"),
          "intent-create",
          "--scope",
          CUSTOM_SCOPE,
        ],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        },
      );
      expect(creation.status, creation.stderr).toBe(0);

      compileTuiRuntimeGraph(projectDir);
      const graph = JSON.parse(
        readFileSync(
          join(dirname(stateFilePath(projectDir)), "runtime-graph.json"),
          "utf8",
        ),
      ) as { stages?: Array<{ stage_slug?: string }> };
      expect(
        graph.stages?.some(
          (stage) => stage.stage_slug === SNAPSHOT_STAGE_SLUG,
        ),
      ).toBe(true);
    } finally {
      cleanupTuiProject(projectDir);
    }
  });
});

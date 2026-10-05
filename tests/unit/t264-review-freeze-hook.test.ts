// covers: hook:aidlc-review-freeze, file:hooks/aidlc-kiro-adapter.ts, hook:review-freeze-command, function:freshReviewReceipts, function:producesArtifactFile, function:producesArtifactUnit, audit:REVIEW_FREEZE_BLOCKED
//
// t264 - the deterministic PreToolUse enforcement of the §12a terminal-receipt
// ordering (the receipt-invalidation loop's hook half; the prose half is
// pinned by t263).
//
// The engine's completion precondition invalidates a REVIEW_COMPLETED receipt
// when a declared produces[] artifact is written after it. The freeze hook
// refuses that write BEFORE the invalidation happens, using the SAME receipt
// scan (freshReviewReceipts, shared in aidlc-lib.ts) - so the freeze window
// and the completion-refusal window cannot diverge. This test exercises:
//
//   (a) the pure decision layer (judgeFreeze + writeTargets, imported from the
//       DIST tree) - stage-level and per-unit freeze/no-freeze cases;
//   (b) the SHIPPED hook as a subprocess over a REAL audit ledger written by
//       the real aidlc-log/audit tools: allow before receipt, block after
//       READY or terminal advisory NOT-READY, release on GATE_REJECTED, allow for
//       non-produces paths, fail-open with no ledger, off-switch, and the
//       REVIEW_FREEZE_BLOCKED audit row on a genuine block;
//   (c) registration pins per harness: Claude settings.json (third entry in
//       the shared PreToolUse group), Codex emit wiring + adapter target,
//       Kiro CLI conductor fs_write registration, opencode plugin call, and
//       the Kiro IDE PreToolUse registration;
//   (d) the Kiro IDE adapter route over the same ledger: each Kiro write and
//       shell tool reaches the shared hook and a block comes back as exit 2.
//
// Mechanism = mixed: (a) is in-process import; (b) spawns the real hook and
// real CLI tools at the process boundary; (c) is text/JSON invariants.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, relative as relativePath, resolve } from "node:path";
import {
  blockReason,
  judgeFreeze,
  REVIEW_FREEZE_FALLBACK_GUIDANCE,
  reviewFreezeRecoveryGuidance,
  shellCommandAltersExecutableResolution,
  shellCommandInvocationDetails,
  shellCommandInvocations,
  writeTargets,
} from "../../dist/claude/.claude/hooks/aidlc-review-freeze.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const HOOK = join(DIST_CLAUDE, "hooks", "aidlc-review-freeze.ts");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const STATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-state.ts");

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// ---------------------------------------------------------------------------
// (a) Pure decision layer
// ---------------------------------------------------------------------------

const RA = {
  slug: "requirements-analysis",
  reviewer: "aidlc-product-lead-agent",
  produces: ["requirements", "requirements-analysis-questions"],
};
const NFR = {
  slug: "nfr-requirements",
  for_each: "unit-of-work",
  reviewer: "aidlc-architecture-reviewer-agent",
  produces: ["nfr-requirements"],
};

test("wrapper value options retain the nested executable and arguments", () => {
  for (const command of [
    "env -a git HOME=/alternate git pwn",
    "env --argv0 git HOME=/alternate git pwn",
    "env --argv0=git HOME=/alternate git pwn",
    "command env -a git HOME=/alternate git pwn",
    "exec -a ignored env HOME=/alternate git pwn",
    "command exec -a ignored env HOME=/alternate git pwn",
    "xargs -d : env HOME=/alternate git pwn",
    "xargs --delimiter : env HOME=/alternate git pwn",
    "xargs --delimiter=: env HOME=/alternate git pwn",
    "xargs --eof env HOME=/alternate git pwn",
    "xargs --eof=STOP env HOME=/alternate git pwn",
    "xargs --replace env HOME=/alternate git pwn",
    "xargs --replace=TOKEN env HOME=/alternate git pwn",
    "xargs --max-lines env HOME=/alternate git pwn",
    "xargs --max-lines=1 env HOME=/alternate git pwn",
    "xargs -L 1 env HOME=/alternate git pwn",
    "xargs --process-slot-var SLOT env HOME=/alternate git pwn",
    "xargs -J REPL env HOME=/alternate git pwn",
    "xargs -rt --max-lines env HOME=/alternate git pwn",
    "ENV.EXE HOME=/alternate GIT.EXE pwn",
    "\"C:/Program Files/Git/usr/bin/env.exe\" HOME=/alternate \"C:/Program Files/Git/cmd/git.exe\" pwn",
    String.raw`"C:\Program Files\Git\usr\bin\env.exe" HOME=/alternate "C:\Program Files\Git\cmd\git.exe" pwn`,
    "env -uHOME HOME=/alternate git pwn",
    "env -C/tmp git pwn",
    "env -agit HOME=/alternate git pwn",
    "env -i0 HOME=/alternate git pwn",
  ]) {
    expect(shellCommandInvocations(command), command).toEqual([
      { name: "git", args: ["pwn"] },
    ]);
  }
});

test("unknown wrapper options remain explicitly ambiguous", () => {
  expect(
    shellCommandInvocations(
      "xargs --future-value SLOT env HOME=/alternate git pwn",
    ),
  ).toEqual([{ name: "", args: [], ambiguous: true }]);
});

test("builtin wrappers recursively expose evaluators", () => {
  for (const command of [
    "builtin eval 'printf harmless'",
    "builtin -- eval 'printf harmless'",
    "builtin builtin -- eval 'printf harmless'",
  ]) {
    expect(shellCommandInvocations(command), command).toEqual([
      { name: "eval", args: ["printf harmless"] },
    ]);
  }
  expect(shellCommandInvocations("builtin -p eval")).toEqual([
    { name: "", args: [], ambiguous: true },
  ]);
});

test("inspection preserves executable provenance and unwraps multiplexer applets", () => {
  expect(
    shellCommandInvocationDetails(
      "command ./scratch/echo.cmd harmless",
    ),
  ).toEqual([
    {
      name: "echo",
      args: ["harmless"],
      executable: "./scratch/echo.cmd",
      launchers: ["command"],
    },
  ]);
  expect(
    shellCommandInvocationDetails("busybox env HOME=/tmp sh -c harmless"),
  ).toEqual([
    {
      name: "sh",
      args: ["-c", "harmless"],
      executable: "sh",
      launchers: ["busybox", "env"],
    },
  ]);
  expect(shellCommandInvocations("toybox rm -rf aidlc")).toEqual([
    { name: "rm", args: ["-rf", "aidlc"] },
  ]);
});

test("inspection marks altered executable lookup and data-driven mutations", () => {
  for (const command of [
    "PATH=/tmp rg",
    "env PATH=/tmp rg",
    "env PaTh=/tmp rg",
    "env PATHEXT=.CMD rg",
    "env -uPATH rg",
    "env --unset=PATH rg",
    "env -i rg",
    "env --ignore-environment rg",
  ]) {
    expect(shellCommandInvocationDetails(command), command).toEqual([
      expect.objectContaining({
        name: "rg",
        executableResolutionChanged: true,
      }),
    ]);
  }
  for (const command of [
    "PATH=/tmp; rg",
    "env -S 'PATH=/tmp rg'",
    "env --split-string='PATHEXT=.CMD rg'",
  ]) {
    expect(shellCommandAltersExecutableResolution(command), command).toBe(true);
  }
  for (const command of [
    "HOME=/tmp rg",
    "MYPATH=/tmp rg",
    "echo PATH=/tmp",
    "env --argv0 PATH rg",
  ]) {
    expect(shellCommandAltersExecutableResolution(command), command).toBe(false);
  }
  expect(shellCommandInvocationDetails("env HOME=/tmp rg")).toEqual([
    {
      name: "rg",
      args: [],
      executable: "rg",
      launchers: ["env"],
    },
  ]);
  expect(shellCommandInvocationDetails("xargs rm -rf")).toEqual([
    {
      name: "rm",
      args: ["-rf"],
      executable: "rm",
      launchers: ["xargs"],
      dataDriven: true,
      dataDrivenMutation: true,
    },
  ]);
  expect(shellCommandInvocationDetails("xargs printf '%s\\n'")).toEqual([
    {
      name: "printf",
      args: ["%s\\n"],
      executable: "printf",
      launchers: ["xargs"],
      dataDriven: true,
    },
  ]);
});

test("descriptor redirections preserve command boundaries and real operands", () => {
  for (const redirect of ["2>&1", "1>&2", "2>&-", "0<&0", "2>& 1"]) {
    expect(shellCommandInvocations(`cp source target ${redirect}`), redirect).toEqual([
      { name: "cp", args: ["source", "target"] },
    ]);
  }
  expect(
    shellCommandInvocations('cp source target 2>&1 && printf "%s" "2>&1"'),
  ).toEqual([
    { name: "cp", args: ["source", "target"] },
    { name: "printf", args: ["%s", "2>&1"] },
  ]);
  expect(shellCommandInvocations("printf value2>&1")).toEqual([
    { name: "printf", args: ["value2"] },
  ]);
  expect(shellCommandInvocations('printf "2">&1')).toEqual([
    { name: "printf", args: ["2"] },
  ]);
  expect(shellCommandInvocations(String.raw`printf x\>&1`)).toEqual([
    { name: "printf", args: ["x>"] },
    { name: "1", args: [] },
  ]);
  expect(shellCommandInvocations(String.raw`printf x\<&0`)).toEqual([
    { name: "printf", args: ["x<"] },
    { name: "0", args: [] },
  ]);
  expect(shellCommandInvocations(String.raw`printf x \>& 1>&1 cp source target`)).toEqual([
    { name: "printf", args: ["x", ">"] },
    { name: "cp", args: ["source", "target"] },
  ]);
  expect(shellCommandInvocations("bun run ''2>&1 installed.ts engine orchestrate next")).toEqual([
    { name: "bun", args: ["run", "2", "installed.ts", "engine", "orchestrate", "next"] },
  ]);
  expect(shellCommandInvocations("bun run '' installed.ts")).toEqual([
    { name: "bun", args: ["run", "", "installed.ts"] },
  ]);
});

const NONE: ReadonlySet<string> = new Set();
const ready = { stageVerdict: "READY", unitVerdicts: new Map<string, string>() };
const notReady = { stageVerdict: "NOT-READY", unitVerdicts: new Map<string, string>() };
const noReceipt = { stageVerdict: null, unitVerdicts: new Map<string, string>() };

describe("t264 (a) judgeFreeze decision table", () => {
  const raFile = "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/requirements.md";

  test("blocks a produces[] write under a fresh READY stage receipt", () => {
    const v = judgeFreeze(RA, raFile, NONE, ready);
    expect(v.block).toBe(true);
    expect(v.stage).toBe("requirements-analysis");
    expect(blockReason(v)).toContain("latest review is final");
    expect(blockReason(v)).toContain("quote it at the gate");
    expect(blockReason(v)).toContain("Request Changes");
  });

  test("blocks under a terminal NOT-READY receipt", () => {
    expect(judgeFreeze(RA, raFile, NONE, notReady).block).toBe(true);
  });

  test("never blocks with no receipt (normal stage work)", () => {
    expect(judgeFreeze(RA, raFile, NONE, noReceipt).block).toBe(false);
  });

  test("never blocks a non-produces path (diary, questions of another stage)", () => {
    const diary = "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/memory.md";
    expect(judgeFreeze(RA, diary, NONE, ready).block).toBe(false);
  });

  test("per-unit: freezes only the reviewed unit", () => {
    const u3 = "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const u4 = "/p/aidlc/spaces/default/intents/i1/construction/U04/nfr-requirements/nfr-requirements.md";
    const receipts = { stageVerdict: "READY", unitVerdicts: new Map([["U03", "READY"]]) };
    const v3 = judgeFreeze(NFR, u3, NONE, receipts);
    expect(v3.block).toBe(true);
    expect(v3.unit).toBe("U03");
    expect(blockReason(v3)).toContain('unit "U03"');
    expect(judgeFreeze(NFR, u4, NONE, receipts).block).toBe(false);
  });

  test("per-unit: a terminal NOT-READY receipt freezes that unit", () => {
    const u3 = "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const receipts = { stageVerdict: "NOT-READY", unitVerdicts: new Map([["U03", "NOT-READY"]]) };
    expect(judgeFreeze(NFR, u3, NONE, receipts).block).toBe(true);
  });

  test("a pending stale-receipt recovery freezes its exact scope like a receipt does", () => {
    // The reviewer records its review beside the artifact, never inside it, so
    // a recovery request opens no write window: the frozen bytes stay frozen
    // until the recovery verdict or a human decision.
    const raFile =
      "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/requirements.md";
    expect(
      judgeFreeze(RA, raFile, NONE, {
        stageVerdict: null,
        unitVerdicts: new Map(),
        stagePending: { recovery: true },
      }).block,
    ).toBe(true);
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stagePending: { recovery: true },
      }).block,
    ).toBe(true);
    // A pending request that is not a recovery neither freezes nor thaws by itself.
    expect(
      judgeFreeze(RA, raFile, NONE, {
        stageVerdict: null,
        unitVerdicts: new Map(),
        stagePending: { recovery: false },
      }).block,
    ).toBe(false);

    const u3 =
      "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const u4 =
      "/p/aidlc/spaces/default/intents/i1/construction/U04/nfr-requirements/nfr-requirements.md";
    const u5 =
      "/p/aidlc/spaces/default/intents/i1/construction/U05/nfr-requirements/nfr-requirements.md";
    const receipts = {
      stageVerdict: null,
      unitVerdicts: new Map([["U04", "READY"]]),
      unitPending: new Map([["U03", { recovery: true }]]),
    };
    expect(judgeFreeze(NFR, u3, NONE, receipts).block).toBe(true);
    expect(judgeFreeze(NFR, u3, NONE, receipts).unit).toBe("U03");
    expect(judgeFreeze(NFR, u4, NONE, receipts).block).toBe(true);
    expect(judgeFreeze(NFR, u5, NONE, receipts).block).toBe(false);
  });

  test("guidance failures fall back without changing the freeze decision", () => {
    const guidance = reviewFreezeRecoveryGuidance(
      "/p",
      "- [-] requirements-analysis — EXECUTE",
      "requirements-analysis",
      () => {
        throw new Error("injected helper failure");
      },
    );
    expect(guidance).toBe(REVIEW_FREEZE_FALLBACK_GUIDANCE);
    expect(blockReason(judgeFreeze(RA, raFile, NONE, ready), guidance)).toContain(
      REVIEW_FREEZE_FALLBACK_GUIDANCE,
    );
  });

  test("writeTargets: file tools and mutation-capable Bash contribute paths", () => {
    const hostPath = (value: string): string => resolve(value);
    const bashTargets = (command: string, cwd?: string): string[] =>
      writeTargets("Bash", { command }, cwd)
        .map((path) => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, ""));
    expect(writeTargets("Write", { file_path: "/a/b.md" })).toEqual(["/a/b.md"]);
    expect(writeTargets("Edit", { file_path: "/a/b.md" })).toEqual(["/a/b.md"]);
    expect(writeTargets("Read", { file_path: "/a/b.md" })).toEqual([]);
    expect(writeTargets("Bash", { command: "printf x >> /a/b.md" })).toEqual([hostPath("/a/b.md")]);
    expect(writeTargets("Bash", { command: "printf x>>/a/b.md" })).toEqual([hostPath("/a/b.md")]);
    expect(writeTargets("Bash", { command: 'printf x > "$PWD/a/b.md"' }, "/p")).toEqual([
      hostPath("/p/a/b.md"),
    ]);
    expect(writeTargets("Bash", { command: "rm /a/b.md" })).toEqual([hostPath("/a/b.md")]);
    expect(writeTargets("Bash", { command: "command rm -f /a/b.md" })).toEqual([
      hostPath("/a/b.md"),
    ]);
    expect(writeTargets("Bash", { command: "cp /a/b.md /tmp/copy" })).not.toContain(
      hostPath("/a/b.md"),
    );
    expect(
      writeTargets("Bash", { command: "cp --target-directory=/tmp /a/b.md" }),
    ).toEqual([hostPath("/tmp"), hostPath("/tmp/b.md")]);
    expect(writeTargets("Bash", { command: "cp -t /tmp /a/b.md" })).toEqual([
      hostPath("/tmp"),
      hostPath("/tmp/b.md"),
    ]);
    expect(
      writeTargets("Bash", {
        command: "cp /tmp/requirements.md /not-present/inception/requirements-analysis",
      }),
    ).toEqual([hostPath("/not-present/inception/requirements-analysis")]);
    expect(writeTargets("Bash", { command: "mv /a/b.md /tmp/moved" })).toEqual(
      expect.arrayContaining([hostPath("/a/b.md"), hostPath("/tmp/moved")]),
    );
    expect(writeTargets("Bash", { command: "install -dv /a/b /tmp/c" })).toEqual([
      hostPath("/a/b"),
      hostPath("/tmp/c"),
    ]);
    expect(writeTargets("Bash", { command: "truncate -s 1 -o /a/b.md" })).toEqual([
      hostPath("/a/b.md"),
    ]);
    expect(
      writeTargets("Bash", { command: "command truncate -s 0 /a/b.md" }),
    ).toEqual([hostPath("/a/b.md")]);
    for (const command of [
      "timeout 5 truncate -s 0 /a/b.md",
      "nice truncate -s 0 /a/b.md",
      "ionice truncate -s 0 /a/b.md",
      "stdbuf -o0 truncate -s 0 /a/b.md",
      "setsid truncate -s 0 /a/b.md",
      "sudo truncate -s 0 /a/b.md",
      "doas truncate -s 0 /a/b.md",
      "xargs truncate -s 0 /a/b.md",
      "time truncate -s 0 /a/b.md",
      "unbuffer truncate -s 0 /a/b.md",
      "env -S 'truncate -s 0 /a/b.md'",
    ]) {
      expect(writeTargets("Bash", { command }), command).toContain(hostPath("/a/b.md"));
    }
    expect(writeTargets("Bash", { command: "truncate -r /a/b.md /tmp/out" })).toEqual([
      hostPath("/tmp/out"),
    ]);
    expect(
      writeTargets("Bash", { command: "sed -i 's/x/y/' /a/b.md /tmp/c.md" }),
    ).toEqual([hostPath("/a/b.md"), hostPath("/tmp/c.md")]);
    expect(
      writeTargets("Bash", { command: "perl -pi -e 's/x/y/' /a/b.md /tmp/c.md" }),
    ).toEqual([hostPath("/a/b.md"), hostPath("/tmp/c.md")]);
    expect(
      writeTargets("Bash", { command: "find aidlc -depth -delete" }, "/p"),
    ).toEqual([hostPath("/p/aidlc")]);
    expect(
      writeTargets("Bash", { command: "find -H -delete" }, "/p"),
    ).toEqual([hostPath("/p")]);
    expect(
      writeTargets("Bash", { command: "find scratch -fprint /a/b.md" }, "/p"),
    ).toEqual([hostPath("/a/b.md")]);
    expect(
      writeTargets("Bash", { command: "find scratch -fprintf /tmp/list '%p\\n'" }, "/p"),
    ).toEqual([hostPath("/tmp/list")]);
    expect(
      writeTargets("Bash", { command: "find scratch -name '*.tmp'" }, "/p"),
    ).toEqual([]);
    expect(
      writeTargets("Bash", { command: "Remove-Item aidlc -Recurse -Force" }, "/p"),
    ).toContain(hostPath("/p/aidlc"));
    expect(
      writeTargets("Bash", { command: "Remove-Item -Path:aidlc -Recurse" }, "/p"),
    ).toContain(hostPath("/p/aidlc"));
    expect(
      writeTargets("Bash", { command: "Move-Item aidlc scratch" }, "/p"),
    ).toEqual(expect.arrayContaining([hostPath("/p/aidlc"), hostPath("/p/scratch")]));
    expect(
      writeTargets("Bash", { command: "rd /s /q aidlc" }, "/p"),
    ).toContain(hostPath("/p/aidlc"));
    expect(
      writeTargets("Bash", { command: "rsync --delete scratch/ aidlc" }, "/p"),
    ).toContain(hostPath("/p/aidlc"));
    expect(
      writeTargets("Bash", { command: "find aidlc -print0 | xargs -0 rm -rf" }, "/p"),
    ).toContain(hostPath("/p"));
    expect(writeTargets("Bash", { command: "sed -n '1p' /a/b.md" })).toEqual([]);
    expect(
      bashTargets("sed --version; cat /a/b.md"),
    ).toEqual([]);
    expect(bashTargets("cat /a/b.md")).toEqual([]);
  });

  test("writeTargets: content cmdlets bind their path, never a value passed by name (#1639)", () => {
    const read = (shell: "posix" | "powershell") => (command: string): string[] =>
      writeTargets("Bash", { command }, "/p", shell)
        .map((path) => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, ""));
    const powerShell = read("powershell");
    const posix = read("posix");
    for (const command of [
      "Set-Content -Path notes.md -Value x",
      "Set-Content -Value x notes.md",
      "Set-Content -Path:notes.md -Value:x",
      "Set-Content -Path: notes.md -Value x",
      "Set-Content -Pat notes.md -Val x",
      "'x' | Add-Content -Encoding utf8 notes.md",
      "'x' | Out-File notes.md -Encoding utf8",
      "'x' | Tee-Object notes.md",
      "'x' | Tee-Object -FilePath notes.md",
    ]) {
      expect(powerShell(command), command).toEqual(["/p/notes.md"]);
      // The POSIX reading has lost the quotes that tell a value from a
      // parameter, so it counts every value as well as the path.
      expect(posix(command), command).toContain("/p/notes.md");
    }
    expect(posix("Set-Content -Path notes.md -Value x")).toEqual(["/p/notes.md", "/p/x"]);
    // Tee-Object -Variable writes no file; with a path named it would fail.
    for (const command of [
      "Tee-Object -InputObject aidlc/a.md -Variable snapshot",
      "Get-Content aidlc/a.md | Tee-Object -Variable snapshot",
    ]) {
      expect(posix(command), command).toEqual([]);
      expect(powerShell(command), command).toEqual([]);
    }
    // Dequoted, '-Variable' reads as -Variable; PowerShell would take it as
    // the path and refuse the extra value, so nothing is written.
    expect(posix("'x' | Tee-Object '-Variable' aidlc/a.md")).toEqual([]);
    expect(posix("'x' | Tee-Object -Variable '-FilePath' aidlc/a.md")).toContain("/p/aidlc/a.md");
    // A dequoted '-Variable' that was another parameter's value hides nothing.
    for (const command of [
      "'x' | Tee-Object -InputObject '-Variable' aidlc/a.md",
      "Tee-Object aidlc/a.md -InputObject '-Variable'",
      "'x' | Tee-Object -OutVariable '-Variable' aidlc/a.md",
      "'x' | Tee-Object -Append: '-Variable' aidlc/a.md",
    ]) {
      expect(posix(command), command).toContain("/p/aidlc/a.md");
      expect(powerShell(command), command).toContain("/p/aidlc/a.md");
    }
    expect(posix("'x' | Tee-Object -OutVariable -- -Variable:aidlc/a.md")).toContain("/p/aidlc/a.md");
    // Dequoted, '-Variable:x' may be a quoted path on a drive named -Variable.
    expect(posix("'x' | Tee-Object '-Variable:aidlc/a.md'")).toContain("/p/aidlc/a.md");
    // A parameter-looking word left without a value may be a quoted path.
    expect(posix("'x' | Tee-Object '-Variable'")).toContain("/p/-Variable");
    // With the quotes known, a bound -Variable writes no file.
    expect(powerShell("'x' | Tee-Object -Variable v aidlc/a.md")).toEqual([]);
    expect(powerShell("New-Item -Path aidlc -Name a.md -ItemType File")).toEqual(["/p/aidlc/a.md"]);
    expect(posix("New-Item -Path: aidlc -Name a.md")).toContain("/p/aidlc/a.md");
    // After --, a word that looks like a parameter is a value as written.
    expect(posix("Set-Content -- -Value:notes.md")).toContain("/p/-Value:notes.md");
    expect(powerShell("Set-Content -- -Value:notes.md")).toContain("/p/-Value:notes.md");
    // A -- the reading gave to a parameter as its value still ends them.
    expect(posix("'x' | Set-Content -ErrorAction -- -Value:notes.md")).toContain("/p/-Value:notes.md");
    // Every positional value counts: a word read apart from how PowerShell
    // binds it must not move a path into the Value slot.
    for (const command of [
      "Set-Content x aidlc/a.md",
      "Set-Content a, aidlc/a.md x",
      "Set-Content a ,aidlc/a.md x",
      "'x' | Set-Content notes.md, aidlc/a.md",
      "'x' | Add-Content -Path notes.md, aidlc/a.md",
      "'x' | Set-Content -- aidlc/a.md",
      "'x' | Out-File -- aidlc/a.md",
      "Set-Content -- -Value aidlc/a.md",
      "'x' | Set-Content –Path aidlc/a.md",
      "'x' | Out-File —FilePath aidlc/a.md",
      "Set-Content -Value '-Value' aidlc/a.md",
      "Set-Content '-Value' -Path:aidlc/a.md",
      "Set-Content -Value:'' aidlc/a.md",
      "\"x\" | Out-File -OutBuffer:\"\" aidlc/a.md",
      // A parameter name ends at ( { . or [.
      "Set-Content -Path(\"aidlc/a.md\") x",
      "Set-Content -Path./aidlc/a.md x",
    ]) {
      expect(powerShell(command), command).toContain("/p/aidlc/a.md");
      expect(posix(command), command).toContain("/p/aidlc/a.md");
    }
    // A string in a group is that string.
    expect(powerShell("Set-Content -Path ('aidlc\\a.md') x")).toContain("/p/aidlc/a.md");
    // PowerShell runs neither as a write; the POSIX reading still counts them.
    for (const command of ["Set-Content -Path=aidlc/a.md x", "Out-File --FilePath:aidlc/a.md"]) {
      expect(posix(command), command).toContain("/p/aidlc/a.md");
    }
    // A parameter the reader does not know may be a switch: every value counts.
    expect(powerShell("Set-Content -Bogus q notes.md x")).toEqual(
      expect.arrayContaining(["/p/notes.md", "/p/q", "/p/x"]),
    );
    // -Pa could be -Path or -PassThru.
    expect(powerShell("Set-Content -Pa notes.md x")).toEqual(
      expect.arrayContaining(["/p/notes.md", "/p/x"]),
    );
  });

  test("writeTargets: a PowerShell command is read as PowerShell (#1639)", () => {
    const targets = (command: string): string[] =>
      writeTargets("Bash", { command }, "/p", "powershell")
        .map((path) => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, ""));
    // Backslashes are separators, not escapes, quoted or not.
    for (const command of [
      "Set-Content aidlc\\docs\\a.md x",
      "Set-Content 'aidlc\\docs\\a.md' x",
      "Set-Content \"aidlc\\docs\\a.md\" x",
      "echo x > aidlc\\docs\\a.md",
      "echo x>aidlc\\docs\\a.md",
      "'x' | Tee-Object aidlc\\docs\\a.md",
      "'x' | Out-File -FilePath aidlc\\docs\\a.md -Append",
      "Set-Content ‘aidlc\\docs\\a.md’ x",
      "Set-Content –Path aidlc\\docs\\a.md –Value x",
      "Set-Content `\n  aidlc\\docs\\a.md x",
      "Set-Content `\r\n  aidlc\\docs\\a.md x",
      "sc aidlc\\docs\\a.md x",
      "rm -r -fo aidlc\\docs\\a.md",
      "cp -Path scratch.md -Destination aidlc\\docs\\a.md",
      "git status; Set-Content aidlc\\docs\\a.md x",
      "Write-Output (Set-Content aidlc\\docs\\a.md x)",
      "\"$(Set-Content aidlc\\docs\\a.md x)\"",
      "Get-ChildItem | ForEach-Object { Remove-Item aidlc\\docs\\a.md }",
    ]) {
      expect(targets(command), command).toContain("/p/aidlc/docs/a.md");
    }
    expect(targets("Set-Content aidlc\\a.md,aidlc\\b.md -Value x")).toEqual([
      "/p/aidlc/a.md",
      "/p/aidlc/b.md",
    ]);
    expect(targets("Set-Content 'a,b.md' -Value x")).toEqual(["/p/a,b.md"]);
    expect(targets("Remove-Item -Path:aidlc\\a.md,aidlc\\b.md")).toEqual([
      "/p/aidlc/a.md",
      "/p/aidlc/b.md",
    ]);
    expect(targets("Set-Content 'it''s.md' -Value x")).toEqual(["/p/it's.md"]);
    for (const command of [
      "Set-Content a, aidlc\\a.md x",
      "'x' | Set-Content -- aidlc\\a.md",
      "'x' | Out-File -- aidlc\\a.md",
    ]) {
      expect(targets(command), command).toContain("/p/aidlc/a.md");
    }
    // A cmdlet that takes its path from the pipeline may write anywhere.
    expect(targets("Get-ChildItem aidlc | Remove-Item -Recurse")).toEqual(["/p"]);
    for (const command of [
      // An escaped dash is a value, not a parameter.
      "Set-Content -Value `-Encoding aidlc\\a.md",
      "Set-Content -Value -`Encoding aidlc\\a.md",
      // An escaped --% does not stop parsing.
      "Write-Output `--% ; Remove-Item aidlc\\a.md",
      // The command on the right of an assignment runs.
      "$null = New-Item -ItemType File aidlc\\a.md",
      "$r = Remove-Item aidlc\\a.md",
      "$x.y=Remove-Item aidlc\\a.md",
      "$" + "{x}=Remove-Item aidlc\\a.md",
      "$a[0] =Remove-Item aidlc\\a.md",
      "$a = $b = Remove-Item aidlc\\a.md",
      "$x ??= Remove-Item aidlc\\a.md",
      "$a=$b=Remove-Item aidlc\\a.md",
      "[string]$x=Remove-Item aidlc\\a.md",
      // A [ that does not close a type name is an ordinary character.
      "echo [; Set-Content aidlc\\a.md x",
      // $pwd is $PWD.
      "Set-Content $pwd\\aidlc\\a.md x",
    ]) {
      expect(targets(command), command).toContain("/p/aidlc/a.md");
    }
    // An array continues past the blanks around its commas.
    for (const command of [
      "New-Item -Path scratch, aidlc -Name a.md -ItemType File",
      "New-Item -Path scratch ,aidlc -Name a.md -ItemType File",
      "New-Item -Path scratch,`\n  aidlc -Name a.md -ItemType File",
      "New-Item -Path scratch,\n  aidlc -Name a.md -ItemType File",
    ]) {
      expect(targets(command), command).toEqual(["/p/scratch/a.md", "/p/aidlc/a.md"]);
    }
    // A pipeline path is replaced only by a path named in full.
    expect(targets("Get-Item aidlc\\a.md | Remove-Item -ErrorAction Stop")).toContain("/p");
    expect(targets("Get-ChildItem aidlc | Move-Item -Destination elsewhere")).toContain("/p");
    // Copy-Item reads what is piped to it; only its destination is written.
    expect(targets("Get-ChildItem aidlc | Copy-Item -Destination elsewhere")).toEqual(["/p/elsewhere"]);
    // A destination it cannot read leaves the pipeline's working directory.
    expect(targets("Get-ChildItem aidlc | Copy-Item -Destination $d")).toEqual(["/p"]);
    expect(targets("Get-ChildItem aidlc | Copy-Item -Dest:elsewhere")).toContain("/p");
    // A redirect target is a file name, whatever it looks like.
    expect(targets("echo hi > -notes.md")).toEqual(["/p/-notes.md"]);
    expect(targets("Write-Output a, b")).toEqual([]);
    expect(targets("$a = 1")).toEqual([]);
    // A newline after | continues the pipeline; a ; ends it.
    expect(targets("Get-ChildItem aidlc |\n  Remove-Item -Recurse")).toEqual(["/p"]);
    expect(targets("Get-ChildItem aidlc |\r\n  Remove-Item -Recurse")).toEqual(["/p"]);
    expect(targets("Get-ChildItem aidlc |\n  # all of it\n  Remove-Item -Recurse")).toEqual(["/p"]);
    expect(targets("Get-ChildItem aidlc |; Remove-Item -Recurse")).toEqual([]);
    expect(targets("Get-Item aidlc\\a.md | Set-Content -Value x")).toEqual(["/p"]);
    // Discarded output, merged streams, comments and values write nothing.
    expect(targets("'x' > $null")).toEqual([]);
    expect(targets("Write-Output x 2>&1")).toEqual([]);
    expect(targets("Write-Output x # > aidlc\\docs\\a.md")).toEqual([]);
    expect(targets("& 'C:\\tools\\aidlc.cmd' engine next")).toEqual([]);
    expect(targets("Get-Content aidlc\\docs\\a.md | Select-String x")).toEqual([]);
    // The POSIX reading of the same commands drops the backslashes.
    expect(writeTargets("Bash", { command: "Set-Content aidlc\\docs\\a.md x" }, "/p")
      .map((path) => path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "")))
      .toEqual(["/p/aidlcdocsa.md", "/p/x"]);
  });
});

// ---------------------------------------------------------------------------
// (b) The shipped hook as a subprocess over a real ledger
// ---------------------------------------------------------------------------

function projBeforeGate(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  const dir = join(
    seededRecordDir(p),
    "inception",
    "requirements-analysis",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
  writeFileSync(
    join(dir, "requirements-analysis-questions.md"),
    "# Requirements Questions\n",
  );
  return p;
}

function openGate(p: string): void {
  const env = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  const r = spawnSync(
    BUN,
    [STATE_TOOL, "gate-start", "requirements-analysis", "--project-dir", p],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`gate-start failed: ${r.stdout}${r.stderr}`);
}

function recordReview(p: string, verdict: "READY" | "NOT-READY"): void {
  const artifact = raArtifact(p);
  mkdirSync(dirname(artifact), { recursive: true });
  if (!existsSync(artifact)) {
    writeFileSync(artifact, "# Requirements\n", "utf-8");
  } else {
    const current = readFileSync(artifact, "utf-8");
    const reviewStart = current.search(/^## Review[ \t]*$/m);
    if (reviewStart !== -1) {
      writeFileSync(
        artifact,
        `${current.slice(0, reviewStart).replace(/\s+$/, "")}\n`,
        "utf-8",
      );
    }
  }
  const args = [
    LOG_TOOL,
    "review",
    "--stage",
    "requirements-analysis",
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
    "--project-dir",
    p,
  ];
  const env = {
    ...process.env,
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  const requested = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  if ((requested.status ?? -1) !== 0) {
    throw new Error(`review request failed: ${requested.stdout}${requested.stderr}`);
  }
  const { reviewFile } = JSON.parse(requested.stdout ?? "{}") as {
    reviewFile: string;
  };
  mkdirSync(dirname(join(p, reviewFile)), { recursive: true });
  writeFileSync(
    join(p, reviewFile),
    `**Verdict:** ${verdict}\n**Reviewer:** aidlc-product-lead-agent\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n`,
    "utf-8",
  );
  const completed = spawnSync(BUN, [...args, "--verdict", verdict], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  if ((completed.status ?? -1) !== 0) {
    throw new Error(
      `review completion failed: ${completed.stdout}${completed.stderr}`,
    );
  }
}

function reject(p: string): void {
  const env = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  const r = spawnSync(
    BUN,
    [STATE_TOOL, "reject", "requirements-analysis", "--feedback", "change it", "--project-dir", p],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`reject failed: ${r.stdout}${r.stderr}`);
}

function runHook(
  p: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function raArtifact(p: string): string {
  return join(seededRecordDir(p), "inception", "requirements-analysis", "requirements.md");
}

function writePayload(file: string): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file } };
}

describe("t264 (b) shipped-hook lifecycle over a real ledger", () => {
  test("allow before any receipt; block after READY; release on GATE_REJECTED; re-block after fresh READY", () => {
    const p = projBeforeGate();
    const file = raArtifact(p);

    // No receipt yet: normal stage work proceeds.
    expect(runHook(p, writePayload(file)).code).toBe(0);

    // Fresh READY receipt: the same write is refused with the gate redirect,
    // and the refusal is auditable.
    recordReview(p, "READY");
    openGate(p);
    const blocked = runHook(p, writePayload(file));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("review-freeze");
    expect(blocked.stderr).toContain(
      "If this is a reviewer suggestion, quote it at the gate",
    );
    expect(blocked.stderr).toContain(
      'When the person already said what should change for stage "requirements-analysis"',
    );
    expect(blocked.stderr).toContain("their exact text unchanged");
    expect(readAllAuditShards(p)).toContain("**Event**: REVIEW_FREEZE_BLOCKED");

    // A recorded gate rejection resets the receipt floor: the freeze lifts
    // with no manual release (the revision path is never frozen).
    reject(p);
    expect(runHook(p, writePayload(file)).code).toBe(0);

    // The re-reviewed revision freezes again - same invariant, next attempt.
    recordReview(p, "READY");
    const revise = spawnSync(
      BUN,
      [STATE_TOOL, "revise", "requirements-analysis", "--project-dir", p],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
      },
    );
    if ((revise.status ?? -1) !== 0) {
      throw new Error(`revise failed: ${revise.stdout}${revise.stderr}`);
    }
    expect(runHook(p, writePayload(file)).code).toBe(2);
  });

  test("advisory NOT-READY is terminal and freezes until the human gate", () => {
    const p = projBeforeGate();
    recordReview(p, "NOT-READY");
    openGate(p);
    expect(runHook(p, writePayload(raArtifact(p))).code).toBe(2);
  });

  test("a non-produces write under a READY receipt is untouched", () => {
    const p = projBeforeGate();
    recordReview(p, "READY");
    openGate(p);
    const diary = join(seededRecordDir(p), "inception", "requirements-analysis", "memory.md");
    expect(runHook(p, writePayload(diary)).code).toBe(0);
  });

  test("Edit and MultiEdit block like Write; Read never blocks", () => {
    const p = projBeforeGate();
    recordReview(p, "READY");
    openGate(p);
    const file = raArtifact(p);
    for (const tool of ["Edit", "MultiEdit"]) {
      expect(
        runHook(p, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file } }).code,
      ).toBe(2);
    }
    expect(
      runHook(p, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } }).code,
    ).toBe(0);
  });

  test("shell redirections to produces[] block without false-positive read operands", () => {
    const p = projBeforeGate();
    const file = raArtifact(p);
    recordReview(p, "READY");
    openGate(p);
    const rel = relative(p, file).replace(/\\/g, "/");
    for (const command of [
      `printf "change" >> ${JSON.stringify(file)}`,
      `printf "change">>${JSON.stringify(file)}`,
      `printf "change" >> "$PWD/${rel}"`,
      `cp --target-directory=${JSON.stringify(dirname(file))} /tmp/requirements.md`,
      `cp /tmp/requirements.md ${JSON.stringify(file)} 2>&1`,
      `cp /tmp/requirements.md ${JSON.stringify(file)} 2>&-`,
      `cp /tmp/requirements.md ${JSON.stringify(file)} 2>& 1`,
      `mv ${JSON.stringify(file)} /tmp/review-freeze-moved`,
      `install -dv ${JSON.stringify(file)} /tmp/review-freeze-directory`,
      `truncate -s 1 -o ${JSON.stringify(file)}`,
      `command truncate -s 0 ${JSON.stringify(file)}`,
      `sed -i 's/change/changed/' ${JSON.stringify(file)} /tmp/review-freeze-other`,
      `perl -pi -e 's/change/changed/' ${JSON.stringify(file)} /tmp/review-freeze-other`,
    ]) {
      const blocked = runHook(p, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: p,
      });
      expect(blocked.code, command).toBe(2);
      expect(blocked.stderr, command).toContain(file);
    }

    for (const command of [
      `cat ${JSON.stringify(file)}`,
      `cat ${JSON.stringify(file)} 2>&1`,
      `sed -n '1p' ${JSON.stringify(file)}`,
      `cp ${JSON.stringify(file)} /tmp/review-freeze-copy`,
      `cp ${JSON.stringify(file)} /tmp/review-freeze-copy 2>&1`,
      `cp --target-directory=/tmp ${JSON.stringify(file)}`,
      `cp /tmp/requirements.md ${JSON.stringify(
        join(p, "unrelated", "inception", "requirements-analysis"),
      )}`,
      `truncate -r ${JSON.stringify(file)} /tmp/review-freeze-output`,
      `sed --version; cat ${JSON.stringify(file)}`,
    ]) {
      expect(
        runHook(p, {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
          cwd: p,
        }).code,
        command,
      ).toBe(0);
    }
  });

  test("fail-open: empty ledger, malformed stdin, and the off-switch all allow", () => {
    const empty = createTestProject();
    tempDirs.push(empty);
    expect(runHook(empty, writePayload("/x/requirements-analysis/requirements.md")).code).toBe(0);

    const p = projBeforeGate();
    recordReview(p, "READY");
    openGate(p);
    const r = spawnSync(BUN, [HOOK], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      input: "not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: p },
      encoding: "utf-8",
    });
    expect(r.status ?? -1).toBe(0);
    expect(
      runHook(p, writePayload(raArtifact(p)), { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1" }).code,
    ).toBe(0);
  });

  test("a completed stage's artifacts are not frozen (state checkbox filter)", () => {
    // state-mid-inception has intent-capture SKIPPED and earlier ideation
    // stages completed - a write to a completed reviewer-bearing stage's
    // produces path must pass even if a stale receipt existed. Use user-stories
    // marked [x] via approve after review to prove the filter end-to-end.
    const p = projBeforeGate();
    recordReview(p, "READY");
    openGate(p);
    const env = {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    };
    const approve = spawnSync(
      BUN,
      [STATE_TOOL, "approve", "requirements-analysis", "--user-input", "Approve", "--project-dir", p],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
    );
    expect(approve.status ?? -1).toBe(0);
    // Stage now [x]: its produces paths are permanent record, not frozen.
    expect(runHook(p, writePayload(raArtifact(p))).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Registration pins per harness
// ---------------------------------------------------------------------------

describe("t264 (c) harness registration", () => {
  test("Claude settings.json wires the hook in the shared PreToolUse group", () => {
    for (const root of [
      join(REPO_ROOT, "harness", "claude"),
      join(REPO_ROOT, "dist", "claude", ".claude"),
    ]) {
      const s = JSON.parse(readFileSync(join(root, "settings.json"), "utf-8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const group = (s.hooks?.PreToolUse ?? []).find((g) =>
        (g.hooks ?? []).some((h) => (h.command ?? "").includes("hook review-freeze")),
      );
      expect(group, root).toBeDefined();
      // Shares the state-transition-guard/reviewer-scope matcher group, so the
      // hook can inspect both file writes and mutation-capable shell commands.
      expect(group?.matcher).toContain("Write");
      expect(group?.matcher).toContain("Edit");
      expect(group?.matcher).toContain("Bash");
    }
  });

  test("Codex hooks.json carries the adapter target; the adapter has the case", () => {
    const hooksJson = readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", "hooks.json"), "utf-8");
    expect(hooksJson).toContain("adapter codex review-freeze");
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "codex", "hooks", "aidlc-codex-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('case "review-freeze"');
    // Delete File / Move to are sibling mutations of the receipt exactly like
    // an Update - the fan-out must include them.
    expect(adapter.split('case "review-freeze"')[1]).toContain("Delete File|Move to");
  });

  test("Copilot's shared tool guard invokes review-freeze", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "copilot", "hooks", "aidlc-copilot-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('"aidlc-review-freeze.ts"');
    expect(adapter).toContain("mutationTargetsOf");
  });

  test("Kiro CLI registers freeze and invalidation on every writable agent", () => {
    for (const root of [
      join(REPO_ROOT, "harness", "kiro", "agents"),
      join(REPO_ROOT, "dist", "kiro", ".kiro", "agents"),
    ]) {
      const configs = readdirSync(root).filter((name) => name.endsWith(".json"));
      for (const name of configs) {
        const agent = JSON.parse(readFileSync(join(root, name), "utf-8")) as {
          tools?: string[];
          hooks?: {
            preToolUse?: Array<{ matcher?: string; command?: string }>;
            postToolUse?: Array<{ matcher?: string; command?: string }>;
          };
        };
        if (!(agent.tools ?? []).includes("fs_write")) continue;
        const pre = agent.hooks?.preToolUse ?? [];
        const post = agent.hooks?.postToolUse ?? [];
        expect(
          pre.some((h) => h.matcher === "fs_write" && h.command?.includes("review-freeze")),
          `${root}/${name}: fs_write freeze`,
        ).toBe(true);
        expect(
          pre.some((h) => h.matcher === "execute_bash" && h.command?.includes("review-freeze")),
          `${root}/${name}: execute_bash freeze`,
        ).toBe(true);
        expect(
          post.some((h) => h.matcher === "fs_write" && h.command?.includes("audit-and-sensors")),
          `${root}/${name}: fs_write invalidation feed`,
        ).toBe(true);
      }
    }
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "kiro", "hooks", "aidlc-kiro-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('target === "review-freeze"');
  });

  test("opencode plugin calls the core hook for write/edit/apply_patch", () => {
    const plugin = readFileSync(
      join(REPO_ROOT, "harness", "opencode", "plugin", "aidlc-opencode-adapter.ts"),
      "utf-8",
    );
    expect(plugin).toContain("aidlc-review-freeze.ts");
    expect(plugin).toContain("review-freeze: this write would invalidate");
  });

  test("Cursor adapter runs review-freeze in its fail-closed preToolUse guard chain", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "cursor", "hooks", "aidlc-cursor-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('file: "aidlc-review-freeze.ts"');
    expect(adapter).toContain('input: claudeShaped("PreToolUse", reviewerToolName)');
  });

  test("Kiro IDE registers review-freeze as its own PreToolUse hook", () => {
    // Kiro runs every PreToolUse hook even after an earlier one blocks, so the
    // freeze is a file of its own beside plan-approval-guard, not a branch of it.
    for (const root of [
      join(REPO_ROOT, "harness", "kiro-ide", "hooks"),
      join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks"),
    ]) {
      const manifest = JSON.parse(readFileSync(join(root, "aidlc-review-freeze.json"), "utf-8")) as {
        hooks: Array<{ trigger: string; matcher?: string; action: { command: string } }>;
      };
      expect(manifest.hooks).toHaveLength(1);
      expect(manifest.hooks[0].trigger).toBe("PreToolUse");
      // It fires for the write and shell tools the adapter forwards (t218 pins
      // that the two sets agree), not for reads.
      const matcher = new RegExp(manifest.hooks[0].matcher ?? "^$");
      expect(matcher.test("fs_write") && matcher.test("execute_bash")).toBe(true);
      expect(matcher.test("read_file")).toBe(false);
      expect(manifest.hooks[0].action.command).toEndWith(" engine adapter kiro-ide review-freeze");
    }
    expect(existsSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks", "aidlc-review-freeze.ts"))).toBe(true);
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "hooks", "aidlc-kiro-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('case "review-freeze":');
  });
});

// ---------------------------------------------------------------------------
// (d) The Kiro IDE adapter route
// ---------------------------------------------------------------------------

const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");

function runKiroIde(
  p: string,
  target: string,
  payload: Record<string, unknown>,
): { code: number; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: p,
    AIDLC_COMPILED_EXECUTABLE: "",
  };
  delete env.USER_PROMPT;
  const r = spawnSync(BUN, [join(p, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: p, session_id: "sess_t264-ide", ...payload }),
    env,
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("t264 (d) Kiro IDE adapter route", () => {
  test("Kiro write and shell tools reach the freeze; reads and other paths do not", () => {
    const p = projBeforeGate();
    cpSync(KIRO_IDE_TREE, join(p, ".kiro"), { recursive: true });
    const file = raArtifact(p);
    const write = { tool_name: "fs_write", tool_input: { path: file, text: "# Changed\n" } };
    expect(runKiroIde(p, "review-freeze", write).code).toBe(0);
    recordReview(p, "READY");
    openGate(p);
    for (const call of [
      write,
      { tool_name: "str_replace", tool_input: { path: file, oldStr: "# Requirements", newStr: "# Changed" } },
      { tool_name: "fs_append", tool_input: { path: file, text: "more\n" } },
      { tool_name: "delete_file", tool_input: { explanation: "remove it", targetFile: file } },
      { tool_name: "execute_bash", tool_input: { command: `echo changed > '${file}'` } },
    ]) {
      const r = runKiroIde(p, "review-freeze", call);
      expect(r.code, call.tool_name).toBe(2);
      expect(r.stderr, call.tool_name).toContain("review-freeze");
    }
    // A relative redirect resolves from the shell call's own cwd.
    const relative = runKiroIde(p, "review-freeze", {
      tool_name: "execute_bash",
      tool_input: { command: "echo changed > requirements.md", cwd: dirname(file) },
    });
    expect(relative.code).toBe(2);
    expect(relative.stderr).toContain("review-freeze");
    // So does one after a literal cd or pushd, from wherever that leaves the shell.
    const reviewedDir = relativePath(p, dirname(file));
    for (const command of [
      `cd '${reviewedDir}' && echo changed > requirements.md`,
      `pushd '${dirname(reviewedDir)}' && echo changed > '${basename(dirname(file))}/requirements.md'`,
    ]) {
      const r = runKiroIde(p, "review-freeze", { tool_name: "execute_bash", tool_input: { command, cwd: p } });
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toContain("review-freeze");
    }
    expect(runKiroIde(p, "review-freeze", { tool_name: "read_file", tool_input: { path: file } }).code).toBe(0);
    expect(runKiroIde(p, "review-freeze", {
      tool_name: "fs_write",
      tool_input: { path: join(dirname(file), "notes.md"), text: "x" },
    }).code).toBe(0);
  });
});

// covers: hook:aidlc-review-freeze, hook:review-freeze-command, function:freshReviewReceipts, function:producesArtifactFile, function:producesArtifactUnit, audit:REVIEW_FREEZE_BLOCKED
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
//       the deliberate Kiro IDE absence.
//
// Mechanism = mixed: (a) is in-process import; (b) spawns the real hook and
// real CLI tools at the process boundary; (c) is text/JSON invariants.

import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

setDefaultTimeout(30_000);

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

  test("only a validated pending recovery request suspends its exact scope", () => {
    const raFile =
      "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/requirements.md";
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stageStale: true,
        stagePending: { recovery: true, suspensionActive: true },
      }).block,
    ).toBe(false);
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stagePending: { recovery: true, suspensionActive: true },
      }).block,
    ).toBe(true);
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stageStale: true,
        sourceStale: false,
        newestSourceUnit: null,
        stagePending: {
          recovery: true,
          suspensionActive: true,
          recoveryCause: "source",
        },
      }).block,
    ).toBe(true);
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stageStale: true,
        sourceStale: true,
        newestSourceUnit: null,
        stagePending: {
          recovery: true,
          suspensionActive: true,
          recoveryCause: "source",
        },
      }).block,
    ).toBe(false);
    expect(
      judgeFreeze(RA, raFile, NONE, {
        ...ready,
        stageStale: true,
        stagePending: { recovery: false, suspensionActive: false },
      }).block,
    ).toBe(true);

    const u3 =
      "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const u4 =
      "/p/aidlc/spaces/default/intents/i1/construction/U04/nfr-requirements/nfr-requirements.md";
    const receipts = {
      stageVerdict: null,
      unitVerdicts: new Map([
        ["U03", "READY"],
        ["U04", "READY"],
      ]),
      unitStale: new Set(["U03"]),
      unitPending: new Map([
        ["U03", { recovery: true, suspensionActive: true }],
      ]),
    };
    expect(judgeFreeze(NFR, u3, NONE, receipts).block).toBe(false);
    expect(judgeFreeze(NFR, u4, NONE, receipts).block).toBe(true);
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
      writeTargets("Bash", { command: "sed --version; cat /a/b.md" }),
    ).toEqual([]);
    expect(writeTargets("Bash", { command: "cat /a/b.md" })).toEqual([]);
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
    { encoding: "utf-8", env },
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
  const requested = spawnSync(BUN, args, { encoding: "utf-8", env });
  if ((requested.status ?? -1) !== 0) {
    throw new Error(`review request failed: ${requested.stdout}${requested.stderr}`);
  }
  appendFileSync(
    artifact,
    `\n## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** aidlc-product-lead-agent\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n`,
    "utf-8",
  );
  const completed = spawnSync(BUN, [...args, "--verdict", verdict], {
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
    { encoding: "utf-8", env },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`reject failed: ${r.stdout}${r.stderr}`);
}

function runHook(
  p: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [HOOK], {
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
      "tell me what should change and I'll record your Request Changes decision",
    );
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
      `sed -n '1p' ${JSON.stringify(file)}`,
      `cp ${JSON.stringify(file)} /tmp/review-freeze-copy`,
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
      { encoding: "utf-8", env },
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
        (g.hooks ?? []).some((h) => (h.command ?? "").includes("aidlc-review-freeze.ts")),
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
    expect(hooksJson).toContain("aidlc-codex-adapter.ts review-freeze");
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

  test("Kiro IDE ships the hook body but NO registration (prose-only harness)", () => {
    // The body lands via the whole-dir hooks copy; no .kiro.hook wiring file
    // consumes it (PreToolUse tool inputs are not uniformly available there).
    expect(existsSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks", "aidlc-review-freeze.ts"))).toBe(true);
    expect(
      existsSync(join(REPO_ROOT, "harness", "kiro-ide", "hooks", "aidlc-review-freeze.kiro.hook")),
    ).toBe(false);
    const ideConductor = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "agents", "aidlc.md"),
      "utf-8",
    );
    expect(ideConductor).not.toContain("review-freeze");
    for (const name of readdirSync(join(REPO_ROOT, "harness", "kiro-ide", "agents"))) {
      if (!name.endsWith("-agent.md")) continue;
      expect(
        readFileSync(join(REPO_ROOT, "harness", "kiro-ide", "agents", name), "utf-8"),
        name,
      ).not.toContain("review-freeze");
    }
  });
});

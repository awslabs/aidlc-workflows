// covers: function:inspectContinuationCursor, function:advanceContinuationCursor, subcommand:aidlc-orchestrate:continue

import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const projects: string[] = [];

const HARNESSES = [
  { name: "claude", dir: ".claude" },
  { name: "codex", dir: ".codex" },
  { name: "copilot", dir: ".aidlc" },
  { name: "cursor", dir: ".cursor" },
  { name: "kiro", dir: ".kiro" },
  { name: "kiro-ide", dir: ".kiro" },
  { name: "opencode", dir: ".aidlc" },
] as const;

type Harness = (typeof HARNESSES)[number];
type Directive = {
  kind: string;
  continue_token?: string;
  message?: string;
};

interface InstalledProject {
  dir: string;
  harness: Harness;
  tool: string;
  markerPath: string;
}

function installHarness(proj: string, harness: Harness): string {
  const destination = join(proj, harness.dir);
  rmSync(destination, { recursive: true, force: true });
  cpSync(join(REPO_ROOT, "dist", harness.name, harness.dir), destination, {
    recursive: true,
  });
  cpSync(
    join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"),
    join(destination, "tools", "aidlc-lib.ts"),
  );
  cpSync(
    join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts"),
    join(destination, "tools", "aidlc-orchestrate.ts"),
  );
  return join(destination, "tools", "aidlc-orchestrate.ts");
}

function project(
  harness: Harness,
  options: { withState?: boolean } = {},
): InstalledProject {
  const withState = options.withState ?? true;
  const dir = setupIntegrationProject(
    withState
      ? { withState: "state-brownfield-feature.md" }
      : { noAidlcDocs: true },
  );
  projects.push(dir);
  const tool = installHarness(dir, harness);
  const org = join(
    dir,
    "aidlc",
    "spaces",
    "default",
    "memory",
    "org.md",
  );
  writeFileSync(
    org,
    Array.from(
      { length: 180 },
      (_, i) => `## Cursor ${i}\n\n${"x".repeat(320)}\n\n`,
    ).join(""),
    "utf-8",
  );
  return {
    dir,
    harness,
    tool,
    markerPath: withState
      ? join(seededRecordDir(dir), ".aidlc-active-directive.json")
      : join(
          dir,
          "aidlc",
          "spaces",
          "default",
          "intents",
          ".aidlc-active-directive.json",
        ),
  };
}

afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, 30000);

function command(
  installed: InstalledProject,
  verb: "next" | "continue",
  arg?: string | string[],
): string[] {
  return [
    BUN,
    installed.tool,
    verb,
    ...(verb === "continue"
      ? [typeof arg === "string" ? arg : ""]
      : Array.isArray(arg)
        ? arg
        : []),
    "--project-dir",
    installed.dir,
  ];
}

function invoke(
  installed: InstalledProject,
  verb: "next" | "continue",
  arg?: string | string[],
  env: Record<string, string> = {},
): { directive: Directive; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(command(installed, verb, arg), {
    cwd: installed.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = proc.stdout.toString().trim();
  const stderr = proc.stderr.toString();
  expect(proc.exitCode, stderr).toBe(0);
  return {
    directive: JSON.parse(stdout) as Directive,
    stdout,
    stderr,
  };
}

async function invokeAsync(
  installed: InstalledProject,
  verb: "next" | "continue",
  arg?: string,
  env: Record<string, string> = {},
): Promise<{ code: number; directive: Directive; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command(installed, verb, arg), {
    cwd: installed.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    code,
    directive: JSON.parse(stdout.trim()) as Directive,
    stdout,
    stderr,
  };
}

function markerPath(proj: InstalledProject): string {
  return proj.markerPath;
}

function marker(proj: InstalledProject): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPath(proj), "utf-8")) as Record<
    string,
    unknown
  >;
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

function isStale(directive: Directive): boolean {
  return directive.kind === "error" &&
    directive.message?.includes("no longer current") === true;
}

function assertMarkerMatchesDirective(
  installed: InstalledProject,
  directive: Directive,
): void {
  const value = marker(installed);
  expect(value.kind).toBe(directive.kind);
  if (directive.kind === "load-steering") {
    expect(value.continue_token_sha256).toBe(
      tokenSha256(directive.continue_token ?? ""),
    );
  } else {
    expect(value).not.toHaveProperty("continue_token");
    expect(value).not.toHaveProperty("continue_token_sha256");
  }
}

function makeCopilotOwned(installed: InstalledProject): void {
  const value = marker(installed);
  const stateSha256 = String(value.state_sha256);
  value.owner_session = "cursor-owner";
  value.owner_epoch = 1;
  value.delivery = "delivered";
  value.needs_rehydrate = false;
  value.active_attempt = {
    id: "seed-next",
    command_kind: "next",
    command_sha256: stateSha256,
    issued_state_sha256: stateSha256,
    session_id: "cursor-owner",
    owner_epoch: 1,
    context_epoch: value.context_epoch,
    status: "settled",
  };
  writeFileSync(
    markerPath(installed),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf-8",
  );
}

describe("t283 engine-owned continuation cursor", () => {
  test("pre-state tokens use the bare-space cursor and have one race winner", async () => {
    const installed = project(HARNESSES[0], { withState: false });
    const first = invoke(installed, "next", [
      "--stage",
      "requirements-analysis",
      "--scope",
      "feature",
    ]).directive;
    expect(first.kind).toBe("load-steering");
    expect(marker(installed)).toMatchObject({
      version: 2,
      state_present: false,
      intent_uuid: null,
      cursor_harness: "claude",
    });
    const token = first.continue_token ?? "";

    const results = await Promise.all([
      invokeAsync(installed, "continue", token),
      invokeAsync(installed, "continue", token),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.filter((result) => result.directive.kind !== "error"))
      .toHaveLength(1);
    expect(results.filter((result) => isStale(result.directive))).toHaveLength(
      1,
    );
  });

  test("all shipped harnesses consume one current token exactly once", () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      expect(first.kind, harness.name).toBe("load-steering");
      const token = first.continue_token ?? "";

      const once = invoke(installed, "continue", token).directive;
      const twice = invoke(installed, "continue", token).directive;

      expect(once.kind, harness.name).not.toBe("error");
      expect(isStale(twice), harness.name).toBe(true);
      expect(marker(installed).cursor_harness, harness.name).toBe(harness.name);
      expect(marker(installed).needs_rehydrate, harness.name).toBe(false);
      assertMarkerMatchesDirective(installed, once);
    }
  }, 60000);

  test("two real processes racing one token have exactly one winner on every harness", async () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const beforeRevision = Number(marker(installed).revision);

      const results = await Promise.all([
        invokeAsync(installed, "continue", token),
        invokeAsync(installed, "continue", token),
      ]);

      expect(results.map((result) => result.code), harness.name).toEqual([0, 0]);
      expect(
        results.filter((result) => result.directive.kind !== "error"),
        harness.name,
      ).toHaveLength(1);
      expect(
        results.filter((result) => isStale(result.directive)),
        harness.name,
      ).toHaveLength(1);
      expect(marker(installed).revision, harness.name).toBe(beforeRevision + 1);
      expect(marker(installed).continue_token_sha256, harness.name).not.toBe(
        tokenSha256(token),
      );
    }
  }, 60000);

  test("Copilot session-owned markers use the same one-winner cursor", async () => {
    const harness = HARNESSES.find((entry) => entry.name === "copilot")!;
    const installed = project(harness);
    const first = invoke(installed, "next").directive;
    makeCopilotOwned(installed);
    const token = first.continue_token ?? "";

    const results = await Promise.all([
      invokeAsync(installed, "continue", token),
      invokeAsync(installed, "continue", token),
    ]);

    expect(results.filter((result) => result.directive.kind !== "error"))
      .toHaveLength(1);
    expect(results.filter((result) => isStale(result.directive))).toHaveLength(
      1,
    );
    expect(marker(installed).owner_session).toBe("cursor-owner");
  });

  test("every delivered token advances once and final run-stage is tokenless", () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      let directive = invoke(installed, "next").directive;
      let consumed = 0;

      while (directive.kind === "load-steering") {
        const token = directive.continue_token ?? "";
        const successor = invoke(installed, "continue", token).directive;
        const replay = invoke(installed, "continue", token).directive;
        expect(successor.kind, harness.name).not.toBe("error");
        expect(isStale(replay), harness.name).toBe(true);
        directive = successor;
        consumed += 1;
        expect(consumed, harness.name).toBeLessThan(100);
      }

      expect(directive.kind, harness.name).toBe("run-stage");
      expect(marker(installed).kind, harness.name).toBe("run-stage");
      expect(marker(installed), harness.name).not.toHaveProperty(
        "continue_token",
      );
      expect(marker(installed), harness.name).not.toHaveProperty(
        "continue_token_sha256",
      );
    }
  }, 60000);

  test("missing, malformed, oversized, v1, legacy, and migrated markers recover once", async () => {
    const harness = HARNESSES[0];
    for (
      const shape of [
        "missing",
        "malformed",
        "oversized",
        "v1",
        "legacy-v2",
        "migrated-harness",
      ] as const
    ) {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const current = marker(installed);

      if (shape === "missing") rmSync(markerPath(installed));
      if (shape === "malformed") {
        writeFileSync(markerPath(installed), "{bad-json\n", "utf-8");
      }
      if (shape === "oversized") {
        writeFileSync(
          markerPath(installed),
          `{"padding":"${"x".repeat(80 * 1024)}"}\n`,
          "utf-8",
        );
      }
      if (shape === "v1") {
        writeFileSync(
          markerPath(installed),
          `${JSON.stringify({
            version: 1,
            stage: current.stage,
            state_sha256: current.state_sha256,
          })}\n`,
          "utf-8",
        );
      }
      if (shape === "legacy-v2") {
        delete current.cursor_harness;
        writeFileSync(
          markerPath(installed),
          `${JSON.stringify(current, null, 2)}\n`,
          "utf-8",
        );
      }
      if (shape === "migrated-harness") {
        current.cursor_harness = "codex";
        writeFileSync(
          markerPath(installed),
          `${JSON.stringify(current, null, 2)}\n`,
          "utf-8",
        );
      }

      const results = await Promise.all([
        invokeAsync(installed, "continue", token),
        invokeAsync(installed, "continue", token),
      ]);
      expect(
        results.filter((result) => result.directive.kind !== "error"),
        shape,
      ).toHaveLength(1);
      expect(
        results.filter((result) => isStale(result.directive)),
        shape,
      ).toHaveLength(1);
      expect(marker(installed).cursor_harness, shape).toBe("claude");
    }
  }, 60000);

  test("fresh next and continue serialize in both lock orders", async () => {
    const harness = HARNESSES[0];

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const beforeRevision = Number(marker(installed).revision);
      const continueResult = invoke(installed, "continue", token);
      const nextResult = invoke(installed, "next");

      expect(continueResult.directive.kind).not.toBe("error");
      expect(nextResult.directive.kind).toBe("load-steering");
      expect(marker(installed).revision).toBe(beforeRevision + 2);
      assertMarkerMatchesDirective(installed, nextResult.directive);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const beforeRevision = Number(marker(installed).revision);
      const nextResult = invoke(installed, "next");
      const continueResult = invoke(installed, "continue", token);

      expect(nextResult.directive.kind).toBe("load-steering");
      expect(nextResult.directive.continue_token).toBe(token);
      expect(continueResult.directive.kind).not.toBe("error");
      expect(marker(installed).revision).toBe(beforeRevision + 2);
      assertMarkerMatchesDirective(installed, continueResult.directive);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const lockDir = join(
        seededRecordDir(installed.dir),
        ".aidlc-active-directive.lock",
      );
      const lockToken = randomUUID();
      mkdirSync(join(lockDir, lockToken), { recursive: true });
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
          reapLiveOwnerAfterStale: true,
          token: lockToken,
        }),
      );

      // The mixed-process race above proves a pre-lock validation is checked
      // again after acquisition. Here a real waiter survives a live hold and
      // succeeds after the owner releases within the bounded retry window.
      const continued = invokeAsync(installed, "continue", token);
      await Bun.sleep(100);
      rmSync(lockDir, { recursive: true, force: true });
      const result = await continued;

      expect(result.code, result.stderr).toBe(0);
      expect(result.directive.kind).not.toBe("error");
      assertMarkerMatchesDirective(installed, result.directive);
    }
  }, 30000);

  test("fresh next emits no work directive when cursor reset publication contends", () => {
    const installed = project(HARNESSES[0]);
    invoke(installed, "next");
    const before = readFileSync(markerPath(installed), "utf-8");
    const lockDir = join(
      seededRecordDir(installed.dir),
      ".aidlc-active-directive.lock",
    );
    const token = randomUUID();
    mkdirSync(join(lockDir, token), { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        startedAtMs: Math.floor(performance.timeOrigin + performance.now()),
        reapLiveOwnerAfterStale: true,
        token,
      }),
    );

    const blocked = invoke(installed, "next").directive;

    expect(blocked.kind).toBe("error");
    expect(blocked.message).toContain("no work directive was issued");
    expect(blocked.message).toContain("Retry the command");
    expect(blocked.message).not.toContain("Retry `next`");
    expect(readFileSync(markerPath(installed), "utf-8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("crash boundaries preserve retry cardinality without production test seams", () => {
    const harness = HARNESSES[0];

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const before = readFileSync(markerPath(installed), "utf-8");
      const lockDir = join(
        seededRecordDir(installed.dir),
        ".aidlc-active-directive.lock",
      );
      const lockToken = randomUUID();
      mkdirSync(join(lockDir, lockToken), { recursive: true });
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 2_000_000_000,
          startedAtMs: 0,
          reapLiveOwnerAfterStale: true,
          token: lockToken,
        }),
      );
      expect(readFileSync(markerPath(installed), "utf-8")).toBe(before);
      const retried = invoke(installed, "continue", token).directive;
      expect(retried.kind).not.toBe("error");
      expect(existsSync(lockDir)).toBe(false);
      expect(isStale(invoke(installed, "continue", token).directive)).toBe(true);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const token = first.continue_token ?? "";
      const before = readFileSync(markerPath(installed), "utf-8");
      const roFd = openSync(markerPath(installed), "r");
      const failed = (() => {
        try {
          return Bun.spawnSync(command(installed, "continue", token), {
            cwd: installed.dir,
            stdout: roFd,
            stderr: "pipe",
          });
        } finally {
          closeSync(roFd);
        }
      })();

      expect(failed.exitCode).not.toBe(0);
      expect(readFileSync(markerPath(installed), "utf-8")).not.toBe(before);
      expect(isStale(invoke(installed, "continue", token).directive)).toBe(true);
      expect(invoke(installed, "next").directive.kind).toBe("load-steering");
    }
  }, 30000);
});

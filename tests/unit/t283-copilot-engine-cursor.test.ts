// covers: function:inspectContinuationCursor, function:advanceContinuationCursor, subcommand:aidlc-orchestrate:continue
//
// The engine-owned continuation cursor under the receipt transport. A
// load-steering part carries an 8-character receipt; `continue <receipt>` that
// matches the marker's current part advances it exactly once (one winner under
// a race). Every other `continue` (replayed, forged, raced-and-lost, after
// run-stage) is answered as a bare `next` would be: the current issued step,
// never an error directive.

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
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{8}$/;
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
  part?: number;
  parts?: number;
  receipt?: string;
  next?: string;
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
  // Well past the transport cap, so every delivery here is chunked.
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
      ? join(seededRecordDir(dir), ".aidlc-engine/active-directive.json")
      : join(
          dir,
          "aidlc",
          "spaces",
          "default",
          "intents",
          ".aidlc-engine/active-directive.json",
        ),
  };
}

// Removing every staged project can exceed bun's hook default under load.
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, 120_000);

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

function receiptSha256(receipt: string): string {
  return createHash("sha256").update(receipt, "utf-8").digest("hex");
}

function continueCommand(harness: Harness, receipt: string): string {
  return `bun ${harness.dir}/tools/aidlc-orchestrate.ts continue ${receipt}`;
}

// A `continue` the engine could not honour: answered as a bare `next`, which in
// a mid-delivery project is a restart at part 1 (never an error directive).
function isRestart(directive: Directive): boolean {
  return directive.kind === "load-steering" && directive.part === 1;
}

function isWorkDirective(directive: Directive): boolean {
  return directive.kind === "load-steering" || directive.kind === "run-stage";
}

function assertMarkerMatchesDirective(
  installed: InstalledProject,
  directive: Directive,
): void {
  const value = marker(installed);
  expect(value.kind).toBe(directive.kind);
  if (directive.kind === "load-steering") {
    expect(value.part).toBe(directive.part);
    expect(value.continue_token).toBe(directive.receipt);
    expect(value.continue_token_sha256).toBe(
      receiptSha256(directive.receipt ?? ""),
    );
  } else {
    expect(value).not.toHaveProperty("continue_token");
    expect(value).not.toHaveProperty("continue_token_sha256");
  }
}

// Race two real processes on one receipt. At least one advances to part
// `part + 1`; nobody is answered with an error. Callers pin the exact shape.
async function raceReceipt(
  installed: InstalledProject,
  directive: Directive,
  label: string,
): Promise<Array<{ code: number; directive: Directive; stdout: string }>> {
  const receipt = directive.receipt ?? "";
  expect(receipt, label).toMatch(RECEIPT_PATTERN);
  const results = await Promise.all([
    invokeAsync(installed, "continue", receipt),
    invokeAsync(installed, "continue", receipt),
  ]);
  expect(results.map((result) => result.code), label).toEqual([0, 0]);
  expect(
    results.filter((result) => result.directive.kind === "error"),
    label,
  ).toHaveLength(0);
  expect(
    results.every((result) => isWorkDirective(result.directive)),
    label,
  ).toBe(true);
  expect(
    results.some((result) => result.directive.part === (directive.part ?? 0) + 1),
    label,
  ).toBe(true);
  return results;
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
  // Old property: one race winner, one "no longer current" error. New property:
  // one race winner (part 2); the loser is re-sent part 1, never an error.
  test("pre-state receipts use the bare-space cursor and have one race winner", async () => {
    const installed = project(HARNESSES[0], { withState: false });
    const first = invoke(installed, "next", [
      "--stage",
      "requirements-analysis",
      "--scope",
      "feature",
    ]).directive;
    expect(first.kind).toBe("load-steering");
    expect(first.part).toBe(1);
    expect(marker(installed)).toMatchObject({
      version: 2,
      state_present: false,
      intent_uuid: null,
      cursor_harness: "claude",
      continue_token: first.receipt,
    });

    const results = await raceReceipt(installed, first, "pre-state");
    // Without a state file the loser cannot read the winner's successor back
    // from the marker, so it is answered as a bare stateless `next` (part 1);
    // every racer that did advance holds the same part-2 receipt.
    const advanced = results.filter((result) => result.directive.part === 2);
    expect(advanced.length).toBeGreaterThanOrEqual(1);
    expect(new Set(advanced.map((result) => result.directive.receipt)).size).toBe(1);
    for (const result of results) {
      if (result.directive.part !== 2) {
        expect(isRestart(result.directive)).toBe(true);
        expect(result.directive.receipt).toBe(first.receipt);
      }
    }
    const value = marker(installed);
    expect(value.cursor_harness).toBe("claude");
    expect(value.state_present).toBe(false);
    expect(results.map((result) => result.directive.receipt)).toContain(
      String(value.continue_token),
    );
  });

  // Old property: the first use of a token advanced, the second errored. New
  // property: the first use advances to part 2; the second is answered as a
  // bare `next` (a restart at part 1 with the same receipt) on every harness.
  test("all shipped harnesses advance one current receipt exactly once", () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      expect(first.kind, harness.name).toBe("load-steering");
      expect(first.part, harness.name).toBe(1);
      expect(first.receipt, harness.name).toMatch(RECEIPT_PATTERN);
      expect(first.next, harness.name).toBe(
        continueCommand(harness, first.receipt ?? ""),
      );
      const receipt = first.receipt ?? "";

      const once = invoke(installed, "continue", receipt).directive;
      const twice = invoke(installed, "continue", receipt).directive;

      expect(once.kind, harness.name).toBe("load-steering");
      expect(once.part, harness.name).toBe(2);
      expect(once.receipt, harness.name).not.toBe(receipt);
      expect(isRestart(twice), harness.name).toBe(true);
      expect(twice.receipt, harness.name).toBe(receipt);
      expect(marker(installed).cursor_harness, harness.name).toBe(harness.name);
      expect(marker(installed).needs_rehydrate, harness.name).toBe(false);
      assertMarkerMatchesDirective(installed, twice);
    }
  }, 60000);

  // Old property: exactly one winner, one stale error, marker advanced once. New
  // property: both racers receive the same part 2 (the loser reads the winner's
  // successor from the marker), never an error, and the marker advanced once.
  test("two real processes racing one receipt have exactly one winner on every harness", async () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const beforeRevision = Number(marker(installed).revision);

      const results = await raceReceipt(installed, first, harness.name);

      if (harness.name === "kiro-ide") {
        // Kiro IDE never re-answers from the marker (its legacy Plan Approval
        // choices are rotated by publication), so the loser there is answered
        // as a bare `next` that restarts delivery at part 1.
        expect(
          results.map((result) => result.directive.part ?? 0).sort((a, b) => a - b),
          harness.name,
        ).toEqual([1, 2]);
        const kiroMarker = marker(installed);
        expect(kiroMarker.kind, harness.name).toBe("load-steering");
        expect(
          results.map((result) => result.directive.receipt),
          harness.name,
        ).toContain(String(kiroMarker.continue_token));
        continue;
      }
      expect(
        results.map((result) => result.directive.part),
        harness.name,
      ).toEqual([2, 2]);
      expect(results[0].stdout, harness.name).toBe(results[1].stdout);
      const value = marker(installed);
      expect(value.kind, harness.name).toBe("load-steering");
      expect(value.part, harness.name).toBe(2);
      expect(Number(value.revision), harness.name).toBe(beforeRevision + 1);
      expect(value.continue_token, harness.name).toBe(results[0].directive.receipt);
      expect(value.continue_token_sha256, harness.name).toBe(
        receiptSha256(String(value.continue_token)),
      );
    }
  }, 60000);

  // Old property: one winner, one stale error, owner preserved. New property:
  // one winner, the loser re-sent part 1, and the Copilot owner preserved.
  test("Copilot session-owned markers use the same one-winner cursor", async () => {
    const harness = HARNESSES.find((entry) => entry.name === "copilot")!;
    const installed = project(harness);
    const first = invoke(installed, "next").directive;
    makeCopilotOwned(installed);

    const results = await raceReceipt(installed, first, "copilot-owned");
    // A session-owned marker is never re-answered from the marker, so the
    // loser is answered as a bare `next` (a part-1 restart); every racer that
    // advanced holds the same part-2 receipt and the owner is preserved.
    const advanced = results.filter((result) => result.directive.part === 2);
    expect(advanced.length).toBeGreaterThanOrEqual(1);
    expect(new Set(advanced.map((result) => result.directive.receipt)).size).toBe(1);
    for (const result of results) {
      if (result.directive.part !== 2) expect(isRestart(result.directive)).toBe(true);
    }
    expect(marker(installed).owner_session).toBe("cursor-owner");
  });

  // Old property: each token advanced once, its replay errored, the final
  // run-stage was tokenless. New property: each receipt advances once along the
  // chain, the final run-stage carries no receipt, and a replay of any consumed
  // receipt afterwards re-answers the run-stage (never an earlier part).
  test("every delivered receipt advances once and the final run-stage carries no receipt", () => {
    for (const harness of HARNESSES) {
      const installed = project(harness);
      let directive = invoke(installed, "next").directive;
      const receipts: string[] = [];

      while (directive.kind === "load-steering") {
        const receipt = directive.receipt ?? "";
        expect(receipt, harness.name).toMatch(RECEIPT_PATTERN);
        expect(receipts, harness.name).not.toContain(receipt);
        expect(directive.next, harness.name).toBe(
          continueCommand(harness, receipt),
        );
        receipts.push(receipt);
        const successor = invoke(installed, "continue", receipt).directive;
        expect(successor.kind, harness.name).not.toBe("error");
        if (successor.kind === "load-steering") {
          expect(successor.part, harness.name).toBe((directive.part ?? 0) + 1);
        }
        directive = successor;
        expect(receipts.length, harness.name).toBeLessThan(100);
      }

      expect(receipts.length, harness.name).toBeGreaterThan(1);
      expect(directive.kind, harness.name).toBe("run-stage");
      expect(directive, harness.name).not.toHaveProperty("receipt");
      expect(directive, harness.name).not.toHaveProperty("next");
      expect(marker(installed).kind, harness.name).toBe("run-stage");
      expect(marker(installed), harness.name).not.toHaveProperty(
        "continue_token",
      );
      expect(marker(installed), harness.name).not.toHaveProperty(
        "continue_token_sha256",
      );
      expect(marker(installed), harness.name).toHaveProperty("steering_payload");

      // A consumed receipt is answered exactly as a bare `next` is, never as an
      // error and never as the earlier part it once named. On every harness but
      // Kiro IDE that is the issued run-stage, re-answered from the marker. Kiro
      // IDE never re-answers from the marker (its legacy Plan Approval choices
      // are rotated by publication), so there a bare `next` after run-stage
      // re-transports the rules from part 1, and the replay follows it.
      for (const receipt of receipts) {
        const label = `${harness.name} ${receipt}`;
        const replay = invoke(installed, "continue", receipt);
        const again = invoke(installed, "next");
        expect(replay.directive.kind, label).not.toBe("error");
        expect(replay.stdout, label).toBe(again.stdout);
        if (harness.name === "kiro-ide") {
          expect(isRestart(replay.directive), label).toBe(true);
        } else {
          expect(replay.directive.kind, label).toBe("run-stage");
        }
      }
    }
  }, 120000);

  // Old property: after marker damage exactly one racer won and one got the
  // stale error. New property: both racers are answered identically and never
  // with an error; the marker is rebuilt or advanced exactly once for this
  // harness and names the receipt both of them hold.
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
      const receipt = first.receipt ?? "";
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
        invokeAsync(installed, "continue", receipt),
        invokeAsync(installed, "continue", receipt),
      ]);
      expect(results.map((result) => result.code), shape).toEqual([0, 0]);
      expect(
        results.filter((result) => result.directive.kind === "error"),
        shape,
      ).toHaveLength(0);
      expect(
        results.every((result) => result.directive.kind === "load-steering"),
        shape,
      ).toBe(true);
      // A marker that still names the receipt (legacy-v2, migrated-harness)
      // advances exactly once to part 2 and the loser reads that successor; a
      // destroyed marker is rebuilt from scratch at part 1 (its revision
      // restarts at 1, plus at most one bump from the second racer) and both
      // racers receive that part.
      const survives = shape === "legacy-v2" || shape === "migrated-harness";
      const expectedPart = survives ? 2 : 1;
      expect(
        results.map((result) => result.directive.part),
        shape,
      ).toEqual([expectedPart, expectedPart]);
      expect(results[0].stdout, shape).toBe(results[1].stdout);
      const value = marker(installed);
      expect(value.version, shape).toBe(2);
      expect(value.cursor_harness, shape).toBe("claude");
      expect(value.kind, shape).toBe("load-steering");
      expect(value.part, shape).toBe(expectedPart);
      if (survives) {
        expect(Number(value.revision), shape).toBe(Number(current.revision) + 1);
      } else {
        expect(Number(value.revision), shape).toBeGreaterThanOrEqual(1);
        expect(Number(value.revision), shape).toBeLessThanOrEqual(2);
      }
      expect(value.continue_token, shape).toBe(results[0].directive.receipt);
    }
  }, 60000);

  test("fresh next and continue serialize in both lock orders", async () => {
    const harness = HARNESSES[0];

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const receipt = first.receipt ?? "";
      const beforeRevision = Number(marker(installed).revision);
      const continueResult = invoke(installed, "continue", receipt);
      const nextResult = invoke(installed, "next");

      expect(continueResult.directive.kind).toBe("load-steering");
      expect(continueResult.directive.part).toBe(2);
      expect(nextResult.directive.kind).toBe("load-steering");
      // The `continue` advances the cursor to part two (one revision). The `next`
      // after it cannot be told apart from an ask by a compacted context, so rather
      // than hand back a middle part it restarts delivery at part one, which costs
      // the second revision. Only a repeat ask AT part one is free.
      expect(nextResult.directive.part).toBe(1);
      expect(nextResult.directive.receipt).toBe(receipt);
      expect(marker(installed).revision).toBe(beforeRevision + 2);
      assertMarkerMatchesDirective(installed, nextResult.directive);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const receipt = first.receipt ?? "";
      const beforeRevision = Number(marker(installed).revision);
      const nextResult = invoke(installed, "next");
      const continueResult = invoke(installed, "continue", receipt);

      expect(nextResult.directive.kind).toBe("load-steering");
      expect(nextResult.directive.receipt).toBe(receipt);
      expect(continueResult.directive.kind).toBe("load-steering");
      expect(continueResult.directive.part).toBe(2);
      // Same in the other order: the repeated `next` is free, the `continue` costs
      // the one revision that actually advances the cursor.
      expect(marker(installed).revision).toBe(beforeRevision + 1);
      assertMarkerMatchesDirective(installed, continueResult.directive);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const receipt = first.receipt ?? "";
      const lockDir = join(
        seededRecordDir(installed.dir),
        ".aidlc-engine/active-directive.lock",
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
      const continued = invokeAsync(installed, "continue", receipt);
      await Bun.sleep(100);
      rmSync(lockDir, { recursive: true, force: true });
      const result = await continued;

      expect(result.code, result.stderr).toBe(0);
      expect(result.directive.kind).toBe("load-steering");
      expect(result.directive.part).toBe(2);
      assertMarkerMatchesDirective(installed, result.directive);
    }
  }, 30000);

  test("fresh next emits no work directive when cursor reset publication contends", () => {
    const installed = project(HARNESSES[0]);
    invoke(installed, "next");
    // Removing the marker makes publication genuinely necessary, which is the
    // case this guarantee is about: a `next` that COULD NOT publish must never
    // hand the conductor work anyway.
    rmSync(markerPath(installed));
    const lockDir = join(
      seededRecordDir(installed.dir),
      ".aidlc-engine/active-directive.lock",
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
    expect(existsSync(markerPath(installed))).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("a repeated next answers from the issued directive without taking the coordination lock", () => {
    const installed = project(HARNESSES[0]);
    const first = invoke(installed, "next");
    const before = readFileSync(markerPath(installed), "utf-8");
    const lockDir = join(
      seededRecordDir(installed.dir),
      ".aidlc-engine/active-directive.lock",
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

    // Nothing to publish, so the query does not contend at all: it returns the
    // directive already issued for this state, byte for byte, and the other
    // holder's lock is left alone.
    const repeated = invoke(installed, "next");

    expect(repeated.directive.kind).toBe(first.directive.kind);
    expect(repeated.directive.receipt).toBe(first.directive.receipt);
    expect(repeated.directive.part).toBe(first.directive.part);
    expect(repeated.stdout).toBe(first.stdout);
    expect(readFileSync(markerPath(installed), "utf-8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
  });

  // Old property: a crashed hold was reaped and the retried token advanced once,
  // its replay erroring; a write failure after commit left the replay stale. New
  // property: the same cardinality with the replay answered as a restart at
  // part 1 (never an error, never part 2 again).
  test("crash boundaries preserve retry cardinality without production test seams", () => {
    const harness = HARNESSES[0];

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const receipt = first.receipt ?? "";
      const before = readFileSync(markerPath(installed), "utf-8");
      const lockDir = join(
        seededRecordDir(installed.dir),
        ".aidlc-engine/active-directive.lock",
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
      const retried = invoke(installed, "continue", receipt).directive;
      expect(retried.kind).toBe("load-steering");
      expect(retried.part).toBe(2);
      expect(existsSync(lockDir)).toBe(false);
      const replay = invoke(installed, "continue", receipt).directive;
      expect(isRestart(replay)).toBe(true);
      expect(replay.receipt).toBe(receipt);
    }

    {
      const installed = project(harness);
      const first = invoke(installed, "next").directive;
      const receipt = first.receipt ?? "";
      const before = readFileSync(markerPath(installed), "utf-8");
      const roFd = openSync(markerPath(installed), "r");
      const failed = (() => {
        try {
          return Bun.spawnSync(command(installed, "continue", receipt), {
            cwd: installed.dir,
            stdout: roFd,
            stderr: "pipe",
          });
        } finally {
          closeSync(roFd);
        }
      })();

      // The cursor advanced (the marker moved to part 2) even though the
      // directive could not be written, so the receipt is consumed: a replay is
      // a restart, and a fresh `next` answers the same restart byte for byte.
      expect(failed.exitCode).not.toBe(0);
      expect(readFileSync(markerPath(installed), "utf-8")).not.toBe(before);
      expect(marker(installed).part).toBe(2);
      const replay = invoke(installed, "continue", receipt);
      expect(isRestart(replay.directive)).toBe(true);
      expect(replay.directive.receipt).toBe(receipt);
      const next = invoke(installed, "next");
      expect(next.directive.kind).toBe("load-steering");
      expect(next.stdout).toBe(replay.stdout);
    }
  }, 30000);
});

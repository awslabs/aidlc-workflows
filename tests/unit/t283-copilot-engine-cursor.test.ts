// covers: function:inspectCopilotContinuation, function:advanceCopilotContinuation, subcommand:aidlc-orchestrate:continue

import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const projects: string[] = [];

type Directive = { kind: string; continue_token?: string; message?: string };

function installHarness(proj: string, harness: "copilot" | "opencode"): void {
  cpSync(join(REPO_ROOT, "dist", harness, ".aidlc"), join(proj, ".aidlc"), { recursive: true });
  cpSync(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"), join(proj, ".aidlc", "tools", "aidlc-lib.ts"));
  cpSync(join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts"), join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"));
}

function project(): string {
  const proj = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
  projects.push(proj);
  installHarness(proj, "copilot");
  const org = join(proj, "aidlc", "spaces", "default", "memory", "org.md");
  writeFileSync(
    org,
    Array.from({ length: 180 }, (_, i) => `## Cursor ${i}\n\n${"x".repeat(320)}\n\n`).join(""),
    "utf-8",
  );
  return proj;
}

afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

function invoke(
  proj: string,
  verb: "next" | "continue",
  arg?: string,
  env: Record<string, string> = {},
): { directive: Directive; stdout: string } {
  const proc = Bun.spawnSync([
    BUN,
    join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"),
    verb,
    ...(verb === "continue" ? [arg ?? ""] : []),
    "--project-dir",
    proj,
  ], { cwd: proj, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const stdout = proc.stdout.toString().trim();
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  return { directive: JSON.parse(stdout) as Directive, stdout };
}

function markerPath(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-active-directive.json");
}

function marker(proj: string): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPath(proj), "utf-8")) as Record<string, unknown>;
}

function makeCopilotOwned(proj: string): void {
  const value = marker(proj);
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
  writeFileSync(markerPath(proj), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("t283 Copilot-owned engine continuation cursor", () => {
  test("two real same-token processes have exactly one winner and one marker publication", async () => {
    const proj = project();
    const first = invoke(proj, "next").directive;
    expect(first.kind).toBe("load-steering");
    makeCopilotOwned(proj);
    const token = first.continue_token ?? "";
    const beforeRevision = Number(marker(proj).revision);
    const procs = Array.from({ length: 2 }, () => Bun.spawn([
      BUN, join(proj, ".aidlc", "tools", "aidlc-orchestrate.ts"), "continue", token, "--project-dir", proj,
    ], { cwd: proj, stdout: "pipe", stderr: "pipe" }));
    const [codes, outputs, errors] = await Promise.all([
      Promise.all(procs.map((proc) => proc.exited)),
      Promise.all(procs.map((proc) => new Response(proc.stdout).text())),
      Promise.all(procs.map((proc) => new Response(proc.stderr).text())),
    ]);
    expect(codes, errors.join("\n")).toEqual([0, 0]);
    const directives = outputs.map((output) => JSON.parse(output.trim()) as Directive);
    expect(directives.filter((directive) => directive.kind !== "error")).toHaveLength(1);
    expect(directives.filter((directive) => directive.message?.includes("no longer current"))).toHaveLength(1);
    expect(marker(proj).revision).toBe(beforeRevision + 1);
    expect(marker(proj).continue_token_sha256).not.toBe(createHash("sha256").update(token).digest("hex"));
  }, 30000);

  test("an old Copilot marker becomes stateless after a real OpenCode install replaces Copilot", () => {
    const proj = project();
    const first = invoke(proj, "next").directive;
    expect(first.kind).toBe("load-steering");
    makeCopilotOwned(proj);
    const token = first.continue_token ?? "";
    installHarness(proj, "opencode");
    const before = readFileSync(markerPath(proj), "utf-8");
    const lockDir = join(seededRecordDir(proj), ".aidlc-active-directive.lock");
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
    const once = invoke(proj, "continue", token).directive;
    const twice = invoke(proj, "continue", token).directive;
    expect(once.kind).not.toBe("error");
    expect(twice).toEqual(once);
    expect(readFileSync(markerPath(proj), "utf-8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
  }, 30000);

  test("fresh Copilot next emits no work directive when cursor reset publication contends", () => {
    const proj = project();
    invoke(proj, "next");
    makeCopilotOwned(proj);
    const before = readFileSync(markerPath(proj), "utf-8");
    const lockDir = join(seededRecordDir(proj), ".aidlc-active-directive.lock");
    const token = randomUUID();
    const now = Math.floor(performance.timeOrigin + performance.now());
    const owner = { pid: process.pid, startedAtMs: now, reapLiveOwnerAfterStale: true, token };
    mkdirSync(join(lockDir, token), { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
    const blocked = invoke(proj, "next").directive;
    expect(blocked).toMatchObject({ kind: "error" });
    expect(blocked.message).toContain("no work directive was issued");
    expect(readFileSync(markerPath(proj), "utf-8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
  }, 10000);

  test("missing, malformed, and v1 markers keep the existing stateless path", () => {
    for (const shape of ["missing", "malformed", "v1"] as const) {
      const proj = project();
      const first = invoke(proj, "next").directive;
      const token = first.continue_token ?? "";
      if (shape === "missing") rmSync(markerPath(proj));
      if (shape === "malformed") writeFileSync(markerPath(proj), "{bad-json\n", "utf-8");
      if (shape === "v1") {
        const current = marker(proj);
        writeFileSync(markerPath(proj), `${JSON.stringify({
          version: 1,
          stage: current.stage,
          state_sha256: current.state_sha256,
        })}\n`, "utf-8");
      }
      const continued = invoke(proj, "continue", token).directive;
      expect(continued.kind, shape).not.toBe("error");
    }
  }, 30000);

  test("a Copilot sessionless marker keeps the existing stateless replay behavior", () => {
    const proj = project();
    const first = invoke(proj, "next").directive;
    expect(first.kind).toBe("load-steering");
    expect(String(marker(proj).owner_session)).toStartWith("sessionless:");
    const once = invoke(
      proj,
      "continue",
      first.continue_token ?? "",
    ).directive;
    const twice = invoke(
      proj,
      "continue",
      first.continue_token ?? "",
    ).directive;
    expect(once.kind).not.toBe("error");
    expect(twice).toEqual(once);
  }, 10000);

  test("a real dead lock owner is reclaimed while the canonical marker stays readable", async () => {
    const proj = project();
    const first = invoke(proj, "next").directive;
    makeCopilotOwned(proj);
    const before = readFileSync(markerPath(proj), "utf-8");
    const lockDir = join(seededRecordDir(proj), ".aidlc-active-directive.lock");
    const ready = join(proj, `.cursor-lock-ready-${randomUUID()}`);
    const holder = join(proj, `.cursor-lock-holder-${randomUUID()}.ts`);
    writeFileSync(holder, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const lockDir = ${JSON.stringify(lockDir)};`,
      `const token = ${JSON.stringify(randomUUID())};`,
      "mkdirSync(lockDir, { mode: 0o700 });",
      "writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAtMs: Math.floor(performance.timeOrigin + performance.now()), reapLiveOwnerAfterStale: true, token }));",
      "mkdirSync(join(lockDir, token), { mode: 0o700 });",
      `writeFileSync(${JSON.stringify(ready)}, 'ready');`,
      "await Bun.sleep(30000);",
    ].join("\n"));
    const proc = Bun.spawn([BUN, holder], { cwd: proj, stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    expect(readFileSync(markerPath(proj), "utf-8")).toBe(before);
    proc.kill(9);
    await proc.exited;
    const recovered = invoke(proj, "continue", first.continue_token ?? "").directive;
    expect(recovered.kind).not.toBe("error");
    expect(existsSync(lockDir)).toBe(false);
  }, 30000);

  test("a process killed before owner stamping is reclaimed after the unstamped grace", async () => {
    const proj = project();
    const first = invoke(proj, "next").directive;
    makeCopilotOwned(proj);
    const before = readFileSync(markerPath(proj), "utf-8");
    const lockDir = join(seededRecordDir(proj), ".aidlc-active-directive.lock");
    const ready = join(proj, `.unstamped-lock-ready-${randomUUID()}`);
    const holder = join(proj, `.unstamped-lock-holder-${randomUUID()}.ts`);
    const acquisitionToken = randomUUID();
    writeFileSync(holder, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      `mkdirSync(${JSON.stringify(lockDir)}, { mode: 0o700 });`,
      `mkdirSync(${JSON.stringify(join(lockDir, acquisitionToken))}, { mode: 0o700 });`,
      `writeFileSync(${JSON.stringify(ready)}, "ready");`,
      "await Bun.sleep(30000);",
    ].join("\n"));
    const proc = Bun.spawn([BUN, holder], { cwd: proj, stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    expect(readFileSync(markerPath(proj), "utf-8")).toBe(before);
    proc.kill(9);
    await proc.exited;
    await Bun.sleep(5);
    const recovered = invoke(proj, "continue", first.continue_token ?? "", {
      AIDLC_LOCK_UNSTAMPED_GRACE_MS: "1",
    }).directive;
    expect(recovered.kind).not.toBe("error");
    expect(existsSync(lockDir)).toBe(false);
  }, 30000);
});

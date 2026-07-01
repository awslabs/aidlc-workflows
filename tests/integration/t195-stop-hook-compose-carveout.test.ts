// covers: hook:aidlc-stop
//
// t195 - the P4 pending-compose Stop-hook carve-out (tier 2b).
//
// An IN-FLIGHT compose proposal's approve/edit/reject gate is a turn-stop like
// a stage gate, but it has no [?]/[R] checkbox signal: the hook's bare-`next`
// probe sees the pending run-stage and would BLOCK the turn - shoving the
// conductor back into stage execution mid-compose (the mid-workflow trap
// class, reopened for compose). The carve-out is POSITIVE-CONFIRMATION via the
// marker file `aidlc/.aidlc-compose-pending` the conductor writes before
// presenting the gate (the engine's compose dispatch print instructs it) and
// deletes on approve/reject.
//
// Cases (the t121 mock-engine pattern - the hook spawns the project's own
// .claude/tools/aidlc-orchestrate.ts, which here is a one-line mock):
//   1. marker present + pending run-stage        -> ALLOW (the carve-out)
//   2. marker ABSENT + pending run-stage         -> BLOCK (nothing weakened)
//   3. marker present + AUTONOMOUS construction  -> BLOCK (autonomy guard)
//   4. marker deleted after the gate resolves    -> BLOCK again (one-shot)
//
// Mechanism: cli - stdin JSON + env + stdout decision, exactly t121's seam.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK_TS = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-stop.ts");

const PINNED_CLONE_ID = "testcloneid195";
function pinnedShardPath(proj: string): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return join(seededAuditDir(proj), `${host}-${PINNED_CLONE_ID}.md`);
}

const MOCK_ENGINE = `console.log(JSON.stringify({ kind: "run-stage", stage: "requirements-analysis" }));
process.exit(0);
`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t195-"));
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
  writeFileSync(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), MOCK_ENGINE, "utf-8");
  const intentsDir = intentsDirOf(proj, DEFAULT_SPACE);
  mkdirSync(join(proj, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify([{ uuid: "00000000-0000-7000-8000-000000000001", slug: "t195", status: "in-flight" }], null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(pinnedShardPath(proj), "audit row 1\n", "utf-8");
  return proj;
}

function seedActive(proj: string, opts: { autonomy?: string } = {}): void {
  const autonomyLine = opts.autonomy
    ? `- **Construction Autonomy Mode**: ${opts.autonomy}\n`
    : "";
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: requirements-analysis\n${autonomyLine}`,
    "utf-8",
  );
}

const markerPath = (proj: string): string => join(proj, "aidlc", ".aidlc-compose-pending");

function runHook(proj: string): { rc: number; out: string } {
  const res = spawnSync(BUN, [HOOK_TS], {
    input: JSON.stringify({ stop_hook_active: false }),
    encoding: "utf-8",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
    },
    timeout: 20_000,
  });
  return { rc: res.status ?? -1, out: (res.stdout ?? "").trim() };
}

describe("t195 pending-compose Stop-hook carve-out (tier 2b)", () => {
  test("1: marker present + pending run-stage -> ALLOW (the turn ends at the compose gate)", () => {
    const proj = makeProject();
    seedActive(proj);
    writeFileSync(markerPath(proj), "pending\n", "utf-8");
    const r = runHook(proj);
    expect(r.rc).toBe(0);
    expect(r.out).not.toContain('"decision":"block"');
  });

  test("2: marker ABSENT + pending run-stage -> BLOCK (enforcement not weakened)", () => {
    const proj = makeProject();
    seedActive(proj);
    const r = runHook(proj);
    expect(r.out).toContain('"decision":"block"');
  });

  test("3: marker present under AUTONOMOUS construction -> BLOCK (autonomy guard)", () => {
    const proj = makeProject();
    seedActive(proj, { autonomy: "autonomous" });
    writeFileSync(markerPath(proj), "pending\n", "utf-8");
    const r = runHook(proj);
    expect(r.out).toContain('"decision":"block"');
  });

  test("4: marker deleted after the gate resolves -> BLOCK again (one-shot signal)", () => {
    const proj = makeProject();
    seedActive(proj);
    writeFileSync(markerPath(proj), "pending\n", "utf-8");
    expect(runHook(proj).out).not.toContain('"decision":"block"');
    unlinkSync(markerPath(proj));
    const r = runHook(proj);
    expect(r.out).toContain('"decision":"block"');
  });
});

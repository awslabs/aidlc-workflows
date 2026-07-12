// covers: file:skills/aidlc/SKILL.md
//
// t-run-opencode-status.serial.test.ts — drive `/aidlc --status` through
// opencode's headless surface (`opencode run --command aidlc`) against the
// SHIPPED dist/opencode tree, and assert on the engine's real outputs. The
// opencode-run driver is the structured "logic half" for the opencode harness
// — the analogue of codex's exec driver (no tmux, no painted screen; the
// model's final message + the project's on-disk state are the observables).
//
// LIVE-PROVEN (2026-07-12, opencode 1.17.18 on Bedrock): the same rig shape
// ran skill + subagent discovery, this status journey, AND a real intent
// birth (scope ask → poc → intent-birth → first run-stage directive with the
// conductor persona) — transcripts in the build session. This test pins the
// cheap status journey so CI can re-verify the shipped tree end-to-end
// without burning a whole workflow.
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm — turn-stable). With an ACTIVE workflow the conductor may
// legitimately resume it inside the same run turn (the forwarding loop lives
// in-turn), so a with-state "status is read-only" assert is not turn-stable
// here — same carve-out as the codex exec twin.
//
// What this proves on the SHIPPED tree, structurally:
//   - the /aidlc command entry (.opencode/command/aidlc.md) resolves and
//     forwards $ARGUMENTS;
//   - skill discovery from .aidlc/skills via the shipped opencode.json
//     skills.paths (the engine-outside-.opencode layout works live);
//   - the engine's print-directive terminal arm (status names no workflow);
//   - nothing is scaffolded by a read-only utility.
//
// LIVE GATE: requires AIDLC_OPENCODE_RUN_LIVE=1 + an opencode >= 1.17 binary
// (AIDLC_OPENCODE_BIN or PATH) + a configured model provider in the user's
// GLOBAL opencode config (the shipped project opencode.json pins no model;
// AIDLC_OPENCODE_MODEL overrides, default Bedrock Sonnet). Skips cleanly
// otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const OPENCODE_DIST = join(REPO_ROOT, "dist", "opencode");
const OPENCODE_BIN = process.env.AIDLC_OPENCODE_BIN ?? "opencode";
const MODEL =
  process.env.AIDLC_OPENCODE_MODEL ?? "amazon-bedrock/global.anthropic.claude-sonnet-4-6";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function opencodeVersionOk(): boolean {
  const r = spawnSync(OPENCODE_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 1 || (maj === 1 && min >= 17);
}

function skipReason(): string | null {
  if (process.env.AIDLC_OPENCODE_RUN_LIVE !== "1") {
    return "set AIDLC_OPENCODE_RUN_LIVE=1 to run the live opencode-run journey (uses your provider)";
  }
  if (!opencodeVersionOk()) return `opencode >= 1.17 not found (AIDLC_OPENCODE_BIN=${OPENCODE_BIN})`;
  if (!existsSync(OPENCODE_DIST)) return `distributable missing: ${OPENCODE_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

// A scratch install: dist/opencode copied verbatim (dotfiles included — the
// engine at .aidlc/, the native shell at .opencode/, the project opencode.json
// whose skills.paths + permission allowlist this journey exercises), then
// git-initialized (opencode resolves the project root by walking to the
// worktree root).
function setupOpencodeProject(): { proj: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-run-")));
  const proj = join(root, "proj");
  cpSync(OPENCODE_DIST, proj, { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "install"],
  ]) {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return { proj, root };
}

// `--command aidlc` invokes the shipped .opencode/command/aidlc.md; the
// message tokens after `--` land in its $ARGUMENTS. The status path needs no
// non-allowlisted tools, so no --auto: an unexpected permission ask would
// auto-reject and fail the asserts (which is the honest signal).
//
// PWD must be pinned to the project: spawnSync's `cwd` does not rewrite the
// inherited PWD env var, and opencode trusts PWD over the real cwd when
// resolving its instance directory — with the runner's checkout leaking
// through, `opencode run` dies with "Unexpected server error"
// (live-reproduced on 1.17.18).
function runOpencode(proj: string, args: string[]): { rc: number; out: string } {
  const r = spawnSync(
    OPENCODE_BIN,
    ["run", "--command", "aidlc", "-m", MODEL, "--", ...args],
    {
      cwd: proj,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PWD: proj },
      timeout: TEST_TIMEOUT_MS,
    },
  );
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe("t-run-opencode-status — /aidlc --status on the shipped dist/opencode via opencode run", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, root } = setupOpencodeProject();
      try {
        const r = runOpencode(proj, ["--status"]);
        // Surface the CLI's own output on a non-zero exit — the observable
        // that names the failure (provider auth, config rejection, crash).
        expect({ rc: r.rc, tail: r.rc === 0 ? "" : r.out.slice(-2000) }).toEqual({
          rc: 0,
          tail: "",
        });
        // The engine's no-workflow status text, surfaced verbatim by the
        // print-directive terminal arm.
        expect(r.out.toLowerCase()).toContain("no active");
        // Read-only: the status path must not scaffold a workflow. The
        // shipped aidlc/ workspace shell (spaces/default/memory + the
        // active-space cursor) is part of the install; the workflow signals
        // are an intent record (state file) and the per-intent scaffold.
        expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"))).toBe(
          false,
        );
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

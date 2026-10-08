// covers: harness-instrument:tui-drive-launch-env
//
// The suite often runs from inside a Claude Code session, which marks every
// child process with CLAUDE_CODE_CHILD_SESSION. A Claude TUI started with that
// marker saves no transcript ("Transcript saving is off"), so a journey that
// reads the session's own transcript (t139) finds none. The driver starts every
// session without the marker, on both backends, as a person's terminal would.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

describe("a TUI session never inherits the launching Claude session's marker", () => {
  // Windows ConPTY launches go through the same cmdStart; this proof runs where
  // the box can host it.
  for (const backend of ["bun", "tmux"] as const) {
    test.skipIf(process.platform === "win32" || (backend === "tmux" && !hasTmux))(`${backend} backend`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tui-launch-env-"));
      const out = join(dir, "seen.txt");
      const target = join(dir, "target.ts");
      writeFileSync(target, [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(out)}, process.env.CLAUDE_CODE_CHILD_SESSION ?? "unset");`,
        'process.stdout.write("ready");',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      const socket = `aidlc-launch-env-${randomUUID()}`;
      const session = `launch-env-${randomUUID().slice(0, 8)}`;
      const env = {
        ...process.env,
        CLAUDE_CODE_CHILD_SESSION: "1",
        AIDLC_TUI_BACKEND: backend,
        AIDLC_TUI_TMUX_SOCKET: socket,
      };
      const drive = (args: string[]) => spawnSync(process.execPath, [DRIVER, ...args], {
        cwd: dir, env, encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      try {
        const started = drive(["start", "--session", session, "--cwd", dir, "--width", "40", "--height", "8",
          "--", process.execPath, target]);
        expect(started.status, started.stderr).toBe(0);
        const deadline = Date.now() + 15_000;
        while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(50);
        expect(readFileSync(out, "utf8")).toBe("unset");
      } finally {
        drive(["kill", "--session", session]);
        if (backend === "tmux") {
          spawnSync("tmux", ["-L", socket, "kill-server"], {
            encoding: "utf8", timeout: remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS),
          });
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

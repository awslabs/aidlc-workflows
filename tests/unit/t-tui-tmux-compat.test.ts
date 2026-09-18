// Real POSIX tmux capture/view compatibility, independently selectable from
// the portable socket-isolation source guards. No model calls; case unchanged.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tui-drive tmux backend runs on a private socket (developer-session safety)", () => {
  test.skipIf(process.platform === "win32")("physical wait/startup omit wrap joining while public capture keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-physical-tmux-"));
    const socket = `aidlc-physical-${randomUUID()}`;
    const session = "physical-rows";
    const target = join(dir, "target.ts");
    const trace = join(process.env.AIDLC_TEST_LOG_DIR ?? dir, `tmux-views-${randomUUID()}.ndjson`);
    writeFileSync(target, `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[2J\\x1b[Habcdefghijklmnop");
let painting = false, frame = 0;
process.stdin.on("data", () => {
  if (painting) return;
  painting = true;
  setInterval(() => process.stdout.write("\\x1b[2J\\x1b[Hframe:"+String(++frame).padStart(6,"0")+":abcdefghij"), 2);
});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(99), 15000);
`);
    const env = {
      ...process.env, AIDLC_TUI_BACKEND: "tmux", AIDLC_TUI_TMUX_SOCKET: socket,
      AIDLC_TUI_TRACE_FILE: trace,
    };
    const drive = (args: string[]) => {
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "../harness/tui-drive.ts"), ...args,
      ], { cwd: dir, env, encoding: "utf8", timeout: 8000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      drive(["start", "--session", session, "--cwd", dir, "--width", "12", "--height", "8",
        "--", process.execPath, target]);
      drive(["wait", "--session", session, "--pattern", "\\nmnop", "--stable-ms", "0", "--timeout-ms", "5000"]);
      drive(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--stable-ms", "100", "--timeout-ms", "5000"]);
      drive(["wait", "--session", session, "--pattern", "abcdefghijklmnop", "--view", "logical", "--stable-ms", "0", "--timeout-ms", "5000"]);
      drive(["wait", "--session", session, "--pattern", "\\nmnop", "--view", "physical", "--stable-ms", "0", "--timeout-ms", "5000"]);
      drive(["startup", "--session", session, "--ready-pattern", "\\nmnop", "--timeout-ms", "5000"]);
      drive(["startup", "--session", session, "--ready-pattern", "abcdefghijklmnop", "--timeout-ms", "5000"]);
      expect(drive(["capture", "--session", session]).trim()).toBe("abcdefghijklmnop");
      expect(drive(["capture", "--session", session, "--physical"]).trim()).toBe("abcdefghijkl\nmnop");
      drive(["send", "--session", session, "--keys", "x", "--literal", "--no-enter"]);
      const repaintPattern = "frame:\\d{6}:abcdefghij";
      for (let sample = 0; sample < 8; sample++) {
        drive(["wait", "--session", session, "--pattern", repaintPattern, "--stable-ms", "0", "--timeout-ms", "5000"]);
      }
      const observations = readFileSync(trace, "utf8").split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.event === "wait_match" && event.pattern === repaintPattern);
      expect(observations).toHaveLength(8);
      for (const event of observations) {
        expect(event.matchedView).toBe("logical");
        expect(event.screen.trim().replaceAll("\n", "")).toBe(event.logicalScreen.trim());
      }
    } finally {
      // This test owns the entire uniquely named server, including failures.
      spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8", timeout: 5000 });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

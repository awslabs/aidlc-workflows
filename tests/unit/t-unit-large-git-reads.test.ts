// covers: function:gitTextAt
//
// A Unit's audit shard outgrows 1 MiB in one long attempt. Pin's candidate
// evidence and audit events read the committed shard through a pipe that stops
// at the runtime's buffer: a 1.19 MB shard came back cut at 1,113,841
// characters, reported as read when git exited first, and as "Pinned candidate
// is missing <shard>" when it was killed. The read now lifts that cap, and a
// committed file's bytes are checked against its recorded size.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTextAt } from "../../dist/claude/.claude/tools/aidlc-unit.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repoWith(path: string, content: string): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "t-unit-large-git-"));
  dirs.push(repo);
  const run = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("config", "user.name", "fixture");
  run("config", "user.email", "fixture@example.test");
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  run("add", "-A");
  run("commit", "-q", "-m", "shard");
  return { repo, head: run("rev-parse", "HEAD") };
}

// One audit block, with multi-byte text so a byte count and a character count differ.
const BLOCK = [
  "## Unit Started",
  "**Timestamp**: 2026-10-18T09:28:13Z",
  "**Event**: UNIT_STARTED",
  "**Stage**: nfr-design",
  "**Unit**: DEMO-2-alpha",
  "**Feedback**: résumé — “quoted” ✓",
  "",
  "---",
  "",
].join("\n");

describe("committed file reads under aidlc unit are never cut short", () => {
  test("a 3 MiB audit shard is read whole, to its last row", () => {
    const shard = "aidlc/spaces/default/intents/261015-demo-1-uniform-test/audit/host-0123456789ab.md";
    const blocks: string[] = [];
    for (let i = 0, bytes = 0; bytes < 3 * 1024 * 1024; i++) {
      const block = BLOCK.replace("09:28:13Z", `09:28:13Z #${i}`);
      blocks.push(block);
      bytes += Buffer.byteLength(block, "utf-8");
    }
    const content = `${blocks.join("")}## Last Row\n**Event**: UNIT_COMPLETED\n`;
    const { repo, head } = repoWith(shard, content);

    const read = gitTextAt(repo, head, shard);
    expect(Buffer.byteLength(read, "utf-8")).toBe(Buffer.byteLength(content, "utf-8"));
    expect(read).toBe(content);
    expect(read.endsWith("**Event**: UNIT_COMPLETED\n")).toBe(true);
  });

  test("a file the commit does not hold is still named as missing", () => {
    const { repo, head } = repoWith("present.md", "present\n");
    expect(() => gitTextAt(repo, head, "absent.md")).toThrow("Pinned candidate is missing absent.md.");
  });
});

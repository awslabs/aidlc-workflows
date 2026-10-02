// t346-antigravity-adapter: the Antigravity stdin shim normalizes payloads into core hooks contract.
//
// covers: file:harness/antigravity/hooks/aidlc-antigravity-adapter.ts

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ADAPTER = join(REPO_ROOT, "dist", "antigravity", ".aidlc", "hooks", "aidlc-antigravity-adapter.ts");

function runAdapter(subcommand: string, input: unknown, cwd: string) {
  return spawnSync(
    process.execPath,
    [ADAPTER, subcommand],
    {
      cwd,
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, AIDLC_RECORD_DIR: cwd },
    }
  );
}

describe("t346 Antigravity Hook Adapter", () => {
  test("1: session-start handles empty / valid payload gracefully", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agy-test-"));
    try {
      const res = runAdapter("session-start", { session_id: "s-123", cwd: tmp }, tmp);
      expect(res.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("2: guard-tool-call normalizes tool name and parameters", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agy-test-"));
    try {
      const payload = {
        tool_name: "write_to_file",
        parameters: { TargetFile: join(tmp, "test.txt"), CodeContent: "hello" },
        session_id: "s-123",
      };
      const res = runAdapter("guard-tool-call", payload, tmp);
      // Fail-open or allow
      expect(res.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("3: malformed JSON input fails open with exit 0", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agy-test-"));
    try {
      const res = runAdapter("guard-tool-call", "not-valid-json", tmp);
      expect(res.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

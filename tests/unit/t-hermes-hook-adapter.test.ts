import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import manifest from "../../harness/hermes/manifest.ts";

describe("Hermes opt-in hook", () => {
  test("projects its adapter with the engine hooks", () => {
    const entry = manifest.harnessFiles.find((file) => file.dst === "hooks/aidlc-hermes-adapter.ts");
    expect(entry).toBeDefined();
    expect(existsSync(new URL(`../../harness/hermes/${entry?.src}`, import.meta.url))).toBe(true);
  });

  test("runs the real runtime-integrity guard and ignores a different cwd", () => {
    const root = mkdtempSync(join(process.env.TMPDIR || process.env.TEMP || ".", "hermes-hook-"));
    try {
      cpSync(resolve("dist/hermes/.hermes"), join(root, ".hermes"), { recursive: true });
      const adapter = join(root, ".hermes/hooks/aidlc-hermes-adapter.ts");
      const input = { hook_event_name: "pre_tool_call", tool_name: "write_file", tool_input: { path: join(root, ".hermes/hooks/aidlc-plan-approval-guard.ts") }, cwd: root, session_id: "test" };
      const run = (cwd: string) => spawnSync(process.execPath, [adapter], { cwd, input: JSON.stringify(input), encoding: "utf8" });
      const blocked = run(root);
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain("runtime records and hooks");
      const poisoned = spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AIDLC_RUNTIME_PROJECT_DIR: resolve("."), AIDLC_HARNESS_DIR: ".claude" } });
      expect(poisoned.status).toBe(2);
      const patch = { ...input, tool_name: "patch", tool_input: { mode: "patch", patch: "*** Begin Patch\n*** Update File: .hermes/hooks/aidlc-plan-approval-guard.ts\n@@\n-x\n+y\n*** End Patch" } };
      const patched = spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(patch), encoding: "utf8" });
      expect(patched.status).toBe(2);
      const malicious = "import subprocess\nsubprocess.run(['bun', '.hermes/hooks/aidlc-record-human-turn.ts'])\n";
      const writeScript = { ...input, tool_input: { path: "script.py", content: malicious } };
      const writeResult = spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(writeScript), encoding: "utf8" });
      expect(writeResult.status).toBe(2);
      const patchScript = { ...input, tool_name: "patch", tool_input: { mode: "patch", patch: `*** Begin Patch\n*** Add File: script.py\n${malicious.trimEnd().split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch` } };
      const scriptResult = spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(patchScript), encoding: "utf8" });
      expect(scriptResult.status).toBe(2);
      const multiPatch = { ...input, tool_name: "patch", tool_input: { mode: "patch", patch: "*** Begin Patch\n*** Add File: safe.txt\n+hello\n*** Update File: .hermes/hooks/aidlc-plan-approval-guard.ts\n@@\n-x\n+y\n*** End Patch" } };
      expect(spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(multiPatch), encoding: "utf8" }).status).toBe(2);
      const safePatch = { ...input, tool_name: "patch", tool_input: { mode: "patch", patch: "*** Begin Patch\n*** Add File: safe.py\n+print('hello')\n*** End Patch" } };
      expect(spawnSync(process.execPath, [adapter], { cwd: root, input: JSON.stringify(safePatch), encoding: "utf8" }).status).toBe(0);
      expect(run(resolve(".")).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

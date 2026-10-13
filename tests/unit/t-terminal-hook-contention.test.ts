// covers: function:publishHookOutput, hook:state-transition-guard
// A busy workflow record must not turn an independent runtime refusal into an
// adapter error (exit 1, which hosts may treat as advisory and fail open).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject, createOrchestrationTestProject, DEFAULT_RECORD_DIR, DEFAULT_SPACE,
  REPO_ROOT, seedAuditFile, seedStateFile, seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { withAuditLock, writeSessionBinding } from "../../core/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const SESSION = "019b0000-1438-7000-8000-000000000099";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanupTestProject(root); });

for (const harness of ["codex", "copilot", "cursor", "kiro", "kiro-ide"] as const) {
  for (const status of ["Running", "Completed"] as const) {
    test(`${harness}/${status}: independent refusal survives another process holding W`, () => {
      const project = createOrchestrationTestProject();
      roots.push(project);
      seedStateFile(project, "state-brownfield-feature.md");
      seedAuditFile(project);
      const state = readFileSync(seededStateFile(project), "utf8")
        .replace(/(- \*\*Status\*\*:\s*)[^\n]+/, `$1${status}`);
      writeFileSync(seededStateFile(project), state);
      writeSessionBinding(project, SESSION, DEFAULT_SPACE, DEFAULT_RECORD_DIR, "switch");
      const dir = harness === "copilot" ? ".aidlc" : harness === "kiro-ide" ? ".kiro" : `.${harness}`;
      cpSync(join(REPO_ROOT, "dist", harness, dir), join(project, dir), { recursive: true });
      const file = harness === "kiro-ide" ? "aidlc-kiro-adapter.ts" : `aidlc-${harness}-adapter.ts`;
      const target = harness === "cursor" ? "guards" : harness === "kiro" ? "state-transition-guard" : "guard-tool-call";
      const command = `printf 'replace runtime' > ${dir}/tools/aidlc-lib.ts`;
      const env = testGuardEnvironment(process.env, "production");
      Object.assign(env, {
        AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project,
        AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
        AIDLC_AUDIT_LOCK_TIMEOUT_MS: "200",
      });
      const result = withAuditLock(project, () => spawnSync(process.execPath, [
        join(project, dir, "hooks", file), target,
      ], {
        cwd: project, env, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
        input: JSON.stringify({
          cwd: project, hook_event_name: "PreToolUse", session_id: SESSION, sessionId: SESSION,
          tool_name: harness === "kiro" || harness === "kiro-ide" ? "execute_bash" : "Bash",
          tool_input: { command },
          toolName: harness === "kiro-ide" ? "execute_bash" : "bash", toolArgs: { command },
          tool_use_id: `${harness}-${status}-runtime-write`,
        }),
      }));
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(harness === "cursor" || harness === "copilot" ? 0 : 2);
      expect(output).toContain("runtime");
      expect(output).not.toContain("Timed out");
      if (harness === "cursor" || harness === "copilot") expect(output).toContain('"deny"');
      expect(readFileSync(seededStateFile(project), "utf8")).toBe(state);
    });
  }
}

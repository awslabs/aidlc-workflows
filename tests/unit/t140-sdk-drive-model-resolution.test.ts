// covers: harness-instrument:sdk-drive-model-resolution
//
// Pins the SDK harness' model-source rule without driving a live Claude turn.
// Model precedence is explicit option > shipped settings > project settings >
// test-only harness default. Shipped settings still own the environment.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveSdkSettings } from "../harness/sdk-drive.ts";

const HARNESS_DEFAULT_MODEL = "opus[1m]";
const SHIPPED_OPUS = "global.anthropic.claude-opus-4-8[1m]";

function withTempProject(assertions: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-sdk-model-"));
  try {
    assertions(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function writeProjectSettings(
  projectDir: string,
  settings: Record<string, unknown>,
): void {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

describe("sdk-drive model resolution", () => {
  test("bare project uses the harness default model and shipped env", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe(HARNESS_DEFAULT_MODEL);
      expect(resolved.modelSource).toBe("harness-default");
      expect(resolved.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(SHIPPED_OPUS);
    });
  });

  test("project settings model beats the harness default while shipped env still wins", () => {
    withTempProject((projectDir) => {
      writeProjectSettings(projectDir, {
        model: "sonnet",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "project-opus-should-not-win",
        },
      });

      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe("sonnet");
      expect(resolved.modelSource).toBe(join(projectDir, ".claude", "settings.json"));
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(SHIPPED_OPUS);
    });
  });

  test("explicit per-call model/env overrides remain available", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir, {
        model: "sonnet",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "explicit-opus",
        },
      });

      expect(resolved.model).toBe("sonnet");
      expect(resolved.modelSource).toBe("option");
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("explicit-opus");
    });
  });
});

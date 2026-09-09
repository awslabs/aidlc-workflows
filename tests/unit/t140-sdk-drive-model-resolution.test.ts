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
  test("bare project uses the harness default model without provider overrides", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe(HARNESS_DEFAULT_MODEL);
      expect(resolved.modelSource).toBe("harness-default");
      expect(resolved.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    });
  });

  test("project settings model and provider env beat the harness default", () => {
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
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL)
        .toBe("project-opus-should-not-win");
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

// covers: harness-instrument:sdk-drive-model-resolution
//
// Pins the SDK harness' model-source rule without driving a live Claude turn.
// The shipped distribution is provider-neutral, so project or explicit test
// settings remain authoritative instead of hidden Bedrock defaults.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveSdkSettings } from "../harness/sdk-drive.ts";

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
  test("bare project does not inject a shipped model", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBeUndefined();
      expect(resolved.modelSource).toBeUndefined();
      if (process.env.PATH) {
        expect(resolved.env.PATH).toBe(process.env.PATH);
      }
    });
  });

  test("project settings remain the fallback authority", () => {
    withTempProject((projectDir) => {
      writeProjectSettings(projectDir, {
        model: "sonnet",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "project-opus",
        },
      });

      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe("sonnet");
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
        "project-opus",
      );
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
      expect(resolved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("explicit-opus");
    });
  });
});

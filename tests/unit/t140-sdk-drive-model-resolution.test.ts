// covers: harness-instrument:sdk-drive-model-resolution
//
// Pins the SDK harness' model-source rule without driving a live Claude turn.
// Model precedence is explicit option > shipped settings > project settings >
// test-only harness default. Shipped settings still own the environment. A run
// launched from a Claude Code session does not hand that session's model
// defaults to its drives; every other run keeps its environment as it is.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveSdkSettings } from "../harness/sdk-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";

const HARNESS_DEFAULT_MODEL = "opus[1m]";

function withTempProject(assertions: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-sdk-model-"));
  try {
    assertions(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/** Run with these process variables set (undefined unsets), then restore them. */
function withEnv(vars: Record<string, string | undefined>, assertions: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    assertions();
  } finally {
    apply(saved);
  }
}

const SESSION_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "session-opus-newer-than-the-sdk",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "session-sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "session-haiku",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "session-fable",
};

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
      const shipped = JSON.parse(
        readFileSync(
          join(REPO_ROOT, "harness", "claude", "settings.json"),
          "utf-8",
        ),
      ) as { env?: Record<string, string> };
      expect(shipped.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(shipped.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
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

  test("a run from a Claude Code session on Bedrock drives CI's pinned models, not the session's", () => {
    withEnv({ ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" }, () => {
      withTempProject((projectDir) => {
        const { env } = resolveDriveSdkSettings(projectDir);
        for (const [key, model] of Object.entries(CI_BEDROCK_MODELS.claude)) expect(env[key]).toBe(model);
        // The session still provides the provider and its credentials.
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      });
    });
  });

  test("a run from a Claude Code session off Bedrock drops the session's models for the bundled defaults", () => {
    withEnv({ ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: undefined }, () => {
      withTempProject((projectDir) => {
        const { env } = resolveDriveSdkSettings(projectDir);
        for (const key of Object.keys(SESSION_MODELS)) expect(env[key]).toBeUndefined();
      });
    });
  });

  test("a run from any other shell, CI's included, keeps its model environment", () => {
    withEnv({ ...CI_BEDROCK_MODELS.claude, CLAUDECODE: undefined, CLAUDE_CODE_USE_BEDROCK: "1" }, () => {
      withTempProject((projectDir) => {
        const { env } = resolveDriveSdkSettings(projectDir);
        for (const [key, model] of Object.entries(CI_BEDROCK_MODELS.claude)) expect(env[key]).toBe(model);
      });
    });
    withEnv({ ...SESSION_MODELS, CLAUDECODE: undefined, CLAUDE_CODE_USE_BEDROCK: undefined }, () => {
      withTempProject((projectDir) => {
        const { env } = resolveDriveSdkSettings(projectDir);
        for (const [key, model] of Object.entries(SESSION_MODELS)) expect(env[key]).toBe(model);
      });
    });
  });

  test("a session's models follow the drive's final provider, not the session's", () => {
    withEnv({ ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" }, () => {
      withTempProject((projectDir) => {
        // A later layer leaves Bedrock: no Bedrock model ids are added.
        const { env } = resolveDriveSdkSettings(projectDir, { env: { CLAUDE_CODE_USE_BEDROCK: "0" } });
        for (const key of Object.keys(SESSION_MODELS)) expect(env[key]).toBeUndefined();
      });
    });
    withEnv({ ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: undefined }, () => {
      withTempProject((projectDir) => {
        // A later layer chooses Bedrock: the drive gets CI's pinned models.
        writeProjectSettings(projectDir, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
        const { env } = resolveDriveSdkSettings(projectDir);
        for (const [key, model] of Object.entries(CI_BEDROCK_MODELS.claude)) expect(env[key]).toBe(model);
      });
    });
  });

  test("project and per-call model env still win over a session's", () => {
    withEnv({ ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" }, () => {
      withTempProject((projectDir) => {
        writeProjectSettings(projectDir, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "project-sonnet" } });
        const { env } = resolveDriveSdkSettings(projectDir, { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "explicit-opus" } });
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("explicit-opus");
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("project-sonnet");
      });
    });
  });
});

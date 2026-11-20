// covers: harness-instrument:sdk-drive-model-resolution
//
// Pins which Claude Code and which environment a live SDK drive gets, without
// driving a turn. A drive runs the first claude on the run's PATH (the one a
// person and the TUI legs start), never the Agent SDK's bundled copy, and stops
// before it starts when there is none. It names no model of its own: the run's
// environment (with the project, shipped and per-call layers over it) names the
// model, else the box's own Claude Code settings do, else the installed Claude
// Code runs its own default. A chat's child-session marker and self-update stay
// out of the drive.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveDriveSdkSettings } from "../harness/sdk-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CLAUDE_NAME = process.platform === "win32" ? "claude.exe" : "claude";
const NO_CLAUDE_CODE_LINE =
  `Live SDK drive stopped before it started: no ${CLAUDE_NAME} on this run's PATH. ` +
  "Install Claude Code, or put the folder that holds it on PATH, and run again.";
const MODEL_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
];
/** The box running these cases may name models in its own environment; no case here may see them. */
const NO_RUN_MODELS = Object.fromEntries(MODEL_NAMES.map((name) => [name, undefined]));

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function withTempProject(assertions: (projectDir: string) => void): void {
  try {
    assertions(tempDir("aidlc-sdk-model-"));
  } finally {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

/** A folder holding a stand-in claude for the finder; no case here starts it. */
function folderWith(name = CLAUDE_NAME): string {
  const dir = tempDir("aidlc-sdk-claude-bin-");
  writeFileSync(join(dir, name), "", { mode: 0o755 });
  return dir;
}

/** A home folder whose Claude Code settings carry this env block (none: no settings file). */
function homeWith(env?: Record<string, string>): string {
  const home = tempDir("aidlc-sdk-home-");
  if (env) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", env }));
  }
  return home;
}

function writeProjectSettings(projectDir: string, settings: Record<string, unknown>): void {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

const SESSION_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "session-opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "session-sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "session-haiku",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "session-fable",
};

describe("sdk-drive runs the Claude Code the run has installed", () => {
  test("a drive runs the claude first on the run's PATH, never the SDK's bundled one", () => {
    withTempProject((projectDir) => {
      const first = folderWith();
      const second = folderWith();
      const resolved = resolveDriveSdkSettings(projectDir, { env: { PATH: `${first}${delimiter}${second}` } }, homeWith());
      expect(resolved.executable).toBe(join(first, CLAUDE_NAME));
    });
  });

  test.skipIf(process.platform !== "win32")("on Windows the PATH key is read in any case, and the child gets one", () => {
    withTempProject((projectDir) => {
      const bin = folderWith();
      const resolved = resolveDriveSdkSettings(projectDir, { env: { Path: bin } }, homeWith());
      expect(resolved.executable).toBe(join(bin, CLAUDE_NAME));
      expect(Object.keys(resolved.env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    });
  });

  test("with no claude on the run's PATH the drive stops before it starts, in one line", () => {
    withTempProject((projectDir) => {
      const empty = tempDir("aidlc-sdk-no-claude-");
      expect(() => resolveDriveSdkSettings(projectDir, { env: { PATH: empty } }, homeWith())).toThrow(NO_CLAUDE_CODE_LINE);
    });
  });

  test.skipIf(process.platform !== "win32")("on Windows a claude.cmd shim first on PATH stops the drive, naming it", () => {
    withTempProject((projectDir) => {
      const shims = folderWith("claude.cmd");
      const shim = join(shims, "claude.cmd");
      expect(() => resolveDriveSdkSettings(projectDir, { env: { PATH: `${shims}${delimiter}${folderWith()}` } }, homeWith()))
        .toThrow(
          `Live SDK drive stopped before it started: the first claude on this run's PATH is ${shim}, a shim the Agent ` +
            "SDK cannot start. Put the folder that holds claude.exe before it on PATH, and run again.",
        );
    });
  });
});

describe("sdk-drive names no model of its own", () => {
  test("with no model named anywhere the drive names none either: the installed Claude Code runs its own default", () => {
    withEnv(NO_RUN_MODELS, () => {
      withTempProject((projectDir) => {
        const resolved = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, homeWith());
        expect(resolved).not.toHaveProperty("model");
        for (const name of MODEL_NAMES) expect(resolved.env[name]).toBeUndefined();
        const shipped = JSON.parse(readFileSync(join(REPO_ROOT, "harness", "claude", "settings.json"), "utf-8")) as {
          model?: string;
        };
        expect(shipped.model).toBeUndefined();
      });
    });
  });

  test("the run's own model names reach the drive, a Claude Code chat's included", () => {
    withEnv({ ...NO_RUN_MODELS, ...SESSION_MODELS, CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" }, () => {
      withTempProject((projectDir) => {
        const home = homeWith({ ANTHROPIC_DEFAULT_OPUS_MODEL: "box-opus" });
        const { env } = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, home);
        for (const [name, model] of Object.entries(SESSION_MODELS)) expect(env[name]).toBe(model);
        expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      });
    });
  });

  test("project and per-call env still layer over the run's", () => {
    withEnv({ ...NO_RUN_MODELS, ...SESSION_MODELS }, () => {
      withTempProject((projectDir) => {
        writeProjectSettings(projectDir, { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "project-sonnet" } });
        const { env } = resolveDriveSdkSettings(
          projectDir,
          { env: { PATH: folderWith(), ANTHROPIC_DEFAULT_OPUS_MODEL: "per-call-opus" } },
          homeWith(),
        );
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("per-call-opus");
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("project-sonnet");
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("session-haiku");
      });
    });
  });

  test("the box's Claude Code settings name the model when the run names none: all their model names, nothing else", () => {
    withEnv({ ...NO_RUN_MODELS, AIDLC_T140_BOX_ONLY: undefined }, () => {
      withTempProject((projectDir) => {
        const home = homeWith({
          ANTHROPIC_DEFAULT_OPUS_MODEL: "box-opus",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "box-sonnet",
          AIDLC_T140_BOX_ONLY: "not a model name",
        });
        const { env } = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, home);
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("box-opus");
        expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("box-sonnet");
        expect(env.AIDLC_T140_BOX_ONLY).toBeUndefined();
        // Only the drive's child gets them: the suite's own environment never does.
        expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      });
    });
  });

  test("a run that names one model keeps every one of the box's names out", () => {
    withEnv({ ...NO_RUN_MODELS, ANTHROPIC_MODEL: "run-model" }, () => {
      withTempProject((projectDir) => {
        const home = homeWith({ ANTHROPIC_DEFAULT_OPUS_MODEL: "box-opus" });
        const { env } = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, home);
        expect(env.ANTHROPIC_MODEL).toBe("run-model");
        expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      });
    });
  });

  test("a chat's child-session marker does not reach the drive", () => {
    withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, () => {
      withTempProject((projectDir) => {
        const { env } = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, homeWith());
        expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      });
    });
  });

  test("the installed Claude Code does not update itself under a drive, whatever a settings layer says", () => {
    withTempProject((projectDir) => {
      writeProjectSettings(projectDir, { env: { DISABLE_AUTOUPDATER: "0" } });
      const { env } = resolveDriveSdkSettings(projectDir, { env: { PATH: folderWith() } }, homeWith());
      expect(env.DISABLE_AUTOUPDATER).toBe("1");
    });
  });
});

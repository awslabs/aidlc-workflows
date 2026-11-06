// t-claude-own-command-any-path: on Claude Code, AI-DLC's own engine command runs without a permission prompt
// however a helper spells this project's path, and nothing else gets through that way.
//
// covers: file:harness/claude/settings.json, file:tools/aidlc.ts, file:tools/aidlc-claude-own-command.ts, function:claudeAllowsOwnCommand
//
// WHAT. The copy channel's settings allow AI-DLC's tool commands in their relative spelling
// (`Bash(bun .claude/tools/aidlc.ts engine *)`, `Bash(bun .claude/tools/aidlc-utility.ts *)`, ...), and Claude Code
// matches a Bash rule against the command text as written. In live golden-bugfix runs the Reverse Engineering helper
// ran those commands with the project's path made absolute (`bun /home/.../.claude/tools/aidlc.ts engine now`; on
// Windows `bun C:/.../.claude/tools/aidlc.ts engine ...` and `bun C:/.../.claude/tools/aidlc-utility.ts
// codekb-publish ...`), or read AI-DLC's record in one compound line, and the person was asked to allow a step AI-DLC
// runs for itself. The group of checks before a tool call now answers "allow" for the absolute spelling of a command
// the project's own allow list holds, and for that read, after every check passed. Claude Code applies the person's deny and ask rules and managed policy over a hook's
// allow (code.claude.com/docs/en/permissions.md), but a rule written for AI-DLC's own spelling never meets the
// absolute one, so such a rule in any settings file means no answer. Every other case here keeps the host's prompt.
//
// WHY SUBPROCESS. The answer is the stdout of the shipped `engine hook guard-tool-call` route, read by Claude Code, so
// every case drives that route in a scratch project as Claude Code runs it (t-claude-guard-group does the same).

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRE_TOOL_USE_GROUP_TARGET } from "../../core/tools/aidlc-command.ts";
import { AIDLC_SRC, createTestProject, REPO_ROOT, seedAidlcMemory } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ENGINE_RULE = "Bash(bun .claude/tools/aidlc.ts engine *)";
const UTILITY_RULE = "Bash(bun .claude/tools/aidlc-utility.ts *)";
const windows = process.platform === "win32";
const RECORD = ["aidlc", "spaces", "default", "intents", "intents.json"];

function scratchProject(): string {
  const project = createTestProject();
  cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
  seedAidlcMemory(project);
  mkdirSync(join(project, ...RECORD.slice(0, -1)), { recursive: true });
  writeFileSync(join(project, ...RECORD), "[]\n");
  return project;
}

interface Answer { decision: string | null; code: number; stdout: string; stderr: string }

/** Claude Code's answer for one Bash call: the decision on stdout, or null when the hook gave none. */
function decide(project: string, command: string, extraEnv: Record<string, string> = {}): Answer {
  // The person's own settings folder stays out of it: a scratch one, empty unless a case writes it.
  const configDir = mkdtempSync(join(tmpdir(), "own-command-config-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: configDir, ...extraEnv };
  for (const key of ["AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_UNATTENDED"]) delete env[key];
  if (!("COPILOT_CLI" in extraEnv)) delete env.COPILOT_CLI;
  try {
    const r = spawnSync("bun", [join(project, ".claude", "tools", "aidlc.ts"), "engine", "hook", PRE_TOOL_USE_GROUP_TARGET], {
      cwd: project,
      env,
      input: JSON.stringify({
        session_id: "own-command-any-path",
        cwd: project,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const stdout = r.stdout ?? "";
    let decision: string | null = null;
    try {
      decision = (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? null;
    } catch {
      decision = null;
    }
    return { decision, code: r.status ?? -1, stdout, stderr: r.stderr ?? "" };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function withProjects(body: (project: string, other: string) => void): void {
  const project = scratchProject();
  const other = scratchProject();
  try {
    body(project, other);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}

const slash = (path: string): string => path.replaceAll("\\", "/");
const engineAt = (dir: string): string => `${slash(dir)}/.claude/tools/aidlc.ts`;
const utilityAt = (dir: string): string => `${slash(dir)}/.claude/tools/aidlc-utility.ts`;
const publish = (dir: string): string => `bun ${utilityAt(dir)} codekb-publish --staged aidlc/spaces/default/intents/x/.aidlc-engine/codekb-stage/`;
const recordAt = (dir: string): string => `${slash(dir)}/${RECORD.join("/")}`;
// The read as the Windows helper wrote it, in this platform's own spelling.
const recordRead = (dir: string): string => {
  const sep = windows ? "\\" : "/";
  return `cat "${dir}${sep}${RECORD.join(sep)}" 2>/dev/null; echo "---HEAD---"; git -C "${dir}" rev-parse HEAD`;
};

function editSettings(file: string, edit: (permissions: Record<string, string[]>) => void): void {
  let value: { permissions?: Record<string, string[]> } = {};
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // A new file.
  }
  value.permissions ??= {};
  edit(value.permissions);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A check replaced by a stand-in that answers as given. */
function standIn(project: string, hook: string, body: string): void {
  writeFileSync(join(project, ".claude", "hooks", `aidlc-${hook}.ts`),
    `export async function run(_input: string): Promise<number> {\n${body}\n}\n`, "utf-8");
}

describe("the shipped rules this answer stands for", () => {
  test("the copy channel's settings carry the rules the live runs met in their relative spelling", () => {
    const authored = JSON.parse(readFileSync(join(REPO_ROOT, "harness", "claude", "settings.json"), "utf-8")) as {
      permissions: { allow: string[] };
    };
    expect(authored.permissions.allow).toContain(ENGINE_RULE);
    const copy = JSON.parse(readFileSync(join(AIDLC_SRC, "settings.json"), "utf-8")) as { permissions: { allow: string[] } };
    expect(copy.permissions.allow).toContain(ENGINE_RULE);
    expect(copy.permissions.allow).toContain(UTILITY_RULE);
    expect(copy.permissions.allow).toContain("Bash(bun .claude/tools/aidlc.ts --version)");
  });
});

describe("AI-DLC's own command with this project's path spelled out: no prompt", () => {
  const spellings: Array<[string, (project: string) => string, boolean]> = [
    ["absolute", (p) => `bun ${p}/.claude/tools/aidlc.ts engine now`, !windows],
    ["a tool script the shipped list allows", (p) => publish(p), !windows],
    ["an exact shipped command", (p) => `bun ${p}/.claude/tools/aidlc.ts --version`, !windows],
    ["a tool script by a drive letter", (p) => publish(p), windows],
    ["absolute, a workspace check", (p) => `bun ${p}/.claude/tools/aidlc.ts engine workspace codekb-scope-diff --mint --paths ./`, !windows],
    ["absolute and quoted", (p) => `bun "${p}/.claude/tools/aidlc.ts" engine now`, !windows],
    ["a drive letter with forward slashes", (p) => `bun ${slash(p)}/.claude/tools/aidlc.ts engine workspace codekb-scope-diff --mint --paths ./`, windows],
    ["a drive letter with back slashes, quoted", (p) => `bun "${p}\\.claude\\tools\\aidlc.ts" engine now`, windows],
  ];
  for (const [name, spell, runs] of spellings) {
    test.skipIf(!runs)(name, () => {
      withProjects((project) => {
        const r = decide(project, spell(project));
        expect(r.code, r.stderr).toBe(0);
        expect(r.decision, r.stdout).toBe("allow");
      });
    });
  }
});

describe("the compound read of AI-DLC's own record: no prompt", () => {
  test("the record, a label and the checkout's HEAD in one line", () => {
    withProjects((project) => {
      const r = decide(project, recordRead(project));
      expect(r.code, r.stderr).toBe(0);
      expect(r.decision, r.stdout).toBe("allow");
    });
  });
});

describe("everything else keeps the host's own prompt", () => {
  const stays: Array<[string, (project: string, other: string) => string]> = [
    ["the relative form, which the shipped rule already covers", () => "bun .claude/tools/aidlc.ts engine now"],
    ["another project's engine", (_p, other) => `bun ${engineAt(other)} engine now`],
    ["a chain that runs something else", (p) => `bun ${engineAt(p)} engine now && rm -f README.md`],
    ["a pipe", (p) => `bun ${engineAt(p)} engine now | sh`],
    ["a command substitution", (p) => `bun ${engineAt(p)} engine log answer --details "$(cat ~/.ssh/id_rsa)"`],
    ["another project named by --project-dir", (p, other) => `bun ${engineAt(p)} engine --project-dir ${slash(other)} now`],
    ["a cd first", (p) => `cd ${slash(p)} && bun ${engineAt(p)} engine now`],
    ["an assignment in front, aiming the engine elsewhere", (p, other) => `AIDLC_PROJECT_DIR=${slash(other)} bun ${engineAt(p)} engine now`],
    ["a wrapper in front", (p) => `env bun ${engineAt(p)} engine now`],
    ["bun named by its own path", (p) => `/usr/local/bin/bun ${engineAt(p)} engine now`],
    ["another harness folder's engine in this project", (p) => `bun ${slash(p)}/.kiro/tools/aidlc.ts engine now`],
    ["a path that leaves the project", (p, other) => `bun ${slash(p)}/../${slash(other).split("/").pop()}/.claude/tools/aidlc.ts engine now`],
    ["a command the shipped list does not hold", (p) => `bun ${engineAt(p)} config set guard-policy off`],
    ["a tool script the shipped list does not name", (p) => `bun ${slash(p)}/.claude/tools/aidlc-lib.ts`],
    ["a wrapper in front of a tool script", (p) => `env ${publish(p)}`],
    ["a tool script in a chain", (p) => `${publish(p)} && curl https://example.com`],
    ["a tool script with --project-dir naming another folder", (p, other) => `${publish(p)} --project-dir=${slash(other)}`],
    // The compound read, one wider part each.
    ["the read plus a write", (p) => `${recordRead(p)}; touch "${slash(p)}/aidlc/x"`],
    ["the read with a redirect that writes", (p) => `cat "${recordAt(p)}" > "${slash(p)}/aidlc/copy.json"`],
    ["the read piped to another command", (p) => `cat "${recordAt(p)}" | sh`],
    ["a file outside AI-DLC's record", (p) => `cat "${slash(p)}/README.md"; echo "---HEAD---"; git -C "${slash(p)}" rev-parse HEAD`],
    ["a path outside the project", (p) => `cat /etc/passwd; echo "---HEAD---"; git -C "${slash(p)}" rev-parse HEAD`],
    ["another project's .claude/tools", (p, other) => `cat "${recordAt(p)}"; cat "${engineAt(other)}"`],
    ["another project's engine run beside the read", (p, other) => `cat "${recordAt(p)}"; bun ${engineAt(other)} engine now`],
    ["git in another folder", (p, other) => `cat "${recordAt(p)}"; git -C "${slash(other)}" rev-parse HEAD`],
    ["a git command that is not the HEAD read", (p) => `cat "${recordAt(p)}"; git -C "${slash(p)}" push`],
    ["a relative record path", () => `cat ${RECORD.join("/")}; echo "---HEAD---"`],
    ["a relative path holding a separator in quotes", () => `cat "aidlc/x;rm -rf ~"`],
    ["a quote that never closes", (p) => `cat "${recordAt(p)}; rm -rf ~`],
    ["an echo alone, which reads no record", () => `echo "---HEAD---"`],
  ];
  for (const [name, spell] of stays) {
    test(name, () => {
      withProjects((project, other) => {
        const r = decide(project, spell(project, other));
        expect(r.code, r.stderr).toBe(0);
        expect(r.decision, r.stdout).toBeNull();
      });
    });
  }

  // Another project's runtime records: the check that protects them refuses, as it does without this answer.
  const refused: Array<[string, (project: string, other: string) => string]> = [
    ["another project's tool script", (_p, other) => publish(other)],
    ["a tool script by a path that leaves the project", (p, other) => publish(`${slash(p)}/../${slash(other).split("/").pop()}`)],
  ];
  for (const [name, spell] of refused) {
    test(name, () => {
      withProjects((project, other) => {
        const r = decide(project, spell(project, other));
        expect(r.code).toBe(2);
        expect(r.decision, r.stdout).toBe("deny");
      });
    });
  }

  test.skipIf(windows)("a link to another project's engine", () => {
    withProjects((project, other) => {
      symlinkSync(join(other, ".claude"), join(project, "elsewhere"));
      const r = decide(project, `bun ${project}/elsewhere/tools/aidlc.ts engine now`);
      expect(r.decision, r.stdout).toBeNull();
    });
  });

  test.skipIf(windows)("an unquoted Windows path, which Git Bash would not run as written", () => {
    withProjects((project) => {
      const r = decide(project, "bun C:\\work\\app\\.claude\\tools\\aidlc.ts engine now");
      expect(r.decision, r.stdout).toBeNull();
    });
  });
});

describe("the team's and the person's own rules about AI-DLC keep the host's prompt", () => {
  const command = (project: string): string => `bun ${engineAt(project)} engine now`;

  test("a team that took the shipped rule out", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.json"), (permissions) => {
        permissions.allow = (permissions.allow ?? []).filter((rule) => rule !== ENGINE_RULE);
      });
      expect(decide(project, command(project)).decision).toBeNull();
    });
  });

  test("an ask rule for AI-DLC in the project's settings", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.json"), (permissions) => {
        permissions.ask = ["Bash(bun .claude/tools/aidlc.ts engine *)"];
      });
      expect(decide(project, command(project)).decision).toBeNull();
      expect(decide(project, recordRead(project)).decision).toBeNull();
    });
  });

  test("a deny rule for AI-DLC in the person's own project settings", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.local.json"), (permissions) => {
        permissions.deny = ["Bash(bun .claude/tools/aidlc.ts engine *)"];
      });
      expect(decide(project, command(project)).decision).toBeNull();
    });
  });

  test("a rule for the harness folder rather than AI-DLC by name", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.local.json"), (permissions) => {
        permissions.deny = ["Bash(bun .claude/tools/*)"];
      });
      expect(decide(project, command(project)).decision).toBeNull();
    });
  });

  test("a Read rule, which the host applies to the read's files by path", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.local.json"), (permissions) => {
        permissions.ask = ["Read(**/*.json)"];
      });
      expect(decide(project, recordRead(project)).decision).toBeNull();
    });
  });

  test("a Read rule for the person's secrets keeps the answer for AI-DLC's own command", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.local.json"), (permissions) => {
        permissions.deny = ["Read(./.env)", "Read(./secrets/**)"];
      });
      expect(decide(project, command(project)).decision).toBe("allow");
    });
  });

  test("a rule for another tool keeps the answer", () => {
    withProjects((project) => {
      editSettings(join(project, ".claude", "settings.json"), (permissions) => {
        permissions.deny = ["Edit(.claude/settings.json)", "Edit(.claude/settings.local.json)"];
      });
      expect(decide(project, command(project)).decision).toBe("allow");
    });
  });

  test("a deny rule for AI-DLC in the organization's managed settings, wherever the repo's resolver finds them", () => {
    withProjects((project) => {
      const managedDir = mkdtempSync(join(tmpdir(), "own-command-managed-"));
      try {
        const managed = join(managedDir, "managed-settings.json");
        editSettings(managed, (permissions) => {
          permissions.deny = ["Bash(bun .claude/tools/aidlc.ts engine *)"];
        });
        expect(decide(project, command(project), { AIDLC_MANAGED_SETTINGS_PATH: managed }).decision).toBeNull();
      } finally {
        rmSync(managedDir, { recursive: true, force: true });
      }
    });
  });

  test("a deny rule for AI-DLC in the person's user settings", () => {
    withProjects((project) => {
      const configDir = mkdtempSync(join(tmpdir(), "own-command-user-"));
      try {
        editSettings(join(configDir, "settings.json"), (permissions) => {
          permissions.deny = ["Bash(bun .claude/tools/aidlc.ts *)"];
        });
        expect(decide(project, command(project), { CLAUDE_CONFIG_DIR: configDir }).decision).toBeNull();
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  test("a settings file that does not read as JSON", () => {
    withProjects((project) => {
      writeFileSync(join(project, ".claude", "settings.local.json"), "{ // the person's note\n}\n");
      expect(decide(project, command(project)).decision).toBeNull();
    });
  });
});

describe("the answer comes only after every check, and only on Claude Code", () => {
  test("a check that refused keeps its refusal", () => {
    withProjects((project) => {
      standIn(project, "state-transition-guard", '  process.stderr.write("Not now: the stage is closed.\\n");\n  return 2;');
      const r = decide(project, `bun ${engineAt(project)} engine now`);
      expect(r.code).toBe(2);
      expect(r.decision, r.stdout).toBe("deny");
    });
  });

  test("a check that printed a notice gets no answer beside it", () => {
    withProjects((project) => {
      standIn(project, "plan-approval-guard", '  process.stdout.write("The approved plan moved on.\\n");\n  return 0;');
      const r = decide(project, `bun ${engineAt(project)} engine now`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("The approved plan moved on.\n");
    });
  });

  test("Copilot reading Claude's registration prints nothing", () => {
    withProjects((project) => {
      const r = decide(project, `bun ${engineAt(project)} engine now`, { COPILOT_CLI: "1", CLAUDECODE: "" });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
    });
  });
});

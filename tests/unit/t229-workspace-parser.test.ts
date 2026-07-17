// covers: subcommand:aidlc-utility:space, subcommand:aidlc-utility:intent, subcommand:aidlc-utility:space-create
// covers: function:parseWorkspaceCommand, function:workspaceCommandUtilityArgv, function:classifyTerminalCommand
// covers: function:RESERVED_RECORD_NAMES
// covers: function:splitDoubleQuotedArgs

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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  birthIntent,
  classifyTerminalCommand,
  parseWorkspaceCommand,
  RESERVED_RECORD_NAME_LIST,
  RESERVED_RECORD_NAMES,
  splitDoubleQuotedArgs,
  workspaceCommandUtilityArgv,
} from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const ORCH = join(REPO_ROOT, "core", "tools", "aidlc-orchestrate.ts");
const UTIL = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
const CORE_TOOLS_DIR = join(REPO_ROOT, "core", "tools");
const DIST_DATA = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data");
const TOOL_ENV = {
  AIDLC_STAGE_GRAPH: join(DIST_DATA, "stage-graph.json"),
  AIDLC_SCOPE_GRID: join(DIST_DATA, "scope-grid.json"),
};

function scratchProject(): string {
  return mkdtempSync(join(tmpdir(), "t229-"));
}

function cleanup(dir: string): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function runNext(projectDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [ORCH, "--project-dir", projectDir, "next", ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    env: { ...process.env, ...TOOL_ENV },
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runUtility(projectDir: string, args: string[]): { status: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync("bun", [UTIL, ...args, "--project-dir", projectDir], {
    cwd: projectDir,
    encoding: "utf-8",
    env: { ...process.env, ...TOOL_ENV },
    timeout: 30_000,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status ?? -1, stdout, stderr, out: stdout + stderr };
}

function runDispatcher(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...TOOL_ENV,
    AIDLC_DISPATCH_TOOLS_DIR: CORE_TOOLS_DIR,
  };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync("bun", [DISPATCHER, ...args], {
    cwd,
    encoding: "utf-8",
    env,
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function directive(projectDir: string, args: string[]): Record<string, string> {
  const r = runNext(projectDir, args);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as Record<string, string>;
}

function commandInvocation(cmd: NonNullable<ReturnType<typeof classifyTerminalCommand>>): string {
  if (cmd.error) return `error: ${cmd.error}`;
  const tail = cmd.args ?? (cmd.arg !== undefined ? [cmd.arg] : []);
  return [cmd.subcommand, ...tail].join(" ");
}

function seedIntent(projectDir: string, slug: string, dirName: string): void {
  const intentsRoot = join(projectDir, "aidlc", "spaces", "default", "intents");
  const recordDir = join(intentsRoot, dirName);
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n", "utf-8");
  writeFileSync(join(recordDir, "aidlc-state.md"), "# AI-DLC State Tracking\n", "utf-8");
  writeFileSync(join(intentsRoot, "active-intent"), `${dirName}\n`, "utf-8");
  writeFileSync(
    join(intentsRoot, "intents.json"),
    `${JSON.stringify(
      [{ uuid: `00000000-0000-7000-8000-${slug.padEnd(12, "0").slice(0, 12)}`, slug, dirName, status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

describe("parseWorkspaceCommand", () => {
  test("ports the spike parser cases for space create, switch sugar, and legacy space-create", () => {
    expect(parseWorkspaceCommand(["space", "create", "teamB"])).toEqual({
      kind: "create",
      noun: "space",
      name: "teamB",
    });
    expect(parseWorkspaceCommand(["space", "My Space"])).toEqual({
      kind: "switch",
      noun: "space",
      name: "My Space",
      explicit: false,
    });
    expect(parseWorkspaceCommand(["space-create", "teamB"])).toEqual({
      kind: "create",
      noun: "space",
      name: "teamB",
    });
  });

  test("ports the spike parser cases for intent list, explicit switch, and birth rest", () => {
    expect(parseWorkspaceCommand(["intent", "260711-simple-calc"])).toEqual({
      kind: "switch",
      noun: "intent",
      name: "260711-simple-calc",
      explicit: false,
    });
    expect(parseWorkspaceCommand(["intent", "list"])).toEqual({
      kind: "list",
      noun: "intent",
      json: false,
    });
    expect(parseWorkspaceCommand(["intent", "list", "--json"])).toEqual({
      kind: "list",
      noun: "intent",
      json: true,
    });
    expect(parseWorkspaceCommand(["intent", "switch", "list"])).toEqual({
      kind: "switch",
      noun: "intent",
      name: "list",
      explicit: true,
    });
    expect(parseWorkspaceCommand(["intent", "switch"])).toMatchObject({
      kind: "error",
      noun: "intent",
      code: "missing-name",
      verb: "switch",
      message: "Usage: aidlc intent switch <name>",
    });
    expect(parseWorkspaceCommand(["intent", "birth", "--scope", "poc", "--label", "x"])).toEqual({
      kind: "birth",
      noun: "intent",
      rest: ["--scope", "poc", "--label", "x"],
    });
  });

  test("utility argv keeps the explicit switch token for verb-shaped names", () => {
    const command = parseWorkspaceCommand(["intent", "switch", "birth"]);
    expect(command).toEqual({
      kind: "switch",
      noun: "intent",
      name: "birth",
      explicit: true,
    });
    expect(workspaceCommandUtilityArgv(command)).toEqual(["intent", "switch", "birth"]);
  });

  test("migration delta missing-name and reserved-future verbs are errors, not sugar switches", () => {
    expect(parseWorkspaceCommand(["space", "create"])).toMatchObject({
      kind: "error",
      noun: "space",
      code: "missing-name",
      message: "Usage: aidlc space create <name>",
    });
    expect(parseWorkspaceCommand(["space", "switch"])).toMatchObject({
      kind: "error",
      noun: "space",
      code: "missing-name",
      message: "Usage: aidlc space switch <name>",
    });
    for (const noun of ["intent", "space"] as const) {
      for (const verb of ["archive", "rename", "show"]) {
        const parsed = parseWorkspaceCommand([noun, verb, "foo"]);
        expect(parsed).toMatchObject({
          kind: "error",
          noun,
          code: "reserved-future-verb",
          verb,
        });
        expect(parsed.kind === "error" ? parsed.message : "").toContain(`${noun} switch ${verb}`);
      }
    }
  });

  test("help and not-workspace cases are preserved", () => {
    expect(parseWorkspaceCommand(["space", "help"])).toEqual({ kind: "help", noun: "space" });
    expect(parseWorkspaceCommand(["intent", "-h"])).toEqual({ kind: "help", noun: "intent" });
    expect(parseWorkspaceCommand(["status"])).toEqual({ kind: "not-workspace" });
    expect(parseWorkspaceCommand(["scope", "change"])).toEqual({ kind: "not-workspace" });
    expect(parseWorkspaceCommand(["build", "a", "space", "station"])).toEqual({ kind: "not-workspace" });
  });

  test("reserved record names include help, current verbs, and future verbs", () => {
    expect(RESERVED_RECORD_NAME_LIST).toEqual([
      "help",
      "list",
      "switch",
      "birth",
      "create",
      "archive",
      "rename",
      "show",
    ]);
    for (const name of RESERVED_RECORD_NAME_LIST) {
      expect(RESERVED_RECORD_NAMES.has(name)).toBe(true);
    }
    expect(RESERVED_RECORD_NAMES.has("teamB")).toBe(false);
  });
});

describe("classifier and next parser parity", () => {
  test("workspace migration rows render the same utility subcommand at both call sites", () => {
    const rows: Array<{ args: string[]; invocation: string }> = [
      { args: ["space"], invocation: "space" },
      { args: ["space", "teamB"], invocation: "space teamB" },
      { args: ["space", "create", "teamB"], invocation: "space-create teamB" },
      { args: ["space", "list"], invocation: "space" },
      { args: ["space", "list", "--json"], invocation: "space --json" },
      { args: ["space", "switch", "teamB"], invocation: "space switch teamB" },
      { args: ["space-create", "teamB"], invocation: "space-create teamB" },
      { args: ["intent", "some-slug"], invocation: "intent some-slug" },
      { args: ["intent", "list"], invocation: "intent" },
      { args: ["intent", "list", "--json"], invocation: "intent --json" },
      { args: ["intent", "switch", "list"], invocation: "intent switch list" },
      { args: ["intent", "birth", "--scope", "poc", "--label", "x"], invocation: "intent-birth --scope poc --label x" },
      { args: ["space", "foo", "--status"], invocation: "space foo" },
    ];
    for (const row of rows) {
      const cmd = classifyTerminalCommand(row.args);
      expect(cmd, row.args.join(" ")).not.toBeNull();
      expect(commandInvocation(cmd!), row.args.join(" ")).toBe(row.invocation);

      const projectDir = scratchProject();
      try {
        const d = directive(projectDir, row.args);
        expect(d.kind, row.args.join(" ")).toBe("print");
        expect(d.message, row.args.join(" ")).toContain(`aidlc-utility.ts ${row.invocation}`);
      } finally {
        cleanup(projectDir);
      }
    }
  });

  test("parser errors agree between classifier and next", () => {
    const rows = [
      { args: ["space", "create"], message: "Usage: aidlc space create <name>" },
      { args: ["space", "switch"], message: "Usage: aidlc space switch <name>" },
      { args: ["intent", "switch"], message: "Usage: aidlc intent switch <name>" },
      { args: ["intent", "archive", "foo"], message: "intent archive is reserved for a future workspace verb" },
    ];
    for (const row of rows) {
      const cmd = classifyTerminalCommand(row.args);
      expect(cmd?.error, row.args.join(" ")).toContain(row.message);

      const projectDir = scratchProject();
      try {
        const d = directive(projectDir, row.args);
        expect(d.kind, row.args.join(" ")).toBe("error");
        expect(d.message, row.args.join(" ")).toContain(row.message);
      } finally {
        cleanup(projectDir);
      }
    }
  });

  test("non-leading workspace words stay non-terminal at both call sites", () => {
    const cmd = classifyTerminalCommand(["build", "a", "space", "station"]);
    expect(cmd).toBeNull();
    const projectDir = scratchProject();
    try {
      const d = directive(projectDir, ["build", "a", "space", "station"]);
      expect(d.kind).toBe("ask");
    } finally {
      cleanup(projectDir);
    }
  });

  test("precedence pin: leading workspace command wins over a later --status at both sites", () => {
    const cmd = classifyTerminalCommand(["space", "foo", "--status"]);
    expect(cmd).toEqual({
      subcommand: "space",
      arg: "foo",
      source: "workspace-verb",
    });
    const projectDir = scratchProject();
    try {
      const d = directive(projectDir, ["space", "foo", "--status"]);
      expect(d.kind).toBe("print");
      expect(d.message).toContain("aidlc-utility.ts space foo");
      expect(d.message).not.toContain("aidlc-utility.ts status");
    } finally {
      cleanup(projectDir);
    }
  });
});

describe("utility handlers and reservation chokepoints", () => {
  test("intent and space handlers accept explicit list, switch, create, and JSON forms", () => {
    const projectDir = scratchProject();
    try {
      birthIntent(projectDir, "alpha-work", "default", "feature");

      const intents = runUtility(projectDir, ["intent", "list", "--json"]);
      expect(intents.status).toBe(0);
      const intentPayload = JSON.parse(intents.stdout) as { active: string | null; intents: Array<{ slug: string }> };
      expect(intentPayload.active).not.toBeNull();
      expect(intentPayload.intents.map((i) => i.slug)).toContain("alpha-work");

      const create = runUtility(projectDir, ["space", "create", "My Space"]);
      expect(create.status).toBe(0);
      expect(create.stdout).toContain("Space created: my-space");

      const spaces = runUtility(projectDir, ["space", "list", "--json"]);
      expect(spaces.status).toBe(0);
      const spacePayload = JSON.parse(spaces.stdout) as { spaces: Array<{ name: string }> };
      expect(spacePayload.spaces.map((s) => s.name)).toContain("my-space");

      const switched = runUtility(projectDir, ["space", "switch", "My Space"]);
      expect(switched.status).toBe(0);
      expect(switched.stdout).toContain("Active space");
      expect(readFileSync(join(projectDir, "aidlc", "active-space"), "utf-8").trim()).toBe("my-space");
    } finally {
      cleanup(projectDir);
    }
  });

  test("engine and dispatcher switch to a verb-named intent without birthing", () => {
    const projectDir = scratchProject();
    try {
      seedIntent(projectDir, "birth", "260711-birth");
      const registry = join(projectDir, "aidlc", "spaces", "default", "intents", "intents.json");
      const before = readFileSync(registry, "utf-8");

      const d = directive(projectDir, ["intent", "switch", "birth"]);
      expect(d.kind).toBe("print");
      expect(d.message).toContain("aidlc-utility.ts intent switch birth");

      const r = runDispatcher(REPO_ROOT, [
        "intent",
        "switch",
        "birth",
        "--project-dir",
        projectDir,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Active intent");
      expect(r.stderr).toBe("");
      expect(readFileSync(registry, "utf-8")).toBe(before);
      expect(readFileSync(join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim()).toBe("260711-birth");
    } finally {
      cleanup(projectDir);
    }
  });

  test("birthIntent and space-create refuse every reserved record name", () => {
    for (const name of RESERVED_RECORD_NAME_LIST) {
      const projectDir = scratchProject();
      try {
        expect(() => birthIntent(projectDir, name, "default", "feature"), name).toThrow("reserved name");
        const r = runUtility(projectDir, ["space-create", name]);
        expect(r.status, name).not.toBe(0);
        if (name === "help") {
          expect(r.out).toContain("Did you mean /aidlc --help");
        } else {
          expect(r.out).toContain("reserved name");
        }
      } finally {
        cleanup(projectDir);
      }
    }
  });

  test("doctor flags pre-existing verb-named spaces and active-space intents as an advisory", () => {
    const projectDir = scratchProject();
    try {
      mkdirSync(join(projectDir, "aidlc", "spaces", "list", "intents"), { recursive: true });
      seedIntent(projectDir, "birth", "260711-birth");
      const r = runUtility(projectDir, ["doctor"]);
      expect(r.out).toContain(
        "Workspace names shadowing grammar verbs (advisory): space 'list', intent 'birth' - reachable via explicit switch; consider renaming.",
      );
    } finally {
      cleanup(projectDir);
    }
  });
});

describe("Kiro quoted argv tokenizer", () => {
  test("double-quoted segments stay one token and quotes are stripped", () => {
    expect(splitDoubleQuotedArgs('space create "My Space"')).toEqual([
      "space",
      "create",
      "My Space",
    ]);
    expect(splitDoubleQuotedArgs('intent switch "list item"')).toEqual([
      "intent",
      "switch",
      "list item",
    ]);
    expect(splitDoubleQuotedArgs('space create "A \\"Quoted\\" Space"')).toEqual([
      "space",
      "create",
      'A "Quoted" Space',
    ]);
  });

  test("quoted multi-word name reaches the classifier as one semantic name token", () => {
    const args = splitDoubleQuotedArgs('space create "My Space"');
    const cmd = classifyTerminalCommand(args);
    expect(cmd).toEqual({
      subcommand: "space-create",
      arg: "My Space",
      source: "workspace-verb",
    });
  });

  test("engine directives preserve multi-word workspace arguments", () => {
    const projectDir = scratchProject();
    try {
      const cases = [
        {
          args: ["space", "create", "My Space"],
          command: "aidlc-utility.ts space-create 'My Space'",
        },
        {
          args: ["space", "switch", "My Space"],
          command: "aidlc-utility.ts space switch 'My Space'",
        },
        {
          args: ["intent", "birth", "--scope", "poc", "--label", "My Work"],
          command: "aidlc-utility.ts intent-birth --scope poc --label 'My Work'",
        },
      ];
      for (const item of cases) {
        const result = directive(projectDir, item.args);
        expect(result.kind, item.args.join(" ")).toBe("print");
        expect(result.message, item.args.join(" ")).toContain(item.command);
      }
    } finally {
      cleanup(projectDir);
    }
  });
});

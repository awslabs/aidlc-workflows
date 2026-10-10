// covers: subcommand:aidlc-utility:space, subcommand:aidlc-utility:intent, subcommand:aidlc-utility:space-create
// covers: function:parseWorkspaceCommand, function:workspaceCommandUtilityArgv, function:classifyTerminalCommand
// covers: function:RESERVED_RECORD_NAMES
// covers: function:splitDoubleQuotedArgs

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
  createIntent,
  classifyTerminalCommand,
  INTENT_VERBS,
  parseWorkspaceCommand,
  RESERVED_RECORD_NAME_LIST,
  RESERVED_RECORD_NAMES,
  SPACE_VERBS,
  splitDoubleQuotedArgs,
  workspaceCommandUtilityArgv,
} from "../../core/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runUtility(projectDir: string, args: string[]): { status: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync("bun", [UTIL, ...args, "--project-dir", projectDir], {
    cwd: projectDir,
    encoding: "utf-8",
    env: { ...process.env, ...TOOL_ENV },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

  test("ports the spike parser cases for intent list, explicit switch, and create rest", () => {
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
    expect(parseWorkspaceCommand(["intent", "create", "--scope", "poc", "--label", "x"])).toEqual({
      kind: "create-intent",
      noun: "intent",
      rest: ["--scope", "poc", "--label", "x"],
    });
  });

  test("utility argv keeps the explicit switch token for verb-shaped names", () => {
    const command = parseWorkspaceCommand(["intent", "switch", "archive"]);
    expect(command).toEqual({
      kind: "switch",
      noun: "intent",
      name: "archive",
      explicit: true,
    });
    expect(workspaceCommandUtilityArgv(command)).toEqual(["intent", "switch", "archive"]);
  });

  test("space creation rejects trailing flags instead of routing them to another command", () => {
    for (const tokens of [
      ["space", "create", "target", "--guard-policy", "relaxed"],
      ["space-create", "target", "--guard-policy", "relaxed"],
    ]) {
      expect(parseWorkspaceCommand(tokens)).toMatchObject({
        kind: "error",
        code: "unexpected-arguments",
      });
    }
  });

  // What the person types after a name rides with the switch, whole, flags
  // included: the agent acts on it for the work just selected. The utility
  // argv never carries it.
  test("a switch keeps every word after the name for the agent, never for the utility", () => {
    for (const [tokens, explicit, words] of [
      [["intent", "auth", "fix", "the", "login", "bug", "today"], false, ["fix", "the", "login", "bug", "today"]],
      [["intent", "switch", "auth", "fix", "the", "login", "bug", "today"], true, ["fix", "the", "login", "bug", "today"]],
      [["intent", "auth", "--guard-policy", "relaxed"], false, ["--guard-policy", "relaxed"]],
      [["intent", "switch", "auth", "--guard-policy", "relaxed"], true, ["--guard-policy", "relaxed"]],
      [["space", "teamb", "--guard-policy", "relaxed"], false, ["--guard-policy", "relaxed"]],
      [["space", "switch", "teamb", "--guard-policy", "relaxed"], true, ["--guard-policy", "relaxed"]],
    ] as const) {
      const command = parseWorkspaceCommand([...tokens]);
      expect(command, tokens.join(" ")).toEqual({ kind: "switch", noun: tokens[0], name: explicit ? tokens[2] : tokens[1], explicit, words: [...words] });
      expect(workspaceCommandUtilityArgv(command), tokens.join(" ")).toEqual(
        explicit ? [tokens[0], "switch", tokens[2]] : [tokens[0], tokens[1]],
      );
    }
    expect(parseWorkspaceCommand(["intent", "auth"])).toEqual({ kind: "switch", noun: "intent", name: "auth", explicit: false });
  });

  test("migration delta missing-name cases are errors, not sugar switches", () => {
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
  });

  test("a word that is no verb is the switch sugar at both sites, rename, show and birth included", () => {
    for (const noun of ["intent", "space"] as const) {
      for (const name of ["rename", "show", "birth"]) {
        expect(parseWorkspaceCommand([noun, name])).toEqual({ kind: "switch", noun, name, explicit: false });
        expect(classifyTerminalCommand([noun, name])).toEqual({ subcommand: noun, arg: name, source: "workspace-verb" });
      }
    }
  });

  test("intent add-repo / remove-repo parse as repo commands that forward verbatim", () => {
    expect(parseWorkspaceCommand(["intent", "add-repo", "app-b"])).toEqual({
      kind: "add-repo",
      noun: "intent",
      name: "app-b",
      rest: [],
    });
    expect(
      workspaceCommandUtilityArgv({ kind: "add-repo", noun: "intent", name: "app-b", rest: [] }),
    ).toEqual(["intent", "add-repo", "app-b"]);
    expect(parseWorkspaceCommand(["intent", "remove-repo", "app-b"])).toEqual({
      kind: "remove-repo",
      noun: "intent",
      name: "app-b",
      rest: [],
    });
    expect(parseWorkspaceCommand(["intent", "add-repo"])).toMatchObject({
      kind: "error",
      code: "missing-name",
      verb: "add-repo",
    });
  });

  test("intent archive / unarchive parse as lifecycle commands that forward verbatim (issue #980)", () => {
    expect(parseWorkspaceCommand(["intent", "archive", "260903-old-spike"])).toEqual({
      kind: "archive",
      noun: "intent",
      name: "260903-old-spike",
      rest: [],
    });
    // Trailing flags ride along untouched, so `--reason` reaches the utility.
    const withReason = parseWorkspaceCommand([
      "intent", "archive", "260903-old-spike", "--reason", "superseded by the v2 design",
    ]);
    expect(withReason).toEqual({
      kind: "archive",
      noun: "intent",
      name: "260903-old-spike",
      rest: ["--reason", "superseded by the v2 design"],
    });
    expect(workspaceCommandUtilityArgv(withReason)).toEqual([
      "intent", "archive", "260903-old-spike", "--reason", "superseded by the v2 design",
    ]);
    expect(parseWorkspaceCommand(["intent", "unarchive", "260903-old-spike"])).toEqual({
      kind: "unarchive",
      noun: "intent",
      name: "260903-old-spike",
      rest: [],
    });
    // A missing name (or a flag where the name should be) is a usage error, not
    // a switch to a record named "archive".
    for (const verb of ["archive", "unarchive"] as const) {
      expect(parseWorkspaceCommand(["intent", verb])).toMatchObject({
        kind: "error",
        noun: "intent",
        code: "missing-name",
        verb,
        message: `Usage: aidlc intent ${verb} <name>`,
      });
      expect(parseWorkspaceCommand(["intent", verb, "--reason", "x"])).toMatchObject({
        kind: "error",
        code: "missing-name",
        verb,
      });
    }
    // Spaces have no lifecycle verbs: `space archive x` stays a bare-name switch
    // sugar (no space is ever named "archive", so it reads as an unknown space).
    expect(parseWorkspaceCommand(["space", "archive", "x"])).toEqual({
      kind: "switch",
      noun: "space",
      name: "archive",
      explicit: false,
      words: ["x"],
    });
  });

  test("intent list --all includes archived records; the plain list shape is unchanged", () => {
    expect(parseWorkspaceCommand(["intent", "list", "--all"])).toEqual({
      kind: "list",
      noun: "intent",
      json: false,
      all: true,
    });
    expect(parseWorkspaceCommand(["intent", "--all"])).toEqual({
      kind: "list",
      noun: "intent",
      json: false,
      all: true,
    });
    expect(parseWorkspaceCommand(["intent", "list", "--json", "--all"])).toEqual({
      kind: "list",
      noun: "intent",
      json: true,
      all: true,
    });
    expect(parseWorkspaceCommand(["intent", "--all", "--json"])).toEqual({
      kind: "list",
      noun: "intent",
      json: true,
      all: true,
    });
    expect(workspaceCommandUtilityArgv(parseWorkspaceCommand(["intent", "list", "--json", "--all"]))).toEqual([
      "intent", "--json", "--all",
    ]);
    // The two-field shape every existing consumer matches is untouched.
    expect(parseWorkspaceCommand(["intent", "list"])).toEqual({ kind: "list", noun: "intent", json: false });
    expect(parseWorkspaceCommand(["intent", "--json"])).toEqual({ kind: "list", noun: "intent", json: true });
    expect(parseWorkspaceCommand(["space", "list", "--all"])).toEqual({ kind: "list", noun: "space", json: false });
  });

  test("help and not-workspace cases are preserved", () => {
    expect(parseWorkspaceCommand(["space", "help"])).toEqual({ kind: "help", noun: "space" });
    expect(parseWorkspaceCommand(["intent", "-h"])).toEqual({ kind: "help", noun: "intent" });
    expect(parseWorkspaceCommand(["status"])).toEqual({ kind: "not-workspace" });
    expect(parseWorkspaceCommand(["scope", "change"])).toEqual({ kind: "not-workspace" });
    expect(parseWorkspaceCommand(["build", "a", "space", "station"])).toEqual({ kind: "not-workspace" });
  });

  test("reserved record names are help and the current verbs", () => {
    expect(RESERVED_RECORD_NAME_LIST).toEqual([
      "help",
      "list",
      "switch",
      "create",
      "archive",
      "unarchive",
      "add-repo",
      "remove-repo",
    ]);
    for (const name of RESERVED_RECORD_NAME_LIST) {
      expect(RESERVED_RECORD_NAMES.has(name)).toBe(true);
    }
    expect(RESERVED_RECORD_NAMES.has("teamB")).toBe(false);
  });
});

describe("classifier and next parser parity", () => {
  test("workspace migration rows render the same utility subcommand at both call sites", () => {
    const rows: Array<{ args: string[]; invocation: string; route: string }> = [
      { args: ["space"], invocation: "space", route: "space list" },
      { args: ["space", "teamB"], invocation: "space teamB", route: "space teamB" },
      { args: ["space", "create", "teamB"], invocation: "space-create teamB", route: "space create teamB" },
      { args: ["space", "list"], invocation: "space", route: "space list" },
      { args: ["space", "list", "--json"], invocation: "space --json", route: "space list --json" },
      { args: ["space", "switch", "teamB"], invocation: "space switch teamB", route: "space switch teamB" },
      { args: ["space-create", "teamB"], invocation: "space-create teamB", route: "space create teamB" },
      { args: ["intent", "some-slug"], invocation: "intent some-slug", route: "intent some-slug" },
      { args: ["intent", "list"], invocation: "intent", route: "intent list" },
      { args: ["intent", "list", "--json"], invocation: "intent --json", route: "intent list --json" },
      { args: ["intent", "switch", "list"], invocation: "intent switch list", route: "intent switch list" },
    ];
    for (const row of rows) {
      const cmd = classifyTerminalCommand(row.args);
      expect(cmd, row.args.join(" ")).not.toBeNull();
      expect(commandInvocation(cmd!), row.args.join(" ")).toBe(row.invocation);

      const projectDir = scratchProject();
      try {
        // A name is the switch only for a record that exists (the classifier,
        // asked without a project, classifies the shape alone).
        if (row.args[0] === "intent" && row.args[1] === "some-slug") seedIntent(projectDir, "some-slug", "260711-some-slug");
        if (row.args[0] === "intent" && row.args[1] === "switch") seedIntent(projectDir, row.args[2], `260711-${row.args[2]}`);
        if (row.args[0] === "space" && row.args.includes("teamB")) {
          // Stored under its slug, as the utility stores a space.
          mkdirSync(join(projectDir, "aidlc", "spaces", "teamb", "intents"), { recursive: true });
        }
        const d = directive(projectDir, row.args);
        expect(d.kind, row.args.join(" ")).toBe("print");
        expect(d.message, row.args.join(" ")).toContain(`aidlc.ts engine ${row.route}`);
      } finally {
        cleanup(projectDir);
      }
    }
  });

  test("intent create stays on the session-aware workflow path", () => {
    const args = ["intent", "create", "--scope", "poc", "--label", "x"];
    expect(classifyTerminalCommand(args)).toBeNull();

    const projectDir = scratchProject();
    try {
      const d = directive(projectDir, args);
      expect(d.kind).toBe("print");
      expect(d.message).toContain("aidlc.ts engine intent create --scope poc --label x");
    } finally {
      cleanup(projectDir);
    }
  });

  test("parser errors agree between classifier and next", () => {
    const rows = [
      { args: ["space", "create"], message: "Usage: aidlc space create <name>" },
      { args: ["space", "switch"], message: "Usage: aidlc space switch <name>" },
      { args: ["intent", "switch"], message: "Usage: aidlc intent switch <name>" },
      { args: ["intent", "archive"], message: "Usage: aidlc intent archive <name>" },
      { args: ["intent", "unarchive"], message: "Usage: aidlc intent unarchive <name>" },
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

  test("a flag after a workspace name is the person's word for the agent at both sites, never a mode switch", () => {
    // The seam never runs it off-band: the conductor gets it through `next`.
    expect(classifyTerminalCommand(["space", "foo", "--status"])).toBeNull();
    const projectDir = scratchProject();
    try {
      // No space is named foo: the agent reads the whole line.
      const unknown = directive(projectDir, ["space", "foo", "--status"]);
      expect(unknown.kind, JSON.stringify(unknown)).toBe("print");
      expect(unknown.message).toContain('The person typed: "space foo --status"');
      expect(unknown.message).not.toContain("aidlc.ts engine status");
      expect(unknown.message).not.toContain("Usage:");
      // With the space there, it switches and the flag rides along for the agent.
      mkdirSync(join(projectDir, "aidlc", "spaces", "foo", "intents"), { recursive: true });
      const d = directive(projectDir, ["space", "foo", "--status"]);
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expect(d.message).toContain("aidlc.ts engine space foo`");
      expect(d.message).toContain('The person also asked: "--status"');
      expect(d.message).not.toContain("aidlc.ts engine status");
    } finally {
      cleanup(projectDir);
    }
  });
});

describe("utility handlers and reservation chokepoints", () => {
  test("intent and space handlers accept explicit list, switch, create, and JSON forms", () => {
    const projectDir = scratchProject();
    try {
      createIntent(projectDir, "alpha-work", "default", "feature");

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
      expect(switched.stdout).toContain("Now working in space `my-space`.");
      expect(switched.stdout).not.toContain("Active space");
      expect(readFileSync(join(projectDir, "aidlc", "active-space"), "utf-8").trim()).toBe("my-space");
    } finally {
      cleanup(projectDir);
    }
  });

  test("engine and dispatcher switch to a verb-named intent without creating", () => {
    const projectDir = scratchProject();
    try {
      seedIntent(projectDir, "archive", "260711-archive");
      const registry = join(projectDir, "aidlc", "spaces", "default", "intents", "intents.json");
      const before = readFileSync(registry, "utf-8");

      const d = directive(projectDir, ["intent", "switch", "archive"]);
      expect(d.kind).toBe("print");
      expect(d.message).toContain("aidlc.ts engine intent switch archive");

      const r = runDispatcher(REPO_ROOT, [
        "engine",
        "intent",
        "switch",
        "archive",
        "--project-dir",
        projectDir,
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Now working on `archive`.");
      expect(r.stdout).not.toContain("Active intent");
      expect(r.stderr).toBe("");
      expect(readFileSync(registry, "utf-8")).toBe(before);
      expect(readFileSync(join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim()).toBe("260711-archive");
    } finally {
      cleanup(projectDir);
    }
  });

  // A word after `intent` or `space` that is neither a verb nor a record's exact
  // name never becomes a name and never reaches the person as "Unknown intent":
  // the engine hands the agent the noun's verbs, the records there and the words
  // whole, to read what the person meant (a mistyped verb or name, or something
  // the noun cannot do) and run that command, or ask them once.
  const INTENT_VERB_LIST = "list, switch <name>, create, archive <name>, unarchive <name>, add-repo <name>, remove-repo <name>";
  const SPACE_VERB_LIST = "list, switch <name>, create <name>";
  function activeIntentCursor(projectDir: string): string {
    const path = join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent");
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }
  function expectUnknownWordStep(d: Record<string, string>, noun: "intent" | "space", typed: string): void {
    expect(d.kind, JSON.stringify(d)).toBe("print");
    expect(d.narration, JSON.stringify(d)).toBeUndefined();
    expect(d.message).toContain(`The ${noun} verbs are: ${noun === "intent" ? INTENT_VERB_LIST : SPACE_VERB_LIST}`);
    for (const verb of noun === "intent" ? INTENT_VERBS : SPACE_VERBS) expect(d.message).toContain(verb);
    expect(d.message).toContain(`The person typed: "${typed}"`);
    expect(d.message).toContain("Read what they meant and run that command; if you cannot tell, ask them once in plain words.");
    expect(d.message).toContain("nothing ran and nothing changed");
    expect(d.message).not.toContain("Unknown");
    expect(d.message).not.toContain("reserved");
  }

  test("a word that is neither a verb nor an intent goes to the agent with the verbs and the intents, whole", () => {
    const projectDir = scratchProject();
    try {
      seedIntent(projectDir, "auth", "260711-auth");
      const cursor = activeIntentCursor(projectDir);
      // A verb that does not exist; a verb mistyped; a name mistyped; a verb
      // typed by its name.
      for (const [typed, args] of [
        ["intent show", ["intent", "show"]],
        ["intent rename foo", ["intent", "rename", "foo"]],
        ["intent swtich auth", ["intent", "swtich", "auth"]],
        ["intent auht", ["intent", "auht"]],
        ["intent switch auht", ["intent", "switch", "auht"]],
      ] as const) {
        const d = directive(projectDir, [...args]);
        expectUnknownWordStep(d, "intent", typed);
        expect(d.message, typed).toContain("The intents here are: auth.");
        expect(d.message, typed).not.toContain("engine intent show");
        expect(d.message, typed).not.toContain("engine intent switch auht");
      }
      // Rename is no intent verb: the agent reads that from the list it is given.
      expect(INTENT_VERB_LIST).not.toContain("rename");
      // The classifier agrees when it knows the project: none of these is run off-band.
      for (const args of [["intent", "show"], ["intent", "auht"], ["intent", "switch", "auht"], ["intent", "auth", "fix", "it"], ["intent", "switch", "auth", "fix", "it"]]) {
        expect(classifyTerminalCommand(args, projectDir), args.join(" ")).toBeNull();
      }
      expect(classifyTerminalCommand(["intent", "auth"], projectDir)).toEqual({ subcommand: "intent", arg: "auth", source: "workspace-verb" });
      expect(classifyTerminalCommand(["intent", "switch", "auth"], projectDir)).toEqual({ subcommand: "intent", args: ["switch", "auth"], source: "workspace-verb" });
      // Nothing was selected by any of it.
      expect(activeIntentCursor(projectDir)).toBe(cursor);
    } finally {
      cleanup(projectDir);
    }
  });

  test("the unknown-word step lists the recent intents, capped, and says how many more", () => {
    const projectDir = scratchProject();
    try {
      const intentsRoot = join(projectDir, "aidlc", "spaces", "default", "intents");
      mkdirSync(intentsRoot, { recursive: true });
      writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n", "utf-8");
      const slugs = Array.from({ length: 23 }, (_, i) => `work-${String(i + 1).padStart(2, "0")}`);
      writeFileSync(join(intentsRoot, "intents.json"), `${JSON.stringify(slugs.map((slug, i) =>
        ({ uuid: `00000000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`, slug, dirName: `2607${String(i + 1).padStart(2, "0")}-${slug}`, status: "in-flight" })), null, 2)}\n`, "utf-8");
      const d = directive(projectDir, ["intent", "wrok-23"]);
      expectUnknownWordStep(d, "intent", "intent wrok-23");
      // Newest first, twenty of them, the rest counted.
      expect(d.message).toContain(`The intents here are: ${[...slugs].reverse().slice(0, 20).join(", ")} (and 3 more; `);
      expect(d.message).toContain("intent list --all` shows them all).");
      expect(d.message).not.toContain("work-01,");
      expect(d.message).not.toContain("work-03,");
    } finally {
      cleanup(projectDir);
    }
  });

  test("a word that is neither a verb nor a space goes to the agent with the verbs and the spaces", () => {
    const projectDir = scratchProject();
    try {
      mkdirSync(join(projectDir, "aidlc", "spaces", "teamb", "intents"), { recursive: true });
      writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n", "utf-8");
      for (const [typed, args] of [
        ["space show", ["space", "show"]],
        ["space rename foo", ["space", "rename", "foo"]],
        ["space swtich teamb", ["space", "swtich", "teamb"]],
        ["space teanb", ["space", "teanb"]],
        ["space switch teanb", ["space", "switch", "teanb"]],
      ] as const) {
        const d = directive(projectDir, [...args]);
        expectUnknownWordStep(d, "space", typed);
        expect(d.message, typed).toContain("The spaces here are: teamb, default.");
      }
      expect(classifyTerminalCommand(["space", "show"], projectDir)).toBeNull();
      expect(classifyTerminalCommand(["space", "teamb"], projectDir)).toEqual({ subcommand: "space", arg: "teamb", source: "workspace-verb" });
      expect(readFileSync(join(projectDir, "aidlc", "active-space"), "utf-8")).toBe("default\n");
      // A space really named show switches by its exact name, like any other.
      mkdirSync(join(projectDir, "aidlc", "spaces", "show", "intents"), { recursive: true });
      const d = directive(projectDir, ["space", "show"]);
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expect(d.message).toContain("aidlc.ts engine space show");
      // With no records at all, the step says so instead of listing.
      const empty = scratchProject();
      try {
        expect(directive(empty, ["intent", "show"]).message).toContain("No intent exists here yet.");
      } finally {
        cleanup(empty);
      }
    } finally {
      cleanup(projectDir);
    }
  });

  test("words after a name switch and reach the agent whole, flags included", () => {
    const projectDir = scratchProject();
    try {
      seedIntent(projectDir, "auth", "260711-auth");
      for (const [args, words] of [
        [["intent", "auth", "fix", "the", "login", "bug", "today"], "fix the login bug today"],
        [["intent", "switch", "auth", "fix", "the", "login", "bug", "today"], "fix the login bug today"],
        [["intent", "auth", "--guard-policy", "relaxed"], "--guard-policy relaxed"],
        [["intent", "switch", "auth", "--guard-policy", "relaxed"], "--guard-policy relaxed"],
      ] as const) {
        const d = directive(projectDir, [...args]);
        expect(d.kind, args.join(" ")).toBe("print");
        expect(d.message, args.join(" ")).toContain(args[1] === "switch" ? "aidlc.ts engine intent switch auth`" : "aidlc.ts engine intent auth`");
        expect(d.message, args.join(" ")).toContain(`The person also asked: "${words}". Act on that for the work just selected`);
        expect(d.message, args.join(" ")).toContain("ask them once in plain words if you cannot tell what they meant");
        expect(d.message, args.join(" ")).not.toContain("then stop");
        expect(d.message, args.join(" ")).not.toContain("Usage:");
      }
      // Nothing is read into the words by the tool: the switch command carries none of them.
      expect(directive(projectDir, ["intent", "auth", "--guard-policy", "relaxed"]).message).not.toContain("engine intent auth --guard-policy");
    } finally {
      cleanup(projectDir);
    }
  });

  // `/aidlc intent show` selects the record named show, as any other name does;
  // the words rename, show and birth are no longer held back for verbs to come.
  test("engine and dispatcher switch to a record named show without the switch verb", () => {
    const projectDir = scratchProject();
    try {
      seedIntent(projectDir, "show", "260711-show");
      const registry = join(projectDir, "aidlc", "spaces", "default", "intents", "intents.json");
      const before = readFileSync(registry, "utf-8");

      const d = directive(projectDir, ["intent", "show"]);
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expect(d.message).toContain("aidlc.ts engine intent show");
      expect(d.message).not.toContain("reserved");

      const r = runDispatcher(REPO_ROOT, ["engine", "intent", "show", "--project-dir", projectDir]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("Now working on `show`.");
      expect(r.stderr).toBe("");
      expect(readFileSync(registry, "utf-8")).toBe(before);
      expect(readFileSync(join(projectDir, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim()).toBe("260711-show");
      // A shell has no agent to hand extra words to: the dispatcher says the usage line.
      const extra = runDispatcher(REPO_ROOT, ["engine", "intent", "show", "extra", "--project-dir", projectDir]);
      expect(extra.status).not.toBe(0);
      expect(`${extra.stdout}${extra.stderr}`).toContain("Usage: aidlc intent switch <name>");
      // Creation is unchanged: a record may be named show.
      const made = scratchProject();
      try {
        expect(() => createIntent(made, "show", "default", "feature")).not.toThrow();
      } finally {
        cleanup(made);
      }
    } finally {
      cleanup(projectDir);
    }
  });

  test("createIntent and space-create refuse every reserved record name", () => {
    for (const name of RESERVED_RECORD_NAME_LIST) {
      const projectDir = scratchProject();
      try {
        expect(() => createIntent(projectDir, name, "default", "feature"), name).toThrow("reserved name");
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
      seedIntent(projectDir, "archive", "260711-archive");
      const r = runUtility(projectDir, ["doctor", "--verbose"]);
      expect(r.out).toContain(
        "Workspace names shadowing grammar verbs (advisory): space 'list', intent 'archive' - reachable via explicit switch; consider renaming.",
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
      // The space the switch selects is stored under its slug.
      mkdirSync(join(projectDir, "aidlc", "spaces", "my-space", "intents"), { recursive: true });
      const cases = [
        {
          args: ["space", "create", "My Space"],
          command: "aidlc.ts engine space create 'My Space'",
        },
        {
          args: ["space", "switch", "My Space"],
          command: "aidlc.ts engine space switch 'My Space'",
        },
        {
          args: ["intent", "create", "--scope", "poc", "--label", "My Work"],
          command: "aidlc.ts engine intent create --scope poc --label 'My Work'",
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

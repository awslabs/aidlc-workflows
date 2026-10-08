// covers: function:refreshActiveMemory, function:refreshActiveMemoryCopy, function:activeMemoryCopyDrift, function:addRootBlocks, function:kiroIdeSteering
//
// t-active-space-includes: every harness's native rule include reads ONE fixed,
// git-ignored location, aidlc/active-memory/ (ACTIVE_MEMORY_DIR), and
// the engine writes the active space's memory files into it. So a space switch
// changes no tracked file: the includes are the same for every teammate, and
// each person's copy follows their own gitignored active-space cursor.
//
// INVARIANTS asserted:
//   1. Every shipped include names the copy and none names a space's files
//      directly: Claude's @-stub, Kiro's agents/*.json resources, Cursor's
//      rules, opencode.json's instructions, AI-DLC's part of Copilot's
//      AGENTS.md, and the persona bodies that read the method by path. Codex
//      ships no AIDLC_RULES_DIR seam.
//   2. Every harness's shipped .gitignore ignores the copy.
//   3. refreshActiveMemory writes the requested space's files into the copy,
//      removes files that space no longer has, is a no-op when current, and
//      never writes through a link.
//   4. Through the real CLI: `space switch` in a git repo leaves `git status`
//      clean while the copy holds the switched space's text, and the
//      session-start hook brings an edit of a memory file into the copy.
//   5. Kiro IDE's steering file keeps carrying the memory text (it does not
//      expand file references), written by the same refresh.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { sha256Bytes, unionBlocks } from "../../core/tools/aidlc-distribution.ts";
import {
  ACTIVE_MEMORY_DIR,
  activeMemoryCopyDrift,
  addRootBlocks,
  kiroIdeSteering,
  refreshActiveMemory,
} from "../../core/tools/aidlc-includes.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const distSurface = (h: string, ...parts: string[]): string =>
  join(REPO_ROOT, "dist", h, ...parts);
const portablePaths = (paths: string[]): string[] =>
  paths.map((path) => path.replaceAll("\\", "/"));
const COPY = "aidlc/active-memory";
const MEMORY_FILES = [
  "org.md",
  "team.md",
  "project.md",
  "phases/ideation.md",
  "phases/inception.md",
  "phases/construction.md",
  "phases/operation.md",
];

const scratch: string[] = [];
const savedHarness = process.env.AIDLC_HARNESS_DIR;
const savedHarnessName = process.env.AIDLC_HARNESS_NAME;

afterEach(() => {
  if (savedHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
  else process.env.AIDLC_HARNESS_DIR = savedHarness;
  if (savedHarnessName === undefined) delete process.env.AIDLC_HARNESS_NAME;
  else process.env.AIDLC_HARNESS_NAME = savedHarnessName;
  for (const d of scratch.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "t-asi-"));
  scratch.push(d);
  return d;
}

// Two spaces' memory trees (so activeSpace and the resolver have a default to
// fall back to), and the active-space cursor when given.
function seedSpaces(root: string, cursor?: string): void {
  for (const sp of ["default", "teamB"]) {
    mkdirSync(join(root, "aidlc", "spaces", sp, "memory", "phases"), { recursive: true });
    writeFileSync(join(root, "aidlc", "spaces", sp, "memory", "org.md"), `# org ${sp}\n`);
  }
  if (cursor !== undefined) {
    mkdirSync(join(root, "aidlc"), { recursive: true });
    writeFileSync(join(root, "aidlc", "active-space"), `${cursor}\n`);
  }
}

const copyFile = (root: string, rel: string): string => readFileSync(join(root, ...COPY.split("/"), ...rel.split("/")), "utf-8");

describe("t-active-space-includes: every shipped include reads the copy", () => {
  test("ACTIVE_MEMORY_DIR is the fixed path the includes name", () => {
    expect(ACTIVE_MEMORY_DIR).toBe(COPY);
  });

  test("Claude: the @-stub imports each method file from the copy and names no space", () => {
    const stub = readFileSync(distSurface("claude", ".claude", "rules", "aidlc.md"), "utf-8");
    const atLines = stub.split("\n").filter((line) => line.startsWith("@"));
    expect(atLines).toEqual(MEMORY_FILES.map((file) => `@../../${COPY}/${file}`));
    expect(stub).not.toContain("aidlc/spaces/default/memory");
  });

  test("Kiro CLI: every agent JSON's resources glob reads the copy", () => {
    const agentsDir = distSurface("kiro", ".kiro", "agents");
    const withMemory = readdirSync(agentsDir).filter((name) => name.endsWith(".json")).filter((name) => {
      const config = JSON.parse(readFileSync(join(agentsDir, name), "utf-8")) as { resources?: string[] };
      if (!Array.isArray(config.resources)) return false;
      expect(config.resources.some((entry) => entry.startsWith("file://aidlc/spaces/")), name).toBe(false);
      return config.resources.includes(`file://${COPY}/**/*.md`);
    });
    expect(withMemory.length).toBeGreaterThanOrEqual(15);
  });

  test("Cursor: the standing and phase rules and the persona bodies read the copy", () => {
    const rulesDir = distSurface("cursor", ".cursor", "rules");
    const standing = readFileSync(join(rulesDir, "aidlc.mdc"), "utf-8");
    for (const file of ["org.md", "team.md", "project.md"]) expect(standing).toContain(`- ${COPY}/${file}`);
    for (const phase of ["ideation", "inception", "construction", "operation"]) {
      expect(readFileSync(join(rulesDir, `aidlc-phase-${phase}.mdc`), "utf-8")).toContain(`- ${COPY}/phases/${phase}.md`);
    }
    for (const name of readdirSync(rulesDir).filter((file) => file.endsWith(".mdc") && file !== "aidlc-onboarding.mdc")) {
      expect(readFileSync(join(rulesDir, name), "utf-8"), name).not.toContain("aidlc/spaces/default/memory/");
    }
    const persona = readFileSync(distSurface("cursor", ".cursor", "agents", "aidlc-architect-agent.md"), "utf-8");
    expect(persona).toContain(`${COPY}/`);
    expect(persona).not.toContain("aidlc/spaces/default/memory/");
  });

  test("opencode: the instructions glob and the persona bodies read the copy", () => {
    const config = JSON.parse(readFileSync(distSurface("opencode", "opencode.json"), "utf-8")) as { instructions: string[] };
    expect(config.instructions).toContain(`${COPY}/**/*.md`);
    expect(config.instructions.some((entry) => entry.includes("aidlc/spaces/"))).toBe(false);
    for (const rel of [[".opencode", "agents"], [".aidlc", "agents"]]) {
      const persona = readFileSync(distSurface("opencode", ...rel, "aidlc-architect-agent.md"), "utf-8");
      expect(persona, rel.join("/")).toContain(`${COPY}/`);
      expect(persona, rel.join("/")).not.toContain("aidlc/spaces/default/memory/");
    }
  });

  test("Copilot: AI-DLC's part of AGENTS.md imports the copy, and so do the persona twins", () => {
    const agentsMd = readFileSync(distSurface("copilot", "AGENTS.md"), "utf-8");
    const atLines = agentsMd.split("\n").filter((line) => line.startsWith("@"));
    expect(atLines).toEqual(MEMORY_FILES.map((file) => `@${COPY}/${file}`));
    for (const rel of [[".github", "agents"], [".aidlc", "agents"]]) {
      const persona = readFileSync(distSurface("copilot", ...rel, "aidlc-architect-agent.md"), "utf-8");
      expect(persona, rel.join("/")).toContain(`${COPY}/`);
      expect(persona, rel.join("/")).not.toContain("aidlc/spaces/default/memory/");
    }
  });

  test("Codex: no include and no AIDLC_RULES_DIR seam; the engine hands each step its rules", () => {
    const config = readFileSync(distSurface("codex", ".codex", "config.toml"), "utf-8");
    expect(config).not.toContain("AIDLC_RULES_DIR");
    expect(config).not.toContain("[shell_environment_policy]");
  });

  test("every harness's shipped .gitignore ignores the copy", () => {
    const harnesses = readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(harnesses.length).toBeGreaterThanOrEqual(7);
    for (const harness of harnesses) {
      const ignore = readFileSync(join(REPO_ROOT, "harness", harness, "dot-gitignore"), "utf-8");
      expect(ignore.split("\n"), harness).toContain("aidlc/active-memory/");
    }
    // The part a copy runtime adds to a team's .gitignore carries it too.
    expect(readFileSync(distSurface("copilot", ".aidlc", "tools", "data", "root-blocks", "gitignore"), "utf-8").split("\n"))
      .toContain("aidlc/active-memory/");
  });
});

describe("t-active-space-includes: refreshActiveMemory writes the space's memory into the copy", () => {
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".claude";
    process.env.AIDLC_HARNESS_NAME = "claude";
  });

  function setup(): string {
    const root = freshRoot();
    seedSpaces(root);
    writeFileSync(join(root, "aidlc", "spaces", "default", "memory", "notes.md"), "# notes default\n");
    writeFileSync(join(root, "aidlc", "spaces", "teamB", "memory", "team.md"), "# team teamB\n");
    writeFileSync(join(root, "aidlc", "spaces", "teamB", "memory", "phases", "ideation.md"), "# ideation teamB\n");
    return root;
  }

  test("writes the requested space's files, then is a no-op; a switch back removes what that space lacks", () => {
    const root = setup();
    expect(portablePaths(refreshActiveMemory(root, "teamB"))).toEqual([COPY]);
    expect(copyFile(root, "org.md")).toBe("# org teamB\n");
    expect(copyFile(root, "team.md")).toBe("# team teamB\n");
    expect(copyFile(root, "phases/ideation.md")).toBe("# ideation teamB\n");
    expect(existsSync(join(root, ...COPY.split("/"), "notes.md"))).toBe(false);
    expect(activeMemoryCopyDrift(root, "teamB")).toEqual([]);
    expect(refreshActiveMemory(root, "teamB")).toEqual([]);

    expect(portablePaths(refreshActiveMemory(root, "default"))).toEqual([COPY]);
    expect(copyFile(root, "org.md")).toBe("# org default\n");
    expect(copyFile(root, "notes.md")).toBe("# notes default\n");
    expect(existsSync(join(root, ...COPY.split("/"), "team.md"))).toBe(false);
    expect(existsSync(join(root, ...COPY.split("/"), "phases", "ideation.md"))).toBe(false);
    expect(activeMemoryCopyDrift(root, "default")).toEqual([]);
    // The drift names what the copy lacks for the other space.
    expect(activeMemoryCopyDrift(root, "teamB").sort()).toEqual(["notes.md", "org.md", "phases/ideation.md", "team.md"]);
  });

  test("an edit of a memory file reaches the copy at the next refresh, and the source is never touched", () => {
    const root = setup();
    refreshActiveMemory(root, "teamB");
    writeFileSync(join(root, "aidlc", "spaces", "teamB", "memory", "team.md"), "# team teamB\n\nEvery queue has a dead-letter alarm.\n");
    expect(activeMemoryCopyDrift(root, "teamB")).toEqual(["team.md"]);
    expect(portablePaths(refreshActiveMemory(root, "teamB"))).toEqual([COPY]);
    expect(copyFile(root, "team.md")).toContain("dead-letter alarm");
    expect(readFileSync(join(root, "aidlc", "spaces", "teamB", "memory", "team.md"), "utf-8")).toContain("dead-letter alarm");
  });

  test("the cursor decides the space when none is given; cursorless means default", () => {
    const cursorless = setup();
    expect(portablePaths(refreshActiveMemory(cursorless))).toEqual([COPY]);
    expect(copyFile(cursorless, "org.md")).toBe("# org default\n");
    // A cursor names a space by its slug (lowercase), as `space create` makes it.
    const onTeam = setup();
    mkdirSync(join(onTeam, "aidlc", "spaces", "team-b", "memory"), { recursive: true });
    writeFileSync(join(onTeam, "aidlc", "spaces", "team-b", "memory", "org.md"), "# org team-b\n");
    writeFileSync(join(onTeam, "aidlc", "active-space"), "team-b\n");
    expect(portablePaths(refreshActiveMemory(onTeam))).toEqual([COPY]);
    expect(copyFile(onTeam, "org.md")).toBe("# org team-b\n");
  });

  test("a copy folder that leads out of the project is not written through", () => {
    const root = setup();
    const outside = freshRoot();
    mkdirSync(join(root, "aidlc"), { recursive: true });
    symlinkSync(outside, join(root, "aidlc", "active-memory"), process.platform === "win32" ? "junction" : "dir");
    expect(refreshActiveMemory(root, "teamB")).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
  });
});

// The same through the real CLI, in a git repository, on the harness whose
// switch rewrote the most tracked files (15 Kiro agent JSONs).
describe("t-active-space-includes: a space switch changes no tracked file", () => {
  const BUN = process.execPath;
  const UTILITY = join(REPO_ROOT, "core", "tools", "aidlc-utility.ts");
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV }, timeout: NATIVE_STARTUP_TIMEOUT_MS });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout;
  }

  function engine(cwd: string, args: string[], env: Record<string, string>): { status: number; out: string } {
    const machine = freshRoot();
    const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", cwd], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share"), AIDLC_BIN_DIR: join(machine, "bin"), ...env },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  function sessionStart(root: string, env: Record<string, string>): void {
    const started = spawnSync(BUN, [join(root, ".kiro", "hooks", "aidlc-session-start.ts")], {
      cwd: root,
      input: "{}",
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
  }

  test("Kiro CLI: switch leaves git clean, the copy holds the switched space, and the hook carries an edit", () => {
    const root = freshRoot();
    cpSync(distSurface("kiro", ".kiro"), join(root, ".kiro"), { recursive: true });
    cpSync(distSurface("kiro", "aidlc"), join(root, "aidlc"), { recursive: true });
    cpSync(distSurface("kiro", ".gitignore"), join(root, ".gitignore"));
    const env = { AIDLC_HARNESS_DIR: ".kiro", AIDLC_HARNESS_NAME: "kiro" };
    // The first chat of a copied install adds AI-DLC's part of the root files
    // and writes the copy; the team commits that state.
    sessionStart(root, env);
    expect(copyFile(root, "org.md")).toBe(readFileSync(join(root, "aidlc", "spaces", "default", "memory", "org.md"), "utf-8"));
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "install");
    expect(git(root, "ls-files", "--", "aidlc/active-memory")).toBe("");
    const created = engine(root, ["space", "create", "teamb"], env);
    expect(created.status, created.out).toBe(0);
    writeFileSync(join(root, "aidlc", "spaces", "teamb", "memory", "team.md"), "# Team\n\nEvery queue has a dead-letter alarm.\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "a second space");

    const switched = engine(root, ["space", "switch", "teamb"], env);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("Now working in space `teamb`.");
    expect(switched.out).not.toContain("repointed");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(copyFile(root, "team.md")).toContain("dead-letter alarm");
    expect(copyFile(root, "org.md")).toBe(readFileSync(join(root, "aidlc", "spaces", "teamb", "memory", "org.md"), "utf-8"));
    // The agent files still read the copy, byte for byte as installed.
    expect(JSON.parse(readFileSync(join(root, ".kiro", "agents", "aidlc-developer-agent.json"), "utf-8")).resources)
      .toContain(`file://${COPY}/**/*.md`);

    // An edit of a memory file reaches the copy at the next session start.
    writeFileSync(join(root, "aidlc", "spaces", "teamb", "memory", "team.md"), "# Team\n\nEvery alarm names its runbook.\n");
    sessionStart(root, env);
    expect(copyFile(root, "team.md")).toContain("names its runbook");
    expect(git(root, "status", "--porcelain")).toBe(" M aidlc/spaces/teamb/memory/team.md\n");
  });
});

describe("t-active-space-includes: Kiro IDE steering carries the active space's memory text", () => {
  // Kiro IDE does not expand `#[[file:]]` references in steering (1.2.4), so the
  // always-included file holds the memory files' text itself (#2023).
  beforeEach(() => {
    process.env.AIDLC_HARNESS_DIR = ".kiro";
    process.env.AIDLC_HARNESS_NAME = "kiro-ide";
  });

  function setup(): { root: string; steeringPath: string } {
    const root = freshRoot();
    seedSpaces(root);
    const steeringDir = join(root, ".kiro", "steering");
    mkdirSync(steeringDir, { recursive: true });
    const steeringPath = join(steeringDir, "aidlc-active-memory.md");
    cpSync(distSurface("kiro-ide", ".kiro", "steering", "aidlc-active-memory.md"), steeringPath);
    return { root, steeringPath };
  }

  test("writes the requested space's memory text into the always-included steering file, beside the copy", () => {
    const { root, steeringPath } = setup();
    const written = portablePaths(refreshActiveMemory(root, "teamB"));
    expect(written).toEqual([COPY, ".kiro/steering/aidlc-active-memory.md"]);

    const after = readFileSync(steeringPath, "utf-8");
    expect(after).toMatch(/^---\ninclusion: always\n---\n/);
    expect(after).toContain('<memory-file path="aidlc/spaces/teamB/memory/org.md">\n# org teamB\n</memory-file>');
    expect(after).not.toContain("aidlc/spaces/default/memory/");
    expect(after).not.toContain("#[[file:");
  });

  test("writing it again for the same space is a no-op", () => {
    const { root, steeringPath } = setup();
    expect(portablePaths(refreshActiveMemory(root, "default"))).toEqual([COPY, ".kiro/steering/aidlc-active-memory.md"]);
    const before = readFileSync(steeringPath, "utf-8");
    expect(refreshActiveMemory(root, "default")).toEqual([]);
    expect(readFileSync(steeringPath, "utf-8")).toBe(before);
  });

  test("a memory with no file to inline gets the authored reference form, byte for byte", () => {
    const root = freshRoot();
    expect(kiroIdeSteering(root, "default")).toEqual({
      text: readFileSync(join(REPO_ROOT, "harness", "kiro-ide", "steering", "aidlc-active-memory.md"), "utf-8"),
      inlined: [],
    });
  });

  test("the shipped file is what the engine writes for the shipped memory", () => {
    const shipped = kiroIdeSteering(distSurface("kiro-ide"), "default");
    expect(readFileSync(distSurface("kiro-ide", ".kiro", "steering", "aidlc-active-memory.md"), "utf-8")).toBe(shipped.text);
    expect(shipped.inlined).toContain("aidlc/spaces/default/memory/team.md");
  });

  test("a steering folder that leads out of the project is not written through", () => {
    const root = freshRoot();
    seedSpaces(root);
    const outside = freshRoot();
    mkdirSync(join(root, ".kiro"), { recursive: true });
    symlinkSync(outside, join(root, ".kiro", "steering"), process.platform === "win32" ? "junction" : "dir");
    expect(portablePaths(refreshActiveMemory(root, "default"))).toEqual([COPY]);
    expect(readdirSync(outside)).toEqual([]);
  });
});

// A copy runtime leaves the team's .gitignore and AGENTS.md out and ships
// AI-DLC's part of each in the harness folder (root-blocks). Where config never
// ran, the engine adds that part after the team's content, once.
describe("t-active-space-includes: AI-DLC's part of the team's root files", () => {
  const blocks = join(distSurface("copilot", ".aidlc"), "tools", "data", "root-blocks");
  const gitignorePart = (): string =>
    `# BEGIN AI-DLC:gitignore\n${readFileSync(join(blocks, "gitignore"), "utf-8").trim()}\n# END AI-DLC:gitignore\n`;
  const agentsPart = (): string =>
    `<!-- BEGIN AI-DLC:agents -->\n${readFileSync(join(blocks, "agents"), "utf-8").trim()}\n<!-- END AI-DLC:agents -->\n`;
  function copiedProject(): string {
    const root = freshRoot();
    cpSync(distSurface("copilot", ".aidlc"), join(root, ".aidlc"), { recursive: true });
    return root;
  }

  test("keeps the team's .gitignore and AGENTS.md byte for byte and adds AI-DLC's part once", () => {
    const root = copiedProject();
    writeFileSync(join(root, ".gitignore"), "node_modules\n.env.local\n");
    writeFileSync(join(root, "AGENTS.md"), "# Shop\n\nOur own notes for agents.\n");
    expect(addRootBlocks(root).sort()).toEqual([".gitignore", "AGENTS.md"]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`node_modules\n.env.local\n\n${gitignorePart()}`);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(`# Shop\n\nOur own notes for agents.\n\n${agentsPart()}`);
    // A second session changes nothing.
    expect(addRootBlocks(root)).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`node_modules\n.env.local\n\n${gitignorePart()}`);
  });

  test("a project without the files gets only AI-DLC's part", () => {
    const root = copiedProject();
    addRootBlocks(root);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(gitignorePart());
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(agentsPart());
  });

  test("an earlier release's unchanged copy keeps its template lines as the team's own", () => {
    const root = copiedProject();
    const template = [
      "# Logs", "logs", "*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*",
      "pnpm-debug.log*", "lerna-debug.log*", "", "node_modules", "dist", "dist-ssr", "*.local", "",
      "# Editor directories and files", ".vscode/*", "!.vscode/extensions.json", ".idea", ".DS_Store",
      "*.suo", "*.ntvs*", "*.njsproj", "*.sln", "*.sw?",
    ].join("\n");
    const earlier = `${template}\n\n${readFileSync(join(blocks, "gitignore"), "utf-8")}`;
    // The release that shipped it lists it among the files it recognises.
    const descriptorPath = join(root, ".aidlc", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.rootIntegrations.find((integration: { path: string }) => integration.path === ".gitignore")
      .legacySignatures.wholeFileHashes.push(sha256Bytes(earlier));
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    writeFileSync(join(root, ".gitignore"), earlier);
    expect(addRootBlocks(root)).toContain(".gitignore");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(`${template}\n\n${gitignorePart()}`);
  });

  // Earlier parts had notes above each group of entries, and two harnesses'
  // parts were combined under a heading per harness. A part with exactly the
  // shipped entries is AI-DLC's own whatever its notes, so it becomes the
  // plain part: one comment line, then every harness's entries.
  test("an earlier part with notes, alone or combined, becomes the plain part", () => {
    const root = copiedProject();
    cpSync(distSurface("kiro", ".kiro"), join(root, ".kiro"), { recursive: true });
    const kiroBlock = readFileSync(join(distSurface("kiro", ".kiro"), "tools", "data", "root-blocks", "gitignore"), "utf-8");
    const plain = unionBlocks([
      { distribution: "copilot", text: readFileSync(join(blocks, "gitignore"), "utf-8") },
      { distribution: "kiro", text: kiroBlock },
    ]);
    const entries = plain.split("\n").filter((line) => !line.startsWith("#"));
    const earlier = [
      "# AI-DLC, the committed and ignored split.",
      "# Per-user cursors are ignored.",
      ...entries.slice(0, 3),
      "#",
      "# Machine-local runtime is ignored.",
      ...entries.slice(3, -2),
      "",
      "# kiro harness",
      ...entries.slice(-2),
    ].join("\n");
    writeFileSync(join(root, ".gitignore"), `node_modules\n\n# BEGIN AI-DLC:gitignore\n${earlier}\n# END AI-DLC:gitignore\n`);
    expect(addRootBlocks(root)).toContain(".gitignore");
    const written = readFileSync(join(root, ".gitignore"), "utf-8");
    expect(written).toBe(`node_modules\n\n# BEGIN AI-DLC:gitignore\n${plain}\n# END AI-DLC:gitignore\n`);
    expect(written).toContain("aidlc/.aidlc-turn-counter");
    expect(written.split("\n").filter((line) => line.startsWith("#") && !/^# (BEGIN|END) AI-DLC:/.test(line)))
      .toEqual(["# AI-DLC: local working files"]);
  });

  test("a part the team changed, and a project config manages, are left as they are", () => {
    const changed = copiedProject();
    const edited = gitignorePart().replace("# END AI-DLC:gitignore", "our-own-line\n# END AI-DLC:gitignore");
    writeFileSync(join(changed, ".gitignore"), edited);
    writeFileSync(join(changed, "AGENTS.md"), "# Shop\n");
    expect(addRootBlocks(changed)).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(changed, ".gitignore"), "utf-8")).toBe(edited);

    const configured = copiedProject();
    writeFileSync(join(configured, ".aidlc", "tools", "data", "aidlc-manifest.json"), "{}\n");
    writeFileSync(join(configured, ".gitignore"), "node_modules\n");
    expect(addRootBlocks(configured)).toEqual([]);
    expect(readFileSync(join(configured, ".gitignore"), "utf-8")).toBe("node_modules\n");
    expect(readdirSync(configured)).not.toContain("AGENTS.md");
  });

  test("files the Cursor installer manages are left to it", () => {
    const root = copiedProject();
    const installed = "node_modules\n\n# BEGIN AIDLC CURSOR\naidlc/active-space\n# END AIDLC CURSOR\n";
    writeFileSync(join(root, ".gitignore"), installed);
    writeFileSync(join(root, "AGENTS.md"), "<!-- BEGIN AIDLC CURSOR -->\n# AI-DLC\n<!-- END AIDLC CURSOR -->\n");
    expect(addRootBlocks(root)).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe(installed);
  });

  test("nothing outside the project is read or written, whatever the harness folder declares", () => {
    const root = copiedProject();
    const outside = freshRoot();
    const descriptorPath = join(root, ".aidlc", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    const escaping = `../${basename(outside)}/escaped`;
    descriptor.rootIntegrations.push(
      { path: escaping, policy: "managed-block", marker: "escape" },
      { path: "linked/AGENTS.md", policy: "managed-block", marker: "linked" },
      { path: "notes.md", policy: "managed-block", marker: "../../../outside" },
    );
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    for (const marker of ["escape", "linked"]) {
      writeFileSync(join(root, ".aidlc", "tools", "data", "root-blocks", marker), "export EVIL=1\n");
    }
    symlinkSync(outside, join(root, "linked"), "dir");
    // The team's AGENTS.md is a link to a file outside: it is not written through.
    writeFileSync(join(outside, "AGENTS.md"), "# elsewhere\n");
    symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    expect(addRootBlocks(root)).toEqual([".gitignore"]);
    expect(existsSync(join(outside, "escaped"))).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(outside, "AGENTS.md"), "utf-8")).toBe("# elsewhere\n");
    expect(existsSync(join(root, "notes.md"))).toBe(false);
  });

  test("a part written at session start names the person's active space", () => {
    const root = copiedProject();
    mkdirSync(join(root, "aidlc", "spaces", "team-b", "memory", "phases"), { recursive: true });
    writeFileSync(join(root, "aidlc", "spaces", "team-b", "memory", "org.md"), "# org team-b\n");
    writeFileSync(join(root, "aidlc", "active-space"), "team-b\n");
    const started = spawnSync(process.execPath, [join(root, ".aidlc", "hooks", "aidlc-session-start.ts")], {
      cwd: root,
      input: "{}",
      encoding: "utf-8",
      env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc", AIDLC_HARNESS_NAME: "copilot" },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- BEGIN AI-DLC:agents -->");
    // The part reads the copy, whichever space is active; the copy holds that space's text.
    expect(agents).toContain(`@${COPY}/org.md`);
    expect(agents).not.toContain("@aidlc/spaces/");
    expect(copyFile(root, "org.md")).toBe("# org team-b\n");
  });
});

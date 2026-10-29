// covers: function:repoNameProblem, function:isValidRepoName, function:repoNameRefusal, function:discoverSiblingRepos, function:quoteCommandArgument, function:readsAlikeInDoubleQuotes, function:codeGenerationPlanNamedPaths, function:resolveConstructionRepo, cli:aidlc-utility(intent-create), cli:aidlc-utility(intent set-repos), subcommand:aidlc-utility:codekb-path, subcommand:aidlc-utility:codekb-snapshot, subcommand:aidlc-utility:codekb-publish, subcommand:aidlc-utility:codekb-scope-diff
//
// A workspace keeps several repos side by side, and each repo is the folder the
// person named, as they named it: a space, an accent, an apostrophe or another
// letter. The work is created with every such repo, Reverse Engineering's tools
// read and write its store under that name, a plan's files in it are the plan's
// own, and a command AI-DLC prints carries the name whole. A name is left out
// only where it breaks something named (repoNameProblem): that folder is not
// part of the work, and the first step says which and why. The accent case runs
// in both Unicode spellings, because a name on macOS can come back decomposed
// (NFD) where Windows and Linux usually keep it composed (NFC).

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  DEFAULT_SPACE,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
} from "../harness/fixtures.ts";
import {
  discoverSiblingRepos,
  isValidRepoName,
  parseSourceListing,
  readIntentRegistry,
  repoNameProblem,
  resolveConstructionRepo,
  serializeSourceListing,
  sourcePathKey,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { codeGenerationPlanNamedPaths } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";

resetAidlcEnv();
setDefaultTimeout(NATIVE_STARTUP_TIMEOUT_MS * 4);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const CAFE_NFC = "caf\u00e9";
const CAFE_NFD = "cafe\u0301";
const ARTIFACT_NAMES = [
  "api-documentation.md",
  "architecture.md",
  "business-overview.md",
  "code-quality-assessment.md",
  "code-structure.md",
  "component-inventory.md",
  "dependencies.md",
  "reverse-engineering-timestamp.md",
  "technology-stack.md",
];

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// An empty workspace holding a git repo in a folder with each of these names.
function workspace(...repos: string[]): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  for (const name of repos) {
    const dir = join(proj, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "greet.py"), 'def greet(name):\n    return "hello " + name\n');
    git(dir, "init", "-q");
    git(dir, "add", "src");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  }
  return proj;
}

function utility(proj: string, args: string[]) {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const result = spawnSync(process.execPath, [UTILITY, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function created(proj: string): string[] {
  const made = utility(proj, ["intent-create", "--scope", "bugfix", "--arguments", "fix the greeting"]);
  expect(made.status, made.out).toBe(0);
  return readIntentRegistry(proj)[0]?.repos ?? [];
}

describe("a repo name is its folder's name as the person gave it", () => {
  test("a space, an accent in either spelling, another script, an apostrophe and other letters are taken", () => {
    for (const name of [
      "my lib", CAFE_NFC, CAFE_NFD, "\u65e5\u672c", "c++ lib", "Portal App 2", "it's lib", "C# lib", "lib!", "a=b",
      "~home", "@scope", "-lib", ".hidden", "x.", "a..b", "portal-app", "My.App_1", "lib (copy)", "lib [old]",
      "{repo}", "a;b", "a$b", "a`b", "it's (old)",
    ]) {
      expect(repoNameProblem(name), name).toBeNull();
      expect(isValidRepoName(name), name).toBe(true);
    }
  });

  test("a name is left out only for a break it names", () => {
    const reasons: Array<[string, string]> = [
      ["", "is not one folder's name"],
      [".", "is not one folder's name"],
      ["..", "is not one folder's name"],
      ["a/b", "is not one folder's name"],
      ["a\\b", "is not one folder's name"],
      ["a\0b", "is not one folder's name"],
      ["a\tb", "has a control character"],
      ["a\u2028b", "has a control character"],
      [" lib", "starts or ends with a space"],
      ["lib ", "starts or ends with a space"],
      ["a:b", 'has ":", which a folder name on Windows cannot have'],
      ["a*b", 'has "*", which a folder name on Windows cannot have'],
      ['a"b', "which a folder name on Windows cannot have"],
      ["R&D", 'has "&", which breaks AI-DLC\'s commands on Windows'],
      ["50%", 'has "%", which breaks AI-DLC\'s commands on Windows'],
      ["a^b", 'has "^", which breaks AI-DLC\'s commands on Windows'],
      ["a,b", 'has ",", which AI-DLC puts between repo names'],
      ["-", 'is "-", which AI-DLC\'s records use for no repo'],
      ["--lib", 'starts with "--", which AI-DLC\'s commands read as an option'],
      ["x@checkout", 'ends with "@checkout"'],
      // No one quoting reads an apostrophe beside these the same in PowerShell
      // and Git Bash, the two shells an agent on Windows runs.
      ["it's!", "which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows"],
      ["it\u2019s!", "which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows"],
      ["it's \u201cnew\u201d", "which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows"],
      ["it's $x", "which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows"],
      ["it's `x`", "which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows"],
    ];
    for (const [name, reason] of reasons) {
      expect(repoNameProblem(name) ?? "", JSON.stringify(name)).toContain(reason);
      expect(isValidRepoName(name), JSON.stringify(name)).toBe(false);
    }
  });

  test("a source listing keyed by such a repo round-trips", () => {
    const listing = new Map([[sourcePathKey("my lib", "src/greet.py"), `100644 ${"a".repeat(40)}`]]);
    const parsed = parseSourceListing(serializeSourceListing(listing));
    expect(parsed === null ? null : [...parsed.keys()]).toEqual([sourcePathKey("my lib", "src/greet.py")]);
  });
});

describe("work in a workspace whose repo folder has a space or another character", () => {
  for (const name of ["my lib", CAFE_NFC, "it's lib", "C# lib", "c++ lib", "lib (copy)"]) {
    test(`${JSON.stringify(name)} beside api: the work is created with both, and the folder keeps its name`, () => {
      const proj = workspace(name, "api");
      expect(discoverSiblingRepos(proj)).toEqual(["api", name].sort());
      expect(created(proj)).toEqual(["api", name].sort());
      expect(readdirSync(proj)).toContain(name);
    });
  }

  test("a construction step names the repo by its folder", () => {
    const proj = workspace("my lib", "api");
    created(proj);
    expect(resolveConstructionRepo(proj, "my lib")).toEqual({ repo: "my lib", cwd: join(proj, "my lib") });
    expect(() => resolveConstructionRepo(proj, "my-lib")).toThrow('--repo "my-lib" is not in this intent\'s repo set');
  });

  test("Reverse Engineering's tools find, scan and publish the store of \"my lib\" under that name", () => {
    const proj = workspace("my lib", "api");
    created(proj);
    const path = utility(proj, ["codekb-path", "--repo", "my lib", "--json"]);
    expect(path.status, path.out).toBe(0);
    expect(JSON.parse(path.stdout)).toEqual({ space: DEFAULT_SPACE, repo: "my lib", dir: `aidlc/spaces/${DEFAULT_SPACE}/codekb/my lib` });
    const paths = ["src/"];
    const snapshot = utility(proj, ["codekb-snapshot", "--repo", "my lib", "--paths", paths.join(","), "--json"]);
    expect(snapshot.status, snapshot.out).toBe(0);
    const baseline = JSON.parse(snapshot.stdout);
    expect(baseline.store).toBe(`aidlc/spaces/${DEFAULT_SPACE}/codekb/my lib/`);
    const mint = utility(proj, ["codekb-scope-diff", "--repo", "my lib", "--mint", "--paths", paths.join(","), "--json"]);
    expect(mint.status, mint.out).toBe(0);
    const fingerprint = JSON.parse(mint.stdout).fingerprint;
    const candidate = join(proj, "candidate");
    mkdirSync(candidate);
    const intent = readIntentRegistry(proj)[0]?.dirName ?? "";
    for (const file of ARTIFACT_NAMES) {
      writeFileSync(
        join(candidate, file),
        file === "reverse-engineering-timestamp.md"
          ? [
            "# Reverse Engineering Timestamp", "", "## Scope of Analysis", "", "```yaml", "scope_version: 1", "kind: partial",
            `intent: ${intent}`, `fingerprint: ${fingerprint}`, "analyzed:", "  paths:", "    - src/", "  components:",
            "    - greeter", "shallow:", "  paths:", "```", "",
          ].join("\n")
          : `# ${file}\n\nGREETER\n`,
      );
    }
    const published = utility(proj, [
      "codekb-publish", "--repo", "my lib", "--staged", candidate, "--paths", paths.join(","),
      "--expect-store", baseline.store_generation, "--expect-source", baseline.source_fingerprint, "--json",
    ]);
    expect(published.status, published.out).toBe(0);
    const store = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", "my lib");
    expect(readdirSync(store).sort()).toEqual(ARTIFACT_NAMES);
    const status = utility(proj, ["codekb-scope-diff", "--repo", "my lib", "--json"]);
    expect(status.status, status.out).toBe(0);
    expect(JSON.parse(status.stdout).verdict).toBe("CURRENT");
  });

  test("a plan's files in \"my lib\" are the plan's own", () => {
    const proj = workspace("my lib", "api");
    created(proj);
    const record = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", readIntentRegistry(proj)[0]?.dirName ?? "");
    const dir = join(record, "construction", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "code-generation-plan.md"),
      "# Code Generation Plan\n\n## Summary\n\n- Touches: `my lib/src/greet.py`, api/app.py\n\n## Steps\n\n" +
        "- [ ] Step 1: change ./my lib/src/greet.py and add my lib/tests/ (the tests)\n",
    );
    const named = codeGenerationPlanNamedPaths(proj, null) ?? [];
    expect(named).toEqual(expect.arrayContaining(["my lib/src/greet.py", "my lib/tests/", "api/app.py"]));
    // A name inside a longer folder name is not that repo.
    writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n\n- Touches: notmy lib/src/greet.py\n");
    expect(codeGenerationPlanNamedPaths(proj, null) ?? []).not.toContain("my lib/src/greet.py");
  });

  test("beside a repo whose name ends another's, a plan's file in \"my lib\" is not also one in \"lib\"", () => {
    const proj = workspace("my lib", "lib");
    created(proj);
    const record = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", readIntentRegistry(proj)[0]?.dirName ?? "");
    const dir = join(record, "construction", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n\n- Touches: `my lib/src/greet.py` and lib/README.md\n");
    const named = codeGenerationPlanNamedPaths(proj, null) ?? [];
    expect(named).toEqual(expect.arrayContaining(["my lib/src/greet.py", "lib/README.md"]));
    expect(named).not.toContain("lib/src/greet.py");
  });
});

describe("a repo folder whose name AI-DLC cannot hold", () => {
  test("is not part of the work, and the first step says which folder and why, once", () => {
    const proj = workspace("R&D", "api");
    expect(discoverSiblingRepos(proj)).toEqual(["api"]);
    expect(discoverSiblingRepos(proj, true)).toEqual(["R&D"]);
    const env = {
      ...process.env,
      AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-0000000004a1",
      AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    };
    const next = (args: string[] = []) => {
      const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env });
      expect(result.directive, result.out).not.toBeNull();
      return result.directive ?? {};
    };
    const creation = next(["--scope", "bugfix", "fix the greeting"]);
    const request = /--request ([0-9a-f]{8})/.exec(String(creation.message))?.[1] ?? "";
    const made = spawnSync(process.execPath, [
      DISPATCHER, "engine", "intent", "create", "--scope", "bugfix", "--request", request, "--label", "greeting",
      "--project-dir", proj,
    ], { encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    expect(readIntentRegistry(proj)[0]?.repos).toEqual(["api"]);
    const line = 'The folder "R&D" is not part of this work: its name has "&", which breaks AI-DLC\'s commands on Windows.';
    // What the person hears with a step: its lines for them, and its own line.
    const heard = (step: Record<string, unknown>): string => [
      ...(Array.isArray(step.change_notices) ? step.change_notices.map(String) : []),
      ...(typeof step.narration === "string" ? [step.narration] : []),
    ].join(" ");
    const said = heard(next());
    expect(said).toContain(line);
    expect(said.split(line).length).toBe(2);
    expect(heard(next())).not.toContain(line);
    expect(readdirSync(proj)).toContain("R&D");
  });

  test("a typed name is refused with the same reason, and nothing is created", () => {
    const proj = workspace("api");
    for (const [name, reason] of [
      ["../escape", 'Invalid --repos entry "../escape": its name is not one folder\'s name'],
      ["R&D", 'Invalid --repos entry "R&D": its name has "&", which breaks AI-DLC\'s commands on Windows.'],
    ]) {
      const refused = utility(proj, ["intent-create", "--scope", "bugfix", "--arguments", "fix it", "--repos", name]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(reason.replaceAll('"', '\\"'));
    }
    expect(readIntentRegistry(proj)).toEqual([]);
  });
});

describe("a command AI-DLC prints carries the repo's name whole", () => {
  test("set-repos naming a repo not here yet prints add-repo with the name quoted", () => {
    const proj = workspace("api", "web");
    created(proj);
    const refused = utility(proj, ["intent", "set-repos", "api,new lib"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("intent add-repo 'new lib'");
  });

  test("an apostrophe is quoted one way for both shells an agent on Windows may run, and a leading @ is quoted for PowerShell", () => {
    expect(quoteCommandArgument("it's lib", "windows")).toBe('"it\'s lib"');
    expect(quoteCommandArgument("it's lib", "posix")).toBe("'it'\"'\"'s lib'");
    expect(quoteCommandArgument("it's lib", "powershell")).toBe("'it''s lib'");
    // What would expand inside double quotes keeps the PowerShell form.
    expect(quoteCommandArgument("it's $HOME", "windows")).toBe("'it''s $HOME'");
    expect(quoteCommandArgument("my lib", "windows")).toBe("'my lib'");
    expect(quoteCommandArgument("@scope", "windows")).toBe("'@scope'");
    expect(quoteCommandArgument("@scope", "powershell")).toBe("'@scope'");
    expect(quoteCommandArgument("@scope", "posix")).toBe("@scope");
    // PowerShell reads a typographic quote as a quote: a name pasted with one
    // is double-quoted, or has its single quote doubled, never left to end the word.
    const curly = "Fred\u2019s lib";
    expect(quoteCommandArgument(curly, "windows")).toBe(`"${curly}"`);
    expect(quoteCommandArgument(curly, "powershell")).toBe("'Fred\u2019\u2019s lib'");
    expect(quoteCommandArgument(curly, "posix")).toBe(`'${curly}'`);
    expect(quoteCommandArgument("a\u201cb\u201d", "windows")).toBe("'a\u201cb\u201d'");
  });
});

// covers: function:workspaceSourceState, function:sameWorkspaceSource, function:recordedSourceListingUnderCurrentBoundary, function:shapeSourceSnapshotIndex, function:codekbSourceFingerprint, file:aidlc-common/stages/inception/reverse-engineering.md, file:knowledge/aidlc-developer-agent/code-analysis-guide.md
//
// A .NET build rewrites bin/ and obj/ beside the project file. When those
// folders counted as source, a rebuild after a review or plan approval read as
// a source change nobody made, and outside git a build during Reverse
// Engineering threw the scan away. The same names hold real source elsewhere
// (Node's bin/www, a hexagonal adapter/out/), so they leave the boundary only
// beside a .csproj, .fsproj or .vbproj. These pin both sides, the evidence
// recorded before the change, the swarm snapshot, the CodeKB fallback, and the
// scan instruction the developer agent reads.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  codekbScopeFingerprint,
  codekbSourceFingerprint,
  lastWorkspaceSourceFailure,
  recordedSourceListingUnderCurrentBoundary,
  sameWorkspaceSource,
  shapeSourceSnapshotIndex,
  workspaceSourceState,
} from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// The walk's own formula: file lines in sorted walk order, then the
// filesystem digest wrapped in the workspace digest.
function referenceFingerprint(files: Array<[string, string]>): string {
  const lines = files.map(([rel, body]) => `file:${rel}:-=${sha256(body)}`);
  const filesystem = sha256(["aidlc-filesystem-source-v2", ...lines].join("\n"));
  return sha256(["aidlc-workspace-source-v2", `filesystem=${filesystem}`].join("\n"));
}

function bareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-dotnet-outputs-"));
  created.push(dir);
  return dir;
}

function write(dir: string, files: Array<[string, string]>): void {
  for (const [rel, body] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

function fingerprint(dir: string): string {
  const state = workspaceSourceState(dir);
  expect(state).not.toBeNull();
  return state!.fingerprint;
}

// Sorted walk order: uppercase names sort before lowercase ones.
const SOURCE: Array<[string, string]> = [
  ["App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />\n"],
  ["App/Program.cs", "Console.WriteLine(1);\n"],
];
const OUTPUTS: Array<[string, string]> = [
  ["App/bin/Debug/App.dll", "MZ\u0000build-1"],
  ["App/obj/project.assets.json", "{\"version\":3}\n"],
  ["App/out/App.dll", "MZ\u0000publish-1"],
];

describe("t-dotnet-build-outputs", () => {
  test(".NET bin/, obj/ and out/ beside a project file leave the source boundary", () => {
    const dir = bareDir();
    write(dir, [...SOURCE, ...OUTPUTS]);
    const before = fingerprint(dir);
    expect(before).toBe(referenceFingerprint(SOURCE));

    // A rebuild rewrites the outputs; nobody changed the source.
    write(dir, [
      ["App/bin/Debug/App.dll", "MZ\u0000build-2"],
      ["App/bin/Release/App.dll", "MZ\u0000release"],
      ["App/obj/project.assets.json", "{\"version\":3,\"restored\":true}\n"],
    ]);
    expect(fingerprint(dir)).toBe(before);

    writeFileSync(join(dir, "App/Program.cs"), "Console.WriteLine(2);\n");
    expect(fingerprint(dir)).not.toBe(before);
  });

  test("bin/ and out/ without a .NET project file stay source", () => {
    const dir = bareDir();
    const files: Array<[string, string]> = [
      ["api/adapter/out/Port.java", "interface Port {}\n"],
      ["node/bin/www", "#!/usr/bin/env node\nrequire('../app');\n"],
      ["node/package.json", "{\"name\":\"web\"}\n"],
    ];
    write(dir, files);
    const before = fingerprint(dir);
    expect(before).toBe(referenceFingerprint(files));

    writeFileSync(join(dir, "node/bin/www"), "#!/usr/bin/env node\nrequire('../server');\n");
    const afterWww = fingerprint(dir);
    expect(afterWww).not.toBe(before);
    writeFileSync(join(dir, "api/adapter/out/Port.java"), "interface Port { void send(); }\n");
    expect(fingerprint(dir)).not.toBe(afterWww);
  });

  test("a registered path under a .NET bin/ opts back in", () => {
    const dir = bareDir();
    write(dir, [
      ...SOURCE,
      ...OUTPUTS,
      ["App/bin/tool.sh", "echo one\n"],
      [".aidlc-source-paths.json", JSON.stringify({ version: 1, paths: ["App/bin/tool.sh"] })],
    ]);
    const before = fingerprint(dir);
    writeFileSync(join(dir, "App/bin/Debug/App.dll"), "MZ\u0000build-2");
    expect(fingerprint(dir)).toBe(before);
    writeFileSync(join(dir, "App/bin/tool.sh"), "echo two\n");
    expect(fingerprint(dir)).not.toBe(before);
  });

  test("evidence recorded before the change still matches until the source or outputs change", () => {
    const dir = bareDir();
    const byproduct: [string, string] = [".DS_Store", "\u0000\u0000finder"];
    write(dir, [byproduct, ...SOURCE, ...OUTPUTS]);
    const current = fingerprint(dir);
    // What the walk recorded with the name exclusions, and before them.
    const recordedWithNames = referenceFingerprint([...SOURCE, ...OUTPUTS]);
    const recordedBeforeNames = referenceFingerprint([byproduct, ...SOURCE, ...OUTPUTS]);
    expect(current).toBe(referenceFingerprint(SOURCE));
    expect(sameWorkspaceSource(recordedWithNames, current)).toBe(true);
    expect(sameWorkspaceSource(recordedBeforeNames, current)).toBe(true);
    expect(sameWorkspaceSource("0".repeat(64), current)).toBe(false);

    // The earlier walk bound the outputs, so a rebuild was a change to it.
    writeFileSync(join(dir, "App/bin/Debug/App.dll"), "MZ\u0000build-2");
    const rebuilt = fingerprint(dir);
    expect(rebuilt).toBe(current);
    expect(sameWorkspaceSource(recordedWithNames, rebuilt)).toBe(false);

    writeFileSync(join(dir, "App/bin/Debug/App.dll"), "MZ\u0000build-1");
    writeFileSync(join(dir, "App/Program.cs"), "Console.WriteLine(2);\n");
    expect(sameWorkspaceSource(recordedWithNames, fingerprint(dir))).toBe(false);
  });

  test("redoing the earlier walk stops at its bound, and then old evidence compares as before", () => {
    const dir = bareDir();
    write(dir, [...SOURCE, ...OUTPUTS]);
    const recorded = referenceFingerprint([...SOURCE, ...OUTPUTS]);
    const previous = process.env.AIDLC_TEST_SOURCE_LEGACY_MAX_FILES;
    process.env.AIDLC_TEST_SOURCE_LEGACY_MAX_FILES = "2";
    try {
      expect(sameWorkspaceSource(recorded, fingerprint(dir))).toBe(false);
      // The current walk bound; the optional earlier one leaves no failure behind.
      expect(lastWorkspaceSourceFailure()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.AIDLC_TEST_SOURCE_LEGACY_MAX_FILES;
      else process.env.AIDLC_TEST_SOURCE_LEGACY_MAX_FILES = previous;
    }
    expect(sameWorkspaceSource(recorded, fingerprint(dir))).toBe(true);
  });

  test("evidence recorded before the change still matches in a multi-repo workspace", () => {
    const dir = bareDir();
    const roof: Array<[string, string]> = [["README.md", "# workspace\n"]];
    const repo = (files: Array<[string, string]>) => files.map(([rel, body]): [string, string] => [`repo-a/${rel}`, body]);
    write(dir, [...roof, ...repo([...SOURCE, ...OUTPUTS])]);
    const filesystem = (files: Array<[string, string]>) =>
      sha256(["aidlc-filesystem-source-v2", ...files.map(([rel, body]) => `file:${rel}:-=${sha256(body)}`)].join("\n"));
    const workspace = (repoFiles: Array<[string, string]>) =>
      sha256(["aidlc-workspace-source-v2", `roof=filesystem:${filesystem(roof)}`, `repo-a=filesystem:${filesystem(repoFiles)}`].join("\n"));
    const state = workspaceSourceState(dir, undefined, undefined, ["repo-a"]);
    expect(state).not.toBeNull();
    expect(state!.fingerprint).toBe(workspace(SOURCE));
    expect(sameWorkspaceSource(workspace([...SOURCE, ...OUTPUTS]), state!.fingerprint)).toBe(true);
    writeFileSync(join(dir, "repo-a/App/Program.cs"), "Console.WriteLine(2);\n");
    const changed = workspaceSourceState(dir, undefined, undefined, ["repo-a"]);
    expect(sameWorkspaceSource(workspace([...SOURCE, ...OUTPUTS]), changed!.fingerprint)).toBe(false);
  });

  test("a recorded listing drops what sits under a .NET output beside a project file", () => {
    const file = (n: string) => `100644 ${n.repeat(64)}`;
    const recorded = new Map<string, string>([
      ["\u0000App/App.csproj", file("a")],
      ["\u0000App/bin/Debug/App.dll", file("b")],
      ["\u0000App/bin/link", `120000 ${"c".repeat(64)}`],
      ["\u0000App/bin/tool.sh", file("d")],
      ["\u0000App/obj/project.assets.json", file("e")],
      ["\u0000Root.vbproj", file("f")],
      ["\u0000bin/Root.dll", file("1")],
      ["\u0000lib/obj/keep.c", file("2")],
      ["\u0000node/bin/www", file("3")],
      ["repo-a\u0000Svc/Svc.fsproj", file("4")],
      ["repo-a\u0000Svc/out/Svc.dll", file("5")],
    ]);
    const current = new Map<string, string>([
      ["\u0000App/App.csproj", file("a")],
      // Registered, so today's walk still carries it.
      ["\u0000App/bin/tool.sh", file("d")],
      ["\u0000Root.vbproj", file("f")],
      ["repo-a\u0000Svc/Svc.fsproj", file("4")],
    ]);
    const kept = recordedSourceListingUnderCurrentBoundary(recorded, current);
    expect([...kept.keys()].sort()).toEqual([
      "\u0000App/App.csproj",
      "\u0000App/bin/tool.sh",
      "\u0000Root.vbproj",
      "\u0000lib/obj/keep.c",
      "\u0000node/bin/www",
      "repo-a\u0000Svc/Svc.fsproj",
    ]);
  });

  test("the swarm snapshot keeps HEAD's .NET outputs and the Unit's edits to Node bin/www and a registered path", () => {
    const dir = bareDir();
    const git = (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", env: env ?? process.env });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    write(dir, [
      ...SOURCE,
      [".gitignore", "obj/\n"],
      ["App/bin/Debug/App.dll", "MZ\u0000committed"],
      ["App/bin/tool.sh", "echo one\n"],
      [".aidlc-source-paths.json", JSON.stringify({ version: 1, paths: ["App/bin/tool.sh"] })],
      ["Lib/Lib.fsproj", "<Project />\n"],
      ["Lib/bin/Lib.dll", "MZ\u0000lib"],
      ["node/bin/www", "start v1\n"],
    ]);
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const committedDll = git(["rev-parse", "HEAD:App/bin/Debug/App.dll"]).trim();
    const committedLib = git(["rev-parse", "HEAD:Lib/bin/Lib.dll"]).trim();
    // A clean build step removes a tracked output tree outright.
    rmSync(join(dir, "Lib/bin"), { recursive: true, force: true });

    write(dir, [
      ["App/bin/Debug/App.dll", "MZ\u0000rebuilt"],
      ["App/bin/tool.sh", "echo two\n"],
      ["App/obj/project.assets.json", "{}\n"],
      ["App/out/App.dll", "MZ\u0000published"],
      ["node/bin/www", "start v2\n"],
    ]);
    const indexFile = join(tmpdir(), `t-dotnet-outputs-index-${process.pid}-${Date.now()}`);
    created.push(indexFile);
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    git(["add", "-A"], env);
    expect(shapeSourceSnapshotIndex(dir, indexFile, false)).not.toBeNull();
    const staged = new Map(
      git(["ls-files", "-s"], env)
        .trim()
        .split("\n")
        .map((line) => [line.slice(line.indexOf("\t") + 1), line.split(" ")[1]]),
    );
    expect(staged.get("App/bin/Debug/App.dll")).toBe(committedDll);
    expect(staged.get("Lib/bin/Lib.dll")).toBe(committedLib);
    expect(staged.has("App/obj/project.assets.json")).toBe(false);
    expect(staged.has("App/out/App.dll")).toBe(false);
    for (const edited of ["App/bin/tool.sh", "node/bin/www"]) {
      expect(staged.get(edited)).toBe(git(["hash-object", edited]).trim());
    }
  });

  test("outside git, the CodeKB token ignores .NET builds and caches but not source", () => {
    const dir = bareDir();
    write(dir, [
      ...SOURCE,
      ...OUTPUTS,
      ["dist/bundle.js", "bundle-1\n"],
      ["node/bin/www", "start v1\n"],
      ["node_modules/left-pad/index.js", "module.exports = 1;\n"],
    ]);
    const before = codekbSourceFingerprint(dir, ["./"]);
    expect(before?.startsWith("tree:")).toBe(true);
    write(dir, [
      ["App/bin/Debug/App.dll", "MZ\u0000build-2"],
      ["App/obj/project.assets.json", "{\"restored\":true}\n"],
      ["node_modules/left-pad/index.js", "module.exports = 2;\n"],
      ["App/.DS_Store", "\u0000finder"],
    ]);
    expect(codekbSourceFingerprint(dir, ["./"])).toBe(before);

    // dist/ can hold real source, so it still counts.
    writeFileSync(join(dir, "dist/bundle.js"), "bundle-2\n");
    const afterDist = codekbSourceFingerprint(dir, ["./"]);
    expect(afterDist).not.toBe(before);
    writeFileSync(join(dir, "node/bin/www"), "start v2\n");
    const afterWww = codekbSourceFingerprint(dir, ["./"]);
    expect(afterWww).not.toBe(afterDist);
    writeFileSync(join(dir, "App/Program.cs"), "Console.WriteLine(2);\n");
    expect(codekbSourceFingerprint(dir, ["./"])).not.toBe(afterWww);

    // A path the scan names itself is always read, even after a wider one.
    const focused = codekbSourceFingerprint(dir, ["App/bin/"]);
    const overlapping = codekbSourceFingerprint(dir, ["./", "App/bin/"]);
    writeFileSync(join(dir, "App/bin/Debug/App.dll"), "MZ\u0000build-3");
    expect(codekbSourceFingerprint(dir, ["App/bin/"])).not.toBe(focused);
    expect(codekbSourceFingerprint(dir, ["./", "App/bin/"])).not.toBe(overlapping);
  });

  test("in a git repo that does not ignore them, the CodeKB token still leaves .NET outputs out", () => {
    const dir = bareDir();
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    // Lib ignores its outputs, as the stock .NET .gitignore does; App does not.
    write(dir, [
      ...SOURCE,
      ...OUTPUTS,
      [".gitignore", "Lib/bin/\nLib/obj/\n"],
      ["Lib/Lib.csproj", "<Project />\n"],
      ["Lib/bin/Lib.dll", "MZ\u0000lib-1"],
      ["Lib/obj/project.assets.json", "{}\n"],
      ["Root.vbproj", "<Project />\n"],
      ["bin/Root.dll", "MZ\u0000root-1"],
      ["node/bin/www", "start v1\n"],
    ]);
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const before = codekbSourceFingerprint(dir, ["./"]);
    expect(before?.startsWith("git:")).toBe(true);
    // Status and reuse read this one; an ignored output must not make it unknown.
    expect(codekbScopeFingerprint(dir, ["./"])).not.toBeNull();
    write(dir, [
      ["App/bin/Debug/App.dll", "MZ\u0000build-2"],
      ["App/obj/project.assets.json", "{\"restored\":true}\n"],
      ["App/out/new.dll", "MZ\u0000publish-2"],
      ["Lib/bin/Lib.dll", "MZ\u0000lib-2"],
      ["bin/Root.dll", "MZ\u0000root-2"],
    ]);
    expect(codekbSourceFingerprint(dir, ["./"])).toBe(before);

    writeFileSync(join(dir, "node/bin/www"), "start v2\n");
    const afterWww = codekbSourceFingerprint(dir, ["./"]);
    expect(afterWww).not.toBe(before);
    writeFileSync(join(dir, "App/Program.cs"), "Console.WriteLine(2);\n");
    expect(codekbSourceFingerprint(dir, ["./"])).not.toBe(afterWww);

    const focused = codekbSourceFingerprint(dir, ["App/bin/"]);
    expect(focused).not.toBeNull();
    writeFileSync(join(dir, "App/bin/Debug/App.dll"), "MZ\u0000build-3");
    expect(codekbSourceFingerprint(dir, ["App/bin/"])).not.toBe(focused);
  });

  test("the developer brief and guide say to follow .gitignore and skip build outputs", () => {
    const prose = (...parts: string[]) => readFileSync(join(REPO_ROOT, "core", ...parts), "utf-8").replace(/\s+/g, " ");
    const stage = prose("aidlc-common", "stages", "inception", "reverse-engineering.md");
    const step2 = stage.slice(stage.indexOf("### Step 2:"), stage.indexOf("### Step 3:"));
    expect(step2).toContain("follow the repo's `.gitignore` files");
    expect(step2).toContain("skip build outputs, dependency folders, and IDE and tool caches");
    expect(step2).toContain("\"What to Skip\"");
    expect(step2).toContain("beside a project file), without opening them.");
    // The architect checks source too, so its brief carries the same rule.
    const step3 = stage.slice(stage.indexOf("### Step 3:"), stage.indexOf("### Step 4:"));
    expect(step3).toContain("Tell the architect that when it checks the project's source it follows the developer's rule");
    expect(step3).toContain("unlisted and unopened, and names none of their files in the artifacts");

    const guide = prose("knowledge", "aidlc-developer-agent", "code-analysis-guide.md");
    const skip = guide.slice(guide.indexOf("## What to Skip"), guide.indexOf("## Source File Classification"));
    expect(skip).toContain("Follow the repository's `.gitignore` files");
    expect(skip).toContain(".NET `bin/` and `obj/` beside a `.csproj`");
    expect(skip).toContain("Node's `bin/www`");
    expect(guide).toContain("Classify every source file that \"What to Skip\" leaves in");
    // The project file beside a folder decides; the scan opens a file only when
    // nothing beside the folder tells, so .NET output is never read to check.
    expect(skip).toContain("Decide from the files beside a folder, not by opening it.");
    expect(skip).toContain("skip them without listing or reading anything inside");
    expect(skip).toContain("Open one file in a folder only when nothing beside it tells which.");
    expect(skip).not.toContain("Open a file in it to tell which.");
    // A path the scan was asked for, or a registered source path, stays source.
    expect(skip).toContain("A folder the brief names to scan, or one listed in `.aidlc-source-paths.json`, is source whatever sits beside it.");
    // The record says the folders were left out, not skimmed.
    expect(skip).toContain("List the folders you skip under **Left out** in the scan's coverage, not under **Skimmed only**.");
    const artifacts = prose("knowledge", "aidlc-developer-agent", "re-artifacts.md");
    expect(artifacts).toContain("- **Left out**: [folders not opened because \"What to Skip\" in code-analysis-guide.md skips them");
    expect(artifacts).toContain("A folder the scan left out (the developer's **Left out** list, such as build output) does not go in `shallow.paths`: it stays out of the block.");
  });
});

// covers: tool:aidlc-init, file:core/tools/aidlc-distribution.ts, file:core/tools/aidlc-includes.ts
// covers: file:core/tools/aidlc-config-diagnostics.ts, file:scripts/package.ts
//
// A team's own opencode.json (their model, provider, instructions and
// permission rules) keeps everything it has when AI-DLC is set up or
// refreshed in the project: AI-DLC adds only its own entries, never changes
// the team's "*" permission rule, and later follows or removes only the
// entries it wrote that nobody changed. A copy leaves the file out and its
// setup (or the first session) adds AI-DLC's part.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { copyChannelOmits, projectionFiles, sha256Bytes } from "../../core/tools/aidlc-distribution.ts";
import { trustedCommand } from "../../core/tools/aidlc-command.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DIST = join(REPO_ROOT, "dist");
const OPENCODE_RELEASE = join(REPO_ROOT, "dist-release", "opencode");
const AIDLC_RULE = trustedCommand("*");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function run(args: string[], cwd: string, tool = INIT): { status: number; stdout: string; stderr: string } {
  // Keep the host's active runtime out of fixture source selection.
  const machine = temp("aidlc-t-ocje-machine-");
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
    },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function project(teamFile?: string): string {
  const dir = temp("aidlc-t-ocje-project-");
  mkdirSync(join(dir, ".git"));
  if (teamFile !== undefined) writeFileSync(join(dir, "opencode.json"), teamFile);
  return dir;
}

function configure(dir: string, source = OPENCODE_RELEASE): { status: number; stdout: string; stderr: string } {
  return run([
    "config", "--project-dir", dir, "--from", source, "--harness", "opencode", "--mcp", "none", "--yes",
  ], dir);
}

function configured(dir: string, source = OPENCODE_RELEASE): string {
  const result = configure(dir, source);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return readFileSync(join(dir, "opencode.json"), "utf-8");
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read opencode.json keys loosely
type Json = any;

function parse(text: string): Json {
  return Bun.JSONC.parse(text.replace(/^\uFEFF/, "")) as Json;
}

function manifestPath(dir: string): string {
  return join(dir, ".aidlc", "tools", "data", "aidlc-manifest.json");
}

function contribution(dir: string): Json {
  return JSON.parse(readFileSync(manifestPath(dir), "utf-8")).rootContributions["opencode.json"];
}

// A release tree to configure from, with its shipped opencode.json (root file
// and root-blocks copy) or its descriptor changed.
function releaseCopy(edit?: (shipped: Json) => void): string {
  const source = temp("aidlc-t-ocje-source-");
  cpSync(OPENCODE_RELEASE, source, { recursive: true });
  if (edit) {
    const shipped = JSON.parse(readFileSync(join(source, "opencode.json"), "utf-8"));
    edit(shipped);
    const text = `${JSON.stringify(shipped, null, 2)}\n`;
    writeFileSync(join(source, "opencode.json"), text);
    writeFileSync(join(source, ".aidlc", "tools", "data", "root-blocks", "opencode.json"), text);
  }
  return source;
}

const TEAM_FILE = [
  "{",
  "  // The team's own model and provider.",
  '  "model": "amazon-bedrock/team-model",',
  '  "provider": { "amazon-bedrock": { "options": { "region": "eu-west-1" } } },',
  '  "instructions": ["docs/team-rules.md"],',
  '  "permission": {',
  '    "bash": {',
  '      "*": "allow",',
  '      "git push *": "ask"',
  "    }",
  "  }",
  "}",
  "",
].join("\n");

describe("a team's opencode.json keeps what the team set", () => {
  test("setup adds AI-DLC's entries and keeps the team's model, provider, instructions, rules and comments", () => {
    const dir = project(TEAM_FILE);
    const after = configured(dir);
    expect(after.startsWith('{\n  // The team\'s own model and provider.\n  "model": "amazon-bedrock/team-model",\n')).toBe(true);
    expect(after).toContain('"provider": { "amazon-bedrock": { "options": { "region": "eu-west-1" } } },');
    const value = parse(after);
    expect(value.model).toBe("amazon-bedrock/team-model");
    expect(value.provider).toEqual({ "amazon-bedrock": { options: { region: "eu-west-1" } } });
    expect(value.instructions).toEqual([
      "docs/team-rules.md",
      ".aidlc/onboarding.md",
      "aidlc/spaces/default/memory/**/*.md",
    ]);
    expect(value.skills).toEqual({ paths: [".aidlc/skills"] });
    expect(value.permission.edit).toEqual({ "*": "allow", ".aidlc/tools/**": "ask", ".aidlc/hooks/**": "ask" });
    // The team's "*" stays theirs; AI-DLC's own rule goes after the team's rules.
    expect(Object.entries(value.permission.bash)).toEqual([
      ["*", "allow"],
      ["git push *", "ask"],
      [AIDLC_RULE, "allow"],
    ]);
    const record = contribution(dir);
    expect(record.policy).toBe("json-entries");
    expect(record.entries[JSON.stringify({ path: ["permission", "bash", AIDLC_RULE] })]).toBeDefined();
    expect(record.entries[JSON.stringify({ path: ["permission", "bash", "*"] })]).toBeUndefined();
    expect(record.entries[JSON.stringify({ path: ["model"] })]).toBeUndefined();
    // A second run changes nothing.
    expect(configured(dir)).toBe(after);
  });

  test("AI-DLC's \"*\" rule is added only to a map that has none, and first, so the team's rules still decide", () => {
    const dir = project('{\n  "permission": {\n    "bash": {\n      "git *": "allow"\n    }\n  }\n}\n');
    const value = parse(configured(dir));
    expect(Object.entries(value.permission.bash)).toEqual([
      ["*", "ask"],
      ["git *", "allow"],
      [AIDLC_RULE, "allow"],
    ]);
  });

  test("opencode's shorthand rule is kept as the team's \"*\"", () => {
    const dir = project('{\n  "permission": {\n    "bash": "ask"\n  }\n}\n');
    const value = parse(configured(dir));
    expect(value.permission.bash).toEqual({ "*": "ask", [AIDLC_RULE]: "allow" });
  });

  test("a byte order mark and CRLF line ends stay as the team saved them", () => {
    const dir = project(`\uFEFF${TEAM_FILE.replaceAll("\n", "\r\n")}`);
    const after = configured(dir);
    expect(after.startsWith("\uFEFF{\r\n  // The team's own model")).toBe(true);
    expect(after.replaceAll("\r\n", "")).not.toContain("\n");
    expect(parse(after).instructions).toContain(".aidlc/onboarding.md");
  });

  test("a shape AI-DLC cannot add to stops config and leaves the file as it is", () => {
    const text = '{\n  "permission": "ask"\n}\n';
    const dir = project(text);
    const result = configure(dir);
    expect(result.status).toBe(4);
    expect(result.stdout + result.stderr).toContain("permission must be a JSON object");
    expect(readFileSync(join(dir, "opencode.json"), "utf-8")).toBe(text);
  });

  test("a project with no opencode.json gets the shipped file as it is", () => {
    const dir = project();
    expect(configured(dir)).toBe(readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8"));
    expect(contribution(dir).created).toBe(true);
  });
});

describe("a refresh follows only AI-DLC's unchanged entries", () => {
  test("a release change reaches AI-DLC's entries; the team's edits and own entries stay", () => {
    const dir = project(TEAM_FILE);
    const first = configured(dir);
    // The team tightens one of AI-DLC's rules.
    writeFileSync(join(dir, "opencode.json"), first.replace('".aidlc/hooks/**": "ask"', '".aidlc/hooks/**": "deny"'));
    const source = releaseCopy((shipped) => {
      delete shipped.$schema;
      shipped.instructions.push(".aidlc/extra.md");
      shipped.permission.edit[".aidlc/tools/**"] = "deny";
      shipped.permission.edit[".aidlc/hooks/**"] = "allow";
    });
    const value = parse(configured(dir, source));
    expect(value.$schema).toBeUndefined();
    expect(value.instructions).toEqual([
      "docs/team-rules.md",
      ".aidlc/onboarding.md",
      "aidlc/spaces/default/memory/**/*.md",
      ".aidlc/extra.md",
    ]);
    expect(value.permission.edit[".aidlc/tools/**"]).toBe("deny");
    expect(value.permission.edit[".aidlc/hooks/**"]).toBe("deny");
    expect(value.model).toBe("amazon-bedrock/team-model");
    expect(Object.keys(value.permission.bash)).toEqual(["*", "git push *", AIDLC_RULE]);
  });

  test("a file AI-DLC wrote whole before is adopted, and the team's later edit is kept", () => {
    const dir = project();
    const shipped = configured(dir);
    // As a release before json-entries recorded it: the whole file, by hash.
    const manifest = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    manifest.rootContributions["opencode.json"] = { policy: "whole-file", hash: sha256Bytes(shipped) };
    writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);
    const edited = `${JSON.stringify({ ...JSON.parse(shipped), model: "team/model" }, null, 2)}\n`;
    writeFileSync(join(dir, "opencode.json"), edited);
    const value = parse(configured(dir));
    expect(value.model).toBe("team/model");
    expect(value.permission.bash[AIDLC_RULE]).toBe("allow");
    const record = contribution(dir);
    expect(record.policy).toBe("json-entries");
    expect(record.entries[JSON.stringify({ path: ["permission", "bash", AIDLC_RULE] })]).toBeDefined();
    expect(record.entries[JSON.stringify({ path: ["model"] })]).toBeUndefined();
  });

  test("when a release stops shipping the file, only AI-DLC's unchanged entries go", () => {
    const dir = project(TEAM_FILE);
    configured(dir);
    const source = releaseCopy();
    const descriptorPath = join(source, ".aidlc", "tools", "data", "aidlc-projection.json");
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8"));
    descriptor.rootIntegrations = descriptor.rootIntegrations.filter((item: { path: string }) => item.path !== "opencode.json");
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    rmSync(join(source, "opencode.json"));
    configured(dir, source);
    expect(readFileSync(join(dir, "opencode.json"), "utf-8")).toBe(TEAM_FILE);
    // A file AI-DLC created goes with its entries.
    const created = project();
    configured(created);
    const retired = configure(created, source);
    expect(retired.status, retired.stdout + retired.stderr).toBe(0);
    expect(existsSync(join(created, "opencode.json"))).toBe(false);
  });
});

describe("a copy keeps the team's opencode.json", () => {
  test("the copy runtime leaves opencode.json out, and its part rides in root-blocks", () => {
    const { descriptor } = projectionFiles(OPENCODE_RELEASE);
    expect(copyChannelOmits(descriptor).has("opencode.json")).toBe(true);
    expect(readFileSync(join(OPENCODE_RELEASE, ".aidlc", "tools", "data", "root-blocks", "opencode.json"), "utf-8"))
      .toBe(readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8"));
    // 2.10.0 checks every release it installs against its own policy list.
    const raw = JSON.parse(readFileSync(join(OPENCODE_RELEASE, ".aidlc", "tools", "data", "aidlc-projection.json"), "utf-8"));
    expect(raw.rootIntegrations.find((item: { path: string }) => item.path === "opencode.json"))
      .toMatchObject({ policy: "whole-file", extendedPolicy: "json-entries" });
  });

  test("the copy's own setup adds AI-DLC's part to the team's file, or writes it where there is none", () => {
    const copy = temp("aidlc-t-ocje-copy-");
    cpSync(OPENCODE_RELEASE, copy, { recursive: true });
    rmSync(join(copy, "opencode.json"));
    const dir = project(TEAM_FILE);
    const value = parse(configured(dir, copy));
    expect(value.model).toBe("amazon-bedrock/team-model");
    expect(value.skills).toEqual({ paths: [".aidlc/skills"] });
    expect(value.permission.bash["*"]).toBe("allow");
    const fresh = project();
    expect(configured(fresh, copy)).toBe(readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8"));
  });

  test("where setup never ran, the first session adds AI-DLC's part with the same rule", async () => {
    const dir = project(TEAM_FILE);
    cpSync(join(DIST, "opencode"), dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), TEAM_FILE);
    const { addRootBlocks } = await import("../../core/tools/aidlc-includes.ts");
    expect(addRootBlocks(dir)).toContain("opencode.json");
    const value = parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
    expect(value.model).toBe("amazon-bedrock/team-model");
    expect(value.instructions).toContain(".aidlc/onboarding.md");
    expect(value.permission.bash["*"]).toBe("allow");
    // Once is enough.
    expect(addRootBlocks(dir)).not.toContain("opencode.json");
  });

  // Copied, setup skipped, a first session, a settings change from the copy's
  // own command, then a refresh from a release: the team's model, provider,
  // instructions and rules are still theirs at the end, only AI-DLC's
  // entries were ever recorded as AI-DLC's, and AGENTS.md and .gitignore keep
  // one AI-DLC part each. Plain JSON and a file with comments alike.
  const PLAIN_TEAM_FILE = `${JSON.stringify(parse(TEAM_FILE), null, 2)}\n`;
  for (const [label, teamFile] of [["with comments", TEAM_FILE], ["plain JSON", PLAIN_TEAM_FILE]] as const) {
    test(`after a first session and a settings change from the copy, a release refresh keeps the team's entries (${label})`, async () => {
      const dir = project(teamFile);
      // The copy runtime: the release tree without the files a copy leaves out.
      cpSync(OPENCODE_RELEASE, dir, { recursive: true });
      for (const path of copyChannelOmits(projectionFiles(OPENCODE_RELEASE).descriptor)) {
        rmSync(join(dir, path), { force: true });
      }
      writeFileSync(join(dir, "opencode.json"), teamFile);
      const { addRootBlocks } = await import("../../core/tools/aidlc-includes.ts");
      expect(addRootBlocks(dir)).toContain("opencode.json");
      const changed = run(
        ["config", "models", "--project-dir", dir, "--project", "--reviewing-effort", "high", "--yes"],
        dir,
        join(dir, ".aidlc", "tools", "aidlc.ts"),
      );
      expect(changed.status, changed.stdout + changed.stderr).toBe(0);
      for (const file of ["AGENTS.md", ".gitignore"]) {
        expect(readFileSync(join(dir, file), "utf-8").match(/BEGIN AI-DLC/g), file).toHaveLength(1);
      }
      const recorded = Object.keys(contribution(dir)?.entries ?? {});
      for (const team of ["model", "provider", "docs/team-rules.md", "git push *"]) {
        expect(recorded.some((id) => id.includes(team)), `${team} recorded as AI-DLC's: ${recorded.join(", ")}`).toBe(false);
      }
      const value = parse(configured(dir));
      expect(value.model).toBe("amazon-bedrock/team-model");
      expect(value.provider).toEqual({ "amazon-bedrock": { options: { region: "eu-west-1" } } });
      expect(value.instructions).toContain("docs/team-rules.md");
      expect(value.instructions).toContain(".aidlc/onboarding.md");
      expect(value.permission.bash["git push *"]).toBe("ask");
      expect(value.permission.bash["*"]).toBe("allow");
    });
  }
});

describe("doctor reads the team's opencode.json by AI-DLC's entries", () => {
  test("a team edit is not a conflict; a missing AI-DLC instruction is named", async () => {
    const { instructionFileDoctorCheck } = await import("../../core/tools/aidlc-config-diagnostics.ts");
    const dir = project(TEAM_FILE);
    const merged = configured(dir);
    expect(instructionFileDoctorCheck(dir, ".aidlc").pass).toBe(true);
    writeFileSync(join(dir, "opencode.json"), merged.replace('".aidlc/onboarding.md", ', ""));
    const missing = instructionFileDoctorCheck(dir, ".aidlc");
    expect(missing.pass).toBe(false);
    expect(missing.label).toContain("block or file missing (opencode.json)");
  });
});

describe("the entry merge", () => {
  test("a method glob for another space fills AI-DLC's method entry", async () => {
    const { mergeJsonEntries } = await import("../../core/tools/aidlc-distribution.ts");
    const shipped = readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8");
    const current = '{\n  "instructions": ["aidlc/spaces/team/memory/**/*.md"]\n}\n';
    const merged = mergeJsonEntries(current, shipped, { kind: "none" });
    if ("conflict" in merged) throw new Error(merged.conflict);
    expect(parse(merged.text).instructions).toEqual(["aidlc/spaces/team/memory/**/*.md", ".aidlc/onboarding.md"]);
  });

  test("a one-line file stays one line where it can", async () => {
    const { mergeJsonEntries } = await import("../../core/tools/aidlc-distribution.ts");
    const shipped = readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8");
    const merged = mergeJsonEntries('{"permission":{"bash":{"git *":"allow"}}}', shipped, { kind: "none" });
    if ("conflict" in merged) throw new Error(merged.conflict);
    const value = parse(merged.text);
    expect(Object.entries(value.permission.bash)).toEqual([["*", "ask"], ["git *", "allow"], [AIDLC_RULE, "allow"]]);
    expect(value.skills).toEqual({ paths: [".aidlc/skills"] });
  });

  test("removing what was merged gives back the team's file byte for byte", async () => {
    const { mergeJsonEntries, removeJsonEntries } = await import("../../core/tools/aidlc-distribution.ts");
    const shipped = readFileSync(join(OPENCODE_RELEASE, "opencode.json"), "utf-8");
    for (const team of [TEAM_FILE, TEAM_FILE.replaceAll("\n", "\r\n"), '{"model":"x","permission":{"bash":{"git *":"allow"}}}']) {
      const merged = mergeJsonEntries(team, shipped, { kind: "none" });
      if ("conflict" in merged) throw new Error(merged.conflict);
      expect(removeJsonEntries(merged.text, merged.entries)).toBe(team);
    }
  });
});

// The person picks or types a Bedrock region; setup says "Using amazon-bedrock
// in <region>". The team's file already names a region of its own, so the
// explicit choice must still reach it: the region and profile leaves become
// AI-DLC's, the file says so once, and doctor reports no mismatch.
describe("an explicit provider choice reaches the team's opencode.json", () => {
  const PLAIN_FILE = `${JSON.stringify(parse(TEAM_FILE), null, 2)}\n`;
  const PROFILE_FILE = TEAM_FILE.replace('"region": "eu-west-1"', '"region": "eu-west-1", "profile": "team-ops"');
  const NOTE = "opencode.json now uses Bedrock in us-east-1 (was eu-west-1).";
  test.each([
    ["with comments", TEAM_FILE, NOTE, undefined],
    ["plain JSON", PLAIN_FILE, NOTE, undefined],
    // A profile the choice does not name stays the team's, and the line says so.
    ["with the team's own profile", PROFILE_FILE, "opencode.json now uses Bedrock in us-east-1 (was eu-west-1); profile team-ops from opencode.json still applies.", "team-ops"],
  ])("config providers --region replaces the team's region, says so once, and doctor agrees (%s)", (label, teamFile, note, teamProfile) => {
    const dir = project(teamFile);
    configured(dir);
    const changed = run([
      "config", "providers", "--project-dir", dir,
      "--provider", "amazon-bedrock", "--region", "us-east-1", "--opencode-default", "yes", "--yes",
    ], dir);
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    const text = readFileSync(join(dir, "opencode.json"), "utf-8");
    if (label === "with comments") expect(text).toContain("// The team's own model and provider.");
    const value = parse(text);
    expect(value.provider["amazon-bedrock"].options.region).toBe("us-east-1");
    expect(value.provider["amazon-bedrock"].options.profile).toBe(teamProfile);
    expect(value.model).toBe("amazon-bedrock/team-model");
    expect(value.permission.bash["*"]).toBe("allow");
    expect(Object.keys(contribution(dir).entries)).toContain(JSON.stringify({ path: ["provider", "amazon-bedrock", "options", "region"] }));
    expect(changed.stdout).toContain(note);
    expect(changed.stdout.match(/now uses Bedrock/g)).toHaveLength(1);
    const check = run(["config", "providers", "--project-dir", dir, "--check"], dir);
    expect(check.stdout + check.stderr).not.toContain("provider-opencode");
    // Rerunning with the same choice changes nothing and says nothing new.
    const again = run([
      "config", "providers", "--project-dir", dir,
      "--provider", "amazon-bedrock", "--region", "us-east-1", "--opencode-default", "yes", "--yes",
    ], dir);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("now uses Bedrock");
    // A reset removes what the explicit choice wrote, the region, and nothing of the team's.
    const reset = run(["config", "providers", "--project-dir", dir, "--reset", "--yes"], dir);
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    const afterText = readFileSync(join(dir, "opencode.json"), "utf-8");
    if (label === "with comments") expect(afterText).toContain("// The team's own model and provider.");
    const after = parse(afterText);
    if (teamProfile) expect(after.provider["amazon-bedrock"].options).toEqual({ profile: teamProfile });
    else expect(after.provider).toBeUndefined();
    expect(after.model).toBe("amazon-bedrock/team-model");
    expect(after.permission.bash["*"]).toBe("allow");
  });

  test("the profile prompt starts from the profile the team's file names", async () => {
    const { openCodeFileProvider } = await import("../../core/tools/aidlc-config-diagnostics.ts");
    expect(openCodeFileProvider(project(PROFILE_FILE))).toEqual({ region: "eu-west-1", profile: "team-ops" });
    expect(openCodeFileProvider(project(TEAM_FILE))).toEqual({ region: "eu-west-1" });
    expect(openCodeFileProvider(project())).toEqual({});
  });
});

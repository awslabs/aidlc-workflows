// covers: file:harness/codex/emit.ts
//
// A project copied from 2.11.0 refreshes from a newer release with its own
// tool. That tool's merge of .codex/config.toml can change a setting's value
// but cannot take a setting out of an inline table (`set = { ... }`): the
// refresh then stops with ".codex/config.toml (locally modified or unowned)"
// and offers --force over the person's file. So every setting 2.11.0 shipped
// inside an inline table still ships, and the one AI-DLC no longer uses,
// AIDLC_RULES_DIR, ships empty, which the engine reads as none.
//
// Mechanism: function - the shipped file against 2.11.0's (a fixture), and the
// engine's rules lookup; no refresh runs.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rulesContentEntries } from "../../core/tools/aidlc-steering.ts";
import { FIXTURES_DIR, REPO_ROOT } from "../harness/fixtures.ts";

type Toml = Record<string, unknown>;

/** The settings a file writes inside inline tables, as paths: `[table]` then `key = { member = ... }`. */
function inlineMembers(text: string): string[][] {
  const members: string[][] = [];
  let table: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([A-Za-z0-9_.-]+)\]\s*$/.exec(line);
    if (header) {
      table = header[1].split(".");
      continue;
    }
    const inline = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}\s*$/.exec(line);
    if (!inline) continue;
    for (const member of inline[2].split(",")) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(member)?.[1];
      if (key) members.push([...table, inline[1], key]);
    }
  }
  return members;
}

function at(value: unknown, path: string[]): { found: boolean; value: unknown } {
  let here = value;
  for (const key of path) {
    if (here === null || typeof here !== "object" || !(key in (here as Toml))) return { found: false, value: undefined };
    here = (here as Toml)[key];
  }
  return { found: true, value: here };
}

const shipped = (channel: string) => readFileSync(join(REPO_ROOT, channel, "codex", ".codex", "config.toml"), "utf-8");
const earlier = readFileSync(join(FIXTURES_DIR, "codex-config-2.11.0", "config.toml"), "utf-8");

describe("a 2.11.0 copy's own refresh can merge the Codex config this release ships", () => {
  test("every setting 2.11.0 shipped inside an inline table still ships, in both channels", () => {
    const members = inlineMembers(earlier);
    expect(members).toContainEqual(["shell_environment_policy", "set", "AIDLC_RULES_DIR"]);
    for (const channel of ["dist", "dist-release"]) {
      const now = Bun.TOML.parse(shipped(channel));
      for (const path of members) expect(at(now, path).found, `${channel}: ${path.join(".")}`).toBe(true);
    }
  });

  test("the rules folder setting ships empty, so it names no space", () => {
    for (const channel of ["dist", "dist-release"]) {
      expect(at(Bun.TOML.parse(shipped(channel)), ["shell_environment_policy", "set", "AIDLC_RULES_DIR"]).value, channel).toBe("");
    }
  });
});

describe("an empty AIDLC_RULES_DIR is none", () => {
  const saved = process.env.AIDLC_RULES_DIR;
  const projects: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env.AIDLC_RULES_DIR;
    else process.env.AIDLC_RULES_DIR = saved;
    for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
  });

  test("the rules a step gets come from the active space, as with no setting", () => {
    const project = mkdtempSync(join(tmpdir(), "t-codex-earlier-refresh-"));
    projects.push(project);
    const node = { rules_in_context: [{ path: "aidlc/spaces/default/memory/team.md" }] } as Parameters<typeof rulesContentEntries>[0];
    process.env.AIDLC_RULES_DIR = "";
    expect(rulesContentEntries(node, project, "teamb")[0].abs).toBe(join(project, "aidlc", "spaces", "teamb", "memory", "team.md"));
    // The value 2.11.0 shipped names one space, whichever is active.
    process.env.AIDLC_RULES_DIR = "aidlc/spaces/default/memory";
    expect(rulesContentEntries(node, project, "teamb")[0].abs).toBe(join(project, "aidlc", "spaces", "default", "memory", "team.md"));
  });
});

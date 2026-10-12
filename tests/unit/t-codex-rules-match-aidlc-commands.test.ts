// covers: harness/codex/emit.ts
//
// Codex pre-allows a command only when a prefix rule in .codex/rules/default.rules
// matches it word for word, and an allowed command also runs outside Codex's
// workspace-write sandbox, where .git and .codex/ are read-only. The copy channel
// shipped ["bun", ".codex/tools/"], which matches no command AI-DLC runs
// (`bun .codex/tools/aidlc.ts engine ...` has `.codex/tools/aidlc.ts` as its second
// word). Measured live on Codex 0.160.0 and 0.162.1: a side-by-side build's
// `swarm prepare` failed with "Read-only file system" and Codex asked to run it
// outside the sandbox; with approval "never" the build stopped there.
//
// The rules allow AI-DLC's own commands as it runs them, and nothing wider: the
// tool scripts behind a machine-changing command, a config change and anything
// else stay with Codex's sandbox and its ask, as on every other harness.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { copyChannelToolScripts, machineReachingTools } from "../../core/tools/aidlc.ts";
import { TRUSTED_ROUTE_NAMESPACE } from "../../core/tools/aidlc-command.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const COPY_ROOT = join(REPO_ROOT, "dist", "codex");
const COPY_RULES = join(COPY_ROOT, ".codex", "rules", "default.rules");
const NATIVE_RULES = join(REPO_ROOT, "dist-release", "codex", ".codex", "rules", "default.rules");

type Element = string | string[];
type Rule = { pattern: Element[]; decision: string };

// The pattern list of each prefix_rule, read as JSON (the emitter writes it with
// JSON.stringify), and its decision.
function readRules(path: string): Rule[] {
  const text = readFileSync(path, "utf-8");
  const rules: Rule[] = [];
  let at = text.indexOf("prefix_rule(");
  while (at !== -1) {
    const open = text.indexOf("[", text.indexOf("pattern", at));
    let depth = 0;
    let close = open;
    for (; close < text.length; close++) {
      if (text[close] === "[") depth++;
      if (text[close] === "]" && --depth === 0) break;
    }
    const pattern = JSON.parse(text.slice(open, close + 1)) as Element[];
    const decision = /decision\s*=\s*"(\w+)"/.exec(text.slice(close))?.[1] ?? "allow";
    rules.push({ pattern, decision });
    at = text.indexOf("prefix_rule(", close);
  }
  return rules;
}

// Codex's prefix match: the pattern's words, in order, each equal to the
// command's word at that place (a list element is a set of alternatives).
function allowed(rules: Rule[], argv: string[]): boolean {
  return rules.some((rule) =>
    rule.decision === "allow" &&
    rule.pattern.length <= argv.length &&
    rule.pattern.every((element, index) =>
      Array.isArray(element) ? element.includes(argv[index]) : element === argv[index]
    )
  );
}

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(md|toml|json|ts)$/.test(name) ? [path] : [];
  });
}

// Every AI-DLC command shape the copy tree names: the dispatcher's engine
// commands and the tool scripts, up to their first two words after the script.
function copyTreeShapes(): string[][] {
  const shapes = new Set<string>();
  for (const file of textFiles(COPY_ROOT)) {
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(/bun \.codex\/tools\/aidlc[a-z-]*\.ts(?: [a-z][a-z-]*){0,3}/g)) {
      shapes.add(match[0]);
    }
  }
  return [...shapes].sort().map((shape) => shape.split(" "));
}

const tool = (script: string) => `.codex/tools/${script}`;

// The commands that need more than the sandbox gives, as the agent ran them live.
const LIVE_COMMANDS: string[][] = [
  ["bun", tool("aidlc.ts"), "engine", "swarm", "prepare", "--batch", "1", "--units", "u1-shout,u2-version", "--base", "main"],
  ["bun", tool("aidlc.ts"), "engine", "swarm", "finalize", "--batch", "1", "--units", "u1-shout,u2-version", "--claimed", "u1-shout,u2-version"],
  ["bun", tool("aidlc-worktree.ts"), "merge", "--slug", "u1-shout", "--target", "main", "--strategy", "squash"],
  ["bun", tool("aidlc-orchestrate.ts"), "next"],
];

// What stays with Codex's sandbox and its ask: a config change, the commands
// that change the machine's AI-DLC install and their scripts, the bare
// dispatcher, a longer file name, the tools folder itself, a Codex worker.
const LEFT_TO_CODEX: string[][] = [
  ["bun", tool("aidlc.ts")],
  ["bun", tool("aidlc.ts"), "config", "--statusline", "on", "--harness", "codex"],
  ["bun", tool("aidlc.ts"), "config", "--pin", "2.11.0"],
  ["bun", tool("aidlc.ts"), "update"],
  ["bun", tool("aidlc.ts"), "uninstall", "--yes"],
  ["bun", tool("aidlc-state.tsx"), "get"],
  ["bun", ".codex/tools/"],
  ["bun", ".codex/hooks/aidlc-human-turn.ts"],
  ["codex", "exec", "--skip-git-repo-check", "-C", "/tmp/w", "build it"],
  ...machineReachingTools().map((script) => ["bun", tool(script), "run"]),
];

const codexOnPath = spawnSync("codex", ["--version"], { encoding: "utf-8" }).status === 0;

function codexAllows(rulesPath: string, argv: string[]): boolean {
  const result = spawnSync("codex", ["execpolicy", "check", "--rules", rulesPath, "--", ...argv], {
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { decision?: string }).decision === "allow";
}

describe("Codex copy channel: the shipped rules match AI-DLC's own commands", () => {
  const rules = readRules(COPY_RULES);

  test("every engine command and tool script the copy tree names is allowed", () => {
    const scripts = new Set(copyChannelToolScripts());
    const expected = copyTreeShapes().filter((argv) =>
      (argv[1] === tool("aidlc.ts") && argv[2] === TRUSTED_ROUTE_NAMESPACE) ||
      scripts.has(argv[1].slice(".codex/tools/".length))
    );
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.filter((argv) => !allowed(rules, argv)).map((argv) => argv.join(" "))).toEqual([]);
  });

  test("the commands a side-by-side build runs are allowed, as the agent ran them", () => {
    expect(LIVE_COMMANDS.filter((argv) => !allowed(rules, argv)).map((argv) => argv.join(" "))).toEqual([]);
  });

  test("each tool script a copy channel pre-approves is allowed, bare or with arguments", () => {
    const missing = copyChannelToolScripts().filter((script) =>
      !allowed(rules, ["bun", tool(script)]) || !allowed(rules, ["bun", tool(script), "--help"])
    );
    expect(missing).toEqual([]);
  });

  test("nothing wider: config changes, machine commands and other programs match no rule", () => {
    expect(LEFT_TO_CODEX.filter((argv) => allowed(rules, argv)).map((argv) => argv.join(" "))).toEqual([]);
  });

  test.skipIf(!codexOnPath)("Codex's own evaluator gives the same answers", () => {
    for (const argv of LIVE_COMMANDS) expect([argv.join(" "), codexAllows(COPY_RULES, argv)]).toEqual([argv.join(" "), true]);
    for (const argv of LEFT_TO_CODEX) expect([argv.join(" "), codexAllows(COPY_RULES, argv)]).toEqual([argv.join(" "), false]);
  });

  test("the onboarding names only what the rules allow", () => {
    for (const file of [join(COPY_ROOT, ".codex", "onboarding.md"), join(COPY_ROOT, ".codex", "config.toml")]) {
      const line = readFileSync(file, "utf-8").split("\n").find((entry) => entry.startsWith("- **Permissions**:"));
      expect(line).toBeDefined();
      expect(line).not.toContain("`bun .codex/hooks/`");
      expect(line).not.toContain("`bun .codex/tools/`");
      expect(line).toContain(`\`bun .codex/tools/aidlc.ts ${TRUSTED_ROUTE_NAMESPACE} ...\``);
      // The scripts behind config, doctor and the machine's install are not
      // pre-allowed, and the line says so.
      for (const left of ["`config`", "`doctor`", "`update`", "`uninstall`"]) expect(line).toContain(left);
    }
  });
});

describe("Codex native channel: the shipped rules match the aidlc engine commands", () => {
  const rules = readRules(NATIVE_RULES);
  const engine = ["aidlc", TRUSTED_ROUTE_NAMESPACE];

  test("a side-by-side build's engine commands are allowed; config and update are not", () => {
    expect(allowed(rules, [...engine, "swarm", "prepare", "--batch", "1", "--units", "a,b"])).toBe(true);
    expect(allowed(rules, [...engine, "orchestrate", "next"])).toBe(true);
    expect(allowed(rules, ["aidlc", "config", "--statusline", "on"])).toBe(false);
    expect(allowed(rules, ["aidlc", "update"])).toBe(false);
  });

  test.skipIf(!codexOnPath)("Codex's own evaluator agrees", () => {
    expect(codexAllows(NATIVE_RULES, [...engine, "swarm", "prepare", "--batch", "1"])).toBe(true);
    expect(codexAllows(NATIVE_RULES, ["aidlc", "update"])).toBe(false);
  });
});

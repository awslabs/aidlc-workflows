// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-knowledge:onboard, function:withNamedDocumentCopied
//
// On a copy install, `/aidlc knowledge onboard <a file outside documents/>` adds
// the file, as it does on a native install. The copy into the space's
// `knowledge/documents/`, and making that folder, happen in the dispatcher's
// own step for the knowledge verb (`withNamedDocumentCopied` in aidlc.ts), so
// the command the engine hands the agent has to go through the dispatcher. On a
// copy install the tool file run on its own refused instead: "documents does not
// exist. Create it and put your documents there, then re-run: mkdir -p ...".
//
// Mechanism: cli. Each case lays a harness's copy runtime into a fresh git
// project the way the release packs it (dist/<harness> without the files
// `copyChannelOmits` names), asks that tree's own engine for the step, and runs
// the command the step names, as the agent does. On the Kiro trees the adapter
// runs a knowledge command itself, before the agent sees any step, so their
// cases send the person's message to the tree's own prompt hook instead.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyChannelOmits, projectionFiles, walkFiles } from "../../core/tools/aidlc-distribution.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOLS_DIR = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
  opencode: ".aidlc",
  copilot: ".aidlc",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
} as const;
type Harness = keyof typeof TOOLS_DIR;
const DOCUMENTS = join("aidlc", "spaces", "default", "knowledge", "documents");
const INDEX = join("aidlc", "spaces", "default", "knowledge", "documentkb", "index.json");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

// A home of its own, apart from the project, with none of this process's
// AI-DLC or host settings carried over.
function cleanEnv(): NodeJS.ProcessEnv {
  const root = temp("aidlc-t-copy-onboard-machine-");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/^(AIDLC_|AWS_AIDLC_|CLAUDE|KIRO_|CODEX_)/.test(name)) delete env[name];
  for (const dir of ["home", "config", "data", "claude"]) mkdirSync(join(root, dir), { recursive: true });
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
}

// A git project holding the person's own document and one harness's runtime,
// laid as the copy-runtime archive lays it (or the native runtime, from
// dist-release).
function project(harness: Harness, tree: "dist" | "dist-release" = "dist"): string {
  const proj = temp(`aidlc-t-copy-onboard-${harness}-`);
  const source = join(REPO_ROOT, tree, harness);
  const omitted = copyChannelOmits(projectionFiles(source).descriptor);
  for (const rel of walkFiles(source)) {
    if (omitted.has(rel.replaceAll("\\", "/"))) continue;
    mkdirSync(dirname(join(proj, rel)), { recursive: true });
    cpSync(join(source, rel), join(proj, rel));
  }
  const init = spawnSync("git", ["init", "-q"], { cwd: proj, encoding: "utf-8" });
  expect(init.status, `${init.stdout ?? ""}${init.stderr ?? ""}`).toBe(0);
  mkdirSync(join(proj, "orig"), { recursive: true });
  writeFileSync(join(proj, "orig", "requirements.md"), "# Requirements\n\nThe app lists a customer's orders.\n", "utf-8");
  return proj;
}

function run(proj: string, argv: string[], env: NodeJS.ProcessEnv, input = ""): { status: number; out: string } {
  const result = spawnSync(argv[0] === "bun" ? BUN : argv[0], argv.slice(1), {
    cwd: proj,
    env,
    encoding: "utf-8",
    input,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// The command the engine's knowledge step names, as the step prints it.
function knowledgeStep(proj: string, harness: Harness, args: string[], env: NodeJS.ProcessEnv): string {
  const next = run(proj, ["bun", join(TOOLS_DIR[harness], "tools", "aidlc.ts"), "engine", "orchestrate", "next", "knowledge", ...args], env);
  expect(next.status, next.out).toBe(0);
  const directive = JSON.parse(next.out.slice(next.out.indexOf("{"), next.out.lastIndexOf("}") + 1)) as { kind: string; message: string };
  expect(directive.kind, next.out).toBe("print");
  const command = /Run `([^`]+)`/.exec(directive.message)?.[1];
  expect(command, directive.message).toBeDefined();
  return command as string;
}

// The step's command as argv: bare words and single- or double-quoted ones,
// the two forms the engine quotes an argument in.
function words(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/'((?:[^']|'')*)'|"([^"]*)"|(\S+)/g)) {
    out.push(match[1] !== undefined ? match[1].replaceAll("''", "'") : (match[2] ?? match[3]));
  }
  return out;
}

function indexedPaths(proj: string): string[] {
  const index = JSON.parse(readFileSync(join(proj, INDEX), "utf-8")) as { documents: { source: { path: string } }[] };
  return index.documents.map((row) => row.source.path);
}

describe("knowledge onboard on a copy install", () => {
  for (const harness of ["claude", "codex", "cursor", "opencode", "copilot"] as const) {
    test(`${harness}: a file outside documents/ is copied in and added`, () => {
      const env = cleanEnv();
      const proj = project(harness);
      const step = knowledgeStep(proj, harness, ["onboard", "orig/requirements.md"], env);
      const result = run(proj, words(step), env);
      expect(result.out).not.toContain("does not exist");
      expect(result.status, result.out).toBe(0);
      const original = readFileSync(join(proj, "orig", "requirements.md"), "utf-8");
      expect(readFileSync(join(proj, DOCUMENTS, "requirements.md"), "utf-8")).toBe(original);
      expect(indexedPaths(proj)).toEqual(["documents/requirements.md"]);
      expect(step).toBe(`bun ${TOOLS_DIR[harness]}/tools/aidlc.ts engine knowledge onboard orig/requirements.md`);
    });
  }

  test("claude: a path with a space stays one document", () => {
    const env = cleanEnv();
    const proj = project("claude");
    mkdirSync(join(proj, "my notes"), { recursive: true });
    writeFileSync(join(proj, "my notes", "vision doc.md"), "# Vision\n\nOrders, newest first.\n", "utf-8");
    const step = knowledgeStep(proj, "claude", ["onboard", "my notes/vision doc.md"], env);
    const result = run(proj, words(step), env);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(proj, DOCUMENTS, "vision doc.md")), result.out).toBe(true);
    expect(indexedPaths(proj)).toEqual(["documents/vision doc.md"]);
  });

  test("claude: a sweep with no documents/ folder yet makes it and refuses nothing", () => {
    const env = cleanEnv();
    const proj = project("claude");
    const step = knowledgeStep(proj, "claude", ["onboard"], env);
    const result = run(proj, words(step), env);
    expect(result.status, result.out).toBe(0);
    expect(result.out).not.toContain("does not exist");
    expect(existsSync(join(proj, DOCUMENTS))).toBe(true);
  });

  for (const harness of ["kiro", "kiro-ide"] as const) {
    test(`${harness}: the engine's step names the dispatcher`, () => {
      const proj = project(harness);
      expect(knowledgeStep(proj, harness, ["onboard", "orig/requirements.md"], cleanEnv()))
        .toBe("bun .kiro/tools/aidlc.ts engine knowledge onboard orig/requirements.md");
    });

    test(`${harness}: the prompt hook copies a file outside documents/ in and adds it`, () => {
      const proj = project(harness);
      const env = { ...cleanEnv(), CLAUDE_PROJECT_DIR: proj };
      const message = JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: `copy-onboard-${harness}`,
        cwd: proj,
        prompt: "/aidlc knowledge onboard orig/requirements.md",
      });
      const result = run(proj, ["bun", join(".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], env, message);
      expect(result.status, result.out).toBe(0);
      expect(result.out).not.toContain("does not exist");
      expect(result.out).toContain("onboard_note");
      const original = readFileSync(join(proj, "orig", "requirements.md"), "utf-8");
      expect(readFileSync(join(proj, DOCUMENTS, "requirements.md"), "utf-8")).toBe(original);
      expect(indexedPaths(proj)).toEqual(["documents/requirements.md"]);
    });
  }

  test("a native install's step is the native command, as before", () => {
    const proj = project("claude", "dist-release");
    expect(knowledgeStep(proj, "claude", ["onboard", "orig/requirements.md"], cleanEnv()))
      .toBe("aidlc engine knowledge onboard orig/requirements.md");
  });
});

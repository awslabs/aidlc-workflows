// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:intent-create

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksHealthReadDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { questionCopyPath } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import {
  cleanupTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DIRECTIVE_LIMIT_BYTES = 28 * 1024;
const BUN = process.execPath;
const AIDLC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const ORCH = join(AIDLC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC, "tools", "aidlc-utility.ts");

const PARAGRAPH =
  "The billing service must keep every invoice line in a ledger that reconciles itself against the bank feed at the " +
  "close of each business day, and it must refuse a reconciliation that is out by even one cent. ";
const MARKER = "The billing service must keep every invoice line";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

type Directive = Record<string, unknown> & { kind?: string; message?: string; question?: string };

function briefOf(chars: number): string {
  return PARAGRAPH.repeat(Math.ceil(chars / PARAGRAPH.length)).slice(0, chars);
}

function projectWithWork(...scopes: string[]): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  for (const scope of scopes) {
    const res = spawnSync(BUN, [UTIL, "intent-create", "--scope", scope, "--project-dir", proj], {
      encoding: "utf-8",
      timeout: NATIVE_STARTUP_TIMEOUT_MS,
    });
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).toBe(0);
  }
  for (const dir of healthDirs(proj)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pre-tool-use.last"), new Date().toISOString());
  }
  return proj;
}

function healthDirs(proj: string): string[] {
  const dirs = [hooksHealthReadDir(proj)];
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  if (existsSync(intents)) {
    for (const name of readdirSync(intents)) {
      const record = join(intents, name);
      if (statSync(record).isDirectory()) dirs.push(join(record, ".aidlc-engine", "hooks-health"));
    }
  }
  return dirs;
}

function next(proj: string, args: string[]): Directive {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: process.env });
  const parsed = JSON.parse(res.stdout.trim() || "{}") as Directive;
  parsed.bytes = Buffer.byteLength(res.stdout.trim(), "utf-8");
  return parsed;
}

function argsOf(command: string): string[] {
  return command.split(" next ")[1].split(" ").filter(Boolean);
}

function requestIdOf(text: string): string {
  const id = /--request ([0-9a-f]{8})/.exec(text)?.[1];
  expect(id, text.slice(0, 400)).toBeDefined();
  return id as string;
}

function planQuestion(proj: string, brief: string, plan = "bugfix"): Directive {
  const proposal = next(proj, [brief]);
  expect(proposal.kind, String(proposal.message)).toBe("print");
  expect(proposal.bytes as number).toBeLessThan(DIRECTIVE_LIMIT_BYTES);
  const ask = next(proj, ["--propose", plan, "--request", requestIdOf(String(proposal.message))]);
  expect(ask.ask_type, String(ask.message)).toBe("scope-confirm");
  return ask;
}

// The stored copy's path as the engine prints it, so these checks follow the
// sessions folder wherever the engine keeps it.
function copyPath(proj: string, id: string): string {
  const copy = questionCopyPath(proj, id);
  expect(copy, `question ${id} has no stored copy`).not.toBeNull();
  return copy as string;
}

function questionCopy(proj: string, id: string): { text: string } {
  return JSON.parse(readFileSync(join(proj, copyPath(proj, id)), "utf-8")) as { text: string };
}

function runCreation(proj: string, printed: Directive): { status: number; out: string } {
  const span = [...String(printed.message).matchAll(/`([^`]*)`/g)].map((m) => m[1])
    .find((entry) => entry.includes("intent create"));
  expect(span, String(printed.message).slice(0, 800)).toBeDefined();
  const command = (span as string).replace("'<2-3 word kebab essence>'", "billing-ledger");
  const res = spawnSync("sh", ["-c", command], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function recordStates(proj: string): string[] {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  if (!existsSync(intents)) return [];
  return readdirSync(intents)
    .map((name) => join(intents, name, "aidlc-state.md"))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf-8"));
}

describe("#1454 a brief above the 28 KiB directive limit still tailors a plan, because the step names the stored copy", () => {
  test("the dispatch names the stored copy instead of carrying the request", () => {
    const proj = projectWithWork();
    const brief = briefOf(30_000);
    expect(brief.length).toBeGreaterThan(DIRECTIVE_LIMIT_BYTES);
    const ask = planQuestion(proj, brief);
    const dispatch = next(proj, argsOf(String(ask.compose_command)));
    expect(dispatch.kind, String(dispatch.message)).toBe("print");
    expect(dispatch.bytes as number).toBeLessThan(DIRECTIVE_LIMIT_BYTES);
    const message = String(dispatch.message);
    const id = requestIdOf(message);
    expect(message).toContain(copyPath(proj, id));
    expect(message).toContain("propose the workflow plan for the request kept in this project at");
    // The step says how long the request is, so a read that returns less of the file shows as cut.
    expect(message).toContain(`${brief.length} characters long`);
    expect(message).not.toContain(MARKER.slice(0, 120));
    expect(questionCopy(proj, id).text).toBe(brief);
  });

  test("a request that fits one step still rides in it, word for word", () => {
    const proj = projectWithWork();
    const brief = briefOf(5_000);
    const ask = planQuestion(proj, brief);
    const dispatch = next(proj, argsOf(String(ask.compose_command)));
    expect(dispatch.kind, String(dispatch.message)).toBe("print");
    const message = String(dispatch.message);
    expect(message).toContain(`propose the workflow plan for: "${brief}"`);
    expect(message).toContain("MUST equal the original task text above verbatim");
    expect(message).not.toContain("the request kept in this project at");
    expect(message).not.toContain(copyPath(proj, requestIdOf(message)));
  });

  // Windows caps one command line at 32,767 characters, so this test cannot
  // hand the 60,000-character request to the tool as one argument there. The
  // 30,000-character cases around it run on Windows.
  test.skipIf(process.platform === "win32")("the step keeps one size however long the brief is", () => {
    const sizes = [30_000, 60_000].map((chars) => {
      const proj = projectWithWork();
      const ask = planQuestion(proj, briefOf(chars));
      const dispatch = next(proj, argsOf(String(ask.compose_command)));
      expect(dispatch.kind, String(dispatch.message)).toBe("print");
      return dispatch.bytes as number;
    });
    expect(sizes.every((bytes) => bytes < DIRECTIVE_LIMIT_BYTES)).toBe(true);
    expect(sizes[1]).toBe(sizes[0]);
  });

  test("the plan the composer proposed is created with the brief as the work's Project", () => {
    const proj = projectWithWork();
    const brief = briefOf(30_000);
    const ask = planQuestion(proj, brief);
    const dispatch = next(proj, argsOf(String(ask.compose_command)));
    const request = requestIdOf(String(dispatch.message));
    const creation = next(proj, ["--scope", "bugfix", "--request", request]);
    expect(creation.kind, String(creation.message)).toBe("print");
    expect(String(creation.message)).toContain(`intent create --scope bugfix --request ${request}`);
    const ran = runCreation(proj, creation);
    expect(ran.status, ran.out.slice(0, 800)).toBe(0);
    const states = recordStates(proj);
    expect(states).toHaveLength(1);
    expect(states[0]).toContain(`- **Project**: ${brief}`);
  });
});

describe("#1454 the new-work-routing ask carries the same preview its question shows, and its routes name the copy", () => {
  test("a long request beside unselected work still reaches its question", () => {
    const proj = projectWithWork("poc", "feature");
    rmSync(join(proj, "aidlc", "active-intent"), { force: true });
    const brief = briefOf(30_000);
    const ask = next(proj, ["poc", brief]);
    expect(ask.kind, String(ask.message)).toBe("ask");
    expect(ask.ask_type).toBe("new-work-routing");
    expect(ask.bytes as number).toBeLessThan(DIRECTIVE_LIMIT_BYTES);
    const description = String(ask.new_work_description);
    expect(description).toHaveLength(240 + 3);
    expect(description).toEndWith("...");
    expect(brief.startsWith(description.slice(0, -3))).toBe(true);
    expect(questionCopy(proj, String(ask.question_id)).text).toBe(brief);
    expect(String(ask.new_intent_command)).toContain(`--request ${String(ask.question_id)}`);
  });
});

// Listed from the folder, so a composer.md a new harness adds is read too.
describe("every harness's composer.md agrees with the dispatch", () => {
  test("each says what creationDescription is when the dispatch names the stored copy", () => {
    const harnesses = join(import.meta.dir, "..", "..", "harness");
    const files = readdirSync(harnesses)
      .map((name) => join(harnesses, name, "skills", "aidlc", "composer.md"))
      .filter((path) => existsSync(path));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      expect(readFileSync(path, "utf-8"), path).toContain("names the request's stored copy instead of carrying it");
    }
  });
});

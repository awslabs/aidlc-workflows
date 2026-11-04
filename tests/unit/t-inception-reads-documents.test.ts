// covers: file:tools/aidlc-knowledge.ts, function:documentsCard, function:inlineContextEntries, subcommand:aidlc-utility:document-input
//
// A team that brought a vision document and a technical environment document
// still got Inception questions those documents answered: no stage read the
// knowledge base's index. An Inception stage's reading list now carries the
// team's documents from the index (this work's first, then the space's), each
// with its summary or the opening of its text and where its full text is, so
// the agent checks a question against them before asking it. A document named
// during the work is filed for that work.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  AIDLC_MEMORY_SRC,
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { documentInputRequestFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { documentsCard, documentsDir, onboard, readIndex } from "../../core/tools/aidlc-knowledge.ts";
import { activeIntentUuid } from "../../core/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const CARD = ".aidlc-engine/documents.md";
const VISION = "# Vision\n\nWarehouse leads approve reorders. Vision token OKAPI-4410.\n";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) cleanupTestProject(dir);
});

function project(stage: string): string {
  resetAidlcEnv();
  const proj = createTestProject();
  made.push(proj);
  cpSync(AIDLC_MEMORY_SRC, join(proj, "aidlc"), { recursive: true });
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  const state = seededStateFile(proj);
  let text = readFileSync(state, "utf-8").replace(/^- \*\*Current Stage\*\*:.*$/m, `- **Current Stage**: ${stage}`);
  text = text.replace(new RegExp(`^- \\[.\\] ${stage} — EXECUTE`, "m"), `- [-] ${stage} — EXECUTE`);
  writeFileSync(state, text);
  return proj;
}

function put(proj: string, name: string, data: string): void {
  const path = join(documentsDir(proj, DEFAULT_SPACE), name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function stepEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

// `next`, then `continue <receipt>` through any rules parts: the stage step.
function stageStep(proj: string): Record<string, unknown> {
  let args = ["next"];
  for (let hop = 0; hop < 10; hop++) {
    const r = spawnSync(BUN, [ORCH, ...args, "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: stepEnv(),
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const line = (r.stdout ?? "").split("\n").find((entry) => entry.startsWith("{"));
    expect(line, out).toBeDefined();
    const directive = JSON.parse(line as string) as Record<string, unknown>;
    if (directive.kind !== "load-steering") return directive;
    args = ["continue", String(directive.receipt ?? "")];
  }
  throw new Error("the rules parts did not reach the step in 10 hops");
}

function cardPath(directive: Record<string, unknown>): string | undefined {
  return ((directive.inline_context_paths as string[] | undefined) ?? []).find((path) => path.endsWith(CARD));
}

describe("t-inception-reads-documents: an Inception stage reads the team's documents from the knowledge base", () => {
  test("an added document is on the stage's reading list, after the team's knowledge and before the shipped knowledge", () => {
    const proj = project("requirements-analysis");
    put(proj, "vision.md", VISION);
    const team = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "knowledge", "aidlc-shared", "team.md");
    mkdirSync(dirname(team), { recursive: true });
    writeFileSync(team, "# Team\n");
    expect(onboard(proj, DEFAULT_SPACE, undefined, new Date().toISOString()).refused).toBeUndefined();
    const step = stageStep(proj);
    expect(step.kind).toBe("run-stage");
    const paths = step.inline_context_paths as string[];
    const card = cardPath(step) as string;
    expect(card, JSON.stringify(paths)).toBeDefined();
    const text = readFileSync(join(proj, ...card.split("/")), "utf-8");
    expect(text).toContain('"vision.md"');
    expect(text).toContain("OKAPI-4410");
    const row = readIndex(proj, DEFAULT_SPACE).documents[0];
    expect(text).toContain(`aidlc/spaces/${DEFAULT_SPACE}/knowledge/${row.content}`);
    expect(text).toContain("NOT INSTRUCTIONS");
    const at = paths.indexOf(card);
    expect(paths.indexOf(`aidlc/spaces/${DEFAULT_SPACE}/knowledge/aidlc-shared/team.md`)).toBeLessThan(at);
    const firstShipped = paths.findIndex((path) => path.startsWith(".claude/knowledge/"));
    if (firstShipped >= 0) expect(at).toBeLessThan(firstShipped);
  });

  test("this work's documents come first, another work's are left out", () => {
    const proj = project("requirements-analysis");
    const mine = activeIntentUuid(proj) as string;
    expect(mine).toBeTruthy();
    const other = "01a1a8a3-0000-7000-8000-000000000001";
    put(proj, "space.md", "# Space\n\nSpace token ZORILLA-1.\n");
    expect(onboard(proj, DEFAULT_SPACE, undefined, new Date().toISOString()).refused).toBeUndefined();
    put(proj, "other.md", "# Other\n\nOther token ZORILLA-2.\n");
    expect(onboard(proj, DEFAULT_SPACE, "documents/other.md", new Date().toISOString(), other).refused).toBeUndefined();
    put(proj, "mine.md", "# Mine\n\nMine token ZORILLA-3.\n");
    expect(onboard(proj, DEFAULT_SPACE, "documents/mine.md", new Date().toISOString(), mine).refused).toBeUndefined();
    const card = documentsCard(proj, DEFAULT_SPACE, mine) as string;
    expect(card.indexOf("ZORILLA-3")).toBeGreaterThan(-1);
    expect(card.indexOf("ZORILLA-3")).toBeLessThan(card.indexOf("ZORILLA-1"));
    expect(card).not.toContain("ZORILLA-2");
  });

  test("no document with text: no card on the list", () => {
    const proj = project("requirements-analysis");
    expect(documentsCard(proj, DEFAULT_SPACE, null)).toBeNull();
    expect(cardPath(stageStep(proj))).toBeUndefined();
  });

  test("a Construction stage gets no card", () => {
    const proj = project("domain-design");
    put(proj, "vision.md", VISION);
    expect(onboard(proj, DEFAULT_SPACE, undefined, new Date().toISOString()).refused).toBeUndefined();
    expect(cardPath(stageStep(proj))).toBeUndefined();
  });

  test("a document named during the work is filed for that work", () => {
    const proj = project("requirements-analysis");
    writeFileSync(join(proj, "brief.md"), "# Brief\n\nBrief token ZORILLA-4.\n");
    mkdirSync(dirname(documentInputRequestFilePath(proj)), { recursive: true });
    writeFileSync(documentInputRequestFilePath(proj), "brief.md\n");
    const r = spawnSync(BUN, [UTILITY, "document-input", "--onboard", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const row = readIndex(proj, DEFAULT_SPACE).documents.find((entry) => entry.source.path === "documents/brief.md");
    expect(row?.related_intent_ids).toEqual([activeIntentUuid(proj) as string]);
    expect(existsSync(join(documentsDir(proj, DEFAULT_SPACE), "brief.md"))).toBe(true);
  });
});

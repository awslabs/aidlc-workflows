// covers: function:withNamedDocumentCopied, function:knowledgePositionalAt,
// function:copyNamedDocumentIntoKnowledge, function:ensureKnowledgeDocumentsFolder,
// function:gitIgnoredAmong, function:knowledgeCopyCapRefusal,
// function:onboardCopyNote, subcommand:aidlc-knowledge:onboard
//
// A person says "start with vision.md" and the document is added. Before this,
// `knowledge onboard` refused twice over: once because `knowledge/documents/`
// did not exist ("Create it and put your documents there, then re-run: mkdir
// -p ..."), and again because the file they named was outside that folder
// ("Copy it under documents/ first, then re-run"). Both are work the engine can
// do, so the command layer does it: the dispatcher makes the folder, copies the
// file or folder they named from inside the project, and the verb indexes the
// copy and says what happened.
//
// The copy lives in aidlc-utility.ts, which already owned it for
// `document-input --onboard`, and the dispatcher routes to it. The knowledge
// module is untouched on purpose: tests/unit/t289 confines its own filesystem
// mutations to `documentkb/`, and `documents/` is the person's own folder.
//
// Mechanism: cli. Every case runs the real dispatcher (`aidlc.ts engine
// knowledge onboard ...`) against a seeded project on the real filesystem,
// because the routing decision, the copy and the walk are what is under test.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SPACE = "default";
// Where the copies land on disk, and how the index records them: a row's
// source path is relative to the space's `knowledge/` folder.
const DOCUMENTS = join("aidlc", "spaces", SPACE, "knowledge", "documents");
const SOURCE = "documents";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(): string {
  const proj = createTestProject();
  created.push(proj);
  return proj;
}

/** The same project, under git, with the ignore rules the case needs. */
function gitProject(ignore: string): string {
  const proj = project();
  const init = spawnSync("git", ["init", "-q"], { cwd: proj, encoding: "utf-8" });
  expect(init.status, `${init.stdout ?? ""}${init.stderr ?? ""}`).toBe(0);
  writeFileSync(join(proj, ".gitignore"), ignore, "utf-8");
  return proj;
}

/** `knowledge onboard ...` as the person's own command runs it, through the dispatcher. */
function onboard(proj: string, args: string[]): { status: number; out: string; json: Record<string, unknown> } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "knowledge", "onboard", ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let json: Record<string, unknown> = {};
  const start = out.indexOf("{");
  if (start !== -1) {
    try {
      json = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as Record<string, unknown>;
    } catch {
      json = {};
    }
  }
  return { status: result.status ?? -1, out, json };
}

const indexedPaths = (json: Record<string, unknown>): string[] =>
  ((json.indexed ?? []) as Array<{ path: string }>).map((row) => row.path);

describe("the document a person names is added, wherever it is in their project", () => {
  test("a sweep of a space with no documents folder adds nothing and refuses nothing", () => {
    const proj = project();
    expect(existsSync(join(proj, DOCUMENTS))).toBe(false);
    const result = onboard(proj, []);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json)).toEqual([]);
    expect(result.out).not.toContain("does not exist");
    expect(result.out).not.toContain("mkdir");
    // The folder is there for them to fill.
    expect(existsSync(join(proj, DOCUMENTS))).toBe(true);
  });

  test("a file at the project root is copied in, indexed, and the line says so once", () => {
    const proj = project();
    writeFileSync(join(proj, "vision.md"), "# Vision\n\nBuild the thing.\n", "utf-8");
    const result = onboard(proj, ["vision.md"]);
    expect(result.status, result.out).toBe(0);
    const destination = `${DOCUMENTS.replaceAll("\\", "/")}/vision.md`;
    expect(readFileSync(join(proj, destination), "utf-8")).toBe("# Vision\n\nBuild the thing.\n");
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/vision.md`]);
    const note = String(result.json.onboard_note);
    expect(note).toContain(`Copied vision.md into AI-DLC's documents as ${destination} and added it.`);
    // Never "add it again": a second add copies the original beside the first,
    // which would leave two live rows for one document.
    expect(note).toContain("The knowledge base reads that copy from now on, not your own vision.md.");
    expect(note).not.toContain("again");
    // The destination is named once, and their own file is untouched.
    expect(note.split(destination)).toHaveLength(2);
    expect(existsSync(join(proj, "vision.md"))).toBe(true);
  });

  test("the same file again adds no second copy and no second row", () => {
    const proj = project();
    writeFileSync(join(proj, "vision.md"), "# Vision\n", "utf-8");
    expect(onboard(proj, ["vision.md"]).status).toBe(0);
    const again = onboard(proj, ["vision.md"]);
    expect(again.status, again.out).toBe(0);
    expect(existsSync(join(proj, DOCUMENTS, "vision-2.md"))).toBe(false);
    expect(indexedPaths(again.json)).toEqual([`${SOURCE}/vision.md`]);
    expect(((again.json.indexed ?? []) as Array<{ status: string }>)[0].status).toBe("already");
  });

  test("a different file of the same name is copied beside the first, never over it", () => {
    const proj = project();
    writeFileSync(join(proj, "vision.md"), "# Vision\n", "utf-8");
    expect(onboard(proj, ["vision.md"]).status).toBe(0);
    mkdirSync(join(proj, "docs"), { recursive: true });
    writeFileSync(join(proj, "docs", "vision.md"), "# A different vision\n", "utf-8");
    const second = onboard(proj, [join("docs", "vision.md")]);
    expect(second.status, second.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "vision.md"), "utf-8")).toBe("# Vision\n");
    expect(readFileSync(join(proj, DOCUMENTS, "vision-2.md"), "utf-8")).toBe("# A different vision\n");
    expect(indexedPaths(second.json)).toEqual([`${SOURCE}/vision-2.md`]);
  });

  test("a folder keeps its layout, and its documents are indexed together", () => {
    const proj = project();
    mkdirSync(join(proj, "design", "api"), { recursive: true });
    writeFileSync(join(proj, "design", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(join(proj, "design", "api", "contract.md"), "# Contract\n", "utf-8");
    const result = onboard(proj, ["design"]);
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "design", "overview.md"), "utf-8")).toBe("# Overview\n");
    expect(readFileSync(join(proj, DOCUMENTS, "design", "api", "contract.md"), "utf-8")).toBe("# Contract\n");
    const root = `${DOCUMENTS.replaceAll("\\", "/")}/design`;
    expect(indexedPaths(result.json).sort()).toEqual([`${SOURCE}/design/api/contract.md`, `${SOURCE}/design/overview.md`]);
    expect(String(result.json.onboard_note)).toContain(`Copied design into AI-DLC's documents as ${root} and added 2 documents.`);
  });

  test("a document already under documents/ is indexed where it lies, with nothing copied and nothing said", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, DOCUMENTS, "policy.md"), "# Policy\n", "utf-8");
    const result = onboard(proj, [`${DOCUMENTS.replaceAll("\\", "/")}/policy.md`]);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/policy.md`]);
    expect(result.json.onboard_note).toBeUndefined();
    expect(existsSync(join(proj, DOCUMENTS, "policy-2.md"))).toBe(false);
  });

  test("a path outside the project is refused, and nothing is copied", () => {
    const proj = project();
    const outside = project();
    writeFileSync(join(outside, "theirs.md"), "# Theirs\n", "utf-8");
    const result = onboard(proj, [join(outside, "theirs.md")]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("is outside");
    expect(existsSync(join(proj, DOCUMENTS, "theirs.md"))).toBe(false);
  });

  test("a symlink inside the project that leaves it is refused, and nothing is copied", () => {
    const proj = project();
    const outside = project();
    writeFileSync(join(outside, "theirs.md"), "# Theirs\n", "utf-8");
    symlinkSync(join(outside, "theirs.md"), join(proj, "linked.md"));
    const result = onboard(proj, ["linked.md"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("is outside");
    expect(existsSync(join(proj, DOCUMENTS, "linked.md"))).toBe(false);
  });

  test("a file inside a named folder that git ignores is left where it is, and the line says so", () => {
    const proj = gitProject("credentials.yaml\n");
    mkdirSync(join(proj, "specs"), { recursive: true });
    writeFileSync(join(proj, "specs", "overview.md"), "# Overview\n", "utf-8");
    writeFileSync(join(proj, "specs", "credentials.yaml"), "token: sh-hh\n", "utf-8");
    const result = onboard(proj, ["specs"]);
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "specs", "overview.md"), "utf-8")).toBe("# Overview\n");
    // The whole point: what they keep out of git is not copied into a folder
    // that is committed.
    expect(existsSync(join(proj, DOCUMENTS, "specs", "credentials.yaml"))).toBe(false);
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/specs/overview.md`]);
    expect(String(result.json.onboard_note)).toContain(
      "1 file inside it is kept out of git, so it was not copied; name one directly to add it.",
    );
  });

  test("a git-ignored file the person names directly is still added, and the line says the copy is not ignored", () => {
    const proj = gitProject("notes.md\n");
    writeFileSync(join(proj, "notes.md"), "# Notes\n", "utf-8");
    const result = onboard(proj, ["notes.md"]);
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "notes.md"), "utf-8")).toBe("# Notes\n");
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/notes.md`]);
    const note = String(result.json.onboard_note);
    expect(note).toContain("Your notes.md is kept out of git, but this copy is not");
    expect(note).not.toContain("not copied");
  });

  test("a folder git ignores is copied whole when the person names it", () => {
    const proj = gitProject("private/\n");
    mkdirSync(join(proj, "private"), { recursive: true });
    writeFileSync(join(proj, "private", "a.md"), "# A\n", "utf-8");
    writeFileSync(join(proj, "private", "b.md"), "# B\n", "utf-8");
    const result = onboard(proj, ["private"]);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json).sort()).toEqual([`${SOURCE}/private/a.md`, `${SOURCE}/private/b.md`]);
    const note = String(result.json.onboard_note);
    expect(note).toContain("Your private is kept out of git, but this copy is not");
    expect(note).not.toContain("not copied");
  });

  test("the documents folder is never created outside the project, whatever the knowledge root points at", () => {
    const proj = project();
    const outside = project();
    mkdirSync(join(proj, "aidlc", "spaces", SPACE), { recursive: true });
    symlinkSync(outside, join(proj, "aidlc", "spaces", SPACE, "knowledge"));
    writeFileSync(join(proj, "vision.md"), "# Vision\n", "utf-8");
    const result = onboard(proj, ["vision.md"]);
    expect(result.status, result.out).not.toBe(0);
    // Nothing is created through the link, and nothing is copied through it.
    expect(existsSync(join(outside, "documents"))).toBe(false);
  });

  test("a folder with more documents than the batch cap copies nothing and says how many it holds", () => {
    const proj = project();
    mkdirSync(join(proj, "specs"), { recursive: true });
    for (let n = 1; n <= 21; n++) writeFileSync(join(proj, "specs", `s${n}.md`), `# ${n}\n`, "utf-8");
    const result = onboard(proj, ["specs"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("specs holds 21 documents, over the 20-document batch cap");
    expect(result.out).toContain("nothing was copied or indexed");
    // Nothing left behind, so naming it again cannot make a second folder.
    expect(existsSync(join(proj, DOCUMENTS, "specs"))).toBe(false);
    expect(existsSync(join(proj, DOCUMENTS, "specs-2"))).toBe(false);
  });

  test("a document over the per-document cap is refused before it is copied", () => {
    const proj = project();
    // One byte over the cap the verb itself refuses at, so the copy is what is
    // being tested, not the indexing.
    writeFileSync(join(proj, "huge.md"), Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
    const result = onboard(proj, ["huge.md"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("over the 33554432-byte per-document cap; nothing was copied");
    expect(existsSync(join(proj, DOCUMENTS, "huge.md"))).toBe(false);
  });
});

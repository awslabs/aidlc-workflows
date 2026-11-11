// covers: function:withNamedDocumentCopied, function:knowledgePositionals,
// function:copyNamedDocumentIntoKnowledge, function:ensureKnowledgeDocumentsFolder,
// function:gitIgnoredAmong, function:knowledgeCopyCapRefusal,
// function:onboardCopyNote, subcommand:aidlc-knowledge:onboard,
// function:copyNamedDocumentsIntoKnowledge, function:planNamedDocumentCopy,
// function:carryOutNamedDocumentCopy, function:knowledgeCopyCapBreach,
// function:onboardNote, function:describeNotAdded, function:namedOnboardFiles,
// function:onboardBatchWork, function:dispatcherCopies, function:notAddedInOrder,
// function:copiedFromPath, function:updateCopiedDocument,
// function:updatedCopiesNote, function:copiedDocumentFor, function:replaceWithStaged
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

function gitProject(ignore: string): string {
  const proj = project();
  const init = spawnSync("git", ["init", "-q"], { cwd: proj, encoding: "utf-8" });
  expect(init.status, `${init.stdout ?? ""}${init.stderr ?? ""}`).toBe(0);
  writeFileSync(join(proj, ".gitignore"), ignore, "utf-8");
  return proj;
}

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

function knowledge(proj: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "knowledge", ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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

// A person names several documents in one command (a field check on 2.11.3
// named four; only the first went in, and the result said nothing about the
// other three). Every path is taken; one that cannot be is named with why and
// left out, and the rest still go in. Together they are one batch, so the
// batch caps count all of them.
describe("several documents named in one command are all added", () => {
  const FOUR = ["requirements.md", "contract-summary.md", "components.md", "unit-of-work.md"];
  const documentsShown = DOCUMENTS.replaceAll("\\", "/");

  function originals(proj: string, names: readonly string[]): string[] {
    mkdirSync(join(proj, "orig"), { recursive: true });
    for (const name of names) writeFileSync(join(proj, "orig", name), `# ${name}\n`, "utf-8");
    return names.map((name) => `orig/${name}`);
  }

  test("four files named in one command are all copied and indexed, and one line names them", () => {
    const proj = project();
    const result = onboard(proj, originals(proj, FOUR));
    expect(result.status, result.out).toBe(0);
    for (const name of FOUR) expect(readFileSync(join(proj, DOCUMENTS, name), "utf-8")).toBe(`# ${name}\n`);
    expect(indexedPaths(result.json).sort()).toEqual(FOUR.map((name) => `${SOURCE}/${name}`).sort());
    expect(String(result.json.onboard_note)).toBe(
      `Copied 4 documents into AI-DLC's documents in ${documentsShown} and added them: requirements.md, ` +
        "contract-summary.md, components.md and unit-of-work.md. The knowledge base reads those copies from now " +
        "on, not your own.",
    );
    expect(result.json.not_added).toBeUndefined();
  });

  test("a missing path among several is named, and the others are added", () => {
    const proj = project();
    const [first, second] = originals(proj, ["a.md", "b.md"]);
    const result = onboard(proj, [first, "orig/typo.md", second]);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json).sort()).toEqual([`${SOURCE}/a.md`, `${SOURCE}/b.md`]);
    expect(result.json.not_added).toEqual([{ path: "orig/typo.md", reason: "no such file or folder" }]);
    expect(String(result.json.onboard_note)).toStartWith(
      "Not added: orig/typo.md (no such file or folder). Name only that one again once it is fixed. Copied 2 documents",
    );
  });

  test("every path that cannot be added is named in one line", () => {
    const proj = project();
    const outside = project();
    writeFileSync(join(outside, "theirs.md"), "# Theirs\n", "utf-8");
    const [first] = originals(proj, ["a.md"]);
    mkdirSync(join(proj, "empty"), { recursive: true });
    const result = onboard(proj, [first, "orig/typo.md", join(outside, "theirs.md"), "empty"]);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/a.md`]);
    expect((result.json.not_added as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
      "orig/typo.md", join(outside, "theirs.md"), "empty",
    ]);
    const note = String(result.json.onboard_note);
    expect(note).toStartWith(
      `Not added: orig/typo.md (no such file or folder), ${join(outside, "theirs.md")} (outside your project) and ` +
        "empty (it holds no documents). Name only those again once they are fixed.",
    );
    expect(existsSync(join(proj, DOCUMENTS, "empty"))).toBe(false);
  });

  test("when none of the paths named can be added, nothing is and each is named", () => {
    const proj = project();
    const result = onboard(proj, ["orig/typo.md", "orig/other.md"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain(
      "Nothing was added: orig/typo.md (no such file or folder) and orig/other.md (no such file or folder).",
    );
    expect(indexedPaths(result.json)).toEqual([]);
  });

  test("named paths that together pass the batch cap copy nothing and say how many they hold", () => {
    const proj = project();
    for (const folder of ["specs-a", "specs-b"]) {
      mkdirSync(join(proj, folder), { recursive: true });
      for (let n = 1; n <= 11; n++) writeFileSync(join(proj, folder, `s${n}.md`), `# ${folder} ${n}\n`, "utf-8");
    }
    const result = onboard(proj, ["specs-a", "specs-b"]);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain(
      "The 2 paths you named hold 22 documents, over the 20-document batch cap; nothing was copied or indexed.",
    );
    expect(existsSync(join(proj, DOCUMENTS, "specs-a"))).toBe(false);
    expect(existsSync(join(proj, DOCUMENTS, "specs-b"))).toBe(false);
  });

  test("the same file named twice is one copy and one row", () => {
    const proj = project();
    const [only] = originals(proj, ["a.md"]);
    const result = onboard(proj, [only, only]);
    expect(result.status, result.out).toBe(0);
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/a.md`]);
    expect(readdirSync(join(proj, DOCUMENTS))).toEqual(["a.md"]);
    expect(String(result.json.onboard_note)).toContain(`Copied a.md into AI-DLC's documents as ${documentsShown}/a.md and added it.`);
  });

  test("a copy that landed under another name is named, and a long list is cut short", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, DOCUMENTS, "a.md"), "# Another a\n", "utf-8");
    const result = onboard(proj, originals(proj, ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"]));
    expect(result.status, result.out).toBe(0);
    expect(String(result.json.onboard_note)).toContain(
      `Copied 7 documents into AI-DLC's documents in ${documentsShown} and added them: a.md as a-2.md, b.md, ` +
        "c.md, d.md, e.md and 2 more.",
    );
  });

  test("an original kept out of git among several is named in the line", () => {
    const proj = gitProject("secret.md\n");
    const result = onboard(proj, originals(proj, ["a.md", "secret.md"]));
    expect(result.status, result.out).toBe(0);
    expect(String(result.json.onboard_note)).toContain(
      "Your secret.md is kept out of git, but its copy is not, so it will be committed unless you keep it out there too.",
    );
  });
});

// A person changes their original and names it again (a field check on 2.11.3
// did this after the agent advised it, and got `contract-summary-2.md`: a
// second live row with the new text and no association, beside the old one).
// The row records which file it was copied from and the bytes copied, so the
// same original updates its copy in place, as long as nobody edited the copy.
describe("a changed original named again updates its copy", () => {
  const INTENT_UUID = "0192f000-0000-7000-8000-000000000042";
  const documentsShown = DOCUMENTS.replaceAll("\\", "/");

  function withIntent(proj: string, slug: string): void {
    const intents = join(proj, "aidlc", "spaces", SPACE, "intents");
    mkdirSync(join(intents, `260101-${slug}`), { recursive: true });
    writeFileSync(join(intents, `260101-${slug}`, "aidlc-state.md"), "# AI-DLC State Tracking\n");
    writeFileSync(
      join(intents, "intents.json"),
      `${JSON.stringify([{ uuid: INTENT_UUID, slug, dirName: `260101-${slug}`, status: "active" }], null, 2)}\n`,
    );
  }

  const rows = (proj: string): Array<Record<string, unknown>> =>
    (JSON.parse(readFileSync(join(proj, "aidlc", "spaces", SPACE, "knowledge", "documentkb", "index.json"), "utf-8")) as {
      documents: Array<Record<string, unknown>>;
    }).documents;

  test("the same original named again writes over its copy: same id, its intent kept, one line says so", () => {
    const proj = project();
    withIntent(proj, "cash-transfer");
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "contract-summary.md"), "# Contract\n\nC1.\n", "utf-8");
    const first = onboard(proj, ["orig/contract-summary.md", "--intent", "cash-transfer"]);
    expect(first.status, first.out).toBe(0);
    const id = (first.json.indexed as Array<{ id: string }>)[0].id;

    writeFileSync(join(proj, "orig", "contract-summary.md"), "# Contract\n\nC1.\n\nCHANGE-1\n", "utf-8");
    const again = onboard(proj, ["orig/contract-summary.md"]);
    expect(again.status, again.out).toBe(0);
    expect(existsSync(join(proj, DOCUMENTS, "contract-summary-2.md"))).toBe(false);
    expect(readFileSync(join(proj, DOCUMENTS, "contract-summary.md"), "utf-8")).toBe("# Contract\n\nC1.\n\nCHANGE-1\n");
    const outcome = (again.json.indexed as Array<{ id: string; status: string }>)[0];
    expect(outcome).toMatchObject({ id, status: "edited" });
    const live = rows(proj);
    expect(live).toHaveLength(1);
    expect(live[0].related_intent_ids).toEqual([INTENT_UUID]);
    expect(String(again.json.onboard_note)).toBe(
      `Updated ${documentsShown}/contract-summary.md to your new contract-summary.md. It stays the same document in ` +
        "the knowledge base.",
    );
  });

  test("the row records where its copy came from, and an update moves the record to the new bytes", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "one\n", "utf-8");
    expect(onboard(proj, ["./orig/a.md"]).status).toBe(0);
    const recorded = rows(proj)[0].copied_from as { path: string; sha256: string };
    expect(recorded.path).toBe("orig/a.md");
    expect(recorded.sha256).toBe(rows(proj)[0].sha256 as string);
    writeFileSync(join(proj, "orig", "a.md"), "two\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    const moved = rows(proj)[0];
    expect((moved.copied_from as { sha256: string }).sha256).toBe(moved.sha256 as string);
    writeFileSync(join(proj, "orig", "a.md"), "three\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    expect(rows(proj)).toHaveLength(1);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("three\n");
  });

  test("a copy someone edited is never written over: the changed original goes in beside it", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "theirs\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, DOCUMENTS, "a.md"), "the team's edit\n", "utf-8");
    writeFileSync(join(proj, "orig", "a.md"), "theirs, changed\n", "utf-8");
    const again = onboard(proj, ["orig/a.md"]);
    expect(again.status, again.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("the team's edit\n");
    expect(readFileSync(join(proj, DOCUMENTS, "a-2.md"), "utf-8")).toBe("theirs, changed\n");
    // Said, so nobody takes the earlier copy for a stale duplicate and deletes the edit.
    expect(String(again.json.onboard_note)).toEndWith(
      "The earlier copy, a.md, has changed since it was copied, so it was left as it is; the knowledge base now holds both.",
    );
  });

  for (const reindex of ["onboard", "sync"] as const) {
    test(`an edited copy taken into the knowledge base (${reindex}) is never written over either`, () => {
      const proj = project();
      mkdirSync(join(proj, "orig"), { recursive: true });
      writeFileSync(join(proj, "orig", "a.md"), "theirs\n", "utf-8");
      expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
      writeFileSync(join(proj, DOCUMENTS, "a.md"), "the team's edit\n", "utf-8");
      const taken = reindex === "onboard" ? onboard(proj, []) : knowledge(proj, ["sync"]);
      expect(taken.status, taken.out).toBe(0);
      writeFileSync(join(proj, "orig", "a.md"), "theirs, changed\n", "utf-8");
      expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
      expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("the team's edit\n");
      expect(readFileSync(join(proj, DOCUMENTS, "a-2.md"), "utf-8")).toBe("theirs, changed\n");
    });
  }

  test("after an edited copy and the copy beside it, the next change updates the one beside it", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "v1\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, DOCUMENTS, "a.md"), "the team's edit\n", "utf-8");
    writeFileSync(join(proj, "orig", "a.md"), "v2\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, "orig", "a.md"), "v3\n", "utf-8");
    const third = onboard(proj, ["orig/a.md"]);
    expect(third.status, third.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a-2.md"), "utf-8")).toBe("v3\n");
    expect(existsSync(join(proj, DOCUMENTS, "a-3.md"))).toBe(false);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("the team's edit\n");
  });

  test("a copy the team moved is theirs: the changed original is copied in afresh", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "v1\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    renameSync(join(proj, DOCUMENTS, "a.md"), join(proj, DOCUMENTS, "a-2025.md"));
    expect(knowledge(proj, ["sync"]).status).toBe(0);
    writeFileSync(join(proj, "orig", "a.md"), "v2\n", "utf-8");
    const afresh = onboard(proj, ["orig/a.md"]);
    expect(afresh.status, afresh.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a-2025.md"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("v2\n");
    expect(String(afresh.json.onboard_note)).not.toContain("earlier copy");
  });

  test("a run that wrote the new bytes and then stopped is finished by the next one, with one row", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "v1\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, "orig", "a.md"), "v2\n", "utf-8");
    // An intent nobody registered stops the verb after the copy step ran.
    const stopped = onboard(proj, ["orig/a.md", "--intent", "no-such-work"]);
    expect(stopped.status, stopped.out).not.toBe(0);
    const again = onboard(proj, ["orig/a.md"]);
    expect(again.status, again.out).toBe(0);
    expect(rows(proj)).toHaveLength(1);
    expect(existsSync(join(proj, DOCUMENTS, "a-2.md"))).toBe(false);
    writeFileSync(join(proj, "orig", "a.md"), "v3\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("v3\n");
    expect(rows(proj)).toHaveLength(1);
  });

  test("a copy whose line endings a Windows checkout changed is left as it is", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "one\ntwo\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, DOCUMENTS, "a.md"), "one\r\ntwo\r\n", "utf-8");
    writeFileSync(join(proj, "orig", "a.md"), "one\ntwo\nthree\n", "utf-8");
    const beside = onboard(proj, ["orig/a.md"]);
    expect(beside.status, beside.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("one\r\ntwo\r\n");
    expect(existsSync(join(proj, DOCUMENTS, "a-2.md"))).toBe(true);
    expect(String(beside.json.onboard_note)).toContain("The earlier copy, a.md, has changed since it was copied");
  });

  test("a document that was not copied in by name keeps today's behaviour", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, DOCUMENTS, "a.md"), "placed by hand\n", "utf-8");
    expect(onboard(proj, [`${documentsShown}/a.md`]).status).toBe(0);
    expect(rows(proj)[0].copied_from).toBeUndefined();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "another a\n", "utf-8");
    const beside = onboard(proj, ["orig/a.md"]);
    expect(beside.status, beside.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("placed by hand\n");
    expect(existsSync(join(proj, DOCUMENTS, "a-2.md"))).toBe(true);
    expect(String(beside.json.onboard_note)).not.toContain("earlier copy");
  });

  test("a copy an older release already made of the new version is used, and the first copy is left alone", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "v1\n", "utf-8");
    expect(onboard(proj, ["orig/a.md"]).status).toBe(0);
    writeFileSync(join(proj, "orig", "a.md"), "v2\n", "utf-8");
    // A teammate on an older release added the changed file: it went in beside the first copy.
    writeFileSync(join(proj, DOCUMENTS, "a-2.md"), "v2\n", "utf-8");
    expect(onboard(proj, [`${documentsShown}/a-2.md`]).status).toBe(0);
    const again = onboard(proj, ["orig/a.md"]);
    expect(again.status, again.out).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "a.md"), "utf-8")).toBe("v1\n");
    expect((again.json.indexed as Array<{ path: string; status: string }>)[0]).toMatchObject({
      path: `${SOURCE}/a-2.md`, status: "already",
    });
    expect(existsSync(join(proj, DOCUMENTS, "a-3.md"))).toBe(false);
  });

  test("several paths, two of them changed originals, update both and add the new one", () => {
    const proj = project();
    mkdirSync(join(proj, "orig"), { recursive: true });
    writeFileSync(join(proj, "orig", "a.md"), "a\n", "utf-8");
    writeFileSync(join(proj, "orig", "b.md"), "b\n", "utf-8");
    expect(onboard(proj, ["orig/a.md", "orig/b.md"]).status).toBe(0);
    writeFileSync(join(proj, "orig", "a.md"), "a, changed\n", "utf-8");
    writeFileSync(join(proj, "orig", "b.md"), "b, changed\n", "utf-8");
    writeFileSync(join(proj, "orig", "c.md"), "c\n", "utf-8");
    const again = onboard(proj, ["orig/a.md", "orig/b.md", "orig/c.md"]);
    expect(again.status, again.out).toBe(0);
    expect(rows(proj)).toHaveLength(3);
    expect(String(again.json.onboard_note)).toBe(
      `Copied c.md into AI-DLC's documents as ${documentsShown}/c.md and added it. The knowledge base reads that ` +
        "copy from now on, not your own c.md. Updated a.md and b.md in " + documentsShown + " to your new " +
        "versions. Each stays the same document in the knowledge base.",
    );
  });

  test("a folder named again still lands beside the first copy", () => {
    const proj = project();
    mkdirSync(join(proj, "design"), { recursive: true });
    writeFileSync(join(proj, "design", "overview.md"), "v1\n", "utf-8");
    expect(onboard(proj, ["design"]).status).toBe(0);
    expect(rows(proj)[0].copied_from).toBeUndefined();
    writeFileSync(join(proj, "design", "overview.md"), "v2\n", "utf-8");
    expect(onboard(proj, ["design"]).status).toBe(0);
    expect(readFileSync(join(proj, DOCUMENTS, "design", "overview.md"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(proj, DOCUMENTS, "design-2", "overview.md"), "utf-8")).toBe("v2\n");
  });
});

// A copy puts its bytes at the name in two steps: an exclusive create of the
// empty name, then a rename of the whole bytes over it. Whatever another copy
// left at the name, the person's bytes land whole and the line names where.
describe("a copy beside another copy of the same name", () => {
  const LONG_AGO = new Date("2001-01-01T00:00:00Z");
  const sizes = (proj: string) =>
    Object.fromEntries(readdirSync(join(proj, DOCUMENTS)).map((name) => [name, statSync(join(proj, DOCUMENTS, name)).size]));

  test("an empty file a stopped copy left is not taken for the person's document, and the copy lands beside it", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, DOCUMENTS, "notes.md"), "");
    utimesSync(join(proj, DOCUMENTS, "notes.md"), LONG_AGO, LONG_AGO);
    writeFileSync(join(proj, "notes.md"), "# Notes\n\nThe person's words.\n", "utf-8");
    const result = onboard(proj, ["notes.md"]);
    expect(result.status, result.out).toBe(0);
    const copy = `${DOCUMENTS.replaceAll("\\", "/")}/notes-2.md`;
    expect(readFileSync(join(proj, copy), "utf-8")).toBe("# Notes\n\nThe person's words.\n");
    expect(String(result.json.onboard_note)).toContain(`Copied notes.md into AI-DLC's documents as ${copy} and added it.`);
    expect(indexedPaths(result.json)).toEqual([`${SOURCE}/notes-2.md`]);
    expect(sizes(proj)).toEqual({ "notes.md": 0, "notes-2.md": 29 });
  });

  // Run in a child so the fs wrapper never reaches this runner's modules.
  function copyInChild(proj: string, name: string, source: string, before: string): { status: number; out: string } {
    const result = spawnSync(BUN, ["--eval", `
      import { mock } from "bun:test";
      import { join } from "node:path";
      const fs = { ...await import("node:fs") };
      const target = join(fs.realpathSync(${JSON.stringify(join(proj, DOCUMENTS))}), ${JSON.stringify(name)});
      let claimed = false;
      mock.module("node:fs", () => ({
        ...fs,
        openSync(path, flags, ...rest) {
          // Another copy takes the name the moment this one claims it.
          if (String(path) === target && flags === "wx" && !claimed) {
            claimed = true;
            ${before}
          }
          return fs.openSync(path, flags, ...rest);
        },
      }));
      const kb = await import(${JSON.stringify(pathToFileURL(join(AIDLC_SRC, "tools", "aidlc-knowledge.ts")).href)});
      const util = await import(${JSON.stringify(pathToFileURL(join(AIDLC_SRC, "tools", "aidlc-utility.ts")).href)});
      const copied = util.copyNamedDocumentIntoKnowledge(${JSON.stringify(proj)}, kb, ${JSON.stringify(SPACE)}, ${JSON.stringify(join(proj, source))});
      process.stdout.write(JSON.stringify({ claimed, target: copied.target }));
    `], { cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }, encoding: "utf-8" });
    return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  test("a different document taking the name at the moment of the claim sends this copy beside it, both whole", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, "notes.md"), "# Mine\n", "utf-8");
    const result = copyInChild(proj, "notes.md", "notes.md", `fs.writeFileSync(target, "# Theirs\\n");`);
    expect(result.status, result.out).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ claimed: true });
    expect(readFileSync(join(proj, DOCUMENTS, "notes.md"), "utf-8")).toBe("# Theirs\n");
    expect(readFileSync(join(proj, DOCUMENTS, "notes-2.md"), "utf-8")).toBe("# Mine\n");
    expect(Object.keys(sizes(proj)).sort()).toEqual(["notes-2.md", "notes.md"]);
  });

  test("another copy's claim that fills with the same bytes within the second is that copy, not a second one", () => {
    const proj = project();
    mkdirSync(join(proj, DOCUMENTS), { recursive: true });
    writeFileSync(join(proj, "notes.md"), "# Notes\n", "utf-8");
    const target = join(proj, DOCUMENTS, "notes.md");
    // The other copy's claim, made a moment ago and filled a moment later by
    // its rename, as a copy running beside this one does.
    writeFileSync(target, "");
    const filler = Bun.spawn([BUN, "--eval", `
      const fs = await import("node:fs");
      await Bun.sleep(200);
      fs.writeFileSync(${JSON.stringify(`${target}.other`)}, "# Notes\\n");
      fs.renameSync(${JSON.stringify(`${target}.other`)}, ${JSON.stringify(target)});
    `], { stdout: "ignore", stderr: "ignore" });
    try {
      const result = copyInChild(proj, "notes.md", "notes.md", "");
      expect(result.status, result.out).toBe(0);
      expect(JSON.parse(result.out).target).toEndWith("notes.md");
    } finally {
      filler.kill();
    }
    expect(sizes(proj)).toEqual({ "notes.md": 8 });
  });
});

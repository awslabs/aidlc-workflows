// covers: function:documentExtractors function:DocumentExtractorSpec
//
// t294 - the `documentExtractors` configuration seam: a team commits its text
// extractor choice so it travels to every clone.
//
// Mechanism: real filesystem + real `bun scripts/package.ts` runs (the seam IS
// the packager; a mocked writer would prove nothing about what ships).
//
// WHY THIS IS PACKAGER-OWNED, which is the whole reason the story exists.
// `harness.json` is generated AND committed AND byte-diffed by
// `package.ts --check`. Its writer builds a FRESH object, so a hand-added field
// is erased on the next build -- and fails the drift guard in the meantime. The
// runtime READER tolerating unknown keys is not evidence to the contrary: the
// reader is not what decides what ships. Three cases, and only two work:
//
//   packager-owned    add it to the manifest type + writeHarnessData; ships
//                     (absent by default) in every tree. THIS.
//   runtime-owned     written by a tool through the read-modify-write helper.
//                     Works mechanically, but that helper targets a DIFFERENT,
//                     install-local file -- so the value never reaches a clone,
//                     which is the actual requirement.
//   hand-edited       breaks --check AND is erased on the next build.
//
// The last two assertions in the first block are the ones that make this real:
// the field must be ABSENT by default in EVERY tree (so no harness is
// perturbed), and a hand-added field must FAIL `--check` (so the guard is
// measured rather than assumed). HARNESSES is enumerated rather than counted: a
// new harness must be added here, and adding one is how `copilot` was found to be
// missing the skill entirely.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentExtractors } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const REPO = join(import.meta.dir, "..", "..");

// This suite runs `bun scripts/package.ts` in WRITE mode repeatedly, including
// hand-corrupting a committed harness.json to prove the drift guard. Running
// that against the real checkout is a shared-mutable-state hazard: siblings
// run the SAME packager concurrently, and there is no way to make an in-place
// restore survive a SIGKILL (a `finally`/`afterEach` never runs). So every
// case here operates on a SCRATCH COPY under a fresh mkdtemp, never REPO. The
// only things read from REPO are `dist/claude/.claude/tools/aidlc-lib.ts`
// (import, read-only) and the fixture-copy source list below (read-only cp).
// No path under REPO is ever opened for writing by this file.
const SCRATCH_SOURCES = ["dist", "core", "harness", "scripts", "plugins"] as const;
const SCRATCH_FILES = ["package.json", "bun.lock", "tsconfig.json"] as const;

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aidlc-t294-"));
  for (const d of SCRATCH_SOURCES) cpSync(join(REPO, d), join(scratch, d), { recursive: true });
  for (const f of SCRATCH_FILES) cpSync(join(REPO, f), join(scratch, f));
  // Resolution must be HERMETIC, not borrowed: the packager's emitters import
  // real packages (harness/codex/emit.ts imports smol-toml), and a scratch
  // with only package.json + bun.lock resolves them via bun's GLOBAL install
  // cache — which works on a freshly-installed CI runner and silently stops
  // working on a long-lived box once that cache no longer serves the package
  // ("Cannot find package 'smol-toml' from /tmp/aidlc-t294-..."). A symlink
  // to the checkout's node_modules is read-only for everything this suite
  // runs (the packager writes only dist/), so it cannot violate the
  // scratch-isolation contract above.
  symlinkSync(join(REPO, "node_modules"), join(scratch, "node_modules"));
});
afterEach(() => {
  // The scratch dir is disposable: on a SIGKILL mid-test, the OS temp dir is
  // simply an orphaned directory under $TMPDIR, never a dirty checkout. This
  // afterEach is a courtesy cleanup, not a correctness requirement.
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// Where each harness's generated harness.json lands. The MAP is per-harness data
// (engine dirs differ, and two harnesses share `.aidlc`), but the LIST below is
// DERIVED from harness/ -- a hardcoded list cannot fail for a harness it has
// never heard of, and upstream added `copilot` mid-slice.
const HARNESS_DATA: Record<string, string> = {
  claude: "dist/claude/.claude/tools/data/harness.json",
  codex: "dist/codex/.codex/tools/data/harness.json",
  copilot: "dist/copilot/.aidlc/tools/data/harness.json",
  cursor: "dist/cursor/.cursor/tools/data/harness.json",
  kiro: "dist/kiro/.kiro/tools/data/harness.json",
  "kiro-ide": "dist/kiro-ide/.kiro/tools/data/harness.json",
  opencode: "dist/opencode/.aidlc/tools/data/harness.json",
};

const HARNESSES = readdirSync(join(REPO, "harness"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((name) => {
    // An unmapped harness FAILS rather than being skipped: skipping silently is
    // how a new harness ships unchecked.
    if (!HARNESS_DATA[name]) {
      throw new Error(
        `harness/${name} has no HARNESS_DATA entry in t294 — a new harness must ` +
          `declare where its harness.json lands so the sweep below covers it.`,
      );
    }
    return name;
  });

// The fields `writeHarnessData` ships for EVERY harness, sorted. Named once so a
// new packager-owned field is a one-line update here rather than four scattered
// literals -- `name` arrived from upstream and had to be added in exactly this
// many places.
const BASE_KEYS = ["harnessDir", "name", "rulesSubdir"] as const;
const BASE_KEYS_WITH_EXTRACTORS = ["documentExtractors", ...BASE_KEYS] as const;

// Fields the packager emits CONDITIONALLY, so they are present for some
// harnesses and absent for others (`scripts/package.ts` guards each on a
// manifest value being set). `documentExtractors` is ours; upstream's
// `runnerFrontmatterAdditions` arrived with the cursor harness, which carries it
// while claude does not. A per-harness key set must therefore be BASE_KEYS plus
// any subset of these -- asserting exact equality against BASE_KEYS alone fails
// the moment a harness opts into one, which is how this test first broke.
const OPTIONAL_KEYS = ["runnerFrontmatterAdditions"] as const;

/** The base fields, plus whichever optional ones this harness actually opts into. */
function expectedKeys(actual: string[], extra: readonly string[] = []): string[] {
  const allowed = new Set<string>([...OPTIONAL_KEYS]);
  return [...BASE_KEYS, ...extra, ...actual.filter((k) => allowed.has(k))].sort();
}

// Every invocation runs INSIDE `scratch`, never REPO: cwd is scratch, and
// `bun <scratch>/scripts/package.ts` resolves REPO_ROOT from the script's own
// path (import.meta.url), so the packager under test believes ITS repo root
// is the scratch copy. Nothing this function does can touch the real checkout.
function pkg(args: string[] = []): { status: number; out: string } {
  const r = spawnSync("bun", [join(scratch, "scripts", "package.ts"), ...args], {
    cwd: scratch,
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function harnessData(h: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scratch, HARNESS_DATA[h]), "utf-8"));
}

/** Resolve a path a case wants to mutate, INSIDE scratch. No backup/restore is
 *  needed: scratch is a disposable copy, so mutating it freely (even via a
 *  killed process) cannot dirty the real checkout -- the whole point of this
 *  rewrite. */
function guard(rel: string): string {
  return join(scratch, rel);
}

describe("t294 absent by default — no harness is perturbed", () => {
  test("every shipped harness.json carries EXACTLY the base fields", () => {
    // The regression this prevents: a new field appearing in every committed file
    // that no team asked for, which is a diff every downstream clone inherits.
    for (const h of HARNESSES) {
      const keys = Object.keys(harnessData(h)).sort();
      expect(keys, h).toEqual(expectedKeys(keys));
    }
  });

  test("--check is green with the field absent", () => {
    const r = pkg(["--check"]);
    expect(r.status, r.out).toBe(0);
  });

  test("the runtime accessor returns null when nothing is configured", () => {
    // Absent is the NORMAL case, not an error: the tool then probes pdftotext on
    // PATH and degrades to extractor_unavailable.
    expect(documentExtractors()).toBeNull();
  });
});

describe("t294 the guard is REAL: a hand-added field fails --check", () => {
  test("hand-editing the committed harness.json breaks the drift guard", () => {
    // This is the assertion that makes "packager-owned" a measured conclusion
    // rather than a design preference. If --check tolerated a hand-added field,
    // the whole story would be unnecessary.
    const path = guard(HARNESS_DATA.claude);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    data.documentExtractors = { "application/pdf": { argv: ["pdftotext", "$IN", "-"] } };
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

    const r = pkg(["--check"]);
    expect(r.status, "a hand-added field must FAIL --check").not.toBe(0);
    expect(r.out).toMatch(/problem|DIFFERS/i);
  }, 120000);

  test("and the next package run ERASES it", () => {
    // The second half of why hand-editing cannot work: even if a user ignored
    // the guard, their edit does not survive a build.
    const path = guard(HARNESS_DATA.claude);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    data.documentExtractors = { "application/pdf": { argv: ["pdftotext", "$IN", "-"] } };
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

    pkg();
    expect(Object.keys(harnessData("claude")).sort()).toEqual([...BASE_KEYS]);
  }, 120000);
});

describe("t294 present when a manifest sets it, and it SURVIVES a repackage", () => {
  test("a manifest-declared extractor ships, survives a second build, and --check stays green", () => {
    // The three properties that together make this a working seam. "Survives a
    // second build" is the one the hand-edit route fails, and it is the reason a
    // team's committed choice actually reaches a clone.
    const path = guard("harness/claude/manifest.ts");
    const src = readFileSync(path, "utf-8");
    expect(src).toContain("rulesRename: null,");
    writeFileSync(
      path,
      src.replace(
        "rulesRename: null,",
        'rulesRename: null,\n  documentExtractors: { "application/pdf": ' +
          '{ argv: ["pdftotext", "-q", "$IN", "-"], timeoutMs: 30000 } },',
      ),
    );

    expect(pkg().status).toBe(0);
    const first = harnessData("claude");
    expect(Object.keys(first).sort()).toEqual([...BASE_KEYS_WITH_EXTRACTORS]);
    expect((first.documentExtractors as Record<string, { argv: string[] }>)["application/pdf"].argv)
      .toEqual(["pdftotext", "-q", "$IN", "-"]);

    // SECOND build: the erasure test. A fresh-object writer that did not learn
    // the field would drop it here.
    expect(pkg().status).toBe(0);
    expect(Object.keys(harnessData("claude")).sort()).toEqual([...BASE_KEYS_WITH_EXTRACTORS]);

    // And the drift guard ACCEPTS it, because the packager now generates it.
    expect(pkg(["--check"]).status, "the packager-generated field must pass --check").toBe(0);

    // Every OTHER tree is untouched: one harness opting in must not perturb its
    // siblings.
    for (const h of HARNESSES.filter((x) => x !== "claude")) {
      const keys = Object.keys(harnessData(h)).sort();
      expect(keys, h).toEqual(expectedKeys(keys));
    }
  }, 180000);
});

describe("t294 the configured value is untrusted input: argv becomes a process", () => {
  /** Read a hand-written harness.json through the SHIPPED reader in a
   *  subprocess, so a module-level cache cannot leak between cases. Returns the
   *  thrown message, or "OK:<json>" when it validated. */
  function readWith(json: string): string {
    const path = guard(HARNESS_DATA.claude);
    writeFileSync(path, json);
    // Driver lives inside scratch's dist tree, never REPO's.
    const driver = join(scratch, "dist", "claude", ".claude", "tools", "__t294probe.ts");
    writeFileSync(
      driver,
      `const lib = await import("./aidlc-lib.ts");\n` +
        `try {\n` +
        `  const m = lib.documentExtractors();\n` +
        `  process.stdout.write("OK:" + JSON.stringify(m === null ? null : [...m]));\n` +
        `} catch (e) { process.stdout.write("ERR:" + e.message); }\n`,
    );
    const r = spawnSync("bun", [driver], { encoding: "utf-8", cwd: scratch });
    execFileSync("rm", ["-f", driver]);
    return (r.stdout ?? "") + (r.stderr ?? "");
  }

  test("a SHELL STRING argv is refused, not helpfully split", () => {
    // Splitting a shell string is how quoting bugs become command injection.
    // Refusing is the only safe answer, and the message must say why.
    const out = readWith(`${JSON.stringify({
      harnessDir: ".claude",
      rulesSubdir: "rules",
      documentExtractors: { "application/pdf": { argv: "pdftotext -q $IN -" } },
    }, null, 2)}\n`);
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/must be an ARRAY/);
  }, 60000);

  test("an empty or non-array argv is refused", () => {
    for (const argv of ["[]", "null", "42", "{}"]) {
      const out = readWith(
        `{"harnessDir":".claude","rulesSubdir":"rules",` +
        `"documentExtractors":{"application/pdf":{"argv":${argv}}}}\n`,
      );
      expect(out, `argv=${argv}`).toStartWith("ERR:");
    }
  }, 120000);

  test("a non-string argv element is refused", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules",` +
      `"documentExtractors":{"application/pdf":{"argv":["pdftotext",42,"$IN"]}}}\n`,
    );
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/argv\[1\]/);
  }, 60000);

  test("a non-object documentExtractors block is refused", () => {
    for (const block of ['"pdftotext"', "[]", "42"]) {
      const out = readWith(
        `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":${block}}\n`,
      );
      expect(out, block).toStartWith("ERR:");
    }
  }, 120000);

  test("a non-positive timeoutMs is refused", () => {
    for (const t of ["0", "-1", '"30000"']) {
      const out = readWith(
        `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
        `{"application/pdf":{"argv":["pdftotext"],"timeoutMs":${t}}}}\n`,
      );
      expect(out, `timeoutMs=${t}`).toStartWith("ERR:");
    }
  }, 120000);

  test("a well-formed block is ACCEPTED — the validator is not merely strict", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["pdftotext","-q","$IN","-"],"timeoutMs":30000}}}\n`,
    );
    expect(out).toStartWith("OK:");
    expect(out).toContain("pdftotext");
  }, 60000);

  // Finding 2: an argv with NO "$IN" spawns the configured process without ever
  // telling it which document to read -- whatever it prints on stdout gets
  // recorded as the extraction of EVERY document routed to this entry. The rule
  // enumerates exactly ONE valid count (1) and fails closed on anything outside
  // it: zero occurrences (the defect) AND more than one (a config the author
  // almost certainly did not intend, with no stdin-input mode to justify it).
  test("an argv with ZERO \"$IN\" occurrences is refused — the document would never be passed in", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["pdftotext","-q","-"]}}}\n`,
    );
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/exactly one "\$IN"/);
    expect(out).toMatch(/found 0/);
  }, 60000);

  test("an argv with TWO \"\\$IN\" occurrences is also refused, not silently accepted", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["pdftotext","$IN","$IN"]}}}\n`,
    );
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/exactly one "\$IN"/);
    expect(out).toMatch(/found 2/);
  }, 60000);

  test("the accepted shape (exactly one \"$IN\" among the arguments) still validates", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["pdftotext","$IN"]}}}\n`,
    );
    expect(out).toStartWith("OK:");
  }, 60000);

  // Finding 5(b), round 2. `argv[0]` is the EXECUTABLE and is NEVER
  // substituted -- `extractDocument`'s spawn is
  // `spawnSync(argv[0], argv.slice(1).map(sub))`. Measured against the
  // shipped tool BEFORE this fix: `argv: ["$IN"]` PASSED validation (exactly
  // one "$IN" in the whole array, by the old count) and every routed document
  // silently reported `extractor_unavailable` with `extractor.name === "$IN"`
  // -- no extraction ever ran, and nothing told the author their config was
  // wrong. The rule the OLD version of this test asserted ("regardless of
  // position") was itself the defect's own premise; this replaces that claim
  // rather than merely adding beside it.
  test("\"\\$IN\" as argv[0] (the executable slot) is refused, not accepted as a degenerate one-occurrence shape", () => {
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["$IN"]}}}\n`,
    );
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/argv\[0\]/);
    expect(out).toMatch(/never substituted/);
  }, 60000);

  test("\"\\$IN\" as argv[0] is refused even when a real \"\\$IN\" also appears among the arguments", () => {
    // argv[0] itself is still wrong regardless of what follows it -- the
    // argv[0] check must not be satisfied merely because SOME element,
    // somewhere, is a correctly-placed $IN.
    const out = readWith(
      `{"harnessDir":".claude","rulesSubdir":"rules","documentExtractors":` +
      `{"application/pdf":{"argv":["$IN","-q","$IN"]}}}\n`,
    );
    expect(out).toStartWith("ERR:");
    expect(out).toMatch(/argv\[0\]/);
  }, 60000);
});

describe("t294 the blast radius is narrowed", () => {
  test("a malformed documentExtractors leaves the RULES dir resolvable", () => {
    // The trap: shippedRulesSubdir() catches everything the reader throws and
    // STRING-MATCHES the message, rethrowing anything it does not recognise. So a
    // bad documentExtractors block would have crashed a function whose only job
    // is to name the rules dir -- an unrelated caller failing on a field it never
    // reads. Extraction still fails closed; only the unrelated path is spared.
    const path = guard(HARNESS_DATA.claude);
    writeFileSync(
      path,
      `{"harnessDir":".claude","rulesSubdir":"rules",` +
      `"documentExtractors":{"application/pdf":{"argv":"a shell string"}}}\n`,
    );
    const driver = join(scratch, "dist", "claude", ".claude", "tools", "__t294blast.ts");
    writeFileSync(
      driver,
      `const lib = await import("./aidlc-lib.ts");\n` +
        // rulesDir resolution must SURVIVE.
        `let rules = "THREW";\n` +
        `try { rules = String(lib.rulesSubdir()); } catch (e) { rules = "THREW:" + e.message; }\n` +
        // The strict accessor must still THROW.
        `let strict = "NO-THROW";\n` +
        `try { lib.documentExtractors(); } catch (e) { strict = "THREW"; }\n` +
        `process.stdout.write(JSON.stringify({ rules, strict }));\n`,
    );
    const r = spawnSync("bun", [driver], { encoding: "utf-8", cwd: scratch });
    execFileSync("rm", ["-f", driver]);
    const parsed = JSON.parse(
      (r.stdout ?? "").slice((r.stdout ?? "").indexOf("{"), (r.stdout ?? "").lastIndexOf("}") + 1),
    );
    // Two assertions, because the shared try/catch makes it easy to break one
    // while fixing the other.
    expect(parsed.rules, "rules resolution must not crash on an unrelated field")
      .not.toStartWith("THREW");
    expect(parsed.strict, "extraction config must still fail closed").toBe("THREW");
  }, 60000);
});

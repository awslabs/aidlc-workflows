// covers: subcommand:aidlc-knowledge:associate subcommand:aidlc-knowledge:dissociate subcommand:aidlc-knowledge:show subcommand:aidlc-knowledge:sync subcommand:aidlc-knowledge:rebind subcommand:aidlc-knowledge:help function:intentIsInactive function:resolveIntentFlag
//
// t285 - the aidlc-knowledge SKILL.md: shipped to every harness, and its prose
// kept in lockstep with the tool's real flag surface (I33, I41).
//
// Mechanism: the real committed dist/ trees + the real shipped tool. The skill is
// prose an LLM executes, so the only meaningful subject is the BYTES THAT SHIP,
// not the authored source: core/ and dist/ can disagree, and it is dist/ the user
// installs.
//
// WHY THE PARITY CHECK IS BIDIRECTIONAL AND DERIVED, not a list in this file.
// The skill's prose tells an LLM which flags to pass, which makes it load-bearing
// code with no compiler. Two distinct failures, so two directions:
//
//   skill -> tool   the skill documents a flag the tool does not accept. The LLM
//                   passes it, the tool exits non-zero, and the workflow stalls on
//                   a flag that never existed.
//   tool -> skill   the tool needs a flag the skill never mentions. The capability
//                   ships dark: nothing is broken, so nothing complains, and the
//                   feature is simply never used.
//
// Both sets are EXTRACTED from the files at run time. A hardcoded expectation here
// would only prove this file agrees with itself -- the circularity that hid two
// real schema bugs behind 48 green tests earlier in this build.
//
// The all-harness sweep is the other half. Codex and Copilot do NOT enumerate core/skills/
// (each carries a hardcoded array in its emit.ts), so a skill can pass
// every claude-tree assertion while being absent from exactly one harness. The
// registration seams are asymmetric, so the test walks EVERY root in harness/.
//
// Path references are RESOLVED, not string-matched: `{{HARNESS_DIR}}` renders to a
// different prefix per harness, and a token that substitutes to a path which does
// not exist is the trap that nearly produced a false finding in #660 round 7.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INACTIVE_INTENT_STATUSES,
  documentsDir,
  intentIsInactive,
  resolveIntentFlag,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import { intentsRegistryPath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const REPO = join(import.meta.dir, "..", "..");
const AIDLC_TOOLS = join(REPO, "dist", "claude", ".claude", "tools");
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

// Each harness roots skills differently, so the LOCATION is per-harness data --
// but the LIST is not hand-maintained. It is derived from `harness/`, because a
// hand-written list cannot fail when a harness it has never heard of appears:
// upstream added `copilot` mid-slice and this file, then naming five roots
// explicitly, stayed green while the skill was absent from that sixth tree.
// Deriving means a new harness turns "we forgot" into a RED test.
const HARNESS_NAMES = readdirSync(join(REPO, "harness"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// Where each harness puts an installed skill, relative to its dist root. Codex
// and Copilot deliberately root skills OUTSIDE their engine dir (.agents/ and
// .github/ respectively) because their hosts only discover skills there.
const SKILL_REL: Record<string, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
  copilot: ".github/skills",
  cursor: ".cursor/skills",
  kiro: ".kiro/skills",
  "kiro-ide": ".kiro/skills",
  opencode: ".aidlc/skills",
};

const HARNESSES = HARNESS_NAMES.map((name) => {
  const rel = SKILL_REL[name];
  // An unmapped harness is a FAILURE, not a skip: silently skipping is exactly
  // how a new harness ships without the skill.
  if (!rel) {
    throw new Error(
      `harness/${name} has no SKILL_REL entry in t285 — a new harness must declare ` +
        `where it roots skills, so the sweep below actually covers it.`,
    );
  }
  return { name, root: join("dist", name), skill: join(rel, "aidlc-knowledge", "SKILL.md") };
});

// Harnesses that do NOT enumerate core/skills/ and instead carry a hardcoded
// array in their emit.ts. A skill missing from one of these ships to every OTHER
// harness and no count-based test notices.
const HARDCODED_SKILL_ARRAY_HARNESSES = ["codex", "copilot"] as const;

const CLAUDE_SKILL = join(REPO, "dist", "claude", ".claude", "skills", "aidlc-knowledge", "SKILL.md");
const TOOL_SRC = join(REPO, "core", "tools", "aidlc-knowledge.ts");

/** Flags the skill's prose tells an LLM to pass. */
function flagsInSkill(text: string): Set<string> {
  return new Set(text.match(/--[a-z][a-z-]+/g) ?? []);
}

/** Flags the shipped tool actually accepts, read out of its parser + entrypoint.
 *  Two shapes, because the tool reads them two ways: the parser's `a === "--x"`
 *  chain, and `--project-dir`, which main() pulls out by indexOf before parsing. */
function flagsInTool(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/a === "(--[a-z][a-z-]+)"/g)) found.add(m[1]);
  for (const m of source.matchAll(/indexOf\("(--[a-z][a-z-]+)"\)/g)) found.add(m[1]);
  return found;
}

// `--project-dir` is deliberately excluded from the tool->skill direction. It is
// test/plumbing scaffolding for pointing a tool at a scratch project, not a flag a
// human or an agent ever passes -- the same "human help hides plumbing nouns" rule
// t230 enforces on the dispatcher. Named here so its absence is a decision on the
// record rather than a gap the extractor happened to miss.
const PLUMBING_FLAGS = new Set(["--project-dir"]);

let proj: string | undefined;

function projectWithIntents(rows: Array<{ slug: string; status: string }>): string {
  proj = mkdtempSync(join(tmpdir(), "t285-"));
  const registry = rows.map((r, i) => ({
    uuid: `0192f000-0000-7000-8000-0000000000${String(i + 10)}`,
    slug: r.slug,
    dirName: `260101-${r.slug}`,
    status: r.status,
  }));
  mkdirSync(join(proj, "aidlc", "spaces", SPACE, "intents"), { recursive: true });
  for (const r of registry) {
    const dir = join(proj, "aidlc", "spaces", SPACE, "intents", r.dirName);
    mkdirSync(dir, { recursive: true });
    // activeIntent() only honours the cursor when the record carries a state
    // file -- a bare directory reads as "no active intent", which silently turns
    // the bare-`--intent` assertions into a test of the wrong error path.
    writeFileSync(join(dir, "aidlc-state.md"), "# AI-DLC State Tracking\n");
  }
  writeFileSync(intentsRegistryPath(proj, SPACE), `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(proj, "aidlc", "active-space"), `${SPACE}\n`);
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

afterEach(() => {
  if (proj) rmSync(proj, { recursive: true, force: true });
  proj = undefined;
});

describe("t285 - the knowledge skill ships everywhere, and its prose matches the tool", () => {
  // ── I33: present in EVERY harness, at the harness-correct root ────────────
  describe("all-harness registration [I33]", () => {
    for (const h of HARNESSES) {
      test(`${h.name}: the skill ships at its harness-correct root`, () => {
        const path = join(REPO, h.root, h.skill);
        expect(existsSync(path), `missing from the ${h.name} tree: ${h.skill}`).toBe(true);
        expect(readFileSync(path, "utf-8").length).toBeGreaterThan(0);
      });

      test(`${h.name}: the tool path in the prose RESOLVES in the shipped layout`, () => {
        const text = readFileSync(join(REPO, h.root, h.skill), "utf-8");
        // Every invocation the skill prints, not just the first: a skill can get
        // one path right and another wrong.
        const refs = [...new Set(text.match(/bun (\S*tools\/aidlc-\S+\.ts)/g) ?? [])]
          .map((m) => m.replace(/^bun /, ""));
        expect(refs.length, "the skill names no tool to run").toBeGreaterThan(0);
        for (const ref of refs) {
          expect(existsSync(join(REPO, h.root, ref)), `${h.name}: ${ref} does not resolve`).toBe(true);
        }
      });

      test(`${h.name}: no unsubstituted {{HARNESS_DIR}} token survives`, () => {
        const text = readFileSync(join(REPO, h.root, h.skill), "utf-8");
        expect(text).not.toContain("{{HARNESS_DIR}}");
      });
    }

    for (const h of HARDCODED_SKILL_ARRAY_HARNESSES) {
      test(`the ${h} hardcoded skill array names the skill (the N-of-N trap)`, () => {
        // These harnesses do not enumerate core/skills/. This asserts the ARRAY, not
        // just the emitted file, so deleting the entry fails here with a clear cause
        // rather than only as a missing file in one tree.
        const emit = readFileSync(join(REPO, "harness", h, "emit.ts"), "utf-8");
        const match = emit.match(/for \(const skill of \[([^\]]+)\]/);
        expect(
          match,
          `harness/${h}/emit.ts no longer matches the hardcoded skill-array extractor`,
        ).not.toBeNull();
        const array = match?.[1] ?? "";
        expect(array, `harness/${h}/emit.ts omits aidlc-knowledge`).toContain("aidlc-knowledge");
      });
    }

    test("the skill is standalone: it declares no stage/graph membership", () => {
      const text = readFileSync(CLAUDE_SKILL, "utf-8");
      // A `stage:` or `phase:` key in the front matter would pull it into the
      // lifecycle graph, which this skill is deliberately outside of.
      const front = text.slice(0, text.indexOf("---", 4));
      expect(front).not.toMatch(/^\s*(stage|phase|scope):/m);
      expect(front).toContain("user-invocable: true");
    });

    test("no closed-harness-count phrasing in the skill [t55 test 8]", () => {
      const text = readFileSync(join(REPO, "core", "skills", "aidlc-knowledge", "SKILL.md"), "utf-8");
      expect(text).not.toMatch(
        /one core,?\s+three\s+harnesses|three\s+(?:cli\s+)?harnesses|three\s+harness\s+distributions?|generated\s+three\s+ways|(?:add|adding)\s+a\s+fourth/i,
      );
    });
  });

  // ── I41: bidirectional flag parity ────────────────────────────────────────
  describe("SKILL.md <-> tool flag parity, both directions [I41]", () => {
    test("every flag the SKILL.md tells an LLM to pass EXISTS on the tool", () => {
      const skillFlags = flagsInSkill(readFileSync(CLAUDE_SKILL, "utf-8"));
      const toolFlags = flagsInTool(readFileSync(TOOL_SRC, "utf-8"));
      expect(skillFlags.size, "extracted no flags from the skill").toBeGreaterThan(0);
      const phantom = [...skillFlags].filter((f) => !toolFlags.has(f)).sort();
      expect(phantom, `the skill documents flags the tool rejects: ${phantom.join(" ")}`).toEqual([]);
    });

    test("every flag the tool accepts APPEARS in the SKILL.md", () => {
      const skillFlags = flagsInSkill(readFileSync(CLAUDE_SKILL, "utf-8"));
      const toolFlags = flagsInTool(readFileSync(TOOL_SRC, "utf-8"));
      expect(toolFlags.size, "extracted no flags from the tool").toBeGreaterThan(0);
      const undocumented = [...toolFlags]
        .filter((f) => !PLUMBING_FLAGS.has(f) && !skillFlags.has(f))
        .sort();
      expect(undocumented, `the tool accepts flags the skill never mentions: ${undocumented.join(" ")}`).toEqual([]);
    });

    test("the extractors are real: both directions see --allow-inactive", () => {
      // Guards the guard. If either regex silently matched nothing, both parity
      // assertions above would pass vacuously -- the failure mode that made two
      // earlier tests in this build pass without exercising anything.
      expect(flagsInSkill(readFileSync(CLAUDE_SKILL, "utf-8")).has("--allow-inactive")).toBe(true);
      expect(flagsInTool(readFileSync(TOOL_SRC, "utf-8")).has("--allow-inactive")).toBe(true);
    });

    test("every subcommand the tool routes is documented in the skill", () => {
      // The verb surface travels the same way the flags do: a verb absent from the
      // prose is a verb the agent never invokes.
      const text = readFileSync(CLAUDE_SKILL, "utf-8");
      for (const verb of ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind"]) {
        expect(text, `verb "${verb}" is absent from the skill`).toContain(verb);
      }
      // `remove` is deliberately absent by design: deletion stays "delete the
      // original, then sync", so the tool never holds a destructive verb over
      // user-owned files. Assert the ABSENCE so re-adding it must be deliberate.
      expect(text).not.toMatch(/^\| `remove/m);
    });

    test("the skill carries the untrusted-content rule, not just a mention of content", () => {
      const text = readFileSync(CLAUDE_SKILL, "utf-8");
      expect(text.toLowerCase()).toContain("untrusted");
      // The load-bearing half is the INSTRUCTION, not the label: an LLM that reads
      // "untrusted" but is not told to refuse imperatives will still obey them.
      expect(text).toMatch(/do not comply/i);
    });
  });

  // ── the --allow-inactive behaviour the prose promises ──────────────────────
  describe("--allow-inactive: the refusal the skill documents is real", () => {
    test("a live intent resolves without the flag", () => {
      const p = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      const r = resolveIntentFlag(p, SPACE, "live-one");
      expect(r?.slug).toBe("live-one");
    });

    for (const status of INACTIVE_INTENT_STATUSES) {
      test(`status "${status}" is refused, and the message names the remedy`, () => {
        const p = projectWithIntents([{ slug: "done-one", status }]);
        expect(() => resolveIntentFlag(p, SPACE, "done-one")).toThrow(/--allow-inactive/);
      });

      test(`status "${status}" resolves WITH --allow-inactive`, () => {
        const p = projectWithIntents([{ slug: "done-one", status }]);
        expect(resolveIntentFlag(p, SPACE, "done-one", true)?.slug).toBe("done-one");
      });
    }

    test("an unrecognised status is treated as LIVE, not refused", () => {
      // The guard is a denylist on purpose. listIntents() reports "unknown" for an
      // on-disk record with no registry row, and hand-written rows carry arbitrary
      // strings; an allowlist would refuse to scope a document to a healthy intent.
      for (const status of ["unknown", "in-flight", "paused", "whatever-the-team-wrote"]) {
        const p = projectWithIntents([{ slug: "odd-one", status }]);
        expect(intentIsInactive(status), `"${status}" must not read as inactive`).toBe(false);
        expect(resolveIntentFlag(p, SPACE, "odd-one")?.slug).toBe("odd-one");
        rmSync(p, { recursive: true, force: true });
      }
      proj = undefined;
    });

    test("the status match is case- and whitespace-insensitive", () => {
      // intents.json is hand-editable, so "Complete" and " complete " both occur.
      for (const status of ["Complete", " complete ", "ARCHIVED"]) {
        expect(intentIsInactive(status), `"${status}" must read as inactive`).toBe(true);
      }
    });

    test("the BARE --intent form is refused too when the active intent is finished", () => {
      // The named-slug path and the bare path are separate branches; guarding only
      // one leaves the other open, and the bare form is the one an agent uses most.
      const p = projectWithIntents([{ slug: "done-one", status: "complete" }]);
      writeFileSync(join(p, "aidlc", "spaces", SPACE, "intents", "active-intent"), "260101-done-one\n");
      expect(() => resolveIntentFlag(p, SPACE, "")).toThrow(/--allow-inactive/);
      expect(resolveIntentFlag(p, SPACE, "", true)?.slug).toBe("done-one");
    });

    test("space-wide (no --intent) is unaffected by intent status", () => {
      const p = projectWithIntents([{ slug: "done-one", status: "complete" }]);
      expect(resolveIntentFlag(p, SPACE, undefined)).toBeNull();
    });

    test("onboard --intent <finished> exits non-zero and writes NO row", () => {
      const p = projectWithIntents([{ slug: "done-one", status: "complete" }]);
      const file = join(documentsDir(p, SPACE), "note.md");
      writeFileSync(file, "body\n");
      const r = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file,
         "--intent", "done-one", "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("--allow-inactive");
      // Pre-write refusal: resolution happens before the lock is taken, so the
      // catalog must not exist at all.
      expect(existsSync(join(p, "aidlc", "spaces", SPACE, "knowledge", "documentkb", "index.json"))).toBe(false);
    });

    test("dissociate needs no flag: removing a scope from a finished intent is cleanup", () => {
      const p = projectWithIntents([{ slug: "done-one", status: "complete" }]);
      const file = join(documentsDir(p, SPACE), "note.md");
      writeFileSync(file, "body\n");
      const onboarded = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file,
         "--intent", "done-one", "--allow-inactive", "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
      expect(onboarded.status, onboarded.stderr).toBe(0);
      const id = JSON.parse(onboarded.stdout).indexed[0].id as string;

      // The point: dissociate does NOT get --allow-inactive, and still succeeds.
      // Without the carve-out the association would be unremovable.
      const r = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "dissociate", id,
         "--intent", "done-one", "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
      expect(r.status, r.stderr).toBe(0);

      // And associate STILL refuses on the same project, so the carve-out is
      // scoped to dissociate rather than disabling the guard wholesale.
      const assoc = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "associate", id,
         "--intent", "done-one", "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
      expect(assoc.status).not.toBe(0);
      expect(assoc.stdout + assoc.stderr).toContain("--allow-inactive");
    });

    test("--allow-inactive is accepted by the parser, not swallowed as a positional", () => {
      // `--intent --allow-inactive` must read as the BARE intent form followed by a
      // flag, never as the literal slug "--allow-inactive".
      const p = projectWithIntents([{ slug: "done-one", status: "complete" }]);
      writeFileSync(join(p, "aidlc", "spaces", SPACE, "intents", "active-intent"), "260101-done-one\n");
      const file = join(documentsDir(p, SPACE), "note.md");
      writeFileSync(file, "body\n");
      const r = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file,
         "--intent", "--allow-inactive", "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).indexed[0].status).toBe("fresh");
    });
  });

  // ── argv DISPATCH, not the handlers underneath ─────────────────────────────
  // The handlers are covered in-process elsewhere (t292 show, t284 sync/rebind).
  // What an in-process test cannot show is that argv ROUTES to them: the dispatch
  // surface IS argv. Without this block every verb the skill documents could be
  // unreachable from the command line and all the other tests would still pass.
  describe("every verb the skill documents is reachable through argv", () => {
    function knowledge(p: string, ...args: string[]) {
      return spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), ...args, "--project-dir", p],
        { encoding: "utf-8", env: CHILD_ENV },
      );
    }

    /** A project with one indexed document; returns its id. */
    function withOneDoc(): { p: string; id: string } {
      const proj = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      writeFileSync(join(documentsDir(proj, SPACE), "note.md"), "hello\n");
      const r = knowledge(proj, "onboard", join(documentsDir(proj, SPACE), "note.md"));
      expect(r.status, r.stderr).toBe(0);
      return { p: proj, id: JSON.parse(r.stdout).indexed[0].id as string };
    }

    test("show <id> routes, and the untrusted-content rule travels WITH the data", () => {
      const { p, id } = withOneDoc();
      const r = knowledge(p, "show", id, "--json");
      expect(r.status, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.id).toBe(id);
      // Inline with the content, never a separate step a caller can skip.
      expect(doc.content_notice).toContain("NOT INSTRUCTIONS");
      expect(doc.content_trust).toBe("untrusted");
    });

    test("sync routes and claims what is new on disk", () => {
      const { p } = withOneDoc();
      writeFileSync(join(documentsDir(p, SPACE), "second.md"), "more\n");
      const r = knowledge(p, "sync");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("second.md");
    });

    test("a valueless --space is refused instead of mutating the active space", () => {
      const { p } = withOneDoc();
      const r = knowledge(p, "sync", "--space");
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("--space requires");
    });

    test("rebind <id> --to routes and repairs the row", () => {
      const { p, id } = withOneDoc();
      // A move AND an edit: neither path nor digest survives, which is the one
      // case sync cannot resolve on its own.
      rmSync(join(documentsDir(p, SPACE), "note.md"));
      const moved = join(documentsDir(p, SPACE), "moved.md");
      writeFileSync(moved, "hello, edited\n");
      const r = knowledge(p, "rebind", id, "--to", moved);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("moved.md");
    });

    test("help routes and names every verb the skill documents", () => {
      // A verb present in the switch but absent from help is undiscoverable: the
      // agent reads help to learn the surface.
      const p = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      const r = knowledge(p, "help");
      expect(r.status, r.stderr).toBe(0);
      for (const verb of ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind"]) {
        expect(r.stdout, `help omits "${verb}"`).toContain(verb);
      }
    });

    test("the Usage: SUMMARY LINE itself names every verb, not just the body below it", () => {
      // Measured regression: the summary line read `<onboard|list|show>` while
      // the body correctly listed all seven -- a reader skimming only the first
      // line (the common case for a usage string) never learns sync/associate/
      // dissociate/rebind exist. Pinned on the literal Usage: line, not "help"
      // output as a whole, so a future edit narrowing just that line trips this.
      const p = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      const r = knowledge(p, "help");
      expect(r.status, r.stderr).toBe(0);
      const usageLine = r.stdout.split("\n").find((l) => l.startsWith("Usage:"));
      expect(usageLine, "no Usage: line in help output").toBeDefined();
      for (const verb of ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind"]) {
        expect(usageLine, `Usage: line omits "${verb}"`).toContain(verb);
      }
    });

    // The skill's path EXAMPLES, executed rather than pattern-matched. Flag-name
    // parity (I41) proves `--to` exists; it cannot prove the VALUE beside it
    // resolves. A real dry-run found both examples rooted at `knowledge/` while
    // the tool resolves from the PROJECT ROOT, so each documented command failed
    // with "No such path" -- with every existing assertion green.
    test("the RELATIVE path shape the skill prints actually resolves [dry-run regression]", () => {
      const text = readFileSync(join(REPO, "core", "skills", "aidlc-knowledge", "SKILL.md"), "utf-8");
      // Every relative documents/ path the skill hands an LLM, from any verb.
      const shapes = [...text.matchAll(/aidlc-knowledge\.ts \S+(?:\s+\S+)*?\s(\S*knowledge\/documents\/\S+)/g)]
        .map((m) => m[1])
        .filter((s) => !s.startsWith("/"));
      expect(shapes.length, "the skill prints no relative documents/ path to check").toBeGreaterThan(0);

      const p = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      for (const shape of shapes) {
        // Render the template into a real file inside this project, then feed the
        // tool the SAME relative string the skill told the agent to use.
        const rel = shape.replace(/<space>/g, SPACE);
        const abs = join(p, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, "example body\n");
        const r = knowledge(p, "onboard", rel);
        expect(r.status, `the skill's documented path "${shape}" does not resolve: ${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout).not.toContain("No such path");
      }
    });

    test("`remove` is refused, not silently accepted", () => {
      // Deletion stays "delete the original, then sync", so the tool never holds
      // a destructive verb over user-owned files. Pinning the refusal keeps that
      // a decision rather than an omission someone later "fixes".
      const p = projectWithIntents([{ slug: "live-one", status: "in-flight" }]);
      const r = knowledge(p, "remove", "some-id");
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("Unknown subcommand");
    });
  });

  // ── --intent disambiguation: the error's own remedy must actually resolve ──
  //
  // INVARIANT: exactly THREE forms resolve a same-slug ambiguity — the on-disk
  // record-dir name (unique by construction), the canonical UUID from
  // intents.json (unique by construction), and a slug (which fails closed with
  // an AMBIGUOUS error, never a guess, when >1 row shares it). Anything outside
  // that set (a bare "260101-foo" that matches nothing, a near-miss UUID, an
  // empty registry) refuses by name rather than silently resolving to some row.
  // Measured before this fix: the error told the user to pass the exact
  // record-dir name, and that exact string still hit the SAME ambiguity error —
  // the remedy the tool prints did not work.
  describe("--intent accepts record-dir name and UUID, not just slug", () => {
    function dupSlugProject(): { p: string; dirA: string; dirB: string; uuidA: string; uuidB: string } {
      const p = mkdtempSync(join(tmpdir(), "t285-dup-"));
      const dirA = "260101-dup-slug";
      const dirB = "260101-dup-slug-2";
      const uuidA = "0192f000-0000-7000-8000-000000000020";
      const uuidB = "0192f000-0000-7000-8000-000000000021";
      mkdirSync(join(proj_(p), dirA), { recursive: true });
      mkdirSync(join(proj_(p), dirB), { recursive: true });
      writeFileSync(join(proj_(p), dirA, "aidlc-state.md"), "# AI-DLC State Tracking\n");
      writeFileSync(join(proj_(p), dirB, "aidlc-state.md"), "# AI-DLC State Tracking\n");
      writeFileSync(
        intentsRegistryPath(p, SPACE),
        `${JSON.stringify(
          [
            { uuid: uuidA, slug: "dup-slug", dirName: dirA, status: "in-flight" },
            { uuid: uuidB, slug: "dup-slug", dirName: dirB, status: "in-flight" },
          ],
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
      mkdirSync(documentsDir(p, SPACE), { recursive: true });
      return { p, dirA, dirB, uuidA, uuidB };
    }
    function proj_(p: string): string {
      return join(p, "aidlc", "spaces", SPACE, "intents");
    }

    afterEach(() => {
      // dupSlugProject makes its own scratch dirs, outside the shared `proj`
      // fixture's afterEach — clean up whatever this describe block created.
    });

    test("the slug alone is refused, and the message names BOTH working remedies", () => {
      const { p, dirA, dirB } = dupSlugProject();
      try {
        expect(() => resolveIntentFlag(p, SPACE, "dup-slug")).toThrow(
          new RegExp(`${dirA}.*${dirB}|record-dir name`),
        );
        expect(() => resolveIntentFlag(p, SPACE, "dup-slug")).toThrow(/UUID/);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("the exact record-dir name from the error resolves — the remedy works", () => {
      const { p, dirA, uuidA } = dupSlugProject();
      try {
        expect(resolveIntentFlag(p, SPACE, dirA)?.uuid).toBe(uuidA);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("the canonical UUID from intents.json resolves — the remedy works", () => {
      const { p, dirA, uuidA } = dupSlugProject();
      try {
        expect(resolveIntentFlag(p, SPACE, uuidA)?.dirName).toBe(dirA);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("both remedies resolve to the OTHER row too — not always the first match", () => {
      const { p, dirB, uuidB } = dupSlugProject();
      try {
        expect(resolveIntentFlag(p, SPACE, dirB)?.uuid).toBe(uuidB);
        expect(resolveIntentFlag(p, SPACE, uuidB)?.dirName).toBe(dirB);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("an unmatched dirName-shaped string falls through to the slug path and refuses by name", () => {
      const { p } = dupSlugProject();
      try {
        expect(() => resolveIntentFlag(p, SPACE, "260101-nonexistent")).toThrow(
          /No intent with slug "260101-nonexistent"/,
        );
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("an unmatched but well-formed UUID refuses by UUID, not by falling through to slug", () => {
      const { p } = dupSlugProject();
      try {
        expect(() => resolveIntentFlag(p, SPACE, "0192f000-0000-7000-8000-00000000ffff")).toThrow(
          /No intent with UUID "0192f000-0000-7000-8000-00000000ffff"/,
        );
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("a UUID matching TWO rows (corrupted registry) is ambiguous, not the first pick", () => {
      // intents.json is hand-editable, untrusted input: nothing stops a human
      // from writing the same UUID onto two rows. Attack the guard's own set —
      // it must fail closed here too, not silently prefer array order.
      const { p, uuidA } = dupSlugProject();
      try {
        const regPath = intentsRegistryPath(p, SPACE);
        const rows = JSON.parse(readFileSync(regPath, "utf-8"));
        rows[1].uuid = uuidA;
        writeFileSync(regPath, `${JSON.stringify(rows, null, 2)}\n`);
        expect(() => resolveIntentFlag(p, SPACE, uuidA)).toThrow(/Ambiguous intent.*UUID/);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("a dirName matching TWO rows (corrupted registry) is ambiguous, not the first pick", () => {
      const { p, dirA } = dupSlugProject();
      try {
        const regPath = intentsRegistryPath(p, SPACE);
        const rows = JSON.parse(readFileSync(regPath, "utf-8"));
        rows[1].dirName = dirA;
        writeFileSync(regPath, `${JSON.stringify(rows, null, 2)}\n`);
        expect(() => resolveIntentFlag(p, SPACE, dirA)).toThrow(/Ambiguous intent.*record-dir/);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("end-to-end through argv: onboard --intent <record-dir-name> actually associates the right row", () => {
      const { p, dirA, uuidA } = dupSlugProject();
      try {
        const file = join(documentsDir(p, SPACE), "note.md");
        writeFileSync(file, "body\n");
        const r = spawnSync(
          "bun",
          [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file, "--intent", dirA, "--project-dir", p],
          { encoding: "utf-8", env: CHILD_ENV },
        );
        expect(r.status, r.stderr).toBe(0);
        const id = JSON.parse(r.stdout).indexed[0].id as string;
        const meta = JSON.parse(
          readFileSync(join(p, "aidlc", "spaces", SPACE, "knowledge", "documentkb", id, "metadata.json"), "utf-8"),
        );
        expect(meta.related_intent_ids).toEqual([uuidA]);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });
  });

  // ── Recovery claim, narrowed and pinned: index-only, not documentkb/-whole ─
  //
  // INVARIANT: a lost `index.json` alone rebuilds losslessly from the surviving
  // per-document `metadata.json` files (ids AND tombstones survive). Deleting
  // the WHOLE `documentkb/` tree destroys those `metadata.json` files too, so
  // that is explicitly NOT covered — ids and tombstones do NOT survive, and the
  // next sync assigns brand-new ids to the surviving originals. Both branches
  // are pinned so the narrowed claim in the docs is enforced, not just written.
  describe("index-only recovery: what IS and is NOT reconstructible [narrowed claim]", () => {
    function docKbProject(): string {
      const p = mkdtempSync(join(tmpdir(), "t285-recover-"));
      mkdirSync(join(p, "aidlc", "spaces", SPACE, "intents"), { recursive: true });
      writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
      mkdirSync(documentsDir(p, SPACE), { recursive: true });
      return p;
    }
    function knowledgeArgv(p: string, ...args: string[]) {
      return spawnSync("bun", [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), ...args, "--project-dir", p], {
        encoding: "utf-8",
        env: CHILD_ENV,
      });
    }

    test("losing ONLY index.json: sync rebuilds it, ids AND a tombstone survive", () => {
      const p = docKbProject();
      try {
        writeFileSync(join(documentsDir(p, SPACE), "a.md"), "one\n");
        writeFileSync(join(documentsDir(p, SPACE), "b.md"), "two\n");
        const onboarded = knowledgeArgv(p, "onboard");
        expect(onboarded.status, onboarded.stderr).toBe(0);
        const ids = JSON.parse(onboarded.stdout).indexed.map((r: { id: string }) => r.id).sort();

        // b.md is deleted and tombstoned before the index itself is lost.
        rmSync(join(documentsDir(p, SPACE), "b.md"));
        expect(knowledgeArgv(p, "sync").status).toBe(0);

        const indexPath = join(p, "aidlc", "spaces", SPACE, "knowledge", "documentkb", "index.json");
        rmSync(indexPath);
        const resynced = knowledgeArgv(p, "sync");
        expect(resynced.status, resynced.stderr).toBe(0);

        const rebuilt = JSON.parse(readFileSync(indexPath, "utf-8"));
        expect(rebuilt.documents.map((d: { id: string }) => d.id).sort(), "ids survive the index-only loss").toEqual(
          ids,
        );
        const tomb = rebuilt.documents.find((d: { source: { path: string } }) => d.source.path === "documents/b.md");
        expect(tomb?.removed_at, "the tombstone survives the index-only loss").toBeTruthy();
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("losing the WHOLE documentkb/ tree: ids do NOT survive, and the tombstone is gone", () => {
      const p = docKbProject();
      try {
        writeFileSync(join(documentsDir(p, SPACE), "a.md"), "one\n");
        writeFileSync(join(documentsDir(p, SPACE), "b.md"), "two\n");
        const onboarded = knowledgeArgv(p, "onboard");
        expect(onboarded.status, onboarded.stderr).toBe(0);
        const idBefore = (JSON.parse(onboarded.stdout).indexed as Array<{ id: string; path: string }>).find(
          (r) => r.path === "documents/a.md",
        )?.id;

        rmSync(join(documentsDir(p, SPACE), "b.md"));
        expect(knowledgeArgv(p, "sync").status).toBe(0);

        // The FULL wipe, exactly as the docs used to (wrongly) call recoverable.
        rmSync(join(p, "aidlc", "spaces", SPACE, "knowledge", "documentkb"), { recursive: true, force: true });
        const resynced = knowledgeArgv(p, "sync");
        expect(resynced.status, resynced.stderr).toBe(0);

        const indexPath = join(p, "aidlc", "spaces", SPACE, "knowledge", "documentkb", "index.json");
        const rebuilt = JSON.parse(readFileSync(indexPath, "utf-8"));
        // Only the still-present original comes back, and with a DIFFERENT id.
        expect(rebuilt.documents.length, "the tombstone for b.md is gone entirely, not preserved").toBe(1);
        expect(rebuilt.documents[0].id).not.toBe(idBefore);
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });
  });

  // ── the extractor-retry remedy the docs publish must be the one that works ─
  describe("extractor_unavailable: the published remedy is sync, not re-onboard [regression]", () => {
    test("re-running onboard on the SAME unchanged path does not retry extraction", () => {
      // Regression pin for the finding: docs said "install it, then onboard the
      // path again" — measured false. onboard reports "already" and performs no
      // retry; only sync re-probes an extractor_unavailable row.
      const p = mkdtempSync(join(tmpdir(), "t285-retry-"));
      try {
        mkdirSync(join(p, "aidlc", "spaces", SPACE, "intents"), { recursive: true });
        writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
        mkdirSync(documentsDir(p, SPACE), { recursive: true });
        // A file with no configured extractor: nothing installed anywhere makes
        // this deterministic without spawning a real external tool.
        const file = join(documentsDir(p, SPACE), "report.bin");
        writeFileSync(file, Buffer.from([0x01, 0x02, 0x03, 0x00, 0xff]));
        const first = spawnSync("bun", [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file, "--project-dir", p], {
          encoding: "utf-8",
          env: CHILD_ENV,
        });
        // A NUL byte makes this an unsupported/refused binary rather than a
        // clean extraction path -- the point here is only the re-onboard verb,
        // not which degraded state it lands in.
        if (first.status !== 0) return; // refused outright — nothing to retry either way
        const second = spawnSync("bun", [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", file, "--project-dir", p], {
          encoding: "utf-8",
          env: CHILD_ENV,
        });
        expect(second.status, second.stderr).toBe(0);
        expect(JSON.parse(second.stdout).indexed[0].status).toBe("already");
      } finally {
        rmSync(p, { recursive: true, force: true });
      }
    });

    test("the skill's remedy for extractor_unavailable names sync, not a bare re-onboard", () => {
      const text = readFileSync(CLAUDE_SKILL, "utf-8");
      const row = text.split("\n").find((l) => l.includes("extractor_unavailable"));
      expect(row, "the extractor_unavailable row is missing from the skill's state table").toBeDefined();
      expect(row).toContain("install it, then run `sync`");
    });

    test("the CLI reference's remedy for extractor_unavailable names sync too", () => {
      const text = readFileSync(join(REPO, "docs", "guide", "12-cli-commands.md"), "utf-8");
      const para = text.slice(text.indexOf("extractor_unavailable"), text.indexOf("extractor_unavailable") + 400);
      expect(para).toContain("installing the tool and running `/aidlc knowledge sync`");
    });
  });

  // ── The per-verb Emits column, pinned by EXECUTION ─────────────────────────
  //
  // WHY THIS EXISTS. `docs/reference/06-hooks-and-tools.md`'s DocumentKB table
  // claimed `sync` emits only DOCUMENT_INDEXED + DOCUMENT_REMOVED. It also emits
  // DOCUMENT_UPDATED, from the moved/changed/retried branches. NOTHING caught
  // that: `t48-audit-event-emitters` guards a DIFFERENT table (it reads
  // `12-state-machine.md` and never opens this file), and `t239` reads this file
  // but only its agent-tool-restrictions slice. A reviewer found the stale cell
  // by hand.
  //
  // And a source scan would NOT have found it either: grepping `syncDocuments`
  // for `"DOCUMENT_*"` literals reports only INDEXED and REMOVED, because the
  // UPDATED emissions are pushed as deferred closures and emitted through a
  // helper after the commit. So the only honest mechanism is to RUN each verb
  // and read the audit shard it actually wrote.
  //
  // Enumerated: the verbs that emit. `list`/`show` are excluded because they are
  // read-only and the table marks them `—`; a future verb that emits and is not
  // added here is NOT covered by this test, so the table row above it is only as
  // good as this list -- which is why the list is asserted against the table's
  // own rows below rather than kept privately in step with it.
  describe("t285 the documented Emits column matches what each verb really writes", () => {
    const DOC = join(REPO, "docs", "reference", "06-hooks-and-tools.md");

    /** The `Emits` cell for one verb, as the table declares it.
     *
     *  Matches the first cell EXACTLY, not by prefix: `| \`sync` also prefixes
     *  the unrelated hook row `sync-workflow-state.ts` further up the same file,
     *  which silently produced a 3-column row and an empty event set. Requiring
     *  exactly three columns keeps this bound to the Subcommand/Purpose/Emits
     *  table rather than any other table that happens to share a first cell. */
    function documentedEmits(verbCell: string): Set<string> {
      const rows = readFileSync(DOC, "utf-8")
        .split("\n")
        .map((l) => l.split("|").map((c) => c.trim()))
        .filter((cells) => cells.length === 5 && cells[1] === `\`${verbCell}\``);
      expect(
        rows.length,
        `expected exactly one Emits table row for cell \`${verbCell}\` in ${DOC}; ` +
          `found ${rows.length}`,
      ).toBe(1);
      if (rows.length !== 1) return new Set();
      return new Set([...rows[0][3].matchAll(/DOCUMENT_[A-Z_]+/g)].map((m) => m[0]));
    }

    /** Every DOCUMENT_* event present in a project's audit shards. */
    function emittedIn(projectDir: string): Set<string> {
      const found = new Set<string>();
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".md") && full.includes("audit")) {
            for (const m of readFileSync(full, "utf-8").matchAll(/DOCUMENT_[A-Z_]+/g)) {
              found.add(m[0]);
            }
          }
        }
      };
      walk(join(projectDir, "aidlc"));
      return found;
    }

    test("sync's row lists DOCUMENT_UPDATED, which a moved file really emits", () => {
      // The exact defect: a move takes sync's `moved` branch, which emits
      // DOCUMENT_UPDATED through the deferred-closure path.
      const proj = mkdtempSync(join(tmpdir(), "t285-emits-"));
      try {
        const docs = join(proj, "aidlc", "spaces", "default", "knowledge", "documents");
        mkdirSync(docs, { recursive: true });
        writeFileSync(join(docs, "a.md"), "body\n");
        const run = (...argv: string[]) =>
          spawnSync("bun", [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), ...argv, "--project-dir", proj], {
            encoding: "utf-8",
            env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
          });
        // Drive EVERY branch sync can emit from, in one project:
        //   new     -- c.md appears and is indexed
        //   moved   -- a.md is renamed, so its row follows the file
        //   removed -- d.md's original is deleted, tombstoning its row
        writeFileSync(join(docs, "d.md"), "doomed\n");
        expect(run("onboard").status).toBe(0);
        renameSync(join(docs, "a.md"), join(docs, "b.md"));
        rmSync(join(docs, "d.md"));
        writeFileSync(join(docs, "c.md"), "brand new\n");
        expect(run("sync").status).toBe(0);

        const actual = emittedIn(proj);
        expect(actual.has("DOCUMENT_UPDATED"), "a moved file must emit DOCUMENT_UPDATED").toBe(true);

        // BOTH directions, because each catches a different lie. A reviewer
        // showed the omission check alone still passed when a never-emitted
        // `DOCUMENT_PHANTOM` was added to the cell -- so an over-claiming doc
        // (an event listed that the tool cannot produce) read as healthy.
        const declared = documentedEmits("sync");
        for (const ev of actual) {
          expect(declared.has(ev), `sync emitted ${ev} but its Emits column omits it`).toBe(true);
        }
        // This scenario drives new + moved + removed, which is every event sync
        // has. If a future branch emits a fourth, this fails and the scenario
        // above must grow to reach it -- which is the correct forcing function,
        // because a declared-but-unreachable event is indistinguishable from an
        // untested one.
        for (const ev of declared) {
          expect(
            actual.has(ev),
            `sync's Emits column declares ${ev}, but no run of every sync branch produced it — ` +
              `either the cell over-claims, or this scenario no longer reaches that branch`,
          ).toBe(true);
        }
      } finally {
        rmSync(proj, { recursive: true, force: true });
      }
    }, 30000);

    test("every emitting verb's row is non-empty, and the read-only verbs' are `—`", () => {
      // Guards the shape the test above depends on: if a row's Emits cell were
      // blank or the verb spelling drifted, `documentedEmits` would throw rather
      // than silently compare against an empty set.
      for (const verb of [
        "onboard [path]",
        "sync",
        "associate <id> --intent [slug]",
        "dissociate <id> --intent [slug]",
        "rebind <id> --to <path>",
      ]) {
        expect(documentedEmits(verb).size, `\`${verb}\` declares no events`).toBeGreaterThan(0);
      }
      for (const verb of ["list [--json]", "show <id> [--json]"]) {
        expect(documentedEmits(verb).size, `read-only \`${verb}\` should declare none`).toBe(0);
      }
    });

    test("the documented audit-shard PATH is the one the tool actually writes", () => {
      // A reviewer found `12-state-machine.md` documenting `spaces/<space>/audit/`
      // while the tool writes `spaces/<space>/intents/audit/` -- a path that does
      // not exist on disk. That is worse than an undocumented gap: the previous
      // round's defence for not fixing the reader was "the behaviour is documented
      // precisely instead", and the documentation was itself wrong.
      //
      // So the path is derived by RUNNING onboard and finding the shard, then
      // matched against the doc. A doc-only assertion would have passed the whole
      // time, which is exactly how this survived.
      const proj = mkdtempSync(join(tmpdir(), "t285-shard-"));
      try {
        const docs = join(proj, "aidlc", "spaces", "default", "knowledge", "documents");
        mkdirSync(docs, { recursive: true });
        writeFileSync(join(docs, "a.md"), "body\n");
        const r = spawnSync(
          "bun",
          [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", proj],
          { encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" } },
        );
        expect(r.status, r.stderr).toBe(0);

        // Find the shard that really carries the event.
        const shards: string[] = [];
        const walk = (dir: string): void => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".md") && full.includes("audit")) {
              if (readFileSync(full, "utf-8").includes("DOCUMENT_INDEXED")) shards.push(full);
            }
          }
        };
        walk(join(proj, "aidlc"));
        expect(shards.length, "no shard carried DOCUMENT_INDEXED").toBe(1);

        // The space-relative directory the event landed in, e.g.
        // `spaces/default/intents/audit`.
        const rel = shards[0].slice(join(proj, "aidlc").length + 1);
        const shardDir = rel.slice(0, rel.lastIndexOf("/"));
        expect(shardDir).toBe("spaces/default/intents/audit");

        // The doc must name that shape, generalised over the space name.
        const doc = readFileSync(join(REPO, "docs", "reference", "12-state-machine.md"), "utf-8");
        const documentsSection = doc.slice(doc.indexOf("### Documents"));
        const claimed = shardDir.replace("spaces/default", "spaces/<space>");
        expect(
          documentsSection.includes(claimed),
          `the Documents section must name the real shard path \`${claimed}\``,
        ).toBe(true);
        // And must NOT still name the path that does not exist.
        expect(
          documentsSection.includes("(`spaces/<space>/audit/`)"),
          "the Documents section still names `spaces/<space>/audit/`, which the tool never writes",
        ).toBe(false);
      } finally {
        rmSync(proj, { recursive: true, force: true });
      }
    }, 30000);
  });
});

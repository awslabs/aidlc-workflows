// covers: function:parseNextFlags, subcommand:aidlc-orchestrate:next, function:splitKiroCommandArgs
//
// A seeded property sweep of the `/aidlc` line. The flag parser is the one
// reader of that line, so what it does with a line nobody wrote on purpose is
// the person's problem the moment an agent forwards their words verbatim: a
// misspelt name, a Windows path, an emoji, a quoted sentence, CRLF from a
// Windows clone. Every case here is generated from a fixed seed and a fixed
// count, so CI runs exactly these lines; a failure prints the seed and the line
// to re-run. The invariants are the ones the engine promises: it never throws,
// the person's words are never dropped or reordered, a known flag with a valid
// value is always that flag, a flag-shaped token before their first word is
// never read as work and never reaches them, one among their words stays their
// text (#847), and `next` writes no audit record for a line of flags alone.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  hooksHealthDir,
  readAuditShardEvents,
  splitKiroCommandArgs,
  validScopes,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { nextArgsAreOnlyWords, parseNextFlags, typedSettingModifiers } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// Fixed so CI runs these exact lines. Change either and the sweep is a new one:
// print them in every failure message so a red is reproducible from the log.
const SEED = 20261010;
const CASES = 600;
// Lines routed through the tool itself, and through a host's human-turn hook:
// each costs a process, so a deterministic slice of the sweep carries them.
const ROUTED = 24;
const HOOKED = 8;

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000d001";

/** mulberry32: a seeded generator, so no dependency and no clock. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUED_FLAGS: Array<{ flag: string; valid: string; field: string }> = [
  { flag: "--scope", valid: "bugfix", field: "scope" },
  { flag: "--depth", valid: "minimal", field: "depth" },
  { flag: "--test-strategy", valid: "standard", field: "testStrategy" },
  { flag: "--review", valid: "advisory", field: "review" },
  { flag: "--guard-policy", valid: "relaxed", field: "changeControl" },
  { flag: "--project-type", valid: "greenfield", field: "projectType" },
  { flag: "--plan-name", valid: "my-plan", field: "planName" },
  { flag: "--request", valid: "1a2b3c4d", field: "request" },
];
const CEREMONY_VALUED = ["--sensors", "--learnings", "--summary-confirmation", "--collaborators", "--plan-approval"];
const FENCE_VALUED = ["--guard.review-freeze", "--guard.state-transition", "--guard.reviewer-scope", "--guard.plan-approval"];
const BOOLEAN_FLAGS = ["--resume", "--single", "--new-intent", "--continue", "--new-scope", "--change", "--every-unit"];
// Flags whose values are a closed set the parser checks itself, so a word
// outside it is a parse error naming what is valid. `--plan-name` takes any
// kebab word, `--request` and `--scope` any token (the route validates the
// scope later), so no generated word is invalid for them.
const CLOSED_VALUE_FLAGS = [
  "--depth", "--test-strategy", "--review", "--guard-policy", "--project-type",
  ...CEREMONY_VALUED, ...FENCE_VALUED,
];
// Flags that read their value only when one follows, so a line ending on one
// falls through to the untaken rule instead of a parse error.
const VALUE_OR_UNTAKEN_FLAGS = ["--scope", "--stage", "--phase"];
const BAD_VALUES = ["banana", "Minimal!", "off-ish", "--scope"];
const ANSWER_FLAGS = [
  "--choice", "--details", "--decision", "--answer", "--user-input", "--feedback",
  "--result", "--verdict", "--mode", "--approve", "--session",
];
// One edit away from a flag the engine takes: the person's own slip.
const MISSPELT = [
  "--plan-aprroval", "--scpe", "--depht", "--guard-polcy", "--new-intnet",
  "--sumary-confirmation", "--revew", "--sensores", "--guard.reviewfreeze", "--test-stategy",
];
const UNKNOWN = ["--nonsense", "--xyzzy", "--dark-mode", "--enable", "--review-freeze", "--verbose-output"];
// `--flag=value`: the engine takes no flag in this form, so each is untaken.
const EQUALS_FORMS = ["--choice=Approve Plan", "--depth=minimal", "--scope=bugfix", "--nonsense=1"];
// Words a person writes. No scope name, verb or noun of the engine's own, and
// nothing that opens with the entry word, so each case's words are unambiguous.
const PLAIN_WORDS = [
  "add", "the", "export", "button", "to", "settings", "page", "crash", "when", "saving",
  "please", "also", "update", "docs", "for", "it",
];
const EXOTIC_WORDS = [
  "café", "naïve", "日本語のテキスト", "🚀", "an emoji 🙂 inside", 'he said "hello" loudly',
  "it's", "C:\\Users\\Dev Tools\\out.txt", "D:\\build\\x y\\z.txt", "tab\there",
  "crlf\r\nsecond line", "a".repeat(400), "--help flag for the reverser", "100% done",
  "cost: $5", "a|b", "back\\slash", "semi;colon", "paren(s)", "star*",
];

type Shape =
  | "words-only"
  | "valued-flag"
  | "ceremony-flag"
  | "fence-flag"
  | "boolean-flag"
  | "bad-value"
  | "missing-value"
  | "valueless-positional"
  | "untaken-answer"
  | "untaken-misspelt"
  | "untaken-unknown"
  | "untaken-equals"
  | "flag-after-words"
  | "after-delimiter"
  | "blank";

interface Case {
  shape: Shape;
  argv: string[];
  /** The person's words this line carries, in order, or null when it carries none. */
  tail: string[] | null;
  /** The flag-shaped token before their first word, when the shape has one. */
  untaken?: string;
  /** For a known flag: what the parse must read. */
  reads?: { field: string; value: string };
}

const SCOPES = new Set([...validScopes()]);
function safeWords(next: () => number, count: number): string[] {
  const words: string[] = [];
  while (words.length < count) {
    const exotic = next() < 0.3;
    const pool = exotic ? EXOTIC_WORDS : PLAIN_WORDS;
    const word = pool[Math.floor(next() * pool.length)];
    // A leading scope name is positional scope syntax and a leading flag-shaped
    // token is the untaken case: neither is the plain-words shape under test.
    if (words.length === 0 && (SCOPES.has(word) || word.startsWith("--") || /^[A-Za-z][\w-]*:/.test(word))) continue;
    words.push(word);
  }
  return words;
}

function buildCase(next: () => number): Case {
  const shapes: Shape[] = [
    "words-only", "valued-flag", "ceremony-flag", "fence-flag", "boolean-flag", "bad-value",
    "missing-value", "valueless-positional", "untaken-answer", "untaken-misspelt", "untaken-unknown",
    "untaken-equals", "flag-after-words", "after-delimiter", "blank",
  ];
  const shape = shapes[Math.floor(next() * shapes.length)];
  const tailLength = 1 + Math.floor(next() * 3);
  const tail = safeWords(next, tailLength);
  const pick = <T,>(pool: readonly T[]): T => pool[Math.floor(next() * pool.length)];
  switch (shape) {
    case "words-only":
      return { shape, argv: [...tail], tail };
    case "valued-flag": {
      const entry = pick(VALUED_FLAGS);
      const withTail = next() < 0.6;
      return {
        shape,
        argv: withTail ? [entry.flag, entry.valid, ...tail] : [entry.flag, entry.valid],
        tail: withTail ? tail : null,
        reads: { field: entry.field, value: entry.valid },
      };
    }
    case "ceremony-flag": {
      const flag = pick(CEREMONY_VALUED);
      const value = next() < 0.5 ? "on" : "off";
      const withTail = next() < 0.6;
      return { shape, argv: withTail ? [flag, value, ...tail] : [flag, value], tail: withTail ? tail : null };
    }
    case "fence-flag": {
      const flag = pick(FENCE_VALUED);
      const value = next() < 0.5 ? "on" : "off";
      const withTail = next() < 0.6;
      return { shape, argv: withTail ? [flag, value, ...tail] : [flag, value], tail: withTail ? tail : null };
    }
    case "boolean-flag": {
      const flag = pick(BOOLEAN_FLAGS);
      // A boolean followed by the person's words: the words are theirs, and no
      // value is eaten off the front of them.
      return { shape, argv: [flag, ...tail], tail };
    }
    case "bad-value": {
      const flag = pick(CLOSED_VALUE_FLAGS);
      return { shape, argv: [flag, pick(BAD_VALUES)], tail: null };
    }
    case "missing-value": {
      const flag = pick(CLOSED_VALUE_FLAGS);
      return { shape, argv: [flag], tail: null };
    }
    case "valueless-positional": {
      const flag = pick(VALUE_OR_UNTAKEN_FLAGS);
      return { shape, argv: [flag], tail: null };
    }
    case "untaken-answer":
    case "untaken-misspelt":
    case "untaken-unknown":
    case "untaken-equals": {
      const token = shape === "untaken-answer"
        ? pick(ANSWER_FLAGS)
        : shape === "untaken-misspelt"
          ? pick(MISSPELT)
          : shape === "untaken-unknown"
            ? pick(UNKNOWN)
            : pick(EQUALS_FORMS);
      const withTail = next() < 0.6;
      return {
        shape,
        argv: withTail ? [token, ...tail] : [token],
        tail: withTail ? tail : null,
        untaken: token,
      };
    }
    case "flag-after-words": {
      // A flag-shaped token at the end of their own sentence: a setting they
      // misspelt, or a flag they want built. The engine takes neither.
      const token = pick([...ANSWER_FLAGS, ...MISSPELT, ...UNKNOWN]);
      return { shape, argv: [...tail, token, "off"], tail, untaken: token };
    }
    case "after-delimiter": {
      const token = pick([...ANSWER_FLAGS, ...MISSPELT, ...UNKNOWN, ...EQUALS_FORMS]);
      return { shape, argv: ["--", token, ...tail], tail: [token, ...tail] };
    }
    case "blank":
      return { shape, argv: pick([[], [""], ["   "], ["\t"], ["\r\n"]]) as string[], tail: null };
  }
}

const cases: Case[] = (() => {
  const next = rng(SEED);
  return Array.from({ length: CASES }, () => buildCase(next));
})();

/** Every failure says how to reproduce itself. */
function where(testCase: Case): string {
  return `seed=${SEED} shape=${testCase.shape} argv=${JSON.stringify(testCase.argv)}`;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

describe("the flag parser over a seeded sweep of lines", () => {
  test(`reads ${CASES} generated lines without throwing, and never swallows a word`, () => {
    for (const testCase of cases) {
      const note = where(testCase);
      let parsed: ReturnType<typeof parseNextFlags>;
      try {
        parsed = parseNextFlags(testCase.argv);
      } catch (error) {
        throw new Error(`${note} threw ${String(error)}`);
      }
      expect(parsed, note).toBeDefined();

      // A flag the engine takes, with a value it accepts, is always that flag.
      if (testCase.reads) {
        expect((parsed as Record<string, unknown>)[testCase.reads.field], note).toBe(testCase.reads.value);
        expect(parsed.untakenFlag, note).toBeUndefined();
        expect(parsed.parseError, note).toBeUndefined();
      }

      // A value the flag does not accept, or none at all, is a parse error that
      // names what is valid. Never a throw, and never work named after it.
      if (testCase.shape === "bad-value" || testCase.shape === "missing-value") {
        expect(typeof parsed.parseError, note).toBe("string");
        expect(String(parsed.parseError), note).toContain(testCase.argv[0].split("=")[0]);
      }

      // A flag that reads its value only when one follows: a line ending on it
      // is either a parse error or the untaken rule, never a throw and never
      // work named after the flag.
      if (testCase.shape === "valueless-positional") {
        const named = typeof parsed.parseError === "string" || parsed.untakenFlag === testCase.argv[0];
        expect(named, `${note} parsed=${JSON.stringify(parsed)}`).toBe(true);
        expect(parsed.intent, note).toBeUndefined();
      }

      // A flag-shaped token after their words is untaken too: where it sits says
      // nothing about what they meant by it. The words before it stand, and the
      // line is still their words, so a reply of theirs stays a reply.
      if (testCase.shape === "flag-after-words") {
        expect(parsed.untakenFlag, note).toBe(testCase.untaken);
        expect(parsed.untakenFlagValue, note).toBe("off");
        expect(parsed.intent, note).toBe((testCase.tail ?? []).join(" "));
      } else if (testCase.untaken !== undefined) {
        // A flag-shaped token before the person's first word is untaken, whatever
        // its spelling, and it never becomes the work's description.
        expect(parsed.untakenFlag, note).toBe(testCase.untaken);
        expect(parsed.intent ?? "", note).not.toContain(testCase.untaken);
        // It takes at most one following word as its value, and the print names
        // that word, so nothing of the line is dropped in silence.
        if (testCase.tail !== null) {
          const first = testCase.tail[0];
          const takesValue = !first.startsWith("--") && !/\s/.test(first);
          if (takesValue) {
            expect(parsed.untakenFlagValue, note).toBe(first);
            const rest = testCase.tail.slice(1);
            expect(parsed.intent ?? "", note).toBe(rest.join(" "));
          }
        } else {
          expect(parsed.intent, note).toBeUndefined();
        }
      }

      // The person's words reach the request whole and in order, for every
      // shape whose words the engine keeps.
      if (
        testCase.tail !== null &&
        testCase.untaken === undefined &&
        testCase.shape !== "bad-value" &&
        testCase.shape !== "missing-value" &&
        testCase.shape !== "valueless-positional"
      ) {
        expect(parsed.intent, note).toBe(testCase.tail.join(" "));
      }

      // After the delimiter every token is theirs, word for word, and nothing
      // is untaken: that is the lossless way the print names (#847).
      if (testCase.shape === "after-delimiter") {
        expect(parsed.untakenFlag, note).toBeUndefined();
        expect(parsed.intent, note).toBe((testCase.tail ?? []).join(" "));
      }

      // A blank line asks for nothing and describes nothing.
      if (testCase.shape === "blank") {
        expect(parsed.untakenFlag, note).toBeUndefined();
        expect(parsed.parseError, note).toBeUndefined();
      }

      // A typed line that is the person's words stays their words, whatever
      // flag-shaped token sits among them: the human-turn hook reads this to
      // decide their `/aidlc` line is a reply, so a token this engine does not
      // take must never file their reply as a command of its own.
      if (
        (testCase.shape === "words-only" || testCase.shape === "flag-after-words") &&
        parsed.parseError === undefined
      ) {
        expect(nextArgsAreOnlyWords(testCase.argv), `${note} parsed=${JSON.stringify(parsed)}`).toBe(true);
      }

      // Every setting the line carries survives the form the answer commands
      // carry it in (`--<key> <value>`), so a question asked again keeps it.
      const modifiers = typedSettingModifiers(parsed);
      if (modifiers.length > 0 && parsed.parseError === undefined) {
        const carried = modifiers.flatMap((modifier) => [`--${modifier.split(" ")[0]}`, modifier.split(" ")[1]]);
        expect(typedSettingModifiers(parseNextFlags(carried)), `${note} carried=${JSON.stringify(carried)}`)
          .toEqual(modifiers);
      }
    }
  });

  // The Kiro seam splits one command line into the argv the engine reads. For
  // every generated line whose words need no quoting, the split returns exactly
  // the tokens, so the two readings of one line never disagree.
  test("the Kiro command splitter returns the same tokens for a line that needs no quoting", () => {
    let checked = 0;
    for (const testCase of cases) {
      if (testCase.argv.length === 0) continue;
      if (testCase.argv.some((token) => token === "" || /[\s"'\\]/.test(token))) continue;
      const line = testCase.argv.join(" ");
      expect(splitKiroCommandArgs(line), `${where(testCase)} line=${JSON.stringify(line)}`).toEqual(testCase.argv);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("the engine routes a seeded slice of those lines", () => {
  /** Shapes whose routing this change owns; the rest are parser-only here. */
  const routable = cases.filter((testCase) =>
    ["words-only", "untaken-answer", "untaken-misspelt", "untaken-unknown", "untaken-equals", "after-delimiter", "ceremony-flag", "fence-flag"]
      .includes(testCase.shape));
  const slice = Array.from({ length: Math.min(ROUTED, routable.length) }, (_unused, index) =>
    routable[Math.floor((index * routable.length) / Math.min(ROUTED, routable.length))]);

  function env(proj: string): NodeJS.ProcessEnv {
    return {
      ...testGuardEnvironment(process.env, "production"),
      CLAUDE_PROJECT_DIR: proj,
      AIDLC_PROJECT_DIR: proj,
      AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: SESSION,
    };
  }

  function openWork(): string {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    writeFileSync(seededStateFile(proj),
      readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8"), "utf-8");
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    return proj;
  }

  const questionDir = (proj: string) => join(proj, "aidlc", ".aidlc-sessions", "questions");

  function questionIds(proj: string): string[] {
    const dir = questionDir(proj);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
  }

  function newQuestionTexts(proj: string, before: readonly string[]): string {
    return questionIds(proj)
      .filter((name) => !before.includes(name))
      .map((name) => readFileSync(join(questionDir(proj), name), "utf-8"))
      .join(" ");
  }

  test(`routes ${slice.length} of them: no crash, no audit record, and nothing reaches the person`, () => {
    const proj = openWork();
    const before = readAuditShardEvents(proj).length;
    for (const testCase of slice) {
      const note = where(testCase);
      // The project carries every earlier line of the slice, and a token after
      // `--` is their text, so only the questions this call adds are its own.
      const questionsBefore = questionIds(proj);
      const result = runOrchestrateNext(ORCHESTRATE, proj, testCase.argv, { env: env(proj) });
      // A line nobody wrote on purpose still returns one directive, never a stack.
      expect(result.out, note).not.toContain("error: Unhandled");
      expect(result.directive, `${note} out=${result.out.slice(0, 400)}`).not.toBeNull();
      const directive = result.directive as Record<string, unknown>;
      if (testCase.untaken !== undefined) {
        // The one agent-facing print: no spoken line, no question of any kind,
        // and the token never said to be the person's words.
        expect(directive.kind, `${note} directive=${JSON.stringify(directive).slice(0, 300)}`).toBe("print");
        expect(directive.narration, note).toBeUndefined();
        expect(directive.ask_type, note).toBeUndefined();
        expect(String(directive.message), note).toContain(testCase.untaken);
        expect(result.out, note).not.toContain("I could not read");
        // No question copy of this call's making says the person asked for it.
        expect(newQuestionTexts(proj, questionsBefore), note).not.toContain(testCase.untaken);
      }
      // `next` reads; it records nothing, whatever the line.
      expect(readAuditShardEvents(proj).length, note).toBe(before);
    }
  });
});

describe("a host's human-turn hook keeps the same reading of the line", () => {
  const hookable = cases.filter((testCase) =>
    testCase.argv.length > 0 && !testCase.argv.some((token) => token === "" || /[\s"'\\]/.test(token)));
  const slice = Array.from({ length: Math.min(HOOKED, hookable.length) }, (_unused, index) =>
    hookable[Math.floor((index * hookable.length) / Math.min(HOOKED, hookable.length))]);

  test(`records ${slice.length} typed lines with the words the parser read`, () => {
    for (const testCase of slice) {
      const note = where(testCase);
      const proj = createTestProject();
      created.push(proj);
      removeWorkspaceRecord(proj);
      const health = hooksHealthDir(proj);
      mkdirSync(health, { recursive: true });
      writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
      const prompt = `/aidlc ${testCase.argv.join(" ")}`;
      const fired = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
        cwd: proj,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
        env: {
          ...testGuardEnvironment(process.env, "production"),
          CLAUDE_PROJECT_DIR: proj,
          AIDLC_PROJECT_DIR: proj,
          AIDLC_UNATTENDED: "0",
          AIDLC_SESSION_OVERRIDE: SESSION,
        },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(fired.status, `${note} ${fired.stdout}${fired.stderr}`).toBe(0);
      const records = listMessages(proj);
      expect(records.length, note).toBe(1);
      // One parser: the record's words are exactly what `next` reads as the
      // request, so the proof kept for the person matches the engine's reading.
      // A line the parser refuses keeps their words whole instead, since the
      // record's job is to prove what they said (aidlc-message-store.ts).
      const parsed = parseNextFlags(testCase.argv);
      const expected = parsed.parseError === undefined
        ? parsed.intent?.trim() || null
        : testCase.argv.join(" ");
      expect(records[0].words, `${note} record=${JSON.stringify(records[0])}`).toBe(expected);
      // Either way the whole line is on record, as the host delivered it.
      expect(records[0].text, note).toBe(prompt);
      cleanupTestProject(created.pop());
    }
  });
});

afterAll(() => {
  process.stdout.write(`\nt-next-flags-fuzz: seed=${SEED} cases=${CASES} routed=${ROUTED} hooked=${HOOKED}\n`);
});

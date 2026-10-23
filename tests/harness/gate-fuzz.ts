// gate-fuzz.ts - the engine is a tool the agent uses: it must not read the person's words.
//
// The engine-level fuzz of the reading design (the design lead's section 4.2):
// at every point where the work waits on the person, a seeded run of 3 to 40
// steps (the person's turns through the host's own hook path, the agent's
// calls from the closed set for the open step, wrong calls, `next`, the gate
// shown again, a Stop probe, a second chat, a resume) is played against the
// real engine, and checked after every step and at the end:
//
//   I1 presence: no decision row without an unspent reply turn of the
//      person's since the last spending row, in this chat or the one chat
//      that spoke since; none at all when AIDLC_UNATTENDED is set.
//   I2 words whole: a decision row names the person's message (Message Id),
//      whose text is what they typed, and its Person Reply or Feedback is
//      that message's words.
//   I3 closed set: a choice outside the open step's set is refused and
//      changes nothing; a valid choice is recorded as handed.
//   I4 no reader: a valid call at the open step, with a live reply, lands.
//   I5 text-blind: the same run with each text replaced by another of the
//      same shape leaves the same rows, state, markers and messages, apart
//      from the fields that copy the words.
//   I6 no loop: a refusal's own step, taken, does not bring the same refusal
//      back; after the run, one reply and `next` give a step.
//   I7 one message, one lifecycle decision.
//   I8 Guard Policy: off and relaxed refuse no more than strict on the same
//      run.
//   I9 no words on screen: no engine output to the agent holds the person's
//      text, and none carries a `say` field.
//
// Plus, as the conductor asked: where a wait is on record and the person has
// not replied, the Stop hook lets the agent end its turn (where no wait is on
// record, what the hook does is data).
//
// States come from two places: the answers corpus's fixtures (one per
// question the engine knows, buildQuestion) and, in the long mode, a walk of
// every shipped scope that copies the project at every point the agent hands
// the turn to the person (the scope run's stand-in, scope-run.ts, on each
// tool's own hook wiring, scope-hosts.ts). gate-fuzz-run.ts is the long mode
// and replays a run by its id; tests/unit/t-gate-fuzz-<n>.test.ts (tests/harness/text-blind-fuzz.ts) is the suite's.

import { createHash } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cleanupTestProject, createOrchestrationTestProject, REPO_ROOT } from "./fixtures.ts";
import {
  activeRecord, AgentStandIn, clip, createScopeProject, type Directive, PersonScript, type RunResult, type ScopeHost,
  ScopeRunRefused, shellQuote, sourceStages, stopVerdict,
} from "./scope-run.ts";
import { createHostProject, type HostName, hostFor, NativeScopeHost, OpencodeScopeHost } from "./scope-hosts.ts";

export type HostId = "claude" | HostName;
export type Policy = "default" | "off" | "relaxed" | "strict";
export const HOST_IDS: readonly HostId[] = ["claude", "codex", "copilot", "kiro", "kiro-ide", "cursor", "opencode"];
export const POLICIES: readonly Exclude<Policy, "default">[] = ["strict", "relaxed", "off"];

type Lib = typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
type Store = typeof import("../../dist/claude/.claude/tools/aidlc-message-store.ts");
let libModule: Lib | undefined;
let storeModule: Store | undefined;
const lib = (): Lib => (libModule ??= require("../../dist/claude/.claude/tools/aidlc-lib.ts") as Lib);
const store = (): Store => (storeModule ??= require("../../dist/claude/.claude/tools/aidlc-message-store.ts") as Store);

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** mulberry32: a seeded generator, so a run is the same on every machine. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
export const hash32 = (text: string): number => createHash("sha256").update(text).digest().readUInt32BE(0);

// ---------------------------------------------------------------------------
// The person's words, by shape (section 4.2's classes)
// ---------------------------------------------------------------------------

export const SHAPES = [
  "digit", "label", "label-variant", "sentence", "sentence-digit", "typo", "language", "unicode", "shell", "crlf",
  "long", "blank", "command-words", "command-bare", "template", "engine-string",
] as const;
export type Shape = (typeof SHAPES)[number];

/** Shapes a reply never has: no words in it, or a command to the tool with none. */
export const NOT_A_REPLY: ReadonlySet<Shape> = new Set(["blank", "command-bare"]);

let harvested: { strings: string[]; templates: RegExp[] } | undefined;
/**
 * Every short string the engine's modules export (labels, choices, questions,
 * field names) and the host turn templates, so a person typing any of them is
 * tried without anyone writing the list.
 */
function engineExports(): { strings: string[]; templates: RegExp[] } {
  if (harvested) return harvested;
  const strings = new Set<string>();
  const templates: RegExp[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length <= 80 && !value.includes("\n") && /[A-Za-z0-9]/.test(value)) strings.add(value);
  };
  for (const file of ["aidlc-lib.ts", "aidlc-reply-reader.ts", "aidlc-log.ts", "aidlc-plan-approval-ask.ts", "aidlc-testing-posture.ts"]) {
    const mod = require(join(REPO_ROOT, "dist", "claude", ".claude", "tools", file)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value === "string") add(value);
      else if (Array.isArray(value)) {
        for (const entry of value) {
          add(entry);
          if (entry !== null && typeof entry === "object") {
            add((entry as { label?: unknown }).label);
            const pattern = (entry as { pattern?: unknown }).pattern;
            if (pattern instanceof RegExp) templates.push(pattern);
          }
        }
      }
    }
  }
  harvested = { strings: [...strings].sort(), templates };
  return harvested;
}

/** A string an anchored host template matches, its open parts filled from the seed; null when this reading cannot make one. */
function fromTemplate(pattern: RegExp, r: () => number): string | null {
  const text = pattern.source
    .replace(/^\^|\$$/g, "")
    .replace(/\\r\?\\n/g, "\n")
    .replace(/\[\\s\\S\]\*/g, () => pick(r, SENTENCES))
    .replace(/\[\^\\n\]\*/g, () => pick(r, ["nightly", "build", "review"]))
    .replace(/\\([.()[\]?*+/|{}$^-])/g, "$1");
  return pattern.test(text) ? text : null;
}

const SENTENCES = [
  "looks good", "go ahead", "yes", "no", "not yet", "ok", "sure, carry on", "approve it", "approved, thanks", "i approve",
  "lgtm", "ship it", "hmm, let me think", "what does this stage do?", "can you explain the second part?",
  "change the title to Orders", "approve but rename the handler", "please add a test for the empty case", "the first one",
  "neither", "both", "skip this", "go back to the requirements", "stop here for today", "let's continue tomorrow", "wait",
  "sorry, wrong window", "Approve. Also add logging", "actually no, request changes", "approve?", "maybe",
  "I'm comfortable approving as-is", "have it checked again", "nothing to add", "add a note: use postgres", "looks correct",
  "use the classic plan", "just me", "keep asking", "review each checkpoint", "the api one", "where are we?",
  "what does approving commit me to?", "approve, and turn plan approval off", "approve and stop for today",
];
const WITH_DIGIT = (n: number): string[] => [
  `option ${n}`, `I pick ${n}`, `le ${n}`, `${n} please`, `go with ${n}`, `number ${n} looks right`, `${n}, but fix the typo`,
  `I said ${n}`, `${n} - and make it faster`, `#${n}`, `${n}.`, `(${n})`,
];
const LANGUAGES = [
  "Sieht gut aus, bitte weiter", "C'est bon pour moi", "Me parece bien, adelante", "Parece bom, pode seguir",
  "これで大丈夫です", "看起来不错，继续", "좋아요, 계속 진행하세요", "يبدو جيدا، تابع", "זה נראה טוב, תמשיך",
  "यह ठीक है, आगे बढ़ो", "Выглядит хорошо, продолжай", "Tamam, devam et", "Được rồi, tiếp tục", "ดูดีแล้ว ไปต่อได้",
  "Va bene, procedi", "Ziet er goed uit", "Wygląda dobrze", "Ναι, συνέχισε", "Approuver", "Aprobar", "承認", "批准",
];
const SHELL = [
  "$(touch pwned)", "`id`", "$HOME", "it's fine", 'say "yes"', "%PATH%", "a & b", "a | b", "<b>bold</b>", "a > b", "^caret",
  "wow!", "a; echo nothing", "back\\slash", "$" + "{IFS}", "'; DROP TABLE x; --", "\"double\" and 'single'",
];
const UNICODE_RANGES: Array<[number, number]> = [
  [0x1f600, 0x1f64f], [0x0300, 0x036f], [0x200b, 0x200f], [0x202a, 0x202e], [0x4e00, 0x4fff], [0x0600, 0x06ff],
  [0x10330, 0x1034a], [0xfe00, 0xfe0f], [0x00a0, 0x00ff], [0x1f1e6, 0x1f1ff],
];

function decorate(r: () => number, label: string, index: number): string {
  return pick(r, [
    label.toLowerCase(), label.toUpperCase(), `${label} (Recommended)`, `${label}.`, `${label}!`, `**${label}**`, `"${label}"`,
    `${index + 1}. ${label}`, `${index + 1}) ${label}`, ` ${label} `, `\`${label}\``, `${label}?`,
  ]);
}

function typo(r: () => number, text: string): string {
  if (text.length < 2) return `${text}${text}`;
  const at = Math.floor(r() * (text.length - 1));
  switch (Math.floor(r() * 4)) {
    case 0: return text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2);
    case 1: return text.slice(0, at) + text.slice(at + 1);
    case 2: return text.slice(0, at) + text[at] + text.slice(at);
    default: return `${text.slice(0, at)}x${text.slice(at + 1)}`;
  }
}

/**
 * The person's words of one shape, from a seed: the open step's own options,
 * every string the engine exports and the host templates among them. Two seeds
 * give two texts of the same shape, which is what the text-blind check swaps.
 */
export function textOf(shape: Shape, seed: number, options: readonly string[], kindSeed = seed): string {
  const r = rng(seed);
  const { strings, templates } = engineExports();
  const labels = options.length > 0 ? options : strings;
  switch (shape) {
    case "digit": return String(Math.floor(r() * 10));
    case "label": return pick(r, labels);
    case "label-variant": {
      const at = Math.floor(r() * labels.length);
      return decorate(r, labels[at], at);
    }
    case "sentence": return pick(r, SENTENCES);
    case "sentence-digit": return pick(r, WITH_DIGIT(1 + Math.floor(r() * 5)));
    case "typo": return typo(r, r() < 0.6 ? pick(r, labels) : pick(r, SENTENCES));
    case "language": return pick(r, LANGUAGES);
    case "unicode": {
      let text = "";
      const length = 1 + Math.floor(r() * 12);
      for (let i = 0; i < length; i++) {
        const [low, high] = pick(r, UNICODE_RANGES);
        text += String.fromCodePoint(low + Math.floor(r() * (high - low + 1)));
      }
      return r() < 0.5 ? `${pick(r, SENTENCES)} ${text}` : text;
    }
    case "shell": return pick(r, SHELL);
    case "crlf":
      return [pick(r, SENTENCES), pick(r, labels), pick(r, SENTENCES)].join(pick(r, ["\r\n", "\r\n\r\n"])) + pick(r, ["", "\r\n"]);
    case "long": {
      // Past the message store's 8000-character cap, so both texts of a pair are cut the same way.
      const length = 9000;
      let text = "";
      while (text.length < length) text += `${pick(r, SENTENCES)} `;
      return text.slice(0, length);
    }
    case "blank": return pick(r, ["", " ", "  \t ", "\n", "\r\n"]);
    case "command-words": return `/aidlc ${pick(r, [...SENTENCES, ...labels, String(Math.floor(r() * 4))])}`;
    case "command-bare": return pick(r, ["/aidlc", "/aidlc ", " /aidlc"]);
    case "template": {
      // Which host's template comes from `kindSeed`, so the two texts of a pair are the same template, filled apart.
      const order = templates.map((_, i) => i).sort((a, b) => rng(kindSeed + a)() - rng(kindSeed + b)());
      for (const at of order) {
        const text = fromTemplate(templates[at], r);
        if (text !== null) return text;
      }
      return "<task-notification>\nthe task finished\n</task-notification>";
    }
    case "engine-string": return pick(r, strings);
  }
}

/** The texts a neutral run uses: no reader can take them for anything. */
export const NEUTRAL = ["zebra quartz sentinel words one", "yak marble sentinel phrase number two, a little longer"] as const;

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/** Copy a project, leaving out `skip` (top-level names) and linking git's objects, which git never rewrites in place. */
function copyTree(src: string, dst: string, skip: ReadonlySet<string>, linkObjects: boolean, rel = ""): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const here = rel ? `${rel}/${name}` : name;
    if (rel === "" && skip.has(name)) continue;
    const from = join(src, name);
    const to = join(dst, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (stat.isDirectory()) copyTree(from, to, skip, linkObjects, here);
    else if (linkObjects && here.startsWith(".git/objects/")) linkSync(from, to);
    else {
      copyFileSync(from, to);
      // The engine binds some evidence to a file's modification time (the strict Reverse Engineering handoff): a copy keeps it.
      utimesSync(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    }
  }
}

/** Copy the files under `src` that are new or differ from `base` into `dst`. */
function copyChanged(src: string, base: string, dst: string): void {
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const was = join(base, name);
    const stat = lstatSync(from);
    if (stat.isDirectory()) copyChanged(from, was, join(dst, name));
    else if (stat.isFile() && (!existsSync(was) || !readFileSync(was).equals(readFileSync(from)))) {
      mkdirSync(dst, { recursive: true });
      copyFileSync(from, join(dst, name));
    }
  }
}


/** The folders a tool's install lays down in a project (its tree, not the method files or the person's own). */
export function installDirs(host: HostId): string[] {
  const tree = join(REPO_ROOT, "dist", host);
  return readdirSync(tree).filter((name) => name !== "aidlc" && lstatSync(join(tree, name)).isDirectory());
}

// ---------------------------------------------------------------------------
// States: where the work waits on the person
// ---------------------------------------------------------------------------

/** One recorded step of the agent's: a command, a file write or removal, a helper's work. */
export type Op =
  | { kind: "bash"; line: string }
  | { kind: "write"; rel: string; content: string }
  | { kind: "remove"; rel: string }
  | { kind: "task"; agent: string; prompt: string; inner: Op[] };

/** What kind of open step a state holds: it decides the agent's closed set. */
export type Kind = "gate" | "question" | "learnings" | "summary" | "plan" | "checkpoint" | "batch" | "protected" | "recovery" |
  "ask" | "resume" | "reuse" | "walked";

export interface State {
  id: string;
  kind: Kind;
  /** The answers corpus question or the walk's name for what it asked. */
  question: string;
  host: HostId;
  policy: Policy;
  unattended: boolean;
  /** The copy to start from, and the install trees laid over it. */
  dir: string;
  install: { from: string; dirs: string[] };
  session: string;
  stage: string;
  unit: string | null;
  /** What the person was asked, and its options as shown. */
  prompt: string;
  options: string[];
  revision: number;
  plan: { done: string[]; later: string[]; skipped: string[] };
  reviewer: string | null;
  /** The agent's own calls after the person answered, in a walk. */
  after: Op[];
  /** The call that showed the step, to show it again. */
  reshow: string | null;
  /** Extra arguments the step's commands carry (a checkpoint's Unit and kind, a question's command file). */
  args: string[];
  /** The engine's own question's choices, each with its command, when the engine handed them before the copy. */
  choices: Array<{ label: string; command: string }>;
}

const STATE_LINE = /^- \[(.)\] ([a-z0-9-]+) \u2014 (EXECUTE|SKIP)/;
const INITIALIZATION = new Set(sourceStages().filter((s) => s.phase === "initialization").map((s) => s.slug));
const REVIEWERS = new Map(sourceStages().map((s) => [s.slug, s.reviewer]));

function planOf(proj: string, stage: string): State["plan"] {
  const plan: State["plan"] = { done: [], later: [], skipped: [] };
  let state = "";
  try {
    state = readFileSync(activeRecord(proj).state, "utf-8");
  } catch {
    return plan;
  }
  let passed = false;
  for (const line of state.split(/\r?\n/)) {
    const m = STATE_LINE.exec(line);
    if (!m) continue;
    const [, mark, slug, kind] = m;
    if (slug === stage) {
      passed = true;
      continue;
    }
    if (INITIALIZATION.has(slug)) continue;
    if (kind === "SKIP") {
      if (passed) plan.skipped.push(slug);
    } else if (!passed && mark === "x") plan.done.push(slug);
    else if (passed && mark === " ") plan.later.push(slug);
  }
  return plan;
}

function revisionCount(proj: string): number {
  try {
    const value = lib().getField(readFileSync(activeRecord(proj).state, "utf-8"), "Revision Count");
    return value ? Number.parseInt(value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Set a fixture's Guard Policy the way a setting the person typed sets it (test setup, before anyone acts): the
 * engine's own line, and the step the template left open (the code plan's question) kept open over the write, as
 * `writeSettings` keeps it. The marker is bound to the state's digest, which binds the line's value and source, so a
 * line rewritten by hand left the question stale and the person's reply to it unkept. A line that already holds the
 * policy stays as it is, its source label with it.
 */
function setPolicy(proj: string, policy: Policy): boolean {
  if (policy === "default") return true;
  let file: string;
  try {
    file = activeRecord(proj).state;
  } catch {
    return false;
  }
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf-8");
  const field = lib().guardPolicyStateField(text);
  if (field && lib().parseGuardPolicyStateLine(lib().getField(text, field))?.value === policy) return true;
  const written = lib().setGuardPolicyLine(text, lib().formatGuardPolicy(policy, "you"));
  writeFileSync(file, written, "utf-8");
  lib().keepActiveDirectiveOverSettingWrite(proj, text, written);
  return true;
}

// --- fixtures: one per question the engine knows (the answers corpus's buildQuestion) ---

type Corpus = typeof import("./aidlc-answers-corpus.ts");
type Inputs = typeof import("./aidlc-input-corpus.ts");
const corpus = (): Corpus => require("./aidlc-answers-corpus.ts") as Corpus;
const inputs = (): Inputs => require("./aidlc-input-corpus.ts") as Inputs;

const RA = "requirements-analysis";
const QFILE = `inception/${RA}/${RA}-questions.md`;
/** The corpus's questions, with the open step's kind, stage and options as the fixture leaves them. */
export const FIXTURES: Record<string, { kind: Kind; stage: string; options: string[]; prompt: string; unit?: string; args?: string[]; revision?: number }> = {
  "stage-gate": { kind: "gate", stage: RA, options: ["Approve", "Request Changes"], prompt: "Requirements Analysis is ready for your review." },
  "stage-gate-accept-as-is": { kind: "gate", stage: RA, options: ["Approve", "Request Changes", "Accept as-is"], prompt: "Requirements Analysis is ready for your review.", revision: 3 },
  "stage-gate-sensor-failure": { kind: "question", stage: RA, options: ["Fix findings", "Override blocking sensors"], prompt: "Blocking gate sensor failure" },
  "code-plan": { kind: "plan", stage: "code-generation", options: ["Approve Plan", "Request Changes", "I'll edit the files"], prompt: "Approve the code plan?" },
  "code-plan-grouped": { kind: "plan", stage: "code-generation", options: ["Approve Plan", "Request Changes", "I'll edit the files"], prompt: "Approve the code plans?" },
  "unit-checkpoint": { kind: "checkpoint", stage: "code-generation", unit: "alpha", options: ["Approve", "Request Changes"], prompt: "Approve this completed alpha?", args: ["--unit", "alpha", "--kind", "unit"] },
  "batch-checkpoint": { kind: "batch", stage: "code-generation", options: ["Approve", "Request Changes"], prompt: "Approve this batch?", args: ["--batch", "1", "--units", "alpha,beta"] },
  "verification-command": { kind: "protected", stage: "functional-design", options: ["Approve", "Request Changes"], prompt: "Use this command to verify each completed Unit?", args: ["--checkpoint", "verification-command", "--command-file", "verification-command.txt"] },
  "construction-policy": { kind: "protected", stage: "functional-design", options: ["Approve", "Request Changes"], prompt: "Switch Construction to build the Units in parallel (swarm)?", args: ["--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm"] },
  "summary-confirmation": { kind: "summary", stage: RA, options: ["Looks correct", "Request changes"], prompt: "Does this all look correct?" },
  "stage-question": { kind: "question", stage: RA, options: ["PostgreSQL", "SQLite", "Other"], prompt: "Which database should the to-do app use?" },
  "answer-mode": { kind: "question", stage: RA, options: ["Guide me", "I'll edit the file", "Chat"], prompt: "How would you like to answer the questions?" },
  learnings: { kind: "question", stage: RA, options: ["Nothing to add", "Add a note"], prompt: "Anything to add for next time?" },
  "reopened-stage": { kind: "reuse", stage: RA, options: ["Keep", "Modify", "Redo from scratch"], prompt: "Keep it, modify it, or redo it from scratch?" },
  "guard-recovery": { kind: "recovery", stage: RA, options: ["finish-revision", "request-changes"], prompt: "How should I go on?" },
  "resume-reentry": { kind: "resume", stage: RA, options: ["redo", "jump", "fresh"], prompt: "Pick up where you left off?" },
  "jump-target": { kind: "resume", stage: RA, options: ["redo", "jump", "fresh"], prompt: "Which stage?" },
  routing: { kind: "ask", stage: RA, options: [], prompt: "" },
  "plan-offer": { kind: "ask", stage: "", options: [], prompt: "" },
  "scope-confirm": { kind: "ask", stage: "", options: [], prompt: "" },
  "intent-pick": { kind: "ask", stage: "", options: [], prompt: "" },
  "project-type": { kind: "ask", stage: "", options: [], prompt: "" },
  "unit-paused": { kind: "ask", stage: "functional-design", options: [], prompt: "" },
};
const FIXTURE_SESSION = "01995000-7a11-7000-8000-00000000d001";

const built = new Map<string, Promise<string>>();
const fixtureDirs: string[] = [];
const askChoices = new Map<string, Array<{ label: string; command: string }>>();
type Asked = { directive: (Directive & { choices?: Array<{ label?: string; command?: string }> }) | null; out: string };
const choicesOf = (asked: Asked) => (asked.directive?.choices ?? [])
  .filter((c): c is { label: string; command: string } => typeof c.label === "string" && typeof c.command === "string");

/**
 * The questions a bare `next` does not show again (the routing question and the plan offer answer a typed line), built
 * as the corpus builds them, keeping the choices the engine handed with them.
 */
async function buildAsk(proj: string, question: string): Promise<void> {
  const { say, next } = inputs();
  if (question === "routing") {
    const { seededStateFile, FIXTURES_DIR } = require("./fixtures.ts") as typeof import("./fixtures.ts");
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
    await say(proj, "/aidlc fix the login", "claude");
    const reading = await next(proj, ["fix", "the", "login"]);
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(reading.directive?.message ?? "")?.[1];
    if (!request) throw new Error(`no request id in the reading note: ${reading.out}`);
    const routing = await next(proj, [...request.split(" "), "--propose", "bugfix"]) as Asked;
    if (routing.directive?.ask_type !== "new-work-routing") throw new Error(`routing question did not open: ${routing.out}`);
    askChoices.set(question, choicesOf(routing));
    return;
  }
  const { proposalFollowUp } = require("./fixtures.ts") as typeof import("./fixtures.ts");
  const line = question === "plan-offer" ? "/aidlc fix the login: it rejects a correct password" : "/aidlc fix the login timeout";
  await say(proj, line, "claude");
  const read = await next(proj, line.replace(/^\/aidlc\s*/, "").split(" "));
  const proposal = proposalFollowUp(read.directive, "bugfix");
  const offer = (proposal === null ? read : await next(proj, proposal)) as Asked;
  if (offer.directive?.ask_type !== "scope-confirm") throw new Error(`the plan offer did not open: ${offer.out}`);
  askChoices.set(question, choicesOf(offer));
}

/** The corpus's fixture for `question`, built once per process. */
async function fixtureTemplate(question: string): Promise<string> {
  if (!built.has(question)) {
    built.set(question, (async () => {
      const proj = createOrchestrationTestProject();
      fixtureDirs.push(proj);
      if (["routing", "plan-offer", "scope-confirm"].includes(question)) await buildAsk(proj, question);
      else await corpus().buildQuestion(proj, question as Parameters<Corpus["buildQuestion"]>[1]);
      return proj;
    })());
  }
  return built.get(question)!;
}
export function cleanupFixtures(): void {
  while (fixtureDirs.length > 0) cleanupTestProject(fixtureDirs.pop());
  built.clear();
}

/** A fixture state: the corpus's project for that question, under a Guard Policy, played on a host. */
export async function fixtureState(question: string, host: HostId, policy: Policy, unattended = false): Promise<State> {
  const meta = FIXTURES[question];
  if (!meta) throw new Error(`no fixture for ${question}`);
  const template = await fixtureTemplate(question);
  // A question asked before any work exists has no Guard Policy to set: it runs as the defaults leave it.
  const settable = (() => {
    try {
      return existsSync(activeRecord(template).state);
    } catch {
      return false;
    }
  })();
  const effective: Policy = settable ? policy : "default";
  const dir = join(statesRoot(), `fx-${question}-${host}-${effective}${unattended ? "-unattended" : ""}`);
  if (!existsSync(dir)) {
    copyTree(template, dir, new Set(), false);
    setPolicy(dir, effective);
  }
  return {
    id: `fx:${question}:${host}:${effective}${unattended ? ":unattended" : ""}`,
    kind: meta.kind, question, host, policy: effective, unattended, dir,
    install: { from: join(REPO_ROOT, "dist", host), dirs: installDirs(host) },
    session: FIXTURE_SESSION, stage: meta.stage, unit: meta.unit ?? null, prompt: meta.prompt, options: meta.options,
    revision: meta.revision ?? 0, plan: meta.stage ? planOf(dir, meta.stage) : { done: [], later: [], skipped: [] },
    reviewer: REVIEWERS.get(meta.stage) ?? null, after: [], reshow: meta.kind === "gate" ? `orchestrate report --stage ${meta.stage} --result awaiting-approval` : null,
    args: meta.args ?? [], choices: askChoices.get(question) ?? [],
  };
}

let statesDir: string | null = null;
function statesRoot(): string {
  statesDir ??= mkdtempSync(join(process.env.AIDLC_GATE_FUZZ_SCRATCH ?? tmpdir(), "gate-fuzz-states-"));
  return statesDir;
}
export function cleanupStates(): void {
  if (statesDir !== null) cleanupTestProject(statesDir);
  statesDir = null;
  cleanupFixtures();
}

// --- walks: every point a shipped scope waits on the person ---

export interface WalkSpec {
  scope: string;
  host: HostId;
  policy: Policy;
  units: string[];
  summary?: boolean;
  /** A stage asked for changes three times before its approval, so Accept as-is is on offer. */
  revise?: string;
  skip?: string[];
  /**
   * Walk on an older release's trees (its `dist` folder): each wait is then answered with this repository's trees laid
   * in, as when the person updates AI-DLC between the question and their reply.
   */
  from?: string;
}

export interface Walk {
  id: string;
  spec: WalkSpec;
  dir: string;
  install: string;
  dirs: string[];
  states: State[];
  ms: number;
  stuck: string | null;
  gatesMet: string[];
}

export function walkId(spec: WalkSpec): string {
  return [spec.host, spec.scope, spec.policy, `${spec.units.length}u`, spec.summary ? "sc" : "", spec.revise ? `rev-${spec.revise}` : "",
    spec.skip?.length ? "skips" : "", spec.from ? `from-${releaseOf(spec.from)}` : ""].filter(Boolean).join("-");
}

/** The release an older `dist` folder was built from. */
function releaseOf(dist: string): string {
  const version = /AIDLC_VERSION = "([^"]+)"/.exec(readFileSync(join(dist, "claude", ".claude", "tools", "aidlc-version.ts"), "utf-8"));
  return version?.[1] ?? "older";
}

/** A project with an older release's tree installed as it ships, in a git repository with one commit. */
function olderProject(dist: string, name: HostId, shape: "code" | "empty"): { proj: string; host: ScopeHost } {
  const proj = join(mkdtempSync(join(process.env.AIDLC_GATE_FUZZ_SCRATCH ?? tmpdir(), "gate-fuzz-older-")), "proj");
  cpSync(join(dist, name), proj, { recursive: true });
  if (shape === "code") cpSync(join(REPO_ROOT, "tests", "fixtures", "brownfield-todo"), proj, { recursive: true });
  const host = hostFor(name, proj);
  host.git("init", "-q", "-b", "main");
  host.git("add", "-A");
  host.git("commit", "-q", "-m", "Before AI-DLC");
  return { proj, host };
}

const ASKING = /\borchestrate report\b.*--result (?:awaiting-approval|revised)\b|\blog decision\b|\bbolt checkpoint\b.*--action ask\b/;

/** What the walk's stand-in names a question, as the kind of open step. */
function kindOf(what: string): Kind {
  if (what === "approval") return "gate";
  if (what === "question" || what === "question mode") return "question";
  if (what === "learnings") return "learnings";
  return "walked";
}

/** Wraps a host's calls so the walk sees every step the agent takes and copies the project where it asks. */
class Recorder {
  readonly states: State[] = [];
  private shown: string | null = null;
  private capture: State | null = null;
  private depth: Op[][] = [];
  private n = 0;

  constructor(readonly host: ScopeHost, readonly walkName: string, readonly dir: string, readonly spec: WalkSpec,
    readonly install: string, readonly dirs: string[]) {
    const bash = host.bash.bind(host);
    const write = host.write.bind(host);
    const remove = host.remove.bind(host);
    const task = host.task.bind(host);
    host.bash = (line: string): RunResult => {
      if (ASKING.test(line)) this.shown = line;
      const capture = this.capture;
      this.note({ kind: "bash", line });
      const res = bash(line);
      if (capture !== null && this.depth.length === 0) this.capture = null;
      return res;
    };
    host.write = (rel: string, content: string) => {
      this.note({ kind: "write", rel, content });
      write(rel, content);
    };
    host.remove = (rel: string) => {
      this.note({ kind: "remove", rel });
      remove(rel);
    };
    host.task = (agent: string, prompt: string, work: () => void) => {
      const inner: Op[] = [];
      this.note({ kind: "task", agent, prompt, inner });
      this.depth.push(inner);
      try {
        task(agent, prompt, work);
      } finally {
        this.depth.pop();
      }
    };
  }

  private note(op: Op): void {
    const inner = this.depth.at(-1);
    if (inner) inner.push(op);
    else if (this.capture) this.capture.after.push(op);
  }

  asked(what: string, stage: string, prompt: string, options: string[], unit: string | null): State {
    this.capture = null;
    const n = ++this.n;
    const dir = join(this.dir, "states", String(n));
    copyTree(this.host.proj, dir, new Set(this.dirs), true);
    // A tool that writes into its own tree as it runs (Kiro IDE does): the files that differ from the install are kept.
    for (const name of this.dirs) copyChanged(join(this.host.proj, name), join(this.install, name), join(dir, name));
    const state: State = {
      id: `${this.walkName}#${n}`, kind: kindOf(what), question: what, host: this.spec.host, policy: this.spec.policy,
      unattended: false, dir, install: { from: this.install, dirs: this.dirs }, session: this.host.session, stage, unit,
      prompt, options, revision: revisionCount(this.host.proj), plan: planOf(this.host.proj, stage),
      reviewer: REVIEWERS.get(stage) ?? null, after: [], reshow: this.shown, args: [], choices: [],
    };
    this.shown = null;
    this.states.push(state);
    return state;
  }

  answered(state: State): void {
    this.capture = state;
  }
}

class WalkStandIn extends AgentStandIn {
  recorder: Recorder | null = null;
  revise: string | null = null;
  private revised = 0;

  override askPerson(what: string, stage: string, question: string, options: string[], words: string): string {
    const unit = (this as unknown as { unitInHand: string | null }).unitInHand;
    const state = this.recorder?.asked(what, stage, question, options, unit);
    const changes = what === "approval" && stage === this.revise && this.revised < 3;
    const choice = super.askPerson(what, stage, question, options, changes ? `Request changes: tighten the wording (${this.revised + 1})` : words);
    if (state) this.recorder?.answered(state);
    return changes ? "Request Changes" : choice;
  }

  override gate(d: Directive): void {
    const stage = String(d.stage);
    if (stage !== this.revise || this.revised >= 3 || d.gate !== true) {
      super.gate(d);
      return;
    }
    // The person asks for changes three times; the fourth showing offers Accept as-is.
    const revising = new RegExp(`^- \\[R\\] ${stage} `, "m").test(readFileSync(activeRecord(this.host.proj).state, "utf-8"));
    if (d.gate_only !== true) this.report(stage, "--result", revising ? "revised" : "awaiting-approval");
    this.askPerson("approval", stage, `${stage} is ready for your review. How would you like to proceed?`, ["Approve", "Request Changes"], "");
    this.report(stage, "--result", "rejected", "--user-input", "Request Changes");
    this.revised++;
    for (const p of (d.produces as string[] | undefined) ?? []) {
      const path = join(this.host.proj, p);
      if (existsSync(path) && p.endsWith(".md") && !p.endsWith("-questions.md")) {
        this.host.write(p, `${readFileSync(path, "utf-8")}\n\nRevision ${this.revised}: tightened the wording.\n`);
      }
    }
    // The revised work is reviewed again; after a rejection the engine counts the passes from one again.
    if (typeof d.reviewer === "string") this.review(d);
    this.gate({ ...d, gate_only: false });
  }
}

/** Walk a scope to done on a host, keeping every point the agent handed the turn to the person. */
export function walk(spec: WalkSpec, root: string): Walk {
  const id = walkId(spec);
  const dir = join(root, id);
  mkdirSync(join(dir, "states"), { recursive: true });
  const shape = spec.scope === "workshop" || spec.scope === "express" ? "empty" : "code";
  const { proj, host } = spec.from ? olderProject(spec.from, spec.host, shape)
    : spec.host === "claude" ? createScopeProject(shape) : createHostProject(spec.host, shape);
  const dirs = installDirs(spec.host).filter((name) => existsSync(join(proj, name)));
  const install = join(dir, "install");
  for (const name of dirs) cpSync(join(proj, name), join(install, name), { recursive: true });
  const recorder = new Recorder(host, id, dir, spec, install, dirs);
  const agent = new WalkStandIn(host, new PersonScript(host), { units: spec.units });
  agent.recorder = recorder;
  agent.revise = spec.revise ?? null;
  const flags = [
    "--scope", spec.scope,
    ...(spec.policy === "default" ? [] : ["--guard-policy", spec.policy]),
    ...(spec.summary ? ["--summary-confirmation", "on"] : []),
    ...(spec.skip?.length ? ["--skip", spec.skip.join(",")] : []),
  ];
  const started = Date.now();
  let stuck: string | null = null;
  try {
    agent.drive(agent.begin(`build the ${spec.scope} work`, flags));
  } catch (error) {
    stuck = error instanceof Error ? clip(error.message, 2000) : String(error);
  }
  if (host instanceof OpencodeScopeHost) host.dispose();
  const gatesMet = [...new Set(recorder.states.filter((s) => s.kind === "gate").map((s) => s.stage))];
  // The person updated AI-DLC while the question waited: their reply meets this repository's trees.
  if (spec.from) for (const state of recorder.states) state.install = { from: join(REPO_ROOT, "dist", spec.host), dirs };
  const result: Walk = { id, spec, dir, install, dirs, states: recorder.states, ms: Date.now() - started, stuck, gatesMet };
  writeFileSync(join(dir, "walk.json"), JSON.stringify(result, null, 2));
  cleanupTestProject(proj);
  return result;
}

export function loadWalk(dir: string): Walk {
  return JSON.parse(readFileSync(join(dir, "walk.json"), "utf-8")) as Walk;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type Channel = "typed" | "box-pick" | "box-free" | "box-dismissed";
/** Which message an agent call names with --message. */
export type MessageRef = "latest" | "older" | "spent" | "other-chat" | "bogus";

export type Step =
  | { kind: "person"; channel: Channel; shape: Shape; seed: number }
  | { kind: "call"; choice: number; message: MessageRef | null; reason: boolean; endsTurn: boolean }
  | { kind: "wrong"; variant: number }
  | { kind: "next" }
  | { kind: "reshow" }
  | { kind: "stop" }
  | { kind: "chat" }
  | { kind: "back" }
  | { kind: "resume" };

/** The channels a host has: a question box on Claude Code and Codex, typed lines everywhere. */
export function channelsOf(host: HostId): Channel[] {
  if (host === "claude") return ["typed", "typed", "box-pick", "box-free", "box-dismissed"];
  if (host === "codex") return ["typed", "typed", "box-pick", "box-free"];
  return ["typed"];
}

/** A seeded run of 3 to `most` steps for a state. */
export function stepsFor(state: State, seed: number, most = 40): Step[] {
  const r = rng(seed);
  const length = 3 + Math.floor(r() * (most - 2));
  const steps: Step[] = [];
  const person = (): Step => ({
    kind: "person", channel: pick(r, channelsOf(state.host)), shape: pick(r, SHAPES), seed: Math.floor(r() * 2 ** 31),
  });
  const call = (): Step => ({
    kind: "call", choice: Math.floor(r() * 1000), endsTurn: r() < 0.15, reason: r() < 0.3,
    message: r() < 0.6 ? null : pick(r, ["latest", "latest", "older", "spent", "other-chat", "bogus"] as const),
  });
  // Most runs open with the person's reply, as most waits end.
  if (r() < 0.75) steps.push(person());
  while (steps.length < length) {
    const roll = r();
    if (roll < 0.34) steps.push(person());
    else if (roll < 0.66) steps.push(call());
    else if (roll < 0.74) steps.push({ kind: "wrong", variant: Math.floor(r() * 1000) });
    else if (roll < 0.82) steps.push({ kind: "next" });
    else if (roll < 0.86) steps.push({ kind: "reshow" });
    else if (roll < 0.92) steps.push({ kind: "stop" });
    else if (roll < 0.95) steps.push({ kind: "chat" });
    else if (roll < 0.97) steps.push({ kind: "back" });
    else steps.push({ kind: "resume" });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// The closed set for an open step
// ---------------------------------------------------------------------------

export interface Call {
  /** A short name for the report. */
  name: string;
  ops: Op[];
  /** One of the engine's actions for the open step. */
  valid: boolean;
  /** The choice the call hands, and the row field that should carry it. */
  choice: string | null;
  /** Whether the call is a lifecycle decision (it spends the reply) rather than an answer. */
  lifecycle: boolean;
}

/** A command the engine named on Claude Code's tree (a fixture built there), as this host's tree names it. */
function onTree(host: ScopeHost, command: string): string {
  return host.dir === ".claude" ? command : command.replace(/(^|\s)\.claude\/tools\//g, `$1${host.dir}/tools/`);
}

function engineLine(host: ScopeHost, ...args: string[]): string {
  const head = host.launcher === null ? ["bun", `${host.dir}/tools/aidlc.ts`] : ["aidlc"];
  return [...head, "engine", ...args].map(shellQuote).join(" ");
}
const bashOp = (line: string): Op => ({ kind: "bash", line });
const SHELL_REASON = "they said: keep $HOME, `id` and \"quotes\" | as typed; 50% & more";

/** The agent's calls from the closed set at this state, each built for the run's chat. */
export function closedSet(state: State, host: ScopeHost, ctx: { choices: Array<{ label: string; command: string }>; proj: string }): Call[] {
  const e = (...args: string[]) => bashOp(engineLine(host, ...args));
  const unit = state.unit ? ["--unit", state.unit] : [];
  const calls: Call[] = [];
  const answer = (details: string, valid = true): Call => ({
    name: `answer ${details}`, valid, choice: details, lifecycle: false,
    ops: [e("log", "answer", "--stage", state.stage, "--details", details, ...unit)],
  });
  switch (state.kind) {
    case "gate":
    case "learnings": {
      if (state.kind === "learnings") {
        for (const option of state.options) calls.push(answer(option));
        calls.push({ name: "show the gate", valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "report", "--stage", state.stage, "--result", "awaiting-approval")] });
      }
      const report = (...args: string[]) => e("orchestrate", "report", "--stage", state.stage, ...args);
      calls.push({ name: "approve", valid: true, choice: "Approve", lifecycle: true, ops: [report("--result", "approved", "--user-input", "Approve")] });
      calls.push({ name: "approve and park", valid: true, choice: "Approve", lifecycle: true, ops: [report("--result", "approved", "--user-input", "Approve", "--park")] });
      // --user-input lands as the agent passed it, at any revision (section 4.2, I3): "Accept as-is" is an approval in the agent's words.
      calls.push({ name: "accept as-is", valid: true, choice: "Accept as-is", lifecycle: true, ops: [report("--result", "approved", "--user-input", "Accept as-is")] });
      calls.push({ name: "request changes", valid: true, choice: "Request Changes", lifecycle: true, ops: [report("--result", "rejected", "--user-input", "Request Changes")] });
      calls.push({ name: "request changes with a reason", valid: true, choice: "Request Changes", lifecycle: true, ops: [report("--result", "rejected", "--user-input", "Request Changes", "--reason", SHELL_REASON)] });
      if (state.plan.skipped.length > 0) calls.push({ name: `add ${state.plan.skipped[0]}`, valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "next", "--add", state.plan.skipped[0])] });
      if (state.plan.later.length > 0) calls.push({ name: `skip ${state.plan.later.at(-1)}`, valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "next", "--skip", state.plan.later.at(-1)!)] });
      if (state.plan.done.length > 0) calls.push({ name: `jump to ${state.plan.done.at(-1)}`, valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "report", "--result", "resumed", "--choice", "jump", "--target", state.plan.done.at(-1)!)] });
      calls.push({ name: "park", valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "park", "--person-asked")] });
      if (walkedDecides(state)) calls.push({ name: "as walked", valid: true, choice: null, lifecycle: state.kind === "gate", ops: state.after });
      // Practices Discovery promotes its drafts before the approval (the ordered exception): its approval is the walk's own.
      if (state.stage === "practices-discovery") {
        const own = calls.filter((c) => !c.name.startsWith("approve") || c.name === "as walked");
        calls.splice(0, calls.length, ...own);
      }
      break;
    }
    case "question":
      for (const option of state.options) calls.push(answer(option));
      break;
    case "summary": {
      const file = join(activeRecord(ctx.proj).dir.slice(ctx.proj.length + 1), QFILE);
      for (const details of ["Looks correct", "Request changes: say what a blank title shows"]) {
        const path = join(ctx.proj, file);
        const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
        calls.push({
          name: `summary ${details.split(":")[0]}`, valid: true, choice: details.split(":")[0], lifecycle: false,
          ops: [
            { kind: "write", rel: file, content: text.replace(/\[Answer\]: ?\n?$/, `[Answer]: ${details.split(":")[0]}\n`) },
            e("log", "answer", "--checkpoint", "summary-confirmation", "--stage", state.stage, "--questions-file", file, "--details", details),
          ],
        });
      }
      break;
    }
    case "plan":
      for (const choice of ctx.choices) {
        calls.push({ name: `plan ${choice.label}`, valid: true, choice: choice.label, lifecycle: /^Approve/.test(choice.label), ops: [bashOp(onTree(host, choice.command))] });
      }
      break;
    case "checkpoint":
      for (const [action, input] of [["approve", "Approve"], ["reject", "Request Changes"]] as const) {
        calls.push({ name: `checkpoint ${action}`, valid: true, choice: input, lifecycle: true, ops: [e("bolt", "checkpoint", ...state.args, "--action", action, "--session", host.session, "--user-input", input)] });
      }
      break;
    case "batch":
      for (const [action, input] of [["approve", "Approve"], ["reject", "Request Changes"]] as const) {
        calls.push({ name: `batch ${action}`, valid: true, choice: input, lifecycle: true, ops: [e("bolt", "swarm-checkpoint", ...state.args, "--action", action, "--session", host.session, "--user-input", input)] });
      }
      break;
    case "protected":
      for (const details of ["Approve", "Request Changes"]) {
        calls.push({ name: `${state.args[1]} ${details}`, valid: true, choice: details, lifecycle: details === "Approve", ops: [e("log", "answer", "--stage", state.stage, ...state.args, "--session", host.session, "--details", details)] });
      }
      break;
    case "recovery":
      for (const op of state.options) calls.push({ name: `recovery ${op}`, valid: true, choice: op, lifecycle: false, ops: [e("log", "answer", "--stage", state.stage, "--checkpoint", "guard-recovery", "--details", op)] });
      break;
    case "resume":
      calls.push({ name: "redo", valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "report", "--result", "resumed", "--choice", "redo")] });
      calls.push({ name: "jump", valid: true, choice: null, lifecycle: false, ops: [e("orchestrate", "report", "--result", "resumed", "--choice", "jump", "--target", state.plan.done.at(-1) ?? state.stage)] });
      break;
    case "reuse":
      for (const decision of ["keep", "modify", "redo"]) {
        calls.push({ name: `reuse ${decision}`, valid: true, choice: decision, lifecycle: false, ops: [e("state", "reuse-artifact", state.stage, "--decision", decision, "--artifacts", "requirements.md")] });
      }
      break;
    case "ask":
      for (const choice of ctx.choices) calls.push({ name: `pick ${choice.label}`, valid: true, choice: choice.label, lifecycle: true, ops: [bashOp(onTree(host, choice.command))] });
      break;
    case "walked":
      if (walkedDecides(state)) calls.push({ name: "as walked", valid: true, choice: null, lifecycle: true, ops: state.after });
      break;
  }
  return calls;
}

// A walk that only ran `next` after the person's turn had its decision taken from their words by a hook: replaying
// it is the run's own `next` step, not a call of the agent's.
const walkedDecides = (state: State) =>
  state.after.some((op) => op.kind !== "bash" || !/ orchestrate next$/.test(op.line.trim()));

/** Calls the agent gets wrong or words its own way: a choice the step does not offer, a flag no command takes, a step that is not open, an approval in its own words. */
export function wrongCalls(state: State, host: ScopeHost): Call[] {
  const e = (...args: string[]) => bashOp(engineLine(host, ...args));
  const { strings } = engineExports();
  const label = strings[hash32(state.id) % strings.length];
  const calls: Call[] = [];
  if (state.kind === "gate" || state.kind === "learnings") {
    for (const input of ["approve", "Approve Plan", label, "Add User Stories"]) {
      // --user-input is the agent's own account of the approval, recorded as handed (section 4.2, I3).
      calls.push({ name: `approve as "${input}"`, valid: true, choice: input, lifecycle: true, ops: [e("orchestrate", "report", "--stage", state.stage, "--result", "approved", "--user-input", input)] });
    }
    const other = state.plan.later[0] ?? state.plan.done[0];
    if (other) calls.push({ name: `approve ${other}, not open`, valid: false, choice: "Approve", lifecycle: true, ops: [e("orchestrate", "report", "--stage", other, "--result", "approved", "--user-input", "Approve")] });
    calls.push({ name: "report with a flag no command takes", valid: false, choice: null, lifecycle: true, ops: [e("orchestrate", "report", "--stage", state.stage, "--result", "approved", "--user-input", "Approve", "--verdict", "yes")] });
  }
  if (state.kind === "plan") calls.push({ name: "plan answered as Approve", valid: false, choice: "Approve", lifecycle: true, ops: [e("log", "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve")] });
  if (state.kind === "checkpoint") calls.push({ name: "checkpoint action outside the set", valid: false, choice: null, lifecycle: true, ops: [e("bolt", "checkpoint", ...state.args, "--action", "maybe", "--session", host.session)] });
  if (state.kind === "recovery") calls.push({ name: "recovery op outside the set", valid: false, choice: "abort-everything", lifecycle: false, ops: [e("log", "answer", "--stage", state.stage, "--checkpoint", "guard-recovery", "--details", "abort-everything")] });
  if (state.kind === "protected") calls.push({ name: `${state.args[1]} answered "${label}"`, valid: false, choice: label, lifecycle: true, ops: [e("log", "answer", "--stage", state.stage, ...state.args, "--session", host.session, "--details", label)] });
  calls.push({ name: "answer with a flag no command takes", valid: false, choice: null, lifecycle: false, ops: [e("log", "answer", "--stage", state.stage || RA, "--details", "x", "--bogus", "1")] });
  return calls;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface OpResult {
  what: string;
  status: number;
  out: string;
}

export interface Row {
  index: number;
  event: string;
  fields: Array<[string, string]>;
}

/** A turn the run gave as the person, with where the record stood when it landed. */
export interface Turn {
  step: number;
  chat: string;
  channel: Channel;
  shape: Shape;
  text: string;
  /** Rows on record when the hook had run. */
  at: number;
  /** A reply by the design's rule: words in it, not a bare command, not a dismissed box. */
  reply: boolean;
}

export interface StepOutcome {
  i: number;
  step: Step;
  label: string;
  chat: string;
  ops: OpResult[];
  /** Rows the step added, from `from` on. */
  from: number;
  rows: Row[];
  call: Call | null;
  /** For a call: whether anything it asked for landed. */
  landed: boolean | null;
  /** The text the engine refused it with, when it refused. */
  refusal: string | null;
  stateBefore: string;
  stateAfter: string;
}

export interface Run {
  state: State;
  seed: number;
  /** Steps dropped from the seed's run (a shrunk run). */
  dropped: number[];
  twin: boolean;
  steps: StepOutcome[];
  turns: Turn[];
  rows: Row[];
  /** Rows the copy held before the run. */
  start: number;
  messages: Array<{ id: string; session: string | null; source: string; text: string; words: string | null; cut: boolean }>;
  /** The messages the copy held before the run (a walk's), which a row's window may reach back to. */
  earlier: Run["messages"];
  files: Record<string, string>;
  finalState: string;
  /** One reply and `next` after the run: the step it gave, or why it gave none. */
  liveness: { ok: boolean; out: string };
  /** The chats the run used, in the order they first spoke: a twin's host names its new chats differently. */
  chats: string[];
  proj: string;
  error: string | null;
}

/** Events that record a person's decision. */
export const DECIDING = new Set([
  "GATE_APPROVED", "GATE_REJECTED", "PLAN_APPROVAL_RECORDED", "QUESTION_ANSWERED", "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED", "CONSTRUCTION_POLICY_RECORDED", "REQUEST_ROUTED",
]);
/** The lifecycle decisions a reply backs once (the design's spending rows); an answer to a question never spends. */
export const SPENDING = new Set([
  "GATE_APPROVED", "GATE_REJECTED", "PLAN_APPROVAL_RECORDED", "VERIFICATION_COMMAND_RECORDED", "CONSTRUCTION_POLICY_RECORDED",
  "REQUEST_ROUTED", "QUESTION_UNANSWERED",
]);
/** Rows that are bookkeeping, not anything the person asked for. */
const BOOKKEEPING = new Set([
  "HUMAN_TURN", "HOST_TURN", "QUESTION_REPLIED", "SUBAGENT_COMPLETED", "SUBAGENT_PROMPT_UNMATCHED", "ERROR_LOGGED",
  "GUARD_POLICY_SET", "COORDINATION_STOOD_ASIDE", "GUARD_STOOD_ASIDE", "SESSION_STARTED", "SESSION_ENDED", "SENSOR_PASSED",
  "SENSOR_FAILED", "SENSOR_BUDGET_OVERRIDE", "MEMORY_EMPTY", "STATE_MERGED", "STATE_FORKED", "STAGE_DEFINITION_CHANGED",
  "DECISION_RECORDED", "STAGE_AWAITING_APPROVAL", "PLAN_APPROVAL_BLOCKED",
]);

function readRows(proj: string): Row[] {
  try {
    return lib().readAuditShardEvents(proj).map(({ event, block }, index) => {
      const fields: Array<[string, string]> = [];
      let last: [string, string] | null = null;
      for (const line of block.split("\n")) {
        const m = /^\*\*([^*]+)\*\*: ?(.*)$/.exec(line);
        if (m) {
          last = [m[1], m[2]];
          fields.push(last);
        } else if (last !== null && !/^## /.test(line)) last[1] += `\n${line}`;
      }
      return { index, event, fields: fields.map(([k, v]) => [k, v.replace(/\n+$/, "")] as [string, string]) };
    });
  } catch {
    return [];
  }
}
export const field = (row: Row, name: string): string | null => row.fields.find(([k]) => k === name)?.[1] ?? null;

function recordFiles(proj: string): Record<string, string> {
  const files: Record<string, string> = {};
  let root: string;
  try {
    root = activeRecord(proj).dir;
  } catch {
    return files;
  }
  const walkDir = (at: string) => {
    if (!existsSync(at)) return;
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (name !== "audit") walkDir(path);
      } else if (stat.isFile() && stat.size < 256_000) {
        const text = readFileSync(path, "utf-8");
        // Keyed with forward slashes on every platform, so the checks that match a record's path match on Windows too.
        if (!text.includes("\u0000")) files[relative(proj, path).replace(/\\/g, "/")] = text;
      }
    }
  };
  walkDir(root);
  return files;
}

const scratchRoots: string[] = [];
let scratch: string | null = null;
function runFolder(): string {
  scratch ??= mkdtempSync(join(process.env.AIDLC_GATE_FUZZ_SCRATCH ?? tmpdir(), "gate-fuzz-runs-"));
  if (!scratchRoots.includes(scratch)) scratchRoots.push(scratch);
  return mkdtempSync(join(scratch, "r-"));
}
export function cleanupRuns(): void {
  while (scratchRoots.length > 0) cleanupTestProject(scratchRoots.pop());
  scratch = null;
}

/** The person's machine as the fuzz gives it: no variable of the chat this test itself runs in. */
export function fuzzEnvironment(unattended: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID", "KIRO_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_UNATTENDED"]) delete env[name];
  if (unattended) env.AIDLC_UNATTENDED = "1";
  return env;
}

// A host names its chats by how many hosts this process made, so a new chat can take the name of the walk's own chat:
// it is started again until its name is one the run has not used.
function freshChat(host: ScopeHost, chats: string[]): void {
  for (let tries = 0; tries < 8; tries++) {
    host.newSession();
    if (!chats.includes(host.session)) return;
  }
}

function joinChat(host: ScopeHost, proj: string, session: string): void {
  host.session = session;
  try {
    lib().writeSessionPidEntry(proj, process.pid, session);
  } catch {
    // A host that names its chat in the shell's environment needs none.
  }
}

const isBlank = (text: string) => text.trim().length === 0;
const isBareCommand = (text: string) => /^\s*[/$]aidlc\s*$/i.test(text);

/** The text a step's person turn types, in the twin run another text of the same shape. */
export function turnText(state: State, step: Extract<Step, { kind: "person" }>, twin: boolean): string {
  if (step.channel === "box-pick") return pick(rng(step.seed), state.options.length ? state.options : ["Approve"]);
  const seed = twin ? (step.seed ^ 0x5bd1e995) >>> 0 : step.seed;
  let text = textOf(step.shape, seed, state.options, step.seed);
  // A box's free text is the person's own words, never one of the box's labels (that is a pick).
  if (step.channel === "box-free" && state.options.some((o) => o.toLowerCase() === text.trim().toLowerCase())) text = `${text} please`;
  return text;
}

/** Play one run of steps against a copy of the state. */
export function play(state: State, seed: number, steps: Step[], opts: { twin?: boolean; dropped?: number[]; policy?: Policy } = {}): Run {
  const proj = join(runFolder(), "proj");
  // The install first, then the copy over it: a file the tool changed in its own tree is the copy's.
  for (const name of state.install.dirs) {
    if (existsSync(join(state.install.from, name))) cpSync(join(state.install.from, name), join(proj, name), { recursive: true });
  }
  copyTree(state.dir, proj, new Set(), false);
  if (opts.policy && opts.policy !== state.policy) setPolicy(proj, opts.policy);
  // An unattended driver starts the tool with AIDLC_UNATTENDED (the tool's own profile clears it).
  const host = hostFor(state.host, proj, fuzzEnvironment(state.unattended), { unattended: state.unattended });
  joinChat(host, proj, state.session);
  const first = state.session;
  const chats = [first];
  const start = readRows(proj).length;
  const messagesBefore = new Set(store().listMessages(proj).map((m) => m.id));
  const run: Run = {
    state, seed, dropped: opts.dropped ?? [], twin: opts.twin === true, steps: [], turns: [], rows: [], start, messages: [],
    earlier: [], files: {}, finalState: "", liveness: { ok: false, out: "" }, chats, proj, error: null,
  };
  let choices: Array<{ label: string; command: string }> = [...state.choices];
  const heard = (out: string) => {
    for (const line of out.split("\n").reverse()) {
      try {
        const d = JSON.parse(line) as { choices?: Array<{ label?: string; command?: string }> };
        if (Array.isArray(d.choices) && d.choices.length > 0) {
          choices = d.choices.filter((c) => typeof c.label === "string" && typeof c.command === "string") as typeof choices;
          return;
        }
      } catch {
        // Not a directive line.
      }
    }
  };
  const runOp = (op: Op, ops: OpResult[]): void => {
    switch (op.kind) {
      case "bash": {
        const line = op.line.replace(/--session (\S+)/g, `--session ${host.session}`);
        let res: RunResult;
        try {
          res = host.bash(line);
        } catch (error) {
          // The tool's own guard refused the command before it ran: the agent reads its refusal as the call's answer.
          if (!(error instanceof ScopeRunRefused)) throw error;
          ops.push({ what: line, status: 2, out: `[guard] ${error.refusal}` });
          return;
        }
        // Loading the step's rules comes back as load-steering: the agent follows its continuations to the step itself.
        for (let hop = 0; hop < 50; hop++) {
          let d: { kind?: unknown; next?: unknown } | null = null;
          try {
            d = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "");
          } catch {
            d = null;
          }
          if (d?.kind !== "load-steering" || typeof d.next !== "string") break;
          try {
            res = host.bash(d.next);
          } catch (error) {
            if (!(error instanceof ScopeRunRefused)) throw error;
            res = { status: 2, stdout: "", stderr: `[guard] ${error.refusal}` };
          }
        }
        const out = `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`;
        heard(res.stdout);
        ops.push({ what: line, status: res.status, out });
        return;
      }
      case "write":
        host.write(op.rel, op.content);
        return;
      case "remove":
        host.remove(op.rel);
        return;
      case "task":
        host.task(op.agent, op.prompt, () => {
          for (const inner of op.inner) runOp(inner, ops);
        });
    }
  };
  const stateText = () => {
    try {
      return readFileSync(activeRecord(proj).state, "utf-8");
    } catch {
      return "";
    }
  };
  const messageFor = (ref: MessageRef): string => {
    const rows = readRows(proj);
    const lastSpend = rows.findLastIndex((row) => SPENDING.has(row.event));
    const turns = rows.filter((row) => row.event === "HUMAN_TURN" && field(row, "Message Id") !== null);
    const id = (row: Row | undefined) => (row ? field(row, "Message Id") : null);
    switch (ref) {
      case "latest": return id(turns.findLast((row) => field(row, "Session") === host.session)) ?? "deadbeef";
      case "older": return id(turns.find((row) => row.index < start)) ?? "deadbeef";
      case "spent": return id(turns.findLast((row) => row.index < lastSpend)) ?? "deadbeef";
      case "other-chat": return id(turns.findLast((row) => field(row, "Session") !== host.session)) ?? "deadbeef";
      case "bogus": return "deadbeef";
    }
  };
  try {
    steps.forEach((step, i) => {
      const stateBefore = stateText();
      const from = readRows(proj).length;
      const ops: OpResult[] = [];
      let label: string = step.kind;
      let call: Call | null = null;
      switch (step.kind) {
        case "person": {
          const text = turnText(state, step, run.twin);
          label = `person ${step.channel} ${step.shape}`;
          if (step.channel === "typed") host.typed(text);
          else if (step.channel === "box-dismissed") {
            if (host instanceof NativeScopeHost) host.picked(state.prompt, state.options, "");
            else host.hook("record-human-turn", {
              hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
              tool_input: { questions: [{ question: state.prompt, header: "Choice", multiSelect: false, options: state.options.map((o) => ({ label: o, description: o })) }] },
              tool_response: { answers: {} },
            });
          } else host.picked(state.prompt, state.options, text);
          // A host's own template stays the host's turn (Arden 2026-10-22 kept the host-identity checks with no host mark).
          const reply = step.channel === "box-dismissed" ? false : step.channel === "box-pick" ? true :
            !(isBlank(text) || isBareCommand(text) || step.shape === "template");
          run.turns.push({ step: i, chat: host.session, channel: step.channel, shape: step.shape, text, at: readRows(proj).length, reply });
          break;
        }
        case "call": {
          const set = closedSet(state, host, { choices, proj });
          if (set.length === 0) {
            // The engine's own question: the agent reads it again to see its choices.
            const res = host.bash(engineLine(host, "orchestrate", "next"));
            heard(res.stdout);
            ops.push({ what: "next (to read the question)", status: res.status, out: res.stdout + res.stderr });
            label = "call (no choices yet)";
            break;
          }
          call = set[step.choice % set.length];
          const extra: string[] = [];
          // --message goes where the design takes it: an answer, a gate report, a checkpoint (section 2.2, item 2).
          const takesMessage = call.ops.some((op) => op.kind === "bash" && /(?: log answer | orchestrate report | bolt (?:swarm-)?checkpoint )/.test(` ${op.line} `.replace(/aidlc-(log|orchestrate|bolt)\.ts/, "$1")));
          if (step.message !== null && takesMessage) extra.push("--message", messageFor(step.message));
          if (step.endsTurn && call.ops.some((op) => op.kind === "bash" && / log answer /.test(op.line))) extra.push("--ends-turn");
          if (step.reason && call.lifecycle && call.name === "approve") extra.push("--reason", SHELL_REASON);
          label = `call ${call.name}${extra.length ? ` ${extra.filter((x) => x.startsWith("--")).join(" ")}${step.message ? `=${step.message}` : ""}` : ""}`;
          const last = call.ops.findLastIndex((op) => op.kind === "bash");
          for (const [at, op] of call.ops.entries()) {
            if (!(at === last && op.kind === "bash" && extra.length > 0)) {
              runOp(op, ops);
              continue;
            }
            runOp({ kind: "bash", line: `${op.line} ${extra.map(shellQuote).join(" ")}` }, ops);
            // A tree whose command does not take --message yet (the design's new flag): the agent runs it without one.
            const at2 = extra.indexOf("--message");
            if (at2 < 0 || !/does not accept \\?"--message\\?"/.test(ops.at(-1)?.out ?? "")) continue;
            ops.pop();
            const rest = extra.filter((_, k) => k !== at2 && k !== at2 + 1);
            runOp({ kind: "bash", line: rest.length > 0 ? `${op.line} ${rest.map(shellQuote).join(" ")}` : op.line }, ops);
            label += " (no --message on this tree)";
          }
          // A redo or jump answers with the command that makes the move; the agent runs it (the skill's `ask` row).
          // Each print names the next command of the move, up to where it says to run `next` again.
          // A plan change answers with the recompose it runs the same way (planChangeDirective).
          if (call.ops.some((op) => op.kind === "bash" && /--result resumed\b|orchestrate next --(?:skip|add)\b/.test(op.line))) {
            for (let hop = 0; hop < 4; hop++) {
              const named = /^\{"message":"Run `((?:next|report|bun |aidlc )[^`]*)`/.exec(ops.at(-1)?.out ?? "")?.[1]?.trim() ??
                /`((?:next|report|bun |aidlc )[^`]*)`/.exec(ops.at(-1)?.out ?? "")?.[1]?.trim();
              if (!named || /(?:^|\s)next$/.test(named) || /orchestrate(?:\.ts)? next$/.test(named)) break;
              runOp(bashOp(/^(?:bun|aidlc) /.test(named) ? named : engineLine(host, "orchestrate", ...named.split(/\s+/))), ops);
            }
          }
          break;
        }
        case "wrong": {
          const set = wrongCalls(state, host);
          call = set[step.variant % set.length];
          label = `wrong: ${call.name}`;
          for (const op of call.ops) runOp(op, ops);
          break;
        }
        case "next":
          runOp(bashOp(engineLine(host, "orchestrate", "next")), ops);
          break;
        case "reshow":
          if (state.reshow) runOp(bashOp(state.reshow.startsWith("bun ") || state.reshow.startsWith("aidlc ") ? state.reshow : engineLine(host, ...state.reshow.split(" "))), ops);
          break;
        case "stop": {
          const verdict = host.stop();
          ops.push({ what: "stop", status: verdict.blocked ? 2 : 0, out: verdict.reason });
          break;
        }
        case "chat":
          freshChat(host, chats);
          chats.push(host.session);
          joinChat(host, proj, host.session);
          break;
        case "back":
          joinChat(host, proj, first);
          break;
        case "resume":
          freshChat(host, chats);
          chats.push(host.session);
          joinChat(host, proj, host.session);
          host.typed("/aidlc --resume");
          run.turns.push({ step: i, chat: host.session, channel: "typed", shape: "command-bare", text: "/aidlc --resume", at: readRows(proj).length, reply: false });
          runOp(bashOp(engineLine(host, "orchestrate", "next", "--resume")), ops);
          break;
      }
      const rows = readRows(proj).slice(from);
      const landedRows = rows.filter((row) => !BOOKKEEPING.has(row.event));
      const stateAfter = stateText();
      // A pick of the engine's own question may carry the work on with no row of its own (part of the active work).
      const stepKind = (() => {
        try {
          return (JSON.parse((ops.at(-1)?.out ?? "").trim().split("\n").at(-1) ?? "") as { kind?: string }).kind ?? null;
        } catch {
          return null;
        }
      })();
      const carriedOn = call?.name.startsWith("pick ") === true && ["run-stage", "done", "ask"].includes(stepKind ?? "");
      const landed = call === null ? null : landedRows.length > 0 || carriedOn ||
        (stateAfter !== stateBefore && /parked/i.test(stateAfter) && !/parked/i.test(stateBefore));
      const refusal = call !== null && !landed ? clip(ops.map((op) => op.out).join("\n"), 1500) : null;
      run.steps.push({ i, step, label, chat: host.session, ops, from, rows, call, landed, refusal, stateBefore, stateAfter });
    });
    // After any run, one reply of the person's and `next` give a step.
    joinChat(host, proj, first);
    host.typed(NEUTRAL[0]);
    // Where no work exists yet, the agent hands `next` the person's words, as the skill forwards a first request.
    let res: RunResult;
    try {
      res = host.bash(engineLine(host, "orchestrate", "next", ...(stateText() === "" ? NEUTRAL[0].split(" ") : [])));
    } catch (error) {
      if (!(error instanceof ScopeRunRefused)) throw error;
      res = { status: 2, stdout: "", stderr: `[guard] ${error.refusal}` };
    }
    let ok = res.status === 0;
    try {
      const d = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as { kind?: string };
      ok = ok && typeof d.kind === "string" && d.kind !== "error";
    } catch {
      ok = false;
    }
    run.liveness = { ok, out: clip(`${res.stdout}${res.stderr}`, 1200) };
  } catch (error) {
    // A guard's refusal outside a call keeps its own words: they say why the run could not go on.
    const why = error instanceof ScopeRunRefused ? `: ${error.refusal}` : "";
    run.error = error instanceof Error ? clip(`${error.message}${why}`, 1500) : String(error);
  }
  if (host instanceof OpencodeScopeHost) host.dispose();
  run.rows = readRows(proj);
  run.finalState = stateText();
  const kept = store().listMessages(proj)
    .map((m) => ({ id: m.id, session: m.session, source: m.source, text: m.text, words: m.words, cut: m.cut === true }));
  run.messages = kept.filter((m) => !messagesBefore.has(m.id));
  run.earlier = kept.filter((m) => messagesBefore.has(m.id));
  run.files = recordFiles(proj);
  if (host instanceof NativeScopeHost && host.hookFailures.length > 0 && run.error === null) {
    run.error = `hook failures: ${clip(host.hookFailures.join(" | "), 1500)}`;
  }
  void stopVerdict;
  return run;
}

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

export type Invariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8" | "I9" | "STOP" | "RUN";

export interface Failure {
  invariant: Invariant;
  /** What fails, the same words for the same cause, so failures group. */
  what: string;
  /** Where it comes from in the source, when the output says. */
  source: string;
  step: number | null;
  detail: string;
}

const lastIndex = <T>(list: readonly T[], test: (item: T) => boolean, before: number): number => {
  for (let i = Math.min(before, list.length) - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
};

/**
 * The person's reply turns on record (the copy's own and the run's), by the design's rule. For presence (I1) a blank
 * typed message is one: the engine counts an empty prompt as the person's turn, since a host may drop its words.
 */
function replyTurns(run: Run, opts: { blankIsPresence?: boolean } = {}): Array<{ index: number; chat: string | null; message: string | null }> {
  const blank = new Set<string>();
  for (const m of run.messages) {
    if ((isBlank(m.text) && opts.blankIsPresence !== true) || (m.words === null && isBareCommand(m.text))) blank.add(m.id);
  }
  const ran = new Map(run.turns.map((t) => [t.at, t]));
  return run.rows.filter((row) => row.event === "HUMAN_TURN").filter((row) => {
    if (field(row, "Origin") === "host") return false;
    if (field(row, "Reply") === lib().COMMAND_TURN_REPLY) {
      // A typed reply the hook marked a command because another question holds it is still a reply (design 2.2, item 9).
      const mine = [...ran.values()].find((t) => t.at === row.index + 1 || t.at === row.index + 2);
      return mine?.reply === true;
    }
    const id = field(row, "Message Id");
    return id === null || !blank.has(id);
  }).map((row) => ({ index: row.index, chat: field(row, "Session"), message: field(row, "Message Id") }));
}

/** Where a refusal's text comes from in the source. */
let sources: Array<{ file: string; lines: string[] }> | undefined;
function sourceFiles(): Array<{ file: string; lines: string[] }> {
  if (sources) return sources;
  sources = [];
  const dirs = [join(REPO_ROOT, "core", "tools"), join(REPO_ROOT, "core", "hooks"),
    ...readdirSync(join(REPO_ROOT, "harness")).map((h) => join(REPO_ROOT, "harness", h, "hooks"))];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".ts")) sources.push({ file: relative(REPO_ROOT, join(dir, name)).replace(/\\/g, "/"), lines: readFileSync(join(dir, name), "utf-8").split("\n") });
    }
  }
  return sources;
}
function enclosingFunction(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(lines[i]) ??
      /^\s{2}(?:(?:private|protected|public|static|override|async)\s+)*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::[^{]*)?\{\s*$/.exec(lines[i]) ??
      /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::[^=]*)?=>/.exec(lines[i]);
    if (m && !["if", "for", "while", "switch", "catch", "else", "return", "function"].includes(m[1])) return m[1];
  }
  return "(top level)";
}
/** The function whose text an output shows: the longest piece of it found in core/ or a harness's hooks. */
export function locate(text: string): string | null {
  const pieces = text
    .replace(/\\"/g, '"')
    .split(/\\n|\n|"[^"]{0,80}"|`[^`]{0,80}`|[{}]|\b[0-9a-f]{8,}\b/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= 24)
    .sort((a, b) => b.length - a.length);
  for (const piece of pieces) {
    for (let length = Math.min(piece.length, 90); length >= 24; length -= 8) {
      for (let start = 0; start + length <= piece.length; start += Math.max(4, Math.floor(length / 3))) {
        const needle = piece.slice(start, start + length);
        for (const { file, lines } of sourceFiles()) {
          const at = lines.findIndex((line) => line.includes(needle));
          if (at >= 0) return `${file} ${enclosingFunction(lines, at)}`;
        }
      }
    }
  }
  return null;
}
/** A refusal's first line without ids, digits and paths, so the same refusal groups. */
export function signature(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && l !== "[stderr]");
  let message = lines[0] ?? "";
  for (const line of lines) {
    try {
      const d = JSON.parse(line) as { kind?: unknown; message?: unknown; error?: unknown; reason?: unknown };
      const said = [d.message, d.error, d.reason].find((v) => typeof v === "string");
      if (typeof said === "string" || typeof d.kind === "string") {
        message = typeof said === "string" ? said : `a ${String(d.kind)} step`;
        break;
      }
    } catch {
      // Not a JSON line.
    }
  }
  return message.replace(/"[^"]*"/g, '"_"').replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** I1 to I4, I6, I7, I9 and the Stop check, from one run. */
export function checkRun(run: Run): Failure[] {
  const failures: Failure[] = [];
  const { state } = run;
  const turns = replyTurns(run);
  const present = replyTurns(run, { blankIsPresence: true });
  const rows = run.rows;
  const chatsSpoke = (from: number, to: number) => new Set(turns.filter((t) => t.index > from && t.index < to).map((t) => t.chat));
  const chatsPresent = (from: number, to: number) => new Set(present.filter((t) => t.index > from && t.index < to).map((t) => t.chat));
  if (run.error) failures.push({ invariant: "RUN", what: "the run could not be played", source: "", step: null, detail: run.error });
  for (const s of run.steps) {
    for (const row of s.rows) {
      if (!DECIDING.has(row.event)) continue;
      // I1: an unspent reply since the last spending row, in this chat or the one chat that spoke since. The rows one
      // call writes are one decision (a batch reject writes one GATE_REJECTED per Unit), so the count starts before them.
      const lastSpend = lastIndex(rows, (r) => SPENDING.has(r.event), s.from);
      const backing = present.filter((t) => t.index > lastSpend && t.index < row.index);
      const spoke = chatsPresent(lastSpend, row.index);
      // A message the agent names in the same second as the last spending row is unspent to the engine: the record
      // keeps whole seconds, and the proof's tie favours the message (one message can give an approval and the answers
      // beside it).
      const namedId = s.ops.some((op) => / --message /.test(` ${op.what} `)) ? field(row, "Message Id") : null;
      const namedTurn = namedId === null ? undefined : rows.find((r) => r.event === "HUMAN_TURN" && field(r, "Message Id") === namedId);
      const spentRow = rows.find((r) => r.index === lastSpend);
      const tie = namedTurn !== undefined && spentRow !== undefined && namedTurn.index < lastSpend &&
        field(namedTurn, "Timestamp") === field(spentRow, "Timestamp");
      const backed = backing.some((t) => t.chat === s.chat) || (backing.length > 0 && spoke.size === 1) || tie;
      if (state.unattended) failures.push({ invariant: "I1", what: `${row.event} under AIDLC_UNATTENDED`, source: "", step: s.i, detail: s.label });
      else if (!backed) failures.push({ invariant: "I1", what: `${row.event} with no unspent reply of the person's`, source: "", step: s.i, detail: `${s.label}; rows since the last spending row: ${rows.slice(lastSpend + 1, row.index).map((r) => r.event).join(", ")}` });
      // I2: the row names the message, and the words on it are that message's. A decision in a chat with no reply of
      // its own since the last decision (one not sent while another engine question was open) names none unless the
      // agent named one: the window is this chat's, so no words and no id, and no refusal.
      const id = field(row, "Message Id");
      const message = id === null ? null : run.messages.find((m) => m.id === id) ?? null;
      // A message the copy held before the run is on record too: the agent may name one ("older"), and a message of
      // this work proves from any chat.
      const before = id === null || message !== null ? null : run.earlier.find((m) => m.id === id) ?? null;
      const sent = new Set(run.turns.map((t) => t.text));
      const ownReply = backing.some((t) => t.chat === s.chat &&
        field(rows.find((r) => r.index === t.index) ?? row, "Open Question") === null);
      const namedOne = s.ops.some((op) => / --message /.test(` ${op.what} `));
      if (id === null) {
        if (ownReply || namedOne) failures.push({ invariant: "I2", what: `${row.event} names no message`, source: "", step: s.i, detail: s.label });
      } else if (message === null && before === null) {
        failures.push({ invariant: "I2", what: `${row.event} names a message not of this run`, source: "", step: s.i, detail: id });
      } else if (message !== null && !sent.has(message.text)) {
        const cut = message.cut && [...sent].some((t) => t.startsWith(message.text));
        // The store keeps a message to its documented bound and marks the cut (MESSAGE_TEXT_MAX_CHARS); a cut anywhere
        // else, or unmarked, loses words.
        if (!(cut && message.text.length === store().MESSAGE_TEXT_MAX_CHARS)) {
          failures.push({ invariant: "I2", what: cut ? `the message record cut the words at ${message.text.length} characters` : "the message record is not what was typed", source: "", step: s.i, detail: `${JSON.stringify(clip(message.text, 120))}` });
        }
      }
      // A row whose words come from several messages names them all, oldest first, ending with Message Id: its words
      // are exactly theirs, joined (the blank ones carry none).
      const ids = field(row, "Message Ids")?.split(",") ?? null;
      const named = ids?.map((one) => [...run.earlier, ...run.messages].find((m) => m.id === one) ?? null) ?? null;
      if (ids !== null && (ids.at(-1) !== id || named!.some((m) => m === null))) {
        failures.push({ invariant: "I2", what: `${row.event} Message Ids is not its messages ending at Message Id`, source: "", step: s.i, detail: `${ids.join(",")} vs ${id}` });
      }
      const joined = named?.every((m) => m !== null)
        ? named.map((m) => m!.words ?? "").filter((words) => !isBlank(words)).join("\n") : null;
      // Since S1 a decision's words are every unspent reply of theirs in this chat, in order, ending with the message
      // the row names: a remark and the answer are both kept. The order is the record's, the HUMAN_TURN row that names
      // each message, as the engine reads it: the store lists messages by the second they came in and then by their
      // random id, so two replies in one second can list backwards.
      const turnAt = new Map<string, number>();
      for (const r of rows) {
        const named = r.event === "HUMAN_TURN" ? field(r, "Message Id") : null;
        if (named !== null && !turnAt.has(named)) turnAt.set(named, r.index);
      }
      const chat = run.messages.filter((m) => m.session === message?.session).map((m, i) => ({ m, i }))
        .sort((a, b) => (turnAt.get(a.m.id) ?? Number.POSITIVE_INFINITY) - (turnAt.get(b.m.id) ?? Number.POSITIVE_INFINITY) || a.i - b.i)
        .map(({ m }) => m);
      const chatWords = chat.map((m) => m.words ?? m.text);
      const at = message === null ? -1 : chat.findIndex((m) => m.id === message.id);
      // A row's field is one line: the audit writer writes each line break in it as \n (renderAuditBlock).
      const oneLine = (text: string) => text.replace(/\r\n?|\n|\u2028|\u2029/g, "\\n");
      const windowOf = (value: string) => at >= 0 && chatWords.slice(0, at + 1).some((_, from) => oneLine(chatWords.slice(from, at + 1).join("\n")) === value);
      // The summary receipt's Feedback is the agent's text after the choice ("Request changes: <what>"), like Reason.
      for (const name of row.event === "SUMMARY_CONFIRMATION_RECORDED" ? ["Person Reply"] : ["Person Reply", "Feedback"]) {
        const value = field(row, name);
        if (value === null) continue;
        const shown = message ?? before;
        const theirs = joined !== null ? value === oneLine(joined)
          : shown === null || value === oneLine(shown.words ?? shown.text) || windowOf(value);
        if (!theirs) {
          failures.push({ invariant: "I2", what: `${row.event} ${name} is not the message's words`, source: "", step: s.i, detail: `${JSON.stringify(clip(value, 120))} vs ${JSON.stringify(clip(joined ?? shown?.words ?? shown?.text ?? "", 120))}` });
        }
      }
    }
    if (s.call === null) continue;
    // I3: a choice outside the set changes nothing; a valid one is recorded as handed.
    if (!s.call.valid) {
      const changed = s.rows.filter((r) => !BOOKKEEPING.has(r.event)).map((r) => r.event);
      if (changed.length > 0 || s.stateAfter !== s.stateBefore) {
        failures.push({ invariant: "I3", what: `"${s.call.name}" outside the set was taken`, source: "", step: s.i, detail: `rows ${changed.join(", ") || "none"}${s.stateAfter !== s.stateBefore ? ", state changed" : ""}` });
      }
    } else if (s.landed && s.call.choice !== null) {
      const row = s.rows.find((r) => DECIDING.has(r.event));
      const recorded = !row ? null : row.event.startsWith("GATE_") ? field(row, "User Input")
        : field(row, "Choice") ?? field(row, "Details");
      if (row && recorded !== null && recorded !== s.call.choice) {
        failures.push({ invariant: "I3", what: `${row.event} recorded "${recorded}" for the choice handed`, source: "", step: s.i, detail: `handed ${JSON.stringify(s.call.choice)}` });
      }
    }
    // I4: a valid call at the open step, with a live reply in this chat, lands.
    if (s.call.valid && !s.landed && !state.unattended && openAt(run, s.i)) {
      const lastSpend = lastIndex(rows, (r) => SPENDING.has(r.event), s.from);
      const live = turns.some((t) => t.index > lastSpend && t.index < s.from && t.index >= run.start && (t.chat === s.chat || chatsSpoke(lastSpend, s.from).size === 1));
      const step = s.step as Extract<Step, { kind: "call" }>;
      const named = step.message === null || step.message === "latest";
      if (live && named) {
        const text = s.refusal ?? "";
        failures.push({ invariant: "I4", what: `"${s.call.name}" refused with a live reply: ${signature(text)}`, source: locate(text) ?? "(not found in the source)", step: s.i, detail: clip(text, 600) });
      }
    }
  }
  // I6: a refusal's own step taken does not bring the same refusal back (the run follows a step only where it names one).
  for (let k = 1; k < run.steps.length; k++) {
    const a = run.steps[k - 1];
    const b = run.steps[k];
    if (a.refusal && b.refusal && a.call?.name === b.call?.name && a.stateAfter !== a.stateBefore && signature(a.refusal) === signature(b.refusal)) {
      failures.push({ invariant: "I6", what: `the same refusal came back after a step changed the state: ${signature(b.refusal)}`, source: locate(b.refusal) ?? "", step: b.i, detail: clip(b.refusal, 400) });
    }
  }
  if (!run.liveness.ok && run.error === null) {
    failures.push({ invariant: "I6", what: "after the run, a reply and next gave no step", source: locate(run.liveness.out) ?? "", step: null, detail: run.liveness.out });
  }
  // I7: one reply backs at most one lifecycle decision; the rows one call writes are one. (The words themselves are
  // the message store's since S1: I2 above reads them there, and the gate-words record's own cap is no loss of them.)
  const stepOf = (index: number) => run.steps.find((o) => index >= o.from && index < o.from + o.rows.length)?.i ?? index;
  for (let k = 0; k < turns.length; k++) {
    const from = turns[k].index;
    const to = turns[k + 1]?.index ?? Number.POSITIVE_INFINITY;
    const spent = rows.filter((r) => r.index > from && r.index < to && r.index >= run.start && SPENDING.has(r.event) && r.event !== "QUESTION_UNANSWERED");
    const calls = [...new Map(spent.map((r) => [stepOf(r.index), r.event])).values()];
    if (calls.length > 1) failures.push({ invariant: "I7", what: `one reply backed ${calls.join(" and ")}`, source: "", step: null, detail: `turn at row ${from}` });
  }
  // I9: no engine output to the agent holds the person's words, and none has a `say` field.
  for (const s of run.steps) {
    for (const op of s.ops) {
      if (/"say"\s*:/.test(op.out)) failures.push({ invariant: "I9", what: "an engine output carries a say field", source: locate(op.out) ?? "", step: s.i, detail: clip(op.out, 300) });
      for (const t of run.turns) {
        if (t.step >= s.i) continue;
        // A quote may be cut short, so the first 30 characters are enough to show it.
        const words = t.text.trim().slice(0, 30);
        if (words.length >= 12 && !["label", "label-variant", "engine-string", "digit", "command-bare", "blank"].includes(t.shape) && op.out.includes(words)) {
          // Where in the step the words sit, when it is a JSON step: the field that hands them to the agent.
          const path = jsonPathHolding(op.out, words);
          // The resume re-show hands the agent the replies a stage kept: the one carrier of their words the design
          // allows in a step (reading-lead, 2026-10-23).
          if (path === "kept_replies.replies[#]") continue;
          failures.push({ invariant: "I9", what: `the person's words in an engine output ${path ? `at ${path}` : `(${t.shape})`}`, source: locate(op.out.split(words).join(" ")) ?? "", step: s.i, detail: clip(op.what, 160) });
          break;
        }
      }
    }
  }
  // Stop: where the wait is on record and nobody has replied since, the agent can end its turn; and an attended turn
  // with nothing on record that the agent waits ends too (Arden 2026-10-22, the design's S4).
  for (const s of run.steps) {
    if (s.step.kind !== "stop" || s.ops[0]?.status !== 2 || state.unattended) continue;
    const replied = run.turns.some((t) => t.step < s.i);
    const decided = run.steps.some((o) => o.i < s.i && o.landed);
    const what = !replied && !decided ? "the Stop hook kept the agent from ending its turn at a recorded wait"
      : "the Stop hook kept an attended turn from ending (nothing on record that the agent waits)";
    failures.push({ invariant: "STOP", what, source: locate(s.ops[0].out) ?? "", step: s.i, detail: clip(s.ops[0].out, 300) });
  }
  return failures;
}

/** The field path (array places as #) of the first string in an output's JSON lines that holds `words`; null if none. */
function jsonPathHolding(out: string, words: string): string | null {
  const walk = (value: unknown, path: string): string | null => {
    if (typeof value === "string") return value.includes(words) ? path : null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const hit = walk(entry, `${path}[#]`);
        if (hit) return hit;
      }
      return null;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        const hit = walk(entry, path ? `${path}.${key}` : key);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const line of out.split("\n")) {
    try {
      const hit = walk(JSON.parse(line), "");
      if (hit) return hit;
    } catch {
      // Not a JSON line.
    }
  }
  return null;
}

/** Whether the state's own step is still open at step `at`: nothing the person decided has landed and the work is not parked. */
function openAt(run: Run, at: number): boolean {
  for (const s of run.steps) {
    if (s.i >= at) break;
    if (s.landed) return false;
    // A decision a hook recorded from a person turn, or a wrong call that landed, closes the step as much as a call.
    if (s.rows.some((r) => SPENDING.has(r.event))) return false;
    if (s.step.kind === "resume" || s.step.kind === "chat") return false;
    if (/\*\*Status\*\*: (?:Parked|parked)/.test(s.stateAfter)) return false;
  }
  return true;
}

// --- I5: the same run with other words of the same shape ---

const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g;
const HEX = /\b[0-9a-f]{8,}\b/g;
function norm(run: Run, text: string): string {
  // The run's folder as written raw, inside a JSON string (Windows doubles its backslashes) and with forward slashes.
  let out = text;
  for (const form of [JSON.stringify(run.proj).slice(1, -1), run.proj, run.proj.replace(/\\/g, "/")]) out = out.split(form).join("<PROJ>");
  out = out.replace(/gate-fuzz-runs-[A-Za-z0-9]+(?:\\\\|\\|\/)r-[A-Za-z0-9]+/g, "<RUN>");
  // The walked project a state was copied from, named in a record written before the copy (a sensor's output path).
  out = out.replace(/[^\s"'`<>]*?[\\/]+aidlc-test-[A-Za-z0-9]+/g, "<PROJ>");
  run.chats.forEach((chat, at) => {
    out = out.split(chat).join(`<CHAT${at}>`);
  });
  return out.replace(TIMESTAMP, "<TS>").replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>").replace(HEX, "<HEX>").replace(/\b1[6-9]\d{11}\b/g, "<MS>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<TOKEN>")
    // Receipts, nonces and byte offsets a run mints or counts for itself (an offset moves with the length of the words before it).
    .replace(/"(\w*(?:receipt|token|nonce|offset|dropped)\w*)"\s*:\s*(?:"[^"]*"|\d+)/gi, '"$1":"<N>"');
}
/** Fields whose values a run mints or times for itself. */
const MINTED_FIELD = /(?:\bms$|Duration|Offset|Receipt|Nonce|Token)/i;
/** A record file's word-keeping values taken out (the gate-words record, a question's kept reply). */
function withoutWords(text: string): string {
  return text.replace(/"(text|words|reply|said|feedback|person_reply|personReply|personWords|person_words)"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"$1":"<W>"');
}
/** Fields that copy the person's words, and the ones a run mints for itself. */
const WORD_FIELDS = new Set(["Person Reply", "Feedback", "Reason", "Details", "Message Id", "Timestamp", "Reply", "Words", "Person Words", "Picked"]);

/** What the record holds, by place, with the word-copying fields and the minted ids taken out. */
export function recordView(run: Run): Map<string, string> {
  const view = new Map<string, string>();
  const clean = (text: string) => norm(run, withoutWords(text));
  run.rows.slice(run.start).forEach((row, at) => {
    view.set(`row${at}`, row.event);
    for (const [k, v] of row.fields) if (!WORD_FIELDS.has(k)) view.set(`row${at}.${k}`, MINTED_FIELD.test(k) ? "<N>" : clean(v));
  });
  view.set("state", clean(run.finalState));
  for (const [path, text] of Object.entries(run.files)) view.set(`file ${norm(run, path)}`, clean(text));
  // Messages that land in one second sort by their random ids, so the sources are compared as a set.
  view.set("messages", run.messages.map((m) => `${m.source}${m.cut ? " cut" : ""}`).sort().join(","));
  return view;
}

/** I5: the twin run's record against the run's. */
export function checkTwin(a: Run, b: Run): Failure[] {
  const va = recordView(a);
  const vb = recordView(b);
  const differ: string[] = [];
  for (const where of new Set([...va.keys(), ...vb.keys()])) {
    const x = va.get(where);
    const y = vb.get(where);
    if (x === y) continue;
    differ.push(where);
  }
  if (differ.length === 0) return [];
  // A field that holds each run's own words is a copy of them, outside the fields the design names; not a reader.
  const typedA = new Set(a.turns.map((t) => t.text.trim()));
  const typedB = new Set(b.turns.map((t) => t.text.trim()));
  const strip = (run: Run, value: string) => {
    let out = value;
    for (const t of [...run.turns].sort((x, y) => y.text.length - x.text.length)) {
      const words = t.text.trim();
      if (words.length === 0) continue;
      for (const form of [words, JSON.stringify(words).slice(1, -1), words.replace(/\s+/g, " "), words.slice(0, 40)]) out = out.split(form).join("<W>");
    }
    return out;
  };
  const copies = differ.filter((where) => {
    const x = va.get(where);
    const y = vb.get(where);
    if (x === undefined || y === undefined) return false;
    return (typedA.has(x.trim()) && typedB.has(y.trim())) || strip(a, x) === strip(b, y);
  });
  const rest = differ.filter((where) => !copies.includes(where));
  const copyFailures: Failure[] = [...new Set(copies.map((where) => where.replace(/^row(\d+)\./, (_, n) => `${a.rows[a.start + Number(n)]?.event ?? "row"}.`)))]
    .map((where) => ({ invariant: "I5" as const, what: `the person's words copied into ${where}`, source: "", step: null, detail: where }));
  if (rest.length === 0) return copyFailures;
  differ.splice(0, differ.length, ...rest);
  return [...copyFailures, ...twinDifference(a, b, va, vb, differ)];
}

function twinDifference(a: Run, b: Run, va: Map<string, string>, vb: Map<string, string>, differ: string[]): Failure[] {
  // The first step whose rows or outcome differ points at the reader.
  for (let k = 0; k < Math.min(a.steps.length, b.steps.length); k++) {
    const sa = a.steps[k];
    const sb = b.steps[k];
    const ea = sa.rows.map((r) => r.event).join(",");
    const eb = sb.rows.map((r) => r.event).join(",");
    if (ea !== eb || sa.landed !== sb.landed) {
      const refused = sa.refusal ?? sb.refusal ?? sa.ops.map((o) => o.out).join("\n");
      const textA = a.turns.filter((t) => t.step <= k).map((t) => JSON.stringify(clip(t.text, 40))).join(" ");
      const textB = b.turns.filter((t) => t.step <= k).map((t) => JSON.stringify(clip(t.text, 40))).join(" ");
      return [{
        invariant: "I5", what: `${sa.label}: ${sa.landed === sb.landed ? "rows differ" : sa.landed ? "landed for one text, refused for the other" : "refused for one text, landed for the other"}${refused ? ` (${signature(refused)})` : ""}`,
        source: (refused && locate(refused)) || "(not found in the source)", step: k,
        detail: `texts ${textA} -> rows [${ea}] | texts ${textB} -> rows [${eb}]`,
      }];
    }
  }
  return [{ invariant: "I5", what: `the record differs in ${differ[0].replace(/\d+/g, "#")}`, source: "", step: null, detail: `${differ.slice(0, 4).join(", ")}: ${clip(va.get(differ[0]) ?? "", 200)} || ${clip(vb.get(differ[0]) ?? "", 200)}` }];
}

/** I8: what off and relaxed refuse on a run, strict refuses too. */
export function checkPolicies(byPolicy: Record<string, Run>): Failure[] {
  const refused = (run: Run) => new Set(run.steps.filter((s) => s.call !== null && !s.landed).map((s) => s.i));
  const strict = byPolicy.strict;
  if (!strict) return [];
  const failures: Failure[] = [];
  for (const policy of ["relaxed", "off"]) {
    const run = byPolicy[policy];
    if (!run) continue;
    for (const i of refused(run)) {
      if (!refused(strict).has(i)) {
        const s = run.steps[i];
        failures.push({ invariant: "I8", what: `${policy} refused "${s.call?.name}" that strict took: ${signature(s.refusal ?? "")}`, source: locate(s.refusal ?? "") ?? "", step: i, detail: clip(s.refusal ?? "", 400) });
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// A run, checked, and shrunk when it fails
// ---------------------------------------------------------------------------

export interface Checked {
  id: string;
  state: string;
  steps: number;
  failures: Failure[];
  ms: number;
  run: Run;
}

/** The id that replays a run: the state, the seed, and the steps a shrink dropped. */
export const runId = (state: State, seed: number, dropped: number[] = [], most = 40) =>
  `${state.id}@${seed}${most !== 40 ? `~${most}` : ""}${dropped.length ? `!${dropped.join(",")}` : ""}`;
export function parseRunId(id: string): { state: string; seed: number; most: number; dropped: number[] } {
  const m = /^(.+)@(\d+)(?:~(\d+))?(?:!([\d,]+))?$/.exec(id);
  if (!m) throw new Error(`not a gate-fuzz run id: ${id}`);
  return { state: m[1], seed: Number(m[2]), most: m[3] ? Number(m[3]) : 40, dropped: m[4] ? m[4].split(",").map(Number) : [] };
}

/** Play a seed's run, its twin, and check both. */
export function checkSeed(state: State, seed: number, opts: { most?: number; dropped?: number[] } = {}): Checked {
  const most = opts.most ?? 40;
  const dropped = opts.dropped ?? [];
  const steps = stepsFor(state, seed, most).filter((_, i) => !dropped.includes(i));
  const started = Date.now();
  const run = play(state, seed, steps, { dropped });
  const twin = play(state, seed, steps, { twin: true, dropped });
  const failures = [...checkRun(run), ...checkTwin(run, twin)];
  return { id: runId(state, seed, dropped, most), state: state.id, steps: steps.length, failures, ms: Date.now() - started, run };
}

const key = (f: Failure) => `${f.invariant} ${f.what}`;

/** Drop steps, one at a time from the end, while the same failure stays: the smallest run that still shows it. */
export function shrink(state: State, seed: number, failure: Failure, opts: { most?: number; budget?: number } = {}): Checked | null {
  const most = opts.most ?? 40;
  let dropped: number[] = [];
  let best: Checked | null = null;
  let budget = opts.budget ?? 20;
  const total = stepsFor(state, seed, most).length;
  for (let i = total - 1; i >= 0 && budget > 0; i--) {
    const trial = [...dropped, i].sort((x, y) => x - y);
    budget--;
    const checked = checkSeed(state, seed, { most, dropped: trial });
    if (checked.failures.some((f) => key(f) === key(failure))) {
      dropped = trial;
      best = checked;
    }
  }
  return best;
}

export { NativeScopeHost };

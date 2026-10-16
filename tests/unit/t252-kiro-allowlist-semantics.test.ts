// covers: file:settings.json
//
// t252-kiro-allowlist-semantics: the shipped Kiro `execute_bash` permission
// patterns are asserted BEHAVIOURALLY, by re-implementing Kiro's own matcher
// and running real command strings through it, not by pinning literal regex
// text. A literal-string assertion cannot tell a working pattern from an inert
// one, which is exactly how the Kiro IDE's `\${?KIRO_PROJECT_DIR}?` spelling
// (unescaped braces = invalid regex, silently dropped) shipped dead.
//
// Mechanism = none: pure in-process reads of the shipped dist agent JSONs plus
// RegExp evaluation. No spawn, no LLM.
//
// The shipped allowlist grants ONLY AI-DLC's own project-relative `.kiro/tools/`
// invocations. Absolute paths are excluded because a path only has to be SHAPED
// like a tool path, not be trustworthy: a grant for any `/.../.kiro/tools/*.ts`
// pre-approves running a file from a world-writable directory (verified live:
// `bun /tmp/.kiro/tools/evil.ts` executed unprompted under such a grant).
// `KIRO_PROJECT_DIR` and `cd` forms are excluded for the same reason: neither a
// variable's value nor a chained working directory is knowable from the regex.
//
// The matcher contract below is transcribed from the upstream CLI
// (crates/chat-cli/src/cli/chat/tools/execute/mod.rs) and re-verified live
// against kiro-cli 2.12.1:
//   - each pattern is wrapped `\A<pat>\z` — a FULL-STRING match, never a prefix
//     one (so an optional tail must be spelled `( .*)?`);
//   - an invalid allow pattern is silently DROPPED (`.filter(Result::is_ok)`),
//     so it neither allows nor denies — it is simply inert;
//   - `deniedCommands` is evaluated first and beats any allow;
//   - each `&&`/`;`/`|`/newline segment is matched SEPARATELY, so a chain runs
//     unprompted only when EVERY segment is allowed. Verified live: with both
//     segments granted, `bun .kiro/tools/<t>.ts && date -u` ran unprompted.
//     `evaluate()` therefore models segmentation rather than refusing outright
//     on the presence of a separator. A blanket refusal would report "ask" for
//     a chain the binary actually allows, and so could not catch a future
//     over-broad allow entry being reached through one.
//
// Tail metacharacters (`>`, `$(...)`) are a separate mechanism: live 2.12.1
// gates those even when the pattern's `( .*)?` tail would match.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDABLE_PROJECT_BYPASSES } from "../../core/tools/aidlc-settings.ts";
import { CONFIG_SECTIONS } from "../../core/tools/aidlc-command.ts";
import { copyChannelToolScripts } from "../../core/tools/aidlc.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HARNESSES = ["kiro"] as const;

// Every read form agents were seen running for "show my settings", "what
// version", "is my setup healthy" and "what is my status", pinned on their own
// so the list cannot lose one.
const SEEN_READ_FORMS = [
  "--status",
  "--version",
  "version",
  "config --help",
  "doctor",
  "--doctor",
  "doctor --verbose",
  "--doctor --verbose",
  "config --show",
  "config --show --json",
  ...CONFIG_SECTIONS.flatMap((section) => [
    `config ${section} --show`,
    `config ${section} --show --json`,
    `config ${section} --help`,
  ]),
];


const PERSONAS = [
  "aidlc-architect-agent.json",
  "aidlc-architecture-reviewer-agent.json",
  "aidlc-aws-platform-agent.json",
  "aidlc-compliance-agent.json",
  "aidlc-composer-agent.json",
  "aidlc-delivery-agent.json",
  "aidlc-design-agent.json",
  "aidlc-developer-agent.json",
  "aidlc-devsecops-agent.json",
  "aidlc-operations-agent.json",
  "aidlc-pipeline-deploy-agent.json",
  "aidlc-product-agent.json",
  "aidlc-product-lead-agent.json",
  "aidlc-quality-agent.json",
];

interface ExecuteBash {
  allowedCommands?: string[];
  deniedCommands?: string[];
}

function execBash(harness: string, agentFile: string): ExecuteBash {
  const p = join(REPO_ROOT, "dist", harness, ".kiro", "agents", agentFile);
  const doc = JSON.parse(readFileSync(p, "utf-8")) as {
    toolsSettings?: Record<string, ExecuteBash>;
  };
  const eb = doc.toolsSettings?.execute_bash;
  if (!eb) throw new Error(`${harness}/${agentFile}: no execute_bash settings`);
  return eb;
}

/** Kiro compiles patterns with the Rust `regex` crate, which is STRICTER than
 *  JavaScript: `{` begins a repetition and must carry a decimal bound, so
 *  `\${?FOO}?` is a hard compile error there while JS silently treats the brace
 *  as a literal (Annex B web-compat). Reject that class explicitly — otherwise
 *  a JS-only validity check calls the inert Kiro IDE pattern "valid" and the
 *  test guards nothing. */
function rustRejects(pattern: string): boolean {
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\\") {
      i++;
      continue;
    }
    if (chars[i] === "{") {
      // Valid Rust repetition: {n}, {n,}, {n,m}
      const rest = pattern.slice(i);
      const repetition = /^\{\d+(,\d*)?\}/.exec(rest);
      if (!repetition) return true;
      i += repetition[0].length - 1;
    }
  }
  return false;
}

/** Compile one pattern the way Kiro does, or null if the regex is invalid
 *  (upstream drops these silently — an inert pattern). */
function compile(pattern: string): RegExp | null {
  if (rustRejects(pattern)) return null;
  try {
    return new RegExp(`^(?:${pattern})$`, "s");
  } catch {
    return null;
  }
}

/** Tail metacharacters the binary gates independently of pattern matching:
 *  command substitution and redirection. Verified live on 2.12.1 -- both
 *  `bun .kiro/tools/<t>.ts > /tmp/x` and `... --stamp $(date -u +%s)` are gated
 *  even though the pattern's `( .*)?` tail matches them.
 *
 *  A BARE `$` is deliberately not listed: under a config that allowlisted the
 *  `$KIRO_PROJECT_DIR` form, `bun $KIRO_PROJECT_DIR/.kiro/tools/<t>.ts` ran
 *  unprompted live, so variable expansion alone does not gate. Those forms are
 *  gated today because no shipped pattern matches them, which is a property of
 *  the allowlist and belongs under pattern matching, not here.
 *
 *  Separators are also not listed; `segments()` handles those. */
const TAIL_METACHARACTERS = ["$(", "`", "<", ">"];

function hasTailMetacharacter(command: string): boolean {
  return TAIL_METACHARACTERS.some((token) => command.includes(token));
}

/** Split on the separators Kiro matches independently. Quote-aware: a `;` or
 *  `&&` INSIDE a quoted argument is argument text, not a separator (verified
 *  live: `--text "safe; words"` runs unprompted under an allow match).
 *  Newline is a separator too: Rust's negated character classes match `\n`, so
 *  a pattern like `cd [^;&|]+` would otherwise span a newline-joined chain. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") {
      if (ch === "|" && command[i + 1] === "|") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&") {
      // `&&` chains and a bare `&` (background) both separate.
      if (command[i + 1] === "&") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

type Verdict = "allow" | "ask" | "deny";

/** Kiro's permission outcome for one command. `ask` becomes a hard refusal when
 *  the session has no interactive or ACP approver; `deny` cannot be approved. */
function evaluate(eb: ExecuteBash, command: string): Verdict {
  const denied = (eb.deniedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);
  if (denied.some((r) => r.test(command))) return "deny";

  const allowed = (eb.allowedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);

  const segs = segments(command);
  if (segs.length === 0) return "ask";
  // A denied segment anywhere makes the whole command unapprovable.
  if (segs.some((s) => denied.some((r) => r.test(s)))) return "deny";
  if (segs.some(hasTailMetacharacter)) return "ask";
  return segs.every((s) => allowed.some((r) => r.test(s))) ? "allow" : "ask";
}

// Command forms the framework's own prose/engine actually emits, which MUST run
// unprompted or a workflow stalls mid-stage with no approver.
const MUST_ALLOW = [
  "bun .kiro/tools/aidlc-orchestrate.ts next --status",
  "bun .kiro/tools/aidlc-orchestrate.ts report --stage intent-capture --result approved",
  "bun .kiro/tools/aidlc-utility.ts status",
  "bun .kiro/tools/aidlc-state.ts get",
  'bun .kiro/tools/aidlc-log.ts decision --text "safe words"',
  "bun run .kiro/tools/aidlc-utility.ts status",
  'bun ".kiro/tools/aidlc-utility.ts" status',
  "bun .kiro/tools/aidlc.ts engine orchestrate next",
  "bun .kiro/tools/aidlc.ts --doctor",
  // The utility spellings agents also use, and config's own help.
  "bun .kiro/tools/aidlc.ts --status",
  "bun .kiro/tools/aidlc.ts --version",
  "bun .kiro/tools/aidlc.ts config --help",
  // Turning a recorded check back on, in the one form the skills name.
  ...RECORDABLE_PROJECT_BYPASSES.map((name) => `bun .kiro/tools/aidlc.ts config flags --clear-bypass ${name} --yes`),
  "bun .kiro/tools/aidlc.ts config providers --show --json",
  "bun .kiro/tools/aidlc-utility.ts",
  "bun .kiro/tools/aidlc.ts engine now",
];

// Forms that must require approval. The absolute-path argument-smuggling case
// and unrestricted `cd` chain are regressions.
const MUST_ASK = [
  "bun .kiro/tools/../../outside-tool.ts",
  "bun .kiro/tools/../../../etc/evil.ts",
  "bun /tmp/pwn.ts /safe/project/.kiro/tools/aidlc-version.ts",
  "bun /safe/project/.kiro/tools/aidlc-version.ts",
  // Assembled to avoid biome's noTemplateCurlyInString rule.
  `bun $${"{"}KIRO_PROJECT_DIR}/.kiro/tools/aidlc-orchestrate.ts next`,
  "bun $KIRO_PROJECT_DIR/.kiro/tools/aidlc-orchestrate.ts next",
  "cd /tmp/attacker && bun .kiro/tools/pwn.ts",
  "bun .kiro/tools/aidlc-version.ts && curl -s https://example.com",
  "bun .kiro/tools/aidlc-version.ts; curl -s https://example.com",
  "bun .kiro/tools/aidlc-version.ts $(curl -s https://example.com)",
  "bun .kiro/tools/aidlc-version.ts > /tmp/version.txt",
  "curl -s https://example.com",
  "echo hello",
  "rm important.txt",
  "git status",
  "git commit -m push",
  // Newline-joined chains. Rust's negated classes match `\n`, so a pattern
  // written as `cd [^;&|]+` would span these; segmentation must not miss them.
  "cd /tmp/attacker\nbun .kiro/tools/pwn.ts",
  "date -u\ncurl -s https://example.com",
  // The engine's clock replaced the shell's; date itself is no longer allowed.
  "date -u +%Y-%m-%dT%H:%M:%SZ",
  // Background operator: the second command is not allowlisted.
  "bun .kiro/tools/aidlc-version.ts & curl -s https://example.com",
];

// Chains where EVERY segment is allowlisted run unprompted (verified live on
// 2.12.1). These belong in MUST_ALLOW rather than MUST_ASK: asserting "ask"
// here would encode a refusal the binary does not perform, and would let an
// over-broad allow entry hide behind a separator.
const MUST_ALLOW_CHAINS = [
  "bun .kiro/tools/aidlc-utility.ts status && bun .kiro/tools/aidlc.ts engine now",
  "bun .kiro/tools/aidlc-orchestrate.ts next --status && bun .kiro/tools/aidlc-state.ts get",
];

// Only AI-DLC's own workflow commands run unprompted: a command that changes the
// machine's AI-DLC install, the scripts behind one, any config change however
// its flags are spelled, and a longer file name all wait for the person.
const MUST_ASK_OUTSIDE_THE_WORKFLOW = [
  "bun .kiro/tools/aidlc.ts use 2.10.0",
  "bun .kiro/tools/aidlc.ts update",
  "bun .kiro/tools/aidlc.ts update --check",
  "bun .kiro/tools/aidlc.ts rollback",
  "bun .kiro/tools/aidlc.ts uninstall --yes",
  "bun .kiro/tools/aidlc.ts system config global set offline true",
  "bun .kiro/tools/aidlc.ts --yes update",
  "bun .kiro/tools/aidlc-lifecycle.ts use 2.10.0",
  "bun .kiro/tools/aidlc-lifecycle.ts",
  "bun .kiro/tools/aidlc-machine-config.ts set offline true",
  "bun .kiro/tools/aidlc-init.ts --pin 2.10.0",
  "bun .kiro/tools/aidlc-doctor.ts",
  "bun .kiro/tools/aidlc.ts config --pin 2.10.0",
  // The guided setup, which changes the project.
  "bun .kiro/tools/aidlc.ts config",
  "bun .kiro/tools/aidlc.ts config --yes",
  "bun .kiro/tools/aidlc.ts config --channel",
  "bun .kiro/tools/aidlc.ts config models --gl\"obal\" --yes",
  "bun .kiro/tools/aidlc.ts config models --deciding-effort high --project --yes",
  "bun .kiro/tools/aidlc.ts config models --show --json --global",
  // Turning a check off, and a form that changes something else as well.
  "bun .kiro/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --local --yes",
  "bun .kiro/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes",
  "bun .kiro/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --bypass AIDLC_DISABLE_SENSORS --yes",
  "bun .kiro/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_SENSORS --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes",
  "bun .kiro/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --bypass AIDLC_DISABLE_SENSORS",
  "bun .kiro/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --question-retention-days 1",
  "bun .kiro/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --global",
  "bun .kiro/tools/aidlc.ts config flags --clear-bypass AIDLC_NOT_A_SWITCH --yes",
  "bun .kiro/tools/aidlc-log.tsx",
  "bun .kiro/tools/aidlc-log.ts.bak run",
];

// A push and a recursive delete go to the person: Kiro asks once, and the
// person's own trust holds. Never denied (a refusal with no way past, measured
// live on 2.29.0), and never run unasked.
const PERSON_DECIDES = [
  "git push origin main",
  "git push",
  "git -C . push origin main",
  'git -C "/tmp/work tree" push origin main',
  "/usr/bin/git push origin main",
  "rm -rf /",
  "rm -rf ~/work",
  "rm -rf *",
  "rm -fr build",
  "rm -r -f /tmp/target",
  "/bin/rm -rf /tmp/target",
  "rm --recursive --force /tmp/target",
];

// The same commands behind an allowed AI-DLC command: no allow entry carries
// one through.
const PERSON_DECIDES_CHAINED = [
  "bun .kiro/tools/aidlc.ts engine now && git push origin main",
  "bun .kiro/tools/aidlc-utility.ts status; rm -rf build",
  "bun .kiro/tools/aidlc-state.ts get | rm -rf /",
  "bun .kiro/tools/aidlc.ts engine now\ngit push",
  'bun .kiro/tools/aidlc-log.ts decision --text "x" && rm -r -f /tmp/target',
];
const NATIVE_PERSON_DECIDES_CHAINED = [
  "aidlc engine now && git push origin main",
  "aidlc engine orchestrate next; rm -rf ~/work",
  "aidlc status | rm -rf /",
  "aidlc engine now\nrm -rf build",
];

// Engine commands from one Kiro CLI bugfix run, first as the engine printed
// them, then as the agent ran them with another command added. Only the added
// command made Kiro ask (re-checked live on 2.23.1: the printed form ran, a
// `| tee` tail asked), which is why the Kiro skill says to run every AI-DLC
// command as printed.
const AS_PRINTED = [
  "bun .kiro/tools/aidlc-orchestrate.ts next",
  "bun .kiro/tools/aidlc-review-brief.ts context --stage code-generation",
  "bun .kiro/tools/aidlc-review-brief.ts review --stage code-generation --why first",
  "bun .kiro/tools/aidlc.ts engine orchestrate report --stage code-generation --result awaiting-approval",
];

const WITH_A_COMMAND_ADDED = [
  "bun .kiro/tools/aidlc-review-brief.ts context --stage code-generation | head -40",
  'bun .kiro/tools/aidlc-orchestrate.ts next | python3 -c "import sys,json; print(json.load(sys.stdin)[0])"',
  'bun .kiro/tools/aidlc-review-brief.ts review --stage code-generation --why first && echo "GATE-OPEN"',
  "cd web && bun .kiro/tools/aidlc-orchestrate.ts next",
];

// The project's own test and build commands run project code and differ per
// project, so they keep asking the person.
const PROJECT_COMMANDS = ["bun test src/filter.test.ts", "bun test", "bunx tsc --noEmit", "npm test"];

// Kiro's `fs_write` outcome for one path, as observed live on 2.23.1 with a
// hook-free agent allowing `[!.]*` and `[!.]*/**`: a path is taken relative to
// the project root (an absolute path inside the project matched), anything
// that resolves outside the project asked (`/tmp/...`, `../...`, `~/...`), and
// inside it a dot below the top level was fine (`src/.env-probe` was written),
// while `.kiro/...` asked. A blanket `fs_write` in `allowedTools` allows every
// path. A blocking preToolUse hook still refused an allowed write, so the
// plan-approval guard keeps its say. Kiro CLI 2.29.0 (Linux) and 2.27.1
// (Windows) read an entry's leading `./` as the project root.
function writeVerdict(agent: { allowedTools?: string[]; allowedPaths: string[] }, path: string): "allow" | "ask" {
  if (agent.allowedTools?.includes("fs_write")) return "allow";
  const rel = projectRelative(path);
  if (rel === null) return "ask";
  return agent.allowedPaths.some((glob) => globRegExp(glob.replace(/^\.\//, "")).test(rel)) ? "allow" : "ask";
}

/** The path relative to the project root, or null when it resolves outside. */
function projectRelative(path: string): string | null {
  const root = "/project";
  const abs = path.startsWith("~") ? `/home/person${path.slice(1)}` : posix.resolve(root, path);
  const rel = posix.relative(root, abs);
  return rel === "" || rel.startsWith("..") || posix.isAbsolute(rel) ? null : rel;
}

/** The glob subset the shipped paths use: `*` and `**` match any run of
 *  characters, `/` included, and `[!x]` is a negated class. Kiro 2.29.0's `*`
 *  crosses `/` too (measured with a hook-free agent: `.aidlc/worktrees/*` +
 *  `/[!.]*` + `/**` allowed `.aidlc/worktrees/<w>/.kiro/agents/x.json`). */
function globRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      while (glob[i + 1] === "*") i++;
      out += ".*";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i);
      out += `[${glob.slice(i + 1, close).replace(/^!/, "^")}]`;
      i = close;
    } else {
      out += ch.replace(/[.+?^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

function writeSettings(harness: string, agentFile: string): { allowedTools?: string[]; allowedPaths: string[] } {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, "dist", harness, ".kiro", "agents", agentFile), "utf-8")) as {
    allowedTools?: string[];
    toolsSettings?: { fs_write?: { allowedPaths?: string[] } };
  };
  return { allowedTools: doc.allowedTools, allowedPaths: doc.toolsSettings?.fs_write?.allowedPaths ?? [] };
}

// The two agents that write project code: the developer and the conductor
// (inline builds).
const CODE_WRITERS = ["aidlc.json", "aidlc-developer-agent.json"];

const WRITE_ALLOW = [
  "web/src/filter.ts",
  "web/src/filter.test.ts",
  "README.md",
  "/project/web/src/filter.ts",
  "/project/README.md",
  "aidlc/spaces/default/intents/fix/plan.md",
];

const WRITE_ASK = [
  ".kiro/agents/aidlc.json",
  ".kiro/tools/aidlc-orchestrate.ts",
  ".git/config",
  ".github/workflows/ci.yml",
  "/project/.github/workflows/ci.yml",
  "src/../.github/workflows/ci.yml",
  ".husky/pre-commit",
  ".kiro/steering/notes.md",
  ".aidlc/worktree-meta.json",
  ".env",
  ".gitignore",
  "/tmp/outside.txt",
  "/etc/hosts",
  "../outside.txt",
  "web/../../outside.txt",
  "~/outside.txt",
];

// A side-by-side build gives each worker its own checkout at
// `.aidlc/worktrees/bolt-<id8>_<slug>`, a top-level dot entry. The unit's own
// records there are written like the same records in the project; the worker's
// code there, the worktree's own dot entries and the rest of `.aidlc/` still
// ask. Measured on 2.29.0: a broader worktree glob also let a worker write its
// worktree's `.kiro/agents` and `.github/workflows`, so those stay pinned here.
// Kiro resolves `..` before it matches, so a record path cannot step out of it.
const WORKTREE = ".aidlc/worktrees/bolt-1a2b3c4d_u1";
const WORKTREE_RECORD = `${WORKTREE}/aidlc/spaces/default/intents/fix/construction/u1/code-generation/code-generation-plan.md`;
const WORKTREE_WRITE_ALLOW = [WORKTREE_RECORD, `/project/${WORKTREE_RECORD}`];
const WORKTREE_WRITE_ASK = [
  `${WORKTREE}/src/app.js`,
  `${WORKTREE}/test/app.test.js`,
  `${WORKTREE}/README.md`,
  `${WORKTREE}/.kiro/agents/aidlc.json`,
  `${WORKTREE}/.github/workflows/ci.yml`,
  `${WORKTREE}/.gitignore`,
  `${WORKTREE}/.git`,
  ".aidlc/worktrees/notes.txt",
  ".aidlc/other/notes.md",
  `${WORKTREE}/../../../../outside.txt`,
  `${WORKTREE}/aidlc/spaces/../../src/app.js`,
  `${WORKTREE}/aidlc/spaces/../../.kiro/agents/aidlc.json`,
  `${WORKTREE}/aidlc/spaces/../../../../../.kiro/agents/aidlc.json`,
  "aidlc/spaces/../../.kiro/agents/aidlc.json",
];

describe("t252 Kiro execute_bash allowlist semantics", () => {
  test("Rust validity shim accepts bounded repetitions and literal closing braces", () => {
    for (const pattern of ["a{2}", "a{2,}", "a{2,4}", "x}y"]) {
      expect(compile(pattern), pattern).not.toBeNull();
    }
    expect(compile("a{,3}")).toBeNull();
    expect(compile("\\$" + "{?KIRO_PROJECT_DIR}?")).toBeNull();
  });

  // Without this, a MUST_ASK entry could pass for the wrong reason: if the
  // model refused every command carrying a separator or metacharacter, those
  // entries would stay green even against an allowlist of `.*`. Pin that the
  // ask/deny verdicts are produced by the shipped patterns, not by a blanket
  // syntax refusal.
  test("MUST_ASK verdicts come from the shipped patterns, not a blanket refusal", () => {
    const wideOpen = { allowedCommands: [".*"], deniedCommands: [] };
    // The two tail-metacharacter cases are gated by the separate mechanism
    // documented on TAIL_METACHARACTERS, not by the allowlist, so they are
    // expected to survive a wide-open allowlist. Every OTHER entry must owe its
    // `ask` verdict to the shipped patterns.
    const byMechanism = MUST_ASK.filter(hasTailMetacharacter);
    expect(byMechanism.length, "tail-metacharacter cases").toBe(2);

    const shouldBeAllowlistDriven = MUST_ASK.filter((c) => !hasTailMetacharacter(c));
    const tautological = shouldBeAllowlistDriven.filter(
      (cmd) => evaluate(wideOpen, cmd) !== "allow",
    );
    expect(
      tautological,
      `these pass regardless of the shipped allowlist, so they assert nothing about it: ${tautological.join(", ")}`,
    ).toEqual([]);
  });

  for (const harness of HARNESSES) {
    const agents = ["aidlc.json", ...PERSONAS];

    test(`${harness}: every shipped pattern is a VALID regex (no inert entries)`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const p of [...(eb.allowedCommands ?? []), ...(eb.deniedCommands ?? [])]) {
          expect(compile(p), `${harness}/${agent}: inert pattern ${p}`).not.toBeNull();
        }
      }
    });

    test(`${harness}: framework-emitted commands run unprompted`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_ALLOW) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should allow \`${cmd}\``)
            .toBe("allow");
        }
      }
    });

    test(`${harness}: chains of allowed segments run unprompted`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_ALLOW_CHAINS) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should allow \`${cmd}\``)
            .toBe("allow");
        }
      }
    });

    test(`${harness}: anything outside AI-DLC's own workflow commands waits for the person`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_ASK_OUTSIDE_THE_WORKFLOW) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should ask for \`${cmd}\``).toBe("ask");
        }
      }
    });

    test(`${harness}: traversal and out-of-scope commands require approval`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_ASK) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should ask for \`${cmd}\``)
            .toBe("ask");
        }
      }
    });

    test(`${harness}: a push and a recursive delete ask the person`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of [...PERSON_DECIDES, ...PERSON_DECIDES_CHAINED]) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should ask for \`${cmd}\``).toBe("ask");
        }
      }
    });

    test(`${harness}: no blanket shell trust via allowedTools`, () => {
      for (const agent of agents) {
        const doc = JSON.parse(
          readFileSync(
            join(REPO_ROOT, "dist", harness, ".kiro", "agents", agent),
            "utf-8",
          ),
        ) as { allowedTools?: string[] };
        expect(doc.allowedTools ?? []).not.toContain("execute_bash");
      }
    });

    test(`${harness}: personas carry the conductor's shell policy`, () => {
      const conductor = execBash(harness, "aidlc.json");
      for (const agent of PERSONAS) {
        expect(execBash(harness, agent), agent).toEqual(conductor);
      }
    });

    test(`${harness}: AI-DLC commands run as printed, and only an added command asks`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of AS_PRINTED) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should allow \`${cmd}\``).toBe("allow");
        }
        for (const cmd of [...WITH_A_COMMAND_ADDED, ...PROJECT_COMMANDS]) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should ask for \`${cmd}\``).toBe("ask");
        }
      }
      const skill = readFileSync(join(REPO_ROOT, "dist", harness, ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill).toContain("Run every AI-DLC command exactly as printed, as a command of its own");
      // Both install channels tell the person which project writes need no click.
      for (const tree of ["dist", "dist-release"]) {
        const onboarding = readFileSync(join(REPO_ROOT, tree, harness, ".kiro", "steering", "aidlc-onboarding.md"), "utf-8");
        expect(onboarding, tree).toContain("- **Project writes**: apart from those commands");
        expect(onboarding, tree).toContain("`.kiro/sensors/`");
      }
    });

    test(`${harness}: the developer and the conductor write project files, not dot entries or outside paths`, () => {
      for (const agent of CODE_WRITERS) {
        const settings = writeSettings(harness, agent);
        for (const path of WRITE_ALLOW) {
          expect(writeVerdict(settings, path), `${harness}/${agent}: should allow writing ${path}`).toBe("allow");
        }
        for (const path of WRITE_ASK) {
          expect(writeVerdict(settings, path), `${harness}/${agent}: should ask before writing ${path}`).toBe("ask");
        }
      }
      // The conductor's own sensor files under `.kiro/` stay pre-approved for it alone.
      expect(writeVerdict(writeSettings(harness, "aidlc.json"), ".kiro/sensors/aidlc-linter.md")).toBe("allow");
      expect(writeVerdict(writeSettings(harness, "aidlc-developer-agent.json"), ".kiro/sensors/aidlc-linter.md")).toBe("ask");
      // The other personas still write only their own AI-DLC files.
      const architect = writeSettings(harness, "aidlc-architect-agent.json");
      expect(writeVerdict(architect, "web/src/filter.ts")).toBe("ask");
      expect(writeVerdict(architect, "aidlc/spaces/default/intents/fix/plan.md")).toBe("allow");
    });

    test(`${harness}: a side-by-side worker writes its unit's records in its worktree, and nothing else there`, () => {
      for (const agent of CODE_WRITERS) {
        const settings = writeSettings(harness, agent);
        for (const path of WORKTREE_WRITE_ALLOW) {
          expect(writeVerdict(settings, path), `${harness}/${agent}: should allow writing ${path}`).toBe("allow");
        }
        for (const path of WORKTREE_WRITE_ASK) {
          expect(writeVerdict(settings, path), `${harness}/${agent}: should ask before writing ${path}`).toBe("ask");
        }
      }
      // The other personas keep their records in the project.
      expect(writeVerdict(writeSettings(harness, "aidlc-architect-agent.json"), WORKTREE_RECORD)).toBe("ask");
    });
  }
});

// The native release runs AI-DLC through the installed `aidlc` command. Every
// agent that runs AI-DLC's engine commands also runs, exactly as written, the
// same read-only and turn-back-on commands as the copy channel; any change
// still waits for the person.
describe("t252 Kiro native release allowlist", () => {
  function nativeBash(agentFile: string): ExecuteBash {
    const p = join(REPO_ROOT, "dist-release", "kiro", ".kiro", "agents", agentFile);
    const doc = JSON.parse(readFileSync(p, "utf-8")) as { toolsSettings?: Record<string, ExecuteBash> };
    const eb = doc.toolsSettings?.execute_bash;
    if (!eb) throw new Error(`dist-release/kiro/${agentFile}: no execute_bash settings`);
    return eb;
  }
  const agents = ["aidlc.json", ...PERSONAS];
  const check = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";

  test("every read form agents run works unprompted on both channels", () => {
    for (const agent of agents) {
      for (const form of SEEN_READ_FORMS) {
        expect(evaluate(execBash("kiro", agent), `bun .kiro/tools/aidlc.ts ${form}`), `${agent}: ${form}`).toBe("allow");
        expect(evaluate(nativeBash(agent), `aidlc ${form}`), `${agent}: ${form}`).toBe("allow");
      }
      for (const form of ["config", "config --yes", "--config", "config models --show --global"]) {
        expect(evaluate(execBash("kiro", agent), `bun .kiro/tools/aidlc.ts ${form}`), `${agent}: ${form}`).not.toBe("allow");
        expect(evaluate(nativeBash(agent), `aidlc ${form}`), `${agent}: ${form}`).not.toBe("allow");
      }
    }
  });

  test("reading a setting, doctor, status, version and turning a check back on run unprompted", () => {
    for (const agent of agents) {
      const eb = nativeBash(agent);
      for (const p of [...(eb.allowedCommands ?? []), ...(eb.deniedCommands ?? [])]) {
        expect(compile(p), `${agent}: inert pattern ${p}`).not.toBeNull();
      }
      for (const command of [
        "aidlc engine orchestrate next",
        "aidlc doctor",
        "aidlc --doctor",
        "aidlc status",
        "aidlc --status",
        "aidlc version",
        "aidlc --version",
        "aidlc config --help",
        "aidlc config models --show --json",
        "aidlc config flags --help",
        ...RECORDABLE_PROJECT_BYPASSES.map((name) => `aidlc config flags --clear-bypass ${name} --yes`),
      ]) {
        expect(evaluate(eb, command), `${agent}: should allow \`${command}\``).toBe("allow");
      }
    }
  });

  test("a push and a recursive delete ask the person, alone or behind an allowed aidlc command", () => {
    for (const agent of agents) {
      const eb = nativeBash(agent);
      for (const command of [...PERSON_DECIDES, ...NATIVE_PERSON_DECIDES_CHAINED]) {
        expect(evaluate(eb, command), `${agent}: should ask for \`${command}\``).toBe("ask");
      }
    }
  });

  test("the guided setup, any config change, turning a check off and the machine commands still ask", () => {
    for (const agent of agents) {
      const eb = nativeBash(agent);
      for (const command of [
        "aidlc config",
        "aidlc config --yes",
        "aidlc --config",
        "aidlc config --pin 2.10.0",
        "aidlc config --channel preview",
        "aidlc config models --show --json --global",
        "aidlc config models --deciding-effort high --project --yes",
        `aidlc config flags --bypass ${check} --local --yes`,
        `aidlc config flags --bypass ${check} --yes`,
        `aidlc config flags --clear-bypass ${check} --bypass AIDLC_DISABLE_SENSORS --yes`,
        `aidlc config flags --clear-bypass ${check} --yes --bypass AIDLC_DISABLE_SENSORS`,
        `aidlc config flags --clear-bypass ${check} --yes --global`,
        "aidlc config flags --clear-bypass AIDLC_NOT_A_SWITCH --yes",
        "aidlc doctor --fix",
        "aidlc doctor && aidlc update",
        "aidlc update",
        "aidlc use 2.10.0",
        "aidlc uninstall --yes",
        "aidlc system config global set offline true",
      ]) {
        expect(evaluate(eb, command), `${agent}: should ask for \`${command}\``).not.toBe("allow");
      }
    }
  });
});

// Kiro CLI's upgrade for its 3.0 engine (`kiro-cli agent upgrade`, the same
// rewrite its `--v3` picker runs) turns each allowedCommands regular expression
// into shell globs, and a Kiro 3.0 `*` matches any run of characters, `/` and
// spaces included. Measured on kiro-cli 2.29.0: a group of alternatives or an
// optional group becomes one glob per spelling, `\x` becomes `x`, and the
// `( .*)?` tail becomes ` *` plus the bare form, so those translate exactly; an
// optional character class such as `["']?` becomes `*`, so `bun (run )?["']?`
// in front of a path let `bun -e '<code>' .kiro/tools/aidlc.ts engine now` and
// the same path in any other folder run unasked; and an entry with more
// spellings than Kiro's limit is dropped without a word (behind that prefix,
// 8 alternatives converted and 12 were dropped), so the one entry for all the
// tool scripts left each of them asking the person.
function v3Translation(pattern: string): { globs: string[]; widened: string[] } {
  const widened: string[] = [];
  let i = 0;
  const notModelled = (what: string) => new Error(`Kiro's translation of ${what} in ${pattern} is not modelled`);
  const alternatives = (): string[] => {
    let out = sequence();
    while (pattern[i] === "|") {
      i++;
      out = [...out, ...sequence()];
    }
    return out;
  };
  const sequence = (): string[] => {
    let out = [""];
    while (i < pattern.length && pattern[i] !== "|" && pattern[i] !== ")") {
      const start = i;
      let part: string[];
      if (pattern[i] === "\\") {
        part = [pattern[i + 1]];
        i += 2;
      } else if (pattern.slice(i) === "( .*)?") {
        part = [" *", ""];
        i = pattern.length;
      } else if (pattern[i] === "(") {
        i++;
        part = alternatives();
        if (pattern[i++] !== ")") throw notModelled("an open group");
        if (pattern[i] === "?") {
          i++;
          part = [...part, ""];
        }
      } else if (pattern[i] === "[") {
        i = pattern.indexOf("]", i) + 1;
        if (i === 0 || pattern[i] !== "?") throw notModelled(pattern.slice(start, i || undefined));
        i++;
        widened.push(pattern.slice(start, i));
        part = ["*"];
      } else if ("?*+{}.^$".includes(pattern[i])) {
        throw notModelled(pattern[i]);
      } else {
        part = [pattern[i++]];
      }
      out = out.flatMap((head) => part.map((tail) => head + tail));
    }
    return out;
  };
  const globs = alternatives();
  if (i !== pattern.length) throw notModelled(pattern.slice(i));
  return { globs: [...new Set(globs)], widened };
}

/** Kiro 3.0's outcome for one command against an agent's translated globs:
 *  every segment matches a glob in full, and a command substitution asks. */
function v3Evaluate(globs: RegExp[], command: string): Verdict {
  const segs = segments(command);
  if (segs.length === 0 || segs.some((s) => s.includes("$(") || s.includes("`"))) return "ask";
  return segs.every((s) => globs.some((glob) => glob.test(s))) ? "allow" : "ask";
}

function v3Globs(agent: string): RegExp[] {
  return (execBash("kiro", agent).allowedCommands ?? []).flatMap((entry) => v3Translation(entry).globs.map(globRegExp));
}

// Commands shaped like AI-DLC's own that are not: inline code, a preload,
// another runner, another script, the same file name in another folder, and a
// longer file name. Each asks on both engines.
const LOOKS_LIKE_AN_AIDLC_COMMAND = [
  "bun -e 'console.log(1)' .kiro/tools/aidlc.ts engine now",
  "bun -e 'console.log(1)' .kiro/tools/aidlc-log.ts decision --text x",
  "bun -e 'console.log(1)' .kiro/tools/aidlc.ts doctor",
  "bun --eval 'console.log(1)' .kiro/tools/aidlc-state.ts get",
  "bun --eval=console.log(1) .kiro/tools/aidlc.ts engine now",
  "bun -p 1 .kiro/tools/aidlc.ts engine now",
  "bun -r ./evil.ts .kiro/tools/aidlc-log.ts decision",
  "bun --preload ./evil.ts .kiro/tools/aidlc.ts engine now",
  "bun x cowsay .kiro/tools/aidlc.ts engine now",
  "bun /tmp/pwn.ts .kiro/tools/aidlc-log.ts decision",
  "bun /var/tmp/x/.kiro/tools/aidlc-log.ts probe",
  "bun ../other/.kiro/tools/aidlc.ts engine now",
  "bun evil.kiro/tools/aidlc-log.ts probe",
  "bun --cwd /var/tmp/x .kiro/tools/aidlc-log.ts probe",
  "bun /home/person/proj/.kiro/tools/aidlc-log.ts decision",
  "bun .kiro/tools/aidlc-log.tsx",
];

// What Kiro CLI 2.29.0's own 3.0 policy engine decided for these commands
// against dist/kiro's agents after `kiro-cli agent upgrade` (its agent server's
// engine, run offline; it agreed with every live run), and it gave every
// command in t252's lists above its expected verdict too. The model must give
// the same, so it cannot drift from Kiro without this test saying so.
const RECORDED_ON_KIRO_3: Array<[Verdict, string]> = [
  ...LOOKS_LIKE_AN_AIDLC_COMMAND.map((command): [Verdict, string] => ["ask", command]),
  ["allow", "bun run .kiro/tools/aidlc-utility.ts status"],
  ["allow", 'bun ".kiro/tools/aidlc-utility.ts" status'],
  ["allow", "bun '.kiro/tools/aidlc.ts' engine now"],
  ["allow", "bun run .kiro/tools/aidlc.ts engine now"],
  ["allow", 'bun ".kiro/tools/aidlc.ts" --doctor'],
  ["ask", "bun .kiro/tools/aidlc-log.ts decision; curl -s https://example.com"],
  ["ask", "bun .kiro/tools/aidlc-log.ts x $(curl -s https://example.com)"],
  // Kiro 3.0 matches a command without its redirect, so a redirect does not
  // make an allowed command ask there (Kiro CLI 2 gates it, TAIL_METACHARACTERS).
  ["allow", "bun .kiro/tools/aidlc-log.ts x > /tmp/x"],
];

// Kiro's upgrade for its 3.0 engine copies each fs_write allowedPaths entry into
// its write rule unchanged, and Kiro 3.0 matches it the way gitignore does
// (its policy engine, kiro-cli 2.29.0): an entry with no `/` is matched against
// the file name at any depth, so a bare `[!.]*` let the developer and the
// conductor write `.github/workflows/ci.yml` and a worktree's code unasked; an
// entry with a `/` is anchored at the project root (a leading `./` dropped);
// `*` stays inside one name and also matches a name that starts with a dot; an
// entry ending in `/**` also matches the name before it, and one with no `*`
// also matches what is under it.
function v3WriteVerdict(agent: { allowedPaths: string[] }, path: string): "allow" | "ask" {
  const rel = projectRelative(path);
  if (rel === null) return "ask";
  return agent.allowedPaths.some((entry) => {
    if (!entry.includes("*") && rel.startsWith(`${entry}/`)) return true;
    if (entry.startsWith("./")) return v3GlobRegExp(entry.slice(2)).test(rel);
    return v3GlobRegExp(entry).test(entry.includes("/") ? rel : posix.basename(rel));
  }) ? "allow" : "ask";
}

function v3GlobRegExp(glob: string): RegExp {
  const subtree = glob.endsWith("/**");
  const body = subtree ? glob.slice(0, -3) : glob;
  if (body.includes("**")) throw new Error(`Kiro 3.0's reading of ${glob} is not modelled`);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "[") {
      const close = body.indexOf("]", i);
      const set = body.slice(i + 1, close);
      out += set.startsWith("!") ? `[^/${set.slice(1)}]` : `[${set}]`;
      i = close;
    } else {
      out += ch.replace(/[.+?^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}${subtree ? "(?:/.*)?" : ""}$`, "s");
}

// What Kiro CLI 2.29.0 on its 3.0 engine (`--agent-engine v3`, headless, after
// Kiro's own upgrade of an agent with the developer's write list) did for these
// paths: written, or refused because it would have asked. Absolute paths sat
// under the project root. Kiro's own protected paths (`.vscode`, `.kiro/agents`)
// and outside paths asked there whatever the list says.
const RECORDED_WRITES_ON_KIRO_3: Array<["allow" | "ask", string]> = [
  ...[
    "README-probe.md",
    "package-probe.json",
    "src/app-probe.js",
    "web/src/deep/x.ts",
    "src/.env-probe",
    "aidlc/spaces/default/intents/i/plan.md",
    ".aidlc/worktrees/bolt-1a2b3c4d_u1/aidlc/spaces/default/intents/i/construction/u1/plan.md",
    "/project/README-abs-probe.md",
    "/project/src/abs-probe.js",
  ].map((path): ["allow" | "ask", string] => ["allow", path]),
  ...[
    ".aidlc/worktrees/bolt-1a2b3c4d_u1/src/wt-probe.js",
    ".aidlc/worktrees/bolt-1a2b3c4d_u1/.kiro/agents/aidlc.json",
    ".aidlc/worktree-meta.json",
    ".github/workflows/ci.yml",
    ".vscode/settings.json",
    ".husky/pre-commit",
    ".kiro/steering/x.md",
    ".kiro/agents/x.json",
    ".gitignore",
    ".env",
    "../outside.txt",
    "/tmp/outside.txt",
    "src/../.env-dotdot-probe",
    "src/../.github/workflows/dotdot-probe.yml",
    "/project/.github/workflows/abs-probe.yml",
    "/project/.aidlc/worktrees/bolt-1a2b3c4d_u1/src/abs-wt-probe.js",
  ].map((path): ["allow" | "ask", string] => ["ask", path]),
];

describe("t252 Kiro allowlist after Kiro CLI's 3.0 upgrade", () => {
  const agents = ["aidlc.json", ...PERSONAS];

  test("every write entry holds a `/`, so Kiro 3.0 anchors it at the project root", () => {
    for (const agent of agents) {
      for (const entry of writeSettings("kiro", agent).allowedPaths) {
        expect(entry, `${agent}: Kiro 3.0 reads ${entry} as a file name at any depth`).toContain("/");
      }
    }
  });

  test("the developer and the conductor write on Kiro 3.0 what they write on Kiro CLI 2", () => {
    for (const agent of CODE_WRITERS) {
      const settings = writeSettings("kiro", agent);
      for (const path of [...WRITE_ALLOW, ...WRITE_ASK, ...WORKTREE_WRITE_ALLOW, ...WORKTREE_WRITE_ASK]) {
        expect(v3WriteVerdict(settings, path), `${agent}: ${path}`).toBe(writeVerdict(settings, path));
      }
    }
  });

  test("the write model gives the verdicts Kiro 3.0 gave", () => {
    for (const agent of CODE_WRITERS) {
      for (const [verdict, path] of RECORDED_WRITES_ON_KIRO_3) {
        expect(v3WriteVerdict(writeSettings("kiro", agent), path), `${agent}: Kiro 3.0 recorded ${verdict} for ${path}`).toBe(verdict);
      }
    }
  });

  test("every entry translates exactly, with no `*` but the arguments' and at most 12 globs", () => {
    for (const agent of agents) {
      for (const entry of execBash("kiro", agent).allowedCommands ?? []) {
        const { globs, widened } = v3Translation(entry);
        expect(widened, `${agent}: Kiro's upgrade turns these into * in ${entry}`).toEqual([]);
        expect(globs.length, `${agent}: ${entry}`).toBeLessThanOrEqual(12);
      }
    }
  });

  test("each tool script has its own entry, which becomes that script's globs", () => {
    const scripts = copyChannelToolScripts().map((script) => script.slice(0, -".ts".length));
    expect(scripts.length).toBeGreaterThan(20);
    for (const agent of agents) {
      const allowed = execBash("kiro", agent).allowedCommands ?? [];
      for (const script of scripts) {
        const own = allowed.filter((entry) => entry.includes(`/${script}\\.ts`));
        expect(own.length, `${agent}: ${script}`).toBe(1);
        const { globs } = v3Translation(own[0]);
        expect(globs, `${agent}: ${script}`).toContain(`bun .kiro/tools/${script}.ts`);
        expect(globs, `${agent}: ${script}`).toContain(`bun .kiro/tools/${script}.ts *`);
      }
    }
  });

  test("AI-DLC's own commands run unasked and nothing else does, as on Kiro CLI 2", () => {
    for (const agent of agents) {
      const globs = v3Globs(agent);
      for (const cmd of [...SEEN_READ_FORMS.map((form) => `bun .kiro/tools/aidlc.ts ${form}`), ...MUST_ALLOW, ...MUST_ALLOW_CHAINS, ...AS_PRINTED]) {
        expect(v3Evaluate(globs, cmd), `${agent}: should allow \`${cmd}\``).toBe("allow");
      }
      for (const cmd of [
        ...MUST_ASK,
        ...MUST_ASK_OUTSIDE_THE_WORKFLOW,
        ...PERSON_DECIDES,
        ...PERSON_DECIDES_CHAINED,
        ...WITH_A_COMMAND_ADDED,
        ...PROJECT_COMMANDS,
        ...LOOKS_LIKE_AN_AIDLC_COMMAND,
      ]) {
        expect(v3Evaluate(globs, cmd), `${agent}: should ask for \`${cmd}\``).toBe("ask");
      }
      for (const cmd of LOOKS_LIKE_AN_AIDLC_COMMAND) {
        expect(evaluate(execBash("kiro", agent), cmd), `${agent} on Kiro CLI 2: should ask for \`${cmd}\``).toBe("ask");
      }
    }
  });

  test("the model gives the verdicts Kiro 3.0's own engine gave", () => {
    const globs = v3Globs("aidlc.json");
    for (const [verdict, cmd] of RECORDED_ON_KIRO_3) {
      expect(v3Evaluate(globs, cmd), `Kiro 3.0 recorded ${verdict} for \`${cmd}\``).toBe(verdict);
    }
  });
});

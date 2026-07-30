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
// The shipped allowlist grants ONLY project-relative `.kiro/tools/<file>.ts`
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HARNESSES = ["kiro", "kiro-ide"] as const;

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
      i++; // escaped: skip the next char
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
  "bun run .kiro/tools/aidlc-version.ts",
  'bun ".kiro/tools/aidlc-version.ts"',
  "date -u",
  "date -u +%Y-%m-%dT%H:%M:%SZ",
];

// Forms that must require approval. The absolute-path argument-smuggling case
// and unrestricted `cd` chain are regressions from the first 2.5.16 candidate.
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
  // Background operator: the second command is not allowlisted.
  "bun .kiro/tools/aidlc-version.ts & curl -s https://example.com",
];

// Chains where EVERY segment is allowlisted run unprompted (verified live on
// 2.12.1). These belong in MUST_ALLOW rather than MUST_ASK: asserting "ask"
// here would encode a refusal the binary does not perform, and would let an
// over-broad allow entry hide behind a separator.
const MUST_ALLOW_CHAINS = [
  "bun .kiro/tools/aidlc-version.ts && date -u",
  "bun .kiro/tools/aidlc-orchestrate.ts next --status && bun .kiro/tools/aidlc-state.ts get",
];

// Destructive forms must be denied outright, not merely sent to an approver.
const MUST_DENY = [
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

    test(`${harness}: traversal and out-of-scope commands require approval`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_ASK) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should ask for \`${cmd}\``)
            .toBe("ask");
        }
      }
    });

    test(`${harness}: destructive commands are denied, not approvable`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_DENY) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should deny \`${cmd}\``)
            .toBe("deny");
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
  }
});

// covers: file:settings.json
//
// t252-kiro-allowlist-semantics: the shipped Kiro `execute_bash` permission
// patterns are asserted BEHAVIOURALLY by running real command strings through
// the stable permission policy shared by supported Kiro releases. Literal-text
// assertions cannot tell a working pattern from an inert one.
//
// Mechanism = none: pure in-process reads of the shipped dist agent JSONs plus
// RegExp evaluation. No spawn, no LLM.
//
// Kiro releases differ in how they pre-parse compound shell commands, so the
// shipped allowlist deliberately avoids variable-expanded paths, absolute
// paths, and `cd` chains. The common contract asserted here is:
//   - each pattern is wrapped `\A<pat>\z` — a FULL-STRING match, never a prefix
//     one (so an optional tail must be spelled `( .*)?`);
//   - an invalid allow pattern is silently DROPPED (`.filter(Result::is_ok)`),
//     so it neither allows nor denies — it is simply inert;
//   - `deniedCommands` is evaluated first and beats any allow;
//   - shell control syntax stays approval-gated rather than relying on
//     release-specific segmentation.

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

const DANGEROUS_SHELL_TOKENS = ["\n", "\r", "<", ">", "&", "|", ";", "$", "`", "IFS"];

function hasDangerousShellSyntax(command: string): boolean {
  return DANGEROUS_SHELL_TOKENS.some((token) => command.includes(token));
}

type Verdict = "allow" | "ask" | "deny";

/** Kiro's permission outcome for one command. `ask` becomes a hard refusal when
 *  the session has no interactive or ACP approver; `deny` cannot be approved. */
function evaluate(eb: ExecuteBash, command: string): Verdict {
  const denied = (eb.deniedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);
  if (denied.some((r) => r.test(command))) return "deny";

  if (hasDangerousShellSyntax(command)) return "ask";

  const allowed = (eb.allowedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);
  return allowed.some((r) => r.test(command)) ? "allow" : "ask";
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

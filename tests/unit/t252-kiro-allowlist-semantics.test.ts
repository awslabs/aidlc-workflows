// covers: file:settings.json
//
// t252-kiro-allowlist-semantics: the shipped Kiro `execute_bash` permission
// patterns are asserted BEHAVIOURALLY, by re-implementing Kiro's own matcher
// and running real command strings through it — not by pinning literal regex
// text. A literal-string assertion cannot tell a working pattern from an inert
// one, which is exactly how the Kiro IDE's `\${?KIRO_PROJECT_DIR}?` spelling
// (unescaped braces = invalid regex, silently dropped) shipped dead.
//
// Mechanism = none: pure in-process reads of the shipped dist agent JSONs plus
// RegExp evaluation. No spawn, no LLM.
//
// The matcher contract below is transcribed from the upstream CLI
// (crates/chat-cli/src/cli/chat/tools/execute/mod.rs) and was re-verified live
// against kiro-cli 2.12.1:
//   - each pattern is wrapped `\A<pat>\z` — a FULL-STRING match, never a prefix
//     one (so an optional tail must be spelled `( .*)?`);
//   - an invalid allow pattern is silently DROPPED (`.filter(Result::is_ok)`),
//     so it neither allows nor denies — it is simply inert;
//   - `deniedCommands` is evaluated first and beats any allow;
//   - the installed 2.12.1 evaluates each `&&`/`;`/`|` segment SEPARATELY, so
//     an allowed `cd <dir>` does NOT authorize the rest of a chain.

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
      if (!/^\{\d+(,\d*)?\}/.test(rest)) return true;
    }
    if (chars[i] === "}") return true; // unescaped, unmatched close
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

/** Split on the separators 2.12.1 evaluates independently. Quote-aware: a `;`
 *  or `&&` INSIDE a quoted argument is argument text, not a separator (verified
 *  live — `... --text "a; b && c"` runs unprompted under an allow match). */
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
    if (ch === ";" || ch === "|") {
      // `||` and `|` both separate
      if (ch === "|" && command[i + 1] === "|") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

type Verdict = "allow" | "gated";

/** Kiro's decision for a command under one agent's settings. "gated" means it
 *  needs interactive approval (or is refused outright when none is available —
 *  the `--no-interactive` / unanswered-ACP case that stalls a workflow). */
function evaluate(eb: ExecuteBash, command: string): Verdict {
  const denied = (eb.deniedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);
  if (denied.some((r) => r.test(command))) return "gated";

  const allowed = (eb.allowedCommands ?? [])
    .map(compile)
    .filter((r): r is RegExp => r !== null);
  const segs = segments(command);
  if (segs.length === 0) return "gated";
  return segs.every((s) => allowed.some((r) => r.test(s))) ? "allow" : "gated";
}

// Command forms the framework's own prose/engine actually emits, which MUST run
// unprompted or a workflow stalls mid-stage with no approver.
const MUST_ALLOW = [
  "bun .kiro/tools/aidlc-orchestrate.ts next --status",
  "bun .kiro/tools/aidlc-orchestrate.ts report --stage intent-capture --result approved",
  "bun .kiro/tools/aidlc-utility.ts status",
  "bun .kiro/tools/aidlc-state.ts get",
  'bun .kiro/tools/aidlc-log.ts decision --text "a; b && c"',
  "bun run .kiro/tools/aidlc-version.ts",
  'bun ".kiro/tools/aidlc-version.ts"',
  // Assembled rather than written literally: a bare "${...}" in a plain string
  // trips biome's noTemplateCurlyInString, and the shell text must stay exact.
  `bun $${"{"}KIRO_PROJECT_DIR}/.kiro/tools/aidlc-orchestrate.ts next`,
  "bun $KIRO_PROJECT_DIR/.kiro/tools/aidlc-orchestrate.ts next",
  "cd /home/u/src/proj && bun .kiro/tools/aidlc-orchestrate.ts next",
  "date -u",
  "date -u +%Y-%m-%dT%H:%M:%SZ",
];

// Forms that must NOT be pre-approved. The traversal case is the security one:
// the pre-2.5.16 `bun \.kiro/tools/.*` swallowed `../` and ran anything.
const MUST_GATE = [
  "bun .kiro/tools/../../outside-tool.ts",
  "bun .kiro/tools/../../../etc/evil.ts",
  "curl -s https://example.com",
  "cd /tmp && curl -s https://example.com",
  "cd /tmp && rm -f important.txt",
  "echo hello",
  "git push origin main",
  "git push",
  "rm -rf /",
  "rm -rf ~/work",
  "rm -rf *",
  "rm -fr build",
];

describe("t252 Kiro execute_bash allowlist semantics", () => {
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

    test(`${harness}: traversal and out-of-scope commands stay gated`, () => {
      for (const agent of agents) {
        const eb = execBash(harness, agent);
        for (const cmd of MUST_GATE) {
          expect(evaluate(eb, cmd), `${harness}/${agent}: should gate \`${cmd}\``)
            .toBe("gated");
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

    test(`${harness}: personas carry the conductor's shell surface`, () => {
      // A delegated persona runs the same tools from the same cwd; a narrower
      // list denied it mid-stage (pre-2.5.16 the personas lacked the
      // KIRO_PROJECT_DIR, absolute-path, and cd forms entirely).
      const conductor = execBash(harness, "aidlc.json").allowedCommands ?? [];
      for (const agent of PERSONAS) {
        expect(execBash(harness, agent).allowedCommands ?? [], agent)
          .toEqual(conductor);
      }
    });
  }
});

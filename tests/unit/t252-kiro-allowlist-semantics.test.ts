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

const HARNESSES = ["kiro"] as const;

const PERSONAS = [
  "aidlc-architect-agent.md",
  "aidlc-architecture-reviewer-agent.md",
  "aidlc-aws-platform-agent.md",
  "aidlc-compliance-agent.md",
  "aidlc-composer-agent.md",
  "aidlc-delivery-agent.md",
  "aidlc-design-agent.md",
  "aidlc-developer-agent.md",
  "aidlc-devsecops-agent.md",
  "aidlc-operations-agent.md",
  "aidlc-pipeline-deploy-agent.md",
  "aidlc-product-agent.md",
  "aidlc-product-lead-agent.md",
  "aidlc-quality-agent.md",
];

// 🔴 REMOVED HERE: the 2.x evaluation apparatus — an `ExecuteBash` reader, a Rust-regex
// validity shim, a segment splitter, a `TAIL_METACHARACTERS` gate, an `evaluate()` that
// produced allow/ask/deny, and four case lists (`MUST_ALLOW` 9, `MUST_ASK` 19,
// `MUST_DENY` 12, `MUST_ALLOW_CHAINS` 2).
//
// It evaluated commands against the `toolsSettings.execute_bash` regexes the personas
// used to carry. Those fields are gone, because they were measured INERT: Kiro applies no
// V2-to-V3 projection to a Markdown agent, and on the engine this row pins
// (`chat.agentEngine: "v3"`) a dispatched persona was PROMPTED for a command its own
// `deniedCommands` matched — an ask where a deny was configured, and `deny` has no
// approval path, so the field was never read.
//
// Where each part went, and what is now covered by nothing:
//
//   the four tail-metacharacter cases   -> tests/unit/t218, executed against the real
//     adapter. Its comment recorded them as "verified live on 2.12.1"; on v3 all four
//     were measured RUNNING UNPROMPTED, so that gate is gone from the platform and the
//     cases are now regression vectors for the adapter's own boundary instead.
//   traversal and out-of-scope paths    -> tests/unit/t218 as REFUSALS, which is
//     stronger than the `ask` this file asserted.
//   the MUST_ALLOW floor               -> tests/unit/t218's PERMITTED list, as real
//     shipped tools through three invocation forms.
//   the destructive cases              -> asserted DECLARATIVELY below (the patterns are
//     present) rather than behaviourally. A glob matcher cannot be reimplemented here
//     honestly; measurement showed `*` crosses a path separator and `..` is not
//     canonicalized, neither of which a hand-rolled matcher would have predicted.
//   "an unrelated command still prompts" -> NOT covered by any test. It was never
//     testable here either: the verdict belongs to the platform's matcher, and the
//     conductor test below already says that reimplementing it would be a guess. What
//     IS pinned is that the adapter leaves such a command alone (t218's UNRELATED list).

// Agent configs ship as Markdown, so the grant model lives in the frontmatter block.
//
// NOT because frontmatter and a JSON config are equivalent — that was this suite's old
// premise and it is false on the engine this row pins. Measured on IDE 1.x: Kiro applies
// no V2-to-V3 projection to a MARKDOWN agent, so a 2.x field in frontmatter is inert
// where the same field in a `.json` agent is still translated. The rules read here are
// 3.0 `permissions`, which both formats honour.
export function agentFrontmatter(harness: string, agentFile: string): Record<string, unknown> {
  const p = join(REPO_ROOT, "dist", harness, ".kiro", "agents", agentFile);
  const block = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(p, "utf-8"));
  if (block === null) throw new Error(`${harness}/${agentFile}: no frontmatter`);
  return Bun.YAML.parse(block[1]) as Record<string, unknown>;
}

interface PermissionRule {
  capability?: string;
  effect?: string;
  match?: string[];
  exclude?: string[];
}

// The 3.0 grant model. Replaces `execBash` below, which read the 2.x
// `toolsSettings.execute_bash` block: measured on IDE 1.x, a MARKDOWN agent receives no
// V2-to-V3 projection, so on the engine this row pins those fields were inert.
function permissionRules(harness: string, agentFile: string): PermissionRule[] {
  const doc = agentFrontmatter(harness, agentFile) as {
    permissions?: { rules?: PermissionRule[] };
  };
  const rules = doc.permissions?.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error(`${harness}/${agentFile}: no permissions.rules`);
  }
  return rules;
}


describe("t252 Kiro shell and write policy, as declared", () => {
  for (const harness of HARNESSES) {
    // 🔴 The behavioural vectors this file used to run against the personas are gone, and
    // that is a deliberate loss recorded rather than a deletion — the header above says
    // where each one went and what is now covered by nothing.
    //
    // They were evaluated by this file's own `evaluate()` against the 2.x
    // `toolsSettings.execute_bash` regexes the personas used to carry. Those fields are
    // gone: measured on IDE 1.x, Kiro applies no V2-to-V3 projection to a MARKDOWN agent,
    // so on the engine this row pins (`chat.agentEngine: "v3"`) they were inert - a
    // dispatched persona was PROMPTED for a command its own `deniedCommands` matched, and
    // `deny` has no approval path, which is proof the field was never read.
    //
    // The 3.0 replacement is globs, and this suite must NOT reimplement a glob matcher:
    // the comment at the conductor test below already says why, and measurement proved the
    // point - a glob's `*` crosses a path separator and `..` is not canonicalized first,
    // neither of which a hand-rolled matcher would have predicted.
    //
    // So the vectors moved to tests/unit/t218-kiro-hook-adapter-channel.test.ts, where
    // they are executed against the REAL adapter through its own hook route instead of
    // against a model of the platform. That is strictly stronger evidence, and it is where
    // the two layers that now carry the boundary are testable: the composition lexer and
    // the shipped-tool enumeration.
    //
    // What remains here is what only a config test can see: that every persona declares
    // the same policy, in the 3.0 vocabulary, with no legacy field left behind pretending
    // to protect anything.
    const agents = PERSONAS;

    test(`${harness}: no persona carries an inert 2.x grant field`, () => {
      for (const agent of agents) {
        const doc = agentFrontmatter(harness, agent);
        for (const field of ["toolsSettings", "allowedTools", "disallowedTools"]) {
          expect(
            Object.hasOwn(doc, field),
            `${harness}/${agent}: ${field} is not read on the pinned engine, and shipping it claims protection that does not exist`,
          ).toBe(false);
        }
      }
    });

    test(`${harness}: every persona declares shell rules in the 3.0 vocabulary`, () => {
      for (const agent of agents) {
        const rules = permissionRules(harness, agent);
        const shell = rules.filter((r) => r.capability === "shell");
        expect(shell.map((r) => r.effect).sort(), `${harness}/${agent}`)
          .toEqual(["allow", "deny"]);
        for (const rule of shell) {
          expect((rule.match ?? []).length, `${harness}/${agent}: ${rule.effect} has no patterns`)
            .toBeGreaterThan(0);
        }
      }
    });

    test(`${harness}: the two operations this framework must never run unattended are denied`, () => {
      for (const agent of agents) {
        const deny = permissionRules(harness, agent)
          .filter((r) => r.capability === "shell" && r.effect === "deny")
          .flatMap((r) => r.match ?? []);
        // Deny is a floor, not the containment: `rm` and `git push` match no allow
        // pattern, so they would prompt on the strength of the allow list alone. What
        // deny adds is removing the human's ability to approve them.
        expect(deny.some((p) => p.startsWith("rm -")), `${harness}/${agent}: recursive rm`)
          .toBe(true);
        expect(deny.some((p) => p.includes("git push")), `${harness}/${agent}: git push`)
          .toBe(true);
      }
    });

    test(`${harness}: a persona's write scope is enforced by a deny, not only by an allow`, () => {
      for (const agent of agents) {
        const writes = permissionRules(harness, agent)
          .filter((r) => r.capability === "fs_write");
        const deny = writes.find((r) => r.effect === "deny");
        // An unmatched capability defaults to ASK in 3.0, where the 2.x
        // `fs_write.allowedPaths` refused outright. Preserving the scope therefore needs
        // a deny with the permitted paths excluded - `exclude` carving an exception out
        // of a deny was measured working on IDE 1.x.
        expect(deny?.match, `${harness}/${agent}: write scope must be a deny over everything`)
          .toEqual(["**"]);
        expect((deny?.exclude ?? []).length, `${harness}/${agent}: deny must exclude the write paths`)
          .toBeGreaterThan(0);
        const allow = writes.find((r) => r.effect === "allow");
        // And where a persona also pre-approves its writes, the allow must name exactly
        // the excluded paths, or the two drift into a deny that outlaws what the allow
        // permits.
        if (allow) expect(allow.match, `${harness}/${agent}`).toEqual(deny?.exclude);
      }
    });

    test(`${harness}: an MCP call still prompts`, () => {
      for (const agent of agents) {
        const mcp = permissionRules(harness, agent)
          .filter((r) => r.capability === "mcp" || r.capability === "all");
        expect(mcp, `${harness}/${agent}: an allow here would pre-approve every MCP server`)
          .toEqual([]);
      }
    });

    test(`${harness}: no allow pattern ends in a wildcard except a bounded argument tail`, () => {
      for (const agent of agents) {
        const allow = permissionRules(harness, agent)
          .filter((r) => r.capability === "shell" && r.effect === "allow")
          .flatMap((r) => r.match ?? []);
        for (const pattern of allow) {
          if (!pattern.endsWith("*")) continue;
          // A trailing `* ` is only acceptable when a SPACE precedes it: the wildcard is
          // then an argument tail on a fully named command, not an open extension of the
          // command itself. `date -u*` would be the bad shape; `… aidlc*.ts *` is fine.
          // The composition lexer refuses what such a tail could otherwise smuggle.
          expect(
            pattern.endsWith(" *") || pattern.endsWith(".ts"),
            `${harness}/${agent}: ${pattern} extends the command, not its arguments`,
          ).toBe(true);
        }
      }
    });

    test(`${harness}: the engine's own session state is outside every persona's write scope`, () => {
      // F1's other half. The delegation ledger and its sibling WITNESS live under
      // `aidlc/.aidlc-sessions/`, and the witness is what lets the adapter tell a tampered
      // session from a fresh one. A delegate that could write there could erase the record
      // that it was ever dispatched. Kiro documents that ALL write tools — `fs_write`,
      // `fs_append`, `str_replace`, `delete_file` — respect `fs_write` capability rules, so
      // this one rule covers deletion too.
      //
      // 🔴 The first version of this test compared exclude STRINGS against three prefixes.
      // A second reader pointed out that lexical prefixes cannot prove a glob does not
      // MATCH a path, and on this engine `*` crosses `/` — so an exclude could satisfy
      // every prefix check and still cover the ledger. The check is now semantic.
      //
      // It does NOT reimplement Kiro's matcher. It OVER-approximates it: every `*` or `**`
      // is read as "any run of characters, slashes included", which is the widest reading
      // and the one measured for shell patterns. If no exclude can match the concrete paths
      // even under the widest reading, none can under a narrower one. A glob shape this
      // reading cannot bound — a character class or a brace set — fails the test outright
      // rather than being guessed at; none ships today.
      //
      // Measured, and closed: `fs_write` path matching DOES canonicalize a `..` segment,
      // unlike shell pattern matching. On Kiro IDE 1.x a probe agent carrying exactly the
      // persona shape (deny `**`, exclude and allow `aidlc/spaces/**`) was asked to write
      // `aidlc/spaces/../probe-traversal.md` and `aidlc/spaces/default/../../x.md`. The
      // session transcript shows the tool received both paths VERBATIM, `..` intact, and
      // also carried a separate `resource` field holding the normalized path
      // (`aidlc/probe-traversal.md`, `aidlc/x.md`). Both writes were refused with
      // `deny fs_write matching "**"`, and neither file exists at its resolved location.
      // So the matcher judges the canonical resource, not the spelling — a traversal inside
      // an excluded tree does not inherit the exclude. The targets below are canonical for
      // the same reason.
      const key = "0".repeat(64);
      const targets = [
        `aidlc/.aidlc-sessions/kiro-delegation/${key}/windows.ndjson`,
        `aidlc/.aidlc-sessions/kiro-delegation/${key}`,
        "aidlc/.aidlc-sessions/kiro-delegation",
        `aidlc/.aidlc-sessions/kiro-delegation-witness/${key}`,
        "aidlc/.aidlc-sessions/kiro-delegation-witness",
        "aidlc/.aidlc-sessions",
      ];
      const widest = (glob: string): RegExp | null => {
        if (/[[\]{}]/.test(glob)) return null;
        const body = glob
          .split(/\*+/)
          .map((part) => part.replace(/[.+?^$()|\\]/g, "\\$&"))
          .join(".*");
        return new RegExp(`^${body}$`);
      };
      for (const agent of agents) {
        const excluded = permissionRules(harness, agent)
          .filter((r) => r.capability === "fs_write" && r.effect === "deny")
          .flatMap((r) => r.exclude ?? []);
        expect(excluded.length, `${harness}/${agent}: nothing excluded`).toBeGreaterThan(0);
        for (const glob of excluded) {
          const re = widest(glob);
          expect(re, `${harness}/${agent}: ${glob} is a shape this check cannot bound`)
            .not.toBeNull();
          for (const target of targets) {
            expect(
              re?.test(target),
              `${harness}/${agent}: exclude ${glob} can cover ${target}, opening the engine's session state to a delegate`,
            ).toBe(false);
          }
        }
      }
    });

    test(`${harness}: every persona carries the same shell policy`, () => {
      const first = permissionRules(harness, PERSONAS[0])
        .filter((r) => r.capability === "shell");
      for (const agent of PERSONAS) {
        expect(
          permissionRules(harness, agent).filter((r) => r.capability === "shell"),
          agent,
        ).toEqual(first);
      }
    });

    // The conductor states the same policy in the capability vocabulary
    // (`permissions.rules`) rather than the tool-settings one, because that is
    // the form its file shipped with before the two Kiro rows merged; both are
    // honoured (agent configs are backward-compatible — Custom agents, "Previous
    // versions"). Asserted as the DECLARED policy: re-implementing Kiro's glob
    // matcher here would be a guess, and this suite exists because an
    // unverifiable pattern is how a dead grant ships.
    test(`${harness}: the conductor grants one route namespace plus exact timestamps, and denies the same two`, () => {
      const doc = agentFrontmatter(harness, "aidlc.md") as {
        permissions?: {
          rules?: Array<{
            capability?: string;
            effect?: string;
            match?: string[];
          }>;
        };
      };
      const shell = (doc.permissions?.rules ?? []).filter(
        (rule) => rule.capability === "shell",
      );
      const matches = (effect: string) =>
        shell.filter((rule) => rule.effect === effect).flatMap((rule) => rule.match ?? []);
      // ONE entrypoint plus a route namespace. A glob over the projected tools directory
      // used to sit beside the dispatcher; it granted execution over a path the PROJECT
      // can write, so a repository could add a matching script and have it pre-approved -
      // which is how relayed repository text reached execution without a second approval.
      // Scoped to `engine` so the trusted boundary is the one the native channel draws.
      expect(matches("allow")).toEqual([
        "bun .kiro/tools/aidlc.ts engine *",
        "date -u",
        'date -u +"%Y-%m-%dT%H:%M:%SZ"',
        "date -u +'%Y-%m-%dT%H:%M:%SZ'",
        "date -u +%Y-%m-%dT%H:%M:%SZ",
      ]);
      expect(matches("allow").some((m) => m.includes("aidlc-*"))).toBe(false);
      // No allow pattern may end in a wildcard, with ONE audited exception. A trailing `*`
      // matched any tail, and on v3 the platform no longer gates the metacharacters a tail
      // can carry: substitution, backticks and redirection were each measured running
      // unprompted, and the redirection wrote a file outside the filesystem rules.
      //
      // The dispatcher line is exempted here because the route namespace is a grant this
      // row must keep, NOT because it is safe: `engine ` ending in a space only stops a
      // tail from beginning mid-token, and `… engine status > file` both matches the
      // pattern and carries a redirection - measured. So this exception is precisely the
      // hole a PreToolUse shell boundary has to close, and the boundary cannot live in the
      // patterns alone. `docs/reference/06-hooks-and-tools.md` already states the
      // underlying reason: a mutation delivered as a shell command is invisible to the
      // Write/Edit hook path, which is why the review freeze parses redirection targets
      // out of the command itself.
      for (const pattern of matches("allow")) {
        if (pattern === "bun .kiro/tools/aidlc.ts engine *") continue;
        expect(pattern.endsWith("*")).toBe(false);
      }
      expect(matches("deny")).toEqual(["rm -rf *", "git push *"]);
    });
  }
});

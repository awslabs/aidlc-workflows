// covers: function:escapeRegex
//
// t109 — escapeRegex(str) round-trip property test (P0 deterministic floor).
//
// Unit under test: escapeRegex in dist/claude/.claude/tools/aidlc-lib.ts:1540
//   export function escapeRegex(str: string): string {
//     return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//   }
//
// This fn is security-relevant: the CLI arg parser builds RegExp patterns
// from caller-supplied tokens, and any metacharacter that survives unescaped
// becomes an injection vector (a "." matching any char, a "(" opening a
// capture group, a "\" forming an escape that breaks the pattern, etc.).
//
// Test design note (house style — see tests/unit/t69-worktree-path.sh):
// these assertions do NOT reimplement the escaping (no parity against our own
// String.replace). A parity test only catches deletion of the function. We
// assert the OBSERVABLE CONTRACT instead — the two properties any correct
// regex-escaper must satisfy, regardless of how it's written:
//
//   P1 (round-trip identity): for any string s, the escaped form, compiled as
//       a whole pattern, matches s exactly. new RegExp(escapeRegex(s)).test(s)
//       === true. A regression that drops escaping for some metachar breaks
//       this the instant that metachar appears in s (e.g. "(" alone is an
//       unterminated group → RegExp throws or fails to match).
//
//   P2 (literal, never metachar): the escaped form embedded inside a LARGER
//       anchored pattern must match s as a literal substring and must NOT
//       match a string that only a metacharacter interpretation would match.
//       escapeRegex("a.b") must match "a.b" and must NOT match "axb"; if the
//       "." leaks through unescaped it matches "axb" and this fails. This is
//       the property that actually defends the arg parser.
//
// The generated corpus deliberately includes every metacharacter the source
// class lists ( . * + ? ^ $ { } ( ) | [ ] \ ) individually, in adjacency, and
// interleaved with ordinary text, so a regression that forgets any single one
// is caught.

import { describe, expect, test } from "bun:test";
import { escapeRegex } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// Every metacharacter the source character class escapes, verbatim:
//   /[.*+?^${}()|[\]\\]/  ->  . * + ? ^ $ { } ( ) | [ ] \
const METACHARS = [
  ".",
  "*",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
];

// A deterministic, hand-curated corpus that stands in for property generation.
// (bun:test has no built-in fuzz generator; a fixed seed-free corpus that
// covers the metachar space exhaustively is both deterministic — required for
// the "none / zero-token" floor — and as strong as random generation for a fn
// whose only branching is "is this char in the class".)
function buildCorpus(): string[] {
  const corpus: string[] = [];

  // 1. Each metachar in isolation.
  for (const m of METACHARS) corpus.push(m);

  // 2. Each metachar wrapped in ordinary text (the "literal between words" case).
  for (const m of METACHARS) corpus.push(`a${m}b`);

  // 3. Each metachar doubled (adjacency — catches greedy-quantifier and
  //    bracket-class edge cases like "**", "??", "[]", "{}", "\\\\").
  for (const m of METACHARS) corpus.push(`${m}${m}`);

  // 4. Every metachar concatenated, forward and reversed, plus a "kitchen sink"
  //    interleaved with text. These are the strings most likely to form an
  //    accidentally-valid (and wrong) pattern if any escaping leaks.
  const allMeta = METACHARS.join("");
  corpus.push(allMeta);
  corpus.push([...METACHARS].reverse().join(""));
  corpus.push(`pre${allMeta}post`);
  corpus.push("a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o");

  // 5. Realistic CLI-arg-shaped inputs (the actual threat surface).
  corpus.push("file.name.ext");
  corpus.push("v1.2.3");
  corpus.push("--flag=value");
  corpus.push("a|b|c");
  corpus.push("C:\\path\\to\\thing");
  corpus.push("$HOME/.config");
  corpus.push("re(group)+?");
  corpus.push("[abc]{1,3}");
  corpus.push(".*"); // the canonical "match anything" injection
  corpus.push("^anchored$");

  // 6. Strings with NO metacharacters — escaping must be a no-op for matching
  //    and must not corrupt the literal.
  corpus.push("plain");
  corpus.push("with space");
  corpus.push("CamelCase123");
  corpus.push("hyphen-and_underscore");

  // 7. Empty string — degenerate but legal input; new RegExp("") matches "".
  corpus.push("");

  return corpus;
}

const CORPUS = buildCorpus();

describe("escapeRegex — round-trip identity (P1)", () => {
  test("new RegExp(escapeRegex(s)) compiles and matches s for every corpus string", () => {
    for (const s of CORPUS) {
      // Compiling must never throw — an unescaped metachar (e.g. a lone "(")
      // would make this an invalid pattern and throw SyntaxError.
      let re: RegExp;
      expect(() => {
        re = new RegExp(escapeRegex(s));
      }).not.toThrow();
      // @ts-expect-error re is assigned above if no throw
      expect(re.test(s)).toBe(true);
    }
  });

  test("anchored whole-string round-trip: ^escapeRegex(s)$ matches exactly s", () => {
    for (const s of CORPUS) {
      const re = new RegExp(`^${escapeRegex(s)}$`);
      expect(re.test(s)).toBe(true);
      // The match consumes the entire input, confirming nothing was treated
      // as a zero-width or wildcard token that would let the anchors slip.
      const m = s.match(re);
      expect(m).not.toBeNull();
      expect(m![0]).toBe(s);
    }
  });
});

describe("escapeRegex — escaped form is a literal, never a metachar (P2)", () => {
  test('escapeRegex("a.b") matches "a.b" but NOT "axb"', () => {
    const re = new RegExp(`^${escapeRegex("a.b")}$`);
    expect(re.test("a.b")).toBe(true);
    // If "." leaked unescaped it would match the wildcard "axb". It must not.
    expect(re.test("axb")).toBe(false);
  });

  test('".*" is escaped to a literal — must not match an arbitrary string', () => {
    // The canonical regex-injection payload. Escaped, it matches only ".*".
    const re = new RegExp(`^${escapeRegex(".*")}$`);
    expect(re.test(".*")).toBe(true);
    expect(re.test("anything")).toBe(false);
    expect(re.test("")).toBe(false);
  });

  test('"^anchored$" anchors are neutralised — matched only as literal chars', () => {
    const re = new RegExp(`^${escapeRegex("^anchored$")}$`);
    expect(re.test("^anchored$")).toBe(true);
    // Without escaping, the inner ^...$ would let "anchored" match too.
    expect(re.test("anchored")).toBe(false);
  });

  test('quantifiers/groups are neutralised: "ab+" matches "ab+", not "abbb"', () => {
    const re = new RegExp(`^${escapeRegex("ab+")}$`);
    expect(re.test("ab+")).toBe(true);
    expect(re.test("abbb")).toBe(false);
  });

  test('alternation is neutralised: "a|b" matches "a|b", not "a" or "b"', () => {
    const re = new RegExp(`^${escapeRegex("a|b")}$`);
    expect(re.test("a|b")).toBe(true);
    expect(re.test("a")).toBe(false);
    expect(re.test("b")).toBe(false);
  });

  test('every metachar, when escaped and embedded, matches only its own literal', () => {
    // For each metacharacter, build a haystack "X<m>Y" and a needle pattern
    // from escapeRegex of that exact string. It must match the literal and
    // must reject a string where <m> is replaced by a different char "Z" —
    // proving the metachar was treated as a literal, not a wildcard/operator.
    for (const m of METACHARS) {
      const literal = `X${m}Y`;
      const re = new RegExp(`^${escapeRegex(literal)}$`);
      expect(re.test(literal)).toBe(true);
      // "XZY" differs from "X<m>Y" only at the metachar position. The only way
      // it could match is if <m> were interpreted as a wildcard — which it
      // must not be. (For "^" / "$", "XZY" simply isn't the literal either.)
      expect(re.test("XZY")).toBe(false);
    }
  });
});

describe("escapeRegex — embedded substring search (the arg-parser threat surface)", () => {
  test("escaped token finds its literal occurrence inside a larger haystack", () => {
    // Mirrors how the CLI arg parser uses it: build a search pattern from a
    // user token and run it against a bigger string. The token must match
    // where it literally appears and nowhere a metachar reading would invent.
    const cases: Array<{ token: string; haystack: string; expect: boolean }> = [
      { token: "v1.2.3", haystack: "version v1.2.3 released", expect: true },
      { token: "v1.2.3", haystack: "version v1X2Y3 released", expect: false }, // dots are literal
      { token: "a*", haystack: "found a* here", expect: true },
      { token: "a*", haystack: "found aaaa here", expect: false }, // * is literal
      { token: "$HOME", haystack: "echo $HOME now", expect: true },
      { token: "(x)", haystack: "call (x) once", expect: true },
      { token: "(x)", haystack: "call x once", expect: false }, // parens are literal
    ];
    for (const c of cases) {
      const re = new RegExp(escapeRegex(c.token));
      expect(re.test(c.haystack)).toBe(c.expect);
    }
  });

  test("backslash is escaped so Windows-style paths round-trip as literals", () => {
    const token = "C:\\path\\to\\thing";
    const re = new RegExp(`^${escapeRegex(token)}$`);
    expect(re.test(token)).toBe(true);
    // A leaked backslash could form "\\p" / "\\t" escapes that change meaning;
    // the literal forward-slash variant must NOT match.
    expect(re.test("C:/path/to/thing")).toBe(false);
  });
});

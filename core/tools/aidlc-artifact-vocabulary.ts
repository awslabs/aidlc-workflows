/**
 * Dependency-free artifact vocabulary shared by library and runtime resolvers.
 * Keep wire-name to filename exceptions here so artifact guards, directives,
 * sensors, and validity receipts always name the same physical file.
 */
const ARTIFACT_FILENAMES: Readonly<Record<string, string>> = {
  "build-test-results": "test-results.md",
  "load-test-results": "test-results.md",
  traceability: "traceability.json",
};

export function artifactFilename(name: string): string {
  return ARTIFACT_FILENAMES[name] ?? `${name}.md`;
}

/** Stages whose produced artifacts live in the space-level code knowledge base. */
export const KNOWN_CODEKB_STAGES: ReadonlySet<string> = new Set([
  "reverse-engineering",
]);

// A run of fully-qualified emoji, optionally ZWJ-joined, then whitespace is
// decoration, so an information-sign emoji before `Sources` still names the
// `Sources` section. A bare text-presentation symbol (copyright, trademark, a
// play triangle) is not decoration. The claim-sources sensor and the summary
// confirmation digest both read contract headings through this one rule.
const LEADING_EMOJI_DECORATION = /^\p{RGI_Emoji}(?:\u200D?\p{RGI_Emoji})*[ \t]+/v;

/** The section name a contract heading gives, read past a leading emoji decoration. */
export function headingKey(heading: string): string {
  return heading.replace(LEADING_EMOJI_DECORATION, "").trim();
}

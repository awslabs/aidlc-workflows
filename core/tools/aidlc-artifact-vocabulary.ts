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

// One flat lowercase file per artifact under memory/templates/ (a space's, or
// a plugin's to ship): the stem is the artifact the required-sections sensor
// keys the template by. The plugin memory reader and the plugin validator both
// read template-name legality through this one rule.
export const TEMPLATE_FILE_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

// A run of fully-qualified emoji, optionally ZWJ-joined, then whitespace is
// decoration, so an information-sign emoji before `Sources` still names the
// `Sources` section. A bare text-presentation symbol (copyright, trademark, a
// play triangle) is not decoration. The claim-sources sensor, the
// required-sections sensor's template check and the summary confirmation
// digest all read contract headings through this one rule.
const LEADING_EMOJI_DECORATION = /^\p{RGI_Emoji}(?:\u200D?\p{RGI_Emoji})*[ \t]+/v;

export function headingKey(heading: string): string {
  return heading.replace(LEADING_EMOJI_DECORATION, "").trim();
}

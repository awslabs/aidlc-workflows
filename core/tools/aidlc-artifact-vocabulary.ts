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

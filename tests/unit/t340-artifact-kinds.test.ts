import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_KIND,
  artifactFilename,
  artifactFormat,
  artifactKind,
  setHtmlArtifactNames,
} from "../../core/tools/aidlc-artifact-vocabulary.ts";
import { parseStageFrontmatter } from "../../core/tools/aidlc-lib.ts";

const STAGES = join(import.meta.dir, "..", "..", "core", "aidlc-common", "stages");

function producedNames(): string[] {
  const names = new Set<string>();
  for (const phase of readdirSync(STAGES)) {
    const dir = join(STAGES, phase);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const parsed = parseStageFrontmatter(readFileSync(join(dir, file), "utf-8"));
      for (const name of [
        ...(parsed.produces as string[]),
        ...((parsed.optional_produces as string[] | undefined) ?? []),
      ]) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

afterEach(() => setHtmlArtifactNames(new Set()));

describe("artifact kind and format vocabulary", () => {
  test("classifies every artifact produced by the core stage set", () => {
    expect(producedNames().filter((name) => artifactKind(name) === null)).toEqual([]);
  });

  test("the table contains only known kinds", () => {
    expect(new Set(Object.values(ARTIFACT_KIND))).toEqual(
      new Set(["document", "visual", "machine"]),
    );
  });

  test("priming flips only selected artifact formats", () => {
    expect(artifactFormat("intent-statement")).toBe("md");
    setHtmlArtifactNames(new Set(["intent-statement"]));
    expect(artifactFormat("intent-statement")).toBe("html");
    expect(artifactFormat("intent-capture-questions")).toBe("md");
  });

  test("filename exceptions win over the selected format", () => {
    setHtmlArtifactNames(new Set(["traceability", "build-test-results", "intent-statement"]));
    expect(artifactFilename("traceability")).toBe("traceability.json");
    expect(artifactFilename("build-test-results")).toBe("test-results.md");
    expect(artifactFilename("intent-statement")).toBe("intent-statement.html");
  });
});

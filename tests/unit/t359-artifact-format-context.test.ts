// covers: function:MARKDOWN_ONLY function:artifactFilename function:artifactFormat function:artifactFormatsFromState function:artifactFormatsForProject function:readStateFile

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  resolveArtifactInstances,
  type ArtifactResolutionOptions,
} from "../../core/tools/aidlc-artifact-resolution.ts";
import {
  artifactFilename,
} from "../../core/tools/aidlc-artifact-vocabulary.ts";
import {
  artifactFormatsForProject,
  createIntent,
  readStateFile,
} from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const VOCABULARY = join(ROOT, "core", "tools", "aidlc-artifact-vocabulary.ts");
const FORMAT_RUNTIME_SOURCES = [
  VOCABULARY,
  join(ROOT, "core", "tools", "aidlc-lib.ts"),
  join(ROOT, "core", "tools", "aidlc-artifact-resolution.ts"),
];
const graphDir = mkdtempSync(join(tmpdir(), "aidlc-t359-"));
const graphPath = join(graphDir, "stage-graph.json");
const graph = JSON.parse(readFileSync(join(
  ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "stage-graph.json",
), "utf-8")) as Array<Record<string, unknown>>;
for (const stage of graph) {
  stage.html_capable = stage.slug === "intent-capture"
    ? ["intent-statement", "stakeholder-map"]
    : [];
}
writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);

const projects: string[] = [];
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  rmSync(graphDir, { recursive: true, force: true });
});

const owner = {
  slug: "intent-capture",
  phase: "ideation",
  produces: ["intent-statement"],
};

function withHtmlSetting(content: string, setting: "on" | "off"): string {
  return content.replace(
    /^(- \*\*Test Strategy\*\*:[^\n]*)$/m,
    `$1\n- **HTML Artifacts**: ${setting}`,
  );
}

function twoIntentProject(): {
  project: string;
  onState: string;
  offState: string;
  onRecord: string;
  offRecord: string;
} {
  const project = setupIntegrationProject({ withState: "state-mid-ideation.md" });
  projects.push(project);

  const onRecord = seededRecordDir(project);
  const onState = withHtmlSetting(readFileSync(seededStateFile(project), "utf-8"), "on");
  writeFileSync(seededStateFile(project), onState);

  const off = createIntent(project, "format-off", DEFAULT_SPACE, "feature");
  const offState = withHtmlSetting(readFileSync(join(ROOT, "tests", "fixtures", "state-mid-ideation.md"), "utf-8"), "off");
  writeFileSync(join(off.recordDir, "aidlc-state.md"), offState);

  return { project, onState, offState, onRecord, offRecord: off.recordDir };
}

function resolvedExtension(
  project: string,
  recordPath: string,
  options: ArtifactResolutionOptions,
): string {
  return resolveArtifactInstances(
    project,
    "intent-statement",
    owner,
    { recordPath, ...options },
  )[0].relativePath.split(".").at(-1) ?? "";
}

describe("immutable per-call artifact format context", () => {
  test("the vocabulary owns no mutable module format state or obsolete priming API", () => {
    const vocabulary = readFileSync(VOCABULARY, "utf-8");
    expect(vocabulary).not.toMatch(/^let /m);
    expect(vocabulary).not.toMatch(
      /^const\s+\w*[Ff]ormat\w*\s*=\s*new Set(?:<[^>]+>)?\s*\(/m,
    );
    expect(vocabulary).not.toMatch(/\.html\.(?:add|delete|clear)\s*\(/);

    const obsoleteGlobalApis = [
      ["set", "HtmlArtifactNames"].join(""),
      ["html", "ArtifactNames"].join(""),
      ["prime", "ArtifactFormats"].join(""),
    ];
    const runtimeSources = FORMAT_RUNTIME_SOURCES
      .map((path) => readFileSync(path, "utf-8"))
      .join("\n");
    for (const name of obsoleteGlobalApis) expect(runtimeSources).not.toContain(name);
  });

  test("artifactFilename defaults to Markdown", () => {
    expect(artifactFilename("intent-statement")).toBe("intent-statement.md");
  });

  test("stateContent resolves two intents alternately without leaking extensions", () => {
    withEnvAndFreshCaches({ AIDLC_STAGE_GRAPH: graphPath }, () => {
      const { project, onState, offState, onRecord, offRecord } = twoIntentProject();
      expect(resolvedExtension(project, onRecord, { stateContent: onState })).toBe("html");
      expect(resolvedExtension(project, offRecord, { stateContent: offState })).toBe("md");
      expect(resolvedExtension(project, onRecord, { stateContent: onState })).toBe("html");
      expect(resolvedExtension(project, offRecord, { stateContent: offState })).toBe("md");
    });
  });

  test("project-derived contexts retain each intent's extension", () => {
    withEnvAndFreshCaches({ AIDLC_STAGE_GRAPH: graphPath }, () => {
      const { project, onRecord, offRecord } = twoIntentProject();
      const onFormats = artifactFormatsForProject(project, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
      const offFormats = artifactFormatsForProject(project, basename(offRecord), DEFAULT_SPACE);

      expect(resolvedExtension(project, offRecord, { formats: offFormats })).toBe("md");
      expect(resolvedExtension(project, onRecord, { formats: onFormats })).toBe("html");
      expect(resolvedExtension(project, offRecord, { formats: offFormats })).toBe("md");
      expect(artifactFilename("intent-statement", onFormats)).toBe("intent-statement.html");
      expect(resolvedExtension(project, onRecord, { formats: onFormats })).toBe("html");
      expect(artifactFilename("intent-statement", offFormats)).toBe("intent-statement.md");
    });
  });

  test("readStateFile has no side effect before resolving the off intent as Markdown", () => {
    withEnvAndFreshCaches({ AIDLC_STAGE_GRAPH: graphPath }, () => {
      const { project, onRecord, offRecord } = twoIntentProject();
      readStateFile(project, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
      expect(resolvedExtension(project, offRecord, {
        formats: artifactFormatsForProject(project, basename(offRecord), DEFAULT_SPACE),
      })).toBe("md");
      expect(resolvedExtension(project, onRecord, {
        formats: artifactFormatsForProject(project, DEFAULT_RECORD_DIR, DEFAULT_SPACE),
      })).toBe("html");
    });
  });
});

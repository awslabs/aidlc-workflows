// Releases 2.8.0 to 2.11.0 refresh a project from a newer release's files with
// this code, run over the newer release's /aidlc skill. Both parts are copied
// byte for byte from v2.11.0 core/tools/aidlc-init.ts, and each is the same on
// every tag from v2.8.0 (t-earlier-release-refresh-regions checks their
// hashes): replaceGeneratedRegion (:4553-4587) and the skill choice with its
// two calls (:6254-6270). The regions those releases render from the newer
// graph are stood in for below, in their shape.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAGE_TABLE = [
  "| Slug | # | Stage | Phase | Execution | Lead Agent | Support Agents | Mode |",
  "|------|---|-------|-------|-----------|------------|----------------|------|",
  "| requirements-analysis | 4 | Requirements Analysis | Inception | ALWAYS | aidlc-product-agent | aidlc-architect-agent | inline |",
].join("\n");
export const SCOPE_TABLE = [
  "| Scope          | Depth         | TestStrategy | EXECUTE / Total |",
  "|----------------|---------------|--------------|-----------------|",
  "| bugfix         | Minimal       | (default)    | 9 / 33          |",
].join("\n");
const renderStageTable = (): string => STAGE_TABLE;
const renderScopeTable = (): string => SCOPE_TABLE;
const canonicalStageTableRegion = (table: string): string =>
  `<!-- BEGIN: compiled stage graph via \`aidlc engine gen stage-table\` - do NOT hand-edit -->\n\n${table}\n\n<!-- END: compiled stage graph -->`;
const canonicalScopeTableRegion = (table: string): string =>
  `<!-- BEGIN: compiled scope grid via \`aidlc engine gen scope-table\` - do NOT hand-edit -->\n\n${table}\n\n<!-- END: compiled scope grid -->`;

function replaceGeneratedRegion(
  current: string,
  generated: string,
  kind: "stage" | "scope",
): string {
  const noun = kind === "stage" ? "stage graph" : "scope grid";
  const beginPrefix = `<!-- BEGIN: compiled ${noun} via `;
  const end = `<!-- END: compiled ${noun} -->`;
  const locate = (content: string): {
    begin: number;
    beginLineEnd: number;
    endStart: number;
    end: number;
  } => {
    const begin = content.indexOf(beginPrefix);
    const beginLineEnd = content.indexOf("-->", begin);
    const endAt = content.indexOf(end, beginLineEnd);
    if (begin < 0 || beginLineEnd < 0 || endAt < 0) {
      throw new Error(`SKILL.md is missing the compiled ${noun} region`);
    }
    return {
      begin,
      beginLineEnd: beginLineEnd + 3,
      endStart: endAt,
      end: endAt + end.length,
    };
  };
  const target = locate(current);
  const source = locate(generated);
  return `${current.slice(0, target.begin)}${
    current.slice(target.begin, target.beginLineEnd)
  }${generated.slice(source.beginLineEnd, source.endStart)}${
    current.slice(target.endStart, target.end)
  }${current.slice(target.end)}`;
}

// `root` holds the newer release's files; `stagedHarness` is its harness folder.
export function refreshSkill(root: string, stagedHarness: string): void {
  {
    const skillPath = existsSync(join(stagedHarness, "skills", "aidlc", "SKILL.md"))
      ? join(stagedHarness, "skills", "aidlc", "SKILL.md")
      : join(root, ".agents", "skills", "aidlc", "SKILL.md");
    if (existsSync(skillPath)) {
      let generated = readFileSync(skillPath, "utf-8");
      generated = replaceGeneratedRegion(
        generated,
        canonicalStageTableRegion(renderStageTable()),
        "stage",
      );
      generated = replaceGeneratedRegion(
        generated,
        canonicalScopeTableRegion(renderScopeTable()),
        "scope",
      );
      writeFileSync(skillPath, generated);
    }
  }
}

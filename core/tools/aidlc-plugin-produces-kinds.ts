// A plugin's output on a per-Unit stage needs a produces_kinds entry when the
// stage maps every required output: with no entry, the output applies to every
// Unit kind, which widens the stage past its review target and fails the
// compile. compose.ts,
// prepareRefreshSource (aidlc-init.ts) and rebuildPluginComposedStage (the
// Cursor installer) write the entry; stripRecordedAdds (aidlc-plugin.ts) and the
// same Cursor rebuild take it out with the output.

import { isPlainObject, parseStageFrontmatter, UNIT_KINDS } from "./aidlc-lib.ts";
import { applicableUnitKinds } from "./aidlc-stage-schema.ts";

// Give each output in `added` an entry listing the kinds the stage applies to,
// unless the stage applies to every kind. An output the stage also lists in
// optional_produces gets none: a strip could not tell that entry from one the
// stage ships, so it would outlive the plugin. An output in both produces and
// optional_produces does not count toward the kinds either: another plugin may
// have made it required.
export function addPluginProducesKinds(content: string, added: readonly string[]): string {
  if (added.length === 0) return content;
  const stage = parsedStage(content);
  if (stage === null || stage.for_each !== "unit-of-work" || !isPlainObject(stage.produces_kinds)) {
    return content;
  }
  const kindsByOutput = stage.produces_kinds;
  const produces = stringItems(stage.produces);
  const optional = new Set(stringItems(stage.optional_produces));
  const addedNames = new Set(added);
  const own = produces.filter((name) => !addedNames.has(name) && !optional.has(name));
  if (own.length === 0) return content;
  const applicable = applicableUnitKinds(own, kindsByOutput);
  // An entry that lists every kind is the same as no entry.
  if (UNIT_KINDS.every((kind) => applicable.has(kind))) return content;
  const kinds = UNIT_KINDS.filter((kind) => applicable.has(kind));
  const entries = added.filter((name) =>
    produces.includes(name) && !optional.has(name) && !Object.hasOwn(kindsByOutput, name)
  );
  if (kinds.length === 0 || entries.length === 0) return content;
  return editProducesKinds(content, (lines) => [
    ...lines,
    ...entries.map((name) => `  ${name}: [${kinds.join(", ")}]`),
  ]);
}

// Take out the entry of each output in `names` that the stage no longer lists
// in produces or optional_produces: an entry for an artifact the stage does not
// declare fails the schema.
export function removeOrphanProducesKinds(content: string, names: readonly string[]): string {
  if (names.length === 0) return content;
  const stage = parsedStage(content);
  if (stage === null) return content;
  const declared = new Set([...stringItems(stage.produces), ...stringItems(stage.optional_produces)]);
  const orphans = new Set(names.filter((name) => !declared.has(name)));
  if (orphans.size === 0) return content;
  return editProducesKinds(content, (lines) =>
    lines.filter((line) => !orphans.has(line.match(/^[ \t]+([a-z][a-z0-9-]*)/)?.[1] ?? ""))
  );
}

function parsedStage(content: string): Record<string, unknown> | null {
  try {
    return parseStageFrontmatter(content);
  } catch {
    return null;
  }
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Rewrite the entry lines of the frontmatter's produces_kinds block, read the
// way the stage parser reads it (mapOfListsField in aidlc-lib.ts): a header,
// then at least one indented `name: [kinds]` line. A stage without that block
// is left alone.
function editProducesKinds(content: string, edit: (lines: string[]) => string[]): string {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?\r?\n)---/);
  if (!frontmatter) return content;
  const start = frontmatter[0].indexOf("\n") + 1;
  const block = frontmatter[1].match(/^(produces_kinds:\s*\n)((?:[ \t]+[a-z][a-z0-9-]*\s*:\s*[^\n]*\n)+)/m);
  if (!block || block.index === undefined) return content;
  const lines = block[2].slice(0, -1).split("\n");
  const at = start + block.index;
  return content.slice(0, at) + block[1] + edit(lines).map((line) => `${line}\n`).join("") +
    content.slice(at + block[0].length);
}

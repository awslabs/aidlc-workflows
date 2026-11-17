// covers: file:core/aidlc-common/stages/inception/reverse-engineering.md, file:core/knowledge/aidlc-developer-agent/re-artifacts.md
//
// In live golden-bugfix runs on Claude Code the Reverse Engineering helper read AI-DLC's record by shell for three
// facts the engine knows: which record and intent it works in (`cat aidlc/spaces/.../intents.json`, `active-intent`),
// where the candidate is staged, and what is staged there (`ls <record>/.aidlc-engine/codekb-stage-<repo>/` after
// writing, to check the nine files). On Windows those reads came cd-prefixed with pipes, and Claude Code asked the
// person to allow them. `engine workspace codekb --json` now prints all three (record, intent, stage, staged; pinned
// in t-workspace-repo-folder-name), and these are the prose halves: the stage and the developer's template name that
// command for each fact, including the check after writing. Without them the tool's new fields are never read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8").replace(/\s+/g, " ");
const COMMAND = "`{{INVOKE}} engine workspace codekb --repo <repo> --json`";

describe("the Reverse Engineering helper is handed its record and staging folder by the engine", () => {
  test("the stage names the command for the staging folder, what is staged, the record and the intent", () => {
    const stage = read(join("core", "aidlc-common", "stages", "inception", "reverse-engineering.md"));
    expect(stage).toContain(
      `${COMMAND} prints that directory as \`stage\`, the files already in it as \`staged\`, and the active record and its intent's slug as \`record\` and \`intent\`.`,
    );
    expect(stage).toContain("Once the candidate is written, run it again: `staged` must list exactly the nine names.");
    expect(stage).toContain(`- Pass ${COMMAND} for the staging directory (\`stage\`), what is staged in it (\`staged\`) and the intent's slug (\`intent\`)`);
  });

  test("the developer's template takes the intent and the staging folder from the same command", () => {
    const template = read(join("core", "knowledge", "aidlc-developer-agent", "re-artifacts.md"));
    expect(template).toContain(`write the \`intent\` that ${COMMAND} prints.`);
    expect(template).not.toContain("intent's `slug` from `intents.json`");
    expect(template).toContain(
      "the `stage` that the same command prints; run it again once they are written, and its `staged` must list exactly the nine names.",
    );
  });
});

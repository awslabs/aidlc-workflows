// covers: file:aidlc-common/protocols/stage-protocol-summary.md, file:aidlc-common/stages/inception/requirements-analysis.md
//
// The summary confirmation before a stage writes its documents has one owner:
// stage-protocol-summary.md, which the engine names when the confirmation is on
// (ceremonyNote in aidlc-directive.ts). Requirements Analysis carried its own
// copy of that stop, with its own prompt and commands and without the decision
// brief the module prints or its feedback question, so the person met a
// different stop at that one stage. Every shipped tree is read: no stage file
// carries the checkpoint's commands, and the module still does.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("t-summary-stop-has-one-owner", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: only the summary module carries the summary confirmation's commands",
    (_name, harness) => {
      const common = join(harness.engineRoot, "aidlc-common");
      const module = read(join(common, "protocols", "stage-protocol-summary.md"));
      expect(module).toContain("--checkpoint summary-confirmation");
      const copies = markdownFiles(join(common, "stages"))
        .filter((file) => read(file).includes("--checkpoint summary-confirmation"))
        .map((file) => relative(harness.distRoot, file));
      expect(copies).toEqual([]);
      const requirements = read(join(common, "stages", "inception", "requirements-analysis.md"));
      expect(requirements).toContain("### Step 9: Confirm the Consolidated Summary");
    },
  );
});

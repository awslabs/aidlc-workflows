// covers: file:aidlc-common/protocols/stage-protocol-governance.md, file:aidlc-common/protocols/stage-protocol.md
//
// The phase-boundary traceability check has one owner: the phase-ending stage
// runs it and files it as `<record>/verification/phase-check-<phase>.md`
// (approval-handoff, delivery-planning, ci-pipeline, and verification.md).
// The governance module, which the conductor skill and the stage protocol
// sent the agent to at every phase boundary, ran it again under another report
// name and on other triggers. Now the module keeps only its per-boundary checks,
// and nothing sends the agent there to run the check. The Kiro skills, left to
// the Kiro owner, still name the module; it holds no procedure for them to run.
// Every shipped tree is read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conductorSkillPaths } from "../harness/conductor-skill.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

describe("t-phase-check-has-one-owner", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: only the phase-ending stage runs the phase check",
    (name, harness) => {
      const protocols = join(harness.engineRoot, "aidlc-common", "protocols");
      const governance = read(join(protocols, "stage-protocol-governance.md"));
      for (const procedure of ["### When to verify", "### Verification process", "[phase-boundary]-verification.md", "run traceability verification"]) {
        expect(governance, procedure).not.toContain(procedure);
      }
      expect(governance).toContain("### Phase boundary checks");
      expect(read(join(protocols, "stage-protocol.md"))).not.toContain("stage-protocol-governance.md");
      if (harness.manifest.tierFlavor !== "kiro") {
        for (const file of conductorSkillPaths(name, join(harness.skillsRoot, "aidlc"))) {
          expect(read(file), file).not.toContain("stage-protocol-governance.md");
        }
      }
    },
  );
});

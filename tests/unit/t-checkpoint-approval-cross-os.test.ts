// covers: function:checkpointRecordForms
//
// A Unit approved at its checkpoint on Linux was asked about again on Windows
// (a live run: the same files gave sha256:7f76d31a... on Linux and
// sha256:924bb5c4... on Windows), and an approval made on Windows was asked
// about again on Linux. The Unit and swarm checkpoint fingerprints held the
// record folder as an OS path, with backslashes on Windows. They now hold it
// with forward slashes on every OS, so an approval made on one OS counts on the
// other, and Linux fingerprints recorded before are unchanged. An approval
// Windows recorded before still counts: the Windows form is accepted too.
import { describe, expect, test } from "bun:test";
import { checkpointRecordForms } from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import { cleanupTestProject, createTestProject, DEFAULT_RECORD_DIR, seededRecordDir } from "../harness/fixtures.ts";

describe("t-checkpoint-approval-cross-os: the record folder in a checkpoint fingerprint", () => {
  test("is written with forward slashes on every OS, and the Windows form still counts", () => {
    const project = createTestProject();
    try {
      expect(checkpointRecordForms(project, seededRecordDir(project))).toEqual([
        `aidlc/spaces/default/intents/${DEFAULT_RECORD_DIR}`,
        `aidlc\\spaces\\default\\intents\\${DEFAULT_RECORD_DIR}`,
      ]);
    } finally {
      cleanupTestProject(project);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { targetsStateFile } from "../harness/state-file-target.ts";

describe("state-file destination predicate", () => {
  test("state-write guard checks destinations and aliases, not artifact content", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "t238-state-target-"));
    try {
      const state = join(projectDir, "record", "aidlc-state.md");
      mkdirSync(dirname(state), { recursive: true });
      writeFileSync(state, "fixture state\n");
      const artifact = join(projectDir, "stories.md");
      writeFileSync(artifact, "The engine owns aidlc-state.md.\n");
      // Hard links require no Windows symlink privilege and exercise file
      // identity under a name that contains no state-file marker.
      const alias = join(projectDir, "state-alias.md");
      linkSync(state, alias);
      for (const toolName of ["Write", "Edit"]) {
        const call = (filePath: string, isError = false) => ({
          toolName,
          input: toolName === "Write"
            ? { file_path: filePath, content: "The engine owns aidlc-state.md." }
            : { file_path: filePath, old_string: "previous text", new_string: "The engine owns aidlc-state.md." },
          isError,
        });
        expect(targetsStateFile(call(artifact), projectDir, state)).toBe(false);
        expect(targetsStateFile(call(state), projectDir, state)).toBe(true);
        expect(targetsStateFile(call(relative(projectDir, state)), projectDir, state)).toBe(true);
        expect(targetsStateFile(call(realpathSync(state)), projectDir, state)).toBe(true);
        expect(targetsStateFile(call(alias), projectDir, state)).toBe(true);
        expect(targetsStateFile(call(state, true), projectDir, state)).toBe(true);
        expect(targetsStateFile(call(join(projectDir, "missing", "aidlc-state.md"), true), projectDir, state)).toBe(true);
      }
      expect(readFileSync(state, "utf-8")).toBe("fixture state\n");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

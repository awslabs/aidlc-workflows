// covers: function:normalizeDriveLetter, function:redactProjectDirPrefix
//
// t348 — normalizeDriveLetter upper-cases a leading Windows drive letter and
// nothing else. VS Code-based hosts (Kiro IDE) report `c:\...` while the project
// dir carries `C:\...`; the drive letter is the one component Windows never
// compares case-sensitively, so it is the only one folded. Directory names keep
// their exact spelling so a case-distinct sibling on case-sensitive storage can
// never alias the record root. Pure string function: runs on every host. The
// redactProjectDirPrefix case resolves real Windows paths, so it runs on
// Windows CI only.

import { describe, expect, test } from "bun:test";
import { normalizeDriveLetter, redactProjectDirPrefix } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("t348 normalizeDriveLetter", () => {
  test("upper-cases a lower-case drive letter with either separator", () => {
    expect(normalizeDriveLetter("c:\\Users\\Dev\\proj")).toBe("C:\\Users\\Dev\\proj");
    expect(normalizeDriveLetter("c:/Users/Dev/proj")).toBe("C:/Users/Dev/proj");
    expect(normalizeDriveLetter("d:")).toBe("D:");
  });

  test("leaves an upper-case drive letter unchanged", () => {
    expect(normalizeDriveLetter("C:/Users/Dev/proj")).toBe("C:/Users/Dev/proj");
  });

  test("never folds components after the drive letter", () => {
    expect(normalizeDriveLetter("c:/users/DEV/Proj")).toBe("C:/users/DEV/Proj");
  });

  test("record-root prefix checks agree across drive-letter case only", () => {
    const root = normalizeDriveLetter("C:/proj/aidlc/spaces/default/intents/x-12345678");
    const file = normalizeDriveLetter("c:/proj/aidlc/spaces/default/intents/x-12345678/ideation/intent.md");
    expect(file.startsWith(`${root}/`)).toBe(true);
    const sibling = normalizeDriveLetter("c:/proj/aidlc/spaces/default/intents/X-12345678/ideation/intent.md");
    expect(sibling.startsWith(`${root}/`)).toBe(false);
  });

  test("POSIX, relative, UNC, and drive-relative-looking inputs are unchanged", () => {
    expect(normalizeDriveLetter("/home/dev/proj")).toBe("/home/dev/proj");
    expect(normalizeDriveLetter("aidlc/spaces")).toBe("aidlc/spaces");
    expect(normalizeDriveLetter("//server/share/proj")).toBe("//server/share/proj");
    expect(normalizeDriveLetter("\\\\server\\share")).toBe("\\\\server\\share");
    expect(normalizeDriveLetter("c:proj")).toBe("c:proj");
    expect(normalizeDriveLetter("ab:/x")).toBe("ab:/x");
    expect(normalizeDriveLetter("")).toBe("");
  });

  // The write-audit hook records the upper-case drive spelling even when the
  // project dir carries `c:\`, so redaction must accept either drive case.
  test.skipIf(process.platform !== "win32")("redactProjectDirPrefix accepts either drive-letter spelling of the project dir", () => {
    for (const projectDir of ["C:\\Users\\Dev\\proj", "c:\\Users\\Dev\\proj"]) {
      for (const file of ["C:/Users/Dev/proj/aidlc/x.md", "c:/Users/Dev/proj/aidlc/x.md", "C:\\Users\\Dev\\proj\\aidlc\\x.md"]) {
        expect(redactProjectDirPrefix(file, projectDir)).toMatch(/^<project-dir>[\\/]aidlc[\\/]x\.md$/);
      }
      expect(redactProjectDirPrefix("C:/Users/Dev/PROJ/x.md", projectDir)).toBe("C:/Users/Dev/PROJ/x.md");
    }
  });
});

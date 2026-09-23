// covers: function:relativeUnderRoot
//
// t342 - Pure cross-platform path containment. Mechanism: none.
// relativeUnderRoot decides whether an absolute file path is under a root and
// returns its forward-slash remainder, or null when it is outside. The explicit
// platform argument exercises win32 case and separator semantics on any host.

import { describe, expect, test } from "bun:test";
import { relativeUnderRoot } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("t342 relativeUnderRoot", () => {
  test("posix returns the forward-slash remainder for a file under the root", () => {
    expect(
      relativeUnderRoot("/tmp/x/root", "/tmp/x/root/a/b.md", "linux"),
    ).toBe("a/b.md");
  });

  test("posix returns an empty remainder for the root itself", () => {
    expect(relativeUnderRoot("/tmp/x/root", "/tmp/x/root", "linux")).toBe("");
  });

  test("posix tolerates a trailing slash on the root", () => {
    expect(
      relativeUnderRoot("/tmp/x/root/", "/tmp/x/root/y.md", "linux"),
    ).toBe("y.md");
  });

  test("posix stays case-sensitive", () => {
    expect(
      relativeUnderRoot("/tmp/x/root", "/TMP/x/root/y.md", "linux"),
    ).toBeNull();
  });

  test("posix rejects a sibling directory sharing the root prefix", () => {
    expect(
      relativeUnderRoot("/proj/aidlc-docs", "/proj/aidlc-docs2/x", "linux"),
    ).toBeNull();
  });

  test("posix rejects a file outside the root", () => {
    expect(
      relativeUnderRoot("/tmp/x/root", "/tmp/other/file.txt", "linux"),
    ).toBeNull();
  });

  test("win32 accepts a lowercase drive letter against an uppercase root", () => {
    expect(
      relativeUnderRoot(
        "C:\\proj\\aidlc-docs",
        "c:/proj/aidlc-docs/x/y.md",
        "win32",
      ),
    ).toBe("x/y.md");
  });

  test("win32 accepts mixed separators and component-case differences", () => {
    expect(
      relativeUnderRoot(
        "C:/proj/aidlc-docs",
        "c:\\proj\\AIDLC-DOCS\\x\\y.md",
        "win32",
      ),
    ).toBe("x/y.md");
  });

  test("win32 tolerates either trailing separator on the root", () => {
    expect(
      relativeUnderRoot(
        "C:/proj/aidlc-docs/",
        "c:/proj/aidlc-docs/x/y.md",
        "win32",
      ),
    ).toBe("x/y.md");
    expect(
      relativeUnderRoot(
        "C:\\proj\\aidlc-docs\\",
        "c:/proj/aidlc-docs/x/y.md",
        "win32",
      ),
    ).toBe("x/y.md");
  });

  test("win32 returns an empty remainder for the root itself", () => {
    expect(
      relativeUnderRoot("C:/proj/aidlc-docs", "c:/proj/aidlc-docs", "win32"),
    ).toBe("");
  });

  test("win32 rejects a sibling directory sharing the root prefix", () => {
    expect(
      relativeUnderRoot("C:/proj/aidlc-docs", "c:/proj/aidlc-docs2/x", "win32"),
    ).toBeNull();
  });

  test("win32 rejects a file on a different drive", () => {
    expect(
      relativeUnderRoot("C:/proj/aidlc-docs", "D:/proj/aidlc-docs/x", "win32"),
    ).toBeNull();
  });

  test("win32 rejects a file outside the root", () => {
    expect(
      relativeUnderRoot("C:/proj/aidlc-docs", "c:/other/x.md", "win32"),
    ).toBeNull();
  });

  test("win32 applies case-insensitive containment to drive-less paths", () => {
    expect(
      relativeUnderRoot("/tmp/x/root", "/TMP/x/root/ideation/y.md", "win32"),
    ).toBe("ideation/y.md");
  });

  test("the default platform argument uses the host platform", () => {
    expect(relativeUnderRoot("/tmp/x/root", "/TMP/x/root/y.md")).toBe(
      relativeUnderRoot("/tmp/x/root", "/TMP/x/root/y.md", process.platform),
    );
  });
});

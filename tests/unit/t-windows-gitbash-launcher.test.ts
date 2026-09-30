// covers: file:core/tools/aidlc-lifecycle.ts file:core/tools/aidlc-install-paths.ts

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { windowsPosixCommandPath } from "../../core/tools/aidlc-install-paths.ts";
import { windowsPosixShim } from "../../core/tools/aidlc-lifecycle.ts";

// The Windows extensionless launcher exists so a bare `aidlc` resolves in Git
// Bash / MSYS shells, which use execvp PATH lookup and ignore PATHEXT (so they
// never find aidlc.cmd). These assertions pin the two load-bearing properties
// that make it work regardless of the host the test runs on.
describe("windows extensionless git bash launcher", () => {
  test("the forwarder is a LF POSIX script that execs its sibling aidlc.cmd", () => {
    const body = windowsPosixShim();
    // A CRLF script breaks under MSYS /bin/sh: the trailing \r joins the
    // shebang interpreter path, so /bin/sh\r is looked up and not found.
    expect(body.includes("\r")).toBe(false);
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);
    // Location-independent: it resolves aidlc.cmd relative to its own path, so
    // the body is a constant the installer's ownership check compares verbatim.
    expect(body).toContain('exec "$(dirname "$0")/aidlc.cmd" "$@"');
    // No absolute install path baked in — that would make the body vary per
    // machine and defeat the byte-for-byte ownership comparison.
    expect(body).not.toContain(":");
  });

  test("the launcher path is bin/aidlc on Windows and null elsewhere", () => {
    const previous = process.env.AIDLC_BIN_DIR;
    const bin = join("/tmp", "aidlc-bin-fixture");
    process.env.AIDLC_BIN_DIR = bin;
    try {
      const path = windowsPosixCommandPath();
      if (process.platform === "win32") {
        expect(path).toBe(join(bin, "aidlc"));
      } else {
        // Off Windows the platform command is already the extensionless
        // launcher, so there is no separate sibling to install.
        expect(path).toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.AIDLC_BIN_DIR;
      else process.env.AIDLC_BIN_DIR = previous;
    }
  });
});

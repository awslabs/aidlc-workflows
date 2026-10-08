// covers: function:updateCheck, function:progressLine
//
// Doctor and update lines a person reads without having asked for them:
// - a machine that has never checked for updates is not a warning (the first
//   doctor from a chat tool runs with no TTY, so it never refreshes the cache);
// - in a terminal only the release asset's own "Downloaded <asset>" line stays;
//   the metadata files it is verified with show a transient line that is cleared.
import { describe, expect, test } from "bun:test";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { updateCheck } from "../../core/tools/aidlc-doctor.ts";
import { progressLine } from "../../core/tools/aidlc-release.ts";

describe("doctor's update row before the first check", () => {
  test("an absent cache is a passing row that says the check has not run", () => {
    const check = updateCheck({
      state: "absent",
      currentVersion: AIDLC_VERSION,
      channel: "stable",
      message: "update cache is absent",
    });
    expect(check.pass).toBe(true);
    expect(check.severity).toBeUndefined();
    expect(check.label).toMatch(/^Update: not checked yet \(run `.* update --check` to check\)$/);
  });

  test("a stale cache still warns with the check command", () => {
    const check = updateCheck({
      state: "stale",
      currentVersion: AIDLC_VERSION,
      channel: "stable",
      message: "update cache is stale",
    });
    expect(check.pass).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.fix).toMatch(/update --check/);
  });
});

describe("download progress lines", () => {
  const url = "https://releases.example/download/v9.9.9/";
  test("in a terminal a verified metadata file leaves no line behind", () => {
    expect(progressLine(`${url}version.json`, false, true, true)).toMatch(/^\rDownloading version\.json\.\.\. *$/);
    const done = progressLine(`${url}version.json`, true, true, true) ?? "";
    expect(done).not.toContain("\n");
    expect(done).not.toContain("Downloaded");
    expect(done.startsWith("\r")).toBe(true);
  });

  test("in a terminal the release asset keeps its Downloaded line", () => {
    expect(progressLine(`${url}aidlc-runtime.tar.gz`, true, false, true)).toMatch(/^\rDownloaded aidlc-runtime\.tar\.gz *\n$/);
  });

  test("piped, only the asset's completed line prints", () => {
    expect(progressLine(`${url}version.json`, true, true, false)).toBeNull();
    expect(progressLine(`${url}aidlc-runtime.tar.gz`, false, false, false)).toBeNull();
    expect(progressLine(`${url}aidlc-runtime.tar.gz`, true, false, false)).toBe("Downloaded aidlc-runtime.tar.gz\n");
  });
});

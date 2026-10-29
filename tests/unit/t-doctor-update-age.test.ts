// covers: function:doctorUpdateState, function:updateCheck, function:cachedUpdateState, function:refreshUpdateState
//
// Doctor's update row read from a check made days ago. Off a terminal (a
// redirect, a script, an agent) doctor does not go to the network, so the row
// names the version it holds as the latest known one, with how long ago it was
// checked, never as today's latest. `--export`, a report someone asked for,
// refreshes the check off a terminal too, and when it cannot, the row says so
// with the same date. On a machine that has never checked, a refresh nobody
// asked for that fails leaves the row passing as not checked yet; only a
// requested `--check-updates` reports the failure.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { doctorUpdateState, updateCheck } from "../../core/tools/aidlc-doctor.ts";
import { cachedUpdateState } from "../../core/tools/aidlc-update.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NEWER = "99.0.0";
const KEYS = [
  "AIDLC_INSTALL_ROOT",
  "AIDLC_BIN_DIR",
  "AIDLC_RELEASE_BASE_URL",
  "AIDLC_OFFLINE",
  "NO_PROXY",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let machine = "";
let requests: string[] = [];
// A release site that answers nothing useful, so a refresh that runs is seen
// by its result and by the requests it made.
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return new Response("unavailable", { status: 503 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  cleanupTestProject(machine || undefined);
  machine = "";
});

function cacheCheckedAgo(ms: number, latestVersion: string, channel: "stable" | "preview" = "stable"): void {
  cleanupTestProject(machine || undefined);
  machine = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-update-age-"));
  mkdirSync(join(machine, "bin"));
  Object.assign(process.env, {
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
    AIDLC_OFFLINE: "0",
    NO_PROXY: "127.0.0.1",
  });
  writeFileSync(join(machine, "update-check.json"), `${JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date(Date.now() - ms).toISOString(),
    latestVersion,
    releaseDate: "2026-10-08",
    channel,
  }, null, 2)}\n`);
  if (channel !== "stable") writeFileSync(join(machine, "channel"), `${channel}\n`);
  requests = [];
}

function neverChecked(): void {
  cleanupTestProject(machine || undefined);
  machine = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-update-age-"));
  mkdirSync(join(machine, "bin"));
  Object.assign(process.env, {
    AIDLC_INSTALL_ROOT: machine,
    AIDLC_BIN_DIR: join(machine, "bin"),
    AIDLC_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}`,
    AIDLC_OFFLINE: "0",
    NO_PROXY: "127.0.0.1",
  });
  requests = [];
}

describe("doctor's update row from an old check", () => {
  test("behind: the version is the latest known one, with its check date, and the fix is still update", () => {
    cacheCheckedAgo(12 * DAY + HOUR, NEWER);
    const check = updateCheck(cachedUpdateState());
    expect(check.label).toBe(`Update: binary ${AIDLC_VERSION}, latest known ${NEWER}, checked 12 days ago`);
    expect(check.severity).toBe("warn");
    expect(check.fix).toMatch(/ update`$/);
  });

  test("not behind: the row names the latest known version and its check date, not the cache", () => {
    cacheCheckedAgo(DAY + HOUR, AIDLC_VERSION);
    const check = updateCheck(cachedUpdateState());
    expect(check.label).toBe(`Update: binary ${AIDLC_VERSION}, latest known ${AIDLC_VERSION}, checked 1 day ago`);
    expect(check.label).not.toContain("cache");
    expect(check.fix).toMatch(/ update --check`$/);
  });

  test("a check from today still says latest, with no date", () => {
    cacheCheckedAgo(2 * HOUR, NEWER);
    expect(updateCheck(cachedUpdateState()).label).toBe(`Update: binary ${AIDLC_VERSION}, latest ${NEWER}`);
  });

  test("another channel's old check is dated too, and the way back names no old version", () => {
    cacheCheckedAgo(3 * DAY + HOUR, "99.0.0-preview.20260903.1", "preview");
    expect(cachedUpdateState().message).toBe(
      `binary ${AIDLC_VERSION} (stable), preview channel newest known 99.0.0-preview.20260903.1, checked 3 days ago; update switches channels`,
    );
    cacheCheckedAgo(3 * DAY + HOUR, "0.0.1-preview.20260101.1", "preview");
    expect(cachedUpdateState().message).toBe(
      `You're on ${AIDLC_VERSION}, newer than the latest known preview 0.0.1-preview.20260101.1, checked 3 days ago. ` +
        "To go back to preview: aidlc update --channel preview. To keep getting stable releases: aidlc config --channel stable.",
    );
  });
});

describe("doctor off a terminal", () => {
  test("a plain run stays off the network and dates what it read", async () => {
    cacheCheckedAgo(12 * DAY + HOUR, NEWER);
    const state = await doctorUpdateState({}, false);
    expect(requests).toHaveLength(0);
    expect(updateCheck(state).label).toBe(
      `Update: binary ${AIDLC_VERSION}, latest known ${NEWER}, checked 12 days ago`,
    );
  });

  test("--export refreshes the old check, and says it could not, with the date of the last one", async () => {
    cacheCheckedAgo(12 * DAY + HOUR, NEWER);
    const state = await doctorUpdateState({ export: "true" }, false);
    expect(state.state).toBe("unavailable");
    const check = updateCheck(state);
    expect(check.label).toBe(
      `Update: could not check for a newer release; binary ${AIDLC_VERSION}, latest known ${NEWER}, checked 12 days ago`,
    );
    expect(check.fix).toMatch(/ update --check`$/);
  });

  test("--export leaves a check from today alone", async () => {
    cacheCheckedAgo(2 * HOUR, NEWER);
    const state = await doctorUpdateState({ export: "true" }, false);
    expect(requests).toHaveLength(0);
    expect(state.state).toBe("behind");
  });

  test("a refresh that fails on a check from today says how many hours ago it was", async () => {
    cacheCheckedAgo(2 * HOUR + 60_000, NEWER);
    const state = await doctorUpdateState({ "check-updates": "true" }, false);
    expect(state.message).toBe(
      `could not check for a newer release; binary ${AIDLC_VERSION}, latest known ${NEWER}, checked 2 hours ago`,
    );
  });
});

describe("doctor on a machine that has never checked", () => {
  test("at a terminal, a refresh that fails leaves the row passing as not checked yet", async () => {
    neverChecked();
    const state = await doctorUpdateState({}, true);
    expect(requests.length).toBeGreaterThan(0);
    expect(state.state).toBe("absent");
    const check = updateCheck(state);
    expect(check.pass).toBe(true);
    expect(check.severity).toBeUndefined();
    expect(check.label).toMatch(/^Update: not checked yet \(run `.*update --check` to check\)$/);
  });

  test("--export off a terminal: the same, the report is not a warning about a check it never had", async () => {
    neverChecked();
    const state = await doctorUpdateState({ export: "true" }, false);
    expect(requests.length).toBeGreaterThan(0);
    expect(state.state).toBe("absent");
    expect(updateCheck(state).pass).toBe(true);
  });

  test("a requested --check-updates that fails still says the check could not be made", async () => {
    neverChecked();
    const state = await doctorUpdateState({ "check-updates": "true" }, true);
    expect(state.state).toBe("unavailable");
    const check = updateCheck(state);
    expect(check.pass).toBe(false);
    expect(check.label).toBe("Update: update refresh unavailable; release metadata could not be checked");
  });
});

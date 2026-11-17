// covers: function:syncServiceHolding, function:syncFolderClause
//
// A project in a synced folder is named by its service, only on a positive
// match against a known root; anything else is silence. Doctor's row and the
// refusals' sentence come from the same words.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SYNC_FOLDER_STEP,
  syncFolderLabel,
  syncServiceHolding,
} from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedStateFile,
  seedWorkspaceShell,
  syncedFolderEnv,
} from "../harness/fixtures.ts";

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) cleanupTestProject(root);
});

function root(): string {
  const dir = createTestProject();
  roots.push(dir);
  return dir;
}

function folder(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dropboxInfo(file: string, accounts: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(accounts));
}

describe("t-sync-folder-hint which sync service holds the project", () => {
  test("macOS CloudStorage folders name their service; any other folder there names nothing", () => {
    const home = root();
    const cloud = folder(home, "Library", "CloudStorage");
    const mac = { platform: "darwin" as const, env: {}, home };
    expect(syncServiceHolding(folder(cloud, "GoogleDrive-a@example.com", "My Drive", "app"), mac)).toBe("Google Drive");
    expect(syncServiceHolding(folder(cloud, "OneDrive-Personal", "app"), mac)).toBe("OneDrive");
    expect(syncServiceHolding(folder(cloud, "Dropbox", "app"), mac)).toBe("Dropbox");
    expect(syncServiceHolding(folder(cloud, "Box-Box", "app"), mac)).toBe("Box");
    expect(syncServiceHolding(folder(cloud, "GoogleDriveX", "app"), mac)).toBeNull();
    expect(syncServiceHolding(folder(cloud, "constructor-x", "app"), mac)).toBeNull();
    expect(syncServiceHolding(folder(home, "Library", "CloudStorageX", "GoogleDrive-a", "app"), mac)).toBeNull();
    expect(syncServiceHolding(cloud, mac)).toBeNull();
    // The same folder on another platform is not a sync root.
    expect(syncServiceHolding(join(cloud, "Dropbox", "app"), { platform: "linux", env: {}, home })).toBeNull();
  });

  test("iCloud's Mobile Documents names iCloud Drive", () => {
    const home = root();
    const project = folder(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "app");
    expect(syncServiceHolding(project, { platform: "darwin", env: {}, home })).toBe("iCloud Drive");
    expect(syncServiceHolding(folder(home, "Documents", "app"), { platform: "darwin", env: {}, home })).toBeNull();
  });

  test("Windows OneDrive folders name OneDrive; a blank value, a sibling folder or a project elsewhere names nothing", () => {
    const base = root();
    const onedrive = folder(base, "OneDrive");
    const project = folder(onedrive, "src", "app");
    const win = (env: NodeJS.ProcessEnv) => ({ platform: "win32" as const, env, home: base });
    expect(syncServiceHolding(project, win({ OneDrive: onedrive }))).toBe("OneDrive");
    expect(syncServiceHolding(project, win({ OneDriveCommercial: onedrive }))).toBe("OneDrive");
    expect(syncServiceHolding(project, win({ OneDriveConsumer: onedrive }))).toBe("OneDrive");
    expect(syncServiceHolding(onedrive, win({ OneDrive: onedrive }))).toBe("OneDrive");
    expect(syncServiceHolding(project, win({ OneDrive: "" }))).toBeNull();
    expect(syncServiceHolding(project, win({ OneDrive: "OneDrive" }))).toBeNull();
    expect(syncServiceHolding(project, win({ OneDrive: join(base, "missing") }))).toBeNull();
    expect(syncServiceHolding(folder(base, "OneDrive-old", "app"), win({ OneDrive: onedrive }))).toBeNull();
    expect(syncServiceHolding(folder(base, "elsewhere"), win({ OneDrive: onedrive }))).toBeNull();
    expect(syncServiceHolding(project, { platform: "linux", env: { OneDrive: onedrive }, home: base })).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("Windows: the OneDrive value matches in either drive-letter case", () => {
    const base = root();
    const onedrive = folder(base, "OneDrive");
    const project = folder(onedrive, "app");
    const flip = (path: string) =>
      /^[a-z]:/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path[0]!.toLowerCase() + path.slice(1);
    expect(syncServiceHolding(project, { platform: "win32", env: { OneDrive: flip(onedrive) }, home: base })).toBe("OneDrive");
    expect(syncServiceHolding(flip(project), { platform: "win32", env: { OneDrive: onedrive }, home: base })).toBe("OneDrive");
  });

  test("Dropbox: a root from its info.json names Dropbox; no file, a broken file or a blank path names nothing", () => {
    const home = root();
    const personal = folder(home, "Dropbox (Personal)");
    const business = folder(home, "Dropbox (Team)");
    const project = folder(business, "app");
    const posix = { platform: "linux" as const, env: {}, home };
    expect(syncServiceHolding(project, posix)).toBeNull();
    dropboxInfo(join(home, ".dropbox", "info.json"), {
      personal: { path: personal, host: 1, is_team: false },
      business: { path: business, host: 1, is_team: true },
    });
    expect(syncServiceHolding(project, posix)).toBe("Dropbox");
    expect(syncServiceHolding(folder(personal, "app"), { ...posix, platform: "darwin" })).toBe("Dropbox");
    expect(syncServiceHolding(folder(home, "elsewhere"), posix)).toBeNull();
    writeFileSync(join(home, ".dropbox", "info.json"), "{not json");
    expect(syncServiceHolding(project, posix)).toBeNull();
    dropboxInfo(join(home, ".dropbox", "info.json"), { personal: { path: "" } });
    expect(syncServiceHolding(project, posix)).toBeNull();
    // Windows keeps info.json under APPDATA or LOCALAPPDATA.
    const appData = folder(home, "AppData", "Roaming");
    dropboxInfo(join(appData, "Dropbox", "info.json"), { personal: { path: business } });
    expect(syncServiceHolding(project, { platform: "win32", env: { APPDATA: appData }, home })).toBe("Dropbox");
    expect(syncServiceHolding(project, { platform: "win32", env: { LOCALAPPDATA: appData }, home })).toBe("Dropbox");
    expect(syncServiceHolding(project, { platform: "win32", env: { APPDATA: "" }, home })).toBeNull();
  });

  test("a project linked into a synced folder is named by where it really is", () => {
    const base = root();
    const onedrive = folder(base, "OneDrive");
    const real = folder(onedrive, "app");
    const link = join(base, "link-to-app");
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    expect(syncServiceHolding(link, { platform: "win32", env: { OneDrive: onedrive }, home: base })).toBe("OneDrive");
  });

  test("doctor shows one advisory row for a project in a synced folder, and none otherwise", () => {
    const project = root();
    seedWorkspaceShell(project);
    seedStateFile(project, "state-mid-ideation.md");
    // A child process: Bun reads the home folder once, at start.
    const syncRows = (env: Record<string, string>) => {
      const script = `const { collectDoctorReport } = await import(${JSON.stringify(UTILITY)});
const report = await collectDoctorReport(${JSON.stringify(project)});
console.log(JSON.stringify(report.checks.filter((row) => row.label.includes("sync can change files"))));`;
      const child = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        env: { ...process.env, ...env },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim().split("\n").pop() ?? "[]");
    };
    expect(syncRows({})).toEqual([]);
    const service = process.platform === "win32" ? "OneDrive" : "Dropbox";
    expect(syncRows(syncedFolderEnv(project, root()))).toEqual([
      { pass: false, severity: "warn", label: syncFolderLabel(service), fix: SYNC_FOLDER_STEP },
    ]);
  });

  test("the words: one label and step for doctor's row and the refusals", () => {
    expect(syncFolderLabel("Dropbox")).toBe(
      "This project is in a Dropbox folder; sync can change files AI-DLC checks",
    );
    expect(syncFolderLabel("iCloud Drive")).toBe(
      "This project is in an iCloud Drive folder; sync can change files AI-DLC checks",
    );
    expect(SYNC_FOLDER_STEP).toBe("move it out of the synced folder or pause sync for it");
  });
});

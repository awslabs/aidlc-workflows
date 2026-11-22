// covers: file:tests/harness/tui-drive.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acceptTuiFixturePermissionMode, claudeModelUpgradeNavigation, claudePermissionNavigation, claudeTrustNavigation, declineOwnedModelUpgrade,
  kiroV3OfferNavigation, preseedClaudeOnboarding, remindKiroV3OfferLater, TUI_TEST_FIXTURE_MARKER,
} from "../harness/tui-drive.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const root = process.env.AIDLC_TEST_WORKER_ROOT ??
    resolve(import.meta.dir, "../../tmp/e2e-driver-isolation");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "synthetic-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Claude onboarding profile isolation", () => {
  test("standalone owned sessions decline model upgrades once without runner-specific environment", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-tui-")));
    scratchDirs.push(dir);
    writeFileSync(join(dir, TUI_TEST_FIXTURE_MARKER), JSON.stringify({ cwd: dir, ownerPid: process.pid }));
    const offer = "Newer Opus model available\nCurrently pinned: Opus 4.8\nLatest available: Opus 5\nUpdate settings to use Opus 5? Claude Code will restart to apply.";
    const yes = `${offer}\n❯ 1. Yes\n  2. No`;
    const no = `${offer}\n  1. Yes\n❯ 2. No`;
    let painted = yes;
    const keys: string[] = [];
    const backend = {
      fixtureCwd: () => dir,
      capture: async () => painted,
      send: async (_session: string, key: string) => {
        keys.push(key);
        if (key === "Down") painted = no;
        else expect(painted).toBe(no);
      },
    };
    const prior = process.env.AIDLC_TEST_WORKER_ROOT;
    delete process.env.AIDLC_TEST_WORKER_ROOT;
    try {
      expect(await declineOwnedModelUpgrade(backend, "standalone", yes)).toBe(true);
      expect(keys).toEqual(["Down", "Enter"]);
      expect(await declineOwnedModelUpgrade(backend, "standalone", yes)).toBe(false);
      expect(await declineOwnedModelUpgrade({ ...backend, fixtureCwd: () => null }, "unowned", yes)).toBe(false);
      expect(keys).toEqual(["Down", "Enter"]);
    } finally {
      if (prior !== undefined) process.env.AIDLC_TEST_WORKER_ROOT = prior;
    }
  });

  test("the Windows configuration-trust menu retains the same visible Yes selection", () => {
    const heading = "Accessing workspace:\nThis folder pre-approves tool permissions";
    expect(claudeTrustNavigation(`${heading}\n❯ 1. Yes, I trust this folder\n2. No, continue without these permissions`)).toBe("Enter");
    expect(claudeTrustNavigation(`${heading}\n1. Yes, I trust this folder\n❯ 2. No, continue without these permissions`)).toBe("Up");
    expect(claudeTrustNavigation(`${heading}\n1. Yes, I trust this folder\n2. No, continue without these permissions`)).toBeNull();
    expect(claudeTrustNavigation("Other menu\n❯ 1. Yes, I trust this folder\n2. No, continue without these permissions")).toBeNull();
  });

  test("permission-mode acceptance follows the painted choice in owned fixtures", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-tui-")));
    scratchDirs.push(dir);
    writeFileSync(join(dir, TUI_TEST_FIXTURE_MARKER), JSON.stringify({ cwd: dir, ownerPid: process.pid }));
    const no = "WARNING: Bypass Permissions mode\n❯ No, exit\n  Yes, I accept";
    const yes = "WARNING: Bypass Permissions mode\n  No, exit\n❯ Yes, I accept";
    expect(claudePermissionNavigation(no)).toBe("Down");
    expect(claudePermissionNavigation(yes)).toBe("Enter");
    expect(claudePermissionNavigation("Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept")).toBe("Down");
    expect(claudePermissionNavigation("bypass permissions on\n❯ No, exit\nYes, I accept")).toBeNull();
    let current = no;
    let now = 0;
    const keys: string[] = [];
    const backend = {
      fixtureCwd: () => dir,
      capture: () => current,
      send: (_session: string, key: string, _literal: boolean, noEnter: boolean) => {
        expect(noEnter).toBe(true);
        keys.push(key);
        if (key === "Down") current = yes;
        else expect(current).toBe(yes);
      },
    };
    expect(await acceptTuiFixturePermissionMode(backend, "fixture", no, {
      now: () => now, sleep: async (ms) => { now += ms; },
    })).toBe(true);
    expect(keys).toEqual(["Down", "Enter"]);
    expect(await acceptTuiFixturePermissionMode({ ...backend, fixtureCwd: () => null }, "fixture", no)).toBe(false);
  });

  test("model-upgrade navigation selects No and refuses ambiguous or ordinary workflow output", () => {
    const offer = [
      "Newer Opus model available", "Currently pinned: Opus 4.8", "Latest available: Opus 5",
      "Update settings to use Opus 5? Claude Code will restart to apply.",
    ].join("\n");
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n  2. No`)).toBe("Down");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. No\n❯ 2. Yes`)).toBe("Up");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. Yes\n❯ 2. No`)).toBe("Enter");
    expect(claudeModelUpgradeNavigation(`${offer}\n  1. Yes\n  2. No`)).toBeNull();
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n❯ 2. No`)).toBeNull();
    expect(claudeModelUpgradeNavigation(`${offer}\n❯ 1. Yes\n  2. No\n[AIDLC] stage`)).toBeNull();
    expect(claudeModelUpgradeNavigation("Approve this workflow?\n❯ 1. Yes\n  2. No")).toBeNull();
  });

  test("first-run preparation can preserve the interactive project trust dialog", () => {
    const dir = scratch();
    const profile = join(dir, "profile");
    const home = join(dir, "untouched-home");
    preseedClaudeOnboarding("/fixture", { CLAUDE_CONFIG_DIR: profile }, home, false);
    expect(json(join(profile, ".claude.json"))).toEqual({ hasCompletedOnboarding: true });
    expect(existsSync(home)).toBe(false);
  });

  test("separate explicit profiles preserve their own settings and never write the host home", () => {
    const dir = scratch();
    const home = join(dir, "host");
    const first = join(dir, "worker-1", "claude");
    const second = join(dir, "worker-2", "claude");
    mkdirSync(home);
    mkdirSync(first, { recursive: true });
    const hostBytes = '{"hostOnly":true}\n';
    writeFileSync(join(home, ".claude.json"), hostBytes);
    writeFileSync(join(first, ".claude.json"), JSON.stringify({
      theme: "dark",
      projects: { "C:/existing": { hasTrustDialogAccepted: false, keep: true } },
    }));
    const env = Object.freeze({ CLAUDE_CONFIG_DIR: first, HOME: home, USERPROFILE: home });
    preseedClaudeOnboarding("C:\\fixture-one", env, home);
    preseedClaudeOnboarding("C:\\fixture-two", { CLAUDE_CONFIG_DIR: second }, home);
    preseedClaudeOnboarding("C:\\existing", env, home);

    expect(json(join(first, ".claude.json"))).toEqual({
      theme: "dark",
      hasCompletedOnboarding: true,
      projects: {
        "C:/existing": { hasTrustDialogAccepted: false, keep: true },
        "C:/fixture-one": { hasTrustDialogAccepted: true },
      },
    });
    expect(json(join(second, ".claude.json"))).toEqual({
      hasCompletedOnboarding: true,
      projects: { "C:/fixture-two": { hasTrustDialogAccepted: true } },
    });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(hostBytes);
    expect(readdirSync(home)).toEqual([".claude.json"]);
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
  });

  test("an explicit profile neither creates a home nor falls back to it on write failure", () => {
    const dir = scratch();
    const home = join(dir, "absent-home");
    const profile = join(dir, "config");
    preseedClaudeOnboarding("project", { CLAUDE_CONFIG_DIR: profile }, home);
    expect(existsSync(join(profile, ".claude.json"))).toBe(true);
    expect(existsSync(home)).toBe(false);

    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "untouched");
    preseedClaudeOnboarding("project", { CLAUDE_CONFIG_DIR: blocked }, home);
    expect(readFileSync(blocked, "utf8")).toBe("untouched");
    expect(existsSync(home)).toBe(false);
  });

  test("without an override the legacy home-level config is still seeded additively", () => {
    const home = scratch();
    writeFileSync(join(home, ".claude.json"), '{"theme":"light"}');
    preseedClaudeOnboarding("C:\\legacy", {}, home);
    expect(json(join(home, ".claude.json"))).toEqual({
      theme: "light",
      hasCompletedOnboarding: true,
      projects: { "C:/legacy": { hasTrustDialogAccepted: true } },
    });
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});

// Kiro CLI 2.33.1 paints this offer at launch with the caret on the upgrade.
const KIRO_V3_OPTIONS = ["Switch to V3 and upgrade my configs", "Remind me later", "Don't ask again"];
function kiroV3Offer(caret: number, options = KIRO_V3_OPTIONS, title = "You're using Kiro CLI V2. Switch to V3 today."): string {
  return [
    title,
    "V3 adds workflows, cloud sessions, and specs. To try it in a new session, run kiro-cli --v3. Learn more: https://kiro.dev/docs/cli/v3/",
    ...options.map((option, index) => `${index === caret ? "❯" : " "} ${option}`),
  ].join("\n");
}

describe("Kiro CLI's V3 offer at launch", () => {
  test("navigation takes Remind me later and refuses anything else", () => {
    expect(kiroV3OfferNavigation(kiroV3Offer(0))).toBe("Down");
    expect(kiroV3OfferNavigation(kiroV3Offer(1))).toBe("Enter");
    expect(kiroV3OfferNavigation(kiroV3Offer(2))).toBe("Up");
    expect(kiroV3OfferNavigation(kiroV3Offer(1, KIRO_V3_OPTIONS, "You're using Kiro CLI V2.\nSwitch to V3 today."))).toBe("Enter");
    expect(kiroV3OfferNavigation(kiroV3Offer(-1))).toBeNull();
    expect(kiroV3OfferNavigation(kiroV3Offer(0).replace("  Remind me later", "❯ Remind me later"))).toBeNull();
    expect(kiroV3OfferNavigation(kiroV3Offer(1, [KIRO_V3_OPTIONS[1], KIRO_V3_OPTIONS[0], KIRO_V3_OPTIONS[2]]))).toBeNull();
    expect(kiroV3OfferNavigation(kiroV3Offer(1, KIRO_V3_OPTIONS.slice(0, 2)))).toBeNull();
    expect(kiroV3OfferNavigation(kiroV3Offer(1, KIRO_V3_OPTIONS, "Upgrade now?"))).toBeNull();
    expect(kiroV3OfferNavigation(`${kiroV3Offer(1)}\n›  ask a question or describe a task ↵`)).toBeNull();

    // On Windows Server the caret is an ASCII ">": kiroV3Offer(0) with ">" is byte for byte the screen Kiro CLI 2.33.1
    // paints there.
    const windows = (screen: string) => screen.replace("❯", ">");
    expect(kiroV3OfferNavigation(windows(kiroV3Offer(0)))).toBe("Down");
    expect(kiroV3OfferNavigation(windows(kiroV3Offer(1)))).toBe("Enter");
    expect(kiroV3OfferNavigation(windows(kiroV3Offer(2)))).toBe("Up");
    expect(kiroV3OfferNavigation(windows(kiroV3Offer(0)).replace("  Remind me later", "> Remind me later"))).toBeNull();
    expect(kiroV3OfferNavigation(windows(kiroV3Offer(0)).replace("  Remind me later", "❯ Remind me later"))).toBeNull();
  });

  test("the offer is answered Remind me later and never Enter on another option", async () => {
    const chat = "›  ask a question or describe a task ↵";
    let now = 0;
    const timing = { now: () => now, sleep: async (ms: number) => { now += ms; } };
    for (const [start, move] of [[0, "Down"], [2, "Up"], [1, null]] as const) {
      let caret: number = start;
      let taken = false;
      const keys: string[] = [];
      const backend = {
        capture: () => taken ? chat : kiroV3Offer(caret),
        send: (_session: string, key: string, _literal: boolean, noEnter: boolean) => {
          expect(noEnter).toBe(true);
          keys.push(key);
          if (key === "Down") caret++;
          else if (key === "Up") caret--;
          else {
            expect(caret).toBe(1);
            taken = true;
          }
        },
      };
      expect(await remindKiroV3OfferLater(backend, "kiro", kiroV3Offer(start), timing)).toBe(true);
      expect(keys).toEqual(move ? [move, "Enter"] : ["Enter"]);
    }

    // A loaded host paints a move after the settle time, or loses the key: the
    // old frame is never read as the moved caret, and no second key goes while
    // one may still be on its way (it could land on "Don't ask again" unseen).
    for (const [lagMs, lost, expected] of [[1000, 0, ["Down", "Enter"]], [0, 1, ["Down"]]] as const) {
      let caret = 0;
      let movedAt = 0;
      let losing: number = lost;
      let taken = false;
      const keys: string[] = [];
      const slow = {
        capture: () => taken ? chat : kiroV3Offer(now - movedAt >= lagMs ? caret : caret - 1),
        send: (_session: string, key: string) => {
          keys.push(key);
          if (key === "Enter") {
            expect(caret).toBe(1);
            taken = true;
            return;
          }
          if (losing-- > 0) return;
          caret += key === "Down" ? 1 : -1;
          movedAt = now;
        },
      };
      const answered = remindKiroV3OfferLater(slow, "kiro", kiroV3Offer(0), timing);
      if (lost) await expect(answered).rejects.toThrow(/did not paint Down/);
      else expect(await answered).toBe(true);
      expect(keys).toEqual([...expected]);
    }

    // A caret that jumps past Remind me later gets no Enter.
    let caret = 0;
    const keys: string[] = [];
    const skipping = {
      capture: () => kiroV3Offer(caret),
      send: (_session: string, key: string) => {
        keys.push(key);
        caret = key === "Down" ? 2 : key === "Up" ? 0 : caret;
      },
    };
    await expect(remindKiroV3OfferLater(skipping, "kiro", kiroV3Offer(0), timing)).rejects.toThrow(/Remind me later/);
    expect(keys).not.toContain("Enter");

    // Kiro takes a while to start its chat after the answer, with the offer
    // still painted: the answer returns only once it is gone, with one Enter.
    {
      let answeredAt: number | null = null;
      const keys: string[] = [];
      const slowExit = {
        capture: () => answeredAt !== null && now - answeredAt >= 1500
          ? "Warning: Kiro is running in trust all tools mode\n❯ No, exit\n  Yes, I accept"
          : kiroV3Offer(1),
        send: (_session: string, key: string) => {
          keys.push(key);
          answeredAt ??= now;
        },
      };
      expect(await remindKiroV3OfferLater(slowExit, "kiro", kiroV3Offer(1), timing)).toBe(true);
      expect(keys).toEqual(["Enter"]);
      expect(slowExit.capture()).not.toContain("Remind me later");
    }

    const ordinary = { capture: () => "Approve this workflow?\n❯ 1. Yes\n  2. No", send: () => { throw new Error("no key expected"); } };
    expect(await remindKiroV3OfferLater(ordinary, "kiro", "Approve this workflow?\n❯ 1. Yes\n  2. No", timing)).toBe(false);
  });
});

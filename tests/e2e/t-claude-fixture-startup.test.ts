// Deterministic modal journeys, run alongside the Windows settings-isolation gate.
import { describe, expect, test } from "bun:test";
import { clearOwnedClaudeFixtureStartup } from "../harness/claude-fixture-startup.ts";

const OWNED_HOME = "/fixture/user-home";
const ENV = { HOME: OWNED_HOME, USERPROFILE: OWNED_HOME };
const READY = "❯\n  bypass permissions on (shift+tab to cycle)";
const UPGRADE = [
  "  Newer Opus model available",
  "",
  "  Currently pinned: Opus 4.8",
  "  Latest available: Opus 5 (us.anthropic.claude-opus-5)",
  "",
  "  Update settings to use Opus 5? Claude Code will restart to apply.",
  "",
  "  ❯ 1. Yes",
  "    2. No",
  "",
  "  Enter to confirm · Esc to cancel",
].join("\n");
const TRUST = "Do you trust this folder?\n❯ 1. Yes\n2. No";
const PERMISSIONS = "Bypass Permissions mode\n❯ 1. No\n2. Yes, I accept";

function fixture(panes: readonly string[]) {
  const sent: { keys: string; pane: string }[] = [];
  let index = -1;
  let time = 0;
  let captures = 0;
  const ui = {
    now: () => time,
    waitFor: (_pattern: string, _timeoutMs: number) => {
      time += 1_000;
      index = Math.min(index + 1, panes.length - 1);
      return true;
    },
    capture: () => {
      captures++;
      return panes[index];
    },
    send: (keys: string) => sent.push({ keys, pane: panes[index] }),
  };
  return { ui, sent, captures: () => captures };
}

describe("owned Claude fixture startup", () => {
  test.each([
    { panes: [UPGRADE, TRUST, PERMISSIONS, READY] },
    { panes: [TRUST, UPGRADE, PERMISSIONS, READY] },
    { panes: [TRUST, PERMISSIONS, UPGRADE, READY] },
    { panes: [UPGRADE, READY] },
    { panes: [READY] },
  ])("handles known startup screens in order: %j", ({ panes }) => {
    const f = fixture(panes);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.captures()).toBe(panes.length);
    expect(f.sent).toEqual(
      panes.filter((pane) => pane !== READY).map((pane) => ({
        keys: pane === TRUST ? "1" : "2",
        pane,
      })),
    );
  });

  test("chooses No once despite a stale upgrade repaint over the ready footer", () => {
    const modal = `${UPGRADE}\n${READY}`;
    const f = fixture([modal, modal, modal, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent).toEqual([{ keys: "2", pane: modal }]);
    expect(f.captures()).toBe(4);
  });

  test("waits for the complete dialog before choosing No", () => {
    const f = fixture([`Newer Opus model available\n${READY}`, UPGRADE, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent).toEqual([{ keys: "2", pane: UPGRADE }]);
  });

  test.each([
    "Update settings?\n❯ 1. Yes\n2. No",
    `Update settings?\n❯ 1. Yes\n2. No\n${READY}`,
    UPGRADE.replace("2. No", "2. Delete settings"),
    UPGRADE.replace("Update settings to use Opus 5?", "Update settings to use Opus 6?"),
    UPGRADE.replace("  Currently pinned: Opus 4.8\n", ""),
    `Newer Opus model available\n${READY}`,
  ])("leaves an unidentified or incomplete dialog unanswered: %j", (pane) => {
    const f = fixture([pane]);
    expect(() => clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui))
      .toThrow("never reached a startup state");
    expect(f.sent).toEqual([]);
  });

  test("times out a persistent modal without sending repeated answers", () => {
    const f = fixture([UPGRADE]);
    expect(() => clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui))
      .toThrow("never reached a startup state");
    expect(f.sent).toEqual([{ keys: "2", pane: UPGRADE }]);
  });

  test.each([
    { HOME: "/operator", USERPROFILE: OWNED_HOME },
    { HOME: OWNED_HOME, USERPROFILE: "/operator" },
    { ...ENV, CLAUDE_CONFIG_DIR: "/operator/.claude" },
  ])("refuses a profile outside the fixture before any interaction: %j", (env) => {
    const f = fixture([UPGRADE, READY]);
    expect(() => clearOwnedClaudeFixtureStartup(OWNED_HOME, env, f.ui))
      .toThrow("test's isolated user profile");
    expect(f.sent).toEqual([]);
    expect(f.captures()).toBe(0);
  });
});

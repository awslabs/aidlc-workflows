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
// Abridged from run 36294830398 (Windows claude-tui 19/21), without the
// selection and check-mark glyphs the chooser also paints.
const THEME = [
  " Let's get started.",
  " Choose the text style that looks best with your terminal",
  " To change this later, run /theme",
  "   1. Auto (match terminal)",
  "   2. Dark mode",
  "   3. Light mode",
].join("\n");
const PERMISSIONS = "Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept";
const PERMISSIONS_SELECTED = "Bypass Permissions mode\n1. No, exit\n❯ 2. Yes, I accept";
const UNNUMBERED = "Bypass Permissions mode\n❯ No, exit\n  Yes, I accept\nEnter to confirm · Esc to cancel";
const UNNUMBERED_SELECTED = "Bypass Permissions mode\n  No, exit\n❯ Yes, I accept\nEnter to confirm · Esc to cancel";

function fixture(panes: readonly string[]) {
  const sent: { keys: string; pane: string; noEnter?: boolean }[] = [];
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
    send: (keys: string, noEnter?: boolean) => sent.push({
      keys, pane: panes[index], ...(noEnter === undefined ? {} : { noEnter }),
    }),
  };
  return { ui, sent, captures: () => captures };
}

describe("owned Claude fixture startup", () => {
  test.each([
    { panes: [UPGRADE, TRUST, PERMISSIONS, PERMISSIONS_SELECTED, READY] },
    { panes: [TRUST, UPGRADE, PERMISSIONS, PERMISSIONS_SELECTED, READY] },
    { panes: [TRUST, PERMISSIONS, PERMISSIONS_SELECTED, UPGRADE, READY] },
    { panes: [UPGRADE, READY] },
    { panes: [READY] },
  ])("handles known startup screens in order: %j", ({ panes }) => {
    const f = fixture(panes);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.captures()).toBe(panes.length);
    expect(f.sent).toEqual(
      panes.filter((pane) => pane !== READY).map((pane) => ({
        keys: pane === TRUST ? "1" : pane === PERMISSIONS ? "Down" : pane === PERMISSIONS_SELECTED ? "Enter" : "2",
        pane,
        ...(pane === PERMISSIONS || pane === PERMISSIONS_SELECTED ? { noEnter: true } : {}),
      })),
    );
  });

  test("navigates the unnumbered trust menu by its painted selection, then confirms Yes once", () => {
    // As painted in run 36306452238; U+276F is Claude's selection marker.
    const trust = (yesSelected: boolean) => [
      " Accessing workspace:",
      " C:\\fixture\\project",
      " Quick safety check: Is this a project you created or one you trust?",
      `${yesSelected ? "   " : " \u276f "}No, exit`,
      `${yesSelected ? " \u276f " : "   "}Yes, I trust this folder`,
      " Enter to confirm",
    ].join("\n");
    const f = fixture([trust(false), trust(false), trust(true), PERMISSIONS, PERMISSIONS_SELECTED, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent.slice(0, 2)).toEqual([
      { keys: "Down", noEnter: true, pane: trust(false) },
      { keys: "Enter", noEnter: true, pane: trust(true) },
    ]);
  });

  test("acknowledges the first-run security notes once, then continues to the known screens", () => {
    const notes = " Security notes:\n 1. Claude can make mistakes.\n 2. Due to prompt injection risks, only use it with code you trust\n Press Enter to continue";
    const f = fixture([THEME, notes, notes, TRUST, PERMISSIONS, PERMISSIONS_SELECTED, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent.filter((send) => send.pane === notes)).toEqual([{ keys: "Enter", pane: notes, noEnter: true }]);
  });

  test("accepts the first-run theme chooser's default once, then continues to the known screens", () => {
    for (const panes of [[THEME, TRUST, PERMISSIONS, PERMISSIONS_SELECTED, READY], [THEME, THEME, READY]]) {
      const f = fixture(panes);
      clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
      expect(f.sent.filter((send) => send.pane === THEME)).toEqual([{ keys: "Enter", pane: THEME, noEnter: true }]);
    }
  });

  test("navigates the observed unnumbered menu once and confirms only the painted Yes selection", () => {
    const f = fixture([UNNUMBERED, UNNUMBERED, UNNUMBERED_SELECTED, UNNUMBERED_SELECTED, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent).toEqual([
      { keys: "Down", noEnter: true, pane: UNNUMBERED },
      { keys: "Enter", noEnter: true, pane: UNNUMBERED_SELECTED },
    ]);
  });

  test("confirms an already selected Yes without moving the selection", () => {
    const f = fixture([UNNUMBERED_SELECTED, READY]);
    clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui);
    expect(f.sent).toEqual([{ keys: "Enter", noEnter: true, pane: UNNUMBERED_SELECTED }]);
  });

  test("does not confirm when the requested menu navigation never repaints", () => {
    const f = fixture([UNNUMBERED]);
    expect(() => clearOwnedClaudeFixtureStartup(OWNED_HOME, ENV, f.ui))
      .toThrow("never reached a startup state");
    expect(f.sent).toEqual([{ keys: "Down", noEnter: true, pane: UNNUMBERED }]);
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
    `Bypass Permissions mode\nYes, I accept\n${READY}`,
    `Bypass Permissions mode\n❯ No, exit\nYes, I accept\nYes, I accept\n${READY}`,
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

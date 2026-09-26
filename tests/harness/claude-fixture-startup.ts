/** Startup handling for a Claude probe whose home was created by the test.
 * Never use this with an operator's profile: Claude can persist modal choices. */
import { claudePermissionNavigation } from "./tui-drive.ts";
import { LIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

interface FixtureStartupUI {
  capture(): string;
  send(keys: string, noEnter?: boolean): void;
  waitFor(pattern: string, timeoutMs: number): boolean;
  now?(): number;
}

// Match the complete observed upgrade dialog, including the numbered No choice.
// The offered version must agree with the confirmation question. A banner or an
// unrelated Yes/No dialog must never receive a numeric answer.
const MODEL_UPGRADE_MODAL =
  /(?:^|\n)[ \t]*Newer Opus model available\s+Currently pinned: Opus \d+(?:\.\d+)*\s+Latest available: Opus (\d+(?:\.\d+)*)(?:[ \t]+\([^\r\n)]+\))?\s+Update settings to use Opus \1\? Claude Code will restart to apply\.\s+(?:❯[ \t]*)?1\. Yes[ \t]*\r?\n[ \t]*(?:❯[ \t]*)?2\. No\s+Enter to confirm · Esc to cancel(?:\s|$)/;
const STARTUP_STATE =
  "trust this folder|Bypass Permissions mode|bypass permissions on|Newer Opus model available";

export function clearOwnedClaudeFixtureStartup(
  ownedUserHome: string,
  env: NodeJS.ProcessEnv,
  ui: FixtureStartupUI,
): void {
  if (
    env.HOME !== ownedUserHome ||
    env.USERPROFILE !== ownedUserHome ||
    env.CLAUDE_CONFIG_DIR !== undefined
  ) {
    throw new Error("Claude startup requires the test's isolated user profile");
  }

  const now = ui.now ?? Date.now;
  const deadline = now() + remainingOperationTimeoutMs(LIVE_STARTUP_TIMEOUT_MS, { env, phase: "Claude fixture startup" })!;
  const answered = new Set<string>();
  let permissionNavigated = false;
  let pane = "";
  while (now() < deadline) {
    const reached = ui.waitFor(STARTUP_STATE, Math.max(1, deadline - now()));
    pane = ui.capture();
    if (!reached) break;

    let modal: string;
    let keys: string;
    if (MODEL_UPGRADE_MODAL.test(pane)) {
      modal = "model-upgrade";
      keys = "2"; // No: retain the provider's pinned model.
    } else if (/Newer Opus model available/.test(pane)) {
      // A partial/reworded upgrade dialog may cover an already-painted footer.
      // Wait for the complete signature; never treat that footer as readiness.
      continue;
    } else if (/trust this folder/i.test(pane)) {
      modal = "trust";
      keys = "1";
    } else if (/Bypass Permissions mode/.test(pane)) {
      // Current Claude paints unnumbered options. Navigate once, then require a
      // fresh complete menu with Yes selected before sending Enter separately.
      const navigation = claudePermissionNavigation(pane);
      if (!navigation || answered.has("permissions")) continue;
      if (navigation === "Enter") {
        ui.send("Enter", true);
        answered.add("permissions");
      } else if (!permissionNavigated) {
        ui.send(navigation, true);
        permissionNavigated = true;
      }
      continue;
    } else if (/(?:^|\n)[ \t]*(?:❯[ \t]*)?\d+\. |Enter to confirm/.test(pane)) {
      // An unrelated dialog can also cover the footer. Leave it unanswered.
      continue;
    } else if (/bypass permissions on/.test(pane)) {
      return;
    } else {
      continue;
    }

    // Slow repaints must not spill a second numeric answer into the prompt.
    if (!answered.has(modal)) {
      ui.send(keys);
      answered.add(modal);
    }
  }
  throw new Error(`Claude TUI never reached a startup state.\n${pane}`);
}

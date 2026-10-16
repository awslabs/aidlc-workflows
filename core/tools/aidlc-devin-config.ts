// core/tools/aidlc-devin-config.ts — the Devin `read_config_from` contract.
//
// Devin documents seven compatibility-import sources
// (read-config-from.mdx:138-146 in the 3000.10.31 doc bundle); every one
// defaults to enabled and `null` counts as `true`, so the shipped project
// config.json states an explicit boolean for each. `agents_standard` stays
// `true` — it is the only channel by which Devin reads the rendered
// AGENTS.md onboarding file.
//
// `windsurf` stays `true` too: on 3000.10.21 through 3000.11.3 the setting
// ALSO gates `.devin/rules` (and `.devin/global_rules.md`) delivery — with it
// `false`, Devin lists the always-on files but never delivers them to the
// chat, including a lone 60-byte rule (measured 2026-10-15 on
// 3000.10.31/11.1/11.3). 3000.11.92 delivers `.devin/rules` either way.
// The Windsurf channel itself imports a user's own `.windsurf/` rules,
// skills, and `~/.codeium/windsurf/` files — an accepted side effect: no
// AI-DLC harness writes `.windsurf/`, so the sibling-twin reason for the
// other `false` keys does not apply.
//
// The shared constants feed three consumers: the t331 pin, the packager's
// drift guard (scripts/package.ts rewriteDevinNativePermissions), and the
// doctor's two advisory rows in aidlc-utility.ts. When Devin documents a new
// import source, this module and harness/devin/config.json are the one place
// to update.
//
// Observed precedence for this setting: on ≤3000.11.3 it is user > project >
// project-local — the reverse of the documented table — so a user-level
// config.json can re-enable an import the project file disables. From
// 3000.11.92 a `false` at ANY layer wins, so the project file can no longer
// be overridden from the user side (measured 2026-10-15 on `devin skills
// list` with a planted .claude skill). That is why the doctor reports the
// user layer separately, version-aware.

import { join } from "node:path";
import { homedir } from "node:os";

/** The seven documented `read_config_from` keys, in the order of Devin's
 *  options table (read-config-from.mdx:138-146). */
export const DEVIN_IMPORT_SOURCES = [
  "agents_standard",
  "cursor",
  "windsurf",
  "claude",
  "copilot",
  "opencode",
  "zed",
] as const;

/** The shipped decision: `agents_standard` (the channel Devin reads the
 *  rendered AGENTS.md through) and `windsurf` (which older builds also use
 *  to gate `.devin/rules` delivery — see the header) are on. */
export const DEVIN_IMPORT_EXPECTED: Record<string, boolean> = {
  agents_standard: true,
  cursor: false,
  windsurf: true,
  claude: false,
  copilot: false,
  opencode: false,
  zed: false,
};

export interface DevinImportAudit {
  /** Documented keys absent from the object's `read_config_from`. */
  missing: string[];
  /** Documented keys explicitly set to `null` (Devin reads `null` as `true`). */
  nullValued: string[];
  /** Keys the shipped config sets `false` whose effective value here is not
   *  `false` — absent and `null` both count, because Devin treats them as
   *  enabled. Keys the shipped config expects `true` are ignored. */
  enabled: string[];
}

/** Compare one parsed config.json against the shipped read_config_from
 *  contract. Accepts either the whole parsed file or its `read_config_from`
 *  sub-object; a missing/non-object block means every key is at its default. */
export function auditDevinImportConfig(raw: unknown): DevinImportAudit {
  let rcf: unknown = raw;
  if (
    raw !== null &&
    typeof raw === "object" &&
    "read_config_from" in (raw as Record<string, unknown>)
  ) {
    rcf = (raw as Record<string, unknown>).read_config_from;
  }
  const obj =
    rcf !== null && typeof rcf === "object"
      ? (rcf as Record<string, unknown>)
      : {};
  const missing: string[] = [];
  const nullValued: string[] = [];
  const enabled: string[] = [];
  for (const key of DEVIN_IMPORT_SOURCES) {
    const value = obj[key];
    if (!(key in obj)) missing.push(key);
    if (value === null) nullValued.push(key);
    if (DEVIN_IMPORT_EXPECTED[key] === false && value !== false) enabled.push(key);
  }
  return { missing, nullValued, enabled };
}

/** The user-level Devin config path: $XDG_CONFIG_HOME/devin/config.json,
 *  else ~/.config/devin/config.json; %APPDATA%\devin\config.json on Windows
 *  (global-vs-local.mdx:21,190). Injectable for tests. */
export function userDevinConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "devin", "config.json");
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "devin", "config.json");
}

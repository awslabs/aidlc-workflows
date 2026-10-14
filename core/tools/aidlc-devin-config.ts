// core/tools/aidlc-devin-config.ts — the Devin `read_config_from` contract.
//
// Devin documents seven compatibility-import sources
// (read-config-from.mdx:138-146 in the 3000.10.31 doc bundle); every one
// defaults to enabled and `null` counts as `true`, so the shipped project
// config.json states an explicit boolean for each. `agents_standard` stays
// `true` — it is the only channel by which Devin reads the rendered
// AGENTS.md onboarding file.
//
// The shared constants feed three consumers: the t331 pin, the packager's
// drift guard (scripts/package.ts rewriteDevinNativePermissions), and the
// doctor's two advisory rows in aidlc-utility.ts. When Devin documents a new
// import source, this module and harness/devin/config.json are the one place
// to update.
//
// Observed precedence for this setting on 3000.6.14/3000.10.21/3000.10.31/
// 3000.11.1 is user > project > project-local — the reverse of the documented
// table — so a user-level config.json can re-enable an import the project
// file disables. That is why the doctor reports the user layer separately.

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

/** The shipped decision: only `agents_standard` is on. */
export const DEVIN_IMPORT_EXPECTED: Record<string, boolean> = {
  agents_standard: true,
  cursor: false,
  windsurf: false,
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
  /** Non-`agents_standard` keys whose effective value is not `false` —
   *  absent and `null` both count, because Devin treats them as enabled. */
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
    if (key !== "agents_standard" && value !== false) enabled.push(key);
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

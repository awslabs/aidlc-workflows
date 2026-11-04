// aidlc-launcher-voucher.ts: the one-use vouchers that let Copilot CLI's
// `.aidlc/bin/aidlc-engine` launcher run a command.
//
// Copilot allows a shell command by its name only, so AI-DLC's skill allows the
// launcher's path and the Copilot adapter sends the engine commands it vouches
// for under that name. The adapter records a voucher for the exact words it
// sends; the dispatcher, entered from the launcher, runs only words with a
// voucher and spends it. With the repository's hooks off (an organisation that
// allows managed hooks only) no voucher is ever written, so every launcher call
// is refused with the plain command to run, which Copilot asks about as before.
// One rule, the adapter's vouching, checked at the second boundary here.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sessionsDir } from "./aidlc-record-core.ts";

/** The variable the launcher sets to its own path before it starts the engine. */
export const LAUNCHER_ENV = "AIDLC_ENGINE_LAUNCHER";
/** The launcher's path from the project folder, as the skill's rule names it. */
export const LAUNCHER_PATH = ".aidlc/bin/aidlc-engine";
// A voucher outlives a Copilot dialog the person takes a while over (the skill
// not loaded yet), and no longer.
const VOUCHER_TTL_MS = 15 * 60_000;

function voucherDir(projectDir: string): string {
  return join(sessionsDir(projectDir), "launcher-vouchers");
}

function voucherKey(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex").slice(0, 32);
}

/** The launcher's file as this release ships it, for the channel's own engine prefix. */
export function launcherBody(invocation: string): string {
  return `#!/bin/sh\nexport ${LAUNCHER_ENV}="$0"\nexec ${invocation} engine "$@"\n`;
}

/** Records one voucher for the dispatcher argv (`engine ...`) the launcher will be handed. */
export function recordLauncherVoucher(projectDir: string, argv: readonly string[]): void {
  const dir = voucherDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    try { if (now - statSync(join(dir, name)).mtimeMs > VOUCHER_TTL_MS) unlinkSync(join(dir, name)); }
    catch { /* another process spent or swept it */ }
  }
  writeFileSync(join(dir, `${voucherKey(argv)}-${randomUUID()}.json`), `${JSON.stringify({ at: new Date(now).toISOString() })}\n`);
}

/**
 * True while a voucher the hook recorded is fresh and unspent: the launcher
 * call it was for did not run (a rule denied it, or the person said no).
 */
export function launcherVoucherUnspent(projectDir: string): boolean {
  const dir = voucherDir(projectDir);
  try { return readdirSync(dir).some((name) => Date.now() - statSync(join(dir, name)).mtimeMs <= VOUCHER_TTL_MS); }
  catch { return false; }
}

/**
 * Spends one voucher for `argv`, the dispatcher's own arguments, when the
 * launcher at `launcherPath` (its `$0`, read from the working folder) started
 * it. False when there is none: the hooks did not send these words.
 */
export function spendLauncherVoucher(launcherPath: string, argv: readonly string[]): boolean {
  const projectDir = resolve(dirname(resolve(launcherPath)), "..", "..");
  const dir = voucherDir(projectDir);
  const prefix = `${voucherKey(argv)}-`;
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.startsWith(prefix)); }
  catch { return false; }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const fresh = Date.now() - statSync(file).mtimeMs <= VOUCHER_TTL_MS;
      unlinkSync(file);
      if (fresh) return true;
    } catch { /* spent by a racing call: try the next */ }
  }
  return false;
}

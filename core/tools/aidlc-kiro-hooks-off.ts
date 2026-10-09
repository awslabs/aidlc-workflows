// AI-DLC hooks a person switched off in Kiro. Kiro IDE's Agent Hooks panel
// turns a project hook off by writing `"enabled": false` into its file under
// `.kiro/hooks/` (Kiro's hook schema: an optional boolean, true when absent);
// Kiro CLI's `.kiro.hook` files carry the same key. A hook that is off runs
// nothing, and until now nothing in AI-DLC read the key: a switched-off guard
// stopped guarding with no word to anyone, and a switched-off reply hook read
// as a reply the hooks missed (#2203).
//
// The person drives: their switch stands, and AI-DLC never turns a hook back
// on. What it owes them is to say which check is off, since when, and the one
// step that turns it back on, in Kiro's words: as a doctor row, as one line
// from the engine's next step (once per change), and in place of the
// missed-reply step when the reply hook is the one that is off. Every read
// here fails open: it can only ever change a sentence.
// The reading (which files, Kiro's key, the file time) lives in aidlc-lib.ts,
// which the hooks are copied beside with its known siblings; this file holds
// the words and imports the reader, and the library never imports this file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  KIRO_REPLY_HOOK,
  type KiroHookSwitch,
  kiroHooksSwitchedOff as readKiroHooksSwitchedOff,
} from "./aidlc-lib.ts";

export { KIRO_HOOK_FILES, KIRO_REPLY_HOOK, kiroReplyHookSwitchedOff } from "./aidlc-lib.ts";

// What each AI-DLC hook does for the person, and what stops while it is off,
// in the words the lines use; one entry per name in KIRO_HOOK_FILES.
const KIRO_HOOK_PROTECTS: Record<string, { what: string; off: string }> = {
  "aidlc-guard-tool-call": {
    what: "check on the assistant's file changes, commands and helpers",
    off: "approvals, the approved plan and AI-DLC's records are not protected",
  },
  [KIRO_REPLY_HOOK]: {
    what: "hook that records your replies",
    off: "your answers to AI-DLC's questions are not seen",
  },
  "aidlc-continue-workflow": {
    what: "hook that notices a turn ending with work pending",
    off: "AI-DLC does not notice when the assistant stops with work left",
  },
  "aidlc-session-start": {
    what: "hook that gives each new chat its workflow context",
    off: "a new chat starts without AI-DLC's context",
  },
  "aidlc-log-subagent": {
    what: "hook that records a helper's finished work",
    off: "helpers' work is not recorded",
  },
  "aidlc-plan-approval-guard": {
    what: "check that keeps code changes to the approved plan",
    off: "code changes are not held to the approved plan",
  },
};

export type KiroHookOff = KiroHookSwitch & { what: string; off: string };

export const KIRO_HOOKS_OFF_STEP = "To turn it back on, enable it under Agent Hooks in Kiro.";

/**
 * Every hook file of AI-DLC's own under `<harnessDir>/hooks/` that Kiro has
 * switched off, with what each one does for the person. Nothing on another
 * harness, or in a project with no Kiro hooks directory.
 */
export function kiroHooksSwitchedOff(projectDir: string, harnessDir = ".kiro"): KiroHookOff[] {
  return readKiroHooksSwitchedOff(projectDir, harnessDir).map((hook) => ({ ...hook, ...KIRO_HOOK_PROTECTS[hook.name] }));
}

// The time as the person would say it: today's clock time, else the date too.
function clock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an earlier session";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** The one line the person hears while a hook is off: what it is for, since when, what stops, and the way back. */
export function kiroHookOffLine(hook: KiroHookOff, now: Date = new Date()): string {
  return `AI-DLC's ${hook.what} is switched off in Kiro's Agent Hooks (${hook.name}) since ${clock(hook.since, now)}: ` +
    `${hook.off} while it is off. ${KIRO_HOOKS_OFF_STEP}`;
}

/** Doctor: one failing row per hook that is off, naming the step. None when every hook is on. */
export function kiroHooksOffDoctorChecks(
  projectDir: string,
  harnessDir: string,
): Array<{ pass: boolean; label: string; fix?: string }> {
  if (harnessDir !== ".kiro") return [];
  return kiroHooksSwitchedOff(projectDir, harnessDir).map((hook) => ({
    pass: false,
    label: `AI-DLC hook ${hook.name} is switched off in Kiro's Agent Hooks: ${hook.off} while it is off`,
    fix: "turn it back on under Agent Hooks in Kiro",
  }));
}

// The engine's next step says each switch-off once: the said mark keeps, per
// hook, the file time it was said for, so a hook turned back on and off again
// is a new change that is said again. The record lives beside the sessions
// (aidlc-lib.ts sessionsDir: `aidlc/.aidlc-sessions`), and a torn or missing
// record only has the line said once more.
const SAID_FILE = "kiro-hooks-off-said.json";

function saidPath(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-sessions", SAID_FILE);
}

function readSaid(projectDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(saidPath(projectDir), "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** The lines the engine's next step carries: each hook off that no step has said at this file time. */
export function kiroHooksOffNotices(projectDir: string, harnessDir = ".kiro", now: Date = new Date()): string[] {
  const said = readSaid(projectDir);
  return kiroHooksSwitchedOff(projectDir, harnessDir)
    .filter((hook) => said[hook.name] !== hook.since)
    .map((hook) => kiroHookOffLine(hook, now));
}

/** Keep that a step said them; a hook back on leaves the record, so its next switch-off is said again. */
export function markKiroHooksOffSaid(projectDir: string, harnessDir = ".kiro"): void {
  try {
    const off = kiroHooksSwitchedOff(projectDir, harnessDir);
    const record = Object.fromEntries(off.map((hook) => [hook.name, hook.since]));
    const current = readSaid(projectDir);
    if (JSON.stringify(record) === JSON.stringify(current)) return;
    const path = saidPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Advisory: without the mark the line is said once more.
  }
}

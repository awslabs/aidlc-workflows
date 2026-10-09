// What the engine's next step says, once per change, about an AI-DLC hook the
// person switched off in Kiro's Agent Hooks (#2203). Kiro writes
// `"enabled": false` into the hook's file and the hook runs nothing; a person
// who did that after a flood of hook cards ran six Units with no guard and no
// word from anyone. Doctor's rows (aidlc-utility.ts, kiroDisabledHookChecks)
// name each hook that is off; this file gives the engine the same reading,
// with the file's time, so the step the person is on says it once and says it
// again only after the hook was on and off again, like a switched-off fence.
// The person drives: their switch stands, and AI-DLC never turns a hook back
// on. Every read fails open: it can only ever change a sentence.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type KiroDisabledHook, kiroDisabledHooks } from "./aidlc-utility.ts";

export const KIRO_HOOKS_OFF_STEP = "Turn it back on under Kiro's Agent Hooks.";

export type KiroHookOff = KiroDisabledHook & {
  /** When the file was last written: the switch, as near as the record gets. */
  since: string;
};

/**
 * The flow-altering AI-DLC hooks Kiro has switched off, each with its file's
 * time. The hooks doctor only warns about are left to doctor: the step says
 * what costs the person a protection, not every record it stops keeping.
 * Nothing on another harness.
 */
export function kiroHooksOff(projectDir: string, harnessDir = ".kiro"): KiroHookOff[] {
  if (harnessDir !== ".kiro") return [];
  const off: KiroHookOff[] = [];
  for (const hook of kiroDisabledHooks(projectDir, harnessDir)) {
    if (hook.protects === null) continue;
    try {
      off.push({ ...hook, since: statSync(join(projectDir, hook.file)).mtime.toISOString() });
    } catch {
      // Fails open: a file whose time cannot be read says nothing.
    }
  }
  return off;
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

/** The one line the person hears: the hook, since when, what is no longer protected, and the way back, in doctor's words. */
export function kiroHookOffLine(hook: KiroHookOff, now: Date = new Date()): string {
  return `AI-DLC hook ${hook.name} is switched off in Kiro's Agent Hooks since ${clock(hook.since, now)}: ` +
    `${hook.protects}. ${KIRO_HOOKS_OFF_STEP}`;
}

// The said mark keeps, per hook, the file time the line was said for, so a hook
// turned back on and off again is a new change that is said again. It lives
// beside the sessions (aidlc-lib.ts sessionsDir: `aidlc/.aidlc-sessions`); a
// torn or missing record only has the line said once more.
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
  return kiroHooksOff(projectDir, harnessDir)
    .filter((hook) => said[hook.name] !== hook.since)
    .map((hook) => kiroHookOffLine(hook, now));
}

/** Keep that a step said them; a hook back on leaves the record, so its next switch-off is said again. */
export function markKiroHooksOffSaid(projectDir: string, harnessDir = ".kiro"): void {
  try {
    const record = Object.fromEntries(kiroHooksOff(projectDir, harnessDir).map((hook) => [hook.name, hook.since]));
    const current = readSaid(projectDir);
    if (JSON.stringify(record) === JSON.stringify(current)) return;
    const path = saidPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Advisory: without the mark the line is said once more.
  }
}

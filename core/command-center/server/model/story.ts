import type { AuditEvent, StoryEvent } from "../types";

/** Events counted per stage (hiddenCounts) but kept out of the story. */
export const HIDDEN_EVENTS: ReadonlySet<string> = new Set(["SENSOR_PASSED", "SENSOR_FIRED", "HUMAN_TURN"]);

/** The story projection used by both `/api/intent` (buildIntent) and the live `intent` deltas (LiveHub). */
export function storyEvents(events: AuditEvent[]): StoryEvent[] {
  return events.filter((e) => e.event && !HIDDEN_EVENTS.has(e.event)).map((e) => ({
    ts: e.ts, kind: e.event!, stage: e.fields.Stage ?? e.fields["Stage slug"] ?? null, unit: e.fields.Unit ?? null,
    text: e.fields.Details ?? e.fields.Reason ?? e.fields.Feedback ?? e.fields["User Input"] ?? e.fields.File ?? e.fields.Decision ?? "", raw: e,
  }));
}

/** A recorded token count (`Tokens In` / `Tokens Out`): a finite, non-negative number (commas allowed), else null. */
export function tokenCount(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}

/** STAGE_COMPLETED events whose `Tokens In` is a valid count: the audit-side token source. */
export const tokenEvents = (events: AuditEvent[]): AuditEvent[] => events.filter((e) => e.event === "STAGE_COMPLETED" && tokenCount(e.fields["Tokens In"]) !== null);

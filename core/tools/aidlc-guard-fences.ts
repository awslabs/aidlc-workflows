// A fence is a hook that refuses an action nobody directed: no engine
// instruction covers it and no human grant is newer than the engine's last
// directive. The policy word lowers a fixed set. Chat can raise a fence with
// `/aidlc config set guard.<fence> on`; lowering comes from scope policy,
// compatible persisted state, or a harness environment switch because hook
// prompt text is not authenticated. Human presence is not touched by the policy
// word and has no in-band switch.
export const GUARD_FENCES = [
  "plan-approval",
  "review-freeze",
  "state-transition",
  "reviewer-scope",
  "human-presence",
] as const;
export type GuardFence = (typeof GUARD_FENCES)[number];

export const SWITCHABLE_GUARD_FENCES = [
  "plan-approval",
  "review-freeze",
  "state-transition",
  "reviewer-scope",
] as const;
export type SwitchableGuardFence = (typeof SWITCHABLE_GUARD_FENCES)[number];

export function isSwitchableGuardFence(value: unknown): value is SwitchableGuardFence {
  return typeof value === "string" && (SWITCHABLE_GUARD_FENCES as readonly string[]).includes(value);
}

/** Config keys of the per-run switches: `guard.plan-approval` and so on. */
export const GUARD_FENCE_CONFIG_PREFIX = "guard.";
export function guardFenceConfigKey(fence: SwitchableGuardFence): string {
  return `${GUARD_FENCE_CONFIG_PREFIX}${fence}`;
}
export function guardFenceFromConfigKey(key: string): SwitchableGuardFence | null {
  if (!key.startsWith(GUARD_FENCE_CONFIG_PREFIX)) return null;
  const fence = key.slice(GUARD_FENCE_CONFIG_PREFIX.length);
  return isSwitchableGuardFence(fence) ? fence : null;
}

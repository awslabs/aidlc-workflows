// covers: hook:aidlc-continue-workflow, hook:aidlc-session-start, hook:aidlc-record-human-turn, hook:aidlc-plan-approval-guard, hook:aidlc-write-audit-log
//
// A hook manifest names an adapter target. Nothing else checks that the target
// exists: `doctor` reports a healthy project, `graph compile --check` passes and
// the type checker never sees the string, because it travels from JSON through
// `aidlc engine adapter <harness> <target>` as plain argv. A manifest naming a
// target the adapter does not implement therefore fails at run time only - and
// for a PreToolUse gate it fails OPEN, because an adapter with no handler
// returns null and the dispatcher exits 0.
//
// This walks every shipped manifest against its adapter's target set, in both
// directions, so a rename or a row merge cannot silently unwire a hook.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Rows whose hooks register through standalone manifests that dispatch into an
// adapter. Discovered rather than hardcoded would be nicer, but the adapter path
// differs per row, so the pairing is stated.
const SUBJECTS = [
  { harness: "kiro", harnessDir: ".kiro", adapter: "hooks/aidlc-kiro-adapter.ts" },
] as const;

/** Targets a manifest asks for, keyed by the manifest file that asks. */
function manifestTargets(distRoot: string, harness: string, harnessDir: string) {
  const hooksDir = join(distRoot, harness, harnessDir, "hooks");
  const asked = new Map<string, string>();
  if (!existsSync(hooksDir)) return asked;
  for (const name of readdirSync(hooksDir).filter((n) => n.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(hooksDir, name), "utf-8")) as {
      hooks?: Array<{ action?: { command?: unknown } }>;
    };
    for (const hook of parsed.hooks ?? []) {
      const command = hook.action?.command;
      if (typeof command !== "string") continue;
      const match = command.match(
        new RegExp(`engine adapter ${harness}\\s+([a-z][a-z0-9-]*)`),
      );
      if (match) asked.set(match[1], name);
    }
  }
  return asked;
}

/** Targets the adapter implements. */
function adapterTargets(source: string) {
  const handled = new Set<string>();
  for (const match of source.matchAll(/target === "([a-z][a-z0-9-]*)"/g)) {
    handled.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)) {
    handled.add(match[1]);
  }
  return handled;
}

describe("t331 hook manifest target coverage", () => {
  for (const subject of SUBJECTS) {
    test(`${subject.harness}: every manifest target exists in the adapter`, () => {
      const adapterPath = join(REPO_ROOT, "harness", subject.harness, subject.adapter);
      expect(existsSync(adapterPath), adapterPath).toBe(true);
      const handled = adapterTargets(readFileSync(adapterPath, "utf-8"));
      expect(handled.size).toBeGreaterThan(0);

      const asked = manifestTargets(
        join(REPO_ROOT, "dist"),
        subject.harness,
        subject.harnessDir,
      );
      expect(asked.size, "no manifest dispatches into the adapter").toBeGreaterThan(0);

      const unimplemented = [...asked]
        .filter(([target]) => !handled.has(target))
        .map(([target, manifest]) => `${manifest} -> ${target}`)
        .sort();
      expect(unimplemented).toEqual([]);
    });

    // The row merge folded a second adapter in. Its targets are not reachable
    // from a manifest yet (the engine and the shipped shells call them), so the
    // coverage walk above cannot see them; naming them here keeps a later edit
    // from dropping one silently.
    test(`${subject.harness}: the adapter keeps the targets the merge brought in`, () => {
      const adapterPath = join(REPO_ROOT, "harness", subject.harness, subject.adapter);
      const handled = adapterTargets(readFileSync(adapterPath, "utf-8"));
      const required = [
        "audit-and-sensors",
        "continue-workflow",
        "deliver-stage-rules",
        "enforce-approval-gate",
        "guard-tool-call",
        "log-subagent",
        "plan-approval-guard",
        "rebuild-stage-graph",
        "record-human-turn",
        "review-freeze",
        "reviewer-scope",
        "session-end",
        "session-start",
        "state-transition-guard",
        "sync-workflow-state",
        "terminal-command-guard",
        "verb-intercept",
      ];
      expect(required.filter((target) => !handled.has(target))).toEqual([]);
    });

    test(`${subject.harness}: the manifests reach the adapter's own harness name`, () => {
      const hooksDir = join(REPO_ROOT, "dist", subject.harness, subject.harnessDir, "hooks");
      expect(existsSync(hooksDir), hooksDir).toBe(true);
      const strangers: string[] = [];
      for (const name of readdirSync(hooksDir).filter((n) => n.endsWith(".json")).sort()) {
        const text = readFileSync(join(hooksDir, name), "utf-8");
        for (const match of text.matchAll(/engine adapter ([a-z][a-z0-9-]*)/g)) {
          if (match[1] !== subject.harness) strangers.push(`${name} -> ${match[1]}`);
        }
      }
      expect(strangers).toEqual([]);
    });
  }
});

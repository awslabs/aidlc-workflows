// t308-hook-matcher-fixture: weak-direction drift gate for hook registrations.
//
// Every registered matcher in scope must select at least one tool_name that we
// have actually captured for that harness. This intentionally does not claim
// that every captured tool has a matcher. Kiro CLI is excluded because its
// agent-v1 matchers use glob and canonical-name/alias-family semantics; t148
// and PR #788 own that coverage with live-captured alias evidence. Claude is
// excluded because the repository has no captured Claude hook payload fixture.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

type JsonObject = Record<string, unknown>;

interface MatcherRegistration {
  event: string;
  matcher: string;
}

interface KiroIdeMatcherRegistration extends MatcherRegistration {
  file: string;
}

const CODEX_FIXTURE_GAPS = [
  {
    event: "PreToolUse",
    matcher: "spawn_agent",
    reason:
      "harness/codex/emit.ts:39-41 records this registration as verified live on Codex 0.142.5; #777 has no delegation capture yet",
  },
  {
    event: "PostToolUse",
    matcher: "request_user_input",
    reason:
      "harness/codex/emit.ts registers the structured-input human-turn seam added by #553; no live Codex request_user_input capture exists yet",
  },
] as const;

// Per-event captures and the log-subagent section in
// docs/reference/kiro-ide-hook-payload.md document these names, including the
// 1.x delegation shapes captured for #543.
const KIRO_IDE_OBSERVED_TOOLS = [
  "fs_write",
  "str_replace",
  "fs_append",
  "execute_bash",
  "invoke_sub_agent",
  "subagent_quality-agent",
  "subagent_response",
] as const;

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
}

function fixtureToolNames(harness: "codex" | "copilot" | "cursor"): string[] {
  const fixture = readJson(
    join(REPO_ROOT, "tests", "fixtures", `${harness}-hook-payloads`, "payloads.json"),
  );
  const names = Object.values(fixture).flatMap((payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return [];
    }
    const toolName = (payload as JsonObject).tool_name;
    return typeof toolName === "string" ? [toolName] : [];
  });
  const uniqueNames = [...new Set(names)].sort();
  expect(
    uniqueNames.length,
    `${harness} captured payload fixture must expose at least one tool_name`,
  ).toBeGreaterThan(0);
  return uniqueNames;
}

function eventGroups(document: JsonObject, source: string): Record<string, unknown[]> {
  const hooks = document.hooks;
  expect(hooks, `${source} must contain a hooks object`).toBeDefined();
  expect(typeof hooks, `${source} hooks must be an object`).toBe("object");
  expect(Array.isArray(hooks), `${source} hooks must not be an array`).toBe(false);

  const events = hooks as Record<string, unknown>;
  expect(Object.keys(events).length, `${source} must register at least one event`).toBeGreaterThan(0);
  const groups: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(events)) {
    expect(Array.isArray(entries), `${source} event ${event} must be an array`).toBe(true);
    groups[event] = entries as unknown[];
  }
  return groups;
}

function matcherRegistrations(document: JsonObject, source: string): MatcherRegistration[] {
  const registrations: MatcherRegistration[] = [];
  for (const [event, groups] of Object.entries(eventGroups(document, source))) {
    for (const group of groups) {
      if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
      if (!Object.hasOwn(group, "matcher")) continue;
      const matcher = (group as JsonObject).matcher;
      expect(typeof matcher, `${source} ${event} matcher must be a string`).toBe("string");
      registrations.push({ event, matcher: matcher as string });
    }
  }
  return registrations;
}

function selectedLiteralNames(matcher: string, toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => name === matcher);
}

function selectedPatternNames(matcher: string, toolNames: readonly string[]): string[] {
  const pattern = new RegExp(matcher);
  return toolNames.filter((name) => {
    pattern.lastIndex = 0;
    return pattern.test(name);
  });
}

describe("t308 hook registration matchers select captured fixture tool names", () => {
  test("Codex matcher registrations reach captures or an explicit fixture gap", () => {
    const source = "dist/codex/.codex/hooks.json";
    const registrations = matcherRegistrations(
      readJson(join(REPO_ROOT, source)),
      source,
    );
    const toolNames = fixtureToolNames("codex");
    expect(registrations.length, "Codex must retain matcher-bearing registrations").toBeGreaterThan(0);

    for (const registration of registrations) {
      const gap = CODEX_FIXTURE_GAPS.find(
        (entry) =>
          entry.event === registration.event &&
          entry.matcher === registration.matcher,
      );
      if (gap) continue;
      expect(
        selectedLiteralNames(registration.matcher, toolNames),
        `Codex ${registration.event}/${registration.matcher} must select a captured tool_name`,
      ).not.toEqual([]);
    }

    for (const gap of CODEX_FIXTURE_GAPS) {
      expect(
        registrations.some(
          (registration) =>
            registration.event === gap.event &&
            registration.matcher === gap.matcher,
        ),
        gap.reason,
      ).toBe(true);
      expect(
        selectedLiteralNames(gap.matcher, toolNames),
        `${gap.reason}; remove this fixture-gap entry once a capture lands`,
      ).toEqual([]);
    }
  });

  test("Kiro IDE matcher-bearing manifests reach observed tool names", () => {
    const hooksDir = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks");
    const registrations: KiroIdeMatcherRegistration[] = [];
    for (const file of readdirSync(hooksDir).filter(
      (entry) => entry.startsWith("aidlc-") && entry.endsWith(".json"),
    )) {
      const document = readJson(join(hooksDir, file));
      expect(document.version, `${file} must use the Kiro IDE v2 manifest`).toBe("v1");
      const hooks = document.hooks;
      expect(Array.isArray(hooks), `${file} hooks must be an array`).toBe(true);
      for (const hook of hooks as unknown[]) {
        if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
        if (!Object.hasOwn(hook, "matcher")) continue;
        const entry = hook as JsonObject;
        expect(typeof entry.matcher, `${file} matcher must be a string`).toBe("string");
        expect(typeof entry.trigger, `${file} matcher requires a trigger`).toBe("string");
        registrations.push({
          file,
          event: entry.trigger as string,
          matcher: entry.matcher as string,
        });
      }
    }

    expect(new Set(registrations.map((registration) => registration.file)).size).toBe(4);
    for (const registration of registrations) {
      expect(
        selectedPatternNames(registration.matcher, KIRO_IDE_OBSERVED_TOOLS),
        `${registration.file} ${registration.event}/${registration.matcher} must select an observed tool name`,
      ).not.toEqual([]);
    }
  });

  for (const harness of ["cursor", "copilot"] as const) {
    test(`${harness} discovers future matchers and checks them against captured tools`, () => {
      const source =
        harness === "cursor"
          ? "dist/cursor/.cursor/hooks.json"
          : "dist/copilot/.github/hooks/aidlc.json";
      const registrations = matcherRegistrations(
        readJson(join(REPO_ROOT, source)),
        source,
      );
      const toolNames = fixtureToolNames(harness);

      for (const registration of registrations) {
        expect(
          selectedPatternNames(registration.matcher, toolNames),
          `${harness} ${registration.event}/${registration.matcher} must select a captured tool_name`,
        ).not.toEqual([]);
      }
    });
  }
});

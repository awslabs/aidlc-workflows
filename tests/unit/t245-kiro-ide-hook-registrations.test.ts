// t245-kiro-ide-hook-registrations: structural contract test for the v2 hook
// JSON files shipped in dist/kiro-ide/.kiro/hooks/. Ensures every registration
// is valid JSON with the expected version, trigger, matcher, and adapter
// command — so a typo cannot silently disable a hook while the suite stays
// green (packaging parity only proves authored=generated, not correctness).
//
// Also pins: session-end has NO v2 registration (the IDE's Stop trigger is
// turn-scoped, not session-scoped), and all legacy .kiro.hook files are present.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTHORED_HOOKS = join(REPO_ROOT, "harness", "kiro-ide", "hooks");
const DIST_HOOKS = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks");

interface HookEntry {
  name: string;
  trigger: string;
  matcher?: string;
  action: { type: string; command: string };
  description?: string;
}

interface HookFile {
  version: string;
  hooks: HookEntry[];
}

// The pinned contract: every v2 hook JSON that MUST ship, with its expected
// trigger, optional matcher regex, and the adapter target embedded in its
// command string.
const EXPECTED_V2_REGISTRATIONS: Array<{
  file: string;
  trigger: string;
  matcher: string | null;
  adapterTarget: string;
}> = [
  { file: "aidlc-session-start.json", trigger: "SessionStart", matcher: null, adapterTarget: "session-start" },
  { file: "aidlc-mint.json", trigger: "UserPromptSubmit", matcher: null, adapterTarget: "mint" },
  { file: "aidlc-block.json", trigger: "PreToolUse", matcher: null, adapterTarget: "block" },
  { file: "aidlc-audit-logger.json", trigger: "PostToolUse", matcher: "fs_write|str_replace|fs_append", adapterTarget: "audit-and-sensors" },
  { file: "aidlc-runtime-compile.json", trigger: "PostToolUse", matcher: "execute_bash", adapterTarget: "runtime-compile" },
  { file: "aidlc-sync-statusline.json", trigger: "PostToolUse", matcher: "execute_bash", adapterTarget: "state-sync" },
  { file: "aidlc-log-subagent.json", trigger: "PostToolUse", matcher: "^(subagent_.+|invoke_sub_agent)$", adapterTarget: "log-subagent" },
  { file: "aidlc-stop.json", trigger: "Stop", matcher: null, adapterTarget: "stop" },
];

// Legacy .kiro.hook files that MUST be present (coexistence with pre-1.0 IDE).
const EXPECTED_LEGACY_FILES = [
  "aidlc-audit-logger.kiro.hook",
  "aidlc-block.kiro.hook",
  "aidlc-log-subagent.kiro.hook",
  "aidlc-mint.kiro.hook",
  "aidlc-runtime-compile.kiro.hook",
  "aidlc-session-end.kiro.hook",
  "aidlc-session-start.kiro.hook",
  "aidlc-stop.kiro.hook",
  "aidlc-sync-statusline.kiro.hook",
];

function parseHookJson(dir: string, file: string): HookFile {
  const path = join(dir, file);
  expect(existsSync(path), `${file} must exist`).toBe(true);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as HookFile;
  return parsed;
}

describe("t245 Kiro IDE hook registrations (v2 schema contract)", () => {
  for (const tree of [
    { name: "authored (harness/kiro-ide/hooks)", dir: AUTHORED_HOOKS },
    { name: "dist (dist/kiro-ide/.kiro/hooks)", dir: DIST_HOOKS },
  ]) {
    describe(tree.name, () => {
      for (const reg of EXPECTED_V2_REGISTRATIONS) {
        test(`${reg.file}: version=v1, trigger=${reg.trigger}, matcher=${reg.matcher ?? "none"}, target=${reg.adapterTarget}`, () => {
          const parsed = parseHookJson(tree.dir, reg.file);
          expect(parsed.version).toBe("v1");
          expect(parsed.hooks.length).toBe(1);
          const hook = parsed.hooks[0];
          expect(hook.trigger).toBe(reg.trigger);
          if (reg.matcher) {
            expect(hook.matcher).toBe(reg.matcher);
          } else {
            expect(hook.matcher).toBeUndefined();
          }
          expect(hook.action.type).toBe("command");
          expect(hook.action.command).toContain(`aidlc-kiro-adapter.ts ${reg.adapterTarget}`);
        });
      }

      // The matcher is deliberately BROAD; the `subagent_response` exclusion is
      // the ADAPTER's job (pinned by t218 N5b), because the direct and
      // dispatcher entry points bypass this matcher entirely. Narrowing the
      // regex here — e.g. requiring a trailing `-agent` — would silently drop
      // completions from fork-added delegates whose names differ. This test
      // pins the broad reach; it must NOT be "hardened" into an exclusion.
      test("log-subagent matcher reaches every observed delegate completion name", () => {
        const parsed = parseHookJson(tree.dir, "aidlc-log-subagent.json");
        const matcher = new RegExp(parsed.hooks[0].matcher ?? "");
        // The two forms captured live on IDE 0.12.333 and 1.0.89-1.0.138 (#459/#543).
        expect(matcher.test("invoke_sub_agent")).toBe(true);
        expect(matcher.test("subagent_aidlc-product-lead-agent")).toBe(true);
        expect(matcher.test("subagent_aidlc-developer-agent")).toBe(true);
        // A fork-added delegate that does not follow the aidlc-*-agent naming
        // must still reach the adapter.
        expect(matcher.test("subagent_my-custom-reviewer")).toBe(true);
        // Unrelated tools must not.
        expect(matcher.test("fs_write")).toBe(false);
        expect(matcher.test("execute_bash")).toBe(false);
      });

      test("session-end has NO v2 registration (Stop is turn-scoped, not session-scoped)", () => {
        expect(existsSync(join(tree.dir, "aidlc-session-end.json"))).toBe(false);
      });

      test("dispatch-rules has NO IDE registration (always-included steering is the delivery channel)", () => {
        expect(existsSync(join(tree.dir, "aidlc-dispatch-rules.json"))).toBe(
          false,
        );
      });

      test("no unexpected v2 hook JSONs beyond the pinned set", () => {
        const allJsons = readdirSync(tree.dir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".json"),
        );
        const expectedSet = new Set(EXPECTED_V2_REGISTRATIONS.map((r) => r.file));
        for (const f of allJsons) {
          expect(expectedSet.has(f), `unexpected v2 hook file: ${f}`).toBe(true);
        }
        expect(allJsons.length).toBe(EXPECTED_V2_REGISTRATIONS.length);
      });
    });
  }

  describe("legacy coexistence", () => {
    for (const legacy of EXPECTED_LEGACY_FILES) {
      test(`dist ships ${legacy}`, () => {
        expect(existsSync(join(DIST_HOOKS, legacy))).toBe(true);
      });
    }
  });
});

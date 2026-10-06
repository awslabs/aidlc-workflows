// covers: subcommand:aidlc-utility intent-create
//
// t343 - intent-create must refuse orphaned positionals instead of silently keeping a
// truncated description (#1114).
//
// The loss is unrecoverable, which is why a refusal beats a warning:
// project-description.json is written once at creation, `workspace project-description`
// returns it verbatim, intent-capture registers it as the `[desc]` source, and the
// claim-sources sensor derives `[desc]` from it. A prefix stored here is the workflow's
// source of truth for the rest of the run.
//
// Mechanism: the SHIPPED tool in a real temp project, driven through argv exactly as a
// shell would hand it over. The defect only exists at the argv boundary - parseArgs and
// shellArg are both correct in isolation - so an in-process unit test cannot see it.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

function run(project: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(process.execPath, [TOOL, ...args, "--project-dir", project], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    out: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

function description(project: string): { status: number; out: string } {
  return run(project, ["project-description"]);
}

/** Refusals are emitted as JSON, so assert on the decoded message rather than on
 *  escaped substrings of the wire form. */
function errorMessage(out: string): string {
  try {
    return String((JSON.parse(out.trim()) as { error?: unknown }).error ?? out);
  } catch {
    return out;
  }
}

describe("t343 intent-create refuses orphaned positionals", () => {
  test("an unquoted --arguments= is refused, not silently truncated", () => {
    if (!existsSync(TOOL)) return; // no materialized projection in this tree
    const project = setupIntegrationProject();
    // Exactly what a shell produces from `--arguments=deploy this to AWS ...`:
    // one attached flag holding the first word, then orphaned words.
    const created = run(project, [
      "intent-create", "--scope", "mvp",
      "--arguments=deploy", "this", "to", "AWS", "and", "also", "tidy",
      "--label", "demo",
    ]);
    expect(created.status).not.toBe(0);
    const message = errorMessage(created.out);
    expect(message).toContain("does not accept positional arguments");
    // The refusal must name the orphans, what would have been kept, and the remedy -
    // otherwise the reader cannot tell which half of their sentence vanished.
    expect(message).toContain('"this"');
    expect(message).toContain('"deploy"');
    expect(message).toContain('--arguments="<full description>"');
    // Refusing must not half-create: no state file means no intent was minted.
    expect(description(project).status).not.toBe(0);
  });

  test("the same text quoted as one argv token is stored whole", () => {
    if (!existsSync(TOOL)) return;
    const project = setupIntegrationProject();
    const text = "deploy this to AWS and also tidy the directory layout";
    const created = run(project, [
      "intent-create", "--scope", "mvp", `--arguments=${text}`, "--label", "demo",
    ]);
    expect(created.status, created.out).toBe(0);
    const stored = description(project);
    expect(stored.status, stored.out).toBe(0);
    expect(JSON.parse(stored.out).description).toBe(text);
  });

  test("the detached spelling is stored whole too", () => {
    if (!existsSync(TOOL)) return;
    const project = setupIntegrationProject();
    const text = "tidy the directory layout";
    const created = run(project, [
      "intent-create", "--scope", "mvp", "--arguments", text, "--label", "demo",
    ]);
    expect(created.status, created.out).toBe(0);
    expect(JSON.parse(description(project).out).description).toBe(text);
  });

  test("both creation spellings still work — the guard must not eat a verb token", () => {
    // A guard that counts every positional past the first rejects the two-token
    // `intent create` alias outright, because its `create` reads as an orphan.
    // Measured: the first version of this fix broke it, and a single-spelling
    // test missed it.
    if (!existsSync(TOOL)) return;
    for (const verb of [["intent-create"], ["intent", "create"]]) {
      const project = setupIntegrationProject();
      const text = `built via ${verb.join(" ")}`;
      const created = run(project, [
        ...verb, "--scope", "mvp", "--arguments", text, "--label", "demo",
      ]);
      expect(created.status, `${verb.join(" ")}: ${created.out}`).toBe(0);
      expect(JSON.parse(description(project).out).description).toBe(text);
    }
  });

  test("legacy init keeps its transition refusal instead of posing as intent-create", () => {
    if (!existsSync(TOOL)) return;
    const project = setupIntegrationProject();
    const result = run(project, ["init", "stray"]);
    expect(result.status).not.toBe(0);
    const message = errorMessage(result.out);
    expect(message).toContain("init now lays down the project data tree");
    expect(message).not.toContain("intent-create does not accept positional arguments");
  });

  test("the alias still refuses a genuine orphan past its verb", () => {
    if (!existsSync(TOOL)) return;
    const project = setupIntegrationProject();
    const created = run(project, [
      "intent", "create", "--scope", "mvp", "--arguments=deploy", "this", "--label", "d",
    ]);
    expect(created.status).not.toBe(0);
    const message = errorMessage(created.out);
    expect(message).toContain("does not accept positional arguments");
    expect(message).toContain('"this"');
    // "create" is part of the verb and must never be reported as an orphan.
    expect(message).not.toContain('"create"');
  });

  test("a stray positional without --arguments still refuses, with generic guidance", () => {
    if (!existsSync(TOOL)) return;
    const project = setupIntegrationProject();
    const created = run(project, ["intent-create", "--scope", "mvp", "stray"]);
    expect(created.status).not.toBe(0);
    const message = errorMessage(created.out);
    expect(message).toContain("does not accept positional arguments");
    expect(message).toContain("quoting any value that contains spaces");
  });
});

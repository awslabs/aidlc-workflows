// t241-opencode-adapter: execute the authored plugin factory against synthetic
// opencode lifecycle calls and real or purpose-built core hook subprocesses.
//
// covers: function:KNOWN_HARNESS_DIRS, hook:aidlc-runtime-compile

import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import createAdapter, {
  aidlcBashBoundaryViolation,
  applyPatchPaths,
  type PluginInput,
} from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshProject(): string {
  const root = mkdtempSync(join(tmpdir(), "t241-opencode-"));
  scratch.push(root);
  mkdirSync(join(root, ".aidlc", "hooks"), { recursive: true });
  mkdirSync(join(root, ".aidlc", "tools"), { recursive: true });
  return root;
}

function writeHook(root: string, name: string, source: string): void {
  const path = join(root, ".aidlc", "hooks", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
}

function copyCore(root: string, relativePath: string): void {
  const source = join(REPO_ROOT, "core", relativePath);
  const destination = join(root, ".aidlc", relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function fakeClient(parentBySession: Record<string, string | undefined> = {}) {
  const prompts: Array<{ id: string; text: string }> = [];
  const client: PluginInput["client"] = {
    session: {
      get: async ({ path }) => ({
        data: parentBySession[path.id]
          ? { parentID: parentBySession[path.id] }
          : {},
      }),
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, text: body.parts[0]?.text ?? "" });
      },
    },
  };
  return { client, prompts };
}

function postTool(tool: string, args: Record<string, unknown>) {
  return {
    tool,
    sessionID: "main",
    callID: `call-${tool}`,
    args,
  };
}

describe("t241 OpenCode adapter command boundary and transition filter", () => {
  test("rejects compound AIDLC bun commands but leaves one invocation and unrelated bash alone", async () => {
    expect(aidlcBashBoundaryViolation("bun .aidlc/tools/aidlc-state.ts approve")).toBeNull();
    expect(
      aidlcBashBoundaryViolation('bun .aidlc/tools/aidlc-utility.ts status "a && b"'),
    ).toBeNull();
    expect(aidlcBashBoundaryViolation("echo ok && touch /tmp/example")).toBeNull();
    expect(
      aidlcBashBoundaryViolation(
        "bun .aidlc/tools/aidlc-utility.ts status && touch /tmp/example",
      ),
    ).toContain("one direct bun invocation");
    expect(
      aidlcBashBoundaryViolation("bun .aidlc/hooks/example.ts > /tmp/example"),
    ).toContain("one direct bun invocation");

    const root = freshProject();
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const before = adapter["tool.execute.before"];
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "safe" },
        { args: { command: "bun .aidlc/tools/aidlc-state.ts approve" } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "compound" },
        {
          args: {
            command:
              "bun .aidlc/tools/aidlc-utility.ts status && touch /tmp/example",
          },
        },
      ),
    ).rejects.toThrow("one direct bun invocation");
  });

  test("an OpenCode state transition passes the real runtime hook command gate", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-runtime-compile.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    mkdirSync(join(root, "aidlc"), { recursive: true });
    writeFileSync(join(root, "aidlc", ".aidlc-hook-debug"), "", "utf-8");

    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    await adapter["tool.execute.after"](
      postTool("bash", {
        command: "bun .aidlc/tools/aidlc-state.ts approve",
      }),
    );

    const debug = readFileSync(
      join(
        root,
        "aidlc",
        "spaces",
        "default",
        "intents",
        ".aidlc-hooks-health",
        "hook-debug.log",
      ),
      "utf-8",
    );
    expect(debug).toContain("runtime-compile\texit: audit empty");
    expect(debug).not.toContain("exit: command not a transition tool");
  });
});

describe("t241 OpenCode adapter reviewer scope", () => {
  test("blocks a sibling-unit read and allows the dispatched unit", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-reviewer-scope.ts");
    copyCore(root, "tools/aidlc-audit.ts");
    copyCore(root, "tools/aidlc-lib.ts");

    const recordRoot = join(root, "aidlc", "spaces", "default", "intents");
    const current = join(recordRoot, "construction", "U01", "design.md");
    const sibling = join(recordRoot, "construction", "U02", "design.md");
    mkdirSync(dirname(current), { recursive: true });
    mkdirSync(dirname(sibling), { recursive: true });
    writeFileSync(current, "# current\n", "utf-8");
    writeFileSync(sibling, "# sibling\n", "utf-8");
    writeFileSync(
      join(recordRoot, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );

    const { client } = fakeClient({ reviewer: "main" });
    const adapter = await createAdapter({ client, directory: root });
    await adapter["chat.message"](
      {
        sessionID: "reviewer",
        agent: "aidlc-architecture-reviewer-agent",
      },
      { parts: [{ type: "text", text: "review" }] },
    );

    const before = adapter["tool.execute.before"];
    await expect(
      before(
        { tool: "read", sessionID: "reviewer", callID: "sibling" },
        { args: { filePath: sibling } },
      ),
    ).rejects.toThrow(/reviewer read-scope:/i);
    await expect(
      before(
        { tool: "read", sessionID: "reviewer", callID: "current" },
        { args: { filePath: current } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("t241 OpenCode adapter write and session lifecycle", () => {
  test("apply_patch emits audit then sensor calls for every affected path", async () => {
    const root = freshProject();
    const trace = join(root, "hook-calls.ndjson");
    for (const [file, label] of [
      ["aidlc-audit-logger.ts", "audit"],
      ["aidlc-sensor-fire.ts", "sensor"],
    ] as const) {
      writeHook(
        root,
        file,
        `import { appendFileSync } from "node:fs";
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`${label}\t`)} + input + "\\n", "utf-8");
`,
      );
    }
    const patchText = `*** Begin Patch
*** Add File: src/one.ts
+export const one = 1;
*** Update File: src/two.ts
@@
-old
+next
*** End Patch
`;
    expect(applyPatchPaths({ patchText })).toEqual(["src/one.ts", "src/two.ts"]);

    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    await adapter["tool.execute.after"](
      postTool("apply_patch", { patchText }),
    );

    const calls = readFileSync(trace, "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        const [label, payload] = line.split("\t", 2);
        return {
          label,
          path: (
            JSON.parse(payload) as { tool_input: { file_path: string } }
          ).tool_input.file_path,
        };
      });
    expect(calls).toEqual([
      { label: "audit", path: "src/one.ts" },
      { label: "sensor", path: "src/one.ts" },
      { label: "audit", path: "src/two.ts" },
      { label: "sensor", path: "src/two.ts" },
    ]);
  });

  test("session-start retries until an active workflow is available, then stops retrying", async () => {
    const root = freshProject();
    const marker = join(root, "workflow-active");
    const count = join(root, "session-start-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(count)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
if (existsSync(${JSON.stringify(marker)})) {
  process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
}
`,
    );
    writeHook(root, "aidlc-mint-presence.ts", "await Bun.stdin.text();\n");

    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const chat = adapter["chat.message"];
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "first" }] },
    );
    expect(readFileSync(count, "utf-8")).toBe("1");

    writeFileSync(marker, "", "utf-8");
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "second" }] },
    );
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "third" }] },
    );
    expect(readFileSync(count, "utf-8")).toBe("2");
  });

  test("concurrent idle events inject one nudge for a session", async () => {
    const root = freshProject();
    const stopCount = join(root, "stop-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
`,
    );
    writeHook(root, "aidlc-mint-presence.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-stop.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(stopCount)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
await Bun.sleep(100);
process.stdout.write(JSON.stringify({ decision: "block", reason: "continue" }) + "\\n");
`,
    );

    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    const idle = {
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    };
    await Promise.all([adapter.event(idle), adapter.event(idle)]);

    expect(readFileSync(stopCount, "utf-8")).toBe("1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("continue");
  });
});

// t241-opencode-adapter: execute the authored plugin factory against synthetic
// opencode lifecycle calls and real or purpose-built core hook subprocesses.
//
// covers: function:KNOWN_HARNESS_DIRS, hook:aidlc-runtime-compile

import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import createAdapter, {
  type PluginInput,
} from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
import {
  createTestProject,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TEST_ENTRYPOINTS = new Set([
  "tools/aidlc-state.ts",
  "tools/aidlc-utility.ts",
  "hooks/aidlc-stop.ts",
]);
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

function freshInstalledProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(
    join(REPO_ROOT, "dist", "opencode", ".aidlc"),
    join(root, ".aidlc"),
    { recursive: true },
  );
  return root;
}

function readAudit(root: string): string {
  const auditDir = seededAuditDir(root);
  return readdirSync(auditDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(auditDir, name), "utf-8"))
    .join("\n");
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
    const root = freshProject();
    const { client } = fakeClient();
    const adapter = await createAdapter({
      client,
      directory: root,
      aidlcEntrypoints: TEST_ENTRYPOINTS,
    });
    const before = adapter["tool.execute.before"];
    const invoke = (callID: string, command: string) =>
      before(
        { tool: "bash", sessionID: "main", callID },
        { args: { command } },
      );
    await expect(
      invoke("safe", "bun .aidlc/tools/aidlc-state.ts approve"),
    ).resolves.toBeUndefined();
    await expect(
      invoke("quoted", 'bun .aidlc/tools/aidlc-utility.ts status "a && b"'),
    ).resolves.toBeUndefined();
    await expect(
      invoke("unrelated", "echo ok && touch /tmp/example"),
    ).resolves.toBeUndefined();
    await expect(
      invoke(
        "compound",
        "bun .aidlc/tools/aidlc-utility.ts status && touch /tmp/example",
      ),
    ).rejects.toThrow("one direct invocation");
    await expect(
      invoke("redirect", "bun .aidlc/hooks/aidlc-stop.ts > /tmp/example"),
    ).rejects.toThrow("one direct invocation");
    await expect(
      invoke("unknown", "bun .aidlc/tools/payload.ts"),
    ).rejects.toThrow("shipped tool or hook");
    await expect(
      invoke(
        "quote-bypass",
        "bun .aidlc/tools/aidlc-utility.ts status 'a\\' ; touch /tmp/x #'",
      ),
    ).rejects.toThrow("one direct invocation");
  });

  test("an OpenCode state transition passes the real runtime hook command gate", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-runtime-compile.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");
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
    copyCore(root, "tools/aidlc-runtime-paths.ts");

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
    await expect(
      before(
        { tool: "list", sessionID: "reviewer", callID: "sibling-list" },
        { args: { path: dirname(sibling) } },
      ),
    ).rejects.toThrow(/reviewer read-scope:/i);
  });
});

describe("t241 OpenCode adapter state-transition guard", () => {
  test("blocks direct lifecycle verbs and allows read-only state queries", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-state-transition-guard.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");

    const { client } = fakeClient();
    const adapter = await createAdapter({
      client,
      directory: root,
      aidlcEntrypoints: new Set([
        ...TEST_ENTRYPOINTS,
        "tools/aidlc-orchestrate.ts",
      ]),
    });
    const before = adapter["tool.execute.before"];
    const invoke = (callID: string, command: string) =>
      before(
        { tool: "bash", sessionID: "main", callID },
        { args: { command } },
      );
    await expect(
      invoke("blocked", "bun .aidlc/tools/aidlc-state.ts approve user-stories"),
    ).rejects.toThrow(/engine-owned/i);
    await expect(
      invoke("readonly", "bun .aidlc/tools/aidlc-state.ts show"),
    ).resolves.toBeUndefined();
    await expect(
      invoke("engine", "bun .aidlc/tools/aidlc-orchestrate.ts next"),
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
      { label: "audit", path: join(root, "src/one.ts") },
      { label: "sensor", path: join(root, "src/one.ts") },
      { label: "audit", path: join(root, "src/two.ts") },
      { label: "sensor", path: join(root, "src/two.ts") },
    ]);
  });

  test("relative apply_patch paths pass the real audit hook's absolute record gate", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-init-active.md");
    mkdirSync(dirname(seededAuditShard(root)), { recursive: true });
    writeFileSync(seededAuditShard(root), "# AI-DLC Audit Log\n", "utf-8");
    const artifact = join(
      seededRecordDir(root),
      "initialization",
      "state-init",
      "state-notes.md",
    );
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# state\n", "utf-8");
    const patchText = `*** Begin Patch
*** Add File: ${relative(root, artifact)}
+# state
*** End Patch
`;

    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    await adapter["tool.execute.after"](
      postTool("apply_patch", { patchText }),
    );

    expect(readAudit(root)).toContain("ARTIFACT_CREATED");
    expect(readAudit(root)).toContain("initialization > state-init > state-notes.md");
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

  test("turn-one idle reaches the real Stop hook when workflow state is born during the turn", async () => {
    const root = freshInstalledProject();
    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });

    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start a workflow" }] },
    );
    seedStateFile(root, "state-init-active.md");
    await adapter.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("[aidlc-forwarding-nudge]");
  });

  test("a transient child lookup failure is not cached as a main session", async () => {
    const root = freshProject();
    const minted = join(root, "minted");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-mint-presence.ts",
      `import { appendFileSync } from "node:fs";
await Bun.stdin.text();
appendFileSync(${JSON.stringify(minted)}, "mint\\n");
`,
    );
    let lookups = 0;
    const client: PluginInput["client"] = {
      session: {
        get: async () => {
          lookups += 1;
          if (lookups === 1) throw new Error("transient");
          return { data: { parentID: "main" } };
        },
        prompt: async () => {},
      },
    };
    const adapter = await createAdapter({ client, directory: root });

    for (const text of ["first", "second"]) {
      await adapter["chat.message"](
        { sessionID: "child" },
        { parts: [{ type: "text", text }] },
      );
    }

    expect(lookups).toBe(2);
    expect(() => readFileSync(minted, "utf-8")).toThrow();
  });

  test("idle serialization is released before a nudge prompt delivers the next idle", async () => {
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
if (n === 0) process.stdout.write(JSON.stringify({ decision: "block", reason: "continue" }) + "\\n");
`,
    );
    let adapter: Awaited<ReturnType<typeof createAdapter>>;
    const client: PluginInput["client"] = {
      session: {
        get: async () => ({ data: {} }),
        prompt: async ({ path }) => {
          await adapter.event({
            event: {
              type: "session.idle",
              properties: { sessionID: path.id },
            },
          });
        },
      },
    };
    adapter = await createAdapter({ client, directory: root });
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    await adapter.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    expect(readFileSync(stopCount, "utf-8")).toBe("2");
  });
});

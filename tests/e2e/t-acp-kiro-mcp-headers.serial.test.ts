// t-acp-kiro-mcp-headers.serial.test.ts - live, credential-free proof that
// Kiro CLI discovers .kiro/settings/mcp.json for an includeMcpJson agent while
// passing ${VAR} HTTP header values through verbatim.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}

const FIXTURE_ENV_VALUE = "aidlc-expanded-header-proof";
const FIXTURE_PLACEHOLDER = `\${AIDLC_MCP_FIXTURE_KEY}`;

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP MCP-header proof (uses Kiro credits)";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not found";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  return null;
}
const SKIP_REASON = skipReason();

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number, result: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result },
    {
      headers: {
        "Mcp-Session-Id": "aidlc-mcp-fixture",
      },
    },
  );
}

describe("t-acp-kiro MCP workspace discovery + verbatim HTTP header limitation", () => {
  test.skipIf(SKIP_REASON !== null)(
    `workspace MCP config reaches tools/list and sends its placeholder header verbatim${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const methods: string[] = [];
      const headers: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }
          headers.push(request.headers.get("X-Aidlc-Test") ?? "");
          const rpc = await request.json() as JsonRpcRequest;
          if (rpc.method) methods.push(rpc.method);

          if (rpc.id === undefined) {
            return new Response(null, { status: 202 });
          }
          if (rpc.method === "initialize") {
            const requestedVersion =
              typeof rpc.params?.protocolVersion === "string"
                ? rpc.params.protocolVersion
                : "2025-03-26";
            return rpcResult(rpc.id, {
              protocolVersion: requestedVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "aidlc-mcp-fixture", version: "1.0.0" },
            });
          }
          if (rpc.method === "tools/list") {
            return rpcResult(rpc.id, {
              tools: [
                {
                  name: "probe",
                  description: "Return a deterministic fixture response.",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            });
          }
          if (rpc.method === "tools/call") {
            return rpcResult(rpc.id, {
              content: [{ type: "text", text: "fixture-ok" }],
              isError: false,
            });
          }
          return Response.json(
            {
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: `Method not found: ${rpc.method ?? ""}` },
            },
            { status: 200 },
          );
        },
      });

      const workspace = mkdtempSync(join(tmpdir(), "aidlc-kiro-mcp-"));
      const previousKey = process.env.AIDLC_MCP_FIXTURE_KEY;
      try {
        mkdirSync(join(workspace, ".kiro", "settings"), { recursive: true });
        mkdirSync(join(workspace, ".kiro", "agents"), { recursive: true });
        writeFileSync(
          join(workspace, ".kiro", "settings", "mcp.json"),
          `${JSON.stringify(
            {
              mcpServers: {
                fixture: {
                  type: "http",
                  url: `http://127.0.0.1:${server.port}/mcp`,
                  headers: {
                    "X-Aidlc-Test": FIXTURE_PLACEHOLDER,
                  },
                  disabled: false,
                },
              },
            },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          join(workspace, ".kiro", "agents", "fixture-agent.json"),
          `${JSON.stringify(
            {
              name: "fixture-agent",
              description: "Live MCP transport fixture.",
              prompt:
                "Call the fixture MCP probe tool exactly once when asked. Do not use any other tool.",
              includeMcpJson: true,
              tools: ["@fixture"],
            },
            null,
            2,
          )}\n`,
        );

        process.env.AIDLC_MCP_FIXTURE_KEY = FIXTURE_ENV_VALUE;
        const result = await driveKiroAcp({
          projectDir: workspace,
          agent: "fixture-agent",
          prompt: "Call the fixture MCP probe tool exactly once, then finish.",
          timeoutMs: remainingWorkMs(),
        });

        expect(result.toolCallIssues).toEqual([]);
        expect(methods).toContain("tools/list");
        expect(headers.length).toBeGreaterThan(0);
        // Live-verified on kiro-cli 2.12.1: the environment value is present
        // in the child process, but Kiro sends the configured placeholder
        // literally. A future Kiro release that starts expanding this value
        // should flip this test and allow the context7 API-key header to return.
        expect(headers.every((value) => value === FIXTURE_PLACEHOLDER)).toBe(true);
        expect(headers).not.toContain(FIXTURE_ENV_VALUE);
      } finally {
        if (previousKey === undefined) {
          delete process.env.AIDLC_MCP_FIXTURE_KEY;
        } else {
          process.env.AIDLC_MCP_FIXTURE_KEY = previousKey;
        }
        server.stop(true);
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// covers: file:mcp_config.json
//
// t-exec-devin-mcp-headers.serial.test.ts — live, credential-free proof that
// Devin CLI resolves `${env:VAR}` references in `.devin/mcp_config.json`
// `headers` before they reach the server, and substitutes an empty string for
// an unset variable. Devin counterpart of
// t-acp-kiro-mcp-headers.serial.test.ts, driven by `devin -p` instead of the
// Kiro ACP driver.
//
// Live-verified on Devin CLI 3000.10.21 (the support floor) and 3000.10.31 on
// 2026-09-21. Bare `${VAR}` also resolved on those builds but is deliberately
// not asserted: Devin documents only the `${env:…}` form, so bare-form
// resolution is an undocumented importer behavior a future build may drop.
//
// The proof is a host contract, not the AI-DLC install — it does NOT require
// dist/devin. Devin connects to every enabled MCP server at session start, so
// a trivial prompt is enough; no tool call is requested or needed.
//
// LIVE GATE: requires AIDLC_DEVIN_EXEC_LIVE=1 + a devin binary >=
// DEVIN_MIN_VERSION (AIDLC_DEVIN_BIN or PATH). Skips cleanly otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDevinAsync } from "../harness/exec-drive.ts";
import {
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
} from "../../core/tools/aidlc-devin-version.ts";

const DEVIN_BIN = process.env.AIDLC_DEVIN_BIN ?? "devin";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const FIXTURE_ENV_VALUE = "aidlc-expanded-header-proof";

function devinVersionOk(): boolean {
  const r = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  const version = parseVersionTriple(r.stdout ?? "");
  // Compare against the shared Devin CLI support floor.
  return r.status === 0 && version !== null &&
    compareTriples(version, DEVIN_MIN_VERSION) >= 0;
}

function skipReason(): string | null {
  if (process.env.AIDLC_DEVIN_EXEC_LIVE !== "1") {
    return "set AIDLC_DEVIN_EXEC_LIVE=1 to run the live Devin MCP-header proof";
  }
  if (!devinVersionOk()) return `devin >= ${DEVIN_MIN_VERSION_STRING} not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
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

describe(`t-exec-devin MCP \${env:VAR} header resolution via devin -p`, () => {
  test.skipIf(SKIP_REASON !== null)(
    `server receives the resolved env value and an empty string for the unset variable${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    async () => {
      const methods: string[] = [];
      const envHeaders: string[] = [];
      const unsetHeaders: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          envHeaders.push(request.headers.get("X-Aidlc-Env") ?? "");
          unsetHeaders.push(request.headers.get("X-Aidlc-Unset") ?? "");
          if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }
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

      // A scratch workspace: git-initialized (Devin resolves the project from
      // the git root) with one ENABLED fixture server in .devin/mcp_config.json.
      const workspace = mkdtempSync(join(tmpdir(), "aidlc-devin-mcp-"));
      try {
        const init = spawnSync("git", ["init"], {
          cwd: workspace,
          encoding: "utf-8",
        });
        expect(init.status, `${init.stdout}${init.stderr}`).toBe(0);
        mkdirSync(join(workspace, ".devin"), { recursive: true });
        writeFileSync(
          join(workspace, ".devin", "mcp_config.json"),
          `${JSON.stringify(
            {
              mcpServers: {
                fixture: {
                  url: `http://127.0.0.1:${server.port}/mcp`,
                  headers: {
                    "X-Aidlc-Env": `\${env:AIDLC_MCP_FIXTURE_KEY}`,
                    "X-Aidlc-Unset": `\${env:AIDLC_MCP_FIXTURE_UNSET}`,
                  },
                  disabled: false,
                },
              },
            },
            null,
            2,
          )}\n`,
        );

        // The fixture value rides the child env (undefined drops the unset
        // marker from the inherited environment); process.env is untouched.
        const r = await runDevinAsync(
          workspace,
          "Reply with exactly the single word OK and do nothing else.",
          {
            AIDLC_MCP_FIXTURE_KEY: FIXTURE_ENV_VALUE,
            AIDLC_MCP_FIXTURE_UNSET: undefined,
          },
        );

        expect(r.rc).toBe(0);
        expect(methods).toContain("initialize");
        expect(envHeaders.length).toBeGreaterThan(0);
        // Every request carried the resolved value; the placeholder text was
        // never transmitted in any header.
        expect(envHeaders.every((value) => value === FIXTURE_ENV_VALUE)).toBe(true);
        expect(
          [...envHeaders, ...unsetHeaders].every((value) => !value.includes("${")),
        ).toBe(true);
        // Unset ${env:VAR} resolves to an empty header value — the observed
        // (not vendor-documented) contract this test pins; a future build that
        // retains the placeholder or refuses the server is the early warning.
        expect(unsetHeaders.length).toBeGreaterThan(0);
        expect(unsetHeaders.every((value) => value === "")).toBe(true);
      } finally {
        server.stop(true);
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

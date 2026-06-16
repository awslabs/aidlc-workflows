// covers: file:kiro-mcp.json, file:agents/aidlc.json, file:agents/aidlc-architect-agent.json, file:agents/aidlc-developer-agent.json
//
// t111 — Kiro MCP registry integrity + the @server grant model. The Kiro
// counterpart to t110 (which guards the Claude registry). Kiro has no
// inherit-all model: servers are declared once in dist/kiro/.kiro/settings/mcp.json
// and an agent opts in with `includeMcpJson: true` PLUS a `@<server>` entry in
// its `tools` array. So unlike Claude (where a grant only RESTRICTS), here a
// `@<server>` token is an additive grant — and a grant naming an undeclared
// server, or a typo'd `@aws-srvless`, is a dangling reference Kiro would never
// resolve. This file pins the registry shape and that every `@<server>` grant
// across the three Kiro agent JSONs names a server the registry declares.
//
// Mechanism: none. Pure structural check over the shipped dist bytes — no
// process boundary, no LLM, zero tokens.
//
// Subject under test:
//   - dist/kiro/.kiro/settings/mcp.json — the Kiro MCP registry.
//   - dist/kiro/.kiro/agents/{aidlc,aidlc-architect-agent,aidlc-developer-agent}.json
//     — the three authored Kiro agent configs.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const KIRO_ROOT = join(REPO_ROOT, "dist", "kiro", ".kiro");
const MCP_JSON = join(KIRO_ROOT, "settings", "mcp.json");
const AGENTS_DIR = join(KIRO_ROOT, "agents");

// The three Kiro agent configs.
const AGENT_FILES = ["aidlc.json", "aidlc-architect-agent.json", "aidlc-developer-agent.json"] as const;

// The five public servers the Kiro registry must declare (mirrors the Claude
// set; hard-coded independently of the file so the test pins policy).
const EXPECTED_SERVERS = ["context7", "aws-mcp", "aws-pricing", "aws-iac", "aws-serverless"] as const;

const AWS_PKG_PINS: Record<string, string> = {
  "aws-mcp": "mcp-proxy-for-aws@latest",
  "aws-pricing": "awslabs.aws-pricing-mcp-server@latest",
  "aws-iac": "awslabs.aws-iac-mcp-server@latest",
  "aws-serverless": "awslabs.aws-serverless-mcp-server@latest",
};

const PLACEHOLDER_RE = /^\$\{[A-Z0-9_]+\}$/;
const SECRET_SHAPE_RE =
  /"[^"]*((sk|pk|rk|ghp|gho|ghs|xox[bap])[_-][A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9]{32,})[^"]*"/;

// `@<server>` grant token in a Kiro agent's tools array — captures the server
// name. A bare `@server` grants all the server's tools; `@server/tool` grants one.
const GRANT_RE = /^@([^/]+)(?:\/.+)?$/;

interface ServerCfg {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
}
interface McpDoc {
  mcpServers?: Record<string, ServerCfg>;
}
interface AgentDoc {
  name?: string;
  includeMcpJson?: unknown;
  tools?: unknown[];
}

const RAW = readFileSync(MCP_JSON, "utf-8");
const DOC: McpDoc = JSON.parse(RAW);
const SERVERS = DOC.mcpServers ?? {};

function loadAgent(file: string): AgentDoc {
  return JSON.parse(readFileSync(join(AGENTS_DIR, file), "utf-8")) as AgentDoc;
}

describe("t111 Kiro MCP registry integrity + @server grant model", () => {
  test("registry settings/mcp.json exists on disk", () => {
    expect(existsSync(MCP_JSON)).toBe(true);
  });

  test("registry parses as valid JSON with an mcpServers object", () => {
    expect(typeof DOC).toBe("object");
    expect(DOC.mcpServers).toBeDefined();
    expect(Array.isArray(SERVERS)).toBe(false);
    expect(SERVERS).not.toBeNull();
  });

  test("mcpServers is the sole top-level key", () => {
    expect(Object.keys(DOC)).toEqual(["mcpServers"]);
  });

  for (const srv of EXPECTED_SERVERS) {
    test(`registry declares expected server: ${srv}`, () => {
      expect(SERVERS[srv]).toBeDefined();
    });
  }

  test("mcpServers declares exactly 5 servers (no unexpected entry)", () => {
    expect(Object.keys(SERVERS).sort()).toEqual([...EXPECTED_SERVERS].sort());
  });

  test("context7 is an http server with a url and a CONTEXT7_API_KEY header", () => {
    const c = SERVERS["context7"];
    expect(c.type).toBe("http");
    expect(typeof c.url).toBe("string");
    expect((c.url as string).length).toBeGreaterThan(0);
    expect(c.headers?.["CONTEXT7_API_KEY"]).toBeDefined();
  });

  for (const [srv, pin] of Object.entries(AWS_PKG_PINS)) {
    test(`${srv} is a uvx launcher pinned to ${pin}`, () => {
      const c = SERVERS[srv];
      expect(c.command).toBe("uvx");
      expect(Array.isArray(c.args)).toBe(true);
      expect((c.args as string[])[0]).toBe(pin);
    });
  }

  test("aws-mcp args carry AWS_REGION=us-east-1 metadata", () => {
    expect((SERVERS["aws-mcp"].args as string[])).toContain("AWS_REGION=us-east-1");
  });

  test("every server header value is an env-var placeholder (no inlined credentials)", () => {
    for (const cfg of Object.values(SERVERS)) {
      for (const v of Object.values(cfg.headers ?? {})) {
        expect(PLACEHOLDER_RE.test(String(v))).toBe(true);
      }
    }
  });

  test("no literal/high-entropy credential shape anywhere in the registry", () => {
    expect(SECRET_SHAPE_RE.test(RAW)).toBe(false);
  });

  test("every @<server> grant across the Kiro agents names a declared server", () => {
    const declared = new Set(Object.keys(SERVERS));
    for (const file of AGENT_FILES) {
      const agent = loadAgent(file);
      const tools = (agent.tools ?? []) as string[];
      for (const tool of tools) {
        if (typeof tool !== "string" || !tool.startsWith("@")) continue;
        if (tool === "@builtin") continue;
        const m = tool.match(GRANT_RE);
        expect(m, `grant '${tool}' in ${file} is malformed`).not.toBeNull();
        const server = m![1];
        expect(declared.has(server), `grant '${tool}' in ${file} names undeclared server '${server}'`).toBe(true);
      }
    }
  });

  test("an agent that lists @<server> grants also sets includeMcpJson:true", () => {
    for (const file of AGENT_FILES) {
      const agent = loadAgent(file);
      const tools = (agent.tools ?? []) as string[];
      const hasGrant = tools.some((t) => typeof t === "string" && t.startsWith("@") && t !== "@builtin");
      if (hasGrant) {
        expect(agent.includeMcpJson, `${file} grants @<server> tools but does not set includeMcpJson:true`).toBe(true);
      }
    }
  });

  test("the conductor (aidlc.json) declares no MCP grants and no includeMcpJson", () => {
    const conductor = loadAgent("aidlc.json");
    const tools = (conductor.tools ?? []) as string[];
    const grants = tools.filter((t) => typeof t === "string" && t.startsWith("@") && t !== "@builtin");
    expect(grants).toEqual([]);
    expect(conductor.includeMcpJson).toBeUndefined();
  });
});

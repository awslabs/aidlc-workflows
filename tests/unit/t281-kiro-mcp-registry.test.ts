// covers: file:settings/mcp.json, file:agents/aidlc.json, file:agents/aidlc-architect-agent.json, file:agents/aidlc-architecture-reviewer-agent.json, file:agents/aidlc-aws-platform-agent.json, file:agents/aidlc-compliance-agent.json, file:agents/aidlc-composer-agent.json, file:agents/aidlc-delivery-agent.json, file:agents/aidlc-design-agent.json, file:agents/aidlc-developer-agent.json, file:agents/aidlc-devsecops-agent.json, file:agents/aidlc-operations-agent.json, file:agents/aidlc-pipeline-deploy-agent.json, file:agents/aidlc-product-agent.json, file:agents/aidlc-product-lead-agent.json, file:agents/aidlc-quality-agent.json
//
// t281 - Kiro MCP registry integrity + the includeMcpJson/@server grant
// model. Pure structural coverage over the shipped dist/kiro bytes: no process
// boundary, no LLM, zero tokens. Agent discovery is dynamic so a future persona
// cannot be added without inheriting these invariants.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const KIRO_ROOT = join(REPO_ROOT, "dist", "kiro", ".kiro");
const MCP_JSON = join(KIRO_ROOT, "settings", "mcp.json");
const CLAUDE_MCP_JSON = join(REPO_ROOT, "dist", "claude", ".mcp.json");
const AGENTS_DIR = join(KIRO_ROOT, "agents");

// The Kiro row ships two keyless HTTP entries. It no longer ships the four uvx
// AWS launchers: each spawns a local process from a `@latest` package, which is
// a heavier default than a row serving both surfaces wants, and the knowledge
// server covers the AWS documentation case over plain HTTP. Claude keeps its own
// five-entry registry, so the cross-harness test below states each side's set
// separately instead of sharing one list.
const EXPECTED_SERVERS = ["context7", "aws-knowledge-mcp-server"] as const;
const EXPECTED_GRANTS = EXPECTED_SERVERS.map((server) => `@${server}`);

const EXPECTED_CLAUDE_SERVERS = [
  "context7",
  "aws-mcp",
  "aws-pricing",
  "aws-iac",
  "aws-serverless",
] as const;

const EXPECTED_URLS: Record<string, string> = {
  context7: "https://mcp.context7.com/mcp",
  "aws-knowledge-mcp-server": "https://knowledge-mcp.global.api.aws",
};

const SECRET_SHAPE_RE =
  /"[^"]*((sk|pk|rk|ghp|gho|ghs|xox[bap])[_-][A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9]{32,})[^"]*"/;
const GRANT_RE = /^@([^/]+)(?:\/.+)?$/;

interface ServerCfg {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  disabled?: unknown;
  [key: string]: unknown;
}

interface McpDoc {
  mcpServers?: Record<string, ServerCfg>;
}

interface AgentDoc {
  $schema?: unknown;
  name?: string;
  includeMcpJson?: unknown;
  tools?: unknown[];
  allowedTools?: unknown[];
}

function loadRegistry(path: string): {
  raw: string;
  doc: McpDoc;
  servers: Record<string, ServerCfg>;
} {
  const raw = readFileSync(path, "utf-8");
  const doc = JSON.parse(raw) as McpDoc;
  return { raw, doc, servers: doc.mcpServers ?? {} };
}

function loadAgents(): Array<{ file: string; doc: AgentDoc }> {
  // Agent configs ship as Markdown; frontmatter and a JSON config are equivalent
  // to Kiro, so the grant model is read out of the frontmatter block.
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const block = /^---\n([\s\S]*?)\n---\n/.exec(
        readFileSync(join(AGENTS_DIR, file), "utf-8"),
      );
      if (block === null) throw new Error(`${file}: no frontmatter`);
      return { file, doc: Bun.YAML.parse(block[1]) as AgentDoc };
    });
}

function stringTools(values: unknown[] | undefined): string[] {
  return (values ?? []).filter((value): value is string => typeof value === "string");
}

describe("t281 Kiro MCP registry integrity", () => {
  test("registry exists and parses as an mcpServers-only document", () => {
    expect(existsSync(MCP_JSON)).toBe(true);
    const { doc, servers } = loadRegistry(MCP_JSON);
    expect(Object.keys(doc)).toEqual(["mcpServers"]);
    expect(doc.mcpServers).not.toBeNull();
    expect(typeof doc.mcpServers).toBe("object");
    expect(Array.isArray(servers)).toBe(false);
  });

  test("registry declares exactly the two expected servers", () => {
    const { servers } = loadRegistry(MCP_JSON);
    expect(Object.keys(servers).sort()).toEqual([...EXPECTED_SERVERS].sort());
  });

  test("every entry is keyless HTTP with its expected URL and spawns nothing", () => {
    const { servers } = loadRegistry(MCP_JSON);
    for (const [server, url] of Object.entries(EXPECTED_URLS)) {
      expect(servers[server]?.type, `${server} type`).toBe("http");
      expect(servers[server]?.url, `${server} url`).toBe(url);
      // A row serving both surfaces ships no launcher: `command`/`args` would
      // spawn a local process from a floating package version.
      expect(Object.hasOwn(servers[server], "command"), `${server} command`).toBe(false);
      expect(Object.hasOwn(servers[server], "args"), `${server} args`).toBe(false);
    }
  });

  test("the Kiro registry declares no headers and its raw bytes are secret-free", () => {
    const { raw, servers } = loadRegistry(MCP_JSON);
    // Kiro CLI 2.12.1 sends MCP HTTP header values verbatim without expanding
    // environment placeholders. Any shipped header is therefore either a
    // broken placeholder or a committed secret, so this registry allows none.
    for (const [server, cfg] of Object.entries(servers)) {
      expect(Object.hasOwn(cfg, "headers"), `${server} must not declare headers`).toBe(false);
    }
    expect(raw.match(SECRET_SHAPE_RE)).toBeNull();
  });

  test("every server is disabled by default and disabled is its last key", () => {
    const { servers } = loadRegistry(MCP_JSON);
    for (const [server, cfg] of Object.entries(servers)) {
      expect(cfg.disabled, `${server} disabled`).toBe(true);
      expect(Object.keys(cfg).at(-1), `${server} key order`).toBe("disabled");
    }
  });

  test("the two registries are independent; the shared context7 matches transport only", () => {
    const { servers: kiroServers } = loadRegistry(MCP_JSON);
    const { servers: claudeServers } = loadRegistry(CLAUDE_MCP_JSON);
    // Claude keeps the five-entry set this row no longer ships. Stating it here
    // makes a later change to Claude's registry fail loudly rather than silently
    // widening what this test believes about the Kiro row.
    expect(Object.keys(claudeServers).sort()).toEqual([...EXPECTED_CLAUDE_SERVERS].sort());

    // Claude can expand its context7 API-key placeholder; Kiro CLI 2.12.1
    // passes header values verbatim, so Kiro intentionally matches only the
    // keyless transport fields.
    expect({
      type: kiroServers.context7.type,
      url: kiroServers.context7.url,
    }).toEqual({
      type: claudeServers.context7.type,
      url: claudeServers.context7.url,
    });
  });
});

describe("t281 Kiro dynamic agent grant model", () => {
  test("all 14 personas opt in with exactly the two grants; conductor gets none", () => {
    const agents = loadAgents();
    const conductor = agents.find(({ doc }) => doc.name === "aidlc");
    const personas = agents.filter(({ doc }) => doc.name !== "aidlc");

    expect(agents).toHaveLength(15);
    expect(personas).toHaveLength(14);
    expect(conductor).toBeDefined();

    for (const { file, doc } of personas) {
      expect(doc.includeMcpJson, `${file} includeMcpJson`).toBe(true);
      const grants = stringTools(doc.tools).filter((tool) => tool.startsWith("@")).sort();
      expect(grants, `${file} MCP grants`).toEqual([...EXPECTED_GRANTS].sort());
    }

    // `$schema` is not asserted either way: it points an editor at the agent-v1
    // JSON schema, and these configs ship as Markdown frontmatter.
    const conductorTools = stringTools(conductor!.doc.tools);
    expect(conductor!.doc.includeMcpJson).toBeUndefined();
    expect(conductorTools.filter((tool) => tool.startsWith("@"))).toEqual([]);
  });

  test("every @server tool grant names a declared registry server", () => {
    const declared = new Set(Object.keys(loadRegistry(MCP_JSON).servers));
    for (const { file, doc } of loadAgents()) {
      for (const tool of stringTools(doc.tools).filter((value) => value.startsWith("@"))) {
        const match = tool.match(GRANT_RE);
        expect(match, `${file} malformed grant '${tool}'`).not.toBeNull();
        expect(
          declared.has(match![1]),
          `${file} grant '${tool}' names undeclared server '${match![1]}'`,
        ).toBe(true);
      }
    }
  });

  test("no @server token appears in any allowedTools array", () => {
    for (const { file, doc } of loadAgents()) {
      const grants = stringTools(doc.allowedTools).filter((tool) => tool.startsWith("@"));
      expect(grants, `${file} allowedTools must keep MCP calls prompting`).toEqual([]);
    }
  });
});

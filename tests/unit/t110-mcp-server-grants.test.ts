// covers: file:mcp.json, file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md
//
// t110 - MCP registry integrity + the inheritance access model. The units it
// proves are the shipped `dist/claude/.mcp.json` registry (file:mcp.json, with
// the leading dot dropped because the registry's covers-id must satisfy the
// generator's UNIT_ID_RE leading-char rule `[A-Za-z0-9_]` in collectIds of
// gen-coverage-registry.ts) and, for the inheritance/dangling-grant invariants,
// the eleven shipped agent personas' `tools:` fields.
//
// Mechanism: none. This is a pure structural/schema check over the shipped bytes
// — is the registry valid, exactly-shaped, secret-free; do the agent personas
// honour the inheritance access model? No process boundary, no argv/exit/stdout
// seam, no LLM, zero tokens. We parse the JSON and read the agent .md bytes
// in-process - the same observables, no subprocess required.
// (The mechanism deriver gates `cli` on a real spawn of an `aidlc-*.ts` literal
// in drivesCliSurface; this file spawns nothing, so it stays none.)
//
// THE ACCESS MODEL: servers are declared once in dist/claude/.mcp.json and
// provisioned to the Claude Code session. Subagents INHERIT all session MCP
// tools by default, so no per-agent grant is required - or possible by
// addition. An agent only needs a `tools:` allowlist entry to RESTRICT itself,
// and such entries must be fully-qualified `mcp__<server>__<tool>` (a bare
// `mcp__<server>` is not honoured by Claude Code).
//
// Subject under test:
//   - dist/claude/.mcp.json - the public MCP registry, resolved here as
//     REPO_ROOT/dist/claude/.mcp.json; .mcp.json is a SIBLING of .claude/, not
//     under AIDLC_SRC.
//   - dist/claude/.claude/agents/aidlc-<agent>-agent.md — the eleven personas
//     (AIDLC_SRC/agents here).
//
// Test-design note (house style): assert the OBSERVABLE shipped contract -
// registry shape, per-server config fields, placeholder-only secrets, exact
// cardinality, and the two grant-token invariants - against the real bytes on
// disk. The expected server names + package pins + region are hard-coded here
// independently of the source, so the test pins the policy rather than echoing
// whatever the file says.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

// $MCP_JSON: dist/claude/.mcp.json — a SIBLING of .claude/, so resolve from
// REPO_ROOT/dist/claude, not from AIDLC_SRC (=.../dist/claude/.claude).
const MCP_JSON = join(REPO_ROOT, "dist", "claude", ".mcp.json");
const AGENTS_DIR = join(AIDLC_SRC, "agents");

// The 11 domain-expert agents.
const AGENTS = [
  "product",
  "design",
  "delivery",
  "architect",
  "aws-platform",
  "compliance",
  "devsecops",
  "developer",
  "quality",
  "pipeline-deploy",
  "operations",
] as const;

const EXPECTED_SERVERS = [
  "context7",
  "aws-mcp",
  "aws-pricing",
  "aws-iac",
  "aws-serverless",
] as const;

// aws-* uvx launchers: server -> expected args[0] '<pkg>@latest' pin.
// Hard-coded independently of the file.
const AWS_PKG_PINS: Record<string, string> = {
  "aws-mcp": "mcp-proxy-for-aws@latest",
  "aws-pricing": "awslabs.aws-pricing-mcp-server@latest",
  "aws-iac": "awslabs.aws-iac-mcp-server@latest",
  "aws-serverless": "awslabs.aws-serverless-mcp-server@latest",
};

// ${UPPER_SNAKE} env-var placeholder shape.
const PLACEHOLDER_RE = /^\$\{[A-Z0-9_]+\}$/;

// High-entropy / literal-key credential shape, applied to the WHOLE .mcp.json
// source text. Provider prefixes, AKIA ids, base64 blobs, long alnum runs.
const SECRET_SHAPE_RE =
  /"[^"]*((sk|pk|rk|ghp|gho|ghs|xox[bap])[_-][A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9]{32,})[^"]*"/;

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

const RAW = readFileSync(MCP_JSON, "utf-8");
const DOC: McpDoc = JSON.parse(RAW);
const SERVERS = DOC.mcpServers ?? {};
const DECLARED = new Set(Object.keys(SERVERS));

function mcpTokens(agent: string): string[] {
  const file = join(AGENTS_DIR, `aidlc-${agent}-agent.md`);
  if (!existsSync(file)) return [];
  const body = readFileSync(file, "utf-8");
  return [...body.matchAll(/mcp__[A-Za-z0-9-]+(?:__[A-Za-z0-9_-]+)?/g)].map(
    (m) => m[0],
  );
}

/** Fully-qualified iff it has a `__<tool>` segment. */
function isFullyQualified(token: string): boolean {
  return /^mcp__[A-Za-z0-9-]+__/.test(token);
}

describe("t110 MCP registry integrity + inheritance access model (migrated from t110-mcp-server-grants.sh, plan 32)", () => {
  // --- Registry is present and valid JSON ------------------------------------
  test("registry .mcp.json exists on disk [.sh test 1]", () => {
    expect(existsSync(MCP_JSON)).toBe(true);
  });

  test("registry parses as valid JSON [.sh test 2]", () => {
    expect(() => JSON.parse(RAW)).not.toThrow();
    // The top-level shape must actually be an object - a JSON `[]` or `42` would
    // parse too.
    expect(typeof DOC).toBe("object");
    expect(DOC).not.toBeNull();
  });

  // --- Expected public servers are declared ----------------------------------
  test("registry declares each expected public server [.sh tests 3-7 ×5]", () => {
    for (const srv of EXPECTED_SERVERS) {
      expect(DECLARED.has(srv), `registry is missing server '${srv}'`).toBe(
        true,
      );
    }
  });

  // --- threat-composer is intentionally NOT here (deferred) -------------------
  test("threat-composer-ai is intentionally NOT declared (deferred) [.sh test 8]", () => {
    expect(DECLARED.has("threat-composer-ai")).toBe(false);
  });

  // --- Inheritance invariant: no bare mcp__<server> grant tokens -------------
  // A bare `mcp__<server>` token (no `__<tool>` segment) in any agent's tools is
  // a no-op and an invalid grant form. Fully-qualified `mcp__<server>__<tool>`
  // entries are permitted and NOT flagged here.
  test("no agent carries a bare mcp__<server> grant token (access is by inheritance) [.sh test 9]", () => {
    const bare: string[] = [];
    for (const agent of AGENTS) {
      for (const tok of mcpTokens(agent)) {
        if (!isFullyQualified(tok)) {
          bare.push(`aidlc-${agent}-agent carries bare token '${tok}'`);
        }
      }
    }
    expect(bare, bare.join("\n")).toHaveLength(0);
  });

  // --- Per-server config shape validity --------------------------------------
  // context7 — HTTP server with a URL + the API-key header placeholder.
  test("context7 declares type 'http' [.sh test 10]", () => {
    expect(SERVERS.context7?.type).toBe("http");
  });

  test("context7 declares a non-empty url string [.sh test 11]", () => {
    const url = SERVERS.context7?.url;
    expect(typeof url).toBe("string");
    expect((url as string).length).toBeGreaterThan(0);
  });

  test("context7 declares a headers.CONTEXT7_API_KEY entry [.sh test 12]", () => {
    const headers = SERVERS.context7?.headers ?? {};
    expect(
      Object.hasOwn(headers, "CONTEXT7_API_KEY"),
    ).toBe(true);
  });

  test("each aws-* server is a uvx launcher pinned to <pkg>@latest [.sh tests 13-24 ×4×3]", () => {
    for (const [srv, pkg] of Object.entries(AWS_PKG_PINS)) {
      const cfg = SERVERS[srv] ?? {};
      expect(cfg.command, `${srv} command`).toBe("uvx");
      expect(Array.isArray(cfg.args), `${srv} args is an array`).toBe(true);
      expect(
        (cfg.args as unknown[]).length,
        `${srv} args is non-empty`,
      ).toBeGreaterThan(0);
      expect((cfg.args as unknown[])[0], `${srv} args[0] pin`).toBe(pkg);
    }
  });

  test("aws-mcp args carry AWS_REGION=us-east-1 metadata [.sh test 25]", () => {
    const args = SERVERS["aws-mcp"]?.args;
    expect(Array.isArray(args)).toBe(true);
    expect(args as unknown[]).toContain("AWS_REGION=us-east-1");
  });

  // --- No committed secrets: credential-position values are env-var placeholders
  test("context7 CONTEXT7_API_KEY is an env-var placeholder, not a literal token [.sh test 26]", () => {
    const key = SERVERS.context7?.headers?.CONTEXT7_API_KEY;
    expect(typeof key).toBe("string");
    expect(PLACEHOLDER_RE.test(key as string)).toBe(true);
  });

  test("every server header value is an env-var placeholder (no inlined credentials) [.sh test 27]", () => {
    const bad: string[] = [];
    for (const [name, cfg] of Object.entries(SERVERS)) {
      for (const [hk, hv] of Object.entries(cfg.headers ?? {})) {
        if (typeof hv !== "string" || !PLACEHOLDER_RE.test(hv)) {
          bad.push(`${name}.${hk} = ${JSON.stringify(hv)}`);
        }
      }
    }
    expect(bad, `non-placeholder header value(s):\n${bad.join("\n")}`).toHaveLength(
      0,
    );
  });

  // No quoted string value anywhere in .mcp.json matches a high-entropy /
  // literal-key shape. Applied to the WHOLE source text, not just header values -
  // catches a leak in any string.
  test("no literal/high-entropy credential shape anywhere in .mcp.json [.sh test 28]", () => {
    const m = RAW.match(SECRET_SHAPE_RE);
    expect(
      m,
      `literal-key shape found in .mcp.json: ${m?.[0] ?? ""}`,
    ).toBeNull();
  });

  // --- Exact cardinality + clean top-level shape -----------------------------
  test("mcpServers declares exactly 5 servers (no 6th unexpected entry) [.sh test 29]", () => {
    expect(Object.keys(SERVERS)).toHaveLength(5);
    expect([...DECLARED].sort()).toEqual([...EXPECTED_SERVERS].sort());
  });

  test("mcpServers is the sole top-level key [.sh test 30]", () => {
    expect(Object.keys(DOC)).toEqual(["mcpServers"]);
  });

  test("mcpServers value is a non-null object (not array, not null) [.sh test 31]", () => {
    const v = DOC.mcpServers;
    expect(v !== null && typeof v === "object" && !Array.isArray(v)).toBe(true);
  });

  // --- Dangling fully-qualified grant guard ----------------------------------
  // Every fully-qualified mcp__<server>__<tool> token names a server declared
  // in .mcp.json. Today no agent carries any mcp__ token, so this passes
  // vacuously; it FAILS the moment an allowlist references e.g.
  // mcp__threat-composer-ai__create or a typo'd server.
  test("every fully-qualified mcp__<server>__<tool> grant names a declared server [.sh test 32]", () => {
    const dangling: string[] = [];
    for (const agent of AGENTS) {
      for (const tok of mcpTokens(agent)) {
        if (!isFullyQualified(tok)) continue;
        const srv = tok.slice("mcp__".length).split("__")[0];
        if (!DECLARED.has(srv)) {
          dangling.push(
            `aidlc-${agent}-agent token '${tok}' names undeclared server '${srv}'`,
          );
        }
      }
    }
    expect(dangling, dangling.join("\n")).toHaveLength(0);
  });

  // --- Roster guard -----------------------------------------------------------
  // Re-count the roster + server set so a silent drop (an agent removed from
  // AGENTS, a server removed from the expected list) is caught.
  test("roster + expected-server set match the 32-assertion plan inputs (TAP plan parity)", () => {
    expect(AGENTS.length).toBe(11);
    expect(EXPECTED_SERVERS.length).toBe(5);
    expect(Object.keys(AWS_PKG_PINS).length).toBe(4);
  });
});

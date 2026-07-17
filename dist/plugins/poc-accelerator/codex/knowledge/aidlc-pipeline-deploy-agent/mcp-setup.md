# Regional MCP Setup for PoCs

## Which server at which step

The eight delivery stages call these servers at defined points (each stage file
names its own usage; this table is the overview). In Global regions the AWS MCP
Remote endpoint covers the API, documentation, and knowledge roles in one
server; in China the roles map to the individual local servers below.

| Step | Server role | Used for |
| --- | --- | --- |
| 1 Requirements capture | documentation | Sanity-check service availability in the target region/partition before promising a capability |
| 2 Solution design | documentation + knowledge + pricing | Regional availability evidence, reference architectures and code examples, order-of-magnitude cost watchpoints in the stack plan |
| 3 Environment readiness | API | Verify the MCP config is live; read-only identity/region/resource discovery before any mutation; confirm the baseline stack state |
| 4 Walking skeleton | IaC + knowledge + API | Generate/validate CDK (cfn-lint, compliance) before deploy; construct examples; confirm deployed resources |
| 5 Feature expansion | IaC + documentation/knowledge | Validate each CDK change before deploy; service behavior instead of guessed API semantics |
| 6 Test validation | API | Read-only confirmation of deployed resource states behind integration checks |
| 7 CDK deployment | IaC + API | Template validation before `cdk deploy`; build the stack inventory from read-only queries |
| 8 Demo and handoff | pricing | Real-time Price List quotes for the PoC running cost and production-scale projection |

Choose exactly one regional configuration before starting, then write it to
the MCP configuration location of the harness you are running on:

| Harness | MCP configuration | Format |
| --- | --- | --- |
| Kiro IDE / Kiro CLI | `.kiro/settings/mcp.json` (workspace) | The JSON examples below, as-is |
| Claude Code | `.mcp.json` (project root) | The same `mcpServers` JSON block |
| Codex CLI | `~/.codex/config.toml` `[mcp_servers.<name>]` | Translate each server's command/args/env to TOML |

The examples below use the Kiro JSON shape as canonical; the server set,
package names, and environment variables are identical on every harness. The
remote/HTTP entries (`aws-mcp-remote`, `aws-knowledge-mcp-server`) require the
host's remote-MCP support — verify with a handshake before relying on them.
For customer engagements, replace `@latest` with an organization-approved
pinned version; `@latest` is acceptable only in internal development
environments. Never put access keys, session tokens, customer IDs, or real
data in the MCP configuration.

## Global AWS regions

Use this for overseas or Global AWS accounts:

```json
{
  "mcpServers": {
    "aws-mcp-remote": {
      "type": "remote",
      "url": "https://mcp.aws.amazon.com"
    },
    "awslabs.aws-iac-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-iac-mcp-server@latest"],
      "env": { "FASTMCP_LOG_LEVEL": "ERROR" }
    },
    "awslabs.aws-pricing-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-pricing-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "replace-with-approved-profile",
        "AWS_REGION": "us-east-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    }
  }
}
```

- `aws-mcp-remote` is the AWS remote MCP endpoint and uses the operator's IAM
  Identity Center / AWS authentication context.
- `awslabs.aws-iac-mcp-server` supports CDK and CloudFormation generation.
- `awslabs.aws-pricing-mcp-server` queries the AWS Price List API for the
  step-8 cost projection (PoC running cost and production-scale estimate).
  The IAM role/user needs `pricing:*` permissions; pricing API calls are free
  and return only public price data, never account billing data. `AWS_REGION`
  selects the nearest Pricing API endpoint (`us-east-1`, `eu-central-1`, or
  `ap-south-1`).

Confirm account, region, and least-privilege role before resource mutation.

## AWS China regions

Use this for BJS/ZHY customer accounts. The AWS remote MCP endpoint
(`mcp.aws.amazon.com`) is not assumed reachable. The topology is four local
servers (API, documentation, IaC, pricing — all PyPI packages run via `uvx`;
the first three are field-tested, pricing follows the same pattern)
plus the knowledge server as a **remote HTTP endpoint**
(`https://knowledge-mcp.global.api.aws`), which is reachable from China and
needs no local install:

```json
{
  "mcpServers": {
    "awslabs.aws-api-mcp-server": {
      "command": "uvx",
      "timeout": 120000,
      "args": ["awslabs.aws-api-mcp-server@latest"],
      "env": {
        "AWS_REGION": "cn-northwest-1",
        "AWS_API_MCP_PROFILE_NAME": "replace-with-approved-profile",
        "REQUIRE_MUTATION_CONSENT": "true",
        "UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple"
      }
    },
    "awslabs.aws-documentation-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-documentation-mcp-server@latest"],
      "env": {
        "AWS_DOCUMENTATION_PARTITION": "aws-cn",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    },
    "awslabs.aws-iac-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-iac-mcp-server@latest"],
      "env": { "FASTMCP_LOG_LEVEL": "ERROR" }
    },
    "awslabs.aws-pricing-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.aws-pricing-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "replace-with-approved-profile",
        "AWS_REGION": "cn-northwest-1",
        "UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple",
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    },
    "aws-knowledge-mcp-server": {
      "url": "https://knowledge-mcp.global.api.aws",
      "type": "http",
      "disabled": false
    }
  }
}
```

Keep `REQUIRE_MUTATION_CONSENT=true`; it makes mutating API actions require a
user decision.

Pricing in China: with a China-partition profile and `AWS_REGION=cn-northwest-1`
the pricing server resolves the China Price List endpoint
(`pricing.cn-northwest-1.amazonaws.com.cn`) and returns the China catalog in
CNY — the correct source for a BJS/ZHY cost projection. The IAM role/user needs
`pricing:*` permissions; the calls are free and return only public price data.
To quote Global-region prices for comparison, run a second instance with a
Global-partition profile instead — one instance cannot span both partitions.

China-specific reliability settings (validated):

- `UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` on the API
  server — the first `uvx` run downloads the package; the domestic mirror
  avoids PyPI timeouts.
- `timeout: 120000` on the API server — cold-start package download plus AWS
  credential resolution can exceed the default timeout.
- `FASTMCP_LOG_LEVEL=ERROR` on the documentation and IaC servers to keep
  stdio noise out of the protocol channel.

Set an approved profile name and China region locally.

## Operational checks

1. Create the harness's MCP configuration (see the location table above) from
   exactly one regional example.
2. For customer engagements, replace `@latest` with reviewed, pinned versions.
3. Authenticate with the approved SSO/profile flow outside the project file.
4. Confirm read-only discovery before a mutation.
5. Record deployed stack identifiers and commands in the PoC record; do not
   record credentials or confidential payloads.

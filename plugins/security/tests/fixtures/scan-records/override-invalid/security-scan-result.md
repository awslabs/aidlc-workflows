# Security scan

```json
{ "schema_version": 1, "scan": { "scan_id": "scan-5e6f7a8b", "scan_type": "DIFF", "base_ref": "HEAD", "status": "COMPLETED", "region": "ap-southeast-1", "mcp_server": "awslabs.security-agent-mcp-server@0.2.1", "completed_at": "2026-11-02T09:40:00Z" }, "findings": [
  { "finding_id": "f-501", "name": "Hardcoded credential", "risk_level": "HIGH", "status": "ACTIVE",
    "override": { "by": "Dana Lee", "reason": "  ", "at": "2026-11-02T09:55:00Z" } },
  { "finding_id": "f-502", "name": "Open redirect", "risk_level": "HIGH", "status": "ACTIVE",
    "override": { "by": "", "reason": "Internal tool", "at": "2026-11-02T09:55:00Z" } },
  { "finding_id": "f-503", "name": "Missing authorization check", "risk_level": "CRITICAL", "status": "ACTIVE",
    "override": { "by": "Dana Lee", "reason": "Behind the VPN", "at": "last Tuesday" } }
] }
```

# Security scan

```json
{ "schema_version": 1, "scan": { "scan_id": "scan-5e6f7a8b", "scan_type": "DIFF", "base_ref": "HEAD", "status": "COMPLETED", "region": "ap-southeast-1", "mcp_server": "awslabs.security-agent-mcp-server@0.2.1", "completed_at": "2026-11-02T09:40:00Z" }, "findings": [
  { "finding_id": "f-401", "name": "Hardcoded credential", "risk_level": "HIGH", "status": "ACTIVE",
    "code_locations": [{ "file_path": "test/fixtures/keys.ts", "line_start": 3 }],
    "override": { "by": "Dana Lee", "reason": "A fake key in a test fixture; it never reaches a deployment.", "at": "2026-11-02T09:55:00Z" } }
] }
```

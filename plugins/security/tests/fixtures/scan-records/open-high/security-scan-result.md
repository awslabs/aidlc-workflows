# Security scan

| Id | Risk | Name | Location | Status | Decision |
| --- | --- | --- | --- | --- | --- |
| f-101 | HIGH | Hardcoded credential | src/config.ts:12 | ACTIVE | |
| f-102 | CRITICAL | Command built from request input | src/run.ts:30-34 | FALSE_POSITIVE | |

```json
{
  "schema_version": 1,
  "scan": {
    "scan_id": "scan-5e6f7a8b",
    "scan_type": "DIFF",
    "base_ref": "HEAD",
    "status": "COMPLETED",
    "region": "ap-southeast-1",
    "mcp_server": "awslabs.security-agent-mcp-server@0.2.1",
    "completed_at": "2026-11-02T09:40:00Z"
  },
  "findings": [
    {
      "finding_id": "f-101",
      "name": "Hardcoded credential",
      "risk_level": "HIGH",
      "status": "ACTIVE",
      "confidence": "HIGH",
      "code_locations": [{ "file_path": "src/config.ts", "line_start": 12, "line_end": 12 }]
    },
    {
      "finding_id": "f-102",
      "name": "Command built from request input",
      "risk_level": "CRITICAL",
      "status": "FALSE_POSITIVE",
      "code_locations": [{ "file_path": "src/run.ts", "line_start": 30, "line_end": 34 }]
    },
    {
      "finding_id": "f-103",
      "name": "Weak random for a non-secret id",
      "risk_level": "LOW",
      "status": "ACTIVE"
    }
  ]
}
```

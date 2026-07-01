# Logging Rules

## Overview
These rules define **how** structured logging implements the observability strategy defined in `extensions/observability/observability-baseline.md`. Every log rule traces back to one or more STRAT rules. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIOBS-LOG-001: Structured Logging for Detect, Assess Impact, and Diagnose

**Rule**: Implementing AIOBS-STRAT-002 for logs, structured log entries serve the three observability goals as follows:

1. **Detect** — Log entries that are the emission source for Customer Experience metrics (AIOBS-MET-002) MUST be structured and purpose-built for metric extraction. These are not debug logs — they are metric sources that happen to be emitted via the logging pipeline.
2. **Assess Impact** — Log entries MUST include sufficient context (customer identifiers, request identifiers, resource identifiers) to enable aggregation of impact scope during investigation.
3. **Diagnose** — Log entries MUST be structured JSON with consistent fields across all components, enabling responders to correlate events across services, filter by error type, and trace the sequence of operations that led to a failure.

Every operation MUST emit a structured log entry for each unit of work, on both success and failure paths. Logging only failures makes it impossible to calculate success rates, detect degradation trends, or use logs as metric sources for Customer Experience metrics. A unit of work that completes without a log entry is invisible to operators.

**Verification**:
- All log entries are structured JSON with consistent field naming across components
- Every operation emits a log entry per unit of work on both success and failure paths
- Log entries designed as metric sources are explicitly structured for metric extraction (not retrofitted from debug logging)
- Log entries include customer/request/resource identifiers enabling impact assessment
- Success and failure log entries use the same base format, differing only in `level`, `message`, and error context fields

---

### Rule AIOBS-LOG-002: Include Fault Isolation Fields in Structured Logs

**Rule**: Implementing AIOBS-STRAT-004 for logs, all structured log entries MUST include application-specific fields that enable fault isolation. At minimum: service name, instance/container ID, availability zone, and software version. Where the architecture supports it: tenant ID, deployment ID, feature flag state, API version, cell/shard ID. For Lambda, `instance_id` is replaced by `function_name` + `function_version` (Lambda has no stable instance ID).

These fields MUST be consistent with the dimensions used on metrics (AIOBS-MET-005) so that responders can correlate across signals.

**Verification**:
- All structured log entries include at minimum: service name, instance/container ID, availability zone, and software version
- Additional fields (tenant ID, deployment ID, etc.) are included where the architecture supports them
- Field names and values are consistent with metric dimensions (AIOBS-MET-005)

---

### Rule AIOBS-LOG-003: Base Structured Log Format (EMF-Compatible)

**Rule**: All structured log entries MUST use a base JSON format that is compatible with the CloudWatch Embedded Metrics Format (EMF). This ensures every log entry can optionally become a metric source by adding the `_aws` metadata block, without requiring a different log format.

**Base log entry (non-metric):**

```json
{
  "timestamp": 1565375354953,
  "level": "INFO",
  "message": "Order processed successfully",
  "status": "success",
  "service": "order-service",
  "version": "2.3.1",
  "instance_id": "i-0abc123def456",
  "availability_zone": "us-east-1a",
  "trace_id": "1-5f4b3c2d-abcdef1234567890",
  "request_id": "req-abc-123",
  "operation": "processOrder",
  "tenant_id": "tenant-42",
  "deployment_id": "deploy-2024-03-15",
  "order_id": "ord-789",
  "duration_ms": 245
}
```

**Metric-bearing log entry (adds `_aws` block per EMF schema):**

```json
{
  "timestamp": 1565375354953,
  "level": "INFO",
  "message": "Order processed successfully",
  "status": "success",
  "service": "order-service",
  "version": "2.3.1",
  "instance_id": "i-0abc123def456",
  "availability_zone": "us-east-1a",
  "trace_id": "1-5f4b3c2d-abcdef1234567890",
  "request_id": "req-abc-123",
  "operation": "processOrder",
  "tenant_id": "tenant-42",
  "deployment_id": "deploy-2024-03-15",
  "order_id": "ord-789",
  "duration_ms": 245,
  "_aws": {
    "Timestamp": 1565375354953,
    "CloudWatchMetrics": [
      {
        "Namespace": "OrderService",
        "Dimensions": [["service", "operation"], ["service"]],
        "Metrics": [
          { "Name": "ProcessingLatency", "Unit": "Milliseconds" },
          { "Name": "OrderCount", "Unit": "Count" }
        ]
      }
    ]
  }
}
```

**Required base fields (every log entry):**

| Field | Type | Description | Source rule |
|-------|------|-------------|------------|
| `timestamp` | integer (epoch ms) | Epoch milliseconds | LOG-001 |
| `level` | string enum: `ERROR`, `WARN`, `INFO`, `DEBUG` | Log level | LOG-003 |
| `message` | string | Human-readable description of the event | LOG-003 |
| `status` | string enum: `success`, `failure` | Outcome of the operation | LOG-001 |
| `service` | string | Service name | LOG-002 / STRAT-004 |
| `version` | string (semver) | Software version | LOG-002 / STRAT-004 |
| `instance_id` | string | Instance or container ID | LOG-002 / STRAT-004 |
| `availability_zone` | string | Availability zone ID | LOG-002 / STRAT-004 |
| `trace_id` | string | Distributed trace ID for cross-signal correlation | TRACE-001 |
| `request_id` | string | Request identifier for correlation | LOG-001 |
| `operation` | string | The operation or function being performed | LOG-001 |

**Conditional fields (where architecture supports):**

| Field | Type | Description | Source rule |
|-------|------|-------------|------------|
| `tenant_id` | string | Tenant identifier (multi-tenant systems) | LOG-002 / STRAT-004 |
| `deployment_id` | string | Deployment identifier | LOG-002 / STRAT-004 |
| `cell_id` | string | Cell or shard identifier | LOG-002 / STRAT-004 |
| `feature_flags` | object | Active feature flag state (key-value pairs) | LOG-002 / STRAT-004 |
| `api_version` | string | API version | LOG-002 / STRAT-004 |

**Metric-bearing entries additionally include:**

| Field | Type | Description | Source rule |
|-------|------|-------------|------------|
| `_aws` | object | EMF metadata block with `Timestamp` (integer), `CloudWatchMetrics` (array of MetricDirective) | MET-002 |
| Numeric value fields | number | The metric values referenced by the EMF `Metrics` definitions (e.g., `duration_ms`) | MET-002 |

**Log level conventions:**
- **ERROR**: The operation failed and requires attention. Customer impact is occurring or imminent.
- **WARN**: The operation succeeded but encountered an unexpected condition that may indicate a developing problem.
- **INFO**: Normal operational events — one entry per unit of work for operations. Metric-source log entries use this level.
- **DEBUG**: Detailed diagnostic information. Not emitted in production by default.

**Verification**:
- All log entries conform to the base JSON format with all required fields present
- Field names are consistent across all components in the service
- Required base fields match the names and types specified above
- Metric-bearing log entries include the `_aws` block conforming to the EMF schema
- Dimension references in the `_aws` block correspond to fields present in the log entry
- Log levels follow the defined conventions

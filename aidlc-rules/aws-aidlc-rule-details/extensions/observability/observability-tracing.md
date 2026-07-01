# Tracing Rules

## Overview
These rules define **how** distributed tracing implements the observability strategy defined in `extensions/observability/observability-baseline.md`. Every trace rule traces back to one or more STRAT rules. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIOBS-TRACE-000: Determine Tracing Level from Architecture

**Rule**: The model MUST analyse the architecture to determine the appropriate tracing level. This is not a user question — the model qualifies it based on the design:

- **Full distributed tracing** — Required when a customer request crosses two or more service boundaries (e.g., API Gateway → Lambda → DynamoDB → SQS → processing Lambda), or when async/event-driven workflows mean a single customer action triggers multiple processing steps. Full tracing provides the request-level flow needed to Diagnose cross-service latency and error propagation (AIOBS-STRAT-002).
- **Basic correlation ID propagation** — Sufficient when the architecture is a single component or a simple request path where the flow is trivially obvious (e.g., API Gateway → single Lambda → single DynamoDB table). In this case, the `request_id` and `trace_id` fields in structured logs (AIOBS-LOG-003) satisfy the Diagnose goal without the overhead of full distributed tracing.

The model MUST document the tracing level decision and rationale during NFR Design. If the architecture evolves to include cross-boundary request flows, the tracing level MUST be re-evaluated.

**Qualification criteria for full distributed tracing:**
- Request path crosses 2+ service boundaries
- Async or event-driven processing (queues, event buses, step functions)
- Latency budget is distributed across multiple components
- Errors can originate in downstream services and propagate upstream
- Multiple teams own components in the request path

**Verification**:
- The tracing level is documented with rationale based on architecture analysis
- Full distributed tracing is active when any qualification criterion is met
- Basic correlation ID propagation is implemented at minimum for all architectures
- The tracing level decision is re-evaluated when the architecture changes

---

### Rule AIOBS-TRACE-001: Distributed Tracing for Detect, Assess Impact, and Diagnose

**Rule**: When full distributed tracing is qualified (AIOBS-TRACE-000), implementing AIOBS-STRAT-002 for traces, distributed tracing serves the three observability goals as follows:

1. **Detect** — Trace-based anomaly detection (elevated error rates, latency spikes across service boundaries) provides an additional Detect signal, particularly for cross-service failures that may not be visible in per-component metrics alone.
2. **Assess Impact** — Traces enable identification of which customer requests and downstream services are affected by a failure, supporting impact scoping beyond what metrics alone can provide.
3. **Diagnose** — Traces provide the request-level flow across service boundaries, showing exactly where latency is introduced, where errors originate, and how failures propagate. This is the primary Diagnose signal for cross-service issues.

Trace context MUST be propagated to every outbound call (HTTP, messaging, async invocations) so that the full request path is visible.

**Verification**:
- Distributed traces are active for all service components
- Trace context is propagated to every outbound call
- The full request path is visible across service boundaries
- Trace data supports latency breakdown and error origin identification

---

### Rule AIOBS-TRACE-002: Include Fault Isolation Attributes on Spans

**Rule**: Implementing AIOBS-STRAT-004 for traces, trace spans MUST include application-specific attributes that enable fault isolation. At minimum: service name, instance/container ID, availability zone, and software version. Where the architecture supports it: tenant ID, deployment ID, feature flag state, API version, cell/shard ID. For Lambda, `instance_id` is replaced by `function_name` + `function_version` (Lambda has no stable instance ID).

These attributes MUST be consistent with the dimensions used on metrics (AIOBS-MET-005) and fields used in logs (AIOBS-LOG-002) so that responders can correlate across all three signals.

**Verification**:
- All trace spans include at minimum: service name, instance/container ID, availability zone, and software version as attributes
- Additional attributes (tenant ID, deployment ID, etc.) are included where the architecture supports them
- Attribute names and values are consistent with metric dimensions (AIOBS-MET-005) and log fields (AIOBS-LOG-002)

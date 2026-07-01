# LLM Observability Rules

## Overview
These rules apply ONLY when the project includes LLM inference services. They are loaded conditionally by the Observability Setup stage when LLM inference is detected during the applicability assessment.

Each rule specifies additional conditions beyond "has LLM inference" (e.g., GPU usage, multi-step workflows, content filtering). Evaluate these conditions per rule.

**Enforcement**: Same as `observability-rules.md` — non-compliance with an applicable rule is a blocking observability finding.

---

## LLM INFERENCE INSTRUMENTATION

### Rule AIOBS-LLM-001: Emit LLM Request Lifecycle Metrics

**Rule**: All LLM inference services MUST emit metrics covering the complete request lifecycle: Request Count, Input/Output/Total Token Count, Time to First Token, Time per Output Token, End-to-End Latency, Throughput, Error Rates (4xx, 5xx, timeout separately), Model Cold Start Duration.

**Verification**:
- All metrics are emitted per request and aggregated at regular intervals
- Metrics include dimensions: ModelId, ModelVersion, EndpointName, InstanceType, AZ-ID
- Latency metrics emit both P50 and P99 per API operation
- Token count metrics are separated by input, output, and total

---

### Rule AIOBS-LLM-002: Instrument Prompt and Response Metadata

**Rule**: All LLM requests MUST be logged with structured metadata. Prompt and response content MUST NOT be logged by default — only metadata (TraceId, RequestId, ModelId, prompt/response lengths, inference parameters, completion reason, latency, status code, InstanceId, AZ-ID).

**Verification**:
- Logs are structured (JSON) and include all required metadata fields
- Logs use EMF or equivalent to generate metrics automatically
- Trace context is propagated from client through all LLM service layers
- Prompt and response content is NOT included in default logs

---

### Rule AIOBS-LLM-003: Emit GPU and Accelerator Utilisation Metrics

**Applies to**: GPU or accelerator-based inference deployments

**Rule**: Services MUST emit: GPU Utilisation (%), GPU Memory Utilisation (%), Accelerator Utilisation, Memory Bandwidth Utilisation (%).

**Verification**:
- Metrics emitted at regular intervals (1 minute minimum)
- Metrics include dimensions: InstanceId, AcceleratorId, ModelId
- Metrics correlate with inference request volumes

---

### Rule AIOBS-LLM-004: Propagate Trace Context Across Multi-Step LLM Workflows

**Applies to**: Multi-step LLM workflows (RAG, agents, tool use, chain-of-thought)

**Rule**: Trace context MUST be propagated across all steps: retrieval, LLM calls, tool invocations, response aggregation.

**Verification**:
- Each step emits a trace segment with: parent trace ID, step name, step duration, input/output token counts
- Distributed traces can reconstruct the full request flow across all LLM invocations

---

## LLM QUALITY AND SAFETY

### Rule AIOBS-LLM-005: Emit Model Response Quality Metrics

**Rule**: LLM services MUST emit: Refusal Rate, Empty Response Rate, Truncation Rate, Guardrail Trigger Rate.

**Verification**:
- Metrics are emitted per ModelId and ModelVersion
- Metrics enable detection of quality degradation across model versions

---

### Rule AIOBS-LLM-006: Log Content Safety Filter Activations

**Applies to**: LLM services with content filtering

**Rule**: All filter activations MUST be logged with structured metadata: TraceId, RequestId, ModelId, filter type, confidence score, action taken, prompt length (not content).

**Verification**:
- Logs are structured and queryable
- Filter activation metrics are aggregated per filter type
- Metrics include dimensions: ModelId, FilterType, Action

---

## LLM AVAILABILITY AND RESILIENCE

### Rule AIOBS-LLM-007: Calculate LLM Client-Side Availability Including Quality Failures

**Rule**: LLM availability MUST be measured from the client perspective. Successful = (2xx AND completion_reason = "stop" AND response_length > 0 AND latency < timeout threshold). Server-side availability (HTTP status only) MUST be measured separately.

**Verification**:
- Client-side availability includes HTTP 2xx with valid content, natural completions, and responses within latency bounds
- Server-side availability is measured separately
- Both metrics are emitted independently to enable divergence detection

---

### Rule AIOBS-LLM-008: Implement Synthetic Canaries for LLM Endpoints

**Applies to**: Externally facing LLM services

**Rule**: Production LLM endpoints MUST be monitored by synthetic canaries executing representative prompts (short factual, long context, multi-turn).

**Verification**:
- Canaries execute at a defined frequency from at least 2 external locations per region
- Canaries test diverse prompt types
- Canary metrics include: availability, TTFT, end-to-end latency, response quality checks
- Canary results are dimensioned by: ModelId, Region, AZ-ID

---

### Rule AIOBS-LLM-009: Implement Per-Model and Per-Instance Outlier Detection

**Applies to**: Multi-model or multi-instance LLM deployments

**Rule**: Outlier detection MUST identify degraded models or instances across fault boundaries: ModelId, InstanceId, AZ-ID.

**Verification**:
- Outlier detection algorithm is implemented (Chi-squared, IQR, MAD, or Z-score)
- Metrics are compared across ModelId, InstanceId, and AZ-ID
- Automated mitigation routes traffic away from outlier endpoints

---

### Rule AIOBS-LLM-010: Compare Client-Perceived Quality with Server-Side Metrics

**Rule**: Client-perceived response quality MUST be compared with server-side metrics to detect silent degradation.

**Verification**:
- Client-side quality metrics and server-side metrics are emitted independently
- Divergence between client and server quality signals is detectable

---

### Rule AIOBS-LLM-011: Validate Response Correctness via Canary Response Checking

**Applies to**: Production LLM services

**Rule**: Canaries MUST validate response correctness, not just availability and latency.

**Verification**:
- Canary prompts include known-answer queries for correctness validation
- Response validation checks are automated and emit pass/fail metrics

---

### Rule AIOBS-LLM-012: Emit Real-Time Concurrency and Queue Depth Metrics

**Applies to**: LLM services with autoscaling

**Rule**: Services MUST emit concurrency and queue depth metrics to support scaling decisions.

**Verification**:
- Real-time concurrency and queue depth metrics are emitted
- Metrics are dimensioned by EndpointName and InstanceId
- Metrics are used as inputs to autoscaling policies

---

### Rule AIOBS-LLM-013: Monitor Token and API Quota Utilisation

**Applies to**: LLM services with quotas

**Rule**: Token and API quota utilisation MUST be monitored to detect exhaustion risk before limits are reached.

**Verification**:
- Quota utilisation metrics are emitted as percentage of current limit
- Quota consumption rate is tracked to detect approaching limits
- Alerts are configured for quota utilisation thresholds

---

### Rule AIOBS-LLM-014: Emit Token-Based Cost Metrics

**Rule**: LLM services MUST emit token-based cost metrics for cost visibility and anomaly detection.

**Verification**:
- Cost metrics are emitted per ModelId, per request, and aggregated
- Metrics enable cost anomaly detection across model versions and endpoints

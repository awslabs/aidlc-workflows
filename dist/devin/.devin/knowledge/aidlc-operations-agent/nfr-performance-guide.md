# NFR Performance and Scalability Guide

> This guide supplements the full NFR Requirements Guide held by the Security Engineer (lead agent for the NFR Requirements stage). It provides the DevOps Engineer with the performance and scalability sections needed for infrastructure-focused contributions during NFR Requirements and NFR Design stages.

## Performance Requirement Benchmarking

### How to Define Performance Requirements
Every performance requirement must specify:
- **Metric**: What is being measured (response time, throughput, resource usage)
- **Target**: The quantitative threshold
- **Percentile**: Which percentile the target applies to (p50, p95, p99)
- **Load condition**: Under what concurrency/traffic the target must hold
- **Measurement method**: How and where the metric is captured

### Common Performance Targets by Application Type

| Application Type | Metric | Target | Percentile | Notes |
|-----------------|--------|--------|------------|-------|
| Web application (interactive) | Page load time | < 2s | p95 | First contentful paint |
| REST API (synchronous) | Response time | < 200ms | p99 | Excludes network transit |
| Search query | Result delivery | < 500ms | p95 | Including ranking |
| Batch processing | Throughput | N records/min | Average | Define minimum acceptable rate |
| Real-time messaging | End-to-end latency | < 100ms | p99 | From send to delivery |
| File upload | Processing time | < 5s per MB | p95 | Post-upload processing |

### Performance Anti-Requirements
Explicitly exclude unreasonable expectations:
- "The system should be fast" (not measurable)
- "All pages load instantly" (no target, no percentile)
- "Handle unlimited users" (no capacity boundary)

Replace with: "The dashboard page loads in < 3 seconds at p95 under 500 concurrent users."

## Scalability Assessment Frameworks

### Capacity Planning Template

| Dimension | Current | 6-Month Target | 12-Month Target | Scaling Mechanism |
|-----------|---------|---------------|-----------------|-------------------|
| Concurrent users | N | N * X | N * Y | Horizontal auto-scaling |
| Data volume | N GB | N * X GB | N * Y GB | Partitioning strategy |
| Requests per second | N | N * X | N * Y | Load balancer + replicas |
| Storage growth rate | N GB/month | N * X GB/month | N * Y GB/month | Tiered storage policy |

### Scalability Requirement Format
```
NFR-SCALE-NNN: [Scalability Requirement]
Current baseline: [measured current capacity]
Target capacity: [required capacity at specific timeline]
Growth model: [linear, exponential, seasonal, step-function]
Scaling approach: [horizontal, vertical, partitioning, caching]
Cost constraint: [infrastructure cost must remain below $X/month at target scale]
Degradation policy: [what degrades first when approaching capacity limits]
```

### Scaling Decision Matrix

| Signal | Scale Up | Scale Out | Optimize First |
|--------|----------|-----------|----------------|
| CPU consistently > 70% | Single-instance workloads | Stateless services | Check for inefficient algorithms |
| Memory pressure | In-memory processing | Distributed cache | Check for memory leaks |
| I/O wait > 30% | Faster storage tier | Read replicas, sharding | Query optimization, indexing |
| Queue depth growing | Faster consumers | More consumer instances | Batch size tuning |
| Connection pool exhausted | Larger pool size | Connection multiplexing | Connection leak investigation |

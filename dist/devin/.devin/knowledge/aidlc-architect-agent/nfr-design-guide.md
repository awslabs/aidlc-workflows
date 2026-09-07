# NFR Design Guide

## Resilience Patterns

Apply these patterns based on failure mode analysis:

| Pattern | When to Use | Key Configuration |
|---------|-------------|-------------------|
| **Circuit Breaker** | External service calls, database connections | Failure threshold (5), timeout (30s), half-open retry interval (60s) |
| **Bulkhead** | Isolating failures between subsystems | Thread pool per dependency, max concurrent requests, queue depth |
| **Retry with Backoff** | Transient failures (network blips, rate limits) | Max retries (3), exponential backoff (100ms, 200ms, 400ms), jitter |
| **Timeout** | Every external call without exception | Connect timeout (5s), read timeout (30s), total timeout (60s) |
| **Fallback** | Degraded mode is acceptable over total failure | Static fallback, cached response, default value, feature flag |
| **Rate Limiter** | Protecting downstream from upstream bursts | Token bucket or sliding window, per-user and global limits |

### Circuit Breaker State Machine
- **Closed** (normal): Requests pass through. Count failures. Open when threshold reached.
- **Open** (tripped): All requests fail fast without calling downstream. Wait for reset timeout.
- **Half-Open** (probing): Allow one request through. If it succeeds, close. If it fails, re-open.

## Caching Architecture

### Cache Placement Decision Matrix

| Scenario | Cache Location | TTL Strategy | Invalidation |
|----------|---------------|--------------|--------------|
| Static assets | CDN edge | Long (24h+) | Version hash in URL |
| API responses (read-heavy) | Reverse proxy / API gateway | Medium (5-15 min) | Event-driven purge |
| Database query results | Application-level (Redis/Memcached) | Short (1-5 min) | Write-through or write-behind |
| Session data | Distributed cache | Session lifetime | Explicit delete on logout |
| Computed aggregations | Materialized view / pre-computed cache | Scheduled refresh | Rebuild on source change |

### Cache Consistency Rules
- Never cache data that must be strongly consistent across requests
- Use cache-aside (lazy loading) as the default pattern
- Write-through only when write latency tolerance allows it
- Always set a TTL -- unbounded caches become stale data stores
- Monitor cache hit ratio (target >90% for read-heavy paths)

## Scalability Patterns

### Horizontal Scaling Strategies

| Strategy | Best For | Considerations |
|----------|----------|----------------|
| **Stateless services** | API servers, web frontends | No session affinity needed; scale by adding instances behind load balancer |
| **Sharding** | Large datasets, multi-tenant systems | Choose shard key carefully (tenant ID, region); avoid cross-shard queries |
| **Read replicas** | Read-heavy workloads (>10:1 read:write) | Accept replication lag; route writes to primary, reads to replicas |
| **Event-driven decoupling** | Bursty workloads, async processing | Use message queues; consumers scale independently of producers |
| **CQRS** | Different read/write scaling needs | Separate read and write models; accept eventual consistency |

### Shard Key Selection Criteria
- High cardinality (many distinct values)
- Even distribution (no hot partitions)
- Query locality (most queries target a single shard)
- Immutable (changing shard keys requires data migration)

## Reliability Engineering

### SLI/SLO Definition Template

For each critical user journey, define:
- **SLI** (Service Level Indicator): The metric being measured
  - Availability: `successful_requests / total_requests`
  - Latency: `requests_below_threshold / total_requests` (e.g., p99 < 500ms)
  - Correctness: `correct_responses / total_responses`
- **SLO** (Service Level Objective): The target for the SLI
  - Format: "99.9% of requests return successfully over a 30-day window"
- **Error Budget**: `1 - SLO` = allowable failure rate
  - 99.9% SLO = 43.2 minutes of downtime per 30 days

### Failure Mode Checklist

For each component, assess:
- [ ] What happens when this component is unavailable?
- [ ] What happens when response time doubles?
- [ ] What happens when throughput exceeds capacity?
- [ ] What happens when a dependency returns corrupted data?
- [ ] Is there a graceful degradation path?
- [ ] What is the blast radius of a failure? (single user, tenant, region, global)
- [ ] What is the recovery procedure? (automatic, manual, requires restart)

## NFR-to-Architecture Mapping

| NFR Category | Architectural Implication |
|-------------|--------------------------|
| Latency < 100ms | In-memory cache, CDN, connection pooling, async non-blocking I/O |
| Availability > 99.9% | Multi-AZ deployment, health checks, auto-restart, circuit breakers |
| Throughput > 10K rps | Horizontal scaling, load balancing, connection pooling, async processing |
| Data durability | Replicated storage, point-in-time recovery, write-ahead logging |
| Disaster recovery RTO < 1h | Multi-region active-passive, automated failover, tested runbooks |
| Zero-downtime deployments | Blue-green or canary deploys, backward-compatible migrations, feature flags |

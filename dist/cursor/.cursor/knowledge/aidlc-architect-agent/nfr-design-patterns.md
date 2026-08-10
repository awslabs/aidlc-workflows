# Non-Functional Requirement Design Patterns

## Purpose
Patterns for achieving reliability, performance, and resilience in production systems. These patterns address the gap between "it works" and "it works reliably at scale."

## Caching Strategies

### Cache-Aside (Lazy Loading)
```
Read: Check cache -> if miss, read from DB -> populate cache -> return
Write: Write to DB -> invalidate cache
```
- Most common pattern; application manages cache explicitly
- Risk: Cache miss thundering herd under cold start or cache failure
- Mitigation: Use cache warming on startup and request coalescing

### Write-Through
```
Write: Write to cache -> cache synchronously writes to DB
Read: Always read from cache
```
- Cache is always consistent with DB
- Higher write latency (two writes on every mutation)
- Best when reads vastly outnumber writes

### Write-Behind (Write-Back)
```
Write: Write to cache -> cache asynchronously writes to DB (batched)
Read: Always read from cache
```
- Lowest write latency (only cache write is synchronous)
- Risk: Data loss if cache fails before async write completes
- Best for high-write throughput where brief inconsistency is acceptable

### Cache Invalidation Rules
- Set TTL (time-to-live) on every cached item — stale data is worse than a cache miss
- Use explicit invalidation on writes when consistency matters
- Never cache error responses (negative caching requires very short TTLs)
- Monitor cache hit ratio — below 80% indicates the cache is not helping

## Circuit Breaker

### Purpose
Prevent cascading failures when a downstream service is unavailable.

### States
1. **Closed** (normal): Requests flow through. Track failure count.
2. **Open** (tripped): All requests fail immediately without calling downstream. Return fallback or error.
3. **Half-Open** (testing): Allow a limited number of probe requests. If they succeed, return to Closed. If they fail, return to Open.

### Configuration
- **Failure threshold**: Number of consecutive failures before opening (e.g., 5)
- **Open duration**: Time to wait before transitioning to half-open (e.g., 30 seconds)
- **Probe count**: Number of test requests in half-open state (e.g., 3)

### Implementation Notes
- Circuit breakers should be per-dependency, not global
- Log state transitions for observability
- Provide meaningful fallback behavior (cached data, degraded response, queue for retry)

## Bulkhead

### Purpose
Isolate failures to prevent one failing component from consuming all system resources.

### Approaches
- **Thread pool isolation**: Each dependency gets its own thread pool with a fixed size. If dependency A exhausts its pool, dependency B is unaffected.
- **Connection pool isolation**: Separate connection pools per downstream service.
- **Process isolation**: Run critical and non-critical workloads in separate processes or containers.

### Sizing Rule
Size each bulkhead based on the dependency's expected throughput plus a buffer. Too small causes unnecessary rejection; too large defeats the purpose.

## Retry with Exponential Backoff

### Pattern
```
Retry after: base_delay * 2^attempt + random_jitter
Example: 100ms, 200ms, 400ms, 800ms, 1600ms (+ jitter)
```

### Rules
- **Always add jitter** — without it, retries from multiple clients synchronize and create thundering herd
- **Set a maximum retry count** (typically 3-5) — infinite retries cause resource exhaustion
- **Only retry transient failures** — do not retry 400 Bad Request or 403 Forbidden
- **Retryable errors**: 429 (rate limited), 500, 502, 503, 504, connection timeout, connection reset
- **Ensure idempotency** — retried operations must produce the same result (use idempotency keys)

## Rate Limiting

### Algorithms
- **Token Bucket**: Accumulate tokens over time; each request consumes a token. Allows controlled bursts.
- **Sliding Window**: Count requests in a rolling time window. Smoother than fixed windows (avoids boundary bursts).
- **Fixed Window**: Count requests per time interval. Simplest but allows 2x burst at window boundaries.

### Application
- Apply at API gateway level for external consumers
- Apply per-user or per-tenant for fair usage
- Return HTTP 429 with `Retry-After` header
- Communicate rate limits in response headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`)

## Load Balancing

### Algorithms
- **Round Robin**: Distribute evenly across instances. Simple, works when instances are homogeneous.
- **Least Connections**: Route to the instance with fewest active connections. Better when requests have variable duration.
- **Weighted**: Assign weights based on instance capacity. Use when instances have different sizes.
- **Consistent Hashing**: Route based on request key (user ID, session). Maintains affinity for caching benefits.

### Health Checks
- **Shallow**: TCP or HTTP 200 check (is the process running?)
- **Deep**: Check downstream dependencies (can the service actually serve requests?)
- Use shallow checks for load balancer routing; deep checks for alerting

## Connection Pooling

### Purpose
Reuse expensive connections (database, HTTP, gRPC) instead of creating new ones per request.

### Configuration
- **Minimum pool size**: Connections kept warm during idle periods (e.g., 5)
- **Maximum pool size**: Upper bound to prevent resource exhaustion (e.g., 20)
- **Connection timeout**: How long to wait for a connection from the pool (e.g., 5 seconds)
- **Idle timeout**: Close connections unused for this duration (e.g., 10 minutes)
- **Max lifetime**: Close connections after this age regardless of use (e.g., 30 minutes) to prevent stale connections

### Sizing Formula
```
Pool size = (Requests per second) x (Average request duration in seconds) x 1.5 (buffer)
```

## Graceful Degradation

### Principle
When a dependency fails, reduce functionality rather than failing entirely.

### Strategies
- **Feature flags**: Disable non-critical features when their backing service is down
- **Cached fallback**: Serve stale cached data with a "data may be outdated" indicator
- **Default values**: Use sensible defaults when personalization service is unavailable
- **Queue for later**: Accept writes into a queue when the write path is degraded
- **Read-only mode**: Disable writes but keep reads functioning

### Priority Tiers
1. **Critical path**: Must always work (authentication, core transaction)
2. **Important**: Degrade gracefully (recommendations, analytics, notifications)
3. **Nice to have**: Disable entirely under pressure (social features, cosmetic enhancements)

Map every dependency to a tier and define the degradation strategy per tier before production launch.

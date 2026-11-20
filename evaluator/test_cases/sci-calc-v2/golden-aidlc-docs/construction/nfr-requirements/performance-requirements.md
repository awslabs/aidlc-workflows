# Performance Requirements

## Response Latency
- **Target**: p95 < 50ms for any single operation
- **Measurement**: pytest timing assertions or benchmark script
- **Scope**: All endpoints including conversions and statistics
- **Rationale**: All operations are single math.stdlib calls (sub-microsecond). 50ms budget is for the full HTTP round-trip including serialization.

## Startup Time
- **Target**: < 2 seconds from `uvicorn` launch to first request served
- **Measurement**: Timed startup in test or manual verification
- **Rationale**: FastAPI + uvicorn cold start is typically < 1 second; no heavy imports needed.

## Request Body Size
- **Target**: Max 1 MB
- **Configuration**: uvicorn `--limit-request-body` or FastAPI middleware
- **Rationale**: Statistics endpoint accepts arrays; 1 MB is generous for number arrays but prevents abuse.

## Throughput (informational, not gated)
- No explicit RPS target for MVP
- Expected: > 1000 RPS single-worker (all operations are synchronous CPU-bound, no I/O)

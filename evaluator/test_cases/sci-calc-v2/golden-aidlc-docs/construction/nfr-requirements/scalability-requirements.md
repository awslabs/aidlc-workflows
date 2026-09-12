# Scalability Requirements

## MVP: Not Applicable

This is a single-instance stateless API with no persistent state. Scalability is not a concern for MVP.

## Inherent Scalability Properties

- **Stateless**: Any instance can handle any request (horizontal scaling trivial if needed)
- **No shared state**: No database, cache, or session storage
- **Pure functions**: All computations are side-effect-free
- **CPU-bound**: No I/O wait (all operations are math.stdlib calls)

## Post-MVP Scaling Path (informational)

If scaling is needed: run multiple uvicorn workers (`--workers N`) or deploy behind a load balancer. No code changes required.

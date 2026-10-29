# Scalability Design

## MVP: No Scalability Design Required

Single-instance deployment. The application is inherently scalable due to statelessness, but no scaling mechanism is implemented for MVP.

## Future Path (no code changes needed)

- Multiple uvicorn workers: `uvicorn ... --workers 4`
- Container-based horizontal scaling: any orchestrator works (stateless)
- Load balancer: any L7 LB (no sticky sessions needed)

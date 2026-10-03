# Logical Components

## Component Map (NFR perspective)

```
┌────────────────────────────────────────────────┐
│              HTTP Layer (FastAPI)                │
│  - Request size enforcement (1 MB)              │
│  - Input validation (Pydantic strict models)    │
│  - Error envelope formatting                    │
│  - Exception handlers (no info disclosure)      │
├────────────────────────────────────────────────┤
│              Route Layer                         │
│  - Domain exception catching                    │
│  - Overflow detection (result == inf check)     │
│  - Response envelope construction               │
├────────────────────────────────────────────────┤
│              Engine Layer                        │
│  - Pure computation (math stdlib)               │
│  - Domain validation (pre-condition checks)     │
│  - Custom exception raising                     │
└────────────────────────────────────────────────┘
```

## NFR Responsibility Distribution

| NFR | Responsible Component |
|-----|----------------------|
| Latency | Inherent (all layers are fast) |
| Input validation | HTTP Layer (Pydantic) |
| Error containment | Route Layer (exception handlers) |
| Correctness | Engine Layer (math stdlib) |
| Information disclosure | HTTP Layer (custom error handlers) |
| Request size | HTTP Layer (uvicorn config) |

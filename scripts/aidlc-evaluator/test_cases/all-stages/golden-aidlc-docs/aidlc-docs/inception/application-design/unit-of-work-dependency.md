# Unit of Work Dependencies

## Dependency Matrix

| Unit | Depends On | Communication | Priority |
|------|-----------|---------------|----------|
| Catalog Service | None | — | Build first |
| Lending Service | Catalog Service | HTTP (httpx) | Build second |

## Dependency Details

### Catalog Service → External Dependencies
- No service dependencies
- Database: own data store (to be determined in NFR)
- Libraries: FastAPI, Pydantic, PyJWT, uvicorn

### Lending Service → Catalog Service
- **Purpose**: Book existence verification and availability updates
- **API Calls**:
  - `GET /api/v1/books/{book_id}/availability` — verify book exists and check copies
  - `POST /api/v1/books/{book_id}/availability` — increment/decrement available_copies
- **Failure Handling**: If Catalog Service is unavailable, Lending operations that require book verification should fail with INTERNAL_ERROR
- **Libraries**: FastAPI, Pydantic, PyJWT, passlib/bcrypt, httpx, uvicorn

## Integration Points

| Integration | Source | Target | Method | Frequency |
|-------------|--------|--------|--------|-----------|
| Checkout verification | Lending | Catalog | HTTP GET | Every checkout |
| Availability decrement | Lending | Catalog | HTTP POST | Every checkout |
| Availability increment | Lending | Catalog | HTTP POST | Every return |
| Hold verification | Lending | Catalog | HTTP GET | Every hold placement |

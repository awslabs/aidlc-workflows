# Intent Backlog

Prioritised proto-Units (MoSCoW), the raw material the initiative brief compiles.

## Must Have
- **U1 -- Estimate widget shell**: render a cost + ETA block on the cart page,
  wired to the shipping-rate quote endpoint.
- **U2 -- Postcode capture**: a minimal postcode input with validation, feeding U1.

## Should Have
- **U3 -- Fallback state**: clear copy + retry when a quote cannot be computed.

## Could Have
- **U4 -- Estimate caching**: cache quotes per postcode for the session to cut
  repeat calls.

## Won't Have (this initiative)
- **U5 -- Multi-carrier comparison**: showing more than one carrier's estimate.

## Sequencing
Dependency-first: U2 -> U1 -> U3, with U4 as an optimisation once U1 is stable.

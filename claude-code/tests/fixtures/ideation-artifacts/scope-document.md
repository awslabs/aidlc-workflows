# Scope Document

## In Scope
- Inline delivery-estimate widget on the cart page (cost + ETA)
- Integration with the existing shipping-rate service
- Graceful fallback copy when a rate cannot be computed

## Out of Scope
- Changes to the payment provider integration
- New shipping carriers or rate contracts
- Mobile-app (native) parity -- this initiative is storefront web only

## Boundaries & Assumptions
- The shipping-rate service already exposes a synchronous quote endpoint
- Address granularity is postcode-level for the cart-stage estimate
- No PII beyond postcode is collected at the cart stage

## Value Stream
Cart view -> request estimate (postcode) -> render cost + ETA -> proceed to
checkout with the estimate carried forward.

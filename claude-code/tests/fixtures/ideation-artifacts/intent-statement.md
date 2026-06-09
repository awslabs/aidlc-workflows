# Intent Statement

## Problem Statement
The e-commerce platform's checkout abandons ~30% of carts at the shipping
step because customers cannot see a delivery estimate until after they
enter payment details. We need an inline delivery-estimate widget that
shows cost and ETA at the cart stage.

## Target Customer
Returning shoppers on the storefront who add items to cart but stall at
checkout. Secondary: first-time buyers comparing total landed cost.

## Success Metrics
- Cart-to-checkout conversion +8 percentage points within one quarter
- Shipping-step abandonment down from 30% to under 20%
- Delivery-estimate widget render < 200ms p95

## Initiative Trigger
Q2 funnel analysis flagged the shipping step as the single largest drop-off.
A competitor shipped inline estimates last month.

## Initial Scope Signal
feature -- a bounded addition to the existing checkout flow, not a new product line.

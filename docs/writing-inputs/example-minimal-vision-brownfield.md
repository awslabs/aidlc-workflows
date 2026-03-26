# Vision: Returns and Refunds Module — OrderFlow Platform

> **Brownfield project.** This document describes a change to an existing system.
> The Current State section is required. It gives AIDLC the context it needs to
> understand what already exists before generating requirements and design.

---

## Current State

OrderFlow is an existing e-commerce order management platform built in TypeScript
on Node.js. It handles order creation, payment capture, fulfilment routing, and
shipping notifications. It does not currently have any returns or refunds capability.
Customers who want to return an item contact support via email, and refunds are
processed manually by the finance team in the payment provider dashboard.

The existing platform has three backend services (order-service, payment-service,
notification-service) and a React frontend. All services are deployed on AWS ECS
Fargate. PostgreSQL is the primary data store.

---

## What We Are Adding

A returns and refunds module that allows customers to self-serve return requests
through the existing storefront, and allows operations staff to review, approve,
and process refunds without leaving the platform.

---

## Features In Scope (this iteration)

- Customer-facing return request form: select order, select items, select return reason
- Return request status tracking for customers (submitted, approved, rejected, refunded)
- Operations dashboard: view open return requests, approve or reject with a note
- Automated refund processing via the existing payment-service integration
- Email notifications to customers at each status change via notification-service
- Return reason codes: damaged, wrong item, changed mind, other

## Features Explicitly Out of Scope (this iteration)

- Return shipping label generation (manual process for now, Phase 2)
- Partial refunds at the line-item level (full order refunds only in MVP)
- Restocking or inventory management integration (Phase 2)
- Fraud detection or return abuse prevention (Phase 3)
- Self-service exchanges (return + reorder in one flow, Phase 2)
- Returns analytics or reporting dashboard (Phase 2)

---

## What Must Not Change

- Order creation, payment capture, and fulfilment flows — do not modify these
- The existing PostgreSQL schema for orders, payments, and customers — additive changes only
- The notification-service API contract — consume it as-is, do not modify it
- The existing React frontend component library and design system

---

## Open Questions

- Should return requests have an approval step, or should eligible returns be auto-approved based on policy rules (e.g., within 30 days, item not marked as final sale)?
- Who owns the return request in the operations dashboard — customer support team, warehouse team, or both with different views?
- Should refunds be issued immediately on approval, or batched and processed at end of day?
- Is there a return window policy (e.g., 30 days from delivery) that the system should enforce, or is it case-by-case for now?

# Unit of Work — Story Map

## Catalog Service (Unit 1)

| Story ID | Story Name | Priority |
|----------|-----------|----------|
| US-CAT-001 | Add a Book | Must Have |
| US-CAT-002 | Update a Book | Must Have |
| US-CAT-003 | Get a Book | Must Have |
| US-CAT-004 | List All Books | Must Have |
| US-CAT-005 | Delete a Book | Must Have |
| US-CAT-006 | Search Books | Must Have |
| US-SYS-001 | Catalog Health Check | Must Have |

**Total**: 7 stories

---

## Lending Service (Unit 2)

| Story ID | Story Name | Priority |
|----------|-----------|----------|
| US-AUTH-001 | Register as a Member | Must Have |
| US-AUTH-002 | Login | Must Have |
| US-AUTH-003 | View My Profile | Must Have |
| US-AUTH-004 | Update My Profile | Must Have |
| US-AUTH-005 | View Any Member Profile | Must Have |
| US-AUTH-006 | Deactivate Member Account | Must Have |
| US-LND-001 | Checkout a Book | Must Have |
| US-LND-002 | Return a Book | Must Have |
| US-LND-003 | Renew a Checkout | Must Have |
| US-LND-004 | View My Active Checkouts | Must Have |
| US-HLD-001 | Place a Hold | Must Have |
| US-HLD-002 | Cancel a Hold | Must Have |
| US-HLD-003 | View Hold Queue | Must Have |
| US-HLD-004 | View My Holds | Must Have |
| US-FEE-001 | View My Fees | Must Have |
| US-FEE-002 | View Any Member's Fees | Must Have |
| US-FEE-003 | Process Fee Payment | Must Have |
| US-RPT-001 | View Overdue Report | Must Have |
| US-RPT-002 | View Collection Summary | Must Have |
| US-SYS-002 | Lending Health Check | Must Have |

**Total**: 20 stories

---

## Summary

| Unit | Stories | Build Order |
|------|---------|-------------|
| Catalog Service | 7 | 1st (no dependencies) |
| Lending Service | 20 | 2nd (depends on Catalog) |
| **Total** | **27** | |

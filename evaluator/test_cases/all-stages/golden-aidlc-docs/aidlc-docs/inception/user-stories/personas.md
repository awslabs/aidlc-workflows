# User Personas

## Persona 1: Librarian (Volunteer Library Manager)

| Attribute | Detail |
|-----------|--------|
| **Name** | Pat the Librarian |
| **Role** | Librarian |
| **Description** | Volunteer who manages the physical collection at a community library. Adds new books, processes returns, resolves lending disputes, and monitors overdue items. |
| **Goals** | Efficiently manage the catalog, see who has overdue books at a glance, process returns quickly, maintain accurate inventory |
| **Frustrations** | Manual spreadsheet tracking, chasing down overdue books via email, lost books with no accountability |
| **Technical Comfort** | Moderate — comfortable using web interfaces and APIs but not a developer |
| **Usage Pattern** | Uses the system during library open hours (evenings/weekends). Burst usage when processing donations or returns. |
| **Key Endpoints** | Book CRUD, book search, return processing, overdue report, hold management, fee payment processing |

## Persona 2: Member (Library Borrower)

| Attribute | Detail |
|-----------|--------|
| **Name** | Alex the Member |
| **Role** | Member |
| **Description** | Community member who borrows and returns books. Browses the catalog, places holds on popular books, and manages their own account. |
| **Goals** | Find available books easily, check out quickly, know when holds become available, track due dates |
| **Frustrations** | Not knowing which books are available, unfair access to popular books, forgetting due dates |
| **Technical Comfort** | Varies — the API will be consumed by a frontend app on their behalf |
| **Usage Pattern** | Sporadic — browses catalog weekly, checks out 1-3 books per month, returns within lending period |
| **Key Endpoints** | Search, checkout, return, renewal, hold placement/cancellation, active checkouts, fee viewing, profile management |

## Persona 3: Admin (Library Operations Manager)

| Attribute | Detail |
|-----------|--------|
| **Name** | Sam the Admin |
| **Role** | Admin |
| **Description** | Person responsible for the library's overall operations. Manages member accounts, configures lending policies, views operational reports. |
| **Goals** | Full oversight of library operations, manage member issues, review usage reports, ensure fair policy enforcement |
| **Frustrations** | No visibility into library usage, inability to manage problem members, lack of operational metrics |
| **Technical Comfort** | High — comfortable with admin dashboards, API tools, and data analysis |
| **Usage Pattern** | Daily monitoring. Occasional member management actions. Weekly report reviews. |
| **Key Endpoints** | All endpoints (full access), collection summary, overdue report, member management, fee payment, account deactivation |

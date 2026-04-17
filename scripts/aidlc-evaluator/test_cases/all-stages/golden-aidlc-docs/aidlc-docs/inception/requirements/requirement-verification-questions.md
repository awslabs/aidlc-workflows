# Requirements Verification Questions — ANSWERED

Please answer the following questions to help clarify the requirements for the BookShelf Community Library API. Fill in the letter choice after each `[Answer]:` tag.

---

## Question 1
The vision document lists open questions about late fee behavior. When a member has outstanding fees and tries to check out a book, should the system block the checkout or allow it with a warning?

A) Block checkout — members with any outstanding fees cannot borrow until fees are paid
B) Block checkout only when outstanding fees exceed a configurable threshold (e.g., $10.00)
C) Allow checkout but include a warning in the API response indicating outstanding fees
D) Other (please describe after [Answer]: tag below)

[Answer]: B

## Question 2
When a book is returned and a hold exists, should there be a grace period before the held book is made available to the next person in the queue?

A) No grace period — immediately fulfill the next hold in the queue upon return
B) Short grace period (e.g., 24 hours) for the returning member to re-check-out before the hold is fulfilled
C) Configurable grace period set by the library admin
D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3
What should happen to a member's active holds and checkouts if an Admin deactivates their account?

A) Cancel all active holds immediately; keep checkouts active so books are still tracked until returned
B) Cancel all active holds and mark all checkouts as requiring immediate return
C) Keep everything active — deactivation only prevents new actions (no new checkouts, holds, or renewals)
D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 4
Should late fees continue accruing indefinitely, or should they cap at a specific amount?

A) Cap at a fixed dollar amount per checkout (e.g., $10.00 as mentioned in the vision)
B) Cap at the book's replacement value (requires a replacement_value field on books)
C) Cap at a configurable maximum set by the library admin
D) No cap — fees accrue indefinitely until the book is returned
E) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5
For the MVP two-service architecture, how should the Catalog Service and Lending Service be deployed?

A) Two separate FastAPI applications, each with its own AWS Lambda function behind API Gateway
B) Two separate FastAPI applications, each deployed as an ECS Fargate container behind API Gateway
C) Let the Infrastructure Design stage determine the optimal compute choice based on NFR analysis
D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 6
Where should member authentication and management live in the two-service architecture?

A) In the Lending Service — since members are primarily lending-related entities
B) In a shared authentication layer (e.g., middleware) used by both services, with member data in the Lending Service
C) As part of both services — each service validates JWTs independently, and the Lending Service owns member data
D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 7
For the MVP asynchronous hold fulfillment, what level of implementation is expected?

A) Full AWS messaging (SQS/SNS/EventBridge) with actual async event processing between services
B) In-process async event handling within the Lending Service (simulated event bus using Python async)
C) Simple synchronous hold check on return — update hold status directly during the return operation, defer true async to Phase 2
D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 8
How should the two services communicate for book existence/availability verification during checkout?

A) Direct HTTP call from Lending Service to Catalog Service's internal API
B) Shared database view (violates data isolation — not recommended)
C) Cached book data in Lending Service, synchronized via events from Catalog Service
D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 9
For the MVP, should the project include AWS CDK infrastructure-as-code for actual deployment, or focus on the application code with deployment deferred?

A) Include complete CDK infrastructure code for both services (Lambda/Fargate, API Gateway, DynamoDB/RDS, SQS, etc.)
B) Include CDK infrastructure code as stubs/templates showing the architecture but not production-ready
C) Focus on application code only — provide deployment documentation but no CDK code in the MVP
D) Other (please describe after [Answer]: tag below)

[Answer]: C

## Question 10
What database should be used for each service?

A) DynamoDB for both services (key-value access patterns, serverless scaling)
B) DynamoDB for Catalog Service, RDS PostgreSQL for Lending Service (lending has more relational queries)
C) RDS PostgreSQL for both services (relational queries, familiar SQL)
D) Let the NFR Requirements and Infrastructure Design stages determine the optimal choice
E) Other (please describe after [Answer]: tag below)

[Answer]: D

## Question 11: Security Extensions
Should security extension rules (SECURITY-01 through SECURITY-15) be enforced for this project?

A) Yes — enforce all SECURITY rules as blocking constraints (recommended for production-grade applications)
B) No — skip all SECURITY rules (suitable for PoCs, prototypes, and experimental projects)
C) Other (please describe after [Answer]: tag below)

[Answer]: A

